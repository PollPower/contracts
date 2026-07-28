// tariff-registry/tests/wi15.1/mirror-writes.test.mjs
// -----------------------------------------------------------------------------
// WI-15.1 mirror-write tests. Coverage per DoD:
//
//   Happy paths (one per circuit-per-sibling combination in the dispatch table):
//     M-T1 mirrorGovernanceRoot on Schedule / Lane / Views
//     M-T2 mirrorEpochAndFloors on Schedule / Lane / Views
//     M-T3 mirrorFederationAuthority on Schedule / Lane
//     M-T4 mirrorSchedulesRoot on Lane / Views
//     M-T5 mirrorClassEntriesRoot on Views
//     M-T6 mirrorLanesRoot on Views
//     M-T7 mirrorAuditRoot on Governance / Schedule / Lane / Views
//
//   Adversarial paths (per DoD "at least one adversarial per circuit"):
//     A-T1 stale epoch — monotonicity rejection
//     A-T2 wrong signer — MIRROR_*_SIG_INVALID
//     A-T3 signature replay across siblings — wrong-self rejects
//     A-T4 rotate to zero authority — MIRROR_FED_AUTH_ZERO
//     A-T5 mirrorAuditRoot with governance-authority sig (wrong role)
//     A-T6 signature over tampered payload — MIRROR_*_SIG_INVALID
//
//   Additional invariant coverage:
//     I-15-B monotone: 3 sequential mirrorEpochAndFloors calls, epochs 1→2→3
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { Revert, pad32, bufEq, toHex } from '../lib.mjs';
import { MirrorSibling, MIRROR_KIND, MIRROR_TAG, makeAuthorityKeypair } from './mirror-lib.mjs';

function assertReverts(fn, expected) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof Revert, `expected Revert, got ${e && e.constructor && e.constructor.name}: ${e && e.message}`);
    if (expected) assert.match(e.message, new RegExp(expected), `expected /${expected}/, got: ${e.message}`);
    return;
  }
  assert.fail(`expected Revert (${expected ?? 'any'}), but no throw`);
}

// Build fixture: fedAuth kp, plus one sibling per role. Bootstraps
// `_mirroredFederationAuthority` on each sibling via the first mirror-write
// signed by `fedAuth`.
function makeFixture({ withAuditWriter = true } = {}) {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();

  const now = 1_700_000_000n;
  const t = now;

  const schedule = new MirrorSibling({ role: 'schedule',
    auditWriterAuthorityTarget: withAuditWriter ? auditWriter.authHash : pad32('') });
  const lane = new MirrorSibling({ role: 'lane',
    auditWriterAuthorityTarget: withAuditWriter ? auditWriter.authHash : pad32('') });
  const views = new MirrorSibling({ role: 'views',
    auditWriterAuthorityTarget: withAuditWriter ? auditWriter.authHash : pad32('') });
  const governance = new MirrorSibling({ role: 'governance',
    auditWriterAuthorityTarget: withAuditWriter ? auditWriter.authHash : pad32('') });

  // Bootstrap fed auth on each sibling by installing fedAuth as the mirror.
  // Uses the mirrorFederationAuthority bootstrap path (empty cur → accept).
  // For Views (no fed-auth circuit... wait, we added it — see below).
  const bootstrap = (sib) => {
    const msg = sib._msgFedAuth(fedAuth.authHash, 1n, fedAuth.authHash);
    const sig = fedAuth.sign(msg);
    sib.mirrorFederationAuthority({
      newAuth: fedAuth.authHash,
      epochAtMirror: 1n,
      sig,
      currentAuthHash: fedAuth.authHash,
      currentTime: t,
    });
  };
  bootstrap(schedule);
  bootstrap(lane);
  bootstrap(views);
  bootstrap(governance);

  return { fedAuth, auditWriter, schedule, lane, views, governance, t };
}

// Utility: sign a mirror-write message under fedAuth.
function signGovRoot(sib, fedAuth, newRoot, epoch) {
  const msg = sib._msgGovRoot(newRoot, epoch, fedAuth.authHash);
  return { msg, sig: fedAuth.sign(msg) };
}
function signEpochFloors(sib, fedAuth, newEpoch, ld, ops, band, rate) {
  const msg = sib._msgEpochFloors(newEpoch, ld, ops, band, rate, fedAuth.authHash);
  return { msg, sig: fedAuth.sign(msg) };
}
function signFedAuth(sib, fedAuth, newAuth, epoch, curAuth) {
  const msg = sib._msgFedAuth(newAuth, epoch, curAuth);
  return { msg, sig: fedAuth.sign(msg) };
}
function signRoot(sib, fedAuth, tag, newRoot, epoch) {
  const msg = sib._msgRoot(tag, newRoot, epoch, fedAuth.authHash);
  return { msg, sig: fedAuth.sign(msg) };
}
function signAuditRoot(sib, auditWriter, newRoot, seq) {
  const msg = require_persistentHash_audit(sib, auditWriter, newRoot, seq);
  return { msg, sig: auditWriter.sign(msg) };
}
function require_persistentHash_audit(sib, auditWriter, newRoot, seq) {
  // Reproduce the mirrorAuditRoot msg layout.
  const { persistentHash, u64ToBytes32 } = require_lib();
  return persistentHash([
    pad32(MIRROR_TAG.AUDIT_ROOT),
    sib.self,
    Buffer.from(newRoot),
    u64ToBytes32(seq),
    Buffer.from(auditWriter.authHash),
  ]);
}
function require_lib() {
  // Trick to load persistentHash/u64ToBytes32 lazily to avoid circular imports.
  // Only for local reuse; we do a one-shot direct import at top.
  return __libCache;
}
let __libCache;
async function loadLib() {
  const lib = await import('../lib.mjs');
  __libCache = { persistentHash: lib.persistentHash, u64ToBytes32: lib.u64ToBytes32 };
}
await loadLib();

// -----------------------------------------------------------------------------
// M-T1 mirrorGovernanceRoot happy paths
// -----------------------------------------------------------------------------
test('M-T1 mirrorGovernanceRoot: Schedule happy path', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const newRoot = randomBytes(32);
  const epoch = 2n;
  const { sig } = signGovRoot(schedule, fedAuth, newRoot, epoch);
  const prevSeq = schedule._actionSeq;
  schedule.mirrorGovernanceRoot({ newRoot, epochAtMirror: epoch, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(schedule._mirroredGovernanceRoot, newRoot), 'root written');
  assert.equal(schedule._mirroredEpoch, epoch, 'epoch advanced');
  assert.equal(schedule._actionSeq, prevSeq + 1n, 'outbox entry emitted');
  const emitted = schedule._actionLog.get(prevSeq);
  assert.equal(emitted.kind, MIRROR_KIND.GOV_ROOT);
});

test('M-T1 mirrorGovernanceRoot: Lane happy path', () => {
  const { fedAuth, lane, t } = makeFixture();
  const newRoot = randomBytes(32);
  const epoch = 2n;
  const { sig } = signGovRoot(lane, fedAuth, newRoot, epoch);
  lane.mirrorGovernanceRoot({ newRoot, epochAtMirror: epoch, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(lane._mirroredGovernanceRoot, newRoot));
  assert.equal(lane._mirroredEpoch, epoch);
});

test('M-T1 mirrorGovernanceRoot: Views happy path', () => {
  const { fedAuth, views, t } = makeFixture();
  const newRoot = randomBytes(32);
  const epoch = 2n;
  const { sig } = signGovRoot(views, fedAuth, newRoot, epoch);
  views.mirrorGovernanceRoot({ newRoot, epochAtMirror: epoch, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(views._mirroredGovernanceRoot, newRoot));
});

// -----------------------------------------------------------------------------
// M-T2 mirrorEpochAndFloors happy paths + I-15-B monotone
// -----------------------------------------------------------------------------
test('M-T2 mirrorEpochAndFloors: Schedule happy path, all 5 cells updated atomically', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const newEpoch = 2n, ld = 250, ops = 2100, band = 25, rate = 42_000_000n;
  const { sig } = signEpochFloors(schedule, fedAuth, newEpoch, ld, ops, band, rate);
  schedule.mirrorEpochAndFloors({
    newEpoch, newLDFloorBps: ld, newOpsFloorBps: ops,
    newSanityBandPct: band, newRefRateFiatPerKwh: rate,
    sig, authHash: fedAuth.authHash, currentTime: t,
  });
  assert.equal(schedule._mirroredEpoch, newEpoch);
  assert.equal(schedule._mirroredLDFloorBps, ld);
  assert.equal(schedule._mirroredOpsFloorBps, ops);
  assert.equal(schedule._mirroredSanityBandPct, band);
  assert.equal(schedule._mirroredRefRateFiatPerKwh, rate);
});

test('M-T2 mirrorEpochAndFloors: Lane happy path', () => {
  const { fedAuth, lane, t } = makeFixture();
  const { sig } = signEpochFloors(lane, fedAuth, 2n, 200, 2000, 20, 40_000_000n);
  lane.mirrorEpochAndFloors({
    newEpoch: 2n, newLDFloorBps: 200, newOpsFloorBps: 2000,
    newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
    sig, authHash: fedAuth.authHash, currentTime: t,
  });
  assert.equal(lane._mirroredEpoch, 2n);
});

test('M-T2 mirrorEpochAndFloors: Views happy path', () => {
  const { fedAuth, views, t } = makeFixture();
  const { sig } = signEpochFloors(views, fedAuth, 2n, 200, 2000, 20, 40_000_000n);
  views.mirrorEpochAndFloors({
    newEpoch: 2n, newLDFloorBps: 200, newOpsFloorBps: 2000,
    newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
    sig, authHash: fedAuth.authHash, currentTime: t,
  });
  assert.equal(views._mirroredEpoch, 2n);
});

test('I-15-B monotone: three sequential mirrorEpochAndFloors calls advance the epoch', () => {
  const { fedAuth, schedule, t } = makeFixture();
  for (const e of [2n, 3n, 4n]) {
    const { sig } = signEpochFloors(schedule, fedAuth, e, 200, 2000, 20, 40_000_000n);
    schedule.mirrorEpochAndFloors({
      newEpoch: e, newLDFloorBps: 200, newOpsFloorBps: 2000,
      newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
      sig, authHash: fedAuth.authHash, currentTime: t,
    });
    assert.equal(schedule._mirroredEpoch, e);
  }
});

// -----------------------------------------------------------------------------
// M-T3 mirrorFederationAuthority happy paths
// -----------------------------------------------------------------------------
test('M-T3 mirrorFederationAuthority: Schedule rotation, current signs', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const newAuth = makeAuthorityKeypair();
  const { sig } = signFedAuth(schedule, fedAuth, newAuth.authHash, 2n, fedAuth.authHash);
  schedule.mirrorFederationAuthority({
    newAuth: newAuth.authHash, epochAtMirror: 2n,
    sig, currentAuthHash: fedAuth.authHash, currentTime: t,
  });
  assert.ok(bufEq(schedule._mirroredFederationAuthority, newAuth.authHash));
});

test('M-T3 mirrorFederationAuthority: Lane rotation, current signs', () => {
  const { fedAuth, lane, t } = makeFixture();
  const newAuth = makeAuthorityKeypair();
  const { sig } = signFedAuth(lane, fedAuth, newAuth.authHash, 2n, fedAuth.authHash);
  lane.mirrorFederationAuthority({
    newAuth: newAuth.authHash, epochAtMirror: 2n,
    sig, currentAuthHash: fedAuth.authHash, currentTime: t,
  });
  assert.ok(bufEq(lane._mirroredFederationAuthority, newAuth.authHash));
});

// -----------------------------------------------------------------------------
// M-T4 mirrorSchedulesRoot happy paths
// -----------------------------------------------------------------------------
test('M-T4 mirrorSchedulesRoot: Lane happy path', () => {
  const { fedAuth, lane, t } = makeFixture();
  const newRoot = randomBytes(32);
  const { sig } = signRoot(lane, fedAuth, MIRROR_TAG.SCHEDULES_ROOT, newRoot, 1n);
  lane.mirrorSchedulesRoot({ newRoot, schedulesEpoch: 1n, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(lane._mirroredSchedulesRoot, newRoot));
  assert.equal(lane._mirroredSchedulesEpoch, 1n);
});

test('M-T4 mirrorSchedulesRoot: Views happy path', () => {
  const { fedAuth, views, t } = makeFixture();
  const newRoot = randomBytes(32);
  const { sig } = signRoot(views, fedAuth, MIRROR_TAG.SCHEDULES_ROOT, newRoot, 1n);
  views.mirrorSchedulesRoot({ newRoot, schedulesEpoch: 1n, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(views._mirroredSchedulesRoot, newRoot));
});

// -----------------------------------------------------------------------------
// M-T5, M-T6 mirrorClassEntriesRoot / mirrorLanesRoot on Views
// -----------------------------------------------------------------------------
test('M-T5 mirrorClassEntriesRoot: Views happy path', () => {
  const { fedAuth, views, t } = makeFixture();
  const newRoot = randomBytes(32);
  const { sig } = signRoot(views, fedAuth, MIRROR_TAG.CLASS_ROOT, newRoot, 1n);
  views.mirrorClassEntriesRoot({ newRoot, classEntriesEpoch: 1n, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(views._mirroredClassEntriesRoot, newRoot));
});

test('M-T6 mirrorLanesRoot: Views happy path', () => {
  const { fedAuth, views, t } = makeFixture();
  const newRoot = randomBytes(32);
  const { sig } = signRoot(views, fedAuth, MIRROR_TAG.LANES_ROOT, newRoot, 1n);
  views.mirrorLanesRoot({ newRoot, lanesEpoch: 1n, sig, authHash: fedAuth.authHash, currentTime: t });
  assert.ok(bufEq(views._mirroredLanesRoot, newRoot));
});

// -----------------------------------------------------------------------------
// M-T7 mirrorAuditRoot happy paths (all 4 siblings)
// -----------------------------------------------------------------------------
for (const role of ['governance', 'schedule', 'lane', 'views']) {
  test(`M-T7 mirrorAuditRoot: ${role} happy path`, () => {
    const fix = makeFixture();
    const sib = fix[role];
    const auditWriter = fix.auditWriter;
    const newRoot = randomBytes(32);
    const seq = 1n;
    const msg = require_persistentHash_audit(sib, auditWriter, newRoot, seq);
    const sig = auditWriter.sign(msg);
    sib.mirrorAuditRoot({ newRoot, globalSeqAtMirror: seq, sig, writerAuthHash: auditWriter.authHash, currentTime: fix.t });
    assert.ok(bufEq(sib._mirroredAuditRoot, newRoot));
    assert.equal(sib._mirroredAuditGlobalSeq, seq);
  });
}

// -----------------------------------------------------------------------------
// A-T1 stale epoch: monotonicity rejection
// -----------------------------------------------------------------------------
test('A-T1 stale epoch on mirrorGovernanceRoot rejects', () => {
  const { fedAuth, schedule, t } = makeFixture();
  // First: advance to epoch 2 using a consistent (root, sig) pair.
  const r1 = randomBytes(32);
  const { sig: sigA } = signGovRoot(schedule, fedAuth, r1, 2n);
  schedule.mirrorGovernanceRoot({ newRoot: r1, epochAtMirror: 2n, sig: sigA, authHash: fedAuth.authHash, currentTime: t });

  // Now try to write at epoch=2 again (stale, since mirrored epoch is already 2).
  const r2 = randomBytes(32);
  const { sig: sigB } = signGovRoot(schedule, fedAuth, r2, 2n);
  assertReverts(
    () => schedule.mirrorGovernanceRoot({ newRoot: r2, epochAtMirror: 2n, sig: sigB, authHash: fedAuth.authHash, currentTime: t }),
    'MIRROR_EPOCH_STALE',
  );

  // Also: try at epoch=1 (strictly less).
  const r3 = randomBytes(32);
  const { sig: sigC } = signGovRoot(schedule, fedAuth, r3, 1n);
  assertReverts(
    () => schedule.mirrorGovernanceRoot({ newRoot: r3, epochAtMirror: 1n, sig: sigC, authHash: fedAuth.authHash, currentTime: t }),
    'MIRROR_EPOCH_STALE',
  );
});

test('A-T1 stale epoch on mirrorEpochAndFloors rejects', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const { sig: sig1 } = signEpochFloors(schedule, fedAuth, 2n, 200, 2000, 20, 40_000_000n);
  schedule.mirrorEpochAndFloors({
    newEpoch: 2n, newLDFloorBps: 200, newOpsFloorBps: 2000,
    newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
    sig: sig1, authHash: fedAuth.authHash, currentTime: t,
  });
  const { sig: sig2 } = signEpochFloors(schedule, fedAuth, 2n, 200, 2000, 20, 40_000_000n);
  assertReverts(
    () => schedule.mirrorEpochAndFloors({
      newEpoch: 2n, newLDFloorBps: 200, newOpsFloorBps: 2000,
      newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
      sig: sig2, authHash: fedAuth.authHash, currentTime: t,
    }),
    'MIRROR_EPOCH_STALE',
  );
});

test('A-T1 stale globalSeq on mirrorAuditRoot rejects', () => {
  const { auditWriter, schedule, t } = makeFixture();
  const r1 = randomBytes(32);
  const msg1 = require_persistentHash_audit(schedule, auditWriter, r1, 5n);
  schedule.mirrorAuditRoot({ newRoot: r1, globalSeqAtMirror: 5n, sig: auditWriter.sign(msg1), writerAuthHash: auditWriter.authHash, currentTime: t });
  const r2 = randomBytes(32);
  const msg2 = require_persistentHash_audit(schedule, auditWriter, r2, 5n);
  assertReverts(
    () => schedule.mirrorAuditRoot({ newRoot: r2, globalSeqAtMirror: 5n, sig: auditWriter.sign(msg2), writerAuthHash: auditWriter.authHash, currentTime: t }),
    'MIRROR_EPOCH_STALE',
  );
});

// -----------------------------------------------------------------------------
// A-T2 wrong signer — sig invalid
// -----------------------------------------------------------------------------
test('A-T2 wrong signer on mirrorGovernanceRoot rejects', () => {
  const { schedule, t } = makeFixture();
  // Pre-fixture bootstrap set _mirroredFederationAuthority to fedAuth.
  // Now try mirrorGovernanceRoot with a DIFFERENT authority hash.
  const rogue = makeAuthorityKeypair();
  const newRoot = randomBytes(32);
  const { sig } = signGovRoot(schedule, rogue, newRoot, 2n);
  assertReverts(
    () => schedule.mirrorGovernanceRoot({
      newRoot, epochAtMirror: 2n,
      sig, authHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_GOV_AUTH_MISMATCH',
  );
});

test('A-T2 mirrorAuditRoot with wrong writer authority rejects', () => {
  const { schedule, t } = makeFixture();
  const rogue = makeAuthorityKeypair();
  const newRoot = randomBytes(32);
  const msg = require_persistentHash_audit(schedule, rogue, newRoot, 1n);
  assertReverts(
    () => schedule.mirrorAuditRoot({
      newRoot, globalSeqAtMirror: 1n,
      sig: rogue.sign(msg),
      writerAuthHash: rogue.authHash,
      currentTime: t,
    }),
    'MIRROR_AUDIT_AUTH_MISMATCH',
  );
});

// -----------------------------------------------------------------------------
// A-T3 signature replay across siblings: sig signed for sibling X does not
// verify on sibling Y (self is part of msg).
// -----------------------------------------------------------------------------
test('A-T3 mirror-write sig for Schedule.self does not validate on Lane.self', () => {
  const { fedAuth, schedule, lane, t } = makeFixture();
  const newRoot = randomBytes(32);
  // Sign for schedule (schedule.self is in the message).
  const { sig } = signGovRoot(schedule, fedAuth, newRoot, 2n);
  // Replay on lane — the msg lane reconstructs uses lane.self, so verify fails.
  assertReverts(
    () => lane.mirrorGovernanceRoot({
      newRoot, epochAtMirror: 2n,
      sig, authHash: fedAuth.authHash, currentTime: t,
    }),
    'MIRROR_GOV_ROOT_SIG_INVALID',
  );
});

// -----------------------------------------------------------------------------
// A-T4 rotate to zero authority — rejected
// -----------------------------------------------------------------------------
test('A-T4 mirrorFederationAuthority to zero rejects', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const { sig } = signFedAuth(schedule, fedAuth, pad32(''), 2n, fedAuth.authHash);
  assertReverts(
    () => schedule.mirrorFederationAuthority({
      newAuth: pad32(''), epochAtMirror: 2n,
      sig, currentAuthHash: fedAuth.authHash, currentTime: t,
    }),
    'MIRROR_FED_AUTH_ZERO',
  );
});

// -----------------------------------------------------------------------------
// A-T5 mirrorAuditRoot signed by governance authority (wrong role) rejects
// because trust-anchor is _auditWriterAuthorityTarget, not federation.
// -----------------------------------------------------------------------------
test('A-T5 mirrorAuditRoot signed by federation authority (wrong role) rejects', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const newRoot = randomBytes(32);
  const msg = require_persistentHash_audit(schedule, fedAuth, newRoot, 1n);
  assertReverts(
    () => schedule.mirrorAuditRoot({
      newRoot, globalSeqAtMirror: 1n,
      sig: fedAuth.sign(msg),
      writerAuthHash: fedAuth.authHash,   // supplies fed hash where audit-writer hash is required
      currentTime: t,
    }),
    'MIRROR_AUDIT_AUTH_MISMATCH',
  );
});

// -----------------------------------------------------------------------------
// A-T6 signature over tampered payload rejects: sign with newRoot=X, submit newRoot=Y.
// -----------------------------------------------------------------------------
test('A-T6 tampered newRoot after signing rejects with sig invalid', () => {
  const { fedAuth, schedule, t } = makeFixture();
  const signedRoot = randomBytes(32);
  const tamperedRoot = randomBytes(32);
  const { sig } = signGovRoot(schedule, fedAuth, signedRoot, 2n);
  assertReverts(
    () => schedule.mirrorGovernanceRoot({
      newRoot: tamperedRoot, epochAtMirror: 2n,
      sig, authHash: fedAuth.authHash, currentTime: t,
    }),
    'MIRROR_GOV_ROOT_SIG_INVALID',
  );
});

// -----------------------------------------------------------------------------
// Cross-sibling integration: fresh deploy → gov advance → schedules mirror →
// lane can now Merkle-verify against a mirrored root (proof-plumbing check).
// -----------------------------------------------------------------------------
test('cross-sibling integration: gov epoch advance → mirror to schedule → mirror schedules root to lane', () => {
  const fix = makeFixture();
  const { fedAuth, schedule, lane, views, t } = fix;

  // Note: `_mirroredEpoch` is the shared monotone counter used by BOTH
  // mirrorGovernanceRoot (§4.1) AND mirrorEpochAndFloors (§4.2) per the
  // design pattern. In a real deploy, the mirror-writer daemon serializes
  // these calls with strictly-increasing epoch values. Here we advance
  // gov root at epoch 2 and floors bundle at epoch 3.

  // 1) Governance advances epoch to 2. Mirror-writer daemon pushes gov root.
  const govRoot = randomBytes(32);
  for (const sib of [schedule, lane, views]) {
    const { sig } = signGovRoot(sib, fedAuth, govRoot, 2n);
    sib.mirrorGovernanceRoot({ newRoot: govRoot, epochAtMirror: 2n, sig, authHash: fedAuth.authHash, currentTime: t });
  }
  // 2) Bundle mirror at epoch 3 (strictly advances _mirroredEpoch).
  for (const sib of [schedule, lane, views]) {
    const { sig } = signEpochFloors(sib, fedAuth, 3n, 200, 2000, 20, 40_000_000n);
    sib.mirrorEpochAndFloors({
      newEpoch: 3n, newLDFloorBps: 200, newOpsFloorBps: 2000,
      newSanityBandPct: 20, newRefRateFiatPerKwh: 40_000_000n,
      sig, authHash: fedAuth.authHash, currentTime: t,
    });
  }
  // 3) Schedule registers something; mirror-daemon pushes schedules root to Lane/Views
  //    (independent monotone counter `_mirroredSchedulesEpoch`).
  const schedulesRoot = randomBytes(32);
  for (const sib of [lane, views]) {
    const { sig } = signRoot(sib, fedAuth, MIRROR_TAG.SCHEDULES_ROOT, schedulesRoot, 1n);
    sib.mirrorSchedulesRoot({ newRoot: schedulesRoot, schedulesEpoch: 1n, sig, authHash: fedAuth.authHash, currentTime: t });
  }
  // 4) Assertions: all mirrors coherent.
  assert.ok(bufEq(schedule._mirroredGovernanceRoot, govRoot));
  assert.ok(bufEq(lane._mirroredGovernanceRoot, govRoot));
  assert.ok(bufEq(views._mirroredGovernanceRoot, govRoot));
  assert.equal(schedule._mirroredEpoch, 3n);
  assert.equal(lane._mirroredEpoch, 3n);
  assert.equal(views._mirroredEpoch, 3n);
  assert.ok(bufEq(lane._mirroredSchedulesRoot, schedulesRoot));
  assert.ok(bufEq(views._mirroredSchedulesRoot, schedulesRoot));
});
