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
// WI-13.1: resolveLanes batch width = the Kenya statutory stack
// (VAT + REP + EPRA + WARMA = 4). There is NO per-schedule lane cap; this
// width is a WI-14 settle-circuit capacity constraint, mirrored here so
// resolveLanes returns a fixed-width Vector<4> exactly like the contract.
export const RESOLVE_LANES_WIDTH = 4;

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
  // WI-13.2 action-log commitment domains
  ACTION_PAYLOAD:    'pp:tariff:v1:actionPayload',
  ACTION_LOG_ROOT:   'pp:tariff:v1:actionLogRoot',
  ACTION_LOG_NODE:   'pp:tariff:v1:actionLogNode',
  ACTION_LOG_EMPTY:  'pp:tariff:v1:actionLogEmpty',
});

// WI-13.2: default action-log Merkle depth for the offline harness. This is a
// SPEED/harness choice and is INDEPENDENT of the contract's CAL-13.2-D
// placeholder (24). AL-T3 proves correctness is D-independent by re-running the
// mirror at several depths. Tests parameterize D freely; nothing here resolves
// CAL-13.2-D.
export const ACTION_LOG_DEPTH_DEFAULT = 24;

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

// ------------------------------ WI-13.2 payload hashes -----------------------
// Byte-for-byte mirror of the .compact per-kind actionPayloadHash helpers
// (§SCOPE B). Fixed tag `pp:tariff:v1:actionPayload` + kind byte as the first
// hashed field, then the source struct's fields in DECLARATION order, each
// widened `(x as Field) as Bytes<32>` (mirrored via u64/u16ToBytes32).

// Kind 1 (LANE_REGISTERED) and kind 7 (LANE_RETIRED): all 12 LaneRecord fields.
export function laneActionPayloadHash(kind, r) {
  return persistentHash([
    pad32(DOMAIN.ACTION_PAYLOAD),
    u64ToBytes32(BigInt(kind)),
    r.scheduleId,
    u64ToBytes32(BigInt(r.laneKindByte)),
    r.leviedBy,
    u16ToBytes32(r.bpsShare),
    r.remitAddress,
    u64ToBytes32(BigInt(r.basis)),
    r.applicabilityHash,
    r.statuteRefHash,
    u64ToBytes32(r.effectiveEpoch),
    u64ToBytes32(r.retiredEpoch),
    u64ToBytes32(BigInt(r.remittanceMode)),
    u64ToBytes32(r.registeredAt),
  ]);
}

// Kind 0 (SCHEDULE_REGISTERED) and kind 3 (SCHEDULE_RETIRED): 8 ScheduleRecord
// fields.
export function scheduleActionPayloadHash(kind, r) {
  return persistentHash([
    pad32(DOMAIN.ACTION_PAYLOAD),
    u64ToBytes32(BigInt(kind)),
    r.scheduleId,
    r.nodeId,
    r.scheduleHash,
    r.operatorPubkey,
    u64ToBytes32(r.effectiveEpoch),
    u64ToBytes32(r.retiredEpoch),
    u64ToBytes32(r.refRateFiatPerKwh),
    u64ToBytes32(r.registeredAt),
  ]);
}

// Kind 2 (retuneClass): scheduleId, classPath, 6 SplitShares subfields,
// rateFiatPerKwh, lastUpdatedAt.
export function retuneActionPayloadHash(scheduleId, classPath, split, rateFiatPerKwh, lastUpdatedAt) {
  return persistentHash([
    pad32(DOMAIN.ACTION_PAYLOAD),
    u64ToBytes32(2n),
    scheduleId,
    classPath,
    u16ToBytes32(split.producerShareBps),
    u16ToBytes32(split.ldShareBps),
    u16ToBytes32(split.opsShareBps),
    u16ToBytes32(split.daoShareBps),
    u16ToBytes32(split.operatorMarginBps),
    u16ToBytes32(split.statutoryTotalBps),
    u64ToBytes32(rateFiatPerKwh),
    u64ToBytes32(lastUpdatedAt),
  ]);
}

// The pad(32,"") sentinel payloadHash for non-mirrored kinds (4/5/6) and
// pre-amendment entries.
export function sentinelPayloadHash() { return Buffer.alloc(32); }

// ------------------------------ WI-13.2 action-log Merkle tree ---------------
// Append-only incremental Merkle tree over raw payloadHash leaves. Mirrors the
// .compact frontier fold: leaf = raw payloadHash (NOT re-hashed), pair-node
// hash = persistentHash([nodeTag, left, right]), empty-leaf = pad32(tag). The
// keeper keeps the full sparse node store (the in-circuit contract keeps only
// the frontier) so it can generate WI-14 EventProof inclusion witnesses.

export function actionLogNodeHash(left, right) {
  return persistentHash([pad32(DOMAIN.ACTION_LOG_NODE), left, right]);
}
export function actionLogEmptyLeaf() { return pad32(DOMAIN.ACTION_LOG_EMPTY); }

// Per-level empty-subtree hashes z[0..depth-1] + the depth-`depth` empty root.
export function actionLogZeros(depth) {
  const zeros = [];
  let z = actionLogEmptyLeaf();
  for (let i = 0; i < depth; i++) { zeros.push(z); z = actionLogNodeHash(z, z); }
  return { zeros, emptyRoot: z };
}

export class ActionLogTree {
  constructor(depth) {
    this.depth = depth;
    const { zeros, emptyRoot } = actionLogZeros(depth);
    this.zeros = zeros;
    this.emptyRoot = emptyRoot;
    this.root = emptyRoot;
    this.nextIndex = 0;
    // Sparse node store: nodes[level] = Map<indexStr, Buffer>. Absent = zeros.
    this.nodes = Array.from({ length: depth + 1 }, () => new Map());
    this.leaves = [];
  }
  _get(level, index) {
    const m = this.nodes[level];
    const k = String(index);
    return m.has(k) ? m.get(k) : this.zeros[level];
  }
  _set(level, index, val) { this.nodes[level].set(String(index), Buffer.from(val)); }

  append(leaf) {
    const idx = this.nextIndex;
    if (idx >= 2 ** this.depth) throw new Error('ActionLogTree: capacity exceeded (2^D)');
    this.leaves.push(Buffer.from(leaf));
    this._set(0, idx, leaf);
    let h = Buffer.from(leaf);
    let i = idx;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      // LSB-first path bit: (i & 1) === 0 -> left child, else right child.
      const parent = (i & 1) === 0
        ? actionLogNodeHash(h, this._get(lvl, i + 1))     // right sibling (empty->zeros)
        : actionLogNodeHash(this._get(lvl, i - 1), h);    // left sibling (stored)
      this._set(lvl + 1, i >> 1, parent);
      h = parent;
      i = i >> 1;
    }
    this.root = h;
    this.nextIndex += 1;
    return this.root;
  }

  // Inclusion proof for the leaf at `index` against the CURRENT tree state,
  // in WI-14 EventProof shape: { siblings: Vector<D>, pathBits: Vector<D> }.
  proof(index) {
    const siblings = [];
    const pathBits = [];
    let i = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const isRight = (i & 1) === 1;
      pathBits.push(isRight);
      siblings.push(this._get(lvl, isRight ? i - 1 : i + 1));
      i = i >> 1;
    }
    return { siblings, pathBits };
  }
}

// WI-14 §7.1 reference `reconstructRoot`: climb from `payloadHash` using
// (siblings, pathBits). Leaf is the raw payloadHash (design decision #4).
export function reconstructActionLogRoot(payloadHash, siblings, pathBits) {
  let h = Buffer.from(payloadHash);
  for (let lvl = 0; lvl < siblings.length; lvl++) {
    h = pathBits[lvl]
      ? actionLogNodeHash(siblings[lvl], h)
      : actionLogNodeHash(h, siblings[lvl]);
  }
  return h;
}

// ------------------------------ WI-13.1 Lane helpers -------------------------

// Composite key for a lane record (scheduleId, leviedBy, laneKindByte).
export function laneKey(scheduleId, leviedBy, laneKindByte) {
  const kindBytes = u64ToBytes32(BigInt(laneKindByte));
  return persistentHash([
    pad32(DOMAIN.LANE_KEY),
    scheduleId,
    leviedBy,
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
  constructor({ federationAuthority, governanceRoot, refRateFiatPerKwh, self, actionLogDepth, autoBootstrap = true }) {
    // Self-address (32 bytes) — mirrors kernel.self().bytes.
    this.self = Buffer.isBuffer(self) ? self : randomBytes(32);
    // Ledger fields (constructor-set).
    // LD v2.2.1 two-flag pattern:
    //   _initialized = constructor ran (sealed in Compact, constructor-only write)
    //   _bootstrapComplete = post-deploy bootstrap readiness gate
    this._initialized = true;
    this._bootstrapComplete = false;
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
    this._actionLogFrontier = new Map();     // level -> hash
    this._actionLogZeros = new Map();        // level -> hash
    // WI-13.1: lane records.
    this._registeredLanes = new Map();       // laneKeyHex -> LaneRecord
    // Event log.
    this._actionLog = new Map();             // seq -> RegistryActionEntry
    this._actionSeq = 0n;
    // WI-13.2 action-log commitment. Fresh init: empty tree + baseSeq 0.
    this.actionLogDepth = actionLogDepth ?? ACTION_LOG_DEPTH_DEFAULT;
    this._actionLogTree = new ActionLogTree(this.actionLogDepth);
    this.registryActionLogRoot = Buffer.alloc(32);
    this._actionLogBaseSeq = 0n;
    this._actionLogClimb = pad32(DOMAIN.ACTION_LOG_EMPTY);
    this._actionLogBootstrapCursor = 0n;
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

    if (autoBootstrap) {
      this.bootstrapActionLog(24n);
    }
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

  assertInitialized() {
    if (!this._initialized) revert('TariffRegistry: not initialized');
    if (!this._bootstrapComplete) revert('TariffRegistry: bootstrap incomplete');
  }

  // WI-13.3 post-deploy bootstrap flow.
  bootstrapActionLog(shardEnd) {
    if (this._bootstrapComplete) revert('TariffRegistry: already initialized');
    const end = BigInt(shardEnd);
    const cursor = this._actionLogBootstrapCursor;
    if (end <= cursor) revert('ACTION_LOG_BOOTSTRAP_NON_MONOTONIC');
    if (end > 24n) revert('ACTION_LOG_BOOTSTRAP_BOUND');

    let z = Buffer.from(this._actionLogClimb);
    for (let i = cursor; i < end; i++) {
      this._actionLogZeros.set(i, Buffer.from(z));
      this._actionLogFrontier.set(i, Buffer.from(z));
      z = actionLogNodeHash(z, z);
    }

    this._actionLogClimb = Buffer.from(z);
    this._actionLogBootstrapCursor = end;

    if (end === 24n) {
      this.registryActionLogRoot = Buffer.from(this._actionLogClimb);
      this._actionLogBaseSeq = this._actionSeq;
      this._bootstrapComplete = true;
    }
  }

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

  emitAction(kind, scheduleId, nodeId, actionHash, payloadHash, currentTime) {
    this.assertInitialized();
    const entry = {
      kind,
      scheduleId: Buffer.from(scheduleId),
      nodeId: Buffer.from(nodeId),
      epoch: this._currentEpoch,
      actionHash: Buffer.from(actionHash),
      emittedAt: BigInt(currentTime),
      payloadHash: Buffer.from(payloadHash),   // WI-13.2
    };
    this._actionLog.set(this._actionSeq, entry);
    // WI-13.2: append the payloadHash leaf and recommit the root.
    this._actionLogTree.append(payloadHash);
    this.registryActionLogRoot = Buffer.from(this._actionLogTree.root);
    this._actionSeq += 1n;
  }

  // WI-13.2 §SCOPE D read circuits.
  getActionEntry(seq) {
    this.assertInitialized();
    const s = BigInt(seq);
    if (!this._actionLog.has(s)) revert('ACTION_LOG_SEQ_MISSING');
    return this._actionLog.get(s);
  }
  getActionPayloadHash(seq) {
    this.assertInitialized();
    const s = BigInt(seq);
    if (!this._actionLog.has(s)) revert('ACTION_LOG_SEQ_MISSING');
    return this._actionLog.get(s).payloadHash;
  }

  // WI-13.2 §SCOPE F — model forward-only migration. Simulate a WI-13.1
  // pre-amendment entry: an _actionLog row with the sentinel payloadHash whose
  // leaf is NOT committed to the root, and bump _actionSeq. (Used only by the
  // migration test to build a realistic pre-amendment state.)
  pushLegacyEntry({ kind, scheduleId, nodeId, actionHash, currentTime }) {
    const entry = {
      kind,
      scheduleId: Buffer.from(scheduleId ?? Buffer.alloc(32)),
      nodeId: Buffer.from(nodeId ?? Buffer.alloc(32)),
      epoch: this._currentEpoch,
      actionHash: Buffer.from(actionHash ?? randomBytes(32)),
      emittedAt: BigInt(currentTime ?? 0n),
      payloadHash: Buffer.alloc(32),   // pre-amendment sentinel
    };
    this._actionLog.set(this._actionSeq, entry);
    this._actionSeq += 1n;
  }

  // "Activate" the WI-13.2 amendment on a migrated instance: seed the root to
  // the empty-tree root, reset the (forward-only) tree, and record baseSeq =
  // the current head. From here every emitAction commits a payloadHash leaf.
  bootstrapActionLogRoot() {
    this._actionLogBaseSeq = this._actionSeq;
    this._actionLogTree = new ActionLogTree(this.actionLogDepth);
    this.registryActionLogRoot = Buffer.from(this._actionLogTree.root);
  }

  // -------------------------- registerSchedule ------------------------------
  registerSchedule({
    nodeId, scheduleHash, operatorPubkey, refRateFiatPerKwh,
    effectiveEpoch, validatorAttestor, validatorSignature, currentTime,
    charterProof,
    now,       // simulate blockTime; must be >= currentTime for L-3.
  }) {
    this.assertInitialized();
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
    const payloadHash = scheduleActionPayloadHash(0, record);
    this.emitAction(0, scheduleId, nodeId, actionHash, payloadHash, currentTime);
    return { scheduleId, actionHash, payloadHash };
  }

  // -------------------------- retireSchedule --------------------------------
  retireSchedule({ scheduleId, currentTime, now }) {
    this.assertInitialized();
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
    const payloadHash = scheduleActionPayloadHash(3, rec);
    this.emitAction(3, scheduleId, rec.nodeId, actionHash, payloadHash, currentTime);
    return { actionHash, payloadHash };
  }

  // -------------------------- advanceEpoch ---------------------------------
  advanceEpoch({ newEpoch, newRefRateFiatPerKwh, newGovernanceRoot, currentTime, now }) {
    this.assertInitialized();
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
    this.emitAction(4, Buffer.alloc(32), Buffer.alloc(32), actionHash, sentinelPayloadHash(), currentTime);
    return { actionHash };
  }

  // -------------------------- setNationalContext ---------------------------
  setNationalContext({ newLDFloorBps, newOpsFloorBps, newSanityBandPct, currentTime, now }) {
    this.assertInitialized();
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
    this.emitAction(5, Buffer.alloc(32), Buffer.alloc(32), actionHash, sentinelPayloadHash(), currentTime);
    return { actionHash };
  }

  // -------------------------- setFederationAuthority ------------------------
  setFederationAuthority({ newAuthorityHash, currentTime, now }) {
    this.assertInitialized();
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
    this.emitAction(6, Buffer.alloc(32), Buffer.alloc(32), actionHash, sentinelPayloadHash(), currentTime);
    return { actionHash };
  }

  // -------------------------- retuneClass ----------------------------------
  retuneClass({
    scheduleId, classPath, newSplitBps, newRateFiatPerKwh,
    operatorId, operatorSignature,
    nonceIn, currentTime, now,
  }) {
    this.assertInitialized();
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

    // Operator signature (new field order includes rate). WI-13.2 design
    // decision #5: this is the AUTHORIZATION hash (-> actionHash slot), renamed
    // authHash to avoid conflation with the canonical mirror payloadHash below.
    const shHash = splitSharesHash(newSplitBps);
    const authHash = persistentHash([
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
    if (!signatureValid(operatorId, authHash, operatorSignature)) revert('RETUNE_OPERATOR_SIG_INVALID');

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
    // WI-13.2: canonical payload (distinct from the authorization hash).
    const payloadHash = retuneActionPayloadHash(
      scheduleId, classPath, newSplitBps, BigInt(newRateFiatPerKwh), BigInt(currentTime));
    this.emitAction(2, scheduleId, rec.nodeId, authHash, payloadHash, currentTime);
    return { authHash, payloadHash };
  }

  // -------------------------- resolvePath ----------------------------------
  resolvePath({ scheduleId, classPath, epoch }) {
    this.assertInitialized();
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
    this.assertInitialized();
    return this.resolvePath({ scheduleId, classPath, epoch: this._currentEpoch });
  }

  isChartered(nodeId, proof) {
    this.assertInitialized();
    return bufEq(reconstructCharterRoot(nodeId, proof), this._governanceRoot);
  }
  isScheduleActive(scheduleId) {
    this.assertInitialized();
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
    this.assertInitialized();
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('registerLane: timestamp cannot be in the future');
    // (a) Schedule must exist and be live.
    const key = toHex(scheduleId);
    if (!this._registeredSchedules.has(key)) revert('SCHEDULE_NOT_FOUND');
    const schedRec = this._registeredSchedules.get(key);
    if (schedRec.retiredEpoch !== 0n) revert('SCHEDULE_NOT_LIVE');

    // (a') I-13.1-I / MED-A: leviedBy must be non-zero. The zero-address is
    // reserved as the resolveLanes empty-slot sentinel, so a lane keyed on it
    // would be indistinguishable from an unpopulated request slot.
    if (bufEq(leviedBy, Buffer.alloc(32))) revert('LANE_LEVIED_BY_ZERO');

    // (b) I-13.1-B: charter proof.
    this.assertCharterMembership(schedRec.nodeId, charterProof);

    // (c) I-13.1-D: effective epoch strictly in the future.
    // Bare checked-cast (no labeled error).
    asUintChecked(BigInt(effectiveEpoch) - this._currentEpoch - 1n, 64, 'registerLane: effectiveEpoch underflow');

    // (c') I-13.1-J: laneKindByte < 16 (reserved statute-kind range).
    // Bare checked-cast (no labeled error).
    asUintChecked(16n - BigInt(laneKindByte) - 1n, 8, 'registerLane: laneKindByte out of range');

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
    const lKey = laneKey(scheduleId, leviedBy, laneKindByte);
    const keyPresent = this._registeredLanes.has(toHex(lKey));
    if (keyPresent) {
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
    const payloadHash = laneActionPayloadHash(1, record);
    this.emitAction(1, scheduleId, schedRec.nodeId, actionHash, payloadHash, currentTime);
    return { actionHash, payloadHash };
  }

  // -------------------------- WI-13.1 retireLane -------------------------------
  retireLane({ scheduleId, leviedBy, laneKindByte, currentTime, now }) {
    this.assertInitialized();
    if (BigInt(now ?? currentTime) < BigInt(currentTime)) revert('retireLane: timestamp cannot be in the future');
    // (a) Look up the lane.
    const lKey = laneKey(scheduleId, leviedBy, laneKindByte);
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
      leviedBy,
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
    const payloadHash = laneActionPayloadHash(7, rec);
    this.emitAction(7, scheduleId, schedRec.nodeId, actionHash, payloadHash, currentTime);
    return { actionHash, payloadHash };
  }

  // -------------------------- WI-13.1 resolveLane ------------------------------
  resolveLane({ scheduleId, leviedBy, laneKindByte }) {
    this.assertInitialized();
    const lKey = laneKey(scheduleId, leviedBy, laneKindByte);
    const key = toHex(lKey);
    if (!this._registeredLanes.has(key)) revert('LANE_NOT_FOUND');
    return this._registeredLanes.get(key);
  }

  // -------------------------- WI-13.1 resolveLanes -----------------------------
  resolveLanes({ scheduleId, leviedBys, laneKindBytes }) {
    this.assertInitialized();
    const zero = zeroLaneRecord();
    const results = [];
    for (let i = 0; i < RESOLVE_LANES_WIDTH; i++) {
      const leviedBy = leviedBys[i];
      const kind = laneKindBytes[i];
      const lKey = laneKey(scheduleId, leviedBy, kind);
      const key = toHex(lKey);
      results.push(this._registeredLanes.has(key) ? this._registeredLanes.get(key) : zero);
    }
    return results;
  }

  // -------------------------- WI-13.1 isLaneActive -----------------------------
  isLaneActive({ scheduleId, leviedBy, laneKindByte }) {
    this.assertInitialized();
    const lKey = laneKey(scheduleId, leviedBy, laneKindByte);
    const key = toHex(lKey);
    if (!this._registeredLanes.has(key)) return false;
    const rec = this._registeredLanes.get(key);
    if (rec.retiredEpoch !== 0n) return false;
    // MED-B: parent schedule must exist and be live. retireSchedule does not
    // touch lane records, so a lane under a retired schedule keeps its own
    // retiredEpoch == 0 yet is not active.
    const schedKey = toHex(scheduleId);
    if (!this._registeredSchedules.has(schedKey)) return false;
    if (this._registeredSchedules.get(schedKey).retiredEpoch !== 0n) return false;
    return this._currentEpoch >= rec.effectiveEpoch;
  }
}

// ------------------------------ Fixture helpers ------------------------------

// A "well-known" registry fixture used by multiple tests. Charter has 4 nodes
// (a, b, c, unchartered-but-known-by-name), governanceRoot matches the tree
// built over the first three.
export function makeFixture(opts = {}) {
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
    autoBootstrap: opts.autoBootstrap ?? true,
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

export function makeUninitializedFixture() {
  return makeFixture({ autoBootstrap: false });
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
