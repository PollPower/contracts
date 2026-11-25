// T19 - the mirrored registry root (fix #5, registry-root anchor). Replaces the
// owner-gated mirrorActionLogRoot trust model: no caller supplies a root;
// syncRegistryRoot copies the registry's own root and entry count, and a
// registry that regresses or rewrites its root is refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEbtFixture, doRegisterSchedule, assertReverts, bufEq } from '../lib.mjs';

test('T19 the root mirror is empty until the first sync, then equals the registry root', () => {
  const { fx, ebt } = makeEbtFixture();
  doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  assert.ok(bufEq(ebt._registryActionLogRootMirror, Buffer.alloc(32)));
  ebt.syncRegistryRoot();
  assert.ok(bufEq(ebt._registryActionLogRootMirror, fx.registry.registryActionLogRoot));
  assert.equal(ebt._registryActionLogCountMirror, BigInt(fx.registry._actionSeq));
});

test('T19 no root setter exists on the model', () => {
  const { ebt } = makeEbtFixture();
  assert.equal(ebt.mirrorActionLogRoot, undefined);
  assert.equal(ebt.mirrorActionLogHead, undefined);
});

test('T19 (negative) a registry whose count goes back, or whose root changes at the same count, is refused', () => {
  const { fx, ebt } = makeEbtFixture();
  doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  ebt.syncRegistryRoot();
  const real = { root: Buffer.from(fx.registry.registryActionLogRoot), seq: fx.registry._actionSeq };
  fx.registry._actionSeq = real.seq - 1n;
  assertReverts(() => ebt.syncRegistryRoot(), 'REGISTRY_ROOT_REGRESSED');
  fx.registry._actionSeq = real.seq;
  fx.registry.registryActionLogRoot = Buffer.alloc(32, 0x99);
  assertReverts(() => ebt.syncRegistryRoot(), 'REGISTRY_ROOT_REGRESSED');
});

test('T19 (negative) before the registry bootstrap completes, the sync fails', () => {
  const { fx, ebt } = makeEbtFixture();
  fx.registry._bootstrapComplete = false;
  assertReverts(() => ebt.syncRegistryRoot(), 'ACTION_LOG_NOT_BOOTSTRAPPED');
});
