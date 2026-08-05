// EBT v8 settle-flow ceremony orchestrator (Preview). Run as plain .mjs under
// node from ~/contracts/ebt (node_modules symlink -> settlement-api realm).
// Steps (subcommand argv[2]): head | attest | settle | revoke | inspect
//
// Owner wallet = deploy seed (also EBT/registry owner + DUST). Provide via
// OWNER_SEED env. Meter-authority HAT signature for settle is produced by a
// relay-side signer (key stays on relay); this script fetches it over SSH-less
// HTTP only if SETTLE is run (see settle section).
import { WebSocket } from 'ws'; globalThis.WebSocket = WebSocket;
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';
import * as Rx from 'rxjs';

import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import * as ledgerV8 from '@midnight-ntwrk/ledger-v8';
import {
  CompactTypeBytes, CompactTypeVector, convertFieldToBytes, persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
(ed).hashes.sha512 = sha512;
function edVerifySync(sig, msg, pk) { return ed.verify(sig, msg, pk); }
import { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { createKeystore, InMemoryTransactionHistoryStorage, PublicKey, UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';

// ------------------------------------------------------------------ constants
const EBT = 'c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3';
const REG = '556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9';
const EBT_BUILD = '/home/pollpower/contracts/ebt/build/v8';
const REG_BUILD = '/home/pollpower/contracts/ebt/registry-build/ceremony';
const INDEXER = 'https://indexer.preview.midnight.network/api/v3/graphql';
const INDEXER_WS = 'wss://indexer.preview.midnight.network/api/v3/graphql/ws';
const NODE_WS = 'wss://rpc.preview.midnight.network';
const PROOF = 'http://127.0.0.1:6300';

const ACTION_LOG_DEPTH = 24;
const MIRROR_NODE_TAG = 'pp:tariff:v1:actionLogNode';
const MIRROR_EMPTY_LEAF_TAG = 'pp:tariff:v1:actionLogEmpty';

// Pilot producer identity for this ceremony (deterministic, documented).
// attestationKey = persistentHash([producerBytes, meterKeyHash]).
const PILOT_PRODUCER_BYTES = 'a11ce0000000000000000000000000000000000000000000000000000000e2e1'; // pilot producer "alice" e2e id
const PILOT_METER_KEY_HASH = 'be7e40000000000000000000000000000000000000000000000000000000e2e0'; // pilot meter-key hash e2e id (all-hex)

const hx = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ''), 'hex'));
const hx32 = (s) => { const u = hx(s); if (u.length !== 32) throw new Error(`expected 32-byte hex, got ${u.length} from ${s}`); return u; };
const toHex = (u) => Buffer.from(u).toString('hex');
const BYTES_32 = new CompactTypeBytes(32);

// ---------------------------------------------------------------- hashing/merkle
function padTag(tag) {
  const enc = Buffer.from(tag, 'utf8');
  const out = new Uint8Array(32); out.set(enc, 0); return out;
}
function persistentHashBytes(inputs) {
  return persistentHash(new CompactTypeVector(inputs.length, BYTES_32), inputs);
}
function pairHash(l, r) { return persistentHashBytes([padTag(MIRROR_NODE_TAG), l, r]); }
function initEmptyTree(depth = ACTION_LOG_DEPTH) {
  const zeros = []; zeros[0] = padTag(MIRROR_EMPTY_LEAF_TAG);
  for (let i = 1; i <= depth; i++) zeros[i] = pairHash(zeros[i-1], zeros[i-1]);
  return { depth, zeros, leaves: [] };
}
function appendLeaf(tree, seq, leaf) {
  if (BigInt(tree.leaves.length) !== seq) throw new Error(`appendLeaf oo: ${tree.leaves.length} vs ${seq}`);
  tree.leaves.push(new Uint8Array(leaf));
}
function buildLevels(tree) {
  const levels = []; levels[0] = new Map();
  for (let i = 0; i < tree.leaves.length; i++) levels[0].set(i, tree.leaves[i]);
  for (let level = 0; level < tree.depth; level++) {
    const cur = levels[level]; const next = new Map();
    if (cur.size > 0) {
      const parents = new Set();
      for (const idx of cur.keys()) parents.add(Math.floor(idx/2));
      for (const p of parents.values()) {
        const left = cur.get(p*2) ?? tree.zeros[level];
        const right = cur.get(p*2+1) ?? tree.zeros[level];
        next.set(p, pairHash(left, right));
      }
    }
    levels[level+1] = next;
  }
  return { levels, root: levels[tree.depth].get(0) ?? tree.zeros[tree.depth] };
}
function computeRoot(tree) { return buildLevels(tree).root; }
function buildInclusionProof(tree, seq) {
  const levels = buildLevels(tree).levels;
  let idx = Number(seq); const siblings = []; const bits = [];
  for (let level = 0; level < tree.depth; level++) {
    const sib = idx ^ 1;
    siblings.push(levels[level].get(sib) ?? tree.zeros[level]);
    bits.push((idx & 1) === 1);
    idx = Math.floor(idx/2);
  }
  return { siblings, bits };
}
function bytesEqual(a, b) { if (a.length !== b.length) return false; for (let i=0;i<a.length;i++) if(a[i]!==b[i]) return false; return true; }

// ------------------------------------------------------------------ loaders
async function loadLedger(buildPath) {
  const mod = await import(pathToFileURL(path.join(buildPath, 'contract', 'index.js')).href);
  return mod.ledger;
}
function toActionEntry(raw) {
  return {
    kind: BigInt(raw.kind), scheduleId: new Uint8Array(raw.scheduleId),
    nodeId: new Uint8Array(raw.nodeId), epoch: BigInt(raw.epoch),
    actionHash: new Uint8Array(raw.actionHash), emittedAt: BigInt(raw.emittedAt),
    payloadHash: new Uint8Array(raw.payloadHash),
  };
}

// Rebuild registry action-log tree live; verify root matches on-chain. Return
// {entries, tree, headSeq, root}.
async function buildRegistryTree(pdp) {
  const regLedgerFn = await loadLedger(REG_BUILD);
  const st = await pdp.queryContractState(REG);
  if (!st) throw new Error('no registry state');
  const r = regLedgerFn(st.data);
  const actionSeq = BigInt(r._actionSeq);
  const baseSeq = BigInt(r._actionLogBaseSeq);
  const onChainRoot = new Uint8Array(r.registryActionLogRoot);
  const entries = [];
  const tree = initEmptyTree();
  for (let seq = baseSeq; seq < actionSeq; seq++) {
    if (!r._actionLog.member(seq)) throw new Error(`missing action entry ${seq}`);
    const e = toActionEntry(r._actionLog.lookup(seq));
    appendLeaf(tree, seq - baseSeq, e.payloadHash);
    entries.push(e);
  }
  const localRoot = computeRoot(tree);
  if (!bytesEqual(localRoot, onChainRoot)) {
    throw new Error(`ROOT DRIFT local=${toHex(localRoot)} onchain=${toHex(onChainRoot)}`);
  }
  return { entries, tree, baseSeq, headSeq: actionSeq - 1n, root: onChainRoot };
}

// ------------------------------------------------------------------ wallet
async function makeOwnerContract() {
  setNetworkId('preview');
  const seedHex = (process.env.OWNER_SEED || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error('OWNER_SEED must be 64-hex');
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  const derived = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  const networkId = getNetworkId();
  const shieldedSecretKeys = ledgerV8.ZswapSecretKeys.fromSeed(derived.keys[Roles.Zswap]);
  const dustSecretKey = ledgerV8.DustSecretKey.fromSeed(derived.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(derived.keys[Roles.NightExternal], networkId);
  const configuration = {
    networkId,
    indexerClientConnection: { indexerHttpUrl: INDEXER, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300000000000000n, feeBlocksMargin: 5 },
    relayURL: new URL(NODE_WS),
    provingServerUrl: new URL(PROOF),
  };
  const wallet = await WalletFacade.init({
    configuration,
    shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, ledgerV8.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);
  console.log('waiting for owner wallet sync...');
  const state = await Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced), Rx.timeout(240000)));
  const dustBal = state.dust?.balance ? state.dust.balance(new Date()) : 'n/a';
  console.log('owner wallet synced. dust balance:', String(dustBal));

  const walletProvider = {
    getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
    getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
    async balanceTx(tx, ttl) {
      const recipe = await wallet.balanceUnboundTransaction(tx,
        { shieldedSecretKeys, dustSecretKey }, { ttl: ttl ?? new Date(Date.now() + 30*60*1000) });
      const signed = await wallet.signRecipe(recipe, (payload) => unshieldedKeystore.signData(payload));
      return wallet.finalizeRecipe(signed);
    },
    submitTx: (tx) => wallet.submitTransaction(tx),
  };
  const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const zkConfigProvider = new NodeZkConfigProvider(EBT_BUILD);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'ebt-v8-ceremony',
      privateStoragePasswordProvider: () => 'EbtV8Ceremony2026-pw',
      accountId: state.shielded.coinPublicKey.toHexString(),
      walletProvider,
    }),
    publicDataProvider: pdp,
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
  const ebtModule = await import(pathToFileURL(path.join(EBT_BUILD, 'contract', 'index.js')).href);
  const witnesses = {
    signature_valid: (ctx, _pubkey, messageHash, signature) => {
      const ps = ctx?.privateState ?? ctx;
      const ok = hatWitnessResult(_pubkey, messageHash, signature);
      return [ps, ok];
    },
    multisig_signature_valid: (ctx, _payload, _authorityHash) => [ctx?.privateState ?? ctx, false],
  };
  const compiled = CompiledContract.make('ebt-v8', ebtModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(EBT_BUILD),
  );
  const contract = await findDeployedContract(providers, {
    contractAddress: EBT, compiledContract: compiled,
    privateStateId: 'ebt-v8-ceremony', initialPrivateState: {},
  });
  return { contract, pdp, state };
}

// signature_valid witness: for settle, verify the relay HAT sig against the
// runtime's messageHash (the circuit's payloadHash). ALSO assert the runtime's
// messageHash equals our precomputed payloadHash (so we KNOW the sig is over the
// exact bytes the circuit checks). If __HAT_MSGHASH_EXPECT/__HAT_SIG are unset
// (non-settle steps), fall back to false (those steps don't call signature_valid).
function hatWitnessResult(pubkey, messageHash, signature) {
  try {
    const mh = new Uint8Array(messageHash);
    if (globalThis.__HAT_MSGHASH_EXPECT_G) {
      const exp = globalThis.__HAT_MSGHASH_EXPECT_G;
      const same = exp.length === mh.length && exp.every((b,i)=>b===mh[i]);
      console.log('[witness] signature_valid runtime msgHash=', toHexLocal(mh), 'matchesPrecomputed=', same);
      if (!same) { console.error('FATAL: runtime payloadHash != precomputed; aborting sig'); return false; }
    }
    const sig = globalThis.__HAT_SIG_G ? globalThis.__HAT_SIG_G : new Uint8Array(signature);
    const ok = edVerifySync(sig, mh, new Uint8Array(pubkey));
    console.log('[witness] signature_valid verify=', ok);
    return ok;
  } catch (e) { console.error('[witness] signature_valid err', e?.message); return false; }
}
function toHexLocal(u){ return Buffer.from(u).toString('hex'); }

function txh(tx) {
  return tx?.public?.txHash ?? tx?.public?.txId ?? tx?.txHash ?? tx?.txId ?? 'unknown';
}

// ------------------------------------------------------------------ steps
async function stepHead() {
  const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const reg = await buildRegistryTree(pdp);
  const relHead = reg.headSeq - reg.baseSeq;
  const latest = reg.entries[Number(relHead)];
  const ip = buildInclusionProof(reg.tree, relHead);
  const latestEntry = {
    kind: BigInt(latest.kind), scheduleId: latest.scheduleId, nodeId: latest.nodeId,
    epoch: latest.epoch, actionHash: latest.actionHash, emittedAt: latest.emittedAt,
    payloadHash: latest.payloadHash,
  };
  const proof = {
    actionSeq: reg.headSeq, payloadHash: latest.payloadHash,
    merkleProof: ip.siblings, merkleSiblings: ip.bits,
  };
  console.log(`head advance target seq=${reg.headSeq} root=${toHex(reg.root)}`);
  const { contract } = await makeOwnerContract();
  console.log('submitting mirrorActionLogHead...');
  const tx = await contract.callTx.mirrorActionLogHead(reg.headSeq, latestEntry, proof);
  console.log('MIRROR_ACTION_LOG_HEAD SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

async function stepAttest() {
  const producerBytes = hx32(PILOT_PRODUCER_BYTES);
  const meterKeyHash = hx32(PILOT_METER_KEY_HASH);
  const attestationKey = persistentHashBytes([producerBytes, meterKeyHash]);
  const reasonCode = 1n; // 1 = pilot onboarding
  const evidenceHash = hx32('e0e0e0e0'.padEnd(64,'0').slice(0,64));
  const currentTime = BigInt(Math.floor(Date.now()/1000));
  console.log('attestationKey:', toHex(attestationKey));
  console.log('producerBytes :', toHex(producerBytes));
  console.log('meterKeyHash  :', toHex(meterKeyHash));
  console.log('currentTime   :', currentTime.toString());
  const { contract } = await makeOwnerContract();
  console.log('submitting attestProducerOwnership...');
  const tx = await contract.callTx.attestProducerOwnership(
    attestationKey, producerBytes, meterKeyHash, reasonCode, evidenceHash, currentTime);
  console.log('ATTEST_PRODUCER_OWNERSHIP SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

async function stepRevoke() {
  const producerBytes = hx32(PILOT_PRODUCER_BYTES);
  const meterKeyHash = hx32(PILOT_METER_KEY_HASH);
  const attestationKey = persistentHashBytes([producerBytes, meterKeyHash]);
  const reasonCode = 2n; // 2 = pilot teardown / bookend
  const evidenceHash = hx32('e1e1e1e1'.padEnd(64,'0').slice(0,64));
  const currentTime = BigInt(Math.floor(Date.now()/1000));
  console.log('revoking attestationKey:', toHex(attestationKey));
  const { contract } = await makeOwnerContract();
  console.log('submitting revokeProducerOwnership...');
  const tx = await contract.callTx.revokeProducerOwnership(
    attestationKey, reasonCode, evidenceHash, currentTime);
  console.log('REVOKE_PRODUCER_OWNERSHIP SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

// ------------------------------------------------------------------ mirror steps
// classPath + split MUST match the retuneClass emitted in step A.
const CLASS_PATH = 'c1a55a7400000000000000000000000000000000000000000000000000000001';
const RETUNE_SPLIT = {
  producerShareBps:  4643n, ldShareBps: 1572n, opsShareBps: 2000n,
  daoShareBps: 0n, operatorMarginBps: 0n, statutoryTotalBps: 1785n,
};
const RETUNE_RATE = 28n;
// lastUpdatedAt = the currentTime passed to retuneClass = emittedAt of seq-5 entry.
// We read it live from the on-chain entry (entry.emittedAt) so no drift.

function entryToStruct(e) {
  return {
    kind: BigInt(e.kind), scheduleId: new Uint8Array(e.scheduleId),
    nodeId: new Uint8Array(e.nodeId), epoch: BigInt(e.epoch),
    actionHash: new Uint8Array(e.actionHash), emittedAt: BigInt(e.emittedAt),
    payloadHash: new Uint8Array(e.payloadHash),
  };
}

// STEP B1: mirrorActionLogRoot owner-advance to the new registry root.
async function stepMirrorRoot() {
  const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const reg = await buildRegistryTree(pdp);
  // Use the HEAD entry (seq = headSeq) as the sample; inclusion proof vs NEW root.
  const relHead = reg.headSeq - reg.baseSeq;
  const sample = reg.entries[Number(relHead)];
  const ip = buildInclusionProof(reg.tree, relHead);
  const sampleEntry = entryToStruct(sample);
  const proof = {
    actionSeq: reg.headSeq, payloadHash: sample.payloadHash,
    merkleProof: ip.siblings, merkleSiblings: ip.bits,
  };
  console.log(`mirror-root newRoot=${toHex(reg.root)} sampleSeq=${reg.headSeq}`);
  const { contract } = await makeOwnerContract();
  console.log('submitting mirrorActionLogRoot...');
  const tx = await contract.callTx.mirrorActionLogRoot(reg.root, sampleEntry, proof);
  console.log('MIRROR_ACTION_LOG_ROOT SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

// STEP B2: mirrorClassStatutoryTotal for the kind-2 retuneClass event (seq 5).
async function stepMirrorClass() {
  const pdp = indexerPublicDataProvider(INDEXER, INDEXER_WS);
  const reg = await buildRegistryTree(pdp);
  // Find the kind-2 entry (retuneClass). Should be seq 5.
  let targetRel = -1;
  for (let i = 0; i < reg.entries.length; i++) {
    if (reg.entries[i].kind === 2n) { targetRel = i; break; }
  }
  if (targetRel < 0) throw new Error('no kind-2 (retuneClass) entry found');
  const absSeq = reg.baseSeq + BigInt(targetRel);
  const entry = reg.entries[targetRel];
  const ip = buildInclusionProof(reg.tree, targetRel);
  const entryStruct = entryToStruct(entry);
  const proof = {
    actionSeq: absSeq, payloadHash: entry.payloadHash,
    merkleProof: ip.siblings, merkleSiblings: ip.bits,
  };
  const scheduleId = hx32(SCHEDULE_ID_HEX());
  const classPath = hx32(CLASS_PATH);
  const lastUpdatedAt = entry.emittedAt; // = retune currentTime
  console.log(`mirror-class seq=${absSeq} payloadHash=${toHex(entry.payloadHash)} lastUpdatedAt=${lastUpdatedAt}`);
  console.log('split=', JSON.stringify(RETUNE_SPLIT,(k,v)=>String(v)));
  const { contract } = await makeOwnerContract();
  console.log('submitting mirrorClassStatutoryTotal...');
  const tx = await contract.callTx.mirrorClassStatutoryTotal(
    entryStruct, scheduleId, classPath, RETUNE_SPLIT, RETUNE_RATE, lastUpdatedAt, proof);
  console.log('MIRROR_CLASS_STATUTORY_TOTAL SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

function SCHEDULE_ID_HEX() { return '0a0ca2e41632da85802a34207c58883f54cc2a1375ca77887c7b8dc682df101a'; }

// ------------------------------------------------------------------ settle
// The settle HAT payload + coherent amounts. Signed relay-side (key stays on relay).
const SETTLE = {
  sessionID:    '5e771e0000000000000000000000000000000000000000000000000000005e01', // pilot settle test session
  hatPubkey:    'bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a', // _meterAuthorityPubkey
  amount:       100000n,
  producerKey:  'a11ce0000000000000000000000000000000000000000000000000000000e2e1', // attested producerBytes
  producerAddr: 'a11ce0000000000000000000000000000000000000000000000000000000e2e1', // mint target (pilot producer addr)
  meterKeyHash: 'be7e40000000000000000000000000000000000000000000000000000000e2e0',
  epoch:        2n,   // lanes effectiveEpoch=2
  fiatValueAtMint: 28n, // band [1,1e9]
  charterNodeId: '96a0e3b3020797f3e5ffd0687834564427b88f084c5b3e424526b492a66a0d0c', // leviedBy for statutory lane
};
// HAT sig is produced relay-side via settle-flow/relay-hat-sign.mjs (key stays
// on the relay; AUTHORITY_KEY_PASSPHRASE supplied there) and passed in here via
// the HAT_SIG env (128-hex). See SETTLE-FLOW-E2E.md §5.

// Build the v8 6-field settle payloadHash EXACTLY as the circuit does.
function settlePayloadHash(sessionID, hatPubkey, amount, producerKey, producerAddrBytes) {
  const amountBytes = convertFieldToBytes(32, amount, 'amount');
  return persistentHashBytes([
    padTag('pollpower:ebt:v8:epoch1'),
    sessionID, hatPubkey, new Uint8Array(amountBytes), producerKey, producerAddrBytes,
  ]);
}

// HAT sig is produced relay-side (key stays on relay) and supplied via HAT_SIG
// env (128-hex). We also recompute payloadHash and assert HAT_MSGHASH env (if
// given) matches, so a stale sig can't be used.

async function stepSettle() {
  const sessionID = hx32(SETTLE.sessionID);
  const hatPubkey = hx32(SETTLE.hatPubkey);
  const producerKey = hx32(SETTLE.producerKey);
  const producerAddrBytes = hx32(SETTLE.producerAddr);
  const meterKeyHash = hx32(SETTLE.meterKeyHash);
  const scheduleId = hx32(SCHEDULE_ID_HEX());
  const classPath = hx32(CLASS_PATH);
  const charterNodeId = hx32(SETTLE.charterNodeId);
  const amount = SETTLE.amount;

  // Compute payloadHash and get the relay HAT signature.
  const payloadHash = settlePayloadHash(sessionID, hatPubkey, amount, producerKey, producerAddrBytes);
  const payloadHashHex = toHex(payloadHash);
  console.log('settle payloadHash:', payloadHashHex);
  if (process.argv[3] === 'hash-only') { console.log('PAYLOADHASH', payloadHashHex); process.exit(0); }
  const hatSigHex = (process.env.HAT_SIG || '').trim();
  if (!/^[0-9a-f]{128}$/.test(hatSigHex)) throw new Error('HAT_SIG env must be 128-hex (relay-signed over payloadHash)');
  console.log('relay HAT sig:', hatSigHex);
  const hatSig = new Uint8Array(Buffer.from(hatSigHex, 'hex'));
  // Wire globals the signature_valid witness reads.
  globalThis.__HAT_MSGHASH_EXPECT_G = payloadHash;
  globalThis.__HAT_SIG_G = hatSig;

  // Lane enumeration: slot0 = statutory lane (kind 3, bps 1785); slots1-3 empty.
  const zero32b = new Uint8Array(32);
  const leviedBys = [charterNodeId, new Uint8Array(32), new Uint8Array(32), new Uint8Array(32)];
  const laneKindBytes = [3n, 0n, 0n, 0n];
  const laneAmts = [17850n, 0n, 0n, 0n];
  // Non-statutory keeper bps + amounts (sum with statutory 1785 lane = 100000).
  const operatorMarginBps = 4643n, opsBps = 2000n, ldBps = 1572n, daoBps = 0n;
  const producerAmt = 46430n, opsAmt = 20000n, divAmt = 15720n, daoAmt = 0n;
  const currentTime = BigInt(Math.floor(Date.now()/1000));

  console.log('sanity: statutorySum(1785)==total; whole=4643+2000+1572+0+1785=10000; amounts sum=', String(producerAmt+opsAmt+divAmt+daoAmt+17850n));

  const { contract } = await makeOwnerContract();
  console.log('submitting settle...');
  const tx = await contract.callTx.settle(
    sessionID, hatPubkey, amount, producerKey, { bytes: producerAddrBytes }, meterKeyHash, hatSig,
    scheduleId, classPath, SETTLE.epoch, SETTLE.fiatValueAtMint,
    leviedBys, laneKindBytes, laneAmts,
    operatorMarginBps, opsBps, ldBps, daoBps,
    producerAmt, opsAmt, divAmt, daoAmt, currentTime);
  console.log('SETTLE SUBMITTED. txHash:', txh(tx));
  process.exit(0);
}

const cmd = process.argv[2];
if (cmd === 'head') await stepHead();
else if (cmd === 'attest') await stepAttest();
else if (cmd === 'revoke') await stepRevoke();
else if (cmd === 'mirror-root') await stepMirrorRoot();
else if (cmd === 'mirror-class') await stepMirrorClass();
else if (cmd === 'settle') await stepSettle();
else { console.error('usage: node ceremony.mjs head|attest|revoke|mirror-root|mirror-class|settle'); process.exit(2); }
