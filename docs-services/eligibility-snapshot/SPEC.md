# Eligibility Snapshot Service — Interface Spec (WI-18)

> **STATUS: DEV DRAFT — SPEC + REFERENCE SCAFFOLD.**
> Not deployed, not audited, not on the pilot's critical path. Reference
> implementation runs against **mock fixture data only**. The real data
> sources span two services (`pollpower-v2-api`, `settlement-api`) plus
> the on-chain LD contract state, none of which this scaffold reads live.
>
> **NOTE ON §5.1 (B-2 mitigation):** As of this file's commit, the
> `multisig/SORTITION-TABLE-DESIGN.md` on `main` does **not** yet contain
> §5.1 — the per-operator session cap / cross-operator requirement /
> trailing-window mitigation lives on open **PR #17** (WI-08). The brief
> for WI-18 stipulates that the B-2 mitigation is a **REQUIRED SPEC
> INPUT** regardless of PR #17's merge status. This service is designed
> to §5.1 as stated in the WI-18 brief so that when PR #17 merges (or
> whatever supersedes it) the snapshot schema does not need to change.

---

## 0. What this service is (and what it isn't)

The **eligibility snapshot service** produces one consistent, timestamped
view of every candidate member's sortition-gate inputs at a single
snapshot instant `t0`. That view is the **only** input the WI-15 table
builder needs to construct the canonical sortition table and its
`membershipRoot`.

**Is:** a read-only aggregator. Reads from three upstream sources, joins
per member, applies the §4 eligibility gate + §5.1 farmability
constraints, and emits a canonical snapshot record. Its output is
consumed by WI-15's `build-table` command (and re-checked by the draw
auditor).

**Is not:**

- **not** the table builder — it does **not** sort by `memberAddr`, does
  not compute Merkle leaves, does not emit `membershipRoot`. That is
  WI-15's job. This service only produces the input WI-15 canonicalizes.
- **not** the draw — that is also WI-15.
- **not** a live query API. In production it runs at rotation-ceremony
  time producing a single artifact per epoch (per §3 of
  SORTITION-TABLE-DESIGN — freeze pool at `t0`, then reveal seed).
- **not** authoritative — it is a read on state that lives elsewhere.
  Two honest builders running against the same underlying state at the
  same `t0` MUST produce byte-identical snapshots (§1.3 determinism).

## 0.1 How it fits

```
              ┌────────────────────┐    ┌──────────────┐    ┌──────────────┐
              │  pollpower-v2-api  │    │settlement-api│    │ LD contract  │
              │  (KYC status,      │    │ (per-session │    │ (registeredAt│
              │   pending-prune    │    │  operator +  │    │  accPerShare │
              │   ops queue)       │    │  timestamp)  │    │  isLive)     │
              └─────────┬──────────┘    └──────┬───────┘    └───────┬──────┘
                        │                      │                    │
                        └────────┬─────────────┴────────────────────┘
                                 ▼   (all read at instant t0)
                     ┌───────────────────────┐
                     │ eligibility-snapshot  │  <- this service
                     │       (WI-18)         │
                     └───────────┬───────────┘
                                 │   snapshot artifact (this spec)
                                 ▼
                     ┌───────────────────────┐
                     │ sortition table builder│ <- WI-15
                     │       (WI-15)         │
                     └───────────┬───────────┘
                                 │   canonical table + membershipRoot
                                 ▼
                     ┌───────────────────────┐
                     │ msfed-v1 rev 5        │
                     │  executeRotateSeats   │  <- WI-10 contract change
                     └───────────────────────┘
```

Downstream, WI-15's `audit-draw` verifies the whole chain (snapshot →
table → root → draw → `incoming[5]`) against the on-chain rotation.

---

## 1. Snapshot artifact (top-level shape)

The snapshot service emits **one JSON document per epoch per tier**:

```jsonc
{
  "specVersion": "pp:eligibility-snapshot:v1",
  "epoch": 42,                          // uint64, the epoch this snapshot is for
  "tierId": "cluster-west",             // opaque tier identifier (matches the
                                        // multisig-federated-v1 instance this
                                        // sortition table feeds)
  "t0": "2026-08-01T00:00:00Z",         // ISO-8601 UTC; the consistent-read instant
  "t0Unix": 1785801600,                 // same as t0 in Unix seconds (uint64) for
                                        // arithmetic against LD's Uint<64> registeredAt
  "sources": {
    "v2ApiRevision":   "v2-api@sha:abc123…",   // provenance stamp, see §5
    "settlementApiRevision": "settlement-api@sha:def456…",
    "ldContractBlock": 1234567           // block/height the LD ledger was read at
  },
  "config": {
    "poolMode":        "single-operator" | "multi-operator",
    "gateThresholds":  { … see §2.2 },   // CAL-3, §5.1 params (all TODO)
    "cooldownEpochs":  { … see §2.3 }    // §6, TODO(calibration)
  },
  "members": [
    { …MemberRecord, see §2… },
    …
  ],
  "output": {
    "epoch": 42,
    "rows": [
      // The pre-gate output in WI-15 build-table input format.
      // ONE row per member that passed the gate:
      { "memberAddr": "0x…32b…", "weight": 1, "isFederationSeat": false },
      …
    ]
  }
}
```

Both `members` (the full per-member evidence) and `output` (the
gate-filtered rows for WI-15) are emitted. `members` is what auditors
re-check field-by-field. `output` is what WI-15's `build-table` command
consumes verbatim.

### 1.1 `output.rows` format — verbatim WI-15 build-table input

Fixed shape per SORTITION-TABLE-DESIGN §1:

```
{
  memberAddr:       hex-string, 32 bytes, "0x" + 64 hex chars
  weight:           uint (currently always 1 — §4 equal-weight recommendation)
  isFederationSeat: boolean (optional, default false; true for lower-tier
                    council-address rows per §1's example)
}
```

Rows in `output.rows` are emitted in **input order** (the same order as
`members`). WI-15 is responsible for **canonical sorting by memberAddr**
(§1.2 of SORTITION-TABLE-DESIGN); this service does not sort. This
matches the WI-15 brief's "input is already gate-filtered" contract.

### 1.2 `output.epoch` MUST equal top-level `epoch`

Bound so a snapshot artifact for one epoch can never be replayed as an
input to another epoch's table build. WI-15 re-checks this equality.

### 1.3 Determinism (invariant)

Two honest snapshot builders reading the same underlying state (same
`v2ApiRevision`, `settlementApiRevision`, `ldContractBlock`) at the same
`t0` MUST produce byte-identical `members[]` and `output.rows[]`, given
identical `config`. Non-determinism sources to be eliminated in
production:

- **Map iteration order** in the LD ledger — resolve by reading the LD
  member set through a canonical query that emits members sorted by
  `UserAddress.bytes` ascending. `members[]` in the artifact is in that
  same ascending order.
- **Session-ordering** inside each member's `sessions[]` — sort by
  `(timestampUnix ASC, sessionId ASC)` and document this in producer
  code.

---

## 2. `MemberRecord` — the per-member schema

Every entry in `members[]` is one candidate. **All fields are populated
from state as of `t0`** (§3 — t0 consistency invariant). No field may
drift mid-snapshot.

```jsonc
{
  "memberAddr": "0x…32b…",              // Bytes<32>, hex. Matches UserAddress.bytes on-chain.

  // ── §4 gate condition 1: KYC ──
  "kycVerified": true,                  // bool. TRUE iff a KYC attestation matching
                                        // this member has been consumed by LD's
                                        // register() (i.e. is in _seenKycJobHashes)
                                        // AND has not been revoked upstream. §2.1.
  "kycProviderTag": "SmileID",          // for audit; per D-2 currently always "SmileID"

  // ── §4 gate condition 2: ≥ X distinct settlement sessions ──
  //     with §5.1 per-session operator attribution
  "sessions": [
    {
      "sessionId":    "0x…32b…",        // Bytes<32> from EBT's replay-guarded
                                        // session identity (settle() input)
      "operatorId":   "operator-west-a", // opaque operator identifier — the operator
                                        // whose meter attested this session. REQUIRED
                                        // per §5.1 so per-operator cap and
                                        // cross-operator count are computable.
      "timestampUnix": 1783123200,      // uint64, when settle() consumed this session.
                                        // REQUIRED per §5.1 trailing-window.
      "settlementApiRef": "sessions/0x…" // provenance stamp for the audit trail
    },
    …
  ],

  // ── §4 gate condition 3: ≥ Y days LD maturity ──
  //     Reader-circuit-free: this scaffold reads the fields directly from
  //     the LD `_members: Map<UserAddress, MemberState>` ledger since
  //     getMemberState / getClaimableAmount were removed in v2.2.1
  //     (see §5 note). Field shape is UNCHANGED.
  "ldRegisteredAt":         1780531200,  // Uint<64>, UNIX seconds; MemberState.registeredAt
  "ldAccPerShareCheckpoint":"12345678900000000000",
                                         // Uint<128> as decimal string; MemberState.accPerShareAtCheckpoint
  "ldAccPerShareAtT0":      "23456789000000000000",
                                         // Uint<128> as decimal string; the GLOBAL _accPerShare read at t0.
                                         // Included so downstream can compute delta = (global - checkpoint)
                                         // and enforce "non-trivial accPerShare checkpoint proving real
                                         // accrued share" (§4).

  // ── §4 gate condition 4: currently live ──
  "isLive":            true,             // MemberState.isLive as of t0
  "lastSeenUnix":      1782739200,       // MemberState.lastSeen — informational,
                                         // included so §6 liveness threshold changes can be checked
                                         // without re-reading the LD state
  "pruning": {
    "hasPending":      false,            // TRUE iff _pendingPrunes contains this member
    "proposedAtUnix":  null              // uint64 | null; the PendingPrune.proposedAt if hasPending
  },

  // ── §6 last-epoch cooldown ──
  "servedInPreviousEpoch": false,        // TRUE iff this memberAddr is in the outgoing[5]
                                         // of the rotation prior to `epoch`. Read from
                                         // msfed-v1 `_seats` at t0 (or from the last
                                         // rotation's `outgoing[5]`).

  // ── §1 row-shape hint ──
  "isFederationSeat": false,             // TRUE only if this row represents a lower-tier
                                         // council address rather than a natural person
                                         // (§1 table example). Populated from tier config.

  // ── §4 gate evaluation, computed by this service ──
  "gate": {
    "pass":  true,                       // TRUE iff every §4 + §5.1 condition holds
    "reasons": [                         // present when pass=false; ordered by check
      // e.g. "sessions.distinctCount<X", "sessions.crossOperatorCount<2",
      // "sessions.perOperator.exceedsSCap", "sessions.window.insufficient",
      // "maturity.tenureDays<Y", "maturity.accPerShareDelta.trivial",
      // "kyc.notVerified", "liveness.notLive", "cooldown.servedPreviousEpoch"
    ]
  }
}
```

### 2.1 KYC verification semantics (`kycVerified`)

Upstream truth for KYC lives in two places today:

- **`pollpower-v2-api`** — the off-chain SmileID pipeline result, plus
  the operational status (e.g. any post-hoc revocation).
- **LD contract `_seenKycJobHashes: Set<Bytes<32>>`** — the on-chain
  Sybil guard (§4 of LD DESIGN.md, §4 of SORTITION-TABLE-DESIGN.md).

`kycVerified = true` requires BOTH:

1. The pipeline reports the member's KYC as active/non-revoked at `t0`
   (in `pollpower-v2-api`).
2. A matching `hash(providerTag, jobIdHash)` is present in
   `_seenKycJobHashes` as of `t0`'s LD block.

The AND is deliberate: on-chain-only would ignore off-chain revocations;
off-chain-only would ignore whether the member was ever properly
registered on LD. Per **D-2** (SmileID-only for Kenya market), the
`kycProviderTag` field is currently a constant; retained in the schema
so a future multi-provider posture doesn't force a schema break.

### 2.2 Gate thresholds (`config.gateThresholds`)

**Every value here is `TODO(CAL-3)` or `TODO(§5.1)` in the reference
implementation.** This service NEVER picks these; they are Garrett's
call per the Federation Implementation Plan §3 calibration register.

```jsonc
{
  // ── CAL-3: §4 gate conditions ──
  "X_minDistinctSessions":  { "value": null, "todo": "CAL-3" },
  "Y_ldMaturityDays":       { "value": null, "todo": "CAL-3" },
  "minAccPerShareDelta":    { "value": null, "todo": "CAL-3 (§4 'non-trivial accPerShare checkpoint proving real accrued share')" },

  // ── §5.1 (WI-08 / PR #17) B-2 mitigation params ──
  "S_cap":                  { "value": null, "todo": "§5.1 (WI-08)" },
                             // per-operator cap on gate-countable sessions. MUST be < X so
                             // one operator alone cannot cross the X threshold.
  "windowDays":             { "value": null, "todo": "§5.1 (WI-08)" },
                             // trailing window over which the X sessions must accumulate.
                             // A pre-rotation session burst inside t0 - windowDays alone
                             // cannot satisfy the gate.
  "minCrossOperatorCount":  { "value": null, "todo": "§5.1 (WI-08)" }
                             // e.g. 2 — sessions must span at least this many operators.
                             // When poolMode == "single-operator" this constraint is
                             // SUSPENDED (§5.1 rev-2 note: "inert at pilot scale").
}
```

### 2.3 Cooldown (`config.cooldownEpochs`)

Per SORTITION-TABLE-DESIGN §6, seat-holders in `e-1` are excluded from
epoch `e`'s table (recommended default = cooldown-ineligible).

```jsonc
{
  "personalCooldownEpochs":   { "value": null, "todo": "§6 per-tier" },  // e.g. 1
  "federationSeatCooldown":   false                                       // §6: federation
                                                                          // seats exempt from
                                                                          // personal cooldown
                                                                          // unless a tier
                                                                          // opts them in
}
```

---

## 3. Snapshot-instant (`t0`) consistency — the load-bearing invariant

Per SORTITION-TABLE-DESIGN §3, membership MUST be frozen at `t0` strictly
before the seed becomes knowable. The point of this service is to
produce a single, consistent, `t0`-dated read across three data sources.
Every field in every `MemberRecord` MUST reflect state at `t0` — no
field may reflect state observed at some later `t0 + ε`.

**Producer contract (normative for the production implementation):**

1. Choose `t0`. Publish it (`.t0` in the artifact).
2. Read the LD contract state at the **block** whose finality-timestamp
   is ≤ `t0` and whose successor's timestamp is > `t0`. Record the block
   in `sources.ldContractBlock`. This gives an atomic, consistent read
   of `_accPerShare`, `_members`, `_seenKycJobHashes`, `_pendingPrunes`,
   `_seats` (from msfed).
3. Read `pollpower-v2-api` and `settlement-api` at a point-in-time query
   parameter (`asOf=t0`). Both services MUST support point-in-time reads
   for this to be sound; if they cannot, the producer MUST fall back to
   a lock-and-drain protocol (freeze writes, snapshot, unfreeze) and
   document that in `sources.*Revision`.
4. If any source cannot honour the `asOf=t0` read, the producer MUST
   abort and not emit an artifact. Silent divergence is the failure
   mode this invariant exists to prevent.

**Auditor contract:** WI-15's `audit-draw` re-reads (or is handed a
re-attested copy of) the same three sources at the same `t0` and checks
byte-equality of the members array. Any drift = reject.

**No mid-snapshot drift.** If a member's LD `isLive` flips from true to
false between the LD read and the settlement-api read, the producer
either aborts or re-reads everything at a new `t0`. There is no partial
snapshot.

---

## 4. Source mapping — which upstream feeds which field

Every `MemberRecord` field is populated from exactly one upstream truth.
This table is normative — WI-15's audit re-checks the mapping.

| Field                              | Upstream source                     | On-chain / API artefact                                        | Notes |
|------------------------------------|-------------------------------------|-----------------------------------------------------------------|-------|
| `memberAddr`                       | LD contract state                   | key of `_members: Map<UserAddress, MemberState>`               | `UserAddress.bytes`, hex-encoded |
| `kycVerified` (AND leg 1: off-chain) | `pollpower-v2-api`                | KYC-status endpoint (`asOf=t0`), including revocation state    | per **D-2** provider = SmileID |
| `kycVerified` (AND leg 2: on-chain) | LD contract state                   | membership in `_seenKycJobHashes` for the member's attestation | authoritative Sybil guard |
| `kycProviderTag`                   | `pollpower-v2-api`                  | per-member KYC record                                          | constant "SmileID" under D-2 |
| `sessions[].sessionId`             | `settlement-api`                    | `settle()`-consumed replay-guarded session id (Bytes<32>)      | matches EBT v7's `_settledSessions` |
| `sessions[].operatorId`            | `settlement-api`                    | per-session operator/meter attestation                         | REQUIRED for §5.1 (B-2 mitigation) |
| `sessions[].timestampUnix`         | `settlement-api`                    | `settle()` timestamp                                           | REQUIRED for §5.1 trailing-window |
| `sessions[].settlementApiRef`      | `settlement-api`                    | opaque provenance stamp                                        | audit trail only |
| `ldRegisteredAt`                   | LD contract state                   | `MemberState.registeredAt`                                     | Uint<64> |
| `ldAccPerShareCheckpoint`          | LD contract state                   | `MemberState.accPerShareAtCheckpoint`                          | Uint<128> as decimal string |
| `ldAccPerShareAtT0`                | LD contract state                   | global `_accPerShare` at `t0`                                  | Uint<128> as decimal string — needed to compute the §4 "non-trivial `accPerShare` delta" |
| `isLive`                           | LD contract state                   | `MemberState.isLive`                                           | Boolean |
| `lastSeenUnix`                     | LD contract state                   | `MemberState.lastSeen`                                         | Uint<64> |
| `pruning.hasPending`               | LD contract state                   | membership in `_pendingPrunes: Map<UserAddress, PendingPrune>` | LD §7 (two-phase prune) |
| `pruning.proposedAtUnix`           | LD contract state                   | `_pendingPrunes[member].proposedAt`                            | Uint<64>, null if not pending |
| `servedInPreviousEpoch`            | msfed-v1 contract state             | membership in `_seats` at `t0` for previous rotation's outgoing set (or event log) | §6 cooldown input |
| `isFederationSeat`                 | tier configuration (off-chain)      | operator/registrar config for this tier                        | not derivable from state alone |
| `gate.pass` / `gate.reasons`       | **computed by this service**        | function of the above + `config`                               | pure function; deterministic |

**Bounded API surface note.** `pollpower-v2-api` and `settlement-api` do
not, as of this scaffold, expose stable `asOf=t0` query parameters.
Landing this service in production is blocked on either (a) those APIs
gaining point-in-time reads, or (b) a lock-and-drain protocol per §3.
Both are §5-open items on the FEDERATION-IMPLEMENTATION-PLAN §3
calibration register-adjacent list — flagged here rather than resolved.

---

## 5. Reader-circuit removal in LD v2.2.1 — schema unchanged

LD v2.2.1 header (`living-dividend-v2.2.1.compact` line 9) documents:

> Removed circuits: getSolvencyState, getStats, getMemberState,
> getClaimableAmount, getPendingClaim, hasPendingPrune.

**Impact on this snapshot service:** none on the schema. The underlying
ledger fields these reader circuits exposed still exist:

- `MemberState { accPerShareAtCheckpoint, lastSeen, registeredAt, isLive }`
  — line 116, still an exported ledger struct.
- `_accPerShare: Uint<128>` — line 165.
- `_members: Map<UserAddress, MemberState>` — line 170.
- `_seenKycJobHashes: Set<Bytes<32>>` — line 171.
- `_pendingPrunes: Map<UserAddress, PendingPrune>` — line 173.

Because `export ledger …` fields are readable directly against the
contract state (indexed via Midnight's ledger reads), removing the
reader *circuits* changed how one queries these fields from JS (direct
ledger read instead of an exported reader), not what data is available.

Downstream computation (e.g. `getClaimableAmount = (accPerShare -
checkpoint) / SCALE`) is performed by consumers off-chain now. This
service records both `ldAccPerShareCheckpoint` and `ldAccPerShareAtT0`
so downstream can perform the same computation without needing a reader
circuit. **No schema change is triggered by this removal.**

---

## 6. Placement inside the ceremony

Ordering with respect to SORTITION-TABLE-DESIGN §3:

```
t0    ← this service produces the snapshot artifact
        (frozen from all three sources, all fields at t0)
        publish members[] AND output.rows[]
t0'   ← WI-15 build-table consumes output.rows[], produces
        canonical table + membershipRoot; publish root + full table
        (this is when the pool becomes immutable per §3 t0)
t1    ← reveal / derive seed (never before the root is committed)
t2    ← draw over (table, seed) → incoming[5] → executeRotateSeats
```

`t0'` is technically after `t0` (this service runs first), but both
occur before any seed is knowable. The "snapshot instant" the
SORTITION-TABLE-DESIGN §3 talks about is functionally the instant this
service's `t0` — WI-15 does not observe any external state, it only
canonicalizes what this service handed it.

---

## 7. Open items before this could leave DEV DRAFT

These are named-and-flagged, not resolved:

1. **Point-in-time read from `pollpower-v2-api` and `settlement-api`.**
   Neither service currently exposes `asOf=t0`. Production requires
   either those API changes or a lock-and-drain protocol.
2. **`operatorId` provenance chain** — the settlement API records the
   settling operator's attested meter-signer. Confirming that field is
   already recorded per-session (and is stable across queries) is a
   settlement-api verification item, not this service's to invent.
3. **`servedInPreviousEpoch` source** — either read `_seats` at the
   rotation-hash immediately prior to `epoch`, or use the epoch's
   rotation event log. Both work; pick one in production and document.
4. **CAL-3 and §5.1 parameter values** — every threshold in
   `config.gateThresholds` is `TODO(calibration)` in the reference
   implementation. Executing sessions are forbidden from picking these
   values per the FEDERATION-IMPLEMENTATION-PLAN §3 register.
5. **KYC revocation lag** — off-chain revocations that have not yet
   flowed to the LD contract's Sybil guard would produce a member who
   is `kycVerified=false` off-chain-side but has their attestation
   consumed on-chain. The AND rule (§2.1) is deliberately conservative
   — a revoked member fails the gate — but the operational protocol
   for on-chain unregistration of revoked members is not this service's
   business, and is flagged for the KYC-pipeline runbook.
6. **§5.1 (WI-08) merge status** — this spec assumes §5.1 as stated in
   the WI-18 brief regardless of PR #17. If PR #17 lands with different
   parameter names or semantics, `config.gateThresholds` field names
   are renamed accordingly (schema is otherwise stable). This is a
   deliberately narrow coupling; a wider mismatch triggers the
   escalate-and-stop protocol in the FEDERATION-IMPLEMENTATION-PLAN
   §5.3.

---

## 8. Not in scope (belongs elsewhere)

- **Canonical sort by `memberAddr` / Merkle-leaf encoding / root
  computation** — WI-15 (`multisig/SORTITION-TABLE-DESIGN.md` §1).
- **Draw procedure** — WI-15 (`SORTITION-TABLE-DESIGN.md` §2 + WI-09
  `SORTITION-DRAW-SPEC.md`).
- **Anti-grinding commit-reveal ordering** — SORTITION-TABLE-DESIGN §3
  (this service just produces the `t0`-dated artifact; the *ordering*
  is enforced by whoever operates the ceremony).
- **On-chain `membershipRoot` binding** — WI-10 (msfed-v1 rev 5
  contract change).
- **Any contract-side change** — this service is entirely off-chain,
  read-only.

---

*Author: WI-18 executing session, 2026-07-13. DEV DRAFT. Verified
against `living-dividend/living-dividend-v2.2.1.compact` (MemberState
struct L116-121, ledger decls L165-173) and
`multisig/SORTITION-TABLE-DESIGN.md` (§4 gate, §3 t0-timing, §1 output
row shape). §5.1 designed to the WI-18 brief; PR #17 not yet merged on
`main` at commit time.*
