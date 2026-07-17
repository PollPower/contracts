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

`CAL_MIRROR_STALE_TOLERANCE` becomes a new calibration placeholder
(CAL-vNext-M1 — resolved by Garrett + supervising session before ceremony,
not by the executing session). Recommended draft value: 4. That is, the
keeper has room to submit up to 4 registry-event-lag before the settle
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
