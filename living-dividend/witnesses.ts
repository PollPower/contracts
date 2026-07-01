// witnesses.ts
// TypeScript witness implementations for living-dividend-v1.compact
//
// Witnesses are prover-side code — they run OFF-CHAIN when a user (or
// keeper) is generating a ZK proof to submit a transaction. The circuit
// then verifies the witness result in-circuit via cheaper assertions.
//
// Compact declares witnesses; TypeScript provides the runtime.
//
// The LD contract declares FOUR witnesses:
//
//   witness witness_divmod(numerator: Field, divisor: Field): DivResult
//   witness witness_multisigSignatureValid(
//     payload: Bytes<32>, authorityHash: Bytes<32>
//   ): Boolean
//   witness witness_memberSignatureValid(
//     member: UserAddress, payload: Bytes<32>
//   ): Boolean
//   witness witness_blockTimeGte(t: Uint<64>): Boolean
//
// Design note: `witness_memberSignatureValid` and
// `witness_multisigSignatureValid` both ultimately delegate to the same
// Ed25519 primitive that v5.2/v7/multisig-v6 use — see the reference
// implementation in `signatureValid()` below. The difference is what
// they're verifying:
//
//   member sig: single Ed25519 signature by the member's UserAddress key
//               over the ld:{op}:v1 payload
//   multisig:   threshold-of-N ring signatures per ADR-002, plus the
//               ring-hash membership check against _multisigAuthority
//
// Usage: this module is imported by the operator's Compact runtime
// integration. The Contract instance from midnight-js-contracts takes a
// witness map keyed by witness name.

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Wire the synchronous SHA-512 implementation @noble/ed25519 v3 needs.
// Idempotent — multiple imports of this module get the same hash impl.
ed.hashes.sha512 = sha512;

// =============================================================================
// Types matching contract structs
// =============================================================================

interface DivResult {
  quotient:  bigint;   // Uint<128>
  remainder: bigint;   // Uint<128>
}

/**
 * The prover-side private-state bundle the keeper / member app populates
 * before generating a proof against LD. Every LD proof needs at most:
 *
 *   - one memberSignature (for claim/touchLiveness)
 *   - one multisigBundle  (for register/unregister)
 *   - the current blockTime (for L-3 checks)
 *
 * All fields are optional; each witness only reads the fields it needs.
 */
export interface LdPrivateState {
  blockTime?:        bigint;
  memberSignature?:  Uint8Array;         // 64-byte Ed25519 signature
  multisigBundle?:   MultisigBundle;
}

export interface MultisigBundle {
  signers:   Uint8Array[];  // Ed25519 pubkeys (each 32 bytes) — the ring
  sigs:      Uint8Array[];  // parallel: sigs[i] is signer[i]'s Ed25519 sig, or null-equiv
  threshold: number;        // M in M-of-N
}

interface WitnessContext<PS> {
  privateState: PS;
}

// =============================================================================
// Core Ed25519 primitive — SAME implementation used by v5.2, v6, v7
// =============================================================================
//
// Returns true iff `signature` is a valid Ed25519 signature on `messageHash`
// under public key `pubkey`. Pure RFC 8032 verification. Synchronous.
// Never throws — malformed inputs return false.
//
// This is the exact function from
// pollpower-monorepo/pollpower-v2/apps/admin/services/proverWitness.ts,
// promoted here as the shared reference implementation.

export function signatureValid(
  pubkey:      Uint8Array,
  messageHash: Uint8Array,
  signature:   Uint8Array,
): boolean {
  if (pubkey.length !== 32) return false;
  if (messageHash.length !== 32) return false;
  if (signature.length !== 64) return false;
  try {
    return ed.verify(signature, messageHash, pubkey);
  } catch {
    // Malformed encoding (R/A not on curve, s not canonical, etc.)
    return false;
  }
}

// =============================================================================
// Multisig bundle verifier — matches ADR-002 pattern
// =============================================================================
//
// A multisig authority is committed on-chain as a single Bytes<32> hash:
//   _multisigAuthority = SHA-256( concat(sortedPubkeys) )
//
// (Or persistentHash — pick one and use it consistently across ceremony
// tooling. This implementation uses SHA-256 to match the pattern used in
// the v5.2 admin-app ceremony flow. Adjust if your admin app uses
// persistentHash for the ring commitment.)
//
// A bundle is valid iff:
//   1. The signer pubkeys hash to authorityHash (ring membership check).
//   2. At least `threshold` of the sigs are valid Ed25519 signatures of
//      `payload` under the corresponding signer's pubkey.
//   3. Threshold is at least 1 and no more than the ring size.
//
// This mirrors the on-chain check semantics of multisig-v6-ed25519.compact
// while keeping the heavy signature verification off-chain (per the
// signature_valid witness pattern that v5.2 established).

export function verifyMultisigBundle(
  bundle:        MultisigBundle,
  payload:       Uint8Array,
  authorityHash: Uint8Array,
): boolean {
  if (payload.length !== 32) return false;
  if (authorityHash.length !== 32) return false;
  if (bundle.signers.length === 0) return false;
  if (bundle.signers.length !== bundle.sigs.length) return false;
  if (bundle.threshold < 1) return false;
  if (bundle.threshold > bundle.signers.length) return false;

  // Ring membership check: SHA-256 of sorted, concatenated signer pubkeys.
  const sorted = [...bundle.signers].sort(compareUint8);
  const concat = new Uint8Array(sorted.length * 32);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].length !== 32) return false;
    concat.set(sorted[i], i * 32);
  }
  const computed = sha256(concat);
  if (!bytesEq(computed, authorityHash)) return false;

  // Count valid signatures over the payload.
  let validCount = 0;
  for (let i = 0; i < bundle.signers.length; i++) {
    if (signatureValid(bundle.signers[i], payload, bundle.sigs[i])) {
      validCount += 1;
      if (validCount >= bundle.threshold) return true;
    }
  }
  return validCount >= bundle.threshold;
}

// =============================================================================
// Witness bindings — the four the LD contract declares
// =============================================================================

/**
 * witness_divmod: prover computes q, r such that num = q*d + r  (0 <= r < d).
 * The LD contract verifies the equation and r < d in-circuit.
 */
export function witness_divmod<PS>(
  ctx:       WitnessContext<PS>,
  numerator: bigint,
  divisor:   bigint,
): [PS, DivResult] {
  if (divisor === 0n) {
    // Should be unreachable — the contract asserts totalLivingMembers > 0
    // before calling divmod. Returning zeros lets the in-circuit assertion
    // produce a clean revert if we ever hit it.
    return [ctx.privateState, { quotient: 0n, remainder: 0n }];
  }
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  return [ctx.privateState, { quotient, remainder }];
}

/**
 * witness_multisigSignatureValid: reads a MultisigBundle from private state,
 * verifies it against `payload` and `authorityHash` using the ADR-002 pattern.
 * Returns true iff the ring-hash matches AND at least `threshold` signatures
 * are valid.
 */
export function witness_multisigSignatureValid<PS extends LdPrivateState>(
  ctx:           WitnessContext<PS>,
  payload:       Uint8Array,
  authorityHash: Uint8Array,
): [PS, boolean] {
  const bundle = ctx.privateState.multisigBundle;
  if (!bundle) return [ctx.privateState, false];
  return [
    ctx.privateState,
    verifyMultisigBundle(bundle, payload, authorityHash),
  ];
}

/**
 * witness_memberSignatureValid: reads a single 64-byte Ed25519 signature from
 * private state and verifies it against `payload` under `member.bytes` (which
 * IS the member's Ed25519 pubkey — UserAddress is a Bytes<32> wrapper).
 */
export function witness_memberSignatureValid<PS extends LdPrivateState>(
  ctx:     WitnessContext<PS>,
  member:  { bytes: Uint8Array },   // UserAddress
  payload: Uint8Array,
): [PS, boolean] {
  const sig = ctx.privateState.memberSignature;
  if (!sig) return [ctx.privateState, false];
  return [ctx.privateState, signatureValid(member.bytes, payload, sig)];
}

/**
 * witness_blockTimeGte: reads the prover's known block time from private
 * state and returns true iff blockTime >= t.
 *
 * The keeper/app fetches the current block time from the indexer at
 * proof-gen time and stuffs it into privateState.blockTime before calling
 * a mutating circuit. The L-3 check is a lower bound on the tx's currentTime
 * param (currentTime must not be in the future relative to blockTime).
 */
export function witness_blockTimeGte<PS extends LdPrivateState>(
  ctx: WitnessContext<PS>,
  t:   bigint,
): [PS, boolean] {
  const blockTime = ctx.privateState.blockTime ?? 0n;
  return [ctx.privateState, blockTime >= t];
}

// =============================================================================
// Witness-map export for midnight-js runtime binding
// =============================================================================

export function makeLdWitnesses<PS extends LdPrivateState>() {
  return {
    witness_divmod:                  witness_divmod<PS>,
    witness_multisigSignatureValid:  witness_multisigSignatureValid<PS>,
    witness_memberSignatureValid:    witness_memberSignatureValid<PS>,
    witness_blockTimeGte:            witness_blockTimeGte<PS>,
  };
}

// Default export for the common case where the prover uses LdPrivateState directly.
export const witnesses = makeLdWitnesses<LdPrivateState>();

// =============================================================================
// Small byte helpers
// =============================================================================

function compareUint8(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
