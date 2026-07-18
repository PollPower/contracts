// T09 — escrow solvency guard boundary (v2 brief T9, I-14-F). A KES redemption
// succeeds when the attested trust float exactly covers outstanding + KES
// obligation, and fails SOLVENCY_GUARD_FAILED one satoshi short.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScenario, buildSettleArgs, makeEscrowAttestation,
  REDEMPTION_KES, assertReverts, nonZero32,
} from '../lib.mjs';

function redeemKes(sc, tariffPath, att) {
  const attestationSig = makeEscrowAttestation(sc.escrowKey, att);
  sc.ebt.redeem({
    amount: 100n, redeemer: nonZero32(0x61), payoutRef: nonZero32(0x62),
    redemptionKind: REDEMPTION_KES, tariffPath, ...att, attestationSig,
    currentTime: 2_000_000n,
  });
}

test('T09 solvency guard: exact float passes, one short fails', () => {
  const base = { attestedOutstandingEbt: 0n, attestationEpoch: 2_000_000n };

  // Exactly covering -> passes.
  {
    const sc = buildScenario();
    sc.ebt.settle(buildSettleArgs(sc));
    const tariffPath = { scheduleId: sc.scheduleId, classPath: sc.classPath, epoch: 2n, fiatValueAtMint: 100n };
    redeemKes(sc, tariffPath, { ...base, attestedTrustFloat: 10000n });
    assert.equal(sc.ebt._redemptionCount, 1n);
  }

  // One satoshi short -> SOLVENCY_GUARD_FAILED.
  {
    const sc = buildScenario();
    sc.ebt.settle(buildSettleArgs(sc));
    const tariffPath = { scheduleId: sc.scheduleId, classPath: sc.classPath, epoch: 2n, fiatValueAtMint: 100n };
    assertReverts(
      () => redeemKes(sc, tariffPath, { ...base, attestedTrustFloat: 9999n }),
      'SOLVENCY_GUARD_FAILED',
    );
    assert.equal(sc.ebt._redemptionCount, 0n);
  }
});
