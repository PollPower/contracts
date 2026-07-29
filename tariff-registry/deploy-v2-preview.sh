#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./deploy-v2-preview.sh [--repo /path/to/contracts] [--force-rebuild] \
    --federation-authority-pubkey <64-hex> \
    --ref-rate-fiat-per-kwh <positive-int-1..1000000> \
    [--rotate-audit-writer]
EOF
}

REPO="$HOME/contracts"
FORCE_REBUILD=false
ROTATE_AUDIT_WRITER=false
FEDERATION_AUTHORITY_PUBKEY=""
REF_RATE_FIAT_PER_KWH=""

while (($# > 0)); do
  case "$1" in
    --help)
      usage
      exit 0
      ;;
    --repo)
      if (($# < 2)); then
        usage >&2
        exit 2
      fi
      REPO="$2"
      shift 2
      ;;
    --force-rebuild)
      FORCE_REBUILD=true
      shift
      ;;
    --federation-authority-pubkey)
      if (($# < 2)); then
        usage >&2
        exit 2
      fi
      FEDERATION_AUTHORITY_PUBKEY="$2"
      shift 2
      ;;
    --ref-rate-fiat-per-kwh)
      if (($# < 2)); then
        usage >&2
        exit 2
      fi
      REF_RATE_FIAT_PER_KWH="$2"
      shift 2
      ;;
    --rotate-audit-writer)
      ROTATE_AUDIT_WRITER=true
      shift
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$FEDERATION_AUTHORITY_PUBKEY" || -z "$REF_RATE_FIAT_PER_KWH" ]]; then
  usage >&2
  exit 2
fi

export PATH="$HOME/.compact/versions/0.30.0/x86_64-unknown-linux-musl:$HOME/.compact/bin:$PATH"
if ! command -v compactc.bin >/dev/null 2>&1; then
  echo "[wrapper] compactc.bin missing after PATH prepend" >&2
  exit 3
fi

if [[ -z "${TARIFF_DEPLOY_UTILS:-}" ]] \
  || [[ ! -f "${TARIFF_DEPLOY_UTILS:-}" ]] \
  || ! grep -q 'export async function createWallet' "$TARIFF_DEPLOY_UTILS" \
  || ! grep -q 'export async function createProviders' "$TARIFF_DEPLOY_UTILS"; then
  echo "[wrapper] TARIFF_DEPLOY_UTILS missing or invalid: ${TARIFF_DEPLOY_UTILS:-}" >&2
  exit 4
fi

CONTRACT_DIR="$REPO/tariff-registry"
DEPLOYMENT_JSON="$CONTRACT_DIR/deployment.json"
if [[ ! -f "$DEPLOYMENT_JSON" ]]; then
  echo "[wrapper] missing deployment.json at $DEPLOYMENT_JSON" >&2
  exit 5
fi

for sibling in tariff-audit tariff-governance tariff-schedule tariff-lane tariff-views; do
  if [[ ! -f "$CONTRACT_DIR/$sibling.compact" ]]; then
    echo "[wrapper] missing sibling source: $sibling.compact" >&2
    exit 6
  fi
done

DEPLOY_SCRIPT="$CONTRACT_DIR/deploy/deploy-wi15.1.ts"
if [[ ! -f "$DEPLOY_SCRIPT" ]]; then
  echo "[wrapper] missing deploy script at $DEPLOY_SCRIPT" >&2
  exit 7
fi

if [[ ! -f "$CONTRACT_DIR/node_modules/@midnight-ntwrk/midnight-js-contracts/package.json" ]]; then
  echo "[wrapper] npm install required ΓÇö @midnight-ntwrk/midnight-js-contracts not installed" >&2
  exit 8
fi

cd "$CONTRACT_DIR"

sibling_order=(tariff-audit tariff-governance tariff-schedule tariff-lane tariff-views)
json_name_order=(audit governance schedule lane views)
declare -A COMPILE_SKIPPED=()
declare -A SOURCE_HASHES=()

for sibling in "${sibling_order[@]}"; do
  src_hash="$(sha256sum "$sibling.compact" | awk '{print $1}')"
  name="${sibling#tariff-}"
  target_build="build/$name"
  fingerprint_file="$target_build/.source-sha256"

  SOURCE_HASHES["$name"]="$src_hash"
  COMPILE_SKIPPED["$name"]=false

  if [[ "$FORCE_REBUILD" == false ]] \
    && [[ -d "$target_build" ]] \
    && compgen -G "$target_build/keys/*.prover" >/dev/null \
    && [[ -f "$fingerprint_file" ]] \
    && [[ "$(tr -d '[:space:]' < "$fingerprint_file")" == "$src_hash" ]]; then
    echo "[wrapper] skip compile $name (source unchanged)"
    COMPILE_SKIPPED["$name"]=true
    continue
  fi

  echo "[wrapper] compiling $name"
  if ! compactc.bin "$sibling.compact" "$target_build"; then
    echo "[wrapper] compile FAILED for $name" >&2
    exit 9
  fi

  printf '%s\n' "$src_hash" > "$fingerprint_file"
done

echo "[wrapper] compile phase complete: 5/5 siblings ready"

DEPLOY_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
LOG_FILE="deploy-v2-preview-${DEPLOY_START}-pid$$.log"
LOG_PATH="$CONTRACT_DIR/$LOG_FILE"
STATUS_PATH="$CONTRACT_DIR/deploy-v2-preview-status.json"

deploy_cmd=(
  npx tsx deploy/deploy-wi15.1.ts
  --federation-authority-pubkey "$FEDERATION_AUTHORITY_PUBKEY"
  --ref-rate-fiat-per-kwh "$REF_RATE_FIAT_PER_KWH"
)

if [[ "$ROTATE_AUDIT_WRITER" == true ]]; then
  deploy_cmd+=(--rotate-audit-writer)
fi

set +e
"${deploy_cmd[@]}" 2>&1 | tee "$LOG_PATH"
DEPLOY_EXIT_CODE=${PIPESTATUS[0]}
set -e

DEPLOY_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SUCCESS=false
if [[ "$DEPLOY_EXIT_CODE" -eq 0 ]]; then
  SUCCESS=true
fi

PUBKEY_PREFIX="${FEDERATION_AUTHORITY_PUBKEY:0:8}..."
{
  printf '{\n'
  printf '  "schemaVersion": "1",\n'
  printf '  "startedAt": "%s",\n' "$DEPLOY_START"
  printf '  "finishedAt": "%s",\n' "$DEPLOY_END"
  printf '  "wrapperPid": %s,\n' "$$"
  printf '  "logFile": "%s",\n' "$LOG_FILE"
  printf '  "exitCode": %s,\n' "$DEPLOY_EXIT_CODE"
  printf '  "success": %s,\n' "$SUCCESS"
  printf '  "flagsForwarded": {\n'
  printf '    "rotateAuditWriter": %s,\n' "$ROTATE_AUDIT_WRITER"
  printf '    "federationAuthorityPubkey": "%s",\n' "$PUBKEY_PREFIX"
  printf '    "refRateFiatPerKwh": "%s"\n' "$REF_RATE_FIAT_PER_KWH"
  printf '  },\n'
  printf '  "compilePhase": {\n'
  printf '    "siblings": [\n'
  for i in "${!json_name_order[@]}"; do
    name="${json_name_order[$i]}"
    comma=","
    if ((i == ${#json_name_order[@]} - 1)); then
      comma=""
    fi
    printf '      { "name": "%s", "skipped": %s, "sourceHash": "%s" }%s\n' \
      "$name" \
      "${COMPILE_SKIPPED[$name]}" \
      "${SOURCE_HASHES[$name]}" \
      "$comma"
  done
  printf '    ]\n'
  printf '  }\n'
  printf '}\n'
} > "$STATUS_PATH"

exit "$DEPLOY_EXIT_CODE"
