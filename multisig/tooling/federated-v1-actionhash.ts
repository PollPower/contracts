// =============================================================================
// federated-v1-actionhash.ts - canonical off-chain actionHash + signing-
// message construction for PollPowerMultiSigFederated v1 (DEV DRAFT, rev 4).
// (Renamed from v7-actionhash.ts; "v7" belongs to the deployed 2026-07-05
// self-bound multisig lineage. Domain separators are pp:msfed:v1:*.)
//
// Companion to multisig/multisig-federated-v1.compact. Every hash here MUST
// match what the contract recomputes in-circuit, byte-for-byte, or approvals
// won't aggregate under the same key and isApproved() fails at execute time.
//
// federated-v1 DIFFERENCES FROM v6.2 (tooling-visible):
//   1. SELF-ADDRESS BINDING (rev 3). Every actionHash and signing message
//      folds the deployment's contract address (kernel.self().bytes) in as
//      the second field: [opSel|domain, self, ...]. Closes cross-deployment
//      replay (M-2 class) with one in-circuit mechanism - no contractTag.
//   2. EPOCH BINDING. Approval messages are NOT the bare actionHash:
//        direct:  H(domain("pp:msfed:v1:approve:direct") ‖ self ‖ epoch ‖ actionHash)
//        fed:     H(domain("pp:msfed:v1:approve:fed") ‖ self ‖ seatId ‖ epoch ‖ actionHash)
//      Rotation increments the epoch and instantly invalidates all sigs.
//   3. NEW OPS: rotateSeats (14-field), setSeatAttestor (5-field),
//      setThreshold / setConstAuthority / setParentAuthority (4-field),
//      conveneRotation (parent-signed message, no council actionHash).
//   4. CONSTITUTIONAL ATTESTATION. The three constitutional ops additionally
//      need the constitutional authority's signature over
//      H(domain("pp:msfed:v1:constitutional") ‖ self ‖ epoch ‖ actionHash).
//   5. addAdmin/removeAdmin are GONE (fixed 5-seat council, wholesale rotation).
//
// GENERIC execute(actionHash) CONVENTION (L-2, unchanged limitation): the
// contract cannot recompute caller-defined hashes. Generic actionHashes MUST
// be built with computeGenericActionHash() below, which binds self + nonce.
//
// Poseidon scheme (persistentHash) throughout - same as the v6.2 ceremony
// path, NOT the SHA-256 scheme in apps/admin/services/actionHash.ts.
// =============================================================================

import { Buffer } from 'buffer';
import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  convertFieldToBytes,
} from '@midnight-ntwrk/compact-runtime';

const Bytes32 = new CompactTypeBytes(32);
const Vec2Bytes32 = new CompactTypeVector(2, Bytes32);
const Vec4Bytes32 = new CompactTypeVector(4, Bytes32);
const Vec5Bytes32 = new CompactTypeVector(5, Bytes32);
const Vec10Bytes32 = new CompactTypeVector(10, Bytes32);
const Vec14Bytes32 = new CompactTypeVector(14, Bytes32);

// v7 op selectors + signing domains. MUST match pad(32, "...") in the contract.
export const V7_OP = {
  setSeatAttestor: 'pp:msfed:v1:setSeatAttestor',
  clearSeatAttestor: 'pp:msfed:v1:clearSeatAttestor',
  rotateSeats: 'pp:msfed:v1:rotateSeats',
  setThreshold: 'pp:msfed:v1:setThreshold',
  setConstAuthority: 'pp:msfed:v1:setConstAuthority',
  setParentAuthority: 'pp:msfed:v1:setParentAuthority',
  generic: 'pp:msfed:v1:generic',
} as const;

export const V7_DOMAIN = {
  approveDirect: 'pp:msfed:v1:approve:direct',
  approveFederated: 'pp:msfed:v1:approve:fed',
  constitutional: 'pp:msfed:v1:constitutional',
  convene: 'pp:msfed:v1:convene',
} as const;

export const COUNCIL_SIZE = 5;
export const CONVENE_PERIOD_SECONDS = 2_592_000n; // 30 days - matches contract

export function padToBytes32(asciiTag: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = Buffer.from(asciiTag, 'ascii');
  if (ascii.length > 32) throw new Error(`tag too long (>32 bytes): ${asciiTag}`);
  bytes.set(ascii, 0);
  return bytes;
}

// uint -> Field -> Bytes<32>, matching the contract's
//   (value as Field) as Bytes<32>
export function uintToBytes32(value: bigint, label: string): Uint8Array {
  return convertFieldToBytes(32, value, label);
}

function assert32(name: string, b: Uint8Array): void {
  if (b.length !== 32) throw new Error(`${name} must be 32 bytes, got ${b.length}`);
}

function domainSel(tag: string): Uint8Array {
  return persistentHash(Bytes32, padToBytes32(tag));
}

// =============================================================================
// Action hashes (what the council approves)
// All bind selfAddress = this deployment's contract address bytes (32).
// =============================================================================

/**
 * executeSetSeatAttestor actionHash:
 *   H([opSel, self, seatId, attestorPubkey, nonceBytes])
 * @param nextNonce the contract nonce AFTER this action (current + 1n)
 */
export function computeSetSeatAttestorActionHash(
  selfAddress: Uint8Array,
  seatId: Uint8Array,
  attestorPubkey: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('seatId', seatId);
  assert32('attestorPubkey', attestorPubkey);
  const opSel = domainSel(V7_OP.setSeatAttestor);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec5Bytes32, [opSel, selfAddress, seatId, attestorPubkey, nonceBytes]);
}

/**
 * executeRotateSeats actionHash (14-field preimage):
 *   H([opSel, self, out0..out4, in0..in4, seedCommitment, nonceBytes])
 * Order matters and must match the contract exactly.
 */
export function computeRotateSeatsActionHash(
  selfAddress: Uint8Array,
  outgoing: Uint8Array[],
  incoming: Uint8Array[],
  seedCommitment: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  if (outgoing.length !== COUNCIL_SIZE) throw new Error('outgoing must have 5 seats');
  if (incoming.length !== COUNCIL_SIZE) throw new Error('incoming must have 5 seats');
  outgoing.forEach((s, i) => assert32(`outgoing[${i}]`, s));
  incoming.forEach((s, i) => assert32(`incoming[${i}]`, s));
  assert32('seedCommitment', seedCommitment);
  assertDistinct('incoming', incoming);

  const opSel = domainSel(V7_OP.rotateSeats);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec14Bytes32, [
    opSel,
    selfAddress,
    ...outgoing,
    ...incoming,
    seedCommitment,
    nonceBytes,
  ]);
}

/** executeSetThreshold actionHash: H([opSel, self, thresholdBytes, nonceBytes]) */
export function computeSetThresholdActionHash(
  selfAddress: Uint8Array,
  newThreshold: number | bigint,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  const t = Number(newThreshold);
  if (!isValidThreshold(t)) {
    throw new Error(
      `newThreshold=${t} is not a strict majority of the fixed 5-seat council (need 3..5)`,
    );
  }
  const opSel = domainSel(V7_OP.setThreshold);
  const thresholdBytes = uintToBytes32(BigInt(newThreshold), 'v7 threshold');
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec4Bytes32, [opSel, selfAddress, thresholdBytes, nonceBytes]);
}

/** executeSetConstitutionalAuthority actionHash: H([opSel, self, newAuthority, nonceBytes]) */
export function computeSetConstAuthorityActionHash(
  selfAddress: Uint8Array,
  newAuthority: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('newAuthority', newAuthority);
  const opSel = domainSel(V7_OP.setConstAuthority);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec4Bytes32, [opSel, selfAddress, newAuthority, nonceBytes]);
}

/** executeSetParentAuthority actionHash: H([opSel, self, newParent, nonceBytes]) */
export function computeSetParentAuthorityActionHash(
  selfAddress: Uint8Array,
  newParent: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('newParent', newParent);
  const opSel = domainSel(V7_OP.setParentAuthority);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec4Bytes32, [opSel, selfAddress, newParent, nonceBytes]);
}

/**
 * Generic operational actionHash for execute(actionHash) - L-2 convention.
 * The contract does NOT recompute this; every off-chain signer MUST build
 * generic hashes this way so self + nonce are always bound:
 *   H([opSel("pp:msfed:v1:generic"), self, payloadHash, nonceBytes])
 * @param payloadHash 32-byte hash of the operation payload (caller-defined)
 */
export function computeGenericActionHash(
  selfAddress: Uint8Array,
  payloadHash: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('payloadHash', payloadHash);
  const opSel = domainSel(V7_OP.generic);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec4Bytes32, [opSel, selfAddress, payloadHash, nonceBytes]);
}

// =============================================================================
// Signing messages (what keys actually sign - self- and epoch-bound)
// =============================================================================

/**
 * Message a DIRECT seat's Ed25519 key signs to approve an action:
 *   H([H(pad("pp:msfed:v1:approve:direct")), self, epochBytes, actionHash])
 * @param epoch the contract's _epoch counter value AT SIGNING TIME
 */
export function computeDirectApprovalMessage(
  selfAddress: Uint8Array,
  actionHash: Uint8Array,
  epoch: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('actionHash', actionHash);
  const domain = domainSel(V7_DOMAIN.approveDirect);
  const epochBytes = uintToBytes32(epoch, 'v7 epoch');
  return persistentHash(Vec4Bytes32, [domain, selfAddress, epochBytes, actionHash]);
}

/**
 * Message a FEDERATION seat's attestor signs after observing lower-tier
 * quorum on the same actionHash:
 *   H([H(pad("pp:msfed:v1:approve:fed")), self, seatId, epochBytes, actionHash])
 * seatId = the lower-tier council's contract address (as registered in _seats).
 */
export function computeFederatedApprovalMessage(
  selfAddress: Uint8Array,
  seatId: Uint8Array,
  actionHash: Uint8Array,
  epoch: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('seatId', seatId);
  assert32('actionHash', actionHash);
  const domain = domainSel(V7_DOMAIN.approveFederated);
  const epochBytes = uintToBytes32(epoch, 'v7 epoch');
  return persistentHash(Vec5Bytes32, [domain, selfAddress, seatId, epochBytes, actionHash]);
}

/**
 * Message the CONSTITUTIONAL AUTHORITY signs to attest a passed referendum
 * for a constitutional action:
 *   H([H(pad("pp:msfed:v1:constitutional")), self, epochBytes, actionHash])
 */
export function computeConstitutionalMessage(
  selfAddress: Uint8Array,
  actionHash: Uint8Array,
  epoch: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('actionHash', actionHash);
  const domain = domainSel(V7_DOMAIN.constitutional);
  const epochBytes = uintToBytes32(epoch, 'v7 epoch');
  return persistentHash(Vec4Bytes32, [domain, selfAddress, epochBytes, actionHash]);
}

/**
 * executeClearSeatAttestor actionHash:
 *   H([opSel, self, seatId, nonceBytes])
 */
export function computeClearSeatAttestorActionHash(
  selfAddress: Uint8Array,
  seatId: Uint8Array,
  nextNonce: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  assert32('seatId', seatId);
  const opSel = domainSel(V7_OP.clearSeatAttestor);
  const nonceBytes = uintToBytes32(nextNonce, 'v7 nonce');
  return persistentHash(Vec4Bytes32, [opSel, selfAddress, seatId, nonceBytes]);
}

/**
 * Message the PARENT AUTHORITY signs for dead-council recovery
 * (executeConveneRotation):
 *   H([H(pad("pp:msfed:v1:convene")), self, epochBytes, timeBytes, in0..in4, seedCommitment])
 * Replay protection: epoch (increments on execution) + self (deployment) +
 * currentTime (F-2: the signature attests to one exact convene time, so a
 * pre-signed convene cannot be held and replayed in a later dead-window
 * within the same epoch).
 */
export function computeConveneMessage(
  selfAddress: Uint8Array,
  incoming: Uint8Array[],
  seedCommitment: Uint8Array,
  epoch: bigint,
  currentTime: bigint,
): Uint8Array {
  assert32('selfAddress', selfAddress);
  if (incoming.length !== COUNCIL_SIZE) throw new Error('incoming must have 5 seats');
  incoming.forEach((s, i) => assert32(`incoming[${i}]`, s));
  assert32('seedCommitment', seedCommitment);
  assertDistinct('incoming', incoming);

  const domain = domainSel(V7_DOMAIN.convene);
  const epochBytes = uintToBytes32(epoch, 'v7 epoch');
  const timeBytes = uintToBytes32(currentTime, 'v7 conveneTime');
  return persistentHash(Vec10Bytes32, [
    domain,
    selfAddress,
    epochBytes,
    timeBytes,
    ...incoming,
    seedCommitment,
  ]);
}

// =============================================================================
// Approval-map key (off-chain mirror of the contract's approvalKey) - useful
// for indexer queries / debugging pending-approval state.
//   H([epochBytes, actionHash])
// =============================================================================
export function computeApprovalKey(actionHash: Uint8Array, epoch: bigint): Uint8Array {
  assert32('actionHash', actionHash);
  const epochBytes = uintToBytes32(epoch, 'v7 epoch');
  return persistentHash(Vec2Bytes32, [epochBytes, actionHash]);
}

// =============================================================================
// Validation helpers - mirror contract asserts so ceremonies fail BEFORE any
// on-chain transaction.
// =============================================================================

/** v7 council is fixed at 5 seats; valid thresholds are 3..5 (strict majority). */
export function isValidThreshold(threshold: number): boolean {
  return threshold >= 3 && threshold <= COUNCIL_SIZE;
}

function assertDistinct(label: string, ids: Uint8Array[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    const hex = Buffer.from(id).toString('hex');
    if (seen.has(hex)) {
      throw new Error(`${label}: duplicate seat id ${hex.slice(0, 16)}...`);
    }
    seen.add(hex);
  }
}

/**
 * Sortition seed commitment helper. Convention (documented, not enforced
 * in-circuit): seedCommitment = H([beaconValue, membershipSnapshotHash])
 * where beaconValue is a public randomness beacon output for the epoch and
 * membershipSnapshotHash commits to the eligible-member list the draw ran
 * over. Publishing (beaconValue, memberList) makes the draw reproducible.
 */
export function computeSeedCommitment(
  beaconValue: Uint8Array,
  membershipSnapshotHash: Uint8Array,
): Uint8Array {
  assert32('beaconValue', beaconValue);
  assert32('membershipSnapshotHash', membershipSnapshotHash);
  return persistentHash(Vec2Bytes32, [beaconValue, membershipSnapshotHash]);
}

/**
 * Dead-council check (off-chain preflight for executeConveneRotation).
 * Mirrors: currentTime >= _lastCouncilActionTime + CONVENE_PERIOD.
 */
export function isCouncilConvenable(
  lastCouncilActionTime: bigint,
  currentTime: bigint,
): boolean {
  return currentTime >= lastCouncilActionTime + CONVENE_PERIOD_SECONDS;
}
