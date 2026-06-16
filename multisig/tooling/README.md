# Multisig v6.2 off-chain tooling (staged)

H-3 remediation requires off-chain changes alongside the v6.2 contract, because
v6.2 changes the self-governance action preimages. These files are **staged for
the pre-mainnet hardening ceremony** — not yet wired into a live runner. See
[`../UNBOUNDED-ADMIN-FINDING.md`](../UNBOUNDED-ADMIN-FINDING.md).

## What changed in v6.2 (off-chain impact)

| | v6 | v6.2 |
|---|---|---|
| Add/remove op tag | `v6:addAdmin` / `v6:removeAdmin` | `v6.2:addAdmin` / `v6.2:removeAdmin` |
| Add/remove actionHash | 3-field `[opSel, pk, nonce]` | **4-field** `[opSel, pk, threshold, nonce]` |
| `executeAddAdmin` call | `executeAddAdmin(pk)` | `executeAddAdmin(pk, newThreshold)` |
| `executeRemoveAdmin` call | `executeRemoveAdmin(pk)` | `executeRemoveAdmin(pk, newThreshold)` |
| `executeSetThreshold` | `v6:setThreshold`, 3-field | `v6.2:setThreshold`, 3-field (tag only) |
| pre-flight check | none | strict-majority + cap, off-chain, before any tx |

The council now signs the **(admin, threshold) pair**, not just the admin. The
threshold must be a strict majority of the resulting set (`T*2 > N`) and the
set is capped at 7. The off-chain helper enforces both before proposing, so the
runner never submits an action the contract's guards would reject.

## Files

- **`v6.2-actionhash.ts`** — canonical actionHash construction for v6.2
  (Poseidon / persistentHash, matching the contract's in-circuit recompute).
  Exports `computeAdminSetActionHash`, `computeSetThresholdActionHash`, and the
  majority/cap helpers (`minMajorityThreshold`, `isValidThreshold`,
  `assertValidAdd`, `assertValidRemove`, `MAX_ADMINS`).
- **`v6.2-ceremony-template.ts`** — the v6.2 successor to the v6 ceremony
  runner (`swap-garrett-ring.ts`). Documents the exact diff in the ADD/REMOVE
  steps. Boilerplate (wallet/providers/witness/approval-casting) is copied from
  the proven v6 runner and elided here; only the v6.2-specific parts are shown.

## Two distinct actionHash schemes — do not confuse them

PollPower has **two** actionHash constructions for the multisig, for two
different governance paths:

1. **Generic governance** (settlement-authority changes, reissuance approvals,
   etc.) — driven by the **mobile admin app** via
   `apps/admin/services/actionHash.ts`. **SHA-256** string scheme,
   domain-separated by contract address (this is the M-2 mitigation — see
   [`../M2-MITIGATION-NOTE.md`](../M2-MITIGATION-NOTE.md)). Uses the generic
   `approve(actionHash)` + `execute(actionHash)` contract path.

2. **Admin-set self-governance** (`executeAddAdmin` / `executeRemoveAdmin` /
   `executeSetThreshold`) — driven by the **ceremony runner** on Kenya. The
   contract **recomputes a Poseidon `persistentHash`** in-circuit, so approvals
   must be keyed under that Poseidon hash. This is the scheme in
   `v6.2-actionhash.ts`.

The mobile admin app does **not** drive `executeAddAdmin` today (verified
2026-06-16: no `executeAddAdmin`/`persistentHash` references in `apps/admin`).
The admin-set ceremony is a deliberate, runner-driven operation. If admin-set
governance is ever moved into the app, it MUST adopt the v6.2 Poseidon scheme
here — the SHA-256 scheme will NOT aggregate approvals for the self-governance
execute path.

## Admin app `actionHash.ts` — staged note

The app's `DOMAIN_SEPARATOR` is still `'PollPowerMultiSig.v5'`. That is correct
for the generic path it serves (the version tag is part of the M-2 domain
separation and does not need to track the multisig contract version). No
functional change to the app is required for v6.2, because the app does not
drive admin-set governance. A clarifying comment has been added to
`apps/admin/services/actionHash.ts` pointing here, so a future maintainer who
adds admin-set governance to the app uses the right scheme.

## Deploy/ceremony checklist (H-3)

1. [ ] Full ZK compile of `multisig-v6.2-ed25519.compact` (Garrett green-light).
2. [ ] Deploy v6.2; record the address; set `EXPECTED_V62_ADDR` in the runner.
3. [ ] Drop `v6.2-actionhash.ts` + the finished runner into the settlement-api
       tree (alongside the existing v6 ceremony scripts) and fix the relative
       import to `src/utils.js`.
4. [ ] Re-validate add/remove (with atomic threshold) end-to-end against v6.2
       on Preview, the same way v6 was validated 2026-05-08.
5. [ ] Migrate the council to v6.2 + perform the H-1 Tangem ring swap on v6.2
       (add real rings, raise threshold to the new majority, remove mocks).
6. [ ] Point any operational tooling that reads multisig state at the v6.2
       address; deprecate v6 in the READMEs.
