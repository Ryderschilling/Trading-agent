/**
 * Day Regime Tracker  (observer only — never gates or alters order flow)
 * ---------------------------------------------------------------------
 * Once per session, shortly after 09:35 ET, this records two things that the
 * 116-day study on 2026-08-04 showed matter:
 *
 *   1. MARKET VOL SCORE — z(QQQ prev-day range) + z(QQQ 09:30–09:34 range)
 *      + z(QQQ 5-day avg range). Over 116 days this was monotonic across all
 *      five quintiles against "share of watchlist symbols that run +2.5% from
 *      09:36": Q1 13.4% -> Q5 3.3%, and the quietest quintile produced zero
 *      big-runner days in a full year. It predicts that the day will be BIG.
 *      It does NOT predict direction (best directional correlate found was
 *      r = 0.154) and it does NOT predict profit (2026-07-31 scored the 96th
 *      percentile and v11 lost 7.17%). Treat it as a sizing signal only.
 *
 *   2. SYMBOL RANK — each watchlist symbol scored by (own 5-day avg range %)
 *      + (own 09:30–09:34 range %). On 2026-08-03 the agent traded the mega
 *      caps while COIN/HOOD/MU/AMD/NVDA ran 4.7–7.1% and it lost money; on
 *      2026-08-04 it caught PLTR/SMCI and made its best day ever. Symbol
 *      selection, not day type, was the difference. Only 8 days of full
 *      20-symbol candle coverage exist, so this rank is UNPROVEN and is
 *      recorded to be judged forward, not acted on.
 *
 * Nothing in this file is read by the signal engine, the broker layer, or any
 * cap. Removing it changes zero trades.
 */

import type Database from "better-sqlite3";
import { nyDayKey, nyPartsFromMs } from "../market/time";

export const REGIME_SNAPSHOT_MIN = 9 * 60 + 35; // 09:35 ET
const RANK_TOP_N = 5;
const LOOKBACK_DAYS = 5;

export type SymbolRank = {
  symbol: string;
  score: number;      // atr5Pct + or5Pct, both as fractions of price
  atr5Pct: number;    // 5-day avg (high-low)/close
  or5Pct: number;     // (high-low) of 09:30–09:34 / session open
  gapPct: number;     // signed open vs prior close
  rank: number;       // 1 = most likely to move
  inTop: 0 | 1;
};

export type DayRegime = {
  dayKey: string;
  computedTs: number;
  volScore: number | null;
  volQuintile: number | null;   // 1 = most volatile, 5 = quietest
  prevRngPct: number | null;
  or5RngPct: number | null;
  atr5Pct: number | null;
  ranks: SymbolRank[];
  topSymbols: string[];
  note?: string;
};

/* --------------------------------------------------------------------- */
/* schema                                                                 */
/* --------------------------------------------------------------------- */

export function ensureDayRegimeTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_regime (
      day_key       TEXT PRIMARY KEY,
      computed_ts   INTEGER NOT NULL,
      vol_score     REAL,
      vol_quintile  INTEGER,
      prev_rng_pct  REAL,
      or5_rng_pct   REAL,
      atr5_pct      REAL,
      top_symbols   TEXT,
      ranks_json    TEXT,
      note          TEXT
    );
  `);
}

/* --------------------------------------------------------------------- */
/* candle helpers — all reads, all bounded                                */
/* --------------------------------------------------------------------- */

type DayBars = { open: number; high: number; low: number; close: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const RTH_MINUTES = 6 * 60 + 30; // 09:30 -> 16:00

/**
 * Epoch ms of 09:30 ET on the NY day containing `ts`. Bar timestamps are
 * minute-aligned from the feed, so walking back by the minute offset is exact
 * and stays correct across the DST boundary (nyPartsFromMs is TZ-aware).
 */
function sessionOpenMs(ts: number): number {
  const p = nyPartsFromMs(ts);
  const minsNow = p.hh * 60 + p.mm;
  return ts - (minsNow - (9 * 60 + 30)) * 60_000;
}

/**
 * OHLC for one symbol over one session window, via the (ticker, ts) primary
 * key. Range-scoped on purpose: an earlier version derived day boundaries with
 * strftime() over the whole table, which full-scanned ~1M rows per symbol and
 * would have stalled the bar handler at 09:35.
 */
function barsInWindow(
  db: Database.Database,
  symbol: string,
  fromMs: number,
  toMs: number
): DayBars | null {
  const row = db
    .prepare(
      `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, MAX(high) AS h, MIN(low) AS l, COUNT(*) AS n
         FROM candles_1m
        WHERE ticker = ? AND session = 'RTH' AND ts >= ? AND ts <= ?`
    )
    .get(symbol, fromMs, toMs) as any;
  if (!row || !row.n) return null;

  const o = db.prepare(`SELECT open FROM candles_1m WHERE ticker=? AND ts=?`).get(symbol, row.first_ts) as any;
  const c = db.prepare(`SELECT close FROM candles_1m WHERE ticker=? AND ts=?`).get(symbol, row.last_ts) as any;
  if (!o || !c) return null;

  return { open: Number(o.open), high: Number(row.h), low: Number(row.l), close: Number(c.close) };
}

/**
 * The `limit` most recent session windows strictly before `todayOpenMs`.
 * Walks back calendar days and keeps the ones that actually have QQQ bars, so
 * weekends and holidays fall out without a calendar table. Capped at 20 look-
 * back days so a long market closure can't spin.
 */
function priorSessionWindows(
  db: Database.Database,
  todayOpenMs: number,
  limit: number
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (let back = 1; back <= 20 && out.length < limit; back++) {
    const from = todayOpenMs - back * DAY_MS;
    const to = from + RTH_MINUTES * 60_000;
    const probe = db
      .prepare(`SELECT 1 FROM candles_1m WHERE ticker='QQQ' AND session='RTH' AND ts>=? AND ts<=? LIMIT 1`)
      .get(from, to);
    if (probe) out.push({ from, to });
  }
  return out; // most recent first
}

/** Prior-session daily bars for one symbol, most recent first. */
function recentDailyBars(
  db: Database.Database,
  symbol: string,
  windows: Array<{ from: number; to: number }>
): DayBars[] {
  const out: DayBars[] = [];
  for (const w of windows) {
    const b = barsInWindow(db, symbol, w.from, w.to);
    if (b) out.push(b);
  }
  return out;
}

/** Session open plus 09:30-09:34 high/low/close. */
function openingRange(db: Database.Database, symbol: string, dayStartMs: number): DayBars | null {
  return barsInWindow(db, symbol, dayStartMs, dayStartMs + 5 * 60_000 - 1);
}

/* --------------------------------------------------------------------- */
/* scoring                                                                */
/* --------------------------------------------------------------------- */

/**
 * Quintile cutoffs for the composite vol score, fitted on 116 days of QQQ
 * data ending 2026-08-04. Hard-coded rather than recomputed so a quintile
 * label means the same thing every day. Re-fit if the watchlist or the data
 * window changes materially.
 */
const VOL_QUINTILE_CUTS = [1.92, 0.34, -0.98, -1.94]; // >=1.92 -> Q1, >=0.34 -> Q2, ...
const QQQ_NORM = {
  prevRng: { mean: 0.01268, sd: 0.00612 },
  or5Rng:  { mean: 0.00307, sd: 0.00206 },
  atr5:    { mean: 0.01296, sd: 0.00489 },
};

function z(v: number, n: { mean: number; sd: number }) {
  return n.sd > 0 ? (v - n.mean) / n.sd : 0;
}

export function volQuintile(score: number): number {
  for (let i = 0; i < VOL_QUINTILE_CUTS.length; i++) {
    if (score >= VOL_QUINTILE_CUTS[i]) return i + 1;
  }
  return 5;
}

/* --------------------------------------------------------------------- */
/* main entry                                                             */
/* --------------------------------------------------------------------- */

export function computeDayRegime(
  db: Database.Database,
  ts: number,
  watchlist: string[]
): DayRegime | null {
  const dayKey = nyDayKey(ts);
  const openMs = sessionOpenMs(ts);
  // One probe pass, reused for every symbol.
  const windows = priorSessionWindows(db, openMs, LOOKBACK_DAYS);
  if (!windows.length) return null;

  // --- market leg (QQQ) ---
  let volScore: number | null = null;
  let prevRngPct: number | null = null;
  let or5RngPct: number | null = null;
  let atr5Pct: number | null = null;

  const qqqPrev = recentDailyBars(db, "QQQ", windows);
  const qqqOr = openingRange(db, "QQQ", openMs);
  if (qqqPrev.length >= 3 && qqqOr && qqqOr.open > 0) {
    const p0 = qqqPrev[0];
    prevRngPct = p0.close > 0 ? (p0.high - p0.low) / p0.close : null;
    atr5Pct =
      qqqPrev.reduce((a, b) => a + (b.close > 0 ? (b.high - b.low) / b.close : 0), 0) / qqqPrev.length;
    or5RngPct = (qqqOr.high - qqqOr.low) / qqqOr.open;
    if (prevRngPct != null) {
      volScore =
        z(prevRngPct, QQQ_NORM.prevRng) + z(or5RngPct, QQQ_NORM.or5Rng) + z(atr5Pct, QQQ_NORM.atr5);
    }
  }

  // --- symbol leg ---
  const ranks: SymbolRank[] = [];
  for (const sym of watchlist) {
    const prev = recentDailyBars(db, sym, windows);
    const or5 = openingRange(db, sym, openMs);
    if (prev.length < 3 || !or5 || or5.open <= 0) continue;
    const a5 =
      prev.reduce((a, b) => a + (b.close > 0 ? (b.high - b.low) / b.close : 0), 0) / prev.length;
    const o5 = (or5.high - or5.low) / or5.open;
    const gap = prev[0].close > 0 ? or5.open / prev[0].close - 1 : 0;
    ranks.push({ symbol: sym, score: a5 + o5, atr5Pct: a5, or5Pct: o5, gapPct: gap, rank: 0, inTop: 0 });
  }
  ranks.sort((a, b) => b.score - a.score);
  ranks.forEach((r, i) => {
    r.rank = i + 1;
    r.inTop = i < RANK_TOP_N ? 1 : 0;
  });

  if (volScore == null && !ranks.length) return null;

  return {
    dayKey,
    computedTs: ts,
    volScore,
    volQuintile: volScore == null ? null : volQuintile(volScore),
    prevRngPct,
    or5RngPct,
    atr5Pct,
    ranks,
    topSymbols: ranks.filter((r) => r.inTop).map((r) => r.symbol),
    note: volScore == null ? "qqq data incomplete" : undefined,
  };
}

export function saveDayRegime(db: Database.Database, r: DayRegime) {
  ensureDayRegimeTable(db);
  db.prepare(
    `INSERT INTO day_regime
       (day_key, computed_ts, vol_score, vol_quintile, prev_rng_pct, or5_rng_pct, atr5_pct, top_symbols, ranks_json, note)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(day_key) DO UPDATE SET
       computed_ts=excluded.computed_ts, vol_score=excluded.vol_score, vol_quintile=excluded.vol_quintile,
       prev_rng_pct=excluded.prev_rng_pct, or5_rng_pct=excluded.or5_rng_pct, atr5_pct=excluded.atr5_pct,
       top_symbols=excluded.top_symbols, ranks_json=excluded.ranks_json, note=excluded.note`
  ).run(
    r.dayKey,
    r.computedTs,
    r.volScore,
    r.volQuintile,
    r.prevRngPct,
    r.or5RngPct,
    r.atr5Pct,
    JSON.stringify(r.topSymbols),
    JSON.stringify(r.ranks),
    r.note ?? null
  );
}

export function hasDayRegime(db: Database.Database, dayKey: string): boolean {
  ensureDayRegimeTable(db);
  const row = db.prepare(`SELECT 1 FROM day_regime WHERE day_key=?`).get(dayKey);
  return !!row;
}

export function getDayRegimeRow(db: Database.Database, dayKey: string): any | null {
  ensureDayRegimeTable(db);
  return db.prepare(`SELECT * FROM day_regime WHERE day_key=?`).get(dayKey) || null;
}

/* --------------------------------------------------------------------- */
/* reporting — powers GET /api/regime                                     */
/* --------------------------------------------------------------------- */

type TradeRow = {
  dayKey: string;
  symbol: string;
  ver: number | null;
  ret: number;
  exitReason: string | null;
};

/**
 * Slices closed trades two ways against the recorded regime:
 *   - by the day's volatility quintile
 *   - by whether the traded symbol was inside that day's top-5 rank
 * Pure read. `SKIPPED` rows are non-trades and are excluded, and unscored
 * rows are dropped rather than counted as breakeven.
 */
export function buildRegimeReport(db: Database.Database, opts?: { strategyVersion?: number | null }) {
  ensureDayRegimeTable(db);

  const days = db.prepare(`SELECT * FROM day_regime ORDER BY day_key ASC`).all() as any[];
  const byDay = new Map<string, any>();
  const topByDay = new Map<string, Set<string>>();
  for (const d of days) {
    byDay.set(d.day_key, d);
    let top: string[] = [];
    try { top = JSON.parse(d.top_symbols || "[]"); } catch { top = []; }
    topByDay.set(d.day_key, new Set(top));
  }

  const raw = db
    .prepare(
      `SELECT o.symbol, o.ruleset_version AS ver, o.exit_return_pct AS ret, o.exit_reason,
              COALESCE(o.entry_ts, a.ts) AS ts
         FROM outcomes o JOIN alerts a ON a.id = o.alert_id
        WHERE o.exit_reason IS NOT NULL AND o.exit_reason != 'SKIPPED'
          AND o.exit_return_pct IS NOT NULL AND o.exit_return_pct != ''`
    )
    .all() as any[];

  const want = opts?.strategyVersion ?? null;
  const trades: TradeRow[] = [];
  for (const r of raw) {
    const ver = r.ver == null ? null : Number(r.ver);
    if (want != null && ver !== want) continue;
    const ts = Number(r.ts);
    if (!Number.isFinite(ts)) continue;
    trades.push({
      dayKey: nyDayKey(ts),
      symbol: String(r.symbol || "").toUpperCase(),
      ver,
      ret: Number(r.ret),
      exitReason: r.exit_reason ?? null,
    });
  }

  const blank = () => ({ n: 0, sum: 0, wins: 0, best: 0, worst: 0 });
  const add = (b: any, ret: number) => {
    b.n += 1; b.sum += ret;
    if (ret > 0) b.wins += 1;
    if (ret > b.best) b.best = ret;
    if (ret < b.worst) b.worst = ret;
  };
  const fin = (b: any) => ({
    n: b.n,
    sumPct: Number(b.sum.toFixed(2)),
    avgPct: b.n ? Number((b.sum / b.n).toFixed(3)) : 0,
    winRate: b.n ? Number((b.wins / b.n).toFixed(3)) : 0,
    bestPct: Number(b.best.toFixed(2)),
    worstPct: Number(b.worst.toFixed(2)),
    dollars: Math.round(b.sum * 50), // $5,000 notional per position
  });

  const byQuintile: Record<string, any> = { "1": blank(), "2": blank(), "3": blank(), "4": blank(), "5": blank(), unknown: blank() };
  const byRank = { inTop: blank(), outside: blank(), unknown: blank() };
  const dayRows = new Map<string, { n: number; sum: number }>();
  let covered = 0;

  for (const t of trades) {
    const reg = byDay.get(t.dayKey);
    const q = reg?.vol_quintile;
    add(byQuintile[q == null ? "unknown" : String(q)], t.ret);

    const top = topByDay.get(t.dayKey);
    if (!top || top.size === 0) add(byRank.unknown, t.ret);
    else { covered += 1; add(top.has(t.symbol) ? byRank.inTop : byRank.outside, t.ret); }

    const d = dayRows.get(t.dayKey) || { n: 0, sum: 0 };
    d.n += 1; d.sum += t.ret;
    dayRows.set(t.dayKey, d);
  }

  const perDay = days.map((d) => {
    const agg = dayRows.get(d.day_key) || { n: 0, sum: 0 };
    let ranks: SymbolRank[] = [];
    try { ranks = JSON.parse(d.ranks_json || "[]"); } catch { ranks = []; }
    return {
      dayKey: d.day_key,
      volScore: d.vol_score == null ? null : Number(d.vol_score.toFixed(2)),
      volQuintile: d.vol_quintile,
      topSymbols: Array.from(topByDay.get(d.day_key) || []),
      trades: agg.n,
      sumPct: Number(agg.sum.toFixed(2)),
      dollars: Math.round(agg.sum * 50),
      ranks,
      note: d.note || null,
    };
  }).reverse();

  const versions = Array.from(new Set(trades.map((t) => t.ver).filter((v): v is number => v != null))).sort((a, b) => a - b);

  return {
    generatedAt: Date.now(),
    daysRecorded: days.length,
    tradesScored: trades.length,
    tradesWithRankCoverage: covered,
    strategyVersion: want,
    strategies: versions,
    byQuintile: Object.fromEntries(Object.entries(byQuintile).map(([k, v]) => [k, fin(v)])),
    byRank: { inTop: fin(byRank.inTop), outside: fin(byRank.outside), unknown: fin(byRank.unknown) },
    perDay,
  };
}
