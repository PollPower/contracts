# TariffRegistry monolith — ceremony-fenced deploy path

**Status:** deployed live on Preview 2026-07-31 → 2026-08-01. 18/18 circuits DEFINED.
**Address:** `556fe46f8dfd5234e97974bfd8b455ef4ea8c785641d80a4d7c12530a3776dd9`

## Why this variant exists

The WI-15.1 5-sibling split (`tariff-audit` / `tariff-governance` /
`tariff-schedule` / `tariff-lane` / `tariff-views` — landed via PRs #66/#67)
was designed to fit the TariffRegistry inside Midnight Preview's per-block
weight limit by trading a monolithic circuit surface for a set of smaller
cross-referencing contracts. It shipped and deploys cleanly.

Between 2026-07-30 and 2026-07-31, running the split against live pilot
data surfaced two operational costs:

1. **Charter-membership mirror bug** (`SCHEDULE_UNCHARTERED_NODE`). The
   `schedule` and `lane` siblings' `assertCharterMembership` reads
   `_governanceRoot`, which on both siblings was initialised to
   `pad(32, "")` and never written. `mirrorGovernanceRoot` was designed to
   populate a separate `_mirroredGovernanceRoot` slot but the reader still
   pointed at the empty local slot. See
   `scratch/PR-BODY-fix-charter-membership.md` (in the workspace, not this
   repo) for the full autopsy — the fix ("Option 4: seal
   `_mirroredGovernanceRoot` at genesis") was drafted but never landed.
2. **Multi-sibling ceremony coordination cost.** The split's registerSchedule
   / registerLane path spans multiple contracts holding cross-referencing
   state. Every deploy is 5 addresses; every pilot-tariff population is 5
   contexts. For a single-operator pilot this is friction without value.

Rather than land Option 4 into the split, we asked whether the original
monolith `tariff-registry-v1.compact` could be deployed instead using the
same **ceremony-fence + post-deploy vk-insert** pattern that landed EBT v8
on 2026-07-30 (PR #68). Answer: yes. This document describes that path.

## The pattern (identical to EBT v8, PR #68)

Preview's per-block weight limit rejects a deploy transaction that includes
verifier keys for all 18 circuits at once. The ceremony-fence pattern
splits the deploy:

1. **KEEP set** — 7 circuits compiled fully. These are the *initial working
   set* needed for schedule + lane registration. Their verifier keys land
   in the deploy transaction.
2. **DEFER set** — 11 circuits compiled to empty stubs (`{ }` for
   `[]`-returning, structural-zero returns for value-returning). No prover
   or verifier size in the deploy transaction.
3. **Post-deploy rollout** — for each DEFER circuit, run a single
   `submitInsertVerifierKeyTx` maintenance transaction that reads the
   verifier bytes from the FULL build (compiled from the un-fenced source)
   and inserts them at the deployed address.

The ceremony-fenced source `tariff-registry-v1-ceremony.compact` is a
mechanical stub of the full `tariff-registry-v1.compact`: same header,
same ledger schema, same struct definitions, same witnesses, same KEEP
circuit bodies. Only the DEFER circuit bodies are replaced with stubs.
No behavior change and no ABI change for the KEEP circuits. No new attack
surface — DEFER stubs return zero-value defaults, so pre-rollout calls
against DEFER surfaces are provably inert on chain (KEEP does not read
their outputs).

**Why the monolith form doesn't hit the charter bug:** in the monolith,
`_governanceRoot` is the same slot on the same contract for both
`assertCharterMembership` (reader) and `advanceEpoch` (writer, called
implicitly at construction time via `initialGovernanceRoot`). No mirror
slot, no split-across-siblings write path, no "populate before use"
requirement. `registerSchedule` and `registerLane` pass charter checks by
construction, against the same live governance root the constructor
sealed.

## Circuit split

| Set | Count | Circuits |
|-----|-------|----------|
| KEEP | 7 | `bootstrapActionLog`, `advanceEpoch`, `registerSchedule`, `registerLane`, `isChartered`, `getActionEntry`, `getActionPayloadHash` |
| DEFER | 11 | `retireSchedule`, `setNationalContext`, `setFederationAuthority`, `retireLane`, `retuneClass`, `resolvePath`, `resolveCurrent`, `isScheduleActive`, `resolveLane`, `resolveLanes`, `isLaneActive` |

KEEP is the minimum surface to bootstrap the schedule + register the four
pilot lanes (producer / ops / dividend / statutory). Everything else — rate
retunes, lane retirements, active-status views, resolvers — DEFERs and
gets rolled in after deploy.

## Reproducing the deploy

Prerequisites: kenya at `~/contracts/tariff-registry/` with `node_modules`
populated; wallet seed in `deployment.json`; Compact 0.30.0 build outputs
under `build/` (full) and `build-ceremony/` (fenced).

```
# 1. Deploy the ceremony fence
node deploy/deploy-tariff-registry-monolith-ceremony.mjs

# 2. Roll each DEFER circuit in one at a time (order-independent; halt on failure)
for c in retireSchedule setNationalContext setFederationAuthority \
         retireLane retuneClass resolvePath resolveCurrent \
         isScheduleActive resolveLane resolveLanes isLaneActive
do
  node rollout/insert-vk-${c}.mjs || break
done

# 3. Verify final state
node deploy/verify-monolith-ceremony-deploy.mjs

# 4. Populate the pilot tariff (registerSchedule + 4 registerLanes)
node populate-pilot-tariff-monolith.mjs
```

Each vk-insert lands in ~20–25 seconds. Total post-deploy rollout time
across 11 inserts is ~5–6 minutes of wall time; the whole ceremony
(deploy + rollout + populate) is ~15 minutes on Preview.

## Live-deploy evidence (2026-07-31 → 2026-08-01)

All artifacts under `deploy/artifacts/`:

- **Deploy** — `monolith-preview-2026-07-31T16-27-30.json`
  Address `556fe46f…`; 7 KEEP circuits landed at deploy time.
- **Rollout** — 11× `vk-insert-monolith-<circuit>-*.json` + full
  `rollout-monolith-2026-07-31T16-30-51Z.log`
  10 of 11 inserts landed cleanly on the first pass. `isLaneActive`
  aborted at 5.8s with `1010: Invalid Transaction: Custom error: 170`
  (submission-time reject, transient — same failure class as
  `manualReissue` in the EBT v8 rollout). Clean retry at 2026-08-01
  00:30 UTC landed at 21.6s.
- **Populate** — `pilot-tariff-monolith-2026-08-01T01-24-27-440Z.json`
  Schedule id `0a0ca2e4…`; 4 lanes registered (producer / ops / dividend
  / statutory); `bpsSum = 10000`. See MEMORY.md pilot-tariff entry for
  the KPLC DC2 parity numbers.

## Retry semantics for custom error 170

Both the EBT v8 rollout (2026-07-30) and the TariffRegistry monolith
rollout (2026-07-31 → 2026-08-01) saw one circuit each halt at
`1010: Invalid Transaction: Custom error: 170` inside 6 seconds of
submission. In both cases:

- The failure came pre-inclusion (the tx was rejected by the submitter
  service before it could be mined). No on-chain state change.
- A clean retry a few minutes later succeeded on the first try, landing
  at the normal 20–25s tx-elapsed profile.
- The rollout guards this by halting immediately on any per-circuit
  failure so an operator can decide whether to retry or investigate. Do
  NOT auto-retry blind; if the second attempt also fails, stop and
  diagnose.

## What's NOT in this PR

- The Option 4 charter-membership fix for the v2 split
  (`fix/wi15.1-charter-membership-mirror-slot`) is superseded and not
  landed. The split remains available in the repo as a reference
  implementation; monolith-ceremony is the pilot deployment path.
- The `tariff-registry-v1-ceremony.compact` source is a mechanical fence
  of `tariff-registry-v1.compact`. There is no functional divergence.
  When the DEFER circuits' full behavior is needed post-launch, they roll
  in from the SAME full-build verifier keys — no source-code re-review
  required, since the un-fenced source is what was audited pre-fence.

## Traceability

- PR #66 (2026-07-29) — WI-15.1 5-sibling split live on Preview
  (aggressive Lane shrink to fit block-limit)
- PR #67 (2026-07-29) — V2-SPLIT-DESIGN.md marked IMPLEMENTED
- PR #68 (2026-07-30) — EBT v8 ceremony-fence + post-deploy vk-insert
  pattern (this monolith uses the same pattern)
- Live deploy: 2026-07-31 16:27 UTC (deploy) → 2026-08-01 00:30 UTC
  (rollout complete) → 2026-08-01 01:24 UTC (pilot tariff populated)
