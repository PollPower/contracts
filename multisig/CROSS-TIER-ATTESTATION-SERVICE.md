# Cross-Tier Attestation Service — Spec (federation-seat voting)

**Status:** DESIGN DRAFT — spec + scaffold guidance, no production code. Not
deployed, not audited.
**Layer:** Post-pilot. The pilot runs a single flat council; no federation seats
exist yet.
**Work item:** WI-21 of [`../FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md).
**Serves:** the `approveFederated` path of
[`multisig-federated-v1.compact`](./multisig-federated-v1.compact); the "climb
the tree" phase of [`FEDERATION-CHARTER-PROTOCOL.md`](./FEDERATION-CHARTER-PROTOCOL.md)
(WI-20).
**Verified against source:** `approveFederated(actionHash, seatId,
attestorSignature)` (L300+) verifies `attestorSignature` over
`federatedApprovalMsg(seatId, actionHash)` against the seat's registered
`_attestors.lookup(seatId)` key, then records the seat's approval. The service
this document specifies is what **produces that signature** — honestly.

## 0. What this document is

When a child council holds a **federation seat** in a parent tier, its vote in
the parent does not arrive as one person's signature — it arrives as an
**attested quorum**: a single `attestorSignature` that asserts "the child
council's own 3-of-5 approved this parent-level action." The contract verifies
that signature against the seat's registered attestor key; it **cannot** verify
that the child quorum actually happened — that honesty is the attestor's job.

This document specifies the off-chain **attestation service** that holds a
child council's attestor key and produces `approveFederated` signatures **only
after** independently verifying the child's own quorum. It is the trust hinge of
the whole fractal structure, so its honesty properties are the spec.

### 0.1 One-sentence contract

> The attestation service holds a child council's attestor key and signs a
> parent-level `federatedApprovalMsg(seatId, actionHash)` **only** after
> verifying that the child council's own 3-of-5 quorum approved that exact
> `actionHash` — turning a lower-tier quorum into the single upper-tier
> signature the `approveFederated` circuit consumes, with replay and
> cross-deployment guards.

---

## 1. The trust hinge (state it honestly)

`approveFederated` trusts the attestor key completely: whoever holds it can cast
the child's federation-seat vote. So the security of the fractal structure
reduces to: **does the attestor sign iff the child quorum genuinely approved?**

There are two honesty models, and the choice is the central design decision:

- **A. Trusted attestor service (v1, RECOMMENDED to start).** A service holds
  the attestor key and signs after verifying the child quorum off-chain
  (checking the child council's own on-chain `_approvals` for that actionHash
  reached threshold). Trust is in the service operating honestly + key custody.
  Simple, shippable, matches how the pilot already trusts operational keys.
- **B. Threshold/aggregated attestor (future).** The attestor "key" is itself a
  threshold signature of the child council members (FROST/MuSig-class), so the
  attestor signature is *mathematically* a child quorum — no trusted service.
  Strong but heavy (threshold-sig ceremony per child vote). Named as the
  hardening path, not v1.

v1 ships model A with the honesty properties below; the design keeps model B
open (the on-chain contract is identical — it only ever sees one signature).

---

## 2. What the service does, per parent-level action

```
INPUT:  parentActionHash, parentSeatId (this child's seat in the parent),
        the child council's contract address
STEP 1: verify the child quorum. Read the child council's on-chain _approvals
        for the CHILD-level action that authorizes this parent vote; assert it
        reached the child's threshold (3-of-5) with valid seat signatures.
STEP 2: bind + sign. Compute msg = federatedApprovalMsg(parentSeatId,
        parentActionHash) EXACTLY as the parent contract does; sign it with the
        attestor key.
STEP 3: submit. Relay approveFederated(parentActionHash, parentSeatId,
        signature) to the parent contract.
```

The load-bearing step is **1**: the service must confirm the child *actually*
decided to cast this vote, at its own quorum, before it signs. A service that
signs without step 1 is a forged upper-tier vote.

### 2.1 The child-level authorizing action

A child council votes in its parent by first passing an **internal action** ("we
approve parent-action X") through its own 3-of-5. That internal approval is what
step 1 reads. So a federation-seat vote is always two quorums deep: the child's
own council approves *casting the vote*, and the service attests that approval
upward. This preserves the §1-of-charter separation (the child governs itself;
the parent sees only the attested result).

---

## 3. Honesty & safety properties (the spec proper)

The service MUST guarantee:

1. **No-sign-without-quorum.** Never produce a signature unless step 1 verified
   the child reached threshold on the corresponding child-level action. This is
   the whole point.
2. **Exact binding.** The signed `msg` binds `parentSeatId` **and**
   `parentActionHash` (the contract's `federatedApprovalMsg` shape). The service
   must not sign a bare hash or a mismatched seat — it signs exactly what the
   parent will verify, nothing looser.
3. **Replay guard.** The service signs a given (parentSeatId, parentActionHash)
   **once**. It keeps a persistent record of signed tuples and refuses repeats,
   so a captured request cannot be re-submitted to double-count. (The parent
   contract's `_approvals` set dedups seats per action too, but the service must
   not rely on that alone.)
4. **Cross-deployment safety.** `parentActionHash` already includes the parent's
   `kernel.self()` (M-2 closure, per FEDERATED-V1-REVIEW) so a signature for one
   parent deployment cannot be replayed against another. The service MUST verify
   the actionHash it is asked to sign actually belongs to the intended parent
   contract before signing.
5. **Epoch freshness.** Child approvals are epoch-bound; the service must verify
   the child quorum is from the current epoch (stale approvals from a rotated
   child council must not be attested upward).
6. **Fail-closed.** Any doubt (child quorum unverifiable, indexer lag, key
   unavailable) ⇒ do not sign. A missing federation vote is a liveness issue
   (recoverable — the parent can wait, or the dead-council convene path exists);
   a wrongly-signed vote is a safety breach (unrecoverable governance forgery).

---

## 4. Attestor key lifecycle

- **Provisioning.** The attestor key is set when the child is seated
  (`_attestors` is written for the seat at federation time — the seat-attestor
  circuits `executeSetSeatAttestor`/`executeClearSeatAttestor` already exist).
  WI-20's charter fixes *who* generates and holds it.
- **Custody.** For model A, the key lives with the attestation service. It
  SHOULD be an HSM/hardware key (the pilot's Tangem ring path is a natural fit —
  a child council's attestor could itself be a hardware key held by the child's
  own members, not PollPower, which materially strengthens model A toward B's
  trust profile).
- **Rotation.** `executeSetSeatAttestor` rotates the key without re-seating the
  child. The service must handle rotation atomically (never a window where it
  signs with a retired key).
- **Revocation.** `executeClearSeatAttestor` (F-1 fix, rev 4 — federating is now
  reversible) removes the seat's attestor; the service must stop signing for a
  cleared seat immediately.

---

## 5. Failure modes & recovery

| Failure | Effect | Recovery |
|---------|--------|----------|
| Service down | Child's federation votes don't get cast | Liveness only; parent waits, or (if the child council itself is dark 30d) parent-convened rotation (existing) |
| Attestor key lost | Child can't vote in parent | Rotate via `executeSetSeatAttestor` (needs child governance) |
| Attestor key compromised | Forged child votes possible | `executeClearSeatAttestor` immediately; re-seat with new key; the compromise window's votes are the blast radius — argues for model B / hardware custody |
| Indexer lag (step 1 reads stale state) | Might miss/misjudge a quorum | Fail-closed (property 6); retry when caught up |

The asymmetry (property 6) is the design's spine: **liveness failures are cheap
and recoverable; safety failures are catastrophic and permanent.** Every
ambiguous case resolves toward not-signing.

---

## 6. Scaffold guidance (for a CHEAP-OK implementer)

Implementation is a keeper-class service (same shape as the LD keeper), so most
of it is delegable once this spec is fixed. A reference scaffold should:

- Subscribe to child-council `_approvals` events (MIP-0002 indexer pattern, as
  the LD keeper does).
- On a child reaching threshold for a "cast parent vote" action, run §2 steps
  1–3.
- Persist signed-tuple records (property 3) in durable storage.
- Reuse the existing Ed25519 signing + `federatedApprovalMsg` construction
  (must match the contract byte-for-byte — a `SORTITION-DRAW-SPEC`-style pinning
  of `federatedApprovalMsg` bytes is a prerequisite, same discipline as WI-09).
- Fail-closed on every error path.

The **spec** (§3 properties, §1 trust model) is BIG-model work and is this
document; the **scaffold** (event loop, signing plumbing, persistence) is
CHEAP-OK against these properties.

---

## 7. Open items

### 7.1 Design decision (Garrett / architecture)

- **Model A vs B** (§1): ship trusted-service v1, or invest in threshold-sig
  from the start? Recommendation: **A for v1, with hardware attestor custody by
  the child's own members** (gets much of B's trust profile cheaply), B as the
  documented hardening path.

### 7.2 Prerequisite

- Pin `federatedApprovalMsg` byte layout in a companion (like WI-09 did for the
  draw), so the service and contract agree byte-for-byte.

### 7.3 Calibration (`TODO(calibration)`)

- Indexer-lag tolerance / retry cadence for step 1.
- Signed-tuple retention window.

---

## 8. One sentence

> The cross-tier attestation service is the off-chain honesty layer that turns a
> child council's own 3-of-5 quorum into the single `attestorSignature` the
> parent's `approveFederated` circuit consumes — signing a byte-exact
> `federatedApprovalMsg(seatId, actionHash)` only after verifying the child
> reached its threshold this epoch, guarding against replay and cross-deployment,
> and failing closed on every ambiguity because a missed vote is recoverable
> liveness while a forged vote is permanent governance capture.

---

*DESIGN DRAFT, 2026-07-13. Spec + scaffold guidance, no production code. WI-21
of the Federation Implementation Plan; serves the existing `approveFederated`
mechanism. Post-pilot.*
