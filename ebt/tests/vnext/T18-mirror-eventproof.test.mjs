// T18 — mirror-write EventProof integration (v2 brief T18, design §7). An
// EventProof witness produced by the WI-13.2 off-chain generator (payloadHash
// leaf + Merkle siblings against registryActionLogRoot) must verify inside the
// EBT mirror-write circuits, and any tampering (bad sibling or wrong record)
// must revert EVENT_PROOF_INVALID.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEbtFixture, doRegisterSchedule, doRetuneClass, doAdvanceEpoch, doRegisterLane,
  buildProof, statutorySplit, assertReverts, nonZero32, toHex, laneKey,
} from '../lib.mjs';

function seedRegistry() {
  const f = makeEbtFixture();
  const { fx, ebt } = f;
  const classPath = nonZero32(0x81);
  const { scheduleId, refRate } = doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  doRetuneClass(fx, { scheduleId, classPath, split: statutorySplit(300), rate: refRate, nonceIn: 1n, currentTime: 1_000_100n });
  doAdvanceEpoch(fx, 1_500_000n, refRate);
  const lane = doRegisterLane(fx, {
    scheduleId, laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 300,
    effectiveEpoch: 2n, currentTime: 1_500_100n, remittanceMode: 1, remitAddress: nonZero32(0x51),
  });
  // Witness-gated trust anchor: cite the lane event as the sample witness.
  const sampleProof = buildProof(fx.registry, lane.seq);
  const sampleEntry = fx.registry.getActionEntry(BigInt(lane.seq));
  ebt.mirrorActionLogRoot({
    newRoot: fx.registry.registryActionLogRoot,
    sampleEntry, proof: sampleProof,
  });
  return { fx, ebt, scheduleId, classPath, lane };
}

test('T18 valid WI-13.2 EventProof verifies in mirrorRegisterLane', () => {
  const { fx, ebt, scheduleId, lane } = seedRegistry();
  const proof = buildProof(fx.registry, lane.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane.seq));

  ebt.mirrorRegisterLane({ entry, laneRecord: lane.record, proof });

  const k = laneKey(scheduleId, lane.record.leviedBy, lane.record.laneKindByte);
  assert.ok(ebt._registeredLanesMirror.has(toHex(k)), 'lane mirrored');
  assert.equal(ebt._registeredLanesMirror.get(toHex(k)).writeActionSeq, BigInt(lane.seq));
});

test('T18 tampered Merkle sibling -> EVENT_PROOF_INVALID', () => {
  const { fx, ebt, lane } = seedRegistry();
  const proof = buildProof(fx.registry, lane.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane.seq));

  const bad = { ...proof, siblings: proof.siblings.map(s => Buffer.from(s)) };
  bad.siblings[0][0] ^= 0xff;   // corrupt one sibling

  assertReverts(() => ebt.mirrorRegisterLane({ entry, laneRecord: lane.record, proof: bad }), 'EVENT_PROOF_INVALID');
});

test('T18 record not matching committed payloadHash -> EVENT_PROOF_INVALID', () => {
  const { fx, ebt, lane } = seedRegistry();
  const proof = buildProof(fx.registry, lane.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane.seq));

  const forged = { ...lane.record, bpsShare: lane.record.bpsShare + 1 };
  assertReverts(() => ebt.mirrorRegisterLane({ entry, laneRecord: forged, proof }), 'EVENT_PROOF_INVALID');
});
