# Trading Agent — Build Handoff

Last updated: 2026-05-21. Read this first in a new chat, then continue.

---

## 1. Current state

System runs correctly (process alive, data feed live, signal engine firing,
paper-mode orders placing, reconciler + restart recovery wired, `tsc` clean).

**Today (2026-05-21) a real regression was found and fixed.** The previous
handoff said "the strategy loses money — do not go live." That conclusion was
**wrong** — it averaged two different code eras together. See section 3.

Broker is **Alpaca paper mode**. IBKR (options) not started.

**A process restart is required to load today's fixes** (see section 5).

---

## 2. The regression (what actually happened)

The 129 closed trades are two separate code eras, not one population:

| Era      | Dates        | Exits seen           | Trades | Result   |
|----------|--------------|----------------------|--------|----------|
| OLD      | Apr 24–May 12| TIME, STOP_CLOSE     | 91     | **+7.13%** |
| CURRENT  | May 13–21    | STRUCTURE_BREAK, EOD | 36     | **−15.28%** |

A commit around **May 12–13** ("Add retest invalidation, EOD flatten, entry
cutoff…") regressed the system. It did three things:

1. Added the **STRUCTURE_BREAK** exit — fires when a 5m bar *opens* beyond the
   structure level. It fills at a price that has already run past the level:
   **0 wins in 23 trades, −18.76%**.
2. Silently **killed STOP / TARGET / breakeven**. `buildOutcomeExecRules()`
   only returned exec rules when `stopMode === "r_multiple"`. The live strategy
   runs `structure_close`, so it returned `undefined` → `exec.enabled = false`
   → STOP, TARGET and BE never fired. DB confirms: 0 STOP, 0 TARGET rows in the
   current era.
3. **Lost the TIME exit** — the OLD era's profit engine (+15.93% / 67 trades,
   69% win, ~60-min hold). It was never ported into `outcomeTracker.ts`.

Net: the only live exits in the current era were STRUCTURE_BREAK and EOD.

---

## 3. What was fixed this session (2026-05-21)

### Code (`tsc --noEmit` clean)

- **`src/rules/schema.ts` — `buildOutcomeExecRules()`**: now returns exec rules
  for *every* stop mode, not just `r_multiple`. `structure_close`/`ma_fail_close`
  → `stopR = 1` (stop at the structure level); `r_multiple` → `stopValueR`.
  Also converts `timeExitBars` → `timeExitMinutes` (× strategy timeframe).
- **`src/engine/outcomeTracker.ts`**:
  - `ExecRules` gained `timeExitMinutes?`.
  - `onMinuteBar()` — new **TIME exit**: closes at market once held
    `timeExitMinutes`. Checked outside the `exec.enabled` gate.
  - `onBar5Close()` — STRUCTURE_BREAK now **skipped whenever `exec.enabled`**.
    It only survives as a fallback for sessions with no managed exec. With the
    schema fix, exec is always enabled, so STRUCTURE_BREAK is effectively dead.
- **`src/index.ts`** — `shouldClose` now includes `reason === "TIME"`, so a
  TIME exit also closes the broker position (otherwise it would orphan).

### Ruleset (DB)

There were **two `active=1` rulesets** (v6 tf=5, and v8 tf=240). The loader
picks the highest active version → on the next restart it would have silently
switched the system to the wrong (240-min) strategy. Fixed:

- DB backed up to `data/trading-agent.backup-2026-05-21.sqlite`.
- v6, v8 set `active=0`. New **v9** created as the single active ruleset
  (logged in `rule_changes`).
- v9 risk block: `stopMode r_multiple, stopValueR 2, profitTargetR 2,
  moveToBreakevenAtR null, timeExitBars 12` (12 × 5m = 60-min TIME exit).

The 2R stop was chosen from a parameter sweep — see section 4.

---

## 4. Verification (candle-level replay of all 127 closed trades)

Replayed every trade against `candles_1m` with the new exit stack
(stop / 2R target / 60-min TIME / EOD), first trigger wins:

| Stop config (TIME 60m, target 2R) | OLD era | CURRENT era | All 127 |
|-----------------------------------|---------|-------------|---------|
| 1R stop (at structure)            | +2.93%  | −4.24%      | −1.31%  |
| **2R stop** (shipped)             | +1.45%  | **+1.63%**  | **+3.08%** |

A 1R stop sits exactly on the structure level and gets wicked out of trades
that recover — it destroys the TIME edge. A 2R stop gives room. The result is
a **plateau**: stopR 1.75–3.0 all return +2–3.3%; only ≤1.5R collapses. Not a
knife-edge fit. maxDD −5.2% (vs −16.9% actual). The +3.08% is spread across
many trades (total minus the single best trade is still +1.02%).

**Honest read:** this turns a −15%/month bleed into a thin positive edge
(~+0.02%/trade, median trade +0.01%). The replay assumes zero slippage on stop
/ target fills, so live will be worse — treat this as **breakeven-to-slightly-
positive, not a money printer.** Good enough to paper-trade forward; **not**
good enough for real money yet.

---

## 5. To deploy

1. `npm run build`
2. **Restart the process.** Required — it loads ruleset v9 and the new exit
   code. The currently-running process still holds v6 in memory.
3. After restart, confirm on the Analytics page that new closes show
   `TIME` / `STOP` / `TARGET` exit reasons and **no new `STRUCTURE_BREAK`**.

---

## 6. Gate to real money / options

1. ~~Fix STRUCTURE_BREAK~~ — done (retired).
2. Paper-trade 2–3 weeks on v9. Confirm net positive on the Analytics page
   *with real fills* (slippage included).
3. Position sizing — **checked 2026-05-21, not a blocker.** `broker/service.ts`
   sizes by **fixed notional** (`cfg.execution.defaultNotional`, default $1000)
   or fixed qty. It does NOT read `strategy.risk.riskValue` / `riskMode` at all —
   the strategy's declared "risk 1% of account" is decorative. So the 2R stop
   does not cause a "2× riskValue" bug (there is no risk-based sizing to break).
   Real effect: a stopped-out trade loses `notional × stopDistance%` — with a
   ~0.3–0.6%-wide 2R stop on a $1000 position that's ~$3–6/trade. The replay's
   maxDD −5.2% already reflects this. Fine for paper. **Before real money**,
   decide: wire true risk-based sizing (broker reads `riskValue`) or keep fixed
   notional deliberately. Architecture debt, not a bug.
4. THEN real money (small size). THEN options via IBKR.

Also still open: SHORT trades historically underperform LONG — re-check once
v9 has a few weeks of data.

---

## 7. Key technical gotchas (don't relearn these)

- **DB timestamps are milliseconds**, not seconds.
- **`exit_return_pct` is in PERCENT units** (0.24 = 0.24%). Reliable score.
- **`realized_pnl_usd` exists on only ~13 rows** — secondary metric only.
- Outcome rows are written only on close/skip. Open positions are in-memory;
  `reconstructLiveSessionsFromDb()` rebuilds them on startup.
- `getDbRows()` filters out SKIPPED / FORMING / INVALID — reuse it.
- MIN_RISK_PCT filter (0.15%) in `broker/service.ts` is deliberate.
- **better-sqlite3 native binding does NOT load in the analysis sandbox** —
  use Python's `sqlite3` for DB inspection. `ts-node --transpile-only` works
  for pure-TS checks that don't open the DB.
- Broker-native stop orders are still dead: `placeBrokerStopAfterEntry()`
  passes `qty=null` so `setStopOrder()` always throws (caught). And Alpaca
  rejects stop orders on fractional positions (notional sizing). The software
  stop in `outcomeTracker` is what actually protects positions.
- DB: `data/trading-agent.sqlite`. Key table `outcomes`.

---

## 8. CLAUDE.md priority list (original)

1. Rules page UI — strategy builder (most work needed)
2. Options trading via IBKR Client Portal Gateway
3. Swing timeframe support (60m/240m/daily)
4. Strategy performance analytics dashboard — **DONE**
5. (renumbered) — see CLAUDE.md for full file map / domain concepts

---

## 9. 2026-07-28 — the retest tolerance defect, and the A/B build

### The defect

`getStrategyRetestTolerancePct()` in `src/rules/schema.ts` returned `0.2` meaning
"0.2 percent". `SignalEngine` consumes it as a raw fraction:

```ts
const tol = Math.abs(lp) * this.cfg.retestTolerancePct;
```

That made the retest band **20% of price**, so the `touched` test in
`onMinuteBar()` was always true and the tap entry fired on the first 1m bar
after the break, wherever price happened to be.

Evidence across the 301 closed trades from 2026-04-15 to 2026-07-27:

- the level sits inside the entry candle in **12 of 301 trades (4%)**
- median entry is **0.76% away** from the level, while the median 1m candle is
  only 0.155% tall
- every recorded FORMING to ENTRY pair in `alerts` is exactly **1 minute** apart

The system was trading break-and-chase. The strategy in STRATEGY.md had never
run. Note the replay harness always used a sane fraction (0.003), which is why
replay and production disagreed for months.

### What was measured

Per-trade percent, summed, 4 bps of round-trip slippage on every exit:

| entry | exits | n | total | Apr-May | Jun-Jul | max DD |
|---|---|---|---|---|---|---|
| chase (bug) | current (1% stop, two-phase trail) | 301 | -13.79% | -16.66 | +2.87 | -18.65% |
| chase (bug) | 0.4% stop / 2.0% target / no trail | 301 | +13.79% | -10.31 | +24.10 | -20.63% |
| retest | current | 119 | -9.93% | -3.43 | -6.50 | -12.12% |
| retest | 0.4% stop / 2.0% target / no trail | 119 | +13.65% | +3.48 | +10.16 | -3.69% |

Neither change works alone. The trail was cutting winners monotonically across
the whole parameter sweep; the 1% stop is far too wide once the entry sits at
the level. Only the pair is positive in both halves.

Ideas tested and rejected: filtering chased entries (worse at every threshold),
skipping the first 30 minutes (much worse — the good trades are at the open),
longs-only / symbol / weekday selection (no mechanism, does not repeat across
halves).

### What changed in the code

- `schema.ts` — tolerance returns a fraction; new `setup.entryMode`
  ("retest" | "immediate") and `setup.retestTolerancePct` (percent); new
  optional per-strategy exit overrides on `risk` (trail + MFE gate) that take
  precedence over the `TRAIL_*` / `MFE_GATE_*` env vars
- `signalEngine.ts` — honours `entryMode`; wires up the long-dormant
  `maxRetestBars` as a retest expiry window; `nearBreakPct` no longer scales off
  the broken tolerance
- `outcomeTracker.ts` — `hasLiveSessionForSymbol()`, `sessionQty()`
- `broker/service.ts` — `closePositionQty()` closes only the qty a session owns
  instead of flattening the symbol; `perStrategyGuards` scopes the symbol/day,
  existing-position and anti-cluster caps to the strategy that raised the alert
- `index.ts` — per-strategy session direction lock and direction flip (they were
  global, so the first strategy to trade locked out the second); outcomes now
  carry `ruleset_version`
- `db.ts` — `outcomes.ruleset_version` migration + index
- `replay` — `--entry-mode=retest|immediate` for head-to-head replays
- `public/compare.html` + `/api/compare` — A/B scoreboard

### To run the A/B

Order matters. The agent has to be stopped first: a live process keeps its
watchlist, runners and broker policy in memory, so rewriting the database
underneath it changes nothing until it restarts.

```bash
./scripts/start-mac.sh --stop                  # stop the running agent
npm run build
npx ts-node scripts/setup-ab-test.ts           # dry run, prints the plan
npx ts-node scripts/setup-ab-test.ts --apply   # backs up the DB, then writes
./scripts/start-mac.sh                          # start (stops anything stale first)
```

The setup script refuses to run while the agent is listening, creates
`outcomes.ruleset_version` itself if the migration has not run yet, and is a
no-op on a second run.

That activates two rulesets: **v10 A-Retest** (retest entry, 0.40% stop, 2.0%
target) and **v11 B-Chase** (immediate entry, 1.0% stop, 2.5% target). Exits are
otherwise identical, so the entry rule is the only real variable. It also widens
the watchlist to 20 symbols and lifts the account caps, which were binding hard:
"max daily notional" was the third most common skip reason at $25k with $5k
positions.

Watch `/compare`. Roughly 40 closed trades per arm before the difference means
anything, so four to six weeks.

### Watchlist note

The `watchlist` table held only 6 symbols (AAPL AMZN GOOGL META MSFT NVDA) while
the running process was trading SPY, QQQ, IWM and PLTR from a stale in-memory
copy. On the next restart the system would have silently dropped to those 6,
including losing SPY and QQQ, which are the market-direction barometer. The
setup script rewrites the table to the full 20.

### Known limits of this test

- Both arms share one Alpaca paper account, so the dollar P&L is a blend.
  `exit_return_pct` is per-alert and computed from bar prices, so the percent
  column is the score that separates them. Separate paper accounts would be
  cleaner and are the obvious next step if the result is close.
- June carries a lot of the retest arm's backtested edge. April is slightly
  negative. This strategy makes money on trending days.
- The retest arm wins 37.8% of its trades and its median trade is a full stop.
  That shape is correct but uncomfortable.
