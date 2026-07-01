# Living Dividend

**Status:** Design-complete, compile-clean, awaiting deploy ceremony.
**Contract version:** v1 (first line of the Living Dividend family)
**Depends on:** EBT v7.1 (see [`../ebt/V7.1-EVENT-DIFF.md`](../ebt/V7.1-EVENT-DIFF.md))
**Origin:** [ADR-019](../../pollpower-internal-docs/memory/ADR-019-living-dividend.md) (PollPower internal), designed 2026-07-01

## What this is

The Living Dividend is a network-wide, UBI-shaped mechanism where every
kWh of energy consumed on the PollPower network pays every living
verified member of the network, in EBT (i.e., in power). Claim-on-demand
filters out the dead gracefully. No political permission required.
Funded by the activity it enables.

It is *not* a subsidy, an inflation source, or a debt instrument. It is
**redistribution at the mint event** — a fraction of every settlement is
routed to the LD contract, which distributes proportionally to a roll
of KYC-verified members via a cumulative-points accumulator.

This directory contains the first working implementation of the
mechanism described in ADR-019.

## Files

| File | Purpose |
|------|---------|
| [`living-dividend-v1.compact`](./living-dividend-v1.compact) | The contract. 13 circuits, 15 ledger fields, 4 witnesses. Compile-clean on compactc 0.31.0 (full ZK). |
| [`witnesses.ts`](./witnesses.ts) | Prover-side TypeScript for `witness_divmod`, `witness_multisigSignatureValid`, `witness_memberSignatureValid`, `witness_blockTimeGte`. |
| [`ld-keeper.ts`](./ld-keeper.ts) | ~200-LOC keeper service. Subscribes to v7.1 `DividendMinted` events; submits idempotent `bumpOnMint` calls. Cursor-persisted, failure-mode-aware. |
| [`DESIGN.md`](./DESIGN.md) | All architectural decisions and the reasoning behind them. First stop for understanding *why*. |
| [`UX-DESIGN.md`](./UX-DESIGN.md) | Member-facing UX: 4 screens, auto-touch behavior, notification cadence. |
| [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md) | 7-phase deploy plan with per-phase rollback. |

## Circuit surface

**Constructor:** `constructor(ebtColor, multisigAuthority)` — deploy-time init.

**Reader circuits** (dashboards, apps, keepers):

- `getSolvencyState()` → `{ balance, totalReceived, totalClaimed, outstandingOwed, isSolvent }`
- `getStats()` → `{ accPerShare, totalLivingMembers, registrationCount, claimCount, bumpCount, pruneCount }`
- `getMemberState(member)` → `MemberState`
- `getClaimableAmount(member)` → `Uint<128>`
- `hasPendingPrune(member)` → `Boolean`

**Mutating circuits** (governance / members / keeper):

- `register(member, kycAttestationHash, currentTime)` — multisig-gated
- `unregister(member, currentTime)` — multisig-gated
- `bumpOnMint(sourceTxSalt, amount, currentTime)` — keeper-called, idempotent
- `claim(member, currentTime)` — holder-signed
- `touchLiveness(member, currentTime)` — holder-signed
- `proposePrune(member, currentTime)` — anyone-can-call
- `executePrune(member, currentTime)` — anyone-can-call, requires 30-day grace

## Core mechanism (cumulative-points accumulator)

Every mint (`bumpOnMint`) bumps a single global accumulator by
`amount * SCALE / totalLivingMembers`. Every member has a snapshot of
that accumulator at their last claim/registration. Claim math:
`owed = (accPerShare - memberCheckpoint) / SCALE`.

O(1) per mint, O(1) per claim. Total contract work is constant
regardless of member count.

Integer division is impossible in-circuit; we use a witness-computed
divmod pattern where the prover returns `{quotient, remainder}` and the
circuit verifies `numerator == quotient * divisor + remainder` with
`remainder < divisor` via checked cast. See `checkedDivide` in the
contract.

## Solvency invariant

At every step:

```
unshieldedBalance(_ebtColor) >= _totalPoolReceived - _totalClaimed
```

Asserted in `bumpOnMint`. The receiver-balance check catches keeper-vs-reality
drift, misconfigured keepers, and buggy event emission — the LD contract
will refuse to accept a bump amount not backed by actual EBT balance.

## Liveness model

A member is "living" iff they have, within the past `INACTIVITY_THRESHOLD_T`
(currently 180 days), performed any signed action against the LD
contract: `register`, `claim`, or `touchLiveness`.

Pruning is two-phase with a 30-day grace period:

1. Anyone can call `proposePrune(member)` once a member is past T.
2. Anyone can call `executePrune(member)` 30 days later.
3. If the member has touched `lastSeen` during grace, `executePrune`
   cancels the prune instead of executing it.

Unclaimed accruals of pruned members implicitly revert to the pool (their
checkpoint is discarded; the accumulator continues; per-member share of
remaining members grows on the next bump).

**No death oracle.** No registry of mortality. The dead, the lost, the
inactive gracefully bleed back into the living pool.

## KYC uniqueness

`_seenKycJobHashes: Set<Bytes<32>>` prevents the same KYC verification
job from being used to register multiple addresses. Key format:
`hash(providerTag, jobIdHash)` — vendor-agnostic (SmileID, Onfido,
Persona, in-person cooperative attestation).

## Integration with EBT v7

The Living Dividend is a downstream contract; EBT v7 stays minimal.

Because Compact does not yet support contract-to-contract calls (per
Midnight's docs and OpenZeppelin's `MultiToken` disclaimers), we use the
**MIP-0002 event pattern** that landed in midnight-js on 2026-06-30:

1. v7.1 (see [`../ebt/V7.1-EVENT-DIFF.md`](../ebt/V7.1-EVENT-DIFF.md))
   emits a `DividendMinted` event inside `settle()`.
2. `ld-keeper.ts` subscribes to that event via the indexer.
3. Keeper calls `LD.bumpOnMint(sourceTxSalt, amount, currentTime)`.
4. LD's idempotency guard (`_processedSalts: Set<Bytes<32>>`) makes
   duplicate calls safe. The keeper can be restarted, replaced, or run
   redundantly with no side effect.

Failure mode: if the keeper dies, dividends stop accruing (but no funds
are lost). When the keeper restarts, it replays missed events in order
from its persistent cursor. Bounded latency, not correctness failure.

## Compile status

```
compactc 0.31.0, full ZK compile: SUCCESS in 18.7s. Zero warnings.
```

## Deploy

See [`DEPLOY-RUNBOOK.md`](./DEPLOY-RUNBOOK.md). 7 phases, per-phase
rollback, monitoring recommendations.

## Related PollPower architecture decisions

- **ADR-001** — Rate immutability as a security feature. LD inherits
  epoch-color rate binding from EBT v7.
- **ADR-002** — Multisig owner and authority for v5+. LD's
  `register`/`unregister` reuse this pattern.
- **ADR-006** — Cooperative DAO producer structure. LD is the
  consumer-side analog: every member is a shareholder in the network's
  activity.
- **ADR-013** — Tariff classes and the capacity slice. Structural
  analog to LD (parametric, transparent, restricted-use, downstream
  contract).
- **ADR-017** — EBT merchant spend / unified redemption. LD payouts are
  in EBT and inherit full v7 spend/transfer/redeem liquidity.
- **ADR-018** — Unshielded EBT token model. Made LD possible by giving
  us native UTXO transfers a downstream contract can wield.
- **ADR-019** — The Living Dividend (this).

## License

See [`../LICENSE`](../LICENSE) and [`../NOTICE`](../NOTICE) in the repo root.
