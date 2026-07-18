// T13 — statutory lane overflow (v2 brief T13, I-14-I). A schedule carrying five
// statutory lanes cannot be settled through the 4-wide request vector: the four
// enumerated lanes leave statutory bps stranded, so settle reverts
// SCHEDULE_LANE_OVERFLOW. After a retire-and-replace brings the live count back
// to four (and the class total is re-tuned to match), settle succeeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScenario, buildSettleArgs, doRetireLane, doRetuneClass,
  warmMirror, statutorySplit, assertReverts, nonZero32,
} from '../lib.mjs';

test('T13 five lanes overflow the 4-wide vector, then recover', () => {
  const lanes = [0, 1, 2, 3, 4].map(i => ({
    laneKindByte: i, leviedBy: nonZero32(0x41 + i), bpsShare: 200,
    remittanceMode: 1, remitAddress: nonZero32(0x51 + i),
  }));
  const sc = buildScenario({ lanes });   // class total = 1000, 5 lanes live

  // Request the first four lanes: sum 800 < class total 1000 with all four slots
  // full -> overflow.
  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'SCHEDULE_LANE_OVERFLOW');

  // Retire the 5th lane and re-tune the class total down to the 4-lane sum.
  doRetireLane(sc.fx, {
    scheduleId: sc.scheduleId, leviedBy: lanes[4].leviedBy,
    laneKindByte: lanes[4].laneKindByte, currentTime: 2_050_000n,
  });
  doRetuneClass(sc.fx, {
    scheduleId: sc.scheduleId, classPath: sc.classPath,
    split: statutorySplit(800), rate: sc.refRate, nonceIn: 1n, currentTime: 2_100_000n,
  });
  warmMirror(sc.ebt, sc.fx);

  const recover = buildSettleArgs(sc, {
    leviedBys: lanes.slice(0, 4).map(l => l.leviedBy),
    laneKindBytes: lanes.slice(0, 4).map(l => l.laneKindByte),
    laneAmts: [200n, 200n, 200n, 200n],
    operatorMarginBps: 6200,
  });
  sc.ebt.settle(recover);
  assert.equal(sc.ebt.settlementCount, 1n);
});
