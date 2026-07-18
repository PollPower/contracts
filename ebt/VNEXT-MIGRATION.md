# VNEXT Migration Runbook (v7.4.2 -> v8)

## 1. Purpose

This document is the caller-side ceremony runbook for EBT migration from `v7.4.2` to `v8` (vNext): what operators and keyholders execute, verify, and roll back at cutover time; `VNEXT-DESIGN` explicitly calls for this companion runbook (`ebt/VNEXT-DESIGN.md`, lines 1126-1127). It is not a contract design document (canonical design authority: `ebt/VNEXT-DESIGN.md` section 9) and not the full ceremony order-of-operations script (companion: `WI-14-CEREMONY-SKELETON.md`, authored separately). If this runbook is wrong, callers can route new settlements, mirrors, or balances to the wrong contract state and cause avoidable settlement outages during ceremony.

## 2. Scope of the cutover

At T+0, all of the following change:

- **Contract deployment boundary:** v8 is a fresh deployment at a new address, with a new token color and new state layout. `VNEXT-DESIGN` states: "vNext is a fresh contract deployment with a new address, a new token color (different `domainSep`), and a new state layout. Existing v7.4.2 EBT does NOT automatically move." (`ebt/VNEXT-DESIGN.md`, lines 1041-1043).
- **Token color / domain separation:** v8 color is derived from `domainSep = pollpower:ebt:v8:epoch1` (v7.4.2 remains `pollpower:ebt:v7:epoch1`).
- **Mint authority flow:** new HAT-backed settlements must route to v8; v7.4.2 must receive no new attestation-driven settle traffic after T+0 (caller-side policy).
- **Redemption split by lineage:** v7.4.2 coins continue to redeem under v7.4.2 behavior; v8 coins redeem under D-10 dual-currency behavior with per-coin `TariffPath` metadata (`ebt/VNEXT-DESIGN.md`, lines 1082-1086).

At T+0, the following do **not** change:

- LD binding contract shape.
- Multisig authority model.
- Producer registry model.
- TariffRegistry contract ownership/governance model.

## 3. Prerequisites (must be true before T+0)

Each prerequisite is ceremony-start checkable.

1. **WI-13.1 + WI-13.2 landed on `main`.**
   - Check command (as specified): `git log --oneline main -- ebt/tariff-registry-v1*.compact`
   - Author note: in this repo layout, the relevant files currently live under `tariff-registry/`; if the above returns empty, verify with `git log --oneline main -- tariff-registry/tariff-registry-v1*.compact`.

2. **PR #39 (EBT v8) merged to `main`.**
   - Check command: `gh pr view 39 --repo PollPower/contracts --json state,mergedAt`
   - Required result at ceremony: `state = MERGED` and non-null `mergedAt`.

3. **v8 full-ZK compilation and key material complete on Kenya.**
   - Prover + verifier keys generated and signed in ceremony records.

4. **Ceremony plan exists and is signed off.**
   - Companion doc: `WI-14-CEREMONY-SKELETON.md` completed, reviewed, approved.

5. **TariffRegistry readiness.**
   - At least one live registered schedule exists.
   - That schedule has at least one live statutory lane.

6. **Off-chain service branches ready for v8 address cutover.**
   - `settlement-api`, keeper process, dashboard, consumer app, producer app, relay APIs updated or explicitly confirmed unaffected.

7. **Mirror-write daemon exists, tested, and deploy-ready.**
   - It must watch TariffRegistry events and submit v8 `mirror*` circuits
     for events at seqs `<= _registryActionLogHeadSeqMirror` (see §5.3
     for the constraint and §5.9 for the owner-advance ceremony that
     periodically raises this bound).
   - Without it, `_registeredLanesMirror` remains empty and settles revert.

8. **Owner-advance ceremony operational owner + schedule signed off.**
   - Weekly cadence confirmed 2026-07-18 (Garrett + supervising session);
     trigger-on-alert supersedes the calendar when daemon queue-lag
     reaches `>= 50%` of `CAL_MIRROR_STALE_TOLERANCE`.
   - Ceremony script + runbook must exist and be tested against the
     bootstrap flow before T+0.
   - Multisig keyholder availability commitment for weekly cadence must
     be signed off in writing.
   - See `WI-14-CEREMONY-SKELETON.md` §12 for the operational ceremony
     spec (authored under the docs patch that lands alongside this file).

## 4. Migration approach — expand VNEXT-DESIGN section 9.1

`VNEXT-DESIGN` recommendation is explicit and remains authoritative:

> "**Recommendation: (a) parallel deployment.**" (`ebt/VNEXT-DESIGN.md`, line 1066)

Candidate paths considered in `VNEXT-DESIGN`:

- **(a) Fresh mint, no migration** (`ebt/VNEXT-DESIGN.md`, lines 1049-1053): deploy v8 in parallel, keep v7.4.2 redeemable, route all new settle flow to v8.
- **(b) Burn-and-remint bridge** (`ebt/VNEXT-DESIGN.md`, lines 1055-1059): requires delegated mint authority bridge and user migration campaign.
- **(c) Claim-based migration** (`ebt/VNEXT-DESIGN.md`, lines 1061-1064): snapshot + ownership-proof claim map.

Why recommendation (a) stands (from section 9.1 reasoning):

- Pilot supply size is operationally small enough for sunset-by-drain (`ebt/VNEXT-DESIGN.md`, lines 1070-1074).
- (b)/(c) enlarge mint-authority and operational surface at ceremony (`ebt/VNEXT-DESIGN.md`, lines 1075-1078).
- v7.4.2 hardening carries forward without introducing bridge-specific risk (`ebt/VNEXT-DESIGN.md`, lines 1079-1081).
- v7.4.2 lacks per-coin `TariffPath` metadata; partitioning redemption by lineage is cleaner than backfilling (`ebt/VNEXT-DESIGN.md`, lines 1082-1086).

This runbook implements (a). It does not re-litigate the path decision.

## 5. Off-chain service impact — expand VNEXT-DESIGN section 9.3

`VNEXT-DESIGN` section 9.3 defines this impact surface: "Settlement-api, dashboard, consumer/producer apps all currently key off v7.4.2's contract address + protocol-split reads." (`ebt/VNEXT-DESIGN.md`, lines 1109-1111)

### 5.1 settlement-api (Kenya, port 7200)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\settlement-api`
  - GitHub: [https://github.com/PollPower/settlement-api](https://github.com/PollPower/settlement-api)
- **Files needing change (grep evidence)**
  - `src/settlement-service.ts` (legacy split constants and split-shaped `callTx.settle`): line 99-109, line 280-294.
  - `src/settlement-service.ts` (contract deployment binding): line 115-121, line 150-153.
  - `src/settlement-api.ts` (incoming settle payload currently `producerAddress`, `amountBaseUnits`, `meterHash`, etc.): line 70-90.
  - `src/ledger-reader.ts` / `BUILD_PATHS` usage via settlement service for contract decoding: `src/settlement-service.ts` line 371, line 553.
  - `rg` evidence at author-time: no `mirrorRegisterLane|mirrorRetireLane|mirrorClassStatutoryTotal|mirrorActionLogRoot|mirrorActionLogHead` matches in `settlement-api/src`.
- **Nature of change**
  - Re-point contract address/config to v8.
  - Widen payload handling for v8 settle inputs (including producer binding and tariff-path-related inputs as required by v8 ABI).
  - Remove retired split-getter assumptions from caller logic; do not derive routing from v7.4.2 split constants.
  - Apply the same retarget discipline used in the earlier v7.3->v7.4.2 off-chain migration pattern (see `MEMORY.md`, 2026-07-05/session history note referenced by `VNEXT-DESIGN` section 9.3, lines 1116-1117).
- **Testing gate before deploy**
  - Integration test against v8 on Preview/Kenya: `/api/settle` produces successful tx and increments expected v8 settlement counters.
  - Negative: stale/missing mirror state yields explicit revert path and operator-visible error.
- **Rollback**
  - If this service fails independently, switch only settlement-api contract config back to v7.4.2 and restart process; keep v8 deployed but idle for new attests until fix.

### 5.2 keeper (session-3 batch-payer, same repo)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\settlement-api`
  - GitHub: [https://github.com/PollPower/settlement-api](https://github.com/PollPower/settlement-api)
- **Files needing change (grep evidence)**
  - `contracts/dev/session-3/batch-payer/config.ts`: line 23-29, line 49-53 (`EBT_CONTRACT_ADDRESS`, legacy fallback).
  - `contracts/dev/session-3/batch-payer/keeper.ts`: line 43, line 108, line 187-196 (`V74_BUILD`, v7.4.2 state read, `_dividendMintedLog` read).
  - `contracts/dev/session-3/batch-payer/index.ts`: startup identifies v7.4.2 in runtime logs (grep match at line 34-35).
- **Nature of change**
  - Keep Session 9 recipient-filter behavior.
  - Re-point keeper contract bindings/build assets from v7.4.2 to v8-compatible artifacts where `_dividendMintedLog` compatibility is preserved by design.
  - Ensure db keying remains contract-scoped during lineage transition.
- **Testing gate before deploy**
  - End-to-end: v8 settle -> dividend entry detected -> keeper tick -> expected bump/skip semantics.
  - Verify no replay of old-contract salts.
- **Rollback**
  - Stop keeper loop and revert its `EBT_CONTRACT_ADDRESS` + build path to v7.4.2, then restart.

### 5.3 mirror-write daemon (new required component)

- **Repo**
  - Expected home: `settlement-api` operational stack (same operator domain), exact file path currently **not present**.
- **Files needing change (grep evidence)**
  - No existing `mirrorRegisterLane`, `mirrorRetireLane`, `mirrorClassStatutoryTotal`, `mirrorActionLogRoot`, or `mirrorActionLogHead` caller found in `settlement-api` source tree at author-time.
- **Design finding (2026-07-18 discovery, confirmed by Garrett 17:48 JST):** the mirror-write circuits verify inclusion against `_registryActionLogRootMirror`, NOT against the current on-chain `registryActionLogRoot`. See `ebt/ebt-v8.compact` L491-500 (`verifyEventProof` reconstructs a root from leaf+proof and asserts equality with the mirrored root scalar). `_registryActionLogRootMirror` is updated only by `mirrorActionLogRoot`, which is `assertOnlyOwner()`-gated (round-2 review-pass-2 fix, commit `9308a40`). The trust-model comment at `ebt-v8.compact` L742-750 states verbatim:

  > "TRUST MODEL: owner is the sole trust anchor for root advances (round 2
  > review-pass-2 fix). The witness (sampleEntry + proof) is defense-in-depth
  > against typo'd/malformed root installs by the owner itself - it proves
  > newRoot is internally consistent with a well-formed Merkle path from a
  > leaf, but does NOT anchor newRoot to previously-trusted registry state.
  > Full option-(iii) anchoring requires TariffRegistry to expose
  > per-transition commitments (deferred to WI-14.1 pre-mainnet-Phase-2).
  > In production the owner is under multisig control so this is effectively
  > multisig-gated."

  The registry rewrites `registryActionLogRoot` on every `emitAction` call (`tariff-registry/tariff-registry-v1.compact` L620: `registryActionLogRoot = _actionLogClimb;`), so registry root and mirrored root diverge after the first post-bootstrap event.

  Behaviour confirmed by `ebt/tests/vnext/T19-mirror-root-witness.test.mjs` test named "T19 valid witness under a new root advances the trust anchor" — which explicitly walks bootstrap -> new event -> owner-called `mirrorActionLogRoot` with the new-root + new-event witness. Non-owner cases at test names "T19 non-owner cannot call mirrorActionLogRoot even with valid witness" and "T19 non-owner cannot install self-consistent attacker-computed root+witness" confirm the owner gate is enforced.

- **Operational model — (A) periodic-owner-advance (confirmed by Garrett + supervising session 2026-07-18 17:48 JST):**
  - The daemon operates ONLY on registry events at seqs `<= _registryActionLogHeadSeqMirror`. It queues events past that bound.
  - The owner (multisig) periodically calls `mirrorActionLogRoot` to advance `_registryActionLogRootMirror` — see §5.9 for the operational ceremony spec.
  - The daemon exposes a `queueLagEvents` metric equal to (`registry._actionSeq - 1`) - `_registryActionLogHeadSeqMirror`.
  - **Owner-advance cadence:** weekly, unless the daemon's `queueLagEvents` metric reaches `>= 50%` of `CAL_MIRROR_STALE_TOLERANCE`, in which case ceremony is triggered immediately.
  - Full option-(iii) public-witness root advance (removing the weekly-ceremony burden) is deferred to WI-14.1 pre-mainnet-Phase-2 per the ebt-v8 trust-model comment quoted above.
- **Nature of change**
  - New daemon must:
    - Subscribe to TariffRegistry state (via Midnight indexer `queryContractState`) and detect new `_actionSeq` values.
    - Reconstruct the event body from live registry state, verify the locally computed `payloadHash` matches `entry.payloadHash`, halt + alert on mismatch.
    - Maintain a full local depth-24 Merkle replica of the registry's `_actionLog` tree, byte-exact-shape with `appendActionLogLeaf` (`tariff-registry-v1.compact` L597-627) and `reconstructActionLogRoot` (`ebt-v8.compact` L467-484).
    - Build inclusion proofs against `_registryActionLogRootMirror` (NOT against the current on-chain registry root).
    - Submit `mirrorRegisterLane` / `mirrorRetireLane` / `mirrorScheduleLifecycle` / `mirrorClassStatutoryTotal` for events at seqs `<= _registryActionLogHeadSeqMirror`.
    - Periodically submit `mirrorActionLogHead(newHeadSeq, latestEntry, proof)` where `newHeadSeq <= _registryActionLogHeadSeqMirror` (the head advance is also bounded by the mirrored root — the cited event must be included under the mirrored root).
    - Expose `queueLagEvents`, `mirrorHeadSeq`, `registryHeadSeq`, `mirroredRootSeq`, `secondsSinceLastOwnerAdvance` metrics.
    - Fire an alert when `queueLagEvents >= 50% * CAL_MIRROR_STALE_TOLERANCE` to trigger the owner-advance ceremony ahead of the weekly cadence.
    - Track health, lag, and single-instance advisory lock (same pattern as `contracts/dev/session-3/batch-payer/keeper.ts`).
- **Testing gate before deploy**
  - Fresh v8 deploy with owner-installed bootstrap root: daemon mirrors all events at seqs `<= bootstrapSeq` and settles start succeeding.
  - Owner-advance simulation: owner calls `mirrorActionLogRoot` with a new root; daemon detects the advance and drains its queue up to the new mirrored-root seq.
  - Induced lag test: stall the owner-advance simulator; confirm `queueLagEvents` grows monotonically and the daemon's alert fires at 50% tolerance. Settle failures with `LANE_MIRROR_STALE` become expected once the mirrored head lags past `CAL_MIRROR_STALE_TOLERANCE`.
  - Recovery test: unstall owner advance; daemon drains queue; settles resume.
- **Rollback**
  - If daemon fails at cutover, either:
    - bring daemon healthy and re-run mirror bootstrap, or
    - temporarily flip settlement-api back to v7.4.2 until daemon is restored.
  - If owner-advance ceremony fails (multisig quorum unavailable), daemon continues serving reads on already-mirrored seqs. Settles for events past the mirrored-root-seq fail with `LANE_MIRROR_STALE` once the tolerance window closes. Recovery is to complete the owner-advance ceremony.
- **Prerequisite linkage**
  - If daemon is not written + tested by ceremony, T+0 must not proceed.
  - If owner-advance ceremony script is not written + tested by ceremony, T+0 must not proceed (see §5.9).

### 5.4 dashboard (`pollpower-ops-dashboard`)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\pollpower-ops-dashboard`
  - GitHub: [https://github.com/PollPower/pollpower-ops-dashboard](https://github.com/PollPower/pollpower-ops-dashboard)
- **Files needing change (grep evidence)**
  - `src/lib/api.ts`: line 20-23, line 139-144 (dashboard reads relay API endpoints; no contract call path).
  - `src/types/index.ts`: line 160-177 (`SettlementRow` view models from API response).
  - `rg` evidence: no `getBpsProducer|getBpsOperations|getBpsDividend|getBpsDao` matches in `pollpower-ops-dashboard/src` at author-time.
- **Nature of change**
  - Ensure dashboard paths consuming balances are fed by v8 color-aware upstream values.
  - Remove any UI assumptions tied to retired split-getter outputs (none found in current dashboard code; dependency is upstream API output).
- **Testing gate before deploy**
  - Dashboard on-chain/overview pages show non-zero v8 balance for at least one known consumer after first v8 settle.
- **Rollback**
  - If dashboard-only regression occurs, roll dashboard frontend to previous build while keeping backend cutover intact.

### 5.5 consumer app (`consumer-standalone`)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\consumer-standalone`
  - GitHub: [https://github.com/PollPower/consumer-standalone](https://github.com/PollPower/consumer-standalone)
- **Files needing change (grep evidence)**
  - `src/api/client.ts`: line 395-398 (`/api/wallet/balance`), line 426-430 (return/cashout flow), line 89-92 (`WalletBalance` type).
  - `services/walletService.ts`: line 76-84 (`/api/wallet/{address}/balance`), line 139-150 (`/api/pawacoin/cashout`).
  - No direct contract-address or split-getter reads found in consumer app source.
- **Nature of change**
  - Balance read path must remain valid for v8-backed balances from relay API.
  - Redemption UI/API contract must carry `redemptionKind` + `TariffPath` once exposed by backend.
- **Testing gate before deploy**
  - Consumer wallet balance updates after first v8 settle.
  - Redemption flow validates new required fields end-to-end.
- **Rollback**
  - If consumer app deploy fails independently, roll back app build; keep server-side cutover and advise users via release channel.

### 5.6 producer app (`producer-standalone`)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\producer-standalone`
  - GitHub: [https://github.com/PollPower/producer-standalone](https://github.com/PollPower/producer-standalone)
- **Files needing change (grep evidence)**
  - `src/api/producer.ts`: line 104-121 (`/api/producer/register` with `midnightCoinPubkeyHex`), line 123-127 (`/api/producer/wallet`).
  - `services/localWallet.ts`: line 41-45 and line 58-62 (producer on-chain identity key material), line 332-334 (stored coin pubkey hex).
  - `services/walletService.ts`: line 76-84 (balance endpoint), line 139-150 (cashout endpoint).
  - No direct v7 split-getter reads found in producer app source.
- **Nature of change**
  - Keep producer attestation UX aligned with producer address/coin-pubkey source used by settlement path.
  - Ensure producer balance views consume v8-backed API outputs.
- **Testing gate before deploy**
  - Producer earnings/balance reflects first v8 settle for a test producer.
  - Producer registration payload still binds correctly for attestation flow.
- **Rollback**
  - Roll back producer app release independently if UI/API mismatch occurs.

### 5.7 meter-authority-service (relay, port 3008)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\meter-authority-service`
  - GitHub: [https://github.com/PollPower/meter-authority-service](https://github.com/PollPower/meter-authority-service)
- **Files reviewed (source evidence)**
  - `src/index.ts`: line 58-61, line 103-107, line 130-134 (`POST /attest` signs and returns authority attestation over hat key + expiry only).
  - `src/attestation.ts`: line 5-8 and line 36-44 (`persistentHash([hatPubkey, expiresAt])`).
- **Nature of change**
  - **No change required for HAT payload widening** at meter-authority-service layer based on current source: it signs only authority attestation data, not the settle payload tuple that now includes `producerAddr`.
  - Operational check still required: on-chain `_meterAuthorityPubkey` for v8 must match live service key.
- **Testing gate before deploy**
  - `GET /metadata` pubkey matches v8 configured meter authority.
  - New v8 settle succeeds with fresh authority signature.
- **Rollback**
  - If mismatch occurs, rotate/restore service key or on-chain authority key before resuming v8 settle traffic.

### 5.8 pollpower-v2-api (relay, port 3001)

- **Repo**
  - Local: `C:\Users\Garrett\Projects\pollpower-v2-api`
  - GitHub: [https://github.com/PollPower/pollpower-v2-api](https://github.com/PollPower/pollpower-v2-api)
- **Files needing change (grep evidence)**
  - `src/services/midnight-settlement.ts`: line 105-112 + line 115-121 (`/api/settle` payload), line 211-221 (`/api/attest`), line 232-243 (`/api/revoke-attestation`), line 253-265 (`/api/reissue`), line 276-285 (`/api/redeem`).
  - `src/services/index.ts`: line 468-470 (`MIDNIGHT_SETTLEMENT_API_URL` wiring).
  - `src/mint-worker.ts`: line 20 (`MIDNIGHT_SETTLEMENT_API_URL` fallback `http://localhost:7200`).
- **Nature of change**
  - Update relay->settlement payload contracts to match v8 settle/redeem input surfaces.
  - No direct v7 split-getter reads found in `pollpower-v2-api` source at author-time.
  - No direct hardcoded v7.4.2 contract address found in relay source; contract binding is delegated to settlement-api.
- **Testing gate before deploy**
  - Relay mint/settlement flows succeed against updated settlement-api using v8 config.
- **Rollback**
  - Revert relay service to previous release and/or point to prior settlement-api build until payload compatibility is restored.

### 5.9 Owner-advance operational ceremony (new required procedure)

- **What it is:** a keyholder ceremony where the contract owner (multisig quorum) calls `mirrorActionLogRoot` on the live v8 contract to advance `_registryActionLogRootMirror` to the current on-chain `registryActionLogRoot` value, and re-anchors the trust anchor.
- **Why it exists:** because `mirrorActionLogRoot` is owner-gated per the trust model quoted in §5.3, and the mirror-write circuits verify proofs against the mirrored root (not the current on-chain registry root), the daemon cannot advance the trust anchor itself. Without a periodic owner-advance ceremony, `_registryActionLogRootMirror` stays frozen at the bootstrap value, the daemon's queue backs up past `CAL_MIRROR_STALE_TOLERANCE`, and settles start failing with `LANE_MIRROR_STALE`.
- **Cadence:** weekly (confirmed by Garrett + supervising session 2026-07-18 17:48 JST); trigger-on-alert supersedes the calendar when daemon `queueLagEvents >= 50% * CAL_MIRROR_STALE_TOLERANCE`.
- **Who runs it:** contract owner (multisig quorum) + observer. Mirror-write daemon operator provides the pre-flight witness bundle.
- **Concrete procedure:** see `WI-14-CEREMONY-SKELETON.md` §12 (steady-state owner-advance ceremony). At a high level:
  1. Daemon operator produces a candidate `(newRoot, sampleEntry, proof)` bundle from the current registry state (same bootstrap-witness tooling from §5 of the ceremony skeleton, re-run against the current registry tip).
  2. Multisig quorum verifies the bundle out-of-band.
  3. Owner submits `mirrorActionLogRoot(newRoot, sampleEntry, proof)`.
  4. Daemon detects the advance and drains its queue.
- **Post-execution verification:** daemon `queueLagEvents` drops to zero (or close to it, if events have landed during the ceremony); observer confirms `_registryActionLogRootMirror` equals the current on-chain `registryActionLogRoot`.
- **Deferral path:** WI-14.1 targets option-(iii) public-witness root advance, which would remove the weekly-ceremony burden by allowing any honest actor to advance the root with a cryptographic (not authority-based) witness. Until WI-14.1 lands, weekly owner-advance is operational reality.

## 6. Sunset schedule — expand VNEXT-DESIGN section 9.2

Verbatim schedule from `VNEXT-DESIGN`:

> 1. **T+0 (vNext deploy ceremony):** deploy vNext. Switch settlement-api to point new attestations at vNext. Legacy v7.4.2 accepts no new attests.  
> 2. **T+1 to T+30 days:** parallel-hold period. Holders may redeem v7.4.2 coins as normal. New settles go to vNext.  
> 3. **T+30:** administrative pass. Any residual v7.4.2 supply is ackowledged; supply typically small.  
> 4. **T+90:** v7.4.2 deprecation notice; deploy addresses documented as redeem-only. No further settles possible.  
> 5. **T+180:** v7.4.2 status = archive. Redemption still callable indefinitely (contracts don't shut down); off-chain tooling stops pointing at it by default.  
> (`ebt/VNEXT-DESIGN.md`, lines 1092-1102)

`VNEXT-DESIGN` also states schedule ownership remains external: "Garrett + supervising session own the final schedule; this is a starting draft." (`ebt/VNEXT-DESIGN.md`, lines 1104-1105)

### Step 1 — T+0 (deploy + cutover)

- **Who executes:** keyholder + ceremony operator + Kenya service operator.
- **Concrete actions:**
  - Deploy v8 contract (from ceremony plan).
  - Update settlement-api environment to v8 contract address/build, then restart:
    - `pm2 restart settlement-api`
  - Start/restart mirror daemon:
    - `pm2 restart ebt-v8-mirror-daemon`
  - Restart relay API integration if payload/config changed:
    - `pm2 restart pollpower-v2-api`
  - Run canary settle through service edge:
    - `curl -sS -X POST "http://127.0.0.1:7200/api/settle" -H "Content-Type: application/json" -H "x-settlement-api-token: <token>" -d "<canary-payload-json>"`
- **Verification:**
  - v8 initialized state true.
  - First test settle on v8 succeeds.
  - v7.4.2 receives no new settle transactions from official callers.
- **Rollback:**
  - If cutover checks fail, revert service config to v7.4.2 and restart while investigating.

### Step 2 — T+1 to T+30 (parallel hold)

- **Who executes:** operations team, support, keyholder for exceptions.
- **Concrete actions:**
  - Keep v7.4.2 redemption endpoints available.
  - Route all new settle traffic to v8 only.
  - Monitor mirror freshness and settlement success rates:
    - `curl -sS "http://127.0.0.1:7200/api/stats"`
    - `curl -sS "http://127.0.0.1:3001/health/midnight"`
    - `curl -sS "http://127.0.0.1:7301/keeper/status"`
- **Verification:**
  - Daily checks: v8 settlement count increases, v7.4.2 settlement count stays unchanged.
- **Rollback:**
  - Service-only rollback (if needed) to prior app/API release while preserving v8 deployment.

### Step 3 — T+30 (administrative pass)

- **Who executes:** operator + finance/reconciliation owner.
- **Concrete actions:**
  - Reconcile residual v7.4.2 circulating supply and holders:
    - `curl -sS "http://127.0.0.1:7200/api/stats" > ".\\artifacts\\t30-v74-stats.json"`
    - `curl -sS "http://127.0.0.1:7200/api/stats" > ".\\artifacts\\t30-v8-stats.json"` (run against v8-configured env context)
  - Publish internal status note:
    - `gh issue comment <tracking-issue-id> --repo PollPower/contracts --body-file ".\\artifacts\\t30-status-note.md"`
- **Verification:**
  - Supply and holder report signed off.
- **Rollback:**
  - N/A for chain state; if reconciliation tooling fails, rerun with corrected snapshots.

### Step 4 — T+90 (deprecation notice)

- **Who executes:** operations comms owner + API owners.
- **Concrete actions:**
  - Mark v7.4.2 as redeem-only in docs, dashboards, and runbooks.
  - Confirm no caller routes initiate v7.4.2 settle.
  - Push documentation marker update:
    - `gh issue comment <tracking-issue-id> --repo PollPower/contracts --body "T+90: v7.4.2 now redeem-only; no new settle routes."`
- **Verification:**
  - Public/internal docs updated.
  - No v7.4.2 settle attempts from official systems.
- **Rollback:**
  - If messaging error, correct docs and announce amended notice.

### Step 5 — T+180 (archive)

- **Who executes:** operations owner.
- **Concrete actions:**
  - Stop default tooling references to v7.4.2.
  - Preserve redemption access paths for legacy holders.
  - Archive operator runbook references:
    - `git grep -n "v7.4.2" -- ebt/ dispatch-briefs/`
    - `gh issue comment <tracking-issue-id> --repo PollPower/contracts --body "T+180 archive posture applied; redemption path preserved."`
- **Verification:**
  - Tooling defaults point to v8 only.
  - Legacy redemption path still callable.
- **Rollback:**
  - Re-enable archived references in tooling only if required for incident support.

## 7. Cross-lifecycle: v7.4.2 during and after cutover

- **T+0 to T+30: v7.4.2 redemption submissions**
  - v7.4.2 redemption remains callable; contract has no automatic shutdown semantics.

- **New settles targeting v7.4.2 after T+0**
  - Officially blocked by caller policy: settlement-api stops issuing/using new v7.4.2 attestation flow.
  - Contract-level reality: v7.4.2 itself does not forbid new attests by time; a rogue caller with valid material could still mint on v7.4.2.
  - Residual capability must be acknowledged and operationally controlled (key custody + endpoint routing + monitoring).

- **T+180 archive semantics**
  - "Archive" means tooling and defaults move away from v7.4.2.
  - It does not mean hard shutdown; redemption remains callable indefinitely (`ebt/VNEXT-DESIGN.md`, lines 1100-1102).

## 8. Failure modes and rollback

Each path lists trigger, authorizer, and action.

1. **v8 deploy tx fails**
   - Trigger: deploy transaction failure/revert.
   - Authorizer: ceremony keyholder set.
   - Action: no state change expected; correct input and retry deploy.

2. **v8 deploys, but `_registryActionLogRootMirror` bootstrap fails**
   - Trigger: initialize/bootstrap root mismatch or invalid root witness.
   - Authorizer: keyholder + supervising session.
   - Action: treat deployment as broken initialization; redeploy to a new address and re-bootstrap correctly.

3. **v8 deploys, but settlement-api still points at v7.4.2**
   - Trigger: settles continue landing on v7.4.2 from official APIs.
   - Authorizer: service operator.
   - Action: flip config to v8 and restart settlement-api; no on-chain rollback needed.

4. **v8 deploys, but keeper daemon / mirror daemon not running**
   - Trigger: settles revert due to empty/stale mirror.
   - Authorizer: service operator + keyholder if chain calls required.
   - Action: start/fix daemon and catch up mirrors; if outage persists, temporarily route settlement-api back to v7.4.2.

5. **Keeper posts wrong root/witnessed mirror state**
   - Trigger: mirror mismatch detected in settle or monitoring.
   - Authorizer: contract owner/keyholder role.
   - Action: submit corrected mirror transaction (`mirrorActionLogRoot` / relevant mirror circuit) with corrected witness; no supply loss because settle re-validates mirror conditions.

## 9. Post-cutover verification checklist

All checks must pass before declaring T+0 complete.

- [ ] v8 contract deployed at expected address from ceremony record.
- [ ] v8 `_initialized == true`.
- [ ] Constructor inputs match signed ceremony inputs.
- [ ] `_registryActionLogRootMirror` equals live TariffRegistry root.
- [ ] Mirror-write daemon healthy (tick loop active, no stale lag alerts).
- [ ] First test settle succeeds end-to-end on v8.
- [ ] Dashboard shows v8-backed balances for at least one consumer.

## 10. Consolidated timeline (runbook proper)

1. Confirm WI-13.1 + WI-13.2 landed on `main`.
2. Confirm PR #39 merged (`state=MERGED`, `mergedAt` non-null).
3. Confirm v8 full-ZK build and key-signoff artifacts are present.
4. Confirm `WI-14-CEREMONY-SKELETON.md` signed off.
5. Confirm TariffRegistry has one live schedule with one live statutory lane.
6. Confirm off-chain service branches are ready for v8 address.
7. Confirm mirror-write daemon exists, tested, and deploy-ready.
8. Execute T+0 deploy ceremony; record deployed v8 address.
9. Bootstrap mirror root/head and start mirror-write daemon.
9a. Confirm owner-advance ceremony script + runbook are staged and tested (§5.9 + `WI-14-CEREMONY-SKELETON.md` §12).
9b. Confirm multisig keyholder availability commitment for the weekly cadence is signed off in writing.
10. Repoint settlement-api and dependent services to v8; restart processes.
11. Run first canary settle on v8; verify success.
12. Verify checklist in section 9 completely.
13. Operate T+1..T+30 parallel hold (v7.4.2 redeem allowed, new settles v8 only).
14. Execute T+30 administrative residual-supply pass.
15. Execute T+90 deprecation notice and redeem-only posture.
16. Execute T+180 archive posture (defaults to v8; v7.4.2 redemption still callable).

## 11. Open questions

All items below require explicit resolution before ceremony execution.

1. **Sequencing lock:** exact merge order and timing between this migration doc and `WI-14-CEREMONY-SKELETON.md` on `main`. **[GARRETT + SUPERVISING SESSION]**
2. **T+0 calendar date:** what exact date/time defines T+0 for this cutover. **[GARRETT + SUPERVISING SESSION]**
3. **Ceremony keyholders:** proceed with pilot-mock keys or complete H-1 remediation first. **[GARRETT + SUPERVISING SESSION]**
4. **Mirror-write daemon ownership:** if not already productionized, who delivers and operates it for ceremony day. **[GARRETT + SUPERVISING SESSION]**
5. **CAL-vNext-M1:** final mirror-stale tolerance calibration for operational liveness margin. **[GARRETT + SUPERVISING SESSION]**
6. **CAL-13.2-D:** final Merkle depth calibration for action-log scaffold (currently noted as 24). **[GARRETT + SUPERVISING SESSION]**
