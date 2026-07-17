// T16 — lane mirror staleness (v2 brief T16, I-14-B / design §3.3). When the
// keeper advances the action-log head tracker far beyond a lane's last mirrored
// write (e.g. a LANE_RETIRED event was committed on the registry but the lane
// slot was never re-mirrored), settle must revert LANE_MIRROR_STALE rather than
// route against a possibly-stale record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts } from '../lib.mjs';

test('T16 head advanced past freshness window -> LANE_MIRROR_STALE', () => {
  const sc = buildScenario();
  // Keeper synced the head far ahead without re-mirroring the lane slots.
  const head = sc.ebt._registryActionLogHeadSeqMirror + 1000n;
  sc.ebt.mirrorActionLogHead({ newHeadSeq: head });

  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'LANE_MIRROR_STALE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
