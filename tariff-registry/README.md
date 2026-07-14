# TariffRegistry (WI-13) — DEV DRAFT (not started, blocked)

**Status:** ⛔ **BLOCKED at environment gate.** Not started, not deployed,
not audited.
**Work item:** WI-13 of
[`FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md).
**Class:** 🏛 governance-adjacent contract change (BIG-only per plan §5.1).
**Brief:** [`dispatch-briefs/WI-13-TariffRegistry.md`](../dispatch-briefs/WI-13-TariffRegistry.md).
**Dispatch memo:** [`dispatch-briefs/WI-13-DISPATCH-MEMO-2026-07-14.md`](../dispatch-briefs/WI-13-DISPATCH-MEMO-2026-07-14.md).

## What this directory will contain (per brief §DELIVERABLE)

- `tariff-registry-v1.compact` — the on-chain source-of-truth for tariff
  schedules that WI-14 will resolve settlement splits against.
- `V1-DESIGN.md` — design doc mirroring `ebt/V7-DESIGN.md`.
- `tests/` — offline smoke suite (T1–T7 from the brief + T3.5 sanity-band
  retune + F-4 second wrong-seat + F-7 epoch-decrement / unauthorised-advance
  negatives per dispatch memo §3).

## What this directory currently contains

Only this README, opened as an escalation-first stub so the draft PR could
be created without inventing contract code before the environment gate is
resolved.

## Why blocked

The dispatch memo §4 and plan §0.2 require a **full-ZK compile on
compactc 0.31.0** as an acceptance criterion for merge. The executing
host does not have `compactc` installed. Escalation posted to the draft PR
per plan §5.3 trigger #2 (invariant "clean full-ZK compile" cannot be
satisfied as written). Waiting on Garrett's ruling.

## When work resumes

Delete this stub note and replace with a real one-page overview once the
first `.compact` skeleton compiles clean, per the brief's
`ACCEPTANCE CRITERIA` (§ACCEPTANCE 1: "Clean full-ZK compile on
compactc 0.31.0, zero warnings, transcript in PR body").

---

*Placeholder stub — 2026-07-14. No contract code committed. Not deployed.*
