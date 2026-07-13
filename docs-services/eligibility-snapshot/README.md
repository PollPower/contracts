# eligibility-snapshot — WI-18

> **STATUS: DEV DRAFT — SPEC + REFERENCE SCAFFOLD.**
> Not deployed. Not audited. Not on the pilot's critical path. The pilot
> runs a single operator per cluster; §5.1's cross-operator constraint
> is inert at that scale and this whole service is postbank —
> post-pilot federation layer.

## What this is

The **eligibility snapshot service**: a read-only aggregator that
produces one consistent, `t0`-dated view of each member's
sortition-gate inputs. Its output feeds the sortition table builder
(**WI-15**), whose canonical table + `membershipRoot` is what the
draw auditor and the on-chain rotation (via **WI-10**'s
`membershipRoot`-binding msfed-v1 rev 5) verify against.

```
┌──────────────────────────┐
│ pollpower-v2-api         │  ─┐
│  (KYC status)            │   │
├──────────────────────────┤   │  all read at t0
│ settlement-api           │   │  (SPEC.md §3 t0-consistency)
│  (per-session operator + │   │
│   timestamp)             │   │
├──────────────────────────┤   │
│ LD contract state        │   │
│  (registeredAt,          │   │
│   accPerShare, isLive,   │   │
│   pending prune, seats)  │  ─┘
└──────────────┬───────────┘
               ▼
    ┌───────────────────────┐
    │ eligibility-snapshot  │  ← WI-18 (this)
    │  (SPEC.md + index.mjs)│
    └──────────┬────────────┘
               │  snapshot JSON: members[] + output.rows[]
               ▼
    ┌───────────────────────┐
    │ sortition table builder│ ← WI-15
    │  build-table + audit  │
    └──────────┬────────────┘
               │  canonical table + membershipRoot
               ▼
    ┌───────────────────────┐
    │ msfed-v1 rev 5        │ ← WI-10 (contract diff)
    │  executeRotateSeats   │
    │   binds membershipRoot│
    └───────────────────────┘
```

## Files

| File | Purpose |
|------|---------|
| `SPEC.md` | The interface spec. Defines the snapshot JSON schema, the source-mapping table (which upstream feeds which field), t0-consistency semantics, and the placement inside the ceremony. This is the load-bearing artifact. |
| `index.mjs` | Reference implementation. Reads MOCK fixture data. Applies the §4 gate + §5.1 (B-2) constraints with **placeholder calibration** — every threshold is a `TODO(calibration)` sentinel. Emits an artifact conforming to `SPEC.md`. Has a `--self-test` mode. |
| `fixtures/snapshot-input.json` | Mock upstream state exercising: (1) clear pass, (2) fail on sessions count, (3) fail on maturity, (4) not-live, (5) all-one-operator (fails §5.1), (6) federation seat. |

## Running

```
node index.mjs                 # production-shape run (uses CAL_TODO — everything uncalibrated)
node index.mjs --self-test     # runs the acceptance checks against fixtures
node index.mjs path/to/x.json  # explicit input path
```

`--self-test` uses a **local, illustrative** calibration set
(`SELF_TEST_CAL` in `index.mjs`) to exercise the fixture cases. Those
numbers are **not CAL-3 / §5.1 values** — real values come from Garrett
per FEDERATION-IMPLEMENTATION-PLAN §3.

Production runs (without `--self-test`) use `CAL_TODO`, which leaves
every threshold `null`. Under `CAL_TODO`, every non-federation-seat
member's `gate.pass` will be `false` with reasons of the form
`sessions.distinctCount.uncalibrated:CAL-3 (X distinct settlement sessions)`.
That is intentional: this service produces **no verdicts** until Garrett
sets the register.

## Invariants (see SPEC.md for the full list)

1. **Output format is exactly WI-15's build-table input:**
   `{ epoch, rows: [{ memberAddr, weight, isFederationSeat? }] }`.
   Per SORTITION-TABLE-DESIGN §1. WI-15 handles canonical sort + Merkle
   root — this service produces the input.
2. **Every gate threshold is a named `TODO(calibration)` constant.**
   Never a hardcoded judgment. See `CAL_TODO` in `index.mjs`.
3. **Per-session operator attribution is present** in every session
   record (B-2 requirement per §5.1 / WI-08 / PR #17).
4. **All source data is mock/fixture.** No live network calls, no
   secrets, no real DB connection strings.
5. **`t0` consistency:** all fields are read at one instant; no field
   may drift mid-snapshot. See SPEC.md §3 for the producer contract in
   production.

## Notes for WI-15 (downstream)

- Consume `output.rows[]` verbatim; do not re-read `members[]`.
- `output.epoch === snap.epoch` is a hard equality — reject mismatches.
- Rows arrive in insertion order (which happens to be `memberAddr`-sorted
  by SPEC.md §1.3 determinism), but **WI-15 must re-sort canonically**
  per SORTITION-TABLE-DESIGN §1.2 to guarantee root reproducibility.
- Rows with `isFederationSeat: true` are the "lower-tier council address"
  case in the SORTITION-TABLE-DESIGN §1 table example; they should be
  weight-1 like every other row unless the §4 concave-gradient fallback
  is ever adopted (not the recommendation).

## Escalations noted, not resolved

None triggered — see SPEC.md §7 for the open items (point-in-time API
reads, `operatorId` provenance chain, `servedInPreviousEpoch` source,
CAL-3/§5.1 values, KYC revocation lag, PR #17 merge status).

Notably: the current `multisig/SORTITION-TABLE-DESIGN.md` on `main`
does **not** yet contain §5.1 (the B-2 mitigation is on open PR #17 /
WI-08). This service was designed to §5.1 as specified in the WI-18
brief so schema stability is preserved if PR #17 merges. If PR #17
lands with different parameter names, `config.gateThresholds` gets
renamed accordingly and nothing else in the schema changes.

Additionally: LD v2.2.1 removed the reader circuits
`getMemberState`/`getClaimableAmount` per its header comment. This is
**not** a schema-breaking change for this service — the underlying
ledger fields (`_members`, `_accPerShare`, `_seenKycJobHashes`,
`_pendingPrunes`) are still `export ledger …` and readable directly.
Documented in SPEC.md §5.

## Not in scope

- Canonical sort / Merkle-leaf encoding / root computation → **WI-15**.
- Draw procedure → **WI-15** + **WI-09** (`SORTITION-DRAW-SPEC.md`).
- Commit-reveal / seed ordering enforcement → ceremony operations,
  guided by `SORTITION-TABLE-DESIGN §3`.
- On-chain `membershipRoot` binding → **WI-10**.
- Any contract-side change → this service is entirely off-chain,
  read-only.
