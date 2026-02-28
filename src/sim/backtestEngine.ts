// src/sim/backtestEngine.ts
import { nyDayKey, nyPartsFromMs, isRegularSessionNY } from "../market/time";

/**
 * Timeframes supported by backtest engine.
 * NOTE: We still fetch canonical 1m bars, then resample to requested timeframe.
 */
export type Timeframe = "1m" | "2m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

/**
 * Level source presets:
 * - DAILY: uses PMH/PML/PDH/PDL (existing behavior)
 * - REPEAT: uses repeat S/R levels derived from recent price touches
 * - BOTH: union of DAILY + REPEAT
 */
export type LevelSourcePreset = "DAILY" | "REPEAT" | "BOTH";

/**
 * Entry mode:
 * - BREAK: enter on breakout close (fill next candle open)
 * - BREAK_RETEST: break then retest then confirm (existing behavior)
 * - RETEST: enter on retest/hold without requiring a prior break
 */
export type EntryMode = "BREAK" | "BREAK_RETEST" | "RETEST";

/**
 * Repeat S/R parameters:
 * tolerancePct: how close counts as a touch (percent of level price)
 * touchCount: how many touches to qualify
 * lookbackBars: how many prior candles to scan (no lookahead)
 */
export type RepeatSrConfig = {
  tolerancePct: number; // e.g. 0.05 = 0.05%
  touchCount: number; // e.g. 3
  lookbackBars: number; // e.g. 150
};

export type BacktestConfig = {
  tickers: string[];
  timeframe: Timeframe;
  startDate: string; // YYYY-MM-DD (America/New_York)
  endDate: string; // YYYY-MM-DD (America/New_York)

  // Strategy tagging (safe metadata only)
  strategyVersion?: number;
  strategyName?: string;

  // NEW: support/resistance + entry behavior (backend only; UI can be wired later)
  levelSource?: LevelSourcePreset; // default "DAILY"
  entryMode?: EntryMode; // default "BREAK_RETEST"
  repeatSr?: Partial<RepeatSrConfig>; // only used when levelSource includes REPEAT
};

export type Candle = {
  ticker: string;
  ts: number; // UTC ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type DailyLevels = {
  day: string; // NY day key
  preHigh: number | null;
  preLow: number | null;
  priorRthHigh: number | null;
  priorRthLow: number | null;
};

export type LevelKey = "PMH" | "PML" | "PDH" | "PDL" | "RR";

export type ResolvedLevel = {
  key: LevelKey;
  price: number;

  // for repeat levels we include a stable id for "one level per day" gating
  levelId?: string;
};

export type TradeDir = "LONG" | "SHORT";
export type ExitReason = "STOP" | "TARGET" | "EOD";

export type SimTrade = {
  ticker: string;
  dir: TradeDir;
  levelKey: LevelKey;
  levelPrice: number;
  entryTs: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  exitTs: number;
  exitPrice: number;
  exitReason: ExitReason;
  rMult: number;
  barsHeld: number;
  meta?: Record<string, any>;
};

export type BacktestMetrics = {
  totalTrades: number;
  winRate: number;        // 0..1
  avgR: number;           // avg R per trade
  expectancy: number;     // expected R per trade (using win/loss components)
  profitFactor: number;
  maxDrawdown: number;

  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldBars: number;

  // NEW (safe additions for UI later)
  avgWinR?: number;
  avgLossR?: number;      // positive number (absolute loss size in R)
  sharpe?: number;        // per-trade Sharpe-like (not annualized)
  stdR?: number;
};

export type EquityPoint = { ts: number; equity: number; drawdown: number };

export function runBacktest(args: {
  config: BacktestConfig;
  candlesByTicker: Record<string, Candle[]>; // 1m candles (canonical)
}) {
  const { config, candlesByTicker } = args;

  const allTrades: SimTrade[] = [];

  const runMeta: any = {
    timeframe: config.timeframe,
    tickers: config.tickers,
    startDate: config.startDate,
    endDate: config.endDate,

    strategyVersion: config.strategyVersion ?? null,
    strategyName: config.strategyName ?? null,

    levelSource: config.levelSource ?? "DAILY",
    entryMode: config.entryMode ?? "BREAK_RETEST",
    repeatSr: normalizeRepeatSr(config.repeatSr)
  };

  for (const ticker of config.tickers) {
    const c1m = candlesByTicker[ticker] || [];
    if (!c1m.length) continue;

    const daily = computeDailyLevels(c1m);

    // resample from canonical 1m into requested timeframe (engine reads all candle types)
    const simCandles = resampleToTimeframe(c1m, config.timeframe);

    const vwap = computeVWAP(simCandles);

    const trades = simulateStrategy({
      ticker,
      candles: simCandles,
      dailyLevels: daily,
      vwap,
      timeframe: config.timeframe,
      levelSource: config.levelSource ?? "DAILY",
      entryMode: config.entryMode ?? "BREAK_RETEST",
      repeatSr: normalizeRepeatSr(config.repeatSr)
    });

    allTrades.push(...trades);
  }

  // deterministic ordering
  allTrades.sort((a, b) => a.entryTs - b.entryTs || a.ticker.localeCompare(b.ticker));

  const metrics = calculateMetrics(allTrades);
  const equity = generateEquityCurve(allTrades);

  return { trades: allTrades, metrics, equity, meta: runMeta };
}

// ------------------------------------------------------------
// Levels (derived from canonical 1m candles)
// ------------------------------------------------------------
export function computeDailyLevels(candles: Candle[]): Record<string, DailyLevels> {
  const byDay: Record<
    string,
    { preHigh: number | null; preLow: number | null; rthHigh: number | null; rthLow: number | null }
  > = {};

  for (const c of candles) {
    const day = nyDayKey(c.ts);
    const p = nyPartsFromMs(c.ts);
    const mins = p.hh * 60 + p.mm;
    const isPre = mins >= 4 * 60 && mins < 9 * 60 + 30;
    const isRth = mins >= 9 * 60 + 30 && mins < 16 * 60;

    if (!byDay[day]) byDay[day] = { preHigh: null, preLow: null, rthHigh: null, rthLow: null };
    const d = byDay[day];

    if (isPre) {
      d.preHigh = d.preHigh == null ? c.high : Math.max(d.preHigh, c.high);
      d.preLow = d.preLow == null ? c.low : Math.min(d.preLow, c.low);
    }
    if (isRth) {
      d.rthHigh = d.rthHigh == null ? c.high : Math.max(d.rthHigh, c.high);
      d.rthLow = d.rthLow == null ? c.low : Math.min(d.rthLow, c.low);
    }
  }

  const days = Object.keys(byDay).sort();
  const out: Record<string, DailyLevels> = {};
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const cur = byDay[day];
    const prev = i > 0 ? byDay[days[i - 1]] : null;
    out[day] = {
      day,
      preHigh: cur.preHigh,
      preLow: cur.preLow,
      priorRthHigh: prev ? prev.rthHigh : null,
      priorRthLow: prev ? prev.rthLow : null
    };
  }
  return out;
}

// ------------------------------------------------------------
// VWAP (intraday cumulative, RTH only)
// ------------------------------------------------------------
export function computeVWAP(candles: Candle[]): Map<number, number> {
  const out = new Map<number, number>();
  let curDay: string | null = null;
  let pv = 0;
  let vol = 0;

  for (const c of candles) {
    const day = nyDayKey(c.ts);
    if (day !== curDay) {
      curDay = day;
      pv = 0;
      vol = 0;
    }
    if (!isRegularSessionNY(c.ts)) continue;

    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * (c.volume || 0);
    vol += c.volume || 0;
    if (vol > 0) out.set(c.ts, pv / vol);
  }
  return out;
}

// ------------------------------------------------------------
// Resampling (from 1m candles)
// ------------------------------------------------------------
const TF_TO_MINUTES: Record<Exclude<Timeframe, "1d" | "1w">, number> = {
  "1m": 1,
  "2m": 2,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240
};

export function resampleToTimeframe(candles1m: Candle[], tf: Timeframe): Candle[] {
  if (tf === "1m") return candles1m;

  if (tf === "1d") return resampleToNyDayRth(candles1m);
  if (tf === "1w") return resampleToNyWeekRth(candles1m);

  const mins = TF_TO_MINUTES[tf as Exclude<Timeframe, "1d" | "1w">];
  if (!Number.isFinite(mins) || mins <= 1) return candles1m;
  return resampleToMinutes(candles1m, mins);
}

export function resampleTo5m(candles1m: Candle[]): Candle[] {
  return resampleToMinutes(candles1m, 5);
}

export function resampleToMinutes(candles1m: Candle[], minutes: number): Candle[] {
  const out: Candle[] = [];
  const bucketMs = Math.max(1, Math.floor(minutes)) * 60_000;

  let cur: Candle | null = null;
  let curBucket = 0;

  for (const c of candles1m) {
    const b = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || b !== curBucket || c.ticker !== cur.ticker) {
      if (cur) out.push(cur);
      curBucket = b;
      cur = {
        ticker: c.ticker,
        ts: b,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }

  if (cur) out.push(cur);
  return out;
}

/**
 * Daily candle built from RTH-only 1m bars.
 * Important: set ts to last included RTH candle so isRegularSessionNY(ts) stays true.
 */
function resampleToNyDayRth(candles1m: Candle[]): Candle[] {
  const out: Candle[] = [];
  let curDay: string | null = null;
  let cur: Candle | null = null;

  for (const c of candles1m) {
    if (!isRegularSessionNY(c.ts)) continue;
    const day = nyDayKey(c.ts);

    if (!cur || day !== curDay || c.ticker !== cur.ticker) {
      if (cur) out.push(cur);
      curDay = day;
      cur = {
        ticker: c.ticker,
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      cur.ts = c.ts; // keep last RTH ts
    }
  }

  if (cur) out.push(cur);
  return out;
}

function weekKeyFromNyDay(dayKey: string): string {
  // convert YYYY-MM-DD to a stable "week key" anchored to Monday (UTC calc on date only)
  const [yy, mm, dd] = dayKey.split("-").map((x) => Number(x));
  const utc = Date.UTC(yy, mm - 1, dd, 0, 0, 0, 0);
  const d = new Date(utc);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const offset = (dow + 6) % 7; // Mon=0
  const monday = utc - offset * 24 * 60 * 60_000;
  const md = new Date(monday);
  const y = md.getUTCFullYear();
  const m = String(md.getUTCMonth() + 1).padStart(2, "0");
  const da = String(md.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

/**
 * Weekly candle built from RTH-only 1m bars. ts stays within RTH.
 */
function resampleToNyWeekRth(candles1m: Candle[]): Candle[] {
  const out: Candle[] = [];
  let curWeek: string | null = null;
  let cur: Candle | null = null;

  for (const c of candles1m) {
    if (!isRegularSessionNY(c.ts)) continue;
    const wk = weekKeyFromNyDay(nyDayKey(c.ts));

    if (!cur || wk !== curWeek || c.ticker !== cur.ticker) {
      if (cur) out.push(cur);
      curWeek = wk;
      cur = {
        ticker: c.ticker,
        ts: c.ts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
      cur.ts = c.ts; // last RTH ts
    }
  }

  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------
// Repeat S/R (no lookahead)
// ------------------------------------------------------------
type RepeatLevel = {
  id: string;
  price: number; // representative price
  touches: number;
};

function normalizeRepeatSr(inp?: Partial<RepeatSrConfig>): RepeatSrConfig {
  const tol = Number(inp?.tolerancePct);
  const touches = Number(inp?.touchCount);
  const lookback = Number(inp?.lookbackBars);

  return {
    tolerancePct: Number.isFinite(tol) && tol > 0 ? tol : 0.05, // 0.05%
    touchCount: Number.isFinite(touches) && touches >= 2 ? Math.floor(touches) : 3,
    lookbackBars: Number.isFinite(lookback) && lookback >= 20 ? Math.floor(lookback) : 150
  };
}

/**
 * Build repeat S/R levels from PRIOR candles only:
 * - window = [i - lookbackBars, i-1]
 * - count touches when candle high/low is within tolerance of an existing level
 * - cluster by incremental averaging
 *
 * Returns levels meeting touchCount threshold.
 */
function computeRepeatLevelsNoLookahead(
  candles: Candle[],
  i: number,
  cfg: RepeatSrConfig
): RepeatLevel[] {
  const end = Math.max(0, Math.min(candles.length, i));
  const start = Math.max(0, end - cfg.lookbackBars);
  if (end - start < Math.max(5, cfg.touchCount)) return [];

  const levels: Array<{ price: number; touches: number }> = [];

  function tolAbs(price: number) {
    return Math.max(1e-9, (Math.abs(price) * cfg.tolerancePct) / 100);
  }

  function addTouch(px: number) {
    if (!Number.isFinite(px) || px <= 0) return;

    // find nearest within tolerance
    let bestIdx = -1;
    let bestDist = Infinity;

    for (let j = 0; j < levels.length; j++) {
      const L = levels[j];
      const dist = Math.abs(px - L.price);
      if (dist <= tolAbs(L.price) && dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }

    if (bestIdx >= 0) {
      // update cluster price as running average
      const L = levels[bestIdx];
      const n = L.touches + 1;
      L.price = (L.price * L.touches + px) / n;
      L.touches = n;
    } else {
      levels.push({ price: px, touches: 1 });
    }
  }

  for (let k = start; k < end; k++) {
    const c = candles[k];
    // only use RTH candles for intraday S/R so it matches engine trading window
    if (!isRegularSessionNY(c.ts)) continue;

    addTouch(Number(c.high));
    addTouch(Number(c.low));
  }

  // qualify
  const qualified = levels
    .filter((L) => L.touches >= cfg.touchCount)
    .sort((a, b) => b.touches - a.touches || a.price - b.price)
    .slice(0, 12) // cap to avoid excessive per-candle loops
    .map((L, idx) => ({
      id: `RR_${idx}_${L.price.toFixed(2)}`,
      price: L.price,
      touches: L.touches
    }));

  return qualified;
}

// ------------------------------------------------------------
// Strategy simulator (no lookahead)
// Signal on close, fill next candle open.
// ------------------------------------------------------------
export function simulateStrategy(args: {
  ticker: string;
  candles: Candle[]; // timeframe candles
  dailyLevels: Record<string, DailyLevels>;
  vwap: Map<number, number>;
  timeframe: Timeframe;

  // NEW behavior controls (backend only)
  levelSource: LevelSourcePreset;
  entryMode: EntryMode;
  repeatSr: RepeatSrConfig;
}): SimTrade[] {
  const { ticker, candles, dailyLevels, levelSource, entryMode, repeatSr } = args;
  const trades: SimTrade[] = [];

  // One trade open max.
  let openTrade:
    | {
        dir: TradeDir;
        entryTs: number;
        entryPrice: number;
        stop: number;
        target: number;
        levelKey: LevelKey;
        levelPrice: number;
        levelId: string;
        entryIdx: number;
      }
    | null = null;
  let openBarsHeld = 0;

  // per day: prevent re-trading the same level
  const tradedLevelByDay: Record<string, Set<string>> = {};

  type SetupState = {
    phase: "IDLE" | "BROKE" | "RETEST";
    breakIdx: number;
    retestIdx: number;
    retestExtreme: number; // low for long, high for short
  };

  // state keys now include a unique per-level id string (PMH/PML/PDH/PDL or RR_*).
  const state: Record<string, Record<string, { long: SetupState; short: SetupState }>> = {};

  function ensureDayState(day: string) {
    if (!tradedLevelByDay[day]) tradedLevelByDay[day] = new Set<string>();
    if (!state[day]) state[day] = {};
  }

  function ensureLevelState(day: string, levelId: string) {
    ensureDayState(day);
    if (!state[day][levelId]) {
      state[day][levelId] = {
        long: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN },
        short: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN }
      };
    }
  }

  function resolveDailyLevels(day: string): ResolvedLevel[] {
    const d = dailyLevels[day];
    if (!d) return [];
    const lvls: Array<ResolvedLevel | null> = [
      d.preHigh != null ? { key: "PMH", price: d.preHigh, levelId: "PMH" } : null,
      d.preLow != null ? { key: "PML", price: d.preLow, levelId: "PML" } : null,
      d.priorRthHigh != null ? { key: "PDH", price: d.priorRthHigh, levelId: "PDH" } : null,
      d.priorRthLow != null ? { key: "PDL", price: d.priorRthLow, levelId: "PDL" } : null
    ];
    return lvls.filter(Boolean) as ResolvedLevel[];
  }

  function resolveLevelsForCandle(day: string, i: number): ResolvedLevel[] {
    const out: ResolvedLevel[] = [];

    if (levelSource === "DAILY" || levelSource === "BOTH") {
      out.push(...resolveDailyLevels(day));
    }

    if (levelSource === "REPEAT" || levelSource === "BOTH") {
      const rr = computeRepeatLevelsNoLookahead(candles, i, repeatSr);
      for (const L of rr) {
        out.push({
          key: "RR",
          price: L.price,
          levelId: L.id
        });
      }
    }

    return out;
  }

  function isAfter330(ts: number) {
    const p = nyPartsFromMs(ts);
    return p.hh * 60 + p.mm >= 15 * 60 + 30;
  }

  function isAtOrAfter355(ts: number) {
    const p = nyPartsFromMs(ts);
    return p.hh * 60 + p.mm >= 15 * 60 + 55;
  }

  function tolAbsForPrice(price: number) {
    // reuse repeat tolerance for "break-only" stop padding when needed
    const pct = Number(repeatSr.tolerancePct || 0.05);
    return Math.max(1e-9, (Math.abs(price) * pct) / 100);
  }

  // Iterate sequentially; never read future candles when deciding.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Only trade RTH candles.
    if (!isRegularSessionNY(c.ts)) continue;

    const day = nyDayKey(c.ts);
    ensureDayState(day);

    const levels = resolveLevelsForCandle(day, i);
    if (!levels.length) continue;

    // Manage open trade
    if (openTrade) {
      openBarsHeld++;

      const stopHit = openTrade.dir === "LONG" ? c.low <= openTrade.stop : c.high >= openTrade.stop;
      const tgtHit = openTrade.dir === "LONG" ? c.high >= openTrade.target : c.low <= openTrade.target;

      // Deterministic worst-case if both occur in same candle: assume STOP first.
      if (stopHit || tgtHit) {
        const exitReason: ExitReason = stopHit ? "STOP" : "TARGET";
        const exitPrice = stopHit ? openTrade.stop : openTrade.target;
        const r = computeR(openTrade.dir, openTrade.entryPrice, openTrade.stop, exitPrice);

        trades.push({
          ticker,
          dir: openTrade.dir,
          levelKey: openTrade.levelKey,
          levelPrice: openTrade.levelPrice,
          entryTs: openTrade.entryTs,
          entryPrice: openTrade.entryPrice,
          stopPrice: openTrade.stop,
          targetPrice: openTrade.target,
          exitTs: c.ts,
          exitPrice,
          exitReason,
          rMult: r,
          barsHeld: openBarsHeld,
          meta: {
            levelId: openTrade.levelId,
            entryMode,
            levelSource
          }
        });

        openTrade = null;
        openBarsHeld = 0;
      } else if (isAtOrAfter355(c.ts)) {
        const exitPrice = c.close;
        const r = computeR(openTrade.dir, openTrade.entryPrice, openTrade.stop, exitPrice);

        trades.push({
          ticker,
          dir: openTrade.dir,
          levelKey: openTrade.levelKey,
          levelPrice: openTrade.levelPrice,
          entryTs: openTrade.entryTs,
          entryPrice: openTrade.entryPrice,
          stopPrice: openTrade.stop,
          targetPrice: openTrade.target,
          exitTs: c.ts,
          exitPrice,
          exitReason: "EOD",
          rMult: r,
          barsHeld: openBarsHeld,
          meta: {
            levelId: openTrade.levelId,
            entryMode,
            levelSource
          }
        });

        openTrade = null;
        openBarsHeld = 0;
      }
    }

    // no overlapping trades
    if (openTrade) continue;
    if (isAfter330(c.ts)) continue;

    // Evaluate setups for each level (one trade per level per day)
    for (const L of levels) {
      const levelId = String(L.levelId || L.key);
      ensureLevelState(day, levelId);

      if (tradedLevelByDay[day].has(levelId)) continue;

      // ---------------------------
      // EntryMode: RETEST (no prior break required)
      // Long: candle touches/pierces level and closes back above -> enter next open
      // Short: candle touches/pierces level and closes back below -> enter next open
      // ---------------------------
      if (entryMode === "RETEST") {
        // LONG retest-hold
        if (c.low <= L.price && c.close > L.price) {
          const entryIdx = i + 1;
          if (entryIdx < candles.length) {
            const entryC = candles[entryIdx];
            if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
              const entryPrice = entryC.open;
              const stop = c.low; // use current candle extreme
              const risk = entryPrice - stop;
              if (Number.isFinite(risk) && risk > 0) {
                const target = entryPrice + 2 * risk;
                openTrade = {
                  dir: "LONG",
                  entryTs: entryC.ts,
                  entryPrice,
                  stop,
                  target,
                  levelKey: L.key,
                  levelPrice: L.price,
                  levelId,
                  entryIdx
                };
                openBarsHeld = 0;
                tradedLevelByDay[day].add(levelId);
              }
            }
          }
        }

        if (openTrade) break;

        // SHORT retest-hold
        if (c.high >= L.price && c.close < L.price) {
          const entryIdx = i + 1;
          if (entryIdx < candles.length) {
            const entryC = candles[entryIdx];
            if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
              const entryPrice = entryC.open;
              const stop = c.high;
              const risk = stop - entryPrice;
              if (Number.isFinite(risk) && risk > 0) {
                const target = entryPrice - 2 * risk;
                openTrade = {
                  dir: "SHORT",
                  entryTs: entryC.ts,
                  entryPrice,
                  stop,
                  target,
                  levelKey: L.key,
                  levelPrice: L.price,
                  levelId,
                  entryIdx
                };
                openBarsHeld = 0;
                tradedLevelByDay[day].add(levelId);
              }
            }
          }
        }

        if (openTrade) break;
        continue;
      }

      // ---------------------------
      // EntryMode: BREAK (enter on breakout close)
      // Uses a conservative stop around the level with tolerance padding.
      // ---------------------------
      if (entryMode === "BREAK") {
        // LONG break
        if (c.close > L.price) {
          const entryIdx = i + 1;
          if (entryIdx < candles.length) {
            const entryC = candles[entryIdx];
            if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
              const entryPrice = entryC.open;
              const stop = L.price - tolAbsForPrice(L.price);
              const risk = entryPrice - stop;
              if (Number.isFinite(risk) && risk > 0) {
                const target = entryPrice + 2 * risk;
                openTrade = {
                  dir: "LONG",
                  entryTs: entryC.ts,
                  entryPrice,
                  stop,
                  target,
                  levelKey: L.key,
                  levelPrice: L.price,
                  levelId,
                  entryIdx
                };
                openBarsHeld = 0;
                tradedLevelByDay[day].add(levelId);
              }
            }
          }
        }

        if (openTrade) break;

        // SHORT break
        if (c.close < L.price) {
          const entryIdx = i + 1;
          if (entryIdx < candles.length) {
            const entryC = candles[entryIdx];
            if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
              const entryPrice = entryC.open;
              const stop = L.price + tolAbsForPrice(L.price);
              const risk = stop - entryPrice;
              if (Number.isFinite(risk) && risk > 0) {
                const target = entryPrice - 2 * risk;
                openTrade = {
                  dir: "SHORT",
                  entryTs: entryC.ts,
                  entryPrice,
                  stop,
                  target,
                  levelKey: L.key,
                  levelPrice: L.price,
                  levelId,
                  entryIdx
                };
                openBarsHeld = 0;
                tradedLevelByDay[day].add(levelId);
              }
            }
          }
        }

        if (openTrade) break;
        continue;
      }

      // ---------------------------
      // EntryMode: BREAK_RETEST (existing behavior)
      // state machine per level
      // ---------------------------

      // LONG setup
      {
        const st = state[day][levelId].long;

        if (st.phase === "IDLE") {
          if (c.close > L.price) {
            st.phase = "BROKE";
            st.breakIdx = i;
            st.retestIdx = -1;
            st.retestExtreme = NaN;
          }
        } else if (st.phase === "BROKE") {
          // retest = touch/pierce level
          if (c.low <= L.price) {
            st.phase = "RETEST";
            st.retestIdx = i;
            st.retestExtreme = c.low;
          }
        } else if (st.phase === "RETEST") {
          // confirmation: close back above
          if (c.close > L.price) {
            const retestLow = st.retestExtreme;
            const entryIdx = i + 1;

            if (entryIdx < candles.length) {
              const entryC = candles[entryIdx];
              if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
                const entryPrice = entryC.open;
                const stop = retestLow;
                const risk = entryPrice - stop;
                if (Number.isFinite(risk) && risk > 0) {
                  const target = entryPrice + 2 * risk;
                  openTrade = {
                    dir: "LONG",
                    entryTs: entryC.ts,
                    entryPrice,
                    stop,
                    target,
                    levelKey: L.key,
                    levelPrice: L.price,
                    levelId,
                    entryIdx
                  };
                  openBarsHeld = 0;
                  tradedLevelByDay[day].add(levelId);
                }
              }
            }

            // reset regardless
            st.phase = "IDLE";
          } else {
            // keep updating retest low while in retest phase
            st.retestExtreme = Math.min(st.retestExtreme, c.low);
          }
        }
      }

      if (openTrade) break;

      // SHORT setup
      {
        const st = state[day][levelId].short;

        if (st.phase === "IDLE") {
          if (c.close < L.price) {
            st.phase = "BROKE";
            st.breakIdx = i;
            st.retestIdx = -1;
            st.retestExtreme = NaN;
          }
        } else if (st.phase === "BROKE") {
          if (c.high >= L.price) {
            st.phase = "RETEST";
            st.retestIdx = i;
            st.retestExtreme = c.high;
          }
        } else if (st.phase === "RETEST") {
          if (c.close < L.price) {
            const retestHigh = st.retestExtreme;
            const entryIdx = i + 1;

            if (entryIdx < candles.length) {
              const entryC = candles[entryIdx];
              if (isRegularSessionNY(entryC.ts) && !isAfter330(entryC.ts)) {
                const entryPrice = entryC.open;
                const stop = retestHigh;
                const risk = stop - entryPrice;
                if (Number.isFinite(risk) && risk > 0) {
                  const target = entryPrice - 2 * risk;
                  openTrade = {
                    dir: "SHORT",
                    entryTs: entryC.ts,
                    entryPrice,
                    stop,
                    target,
                    levelKey: L.key,
                    levelPrice: L.price,
                    levelId,
                    entryIdx
                  };
                  openBarsHeld = 0;
                  tradedLevelByDay[day].add(levelId);
                }
              }
            }

            st.phase = "IDLE";
          } else {
            st.retestExtreme = Math.max(st.retestExtreme, c.high);
          }
        }
      }

      if (openTrade) break;
    }
  }

  return trades;
}

function computeR(dir: TradeDir, entry: number, stop: number, exit: number): number {
  const risk = dir === "LONG" ? entry - stop : stop - entry;
  if (!Number.isFinite(risk) || risk <= 0) return 0;
  const pnl = dir === "LONG" ? exit - entry : entry - exit;
  return pnl / risk;
}

// ------------------------------------------------------------
// Metrics + equity curve
// ------------------------------------------------------------
export function calculateMetrics(trades: SimTrade[]): BacktestMetrics {
  const totalTrades = trades.length;
  if (!totalTrades) {
    return {
      totalTrades: 0,
      winRate: 0,
      avgR: 0,
      expectancy: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      avgHoldBars: 0
    };
  }

  let wins = 0;
  let losses = 0;

  let sumR = 0;
  let grossWin = 0;
  let grossLoss = 0; // this is ABS loss sum (positive)
  let sumHold = 0;

  let winStreak = 0;
  let lossStreak = 0;
  let longestWinStreak = 0;
  let longestLossStreak = 0;

  for (const t of trades) {
    const r = Number(t.rMult || 0);
    sumR += r;
    sumHold += Number(t.barsHeld || 0);
    if (r > 0) {
      wins++;
      grossWin += r;
      winStreak++;
      lossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, winStreak);
    } else if (r < 0) {
      losses++;
      grossLoss += Math.abs(r);
      lossStreak++;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    } else {
      winStreak = 0;
      lossStreak = 0;
    }
  }

  const winRate = wins / totalTrades;
  const avgR = sumR / totalTrades;

  // --- NEW: avg win/loss + expectancy components (in R) ---
  const avgWinR = wins > 0 ? grossWin / wins : 0;

  // grossLoss is already ABS loss sum (positive)
  const avgLossR = losses > 0 ? (grossLoss / losses) : 0;

  // expectancy = P(win)*AvgWin - P(loss)*AvgLoss
  const expectancy = winRate * avgWinR - (1 - winRate) * avgLossR;

  // --- NEW: per-trade Sharpe-like using R-multiples ---
  const rSeries = trades.map((t) => Number(t.rMult || 0)).filter(Number.isFinite);
  const meanR = avgR;

  let varR = 0;
  for (const r of rSeries) varR += (r - meanR) * (r - meanR);
  varR = rSeries.length > 1 ? varR / (rSeries.length - 1) : 0;

  const stdR = Math.sqrt(Math.max(0, varR));
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(rSeries.length) : 0;

  const profitFactor = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0);

  const equity = generateEquityCurve(trades);
  let maxDrawdown = 0;
  for (const p of equity) maxDrawdown = Math.min(maxDrawdown, p.drawdown);

  return {
    totalTrades,
    winRate,
    avgR,
    expectancy,
    profitFactor,
    maxDrawdown,
    longestWinStreak,
    longestLossStreak,
    avgHoldBars: sumHold / totalTrades,
  
    // NEW
    avgWinR,
    avgLossR,
    stdR,
    sharpe
  };
}

export function generateEquityCurve(trades: SimTrade[]): EquityPoint[] {
  const sorted = trades.slice().sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);
  const out: EquityPoint[] = [];
  let equity = 0;
  let peak = 0;

  for (const t of sorted) {
    equity += Number(t.rMult || 0);
    peak = Math.max(peak, equity);
    const dd = equity - peak; // <= 0
    out.push({ ts: t.exitTs, equity, drawdown: dd });
  }
  return out;
}

// Simple rolling-mean smoother for equity curve (UI can plot this later)
export function smoothEquityCurve(points: EquityPoint[], window = 7): EquityPoint[] {
  const w = Math.max(1, Math.floor(window));
  if (!points.length || w === 1) return points.slice();

  const eq = points.map((p) => p.equity);
  const out: EquityPoint[] = [];

  let peak = -Infinity;

  for (let i = 0; i < points.length; i++) {
    const start = Math.max(0, i - w + 1);
    let sum = 0;
    let n = 0;
    for (let j = start; j <= i; j++) {
      sum += eq[j];
      n++;
    }
    const sm = sum / Math.max(1, n);

    peak = Math.max(peak, sm);
    const dd = sm - peak;

    out.push({ ts: points[i].ts, equity: sm, drawdown: dd });
  }

  return out;
}