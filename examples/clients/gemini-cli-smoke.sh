#!/usr/bin/env bash
# Gemini CLI — MCP when available, REST fallback via --mode rest
set -euo pipefail
MODE="${OPENCADRE_SMOKE_MODE:-mcp}"
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client gemini-cli --mode "$MODE" "$@"
