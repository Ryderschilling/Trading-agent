# Tracking the v12 / v13 exit change

Applied 2026-08-22. Baseline to beat: **v11 live (1.0% stop / 2.5% target) returned
+41.25% over 292 trades with a −19.96% max drawdown, 43.2% win rate, and 85% of the
total coming from one day.**

Everything below is the sum of `exit_return_pct` less 4 bps per trade. Dollars are
that percentage applied to $5,000 of notional. Run these against
`data/trading-agent.sqlite` — read-only, safe while the agent is running.

---

## The one query — run it every Friday

```sql
SELECT ruleset_version AS arm,
       count(*)                                            AS trades,
       round(sum(exit_return_pct) - 0.04*count(*), 2)      AS total_pct,
       round(sum(exit_return_pct)/count(*) - 0.04, 3)      AS per_trade,
       round(100.0*sum(exit_return_pct > 0)/count(*), 1)   AS win_rate,
       round((sum(exit_return_pct) - 0.04*count(*))/100*5000) AS dollars
FROM outcomes
WHERE exit_reason != 'SKIPPED' AND archived = 0
  AND ruleset_version IN (12, 13)
  AND entry_ts >= (strftime('%s','now','-7 days') * 1000)
GROUP BY 1;
```

Change `-7 days` to `-30 days` or drop the line entirely for since-inception.

## Is the trail actually working?

The single clearest sign. Under the old settings every `STOP` row was a loss. Under a
trailing stop, a `STOP` row can be a *win* — that is the trail locking in a runner.

```sql
SELECT ruleset_version AS arm, exit_reason,
       count(*) AS n,
       sum(exit_return_pct > 0) AS winners,
       round(sum(exit_return_pct), 2) AS total_pct
FROM outcomes
WHERE exit_reason != 'SKIPPED' AND archived = 0 AND ruleset_version IN (12,13)
GROUP BY 1, 2 ORDER BY 1, 3 DESC;
```

**Healthy:** at least 15% of `STOP` rows are profitable within the first month.
**Broken:** zero profitable stops after 30+ trades means the trail never arms — check
`trailActivatePct` survived the config load, on http://localhost:3000/rules.

## Concentration — the number that says whether this lasts

```sql
WITH d AS (
  SELECT date(entry_ts/1000, 'unixepoch', '-4 hours') AS day,
         sum(exit_return_pct) - 0.04*count(*) AS pnl
  FROM outcomes
  WHERE exit_reason != 'SKIPPED' AND archived = 0 AND ruleset_version IN (12,13)
  GROUP BY 1)
SELECT round(sum(pnl), 2)                       AS total_pct,
       round(max(pnl), 2)                       AS best_day,
       round(max(pnl) / nullif(sum(pnl), 0), 2) AS best_day_share,
       sum(pnl > 0) || '/' || count(*)          AS positive_days
FROM d;
```

**Target: best_day_share below 0.50.** It was 0.85 on v11. Above 0.60 means you are
still looking at one lucky day, not a strategy — and it is the number the volatility
gate is supposed to fix, so it is also the test of whether the gate is earning its keep.

## Drawdown — this is what caps your position size

```sql
WITH d AS (
  SELECT date(entry_ts/1000,'unixepoch','-4 hours') AS day,
         sum(exit_return_pct) - 0.04*count(*) AS pnl
  FROM outcomes
  WHERE exit_reason != 'SKIPPED' AND archived = 0 AND ruleset_version IN (12,13)
  GROUP BY 1),
c AS (SELECT day, sum(pnl) OVER (ORDER BY day) AS eq FROM d)
SELECT round(min(eq - peak), 2) AS max_drawdown_pct
FROM (SELECT day, eq, max(eq) OVER (ORDER BY day) AS peak FROM c);
```

---

## Decision rules — write these down now, before you have an opinion

Do not judge anything before **40 closed trades per arm**. That is roughly four weeks
at the current rate, longer once the volatility gate is in.

At 40 trades per arm, for each arm:

| Reading | Meaning | Action |
|---|---|---|
| total ÷ \|max drawdown\| ≥ 2.0 **and** best_day_share < 0.50 | working | leave it, start the sizing work |
| ratio 1.0–2.0 | inconclusive | run another 40 trades, change nothing |
| ratio < 1.0 after 80 trades | not working | roll back to v11's settings and re-open the question |
| per_trade < 0 after 60 trades | broken | stop, then diff the live config against `scripts/apply-new-exits.sql` before blaming the strategy |

**Do not change a setting mid-window.** Every change resets the 40-trade count to zero.
That discipline is the whole point; the reason four months of history was hard to read
is that settings moved underneath it.

## Every month

1. Re-run the exit lab over the newly closed trades and check the live per-trade result
   against what the backtest predicted. Predicted, ungated: **+0.15% per trade**. Gated
   at the top 25%: **+0.43% per trade**. A live number more than half a point below
   prediction means the simulator is missing something real — most likely slippage on
   stop fills, since the database records stop exits at exactly the stop price.
2. Re-check the plateau. If 0.80% / arm +2.0 / give 1.0 is no longer on a hill of
   good neighbours, the regime changed and the parameters are stale.
3. Never re-optimise on the last month alone. Rank by return ÷ drawdown, never by total.

## What "good" looks like in dollars

At $5,000 fixed notional the study's gated configuration returned **+65.59% summed over
154 trades across five months**, about $3,280, with a −13.77% worst drawdown. At 0.5%
risk-based sizing on a $25,000 account that is roughly **$2,250 a month**. If the live
numbers land within about a third of that, the engine is doing what it was measured to do.
