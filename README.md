# PollPower Smart Contracts

**The rules of a working energy economy, written as code and enforced by a blockchain.** These are the smart contracts behind PollPower — a renewable-energy economy for rural Kenya — running on the [Midnight Network](https://midnight.network).

This isn't a whitepaper promise. Every contract here is **live, on-chain, and proven end-to-end on Midnight Preview**: a solar producer sells power, three independent parties sign off, tokens are minted directly to the producer's wallet, and every KYC-verified community member is paid their share — all without any single party (PollPower included) able to move value alone. On **2026-08-05** the next-generation **EBT v8** settlement contract closed its full economic loop on-chain for the first time: `retune → mirror → settle → revoke`, minting real supply against a live tariff registry with a real Meter-Authority signature.

This repository is the **canonical, on-chain source** for every contract PollPower runs — from the audit-hardened suite deployed 2026-06-12, through the domain-bound v7.4.x generation live on Preview since 2026-07-05, to EBT v8 today. The whitepaper describes the vision; **this code is the vision, enforced.**

## 🏁 Latest milestone

> ✅ **The full EBT v8 settle flow is proven end-to-end on Midnight Preview (2026-08-05).** For the first time, the next-generation settlement contract ran its complete economic lifecycle on-chain: a tariff class was retuned on the live pilot TariffRegistry, that change was mirrored into the EBT contract's registry surface, `settle` was executed with a **real Meter-Authority (HAT) signature** — minting `_totalSupply` from **0 → 100,000** in exact policy slices — and the producer's ownership attestation was then revoked. **Six transactions, all landed** (`SucceedEntirely`), spanning ~38 minutes. This closes the loop the whole v8 line was built for: `retune → mirror → settle → revoke`, with a live HAT signature and a mirrored TariffRegistry root. See the [EBT v8 on-chain flow](#ebt-v8--full-settle-flow-2026-08-05) below and [`ebt/SETTLE-FLOW-E2E.md`](./ebt/SETTLE-FLOW-E2E.md) for the full runbook.

<details>
<summary><b>Milestone history</b> (newest → oldest)</summary>

> 🔬 **EBT v8 mirror daemon E2E (2026-08-04).** Ahead of the settle flow, the off-chain **mirror daemon** was validated end-to-end on Preview: the full tariff → mirror pipeline (registry action-log root → owner-advance → EBT registry-surface mirror) works on-chain, with **5/5 registry events mirrored** (schedule lifecycle + 4 lanes). The daemon reads the audit sibling's action-log climb and advances the EBT contract's mirrored root/head so `settle` can read a coherent registry state.

> 🔧 **EBT v8 ceremony-fenced deploy + vk-insert rollout (2026-07-30).** The full 18-circuit v8 contract deploys via a **ceremony-fenced approach** — v8's monolithic 18-circuit deploy tx exceeds Preview's per-tx block-weight limit, so 8 ceremony-critical circuits go in one deploy tx, then the remaining 10 are added via `submitInsertVerifierKeyTx` maintenance txs (10 sequential inserts, all `SucceedEntirely`, verified 18/18 DEFINED on-chain). This deploy-then-vk-insert pattern is the proven workaround for any Compact contract that exceeds the block limit. See [`ebt/V8-CEREMONY-FENCE.md`](./ebt/V8-CEREMONY-FENCE.md) for the design + rollout plan.

> 💧 **Living Dividend full economic loop (2026-07-05).** The **Living Dividend** — the mechanism that pays every KYC-verified member a share of every energy sale — completed its **full economic loop live on Preview**: five members joined a brand-new (zero-state) dividend pool, an energy sale minted the dividend, and **all five members claimed and were paid on-chain**. First end-to-end join → earn → claim → get-paid cycle for a group of members from a true zero start. See [the v7.4 stack](#the-v74-contract-generation-2026-07-05) below.

</details>

> ⚠️ **EBT v8 Preview pilot posture.** The v8 contract lineage introduces `settle` against a mirrored TariffRegistry root plus a weekly owner-advance ceremony. Its Preview admin set is **1 real Tangem ring + 4 pilot-mock keys, all held by Garrett**. External attackers can derive the four pilot-mock private keys from public seeds (this is the tracked **H-1** gap). This posture is intentional for the Preview pilot to prove the ceremony loop; **mainnet Phase 2 is hard-gated on a full Tangem ring swap** (WI-14.2). See [`ebt/WI-14-CEREMONY-SKELETON.md`](./ebt/WI-14-CEREMONY-SKELETON.md) §9 CAL-1 and [`ebt/VNEXT-MIGRATION.md`](./ebt/VNEXT-MIGRATION.md) for the cutover plan.

> **Released alongside the [PollPower White Paper v10.0](https://github.com/PollPower/whitepaper).**
> The whitepaper describes the design rationale; this repository contains the code that enforces it.

---

## What's here

| Contract | Purpose | Status |
|---|---|---|
| [`ebt/ebt-v8.compact`](./ebt/ebt-v8.compact) | **EBT v8 — next-generation settlement contract.** 18 exported circuits covering `settle` against a mirrored TariffRegistry root, full daemon-mirrored registry surface (register/retire lane, schedule lifecycle, class totals, action-log head/root), dual governance (`execMultisigOp` multisig-cosigned + `execOwnerOp` owner-signed), producer redemption, and break-glass emergency reissue. Carries forward the EBT-H-1 fix (5-field HAT signed payload includes `producerAddr` with domain sep `pollpower:ebt:v8:epoch1`). See [`ebt/VNEXT-DESIGN.md`](./ebt/VNEXT-DESIGN.md), [`ebt/VNEXT-MIGRATION.md`](./ebt/VNEXT-MIGRATION.md), [`ebt/WI-14-CEREMONY-SKELETON.md`](./ebt/WI-14-CEREMONY-SKELETON.md), and [`ebt/SETTLE-FLOW-E2E.md`](./ebt/SETTLE-FLOW-E2E.md). | ✅ **PREVIEW — full settle flow proven on-chain 2026-08-05** (`retune → mirror → settle → revoke`, `_totalSupply` 0→100,000 with real HAT sig). Deployed ceremony-fenced 2026-07-30; all 18 circuits DEFINED. |
| [`ebt/ebt-v8-ceremony.compact`](./ebt/ebt-v8-ceremony.compact) | **EBT v8 ceremony-fenced build** — 8-circuit subset of v8, byte-identical to v8 in the circuits it defines (`initialize`, `attestProducerOwnership`, `revokeProducerOwnership`, `mirrorActionLogHead`, `mirrorScheduleLifecycle`, `mirrorClassStatutoryTotal`, `mirrorRegisterLane`, `settle`). Deployed in a single tx; the remaining 10 v8 circuits are added post-deploy via `submitInsertVerifierKeyTx` maintenance txs. This split is the workaround for v8's monolithic deploy exceeding Preview's per-tx block weight limit. See [`ebt/V8-CEREMONY-FENCE.md`](./ebt/V8-CEREMONY-FENCE.md). | ✅ **PREVIEW** — deployed 2026-07-30 as the base of the full 18-circuit rollout |
| [`ebt/ebt-v7.4.2.compact`](./ebt/ebt-v7.4.2.compact) | **EBT v7.4.2 — current settlement contract.** v7.1 lineage + domain-bound dividend salt (LD-1: contract address bound into the mint record so it can't be replayed across deployments), and the four multisig setters / two owner setters merged into `execMultisigOp(op,…)` / `execOwnerOp(op,…)` to fit the block-weight limit. Adds in-place `setMultisigAuthority` rotation so the pre-mainnet Tangem ring swap needs no redeploy. Carries forward all v5.2 audit hardening (C-1, M-1, M-4, L-1, L-3). | ✅ **PRODUCTION (Preview)** — deployed + validated end-to-end 2026-07-05 |
| [`ebt/ebt-v7.compact`](./ebt/ebt-v7.compact) | The Energy-Backed Token (v7). Unshielded, contract-minted ledger token — `settle()` mints the producer slice directly to the producer's wallet; `claimSplit()` distributes the ops/dividend/DAO slices. Carries forward all v5.2 audit hardening (C-1, M-1, M-4, L-1, L-3). | ✅ **PRODUCTION** — active mint path since 2026-06-17; superseded on Preview by v7.4.2 |
| [`ebt/ebt-v7.1.compact`](./ebt/ebt-v7.1.compact) | EBT v7.1 — v7 + `DividendMintedEntry` public ledger log on dividend-slice mint, plus **3-of-5 multisig-gated** `setLivingDividendAddress` / `clearLivingDividendAddress` setters. Design basis for v7.4.2. See [`ebt/V7.1-EVENT-DIFF.md`](./ebt/V7.1-EVENT-DIFF.md). | ✅ **SUPERSEDED** — folded into the deployed v7.4.2 |
| [`ebt/ebt-v5.2.compact`](./ebt/ebt-v5.2.compact) | EBT v5.2. Audit-hardened settlement with producer-bound signatures, attestation binding, and capped reissuance. Superseded by v7's unshielded contract-mint model. | ⚠️ **LEGACY** — on chain, superseded by v7 |
| [`ebt/ebt-v5.compact`](./ebt/ebt-v5.compact) | EBT v5 (original). Single-authority settlement with internal meter registry. | ⚠️ **LEGACY** — still on chain, balance reads only |
| [`ebt/ebt-v5.1.compact`](./ebt/ebt-v5.1.compact) | EBT v5.1 (stateless attestation). Superseded by v5.2 before cutover. | ❌ **DEAD-LETTER** — deployed but never wired. See [audit findings](#audit-2026-06-10). |
| [`multisig/multisig-v7-ed25519.compact`](./multisig/multisig-v7-ed25519.compact) | **Multisig v7 — current council multi-sig.** 3-of-5 Ed25519 with the contract address domain-bound into every signed action (nonce-bound `approve`/`execute`). Governs binding, meter approval, and authority rotation across the v7.4 stack. | ✅ **PRODUCTION (Preview)** — deployed 2026-07-05, *pilot-mock admins active, see [STATUS](./producer-registry/STATUS.md)* |
| [`multisig/multisig-federated-v1.compact`](./multisig/multisig-federated-v1.compact) | **Federated council — research/next-gen governance.** A separate lineage from v7 (domain `pp:msfed:v1:*`). Implements the [Fractal Federation](#governance-the-fractal-federation) design: a fixed 5-seat council **re-drawn each epoch by sortition** (no add/remove admin → structurally kills H-3), a **constitutional floor** (rule changes need a member-referendum attestation on top of council quorum), **federation seats** (a seat can be a lower-tier council, entered via an attested-quorum witness), and **parent-convened dead-council recovery** (30-day liveness gate). See the [adversarial review](./multisig/FEDERATED-V1-REVIEW.md). | 📐 **DEV DRAFT** — full ZK build passes (19 circuits), 22/22 offline smoke; **not deployed**, not audited. |
| [`multisig/multisig-v6-ed25519.compact`](./multisig/multisig-v6-ed25519.compact) | 3-of-5 Ed25519 council multi-sig. M-2 domain separation provided at the actionHash layer. | ✅ **PRODUCTION** — superseded on Preview by v7 |
| [`multisig/multisig-v6.2-ed25519.compact`](./multisig/multisig-v6.2-ed25519.compact) | H-3 hardening of v6: hard-capped admin set (7), threshold coupled to set size (atomic, strict majority), majority floors on init + setThreshold. Built on the v6 production base (no Poseidon-in-app cost). | 🛠️ **STAGED** — compiles clean (compactc 0.30.0 `--skip-zk`), not yet deployed. See [UNBOUNDED-ADMIN-FINDING](./multisig/UNBOUNDED-ADMIN-FINDING.md). |
| [`multisig/multisig-v6.1-ed25519.compact`](./multisig/multisig-v6.1-ed25519.compact) | In-circuit contractTag variant. Redundant with actionHash-layer separation; forces Poseidon into the mobile app. | 📐 **DESIGN ARTIFACT** — not deployed. See [M2-MITIGATION-NOTE](./multisig/M2-MITIGATION-NOTE.md). |
| [`multisig/multisig-v5.compact`](./multisig/multisig-v5.compact) | Multisig v5. Single-admin self-governance. | ❌ **DEPRECATED** — H-2 finding: any single admin can mutate the admin set. See [migration plan](./multisig/H2-MIGRATION-PLAN.md). |
| [`producer-registry/producer-registry-v2.compact`](./producer-registry/producer-registry-v2.compact) | **Producer Registry v2 — current registry.** Council-gated (3-of-5) list of approved meters with the contract address domain-bound into each `approve()` / `executeAddMeter()` action. Pre-flight check before any EBT mint. | ✅ **PRODUCTION (Preview)** — deployed 2026-07-05, *pilot-mock admins active* |
| [`producer-registry/producer-registry-v1.compact`](./producer-registry/producer-registry-v1.compact) | Council-gated registry of approved producers. Pre-flight check before any EBT mint. | ✅ **PRODUCTION** — superseded on Preview by v2 |
| [`community-poll/community-poll-v2.compact`](./community-poll/community-poll-v2.compact) | KYC'd, Sybil-resistant community polls with witness-bound ZK voting. | ✅ **PRODUCTION** — deployed 2026-06-12, smoke-tested on-chain |
| [`community-poll/community-poll.compact`](./community-poll/community-poll.compact) | Community Poll v1. No real ZK guarantees despite comments claiming otherwise. | ❌ **RESEARCH PREVIEW** — C-2 finding: unlimited Sybil voting. See [V2-SPEC](./community-poll/V2-SPEC.md). |
| [`living-dividend/living-dividend-v2.2.1.compact`](./living-dividend/living-dividend-v2.2.1.compact) | **Living Dividend v2.2.1 — current deployed dividend pool.** Cumulative-`accPerShare` accumulator distributing a fraction of every EBT mint to every KYC-verified living member. Domain-bound (LD-3: contract address in all five signed payloads), claim-on-demand + graceful death filter (180-day inactivity, 30-day prune grace). Members register, the keeper bumps the accumulator on each dividend mint, members claim, and an off-chain batch payer settles the payouts. | ✅ **PRODUCTION (Preview)** — deployed + full 5-member payout loop validated 2026-07-05. **Superseded by v2.2.2** (audit fixes, see below). |
| `living-dividend-v2.2.2` *(in [settlement-api](https://github.com/PollPower/settlement-api))* | **v2.2.1 + the 2026-07-07 audit fixes.** **LD-C-1** (Critical): prune/bump time gates switched from a prover-controlled `witness_blockTimeGte` to the stdlib on-chain `blockTimeGte`, so an attacker can no longer forge elapsed-time to prune an active member. **LD-H-3** (High): `bumpOnMint` now requires a keeper signature (new `_keeperAuthority` + `setKeeperAuthority` rotation), killing the salt-squat DoS. | 🛠️ **STAGED** — full ZK build passes (10 circuits/20 keys), mutation-tested; awaiting redeploy. |
| [`living-dividend/living-dividend-v1.compact`](./living-dividend/living-dividend-v1.compact) | Living Dividend v1 — original cumulative-points accumulator design. Downstream of EBT v7.1 via MIP-0002 event pattern. | 📐 **DESIGN ARTIFACT** — superseded by the deployed v2.2.1. See [DESIGN](./living-dividend/DESIGN.md). |

---

## On-chain addresses (Midnight Preview)

### EBT v8 — full settle flow (2026-08-05) {#ebt-v8--full-settle-flow-2026-08-05}

The complete `retune → mirror → settle → revoke` lifecycle, executed on-chain against the live pilot TariffRegistry. `settle` minted `_totalSupply` from **0 → 100,000** in exact policy slices with a **real Meter-Authority (HAT) signature**.

| Contract | Address | Role |
|---|---|---|
| **EBT v8 (full 18 circuits)** | `c9ee61713d07c6d6e6f3c0bbe119d281307c643caaaf8d785813a9fb52f036e3` | Settlement contract — `settle`, mirror surface, all 18 circuits DEFINED |
| **TariffRegistry (monolith-ceremony)** | `556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9` | Live pilot registry the mirror reads (all deferred circuits vk-inserted) |

**On-chain transaction ledger (six txs, all `SucceedEntirely`, 2026-08-05):**

| Step | Circuit | Contract | txHash |
|---|---|---|---|
| A | `retuneClass` | registry `556fe46f` | `8c3187b042dae344726a93a53e0cca8fff12312d979610e13579be7a8a4c4c48` |
| B1 | `mirrorActionLogRoot` | EBT `c9ee6171` | `95419628ce8a63cc86361b60c7f13653ff0cd93af2feae7e5e6faac3b628a45e` |
| B2 | `mirrorClassStatutoryTotal` | EBT | `b4ab6f9e4b1bcaf9bd42200f5263ce68ac44b979d692f0e963897d38fd8de62a` |
| B3 | `mirrorActionLogHead` | EBT | `7983790beee66d2ae37c0db8f8f9ec9b642fbe115bd734ee92c1ffee9593d97b` |
| C | `settle` (real HAT sig) | EBT | `16f160947b7302cb377e77ba610b20fe892b1fd0fa7eba2cfa5d8125724eb020` |
| D | `revokeProducerOwnership` | EBT | `fed5b31edbb14695a1a87fb5e3e2e1009470c91cb8fd2403b243260d83fd39d7` |

Final on-chain state: registry `_actionSeq=6`, EBT mirror head=5, **`_totalSupply=100,000`** (settle minted), producer attestation revoked. All six txs are resolvable on the public Preview explorer ([Night Scan](https://explorer.preview.midnight.network)). Full runbook + reusable scripts: [`ebt/SETTLE-FLOW-E2E.md`](./ebt/SETTLE-FLOW-E2E.md).

### EBT v8 — ceremony-fenced deploy + vk-insert rollout (2026-07-30)

The full 18-circuit EBT v8 contract, deployed via the ceremony-fenced approach (8 circuits in the deploy tx, 10 added post-deploy via `submitInsertVerifierKeyTx`). This is the rehearsal contract that proved the deploy-then-vk-insert pattern before the settle-flow work moved to the live pilot contract above.

| Contract | Address | Deployed |
|---|---|---|
| **EBT v8 (ceremony-fenced deploy, 8 circuits)** | `10158a544233f7590ae00fd34255c3646aa25fe75375eab00d76582647ae474f` | 2026-07-29 (rehearsal) |
| **EBT v8 (full 18 circuits, same address post-vk-insert rollout)** | `10158a544233f7590ae00fd34255c3646aa25fe75375eab00d76582647ae474f` | 2026-07-30 (all 10 inserts landed) |

Rehearsal manifests (deploy tx + 10 vk-insert tx receipts) at [`ebt/ceremony-artifacts/`](./ebt/ceremony-artifacts/).

### Current production — v7.4 contract generation (2026-07-05) {#the-v74-contract-generation-2026-07-05}

The four-contract domain-bound stack, deployed and validated end-to-end on Preview. Council authority `e11cd3e8…ca0b`, threshold 3-of-5.

| Contract | Address | Deployed |
|---|---|---|
| **EBT v7.4.2** | `8df41314e78720d8229b64dbeafff36d05b8b3578d2464cffcb271ccebb3c415` | 2026-07-05 |
| **Living Dividend v2.2.1** | `9c12e8b12fa6c6180e86b986dddd46c049e9c2e46724ed2309debf2c19af069a` | 2026-07-05 |
| **Producer Registry v2** | `d1eefe13f238c456d7cda017feb046a104f05cfedbc2259e97f4d703b9d0a740` | 2026-07-05 |
| **Multisig v7 (Ed25519)** | `e03478718030d07eb1e7d8fa4fd322751e000fa48195b67ea442ec8b29f47ce5` | 2026-07-05 |
| Living Dividend v2.2.1 (genesis demo) | `702dc89a1409d58d8b309533269aae5a4f36535ef21b31d1bbc20ceff3a998ed` | 2026-07-05 |

> The **genesis demo** contract is a fresh zero-state Living Dividend deployed for the 2026-07-05 end-to-end validation (5 members register → settle → dividend mint → 5 claims → all 5 paid on-chain).

### Prior production (2026-06 generation, on chain)

| Contract | Address | Deployed |
|---|---|---|
| EBT v7 | `667d7f2aad9fac8613604df544d608ee2956f1771e440cc0c666592e80bec2b4` | 2026-06-17 |
| Multisig v6 | `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` | 2026-05-08 |
| Community Poll v2 | `8fcb540d96f34ed18d37ab637f0393341cf4eba2759d09e1e07675fc4f4fea63` | 2026-06-12 |
| ProducerRegistry v1 | `c6730596dd7770dd69bd5051a769e8c42d34dc99c47228f751cae38f00b2ff1d` | 2026-05-09 |

### Legacy (on chain, not active production path)

| Contract | Address | Status |
|---|---|---|
| EBT v5.2 | `4120b44ed9067f5576006a559e187a447c667db401d9c2ef1d44dedb34e3f835` | Legacy — superseded by v7 |
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
| H-1 | High | Pilot-mock admin keys publicly derivable | ⏳ **In progress** — real Tangem ring hardware validated end-to-end (first council ring activated, on-chip Ed25519); full 5-ring swap into the on-chain multisig pending pre-mainnet ceremony |
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

### Follow-up review (2026-06-16)

| ID | Severity | Finding | Status |
|---|---|---|---|
| H-3 | High | Multisig v6 admin set is uncapped while `_threshold` is fixed — a one-time threshold capture can be made permanent (puppet admins) and honest votes dilute | 📄 Open — v6.2 remediation staged; see [multisig/UNBOUNDED-ADMIN-FINDING.md](./multisig/UNBOUNDED-ADMIN-FINDING.md) |

H-3 is a pre-mainnet must-fix, not pilot-urgent (one operator holds all five keys during the pilot). Recommended to bundle the v6.2 deploy with the H-1 Tangem ring swap and H-2 v5→v6 cutover ceremony.

Full audit spec: [`ebt/V5.2-MIGRATION.md`](./ebt/V5.2-MIGRATION.md) and [`community-poll/V2-SPEC.md`](./community-poll/V2-SPEC.md).

### Second full audit (2026-07-07)

A fresh two-wave audit reviewed the deployed v7.4.x stack, the Living Dividend, and the off-chain batch-payer daemon. Contract-level highlights and their fixes:

| ID | Severity | Finding | Status |
|---|---|---|---|
| LD-C-1 | Critical | LD prune/bump time gates trusted a prover-controlled `witness_blockTimeGte` → an attacker could forge elapsed time and prune an *active* member | ✅ Fixed in **LD v2.2.2** (stdlib `blockTimeGte`); staged in [settlement-api](https://github.com/PollPower/settlement-api) |
| LD-H-3 | High | LD `bumpOnMint` was unauthenticated → salt-squat DoS of dividend distribution | ✅ Fixed in **LD v2.2.2** (keeper-signature gate + `setKeeperAuthority`) |
| EBT-H-1 | High | `producerAddr` (the mint target) not bound in the HAT signed payload → mint-redirection risk (revises the earlier "C-1 fully fixed" note) | ✅ **Fixed in EBT v8** — `settle` circuit now signs a 5-field HAT payload including `producerAddr` with domain separator `pollpower:ebt:v8:epoch1`. Verified present in the ceremony-deployed contract (2026-07-30). |
| AUTH-H-1 | High | Pilot-mock council keys (same as H-1) | 📄 Open — Tangem ring ceremony |

The LD fixes compile to a full ZK build and are mutation-tested; they await redeploy. **EBT-H-1 is fixed in the EBT v8 contract line** (deployed to Preview 2026-07-30). Remaining medium/low findings (active-attestation check on `settle`, generic `execute()` hardening, rotation-runbook drift) are tracked for the pre-mainnet pass. Backend/app findings from the same audit are remediated in the [pollpower-v2-api](https://github.com/PollPower/pollpower-v2-api), [settlement-api](https://github.com/PollPower/settlement-api), and the consumer/producer apps.

### Known limitations

- **H-1 is operational, not code.** The 5 pilot admin keys are derived from `SHA-256("pollpower-pilot-mock-ring-i")`. They are publicly derivable. This is disclosed because it is demonstration architecture, not a security control. Real Tangem ring pubkeys replace these in the pre-mainnet ceremony. The Tangem hardware path is now validated end-to-end (a real council ring has been activated with an on-chip Ed25519 key); the remaining work is provisioning all five council rings and swapping them into the deployed multisig admin set, retiring the mock keys.
- **Community Poll v2 has per-transaction linkability.** Nullifier + tallyKey are public per vote transaction. An observer can link an anonymous commitment to its chosen option. Privacy holds across voters, not per transaction. Full ballot privacy (homomorphic tally) is v3 research.
- **ProducerRegistry v1.1 and Multisig v6.1 are not deployed.** v1.1 exceeded the Preview block-size limit (18MB proving keys); both in-circuit `contractTag` variants are redundant with the actionHash-layer M-2 mitigation (the admin app binds the contract address into every signed preimage) and would force a Poseidon dependency into the mobile admin app. v1 and v6 continue as production. See [multisig/M2-MITIGATION-NOTE.md](./multisig/M2-MITIGATION-NOTE.md).

---

## Governance: the Fractal Federation {#governance-the-fractal-federation}

Every privileged operation — approving a producer, designating the Meter Authority, rotating keys, changing a threshold — goes through a **council multi-signature**. Today that council is the production **Multisig v7** (`multisig-v7-ed25519.compact`): a fixed **3-of-5 Ed25519** ring where every signed action is domain-bound to the exact contract it targets, so a signature for one contract can never be replayed against another. During the pilot one operator holds all five keys (the publicly-derivable *pilot-mock* keys, H-1); the pre-mainnet ceremony swaps in five hardware **Tangem** rings.

A flat 3-of-5 works for one pilot council. It does **not** scale to a network of village clusters, each of which needs local autonomy while still composing into a coherent whole. That scaling problem is what the **Fractal Federation** design addresses, and it is implemented (as a **DEV DRAFT, not yet deployed**) in [`multisig/multisig-federated-v1.compact`](./multisig/multisig-federated-v1.compact). Its four moving parts:

1. **Sortition seats (no permanent admins).** The council is always exactly 5 seats, but `addAdmin`/`removeAdmin` are *removed*. Instead, each epoch the seats are **re-drawn by lottery** from the tier's membership via `executeRotateSeats`, which commits a `seedCommitment` so anyone can recompute the draw off-chain and verify it. Because the set size is fixed at 5, this *structurally eliminates* the H-3 "stack the admin set with puppets" attack that the flat v6/v7 lineage has to guard against with caps.
2. **Constitutional floor.** Rule-changing operations (threshold, constitutional authority, parent authority) require **two independent approvals**: the council quorum **and** an Ed25519 attestation from a registered *constitutional authority* that a network-wide **member referendum** passed. In production that referendum instrument is **Community Poll v2** (already deployed) — the authority signs only if a designated poll shows the measure passed with the required turnout. So a captured council still cannot rewrite the rules; the members can veto from below.
3. **Federation seats.** A council seat may be a **lower-tier council's contract address** instead of a person's pubkey. That lower tier's quorum enters the parent as an **attested observation**: a registered attestor key co-signs `(seatId ‖ epoch ‖ actionHash)` after seeing the lower tier reach quorum on-chain (the same trust pattern as the Meter Authority). This is how clusters compose into regions without a central admin.
4. **Parent-convened recovery.** A council that loses 3+ seats can never again reach quorum — including to rotate *itself*. If **no** council action lands for 30 days (block-time validated), a registered **parent authority** may trigger a single sortition rotation *without* council quorum. It **convenes, never appoints**: the parent's signature binds the incoming seats to a `seedCommitment`, so a parent that installs cronies produces an unverifiable draw — publicly visible misbehavior.

Why this shape? Threshold quorums **compose multiplicatively** — controlling `(3/5)` of each tier down four levels is only ~13% of the leaves, so a naive tree of councils is *easier* to capture than a single council, not harder. The constitutional floor (members can always veto rule changes from below) and sortition (seats can't be permanently held) are the two load-bearing defenses that make a federation safe rather than merely convenient. The full rationale — including the capture math and its grounding in Ostrom's principle of nested enterprises — lives in the [PollPower White Paper v10.0](https://github.com/PollPower/whitepaper); the contract's own header documents each mechanism against the design, and [`multisig/FEDERATED-V1-REVIEW.md`](./multisig/FEDERATED-V1-REVIEW.md) is its adversarial review.

**Status:** `multisig-federated-v1` is a design exploration. It compiles to a full ZK build (19 circuits) and passes 22/22 offline smoke tests, but it is **not deployed, not audited, and not on the pilot's critical path.** The pilot runs on the flat Multisig v7. Federation is how PollPower intends to grow *beyond* the pilot.

---

## The mint path

EBT cannot be minted unless every party with a role agrees, by signature. No single key — including any held by PollPower — can produce a mint by itself.

**Current path (EBT v7, active since 2026-06-17):**

1. A consumer pays KES at a metered outlet.
2. The **gateway hardware** signs the meter reading with its Ed25519 key. The signature covers session ID, hardware pubkey, amount, AND the producer's wallet address (C-1 fix — the producer is bound into the signature).
3. The **Meter Authority** (whose pubkey is set by the council) attests that the gateway is currently approved.
4. The **ProducerRegistry** (3-of-5 council multi-sig-gated) confirms the meter is registered.
5. `settle()` verifies both signatures, the attestation binding (M-1), the slice policy, and the session replay guard, then mints the producer's EBT slice **as an unshielded ledger token directly to the producer's wallet** — the recipient owns the minted UTXO on chain, not the submitter.
6. `claimSplit()` distributes the operations / dividend / DAO slices per the BPS policy.

v7's unshielded contract-mint model means a third party (the producer) provably receives contract-minted value without trusting the submitter — the capability the earlier shielded design could not deliver. Three independent signing roles; no single party completes the path alone.

**The dividend loop (EBT v7.4.2 + Living Dividend v2.2.1, validated live 2026-07-05):** on each sale, `claimSplit()` mints the dividend slice into the Living Dividend pool. A keeper bumps the pool's `accPerShare` accumulator across all living members, each member claims their accrued share on demand, and an off-chain batch payer settles the payouts. On 2026-07-05 this ran end-to-end from a zero-state pool — 5 members registered, 1 sale settled, and all 5 members claimed and were paid on-chain.

**Next-generation path (EBT v8, proven on Preview 2026-08-05):** v8 replaces the in-contract slice policy with a `settle` that reads a **mirrored TariffRegistry root**. A tariff class is retuned on the registry (`retuneClass`), an off-chain daemon mirrors that change into the EBT contract's registry surface (`mirrorActionLogRoot` / `mirrorClassStatutoryTotal` / `mirrorActionLogHead`), and `settle` then verifies a **5-field HAT signature** (including `producerAddr`, the EBT-H-1 fix) against the mirrored class totals before minting. On 2026-08-05 the full `retune → mirror → settle → revoke` lifecycle ran on-chain end-to-end — `_totalSupply` 0 → 100,000 with a real Meter-Authority signature. See [EBT v8 on-chain flow](#ebt-v8--full-settle-flow-2026-08-05).

---

## Reading the contracts

[Compact](https://docs.midnight.network/develop/tutorial/building) is the smart-contract language for Midnight, syntactically similar to TypeScript with ZK-aware semantics. The contracts are small enough to read in one sitting:

- `ebt-v8.compact` — the next-generation settlement contract (18 circuits; TariffRegistry-mirrored `settle` + full governance/redemption/mirror surface). Deployed to Preview 2026-07-30 via ceremony-fenced approach; see [`ebt/V8-CEREMONY-FENCE.md`](./ebt/V8-CEREMONY-FENCE.md) for the deploy split rationale.
- `ebt-v7.4.2.compact` — the current settlement contract (two signature verifications + BPS policy + unshielded mint + domain-bound dividend salt)
- `living-dividend-v2.2.1.compact` — the current dividend pool (`accPerShare` accumulator + claim-on-demand + death filter)
- `multisig-v7-ed25519.compact` — the current 3-of-5 council multi-sig
- `multisig-federated-v1.compact` — the DEV-DRAFT [Fractal Federation](#governance-the-fractal-federation) council (sortition + constitutional floor)
- `producer-registry-v2.compact` — the current council-gated meter registry
- `community-poll-v2.compact` — KYC'd, Sybil-resistant community polls

Earlier versions (v7, v7.1, v5.x; LD v1; Multisig v6.x; Registry v1.x) remain in-tree for provenance.

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
