import * as path from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';

import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  persistentHash as runtimePersistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadSeatSignatures, type ApprovalBundle } from './deploy/seat-signatures.js';

// Preview network — required by midnight-js-contracts.deployContract.
// midnight-js-network-id demands an explicit setNetworkId() call before any
// wallet or contract op; settlement-api handles this in config.ts's side
// effects but this deploy tool loads utils.ts directly.
setNetworkId('preview');

// Keep sync verify behavior aligned with existing deploy tooling.
(ed as any).hashes.sha512 = sha512;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUILD_PATH = path.resolve(__dirname, 'build');
const BUILD_CONTRACT_INDEX = path.join(BUILD_PATH, 'contract', 'index.js');
const OUTPUT_PUBLIC_JSON = path.resolve(
  __dirname,
  'tariff-registry-preview-deployment.public.json',
);
const DEPLOYMENT_JSON_PATH = path.resolve(__dirname, 'deployment.json');

const ACTION_LOG_DEPTH = 24;
const CHARTER_DEPTH = 12;
const NETWORK_ID = 'preview';
const PILOT_THRESHOLD = 3;
const REF_RATE_FIAT_PER_KWH = 100n;
const LANE_KIND_BYTE = 1;
const BPS_SHARE = 100;
const BASIS = 0;
const REMITTANCE_MODE = 0;

type DivResult = { quotient: bigint; remainder: bigint };
type CharterProof = { siblings: Uint8Array[]; indices: boolean[] };

type PilotSeat = {
  seed: string;
  sk: Uint8Array;
  pk: Uint8Array;
  pkHex: string;
};

type DeploymentRecord = {
  contractAddress: string;
  network: 'preview';
  federationAuthorityHex: string;
  seatPubkeysHex: string[];
  charterRootHex: string;
  governanceRootHex: string;
  scheduleId: string;
  laneKey: string;
  classPath: string;
  actionSeqAtDeploy: string;
  registryActionLogRoot: string;
  advanceEpochActionHashHex: string;
  advancedToEpoch: string;
  payloadHashesEmitted: Array<{ seq: string; kind: number; payloadHashHex: string }>;
  deployedAt: string;
  deployerBech32: string;
  pilotMockDisclosure: string;
};

const Bytes32 = new CompactTypeBytes(32);
const Vec6Bytes32 = new CompactTypeVector(6, Bytes32);
type MsfedActionHashHelpers = {
  padToBytes32: (asciiTag: string) => Uint8Array;
  uintToBytes32: (value: bigint, label: string) => Uint8Array;
};

function sha256Bytes(data: Uint8Array | Buffer | string): Uint8Array {
  const h = createHash('sha256');
  if (typeof data === 'string') {
    h.update(data, 'utf8');
  } else {
    h.update(data);
  }
  return new Uint8Array(h.digest());
}

function pad32(tag: string): Uint8Array {
  const out = new Uint8Array(32);
  const b = Buffer.from(tag, 'utf8');
  if (b.length > 32) {
    throw new Error(`pad32: tag too long (${b.length}): ${tag}`);
  }
  out.set(b, 0);
  return out;
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

function u64ToBytes32(u: bigint | number): Uint8Array {
  const v = BigInt(u);
  if (v < 0n) {
    throw new Error(`u64ToBytes32: negative input ${v}`);
  }
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64BE(v & 0xffff_ffff_ffff_ffffn, 24);
  return new Uint8Array(buf);
}

function u16ToBytes32(u: bigint | number): Uint8Array {
  return u64ToBytes32(u);
}

function persistentHash(parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) {
    if (p.length !== 32) {
      throw new Error(`persistentHash: expected 32-byte part, got ${p.length}`);
    }
    h.update(p);
  }
  return new Uint8Array(h.digest());
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cmpBytesLex(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function deriveSeat(seed: string): PilotSeat {
  const sk = sha256Bytes(seed);
  const pk = ed.getPublicKey(sk);
  return { seed, sk, pk, pkHex: toHex(pk) };
}

function buildPilotSeats(): PilotSeat[] {
  return [0, 1, 2, 3, 4].map((i) => deriveSeat(`pp-tariff-pilot-seat-${i}`));
}

function federationAuthorityFromSeats(seatPubkeys: Uint8Array[]): Uint8Array {
  const sorted = [...seatPubkeys].sort(cmpBytesLex);
  const cat = concatBytes(sorted);
  return sha256Bytes(cat);
}

function buildCharterTree(nodeIds: Uint8Array[]) {
  if (nodeIds.length > 2 ** CHARTER_DEPTH) {
    throw new Error('charter tree: too many nodes');
  }
  const leafHash = (nodeId: Uint8Array): Uint8Array =>
    persistentHash([pad32('pp:fed:charter:leaf'), nodeId]);
  const padHash = sha256Bytes(pad32('pp:fed:charter:leaf:pad'));
  const pairHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
    persistentHash([pad32('pp:fed:charter:node'), left, right]);

  const leaves: Uint8Array[] = nodeIds.map(leafHash);
  while (leaves.length < 2 ** CHARTER_DEPTH) leaves.push(padHash);

  const levels: Uint8Array[][] = [leaves];
  for (let d = 0; d < CHARTER_DEPTH; d++) {
    const cur = levels[d];
    const nxt: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      nxt.push(pairHash(cur[i], cur[i + 1]));
    }
    levels.push(nxt);
  }
  const root = levels[CHARTER_DEPTH][0];

  const proofsByNodeId = new Map<string, CharterProof>();
  for (let i = 0; i < nodeIds.length; i++) {
    const siblings: Uint8Array[] = [];
    const indices: boolean[] = [];
    let idx = i;
    for (let d = 0; d < CHARTER_DEPTH; d++) {
      const sibIdx = idx ^ 1;
      siblings.push(levels[d][sibIdx]);
      indices.push((idx & 1) === 1);
      idx >>= 1;
    }
    proofsByNodeId.set(toHex(nodeIds[i]), { siblings, indices });
  }

  return { root, proofsByNodeId };
}

function splitSharesHash(s: {
  producerShareBps: number;
  ldShareBps: number;
  opsShareBps: number;
  daoShareBps: number;
  operatorMarginBps: number;
  statutoryTotalBps: number;
}): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:splitShares'),
    u16ToBytes32(s.producerShareBps),
    u16ToBytes32(s.ldShareBps),
    u16ToBytes32(s.opsShareBps),
    u16ToBytes32(s.daoShareBps),
    u16ToBytes32(s.operatorMarginBps),
    u16ToBytes32(s.statutoryTotalBps),
  ]);
}

function scheduleActionPayloadHash(
  kind: number,
  record: {
    scheduleId: Uint8Array;
    nodeId: Uint8Array;
    scheduleHash: Uint8Array;
    operatorPubkey: Uint8Array;
    effectiveEpoch: bigint;
    retiredEpoch: bigint;
    refRateFiatPerKwh: bigint;
    registeredAt: bigint;
  },
): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:actionPayload'),
    u64ToBytes32(BigInt(kind)),
    record.scheduleId,
    record.nodeId,
    record.scheduleHash,
    record.operatorPubkey,
    u64ToBytes32(record.effectiveEpoch),
    u64ToBytes32(record.retiredEpoch),
    u64ToBytes32(record.refRateFiatPerKwh),
    u64ToBytes32(record.registeredAt),
  ]);
}

function laneActionPayloadHash(
  kind: number,
  record: {
    scheduleId: Uint8Array;
    laneKindByte: number;
    leviedBy: Uint8Array;
    bpsShare: number;
    remitAddress: Uint8Array;
    basis: number;
    applicabilityHash: Uint8Array;
    statuteRefHash: Uint8Array;
    effectiveEpoch: bigint;
    retiredEpoch: bigint;
    remittanceMode: number;
    registeredAt: bigint;
  },
): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:actionPayload'),
    u64ToBytes32(BigInt(kind)),
    record.scheduleId,
    u64ToBytes32(BigInt(record.laneKindByte)),
    record.leviedBy,
    u16ToBytes32(record.bpsShare),
    record.remitAddress,
    u64ToBytes32(BigInt(record.basis)),
    record.applicabilityHash,
    record.statuteRefHash,
    u64ToBytes32(record.effectiveEpoch),
    u64ToBytes32(record.retiredEpoch),
    u64ToBytes32(BigInt(record.remittanceMode)),
    u64ToBytes32(record.registeredAt),
  ]);
}

function retuneActionPayloadHash(
  scheduleId: Uint8Array,
  classPath: Uint8Array,
  split: {
    producerShareBps: number;
    ldShareBps: number;
    opsShareBps: number;
    daoShareBps: number;
    operatorMarginBps: number;
    statutoryTotalBps: number;
  },
  rateFiatPerKwh: bigint,
  lastUpdatedAt: bigint,
): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:actionPayload'),
    u64ToBytes32(2n),
    scheduleId,
    classPath,
    u16ToBytes32(split.producerShareBps),
    u16ToBytes32(split.ldShareBps),
    u16ToBytes32(split.opsShareBps),
    u16ToBytes32(split.daoShareBps),
    u16ToBytes32(split.operatorMarginBps),
    u16ToBytes32(split.statutoryTotalBps),
    u64ToBytes32(rateFiatPerKwh),
    u64ToBytes32(lastUpdatedAt),
  ]);
}

function laneKey(scheduleId: Uint8Array, leviedBy: Uint8Array, laneKindByte: number): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:laneKey'),
    scheduleId,
    leviedBy,
    u64ToBytes32(BigInt(laneKindByte)),
  ]);
}

function computeRegisterScheduleActionHash(
  selfBytes: Uint8Array,
  nodeId: Uint8Array,
  scheduleHash: Uint8Array,
  effectiveEpoch: bigint,
  currentEpoch: bigint,
): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:registerSchedule'),
    selfBytes,
    nodeId,
    scheduleHash,
    u64ToBytes32(effectiveEpoch),
    u64ToBytes32(currentEpoch),
  ]);
}

function computeScheduleId(
  selfBytes: Uint8Array,
  nodeId: Uint8Array,
  effectiveEpoch: bigint,
): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:scheduleId'),
    selfBytes,
    nodeId,
    u64ToBytes32(effectiveEpoch),
  ]);
}

function computeRegisterLaneActionHash(input: {
  selfBytes: Uint8Array;
  scheduleId: Uint8Array;
  laneKindByte: number;
  leviedBy: Uint8Array;
  bpsShare: number;
  remitAddress: Uint8Array;
  basis: number;
  applicabilityHash: Uint8Array;
  statuteRefHash: Uint8Array;
  effectiveEpoch: bigint;
  remittanceMode: number;
  currentEpoch: bigint;
  currentTime: bigint;
}): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:registerLane'),
    input.selfBytes,
    input.scheduleId,
    u64ToBytes32(BigInt(input.laneKindByte)),
    input.leviedBy,
    u16ToBytes32(input.bpsShare),
    input.remitAddress,
    u64ToBytes32(BigInt(input.basis)),
    input.applicabilityHash,
    input.statuteRefHash,
    u64ToBytes32(input.effectiveEpoch),
    u64ToBytes32(BigInt(input.remittanceMode)),
    u64ToBytes32(input.currentEpoch),
    u64ToBytes32(input.currentTime),
  ]);
}

function computeAdvanceEpochActionHash(
  selfAddress: Uint8Array,
  currentEpoch: bigint,
  newEpoch: bigint,
  newRefRateFiatPerKwh: bigint,
  newGovernanceRoot: Uint8Array,
  helpers: MsfedActionHashHelpers,
): Uint8Array {
  /*
  const actionHash = persistentHash<Vector<6, Bytes<32>>>([
    pad(32, "pp:tariff:v1:advanceEpoch"),
    selfBytes(),
    currentEpochBytes,
    newEpochBytes,
    newRateBytes,
    disclose(newGovernanceRoot),
  ]);
  */
  const opSel = helpers.padToBytes32('pp:tariff:v1:advanceEpoch');
  const currentEpochBytes = helpers.uintToBytes32(currentEpoch, 'currentEpoch');
  const newEpochBytes = helpers.uintToBytes32(newEpoch, 'newEpoch');
  const newRateBytes = helpers.uintToBytes32(newRefRateFiatPerKwh, 'newRefRate');
  return new Uint8Array(runtimePersistentHash(Vec6Bytes32, [
    opSel,
    selfAddress,
    currentEpochBytes,
    newEpochBytes,
    newRateBytes,
    newGovernanceRoot,
  ]));
}

function computeRetuneAuthHash(input: {
  selfBytes: Uint8Array;
  scheduleId: Uint8Array;
  classPath: Uint8Array;
  newSplitBps: {
    producerShareBps: number;
    ldShareBps: number;
    opsShareBps: number;
    daoShareBps: number;
    operatorMarginBps: number;
    statutoryTotalBps: number;
  };
  newRateFiatPerKwh: bigint;
  currentEpoch: bigint;
  nonceIn: bigint;
  currentTime: bigint;
}): Uint8Array {
  return persistentHash([
    pad32('pp:tariff:v1:retuneClass'),
    input.selfBytes,
    input.scheduleId,
    input.classPath,
    splitSharesHash(input.newSplitBps),
    u64ToBytes32(input.newRateFiatPerKwh),
    u64ToBytes32(input.currentEpoch),
    u64ToBytes32(input.nonceIn),
    u64ToBytes32(input.currentTime),
  ]);
}

class ActionLogTree {
  depth: number;

  zeros: Uint8Array[];

  root: Uint8Array;

  nextIndex: number;

  nodes: Array<Map<string, Uint8Array>>;

  constructor(depth: number) {
    this.depth = depth;
    this.zeros = [];
    let z = pad32('pp:tariff:v1:actionLogEmpty');
    for (let i = 0; i < depth; i++) {
      this.zeros.push(z);
      z = persistentHash([pad32('pp:tariff:v1:actionLogNode'), z, z]);
    }
    this.root = z;
    this.nextIndex = 0;
    this.nodes = Array.from({ length: depth + 1 }, () => new Map());
  }

  private get(level: number, idx: number): Uint8Array {
    const m = this.nodes[level];
    const k = String(idx);
    return m.has(k) ? (m.get(k) as Uint8Array) : this.zeros[level];
  }

  private set(level: number, idx: number, val: Uint8Array): void {
    this.nodes[level].set(String(idx), new Uint8Array(val));
  }

  append(leaf: Uint8Array): Uint8Array {
    const idx = this.nextIndex;
    this.set(0, idx, leaf);
    let h: Uint8Array<ArrayBufferLike> = new Uint8Array(leaf);
    let i = idx;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const parent =
        (i & 1) === 0
          ? persistentHash([pad32('pp:tariff:v1:actionLogNode'), h, this.get(lvl, i + 1)])
          : persistentHash([pad32('pp:tariff:v1:actionLogNode'), this.get(lvl, i - 1), h]);
      this.set(lvl + 1, i >> 1, parent);
      h = parent;
      i >>= 1;
    }
    this.root = h;
    this.nextIndex += 1;
    return this.root;
  }
}

function makePathBits(seq: bigint): boolean[] {
  const bits: boolean[] = [];
  let n = BigInt(seq);
  for (let i = 0; i < ACTION_LOG_DEPTH; i++) {
    bits.push((n & 1n) === 1n);
    n >>= 1n;
  }
  return bits;
}

async function loadSettlementDeployUtils() {
  const repoRoot = path.resolve(__dirname, '..');
  const candidates = [
    process.env.TARIFF_DEPLOY_UTILS,
    path.resolve(repoRoot, '..', 'settlement-api', 'src', 'utils.js'),
    path.resolve(repoRoot, 'src', 'utils.js'),
  ].filter((x): x is string => Boolean(x));

  let lastErr: unknown = undefined;
  for (const c of candidates) {
    try {
      const mod = await import(pathToFileURL(c).href);
      if (mod?.createWallet && mod?.createProviders && mod?.logger) {
        return mod;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Unable to locate deploy helper module exporting createWallet/createProviders/logger. ` +
      `Set TARIFF_DEPLOY_UTILS to settlement-api src/utils.js. Last error: ${String(lastErr)}`,
  );
}

async function loadMsfedActionHashHelpers(): Promise<MsfedActionHashHelpers> {
  const modulePath = path.resolve(__dirname, '..', 'multisig', 'tooling', 'federated-v1-actionhash.js');
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.padToBytes32 !== 'function' || typeof mod.uintToBytes32 !== 'function') {
    throw new Error(
      `Expected padToBytes32/uintToBytes32 exports in ${modulePath}; verify PR #58 (cdfb875) is present.`,
    );
  }
  return {
    padToBytes32: mod.padToBytes32 as (asciiTag: string) => Uint8Array,
    uintToBytes32: mod.uintToBytes32 as (value: bigint, label: string) => Uint8Array,
  };
}

async function main() {
  const seatSignaturesPath = readFlagValue('--seat-signatures');

  // H-1 disclosure (Preview-only): these pilot seat keys are deterministic and public.
  const pilotSeats = buildPilotSeats();
  const seatPubkeys = pilotSeats.map((s) => s.pk);
  const seatPubkeysHex = pilotSeats.map((s) => s.pkHex);
  const federationAuthority = federationAuthorityFromSeats(seatPubkeys);
  const federationAuthorityHex = toHex(federationAuthority);

  if (existsSync(OUTPUT_PUBLIC_JSON)) {
    const existing = JSON.parse(readFileSync(OUTPUT_PUBLIC_JSON, 'utf8')) as Partial<DeploymentRecord>;
    if (existing.contractAddress) {
      console.log(`Idempotent exit: existing contractAddress=${existing.contractAddress}`);
      return;
    }
  }

  if (!existsSync(BUILD_CONTRACT_INDEX)) {
    throw new Error(
      `Compiled artifact missing: ${BUILD_CONTRACT_INDEX}. Compile on kenya first (compactc.bin).`,
    );
  }
  if (!existsSync(DEPLOYMENT_JSON_PATH)) {
    throw new Error(`Missing deployment seed file: ${DEPLOYMENT_JSON_PATH}`);
  }

  const deploymentJson = JSON.parse(readFileSync(DEPLOYMENT_JSON_PATH, 'utf8')) as { seed: string };
  if (!deploymentJson.seed) {
    throw new Error('deployment.json missing "seed"');
  }

  const charterNodeId = sha256Bytes('pp-preview-node-0');
  const charter = buildCharterTree([charterNodeId]);
  const governanceRoot = charter.root;
  const governanceRootHex = toHex(governanceRoot);
  const charterRootHex = governanceRootHex;
  const charterProof = charter.proofsByNodeId.get(toHex(charterNodeId));
  if (!charterProof) {
    throw new Error('Failed to build charter proof for pp-preview-node-0');
  }

  const operatorSk = sha256Bytes('pp-tariff-preview-operator-0');
  const operatorPk = ed.getPublicKey(operatorSk);
  const validatorSk = sha256Bytes('pp-tariff-preview-validator-0');
  const validatorPk = ed.getPublicKey(validatorSk);

  const approvalBundles = new Map<string, ApprovalBundle>();
  const keyForBundle = (payload: Uint8Array, authorityHash: Uint8Array): string =>
    `${toHex(payload)}:${toHex(authorityHash)}`;

  const witnesses = {
    signature_valid(
      context: { privateState: unknown },
      pubkey: Uint8Array,
      messageHash: Uint8Array,
      signature: Uint8Array,
    ): [unknown, boolean] {
      if (pubkey.length !== 32 || messageHash.length !== 32 || signature.length !== 64) {
        return [context.privateState, false];
      }
      let ok = false;
      try {
        ok = ed.verify(signature, messageHash, pubkey);
      } catch {
        ok = false;
      }
      return [context.privateState, ok];
    },
    multisig_signature_valid(
      context: { privateState: unknown },
      payload: Uint8Array,
      authorityHash: Uint8Array,
    ): [unknown, boolean] {
      if (payload.length !== 32 || authorityHash.length !== 32) {
        return [context.privateState, false];
      }
      const bundle = approvalBundles.get(keyForBundle(payload, authorityHash));
      if (!bundle) return [context.privateState, false];
      if (bundle.seatPubkeys.length !== bundle.signatures.length) return [context.privateState, false];
      if (bundle.threshold < 1 || bundle.threshold > bundle.seatPubkeys.length) {
        return [context.privateState, false];
      }
      const computedAuthority = federationAuthorityFromSeats(bundle.seatPubkeys);
      if (!bytesEq(computedAuthority, authorityHash)) return [context.privateState, false];

      let valid = 0;
      for (let i = 0; i < bundle.seatPubkeys.length; i++) {
        const pk = bundle.seatPubkeys[i];
        const sig = bundle.signatures[i];
        if (pk.length !== 32 || sig.length !== 64) continue;
        let ok = false;
        try {
          ok = ed.verify(sig, payload, pk);
        } catch {
          ok = false;
        }
        if (ok) valid += 1;
      }
      return [context.privateState, valid >= bundle.threshold && valid >= PILOT_THRESHOLD];
    },
    charter_membership_proof(
      context: { privateState: unknown },
      nodeId: Uint8Array,
    ): [unknown, CharterProof] {
      const proof = charter.proofsByNodeId.get(toHex(nodeId));
      if (!proof) {
        return [
          context.privateState,
          {
            siblings: Array.from({ length: CHARTER_DEPTH }, () => new Uint8Array(32)),
            indices: Array.from({ length: CHARTER_DEPTH }, () => false),
          },
        ];
      }
      return [context.privateState, proof];
    },
    witness_divmod(
      context: { privateState: unknown },
      numerator: bigint,
      divisor: bigint,
    ): [unknown, DivResult] {
      if (divisor === 0n) {
        return [context.privateState, { quotient: 0n, remainder: 0n }];
      }
      return [context.privateState, { quotient: numerator / divisor, remainder: numerator % divisor }];
    },
    action_log_path_bits(
      context: { privateState: unknown },
      seq: bigint,
    ): [unknown, boolean[]] {
      return [context.privateState, makePathBits(seq)];
    },
  };

  const buildModule = await import(pathToFileURL(BUILD_CONTRACT_INDEX).href);
  const compiled = (CompiledContract.make as any)('tariff-registry-v1', buildModule.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses),
    (CompiledContract.withCompiledFileAssets as any)(BUILD_PATH),
  );

  const deployUtils = await loadSettlementDeployUtils();
  const walletCtx = await deployUtils.createWallet(deploymentJson.seed);
  await Rx.firstValueFrom(
    walletCtx.wallet.state().pipe(Rx.throttleTime(5000), Rx.filter((s: any) => s.isSynced)),
  );
  const providers = await deployUtils.createProviders(walletCtx, BUILD_PATH);
  const deployerBech32 = walletCtx.unshieldedKeystore.getBech32Address();

  const deployed: any = await deployContract(providers, {
    compiledContract: compiled,
    args: [federationAuthority, governanceRoot, REF_RATE_FIAT_PER_KWH],
    privateStateId: 'tariff-registry-v1-preview-state',
    initialPrivateState: {},
  } as any);
  const contractAddress: string = deployed.deployTxData.public.contractAddress;
  const selfBytes = new Uint8Array(Buffer.from(contractAddress.replace(/^0x/, ''), 'hex'));
  const actionHashHelpers = await loadMsfedActionHashHelpers();
  if (selfBytes.length !== 32) {
    throw new Error(`Unexpected contractAddress byte length ${selfBytes.length}`);
  }

  // WI-13.3 post-deploy bootstrap (three sequential shards; see contract
  // circuit `bootstrapActionLog` and `tariff-registry/V1.3-DESIGN.md` §5).
  // The constructor now leaves the action-log empty tree uninitialized to
  // fit under Midnight block limits; keeper (this deploy script) advances
  // the shard cursor 0 → 8 → 16 → 24. Only the terminal shard commits
  // `registryActionLogRoot`, sets `_actionLogBaseSeq`, and flips
  // `_bootstrapComplete = true`. Without these three calls every branch
  // op below reverts with "TariffRegistry: bootstrap incomplete".
  console.log('[deploy] bootstrap shard 1/3: bootstrapActionLog(8n)');
  await deployed.callTx.bootstrapActionLog(8n);
  console.log('[deploy] bootstrap shard 2/3: bootstrapActionLog(16n)');
  await deployed.callTx.bootstrapActionLog(16n);
  console.log('[deploy] bootstrap shard 3/3 (terminal): bootstrapActionLog(24n)');
  await deployed.callTx.bootstrapActionLog(24n);

  const currentEpoch = 0n;
  const currentTime = 0n;
  const effectiveEpoch = currentEpoch + 1n;

  const scheduleHash = sha256Bytes('pp-preview-schedule-hash-0');
  const registerScheduleActionHash = computeRegisterScheduleActionHash(
    selfBytes,
    charterNodeId,
    scheduleHash,
    effectiveEpoch,
    currentEpoch,
  );
  const validatorSignature = await ed.signAsync(registerScheduleActionHash, validatorSk);
  const scheduleBundle: ApprovalBundle = {
    seatPubkeys,
    signatures: await Promise.all(
      pilotSeats.map((s) => ed.signAsync(registerScheduleActionHash, s.sk)),
    ),
    threshold: PILOT_THRESHOLD,
  };
  approvalBundles.set(
    keyForBundle(registerScheduleActionHash, federationAuthority),
    scheduleBundle,
  );
  await deployed.callTx.registerSchedule(
    charterNodeId,
    scheduleHash,
    operatorPk,
    REF_RATE_FIAT_PER_KWH,
    effectiveEpoch,
    validatorPk,
    validatorSignature,
    currentTime,
  );

  const scheduleId = computeScheduleId(selfBytes, charterNodeId, effectiveEpoch);

  const leviedBy = sha256Bytes('pp-preview-leviedBy-0');
  const remitAddress = sha256Bytes('pp-preview-remitAddress-0');
  const applicabilityHash = sha256Bytes('pp-preview-applicability-0');
  const statuteRefHash = sha256Bytes('pp-preview-statuteRef-0');

  const registerLaneActionHash = computeRegisterLaneActionHash({
    selfBytes,
    scheduleId,
    laneKindByte: LANE_KIND_BYTE,
    leviedBy,
    bpsShare: BPS_SHARE,
    remitAddress,
    basis: BASIS,
    applicabilityHash,
    statuteRefHash,
    effectiveEpoch,
    remittanceMode: REMITTANCE_MODE,
    currentEpoch,
    currentTime,
  });
  const laneBundle: ApprovalBundle = {
    seatPubkeys,
    signatures: await Promise.all(
      pilotSeats.map((s) => ed.signAsync(registerLaneActionHash, s.sk)),
    ),
    threshold: PILOT_THRESHOLD,
  };
  approvalBundles.set(keyForBundle(registerLaneActionHash, federationAuthority), laneBundle);
  await deployed.callTx.registerLane(
    scheduleId,
    LANE_KIND_BYTE,
    leviedBy,
    BPS_SHARE,
    remitAddress,
    BASIS,
    applicabilityHash,
    statuteRefHash,
    effectiveEpoch,
    REMITTANCE_MODE,
    charterProof,
    currentTime,
  );

  const classPath = sha256Bytes('preview.class.a');
  const split = {
    producerShareBps: 6500,
    ldShareBps: 500,
    opsShareBps: 2500,
    daoShareBps: 300,
    operatorMarginBps: 200,
    statutoryTotalBps: 0,
  };
  const nonceIn = 1n;
  const retuneAuthHash = computeRetuneAuthHash({
    selfBytes,
    scheduleId,
    classPath,
    newSplitBps: split,
    newRateFiatPerKwh: REF_RATE_FIAT_PER_KWH,
    currentEpoch,
    nonceIn,
    currentTime,
  });
  const operatorSignature = await ed.signAsync(retuneAuthHash, operatorSk);
  const divResult: DivResult = {
    quotient: (REF_RATE_FIAT_PER_KWH * BigInt(20 * 100)) / 10_000n,
    remainder: (REF_RATE_FIAT_PER_KWH * BigInt(20 * 100)) % 10_000n,
  };

  await deployed.callTx.retuneClass(
    scheduleId,
    classPath,
    split,
    REF_RATE_FIAT_PER_KWH,
    operatorPk,
    operatorSignature,
    nonceIn,
    currentTime,
    divResult,
    divResult,
  );

  const nextEpoch = currentEpoch + 1n;
  const newRate = REF_RATE_FIAT_PER_KWH;
  const newRoot = governanceRoot;
  const advanceEpochActionHash = computeAdvanceEpochActionHash(
    selfBytes,
    currentEpoch,
    nextEpoch,
    newRate,
    newRoot,
    actionHashHelpers,
  );
  const advanceEpochBundle: ApprovalBundle = seatSignaturesPath
    ? loadSeatSignatures(seatSignaturesPath)
    : {
        seatPubkeys,
        signatures: await Promise.all(
          pilotSeats.map((s) => ed.signAsync(advanceEpochActionHash, s.sk)),
        ),
        threshold: PILOT_THRESHOLD,
      };
  if (seatSignaturesPath) {
    console.log(`[deploy] INFO --seat-signatures path used: ${seatSignaturesPath}`);
  } else {
    console.log('[deploy] INFO inline signing path used for advanceEpoch');
  }
  approvalBundles.set(
    keyForBundle(advanceEpochActionHash, federationAuthority),
    advanceEpochBundle,
  );
  console.log('[deploy] pilot smoke: advanceEpoch');
  await deployed.callTx.advanceEpoch(
    nextEpoch,
    newRate,
    newRoot,
    currentTime,
  );
  const advancedCurrentEpoch = nextEpoch;

  const scheduleRecord = {
    scheduleId,
    nodeId: charterNodeId,
    scheduleHash,
    operatorPubkey: operatorPk,
    effectiveEpoch,
    retiredEpoch: 0n,
    refRateFiatPerKwh: REF_RATE_FIAT_PER_KWH,
    registeredAt: currentTime,
  };
  const laneRecord = {
    scheduleId,
    laneKindByte: LANE_KIND_BYTE,
    leviedBy,
    bpsShare: BPS_SHARE,
    remitAddress,
    basis: BASIS,
    applicabilityHash,
    statuteRefHash,
    effectiveEpoch,
    retiredEpoch: 0n,
    remittanceMode: REMITTANCE_MODE,
    registeredAt: currentTime,
  };
  const payload0 = scheduleActionPayloadHash(0, scheduleRecord);
  const payload1 = laneActionPayloadHash(1, laneRecord);
  const payload2 = retuneActionPayloadHash(
    scheduleId,
    classPath,
    split,
    REF_RATE_FIAT_PER_KWH,
    currentTime,
  );
  const payloadHashesEmitted = [
    { seq: '0', kind: 0, payloadHashHex: toHex(payload0) },
    { seq: '1', kind: 1, payloadHashHex: toHex(payload1) },
    { seq: '2', kind: 2, payloadHashHex: toHex(payload2) },
  ];

  const actionTree = new ActionLogTree(ACTION_LOG_DEPTH);
  actionTree.append(payload0);
  actionTree.append(payload1);
  actionTree.append(payload2);

  const out: DeploymentRecord = {
    contractAddress,
    network: NETWORK_ID,
    federationAuthorityHex,
    seatPubkeysHex,
    charterRootHex,
    governanceRootHex,
    scheduleId: toHex(scheduleId),
    laneKey: toHex(laneKey(scheduleId, leviedBy, LANE_KIND_BYTE)),
    classPath: toHex(classPath),
    actionSeqAtDeploy: '3',
    registryActionLogRoot: toHex(actionTree.root),
    advanceEpochActionHashHex: toHex(advanceEpochActionHash),
    advancedToEpoch: advancedCurrentEpoch.toString(),
    payloadHashesEmitted,
    deployedAt: new Date().toISOString(),
    deployerBech32,
    pilotMockDisclosure:
      'H-1 open — keys derived from seeds pp-tariff-pilot-seat-{0..4}, publicly derivable, Preview-only',
  };

  writeFileSync(OUTPUT_PUBLIC_JSON, JSON.stringify(out, null, 2));
  console.log(`Saved ${OUTPUT_PUBLIC_JSON}`);
  console.log(`CONTRACT_ADDRESS=${contractAddress}`);
}

function readFlagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a path argument`);
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
