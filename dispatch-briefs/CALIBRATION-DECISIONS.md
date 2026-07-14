# Calibration Decision Sheet — Garrett's Blocking Inputs

**Purpose:** every CAL-n placeholder in the federation plan that gates
WI-13 / WI-14 dispatch, collected in one place with the concrete question,
where it's consumed, what would be a reasonable default range (**not a
recommendation**), and the concrete downstream tests that need the value
to pass.

**Rule:** executing sessions MUST NOT resolve any of these. This sheet
exists so Garrett can resolve them in one sitting, out-of-band, then
plumb the answers into the dispatch memo as concrete constants.

**Status:** all items OPEN as of 2026-07-14 unless marked otherwise.

---

## CAL-1 — LD floor and Ops floor (national defaults)

**The concrete parameters:**
- `LD_FLOOR_BPS` — minimum share of every settled kWh that MUST route to
  the Living Dividend national pool. Basis points (0..10000).
- `OPS_FLOOR_BPS` — minimum share that MUST route to the operator's ops
  lane (fixed costs, maintenance, grid uptime).

**Consumed by:** WI-06 validator, WI-13 registry (I-B floor check on
`retuneClass`), WI-14 EBT vNext at settle-time (I-14-C sum-to-10000
requires knowing the floors before splits resolve).

**Range for consideration (NOT recommendation):**
- LD floor: pilot precedent is single-digit percent (v2.2.x LD share
  observed in the June accumulator math); the *national* floor is a
  political number, not a technical one. Range typically discussed:
  3%–10% (300–1000 bps).
- Ops floor: whatever number keeps operators solvent under the sanity
  band. Depends on their disclosed cost stack. Range typically discussed:
  20%–40% (2000–4000 bps).

**Interaction:** together with statutory-lane totals (CAL-11) and any
mandated cross-subsidy (CAL-8), the floors must sum to something well
below 10000 bps or `retuneClass` cannot function.

**What breaks without it:**
- WI-13 test T3 (I-B negative retune) cannot be authored — no floor to
  cross.
- WI-14 test T1 (happy path) needs concrete floor values in the fixture
  schedule.

**Blocking WI-13?** Not for compile — placeholders work. Blocking for
**test authoring** — yes.
**Blocking WI-14?** Yes for test authoring; not for compile.

---

## CAL-2 — Sanity-band width + indexation rule (C-6)

**The concrete parameters:**
- Sanity-band width: how far a per-coin `fiatValueAtMint` may diverge
  from the network-median before settle rejects. Expressed as a
  percentage or a hard-cap-plus-floor.
- Indexation rule: does the band recenter over time (rolling window,
  epoch-anchored, statute-anchored)? Recentering cadence?

**Consumed by:** WI-06 registration validator, WI-13 `resolvePath` view,
WI-14 settle (I-14-E immutability check is trivial; the bound at *mint*
time is where CAL-2 lives).

**Range for consideration (NOT recommendation):**
- Width: 5%–20% around a median. Wider protects producers from local
  cost shocks; narrower protects redemption predictability.
- Indexation: choices are (a) fixed at charter time, (b) epoch-anchored
  moving window, (c) statute-anchored (updates when the tariff schedule
  itself epoch-bumps).

**What breaks without it:**
- WI-14 cannot test the "coin at boundary of band" positive case or the
  "coin one satoshi over" negative — no band to test against.
- The redemption-predictability story to CBK / trust regulators leans on
  this number. Without it the D-8 solvency invariant is technically
  fine but the *marketing* invariant ("what your coin is worth") has no
  bound.

**Blocking WI-13?** Not directly. Blocking for **red-team
completeness** — a WI-13 review that can't reason about band-drift is
weaker.
**Blocking WI-14?** Yes for test authoring.

---

## CAL-8 — Statute-to-lane ceremony parameters (R-3)

**The concrete parameters:**
- Quorum required to add/change/retire a `STATUTORY_*` lane.
- Review window (how long the proposed change is public before it takes
  effect).
- Publication venue and format.

**Consumed by:** WI-07 (upstream), referenced by WI-13 (lane changes go
through federation approval circuits the registry accepts), touches
WI-14 indirectly (settle-time routing depends on lanes existing).

**Range for consideration (NOT recommendation):**
- Quorum: matches or exceeds the tier's baseline governance quorum. If
  ordinary tier decisions are 3-of-5, statutory-lane ceremony is
  4-of-5 or 5-of-5. The intuition: statutory lanes reach into the
  legal system; the ceremony should be visibly harder.
- Review window: minimum a full member-notification cycle. 14–30 days
  is the typical political range.
- Publication: on-chain event + off-chain human-readable text at a
  stable URL.

**What breaks without it:**
- Nothing in the WI-13 / WI-14 briefs directly; both accept the value as
  input. But the ceremony *concept* has to exist by the time a real
  statutory lane is added, or the political-legitimacy argument
  collapses.

**Blocking WI-13?** No.
**Blocking WI-14?** No, but blocking real-world use of statutory lanes.

---

## CAL-11 — Remittance default: option 1 (fiat door) vs option 2 (on-chain lane)

**The concrete question:**
- **Option 1 (fiat door):** a `STATUTORY_*` lane's `remitAddress` points
  to a bank/M-Pesa/paybill account. Settle mints EBT for the lane;
  redemption on the lane routes fiat to that account. State receives
  fiat in the units it understands.
- **Option 2 (on-chain lane):** `remitAddress` is a state-controlled
  on-chain address. Settle mints EBT for the lane; the state holds and
  redeems as it chooses. State receives EBT and can hold/convert on its
  own schedule.

**Consumed by:** WI-07 lane semantics, WI-14 statutory-lane routing
(I-14-D applicability), the political story to the state.

**Trade-offs (surface-level, NOT a recommendation):**
- Option 1 is legally cleaner in the near term (state already knows
  what to do with M-Pesa balances) and matches how existing tax /
  levy remittance works.
- Option 2 is philosophically consistent with the whole project
  (state as a first-class on-chain actor, "state attests, mint pays")
  and cheaper at scale, but requires the state to hold custody of
  something it may not want to hold.
- Mixed default: option 1 by default at charter time, option 2
  available if a specific statute names an on-chain remit address.

**What breaks without it:**
- WI-14 test T8 (I-14-D statutory-lane missing `remitAddress` fails)
  needs a fixture. The fixture needs to know which *kind* of address to
  supply.
- The onboarding conversation with the state's revenue/energy ministry
  needs a default answer.

**Blocking WI-13?** No — registry accepts either shape.
**Blocking WI-14?** Yes for test fixtures; concept-level, not
compile-level.

---

## Summary — what to resolve before dispatching

**Before WI-13 dispatch:**
- CAL-1 (concrete floor values) — REQUIRED for test authoring.
- CAL-2 (sanity-band width) — RECOMMENDED for red-team completeness.

**Before WI-14 dispatch (must also have WI-13 landed):**
- CAL-1 — REQUIRED, propagated from WI-13's values.
- CAL-2 — REQUIRED for band-boundary tests.
- CAL-11 — REQUIRED for statutory-lane fixtures.
- CAL-8 — RECOMMENDED so the ceremony concept exists in the design.

Everything else in the plan's calibration register (CAL-3, CAL-4, CAL-5,
CAL-6, CAL-7, CAL-12) is out of scope for WI-13/WI-14 — those gate other
items (sortition thresholds, cohort sizes, tier-promotion criteria, roll
basis). They can be resolved on their own schedule.

---

## Format for supplying answers

When you resolve these, drop a memo in `dispatch-briefs/` named
`CALIBRATION-DECISIONS-RESOLVED-YYYY-MM-DD.md` with the concrete values
and the reasoning trail. The executing session's dispatch memo pulls
values from that resolved file. The values live in code as named
constants in the target contract's `V*-DESIGN.md`.

*This sheet is spec/policy only. No code. Update in place as items
resolve.*
