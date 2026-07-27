# TariffRegistry v1 Preview Deploy Runbook

This runbook prepares and runs the Preview deploy from kenya.  
Do not run this from the Windows workstation.

## Prerequisites

- `compactc.bin` is installed and in `PATH` on kenya.
- SSH access to kenya is working.
- A fresh checkout of the contracts repo exists on kenya (default: `$HOME/contracts`).
- `deployment.json` with the deployer seed exists at `contracts/tariff-registry/deployment.json` on kenya.
- Node.js + npm are available on kenya.

## Pilot-mock disclosure (H-1 posture)

This Preview deploy uses deterministic public pilot seeds:

- `pp-tariff-pilot-seat-0`
- `pp-tariff-pilot-seat-1`
- `pp-tariff-pilot-seat-2`
- `pp-tariff-pilot-seat-3`
- `pp-tariff-pilot-seat-4`

The corresponding Ed25519 keys are publicly derivable and are Preview-only.

## Commands (kenya)

```bash
ssh kenya
# Clone contracts repo if not already present (deployment.json is gitignored).
if [ ! -d "$HOME/contracts" ]; then
  cd "$HOME"
  git clone git@github.com:PollPower/contracts.git contracts
fi
cd "$HOME/contracts"
git fetch origin
git checkout feat/wi14-tariff-registry-preview-deploy
git pull --ff-only

# Copy deployer wallet seed into place (reuses the same wallet that deployed
# EBT v5 and everything since; do NOT commit).
cp "$HOME/mn-dev/settlement-work/deployment.json" \
   "$HOME/contracts/tariff-registry/deployment.json"

cd tariff-registry
npm install
chmod +x deploy-preview.sh

# compactc needs zkir on PATH; deploy script needs the settlement-api utils.ts
# for wallet + provider setup.
export PATH="$HOME/.compact/versions/0.30.0/x86_64-unknown-linux-musl:$HOME/.compact/bin:$PATH"
export TARIFF_DEPLOY_UTILS="/opt/pollpower/settlement-api/src/utils.ts"

./deploy-preview.sh --repo "$HOME/contracts"
```

The compile step takes ~30 minutes on kenya-class hardware (17 circuits with
full ZK setup keys). Subsequent runs skip compile when `build/keys/` is
populated and the source SHA matches `build/.source-sha256`; pass
`--force-rebuild` to force recompile.

## Bootstrap shard sequence (WI-13.3, post-2026-07-27)

Under PR #44 (WI-13.3, merged 2026-07-27), the TariffRegistry
constructor no longer initializes the action-log empty tree. The
deploy script runs three sequential `bootstrapActionLog` calls after
`deployContract` and before the first `registerSchedule`:

1. `bootstrapActionLog(8n)`  — initializes empty-tree levels 0-7
2. `bootstrapActionLog(16n)` — initializes empty-tree levels 8-15
3. `bootstrapActionLog(24n)` — initializes empty-tree levels 16-23,
   commits `registryActionLogRoot` to the depth-24 empty root, sets
   `_actionLogBaseSeq = 0`, and sets `_bootstrapComplete = true`.

Only after all three calls succeed can `registerSchedule`,
`registerLane`, `retuneClass`, and any other branch op run.

**Expected timing:** each shard call is a single Midnight transaction;
~1-3 minutes each depending on block time. Total shard sequence
overhead: ~5-10 minutes.

**Recovery if a shard fails mid-sequence:** the deploy script does not
resume mid-deploy. If shard 1 succeeds but shard 2 fails, the deployed
contract is in a stuck state with `_actionLogBootstrapCursor = 8` and
`_bootstrapComplete = false`. The correct recovery is:

- Abandon the partially-initialized contract (no rollback exists for a
  deployed Midnight address; orphan is acceptable).
- Delete or rename `tariff-registry-preview-deployment.public.json` so
  the top-of-`main` idempotent-exit check does not re-detect the dead
  address.
- Re-run `./deploy-preview.sh` from scratch. A fresh deploy allocates a
  new contract address and starts the shard sequence over.

## Output artifact

After successful deploy, public output lands at:

- `contracts/tariff-registry/tariff-registry-preview-deployment.public.json`

Seed material remains in:

- `contracts/tariff-registry/deployment.json` (do not commit).

## Copy public artifact back to Windows checkout

Run on Windows PowerShell:

```powershell
scp kenya:~/contracts/tariff-registry/tariff-registry-preview-deployment.public.json C:\Users\Garrett\Projects\contracts\tariff-registry\
```

## Rollback / abandon

No on-chain rollback exists for a deployed contract address.  
If you need to abandon the Preview deploy:

- keep chain state as-is (orphaned deployment is acceptable), and
- delete local/deployment artifacts as needed.
