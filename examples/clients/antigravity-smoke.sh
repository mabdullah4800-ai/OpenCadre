#!/usr/bin/env bash
# Antigravity (IDE / app) — MCP; the config example lives in examples/clients/antigravity/mcp_config.json
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client antigravity --mode mcp "$@"
