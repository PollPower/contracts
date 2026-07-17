// T04 — HAT mint-redirection defence (v2 brief T4 / attack EBT-H-1, I-14-A).
// The HAT payload binds producerAddr. An observer who replays a valid HAT but
// swaps in their own producerAddr recomputes a different payload hash, so the
// meter-authority signature no longer verifies -> "Bad HAT signature".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts, nonZero32 } from '../lib.mjs';

test('T04 swapped producerAddr breaks HAT signature (mint-redirection blocked)', () => {
  const sc = buildScenario();
  const attacker = nonZero32(0x7e);

  // HAT was legitimately signed over the producer's real address, but the
  // submitted settle carries the attacker's address.
  const args = buildSettleArgs(sc, {
    producerAddr: attacker,
    signedProducerAddr: sc.producerAddr,
  });

  assertReverts(() => sc.ebt.settle(args), 'Bad HAT signature');
  assert.equal(sc.ebt.settlementCount, 0n);
  assert.equal(sc.ebt.mints.length, 0);

  // Sanity: with the address the HAT actually signed over, settle succeeds.
  const good = buildSettleArgs(sc);
  sc.ebt.settle(good);
  assert.equal(sc.ebt.settlementCount, 1n);
});
