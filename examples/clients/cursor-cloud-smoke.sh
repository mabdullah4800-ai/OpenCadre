#!/usr/bin/env bash
# Cursor Cloud — MCP per turn; load watcher env if present
set -euo pipefail
ENV_FILE="${OPENCADRE_ENV_FILE:-$HOME/.cursor/opencadre-watcher.env}"
if [[ -f "$ENV_FILE" ]]; then set -a; source "$ENV_FILE"; set +a; fi
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client cursor-cloud --mode mcp "$@"
