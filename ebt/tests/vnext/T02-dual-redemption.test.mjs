// T02 — per-coin dual redemption (v2 brief T2). A KES redemption runs the
// escrow solvency guard + attestation freshness and records fiatValueAtMint;
// its KWH sibling redeems the same tariff-path WITHOUT the solvency guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScenario, buildSettleArgs, makeEscrowAttestation,
  REDEMPTION_KES, REDEMPTION_KWH, nonZero32, bufEq,
} from '../lib.mjs';

test('T02 KES redemption runs solvency guard; KWH sibling does not', () => {
  const sc = buildScenario();
  const args = buildSettleArgs(sc);
  sc.ebt.settle(args);

  const tariffPath = {
    scheduleId: sc.scheduleId, classPath: sc.classPath,
    epoch: args.epoch, fiatValueAtMint: 100n,
  };
  const redeemer = nonZero32(0x61);

  // KES leg: obligation = 100 * 100 = 10000; float must cover outstanding+that.
  const att = {
    attestedTrustFloat: 10000n, attestedOutstandingEbt: 0n, attestationEpoch: 2_000_000n,
  };
  const attestationSig = makeEscrowAttestation(sc.escrowKey, att);
  sc.ebt.redeem({
    amount: 100n, redeemer, payoutRef: nonZero32(0x62), redemptionKind: REDEMPTION_KES,
    tariffPath, ...att, attestationSig, currentTime: 2_000_000n,
  });

  // KWH leg: same tariff-path, no escrow attestation needed.
  sc.ebt.redeem({
    amount: 50n, redeemer, payoutRef: nonZero32(0x63), redemptionKind: REDEMPTION_KWH,
    tariffPath, currentTime: 2_000_000n,
  });

  assert.equal(sc.ebt._redemptionCount, 2n);
  const kes = sc.ebt._redemptionLog.get(0n);
  assert.equal(kes.redemptionKind, REDEMPTION_KES);
  assert.equal(kes.tpFiatValueAtMint, 100n);
  assert.ok(bufEq(kes.tpScheduleId, sc.scheduleId));
  const kwh = sc.ebt._redemptionLog.get(1n);
  assert.equal(kwh.redemptionKind, REDEMPTION_KWH);
  assert.equal(kwh.tpFiatValueAtMint, 100n);
  assert.equal(sc.ebt._totalRedeemed, 150n);
});
