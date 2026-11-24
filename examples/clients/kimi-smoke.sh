#!/usr/bin/env bash
# Kimi CLI — MCP via /mcp-config
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client kimi --mode mcp "$@"
