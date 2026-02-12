import { TradeDirection, TradeOutcome } from "./types";

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
  bar5Count: number;

  checkpointsMin: number[];
  returnsPct: Record<string, number>;
};

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
  }) {
    const checkpointsMin = (this.cfg.checkpointsMin ?? [1, 3, 5, 10, 15, 30, 60]).slice();

    const s: ActiveSession = {
      alertId: args.alertId,
      symbol: args.symbol,
      dir: args.dir,
      structureLevel: args.structureLevel,
      entryTs: args.entryTs,
      entryRefPrice: args.entryRefPrice,

      status: "LIVE",
      endTs: args.entryTs,

      maxHigh: args.entryRefPrice,
      minLow: args.entryRefPrice,
      mfeAbs: 0,
      maeAbs: 0,
      mfeTs: null,

      stoppedOut: false,
      stopTs: null,
      stopClose: null,
      barsToStop: null,
      bar5Count: 0,

      checkpointsMin,
      returnsPct: {}
    };

    this.sessionsById.set(args.alertId, s);
    if (!this.sessionsBySymbol.has(args.symbol)) this.sessionsBySymbol.set(args.symbol, new Set());
    this.sessionsBySymbol.get(args.symbol)!.add(args.alertId);
  }

  onMinuteBar(args: { symbol: string; ts: number; high: number; low: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of ids) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      s.endTs = args.ts;

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

      const elapsedMin = (args.ts - s.entryTs) / 60_000;
      for (const m of s.checkpointsMin) {
        const key = `${m}m`;
        if (s.returnsPct[key] != null) continue;
        if (elapsedMin >= m) {
          const ret =
            s.dir === "LONG"
              ? (args.close - s.entryRefPrice) / s.entryRefPrice
              : (s.entryRefPrice - args.close) / s.entryRefPrice;
          s.returnsPct[key] = Number((ret * 100).toFixed(4));
        }
      }

      if (elapsedMin >= this.cfg.trackWindowMin) {
        s.status = "COMPLETED";
        completed.push(s.alertId);
      }
    }

    return completed;
  }

  onBar5Close(args: { symbol: string; ts: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of ids) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      s.bar5Count += 1;

      const stopHit = s.dir === "LONG" ? args.close < s.structureLevel : args.close > s.structureLevel;

      if (stopHit) {
        s.status = "STOPPED";
        s.stoppedOut = true;
        s.stopTs = args.ts;
        s.stopClose = args.close;
        s.barsToStop = s.bar5Count;
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

    const stopReturnPct =
      s.stoppedOut && s.stopClose != null
        ? Number(
            ((((s.dir === "LONG" ? s.stopClose - s.entryRefPrice : s.entryRefPrice - s.stopClose) /
              s.entryRefPrice) *
              100) as number).toFixed(4)
          )
        : null;

    const out: TradeOutcome = {
      alertId: s.alertId,
      symbol: s.symbol,
      dir: s.dir,
      structureLevel: s.structureLevel,
      entryTs: s.entryTs,
      entryRefPrice: s.entryRefPrice,
      status: s.status,
      endTs: s.stopTs ?? s.endTs,

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

    this.sessionsById.delete(alertId);
    const set = this.sessionsBySymbol.get(s.symbol);
    if (set) {
      set.delete(alertId);
      if (set.size === 0) this.sessionsBySymbol.delete(s.symbol);
    }

    return out;
  }
}