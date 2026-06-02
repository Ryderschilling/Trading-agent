#!/bin/bash
# Mac-safe startup wrapper for the trading agent.
# Prevents macOS from sleeping the process during trading hours.
#
# Usage:
#   chmod +x scripts/start-mac.sh
#   ./scripts/start-mac.sh           # production (dist/index.js)
#   ./scripts/start-mac.sh --dev     # dev (ts-node src/index.ts)
#
# caffeinate flags:
#   -i = prevent idle sleep
#   -s = prevent system sleep (works even when lid is closed if plugged in)
#   -w = wait for the child process to exit before releasing the assertion

set -e

DEV=false
if [[ "$1" == "--dev" ]]; then
  DEV=true
fi

# Check if caffeinate is available (macOS only)
if ! command -v caffeinate &>/dev/null; then
  echo "[start] WARNING: caffeinate not available (not macOS). Running without sleep prevention."
  if $DEV; then
    npm run dev
  else
    npm start
  fi
  exit 0
fi

echo "[start] Launching trading agent with caffeinate (Mac sleep prevention active)"
echo "[start] To stop: Ctrl+C (or kill the caffeinate process)"
echo ""

if $DEV; then
  exec caffeinate -i -s ts-node src/index.ts
else
  exec caffeinate -i -s node dist/index.js
fi
