# WI-14 — EBT vNext (settle circuit) — Dispatch Brief v2

**SUPERSEDES:** [`dispatch-briefs/WI-14-EBT-vNext.md`](WI-14-EBT-vNext.md) (dated 2026-07-14).

**Revision date:** 2026-07-17 (JST).

**Revision reason:** drift analysis on 2026-07-17 (see workspace memory
`memory/2026-07-17.md`) found nine discrepancies between the v1 brief
and `tariff-registry/V1.1-DESIGN.md §7` (§7 is the WI-14 handoff section;
titled "Handoff to WI-14 (settle circuit consumer)"; also referred to
as §A7 in some notes — same section) which became the spec-of-record
after WI-13.1 landed on `main` at `065eb96`. This v2 resolves all nine
items. Item #1 (read-pattern architectural gate — cross-contract call
vs. mirror vs. shared module) was decided by Garrett on 2026-07-17:
**option (b) Registry-mirror inside EBT**. EBT declares its own
`_registeredLanesMirror` field; the keeper writes to it from
TariffRegistry events; the WI-14 settle circuit reads the mirror
in-circuit. TariffRegistry remains independently deployable.

**Status:** dispatch-ready as spec-of-record for the WI-14 settle-circuit
design pass. Design pass to produce `ebt/VNEXT-DESIGN.md` reading against
this v2 brief.

**v1 preserved for adversarial diff.** Do not delete or edit v1. v2 is
the current spec; v1 is the audit trail.

---

**Status:** Dispatch brief. Written for a supervising BIG session at
dispatch time — NOT to be executed by the drafting session.
**Class:** 💰 **touches-funds**, settlement contract change. Highest-risk
item in the whole federation plan.
**Exec permission:** **BIG only.** Two independent BIG passes required
(§5.1 💰 row). No `--skip-zk`. No shortcuts. Ceremony required at deploy.
**Depends on merged:** WI-01 (escrow design), WI-02 (clearinghouse),
WI-03 (fungibility stance — folded into D-10), WI-06 (schedule model),
WI-07 (statutory lanes), WI-13 (TariffRegistry contract), **WI-13.1**
(TariffRegistry statutory-lane records — merged in PR #32 as
`065eb96`). WI-13.1 must be compiled and DEV-DRAFT-stable before this
brief is dispatched (it is, as of 2026-07-17).
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
   settle-time; sum-to-10000 invariant. §A2 `StatutoryLane` schema is
   the source of truth for the mirrored `LaneRecord` fields (see §KEEPER
   MIRROR CONTRACT below).
6. **`tariff-registry/V1.1-DESIGN.md §7` — authoritative WI-14 handoff
   spec of record.** `V1-DESIGN.md` is the WI-13 pre-lanes design and
   remains in the repo for historical reference only; do not read it as
   the spec-of-record for WI-14. §7 defines the three MUST-enforce
   acceptance criteria (§7.4 AC-1/AC-2/AC-3), the zero-record sentinel
   discriminator rule (§7.3), the keeper's cache-invalidation discipline
   (§7.1), and the deduplication rule (§7.2). This v2 brief carries the
   same content into WI-14's spec surface; where the two documents
   diverge, **V1.1-DESIGN.md §7 wins** and this brief must be corrected.
7. `tariff-registry/tariff-registry-v1.compact` (already merged; contains
   the WI-13.1 additive amendment). Verify these exports exist as
   claimed:
   - `resolveLanes` — line 1280 (bounded batch view returning
     `Vector<4, LaneRecord>`)
   - `isLaneActive` — line 1322 (canonical liveness oracle)
   - `_registeredLanes: Map<Bytes<32>, LaneRecord>` — line 265
   - `_classEntries` with `ClassEntry.bps.statutoryTotalBps: Uint<16>`
     — struct field at line 158; ClassEntry declaration around line
     166
   - `emitAction` kind 1 `LANE_REGISTERED` (line 918 region) and kind 7
     `LANE_RETIRED` (line 991 region) — mirror cache-invalidation
     triggers
8. `ebt/ebt-v7.4.2.compact` — **the production baseline this contract
   forks from.** Read the entire file. Understand `settle`, `attest`,
   `reissue`, HAT payload construction (line ~563), the LD binding, the
   claim/claimSplit path, `_dividendMintedLog` shape.
9. `ebt/V7-DESIGN.md` + `ebt/V7.1-EVENT-DIFF.md` — v7 design lineage.
10. `memory/2026-07-07-audit-findings.md` (or wherever it lives) — Wave 1
    finding **EBT-H-1** (producerAddr not in HAT signed payload,
    mint-redirection). Any vNext MUST fix this by construction, not just
    inherit v7.4.2's status quo.
11. `memory/2026-07-17.md` — this v2 brief's drift analysis and Garrett's
    Registry-mirror decision. Reference material for reviewers who need
    to understand why v2 exists.
12. `memory/reference-architecture.md` — pilot invariants I-1 (1 EBT =
    1 kWh) and I-2 (mint-after-payment).

---

## DELIVERABLE (exact paths, format)

- `ebt/ebt-vNext.compact` — the new lineage. Version string per naming
  convention set by the supervising session at dispatch (e.g. `v8` if the
  break is total; `v7.5` if it is strictly additive — the supervising
  session decides after reading the diff).
- `ebt/VNEXT-DESIGN.md` — full design doc: circuits, ledger fields,
  event shapes, invariants (I-1..I-3 preserved, new I-14-A..I-14-K
  below added), non-goals, migration story from v7.4.2. Design doc
  MUST explicitly restate the Registry-mirror pattern from §KEEPER
  MIRROR CONTRACT below, including the mirror-key derivation and the
  mirror-freshness verification approach (see §7 open items — the
  specific mechanism is a design-pass output).
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

### B. Multi-lane split resolution (against registered schedule) — via Registry-mirror

`settle` no longer takes a single `producerAddr`; it takes
`(scheduleId, classPath, epoch)` and resolves splits from the WI-13.1
statutory-lane registry state. The circuit MUST verify the resolved
splits sum to exactly 10000 bps (I-14-C below) and mint separate outputs
per lane.

**Read-pattern resolution (Garrett, 2026-07-17): option (b)
Registry-mirror inside EBT.** WI-14's EBT contract declares its own
mirror ledger fields:

- `_registeredLanesMirror: Map<Bytes<32>, LaneRecord>` — same key
  derivation as TariffRegistry's `_registeredLanes` (`persistentHash`
  over `(scheduleId, laneKindByte, ...)` per V1.1-DESIGN.md §2.3
  `laneKey` helper — the design pass must lift the exact derivation
  from that section, byte-for-byte, into vNext).
- `_classStatutoryTotalBpsMirror: Map<Bytes<32>, Uint<16>>` — keyed by
  `hash(scheduleId, classPath)`. Mirrors the `statutoryTotalBps` field
  on `ClassEntry.bps` (WI-13 `_classEntries`). Required for I-14-K
  (statutory-lane sum backstop; see below) since `resolveLanes` alone
  does not carry the schedule's declared aggregate.
- `_scheduleLiveMirror: Map<Bytes<32>, Bool>` — keyed by `scheduleId`.
  Mirrors `isScheduleActive(scheduleId)` on the registry. Required
  because the four-part liveness predicate (§LIVENESS PREDICATE) needs
  the parent schedule's live-status in-circuit and there is no
  cross-contract call to poll it.

The mirror is keeper-fed via `TariffRegistry.emitAction` events of kinds
`1 LANE_REGISTERED` and `7 LANE_RETIRED` (mirror-update signals for
lane state) plus the WI-13 schedule-lifecycle event kinds
(`SCHEDULE_REGISTERED`, `SCHEDULE_RETIRED`; mirror-update signals for
`_scheduleLiveMirror`). The keeper submits explicit mirror-write
circuits on EBT that carry witness proofs of registry state; the EBT
circuits verify those proofs before writing the mirror. **The mirror is
untrusted keeper input until proven against registry state**; the
specific verification mechanism (per-write witness proof of registry
map membership, or a batched `statutoryLanesRoot`-style commitment on
the registry side, or another approach) is a design-pass decision (see
§KEEPER MIRROR CONTRACT below and §7 open items).

The WI-14 settle circuit reads the three mirror maps in-circuit —
same-contract read, no cross-contract call. TariffRegistry remains
independently deployable; WI-14 vNext can upgrade without disturbing
the registry's federation-approved lane state.

### C. Statutory-lane routing (WI-07)

Lanes with `laneKind == STATUTORY_*` route to their designated
`remitAddress` per WI-07's per-class applicability rules **when
`remittanceMode == 1` (on-chain remit)**. The routing is inside the
circuit, not a keeper trust point — a statutory on-chain-remit lane
whose `remitAddress` is zero MUST fail settle with error label
`LANE_REMIT_ADDR_ZERO_ON_CHAIN`; see I-14-D below.

Lanes with `remittanceMode == 0` (fiat-door) may legitimately register
with `remitAddress == 0` as an off-chain marker and MUST NOT trip the
guard.

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

## KEEPER MIRROR CONTRACT (new in v2 — normative)

Per the read-pattern resolution above (option (b) Registry-mirror inside
EBT), the WI-14 settle circuit is a **same-contract read of a mirror
map**, never a cross-contract call to TariffRegistry. This section
enumerates the mirror contract that the design pass must formalize.

### Trigger events (from TariffRegistry)

The mirror is invalidated / updated in response to these
`emitAction` action-kinds emitted by `tariff-registry-v1.compact`:

| Kind | Name              | Mirror update needed                                                     |
|------|-------------------|--------------------------------------------------------------------------|
| 1    | `LANE_REGISTERED` | Add / overwrite entry in `_registeredLanesMirror` for `laneKey`          |
| 7    | `LANE_RETIRED`    | Overwrite entry in `_registeredLanesMirror` with `retiredEpoch != 0`     |
| —    | `SCHEDULE_REGISTERED` (WI-13 kind — confirm at design pass) | `_scheduleLiveMirror[scheduleId] = true`; mirror `_classStatutoryTotalBpsMirror` for each class |
| —    | `SCHEDULE_RETIRED` (WI-13 kind — confirm at design pass)    | `_scheduleLiveMirror[scheduleId] = false`                              |
| —    | `retuneClass` action-kind (WI-13 kind — confirm at design pass) | Overwrite `_classStatutoryTotalBpsMirror[hash(scheduleId, classPath)]` |

Per V1.1-DESIGN.md §7.1: `_actionLog` entries carry only
`{ scheduleId, nodeId, actionHash, epoch, currentTime }`; the
`actionHash` is a non-invertible commitment. Events therefore serve as
**cache-invalidation signals only** — the keeper's off-chain indexer
must re-scan registry map state (via read-only calls to
`resolveLane` / `resolveLanes` / `isLaneActive` / read of
`_classEntries` and `_registeredSchedules` from indexer-level state)
to reconstruct the fields it will then write into the EBT mirror.

### Trust boundary

Mirror state is untrusted keeper input. Each mirror-write EBT circuit
(names TBD at design pass — e.g. `mirrorRegisterLane`,
`mirrorRetireLane`, `mirrorScheduleLifecycle`,
`mirrorClassStatutoryTotal`) MUST carry a witness proof against the
authoritative registry state at some referenced height, and MUST verify
that proof in-circuit before touching the mirror. The specific
verification mechanism is a design-pass output — options include:

- **Per-write witness against registry map membership**: keeper
  supplies the `LaneRecord` plus a Merkle/hash proof of its inclusion
  in `TariffRegistry._registeredLanes` at height H. EBT verifies the
  proof against a `registryStateRoot` committed on-chain (requires
  TariffRegistry to expose a root — a one-field additive amendment to
  WI-13.1 if it doesn't already).
- **Attestation from a federation-signed registry-mirror committee**:
  keeper carries a threshold signature over the mirrored state; EBT
  verifies the multisig.
- **Registry-side event commitment (mini-diff to WI-13.1)**:
  TariffRegistry extends `emitAction` for kinds 1 and 7 (and the
  schedule-lifecycle kinds) to include the full `LaneRecord` payload
  (or its `persistentHash`) so the keeper's mirror-write EBT circuit
  can verify against the event stream directly. Requires a WI-13.1
  amendment (potentially blocked on a WI-13.2).

**Design-pass MUST resolve this before the vNext PR opens.** Placeholder
until then: assume the per-write witness pattern; note the
`registryStateRoot` requirement on TariffRegistry as an open item.

### Failure mode: stale keeper

Any settle whose lane resolution reads a `_registeredLanesMirror` entry
that fails verification against a fresh challenge (e.g. mirror-write
circuit hasn't been called since the last `LANE_RETIRED` event) MUST
fail with error label `LANE_MIRROR_STALE`. The specific staleness check
is design-pass output.

### `isLaneActive` as canonical liveness oracle

V1.1-DESIGN.md §7 (step 4) and the WI-13.1 §2.8 circuit both designate
`isLaneActive(scheduleId, laneKindByte)` as the canonical liveness
oracle for the four-part predicate below. WI-14's settle circuit MAY
replicate the predicate slot-by-slot in-line (since the mirror carries
the raw fields) or MAY define a same-signature EBT-side helper reading
the mirror; both are permitted. The design pass MUST pick one and
justify. Whichever is chosen, it MUST produce byte-identical liveness
results to `isLaneActive` reading the registry directly at the same
epoch.

---

## INVARIANT DISCRIMINATOR & LIVENESS RULES (new in v2 — normative)

Per V1.1-DESIGN.md §7.3 (zero-record sentinel) and §7 step 4
(populated-vs-live predicate).

### Zero-record sentinel discriminator rule

The only sound discriminator for a real vs. empty `LaneRecord` slot is:

```
rec.scheduleId != Bytes<32>::zero()
```

DO NOT use any of the following as discriminator — every one can
legitimately be zero on a real record:

- `bpsShare == 0` — an informational lane may register with zero bps.
- `laneKindByte == 0` — kind 0 is VAT (Kenya statutory stack); a
  legitimate real record.
- `remitAddress == 0` — legitimate under `remittanceMode == 0`
  (fiat-door marker).
- `retiredEpoch == 0` — legitimate on a live lane; retired lanes carry
  non-zero.
- `basis == 0`, `remittanceMode == 0` — routine values on real
  records.

All slot-iteration circuits in vNext MUST use `scheduleId != zero` as
the populated-slot predicate. Fail-closed default: unfilled
`resolveLanes` slots per V1.1-DESIGN.md §7.3 return `LaneRecord` with
all fields zero; those slots contribute nothing to routing, sum
invariants, or liveness checks.

### Liveness predicate (four-part)

A `LaneRecord` slot is LIVE when **all four** hold:

1. `rec.scheduleId != Bytes<32>::zero()` — populated slot (per
   discriminator above).
2. `rec.retiredEpoch == 0 || rec.retiredEpoch > currentEpoch` — not
   retired.
3. `rec.effectiveEpoch <= currentEpoch` — effective now.
4. `_scheduleLiveMirror[rec.scheduleId] == true` — parent schedule
   still live. Mirrors WI-13.1 `isScheduleActive` (parent-liveness
   check equivalent to reading `_registeredSchedules.member` +
   `retiredEpoch == 0` on the registry side; see V1.1-DESIGN.md §7
   step 4 and I-13.1-K).

The settle circuit MAY replicate this predicate slot-by-slot in-line
(against the mirror's raw fields), or MAY expose a same-signature
`isLaneActive`-equivalent helper reading the mirror. Both are
permitted; the design pass picks one.

---

## INVARIANTS THAT MUST HOLD (checkable statements)

All v7.4.2 invariants (I-1 1 EBT = 1 kWh, I-2 mint-after-payment, I-3
attest / reissue / settle preconditions) are preserved. Additionally
(v1 invariants I-14-A..I-14-H preserved; three new invariants added in
v2 as I-14-I / I-14-J / I-14-K per V1.1-DESIGN.md §7.4 and §7.2):

**I-14-A (mint-redirection fixed by construction):** the HAT signed
payload includes `producerAddr` (or an in-circuit binding
`producerAddr == addressFromKey(producerKey)`). No path exists by which
`settle` mints to an address not in the signed payload. This is a bug
fix, not an addition — v7.4.2's payload is insufficient (see EBT-H-1).

**I-14-B (schedule-path enforcement):** every successful `settle` cites a
`(scheduleId, classPath, epoch)` that resolves in the
`_registeredLanesMirror` (and `_scheduleLiveMirror` for the parent
schedule) AND is not a retired schedule at that epoch. No free-form
splits.

**I-14-C (whole-class 10000 bps preserved):** the whole-class split
(LD + ops + statutory lanes) MUST sum to exactly 10000 bps. This is a
whole-class invariant preserved by WI-13's `retuneClass` at
schedule-registration time; vNext relies on it via the
`_classStatutoryTotalBpsMirror` field for its own sum check (see
I-14-K). Note: I-14-C in v1 conflated the whole-class check with the
statutory sub-total check; v2 separates the two — I-14-C is the
whole-class ceremony invariant (upstream), I-14-K is the settle-time
statutory sub-total backstop (downstream). Both must hold.

**I-14-D (STATUTORY lane remittance address, on-chain-remit only):** for
each resolved lane `L` in the settle circuit with
`L.remittanceMode == 1` (on-chain remit), `L.remitAddress` MUST be
non-zero. Settle MUST fail with error label
`LANE_REMIT_ADDR_ZERO_ON_CHAIN` when the check fails. Fiat-door lanes
(`L.remittanceMode == 0`) MAY have `L.remitAddress == 0` as a
legitimate off-chain marker; those slots MUST NOT trip the guard.
Silent pooling of statutory amounts into ops is a security bug.
Corresponds to V1.1-DESIGN.md §7.4 AC-1.

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

**I-14-I (SCHEDULE_LANE_OVERFLOW + recovery paths — new in v2):** the
mirror-read lane vector has fixed width `Vector<4>` (matching
V1.1-DESIGN.md §7 request-vector width and §2.0 no-per-schedule-cap
posture on the registry side). If a schedule's live statutory-lane
count exceeds 4 slots (i.e. the keeper's off-chain enumeration finds
more than 4 live lanes on the schedule about to be settled — see
V1.1-DESIGN.md §7 step 1), settle MUST fail with error label
`SCHEDULE_LANE_OVERFLOW`. Recovery paths (both federation-gated per
WI-13.1 governance; per V1.1-DESIGN.md §7.4 AC-3):
- **(a) Retire-and-replace within capacity.** Retire a
  lower-priority live lane on the affected schedule via `retireLane`,
  then register the new statutory lane, keeping the live-lane count
  ≤ 4. Preferred whenever at least one existing lane is
  discretionary.
- **(b) Reschedule.** If all existing lanes are statutory-mandatory
  and none can be retired, retire the entire schedule via
  `retireSchedule` and register a fresh `scheduleId` carrying the
  updated lane set. Option (b) additionally requires WI-14 keeper
  re-pointing to the new `scheduleId` and re-warming the mirror; this
  operational cost MUST be documented and scheduled before option
  (b) is invoked.
Neither path can be initiated by WI-14 — schedule-lifecycle governance
is WI-13's responsibility.

**I-14-J (keeper deduplication — new in v2):** the keeper MAY pass the
same `(leviedBy, laneKindByte)` pair twice into the mirror-request
vector, and `resolveLanes` (and by extension the mirror) will return
the same `LaneRecord` twice (both slots hit the same `laneKey`). Naive
summation would double-route remittances. The settle circuit is
responsible for deduplicating the returned vector on
`(scheduleId, laneKindByte)` (equivalently: on `laneKey`) before
enumerating remittance destinations. Settle MUST NOT trust the keeper
to pre-deduplicate. Settle MUST fail with error label `LANE_DUP_KEY`
on detected duplicates rather than silently coalescing them (the
loud-fail posture surfaces keeper misbehavior; a silent coalesce
would mask a keeper mis-enumeration bug). Corresponds to
V1.1-DESIGN.md §7.2.

**I-14-K (statutory lane sum invariant — new in v2):** `sum(bpsShare_i
for populated live statutory lane slots)` — enumerated over the
mirror-read `LaneRecord` vector, filtered by the four-part liveness
predicate — MUST equal
`_classStatutoryTotalBpsMirror[hash(scheduleId, classPath)]`. This is
a settle-time keeper-honesty check against under-enumeration (a
dropped lane makes the sum too low) or duplication that survives
I-14-J (a duplicate that inflates the total). Settle MUST fail with
error label `LANE_SUM_MISMATCH` when the check fails. This is the
STRONG BACKSTOP against keeper mis-enumeration; I-14-C is the
upstream whole-class ceremony invariant preserved at
schedule-registration time. Corresponds to V1.1-DESIGN.md §7.4 AC-2.

**Standing (Compact discipline, §0.2):** no contract-to-contract calls
(Registry-mirror pattern only — see §KEEPER MIRROR CONTRACT), no
integer `/` or `%` in-circuit (witness-computed divmod +
`checkedDivide` verify — critical for split math), no `<`/`<=` on
`Field`, all sealed fields in `constructor()`, `disclose()` on every
witness → ledger path.

---

## ERROR LABELS (normative, alphabetical)

Enumerated so tests can assert exact labels. Each label maps to the
invariant it guards; each MUST appear verbatim in the circuit's assert
messages.

| Label                            | Guards            | Where fired                                                    |
|----------------------------------|-------------------|----------------------------------------------------------------|
| `LANE_DUP_KEY`                   | I-14-J            | Duplicate `(scheduleId, laneKindByte)` in mirror-read vector.  |
| `LANE_MIRROR_STALE`              | Mirror discipline | Mirror entry fails freshness check against latest registry event. |
| `LANE_REMIT_ADDR_ZERO_ON_CHAIN`  | I-14-D            | On-chain-remit (`mode==1`) lane with `remitAddress == 0`.      |
| `LANE_SUM_MISMATCH`              | I-14-K            | Statutory sum ≠ `_classStatutoryTotalBpsMirror` value.         |
| `SCHEDULE_LANE_OVERFLOW`         | I-14-I            | Mirror-read enumeration returns > 4 live statutory lanes.      |
| *(v7.4.2 labels preserved; v1 EBT-H-1 label at design pass)* | I-14-A | HAT payload mismatch — exact label design-pass choice.         |

The design pass MUST NOT rename any of the labels above; test suites
will pin against these exact strings.

---

## ACCEPTANCE CRITERIA (what BIG review will check)

1. Clean full-ZK compile on compactc 0.30.0 (WI-13 landed on 0.30.0;
   0.31.0 pin is deferred per 2026-07-16 environment note), zero
   warnings, transcript in PR body.
2. All REQUIRED TESTS pass in the offline suite, including the
   negatives.
3. **Two independent BIG passes** (different sessions, no shared
   context) sign off on I-14-A (mint-redirection), I-14-D (statutory
   routing), I-14-F (solvency guard), I-14-I (overflow recovery
   posture), and I-14-K (sum backstop). §5.1 💰 row.
4. Adversarial pre-read documented in PR: "worst compliant
   implementation of this brief?" — answered before code was written.
5. Cross-brief consistency check: WI-14's assumed WI-13.1 interface
   (mirror-key derivation, event kinds 1 / 7 + schedule kinds, sentinel
   discriminator, four-part liveness predicate) matches WI-13.1's
   actual exports at commit `065eb96` (or successor if WI-13.2 lands
   first). Record commit hash reviewed against.
6. Registry-mirror freshness mechanism resolved in `VNEXT-DESIGN.md`
   (per-write witness, federation attestation, or registry-side event
   commitment). Whichever is chosen, `LANE_MIRROR_STALE` MUST be a
   real check, not a placeholder.
7. Migration story in `VNEXT-MIGRATION.md` explicitly addressed by
   Garrett + supervising session BEFORE ceremony.
8. Ceremony plan attached: keyholders, order of operations, rollback
   posture. No deploy without a written ceremony plan.

---

## REQUIRED TESTS (offline smoke suite)

Each test lives in `ebt/tests/`, TypeScript, deterministic, no
network. v1 tests T1–T12 preserved; v2 adds T13–T18 covering the new
invariants.

**Positives:**
1. **T1 — end-to-end happy path:** register schedule + lanes (mock
   registry events); mirror-write EBT circuits carry the state into
   `_registeredLanesMirror` / `_classStatutoryTotalBpsMirror` /
   `_scheduleLiveMirror`; attest → settle with (scheduleId, classPath,
   epoch) → mint splits across LD, ops, statutory lane → sum to input
   kWh × 10000 bps exactly → LD `bumpOnMint` fires.
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
   Mirror has no entry for the scheduleId.
6. **T6 — I-14-B: settle against retired schedule at post-retirement
   epoch fails.** Mirror `_scheduleLiveMirror` set to `false` via a
   `SCHEDULE_RETIRED` mirror-write.
7. **T7 — I-14-K: crafted splits that sum to 9999 or 10001 fail with
   `LANE_SUM_MISMATCH`.** Property test at 1000 random split vectors.
   (v1's T7 targeted the fused whole-class-plus-statutory sum; v2
   retargets to the statutory sub-total per I-14-K separation.)
8. **T8 — I-14-D: on-chain-remit (`mode==1`) statutory lane with
   `remitAddress == 0` fails with `LANE_REMIT_ADDR_ZERO_ON_CHAIN`.**
   Does not silently pool into ops. Confirm the fiat-door
   (`mode==0`, `remitAddress==0`) sibling case does NOT trip the
   guard.
9. **T9 — I-14-F: redeem that would violate solvency fails.** Simulate
   trust float at boundary + one satoshi over.
10. **T10 — I-14-G: de-federated operator cannot start new settle.**
    In-flight settle at same operator + fresh attestation completes.
11. **T11 — I-14-H: LD `_dividendMintedLog` shape matches v7.4.2 for
    identical mint inputs.** Regression guard for the LD keeper's
    contract-scope filter (Session 9 fix).

**Property tests:**
12. **T12 — random schedules × random splits × random paths, 1000
    runs:** every successful settle satisfies I-14-C, I-14-K, and
    I-14-H simultaneously.

**New in v2:**
13. **T13 — I-14-I: SCHEDULE_LANE_OVERFLOW.** Warm the mirror with 5
    live statutory lanes on a single schedule (via 5 mirror-writes);
    settle attempt reverts with `SCHEDULE_LANE_OVERFLOW`. Confirm the
    same schedule succeeds after a retire-and-replace bringing the
    count back to 4.
14. **T14 — I-14-J: LANE_DUP_KEY.** Craft a mirror-read request vector
    with a duplicate `(leviedBy, laneKindByte)` pair; settle reverts
    with `LANE_DUP_KEY`.
15. **T15 — I-14-K: dropped-lane under-enumeration.** Warm mirror with
    3 live lanes summing to `statutoryTotalBps`; keeper builds a
    request vector omitting one lane; settle reverts with
    `LANE_SUM_MISMATCH`.
16. **T16 — mirror staleness: LANE_MIRROR_STALE.** Warm mirror with a
    live lane; emit a `LANE_RETIRED` event on the registry side but
    DO NOT run the mirror-update circuit; settle reverts with
    `LANE_MIRROR_STALE`. (Test shape depends on the freshness
    mechanism chosen in the design pass; the negative case MUST
    exist regardless.)
17. **T17 — zero-record sentinel discipline.** Warm mirror with 2
    live lanes and 2 zero-slot fillers in the request vector; settle
    succeeds, routes to 2 destinations only, ignores the zero slots.
    Cross-check: mutating a "real record" to have `bpsShare == 0` or
    `remitAddress == 0` under `mode==0` MUST NOT be treated as a
    zero-record sentinel.
18. **T18 — fiat-door + on-chain-remit siblings on same schedule.**
    Mirror carries one lane at `mode==0, remitAddress==0` and one at
    `mode==1, remitAddress=non-zero`; settle succeeds; on-chain lane
    routes to its address; fiat-door lane is enumerated for the sum
    check (I-14-K) but MUST NOT trigger `LANE_REMIT_ADDR_ZERO_ON_CHAIN`
    and MUST NOT attempt on-chain routing.

---

## DO NOT (hard constraints — this contract touches money)

- **DO NOT deploy without a written ceremony plan and Garrett's explicit
  green light.** DEV DRAFT at PR time. Ceremony is a separate item.
- **DO NOT modify `ebt/ebt-v7.4.2.compact`.** Fork to a new file. v7.4.2
  is pilot canon.
- **DO NOT modify `living-dividend/*` or `multisig/*`.** LD binding
  preserved by shape (I-14-H); any real LD change is a separate item.
- **DO NOT introduce a contract-to-contract call from EBT vNext to
  TariffRegistry.** Compact forbids it. Registry-mirror pattern only
  (§KEEPER MIRROR CONTRACT). If the design pass finds itself wanting
  to write a "call resolveLanes on TariffRegistry", stop and
  escalate — the mirror was Garrett's decision on 2026-07-17 and
  reversing it is out of the executing session's scope.
- **DO NOT pool fiat redemption across coins.** D-10 is explicit:
  per-coin `fiatValueAtMint`. Pooling is the pre-D-10 model and is
  wrong.
- **DO NOT silently pool statutory amounts into ops when
  `remitAddress` is missing under `mode==1`.** Fail settle with
  `LANE_REMIT_ADDR_ZERO_ON_CHAIN`. I-14-D is a security invariant, not
  a UX preference.
- **DO NOT trigger the on-chain-remit guard on fiat-door
  (`mode==0`) lanes with `remitAddress == 0`.** Legitimate off-chain
  marker. The guard is mode-conditional (I-14-D).
- **DO NOT use any zero-field-value discriminator other than
  `scheduleId != Bytes<32>::zero()`.** `bpsShare == 0`,
  `laneKindByte == 0`, `remitAddress == 0`, `retiredEpoch == 0` are
  all legitimate on real records (§INVARIANT DISCRIMINATOR RULES).
- **DO NOT silently coalesce duplicate `(leviedBy, laneKindByte)`
  slots.** Fail loudly with `LANE_DUP_KEY` (I-14-J). Silent coalesce
  masks keeper misbehavior.
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
- **DO NOT let the mirror freshness mechanism be a placeholder in the
  merged PR.** The design pass MUST pick one of the enumerated
  options (per-write witness / federation attestation / registry-side
  event commitment) and implement `LANE_MIRROR_STALE` as a real
  check. If none of the three is compatible with WI-13.1 as it stands
  and a WI-13.2 amendment is required, escalate.

---

## CALIBRATION PLACEHOLDERS (Garrett's call, do NOT resolve)

Executing session MUST mark and continue with placeholders:

| CAL | Where used |
|-----|-----------|
| CAL-1 | `LD_FLOOR_BPS`, `OPS_FLOOR_BPS` — resolved via WI-13, referenced here. |
| CAL-2 | Sanity-band width — bounds `fiatValueAtMint` at settle. TODO. |
| CAL-8 | Statute-to-lane ceremony parameters — reference only. |
| CAL-11 | Remittance default (option 1 fiat door vs option 2 on-chain lane) — shapes statutory `remitAddress` semantics AND the mode-conditional I-14-D guard. TODO. |

Any temptation to resolve any of these to make a test pass is an
escalation trigger, not a workaround.

---

## ESCALATION TRIGGERS (stop and comment on the draft PR)

Per plan §5.3 — for 💰 items, the trigger threshold is *lower*, not
higher:
1. Any READ-FIRST file contradicts this brief.
2. Any invariant I-14-A..I-14-K cannot be satisfied as written.
3. The change wants to touch v7.4.2, LD, or multisig.
4. A CAL-n value must be picked.
5. A test can only pass by weakening it OR by using `--skip-zk`.
6. The keeper/event pattern feels like it wants a contract-to-contract
   call from EBT vNext to TariffRegistry (it doesn't; the mirror is
   Garrett's decision, not the executing session's).
7. The mirror freshness mechanism cannot be implemented without a
   WI-13.1 amendment (WI-13.2) — escalate; the design pass does not
   get to invent a WI-13.2.
8. Migration story looks nontrivial. Stop and get Garrett.
9. Any redemption or split path exceeds the safety envelope of the
   escrow's published solvency invariant.
10. V1.1-DESIGN.md §7 and this brief diverge on any acceptance
    criterion (AC-1 / AC-2 / AC-3 map to I-14-D / I-14-K / I-14-I) —
    §7 wins; escalate the brief for correction.

For 💰 items, escalation is cheap; a bad merge is not.

---

## Supervising-session pre-dispatch checklist

- [ ] WI-13 + WI-13.1 have landed on `main` as DEV DRAFT, compile-clean,
  tests passing (verified 2026-07-17: `065eb96` on top of `e5fb5d1`).
- [ ] EBT-H-1 finding read fresh from the 2026-07-07 audit memo; do not
  rely on this brief's summary.
- [ ] V1.1-DESIGN.md §7 read in full and cross-checked against the
  invariant table in §INVARIANTS THAT MUST HOLD above.
- [ ] Two BIG sessions scheduled, staggered, with no shared context on
  the diff — book them BEFORE the executing session starts.
- [ ] Ceremony plan skeleton drafted with Garrett before dispatch, not
  after — the executing session's job is to make the ceremony plan
  fillable, not to invent it.
- [ ] Red-team pass: "worst compliant implementation of this brief?" —
  answered in the dispatch memo, attached to the executing session's
  first message. Include the "keeper who under-enumerates statutory
  lanes to skim" scenario as a concrete pass target — I-14-K is the
  backstop.
- [ ] Confirm compactc 0.30.0 is the executing environment (WI-13
  landed on 0.30.0; 0.31.0 pin deferred).

---

## The one paragraph for Garrett to read before dispatching this

This is the settlement contract. It is the piece where a bug becomes a
lost pilot, a lost trust license, or a lost person's dividend. The
brief above is *long on purpose*: every DO NOT is a specific way this
contract can silently go wrong, drawn from the audit history of the
lineage (EBT-H-1), the constitutional structure of the federation
(D-4, D-5..D-9, D-10), and the WI-13.1 handoff constraints
(V1.1-DESIGN.md §7). If the executing session pushes back on any
constraint here as "unnecessary", that is the moment to switch
sessions, not the moment to relax the brief. The Registry-mirror
pattern (§KEEPER MIRROR CONTRACT) is the load-bearing architectural
decision; if the design pass drifts from it, the whole cross-contract
independence property is lost. The verification loop is the only
thing between spec and disaster.

---

*Dispatch brief v2 authored 2026-07-17, revising the 2026-07-14 v1
brief per drift analysis against `V1.1-DESIGN.md §7` (post-WI-13.1
merge in `065eb96`). This document is spec/policy only; zero
contract code lives here. v1 preserved at
[`WI-14-EBT-vNext.md`](WI-14-EBT-vNext.md) for adversarial diff.*
