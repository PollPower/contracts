# WI-13 Dispatch Memo — 2026-07-14

**For:** the executing BIG session picking up
`dispatch-briefs/WI-13-TariffRegistry.md`.
**Read order:** (1) BOOTSTRAP-PROMPT.md — (2) THIS MEMO — (3) WI-13 brief —
(4) all READ-FIRST files the brief names.
**Status:** dispatch memo, not a brief amendment. The brief in PR #28 is
canonical. This memo carries three things the brief cannot:

1. The resolved calibration values you MUST use (CAL-1, CAL-2).
2. The eight red-team amendments from `WI-13-REDTEAM-MEMO.md` as
   ground rules for your work.
3. The exact reviewed-against commit hashes so your PR body can cite
   them.

**Purpose:** everything the brief left symbolic is now concrete. There
is no CAL-n you need to invent. Every escalation trigger except #2 (any
invariant cannot be satisfied) is the fail-safe you use if this memo
somehow contradicts source; it should not.

---

## Section 1 — Reviewed-against commit hashes

The brief was written against and this memo published against `main` at:

- **Repo `main` HEAD:** `fad17d2` (docs: pre-dispatch kit for WI-13
  merged in PR #29)
- **`multisig/FEDERATION-CHARTER-PROTOCOL.md`:** blob
  `4dca4f2` (charter structure + node-id semantics WI-13 consumes)
- **`TARIFF-SCHEDULE-MODEL.md`:** blob `1650dd2` (WI-06 schedule model +
  §7.1 governance-first ID rule)
- **`STATUTORY-LANES-MODEL.md`:** blob `58fa615` (WI-07 lane extension +
  sum-to-10000)

Cite these in your PR body under "Reviewed against." If the current
`main` has moved by the time you dispatch, re-hash against then-current
and note any divergence — escalation trigger 1 fires if any READ-FIRST
file has changed materially since these hashes.

---

## Section 2 — Resolved calibration values (do NOT re-open)

From `dispatch-briefs/CALIBRATION-DECISIONS-RESOLVED-2026-07-14.md`.
Bake these into `tariff-registry/V1-DESIGN.md` as named constants.
Use them in test fixtures.

| Constant | Value | Semantic |
|---|---|---|
| `LD_FLOOR_BPS` | **200** | 2.00% Living Dividend floor |
| `OPS_FLOOR_BPS` | **2000** | 20.00% operator ops floor |
| `SANITY_BAND_PCT` | **20** | ±20% around schedule reference value |

**Indexation rule:** sanity band is **epoch-anchored moving window** —
recenters on the schedule's `advanceEpoch` governance act, not on
block-time or witness disclosure (see F-7 below).

These are Garrett-resolved. Do not treat them as `TODO(calibration)`.
Do not resolve any other CAL-n value — see §3.

---

## Section 3 — Ground rules from the red-team pass

These are the eight failure modes from `WI-13-REDTEAM-MEMO.md`,
translated into hard rules for your session. Each supersedes any softer
reading of the brief.

### F-1. "MUST fail" means REVERT

When the brief says `registerSchedule` MUST fail for an unchartered
node (I-A), or that any invariant "MUST" hold, that means **circuit-level
revert**. Not `emit(SchedulePendingCharter)`. Not `return false`. Not
"success-with-warning-event." Revert.

Test T2 (I-A negative) MUST demonstrate revert semantics, not
warning-event acceptance.

### F-2. `retuneClass` is un-gated by design

Do not add federation approval to `retuneClass`. The un-gated
permissionless-within-bounds behavior is a SAFETY feature (companies
get the leaves). The IN-CIRCUIT floor check (I-B) is the safety
property. Adding federation gating REDUCES safety by collapsing the
constitutional separation of powers.

If you find yourself wanting to gate `retuneClass` "just for
malicious retunes" — that IS the escalation trigger. Comment on the
draft PR and stop.

### F-3. No contract-to-contract calls, no matter how awkward

WI-13 does NOT read charter registry state directly to verify I-A.
Compact forbids contract-to-contract calls, but the deeper point is
architectural: the circuit verifies a **witness** (a charter existence
proof) provided by the caller. A keeper off-chain mirrors charter
state into a form the witness can prove against.

If verifying the charter feels awkward, that is because you are
reaching for a direct call. Use witness + keeper.

### F-4. Schedule-to-seat mapping is explicit

The mapping from a schedule's `nationRef` / `operatorId` to the
`_attestors` seat that MUST sign its `federationApproval` MUST be:

- **Diagrammed in `V1-DESIGN.md`** — a diagram, not just prose.
- **Exercised by at least TWO wrong-seat negatives** in your test
  suite (not just T5's single unregistered-key case). Different
  wrong-tier and different wrong-scope wrong-seat combinations.

### F-5. Sanity band re-checked on every retune

The brief's I-B floor check is not the whole story. Add to your
implementation: **`retuneClass` MUST re-check the sanity band
against the current registered schedule's reference value.** A
sequence of small retunes that would drift the schedule past ±20%
of its declared reference MUST fail on the retune that crosses the
boundary.

Add test **T3.5**: attempt a retune that would push
`fiatValueAtMint` outside `±SANITY_BAND_PCT` of the schedule's
reference; it MUST fail.

### F-6. Emit events sufficient for keeper invalidation

Every state-mutating circuit (`registerSchedule`, `registerLane`,
`retuneClass`, `retireSchedule`, `advanceEpoch`) MUST emit an event
sufficient for a downstream keeper (WI-14's reader) to invalidate
its mirrored view.

**Enumerate the full event list in `V1-DESIGN.md`.** Include the
field shape for each event and a note on which downstream state
each keeper would invalidate on receipt. Do not leave this to
future-work.

### F-7. `EPOCH` advance is a named gated circuit

Do NOT derive `EPOCH` from block time. Do NOT accept an `epoch`
witness disclosure. Add a named circuit `advanceEpoch()` that:

- Increments `EPOCH` by 1 (monotone).
- Is gated by federation approval (same shape as `registerSchedule`).
- Emits an `EpochAdvanced{oldEpoch, newEpoch, blockHeight}` event
  (per F-6).
- Cannot decrement, skip, or repeat.

Test: attempt an epoch decrement — MUST fail. Attempt an
epoch advance without federation approval — MUST fail.

### F-8. Escalation trigger 3 is the FIRST rule

Before you write any code, acknowledge in your draft PR body:

> "I will not touch any file outside `tariff-registry/`. If I find
> myself wanting to modify anything under `ebt/`, `living-dividend/`,
> `multisig/`, or any other lineage, I will stop and comment on this
> PR."

This is the "while I'm in there" trap. The failure mode is
well-intentioned refactoring of adjacent contracts that slips
through review because reviewers focus on the named contract.

---

## Section 4 — What the completed diff looks like

Your PR, when ready-for-review, MUST contain:

**Files (per brief DELIVERABLE):**
- `tariff-registry/tariff-registry-v1.compact` — new contract, new
  lineage.
- `tariff-registry/V1-DESIGN.md` — with the F-4 diagram, F-6 event
  enumeration, F-7 advanceEpoch specification, and CAL-1 / CAL-2
  values as named constants.
- `tariff-registry/README.md` — one-page overview.
- `tariff-registry/tests/` — offline smoke suite covering T1..T7
  from the brief PLUS T3.5 (F-5) PLUS the F-4 second wrong-seat
  negative PLUS the F-7 epoch-decrement and unauthorised-advance
  negatives.

**PR body:**
- "Reviewed against" section citing the four commit hashes from §1
  (or the current-main hashes if `main` moved, with divergence
  notes).
- Red-team pre-read: your OWN answer to "worst compliant
  implementation of this brief?" — three failure modes minimum,
  NOT copied from `WI-13-REDTEAM-MEMO.md` (that was mine).
- F-8 acknowledgement quoted verbatim.
- Full-ZK compile transcript (compactc 0.31.0, no `--skip-zk`).
- Test-run transcript showing all tests green.

**Ready-for-review criteria (§5.1 🏛 row):**
- One BIG adversarial review pass required.
- Garrett sign-off before merge.

---

## Section 5 — Post-merge follow-up (your responsibility)

- Update `FEDERATION-IMPLEMENTATION-PLAN.md` §6 status tracker:
  WI-13 row → ✓ merged with your PR number.
- Write memory file:
  `C:\Users\Garrett\.openclaw\workspace\memory\YYYY-MM-DD-wi13-merged.md`
  with the PR number, notable decisions, and any invariants you
  suggest for a future brief revision.
- Do NOT dispatch WI-14. WI-14 requires a separate BIG session with
  no shared context from yours (§5.1 💰 two-pass rule).

---

## Section 6 — If something feels wrong

Per plan §5.3:

1. READ-FIRST files contradict this memo or the brief → STOP, comment
   on the draft PR.
2. Any brief invariant or memo ground rule cannot be satisfied → STOP.
3. You want to touch a file outside `tariff-registry/` → STOP.
4. A test can only pass by weakening it → STOP.
5. `--skip-zk` looks tempting → STOP.
6. Any CAL-n other than §2's three feels like it needs to be picked → STOP.
7. Anything in §3's F-1..F-8 feels like it "should be relaxed" — that
   is exactly the pattern the red-team memo predicted → STOP.

Escalation costs nothing. A merged bad diff costs everything. This is
the entire point of the federation series' verification loop.

---

*Dispatch memo authored 2026-07-14 22:22 JST by supervising session,
per plan §5.4 supervising-session checklist. Consumed by executing
session at dispatch time. Do NOT modify this file after dispatch — if
values need to change, append a new dated memo.*
