// src/engine/outcomeTracker.ts
import { TradeDirection, TradeOutcome } from "./types";

/**
 * Broker-like execution rules (derived from strategy config).
 *
 * Interpretation (structure-anchored R):
 * - 1R = abs(entryRefPrice - structureLevel)
 * - stopR=1  => stopPrice is 1R against the position (classic structure stop)
 * - targetR=2 => targetPrice is 2R in favor
 * - moveStopToBEAtR=1 => once +1R is touched, stop moves to entry (BE)
 * - trailStartR=1 + trailByR=1 => once +1R is touched, stop trails by 1R behind best price
 * - maxHoldBars1m => time stop in 1-minute bars (falls back to trackWindowMin)
 */
export type ExecRules = {
  stopR: number;              // > 0
  targetR: number;            // > 0
  moveStopToBEAtR?: number;   // > 0 (optional)

  trailEnabled?: boolean;
  trailStartR?: number;       // > 0 (optional; default 1)
  trailByR?: number;          // > 0 (optional; default 1)

  maxHoldBars1m?: number;     // >= 1 (optional)
};

type ExecState = {
  enabled: boolean;

  // fixed at entry
  rAbs: number;        // absolute $ value of 1R
  entry: number;
  stopPx: number;
  targetPx: number;
  beTriggerPx: number | null;

  // trailing
  trailEnabled: boolean;
  trailStartPx: number | null;
  trailByAbs: number;            // abs $ distance behind peak/trough
  bestFavorablePx: number | null; // highest high (LONG) or lowest low (SHORT)

  // mutates
  stopMovedToBE: boolean;

  exitReason: "STOP" | "TARGET" | "TIME" | null;
  exitTs: number | null;
  exitFill: number | null;
};

type ActiveSession = {
  alertId: string;
  symbol: string;
  dir: TradeDirection;

  // anchors R distance
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

  // exit / stop fields (kept for DB schema + UI)
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

function computeReturnPct(dir: TradeDirection, entry: number, px: number): number {
  if (!isFiniteNum(entry) || entry <= 0 || !isFiniteNum(px)) return 0;
  const ret = dir === "LONG" ? (px - entry) / entry : (entry - px) / entry;
  return Number((ret * 100).toFixed(4));
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

      trailEnabled: false,
      trailStartPx: null,
      trailByAbs: 0,
      bestFavorablePx: null,

      stopMovedToBE: false,
      exitReason: null,
      exitTs: null,
      exitFill: null
    };
  }

  const stopR = Number(rules.stopR);
  const targetR = Number(rules.targetR);
  const moveBE = rules.moveStopToBEAtR == null ? null : Number(rules.moveStopToBEAtR);

  if (!isFiniteNum(entry) || entry <= 0) return { ...computeExecState({ dir: args.dir, entry, structureLevel: structure }) };
  if (!isFiniteNum(structure)) return { ...computeExecState({ dir: args.dir, entry, structureLevel: structure }) };
  if (!isFiniteNum(stopR) || stopR <= 0) return { ...computeExecState({ dir: args.dir, entry, structureLevel: structure }) };
  if (!isFiniteNum(targetR) || targetR <= 0) return { ...computeExecState({ dir: args.dir, entry, structureLevel: structure }) };

  const rAbs = Math.abs(entry - structure);
  if (!isFiniteNum(rAbs) || rAbs <= 0) return { ...computeExecState({ dir: args.dir, entry, structureLevel: structure }) };

  const dir = args.dir;

  const stopPx = dir === "LONG" ? entry - stopR * rAbs : entry + stopR * rAbs;
  const targetPx = dir === "LONG" ? entry + targetR * rAbs : entry - targetR * rAbs;

  const beTriggerPx =
    moveBE != null && isFiniteNum(moveBE) && moveBE > 0
      ? (dir === "LONG" ? entry + moveBE * rAbs : entry - moveBE * rAbs)
      : null;

  const trailEnabled = Boolean(rules.trailEnabled);
  const trailStartR = isFiniteNum(rules.trailStartR) && Number(rules.trailStartR) > 0 ? Number(rules.trailStartR) : 1;
  const trailByR = isFiniteNum(rules.trailByR) && Number(rules.trailByR) > 0 ? Number(rules.trailByR) : 1;

  const trailStartPx =
    trailEnabled ? (dir === "LONG" ? entry + trailStartR * rAbs : entry - trailStartR * rAbs) : null;

  return {
    enabled: true,
    rAbs,
    entry,
    stopPx,
    targetPx,
    beTriggerPx,

    trailEnabled,
    trailStartPx,
    trailByAbs: trailByR * rAbs,
    bestFavorablePx: null,

    stopMovedToBE: false,
    exitReason: null,
    exitTs: null,
    exitFill: null
  };
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

  /**
   * Execution + tracking on 1m bars.
   * - stop/target use high/low (intrabar)
   * - BE + trailing supported
   * - checkpoint returns use close (stable UX)
   */
  onMinuteBar(args: { symbol: string; ts: number; high: number; low: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      s.endTs = args.ts;
      s.bar1mCount += 1;

      // excursions
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

      // checkpoint returns (close-based)
      const elapsedMin = (args.ts - s.entryTs) / 60_000;
      for (const m of s.checkpointsMin) {
        const key = `${m}m`;
        if (s.returnsPct[key] != null) continue;
        if (elapsedMin >= m) s.returnsPct[key] = computeReturnPct(s.dir, s.entryRefPrice, args.close);
      }

      // broker-like execution (if enabled)
      if (s.exec.enabled) {
        // 1) update best favorable price for trailing
        if (s.exec.trailEnabled) {
          if (s.exec.bestFavorablePx == null) {
            s.exec.bestFavorablePx = s.dir === "LONG" ? args.high : args.low;
          } else {
            if (s.dir === "LONG") s.exec.bestFavorablePx = Math.max(s.exec.bestFavorablePx, args.high);
            else s.exec.bestFavorablePx = Math.min(s.exec.bestFavorablePx, args.low);
          }
        }

        // 2) BE move
        if (!s.exec.stopMovedToBE && s.exec.beTriggerPx != null) {
          const touched = s.dir === "LONG" ? args.high >= s.exec.beTriggerPx : args.low <= s.exec.beTriggerPx;
          if (touched) {
            s.exec.stopPx = s.exec.entry;
            s.exec.stopMovedToBE = true;
          }
        }

        // 3) Trailing stop (only after trailStartPx is touched)
        if (s.exec.trailEnabled && s.exec.trailStartPx != null && s.exec.bestFavorablePx != null) {
          const active = s.dir === "LONG" ? args.high >= s.exec.trailStartPx : args.low <= s.exec.trailStartPx;
          if (active) {
            const trailStop =
              s.dir === "LONG"
                ? s.exec.bestFavorablePx - s.exec.trailByAbs
                : s.exec.bestFavorablePx + s.exec.trailByAbs;

            // never loosen stop
            if (s.dir === "LONG") s.exec.stopPx = Math.max(s.exec.stopPx, trailStop);
            else s.exec.stopPx = Math.min(s.exec.stopPx, trailStop);
          }
        }

        // 4) stop/target detection (conservative: STOP first if both in same bar)
        const hitStop = s.dir === "LONG" ? args.low <= s.exec.stopPx : args.high >= s.exec.stopPx;
        if (hitStop) {
          s.status = "STOPPED";
          s.stoppedOut = true;
          s.stopTs = args.ts;
          s.stopClose = s.exec.stopPx; // filled at stop price
          s.barsToStop = s.bar1mCount;

          s.exec.exitReason = "STOP";
          s.exec.exitTs = args.ts;
          s.exec.exitFill = s.exec.stopPx;

          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, s.exec.stopPx);

          completed.push(s.alertId);
          continue;
        }

        const hitTarget = s.dir === "LONG" ? args.high >= s.exec.targetPx : args.low <= s.exec.targetPx;
        if (hitTarget) {
          s.status = "COMPLETED";
          s.stoppedOut = false;

          s.exec.exitReason = "TARGET";
          s.exec.exitTs = args.ts;
          s.exec.exitFill = s.exec.targetPx;

          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, s.exec.targetPx);

          completed.push(s.alertId);
          continue;
        }

        // 5) time stop (prefer maxHoldBars1m if provided)
        const maxHold1m =
          s.execRules?.maxHoldBars1m != null && isFiniteNum(s.execRules.maxHoldBars1m) && Number(s.execRules.maxHoldBars1m) >= 1
            ? Math.floor(Number(s.execRules.maxHoldBars1m))
            : Math.floor(this.cfg.trackWindowMin);

        if (s.bar1mCount >= maxHold1m) {
          s.status = "COMPLETED";
          s.exec.exitReason = "TIME";
          s.exec.exitTs = args.ts;
          s.exec.exitFill = args.close;

          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);

          completed.push(s.alertId);
          continue;
        }
      }

      // legacy time-based completion (when exec disabled)
      if (!s.exec.enabled && elapsedMin >= this.cfg.trackWindowMin) {
        s.status = "COMPLETED";
        s.exec.exitReason = "TIME";
        s.exec.exitTs = args.ts;
        s.exec.exitFill = args.close;

        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);

        completed.push(s.alertId);
      }
    }

    return completed;
  }

  /**
   * Legacy hook kept because index.ts still calls it.
   * - If exec is enabled, this is a no-op (execution handled in onMinuteBar).
   * - If exec is disabled, it enforces "stop on bar-close breach of structure".
   */
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
      s.stoppedOut && s.stopClose != null
        ? computeReturnPct(s.dir, s.entryRefPrice, s.stopClose)
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