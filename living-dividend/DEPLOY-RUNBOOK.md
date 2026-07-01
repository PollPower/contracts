# Living Dividend — Deploy Runbook

**Status:** DRAFT (design-complete; awaits deploy ceremony)
**Related:** [`living-dividend-v1.compact`](./living-dividend-v1.compact)
(full ZK compile-clean), [`../ebt/V7.1-EVENT-DIFF.md`](../ebt/V7.1-EVENT-DIFF.md),
[`ld-keeper.ts`](./ld-keeper.ts), [`DESIGN.md`](./DESIGN.md)

## Pre-flight

- [ ] Council go/no-go decision
- [ ] Full ZK compile passes on target compactc (done: 0.31.0, 18.7s)
- [ ] TypeScript witness impls wired to real v5.2 multisig helper
- [ ] LD contract audit checklist reviewed (below)
- [ ] Tangem multisig ring holders confirmed available for two ceremonies
      (one for LD registration authority setup, one for v7.1 LD address bind)
- [ ] Kenya + relay infra healthy (settlement-api, indexer, proof-server)
- [ ] Contract source pushed to `github.com/PollPower/contracts` on
      branch `feat/living-dividend`

## Phase 0 — Contract audit self-checklist

Run the same audit rubric v5.2 got. LD-specific items:

- [ ] Idempotency: `_processedSalts` prevents replay of `bumpOnMint`
- [ ] Solvency: `unshieldedBalance` check in every `bumpOnMint`
- [ ] Divide-by-zero: `_totalLivingMembers > 0` asserted before divmod
- [ ] KYC uniqueness: `_seenKycJobHashes` enforced in `register`
- [ ] Multisig gating: `register`, `unregister` require valid multisig sig
- [ ] Member sig: `claim`, `touchLiveness` require valid member sig
- [ ] L-3 timestamps: all mutating circuits validate `witness_blockTimeGte`
- [ ] Grace period: `executePrune` cancels prune if lastSeen > proposedAt
- [ ] Sealed field integrity: only `constructor` writes `_initialized`,
      `_ebtColor`, `_multisigAuthority`
- [ ] Signature witness pattern matches v5.2 (Ed25519 verify off-chain,
      Boolean returned to circuit)

## Phase 1 — Deploy LD to Preview

1. Compile production build (`compactc 0.31.0`, full ZK, no --skip-zk).
2. Fund deploy wallet with sufficient DUST.
3. Choose `ebtColor` — must match v7's epoch1 color:
   `tokenType(pad(32, "pollpower:ebt:v7:epoch1"), v7ContractAddress)`
4. Choose `multisigAuthority` — hash of the multisig ring pubkey set
   (per ADR-002).
5. Call `LivingDividend.deploy(ebtColor, multisigAuthority)`.
6. **Capture and record `ldContractAddress`.**
7. Verify:
   - `getStats()` returns zero-state (all counters 0)
   - `getSolvencyState()` returns `{ balance: 0, totalReceived: 0,
     totalClaimed: 0, outstandingOwed: 0, isSolvent: true }`
   - `_initialized == true`
   - `_ebtColor` matches v7 epoch1

## Phase 2 — Register pilot members (LD roll bootstrap)

Before v7.1 goes live, populate LD's member roll so the first bump has
something to divide against.

1. For each of the 5 pilot consumers on Path A:
   - Multisig ring holders assemble
   - Multisig signs `register(memberAddr, kycAttestationHash, currentTime)`
   - Submit tx via any admin's node
2. Verify:
   - `getStats().totalLivingMembers == 5`
   - `getMemberState(addr)` returns `{ lastSeen: now, isLive: true }` for each

## Phase 3 — Deploy v7.1 to Preview

1. Apply `v7.1-event-diff.md` changes on top of v7 source.
2. Compile production build.
3. Deploy — `_livingDividendAddress = none<ContractAddress>()` at deploy.
4. **Capture and record `v7_1_ContractAddress`.**
5. Verify: v7.1 settle behaves identical to v7 (dividend still goes to
   placeholder treasury; no event emitted).

## Phase 4 — Migrate settlement-api

1. Update `settlement-api/config.ts`:
   - `EBT_CONTRACT_ADDRESS` → v7.1 address
   - Leave v7 as `EBT_LEGACY_ADDRESS` for historical reads
2. Run migration script to re-attest producers on v7.1
   (`producerRegistry` entries need updating).
3. Restart pm2 `settlement-api`.
4. Verify: manual test session settle succeeds on v7.1.

## Phase 5 — Bind LD to v7.1 (the moment)

**This is the one-way door.** After this step, every settle emits
`DividendMinted`.

1. Multisig ring holders assemble.
2. Multisig signs `setLivingDividendAddress(ldContractAddress, currentTime)`
   on v7.1.
3. Submit tx.
4. Verify: `_livingDividendAddress.is_some == true` on v7.1.

## Phase 6 — Start the keeper

1. Deploy `ld-keeper.ts` to the operator's keeper host (systemd, pm2,
   Docker — any long-lived process manager):
   ```bash
   # Example (pm2):
   npm install
   npm run build
   pm2 start dist/ld-keeper.js --name ld-keeper --env production
   ```
2. Set env vars:
   - `V7_CONTRACT_ADDR` = v7.1 address
   - `LD_CONTRACT_ADDR` = LD address
   - `INDEXER_HTTP_URL` = Preview indexer HTTPS endpoint (for state reads)
   - `INDEXER_WS_URL` = Preview indexer WSS endpoint (for subscription)
   - `PROOF_SERVER_URL` = local proof-server URL (default `http://localhost:6300`)
   - `KEEPER_SK` = keeper wallet secret key (hex, kept out of source control)
   - `CURSOR_FILE` = path to persistent cursor JSON (e.g. `./data/ld-keeper.cursor.json`)
   - `WS_RECONNECT_BASE_MS` = initial reconnect delay (default `1000`)
   - `WS_RECONNECT_MAX_MS` = max reconnect delay (default `60000`)
3. Verify keeper is running: `pm2 logs ld-keeper`

## Phase 7 — Prove the loop end-to-end

1. Run a real settle tx on v7.1 (e.g. a small test session).
2. Wait for indexer to catch up (~30-60s).
3. Verify keeper logs show `[ld-keeper] bumped { ... }` for that event.
4. Query LD: `getStats().bumpCount == 1`, `getStats().accPerShare > 0`,
   `_totalPoolReceived == divAmt`.
5. Have one pilot member submit a `claim(currentTime)`.
6. Verify:
   - Tx succeeds
   - Member's wallet receives `owed` EBT
   - LD `_totalClaimed` increments
   - Solvency invariant holds: `unshieldedBalance == totalReceived - totalClaimed`

## Rollback plan (per phase)

- **Phase 1 broken:** LD contract has a bug. Redeploy new LD with fix,
  update Phase 2/5 targets. No user-facing impact (LD not yet bound).
- **Phase 3 broken:** v7.1 has a bug. Revert settlement-api config to v7.
  v7.1 becomes zombie contract; no funds lost.
- **Phase 4 broken:** settlement-api can't talk to v7.1. Revert to v7,
  investigate migration script.
- **Phase 5 broken:** LD address set incorrectly. Multisig-call
  `clearLivingDividendAddress()` (see v7.1 diff), redo Phase 5.
- **Phase 6 broken:** keeper misconfigured. Fix env + restart pm2. Missed
  events replay from cursor on restart — no data loss.
- **Phase 7 broken:** end-to-end broken. Halt, triage, don't proceed to
  pilot exposure.

## Post-deploy monitoring

- Ops dashboard: add LD panel with `getStats()` + `getSolvencyState()` reads
- Alert if `isSolvent == false` (would indicate v7.1 misconfiguration
  or event/keeper drift)
- Alert if `bumpCount` stops growing while v7.1 `settlementCount` grows
  (keeper is stuck)
- Weekly reconciliation: `unshieldedBalance == totalReceived - totalClaimed`
