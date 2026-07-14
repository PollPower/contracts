# Calibration Decisions — Resolved 2026-07-14 (partial, WI-13 dispatch set)

**Resolved by:** Garrett, 2026-07-14 22:22 JST.
**Scope:** the minimum set to dispatch WI-13. WI-14 requires
additional resolution (CAL-11 at minimum) before dispatch.
**Consumes:** `dispatch-briefs/CALIBRATION-DECISIONS.md`.

---

## CAL-1 — LD floor and Ops floor (national defaults)

- **`LD_FLOOR_BPS = 200`** (2.00% of every settled kWh routes to the
  Living Dividend national pool).
- **`OPS_FLOOR_BPS = 2000`** (20.00% of every settled kWh routes to the
  operator's ops lane).

**Reasoning trail:**
- LD floor at 2% is deliberately conservative for national launch;
  small enough to be politically defensible ("2% of every kWh feeds
  the people who live under the wires") and small enough to leave
  operator margin room. Revisable upward via WI-13 branch operation +
  federation approval; not revisable downward without member-council
  quorum change (constitutional layer).
- Ops floor at 20% is the *wider* of the discussed range (25%/20%/15%),
  favoring operator flexibility and grid-maintenance headroom over
  aggressive consumer-side undercutting. Rationale: at launch, an
  under-margined operator failing is a worse political story than an
  operator margin-of-20% "looking fat" — a stranded grid costs more
  than a fat operator.
- Together: 200 + 2000 = 2200 bps of the 10000 committed as floors,
  leaving 7800 bps for statutory lanes, generation, distribution, and
  operator retune room. Well below the collision boundary.

---

## CAL-2 — Sanity-band width + indexation rule

- **`SANITY_BAND_PCT = 20`** (per-coin `fiatValueAtMint` may not
  diverge from the schedule's declared reference value by more than
  ±20%).
- **Indexation rule:** **epoch-anchored moving window** — the sanity
  band recenters on schedule epoch bumps, not on wall-clock time or
  block-time. Recentering is tied to a governance act (the epoch
  advance is itself a gated circuit per WI-13 red-team F-7).

**Reasoning trail:**
- Wider option (±20%) chosen deliberately: allows operators to price
  through local cost shocks without triggering a settle failure. A
  tighter band (±5%–10%) would produce a cleaner regulator story but
  higher day-to-day fragility for operators facing e.g. fuel or FX
  volatility on inputs.
- Epoch-anchored indexation: ties band recentering to a governance act
  (advanceEpoch), not clock drift. Consequence: within an epoch, the
  band is fixed; across epochs, the band recenters on the epoch's new
  reference. Auditable, non-farmable, and consistent with the
  "companies price, members bound" preamble — the band moves when
  members-through-governance say it moves.

---

## Not resolved in this pass (still open for WI-14)

- **CAL-8** — Statute-to-lane ceremony parameters. Not blocking for
  WI-13; blocking for real-world statutory-lane rollout.
- **CAL-11** — Remittance default (fiat door vs on-chain lane). Must
  be resolved before WI-14 dispatch (test T8 fixture depends on it).

---

## Downstream propagation

- WI-13 `V1-DESIGN.md` names these three constants (`LD_FLOOR_BPS`,
  `OPS_FLOOR_BPS`, `SANITY_BAND_PCT`) with the values above.
- WI-13 test T1 (happy path) uses these values in its fixture schedule.
- WI-13 test T3 (I-B negative retune) uses these values as the floor
  the negative retune attempts to cross.
- The recommended new test T3.5 (sanity-band retune negative, from red-team F-5)
  uses `SANITY_BAND_PCT = 20` as the boundary.
- WI-14, when dispatched, inherits CAL-1 and CAL-2 unchanged; CAL-11
  resolved separately at that time.

---

## Amendment procedure

If any of these values need to change before WI-13 lands, do NOT edit
this file. Append a new `CALIBRATION-DECISIONS-RESOLVED-YYYY-MM-DD.md`
with the revised values and reasoning. The most recent dated file wins
at dispatch time; older files remain as historical record. This mirrors
the plan §5.2 discipline: no in-place mutation of resolved decisions.

If values need to change *after* WI-13 lands on-chain: full governance
ceremony required (branch operation with federation approval per WI-13
I-D). Not an off-chain edit.

*Authored 2026-07-14 by supervising session at Garrett's decision.
Spec/policy only.*
