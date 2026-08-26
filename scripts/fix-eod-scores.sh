#!/bin/bash
# One-shot fix for the unscored EOD/manual-close trades.
# Stops the agent, applies scripts/backfill-eod-scores.sql, prints proof it
# worked, then restarts the agent in the foreground (same as start-mac.sh).
set -e
cd "$(dirname "$0")/.."

echo "[fix] stopping agent..."
./scripts/start-mac.sh --stop
sleep 2

echo "[fix] applying backfill..."
sqlite3 -cmd ".timeout 10000" data/trading-agent.sqlite < scripts/backfill-eod-scores.sql

echo "[fix] verifying..."
REMAINING=$(sqlite3 data/trading-agent.sqlite "SELECT count(*) FROM outcomes WHERE exit_reason != 'SKIPPED' AND (exit_return_pct IS NULL OR exit_return_pct = '');")
echo "[fix] unscored closed trades remaining: $REMAINING (should be 0)"
if [ "$REMAINING" != "0" ]; then
  echo "[fix] WARNING: backfill did not fully apply. NOT restarting. Investigate before restart."
  exit 1
fi

echo "[fix] done. restarting agent (foreground, Ctrl+C to stop)..."
exec ./scripts/start-mac.sh
