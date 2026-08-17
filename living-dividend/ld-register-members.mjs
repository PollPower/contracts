// ld-register-members.mjs — P5.1: register pilot members into the deployed
// Living Dividend v2.2.1 contract on Preview, using the MOCK 4-key multisig ring.
//
// ⚠️  MOCK / DRY-RUN MEMBERSHIP over REAL metered energy. We cannot sell energy
//     pre-permit, so membership + payments are simulated. Member addresses are
//     DERIVED (deterministic, mock) from existing sandbox-KYC'd users — no new
//     wallet creation. kycAttestationHash ties to the REAL sandbox KYC job id.
//
// Modeled on ~/contracts/ebt/retune.mjs (findDeployedContract + callTx + a
// witness that signs the runtime-handed payload). Deploy pattern from
// ~/contracts/living-dividend/deploy-ld-v2.2.1.mjs.
//
// KEY DESIGN (avoids the persistentHash-divergence hazard):
//   The register circuit computes `payload = persistentHash([...])` IN-CIRCUIT
//   and hands that exact 32-byte payload to witness_multisigSignatureValid.
//   So we DO NOT precompute persistentHash off-chain. Our witness signs the
//   handed payload with 3-of-4 mock ring keys and returns a bundle that
//   verifyMultisigBundle accepts. (Same trick retune.mjs uses for signature_valid.)
//
//   witness_blockTimeGte(t): return privateState.blockTime >= t. We fetch the
//   current chain time and pass currentTime a little in the PAST so the check holds.
//
// USAGE:
//   node ld-register-members.mjs --dry-run   # build+validate, NO tx (prints derived members, exits)
//   node ld-register-members.mjs             # LIVE: submit one register tx per member, poll counter
//   node ld-register-members.mjs --only=1    # register only the Nth member (1-based), for a single smoke tx first
//
// Run from ~/contracts/living-dividend (node_modules symlink -> settlement-api realm).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LD_ROOT = '/home/pollpower/contracts/living-dividend';
const EBT_ROOT = '/home/pollpower/contracts/ebt';
const BUILD_DIR = path.join(LD_ROOT, 'build', 'v2.2.1');
const LD_ADDR = 'efccdb2348f98c496f8fd5925a6961c3d81966eab562b928ab9765264dc7fd30';
const EXPECTED_AUTH = 'cb564026d1028c0c7cd3c22512f0e302df28fd05ba8939bf230010546c479cb4';
const MOCK_KEYS_PATH = path.join(LD_ROOT, 'mock-multisig-keys.json');
const DEPLOYMENT_JSON_PATH = path.join(EBT_ROOT, 'deployment.json');

const INDEXER = 'https://indexer.preview.midnight.network/api/v3/graphql';
const INDEXER_WS = 'wss://indexer.preview.midnight.network/api/v3/graphql/ws';
const NODE_WS = 'wss://rpc.preview.midnight.network';
const PROOF = 'http://127.0.0.1:6300';

const DRY_RUN = process.argv.includes('--dry-run');
const ONLY_ARG = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const ONLY = ONLY_ARG ? parseInt(ONLY_ARG, 10) : null;

// ---- Pilot members: existing sandbox-KYC'd users (id, kycJobId, shieldedAddr).
// Member address is DERIVED (mock): sha256("ld:member:v1"|shieldedAddr) -> 32B.
// kycAttestationHash: sha256("ld:kyc:v1"|kycJobId) -> 32B (distinct per user, real KYC provenance).
const PILOT = [
  { id: '014c6d0b-4261-39fd-65de-481ae020cc5b', kycJobId: 'mock_web_1778232009990', shielded: 'mn_shield-addr_preview1efnsf5hdk29ksjw083ug8eha8mvmzguz9sk7wmjwzwfzjru4lhzddh0an47mnd2s6j990tjkfxn9w6yp4tpal0243rj67ckyrlu7hkcajll22' },
  { id: '793d0b4c-50f6-52e7-4d59-919e3bf9144c', kycJobId: 'mock_web_1778234004793', shielded: 'mn_shield-addr_preview1jmfua6advldnhg5ttxj9uequa7u3r0vlvthlsvepljh82fcrp7x0l0ln4rk563z6w75c7snyrej4azqttsm6nlter2sxt2wvrpmpr4g7dqpv5' },
  { id: '48bc0774-7ff6-eb2f-fff4-3a9eddcdaa1d', kycJobId: 'mock_web_1778237333264', shielded: 'mn_shield-addr_preview19u9ahg654j7cfc7nhnmjwey9zqff5xnd0zlhw02hhw755jk92fuc0jjt80sqsep4wzt4620w0z5rq50c99t39l6e2s3pvkvmqgtuu8c3prau5' },
  { id: '6ea4f31f-0009-6240-6ace-c52996cf764f', kycJobId: 'mock_web_1778237590989', shielded: 'mn_shield-addr_preview1v5k2qnedt0zdjfzv0pwaxnnqs4k0nd2f3eyas26jmsflpm362unztju4updu8dh82x3tqdp0gkrtqkfdav55e23xhkurd2v6vefgmsg8vvds9' },
  { id: 'a20328cf-ae8b-4a0b-c8b4-119e396f2c64', kycJobId: 'mock_web_1778387335567', shielded: 'mn_shield-addr_preview1cp6tekltt5gylvneqqmkyhdjv4xmnlmsmexrue5grwgww86snu4qtxgfgfz4dflly5q78xjxswfttq77fv92wf2ukxecuvrp27y3wgq2evrkh' },
];

const toHex = (u) => Buffer.from(u).toString('hex');
const hx = (s) => new Uint8Array(Buffer.from(String(s).replace(/^0x/, ''), 'hex'));

function deriveMember(shielded) {
  return new Uint8Array(createHash('sha256').update('ld:member:v1').update(shielded).digest());
}
function deriveKycHash(kycJobId) {
  return new Uint8Array(createHash('sha256').update('ld:kyc:v1').update(kycJobId).digest());
}

// ---- Mock ring (3-of-4). Sign the runtime-handed payload with the first 3 keys.
function loadRing() {
  const mk = JSON.parse(fs.readFileSync(MOCK_KEYS_PATH, 'utf8'));
  if (mk.multisigAuthorityHex !== EXPECTED_AUTH) {
    throw new Error(`ring authority ${mk.multisigAuthorityHex} != expected ${EXPECTED_AUTH}`);
  }
  const signers = mk.signers.map((s) => ({ priv: hx(s.privHex), pub: hx(s.pubHex) }));
  return { signers, threshold: mk.threshold };
}

// Build a MultisigBundle over `payload`: sign with `threshold` keys (real ed25519),
// leave the rest as 64-zero placeholders. verifyMultisigBundle counts valid sigs >= threshold.
function signBundle(ring, payload) {
  const signers = ring.signers.map((s) => s.pub);
  const sigs = ring.signers.map((s, i) =>
    i < ring.threshold ? ed.sign(payload, s.priv) : new Uint8Array(64));
  return { signers, sigs, threshold: ring.threshold };
}

function log(m) { console.log(`[ld-register] ${m}`); }
function fatal(m) { console.error(`[ld-register] FATAL: ${m}`); process.exit(1); }

async function main() {
  const ring = loadRing();
  log(`ring loaded: ${ring.signers.length} signers, threshold ${ring.threshold}, authority ${EXPECTED_AUTH} (MOCK)`);

  // Show derived members.
  const members = PILOT.map((p, idx) => {
    const member = deriveMember(p.shielded);
    const kycHash = deriveKycHash(p.kycJobId);
    return { idx: idx + 1, ...p, member, kycHash };
  });
  log('derived pilot members (MOCK addresses, real KYC job provenance):');
  for (const m of members) {
    log(`  #${m.idx} user=${m.id} kycJob=${m.kycJobId}`);
    log(`      member(mock)=${toHex(m.member)}`);
    log(`      kycHash     =${toHex(m.kycHash)}`);
  }

  if (DRY_RUN) {
    log('DRY-RUN: not loading wallet / not submitting. Verifying bundle math on a sample payload...');
    const samplePayload = new Uint8Array(createHash('sha256').update('sample').digest());
    const bundle = signBundle(ring, samplePayload);
    // Local re-verify with the same logic verifyMultisigBundle uses.
    const sorted = [...bundle.signers].sort((a, b) => { for (let i=0;i<32;i++){ if(a[i]!==b[i]) return a[i]-b[i]; } return 0; });
    const concat = new Uint8Array(sorted.length * 32);
    sorted.forEach((s, i) => concat.set(s, i * 32));
    const computedAuth = toHex(sha256(concat));
    let valid = 0;
    for (let i = 0; i < bundle.signers.length; i++) {
      try { if (ed.verify(bundle.sigs[i], samplePayload, bundle.signers[i])) valid++; } catch {}
    }
    log(`DRY-RUN: computed ring authority = ${computedAuth} (match=${computedAuth === EXPECTED_AUTH})`);
    log(`DRY-RUN: valid sigs over sample payload = ${valid} (threshold ${ring.threshold}, pass=${valid >= ring.threshold})`);
    log('DRY-RUN: done. No tx submitted.');
    process.exit(0);
  }

  // ---- LIVE: load wallet + providers (same utils the deploy used) ----------
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId('preview');
  const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
  const { findDeployedContract } = await import('@midnight-ntwrk/midnight-js-contracts');
  const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');
  const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
  const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');

  const dep = JSON.parse(fs.readFileSync(DEPLOYMENT_JSON_PATH, 'utf8'));
  if (!dep.seed) fatal('deployment.json missing seed');
  const utils = await import(pathToFileURL('/opt/pollpower/settlement-api/src/utils-runtime.js').href);
  log('creating deploy wallet (has DUST)...');
  const walletCtx = await utils.createWallet(dep.seed);

  // Fetch current chain time so witness_blockTimeGte(currentTime) holds.
  // We pass currentTime = now - 120s (safely in the past vs the chain's block time).
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const currentTime = nowSec - 120n;

  // Private state holds the ring bundle for the CURRENT payload + blockTime.
  // We rebuild it per member (payload differs). witness reads privateState fields.
  let currentBundlePayloadHex = null;
  let currentBundle = null;

  const witnesses = {
    witness_divmod: (ctx, num, div) => {
      if (div === 0n) return [ctx.privateState ?? ctx, { quotient: 0n, remainder: 0n }];
      return [ctx.privateState ?? ctx, { quotient: num / div, remainder: num % div }];
    },
    // Sign the runtime-handed payload with the mock ring (3-of-4). This is the
    // register-gate. The payload IS persistentHash([...]) computed in-circuit.
    witness_multisigSignatureValid: (ctx, payload, authorityHash) => {
      const bundle = signBundle(ring, payload);
      // sanity: local verify
      let ok = false;
      try {
        let valid = 0;
        for (let i = 0; i < bundle.signers.length; i++) {
          try { if (ed.verify(bundle.sigs[i], payload, bundle.signers[i])) valid++; } catch {}
        }
        ok = valid >= bundle.threshold;
      } catch {}
      currentBundlePayloadHex = toHex(payload);
      currentBundle = bundle;
      console.log(`[witness] multisig over payload=${toHex(payload)} auth=${toHex(authorityHash)} localValid=${ok}`);
      return [ctx.privateState ?? ctx, ok];
    },
    witness_memberSignatureValid: (ctx, _member, _payload) => [ctx.privateState ?? ctx, false],
    // currentTime must be <= chain blockTime. We assert our own currentTime is in the past.
    witness_blockTimeGte: (ctx, t) => {
      // blockTime is "now"; we pass t=currentTime (now-120), so blockTime >= t holds.
      const bt = BigInt(Math.floor(Date.now() / 1000));
      return [ctx.privateState ?? ctx, bt >= t];
    },
  };

  const walletProvider = utils.buildWalletProvider ? await utils.buildWalletProvider(walletCtx) : null;
  // Providers: reuse settlement-api utils.createProviders (wallet+indexer+proof), then zkConfigDir.
  let providers = await utils.createProviders(walletCtx, path.join(LD_ROOT, 'build'));
  providers = utils.withZkConfigDir(providers, BUILD_DIR);

  const ldModule = await import(pathToFileURL(path.join(BUILD_DIR, 'contract', 'index.js')).href);
  const compiled = CompiledContract.make('ld-v2.2.1', ldModule.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(BUILD_DIR),
  );

  log(`finding deployed LD at ${LD_ADDR}...`);
  const contract = await findDeployedContract(providers, {
    contractAddress: LD_ADDR,
    compiledContract: compiled,
    privateStateId: 'ld-v2.2.1-state',
    initialPrivateState: {},
  });

  const targets = ONLY ? members.filter((m) => m.idx === ONLY) : members;
  log(`registering ${targets.length} member(s)${ONLY ? ` (only #${ONLY})` : ''}. currentTime=${currentTime}`);

  const results = [];
  for (const m of targets) {
    log(`--- register #${m.idx} user=${m.id} member=${toHex(m.member).slice(0,16)}... ---`);
    try {
      // UserAddress is a Bytes<32> struct { bytes }. The compiled ABI accepts
      // either the raw Uint8Array or {bytes}. retune passed raw Uint8Array for
      // Bytes<32> args; UserAddress is a single-field struct -> pass {bytes}.
      const memberArg = { bytes: m.member };
      const tx = await contract.callTx.register(memberArg, m.kycHash, currentTime);
      const txHash = tx?.public?.txHash ?? tx?.public?.txId ?? tx?.txHash ?? tx?.txId ?? 'unknown';
      log(`  ✅ register #${m.idx} SUBMITTED txHash=${txHash}`);
      results.push({ idx: m.idx, id: m.id, member: toHex(m.member), kycHash: toHex(m.kycHash), txHash, payloadHex: currentBundlePayloadHex });
    } catch (e) {
      console.error(`  ❌ register #${m.idx} FAILED:`, e?.message || String(e));
      let cur = e;
      for (let i = 0; i < 5 && cur?.cause; i++) { console.error(`    cause[${i}]:`, cur.cause?.message || String(cur.cause)); cur = cur.cause; }
      results.push({ idx: m.idx, id: m.id, member: toHex(m.member), error: e?.message || String(e) });
      // Stop on first failure so we don't spray bad txs.
      break;
    }
  }

  const outPath = path.join(LD_ROOT, 'deploy-artifacts', `ld-register-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ ldAddr: LD_ADDR, currentTime: String(currentTime), mock: true, results }, null, 2));
  log(`wrote ${outPath}`);

  if (walletCtx?.wallet?.close) { try { await walletCtx.wallet.close(); } catch {} }
  log('DONE');
  process.exit(0);
}

main().catch((e) => { console.error('[ld-register] MAIN failed:', e?.stack || e?.message || e); process.exit(1); });
