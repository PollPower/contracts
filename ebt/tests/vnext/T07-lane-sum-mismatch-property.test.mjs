// T07 — LANE_SUM_MISMATCH property test (v2 brief T7, I-14-K). For random lane
// vectors whose bps sum differs from the mirrored class statutory total by a
// non-zero delta, settle MUST revert LANE_SUM_MISMATCH. The invariant is that
// enumerated statutory lanes reconstruct the class total exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

import { buildScenario, buildSettleArgs, assertReverts, nonZero32 } from '../lib.mjs';

const PROP_RUNS = 1000;   // v2 brief §REQUIRED TESTS: 1000 random split vectors.

test('T07 property: lane sum != class total always -> LANE_SUM_MISMATCH', () => {
  for (let run = 0; run < PROP_RUNS; run++) {
    // 1..3 lanes so a free request slot always remains: this isolates the
    // sum-reconstruction guard (I-14-K) from the 4-full-slots overflow guard
    // (I-14-I, exercised separately in T13).
    const nLanes = 1 + randomInt(3);
    const lanes = [];
    let laneSum = 0;
    for (let i = 0; i < nLanes; i++) {
      const bps = 50 + randomInt(400);         // keep totals well under floors
      laneSum += bps;
      lanes.push({
        laneKindByte: i, leviedBy: nonZero32(0x41 + i), bpsShare: bps,
        remittanceMode: 1, remitAddress: nonZero32(0x51 + i),
      });
    }
    // Class total differs from the actual lane sum by +/-1 (non-zero delta).
    const delta = randomInt(2) === 0 ? 1 : -1;
    const classTotal = laneSum + delta;

    const sc = buildScenario({ lanes, classStatutoryTotalBps: classTotal });
    const args = buildSettleArgs(sc);
    assertReverts(() => sc.ebt.settle(args), 'LANE_SUM_MISMATCH');
    assert.equal(sc.ebt.settlementCount, 0n);
  }
});
