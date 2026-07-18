// T05 — settle against an unregistered schedule reverts (v2 brief T5, I-14-B).
// The schedule-liveness mirror has no entry for a random scheduleId, so settle
// fails SCHEDULE_NOT_LIVE before any routing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { buildScenario, buildSettleArgs, assertReverts } from '../lib.mjs';

test('T05 unregistered schedule -> SCHEDULE_NOT_LIVE', () => {
  const sc = buildScenario();
  const args = buildSettleArgs(sc, { scheduleId: randomBytes(32) });
  assertReverts(() => sc.ebt.settle(args), 'SCHEDULE_NOT_LIVE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
