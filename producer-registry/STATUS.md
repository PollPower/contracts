# STATUS — ProducerRegistry v1

**As of 2026-05-09**

## ⚠️ PILOT-MOCK ADMINS ACTIVE — NOT YET OPERATIONALLY TRUSTLESS

The deployed registry contract `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d`
is currently seeded with 5 **pilot-mock** admin keypairs derived from
deterministic seeds:

```
sk_i = SHA-256("pollpower-pilot-mock-ring-i")   for i in 1..5
```

These seed strings are public — derivable from `SHA-256("pollpower-pilot-mock-ring-i")`
as published in PollPower's design notes. **Anyone aware of this convention
can derive all 5 private keys** and produce a valid 3-of-5 signature on any
actionHash.

### What this means

The architectural claim "the registry is governed by 3-of-5 admin ring
co-signature" is **structurally true** of the deployed contract — the
contract verifies real Ed25519 signatures, the threshold is enforced,
the action-hash recomputation is correct, replay protection works.

But the operational reality is that **PollPower (or anyone else with
repository access) currently controls all 5 admin keys**, so 3-of-5 in
practice means "any one entity who can read this repo".

### Why this is acceptable today

- The registry is deployed on **Midnight Preview** with no real value at stake.
- The "pilot-mock" labeling is honest and explicit throughout the code,
  the deployment record, and this STATUS.md.
- The planned ceremony to swap real Tangem ring keys for the pilot-mocks
  is a documented next step.
- This contract is currently a **demonstration of the trustless rail**,
  not the trustless rail itself.

### Why this would NOT be acceptable for mainnet / production

Before this contract (or its successor) is used to gate any settlement
involving real value, the pilot-mock keys MUST be replaced with real
hardware-backed keys (Tangem rings, in PollPower's intended deployment).
Public derivability of admin keys is incompatible with the trust model.

## How to swap pilot-mocks for real rings (when hardware arrives)

The contract supports admin rotation via `executeAddAdmin` and
`executeRemoveAdmin`. With pilot-mocks still active, the swap ceremony is:

1. Real ring 1 generates pubkey via Tangem. Add via:
   - 3 of 5 pilot-mocks approve `addAdmin(ring1_pubkey)` actionHash
   - Anyone calls `executeAddAdmin(ring1_pubkey)`
   - Now: 6 admins total, 5 pilot-mock + 1 real.
2. Repeat for rings 2-5. Each addition signs against the current admin
   set (which transitions from "5 pilot-mocks" → "5 pilot-mocks + N real").
3. Optionally raise threshold via `executeSetThreshold(N)` if council
   wants to require more real rings during transition.
4. Remove pilot-mocks one at a time:
   - The current admin set (real + still-pilot-mock) approves `removeAdmin(pilot_mock_i)`
   - Anyone calls `executeRemoveAdmin(pilot_mock_i)`
   - Repeat for all 5.
5. Final state: 5 real rings, 0 pilot-mocks, threshold 3.

The contract enforces "don't drop admin count below threshold" so the
swap must be done in the order above (add reals, then remove pilot-mocks).

## Other operational caveats

- The v5.1 contract's earlier draft had a freshness-check bug (caller-provided
  `currentTime`); the deployed v5.1 uses an in-circuit block-time check instead.
- The off-chain RegistryGate cache that pre-flights mints has no automatic
  invalidation on registry-state changes; admins force a refresh after a
  ceremony.
- EBT v5 (the current production contract) maintains a separate internal
  meter list that is still controlled by the contract owner key. The v5.1
  successor closes this gap by removing the internal meter list entirely and
  replacing it with in-circuit signature verification.

## Verifying the current admin set on chain

To confirm what admin pubkeys are actually present in contract state
(without trusting this file), query the deployed contract directly via
any Midnight Preview indexer or node:

- `getAdminCount()` — number of admins currently registered
- `getThreshold()` — multi-sig threshold (currently 3)
- `getMeterCount()` — number of registered producers/meters
- `isMeterRegistered(<keyHash>)` — whether a specific meter is approved
- `isAdmin(<pubkey>)` — whether a specific pubkey is in the admin set
- `getNonce()` — current nonce (replay protection)

Contract address: `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d`
