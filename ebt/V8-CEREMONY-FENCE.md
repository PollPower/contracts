# V8-CEREMONY-FENCE.md

**Contract:** `PollPower/contracts` → `ebt/`
**Author:** Joi
**Date drafted:** Wed 2026-07-29
**Target ceremony:** Sun 2026-08-02 ~14:00 JST
**Status:** DRAFT (ceremony pre-flight; not yet applied)

---

## Summary

EBT v8, as designed and compiled from `ebt-v8.compact` (1364 lines, 18
exported circuits), **cannot deploy on Midnight Preview in a single
transaction** because its 18-circuit verifier-key bundle exceeds the
per-tx weight limit. On 2026-07-29 evening, four deploy attempts
against Preview failed with `1010: Invalid Transaction: Transaction
would exhaust the block limits`.

To keep the Sun 2026-08-02 ceremony on the calendar, this document
specifies a **ceremony-fenced subset** of v8: a 927-line source
(`ebt-v8-ceremony.compact`) that compiles to **8 exported circuits**,
comfortably below Preview's block-limit budget (validated on
2026-07-29 by the tariff-registry deploys — views: 10 circuits, 21 KB;
Lane: 1 circuit; both cleared).

The 10 deferred circuits are added post-ceremony via
`submitInsertVerifierKeyTx` maintenance transactions — one circuit
per tx, spread over days t+1 through t+3.

---

## Fencing decision: 8 kept, 10 deferred

### Kept (in `ebt-v8-ceremony.compact`)

| # | Circuit | Verifier size | Reason kept |
|---|---|---|---|
| 1 | `initialize` | 1,351 B | Ceremony step 4 literally calls this. |
| 2 | `attestProducerOwnership` | 2,119 B | Ceremony step 3 — pilot producer must be attested before settle. |
| 3 | `revokeProducerOwnership` | 2,119 B | Ceremony bookend — demonstrates revocation path. |
| 4 | `mirrorActionLogHead` | 2,119 B | Required by `settle` to satisfy `LANE_MIRROR_STALE`. |
| 5 | `mirrorScheduleLifecycle` | 2,119 B | Required by `settle` to satisfy `SCHEDULE_NOT_LIVE`. |
| 6 | `mirrorClassStatutoryTotal` | 2,119 B | Required by `settle` to satisfy `CLASS_NOT_LIVE`. |
| 7 | `mirrorRegisterLane` | 2,119 B | Required by `settle` — at least one lane must exist in `_registeredLanesMirror`. |
| 8 | `settle` | 2,119 B | The core money circuit. The ceremony's proof of settlement. |

**Total verifier bytes:** ~15.2 KB. Below views' 21 KB baseline.

### Deferred (added post-ceremony via vk-insert)

| # | Circuit | Rollout day | Reason deferred |
|---|---|---|---|
| 1 | `mirrorActionLogRoot` | t+1 | Root advance mid-flight. Not needed for single ceremony settle. |
| 2 | `mirrorRetireLane` | t+1 | Lane retirement. Not exercised in ceremony. |
| 3 | `execOwnerOp` | t+1 | Owner-signed ops (meter-authority rotation, misc). Initial keys are set in `initialize`; rotation is post-ceremony ops. |
| 4 | `claimSplit` | t+2 | Ops/div/dao slice mint. Only meaningful after `settle` accumulates pending. Post-ceremony rehearsal step. |
| 5 | `execMultisigOp` | t+2 | Multisig-gated LD binding + attestor rotation. LD binding wasn't the ceremony's job on day 1. |
| 6 | `redeem` | t+3 | Producer end-of-flow redemption. Needs escrow-attestor state we won't touch on day 1. |
| 7 | `manualReissue` | t+3 | Emergency reissuance. Never exercised in normal flow. |
| 8 | `resolveLanesMirror` | t+3 | Read-only view. |
| 9 | `isLaneActiveMirror` | t+3 | Read-only view. |
| 10 | `getRegistryActionLogHeadSeq` | t+3 | Read-only view. **Smoke-test target** (smallest verifier at 1,351 B, no state deps). |

**Total deferred verifier bytes:** ~20 KB (spread over 10 txs).

---

## Prerequisite verification (done 2026-07-29)

Before adopting this fence, I confirmed that **no KEPT circuit calls any
DEFERRED circuit**. Cross-reference scan:

- All 8 KEEP circuit bodies extracted by brace-balance.
- For each, grepped body for `\b<DEFER>\s*\(` — zero hits across all 8.
- Reverse check: each DEFER circuit's "callers" grep returned only its
  own definition line and (for `claimSplit`, `redeem`, `mirrorRetireLane`)
  a **single comment** mentioning the name in prose. No actual calls.

Scan artifacts preserved at `workspace/scratch/ebt-v8-crossref-scan.sh`
and `workspace/scratch/ebt-v8-defer-callers.sh`.

## Source-edit method

`compactc` version 0.30.0 does **not** expose a `--only-circuits` /
`--exclude-circuits` flag (confirmed via `--help` inspection on
2026-07-29). Ceremony source is built by deleting the 10 deferred
circuit bodies from `ebt-v8.compact`, preserving their comment blocks
in a git commit for audit trail, then compiling the result.

Deletion tool: `workspace/scratch/build-ebt-v8-ceremony.sh` (idempotent
Python edit, deletes bottom-up so line numbers stay stable).

## Post-ceremony vk-insert rollout schedule

Each `submitInsertVerifierKeyTx` call:
- Reads the target `.verifier` file from `build/v8/keys/<circuitId>.verifier`
  (the full v8 build already compiled 2026-07-29 12:48–13:06 UTC).
- Calls the SDK function against the ceremony-deployed contract address.
- Recomputes signing key from `privateStateProvider` (same key that
  `deployContract` stored under the ceremony address).
- Writes an artifact manifest to `deploy-artifacts/vk-insert-<circuitId>-<stamp>.json`.

### Schedule

| Day | Batch | Rationale |
|---|---|---|
| **t+0 (ceremony)** | `ebt-v8-ceremony` deploy (8 circuits) + `initialize` + mirror-setup + `attestProducerOwnership` + `settle` + `revokeProducerOwnership` | Money proof end-to-end. |
| **t+1 Mon** | `mirrorActionLogRoot`, `mirrorRetireLane`, `execOwnerOp` | Governance surface. No user impact. |
| **t+2 Tue** | `claimSplit`, `execMultisigOp` | Protocol economics + LD binding. Rehearsal: run a mock claim + a mock LD bind. |
| **t+3 Wed** | `redeem`, `manualReissue`, `resolveLanesMirror`, `isLaneActiveMirror`, `getRegistryActionLogHeadSeq` | Redemption + read-only views. Rehearsal: run a redeem end-to-end. |

**Order rationale:**
- t+1 first — governance surface. Small, isolated, minimum surprise if anything goes wrong.
- t+2 next — protocol economics (mints slices, binds LD). Depends on `settle` state that ceremony populates.
- t+3 last — redemption + views. `redeem` reads state populated across t+0–t+2.

### Smoke test (Fri 2026-07-31 before ceremony)

Before day of ceremony, dry-run the vk-insert flow on Preview against
some existing test contract (or a small dedicated one), using
`getRegistryActionLogHeadSeq` as the target — it's the smallest
verifier (1,351 B) and has zero state dependencies. Confirms:

1. `submitInsertVerifierKeyTx` API works end-to-end against Preview.
2. Signing-key retrieval from `privateStateProvider` works.
3. The `.verifier` file byte layout is what the SDK expects.
4. Post-tx `contractState.operation(circuitId)` returns defined.

If the smoke test passes, we have high confidence the t+1..t+3 rollout
will work.

## Ordering invariant (audit trail)

Deferred circuits **must** be added in EXACTLY the schedule specified
above. If a mid-rollout tx fails, the failure is fixed before advancing
to the next circuit. This preserves the audit invariant: **"circuit X's
verifier key was inserted after circuit Y's verifier key,"** which
lets post-hoc audit findings be re-verified against each addition
point separately.

Each vk-insert also writes an artifact manifest containing the
contract address, circuit id, tx hash, and timestamp — the same
schema as ceremony deploy artifacts.

## Fallback ladder

- **A. Fenced deploy (this doc).** ~30–60 min work, deploys 8 circuits
  cleanly. **PRIMARY plan.**
- **B. If 8 circuits still exceed block limit** (unlikely — 8 < views' 10):
  drop to 7 by removing `revokeProducerOwnership`. Ceremony can
  demonstrate attest + settle only; revoke moves to t+1 batch.
- **C. If 7 also fails:** drop to 6 by removing `mirrorClassStatutoryTotal`
  and expecting settle to fail on `CLASS_NOT_LIVE`. Ceremony demonstrates
  attest + mirror-setup only, but not end-to-end settle.
- **D. Sibling-split.** Rewrite v8 as `ebt-core` + `ebt-mirror`
  (2 contracts, daemon-glued like tariff-registry). ~1–2 day cost,
  still fits before Sunday if we start Thursday morning.
- **E. Push ceremony week.** Last resort. Slips the pilot rehearsal
  schedule.

## Post-mortem: why we're doing this

- **v6→v7→v8 growth:** each v-bump added mirror circuits + audit
  remediation. v7 was probably right at the edge; v8's 18 circuits
  crossed it.
- **We built the full artifact anyway.** All 18 verifier keys and prover
  keys already exist on kenya (`build/v8/keys/`). No wasted work — the
  10 deferred circuits will use the same keys they were built with.
- **Contract upgrade path (`execMultisigOp` op-code changes) is NOT
  available for this rollout** because `execMultisigOp` itself is one
  of the deferred circuits. The Substrate-native
  `contractMaintenanceTx` route bypasses this bootstrap problem —
  vk-inserts are gated by the maintenance signing key from
  `initialize`, not by an on-contract multisig.
- **Precedent for aggressive fencing:** the tariff-registry Lane sibling
  was similarly shrunk on 2026-07-29 (F1–F4 fence, retains only
  `registerLane`) and deployed cleanly at 24.5s.

## Artifacts checklist (pre-ceremony)

Before day of ceremony, the following must be on kenya:

- [ ] `ebt-v8-ceremony.compact` (927 lines, 8 exports)
- [ ] `build/v8-ceremony/` full artifact (contract/, keys/, zkir/)
- [ ] `deploy-ebt-v8-ceremony.mjs`
- [ ] `deployment.json` with fresh seed and `contractAddress: null`
- [ ] `rollout/insert-vk-*.mjs` — 10 scripts, one per deferred circuit
- [ ] `deploy-artifacts/` directory ready to receive manifests
- [ ] Dry-run of `deploy-ebt-v8-ceremony.mjs` on Preview passed
- [ ] Smoke test of `submitInsertVerifierKeyTx` on Preview passed
- [ ] `V8-CEREMONY-FENCE.md` merged to `PollPower/contracts` main
