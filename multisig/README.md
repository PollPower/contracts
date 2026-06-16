# Multi-Sig Contracts

The council multi-signature contracts that govern privileged operations across the PollPower protocol.

| File | Status |
|---|---|
| [`multisig-v6-ed25519.compact`](./multisig-v6-ed25519.compact) | ✅ **PRODUCTION** — 3-of-5 Ed25519 council multi-sig. M-2 domain separation is provided at the actionHash layer (see [M2-MITIGATION-NOTE.md](./M2-MITIGATION-NOTE.md)). Open hardening item: H-3 unbounded admin set + fixed threshold (see [UNBOUNDED-ADMIN-FINDING.md](./UNBOUNDED-ADMIN-FINDING.md)). |
| [`multisig-v6.1-ed25519.compact`](./multisig-v6.1-ed25519.compact) | 📐 **DESIGN ARTIFACT** — in-circuit `contractTag` variant. NOT deployed: redundant with the actionHash-layer mitigation and forces a Poseidon dependency into the mobile admin app. See [M2-MITIGATION-NOTE.md](./M2-MITIGATION-NOTE.md). |
| [`multisig-v5.compact`](./multisig-v5.compact) | ❌ **DEPRECATED** — single-admin self-governance vulnerability (H-2). See [H2-MIGRATION-PLAN.md](./H2-MIGRATION-PLAN.md). |

## What the council does

The council is the governance layer for slow, deliberate operations:

- **Approving new producers** in the [`ProducerRegistry`](../producer-registry/)
- **Designating the Meter Authority** (the operational signer for gateway attestations)
- **Managing its own admin set** (add/remove admins, change threshold)

## M-2 — domain separation (mitigated at actionHash layer)

The audit's M-2 finding assumed admins sign a bare `actionHash` that could be
replayed across contracts sharing the admin key set. In practice the admin app
never signs a bare actionHash — `actionHash.ts` builds it as
`SHA-256("PollPowerMultiSig.v5" | chain=… | contract=<address> | op=… | params=… | nonce=…)`,
so the contract address is already bound into every signed preimage. A
signature for one contract's actionHash is invalid for another. v6.1's
in-circuit `contractTag` (Poseidon) is therefore redundant and is not
deployed. Full reasoning: [M2-MITIGATION-NOTE.md](./M2-MITIGATION-NOTE.md).

## H-3 — unbounded admin set + fixed threshold (open)

`executeAddAdmin` grows `_admins` without a size cap, while `_threshold` is
fixed at `initialize()` and never scales with the set. A one-time
threshold-many compromise can therefore be made *permanent*: the attacker adds
puppet admins at the unchanged threshold and entrenches, while every honest
admin's relative weight dilutes. Affects both v6 (production) and the v6.1
artifact (identical governance logic). Not pilot-urgent (one operator holds all
five keys), but a pre-mainnet must-fix. Proposed v6.2 remediation (hard size
cap + threshold-coupled-to-size + size-relative init guard + setThreshold
majority floor) is documented in
[UNBOUNDED-ADMIN-FINDING.md](./UNBOUNDED-ADMIN-FINDING.md).

## L-2 — nonce binding

The actionHash includes `nonce=<n>` in its preimage and the contract's
self-governance `execute*` variants recompute the nonce-bound hash in-circuit,
so cleared-then-re-approved hashes cannot be re-executed. (The v6.1 generic
`execute(opSelector, payload)` form was the in-circuit version of this; not
needed given the actionHash already binds the nonce.)

### Pilot-mock admin keys (H-1)

The current 5 admin keys are derived from `SHA-256("pollpower-pilot-mock-ring-i")` where `i` is 1-5. **These are publicly derivable.** This is demonstration architecture for the Preview network pilot, not a security control. Real Tangem ring pubkeys replace these in the pre-mainnet ceremony. See [`../producer-registry/STATUS.md`](../producer-registry/STATUS.md).

## On-chain addresses (Midnight Preview)

| Contract | Address | Status |
|---|---|---|
| **Multisig v6** | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | ✅ Production |
| Multisig v6.1 | `6a57b2fbd39ae6d9e7a85c47db894262a330431926273d7dccfd39f9ca2a8fd7` | Deployed but unused (design artifact) |
| Multisig v5 | `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce` | Deprecated |
