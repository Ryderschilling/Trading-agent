#!/bin/bash
# Mac-safe startup wrapper for the trading agent.
# Prevents macOS from sleeping the process during trading hours.
#
# Usage:
#   chmod +x scripts/start-mac.sh
#   ./scripts/start-mac.sh           # production (dist/index.js)
#   ./scripts/start-mac.sh --dev     # dev (ts-node src/index.ts)
#   ./scripts/start-mac.sh --stop    # just stop whatever is running
#
# caffeinate flags:
#   -i = prevent idle sleep
#   -s = prevent system sleep (works even when lid is closed if plugged in)
#   -w = wait for the child process to exit before releasing the assertion

set -e

DEV=false
STOP_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --dev)  DEV=true ;;
    --stop) STOP_ONLY=true ;;
  esac
done

PORT="${PORT:-3000}"

# Stop whatever is already holding the port. Without this a restart dies on
# EADDRINUSE and the OLD process keeps running with the OLD config still in
# memory, which looks like "the restart worked" but changes nothing.
stop_existing() {
  local pids
  pids=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "[start] stopping existing agent on port $PORT (pid: $pids)"
    kill $pids 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 1
      pids=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
      [[ -z "$pids" ]] && break
    done
    pids=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "[start] it did not exit, sending SIGKILL"
      kill -9 $pids 2>/dev/null || true
      sleep 1
    fi
    # release the sleep assertion left behind by the old wrapper
    pkill -f "caffeinate -i -s node dist/index.js" 2>/dev/null || true
    pkill -f "caffeinate -i -s ts-node src/index.ts" 2>/dev/null || true
    echo "[start] stopped"
  else
    echo "[start] nothing running on port $PORT"
  fi
}

stop_existing

if $STOP_ONLY; then
  exit 0
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
