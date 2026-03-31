// src/engine/outcomeTracker.ts
import { TradeDirection, TradeOutcome } from "./types";

/**
 * Broker-like execution rules (derived from strategy config).
 * Interpretation:
 * - We compute 1R as the absolute distance from entryRefPrice to structureLevel.
 * - stopR=1 => stopPrice == entry +/- 1R (not structure).
 * - targetR=2 => targetPrice == entry +/- 2R.
 * - moveStopToBEAtR=1 => once price reaches +1R, stop moves to entry (breakeven).
 */
export type ExecRules = {
  stopR: number;              // > 0
  targetR: number;            // > 0
  moveStopToBEAtR?: number;   // > 0 (optional)
};

type ExecState = {
  enabled: boolean;

  // fixed at entry
  rAbs: number;        // absolute $ value of 1R
  entry: number;
  stopPx: number;
  targetPx: number;
  beTriggerPx: number | null;

  // mutates
  stopMovedToBE: boolean;
  exitReason: "STOP" | "TARGET" | "TIME" | "STOP_CLOSE" | null;
  exitTs: number | null;
  exitFill: number | null;
};

type ActiveSession = {
  alertId: string;
  symbol: string;
  dir: TradeDirection;

  structureLevel: number;

  entryTs: number;
  entryRefPrice: number;

  status: "LIVE" | "STOPPED" | "COMPLETED";
  endTs: number;

  // tracking
  maxHigh: number;
  minLow: number;
  mfeAbs: number;
  maeAbs: number;
  mfeTs: number | null;

  // stop fields
  stoppedOut: boolean;
  stopTs: number | null;
  stopClose: number | null;
  barsToStop: number | null;

  // counters
  bar1mCount: number;

  // checkpoint returns
  checkpointsMin: number[];
  returnsPct: Record<string, number>;

  // broker-like exec (optional)
  execRules?: ExecRules;
  exec: ExecState;
};

function isFiniteNum(x: any): x is number {
  return Number.isFinite(Number(x));
}

function computeExecState(args: {
  dir: TradeDirection;
  entry: number;
  structureLevel: number;
  execRules?: ExecRules;
}): ExecState {
  const entry = Number(args.entry);
  const structure = Number(args.structureLevel);

  const rules = args.execRules;
  if (!rules) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  const stopR = Number(rules.stopR);
  const targetR = Number(rules.targetR);
  const moveBE = rules.moveStopToBEAtR == null ? null : Number(rules.moveStopToBEAtR);

  if (!isFiniteNum(entry) || entry <= 0) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  if (!isFiniteNum(structure)) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  if (!isFiniteNum(stopR) || stopR <= 0) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  if (!isFiniteNum(targetR) || targetR <= 0) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  const rAbs = Math.abs(entry - structure);
  if (!isFiniteNum(rAbs) || rAbs <= 0) {
    return {
      enabled: false,
      rAbs: 0,
      entry,
      stopPx: structure,
      targetPx: entry,
      beTriggerPx: null,
      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  const dir = args.dir;

  const stopPx = dir === "LONG" ? entry - stopR * rAbs : entry + stopR * rAbs;
  const targetPx = dir === "LONG" ? entry + targetR * rAbs : entry - targetR * rAbs;

  const beTriggerPx =
    moveBE != null && isFiniteNum(moveBE) && moveBE > 0
      ? (dir === "LONG" ? entry + moveBE * rAbs : entry - moveBE * rAbs)
      : null;

  return {
    enabled: true,
    rAbs,
    entry,
    stopPx,
    targetPx,
    beTriggerPx,
    stopMovedToBE: false,
    exitReason: null,
    exitTs: null,
    exitFill: null
  };
}

function computeReturnPct(dir: TradeDirection, entry: number, px: number): number {
  if (!isFiniteNum(entry) || entry <= 0 || !isFiniteNum(px)) return 0;
  const ret = dir === "LONG" ? (px - entry) / entry : (entry - px) / entry;
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
    execRules?: ExecRules;
  }) {
    const checkpointsMin = (this.cfg.checkpointsMin ?? [1, 3, 5, 10, 15, 30, 60]).slice();

    const entryRef = Number(args.entryRefPrice);
    const structure = Number(args.structureLevel);

    const exec = computeExecState({
      dir: args.dir,
      entry: entryRef,
      structureLevel: structure,
      execRules: args.execRules
    });

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
          s.returnsPct[key] = computeReturnPct(s.dir, s.entryRefPrice, args.close);
        }
      }

      if (s.exec.enabled) {
        if (!s.exec.stopMovedToBE && s.exec.beTriggerPx != null) {
          if (s.dir === "LONG") {
            if (args.high >= s.exec.beTriggerPx) {
              s.exec.stopPx = s.exec.entry;
              s.exec.stopMovedToBE = true;
            }
          } else {
            if (args.low <= s.exec.beTriggerPx) {
              s.exec.stopPx = s.exec.entry;
              s.exec.stopMovedToBE = true;
            }
          }
        }

        let hitStop = false;
        let hitTarget = false;

        if (s.dir === "LONG") {
          hitStop = args.low <= s.exec.stopPx;
          hitTarget = args.high >= s.exec.targetPx;
        } else {
          hitStop = args.high >= s.exec.stopPx;
          hitTarget = args.low <= s.exec.targetPx;
        }

        if (hitStop) {
          s.status = "STOPPED";
          s.stoppedOut = true;
          s.stopTs = args.ts;
          s.stopClose = s.exec.stopPx;
          s.barsToStop = s.bar1mCount;

          s.exec.exitReason = "STOP";
          s.exec.exitTs = args.ts;
          s.exec.exitFill = s.exec.stopPx;

          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, s.exec.stopPx);

          completed.push(s.alertId);
          continue;
        }

        if (hitTarget) {
          s.status = "COMPLETED";
          s.stoppedOut = false;
          s.stopTs = null;
          s.stopClose = null;
          s.barsToStop = null;

          s.exec.exitReason = "TARGET";
          s.exec.exitTs = args.ts;
          s.exec.exitFill = s.exec.targetPx;

          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, s.exec.targetPx);

          completed.push(s.alertId);
          continue;
        }
      }

      if (elapsedMin >= this.cfg.trackWindowMin) {
        s.status = "COMPLETED";

        // TIME exit fill = bar close
        s.exec.exitReason = "TIME";
        s.exec.exitTs = args.ts;
        s.exec.exitFill = args.close;

        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);

        completed.push(s.alertId);
      }
    }

    return completed;
  }

  onBar5Close(args: { symbol: string; ts: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      if (s.exec.enabled) continue;

      const stopHit = s.dir === "LONG" ? args.close < s.structureLevel : args.close > s.structureLevel;
      if (stopHit) {
        s.status = "STOPPED";
        s.stoppedOut = true;
        s.stopTs = args.ts;
        s.stopClose = args.close;
        s.barsToStop = s.bar1mCount;

        s.exec.exitReason = "STOP_CLOSE";
        s.exec.exitTs = args.ts;
        s.exec.exitFill = args.close;

        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);

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
      s.stoppedOut && s.stopClose != null ? computeReturnPct(s.dir, s.entryRefPrice, s.stopClose) : null;

    const exitReason = s.exec.exitReason ?? null;
    const exitFill = s.exec.exitFill ?? null;

    const exitReturnPct =
      exitFill != null && isFiniteNum(exitFill) ? computeReturnPct(s.dir, s.entryRefPrice, exitFill) : null;

    const out: TradeOutcome = {
      alertId: s.alertId,
      symbol: s.symbol,
      dir: s.dir,
      structureLevel: s.structureLevel,
      entryTs: s.entryTs,
      entryRefPrice: s.entryRefPrice,
      status: s.status,
      endTs: s.stopTs ?? s.endTs,

      exitReason,
      exitFill,
      exitReturnPct,
      stopMovedToBE: Boolean(s.exec.stopMovedToBE),

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