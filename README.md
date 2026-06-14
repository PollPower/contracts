# PollPower Smart Contracts

The smart contracts that govern the PollPower energy economy on the [Midnight Network](https://midnight.network).

This repository contains the **canonical, on-chain source** for every contract PollPower currently runs, including audit-hardened versions deployed on 2026-06-12.

> **Released alongside the [PollPower White Paper v10.0](https://github.com/PollPower/whitepaper).**
> The whitepaper describes the design rationale; this repository contains the code that enforces it.

---

## What's here

| Contract | Purpose | Status |
|---|---|---|
| [`ebt/ebt-v5.2.compact`](./ebt/ebt-v5.2.compact) | The Energy-Backed Token. Audit-hardened settlement with producer-bound signatures, attestation binding, and capped reissuance. | ✅ **PRODUCTION** — active mint path since 2026-06-12 |
| [`ebt/ebt-v5.compact`](./ebt/ebt-v5.compact) | EBT v5 (original). Single-authority settlement with internal meter registry. | ⚠️ **LEGACY** — still on chain, balance reads only |
| [`ebt/ebt-v5.1.compact`](./ebt/ebt-v5.1.compact) | EBT v5.1 (stateless attestation). Superseded by v5.2 before cutover. | ❌ **DEAD-LETTER** — deployed but never wired. See [audit findings](#audit-2026-06-10). |
| [`multisig/multisig-v6-ed25519.compact`](./multisig/multisig-v6-ed25519.compact) | 3-of-5 Ed25519 council multi-sig. M-2 domain separation provided at the actionHash layer. | ✅ **PRODUCTION** — *pilot-mock admins active, see [STATUS](./producer-registry/STATUS.md)* |
| [`multisig/multisig-v6.1-ed25519.compact`](./multisig/multisig-v6.1-ed25519.compact) | In-circuit contractTag variant. Redundant with actionHash-layer separation; forces Poseidon into the mobile app. | 📐 **DESIGN ARTIFACT** — not deployed. See [M2-MITIGATION-NOTE](./multisig/M2-MITIGATION-NOTE.md). |
| [`multisig/multisig-v5.compact`](./multisig/multisig-v5.compact) | Multisig v5. Single-admin self-governance. | ❌ **DEPRECATED** — H-2 finding: any single admin can mutate the admin set. See [migration plan](./multisig/H2-MIGRATION-PLAN.md). |
| [`producer-registry/producer-registry-v1.compact`](./producer-registry/producer-registry-v1.compact) | Council-gated registry of approved producers. Pre-flight check before any EBT mint. | ✅ **PRODUCTION** — *pilot-mock admins active* |
| [`community-poll/community-poll-v2.compact`](./community-poll/community-poll-v2.compact) | KYC'd, Sybil-resistant community polls with witness-bound ZK voting. | ✅ **PRODUCTION** — deployed 2026-06-12, smoke-tested on-chain |
| [`community-poll/community-poll.compact`](./community-poll/community-poll.compact) | Community Poll v1. No real ZK guarantees despite comments claiming otherwise. | ❌ **RESEARCH PREVIEW** — C-2 finding: unlimited Sybil voting. See [V2-SPEC](./community-poll/V2-SPEC.md). |

---

## On-chain addresses (Midnight Preview)

### Current production

| Contract | Address | Deployed |
|---|---|---|
| **EBT v5.2** | `4120b44ed9067f5576006a559e187a447c667db401d9c2ef1d44dedb34e3f835` | 2026-06-12 |
| **Multisig v6** | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | 2026-05-08 |
| **Community Poll v2** | `8fcb540d96f34ed18d37ab637f0393341cf4eba2759d09e1e07675fc4f4fea63` | 2026-06-12 |
| **ProducerRegistry v1** | `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d` | 2026-05-09 |

### Legacy (on chain, not active production path)

| Contract | Address | Status |
|---|---|---|
| EBT v5 | `5cbc10a7a8f43a86fab8a8a015823b973be887b41bf6e2b03b51eb2dccff3b0e` | Legacy — balance reads |
| EBT v5.1 | `e3514ab0c5dca1a61700ac96f12f80157ea41474642161ce91cdd62dc0a1291d` | Dead-letter — never wired |
| Multisig v5 | `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce` | Deprecated |
| Multisig v6.1 | `6a57b2fbd39ae6d9e7a85c47db894262a330431926273d7dccfd39f9ca2a8fd7` | Deployed but unused (design artifact) |
| Community Poll v1 | `a6a494880b3d646be22f31f891c1b1ba4df0142cbc7ddc008d9be6812f0b74be` | Research Preview |

---

## Audit (2026-06-10) {#audit-2026-06-10}

On June 10, 2026, the full contract suite (tag `v10.0`, commit `c06191e`) was reviewed by Claude Fable 5 (Anthropic). The review found 2 critical, 2 high, 4 medium, 3 low, and 2 informational findings.

**All findings have been remediated or staged for remediation.** The 2026-06-12 deployment addresses every on-chain finding that was fixable without external ceremony (Tangem ring swap).

| ID | Severity | Finding | Status |
|---|---|---|---|
| C-1 | Critical | `producer` unauthenticated in v5.1 `settle()` — frontrun risk | ✅ Fixed in EBT v5.2 |
| C-2 | Critical | Community-Poll `castVote` has no witness binding — Sybil voting | ✅ Fixed in Poll v2 |
| H-1 | High | Pilot-mock admin keys publicly derivable | ⏳ Tangem ring ceremony |
| H-2 | High | Multisig v5 single-admin self-governance | ✅ Superseded by v6.1 |
| M-1 | Medium | `attestationKey` not bound to `(producer, meterKeyHash)` | ✅ Fixed in EBT v5.2 |
| M-2 | Medium | Ed25519 signed messages lack domain separation | ✅ Mitigated at actionHash layer (contract addr in signed preimage); v6.1 in-circuit variant not needed |
| M-3 | Medium | KYC re-registration stuck / double-revoke undercount | ✅ Fixed in Poll v2 |
| M-4 | Medium | `manualReissue` uncapped, single-key | ✅ Fixed in EBT v5.2 |
| L-1 | Low | `transferOwnership` to ContractAddress bricks owner | ✅ Fixed in EBT v5.2 + Poll v2 |
| L-2 | Low | Generic `approve`/`execute` not nonce-bound | ✅ Fixed in Multisig v6.1 |
| L-3 | Low | Audit timestamps hardcoded to 0 | ✅ Fixed in EBT v5.2 |
| I-1 | Info | File header says "v4" | ✅ Fixed |
| I-2 | Info | Pragma open-ended | ✅ Fixed in Poll v2 |

Full audit spec: [`ebt/V5.2-MIGRATION.md`](./ebt/V5.2-MIGRATION.md) and [`community-poll/V2-SPEC.md`](./community-poll/V2-SPEC.md).

### Known limitations

- **H-1 is operational, not code.** The 5 pilot admin keys are derived from `SHA-256("pollpower-pilot-mock-ring-i")`. They are publicly derivable. This is disclosed because it is demonstration architecture, not a security control. Real Tangem ring pubkeys replace these in the pre-mainnet ceremony.
- **Community Poll v2 has per-transaction linkability.** Nullifier + tallyKey are public per vote transaction. An observer can link an anonymous commitment to its chosen option. Privacy holds across voters, not per transaction. Full ballot privacy (homomorphic tally) is v3 research.
- **ProducerRegistry v1.1 and Multisig v6.1 are not deployed.** v1.1 exceeded the Preview block-size limit (18MB proving keys); both in-circuit `contractTag` variants are redundant with the actionHash-layer M-2 mitigation (the admin app binds the contract address into every signed preimage) and would force a Poseidon dependency into the mobile admin app. v1 and v6 continue as production. See [multisig/M2-MITIGATION-NOTE.md](./multisig/M2-MITIGATION-NOTE.md).

---

## The mint path

EBT cannot be minted unless every party with a role agrees, by signature. No single key — including any held by PollPower — can produce a mint by itself.

**Current path (EBT v5.2, active since 2026-06-12):**

1. A consumer pays KES at a metered outlet.
2. The **gateway hardware** signs the meter reading with its Ed25519 key. The signature covers session ID, hardware pubkey, amount, AND the producer's wallet address (C-1 fix — the producer is bound into the signature).
3. The **Meter Authority** (whose pubkey is set by the council) attests that the gateway is currently approved.
4. The **ProducerRegistry** (3-of-5 council multi-sig-gated) confirms the meter is registered.
5. `settle()` verifies both signatures, the attestation binding (M-1), the slice policy, and the session replay guard, then mints EBT.

Three independent signing roles. No single party completes the path alone.

---

## Reading the contracts

[Compact](https://docs.midnight.network/develop/tutorial/building) is the smart-contract language for Midnight, syntactically similar to TypeScript with ZK-aware semantics. The contracts are small enough to read in one sitting:

- `ebt-v5.2.compact` — ~560 lines (the most complex — two signature verifications + BPS policy)
- `multisig-v6.1-ed25519.compact` — ~300 lines
- `community-poll-v2.compact` — ~290 lines
- `producer-registry-v1.compact` — ~250 lines

Each subdirectory contains a `README.md` and supporting docs.

---

## What's **not** here

This repository intentionally does **not** contain:

- The deployment scripts (those reference seed material; see `ebt/deploy-ebt-v5.2.ts` for the template with redacted seeds)
- The settlement service (the off-chain bridge that calls these contracts)
- The Meter Authority service (the off-chain signer for gateway attestations)
- The mobile apps, backend APIs, or operational tooling

These are PollPower's implementation of the protocol. The contracts here are the **protocol itself**.

For the architectural and economic rationale, see the **[PollPower White Paper v10.0](https://github.com/PollPower/whitepaper)**.

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).

The **"PollPower"** name and logo are trademarks of PollPower and are not licensed under Apache 2.0.

---

## Contributing

Issues and pull requests welcome. Security-sensitive disclosures: **security@pollpower.energy**.

---

*The contracts are the rules. The chain enforces them. Read the source.*
