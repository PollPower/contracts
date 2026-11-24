# Living Dividend v3: user-initiated claims through a cross-contract call

Branch `wi16-ledger9`. Status: **design only, awaiting approval.** No contract
code is written. Depends on [WI16-auth-fix-design.md](./WI16-auth-fix-design.md)
(C-1/C-2/H-1).

## Goal

A member claims their dividend themselves, in one transaction, and receives
**unshielded EBT directly in their wallet**. The claim uses a ledger 9
cross-contract call from LD into EBT, and **EBT never calls back into LD**.

## What changes from v2.2.2

v2.2.2 (in the `settlement-api` repo, PRs #5 and #6) keeps accounting on-chain
but custody off-chain. `claim()` only writes a `PendingClaim`. An off-chain
batch payer later sends EBT from a Shamir-shared LD-pool wallet, and the
council marks the claim paid with `executePayout`. A keeper feeds new dividend
in with `bumpOnMint`. (v1's on-chain custody was abandoned because the runtime
rejected unshielded mints to a contract address.)

v3 removes the custody problem instead of working around it: **no tokens ever
sit in a contract.** EBT keeps the dividend slice as an on-chain *budget*, and
mints from that budget straight to the member when LD asks.

| v2.2.2 | v3 |
|---|---|
| `claimSplit(kind = LD)` mints the dividend slice to the off-chain LD-pool wallet | The dividend slice stays in EBT as `_dividendAccrued`; no mint until a member claims |
| Keeper calls `bumpOnMint(salt, amount)` with a keeper signature | **Removed.** LD pulls the accrued total from EBT (`dividendAccrued()`) at the start of every state change |
| `claim()` writes `PendingClaim`; batch payer pays; council `executePayout` | `claim()` calls `EBT.mintDividend(payout, owed)`; EBT mints in the same transaction |
| Member identity: `witness_memberSignatureValid` (bypassable, C-1) | Member proves a Jubjub key with an in-circuit Schnorr signature |
| Council: `witness_multisigSignatureValid` (bypassable, C-1) | Council via cross-contract `isApproved(actionHash)` + local consumed set |
| Off-chain BP-3 reconciliation backstop | Solvency is an on-chain invariant in EBT (`minted ≤ accrued`); reconciliation becomes a read-only check |

## Audit fixes carried forward

| ID | v2.2.2 fix | v3 |
|---|---|---|
| LD-C-1 | stdlib `blockTimeGte` replaces the prover-controlled time witness (real fix) | Kept: every time gate uses stdlib `blockTimeGte`/`blockTimeLt` |
| LD-H-3 | keeper signature on `bumpOnMint`, but through a prover-trusted witness (still bypassable, C-1) | **Removed structurally**: no `bumpOnMint`, no keeper, no salts. Accrual is read from EBT, so there is nothing to squat or forge |
| LD-3 | contract address in every signed payload | Kept: `kernel.self()` in every digest |
| LD-M-2 | 2^63 default time witness | Gone with the witness |
| WI16-C-1 | — | Member and council checks verified in-circuit |
| WI16-H-1 | constructor init (already) | Kept |

## Flow

```
member (phone)                LD v3                                   EBT v9
     | claim(id, nonce, sig) ->|                                        |
     |                         | verify Schnorr(sig, memberPk[id])      |
     |                         | sync():  total = EBT.dividendAccrued() --> (view, witness-free)
     |                         |          accPerShare += Δ·1e18 / live   |
     |                         | owed = (accPerShare - checkpoint)/1e18 |
     |                         | checkpoint := accPerShare; nonce++     |
     |                         | EBT.mintDividend(payout, owed) ------->| assert caller() == left(LD)
     |                         |                                        | assert minted + owed <= accrued
     |                         |                                        | minted += owed
     |<----------- unshielded EBT minted to payout -------------------- | mintUnshieldedToken(..., right(payout))
```

One transaction: LD's proof plus EBT's proof for the callee circuits. No call
from EBT to LD exists, and the runtime's re-entrancy guard would reject one.

## EBT v9 side

```compact
// Witness-free callees (a circuit reached through a contract type may not call witnesses).
export circuit dividendAccrued(): Uint<128> { return _dividendAccrued; }

export circuit mintDividend(member: UserAddress, amount: Uint<128>): [] {
  const c = kernel.caller();
  assert(c.is_some && c.value.is_left && c.value.left == _livingDividend, "Only LD");
  const a = disclose(amount);
  assert((_dividendMinted + a) as Uint<128> <= _dividendAccrued, "Exceeds dividend budget");
  _dividendMinted = (_dividendMinted + a) as Uint<128>;
  mintUnshieldedToken(pad(32, "pollpower:ebt:v9:epoch1"), a as Uint<64>,
                      right<ContractAddress, UserAddress>(disclose(member)));
}
```

- `settle` adds the dividend slice to `_dividendAccrued` (instead of a pending
  amount that `claimSplit` mints to the LD wallet).
- `kernel.caller()` is read only on this contract-to-contract path, as the
  stdlib docs require (they warn it is unreliable for top-level user calls).
- **Deploy order:** EBT first (it does not know LD yet), then LD with EBT's
  address in its constructor, then a one-time council action on EBT,
  `bindLivingDividend(ld)`, which sets `_livingDividend` and refuses a second
  bind. (EBT v8 already has a council-gated LD binding; this makes it bind-once.)

## LD v3 ledger

| Field | Type | Notes |
|---|---|---|
| `_ebt` | `sealed` contract `EbtDividend` | constructor |
| `_council` | `sealed` contract `Council` | constructor |
| `_members` | `Map<Bytes<32>, Member>` | key = member id = `persistentHash(pad("pp:ld:v3:member"), pkX, pkY)` |
| `Member` | `{ payout: UserAddress, pk: JubjubPoint, checkpoint: Uint<128>, nonce: Uint<64>, lastSeen: Uint<64>, registeredAt: Uint<64>, isLive: Boolean }` | |
| `_accPerShare` | `Uint<128>` | scaled by 1e18 (as v2) |
| `_lastSyncedAccrued` | `Uint<128>` | EBT total already distributed into the accumulator |
| `_unallocated` | `Uint<128>` | dividend that accrued while there were no live members (decision below) |
| `_live` | `Uint<64>` | live member count |
| `_seenKycJobHashes` | `Set<Bytes<32>>` | as v2 (one registration per KYC job) |
| `_pendingPrunes` | `Map<Bytes<32>, Uint<64>>` | proposal time |
| `_consumedActions` | `Set<Bytes<32>>` | council replay protection |

Claim and registration logs move to **ledger 9 contract events** (MIP-0002,
indexed by indexer 4.4.101), which are cheaper than growing maps.
**Decision needed:** events, or keep v2's on-chain log maps.

## Circuits

| Circuit | Authorization | Effect |
|---|---|---|
| `constructor(ebt, council)` | deploy (H-1) | sealed references |
| `register(pk, payout, kycHash)` | council `isApproved(hash(tag, self, id, payout, kycHash))` | sync, then add member at the current `_accPerShare` |
| `unregister(id)` | council | sync, mark not live, `_live--` (unclaimed growth is forfeited, as in v2) |
| `claim(id, sig)` | member Schnorr over `(tag, self, id, nonce)` | sync, pay `owed` through `EBT.mintDividend`, bump `nonce`, refresh `lastSeen` |
| `touchLiveness(id, sig)` | member Schnorr over `(tag, self, id, nonce)` | refresh `lastSeen`, bump `nonce` |
| `proposePrune(id)` / `executePrune(id)` | permissionless, block-time gated (180 days inactive + 30-day grace) | sync, then remove from `_live` |
| `sweepUnallocated(to)` | council | only if that decision is "council sweeps" |

- **Replay:** the per-member `nonce` in every member digest means a captured
  signature cannot be replayed to keep a dead member "live".
- **Sync before every membership change**, so a new member never shares
  dividend that accrued before they joined, and a pruned member's share is
  settled first.
- **Division** keeps v2's witness-assisted `checkedDivide` (the circuit checks
  `n = q·d + r` with a range check on `r`), which is a safe witness use.
- **Rounding:** floor division; the remainder stays in EBT's budget and is
  distributed in a later sync.

## Why Schnorr for members (not a hash-preimage secret)

The consumer app proves on a LAN proof server, and the proof server sees every
private input. With a hash-preimage identity the member's secret would reach
that server; with Schnorr only a single-use signature does. Schnorr is also
the cheaper circuit (2.1 MB vs 11.3 MB proving key in the spike).

## Spike evidence (Compact 0.36.1, throwaway)

`ld_spike.compact` + `ebt_spike.compact` compile cleanly (`--skip-zk`, on
kenya) with: two contract types, sealed contract-reference ledger fields,
`sync()` making a view call into EBT, `claim()` making a minting call into
EBT, and EBT checking `kernel.caller()`. **Not yet shown:** run-time and
on-chain behaviour (two calls to the same callee in one transaction; a mint
inside a callee). The first local-devnet run must cover both before any public
deploy.

## Open decisions

1. **Zero live members:** dividend accrued while nobody is registered goes to
   `_unallocated` and the council can sweep it to the DAO (recommended), or it
   waits for the first member (who would then receive all of it).
2. **Events vs log maps** for claims and registrations (recommended: events).
3. **Payout address changes:** fixed at registration and changed only by
   council re-registration (recommended for the Buildathon), or member-signed
   with a delay.
4. **Existing v2.2.1/v2.2.2 members:** the Preview state is gone, so v3 starts
   empty; the 5 pilot members re-register through the council.

## Test plan (before contract code)

- Accounting: N members, interleaved settles/claims/registers/prunes;
  Σ claimed + undistributed remainder == accrued; no member is paid twice;
  a new member gets nothing from earlier accruals.
- Authorization: forged or replayed member signature rejected; council action
  without quorum rejected; replayed council action rejected;
  `mintDividend` called directly (not from LD) rejected; budget overdraw rejected.
- No re-entry: EBT's callee circuits never reference LD.
- Parity: the member signer's digest equals the circuit's (tests/parity pattern).
- Devnet end-to-end: register → settle → claim → balance arrives at payout.

## Effort

3–4 dev-days for LD v3 plus the EBT v9 callee side, inside the 12–15 day total
in the auth fix design.
