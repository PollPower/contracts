// T14 — duplicate lane key rejection (v2 brief T14, I-14-J). A request vector
// that names the same (leviedBy, laneKindByte) twice must revert LANE_DUP_KEY
// before any statutory sum is computed (prevents double-counting a lane).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts } from '../lib.mjs';

test('T14 duplicated lane key -> LANE_DUP_KEY', () => {
  const sc = buildScenario();     // 4 distinct lanes
  const l0 = sc.lanes[0];

  // Slots 0 and 1 both resolve to lane 0's key.
  const args = buildSettleArgs(sc, {
    leviedBys: [l0.leviedBy, l0.leviedBy, sc.lanes[2].leviedBy, sc.lanes[3].leviedBy],
    laneKindBytes: [l0.laneKindByte, l0.laneKindByte, sc.lanes[2].laneKindByte, sc.lanes[3].laneKindByte],
  });

  assertReverts(() => sc.ebt.settle(args), 'LANE_DUP_KEY');
  assert.equal(sc.ebt.settlementCount, 0n);
});
