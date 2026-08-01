// tariff-registry/deploy/populate-pilot-tariff-monolith.mjs
// -----------------------------------------------------------------------------
// Pilot tariff registration on monolith Preview deployment.
//
// Registers 1 schedule + 4 lanes using a single monolith contract address.
//
// Usage:
//   node populate-pilot-tariff-monolith.mjs
//
// Writes manifest to:
//   /home/pollpower/contracts/tariff-registry/deploy/artifacts/pilot-tariff-monolith-<timestamp>.json
// -----------------------------------------------------------------------------

import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import {
  persistentHash as runtimePersistentHash,
  CompactTypeBytes,
  CompactTypeVector,
} from '@midnight-ntwrk/compact-runtime';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

import { bech32m } from 'bech32';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

// -------------------------- Static config --------------------------
const REPO_ROOT = '/home/pollpower/contracts/tariff-registry';
const BUILD_ROOT = path.join(REPO_ROOT, 'build');
const BUILD_CONTRACT_JS = path.join(BUILD_ROOT, 'contract', 'index.js');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'deploy', 'artifacts');
const DEPLOYMENT_JSON_PATH = path.join(REPO_ROOT, 'deployment.json');
const DEPLOY_UTILS_PATH = path.join(REPO_ROOT, 'deploy', 'deploy-utils.mjs');

// Tariff spec (LOCKED per Garrett 2026-07-30 18:53 JST)
const REF_RATE_FIAT_PER_KWH = 28n;
const LANES = [
  { role: 'producer', laneKindByte: 0, bpsShare: 4643, kesPerKwh: 13.0 },
  { role: 'ops', laneKindByte: 1, bpsShare: 1643, kesPerKwh: 4.6 },
  { role: 'dividend', laneKindByte: 2, bpsShare: 1929, kesPerKwh: 5.4 },
  { role: 'statutory', laneKindByte: 3, bpsShare: 1785, kesPerKwh: 5.0 },
];

// Recipient addresses (bech32m) from ceremony/recipient-keys.json
const RECIPIENT_KEYS_PATH = '/home/pollpower/contracts/ebt/ceremony/recipient-keys.json';

// Federation constants
const CHARTER_DEPTH = 12;
const CHARTER_LEAF_TAG = 'pp:fed:charter:leaf';
const CHARTER_NODE_TAG = 'pp:fed:charter:node';
const CHARTER_LEAF_PAD_TAG = 'pp:fed:charter:leaf:pad';
const ACTION_LOG_PATH_DEPTH = 24;
const SCHEDULE_PATH_DEPTH = 20;
const LANE_PATH_DEPTH = 16;
const CLASS_ENTRY_PATH_DEPTH = 16;
const PILOT_THRESHOLD = 3;

const Bytes32 = new CompactTypeBytes(32);

// -------------------------- Utilities --------------------------
function toHex(b) {
  return Buffer.from(b).toString('hex');
}
function bytesToHex(b) {
  return toHex(b);
}
function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function cmpBytesLex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}
function concatBytes(list) {
  let total = 0;
  for (const b of list) total += b.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of list) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}
function sha256Bytes(x) {
  return new Uint8Array(createHash('sha256').update(x).digest());
}
function pad32(s) {
  const out = new Uint8Array(32);
  const enc = new TextEncoder().encode(s);
  if (enc.length > 32) throw new Error(`pad32 overflow: ${s} (${enc.length} bytes)`);
  out.set(enc, 0);
  return out;
}
function u64ToBytes32(n) {
  // Compact convertFieldToBytes-compatible encoding:
  // little-endian uint64 at offset 0 in a 32-byte buffer.
  const out = new Uint8Array(32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  out.set(buf, 0);
  return out;
}
function persistentHash(items) {
  const VecN = new CompactTypeVector(items.length, Bytes32);
  return runtimePersistentHash(VecN, items);
}

function getLatestMonolithManifestPath() {
  const names = fs
    .readdirSync(ARTIFACTS_DIR)
    .filter((name) => name.startsWith('monolith-preview-') && name.endsWith('.json'))
    .sort((a, b) => b.localeCompare(a));
  if (names.length === 0) {
    throw new Error(`[pilot-monolith] no monolith-preview-* manifest found in ${ARTIFACTS_DIR}`);
  }
  return path.join(ARTIFACTS_DIR, names[0]);
}

// -------------------------- Seat derivation --------------------------
function deriveSeat(seed) {
  const sk = sha256Bytes(seed);
  const pk = ed.getPublicKey(sk);
  return { seed, sk, pk, pkHex: toHex(pk) };
}
function buildPilotSeats() {
  return [0, 1, 2, 3, 4].map((i) => deriveSeat(`pp-tariff-pilot-seat-${i}`));
}
function federationAuthorityFromSeats(seatPubkeys) {
  const sorted = [...seatPubkeys].sort(cmpBytesLex);
  return sha256Bytes(concatBytes(sorted));
}

// -------------------------- Charter tree --------------------------
function buildCharterTree(nodeIds) {
  if (nodeIds.length > 2 ** CHARTER_DEPTH) {
    throw new Error('charter tree: too many nodes');
  }
  const leafHash = (nodeId) => persistentHash([pad32(CHARTER_LEAF_TAG), nodeId]);
  const padHash = sha256Bytes(pad32(CHARTER_LEAF_PAD_TAG));
  const pairHash = (left, right) => persistentHash([pad32(CHARTER_NODE_TAG), left, right]);

  const leaves = nodeIds.map(leafHash);
  while (leaves.length < 2 ** CHARTER_DEPTH) leaves.push(padHash);

  const levels = [leaves];
  for (let d = 0; d < CHARTER_DEPTH; d++) {
    const cur = levels[d];
    const nxt = [];
    for (let i = 0; i < cur.length; i += 2) nxt.push(pairHash(cur[i], cur[i + 1]));
    levels.push(nxt);
  }
  const root = levels[CHARTER_DEPTH][0];

  const proofsByNodeId = new Map();
  for (let i = 0; i < nodeIds.length; i++) {
    const siblings = [];
    const indices = [];
    let idx = i;
    for (let d = 0; d < CHARTER_DEPTH; d++) {
      const isRight = (idx & 1) === 1;
      const sib = levels[d][isRight ? idx - 1 : idx + 1];
      siblings.push(sib);
      indices.push(isRight);
      idx = idx >> 1;
    }
    proofsByNodeId.set(toHex(nodeIds[i]), { siblings, indices });
  }
  return { root, proofsByNodeId };
}

// -------------------------- Bundle key --------------------------
function keyForBundle(payload, authorityHash) {
  return `${toHex(payload)}:${toHex(authorityHash)}`;
}

// -------------------------- Path bits helper --------------------------
function makePathBits(seq, depth) {
  const bits = [];
  let x = seq;
  for (let i = 0; i < depth; i++) {
    bits.push((x & 1n) === 1n);
    x = x >> 1n;
  }
  return bits;
}

// -------------------------- Witness map --------------------------
function buildWitnessProviders(state) {
  return {
    signature_valid(context, pubkey, messageHash, signature) {
      let ok = false;
      let errMsg;
      try {
        ok = ed.verify(signature, messageHash, pubkey);
      } catch (e) {
        ok = false;
        errMsg = e?.message ?? String(e);
      }
      console.log('[witness] signature_valid called:');
      console.log('  pubkey  =', Buffer.from(pubkey).toString('hex'), 'len', pubkey.length);
      console.log('  msgHash =', Buffer.from(messageHash).toString('hex'), 'len', messageHash.length);
      console.log('  sig     =', Buffer.from(signature).toString('hex'), 'len', signature.length);
      console.log('  verify  =', ok, errMsg ? `err=${errMsg}` : '');
      return [context.privateState, ok];
    },
    multisig_signature_valid(context, payload, authorityHash) {
      console.log('[witness] multisig_signature_valid called:');
      console.log('  payload       =', Buffer.from(payload).toString('hex'), 'len', payload.length);
      console.log('  authorityHash =', Buffer.from(authorityHash).toString('hex'), 'len', authorityHash.length);
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
    charter_membership_proof(context, nodeId) {
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
    witness_divmod(context, numerator, divisor) {
      if (divisor === 0n) return [context.privateState, { quotient: 0n, remainder: 0n }];
      return [context.privateState, { quotient: numerator / divisor, remainder: numerator % divisor }];
    },
    action_log_path_bits(context, seq) {
      return [context.privateState, makePathBits(BigInt(seq), ACTION_LOG_PATH_DEPTH)];
    },
    schedule_path_bits(context, seq) {
      return [context.privateState, makePathBits(BigInt(seq), SCHEDULE_PATH_DEPTH)];
    },
    lane_path_bits(context, seq) {
      return [context.privateState, makePathBits(BigInt(seq), LANE_PATH_DEPTH)];
    },
    class_entry_path_bits(context, seq) {
      return [context.privateState, makePathBits(BigInt(seq), CLASS_ENTRY_PATH_DEPTH)];
    },
  };
}

// -------------------------- Runtime setup --------------------------
async function loadDeployUtils() {
  if (!fs.existsSync(DEPLOY_UTILS_PATH)) {
    throw new Error(`[pilot-monolith] missing deploy utils: ${DEPLOY_UTILS_PATH}`);
  }
  return import(pathToFileURL(DEPLOY_UTILS_PATH).href);
}

async function getRuntime() {
  if (!fs.existsSync(DEPLOYMENT_JSON_PATH)) {
    throw new Error(`[pilot-monolith] missing seed file: ${DEPLOYMENT_JSON_PATH}`);
  }
  const parsed = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!parsed.seed) throw new Error('[pilot-monolith] deployment.json missing "seed"');

  const deployUtils = await loadDeployUtils();
  const walletCtx = await deployUtils.createWallet(parsed.seed);
  const providers = await deployUtils.createProviders(walletCtx, BUILD_ROOT);
  return { providers, deployUtils };
}

async function loadCompiledMonolith(state) {
  if (!fs.existsSync(BUILD_CONTRACT_JS)) {
    throw new Error(`[pilot-monolith] missing build module: ${BUILD_CONTRACT_JS}`);
  }
  const buildModule = await import(pathToFileURL(BUILD_CONTRACT_JS).href);
  const witnesses = buildWitnessProviders(state);
  return CompiledContract.make('tariff-registry-monolith-ceremony', buildModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(BUILD_ROOT),
  );
}

async function resolveDeployedMonolith(contractAddress, state) {
  setNetworkId('preview');
  const runtime = await getRuntime();
  const compiled = await loadCompiledMonolith(state);
  const providersWithZk = runtime.deployUtils.withZkConfigDir(runtime.providers, BUILD_ROOT);
  const deployed = await findDeployedContract(providersWithZk, {
    contractAddress,
    compiledContract: compiled,
  });
  return { deployed, providers: providersWithZk };
}

// -------------------------- Bech32m -> 32-byte payload --------------------------
function decodeBech32mUnshielded(addr) {
  const decoded = bech32m.decode(addr, 200);
  const data = bech32m.fromWords(decoded.words);
  const bytes = new Uint8Array(data);
  if (bytes.length === 32) return bytes;
  if (bytes.length === 33) return bytes.slice(1);
  if (bytes.length > 32) return bytes.slice(bytes.length - 32);
  throw new Error(`[pilot-monolith] unshielded address payload too short: ${bytes.length}`);
}

// -------------------------- Epoch read --------------------------
async function readCurrentEpoch(contractAddress, providers) {
  try {
    const buildModule = await import(pathToFileURL(BUILD_CONTRACT_JS).href);
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!state) {
      console.log('[pilot-monolith] readCurrentEpoch: no state, fallback=1n');
      return 1n;
    }
    const ledger = buildModule.ledger(state.data);
    const ep = BigInt(ledger._currentEpoch);
    console.log(`[pilot-monolith] readCurrentEpoch: _currentEpoch=${ep}`);
    return ep;
  } catch (e) {
    console.log(`[pilot-monolith] readCurrentEpoch failed (${e?.message ?? e}), fallback=1n`);
    return 1n;
  }
}

// -------------------------- MAIN --------------------------
async function main() {
  const start = Date.now();
  console.log('[pilot-monolith] Starting tariff population...');

  const latestManifestPath = getLatestMonolithManifestPath();
  console.log(`[pilot-monolith] using manifest: ${latestManifestPath}`);
  const monolithManifest = JSON.parse(fs.readFileSync(latestManifestPath, 'utf8'));

  const contractAddress = monolithManifest.contractAddress;
  const federationAuthorityHex = monolithManifest.governanceInit.federationAuthorityHex;
  const charterNodeIdHex = monolithManifest.governanceInit.charterNodeIdHex;

  // Single-address wiring for all former sibling references.
  const scheduleAddr = contractAddress;
  const laneAddr = contractAddress;
  const auditAddr = contractAddress;
  const govAddr = contractAddress;

  console.log(`[pilot-monolith] contractAddress=${contractAddress}`);
  console.log(`[pilot-monolith] scheduleAddr=${scheduleAddr}`);
  console.log(`[pilot-monolith] laneAddr=${laneAddr}`);
  console.log(`[pilot-monolith] auditAddr=${auditAddr}`);
  console.log(`[pilot-monolith] govAddr=${govAddr}`);
  console.log(`[pilot-monolith] federationAuthority=${federationAuthorityHex}`);

  if (!fs.existsSync(RECIPIENT_KEYS_PATH)) {
    throw new Error(`[pilot-monolith] missing recipient keys: ${RECIPIENT_KEYS_PATH}`);
  }
  const rk = JSON.parse(fs.readFileSync(RECIPIENT_KEYS_PATH, 'utf8'));

  const remitByRole = {
    // Gap 5 preserved from the sibling flow.
    producer: decodeBech32mUnshielded(rk.keys.ops.address_bech32m),
    ops: decodeBech32mUnshielded(rk.keys.ops.address_bech32m),
    dividend: decodeBech32mUnshielded(rk.keys.dividend.address_bech32m),
    statutory: decodeBech32mUnshielded(rk.keys.statutory.address_bech32m),
  };

  const seats = buildPilotSeats();
  const seatPubkeys = seats.map((s) => s.pk);
  const derivedFedAuthority = federationAuthorityFromSeats(seatPubkeys);
  const derivedFedAuthorityHex = bytesToHex(derivedFedAuthority);
  if (derivedFedAuthorityHex !== federationAuthorityHex) {
    throw new Error(
      `[pilot-monolith] federation authority mismatch: derived ${derivedFedAuthorityHex} vs on-chain ${federationAuthorityHex}`,
    );
  }
  console.log('[pilot-monolith] federation authority verified');

  const charterNodeIdBytes = new Uint8Array(Buffer.from(charterNodeIdHex, 'hex'));
  const charterTree = buildCharterTree([charterNodeIdBytes]);
  const witnessState = {
    approvalBundles: new Map(),
    charterProofsByNodeId: charterTree.proofsByNodeId,
  };

  const runtime = await resolveDeployedMonolith(contractAddress, witnessState);
  const deployed = runtime.deployed;
  const providers = runtime.providers;

  // ----- STEP 1: registerSchedule -----
  const selfBytes = new Uint8Array(Buffer.from(contractAddress.replace(/^0x/, ''), 'hex'));
  if (selfBytes.length !== 32) {
    throw new Error(`[pilot-monolith] contractAddress is not 32 bytes: ${selfBytes.length}`);
  }

  const currentEpoch = await readCurrentEpoch(contractAddress, providers);
  const effectiveEpoch = currentEpoch + 2n;
  console.log(`[pilot-monolith] currentEpoch=${currentEpoch}, effectiveEpoch=${effectiveEpoch}`);

  const scheduleHash = persistentHash([
    pad32('pp:tariff:pilot:scheduleContent'),
    u64ToBytes32(REF_RATE_FIAT_PER_KWH),
    u64ToBytes32(effectiveEpoch),
    u64ToBytes32(BigInt(LANES[0].bpsShare)),
    u64ToBytes32(BigInt(LANES[1].bpsShare)),
    u64ToBytes32(BigInt(LANES[2].bpsShare)),
    u64ToBytes32(BigInt(LANES[3].bpsShare)),
  ]);

  const validatorAttestorHex = monolithManifest.auditWriter.publicKeyHex;
  const validatorAttestorBytes = new Uint8Array(Buffer.from(validatorAttestorHex, 'hex'));
  const operatorPubkey = validatorAttestorBytes;
  const currentTime = BigInt(Math.floor(Date.now() / 1000));

  const scheduleActionHash = persistentHash([
    pad32('pp:tariff:v1:registerSchedule'),
    selfBytes,
    charterNodeIdBytes,
    scheduleHash,
    u64ToBytes32(effectiveEpoch),
    u64ToBytes32(currentEpoch),
  ]);

  const auditWriterPemPath = monolithManifest.auditWriter.privateKeyPath;
  if (!fs.existsSync(auditWriterPemPath)) {
    throw new Error(`[pilot-monolith] audit-writer pem missing: ${auditWriterPemPath}`);
  }
  const auditWriterPrivPem = fs.readFileSync(auditWriterPemPath, 'utf8');
  const auditWriterKey = createPrivateKey(auditWriterPrivPem);
  const validatorSignature = new Uint8Array(
    nodeSign(null, Buffer.from(scheduleActionHash), auditWriterKey),
  );

  const scheduleBundle = {
    seatPubkeys,
    signatures: await Promise.all(seats.map((s) => ed.signAsync(scheduleActionHash, s.sk))),
    threshold: PILOT_THRESHOLD,
  };
  witnessState.approvalBundles.set(
    keyForBundle(scheduleActionHash, derivedFedAuthority),
    scheduleBundle,
  );

  console.log(`[pilot-monolith] scheduleActionHash=${Buffer.from(scheduleActionHash).toString('hex')}`);
  console.log(`[pilot-monolith] validatorAttestor=${validatorAttestorHex}`);
  console.log('[pilot-monolith] Submitting registerSchedule...');
  const scheduleResult = await deployed.callTx.registerSchedule(
    charterNodeIdBytes,
    scheduleHash,
    operatorPubkey,
    REF_RATE_FIAT_PER_KWH,
    effectiveEpoch,
    validatorAttestorBytes,
    validatorSignature,
    currentTime,
  );
  const scheduleTxHash = String(
    scheduleResult?.public?.txId ?? scheduleResult?.txId ?? scheduleResult?.public?.txHash ?? 'unknown',
  );
  console.log(`[pilot-monolith] registerSchedule tx: ${scheduleTxHash}`);

  const scheduleId = persistentHash([
    pad32('pp:tariff:v1:scheduleId'),
    selfBytes,
    charterNodeIdBytes,
    u64ToBytes32(effectiveEpoch),
  ]);
  const scheduleIdHex = bytesToHex(scheduleId);
  console.log(`[pilot-monolith] derived scheduleId=${scheduleIdHex}`);

  // ----- STEP 2: registerLane x 4 -----
  const laneResults = [];
  for (const lane of LANES) {
    const laneRemit = remitByRole[lane.role];
    const leviedBy = charterNodeIdBytes;
    const laneCurrentTime = BigInt(Math.floor(Date.now() / 1000));
    const applicabilityHash = pad32(`pp:tariff:pilot:${lane.role}`);
    const statuteRefHash =
      lane.role === 'statutory' ? pad32('kenya:kplc:2026') : new Uint8Array(32);
    const basis = 0;
    const remittanceMode = 0;

    const laneActionHash = persistentHash([
      pad32('pp:tariff:v1:registerLane'),
      selfBytes,
      scheduleId,
      u64ToBytes32(BigInt(lane.laneKindByte)),
      leviedBy,
      u64ToBytes32(BigInt(lane.bpsShare)),
      laneRemit,
      u64ToBytes32(BigInt(basis)),
      applicabilityHash,
      statuteRefHash,
      u64ToBytes32(effectiveEpoch),
      u64ToBytes32(BigInt(remittanceMode)),
      u64ToBytes32(currentEpoch),
      u64ToBytes32(laneCurrentTime),
    ]);

    const laneBundle = {
      seatPubkeys,
      signatures: await Promise.all(seats.map((s) => ed.signAsync(laneActionHash, s.sk))),
      threshold: PILOT_THRESHOLD,
    };
    witnessState.approvalBundles.set(keyForBundle(laneActionHash, derivedFedAuthority), laneBundle);

    const charterProofForLane = witnessState.charterProofsByNodeId.get(toHex(leviedBy));
    if (!charterProofForLane) {
      throw new Error(`[pilot-monolith] no charter proof found for leviedBy=${toHex(leviedBy)}`);
    }

    console.log(`[pilot-monolith] Submitting registerLane (${lane.role})...`);
    const laneResult = await deployed.callTx.registerLane(
      scheduleId,
      BigInt(lane.laneKindByte),
      leviedBy,
      BigInt(lane.bpsShare),
      laneRemit,
      BigInt(basis),
      applicabilityHash,
      statuteRefHash,
      effectiveEpoch,
      BigInt(remittanceMode),
      charterProofForLane,
      laneCurrentTime,
    );
    const laneTxHash = String(
      laneResult?.public?.txId ?? laneResult?.txId ?? laneResult?.public?.txHash ?? 'unknown',
    );
    console.log(`[pilot-monolith]   ${lane.role} tx: ${laneTxHash}`);
    laneResults.push({ role: lane.role, txHash: laneTxHash, bpsShare: lane.bpsShare });
  }

  // ----- STEP 3: Verify -----
  const bpsSum = LANES.reduce((s, l) => s + l.bpsShare, 0);
  if (bpsSum !== 10000) {
    throw new Error(`[pilot-monolith] bps sum mismatch: ${bpsSum} !== 10000`);
  }
  console.log(`[pilot-monolith] bps sum verified: ${bpsSum}`);

  // ----- Manifest -----
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(ARTIFACTS_DIR, `pilot-tariff-monolith-${stamp}.json`);
  const manifest = {
    schemaVersion: '1',
    generatedAt: new Date().toISOString(),
    mode: 'live-preview-monolith',
    sourceDeployManifest: path.basename(latestManifestPath),
    contractAddress,
    tariffSpec: {
      consumerTotalKes: 28.0,
      baseEnergyKes: 23.0,
      lanes: LANES.map((l) => ({
        role: l.role,
        laneKindByte: l.laneKindByte,
        bpsShare: l.bpsShare,
        kesPerKwh: l.kesPerKwh,
      })),
      statutoryBreakdown: {
        rep: { kes: 1.2, ratePct: 5, base: 23.0 },
        epraWarma: { kes: 0.1, note: 'combined EPRA+WARMA at 1-decimal display' },
        vat: { kes: 3.7, ratePct: 16, base: 23.0 },
      },
    },
    scheduleId: scheduleIdHex,
    scheduleTxHash,
    laneTxHashes: laneResults,
    governanceInit: monolithManifest.governanceInit,
    auditWriter: {
      publicKeyHex: monolithManifest.auditWriter.publicKeyHex,
      privateKeyPath: monolithManifest.auditWriter.privateKeyPath,
    },
    validatorAttestorHex,
    validatorAttestorNote:
      'PLACEHOLDER - audit-writer keypair used as WI-16 validator attestor. Rotate post-launch via owner op.',
    elapsedMs: Date.now() - start,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[pilot-monolith] manifest written: ${manifestPath}`);
  console.log(`[pilot-monolith] ALL DONE (${Date.now() - start}ms)`);
}

main().catch((err) => {
  console.error('[pilot-monolith] FAILED:', err);
  process.exit(1);
});
