#!/usr/bin/env bash
# Grok Build — hub-side smoke only. "grok" is a label on the messages this sends; no Grok
# binary is started and no Grok config is read. Grok Build is not installed on any fleet machine.
set -euo pipefail
exec node "$(dirname "$0")/lib/inbox-smoke.mjs" --client grok --mode mcp "$@"
