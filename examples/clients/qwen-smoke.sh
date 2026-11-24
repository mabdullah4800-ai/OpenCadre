#!/usr/bin/env bash
# Qwen-Agent — native MCP in long-running process
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client qwen --mode mcp "$@"
