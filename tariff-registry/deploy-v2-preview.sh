#!/usr/bin/env bash
set -euo pipefail

REPO="${TARIFF_REGISTRY_REPO:-$HOME/contracts-wi15-impl}"
CONTRACT_DIR="$REPO/tariff-registry"

export PATH="$HOME/.compact/versions/0.30.0/x86_64-unknown-linux-musl:$HOME/.compact/bin:$PATH"

cd "$CONTRACT_DIR"

for f in tariff-audit tariff-governance tariff-schedule tariff-lane tariff-views; do
  echo "[wi15] compiling $f"
  compactc.bin "$f.compact" "build/$f"
done

echo "[wi15] running v2 deploy scaffold"
npx tsx deploy-tariff-registry-v2-preview.ts
