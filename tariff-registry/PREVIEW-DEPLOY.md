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
