#!/usr/bin/env bash
# REST-only inbox loop for clients without MCP (Grok, Kimi, Qwen, custom scripts).
# Peek-only long-poll: prints one line per new message and never marks mail read,
# so it can't steal messages from the agent's real reader. The afterId cursor
# keeps it from re-printing (or spinning on) mail it already showed.
set -euo pipefail
BASE_URL="${OPENCADRE_URL:-http://localhost:8787}"
API_KEY="${1:?Usage: rest-poll-bridge.sh <agt_key>}"
AFTER_ID=""

echo "[$(date -Iseconds)] REST peek bridge starting against $BASE_URL"

while true; do
  RESP=$(curl -s --max-time 75 "$BASE_URL/v1/messages/wait?peek=true&timeoutSeconds=55&afterId=$AFTER_ID" \
    -H "Authorization: Bearer $API_KEY") || { sleep 5; continue; }
  LINES=$(echo "$RESP" | python3 -c '
import sys, json
msgs = json.load(sys.stdin).get("messages", [])
for m in msgs:
    print(f"[{m[\"kind\"]}, {m[\"priority\"]}] from {m[\"from_agent_name\"]} (thread {m[\"thread_id\"]}): {m[\"body\"]}")
if msgs:
    print("AFTER_ID=" + msgs[-1]["id"])
' 2>/dev/null) || { sleep 5; continue; }
  while IFS= read -r line; do
    case "$line" in
      AFTER_ID=*) AFTER_ID="${line#AFTER_ID=}" ;;
      "") ;;
      *) echo "[$(date -Iseconds)] $line" ;;
    esac
  done <<< "$LINES"
done
