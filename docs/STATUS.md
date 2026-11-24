# WI-16 ledger 9 status

Branch `wi16-ledger9`. Updated at the end of each task.
Last update: 2026-11-24 (late JST), consumer app LD v3 member actions done (signing + service). Next: step 4, devnet scripts + LD v3 relayer + settle submit.

## Current state (2026-11-24, evening JST)

**Done on `wi16-ledger9`:** H-1, C-2, C-1 council (Multisig v8, EBT, TR),
C-1c machine signers (EBT, TR), **LD v3** with its EBT side, and the new
settle-path fixes WI16-E-1..3. Tests: contract + parity 123/123 (0 skipped),
mirror 133/133, typecheck clean. Nothing deployed anywhere public.

**Environment:** throne rebooted; WSL starts with `memory=8GB` and compiles
locally again (EBT full ZK build: 7 min on throne). Tailscale healthy. SSH
tunnel to kenya's devnet open (19944 / 18088 / 16300; node, indexer and proof
server answer). Nothing else running.

Off-chain, not in the repo: `C:\Users\Garrett\PollPower-council\` (council keys: Garrett's ring verified; Jonathan / Timothy / Yume pending).

**Decisions (Garrett, 2026-11-24, after LD v3):** 72 h payout-change delay
approved. HAT signing: option 3, meter-authority-service countersigns the
chip's Ed25519 signature now; chip signs directly after Preprod (tracked:
`docs/design/hat-chip-signing-followup.md`). The Low finding (TR retire at
epoch 0) is fixed before any Preprod deploy: scheduled with the devnet script
work (step 4), since the deploy scripts touch TariffRegistry anyway.

**Order of work from here:**
1. ~~meter-authority-service~~ done: `POST /hat/v9` on branch `wi16-hat-v9`
   (`18f4dcb`), not deployed (Joi deploys). Contract side `84a748f`.
2. ~~Settlement client~~ done: `pp-settle-service` branch `wi16-hat-v9`
   (`54e3d66`), not deployed. Counter, chip signs `chipDigest`, `/hat/v9`
   countersign, digest cross-check; the on-chain `submit` is wired in step 4.
   **Legacy mint path retired** (Garrett: all mints via metered settles,
   corrections via council-approved `manualReissue`): `pollpower-v2-api`
   branch `wi16-retire-mint-path` (`1774a26`, from the deployed `49b0ac2`),
   disabled behind `LEGACY_SETTLEMENT_MINT_ENABLED` (default off), not
   deleted. Inventory: `pollpower-v2-api/docs/legacy-settlement-mint-retirement.md`.
   **Gaps to decide/schedule:** (A) nothing connects a consumer outlet
   purchase to a pp-settle-service metered settle (is the outlet meter the HAT
   chip?); (B) pp-settle-service needs to persist a countersigned settle and
   retry the submit (step 4); (C) EBT `manualReissue` is owner + meter-authority
   co-signed, **not council-gated**: needs a contract change plus owner/co-sign
   tooling. pp-settle-service stays undeployed until step 4.
   **HAT firmware:** `PollPower/gateway-execution` (`firmware/pp_attest.c`,
   `pp_gwattest.c`, `pp_keystore.c`). The chip has a native attestation that
   signs its own metered energy; production uses `SIGN_HASH` (host picks the
   amount). Interim hardening proposed in the follow-up doc.
3. ~~Consumer app LD v3 member actions~~ done (screens pending the backend):
   wallet shim 0.3.0 (`pollpower-monorepo` `c71d06c`: Jubjub member key
   derived from the mnemonic, `ldMemberIdentity`, `signLdMemberAction` that
   builds the message itself; 4 vector tests vs the compiled LD v3) and
   `consumer-standalone` branch `wi16-ld-v3` (`ecca925`: `ldV3Service`,
   `useLdV3Member`, API client for `GET /api/ld/v3/member` and
   `POST /api/ld/v3/action`; 7 tests, 5 negative). **Needs in step 4:** the
   LD v3 relayer endpoints in pollpower-v2-api, a device check that the
   shim's new WASM initialises in the WebView, and the screens.
4. **Devnet scripts:** ceremony / HAT / retune / deploy (they refuse to run
   now); `tests/contract/settle-world.mjs` is the reference. Plus the TR
   retire-at-epoch-0 fix, pp-settle-service `submit` + retry (gap B), and the
   LD v3 relayer (`/api/ld/v3/member`, `/api/ld/v3/action`).
5. **Full devnet run**: confirm a mint inside a cross-contract call, two calls
   to EBT in one transaction, the indexer returning LD's `Misc` events (and
   EBT's `settleChip`); re-measure deploy sizes.
6. **Recorded demo** (Mon 30).

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
| Wed 25 | **C-2** (EBT owner Schnorr) + Schnorr signer lib + parity · **Tangem ring verified on devnet** | **C-2 done early (Tue 24)** `d170a9f`: 13 contract tests (11 negative) green; owner = Jubjub key, in-circuit `jubjubSchnorrVerify` over (contract, circuit, args digest, nonce); signer uses the contract's exported pure helpers. Devnet path for the ring proven with a software key, low-S and high-S both verified on chain (`61cf805`). **Tangem ring verified (Tue 24):** real ring secp256k1 signature (compressed 33-byte key, raw 64-byte r‖s, low-S) accepted by `@noble/curves`, the compiled circuit and **on chain with a real proof** (devnet block 627); wrong digest rejected. Council keys stay on the rings | C-2 ✅ · Tangem ✅ |
| Thu 26 | **C-1 council**: Multisig secp256k1 `approve` + `isApproved`; EBT/TR/LD `requireCouncil` + replay records | **Started early (Tue 24).** Multisig v8 done `6e818e3`: in-circuit `secp256k1EcdsaVerify`, no witnesses; approvals per (action, slot) under a council epoch; constructor for ≤7 slots with H-3 bounds and duplicate-key rejection. 14 tests (10 negative) green, incl. the PoC replayed against v6.2 (control: still vulnerable) and v8 (rejected). Council rotation designed (72 h delay) as a **Preprod gate**. **C-1b done (Tue 24):** EBT `1f9cf27` (10 tests, 8 negative) and TariffRegistry `de37277` (8 tests, 6 negative) check approval through a ledger 9 cross-contract call to `isApproved` on a real Multisig v8 (verifier keys checked), with their own replay records; council witnesses, EBT op 3 and TR `setFederationAuthority` removed (council rotates in place). LD gets the same with LD v3. Council 2-of-3 + standby procedure documented `14b3fde` | C-1 council ✅ (LD with LD v3) |
| Fri 27 | **C-1 machine signers**: HAT, escrow attestor, schedule operators → Jubjub Schnorr; meter-authority-service signer | **Done early (Tue 24)**: EBT `1e90910` (18 tests, 12 negative) and TariffRegistry `a95e48b` (11 tests, 7 negative). No `signature_valid` witness left; HAT, reissue co-signature, escrow attestation, schedule validator and operators are Jubjub keys verified in-circuit over exported pure-circuit messages bound to the contract address. Found and fixed on the way: **TR `registerSchedule` front-run** (approval did not bind operator key or reference rate; validator key was a free argument) and the reissue co-signature not binding the recipient. PoC shown on the old builds. **Open (cross-app):** `meter-authority-service` signer change, notified to Joi; in-repo Ed25519 settle-flow scripts refuse to run until the devnet rewrite | C-1c ✅ (service signer ⏳) |
| Sat 28 | **LD v3** + EBT `dividendAccrued` / `mintDividend` callee | **Done early (Tue 24, after the reboot):** EBT side `b236ea4` (12 tests, 8 negative), LD v3 `dcd9632` (20 tests, 11 negative). Members claim themselves; EBT mints to the payout address from an on-chain budget it cannot overdraw; LD bound once. Garrett's (a)/(b)/(c) built in; payout-change delay proposed at **72 h**. A full in-memory settle for these tests exposed **WI16-E-1** (High: settle split not bound to the class, dividend could be zeroed), **WI16-E-2** (High: registry mirror rollback) and **WI16-E-3** (Medium: proof sequence unbound); all shown on the old build and fixed. Harness gap fixed on the way: callee state is now written back after cross-contract calls (the budget test caught it) | LD v3 ✅ |
| (new) | **meter-authority-service + settlement client** → Jubjub Schnorr (Garrett 2026-11-24: owned here, Joi deploys to kenya) · rewrite ceremony / HAT / retune / deploy scripts | **Started early (Tue 24).** The production HAT chip signs Ed25519 on chip, which the circuit cannot verify; Garrett chose option 3. **meter-authority-service done** (`wi16-hat-v9` `18f4dcb`): `/hat/v9` verifies the chip signature against the allowlist, applies the sanity rules and countersigns in Jubjub; 14 tests (10 negative), vectors from the compiled contract; runtime 0.15 → 0.21 (fixed the legacy `/attest` rename on the way). **Contract** `84a748f`: `chipDigest` + `hatMessage` bind the chip key/signature; `settleChip` audit event; 2 new tests. **pp-settle-service** (`wi16-hat-v9` `54e3d66`): v9 flow with a persisted per-chip counter and `/hat/v9` client, 36 tests green; on-chain submit left for step 4 (throws until then). Found: `settlement-api`'s settle (v2-api mint worker) has no HAT and cannot mint on v9 (decision for Garrett) | service ✅ · client ✅ (submit in step 4) |
| Sun 29 | **Full local-devnet run** of the whole stack (fenced deploys, settle, claim), deploy sizes re-measured | | |
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
| WI16-C-1 | Critical | Every signature/council check in all four contracts is a prover-supplied witness | Confirmed (runtime PoC). **Council part fixed** (Multisig v8 in-circuit secp256k1; EBT + TR via cross-contract `isApproved`). **Machine signers fixed** (C-1c: EBT HAT, reissue co-sign, escrow attestor; TR validator, operators; in-circuit Jubjub Schnorr). **LD fixed** by LD v3 (member Schnorr, council `isApproved`, no witnesses but the checked divider). |
| WI16-C-2 | Critical | EBT v8 owner gate uses `ownPublicKey()` | **Fixed** `d170a9f` (owner Jubjub Schnorr, in-circuit) |
| WI16-H-1 | High | EBT v8 and Multisig v6.2 `initialize` front-runnable | **Fixed** `9a1d7c0` (constructor sets every authority; Multisig v8 likewise) |
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

**After H-1 + C-2 (`d170a9f`, full ZK on kenya, Tue 24):** EBT v8 17 proved
circuits (+7 pure helpers, no keys), ceremony 7. Owner-gated verifier keys
grew 2,121 → 2,313 B (in-circuit Schnorr); prover keys ~24 MB each. Full
deploy 85.3% of the block (still needs the fence), **ceremony deploy 35.6%
(fits in one tx)**, each vk insert 4.9%. The fence plan holds.

**After C-1 council (full ZK on kenya, 30 min, Tue 24):** every staged deploy fits.

| Contract | Full deploy | Staged (ceremony) deploy | Each vk insert |
|---|---|---|---|
| Multisig v8 (5 keys) | **22.8%, fits in one tx** | not needed | 5.7% |
| EBT v8 (17 keys) | 85.3% (fence needed, unchanged) | **35.6%, fits** | 4.9% |
| TariffRegistry v1 (17 keys; first full build) | 78.8% (fence needed) | **31.7%, fits** | 4.5% |

The cross-contract call left EBT's sizes unchanged (`execMultisigOp` verifier key 2,121 B).

Before WI-16 fixes: EBT v8 deploy pricing (ledger 9 cost model): full deploy 84% of the
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

- throne's WSL VM does not start (`ERROR_NO_SYSTEM_RESOURCES`), at **any**
  size: tried `memory=4GB` (Garrett, 2026-11-24) and 2 GB, same error, with
  ~11 GB RAM free. Not a size problem: 47 GB of 56 GB commit is in use, about
  17 GB of it not attributable to any process, and kernel pools are ~4 GB
  after 23 days up, so most likely leaked memory. Needs a reboot (or an admin
  `Restart-Service vmcompute`). `.wslconfig` is now `memory=4GB` (backup
  `.wslconfig.bak-8gb`). Builds run on kenya (`COMPACT_REMOTE=kenya`).
- **Full ZK build memory, measured on kenya** (`/usr/bin/time -v`,
  TariffRegistry v1, the largest): peak **5.0 GB** in one process, 9 min,
  3.5 GB of keys written. **4 GB is not enough for full builds**; 6 GB is the
  minimum, 8 GB recommended. Skip-zk builds fit easily in 4 GB.
- No GitHub token is stored in WSL (it was passed to one process and cleared).

## Open decisions

1. **Approve the C-1/C-2/H-1 fix design**, including Schnorr (recommended)
   or hash-preimage identity for the owner (C-2).
2. ~~Can the Tangem rings sign secp256k1?~~ **Yes** (devnet-verified 2026-11-24). Council keys stay
   on hardware (C-1a).
3. **Schedule:** option A (fix everything, Buildathon demo on a local devnet,
   Preprod after) or B (Multisig + EBT + TariffRegistry fixed by Nov 30, LD v3
   after). Recommendation: A.
4. **LD v3:** zero-member dividend handling, events vs log maps, payout
   address changes (recommendations in the design).
5. **`meter-authority-service` signer change** (Ed25519 → Jubjub Schnorr) is
   cross-app; it needs an owner and a slot. Message layouts are in the design
   doc (C-1c); Joi notified 2026-11-24.
6. **throne WSL:** needs a reboot to start at all; then `memory=8GB` (or 6 GB
   minimum) for full ZK builds, 4 GB only for skip-zk.

## Follow-ups after the Preprod redeploy

- **Admin app** (monorepo `pollpower-v2/apps/admin`): `app.json` still points at
  the Preview indexer, `network: "preview"` and the dead multisig v5/v6
  addresses; `services/adminAuth.ts` defaults to `'preview'`. Switch to Preprod
  and the new addresses after the redeploy, together with the C-1a signing
  change (secp256k1 approvals replace the `PollPowerMultiSig.v5` Ed25519
  action hashes in `services/actionHash.ts`).

## Known gaps after C-1 council (tracked)

- **Deploy sizes after LD v3:** EBT full deploy is now 19 verifier keys,
  95.0% of a block (was 85.3%); it already goes out staged, one key per 4.9%
  transaction, so the plan is unchanged. The EBT ceremony variant and LD v3
  are not priced yet (need full ZK builds); do it with the devnet build. The
  pricing script lives in the session scratchpad; move it into `tooling/`
  before the devnet run.
- **TR retire at epoch 0** (Low, open): `retiredEpoch = 0` reads as live.
  Fix before any Preprod deploy; scheduled with the devnet scripts (step 4).
- **HAT trust model:** until the chip signs a curve the circuit verifies,
  the on-chain proof vouches for meter-authority-service, not the chip.
  Follow-up after Preprod: `docs/design/hat-chip-signing-followup.md`
  (needs the HAT firmware source location from Garrett).
- **Consumer app** must sign LD v3 member actions (Jubjub Schnorr over
  `memberMessage`) before members can claim on the devnet/demo; not started.
- **JS mirror** (`ebt/tests/lib.mjs`, `ebt/tests/vnext/T20…`) still models
  the old witness-based council checks; the contract tests are the reference
  for this path now. Mirror to be updated or retired for it.
- **Off-chain tooling** still on the old interfaces: `ebt/settle-flow/ceremony.mjs`,
  `retune.mjs`, `relay-hat-sign.mjs` (Ed25519), the EBT and TR ceremony deploy
  scripts. All refuse to run; rewritten for the Sunday devnet run with
  Jubjub signers (`tests/contract/machine-signer.mjs` is the reference).
- **Deploy pricing** not re-measured after C-1c (needs full ZK builds of EBT
  and TR, ~30 min on kenya). TR gained one circuit (`setValidator`, +1 vk
  insert, ~4.5% of a block); staged deploys had ~25% headroom. Re-measure
  with the devnet build.
- **TariffRegistry action hashes**: `registerSchedule`, `retuneClass` and
  `setValidator` now have exported pure helpers (C-1c); the other federation
  ops (`retireSchedule`, `advanceEpoch`, `setNationalContext`, lanes) are
  still computed inside each circuit. Add with the admin-app switch.
