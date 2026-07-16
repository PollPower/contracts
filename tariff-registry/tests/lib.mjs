// tariff-registry/tests/lib.mjs
// -----------------------------------------------------------------------------
// Offline JS mirror of tariff-registry-v1.compact. Same shape, same domain
// tags, same field order, same revert-message strings. The .compact contract
// is the ground truth for on-chain behavior; this file lets the offline smoke
// suite exercise the invariants (T1..T7 + T3.5 + F-4 + F-7a/b + R-A/B/C)
// without a live chain.
//
// Mirroring convention (matches multisig/tooling/sortition-table/lib.mjs):
//
//   - Every persistentHash<Vector<N, Bytes<32>>>([...]) is reproduced as an
//     SHA-256 over the concatenation of the exact same field bytes.
//   - Every "as Uint<N>" checked-cast is emulated as a JS bigint bounds check
//     that throws a REVERT with the same message string on failure.
//   - Every witness (multisig_signature_valid, signature_valid,
//     charter_membership_proof, witness_divmod) is a JS function that the
//     test harness provides; the contract's assert(disclose(witness(...)))
//     is emulated by "throw REVERT if the JS witness returns false or bad
//     data".
//
// See ../V1-DESIGN.md and the WI-13 dispatch memo for the invariants.
// -----------------------------------------------------------------------------

import { createHash, sign, verify, generateKeyPairSync, randomBytes } from 'node:crypto';

// ------------------------------ constants ------------------------------------

export const CHARTER_DEPTH = 12;
export const RETUNE_MIN_INTERVAL_S = 60n;
// WI-13.1: max statutory lane count per TARIFF-SCHEDULE-MODEL §9.
export const MAX_STATUTORY_LANES = 4;

// Domain tags (byte-for-byte identical to .compact strings).
export const DOMAIN = Object.freeze({
  REGISTER_SCHEDULE: 'pp:tariff:v1:registerSchedule',
  RETIRE_SCHEDULE:   'pp:tariff:v1:retireSchedule',
  RETUNE_CLASS:      'pp:tariff:v1:retuneClass',
  RETUNE_NONCE:      'pp:tariff:v1:retuneNonce',
  RETUNE_COOLDOWN:   'pp:tariff:v1:retuneCooldown',
  ADVANCE_EPOCH:     'pp:tariff:v1:advanceEpoch',
  SET_NATL_CTX:      'pp:tariff:v1:setNationalContext',
  ROTATE_AUTH:       'pp:tariff:v1:rotateAuth',
  SCHEDULE_ID:       'pp:tariff:v1:scheduleId',
  CLASS_SPLIT_KEY:   'pp:tariff:v1:classSplitKey',
  SPLIT_SHARES:      'pp:tariff:v1:splitShares',
  CHARTER_LEAF:      'pp:fed:charter:leaf',
  CHARTER_NODE:      'pp:fed:charter:node',
  // WI-13.1 lane domains
  LANE_KEY:          'pp:tariff:v1:laneKey',
  REGISTER_LANE:     'pp:tariff:v1:registerLane',
  RETIRE_LANE:       'pp:tariff:v1:retireLane',
});

// Calibration values from CALIBRATION-DECISIONS-RESOLVED-2026-07-14.md.
export const CAL = Object.freeze({
  LD_FLOOR_BPS: 200,
  OPS_FLOOR_BPS: 2000,
  SANITY_BAND_PCT: 20,
});

// ------------------------------ REVERT helper -------------------------------

export class Revert extends Error {
  constructor(message) {
    super(message);
    this.name = 'Revert';
  }
}

function revert(message) { throw new Revert(message); }

// Checked-cast to Uint<N> (bigint bounds). Reverts with `message` on underflow.
function asUintChecked(value, bits, message) {
  const v = BigInt(value);
  if (v < 0n) revert(message);
  const max = (1n << BigInt(bits)) - 1n;
  if (v > max) revert(message);
  return v;
}

// ------------------------------ byte helpers ---------------------------------

// pad(32, str) in Compact = str utf8 bytes, right-padded to 32 with 0x00.
export function pad32(str) {
  const buf = Buffer.alloc(32);
  const src = Buffer.from(str, 'utf8');
  if (src.length > 32) throw new Error(`pad32: string too long: ${str}`);
  src.copy(buf, 0);
  return buf;
}

// Uint -> Bytes<32> big-endian (matches "(x as Field) as Bytes<32>" convention).
export function u64ToBytes32(u) {
  const v = BigInt(u);
  if (v < 0n) throw new Error('u64ToBytes32: negative');
  const buf = Buffer.alloc(32);
  buf.writeBigUInt64BE(v & 0xFFFFFFFFFFFFFFFFn, 24); // low 8 bytes
  return buf;
}
export const u16ToBytes32 = u64ToBytes32;
export const u128ToBytes32 = (u) => {
  const v = BigInt(u);
  const buf = Buffer.alloc(32);
  // high 8 bytes -> offset 8, low 8 bytes -> offset 16 (big-endian 128-bit)
  buf.writeBigUInt64BE((v >> 64n) & 0xFFFFFFFFFFFFFFFFn, 8);
  buf.writeBigUInt64BE(v & 0xFFFFFFFFFFFFFFFFn, 16);
  return buf;
};

// persistentHash<Vector<N, Bytes<32>>>([...]) = SHA-256(concat).
export function persistentHash(parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (!Buffer.isBuffer(p)) throw new Error('persistentHash: non-Buffer input');
    if (p.length !== 32) throw new Error(`persistentHash: expected 32 bytes, got ${p.length}`);
    h.update(p);
  }
  return h.digest();
}
// persistentHash<Bytes<32>>(x) = SHA-256(x). Used for domain-string hashing.
export function persistentHashSingle(buf) {
  return createHash('sha256').update(buf).digest();
}

export function toHex(b) { return Buffer.isBuffer(b) ? b.toString('hex') : Buffer.from(b).toString('hex'); }
export function fromHex(s) { return Buffer.from(s.replace(/^0x/, ''), 'hex'); }
export function bufEq(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && a.equals(b); }

// ------------------------------ Ed25519 --------------------------------------
// Node's built-in Ed25519. Public keys are 32 bytes, sigs 64 bytes.

export function newEd25519() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey,
    privateKey,
    pubkeyBytes: publicKey.export({ type: 'spki', format: 'der' }).slice(-32), // DER Ed25519 pubkey ends with 32-byte raw pubkey
    sign(msg) {
      // Node's sign for Ed25519: signature is 64 bytes, algorithm=null.
      return sign(null, msg, privateKey);
    },
    verify(msg, sig) {
      return verify(null, msg, publicKey, sig);
    },
  };
}

// signature_valid witness — Node-native Ed25519 verify from raw 32-byte pubkey.
// (Real contract's witness verifies via off-chain prover; here we do it directly.)
import { createPublicKey } from 'node:crypto';
function pubkeyFromRawBytes(raw32) {
  // Wrap raw 32-byte Ed25519 pubkey into SPKI DER:
  // 302a300506032b6570032100 || pubkey
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw32,
  ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
export function signatureValid(pubkeyBytes, messageHash, signature) {
  try {
    const pk = pubkeyFromRawBytes(pubkeyBytes);
    return verify(null, messageHash, pk, signature);
  } catch { return false; }
}
export function ed25519Sign(privateKey, message) {
  return sign(null, message, privateKey);
}

// ------------------------------ Merkle charter proofs ------------------------

// Build a fixed-depth Merkle tree over 32-byte leaves. Padding uses a
// sentinel that hashes DIFFERENTLY from any real leaf.
export function buildCharterTree(nodeIds) {
  if (nodeIds.length > (1 << CHARTER_DEPTH)) {
    throw new Error('charter tree: too many nodes');
  }
  const leafHash = (nodeId) => persistentHash([pad32(DOMAIN.CHARTER_LEAF), nodeId]);
  const padHash = persistentHashSingle(pad32(DOMAIN.CHARTER_LEAF + ':pad'));
  const pairHash = (l, r) => persistentHash([pad32(DOMAIN.CHARTER_NODE), l, r]);

  // Compute per-leaf hashes.
  const leaves = nodeIds.map(leafHash);
  while (leaves.length < (1 << CHARTER_DEPTH)) leaves.push(padHash);

  // Build up.
  const levels = [leaves];
  for (let d = 0; d < CHARTER_DEPTH; d++) {
    const cur = levels[d];
    const nxt = [];
    for (let i = 0; i < cur.length; i += 2) {
      nxt.push(pairHash(cur[i], cur[i + 1]));
    }
    levels.push(nxt);
  }
  const root = levels[CHARTER_DEPTH][0];

  // For each real leaf position, produce a proof (siblings + indices).
  const proofsByNodeId = new Map();
  for (let i = 0; i < nodeIds.length; i++) {
    const siblings = [];
    const indices = [];
    let idx = i;
    for (let d = 0; d < CHARTER_DEPTH; d++) {
      const sibIdx = idx ^ 1;
      siblings.push(levels[d][sibIdx]);
      indices.push((idx & 1) === 1); // true = we are RIGHT, sibling is LEFT
      idx = idx >> 1;
    }
    proofsByNodeId.set(toHex(nodeIds[i]), { siblings, indices });
  }

  return { root, proofsByNodeId, leaves, levels };
}

// Reconstruct root from (nodeId, proof) — mirrors assertCharterMembership().
export function reconstructCharterRoot(nodeId, proof) {
  const pairDomain = pad32(DOMAIN.CHARTER_NODE);
  let h = persistentHash([pad32(DOMAIN.CHARTER_LEAF), nodeId]);
  for (let d = 0; d < CHARTER_DEPTH; d++) {
    const sib = proof.siblings[d];
    const idx = proof.indices[d];
    h = idx
      ? persistentHash([pairDomain, sib, h])   // we are RIGHT
      : persistentHash([pairDomain, h, sib]);  // we are LEFT
  }
  return h;
}

// ------------------------------ SplitShares ----------------------------------

export function splitSharesHash(s) {
  return persistentHash([
    pad32(DOMAIN.SPLIT_SHARES),
    u16ToBytes32(s.producerShareBps),
    u16ToBytes32(s.ldShareBps),
    u16ToBytes32(s.opsShareBps),
    u16ToBytes32(s.daoShareBps),
    u16ToBytes32(s.operatorMarginBps),
    u16ToBytes32(s.statutoryTotalBps),
  ]);
}

export function sumSplit(s) {
  return BigInt(s.producerShareBps)
       + BigInt(s.ldShareBps)
       + BigInt(s.opsShareBps)
       + BigInt(s.daoShareBps)
       + BigInt(s.operatorMarginBps)
       + BigInt(s.statutoryTotalBps);
}

// ------------------------------ WI-13.1 Lane helpers -------------------------

// Composite key for a lane record (scheduleId + laneKindByte).
export function laneKey(scheduleId, laneKindByte) {
  const kindBytes = u64ToBytes32(BigInt(laneKindByte));
  return persistentHash([
    pad32(DOMAIN.LANE_KEY),
    scheduleId,
    kindBytes,
  ]);
}

// Zero LaneRecord (for unpopulated resolveLanes slots).
export function zeroLaneRecord() {
  return {
    scheduleId:        Buffer.alloc(32),
    laneKindByte:      0,
    leviedBy:          Buffer.alloc(32),
    bpsShare:          0,
    remitAddress:      Buffer.alloc(32),
    basis:             0,
    applicabilityHash: Buffer.alloc(32),
    statuteRefHash:    Buffer.alloc(32),
    effectiveEpoch:    0n,
    retiredEpoch:      0n,
    remittanceMode:    0,
    registeredAt:      0n,
  };
}

// ------------------------------ contract state -------------------------------

// The registry state. Mirror of the ledger fields.
export class TariffRegistry {
  constructor({ federationAuthority, governanceRoot, refRateFiatPerKwh, self }) {
    // Self-address (32 bytes) — mirrors kernel.self().bytes.
    this.self = Buffer.isBuffer(self) ? self : randomBytes(32);
    // Ledger fields (constructor-set).
    this._initialized = true;
    this._federationAuthority = Buffer.from(federationAuthority);
    this._governanceRoot = Buffer.from(governanceRoot);
    this._refRateFiatPerKwh = BigInt(refRateFiatPerKwh);
    // Calibration ledger fields.
    this._LD_FLOOR_BPS = CAL.LD_FLOOR_BPS;
    this._OPS_FLOOR_BPS = CAL.OPS_FLOOR_BPS;
    this._SANITY_BAND_PCT = CAL.SANITY_BAND_PCT;
    this._pendingLDFloorBps = 0;
    this._pendingOpsFloorBps = 0;
    this._pendingSanityBandPct = 0;
    this._hasPendingContext = false;
    this._currentEpoch = 0n;
    // Maps.
    this._registeredSchedules = new Map();   // scheduleIdHex -> ScheduleRecord
    this._activeScheduleByNode = new Map();  // nodeIdHex -> scheduleIdHex
    this._classEntries = new Map();          // splitKeyHex -> ClassEntry
    this._retuneNonces = new Map();          // nonceKeyHex -> Uint64
    this._retuneLastTime = new Map();        // cdKeyHex -> Uint64
    this._consumedFederationApprovals = new Set(); // hex actionHashes
    // WI-13.1: lane records.
    this._registeredLanes = new Map();       // laneKeyHex -> LaneRecord
    // Event log.
    this._actionLog = new Map();             // seq -> RegistryActionEntry
    this._actionSeq = 0n;
    // Witness surface.
    this._witnesses = {
      // Default multisig witness: returns true iff the approval bundle was
      // registered UNDER THE CURRENT AUTHORITY (i.e. the msfed council whose
      // hash matches the passed authorityHash param). This mirrors real
      // multisig_signature_valid: the off-chain prover reconstructs the
      // bundle for a specific authorityHash, and the contract asserts the
      // returned Boolean.
      multisig_signature_valid: (payload, authorityHash) => {
        const boundAuth = this._multisigApprovals.get(toHex(payload));
        if (!boundAuth) return false;
        return bufEq(boundAuth, authorityHash);
      },
    };
    // Off-chain multisig bundle store — tests call approveByFederation to
    // simulate the msfed council approving `actionHash` under the current
    // federation authority. Maps hex actionHash → the authorityHash the
    // bundle was signed against (Buffer).
    this._multisigApprovals = new Map();
  }

  // Record an off-chain msfed bundle for `actionHash`, bound to the CURRENT
  // federation authority. F-4 tests can force a mismatch by rotating
  // _federationAuthority after granting the approval.
  approveByFederation(actionHash, authorityHash) {
    const auth = authorityHash ?? this._federationAuthority;
    this._multisigApprovals.set(toHex(actionHash), Buffer.from(auth));
  }
  isApproved(actionHash) {
    return this._multisigApprovals.has(toHex(actionHash));
  }

  currentEpochBytes() { return u64ToBytes32(this._currentEpoch); }

  // ---- helper: retune nonce key --------------------------------------------
  retuneNonceKey(operatorId, scheduleId) {
    return persistentHash([
      pad32(DOMAIN.RETUNE_NONCE),
      operatorId,
      scheduleId,
      this.currentEpochBytes(),
    ]);
  }
  retuneCooldownKey(operatorId, scheduleId, classPath) {
    return persistentHash([
      pad32(DOMAIN.RETUNE_COOLDOWN),
      operatorId,
      scheduleId,
      classPath,
    ]);
  }
  classSplitKey(scheduleId, classPath) {
    return persistentHash([
      pad32(DOMAIN.CLASS_SPLIT_KEY),
      scheduleId,
      classPath,
    ]);
  }

  // ---- charter check --------------------------------------------------------
  assertCharterMembership(nodeId, proof) {
    const root = reconstructCharterRoot(nodeId, proof);
    if (!bufEq(root, this._governanceRoot)) revert('SCHEDULE_UNCHARTERED_NODE');
  }

  // ---- consume federation approval -----------------------------------------
  consumeFederationApproval(actionHash) {
    if (this._consumedFederationApprovals.has(toHex(actionHash))) {
      revert('FEDERATION_APPROVAL_REPLAYED');
    }
    if (!this._witnesses.multisig_signature_valid(actionHash, this._federationAuthority)) {
      revert('FEDERATION_APPROVAL_INVALID');
    }
    this._consumedFederationApprovals.add(toHex(actionHash));
  }

  emitAction(kind, scheduleId, nodeId, actionHash, currentTime) {
    const entry = {
      kind,
      scheduleId: Buffer.from(scheduleId),
      nodeId: Buffer.from(nodeId),
      epoch: this._currentEpoch,
      actionHash: Buffer.from(actionHash),
      emittedAt: BigInt(currentTime),
    };
    this._actionLog.set(this._actionSeq, entry);
    this._actionSeq += 1n;
  }

  // -------------------------- registerSchedule ------------------------------
  registerSchedule({
    nodeId, scheduleHash, operatorPubkey, refRateFiatPerKwh,
    effectiveEpoch, validatorAttestor, validatorSignature, currentTime,
    charterProof,
    now,       // simulate blockTime; must be >= currentTime for L-3.
  }) {
    // L-3: blockTimeGte(currentTime).
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('registerSchedule: timestamp cannot be in the future');
    // R-A charter proof.
    this.assertCharterMembership(nodeId, charterProof);
    // I-4: effectiveEpoch > currentEpoch.
    asUintChecked(BigInt(effectiveEpoch) - this._currentEpoch - 1n, 64, 'EFFECTIVE_EPOCH_NOT_FUTURE');

    const currentEpochBytes = this.currentEpochBytes();
    const effectiveEpochBytes = u64ToBytes32(effectiveEpoch);
    const actionHash = persistentHash([
      pad32(DOMAIN.REGISTER_SCHEDULE),
      this.self,
      nodeId,
      scheduleHash,
      effectiveEpochBytes,
      currentEpochBytes,
    ]);

    // WI-16 validator verdict signature over actionHash.
    if (!signatureValid(validatorAttestor, actionHash, validatorSignature)) {
      revert('VALIDATOR_VERDICT_INVALID');
    }
    // I-D federation approval + replay guard.
    this.consumeFederationApproval(actionHash);

    const scheduleId = persistentHash([
      pad32(DOMAIN.SCHEDULE_ID),
      this.self,
      nodeId,
      effectiveEpochBytes,
    ]);
    const record = {
      scheduleId,
      nodeId,
      scheduleHash,
      operatorPubkey,
      effectiveEpoch: BigInt(effectiveEpoch),
      retiredEpoch: 0n,
      refRateFiatPerKwh: BigInt(refRateFiatPerKwh),
      registeredAt: BigInt(currentTime),
    };
    this._registeredSchedules.set(toHex(scheduleId), record);
    this._activeScheduleByNode.set(toHex(nodeId), toHex(scheduleId));
    this.emitAction(0, scheduleId, nodeId, actionHash, currentTime);
    return { scheduleId, actionHash };
  }

  // -------------------------- retireSchedule --------------------------------
  retireSchedule({ scheduleId, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('retireSchedule: timestamp cannot be in the future');
    const key = toHex(scheduleId);
    if (!this._registeredSchedules.has(key)) revert('SCHEDULE_NOT_FOUND');
    const rec = this._registeredSchedules.get(key);
    if (rec.retiredEpoch !== 0n) revert('SCHEDULE_ALREADY_RETIRED');

    const actionHash = persistentHash([
      pad32(DOMAIN.RETIRE_SCHEDULE),
      this.self,
      scheduleId,
      this.currentEpochBytes(),
    ]);
    this.consumeFederationApproval(actionHash);

    rec.retiredEpoch = this._currentEpoch;
    this._registeredSchedules.set(key, rec);
    const nodeKey = toHex(rec.nodeId);
    if (this._activeScheduleByNode.get(nodeKey) === key) {
      this._activeScheduleByNode.delete(nodeKey);
    }
    this.emitAction(3, scheduleId, rec.nodeId, actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- advanceEpoch ---------------------------------
  advanceEpoch({ newEpoch, newRefRateFiatPerKwh, newGovernanceRoot, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('advanceEpoch: timestamp cannot be in the future');
    const currentE = this._currentEpoch;
    const dNew = BigInt(newEpoch);
    // Two-sided checked-cast equality: newEpoch === currentE + 1.
    asUintChecked(dNew - currentE - 1n, 64, 'EPOCH_ADVANCE_NOT_PLUS_ONE');
    asUintChecked(currentE + 1n - dNew, 64, 'EPOCH_ADVANCE_NOT_PLUS_ONE');

    const actionHash = persistentHash([
      pad32(DOMAIN.ADVANCE_EPOCH),
      this.self,
      u64ToBytes32(currentE),
      u64ToBytes32(dNew),
      u64ToBytes32(newRefRateFiatPerKwh),
      Buffer.from(newGovernanceRoot),
    ]);
    this.consumeFederationApproval(actionHash);

    this._currentEpoch += 1n;
    this._refRateFiatPerKwh = BigInt(newRefRateFiatPerKwh);
    this._governanceRoot = Buffer.from(newGovernanceRoot);
    if (this._hasPendingContext) {
      this._LD_FLOOR_BPS = this._pendingLDFloorBps;
      this._OPS_FLOOR_BPS = this._pendingOpsFloorBps;
      this._SANITY_BAND_PCT = this._pendingSanityBandPct;
      this._hasPendingContext = false;
      this._pendingLDFloorBps = 0;
      this._pendingOpsFloorBps = 0;
      this._pendingSanityBandPct = 0;
    }
    this.emitAction(4, Buffer.alloc(32), Buffer.alloc(32), actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- setNationalContext ---------------------------
  setNationalContext({ newLDFloorBps, newOpsFloorBps, newSanityBandPct, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('setNationalContext: timestamp cannot be in the future');
    if (BigInt(newLDFloorBps) > 10000n) revert('LD floor exceeds 10000 bps');
    if (BigInt(newOpsFloorBps) > 10000n) revert('Ops floor exceeds 10000 bps');
    if (BigInt(newSanityBandPct) > 100n) revert('Sanity band pct exceeds 100');
    const actionHash = persistentHash([
      pad32(DOMAIN.SET_NATL_CTX),
      this.self,
      this.currentEpochBytes(),
      u16ToBytes32(newLDFloorBps),
      u16ToBytes32(newOpsFloorBps),
      u16ToBytes32(newSanityBandPct),
    ]);
    this.consumeFederationApproval(actionHash);
    this._pendingLDFloorBps = Number(newLDFloorBps);
    this._pendingOpsFloorBps = Number(newOpsFloorBps);
    this._pendingSanityBandPct = Number(newSanityBandPct);
    this._hasPendingContext = true;
    this.emitAction(5, Buffer.alloc(32), Buffer.alloc(32), actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- setFederationAuthority ------------------------
  setFederationAuthority({ newAuthorityHash, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('setFederationAuthority: timestamp cannot be in the future');
    if (bufEq(newAuthorityHash, Buffer.alloc(32))) revert('setFederationAuthority: zero hash rejected');
    if (bufEq(newAuthorityHash, this._federationAuthority)) revert('setFederationAuthority: no-op rotation');
    const actionHash = persistentHash([
      pad32(DOMAIN.ROTATE_AUTH),
      this.self,
      Buffer.from(newAuthorityHash),
      this.currentEpochBytes(),
    ]);
    this.consumeFederationApproval(actionHash);
    this._federationAuthority = Buffer.from(newAuthorityHash);
    this.emitAction(6, Buffer.alloc(32), Buffer.alloc(32), actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- retuneClass ----------------------------------
  retuneClass({
    scheduleId, classPath, newSplitBps, newRateFiatPerKwh,
    operatorId, operatorSignature,
    nonceIn, currentTime, now,
  }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('retuneClass: timestamp cannot be in the future');
    const key = toHex(scheduleId);
    if (!this._registeredSchedules.has(key)) revert('SCHEDULE_NOT_FOUND');
    const rec = this._registeredSchedules.get(key);
    if (rec.retiredEpoch !== 0n) revert('SCHEDULE_NOT_LIVE');
    if (!bufEq(operatorId, rec.operatorPubkey)) revert('RETUNE_OPERATOR_MISMATCH');

    // R-B compound nonce, strict monotone per (op, sched, epoch).
    const nonceKey = this.retuneNonceKey(operatorId, scheduleId);
    const prev = this._retuneNonces.get(toHex(nonceKey)) ?? 0n;
    const expected = BigInt(prev) + 1n;
    if (BigInt(nonceIn) !== expected) revert('RETUNE_NONCE_MISMATCH');

    // Cooldown per (op, sched, class).
    const cdKey = this.retuneCooldownKey(operatorId, scheduleId, classPath);
    if (this._retuneLastTime.has(toHex(cdKey))) {
      const lastT = this._retuneLastTime.get(toHex(cdKey));
      const earliest = BigInt(lastT) + RETUNE_MIN_INTERVAL_S;
      asUintChecked(BigInt(currentTime) - earliest, 64, 'RETUNE_COOLDOWN_NOT_ELAPSED');
    }

    // Operator signature (new field order includes rate).
    const shHash = splitSharesHash(newSplitBps);
    const payloadHash = persistentHash([
      pad32(DOMAIN.RETUNE_CLASS),
      this.self,
      scheduleId,
      classPath,
      shHash,
      u64ToBytes32(newRateFiatPerKwh),
      this.currentEpochBytes(),
      u64ToBytes32(nonceIn),
      u64ToBytes32(currentTime),
    ]);
    if (!signatureValid(operatorId, payloadHash, operatorSignature)) revert('RETUNE_OPERATOR_SIG_INVALID');

    // I-B floor re-check.
    asUintChecked(BigInt(newSplitBps.ldShareBps) - BigInt(this._LD_FLOOR_BPS), 16, 'RETUNE_LD_FLOOR_VIOLATION');
    asUintChecked(BigInt(newSplitBps.opsShareBps) - BigInt(this._OPS_FLOOR_BPS), 16, 'RETUNE_OPS_FLOOR_VIOLATION');
    // I-C sum-to-10000 exact.
    if (sumSplit(newSplitBps) !== 10000n) revert('RETUNE_SUM_NOT_10000');

    // T3.5 sanity band: newRate must be within ±SANITY_BAND_PCT of
    // rec.refRateFiatPerKwh. bandDelta = ref * (SANITY_BAND_PCT * 100) / 10000
    //                                   = ref * SANITY_BAND_PCT / 100.
    const ref = BigInt(rec.refRateFiatPerKwh);
    const bandBps = BigInt(this._SANITY_BAND_PCT) * 100n;
    // Integer division (mirrors checkedDivide integer floor).
    const bandDelta = (ref * bandBps) / 10000n;
    const lowEdge = ref - bandDelta;    // never underflows: bandDelta <= ref (since bandBps <= 10000, given SANITY_BAND_PCT <= 100)
    const highEdge = ref + bandDelta;
    const newRate = BigInt(newRateFiatPerKwh);
    asUintChecked(newRate - lowEdge, 128, 'RETUNE_VIOLATES_SANITY_BAND');
    asUintChecked(highEdge - newRate, 128, 'RETUNE_VIOLATES_SANITY_BAND');

    // Commit.
    const splitKey = this.classSplitKey(scheduleId, classPath);
    this._classEntries.set(toHex(splitKey), {
      bps: { ...newSplitBps },
      rateFiatPerKwh: newRate,
      lastUpdatedAt: BigInt(currentTime),
    });
    this._retuneNonces.set(toHex(nonceKey), BigInt(nonceIn));
    this._retuneLastTime.set(toHex(cdKey), BigInt(currentTime));
    this.emitAction(2, scheduleId, rec.nodeId, payloadHash, currentTime);
    return { payloadHash };
  }

  // -------------------------- resolvePath ----------------------------------
  resolvePath({ scheduleId, classPath, epoch }) {
    const key = toHex(scheduleId);
    if (!this._registeredSchedules.has(key)) revert('SCHEDULE_NOT_FOUND');
    const rec = this._registeredSchedules.get(key);
    const dEpoch = BigInt(epoch);
    asUintChecked(dEpoch - rec.effectiveEpoch, 64, 'RESOLVE_EPOCH_OUT_OF_RANGE');
    asUintChecked(this._currentEpoch - dEpoch, 64, 'RESOLVE_EPOCH_OUT_OF_RANGE');
    if (rec.retiredEpoch !== 0n) {
      asUintChecked(rec.retiredEpoch - dEpoch - 1n, 64, 'RESOLVE_EPOCH_OUT_OF_RANGE');
    }
    const splitKey = this.classSplitKey(scheduleId, classPath);
    if (!this._classEntries.has(toHex(splitKey))) revert('CLASS_NOT_FOUND');
    return this._classEntries.get(toHex(splitKey));
  }
  resolveCurrent({ scheduleId, classPath }) {
    return this.resolvePath({ scheduleId, classPath, epoch: this._currentEpoch });
  }

  isChartered(nodeId, proof) {
    return bufEq(reconstructCharterRoot(nodeId, proof), this._governanceRoot);
  }
  isScheduleActive(scheduleId) {
    const rec = this._registeredSchedules.get(toHex(scheduleId));
    if (!rec) return false;
    if (rec.retiredEpoch !== 0n) return false;
    return this._currentEpoch >= rec.effectiveEpoch;
  }

  // -------------------------- WI-13.1 registerLane -----------------------------
  registerLane({
    scheduleId, laneKindByte, leviedBy, bpsShare, remitAddress, basis,
    applicabilityHash, statuteRefHash, effectiveEpoch, remittanceMode,
    charterProof, currentTime, now,
  }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('registerLane: timestamp cannot be in the future');
    // (a) Schedule must exist and be live.
    const key = toHex(scheduleId);
    if (!this._registeredSchedules.has(key)) revert('SCHEDULE_NOT_FOUND');
    const schedRec = this._registeredSchedules.get(key);
    if (schedRec.retiredEpoch !== 0n) revert('SCHEDULE_NOT_LIVE');

    // (b) I-13.1-B: charter proof.
    this.assertCharterMembership(schedRec.nodeId, charterProof);

    // (c) I-13.1-D: effective epoch strictly in the future.
    asUintChecked(BigInt(effectiveEpoch) - this._currentEpoch - 1n, 64, 'LANE_EPOCH_RETROACTIVE');

    // (d) Prepare 14 hash inputs.
    const kindBytes         = u64ToBytes32(BigInt(laneKindByte));
    const bpsShareBytes     = u16ToBytes32(bpsShare);
    const basisBytes        = u64ToBytes32(BigInt(basis));
    const effectiveEpochBytes = u64ToBytes32(effectiveEpoch);
    const remittanceModeBytes = u64ToBytes32(BigInt(remittanceMode));
    const currentEpochBytes = this.currentEpochBytes();
    const timeBytes         = u64ToBytes32(currentTime);

    const actionHash = persistentHash([
      pad32(DOMAIN.REGISTER_LANE),
      this.self,
      scheduleId,
      kindBytes,
      leviedBy,
      bpsShareBytes,
      remitAddress,
      basisBytes,
      applicabilityHash,
      statuteRefHash,
      effectiveEpochBytes,
      remittanceModeBytes,
      currentEpochBytes,
      timeBytes,
    ]);

    // (e) I-13.1-A: federation approval.
    this.consumeFederationApproval(actionHash);

    // (f) I-13.1-E: duplicate check.
    const lKey = laneKey(scheduleId, laneKindByte);
    if (this._registeredLanes.has(toHex(lKey))) {
      const existing = this._registeredLanes.get(toHex(lKey));
      if (existing.retiredEpoch === 0n) revert('LANE_ALREADY_REGISTERED');
    }

    // (g) Insert the LaneRecord.
    const record = {
      scheduleId,
      laneKindByte: Number(laneKindByte),
      leviedBy,
      bpsShare: Number(bpsShare),
      remitAddress,
      basis: Number(basis),
      applicabilityHash,
      statuteRefHash,
      effectiveEpoch: BigInt(effectiveEpoch),
      retiredEpoch: 0n,
      remittanceMode: Number(remittanceMode),
      registeredAt: BigInt(currentTime),
    };
    this._registeredLanes.set(toHex(lKey), record);

    // (h) Emit action kind 1 = LANE_REGISTERED.
    this.emitAction(1, scheduleId, schedRec.nodeId, actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- WI-13.1 retireLane -------------------------------
  retireLane({ scheduleId, laneKindByte, currentTime, now }) {
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('retireLane: timestamp cannot be in the future');
    // (a) Look up the lane.
    const lKey = laneKey(scheduleId, laneKindByte);
    const key = toHex(lKey);
    if (!this._registeredLanes.has(key)) revert('LANE_NOT_FOUND');
    const rec = this._registeredLanes.get(key);

    // (b) I-13.1-F: must be active.
    if (rec.retiredEpoch !== 0n) revert('LANE_ALREADY_RETIRED');

    // (c) Prepare hash inputs.
    const kindBytes         = u64ToBytes32(BigInt(laneKindByte));
    const currentEpochBytes = this.currentEpochBytes();
    const timeBytes         = u64ToBytes32(currentTime);

    const actionHash = persistentHash([
      pad32(DOMAIN.RETIRE_LANE),
      this.self,
      scheduleId,
      kindBytes,
      currentEpochBytes,
      timeBytes,
    ]);

    // (d) Federation approval.
    this.consumeFederationApproval(actionHash);

    // (e) Mark retired.
    rec.retiredEpoch = this._currentEpoch;
    this._registeredLanes.set(key, rec);

    // (f) Emit action kind 7 = LANE_RETIRED.
    const schedRec = this._registeredSchedules.get(toHex(scheduleId));
    this.emitAction(7, scheduleId, schedRec.nodeId, actionHash, currentTime);
    return { actionHash };
  }

  // -------------------------- WI-13.1 resolveLane ------------------------------
  resolveLane({ scheduleId, laneKindByte }) {
    const lKey = laneKey(scheduleId, laneKindByte);
    const key = toHex(lKey);
    if (!this._registeredLanes.has(key)) revert('LANE_NOT_FOUND');
    return this._registeredLanes.get(key);
  }

  // -------------------------- WI-13.1 resolveLanes -----------------------------
  resolveLanes({ scheduleId, laneKindBytes }) {
    const zero = zeroLaneRecord();
    const results = [];
    for (let i = 0; i < MAX_STATUTORY_LANES; i++) {
      const kind = laneKindBytes[i];
      const lKey = laneKey(scheduleId, kind);
      const key = toHex(lKey);
      results.push(this._registeredLanes.has(key) ? this._registeredLanes.get(key) : zero);
    }
    return results;
  }

  // -------------------------- WI-13.1 isLaneActive -----------------------------
  isLaneActive({ scheduleId, laneKindByte }) {
    const lKey = laneKey(scheduleId, laneKindByte);
    const key = toHex(lKey);
    if (!this._registeredLanes.has(key)) return false;
    const rec = this._registeredLanes.get(key);
    if (rec.retiredEpoch !== 0n) return false;
    return this._currentEpoch >= rec.effectiveEpoch;
  }
}

// ------------------------------ Fixture helpers ------------------------------

// A "well-known" registry fixture used by multiple tests. Charter has 4 nodes
// (a, b, c, unchartered-but-known-by-name), governanceRoot matches the tree
// built over the first three.
export function makeFixture() {
  const opKey = newEd25519();
  const validatorKey = newEd25519();
  const nodeA = Buffer.from('a'.repeat(64), 'hex');           // 32 bytes of 0xAA
  const nodeB = Buffer.from('b'.repeat(64), 'hex');
  const nodeC = Buffer.from('c'.repeat(64), 'hex');
  const nodeD_unchartered = Buffer.from('d'.repeat(64), 'hex');
  const chartered = [nodeA, nodeB, nodeC];
  const tree = buildCharterTree(chartered);

  const registry = new TariffRegistry({
    federationAuthority: randomBytes(32),
    governanceRoot: tree.root,
    refRateFiatPerKwh: 100n, // arbitrary anchor
    self: randomBytes(32),
  });

  return {
    registry,
    opKey,
    validatorKey,
    charteredNodes: chartered,
    nodeUnchartered: nodeD_unchartered,
    charterTree: tree,
  };
}

// Build a valid SplitShares that sums to 10000 and passes floors.
// Canonical: producer 6500, ld 500, ops 2500, dao 300, margin 200, statutory 0.
// Sum = 10000. LD 500 >= 200 floor ✓. Ops 2500 >= 2000 floor ✓.
// (Sanity band applies to CLASS RATE, not producer share — producer bps has
// no independent bound beyond the shared sum-to-10000 + non-negative-Uint.)
export function validSplit(overrides = {}) {
  const canonical = {
    producerShareBps: 6500,
    ldShareBps: 500,
    opsShareBps: 2500,
    daoShareBps: 300,
    operatorMarginBps: 200,
    statutoryTotalBps: 0,
  };
  return { ...canonical, ...overrides };
}
