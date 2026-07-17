// T06 — settle against a retired schedule reverts (v2 brief T6, I-14-B).
// After the registry retires the schedule and the keeper mirrors the kind-3
// lifecycle event, the schedule-liveness mirror flips to false.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, doRetireSchedule, warmMirror, assertReverts } from '../lib.mjs';

test('T06 retired schedule -> SCHEDULE_NOT_LIVE', () => {
  const sc = buildScenario();
  // Retire the schedule on the registry, then re-warm the mirror.
  doRetireSchedule(sc.fx, { scheduleId: sc.scheduleId, currentTime: 1_600_000n });
  warmMirror(sc.ebt, sc.fx);

  const args = buildSettleArgs(sc);
  assertReverts(() => sc.ebt.settle(args), 'SCHEDULE_NOT_LIVE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
