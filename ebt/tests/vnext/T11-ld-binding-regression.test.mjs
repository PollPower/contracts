// T11 — Living-Dividend binding regression (v2 brief T11, I-14-H). v8 settle
// still accrues the dividend slice to pending (it does NOT mint LD inline), and
// claimSplit(dividend) preserves v7.4.2 semantics byte-for-byte: it mints to the
// dividend recipient and, when an LD address is bound, writes a bumpOnMint entry
// with a deterministic per-seq salt, epoch color, and monotone sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, nonZero32, bufEq } from '../lib.mjs';

test('T11 claimSplit mints dividend + writes bumpOnMint log when LD bound', () => {
  const sc = buildScenario();
  const ld = nonZero32(0x99);
  sc.ebt.setLivingDividendAddress(ld);

  // First coin: settle accrues to pending (no LD mint inline).
  const a1 = buildSettleArgs(sc);
  sc.ebt.settle(a1);
  assert.equal(sc.ebt._pendingDiv, BigInt(a1.ldBps));
  assert.equal(sc.ebt._dividendMintedLog.size, 0);

  sc.ebt.claimSplit({ kind: 1, currentTime: 2_100_000n });
  assert.equal(sc.ebt._pendingDiv, 0n);
  assert.equal(sc.ebt._dividendMintedLog.size, 1);
  const e0 = sc.ebt._dividendMintedLog.get(0n);
  assert.equal(e0.amount, BigInt(a1.ldBps));
  assert.ok(bufEq(e0.recipient, ld));
  assert.equal(e0.blockTime, 2_100_000n);

  // Second coin -> second monotone bumpOnMint entry.
  const a2 = buildSettleArgs(sc);
  sc.ebt.settle(a2);
  sc.ebt.claimSplit({ kind: 1, currentTime: 2_200_000n });
  assert.equal(sc.ebt._dividendMintedLog.size, 2);
  const e1 = sc.ebt._dividendMintedLog.get(1n);
  assert.equal(e1.amount, BigInt(a2.ldBps));
  assert.ok(!bufEq(e0.sourceTxSalt, e1.sourceTxSalt), 'per-seq salt distinct');
  assert.ok(bufEq(e0.epochColor, e1.epochColor), 'stable epoch color');
});

test('T11 unbound LD: claimSplit mints but writes no bumpOnMint entry', () => {
  const sc = buildScenario();
  sc.ebt.settle(buildSettleArgs(sc));
  sc.ebt.claimSplit({ kind: 1, currentTime: 2_100_000n });
  assert.equal(sc.ebt._dividendMintedLog.size, 0);
  assert.equal(sc.ebt._dividendEventSeq, 0n);
});
