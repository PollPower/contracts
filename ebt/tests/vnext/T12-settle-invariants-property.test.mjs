// T12 — settle invariant property test (v2 brief T12). For random valid
// schedules x split vectors x tariff-paths, every SUCCESSFUL settle must
// satisfy: I-14-C (all slices sum to the input kWh), I-14-K (statutory lanes
// reconstruct the class total), and I-14-H (LD binding still fires downstream).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';

import { buildScenario, buildSettleArgs, nonZero32, bufEq } from '../lib.mjs';

const PROP_RUNS = 1000;

test('T12 property: valid settles satisfy I-14-C / I-14-K / I-14-H', () => {
  for (let run = 0; run < PROP_RUNS; run++) {
    const nLanes = 1 + randomInt(4);
    const lanes = [];
    let laneSum = 0;
    for (let i = 0; i < nLanes; i++) {
      const bps = 50 + randomInt(400);
      laneSum += bps;
      const mode = randomInt(2);             // mix fiat-door + on-chain lanes
      lanes.push({
        laneKindByte: i, leviedBy: nonZero32(0x41 + i), bpsShare: bps,
        remittanceMode: mode,
        remitAddress: mode === 1 ? nonZero32(0x51 + i) : Buffer.alloc(32),
      });
    }

    const sc = buildScenario({ lanes });       // class total == laneSum (I-14-K)
    const amount = 10000n;
    const args = buildSettleArgs(sc, { amount });
    sc.ebt.settle(args);

    // I-14-C: every slice sums to the input kWh.
    const sliced = BigInt(args.producerAmt) + BigInt(args.opsAmt)
      + BigInt(args.divAmt) + BigInt(args.daoAmt)
      + args.laneAmts.reduce((a, x) => a + BigInt(x), 0n);
    assert.equal(sliced, amount, `run ${run} I-14-C`);
    assert.equal(sc.ebt._totalSupply, amount);

    // I-14-K: enumerated statutory lanes == class total.
    assert.equal(BigInt(laneSum), BigInt(sc.classStatutoryTotalBps), `run ${run} I-14-K`);

    // I-14-H: dividend accrues to pending; claimSplit binds LD.
    assert.equal(sc.ebt._pendingDiv, BigInt(args.ldBps));
    const ld = nonZero32(0x99);
    sc.ebt.setLivingDividendAddress(ld);
    sc.ebt.claimSplit({ kind: 1, currentTime: 2_100_000n });
    assert.equal(sc.ebt._dividendMintedLog.size, 1, `run ${run} I-14-H`);
    assert.ok(bufEq(sc.ebt._dividendMintedLog.get(0n).recipient, ld));
  }
});
