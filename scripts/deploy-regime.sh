#!/bin/bash
# Deploys the Day Regime observer.
#   1. stops the agent
#   2. rebuilds dist
#   3. backfills day_regime from existing candles
#   4. verifies the table is populated, refuses to restart if it isn't
#   5. restarts the agent in the foreground
#
# The observer touches no trading logic. If step 3 or 4 fails, the agent still
# restarts fine on the previous behaviour — the table just stays empty.
set -e
cd "$(dirname "$0")/.."

echo "[regime] stopping agent..."
./scripts/start-mac.sh --stop || true
sleep 2

echo "[regime] building..."
npm run build

echo "[regime] backfilling day_regime from candles..."
npx ts-node scripts/backfill-day-regime.ts

echo "[regime] verifying..."
ROWS=$(sqlite3 data/trading-agent.sqlite "SELECT count(*) FROM day_regime;")
echo "[regime] day_regime rows: $ROWS"
if [ "$ROWS" = "0" ]; then
  echo "[regime] WARNING: table is empty. NOT restarting. Investigate before restart."
  exit 1
fi

echo "[regime] checking dist is fresh..."
if [ ! -f dist/engine/dayRegime.js ]; then
  echo "[regime] WARNING: dist/engine/dayRegime.js missing — build did not emit. NOT restarting."
  exit 1
fi

echo "[regime] done. restarting agent (foreground, Ctrl+C to stop)..."
exec ./scripts/start-mac.sh
