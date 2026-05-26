// src/replay/harness.ts
//
// Replay harness — drives the LIVE SignalEngine + executionSim with synthetic
// scenarios and produces a structured report.
//
// This is intentionally instant (run-and-report), not real-time. The user
// chose this in setup. To add a wall-clock replay later, wrap the main loop
// in a setInterval keyed off bar timestamps.
//
// IMPORTANT: this harness does NOT drive BrokerExecutionService. Phase 2 will
// route through that to test broker gates / sizing / DB persistence. For now
// MockBroker is invoked directly when an entry alert fires.

import { SignalEngine } from "../engine/signalEngine";
import { Bar5, MarketDirection, computeMarketDirection } from "../market/marketDirection";
import { Levels, initLevels, onBarUpdateLevels } from "../market/levels";
import { isFirstHourNY, isPastEntryCutoffNY, isPastEodFlattenNY } from "../market/time";
import { initExec, onMinuteBarExec, ExecState, ExecRules, ExecFill } from "../sim/executionSim";
import { Alert } from "../engine/types";

import { MockBroker } from "./mockBroker";
import {
  HarnessOptions,
  ReplayAlert,
  ReplayBar1m,
  ReplayBrokerCall,
  ReplayError,
  ReplayFill,
  ReplayReport,
  Scenario,
  ScenarioResult,
} from "./types";

const FIVE_MIN_MS = 5 * 60_000;

const DEFAULT_ENGINE_CFG = {
  timeframeMin: 5,
  retestTolerancePct: 0.003, // 0.3% — gives ~$0.30 tap window on a $100 level
  rsWindowBars5m: 3,
  emaPeriods: [] as number[], // Phase 1 keeps this off for determinism
  trendFilter4h: false as boolean,
};

const DEFAULT_EXEC_RULES: ExecRules = {
  stopR: 1,
  targetR: 2,
  moveStopToBEAtR: 1,
};

const STRUCTURE_WINDOW = 3;

// Default minimum 1R window as a fraction of entry price. Any entry where
// abs(entry - structureLevel) / entry is below this gets skipped — those
// trades are guaranteed-stop-on-entry and just waste broker calls + slippage.
// Calibrated from a 4-day / 5-symbol sample where every trade with 1R < 0.15%
// was a stop-out at 0.00% return.
const DEFAULT_MIN_RISK_PCT = 0.0015;

type OpenTrade = {
  alertId: string;
  symbol: string;
  dir: "LONG" | "SHORT";
  entryTs: number;
  entryPrice: number;
  state: ExecState;
  stopPrice: number;
  targetPrice: number;
};

type SymbolBucket = {
  ts: number; // bucket open (epoch ms, floored to 5m boundary)
  o: number;
  h: number;
  l: number;
  c: number;
};

type SymbolState = {
  levels: Levels;
  bars5: Bar5[];
  bucket: SymbolBucket | null;
  lastClose: number | null;
};

// Walk a scenario one bar at a time and return a ScenarioResult.
async function runScenario(scenario: Scenario, opts: HarnessOptions): Promise<ScenarioResult> {
  const errors: ReplayError[] = [];
  const alerts: ReplayAlert[] = [];
  const fills: ReplayFill[] = [];

  // ---- Setup: engine + per-symbol state -----------------------------------
  const engine = new SignalEngine({
    ...DEFAULT_ENGINE_CFG,
    trendFilter4h: Boolean(opts.trendFilter4h),
  });

  const allSymbols = Object.keys(scenario.bars);
  const symbolState = new Map<string, SymbolState>();

  let earliestTs = Infinity;
  for (const sym of allSymbols) {
    const firstBar = scenario.bars[sym][0];
    if (firstBar && firstBar.t < earliestTs) earliestTs = firstBar.t;
  }
  if (!Number.isFinite(earliestTs)) {
    errors.push({
      scenarioId: scenario.id,
      phase: "data-prep",
      ts: null,
      symbol: null,
      message: "Scenario has no bars",
      stack: null,
    });
    return buildEmptyResult(scenario, alerts, fills, [], errors);
  }

  for (const sym of allSymbols) {
    symbolState.set(sym, {
      levels: initLevels(earliestTs),
      bars5: [],
      bucket: null,
      lastClose: null,
    });
  }

  // Pre-register all symbols with the engine.
  for (const sym of allSymbols) {
    const st = symbolState.get(sym)!;
    engine.ensureSymbol(sym, st.levels);
  }

  // Preload prior 5m bars per symbol so the 4h trend filter has a warm regime
  // by the time this scenario starts. Without this, the first 14+ trading days
  // of any replay run would have an UNKNOWN regime and the filter would silently
  // pass everything through, defeating the A/B test.
  //
  // Loaded lazily: only fetches when trendFilter4h is enabled, and only when
  // we have a SQLite cache to read from. Falls back to a no-op if not.
  if (opts.trendFilter4h) {
    const preloadDays = opts.preload4hDays ?? 21;
    try {
      const { preload5mHistoryFromSqlite } = await import("./preloadHistory");
      for (const sym of allSymbols) {
        const preloaded = await preload5mHistoryFromSqlite({
          symbol: sym,
          beforeTs: earliestTs,
          tradingDays: preloadDays,
        });
        if (!preloaded.length) continue;
        const st = symbolState.get(sym)!;
        for (const b5 of preloaded) {
          engine.pushBar5(sym, b5);
          st.bars5.push(b5);
        }
      }
    } catch (e: any) {
      errors.push({
        scenarioId: scenario.id,
        phase: "data-prep",
        ts: null,
        symbol: null,
        message: `4h preload failed (continuing with cold regime): ${String(e?.message || e)}`,
        stack: typeof e?.stack === "string" ? e.stack : null,
      });
    }
  }

  const minRiskPct = opts.minRiskPct ?? DEFAULT_MIN_RISK_PCT;
  const enforceLiveTimeGates = opts.enforceLiveTimeGates ?? true;
  const skippedEntries: ScenarioResult["skippedEntries"] = [];

  // ---- Mock broker --------------------------------------------------------

  // The harness sets these before each broker call so MockBroker can record
  // the right ts and resolve the fill price from the NEXT bar's open.
  let currentBarTs: number | null = null;
  // Map<symbol, ReplayBar1m> — bar following the alert; the harness wires this
  // up just before calling submitMarketOrder.
  const nextBarBySymbol = new Map<string, ReplayBar1m>();

  const broker = new MockBroker({
    scenarioIdAccessor: () => scenario.id,
    currentBarTsAccessor: () => currentBarTs,
    fillPriceResolver: (symbol) => {
      const nb = nextBarBySymbol.get(symbol);
      if (nb && Number.isFinite(nb.o)) return nb.o;
      // fall back to last close if available — avoids exception, surfaces as fill quality issue
      const st = symbolState.get(symbol);
      return st?.lastClose ?? null;
    },
  });

  // ---- Open trade state (executionSim) ------------------------------------
  // Wrapped in a holder so TS doesn't narrow it to `null` literal type
  // (the only reassignment is inside the handleEntryAlert closure, which
  // CFA can't see).
  const tradeHolder: { current: OpenTrade | null } = { current: null };

  // ---- Build chronological 1m timeline ------------------------------------

  type TimelineItem = { ts: number; symbol: string; bar: ReplayBar1m };
  const timeline: TimelineItem[] = [];
  for (const sym of allSymbols) {
    for (const b of scenario.bars[sym]) {
      timeline.push({ ts: b.t, symbol: sym, bar: b });
    }
  }
  // Within the same minute, SPY/QQQ first so market direction is up-to-date
  // when we evaluate the test symbol.
  const SYM_ORDER: Record<string, number> = { SPY: 0, QQQ: 1 };
  timeline.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const ao = SYM_ORDER[a.symbol] ?? 99;
    const bo = SYM_ORDER[b.symbol] ?? 99;
    return ao - bo;
  });

  // Helper to peek the next 1m bar for a symbol after index i (for next-open fill price).
  function peekNextBarFor(symbol: string, afterIdx: number): ReplayBar1m | null {
    for (let j = afterIdx + 1; j < timeline.length; j++) {
      if (timeline[j].symbol === symbol) return timeline[j].bar;
    }
    return null;
  }

  // ---- Core loop ----------------------------------------------------------

  for (let i = 0; i < timeline.length; i++) {
    const { ts, symbol, bar } = timeline[i];
    const st = symbolState.get(symbol)!;
    st.lastClose = bar.c;

    // 1. Update levels for this symbol on this 1m bar.
    try {
      onBarUpdateLevels(st.levels, bar.t, bar.h, bar.l);
    } catch (e: any) {
      errors.push(mkError(scenario.id, "data-prep", bar.t, symbol, e));
    }

    // 2. Aggregate into 5m buckets. When we cross into a new bucket, the
    //    previous bucket is "closed" → push to engine and evaluate.
    const bucketTs = Math.floor(bar.t / FIVE_MIN_MS) * FIVE_MIN_MS;
    if (!st.bucket || st.bucket.ts !== bucketTs) {
      if (st.bucket) finalizeAndEvaluate(symbol, st, st.bucket);
      st.bucket = { ts: bucketTs, o: bar.o, h: bar.h, l: bar.l, c: bar.c };
    } else {
      st.bucket.h = Math.max(st.bucket.h, bar.h);
      st.bucket.l = Math.min(st.bucket.l, bar.l);
      st.bucket.c = bar.c;
    }

    // 3a. PRODUCTION TIME GATE — EOD force-flatten.
    //     Live system: outcomeTracker calls isPastEodFlattenNY(ts) at 14:59 ET
    //     and force-closes any open position at the current bar's close.
    {
      const ot = tradeHolder.current;
      if (
        enforceLiveTimeGates &&
        ot &&
        symbol === ot.symbol &&
        isPastEodFlattenNY(bar.t)
      ) {
        const retPct =
          ((ot.dir === "LONG" ? 1 : -1) * ((bar.c - ot.entryPrice) / ot.entryPrice)) * 100;
        fills.push({
          scenarioId: scenario.id,
          symbol: ot.symbol,
          dir: ot.dir,
          entryTs: ot.entryTs,
          entryPrice: ot.entryPrice,
          exitTs: bar.t,
          exitPrice: bar.c,
          exitReason: "EOD",
          retPct,
          stopPrice: ot.stopPrice,
          targetPrice: ot.targetPrice,
        });
        tradeHolder.current = null;
      }
    }

    // 3. If this is the test symbol and we have an open trade, drive
    //    executionSim with this 1m bar (stop/target/BE).
    const ot = tradeHolder.current;
    if (ot && symbol === ot.symbol) {
      try {
        const fill = onMinuteBarExec(
          ot.dir,
          ot.state,
          DEFAULT_EXEC_RULES,
          bar.t,
          bar.h,
          bar.l,
          bar.c
        );
        if (fill) {
          fills.push({
            scenarioId: scenario.id,
            symbol: ot.symbol,
            dir: ot.dir,
            entryTs: ot.entryTs,
            entryPrice: ot.entryPrice,
            exitTs: fill.exitTs,
            exitPrice: fill.exitPrice,
            exitReason: fill.exitReason,
            retPct: fill.retPct,
            stopPrice: ot.stopPrice,
            targetPrice: ot.targetPrice,
          });
          tradeHolder.current = null;
        }
      } catch (e: any) {
        errors.push(mkError(scenario.id, "execution-bar", bar.t, symbol, e));
      }
    }

    // 4. For the test symbol, attempt 1-min tap entry (engine.onMinuteBar).
    //    The engine only emits an entry if it's already in BROKEN state.
    //
    //    PRODUCTION TIME GATE: live src/index.ts only calls onMinuteBar when
    //    isFirstHourNY(ts) is true AND isPastEntryCutoffNY(ts) is false.
    //    Without this gate, the harness fires entries that would never
    //    submit live (any entry after 10:30 ET).
    if (symbol === scenario.testSymbol && !tradeHolder.current) {
      const entryWindowOpen = enforceLiveTimeGates
        ? isFirstHourNY(bar.t) && !isPastEntryCutoffNY(bar.t)
        : true;

      if (entryWindowOpen) {
        const marketDir = currentMarketDir(symbolState);
        try {
          const tapAlert = engine.onMinuteBar({
            symbol,
            ts: bar.t,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            marketDir,
          });
          if (tapAlert) {
            alerts.push({ alert: tapAlert, scenarioId: scenario.id });
            await handleEntryAlert(tapAlert, i);
          }
        } catch (e: any) {
          errors.push(mkError(scenario.id, "engine-tap", bar.t, symbol, e));
        }
      }
    }
  }

  // Finalize any trailing bucket so the last 5m doesn't get dropped.
  for (const [sym, st] of symbolState.entries()) {
    if (st.bucket) {
      finalizeAndEvaluate(sym, st, st.bucket);
      st.bucket = null;
    }
  }

  // If an open trade survived to EOD, record it as an EOD/open exit.
  const eodTrade = tradeHolder.current;
  if (eodTrade) {
    const lastBar = scenario.bars[eodTrade.symbol].at(-1);
    fills.push({
      scenarioId: scenario.id,
      symbol: eodTrade.symbol,
      dir: eodTrade.dir,
      entryTs: eodTrade.entryTs,
      entryPrice: eodTrade.entryPrice,
      exitTs: lastBar?.t ?? null,
      exitPrice: lastBar?.c ?? null,
      exitReason: "EOD",
      retPct: lastBar
        ? ((eodTrade.dir === "LONG" ? 1 : -1) * ((lastBar.c - eodTrade.entryPrice) / eodTrade.entryPrice)) * 100
        : null,
      stopPrice: eodTrade.stopPrice,
      targetPrice: eodTrade.targetPrice,
    });
    tradeHolder.current = null;
  }

  // ---- Compare observed vs expected ---------------------------------------
  return finishResult(scenario, alerts, fills, broker.getCalls(), errors, skippedEntries);

  // -- nested helpers (closures over engine/symbolState/openTrade/broker) ---

  function finalizeAndEvaluate(symbol: string, st: SymbolState, bucket: SymbolBucket) {
    const bar5: Bar5 = { t: bucket.ts, o: bucket.o, h: bucket.h, l: bucket.l, c: bucket.c };

    try {
      engine.pushBar5(symbol, bar5);
      st.bars5.push(bar5);
    } catch (e: any) {
      errors.push(mkError(scenario.id, "engine-eval", bucket.ts, symbol, e));
      return;
    }

    // Only the TEST symbol triggers signal evaluation; SPY/QQQ are pure context.
    if (symbol !== scenario.testSymbol) return;

    const spy = symbolState.get("SPY");
    if (!spy) return;

    const marketDir = currentMarketDir(symbolState);

    try {
      const alert = engine.evaluateSymbol({
        symbol,
        marketDir,
        spyBars5: spy.bars5,
        symBars5: st.bars5,
        symLevels: st.levels,
        nowTs: bucket.ts,
        symVwap: null, // Phase 1: skip VWAP filter — covered by separate test later
      });
      if (alert) {
        alerts.push({ alert, scenarioId: scenario.id });
        // FORMING alerts do not trigger a broker order — the live system waits
        // for the 1m tap. We only fire the broker on entry alerts.
        if (isEntryAlert(alert) && !tradeHolder.current) {
          // shouldn't normally hit this path (entries come from onMinuteBar),
          // but if a strategy variant fires entry on 5m close we honor it.
          // Position the harness at the bucket close index for next-bar fill.
          const idx = findTimelineIdx(timeline, bucket.ts + FIVE_MIN_MS - 60_000, symbol);
          if (idx >= 0) void handleEntryAlert(alert, idx);
        }
      }
    } catch (e: any) {
      errors.push(mkError(scenario.id, "engine-eval", bucket.ts, symbol, e));
    }
  }

  async function handleEntryAlert(alert: Alert, atTimelineIdx: number) {
    if (tradeHolder.current) return; // one trade at a time
    const symbol = alert.symbol;
    const structureLevel = Number(alert.structureLevel ?? alert.levelPrice);
    if (!Number.isFinite(structureLevel)) {
      errors.push(mkError(scenario.id, "execution-init", alert.ts, symbol, new Error("alert missing structureLevel/levelPrice")));
      return;
    }

    const nextBar = peekNextBarFor(symbol, atTimelineIdx);
    if (!nextBar) {
      // No bar after the entry alert — record this as a no-fill scenario.
      errors.push(mkError(scenario.id, "broker-submit", alert.ts, symbol, new Error("no bar after entry alert — cannot fill at next open")));
      return;
    }

    // FIX #1: min-1R filter. If the structure-based stop is closer to the
    // would-be fill price than minRiskPct, the trade is guaranteed-stop-on-entry
    // and just wastes broker calls + slippage. Skip and record.
    const wouldFillPrice = nextBar.o;
    const oneRPct = Math.abs(wouldFillPrice - structureLevel) / Math.abs(wouldFillPrice);
    if (minRiskPct > 0 && oneRPct < minRiskPct) {
      skippedEntries.push({
        ts: alert.ts,
        symbol,
        dir: alert.dir,
        entryPrice: wouldFillPrice,
        structureLevel,
        oneRPct,
        reason: "low_risk",
      });
      return;
    }

    nextBarBySymbol.set(symbol, nextBar);
    currentBarTs = nextBar.t;

    const side: "buy" | "sell" = alert.dir === "CALL" ? "buy" : "sell";
    const clientOrderId = `replay-${scenario.id}-${alert.id.slice(0, 8)}`;

    let fillPrice: number;
    try {
      const result = await broker.submitMarketOrder({
        symbol,
        side,
        clientOrderId,
        qty: null,
        notional: opts.defaultNotional ?? 1_000,
        extendedHours: false,
      });
      fillPrice = Number(result?.raw?.fillPrice ?? nextBar.o);
    } catch (e: any) {
      errors.push(mkError(scenario.id, "broker-submit", alert.ts, symbol, e));
      return;
    }

    const dir: "LONG" | "SHORT" = side === "buy" ? "LONG" : "SHORT";
    let state: ExecState;
    try {
      state = initExec(dir, nextBar.t, fillPrice, structureLevel, DEFAULT_EXEC_RULES);
    } catch (e: any) {
      errors.push(mkError(scenario.id, "execution-init", alert.ts, symbol, e));
      return;
    }

    tradeHolder.current = {
      alertId: alert.id,
      symbol,
      dir,
      entryTs: nextBar.t,
      entryPrice: fillPrice,
      state,
      stopPrice: state.stopPrice,
      targetPrice: state.targetPrice,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMarketDir(symbolState: Map<string, { bars5: Bar5[]; levels: Levels }>): MarketDirection {
  const spy = symbolState.get("SPY");
  const qqq = symbolState.get("QQQ");
  if (!spy || !qqq) return "NEUTRAL";
  return computeMarketDirection({
    spyBars5: spy.bars5,
    qqqBars5: qqq.bars5,
    spyLevels: spy.levels,
    qqqLevels: qqq.levels,
    structureWindow: STRUCTURE_WINDOW,
  });
}

function isEntryAlert(alert: Alert): boolean {
  return alert.message === "A+ ENTRY (1m TAP)" || alert.message === "A+ ENTRY — BUY ON THIS 5-MIN CLOSE";
}

function isFormingAlert(alert: Alert): boolean {
  return alert.message === "A+ SETUP FORMING — WAIT FOR RETEST";
}

function isInvalidAlert(alert: Alert): boolean {
  return alert.message === "SETUP INVALID — STAND DOWN";
}

function mkError(scenarioId: string, phase: ReplayError["phase"], ts: number | null, symbol: string | null, err: any): ReplayError {
  return {
    scenarioId,
    phase,
    ts,
    symbol,
    message: String(err?.message || err || "unknown error"),
    stack: typeof err?.stack === "string" ? err.stack : null,
  };
}

function findTimelineIdx(
  timeline: Array<{ ts: number; symbol: string }>,
  ts: number,
  symbol: string
): number {
  // last index where ts <= target and symbol matches
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i];
    if (it.symbol === symbol && it.ts <= ts) return i;
  }
  return -1;
}

function buildEmptyResult(
  scenario: Scenario,
  alerts: ReplayAlert[],
  fills: ReplayFill[],
  brokerCalls: ReplayBrokerCall[],
  errors: ReplayError[]
): ScenarioResult {
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    testSymbol: scenario.testSymbol,
    pass: false,
    failures: ["data-prep failed before scenario could run"],
    alerts,
    fills,
    brokerCalls,
    errors,
    expect: scenario.expect ?? null,
    observed: {
      formingAlerts: 0,
      entryAlerts: 0,
      invalidatedAlerts: 0,
      skippedLowRisk: 0,
      firstDir: null,
      firstLevel: null,
      finalExitReason: null,
    },
    skippedEntries: [],
  };
}

function finishResult(
  scenario: Scenario,
  alerts: ReplayAlert[],
  fills: ReplayFill[],
  brokerCalls: ReplayBrokerCall[],
  errors: ReplayError[],
  skippedEntries: ScenarioResult["skippedEntries"]
): ScenarioResult {
  const ourAlerts = alerts.filter((a) => a.alert.symbol === scenario.testSymbol).map((a) => a.alert);
  const formingAlerts = ourAlerts.filter(isFormingAlert).length;
  const entryAlerts = ourAlerts.filter(isEntryAlert).length;
  const invalidatedAlerts = ourAlerts.filter(isInvalidAlert).length;

  const firstNonInvalid = ourAlerts.find((a) => !isInvalidAlert(a));
  const firstDir = firstNonInvalid && (firstNonInvalid.dir === "CALL" || firstNonInvalid.dir === "PUT")
    ? (firstNonInvalid.dir as "CALL" | "PUT")
    : null;
  const firstLevel = firstNonInvalid && (firstNonInvalid.level !== "—")
    ? (firstNonInvalid.level as "PMH" | "PML" | "PDH" | "PDL")
    : null;

  const lastFill = fills.find((f) => f.symbol === scenario.testSymbol);
  const finalExitReason = lastFill?.exitReason === "OPEN" ? "OPEN" : (lastFill?.exitReason as any) ?? null;

  const failures: string[] = [];
  const expect = scenario.expect;
  if (expect) {
    if (expect.expectFormingAlert && formingAlerts === 0) {
      failures.push("expected at least one FORMING alert, got 0");
    }
    if (!expect.expectFormingAlert && formingAlerts > 0) {
      failures.push(`expected no FORMING alert, got ${formingAlerts}`);
    }
    if (expect.expectEntryAlert && entryAlerts === 0) {
      failures.push("expected at least one ENTRY alert, got 0");
    }
    if (!expect.expectEntryAlert && entryAlerts > 0) {
      failures.push(`expected no ENTRY alert, got ${entryAlerts}`);
    }
    if (expect.expectedDir && firstDir && expect.expectedDir !== firstDir) {
      failures.push(`expected dir ${expect.expectedDir}, got ${firstDir}`);
    }
    if (expect.expectedLevel && firstLevel && expect.expectedLevel !== firstLevel) {
      failures.push(`expected level ${expect.expectedLevel}, got ${firstLevel}`);
    }
    if (expect.expectedExitReason && expect.expectedExitReason !== "NONE") {
      if (finalExitReason !== expect.expectedExitReason) {
        failures.push(`expected exit reason ${expect.expectedExitReason}, got ${finalExitReason ?? "none"}`);
      }
    }
  }
  // Observational scenarios (no expect) only fail on uncaught errors.
  if (errors.length > 0) {
    failures.push(`${errors.length} uncaught error(s) during scenario`);
  }

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    testSymbol: scenario.testSymbol,
    pass: failures.length === 0,
    failures,
    alerts,
    fills,
    brokerCalls,
    errors,
    expect: scenario.expect ?? null,
    observed: {
      formingAlerts,
      entryAlerts,
      invalidatedAlerts,
      skippedLowRisk: skippedEntries.length,
      firstDir,
      firstLevel,
      finalExitReason,
    },
    skippedEntries,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runReplay(scenarios: Scenario[], opts: HarnessOptions = {}): Promise<ReplayReport> {
  const startedAt = Date.now();
  const filtered = opts.scenarioFilter
    ? scenarios.filter((s) => s.id.includes(opts.scenarioFilter!))
    : scenarios;

  const results: ScenarioResult[] = [];
  for (const scenario of filtered) {
    if (opts.verbose) {
      console.log(`[replay] running scenario: ${scenario.id}`);
    }
    try {
      const res = await runScenario(scenario, opts);
      results.push(res);
      if (opts.verbose) {
        const status = res.pass ? "PASS" : "FAIL";
        console.log(`[replay]   ${status} — ${res.failures.length} failure(s), ${res.errors.length} error(s)`);
      }
    } catch (e: any) {
      results.push({
        scenarioId: scenario.id,
        name: scenario.name,
        testSymbol: scenario.testSymbol,
        pass: false,
        failures: [`uncaught harness error: ${String(e?.message || e)}`],
        alerts: [],
        fills: [],
        brokerCalls: [],
        errors: [mkError(scenario.id, "engine-eval", null, scenario.testSymbol, e)],
        expect: scenario.expect ?? null,
        observed: {
          formingAlerts: 0,
          entryAlerts: 0,
          invalidatedAlerts: 0,
          skippedLowRisk: 0,
          firstDir: null,
          firstLevel: null,
          finalExitReason: null,
        },
        skippedEntries: [],
      });
    }
  }

  const finishedAt = Date.now();

  // Optional agent review pass — only if explicitly enabled AND an API key is set.
  let agentReview: string | null = null;
  let agentEnabled = false;
  if (opts.enableAgentReview && (process.env.OPENAI_API_KEY || process.env.AGENT_OPENAI_API_KEY)) {
    agentEnabled = true;
    try {
      agentReview = await runAgentReview(results);
    } catch (e: any) {
      agentReview = `[agent review failed: ${String(e?.message || e)}]`;
    }
  } else if (opts.enableAgentReview) {
    agentReview = "[agent review skipped: no OPENAI_API_KEY in env]";
  }

  return {
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    agentEnabled,
    agentReview,
    scenarioResults: results,
    totals: {
      scenarios: results.length,
      passed: results.filter((r) => r.pass).length,
      failed: results.filter((r) => !r.pass).length,
      alerts: results.reduce((acc, r) => acc + r.alerts.length, 0),
      fills: results.reduce((acc, r) => acc + r.fills.length, 0),
      brokerCalls: results.reduce((acc, r) => acc + r.brokerCalls.length, 0),
      errors: results.reduce((acc, r) => acc + r.errors.length, 0),
    },
  };
}

/**
 * Minimal agent review: hand the results to the OpenAI Responses API and ask
 * for a short critique. Avoids importing AiOperatorService directly because
 * that requires a Database + saveRules deps wiring.
 */
async function runAgentReview(results: ScenarioResult[]): Promise<string> {
  const apiKey = process.env.AGENT_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (!apiKey) return "[no api key]";

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.AGENT_OPENAI_MODEL || "gpt-4o-mini";

  const summary = results.map((r) => ({
    id: r.scenarioId,
    pass: r.pass,
    failures: r.failures,
    observed: r.observed,
    errors: r.errors.map((e) => ({ phase: e.phase, message: e.message })),
  }));

  const systemPrompt = [
    "You are reviewing a controlled replay run of a live trading system.",
    "Each scenario had specific expectations. Tell the engineer:",
    "1) which scenarios indicate real bugs vs intentional behavior,",
    "2) the most likely root cause for any failure,",
    "3) what to test next. Be terse — bullet points only.",
  ].join(" ");

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: JSON.stringify(summary, null, 2) }] },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return `[agent http ${res.status}: ${detail.slice(0, 200)}]`;
  }

  const payload: any = await res.json();
  const outputs: any[] = Array.isArray(payload?.output) ? payload.output : [];
  const parts: string[] = [];
  for (const item of outputs) {
    if (item?.type !== "message" || !Array.isArray(item?.content)) continue;
    for (const content of item.content) {
      if (content?.type === "output_text" && typeof content?.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim() || "[empty agent response]";
}
