# Cohort Registration — Circuit Spec (LD national-scale enrollment)

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot, post-government-MOU. The pilot uses one-at-a-time
`register()`; nothing here is on the pilot's critical path.
**Work item:** WI-05 of [`../FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md).
**Formalizes:** [`../NATIONAL-ONBOARDING-PROTOCOL.md`](../NATIONAL-ONBOARDING-PROTOCOL.md)
Phase 3 (the Merkle-cohort registration that closes finding B-3), §4 (throughput/cost),
W-2 (registrar corruption); and finding B-3 of
[`../FEDERATED-TARIFF-OPEN-QUESTIONS.md`](../FEDERATED-TARIFF-OPEN-QUESTIONS.md).
**Extends:** [`living-dividend-v2.2.1.compact`](./living-dividend-v2.2.1.compact) —
adds a cohort-registration path alongside the existing one-at-a-time `register()`.
**Implements decision:** D-2 (SmileID-only KYC) — cohort-member uniqueness keys
on the existing `_seenKycJobHashes` scheme, no canonical-person commitment needed
until a second provider exists.
**Blocks:** national-onboarding Phase 3.

## 0. What this document is

The deployed `register()` is one signed multisig ceremony **per person**
(verified: L215–L261 — a `Vector<5>` `ld:register:v2` payload multisig-signed,
a `_seenKycJobHashes` insert, a `_totalLivingMembers` bump, per call). At
national scale that is a 3-of-5 human ceremony per villager — the multisig
becomes the bottleneck on the exact metric (mint velocity / inclusion) the
architecture optimizes. That is finding **B-3**.

This spec adds a **cohort-registration path**: a federation-countersigned
Merkle root admits a whole verified cohort in one ceremony; individuals prove
themselves into the roll **on demand at first claim/touch**. It does **not**
remove the existing `register()` — the two coexist (pilot and small operators
keep the simple path; national rolls use cohorts).

### 0.1 One-sentence contract

> A federation-countersigned **cohort root** commits a whole verified cohort in
> one ceremony; a member later proves a Merkle path from their leaf to that
> root to materialize their own `MemberState` on demand — so registration
> throughput goes from ceremony-per-person to ceremony-per-cohort, and members
> who never claim never touch the chain individually.

---

## 1. The design in one picture

```
OFF-CHAIN (registrar, per cohort)              ON-CHAIN
  verify N members' KYC (SmileID)     ──►  submitCohortRoot(root, meta, sigs)
  build canonical cohort leaves            [multisig + registrar co-sign,
  compute cohortRoot (Merkle)               quota-checked, challenge window
                                            opens]
                                              │
MEMBER (later, on first claim/touch)          ▼
  hold Merkle path to my leaf     ──►  proveInAndRegister(leaf, path, root)
                                            [verify path→root; verify root is
                                             committed + past challenge window;
                                             KYC-unique; materialize MemberState]
                                              │
                                              ▼
                                         member is now a normal LD member;
                                         claim() / touchLiveness() unchanged
```

Two new circuits (`submitCohortRoot`, `proveInAndRegister`), a handful of new
ledger fields, and a delegated-registrar authority model. Everything downstream
(accumulator, claim, prune, liveness) is **unchanged** — a cohort member, once
proven in, is byte-identical to a `register()`-ed member.

---

## 2. New ledger state

```
// Cohort roots that have been committed by a registrar + federation.
export ledger _cohortRoots: Map<Bytes<32>, CohortMeta>;   // key = cohortRoot

struct CohortMeta {
  registrar:        Bytes<32>    // the delegated registrar id that submitted it
  nationRef:        Bytes<32>    // scope (same-tree id; D-4)
  memberCount:      Uint<32>     // claimed size (for quota accounting)
  committedAt:      Uint<64>     // block time of submission
  challengeEndsAt:  Uint<64>     // committedAt + CHALLENGE_WINDOW (TODO(calibration))
  revoked:          Boolean      // set true if the cohort is challenged out
}

// Delegated registrars: federation-granted, federation-revocable, quota-bounded.
export ledger _registrars: Map<Bytes<32>, RegistrarState>;   // key = registrar id

struct RegistrarState {
  quotaRemaining:   Uint<32>     // members this registrar may still admit
  isActive:         Boolean      // federation can flip false to revoke
  nationRef:        Bytes<32>    // scope
}

// Prevents the same leaf being proven-in twice (per-cohort).
export ledger _provenLeaves: Set<Bytes<32>>;   // key = hash(cohortRoot ‖ leaf)
```

`_seenKycJobHashes` (existing) is **reused** for KYC uniqueness — a cohort
member's `kycAttestationHash` is checked against it at `proveInAndRegister`
exactly as `register()` does, so cross-path duplicates are impossible.

---

## 3. Leaf encoding (canonical, deterministic)

A cohort member's leaf commits everything `register()` would have written,
so proving-in is equivalent to having registered:

```
leaf = persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "ld:cohortleaf:v1"),          // domain tag (reserved here)
    member.bytes,                          // UserAddress (32)
    kycAttestationHash,                    // the SmileID job hash (32)
    (registeredAtIntent as Field) as Bytes<32>   // the cohort's intended registeredAt
])
```

- **Canonical cohort ordering:** leaves sorted ascending by `member.bytes`
  (lexicographic, total — the same discipline as the sortition table and the
  tariff schedule). Binary Merkle tree, domain-separated internal nodes
  `persistentHash([pad(32,"ld:cohortnode:v1"), left, right])`, pad to next
  power of two with a sentinel `persistentHash([pad(32,"ld:cohortpad:v1")])`
  (weight/undrawable concept N/A here — padded leaves simply never match a real
  member).
- Domain tags `ld:cohortleaf:v1`, `ld:cohortnode:v1`, `ld:cohortpad:v1`
  reserved here. (A `SORTITION-DRAW-SPEC`-style companion should pin the exact
  Merkle arity/padding bytes before implementation — same discipline as WI-09.)

`registeredAtIntent` is fixed at cohort-build time and committed in the leaf so
the member's tenure clock (§6) is not gameable at prove-in time.

---

## 4. Circuit: submitCohortRoot (the one ceremony per cohort)

```
submitCohortRoot(
  cohortRoot:  Bytes<32>,
  registrar:   Bytes<32>,
  nationRef:   Bytes<32>,
  memberCount: Uint<32>,
  currentTime: Uint<64>,
  // + federation multisig signature over the payload, + registrar signature
)
```

Checks (all asserted):

1. **Initialized + time sane** (existing pattern: `witness_blockTimeGte`).
2. **Federation countersignature** over a `Vector<N>` `ld:cohortroot:v1` payload
   `[domain, self, cohortRoot, registrar, nationRef, memberCount, time]`,
   verified against `_multisigAuthority` — the **same** `witness_multisigSignatureValid`
   pattern `register()` uses (L232). This is the "federation admits members"
   power (NATIONAL-ONBOARDING §1).
3. **Registrar authority + quota.** `_registrars.lookup(registrar).isActive`
   and `quotaRemaining >= memberCount`; decrement `quotaRemaining` by
   `memberCount`. This bounds a corrupt registrar's blast radius to its quota
   (W-2).
4. **Registrar signature** over the same payload (proves the registrar
   proposed this exact root — registrars propose, federation admits).
5. **Fresh root.** `!_cohortRoots.member(cohortRoot)`.
6. Insert `CohortMeta` with `challengeEndsAt = currentTime + CHALLENGE_WINDOW`
   (`TODO(calibration)`), `revoked = false`.

Note: `submitCohortRoot` does **not** touch `_totalLivingMembers` — a committed
cohort is not yet a set of living members. Members count only when they
prove in (§5). This is what makes the cost profile "roots + claims-on-demand"
(NATIONAL-ONBOARDING §4): the unclaimed population is free.

### 4.1 Registrar delegation (grant/revoke)

Two federation-multisig-gated circuits, same signature model:

- `grantRegistrar(registrar, nationRef, quota, currentTime, +fedSig)` — inserts/
  updates a `RegistrarState`, `isActive = true`.
- `revokeRegistrar(registrar, currentTime, +fedSig)` — flips `isActive = false`.
  Already-committed roots survive revocation (their members can still prove in
  during/after the challenge window unless the root itself is challenged);
  revocation only stops *new* submissions. Trust-shape mirrors ProducerRegistry
  gating one level down (NATIONAL-ONBOARDING Phase 3).

### 4.2 Challenge-out (public contestability of a cohort root)

`challengeCohortRoot(cohortRoot, currentTime, +fedSig)` — during the challenge
window, the federation (on a substantiated public challenge) may set
`revoked = true`, which permanently blocks prove-in against that root. This is
the "public challenge window on cohort roots" of NATIONAL-ONBOARDING W-2. The
substantiation is off-chain/procedural; the on-chain effect is the revoke flag.

---

## 5. Circuit: proveInAndRegister (member materializes on demand)

```
proveInAndRegister(
  member:             UserAddress,
  kycAttestationHash: Bytes<32>,
  registeredAtIntent: Uint<64>,
  cohortRoot:         Bytes<32>,
  merklePath:         Vector<MAX_COHORT_DEPTH, Bytes<32>>,   // sibling hashes
  pathDirections:     Vector<MAX_COHORT_DEPTH, Boolean>,     // left/right at each level
  currentTime:        Uint<64>,
  // + member signature (relayed-submission pattern, same as claim/touch)
)
```

Checks (all asserted):

1. **Cohort committed + not revoked + past challenge window.**
   `_cohortRoots.member(cohortRoot)`, `!meta.revoked`,
   `currentTime >= meta.challengeEndsAt` (checked-cast; a member cannot prove in
   until the challenge window closes — this is what gives the window teeth).
2. **Recompute the leaf** from `(member, kycAttestationHash,
   registeredAtIntent)` per §3.
3. **Verify the Merkle path.** Fold `merklePath`/`pathDirections` up with the
   domain-separated node hash and assert the computed root `== cohortRoot`.
   `MAX_COHORT_DEPTH` is a compile-time bound (`TODO(calibration)`; e.g. 20 →
   up to ~1M leaves per cohort).
4. **Not already proven in.** `!_provenLeaves.member(hash(cohortRoot ‖ leaf))`;
   insert it. (Prevents double-materialization of the same leaf.)
5. **KYC-unique.** `!_seenKycJobHashes.member(kycAttestationHash)`; insert it —
   the **same** guard as `register()`, so a person in a cohort who also somehow
   holds a direct registration cannot double up.
6. **Member signature** (relayed-submission — the member's own key authorizes
   materialization; PollPower's relay pays DUST, per LD DESIGN §3).
7. **Materialize `MemberState`** exactly as `register()` does:
   `accPerShareAtCheckpoint = _accPerShare` (they start accruing from *now*, not
   from cohort-commit — see §6), `lastSeen = currentTime`,
   `registeredAt = registeredAtIntent`, `isLive = true`; insert into `_members`;
   `_totalLivingMembers += 1`.

After step 7 the member is indistinguishable from a `register()`-ed member;
`claim`, `touchLiveness`, `proposePrune`, `executePrune` all operate on them
unchanged.

### 5.1 The accumulator-fairness decision (important)

A cohort member's `accPerShareAtCheckpoint` is set to `_accPerShare` **at
prove-in time**, not at cohort-commit time. Consequence: a member accrues
dividend only from when they actually prove in, **not** retroactively from when
their cohort was committed. This is correct and deliberate:

- It preserves the accumulator invariant (a member's owed =
  `accPerShare - checkpoint`; a checkpoint from the past would mint them
  dividend for a period they were not a counted living member).
- It matches claim-on-demand economics: the unclaimed cohort population does
  not dilute the accumulator (they are not in `_totalLivingMembers` until
  prove-in), so existing members are not diluted by paper enrollment
  (interacts cleanly with the D-3 national-pool decision — the pool is not
  watered down by cohorts that haven't materialized).
- `registeredAt` still uses `registeredAtIntent` (the cohort's intent) so the
  liveness/tenure clock and the sortition maturity gate see the *true* enrollment
  date, while the *dividend* checkpoint starts at prove-in. Tenure and accrual
  are deliberately decoupled: you get credit for *when you were enrolled* for
  maturity/liveness, but you accrue dividend only for the period you are an
  actually-materialized living member.

This decoupling is the subtle heart of the spec and MUST be preserved in
implementation — getting it wrong either dilutes existing members (checkpoint
too early) or denies cohort members their tenure (registeredAt too late).

---

## 6. What is NOT changed (and must not be)

- **The accumulator** (`_accPerShare`, `bumpOnMint`, `checkedDivide`) — untouched.
- **`claim` / `touchLiveness` / prune** — untouched; cohort members use them as-is.
- **The one-at-a-time `register()`** — kept, for pilot + small operators.
- **KYC uniqueness scheme** — stays `_seenKycJobHashes` keyed on the SmileID
  `hash(providerTag, jobIdHash)` (D-2); no canonical-person commitment (WI-04)
  until a second provider exists.
- **LD-C-1 / LD-H-3 hardening** (blockTimeGte time gates, keeper-signed
  bumpOnMint from v2.2.2) — the cohort path uses the same `witness_blockTimeGte`
  discipline; it introduces no new prover-controlled time input.

---

## 7. Compact realization notes (for the implementing session)

- **Merkle verification is bounded iteration** over `MAX_COHORT_DEPTH` levels;
  fold with `persistentHash<Vector<2>>` per level, selecting sibling order by
  `pathDirections[i]`. No data-dependent loop bound (Compact forbids it) — always
  iterate the full `MAX_COHORT_DEPTH`, using a "reached root" flag for shallower
  trees, or require all cohorts padded to exactly `MAX_COHORT_DEPTH` (simpler;
  recommended).
- **All comparisons via checked-cast** (`currentTime >= challengeEndsAt`), never
  `Field` `<` (LD DESIGN Compact-lessons #4).
- **`disclose()`** on every witness-origin value flowing to a ledger write
  (member, hashes, times) — same as `register()`.
- **Signatures**: reuse `witness_multisigSignatureValid` (federation),
  `witness_memberSignatureValid` (member); add a `witness_registrarSignatureValid`
  or fold the registrar sig into the multisig payload — implementer's call,
  documented in the diff.
- **New domain tags** to reserve: `ld:cohortroot:v1`, `ld:cohortleaf:v1`,
  `ld:cohortnode:v1`, `ld:cohortpad:v1`, `ld:registrar:v1`.

---

## 8. Adversarial register (what this must resist)

- **W-2 registrar corruption** — bounded by `quotaRemaining` (a corrupt
  registrar can only admit up to its quota), the federation countersignature
  (registrar proposes, federation admits), the challenge window + revoke, and
  revocability. Residual risk is bounded by quota size (`TODO(calibration)`).
- **Ghost-claim farming (W-3)** — a cohort full of fake leaves is worthless
  until a fake member's key proves in *and* passes KYC uniqueness; the claim
  path requires member-held keys. Unclaimed ghosts cost the attacker cohort-build
  effort and yield nothing (they never enter `_totalLivingMembers`).
- **Double-materialization** — blocked by `_provenLeaves` (per-cohort-leaf) and
  `_seenKycJobHashes` (cross-path KYC).
- **Retroactive-dividend theft** — blocked by §5.1 (checkpoint set at prove-in,
  never at commit).
- **Challenge-window bypass** — blocked by the `currentTime >= challengeEndsAt`
  gate on prove-in; no member materializes before the window closes.
- **Cross-deployment replay** — every signed payload includes
  `disclose(kernel.self()).bytes` (the existing LD-3 discipline).

---

## 9. Acceptance criteria (for the implementing session + reviewer)

The implementation MUST:

1. Full-ZK compile clean on compactc 0.31.0 (the whole-contract bar, not
   `--skip-zk`).
2. Leave every existing circuit (register, claim, bump, prune, touch) and every
   existing ledger field byte-identical in behavior (regression suite green).
3. Reject prove-in before the challenge window closes; after revoke; on a bad
   Merkle path; on a reused leaf; on a reused KYC hash; on quota exhaustion at
   submit.
4. Set a cohort member's `accPerShareAtCheckpoint` at prove-in, `registeredAt`
   at intent (§5.1) — with a test asserting a member proven in *after* several
   `bumpOnMint`s accrues **zero** for the pre-prove-in period.
5. Produce deterministic cohort roots (two independent builders agree — the
   WI-09/WI-15 two-implementations discipline).
6. Bound registrar blast radius to quota (test: over-quota submit rejected).

Test-vector obligation: cohort build + prove-in round-trip; every reject path;
the §5.1 no-retroactive-accrual assertion; a challenge-then-revoke blocking
prove-in.

---

## 10. Open calibration items (Garrett's call — do NOT invent)

| # | Parameter | Section |
|---|-----------|---------|
| CAL-CHALLENGE | Challenge-window length | §4, §5 |
| CAL-QUOTA | Per-registrar quota (blast-radius bound) | §4.1, §8 |
| CAL-DEPTH | `MAX_COHORT_DEPTH` (max cohort size = 2^depth) | §3, §5, §7 |
| — | Whether death-record hint feeds inform proposePrune (NATIONAL-ONBOARDING §6 open item) — orthogonal to this spec | — |

All are `TODO(calibration)`; the spec is complete without their values.

---

## 11. One sentence

> Cohort registration adds two circuits to the Living Dividend — a
> federation-countersigned, quota-bounded, challengeable `submitCohortRoot` that
> commits a verified cohort's Merkle root in one ceremony, and a
> member-signed `proveInAndRegister` that verifies a Merkle path and
> materializes a normal `MemberState` on demand (checkpointing dividend accrual
> at prove-in but tenure at intent) — turning national enrollment from a
> ceremony-per-person bottleneck into roots-plus-claims-on-demand, while reusing
> the existing KYC-uniqueness, accumulator, claim, and prune machinery unchanged.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code. Post-pilot.
WI-05 of the Federation Implementation Plan; extends living-dividend-v2.2.1.*
