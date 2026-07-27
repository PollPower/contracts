# WI-14 Ceremony Skeleton — EBT v8 Preview Deploy (T+0)

## 1. Purpose

This document is the T+0 deploy ceremony plan for EBT v8 on Midnight Preview mainnet, aligned to the vNext sunset schedule in `ebt/VNEXT-DESIGN.md` section 9.2 (T+0 through T+180) and focused on the deploy-day sequence only. It is not the long-horizon migration/caller runbook (see `ebt/VNEXT-MIGRATION.md`, PR #40) and not the contract design authority (see `ebt/VNEXT-DESIGN.md`, especially sections 7 and 9).

## 2. Keyholders

| Role | Key material | Custody today | Custody at ceremony |
|---|---|---|---|
| Contract owner (for `execOwnerOp` / owner-gated circuits such as `initialize` and `mirrorActionLogRoot`) | Owner signing key (production control path is under multisig governance per WI-14 review notes) | Garrett (via Multisig v6 PROD `f7192a50...c3fa` co-sign, current admin set = 1 real ring + 4 pilot-mocks; see H-1 note below and §9 CAL-1) | Present, identity-checked, signs owner operations live at T+0 AND signs weekly owner-advance ceremonies (see §12) throughout the v8 lifetime until WI-14.1 lands |
| Multisig quorum members (for `execMultisigOp`) | Multisig admin Ed25519 keys (3-of-5) | Pilot ring set currently active (see H-1 note below) | 3-of-5 online and able to co-sign required governance actions at T+0 AND for the weekly owner-advance ceremony (§12) throughout v8 lifetime |
| Meter authority | Meter Authority signer pubkey for `_meterAuthorityPubkey` | Live relay meter-authority service key (`GET /metadata`) | Same key installed at `initialize()` unless rotated in a prior approved ceremony |
| Escrow attestor | Escrow attestor pubkey for `_escrowAttestorPubkey` (redeem solvency guard) | `[GARRETT-DECIDED]` (specific escrow attestor pubkey to be locked in the T+0 pre-flight signed input manifest — see §4 step 4 and §3 prerequisite 10) | Pubkey supplied at `initialize()` and attestor reachable for post-cutover checks |
| Deploy operator | Deployer key + deployment workstation/session on Kenya | Garrett's existing PollPower deployer wallet on Kenya (same wallet used for EBT v5+ deploys per `~/mn-dev/settlement-work/deployment.json`) | Runs deploy transaction and records tx hash/address |
| Mirror-write daemon operator | Daemon runtime key(s) and service credentials for mirror transactions | Daemon implementation landed at `PollPower/settlement-api:feat/wi14-mirror-daemon` (four commits, 14 source files + 3 test files); operator = Garrett with Joi/BIG supervising session; PR pending TariffRegistry Preview deploy for C.1/C.2/C.5/C.8 hash-vector verification | Must own a tested deployable daemon before ceremony starts AND own the pre-flight witness-bundle-generation procedure for each weekly owner-advance ceremony (§12 step 1) |
| Settlement-api operator | Kenya service access (pm2 + config secrets) | Existing operator for `settlement-api` | Flips contract target to v8 and validates first settle |
| Ceremony observer / recorder | No signing key (audit witness role) | Joi/BIG supervising session (workspace webchat, session-key `agent:solar-scout:main`) — records minute-by-minute in daily memory + mempalace | Maintains minute-by-minute record and captures attestation artifacts |

**H-1 key posture flag (mandatory) — RESOLVED 2026-07-27 by Garrett (CAL-1, §9):** the ceremony proceeds with the current pilot-posture admin set (1 real Tangem ring + 4 pilot-mock keys) on Multisig v6 PROD. Tangem ring activations continue in parallel; mock-key access is retained during transition to exercise rotate-seat functions with a known-good quorum. H-1 fully closes only when all 5 admins are real rings; H-1 remains a hard-gate blocker for mainnet Phase 2 (tracked as WI-14.2). See §9 CAL-1 for the full decision + rationale.

## 3. Prerequisites (checkable at ceremony start)

1. PR #39 (EBT v8) is merged to `main` at a specific commit SHA.  
   Check: `gh pr view 39 --repo PollPower/contracts --json state,mergeCommit,mergedAt`
2. v8 compiled full-ZK on Kenya, with prover/verifier key material generated, signed, and fingerprinted in ceremony artifacts.
3. `ebt/VNEXT-MIGRATION.md` (PR #40) is merged to `main`.  
   Check: `gh pr view 40 --repo PollPower/contracts --json state,mergeCommit,mergedAt`
4. WI-13.1 + WI-13.2 are already deployed and TariffRegistry on Preview has live schedule/lane data.
5. Mirror-write daemon code exists, is tested, and is deployable for T+0.  
   **Critical:** current `contracts` repo tree contains no v8 mirror-writer implementation; PR #40 section 5.3 also flags this gap.
6. Contract owner + multisig quorum are physically/logically available for the ceremony window (no asynchronous "sign later" assumption).
7. Deploy operator has Kenya environment ready (network sync, DUST, build artifacts, exact commit checkout).
8. Bootstrap value for `_registryActionLogRootMirror` is precomputed from live TariffRegistry state using the section 5 method, with witness package prepared (`sampleEntry + proof`). Witness-generation script provenance: `settlement-api/scripts/generate-owner-advance-bundle.ts` reusing daemon's own `merkle.ts` + `hashing.ts` (per §9 CAL-6).
9. **Weekly owner-advance ceremony procedure signed off and tested end-to-end** (see §12). Weekly cadence + alert-triggered supersession confirmed by Garrett + supervising session 2026-07-18. Operator = Garrett (sole); escalation path locked per §9 CAL-7. Multisig keyholder availability commitment for the weekly cadence is signed off in writing under the current pilot-posture admin set (1 real ring + 4 pilot-mocks, all held by Garrett; see §9 CAL-1).
10. `initialize()` input set is signed off in writing: meter authority pubkey, escrow attestor pubkey, multisig authority hash, recipient addresses, and any other constructor/init inputs.  
   **Recipient addresses (RESOLVED 2026-07-27, §9 CAL-4):** reuse the existing v7.4.2 pilot producer wallet set — `con-000`, `con-001`, `con-002`, `prod-000`, `prod-001`. Exact bech32m addresses to be captured in the T+0 pre-flight signed input manifest from the current v7.4.2 producer registry on relay.
11. **WI-13.3 shard bootstrap sequence** (added post-#44 merge, 2026-07-27): TariffRegistry deploys with `_bootstrapComplete = false`. Between deploy and the `initialize()` step, the deploy operator MUST call `bootstrapActionLog(8n)`, then `bootstrapActionLog(16n)`, then `bootstrapActionLog(24n)` in three sequential transactions. The terminal shard commits the depth-24 empty root, sets `_actionLogBaseSeq = _actionSeq`, and sets `_bootstrapComplete = true`. Any branch op (register/retire/retune) called before the terminal shard reverts with `TariffRegistry: bootstrap incomplete`. See `tariff-registry/V1.3-DESIGN.md` §5 for keeper sequence detail.

## 4. Ceremony steps (ordered list)

**Note (added 2026-07-27):** step 2 below deploys TariffRegistry. Under WI-13.3 (merged 2026-07-27 as PR #44 commit `feaeccc`), TariffRegistry deploys with `_bootstrapComplete = false` and requires three post-deploy `bootstrapActionLog(shardEnd)` calls (8 → 16 → 24) BEFORE any branch op or before the v8 ceremony proceeds past step 4. These three shard calls are treated as extension of step 2 (deploy operator role) and MUST complete before step 3's contract-address broadcast is treated as ceremony-ready. See prerequisite 11 and `tariff-registry/V1.3-DESIGN.md` for detail.

1. **Step 1: Pre-flight identity + custody confirmation**
   - **Who:** Ceremony observer + all roles from section 2.
   - **Command / action:** In ceremony room, each signer proves control by signing the pre-flight nonce in their wallet (`sign nonce "<ceremony-id>:preflight"`).
   - **Expected output:** Signed nonce bundle for every required signer; Kenya build environment checks green.
   - **Verify:** Observer checks signatures map to expected pubkeys and records timestamp.
   - **If failed:** Abort ceremony; reschedule with full quorum.

2. **Step 2: Deploy operator submits v8 deploy transaction to Preview**
   - **Who:** Deploy operator.
   - **Command / action:** `npx tsx "[GARRETT-DECIDED]/deploy-ebt-v8.ts"`
   - **Expected output:** Deploy tx accepted; pending tx hash emitted.
   - **Verify:** Observer and owner independently confirm tx hash appears on Preview indexer.
   - **If failed:** Retry deploy after correcting immediate error (see section 6).

3. **Step 3: Capture deploy receipt and broadcast contract address**
   - **Who:** Deploy operator.
   - **Command / action:** Record deploy receipt payload (`contractAddress`, `txHash`, `blockHeight`) into ceremony log and broadcast in keyholder channel.
   - **Expected output:** One canonical v8 contract address acknowledged by all keyholders.
   - **Verify:** Multisig quorum confirms same address byte-for-byte.
   - **If failed:** Freeze ceremony; do not proceed until receipt disagreement is resolved.

4. **Step 4: Owner initializes v8 with signed input set**
   - **Who:** Contract owner (+ multisig quorum where owner-control policy requires co-sign).
   - **Command / action:** Submit `initialize(...)` using signed input manifest: `_meterAuthorityPubkey`, multisig authority hash, recipient addresses (per §9 CAL-4: v7.4.2 pilot producer wallets `con-000`, `con-001`, `con-002`, `prod-000`, `prod-001`, bech32m captured pre-flight), `_escrowAttestorPubkey`.
   - **Expected output:** `initialize()` succeeds once; `_initialized == true`.
   - **Verify:** Observer reads back `_initialized` and each configured field.
   - **If failed:** Treat as one-shot initialization failure and redeploy (section 6).

5. **Step 5: Compute bootstrap value for `_registryActionLogRootMirror`**
   - **Who:** Mirror-write daemon operator.
   - **Command / action:** Execute bootstrap procedure in section 5 to derive current TariffRegistry root and witness package from live state.
   - **Expected output:** Candidate `newRoot`, `sampleEntry`, `proof` bundle with reproducible checksum.
   - **Verify:** Owner + observer independently recompute/check the bundle against same chain tip.
   - **If failed:** Stop before owner call; regenerate witness package.

6. **Step 6: Owner installs bootstrap root via `mirrorActionLogRoot`**
   - **Who:** Contract owner.
   - **Command / action:** Submit `mirrorActionLogRoot(newRoot=<bootstrap>, sampleEntry, proof)`.
   - **Expected output:** Transaction succeeds; `_registryActionLogRootMirror` equals bootstrap root.
   - **Verify:** Observer reads `_registryActionLogRootMirror` and compares to TariffRegistry `registryActionLogRoot`.
   - **If failed:** Correct witness/root and retry owner call (section 5 + section 6).

7. **Step 7: Start mirror-write daemon and establish freshness anchor**
   - **Who:** Mirror-write daemon operator.
   - **Command / action:** `pm2 start ebt-v8-mirror-daemon --update-env` (or `pm2 restart` if already provisioned), then post first `mirrorActionLogHead`.
   - **Expected output:** Daemon healthy; first head update accepted.
   - **Verify:** Observer confirms at least one successful `mirrorActionLogHead` tx and advancing mirrored head value.
   - **If failed:** Restart daemon and recover from last durable cursor; do not proceed to settle cutover.

8. **Step 8: One-shot mirror backfill for existing lanes/schedules**
   - **Who:** Mirror-write daemon operator.
   - **Command / action:** Submit mirror writes for all current registry state (`mirrorRegisterLane`, `mirrorScheduleLifecycle`, `mirrorClassStatutoryTotal` for every applicable key).
   - **Expected output:** Backfill completes with zero missing required lanes/schedules.
   - **Verify:** Observer runs completeness checklist against TariffRegistry reads (`resolveLanes`/schedule live/class totals) versus v8 mirror reads.
   - **If failed:** Resume backfill from last confirmed item; mirror writes are idempotent-on-content.

9. **Step 9: Settlement-api cutover to v8**
   - **Who:** Settlement-api operator.
   - **Command / action:** Update v8 address/config and restart service: `pm2 restart settlement-api --update-env`.
   - **Expected output:** Service healthy and targeting v8.
   - **Verify:** Read `_meterAuthorityPubkey` from v8 through service diagnostics; confirm returned key matches initialize input.
   - **If failed:** Flip config back to v7.4.2 until mirror/backfill and service config are corrected.

10. **Step 10: Execute first end-to-end test settle**
    - **Who:** Settlement-api operator + ceremony observer.
    - **Command / action:** Run first canary settle exactly as defined in `VNEXT-MIGRATION.md` section 9 post-cutover checklist.
    - **Expected output:** Settle succeeds on v8 with expected state transitions and no stale-mirror failure.
    - **Verify:** Observer confirms tx success and checklist items in `VNEXT-MIGRATION.md` section 9.
    - **If failed:** Revert traffic to v7.4.2 and invoke rollback path (section 6).

11. **Step 11: Post-ceremony attestation**
    - **Who:** All signing keyholders + observer.
    - **Command / action:** Sign ceremony attestation document (hash of deployed address, tx hashes, bootstrap root, and verification outputs).
    - **Expected output:** Fully signed attestation artifact stored with deployment records.
    - **Verify:** Observer verifies signature set completeness and artifact integrity hash.
    - **If failed:** Ceremony is operationally complete but not administratively closed; gather missing signatures before declaring final close.

## 5. Bootstrap value for `_registryActionLogRootMirror`

This is the load-bearing step at T+0.

- **Target value at T+0:** the current live TariffRegistry `registryActionLogRoot` on Preview at the exact bootstrap block height.

- **How to compute (two candidate paths):**
  - **(a) Direct chain read (recommended):** read TariffRegistry ledger field `registryActionLogRoot` directly from Preview and use that value as `newRoot`.
  - **(b) Local replay (cross-check):** replay TariffRegistry action log from deploy to current head using the same append algorithm documented in `tariff-registry/tariff-registry-v1.compact` (`appendActionLogLeaf`, `ACTION_LOG_DEPTH`, node-hash shape) and reconstruct the root.

- **Recommendation:** Use (a) as source-of-truth root, with (b) as independent validation when tooling/time permits. This matches `VNEXT-DESIGN` section 7.1 posture: mirror writes must verify against the canonical root trust anchor, not operator opinion.

- **How to prove the root is right for `mirrorActionLogRoot`:**
  1. Select `sampleEntry` as the most recent TariffRegistry action event (`getActionEntry(headSeq)`).
  2. Build Merkle witness (`proof`) for `sampleEntry.payloadHash` under the candidate `newRoot` using TariffRegistry action-log structure.
  3. Submit `mirrorActionLogRoot(newRoot, sampleEntry, proof)`.
  4. Confirm v8 stores `newRoot` and subsequent mirror-write proofs verify.

- **Failure mode if wrong root is installed:** subsequent mirror writes fail witness reconstruction with `EVENT_PROOF_INVALID` because reconstructed roots do not match `_registryActionLogRootMirror`.

- **Recovery if wrong root installed:** owner re-runs `mirrorActionLogRoot` with the correct root + valid witness. Settle safety remains intact because settle re-checks mirror state each invocation; this is an availability failure, not a mint-auth bypass.

- **Documentation confidence note:** TariffRegistry root-computation algorithm is documented in source (`appendActionLogLeaf` and emitted-entry payload hash rules), so derivation is concrete. Remaining open risk is tooling/operator readiness to generate witnesses reliably at ceremony time (tracked in section 9).

## 6. Rollback paths

- **Deploy tx fails:** correct immediate deploy issue (nonce/funding/config) and retry deploy tx; no partial state should be assumed valid.
- **Initialize call fails:** treat as terminal for that deployment attempt because initialize is one-shot in v8 design posture; redeploy to a new contract address and restart from step 2.
- **Bootstrap root install fails:** do not proceed; regenerate witness/root package and retry `mirrorActionLogRoot` with corrected inputs.
- **Mirror backfill is partial:** restart daemon/backfill job from last confirmed cursor; mirror writes are idempotent-on-content.
- **Settlement-api points to v8 before mirror is ready:** settles revert due to missing/stale mirror state; immediately point settlement-api back to v7.4.2 until mirror backfill completes.

## 7. Post-ceremony state confirmation

Use this checklist plus `VNEXT-MIGRATION.md` section 9.

- `v8._initialized == true`.
- `initialize()` inputs read back exactly (meter authority pubkey, escrow attestor pubkey, authority hash, recipients).
- `_registryActionLogRootMirror` equals current TariffRegistry `registryActionLogRoot`.
- At least one mirror-write transaction (`mirrorActionLogHead` and one lane/schedule/class mirror write) succeeds after daemon start.
- First test settle succeeds end-to-end (per `VNEXT-MIGRATION.md` section 9).

## 8. Timeline estimate

Assuming no failures, expect roughly: deploy about 5 minutes, WI-13.3 shard sequence (three `bootstrapActionLog` calls) about 5-10 minutes total, initialize about 5 minutes including co-sign wait, bootstrap-root derivation/install about 5 minutes, mirror backfill variable at N minutes per currently-registered lane/schedule workload, settlement-api restart about 2 minutes, and first canary settle about 10 minutes. This is an order-of-magnitude planning estimate, not an SLA; keyholders should reserve a 2-3 hour ceremony window. T+0 target per §9 CAL-5: Sunday 2026-08-02, ~14:00 JST.

## 9. Open questions — RESOLVED 2026-07-27 (Garrett)

All pre-ceremony CAL sign-offs closed by Garrett + supervising session (Joi) on 2026-07-27 17:05 JST. The original open-question numbering is preserved below for audit continuity; each item now records its locked decision.

1. **CAL-1 — Pilot-mock keys vs H-1 remediation sequencing.**
   **RESOLVED:** Proceed with v8 Preview cutover using the CURRENT Multisig v6 PROD admin set (1 real Tangem ring `295be1f5...466f` + 4 pilot-mock keys derived from `sha256("pollpower-pilot-mock-ring-{0..3}")`). Continue Tangem ring activations in parallel with the pilot. Maintain mock-key access during transition so rotate-seat / add-remove-admin functions can be exercised with a known-good quorum. H-1 fully closes when all 5 admins are real rings. This ceremony plan therefore treats the admin set as pilot-posture; H-1 remains a hard-gate blocker for mainnet Phase 2, tracked as WI-14.2.
   **Rationale:** All signing sources (Garrett's ring + all 4 mock seeds) are held by Garrett. Threshold-3 is met multiple ways from a single custodian. The external-attacker risk (public mock seeds) is the H-1 gap that mainnet blocks on, not Preview.

2. **CAL-vNext-M1 — Mirror-stale tolerance.**
   **RESOLVED:** `32 events`. Alert threshold at 16 events (50% lag). Raise to `64` before mainnet Phase 2 once real event rate is observed. This is a config value, not on-chain — bumpable post-deploy without re-ceremony. Cadence remains weekly + alert-on-50%-lag as previously RESOLVED 2026-07-18.

3. **CAL-13.2-D — Action-log Merkle depth.**
   **RESOLVED:** `24`. 16.7M event lifetime capacity, negligible circuit cost, set-and-forget for v8 lifetime. Baked in at TariffRegistry deploy (WI-13.3 shard sequence terminates at depth 24).

4. **Mirror-write daemon delivery owner + readiness.**
   **RESOLVED:** Daemon implementation landed at `PollPower/settlement-api:feat/wi14-mirror-daemon` (14 source files + 3 test files across four commits `7be3980` → `80222f8` → `b95b145` → `cca56ba`). Operator: Garrett (with Joi/BIG supervising session support). Pre-T+0 readiness item: TariffRegistry Preview deploy must be executed so daemon's C.1/C.2/C.5/C.8 hash-vector verification tests can materialize their vectors against a live chain; daemon PR opens after that step.

5. **CAL-4 — `initialize()` recipient addresses.**
   **RESOLVED:** Reuse the existing v7.4.2 producer address set — 5 pilot producer wallets (`con-000`, `con-001`, `con-002`, `prod-000`, `prod-001`). Zero net change to app-side wallet routing.

6. **CAL-5 — Ceremony date/time (T+0).**
   **RESOLVED:** Sunday 2026-08-02, ~14:00 JST. Weekly owner-advance ceremony (§12) runs every Sunday at the same slot going forward, until superseded by trigger-on-alert (see §12.2).

7. **CAL-6 — Bootstrap witness tooling provenance.**
   **RESOLVED:** Reuse the mirror-daemon's own `src/mirror-daemon/merkle.ts` + `src/mirror-daemon/hashing.ts`. Add a standalone one-shot script `settlement-api/scripts/generate-owner-advance-bundle.ts` that imports the daemon's tree code and dumps `(newRoot, sampleEntry, proof)` at the current TariffRegistry tip. Same codepath as the daemon's own mirror-write witnesses = no cross-implementation drift. Sign-off flow: Garrett (owner, verifies `newRoot` against direct chain read of `registryActionLogRoot`) → daemon operator (produces the bundle) → observer (records checksum). Script to be added in a follow-up PR against `settlement-api`.

8. **CAL-7 — Weekly owner-advance ceremony operator + escalation.**
   **RESOLVED:** Garrett is the sole ceremony operator. Escalation path:
   - **Miss 1 week:** notification only; daemon continues serving reads on already-mirrored seqs; queue grows.
   - **Miss 2 weeks (queue at ~50% of CAL-vNext-M1 tolerance = 16 events):** urgent async multisig co-sign via Signal keyholder channel, 24-hour window. Ceremony is not deferred to the next weekly slot — it is treated as urgent.
   - **Miss 3 weeks (queue past tolerance, settles begin failing with `LANE_MIRROR_STALE`):** declare degraded service (pilot users notified via PollPower status surface or equivalent); run ceremony as soon as any 3 multisig members reachable, even outside normal cadence.
   - **Pilot-mock posture note:** while CAL-1 keeps the mock admins in the admin set, Garrett can co-sign as all 3 required seats himself in an emergency. This is the pilot-mock trade-off and is fine while H-1 remains open. Backup operator handoff is deferred to WI-14.2.

### Follow-up items unlocked by these decisions

- **Follow-up F-1:** Add `settlement-api/scripts/generate-owner-advance-bundle.ts` (per CAL-6). Not blocking T+0 but must exist before the first weekly owner-advance ceremony after T+0.
- **Follow-up F-2:** Add explicit README banner on `PollPower/contracts` marking v8 Preview as pilot-posture / not-for-mainnet-use pending H-1 (per CAL-1 + WI-14.2).
- **Follow-up F-3:** Update `ebt/VNEXT-DESIGN.md` §3.3 tolerance draft (4 events) to reflect CAL-vNext-M1 resolved value (32 events) once CAL-2 lands in prod.

## 12. Steady-state owner-advance ceremony (post-T+0, weekly)

This is the operational ceremony that keeps `_registryActionLogRootMirror` current with the on-chain `TariffRegistry.registryActionLogRoot` throughout the v8 lifetime, until WI-14.1 replaces the owner-advance model with a public-witness advance.

### 12.1 Purpose

The mirror-write circuits (`mirrorRegisterLane`, `mirrorRetireLane`, `mirrorScheduleLifecycle`, `mirrorClassStatutoryTotal`, `mirrorActionLogHead`) verify inclusion proofs against `_registryActionLogRootMirror`, NOT against the current on-chain `registryActionLogRoot`. See `ebt/ebt-v8.compact` L491-500 (`verifyEventProof` asserts `reconstructedRoot == _registryActionLogRootMirror`).

`_registryActionLogRootMirror` is updated only by `mirrorActionLogRoot`, which is `assertOnlyOwner()`-gated per `ebt/ebt-v8.compact` L742-770 (round-2 review-pass-2 fix, commit `9308a40`, 2026-07-18 00:20 JST). Verbatim trust-model comment:

> TRUST MODEL: owner is the sole trust anchor for root advances (round 2
> review-pass-2 fix). The witness (sampleEntry + proof) is
> defense-in-depth against typo'd/malformed root installs by the owner
> itself - it proves newRoot is internally consistent with a
> well-formed Merkle path from a leaf, but does NOT anchor newRoot to
> previously-trusted registry state. Full option-(iii) anchoring
> requires TariffRegistry to expose per-transition commitments
> (deferred to WI-14.1 pre-mainnet-Phase-2). In production the owner
> is under multisig control so this is effectively multisig-gated.

The registry rewrites `registryActionLogRoot` on every `emitAction` (`tariff-registry-v1.compact` L620). Between owner advances, the mirror-write daemon can only mirror events at seqs whose leaves are committed under the currently-mirrored root - see `VNEXT-MIGRATION.md` §5.3 for the operational-model explanation and daemon shape.

Behaviour confirmed by `ebt/tests/vnext/T19-mirror-root-witness.test.mjs`.

### 12.2 Cadence

- **Baseline: weekly** (confirmed by Garrett + supervising session 2026-07-18 17:50 JST; T+0 = Sunday 2026-08-02 ~14:00 JST per §9 CAL-5; weekly cadence runs every Sunday at the same slot going forward).
- **Trigger-on-alert supersedes calendar:** when the daemon's `queueLagEvents` metric reaches `>= 50% * CAL_MIRROR_STALE_TOLERANCE`, the ceremony must be triggered immediately, not deferred to the weekly slot. `CAL_MIRROR_STALE_TOLERANCE = 32 events` per §9 CAL-2 (alert threshold = 16 events = 50%).
- **Escalation if quorum unreachable in a given week (locked per §9 CAL-7):**
  - **Miss 1 week:** notification only; daemon continues serving reads on already-mirrored seqs; new-lane / retire / retune events queue.
  - **Miss 2 weeks (queue at ~50% tolerance = 16 events):** urgent async multisig co-sign via Signal keyholder channel, 24-hour window. Not deferred to next weekly slot — treated as urgent.
  - **Miss 3 weeks (queue past tolerance, settles begin failing with `LANE_MIRROR_STALE`):** declare degraded service; run ceremony as soon as any 3 multisig members reachable, even outside normal cadence.
  - **Pilot-mock posture note:** while CAL-1 keeps mock admins in the admin set, Garrett can co-sign as all 3 required seats himself in an emergency. Pilot-mock trade-off; fine while H-1 remains open. Backup operator handoff deferred to WI-14.2.
  - Operator responsibility to declare degraded service in the interim.

### 12.3 Keyholders required

Same set as T+0 ceremony (see §2):

- Contract owner (or multisig quorum acting as owner per production control path).
- Multisig quorum (3-of-5) for the co-sign.
- Mirror-write daemon operator (produces witness bundle).
- Ceremony observer (records minute-by-minute).

The meter authority, escrow attestor, deploy operator, and settlement-api operator roles from §2 are NOT required at each weekly ceremony (they were T+0 only).

### 12.4 Prerequisites (checkable at each weekly ceremony)

1. Mirror-write daemon healthy and reporting current `queueLagEvents`, `mirrorHeadSeq`, `registryHeadSeq`, and `mirroredRootSeq` metrics.
2. Owner (multisig quorum) available; identity-checked; hardware wallets / signing tooling operational.
3. Daemon operator has run the witness-bundle-generation script against the current registry state within the last 60 minutes and holds a valid candidate `(newRoot, sampleEntry, proof)` bundle.
4. Bundle checksum has been posted to the keyholder channel for out-of-band verification.

### 12.5 Ceremony steps (ordered list)

1. **Step 1: Daemon operator produces the witness bundle**
   - **Who:** Mirror-write daemon operator.
   - **Command / action:** run the witness-bundle-generation script against the current TariffRegistry state (same procedure as §5 of this document - the T+0 bootstrap-witness tooling, re-run at the current registry tip).
   - **Expected output:** `(newRoot, sampleEntry, proof)` bundle with reproducible checksum.
   - **Verify:** operator posts the bundle checksum to the keyholder channel; at least one other keyholder recomputes the checksum independently within 30 minutes.
   - **If failed:** regenerate; do NOT proceed until bundle is reproducible.

2. **Step 2: Multisig quorum verifies the bundle**
   - **Who:** Multisig quorum members (3-of-5).
   - **Command / action:** each participant independently reads the current on-chain `registryActionLogRoot` from TariffRegistry, and confirms `newRoot` matches.
   - **Expected output:** quorum agreement on the bundle validity.
   - **Verify:** observer records each participant's confirmation.
   - **If failed:** freeze ceremony; investigate discrepancy (indexer staleness, wrong contract address, bundle recompute bug).

3. **Step 3: Owner (multisig) submits `mirrorActionLogRoot`**
   - **Who:** Contract owner via multisig quorum co-sign path.
   - **Command / action:** submit `mirrorActionLogRoot(newRoot, sampleEntry, proof)` to v8.
   - **Expected output:** Transaction succeeds; `_registryActionLogRootMirror` equals `newRoot`.
   - **Verify:** observer reads `_registryActionLogRootMirror` from v8 and compares to `newRoot`.
   - **If failed:** correct witness/root and retry with new bundle; do NOT retry with the same bundle if the failure was a proof mismatch (indicates witness-generation drift).

4. **Step 4: Daemon detects advance and drains queue**
   - **Who:** Mirror-write daemon (automatic).
   - **Expected output:** `queueLagEvents` drops toward zero over the next N poll intervals as the daemon submits mirror-writes for previously-queued events.
   - **Verify:** observer + daemon operator confirm `queueLagEvents < 5%` of `CAL_MIRROR_STALE_TOLERANCE` within 10 minutes.
   - **If failed:** debug daemon; check daemon logs for `EVENT_PROOF_INVALID` reverts (indicates a hash-shape mismatch between daemon's local tree and the newly-installed root - halt daemon and reconcile).

5. **Step 5: Post-ceremony attestation**
   - **Who:** Multisig quorum + observer.
   - **Command / action:** sign a ceremony attestation document (hash of new root, submitting tx hash, participant list, queue-drain confirmation).
   - **Expected output:** signed attestation stored with weekly ceremony records.

### 12.6 Post-ceremony verification checklist

- [ ] `_registryActionLogRootMirror` equals current on-chain `registryActionLogRoot`.
- [ ] Daemon `queueLagEvents` returned to baseline.
- [ ] Latest settle canary succeeds (recommended: one canary settle against v8 within 60 minutes of ceremony completion).
- [ ] Signed attestation filed.

### 12.7 Rollback

- **Bundle rejected on-chain (proof invalid):** correct bundle generation and retry. Failed submission is a no-op; no state change. Daemon queue continues to grow until a successful advance.
- **Daemon halts after advance (root mismatch during drain):** debug daemon-side tree state; if local tree diverges from registry, halt daemon and reconstruct tree from a fresh replay of the registry `_actionLog`. No fund risk; this is availability only.
- **Quorum unreachable:** defer ceremony; declare degraded service; reschedule as soon as quorum available. If settles begin failing with `LANE_MIRROR_STALE` before ceremony recovers, that is expected degradation, not a fund-safety incident.

### 12.8 Sunset condition

This ceremony can be retired once WI-14.1 lands and v8 is upgraded (or forked) to expose a `mirrorActionLogRootPublic` circuit backed by per-transition commitments from TariffRegistry (option-(iii) trust anchor). Until then, weekly owner-advance is the operational reality.
