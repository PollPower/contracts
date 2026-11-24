# WI-16 ledger 9 status

Branch `wi16-ledger9`. Updated at the end of each task.
Last update: 2026-11-24, start of the fix implementation (design approved, Schnorr for C-2).

## Day-by-day plan vs actual

Scope (Garrett, 2026-11-24): the full fix set (C-1, C-2, H-1) plus LD v3 by
Nov 30, in this order, each step committed with tests green before the next.
Negative tests from the PoC and parity tests are not optional. **If a step
slips by more than half a day, Garrett is told at once; tests are never
compressed to catch up.**

Honest framing: the design estimate was 12–15 dev-days; the plan below is 7
calendar days. It only holds if each step lands in about a day.

| Day | Planned | Actual | Status |
|---|---|---|---|
| Tue 24 | **H-1** (EBT, Multisig: constructor sets all authorities) · Tangem test tooling + admin-app "sign hash" · local devnet up | **H-1 done**: 9 contract tests (3 negative) green; EBT 18→17, ceremony 8→7, Multisig 12→11 circuits. Tangem tooling + software-key pipeline (5 tests) `3d29984`; admin app ring test `e77521b` (monorepo, branch `wi16-ledger9`); devnet up on kenya (node 2.1.101, indexer 4.4.101, proof 9.0.2; offset ports). **Waiting on:** ring signature (needs `read:packages` token for the APK build) | H-1 ✅ · Tangem ⏳ |
| Wed 25 | **C-2** (EBT owner Schnorr) + Schnorr signer lib + parity · **Tangem ring verified on devnet** | | |
| Thu 26 | **C-1 council**: Multisig secp256k1 `approve` + `isApproved`; EBT/TR/LD `requireCouncil` + replay records | | |
| Fri 27 | **C-1 machine signers**: HAT, escrow attestor, schedule operators → Jubjub Schnorr; meter-authority-service signer | | |
| Sat 28 | **LD v3** + EBT `dividendAccrued` / `mintDividend` callee | | |
| Sun 29 | **Full local-devnet run** of the whole stack (fenced deploys, settle, claim) | | |
| Mon 30 | Recorded demo + submission (shows what passed the devnet run) | | |

Deploy gate: nothing goes to Preprod until every step passes on the local
devnet **and** Joi confirms kenya is fully synced.

## Goal: Nov 30 Buildathon, Wave 3

Run the PollPower contract stack on **Midnight Preprod (ledger 9)** against
kenya's self-hosted stack:

- Multisig v6.2 (H-3 hardening; Tangem admin swap done manually by Garrett)
- TariffRegistry monolith (ceremony-fenced deploy + vk-insert rollout)
- EBT v8 (ceremony-fenced deploy + vk-insert rollout)
- New Living Dividend: user-initiated claims via a ledger 9 cross-contract
  call; unshielded; no re-entry into the caller

Community Poll comes after Nov 30. Deploys are manual ceremonies Garrett
green-lights; nothing in this branch deploys. **Rule (Garrett, 2026-11-24): no
contract goes to any public network, Preprod included, until WI16-C-1, C-2 and
H-1 are fixed.**

Infrastructure (kenya Cardano node, db-sync, midnight-node 2.1.101, indexer
4.4.101, proof server 9.0.2) is **Joi's**; status lives in
`docs/infra-status.md`, target Thursday evening. The tooling reads every
endpoint from environment variables (`.env.example`), ready for kenya's
Tailscale addresses.

## Blocking: authorization (docs/findings-status.md)

| ID | Severity | Summary | State |
|---|---|---|---|
| WI16-C-1 | Critical | Every signature/council check in all four contracts is a prover-supplied witness | Confirmed (runtime PoC on Multisig v6.2; source elsewhere). **Fix designed, awaiting approval** |
| WI16-C-2 | Critical | EBT v8 owner gate uses `ownPublicKey()` | Confirmed by source. **Fix designed** |
| WI16-H-1 | High | EBT v8 and Multisig v6.2 `initialize` front-runnable | Confirmed by source. **Fix designed** |
| LD-H-3 | High | v2.2.2's keeper gate is itself a C-1 witness | Removed structurally in the LD v3 design |

Designs: [`design/WI16-auth-fix-design.md`](design/WI16-auth-fix-design.md),
[`design/living-dividend-v3-design.md`](design/living-dividend-v3-design.md).
Estimate: **12–15 dev-days** for the four contracts with tests and a devnet
end-to-end run, so the full set does not fit before Nov 30 (schedule options
in the design).

## Results

### Toolchain and contracts

| Contract | Compact 0.36.1 `--skip-zk` | Full ZK | Commit |
|---|---|---|---|
| EBT v8 (18 circuits) | ✅ pragma pinned to 0.28 only change | ✅ kenya 6 m 16 s, 2.4 GB peak | `c4a5240` |
| EBT v8 ceremony (8) | ✅ | ✅ kenya 4 m 01 s | `c4a5240` |
| Multisig v6.2 (12) | ✅ | not run | `b7dfc89` |
| TariffRegistry v1 + ceremony (18 + 18) | ✅ | not run | `b7dfc89` |

EBT v8 deploy pricing (ledger 9 cost model): full deploy 84% of the
50,000-byte `bytes_written` block limit (too big for one transaction, which
gets ~60–65%); ceremony deploy 36% (fits); each vk insert 4.5%. The ceremony
build's 8 verifier keys are byte-identical to the full build's. Mirror
circuits carry ~344 MiB proving keys each.

### Phase 3: tooling on the ledger 9 package set (`b31e164`)

- **Packages:** npm workspaces at the repo root (`tariff-registry`,
  `ebt/settle-flow`); Midnight.js 5.0.1, compact-js 3.0.2, compact-runtime
  0.21.0, platform-js 3.0.0, ledger-v9 1.0.2, onchain-runtime-v4 4.0.2, wallet
  SDK 2.0.1. One copy of each WASM protocol package
  (`npm run check:single-copies`).
- **Endpoints:** `tooling/midnight-network.mjs` reads
  `MIDNIGHT_NETWORK_ID`, `MIDNIGHT_INDEXER_URL`, `MIDNIGHT_NODE_URL` (+ optional
  WS, proof server, TTL). No hardcoded endpoint, no Preview fallback.
  Contract addresses, build directories, key paths and the private-state
  password are environment variables too.
- **Providers:** `tooling/midnight-providers.mjs` (wallet SDK 2 from seeds,
  Midnight.js 5 ledger 9 wallet/midnight providers, `config`), type-checked
  against the installed typings. TariffRegistry `deploy-utils` and the
  settle-flow scripts use it.
- **Runtime rename:** `convertFieldToBytes` → `convertBigintToBytes` in
  compact-runtime 0.21; fixed in `ceremony.mjs` and the multisig action-hash
  tooling.
- **Tests:** `npm test`: mirror suites **133/133**, parity **3/3**,
  `npm run typecheck` clean.
- **Parity tests** run the compiled 0.36.1 contracts offline and compare their
  hashes with the TypeScript side: TariffRegistry action-log root and zero
  levels, EBT attestation key, EBT `settle` HAT payload. They found
  **WI16-T-1**: the JS mirror encoded integers big-endian while the circuit
  is little-endian, so mirror tests on integer fields had only checked
  themselves. Mirror fixed; the live ceremony tooling was already correct.
- **Not ported yet** (they change with the C-1/C-2/H-1 fixes): circuit call
  sites and witnesses inside the ceremony scripts. The V2-split tooling is
  superseded and excluded from the typecheck.

### Fix-design spike (throwaway, scratchpad)

Compiled under 0.36.1: stdlib `jubjubSchnorrVerify` (HAT: 2.1 MB proving key,
1,593 B verifier key), stdlib `secp256k1EcdsaVerify` (council/Tangem: 117 MB,
2,745 B), hash-preimage identity (11.3 MB, 2,121 B), cross-contract
`isApproved` (0.2 MB), `kernel.caller()`-gated mint (0.4 MB), and an LD → EBT
claim with a view call and a minting call. No fix grows a verifier key past
2,745 B, so the ceremony-fence plan holds.

### Environment notes

- throne's WSL VM could not start (`ERROR_NO_SYSTEM_RESOURCES`; 7.9 GB free of
  32 GB). `npm run build:contracts` needs it on Windows. A `memory=8GB` cap in
  `%UserProfile%\.wslconfig` would fix it; not changed without asking. The
  last spike compiled on kenya instead.
- No GitHub token is stored in WSL (it was passed to one process and cleared).

## Open decisions

1. **Approve the C-1/C-2/H-1 fix design**, including Schnorr (recommended)
   or hash-preimage identity for the owner (C-2).
2. **Can the Tangem rings sign secp256k1?** Decides whether council keys stay
   on hardware (C-1a).
3. **Schedule:** option A (fix everything, Buildathon demo on a local devnet,
   Preprod after) or B (Multisig + EBT + TariffRegistry fixed by Nov 30, LD v3
   after). Recommendation: A.
4. **LD v3:** zero-member dividend handling, events vs log maps, payout
   address changes (recommendations in the design).
5. **`meter-authority-service` signer change** (Ed25519 → Jubjub Schnorr) is
   cross-app; it needs an owner and a slot.
6. **throne WSL memory cap** (`.wslconfig`), or keep compiling on kenya.
