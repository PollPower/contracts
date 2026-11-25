// T21 - the LANE_MIRROR_STALE head (fix #5). Replaces the caller-cited
// mirrorActionLogHead: after syncRegistryRoot the head is exactly the
// registry's latest entry (count - 1), never ahead of it and never chosen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeEbtFixture, doRegisterSchedule, doAdvanceEpoch } from '../lib.mjs';

test('T21 head = latest registry entry after each sync, monotone', () => {
  const { fx, ebt } = makeEbtFixture();
  const { refRate } = doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  ebt.syncRegistryRoot();
  const h1 = ebt._registryActionLogHeadSeqMirror;
  assert.equal(h1, BigInt(fx.registry._actionSeq) - 1n);
  doAdvanceEpoch(fx, 1_500_000n, refRate);
  doAdvanceEpoch(fx, 1_600_000n, refRate);
  ebt.syncRegistryRoot();
  assert.equal(ebt._registryActionLogHeadSeqMirror, BigInt(fx.registry._actionSeq) - 1n);
  assert.ok(ebt._registryActionLogHeadSeqMirror > h1);
});
