// T21 - mirrorActionLogHead exact witness bound (review-pass-2 round-2 fix).
// The head must equal the proven event seq; no lookahead is allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeEbtFixture, doRegisterSchedule, doRetuneClass, doAdvanceEpoch,
  doRegisterLane, buildProof, statutorySplit, assertReverts, nonZero32,
} from '../lib.mjs';

function seedRegistryStage2() {
  const f = makeEbtFixture();
  const { fx, ebt } = f;
  const classPath = nonZero32(0x92);
  const { scheduleId, refRate } = doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  doRetuneClass(fx, {
    scheduleId, classPath, split: statutorySplit(300),
    rate: refRate, nonceIn: 1n, currentTime: 1_000_100n,
  });
  doAdvanceEpoch(fx, 1_500_000n, refRate);
  const lane1 = doRegisterLane(fx, {
    scheduleId, laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 300,
    effectiveEpoch: 2n, currentTime: 1_500_100n, remittanceMode: 1, remitAddress: nonZero32(0x51),
  });
  const lane2 = doRegisterLane(fx, {
    scheduleId, laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 300,
    effectiveEpoch: 2n, currentTime: 1_500_200n, remittanceMode: 1, remitAddress: nonZero32(0x52),
  });
  return { fx, ebt, lane1, lane2 };
}

function bootstrapRootMirror(fx, ebt, seq) {
  const proof = buildProof(fx.registry, seq);
  const entry = fx.registry.getActionEntry(BigInt(seq));
  ebt.mirrorActionLogRoot({
    newRoot: fx.registry.registryActionLogRoot,
    sampleEntry: entry,
    proof,
  });
}

test('T21 valid head advance requires exact seq equality', () => {
  const { fx, ebt, lane2 } = seedRegistryStage2();
  bootstrapRootMirror(fx, ebt, lane2.seq);
  const proof = buildProof(fx.registry, lane2.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane2.seq));

  ebt.mirrorActionLogHead({ newHeadSeq: BigInt(lane2.seq), latestEntry: entry, proof });
  assert.equal(ebt._registryActionLogHeadSeqMirror, BigInt(lane2.seq));
});

test('T21 newHeadSeq > proof.actionSeq reverts HEAD_ADVANCE_BEYOND_WITNESS', () => {
  const { fx, ebt, lane1 } = seedRegistryStage2();
  bootstrapRootMirror(fx, ebt, lane1.seq);
  const proof = buildProof(fx.registry, lane1.seq);
  const entry = fx.registry.getActionEntry(BigInt(lane1.seq));

  assertReverts(
    () => ebt.mirrorActionLogHead({
      newHeadSeq: BigInt(lane1.seq) + 1n,
      latestEntry: entry,
      proof,
    }),
    'HEAD_ADVANCE_BEYOND_WITNESS',
  );
});

test('T21 newHeadSeq below current head reverts not monotone', () => {
  const { fx, ebt, lane1, lane2 } = seedRegistryStage2();
  bootstrapRootMirror(fx, ebt, lane2.seq);
  const proof2 = buildProof(fx.registry, lane2.seq);
  const entry2 = fx.registry.getActionEntry(BigInt(lane2.seq));
  ebt.mirrorActionLogHead({ newHeadSeq: BigInt(lane2.seq), latestEntry: entry2, proof: proof2 });

  const proof1 = buildProof(fx.registry, lane1.seq);
  const entry1 = fx.registry.getActionEntry(BigInt(lane1.seq));
  assertReverts(
    () => ebt.mirrorActionLogHead({
      newHeadSeq: BigInt(lane1.seq),
      latestEntry: entry1,
      proof: proof1,
    }),
    'mirrorActionLogHead: not monotone',
  );
});
