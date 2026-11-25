// planSettleArgs: builds EBT settle's full argument list from the LIVE mirrors
// (class split, live statutory lanes), so the submitter can never send a split
// the contract refuses (SPLIT_OFF_CLASS / LANE_SUM_MISMATCH / SLICE_OFF_POLICY)
// after meter-authority-service has already countersigned the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists } from '../parity/harness.mjs';
import { settleWorld, CLASS, T0, SPLIT } from './settle-world.mjs';
import { signSettle, chipHwId, sessionFrom16 } from './hat-signer.mjs';
import { planSettleArgs, slicesFor, liveLanes, classKeyOf, syncCheckAndPlan } from '../../tooling/settle/settle-plan.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;
const b32 = (x) => new Uint8Array(32).fill(x);

/** A countersigned bundle for `amount`, as pp-settle-service holds it before submit. */
function bundle(w, amount, n) {
  const f = {
    sessionID: sessionFrom16(new Uint8Array(16).fill(0x40 + n)), amount, producerKey: b32(0x63),
    producerAddr: { bytes: b32(0x64) }, meterKeyHash: b32(0x65), chipHwId: chipHwId(w.keys.chip),
    chipSessionUwh: amount * 1000n + 999n, chipUptimeMs: 90_000n + BigInt(n), chipNonce: 7_000n + BigInt(n),
  };
  const s = signSettle(w.ebtMod, w.ebt, f, { chip: w.keys.chip, hatSk: w.keys.hat.sk });
  return { f, s };
}

test('SP-1: planned args settle on the real EBT; slices sum exactly to the amount', { skip }, async () => {
  const w = await settleWorld();
  for (const [n, amount] of [[1, 10_000n], [2, 7n], [3, 1_234_567n]]) {
    const { f, s } = bundle(w, amount, n);
    const before = w.ebt.ledger()._totalSupply;
    const args = planSettleArgs({
      ebtModule: w.ebtMod, ledger: w.ebt.ledger(), fields: f, chip: s,
      scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
    });
    await w.ebt.call('settle', ...args);
    assert.equal(w.ebt.ledger()._totalSupply - before, amount, `amount ${amount}`);
  }
});

test('SP-2: the class split is read from the mirror; a retuned class is followed', { skip }, async () => {
  const w = await settleWorld();
  const split = w.ebt.ledger()._classSplitMirror.lookup(classKeyOf(w.scheduleId, CLASS));
  assert.equal(split.ldShareBps, 1000n);
  assert.equal(split.opsShareBps, 2000n);
});

test('SP-3 (negative): a class that is not mirrored is refused before submit', { skip }, async () => {
  const w = await settleWorld();
  const { f, s } = bundle(w, 100n, 9);
  assert.throws(() => planSettleArgs({
    ebtModule: w.ebtMod, ledger: w.ebt.ledger(), fields: f, chip: s,
    scheduleId: w.scheduleId, classPath: b32(0xc9), epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
  }), /CLASS_NOT_LIVE/);
});

test('SP-4: slices are within one unit of their bps and sum exactly (largest remainder)', () => {
  for (const amount of [1n, 7n, 99n, 10_000n, 1_234_567n]) {
    const bps = [4643n, 2000n, 1572n, 0n, 1785n];
    const s = slicesFor(amount, bps);
    assert.equal(s.reduce((a, x) => a + x, 0n), amount);
    s.forEach((amt, i) => {
      const cross = amt * 10000n, target = amount * bps[i];
      assert.ok(cross + 10000n > target && cross < target + 10000n, `slice ${i} of ${amount}`);
    });
  }
});

test('SP-5: lanes - only live lanes of this schedule; their bps must equal the class statutory total', () => {
  const sid = b32(0x5a);
  const lane = (o) => ({ record: { scheduleId: sid, laneKindByte: 3n, leviedBy: b32(0x11), bpsShare: 1785n, effectiveEpoch: 1n, retiredEpoch: 0n, remittanceMode: 0n, remitAddress: b32(0), ...o }, writeActionSeq: 5n });
  const mirror = new Map([
    ['a', lane({})],
    ['b', lane({ scheduleId: b32(0x5b) })],               // other schedule
    ['c', lane({ leviedBy: b32(0x12), retiredEpoch: 1n })], // retired at epoch 1
    ['d', lane({ leviedBy: b32(0x13), effectiveEpoch: 9n })], // not yet effective
  ]);
  const ledger = { _registeredLanesMirror: { [Symbol.iterator]: () => mirror.entries() } };
  const live = liveLanes(ledger, sid, 1n);
  assert.equal(live.length, 1);
  assert.equal(live[0].bpsShare, 1785n);
  const five = new Map(Array.from({ length: 5 }, (_, i) => [String(i), lane({ leviedBy: b32(0x20 + i), bpsShare: 1n })]));
  assert.throws(() => liveLanes({ _registeredLanesMirror: { [Symbol.iterator]: () => five.entries() } }, sid, 1n), /more than 4 live lanes/);
});

// Fix #5: with the registry's ledger given, the planner refuses while the
// registry is ahead of EBT's synced root (a retune or lane not yet mirrored
// would otherwise settle at the old split); after sync + re-mirror it plans.
test('SP-5 (negative): registry ahead of EBT\'s synced root -> refused until sync + re-mirror', { skip }, async () => {
  const w = await settleWorld();
  const NEW = { producerShareBps: 5900n, ldShareBps: 1100n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 0n };
  const t = T0 + 7200n;
  await w.retune(NEW, 100n, 2n, t);
  w.syncTree();
  const { f, s } = bundle(w, 10_000n, 9);
  const p = () => planSettleArgs({
    ebtModule: w.ebtMod, ledger: w.ebt.ledger(), registryLedger: w.tr.ledger(), fields: f, chip: s,
    scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
  });
  assert.throws(p, /REGISTRY_AHEAD_OF_MIRROR/);
  await w.sync();
  assert.throws(p, /CLASS_MIRROR_BEHIND/, 'synced but not re-mirrored');
  await w.mirrorClass(w.entries.length - 1, NEW, 100n, t);
  const args = p();
  assert.equal(args[22], 1100n, 'Living Dividend bps from the retuned class');
  await w.ebt.call('settle', ...args);
});

test('SP-6 (negative): a lane registered and synced but not mirrored -> LANE_MIRROR_BEHIND', { skip }, async () => {
  const { registerLaneActionHash } = await import('../../tooling/tariff/lane.mjs');
  const { charterProof } = await import('./settle-world.mjs');
  const w = await settleWorld();
  const lane = { scheduleId: w.scheduleId, laneKindByte: 1n, leviedBy: b32(0x71), bpsShare: 300n, remitAddress: b32(0x72),
    basis: 0n, applicabilityHash: b32(0x73), statuteRefHash: b32(0x74), effectiveEpoch: 1n, remittanceMode: 1n };
  await w.approve(registerLaneActionHash(w.tr.addressBytes, lane, w.tr.ledger()._currentEpoch, T0));
  await w.tr.call('registerLane', lane.scheduleId, lane.laneKindByte, lane.leviedBy, lane.bpsShare, lane.remitAddress, lane.basis,
    lane.applicabilityHash, lane.statuteRefHash, lane.effectiveEpoch, lane.remittanceMode, charterProof, T0);
  await w.sync();
  const { f, s } = bundle(w, 10_000n, 10);
  assert.throws(() => planSettleArgs({
    ebtModule: w.ebtMod, ledger: w.ebt.ledger(), registryLedger: w.tr.ledger(), fields: f, chip: s,
    scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
  }), /LANE_MIRROR_BEHIND/);
});

// The Preprod settle path (chain adapter -> syncCheckAndPlan) runs the mirror
// check by default: sync EBT with the registry when it is behind, re-read both,
// then refuse on REGISTRY_AHEAD_OF_MIRROR / CLASS_MIRROR_BEHIND / LANE_MIRROR_BEHIND.
const gate = (w, f, s, sync) => {
  const calls = { sync: 0 };
  const run = () => syncCheckAndPlan({
    readEbt: async () => w.ebt.ledger(), readRegistry: async () => w.tr.ledger(),
    sync: async () => { calls.sync++; await sync(); }, log: { log() {} },
    plan: { ebtModule: w.ebtMod, fields: f, chip: s, scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0 },
  });
  return { run, calls };
};

test('SP-7: in step with the registry -> no sync, plans and settles', { skip }, async () => {
  const w = await settleWorld();
  const { f, s } = bundle(w, 10_000n, 11);
  const g = gate(w, f, s, () => w.sync());
  const args = await g.run();
  assert.equal(g.calls.sync, 0);
  await w.ebt.call('settle', ...args);
});

test('SP-8 (negative): a retune -> the gate syncs, then refuses CLASS_MIRROR_BEHIND until re-mirrored', { skip }, async () => {
  const w = await settleWorld();
  const NEW = { producerShareBps: 5900n, ldShareBps: 1100n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 0n };
  const t = T0 + 7200n;
  await w.retune(NEW, 100n, 2n, t);
  w.syncTree();
  const { f, s } = bundle(w, 10_000n, 12);
  const g = gate(w, f, s, () => w.sync());
  await assert.rejects(g.run(), /CLASS_MIRROR_BEHIND/);
  assert.equal(g.calls.sync, 1, 'synced once');
  assert.equal(w.ebt.ledger()._registryActionLogCountMirror, w.tr.ledger()._actionSeq);
  await w.mirrorClass(w.entries.length - 1, NEW, 100n, t);
  const args = await g.run();
  assert.equal(g.calls.sync, 1, 'no second sync once in step');
  assert.equal(args[22], 1100n);
  await w.ebt.call('settle', ...args);
});

test('SP-9 (negative): a new lane -> the gate syncs, then refuses LANE_MIRROR_BEHIND', { skip }, async () => {
  const { registerLaneActionHash } = await import('../../tooling/tariff/lane.mjs');
  const { charterProof } = await import('./settle-world.mjs');
  const w = await settleWorld();
  const lane = { scheduleId: w.scheduleId, laneKindByte: 1n, leviedBy: b32(0x71), bpsShare: 300n, remitAddress: b32(0x72),
    basis: 0n, applicabilityHash: b32(0x73), statuteRefHash: b32(0x74), effectiveEpoch: 1n, remittanceMode: 1n };
  await w.approve(registerLaneActionHash(w.tr.addressBytes, lane, w.tr.ledger()._currentEpoch, T0));
  await w.tr.call('registerLane', lane.scheduleId, lane.laneKindByte, lane.leviedBy, lane.bpsShare, lane.remitAddress, lane.basis,
    lane.applicabilityHash, lane.statuteRefHash, lane.effectiveEpoch, lane.remittanceMode, charterProof, T0);
  const { f, s } = bundle(w, 10_000n, 13);
  const g = gate(w, f, s, () => w.sync());
  await assert.rejects(g.run(), /LANE_MIRROR_BEHIND/);
  assert.equal(g.calls.sync, 1);
});

test('SP-10 (negative): a sync that does not catch up -> REGISTRY_AHEAD_OF_MIRROR, nothing planned', { skip }, async () => {
  const w = await settleWorld();
  await w.retune({ producerShareBps: 5900n, ldShareBps: 1100n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 0n }, 100n, 2n, T0 + 7200n);
  const { f, s } = bundle(w, 10_000n, 14);
  const g = gate(w, f, s, async () => {});
  await assert.rejects(g.run(), /REGISTRY_AHEAD_OF_MIRROR/);
  assert.equal(g.calls.sync, 1);
});

test('SP-11 (negative): the chain adapter refuses to open without the registry (the check is not optional)', async () => {
  const { createEbtSettleChain } = await import('../../tooling/settle/ebt-settle-chain.mjs');
  await assert.rejects(createEbtSettleChain(/** @type {any} */ ({ providers: {}, ebtBuildDir: 'x', ebtAddress: 'ab' })), /REGISTRY_GATE_REQUIRED/);
  await assert.rejects(createEbtSettleChain(/** @type {any} */ ({ providers: {}, ebtBuildDir: 'x', ebtAddress: 'ab', registryAddress: 'cd' })), /REGISTRY_GATE_REQUIRED/);
});

test('SP-12: a registry entry that changes nothing EBT mirrors (same-split retune) -> the gate syncs, re-checks and settles (the devnet pass flow)', { skip }, async () => {
  const w = await settleWorld();
  await w.retune(SPLIT, 100n, 2n, T0 + 7200n);
  const { f, s } = bundle(w, 10_000n, 15);
  const g = gate(w, f, s, () => w.sync());
  const args = await g.run();
  assert.equal(g.calls.sync, 1);
  assert.equal(w.ebt.ledger()._registryActionLogCountMirror, w.tr.ledger()._actionSeq);
  await w.ebt.call('settle', ...args);
});
