#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
while true; do
  node "$ROOT/scripts/inbox-monitor-loop.mjs" || true
  sleep 2
done
