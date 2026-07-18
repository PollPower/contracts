// T01 — end-to-end happy path (v2 brief §REQUIRED TESTS T1).
// Register schedule + lanes (mock registry events) -> mirror-write EBT circuits
// carry the state into the three mirrors -> attest -> settle -> mint splits
// across producer + ops/ld/dao (pending) + statutory lanes -> sum to input
// kWh x 10000 bps exactly -> LD bumpOnMint fires (via claimSplit, I-14-H).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, toHex, bufEq, nonZero32 } from '../lib.mjs';

test('T01 happy path: settle mints all splits, sums to kWh, LD bump fires', () => {
  const sc = buildScenario();
  const { ebt } = sc;
  const args = buildSettleArgs(sc);

  ebt.settle(args);

  // Session recorded, supply == amount, settle log carries the TariffPath.
  assert.equal(ebt._totalSupply, 10000n);
  assert.equal(ebt.settlementCount, 1n);
  const entry = ebt._settleLog.get(0n);
  assert.ok(bufEq(entry.scheduleId, sc.scheduleId));
  assert.equal(entry.fiatValueAtMint, 100n);
  assert.equal(entry.amount, 10000n);

  // Producer minted directly; each on-chain statutory lane minted to its addr.
  const producerMint = ebt.mints.find(m => bufEq(m.recipient, sc.producerAddr));
  assert.ok(producerMint, 'producer mint present');
  assert.equal(producerMint.amount, BigInt(args.operatorMarginBps));
  for (const l of sc.lanes) {
    const m = ebt.mints.find(x => bufEq(x.recipient, l.remitAddress));
    assert.ok(m, `lane ${l.laneKindByte} minted on-chain`);
    assert.equal(m.amount, BigInt(l.bpsShare));
  }

  // ops/ld/dao accrued to pending (minted later via claimSplit; LD binding).
  assert.equal(ebt._pendingOps, BigInt(args.opsBps));
  assert.equal(ebt._pendingDiv, BigInt(args.ldBps));
  assert.equal(ebt._pendingDao, BigInt(args.daoBps));

  // Sum of all slices == input kWh exactly (I-1 / I-14-C).
  const totalSliced = BigInt(args.producerAmt) + BigInt(args.opsAmt)
    + BigInt(args.divAmt) + BigInt(args.daoAmt)
    + args.laneAmts.reduce((a, x) => a + BigInt(x), 0n);
  assert.equal(totalSliced, 10000n);

  // LD bumpOnMint fires: bind LD, claimSplit(dividend) writes _dividendMintedLog.
  ebt.setLivingDividendAddress(nonZero32(0x99));
  assert.equal(ebt._dividendMintedLog.size, 0);
  ebt.claimSplit({ kind: 1, currentTime: 2_100_000n });
  assert.equal(ebt._dividendMintedLog.size, 1, 'LD bumpOnMint entry written');
  const ld = ebt._dividendMintedLog.get(0n);
  assert.equal(ld.amount, BigInt(args.ldBps));
});
