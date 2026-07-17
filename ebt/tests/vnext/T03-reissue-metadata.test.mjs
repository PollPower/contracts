// T03 — manualReissue preserves per-coin tariff-path metadata (v2 brief T3).
// The reissuance-log entry must carry the source coin's scheduleId/classPath/
// epoch/fiatValueAtMint verbatim (I-14-E) with the meter authority co-signature.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, nonZero32, bufEq } from '../lib.mjs';

test('T03 manualReissue carries source tariff-path metadata unchanged', () => {
  const sc = buildScenario();
  const sourceTariffPath = {
    scheduleId: sc.scheduleId, classPath: sc.classPath,
    epoch: 2n, fiatValueAtMint: 137n,
  };
  const producerAddr = nonZero32(0x71);

  sc.ebt.manualReissue({
    producerKey: sc.producerKey, producerAddr, amount: 500n,
    reasonCode: 3, evidenceHash: nonZero32(0x72),
    sourceTariffPath, currentTime: 2_000_000n, meterKey: sc.meterKey,
  });

  assert.equal(sc.ebt.reissuanceCount, 1n);
  const e = sc.ebt.reissuanceLog.get(0n);
  assert.equal(e.amount, 500n);
  assert.ok(bufEq(e.tpScheduleId, sc.scheduleId));
  assert.ok(bufEq(e.tpClassPath, sc.classPath));
  assert.equal(e.tpEpoch, 2n);
  assert.equal(e.tpFiatValueAtMint, 137n);
});
