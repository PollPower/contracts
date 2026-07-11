# Federated Tariff Architecture — Open Questions & Adversarial Findings

**Status:** FINDINGS DOC — adversarial review of
[`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md)
(merged as PR #11, 2026-07-11), conducted same-day against the merged text.
**Layer:** Post-pilot, like its subject. Nothing here blocks the pilot.
**Companion to:** [`STATUTORY-LANES.md`](./STATUTORY-LANES.md) (same follow-up PR).

## 0. What this document is

PR #11 was merged quickly; this is the adversarial pass it would have received
in review, preserved as a standing open-questions register. Findings are
ranked: **A** (must-solve before any second operator onboards), **B** (sharp
interactions worth resolving early), **C** (worth a look when convenient).

The A-findings are not edge cases. Both are direct consequences of the
architecture's own headline promise ("a consumer's EBT spends identically
anywhere") and must be answered before that promise is made to a second
operator.

---

## A-1. Interoperability implies an intra-national clearinghouse

**The gap.** The doc promises token portability across operators but never
describes the money movement that portability creates. Play it forward:

1. Consumer earns/buys EBT on Operator A's grid (their KES sits with A's
   settlement pool).
2. Consumer spends EBT at a merchant on Operator B's grid.
3. Merchant redeems to KES — **paid out of B's fiat**, while **A holds the
   original consumer payment**.

That is an inter-operator receivable. Multiplied across every operator pair,
it is a netting/true-up problem with inter-operator credit risk —
structurally identical to the cross-border problem §7.3 solves, except it is
*inside* the nation, and it is **not optional**: it is implied by fungibility
itself.

**Likely shape of the fix.** The border solution ports down: net continuously
in EBT terms, true-up the fiat residual periodically, and restrict who carries
the inter-operator book (a national clearing function — protocol-operated or
a licensed role). Needs a §3.5-class addition to the architecture doc once
designed.

**Status:** OPEN. Blocking for multi-operator onboarding.

---

## A-2. Where does the jar live? (custody of backing fiat)

**The gap.** Invariant I-2 says fiat is in the jar before mint — but the doc
never says *whose jar*. If each operator custodies its own consumer payments,
then EBT backing quality equals operator credit quality, and an operator
insolvency makes "their" minted EBT worthless — which breaks fungibility for
**everyone** (a merchant must then care which grid minted the coin they are
accepting, and I-1's economic meaning collapses).

**Likely shape of the fix.** Backing fiat sits in a **protocol-controlled
national escrow** (or a ring-fenced trust structure per nation), not on
operator balance sheets. Operators originate payments into it and instruct
splits out of it; they never own the float. This is a major custody and
regulatory statement — arguably the single most consequential unstated
decision in the architecture — and it needs its own design + legal treatment.

**Status:** OPEN. Blocking for multi-operator onboarding. Prerequisite
context for A-1 (the clearinghouse design depends on where the fiat sits).

---

## B-1. Fiat-memory vs fungibility — a Gresham's Law tension

§2 celebrates per-coin backing metadata; §3.3 records the tariff path on every
coin. But if coins carry different backing-KES and redemption pays out a
coin's *specific* backing, EBT is not economically fungible — it is a family
of coins with different cash-out values. Rational actors spend low-backed
coins and hoard/redeem high-backed ones (Gresham's Law).

Either redemption is **pooled/averaged** at the retail layer (restores
fungibility, blurs the per-coin audit trail) or coins remain **distinguishable
at redemption** (keeps the audit, loses clean fungibility). The doc currently
implies both; it must pick a stance per redemption path. A plausible
resolution: per-coin metadata is an *audit* artifact (who backed what, for
solvency and compliance), while *redemption value* is pooled at the national
escrow — audit trail intact, economics fungible. Needs to be made explicit.

**Status:** OPEN — needs an explicit stance in the architecture doc.

## B-2. Settlement-session farming attacks governance eligibility (cross-doc)

Invariant I-2 makes *mint* inflation expensive (fake consumption requires real
KES and leaks the LD+ops floors every wash cycle). But the sortition design
(`multisig/SORTITION-TABLE-DESIGN.md` §4) gates governance eligibility on
"≥X distinct settlement sessions." An operator can cheaply *manufacture
sessions* for its own people, making them governance-eligible at scale and
stacking a cluster's sortition pool.

The tariff architecture hands operators a session-printing machine; the
governance layer treats sessions as personhood-adjacent evidence. Invisible
when either doc is read alone.

**Likely fix lives in the sortition gate:** sessions must span operators, or
per-operator caps on gate-countable sessions, or gate on LD-maturity signals
that wash cycles cannot cheaply generate. Flag for the sortition doc's next
revision.

**Status:** OPEN — mitigation belongs in SORTITION-TABLE-DESIGN §4/§5.

## B-3. LD registration throughput vs the onboarding pitch

§6 sells "onboard a mini-grid, inherit hundreds of meters overnight." LD
`register()` is one-member-at-a-time and multisig-gated; a 3-of-5 human
ceremony per villager does not survive a 500-member onboarding day. The
multisig becomes the bottleneck on the exact metric (mint velocity) the
architecture optimizes.

**Likely fix:** batch registration circuits, and/or per-operator *delegated
registration authority* with federation-revocable scope (operator's delegate
key can register members under quota + audit, federation can revoke the
delegation). Same trust-shape as ProducerRegistry gating, one level down.

**Status:** OPEN — LD-side design item before first operator onboarding.

## B-4. Cross-operator LD dilution races

One national LD pool with per-member equal accrual means Operator A
registering 10k low-consumption members dilutes a dividend funded
predominantly by Operator B's high-consumption customers. Operators are thus
in a member-registration race with asymmetric funding — good for reach
(registration pressure = inclusion pressure), but it creates a
"who funds vs who collects" political fault line between operators.

Worth modeling before two real operators exist. Possible postures: accept it
openly as the network's solidarity mechanism (and say so in operator
agreements), or explore per-cluster LD pools federated under the constitutional
floor (which §7.4 already contemplates across nations — the same nesting could
apply within one).

**Status:** OPEN — economic modeling + a policy decision, not (yet) a
contract change.

---

## C-findings (worth a look when convenient)

- **C-1. The ops floor's recipient is undefined.** The architecture
  constitutionalizes an ops minimum but never says who receives it at
  federation scale. If it is permanently PollPower-the-company, a rent is
  baked into the constitution. Politically explosive later; cheap to define
  now (e.g., ops floor pays a federation-governed operations treasury, from
  which the operating company is *contracted*).

- **C-2. Incumbent capture of branch permissions.** §5 lets federation seats
  gate new-company onboarding — incumbents voting on whether competitors may
  exist. Needs conflict-of-interest recusal rules in the federation's
  procedures.

- **C-3. Tariff class as poverty marker.** Per-coin tariff-path metadata means
  "lifeline class" — a poverty signal — rides on coins. The privacy posture
  must state who can read the path (ties into B-1's audit-vs-redemption
  split, and into STATUTORY-LANES §B-3 aggregation rules).

- **C-4. Cross-vendor KYC duplication.** `hash(providerTag, jobIdHash)`
  catches same-vendor duplicates only; the same human via two different KYC
  vendors yields two LD memberships. Incentive scales with the pool. Known
  LD-design limitation; the tariff architecture raises its stakes.

- **C-5. Cross-border swap atomicity.** §7.3's extinguish-TZ / mint-KE legs
  are separate events; the KE mint waits on actual KE consumption. Someone
  holds an intertemporal position between delivery and consumption — define
  who (the licensed desk is the natural answer, with limits).

- **C-6. Band indexing under inflation.** A static sanity band (§7.2) drifts
  every operator out of compliance under normal KES inflation. The band needs
  an indexation rule (reference re-set cadence, or CPI-linked drift), epoch-
  bound like everything else.

- **C-7. Lifeline cross-subsidy accounting.** If lifeline classes are priced
  below cost, someone funds the gap (other classes, the operator's margin, or
  a subsidy pool). The tree can *express* this but the doc doesn't say where
  the gap lands. Interacts with STATUTORY-LANES §5 (government top-up pools).

- **C-8. Tax fields.** Resolved in principle by
  [`STATUTORY-LANES.md`](./STATUTORY-LANES.md) (same PR); listed here for
  completeness because the original doc omitted VAT/levies entirely.

- **C-9. Operator exit/wind-down protocol.** Ostrom's design principles
  include conflict-resolution machinery and clear boundaries; the architecture
  has floors but no exit rights. What happens to an exiting operator's
  members, meters, outstanding EBT backing, and LD registrations? Needs a
  wind-down runbook-class design (interacts with A-2: if the protocol holds
  the float, operator exit does not strand backing).

- **C-10. Gray-market OTC across borders.** §7.3 restricts the *official*
  swap; it cannot restrict P2P fiat-for-EBT trades (M-Pesa one side, EBT the
  other). Expect a street price between colors wherever official friction
  exists. Not preventable — but should be *monitored* as a signal (a wide
  street spread means the official channel's limits are mispriced).

---

## Ranking summary

| # | Finding | Severity | Blocks |
|---|---------|----------|--------|
| A-1 | Intra-national clearinghouse missing | Must-solve | 2nd operator |
| A-2 | Custody of backing fiat undefined | Must-solve | 2nd operator |
| B-1 | Fiat-memory vs fungibility stance | High | Redemption design |
| B-2 | Session-farming → governance eligibility | High | Sortition gate rev |
| B-3 | LD registration throughput | High | 1st operator onboarding |
| B-4 | LD dilution race between operators | High | Operator agreements |
| C-1…C-10 | See above | Moderate/Low | Various |

---

*FINDINGS DOC, 2026-07-11. Adversarial review of merged PR #11. Spec/policy
only — zero contract code. All items post-pilot.*
