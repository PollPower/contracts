// T08 — on-chain remit address guard (v2 brief T8, I-14-D). A lane with
// remittanceMode == 1 (on-chain) and a zero remit address must revert
// LANE_REMIT_ADDR_ZERO_ON_CHAIN, while a fiat-door lane (mode 0) with a zero
// remit address is legitimate and must NOT trip the guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts, nonZero32, bufEq } from '../lib.mjs';

const ZERO = Buffer.alloc(32);

test('T08 on-chain lane with zero remit addr -> LANE_REMIT_ADDR_ZERO_ON_CHAIN', () => {
  const sc = buildScenario({
    lanes: [
      { laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 500, remittanceMode: 1, remitAddress: ZERO },
      { laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 500, remittanceMode: 1, remitAddress: nonZero32(0x52) },
    ],
  });
  const args = buildSettleArgs(sc);
  assertReverts(() => sc.ebt.settle(args), 'LANE_REMIT_ADDR_ZERO_ON_CHAIN');
  assert.equal(sc.ebt.settlementCount, 0n);
});

test('T08 fiat-door lane (mode 0) with zero remit addr settles fine', () => {
  const sc = buildScenario({
    lanes: [
      { laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 500, remittanceMode: 0, remitAddress: ZERO },
      { laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 500, remittanceMode: 1, remitAddress: nonZero32(0x52) },
    ],
  });
  const args = buildSettleArgs(sc);
  sc.ebt.settle(args);
  assert.equal(sc.ebt.settlementCount, 1n);
  // The fiat-door lane is enumerated (counted in the statutory sum) but never
  // minted on-chain; only the on-chain lane routes.
  assert.ok(!sc.ebt.mints.some(m => bufEq(m.recipient, ZERO)), 'no mint to zero addr');
  assert.ok(sc.ebt.mints.some(m => bufEq(m.recipient, nonZero32(0x52))), 'on-chain lane minted');
});
