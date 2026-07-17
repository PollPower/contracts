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
  buildScenario, buildSettleArgs, assertReverts, buildProof, doAdvanceEpoch,
} from '../lib.mjs';

test('T16 head advanced past freshness window -> LANE_MIRROR_STALE', () => {
  const sc = buildScenario();
  // Keeper synced the root/head far ahead using real post-lane events, but did
  // not re-mirror lane slots. With exact-head semantics, witness.actionSeq must
  // equal newHeadSeq.
  for (let i = 0; i < 100; i++) doAdvanceEpoch(sc.fx, 1_600_000n + BigInt(i), sc.refRate);
  const latestEv = sc.fx.events[sc.fx.events.length - 1];
  const proof = buildProof(sc.fx.registry, latestEv.seq);
  const entry = sc.fx.registry.getActionEntry(BigInt(latestEv.seq));
  sc.ebt.mirrorActionLogRoot({
    newRoot: sc.fx.registry.registryActionLogRoot,
    sampleEntry: entry,
    proof,
  });
  sc.ebt.mirrorActionLogHead({ newHeadSeq: BigInt(latestEv.seq), latestEntry: entry, proof });

  assertReverts(() => sc.ebt.settle(buildSettleArgs(sc)), 'LANE_MIRROR_STALE');
  assert.equal(sc.ebt.settlementCount, 0n);
});
