// tariff-registry/tests/wi15.1/mirror-writes-genesis.test.mjs
// -----------------------------------------------------------------------------
// WI-15.1 Fix A adversarial tests — verify that the PR #49 genesis front-run
// window is closed on Schedule / Lane / Views / Governance.
//
// Motivation: PR #49 review — https://github.com/PollPower/contracts/pull/49#issuecomment-5099332211
// BIG showed that every mirror-write with the pattern
//
//     const cur = _mirroredFederationAuthority;
//     const bootstrap = cur == pad(32, "");
//     assert(disclose(bootstrap || (dCur == cur)), "MIRROR_FED_AUTH_MISMATCH");
//
// let the FIRST caller at genesis (`cur == pad(32, "")`) name any authority
// hash in `currentAuthHash`; signature_valid then verified against that
// attacker-supplied key. Attacker permanently captures the mirror-authority.
//
// Fix: Schedule / Lane / Views constructors now accept
// `initialFederationAuthority: Bytes<32>` and `initialAuditWriterAuthority: Bytes<32>`
// as sealed init parameters and write them to `_mirroredFederationAuthority`
// and `_auditWriterAuthorityTarget` at deploy time. Every mirror-write must
// match those sealed values verbatim — no bootstrap escape hatch.
//
// This test file constructs a FRESH sibling per test (i.e. no pre-fixture
// mirror-writes have run) and confirms that:
//
//   (a) A rogue authority attempting the first mirror-write at genesis is
//       rejected with the expected MISMATCH revert.
//   (b) The sealed genesis authority is written verbatim to the sibling's
//       mirror-cell and the trust anchor is not writable by anyone else.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { Revert, pad32, bufEq, persistentHash, u64ToBytes32 } from '../lib.mjs';
import {
  MirrorSibling, MIRROR_TAG, makeAuthorityKeypair,
} from './mirror-lib.mjs';

function assertReverts(fn, expected) {
  try { fn(); }
  catch (e) {
    assert.ok(e instanceof Revert, `expected Revert, got ${e?.constructor?.name}: ${e?.message}`);
    if (expected) assert.match(e.message, new RegExp(expected), `expected /${expected}/, got: ${e.message}`);
    return;
  }
  assert.fail(`expected Revert (${expected ?? 'any'}), but no throw`);
}

// Fresh sibling with sealed genesis authorities. No pre-flight mirror-writes.
function freshSibling(role, { fedAuth, auditWriter }) {
  return new MirrorSibling({
    role,
    initialFederationAuthority: fedAuth.authHash,
    initialAuditWriterAuthority: auditWriter.authHash,
  });
}

const t = 1_700_000_000n;

// -----------------------------------------------------------------------------
// FIX-A-1: Schedule — rogue authority at genesis on mirrorGovernanceRoot rejects
// -----------------------------------------------------------------------------
test('FIX-A-1 Schedule: rogue authority at genesis on mirrorGovernanceRoot rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const schedule = freshSibling('schedule', { fedAuth, auditWriter });

  // Sanity: sealed at genesis, matches fedAuth (not empty pad32('')).
  assert.ok(bufEq(schedule._mirroredFederationAuthority, fedAuth.authHash),
    'sealed genesis fedAuth written by ctor');
  assert.ok(!bufEq(schedule._mirroredFederationAuthority, pad32('')),
    'not empty at genesis');

  // Rogue tries a mirror-write signing under their own key. Under the old
  // bootstrap short-circuit this would have been accepted (first-caller wins).
  const newRoot = randomBytes(32);
  const epoch = 2n;
  const msg = schedule._msgGovRoot(newRoot, epoch, rogue.authHash);
  const sig = rogue.sign(msg);
  assertReverts(
    () => schedule.mirrorGovernanceRoot({
      newRoot, epochAtMirror: epoch,
      sig, authHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_GOV_AUTH_MISMATCH',
  );

  // The mirror-cell was not written.
  assert.ok(bufEq(schedule._mirroredFederationAuthority, fedAuth.authHash),
    'trust anchor unchanged after rejected rogue write');
});

// -----------------------------------------------------------------------------
// FIX-A-2: Lane — rogue authority at genesis on mirrorFederationAuthority rejects
// (the classic §4.3 front-run scenario BIG called out)
// -----------------------------------------------------------------------------
test('FIX-A-2 Lane: rogue authority at genesis on mirrorFederationAuthority rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const lane = freshSibling('lane', { fedAuth, auditWriter });

  // Rogue names their own hash as `currentAuthHash` and signs a fresh rotation.
  // Under the old code this would rotate the mirror-authority to attacker.newAuth.
  const attackerNewAuth = makeAuthorityKeypair();
  const epoch = 2n;
  const msg = lane._msgFedAuth(attackerNewAuth.authHash, epoch, rogue.authHash);
  const sig = rogue.sign(msg);
  assertReverts(
    () => lane.mirrorFederationAuthority({
      newAuth: attackerNewAuth.authHash,
      epochAtMirror: epoch,
      sig,
      currentAuthHash: rogue.authHash,
      currentTime: t,
    }),
    'MIRROR_FED_AUTH_MISMATCH',
  );

  // Trust anchor unchanged — attacker did not capture mirror-authority.
  assert.ok(bufEq(lane._mirroredFederationAuthority, fedAuth.authHash),
    'trust anchor unchanged after rejected rogue rotation');
});

// -----------------------------------------------------------------------------
// FIX-A-3: Views — rogue authority at genesis on mirrorGovernanceRoot rejects
// (Views has _mirroredFederationAuthority per PR #49 Blocker #2)
// -----------------------------------------------------------------------------
test('FIX-A-3 Views: rogue authority at genesis on mirrorGovernanceRoot rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const views = freshSibling('views', { fedAuth, auditWriter });

  const newRoot = randomBytes(32);
  const epoch = 2n;
  const msg = views._msgGovRoot(newRoot, epoch, rogue.authHash);
  const sig = rogue.sign(msg);
  assertReverts(
    () => views.mirrorGovernanceRoot({
      newRoot, epochAtMirror: epoch,
      sig, authHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_GOV_AUTH_MISMATCH',
  );

  assert.ok(bufEq(views._mirroredFederationAuthority, fedAuth.authHash),
    'Views trust anchor unchanged after rejected rogue write');
});

// -----------------------------------------------------------------------------
// FIX-A-4: Governance — rogue audit-writer at genesis on mirrorAuditRoot rejects
// (governance uses `_auditWriterAuthorityTarget` per §A2)
// -----------------------------------------------------------------------------
test('FIX-A-4 Governance: rogue audit-writer at genesis on mirrorAuditRoot rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const governance = freshSibling('governance', { fedAuth, auditWriter });

  // Sanity: sealed at genesis.
  assert.ok(bufEq(governance._auditWriterAuthorityTarget, auditWriter.authHash),
    'sealed genesis audit-writer written by ctor');

  const newRoot = randomBytes(32);
  const seq = 1n;
  // Build message under rogue key.
  const msg = persistentHash([
    pad32(MIRROR_TAG.AUDIT_ROOT),
    governance.self,
    Buffer.from(newRoot),
    u64ToBytes32(seq),
    Buffer.from(rogue.authHash),
  ]);
  const sig = rogue.sign(msg);

  assertReverts(
    () => governance.mirrorAuditRoot({
      newRoot, globalSeqAtMirror: seq,
      sig, writerAuthHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_AUDIT_AUTH_MISMATCH',
  );

  // Trust anchor unchanged.
  assert.ok(bufEq(governance._auditWriterAuthorityTarget, auditWriter.authHash),
    'Governance audit-writer trust anchor unchanged after rejected rogue write');
});

// -----------------------------------------------------------------------------
// FIX-A-5: Schedule — rogue audit-writer at genesis on mirrorAuditRoot rejects
// (Schedule also holds `_auditWriterAuthorityTarget`, sealed by its constructor
// per WI-15.1 Fix A)
// -----------------------------------------------------------------------------
test('FIX-A-5 Schedule: rogue audit-writer at genesis on mirrorAuditRoot rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const schedule = freshSibling('schedule', { fedAuth, auditWriter });

  const newRoot = randomBytes(32);
  const seq = 1n;
  const msg = persistentHash([
    pad32(MIRROR_TAG.AUDIT_ROOT),
    schedule.self,
    Buffer.from(newRoot),
    u64ToBytes32(seq),
    Buffer.from(rogue.authHash),
  ]);
  const sig = rogue.sign(msg);

  assertReverts(
    () => schedule.mirrorAuditRoot({
      newRoot, globalSeqAtMirror: seq,
      sig, writerAuthHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_AUDIT_AUTH_MISMATCH',
  );
});

// -----------------------------------------------------------------------------
// FIX-A-6: Rogue with a VALID signature under their own key at genesis still
// rejects — the MISMATCH check runs BEFORE signature_valid, so even if the
// attacker signs correctly under their own key the mismatch closes the door.
//
// (Belt-and-suspenders: this documents that the fix works regardless of which
// assertion order the compiler generates.)
// -----------------------------------------------------------------------------
test('FIX-A-6 Schedule: rogue with valid sig under own key at genesis still rejects', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const rogue = makeAuthorityKeypair();

  const schedule = freshSibling('schedule', { fedAuth, auditWriter });
  const newRoot = randomBytes(32);
  const epoch = 2n;
  const msg = schedule._msgGovRoot(newRoot, epoch, rogue.authHash);
  // Signature is cryptographically valid under rogue's key.
  const sig = rogue.sign(msg);

  assertReverts(
    () => schedule.mirrorGovernanceRoot({
      newRoot, epochAtMirror: epoch,
      sig, authHash: rogue.authHash, currentTime: t,
    }),
    'MIRROR_GOV_AUTH_MISMATCH',
  );
});

// -----------------------------------------------------------------------------
// FIX-A-7: Positive-control — a legitimate first mirror-write at genesis under
// the sealed authority succeeds. This documents that Fix A does not break the
// happy path; the sealed authority IS the trust anchor from tx-0.
// -----------------------------------------------------------------------------
test('FIX-A-7 Positive: legitimate first mirror-write at genesis under sealed authority succeeds', () => {
  const fedAuth = makeAuthorityKeypair();
  const auditWriter = makeAuthorityKeypair();
  const schedule = freshSibling('schedule', { fedAuth, auditWriter });

  const newRoot = randomBytes(32);
  const epoch = 2n;
  const msg = schedule._msgGovRoot(newRoot, epoch, fedAuth.authHash);
  const sig = fedAuth.sign(msg);
  schedule.mirrorGovernanceRoot({
    newRoot, epochAtMirror: epoch,
    sig, authHash: fedAuth.authHash, currentTime: t,
  });
  assert.ok(bufEq(schedule._mirroredGovernanceRoot, newRoot),
    'first legitimate mirror-write at genesis writes the root');
  assert.equal(schedule._mirroredEpoch, epoch);
});
