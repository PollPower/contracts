# T+0 Pre-flight Signed Input Manifest — Template

**Ceremony:** EBT v8 initial deploy (ceremony-fenced) + `initialize()` + post-deploy vk-insert rollout on Preview
**Target date:** Sun 2026-08-02 ~14:00 JST (§9 CAL-5)
**Ref:**
- `PollPower/contracts@main` `ebt/WI-14-CEREMONY-SKELETON.md` §3 prerequisite #10, §4 step 4
- `PollPower/contracts@main` `ebt/V8-CEREMONY-FENCE.md` (rehearsed live 2026-07-29 → 2026-07-30, addr `10158a54...ae474f` on Preview)
**Signed off by:** Garrett (in ceremony room, before signing)

---

## Ceremony identity

- **Ceremony ID:** `t0-preview-2026-08-02`  (or `[YYYY-MM-DD ceremony variant]`)
- **Wall-clock start:** `[HH:MM JST, filled at ceremony room]`
- **Wall-clock signed-off:** `[HH:MM JST, at manifest sign time]`
- **Signers present:** `[list of the 5 admin signers; 1 real Tangem ring + 4 pilot-mock keys per §9 CAL-1 H-1 posture]`
- **Observer:** `Joi (BIG session, transcript captured)`

---

## Contract addresses (deployed pre-ceremony)

### TariffRegistry (5-sibling split, per `PollPower/contracts@main` `0627b55`)

Deployed 2026-07-29 21:10 JST, manifest at `kenya:~/contracts/tariff-registry/deploy/artifacts/wi15.1-preview-2026-07-29T12-01-14-995Z.json`.

- **Audit** (holds `_actionLog`, `_actionLogClimb`, `registryActionLogRoot`): `91a70ba3ab88f3753c47874025c31245ddcf8a07f3d040bbb74190b277358131`
- **Governance:** `c4fa3431255e59c8d387df6be73262de510cc7024d03a09e079829d7d2d543f1`
- **Schedule:** `06b2ef2505bc00e4e371c15ad6ca4faeb374e192d4fe542cc426d0f3d243c5da`
- **Lane** (aggressive-shrink per `V1.1-DEFERRED.md`, registerLane-only): `f49c332d36948983059786b754563d424d0f701d2ca809ff2dbb65ff460a43bd`
- **Views:** `f06f873253c6a509b6c061898f9c771c60b73db0c21560e5a446e7ffbfb44356`

### EBT v8 (ceremony-fenced)

- **Contract address:** `[FILL AT DEPLOY STEP 2, before initialize()]`
- **Rehearsal address (Preview, Wed 2026-07-29):** `10158a544233f7590ae00fd34255c3646aa25fe75375eab00d76582647ae474f`
- **Deploy tx (rehearsal):** `00a2d098e22123e19b3d3beb747647c54951808f354d740cf7699f1672b1cc49a3`
- **Compiled from:** `PollPower/contracts@main:ebt/ebt-v8-ceremony.compact` at git rev `[FILL: rev-parse HEAD before deploy]`
- **Build path on kenya:** `~/contracts/ebt/build/v8-ceremony`
- **Deploy script:** `~/contracts/ebt/deploy-ebt-v8-ceremony.mjs`
- **Circuits in initial deploy (8):** `initialize`, `attestProducerOwnership`, `revokeProducerOwnership`, `mirrorActionLogHead`, `mirrorScheduleLifecycle`, `mirrorClassStatutoryTotal`, `mirrorRegisterLane`, `settle`
- **Circuits added post-deploy via vk-insert (10):** `getRegistryActionLogHeadSeq`, `claimSplit`, `execMultisigOp`, `redeem`, `mirrorActionLogRoot`, `mirrorRetireLane`, `execOwnerOp`, `manualReissue`, `resolveLanesMirror`, `isLaneActiveMirror`

**Why fenced:** v8's 18-circuit deploy tx exceeds Preview's per-tx block weight limit. Solution rehearsed Wed 2026-07-29 late-night: deploy 8 ceremony-critical circuits in one tx, then add the remaining 10 via `submitInsertVerifierKeyTx` maintenance txs. See `V8-CEREMONY-FENCE.md` for full rationale.

**Rehearsal timing** (Wed 2026-07-29 → Thu 2026-07-30 JST):
- Ceremony deploy: 22.8s tx elapsed
- 10 vk-inserts: mean 21.9s ± 1.7s each
- Total wall time (including ~80s wallet init per session): ~55 min for the whole rollout

### Multisig v6 PROD

- **Address:** `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a` (per MEMORY.md landmark)
- **Threshold:** 3-of-5, Ed25519
- **Admin set (pilot posture, H-1):** 1 real Tangem ring + 4 pilot-mock keys, all held by Garrett

---

## Ceremony sequence (rehearsed order)

Wed 2026-07-29 → Thu 2026-07-30 rehearsal validated this sequence end-to-end
against address `10158a54...ae474f`. Sunday re-runs the same sequence against
a fresh address.

### t+0 (ceremony room, Sun ~14:00 JST)

1. **Deploy `ebt-v8-ceremony`** — expect ~23s tx elapsed. Address recorded.
2. **`initialize(...)`** with the 8-parameter bootstrap (see input set below).
3. **`mirrorRegisterLane`** — install at least one lane in `_registeredLanesMirror`.
4. **`mirrorScheduleLifecycle`** — set the schedule live in `_scheduleLiveMirror`.
5. **`mirrorClassStatutoryTotal`** — install class total in `_classStatutoryTotalBpsMirror`.
6. **`mirrorActionLogHead`** — advance headSeq (also serves as the freshness anchor).
7. **`attestProducerOwnership`** — attest pilot producer.
8. **`settle`** — the money proof, single HAT-signed settlement.
9. **`revokeProducerOwnership`** — bookend, prove the revocation path works.

### t+1..t+3 (or same-day if pace is comfortable)

Run 10 vk-inserts one-per-tx via `~/contracts/ebt/rollout/insert-vk-<circuit>.mjs`.
Rehearsed priority order (Garrett-approved 2026-07-29):

- **t+1 Mon:** getRegistryActionLogHeadSeq (smoke test if not done t+0), claimSplit, execMultisigOp
- **t+2 Tue:** redeem, mirrorActionLogRoot
- **t+3 Wed:** mirrorRetireLane, execOwnerOp, manualReissue, resolveLanesMirror, isLaneActiveMirror

Halt rule: if any vk-insert fails, stop the whole rollout until we understand why. `verify-ceremony-state.mjs` after each insert.

---

## `initialize()` input set — SIGNED VALUES

Per `WI-14-CEREMONY-SKELETON.md` §4 step 4:

### 1. `_meterAuthorityPubkey`

Source: Meter Authority Service on relay (`GET /metadata`)

- **Value (hex):** `bf043807ba0112048d1ba073a47128bb094b3710036fe3da898fcd957fa6f09a` (per MEMORY.md landmark; verify with `curl http://89.167.106.57:3008/metadata | jq -r .pubkey` in ceremony room)
- **Verified against relay at ceremony:** `[✓ / value read at ceremony room]`

### 2. `_escrowAttestorPubkey`

- **Value (hex):** `[GARRETT-DECIDED — commit the specific pubkey here at manifest sign time. Reuse a v7.4.2 escrow attestor pubkey or generate a new deploy-scoped one; if latter, keypair path and passphrase are recorded in the sealed manifest, not this template.]`
- **Provenance:** `[e.g., "reused from v7.4.2 deploy 2026-07-05" OR "freshly generated 2026-08-02 in ceremony room via <path/tool>"]`
- **Reachability check (post-deploy):** `[✓ / attestor's redeem-solvency endpoint responds]`

### 3. Multisig authority hash

- **Multisig v6 address:** `f7192a504e186e6a418bcb3f42291ee1a3c032b8c0724c4fab54cc3f62745c3a`
- **Authority hash value:** `[FILL: computed as `_authorityHash` field of multisig-v6 state, read from kenya via `queryContractState` or the settlement-api /governance endpoint at ceremony start]`
- **Reads to same value at ceremony room:** `[✓]`

### 4. Recipient addresses (per §9 CAL-4)

**Rule:** reuse the existing v7.4.2 pilot producer wallet set. Bech32m encoded (real Midnight Preview producer addresses).

- **con-000** (consumer 0): `[FILL from v7.4.2 producer registry on relay]`
- **con-001** (consumer 1): `[FILL]`
- **con-002** (consumer 2): `[FILL]`
- **prod-000** (producer 0): `[FILL]`
- **prod-001** (producer 1): `[FILL]`

**Extraction command (at ceremony room):**
```
ssh pollpower-relay "psql -U pollpower -d pollpower -c \\
  \"SELECT display_name, midnight_address FROM producers \\
    WHERE display_name IN ('con-000','con-001','con-002','prod-000','prod-001') \\
    ORDER BY display_name;\""
```

### 5. Any other constructor/init inputs

Cross-check against `ebt/ebt-v8-ceremony.compact` `initialize(...)` circuit signature at ceremony start:

- `[FILL: any additional `initialize()` args added since 2026-07-27 CAL-4 spec-out. Currently none per WI-14-CEREMONY-SKELETON.md, but re-read the circuit before ceremony.]`

---

## Post-`initialize()` verification (per §4 step 4 sub-checks + step 5)

- [ ] `_initialized == true` (read via `queryContractState` decoder)
- [ ] `_meterAuthorityPubkey` reads back **identical bytes** to value 1 above
- [ ] `_escrowAttestorPubkey` reads back **identical bytes** to value 2 above
- [ ] `_authorityHash` reads back **identical bytes** to value 3 above
- [ ] `_producerAddresses` (or v8-named equivalent) list matches the 5 bech32m addresses from value 4 above, in the declared order

## Post-`mirrorActionLogRoot` note

**Ceremony-fenced deploy does NOT include `mirrorActionLogRoot`** — that circuit is in the deferred-10 set. The initial ceremony sequence uses `mirrorActionLogHead` to advance headSeq only; the mirrored log root is bootstrapped from the `initialize()` argument (per `ebt-v8-ceremony.compact:initialize` circuit).

Post-t+0 (during vk-insert rollout on day t+2 in the rehearsed schedule), `mirrorActionLogRoot` becomes callable. From that point onward, the daemon can advance the mirrored root when the audit sibling's `_actionLogClimb` moves.

**At ceremony:**
- [ ] `_registryActionLogRootMirror` set to the value passed at `initialize()` (bootstrap from tariff-registry audit sibling `91a70ba3...58131` empty-log root `5913fa3d3b327cc22903adbb421c36ef7e8d0248bfc701cd875a489044cc8e47`, or refreshed value from live audit sibling state read at ceremony time)
- [ ] `_registryActionLogHeadSeqMirror == 0` (empty log at bootstrap)

## Bundle provenance (for mirror-install ceremony)

Per F-1, use `scripts/generate-owner-advance-bundle.ts` (now on `settlement-api:main` post-PR #8 merge `3a3b9f7`) to generate the witness bundle. **However**, initial mirror-install with an empty log is a degenerate case — the bundle contains no `sampleEntry`. Confirm during ceremony that the F-1 script handles empty-log initial-install correctly, or fall back to a hand-composed empty-root install per the daemon's `mirrorActionLogRoot` circuit signature.

- [ ] Bundle generated at: `[FILL path]`
- [ ] Bundle SHA256 (integrity): `[FILL sha256sum output]`

---

## vk-insert rollout tracking (t+1..t+3)

For each circuit added post-ceremony:

| # | Circuit | Target date | txHash | Elapsed | Verified |
|---|---|---|---|---|---|
| 1 | `getRegistryActionLogHeadSeq` | t+1 | `[FILL]` | `[FILL]` | `[✓]` |
| 2 | `claimSplit` | t+1 | `[FILL]` | `[FILL]` | `[✓]` |
| 3 | `execMultisigOp` | t+1 | `[FILL]` | `[FILL]` | `[✓]` |
| 4 | `redeem` | t+2 | `[FILL]` | `[FILL]` | `[✓]` |
| 5 | `mirrorActionLogRoot` | t+2 | `[FILL]` | `[FILL]` | `[✓]` |
| 6 | `mirrorRetireLane` | t+3 | `[FILL]` | `[FILL]` | `[✓]` |
| 7 | `execOwnerOp` | t+3 | `[FILL]` | `[FILL]` | `[✓]` |
| 8 | `manualReissue` | t+3 | `[FILL]` | `[FILL]` | `[✓]` |
| 9 | `resolveLanesMirror` | t+3 | `[FILL]` | `[FILL]` | `[✓]` |
| 10 | `isLaneActiveMirror` | t+3 | `[FILL]` | `[FILL]` | `[✓]` |

**Halt condition:** if any row's verification fails, freeze rollout, investigate root cause before advancing. `verify-ceremony-state.mjs` compares deployment.json.circuitsRolledIn to on-chain `contractState.operation(circuitId)` and must return ALL CHECKS PASSED.

**Expected final state after row 10 verified:** on-chain 18 DEFINED / 0 UNDEFINED. Matches the rehearsed end-state at `10158a54...ae474f`.

---

## Sign-off block

**All values above verified by the signers present.**

Signature by each admin signer (5 total, threshold 3):

- [ ] Signer 1 (real Tangem ring): `[FILL: signature of the sha256 of this manifest file]`
- [ ] Signer 2 (pilot-mock A): `[FILL]`
- [ ] Signer 3 (pilot-mock B): `[FILL]`
- [ ] Signer 4 (pilot-mock C): `[FILL]`
- [ ] Signer 5 (pilot-mock D): `[FILL]`

**Ceremony ID recorded on chain via first tx memo (informational):** `t0-preview-2026-08-02`

---

## Post-ceremony immediate actions

1. **Copy this filled manifest** to `PollPower/contracts` repo at `ebt/ceremony-artifacts/t0-preview-2026-08-02-preflight-manifest.md`, commit + push. This is the durable record.
2. **Copy the sha256 + signatures** to a sealed off-repo location (e.g., an encrypted note in Garrett's ClawdBrain).
3. **Enable pm2 daemon** with the finalized `EBT_V8_ADDRESS` env value (from step 2 deployment) — see the "Post-merge todo" section of `PollPower/settlement-api#8`.
4. **Run `verify-hash-shape.ts`** if any lane/schedule/retune registrations happened during ceremony (empty log = defer).
5. **Run vk-insert rollout** on t+1..t+3 per schedule above; verify after each insert.
6. Update `MEMORY.md` "EBT v8" landmark with the deployed address and initialize confirmation.

---

*Template drafted 2026-07-29 22:35 JST; updated 2026-07-30 00:45 JST to reflect ceremony-fence approach with full vk-insert rehearsal completed at Preview addr `10158a54...ae474f`. Fill in ceremony room; do not pre-fill sensitive values (escrow attestor privkey, signatures) in the repo copy.*
