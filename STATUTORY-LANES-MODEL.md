# StatutoryLane — Data Model Extension & Applicability Validator Spec

**Status:** DESIGN DRAFT — spec only, no contract code. Not deployed, not audited.
**Layer:** Post-pilot. Nothing here is on the pilot's critical path.
**Work item:** WI-07 of [`FEDERATION-IMPLEMENTATION-PLAN.md`](./FEDERATION-IMPLEMENTATION-PLAN.md).
**Extends:** [`TARIFF-SCHEDULE-MODEL.md`](./TARIFF-SCHEDULE-MODEL.md) (WI-06) — the
`SplitPolicy` struct and the registration-time validator this document adds one
lane class and one applicability check to.
**Formalizes:** [`STATUTORY-LANES.md`](./STATUTORY-LANES.md) §2 (the
`statutoryLanes` lane class), §2.2 (per-class applicability), §2.3 (fiat
remittance path), R-3 (statute-to-lane change ceremony).
**Blocks:** WI-13 (TariffRegistry implements this), WI-14 (settlement routes the
statutory share).

## 0. What this document is

WI-06 defined the tariff tree and a validator that enforces the LD/ops floors,
sum-to-10000, and the sanity band. This document adds **government taxation**
to that model as *one new lane class* — deliberately small, because the whole
point of STATUTORY-LANES §2.1 is "one new lane class; zero new architecture."
A statutory lane cascades and is validated by **exactly the same machinery**
as the constitutional floors; it is just sourced from statute instead of the
federation.

It pins: the `StatutoryLane` struct, how it folds into WI-06's `SplitPolicy`
sum-to-10000 invariant, the per-class applicability rule, the two remittance
postures, and the governance ceremony for changing a lane.

### 0.1 The one-sentence contract

> A `StatutoryLane` is a statute-set basis-point lane (VAT / levy / cess / duty)
> that rides in a line's `SplitPolicy` exactly like the constitutional floors,
> is validated at registration by the same every-path check, applies per tariff
> class via an `applicability` rule, and remits atomically at settlement to a
> `remitAddress` — set by statute, never by the operator, epoch-bound and never
> retroactive.

---

## 1. Where it attaches (folding into WI-06)

WI-06 §2.1 reserved a field on `SplitPolicy` for exactly this:

```
// WI-07 adds: statutoryLanesRoot: Bytes<32> (Merkle root of the lane array)
```

WI-07 realizes it. A line's split now carries a bounded array of statutory
lanes plus their root:

```
struct SplitPolicy {          // WI-06 struct, extended
  lineId:            Bytes<32>
  producerShareBps:  Uint<16>
  ldShareBps:        Uint<16>   // >= cascaded LD floor
  opsShareBps:       Uint<16>   // >= cascaded ops floor
  daoShareBps:       Uint<16>
  operatorMarginBps: Uint<16>
  laneCount:         Uint<8>    // <= MAX_STATUTORY_LANES  (WI-06 depth bound)
  statutoryLanes:    Vector<MAX_STATUTORY_LANES, StatutoryLane>  // fixed-width, zero-padded
  statutoryLanesRoot: Bytes<32> // canonical hash of the populated lanes (§4)
}
```

### 1.1 The revised sum-to-10000 invariant (S1')

WI-06 invariant S1 was: five shares sum to 10000. With statutory lanes, S1
becomes **S1'**:

```
producerShareBps + ldShareBps + opsShareBps + daoShareBps
  + operatorMarginBps + (sum of every lane.rateBps) == 10000
```

Still one Field-equality check against `10000 as Field` (WI-06 §5.3 / EBT
v7.4.2 L561–L564). The statutory share is carved out of the same 10000; it is
**not** additional on top. STATUTORY-LANES §2.1: "the mint does not happen
unless the statutory lane is satisfied" — i.e. the tax is part of the split, so
if the lanes don't fit inside 10000 alongside the floors, the schedule is
rejected whole.

### 1.2 Interaction with the floors (the one subtlety)

Statutory lanes and the LD/ops floors **compete for the same 10000**. A line
must satisfy *both* `ldShareBps >= effLdFloor` *and* fit its statutory lanes,
or the operator margin absorbs the squeeze. This is correct and intended: the
constitutional floor and the tax are both non-negotiable claims on the split;
what flexes is the operator's own margin, not the floor and not the tax. The
validator does not arbitrate between them — it simply rejects any split where
all mandatory claims (floors + statute) plus the operator's chosen shares do
not sum to exactly 10000.

---

## 2. The StatutoryLane struct

```
struct StatutoryLane {
  leviedBy:      Bytes<32>    // canonical id of the authority ("KRA","EPRA","REP","WARMA",county-id)
  kind:          Uint<8>      // enum: 0=VAT, 1=levy, 2=cess, 3=duty
  rateBps:       Uint<16>     // set by statute, NOT by the operator
  remitAddress:  Bytes<32>    // authority address, or a licensed remittance escrow (§3)
  basis:         Uint<8>      // enum: what the rate applies to (0=pre-tax energy charge,
                              //   1=full retail price, ... statute-defined)
  applicability: Bytes<32>    // commitment to the per-class applicability rule (§5)
  statuteRefHash: Bytes<32>   // hash of the human-readable enabling-law citation
  effectiveEpoch: Uint<64>    // never retroactive (I-4)
  // INVARIANT SL1: effectiveEpoch > current epoch at registration.
  // INVARIANT SL2: leviedBy is scoped to the schedule's nationRef (§6, boundary B-4).
}
```

Notes:

- **`rateBps` is statute-set.** The operator cannot tune, dodge, or waive it
  (STATUTORY-LANES §2.1). At registration the validator only checks it *fits*
  the split (S1'); it does not check the *value* against statute — that
  correctness is the R-3 statute-to-lane translation ceremony's job (§7), not
  the circuit's. The circuit enforces *presence and conservation*, the ceremony
  enforces *correctness of the number*.
- **`basis` and `kind` are small enums** (`Uint<8>`), not strings — Compact
  favors fixed-width. The human-readable names live in the off-chain renderer
  (WI-17), keyed by enum.
- **`statuteRefHash`** commits the citation so a lane is always traceable to a
  law; the full text lives off-chain (published), the hash pins it.

---

## 3. Remittance — the two postures (STATUTORY-LANES §2.3)

The model supports both; which one applies is a per-lane deployment choice, not
a schema difference:

- **Option 1 — direct fiat remittance (pragmatic default).** The lane's fiat
  share **never mints**; it is carved out at the fiat door and remitted through
  the existing licensed M-Pesa/B2C rails. On-chain, the lane still appears in
  the split (for S1' and audit) but `remitAddress` is a marker, not a
  mint target — the settlement contract (WI-14) routes that slice to the fiat
  door instead of minting EBT to it.
- **Option 2 — on-chain lane + licensed conversion.** The lane accrues on-chain
  to `remitAddress` (full public auditability); a licensed escrow converts to
  fiat on a schedule. `remitAddress` is a real minting target.

The model is identical for both; the **only** difference is how WI-14's
settlement treats the slice (fiat-door vs on-chain mint). This spec records the
distinction as a per-lane `remittanceMode: Uint<8>` (0=fiat-door, 1=on-chain)
so WI-14 can branch on it without a schema change. `TODO(calibration)` CAL-11:
which mode is the default posture.

---

## 4. Canonical serialization of lanes

Same discipline as WI-06 §3:

- Lanes sorted ascending by `leviedBy` bytes, then by `kind` (a levier can have
  multiple lane kinds).
- `statutoryLanesRoot = persistentHash(domain="pp:tariff:statlanes:v1",
  <each populated lane's fields in declared order, canonical order>)`.
- Only `laneCount` populated entries fold in; zero-padded slots excluded.
- Domain tag `pp:tariff:statlanes:v1` reserved here.

The root lets the line's `SplitPolicy` commit its lanes in one 32-byte field
(WI-06's reserved `statutoryLanesRoot`), so the WI-06 schedule hash stays a
fixed-size fold even as lane counts vary.

---

## 5. Per-class applicability (STATUTORY-LANES §2.2)

Tax law is not flat: lifeline/social classes are often VAT-exempt or reduced;
commercial classes are not. The tree expresses this natively because
applicability attaches **where the tree already resolves prices** — at the
tariff class.

The `StatutoryLane.applicability` field commits a rule of the form:

```
applicabilityRule := for each classId (or class-pattern):
                       FULL      (lane applies at rateBps)
                     | REDUCED   (lane applies at a reduced rate, value in the rule)
                     | EXEMPT    (lane does not apply)
```

At registration the validator checks that **every class in the schedule** has a
defined disposition under **every statutory lane** that names it — no class may
be silently un-dispositioned (an un-ruled class is a rejection,
`CLASS_APPLICABILITY_UNDEFINED`). The rule itself is committed as a hash
(off-chain rule, on-chain commitment), the same shape as
`TariffClass.eligibilityRuleHash` in WI-06 — the machinery already exists
(STATUTORY-LANES §2.2: "the same way it checks floors").

**R-4 exemption-gaming note (STATUTORY-LANES R-4):** per-class applicability
creates an incentive to misclassify customers into exempt classes. That is
carried by the same `eligibilityRule` attestation as the tariff class itself;
statutory exemptions raise its stakes but add no new mechanism. Flagged, not
solved here (shared open item with WI-06's C-7 lifeline accounting).

---

## 6. Boundaries — the constitution of the government relationship

These are structural, from STATUTORY-LANES §4 ("a lane and a window, never a
lever"), and the validator/model enforces the ones that are enforceable:

- **B-1 (enforced structurally).** A statutory lane touches **only** its own
  `rateBps` slice. The model gives the authority no field that can alter I-1
  (1 EBT = 1 kWh), I-2 (mint-after-payment), the LD floor, the ops floor, or
  any other participant's shares. There is no "government" field on
  `TariffSchedule`, `TariffClass`, or the floors — by construction the
  authority can only be a `leviedBy` on a lane. This is the code-level
  expression of "you tax the flow; you do not control the pipe."
- **B-4 (enforced: SL2).** A lane is scoped to its schedule's `nationRef`; a
  Kenyan lane cannot touch a Tanzanian settlement. The validator rejects a lane
  whose `leviedBy` scope does not match the schedule's `nationRef`
  (`LANE_NATION_MISMATCH`).
- **B-2, B-3 (out of code scope).** "The protocol is the rail, not the tax
  police" and the aggregation-only privacy posture are operational/policy
  boundaries; the model neither reports individuals nor exposes per-consumption
  data — but that is a property of what the settlement layer chooses to emit
  (WI-14), documented, not a validator check.

---

## 7. The statute-to-lane change ceremony (R-3)

Changing a lane's `rateBps` (a finance-act change) is a **governance-ceremony**
operation, the same class as a floor change (WI-06 §6):

- Multisig-gated (a lane change is a governance action, not a leaf operation —
  it is not the operator's to make).
- **Epoch-delayed** (I-4): the new rate takes effect next epoch, giving
  operators a review window between enactment-on-chain and effect.
- **Published `statuteRefHash`**: the change must cite the enabling law; the
  citation is committed on-chain and published off-chain.

`TODO(calibration)` CAL-8: the ceremony's quorum, review-window length, and
publication requirements (STATUTORY-LANES §7). This spec requires only that the
change is (a) multisig-gated, (b) epoch-delayed, (c) statute-cited.

R-3 fidelity note: translating a finance act into a `rateBps` correctly is a
human act with live-money stakes. The circuit enforces conservation and
epoch-bounding; it cannot enforce that the number matches the statute. That is
the ceremony's responsibility, and why the ceremony demands a published
citation — so the translation is publicly contestable.

---

## 8. Acceptance criteria (for WI-13 and WI-16)

A conforming implementation MUST:

1. Fold statutory lanes into the S1' sum-to-10000 check (lanes + floors +
   operator shares == 10000 exactly).
2. Reject a schedule where floors + statutory lanes alone exceed 10000
   (`MANDATORY_CLAIMS_EXCEED_10000` — the floor+tax are jointly infeasible).
3. Reject a lane with `effectiveEpoch <= currentEpoch` (SL1).
4. Reject a lane whose `leviedBy` scope mismatches `nationRef` (SL2 / B-4).
5. Reject a class left un-dispositioned under a lane that names it
   (`CLASS_APPLICABILITY_UNDEFINED`).
6. Produce a deterministic `statutoryLanesRoot` (§4) — two implementations
   agree byte-for-byte.
7. Carry `remittanceMode` per lane so WI-14 can route fiat-door vs on-chain
   without a schema change.

Test-vector obligation (WI-16): one fixture per reject reason; a valid schedule
with a VAT lane + a REP levy that accepts; a lifeline class EXEMPT from VAT
alongside a commercial class at FULL VAT (proving per-class applicability); a
schedule where floors+tax leave zero operator margin (accepts — margin may be
zero) vs one where they exceed 10000 (rejects).

---

## 9. Open calibration items (Garrett's call — do NOT invent)

| # | Parameter | Section |
|---|-----------|---------|
| CAL-8 | Statute-to-lane ceremony: quorum, review window, publication | §7 |
| CAL-11 | Default remittance posture (option 1 fiat-door vs option 2 on-chain) | §3 |
| — | Which authorities/lanes to model first (KRA VAT + EPRA levy the obvious pair; REP the narrative one) | STATUTORY-LANES §7 |
| R-4/C-7 | Lifeline exemption + cross-subsidy accounting (shared with WI-06) | §5 |

---

## 10. One sentence

> Government taxation enters the tariff model as a single new `StatutoryLane`
> lane class inside WI-06's `SplitPolicy` — statute-set basis points that
> compete with the constitutional floors for the same 10000, validated at
> registration by the same every-path machinery, applied per tariff class via a
> committed applicability rule, scoped to one nation, remitted atomically at
> settlement in whichever of two postures the authority chooses, and changed
> only by an epoch-delayed multisig ceremony that must cite the enabling
> statute — giving the state a lane and a window, never a lever.

---

*DESIGN DRAFT, 2026-07-13. Spec/policy only — zero contract code. Post-pilot
layer. WI-07 of the Federation Implementation Plan; extends WI-06.*
