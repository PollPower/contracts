# WI-14 EBT vNext — Design Document

**Status:** design draft against `dispatch-briefs/WI-14-EBT-vNext-v2.md`. Zero
contract code lives here; this document is the design pass output that will
drive the next session's `.compact` authoring.

**Branch:** `docs/wi14-vnext-design` (off `docs/wi14-brief-v2-revision`, which
carries the v2 brief at `fcbad09`).

**Reads-against:**

- `dispatch-briefs/WI-14-EBT-vNext-v2.md` (spec of record; every design
  decision here cites a section of it).
- `ebt/V7-DESIGN.md` (v7 unshielded-token lineage — this design forks from it,
  not from v5.2).
- `ebt/ebt-v7.4.2.compact` (production baseline: HAT / attest / reissue /
  settle / claimSplit / LD binding).
- `tariff-registry/V1.1-DESIGN.md §7` (WI-14 handoff spec of record — where it
  and the brief diverge, §7 wins per brief §ESCALATION TRIGGERS #10).
- `tariff-registry/tariff-registry-v1.compact` (WI-13.1 exports: `LaneRecord`
  struct, `resolveLanes`, `isLaneActive`, `laneKey` helper, `emitAction` event
  kinds 1 / 7 / schedule-lifecycle).
- `memory/audit-2026-07-07-findings.md` (EBT-H-1 finding — mint-redirection
  fix is invariant I-14-A).

**Compactc pin:** `0.30.0`. WI-13 landed on 0.30.0; 0.31.0 is deferred per
2026-07-16 environment note.

**Version label recommendation:** call the new lineage `v8`. The changes are
not strictly additive (new ledger fields, new mint recipients, new circuits,
HAT payload widening, new failure modes). A `v7.5` label would understate the
diff and set the wrong review posture for a `💰 touches-funds` change. The
supervising session at dispatch owns this final call per v2 brief §DELIVERABLE.

---

## §1. Purpose

Take the v7.4.2 unshielded-token contract and extend it to consume the WI-13.1
statutory-lane registry via a same-contract mirror pattern, so that `settle`
can route mint outputs to multiple lanes (LD + ops + statutory lanes) sourced
from a federation-approved schedule rather than the four hard-coded protocol
splits currently baked into v7.4.2's state.

Along the way this contract closes the EBT-H-1 mint-redirection finding
(I-14-A), adds per-coin tariff-path metadata for D-10 fiat-denominated
redemption (I-14-E, I-14-F), and preserves v7.4.2's LD binding contract
(I-14-H) so Session 3–5's ceremony infrastructure and Session 8's compound-PK
idempotency are not disturbed.

Non-goals (deferred):

- Multi-epoch color-per-epoch minting. Single color per instance for this
  cut.
- LD structural changes. Binding preserved by shape; any real LD change is a
  separate item.
- Multisig / registry / meter-authority contract changes.
- WI-13.2 amendment to TariffRegistry — the design carries a mirror-freshness
  mechanism that requires it, and the requirement is called out explicitly as
  a follow-up work item (§3), but the amendment itself is written under WI-13.

---

## §2. Ledger fields (state kept on-chain)

The following ledger fields exist. Every field is grouped by lineage
(preserved from v7.4.2 / modified / net-new for vNext).

### 2.1 Preserved from v7.4.2 (identical semantics, identical types)

| Field | Type | Purpose | Invariant |
|---|---|---|---|
| `_initialized` | `Boolean` | Constructor guard | Standing |
| `_owner` | `Bytes<32>` | Ownership (multisig-gated setters, L-1 pattern) | v7.4.2 |
| `_meterAuthorityPubkey` | `Bytes<32>` | HAT signer authority | I-14-A |
| `_totalSupply` | `Uint<128>` | Circulating EBT | I-1 (1 EBT = 1 kWh) |
| `_settledSessions` | `Set<Bytes<32>>` | Replay guard on `sessionID` | v7.4.2 |
| `settlementCount` | `Counter` | Settle audit trail | v7.4.2 |
| `producerAttestations` | `Map<Bytes<32>, ...>` | Producer key → wallet attestation | M-1 remediation |
| `reissuanceCount`, `reissuanceLog`, `_lastReissueTime` | (v7.4.2 types) | Manual-reissue audit + cooldown | M-4 remediation |
| `_dividendMintedLog` | `Map<Uint<64>, DividendMintedEntry>` | LD binding — keeper-observable ledger of every `claimSplit` bump | I-14-H |
| `_redemptionCount`, `_redemptionLog` | `Counter`, `Map<Uint<64>, RedemptionEntry>` | Provable-burn audit for KES release | I-14-F |
| `_actionLog`-style keeper-observable event stream | (v7.4.2 shape) | Off-chain indexer signal | Compact discipline §0.2 |

`_bpsProducer`, `_bpsOperations`, `_bpsDividend`, `_bpsDao`,
`_operationsRecipient`, `_dividendRecipient`, `_daoRecipient` from v7.4.2 are
**removed**. Those four hard-coded splits are the thing the mirror replaces:
splits now come from `_registeredLanesMirror` at settle time, keyed to the
schedule the producer cites. See §5 for how `settle` uses the mirror and
§9 for the migration story on the retired fields.

### 2.2 Net-new mirror maps (Registry-mirror pattern per v2 brief §KEEPER MIRROR CONTRACT)

Three mirror maps, all keyed the same way TariffRegistry keys its own state.
Every key derivation must be byte-identical to WI-13.1's to preserve the
mirror-vs-truth verification in §3.

```
export ledger _registeredLanesMirror:              Map<Bytes<32>, LaneRecord>;
export ledger _classStatutoryTotalBpsMirror:       Map<Bytes<32>, Uint<16>>;
export ledger _scheduleLiveMirror:                 Map<Bytes<32>, Boolean>;
```

**`_registeredLanesMirror`** — key derivation MUST reuse WI-13.1's `laneKey`
formula verbatim:

```
laneKey(scheduleId, leviedBy, laneKindByte) =
  persistentHash<Vector<4, Bytes<32>>>([
    pad(32, "pp:tariff:v1:laneKey"),
    scheduleId,
    leviedBy,
    (laneKindByte as Field) as Bytes<32>,
  ])
```

Value type: the WI-13.1 `LaneRecord` struct, imported by name (12 fields:
`scheduleId, laneKindByte, leviedBy, bpsShare, remitAddress, basis,
applicabilityHash, statuteRefHash, effectiveEpoch, retiredEpoch,
remittanceMode, registeredAt`).

**`_classStatutoryTotalBpsMirror`** — key derivation:

```
classKey(scheduleId, classPath) = persistentHash<Vector<3, Bytes<32>>>([
  pad(32, "pp:ebt:vNext:classKey"),
  scheduleId,
  classPath,
])
```

The `pp:ebt:vNext:classKey` domain-separation tag is EBT-side (WI-13.1 does
not need the same key because its own `_classEntries` map uses a different
composite key on the registry side). The mirror carries only what settle
needs: the `statutoryTotalBps: Uint<16>` sub-field of `ClassEntry.bps`. The
class-level `rateFiatPerKwh` and `lastUpdatedAt` are NOT mirrored; if `settle`
needs fiat-value-at-mint (I-14-E), the caller passes it as a settle input and
it is validated against a sanity band using CAL-2 (unresolved). This keeps
the mirror surface narrow.

**`_scheduleLiveMirror`** — key derivation is the raw `scheduleId` (32-byte
identity, no hash wrapper). Value is `Boolean`. `true` == schedule is live and
usable in settle; `false` == schedule is retired.

### 2.3 Net-new per-coin metadata (WI-06 A2 → I-14-E)

Every minted coin carries a `TariffPath` record. This is coin-side state, not
a ledger map. Encoded into the mint event / redemption entry.

```
struct TariffPath {
  scheduleId:      Bytes<32>,
  classPath:       Bytes<32>,     // hash of the class path components
  epoch:           Uint<64>,
  fiatValueAtMint: Uint<64>,      // KES per coin, bounded by CAL-2 sanity band
}
```

Where this lives:

- On mint: passed as circuit input to `settle`, disclosed and embedded in the
  `_actionLog` mint event and the coin's `RedemptionEntry` audit row.
- On redeem: read from the `RedemptionEntry` for the burned coin (I-14-E:
  once minted, `fiatValueAtMint` is immutable — the entry is the record).
- On reissue: preserved. `manualReissue` (M-4-hardened) copies the source
  coin's `TariffPath` to the reissued output.

**Storage choice — not a per-coin ledger map.** Compact unshielded tokens
color entire outputs uniformly; per-coin storage on the ledger would require
either color-per-tariff-path (combinatorial explosion) or a `_coinTariffPath`
map keyed by coin identity (Compact's UTXO model doesn't give us a
first-class coin id). The design instead treats `TariffPath` as event-side
state: the settle event carries it, the redemption event carries it, and the
off-chain indexer + settlement-api reconstitute per-coin fiat obligations
from the event stream. This matches D-10's per-coin fiat metadata by carrying
the metadata attached to the settle/redeem transactions rather than in a
ledger map.

Escalation trigger fired (§11): the "single color per instance" non-goal
above is in tension with D-10's per-coin fiat-value-at-mint. Two coins minted
at different `fiatValueAtMint` share the same color — they redeem for
different KES amounts. The redemption path (§6) must key off the
`RedemptionEntry` for the payoutRef, not off the color, to preserve
per-coin semantics. Called out again in §6 and §11.

### 2.4 Modified from v7.4.2

- **HAT payload width.** v7.4.2 signs a 4-field payload
  `[sessionID, hatPubkey, amountBytes, producerKey]`. vNext signs a 5-field
  payload `[sessionID, hatPubkey, amountBytes, producerKey, producerAddr]`.
  Domain-separation tag becomes `pollpower:ebt:vNext:epoch1`. This is the
  I-14-A fix by construction: an observer of a valid attestation tuple
  cannot substitute producerAddr because it is now in the signed payload.
- **Domain-sep tag for token color.** v7.4.2 uses
  `pollpower:ebt:v7:epoch1`. vNext uses `pollpower:ebt:vNext:epoch1` (final
  version label set at dispatch). Because the tag encodes into the token
  color via `tokenType(domainSep, contractAddress)`, vNext EBT is a distinct
  color from v7.4.2 EBT — a hard boundary that supports the migration
  story in §9.

---

## §3. Mirror freshness mechanism — the key architectural decision

The v2 brief §KEEPER MIRROR CONTRACT enumerates three candidate mechanisms
for verifying that `_registeredLanesMirror` (and the two sibling mirrors)
reflect current registry state at settle time. The design pass must pick
one. This section walks the tradeoffs, recommends one, and documents what
`LANE_MIRROR_STALE` looks like under the chosen mechanism.

### 3.1 The three candidates

**Option (i) — Per-write witness against registry map membership.**
Every mirror-write EBT circuit accepts as input the `LaneRecord` (or class
statutory total, or schedule liveness flag) that the keeper wants to write,
plus a Merkle-style inclusion proof that the record is present in
TariffRegistry's `_registeredLanes` at some height H. EBT verifies the proof
against a `registryStateRoot: Bytes<32>` field committed on-chain. Freshness
becomes "the proof verifies against a `registryStateRoot` at or after height
H_last, where H_last is the height of the most recent
`LANE_REGISTERED`/`LANE_RETIRED` event the keeper is aware of." Requires
TariffRegistry to expose a state root — a one-field additive amendment
(WI-13.2). Requires Compact-side Merkle-proof machinery, which is not free.

Freshness check per settle: read the mirrored `LaneRecord` in-circuit;
verify the mirror-write commitment (the settle circuit trusts the mirror
map's contents because the write-side circuit verified the proof at write
time). This is not "freshness" in the strict sense — it is "the mirror is
never wrong because writes are proof-gated." Staleness surfaces as an
absence: a `LANE_RETIRED` event has been emitted but the keeper hasn't yet
called the mirror-write circuit to retire the mirror entry. `LANE_MIRROR_STALE`
in this world means "the settle circuit read `_registeredLanesMirror[key]`
and got a live entry, but a subsequent registry event has invalidated it and
the mirror-write has not fired." Detecting that in-circuit is hard — the
settle circuit does not know registry events exist. Practical
implementation: attach a `registryHeightAtWrite: Uint<64>` alongside every
`LaneRecord` in the mirror, and a settle-caller-supplied
`freshBeforeHeight: Uint<64>` bounded against a `registryStaleTolerance:
Uint<64>` constant. Any mirror entry older than `freshBeforeHeight -
registryStaleTolerance` fails settle. This is heuristic and depends on the
tolerance value (a new CAL-n placeholder).

**Option (ii) — Federation-signed attestation.**
The keeper submits mirror-write requests carrying a threshold signature over
`(scheduleId, laneKindByte, LaneRecord)` (or over an event-batch commitment)
from a federation-controlled mirror-attestation committee. EBT verifies the
multisig. Freshness comes from the committee refreshing signatures each
epoch (or each event) and slashing keepers that submit stale attestations.
`LANE_MIRROR_STALE` fires when the attestation's epoch is older than settle
epoch minus a tolerance.

This decouples the trust boundary from cryptographic map-membership at the
cost of introducing a new operational entity (the attestation committee).
For a `💰 touches-funds` contract this is a nontrivial addition — we would
be relying on a federation committee that does not exist yet to certify the
statutory-lane view. It works if the committee already exists (it does not),
and if committee misbehavior is bounded (via slashing that we would also
need to build).

**Option (iii) — Registry-side event commitment (WI-13.2 mini-diff).**
TariffRegistry extends its `emitAction` circuits (kinds 1 `LANE_REGISTERED`,
7 `LANE_RETIRED`, and the schedule-lifecycle kinds) to include the full
mirrored payload (either the `LaneRecord` inline, or its `persistentHash`)
in the event body. The keeper's mirror-write EBT circuit takes as input the
event body plus a proof-of-inclusion in the registry's `_actionLog`. EBT
verifies against a `registryActionLogRoot` committed on-chain (or against a
per-event commitment carried in the event body itself). Freshness comes for
free: the event is the truth, the mirror-write moves the event into the
mirror map, and the settle circuit reads the mirror knowing every entry
traces to an event.

`LANE_MIRROR_STALE` in this world: the mirror-write circuit carries an
`actionSeq: Uint<64>` alongside every record; settle asserts that
`actionSeq` is within a bounded window of `registryActionLogHeadSeq`
(mirrored separately). If the head advances (new events emitted on the
registry) and the mirror does not catch up, settle fails at the boundary.
The tolerance is a CAL-n placeholder but small (single-digit sequence
numbers, not epochs).

Requires a WI-13.1 amendment (WI-13.2): `emitAction` payload widening for
five action-kinds, plus a `registryActionLogRoot` (or equivalent commitment)
export on the registry side. Non-trivial but bounded.

### 3.2 Recommendation

**Option (iii), registry-side event commitment. Requires WI-13.2 amendment
to TariffRegistry.**

Why:

- **Correctness by construction, not by tolerance.** Options (i) and (ii)
  both rely on a `staleTolerance` scalar that becomes a new CAL-n
  placeholder. For a settlement contract this is the wrong shape — the
  tolerance is a security-relevant knob and its value ends up in the audit
  surface. Option (iii)'s tolerance is a sequence-number window over
  registry events, which is O(recent events) not O(epochs), and is a
  bounded operational concern rather than a policy value.
- **Aligns with the constitutional "the mint pays" principle
  (§0.1 in FEDERATION-IMPLEMENTATION-PLAN.md).** The registry emits the
  authoritative statement; EBT observes it and mints accordingly. Option
  (ii) puts a committee between the two, which is a decoupling in the
  wrong direction.
- **Fits the existing MIP-0002 event-log pattern.** WI-13.1 already emits
  `_actionLog` entries for kinds 1, 7, and the schedule-lifecycle kinds.
  Widening the event body is a smaller diff than introducing a new
  committee or a new state root export dedicated to map membership.
- **Handles the class-statutory-total-bps case cleanly.** Options (i) and
  (ii) treat `_classStatutoryTotalBpsMirror` and `_scheduleLiveMirror` as
  first-class map-membership questions, which don't fit as cleanly — the
  class total is a field on `ClassEntry`, not a discrete map entry. Option
  (iii) simply emits schedule-lifecycle and retune events with the mirrored
  fields inline; the mirror-write reads them from the event body.
- **The WI-13.2 amendment is small.** Widen `RegistryActionEntry` to carry
  a `payloadHash: Bytes<32>` (or the payload inline) for the five relevant
  action-kinds; export the `_actionLog`'s Merkle root (or a per-event
  commitment via `persistentHash`) as `registryActionLogRoot: Bytes<32>`
  ledger; add a `getEventCommitment(seq)` circuit for keepers to read.
  Zero changes to WI-13.1's federation-governance surface — the amendment
  is purely observational.

Cost:

- Blocks vNext on WI-13.2 landing first. This is an escalation trigger, not
  a design-pass workaround.
- Adds ~30 lines of Compact to WI-13.1's action-emission surface + a new
  root export. Small.
- The mirror-write EBT circuits carry event-inclusion proofs; that is
  standard `persistentHash` machinery.

### 3.3 Concrete `LANE_MIRROR_STALE` check under option (iii)

On settle:

1. Read `_registeredLanesMirror[laneKey(scheduleId, leviedBy, laneKindByte)]`.
2. Extract the mirrored entry's `writeActionSeq: Uint<64>` (a new field on
   the mirrored value, set at mirror-write time from the source registry
   event's action-seq).
3. Read `_registryActionLogHeadSeqMirror: Uint<64>` (a scalar ledger field
   on EBT, mirrored from the registry's `_actionSeq` counter — updated by a
   thin `mirrorActionLogHead(seq, proof)` circuit that the keeper calls at
   the top of every batch).
4. Assert `writeActionSeq >= _registryActionLogHeadSeqMirror - CAL_MIRROR_STALE_TOLERANCE`.
   Fail with `LANE_MIRROR_STALE` otherwise.

`CAL_MIRROR_STALE_TOLERANCE` was a calibration placeholder
(CAL-vNext-M1). **RESOLVED 2026-07-27 at 32 events** per
[`WI-14-CEREMONY-SKELETON.md`](./WI-14-CEREMONY-SKELETON.md) §9 CAL-2 (raise
to 64 before mainnet Phase 2). Alert threshold at 50% = 16 events
triggers immediate ceremony supersession of the weekly cadence. The
keeper has room to submit up to 32 registry-event-lag before the settle
circuit refuses. Small enough that keeper down-time is surfaced fast; large
enough to survive batch-window latency.

### 3.4 Failure mode analysis under option (iii)

**(a) Slow keeper.** Registry emits 10 events (schedule retunes, lane
registrations) in a burst; keeper falls 4 events behind on the mirror.
Settles at the tail of the queue succeed; settles at the head fail with
`LANE_MIRROR_STALE`. Recovery: keeper catches up, settles retry. Zero fund
risk.

**(b) Offline keeper.** No mirror updates. Head advances; settles start
failing after `CAL_MIRROR_STALE_TOLERANCE` events. Recovery: alternate
keeper (or the primary keeper resumed) takes over. Zero fund risk.

**(c) Malicious keeper.** Keeper writes a mirror entry that does not match
the registry event body. The mirror-write circuit verifies the event
commitment against `registryActionLogRoot`; a fabricated `LaneRecord`
produces a different `persistentHash` than the on-chain event body and the
proof-verify assert fails at mirror-write time. The malicious write never
lands. Zero fund risk. Additional defense: the mirror-write circuit is
public — any honest keeper can outrun a malicious keeper by submitting the
correct write.

**(d) Malicious registry.** If TariffRegistry itself is compromised, all
bets are off — the registry can emit fabricated events and the mirror will
faithfully reflect them. This is out of scope for WI-14; it is the concern
of WI-13.1's federation-approval + charter-membership gates.

### 3.5 What WI-13.2 must expose

The design pass documents this so the WI-13.2 dispatch memo has a starting
surface. Not authored here; the executing session for WI-13.2 owns the
specifics.

- `RegistryActionEntry.payloadHash: Bytes<32>` — canonical hash of the
  event body for kinds 1 `LANE_REGISTERED`, 7 `LANE_RETIRED`,
  `SCHEDULE_REGISTERED`, `SCHEDULE_RETIRED`, and `retuneClass`. Precise
  payload for each kind: TBD in WI-13.2. For kind 1 the payload MUST
  include the full `LaneRecord` fields the mirror needs (all 12 of them).
- `registryActionLogRoot: Bytes<32>` ledger field — Merkle root over
  `_actionLog` entries, updated on every `emitAction` call. Or equivalent:
  a per-event `persistentHash` chain committed on-chain such that any
  event's inclusion in the log can be proven in-circuit.
- `getActionEntry(seq: Uint<64>): RegistryActionEntry` read circuit (or a
  more targeted `getActionPayloadHash(seq)`) — for keepers to fetch the
  authoritative event body.
- Domain-separation tag for the action-log commitment:
  `pp:tariff:v1:actionLogRoot` (author's suggestion; WI-13.2 owns final).

Coordinating dispatch: WI-13.2 → WI-14 vNext → deploy ceremony. WI-14 vNext
cannot be dispatched until WI-13.2 lands on `main`.

---

## §4. Circuit inventory

Complete enumeration of every circuit vNext exposes. Grouped by lineage.
Signatures given in Compact syntax; pre/post-conditions and invariants are
prose per row. Byte-exact circuit bodies are the next session's job — this
inventory is the shape.

### 4.1 Kept from v7.4.2 (identical signature, identical semantics)

| Circuit | Signature | Purpose | Invariants |
|---|---|---|---|
| `transferOwnership` | `(newOwner: Bytes<32>): []` | Multisig-gated owner rotation | L-1 (is_left guard) |
| `setMeterAuthority` | `(newAuthority: Bytes<32>): []` | Multisig-gated authority rotation | v7.4.2 |
| `attestProducerOwnership` | `(producerKey, wallet, ...): []` | Bind producer key ↔ wallet address | M-1 |
| `revokeProducerOwnership` | `(producerKey): []` | Revoke attestation | v7.4.2 |
| `getMeterAuthority` | `(): Bytes<32>` | Read | v7.4.2 |
| `getMarginPolicy` | `(): MarginPolicy` | Read (retained for external callers) | v7.4.2 |
| `getAttestation` | `(producerKey): ProducerAttestation` | Read | v7.4.2 |
| `totalSupply` | `(): Uint<128>` | Read | v7.4.2 |
| `transfer` | `(amount: Uint<128>, recipient: UserAddress): []` | Native unshielded send wrapper | v7 §5.2 |
| `claim` | (v7.4.2 signature) | LD claim (member-side) | I-14-H |
| `claimSplit` | (v7.4.2 signature) | LD split + bumpOnMint | I-14-H |

### 4.2 Modified from v7.4.2

| Circuit | v7.4.2 signature | vNext signature | What changes |
|---|---|---|---|
| `settle` | `(sessionID, hatSig, hatPubkey, kWh, producerKey, producerAddr, ...)` | `(sessionID, hatSig, hatPubkey, kWh, producerKey, producerAddr, scheduleId, classPath, fiatValueAtMint, epoch, laneRequest: LaneRequestVector, ...)` | (a) HAT payload widens to 5 fields including `producerAddr` (I-14-A); (b) mint recipients come from `_registeredLanesMirror` reads per `laneRequest`; (c) sum + overflow + dedup + remit-address + liveness checks fire in the settle body (I-14-C..K). Full spec in §5. |
| `redeem` | `(amount, redeemer, payoutRef, currentTime): []` | `(amount, redeemer, payoutRef, redemptionKind: Uint<8>, tariffPath: TariffPath, currentTime): []` | Adds `redemptionKind ∈ {KES, KWH}` and takes the coin's own `TariffPath` for per-coin fiat metadata (D-10). Solvency guard added (I-14-F). Full spec in §6. |
| `manualReissue` | v7.4.2 (M-4-hardened) | + `sourceTariffPath` copied to reissued output | Preserves `TariffPath` on reissue (I-14-E). Cap / cooldown / co-sign preserved unchanged from v7.4.2. |
| HAT verification helper | `verifyHat(...): Boolean` on 4-field payload | Same helper on 5-field payload | Domain-sep tag becomes `pollpower:ebt:vNext:epoch1`; payload adds `producerAddr` (I-14-A). |

### 4.3 Net-new for vNext (mirror-write surface)

| Circuit | Signature | Purpose | Invariants |
|---|---|---|---|
| `mirrorRegisterLane` | `(entry: RegistryActionEntry, laneRecord: LaneRecord, inclusionProof: EventProof): []` | Copy a registry `LANE_REGISTERED` event into `_registeredLanesMirror` | Mirror discipline; verifies event against `registryActionLogRoot` |
| `mirrorRetireLane` | `(entry: RegistryActionEntry, laneRecord: LaneRecord, inclusionProof: EventProof): []` | Copy a `LANE_RETIRED` event, overwrites the mirror with `retiredEpoch != 0` | Mirror discipline |
| `mirrorScheduleLifecycle` | `(entry: RegistryActionEntry, scheduleId: Bytes<32>, isLive: Boolean, inclusionProof: EventProof): []` | Copy `SCHEDULE_REGISTERED` / `SCHEDULE_RETIRED` events into `_scheduleLiveMirror` | Mirror discipline |
| `mirrorClassStatutoryTotal` | `(entry: RegistryActionEntry, scheduleId: Bytes<32>, classPath: Bytes<32>, statutoryTotalBps: Uint<16>, inclusionProof: EventProof): []` | Copy `retuneClass` (and initial-registration) events into `_classStatutoryTotalBpsMirror` | Mirror discipline |
| `mirrorActionLogHead` | `(newHeadSeq: Uint<64>, inclusionProof: EventProof): []` | Update `_registryActionLogHeadSeqMirror` scalar so the settle-time freshness check has a head to compare against | `LANE_MIRROR_STALE` machinery |

### 4.4 Net-new read helpers (in-circuit or off-chain)

| Circuit | Signature | Purpose | Notes |
|---|---|---|---|
| `resolveLanesMirror` | `(scheduleId, leviedBys: Vector<4, Bytes<32>>, laneKindBytes: Vector<4, Uint<8>>): Vector<4, LaneRecord>` | Byte-identical to WI-13.1 `resolveLanes` but reads the EBT-side mirror | Convenience; also invoked by `settle` inline |
| `isLaneActiveMirror` | `(scheduleId, leviedBy, laneKindByte): Boolean` | Byte-identical to WI-13.1 `isLaneActive` but reads the mirror | Must produce byte-identical results to registry `isLaneActive` at the same epoch |
| `getRegistryActionLogHeadSeq` | `(): Uint<64>` | Read the mirrored head seq | Diagnostic |

### 4.5 Retired from v7.4.2

The protocol-split setters and getters (`setBpsProducer`, `setBpsOperations`,
`setBpsDividend`, `setBpsDao`, `setOperationsRecipient`, `setDividendRecipient`,
`setDaoRecipient`) are removed. Settlement policy is now sourced from the
registered schedule; there is nothing for these to configure. Same for the
corresponding read circuits — `getBpsProducer` etc. are removed. Callers that
read them today (settlement-api, dashboard) need re-pointing to registry
reads. See §9 migration for the caller-side impact.

---

## §5. `settle` circuit design — the money circuit

Full sequential specification. Every step cites the invariant it enforces
and the error label it may raise. Body is prose + pseudocode; not Compact.

### 5.1 Inputs

```
circuit settle(
  // HAT bundle (5-field payload — I-14-A)
  sessionID:         Bytes<32>,
  hatSig:            HatSignature,
  hatPubkey:         Bytes<32>,
  kWh:               Uint<64>,
  producerKey:       Bytes<32>,
  producerAddr:      Bytes<32>,

  // Tariff path binding
  scheduleId:        Bytes<32>,
  classPath:         Bytes<32>,
  epoch:             Uint<64>,
  fiatValueAtMint:   Uint<64>,

  // Lane request — what the keeper claims are the live statutory lanes at
  // (scheduleId, classPath, epoch). Width 4 matches WI-13.1 resolveLanes.
  leviedBys:         Vector<4, Bytes<32>>,
  laneKindBytes:     Vector<4, Uint<8>>,

  // Split ceremony inputs (for the non-statutory portion of the class)
  ldRecipient:       UserAddress,   // living-dividend pool address
  opsRecipient:      UserAddress,   // ops split (WI-06 opsShareBps)

  // Timestamp for L-3 block-time validation
  currentTime:       Uint<64>,
): []
```

Note the deliberate absence of `_bpsProducer` etc. — splits come from the
registered schedule's `SplitShares` (mirrored) plus the resolved statutory
lanes (mirrored). The caller does not supply bps values.

### 5.2 Sequential body

```
1. PRE-CONDITIONS
   a. assert(_initialized)
   b. assert(kWh > 0)
   c. assert(!_settledSessions.member(sessionID))          // replay guard
   d. assert(blockTimeGte(currentTime))                    // L-3
   e. assert(currentTime <= disclose(now) + epsilon)       // L-3 (upper bound)

2. HAT VERIFICATION — I-14-A
   const payloadHash = persistentHash<Vector<6, Bytes<32>>>([
     pad(32, "pollpower:ebt:vNext:epoch1"),
     sessionID,
     hatPubkey,
     (kWh as Field) as Bytes<32>,
     producerKey,
     producerAddr,                                        // <-- I-14-A
   ]);
   assert(hatPubkey == _meterAuthorityPubkey);            // HAT signer is authority
   assert(verifySig(hatSig, hatPubkey, payloadHash));

3. PRODUCER ATTESTATION
   const att = producerAttestations.lookup(producerKey);
   assert(att.wallet == producerAddr);                    // I-14-A end-to-end
   assert(!att.revoked);

4. MIRROR FRESHNESS PRECHECK — LANE_MIRROR_STALE machinery per §3.3
   // The settle circuit does not know about registry events directly. It
   // asserts against the mirror's own head-tracker scalar. If the keeper
   // has not kept the head fresh, every settle fails until the head is
   // caught up via mirrorActionLogHead. This is the coarse guard; the
   // per-record guard is at step 8.
   const headSeq = _registryActionLogHeadSeqMirror.read();

5. SCHEDULE LIVENESS — I-14-B
   assert(_scheduleLiveMirror.member(scheduleId));
   assert(_scheduleLiveMirror.lookup(scheduleId) == true);
     // else: SCHEDULE_NOT_LIVE (label from v7.4.2 or new)

6. CLASS STATUTORY TOTAL — mirror lookup for I-14-K
   const cKey = classKey(scheduleId, classPath);
   assert(_classStatutoryTotalBpsMirror.member(cKey));
   const statutoryTotalBps = _classStatutoryTotalBpsMirror.lookup(cKey);
     // else: CLASS_NOT_LIVE

7. FIAT SANITY BAND — CAL-2
   assert(fiatValueAtMint >= CAL_2_FIAT_FLOOR);
   assert(fiatValueAtMint <= CAL_2_FIAT_CEIL);
     // CAL-2 placeholders; not resolved here.

8. LANE RESOLUTION (mirror read + per-slot verification)
   const laneVec: Vector<4, LaneRecord> =
     resolveLanesMirror(scheduleId, leviedBys, laneKindBytes);

   // Per-slot freshness (I-14 mirror discipline; LANE_MIRROR_STALE per §3.3)
   for i in 0..4:
     if (laneVec[i].scheduleId != zero32):
       // Populated slot — check freshness
       assert(laneVec[i].writeActionSeq >=
              headSeq - CAL_MIRROR_STALE_TOLERANCE);
         // else: LANE_MIRROR_STALE

9. DEDUP CHECK — I-14-J (LANE_DUP_KEY)
   // Fail-loud on duplicate (scheduleId, laneKindByte) pairs.
   // Since scheduleId is constant across the vector, dedup is on laneKindByte
   // among populated slots.
   for i in 0..4:
     for j in (i+1)..4:
       if (laneVec[i].scheduleId != zero32 &&
           laneVec[j].scheduleId != zero32):
         assert(laneVec[i].laneKindByte != laneVec[j].laneKindByte);
           // else: LANE_DUP_KEY

10. OVERFLOW CHECK — I-14-I (SCHEDULE_LANE_OVERFLOW)
    // The keeper is expected to enumerate all live statutory lanes for the
    // class. If the class has more than 4 live lanes, the keeper cannot
    // fit them into Vector<4>. Settle detects this by comparing the sum of
    // populated-live-slot bpsShares against statutoryTotalBps: if the sum
    // is < statutoryTotalBps AND there's no zero slot to absorb the
    // difference, we've overflowed. Cleaner detection: the keeper is
    // required to signal overflow explicitly by leaving all 4 slots
    // populated-live AND the sum-check in step 11 fails high. In practice:
    //
    //   if (populated-live-slot-count == 4 AND sum < statutoryTotalBps):
    //     fail SCHEDULE_LANE_OVERFLOW
    //
    // vs LANE_SUM_MISMATCH which fires when sum != statutoryTotalBps in
    // the < 4 case. Both are honest-keeper failures; overflow is a
    // schedule-lifecycle bug the operator must fix per I-14-I recovery.

11. LIVENESS + SUM — four-part predicate per v2 brief §LIVENESS PREDICATE;
    sum invariant I-14-K (LANE_SUM_MISMATCH)
    var statutorySum: Uint<32> = 0;
    var populatedLiveCount: Uint<8> = 0;
    for i in 0..4:
      const rec = laneVec[i];
      // Zero-record sentinel (v2 brief §INVARIANT DISCRIMINATOR RULES)
      if (rec.scheduleId == zero32):
        continue;                                          // skip empty slot
      populatedLiveCount += 1;
      // Four-part liveness
      assert(rec.retiredEpoch == 0 || rec.retiredEpoch > epoch);
      assert(rec.effectiveEpoch <= epoch);
      // (parent-schedule-live already checked at step 5)
      // On-chain-remit address guard — I-14-D (LANE_REMIT_ADDR_ZERO_ON_CHAIN)
      if (rec.remittanceMode == 1):
        assert(rec.remitAddress != zero32);
      statutorySum += rec.bpsShare;
    assert(statutorySum == statutoryTotalBps);              // I-14-K

12. NON-STATUTORY SPLIT COMPUTATION
    // The class's SplitShares (mirrored under _classSplitSharesMirror if we
    // choose to mirror the full ClassEntry.bps, otherwise recovered from
    // schedule-side reads) gives us the LD / ops / DAO / operatorMargin
    // components. For this design cut we mirror only statutoryTotalBps and
    // require the caller to pass the four remaining bps values as inputs;
    // the settle circuit re-checks their sum == 10000 - statutoryTotalBps.
    //
    // Rationale: the LD / ops / DAO / operatorMargin values are relatively
    // stable and the caller (producer's wallet client) can supply them from
    // its off-chain schedule cache. If they drift from the registry, the
    // sum check fails and settle reverts. This keeps the mirror surface
    // narrow at the cost of one more caller input; the alternative is
    // mirroring the full SplitShares struct which balloons the mirror. The
    // executing session may reverse this at implementation time — flag it
    // in §11 as an open decision.
    //
    // For now:
    //   input to settle: ldBps, opsBps, daoBps, operatorMarginBps
    //   assert(ldBps + opsBps + daoBps + operatorMarginBps + statutoryTotalBps == 10000)
    //     // I-14-C

13. MINT — one output per lane + LD + ops + (DAO if configured) + producer
    // Per v7.4.2 (§5.1 in V7-DESIGN.md) via mintUnshieldedToken. Producer
    // gets what remains after all shares.
    const producerBps = operatorMarginBps;  // producer-share is the operator margin
    const totalAmount = kWh;                 // 1 EBT = 1 kWh (I-1)
    const ldAmt   = (kWh * ldBps  ) / 10000;
    const opsAmt  = (kWh * opsBps ) / 10000;
    const daoAmt  = (kWh * daoBps ) / 10000;
    const prodAmt = (kWh * producerBps) / 10000;
    // Statutory lane amounts (per lane):
    // laneAmt[i] = (kWh * laneVec[i].bpsShare) / 10000
    // Sum of laneAmt[i] equals (kWh * statutoryTotalBps) / 10000.
    // Note the division above is witness-computed divmod + checkedDivide
    // per Compact discipline §0.2 (no integer / in-circuit).
    //
    // Mint calls (all through mintUnshieldedToken with
    // domainSep = pad(32, "pollpower:ebt:vNext:epoch1")):
    mintUnshielded(prodAmt, producerAddr);
    mintUnshielded(ldAmt,   ldRecipient);
    mintUnshielded(opsAmt,  opsRecipient);
    if (daoBps > 0) mintUnshielded(daoAmt, DAO_ADDR_FROM_SCHEDULE);
    for i in 0..4:
      const rec = laneVec[i];
      if (rec.scheduleId == zero32) continue;
      // Fiat-door (mode==0): DO NOT mint on-chain. The keeper handles it
      // off-chain against the fiat door; the amount is enumerated in the
      // sum check (I-14-K) but no mint call fires.
      if (rec.remittanceMode == 0) continue;
      const laneAmt = (kWh * rec.bpsShare) / 10000;
      mintUnshielded(laneAmt, rec.remitAddress);

14. STATE UPDATES + LD BINDING — I-14-H
    _totalSupply = _totalSupply + totalAmount;
    _settledSessions.insert(sessionID);
    settlementCount.increment(1);
    // LD binding: bumpOnMint follows v7.4.2 shape (Session 9's
    // recipient-filter fix already lives in the keeper; the mint entry we
    // emit must carry the ld recipient in its recipient field so the
    // keeper's contract-scope filter continues to work).
    _dividendMintedLog.insert(seq, DividendMintedEntry {
      amount: ldAmt,
      recipient: ldRecipient,
      // ...v7.4.2 shape preserved
    });

15. EVENT EMISSION — tariff-path in event body per §2.3
    emitAction(kind = SETTLE, payload = TariffPath {
      scheduleId, classPath, epoch, fiatValueAtMint
    }, ...v7.4.2 fields);
```

### 5.3 Error labels raised

The following labels MUST appear verbatim in the settle body's assert
messages. Test suites will pin against these strings.

- `SCHEDULE_NOT_LIVE` — step 5 (v7.4.2 or new; label locked at implementation time)
- `CLASS_NOT_LIVE` — step 6
- Fiat-band label (from CAL-2) — step 7
- `LANE_MIRROR_STALE` — step 8 (per §3.3)
- `LANE_DUP_KEY` — step 9 (I-14-J)
- `SCHEDULE_LANE_OVERFLOW` — step 10 (I-14-I)
- `LANE_REMIT_ADDR_ZERO_ON_CHAIN` — step 11 (I-14-D)
- `LANE_SUM_MISMATCH` — step 11 (I-14-K)
- `WHOLE_CLASS_SUM_MISMATCH` — step 12 (I-14-C, label author's choice)
- v7.4.2 labels for HAT / attestation / replay preserved.

### 5.4 Invariants enforced by settle

I-14-A (HAT payload includes producerAddr — step 2)
I-14-B (schedule-path exists, live — steps 5, 6, 8)
I-14-C (whole class sums to 10000 — step 12)
I-14-D (on-chain-remit address non-zero — step 11)
I-14-E (per-coin fiat metadata written at mint — step 15)
I-14-G (drain-window check — step 3's `att.revoked` extended to operator status; details for the executing session)
I-14-H (LD binding shape preserved — step 14)
I-14-I (overflow — step 10)
I-14-J (dedup — step 9)
I-14-K (statutory sum — step 11)

I-14-F is a `redeem` invariant, not `settle`. See §6.

---

## §6. `redeem` circuit design

Dual redemption per D-10 + WI-01 D-5..D-9. Coin's own `TariffPath` drives
the per-coin fiat obligation.

### 6.1 Inputs

```
circuit redeem(
  amount:          Uint<128>,      // EBT base units to burn
  redeemer:        Bytes<32>,      // holder identity for the audit log
  payoutRef:       Bytes<32>,      // off-chain payout correlation id
  redemptionKind:  Uint<8>,        // 0 = KES, 1 = KWH
  tariffPath:      TariffPath,     // coin's own metadata (§2.3) — I-14-E
  currentTime:     Uint<64>,
): []
```

### 6.2 Sequential body

```
1. PRE-CONDITIONS
   assert(_initialized);
   assert(amount > 0);
   assert(redemptionKind == 0 || redemptionKind == 1);
   assert(blockTimeGte(currentTime));

2. BALANCE CHECK
   const color = tokenType(pad(32, "pollpower:ebt:vNext:epoch1"), kernel.self());
   assert(unshieldedBalanceGte(color, amount));

3. TARIFF-PATH VALIDATION — I-14-E
   // The caller supplies the coin's TariffPath; the coin was minted with it
   // (settle step 15). We validate the path against the currently-active
   // schedule state — a coin whose scheduleId has been retired since mint is
   // still redeemable (retirement doesn't invalidate outstanding coins) but
   // its fiatValueAtMint is fixed at mint-time (I-14-E).
   //
   // The path itself is not re-hashed against a coin identifier because
   // Compact unshielded tokens don't give us per-coin identity; the settle-time
   // event log is the audit trail.

4. FIAT SANITY BAND — CAL-2 (again — redemption side)
   assert(tariffPath.fiatValueAtMint >= CAL_2_FIAT_FLOOR);
   assert(tariffPath.fiatValueAtMint <= CAL_2_FIAT_CEIL);

5. SOLVENCY GUARD — I-14-F (KES only)
   if (redemptionKind == 0):  // KES
     // Compute the KES obligation this redemption would create.
     // amount * fiatValueAtMint gives KES base units (with CAL-2 units
     // agreed at ceremony).
     const kesObligation = amount * tariffPath.fiatValueAtMint;
     // The escrow's trust-float commitment lives off-chain (D-8 published
     // solvency invariant). vNext cannot read escrow state in-circuit;
     // instead, redeem carries a witness proof of trust-float sufficiency
     // from the escrow's attestation channel.
     //
     // Concretely: an `EscrowSolvencyAttestation` struct carrying
     // (attestedTrustFloat: Uint<128>, attestedOutstandingEbt: Uint<128>,
     // attestationSig: Signature, attestationEpoch: Uint<64>) is a witness
     // input; the circuit verifies the sig against a
     // _escrowAttestorPubkey ledger field (new — set at constructor time,
     // rotated via multisig-gated setter) and asserts:
     //   attestedTrustFloat >= attestedOutstandingEbt + kesObligation
     //     // else: SOLVENCY_GUARD_FAILED (I-14-F)
     // and:
     //   attestationEpoch >= currentTime - CAL_ESCROW_STALE_TOLERANCE
     //     // else: ESCROW_ATTESTATION_STALE

6. BURN
   sendUnshielded(color, amount, BURN_SINK);
   _totalSupply = _totalSupply - amount;

7. AUDIT LOG
   const entry = RedemptionEntry {
     redeemer, amount, payoutRef, redeemedAt: currentTime,
     tariffPath,                                          // I-14-E persisted
     redemptionKind,
   };
   _redemptionLog.insert(_redemptionCount.read(), entry);
   _redemptionCount.increment(1);

8. EVENT EMISSION
   emitAction(kind = REDEEM, payload = entry, ...);
```

### 6.3 KWH redemption

The `KWH` branch is intentionally underspecified here. WI-01 D-5..D-9
describe the kWh delivery path from the operator side; the on-chain shape
for a kWh redemption is a burn + delivery-attestation lookup + delivery-log
write. Whether this belongs in the same `redeem` circuit with a switch, or
splits into a companion `redeemForKwh` circuit, is a design decision the
supervising session at dispatch may want to revisit. Recommendation: keep
them in one circuit for API simplicity, branch on `redemptionKind`, and
defer the kWh-side witness plumbing to a follow-up when the operator-side
kWh delivery attestation channel is more concrete.

### 6.4 Escrow attestor pubkey — new ledger field

```
export ledger _escrowAttestorPubkey: Bytes<32>;
```

Set at constructor time. Rotated via a multisig-gated setter
(`setEscrowAttestorPubkey`, same shape as `setMeterAuthority`). This is the
trust anchor for the solvency guard's witness proof (§6.2 step 5).

### 6.5 Error labels raised

- `INSUFFICIENT_BALANCE` — step 2 (v7.4.2 label preserved)
- Fiat-band label — step 4
- `SOLVENCY_GUARD_FAILED` — step 5 (I-14-F)
- `ESCROW_ATTESTATION_STALE` — step 5
- v7.4.2 labels for time / init preserved.

---

## §7. Mirror-write circuits

Five mirror-write circuits, one per event kind in scope, plus the head-seq
tracker. Each follows the same shape: accept the registry event body,
verify against `registryActionLogRoot`, write the mirror.

### 7.1 Common witness — `EventProof`

```
struct EventProof {
  actionSeq:      Uint<64>,       // registry _actionLog sequence number
  payloadHash:    Bytes<32>,      // hash of the event body (I-14-A style)
  merkleProof:    Vector<D, Bytes<32>>,  // D = registry action-log depth (WI-13.2 output)
  merkleSiblings: Vector<D, Bool>,       // path bits
}
```

Verification (in every mirror-write circuit):

```
circuit verifyEventProof(
  entry:       RegistryActionEntry,     // WI-13.1 struct
  proof:       EventProof,
): [] {
  const computedHash = persistentHash<...>(entry fields);
  assert(computedHash == proof.payloadHash);
  // Reconstruct merkle root from (payloadHash, merkleProof, merkleSiblings)
  const reconstructedRoot = reconstructRoot(proof);
  assert(reconstructedRoot == _registryActionLogRootMirror.read());
    // else: EVENT_PROOF_INVALID
}
```

`_registryActionLogRootMirror: Bytes<32>` is a scalar ledger field on EBT,
mirrored from TariffRegistry's `registryActionLogRoot` by a thin
`mirrorActionLogRoot(newRoot, oldEntry: RegistryActionEntry, proof:
EventProof)` circuit whose auth model is the same event-inclusion check
applied to the root-transition event. (Bootstrap of this mirror is a
deploy-ceremony concern — the initial value is set at constructor time from
TariffRegistry's post-WI-13.2 state.)

### 7.2 `mirrorRegisterLane`

```
circuit mirrorRegisterLane(
  entry:        RegistryActionEntry,
  laneRecord:   LaneRecord,
  proof:        EventProof,
): [] {
  assert(entry.kind == 1);                                 // LANE_REGISTERED
  verifyEventProof(entry, proof);
  // Cross-check the LaneRecord fields against the event payload
  const recHash = persistentHash<...>(laneRecord fields);
  assert(recHash == entry.payloadHash);                    // wired to WI-13.2
  // Write mirror
  const key = laneKey(laneRecord.scheduleId, laneRecord.leviedBy,
                      laneRecord.laneKindByte);
  // Attach mirror-write bookkeeping
  const mirrored = MirroredLaneRecord {
    record:          laneRecord,
    writeActionSeq:  proof.actionSeq,
  };
  _registeredLanesMirror.insert(key, mirrored);
}
```

Note the wrapping struct `MirroredLaneRecord` — the mirror stores the raw
`LaneRecord` plus a `writeActionSeq` for the §3.3 freshness check. §2.2's
type signature is simplified; the real Compact declaration is `Map<Bytes<32>,
MirroredLaneRecord>`.

### 7.3 `mirrorRetireLane`

Same shape as `mirrorRegisterLane` but expects `entry.kind == 7`
(`LANE_RETIRED`). Overwrites the existing mirror entry with the retired
version (`retiredEpoch != 0`). Does not delete — retired records stay in
the mirror to preserve the four-part liveness predicate's ability to
distinguish retired from never-registered.

### 7.4 `mirrorScheduleLifecycle`

Handles both `SCHEDULE_REGISTERED` and `SCHEDULE_RETIRED` events. Writes
`_scheduleLiveMirror[scheduleId] = true` or `false` respectively.

### 7.5 `mirrorClassStatutoryTotal`

Handles `retuneClass` events. Writes `_classStatutoryTotalBpsMirror` at
`classKey(scheduleId, classPath) → statutoryTotalBps`. Also handles the
initial `SCHEDULE_REGISTERED` event (which for a fresh schedule may carry
zero classes; the class entries populate via subsequent `retuneClass`
calls per WI-13.1).

### 7.6 `mirrorActionLogHead`

```
circuit mirrorActionLogHead(
  newHeadSeq:   Uint<64>,
  proof:        EventProof,       // proof that newHeadSeq is the current head
): [] {
  // Assert monotonicity
  assert(newHeadSeq > _registryActionLogHeadSeqMirror.read());
  // Verify against registry state — the proof shape may differ from
  // per-event proofs (head is a scalar, not an event); WI-13.2 will spec
  // a getActionLogHeadSeq() commitment path.
  verifyHeadProof(newHeadSeq, proof);
  _registryActionLogHeadSeqMirror = newHeadSeq;
}
```

The keeper is expected to call this circuit at the top of every settle
batch. If it doesn't, `LANE_MIRROR_STALE` starts firing at settle time.

### 7.7 Public callable

All five circuits are PUBLIC — anyone can submit a mirror-write. This is
intentional: it means the mirror can be repaired by any honest actor if
the primary keeper is offline or misbehaving. There is no auth check on
the caller; the auth is entirely on the event proof.

---

## §8. Read-only helper circuits

Semantic parity with WI-13.1's registry-side reads, backed by the mirror.

### 8.1 `resolveLanesMirror`

Byte-identical signature to WI-13.1's `resolveLanes`:

```
circuit resolveLanesMirror(
  scheduleId:    Bytes<32>,
  leviedBys:     Vector<4, Bytes<32>>,
  laneKindBytes: Vector<4, Uint<8>>,
): Vector<4, LaneRecord>
```

Body: read the four `laneKey` entries from `_registeredLanesMirror`,
returning the zero-record sentinel `LaneRecord` (all fields zero — same
shape as WI-13.1 uses) for absent keys. Unwraps `MirroredLaneRecord` to
return the raw `LaneRecord` — the `writeActionSeq` bookkeeping is not part
of the semantic interface.

This helper is invoked inline by `settle` (§5.2 step 8). Its public
availability lets off-chain simulators, dashboard reads, and audit tools
query the mirror without duplicating the read logic.

### 8.2 `isLaneActiveMirror`

Byte-identical signature to WI-13.1's `isLaneActive`:

```
circuit isLaneActiveMirror(
  scheduleId:   Bytes<32>,
  leviedBy:     Bytes<32>,
  laneKindByte: Uint<8>,
): Boolean
```

Must produce byte-identical results to registry `isLaneActive` at the same
epoch, when the mirror is fresh. Body implements the four-part liveness
predicate against the mirrored `LaneRecord` and `_scheduleLiveMirror`:

```
1. key = laneKey(scheduleId, leviedBy, laneKindByte)
2. if (!_registeredLanesMirror.member(key)) return false
3. rec = _registeredLanesMirror.lookup(key).record
4. if (rec.retiredEpoch != 0) return false
5. if (!_scheduleLiveMirror.member(scheduleId)) return false
6. if (_scheduleLiveMirror.lookup(scheduleId) == false) return false
7. return _currentEpoch.read() >= rec.effectiveEpoch
```

Step 7's `_currentEpoch` is a new ledger scalar on EBT, updated via a
keeper circuit that carries an inclusion proof against a registry epoch
commitment. (Alternative: settle takes the epoch as an input and asserts
it against a mirrored `_epochBound`. The executing session picks the
cleaner shape at implementation time — flagged in §11.)

### 8.3 `getRegistryActionLogHeadSeq`

```
circuit getRegistryActionLogHeadSeq(): Uint<64>
```

Read the mirrored head seq. Diagnostic; used by off-chain callers to
assess mirror freshness before submitting a settle.

### 8.4 `settleSimulate` — out of scope for this cut

A `settleSimulate` circuit would re-execute `settle`'s validation without
minting, so callers can preview success/failure and inspect the exact
error label. Useful but not required for the settle circuit itself.
Deferred to a follow-up.

---

## §9. Migration from v7.4.2

vNext is a fresh contract deployment with a new address, a new token color
(different `domainSep`), and a new state layout. Existing v7.4.2 EBT does
NOT automatically move.

### 9.1 Recommendation: parallel deployment, sunset schedule for v7.4.2

Three candidate paths were considered:

**(a) Fresh mint, no migration.** vNext deploys alongside v7.4.2. v7.4.2
stays live for redemption of existing coins; no new mints go through it.
All new settlement flows through vNext. v7.4.2 sunset triggers when its
supply drains to zero (or is close to zero and the remainder is
administratively bought back).

**(b) Burn-and-remint bridge.** A one-shot migration circuit lets
v7.4.2 holders burn their coins and receive vNext coins at 1:1. Requires
the bridge to have mint authority on vNext (delegated at ceremony),
requires holders to actively participate, requires an off-chain campaign
to drive migration.

**(c) Claim-based migration.** Snapshot v7.4.2 supply at a cutover epoch,
deploy vNext with a claim map, holders claim their new coins by proving
ownership of the old coins. Similar to (b) but with a proof-based claim
instead of an active burn.

**Recommendation: (a) parallel deployment.**

Why:

- The pilot supply is small enough (five consumers, one producer per
  MEMORY.md status) that a sunset-by-drain approach is operationally
  feasible. The five consumers can redeem their v7.4.2 coins and receive
  new v7.4.2 mints in the last pre-cutover settle, or accept a
  parallel-holdings period.
- (b) and (c) both require ceremony-level setup on vNext's mint authority
  (a bridge with delegated mint is a bigger surface than we want on a
  contract whose main job is to make sure only HAT-attested settles can
  mint).
- The v7.4.2 audit hardening (M-4 cap/cooldown/co-sign on manualReissue,
  L-1 ownership guard, L-3 timestamp validation) is preserved into vNext
  by construction — (a) doesn't risk regressing those.
- (a) sidesteps the §2.3 non-goal tension: v7.4.2 doesn't have per-coin
  tariff-path metadata, so migrating supply forward would leave every
  migrated coin without a `fiatValueAtMint`. Simpler to say: v7.4.2 coins
  redeem under v7.4.2 rules; vNext coins redeem under D-10 per-coin fiat
  rules. Clean partition.

### 9.2 Sunset schedule

Proposed:

1. **T+0 (vNext deploy ceremony):** deploy vNext. Switch settlement-api to
   point new attestations at vNext. Legacy v7.4.2 accepts no new attests.
2. **T+1 to T+30 days:** parallel-hold period. Holders may redeem v7.4.2
   coins as normal. New settles go to vNext.
3. **T+30:** administrative pass. Any residual v7.4.2 supply is
   ackowledged; supply typically small.
4. **T+90:** v7.4.2 deprecation notice; deploy addresses documented as
   redeem-only. No further settles possible.
5. **T+180:** v7.4.2 status = archive. Redemption still callable indefinitely
   (contracts don't shut down); off-chain tooling stops pointing at it by
   default.

Garrett + supervising session own the final schedule; this is a starting
draft.

### 9.3 Caller-side impact

Settlement-api, dashboard, consumer/producer apps all currently key off
v7.4.2's contract address + protocol-split reads. Migration to vNext
requires:

- **settlement-api**: attests to vNext instead of v7.4.2. HAT payload
  widens (add producerAddr). Fetch splits from tariff-registry (via
  keeper-mirror events or directly) rather than from v7.4.2's retired
  setters. See MEMORY.md 2026-07-05 for how the v7.3→v7.4.2 retarget
  batched off-chain callers — same pattern applies here.
- **keeper (session-3 batch-payer)**: `_dividendMintedLog` shape
  preserved (I-14-H); Session 9's recipient-filter fix continues to work.
  Keeper reads from vNext contract address.
- **dashboard**: read `unshieldedBalance(vNextColor)` for balances; drop
  the retired split-getter reads.
- **consumer/producer apps**: same balance-read change; redemption UI
  needs `redemptionKind` + `TariffPath` inputs.

See `VNEXT-MIGRATION.md` (to be authored under the vNext PR, per v2 brief
§DELIVERABLE) for the caller-side runbook.

---

## §10. Test scaffold

Map of v2 brief's T1–T18 to concrete test files. All tests live in
`ebt/tests/`, mirror v7.4.2's offline-tests layout (TypeScript,
deterministic, no network).

### 10.1 Test file layout

```
ebt/tests/
  vnext/
    fixtures/
      registry-events.ts         // synthetic RegistryActionEntry fixtures
      lane-records.ts            // synthetic LaneRecord fixtures per T-case
      escrow-attestations.ts     // synthetic solvency-attestation fixtures
      schedules.ts               // 4-lane fixture, overflow fixture, mixed-mode fixture
    T01-happy-path.test.ts
    T02-dual-redemption.test.ts
    T03-reissue-preserves-metadata.test.ts
    T04-mint-redirection-fails.test.ts
    T05-unregistered-schedule-fails.test.ts
    T06-retired-schedule-fails.test.ts
    T07-sum-mismatch.test.ts
    T08-onchain-remit-zero-addr.test.ts
    T09-solvency-guard.test.ts
    T10-defederated-operator.test.ts
    T11-ld-binding-regression.test.ts
    T12-property-schedules-splits.test.ts
    T13-schedule-lane-overflow.test.ts
    T14-lane-dup-key.test.ts
    T15-dropped-lane-under-enum.test.ts
    T16-mirror-stale.test.ts
    T17-zero-sentinel-discipline.test.ts
    T18-fiat-and-onchain-siblings.test.ts
    helpers/
      mirror-warm.ts              // build a well-formed mirror state from event fixtures
      settle-driver.ts            // parameterized settle harness
      redeem-driver.ts
```

### 10.2 Test-to-invariant map

| Test | Proves | Error label | Notes |
|---|---|---|---|
| T01 | End-to-end happy path | (none — positive) | Confirms mint output count, LD `bumpOnMint` fires |
| T02 | Dual redemption per-coin fiat | (none — positive) | KES + KWH siblings against different `fiatValueAtMint` |
| T03 | I-14-E | (none) | Reissue preserves TariffPath byte-for-byte |
| T04 | I-14-A | HAT sig failure label | Observer takes valid HAT, submits with wrong producerAddr, MUST fail |
| T05 | I-14-B | `SCHEDULE_NOT_LIVE` (or class equiv) | Schedule missing from mirror |
| T06 | I-14-B | `SCHEDULE_NOT_LIVE` | Schedule mirrored as `live == false` |
| T07 | I-14-K | `LANE_SUM_MISMATCH` | Property test, 1000 crafted vectors summing to 9999 or 10001 |
| T08 | I-14-D | `LANE_REMIT_ADDR_ZERO_ON_CHAIN` | On-chain-remit lane with zero remitAddress. Also confirms fiat-door sibling doesn't trip |
| T09 | I-14-F | `SOLVENCY_GUARD_FAILED` | Trust float at boundary + one unit over |
| T10 | I-14-G | (v7.4.2 label or new) | De-federated operator cannot start new settle; in-flight completes |
| T11 | I-14-H | (none — shape check) | `_dividendMintedLog` bytes identical to v7.4.2 for same inputs; keeper contract-scope filter still works |
| T12 | I-14-C + I-14-K + I-14-H | (none) | Property test, 1000 random schedules, all three invariants hold simultaneously |
| T13 | I-14-I | `SCHEDULE_LANE_OVERFLOW` | 5-lane schedule warm; settle fails; retire-and-replace to 4-lane succeeds |
| T14 | I-14-J | `LANE_DUP_KEY` | Duplicate `(leviedBy, laneKindByte)` in request vector |
| T15 | I-14-K | `LANE_SUM_MISMATCH` | Keeper drops a lane; under-enumeration detected |
| T16 | Mirror discipline | `LANE_MIRROR_STALE` | Emit `LANE_RETIRED` event, don't run mirror-write, settle fails |
| T17 | Zero-record sentinel | (positive) | 2 real + 2 zero slots in vector; settle succeeds; NEGATIVE cross-check: real record with `bpsShare == 0` NOT treated as sentinel |
| T18 | I-14-D siblings | (positive on fiat-door, no trip) | fiat-door + on-chain-remit siblings on same schedule; on-chain routes, fiat-door doesn't |

### 10.3 Property-test discipline

T07 and T12 both fuzz. `fast-check` (or equivalent) at 1000 runs each,
seed pinned in the test file so failures are reproducible. Property
generators live in `ebt/tests/vnext/fixtures/` next to the fixtures they
underlie.

### 10.4 Fixtures

`schedules.ts` should carry at least these baseline fixtures:

- **KenyaStandardStack**: 4-lane statutory (VAT + REP + EPRA + WARMA) at
  realistic bps values, `remittanceMode == 1` for all four. Used by T01,
  T02, T11, T12.
- **OverflowStack**: 5 statutory lanes on a single schedule (feeds T13's
  overflow trigger; 5th lane cannot be enumerated in Vector<4>).
- **MixedModeStack**: 1 fiat-door lane (`mode==0, remitAddress==0`) + 1
  on-chain-remit lane (`mode==1, remitAddress=non-zero`). Feeds T18.
- **ZeroBpsInformationalStack**: a real lane with `bpsShare == 0` (e.g. an
  informational statutory tag with no routing). Feeds T17's cross-check.
- **RetiredParentSchedule**: schedule marked retired in mirror. Feeds T06.

### 10.5 Deferred: on-chain integration tests

The offline suite is the primary review gate per v2 brief §ACCEPTANCE
CRITERIA. On-chain integration tests against Preview follow after the
full-ZK compile transcript lands in the PR. That's a separate item;
test scaffold here is offline only.

---

## §11. Open questions / escalation triggers hit during design

Every design decision here that isn't fully anchored in the v2 brief or
WI-13.1's exports is listed. Reviewers: this is the priority list for
your attention before dispatch to `.compact` authoring.

### 11.1 Hard escalations (require Garrett + supervising-session decision before dispatch)

**E-1. Mirror freshness mechanism blocks on WI-13.2 amendment.** §3's
recommendation of option (iii) requires TariffRegistry to expose
`registryActionLogRoot` and widen `RegistryActionEntry.payloadHash` for
five event kinds. This is a WI-13.1 amendment (WI-13.2). WI-14 vNext
cannot be dispatched to `.compact` authoring until WI-13.2 lands on
`main`. Dispatch ordering: WI-13.2 dispatch → WI-13.2 merge → WI-14
vNext dispatch → vNext merge → deploy ceremony. This corresponds to
v2 brief §ESCALATION TRIGGERS #7.

**E-2. CAL-vNext-M1 (mirror stale tolerance).** §3.3 introduced a
calibration placeholder for the `LANE_MIRROR_STALE` window. **RESOLVED
2026-07-27 at 32 events** (alert at 16 = 50% lag; raise to 64 before
mainnet Phase 2) per [`WI-14-CEREMONY-SKELETON.md`](./WI-14-CEREMONY-SKELETON.md)
§9 CAL-2. Corresponds to v2 brief §CALIBRATION PLACEHOLDERS.

**E-3. CAL-vNext-M2 (escrow attestation stale tolerance).** §6.2 step 5
introduces a similar tolerance for the escrow solvency attestation
freshness. Not resolved.

**E-4. Version label (v7.5 vs v8).** v2 brief §DELIVERABLE explicitly
defers this to the supervising session at dispatch. Design pass
recommendation: **v8**. Rationale: HAT payload widening + new ledger
fields + new mint recipients + retired setters is not additive. But the
final call is not the design pass's.

**E-5. Migration path.** §9 recommends (a) parallel deployment with a
30/90/180 day sunset. Garrett + supervising-session own the final path
per v2 brief §DO NOT ("DO NOT let the migration decision be made by the
executing session").

### 11.2 Design decisions made without full brief anchor (flag for reviewer sanity check)

**D-1. SplitShares mirroring is partial.** §5.2 step 12 mirrors only
`statutoryTotalBps` on the class side, not the full `SplitShares` struct
(LD / ops / DAO / operatorMargin bps values). The caller supplies the
four non-statutory bps values as settle inputs and the circuit re-checks
their sum against `10000 - statutoryTotalBps`. Rationale: narrower
mirror surface; the four values are relatively stable per schedule. But
this puts trust in the caller to supply values consistent with the
registered schedule, and drift is only caught via the sum check
(not a direct comparison). Alternative: mirror the full `SplitShares` +
add four more mirror-writes on `retuneClass`. Executing session may
reverse this. FLAG for review.

**D-2. Epoch source (mirrored ledger vs settle input).** §8.2 step 7
calls out that `_currentEpoch` needs to live on EBT (mirrored from
registry or from the operator's own epoch clock). Two shapes possible:
(a) EBT maintains `_currentEpoch: Uint<64>` and a `bumpEpoch` circuit
verifying against a registry-side epoch commitment; (b) `settle` takes
epoch as an input and validates against a mirrored `_epochBound` scalar.
Design pass leans (a) for symmetry with the other mirrored state, but
did not lock it. Executing session picks at implementation time.

**D-3. `redeem` KWH branch.** §6.3 explicitly underspecifies the kWh
redemption. Delivery-attestation channel design is downstream (WI-01
D-5..D-9) and the on-chain shape depends on it. Decision deferred.

**D-4. Mirror-write authentication is proof-only, no per-caller check.**
§7.7 makes mirror-writes public (anyone can submit). This is a
deliberate choice: public writes mean the mirror is repairable by any
honest actor. But it means a spammy caller can burn gas by re-submitting
valid mirror writes redundantly. Mitigation: idempotency — the
mirror-write circuits should be no-ops (assert-equal) if the mirror
already reflects the event at the given actionSeq. Flag for the
executing session to implement.

**D-5. `_dividendMintedLog.recipient` is set to the LD pool address.**
§5.2 step 14 preserves v7.4.2's shape here. Session 9's
contract-scope filter on the keeper reads this recipient field to scope
log entries to the correct LD binding. FLAG for review: confirm the
executing session doesn't inadvertently change `recipient` in the mint
event shape — this is a keeper-facing regression risk.

### 11.3 Calibration placeholders inherited from v2 brief

| CAL | Where used in vNext |
|---|---|
| CAL-1 | LD floor / ops floor (via schedule-registered SplitShares) |
| CAL-2 | Fiat-value sanity band at settle (§5.2 step 7) and redeem (§6.2 step 4) |
| CAL-8 | Statute-to-lane ceremony parameters (reference only) |
| CAL-11 | Remittance default shaping I-14-D mode-conditional guard |
| CAL-vNext-M1 | Mirror stale tolerance (§3.3, new in this design pass) |
| CAL-vNext-M2 | Escrow attestation stale tolerance (§6.2, new in this design pass) |

All six unresolved. Executing session marks with `TODO(calibration)`,
does NOT resolve.

### 11.4 Cross-brief coherence to re-check at dispatch

- v2 brief §KEEPER MIRROR CONTRACT lists five event kinds requiring
  mirror updates: kinds 1, 7, `SCHEDULE_REGISTERED`, `SCHEDULE_RETIRED`,
  `retuneClass`. All five have mirror-write circuits designed in §7.
  Confirm at dispatch that WI-13.1 emits all five as-listed, and that
  WI-13.2's payload widening covers all five.
- v2 brief §INVARIANTS THAT MUST HOLD lists I-14-A through I-14-K.
  This design pass covers A/B/C/D/E/F/G/H/I/J/K. Confirm coverage at
  dispatch.
- v2 brief §ERROR LABELS lists five WI-14-specific labels. This design
  pass raises all five (plus v7.4.2 preserved labels + one new solvency
  label `SOLVENCY_GUARD_FAILED` + one new escrow-freshness label
  `ESCROW_ATTESTATION_STALE`). Reviewer may want the two new labels
  added to the v2 brief's normative table.

---

*Design pass authored 2026-07-17 against `dispatch-briefs/WI-14-EBT-vNext-v2.md`.
No `.compact` code written; this is the design of record for the next
session's authoring. Two BIG-review passes required at PR time per v2 brief
§ACCEPTANCE CRITERIA §3.*
