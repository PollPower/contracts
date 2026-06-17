# EBT v7 — Unshielded Token Design (transfer + redeem, native UTXO)

**Date:** 2026-06-17
**Status:** DESIGN DRAFT (pre-spike). Author: Joi (with Garrett).
**Decision basis:** ADR-018 (unshielded EBT token model), ADR-017 (unified
redemption), ADR-001 (rate immutability). Carries forward EBT v5.2 audit
hardening.
**Compiler target:** compactc 0.30.0 (same as v5.2). pragma `>= 0.16 && <= 0.22`.

> ⚠️ Pre-spike. Circuit bodies below are DESIGN SKETCHES illustrating shape and
> the stdlib calls, not compiled code. Build step 0 is a tiny mint+send+balance
> spike to confirm the unshielded primitives work on our toolchain + Preview.

## 1. Goal

Turn EBT from a flat, non-transferable public balance map (v5.2) into a
**contract-minted, unshielded, native-UTXO token** that:
1. Mints only via `settle()` (producer + protocol-split recipients) — unchanged
   authority/attestation logic from v5.2.
2. **Transfers** holder -> holder (`sendUnshielded`), fee-paid in sponsored DUST.
3. **Redeems** (burns) by any holder for KES via the ADR-017 settlement rail.
4. Preserves the **1:1 EBT↔pool invariant** by construction (rate fixed per epoch).

## 2. Token model

- **EBT is an unshielded ledger token whose mint authority is this contract.**
- **Color (token type)** = `tokenType(domainSep, contractAddress)` where
  `domainSep = pad(32, "pollpower:ebt:v7:epoch1")`. The color encodes the rate
  epoch (ADR-001). One epoch = one color = one rate. Multiple epochs (if ever) =
  distinct colors; color *is* the rate tag — no per-coin datum, no FIFO lots.
- **Value lives in unshielded UTXOs**, moved by `sendUnshielded`. Balances are
  read with `unshieldedBalance(color)`. Transparent on-chain (accepted trade-off).

## 3. Stdlib primitives used (from CompactStandardLibrary)

```
mintUnshieldedToken(domainSep: Bytes<32>, amount: Uint<64>,
                    recipient: Either<ContractAddress, UserAddress>): Bytes<32>  // returns color
sendUnshielded(color: Bytes<32>, amount: Uint<128>,
               recipient: Either<ContractAddress, UserAddress>): []
receiveUnshielded(color: Bytes<32>, amount: Uint<128>): []
unshieldedBalance(color: Bytes<32>): Uint<128>      // + Lt / Gt / Gte
tokenType(domainSep: Bytes<32>, contract: ContractAddress): Bytes<32>
```

Note recipient is `Either<ContractAddress, UserAddress>` for unshielded (NOT
`ZswapCoinPublicKey` — that's the shielded path).

## 4. Ledger state (delta from v5.2)

KEEP (governance/policy/audit — unchanged semantics):
```
_initialized, _owner, _meterAuthorityPubkey
_bpsProducer, _bpsOperations, _bpsDividend, _bpsDao
_operationsRecipient, _dividendRecipient, _daoRecipient
settlementCount, _settledSessions
producerAttestations, reissuanceCount, reissuanceLog, _lastReissueTime
```

CHANGE:
```
// DROP the flat balance map — value now lives in native unshielded UTXOs.
- export ledger _balances: Map<Bytes<32>, Uint<128>>;

// Keep a redemption audit log (provable burn records for KES release).
+ export ledger _redemptionCount: Counter;
+ export ledger _redemptionLog: Map<Uint<64>, RedemptionEntry>;
// _totalSupply still tracked for accounting (mint += , redeem -=).
  export ledger _totalSupply: Uint<128>;
+ // optional: _totalRedeemed: Uint<128> for net-supply reconciliation.
```

New struct:
```
struct RedemptionEntry {
  redeemer:    Bytes<32>;   // holder pubkey (or hash) who redeemed
  amount:      Uint<128>;   // EBT base units burned
  payoutRef:   Bytes<32>;   // off-chain payout correlation id (cashout/redemption row)
  redeemedAt:  Uint<64>;    // block-time-validated timestamp (L-3 pattern)
}
```

## 5. Circuits

### 5.1 settle() — mint via unshielded token (reworked tail of v5.2)

Everything up to the mint stays identical to v5.2 (authority sig, attestation
binding M-1, HAT 4-field signed payload C-1, slice policy, replay guard). Only
the "apply mint" tail changes: instead of writing `_balances`, mint unshielded
tokens to each recipient.

```compact
// ... all v5.2 verification unchanged ...
const domainSep = pad(32, "pollpower:ebt:v7:epoch1");

// producer + protocol splits (producerAmt/opsAmt/divAmt/daoAmt computed as v5.2)
mintUnshieldedToken(domainSep, disclose(producerAmt) as Uint<64>,
                    right<ContractAddress, UserAddress>(disclose(producerAddr)));
mintUnshieldedToken(domainSep, disclose(opsAmt) as Uint<64>,
                    right<ContractAddress, UserAddress>(_operationsRecipientAddr));
mintUnshieldedToken(domainSep, disclose(divAmt) as Uint<64>, ...dividend...);
mintUnshieldedToken(domainSep, disclose(daoAmt) as Uint<64>, ...dao...);

_totalSupply = disclose((_totalSupply + amount) as Uint<128>);
_settledSessions.insert(disclose(sessionID));
settlementCount.increment(1);
```

OPEN: recipient identity type. v5.2 keyed balances by `Bytes<32>` pubkey;
unshielded send wants `UserAddress`. Need to map producer wallet pubkey ->
UserAddress (verify the address encoding in the spike). May store recipients as
UserAddress in state instead of Bytes<32>.

### 5.2 transfer() — native UTXO move

Thin wrapper over `sendUnshielded`. The caller proves ownership by holding the
UTXO (the ledger enforces it); the contract just executes the send. In practice
holders may call `sendUnshielded` directly via wallet without the contract — but
a contract circuit lets us add policy (e.g. transfer caps, pause) if ever needed.

```compact
export circuit transfer(amount: Uint<128>, recipient: UserAddress): [] {
  const color = tokenType(pad(32, "pollpower:ebt:v7:epoch1"), kernel.self());
  // ledger enforces caller has the balance; optionally assert here:
  assert(unshieldedBalanceGte(color, disclose(amount)), "Insufficient EBT");
  sendUnshielded(disclose(color), disclose(amount),
                 right<ContractAddress, UserAddress>(disclose(recipient)));
}
```

NOTE: whether the *caller's* UTXOs are spendable inside a contract circuit, or
whether transfers happen purely at the wallet/UTXO layer with the contract only
for mint/redeem, is a SPIKE question. If wallet-layer transfer is the norm, the
contract may not need transfer() at all — holders send EBT like any unshielded
token. Either way, transfer works; this circuit is the "with-policy" option.

### 5.3 redeem() — burn for KES

Holder burns EBT; contract records a provable redemption the settlement-api keys
the M-Pesa payout to. Burn = send to a canonical unspendable/sink address
(confirm canonical burn in spike), then log.

```compact
export circuit redeem(
  amount:     Uint<128>,
  redeemer:   Bytes<32>,    // holder identity for the audit log
  payoutRef:  Bytes<32>,    // correlates to off-chain redemption/cashout row
  currentTime: Uint<64>,
): [] {
  assert(_initialized, "Not initialized");
  assert(amount > 0 as Uint<128>, "Must redeem > 0");
  const color = tokenType(pad(32, "pollpower:ebt:v7:epoch1"), kernel.self());
  assert(unshieldedBalanceGte(color, disclose(amount)), "Insufficient EBT");

  // L-3: validate timestamp not in the future.
  assert(disclose(blockTimeGte(disclose(currentTime))), "timestamp in future");

  // Burn: move the EBT out of circulation (canonical sink — confirm in spike).
  sendUnshielded(disclose(color), disclose(amount), <BURN_SINK>);

  _totalSupply = disclose((_totalSupply - amount) as Uint<128>);

  const entry = RedemptionEntry {
    redeemer: disclose(redeemer),
    amount: disclose(amount),
    payoutRef: disclose(payoutRef),
    redeemedAt: disclose(currentTime),
  };
  _redemptionLog.insert(_redemptionCount.read() as Uint<64>, entry);
  _redemptionCount.increment(1);
}
```

The off-chain flow (ADR-017 cashout-worker, generalized to any holder):
`redeem() on-chain (real burn now) -> settlement-api confirms the burn tx +
matches payoutRef -> B2C/B2B KES to the payee -> ResultURL callback finalizes.`
This RETIRES `SKIP_ON_CHAIN_BURN_FOR_PILOT` — the burn is now a real on-chain op.

### 5.4 Keep from v5.2 (unchanged)

`transferOwnership` (L-1 guard), `setMeterAuthority`, `attestProducerOwnership`,
`revokeProducerOwnership`, `manualReissue` (M-4 cap/cooldown/co-sign — but now
mints via `mintUnshieldedToken`), reads (`totalSupply`, `getMeterAuthority`,
`getMarginPolicy`, `getAttestation`, etc.). Replace `balanceOf(account)` with a
read over `unshieldedBalance(color)` semantics (note: unshielded balance is a
ledger fact, may not need a contract read circuit at all).

## 6. The 1:1 invariant (why solvency holds)

- Mint: `settle()` mints EBT only against a verified metered session; the KES that
  backed it entered the pool at the epoch rate. `_totalSupply += amount`.
- Transfer: `sendUnshielded` moves EBT between holders; pool untouched; supply
  unchanged. (Garrett's unified-holder model.)
- Redeem: `redeem()` burns EBT (`_totalSupply -= amount`) and triggers exactly
  `amount * epochRate` KES out of the pool.
- Therefore `circulating EBT (= _totalSupply) * epochRate == KES_in_pool` holds
  at every step. Color-per-epoch keeps the rate unambiguous if epochs ever differ.

## 7. Build plan

0. **SPIKE (gate):** ~20-line contract — `mintUnshieldedToken` to a user,
   `sendUnshielded` user->user, `unshieldedBalance` read. Compile on compactc
   0.30.0, deploy Preview, confirm a non-submitter recipient actually receives +
   can re-send (this is the exact thing the shielded path FAILED at — Option A).
   Confirm DUST sponsorship path for user transfers. **Do not proceed until this
   passes.**
1. Fork v5.2 -> v7. Swap balance map for unshielded mint in `settle()` +
   `manualReissue`. Add `redeem()` + redemption log. Add (optional) `transfer()`.
2. Compile clean (--skip-zk then full ZK).
3. Re-run the v5.2 audit checklist against v7 (ensure no hardening regressed).
4. Off-chain: generalize cashout-worker to any holder (ADR-017 P0/P1), wire
   real `redeem()` burn, drop the pilot skip flag.
5. Deploy ceremony (Garrett green-light). Migrate pilot balances if needed.

## 8. Open questions (carried from ADR-018)

1. GA + Preview behaviour of unshielded contract/ledger mint+send (the spike).
2. DUST sponsorship for user `sendUnshielded`.
3. Canonical burn sink + redemption proof shape.
4. Recipient identity: `UserAddress` vs `Bytes<32>` pubkey mapping.
5. Does the contract need `transfer()`/`balanceOf()` at all, or are those pure
   wallet/ledger-layer operations once EBT is a native unshielded token?
6. Multi-epoch: single color now (recommended) vs color-per-epoch from day one.
