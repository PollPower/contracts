// ebt/tests/lib.mjs
// -----------------------------------------------------------------------------
// Offline JS mirror of ebt/ebt-v8.compact (WI-14 EBT vNext). Same shape, same
// domain tags, same field order, same revert-message strings. The .compact
// contract is ground truth for on-chain behaviour; this file lets the offline
// smoke suite (T01..T18) exercise the invariants (I-14-A..K) without a chain.
//
// The Registry side is REUSED from tariff-registry/tests/lib.mjs (WI-13.1 +
// WI-13.2): LaneRecord / laneKey / per-kind payloadHash / the action-log Merkle
// tree + reconstructRoot. That guarantees the EBT mirror-write EventProof path
// consumes the SAME artifacts a real WI-13.2 keeper would produce.
//
// Mirroring convention matches tariff-registry/tests/lib.mjs:
//   - persistentHash<Vector<N,Bytes<32>>>([...]) == SHA-256 over the same bytes.
//   - "as Uint<N>" checked-casts emulated as bigint bounds checks that throw a
//     Revert with the same message string.
//   - witnesses (signature_valid, multisig_signature_valid) are JS functions.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

import * as R from '../../tariff-registry/tests/lib.mjs';

const {
  pad32, persistentHash, u64ToBytes32, u16ToBytes32,
  toHex, bufEq, Revert,
  laneKey, zeroLaneRecord,
  laneActionPayloadHash, scheduleActionPayloadHash, retuneActionPayloadHash,
  reconstructActionLogRoot,
  newEd25519, ed25519Sign, signatureValid,
  makeFixture,
} = R;

// Re-export the registry primitives the test files lean on.
export {
  pad32, persistentHash, u64ToBytes32, u16ToBytes32,
  toHex, bufEq, Revert,
  laneKey, zeroLaneRecord,
  laneActionPayloadHash, scheduleActionPayloadHash, retuneActionPayloadHash,
  reconstructActionLogRoot,
  newEd25519, ed25519Sign, signatureValid,
  makeFixture,
};

// ------------------------------ REVERT helper --------------------------------

function revert(message) { throw new Revert(message); }

// Checked-cast to Uint<N> — reverts with `message` on underflow/overflow.
function asUintChecked(value, bits, message) {
  const v = BigInt(value);
  if (v < 0n) revert(message);
  const max = (1n << BigInt(bits)) - 1n;
  if (v > max) revert(message);
  return v;
}

// ------------------------------ EBT domain tags ------------------------------
// Byte-for-byte identical to the .compact string literals. TASK: the v2 brief
// locks the domain-sep tag to "pollpower:ebt:v8:epoch1".

export const EBT_DOMAIN = Object.freeze({
  COLOR:         'pollpower:ebt:v8:epoch1',   // token color + mint domain
  HAT:           'pollpower:ebt:v8:epoch1',   // HAT signed-payload domain
  CLASS_KEY:     'pp:ebt:v8:classKey',        // _classStatutoryTotalBpsMirror key
  DIVIDEND_SALT: 'pollpower:dividend:v8',      // LD binding salt (I-14-H shape)
  ESCROW:        'pollpower:ebt:v8:escrow',    // escrow solvency-attestation domain
});

// Calibration scaffolds (mirror of the .compact pure circuits). NON-AUTHORITATIVE
// — none of these resolves a CAL-n value; they exist so the harness can run.
// CAL-vNext-M1 scaffold: kept in lockstep with the .compact literal. The design
// DRAFT is 4; this scaffold is generous (64) so multi-event test scenarios do
// not spuriously trip freshness — like the registry's CAL-13.2-D=24 scaffold,
// this is NOT a resolution of CAL-vNext-M1 (still Garrett's call).
export const CAL_MIRROR_STALE_TOLERANCE = 64n;   // CAL-vNext-M1 (scaffold, TODO)
export const CAL_ESCROW_STALE_TOLERANCE = 3600n; // CAL-vNext-M2 (scaffold)
export const CAL_2_FIAT_FLOOR = 1n;               // CAL-2 (scaffold)
export const CAL_2_FIAT_CEIL  = 1000000000n;      // CAL-2 (scaffold)
export const REDEMPTION_KES = 0;
export const REDEMPTION_KWH = 1;

// ------------------------------ EBT helpers ----------------------------------

// EBT-side class key (design §2.2). Domain-sep is EBT-side.
export function classKey(scheduleId, classPath) {
  return persistentHash([pad32(EBT_DOMAIN.CLASS_KEY), scheduleId, classPath]);
}

// Slice policy — cross-multiplication, ported from the .compact assertSliceOnPolicy.
function assertSliceOnPolicy(amt, amount, bps) {
  const bpsTotal = 10000n;
  const cross  = BigInt(amt) * bpsTotal;
  const target = BigInt(amount) * BigInt(bps);
  if (!(cross + bpsTotal > target && cross < target + bpsTotal)) {
    revert('SLICE_OFF_POLICY');
  }
}

// verifyEventProof (VNEXT-DESIGN §7.1). Mirror of the .compact circuit.
function verifyEventProof(entry, proof, rootMirror) {
  if (!bufEq(entry.payloadHash, proof.payloadHash)) revert('EVENT_PROOF_INVALID');
  const recon = reconstructActionLogRoot(proof.payloadHash, proof.siblings, proof.pathBits);
  if (!bufEq(recon, rootMirror)) revert('EVENT_PROOF_INVALID');
}

function deepCopyLane(r) {
  return {
    scheduleId:        Buffer.from(r.scheduleId),
    laneKindByte:      Number(r.laneKindByte),
    leviedBy:          Buffer.from(r.leviedBy),
    bpsShare:          Number(r.bpsShare),
    remitAddress:      Buffer.from(r.remitAddress),
    basis:             Number(r.basis),
    applicabilityHash: Buffer.from(r.applicabilityHash),
    statuteRefHash:    Buffer.from(r.statuteRefHash),
    effectiveEpoch:    BigInt(r.effectiveEpoch),
    retiredEpoch:      BigInt(r.retiredEpoch),
    remittanceMode:    Number(r.remittanceMode),
    registeredAt:      BigInt(r.registeredAt),
  };
}

function deepCopySchedule(r) {
  return {
    scheduleId:        Buffer.from(r.scheduleId),
    nodeId:            Buffer.from(r.nodeId),
    scheduleHash:      Buffer.from(r.scheduleHash),
    operatorPubkey:    Buffer.from(r.operatorPubkey),
    effectiveEpoch:    BigInt(r.effectiveEpoch),
    retiredEpoch:      BigInt(r.retiredEpoch),
    refRateFiatPerKwh: BigInt(r.refRateFiatPerKwh),
    registeredAt:      BigInt(r.registeredAt),
  };
}

// ------------------------------ EBT contract state ---------------------------

export class EBT {
  constructor({
    meterAuthorityPubkey, multisigAuthority,
    operationsRecipient, dividendRecipient, daoRecipient,
    escrowAttestorPubkey, registryActionLogRoot, self,
  }) {
    this.self = Buffer.isBuffer(self) ? self : randomBytes(32);
    this._initialized = true;
    this._owner = randomBytes(32);
    this._meterAuthorityPubkey = Buffer.from(meterAuthorityPubkey);
    this._multisigAuthority = Buffer.from(multisigAuthority ?? randomBytes(32));
    this._operationsRecipient = Buffer.from(operationsRecipient);
    this._dividendRecipient = Buffer.from(dividendRecipient);
    this._daoRecipient = Buffer.from(daoRecipient);
    this._escrowAttestorPubkey = Buffer.from(escrowAttestorPubkey);

    this._totalSupply = 0n;
    this._totalRedeemed = 0n;
    this.settlementCount = 0n;
    this._settledSessions = new Set();

    this.producerAttestations = new Map();
    this.reissuanceCount = 0n;
    this.reissuanceLog = new Map();
    this._lastReissueTime = 0n;
    this._redemptionCount = 0n;
    this._redemptionLog = new Map();

    this._pendingOps = 0n;
    this._pendingDiv = 0n;
    this._pendingDao = 0n;
    this._splitClaimCount = 0n;

    this._livingDividendAddress = null;   // Buffer (contract addr) or null
    this._dividendEventSeq = 0n;
    this._dividendMintedLog = new Map();

    // Registry-mirror maps.
    this._registeredLanesMirror = new Map();        // keyHex -> {record, writeActionSeq}
    this._classStatutoryTotalBpsMirror = new Map(); // keyHex -> number
    this._scheduleLiveMirror = new Map();           // sidHex -> bool
    this._registryActionLogRootMirror = Buffer.from(registryActionLogRoot);
    this._registryActionLogHeadSeqMirror = 0n;

    this._settleLog = new Map();

    // Multisig approval bundle store (mirror of the multisig_signature_valid
    // witness). Tests call approveMultisig(payloadHash) to authorize an
    // execMultisigOp payload; a missing bundle causes the witness to fail.
    this._multisigApprovals = new Map();

    // Test-observable side effects.
    this.mints = [];            // [{ amount, recipient }]
    this._poolBalance = 0n;     // circulating on-chain balance (for redeem)
  }

  // Multisig-witness helpers (mirror of the .compact multisig_signature_valid
  // witness). approveMultisig binds a payload hash to the current authority so
  // multisigSignatureValid returns true; used by execMultisigOp mirror below.
  approveMultisig(payloadHash) {
    this._multisigApprovals.set(toHex(payloadHash), Buffer.from(this._multisigAuthority));
  }
  multisigSignatureValid(payload, authorityHash) {
    const bound = this._multisigApprovals.get(toHex(payload));
    return !!bound && bufEq(bound, authorityHash);
  }

  ebtColorPool() { return this._poolBalance; }

  _mint(amount, recipient) {
    this.mints.push({ amount: BigInt(amount), recipient: Buffer.from(recipient) });
    this._poolBalance += BigInt(amount);
  }

  // ---------------------------- attestation --------------------------------
  attest({ producerKey, meterKeyHash, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('timestamp cannot be in the future');
    const attKey = persistentHash([producerKey, meterKeyHash]);
    this.producerAttestations.set(toHex(attKey), {
      active: true, attestedAt: BigInt(currentTime), revokedAt: 0n,
    });
  }
  revoke({ producerKey, meterKeyHash, currentTime, now }) {
    if (BigInt(now ?? (currentTime ?? 0n)) < BigInt(currentTime ?? 0n)) revert('timestamp cannot be in the future');
    const attKey = persistentHash([producerKey, meterKeyHash]);
    const st = this.producerAttestations.get(toHex(attKey));
    if (!st) revert('No such attestation');
    if (!st.active) revert('Already revoked');
    st.active = false;
    this.producerAttestations.set(toHex(attKey), st);
  }

  // ---------------------------- LD binding setter --------------------------
  setLivingDividendAddress(addr) { this._livingDividendAddress = Buffer.from(addr); }

  // ---------------------------- mirror trust anchors -----------------------
  // Round-2 fix: owner gate is the trust anchor; witness is sanity-only.
  mirrorActionLogRoot({ newRoot, sampleEntry, proof, caller }) {
    const who = caller ? Buffer.from(caller) : this._owner;
    if (!bufEq(who, this._owner)) revert('Only owner');
    if (!bufEq(sampleEntry.payloadHash, proof.payloadHash)) revert('EVENT_PROOF_INVALID');
    const recon = reconstructActionLogRoot(proof.payloadHash, proof.siblings, proof.pathBits);
    if (!bufEq(recon, newRoot)) revert('EVENT_PROOF_INVALID');
    this._registryActionLogRootMirror = Buffer.from(newRoot);
  }
  // Review-pass-1 fix: witness-gated. The caller cites the latest event they
  // can prove is included under the CURRENTLY-mirrored root; the proof's
  // actionSeq must exactly equal the new head.
  mirrorActionLogHead({ newHeadSeq, latestEntry, proof }) {
    verifyEventProof(latestEntry, proof, this._registryActionLogRootMirror);
    if (!(BigInt(proof.actionSeq) === BigInt(newHeadSeq))) {
      revert('HEAD_ADVANCE_BEYOND_WITNESS');
    }
    asUintChecked(BigInt(newHeadSeq) - this._registryActionLogHeadSeqMirror, 64,
                  'mirrorActionLogHead: not monotone');
    this._registryActionLogHeadSeqMirror = BigInt(newHeadSeq);
  }

  // ---------------------------- execMultisigOp (mirror) --------------------
  // Only op 4 (setEscrowAttestor) is implemented in the JS mirror — the other
  // ops (LD binding / dividend recipient / multisig authority rotation) have
  // no offline-suite coverage today and are exercised only on-chain.
  execMultisigOp({ op, newEscrowAttestor, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('execMultisigOp: timestamp cannot be in the future');
    const k = Number(op);
    if (k !== 4) revert('execMultisigOp: bad op');
    const zero = Buffer.alloc(32);
    if (bufEq(newEscrowAttestor, zero)) revert('setEscrowAttestor: zero pubkey rejected');
    if (bufEq(newEscrowAttestor, this._escrowAttestorPubkey)) {
      revert('setEscrowAttestor: no-op rotation');
    }
    const payload = persistentHash([
      pad32('ebt:v8:setEscrowAttestor'),
      Buffer.from(newEscrowAttestor),
      u64ToBytes32(currentTime),
    ]);
    if (!this.multisigSignatureValid(payload, this._multisigAuthority)) {
      revert('setEscrowAttestor: multisig signature invalid');
    }
    this._escrowAttestorPubkey = Buffer.from(newEscrowAttestor);
  }

  // ---------------------------- execOwnerOp (mirror) -----------------------
  // Review-pass-1 fix: only ops 0 and 1 remain. Op 2 (setEscrowAttestor) moved
  // to execMultisigOp op 4. Op 0 (transferOwnership) requires an owner model
  // the JS mirror doesn't otherwise carry, so only op 1 is implemented.
  execOwnerOp({ op, newAuthorityPubkey }) {
    const k = Number(op);
    if (k === 1) {
      this._meterAuthorityPubkey = Buffer.from(newAuthorityPubkey);
      return;
    }
    revert('execOwnerOp: bad op');
  }

  // ---------------------------- mirror-write circuits ----------------------
  mirrorRegisterLane({ entry, laneRecord, proof }) {
    if (Number(entry.kind) !== 1) revert('MIRROR_KIND_MISMATCH');
    verifyEventProof(entry, proof, this._registryActionLogRootMirror);
    const recHash = laneActionPayloadHash(1, laneRecord);
    if (!bufEq(recHash, entry.payloadHash)) revert('EVENT_PROOF_INVALID');
    const k = laneKey(laneRecord.scheduleId, laneRecord.leviedBy, laneRecord.laneKindByte);
    this._registeredLanesMirror.set(toHex(k), {
      record: deepCopyLane(laneRecord), writeActionSeq: BigInt(proof.actionSeq),
    });
  }
  mirrorRetireLane({ entry, laneRecord, proof }) {
    if (Number(entry.kind) !== 7) revert('MIRROR_KIND_MISMATCH');
    verifyEventProof(entry, proof, this._registryActionLogRootMirror);
    const recHash = laneActionPayloadHash(7, laneRecord);
    if (!bufEq(recHash, entry.payloadHash)) revert('EVENT_PROOF_INVALID');
    const k = laneKey(laneRecord.scheduleId, laneRecord.leviedBy, laneRecord.laneKindByte);
    this._registeredLanesMirror.set(toHex(k), {
      record: deepCopyLane(laneRecord), writeActionSeq: BigInt(proof.actionSeq),
    });
  }
  mirrorScheduleLifecycle({ entry, scheduleRecord, proof }) {
    const k = Number(entry.kind);
    if (k !== 0 && k !== 3) revert('MIRROR_KIND_MISMATCH');
    verifyEventProof(entry, proof, this._registryActionLogRootMirror);
    const recHash = scheduleActionPayloadHash(k, scheduleRecord);
    if (!bufEq(recHash, entry.payloadHash)) revert('EVENT_PROOF_INVALID');
    const isLive = BigInt(scheduleRecord.retiredEpoch) === 0n;
    this._scheduleLiveMirror.set(toHex(scheduleRecord.scheduleId), isLive);
  }
  mirrorClassStatutoryTotal({ entry, scheduleId, classPath, split, rateFiatPerKwh, lastUpdatedAt, proof }) {
    if (Number(entry.kind) !== 2) revert('MIRROR_KIND_MISMATCH');
    verifyEventProof(entry, proof, this._registryActionLogRootMirror);
    const recHash = retuneActionPayloadHash(scheduleId, classPath, split, rateFiatPerKwh, lastUpdatedAt);
    if (!bufEq(recHash, entry.payloadHash)) revert('EVENT_PROOF_INVALID');
    const cKey = classKey(scheduleId, classPath);
    this._classStatutoryTotalBpsMirror.set(toHex(cKey), Number(split.statutoryTotalBps));
  }

  // ---------------------------- read helpers -------------------------------
  resolveLanesMirror({ scheduleId, leviedBys, laneKindBytes }) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const k = laneKey(scheduleId, leviedBys[i], laneKindBytes[i]);
      out.push(this._registeredLanesMirror.has(toHex(k))
        ? this._registeredLanesMirror.get(toHex(k)).record : zeroLaneRecord());
    }
    return out;
  }
  isLaneActiveMirror({ scheduleId, leviedBy, laneKindByte, epoch }) {
    const k = laneKey(scheduleId, leviedBy, laneKindByte);
    if (!this._registeredLanesMirror.has(toHex(k))) return false;
    const rec = this._registeredLanesMirror.get(toHex(k)).record;
    if (BigInt(rec.retiredEpoch) !== 0n) return false;
    const sid = toHex(scheduleId);
    if (!this._scheduleLiveMirror.has(sid)) return false;
    if (this._scheduleLiveMirror.get(sid) === false) return false;
    return BigInt(epoch) >= BigInt(rec.effectiveEpoch);
  }
  getRegistryActionLogHeadSeq() { return this._registryActionLogHeadSeqMirror; }

  // ---------------------------- per-slot settle check ----------------------
  _settleCheckSlot(m, epoch, headSeq) {
    if (!(BigInt(m.writeActionSeq) + CAL_MIRROR_STALE_TOLERANCE >= BigInt(headSeq))) {
      revert('LANE_MIRROR_STALE');
    }
    if (!(BigInt(m.record.retiredEpoch) === 0n || BigInt(m.record.retiredEpoch) > BigInt(epoch))) {
      revert('LANE_RETIRED_AT_EPOCH');
    }
    if (!(BigInt(m.record.effectiveEpoch) <= BigInt(epoch))) {
      revert('LANE_NOT_EFFECTIVE');
    }
    if (Number(m.record.remittanceMode) === 1 && bufEq(m.record.remitAddress, Buffer.alloc(32))) {
      revert('LANE_REMIT_ADDR_ZERO_ON_CHAIN');
    }
  }

  // ---------------------------- settle -------------------------------------
  settle({
    sessionID, hatPubkey, amount, producerKey, producerAddr, meterKeyHash, hatSig,
    scheduleId, classPath, epoch, fiatValueAtMint,
    leviedBys, laneKindBytes, laneAmts,
    operatorMarginBps, opsBps, ldBps, daoBps,
    producerAmt, opsAmt, divAmt, daoAmt,
    currentTime, now,
  }) {
    // 1. PRE-CONDITIONS
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('timestamp cannot be in the future');
    if (BigInt(amount) <= 0n) revert('Amount must be positive');
    if (this._settledSessions.has(toHex(sessionID))) revert('Session already settled');

    // 2. HAT VERIFICATION — I-14-A (payload binds producerAddr).
    const payloadHash = persistentHash([
      pad32(EBT_DOMAIN.HAT),
      sessionID, hatPubkey, u64ToBytes32(amount), producerKey, producerAddr,
    ]);
    if (!bufEq(hatPubkey, this._meterAuthorityPubkey)) revert('HAT signer is not the meter authority');
    if (!signatureValid(hatPubkey, payloadHash, hatSig)) revert('Bad HAT signature');

    // 3. PRODUCER ATTESTATION — I-14-G.
    const attKey = persistentHash([producerKey, meterKeyHash]);
    if (!this.producerAttestations.has(toHex(attKey))) revert('PRODUCER_NOT_ATTESTED');
    if (!this.producerAttestations.get(toHex(attKey)).active) revert('OPERATOR_DEFEDERATED');

    // 4. head tracker.
    const headSeq = this._registryActionLogHeadSeqMirror;

    // 5. SCHEDULE LIVENESS — I-14-B.
    if (!this._scheduleLiveMirror.has(toHex(scheduleId))) revert('SCHEDULE_NOT_LIVE');
    if (this._scheduleLiveMirror.get(toHex(scheduleId)) !== true) revert('SCHEDULE_NOT_LIVE');

    // 6. CLASS STATUTORY TOTAL — for I-14-K.
    const cKey = classKey(scheduleId, classPath);
    if (!this._classStatutoryTotalBpsMirror.has(toHex(cKey))) revert('CLASS_NOT_LIVE');
    const statutoryTotalBps = BigInt(this._classStatutoryTotalBpsMirror.get(toHex(cKey)));

    // 7. FIAT SANITY BAND — CAL-2.
    if (BigInt(fiatValueAtMint) < CAL_2_FIAT_FLOOR) revert('FIAT_VALUE_OUT_OF_BAND');
    if (BigInt(fiatValueAtMint) > CAL_2_FIAT_CEIL) revert('FIAT_VALUE_OUT_OF_BAND');

    // 8. LANE RESOLUTION.
    const keys = [0, 1, 2, 3].map(i => laneKey(scheduleId, leviedBys[i], laneKindBytes[i]));
    const ms = keys.map(k => this._registeredLanesMirror.has(toHex(k))
      ? this._registeredLanesMirror.get(toHex(k))
      : { record: zeroLaneRecord(), writeActionSeq: 0n });
    const zeroBuf = Buffer.alloc(32);
    const pop = ms.map(m => !bufEq(m.record.scheduleId, zeroBuf));

    // 9. DEDUP — I-14-J.
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (pop[i] && pop[j] && bufEq(keys[i], keys[j])) revert('LANE_DUP_KEY');
      }
    }

    // 10. PER-SLOT FRESHNESS + LIVENESS + REMIT GUARD.
    for (let i = 0; i < 4; i++) if (pop[i]) this._settleCheckSlot(ms[i], epoch, headSeq);

    // 11. STATUTORY SUM + OVERFLOW — I-14-K / I-14-I.
    let statutorySum = 0n, populatedCount = 0n;
    for (let i = 0; i < 4; i++) {
      if (pop[i]) { statutorySum += BigInt(ms[i].record.bpsShare); populatedCount += 1n; }
    }
    if (populatedCount === 4n && statutorySum < statutoryTotalBps) revert('SCHEDULE_LANE_OVERFLOW');
    if (statutorySum !== statutoryTotalBps) revert('LANE_SUM_MISMATCH');

    // 12. WHOLE-CLASS 10000 — I-14-C.
    const whole = BigInt(operatorMarginBps) + BigInt(opsBps) + BigInt(ldBps)
                + BigInt(daoBps) + statutoryTotalBps;
    if (whole !== 10000n) revert('WHOLE_CLASS_SUM_MISMATCH');

    // 13. SLICE POLICY.
    assertSliceOnPolicy(producerAmt, amount, operatorMarginBps);
    assertSliceOnPolicy(opsAmt, amount, opsBps);
    assertSliceOnPolicy(divAmt, amount, ldBps);
    assertSliceOnPolicy(daoAmt, amount, daoBps);
    for (let i = 0; i < 4; i++) {
      if (pop[i]) assertSliceOnPolicy(laneAmts[i], amount, ms[i].record.bpsShare);
      else if (BigInt(laneAmts[i]) !== 0n) revert('lane amount on empty slot');
    }

    // 14. AMOUNT SUM.
    let sumAll = BigInt(producerAmt) + BigInt(opsAmt) + BigInt(divAmt) + BigInt(daoAmt);
    for (let i = 0; i < 4; i++) sumAll += BigInt(laneAmts[i]);
    if (sumAll !== BigInt(amount)) revert('slice sum mismatch');

    // 15. MINT.
    this._mint(BigInt(producerAmt), producerAddr);
    for (let i = 0; i < 4; i++) {
      if (pop[i] && Number(ms[i].record.remittanceMode) === 1) {
        this._mint(BigInt(laneAmts[i]), ms[i].record.remitAddress);
      }
    }
    this._pendingOps += BigInt(opsAmt);
    this._pendingDiv += BigInt(divAmt);
    this._pendingDao += BigInt(daoAmt);

    // 16. STATE + per-coin tariff-path event.
    this._totalSupply += BigInt(amount);
    this._settledSessions.add(toHex(sessionID));
    const seq = this.settlementCount;
    this._settleLog.set(seq, {
      sessionID: Buffer.from(sessionID),
      scheduleId: Buffer.from(scheduleId),
      classPath: Buffer.from(classPath),
      epoch: BigInt(epoch),
      fiatValueAtMint: BigInt(fiatValueAtMint),
      producerAddr: Buffer.from(producerAddr),
      amount: BigInt(amount),
    });
    this.settlementCount += 1n;
  }

  // ---------------------------- claimSplit (LD binding preserved) ----------
  claimSplit({ kind, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('timestamp cannot be in the future');
    const k = Number(kind);
    if (k === 0) {
      if (this._pendingOps <= 0n) revert('No pending ops split');
      this._mint(this._pendingOps, this._operationsRecipient);
      this._pendingOps = 0n;
    } else if (k === 1) {
      if (this._pendingDiv <= 0n) revert('No pending dividend split');
      const divAmount = this._pendingDiv;
      this._mint(divAmount, this._dividendRecipient);
      this._pendingDiv = 0n;
      if (this._livingDividendAddress) {
        const seq = this._dividendEventSeq;
        const seqBytes = u64ToBytes32(seq);
        const salt = persistentHash([pad32(EBT_DOMAIN.DIVIDEND_SALT), this.self, seqBytes]);
        this._dividendMintedLog.set(seq, {
          sourceTxSalt: salt,
          amount: divAmount,
          recipient: Buffer.from(this._livingDividendAddress),
          blockTime: BigInt(currentTime),
          epochColor: pad32(EBT_DOMAIN.COLOR),
        });
        this._dividendEventSeq += 1n;
      }
    } else if (k === 2) {
      if (this._pendingDao <= 0n) revert('No pending dao split');
      this._mint(this._pendingDao, this._daoRecipient);
      this._pendingDao = 0n;
    } else {
      revert('Bad split kind');
    }
    this._splitClaimCount += 1n;
  }

  // ---------------------------- redeem -------------------------------------
  redeem({
    amount, redeemer, payoutRef, redemptionKind, tariffPath,
    attestedTrustFloat, attestedOutstandingEbt, attestationEpoch, attestationSig,
    currentTime, now,
  }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('timestamp cannot be in the future');
    if (BigInt(amount) <= 0n) revert('Must redeem > 0');
    const rk = Number(redemptionKind);
    if (rk !== REDEMPTION_KES && rk !== REDEMPTION_KWH) revert('bad redemption kind');
    if (this._poolBalance < BigInt(amount)) revert('INSUFFICIENT_BALANCE');

    if (BigInt(tariffPath.fiatValueAtMint) < CAL_2_FIAT_FLOOR) revert('FIAT_VALUE_OUT_OF_BAND');
    if (BigInt(tariffPath.fiatValueAtMint) > CAL_2_FIAT_CEIL) revert('FIAT_VALUE_OUT_OF_BAND');

    if (rk === REDEMPTION_KES) {
      const attHash = persistentHash([
        pad32(EBT_DOMAIN.ESCROW),
        u64ToBytes32(attestedTrustFloat),
        u64ToBytes32(attestedOutstandingEbt),
        u64ToBytes32(attestationEpoch),
      ]);
      if (!signatureValid(this._escrowAttestorPubkey, attHash, attestationSig)) {
        revert('ESCROW_ATTESTATION_SIG_INVALID');
      }
      if (!(BigInt(attestationEpoch) + CAL_ESCROW_STALE_TOLERANCE >= BigInt(currentTime))) {
        revert('ESCROW_ATTESTATION_STALE');
      }
      const kesObligation = BigInt(amount) * BigInt(tariffPath.fiatValueAtMint);
      const required = BigInt(attestedOutstandingEbt) + kesObligation;
      if (!(BigInt(attestedTrustFloat) >= required)) revert('SOLVENCY_GUARD_FAILED');
    }

    this._poolBalance -= BigInt(amount);
    this._totalSupply -= BigInt(amount);
    this._totalRedeemed += BigInt(amount);

    const entry = {
      redeemer: Buffer.from(redeemer),
      amount: BigInt(amount),
      payoutRef: Buffer.from(payoutRef),
      redeemedAt: BigInt(currentTime),
      redemptionKind: rk,
      tpScheduleId: Buffer.from(tariffPath.scheduleId),
      tpClassPath: Buffer.from(tariffPath.classPath),
      tpEpoch: BigInt(tariffPath.epoch),
      tpFiatValueAtMint: BigInt(tariffPath.fiatValueAtMint),
    };
    this._redemptionLog.set(this._redemptionCount, entry);
    this._redemptionCount += 1n;
  }

  // ---------------------------- manualReissue ------------------------------
  manualReissue({
    producerKey, producerAddr, amount, reasonCode, evidenceHash,
    sourceTariffPath, currentTime, now, authoritySig, meterKey,
  }) {
    if (BigInt(amount) <= 0n) revert('Must reissue > 0');
    if (BigInt(amount) > 1000000n) revert('Exceeds max reissue per call');
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('timestamp cannot be in the future');
    const earliest = this._lastReissueTime + 3600n;
    if (BigInt(currentTime) < earliest) revert('Reissue cooldown not elapsed');

    const msgHash = persistentHash([
      producerKey, u64ToBytes32(amount), u64ToBytes32(this.reissuanceCount),
    ]);
    const sig = authoritySig ?? (meterKey ? ed25519Sign(meterKey.privateKey, msgHash) : null);
    if (!sig || !signatureValid(this._meterAuthorityPubkey, msgHash, sig)) {
      revert('Reissue requires authority co-signature');
    }

    this._mint(BigInt(amount), producerAddr);
    this._totalSupply += BigInt(amount);

    const seq = this.reissuanceCount;
    this.reissuanceLog.set(seq, {
      producer: Buffer.from(producerKey),
      amount: BigInt(amount),
      reasonCode: Number(reasonCode),
      evidenceHash: Buffer.from(evidenceHash),
      reissuedAt: BigInt(currentTime),
      tpScheduleId: Buffer.from(sourceTariffPath.scheduleId),
      tpClassPath: Buffer.from(sourceTariffPath.classPath),
      tpEpoch: BigInt(sourceTariffPath.epoch),
      tpFiatValueAtMint: BigInt(sourceTariffPath.fiatValueAtMint),
    });
    this.reissuanceCount += 1n;
    this._lastReissueTime = BigInt(currentTime);
  }
}

// =============================================================================
// Registry-driving helpers — replicate the WI-13.2 keeper's event stream on a
// real TariffRegistry instance, capturing per-event data (seq + record) needed
// to build EventProofs for the EBT mirror. Every event is pushed to fx.events.
// =============================================================================

function approve(registry, actionHash) { registry.approveByFederation(actionHash); }

export function doRegisterSchedule(fx, { nodeId, scheduleHash, effectiveEpoch, currentTime, refRate } = {}) {
  const { registry, opKey, validatorKey, charteredNodes, charterTree } = fx;
  nodeId = nodeId ?? charteredNodes[0];
  scheduleHash = scheduleHash ?? randomBytes(32);
  effectiveEpoch = effectiveEpoch ?? (registry._currentEpoch + 1n);
  currentTime = currentTime ?? 1_000_000n;
  refRate = refRate ?? 100n;
  const actionHash = persistentHash([
    pad32(R.DOMAIN.REGISTER_SCHEDULE), registry.self, nodeId, scheduleHash,
    u64ToBytes32(effectiveEpoch), registry.currentEpochBytes(),
  ]);
  approve(registry, actionHash);
  const validatorSignature = ed25519Sign(validatorKey.privateKey, actionHash);
  const charterProof = charterTree.proofsByNodeId.get(toHex(nodeId));
  const seq = registry._actionSeq;
  const res = registry.registerSchedule({
    nodeId, scheduleHash, operatorPubkey: opKey.pubkeyBytes,
    refRateFiatPerKwh: refRate, effectiveEpoch,
    validatorAttestor: validatorKey.pubkeyBytes, validatorSignature,
    currentTime, charterProof, now: currentTime,
  });
  fx.events.push({
    seq, kind: 0,
    schedRecord: deepCopySchedule(registry._registeredSchedules.get(toHex(res.scheduleId))),
  });
  return { scheduleId: res.scheduleId, refRate, seq };
}

export function doAdvanceEpoch(fx, currentTime, refRate = 100n) {
  const { registry } = fx;
  const from = registry._currentEpoch;
  const to = from + 1n;
  const ah = persistentHash([pad32(R.DOMAIN.ADVANCE_EPOCH), registry.self,
    u64ToBytes32(from), u64ToBytes32(to), u64ToBytes32(refRate), registry._governanceRoot]);
  approve(registry, ah);
  const seq = registry._actionSeq;
  registry.advanceEpoch({ newEpoch: to, newRefRateFiatPerKwh: refRate,
    newGovernanceRoot: registry._governanceRoot, currentTime, now: currentTime });
  fx.events.push({ seq, kind: 4 });
}

export function doRetuneClass(fx, { scheduleId, classPath, split, rate, nonceIn, currentTime }) {
  const { registry, opKey } = fx;
  const shHash = persistentHash([
    pad32(R.DOMAIN.SPLIT_SHARES),
    u16ToBytes32(split.producerShareBps), u16ToBytes32(split.ldShareBps),
    u16ToBytes32(split.opsShareBps), u16ToBytes32(split.daoShareBps),
    u16ToBytes32(split.operatorMarginBps), u16ToBytes32(split.statutoryTotalBps),
  ]);
  const authHash = persistentHash([
    pad32(R.DOMAIN.RETUNE_CLASS), registry.self, scheduleId, classPath, shHash,
    u64ToBytes32(rate), registry.currentEpochBytes(), u64ToBytes32(nonceIn),
    u64ToBytes32(currentTime),
  ]);
  const signature = ed25519Sign(opKey.privateKey, authHash);
  const seq = registry._actionSeq;
  registry.retuneClass({
    scheduleId, classPath, newSplitBps: split, newRateFiatPerKwh: rate,
    operatorId: opKey.pubkeyBytes, operatorSignature: signature,
    nonceIn, currentTime, now: currentTime,
  });
  fx.events.push({
    seq, kind: 2, scheduleId: Buffer.from(scheduleId), classPath: Buffer.from(classPath),
    split: { ...split }, rate: BigInt(rate), lastUpdatedAt: BigInt(currentTime),
  });
  return { seq };
}

export function doRegisterLane(fx, {
  scheduleId, laneKindByte, leviedBy, bpsShare, effectiveEpoch, currentTime,
  remittanceMode = 1, remitAddress, basis = 0,
}) {
  const { registry, charteredNodes, charterTree } = fx;
  remitAddress = remitAddress ?? randomBytes(32);
  const applicabilityHash = randomBytes(32);
  const statuteRefHash = randomBytes(32);
  const ah = persistentHash([
    pad32(R.DOMAIN.REGISTER_LANE), registry.self, scheduleId,
    u64ToBytes32(laneKindByte), leviedBy, u16ToBytes32(bpsShare), remitAddress,
    u64ToBytes32(basis), applicabilityHash, statuteRefHash,
    u64ToBytes32(effectiveEpoch), u64ToBytes32(remittanceMode),
    registry.currentEpochBytes(), u64ToBytes32(currentTime),
  ]);
  approve(registry, ah);
  const charterProof = charterTree.proofsByNodeId.get(toHex(charteredNodes[0]));
  const seq = registry._actionSeq;
  registry.registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare, remitAddress, basis,
    applicabilityHash, statuteRefHash, effectiveEpoch, remittanceMode,
    charterProof, currentTime, now: currentTime,
  });
  const record = deepCopyLane(registry.resolveLane({ scheduleId, leviedBy, laneKindByte }));
  fx.events.push({ seq, kind: 1, record });
  return { seq, record };
}

export function doRetireLane(fx, { scheduleId, leviedBy, laneKindByte, currentTime }) {
  const { registry } = fx;
  const ah = persistentHash([
    pad32(R.DOMAIN.RETIRE_LANE), registry.self, scheduleId, leviedBy,
    u64ToBytes32(laneKindByte), registry.currentEpochBytes(), u64ToBytes32(currentTime),
  ]);
  approve(registry, ah);
  const seq = registry._actionSeq;
  registry.retireLane({ scheduleId, leviedBy, laneKindByte, currentTime, now: currentTime });
  const record = deepCopyLane(registry.resolveLane({ scheduleId, leviedBy, laneKindByte }));
  fx.events.push({ seq, kind: 7, record });
  return { seq, record };
}

export function doRetireSchedule(fx, { scheduleId, currentTime }) {
  const { registry } = fx;
  const ah = persistentHash([pad32(R.DOMAIN.RETIRE_SCHEDULE),
    registry.self, scheduleId, registry.currentEpochBytes()]);
  approve(registry, ah);
  const seq = registry._actionSeq;
  registry.retireSchedule({ scheduleId, currentTime, now: currentTime });
  fx.events.push({
    seq, kind: 3,
    schedRecord: deepCopySchedule(registry._registeredSchedules.get(toHex(scheduleId))),
  });
  return { seq };
}

// Build an EventProof for `seq` against the registry's CURRENT action-log tree.
export function buildProof(registry, seq) {
  const entry = registry.getActionEntry(BigInt(seq));
  const { siblings, pathBits } = registry._actionLogTree.proof(Number(seq));
  return { actionSeq: BigInt(seq), payloadHash: Buffer.from(entry.payloadHash), siblings, pathBits };
}

// Pick any event with a payloadHash in fx.events (registry action seq order)
// and build a { entry, proof } bundle suitable for the witness-gated
// trust-anchor setters. Returns null if the registry has no mirrorable events
// yet (which would be a test-setup bug for witness-gated warmMirror).
function pickSampleWitness(fx) {
  for (const ev of fx.events) {
    if (ev.kind === 4 || ev.kind === 5 || ev.kind === 6) continue;
    const proof = buildProof(fx.registry, ev.seq);
    const entry = fx.registry.getActionEntry(BigInt(ev.seq));
    return { entry, proof };
  }
  return null;
}

// Warm the EBT mirror from every mirrorable event in fx.events, verifying each
// EventProof against the registry's committed root. Sets the head tracker to
// the highest mirrored seq (keeper "caught up to latest"). Pass { headSeq } to
// force a specific head (e.g. staleness tests).
//
// Review-pass-1 fix: the two trust-anchor setters are witness-gated, so this
// helper installs the root using any real event's inclusion proof (the head
// advance then reuses the exact new-head event's proof).
export function warmMirror(ebt, fx, opts = {}) {
  const registry = fx.registry;
  const sample = pickSampleWitness(fx);
  if (!sample) {
    throw new Error('warmMirror: no mirrorable events in fixture; witness-gated setters need at least one real event');
  }
  ebt.mirrorActionLogRoot({
    newRoot: registry.registryActionLogRoot,
    sampleEntry: sample.entry,
    proof: sample.proof,
  });
  let maxSeq = 0n;
  let latestBundle = sample;   // fallback if no mirrorable events beyond sample
  for (const ev of fx.events) {
    if (ev.kind === 4 || ev.kind === 5 || ev.kind === 6) continue; // non-mirrored
    const proof = buildProof(registry, ev.seq);
    const entry = registry.getActionEntry(BigInt(ev.seq));
    if (ev.kind === 0 || ev.kind === 3) {
      ebt.mirrorScheduleLifecycle({ entry, scheduleRecord: ev.schedRecord, proof });
    } else if (ev.kind === 1) {
      ebt.mirrorRegisterLane({ entry, laneRecord: ev.record, proof });
    } else if (ev.kind === 7) {
      ebt.mirrorRetireLane({ entry, laneRecord: ev.record, proof });
    } else if (ev.kind === 2) {
      ebt.mirrorClassStatutoryTotal({
        entry, scheduleId: ev.scheduleId, classPath: ev.classPath,
        split: ev.split, rateFiatPerKwh: ev.rate, lastUpdatedAt: ev.lastUpdatedAt, proof,
      });
    }
    if (BigInt(ev.seq) > maxSeq) maxSeq = BigInt(ev.seq);
    latestBundle = { entry, proof };
  }
  const finalHead = opts.headSeq ?? maxSeq;
  // Head advance requires an exact witness for newHeadSeq.
  const headWitness = opts.headWitness ?? (
    opts.headSeq !== undefined
      ? {
          entry: registry.getActionEntry(BigInt(finalHead)),
          proof: buildProof(registry, BigInt(finalHead)),
        }
      : latestBundle
  );
  ebt.mirrorActionLogHead({
    newHeadSeq: finalHead,
    latestEntry: headWitness.entry,
    proof: headWitness.proof,
  });
}

// =============================================================================
// High-level fixture + scenario builders
// =============================================================================

export function nonZero32(byte = 0x11) { return Buffer.alloc(32, byte); }

export function makeEbtFixture() {
  const fx = makeFixture();       // TariffRegistry fixture (registry + keys)
  fx.events = [];
  const meterKey = newEd25519();
  const escrowKey = newEd25519();
  const ebt = new EBT({
    meterAuthorityPubkey: meterKey.pubkeyBytes,
    multisigAuthority: randomBytes(32),
    operationsRecipient: nonZero32(0x21),
    dividendRecipient: nonZero32(0x22),
    daoRecipient: nonZero32(0x23),
    escrowAttestorPubkey: escrowKey.pubkeyBytes,
    registryActionLogRoot: fx.registry.registryActionLogRoot,
    self: randomBytes(32),
  });
  const producerKey = randomBytes(32);
  const meterKeyHash = randomBytes(32);
  const producerAddr = nonZero32(0x31);
  return { fx, ebt, meterKey, escrowKey, producerKey, meterKeyHash, producerAddr };
}

// Sign a v8 HAT payload (mirror of the .compact 6-field persistentHash).
export function signHat(meterKey, { sessionID, hatPubkey, amount, producerKey, producerAddr }) {
  const payloadHash = persistentHash([
    pad32(EBT_DOMAIN.HAT), sessionID, hatPubkey, u64ToBytes32(amount), producerKey, producerAddr,
  ]);
  return ed25519Sign(meterKey.privateKey, payloadHash);
}

export function makeEscrowAttestation(escrowKey, { attestedTrustFloat, attestedOutstandingEbt, attestationEpoch }) {
  const attHash = persistentHash([
    pad32(EBT_DOMAIN.ESCROW),
    u64ToBytes32(attestedTrustFloat), u64ToBytes32(attestedOutstandingEbt), u64ToBytes32(attestationEpoch),
  ]);
  return ed25519Sign(escrowKey.privateKey, attHash);
}

// A statutory split whose statutoryTotalBps equals the lanes' bps sum, floors
// respected (ld>=200, ops>=2000, sum 10000). Used by retuneClass.
export function statutorySplit(statutoryTotalBps) {
  const s = Number(statutoryTotalBps);
  const rest = 10000 - s;                // must be >= 0
  // ld 500, ops 2500 (>= floors), dao 500; producer absorbs the remainder.
  const producer = rest - 500 - 2500 - 500;
  return {
    producerShareBps: producer,
    ldShareBps: 500,
    opsShareBps: 2500,
    daoShareBps: 500,
    operatorMarginBps: 0,
    statutoryTotalBps: s,
  };
}

// Build a standard live 4-lane (Kenya-style) scenario and a fully-warmed EBT
// mirror. Returns everything settle() needs. `lanes` overrides let negative
// tests perturb specific slots. Registry event order keeps lanes last so their
// writeActionSeq is within CAL-vNext-M1 of the head.
//
//   opts.lanes: array of { laneKindByte, leviedBy, bpsShare, remittanceMode,
//                          remitAddress, effectiveEpoch }
//   opts.attest: default true (attest the producer).
export function buildScenario(opts = {}) {
  const f = makeEbtFixture();
  const { fx, ebt, meterKey, producerKey, meterKeyHash, producerAddr } = f;
  const classPath = opts.classPath ?? randomBytes(32);

  const lanes = opts.lanes ?? [
    { laneKindByte: 0, leviedBy: nonZero32(0x41), bpsShare: 250, remittanceMode: 1, remitAddress: nonZero32(0x51) },
    { laneKindByte: 1, leviedBy: nonZero32(0x42), bpsShare: 250, remittanceMode: 1, remitAddress: nonZero32(0x52) },
    { laneKindByte: 2, leviedBy: nonZero32(0x43), bpsShare: 250, remittanceMode: 1, remitAddress: nonZero32(0x53) },
    { laneKindByte: 3, leviedBy: nonZero32(0x44), bpsShare: 250, remittanceMode: 1, remitAddress: nonZero32(0x54) },
  ];
  const laneBpsSum = lanes.reduce((a, l) => a + Number(l.bpsShare), 0);
  // Class statutory total defaults to the lane bps sum (I-14-K holds); negative
  // tests (T07) override it so lane sum != class total -> LANE_SUM_MISMATCH.
  const classStatutoryTotalBps = opts.classStatutoryTotalBps ?? laneBpsSum;

  // Registry event stream (schedule, retune=class-total, advance, then lanes).
  const { scheduleId, refRate } = doRegisterSchedule(fx, { effectiveEpoch: 1n, currentTime: 1_000_000n });
  doRetuneClass(fx, {
    scheduleId, classPath, split: statutorySplit(classStatutoryTotalBps),
    rate: refRate, nonceIn: 1n, currentTime: 1_000_100n,
  });
  doAdvanceEpoch(fx, 1_500_000n, refRate);   // currentEpoch -> 1
  let t = 1_500_100n;
  for (const l of lanes) {
    doRegisterLane(fx, {
      scheduleId, laneKindByte: l.laneKindByte, leviedBy: l.leviedBy,
      bpsShare: l.bpsShare, effectiveEpoch: l.effectiveEpoch ?? 2n, currentTime: t,
      remittanceMode: l.remittanceMode, remitAddress: l.remitAddress,
    });
    t += 100n;
  }

  warmMirror(ebt, fx, opts.warm);

  if (opts.attest !== false) {
    ebt.attest({ producerKey, meterKeyHash, currentTime: 900_000n });
  }

  return {
    ...f, scheduleId, classPath, refRate, lanes, laneBpsSum,
    classStatutoryTotalBps,
    epoch: opts.epoch ?? 2n,
  };
}

// Assert that `fn` throws a Revert whose message matches `expected` (string ==
// substring, or RegExp). Returns the caught error for further inspection.
export function assertReverts(fn, expected) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  if (!threw) throw new Error(`expected revert ${expected}, but no throw`);
  const msg = String(threw.message ?? threw);
  const ok = expected instanceof RegExp ? expected.test(msg) : msg.includes(expected);
  if (!ok) throw new Error(`expected revert matching ${expected}, got: ${msg}`);
  return threw;
}

// Build a full settle() argument bundle for a scenario. Non-statutory bps
// default to summing to (10000 - laneBpsSum); amount defaults to 10000 so each
// slice amount equals its bps exactly. Overridable for negative tests.
export function buildSettleArgs(sc, over = {}) {
  const amount = over.amount ?? 10000n;
  const nonStatutory = 10000 - sc.laneBpsSum;
  // ld 700, ops 2000, dao 300, remainder -> operatorMargin (producer).
  const ldBps = over.ldBps ?? 700;
  const opsBps = over.opsBps ?? 2000;
  const daoBps = over.daoBps ?? 300;
  const operatorMarginBps = over.operatorMarginBps ?? (nonStatutory - ldBps - opsBps - daoBps);

  // Request vectors are always 4 slots wide; scenarios with fewer lanes pad the
  // remainder with the empty-slot sentinel (zero leviedBy / zero amount).
  const pad4 = (arr, filler) => { const a = arr.slice(0, 4); while (a.length < 4) a.push(filler); return a; };
  const leviedBys = pad4(over.leviedBys ?? sc.lanes.map(l => l.leviedBy), Buffer.alloc(32));
  const laneKindBytes = pad4(over.laneKindBytes ?? sc.lanes.map(l => l.laneKindByte), 0);
  const laneAmts = pad4(over.laneAmts ?? sc.lanes.map(l => (BigInt(amount) * BigInt(l.bpsShare)) / 10000n), 0n);

  const producerAmt = over.producerAmt ?? (BigInt(amount) * BigInt(operatorMarginBps)) / 10000n;
  const opsAmt = over.opsAmt ?? (BigInt(amount) * BigInt(opsBps)) / 10000n;
  const divAmt = over.divAmt ?? (BigInt(amount) * BigInt(ldBps)) / 10000n;
  const daoAmt = over.daoAmt ?? (BigInt(amount) * BigInt(daoBps)) / 10000n;

  const sessionID = over.sessionID ?? randomBytes(32);
  const fiatValueAtMint = over.fiatValueAtMint ?? 100n;
  const producerAddr = over.producerAddr ?? sc.producerAddr;
  const hatPubkey = over.hatPubkey ?? sc.meterKey.pubkeyBytes;
  const producerKey = over.producerKey ?? sc.producerKey;

  // HAT signature over the ACTUAL bound values (unless a raw hatSig override).
  const hatSig = over.hatSig ?? signHat(sc.meterKey, {
    sessionID, hatPubkey, amount, producerKey,
    producerAddr: over.signedProducerAddr ?? producerAddr,
  });

  return {
    sessionID, hatPubkey, amount, producerKey, producerAddr,
    meterKeyHash: over.meterKeyHash ?? sc.meterKeyHash, hatSig,
    scheduleId: over.scheduleId ?? sc.scheduleId,
    classPath: over.classPath ?? sc.classPath,
    epoch: over.epoch ?? sc.epoch,
    fiatValueAtMint,
    leviedBys, laneKindBytes, laneAmts,
    operatorMarginBps, opsBps, ldBps, daoBps,
    producerAmt, opsAmt, divAmt, daoAmt,
    currentTime: over.currentTime ?? 2_000_000n,
  };
}
