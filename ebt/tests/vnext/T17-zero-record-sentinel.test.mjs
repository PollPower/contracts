// T17 — zero-record sentinel discrimination (v2 brief T17, I-14-J). An empty
// request slot (zero leviedBy -> zero-record on lookup) is skipped, but a real
// lane must never be mistaken for the sentinel: a populated mode-0 / zero-remit
// lane is still enumerated in the statutory sum.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, nonZero32, bufEq } from '../lib.mjs';

const ZERO = Buffer.alloc(32);

test('T17 two real lanes + two empty slots settle and route to two dests', () => {
  const sc = buildScenario({
    lanes: [
      { laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 500, remittanceMode: 1, remitAddress: nonZero32(0x51) },
      { laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 500, remittanceMode: 1, remitAddress: nonZero32(0x52) },
    ],
  });
  const args = buildSettleArgs(sc, {
    leviedBys: [sc.lanes[0].leviedBy, sc.lanes[1].leviedBy, ZERO, ZERO],
    laneKindBytes: [0, 1, 0, 0],
    laneAmts: [500n, 500n, 0n, 0n],
  });
  sc.ebt.settle(args);
  assert.equal(sc.ebt.settlementCount, 1n);
  assert.ok(sc.ebt.mints.some(m => bufEq(m.recipient, nonZero32(0x51))));
  assert.ok(sc.ebt.mints.some(m => bufEq(m.recipient, nonZero32(0x52))));
});

test('T17 populated mode-0 zero-remit lane is enumerated, not a sentinel', () => {
  // If the mode-0/zero-remit lane were mistaken for the empty-slot sentinel its
  // 500 bps would drop out and the sum check would fail; a clean settle proves
  // it was enumerated.
  const sc = buildScenario({
    lanes: [
      { laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 500, remittanceMode: 0, remitAddress: ZERO },
      { laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 500, remittanceMode: 1, remitAddress: nonZero32(0x52) },
    ],
  });
  sc.ebt.settle(buildSettleArgs(sc));
  assert.equal(sc.ebt.settlementCount, 1n);
});
