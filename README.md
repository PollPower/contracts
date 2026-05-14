# PollPower Smart Contracts

The smart contracts that govern the PollPower energy economy on the [Midnight Network](https://midnight.network).

This repository contains the **canonical, on-chain source** for every contract PollPower currently runs in production, plus one contract (EBT v5.1) that is deployed and operational on chain but is not yet wired into the production settlement path.

> **Released alongside the [PollPower White Paper v10.0](https://github.com/PollPower/whitepaper).**
> The whitepaper describes the design rationale; this repository contains the code that enforces it.

---

## What's here

| Contract | Purpose | Status |
|---|---|---|
| [`ebt/ebt-v5.compact`](./ebt/ebt-v5.compact) | The Energy-Backed Token. Mints EBT at settlement; transfers, redeems for KES via burn. | ✅ **PRODUCTION** — current mint path |
| [`ebt/ebt-v5.1.compact`](./ebt/ebt-v5.1.compact) | Stateless-attestation successor. Verifies gateway hardware signature + Meter Authority attestation directly inside the settlement circuit. | 🟡 **DEPLOYED — cutover pending** |
| [`multisig/multisig-v5.compact`](./multisig/multisig-v5.compact) | The first multi-sig contract — current owner of EBT v5. | ✅ **PRODUCTION** |
| [`multisig/multisig-v6-ed25519.compact`](./multisig/multisig-v6-ed25519.compact) | 3-of-5 Ed25519 council multi-sig. The "council" referenced in the whitepaper. | ✅ **PRODUCTION** — *pilot-mock admins active, see [STATUS](./producer-registry/STATUS.md)* |
| [`producer-registry/producer-registry-v1.compact`](./producer-registry/producer-registry-v1.compact) | Council-gated registry of approved producers. Pre-flight check before any EBT mint. | ✅ **PRODUCTION** — *pilot-mock admins active* |
| [`community-poll/community-poll.compact`](./community-poll/community-poll.compact) | KYC'd, Sybil-resistant community polls with ZK voting. | ✅ **PRODUCTION** |

---

## On-chain addresses (Midnight Preview)

| Contract | Address | Deployed |
|---|---|---|
| EBT v5 | `5cbc10a7a8f43a86fab8a8a015823b973be887b41bf6e2b03b51eb2dccff3b0e` | 2026-05-04 |
| EBT v5.1 | `e3514ab0c5dca1a61700ac96f12f80157ea41474642161ce91cdd62dc0a1291d` | 2026-05-09 |
| Multisig v5 | `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce` | 2026-05-06 |
| Multisig v6 (Ed25519) | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | 2026-05-08 |
| ProducerRegistry v1 | `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d` | 2026-05-09 |
| Community Poll | `a6a494880b3d646be22f31f891c1b1ba4df0142cbc7ddc008d9be6812f0b74be` | 2026-04-10 |

You can query any of these directly against a Midnight Preview indexer or node to verify their state.

---

## The mint path in plain language

The whole point of these contracts is that **EBT cannot be minted unless every party with a role agrees, by signature**. No single key — including any held by PollPower — can produce a mint by itself.

Today's mint path (EBT v5):
1. A consumer pays KES at a metered outlet.
2. The PollPower settlement service prepares a settlement call to `EBT.settle()`.
3. The contract verifies the producer named in the call is in the on-chain **ProducerRegistry** (`v1`), which requires 3-of-5 **council multi-sig** signatures to modify.
4. The contract verifies the meter ID was previously registered.
5. EBT mints to the producer's wallet, split by the on-chain margin policy.

EBT v5.1 (deployed but not yet wired) adds two in-circuit signature verifications to that path:
- The **gateway hardware** must have signed the meter reading.
- The **Meter Authority service** (whose pubkey is set by the council) must have attested that the gateway is currently approved.

After v5.1 cutover, the mint path is gated by signatures from **three independent roles**:
- The metering hardware (signed reading)
- The Meter Authority (signed gateway attestation)
- The council (multi-sig-gated producer registry)

No single party can complete the path alone.

---

## Reading the contracts

If you've never read [Compact](https://docs.midnight.network/develop/tutorial/building) before, it's the smart-contract language for Midnight, syntactically similar to TypeScript with ZK-aware semantics. The contracts here are small enough to read in one sitting:

- `ebt-v5.compact` — ~250 lines
- `ebt-v5.1.compact` — ~300 lines
- `multisig-v5.compact` — ~120 lines
- `multisig-v6-ed25519.compact` — ~180 lines
- `producer-registry-v1.compact` — ~250 lines
- `community-poll.compact` — ~180 lines

Each subdirectory contains a `DESIGN.md` (architectural intent), a `STATUS.md` where relevant (operational state), and a per-contract `README.md` (entry-point walkthrough).

---

## Verifying deployment

The on-chain bytecode at each address above was compiled from the corresponding source file in this repository.

To verify a contract was deployed from the source:

```bash
# Install compactc 0.30.0 from Midnight
# https://docs.midnight.network/develop/installation

# Compile locally
compact compile ebt/ebt-v5.compact ./build/ebt-v5

# Compare the contract hash to what's on chain
# (See Midnight docs for the canonical chain-query workflow)
```

The contract hash, ZK circuit hashes, and verifier keys derived from this source should match what an indexer returns for the deployed address.

---

## What's **not** here

This repository intentionally does **not** contain:

- The deployment scripts (those reference seed material and operational secrets)
- The settlement service implementation (the off-chain bridge that calls these contracts)
- The Meter Authority service (the off-chain signer that issues gateway attestations under EBT v5.1)
- The mobile apps, backend APIs, or operational tooling

These are PollPower's implementation of the protocol. The contracts here are the **protocol itself** — the rules that any operator (including PollPower) must follow when minting EBT or governing the network.

For the architectural and economic rationale behind the contracts, see the **[PollPower White Paper v10.0](https://github.com/PollPower/whitepaper)**.

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).

This is a permissive open-source license that includes a patent grant. You may use, modify, and distribute this code freely, including in commercial contexts.

The **"PollPower"** name and logo are not licensed under Apache 2.0 — they remain trademarks of PollPower. The contract code is open; the brand is not.

For the rationale behind this licensing choice and how it fits into PollPower's broader open-source strategy, see the whitepaper's discussion of the protocol-as-public-good model.

---

## Contributing

Issues and pull requests welcome.

For contract-level changes that would affect deployed contracts: open an issue first. Deployed contracts on chain cannot be modified, only superseded by new deployments — so contract changes go through a careful review-and-redeploy cycle, not in-place edits.

For documentation, comments, typos, and clarifying questions: PRs welcome directly.

Security-sensitive disclosures: **security@pollpower.energy** (PGP key linked at https://pollpower.energy/security).

---

## Companion repositories

- [`PollPower/whitepaper`](https://github.com/PollPower/whitepaper) — design rationale, economic model, and addenda
- *(Future: hardware design, firmware, and formal specification will be published once the first real-world EBT mint is recorded.)*

---

*The contracts are the rules. The chain enforces them. Read the source.*
