// TR retire at epoch 0 (Low, found 2026-11-24; fix before Preprod).
// retiredEpoch = 0 means "live" for every reader (TR, EBT mirror, lane
// checks), so retiring at epoch 0 recorded a retirement that nobody saw. Fix:
// retirement is refused until the first epoch advance (RETIRE_AT_EPOCH_ZERO),
// for schedules and lanes. The encoding is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists, runtimePersistentHash, padTag, b32 } from '../parity/harness.mjs';
import { settleWorld, T0 } from './settle-world.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;
const le32 = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 0; x > 0n; i++, x >>= 8n) b[i] = Number(x & 0xffn); return b; };
const retireHash = (w, epoch) => runtimePersistentHash([padTag('pp:tariff:v1:retireSchedule'), w.tr.addressBytes, w.scheduleId, le32(epoch)]);
async function advance(w) {
  const h = runtimePersistentHash([padTag('pp:tariff:v1:advanceEpoch'), w.tr.addressBytes, le32(0), le32(1), le32(100), w.tr.ledger()._governanceRoot]);
  await w.approve(h);
  await w.tr.call('advanceEpoch', 1n, 100n, w.tr.ledger()._governanceRoot, T0);
}

test('TR-E0-1 (negative): a schedule cannot be retired at epoch 0, even with council approval', { skip }, async () => {
  const w = await settleWorld();
  await w.approve(retireHash(w, 0));
  await assert.rejects(w.tr.call('retireSchedule', w.scheduleId, T0), /RETIRE_AT_EPOCH_ZERO/);
  assert.equal(w.tr.ledger()._registeredSchedules.lookup(w.scheduleId).retiredEpoch, 0n);
});

test('TR-E0-2: after the first epoch advance the schedule retires and reads as retired', { skip }, async () => {
  const w = await settleWorld();
  await advance(w);
  await w.approve(retireHash(w, 1));
  await w.tr.call('retireSchedule', w.scheduleId, T0);
  assert.equal(w.tr.ledger()._registeredSchedules.lookup(w.scheduleId).retiredEpoch, 1n);
});

test('TR-E0-3 (negative): lanes cannot be retired at epoch 0 either', { skip }, async () => {
  const w = await settleWorld();
  await assert.rejects(w.tr.call('retireLane', w.scheduleId, b32(0x77), 1n, T0), /RETIRE_AT_EPOCH_ZERO/);
  await advance(w);
  await assert.rejects(w.tr.call('retireLane', w.scheduleId, b32(0x77), 1n, T0), /LANE_NOT_FOUND/, 'guard passes after the advance');
});
