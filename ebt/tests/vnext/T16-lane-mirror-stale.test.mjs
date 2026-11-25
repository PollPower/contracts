// T16 — lane mirror staleness (v2 brief T16, I-14-B / design §3.3). When the
// registry has moved far beyond a lane's last mirrored write (e.g. a
// LANE_RETIRED event was committed on the registry but the lane slot was never
// re-mirrored), settle must revert LANE_MIRROR_STALE rather than route against
// a possibly-stale record.
//
// Fix #5: the head is no longer set by a caller; syncRegistryRoot copies the
// registry's entry count and the head is its latest entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts, doAdvanceEpoch } from '../lib.mjs';

test('T16 registry moved past the freshness window -> LANE_MIRROR_STALE', () => {
  const sc = buildScenario();
  for (let i = 0; i < 100; i++) doAdvanceEpoch(sc.fx, 1_600_000n + BigInt(i), sc.refRate);
  sc.ebt.syncRegistryRoot();
  assert.equal(sc.ebt._registryActionLogHeadSeqMirror, BigInt(sc.fx.registry._actionSeq) - 1n);
  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'LANE_MIRROR_STALE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
