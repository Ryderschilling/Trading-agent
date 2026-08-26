#!/usr/bin/env bash
# =====================================================================
# Trading Agent — apply the 2026-08-22 exit block
#   Creates v12 (A — Retest) and v13 (B — Chase): 0.80% stop, fixed target
#   disabled, trailing stop arms at +2.0% MFE and gives back 1.0% from peak.
#   Retires v10/v11. Flags the v6/v8/v9 era as archived.
#
#   Run from the repo root:   ./scripts/apply-new-exits.sh
#   Refuses to run twice. Takes a timestamped backup first.
#   Rollback SQL is at the bottom of scripts/apply-new-exits.sql
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

DB="data/trading-agent.sqlite"
SQL="scripts/apply-new-exits.sql"
STAMP="$(date +%Y%m%d-%H%M%S)"

command -v sqlite3 >/dev/null || { echo "FAIL: sqlite3 not on PATH"; exit 1; }
[ -f "$DB" ]  || { echo "FAIL: $DB not found — run this from the repo root"; exit 1; }
[ -f "$SQL" ] || { echo "FAIL: $SQL not found"; exit 1; }

echo "==> 1/6  stopping the agent"
./scripts/start-mac.sh --stop || true
sleep 2
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  echo "FAIL: something is still listening on :3000. Kill it and re-run."
  echo "      lsof -ti tcp:3000 | xargs kill"
  exit 1
fi
echo "    port 3000 clear"

echo "==> 2/6  backing up"
cp "$DB" "$DB.backup-$STAMP"
echo "    $DB.backup-$STAMP"

echo "==> 3/6  pre-flight"
EXISTING=$(sqlite3 "$DB" "SELECT count(*) FROM rulesets WHERE version IN (12,13);")
if [ "$EXISTING" != "0" ]; then
  echo "FAIL: v12/v13 already exist. Nothing to do."
  echo "      To redo: see the ROLLBACK block in $SQL, then re-run."
  exit 1
fi
if ! sqlite3 "$DB" "PRAGMA table_info(outcomes);" | grep -q '|archived|'; then
  sqlite3 "$DB" "ALTER TABLE outcomes ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;"
  echo "    added outcomes.archived"
else
  echo "    outcomes.archived already present"
fi

echo "==> 4/6  applying"
sqlite3 "$DB" < "$SQL"

echo "==> 5/6  verifying"
FAILED=0
check () { # label expected actual
  if [ "$2" = "$3" ]; then printf '    ok   %-34s %s\n' "$1" "$3"
  else printf '    FAIL %-34s got %s, want %s\n' "$1" "$3" "$2"; FAILED=1; fi
}
check "active rulesets"      "12,13" "$(sqlite3 "$DB" "SELECT group_concat(version) FROM (SELECT version FROM rulesets WHERE active=1 ORDER BY version);")"
check "v12 stop %"           "0.8"   "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.stopValuePct') FROM rulesets WHERE version=12;")"
check "v13 stop %"           "0.8"   "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.stopValuePct') FROM rulesets WHERE version=13;")"
check "v12 trail arm %"      "2.0"   "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.trailActivatePct') FROM rulesets WHERE version=12;")"
check "v13 trail arm %"      "2.0"   "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.trailActivatePct') FROM rulesets WHERE version=13;")"
check "v12 trail give-back %" "1.0"  "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.trailDistancePct') FROM rulesets WHERE version=12;")"
check "v13 trail give-back %" "1.0"  "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.risk.trailDistancePct') FROM rulesets WHERE version=13;")"
check "v12 entry mode"       "retest"    "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.setup.entryMode') FROM rulesets WHERE version=12;")"
check "v13 entry mode"       "immediate" "$(sqlite3 "$DB" "SELECT json_extract(config_json,'\$.setup.entryMode') FROM rulesets WHERE version=13;")"
check "archived legacy rows" "588"   "$(sqlite3 "$DB" "SELECT count(*) FROM outcomes WHERE archived=1;")"
check "live rows kept"       "481"   "$(sqlite3 "$DB" "SELECT count(*) FROM outcomes WHERE archived=0;")"

if [ "$FAILED" != "0" ]; then
  echo
  echo "VERIFICATION FAILED — restoring the backup and NOT restarting."
  cp "$DB.backup-$STAMP" "$DB"
  echo "restored from $DB.backup-$STAMP. The agent is still stopped."
  exit 1
fi

echo "==> 6/6  restarting"
./scripts/start-mac.sh &
sleep 6
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  echo
  echo "DONE. Agent is up on :3000 running v12 and v13."
  echo "Open http://localhost:3000/rules and confirm both arms show a 0.80% stop"
  echo "and a trailing stop, then check /outcomes tomorrow for exit_reason=STOP rows"
  echo "with POSITIVE returns — that is the trail working."
else
  echo
  echo "WARNING: nothing on :3000. The DB change applied fine but the agent did not"
  echo "come up. Start it yourself with ./scripts/start-mac.sh and watch the output."
  exit 1
fi
