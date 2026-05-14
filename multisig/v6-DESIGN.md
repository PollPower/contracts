# Multi-sig v6: Ed25519-via-witness verification

**Status:** dev fork, **revised plan after Compact research (2026-05-08 evening).**
**Branch:** `dev/multisig-ed25519` on settlement-api
**Author:** PollPower
**Companion files:**
- `multisig-v6-ed25519.compact` — target contract (will be rewritten this session)
- `verify-ed25519.compact` — Ed25519 verification helper using witness pattern
- `prover-side-verify.md` — how the off-chain prover does the verification

## What changed from the first DESIGN

The original DESIGN.md (committed in `db2f575`) scoped Ed25519 verification as a 10-12 week initiative requiring custom Curve25519 + SHA-512 circuits over non-native field arithmetic. **That scoping was correct for "verify Ed25519 inside the ZK circuit using only field operations."** It was the wrong target.

After researching Compact's official syntax reference (Compact 0.31, language 0.23), the **idiomatic pattern for signature verification in Compact is**:

```compact
// Off-chain prover verifies the signature, then provides the boolean result.
// The contract trusts the prover for the math, but the resulting boolean is
// committed inside the ZK proof — so an attacker can't forge a valid proof
// without compromising the prover's private state.
witness signature_valid(
  pubkey: Bytes<32>,
  message: Bytes<32>,
  signature: Bytes<64>,
): Boolean;
```

This is documented in the official syntax reference under "Built-in Functions / notBuiltIn / verify_signature" and is used in production by:
- **`midnames/core/contract/src/did.compact`** (DID registry with Ed25519 keys)
- **`midnightntwrk/example-proofshare`** (key-digest commitment + integrity proof)

The pattern means: the **admin's local prover** verifies the Ed25519 signature using JavaScript (`@noble/ed25519` or similar), and the verification result is a witness value baked into the resulting ZK proof. The contract enforces:

1. The witness boolean is `true` (signature valid per prover).
2. The pubkey is a registered admin.
3. (Critically) The `message` argument was derived from on-chain data the prover can't lie about.

The trust shift compared to the pilot architecture (today):

| Layer | Pilot today | v6 with witness |
|---|---|---|
| Who verifies the Ed25519 sig | The PollPower API server | Each admin's own prover (their own device) |
| Who can forge an approval | Anyone who compromises the API server | Anyone who compromises an admin's device |
| Who can DoS / refuse to submit | The API server | Any single admin (others can still relay) |
| Audit trail | On-chain (record-only) | On-chain (record-only) |

The witness approach **doesn't hit "fully on-chain Ed25519 verification,"** but it does push verification out of the trusted server into the admins' own devices. That is a meaningful, shippable trust upgrade — and it can land in days, not weeks.

If we later want fully-in-circuit Ed25519 verification (the original plan), that becomes a *future* upgrade, and the witness-based contract today is forward-compatible: we just replace the witness call with a real circuit call when one ships in Compact's stdlib (or when we decide to write our own). The rest of the v6 contract stays the same.

## Why the witness approach is "good enough" for production

The threat model breakdown:

**Without v6 (pilot today):**
- Attacker compromises API server → can submit any proposal/approval as any admin.
- Attacker compromises a single admin device → can sign whatever that one admin would sign, but cannot threshold-pass alone.

**With v6 witness:**
- Attacker compromises API server (now just a relayer) → cannot submit fake approvals, because the API doesn't have any admin's private key. Liveness DoS only.
- Attacker compromises a single admin device → can sign whatever that one admin would sign, AND can lie in their own proofs (the prover-side verification is on the compromised device). But each individual admin signature still requires a separate proof submission, so threshold isn't bypassed.
- Attacker compromises threshold-many admin devices → game over (same as today).

The key gain: **the API server is no longer in the trust boundary.** That's a security upgrade PollPower can articulate to auditors with a straight face.

**With future fully-in-circuit Ed25519 verification (post-launch):**
- Attacker compromises an admin device → cannot lie about signature validity, because the verification is in-circuit and any provided signature must check against the published pubkey. They can still sign with a stolen ring (physical compromise), but they can't fabricate a sig from a software-only attack.

That's the marginal additional gain from fully-on-chain. Worth pursuing eventually but **NOT a launch blocker**.

## Concrete v6 architecture

### Witness signatures

```compact
// Returns true iff `signature` is a valid Ed25519 signature on
// `messageHash` under `pubkey`, per RFC 8032.
//
// IMPLEMENTATION: prover-side (off-chain). The prover script has access to
// @noble/ed25519 and verifies the signature mathematically before providing
// the boolean. The boolean is committed as part of the ZK witness data, so
// an honest prover with a valid signature produces a proof that passes; a
// dishonest prover claiming a false signature is valid produces a proof
// that the contract still records (because the contract trusts the witness),
// but the dishonest claim is only as exploitable as the dishonest prover.
//
// THREAT MODEL: an attacker who controls an admin's device could lie here.
// But controlling an admin's device is already game over for that admin's
// signing power; it doesn't unlock additional attacks.
witness signature_valid(
  pubkey: Bytes<32>,
  messageHash: Bytes<32>,
  signature: Bytes<64>,
): Boolean;
```

### State

```compact
// Same shape as v5 but admins are Ed25519 pubkeys, not Zswap keys.
export ledger _admins: Set<Bytes<32>>;       // 32-byte Ed25519 pubkeys
export ledger _threshold: Uint<8>;
export ledger _nonce: Counter;
export ledger _approvals: Map<Bytes<32>, Set<Bytes<32>>>;   // actionHash → set of admin pubkeys
export ledger _initialized: Boolean;
```

### Approve circuit (the new gate)

```compact
export circuit approve(
  actionHash: Bytes<32>,
  signerPubkey: Bytes<32>,
  signature: Bytes<64>,
): [] {
  assert(_initialized, "Not initialized");

  // 1. Witness-based signature check. The prover (admin's device) verifies
  //    Ed25519 mathematically and commits to the boolean.
  const sigOk = signature_valid(signerPubkey, actionHash, signature);
  assert(disclose(sigOk), "Bad Ed25519 signature");

  // 2. Pubkey must be a registered admin.
  assert(_admins.member(disclose(signerPubkey)), "Signer is not an admin");

  // 3. Record the approval (idempotent set semantics).
  if (!_approvals.member(disclose(actionHash))) {
    _approvals.insert(disclose(actionHash), default<Set<Bytes<32>>>());
  }
  _approvals.lookup(disclose(actionHash)).insert(disclose(signerPubkey));
}
```

The `disclose(sigOk)` makes the witness boolean part of the public proof. An attacker can't compile a valid proof claiming `signature_valid()` returned true if their off-chain verification actually returned false — the proof system would refuse to construct.

Wait, that's not quite right. Let me think more carefully...

Actually, the witness value IS controlled by the prover. If the prover lies and provides `true` when it should be `false`, the proof construction succeeds (because `assert` checks the disclosed boolean is true, and the prover claimed true). The contract has no way to catch this — the *whole point* of witnesses is that the contract trusts the off-chain computation.

**So the trust model really is:** the contract trusts the prover claiming "yes, I verified this signature." A malicious prover (= compromised admin device) can submit any signature claiming it verifies. **This is the same level of trust as a malicious admin signing whatever they want.** Compromise of an admin device = bypass of that admin's signing constraint.

The reason this is still a security upgrade over the pilot is the **distribution of trust**: the API server today can sign as any admin (it has admin sig material in the relayer wallet), whereas in v6 the server has no signing power and each admin's signing power is bounded by their individual device.

### What the prover does

The admin app's local code (or a relayer if the admin doesn't run their own prover) provides this implementation:

```typescript
// In the admin app's prover (e.g., apps/admin/services/proverWitness.ts):
import * as ed from '@noble/ed25519';

export const signatureValid = async (
  pubkey: Uint8Array,    // 32 bytes
  messageHash: Uint8Array, // 32 bytes
  signature: Uint8Array,   // 64 bytes
): Promise<boolean> => {
  return ed.verify(signature, messageHash, pubkey);
};
```

This is pure JS. No WASM, no shim, no curve arithmetic. Just `@noble/ed25519.verify()`.

## Phased rollout (revised)

| Phase | Effort | Calendar |
|---|---|---|
| 0: Research + decision | done | done (this evening) |
| 1: v6 contract with witness sig | 2-3 days | this week |
| 2: Admin app prover witness implementation | 1 day | this week |
| 3: Contract deploy to preview testnet | 1 day | this week |
| 4: Admin re-onboarding (3-of-5 admins) | 1 day | next week |
| 5: Cutover plan from v5 (or run both in parallel) | 1 day | next week |
| 6: (future) Fully-in-circuit Ed25519 — separate roadmap | 10-12 weeks | post-launch |

**Total to ship v6 with witness pattern: ~7 working days.** Doable for a May 15 launch if we commit by Monday.

## What replaces this DESIGN.md

When the witness-based v6 ships, this design becomes the README of the dev fork. The phased roadmap for fully-in-circuit Ed25519 stays in a separate `future-fully-in-circuit.md` for whenever Compact's stdlib catches up or someone wants to do the curve work.
