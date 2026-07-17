// T10 — de-federation gating (v2 brief T10, I-14-G). settle works while the
// producer is attested, reverts OPERATOR_DEFEDERATED after revocation, and
// works again once re-attested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScenario, buildSettleArgs, assertReverts } from '../lib.mjs';

test('T10 revoke blocks settle; re-attest restores it', () => {
  const sc = buildScenario();

  sc.ebt.settle(buildSettleArgs(sc));
  assert.equal(sc.ebt.settlementCount, 1n);

  sc.ebt.revoke({ producerKey: sc.producerKey, meterKeyHash: sc.meterKeyHash, currentTime: 1_900_000n });
  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'OPERATOR_DEFEDERATED');
  assert.equal(sc.ebt.settlementCount, 1n);

  sc.ebt.attest({ producerKey: sc.producerKey, meterKeyHash: sc.meterKeyHash, currentTime: 1_950_000n });
  sc.ebt.settle(buildSettleArgs(sc));
  assert.equal(sc.ebt.settlementCount, 2n);
});
