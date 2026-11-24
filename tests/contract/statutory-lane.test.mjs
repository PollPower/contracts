// Statutory lane end to end on the compiled contracts (Preprod class has one,
// Garrett 2026-11-24): a council-approved TariffRegistry registerLane, mirrored
// into EBT through an action-log proof, then a settle whose split is planned
// from the live mirrors pays the lane its slice (on-chain remit: minted to the
// lane's remit address).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExists } from '../parity/harness.mjs';
import { settleWorld, CLASS, T0, charterProof } from './settle-world.mjs';
import { signSettle, chipHwId, sessionFrom16 } from './hat-signer.mjs';
import { signOwnerAction } from './owner-signer.mjs';
import { planSettleArgs } from '../../tooling/settle/settle-plan.mjs';
import { registerLaneActionHash, findLane } from '../../tooling/tariff/lane.mjs';

const need = ['ebt-v8', 'tariff-registry-v1', 'multisig-v8'];
const skip = need.every(buildExists) ? false : `builds missing: ${need.join(', ')}`;
const b32 = (x) => new Uint8Array(32).fill(x);

// Class with a 300-bps statutory share: producer 5700 + margin 500 + ld 1000 + ops 2000 + dao 500 + 300 = 10000.
const SPLIT_L = { producerShareBps: 5700n, ldShareBps: 1000n, opsShareBps: 2000n, daoShareBps: 500n, operatorMarginBps: 500n, statutoryTotalBps: 300n };
const laneFor = (w, o = {}) => ({
  scheduleId: w.scheduleId, laneKindByte: 1n, leviedBy: b32(0x71), bpsShare: 300n, remitAddress: b32(0x72),
  basis: 0n, applicabilityHash: b32(0x73), statuteRefHash: b32(0x74), effectiveEpoch: 1n, remittanceMode: 1n, ...o,
});
const laneArgs = (l) => [l.scheduleId, l.laneKindByte, l.leviedBy, l.bpsShare, l.remitAddress, l.basis,
  l.applicabilityHash, l.statuteRefHash, l.effectiveEpoch, l.remittanceMode];

function bundle(w, amount, n) {
  const f = {
    sessionID: sessionFrom16(new Uint8Array(16).fill(0x50 + n)), amount, producerKey: b32(0x63),
    producerAddr: { bytes: b32(0x64) }, meterKeyHash: b32(0x65), chipHwId: chipHwId(w.keys.chip),
    chipSessionUwh: amount * 1000n + 1n, chipUptimeMs: 80_000n + BigInt(n), chipNonce: 9_000n + BigInt(n),
  };
  return { f, s: signSettle(w.ebtMod, w.ebt, f, { chip: w.keys.chip, hatSk: w.keys.hat.sk }) };
}
const plan = (w, f, s) => planSettleArgs({
  ebtModule: w.ebtMod, ledger: w.ebt.ledger(), fields: f, chip: s,
  scheduleId: w.scheduleId, classPath: CLASS, epoch: 1n, fiatValueAtMint: 2n, currentTime: T0,
});

async function registerAndMirror(w, lane) {
  await w.approve(registerLaneActionHash(w.tr.addressBytes, lane, w.tr.ledger()._currentEpoch, T0));
  await w.tr.call('registerLane', ...laneArgs(lane), charterProof, T0);
  w.syncTree();
  const seq = w.entries.length - 1;
  // EBT here predates the lane: advance its mirrored action-log root first (owner-signed).
  const rootArgs = [w.tree.root(), w.entries[seq]];
  await w.ebt.call('mirrorActionLogRoot', ...rootArgs, w.tree.proof(seq),
    signOwnerAction(w.ebtMod, w.ebt, 'mirrorActionLogRoot', rootArgs, { sk: w.keys.owner.sk }));
  const rec = findLane(w.tr.ledger(), lane.scheduleId, lane.leviedBy, lane.laneKindByte);
  await w.ebt.call('mirrorRegisterLane', w.entries[seq], rec, w.tree.proof(seq));
  return rec;
}

test('LN-1: council-approved lane registers, mirrors into EBT, and a planned settle pays its slice', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const lane = laneFor(w);
  const rec = await registerAndMirror(w, lane);
  assert.equal(rec.bpsShare, 300n);
  const { f, s } = bundle(w, 10_000n, 1);
  const args = plan(w, f, s);
  assert.deepEqual(args[19], [300n, 0n, 0n, 0n], 'lane slice 3% of 10000 in slot 0');
  const before = w.ebt.ledger()._totalSupply;
  await w.ebt.call('settle', ...args);
  assert.equal(w.ebt.ledger()._totalSupply - before, 10_000n);
});

test('LN-2 (negative): an approval over any other lane field does not register the lane', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const lane = laneFor(w);
  await w.approve(registerLaneActionHash(w.tr.addressBytes, { ...lane, bpsShare: 301n }, w.tr.ledger()._currentEpoch, T0));
  await assert.rejects(w.tr.call('registerLane', ...laneArgs(lane), charterProof, T0), /FEDERATION_APPROVAL_INVALID/);
  await w.approve(registerLaneActionHash(w.tr.addressBytes, { ...lane, remitAddress: b32(0x99) }, w.tr.ledger()._currentEpoch, T0));
  await assert.rejects(w.tr.call('registerLane', ...laneArgs(lane), charterProof, T0), /FEDERATION_APPROVAL_INVALID/);
});

test('LN-3 (negative): with the lane live, a settle that drops or shorts the lane is refused', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  await registerAndMirror(w, laneFor(w));
  const { f, s } = bundle(w, 10_000n, 2);
  const args = plan(w, f, s);
  const dropped = [...args];
  dropped[17] = [b32(0), b32(0), b32(0), b32(0)]; dropped[18] = [0n, 0n, 0n, 0n]; dropped[19] = [0n, 0n, 0n, 0n];
  dropped[24] = args[24] + 300n;   // the lane's slice handed to the producer
  await assert.rejects(w.ebt.call('settle', ...dropped), /LANE_SUM_MISMATCH/);
  const shorted = [...args];
  shorted[19] = [200n, 0n, 0n, 0n]; shorted[24] = args[24] + 100n;
  await assert.rejects(w.ebt.call('settle', ...shorted), /SLICE_OFF_POLICY|lane/i);
  await w.ebt.call('settle', ...args);   // the planned one still settles
});

test('LN-4 (negative): without the lane mirrored, the class statutory share blocks every settle', { skip }, async () => {
  const w = await settleWorld({ split: SPLIT_L });
  const { f, s } = bundle(w, 10_000n, 3);
  assert.throws(() => plan(w, f, s), /LANE_SUM_MISMATCH/);
});
