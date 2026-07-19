#!/usr/bin/env bash
set -euo pipefail

REPO="${TARIFF_REGISTRY_REPO:-$HOME/contracts}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      if [[ $# -lt 2 ]]; then
        echo "error: --repo requires a path argument" >&2
        exit 2
      fi
      REPO="$2"
      shift 2
      ;;
    --force-rebuild)
      FORCE_REBUILD=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: $0 [--repo /path/to/contracts] [--force-rebuild]" >&2
      exit 2
      ;;
  esac
done

if ! command -v compactc.bin >/dev/null 2>&1; then
  echo "error: compactc.bin not found in PATH" >&2
  exit 1
fi

CONTRACT_DIR="$REPO/tariff-registry"
CONTRACT_SRC="$CONTRACT_DIR/tariff-registry-v1.compact"
BUILD_DIR="$CONTRACT_DIR/build"

if [[ ! -f "$CONTRACT_SRC" ]]; then
  echo "error: missing contract source: $CONTRACT_SRC" >&2
  exit 1
fi

echo "[preview] repo: $REPO"

# Skip compile if build/keys already populated (~17 circuit provers).
# Full ZK compile takes ~30 min on kenya-class hardware; re-runs of the
# deploy step should not pay that cost when the source hasn't changed.
# Pass --force-rebuild to override.
NEED_COMPILE=1
if [[ "$FORCE_REBUILD" == "0" && -d "$BUILD_DIR/keys" ]]; then
  PROVER_COUNT=$(ls "$BUILD_DIR/keys"/*.prover 2>/dev/null | wc -l)
  if [[ "$PROVER_COUNT" -ge 15 ]]; then
    # Confirm source hasn't changed vs a fingerprint sidecar.
    SRC_HASH=$(sha256sum "$CONTRACT_SRC" | awk '{print $1}')
    HASH_FILE="$BUILD_DIR/.source-sha256"
    if [[ -f "$HASH_FILE" && "$(cat "$HASH_FILE")" == "$SRC_HASH" ]]; then
      echo "[preview] build/keys populated ($PROVER_COUNT provers) and source unchanged; skipping compile"
      NEED_COMPILE=0
    else
      echo "[preview] build/keys populated but source hash differs (or missing); rebuilding"
    fi
  fi
fi

if [[ "$NEED_COMPILE" == "1" ]]; then
  echo "[preview] compiling: $CONTRACT_SRC -> $BUILD_DIR"
  compactc.bin "$CONTRACT_SRC" "$BUILD_DIR"
  # Fingerprint the source so future runs can short-circuit.
  sha256sum "$CONTRACT_SRC" | awk '{print $1}' > "$BUILD_DIR/.source-sha256"
fi

cd "$CONTRACT_DIR"
echo "[preview] running deploy script"
npx tsx deploy-tariff-registry-preview.ts
