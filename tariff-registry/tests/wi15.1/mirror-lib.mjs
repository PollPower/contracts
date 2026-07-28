// tariff-registry/tests/wi15.1/mirror-lib.mjs
// -----------------------------------------------------------------------------
// Offline JS mirror of WI-15.1 mirror-write circuits and mirror-cell state,
// installed on Schedule / Lane / Views / Governance siblings. Mirrors the
// Compact contract byte-for-byte on domain tags, message layouts, revert
// strings, and body pattern (V2-SPLIT-DESIGN.md §4.1–4.9).
//
// See lib.mjs for the base pattern (SHA-256 for persistentHash, Ed25519 for
// signature_valid, checked-cast Uint bounds for monotone assertions).
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import {
  pad32, persistentHash, u64ToBytes32, u16ToBytes32,
  toHex, bufEq, Revert,
  signatureValid, ed25519Sign, newEd25519,
} from '../lib.mjs';

function revert(msg) { throw new Revert(msg); }

// Mirror-write action kinds (proposed §4.1–§4.9 values).
export const MIRROR_KIND = Object.freeze({
  GOV_ROOT:       16,
  EPOCH_FLOORS:   17,
  FED_AUTH:       18,
  SCHEDULES_ROOT: 19,
  CLASS_ROOT:     20,
  LANES_ROOT:     21,
  AUDIT_ROOT:     22,
});

// Domain tags — byte-for-byte identical to the .compact strings.
export const MIRROR_TAG = Object.freeze({
  GOV_ROOT:       'pp:tariff:v2:mirrorGovRoot',
  EPOCH_FLOORS:   'pp:tariff:v2:mirrorEpochFloors',
  FED_AUTH:       'pp:tariff:v2:mirrorFedAuth',
  SCHEDULES_ROOT: 'pp:tariff:v2:mirrorSchedulesRoot',
  CLASS_ROOT:     'pp:tariff:v2:mirrorClassRoot',
  LANES_ROOT:     'pp:tariff:v2:mirrorLanesRoot',
  AUDIT_ROOT:     'pp:tariff:v2:mirrorAuditRoot',
});

// -----------------------------------------------------------------------------
// A minimal V2 sibling — mirror cells + emitAction outbox counter. Models
// what Schedule / Lane / Views hold post-mirror-write.
// -----------------------------------------------------------------------------
export class MirrorSibling {
  constructor({
    self,
    // audit-writer trust anchor (Governance-constructor-seeded per §A2)
    auditWriterAuthorityTarget = pad32(''),
    role = 'schedule',  // 'schedule' | 'lane' | 'views' | 'governance'
  } = {}) {
    this.self = Buffer.isBuffer(self) ? self : randomBytes(32);
    this.role = role;

    // Bootstrap markers — sibling is deployed as ready. Tests can toggle.
    this._initialized = true;
    this._bootstrapComplete = true;

    // Local outbox — mirror-writes emit actions here (§4.1 step 4).
    this._actionLog = new Map();     // seq -> entry
    this._actionSeq = 0n;
    this._currentEpoch = 0n;

    // Mirror cells (all zero at deploy, per constructor).
    this._mirroredGovernanceRoot        = Buffer.alloc(32);
    this._mirroredEpoch                 = 0n;
    this._mirroredLDFloorBps            = 0;
    this._mirroredOpsFloorBps           = 0;
    this._mirroredSanityBandPct         = 0;
    this._mirroredRefRateFiatPerKwh     = 0n;
    this._mirroredFederationAuthority   = Buffer.alloc(32);
    this._mirroredSchedulesRoot         = Buffer.alloc(32);
    this._mirroredSchedulesEpoch        = 0n;
    this._mirroredClassEntriesRoot      = Buffer.alloc(32);
    this._mirroredClassEntriesEpoch     = 0n;
    this._mirroredLanesRoot             = Buffer.alloc(32);
    this._mirroredLanesEpoch            = 0n;
    this._mirroredAuditRoot             = Buffer.alloc(32);
    this._mirroredAuditGlobalSeq        = 0n;

    // Trust anchor for audit-writer authority (§A2 addendum).
    this._auditWriterAuthorityTarget = Buffer.from(auditWriterAuthorityTarget);
  }

  assertInitialized() {
    if (!this._initialized) revert('TariffRegistry: not initialized');
    if (!this._bootstrapComplete) revert('TariffRegistry: bootstrap incomplete');
  }

  emitAction(kind, scheduleId, nodeId, actionHash, payloadHash, currentTime) {
    const seq = this._actionSeq;
    this._actionLog.set(seq, {
      kind,
      scheduleId: Buffer.from(scheduleId),
      nodeId: Buffer.from(nodeId),
      epoch: this._currentEpoch,
      actionHash: Buffer.from(actionHash),
      emittedAt: BigInt(currentTime),
      payloadHash: Buffer.from(payloadHash),
    });
    this._actionSeq = seq + 1n;
  }

  // --- helpers to build canonical mirror-write messages ---------------------
  _msgGovRoot(newRoot, epoch, authHash) {
    return persistentHash([
      pad32(MIRROR_TAG.GOV_ROOT),
      this.self,
      newRoot,
      u64ToBytes32(epoch),
      authHash,
    ]);
  }
  _msgEpochFloors(newEpoch, ld, ops, band, rate, authHash) {
    return persistentHash([
      pad32(MIRROR_TAG.EPOCH_FLOORS),
      this.self,
      u64ToBytes32(newEpoch),
      u16ToBytes32(ld),
      u16ToBytes32(ops),
      u16ToBytes32(band),
      u64ToBytes32(rate),
      authHash,
    ]);
  }
  _msgFedAuth(newAuth, epoch, curAuth) {
    return persistentHash([
      pad32(MIRROR_TAG.FED_AUTH),
      this.self,
      newAuth,
      u64ToBytes32(epoch),
      curAuth,
    ]);
  }
  _msgRoot(tag, newRoot, epoch, authHash) {
    return persistentHash([
      pad32(tag),
      this.self,
      newRoot,
      u64ToBytes32(epoch),
      authHash,
    ]);
  }

  // -------------------------------------------------------------------------
  // mirrorGovernanceRoot (§4.1) — installs on Schedule, Lane, Views.
  // -------------------------------------------------------------------------
  mirrorGovernanceRoot({ newRoot, epochAtMirror, sig, authHash, currentTime }) {
    this.assertInitialized();

    const msg = this._msgGovRoot(newRoot, epochAtMirror, authHash);

    // Bootstrap-friendly binding: first write seeds trust anchor.
    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(authHash, cur)) revert('MIRROR_GOV_AUTH_MISMATCH');
    if (!signatureValid(authHash, msg, sig)) revert('MIRROR_GOV_ROOT_SIG_INVALID');

    // I-15-B monotone: (dEpoch - _mirroredEpoch - 1) as Uint<64>
    if (BigInt(epochAtMirror) <= this._mirroredEpoch) {
      revert('MIRROR_EPOCH_STALE');  // checked-cast underflow
    }

    this._mirroredGovernanceRoot = Buffer.from(newRoot);
    this._mirroredEpoch = BigInt(epochAtMirror);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.GOV_ROOT),
      Buffer.from(newRoot),
      u64ToBytes32(epochAtMirror),
    ]);
    this.emitAction(MIRROR_KIND.GOV_ROOT, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorEpochAndFloors (§4.2) — Schedule, Lane, Views.
  // -------------------------------------------------------------------------
  mirrorEpochAndFloors({
    newEpoch, newLDFloorBps, newOpsFloorBps, newSanityBandPct, newRefRateFiatPerKwh,
    sig, authHash, currentTime,
  }) {
    this.assertInitialized();
    const msg = this._msgEpochFloors(
      newEpoch, newLDFloorBps, newOpsFloorBps, newSanityBandPct, newRefRateFiatPerKwh, authHash,
    );

    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(authHash, cur)) revert('MIRROR_GOV_AUTH_MISMATCH');
    if (!signatureValid(authHash, msg, sig)) revert('MIRROR_EPOCH_FLOORS_SIG_INVALID');

    if (BigInt(newEpoch) <= this._mirroredEpoch) revert('MIRROR_EPOCH_STALE');

    this._mirroredEpoch                 = BigInt(newEpoch);
    this._mirroredLDFloorBps            = Number(newLDFloorBps);
    this._mirroredOpsFloorBps           = Number(newOpsFloorBps);
    this._mirroredSanityBandPct         = Number(newSanityBandPct);
    this._mirroredRefRateFiatPerKwh     = BigInt(newRefRateFiatPerKwh);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.EPOCH_FLOORS),
      u64ToBytes32(newEpoch),
      u16ToBytes32(newLDFloorBps),
      u16ToBytes32(newOpsFloorBps),
      u16ToBytes32(newSanityBandPct),
      u64ToBytes32(newRefRateFiatPerKwh),
    ]);
    this.emitAction(MIRROR_KIND.EPOCH_FLOORS, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorFederationAuthority (§4.3) — Schedule, Lane.
  // -------------------------------------------------------------------------
  mirrorFederationAuthority({ newAuth, epochAtMirror, sig, currentAuthHash, currentTime }) {
    this.assertInitialized();
    if (bufEq(newAuth, pad32(''))) revert('MIRROR_FED_AUTH_ZERO');

    const msg = this._msgFedAuth(newAuth, epochAtMirror, currentAuthHash);
    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(currentAuthHash, cur)) revert('MIRROR_FED_AUTH_MISMATCH');
    if (!signatureValid(currentAuthHash, msg, sig)) revert('MIRROR_FED_AUTH_SIG_INVALID');

    if (BigInt(epochAtMirror) <= this._mirroredEpoch) revert('MIRROR_EPOCH_STALE');

    this._mirroredFederationAuthority = Buffer.from(newAuth);
    this._mirroredEpoch = BigInt(epochAtMirror);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.FED_AUTH),
      Buffer.from(newAuth),
      u64ToBytes32(epochAtMirror),
    ]);
    this.emitAction(MIRROR_KIND.FED_AUTH, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorSchedulesRoot (§4.6) — Lane, Views.
  // -------------------------------------------------------------------------
  mirrorSchedulesRoot({ newRoot, schedulesEpoch, sig, authHash, currentTime }) {
    this.assertInitialized();
    const msg = this._msgRoot(MIRROR_TAG.SCHEDULES_ROOT, newRoot, schedulesEpoch, authHash);
    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(authHash, cur)) revert('MIRROR_GOV_AUTH_MISMATCH');
    if (!signatureValid(authHash, msg, sig)) revert('MIRROR_SCHEDULES_ROOT_SIG_INVALID');

    if (BigInt(schedulesEpoch) <= this._mirroredSchedulesEpoch) revert('MIRROR_EPOCH_STALE');

    this._mirroredSchedulesRoot = Buffer.from(newRoot);
    this._mirroredSchedulesEpoch = BigInt(schedulesEpoch);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.SCHEDULES_ROOT),
      Buffer.from(newRoot),
      u64ToBytes32(schedulesEpoch),
    ]);
    this.emitAction(MIRROR_KIND.SCHEDULES_ROOT, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorClassEntriesRoot (§4.7) — Views only.
  // -------------------------------------------------------------------------
  mirrorClassEntriesRoot({ newRoot, classEntriesEpoch, sig, authHash, currentTime }) {
    this.assertInitialized();
    const msg = this._msgRoot(MIRROR_TAG.CLASS_ROOT, newRoot, classEntriesEpoch, authHash);
    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(authHash, cur)) revert('MIRROR_GOV_AUTH_MISMATCH');
    if (!signatureValid(authHash, msg, sig)) revert('MIRROR_CLASS_ROOT_SIG_INVALID');

    if (BigInt(classEntriesEpoch) <= this._mirroredClassEntriesEpoch) revert('MIRROR_EPOCH_STALE');

    this._mirroredClassEntriesRoot = Buffer.from(newRoot);
    this._mirroredClassEntriesEpoch = BigInt(classEntriesEpoch);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.CLASS_ROOT),
      Buffer.from(newRoot),
      u64ToBytes32(classEntriesEpoch),
    ]);
    this.emitAction(MIRROR_KIND.CLASS_ROOT, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorLanesRoot (§4.8) — Views only.
  // -------------------------------------------------------------------------
  mirrorLanesRoot({ newRoot, lanesEpoch, sig, authHash, currentTime }) {
    this.assertInitialized();
    const msg = this._msgRoot(MIRROR_TAG.LANES_ROOT, newRoot, lanesEpoch, authHash);
    const cur = this._mirroredFederationAuthority;
    const isBootstrap = bufEq(cur, pad32(''));
    if (!isBootstrap && !bufEq(authHash, cur)) revert('MIRROR_GOV_AUTH_MISMATCH');
    if (!signatureValid(authHash, msg, sig)) revert('MIRROR_LANES_ROOT_SIG_INVALID');

    if (BigInt(lanesEpoch) <= this._mirroredLanesEpoch) revert('MIRROR_EPOCH_STALE');

    this._mirroredLanesRoot = Buffer.from(newRoot);
    this._mirroredLanesEpoch = BigInt(lanesEpoch);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.LANES_ROOT),
      Buffer.from(newRoot),
      u64ToBytes32(lanesEpoch),
    ]);
    this.emitAction(MIRROR_KIND.LANES_ROOT, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }

  // -------------------------------------------------------------------------
  // mirrorAuditRoot (§4.9) — Governance, Schedule, Lane, Views.
  //   Signer = audit-writer authority (§A1/§A6 addendum), NOT gov auth.
  // -------------------------------------------------------------------------
  mirrorAuditRoot({ newRoot, globalSeqAtMirror, sig, writerAuthHash, currentTime }) {
    this.assertInitialized();
    const msg = persistentHash([
      pad32(MIRROR_TAG.AUDIT_ROOT),
      this.self,
      Buffer.from(newRoot),
      u64ToBytes32(globalSeqAtMirror),
      Buffer.from(writerAuthHash),
    ]);
    const target = this._auditWriterAuthorityTarget;
    const isBootstrap = bufEq(target, pad32(''));
    if (!isBootstrap && !bufEq(writerAuthHash, target)) revert('MIRROR_AUDIT_AUTH_MISMATCH');
    if (!signatureValid(writerAuthHash, msg, sig)) revert('MIRROR_AUDIT_ROOT_SIG_INVALID');

    if (BigInt(globalSeqAtMirror) <= this._mirroredAuditGlobalSeq) revert('MIRROR_EPOCH_STALE');

    this._mirroredAuditRoot = Buffer.from(newRoot);
    this._mirroredAuditGlobalSeq = BigInt(globalSeqAtMirror);

    const payloadHash = persistentHash([
      pad32(MIRROR_TAG.AUDIT_ROOT),
      Buffer.from(newRoot),
      u64ToBytes32(globalSeqAtMirror),
    ]);
    this.emitAction(MIRROR_KIND.AUDIT_ROOT, pad32(''), pad32(''), msg, payloadHash, currentTime);
  }
}

// -----------------------------------------------------------------------------
// Helper: build a federation-authority ed25519 keypair whose raw-pubkey hash
// serves as the authorityHash. Real federation authority is a multisig hash
// (§4.3), but for mirror-write signature checks the contract uses
// signature_valid(authorityHash, msg, sig) which takes a raw 32-byte pubkey.
// -----------------------------------------------------------------------------
export function makeAuthorityKeypair() {
  const kp = newEd25519();
  return {
    kp,
    authHash: Buffer.from(kp.pubkeyBytes),
    sign(msg) { return ed25519Sign(kp.privateKey, msg); },
  };
}
