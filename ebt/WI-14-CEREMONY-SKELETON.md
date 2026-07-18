# WI-14 Ceremony Skeleton — EBT v8 Preview Deploy (T+0)

## 1. Purpose

This document is the T+0 deploy ceremony plan for EBT v8 on Midnight Preview mainnet, aligned to the vNext sunset schedule in `ebt/VNEXT-DESIGN.md` section 9.2 (T+0 through T+180) and focused on the deploy-day sequence only. It is not the long-horizon migration/caller runbook (see `ebt/VNEXT-MIGRATION.md`, PR #40) and not the contract design authority (see `ebt/VNEXT-DESIGN.md`, especially sections 7 and 9).

## 2. Keyholders

| Role | Key material | Custody today | Custody at ceremony |
|---|---|---|---|
| Contract owner (for `execOwnerOp` / owner-gated circuits such as `initialize` and `mirrorActionLogRoot`) | Owner signing key (production control path is under multisig governance per WI-14 review notes) | `[GARRETT-DECIDED]` | Present, identity-checked, signs owner operations live |
| Multisig quorum members (for `execMultisigOp`) | Multisig admin Ed25519 keys (3-of-5) | Pilot ring set currently active (see H-1 note below) | 3-of-5 online and able to co-sign required governance actions |
| Meter authority | Meter Authority signer pubkey for `_meterAuthorityPubkey` | Live relay meter-authority service key (`GET /metadata`) | Same key installed at `initialize()` unless rotated in a prior approved ceremony |
| Escrow attestor | Escrow attestor pubkey for `_escrowAttestorPubkey` (redeem solvency guard) | `[GARRETT-DECIDED]` | Pubkey supplied at `initialize()` and attestor reachable for post-cutover checks |
| Deploy operator | Deployer key + deployment workstation/session on Kenya | `[GARRETT-DECIDED]` | Runs deploy transaction and records tx hash/address |
| Mirror-write daemon operator | Daemon runtime key(s) and service credentials for mirror transactions | No productionized v8 mirror daemon path found in this repo; PR #40 flags this as a prerequisite gap | Must own a tested deployable daemon before ceremony starts |
| Settlement-api operator | Kenya service access (pm2 + config secrets) | Existing operator for `settlement-api` | Flips contract target to v8 and validates first settle |
| Ceremony observer / recorder | No signing key (audit witness role) | `[GARRETT-DECIDED]` | Maintains minute-by-minute record and captures attestation artifacts |

**H-1 key posture flag (mandatory):** `C:\Users\Garrett\.openclaw\workspace\MEMORY.md` still marks H-1 open (pilot-mock keys publicly derivable; Tangem ring swap ceremony pending). This ceremony plan does not decide whether v8 cutover runs with pilot-mock keys or only after H-1 remediation; this remains **[GARRETT + SUPERVISING SESSION]**.

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
8. Bootstrap value for `_registryActionLogRootMirror` is precomputed from live TariffRegistry state using the section 5 method, with witness package prepared (`sampleEntry + proof`).
9. `initialize()` input set is signed off in writing: meter authority pubkey, escrow attestor pubkey, multisig authority hash, recipient addresses, and any other constructor/init inputs.  
   Recipient addresses remain `[GARRETT-DECIDED]`.

## 4. Ceremony steps (ordered list)

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
   - **Command / action:** Submit `initialize(...)` using signed input manifest: `_meterAuthorityPubkey`, multisig authority hash, recipient addresses `[GARRETT-DECIDED]`, `_escrowAttestorPubkey`.
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

Assuming no failures, expect roughly: deploy about 5 minutes, initialize about 5 minutes including co-sign wait, bootstrap-root derivation/install about 5 minutes, mirror backfill variable at N minutes per currently-registered lane/schedule workload, settlement-api restart about 2 minutes, and first canary settle about 10 minutes. This is an order-of-magnitude planning estimate, not an SLA; keyholders should reserve a 2-3 hour ceremony window.

## 9. Open questions

1. **Pilot-mock keys vs H-1 remediation sequencing** — Does v8 cutover run before Tangem ring swap, or is H-1 remediation a hard gate first? **[GARRETT + SUPERVISING SESSION]**
2. **CAL-vNext-M1 final lock** — Final mirror-stale tolerance for production freshness checks. **[GARRETT + SUPERVISING SESSION]**
3. **CAL-13.2-D final lock** — Action-log Merkle depth is scaffolded as 24 in current registry source; production value unresolved. **[GARRETT + SUPERVISING SESSION]**
4. **Mirror-write daemon delivery owner + readiness** — No concrete v8 mirror-daemon implementation path is present in this repo; assign owner and readiness criteria before T+0. **[GARRETT + SUPERVISING SESSION]**
5. **`initialize()` recipient addresses** — Exact recipient address set is not specified in-repo and must be supplied explicitly. **[GARRETT-DECIDED]**
6. **Ceremony date/time (T+0)** — Calendar lock for keyholder availability and change window. **[GARRETT + SUPERVISING SESSION]**
7. **Bootstrap witness tooling provenance** — Which specific tool/script produces `sampleEntry + proof` from live TariffRegistry at ceremony time, and who signs off its output. **[GARRETT + SUPERVISING SESSION]**
