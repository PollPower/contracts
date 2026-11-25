# WI-16 ledger 9 status

Branch `wi16-ledger9`. Updated at the end of each task.
Last update: 2026-11-24 (night JST), pre-devnet questions answered (design doc "Settle / reissue Q&A"): on-chain chip registry (council-gated) + chip-nonce replay set; reissue token hashed with expiry; devnet chip guard. Next: step 4 item 4, devnet scripts + LD v3 relayer.

## Current state (2026-11-24, evening JST)

**Done on `wi16-ledger9`:** H-1, C-2, C-1 council (Multisig v8, EBT, TR),
C-1c machine signers (EBT, TR), **LD v3** with its EBT side, and the new
settle-path fixes WI16-E-1..3. Tests: contract + parity 123/123 (0 skipped),
mirror 133/133, typecheck clean. Nothing deployed anywhere public.

Off-chain, not in the repo: the council-keys file (council keys: one council member's ring verified; standby ring verified 2026-11-24, off-chain + compiled circuit; council members 1 and 2 pending).

**Decisions (Garrett, 2026-11-24, after LD v3):** 72 h payout-change delay
approved. HAT signing: option 3, meter-authority-service countersigns the
chip's Ed25519 signature now; chip signs directly after Preprod (tracked:
`docs/design/hat-chip-signing-followup.md`). The Low finding (TR retire at
epoch 0) is fixed before any Preprod deploy: scheduled with the devnet script
work (step 4), since the deploy scripts touch TariffRegistry anyway.

**Decisions (Garrett, 2026-11-24, late):**
- Gap A: outlet stations meter through the Gateway HAT (INA226 → CC1352P7),
  so outlet sessions settle through pp-settle-service; link each purchase /
  outlet session to its metered settle (session id in both records).
  Firmware checked: `ATTEST` (0x60) signs the chip's own INA226-fed
  `session_uwh`, chip uptime and a TRNG nonce; the host supplies only the
  16-byte session id.
- Gap C: council gate on `manualReissue` (2-of-3 via Multisig v8, per-action
  replay records) + attack tests + owner-signature tooling + co-sign
  endpoint, before any Preprod deploy.
- meter-authority-service must require the chip's native attestation and
  refuse `SIGN_HASH` for settles (before Preprod); next firmware revision
  disables `SIGN_HASH` for settle use.
- Admin attest / revoke / reissue buttons: post-redeploy admin-app update.
- pp-settle-service and the mint-worker change stay undeployed until Garrett
  says so.

**Pre-devnet answers (Garrett's questions, 2026-11-24):** see the design doc,
"Settle / reissue Q&A". New on chain: council-gated HAT chip registry
(`registerChip` / `revokeChip`) enforced in `settle`, and a used-chip-nonce set;
µWh remainder documented (≤ 999 µWh per settle); reissue token stored as
SHA-256 with an expiry; devnet chips (`PPDEV`) refused off-devnet; the contract
cannot tell native attestations from SIGN_HASH (ledger 9 has no Ed25519):
recommend the firmware change before Preprod.

**Devnet run progress (the node host local devnet, 2026-11-24):** council (Multisig v8,
marked devnet keys) -> TR staged deploy + registerSchedule via TR->Council
cross-contract call with real proofs + retuneClass -> EBT staged deploy (14
VK inserts, 16-20 s each) + mirrors + producer attestation + council chip
registration -> first settle on chain (154 s; supply 10000, dividend accrued
1000) -> watcher verified the chip signature on the indexer-read event (OK).
Then LD v3 deploy (20 s), bound in EBT (council op 0), member registered
(LD -> Council + LD -> EBT in one tx, 85 s), second settle (149 s; accrued
2000), claim (72 s, SucceedEntirely).

**The three on-chain unknowns: all confirmed on the devnet (2026-11-24).**
1. Mint inside a cross-contract call: the claim's LD -> EBT `mintDividend`
   created an unshielded UTXO of 1000 EBT owned by the member's payout
   address (indexer: claim tx unshielded.created); EBT `_dividendMinted`
   0 -> 1000, LD `_totalClaimed` 1000. The 1000 accrued before anyone
   registered stayed unminted (Garrett's choice a).
2. Two calls to EBT in one transaction: the same claim calls EBT
   `dividendAccrued` (sync) and then `mintDividend`.
3. The indexer returns LD events: `pp:ld:v3:register` and `pp:ld:v3:claim`
   (and EBT `settleChip`) via queryContractEvents, restored to 288 B by the
   codec. The indexer delivered full 256-B payloads in this run.
Supply note: settle adds the whole amount (LD share included) to
`_totalSupply`; `mintDividend` mints that already-counted share, so supply
does not move at claim (20000 before and after).
**Deploy sizes re-measured (2026-11-24, final builds, ledger 9 cost model,
`tooling/measure/measure-deploy-cost-l9.mjs`; 50,000 `bytesWritten` per block,
one tx realistically ~60%):**

| Contract | Full deploy | Staged (ceremony) deploy | Each vk insert | Devnet |
|---|---|---|---|---|
| Multisig v8 (5 vks) | 22.8%, fits | not needed | 5.7% | full deploy, 16-18 s |
| TariffRegistry v1 (18) | 85.5%, too big | **32.1%, fits** | 4.9% | staged, passed |
| EBT v8 (21) | **104.2%: larger than a block** | **36.0%, fits** | 4.9% | staged: 21 s + 14 inserts at 16-20 s |
| LD v3 (10) | 44.3%, fits | not needed | 4.8% | full deploy, 20 s |

EBT grew from 85% (C-1 council) to 104% with the chip registry, council
reissue and dividend circuits: the staged deploy is now the only way EBT can
be deployed. The Preprod ceremony must budget ~15 blocks for EBT's vk inserts.

Next: pp-settle-service submit wiring, the LD
v3 relayer, Gap A session linking, watcher subscription + alert sink.

**Finding (2026-11-24): the contract maintenance authority is a standing
backdoor unless locked.** Midnight.js `deployContract` gives each contract a
one-key maintenance authority (fresh signing key, threshold 1, kept in the
local private-state store, e.g. `midnight-level-db/`). That key can insert or
remove verifier keys and replace the authority at any time, i.e. replace any
circuit's logic. It is what makes a staged deploy possible, and afterwards it
must be locked. Applies to the Preview contracts already deployed (v7.4.x
stack, EBT v8 rollout: its 10 inserts show a live deployer key): whoever holds
those stores can rewrite them. Not touched; flagged to Garrett and Joi.
`midnight-level-db/` is now gitignored.

**Staged-deploy window: devnet attack tests (`stack.mjs attacks`), 12/12
pass on the node host's devnet.** Fresh EBT, mid-deploy (7 ceremony keys, mirrors and
producer attested):
- SD-1 the finalized check refuses it (14 missing, authority not locked);
- SD-2 calling a circuit not yet inserted (registerChip) fails -- refused by
  Midnight.js client-side (contract type mismatch); a raw-transaction version
  that reaches the node is still owed;
- SD-3 settle (in the ceremony set) with a valid HAT fails CHIP_NOT_REGISTERED
  (registerChip is not callable until inserted), supply stays 0;
- SD-4..7 an outsider key inserting the genuine registerChip key, a foreign key
  under manualReissue, removing settle, or taking over the authority: all
  rejected by the node; SD-8 state unchanged;
- SD-9 finalization (13 inserts, then the last key + lock in one update)
  passes the check; SD-10..12 after the lock even the deployer key (remove
  settle, restore its authority) and an unsigned update are rejected.
Rejection reasons are redacted by Midnight.js; the authorized updates use the
same submit path and succeed, so the rejections are the authority check.
So: during the window only the deployer key can insert, and nothing mints
(settle needs a council-registered chip, which needs registerChip). The
contract is NOT inert in the strict sense (the 7 ceremony circuits are
callable: mirrors take only valid TR proofs, attestation needs the owner key).

**Assessment: splitting EBT to recover headroom (no implementation).**
Deploy cost is ~linear in verifier keys (~4.6-4.9% of a block each):
EBT 104.2%; without the chip registry 95.0%; without reissue 99.2%; without
the dividend callees 95.5%; without all three 81.5%; only removing the 9
TR-mirror circuits reaches 60.1%, the single-tx ceiling. No modest split
brings back a one-tx deploy, so staged deploy + finalize-and-lock stays.
Costs of splitting: the chip registry is read by every settle, so a separate
registry adds a cross-contract call and one more proof per settle (settle is
~150 s now); reissue must still mint inside EBT (the token type is bound to
EBT's address), so EBT keeps a gated mint callee and saves ~1 key; each new
contract adds a deploy + lock, an address in CROSS-APP-CONTRACTS, and a
caller-check surface. The real argument for a split is upgrade isolation (with
locked authorities, changing the chip registry means redeploying EBT and
migrating balances), not headroom. Recommendation: no split before Preprod;
revisit if the ceremony set nears ~60% or chip-registry changes are expected.

**Full devnet pass from fresh state: PASS (2026-11-24, commit 7177dd1, 53 min;
record `docs/devnet-passes/2026-11-24T12-57-05-537Z-pass.json`).** One
uninterrupted run, fresh council / keys / contracts, clean tree: council,
TariffRegistry, EBT and LD v3 deployed by the shared deploy suite and each
finalized with its authority locked; two metered settles (watcher OK on both
from the indexer); LD register + claim (mint inside a cross-contract call,
two EBT calls in one tx, LD events via the indexer); pp-settle-service submit
+ crash replay; LD relayer (4 actions, replay refused); watcher alerted all 3
council members for a forged-chip-signature settle; staged-deploy attacks
12/12. Only a fresh-state run counts (`stack.mjs all` refuses existing
state); the Preprod ceremony (`tooling/deploy/preprod-ceremony.mjs`, manual,
not run) uses the same deploy suite and refuses builds or deploy code that
differ from a passing record.

**Step 4 item 4: code complete, each part run on the node host's devnet (2026-11-24).**
- pp-settle-service on-chain submit (`wi16-hat-v9`): split planned from EBT's
  live mirrors (`tooling/settle/settle-plan.mjs`), retry, never resubmits a
  landed session; Gap B journal (countersigned bundle fsynced before submit,
  replayed at startup; bundle refusals final, mirror refusals stay pending).
  Devnet: settle 12345 via the service's real code; crash replay settled a
  journaled-only bundle; a landed session was not resubmitted.
- LD v3 relayer (`tooling/ld/`, token-guarded, pre-checks the member's
  signature before proving) + pollpower-v2-api routes (`wi16-ld-v3-relayer`:
  enroll / member / action, only the caller's member id). Devnet: claim,
  touchLiveness, requestPayoutChange (+72 h), cancelPayoutChange relayed; a
  replayed claim refused before proving.
- Gap A: pp-settle-service requires the session id and puts amount + chip uWh
  on `settled` events; v2-api (`wi16-gap-a`) links each outlet session
  (settle id = sha256 prefix of the session id), starts delivery through
  pp-settle-service and closes the session from events. Off unless
  METERED_SETTLE_ENABLED=true.
- Settle watcher service (`tooling/watcher/settle-watcher-service.mjs`):
  per-member alert sinks (independent delivery, retried, persisted, never
  re-alerted). Devnet: a forged-chip-signature settle with a valid
  countersignature was accepted by the contract and alerted to all 3 council
  members once; genuine settles silent.
**Decisions (Garrett, 2026-11-24, after the first qualifying pass):**
- Watcher alert channel: a Telegram bot posting to the council group, plus
  email to all three members as backup; each channel delivered and retried on
  its own (`tooling/watcher/alert-channels.mjs`, tests AC-1..8). Secrets only
  in owner-only files outside any repo. Runs as a systemd service; Joi deploys
  (`tooling/watcher/deploy/`, runbook `docs/runbooks/hat-settle-watcher.md`).
- Statutory lane: the Preprod class has one, so the devnet class now has a
  300-bps on-chain-remit lane (council-approved `registerLane`, mirrored into
  EBT, every settle planned from the live mirrors; tests LN-1..4). Fresh pass
  with the lane: **PASS** (2026-11-25, `08c94b8`, clean tree, 67 min; 11
  stages, 12/12 attacks refused; record `docs/devnet-passes/2026-11-25T05-42-47-913Z-pass.json`).
- Every full pass starts by restarting the proof server (Garrett,
  2026-11-25, after the node host OOM-killed it mid-pass at 21.7 GB); a failed
  restart stops the pass. Joi caps the proof server's memory.
- Operational procedures, hosts and council logistics live in the private
  ops repository (`PollPower/ops`, private; 2026-11-25); this repo stays public.
- Statutory lane (Garrett, 2026-11-25): minted on chain to a council-approved
  PollPower statutory account; KES remitted off-chain and recorded with
  `tooling/tariff/remit.mjs` (hash-chained log; each head anchored in the ops
  log `the ops log` on the node host, backed up nightly to the backup array, and in the
  council Telegram group). Later: an on-chain anchor.
- Proof server: one job, one worker, `--job-timeout 3600`, 15 GiB cap (Joi);
  our tooling sends one proof at a time (`555d32b`) with a 3600 s client
  timeout (`5394d02`). Measured 2026-11-25 (Preprod paused): largest single
  proof ~10.3 GiB (registerSchedule; registerLane 9.49 GiB on a fresh server),
  so peak + 20 % fits the 15 GiB cap and no cloud proving host is needed. The
  server keeps memory across proofs (registerLane after the other tariff
  proofs hit 15 GiB and was OOM-killed), so a pass restarts it before every
  proof (`08c94b8`, `MIDNIGHT_PROOF_SERVER_RESET`; no OOM kills in the pass).
  Under CPU contention (Preprod syncing) one proof took >15 min: passes run
  while Preprod's node and indexer are paused, or take much longer.
- Recorded demo on this pass: `docs/demo/wi16-demo.md` (ring in council slot 0
  of a separate demo deployment of the same suite). Dry run 2026-11-25 with a
  software key standing in for the ring: prep 40 min; scenes 1-5 all as
  scripted (ring approval, settle 12,345 EBT incl. lane 370, claim 617 EBT,
  3 attacks refused with supply unchanged, forged settle alerted to all 3).
  Scene times 3:01 / 1:53 / 1:12 / 0:05 / 1:55 before the edit speeds up proving.
  **Recorded 2026-11-25** (Preprod node + indexer paused for it): separate
  demo deployment (prep 40 min, `0a9376c`), council slot 0 = a real council
  Tangem ring, slots 1-2 devnet stand-ins. All five scenes ran: the ring's
  approval verified in-circuit and landed on chain, member registered via
  LD -> Council; metered settle incl. the statutory lane; Living Dividend
  claim via LD -> EBT; three attacks refused; forged settle alerted through
  the council alert bridge to the council Telegram group and all three
  inboxes, labelled DEMO (`932aa94`), no undelivered alerts. Next: Preprod
  resumes on Garrett's go.
Open: consumer app must call `/api/ld/v3/enroll` with the shim's member key
after KYC; everything above undeployed.

**Preprod gates (all must hold before any Preprod deploy):**
- ~~Fresh pass pending: covers ops move + fix #5.~~ **PASSED** 2026-11-25 on
  `wi16-fix5` at `19aadeb` (clean tree; ops move + fix #5 + settle registry
  gate): 11 stages, 13/13 attacks incl. `RA-chain`, adapter synced EBT 3 -> 4
  of 4 and settled; proof-server peak 10.17 GiB of 15; record
  `docs/devnet-passes/2026-11-25T13-46-10-951Z-pass.json`. Merged into `wi16-ledger9` on 2026-11-26, before Preprod, at Garrett's request; the reviewed state is tag `review-base` (`f72ff34`).
- **The ring key behind the July fragment is retired: never in any new council.**
- **Pre-mainnet: decide stale-lane tolerance (CAL-vNext-M1); not a Preprod blocker.**
- Every step passes on the local devnet, and Joi confirms the node host is fully synced.
- **Council rotation (72 h delay)**: implemented 2026-11-26 on branch
  `wi16-rotation` (2-of-3 approve -> schedule -> 72 h -> execute, generation
  bump; council-approved cancel; tests R-1..R-10, C1b-TR-8; devnet stage
  `rotation`). Fresh pass pending; merge into `wi16-ledger9` after it passes.
- **HAT firmware with `SIGN_HASH` disabled for settle use** (hard gate,
  Garrett 2026-11-24): the contract cannot tell `SIGN_HASH` signatures from
  native attestations.
- Settle-event watcher running as a service and alerting all council members
  on Telegram (council group) AND email, each channel independent; every
  channel confirmed with `--test-alert` (`docs/runbooks/hat-settle-watcher.md`).
- **Council keys for Preprod** (ceremony rule, decided 2026-11-25):
  - slot 0: a **fresh secp256k1 key created on the founder's ring for
    Preprod**, never published anywhere before the deploy;
  - slots 1 and 2: council member 1's and council member 2's ring keys;
  - **none of these public keys is ever committed** to any repository: they
    reach the Multisig v8 constructor only from the off-chain council-keys file;
  - the council keys published so far only ever controlled the devnet demo
    and are never reused on Preprod or mainnet.
  Built only through `tooling/council/council-keys-guard.mjs`, which
  hard-refuses the devnet council test keys (marked: x starts 0xDE7E) on any
  network but the local devnet.
- **Exact-length event decoding everywhere events are read** (watcher, LD v3
  relayer, any indexer consumer), via `tooling/events/event-codec.mjs`: each
  event is restored to its exact expected length per type/version (the runtime
  drops trailing zero bytes; shorter data is zero-padded), longer data and
  unknown framing are refused, and signatures/digests are verified over the
  restored full-length bytes. Proven by W-4 (strictness) and W-5 (uptime 0 and
  nonce 0: trimmed on the wire, restored, re-encoded byte-exact, chip
  signature verifies). Done in tooling; the devnet run must confirm it against
  the indexer (done 2026-11-24: events are read through the provider's decoded
  Misc `name` + `payload`, restored by `restoreIndexerMiscEvent`; the `raw`
  field is the whole log item, 373 B with framing + metadata, and is never
  decoded as the event; W-6). The LD relayer must use the codec.
- **Devnet council test keys hard-blocked off-devnet** (done, CK-1..CK-3):
  marked keys (x starts 0xDE7E) are refused by the constructor builder on any
  network but `undeployed`, whatever the configuration says.
- **Finalized-state check passes for every deployed contract** (EBT, TR, LD
  v3, Multisig v8): `checkFinalized()` in `tooling/deploy/finalize.mjs` -- the
  on-chain operations equal the audited build exactly (none missing, none
  extra, every verifier key byte-identical) AND the maintenance authority is
  locked (threshold >= 1 and above the committee size; threshold 0 is refused:
  it needs no signature at all). Staged deploys end with ONE maintenance update
  that inserts the last key and locks the authority (`finalizeContract`), so
  the complete contract never exists with a live deployer key. Run the check
  against the indexer after the ceremony and record the result.
- **SD-2 at the node:** a raw transaction (built without Midnight.js's
  contract-type check) calling a circuit whose verifier key is not inserted
  must be rejected by the node, with state unchanged. The devnet SD-2 so far
  is refused client-side only.
- **Secret scanning across all PollPower repos:** gitleaks pre-commit hook +
  CI job (plain binary; the gitleaks Action needs a paid license for orgs),
  custom rules for Midnight private-state stores and seed fields, and
  `.gitignore` entries for local key stores and `.env` files. GitHub native
  scanning + push protection on every public repo.
- **Locked maintenance authority on EBT, TariffRegistry and LD v3** on
  Preprod/mainnet (Garrett 2026-11-24); upgrades are a new version + council-
  approved migration.
- **EBT reads the TariffRegistry root on chain** (fix #5; Garrett
  2026-11-25): **done**: built on branch `wi16-fix5`, fresh pass PASSED (`19aadeb`),
  merged into `wi16-ledger9` on 2026-11-26, before Preprod, at Garrett's request; the reviewed state is tag `review-base` (`f72ff34`). TariffRegistry `actionLogAnchor` (witness-free, refused before the
  bootstrap completes) read by a permissionless EBT `syncRegistryRoot`
  through a cross-contract call; `mirrorActionLogRoot`, its owner digest and
  `mirrorActionLogHead` removed; the constructor takes the registry address
  (sealed). Attack tests RA-1..RA-8 written first (on the pre-fix build the
  owner key installed a forged root and a settle paid the forged lane);
  the settle adapter (the Preprod settle path) gates every settle by default:
  sync EBT if behind, re-check, refuse on `REGISTRY_AHEAD_OF_MIRROR` /
  `CLASS_MIRROR_BEHIND` / `LANE_MIRROR_BEHIND` (it will not open without
  `TARIFF_REGISTRY_ADDRESS` / `TARIFF_REGISTRY_BUILD_DIR`); devnet run now
  registers the lane after EBT's deploy (sync -> re-mirror -> settle) and
  checks `RA-chain`. Full ZK builds: staged EBT 34.4 % and staged TR 36.1 %
  of a block (each one tx). Design and the changes made while implementing:
  [`design/registry-root-anchor-design.md`](design/registry-root-anchor-design.md).
- Done already: Gap C council gate on `manualReissue`, native attestation in
  meter-authority-service, epoch-0 retire fix, chip registry + nonce set.

**Step 4 order (ABI first, so the scripts are written once):**
1. ~~TR retire-at-epoch-0 fix~~ done `49403b3` (3 tests).
2. ~~`manualReissue` council gate~~ done `d1a0e36` (RC1-RC5), owner signer
   `tooling/owner/` (OWN-1/2), co-sign endpoint meter-authority-service
   `/reissue/v9` (`8e4caa1`, 4 tests).
3. ~~Native chip attestation~~ done: contract `d1a0e36` (settle carries the
   chip's own µWh / uptime / nonce / hardware id; amount == floor(µWh/1000)
   in-circuit; event re-verifiable), meter-authority-service `c6f2b92`
   (native attestation only, SIGN_HASH refused; 17 tests), pp-settle-service
   `7aa0eaf` (`ATTEST`; session id = purchase id, Gap A; 36 tests).
   Contracts: 136/136 + mirror 133/133.
4. **Settle-event watcher** (Garrett 2026-11-24): re-verify each
   `settleChip` event's chip Ed25519 signature against the chip's on-chain
   registered key, alert all council members on mismatch. Chip revocation stays
   2-of-3 (no single-member suspend); runbook `docs/runbooks/hat-settle-watcher.md`.
   **Core done** (`tooling/watcher/settle-watcher-lib.mjs`, tests W-1..W-4):
   W-2 shows the contract accepting a countersigned SIGN_HASH-style signature
   and the watcher flagging it. Still to do: the indexer subscription + alert
   sink (all council members), run on the devnet. The runtime's value
   encoding drops trailing zero bytes of event payloads (288 -> 257 here):
   `tooling/events/event-codec.mjs` restores each event to its exact layout
   length per type (shorter: zero-padded; longer: refused), the watcher
   verifies over the restored fields, and W-5 round-trips an event whose last
   fields are genuinely zero. The devnet run must still confirm the indexer's
   `raw` framing.
4. Devnet scripts (deploy, mirror, settle submit with retry), LD v3 relayer
   (`/api/ld/v3/*`), Gap A session linking; then the devnet run.

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
| Tue 24 | **H-1** (EBT, Multisig: constructor sets all authorities) · Tangem test tooling + admin-app "sign hash" · local devnet up | **H-1 done**: 9 contract tests (3 negative) green; EBT 18→17, ceremony 8→7, Multisig 12→11 circuits. Tangem tooling + software-key pipeline (5 tests) `3d29984`; admin app ring test `e77521b` (monorepo, branch `wi16-ledger9`); devnet up on the node host (node 2.1.101, indexer 4.4.101, proof 9.0.2; offset ports). **Waiting on:** ring signature (needs `read:packages` token for the APK build) | H-1 ✅ · Tangem ⏳ |
| Wed 25 | **C-2** (EBT owner Schnorr) + Schnorr signer lib + parity · **Tangem ring verified on devnet** | **C-2 done early (Tue 24)** `d170a9f`: 13 contract tests (11 negative) green; owner = Jubjub key, in-circuit `jubjubSchnorrVerify` over (contract, circuit, args digest, nonce); signer uses the contract's exported pure helpers. Devnet path for the ring proven with a software key, low-S and high-S both verified on chain (`61cf805`). **Tangem ring verified (Tue 24):** real ring secp256k1 signature (compressed 33-byte key, raw 64-byte r‖s, low-S) accepted by `@noble/curves`, the compiled circuit and **on chain with a real proof** (devnet block 627); wrong digest rejected. Council keys stay on the rings | C-2 ✅ · Tangem ✅ |
| Thu 26 | **C-1 council**: Multisig secp256k1 `approve` + `isApproved`; EBT/TR/LD `requireCouncil` + replay records | **Started early (Tue 24).** Multisig v8 done `6e818e3`: in-circuit `secp256k1EcdsaVerify`, no witnesses; approvals per (action, slot) under a council epoch; constructor for ≤7 slots with H-3 bounds and duplicate-key rejection. 14 tests (10 negative) green, incl. the PoC replayed against v6.2 (control: still vulnerable) and v8 (rejected). Council rotation designed (72 h delay) as a **Preprod gate**. **C-1b done (Tue 24):** EBT `1f9cf27` (10 tests, 8 negative) and TariffRegistry `de37277` (8 tests, 6 negative) check approval through a ledger 9 cross-contract call to `isApproved` on a real Multisig v8 (verifier keys checked), with their own replay records; council witnesses, EBT op 3 and TR `setFederationAuthority` removed (council rotates in place). LD gets the same with LD v3. Council 2-of-3 + standby procedure documented `14b3fde` | C-1 council ✅ (LD with LD v3) |
| Fri 27 | **C-1 machine signers**: HAT, escrow attestor, schedule operators → Jubjub Schnorr; meter-authority-service signer | **Done early (Tue 24)**: EBT `1e90910` (18 tests, 12 negative) and TariffRegistry `a95e48b` (11 tests, 7 negative). No `signature_valid` witness left; HAT, reissue co-signature, escrow attestation, schedule validator and operators are Jubjub keys verified in-circuit over exported pure-circuit messages bound to the contract address. Found and fixed on the way: **TR `registerSchedule` front-run** (approval did not bind operator key or reference rate; validator key was a free argument) and the reissue co-signature not binding the recipient. PoC shown on the old builds. **Open (cross-app):** `meter-authority-service` signer change, notified to Joi; in-repo Ed25519 settle-flow scripts refuse to run until the devnet rewrite | C-1c ✅ (service signer ⏳) |
| Sat 28 | **LD v3** + EBT `dividendAccrued` / `mintDividend` callee | **Done early (Tue 24, after the reboot):** EBT side `b236ea4` (12 tests, 8 negative), LD v3 `dcd9632` (20 tests, 11 negative). Members claim themselves; EBT mints to the payout address from an on-chain budget it cannot overdraw; LD bound once. Garrett's (a)/(b)/(c) built in; payout-change delay proposed at **72 h**. A full in-memory settle for these tests exposed **WI16-E-1** (High: settle split not bound to the class, dividend could be zeroed), **WI16-E-2** (High: registry mirror rollback) and **WI16-E-3** (Medium: proof sequence unbound); all shown on the old build and fixed. Harness gap fixed on the way: callee state is now written back after cross-contract calls (the budget test caught it) | LD v3 ✅ |
| (new) | **meter-authority-service + settlement client** → Jubjub Schnorr (Garrett 2026-11-24: owned here, Joi deploys to the node host) · rewrite ceremony / HAT / retune / deploy scripts | **Started early (Tue 24).** The production HAT chip signs Ed25519 on chip, which the circuit cannot verify; Garrett chose option 3. **meter-authority-service done** (`wi16-hat-v9` `18f4dcb`): `/hat/v9` verifies the chip signature against the allowlist, applies the sanity rules and countersigns in Jubjub; 14 tests (10 negative), vectors from the compiled contract; runtime 0.15 → 0.21 (fixed the legacy `/attest` rename on the way). **Contract** `84a748f`: `chipDigest` + `hatMessage` bind the chip key/signature; `settleChip` audit event; 2 new tests. **pp-settle-service** (`wi16-hat-v9` `54e3d66`): v9 flow with a persisted per-chip counter and `/hat/v9` client, 36 tests green; on-chain submit left for step 4 (throws until then). Found: `settlement-api`'s settle (v2-api mint worker) has no HAT and cannot mint on v9 (decision for Garrett) | service ✅ · client ✅ (submit in step 4) |
| Sun 29 | **Full local-devnet run** of the whole stack (fenced deploys, settle, claim), deploy sizes re-measured | | |
| Mon 30 | Recorded demo + submission (shows what passed the devnet run) | | |

Deploy gate: nothing goes to Preprod until every step passes on the local
devnet **and** Joi confirms the node host is fully synced.

## Goal: Nov 30 Buildathon, Wave 3

Run the PollPower contract stack on **Midnight Preprod (ledger 9)** against
the node host's self-hosted stack:

- Multisig v6.2 (H-3 hardening; Tangem admin swap done manually by Garrett)
- TariffRegistry monolith (ceremony-fenced deploy + vk-insert rollout)
- EBT v8 (ceremony-fenced deploy + vk-insert rollout)
- New Living Dividend: user-initiated claims via a ledger 9 cross-contract
  call; unshielded; no re-entry into the caller

Community Poll comes after Nov 30. Deploys are manual ceremonies Garrett
green-lights; nothing in this branch deploys. **Rule (Garrett, 2026-11-24): no
contract goes to any public network, Preprod included, until WI16-C-1, C-2 and
H-1 are fixed.**

Infrastructure (the node host Cardano node, db-sync, midnight-node 2.1.101, indexer
4.4.101, proof server 9.0.2) is **Joi's**; status lives in
`docs/infra-status.md`, target Thursday evening. The tooling reads every
endpoint from environment variables (`.env.example`), ready for the node host's
private-network addresses.

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
| EBT v8 (18 circuits) | ✅ pragma pinned to 0.28 only change | ✅ the node host 6 m 16 s, 2.4 GB peak | `c4a5240` |
| EBT v8 ceremony (8) | ✅ | ✅ the node host 4 m 01 s | `c4a5240` |
| Multisig v6.2 (12) | ✅ | not run | `b7dfc89` |
| TariffRegistry v1 + ceremony (18 + 18) | ✅ | not run | `b7dfc89` |

**After H-1 + C-2 (`d170a9f`, full ZK on the node host, Tue 24):** EBT v8 17 proved
circuits (+7 pure helpers, no keys), ceremony 7. Owner-gated verifier keys
grew 2,121 → 2,313 B (in-circuit Schnorr); prover keys ~24 MB each. Full
deploy 85.3% of the block (still needs the fence), **ceremony deploy 35.6%
(fits in one tx)**, each vk insert 4.9%. The fence plan holds.

**After C-1 council (full ZK on the node host, 30 min, Tue 24):** every staged deploy fits.

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

Host and workstation notes are kept in the private ops repository
(`PollPower/ops`, private).

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
6. **the dev workstation WSL:** needs a reboot to start at all; then `memory=8GB` (or 6 GB
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
  and TR, ~30 min on the node host). TR gained one circuit (`setValidator`, +1 vk
  insert, ~4.5% of a block); staged deploys had ~25% headroom. Re-measure
  with the devnet build.
- **TariffRegistry action hashes**: `registerSchedule`, `retuneClass` and
  `setValidator` now have exported pure helpers (C-1c); the other federation
  ops (`retireSchedule`, `advanceEpoch`, `setNationalContext`, lanes) are
  still computed inside each circuit. Add with the admin-app switch.
