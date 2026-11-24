#!/usr/bin/env bash
# Claude Code — connect → send → receive → reply smoke (MCP Streamable HTTP)
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client claude-code --mode mcp "$@"
