import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  Revert,
  makeUninitializedFixture,
  actionLogZeros,
  bufEq,
} from './lib.mjs';

function assertReverts(fn, expected) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof Revert, `expected Revert, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    if (expected) assert.match(e.message, new RegExp(expected), `expected /${expected}/, got: ${e.message}`);
    return;
  }
  assert.fail(`expected Revert (${expected ?? 'any'}), but no throw`);
}

test('T1 bootstrap-only path: constructor-marked + bootstrap-ready, empty-root parity, baseSeq=0', () => {
  const fx = makeUninitializedFixture();
  const { registry } = fx;
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, false);
  assert.equal(registry._actionLogBaseSeq, 0n);
  assert.equal(registry._actionSeq, 0n);

  registry.bootstrapActionLog(24n);

  const { emptyRoot } = actionLogZeros(24);
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, true);
  assert.ok(bufEq(registry.registryActionLogRoot, emptyRoot), 'bootstrap root must equal depth-24 empty root');
  assert.equal(registry._actionLogBaseSeq, 0n);
  assert.equal(registry._actionLogBootstrapCursor, 24n);
});

test('T2 pre-init gate: branch ops revert before bootstrap completes', () => {
  const fx = makeUninitializedFixture();
  const { registry, charterTree, charteredNodes, opKey } = fx;
  const proof = charterTree.proofsByNodeId.get(charteredNodes[0].toString('hex'));
  const zero32 = Buffer.alloc(32);

  const notReady = 'TariffRegistry: bootstrap incomplete';

  assertReverts(() => registry.registerSchedule({
    nodeId: charteredNodes[0],
    scheduleHash: randomBytes(32),
    operatorPubkey: opKey.pubkeyBytes,
    refRateFiatPerKwh: 100n,
    effectiveEpoch: 1n,
    validatorAttestor: randomBytes(32),
    validatorSignature: Buffer.alloc(64),
    currentTime: 1n,
    charterProof: proof,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.registerLane({
    scheduleId: randomBytes(32),
    laneKindByte: 1,
    leviedBy: randomBytes(32),
    bpsShare: 500,
    remitAddress: randomBytes(32),
    basis: 0,
    applicabilityHash: randomBytes(32),
    statuteRefHash: randomBytes(32),
    effectiveEpoch: 2n,
    remittanceMode: 0,
    charterProof: proof,
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.retuneClass({
    scheduleId: randomBytes(32),
    classPath: randomBytes(32),
    newSplitBps: {
      producerShareBps: 6500,
      ldShareBps: 500,
      opsShareBps: 2500,
      daoShareBps: 300,
      operatorMarginBps: 200,
      statutoryTotalBps: 0,
    },
    newRateFiatPerKwh: 100n,
    operatorId: opKey.pubkeyBytes,
    operatorSignature: Buffer.alloc(64),
    nonceIn: 1n,
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.retireLane({
    scheduleId: randomBytes(32),
    leviedBy: randomBytes(32),
    laneKindByte: 1,
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.retireSchedule({
    scheduleId: randomBytes(32),
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.setNationalContext({
    newLDFloorBps: 200,
    newOpsFloorBps: 2000,
    newSanityBandPct: 20,
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.advanceEpoch({
    newEpoch: 1n,
    newRefRateFiatPerKwh: 100n,
    newGovernanceRoot: zero32,
    currentTime: 1n,
    now: 1n,
  }), notReady);

  assertReverts(() => registry.setFederationAuthority({
    newAuthorityHash: randomBytes(32),
    currentTime: 1n,
    now: 1n,
  }), notReady);
});

test('T3 idempotency: bootstrap call after initialization reverts', () => {
  const fx = makeUninitializedFixture();
  const { registry } = fx;
  registry.bootstrapActionLog(24n);
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, true);
  assertReverts(() => registry.bootstrapActionLog(24n), 'already initialized');
});

test('T4 option-B shard progress: cursor monotonic and terminal init', () => {
  const fx = makeUninitializedFixture();
  const { registry } = fx;

  registry.bootstrapActionLog(12n);
  assert.equal(registry._actionLogBootstrapCursor, 12n);
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, false);

  registry.bootstrapActionLog(13n);
  assert.equal(registry._actionLogBootstrapCursor, 13n);
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, false);

  assertReverts(() => registry.bootstrapActionLog(12n), 'ACTION_LOG_BOOTSTRAP_NON_MONOTONIC');

  registry.bootstrapActionLog(24n);
  assert.equal(registry._actionLogBootstrapCursor, 24n);
  assert.equal(registry._initialized, true);
  assert.equal(registry._bootstrapComplete, true);
});

test('T5 root-shape byte parity: post-bootstrap root equals legacy empty-tree root', () => {
  const fx = makeUninitializedFixture();
  const { registry } = fx;
  registry.bootstrapActionLog(24n);
  const { emptyRoot } = actionLogZeros(24);
  assert.ok(bufEq(registry.registryActionLogRoot, emptyRoot));
});

