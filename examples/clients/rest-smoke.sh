#!/usr/bin/env bash
# REST-only client — no MCP required
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client rest --mode rest "$@"
