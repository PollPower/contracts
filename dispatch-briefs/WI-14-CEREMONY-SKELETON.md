# WI-14 EBT vNext — Deploy Ceremony Skeleton

**Purpose:** the ceremony plan is a MANDATORY deliverable for WI-14
(per `WI-14-EBT-vNext.md` DELIVERABLE §7 and ACCEPTANCE §7). The
executing session's job is to fill this skeleton against then-current
repo state; **it is NOT the executing session's job to invent the
ceremony structure.** That happens here, in the supervising session,
before dispatch — otherwise the ceremony becomes emergent, which is
the wrong operational posture for settlement contract code.

**Status:** skeleton only. All specifics TODO by Garrett + supervising
session at ceremony-plan time. NO CEREMONY WITHOUT WRITTEN PLAN + GARRETT
SIGN-OFF.

**Referenced by:** `WI-14-EBT-vNext.md` DELIVERABLE §7 / ACCEPTANCE §7.

---

## 0. Ceremony prerequisites (must all be true before day-of)

- [ ] WI-13 (TariffRegistry v1) landed on `main` as DEV DRAFT,
  compile-clean, tests green. Deploy or DEV-DRAFT-stable
  (supervising-session decision).
- [ ] WI-14 EBT vNext contract landed on `main` as DEV DRAFT,
  compile-clean, all 12+ tests green.
- [ ] Two independent BIG passes (§5.1 💰 row) completed with written
  sign-off. No shared context between the two passes.
- [ ] Migration story (`ebt/VNEXT-MIGRATION.md`) reviewed by Garrett.
  Explicit decision: does vNext supersede v7.4.2 in pilot, or deploy in
  parallel post-pilot? Recorded, not ad-hoc.
- [ ] Calibration values from `CALIBRATION-DECISIONS-RESOLVED-*.md`
  plumbed into the contract as named constants (CAL-1, CAL-2, CAL-11
  at minimum). No `TODO(calibration)` left in the deploy artifact.
- [ ] EBT-H-1 mint-redirection fix (I-14-A) verified against source by
  a reviewer who *did not write it* — this is the load-bearing bug fix
  and warrants a specific spot-check.
- [ ] Ceremony plan (this document, filled) reviewed by Garrett with
  at least 24h to sleep on it before day-of.
- [ ] Full-ZK compile transcript reproduced in a clean checkout by a
  reviewer who is not the executing session — the "does the artifact
  compile from source alone" check.
- [ ] Rollback posture written and rehearsed (§4 below).
- [ ] Announcement text to pilot participants drafted, reviewed by
  Garrett — pilot invariants (I-1, I-2) unchanged, no behavior change
  visible to end users if migration is parallel; if migration is
  in-place, explicit user-facing communication.

---

## 1. Keyholders and roles (TODO fill at ceremony-plan time)

| Role | Person | Key held | Backup |
|------|--------|----------|--------|
| Deployer | TODO | Midnight deploy key | TODO |
| Operator attestor (authority pubkey rotation, if needed) | TODO | Attestation authority signing key | TODO |
| LD-pool 3-of-5 Shamir holders | Garrett + TODO×4 | Shamir shares (per Session 3 setup) | — |
| Multisig v7 3-of-5 approvers (for any charter-touching setup) | TODO | Ed25519 signing keys | — |
| Independent observer | TODO | none (audit role) | — |

**Minimum quorum for ceremony to proceed:**
- Deploy: deployer alone can push contract, but any state-touching
  post-deploy step requires named quorums below.
- Any registry cross-ref: 3-of-5 multisig sign-off.
- Any live LD-pool touch: 3-of-5 Shamir reconstruction (Session 3
  discipline).

---

## 2. Order of operations (day-of)

Written top-to-bottom, no skipping, no re-ordering. Each step names its
verifier and its abort trigger.

1. **Pre-flight (T-60 minutes)**
   - Independent observer re-runs full-ZK compile in a clean checkout
     from the tagged commit. If hash doesn't match the reviewed one:
     **ABORT.**
   - All keyholders confirm reachability (chat check-in). If any
     required keyholder is unreachable: **ABORT.**
   - Sanity-check network conditions: Midnight node in sync, DUST
     budget available, no ongoing incidents. If any red: **ABORT.**

2. **Deploy the WI-14 contract (T-0)**
   - Deployer submits deploy tx.
   - Independent observer confirms the deploy address on-chain.
   - Deploy hash recorded in `ebt/VNEXT-DEPLOYMENT.public.json` (new
     file, PR after ceremony).

3. **Post-deploy sanity checks (T+15)**
   - Ledger constructor state matches expected initial values.
   - Read-only `resolvePath` view returns expected splits against a
     fixture schedule (registered in WI-13 already, or registered as
     part of this ceremony — see step 4).
   - EBT-H-1 fix confirmed at runtime: an attempted settle with a
     mismatched producerAddr on a known-good HAT tuple **fails**. This
     is the load-bearing runtime check.

4. **Registry cross-ref (if migration = in-place; T+30)**
   - WI-13 registry updated to point pilot schedule at vNext contract
     address. 3-of-5 multisig approval required for this step. If
     unavailable: **DELAY** to a later ceremony window; do not proceed.
   - If migration = parallel post-pilot: skip this step; vNext runs on
     a separate deploy lane.

5. **Live smoke (T+60)**
   - Two settle transactions on the tagged pilot fixtures (small
     amount, known operators). Both must:
     - Mint the expected splits.
     - Fire the LD `_dividendMintedLog` event with the correct
       contract-scope filter shape (Session 9 fix inherited).
     - Route any statutory-lane amount to the configured
       `remitAddress` (I-14-D).
   - If any smoke tx behaves off-spec: **ROLLBACK** per §4.

6. **Live redemption smoke (T+90)**
   - One KES redemption on a coin minted in step 5. Trust float
     release matches the coin's `fiatValueAtMint` (D-10 per-coin).
   - One KWH redemption on a sibling coin. kWh delivery path fires.
   - Solvency invariant (D-8) checked before and after each redeem.
     If violated at any point: **ROLLBACK.**

7. **Announcement + memory (T+120)**
   - Announcement to pilot participants (per prerequisite bullet).
   - Ceremony memory file written at
     `workspace/memory/YYYY-MM-DD-wi14-ceremony.md`.
   - `FEDERATION-IMPLEMENTATION-PLAN.md` §6 tracker updated to
     ✓ deployed with the deploy hash.
   - This document archived to
     `ebt/ceremonies/YYYY-MM-DD-vnext-deploy/`.

---

## 3. Test transactions (fixtures)

**Fixture inventory to prepare BEFORE ceremony day:**
- One canonical operator (pilot-mock keys, already registered in
  ProducerRegistry v1).
- One canonical consumer (pilot-mock KYC, LD-registered, at prove-in).
- One canonical schedule registered in WI-13 with concrete floors
  (from CAL-1) and one statutory lane with concrete `remitAddress`
  (from CAL-11).
- Amounts small enough to be trivially reversible in the pilot budget
  if rollback fires.

---

## 4. Rollback posture

**Rollback trigger conditions (any one triggers immediate rollback
consideration):**
- Post-deploy sanity check (§2.3) shows unexpected ledger state.
- Live smoke (§2.5) mints wrong splits, misses statutory routing, or
  fails to fire LD event correctly.
- Redemption smoke (§2.6) violates D-8 solvency invariant at any
  point.
- Any observer flags an on-chain behavior not matching the reviewed
  spec.
- Any keyholder loses network reachability during the ceremony window.

**Rollback procedure (parallel-deploy migration):**
1. Do NOT update WI-13 registry to point at vNext (step 4 skipped).
2. vNext contract remains deployed but unused. It's a research
   artifact, per the pattern already established with EBT v5.1/v5.2.
3. Write incident memory file. Reconvene supervising session for
   diagnosis before next attempt.

**Rollback procedure (in-place migration):**
1. Multisig 3-of-5 approval: revert WI-13 registry pointer to v7.4.2
   address.
2. Any coins minted on vNext during the failed ceremony window are
   reconciled per the migration doc (VNEXT-MIGRATION.md must
   pre-specify this — DO NOT INVENT DURING ROLLBACK).
3. Announcement to pilot participants: brief, factual, no blame.
4. Incident memory file.

**Rollback authority:** Garrett or supervising session may call
rollback at any point in §2 through the announcement in §2.7. No
justification required in the moment; postmortem after.

---

## 5. What this ceremony is NOT

- Not the moment to change any invariant.
- Not the moment to resolve any CAL-n value.
- Not the moment to add "just one more" test — if it wasn't in the
  reviewed diff, it's not in the ceremony.
- Not the moment to fix a bug found day-of. Any bug found day-of →
  ABORT + fix + re-ceremony.

---

## 6. Post-ceremony (T+24h and T+7d)

- **T+24h:** first day's mint/redeem volume reviewed. LD
  `_dividendMintedLog` shape sanity check. No off-spec events.
- **T+7d:** week's data reviewed. Session-8-class bug hunt: any
  contract-scope filter issue, phantom accumulator growth, sequel
  bugs from the batch-payer/keeper stack? If clean: ceremony
  considered *complete*, not just *executed*.
- **T+30d:** first-month operational review. Migration status
  documented. Any latent behavior found → planned in-place fix, not
  emergency deploy.

---

## 7. One paragraph for Garrett before the day

This is the ceremony that promotes vNext from DEV DRAFT to a contract
that touches money. Every guardrail above exists because a failure at
this step is not recoverable by "trying again next week" — it is
recoverable only by having *pre-committed* to abort criteria, rollback
posture, and a specific reviewer topology that catches bugs the writing
session couldn't. If you find yourself, on ceremony day, wanting to
skip a step "because we already verified that," that is the moment to
reread §5.4 of the plan and re-verify. This document exists to make
your day-of decisions boring. Boring is the goal.

---

*Skeleton authored 2026-07-14 by supervising session, per WI-14 brief
ACCEPTANCE §7. All TODOs filled by Garrett + supervising session at
ceremony-plan time, before dispatch of WI-14 to an executing session.*
