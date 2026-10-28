# Deployment Register

Canonical register of PollPower smart contracts deployed on-chain. **All addresses below are on the Midnight Preview testnet; no PollPower contracts are deployed on mainnet.**

For architectural context on each contract, see the top-level [README.md](./README.md) and the per-contract subdirectory READMEs. For settlement-service wiring that pins the active EBT contract, see [`ebt/settle-flow/ceremony.mjs`](./ebt/settle-flow/ceremony.mjs).

Addresses marked **unverified** cannot be cross-checked against this repo's own records (the deploy manifest lives in a non-public service repo). Everything else is sourced from the repository files cited in the "Source" column.

## EBT (Energy-Backed Token)

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| **EBT v8 (pilot)** | `c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3` | 2026-08-16 | Active: Milestone II hardware-metered settlement. Initialized 2026-08-01 with `multisigAuthorityHash` = Multisig v6 `f7192a50...` and daemon-mirrored against the TariffRegistry monolith `556fe46f...`. Producer attestations live in the contract's internal `producerAttestations` map (no external ProducerRegistry). `_livingDividendAddress` is `none` by default (bindable via `execMultisigOp` setLD). | pp-settle-service (`ebt/settle-flow/ceremony.mjs` constant `EBT`), pollpower-v2-api active epoch | [README.md](./README.md) "EBT v8 - full settle flow (2026-08-05)", [ebt/SETTLE-FLOW-E2E.md](./ebt/SETTLE-FLOW-E2E.md), [ebt/settle-flow/ceremony.mjs](./ebt/settle-flow/ceremony.mjs), [ebt/ebt-v8.compact](./ebt/ebt-v8.compact) (producer attestation at lines 692-737) |
| EBT v8 (council redeploy) | `4bd6adb0317a215adbe6a4e6f17c0597e9d5943a82dbff90a844fc12806b8b3b` | 2026-08-18 | Dev / simulated only (council re-deploy with MOCK meter authority) | none in production | **Unverified from this repo**: deploy manifest lives in the non-public settlement-service repo. Date 2026-08-18 per that external manifest. |
| EBT v8 (ceremony rehearsal) | `10158a544233f7590ae00fd34255c3646aa25fe75375eab00d76582647ae474f` | 2026-07-29 (ceremony-fenced deploy) / 2026-07-30 (all 10 vk-inserts landed) | Rehearsal, superseded | none | [README.md](./README.md) "EBT v8 - ceremony-fenced deploy + vk-insert rollout (2026-07-30)", [ebt/V8-CEREMONY-FENCE.md](./ebt/V8-CEREMONY-FENCE.md), [ebt/ceremony-artifacts/ebt-v8-ceremony-preview-deploy.json](./ebt/ceremony-artifacts/ebt-v8-ceremony-preview-deploy.json) |
| EBT v7.4.2 | `8df41314e78720d8229b64dbeafff36d05b8b3578d2464cffcb271ccebb3c415` | 2026-07-05 | Legacy / superseded on Preview by EBT v8 | none in production | [README.md](./README.md) "Current production - v7.4 contract generation (2026-07-05)" |
| EBT v7 | `667d7f2aad9fac8613604df544d608ee2956f1771e440cc0c666592e80bec2b4` | 2026-06-17 | Legacy / superseded on Preview by v7.4.2 then v8 | none in production | [README.md](./README.md) "Prior production (2026-06 generation, on chain)", [ebt/README.md](./ebt/README.md) EBT v7 section |
| EBT v5.2 | `4120b44ed9067f5576006a559e187a447c667db401d9c2ef1d44dedb34e3f835` | 2026-06-12 | Legacy / superseded by v7 | none in production | [README.md](./README.md) "Legacy (on chain, not active production path)", [ebt/README.md](./ebt/README.md) EBT v5.2 section |
| EBT v5 | `5cbc10a7a8f43a86fab8a8a015823b973be887b41bf6e2b03b51eb2dccff3b0e` | **Unverified** (deploy date not recorded in this repo) | Deprecated 2026-10-28; balance reads only, no longer the active mint path | none | [README.md](./README.md) "Legacy" table |
| EBT v5.1 | `e3514ab0c5dca1a61700ac96f12f80157ea41474642161ce91cdd62dc0a1291d` | **Unverified** (deploy date not recorded in this repo) | Dead-letter: deployed but never wired (superseded by v5.2 before cutover) | none | [README.md](./README.md) "Legacy" table, [NOTICE](./NOTICE) |

## TariffRegistry

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| **TariffRegistry (monolith-ceremony)** | `556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9` | 2026-07-31 (ceremony-fenced deploy) / 2026-08-01 (all 11 vk-inserts landed) | Active: live pilot registry (all 18 circuits DEFINED). Source of truth for tariff schedules / lanes / class totals that EBT v8 `settle` reads via mirrored root. | **EBT v8 pilot `c9ee6171...`** (via off-chain mirror daemon advancing `_registryActionLogRoot` / `_registryActionLogHeadSeq` into the EBT mirror surface before every settle) | [tariff-registry/MONOLITH-CEREMONY.md](./tariff-registry/MONOLITH-CEREMONY.md), [README.md](./README.md) "EBT v8 - full settle flow (2026-08-05)" |

## Multisig

The EBT v8 pilot and the earlier v7.4 stack use **different** multisig contracts. v8 was initialized on 2026-08-01 with Multisig v6 as its `multisigAuthorityHash` (evidence: `ebt/deploy-artifacts/ebt-v8-initialize-2026-08-01T00-50-44.json` in the private settlement-service repo); the v7.4 stack governance ring is Multisig v7, deployed 2026-07-05.

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| **Multisig v6** | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | 2026-05-08 | **Active: governance authority bound into the EBT v8 pilot** (set as `_multisigAuthority` at initialize 2026-08-01); also the active ring for all v6/v6-era downstream contracts | **EBT v8 pilot `c9ee6171...`** (as `_multisigAuthority` hash) | [README.md](./README.md) "Prior production (2026-06 generation, on chain)", [multisig/README.md](./multisig/README.md) on-chain-addresses table, [NOTICE](./NOTICE); initialize args archived in private settlement-service repo |
| Multisig v7 (Ed25519) | `e03478718030d07eb1e7d8fa4fd322751e000fa48195b67ea442ec8b29f47ce5` | 2026-07-05 | Active for the v7.4 stack only; superseded on the v8 pilot path (which binds v6 directly as its multisig authority); pilot-mock admins active, pre-mainnet Tangem swap pending | EBT v7.4.2, LD v2.2.1, Producer Registry v2 (v7.4 stack governance) | [README.md](./README.md) "Current production - v7.4 contract generation (2026-07-05)" |
| Multisig v6.1 | `6a57b2fbd39ae6d9e7a85c47db894262a330431926273d7dccfd39f9ca2a8fd7` | **Unverified** (deploy date not recorded in this repo) | Deployed but unused (design artifact; redundant with actionHash-layer M-2 mitigation) | none | [README.md](./README.md) "Legacy" table, [multisig/README.md](./multisig/README.md) on-chain-addresses table |
| Multisig v5 | `182a7a8b8163d2bd98e4ff2e1c9dec7ef788e8503f46db46be311d74a2d8a7ce` | **Unverified** (deploy date not recorded in this repo) | Deprecated (H-2 single-admin self-governance finding) | none | [README.md](./README.md) "Legacy" table, [multisig/README.md](./multisig/README.md), [NOTICE](./NOTICE) |

## Producer Registry

**EBT v8 does not reference any external ProducerRegistry contract.** The v8 contract carries its own on-chain producer-attestation surface (`producerAttestations` map + `attestProducerOwnership` / `revokeProducerOwnership` circuits in `ebt/ebt-v8.compact` lines 692-737). The ProducerRegistry contracts below are only used by the earlier v5-era and v7.4-stack mint paths.

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| Producer Registry v2 | `d1eefe13f238c456d7cda017feb046a104f05cfedbc2259e97f4d703b9d0a740` | 2026-07-05 | Active for the v7.4 stack only; **not referenced by the EBT v8 pilot** (v8 uses its own internal producer-attestation surface) | v7.4 stack (EBT v7.4.2 pre-flight) | [README.md](./README.md) "Current production - v7.4 contract generation (2026-07-05)" |
| ProducerRegistry v1 | `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d` | 2026-05-09 | Legacy: gated every EBT v5 settlement via off-chain pre-flight check; **not referenced by the EBT v8 pilot** | historical EBT v5 settlement pre-flight (no longer the active mint path) | [producer-registry/README.md](./producer-registry/README.md), [producer-registry/STATUS.md](./producer-registry/STATUS.md), [README.md](./README.md), [NOTICE](./NOTICE) |

## Living Dividend

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| **Living Dividend v2.2.1** | `9c12e8b12fa6c6180e86b986dddd46c049e9c2e46724ed2309debf2c19af069a` | 2026-07-05 | Active for the v7.4 stack (full 5-member payout loop validated 2026-07-05); superseded by v2.2.2 staged in the settlement-api repo. **Not bound to the EBT v8 pilot by default** (`_livingDividendAddress` is `none` at v8 init; bindable later via `execMultisigOp` setLD). | v7.4 stack dividend-slice route | [README.md](./README.md) "Current production - v7.4 contract generation (2026-07-05)" |
| Living Dividend v2.2.1 (genesis demo) | `702dc89a1409d58d8b309533269aae5a4f36535ef21b31d1bbc20ceff3a998ed` | 2026-07-05 | Zero-state demo contract (used for the 2026-07-05 end-to-end validation: 5 members register, settle, dividend mint, 5 claims, all 5 paid on-chain) | validation only | [README.md](./README.md) "Current production - v7.4 contract generation (2026-07-05)" |

## Community Poll

| Contract | Address (full) | Deployed | Status | Used by | Source |
|---|---|---|---|---|---|
| **Community Poll v2** | `8fcb540d96f34ed18d37ab637f0393341cf4eba2759d09e1e07675fc4f4fea63` | 2026-06-12 | Active: witness-bound ZK voting with real Sybil resistance | KYC-gated member polls | [community-poll/README.md](./community-poll/README.md), [README.md](./README.md) "Prior production (2026-06 generation, on chain)" |
| Community Poll v1 | `a6a494880b3d646be22f31f891c1b1ba4df0142cbc7ddc008d9be6812f0b74be` | **Unverified** (deploy date not recorded in this repo) | Research Preview, deprecated: C-2 critical finding (unlimited Sybil voting; no real ZK guarantees) | none (historical artifact only) | [community-poll/README.md](./community-poll/README.md), [README.md](./README.md) "Legacy" table, [NOTICE](./NOTICE) |

## Not deployed (contracts in this repo without an on-chain address)

The following contracts live in this repo but have no deployed address on Midnight Preview. They are staged, design-artifact, or dev-draft only.

- `ebt/ebt-v7.1.compact` - design basis for v7.4.2; folded into v7.4.2 at deploy
- `multisig/multisig-federated-v1.compact` - dev-draft Fractal Federation council; compiles clean (19 circuits, 22/22 offline smoke); not deployed, not audited
- `multisig/multisig-v6.2-ed25519.compact` - staged H-3 remediation; compiles clean; awaiting pre-mainnet hardening ceremony
- `producer-registry/producer-registry-v1.1.compact` - exceeded Preview block-size limit (18MB proving keys); not deployed
- Living Dividend v2.2.2 - audit fixes (LD-C-1, LD-H-3) staged in the [settlement-api](https://github.com/PollPower/settlement-api) repo; awaiting redeploy

## Off-chain authorities (not contracts)

The **Meter Authority (HAT)** is an operational signing key, not a deployed contract. The current HAT pubkey is set on each EBT contract via `initialize()` (and rotatable via governance). On the active pilot EBT v8 (`c9ee6171...`), the HAT pubkey is the one signed into the 5-field HAT payload for every `settle()` call (domain separator `pollpower:ebt:v8:epoch1`). See [README.md](./README.md) "The mint path" and [ebt/SETTLE-FLOW-E2E.md](./ebt/SETTLE-FLOW-E2E.md) for the live-mode HAT wiring on 2026-08-05.

## Keeping this register current

When a new contract is deployed (or an existing contract is redeployed, retired, or re-roled) edit this file as part of the same change. The top-level [README.md](./README.md) address tables remain the primary narrative source; this file is the single-table lookup.
