# EBT reads the TariffRegistry root on chain (registry-root anchor)

Status: **designed, not implemented.** Scheduled after the Nov 30 submission
and before any Preprod deploy (Preprod gate, Garrett 2026-11-25). Closes
REVIEW.md trust assumption #5.

## Problem

EBT never calls the TariffRegistry. It keeps a mirror of the registry's
action-log Merkle root (`_registryActionLogRootMirror`), and every mirrored
item (class split, schedule lifecycle, statutory lane) is proven against that
root by Merkle path (`verifyEventProof`), monotonically (WI16-E-2, E-3).

The root itself comes from two places, both chosen by a person:

- the **constructor** argument `registryActionLogRoot` (the deployer picks it);
- **`mirrorActionLogRoot`**, gated by the owner's Jubjub signature. Its
  Merkle-path argument only checks that the new root is internally
  well-formed, not that it is the registry's root (comment above the circuit
  in `ebt/ebt-v8.compact`).

So a stolen owner key can install a root of its own making, then mirror a
forged lane whose `remitAddress` is the attacker's, and every later settle
mints the statutory slice there (settles still need a council-registered chip
and the meter authority's countersignature, so the attacker gets the slice of
honest settles, not free mints). A forged class split could likewise shift
shares between the producer, operations, DAO and dividend (their recipients
are fixed in EBT, so it changes amounts, not destinations).

## Fix

EBT reads the root from the TariffRegistry itself, through a ledger 9
cross-contract call, the same pattern as LD v3 → EBT `dividendAccrued()`
(proven on the local devnet 2026-11-24). No person supplies a root any more.

This is possible because **the TariffRegistry is not deployed yet**: it can
still gain the view circuit, and EBT can be built with a sealed reference to
it. Once both are deployed and locked, this change would need a new version
of each plus a migration.

### TariffRegistry

New witness-free view circuit (a circuit reached through a cross-contract call
may not call witnesses):

```compact
// Witness-free; read by EBT through a cross-contract call.
export circuit actionLogAnchor(): ActionLogAnchor {
  assert(_actionLogBootstrapCursor == ACTION_LOG_DEPTH, "ACTION_LOG_NOT_BOOTSTRAPPED");
  return ActionLogAnchor { root: registryActionLogRoot, count: _actionSeq };
}
```

- `count` is the number of entries appended (`_actionSeq`), so the latest
  entry is `count - 1`; the exact type and read of the `Counter` are settled
  when it is written.
- Refused until the sharded bootstrap is finished, so EBT can never anchor to
  a half-initialised tree.
- In the **TariffRegistry ceremony set**, because EBT's staged deploy needs it
  before EBT's own mirrors run.

### EBT

```compact
contract TariffRegistryAnchor {
  circuit actionLogAnchor(): ActionLogAnchor;
}
export sealed ledger _registry: TariffRegistryAnchor;   // constructor

// Permissionless: copies the registry's real state; nobody chooses the root.
export circuit syncRegistryRoot(): [] {
  const a = _registry.actionLogAnchor();
  assert(a.count >= _registryActionLogCountMirror, "REGISTRY_ROOT_REGRESSED");
  _registryActionLogRootMirror = a.root;
  _registryActionLogCountMirror = a.count;
}
```

- **Constructor:** the `registryActionLogRoot` argument is replaced by the
  registry's contract address (sealed `_registry`). The root mirror starts
  empty; the first `syncRegistryRoot` fills it. Deploy order is unchanged
  (council → TariffRegistry → EBT → LD).
- **Removed:** `mirrorActionLogRoot` and `ownerDigest_mirrorActionLogRoot`.
  No circuit accepts a caller-chosen root.
- **`mirrorActionLogHead`:** the head can now come from the anchor's count, so
  this circuit can go too (decide while writing the tests: keep it only if
  the lane freshness check (`LANE_MIRROR_STALE`) needs a head that lags the
  root).
- `syncRegistryRoot` is in the **EBT ceremony set** (mirrors run during the
  staged deploy).
- Permissionless is safe: the call only copies the registry's state, and the
  registry's log is append-only, so the root only moves forward; the
  regression assert is belt and braces. Anyone can make EBT catch up with the
  registry, which is the point; it can make an old lane mirror stale, but
  only because the registry really did change.

### What stays trusted

Nothing chooses the root. The registry's own content is council-governed
(approvals through Multisig v8 for federation actions, Jubjub-signed validator
and operator for schedules and retunes), which is the trust we intend.

## Attack tests (written first, failing on the current build)

New file `tests/contract/registry-anchor.test.mjs`, on the in-memory world
(`tests/contract/settle-world.mjs`), with a real TariffRegistry and EBT:

| ID | Test |
|---|---|
| RA-1 (negative, PoC) | Owner key installs a forged root containing an attacker lane, mirrors the lane and a settle pays the attacker. Passes on the current build (the PoC); on the new build no circuit takes a root, and the same forged lane cannot be mirrored. |
| RA-2 (negative) | A forged root via the constructor: EBT deploys with a registry reference, not a root; the first sync installs the registry's real root. |
| RA-3 (negative) | A look-alike registry (fixture with the same interface, attacker-deployed) is never read: `_registry` is sealed; EBT bound to the real registry ignores it. |
| RA-4 (negative) | A lane or class entry that is not in the registry's log cannot be mirrored after a sync (Merkle proof against the real root). |
| RA-5 (negative) | Root regression: a fixture registry whose count goes backwards is refused (`REGISTRY_ROOT_REGRESSED`). |
| RA-6 (negative) | Before the registry's bootstrap completes, the anchor read and the sync fail. |
| RA-7 | After a council-approved registry change (new lane, retune), sync → re-mirror → settle pays the new split; before the sync, settle is held by the freshness rules. |
| RA-8 | The view circuit is witness-free; `mirrorActionLogRoot` and the owner digest are gone from EBT's exports. |

Existing tests to update: `c2-owner-schnorr` (owner-circuit table),
`ld3-ebt-side` and `statutory-lane` (they install roots with the owner key),
`h1-constructor-init` (constructor argument), `settle-world` and parity
`EBT-*` where the constructor or root path appears. The JS mirror suites under
`ebt/tests/vnext/` (T16, T18, T19, T21) model the old root path: update or
retire them.

## Tooling

- `tooling/deploy/deploy-suite.mjs` and `preprod-ceremony.mjs`: EBT
  constructor takes the registry address; ceremony sets gain
  `actionLogAnchor` (TR) and `syncRegistryRoot` (EBT); call `syncRegistryRoot`
  before the first mirrors.
- `tooling/deploy/finalize.mjs` manifests: new operation sets for both
  contracts.
- `tooling/devnet/stack.mjs`: sync after every registry change; new step in
  the run: a registry change **after** EBT is deployed (today the lane is
  registered before EBT deploys), then sync, re-mirror and settle; an
  `attacks` case showing no root can be installed by any key.
- `tooling/settle/settle-plan.mjs` (used by pp-settle-service): if the
  registry's count is ahead of EBT's mirror, sync and re-mirror before
  planning a settle, or refuse with a clear error (decide with the service
  owner).
- Old Preview-era rollout scripts (`ebt/rollout/insert-vk-mirrorActionLogRoot.mjs`
  and the `ebt/settle-flow/ceremony.mjs` root path) are superseded; mark them.

## Build, sizes, docs

- Full ZK rebuild of TariffRegistry and EBT; re-measure deploy sizes with
  `tooling/measure/measure-deploy-cost-l9.mjs`. Expected: EBT's key count
  stays about the same (−1 or −2 removed circuits, +1 sync); TariffRegistry
  gains one key (~5% of a block per insert; its staged deploy is at 32.1%, and
  the anchor joins the ceremony set). To be measured, not assumed.
- Proof cost: one extra callee proof per **sync**, not per settle.
- Docs: REVIEW.md #5 (to "fixed"), `docs/findings-status.md`,
  `docs/STATUS.md`, this design.
- Cross-app: EBT's constructor ABI and the TariffRegistry's interface change.
  Record in CROSS-APP-CONTRACTS when implemented (notify Joi then).

## Fresh devnet pass

Required: both builds change, and the Preprod ceremony refuses builds or deploy
code that differ from a passing record. The pass must include the new
post-deploy registry change → sync → settle step.

## Estimate

About **3 dev-days** plus a fresh pass:

| Part | Effort |
|---|---|
| Contract changes (TR view circuit, EBT sync, constructor, removals; both ceremony variants) | 0.5 d |
| Attack tests RA-1..RA-8 first, then updates to existing suites | 1 d |
| Tooling (deploy suite, ceremony, finalize manifests, devnet stage, settle plan) | 1 d |
| Full ZK builds, sizes, docs | 0.5 d |
| Fresh devnet pass | ~0.5 d elapsed |
