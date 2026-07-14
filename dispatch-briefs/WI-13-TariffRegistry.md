# WI-13 — TariffRegistry contract (new lineage) — Dispatch Brief

**Status:** Dispatch brief. Written for a supervising BIG session at
dispatch time — NOT to be executed by the drafting session.
**Class:** 🏛 governance-adjacent, contract change (full cycle required).
**Exec permission:** **BIG only.** No CHEAP-OK path. No `--skip-zk`.
**Depends on merged:** WI-06 (`TARIFF-SCHEDULE-MODEL.md`),
WI-07 (`STATUTORY-LANES-MODEL.md`), WI-20
(`multisig/FEDERATION-CHARTER-PROTOCOL.md`). All landed on `main`.
**Blocks:** WI-14 (EBT vNext settlement uses this registry as its source of
truth for split resolution).

---

## READ FIRST (exact files, in order)

1. `FEDERATION-IMPLEMENTATION-PLAN.md` §0.1 (constitutional preamble),
   §0.2 (standing discipline — same-tree invariant, Compact constraints,
   compactc 0.31.0), §0.3 (D-4 governance-first ID minting), and the WI-13
   row in §1 Tier 2 + §2.1 critical path.
2. `TARIFF-SCHEDULE-MODEL.md` — the canonical WI-06 data model. §7.1 is
   load-bearing for this contract: the schedule tree's `nationRef` /
   `operatorId` MUST already be a chartered governance-tree node.
3. `STATUTORY-LANES-MODEL.md` — WI-07's `statutoryLanes` extension.
   Registry verdicts include statutory-applicability match.
4. `multisig/FEDERATION-CHARTER-PROTOCOL.md` — WI-20's charter structure
   and node-id semantics. The registry consumes these identities; it does
   not mint them.
5. `ebt/ebt-v7.4.2.compact` header and `V7-DESIGN.md` — production Compact
   conventions this lineage must mirror (domain tags, `disclose()` posture,
   sealed-field constructors, event/keeper integration pattern MIP-0002).
6. `multisig/multisig-federated-v1.compact` — cross-tier approval circuits
   the registry's branch operations will be gated by (`approveFederated`
   path). Do not modify this file; only reference its signatures.
7. `multisig/FEDERATED-V1-REVIEW.md` — know the standing findings before
   proposing any interaction with federated approval.

---

## DELIVERABLE (exact paths, format)

- `tariff-registry/tariff-registry-v1.compact` — new contract, new
  lineage. Compact 0.31.0. Full-ZK compile transcript attached to PR.
- `tariff-registry/V1-DESIGN.md` — design doc mirroring the shape of
  `ebt/V7-DESIGN.md`: circuits, ledger fields, event shapes, invariants,
  known non-goals.
- `tariff-registry/README.md` — one-page overview, deploy status
  (DEV DRAFT, not deployed, not audited).
- `tariff-registry/tests/` — offline smoke suite. Minimum coverage per
  REQUIRED TESTS below.
- PR: `feat/tariff-registry-v1`, draft until BIG review passes.

---

## SCOPE — what this contract does

The registry is the **on-chain source of truth for tariff schedules** that
WI-14's settlement circuits will resolve splits against. Nothing more.
It does not mint. It does not hold custody. It does not gate settlement
directly. It publishes structured, versioned, federation-vetted schedules
that settlement reads.

### Circuits (exported)

Names are indicative; final signatures land in `V1-DESIGN.md` after the
supervising session's red-team pass.

1. **`registerSchedule(schedule, validatorVerdict, federationApproval)`**
   Branch operation. Registers a new schedule for a chartered node
   (nation or operator). Requires:
   - `schedule.nationRef` / `schedule.operatorId` MUST be a chartered
     governance-tree node id (D-4). The circuit verifies this against the
     charter registry — **no schedule for an ungoverned entity.**
   - `validatorVerdict` — commitment to the off-chain WI-16 validator's
     every-path × every-floor × sanity-band × statutory-applicability
     verdict, signed by the federation seat's attestor per WI-21.
   - `federationApproval` — a fresh `approveFederated` witness from the
     appropriate tier's council (child council attests via WI-21's
     no-sign-without-quorum path).
   - Emits `ScheduleRegistered{nodeId, scheduleHash, epoch}`.

2. **`registerLane(scheduleId, laneSpec, federationApproval)`**
   Branch operation. Adds a new lane class (e.g. a new statutory lane
   activation, new operator line-of-business) under an already-registered
   schedule. Same charter + verdict + federated-approval requirements.

3. **`retuneClass(scheduleId, classPath, newSplitBps, operatorSignature)`**
   Leaf operation. Permissionless-within-bounds retune of the split
   basis-points for one leaf class under an existing schedule. NOT
   federation-gated — this is the "companies get the leaves" clause of
   the constitutional preamble. Circuit MUST re-check every cascaded floor
   (`LD_FLOOR_BPS`, `OPS_FLOOR_BPS`, statutory-lane floors) and the sanity
   band from WI-06; a retune that would violate any floor MUST fail. The
   operator's signature is on `(scheduleId, classPath, newSplitBps, epoch,
   nonce)`; nonce is registry-tracked per operator.

4. **`retireSchedule(scheduleId, federationApproval)`**
   Marks a schedule inactive at an epoch boundary. Existing settlement
   references at older epochs remain valid; new settlement references
   MUST use a live schedule. Federation-gated.

5. **`resolvePath(scheduleId, path, epoch) → (splits[], laneKinds[])`**
   Read-only view used by WI-14's settlement circuit. Given a schedule id,
   a tariff path (customer class, tier, time-of-use bucket per WI-06),
   and an epoch, returns the resolved split basis points and lane kinds.
   Sums to exactly 10000 bps (I-3 invariant from WI-07).

### Ledger fields (indicative)

- `registeredSchedules: Map<Bytes<32>, ScheduleRecord>` — key is
  `hash(nodeId, epoch)`.
- `activeScheduleByNode: Map<Bytes<32>, Bytes<32>>` — chartered node →
  current active schedule id.
- `retuneNonceByOperator: Map<Bytes<32>, Uint<64>>` — replay-guard for
  `retuneClass`.
- `EPOCH: sealed Uint<64>` — constructor-initialised, monotone-increasing.

All ledger writes touching sealed fields need `constructor()`;
witness-derived ledger writes need `disclose()`.

---

## INVARIANTS THAT MUST HOLD (checkable statements)

**I-A (D-4 same-tree invariant, ENFORCED, NOT MERELY CHECKED):**
`registerSchedule` MUST fail if `schedule.nationRef` or `schedule.operatorId`
is not present in the governance-tree charter registry. Post-condition of
every successful `registerSchedule`: `charterExists(nodeId) == true`.

**I-B (WI-06 floors, per-retune):** every successful `retuneClass` leaves
every path × every cascaded floor still satisfied. A retune that would
force any cascaded floor below its minimum MUST fail. This is checked
in-circuit against the current registered schedule's floor set, not
witness-supplied.

**I-C (WI-07 sum-to-10000):** every `resolvePath` return value satisfies
`sum(splits) == 10000` exactly. `laneKinds.length == splits.length`.

**I-D (WI-21 fail-closed):** `federationApproval` MUST verify against the
appropriate seat's `_attestors` key AND MUST be for a fresh action hash
(replay guard). Any ambiguity → reject.

**I-E (epoch monotonicity):** `epoch` is monotone non-decreasing.
`retireSchedule` at epoch `e` does not invalidate `resolvePath` calls that
name epoch `e' <= e`.

**I-F (no fund movement):** the registry has zero ability to move fiat,
mint EBT, or touch escrow. It publishes structure only. Any circuit that
appears to take value in or out is a bug.

**I-G (Compact discipline, standing invariants):** no contract-to-contract
calls (WI-14 consumes via view + event). No integer `/` or `%` in-circuit
(witness-computed divmod + `checkedDivide` verify). No `<`/`<=` on `Field`
(checked-cast pattern). All sealed fields set in `constructor()`. Every
witness → ledger path uses `disclose()`.

---

## ACCEPTANCE CRITERIA (what BIG review will check)

1. Clean full-ZK compile on compactc 0.31.0, zero warnings, transcript in
   PR body.
2. All REQUIRED TESTS below pass in the offline suite.
3. Adversarial pre-read documented in the PR body: "what is the worst
   compliant implementation of this brief?" — answered honestly.
4. Second-independent BIG pass (no shared context) reviews I-A and I-D
   specifically. Registry gating is the entire security surface.
5. Same-tree invariant checked against a fresh reading of
   `multisig/FEDERATION-CHARTER-PROTOCOL.md` — not against summaries.
6. `V1-DESIGN.md` includes a "non-goals" section that names, at minimum:
   fund movement, KYC gating, LD accounting, settlement.

---

## REQUIRED TESTS (offline smoke suite)

Every test lives in `tariff-registry/tests/`, TypeScript, deterministic,
no network.

1. **T1 — happy path:** charter node → register schedule → resolve a path
   → sum-to-10000 → retune one class within bounds → resolve → still
   sum-to-10000, changed correctly.
2. **T2 — I-A negative:** `registerSchedule` with an unchartered node id
   MUST fail. This is the D-4 test; if it doesn't fail, the whole invariant
   is broken.
3. **T3 — I-B negative:** `retuneClass` that would drop
   `LD_FLOOR_BPS` below its floor MUST fail. Repeat for `OPS_FLOOR_BPS`
   and a statutory-lane floor.
4. **T4 — I-D replay:** submit the same `federationApproval` twice; second
   attempt MUST fail.
5. **T5 — I-D forgery:** submit `federationApproval` signed by a key that
   is not the seat's registered attestor; MUST fail. Zero ambiguity path.
6. **T6 — epoch retirement:** retire schedule at epoch e, `resolvePath` at
   epoch e-1 still works, at epoch e+1 fails.
7. **T7 — property test:** random valid schedules × random paths, 1000
   iterations, `sum(splits) == 10000` holds every time.

---

## DO NOT (hard constraints)

- **DO NOT deploy.** This item ends at DEV DRAFT + review-ready PR.
- **DO NOT modify any file under `ebt/`, `living-dividend/`, or
  `multisig/`.** WI-14 modifies EBT; this is a separate contract.
- **DO NOT mint EBT, hold fiat, or read escrow state.** I-F.
- **DO NOT resolve any CAL-n value.** In particular: `LD_FLOOR_BPS`,
  `OPS_FLOOR_BPS` (CAL-1), sanity-band width (CAL-2). Use named
  placeholders and mark `TODO(calibration)`.
- **DO NOT use `--skip-zk`.** Full-ZK or nothing (§0.2, §5.1).
- **DO NOT introduce `_members` / membershipRoot / any governance ledger
  field.** Wrong contract.
- **DO NOT allow `retuneClass` to be federation-gated.** Companies get the
  leaves; this is the constitutional preamble. Any temptation to add a
  federation check to leaf ops is a spec violation.
- **DO NOT collapse this contract into EBT vNext.** The separation of
  concerns is deliberate: registry publishes structure, EBT resolves
  against it.

---

## CALIBRATION PLACEHOLDERS (Garrett's call, do NOT resolve)

Executing session MUST mark and continue with placeholders:

| CAL | Where used |
|-----|-----------|
| CAL-1 | `LD_FLOOR_BPS`, `OPS_FLOOR_BPS` — used in I-B floor checks. Named constants; values TODO. |
| CAL-2 | Sanity-band width + indexation rule — used in retune validation. TODO. |
| CAL-8 | Statute-to-lane ceremony parameters — reference only; consumed by WI-07 upstream, not enforced in registry. |
| CAL-11 | Remittance default — affects lane kinds resolvePath returns but not registry mechanics. |

---

## ESCALATION TRIGGERS (stop and comment on the draft PR)

Per plan §5.3:
1. Any READ-FIRST file contradicts this brief.
2. Any invariant I-A..I-G cannot be satisfied as written.
3. Registry needs to touch a file not named in DELIVERABLE.
4. A CAL-n value must be picked.
5. A test can only pass by weakening it.
6. The item wants to touch settlement, floors, identity keys, or custody.

Escalation is a feature, not a failure. The failure mode this guards
against is a helpful implementation that quietly violates I-A or I-F.

---

## Supervising-session pre-dispatch checklist

- [ ] Red-team pass done: "worst compliant implementation of this brief?"
  answered in the dispatch memo before handing off.
- [ ] Confirm WI-06, WI-07, WI-20 heads on `main` are the ones this brief
  was written against (record commit hashes).
- [ ] Confirm compactc version 0.31.0 is the executing environment.
- [ ] Second independent BIG pass scheduled *before* the executing session
  starts, not after.

---

*Dispatch brief authored 2026-07-14, per FEDERATION-IMPLEMENTATION-PLAN.md
§4 skeleton. This document is spec/policy only; zero contract code lives
here.*
