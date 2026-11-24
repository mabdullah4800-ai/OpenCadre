#!/usr/bin/env bash
# Cursor (local) — same MCP transport as Claude Code
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client cursor-local --mode mcp "$@"
