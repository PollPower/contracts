# Multi-Sig Contracts

The council multi-signature contracts that govern privileged operations across the PollPower protocol.

| File | Status |
|---|---|
| [`multisig-v6.1-ed25519.compact`](./multisig-v6.1-ed25519.compact) | ✅ **PRODUCTION** — domain-separated 3-of-5 Ed25519 council multi-sig |
| [`multisig-v6-ed25519.compact`](./multisig-v6-ed25519.compact) | ⚠️ **LEGACY** — superseded by v6.1 (lacks M-2 domain separation) |
| [`multisig-v5.compact`](./multisig-v5.compact) | ❌ **DEPRECATED** — single-admin self-governance vulnerability (H-2). See [H2-MIGRATION-PLAN.md](./H2-MIGRATION-PLAN.md). |

## What the council does

The council is the governance layer for slow, deliberate operations:

- **Approving new producers** in the [`ProducerRegistry`](../producer-registry/)
- **Designating the Meter Authority** (the operational signer for gateway attestations)
- **Managing its own admin set** (add/remove admins, change threshold)

## v6.1 — What changed from v6 (2026-06-12)

**M-2 fix:** Approvals are now signed over `persistentHash([contractTag, actionHash])` instead of bare `actionHash`. The multisig and ProducerRegistry share the same admin key set (same Tangem rings); without domain separation, a signature collected for one contract could be replayed against the other.

**L-2 fix:** Generic `execute()` now takes `(opSelector, payload)` and recomputes the nonce-bound action hash in-circuit. Every executed action is structurally nonce-bound — cleared-then-re-approved hashes cannot be re-executed.

### Pilot-mock admin keys (H-1)

The current 5 admin keys are derived from `SHA-256("pollpower-pilot-mock-ring-i")` where `i` is 1-5. **These are publicly derivable.** This is demonstration architecture for the Preview network pilot, not a security control. Real Tangem ring pubkeys replace these in the pre-mainnet ceremony. See [`../producer-registry/STATUS.md`](../producer-registry/STATUS.md).

## On-chain addresses (Midnight Preview)

| Contract | Address | Status |
|---|---|---|
| **Multisig v6.1** | `6a57b2fbd39ae6d9e7a85c47db894262a330431926273d7dccfd39f9ca2a8fd7` | ✅ Production |
| Multisig v6 | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | Legacy |
| Multisig v5 | `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce` | Deprecated |
