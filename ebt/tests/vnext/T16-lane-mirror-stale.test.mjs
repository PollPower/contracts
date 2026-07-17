// T16 — lane mirror staleness (v2 brief T16, I-14-B / design §3.3). When the
// keeper advances the action-log head tracker far beyond a lane's last mirrored
// write (e.g. a LANE_RETIRED event was committed on the registry but the lane
// slot was never re-mirrored), settle must revert LANE_MIRROR_STALE rather than
// route against a possibly-stale record.
//
// Review-pass-1 fix: mirrorActionLogHead is now witness-gated. The keeper must
// cite a real event proven under the currently-mirrored root; the proof's
// actionSeq bounds how far the head can advance in a single call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScenario, buildSettleArgs, assertReverts, buildProof,
} from '../lib.mjs';

test('T16 head advanced past freshness window -> LANE_MIRROR_STALE', () => {
  const sc = buildScenario();
  // Keeper synced the head far ahead without re-mirroring the lane slots.
  // Under the witness-gated setter, cite the highest-seq real event as the
  // head witness; its actionSeq <= the new head so the assert passes, but the
  // lanes were written earlier and their writeActionSeq now falls outside
  // the CAL_MIRROR_STALE_TOLERANCE window relative to the new head.
  const head = sc.ebt._registryActionLogHeadSeqMirror + 1000n;
  const latestEv = sc.fx.events[sc.fx.events.length - 1];
  const proof = buildProof(sc.fx.registry, latestEv.seq);
  const entry = sc.fx.registry.getActionEntry(BigInt(latestEv.seq));
  sc.ebt.mirrorActionLogHead({ newHeadSeq: head, latestEntry: entry, proof });

  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'LANE_MIRROR_STALE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
