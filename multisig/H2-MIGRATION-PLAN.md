# H-2 Migration Plan: Retire Multisig v5 Self-Governance

**Audit finding:** H-2 (High) — Multisig v5's `addAdmin`, `removeAdmin`,
and `setThreshold` accept any single admin's call ("SIMPLIFICATION FOR
PILOT" per the source comments). A single compromised admin key can
mutate the admin set or threshold without threshold approval.

**Audit ref:** 2026-06-10 Fable 5 review, tag v10.0, commit c06191e
**Plan drafted:** 2026-06-12
**Status:** STAGED — not yet executed. Execution is a deploy-coordination
task requiring Garrett's green-light.

## Current state

| Contract | Address | Governance model | Status |
|----------|---------|------------------|--------|
| Multisig v5 | `182a7a8b…a2d8a7ce` | Single-admin self-governance (H-2 issue) | Deployed, production label |
| Multisig v6 | `f7192a50…62745c3a` | Nonce-bound threshold self-governance | Deployed, validated e2e |
| Multisig v6.1 | (not deployed) | v6 + M-2 domain separation + L-2 nonce-bound execute | Staged in this branch |

## Why v5 can't be patched

Compact contracts are immutable post-deploy. The v5 contract's
`addAdmin`/`removeAdmin`/`setThreshold` will accept single-admin calls
forever. The only mitigation is to stop treating v5 as authoritative.

## Migration steps

### Phase 1 — Documentation (can ship immediately)

1. [ ] Update `multisig/README.md`: change every reference to v5 as
   "production governance" to "DEPRECATED — audit ledger only, superseded
   by v6". State explicitly that v5's self-governance path has a known
   single-admin mutation issue (H-2) and MUST NOT be relied on.
2. [ ] Add a `DEPRECATED` banner comment to the top of `multisig-v5.compact`
   pointing at v6/v6.1.
3. [ ] Update White Paper v10.x references (Addendum sections covering
   governance) to describe v6 as the production multisig.

### Phase 2 — Operational cutover (requires coordination)

4. [ ] Confirm no operational tooling still submits to v5. Check:
   - settlement-api (Kenya): grep for the v5 contract address
   - admin app / proverWitness.ts (relay): grep for v5 address
   - Any cron jobs or scripts on relay/Kenya referencing v5
5. [ ] Point all governance audit-trail writes at v6 (or v6.1 once deployed).
6. [ ] Record a final "v5 retired" action in v5 itself (optional, for the
   public audit trail), then stop writing to it.

### Phase 3 — v6.1 deployment (separate ceremony)

7. [ ] Deploy multisig v6.1 with the same 5 pilot-mock admins, threshold 3,
   and a fresh contractTag (recommended:
   SHA-256("pollpower:multisig:v6.1:preview:2026-06-XX")).
8. [ ] Deploy ProducerRegistry v1.1 with its own contractTag.
9. [ ] Update admin tooling to sign domain-separated hashes
   (persistentHash([contractTag, actionHash])).
10. [ ] Re-validate 3-of-5 end-to-end on v6.1 (same test as v6 validation
    on 2026-05-08).
11. [ ] Migrate registry state: re-add approved meters to v1.1 via
    multi-sig flow (1 meter currently — low effort).
12. [ ] Update settlement-api RegistryGate to read v1.1's
    isMeterRegistered().

### Phase 4 — Tangem ring swap (H-1, pre-mainnet, separate ceremony)

13. [ ] Per producer-registry/STATUS.md: add real Tangem ring pubkeys to
    the v6.1/v1.1 admin sets via executeAddAdmin (threshold flow), then
    executeRemoveAdmin the pilot-mock keys, in that order.

## Decision points for Garrett

- **Deploy v6.1 now or fold into the Tangem ceremony?** Both deployments
  need fresh admin-tooling signatures. Doing v6.1 + v1.1 + Tangem rings
  in one ceremony halves the operational overhead but couples two risk
  surfaces. Recommend: v6.1/v1.1 first (validates domain separation with
  mock keys), Tangem swap second.
- **Should v5 get a final on-chain retirement marker?** Cheap to do,
  nice-to-have for public audit narrative.

## What this plan does NOT do

- Does not decommission the v5 contract (impossible — immutable).
- Does not change the EBT contract's owner model (that's the Cardano
  native multisig layer, separate workstream).
- Does not touch H-1 (pilot-mock keys) — that's the Tangem ceremony.
