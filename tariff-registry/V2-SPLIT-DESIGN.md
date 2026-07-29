# TariffRegistry V2 – contract-split design (WI-15 candidate)

Status: **IMPLEMENTED** — 5-sibling split deployed live on Midnight Preview on 2026-07-29 (`PollPower/contracts@main` PR #66 merged as `0627b55`). Preview addresses in the merge commit. Lane sibling shipped via aggressive shrink (registerLane-only) per `tariff-registry/V1.1-DEFERRED.md`; V1.1 will restore fenced circuits (retireLane, retuneClass, resolveLane*, mirror-writes, mirror ledger decls) once refTime headroom is available. This design doc remains authoritative for the split shape; refer to V1.1-DEFERRED.md for the deviation record and un-fence recipe.
Kind: Split of monolithic `tariff-registry-v1.compact` into siblings.
Authoring session: Solar Scout sub-agent (Joi persona)
Date: 2026-07-27
Target compiler: Compact 0.30.0
Parents: `V1-DESIGN.md`, `V1.1-DESIGN.md`, `V1.3-DESIGN.md`
Branch target (proposed): `feat/wi15-v2-split`

---

## TL;DR (30-second read)

- **The monolith deploy is 2,300,389 bytes, 2.93× over the Preview 786,432-byte normal cap.** Parent session confirmed this live on 2026-07-27; the tx dies at `submitAndWatchExtrinsic` with `1010: Invalid Transaction: Transaction would exhaust the block limits`. Not a weight problem — a byte-budget problem.
- **Root cause of the ~200 KiB-per-mutator bloat is the 24-iteration Merkle append loop inlined into every mutator via `emitAction()` → `appendActionLogLeaf()`** (`tariff-registry-v1.compact:606-635`). Compact 0.30 inlines this into 9 different zkirs, paying for it 9 times.
- **Recommendation: 5-contract split, with the append loop hoisted into a dedicated `AuditLog` sibling.** Mutators write action-log entries into a *local outbox map* and let a mirror-writer daemon (WI-14 keeper pattern) call `AuditLog.commitAuditEntry` to fold each leaf into the committed root.
- **Every projected sibling fits under 768 KiB with ≥120 KiB headroom.** Largest is `AuditLog` at ~462 KiB; smallest is `Views` at ~233 KiB. Governance, Schedule, and Lane all land 320–540 KiB.
- **Every WI-13 / WI-13.1 / WI-13.3 invariant is preserved.** The split introduces one new invariant class (I-15-A: audit-mirror soundness). The C2C migration collapses the mirror-writer daemon into direct cross-contract calls with no invariant deltas; circuit signatures survive unchanged.

---

## 1) Motivation

### 1.1 The failing tx

On 2026-07-27 parent session (Joi/main) attempted preview deploy of `tariff-registry-v1.compact` and observed, from `kenya:~/contracts/tariff-registry/deploy-2026-07-27.attempt3.log`, verbatim:

> `2026-07-27 12:45:58        RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Transaction would exhaust the block limits`

This is the FIRST `submitAndWatchExtrinsic` call from the deploy path (`deployContract()` in the wallet SDK). Nothing landed on chain. The deploy path terminates before block inclusion.

### 1.2 Why this is a byte-cap problem, not a weight problem

Parent session queried Preview live and measured `system.blockLength`:

- `max.normal`      = **786,432 bytes** (768 KiB)
- `max.operational` = 1,048,576 bytes (1 MiB)

Measured monolith deploy payload from `kenya:~/contracts/tariff-registry/build/`:

| Component | Bytes |
|-----------|-------|
| 18 verifier keys | 35,838 |
| 18 zkir          | 2,111,428 |
| 18 bzkir         | 153,123 |
| **Total** | **2,300,389** |

That is **2.93× the normal cap** and **2.19× the operational cap**. Even if we could get the deploy classified as `operational` (we can't; contract-deploy extrinsics are `normal`), the payload is still 2.2× over. This is not a runtime-weight problem — it's the raw serialized deploy tx exceeding `max.normal` before dispatch weight is even considered. The `1010` error class in Substrate is emitted by `pre_dispatch` byte-length checks; it does not require executing the tx.

Attempt-3 log shows the tx never entered a block. There is no successful partial state on chain from this deploy.

### 1.3 Why the split is necessary

WI-14 mirror-daemon rollout, WI-15 settle circuit, WI-16 validator tooling, and WI-17 tariff renderer all depend on a Preview-live TariffRegistry. There is no published Midnight roadmap in this branch context that lifts `max.normal` above 768 KiB. Waiting on chain-side changes is not a route.

Attempts to shrink the monolith below 768 KiB have to remove ~66% of the deploy payload. No single-contract optimisation in Compact 0.30 is credibly that large (see §10 rejected alternatives). The only remaining lever is horizontal split.

---

## 2) Design principles

### 2.1 Preserve every WI-13.x invariant

The V2 split is a **structural refactor**, not a semantic one. Every invariant enforced by `tariff-registry-v1.compact` MUST hold post-split with equal strength. Full enumeration in §8; the operative rule is: **no invariant weakens, no cell loses a writer or a reader**.

### 2.2 Split along storage boundaries, not execution boundaries

Circuits move with the cells they write. A cell is written by exactly one contract post-split. A cell may be read by multiple contracts, but every non-owning reader reads a **witness-verified mirror**, never the source-of-truth cell.

This rule is what keeps mirror-writer soundness tractable. The alternative — splitting by "logical feature" — creates cells written from multiple contracts, which under Compact 0.30's no-C2C constraint is unimplementable without weakening at least one invariant.

### 2.3 Every sibling fits under 768 KiB with ≥100 KiB headroom

Sizing math per contract:

```
size ≈ Σ(circuit_zkir) + Σ(verifier_keys) + Σ(bzkir) + fixed_overhead
verifier_key_per_circuit  ≈ 2 KB
bzkir_per_circuit         ≈ 8 KB
fixed_overhead            ≈ 30 KB (contract-info.json + module glue)
```

Every sibling must have projected `size ≤ 662 KiB` (leaves 106 KiB for growth).

### 2.4 Cross-contract state consistency via witness-verified Merkle mirrors + mirror-writer daemon

Compact 0.30 has no cross-contract call primitive. Cross-contract state consistency is enforced by:

1. **Source-of-truth cell** lives in one contract (the "owner").
2. **Mirror cell** lives in each dependent contract.
3. **Mirror-write circuit** takes a witness-supplied proof (Merkle path or signature-chain) that the mirror value matches the source-of-truth value at some finalized state.
4. **Mirror-writer daemon** (WI-14 keeper) observes source finalization, constructs the proof, calls the mirror-write circuit on each dependent contract.

This is the same shape the WI-14 EBT keeper uses for `_governanceRoot` propagation. The V2 split extends this pattern to more cells (§4).

### 2.5 Circuit signatures survive C2C transition unchanged

When Compact adds cross-contract calls, mirror-write circuits collapse into direct calls, and the mirror-writer daemon retires. The *externally observable* circuit signature (`registerLane(scheduleId, laneKindByte, ...)`) does not change. Only *who calls it and how it reads sibling state* changes.

This gives WI-15 forward-compatibility: apps built against the V2 interface continue to work after C2C ships. See §6.

### 2.6 Compact 0.30 ambient constraints (must hold in every new file)

- No `/` or `%` in-circuit. Cross-multiplication with ±1 base-unit tolerance windows is the floor pattern. Any new comparator in a sibling contract uses this pattern.
- `sealed` fields written only in the constructor of their owning contract.
- Every witness-supplied value used against ledger state is wrapped in `disclose()`.
- Every inequality is a checked cast.

These are the same rules `V1-DESIGN.md §2` (`Compact 0.30.0 constraints that shape the design`) enforces on the monolith; they carry over unchanged.

---

## 3) Proposed contract map

Five siblings, deployed in the order shown.

### 3.1 Contract inventory

| # | Contract file | Role |
|---|---------------|------|
| 1 | `tariff-audit.compact` | Owns the 24-level action-log Merkle tree. Only writer of `registryActionLogRoot`, `_actionLogFrontier`, `_actionLogZeros`, `_actionLogClimb`, `_actionLogBaseSeq`, `_actionLogBootstrapCursor`, `_bootstrapComplete`. Exports `commitAuditEntry` and `bootstrapActionLog`. |
| 2 | `tariff-governance.compact` | Owns federation authority, national context (floors/band), current epoch, governance root, replay set. Exports `advanceEpoch`, `setNationalContext`, `setFederationAuthority`. |
| 3 | `tariff-schedule.compact` | Owns schedule registry and class entries. Exports `registerSchedule`, `retireSchedule`, view circuits over schedules. |
| 4 | `tariff-lane.compact` | Owns lane registry, retune bookkeeping, active-schedule-by-node index. Exports `registerLane`, `retireLane`, `retuneClass`, lane view circuits. |
| 5 | `tariff-views.compact` | Pure read-only views that touch multiple mirrors (`resolvePath`, `resolveCurrent`, `resolveLanes`, `isChartered`). No mutators, no ledger writes. |

Rationale for the 5-way split (rather than parent's provisional 4-way):
- Parent's 4-way keeps `bootstrapActionLog` (~178 KiB zkir) in Governance, keeping Governance at ~886 KiB (over cap).
- Hoisting the audit machinery into its own sibling drops Governance to ~324 KiB (well under cap, huge headroom) AND drops every other mutator by ~180 KiB each (no more inlined 24-iter Merkle loop).
- The extra contract-info.json + fixed overhead (~30 KiB) is trivial next to the ~180 KiB × 8 mutators saved.

### 3.2 Size projection per contract

Per-circuit zkir sizes are the measured values from parent's ground-truth table. "New" circuits (mirror-writes and outbox-emit stubs) are estimated conservatively at 40–80 KiB (empty-loop, minimal-witness circuits are much lighter than the ~200 KiB mutators, which are dominated by the append loop).

**Contract 1: `tariff-audit.compact`**

| Circuit | zkir (bytes) | Notes |
|---------|--------------|-------|
| `bootstrapActionLog`      | 178,027 | Sharded WI-13.3 bootstrap. Owns the loop. |
| `commitAuditEntry`        | ~205,000 | NEW. Wraps `appendActionLogLeaf` (`tariff-registry-v1.compact:606-635`) + mirror-writer authority check. |
| `getActionEntry`          | 5,859   | View. |
| `getActionPayloadHash`    | 5,544   | View. |
| **zkir subtotal** | **~394,430** | |
| verifier keys (4 × 2 KB)  | 8,000 | |
| bzkir (4 × 8 KB)          | 32,000 | |
| fixed overhead            | 30,000 | |
| **Projected total** | **~464,430** | **~453 KiB**; **~315 KiB headroom under 768 KiB cap** |

Notes:
- `_actionLog` (the RegistryActionEntry map keyed by seq) does NOT move here. It stays in each mutator-owning sibling as a per-domain outbox. AuditLog only owns the Merkle-committed root and the tree machinery. See §4.4.
- `commitAuditEntry` is estimated at ~205 KB because it inlines the same 24-iter loop `appendActionLogLeaf` has today, plus an authority-check preamble (~5 KB). The parent-measured `bootstrapActionLog` at 178 KB is a good calibration point — it inlines the same loop, and `commitAuditEntry` adds one authority-hash check.

**Contract 2: `tariff-governance.compact`**

| Circuit | zkir (bytes) | Notes |
|---------|--------------|-------|
| `advanceEpoch`            | ~50,000 | REDUCED. Removes inlined `appendActionLogLeaf`; writes outbox. |
| `setNationalContext`      | ~40,000 | REDUCED. |
| `setFederationAuthority`  | ~40,000 | REDUCED. |
| `isChartered` (mirror-read view) | 13,898 | Reads mirrored `_governanceRoot`. |
| `mirrorAuditRoot` (mirror-write for AuditLog root, for anti-fork sanity) | ~30,000 | NEW, optional. |
| **zkir subtotal** | **~173,900** | |
| verifier keys (5 × 2 KB)  | 10,000 | |
| bzkir (5 × 8 KB)          | 40,000 | |
| fixed overhead            | 30,000 | |
| **Projected total** | **~253,900** | **~248 KiB**; **~520 KiB headroom** |

Governance is by far the smallest mutator sibling because none of its three mutators do heavy per-op arithmetic; they were only bloated in the monolith by the append loop.

**Contract 3: `tariff-schedule.compact`**

| Circuit | zkir (bytes) | Notes |
|---------|--------------|-------|
| `registerSchedule`        | ~65,000 | REDUCED. Retains schedule-validation logic; drops append loop. |
| `retireSchedule`          | ~50,000 | REDUCED. |
| `isScheduleActive`        | 8,862   | View. |
| `mirrorGovernanceRoot` (mirror-write) | ~30,000 | NEW. |
| `mirrorEpochAndFloors` (mirror-write) | ~35,000 | NEW. Copies `_currentEpoch`, `_LD_FLOOR_BPS`, `_OPS_FLOOR_BPS`, `_SANITY_BAND_PCT` snapshots into schedule-local mirrors. |
| **zkir subtotal** | **~188,862** | |
| verifier keys (5 × 2 KB)  | 10,000 | |
| bzkir (5 × 8 KB)          | 40,000 | |
| fixed overhead            | 30,000 | |
| **Projected total** | **~268,862** | **~263 KiB**; **~505 KiB headroom** |

**Contract 4: `tariff-lane.compact`**

| Circuit | zkir (bytes) | Notes |
|---------|--------------|-------|
| `registerLane`            | ~65,000 | REDUCED. Retains I-13.1-A..K lane checks; drops append loop. |
| `retireLane`              | ~45,000 | REDUCED. |
| `retuneClass`             | ~85,000 | REDUCED. Retains I-B/I-C cross-multiplication floor/sum checks; drops append loop. Retune has slightly heavier per-op arithmetic than lane/schedule, hence the higher post-hoist estimate. |
| `isLaneActive`            | 16,602  | View. |
| `resolveLane`             | 7,673   | View. |
| `mirrorScheduleRoot` (mirror-write of `_registeredSchedules` root) | ~35,000 | NEW. Lane needs schedule liveness for I-13.1-C / I-13.1-K. |
| `mirrorGovernanceRoot` (mirror-write) | ~30,000 | NEW. Lane needs charter proofs (I-13.1-B). |
| `mirrorEpochAndFloors` (mirror-write) | ~35,000 | NEW. Lane's `retuneClass` needs `_LD_FLOOR_BPS` etc for I-B. |
| **zkir subtotal** | **~319,275** | |
| verifier keys (8 × 2 KB)  | 16,000 | |
| bzkir (8 × 8 KB)          | 64,000 | |
| fixed overhead            | 30,000 | |
| **Projected total** | **~429,275** | **~419 KiB**; **~349 KiB headroom** |

**Contract 5: `tariff-views.compact`**

| Circuit | zkir (bytes) | Notes |
|---------|--------------|-------|
| `resolvePath`             | 11,314  | View. Reads mirror of `_registeredSchedules`, `_classEntries`. |
| `resolveCurrent`          | 11,995  | View. |
| `resolveLanes`            | 36,333  | View. Bounded batch (`Vector<4, LaneRecord>` per I-13.1-H). |
| `mirrorScheduleRoot`      | ~35,000 | NEW. |
| `mirrorLaneRoot`          | ~35,000 | NEW. |
| `mirrorClassEntriesRoot`  | ~30,000 | NEW. |
| **zkir subtotal** | **~159,642** | |
| verifier keys (6 × 2 KB)  | 12,000 | |
| bzkir (6 × 8 KB)          | 48,000 | |
| fixed overhead            | 30,000 | |
| **Projected total** | **~249,642** | **~244 KiB**; **~524 KiB headroom** |

### 3.3 Aggregate size table

| Contract | Projected KiB | Under 768? | Headroom |
|----------|--------------:|:----------:|---------:|
| AuditLog     | ~453 | ✅ | ~315 |
| Governance   | ~248 | ✅ | ~520 |
| Schedule     | ~263 | ✅ | ~505 |
| Lane         | ~419 | ✅ | ~349 |
| Views        | ~244 | ✅ | ~524 |
| **Sum** | **~1,627** | | |

Total aggregate deploy payload ~1.59 MiB across 5 separate txs, each within `max.normal`. Compare monolith: 2.19 MiB in a single tx. Rough overhead cost of the split: ~150 KiB across 5 fixed_overhead payloads and the new mirror-write circuits — a modest tax for a 3× deployability gain.

### 3.4 Ledger cell ownership matrix

All 28 cells assigned exactly one owner contract. `R` = reads (via mirror unless same-contract).

| Cell | Owner | Governance | Schedule | Lane | Views | Notes |
|------|-------|:----------:|:--------:|:----:|:-----:|-------|
| `_initialized` | Governance | W | R | R | R | Sealed constructor marker per WI-13.3 §3.5. Every dependent asserts governance initialization before mirror-writes. |
| `_bootstrapComplete` | AuditLog | R | R | R | R | Set true at terminal `bootstrapActionLog` shard. WI-14 mirror-daemon gate. |
| `_federationAuthority` | Governance | W | R (mirror) | R (mirror) | — | Rotated only via `setFederationAuthority` (I-D domain). |
| `_LD_FLOOR_BPS` | Governance | W | R (mirror) | R (mirror) | R (mirror) | I-B enforcement in `retuneClass` (Lane) reads mirror. |
| `_OPS_FLOOR_BPS` | Governance | W | R (mirror) | R (mirror) | R (mirror) | I-B. |
| `_SANITY_BAND_PCT` | Governance | W | R (mirror) | R (mirror) | R (mirror) | T3.5 sanity band. |
| `_pendingLDFloorBps` | Governance | W | — | — | — | Shadow slot. `advanceEpoch` swaps into `_LD_FLOOR_BPS`. Purely internal to Governance. |
| `_pendingOpsFloorBps` | Governance | W | — | — | — | Ditto. |
| `_pendingSanityBandPct` | Governance | W | — | — | — | Ditto. |
| `_hasPendingContext` | Governance | W | — | — | — | Ditto. |
| `_currentEpoch` | Governance | W (Counter) | R (mirror) | R (mirror) | R (mirror) | I-E: `advanceEpoch` is the only writer, +1 only. |
| `_refRateFiatPerKwh` | Governance | W | — | R (mirror) | — | Read by `retuneClass` for sanity-band centering. |
| `_governanceRoot` | Governance | W | R (mirror) | R (mirror) | R (mirror) | R-A charter Merkle root. Rotated via `advanceEpoch` (`tariff-registry-v1.compact:901-966`). |
| `_registeredSchedules` | Schedule | — | W | R (mirror of root) | R (mirror of root) | Schedule map. Lane/Views hold the Merkle root only. |
| `_activeScheduleByNode` | Lane | — | R (mirror) | W | R (mirror) | Kept in Lane because `registerLane`+`retireLane` need liveness lookups on the current active schedule per node. |
| `_classEntries` | Schedule | — | W | R (mirror of root) | R (mirror of root) | Class-level split shares. |
| `_registeredLanes` | Lane | — | — | W | R (mirror of root) | I-13.1-E uniqueness. |
| `_retuneNonces` | Lane | — | — | W | — | R-B replay guard, per (operator, schedule, epoch). |
| `_retuneLastTime` | Lane | — | — | W | — | R-B cooldown. |
| `_consumedFederationApprovals` | Governance | W | R (mirror) | R (mirror) | — | I-D replay set. Consumed inside every federation-gated mutator. **See §4.5** — this is the trickiest mirror. |
| `_actionLog` (RegistryActionEntry map) | Sharded per mutator | Gov local | Sched local | Lane local | R (mirror of AuditLog root) | Each mutator sibling keeps its OWN local `_actionLog` outbox. See §4.4. |
| `_actionSeq` | Sharded per mutator | Gov local | Sched local | Lane local | — | Sequence counter local to each mutator sibling. Global monotonicity guaranteed by AuditLog seq. |
| `registryActionLogRoot` | AuditLog | R (mirror) | R (mirror) | R (mirror) | R (mirror) | Committed root over all folded leaves. |
| `_actionLogFrontier` | AuditLog | — | — | — | — | AuditLog-internal. |
| `_actionLogZeros` | AuditLog | — | — | — | — | AuditLog-internal. |
| `_actionLogBaseSeq` | AuditLog | — | — | — | — | AuditLog-internal. |
| `_actionLogClimb` | AuditLog | — | — | — | — | Transient climb accumulator (`tariff-registry-v1.compact:333-338`). AuditLog-internal. |
| `_actionLogBootstrapCursor` | AuditLog | — | — | — | — | WI-13.3 shard cursor. AuditLog-internal. |

Every cell has exactly one writer contract. Reads that cross contract boundaries go through mirrors.

---

## 4) Cross-contract state model (pre-C2C)

There are seven cross-cutting values that need mirroring:

1. `_governanceRoot` — root of charter tree (Governance → Schedule, Lane, Views).
2. `_currentEpoch` + `_LD_FLOOR_BPS` + `_OPS_FLOOR_BPS` + `_SANITY_BAND_PCT` + `_refRateFiatPerKwh` bundle (Governance → Schedule, Lane, Views).
3. `_federationAuthority` (Governance → Schedule, Lane).
4. `_registeredSchedules` root (Schedule → Lane, Views).
5. `_classEntries` root (Schedule → Views).
6. `_registeredLanes` root (Lane → Views).
7. `registryActionLogRoot` (AuditLog → all).
8. `_consumedFederationApprovals` set root (Governance → Schedule, Lane). See §4.5.

### 4.1 `_governanceRoot` mirror

**Source of truth:** Governance's `_governanceRoot: Bytes<32>`. Written only inside `advanceEpoch` (`tariff-registry-v1.compact:901-966`).

**Mirror cells:** Schedule, Lane, Views each hold `_mirroredGovernanceRoot: Bytes<32>`.

**Mirror-write circuit signature (proposed):**

```
export circuit mirrorGovernanceRoot(
  newRoot: Bytes<32>,
  epochAtMirror: Uint<64>,
  govAuthoritySig: Bytes<64>,          // witness-supplied
  govAuthorityHash: Bytes<32>,         // must match Gov's current _federationAuthority
): [];
```

Body pattern:
1. `assert(signature_valid(govAuthorityHash, newRoot || epochAtMirror, govAuthoritySig))` — same witness function as `tariff-registry-v1.compact:116-124`.
2. `assert(epochAtMirror > _mirroredEpoch, "MIRROR_EPOCH_STALE")` — monotone.
3. Write `_mirroredGovernanceRoot = disclose(newRoot)`, `_mirroredEpoch = disclose(epochAtMirror)`.
4. Emit `MIRROR_GOV_ROOT` action to local outbox with `payloadHash = persistentHash([tag, newRoot, epochAtMirror])`.

**Mirror-writer daemon:** WI-14 keeper. Watches Governance's `_actionLog` for `EPOCH_ADVANCED` (kind 4 in existing enum). On each new epoch, reads Governance's current `_governanceRoot` and `_currentEpoch`, obtains the federation-authority signature (or a governance-authority signature if that's the design choice; see §9 Q1), calls `mirrorGovernanceRoot` on Schedule, Lane, Views.

**Sync action-log entry:** each mirror-write emits `MIRROR_GOV_ROOT` (new action kind, proposed value 16) to that contract's local outbox, folded into the local seq → AuditLog root chain.

### 4.2 Epoch + floors bundle mirror

**Source of truth:** Governance owns `_currentEpoch`, `_LD_FLOOR_BPS`, `_OPS_FLOOR_BPS`, `_SANITY_BAND_PCT`, `_refRateFiatPerKwh` (`tariff-registry-v1.compact:249-269`).

**Mirror cells:** Schedule, Lane, Views hold identical-named `_mirrored*` variants.

**Mirror-write circuit:** `mirrorEpochAndFloors(newEpoch, newLDFloor, newOpsFloor, newSanity, newRefRate, sig, authHash)`. Same signature pattern as §4.1.

**Ordering invariant:** Mirror-writer daemon MUST NOT advance a dependent's mirror epoch past Governance's actual `_currentEpoch`. Every `advanceEpoch` action on Governance triggers exactly one mirror-write per dependent, in order.

**Why bundle these five values:** they change atomically inside `advanceEpoch`. Splitting the mirror-write into five circuits would create a window where the dependent's mirrored epoch has advanced but its mirrored floors haven't. WI-14's retune circuit reads all five together for I-B (floor) and I-C (sum) checks; the atomicity matters.

### 4.3 `_federationAuthority` mirror

**Source of truth:** Governance's `_federationAuthority: Bytes<32>`. Written in `setFederationAuthority` (`tariff-registry-v1.compact:1021-1063`).

**Mirror cells:** Schedule, Lane hold `_mirroredFederationAuthority: Bytes<32>`.

**Mirror-write circuit:** `mirrorFederationAuthority(newAuth, epochAtMirror, sig, currentAuthHash)`. Signature preamble uses the CURRENT (pre-rotation) authority to sign the mirror-write, closing the F-13 "the new authority signs its own installation" replay hole that the monolith avoids by having `setFederationAuthority` gated by the current authority.

**Notably**, `_federationAuthority` is used by *every* federation-gated mutator (register/retire schedule, register/retire lane, advanceEpoch, setNationalContext, setFederationAuthority itself) to consume approvals via `consumeFederationApproval(actionHash, opLabel)` (`tariff-registry-v1.compact:665-706`). Dependents that hold a mirror can call the same helper against their local mirror; correctness requires the mirror is not more stale than one rotation window.

### 4.4 Action-log entries — local outbox, committed root

This is the single most consequential piece of the split.

**Design:** Each mutator sibling (Governance, Schedule, Lane) keeps its own local `_actionLog: Map<Uint<64>, RegistryActionEntry>` and `_actionSeq: Counter`. The `emitAction` helper in each sibling writes ONLY to that sibling's local outbox — it does NOT call `appendActionLogLeaf`.

The 24-iter Merkle append loop (`tariff-registry-v1.compact:606-635`) lives exclusively in AuditLog's `commitAuditEntry` circuit. `commitAuditEntry` takes:

```
export circuit commitAuditEntry(
  sourceContractTag: Bytes<32>,     // "gov" | "sched" | "lane"
  localSeq: Uint<64>,               // the seq inside the source sibling
  payloadHash: Bytes<32>,           // the entry's payloadHash
  globalSeq: Uint<64>,              // AuditLog's own monotone counter
  writerSig: Bytes<64>,             // witness: mirror-writer daemon signature
): [];
```

Body:
1. Assert `writerSig` is a valid signature under a known audit-writer authority hash (a Governance-controlled cell mirrored into AuditLog as `_mirroredAuditWriterAuthority`).
2. Assert `globalSeq == _actionSeq.read()` (strict monotone; Counter enforces the +1).
3. Perform the 24-level Merkle fold (identical body to `appendActionLogLeaf` at `tariff-registry-v1.compact:606-635`).
4. Advance `_actionSeq`.

**Global vs local seq mapping:** each entry has a `(sourceContractTag, localSeq)` identity and a `globalSeq` ordering assigned by AuditLog on commit. WI-14 mirror-daemon commits in a fixed order (Governance → Schedule → Lane) within each source-block window to keep global ordering deterministic. Consumers query AuditLog for the root and for individual entries via `getActionEntry(globalSeq)` (renamed from monolith; still `getActionEntry` in AuditLog's exports for signature compatibility).

**Why not store `RegistryActionEntry` in AuditLog too?** Because that doubles the storage cost and requires the mirror-writer daemon to serialize the entire entry through witness data on every commit, blowing up witness sizes. Storing entries locally in the sibling that produced them is cheap; the Merkle root over `payloadHash` is what settlement consumers actually need.

**Sync action-log entry for the mirror itself:** none needed. `commitAuditEntry` IS the sync. Its execution is recorded in AuditLog's own `_actionSeq`.

### 4.5 `_consumedFederationApprovals` mirror

This is the mirror that's hardest to make crisp, and it's why the split does NOT collapse Governance/Schedule/Lane into fewer siblings.

**Source-of-truth choice:** Governance owns the *authoritative* set. Every federation-gated mutator in Schedule or Lane must consume the approval, which means writing to the set.

**Two candidate designs:**

**Design A: Set root mirror (recommended).** Governance holds `_consumedFederationApprovals: Set<Bytes<32>>` and a derived `_consumedFedApprovalsRoot: Bytes<32>`. Schedule and Lane hold a mirror of the root plus their own local `_localFedConsumed: Set<Bytes<32>>`. When Schedule's `registerSchedule` runs, it consumes locally into `_localFedConsumed` and emits a `FEDERATION_APPROVAL_CONSUMED` action. Mirror-writer daemon reads the sibling's local set additions and calls `commitFedConsumption(actionHash, siblingTag, sig)` on Governance to fold the addition into the authoritative set. Governance's next mirror-write pushes the updated root back to Schedule and Lane.

**Downside of A:** brief cross-sibling window where two siblings could both consume the same actionHash before the sync completes. This is the R-B / I-D replay hole.

**Mitigation:** federation approvals are per-operation and per-domain-tag. The domain-tag registry (`tariff-registry-v1.compact` line ranges 665-706 for `consumeFederationApproval`; V1-DESIGN.md §5) partitions actionHashes such that Schedule ops and Lane ops don't share tags. `registerSchedule` uses domain tag `"pp:tariff:v1:federationDomain:registerSchedule"`; `registerLane` uses `"pp:tariff:v1:federationDomain:registerLane"`. If domain tags are disjoint across owning siblings, cross-sibling replay is structurally impossible: the same actionHash from a domain owned by Schedule cannot be replayed on Lane because Lane's `consumeFederationApproval` verifies domain match. This is already how the monolith enforces I-D partitioning; we inherit it for free.

**Verified against source:** the domain-tag partition claim requires that Governance-only op labels (`advanceEpoch`, `setNationalContext`, `setFederationAuthority`), Schedule op labels (`registerSchedule`, `retireSchedule`), and Lane op labels (`registerLane`, `retireLane`, `retuneClass`) are non-overlapping strings. Confirmed at `tariff-registry-v1.compact:665-706` (`consumeFederationApproval` uses `opLabel` as a per-domain nonce namespace). No monolith op reuses a label; §5 of V1-DESIGN.md's domain-tag registry is the reference.

**Design B: local-only sets.** Each sibling keeps its own local `_localFedConsumed`, and cross-sibling replay is prevented purely by domain-tag disjointness. Governance no longer needs a global set. This is *simpler* than A but relies more heavily on the invariant that domain-tags never overlap between siblings.

**Recommendation:** **Design B**. Domain tags are structurally disjoint; the global set adds no additional safety over per-domain nonce partitioning. Governance's `_consumedFederationApprovals` retains only the Governance-domain approvals (`advanceEpoch` etc.). Schedule and Lane each get their own equivalently-named local set for their domains.

This makes `_consumedFederationApprovals` a *sharded* cell, not a mirrored cell. See §3.4 note.

**New invariant introduced:** **I-15-A (federation-domain disjointness):** No `opLabel` value used in `consumeFederationApproval` appears in more than one sibling's export surface. Enforced by inspection at each new circuit's PR review; violation is a structural bug, not a runtime one.

### 4.6 `_registeredSchedules` root mirror

**Source of truth:** Schedule's `_registeredSchedules: Map<Bytes<32>, ScheduleRecord>`.

**Derived root:** Schedule maintains `_schedulesMerkleRoot: Bytes<32>` (a Merkle tree over `(scheduleId, hash(ScheduleRecord))` pairs, updated inside `registerSchedule` and `retireSchedule`). The `Map` is not naturally Merkle-committed, so we add a bounded Merkle tree over its contents. Depth constant: `SCHEDULE_TREE_DEPTH = 20` (~1M schedules), following the same shape as `ACTION_LOG_DEPTH`.

**Mirror cells:** Lane and Views hold `_mirroredSchedulesRoot: Bytes<32>` and `_mirroredSchedulesEpoch: Uint<64>` (the local sibling epoch at which the mirror was refreshed).

**Consumer path in Lane:** `registerLane` needs `_registeredSchedules.member(scheduleId)` and `retiredEpoch == 0` (I-13.1-C). Post-split, Lane's `registerLane` accepts a witness-supplied `scheduleProof: Vector<20, Bytes<32>>` and an `expectedScheduleRecord: ScheduleRecord`, and verifies the Merkle path against `_mirroredSchedulesRoot`. This is analogous to the charter proof pattern in `tariff-registry-v1.compact:431-538`.

**Mirror-write circuit:** `mirrorSchedulesRoot(newRoot, schedulesEpoch, sig, authHash)`. Same shape as §4.1.

**Sync action-log entry:** each mirror-write emits `MIRROR_SCHEDULE_ROOT` (proposed action kind 17).

### 4.7 `_classEntries` root mirror

**Source of truth:** Schedule's `_classEntries: Map<Bytes<32>, ClassEntry>`.

**Derived root:** `_classEntriesMerkleRoot`, computed in `retuneClass` (currently Lane) — but `retuneClass` writes to `_classEntries` in the monolith, so `_classEntries` MUST live in whichever contract owns `retuneClass`.

**Design tension:** V1's `retuneClass` is a schedule-scoped mutator (it retunes a class within a schedule) but under our storage-boundary rule, class entries live wherever `retuneClass` writes them. The monolith writes `_classEntries` in `retuneClass` (`tariff-registry-v1.compact:1268-1425`). If `retuneClass` lives in Lane per parent's Option B, then `_classEntries` lives in Lane too.

**Resolution:** move `_classEntries` to Lane, keep `retuneClass` in Lane. `_classEntries` mirror to Views. Schedule contract does NOT hold `_classEntries` post-split. `registerSchedule` in the monolith seeds the class entries — post-split, `registerSchedule` in Schedule emits a `SCHEDULE_REGISTERED` action carrying the initial class-entries hash bundle, and Lane's mirror-write reads that and seeds its local `_classEntries` via a paired `seedClassEntriesForSchedule` circuit gated by a Merkle proof against `_mirroredSchedulesRoot`.

This is admittedly the most awkward corner of the split. See §9 Q3 for whether an alternative bundling (Schedule+Lane in one contract) is worth reconsidering — but the current sizing says they fit as separate siblings comfortably.

### 4.8 `_registeredLanes` root mirror

**Source of truth:** Lane's `_registeredLanes: Map<Bytes<32>, LaneRecord>`.

**Derived root:** `_lanesMerkleRoot`, depth `LANE_TREE_DEPTH = 20`.

**Mirror cells:** Views holds `_mirroredLanesRoot`.

**Consumer path in Views:** `resolveLanes` returns `Vector<4, LaneRecord>` per I-13.1-H. Post-split, `resolveLanes` accepts a witness-supplied bundle of up to 4 `laneProofs` and reconstructs each against `_mirroredLanesRoot`.

### 4.9 `registryActionLogRoot` mirror

**Source of truth:** AuditLog's `registryActionLogRoot`.

**Mirror cells:** every other contract holds `_mirroredAuditRoot`.

**Purpose:** any sibling that needs to prove "this action-log entry existed" for downstream WI-14/WI-16/WI-17 consumers can do so against its local mirror. Not strictly required for the split to function, but makes consumer proofs uniform across siblings.

### 4.10 Bootstrap sequencing

Every mirror-write circuit requires that its source contract be initialized. Bootstrap ordering therefore fans out from Governance:

```
1. Deploy AuditLog             → no dependencies
2. Deploy Governance           → mirrors AuditLog root (optional at deploy time)
3. Deploy Schedule             → mirrors Governance root + epoch
4. Deploy Lane                 → mirrors Governance + Schedule roots
5. Deploy Views                → mirrors all
6. Bootstrap AuditLog          → shard `bootstrapActionLog(8)` × 3
7. Governance:advanceEpoch     → seeds first governance root
8. Mirror-writer daemon starts → begins fan-out
```

Details in §7.

---

## 5) Circuit-by-circuit relocation

Every one of the 18 monolith circuits is placed. New circuits introduced by the split are also enumerated.

### 5.1 Original mutator circuits

| Circuit (monolith line) | Target contract | Ledger cells needed | New witness/mirror deps | Signature changes |
|-------------------------|-----------------|---------------------|-------------------------|-------------------|
| `registerSchedule` (742) | Schedule | `_registeredSchedules` (W), `_governanceRoot` (R via mirror), `_currentEpoch` (R via mirror), `_federationAuthority` (R via mirror), `_consumedFederationApprovals` (W, local shard) | Requires `charterProof` verified against mirrored `_governanceRoot`. Requires `fedApproval` verified against mirrored `_federationAuthority`. Interface unchanged. | NO. |
| `retireSchedule` (836) | Schedule | `_registeredSchedules` (W), `_currentEpoch` (R via mirror), `_federationAuthority` (R via mirror), `_consumedFederationApprovals` (W, local shard) | Same as above. | NO. |
| `advanceEpoch` (901) | Governance | `_currentEpoch` (W), `_governanceRoot` (W), `_LD_FLOOR_BPS`/`_OPS_FLOOR_BPS`/`_SANITY_BAND_PCT` (W, swap from pending), `_pendingLDFloorBps`/etc (W), `_hasPendingContext` (W), `_refRateFiatPerKwh` (W), `_federationAuthority` (R), `_consumedFederationApprovals` (W, local shard) | Governance-domain approvals only. | NO. |
| `setNationalContext` (967) | Governance | `_pendingLDFloorBps`/etc (W), `_hasPendingContext` (W), `_federationAuthority` (R), `_consumedFederationApprovals` (W, local shard) | Governance-domain. | NO. |
| `setFederationAuthority` (1021) | Governance | `_federationAuthority` (W), `_consumedFederationApprovals` (W, local shard) | Governance-domain. | NO. |
| `registerLane` (1064) | Lane | `_registeredLanes` (W), `_registeredSchedules` (R via mirrored root + Merkle proof), `_governanceRoot` (R via mirror), `_currentEpoch` (R via mirror), `_federationAuthority` (R via mirror), `_activeScheduleByNode` (R), `_consumedFederationApprovals` (W, local shard) | Adds `scheduleProof: Vector<20, Bytes<32>>` and `expectedScheduleRecord: ScheduleRecord` witness for I-13.1-C liveness check. See §5.4. | **YES** — one added witness param. See §5.4 for compatibility note. |
| `retireLane` (1190) | Lane | `_registeredLanes` (W), `_currentEpoch` (R via mirror), `_federationAuthority` (R via mirror), `_consumedFederationApprovals` (W, local shard) | Charter proof for the retiring authority. | NO in mutator body; the caller must be Lane's federation authority (same as monolith). |
| `retuneClass` (1268) | Lane | `_classEntries` (W), `_retuneNonces` (W), `_retuneLastTime` (W), `_registeredSchedules` (R via mirrored root + Merkle proof), `_LD_FLOOR_BPS`/`_OPS_FLOOR_BPS`/`_SANITY_BAND_PCT` (R via mirror), `_refRateFiatPerKwh` (R via mirror), `_currentEpoch` (R via mirror) | Adds `scheduleProof` for I-13.1-C-style parent-schedule liveness. See §5.4. | Same as `registerLane` — one added witness. |
| `bootstrapActionLog` (708) | AuditLog | `_actionLogFrontier` (W), `_actionLogZeros` (W), `_actionLogClimb` (W), `_actionLogBootstrapCursor` (W), `_actionLogBaseSeq` (W), `_bootstrapComplete` (W), `registryActionLogRoot` (W) | None. Body unchanged from `tariff-registry-v1.compact:708-741`. | NO. |

### 5.2 Original view circuits

| Circuit (monolith line) | Target contract | Ledger cells needed | Notes |
|-------------------------|-----------------|---------------------|-------|
| `resolvePath` (1426) | Views | `_registeredSchedules` (R via mirror), `_classEntries` (R via mirror) | Needs `scheduleProof` + `classProof` witnesses now. |
| `resolveCurrent` (1455) | Views | Same as `resolvePath` plus `_activeScheduleByNode` (R via mirror). | |
| `isChartered` (1463) | Views (or Governance — same signature either way) | `_governanceRoot` (R). | Placing in Views keeps Views the natural "read any state" contract. Governance also exports it locally for tests. |
| `isScheduleActive` (1519) | Schedule or Views | `_registeredSchedules` (R). | Place in Schedule for zero-overhead direct read; Views also has a mirror-based variant. |
| `getActionEntry` (1539) | AuditLog | AuditLog-internal action-log storage. | AuditLog stores committed entries indexed by globalSeq. |
| `getActionPayloadHash` (1546) | AuditLog | AuditLog-internal. | |
| `resolveLane` (1557) | Lane | `_registeredLanes` (R). | Direct read in owning contract. |
| `resolveLanes` (1572) | Lane and Views | Lane has direct-read variant; Views has mirror-based variant returning `Vector<4, LaneRecord>` per I-13.1-H. | |
| `isLaneActive` (1614) | Lane | `_registeredLanes` (R), `_registeredSchedules` (R via mirror per I-13.1-K). | |

### 5.3 New circuits introduced by the split

| Circuit | Contract | Purpose | Est. zkir |
|---------|----------|---------|-----------|
| `commitAuditEntry` | AuditLog | Fold `payloadHash` into Merkle root. Successor of monolith's inlined `appendActionLogLeaf`. | ~205 KB |
| `mirrorGovernanceRoot` | Schedule, Lane, Views | Copy Gov's `_governanceRoot` into local mirror. | ~30 KB each |
| `mirrorEpochAndFloors` | Schedule, Lane, Views | Bundle 5-value atomic mirror. | ~35 KB each |
| `mirrorFederationAuthority` | Schedule, Lane | Copy Gov's `_federationAuthority`. | ~30 KB each |
| `mirrorSchedulesRoot` | Lane, Views | Copy Schedule's Merkle root. | ~30-35 KB each |
| `mirrorLaneRoot` | Views | Copy Lane's Merkle root. | ~35 KB |
| `mirrorClassEntriesRoot` | Views | Copy Lane's class-entries Merkle root. | ~30 KB |
| `mirrorAuditRoot` | Governance, Schedule, Lane, Views | Copy AuditLog's `registryActionLogRoot`. | ~30 KB each |
| `seedClassEntriesForSchedule` | Lane | Seed `_classEntries` for a newly registered schedule based on Merkle proof against `_mirroredSchedulesRoot`. See §4.7. | ~50 KB |

All mirror-write circuits share a common body shape: verify signature, monotone-epoch check, disclose-and-write. They are compilable copies of a small template; total added zkir across all mirror-writes is under 400 KB spread across 5 contracts.

### 5.4 The witness-parameter signature change for Lane circuits

Lane's `registerLane`, `retireLane`, and `retuneClass` gain new witness parameters (Merkle proofs against mirrored roots). The **exported circuit signatures** technically change: they take additional witness inputs.

**However**, witness inputs are supplied by the prover off-chain and are not part of the public-input schema seen by verifiers. In terms of *keeper-facing API*, the schedule-liveness check that was previously "in-contract Map lookup" becomes "off-chain proof construction + in-contract Merkle verify". The keeper's TypeScript bundle-builder library adds one extra step: generate the schedule Merkle proof.

**Keeper-visible signature change:** the bundle-builder function signature grows a proof argument. This is a keeper-library update, not an on-chain interface change.

**Under C2C:** the added witness parameters disappear entirely; the contract calls `Schedule.getScheduleRecord(scheduleId)` directly. See §6.

---

## 6) Migration path when C2C lands

When Compact adds cross-contract calls (target: Compact 0.32+, no committed date), several mirror mechanisms retire.

### 6.1 What collapses

| Mirror mechanism | Post-C2C fate |
|------------------|---------------|
| `_mirroredGovernanceRoot` cell | Deleted from Schedule/Lane/Views. Direct read: `Governance.getGovernanceRoot()`. |
| `_mirroredEpoch`, `_mirroredLDFloorBps`, etc | Deleted from Schedule/Lane/Views. Direct read: `Governance.getEpoch()`, `Governance.getFloors()`. |
| `_mirroredFederationAuthority` | Deleted. Direct read: `Governance.getFederationAuthority()`. |
| `_mirroredSchedulesRoot` | Deleted from Lane/Views. `registerLane` calls `Schedule.getScheduleRecord(scheduleId)` directly instead of Merkle-verifying a witness proof. |
| `_mirroredLanesRoot`, `_mirroredClassEntriesRoot` | Deleted from Views. Direct reads. |
| `_mirroredAuditRoot` | Retained (still useful for sibling-local anti-fork checks), but no longer maintained by daemon. |

### 6.2 What collapses in circuits

| Circuit | Pre-C2C body | Post-C2C body | LOC delta |
|---------|--------------|---------------|-----------|
| `Lane.registerLane` | Merkle-verify schedule proof against `_mirroredSchedulesRoot` | Call `Schedule.getScheduleRecord(scheduleId)`, read directly | -25 LOC |
| `Lane.retuneClass` | Merkle-verify schedule proof + read mirrored floors | Direct sibling reads | -30 LOC |
| `Views.resolvePath` | Two Merkle-verifies against mirrored roots | Two direct sibling reads | -40 LOC |
| `Views.resolveLanes` | Up to 4 Merkle-verifies | 4 direct reads | -55 LOC |
| All `mirror*` circuits | ~200 total LOC | DELETED | -200 LOC |
| `seedClassEntriesForSchedule` (Lane) | Merkle-verified schedule seed | Direct Schedule → Lane call on `registerSchedule` completion, atomic | -50 LOC |
| **Total** | — | — | **~-400 LOC** |

### 6.3 What survives C2C

| Item | Survives | Reason |
|------|:--------:|--------|
| `AuditLog.commitAuditEntry` circuit | ✅ | Even with C2C, AuditLog is the natural owner of the Merkle tree; mutators calling `AuditLog.commitAuditEntry` directly is a strict improvement over the daemon path. |
| `AuditLog.bootstrapActionLog` | ✅ | Sharded bootstrap remains the WI-13.3-established pattern. |
| All monolith mutator signatures (schedule/lane/retune/epoch/context/auth) | ✅ | External keeper API unchanged. |
| All monolith view signatures (`resolvePath`, `resolveCurrent`, etc.) | ✅ | External consumer API unchanged. |
| Per-sibling `_actionLog` local outbox | ✅ or ❌ | May be retired if C2C allows synchronous `AuditLog.commitAuditEntry` inside the same tx as the mutator. If so, sibling doesn't need to store the entry locally. Marginal optimization; can keep as-is. |
| WI-14 mirror-daemon | ❌ (mostly) | The mirror-writer portion of the daemon retires. WI-14's other roles (chain-follower, event indexer, WI-15 settle keeper) survive. |

### 6.4 Circuit signatures that survive C2C unchanged (explicit list)

Every one of these is byte-for-byte the same before and after C2C, as seen by external keepers:

- `registerSchedule(scheduleId, scheduleData, ..., fedApproval, sig)`
- `retireSchedule(scheduleId, ..., fedApproval, sig)`
- `advanceEpoch(newEpoch, newGovRoot, newRefRate, fedApproval, sig)`
- `setNationalContext(newLDFloor, newOpsFloor, newSanity, fedApproval, sig)`
- `setFederationAuthority(newAuthHash, fedApproval, sig)`
- `registerLane(scheduleId, laneKindByte, leviedBy, effectiveEpoch, splitShares, fedApproval, sig, charterProof)`
- `retireLane(...)`
- `retuneClass(scheduleId, classPathHash, newSplitShares, operatorSig, retuneNonce)`
- `bootstrapActionLog(shardEnd)`
- `resolvePath`, `resolveCurrent`, `resolveLane`, `resolveLanes`, `isLaneActive`, `isChartered`, `isScheduleActive`, `getActionEntry`, `getActionPayloadHash`

What differs pre-vs-post-C2C is **only the witness parameters** on Lane's three mutators and on Views' `resolve*`, and those are keeper-library concerns, not on-chain interface.

---

## 7) Deploy sequence

Topological order, from independent to dependent:

### 7.1 Order

1. **Deploy `tariff-audit.compact`**
   - Constructor writes: `_actionLogClimb = pad(32, "pp:tariff:v1:actionLogEmpty")`, `_actionLogBootstrapCursor = 0`, `_bootstrapComplete = false`, `_initialized = true`.
   - Save deployed address as `AUDIT_ADDR`.

2. **Deploy `tariff-governance.compact`**
   - Constructor takes `AUDIT_ADDR` as a sealed init param.
   - Constructor writes constants: `_LD_FLOOR_BPS = 200`, `_OPS_FLOOR_BPS = 2000`, `_SANITY_BAND_PCT = 20`, `_federationAuthority = <initial>` (from deploy config), `_governanceRoot = <initial>` (from deploy config, seeded with genesis charter root), `_currentEpoch = 0`.
   - Save as `GOV_ADDR`.

3. **Deploy `tariff-schedule.compact`**
   - Constructor takes `AUDIT_ADDR`, `GOV_ADDR`.
   - Constructor writes: `_mirroredAuditAddress = AUDIT_ADDR`, `_mirroredGovAddress = GOV_ADDR`.
   - Mirror cells (`_mirroredGovernanceRoot` etc.) initialize to zero; must be populated by daemon before `registerSchedule` can succeed (blocked by mirror-epoch check).
   - Save as `SCHED_ADDR`.

4. **Deploy `tariff-lane.compact`**
   - Constructor takes `AUDIT_ADDR`, `GOV_ADDR`, `SCHED_ADDR`.
   - Save as `LANE_ADDR`.

5. **Deploy `tariff-views.compact`**
   - Constructor takes all four prior addresses.

6. **Bootstrap AuditLog:**
   - Call `bootstrapActionLog(8)`, `bootstrapActionLog(16)`, `bootstrapActionLog(24)` per WI-13.3 K=8 policy.
   - Post-terminal call: `_bootstrapComplete == true`, `registryActionLogRoot == expected depth-24 empty root`.

7. **Seed initial governance state on Governance:**
   - `advanceEpoch(1, <initial gov root>, <initial ref rate>, <fedApproval>, <sig>)` — the first epoch advance seeds `_governanceRoot`.

8. **Start mirror-writer daemon** (WI-14 keeper):
   - Daemon reads Governance's `_actionLog` for `EPOCH_ADVANCED`, calls `mirrorEpochAndFloors` and `mirrorGovernanceRoot` on Schedule, Lane, Views.
   - Once all four mirrors report `_mirroredEpoch >= 1`, the contract stack is ready for `registerSchedule` etc.

### 7.2 What the deploy script needs to know at each step

- **Between steps 1-5:** the address of every previously deployed contract (so constructor params can reference them).
- **Between steps 5-6:** nothing — bootstrap is self-contained.
- **Between steps 6-7:** the initial federation authority hash, the initial governance root, the initial national reference rate, and a valid federation-approval signature from the seat-of-record for `advanceEpoch(1, ...)`.
- **Between steps 7-8:** mirror-writer daemon config (source addresses, dest addresses, authority hash for mirror-writer signature).

Deploy script (`deploy-tariff-registry-preview.ts`) needs a 5-address plan carried across all steps.

### 7.3 Deploy tx size projections

Each individual `submitAndWatchExtrinsic` deploy tx must be under 786,432 bytes. Per §3.3, every sibling projects at ~250–460 KiB, so each deploy tx has 300+ KiB of headroom against the cap. The failing monolith tx (~2.19 MiB) becomes five successful txs each well under the cap.

---

## 8) Invariant preservation

Every invariant from the parent design docs is enumerated below with its verbatim source quote, its location, and the sibling contract that owns its enforcement post-split.

### 8.1 WI-13 core invariants (V1-DESIGN.md §6, lines 570-583)

Verbatim from `V1-DESIGN.md`:

> `| I-A (D-4 charter existence) | §4.1 charter proof + \_governanceRoot; §4.2 step 3 |`
> `| I-B (floors per retune) | §4.4 steps 7 (LD, OPS) + 8 (sanity band) |`
> `| I-C (sum-to-10000) | §4.4 step 7 (`sum == 10000 as Field`); `SplitShares` type invariant |`
> `| I-D (federation approval fresh) | §4.2 step 7 (sig verify) + step 8 (replay set) |`
> `| I-E (epoch monotonicity) | \_currentEpoch: Counter (append-only); advanceEpoch checked-cast to +1 only; retiredEpoch field enables historical resolvePath |`
> `| I-F (no fund movement) | Structural — no mint/burn/transfer primitives, no address-of-recipient in any circuit signature |`
> `| I-G (Compact discipline) | Every witness→ledger write uses disclose(); every inequality is a checked cast; no / or %; sealed fields in constructor |`

Preservation under the split:

| Inv | Owner post-split | Mechanism |
|-----|------------------|-----------|
| I-A | Schedule (registerSchedule), Lane (registerLane) | Both consume `charterProof` verified against **mirrored** `_governanceRoot`. Mirror-writer soundness (I-15-A) closes the loop: the mirrored root is only accepted with a valid governance-authority signature at a specified epoch. |
| I-B | Lane (retuneClass) | `retuneClass` reads mirrored floors atomically-bundled (see §4.2). The 5-value bundle mirror-write is the mechanism preserving I-B under the split. |
| I-C | Lane (retuneClass) | Structural (`SplitShares` type invariant + `sum == 10000 as Field` check). Type invariant survives file boundaries in Compact 0.30. |
| I-D | Sharded across Gov, Schedule, Lane (I-15-A domain disjointness) | Each contract holds its own `_consumedFederationApprovals` for the domain tags it owns; disjoint domain tags mean no cross-contract replay is possible. |
| I-E | Governance (advanceEpoch) | `_currentEpoch: Counter` in Governance. Counter is the same primitive as monolith. |
| I-F | Structural, all siblings | No sibling contract adds mint/burn/transfer. Deletion-audit at PR review. |
| I-G | Structural, all siblings | Compiler-enforced. Same rules apply to every `.compact` file. |

No I-13 invariant is weakened. Charter proofs and federation approvals are preserved with an extra mirror-verification step, which strengthens rather than weakens the check (adds a signature layer).

### 8.2 WI-13.1 lane invariants (V1.1-DESIGN.md §3, lines 767-777)

Verbatim from `V1.1-DESIGN.md`:

> `| I-13.1-A (federation gate) | consumeFederationApproval(actionHash, domain) inside both registerLane step (e) and retireLane step (d) | LANE-T1 happy path, LANE-T8 replay |`
> `| I-13.1-B (charter binding) | assertCharterMembership(schedRec.nodeId, charterProof) in registerLane step (b) | LANE-T2, LANE-R-A |`
> `| I-13.1-C (schedule liveness) | assert(schedRec.retiredEpoch == 0 as Uint<64>, "SCHEDULE_NOT_LIVE") in registerLane step (a) | LANE-T3 |`
> `| I-13.1-D (epoch non-retroactivity) | ((effectiveEpoch - _currentEpoch.read() - 1) as Uint<64>) checked cast in registerLane step (c) | LANE-T4 |`
> `| I-13.1-E (uniqueness at (scheduleId, leviedBy, laneKindByte)) | !\_registeredLanes.member(dKey) \|\| \_registeredLanes.lookup(dKey).retiredEpoch != 0 as Uint<64> duplicate check in registerLane step (f), key derived from all 3 fields via laneKey | LANE-T5 (multi-authority same-kind succeeds), LANE-T5b (exact-key dup fails), LANE-R-E |`
> `| I-13.1-F (retire idempotence + audit) | assert(rec.retiredEpoch == 0 as Uint<64>, "LANE_ALREADY_RETIRED") in retireLane step (b); retired records remain in \_registeredLanes until overwritten; indexer snapshots on each event | LANE-T6, LANE-T7 |`
> `| I-13.1-G (read purity) | resolveLane / resolveLanes / isLaneActive contain NO ledger writes and NO emitAction — structural | inspection (no test; structural verification) |`
> `| I-13.1-H (bounded batch width) | resolveLanes returns Vector<4, LaneRecord> (Kenya statutory stack). No registration-time cap; schedules with more than 4 live lanes cannot be settled by this contract — enforced at WI-14 settle time (revert SCHEDULE_LANE_OVERFLOW), not at WI-13.1 registration time | LANE-T9, LANE-T11 |`
> `| I-13.1-I (leviedBy non-zero) | assert(disclose(leviedBy) != pad(32, ""), "LANE_LEVIED_BY_ZERO") in registerLane step (a') — the zero-address is reserved as the resolveLanes empty-slot sentinel (MED-A) | LANE-T10 |`
> `| I-13.1-J (laneKindByte range) | ((16 - laneKindByte - 1) as Uint<8>) checked cast in registerLane step (c') | LANE-T12 |`
> `| I-13.1-K (parent-schedule liveness) | isLaneActive returns false unless \_registeredSchedules.member(scheduleId) and its retiredEpoch == 0, in addition to the lane-level checks (MED-B); WI-14 settle applies the same populated-live predicate in-circuit | LANE-T13 |`

Preservation under the split (all in Lane contract):

| Inv | Mechanism unchanged? | Notes |
|-----|:--------------------:|-------|
| I-13.1-A | ✅ (owner shift: Lane's local `_consumedFederationApprovals`) | Domain tags are `"pp:tariff:v1:federationDomain:registerLane"` and `"...retireLane"`, both Lane-owned. |
| I-13.1-B | ✅ | Charter proof against mirrored `_governanceRoot`. |
| I-13.1-C | ✅ (mechanism shift: Merkle proof against mirrored `_schedulesMerkleRoot` instead of direct `_registeredSchedules.lookup`) | The `schedRec.retiredEpoch == 0` assertion is unchanged; only the *source* of `schedRec` shifts from direct lookup to witness-verified Merkle proof. |
| I-13.1-D | ✅ | Checked cast against mirrored `_currentEpoch`. |
| I-13.1-E | ✅ | Direct `_registeredLanes.member` / `.lookup` — same contract as writer. |
| I-13.1-F | ✅ | Direct read on `_registeredLanes` — same contract. |
| I-13.1-G | ✅ | Structural. Views' variants of `resolveLane`/`resolveLanes` also have no writes. |
| I-13.1-H | ✅ | `Vector<4, LaneRecord>` return type preserved in both Lane's and Views' variants. |
| I-13.1-I | ✅ | Same disclose+assert idiom in Lane's `registerLane`. |
| I-13.1-J | ✅ | Same checked cast. |
| I-13.1-K | ✅ (mechanism shift: mirrored schedule root instead of direct lookup) | Same argument as I-13.1-C. |

### 8.3 WI-13.3 bootstrap invariants (V1.3-DESIGN.md §3.5, §7)

Verbatim from `V1.3-DESIGN.md` lines 231-236 (backticks preserved character-for-character from source):

> `_initialized` stays sealed and still receives exactly one write:
>
> - constructor writes `_initialized = true` exactly once (constructor-ran marker)
> - bootstrap writes `_bootstrapComplete = true` at terminal shard
> - `assertInitialized()` now enforces BOTH `_initialized` and `_bootstrapComplete`
> - all existing branch/read call sites stay unchanged and inherit the tighter gate

And from `V1.3-DESIGN.md` lines 361-362 (Option-B climb persistence invariant, backticks preserved):

> - On shard entry, loop continuation must start from persisted `_actionLogClimb`,
>   not from a fresh local seed, except initial constructor seed.

Preservation under the split:

| WI-13.3 invariant | Owner post-split | Notes |
|-------------------|------------------|-------|
| Sealed `_initialized` exactly-one-write | Each sibling has its own `_initialized`, written once in its own constructor. Governance/Schedule/Lane/Views each maintain the sealed-constructor-marker discipline. AuditLog's `_bootstrapComplete` retains its own trajectory. | Semantics per-contract; discipline unchanged. |
| `_bootstrapComplete` terminal-shard write | AuditLog only. | Only AuditLog runs the sharded loop; only AuditLog owns `_bootstrapComplete`. |
| `assertInitialized()` gate | Each sibling has a local `assertInitialized()` that checks its own `_initialized` AND its own required mirror bootstrap (`_mirroredEpoch >= 1`, `_mirroredAuditRoot != zero`, etc.). | Strictly tighter than monolith gate. |
| Climb persistence across shards | AuditLog | Body identical to monolith `bootstrapActionLog` at `tariff-registry-v1.compact:708-741`. |

### 8.4 New invariants introduced by V2 split

Two new invariant classes:

**I-15-A (Federation-domain disjointness):**
> No `opLabel` string value passed to `consumeFederationApproval` is exported by more than one sibling contract in the V2 split.

- Owner: static (repo-level).
- Enforced by: PR-review inspection; a compile-time cross-file grep in CI would be trivial to add.
- Consequence: I-D replay safety is preserved sibling-wise despite the sharded replay set.

**I-15-B (Mirror-root soundness):**
> Every mirror-write circuit MUST verify a signature under the source contract's federation authority (or a designated mirror-writer authority) over the tuple `(newRootValue, sourceEpochAtMirror)`, AND MUST enforce monotone `sourceEpochAtMirror` progression against a locally stored `_lastMirroredEpoch`.

- Owner: every mirror-write circuit in every sibling.
- Enforced by: each `mirror*` circuit body pattern (§4.1 template).
- Consequence: A malicious mirror-writer daemon cannot forge a stale or forged root, and cannot revert a mirror to an earlier state.

**I-15-C (Local-outbox ordering):**
> Each mutator sibling's `_actionSeq` is monotone within that sibling. AuditLog's `_actionSeq` is monotone globally. AuditLog's `commitAuditEntry` enforces `globalSeq == _actionSeq.read()` (Counter primitive).

- Owner: AuditLog + each mutator sibling.
- Enforced by: `Counter` primitive semantics + the `commitAuditEntry` sequence check.
- Consequence: WI-14 consumers see a well-defined global ordering.

---

## 9) Open questions

Items requiring Charles / Midnight team / Garrett input before implementation:

**Q1. Preview block-cap roadmap.**
Is there any published Midnight roadmap raising `max.normal` above 786,432 bytes? If so, the 5-way split may be over-engineered; a 3-way or 2-way with looser sizing could work. Nothing in the checked-in repo mentions such a roadmap; parent session's search on 2026-07-27 turned up nothing. **Assumption**: cap stays 768 KiB for the foreseeable Preview lifetime.

**Q2. Whether `sealed circuit` in Compact 0.30 dedupes across circuits.**
The monolith inlines `appendActionLogLeaf` into 9 mutators, each paying ~180 KiB for the same loop body. If Compact 0.30 supported `sealed circuit` deduplication (a single shared zkir referenced by multiple exports), we might shrink the monolith by ~1.5 MiB and fit under the cap without splitting. **Assumption**: `sealed circuit` does NOT dedupe across exported-circuit zkirs in 0.30. If Charles confirms otherwise, revisit before committing to the split.

**Q3. Whether `_classEntries` should live with `_registeredSchedules`.**
§4.7 places `_classEntries` in Lane because `retuneClass` writes to it. An alternative is placing `retuneClass` in Schedule (moving the class-retune surface with the schedules it retunes), which puts `_classEntries` in Schedule. That collapses one mirror (§4.7 disappears) but adds a mirror direction (Schedule now needs mirrored floors for I-B). Sizing works either way (Schedule with `retuneClass` at ~340 KiB, Lane without at ~340 KiB — both fit). Choose based on which reads more naturally to reviewers.

**Q4. Mirror-writer authority: same key as federation authority, or dedicated?**
§4.1 shows the mirror-writer daemon signing with `govAuthorityHash`. Using the federation authority key for mirror writes concentrates trust; a dedicated `_mirrorWriterAuthority` cell (Governance-controlled, rotatable) may be cleaner. Sizing impact: adds one more cell + one more Gov-controlled rotation circuit. Recommend: dedicated key. Confirm with Garrett.

**Q5. Dependency on WI-14 mirror-daemon patterns.**
The design assumes the WI-14 keeper (`settlement-api:feat/wi14-mirror-daemon`) has a proven pattern for signature-verified state mirrors. If WI-14 patterns haven't been solidified as of split-implementation start, WI-15 may need to solidify them first (or vice versa). Recommend: cross-check with `settlement-api` current mirror-daemon shape before opening the WI-15 PR.

**Q6. Testing story for the 5-contract deploy chain.**
Existing monolith tests (T1..T13, LANE-T*, T-13.3) run against a single-contract fixture. Post-split, tests need a 5-contract deploy harness, either in a local sandbox or against Preview. Q: does `@midnight/wallet-sdk-node-client` support in-process multi-contract deploy for tests? If not, need to build a fixture layer.

**Q7. Cross-sibling atomicity guarantees.**
A malicious keeper could partially propagate a mirror (e.g. update Schedule's `_mirroredGovernanceRoot` but not Lane's). Consumers reading Lane get a stale root for one epoch. Q: is that consequential for WI-14 settle? Or is eventual consistency across mirrors acceptable given the ~seconds propagation window? Recommend: eventual consistency with a per-sibling `_mirroredEpoch` visible to consumers, so WI-14 can gate settle on "all four siblings show the same mirrored epoch."

---

## 10) Deferred alternatives (rejected but recorded)

### 10.1 Reducing `ACTION_LOG_DEPTH`

Dropping `ACTION_LOG_DEPTH` from 24 to (say) 16 would shrink the append loop by ~33%, saving ~60 KiB per mutator × 9 mutators ≈ 540 KiB. Monolith would drop from 2.19 MiB to ~1.7 MiB. **Still over the cap.**

- **Rejected because:** the brief explicitly forbids it (WI-13.3 non-goal, V1.3-DESIGN.md §1 line "do not change `ACTION_LOG_DEPTH` (=24)"). Reducing depth also bounds the max lifetime action count to 2^16 = 65,536 entries, which is inadequate for a multi-decade tariff registry.
- **Even if allowed:** doesn't solve the problem; still over the cap.

### 10.2 Operational-extrinsic lane

Substrate has a separate `max.operational` byte budget (1,048,576 bytes = 1 MiB on Preview). Certain classes of extrinsics (governance, block author-driven) run under this larger budget.

- **Rejected because:**
  - Contract-deploy extrinsics are `normal` class in Midnight's ledger runtime; they do not have an operational path exposed to userland.
  - Monolith at 2.19 MiB is still 2.2× over the operational cap even if we could route through it.

### 10.3 Waiting for a Preview block-cap increase

Midnight has not published a roadmap in this branch context that lifts `max.normal` above 768 KiB. Waiting is not a route.

- **Rejected because:** no committed date, no branch-visible signal of intent, and downstream WIs (14/15/16/17) are blocked on Preview-live TariffRegistry.

### 10.4 Single-contract shrink via `sealed circuit` deduplication (or similar Compact 0.30 features)

If Compact 0.30 supported deduping a `sealed circuit` body across multiple exported-circuit zkirs, the 9 mutators × 180 KiB append-loop bloat would collapse to a single 180 KiB shared body, saving ~1.4 MiB. Monolith would fit.

- **Rejected because:** no evidence in the branch that this feature exists or works this way in 0.30. Even if it did, it would rest on a Compact-specific compilation semantic that may change between versions.
- **If it turns out to be viable (Q2 above):** revisit before committing to the split. It's the strictly-cheaper option if available.

### 10.5 Two-contract split (Governance+Audit / Everything else)

A minimal 2-way split. Bookkeeping is simpler, but "everything else" still contains 6 mutators + views + full action-log machinery, projected at ~1.6 MiB — over the cap.

- **Rejected because:** doesn't fit.

### 10.6 Three-contract split (Governance+Audit / Schedule+Lane / Views)

Governance+Audit at ~700 KiB (fits, thin margin). Schedule+Lane at ~950 KiB — over the cap (both hold mutators with the append loop). Views at ~240 KiB.

- **Rejected because:** Schedule+Lane busts. Would need to hoist the loop into Governance+Audit, at which point the design is 3-way with the same mirror-writer machinery as the 5-way, but with less balanced sizes.

### 10.7 Deferring the action-log append into a separate tx entirely (not a contract)

Instead of `commitAuditEntry` being a contract circuit, run the Merkle append entirely off-chain in the keeper. On-chain state: just the outbox and the committed root.

- **Rejected because:** breaks WI-14 event proofs, which need on-chain root soundness for zk-verifiable inclusion. The Merkle append MUST be in-circuit for the root to be trustworthy.

---

## 11) Verification checklist for implementers

Before opening the split PR, implementer (Cursor session or otherwise) must tick every box:

### 11.1 Sizing

- [ ] Compile all 5 siblings on Kenya against `compactc 0.30.0`.
- [ ] For each sibling, sum `build/**/zkir/*.bin`, `build/**/verifier-key/*`, `build/**/bzkir/*.bin`, plus overhead.
- [ ] Confirm every sibling total is < 786,432 bytes.
- [ ] Confirm every sibling has ≥ 100 KiB headroom (< 686,432 bytes).
- [ ] Record measured sizes in an appendix to this doc before merging.

### 11.2 Invariant preservation

- [ ] Every WI-13.x invariant enumerated in §8.1–8.3 has a corresponding mechanism in exactly one sibling contract.
- [ ] Every mechanism cites a specific circuit and line range in the new sibling file (analogous to how V1-DESIGN §6 cites §4.1 step 3 etc.).
- [ ] No cell has more than one writer.
- [ ] No cell has a writer that isn't listed as owner in §3.4.
- [ ] Every mirror cell has a `_mirrored*Epoch` companion.
- [ ] Every mirror-write circuit enforces I-15-B (signature + monotone epoch).

### 11.3 Interfaces

- [ ] Every keeper-facing circuit signature listed in §6.4 matches its monolith counterpart byte-for-byte (public-input schema).
- [ ] Lane's `registerLane`, `retireLane`, `retuneClass` and Views' `resolve*` correctly accept the new Merkle-proof witness parameters.
- [ ] Bundle-builder library (`settlement-api/mirror-bundle-builder`) produces the correct schedule/lane/class Merkle proofs.

### 11.4 Deploy dry-runs

- [ ] Local sandbox: deploy AuditLog, Governance, Schedule, Lane, Views in order. Confirm each `deployContract()` call succeeds (no `1010` errors).
- [ ] Local sandbox: run all 3 shards of `bootstrapActionLog`. Confirm `_bootstrapComplete == true`.
- [ ] Local sandbox: run `advanceEpoch(1, ...)` on Governance. Confirm `_governanceRoot` populated.
- [ ] Local sandbox: run mirror-writer daemon end-to-end. Confirm all 4 dependents show `_mirroredEpoch == 1`.
- [ ] Local sandbox: happy-path register a schedule via Schedule contract. Confirm entry appears in Schedule's local outbox AND is committed to AuditLog root within one daemon cycle.
- [ ] Local sandbox: happy-path register a lane. Confirm I-13.1-A through I-13.1-K all fire correctly against mirrored roots.
- [ ] Preview: repeat above end-to-end.

### 11.5 Regression posture

- [ ] Every existing monolith test (T1..T13, LANE-T*, T-13.3-*) has a corresponding split-fixture version that produces the same outcome.
- [ ] New tests for I-15-A/B/C mirror soundness.
- [ ] New tests for cross-sibling replay attempts (must fail).
- [ ] New tests for stale-mirror rejection (mirror-write with `epochAtMirror <= _lastMirroredEpoch` must fail).

### 11.6 Documentation

- [ ] `V2-SPLIT-DESIGN.md` (this doc) referenced from the top of each new `.compact` file.
- [ ] Ceremony runbook (WI-14 §4 or successor) updated with 5-contract deploy sequence.
- [ ] Mirror-writer daemon config schema documented in `settlement-api/mirror-daemon-config.md`.

---

## Appendix A: Measured data (parent session, 2026-07-27)

### A.1 Preview block-cap query (live via `system.blockLength`)

```
max.normal      = 786,432 bytes  (768 KiB)
max.operational = 1,048,576 bytes (1024 KiB)
```

### A.2 Monolith deploy-payload breakdown (measured on `kenya:~/contracts/tariff-registry/build/`)

```
18 verifier keys total: 35,838 bytes
18 zkir total:       2,111,428 bytes
18 bzkir total:        153,123 bytes
DEPLOY SUM:          2,300,389 bytes  (≈ 2.19 MiB)
Over normal cap:     × 2.93
Over operational:    × 2.19
```

### A.3 Per-circuit zkir sizes (measured)

```
registerLane             243,096
registerSchedule         234,611
retuneClass              234,185
advanceEpoch             229,665
retireLane               223,528
retireSchedule           222,882
setNationalContext       214,978
setFederationAuthority   212,376
bootstrapActionLog       178,027
resolveLanes              36,333
isLaneActive              16,602
isChartered               13,898
resolveCurrent            11,995
resolvePath               11,314
isScheduleActive           8,862
resolveLane                7,673
getActionEntry             5,859
getActionPayloadHash       5,544
```

### A.4 Sizing constants (calibration)

```
verifier per circuit: ~2 KB
bzkir per circuit:    ~8 KB
fixed overhead:       ~30 KB (contract-info.json + module glue)
```

### A.5 Cell-touch matrix

Full 28-cell inventory (`tariff-registry-v1.compact:236-334`):

**Federation-family cells** (schedule/lane/retune/epoch mutators):
`_LD_FLOOR_BPS`, `_OPS_FLOOR_BPS`, `_SANITY_BAND_PCT`, `_activeScheduleByNode`,
`_classEntries`, `_currentEpoch`, `_governanceRoot`, `_hasPendingContext`,
`_pendingLDFloorBps`, `_pendingOpsFloorBps`, `_pendingSanityBandPct`,
`_refRateFiatPerKwh`, `_registeredLanes`, `_registeredSchedules`,
`_retuneLastTime`, `_retuneNonces`

**Governance-only cell**: `_federationAuthority`

**Shared between federation and governance** (the pending-context shadow slots):
`_currentEpoch`, `_hasPendingContext`, `_pendingLDFloorBps`,
`_pendingOpsFloorBps`, `_pendingSanityBandPct`

**Action-log machinery** (bootstrap-only writer, all mutators readers pre-split):
`_actionLog`, `_actionSeq`, `registryActionLogRoot`, `_actionLogFrontier`,
`_actionLogZeros`, `_actionLogBaseSeq`, `_actionLogClimb`,
`_actionLogBootstrapCursor`, `_bootstrapComplete`

**Initialization**: `_initialized`

**Replay set** (parent-session ground truth omitted this cell; verified against `tariff-registry-v1.compact:292-293`):
`_consumedFederationApprovals`

Total: 28 cells (matches parent count; the parent-session cell inventory in the brief listed federation-family + governance + shared + action-log + init but the aggregate is consistent).

### A.6 Failing tx signature (from `kenya:~/contracts/tariff-registry/deploy-2026-07-27.attempt3.log`)

```
2026-07-27 12:45:58        RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic):
                           ExtrinsicStatus:: 1010: Invalid Transaction:
                           Transaction would exhaust the block limits
```

Failure point: first `submitAndWatchExtrinsic` inside `deployContract()`. No state landed on chain.

### A.7 Source citations reference (line ranges used in this doc)

| Ref | File | Line range | Content |
|-----|------|:----------:|---------|
| C1 | `tariff-registry-v1.compact` | 116-124 | `witness signature_valid(...)` |
| C2 | `tariff-registry-v1.compact` | 236-334 | Ledger cell declarations |
| C3 | `tariff-registry-v1.compact` | 292-293 | `_consumedFederationApprovals: Set<Bytes<32>>` |
| C4 | `tariff-registry-v1.compact` | 333-338 | `_actionLogClimb` transient accumulator comment |
| C5 | `tariff-registry-v1.compact` | 431-538 | `assertCharterMembership` |
| C6 | `tariff-registry-v1.compact` | 606-635 | `appendActionLogLeaf` — the 24-iter Merkle append loop |
| C7 | `tariff-registry-v1.compact` | 640-664 | `emitAction` |
| C8 | `tariff-registry-v1.compact` | 665-706 | `consumeFederationApproval` |
| C9 | `tariff-registry-v1.compact` | 708-741 | `bootstrapActionLog` — WI-13.3 sharded bootstrap |
| C10 | `tariff-registry-v1.compact` | 742-835 | `registerSchedule` |
| C11 | `tariff-registry-v1.compact` | 901-966 | `advanceEpoch` (writes `_governanceRoot`) |
| C12 | `tariff-registry-v1.compact` | 1021-1063 | `setFederationAuthority` |
| C13 | `tariff-registry-v1.compact` | 1064-1189 | `registerLane` |
| C14 | `tariff-registry-v1.compact` | 1268-1425 | `retuneClass` (writes `_classEntries`) |
| V1 | `V1-DESIGN.md` | 570-583 | I-A through I-G table |
| V1.1 | `V1.1-DESIGN.md` | 767-777 | I-13.1-A through I-13.1-K table |
| V1.3 | `V1.3-DESIGN.md` | 231-241 | Sealed-init exactly-one-write invariant |
| V1.3-b | `V1.3-DESIGN.md` | 361-362 | Climb persistence invariant |

---

## Appendix B: Rejected variants recap

| Variant | Fits under cap? | Why not recommended |
|---------|:---------------:|---------------------|
| Monolith as-is | ❌ (2.93× over) | Failing tx signature in Appendix A.6 |
| Monolith with `ACTION_LOG_DEPTH=16` | ❌ (still ~2.2× over) | Also forbidden by WI-13.3 non-goal |
| Monolith on `max.operational` lane | ❌ (2.19× over) | And unavailable to userland deploys |
| 2-way split (Gov+Audit / Rest) | ❌ | Rest still ~1.6 MiB |
| 3-way split (Gov+Audit / Sched+Lane / Views) | ❌ | Sched+Lane at ~950 KiB |
| 4-way split (parent's Option B) | ❌ Gov at ~886 KiB | Bootstrap loop still in Gov |
| **5-way split (this doc's recommendation)** | ✅ All under 460 KiB | Recommended |
| `sealed circuit` dedupe (if 0.30 supports) | Possibly ✅ | Q2 open item; revisit if confirmed viable |
| Off-chain Merkle append | ❌ (breaks WI-14) | Root loses zk-verifiability |

---

## Appendix C: File-map summary

Proposed new files (do NOT modify `tariff-registry-v1.compact`):

```
kenya:~/contracts/tariff-registry/
├── tariff-registry-v1.compact       # UNCHANGED (kept for archive / rollback)
├── tariff-audit.compact             # NEW
├── tariff-governance.compact        # NEW
├── tariff-schedule.compact          # NEW
├── tariff-lane.compact              # NEW
├── tariff-views.compact             # NEW
├── V1-DESIGN.md                     # UNCHANGED
├── V1.1-DESIGN.md                   # UNCHANGED
├── V1.3-DESIGN.md                   # UNCHANGED
└── V2-SPLIT-DESIGN.md               # NEW (this doc, once routed)
```

And on `settlement-api`:

```
kenya:/opt/pollpower/settlement-api/
├── mirror-daemon/                   # NEW OR EXTENDED
│   ├── mirror-writer.ts             # NEW — sig-verified state mirror pusher
│   ├── outbox-follower.ts           # NEW — reads sibling _actionLog, commits to AuditLog
│   └── config-schema.ts             # NEW
└── mirror-bundle-builder/           # NEW
    ├── build-schedule-proof.ts      # NEW — Merkle proofs for Lane's registerLane
    ├── build-class-proof.ts         # NEW
    └── build-lane-proof.ts          # NEW
```

---

_End of document._
