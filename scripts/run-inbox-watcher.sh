#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${OPENCADRE_ENV_FILE:-$HOME/.cursor/opencadre-watcher.env}"
[[ -f "$ENV_FILE" ]] && set -a && source "$ENV_FILE" && set +a
cd "$ROOT"
while true; do
  echo "[$(date -Is)] starting zero-token-pinger (ingest-wake-only)"
  node scripts/zero-token-pinger.mjs || true
  sleep 5
done
