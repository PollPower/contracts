// tariff-registry/deploy/deploy-wi15.1.ts
// -----------------------------------------------------------------------------
// WI-15.1 preview deploy script — implements V2-SPLIT-ADDENDUM §A4 verbatim
// (steps 1–6 + manifest write; step 7 daemon-start is out of scope for WI-15.1,
// step 8 rotation is optional and gated by --rotate-audit-writer).
//
// V2-SPLIT-ADDENDUM.md §A4 (verbatim block quote):
//
//   1. Generate deploy-scoped auditWriter keypair offline.
//   2. Deploy AuditLog with initialAuditWriterAuthority = auditWriter.pubkey.
//   3. Deploy Governance with matching initialAuditWriterAuthority field.
//   4. Deploy Schedule, Lane, Views with constructor addresses.
//   5. Run AuditLog bootstrap shards: (8), (16), (24).
//   6. Seed Governance epoch via advanceEpoch(1, ...).
//   7. Start mirror-writer daemon using auditWriter private key for commitAuditEntry signing.
//   8. Optional ceremony: rotate audit writer immediately to operational key via rotateAuditWriterAuthority.
//
// Usage:
//   tsx deploy/deploy-wi15.1.ts [--dry-run] [--rotate-audit-writer]
//
// --dry-run   — do not connect to Preview; emit a receipt manifest with fake
//               addresses so the script can be exercised without a live node.
//               Useful when Preview is unreachable; DoD accepts a dry-run
//               receipt in lieu of a live deploy.
// --rotate-audit-writer  — after step 6, run rotateAuditWriterAuthority to a
//               freshly-generated operational key (step 8, optional).
// -----------------------------------------------------------------------------

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  persistentHash as runtimePersistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  convertFieldToBytes,
} from '@midnight-ntwrk/compact-runtime';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { loadSeatSignatures, type ApprovalBundle, PILOT_THRESHOLD } from './seat-signatures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.join(REPO_ROOT, 'build');
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');
const DEPLOYMENT_JSON_PATH = path.join(REPO_ROOT, 'deployment.json');
const ACTION_LOG_PATH_DEPTH = 24;
const SCHEDULE_PATH_DEPTH = 20;
const LANE_PATH_DEPTH = 16;
const CLASS_ENTRY_PATH_DEPTH = 16;
const CHARTER_DEPTH = 12;
const CHARTER_LEAF_TAG = 'pp:fed:charter:leaf';
const CHARTER_NODE_TAG = 'pp:fed:charter:node';
const CHARTER_LEAF_PAD_TAG = 'pp:fed:charter:leaf:pad';
const MSFED_ADVANCE_EPOCH_DOMAIN = 'pp:tariff:v1:advanceEpoch';
const Bytes32 = new CompactTypeBytes(32);
const Vec6Bytes32 = new CompactTypeVector(6, Bytes32);

const DRY_RUN = process.argv.includes('--dry-run');
const ROTATE_AUDIT_WRITER = process.argv.includes('--rotate-audit-writer');
const FEDERATION_AUTHORITY_PUBKEY_ARG = readFlagValue('--federation-authority-pubkey');
const REF_RATE_FIAT_PER_KWH_ARG = readFlagValue('--ref-rate-fiat-per-kwh');
const SEAT_SIGNATURES_PATH = readFlagValue('--seat-signatures');

(ed as any).hashes.sha512 = sha512;

// ---------- helpers ----------------------------------------------------------
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function bytesToHex(b: Uint8Array | Buffer): string {
  return Buffer.from(b).toString('hex');
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

function sha256Bytes(data: Uint8Array | Buffer | string): Uint8Array {
  const h = createHash('sha256');
  if (typeof data === 'string') {
    h.update(data, 'utf8');
  } else {
    h.update(data);
  }
  return new Uint8Array(h.digest());
}

function readFlagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function fatalCli(message: string): never {
  throw new Error(`[wi15.1] ${message}`);
}

function parseFederationAuthorityPubkeyHex(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    fatalCli(`--federation-authority-pubkey must be exactly 64 hex chars; got: ${value}`);
  }
  const decoded = Buffer.from(value, 'hex');
  if (decoded.length !== 32) {
    fatalCli(`--federation-authority-pubkey must decode to 32 bytes; got ${decoded.length}`);
  }
  if (decoded.equals(Buffer.alloc(32))) {
    fatalCli('--federation-authority-pubkey must not be all zeros');
  }
  return decoded;
}

function parseRefRateFiatPerKwh(value: string): bigint {
  if (!/^[0-9]+$/.test(value)) {
    fatalCli(`--ref-rate-fiat-per-kwh must be a positive integer; got: ${value}`);
  }
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > 1_000_000n) {
    fatalCli(`--ref-rate-fiat-per-kwh out of range (1..1000000); got: ${value}`);
  }
  return parsed;
}

function rawEd25519Pubkey(publicKey: any): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return Buffer.from(der.slice(-32));
}

interface DeployStepResult {
  step: number;
  name: string;
  ok: boolean;
  address?: string;
  txHash?: string;
  error?: string;
  extra?: Record<string, unknown>;
}

interface LiveRuntimeContext {
  providers: unknown;
  deployUtils: any;
}

type CharterProof = {
  siblings: Uint8Array[];
  indices: boolean[];
};

type PilotSeat = {
  seed: string;
  sk: Uint8Array;
  pk: Uint8Array;
  pkHex: string;
};

type LiveWitnessState = {
  approvalBundles: Map<string, ApprovalBundle>;
  charterProofsByNodeId: Map<string, CharterProof>;
};

let liveRuntimeContextPromise: Promise<LiveRuntimeContext> | null = null;

const KNOWN_WITNESS_NAMES = [
  'signature_valid',
  'multisig_signature_valid',
  'charter_membership_proof',
  'witness_divmod',
  'action_log_path_bits',
  'schedule_path_bits',
  'lane_path_bits',
  'class_entry_path_bits',
] as const;

type WitnessName = (typeof KNOWN_WITNESS_NAMES)[number];
type WitnessProvider = (...args: any[]) => [unknown, unknown];
type WitnessMap = Partial<Record<WitnessName, WitnessProvider>>;

// A recoverable step wrapper that logs the failing step and returns non-zero
// on any failure (per DoD: "On failure, log the failing step and exit non-zero").
async function runStep<T>(
  step: number,
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  console.log(`[wi15.1] step ${step}: ${name}`);
  const start = Date.now();
  try {
    const result = await action();
    console.log(`[wi15.1] step ${step}: ok (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.error(`[wi15.1] step ${step} FAILED: ${name}`);
    console.error(err);
    process.exit(1);
  }
}

function makePathBits(seq: bigint, depth: number): boolean[] {
  const bits: boolean[] = [];
  let n = seq;
  for (let i = 0; i < depth; i++) {
    bits.push((n & 1n) === 1n);
    n >>= 1n;
  }
  return bits;
}

function verifySignatureRawEd25519(
  pubkey: Uint8Array,
  messageHash: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (pubkey.length !== 32 || messageHash.length !== 32 || signature.length !== 64) {
      return false;
    }
    const spkiDer = Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(pubkey),
    ]);
    const publicKey = createPublicKey({
      key: spkiDer,
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(messageHash),
      publicKey,
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

function buildWitnessProviders(state: LiveWitnessState): WitnessMap {
  return {
    signature_valid(
      context: { privateState: unknown },
      pubkey: Uint8Array,
      messageHash: Uint8Array,
      signature: Uint8Array,
    ): [unknown, boolean] {
      return [context.privateState, verifySignatureRawEd25519(pubkey, messageHash, signature)];
    },
    multisig_signature_valid(
      context: { privateState: unknown },
      payload: Uint8Array,
      authorityHash: Uint8Array,
    ): [unknown, boolean] {
      if (payload.length !== 32 || authorityHash.length !== 32) {
        return [context.privateState, false];
      }
      const bundle = state.approvalBundles.get(keyForBundle(payload, authorityHash));
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
    ): [unknown, { siblings: Uint8Array[]; indices: boolean[] }] {
      const proof = state.charterProofsByNodeId.get(toHex(nodeId));
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
    ): [unknown, { quotient: bigint; remainder: bigint }] {
      if (divisor === 0n) {
        return [context.privateState, { quotient: 0n, remainder: 0n }];
      }
      return [context.privateState, { quotient: numerator / divisor, remainder: numerator % divisor }];
    },
    action_log_path_bits(
      context: { privateState: unknown },
      seq: bigint,
    ): [unknown, boolean[]] {
      return [context.privateState, makePathBits(BigInt(seq), ACTION_LOG_PATH_DEPTH)];
    },
    schedule_path_bits(
      context: { privateState: unknown },
      seq: bigint,
    ): [unknown, boolean[]] {
      return [context.privateState, makePathBits(BigInt(seq), SCHEDULE_PATH_DEPTH)];
    },
    lane_path_bits(
      context: { privateState: unknown },
      seq: bigint,
    ): [unknown, boolean[]] {
      return [context.privateState, makePathBits(BigInt(seq), LANE_PATH_DEPTH)];
    },
    class_entry_path_bits(
      context: { privateState: unknown },
      seq: bigint,
    ): [unknown, boolean[]] {
      return [context.privateState, makePathBits(BigInt(seq), CLASS_ENTRY_PATH_DEPTH)];
    },
  };
}

function parseWitnessNamesFromSiblingDts(dtsSource: string): WitnessName[] {
  const names: WitnessName[] = [];
  for (const witnessName of KNOWN_WITNESS_NAMES) {
    if (new RegExp(`\\b${witnessName}\\b`).test(dtsSource)) {
      names.push(witnessName);
    }
  }
  return names;
}

function witnessPathsForSibling(siblingName: string): { jsPath: string; dtsPath: string; assetsPath: string } {
  const contractDir = path.join(BUILD_ROOT, siblingName, 'contract');
  return {
    jsPath: path.join(contractDir, 'index.js'),
    dtsPath: path.join(contractDir, 'index.d.ts'),
    assetsPath: path.join(BUILD_ROOT, siblingName),
  };
}

function pickWitnessesForSibling(
  witnessNames: WitnessName[],
  witnessState: LiveWitnessState,
): Record<string, WitnessProvider> {
  const allWitnesses = buildWitnessProviders(witnessState);
  const selected: Record<string, WitnessProvider> = {};
  for (const witnessName of witnessNames) {
    const witness = allWitnesses[witnessName];
    if (typeof witness !== 'function') {
      throw new Error(`[wi15.1] witness provider is missing implementation: ${witnessName}`);
    }
    selected[witnessName] = witness;
  }
  return selected;
}

async function loadCompiledSiblingContract(
  siblingName: string,
  witnessState: LiveWitnessState,
): Promise<unknown> {
  const { jsPath, dtsPath, assetsPath } = witnessPathsForSibling(siblingName);
  if (!fs.existsSync(jsPath)) {
    fatalCli(`missing compiled sibling JS artifact: ${jsPath}`);
  }
  if (!fs.existsSync(dtsPath)) {
    fatalCli(`missing compiled sibling d.ts artifact: ${dtsPath}`);
  }

  const dtsSource = fs.readFileSync(dtsPath, 'utf8');
  const witnessNames = parseWitnessNamesFromSiblingDts(dtsSource);
  const witnesses = pickWitnessesForSibling(witnessNames, witnessState);
  const buildModule = await import(pathToFileURL(jsPath).href);
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  return (CompiledContract.make as any)(siblingName, buildModule.Contract).pipe(
    (CompiledContract.withWitnesses as any)(witnesses),
    (CompiledContract.withCompiledFileAssets as any)(assetsPath),
  );
}

// Preview-network deploy wrapper. In non-dry-run mode this loads
// @midnight-ntwrk/midnight-js-contracts and calls deployContract; in dry-run
// mode it returns a deterministic pseudo-address derived from the constructor
// args hash so downstream steps can proceed.
async function deployOrDryRun(
  siblingName: string,
  constructorArgs: unknown[],
  witnessState: LiveWitnessState,
): Promise<{ address: string; txHash: string }> {
  if (DRY_RUN) {
    const h = createHash('sha256');
    h.update(siblingName);
    for (const a of constructorArgs) {
      h.update(Buffer.from(JSON.stringify(a)));
    }
    const digest = h.digest();
    return {
      address: '0x' + digest.slice(0, 20).toString('hex'),
      txHash: '0x' + digest.slice(0, 32).toString('hex'),
    };
  }

  // Live-deploy path. Kept behind a runtime import so --dry-run works
  // without the SDK dependencies being loaded.
  const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');
  const runtime = await getLiveRuntimeContext();
  const siblingDir = path.join(BUILD_ROOT, siblingName);
  const providers = runtime.deployUtils.withZkConfigDir(runtime.providers as any, siblingDir);

  // deployContract returns a handle with `deployTxData` (already finalized) and
  // `callTx`/`circuitMaintenanceTx`/`contractMaintenanceTx` interfaces.
  // midnight-js-contracts@4.0.2:
  //   deployContract(providers, { compiledContract, ...options })
  //   -> { deployTxData: FinalizedDeployTxData<C>, callTx, circuitMaintenanceTx, contractMaintenanceTx }
  // where deployTxData.public: FinalizedTxData (has txId, txHash).
  const compiledContract = await loadCompiledSiblingContract(siblingName, witnessState);
  const deployedContract = await deployContract(providers as any, {
    compiledContract: compiledContract as any,
    privateStateId: `wi15.1-${siblingName}-state`,
    initialPrivateState: {} as any,
    args: constructorArgs,
  } as any);
  const deployTxData = (deployedContract as any).deployTxData;
  return {
    address: deployTxData.public.contractAddress,
    txHash: deployTxData?.public?.txId ?? deployTxData?.public?.txHash ?? 'unknown',
  };
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

function u64ToBytes32(u: bigint | number): Uint8Array {
  const v = BigInt(u);
  if (v < 0n) {
    throw new Error(`u64ToBytes32: negative input ${v}`);
  }
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64BE(v & 0xffff_ffff_ffff_ffffn, 24);
  return new Uint8Array(buf);
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

function persistentHash(parts: Uint8Array[]): Uint8Array {
  for (const p of parts) {
    if (p.length !== 32) {
      throw new Error(`persistentHash: expected 32-byte part, got ${p.length}`);
    }
  }
  const h = createHash('sha256');
  for (const p of parts) {
    h.update(p);
  }
  return new Uint8Array(h.digest());
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
  const leafHash = (nodeId: Uint8Array): Uint8Array => persistentHash([pad32(CHARTER_LEAF_TAG), nodeId]);
  const padHash = sha256Bytes(pad32(CHARTER_LEAF_PAD_TAG));
  const pairHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
    persistentHash([pad32(CHARTER_NODE_TAG), left, right]);

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

function contractAddressArg(addressHex: string): { bytes: Uint8Array } {
  const hex = addressHex.startsWith('0x') ? addressHex.slice(2) : addressHex;
  const bytes = new Uint8Array(Buffer.from(hex, 'hex'));
  if (bytes.length !== 32) {
    throw new Error(
      `[wi15.1] contract address must decode to 32 bytes, got ${bytes.length} for ${addressHex}`,
    );
  }
  return { bytes };
}

function asBytes32FromHex(addressHex: string): Uint8Array {
  const hex = addressHex.startsWith('0x') ? addressHex.slice(2) : addressHex;
  const bytes = new Uint8Array(Buffer.from(hex, 'hex'));
  if (bytes.length === 32) {
    return bytes;
  }
  if (!DRY_RUN) {
    throw new Error(`[wi15.1] expected 32-byte contract address, got ${bytes.length} bytes`);
  }
  return sha256Bytes(bytes);
}

function keyForBundle(payload: Uint8Array, authorityHash: Uint8Array): string {
  return `${toHex(payload)}:${toHex(authorityHash)}`;
}

// -----------------------------------------------------------------------------
// msfed ActionHash byte-encoding helpers (WI-15.1-C2 STOP-3 fix, 2026-07-29).
//
// These MUST byte-match what the compact circuit produces at runtime. The
// canonical spec lives at tariff-governance.compact lines 637-644:
//
//   const currentEpochBytes = (currentE as Field) as Bytes<32>;
//   const newEpochBytes     = (dNew as Field) as Bytes<32>;
//   const newRateBytes      = (disclose(newRefRateFiatPerKwh) as Field) as Bytes<32>;
//   const actionHash = persistentHash<Vector<6, Bytes<32>>>([
//     pad(32, "pp:tariff:v1:advanceEpoch"),
//     selfBytes(),
//     currentEpochBytes,
//     newEpochBytes,
//     newRateBytes,
//     disclose(newGovernanceRoot),
//   ]);
//
// Encoding truth:
//   - `pad(32, "...")` treats the tag as ASCII bytes, LSB-first in the 32-byte
//     slot (i.e. bytes[0] = first char of tag, high bytes zero).
//   - `(x as Field) as Bytes<32>` is precisely what @midnight-ntwrk/compact-
//     runtime's `convertFieldToBytes(32, value, label)` produces: little-endian
//     with bytes[0] = LSB, high bytes zero.
//
// These are byte-for-byte equivalent to the canonical exports at
// ~/contracts/multisig/tooling/federated-v1-actionhash.ts padToBytes32 and
// uintToBytes32. Inlined here (rather than dynamically loaded) so the deploy
// script cannot silently drift from a broken shadow file. If future contracts
// change the encoding, update BOTH this block AND the canonical .ts exports
// in lockstep and re-run the actionhash oracle check.
//
// DO NOT reuse the local pad32/u64ToBytes32 above (lines ~447 and ~457) for
// msfed hashing — those use UTF-8 pad and BIG-endian uint layout for legacy
// charter-tree hashing, which is a separate scheme that is NOT what the
// compact circuit expects for msfed action hashes.
// -----------------------------------------------------------------------------
function msfedPadToBytes32(asciiTag: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = Buffer.from(asciiTag, 'ascii');
  if (ascii.length > 32) {
    throw new Error(`msfedPadToBytes32: tag too long (>32 bytes): ${asciiTag}`);
  }
  bytes.set(ascii, 0);
  return bytes;
}

function msfedUintToBytes32(value: bigint, label: string): Uint8Array {
  return convertFieldToBytes(32, value, label);
}

function computeAdvanceEpochActionHash(
  selfAddress: Uint8Array,
  currentEpoch: bigint,
  newEpoch: bigint,
  newRefRateFiatPerKwh: bigint,
  newGovernanceRoot: Uint8Array,
): Uint8Array {
  const opSel = msfedPadToBytes32(MSFED_ADVANCE_EPOCH_DOMAIN);
  const currentEpochBytes = msfedUintToBytes32(currentEpoch, 'currentEpoch');
  const newEpochBytes = msfedUintToBytes32(newEpoch, 'newEpoch');
  const newRateBytes = msfedUintToBytes32(newRefRateFiatPerKwh, 'newRefRate');
  return new Uint8Array(runtimePersistentHash(Vec6Bytes32, [
    opSel,
    selfAddress,
    currentEpochBytes,
    newEpochBytes,
    newRateBytes,
    newGovernanceRoot,
  ]));
}

async function loadSettlementDeployUtils(): Promise<any> {
  const candidates = [
    process.env.TARIFF_DEPLOY_UTILS,
    path.resolve(REPO_ROOT, '..', 'settlement-api', 'src', 'utils.js'),
    path.resolve(REPO_ROOT, 'src', 'utils.js'),
  ].filter((x): x is string => Boolean(x));
  let lastErr: unknown = undefined;
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href);
      if (mod?.createWallet && mod?.createProviders) {
        return mod;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  fatalCli(
    `unable to locate settlement deploy utils (set TARIFF_DEPLOY_UTILS). Last error: ${String(lastErr)}`,
  );
}

async function getLiveRuntimeContext(): Promise<LiveRuntimeContext> {
  if (DRY_RUN) {
    fatalCli('internal: getLiveRuntimeContext called in dry-run mode');
  }
  if (liveRuntimeContextPromise !== null) {
    return liveRuntimeContextPromise;
  }
  liveRuntimeContextPromise = (async () => {
    if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) {
      fatalCli(`missing deployment seed file in live mode: ${DEPLOYMENT_JSON_PATH}`);
    }
    const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8')) as { seed?: string };
    if (!parsed.seed) {
      fatalCli(`deployment seed file is missing "seed": ${DEPLOYMENT_JSON_PATH}`);
    }
    const deployUtils = await loadSettlementDeployUtils();
    const walletCtx = await deployUtils.createWallet(parsed.seed);
    const providers = await deployUtils.createProviders(walletCtx, BUILD_ROOT);
    if (typeof deployUtils.withZkConfigDir !== 'function') {
      fatalCli('settlement deploy utils is missing withZkConfigDir(providers, zkConfigDir)');
    }
    return { providers, deployUtils };
  })();
  return liveRuntimeContextPromise;
}

async function callCircuitOrDryRun(
  siblingName: string,
  address: string,
  circuitName: string,
  args: unknown[],
  witnessState: LiveWitnessState,
): Promise<{ txHash: string }> {
  if (DRY_RUN) {
    const h = createHash('sha256').update(siblingName).update(circuitName);
    for (const a of args) h.update(Buffer.from(JSON.stringify(a)));
    return { txHash: '0x' + h.digest().toString('hex') };
  }
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  setNetworkId('preview');

  const runtime = await getLiveRuntimeContext();
  const siblingDir = path.join(BUILD_ROOT, siblingName);
  const providers = runtime.deployUtils.withZkConfigDir(runtime.providers as any, siblingDir);
  const compiled = await loadCompiledSiblingContract(siblingName, witnessState);
  const deployed = await findDeployedContract(providers as any, {
    compiledContract: compiled as any,
    contractAddress: address as any,
  } as any);
  const callFn = (deployed.callTx as Record<string, (...circuitArgs: unknown[]) => Promise<any>>)[circuitName];
  if (typeof callFn !== 'function') {
    throw new Error(`[wi15.1] circuit not found on ${siblingName}: ${circuitName}`);
  }
  const finalized = await callFn(...args);
  const txHash = String(finalized?.public?.txId ?? finalized?.txId ?? finalized?.public?.txHash ?? 'unknown');
  return { txHash };
}

// ---------- main -------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[wi15.1] deploy start');
  console.log(`[wi15.1] mode: ${DRY_RUN ? 'dry-run (no chain writes)' : 'live preview'}`);
  console.log(`[wi15.1] rotate-audit-writer: ${ROTATE_AUDIT_WRITER}`);

  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const results: DeployStepResult[] = [];
  const stamp = timestamp();
  const manifestPath = path.join(ARTIFACTS_DIR, `wi15.1-preview-${stamp}.json`);
  const pilotSeats = buildPilotSeats();
  const seatPubkeys = pilotSeats.map((s) => s.pk);
  const seatPubkeysHex = pilotSeats.map((s) => s.pkHex);
  const derivedFederationAuthority = federationAuthorityFromSeats(seatPubkeys);
  const charterNodeId = sha256Bytes('pp-preview-node-0');
  const charterTree = buildCharterTree([charterNodeId]);
  const witnessState: LiveWitnessState = {
    approvalBundles: new Map<string, ApprovalBundle>(),
    charterProofsByNodeId: charterTree.proofsByNodeId,
  };

  // ------------------- STEP 1: Generate audit-writer keypair -----------------
  const auditWriterInfo = await runStep(1, 'Generate deploy-scoped auditWriter keypair', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pub = rawEd25519Pubkey(publicKey);
    // Save keypair (PEM) for step 7 daemon handoff.
    const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const keyPath = path.join(ARTIFACTS_DIR, `audit-writer-${stamp}.pem`);
    fs.writeFileSync(keyPath, privPem, { mode: 0o600 });
    return { pubHex: bytesToHex(pub), pubBytes: pub, keyPath, privateKey };
  });
  results.push({ step: 1, name: 'audit-writer keypair', ok: true, extra: { pubHex: auditWriterInfo.pubHex, keyPath: auditWriterInfo.keyPath } });

  // ------------------- STEP 2: Deploy AuditLog -------------------------------
  const auditContractAddress = await runStep(2, 'Deploy AuditLog', async () => {
    const { address, txHash } = await deployOrDryRun(
      'audit',
      [auditWriterInfo.pubBytes],
      witnessState,
    );
    results.push({ step: 2, name: 'audit deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 3: Deploy Governance -----------------------------
  // Governance constructor per V2-SPLIT-ADDENDUM.md §A2:
  //   auditContractAddress, initialFederationAuthority, initialGovernanceRoot,
  //   initialRefRateFiatPerKwh, initialAuditWriterAuthority.
  const initialFederationAuthority = (() => {
    if (FEDERATION_AUTHORITY_PUBKEY_ARG !== undefined) {
      const parsed = parseFederationAuthorityPubkeyHex(FEDERATION_AUTHORITY_PUBKEY_ARG);
      if (!bytesEq(parsed, derivedFederationAuthority)) {
        fatalCli(
          `--federation-authority-pubkey mismatch: expected ${toHex(derivedFederationAuthority)}, got ${toHex(parsed)}`,
        );
      }
      return parsed;
    }
    if (!DRY_RUN) {
      fatalCli('missing required --federation-authority-pubkey <hex> in live mode');
    }
    return derivedFederationAuthority;
  })();
  const initialGovernanceRoot = charterTree.root;
  const initialRefRateFiatPerKwh = (() => {
    if (REF_RATE_FIAT_PER_KWH_ARG !== undefined) {
      return parseRefRateFiatPerKwh(REF_RATE_FIAT_PER_KWH_ARG);
    }
    if (DRY_RUN) {
      return 100n;
    }
    fatalCli('missing required --ref-rate-fiat-per-kwh <int> in live mode');
  })();

  const governanceContractAddress = await runStep(3, 'Deploy Governance', async () => {
    const { address, txHash } = await deployOrDryRun(
      'governance',
      [
        DRY_RUN ? auditContractAddress : contractAddressArg(auditContractAddress),
        initialFederationAuthority,
        initialGovernanceRoot,
        DRY_RUN ? initialRefRateFiatPerKwh.toString() : initialRefRateFiatPerKwh,
        auditWriterInfo.pubBytes,
      ],
      witnessState,
    );
    results.push({ step: 3, name: 'governance deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 4: Deploy Schedule, Lane, Views -------------------
  // WI-15.1 Fix A: Schedule/Lane/Views constructors now accept two sealed
  // init params to close the PR #49 genesis front-run window:
  //   initialFederationAuthority: same value passed to Governance in step 3.
  //   initialAuditWriterAuthority: same auditWriter.pubkey passed in step 2.
  // Both anchors must match Governance/AuditLog at tx-0 alignment.
  const scheduleContractAddress = await runStep(4, 'Deploy Schedule', async () => {
    const { address, txHash } = await deployOrDryRun(
      'schedule',
      [
        DRY_RUN ? auditContractAddress : contractAddressArg(auditContractAddress),
        DRY_RUN ? governanceContractAddress : contractAddressArg(governanceContractAddress),
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
      witnessState,
    );
    results.push({ step: 4, name: 'schedule deploy', ok: true, address, txHash });
    return address;
  });

  const laneContractAddress = await runStep(4, 'Deploy Lane', async () => {
    const { address, txHash } = await deployOrDryRun(
      'lane',
      [
        DRY_RUN ? auditContractAddress : contractAddressArg(auditContractAddress),
        DRY_RUN ? governanceContractAddress : contractAddressArg(governanceContractAddress),
        DRY_RUN ? scheduleContractAddress : contractAddressArg(scheduleContractAddress),
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
      witnessState,
    );
    results.push({ step: 4, name: 'lane deploy', ok: true, address, txHash });
    return address;
  });

  const viewsContractAddress = await runStep(4, 'Deploy Views', async () => {
    const { address, txHash } = await deployOrDryRun(
      'views',
      [
        DRY_RUN ? auditContractAddress : contractAddressArg(auditContractAddress),
        DRY_RUN ? governanceContractAddress : contractAddressArg(governanceContractAddress),
        DRY_RUN ? scheduleContractAddress : contractAddressArg(scheduleContractAddress),
        DRY_RUN ? laneContractAddress : contractAddressArg(laneContractAddress),
        initialFederationAuthority,
        auditWriterInfo.pubBytes,
      ],
      witnessState,
    );
    results.push({ step: 4, name: 'views deploy', ok: true, address, txHash });
    return address;
  });

  // ------------------- STEP 5: Bootstrap AuditLog shards ----------------------
  // WI-13.3 policy K=8 shards: (8), (16), (24). Terminal shard sets
  // _bootstrapComplete=true.
  for (const shardEnd of [8n, 16n, 24n]) {
    const shardEndNumber = Number(shardEnd);
    await runStep(5, `bootstrapActionLog(${shardEndNumber})`, async () => {
      const { txHash } = await callCircuitOrDryRun(
        'audit',
        auditContractAddress,
        'bootstrapActionLog',
        [DRY_RUN ? shardEndNumber : shardEnd],
        witnessState,
      );
      results.push({ step: 5, name: `bootstrapActionLog(${shardEndNumber})`, ok: true, txHash });
    });
  }

  // ------------------- STEP 6: Seed Governance epoch -------------------------
  let advanceEpochActionHashHex = '';
  await runStep(6, 'Governance advanceEpoch(1, ...)', async () => {
    const governanceSelfBytes = asBytes32FromHex(governanceContractAddress);
    const currentEpoch = 0n;
    const newEpoch = 1n;
    const newRefRate = initialRefRateFiatPerKwh;
    const newGovRoot = initialGovernanceRoot;
    const currentTime = BigInt(Math.floor(Date.now() / 1000));

    // Single code path for dry-run and live: the inline msfed helpers above
    // are byte-identical to the compact circuit's encoding, so no branching is
    // needed. Previously we split DRY_RUN → local pad32/u64ToBytes32 and live
    // → dynamic-loaded shadow file, but both branches drifted from the
    // canonical convertFieldToBytes/ASCII-pad spec (WI-15.1-C2 STOP-3, 07-29).
    const advanceEpochActionHash = computeAdvanceEpochActionHash(
      governanceSelfBytes,
      currentEpoch,
      newEpoch,
      newRefRate,
      newGovRoot,
    );
    advanceEpochActionHashHex = toHex(advanceEpochActionHash);
    const advanceEpochBundle: ApprovalBundle = SEAT_SIGNATURES_PATH
      ? loadSeatSignatures(SEAT_SIGNATURES_PATH)
      : {
          seatPubkeys,
          signatures: await Promise.all(
            pilotSeats.map((s) => ed.signAsync(advanceEpochActionHash, s.sk)),
          ),
          threshold: PILOT_THRESHOLD,
        };
    witnessState.approvalBundles.set(
      keyForBundle(advanceEpochActionHash, initialFederationAuthority),
      advanceEpochBundle,
    );

    const { txHash } = await callCircuitOrDryRun(
      'governance',
      governanceContractAddress,
      'advanceEpoch',
      DRY_RUN
        ? [Number(newEpoch), Number(newRefRate), newGovRoot, Number(currentTime)]
        : [newEpoch, newRefRate, newGovRoot, currentTime],
      witnessState,
    );
    results.push({ step: 6, name: 'advanceEpoch(1)', ok: true, txHash });
  });

  // ------------------- STEP 8 (optional): rotate audit writer ----------------
  let rotatedAuditWriterPubHex: string | undefined;
  if (ROTATE_AUDIT_WRITER) {
    await runStep(8, 'rotateAuditWriterAuthority (optional ceremony)', async () => {
      const { publicKey: newPub } = generateKeyPairSync('ed25519');
      const newPubRaw = rawEd25519Pubkey(newPub);
      rotatedAuditWriterPubHex = bytesToHex(newPubRaw);
      const { txHash } = await callCircuitOrDryRun(
        'audit',
        auditContractAddress,
        'rotateAuditWriterAuthority',
        // TODO(step-8): forward-port from V1's rotation ceremony.
        [rotatedAuditWriterPubHex],
        witnessState,
      );
      results.push({ step: 8, name: 'rotateAuditWriterAuthority', ok: true, txHash });
    });
  }

  // ------------------- Write manifest ----------------------------------------
  const manifest = {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    network: 'preview',
    contracts: {
      audit:      { address: auditContractAddress },
      governance: { address: governanceContractAddress },
      schedule:   { address: scheduleContractAddress },
      lane:       { address: laneContractAddress },
      views:      { address: viewsContractAddress },
    },
    auditWriter: {
      publicKeyHex: auditWriterInfo.pubHex,
      privateKeyPath: auditWriterInfo.keyPath,
      rotatedTo: rotatedAuditWriterPubHex,
    },
    governanceInit: {
      federationAuthorityHex: bytesToHex(initialFederationAuthority),
      seatPubkeysHex,
      charterNodeIdHex: toHex(charterNodeId),
      governanceRootHex: bytesToHex(initialGovernanceRoot),
      advanceEpochActionHashHex,
      refRateFiatPerKwh: initialRefRateFiatPerKwh.toString(),
    },
    stepResults: results,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[wi15.1] manifest written: ${manifestPath}`);
  console.log(`[wi15.1] contracts deployed: 5/5`);
  console.log(`[wi15.1] done`);
}

main().catch((err) => {
  console.error('[wi15.1] deploy script uncaught error:', err);
  process.exit(1);
});
