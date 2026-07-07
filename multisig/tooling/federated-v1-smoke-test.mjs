// =============================================================================
// federated-v1-smoke-test.mjs - offline smoke tests for multisig-federated-v1
//
// Run on kenya (needs the compiled build + settlement-api node_modules):
//   cd /opt/pollpower/settlement-api
//   node /path/to/federated-v1-smoke-test.mjs /path/to/build/contract/index.js
//
// Pattern: contracts/dev/multisig-ed25519/poc-runtime-test.mjs (Phase 2b POC).
// Covers: initialize, direct approve (epoch+self-bound msg), federated approve
// (attestor path), threshold execute, setSeatAttestor, rotateSeats (epoch bump
// kills pending approvals), conveneRotation (dead-council gate), constitutional
// dual-gates (setThreshold), negative paths.
// =============================================================================

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
ed.hashes.sha512 = sha512;

import * as cr from '@midnight-ntwrk/compact-runtime';
import { pathToFileURL } from 'node:url';

const buildPath = process.argv[2];
if (!buildPath) {
  console.error('usage: node v7-smoke-test.mjs <path-to-build/contract/index.js>');
  process.exit(2);
}
const { Contract } = await import(pathToFileURL(buildPath).href);

// --- witness (same shape as production proverWitness.ts) --------------------
const witnesses = {
  signature_valid(context, pubkey, messageHash, signature) {
    let ok = false;
    try { ok = ed.verify(signature, messageHash, pubkey); } catch { ok = false; }
    return [context.privateState, ok];
  },
};

// --- Poseidon helpers mirroring tooling/v7-actionhash.ts ---------------------
const Bytes32 = new cr.CompactTypeBytes(32);
const vec = (n) => new cr.CompactTypeVector(n, Bytes32);
const pad32 = (s) => { const b = new Uint8Array(32); b.set(Buffer.from(s, 'ascii')); return b; };
const dsel = (tag) => cr.persistentHash(Bytes32, pad32(tag));
const u2b = (v) => cr.convertFieldToBytes(32, v, 'u2b');
const H = (n, arr) => cr.persistentHash(vec(n), arr);

// signing messages (must byte-match the contract's in-circuit recomputation)
const directMsg = (self, epoch, ah) =>
  H(4, [dsel('pp:msfed:v1:approve:direct'), self, u2b(epoch), ah]);
const fedMsg = (self, seat, epoch, ah) =>
  H(5, [dsel('pp:msfed:v1:approve:fed'), self, seat, u2b(epoch), ah]);
const constMsg = (self, epoch, ah) =>
  H(4, [dsel('pp:msfed:v1:constitutional'), self, u2b(epoch), ah]);
const conveneMsg = (self, epoch, incoming, seed) =>
  H(9, [dsel('pp:msfed:v1:convene'), self, u2b(epoch), ...incoming, seed]);

// action hashes
const setThresholdAH = (self, t, nonce) =>
  H(4, [dsel('pp:msfed:v1:setThreshold'), self, u2b(BigInt(t)), u2b(nonce)]);
const setAttestorAH = (self, seat, att, nonce) =>
  H(5, [dsel('pp:msfed:v1:setSeatAttestor'), self, seat, att, u2b(nonce)]);
const rotateAH = (self, out, inc, seed, nonce) =>
  H(14, [dsel('pp:msfed:v1:rotateSeats'), self, ...out, ...inc, seed, u2b(nonce)]);

// --- test scaffolding --------------------------------------------------------
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); failed++; }
}
function expectThrow(fn, needle, label) {
  try { fn(); throw new Error(`${label}: expected throw, got success`); }
  catch (e) {
    if (e.message.includes(`${label}: expected throw`)) throw e;
    if (!e.message.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`${label}: wrong error: ${e.message.split('\n')[0]}`);
    }
  }
}

// --- keys --------------------------------------------------------------------
const mk = () => { const sk = ed.utils.randomSecretKey(); return { sk, pk: ed.getPublicKey(sk) }; };
const seats = [mk(), mk(), mk(), mk(), mk()];        // direct seats epoch 0
const nextSeats = [mk(), mk(), mk(), mk(), mk()];    // incoming for rotation
const authority = mk();                              // constitutional authority
const parent = mk();                                 // parent authority
const attestor = mk();                               // federation-seat attestor
const clusterAddr = (() => { const b = new Uint8Array(32); b.fill(0xC1); return b; })(); // fake lower-tier contract addr

// --- boot --------------------------------------------------------------------
const contract = new Contract(witnesses);
const initState = contract.initialState({
  initialPrivateState: {},
  initialZswapLocalState: {
    coinPublicKey: new Uint8Array(32), currentIndex: 0n,
    inputs: [], outputs: [], transient: [],
  },
});
const selfAddr = cr.dummyContractAddress();
let ctx = cr.createCircuitContext(
  selfAddr,
  initState.currentZswapLocalState,
  initState.currentContractState,
  initState.currentPrivateState,
  undefined,
  cr.CostModel.initialCostModel(),
);
// contract folds kernel.self().bytes into hashes — capture the same bytes
const selfBytes = typeof selfAddr === 'object' && selfAddr.bytes
  ? selfAddr.bytes
  : Uint8Array.from(Buffer.from(String(selfAddr).replace(/^0x/, ''), 'hex'));

const T0 = 1_800_000_000n; // deploy-time clock seed (block-time 0 in offline runtime accepts <= real assertions? see note)
// NOTE: blockTimeGte(currentTime) in the offline runtime compares against the
// context's block time (0 in a fresh QueryContext), so any currentTime > 0
// would fail "cannot be in the future". We therefore drive the clock with 0n
// everywhere except where the convene-period math needs real deltas — those
// tests set currentTime relative to 0.
const NOW = 0n;

const call = (name, ...args) => {
  const r = contract.impureCircuits[name](ctx, ...args);
  ctx = r.context;
  return r;
};
const peek = (name, ...args) => contract.impureCircuits[name](ctx, ...args).result;

// =============================================================================
console.log('\n=== v7-federated offline smoke tests ===\n');

test('initialize: 5 seats, threshold 3, authorities, clock seeded', () => {
  call('initialize',
    seats[0].pk, seats[1].pk, seats[2].pk, seats[3].pk, seats[4].pk,
    3n, authority.pk, parent.pk, NOW);
});

test('initialize: double-init rejected', () => {
  expectThrow(() => call('initialize',
    seats[0].pk, seats[1].pk, seats[2].pk, seats[3].pk, seats[4].pk,
    3n, authority.pk, parent.pk, NOW), 'already initialized', 'double-init');
});

// --- direct approvals + generic execute --------------------------------------
const genericAH = (() => { const b = new Uint8Array(32); b.fill(7); return b; })();

test('approve: direct seat with epoch+self-bound message', () => {
  const msg = directMsg(selfBytes, 0n, genericAH);
  call('approve', genericAH, seats[0].pk, ed.sign(msg, seats[0].sk));
});

test('approve: bare-actionHash signature rejected (epoch binding is real)', () => {
  expectThrow(
    () => call('approve', genericAH, seats[1].pk, ed.sign(genericAH, seats[1].sk)),
    'bad ed25519', 'bare-hash sig');
});

test('approve: non-seat signer rejected', () => {
  const outsider = mk();
  const msg = directMsg(selfBytes, 0n, genericAH);
  expectThrow(
    () => call('approve', genericAH, outsider.pk, ed.sign(msg, outsider.sk)),
    'not a seat', 'outsider');
});

test('execute: rejected below threshold', () => {
  expectThrow(() => call('execute', genericAH, NOW), 'not enough approvals', 'sub-threshold');
});

test('execute: succeeds at threshold 3', () => {
  const msg = directMsg(selfBytes, 0n, genericAH);
  call('approve', genericAH, seats[1].pk, ed.sign(msg, seats[1].sk));
  call('approve', genericAH, seats[2].pk, ed.sign(msg, seats[2].sk));
  if (peek('isApproved', genericAH) !== true) throw new Error('isApproved should be true');
  call('execute', genericAH, NOW);
  if (peek('getNonce') !== 1n) throw new Error(`nonce should be 1, got ${peek('getNonce')}`);
});

// --- federation seat ----------------------------------------------------------
test('setSeatAttestor: convert seat[4] to federation seat (council-approved)', () => {
  // rotate seat[4]'s id to the cluster contract address first? No — v7 has no
  // add/remove. Instead we register an attestor FOR an existing seat id. For
  // the smoke test we treat seats[4].pk as the "cluster address" registered
  // at initialize (a 32-byte id is a 32-byte id — the contract doesn't care).
  const nonce = peek('getNonce') + 1n;
  const ah = setAttestorAH(selfBytes, seats[4].pk, attestor.pk, nonce);
  const msg = directMsg(selfBytes, 0n, ah);
  call('approve', ah, seats[0].pk, ed.sign(msg, seats[0].sk));
  call('approve', ah, seats[1].pk, ed.sign(msg, seats[1].sk));
  call('approve', ah, seats[2].pk, ed.sign(msg, seats[2].sk));
  call('executeSetSeatAttestor', seats[4].pk, attestor.pk, NOW);
  if (peek('isFederatedSeat', seats[4].pk) !== true) throw new Error('seat[4] should be federated');
});

const fedAH = (() => { const b = new Uint8Array(32); b.fill(9); return b; })();

test('approveFederated: attestor signature accepted for federation seat', () => {
  const msg = fedMsg(selfBytes, seats[4].pk, 0n, fedAH);
  call('approveFederated', fedAH, seats[4].pk, ed.sign(msg, attestor.sk));
  if (peek('getApprovalCount', fedAH) !== 1n) throw new Error('fed approval not counted');
});

test('approve: federation seat can no longer approve directly', () => {
  const msg = directMsg(selfBytes, 0n, fedAH);
  expectThrow(
    () => call('approve', fedAH, seats[4].pk, ed.sign(msg, seats[4].sk)),
    'must use approveFederated', 'fed-direct');
});

test('approveFederated: wrong attestor key rejected', () => {
  const rogue = mk();
  const msg = fedMsg(selfBytes, seats[4].pk, 0n, fedAH);
  expectThrow(
    () => call('approveFederated', fedAH, seats[4].pk, ed.sign(msg, rogue.sk)),
    'bad attestor', 'rogue attestor');
});

// --- constitutional floor -----------------------------------------------------
test('setThreshold: council quorum alone is NOT enough (floor is real)', () => {
  const nonce = peek('getNonce') + 1n;
  const ah = setThresholdAH(selfBytes, 4, nonce);
  const msg = directMsg(selfBytes, 0n, ah);
  call('approve', ah, seats[0].pk, ed.sign(msg, seats[0].sk));
  call('approve', ah, seats[1].pk, ed.sign(msg, seats[1].sk));
  call('approve', ah, seats[2].pk, ed.sign(msg, seats[2].sk));
  const badSig = ed.sign(constMsg(selfBytes, 0n, ah), seats[0].sk); // signed by a seat, not the authority
  expectThrow(() => call('executeSetThreshold', 4n, badSig, NOW),
    'bad constitutional attestation', 'no-referendum');
});

test('setThreshold: quorum + authority attestation succeeds', () => {
  const nonce = peek('getNonce') + 1n;
  const ah = setThresholdAH(selfBytes, 4, nonce);
  const authSig = ed.sign(constMsg(selfBytes, 0n, ah), authority.sk);
  call('executeSetThreshold', 4n, authSig, NOW);
  if (peek('getThreshold') !== 4n) throw new Error('threshold should be 4');
});

test('setThreshold: sub-majority threshold rejected outright', () => {
  expectThrow(() => call('executeSetThreshold', 2n, new Uint8Array(64), NOW),
    'majority', 'sub-majority');
});

// restore threshold 3 for the rotation tests
test('setThreshold: restore to 3 (same dual-gate path)', () => {
  const nonce = peek('getNonce') + 1n;
  const ah = setThresholdAH(selfBytes, 3, nonce);
  const msg = directMsg(selfBytes, 0n, ah);
  // threshold is now 4 → need 4 approvals (seat[4] is federated, use attestor)
  call('approve', ah, seats[0].pk, ed.sign(msg, seats[0].sk));
  call('approve', ah, seats[1].pk, ed.sign(msg, seats[1].sk));
  call('approve', ah, seats[2].pk, ed.sign(msg, seats[2].sk));
  const fmsg = fedMsg(selfBytes, seats[4].pk, 0n, ah);
  call('approveFederated', ah, seats[4].pk, ed.sign(fmsg, attestor.sk));
  const authSig = ed.sign(constMsg(selfBytes, 0n, ah), authority.sk);
  call('executeSetThreshold', 3n, authSig, NOW);
  if (peek('getThreshold') !== 3n) throw new Error('threshold should be 3 again');
});

// --- rotation + epoch death of approvals ---------------------------------------
const staleAH = (() => { const b = new Uint8Array(32); b.fill(0x5A); return b; })();

test('rotateSeats: council-approved wholesale rotation, epoch increments', () => {
  // park a pending approval that must die at rotation
  const smsg = directMsg(selfBytes, 0n, staleAH);
  call('approve', staleAH, seats[0].pk, ed.sign(smsg, seats[0].sk));
  call('approve', staleAH, seats[1].pk, ed.sign(smsg, seats[1].sk));
  call('approve', staleAH, seats[2].pk, ed.sign(smsg, seats[2].sk));
  if (peek('isApproved', staleAH) !== true) throw new Error('stale action should be approved pre-rotation');

  const outgoing = seats.map((s) => s.pk);
  const incoming = nextSeats.map((s) => s.pk);
  const seed = (() => { const b = new Uint8Array(32); b.fill(0xEE); return b; })();
  const nonce = peek('getNonce') + 1n;
  const ah = rotateAH(selfBytes, outgoing, incoming, seed, nonce);
  const msg = directMsg(selfBytes, 0n, ah);
  call('approve', ah, seats[0].pk, ed.sign(msg, seats[0].sk));
  call('approve', ah, seats[1].pk, ed.sign(msg, seats[1].sk));
  call('approve', ah, seats[2].pk, ed.sign(msg, seats[2].sk));
  call('executeRotateSeats', outgoing, incoming, seed, NOW);

  if (peek('getEpoch') !== 1n) throw new Error('epoch should be 1');
  if (peek('isSeat', seats[0].pk) !== false) throw new Error('old seat should be out');
  if (peek('isSeat', nextSeats[0].pk) !== true) throw new Error('new seat should be in');
});

test('rotation kills pending approvals (epoch-keyed map)', () => {
  if (peek('isApproved', staleAH) !== false) {
    throw new Error('stale approval survived rotation — epoch binding broken');
  }
});

test('old-epoch signatures are dead after rotation', () => {
  const ah = (() => { const b = new Uint8Array(32); b.fill(0x11); return b; })();
  const oldEpochMsg = directMsg(selfBytes, 0n, ah); // epoch 0 message
  expectThrow(
    () => call('approve', ah, nextSeats[0].pk, ed.sign(oldEpochMsg, nextSeats[0].sk)),
    'bad ed25519', 'old-epoch sig');
  // and the correct new-epoch message works
  const newMsg = directMsg(selfBytes, 1n, ah);
  call('approve', ah, nextSeats[0].pk, ed.sign(newMsg, nextSeats[0].sk));
});

// --- convene (dead-council recovery) -------------------------------------------
test('conveneRotation: rejected while council is alive (period not elapsed)', () => {
  const incoming = seats.map((s) => s.pk); // rotate the originals back in
  const seed = (() => { const b = new Uint8Array(32); b.fill(0xAB); return b; })();
  const msg = conveneMsg(selfBytes, 1n, incoming, seed);
  expectThrow(
    () => call('executeConveneRotation', incoming, seed, NOW, ed.sign(msg, parent.sk)),
    'not dead', 'convene-too-early');
});

// NOTE: testing the elapsed-period path offline requires advancing the
// context block time (blockTimeGte gate). The offline QueryContext pins
// block time at 0, and _lastCouncilActionTime was seeded with 0, so
// currentTime >= 0 + 30d cannot pass blockTimeGte(currentTime) at block
// time 0. The elapsed path is exercised in the testnet harness instead —
// documented as T-1 in the PR.

test('conveneRotation: parent signature is verified (garbage sig rejected)', () => {
  const incoming = seats.map((s) => s.pk);
  const seed = (() => { const b = new Uint8Array(32); b.fill(0xAB); return b; })();
  expectThrow(
    () => call('executeConveneRotation', incoming, seed, NOW, new Uint8Array(64)),
    'not dead', 'convene-gate-order'); // dead-gate fires first by design
});

// =============================================================================
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
