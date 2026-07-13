# Federation Charter & Instantiation Protocol (+ Governance-Standing Rules)

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot. The pilot runs flat Multisig v7, one operator; nothing
here is on the pilot's critical path.
**Work items:** WI-20 (charter / instantiation protocol) + WI-23
(governance-standing rules — folded in here as §4, because a charter must state
whose interests a tier answers to).
**Formalizes:** the "Governance: the Fractal Federation" section of the root
[`README.md`](../README.md); the federation-seat / parent-recovery mechanics of
[`multisig-federated-v1.compact`](./multisig-federated-v1.compact) (DEV DRAFT,
rev 4); architecture §5 ("branches are permissioned"); findings C-2 (incumbent
capture) and B-2 (operator pool-stacking) from
[`../FEDERATED-TARIFF-OPEN-QUESTIONS.md`](../FEDERATED-TARIFF-OPEN-QUESTIONS.md).
**Implements decision D-4** (governance-first ID minting) from
[`../FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md) §0.3.
**Verified against source:** `multisig-federated-v1.compact` rev 4 —
`initialize(seat1..5, threshold, constitutionalAuthority, parentAuthority,
currentTime)` (L236–L272), `approveFederated(actionHash, seatId,
attestorSignature)` (L300+), `_constitutionalAuthority`/`_parentAuthority`
ledger fields (L173/L177), and `FEDERATED-V1-REVIEW.md` (findings F-1/F-2 fixed
rev 4; A-1..A-5 accepted). This protocol adds **no contract mechanism** — it
specifies the *lifecycle* around the mechanisms that already exist.

## 0. What this document is

The contract already has the *mechanics* of nesting: a seat can be a lower-tier
council (`approveFederated`), a parent can revive a dead child
(`executeConveneRotation`), and each tier holds a `constitutionalAuthority` +
`parentAuthority`. What it does **not** have is a *lifecycle*: how a collective
comes into being, mints its canonical identity, and petitions to become a seat
in a higher tier. This document is that lifecycle — the governance twin of the
tariff architecture's §5 "branches are permissioned."

It answers three questions:

1. **How does a collective form?** (§2 — deploy a child council instance)
2. **How does it climb the tree?** (§3 — petition a parent tier for a seat)
3. **Whose interests does each tier answer to, and who may hold a seat?**
   (§4 — governance-standing rules, WI-23)

### 0.1 One-sentence contract

> A collective forms by deploying its own `multisig-federated-v1` instance with
> a chartered canonical id (minted by the parent tier per D-4, before any
> tariff schedule may reference it), then climbs the tree by petitioning a
> parent tier which — subject to conflict-of-interest recusal and the rule that
> only natural persons and lower-tier member councils may hold seats — admits
> the child's council address as a federation seat via the existing
> `approveFederated` path.

---

## 1. The two on-chain facts a charter already maps to

Reading `initialize()` (L236–L272), a tier's entire on-chain identity is:

- **`_seats`** — the 5 seat ids (persons or lower-tier council addresses).
- **`_threshold`** — 3-of-5 (strict-majority floor enforced: `threshold*2 > 5`).
- **`_constitutionalAuthority`** — the key that must co-sign constitutional
  (rule-level) changes on top of council quorum (the "member-referendum"
  attestation of the README's constitutional-floor design).
- **`_parentAuthority`** — the parent tier that may convene a rotation if this
  council goes dark (30-day liveness gate).

A **charter** is the off-chain document + on-chain deployment that fixes these
four things for a tier, plus the canonical id (D-4). Everything else in this
protocol is *how those values are chosen and who is allowed to choose them* —
the contract enforces the values once set; the charter governs their setting.

---

## 2. Phase 1 — a collective forms (instantiation)

### 2.1 Charter contents (off-chain, published; committed on-chain by hash)

A forming collective publishes a **charter document** containing:

- `canonicalId` — the 32-byte node id (minted per §2.2 / D-4).
- The tier's **scope** — what it governs (a village cluster, a county
  federation, a national tier) and its `nationRef`.
- The **initial 5 seats** — how they were selected (sortition per
  SORTITION-TABLE-DESIGN, or a documented bootstrap set for a brand-new tier
  that has not yet reached 5 sortition-eligible members — see §2.3).
- The **constitutional authority** — who/what co-signs rule changes (a
  member-referendum mechanism, or a documented bootstrap authority).
- The **parent authority** — the id of the tier above (or a documented "root
  tier, no parent" for the top).
- A **standing statement** (§4) — whose interests this tier answers to.
- `charterHash = persistentHash(domain="pp:fed:charter:v1", <fields>)` — the
  domain tag `pp:fed:charter:v1` is reserved here.

### 2.2 D-4: the parent mints the id (governance-first)

Per decision D-4, `canonicalId` is **minted by the parent tier's chartering
act**, not self-assigned. Concretely: a forming collective submits its charter
(and proposed seats) to the parent tier; the parent tier, by council quorum,
**approves the charter and issues the `canonicalId`**. Only then may the child
deploy its `multisig-federated-v1` instance with that id, and only then may any
tariff schedule (WI-06/WI-13) reference it as `operatorId`/`nationRef`.

This is the structural enforcement of the plan §0.2 same-tree invariant: an id
exists in the governance tree *before* it can appear in the tariff tree, so a
schedule can never reference an ungoverned entity (TARIFF-SCHEDULE-MODEL §7.1).

**The root tier is the bootstrap exception.** The top-of-tree has no parent to
mint its id; its id and initial charter are fixed at genesis (a documented
founding act), and it is the only tier permitted a null `parentAuthority`.
Every other tier's id traces to a parent chartering act.

### 2.3 The 5-seat bootstrap problem (verified against §7 preconditions)

The sortition design (§7) requires ≥5 distinct eligible members before a tier
can draw a council. A brand-new collective may not have 5 sortition-eligible
members yet. The charter therefore permits a **documented bootstrap council**
(named seats, disclosed as bootstrap-not-sortition, exactly as the pilot
discloses its mock admin keys) that runs until the tier reaches the sortition
precondition, at which point it MUST transition to sortition-drawn rotation.
The transition threshold and deadline are `TODO(calibration)` (§6). This mirrors
the honest H-1 disclosure pattern already used for pilot-mock keys.

---

## 3. Phase 2 — a collective climbs the tree (federation-seat petition)

### 3.1 The petition

An already-chartered child tier petitions a parent tier to seat the child's
**council address** as one of the parent's 5 federation seats. This is the
governance action architecture §5 calls a "permissioned branch": you cannot
unilaterally declare yourself a seat in a higher tier.

The parent tier processes the petition as a normal council action (its own
3-of-5 quorum), and on approval seats the child via the **existing**
`approveFederated` mechanism — the child council's future votes in the parent
then arrive as an attested lower-tier quorum, not an individual signature. No
new contract circuit is needed; the seat is filled through the rotation path
(`executeRotateSeats`) with the child's council address as an `incoming` id
flagged federated.

### 3.2 The cross-tier attestation (cross-reference to WI-21)

When the seated child council later votes in the parent, someone must produce
the **attested-quorum witness** that `approveFederated` consumes (proof that
the child's own 3-of-5 actually approved the parent-level action). That
off-chain attestation service is **WI-21**, not this document. This protocol
only fixes *when a child becomes eligible to vote that way* (on parent
approval of the petition); WI-21 fixes *how each such vote is attested*.

### 3.3 Promotion criteria (cross-reference to WI-22)

*Which* collectives may petition *which* parent, and *when* (village co-op →
county federation → national) is the **tier-promotion criteria** — WI-22 — and
it is `TODO(calibration)`. The hard requirement this protocol imposes on WI-22:
the criterion MUST be **mechanical and published**, never discretionary, or
seat-granting becomes patronage (finding W-4 of NATIONAL-ONBOARDING, and C-2
here). A parent tier approving a petition checks the WI-22 criterion is met; it
does not exercise taste.

---

## 4. Governance-standing rules (WI-23)

This is the section that says *whose interests each tier answers to* and *who
may hold a seat*. It closes findings C-2 (incumbents voting on competitors) and
B-2 (operators stacking the pool), and it is the constitutional expression of
the plan's separation of powers ("members bound"): the councils that set the
floors answer to **members**, not to the companies those floors constrain.

### 4.1 R-1 — only natural persons and lower-tier member councils may hold seats

A seat id is **either**:

- a **natural person's** council-seat identity (a KYC-unique member, per the
  sortition gate), **or**
- a **lower-tier member council's** address (a federation seat).

A seat id may **never** be a **corporate/operator entity**. An operator is a
priced participant in the tariff tree (a `TariffSchedule.operatorId`); it is
**not** a governance actor. This is the structural core of "companies price,
members bound": the thing being constrained (the company) cannot sit on the
body that constrains it.

Enforcement: this is a **charter + sortition-table construction** rule
(off-chain, §1 table build), not a new circuit — the sortition gate already
selects only KYC'd members, and federation seats are explicitly lower-tier
council addresses. WI-23's job is to make it an *explicit, documented
prohibition* so no charter accidentally seats a corporate id, and so the
table-builder (WI-15) rejects a candidate row that resolves to an operator
entity.

### 4.2 R-2 — conflict-of-interest recusal (finding C-2)

When a council votes on a matter in which a seat-holder has an interest —
approving a *new company* the seat-holder owns or works for, approving a
*competitor* of an operator the seat-holder is tied to, or setting a floor that
differentially benefits their operator — that seat-holder **must recuse**.

- Recusal is **declared** (the seat-holder abstains; the action's quorum is
  computed over the non-recused seats for that vote).
- A recusal that *should* have happened but did not is a **charter violation**,
  challengeable through the tier's constitutional-authority path and grounds
  for the parent-convened rotation.
- The set of interests requiring recusal is enumerated in the charter's
  standing statement (§1) — `TODO(calibration)` on the exact enumeration, but
  it MUST at minimum cover: ownership/employment in a company being chartered
  or repriced, and family/financial ties disclosed at seating.

This is a **procedural** rule (the contract cannot know a seat-holder's
off-chain interests), enforced socially + through the challenge/convene path,
and made auditable by requiring interests to be **declared at seating** and
recusals to be **logged**.

### 4.3 R-3 — operator pool-stacking guard (interlock with B-2 / §5.1)

An operator must not be able to convert its market position into a governing
bloc by stacking a tier's sortition pool with members it sponsors. This is the
governance-side twin of the B-2 mitigation already in SORTITION-TABLE-DESIGN
§5.1 (the cross-operator session requirement). WI-23 adds the standing rule
that makes it constitutional rather than merely technical:

- A tier whose sortition pool is dominated by a single operator's sponsored
  members (over a `TODO(calibration)` concentration threshold) MUST NOT run an
  unmodified sortition draw — it either widens the pool (cross-operator
  requirement, §5.1) or defers rotation until the pool diversifies.
- This couples with §5.1 (who *qualifies*) and §6-cooldown (who may *serve
  again*): three interlocking limits, none sufficient alone, jointly bounding
  operator capture.

### 4.4 The standing statement (what every charter must declare)

Every charter's §1 standing statement MUST answer, in publishable prose:

1. **Whose interests** this tier's council answers to (its member
   constituency), stated explicitly.
2. The **recusal enumeration** (§4.2) for this tier.
3. Any **bootstrap disclosures** (§2.3) — non-sortition seats, and the
   transition plan to sortition.
4. The tier's **scope and parent** (redundant with the on-chain charter, but
   in human-legible form — the R-3 legibility test: a member must be able to
   read who governs them and how).

---

## 5. What is enforced where (honesty about the trust model)

| Rule | Enforcement |
|------|-------------|
| D-4 id minting (§2.2) | Structural — WI-13 rejects tariff schedules for uncharted ids; parent-quorum mints the id |
| 5-seat / 3-of-5 / strict majority | In-circuit (`initialize`, verified L250–L272) |
| Cross-deployment replay safety | In-circuit (`kernel.self()` in every actionHash — M-2 closed per review) |
| Federation-seat nesting | In-circuit (`approveFederated`, existing) |
| Parent dead-council recovery | In-circuit (`executeConveneRotation`, 30-day gate) |
| R-1 no-corporate-seats (§4.1) | Off-chain — charter + sortition-table build (WI-15 rejects operator-entity rows) |
| R-2 recusal (§4.2) | Procedural — declared at seating, logged, challengeable via convene path |
| R-3 pool-stacking (§4.3) | Off-chain gate + standing rule (interlocks §5.1 + cooldown) |
| Promotion criteria (§3.3) | Off-chain, mechanical + published (WI-22) |

The honest summary: the *structural* protections (id minting, seat count,
replay, nesting, recovery) are in-circuit and strong; the *political*
protections (no corporate seats, recusal, anti-stacking) are charter +
table-build + procedural, because the contract cannot know off-chain interests.
This is the correct division — the same one the sortition design draws between
what the chain enforces and what the ceremony enforces.

---

## 6. Open calibration items (Garrett's call — do NOT invent)

| # | Parameter | Section |
|---|-----------|---------|
| CAL-BOOT | Bootstrap-council transition threshold + deadline (when a young tier must switch from named seats to sortition) | §2.3 |
| CAL-PROMO | Tier-promotion criteria (WI-22): footprint/maturity thresholds for village→county→national | §3.3 |
| CAL-RECUSE | The recusal-interest enumeration per tier | §4.2 |
| CAL-STACK | Single-operator pool-concentration threshold that forces pool-widening / rotation deferral | §4.3 |
| CAL-CONST | What the constitutional-authority co-sign actually is (member referendum mechanism, turnout floor — ties to SORTITION §10.1) | §1 |

---

## 7. One sentence

> A collective forms by deploying its own five-seat federated council under a
> canonical id its parent tier mints (D-4, before any tariff may reference it),
> climbs the tree by petitioning a parent that seats its council address through
> the existing `approveFederated` path on a mechanical published criterion, and
> operates under a charter that constitutionally forbids corporate seats,
> mandates conflict-of-interest recusal, and guards against operator
> pool-stacking — so that the councils setting the floors answer to members,
> never to the companies those floors constrain.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code; adds no
contract mechanism, only the lifecycle around the mechanisms
`multisig-federated-v1` already has. WI-20 + WI-23 of the Federation
Implementation Plan. Post-pilot.*
