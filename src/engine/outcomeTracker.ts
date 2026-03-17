// src/engine/outcomeTracker.ts
import { TradeDirection, TradeOutcome } from "./types";
import { initExec, onMinuteBarExec, ExecRules, ExecState } from "../sim/executionSim";

type ActiveSession = {
  alertId: string;
  symbol: string;
  dir: TradeDirection;
  structureLevel: number;
  entryTs: number;
  entryRefPrice: number;

  status: "LIVE" | "STOPPED" | "COMPLETED";
  endTs: number;

  maxHigh: number;
  minLow: number;
  mfeAbs: number;
  maeAbs: number;
  mfeTs: number | null;

  stoppedOut: boolean;
  stopTs: number | null;
  stopClose: number | null;
  barsToStop: number | null;

  bar1mCount: number;

  checkpointsMin: number[];
  returnsPct: Record<string, number>;

  execRules?: ExecRules;
  exec: ExecState | null; // null = execution sim disabled
};

function isFiniteNum(x: any): x is number {
  return Number.isFinite(Number(x));
}

function computeReturnPct(dir: TradeDirection, entry: number, px: number): number {
  if (!isFiniteNum(entry) || entry <= 0 || !isFiniteNum(px)) return 0;
  const ret =
    dir === "LONG"
      ? (px - entry) / entry
      : (entry - px) / entry;
  return Number((ret * 100).toFixed(4));
}

export class OutcomeTracker {
  private sessionsById = new Map<string, ActiveSession>();
  private sessionsBySymbol = new Map<string, Set<string>>();

  constructor(private cfg: { trackWindowMin: number; checkpointsMin?: number[] }) {}

  startSession(args: {
    alertId: string;
    symbol: string;
    dir: TradeDirection;
    structureLevel: number;
    entryTs: number;
    entryRefPrice: number;
    execRules?: ExecRules; // optional (strategy-derived)
  }) {
    const checkpointsMin = (this.cfg.checkpointsMin ?? [1, 3, 5, 10, 15, 30, 60]).slice();

    const entryRef = Number(args.entryRefPrice);
    const structure = Number(args.structureLevel);

    // If execRules provided and 1R is valid, enable broker-like execution sim.
    let exec: ExecState | null = null;
    if (args.execRules) {
      try {
        exec = initExec(args.dir, args.entryTs, entryRef, structure, args.execRules);
      } catch {
        exec = null; // fallback to time-based + legacy stop logic
      }
    }

    const s: ActiveSession = {
      alertId: args.alertId,
      symbol: args.symbol,
      dir: args.dir,
      structureLevel: structure,
      entryTs: args.entryTs,
      entryRefPrice: entryRef,

      status: "LIVE",
      endTs: args.entryTs,

      maxHigh: entryRef,
      minLow: entryRef,
      mfeAbs: 0,
      maeAbs: 0,
      mfeTs: null,

      stoppedOut: false,
      stopTs: null,
      stopClose: null,
      barsToStop: null,

      bar1mCount: 0,

      checkpointsMin,
      returnsPct: {},

      execRules: args.execRules,
      exec
    };

    this.sessionsById.set(args.alertId, s);
    if (!this.sessionsBySymbol.has(args.symbol)) this.sessionsBySymbol.set(args.symbol, new Set());
    this.sessionsBySymbol.get(args.symbol)!.add(args.alertId);
  }

  onMinuteBar(args: { symbol: string; ts: number; high: number; low: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      s.endTs = args.ts;
      s.bar1mCount += 1;

      // update MFE/MAE tracking
      if (args.high > s.maxHigh) s.maxHigh = args.high;
      if (args.low < s.minLow) s.minLow = args.low;

      let mfeAbs = 0;
      let maeAbs = 0;

      if (s.dir === "LONG") {
        mfeAbs = s.maxHigh - s.entryRefPrice;
        maeAbs = s.entryRefPrice - s.minLow;
      } else {
        mfeAbs = s.entryRefPrice - s.minLow;
        maeAbs = s.maxHigh - s.entryRefPrice;
      }

      if (mfeAbs > s.mfeAbs) {
        s.mfeAbs = mfeAbs;
        s.mfeTs = args.ts;
      }
      if (maeAbs > s.maeAbs) s.maeAbs = maeAbs;

      // checkpoint returns (close-based, same as before)
      const elapsedMin = (args.ts - s.entryTs) / 60_000;
      for (const m of s.checkpointsMin) {
        const key = `${m}m`;
        if (s.returnsPct[key] != null) continue;
        if (elapsedMin >= m) {
          s.returnsPct[key] = computeReturnPct(s.dir, s.entryRefPrice, args.close);
        }
      }

      // broker-like execution (intrabar using high/low)
      if (s.exec && s.execRules) {
        const fill = onMinuteBarExec(
          s.dir,
          s.exec,
          s.execRules,
          args.ts,
          args.high,
          args.low,
          args.close
        );

        if (fill) {
          if (fill.exitReason === "STOP") {
            s.status = "STOPPED";
            s.stoppedOut = true;
            s.stopTs = fill.exitTs;
            s.stopClose = fill.exitPrice;
            s.barsToStop = s.bar1mCount;
          } else {
            s.status = "COMPLETED";
            s.stoppedOut = false;
            s.stopTs = fill.exitTs; // keep end timestamp
            s.stopClose = fill.exitPrice; // store fill for PnL calculation even if target
            s.barsToStop = null;
          }

          s.endTs = fill.exitTs;
          completed.push(s.alertId);
          continue;
        }
      }

      // time-based completion fallback
      if (elapsedMin >= this.cfg.trackWindowMin) {
        s.status = "COMPLETED";
        s.endTs = args.ts;
        completed.push(s.alertId);
      }
    }

    return completed;
  }

  /**
   * Legacy bar-close stop hook.
   * If exec sim is enabled, this is a no-op (minute sim handles exits).
   */
  onBar5Close(args: { symbol: string; ts: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      // broker mode: ignore this
      if (s.exec && s.execRules) continue;

      const stopHit = s.dir === "LONG" ? args.close < s.structureLevel : args.close > s.structureLevel;
      if (stopHit) {
        s.status = "STOPPED";
        s.stoppedOut = true;
        s.stopTs = args.ts;
        s.stopClose = args.close;
        s.barsToStop = s.bar1mCount;
        s.endTs = args.ts;
        completed.push(s.alertId);
      }
    }

    return completed;
  }

  finalize(alertId: string): TradeOutcome | null {
    const s = this.sessionsById.get(alertId);
    if (!s) return null;
    if (s.status === "LIVE") return null;

    const mfePct = s.entryRefPrice > 0 ? (s.mfeAbs / s.entryRefPrice) * 100 : 0;
    const maePct = s.entryRefPrice > 0 ? (s.maeAbs / s.entryRefPrice) * 100 : 0;

    const timeToMfeSec = s.mfeTs != null ? Math.max(0, Math.round((s.mfeTs - s.entryTs) / 1000)) : null;

    // For STOP: stopClose is stop fill
    // For TARGET: stopClose is target fill (we stored it)
    const realizedExitPx =
      s.stopClose != null && isFiniteNum(s.stopClose) ? Number(s.stopClose) : null;

    const stopReturnPct =
      realizedExitPx != null
        ? computeReturnPct(s.dir, s.entryRefPrice, realizedExitPx)
        : null;

    const out: TradeOutcome = {
      alertId: s.alertId,
      symbol: s.symbol,
      dir: s.dir,
      structureLevel: s.structureLevel,
      entryTs: s.entryTs,
      entryRefPrice: s.entryRefPrice,
      status: s.status,
      endTs: s.endTs,

      mfeAbs: Number(s.mfeAbs.toFixed(6)),
      maeAbs: Number(s.maeAbs.toFixed(6)),
      mfePct: Number(mfePct.toFixed(4)),
      maePct: Number(maePct.toFixed(4)),
      timeToMfeSec,

      stoppedOut: s.stoppedOut,
      stopTs: s.stopTs,
      stopClose: s.stopClose,
      stopReturnPct,
      barsToStop: s.barsToStop,

      returnsPct: s.returnsPct
    };

    // cleanup
    this.sessionsById.delete(alertId);
    const set = this.sessionsBySymbol.get(s.symbol);
    if (set) {
      set.delete(alertId);
      if (set.size === 0) this.sessionsBySymbol.delete(s.symbol);
    }

    return out;
  }
} 