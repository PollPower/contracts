// WI16-C-1a: Multisig v8. Council approvals are secp256k1 signatures verified
// in-circuit (stdlib secp256k1EcdsaVerify), not a prover-supplied witness.
//
// The PoC (2026-11-23) showed Multisig v6.2 reaching 3-of-5 with forged
// signatures because `approve` only asserted the `signature_valid` witness.
// PoC-1 replays that attack against v6.2 to prove the test detects it; the
// v8 tests then show every variant of it fails.
//
// Interface under test:
//   constructor(adminPks: Vector<7, Secp256k1Point>, adminCount: Uint<8>, threshold: Uint<8>)
//   pure approvalDigest(self: Bytes<32>, actionHash: Bytes<32>, epoch: Uint<64>) -> Bytes<32>
//   approve(actionHash, adminIndex: Uint<8>, sig: Secp256k1EcdsaSignature)
//   isApproved(actionHash) -> Boolean, getApprovalCount(actionHash) -> Uint<64>
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, buildExists, loadContract, deploy, b32 } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest, forgedSignature } from './council-signer.mjs';

const NAME = 'multisig-v8';
const skip = buildExists(NAME) ? false : `build/l9/${NAME} missing: run \`npm run build:contracts\``;
const ACTION = b32(0xab);

// 3 council keys at 2-of-3 (the devnet layout); slots 3..6 are filler.
async function setup({ count = 3, threshold = 2, keys } = {}) {
  const mod = await loadContract(NAME);
  const council = keys ?? Array.from({ length: 7 }, newCouncilKey);
  const c = await deploy(mod, {}, [council.map((k) => k.point), BigInt(count), BigInt(threshold)]);
  const sign = (i, action = ACTION, opts = {}) =>
    signDigest(approvalDigest(mod, opts.self ?? c.addressBytes, action, opts.epoch ?? 0n), (opts.key ?? council[i]).sk, opts);
  const approve = (i, sig, action = ACTION) => c.call('approve', action, BigInt(i), sig);
  const count_ = async (action = ACTION) => c.call('getApprovalCount', action);
  const approved = async (action = ACTION) => c.call('isApproved', action);
  return { mod, c, council, sign, approve, count: count_, approved };
}

// ------------------------------------------------------------ PoC regression
test('PoC-1 (control): Multisig v6.2 reaches threshold with forged signatures', async () => {
  const mod = await loadContract('multisig-v6.2');
  const admins = [1, 2, 3, 4, 5].map((i) => b32(0xc0 + i));
  const lying = { signature_valid: (ctx) => [ctx.privateState, true] };
  const c = await deploy(mod, lying, [...admins, 3n]);
  for (const pk of admins.slice(0, 3)) await c.call('approve', ACTION, pk, new Uint8Array(64));
  assert.equal(await c.call('isApproved', ACTION), true, 'the old contract is expected to be vulnerable');
});

test('C1-0: Multisig v8 has no witnesses at all', { skip }, async () => {
  const info = JSON.parse(fs.readFileSync(path.join(BUILD, NAME, 'compiler', 'contract-info.json'), 'utf8'));
  assert.ok(Array.isArray(info.witnesses), 'compiler metadata must list witnesses');
  assert.deepEqual(info.witnesses, []);
  assert.ok(info.circuits.some((x) => x.name === 'approvalDigest' && x.pure), 'approvalDigest must be an exported pure circuit');
});

test('C1-1 (negative, PoC): forged signatures never reach the threshold', { skip }, async () => {
  const { approve, approved, count } = await setup();
  for (const i of [0, 1, 2]) await assert.rejects(approve(i, forgedSignature()), /bad council signature/);
  assert.equal(await count(), 0n);
  assert.equal(await approved(), false);
});

test('C1-2 (negative): a real signature by a key outside the council is rejected', { skip }, async () => {
  const { approve, sign } = await setup();
  const outsider = newCouncilKey();
  await assert.rejects(approve(0, sign(0, ACTION, { key: outsider })), /bad council signature/);
});

test('C1-3 (negative): an admin cannot use another slot', { skip }, async () => {
  const { approve, sign } = await setup();
  await assert.rejects(approve(1, sign(0)), /bad council signature/); // admin 0 signs, claims slot 1
});

test('C1-4 (negative): a signature for another action is rejected', { skip }, async () => {
  const { approve, sign } = await setup();
  await assert.rejects(approve(0, sign(0, b32(0xcd)), ACTION), /bad council signature/);
});

test('C1-5 (negative): a signature bound to another multisig address is rejected', { skip }, async () => {
  const { approve, sign } = await setup();
  await assert.rejects(approve(0, sign(0, ACTION, { self: b32(0x77) })), /bad council signature/);
});

test('C1-6 (negative): a signature for another council epoch is rejected', { skip }, async () => {
  const { approve, sign } = await setup();
  await assert.rejects(approve(0, sign(0, ACTION, { epoch: 1n })), /bad council signature/);
});

test('C1-7 (negative): one admin counts once, even with the high-S twin signature', { skip }, async () => {
  const { approve, sign, count, approved } = await setup();
  await approve(0, sign(0));
  await assert.rejects(approve(0, sign(0)), /already approved/);
  await assert.rejects(approve(0, sign(0, ACTION, { highS: true })), /already approved/);
  assert.equal(await count(), 1n);
  assert.equal(await approved(), false);
});

test('C1-8 (negative): slots beyond the council size cannot approve', { skip }, async () => {
  const { approve, sign } = await setup();
  await assert.rejects(approve(3, sign(3)), /not a council slot/); // slot 3 holds a filler key
});

test('C1-9: two distinct admins reach 2-of-3; high-S signatures are accepted', { skip }, async () => {
  const { approve, sign, count, approved } = await setup();
  await approve(0, sign(0));
  assert.equal(await approved(), false);
  await approve(2, sign(2, ACTION, { highS: true }));
  assert.equal(await count(), 2n);
  assert.equal(await approved(), true);
  assert.equal(await approved(b32(0xcd)), false, 'approval is per action');
});

test('C1-10: the off-chain digest is the circuit digest (signer parity)', { skip }, async () => {
  const { mod, c } = await setup();
  const d = approvalDigest(mod, c.addressBytes, ACTION, 0n);
  assert.equal(d.length, 32);
  assert.notDeepEqual(d, approvalDigest(mod, c.addressBytes, ACTION, 1n));
  assert.notDeepEqual(d, approvalDigest(mod, b32(0x77), ACTION, 0n));
});

// ------------------------------------------------------------ constructor (H-1 + H-3)
test('C1-11: the constructor installs the council, count and threshold', { skip }, async () => {
  const { c, council } = await setup();
  const L = c.ledger();
  assert.equal(L._adminCount, 3n);
  assert.equal(L._threshold, 2n);
  assert.equal(L._epoch, 0n);
  for (const i of [0, 1, 2]) assert.deepEqual(L._adminPks.lookup(BigInt(i)), council[i].point);
  assert.equal(L._adminPks.member(3n), false, 'filler slots are not stored');
});

test('C1-12 (negative): constructor bounds (H-3) and duplicate keys', { skip }, async () => {
  const keys = Array.from({ length: 7 }, newCouncilKey);
  const bad = [
    [{ count: 0, threshold: 1 }, /admin count/],
    [{ count: 8, threshold: 5 }, /admin count/],
    [{ count: 3, threshold: 0 }, /Threshold must be > 0/],
    [{ count: 3, threshold: 4 }, /Threshold must be <= admin count/],
    [{ count: 4, threshold: 2 }, /majority/],
    [{ count: 3, threshold: 2, keys: [keys[0], keys[1], keys[0], ...keys.slice(3)] }, /duplicate council key/],
  ];
  for (const [opts, re] of bad) await assert.rejects(setup({ keys, ...opts }), re, JSON.stringify(opts, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 60));
  // The full cap is allowed.
  const { c } = await setup({ keys, count: 7, threshold: 4 });
  assert.equal(c.ledger()._adminCount, 7n);
});
