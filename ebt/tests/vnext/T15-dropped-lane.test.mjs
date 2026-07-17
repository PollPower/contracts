// T15 — dropped statutory lane (v2 brief T15, I-14-K). Omitting a live statutory
// lane from the request vector leaves the enumerated sum short of the class
// total, so settle reverts LANE_SUM_MISMATCH (a keeper cannot silently skip a
// levy).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts } from '../lib.mjs';

const ZERO = Buffer.alloc(32);

test('T15 omitting a live lane -> LANE_SUM_MISMATCH', () => {
  const sc = buildScenario();     // 4 lanes x 250 bps = 1000 class total

  // Only three lanes requested; slot 3 is the empty-slot sentinel.
  const args = buildSettleArgs(sc, {
    leviedBys: [sc.lanes[0].leviedBy, sc.lanes[1].leviedBy, sc.lanes[2].leviedBy, ZERO],
    laneKindBytes: [sc.lanes[0].laneKindByte, sc.lanes[1].laneKindByte, sc.lanes[2].laneKindByte, 0],
    laneAmts: [250n, 250n, 250n, 0n],
  });

  assertReverts(() => sc.ebt.settle(args), 'LANE_SUM_MISMATCH');
  assert.equal(sc.ebt.settlementCount, 0n);
});
