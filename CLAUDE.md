# Trading Agent — Project Context & AI Collaboration Instructions

> **Strategy spec:** See [`STRATEGY.md`](./STRATEGY.md) for the complete PB Investing Break & Retest strategy definition — how the system thinks, what it looks for, and how every rule maps to code.

## What This Project Is

An automated trading system built in **TypeScript / Node.js** with a web-based UI. It connects to brokers (Alpaca now, IBKR in progress), receives real-time market data, evaluates symbols against configurable rule sets, fires trade alerts, and tracks outcomes. It is live and in active development.

The system trades one hardcoded strategy: **PB Investing Break & Retest** — break of premarket/previous-day highs and lows, confirmed by VWAP position, 8 EMA, and relative strength, with 1-minute tap entry precision.

The goal is a fully automated, rules-driven trading engine that handles equities, options, and eventually forex across both intraday and multi-day timeframes.

---

## Current Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Database | SQLite via `better-sqlite3` |
| HTTP server | Express |
| Realtime | WebSocket (custom, `src/server/realtime.ts`) |
| Data feed | Alpaca WebSocket stream (`src/data/alpaca.ts`) |
| Primary broker | Alpaca REST (`src/broker/alpacaAdapter.ts`) |
| Options broker (WIP) | IBKR Client Portal Gateway (`src/broker/ibkrAdapter.ts`) |
| UI | Vanilla HTML/JS/CSS (`public/`) |
| Deployment | Docker |

---

## Architecture Map

```
src/
  index.ts                  — App entry: wires everything together, runs the main loop
  data/
    alpaca.ts               — WebSocket stream: bar subscription and message parsing
  market/
    levels.ts               — PMH/PML/PDH/PDL/VWAP level computation and updates
    marketDirection.ts      — SPY/QQQ bias: BULLISH / BEARISH / NEUTRAL
    sectorResolver.ts       — Maps symbol to sector ETF for alignment checks
    time.ts                 — NY market hours, day key helpers
  engine/
    signalEngine.ts         — Core signal logic: break detection, retest tap, forming candidates
    rs.ts                   — Relative strength computation (sym vs SPY on 5m bars)
    outcomeTracker.ts       — Tracks live trade outcomes: stop, target, breakeven, R-multiples
    executionSimulator.ts   — Simulates fill logic for backtesting
    types.ts                — Shared types: Alert, Direction, TradeOutcome, SignalState
  rules/
    schema.ts               — StrategyDefinition schema (v3): normalizes, migrates legacy formats
    executionPolicy.ts      — Thin wrapper around normalizeStrategyDefinition
  broker/
    alpacaAdapter.ts        — Alpaca REST: account, positions, orders
    ibkrAdapter.ts          — IBKR Client Portal Gateway: account, positions, orders (WIP)
    service.ts              — BrokerExecutionService: broker-agnostic execution layer
    config.ts               — Credential masking, merge, normalization
    types.ts                — BrokerAdapter interface, order types
  db/
    db.ts                   — SQLite: ruleset CRUD, broker config persistence
  server/
    http.ts                 — Express routes: rules, broker, backtest, outcomes, watchlist APIs
    auth.ts                 — Auth middleware
    realtime.ts             — WebSocket push to UI
  sim/
    backtestEngine.ts       — Bar-replay backtest runner
    backtestQueue.ts        — Queue for async backtest jobs
    executionSim.ts         — Simulated execution for backtest
  tests/
    broker-and-forming.test.ts
    http-rules.test.ts
    strategy-schema.test.ts

public/
  index.html / app.js       — Dashboard: live alerts, forming candidates
  rules.html / rules.js     — Strategy rule builder UI (PRIORITY — needs most work)
  backtest.html / backtest.js
  brokers.html / brokers.js
  outcomes.html / outcomes.js
  watchlist.html

data/
  trading-agent.sqlite      — Live database
  alerts.json               — Alert history
  outcomes.json             — Trade outcomes
  watchlist.json            — Active watchlist
```

---

## Core Domain Concepts

### Signal Flow
1. Alpaca WebSocket delivers 5m bars per symbol in the watchlist
2. `levels.ts` maintains PMH, PML, PDH, PDL, VWAP for each symbol
3. `marketDirection.ts` computes SPY/QQQ bias (BULLISH/BEARISH/NEUTRAL)
4. `rs.ts` computes relative strength of each symbol vs SPY
5. `signalEngine.ts` evaluates each bar: if price closes through a level with RS alignment → "A+ SETUP FORMING — WAIT FOR RETEST"
6. On 1m bars, `onMinuteBar()` fires "A+ ENTRY (1m TAP)" when price touches the retest level
7. `outcomeTracker.ts` manages the live trade from entry through stop/target/time exit
8. Alerts push to UI via WebSocket and persist to SQLite

### Strategy Schema (v3)
Defined in `src/rules/schema.ts`. A `StrategyDefinition` has:
- **setupType**: `break_retest` | `ma_cross`
- **timeframeMin**: bar timeframe (1, 5, 15, 60, etc.)
- **direction**: `both` | `long` | `short`
- **setup**: either `BreakRetestSetup` or `MaCrossSetup`
- **filters**: session, volume, volatility, market bias, SPY/QQQ alignment, VWAP agreement, relative strength
- **risk**: riskMode, riskValue, stopMode, R-multiples (stop, target, breakeven), time exit, max positions
- **brokerCaps**: maxTradesPerDay, maxCapital

The schema supports three historical formats and normalizes all of them into v3 on load (see `normalizeStrategyDefinition`). Do not break backward compat.

### Broker Abstraction
`BrokerAdapter` interface in `src/broker/types.ts`. Both Alpaca and IBKR implement it. `BrokerExecutionService` (`src/broker/service.ts`) is the broker-agnostic execution layer the rest of the system calls.

IBKR uses the Client Portal Gateway (local HTTPS on 127.0.0.1:5000 / 5001), which requires `rejectUnauthorized: false` due to self-signed certs. This is intentional.

---

## Current State & Known Gaps

### What Works
- Live Alpaca data feed + 5m/1m bar processing
- Break/retest signal detection + 1m tap entry logic
- Alert push to UI via WebSocket
- Outcome tracking (stop, target, breakeven, R-multiples)
- Backtest engine with bar replay
- Broker abstraction layer (Alpaca fully wired)
- SQLite persistence for rulesets, broker config, alerts, outcomes
- Basic auth

### What Needs Work (Priority Order)

1. **Rules page / strategy builder** — `public/rules.html` + `public/rules.js`. This is the highest priority. The UI for configuring strategies needs to be more powerful, intuitive, and complete. The schema supports a lot of options that may not be fully exposed in the UI.

2. **Options trading integration** — IBKR adapter is started but options-specific logic (contract selection, strike/expiry, greeks, options order types) is not implemented. This is the next major feature.

3. **IBKR full integration** — Beyond options: confirm account, positions, and order submission work end-to-end with a live IBKR gateway.

4. **Multi-timeframe swing strategies** — Current signal logic is tuned for intraday (5m/1m). Swing setups (60m, 240m, daily) need their own level logic and hold-time management.

5. **Strategy performance analytics** — Outcomes are tracked but there's no dashboard for win rate, avg R, drawdown, expectancy per strategy.

---

## Engineering Standards for This Codebase

- **TypeScript strict mode** — maintain type safety, do not use `any` unless absolutely necessary (and flag it when you do)
- **No external HTTP libs** — raw `https` module is used intentionally for minimal dependencies
- **Schema normalization** — all user input flows through schema normalization before touching the engine; never trust raw form data
- **Bar-time determinism** — cooldowns and state transitions use bar timestamps (`bar.t`), never `Date.now()`, to keep backtests deterministic
- **SQLite is the source of truth** — no in-memory caches that diverge from DB state
- **Broker abstraction** — all execution goes through `BrokerAdapter` interface; never call Alpaca/IBKR APIs directly from the signal engine or rules logic
- **No breaking legacy rulesets** — `normalizeStrategyDefinition` handles v1/v2/v3 migration; schema changes must extend, not break, existing saved strategies

---

## How to Work with Me (AI Instructions)

**Default mode:** Act as a senior TypeScript engineer who owns this codebase. When I bring a task, read the relevant files first, then implement. Don't ask obvious questions — make reasonable assumptions, state them, and move.

**When I ask about the rules page:** The core schema is in `src/rules/schema.ts`. The UI is in `public/rules.html` and `public/rules.js`. When suggesting changes, account for all fields in `StrategyDefinition`. The UI should expose every tunable parameter cleanly.

**When I ask about options:** The gap is in `src/broker/ibkrAdapter.ts` and in the signal engine — there's no options contract model yet. Options require: contract selection (symbol + expiry + strike + type), Greeks-aware sizing, different order types (limit on mid, etc.), and different exit logic. This will require schema extensions.

**When I ask about new strategies:** New setups must be added as new `setupType` values in `schema.ts`, with a corresponding setup type, normalizer, and default. The signal engine must be extended to handle them. Keep the existing `break_retest` and `ma_cross` logic untouched.

**When I ask about backtesting:** The backtest engine replays bars deterministically. Entries and exits must use `bar.t` timestamps. The simulator in `src/sim/executionSim.ts` handles fill logic. Do not introduce `Date.now()` calls into backtest paths.

**When I ask about broker integration:** Always go through `BrokerAdapter`. If a new broker requires new methods on the interface, add them to `types.ts` and implement stub fallbacks in existing adapters.

**Code style:**
- Functional helpers at file level, classes only for stateful components (SignalEngine, OutcomeTracker, BrokerExecutionService)
- Normalize inputs at system boundaries (API endpoints, DB reads, strategy loads)
- Error paths must be explicit — no silent swallows
- If a fix is a patch/shortcut, say so and flag the proper fix

---

## Open Questions / Decisions Pending

- **Options contract selection strategy:** How will the system pick strike and expiry? (e.g., ATM with 30+ DTE, delta-targeting, etc.) — **Not yet decided**
- **Swing timeframe data source:** Alpaca supports daily bars but does the current stream subscription handle 60m/240m? Needs verification.
- **Forex:** Listed as a target market but no FX broker or data source is wired. Deferred.
- **Position sizing for options:** Options have different notional exposure than equities. The current `riskMode: percent_account` model assumes equity-style sizing. Needs rethinking for options.

---

## Quick Reference: Key Files to Know

| Task | File(s) |
|---|---|
| Add a new strategy type | `src/rules/schema.ts`, `src/engine/signalEngine.ts` |
| Change signal logic | `src/engine/signalEngine.ts` |
| Change exit / risk logic | `src/engine/outcomeTracker.ts`, `src/rules/schema.ts` |
| Add a new broker | `src/broker/types.ts` (interface), new adapter file, `src/index.ts` |
| Fix rules UI | `public/rules.html`, `public/rules.js` |
| Change API routes | `src/server/http.ts` |
| Change DB schema | `src/db/db.ts` |
| Backtest changes | `src/sim/backtestEngine.ts`, `src/sim/executionSim.ts` |
| Add new market data | `src/data/alpaca.ts`, `src/market/levels.ts` |
