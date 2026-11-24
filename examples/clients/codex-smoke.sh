#!/usr/bin/env bash
# ChatGPT / Codex Developer Mode — Streamable HTTP MCP
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client codex --mode mcp "$@"
