# WI-14 — EBT vNext (tariff-path metadata, multi-lane split, statutory lanes, dual-redemption) — Dispatch Brief

**Status:** Dispatch brief. Written for a supervising BIG session at
dispatch time — NOT to be executed by the drafting session.
**Class:** 💰 **touches-funds**, settlement contract change. Highest-risk
item in the whole federation plan.
**Exec permission:** **BIG only.** Two independent BIG passes required
(§5.1 💰 row). No `--skip-zk`. No shortcuts. Ceremony required at deploy.
**Depends on merged:** WI-01 (escrow design), WI-02 (clearinghouse),
WI-03 (fungibility stance — folded into D-10), WI-06 (schedule model),
WI-07 (statutory lanes), WI-13 (TariffRegistry contract). WI-13 must be
compiled and DEV-DRAFT-stable before this brief is dispatched.
**Blocks:** multi-operator settlement, national rollout Phase 2+.

**Read this brief before you read anything else in the plan.** The
constraints below are not commentary; they are the safety envelope for
the single most fund-adjacent contract change in the series.

---

## READ FIRST (exact files, in order)

1. `FEDERATION-IMPLEMENTATION-PLAN.md` §0.1 (**"the mint pays"** — the
   constitutional preamble is enforcement scope for this contract), §0.2
   (Compact discipline, standing invariants I-1/I-2/I-3), §0.3 (D-1, D-5
   through D-10 — every one shapes this contract), §2.1 critical path.
2. `NATIONAL-ESCROW-DESIGN.md` — D-5..D-9 in full. Understand:
   dual KES/kWh redemption; the **release-on-mint-attestation** single
   authorization; the published solvency invariant; the drain-window /
   fixed-notice lifecycle. The redemption side of this contract must
   compose cleanly with the escrow side, or funds break.
3. `CLEARINGHOUSE-DESIGN.md` — D-10 energy-denominated fungibility.
   **Per-coin fiat metadata, not pooled.** This is the redemption model
   this contract implements.
4. `TARIFF-SCHEDULE-MODEL.md` — WI-06 canonical schedule model. Splits
   this contract resolves come from here.
5. `STATUTORY-LANES-MODEL.md` — WI-07. Statutory-lane routing at
   settle-time; sum-to-10000 invariant.
6. `tariff-registry/V1-DESIGN.md` + `tariff-registry/tariff-registry-v1.compact`
   — WI-13 output. This contract reads registry state via the MIP-0002
   event/keeper pattern; it does NOT call the registry directly (no
   contract-to-contract calls in Compact).
7. `ebt/ebt-v7.4.2.compact` — **the production baseline this contract
   forks from.** Read the entire file. Understand `settle`, `attest`,
   `reissue`, HAT payload construction (line ~563), the LD binding, the
   claim/claimSplit path, `_dividendMintedLog` shape.
8. `ebt/V7-DESIGN.md` + `ebt/V7.1-EVENT-DIFF.md` — v7 design lineage.
9. `memory/2026-07-07-audit-findings.md` (or wherever it lives) — Wave 1
   finding **EBT-H-1** (producerAddr not in HAT signed payload,
   mint-redirection). Any vNext MUST fix this by construction, not just
   inherit v7.4.2's status quo.
10. `memory/reference-architecture.md` — pilot invariants I-1 (1 EBT =
    1 kWh) and I-2 (mint-after-payment).

---

## DELIVERABLE (exact paths, format)

- `ebt/ebt-vNext.compact` — the new lineage. Version string per naming
  convention set by the supervising session at dispatch (e.g. `v8` if the
  break is total; `v7.5` if it is strictly additive — the supervising
  session decides after reading the diff).
- `ebt/VNEXT-DESIGN.md` — full design doc: circuits, ledger fields,
  event shapes, invariants (I-1..I-3 preserved, new I-14-A..I-14-H below
  added), non-goals, migration story from v7.4.2.
- `ebt/VNEXT-MIGRATION.md` — explicit migration plan for existing pilot
  coins if this lineage supersedes v7.4.2 in production, OR explicit
  statement that v7.4.2 remains pilot canon and vNext deploys in parallel
  post-pilot. This is a **Garrett + supervising session decision**, not
  the executing session's.
- `ebt/tests/` additions — full offline smoke suite covering every
  invariant below.
- Full-ZK compile transcript attached to PR body.
- PR: `feat/ebt-vnext`, draft until **two** independent BIG reviews pass.

---

## SCOPE — what this contract does that v7.4.2 does not

Five additions, each one a self-contained circuit-level change:

### A. Per-coin tariff-path metadata (WI-06 §2)

Every minted coin carries `tariffPath` in its backing metadata:
`(scheduleId, classPath, epoch, fiatValueAtMint)`. This is the D-10
"per-coin fiat metadata" made concrete. At mint time, `settle` records
the tariff path used and the fiat value assigned. At redeem time, the
fiat side pays what the coin's own metadata records — not a pooled rate.

`fiatValueAtMint` is bounded by the sanity band (WI-06 CAL-2) so a
divergence between coin face values cannot exceed policy limits.

### B. Multi-lane split resolution (against registered schedule)

`settle` no longer takes a single `producerAddr`; it takes
`(scheduleId, classPath, epoch)` and resolves splits from the registered
schedule via the WI-13 keeper's event-mirrored view. The circuit MUST
verify the resolved splits sum to exactly 10000 bps (I-14-C below) and
mint separate outputs per lane.

Splits are read from a **keeper-mirrored** copy of registry state, event
integration per MIP-0002, NOT via contract-to-contract call.

### C. Statutory-lane routing (WI-07)

Lanes with `laneKind == STATUTORY_*` route to their designated
`remitAddress` per WI-07's per-class applicability rules. The routing is
inside the circuit, not a keeper trust point — a statutory lane whose
`remitAddress` is missing MUST fail settle, not silently pool the money
into the ops lane.

### D. Escrow-aware redemption (WI-01 D-5..D-9)

`redeem` takes a coin and a `redemptionKind ∈ {KES, KWH}`:
- `KES`: releases the coin's `fiatValueAtMint` from the escrow trust
  float (D-7 release-on-attestation single authorization). Coin burned.
- `KWH`: routes to the operator-side kWh delivery path (specifics TBD by
  supervising session at dispatch — this half may split into a companion
  circuit).

Redemption MUST re-check the solvency invariant (D-8) — a redeem that
would leave attested trust balance < outstanding EBT MUST fail.

### E. Mint-redirection fix (EBT-H-1 from 2026-07-07 audit)

The HAT signed payload MUST include `producerAddr` (or MUST bind
`producerAddr = addressFromKey(producerKey)`). v7.4.2's 4-field payload
(producerKey, meterKey, kWh, epoch) is insufficient — an observer of a
valid attestation tuple can submit `settle` with their own producerAddr
and redirect mint. vNext MUST close this by construction. Domain-sep
tag becomes `pollpower:ebt:vNext:epoch1` (or the versioned equivalent).

---

## INVARIANTS THAT MUST HOLD (checkable statements)

All v7.4.2 invariants (I-1 1 EBT = 1 kWh, I-2 mint-after-payment, I-3
attest / reissue / settle preconditions) are preserved. Additionally:

**I-14-A (mint-redirection fixed by construction):** the HAT signed
payload includes `producerAddr` (or an in-circuit binding
`producerAddr == addressFromKey(producerKey)`). No path exists by which
`settle` mints to an address not in the signed payload. This is a bug
fix, not an addition — v7.4.2's payload is insufficient (see EBT-H-1).

**I-14-B (schedule-path enforcement):** every successful `settle` cites a
`(scheduleId, classPath, epoch)` that resolves in the keeper-mirrored
registry view AND is not a retired schedule at that epoch. No
free-form splits.

**I-14-C (sum-to-10000 preserved at circuit level):** the splits used to
mint MUST sum to exactly 10000 bps. Re-checked in the circuit, not
trusted from the keeper's view.

**I-14-D (statutory lane routing is not optional):** if the resolved
splits include a `STATUTORY_*` lane, its `remitAddress` MUST be present
and non-zero. Missing statutory `remitAddress` → settle fails. Silent
pooling of statutory amounts into ops is a security bug.

**I-14-E (per-coin fiat metadata immutability):** once minted,
`fiatValueAtMint` on a coin cannot be modified. `reissue` preserves it.
Nothing rewrites it.

**I-14-F (redemption solvency guard):** every `redeem` for `KES`
re-checks D-8's solvency invariant. Any redeem that would violate it
fails. This is a circuit-level check, not a keeper trust point.

**I-14-G (drain-window semantics):** a de-federated operator (D-9)
cannot open new `settle` at that operator's scheduleId, but in-flight
attestations already mid-drain complete. The circuit distinguishes these
via operator-status predicate.

**I-14-H (LD binding preserved):** vNext preserves v7.4.2's LD binding to
`_dividendMintedLog` — LD pool bumps continue to fire on mint per v7.4.2
semantics. Any change to LD binding is out of scope for this brief and
requires its own item.

**Standing (Compact discipline, §0.2):** no contract-to-contract calls
(MIP-0002 event/keeper only), no integer `/` or `%` in-circuit
(witness-computed divmod + `checkedDivide` verify — critical for split
math), no `<`/`<=` on `Field`, all sealed fields in `constructor()`,
`disclose()` on every witness → ledger path.

---

## ACCEPTANCE CRITERIA (what BIG review will check)

1. Clean full-ZK compile on compactc 0.31.0, zero warnings, transcript in
   PR body.
2. All REQUIRED TESTS pass in the offline suite, including the negatives.
3. **Two independent BIG passes** (different sessions, no shared context)
   sign off on I-14-A (mint-redirection), I-14-D (statutory routing), and
   I-14-F (solvency guard). §5.1 💰 row.
4. Adversarial pre-read documented in PR: "worst compliant implementation
   of this brief?" — answered before code was written.
5. Cross-brief consistency check: WI-14's assumed WI-13 interface matches
   WI-13's actual exported signatures. Record WI-13 commit hash reviewed
   against.
6. Migration story in `VNEXT-MIGRATION.md` explicitly addressed by
   Garrett + supervising session BEFORE ceremony.
7. Ceremony plan attached: keyholders, order of operations, rollback
   posture. No deploy without a written ceremony plan.

---

## REQUIRED TESTS (offline smoke suite)

Each test lives in `ebt/tests/`, TypeScript, deterministic, no network.

**Positives:**
1. **T1 — end-to-end happy path:** register schedule (mock registry
   event) → attest → settle with (scheduleId, classPath, epoch) → mint
   splits across LD, ops, statutory lane → sum to input kWh × 10000
   bps exactly → LD `bumpOnMint` fires.
2. **T2 — dual redemption:** mint coin at `fiatValueAtMint = X`; redeem
   `KES` → trust float releases exactly X; redeem sibling coin `KWH` →
   kWh delivery path fires. Per-coin, not pooled.
3. **T3 — reissue preserves metadata:** reissue a coin, `fiatValueAtMint`
   and `tariffPath` unchanged (I-14-E).

**Negatives (the important half):**
4. **T4 — I-14-A: mint-redirection attempt fails.** Observer takes a
   valid HAT tuple, submits settle with their own producerAddr. MUST
   fail. If it passes, everything else is moot.
5. **T5 — I-14-B: settle against unregistered scheduleId fails.**
6. **T6 — I-14-B: settle against retired schedule at post-retirement
   epoch fails.**
7. **T7 — I-14-C: crafted splits that sum to 9999 or 10001 fail.**
   Property test at 1000 random split vectors.
8. **T8 — I-14-D: statutory lane with missing `remitAddress` fails.**
   Does not silently pool into ops.
9. **T9 — I-14-F: redeem that would violate solvency fails.** Simulate
   trust float at boundary + one satoshi over.
10. **T10 — I-14-G: de-federated operator cannot start new settle.**
    In-flight settle at same operator + fresh attestation completes.
11. **T11 — I-14-H: LD `_dividendMintedLog` shape matches v7.4.2 for
    identical mint inputs.** Regression guard for the LD keeper's
    contract-scope filter (Session 9 fix).

**Property tests:**
12. **T12 — random schedules × random splits × random paths, 1000 runs:**
    every successful settle satisfies I-14-C and I-14-H simultaneously.

---

## DO NOT (hard constraints — this contract touches money)

- **DO NOT deploy without a written ceremony plan and Garrett's explicit
  green light.** DEV DRAFT at PR time. Ceremony is a separate item.
- **DO NOT modify `ebt/ebt-v7.4.2.compact`.** Fork to a new file. v7.4.2
  is pilot canon.
- **DO NOT modify `living-dividend/*` or `multisig/*`.** LD binding
  preserved by shape (I-14-H); any real LD change is a separate item.
- **DO NOT introduce a contract-to-contract call to WI-13.** Compact
  forbids it. MIP-0002 event + keeper mirror, always.
- **DO NOT pool fiat redemption across coins.** D-10 is explicit:
  per-coin `fiatValueAtMint`. Pooling is the pre-D-10 model and is
  wrong.
- **DO NOT silently pool statutory amounts into ops when
  `remitAddress` is missing.** Fail settle. I-14-D is a security
  invariant, not a UX preference.
- **DO NOT skip the sanity-band check on `fiatValueAtMint`.** CAL-2 is a
  placeholder; the check is real.
- **DO NOT resolve any CAL-n value.** In particular CAL-1 (floors),
  CAL-2 (sanity band), CAL-11 (remittance default). Placeholders +
  `TODO(calibration)`.
- **DO NOT use `--skip-zk` for any compile that will inform a review
  decision.** Full-ZK only.
- **DO NOT ship with v7.4.2's 4-field HAT payload.** I-14-A is a bug fix;
  inheriting v7.4.2's status quo means shipping a known finding.
- **DO NOT let the migration decision (VNEXT-MIGRATION.md) be made by
  the executing session.** Garrett + supervising session only.

---

## CALIBRATION PLACEHOLDERS (Garrett's call, do NOT resolve)

Executing session MUST mark and continue with placeholders:

| CAL | Where used |
|-----|-----------|
| CAL-1 | `LD_FLOOR_BPS`, `OPS_FLOOR_BPS` — resolved via WI-13, referenced here. |
| CAL-2 | Sanity-band width — bounds `fiatValueAtMint` at settle. TODO. |
| CAL-8 | Statute-to-lane ceremony parameters — reference only. |
| CAL-11 | Remittance default (option 1 fiat door vs option 2 on-chain lane) — shapes statutory `remitAddress` semantics. TODO. |

Any temptation to resolve any of these to make a test pass is an
escalation trigger, not a workaround.

---

## ESCALATION TRIGGERS (stop and comment on the draft PR)

Per plan §5.3 — for 💰 items, the trigger threshold is *lower*, not
higher:
1. Any READ-FIRST file contradicts this brief.
2. Any invariant I-14-A..I-14-H cannot be satisfied as written.
3. The change wants to touch v7.4.2, LD, or multisig.
4. A CAL-n value must be picked.
5. A test can only pass by weakening it OR by using `--skip-zk`.
6. The keeper/event pattern feels like it wants a contract-to-contract
   call (it doesn't; the executing session is confused).
7. Migration story looks nontrivial. Stop and get Garrett.
8. Any redemption or split path exceeds the safety envelope of the
   escrow's published solvency invariant.

For 💰 items, escalation is cheap; a bad merge is not.

---

## Supervising-session pre-dispatch checklist

- [ ] WI-13 has landed on `main` as DEV DRAFT, compile-clean, tests
  passing. Record commit hash.
- [ ] EBT-H-1 finding read fresh from the 2026-07-07 audit memo; do not
  rely on this brief's summary.
- [ ] Two BIG sessions scheduled, staggered, with no shared context on
  the diff — book them BEFORE the executing session starts.
- [ ] Ceremony plan skeleton drafted with Garrett before dispatch, not
  after — the executing session's job is to make the ceremony plan
  fillable, not to invent it.
- [ ] Red-team pass: "worst compliant implementation of this brief?" —
  answered in the dispatch memo, attached to the executing session's
  first message.
- [ ] Confirm compactc 0.31.0 is the executing environment.

---

## The one paragraph for Garrett to read before dispatching this

This is the settlement contract. It is the piece where a bug becomes a
lost pilot, a lost trust license, or a lost person's dividend. The
brief above is *long on purpose*: every DO NOT is a specific way this
contract can silently go wrong, drawn from the audit history of the
lineage (EBT-H-1) and the constitutional structure of the federation
(D-4, D-5..D-9, D-10). If the executing session pushes back on any
constraint here as "unnecessary", that is the moment to switch sessions,
not the moment to relax the brief. The verification loop is the only
thing between spec and disaster.

---

*Dispatch brief authored 2026-07-14, per FEDERATION-IMPLEMENTATION-PLAN.md
§4 skeleton + §5.1 💰 row. This document is spec/policy only; zero
contract code lives here.*
