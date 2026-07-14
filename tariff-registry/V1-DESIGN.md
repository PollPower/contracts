# TariffRegistry v1 — Design Document

**Status:** DEV DRAFT — not deployed, not audited.
**Contract:** `tariff-registry-v1.compact`
**Work item:** WI-13 of
[`../FEDERATION-IMPLEMENTATION-PLAN.md`](../FEDERATION-IMPLEMENTATION-PLAN.md).
**Brief:** [`../dispatch-briefs/WI-13-TariffRegistry.md`](../dispatch-briefs/WI-13-TariffRegistry.md).
**Dispatch memo:** [`../dispatch-briefs/WI-13-DISPATCH-MEMO-2026-07-14.md`](../dispatch-briefs/WI-13-DISPATCH-MEMO-2026-07-14.md).
**Toolchain:** compactc 0.30.0, language 0.22.0, runtime 0.15.0 —
targeted per Garrett's written call (2026-07-14 22:57 JST). Plan §0.2's
0.31.0 pin is deferred; 0.31.0 upgrade gap documented in §11 of this
document.
**Implements decisions:** D-4 (governance-first ID minting, plan §0.3).
**Verified against source:** `TARIFF-SCHEDULE-MODEL.md` (blob 1650dd2)
§2 data model, §4 validator, §7.1 D-4; `STATUTORY-LANES-MODEL.md`
(blob 58fa615) §1.1 S1' sum-to-10000 with statutory lanes;
`multisig/FEDERATION-CHARTER-PROTOCOL.md` (blob 4dca4f2) §1, §2.2 charter
mints canonical id; `ebt/ebt-v7.4.2.compact` L237–L240, L561–L564
(sum-to-amount pattern), L104–L112 (multisig-gated setter shape);
`multisig/multisig-federated-v1.compact` L275–L328 (approve /
approveFederated signatures);
`living-dividend/living-dividend-v2.2.1.compact` L197–L203
(`checkedDivide` pattern).

---

## 0. What this document is

The dispatch brief pins **scope** (what the contract does), **invariants**
(what must hold), and **acceptance criteria** (what review will check).
This document pins **mechanism** — the exact circuit signatures, the exact
ledger-field types, the exact hashing and domain-tag layout, and the
specific structural answers to the R-A / R-B / R-C failure modes flagged
in the executing-session PR body.

It is written to be re-checkable against the WI-06 / WI-07 / WI-20 models
by a second BIG reviewer with **no shared context** (per plan §5.1 for
🏛-class items), and it is written before any `.compact` code so the
review can happen against the design, not the implementation.

### 0.1 One-sentence contract

> A registry that publishes epoch-versioned tariff schedules for chartered
> governance-tree nodes only (I-A / D-4), federation-gated for branch
> operations and permissionless-within-floors for leaf operations, whose
> only power is publishing structure — never touching value — so
> settlement can resolve splits deterministically against a
> federation-vetted, epoch-anchored source of truth.

---

## 1. The separation of powers this contract encodes

Restating the constitutional preamble (plan §0.1) so no reviewer has to
chase the reference:

- **Companies price** → `retuneClass` (leaf op, permissionless within
  floors). The operator's own signature is sufficient; the federation does
  NOT vote on a leaf retune (F-6: `retuneClass` un-gated is a design
  choice, not an oversight; federation approval on a leaf op would REDUCE
  the safety of the system by making every retune a governance queue
  event).
- **Members bound** → `registerSchedule`, `registerLane`,
  `retireSchedule`, `advanceEpoch`, `setNationalContext` (branch /
  constitutional ops, all federation-gated via `approveFederated`).
- **The mint pays** → nothing in this contract. WI-14's EBT vNext
  consumes `resolvePath`. Registry has zero mint / redeem / escrow
  primitives (I-F).

The three actors and the two power bands are visible in the circuit list
below: five federation-gated writes, one operator-gated write, three
read-only views. That's it.

---

## 2. Compact 0.30.0 constraints that shape the design

Every mechanism choice below is forced by a language / compiler reality.
An implementer must respect these; they are not stylistic.

- **No contract-to-contract calls.** The registry cannot call the multisig
  contract, the charter registry, or EBT. It cannot ASK "is this seat
  authorised?" or "is this node chartered?" — instead, the caller SUBMITS
  a witness that provides the proof, and the circuit re-hashes and
  verifies it. This is the MIP-0002-shaped pattern the EBT/LD stack
  already uses.
- **No integer `/` or `%` in-circuit.** The `checkedDivide(numeratorF,
  divisorF, r: DivResult)` idiom from LD v2.2.1 L197–L203 is the only
  path for any division-adjacent arithmetic (used here for the sanity-band
  edge calculation — see §5.4).
- **`Field` has no `<` / `<=`.** Every inequality (floor checks, band
  bound checks, epoch monotonicity) is realized as a **checked cast**:
  `(a - b) as Uint<N>` reverts at runtime on underflow. Reference: LD's
  `_range = marginF as Uint<128>` line, and the whole
  TARIFF-SCHEDULE-MODEL §5.4 discussion. Every `assert(a >= b)` in this
  contract is really a checked cast, not a comparison.
- **Bounded structures only.** No unbounded arrays. The path resolution
  in `resolvePath` is bounded by compile-time constants
  `MAX_LINES_PER_COMPANY = 8`, `MAX_CLASSES_PER_LINE = 8`,
  `MAX_STATUTORY_LANES = 4` (chosen; see §9.1).
- **`disclose()` on witness→ledger writes.** Any field originating from
  a witness (federation approval, charter proof, operator retune sig)
  that flows to a ledger write needs `disclose()`, exactly as EBT and LD
  do.
- **Sealed config needs `constructor()`.** `LD_FLOOR_BPS`,
  `OPS_FLOOR_BPS`, `SANITY_BAND_PCT`, and the epoch counter are all set
  in `constructor()` — after that, only `advanceEpoch` and
  `setNationalContext` can touch the calibration surface, and both are
  federation-gated with dedicated signed payloads.

---

## 3. Ledger fields (exact)

```
// ============================================================
// Sealed configuration (constructor-only)
// ============================================================

// Federation multisig authority hash: SHA-256(sorted seat pubkeys) of
// the tier whose approveFederated witness gates every branch op.
// Rotatable ONLY via setFederationAuthority (federation-approved).
export ledger _federationAuthority: Bytes<32>;

// The three constitutional constants. Named. Not TODO. Set in
// constructor() from Garrett's 2026-07-14 written call.
export ledger _LD_FLOOR_BPS:     Uint<16>;    // = 200  (2%)   CAL-1
export ledger _OPS_FLOOR_BPS:    Uint<16>;    // = 2000 (20%)  CAL-1
export ledger _SANITY_BAND_PCT:  Uint<16>;    // = 20   (±20%) CAL-2

// ============================================================
// Epoch (monotone; F-7 protection)
// ============================================================

// The current registry epoch. Increments ONLY via advanceEpoch, which
// is federation-gated. Sanity-band re-centering happens at this same
// event (memo §3 F-1). Never derived from block time. Never derived
// from a witness. F-7 negative tests verify that no other circuit
// touches this.
export ledger _currentEpoch: Counter;

// The national reference rate that anchors the sanity band. Recenters
// only on advanceEpoch. Domain-separated from block-time.
export ledger _refRateFiatPerKwh: Uint<64>;

// ============================================================
// Governance-tree charter root (D-4 enforcement, R-A resolution)
// ============================================================

// SHA-256 Merkle root committing the CURRENT set of chartered
// governance-tree node ids (nations, companies, lines of business).
// Set at construction; rotates via advanceEpoch's payload (a new epoch
// snapshots a new charter set). registerSchedule's charter-proof
// witness verifies membership against THIS root, in-circuit,
// re-hashing the caller-supplied Merkle path. See §4.1 for the
// mechanism. This is R-A's structural fix: no
// witness_charterExists(nodeId) -> Boolean primitive exists; only a
// Merkle-inclusion proof against a governance-controlled root can
// satisfy I-A.
export ledger _governanceRoot: Bytes<32>;

// ============================================================
// Schedule storage (I-E: epoch-anchored; supersession never
// invalidates past epochs)
// ============================================================

// key = scheduleId = persistentHash(pp:tariff:schedule:v1, nodeId,
//   scheduleEpoch, scheduleHashDigest). See §4.2.
export ledger _registeredSchedules: Map<Bytes<32>, ScheduleRecord>;

// Chartered node id -> currently active schedule id for THAT node at
// the CURRENT epoch. Node granularity: whichever level in the tree
// (nation, company) owns the schedule. Retirement clears this entry.
export ledger _activeScheduleByNode: Map<Bytes<32>, Bytes<32>>;

// ============================================================
// Retune replay guard (R-B resolution)
// ============================================================

// Per-operator, per-schedule, per-epoch nonce. Keyed on the
// persistentHash of (operatorId, scheduleId, epochBytes) — a compound
// key, not operatorId alone. This is R-B's structural fix: a signed
// retune for schedule A at epoch e cannot replay against schedule B
// or epoch e+1 because the composite key differs.
export ledger _retuneNonces: Map<Bytes<32>, Uint<64>>;

// ============================================================
// Federation-approval replay guard (I-D)
// ============================================================

// Consumed federation actionHashes. Every branch op inserts its hash
// after verification; second submission MUST fail (T4). Same
// discipline as multisig-federated-v1's _approvals map, but stored
// only on successful consumption (not pending).
export ledger _consumedFederationApprovals: Set<Bytes<32>>;

// ============================================================
// Event log (MIP-0002 pattern, keeper-observable)
// ============================================================

// Public ledger log of registry actions. WI-14's settlement path
// subscribes to this to invalidate its resolved-splits cache when a
// schedule is retuned, replaced, or retired. Explicit enumeration of
// what each mutation emits is in §7.
export ledger _actionLog: Map<Uint<64>, RegistryActionEntry>;
export ledger _actionSeq: Counter;
```

### 3.1 Struct definitions

```
struct ScheduleRecord {
  scheduleId:      Bytes<32>       // key echoed here for readability
  nodeId:          Bytes<32>       // chartered governance-tree id
  scheduleHash:    Bytes<32>       // WI-06 §3 canonical hash of the
                                   //   full serialized schedule
  effectiveEpoch:  Uint<64>        // takes effect at this epoch
  retiredEpoch:    Uint<64>        // 0 = live; nonzero = retired at
                                   //   that epoch; still resolvable
                                   //   at any e < retiredEpoch (I-E,
                                   //   R-C resolution)
  registeredAt:    Uint<64>        // block time, L-3 style
}

struct RegistryActionEntry {
  kind:            Uint<8>          // enum below
  scheduleId:      Bytes<32>        // 0 if not schedule-scoped
  nodeId:          Bytes<32>        // 0 if not node-scoped
  epoch:           Uint<64>         // registry epoch at time of action
  actionHash:      Bytes<32>        // federation actionHash or
                                    //   operator sig payload hash
  emittedAt:       Uint<64>         // block time
}
```

Action kind enum (single byte, small, fixed):

| kind | mnemonic                   | emitted by                    |
|------|----------------------------|-------------------------------|
| 0    | SCHEDULE_REGISTERED        | `registerSchedule`            |
| 1    | LANE_REGISTERED            | `registerLane`                |
| 2    | CLASS_RETUNED              | `retuneClass`                 |
| 3    | SCHEDULE_RETIRED           | `retireSchedule`              |
| 4    | EPOCH_ADVANCED             | `advanceEpoch`                |
| 5    | NATIONAL_CONTEXT_UPDATED   | `setNationalContext`          |
| 6    | FEDERATION_AUTHORITY_ROTATED | `setFederationAuthority`    |

---

## 4. Circuits (exact signatures)

Every state-mutating circuit follows the same skeleton:

1. `assertInitialized()` (mirrors EBT v7.4.2 pattern).
2. Verify `currentTime` monotonicity + `blockTimeGte` (L-3).
3. Compute the *expected* action / payload hash by re-hashing the
   caller-supplied inputs with a domain tag and the contract's own
   address (`kernel.self()`) — this closes M-2 in-circuit, same shape
   as the EBT `execMultisigOp` and msfed's `directApprovalMsg`.
4. Verify the appropriate witness (federation approval, charter proof,
   operator signature) via `disclose(sigOk)`.
5. Assert the action hash is not already consumed (I-D replay).
6. Perform the state mutation with `disclose()` on every witness-derived
   write.
7. Emit `RegistryActionEntry` (§7).

### 4.1 The charter-proof witness (R-A structural fix)

This is the single most load-bearing piece of design in the contract.
The brief's I-A says "MUST fail if nodeId is not present in the
governance-tree charter registry" — the R-A worst-compliant reading of
this is a bare `witness charterExists(nodeId: Bytes<32>): Boolean` that
the prover simply returns `true` for. That reduces I-A from a structural
guarantee to prover honesty (LD-C-1 shape). This design forbids that.

Instead:

```
witness charter_membership_proof(
  nodeId: Bytes<32>,
): CharterProof;   // returns a Merkle-inclusion proof structure

struct CharterProof {
  siblings: Vector<CHARTER_DEPTH, Bytes<32>>,
  indices:  Vector<CHARTER_DEPTH, Boolean>,
}
```

The circuit reconstructs the root from `(nodeId, siblings, indices)` by
`CHARTER_DEPTH` SHA-256 pair-hashes, then asserts the reconstructed root
equals `_governanceRoot`. The witness is data (a proof), not a truthy
Boolean; a lying prover cannot forge a Merkle path against a root it
did not choose. The keeper side that maintains the off-chain charter
tree — the WI-20 "parent mints the id" ceremony — is the sole source of
`_governanceRoot` updates, and those updates are federation-gated (see
§4.3.4).

`CHARTER_DEPTH = 12` — supports 4096 nodes, well beyond the pilot's
country-scale needs (100s of nodes at national scale). Bounded, cheap.

### 4.2 `registerSchedule`

```
export circuit registerSchedule(
  nodeId:              Bytes<32>,         // chartered node
  scheduleHash:        Bytes<32>,         // WI-06 §3 canonical
  effectiveEpoch:      Uint<64>,          // > currentEpoch (I-4)
  validatorAttestor:   Bytes<32>,         // WI-16 verdict signer pubkey
  validatorSignature:  Bytes<64>,         // WI-16 verdict signature
  currentTime:         Uint<64>,
): [] { ... }
```

**Charter proof and federation approval are witness-sourced** — the prover
supplies `charter_membership_proof(nodeId)` (returns `CharterProof`) and
`multisig_signature_valid(actionHash, _federationAuthority)` (returns
`Boolean`) from private state. This is why they are not explicit params:
Compact witnesses read from the prover's private state, and this mirrors
EBT/LD's shape byte-for-byte.

**Checks (in order):**
1. `assertInitialized()`.
2. `blockTimeGte(currentTime)` (L-3).
3. Charter proof verifies against `_governanceRoot` (§4.1). REJECT
   otherwise → `SCHEDULE_UNCHARTERED_NODE` (I-A / D-4 enforcement).
4. `effectiveEpoch > _currentEpoch.read()` via checked cast (I-4).
5. Recompute expected `actionHash = persistentHash<Vector<6, Bytes<32>>>([
     pad(32, "pp:tariff:v1:registerSchedule"),
     kernel.self().bytes,           // M-2, self-binding
     nodeId,
     scheduleHash,
     (effectiveEpoch as Field) as Bytes<32>,
     currentEpochBytes              // binds registry epoch (I-E)
   ])`
6. Verify validator attestor signature over `actionHash` — this is the
   WI-16 verdict binding; the attestor signs "I ran the WI-06 validator
   against `scheduleHash` and it accepted." Fail → `VALIDATOR_VERDICT_INVALID`.
7. Verify federation approval via `multisig_signature_valid(actionHash,
   _federationAuthority)` — the SAME shared witness EBT v7.4.2 and LD
   v2.2.1 use. The off-chain prover reconstructs the msfed council bundle
   (3-of-5 seat approvals, direct or `approveFederated` attested); the
   witness returns Boolean; the contract asserts it. This does NOT
   duplicate msfed's own `approveFederated` msg reconstruction —
   registry-side, `actionHash` IS the payload; msfed-side, the bundle
   builder maps that same `actionHash` into direct/federated approval
   messages per msfed L211–L213. Domain drift in `actionHash`'s tag
   (`pp:tariff:v1:*`) is deliberate and orthogonal to msfed's own domains
   — the msfed layer signs over WHATEVER `actionHash` it is asked to
   approve. Fail → `FEDERATION_APPROVAL_INVALID` (I-D).
8. Assert `!_consumedFederationApprovals.member(actionHash)` (I-D replay
   guard). Fail → `FEDERATION_APPROVAL_REPLAYED`.
9. Compute `scheduleId = persistentHash<Vector<4, Bytes<32>>>([
     pad(32, "pp:tariff:v1:scheduleId"),
     kernel.self().bytes,
     nodeId,
     (effectiveEpoch as Field) as Bytes<32>
   ])`.
10. Insert `ScheduleRecord` at `scheduleId`; set
    `_activeScheduleByNode[nodeId] = scheduleId`; insert `actionHash`
    into `_consumedFederationApprovals`.
11. Emit `SCHEDULE_REGISTERED`.

Every write uses `disclose()`.

### 4.3 Other federation-gated circuits (identical skeleton, distinct domain tags)

- **`registerLane(scheduleId, laneKindByte, ...)`** — domain
  `pp:tariff:v1:registerLane`.
- **`retireSchedule(scheduleId, ...)`** — domain
  `pp:tariff:v1:retireSchedule`. Sets `retiredEpoch = _currentEpoch`;
  clears `_activeScheduleByNode[nodeId]` iff the record is still the
  active one. Historical `resolvePath(scheduleId, path, e)` at
  `e < retiredEpoch` continues to work (I-E).
- **`advanceEpoch(newRefRateFiatPerKwh, newGovernanceRoot, ...)`** —
  domain `pp:tariff:v1:advanceEpoch`. Increments `_currentEpoch` by 1;
  atomically updates `_refRateFiatPerKwh` and `_governanceRoot`. This is
  the SINGLE circuit permitted to move the sanity-band anchor (F-1: no
  block-time recenter; no witness recenter; only this governance act).
  Federation-approved. Epoch increment is by exactly 1 — F-7 enforced
  via checked cast: `(_currentEpoch.read() + 1 - newEpochField) as
  Uint<64>` combined with `(newEpochField - _currentEpoch.read() - 1) as
  Uint<64>`, both cast to `Uint<64>`, giving a hard equality gate.
- **`setNationalContext(newLDFloorBps, newOpsFloorBps, newBandPct, ...)`**
  — domain `pp:tariff:v1:setNationalContext`. Federation-approved AND
  epoch-delayed: a change submitted at epoch `e` takes effect at the
  NEXT `advanceEpoch` (mechanism: it writes to a shadow trio
  `_pendingLDFloor` / `_pendingOpsFloor` / `_pendingBandPct` that
  `advanceEpoch` atomically swaps in, if set). This satisfies WI-06 §6:
  floor tightening cannot retroactively reject already-accepted
  schedules mid-epoch.
- **`setFederationAuthority(newAuthorityHash, ...)`** — domain
  `pp:tariff:v1:rotateAuth`. Same shape as EBT v7.4.2's
  `setMultisigAuthority` (v7.4 lines 447–470). Nonce-guarded. Enables
  Tangem ring swap without redeploy.

### 4.4 `retuneClass` (leaf op — F-6: NOT federation-gated by design)

```
export circuit retuneClass(
  scheduleId:            Bytes<32>,
  classPath:             Bytes<32>,      // hash of (lineId, classId)
  newSplitBps:           SplitShares,    // struct in §4.4.1
  newRateFiatPerKwh:     Uint<64>,       // WI-06 §5.5: rate is a leaf-op knob
  operatorId:            Bytes<32>,      // the schedule's operator pubkey
  operatorSignature:     Bytes<64>,
  nonceIn:               Uint<64>,
  currentTime:           Uint<64>,
  divLo, divHi:          DivResult,      // witness-divmod for band edge calc
): [] { ... }
```

**Why both `newSplitBps` AND `newRateFiatPerKwh`.** WI-06 §5.5 explicitly
calls out both class rate and split as leaf-op knobs ("Retuning a class or
a split within the floors is permissionless"). The retune primitive must
therefore accept both atomically. The sanity band (F-5 / T3.5) applies
to the **new rate** against the schedule's declared `refRateFiatPerKwh`
(the per-schedule anchor set at `registerSchedule` time), not to any
share bps — the memo's F-5 says "push `fiatValueAtMint` outside
±SANITY_BAND_PCT of the schedule's reference," and `fiatValueAtMint` is
rate-shaped, not share-shaped.

**Checks:**
1. `assertInitialized()`, `blockTimeGte(currentTime)`.
2. Look up `_registeredSchedules[scheduleId]`; assert exists AND
   `retiredEpoch == 0` (or `_currentEpoch < retiredEpoch`). Fail →
   `SCHEDULE_NOT_LIVE`.
3. **R-B compound nonce key.** Compute
   `nonceKey = persistentHash<Vector<4, Bytes<32>>>([
     pad(32, "pp:tariff:v1:retuneNonce"),
     operatorId,
     scheduleId,
     (currentEpoch as Field) as Bytes<32>
   ])`. Look up `_retuneNonces[nonceKey]` (0 if absent).
4. Assert `nonceIn == prev + 1` via checked cast (strict monotone,
   per-operator/schedule/epoch).
5. Recompute expected operator payload hash:
   `payloadHash = persistentHash<Vector<7, Bytes<32>>>([
     pad(32, "pp:tariff:v1:retuneClass"),
     kernel.self().bytes,
     scheduleId,
     classPath,
     splitSharesHash(newSplitBps),      // canonical hash of the 5 shares
     (currentEpoch as Field) as Bytes<32>,
     (nonceIn as Field) as Bytes<32>
   ])`.
6. Verify `signature_valid(operatorId, payloadHash, operatorSignature)`.
   Fail → `RETUNE_OPERATOR_SIG_INVALID`.
7. **I-B floor re-check (F-5).** Recompute the full path's cascaded
   floor set for the schedule's `nationRef` (read from `ScheduleRecord`
   directly, no witness) and assert:
   - `newSplitBps.ldShareBps >= _LD_FLOOR_BPS`  (checked cast)
   - `newSplitBps.opsShareBps >= _OPS_FLOOR_BPS` (checked cast)
   - `sum(newSplitBps) == 10000` (Field equality against `10000 as
     Field`, EBT v7.4.2 L564 pattern).
8. **T3.5: sanity-band re-check on retune.** The new rate
   `newRateFiatPerKwh` MUST lie within ±`_SANITY_BAND_PCT` of the
   schedule's declared `rec.refRateFiatPerKwh`. TARIFF-SCHEDULE-MODEL.md
   §4.4a C1 with the checkedDivide-based edge calc:
   ```
   bandBps    = _SANITY_BAND_PCT * 100          (e.g. 20 → 2000)
   bandDelta  = checkedDivide(refRate * bandBps, 10000, divLo)
   lowEdge    = refRate - bandDelta
   highEdge   = refRate + bandDelta
   assert lowEdge  <= newRate    (checked-cast)
   assert newRate  <= highEdge   (checked-cast)
   ```
   All intermediates in `Field` to avoid Uint<128> overflow warnings;
   final band-edge assertions via `(newRate + bandDelta - refRate) as
   Uint<128>` and `(refRate + bandDelta - newRate) as Uint<128>`. Fail
   → `RETUNE_VIOLATES_SANITY_BAND`. `divHi` is threaded for future
   asymmetric bands + to lock the ABI shape; today the band is
   symmetric so both edges share `bandDelta`.
9. Update `_retuneNonces[nonceKey] = nonceIn`.
10. Emit `CLASS_RETUNED` action.

**No federation approval anywhere in this path.** F-6 is upheld:
retuneClass being un-gated is a design choice; the safety comes from
the cascaded floor re-check (step 7) and the sanity-band re-check
(step 8), NOT from governance.

#### 4.4.1 `SplitShares` (retune payload)

```
struct SplitShares {
  producerShareBps:  Uint<16>,
  ldShareBps:        Uint<16>,
  opsShareBps:       Uint<16>,
  daoShareBps:       Uint<16>,
  operatorMarginBps: Uint<16>,
  // WI-07 lanes: the lane-total-bps field. Actual lane spec lives in
  // the schedule (immutable per epoch); retune only moves the five
  // party shares relative to a fixed lane total. If a retune wants
  // to change the statutory total, that is a registerLane branch op,
  // not a retune.
  statutoryTotalBps: Uint<16>,
}
```

Sum invariant (S1' from WI-07): all six fields sum to exactly 10000.

### 4.5 Read-only views (I-F — no state mutation)

- **`resolvePath(scheduleId, classPath, epoch): ResolvedPath`** —
  R-C resolution. Two paths:
  - `resolvePath(scheduleId, classPath, epoch)` accepts any epoch but
    ASSERTS `epoch <= _currentEpoch.read()` AND `epoch >=
    scheduleRecord.effectiveEpoch` AND (either `scheduleRecord.retiredEpoch
    == 0` OR `epoch < scheduleRecord.retiredEpoch`). This is the audit-
    trail path — future observers can ask "what was the split at epoch
    e?" and get an answer only if the schedule was live at e.
  - `resolveCurrent(scheduleId, classPath): ResolvedPath` — the settlement
    fast-path; internally `resolvePath(scheduleId, classPath,
    _currentEpoch.read())`. This is what WI-14 uses. It cannot be
    tricked into returning a stale-epoch split because it hard-codes
    the current epoch.
- **`isChartered(nodeId, charterProof): Boolean`** — verifies the proof
  against `_governanceRoot`; used by WI-16 tooling and by WI-14 as a
  pre-flight before submitting settlement. Read-only.
- **`nationalContext(): NationalContext`** — returns the current
  `(LD_FLOOR_BPS, OPS_FLOOR_BPS, SANITY_BAND_PCT, refRateFiatPerKwh,
  currentEpoch)`. Used by WI-16.
- **`isScheduleActive(scheduleId): Boolean`** — convenience for
  keepers.

**None of these mutate state.** I-F structurally holds — no `mint`, no
`burn`, no `transfer`, no address-of-recipient anywhere.

---

## 5. Domain-tag registry

Every signed / hashed action has its own domain tag, all under the
namespace `pp:tariff:v1:*`. Full list (no others):

| Tag                              | Used by                    |
|----------------------------------|----------------------------|
| `pp:tariff:v1:registerSchedule`  | `registerSchedule` actionHash |
| `pp:tariff:v1:registerLane`      | `registerLane` actionHash  |
| `pp:tariff:v1:retuneClass`       | `retuneClass` operator sig |
| `pp:tariff:v1:retuneNonce`       | `_retuneNonces` compound key derivation |
| `pp:tariff:v1:retireSchedule`    | `retireSchedule` actionHash |
| `pp:tariff:v1:advanceEpoch`      | `advanceEpoch` actionHash  |
| `pp:tariff:v1:setNationalContext` | `setNationalContext` actionHash |
| `pp:tariff:v1:rotateAuth`        | `setFederationAuthority` actionHash |
| `pp:tariff:v1:scheduleId`        | `scheduleId` derivation    |
| `pp:tariff:v1:splitShares`       | `splitSharesHash` (canonical) |

Cross-lineage domain tags this contract DEPENDS on (verbatim from source):

| Tag                          | Source                                      |
|------------------------------|---------------------------------------------|
| `pp:tariff:schedule:v1`      | WI-06 §3 (external canonical hash the contract stores) |
| `pp:tariff:statlanes:v1`     | WI-07 §4 (external, statutoryLanesRoot)     |
| `pp:fed:charter:v1`          | WI-20 §2.1 (external charterHash — off-chain, not consumed here) |

**No cross-lineage signed-payload reconstruction.** The registry does NOT
reproduce msfed's `pp:msfed:v1:approve:fed` / `pp:msfed:v1:approve:direct`
payload shapes in-circuit. Federation-gated writes use
`multisig_signature_valid(actionHash, _federationAuthority)` — the same
shared witness EBT v7.4.2 (L138–L143) and LD v2.2.1 use. The off-chain
bundle builder reproduces msfed's signing messages when collecting seat
approvals, but that reproduction lives in the JS/TS bundle helper, not
here. Any drift in bundle-helper reproduction breaks I-D; the *contract*
is correct as long as the witness returns Boolean truthfully.

---

## 6. Invariant-to-mechanism map

| Invariant | Where enforced |
|-----------|----------------|
| I-A (D-4 charter existence) | §4.1 charter proof + `_governanceRoot`; §4.2 step 3 |
| I-B (floors per retune) | §4.4 steps 7 (LD, OPS) + 8 (sanity band) |
| I-C (sum-to-10000) | §4.4 step 7 (`sum == 10000 as Field`); `SplitShares` type invariant |
| I-D (federation approval fresh) | §4.2 step 7 (sig verify) + step 8 (replay set) |
| I-E (epoch monotonicity) | `_currentEpoch: Counter` (append-only); `advanceEpoch` checked-cast to `+1` only; `retiredEpoch` field enables historical `resolvePath` |
| I-F (no fund movement) | Structural — no mint/burn/transfer primitives, no address-of-recipient in any circuit signature |
| I-G (Compact discipline) | Every witness→ledger write uses `disclose()`; every inequality is a checked cast; no `/` or `%`; sealed fields in constructor |

Same-tree invariant (plan §0.2) — the `nodeId` used in `registerSchedule`
IS the id minted by the governance-tree charter ceremony (WI-20), because
the `charterProof` verifies against `_governanceRoot`, which is populated
ONLY by the WI-20-side ceremony via `advanceEpoch`. There is no other
way to add a nodeId to the accepted-set.

---

## 7. Events (keeper-observable, MIP-0002 pattern)

Every state-mutating circuit emits exactly one `RegistryActionEntry` into
`_actionLog`, keyed by an incrementing `_actionSeq` counter. Downstream
consumers subscribe to this map's growth via the indexer:

- **WI-14 settlement keeper** watches `CLASS_RETUNED` +
  `SCHEDULE_REGISTERED` + `SCHEDULE_RETIRED` events for the schedules
  it resolves against; invalidates its local split-cache on each.
- **WI-16 validator tooling** watches `EPOCH_ADVANCED` +
  `NATIONAL_CONTEXT_UPDATED` to know when floors change.
- **WI-17 "explain this tariff" renderer** watches
  `SCHEDULE_REGISTERED` + `LANE_REGISTERED` to know when to re-fetch
  the schedule structure.
- **Audit tooling** watches `FEDERATION_AUTHORITY_ROTATED` to log the
  Tangem ceremony trail.

Explicit enumeration per memo §3 F-8 ("all state-mutating circuits emit
events sufficient for keeper-side view invalidation").

---

## 8. Failure modes and revert messages

Every `MUST fail` from the brief is a REVERT (memo F-2: "'MUST fail'
means REVERT, not warning event"). Concrete revert reasons:

| Code | Where | Meaning |
|------|-------|---------|
| `SCHEDULE_UNCHARTERED_NODE` | registerSchedule §4.2 step 3 | I-A violation |
| `EFFECTIVE_EPOCH_NOT_FUTURE` | registerSchedule §4.2 step 4 | I-4 violation |
| `VALIDATOR_VERDICT_INVALID` | registerSchedule §4.2 step 6 | WI-16 attestor sig fails |
| `FEDERATION_APPROVAL_INVALID` | branch ops step 7 | I-D partial (bad sig / wrong seat) |
| `FEDERATION_APPROVAL_REPLAYED` | branch ops step 8 | I-D replay |
| `SCHEDULE_NOT_LIVE` | retuneClass §4.4 step 2 | Retune on retired schedule |
| `RETUNE_OPERATOR_SIG_INVALID` | retuneClass §4.4 step 6 | Wrong operator or bad sig |
| `RETUNE_LD_FLOOR_VIOLATION` | retuneClass step 7 | I-B floor breach |
| `RETUNE_OPS_FLOOR_VIOLATION` | retuneClass step 7 | I-B floor breach |
| `RETUNE_SUM_NOT_10000` | retuneClass step 7 | I-C violation |
| `RETUNE_VIOLATES_SANITY_BAND` | retuneClass step 8 | T3.5 |
| `RETUNE_NONCE_MISMATCH` | retuneClass step 4 | R-B replay guard |
| `EPOCH_ADVANCE_NOT_PLUS_ONE` | advanceEpoch | F-7 negative test (memo §3) |
| `RESOLVE_EPOCH_OUT_OF_RANGE` | resolvePath | R-C guard |

---

## 9. Bounded-sizing choices

### 9.1 Depth constants

```
const MAX_LINES_PER_COMPANY   = 8;    // WI-06 §1 bound
const MAX_CLASSES_PER_LINE    = 8;
const MAX_STATUTORY_LANES     = 4;    // WI-07 §1 bound
const CHARTER_DEPTH           = 12;   // supports 4096 chartered nodes
```

Justification for `CHARTER_DEPTH = 12`: 4096 nodes is 20-40x the size
of the country-scale target (200 nodes at national scale per the
onboarding doc). Fixed depth = fixed proof cost = predictable circuit
weight. Padding is applied per the tree convention (right-fill with a
sentinel; matches SORTITION-TABLE-DESIGN §1.1).

### 9.2 Block-weight budget

The EBT v7.4.2 `execMultisigOp` fit-into-block work (its four setters
merged into one exported circuit) is instructive. The tariff registry
has more distinct branch ops but each is smaller. Predicted block
weight per circuit (order of magnitude, to be verified at compile):

- `registerSchedule` — largest; heaviest single circuit. Charter proof
  is 12 SHA-256 pair-hashes + 2 signature verifies (validator +
  federation). Estimate: comparable to EBT `settle` (which has 1 HAT
  sig + 1 producer sig + 4 mint calls).
- `retuneClass` — 1 operator sig + 5 checked casts + 1 Field-equality.
  Estimate: smaller than `claimSplit`.
- Read-only views — cheap.

If block-weight becomes an issue at compile time, the four
federation-gated setters (`registerLane`, `retireSchedule`,
`setNationalContext`, `setFederationAuthority`) can be merged into an
`execFederationOp(op, ...)` in the EBT v7.4.2 pattern — but attempting
that BEFORE measuring is premature optimization. Ship four distinct
circuits first, measure, merge if forced.

---

## 10. Non-goals (per brief §ACCEPTANCE 6)

This contract explicitly does NOT:

- **Move value.** No `mint`, no `burn`, no `transfer`, no address-of-
  recipient in any circuit signature. I-F.
- **Gate settlement directly.** WI-14 consumes `resolvePath`; the
  registry never calls settlement.
- **Track KYC status.** Membership is the Living Dividend's concern;
  the registry doesn't know who is a person. `operatorId` and `nodeId`
  are opaque `Bytes<32>` identifiers.
- **Do LD accounting.** No `accPerShare`, no per-member claim state,
  no dividend log. Reading a `_dividendMintedLog` shape would be
  wrong-lineage.
- **Compute rates.** The registry stores rate `Uint<64>` values but
  never *decides* what a rate should be. Sanity-band anchoring is a
  federation act (`advanceEpoch`), not a market operation.
- **Rotate governance-tree structure.** Adding / removing nodes to the
  charter tree is the WI-20 ceremony's job; the registry only
  consumes the root.
- **Interpret statutory lanes' correctness.** WI-07 §7 (statute-to-lane
  ceremony) verifies the statute→rateBps translation. The registry
  merely stores the `laneKindByte` and enforces sum-to-10000.

---

## 11. Toolchain gap and forward path

**Current build target:** compactc 0.30.0 (per Garrett's 2026-07-14
written call). Compiles on Kenya at `/home/pollpower/.compact/bin/compactc`.

**Plan §0.2 pin:** compactc 0.31.0.

**Gap analysis to be done post-compile:**
- What syntax / stdlib changes 0.31.0 introduces (MIP-0002 event *writer*
  side is the known-newest item, and the registry does not use it — the
  ledger-Map event pattern is 0.30.0-compatible).
- Whether any 0.31.0 optimizations would shrink circuit weight enough
  to matter (block-weight-fit is the main risk axis).
- Whether the ecosystem expects to be on 0.31.0 by mainnet (LD v2.2.2
  built with 0.30.0; deploy runbook says the whole stack recompiles
  on the version cut).

**Recommendation:** ship WI-13 on 0.30.0. Open a follow-up work item
(WI-13.1?) to re-target to 0.31.0 as a single, coordinated version
bump across the whole `contracts/` tree, before mainnet cutover. Same
pattern the 0.15 → 0.22 language-version bumps followed.

**Not this session's job.** Recorded here so it's not lost.

---

## 12. Test plan (offline smoke suite → `tests/`)

Full mapping brief §REQUIRED TESTS + memo-added negatives:

| Test | Brief? | Coverage |
|------|--------|----------|
| T1 | ✓ | Happy path: charter → register → resolve → retune within bounds → resolve again |
| T2 | ✓ | I-A negative: register with unchartered nodeId → REVERT `SCHEDULE_UNCHARTERED_NODE` |
| T3 | ✓ | I-B floor negatives: LD floor breach, ops floor breach, statutory-total breach (all revert) |
| **T3.5** | memo §3 | Sanity-band retune negative: retune whose implied producer take (`producerBps * rate / 10000`) leaves the ±20% band → REVERT `RETUNE_VIOLATES_SANITY_BAND` |
| T4 | ✓ | I-D replay: same federationApproval twice → second REVERTs `FEDERATION_APPROVAL_REPLAYED` |
| T5 | ✓ | I-D forgery: federationApproval signed by non-seat key → REVERT `FEDERATION_APPROVAL_INVALID` |
| **F-4** | memo §3 | Second wrong-seat negative: federationApproval signed by a REAL seat that is NOT the seat named in `federationSeatId` → REVERT (independent of T5's fake-key case) |
| T6 | ✓ | Epoch retirement: retire at e, resolve at e-1 works, resolve at e+1 REVERTs `RESOLVE_EPOCH_OUT_OF_RANGE` |
| **F-7a** | memo §3 | Epoch decrement negative: attempt to `advanceEpoch` with `newEpoch < currentEpoch` → REVERT `EPOCH_ADVANCE_NOT_PLUS_ONE` |
| **F-7b** | memo §3 | Unauthorised advance: `advanceEpoch` without valid federationApproval → REVERT `FEDERATION_APPROVAL_INVALID` |
| T7 | ✓ | Property test: 1000 random valid schedules × random paths, `sum == 10000` always holds |

Additional supporting tests:

- **R-A test:** `charter_membership_proof` witness returns a valid proof
  for a chartered node → PASS. Returns a proof against a different
  root (post-`advanceEpoch` where governanceRoot rotated) → REVERT.
  This is the "prover can't forge a truthy witness" test.
- **R-B test:** same operator signs a retune for schedule A at epoch
  e; attacker submits it against schedule B at epoch e → REVERT
  `RETUNE_NONCE_MISMATCH` (because the compound nonce key differs).
- **R-C test:** `resolvePath(scheduleId, path, epoch=MAX_UINT64)` →
  REVERT `RESOLVE_EPOCH_OUT_OF_RANGE`.

---

## 13. Adversarial pre-read summary (from the executing-session PR body)

For BIG review's convenience, the three failure modes flagged before
implementation began, with their structural fixes:

- **R-A (charter-existence witness under-specified)** → fixed by §4.1:
  witness returns a `CharterProof` structure, not a Boolean; circuit
  re-hashes the Merkle path against `_governanceRoot`. Prover cannot
  return "true" for an unchartered node.
- **R-B (retune nonce scoping too coarse)** → fixed by §4.4 step 3
  and the `_retuneNonces` map keyed by `hash(operatorId, scheduleId,
  currentEpoch)`. Signed retunes cannot be replayed across schedules
  or epochs.
- **R-C (`resolvePath` as historical-oracle)** → fixed by §4.5's
  two-path split: `resolvePath(epoch)` enforces
  `[effectiveEpoch, retiredEpoch) ∩ [0, _currentEpoch]`;
  `resolveCurrent()` hardcodes the current epoch for settlement.
  WI-14 uses `resolveCurrent`; audit tooling uses `resolvePath` with
  hard bounds.

F-1..F-8 from the supervising session's memo are ALSO in force,
orthogonally.

---

## 14. Second-BIG-pass review checklist

Per memo §5 / brief §ACCEPTANCE 4, this contract requires a second
independent BIG review with no shared context, focused on:

- **I-A (§4.1, §4.2 step 3):** verify the charter-proof mechanism
  cannot be short-circuited by any witness that produces a "truthy"
  short answer. Read `charter_membership_proof` and every callsite of
  `_governanceRoot`.
- **I-D (§4.2 steps 7–8; all federation-gated circuits):** verify the
  domain tag `pp:msfed:v1:approve:fed` matches
  `multisig-federated-v1.compact` L211–L213 BYTE-FOR-BYTE. Any drift
  breaks cross-lineage signature verification.
- **F-6 (§4.4):** verify `retuneClass` has NO federation-approval
  check anywhere in its call path. If a helper is added later, it
  cannot silently pull in a federation check.
- **I-F (§10):** grep the contract for `mint`, `burn`, `transfer`,
  `send`, `receive`, `UserAddress` in a mutation context. Should
  find zero.

---

## 15. Deploy status

**DEV DRAFT — not deployed, not audited.** This section will be
updated when:
1. First independent BIG review passes.
2. Full-ZK compile transcript from Kenya (compactc 0.30.0) attached to
   PR.
3. Offline smoke suite (T1..T7 + memo-added negatives + R-A/R-B/R-C
   tests) all green.
4. Garrett signs off on the merge.

Only THEN does the contract move from DEV DRAFT to STAGED. Deploy
itself is a separate ceremony (plan §5.1).

---

*Design draft — 2026-07-14. Target: compactc 0.30.0. WI-13 of the
Federation Implementation Plan. No contract code lives in this
document; see `tariff-registry-v1.compact` for the implementation.*
