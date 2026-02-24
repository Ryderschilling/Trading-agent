import { nyDayKey, nyPartsFromMs, isRegularSessionNY } from "../market/time";

export type Timeframe = "1m" | "5m";

export type BacktestConfig = {
  tickers: string[];
  timeframe: Timeframe;
  startDate: string; // YYYY-MM-DD (America/New_York)
  endDate: string; // YYYY-MM-DD (America/New_York)
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

export type LevelKey = "PMH" | "PML" | "PDH" | "PDL";

export type ResolvedLevel = {
  key: LevelKey;
  price: number;
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
  winRate: number;
  avgR: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  longestWinStreak: number;
  longestLossStreak: number;
  avgHoldBars: number;
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
    endDate: config.endDate
  };

  for (const ticker of config.tickers) {
    const c1m = candlesByTicker[ticker] || [];
    if (!c1m.length) continue;

    const daily = computeDailyLevels(c1m);
    const simCandles = config.timeframe === "5m" ? resampleTo5m(c1m) : c1m;
    const vwap = computeVWAP(simCandles);

    const trades = simulateStrategy({
      ticker,
      candles: simCandles,
      dailyLevels: daily,
      vwap,
      timeframe: config.timeframe
    });

    allTrades.push(...trades);
  }

  // Deterministic ordering
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
  // key: candle.ts -> vwap value at close
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
// Resampling
// ------------------------------------------------------------
export function resampleTo5m(candles1m: Candle[]): Candle[] {
  const out: Candle[] = [];
  const bucketMs = 5 * 60_000;

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
}): SimTrade[] {
  const { ticker, candles, dailyLevels } = args;
  const trades: SimTrade[] = [];

  // One trade open max across all levels.
  let openTrade:
    | {
        dir: TradeDir;
        entryTs: number;
        entryPrice: number;
        stop: number;
        target: number;
        levelKey: LevelKey;
        levelPrice: number;
        entryIdx: number;
      }
    | null = null;
  let openBarsHeld = 0;

  // per day: prevent re-trading the same level
  const tradedLevelByDay: Record<string, Set<LevelKey>> = {};

  type SetupState = {
    phase: "IDLE" | "BROKE" | "RETEST";
    breakIdx: number;
    retestIdx: number;
    retestExtreme: number; // low for long, high for short
  };

  const state: Record<string, Record<LevelKey, { long: SetupState; short: SetupState }>> = {};

  function ensureDayState(day: string) {
    if (!tradedLevelByDay[day]) tradedLevelByDay[day] = new Set<LevelKey>();
    if (!state[day]) {
      state[day] = {
        PMH: {
          long: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN },
          short: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN }
        },
        PML: {
          long: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN },
          short: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN }
        },
        PDH: {
          long: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN },
          short: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN }
        },
        PDL: {
          long: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN },
          short: { phase: "IDLE", breakIdx: -1, retestIdx: -1, retestExtreme: NaN }
        }
      };
    }
  }

  function resolveLevels(day: string): ResolvedLevel[] {
    const d = dailyLevels[day];
    if (!d) return [];
    const lvls: Array<ResolvedLevel | null> = [
      d.preHigh != null ? { key: "PMH", price: d.preHigh } : null,
      d.preLow != null ? { key: "PML", price: d.preLow } : null,
      d.priorRthHigh != null ? { key: "PDH", price: d.priorRthHigh } : null,
      d.priorRthLow != null ? { key: "PDL", price: d.priorRthLow } : null
    ];
    return lvls.filter(Boolean) as ResolvedLevel[];
  }

  function isAfter330(ts: number) {
    const p = nyPartsFromMs(ts);
    return p.hh * 60 + p.mm >= 15 * 60 + 30;
  }

  function isAtOrAfter355(ts: number) {
    const p = nyPartsFromMs(ts);
    return p.hh * 60 + p.mm >= 15 * 60 + 55;
  }

  // Iterate sequentially; never read future candles when deciding.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Only trade RTH candles.
    if (!isRegularSessionNY(c.ts)) {
      continue;
    }

    const day = nyDayKey(c.ts);
    ensureDayState(day);
    const dayLevels = resolveLevels(day);
    if (!dayLevels.length) continue;

    // EOD force-exit at 15:55 close
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
          barsHeld: openBarsHeld
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
          barsHeld: openBarsHeld
        });

        openTrade = null;
        openBarsHeld = 0;
      }
    }

    // no overlapping trades
    if (openTrade) continue;
    if (isAfter330(c.ts)) continue;

    // Evaluate setups for each level (one trade per level per day)
    for (const L of dayLevels) {
      const key = L.key;
      if (tradedLevelByDay[day].has(key)) continue;

      // Long setup against this level
      {
        const st = state[day][key].long;
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
                    levelKey: key,
                    levelPrice: L.price,
                    entryIdx
                  };
                  openBarsHeld = 0;
                  tradedLevelByDay[day].add(key);
                }
              }
            }
            // reset state regardless
            st.phase = "IDLE";
          } else {
            // keep updating retest low while in retest phase
            st.retestExtreme = Math.min(st.retestExtreme, c.low);
          }
        }
      }

      if (openTrade) break; // no overlap

      // Short setup against this level
      {
        const st = state[day][key].short;
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
                    levelKey: key,
                    levelPrice: L.price,
                    entryIdx
                  };
                  openBarsHeld = 0;
                  tradedLevelByDay[day].add(key);
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
  let sumR = 0;
  let grossWin = 0;
  let grossLoss = 0;
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
      grossLoss += Math.abs(r);
      lossStreak++;
      winStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, lossStreak);
    } else {
      // flat counts toward breaking streaks
      winStreak = 0;
      lossStreak = 0;
    }
  }

  const winRate = wins / totalTrades;
  const avgR = sumR / totalTrades;
  const expectancy = avgR; // R-expectancy per trade
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // drawdown computed from equity curve
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
    avgHoldBars: sumHold / totalTrades
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