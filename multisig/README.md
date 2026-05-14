# Multi-Sig Contracts

The council multi-signature contracts that govern privileged operations across the PollPower protocol.

| File | Status |
|---|---|
| [`multisig-v5.compact`](./multisig-v5.compact) | ✅ **PRODUCTION** — current owner of EBT v5; threshold-signed action approval |
| [`multisig-v6-ed25519.compact`](./multisig-v6-ed25519.compact) | ✅ **PRODUCTION** — 3-of-5 Ed25519 council multi-sig (the "council" in the whitepaper) |

## What the council does

The council is the governance layer for slow, deliberate operations:

- **Designating the Meter Authority** (the operational signer for gateway attestations under EBT v5.1)
- **Approving new producers** in the [`ProducerRegistry`](../producer-registry/)
- **Revoking** compromised producers, the Meter Authority, or council keys themselves
- **Adjusting network parameters** that require ceremony rather than continuous operation
- **Authorising contract upgrades** or emergency procedures

The council does **not** approve individual gateways. That responsibility is delegated to the Meter Authority (see [EBT v5.1](../ebt/)), because gateway provisioning happens too often in the field to gate every install on a multi-party ceremony. The Authority operates within the trust granted to it by the council; if the Authority is ever compromised, the council revokes it.

## Multi-sig v5

**Address (Midnight Preview):** `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce`
**Deployed:** 2026-05-06

The original multi-sig design. Currently the owner of EBT v5. Designed for Compact's native account-key threshold model.

## Multi-sig v6 (Ed25519 witness)

**Address (Midnight Preview):** `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a`
**Deployed:** 2026-05-08

The current 3-of-5 council multi-sig. Uses an Ed25519-signature witness pattern: signatures are verified off-chain in the prover, gated by an in-circuit `assert` on the verification result. This is the idiomatic Compact pattern for ring-signature multi-sig and allows the contract to bind to specific external keypairs (Tangem hardware rings, in PollPower's intended deployment).

The contract verifies real Ed25519 signatures, enforces the 3-of-5 threshold, and provides replay protection via a nonce that advances with every executed action.

### Trust caveat — pilot-mock admins active

⚠️ **The 5 admin keypairs currently registered on this contract are derived from public seed strings**, not real Tangem rings. See [STATUS](../producer-registry/STATUS.md) for the full disclosure.

This is acceptable on Midnight Preview where no real value is at stake; it is **not** the trust model for production at scale. The planned ceremony to swap real Tangem ring keys in is documented in the same STATUS file.

See [`v6-DESIGN.md`](./v6-DESIGN.md) for the full architectural intent.
