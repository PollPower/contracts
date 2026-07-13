# Tier-Promotion Criteria — when a collective may federate upward

**Status:** DESIGN DRAFT — spec/policy frame, no contract code. Most values are
`TODO(calibration)` (Garrett's call). Not deployed, not audited.
**Layer:** Post-pilot.
**Work item:** WI-22 of [`../FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md).
**Serves:** the "climb the tree" petition of
[`FEDERATION-CHARTER-PROTOCOL.md`](./FEDERATION-CHARTER-PROTOCOL.md) §3.3 —
which imposes the hard requirement this document satisfies: the promotion
criterion MUST be **mechanical and published**, never discretionary.
**Related:** NATIONAL-ONBOARDING W-4 (the identical anti-patronage requirement
for county roll-expansion — same principle, different axis).

## 0. What this document is

A collective climbs the tree by petitioning a parent tier for a federation seat
(charter §3). WI-20 fixed *how* the petition is processed (parent quorum seats
the child via `approveFederated`). This document fixes *when a petition may
succeed* — the eligibility bar — and its single most important property is that
the bar is **mechanical**, so seat-granting cannot become patronage.

### 0.1 The non-negotiable: mechanical, not discretionary

If a parent council can grant or deny seats by *taste*, then incumbents decide
which collectives get a governance voice — the C-2 capture risk, one tier up,
and the W-4 "which county goes next is a political prize" risk. The defense is
the same in both places: **a published, mechanical criterion that a parent
merely verifies, never judges.** A collective that meets the bar is entitled to
its petition being granted; a parent refusing a qualifying collective is a
charter violation (challengeable via the constitutional-authority path).

This document is therefore a **frame of the right *kinds* of criteria** (which
are mechanical and non-farmable) plus the thresholds left as `TODO(calibration)`
for Garrett — the same discipline as the sortition gate (§4 gates are named;
their numbers are Garrett's).

---

## 1. The shape of a good criterion (mechanical + non-farmable)

Promotion criteria must be built from quantities that are (a) objectively
readable on-chain or from attested data, and (b) expensive/impossible to fake —
the same farmability discipline as the sortition gate (SORTITION-TABLE-DESIGN
§5). The candidate signals, all mechanical:

| Signal | Why it's a good promotion gate | Farmability |
|--------|-------------------------------|-------------|
| **Sustained mint velocity** | A collective minting real EBT is delivering real metered energy to real payers — the network-value signal (architecture §6). | Hard to fake — every mint leaks the LD+ops floors and needs real fiat-in (I-2) + meter attestation. |
| **Member count (KYC-unique, live)** | A collective representing many real members has real constituency weight. | KYC-unique + liveness-gated; Sybil-bounded by the LD Sybil economics. |
| **LD maturity of its members** | Members with real accrued dividend share = a real, tenured community, not a flash-registered bloc. | Tenure can't be bought (wall-clock); accrual is downstream of real earning. |
| **Council liveness** | The child council has actually been operating (rotating, acting) for a minimum period. | Wall-clock + on-chain action history. |
| **Cross-operator diversity** (if the tier spans operators) | Guards against a single operator dressing up as a collective (B-2 one level up). | Requires genuinely multi-operator activity. |

The **anti-signals** (what must NOT be a criterion): anything discretionary
("the parent likes them"), anything fiat-weighted (plutocracy), anything a
single operator can manufacture for a sponsored bloc (B-2).

---

## 2. The tiers (illustrative structure; thresholds are Garrett's)

The tree grows in levels; each promotion is a collective at level `n` earning a
seat at level `n+1`:

```
household member
  └─ village/cluster council      (level 1 — the base collective)
       └─ county federation        (level 2)
            └─ national tier        (level 3)
                 └─ (continental, far future)
```

A **level-1 cluster** forms per charter §2 (it needs only the 5-seat sortition
precondition). Promotion is about **level-1 → level-2 → level-3**: when may a
cluster hold a seat in a county federation, and when may a county federation
hold a seat in the national tier?

Each promotion uses the §1 signals with tier-appropriate thresholds:

- **Cluster → county seat:** the cluster must show sustained mint velocity, a
  minimum live KYC'd member count, minimum council liveness, and minimum member
  LD maturity — all `TODO(calibration)` per §3.
- **County → national seat:** the county federation must show the same signals
  aggregated across its clusters, plus (if applicable) cross-operator diversity
  — `TODO(calibration)`.

The *structure* (which signals, monotone thresholds rising with tier) is the
spec; the *numbers* are Garrett's.

---

## 3. Open calibration items (Garrett's call — do NOT invent)

| # | Parameter | Notes |
|---|-----------|-------|
| CAL-PROMO-MINT | Sustained mint-velocity threshold per tier (and the averaging window) | The primary economic-reality gate |
| CAL-PROMO-MEMBERS | Minimum live KYC'd member count per tier | Constituency-weight gate |
| CAL-PROMO-MATURITY | Minimum member LD-maturity distribution per tier | Anti-flash-bloc gate |
| CAL-PROMO-LIVENESS | Minimum council operating period before promotion | Anti-brand-new gate |
| CAL-PROMO-DIVERSITY | Cross-operator diversity minimum (multi-operator tiers) | B-2-up guard |
| CAL-PROMO-REVIEW | Challenge/verification window on a promotion (parallel to charter challenge) | Public contestability |

Guidance for setting them (not decisions): thresholds should **rise
monotonically with tier** (a national seat demands more than a county seat), and
should be set so that meeting them is a real achievement (promotion means
something) but not so high that the tree can never grow (W-4: the criterion must
actually admit new tiers as the network reaches them, mechanically).

---

## 4. Interaction with the rest of the design

- **Charter §3.3** requires exactly this doc's mechanical criterion; a parent
  checks it and does not judge.
- **WI-23 standing rules** still apply on top: even a qualifying collective's
  *seat* must be a lower-tier member council (R-1), and the parent seats it via
  `approveFederated` (WI-21).
- **W-4 (NATIONAL-ONBOARDING)** is the same principle for roll-expansion; the
  mint-velocity + footprint signals here and the "which county next" criterion
  there should be kept consistent (both mechanical, both published) so the
  network's *governance* growth and its *membership* growth follow the same
  legible, non-patronage logic.

---

## 5. One sentence

> A collective earns a seat one tier up by mechanically meeting published,
> non-farmable thresholds — sustained real mint velocity, live KYC'd member
> count, member LD maturity, council liveness, and (for multi-operator tiers)
> cross-operator diversity, rising monotonically with tier — so that a parent
> merely verifies eligibility and never grants seats by taste, keeping the
> tree's growth an entitlement of demonstrated real-world constituency rather
> than a prize incumbents dispense.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy frame; thresholds are `TODO(calibration)`
(Garrett's call). WI-22 of the Federation Implementation Plan. Post-pilot.*
