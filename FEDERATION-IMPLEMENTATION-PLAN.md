# Federation Implementation Plan — Work Breakdown & Delegation Framework

**Status:** IMPLEMENTATION PLAN — spec only, no contract code. Not deployed,
not audited.
**Layer:** Post-pilot. Nothing in this plan touches the pilot's critical path.
The pilot runs a single operator, a single flat rate, EBT v7.4.2 + Multisig v7
+ LD v2.2.x, and none of that changes here.
**Synthesizes:** [`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md)
(PR #11), [`FEDERATED-TARIFF-OPEN-QUESTIONS.md`](./FEDERATED-TARIFF-OPEN-QUESTIONS.md)
+ [`STATUTORY-LANES.md`](./STATUTORY-LANES.md) (PR #12),
[`NATIONAL-ONBOARDING-PROTOCOL.md`](./NATIONAL-ONBOARDING-PROTOCOL.md) (PR #13),
[`multisig/SORTITION-TABLE-DESIGN.md`](./multisig/SORTITION-TABLE-DESIGN.md) (PR #10),
and the "Governance: the Fractal Federation" section of the root
[`README.md`](./README.md) (PR #9).

## 0. What this document is

The design-doc series (PRs #9–#13) describes *what* the federation layer is.
This document turns it into *buildable, delegable work*: a dependency-ordered
work breakdown, a sequencing strategy that puts the two must-solve blockers
first, self-contained task briefs suitable for cheaper models executing under
supervision, and the verification loop that keeps supervised output honest.

Two audiences:

1. **Garrett + a supervising session** (Fable/Opus class) — owns sequencing,
   reviews all output, makes every calibration call.
2. **Executing sessions** (cheaper models) — receive one work-item brief at a
   time (§5), with no assumed session memory and no assumed judgment. The
   brief carries all the judgment.

### 0.1 The constitutional preamble — separation of powers

Every work item below serves one separation, stated here once so no
implementation ever blurs it:

> **Companies price. Members bound. The mint pays.**
>
> - **Companies get the leaves.** Their tariff schedule, their line splits,
>   their margin — shareholder logic, permissionless iteration within the
>   cascaded floors (architecture §5). Nobody votes on a company's prices.
> - **Members get the constitution.** Federation councils — drawn by
>   sortition from KYC'd, settlement-active, LD-mature *members* — set the
>   LD floor, the ops floor, the sanity band, and gate who may become a
>   company or a line of business at all. Consumers do not set prices; they
>   set the bounds every price must satisfy, and the LD floor pays them on
>   every kWh sold regardless of which supplier they chose.
> - **The mint pays.** Mint-after-payment (I-2) and 1 EBT = 1 kWh (I-1) are
>   nobody's lever — not the companies', not the councils', not the state's.
>
> Combined with NATIONAL-ONBOARDING §1 (*the state attests persons, the
> federation admits members, the mint pays dividends*), the full power map
> has four actors — companies, members, state, mint — and no actor holds two
> powers.

Two honest caveats the plan does not paper over:

- **"Choose a different supplier" is weak at the edge.** Rural mini-grids are
  natural monopolies; exit barely exists, so *voice* (the member-held
  constitution) carries the load. That is why the floors are constitutional
  rather than contractual. Operator agreements and public messaging should
  say this plainly rather than lean on a competition story that will not
  exist in a one-grid village.
- **Corporate capture of seats is not yet forbidden anywhere.** The sortition
  gate selects members, but an operator's owners and staff are members too
  (finding C-2, finding B-2). WI-23 exists to close this explicitly.

### 0.2 Standing discipline (applies to every work item)

- **Verify against source, not summaries.** Before planning or building
  against a contract behavior, read the circuit. The sortition work
  established this norm; it holds. Claims in this plan were themselves
  verified against `multisig-federated-v1.compact` (rev 4, 19 exported
  circuits, no `_members`/`membershipRoot` ledger field) and
  `living-dividend-v2.2.1.compact` (9 exported circuits, one-at-a-time
  multisig-gated `register`).
- **Production lineage is untouchable.** EBT v7.4.2 + Multisig v7 + LD v2.2.x
  (v2.2.2 staged) are the pilot. `multisig-federated-v1` is DEV DRAFT — not
  deployed, not audited. No work item modifies a deployed production
  contract; all contract work is on new versions or new lineages.
- **Compact constraints shape everything:** no contract-to-contract calls
  (MIP-0002 event + keeper is the integration pattern); no integer `/` or `%`
  in-circuit (witness-computed divmod, `checkedDivide` pattern); `Field` has
  no `<`/`<=` (checked-cast tricks); witness values into ledger writes need
  `disclose()`; sealed fields need `constructor()`; compiler is
  **compactc 0.31.0**.
- **Contract changes take the full cycle, every time:** design → compile-clean
  (full ZK, not `--skip-zk`) → offline tests → adversarial review →
  deploy ceremony. No step skipped, no matter how small the diff.
- **Same tree, one identity.** The governance tree and the tariff tree are
  the same nested structure (architecture §3). Charter objects (WI-20) and
  TariffRegistry node references (WI-13) MUST use the same on-chain
  identities for nation/company nodes, or the two trees drift. This is a
  standing invariant, checked in review for every item that touches either.

---

## 0.3 Decisions taken (2026-07-12, Garrett)

Two Tier-0/Tier-1 questions were decided in-session on 2026-07-12; the work
breakdown below reflects them.

- **D-1 (resolves A-2 direction / WI-01 scope):** backing fiat lives in a
  **protocol-controlled national escrow pool**. Operators originate consumer
  payments into it and instruct splits out of it; they never own the float.
  WI-01 is therefore no longer a *whether* question — its remaining scope is
  the *how*: legal wrapper per nation, solvency accounting, operator-insolvency
  isolation, wind-down interaction (C-9), and the regulatory posture.
- **D-2 (re-scopes WI-04/WI-12):** **SmileID is the sole KYC provider going
  forward** for the Kenya market; other markets get their own investigation
  when they exist. Consequences:
  - The C-4 cross-provider duplicate hole is closed *operationally* (one
    provider ⇒ no second door), not cryptographically. The binding invariant
    becomes: **the off-chain pipeline's national-ID-number dedup is sound**
    — auditable, and now a named review item for WI-05/WI-11.
  - WI-04 and WI-12 are **deferred until a second market or second provider
    is real**. They stay specified (the designs in the onboarding doc remain
    valid) but are off the critical path.
  - WI-05/WI-11 (cohort registration) lose their WI-04 dependency and key
    cohort-member uniqueness on the existing `hash(providerTag, jobIdHash)`
    scheme with providerTag fixed to SmileID.
  - The constitutional principle *"multiple KYC doors, never the only door"*
    (NATIONAL-ONBOARDING §1) is **unchanged as a design commitment** —
    SmileID-only is operational reality, not a constitutional amendment. The
    anti-identity-lever posture stays intact for the government conversation.

---

## 1. Work breakdown

Legend — **Size:** S / M / L. **Risk:** 💰 touches-funds · 🏛 governance ·
📖 read-only/spec. **Exec:** who may execute — `BIG` (Fable/Opus-class only),
`CHEAP-OK` (delegable to a cheaper model with the §5 brief), `GARRETT`
(human decision).

### Tier 0 — Blocking decisions (nothing in Tier 2's settlement path ships before these)

| ID | Item | Scope | Size | Risk | Exec | Depends on | Blocks |
|----|------|-------|------|------|------|-----------|--------|
| **WI-01** | **A-2: National escrow / custody of backing fiat** — **direction DECIDED per D-1** (protocol-controlled national escrow pool; operators never own the float). Remaining scope is the *how*: legal wrapper per nation, solvency accounting, regulatory posture, operator-insolvency isolation, wind-down interaction (C-9). | L | 💰 | BIG + GARRETT | — (direction set) | WI-02, WI-03, WI-14, onboarding Phase 2 wallet tiers, C-9 |
| **WI-02** | **A-1: Intra-national clearinghouse** | Design doc: inter-operator netting when EBT earned on grid A is redeemed on grid B. Continuous netting in EBT terms, periodic fiat true-up, who carries the inter-operator book (protocol-operated vs licensed role), credit-risk limits. Ports the §7.3 border mechanism inward. Lands as a §3.5-class addition to the architecture doc. | L | 💰 | BIG + GARRETT | WI-01 | WI-14, second-operator onboarding |
| **WI-03** | **B-1: Fungibility stance amendment** | Amend architecture doc with an explicit stance: per-coin backing metadata is an *audit* artifact; *redemption value* is pooled at the national escrow (or the explicit alternative if Garrett rules otherwise). Also resolves C-3 (who can read the tariff path — poverty-marker privacy). | S | 📖 | BIG | WI-01 | WI-14 redemption semantics |

### Tier 1 — Design specs, parallelizable now

| ID | Item | Scope | Size | Risk | Exec | Depends on | Blocks |
|----|------|-------|------|------|------|-----------|--------|
| **WI-04** | **C-4: Canonical-person identifier scheme** — **DEFERRED per D-2** (single-provider posture makes it moot until a second market/provider). Spec retained for that day: salted commitment over national-ID number vs cross-provider dedup attestation; threat model: state linkage, dictionary attack on ID-space, provider collusion. | M | 🏛 | BIG + GARRETT | second market | WI-12 (deferred with it) |
| **WI-05** | **B-3: Cohort-registration circuit spec** | Full spec for Merkle-cohort LD registration (NATIONAL-ONBOARDING Phase 3): leaf encoding, root submission by delegated registrar, federation countersignature, quota accounting, challenge window, prove-in-at-first-claim flow, revocation. Trust-shape mirrors ProducerRegistry gating one level down. Uniqueness keyed on the existing SmileID `hash(providerTag, jobIdHash)` per D-2; pipeline ID-number dedup soundness is a named review item. | L | 💰 | BIG | — | WI-11 |
| **WI-06** | **TariffSchedule / SplitPolicy data model + validator spec** | Canonical serialization of the schedule tree (§3.1–3.2), the registration-time validator algorithm (every path × every cascaded floor × sanity band × statutory applicability), epoch-versioning rules (I-4). Includes the C-6 band-indexation rule and C-7 lifeline cross-subsidy accounting stance. | M | 🏛 | BIG | — | WI-07, WI-13, WI-16, WI-17 |
| **WI-07** | **StatutoryLane extension spec** | `statutoryLanes` lane class on WI-06's model (STATUTORY-LANES §2): per-class applicability, remitAddress semantics for both remittance options, statute-to-lane change ceremony (R-3). | S | 🏛 | BIG | WI-06 | WI-13, WI-14 |
| **WI-08** | **B-2: Sortition-gate revision** | Revise SORTITION-TABLE-DESIGN §4/§5: sessions must span operators, or per-operator caps on gate-countable sessions, or LD-maturity-weighted gating — kill the session-printing → governance-stacking path. Doc rev only. | S | 🏛 | BIG | — | WI-15 gate logic |
| **WI-09** | **SORTITION-DRAW-SPEC companion** | Pin the concrete primitives the design note leaves symbolic: hash function (SHA-256 off-chain), Merkle arity + padding sentinel, byte encodings, spec-version string, test vectors. Pure transcription of §1–§3 into a normative spec with vectors. | S | 📖 | CHEAP-OK | — | WI-10, WI-15 |
| **WI-20** | **Federation charter / instantiation protocol** | How a collective forms and climbs the tree: deploying a child msfed instance (own sortition table, own constitutional authority), petitioning the parent tier for a federation seat (the governance twin of architecture §5 "branches are permissioned"), charter contents (whose interests the tier answers to), seat-attestor key lifecycle at charter time. | M | 🏛 | BIG + GARRETT | — | WI-21, WI-22 |
| **WI-23** | **Governance-standing rules** | Who may hold seats: natural persons and lower-tier member councils only — never corporate entities. Conflict-of-interest recusal when a seat-holder has an interest in the operator being voted on (C-2). Operator-staff pool-stacking guard (interlocks with WI-08). Lands in the charter template (WI-20) and as a SORTITION-TABLE-DESIGN amendment. | M | 🏛 | BIG + GARRETT | — | WI-20 charter template |

### Tier 2 — Contract changes (full cycle each: design → full-ZK compile → offline tests → adversarial review → ceremony)

| ID | Item | Scope | Size | Risk | Exec | Depends on | Blocks |
|----|------|-------|------|------|------|-----------|--------|
| **WI-10** | **msfed-v1 rev 5: membershipRoot binding** | The one small contract addition SORTITION-TABLE-DESIGN §9 proposes: bind `membershipRoot` alongside `seedCommitment` in both rotation circuits (`executeRotateSeats` Vector<14>→<15>, `executeConveneRotation` Vector<10>→<11>). No mechanism change. Still DEV DRAFT after — this does not deploy anything. | S | 🏛 | CHEAP-OK (mechanical diff) + BIG review | WI-09 | honest rotations under the sortition spec |
| **WI-11** | **LD vNext: cohort registration** | Implement WI-05 in the LD lineage: cohort-root ledger set, delegated-registrar authority (grant/revoke via multisig), quota counters, challenge window, `proveInAndRegister`-style claim-time membership proof. The single biggest LD change in the series. Keeps the SmileID-keyed uniqueness scheme per D-2. | L | 💰 | BIG | WI-05 (spec) | national onboarding Phase 3 |
| **WI-12** | **LD vNext: canonical-person uniqueness** — **DEFERRED per D-2** (bundled with WI-04 when a second provider becomes real). Would replace `hash(providerTag, jobIdHash)` with a canonical-person commitment + migration story for SmileID-keyed pilot members. | M | 🏛 | BIG | WI-04 (deferred) | multi-provider KYC |
| **WI-13** | **TariffRegistry contract (new lineage)** | New contract: registered TariffSchedules, epoch-bound versions, federation-gated branch operations (new company, new line), permissionless leaf operations (class retune within floors), on-chain commitment of the WI-06 validator's verdict. Node identities shared with WI-20 charters (§0.2 same-tree invariant). | L | 🏛 | BIG | WI-06, WI-07, WI-20 | WI-14 |
| **WI-14** | **EBT vNext: tariff-path metadata + multi-lane split + statutory lanes** | The settlement-side implementation: per-coin backing metadata (§2), split resolution against a registered schedule path, statutory-lane routing at settle-time, escrow-aware redemption semantics per WI-01/03. Furthest-out contract item; do not start before Tier 0 closes. | L | 💰 | BIG | WI-01, WI-02, WI-03, WI-07, WI-13 | multi-operator settlement |
| **WI-21** | **Cross-tier attestation service** | Off-chain keeper-class service producing the attested-quorum witness when a child council votes as a federation seat in its parent (`approveFederated` path). Attestor key lifecycle, child-quorum verification, replay guards. | M | 🏛 | BIG design, CHEAP-OK scaffolding | WI-20 | live multi-tier federation |

### Tier 3 — Tooling / services / models (most parallelizable; cheap-model territory)

| ID | Item | Scope | Size | Risk | Exec | Depends on | Blocks |
|----|------|-------|------|------|------|-----------|--------|
| **WI-15** | **Sortition table builder + draw auditor CLI** | Two pure tools per SORTITION-TABLE-DESIGN §1–§2: (a) build canonical table + Merkle root from an eligibility snapshot; (b) given (table, seed, incoming[5]), re-run the draw and verdict match/mismatch. Deterministic, test-vector-driven. | M | 📖 | CHEAP-OK | WI-09 | rotation ops |
| **WI-16** | **Schedule validator tool** | Off-chain implementation of WI-06's every-path-vs-every-floor check, runnable by operators pre-submission and by anyone post-registration. | M | 📖 | CHEAP-OK | WI-06 | operator onboarding UX |
| **WI-17** | **"Explain this tariff" renderer** | Human-readable rendering of a schedule path: what the customer pays, where every basis point goes, which statute backs each lane (R-2 visibility requirement). | S | 📖 | CHEAP-OK | WI-06 | public legibility |
| **WI-18** | **Eligibility snapshot service** | One consistent read: KYC status + distinct settlement sessions + LD maturity + live flag per member, at snapshot instant t0. Spans pollpower-v2-api + settlement-api data. Read-only aggregation; feeds WI-15. | M | 📖 | CHEAP-OK | WI-08 (gate def) | sortition rotations |
| **WI-19** | **Dilution & throughput models** | Order-of-magnitude models: B-4 cross-operator LD dilution scenarios; NATIONAL-ONBOARDING §4 claims-per-epoch, proof-generation capacity at the relay tier, DUST budget per county rollout. Spreadsheet/notebook class. | M | 📖 | CHEAP-OK | — | operator agreements, Phase-3 pacing |
| **WI-22** | **Tier-promotion criteria** | The mechanical, published rule for when collectives federate upward (village co-op → county federation → national seat). Anti-favoritism twin of W-4's county-expansion criterion: mechanical, not discretionary, or seat-granting becomes patronage. Mostly calibration. | S | 🏛 | GARRETT + BIG drafting | WI-20 | tree growth |

### Explicitly deferred (tracked, not scheduled)

- **B-4 policy decision** (one national LD pool vs federated county pools) —
  needs WI-19's model first; Garrett's call.
- **C-5** (cross-border swap atomicity / licensed-desk limits), **C-10**
  (gray-market monitoring) — post-national, pre-cross-border.
- **C-9** (operator wind-down runbook) — resolves mostly inside WI-01's
  escrow design; runbook written after WI-01 lands.
- **USSD / custody-light wallet tier** (onboarding Phase 2) — open design
  item flagged against ADR-006; needs its own adversarial treatment after
  WI-01.
- **Sortition service-reward (LD share multiplier)** and **§10.1 turnout
  floor / §10.2 community-seeded randomness** — post-pilot governance
  enhancements per PR #10; not federation-blocking.

---

## 2. Sequencing

### 2.1 Critical path

```
WI-01 (escrow)  ──►  WI-02 (clearinghouse)  ──►  WI-14 (EBT vNext)
      │                                            ▲
      └──►  WI-03 (fungibility stance) ────────────┘
                        WI-06 ──► WI-07 ──► WI-13 ─┘
```

WI-01's direction is now decided (D-1: protocol escrow) — what remains is
design + legal work on the *how*. It still gates WI-02/03/14, but the
clearinghouse design (WI-02) can begin sooner since the "where does the fiat
sit" prerequisite is answered.

### 2.2 Parallel lanes (startable immediately, no Tier-0 dependency)

- **Identity lane:** WI-05 → WI-11 (WI-04/WI-12 deferred per D-2 — lane
  unblocked, starts at the cohort spec directly)
- **Governance lane:** WI-08, WI-09 → WI-10, WI-15; WI-20 + WI-23 → WI-21, WI-22
- **Tariff-spec lane:** WI-06 → WI-07, WI-16, WI-17 (contract WI-13 waits on
  WI-20 for shared node identity)
- **Modeling lane:** WI-18, WI-19

### 2.3 Suggested first wave (this month, cheap-model friendly)

1. WI-09 (draw-spec) — small, pure, unblocks two tools
2. WI-15 (table builder + auditor) — right behind it
3. WI-19 (dilution/throughput models) — informs Garrett's B-4 and pacing calls
4. WI-18 (eligibility snapshot service) — after WI-08's gate revision lands
5. WI-08 (gate revision) — BIG-model doc rev, small

Meanwhile Garrett + BIG session drive WI-01's *how* (escrow legal/solvency
design) and WI-05 (cohort spec) — with D-1 and D-2 taken, those are the two
items everything expensive now hangs off.

---

## 3. Calibration register — blocking-input TODOs (Garrett's call, do not invent)

Every item below is a **blocking input**: executing sessions MUST mark the
dependent spec `TODO(calibration)` and continue with a named placeholder —
never a guessed value.

| # | Parameter | Consumed by |
|---|-----------|-------------|
| CAL-1 | `LD_FLOOR_BPS`, `OPS_FLOOR_BPS` national defaults | WI-06, WI-13, WI-14 |
| CAL-2 | Sanity-band width + indexation rule (C-6) | WI-06, WI-16 |
| CAL-3 | Sortition gate thresholds: X distinct sessions, Y days LD maturity (per tier) | WI-08, WI-15, WI-18 |
| CAL-4 | Cohort size, registrar quota, challenge-window length | WI-05, WI-11 |
| CAL-5 | Roll-expansion criterion (W-4 footprint threshold) | WI-22, onboarding Phase 5 |
| CAL-6 | Tier-promotion thresholds (collective → county → national) | WI-22, WI-20 |
| CAL-7 | Decline cooldown, acceptance window, ghost cooldown (sortition §7) | WI-15 |
| CAL-8 | Statute-to-lane ceremony: quorum, review window, publication (R-3) | WI-07 |
| CAL-9 | One national LD pool vs federated county pools (B-4/§3) | WI-11, WI-19 informs |
| CAL-10 | ~~Canonical-person scheme choice~~ **RESOLVED by D-2** (SmileID-only posture; revisit at second market) | WI-04/12 when revived |
| CAL-11 | Remittance default: option 1 (fiat door) vs option 2 (on-chain lane) | WI-07, WI-14 |
| CAL-12 | Citizenship vs residence basis for the roll (W-5) | onboarding policy |

---

## 4. Per-item task specs (briefs for executing sessions)

Format contract: each brief is **self-contained** — an executing session
receives ONE brief plus repo access and nothing else. Every brief has the
same skeleton; the four fully-worked examples below are the first-wave items.
Briefs for later items are written by the supervising session **when the item
is actually dispatched** (writing them all now would freeze judgment against
stale context — the skeleton is the contract, not the prose).

### Brief skeleton (mandatory sections)

```
WI-NN <title>
READ FIRST (exact files, in order)
DELIVERABLE (exact paths, format)
INVARIANTS THAT MUST HOLD (checkable statements)
ACCEPTANCE CRITERIA (what review will check)
REQUIRED TESTS (if code)
DO NOT (hard constraints; assume you will be tempted)
CALIBRATION PLACEHOLDERS (CAL-n items you must NOT resolve yourself)
```

---

### WI-09 — SORTITION-DRAW-SPEC companion (worked brief)

**READ FIRST:** `multisig/SORTITION-TABLE-DESIGN.md` (all of it, especially
§1.1 leaf encoding, §2 draw procedure, §3 commit-reveal); then
`multisig/multisig-federated-v1.compact` L441–L545 (the two rotation
circuits) to understand what the spec's outputs feed.

**DELIVERABLE:** `multisig/SORTITION-DRAW-SPEC.md` — a normative spec that
pins every symbolic choice the design note left open, plus machine-readable
test vectors in `multisig/tooling/draw-spec-vectors.json`.

Must pin: hash primitive for the off-chain auditor path (SHA-256), exact
byte encodings (endianness already specified in §1.1 — transcribe, do not
change), Merkle tree arity (binary), padding sentinel rule, the
`pp:sortition:*:v1` domain-tag registry, the rejection-sampling collision
rule, and the spec-version string format.

**INVARIANTS:** (1) Two independent implementations of this spec given the
same (eligibility set, seed) MUST produce byte-identical roots and identical
`selected[5]`. (2) Every domain tag in the spec appears verbatim in the
design note — no new tags. (3) `epoch` is inside every leaf. (4) Padded
leaves have weight 0 and are undrawable.

**ACCEPTANCE:** ≥ 6 test vectors covering: minimal table (n=5), non-power-of-two
padding, collision-triggering seed (rejection path exercised), equal-weight
gate policy, one federation-seat row, and a deliberately WRONG `incoming[5]`
the auditor must reject.

**DO NOT:** modify SORTITION-TABLE-DESIGN.md; introduce Poseidon (that is the
future in-circuit variant, out of scope); invent gate thresholds (CAL-3);
write any `.compact` code.

---

### WI-15 — Sortition table builder + draw auditor CLI (worked brief)

**READ FIRST:** `multisig/SORTITION-DRAW-SPEC.md` (WI-09 output — this item
does not start until it merges); `multisig/SORTITION-TABLE-DESIGN.md` §1–§3,
§7–§8; the vectors file.

**DELIVERABLE:** `multisig/tooling/sortition-table/` — TypeScript CLI, two
commands: `build-table` (eligibility snapshot JSON → canonical table +
membershipRoot) and `audit-draw` (table + seed + claimed incoming[5] →
MATCH/MISMATCH verdict with the divergence point). No network access; pure
stdin/file in → file/stdout out.

**INVARIANTS:** (1) Determinism: same inputs → byte-identical outputs, across
runs and platforms. (2) Every vector in `draw-spec-vectors.json` passes.
(3) The auditor rejects a rotation whose membership snapshot postdates the
seed reveal (the §3 ordering invariant) when given timestamped inputs.
(4) `n >= 5` distinct eligible members enforced as a hard precondition.

**ACCEPTANCE:** vectors green; property test (1000 random tables × seeds:
draw always terminates, always 5 distinct, uniform-ish distribution sanity
check); `audit-draw` catches a single-member substitution in `incoming`.

**REQUIRED TESTS:** vector conformance + the property tests above, in the
repo's standard TS test layout.

**DO NOT:** read eligibility from live services (that is WI-18's job — this
tool takes a snapshot file); implement the gate logic (input is already
gate-filtered); add weighting options beyond `weight=1` and the spec'd
concave fallback; touch any `.compact` file.

---

### WI-19 — Dilution & throughput models (worked brief)

**READ FIRST:** `FEDERATED-TARIFF-OPEN-QUESTIONS.md` B-3/B-4;
`NATIONAL-ONBOARDING-PROTOCOL.md` §3–§4; `living-dividend/DESIGN.md`
(accumulator math, SCALE, claim-on-demand semantics);
`living-dividend/living-dividend-v2.2.1.compact` `bumpOnMint`/`claim` for
the actual cost surface.

**DELIVERABLE:** `docs-models/federation-scale-models.md` + a reproducible
notebook/spreadsheet (committed) with: (a) per-member dividend under
operator-count × member-count × mint-rate grids (B-4 scenarios: symmetric,
10:1 asymmetric funding, registration-race dynamics); (b) claims-per-epoch
and proof-generation load at 1%/5%/20% national adoption; (c) DUST budget
per county-scale cohort rollout under the Merkle-cohort model (roots +
claims-on-demand only).

**INVARIANTS:** every number traceable to a stated assumption; assumptions
tabled separately from results; no assumption presented as a conclusion.

**ACCEPTANCE:** the B-4 section ends with a decision-ready comparison for
CAL-9 (one pool vs federated pools) — inputs Garrett needs, not a
recommendation disguised as math.

**DO NOT:** pick CAL-9; use pilot-confidential figures without flagging;
model the service-reward multiplier (deferred item).

---

### WI-10 — msfed rev 5: membershipRoot binding (worked brief)

**READ FIRST:** `multisig/SORTITION-TABLE-DESIGN.md` §0 and §9 (the exact
proposed change); `multisig/multisig-federated-v1.compact` in full —
especially `executeRotateSeats` (L441–L487) and `executeConveneRotation`
(L499–L545) and the actionHash Vector construction in each;
`multisig/FEDERATED-V1-REVIEW.md` (know the standing findings).

**DELIVERABLE:** `multisig/multisig-federated-v1.compact` rev 5 on a feature
branch: add `membershipRoot: Bytes<32>` parameter to both rotation circuits,
bound into the actionHash (Vector<14>→Vector<15>; parent message
Vector<10>→Vector<11>), header + inline comments updated, rev history
appended. Full-ZK compile output attached to the PR.

**INVARIANTS:** (1) NO other circuit, ledger field, or mechanism changes —
this is a binding-only diff. (2) Domain tags unchanged except where the
design note specifies. (3) Epoch-increment semantics untouched. (4) The
contract remains DEV DRAFT — nothing in this item deploys.

**ACCEPTANCE:** clean full-ZK compile on compactc 0.31.0 (19 circuits, zero
warnings); diff review confirms binding-only; offline smoke suite still
passes (22/22 baseline, updated for the new parameter arity).

**REQUIRED TESTS:** update the existing offline smoke tests for the new
Vector arities; add one negative test: rotation with a mismatched
membershipRoot in the approval hash must not reach quorum.

**DO NOT:** implement the draw in-circuit (explicitly future work per the
contract header); add a `_members` ledger set; refactor anything adjacent
"while you're in there"; deploy.

---

### Briefs pending dispatch (skeleton applies)

WI-01..08, WI-11..14, WI-16..18, WI-20..23 — written by the supervising
session at dispatch time, one at a time, against then-current repo state.
Tier-0 and 💰-class items additionally get an adversarial pre-read: the
supervising session writes the brief, then red-teams its own brief before
dispatch ("what is the worst compliant implementation of this spec?").

---

## 5. Governance & verification loop

### 5.1 Review matrix

| Output class | Auto-checks (merge-blocking) | Human/BIG review |
|---|---|---|
| Spec/design doc (📖) | markdown lint, internal-link check | BIG session reviews for consistency with the doc series; Garrett approves direction |
| Tooling (Tier 3) | compile, full test suite, vector conformance, determinism re-run | BIG reviews test *adequacy* (not just green), spot-checks logic |
| Contract diff (🏛) | full-ZK compile (never `--skip-zk` for merge), offline smoke suite | **Mandatory BIG adversarial review** + Garrett sign-off |
| Contract diff (💰) | all of the above | **Mandatory BIG adversarial review + a second independent BIG pass** (different session, no shared context) + Garrett sign-off + deploy ceremony |

### 5.2 PR conventions (this repo, verified working)

- Spec-only PRs for design docs; one work item = one PR; branch names
  `docs/<topic>` or `feat/<topic>`.
- PR body via `--body-file` (multiline bodies mangle inline on PowerShell).
- PowerShell `;` separators, never `&&`.
- `git push` exit-1 stderr quirk is benign — confirm success via the
  `old..new` ref line.
- Every PR touching a contract attaches the full-ZK compile transcript.
- Executing sessions open PRs as **draft**; only the supervising session
  marks ready-for-review.

### 5.3 Escalation triggers (cheap → BIG, immediately)

An executing session MUST stop and escalate when:

1. The brief's READ-FIRST files contradict the brief itself.
2. Any invariant in the brief cannot be satisfied as written.
3. A change wants to touch a file not named in the brief.
4. Anything requires choosing a CAL-n value.
5. A test can only pass by weakening it.
6. The item turns out to touch settlement, floors, identity keys, or
   custody in any way the brief did not anticipate.

Escalation = comment on the draft PR + stop. No workarounds, no judgment
calls. The failure mode this protects against is a mediocre model being
*helpful*.

### 5.4 The supervising session's own checklist (per dispatched item)

- Brief written against current `main`, not memory.
- Red-team pass done for 💰/🏛 items ("worst compliant implementation").
- On completion: verify invariants directly (read the diff / run the tool),
  never trust the executing session's self-report.
- Same-tree invariant (§0.2) checked whenever the item touches charters,
  registries, or node identities.
- Memory file updated (`workspace/memory/`) with item status; this plan's
  §6 tracker updated in the same PR that closes the item.

---

## 6. Status tracker

| ID | Status | PR | Notes |
|----|--------|----|----|
| WI-01 | ◐ direction decided (D-1) | — | Protocol escrow pool; *how* design pending |
| WI-04, WI-12 | ⧖ deferred (D-2) | — | Revive at second market/provider |
| all others | ☐ not started | — | Plan merged; first wave per §2.3 |

---

## 7. One sentence

> The federation ships as twenty-three bounded work items under one
> separation of powers — companies price, members bound, the mint pays —
> sequenced so that the two custody questions nobody can delegate (where
> the fiat lives, who nets between operators) are answered by humans first,
> while everything provably mechanical is specified tightly enough to hand
> to cheaper hands under adversarial review.

---

*IMPLEMENTATION PLAN, 2026-07-12. Spec/policy only — zero contract code.
Post-pilot layer; the pilot's critical path (EBT v7.4.2, Multisig v7,
LD v2.2.x) is untouched by every item in this document.*
