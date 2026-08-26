-- =====================================================================
-- Trading Agent — new exit block, 2026-08-22
-- Creates v12 (A — Retest) and v13 (B — Chase) carrying the exit settings from
-- the out-of-sample study, and retires v10/v11 so each version's trade history
-- stays attached to the settings that produced it.
--     0.80% stop | fixed target disabled | trail arms +2.0%, gives back 1.0%
-- Also flags the v6/v8/v9 era as archived so the dashboards can stop counting it.
-- The wrapper script (apply-new-exits.sh) refuses to run this twice.
-- Rollback SQL is at the bottom of this file.
-- =====================================================================
BEGIN;

INSERT INTO rulesets (version, created_ts, name, active, config_json)
VALUES (12, CAST(strftime('%s','now') AS INTEGER)*1000, 'A — Retest (v12)', 1,
  '{"version": 3, "name": "A — Retest (v12)", "description": "Break and retest entry. New exit block from the 2026-08-22 out-of-sample study: 0.80% stop, no effective fixed target (profitTargetR 25 = a 20% target that never fills), trailing stop arms at +2.0% MFE and gives back 1.0% from the peak. Volatility-rank gate: entries only in the top 25% of the day''s ranked universe. Replaces v10.", "setupType": "break_retest", "timeframeMin": 5, "direction": "both", "setup": {"levels": ["pmh", "pml", "vwap"], "movingAverage": null, "breakConfirmation": "wick_and_close", "retestConfirmation": "reclaim_close", "maxRetestBars": 12, "entryTrigger": "retest_close", "entryMode": "retest", "retestTolerancePct": 0.2}, "filters": {"session": "regular", "universe": "watchlist", "minVolume": null, "minVolatilityPct": null, "requireMarketBias": true, "requireSpyQqqAlignment": true, "requireVwapAgreement": true, "requireRelativeStrength": true}, "risk": {"riskMode": "percent_account", "riskValue": 1, "stopMode": "percent", "stopValueR": null, "moveToBreakevenAtR": null, "timeExitBars": 72, "maxOpenPositions": 3, "trailActivatePct": 2.0, "trailDistancePct": 1.0, "trailTightenPct": 0, "trailTightenDistancePct": 0, "mfeGateMinutes": 30, "mfeGatePct": 0.05, "stopValuePct": 0.8, "profitTargetR": 25}, "brokerCaps": {"maxTradesPerDay": 4, "maxCapital": null}}');

INSERT INTO rule_changes (ts, version, changed_by, action, payload)
VALUES (CAST(strftime('%s','now') AS INTEGER)*1000, 12, 'ryder', 'created', '{"note": "exit block from the 2026-08-22 OOS study: 0.80% stop, trail arm +2.0 give back 1.0, fixed target disabled (profitTargetR 25)", "replaces": 10}');

INSERT INTO rulesets (version, created_ts, name, active, config_json)
VALUES (13, CAST(strftime('%s','now') AS INTEGER)*1000, 'B — Chase (v13)', 1,
  '{"version": 3, "name": "B — Chase (v13)", "description": "Breakout continuation entry, first bar after the break. Same exit block and volatility gate as v12, so the only difference between the arms is retest vs chase. 0.80% stop, no effective fixed target, trail arms at +2.0% and gives back 1.0%. Replaces v11.", "setupType": "break_retest", "timeframeMin": 5, "direction": "both", "setup": {"levels": ["pmh", "pml", "vwap"], "movingAverage": null, "breakConfirmation": "wick_and_close", "retestConfirmation": "reclaim_close", "maxRetestBars": 12, "entryTrigger": "retest_close", "entryMode": "immediate", "retestTolerancePct": 0.2}, "filters": {"session": "regular", "universe": "watchlist", "minVolume": null, "minVolatilityPct": null, "requireMarketBias": true, "requireSpyQqqAlignment": true, "requireVwapAgreement": true, "requireRelativeStrength": true}, "risk": {"riskMode": "percent_account", "riskValue": 1, "stopMode": "percent", "stopValueR": null, "moveToBreakevenAtR": null, "timeExitBars": 72, "maxOpenPositions": 3, "trailActivatePct": 2.0, "trailDistancePct": 1.0, "trailTightenPct": 0, "trailTightenDistancePct": 0, "mfeGateMinutes": 30, "mfeGatePct": 0.05, "stopValuePct": 0.8, "profitTargetR": 25}, "brokerCaps": {"maxTradesPerDay": 4, "maxCapital": null}}');

INSERT INTO rule_changes (ts, version, changed_by, action, payload)
VALUES (CAST(strftime('%s','now') AS INTEGER)*1000, 13, 'ryder', 'created', '{"note": "exit block from the 2026-08-22 OOS study: 0.80% stop, trail arm +2.0 give back 1.0, fixed target disabled (profitTargetR 25)", "replaces": 11}');

-- retire the old arms: history stays, they simply stop trading
UPDATE rulesets SET active = 0 WHERE version IN (10, 11);
INSERT INTO rule_changes (ts, version, changed_by, action, payload)
  SELECT CAST(strftime('%s','now') AS INTEGER)*1000, version, 'ryder', 'deactivated',
         '{"note":"superseded by v12/v13 on 2026-08-22"}'
  FROM rulesets WHERE version IN (10, 11);

-- the dead eras
UPDATE outcomes SET archived = 1 WHERE ruleset_version IN (6, 8, 9);
UPDATE rulesets SET active = 0 WHERE version IN (6, 8, 9);

COMMIT;

-- =====================================================================
-- ROLLBACK — paste this into sqlite3 to undo everything above
--   BEGIN;
--     DELETE FROM rulesets     WHERE version IN (12,13);
--     DELETE FROM rule_changes WHERE version IN (12,13);
--     UPDATE rulesets SET active = 1 WHERE version IN (10,11);
--     UPDATE outcomes SET archived = 0;
--   COMMIT;
-- (the `archived` column can stay; 0 everywhere means it does nothing)
-- =====================================================================
