#!/usr/bin/env bash
set -euo pipefail

REPO="${TARIFF_REGISTRY_REPO:-$HOME/contracts}"

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
    *)
      echo "error: unknown argument: $1" >&2
      echo "usage: $0 [--repo /path/to/contracts]" >&2
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
echo "[preview] compiling: $CONTRACT_SRC -> $BUILD_DIR"
compactc.bin "$CONTRACT_SRC" "$BUILD_DIR"

cd "$CONTRACT_DIR"
echo "[preview] running deploy script"
npx tsx deploy-tariff-registry-preview.ts
