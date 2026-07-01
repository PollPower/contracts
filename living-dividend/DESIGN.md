# Living Dividend Contract — Design Rationale

**Status:** Design-locked, compile-clean, awaits deploy ceremony.
**Related:** [ADR-019](../../pollpower-internal-docs/memory/ADR-019-living-dividend.md)
(PollPower internal), [ADR-018 (unshielded EBT)](../ebt/README.md),
[EBT v7 design](../ebt/V7-DESIGN.md), [V7.1 event diff](../ebt/V7.1-EVENT-DIFF.md).

## What this document is

The architectural decisions behind
[`living-dividend-v1.compact`](./living-dividend-v1.compact) and the
reasoning that drove them. Read this first if you want to understand
*why* the contract looks the way it does.

## Design decisions locked

### 1. Integration surface with EBT v7 — MIP-0002 events + keeper

**Constraint:** Contract-to-contract calls are not yet supported in
Compact (confirmed via Midnight's own docs and OpenZeppelin's
`MultiToken` disclaimers). A pure synchronous "v7 calls LD.bumpOnMint()"
design is impossible today.

**Solution:** MIP-0002 landed in midnight-js on 2026-06-30, verifying the
`emit → indexer contract-events` loop end-to-end. This gives us
event-driven integration:

- v7.1 emits a `DividendMinted` event inside `settle()`, at the same
  atomic moment the dividend slice mints. Both succeed or both revert.
- A keeper service subscribes to the event via the indexer.
- Keeper calls `LD.bumpOnMint(sourceTxSalt, amount, currentTime)` with an
  idempotency guard.

**The salt is computed in-circuit** from
`hash("pollpower:dividend:v7.1", sessionID, currentTime)`. Because v5.2's
replay guard already enforces sessionID uniqueness, salt uniqueness is
inherited for free.

**Failure mode:** if the keeper dies, dividends stop accruing but no funds
are lost. When the keeper restarts, it replays missed events in order
from its persistent cursor. Bounded latency, never correctness failure.

**Forward compatibility:** when Compact ships true contract-to-contract
calls, we can promote `settle()` to call `bumpOnMint` directly and retire
the keeper. The event emission stays (indexers still consume it).

### 2. State model — cumulative-points accumulator

**Standard MasterChef / Compound pattern.** One global monotone-increasing
accumulator (`_accPerShare`); each member has a snapshot at their last
claim or registration (`accPerShareAtCheckpoint`). Claim math:
`owed = (accPerShare - checkpoint) / SCALE`.

**O(1) per mint, O(1) per claim.** Total contract work is constant
regardless of member count. Vital at continental scale where naive
per-member update loops would be catastrophic.

**Scale factor:** `SCALE = 10^18`. Necessary because integer division
truncates; without scaling, tiny mints round to zero and every member
accrues nothing forever.

**Division strategy:** Compact circuits cannot use integer `/` or `%`
directly, and Field values cannot use `<=`. We use a **witness-computed
divmod** pattern:

1. Prover returns `{quotient, remainder}` via `witness_divmod(num, div)`.
2. Circuit asserts `numerator == quotient * divisor + remainder` (Field
   equality — cheap).
3. Circuit enforces `remainder < divisor` via a checked cast
   `(divisor - remainder - 1) as Uint<128>` (fails at runtime if
   `remainder >= divisor`).

See `checkedDivide` in the contract. Same class of ZK pattern as any
"prover computes, circuit verifies" idiom.

### 3. Recipient address type — self-custody + relayed submission

Three options were considered:

- **Self-custody (chosen):** member generates a Midnight wallet locally,
  the LD contract keys `_members` by their `UserAddress`. Matches the
  v7 producer/consumer path (5 consumers + 1 producer already registered
  on Path A).
- **Rejected: Custody-first.** Would require PollPower to hold every
  member's private key. Reintroduces trusted-intermediary role that
  ADR-006 explicitly rejects. Creates continental-scale custody-target
  attack surface.
- **Adopted enhancement: relayed submission.** Member's wallet signs
  claim/touch payloads; PollPower's relay pays DUST and marshals the
  transaction. Same rail already used for v7 transfers. Preserves
  self-sovereignty (member's key is theirs) while removing the
  "get DUST to every member" onboarding UX problem.

### 4. KYC pipeline — multisig-gated registration with on-chain uniqueness

```
1. Member generates wallet locally at signup
2. Member completes KYC (SmileID, or future providers)
3. off-chain API verifies job uniqueness, phone ownership, address well-formedness
4. API produces KycAttestation { providerTag, jobIdHash }
5. Multisig admin app reviews pending queue → threshold approval
6. register(midnightAddress, kycAttestationHash, currentTime) submitted to LD
7. LD verifies multisig sig (ADR-002 pattern), snapshots _accPerShare
```

Mirrors the ProducerRegistry v1 pattern (multisig-gated on-chain
registration attesting off-chain KYC completion).

**On-chain KYC uniqueness:** `_seenKycJobHashes: Set<Bytes<32>>` prevents
the same KYC verification from being used to register multiple addresses.
Key format: `hash(providerTag, jobIdHash)` — vendor-agnostic across
SmileID, Onfido, Persona, in-person cooperative attestation, etc.

Cost: one `Set.member()` check + one `Set.insert()` per `register()` call.
Runs a few thousand times per year at continental scale — not per-mint.
Moves KYC uniqueness from "trust the API" to "cryptographically
guaranteed." Same class of hardening as v5.2's `_settledSessions` replay
guard.

### 5. Multi-address migration — unregister/register on wallet loss

If a member loses their phone and cooperative bylaws reissue them a new
address, the new address is a *different* `UserAddress`. Two options
were considered:

- **Chosen: unregister/register.** Old address is `unregister`ed,
  unclaimed accruals implicitly revert to the pool (checkpoint discarded,
  accumulator unchanged, per-member share of remaining members grows on
  next bump). New address `register`s fresh, starts accruing from now.
- **Not chosen: `reassign(oldAddr, newAddr, multisigSig)`.** Would
  migrate the checkpoint and lastSeen. Cleaner member UX but more
  contract surface.

The slight punitive edge on option 1 is acceptable because claim cadence
is frequent enough that per-migration loss is bounded (worst case ~1
claim period). The larger question of "wallet-contents loss" is a
separate concern — bylaws territory, not LD's problem to solve.

### 6. Liveness signal set — Tier 1 only for v1

A member is "living" iff they have, within the past
`INACTIVITY_THRESHOLD_T` (currently 180 days), performed a signed action.

**Tier 1 (chosen for v1) — in-contract, no trust required:**

- `register` sets initial `lastSeen`
- `claim` updates `lastSeen`
- `touchLiveness` updates `lastSeen`

**Tier 2 (deferred) — keeper-attested v7 activity events.** Redeem,
transfer, mint-as-consumer. Requires trusting the keeper to attest
events genuinely happened. Deferred until v7.1 event pattern proves
stable in production.

**Tier 3 (deferred) — in-circuit v7 activity reads.** Would replace
Tier 2 and DAO vote hooks. Requires Compact cross-contract calls to ship.

**Sybil economics:** a Sybil operator must run `touchLiveness` for every
fake identity every 180 days at DUST + proof-generation cost. At pilot
dividend rates the Sybil cost floor is already close to the dividend
value; at cooperative scale (~1800 KES per 6mo) Sybil economics still
work as long as touchLiveness costs cents worth of DUST + proof compute.
That is exactly where we want the Sybil constraint biting.

**App auto-touch behavior** (design, not contract): on every app open,
if `lastSeen + 30 days < now`, silently submit `touchLiveness` in the
background via the relay. Sponsored DUST. Practical member-facing
threshold becomes "6 months of not opening the app," which is a real
deprecation signal.

### 7. Prune model — two-phase with 30-day grace

`proposePrune(member)` — anyone can call once a member is past T. Creates
a `PendingPrune` entry.

`executePrune(member)` — anyone can call 30 days after propose. If the
member has touched `lastSeen` during grace, the prune is *cancelled*
(pending is removed, member stays live). Otherwise the prune executes
(member marked `isLive = false`, `totalLivingMembers` decrements,
accruals implicitly revert to the pool).

**Rationale:** the grace window prevents accidental reversion for
members in hospital, traveling, or between phones. Combined with app
auto-touch, this makes accidental prune vanishingly unlikely for
engaged members.

### 8. Threshold T = 180 days

Community fairness argument: dead members should not dilute the living
for years. If T is set too high, the accumulator's growth is partly
"paying" wallets that will never claim, quietly reducing per-member
share of engaged members. 180 days is a real "this person is gone"
threshold — longer than any reasonable travel/hospitalization, shorter
than "we forgot about you."

Governance can tune later per ADR-013's parameter-governance pattern.

### 9. Slice size — 100% of solar dividend slice (1.86%) at launch

No total BPS change from v7's split. The solar-dividend slice, which
was always the architectural soft spot in the v5 4-slice model, becomes
the LD slice at Phase 2. Governance tunes the size later.

### 10. Denomination — EBT, not KES

Members receive EBT (power), not shillings. They can:

1. Use the EBT for power at any meter (the direct path)
2. Hold indefinitely (epoch-color preserves purchasing power per ADR-001)
3. Transfer to other members
4. Redeem for KES at the epoch rate (full bearer right under v7)

Option 4 means the dividend can ultimately become cash if the member
wants. But the primitive the network distributes is *power* — the floor
commodity below which modern life stops working. This is the correct
primitive for an energy network and for the post-AI economy specifically:
AI does not eat the kWh you used this morning.

## Compact syntax lessons (for future contracts)

The contract took several compile passes. Notes for anyone writing
Compact against compactc 0.30+:

1. **No numeric separators.** `1_000_000` breaks; use plain digits.
2. **`UserAddress` is a struct.** Access `.bytes` for the raw `Bytes<32>`
   when hashing.
3. **`Uint<128> * Uint<128>` overflows** the largest representable Uint.
   Do multiplication in `Field` space, cast back with a checked cast.
4. **Field values cannot use `<=` or `<`** directly. Use divmod-and-equation
   patterns or checked-cast tricks instead.
5. **Witness output flowing into a ledger write requires `disclose()`.**
   The compiler enforces this to prevent accidental private-value leaks
   into public state.
6. **Sealed ledger fields require `constructor()`,** not an exported
   `initialize` circuit. Use constructor parameters for deploy-time
   config.

## Contract shape summary

| Category | Count | Notes |
|----------|-------|-------|
| Constructor | 1 | Sets sealed config at deploy |
| Reader circuits | 5 | `getSolvencyState`, `getStats`, `getMemberState`, `getClaimableAmount`, `hasPendingPrune` |
| Mutating circuits | 7 | `register`, `unregister`, `bumpOnMint`, `claim`, `touchLiveness`, `proposePrune`, `executePrune` |
| Ledger fields | 15 | 3 sealed config + 4 accumulator + 4 maps/sets + 4 audit |
| Witnesses | 4 | divmod, multisig sig, member sig, blocktime |
| Compile status | ✅ | Full ZK clean on compactc 0.31.0 in 18.7s, zero warnings |

## Open items (post-deploy design work)

- **Sybil layered approach at scale.** Not a pilot blocker but documented
  path needed pre-mainnet. Layered: SmileID biometric floor + cooperative
  vouching + periodic re-verification.
- **Regulatory framing.** Cooperative dividend in commodity-kind.
  Structurally similar to rural US electric cooperative patronage
  dividends. Draft for EPRA/CMA/Treasury pre-clearance is TODO.
- **Claim UX in the app.** See [UX-DESIGN.md](./UX-DESIGN.md) for the
  design; implementation is downstream of contract deploy.
