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
cd "$HOME/contracts"
git fetch origin
git checkout feat/wi14-tariff-registry-preview-deploy
git pull --ff-only
cd tariff-registry
npm install
chmod +x deploy-preview.sh
./deploy-preview.sh --repo "$HOME/contracts"
```

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
