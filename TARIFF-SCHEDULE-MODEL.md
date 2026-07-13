# TariffSchedule / SplitPolicy — Data Model & Cascading-Floor Validator Spec

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot. The pilot runs a single operator, a single flat rate, and
the flat `Uint<16>` split already in EBT v7.4.2. Nothing here is on the pilot's
critical path.
**Work item:** WI-06 of [`FEDERATION-IMPLEMENTATION-PLAN.md`](./FEDERATION-IMPLEMENTATION-PLAN.md).
**Formalizes:** [`FEDERATED-TARIFF-ARCHITECTURE.md`](./FEDERATED-TARIFF-ARCHITECTURE.md)
§3 (the tariff tree + `TariffSchedule`/`SplitPolicy` objects), §4 (the
cascading-floor invariant), §7.2 (the national reference band / sanity band),
plus R-3/R-4 (legibility + epoch-bound mutability).
**Blocks:** WI-07 (statutory lanes extend the `SplitPolicy` defined here),
WI-13 (the TariffRegistry contract implements this model), WI-16 (the off-chain
validator tool implements §5's algorithm), WI-17 (the "explain this tariff"
renderer reads this schema).
**Verified against source:** EBT v7.4.2 already carries the flat split as four
`export ledger _bpsProducer/_bpsOperations/_bpsDividend/_bpsDao: Uint<16>`
fields (contract L237–L240) and enforces slice conservation with
`assert(sumAll == amount)` over a `10000 as Field` base (L561–L564). This spec
generalizes that exact discipline from one flat split to a nested tree; it does
**not** invent a new arithmetic model.

## 0. What this document is

The architecture doc says *what* the tariff tree is and *why*. This document
pins the **on-chain data model** (the concrete field types a `TariffRegistry`
contract stores), the **canonical serialization** (so a schedule hashes
identically for everyone), and the **registration-time validator algorithm**
(the every-path × every-floor × sanity-band × applicability check that makes
the constitutional floors structural rather than aspirational).

It is written to be implementable by a contract engineer (WI-13) and an
off-chain tooling author (WI-16) without either having to re-derive intent
from the prose architecture. Where a value is Garrett's call, it is a named
`TODO(calibration)` — this document invents no thresholds.

### 0.1 The one-sentence contract

> A `TariffSchedule` is a company's nested tree of lines-of-business and
> tariff-classes, each line carrying a `SplitPolicy` in basis points; the
> validator accepts the schedule iff **every root-to-leaf path** satisfies
> **every floor cascaded from nation and company**, its split sums to exactly
> 10000 bps, and every class rate sits inside the national sanity band — all
> checked at registration, epoch-bound, never retroactive.

---

## 1. Compact constraints that shape the model

Every modeling choice below is forced by a Compact/`compactc 0.31.0` reality.
An implementer must respect these; they are not stylistic.

- **No contract-to-contract calls.** The TariffRegistry cannot call EBT or the
  multisig at settlement. Consequence: the validator runs **at registration**
  and commits a verdict on-chain; settlement (WI-14) reads a pre-validated,
  epoch-versioned schedule, it does not re-validate live. This is the same
  MIP-0002-shaped separation the LD keeper uses.
- **No integer `/` or `%` in-circuit; `Field` has no `<`/`<=`.** All bps
  comparisons (floor checks, sanity-band checks, sum-to-10000) must use the
  **witness-divmod / checked-cast** pattern already in the LD contract
  (`checkedDivide`) and EBT (`sumAll == amount` equality + `bpsTotal` Field
  base). No floor check may be written as `share >= floor` on `Field`; it is
  written as a checked `Uint` cast that fails at runtime on violation (see
  §5.4).
- **Bounded structures only.** Compact has no unbounded arrays. The tree must
  be **depth- and width-bounded** by compile-time constants
  (`MAX_LINES_PER_COMPANY`, `MAX_CLASSES_PER_LINE`, `MAX_STATUTORY_LANES`),
  which also directly bounds the R-3 fraud/legibility surface. These bounds
  are `TODO(calibration)` (architecture §9 "tariff-tree depth limit").
- **`disclose()` on witness→ledger writes.** Any schedule field that originates
  from a witness (e.g. an off-chain-computed canonical hash) and flows to a
  ledger write needs `disclose()`, exactly as the LD/EBT contracts do.
- **Sealed config needs `constructor()`.** National floors and the reference
  band, if held on the registry, are deploy-time sealed config, not mutable
  ledger, unless a governance setter is explicitly provided (see §6).

---

## 2. The data model

Basis points everywhere: a share is a `Uint<16>` in `[0, 10000]`. This matches
EBT v7.4.2's existing `_bps*` fields and is currency-agnostic (architecture
§7's note: bps floors travel across currency zones with no conversion).

### 2.1 SplitPolicy (attaches at the line level)

```
struct SplitPolicy {
  lineId:            Bytes<32>     // canonical id of the owning line
  producerShareBps:  Uint<16>      // to the generating producer
  ldShareBps:        Uint<16>      // to the Living Dividend pool  (>= cascaded LD floor)
  opsShareBps:       Uint<16>      // to network operations        (>= cascaded ops floor)
  daoShareBps:       Uint<16>      // to the operator's local DAO / treasury
  operatorMarginBps: Uint<16>      // the operator's business cut
  // WI-07 adds: statutoryLanesRoot: Bytes<32> (Merkle root of the lane array)
  // INVARIANT S1: the five shares + total statutory bps == 10000 exactly.
}
```

The sum-to-10000 invariant (S1) is the tree-level generalization of EBT
v7.4.2's `assert(sumAll == amount)`. WI-07 (statutory lanes) is designed to
slot in as a sibling bps contribution; this model reserves a
`statutoryLanesRoot` field so the WI-07 extension is additive, not a schema
break.

### 2.2 TariffClass (the leaf; where a price lives)

```
struct TariffClass {
  classId:          Bytes<32>     // "lifeline", "standard", "peak", ...
  rateFiatPerKwh:   Uint<64>      // the price the customer pays, in minor currency units
                                  //   (e.g. cents/KES-cents) — integer, never a float
  eligibilityRuleHash: Bytes<32>  // commitment to the off-chain eligibility rule
                                  //   (who qualifies); attested off-chain, committed here
  effectiveEpoch:   Uint<64>      // when it activates; never retroactive (I-4)
  // INVARIANT C1: rateFiatPerKwh lies within the national sanity band (§4.3).
  // INVARIANT C2: effectiveEpoch > current epoch at registration (I-4).
}
```

`rateFiatPerKwh` is an **integer in minor currency units** — never a decimal.
This avoids floating point (which Compact does not have) and makes the
sanity-band comparison a pure integer check.

### 2.3 LineOfBusiness

```
struct LineOfBusiness {
  lineId:       Bytes<32>          // "B2C-residential", "B2B-commercial", "agri-irrigation"
  split:        SplitPolicy        // THIS line's split (S1 must hold)
  classCount:   Uint<8>            // number of populated classes (<= MAX_CLASSES_PER_LINE)
  classes:      Vector<MAX_CLASSES_PER_LINE, TariffClass>   // fixed-width; unused slots zeroed
  // INVARIANT LB1: split.lineId == lineId (a split cannot be attached to the wrong line).
}
```

### 2.4 TariffSchedule (the registered object)

```
struct TariffSchedule {
  operatorId:   Bytes<32>          // the company (a governance-tree node id — see §7)
  nationRef:    Bytes<32>          // which national band + floors it lives under
  lineCount:    Uint<8>            // <= MAX_LINES_PER_COMPANY
  lines:        Vector<MAX_LINES_PER_COMPANY, LineOfBusiness>  // fixed-width; unused slots zeroed
  scheduleEpoch: Uint<64>          // the epoch this schedule version takes effect (I-4)
  // INVARIANT TS1: operatorId + nationRef are the SAME node identities used by the
  //   governance-tree charter (WI-20) — the same-tree invariant of the plan §0.2.
}
```

`nationRef` binds a schedule to exactly one national context, from which the
floors and the sanity band are drawn (§4). `operatorId` is a **shared
identity** with the governance tree (plan §0.2 same-tree invariant) — the
validator does not need to resolve it, but WI-13 must ensure it references a
node the federation actually chartered (WI-20).

### 2.5 NationalContext (sealed per-nation config the validator reads)

```
struct NationalContext {
  nationRef:      Bytes<32>
  ldFloorBps:     Uint<16>         // LD_FLOOR_BPS      — TODO(calibration) CAL-1
  opsFloorBps:    Uint<16>         // OPS_FLOOR_BPS     — TODO(calibration) CAL-1
  refRateFiatPerKwh: Uint<64>      // national reference (the band's center)  — CAL-2
  bandLowBps:     Uint<16>         // how far BELOW ref a rate may sit (bps)   — CAL-2
  bandHighBps:    Uint<16>         // how far ABOVE ref a rate may sit (bps)   — CAL-2
  // Company-level higher internal floors, if any, are carried on the company
  //   node and cascaded in §4; they may only tighten, never loosen.
}
```

All five parameters are **`TODO(calibration)`** (architecture §9). The
validator treats them as inputs; it never chooses them.

---

## 3. Canonical serialization

Two honest parties serializing the same schedule MUST produce identical bytes,
so the schedule's commitment hash is deterministic (mirrors the sortition
table's canonical-ordering discipline).

- **Integers:** unsigned, big-endian, fixed-width to the struct's declared type
  (`Uint<16>` → 2 bytes, `Uint<64>` → 8 bytes, `Uint<8>` → 1 byte).
- **`Bytes<32>`:** raw, no framing.
- **Line ordering:** lines sorted ascending by `lineId` bytes (lexicographic,
  total — `lineId` is unique per schedule).
- **Class ordering within a line:** ascending by `classId` bytes.
- **Unused fixed-width slots:** zero-filled and **excluded** from the hash by
  honoring `lineCount`/`classCount` (only populated entries are folded in).
- **Schedule commitment:**
  `scheduleHash = persistentHash(domain="pp:tariff:schedule:v1", <fields in
  declared order, lines then classes in canonical order>)` — using the same
  `persistentHash(Vector<N,Bytes<32>>, ...)` idiom the LD/EBT contracts use for
  their signed payloads. The domain tag `pp:tariff:schedule:v1` is new to this
  lineage and reserved here.

---

## 4. The validator — every path × every floor

The validator is the heart of WI-06. It runs **at registration** and either
accepts the whole schedule or rejects it whole (architecture §4: "a schedule
with any floor-violating leaf is rejected whole"). There is no partial accept.

### 4.1 Inputs

`validate(schedule: TariffSchedule, nation: NationalContext, companyFloors:
CompanyFloors, currentEpoch: Uint<64>) -> accept | reject(reason)`

`companyFloors` carries any higher internal floors the company set on its own
node (architecture §4: "a values-driven co-op may mandate LD ≥ 10%"). If the
company set none, `companyFloors` equals the national floors.

### 4.2 The cascaded floor for a path

For each line, the **effective floor** is the tighter (higher) of the national
and company floor, per lane:

```
effLdFloor  = max(nation.ldFloorBps,  companyFloors.ldFloorBps)
effOpsFloor = max(nation.opsFloorBps, companyFloors.opsFloorBps)
```

Monotone-tighten only (architecture §4): a company floor **below** the national
floor is itself a rejection (`reason = COMPANY_FLOOR_BELOW_NATIONAL`), caught
before per-line checks.

### 4.3 Per-path checks (run for every line, every class)

For **each** line `L` in `schedule.lines[0 .. lineCount-1]`:

1. **Split conservation (S1).** `L.split.{producer+ld+ops+dao+operatorMargin}
   + statutoryTotal == 10000`. Checked as `Field` equality against
   `10000 as Field` (the EBT v7.4.2 pattern), **not** as a `<=`/`>=`.
   Reject `SPLIT_SUM_NE_10000`.
2. **LD floor.** `L.split.ldShareBps >= effLdFloor`. Written as the checked
   cast `(L.split.ldShareBps - effLdFloor) as Uint<16>` — underflows and
   fails at runtime if the share is below the floor (the `checkedDivide`-class
   trick; see §5.4). Reject `LD_FLOOR_VIOLATION`.
3. **Ops floor.** `L.split.opsShareBps >= effOpsFloor`, same checked-cast
   pattern. Reject `OPS_FLOOR_VIOLATION`.
4. **Line/split binding (LB1).** `L.split.lineId == L.lineId`. Reject
   `SPLIT_LINE_MISMATCH`.
5. For **each** class `C` in `L.classes[0 .. classCount-1]`:
   a. **Sanity band (C1).** `C.rateFiatPerKwh` within
      `[ref*(1 - bandLow), ref*(1 + bandHigh)]`. Because there is no float,
      compute band edges in minor units with the witness-divmod pattern:
      `lowEdge  = ref - checkedDivide(ref * bandLowBps, 10000)`,
      `highEdge = ref + checkedDivide(ref * bandHighBps, 10000)`, then assert
      `lowEdge <= C.rateFiatPerKwh <= highEdge` via two checked casts. Reject
      `RATE_OUTSIDE_BAND`.
   b. **Non-retroactivity (C2).** `C.effectiveEpoch > currentEpoch`. Checked
      cast. Reject `EPOCH_RETROACTIVE`.

### 4.4 Accept condition

`accept` iff **every** line and **every** class passes **every** check above.
On accept, the registry commits `scheduleHash` (§3) bound to `scheduleEpoch`;
that commitment is what settlement (WI-14) later resolves a price-path against.

### 4.5 Why registration-time, not settlement-time

No contract-to-contract calls (§1) means settlement cannot call the validator.
Validating once at registration and committing the verdict means settlement is
a cheap read of an already-proven-safe schedule. This also closes R-4
(mutability/replay): the accepted schedule is epoch-versioned and immutable for
its epoch; a new epoch requires a fresh `validate` + commit.

---

## 5. In-circuit realization notes (for WI-13)

Guidance, not a contract. WI-13 owns the actual `.compact`.

### 5.1 Bounded iteration

`MAX_LINES_PER_COMPANY` × `MAX_CLASSES_PER_LINE` is the validator's fixed
iteration count. Every slot is visited; unpopulated slots (beyond
`lineCount`/`classCount`) are skipped by a guard, not by early exit (Compact
circuits do not branch on data-dependent loop bounds). Pick the bounds small
(R-3): a company with 4 lines × 6 classes is 24 leaves, already generous for a
mini-grid.

### 5.2 Floor checks are checked casts, never `Field` comparisons

`Field` has no `<`. Every `>=`/`<=` in §4 is realized as
`(a - b) as Uint<16>` (or `Uint<64>` for rates), which the compiler lowers to a
runtime range check that reverts on underflow. This is the same mechanism
`checkedDivide` uses for `remainder < divisor`.

### 5.3 Sum-to-10000 is Field equality

`(sum of shares as Field) == (10000 as Field)` — exactly EBT v7.4.2 L561–L564.
Equality on `Field` is cheap and total.

### 5.4 The checked-cast idiom (reference)

```
// assert a >= b for Uint<16> a, b:
const _guard = (a - b) as Uint<16>;   // reverts at runtime if a < b (underflow)
// _guard is otherwise unused; its construction IS the assertion.
```

### 5.5 Branch-permission gating (cross-reference, not this item)

*Registering* a new company or a new line is federation-gated (architecture §5:
"branches are permissioned"), using the same 3-of-5 multisig-gated pattern as
ProducerRegistry meter approval. *Retuning a class or a split within the floors*
is permissionless (a leaf operation). This spec defines the validator that runs
on **both** paths; **who is allowed to submit** which operation is WI-13's gate
design + WI-20's charter, not WI-06. This document only guarantees: whatever is
submitted, the floors and band hold or it is rejected.

---

## 6. Governance of the floors and band themselves

The `NationalContext` parameters (§2.5) are federation-governed. Changing
`ldFloorBps`/`opsFloorBps`/band is a **governance-ceremony** operation (the
same class as a multisig setter), epoch-bound like everything else (I-4): a
floor change takes effect at the next epoch and never invalidates schedules
already accepted for the current epoch. Whether the setter lives on the
TariffRegistry or on the federated multisig is WI-13's call; this spec requires
only that (a) it is multisig-gated, (b) it is epoch-delayed, and (c) a
floor **tightening** cannot retroactively reject an already-accepted schedule
mid-epoch — it applies from the next epoch's re-registration.

---

## 7. Same-tree invariant (plan §0.2)

`schedule.operatorId` and `schedule.nationRef` MUST be the identical on-chain
node ids the governance tree uses for that company and nation (WI-20 charters,
WI-13 registry). If the two trees use different identities for the same entity,
the governance floor that a council sets for "company X" and the schedule that
"company X" registers stop referring to the same X — and the constitutional
floor silently stops binding. WI-13's review MUST check this linkage explicitly;
it is the single most important cross-item consistency requirement in the
tariff/governance pair.

---

## 8. Acceptance criteria (for WI-16, the off-chain validator tool, and WI-13)

A conforming validator implementation MUST:

1. Reject any schedule with a floor-violating leaf **whole** (no partial accept).
2. Reject a company floor set below the national floor
   (`COMPANY_FLOOR_BELOW_NATIONAL`).
3. Reject a split whose lanes do not sum to exactly 10000.
4. Reject any class rate outside the sanity band.
5. Reject any class with `effectiveEpoch <= currentEpoch`.
6. Produce a **deterministic** `scheduleHash` (§3) — two implementations agree
   byte-for-byte (the WI-16 tool and the WI-13 contract must match, the same
   two-independent-implementations discipline WI-09/WI-15 established).
7. Name the exact failing `(lineId, classId, reason)` on rejection (R-3
   legibility; feeds WI-17's renderer).

Test-vector obligation (WI-16): at least one fixture per reject reason above,
plus a fully-valid multi-line schedule that accepts, plus a schedule that is
valid under national floors but rejected under a tighter company floor
(proving the cascade).

---

## 9. Open calibration items (Garrett's call — do NOT invent)

| # | Parameter | Section |
|---|-----------|---------|
| CAL-1 | `ldFloorBps`, `opsFloorBps` national defaults | §2.5, §4.2 |
| CAL-2 | `refRateFiatPerKwh`, `bandLowBps`, `bandHighBps` (+ the C-6 indexation rule for the band under inflation) | §2.5, §4.3 |
| DEPTH | `MAX_LINES_PER_COMPANY`, `MAX_CLASSES_PER_LINE`, `MAX_STATUTORY_LANES` | §1, §5.1 |
| GATE | Branch-permission quorum (which federation seat approves a new company/line) | §5.5 |
| C-7 | Lifeline cross-subsidy accounting — where the below-cost gap lands | (deferred; interacts with STATUTORY-LANES §5) |

---

## 10. One sentence

> A company's tariff tree is stored as a bounded nested struct of lines (each
> with a basis-point `SplitPolicy`) and classes (each with an integer rate and
> an effective epoch); a registration-time validator — using the same
> checked-cast and Field-equality arithmetic EBT v7.4.2 already uses — accepts
> the schedule only if every path satisfies every cascaded floor, every split
> sums to 10000, and every rate sits in the national band, committing an
> epoch-versioned deterministic hash that settlement later reads without
> re-validating, because Compact has no contract-to-contract calls.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code. Post-pilot
layer; the pilot's flat EBT v7.4.2 split is untouched. WI-06 of the Federation
Implementation Plan.*
