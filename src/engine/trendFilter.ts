// src/engine/trendFilter.ts
//
// 4-hour trend regime filter. Built 2026-05-18 from Ryder's request:
//   "on the 4 hour timeframe, if the 9 ema is above or crossing above the
//    21 day ma then only calls are allowed. and same for shorts."
//
// Mechanics:
//   - Aggregate 5m bars into 4h buckets (UTC-aligned, deterministic).
//   - Compute EMA(9) and SMA(21) on the closes of those 4h bars.
//   - Regime = BULL when EMA(9) >= SMA(21), BEAR when EMA(9) < SMA(21).
//   - Insufficient history (< 21 4h bars) → UNKNOWN (pass through, do not block).
//
// Why pass-through on UNKNOWN: a stale/cold-start system shouldn't suddenly
// dark every trade because it doesn't have enough history yet. Live trading
// always has 14+ days of bars after the first 2 weeks of operation; replay
// runs preload prior bars to clear the warm-up window.

import { Bar5 } from "../market/marketDirection";

export type TrendRegime = "BULL" | "BEAR" | "UNKNOWN";

export type TrendFilterConfig = {
  /** 4h bar width in ms. Const in practice; exposed for future tuning. */
  bucketMs?: number;
  /** EMA period on 4h closes. Default 9. */
  emaPeriod?: number;
  /** SMA period on 4h closes. Default 21. */
  smaPeriod?: number;
};

const FOUR_HOUR_MS = 4 * 60 * 60_000;
const DEFAULT_EMA = 9;
const DEFAULT_SMA = 21;

type Bucket = { ts: number; o: number; h: number; l: number; c: number };

/**
 * Aggregate a chronologically-sorted 5m bar series into 4h buckets (UTC-aligned).
 * Bars within the same 4h slot are folded into one bucket; the close of the
 * latest 5m bar in the bucket becomes the 4h close.
 *
 * Exported for testing and for downstream filters that need 4h bars.
 */
export function aggregateTo4h(bars5: Bar5[], bucketMs: number = FOUR_HOUR_MS): Bucket[] {
  if (!bars5 || bars5.length === 0) return [];

  const out: Bucket[] = [];
  let cur: Bucket | null = null;

  for (const b of bars5) {
    if (!Number.isFinite(b.t)) continue;
    const slot = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || cur.ts !== slot) {
      if (cur) out.push(cur);
      cur = { ts: slot, o: b.o, h: b.h, l: b.l, c: b.c };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Simple moving average over the last `period` closes. Returns null if there
 * are fewer than `period` bars (we never report a partial-window SMA — that
 * would generate false regimes during warm-up).
 */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i];
  return sum / period;
}

/**
 * Exponential moving average over the last `period` closes. Seeded with the
 * SMA of the first `period` closes, then walked forward with the standard
 * alpha = 2 / (period + 1) recurrence. Returns null when history is shorter
 * than `period`.
 */
function ema(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const alpha = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  let v = seed / period;
  for (let i = period; i < closes.length; i++) {
    v = closes[i] * alpha + v * (1 - alpha);
  }
  return v;
}

/**
 * Compute the 4h regime from a 5m bar series. Returns BULL when EMA(9) is at
 * or above SMA(21) on the most recent completed 4h bucket, BEAR when below,
 * UNKNOWN when there aren't enough 4h bars yet.
 *
 * "or crossing above" from Ryder's spec is naturally captured by the >= check:
 * the bar that crosses up has EMA == SMA momentarily, then > immediately after.
 */
export function compute4hRegime(bars5: Bar5[], cfg?: TrendFilterConfig): TrendRegime {
  const bucketMs = cfg?.bucketMs ?? FOUR_HOUR_MS;
  const emaP = cfg?.emaPeriod ?? DEFAULT_EMA;
  const smaP = cfg?.smaPeriod ?? DEFAULT_SMA;

  const buckets = aggregateTo4h(bars5, bucketMs);
  if (buckets.length < smaP) return "UNKNOWN";

  const closes = buckets.map((b) => b.c);
  const emaVal = ema(closes, emaP);
  const smaVal = sma(closes, smaP);
  if (emaVal == null || smaVal == null) return "UNKNOWN";

  return emaVal >= smaVal ? "BULL" : "BEAR";
}

/**
 * Apply the regime to a proposed direction. Returns true if the trade is
 * allowed, false if it should be blocked. UNKNOWN always passes through.
 *
 *   CALL (LONG)  allowed when regime is BULL or UNKNOWN
 *   PUT  (SHORT) allowed when regime is BEAR or UNKNOWN
 */
export function trendAllowsDirection(regime: TrendRegime, dir: "CALL" | "PUT"): boolean {
  if (regime === "UNKNOWN") return true;
  if (dir === "CALL") return regime === "BULL";
  if (dir === "PUT") return regime === "BEAR";
  return true;
}
