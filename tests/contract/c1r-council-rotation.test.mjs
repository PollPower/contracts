// Council rotation on Multisig v8 (Preprod gate; design: WI16-auth-fix-design.md
// "Council rotation"). Rotation is in place (same address), council-approved
// (current threshold), delayed 72 h, and bumps the council generation
// (`_epoch`), which invalidates every approval of the old generation.
//
// Interface under test:
//   pure rotationHash(self, epoch, seq, newPks: Vector<7, Secp256k1Point>, adminCount, threshold) -> Bytes<32>
//   pure cancelRotationHash(self, epoch, rotationHash) -> Bytes<32>
//   scheduleRotation(newPks, adminCount, threshold, currentTime)   anyone; needs isApproved(rotationHash)
//   executeRotation(newPks, adminCount, threshold)                  anyone; after readyAt
//   cancelRotation()                                                anyone; needs isApproved(cancelRotationHash)
//   ledger: _rotationPending, _pendingRotationHash, _rotationReadyAt, _rotationSeq
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists, loadContract, deploy, b32 } from '../parity/harness.mjs';
import { newCouncilKey, approvalDigest, signDigest } from './council-signer.mjs';

const NAME = 'multisig-v8';
const skip = buildExists(NAME) ? false : `build/l9/${NAME} missing: run \`npm run build:contracts\``;
const DELAY = 72n * 3600n;
const T0 = 1_800_000_000n;
const ACTION = b32(0xab);

async function setup() {
  const mod = await loadContract(NAME);
  const council = Array.from({ length: 7 }, newCouncilKey);
  const c = await deploy(mod, {}, [council.map((k) => k.point), 3n, 2n]);
  c.setTime(T0);
  const P = mod.pureCircuits;
  const L = () => c.ledger();
  /** keys[i] signs `action` for slot `slot` under the CURRENT generation (or `epoch`). */
  const approveAs = (key, slot, action, epoch = L()._epoch) =>
    c.call('approve', action, BigInt(slot), signDigest(approvalDigest(mod, c.addressBytes, action, epoch), key.sk));
  const filler = council.slice(3).map((k) => k.point);
  /** A proposed council: `keys` in slots 0.., count, threshold. */
  const proposal = (keys, n = keys.length, t = 2) => {
    const pks = [...keys.map((k) => k.point), ...council.map((k) => k.point)].slice(0, 7);
    return { pks, n: BigInt(n), t: BigInt(t), keys };
  };
  const hashOf = (p) => P.rotationHash(c.addressBytes, L()._epoch, L()._rotationSeq, p.pks, p.n, p.t);
  const schedule = (p, time = T0) => c.call('scheduleRotation', p.pks, p.n, p.t, time);
  const execute = (p) => c.call('executeRotation', p.pks, p.n, p.t);
  return { mod, c, P, L, council, approveAs, proposal, hashOf, schedule, execute, filler };
}

/** The standby replaces slot 2 (the design's standby procedure). */
async function standbyRotation(s) {
  const standby = newCouncilKey();
  const p = s.proposal([s.council[0], s.council[1], standby]);
  return { standby, p, h: s.hashOf(p) };
}

test('R-1: 2-of-3 approve, schedule, wait 72 h, execute: new council in place, generation 1', { skip }, async () => {
  const s = await setup();
  const { standby, p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[1], 1, h);
  await s.schedule(p, T0);
  assert.equal(s.L()._rotationPending, true);
  assert.equal(s.L()._rotationReadyAt, T0 + DELAY);
  s.c.setTime(T0 + DELAY);
  await s.execute(p);
  const L = s.L();
  assert.equal(L._epoch, 1n);
  assert.equal(L._rotationPending, false);
  assert.equal(L._adminCount, 3n);
  assert.equal(L._threshold, 2n);
  assert.deepEqual(L._adminPks.lookup(2n), standby.point);
  // The standby approves in generation 1; the removed member cannot.
  await s.approveAs(standby, 2, ACTION);
  await assert.rejects(s.approveAs(s.council[2], 2, b32(0xac)), /bad council signature/);
  await s.approveAs(s.council[0], 0, ACTION);
  assert.equal(await s.c.call('isApproved', ACTION), true);
});

test('R-2 (negative): rotation without 2-of-3 is refused (one approval; a removed or outside key; a forged slot)', { skip }, async () => {
  const s = await setup();
  const { p, h } = await standbyRotation(s);
  await assert.rejects(s.schedule(p), /ROTATION_NOT_APPROVED/, 'no approvals');
  await s.approveAs(s.council[0], 0, h);
  await assert.rejects(s.schedule(p), /ROTATION_NOT_APPROVED/, 'one of three');
  const outsider = newCouncilKey();
  await assert.rejects(s.approveAs(outsider, 1, h), /bad council signature/);
  await assert.rejects(s.approveAs(s.council[0], 1, h), /bad council signature/, 'one key cannot fill two slots');
  // Approvals for a DIFFERENT council do not carry over to this one.
  const other = s.proposal([s.council[0], s.council[1], newCouncilKey()]);
  await s.approveAs(s.council[1], 1, s.hashOf(other));
  await assert.rejects(s.schedule(p), /ROTATION_NOT_APPROVED/);
  assert.equal(s.L()._rotationPending, false);
  assert.equal(s.L()._epoch, 0n);
});

test('R-3 (negative): executing before the 72 h delay is refused; nothing changes', { skip }, async () => {
  const s = await setup();
  const { p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[2], 2, h);
  await s.schedule(p, T0);
  await assert.rejects(s.execute(p), /ROTATION_NOT_READY/, 'immediately');
  s.c.setTime(T0 + DELAY - 1n);
  await assert.rejects(s.execute(p), /ROTATION_NOT_READY/, 'one second early');
  assert.equal(s.L()._epoch, 0n);
  assert.deepEqual(s.L()._adminPks.lookup(2n), s.council[2].point);
});

test('R-4 (negative): an approval cannot be replayed across generations', { skip }, async () => {
  const s = await setup();
  // Generation 0: slot 0 approves ACTION (1 of 2), and slot 2 (about to be removed) signs it too.
  const sig0 = signDigest(approvalDigest(s.mod, s.c.addressBytes, ACTION, 0n), s.council[0].sk);
  await s.c.call('approve', ACTION, 0n, sig0);
  const sig2 = signDigest(approvalDigest(s.mod, s.c.addressBytes, ACTION, 0n), s.council[2].sk);
  const { standby, p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[1], 1, h);
  await s.schedule(p, T0);
  s.c.setTime(T0 + DELAY);
  await s.execute(p);
  // Generation 1: the old approval does not count, and its signatures do not verify.
  assert.equal(await s.c.call('getApprovalCount', ACTION), 0n);
  await assert.rejects(s.c.call('approve', ACTION, 0n, sig0), /bad council signature/, 'slot 0 replays its gen-0 signature');
  await assert.rejects(s.c.call('approve', ACTION, 2n, sig2), /bad council signature/, 'removed member replays a gen-0 signature');
  // The gen-0 rotation approvals cannot schedule anything again.
  await assert.rejects(s.schedule(p, T0 + DELAY), /ROTATION_NOT_APPROVED/);
  // Fresh gen-1 approvals work.
  await s.approveAs(s.council[0], 0, ACTION);
  await s.approveAs(standby, 2, ACTION);
  assert.equal(await s.c.call('isApproved', ACTION), true);
});

test('R-5 (negative): executing a council other than the scheduled one is refused', { skip }, async () => {
  const s = await setup();
  const { p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[1], 1, h);
  await s.schedule(p, T0);
  s.c.setTime(T0 + DELAY);
  const swapped = s.proposal([s.council[0], newCouncilKey(), s.council[2]]);
  await assert.rejects(s.execute(swapped), /ROTATION_MISMATCH/);
  await assert.rejects(s.execute({ ...p, t: 3n }), /ROTATION_MISMATCH/, 'same keys, other threshold');
  await s.execute(p);
});

test('R-6 (negative): the schedule time must be current (not future, not stale), so the delay cannot be shortened', { skip }, async () => {
  const s = await setup();
  const { p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[1], 1, h);
  await assert.rejects(s.schedule(p, T0 + 60n), /timestamp cannot be in the future/);
  await assert.rejects(s.schedule(p, T0 - 3601n), /ROTATION_TIME_STALE/);
  await s.schedule(p, T0 - 3600n);   // within the window
  assert.equal(s.L()._rotationReadyAt, T0 - 3600n + DELAY);
});

test('R-7 (negative): the new council keeps the H-3 bounds, a majority threshold and distinct keys', { skip }, async () => {
  const s = await setup();
  const k = [s.council[0], s.council[1], newCouncilKey(), newCouncilKey()];
  const bad = [
    [s.proposal(k.slice(0, 3), 0, 1), /admin count/],
    [s.proposal(k.slice(0, 3), 8, 5), /admin count/],
    [s.proposal(k.slice(0, 3), 3, 0), /Threshold must be > 0/],
    [s.proposal(k.slice(0, 3), 3, 4), /Threshold must be <= admin count/],
    [s.proposal(k, 4, 2), /majority/],
    [s.proposal([k[0], k[1], k[0]]), /duplicate council key/],
  ];
  for (const [p, re] of bad) {
    const h = s.hashOf(p);
    await s.approveAs(s.council[0], 0, h);
    await s.approveAs(s.council[1], 1, h);
    await assert.rejects(s.schedule(p), re);
  }
});

test('R-8: a council-approved cancel stops a pending rotation; it cannot then execute or be re-scheduled', { skip }, async () => {
  const s = await setup();
  const { p, h } = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, h);
  await s.approveAs(s.council[1], 1, h);
  await s.schedule(p, T0);
  await assert.rejects(s.c.call('cancelRotation'), /CANCEL_NOT_APPROVED/);
  const ch = s.P.cancelRotationHash(s.c.addressBytes, 0n, h);
  await s.approveAs(s.council[0], 0, ch);
  await assert.rejects(s.c.call('cancelRotation'), /CANCEL_NOT_APPROVED/, 'one of three');
  await s.approveAs(s.council[2], 2, ch);
  await s.c.call('cancelRotation');
  assert.equal(s.L()._rotationPending, false);
  s.c.setTime(T0 + DELAY);
  await assert.rejects(s.execute(p), /NO_PENDING_ROTATION/);
  await assert.rejects(s.schedule(p, T0 + DELAY), /ROTATION_NOT_APPROVED/, 'the old approvals belong to the old proposal number');
  assert.equal(s.L()._epoch, 0n);
});

test('R-9 (negative): one pending rotation at a time', { skip }, async () => {
  const s = await setup();
  const a = await standbyRotation(s);
  await s.approveAs(s.council[0], 0, a.h);
  await s.approveAs(s.council[1], 1, a.h);
  await s.schedule(a.p, T0);
  const b = s.proposal([s.council[0], newCouncilKey(), s.council[2]]);
  const hb = s.hashOf(b);
  await s.approveAs(s.council[0], 0, hb);
  await s.approveAs(s.council[2], 2, hb);
  await assert.rejects(s.schedule(b, T0), /ROTATION_PENDING/);
});

test('R-10: rotationHash binds the address, generation, proposal number, keys, count and threshold (signer parity)', { skip }, async () => {
  const s = await setup();
  const { p } = await standbyRotation(s);
  const base = s.P.rotationHash(s.c.addressBytes, 0n, 0n, p.pks, 3n, 2n);
  assert.equal(base.length, 32);
  assert.notDeepEqual(base, s.P.rotationHash(b32(0x77), 0n, 0n, p.pks, 3n, 2n));
  assert.notDeepEqual(base, s.P.rotationHash(s.c.addressBytes, 1n, 0n, p.pks, 3n, 2n));
  assert.notDeepEqual(base, s.P.rotationHash(s.c.addressBytes, 0n, 1n, p.pks, 3n, 2n));
  assert.notDeepEqual(base, s.P.rotationHash(s.c.addressBytes, 0n, 0n, p.pks, 3n, 3n));
  const other = [...p.pks]; other[1] = newCouncilKey().point;
  assert.notDeepEqual(base, s.P.rotationHash(s.c.addressBytes, 0n, 0n, other, 3n, 2n));
  // Slots beyond the count do not matter (filler is canonicalised).
  const filler = [...p.pks]; filler[5] = newCouncilKey().point;
  assert.deepEqual(base, s.P.rotationHash(s.c.addressBytes, 0n, 0n, filler, 3n, 2n));
});
