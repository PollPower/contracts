// =============================================================================
// v6.2-actionhash.ts — canonical off-chain actionHash construction for
// PollPowerMultiSig v6.2.
//
// STAGED for the pre-mainnet hardening ceremony (H-3 remediation). Not yet
// wired into the live ceremony runner — see UNBOUNDED-ADMIN-FINDING.md.
//
// WHY THIS FILE EXISTS
// --------------------
// v6.2 changes the self-governance action preimages:
//   - executeAddAdmin / executeRemoveAdmin now take a `newThreshold` arg, bound
//     into the actionHash, so the council votes on the (admin, threshold) PAIR.
//   - The preimage grows from 3 fields to 4: [opSel, param, threshold, nonce].
//   - Op selectors are version-tagged: "v6.2:addAdmin" / "v6.2:removeAdmin".
//     setThreshold stays 3-field ("v6.2:setThreshold").
//
// The hash MUST match what the contract recomputes in-circuit, byte-for-byte,
// or approvals won't aggregate under the same key and isApproved() fails at
// execute time.
//
// This mirrors the proven `computeActionHash` helper from the v6 ceremony
// (swap-garrett-ring.ts / test-ceremony.ts) — same persistentHash (Poseidon),
// same CompactTypeVector, same padToBytes32 / convertFieldToBytes — extended
// to the 4-field add/remove shape.
//
// NOTE on the admin app: apps/admin/services/actionHash.ts uses a SHA-256
// string scheme for the GENERIC governance path (approve/execute(actionHash)),
// domain-separated by contract address (the M-2 mitigation). It does NOT drive
// executeAddAdmin/executeRemoveAdmin. The admin-set self-governance path is
// driven from the ceremony runner using the Poseidon scheme below. If admin-set
// governance is ever moved INTO the app, it must use THIS scheme, not the
// SHA-256 one — they are not interchangeable.
// =============================================================================

import { Buffer } from 'buffer';
import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  convertFieldToBytes,
} from '@midnight-ntwrk/compact-runtime';

const Bytes32 = new CompactTypeBytes(32);
const Vec3Bytes32 = new CompactTypeVector(3, Bytes32);
const Vec4Bytes32 = new CompactTypeVector(4, Bytes32);

// v6.2 op selectors. MUST match the pad(32, "...") tags in the contract.
export const V62_OP = {
  addAdmin: 'v6.2:addAdmin',
  removeAdmin: 'v6.2:removeAdmin',
  setThreshold: 'v6.2:setThreshold',
} as const;

function padToBytes32(asciiTag: string): Uint8Array {
  const bytes = new Uint8Array(32);
  const ascii = Buffer.from(asciiTag, 'ascii');
  if (ascii.length > 32) throw new Error(`op tag too long (>32 bytes): ${asciiTag}`);
  bytes.set(ascii, 0);
  return bytes;
}

// uint -> Field -> Bytes<32>, matching the contract's
//   (value as Field) as Bytes<32>
// cast used for both the threshold and the nonce.
function uintToBytes32(value: bigint, label: string): Uint8Array {
  return convertFieldToBytes(32, value, label);
}

/**
 * v6.2 executeAddAdmin / executeRemoveAdmin actionHash.
 *
 *   opSel      = persistentHash(pad(32, opTag))
 *   actionHash = persistentHash([opSel, adminPk, thresholdBytes, nonceBytes])
 *
 * @param opTag      V62_OP.addAdmin or V62_OP.removeAdmin
 * @param adminPk    32-byte Ed25519 ring pubkey being added/removed
 * @param newThreshold the threshold to set atomically with the change
 * @param nextNonce  the contract nonce AFTER this action (current + 1n)
 */
export function computeAdminSetActionHash(
  opTag: typeof V62_OP.addAdmin | typeof V62_OP.removeAdmin,
  adminPk: Uint8Array,
  newThreshold: number | bigint,
  nextNonce: bigint,
): Uint8Array {
  if (adminPk.length !== 32) throw new Error('adminPk must be 32 bytes');
  const opSel = persistentHash(Bytes32, padToBytes32(opTag));
  const thresholdBytes = uintToBytes32(BigInt(newThreshold), 'v6.2 threshold');
  const nonceBytes = uintToBytes32(nextNonce, 'v6.2 nonce');
  return persistentHash(Vec4Bytes32, [opSel, adminPk, thresholdBytes, nonceBytes]);
}

/**
 * v6.2 executeSetThreshold actionHash (unchanged 3-field shape).
 *
 *   actionHash = persistentHash([opSel, thresholdBytes, nonceBytes])
 */
export function computeSetThresholdActionHash(
  newThreshold: number | bigint,
  nextNonce: bigint,
): Uint8Array {
  const opSel = persistentHash(Bytes32, padToBytes32(V62_OP.setThreshold));
  const thresholdBytes = uintToBytes32(BigInt(newThreshold), 'v6.2 threshold');
  const nonceBytes = uintToBytes32(nextNonce, 'v6.2 nonce');
  return persistentHash(Vec3Bytes32, [opSel, thresholdBytes, nonceBytes]);
}

// ---------------------------------------------------------------------------
// Majority helper — mirrors the contract's strict-majority rule (T*2 > N).
// Use this off-chain to pick a valid newThreshold BEFORE proposing, so the
// ceremony never proposes an action the contract will reject.
// ---------------------------------------------------------------------------

export const MAX_ADMINS = 7;

/** Smallest threshold that is a strict majority of n admins. */
export function minMajorityThreshold(n: number): number {
  return Math.floor(n / 2) + 1;
}

/** True iff threshold is a valid strict majority for a set of size n. */
export function isValidThreshold(threshold: number, n: number): boolean {
  return threshold >= 1 && threshold <= n && threshold * 2 > n;
}

/**
 * Resulting (size, threshold) checks for an ADD. Throws with the exact reason
 * the contract would assert on, so failures surface before any on-chain tx.
 */
export function assertValidAdd(currentSize: number, newThreshold: number): void {
  if (currentSize >= MAX_ADMINS) {
    throw new Error(`addAdmin: admin set at maximum (${MAX_ADMINS})`);
  }
  const newSize = currentSize + 1;
  if (!isValidThreshold(newThreshold, newSize)) {
    throw new Error(
      `addAdmin: newThreshold=${newThreshold} is not a strict majority of new size ${newSize} ` +
        `(need ${minMajorityThreshold(newSize)}..${newSize})`,
    );
  }
}

/** Resulting (size, threshold) checks for a REMOVE. */
export function assertValidRemove(currentSize: number, oldThreshold: number, newThreshold: number): void {
  // Contract floor guard uses the OLD threshold against the pre-change size.
  if (currentSize <= oldThreshold) {
    throw new Error('removeAdmin: would drop admin count below threshold');
  }
  const newSize = currentSize - 1;
  if (!isValidThreshold(newThreshold, newSize)) {
    throw new Error(
      `removeAdmin: newThreshold=${newThreshold} is not a strict majority of new size ${newSize} ` +
        `(need ${minMajorityThreshold(newSize)}..${newSize})`,
    );
  }
}
