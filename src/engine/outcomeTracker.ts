// src/engine/outcomeTracker.ts
import { isPastEodFlattenNY } from "../market/time";
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
  timeExitMinutes?: number;   // > 0 (optional) — exit at market once held this many minutes
  mfeGateMinutes?: number;    // > 0 (optional) — check window: if MFE < mfeGatePct% by this time, exit early
  mfeGatePct?: number;        // > 0 (optional) — minimum required MFE % before mfeGateMinutes elapses
  trailActivatePct?: number;  // > 0 (optional) — % MFE to activate trailing stop (e.g. 0.5 = 0.5%)
  trailDistancePct?: number;  // > 0 (optional) — % below peak to trail stop (e.g. 0.3 = 0.3%)
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
  trailActive: boolean;     // true once MFE crosses trailActivatePct
  exitReason: "STOP" | "TARGET" | "TIME" | "STOP_CLOSE" | "STRUCTURE_BREAK" | "EOD" | "MANUAL_CLOSE" | "SKIPPED" | null;
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

  // Broker-truth entry fill (filled_avg_price). Null until we hear back from
  // the broker. When set, this is what we use to compute realized P&L. The
  // simulated `entryRefPrice` (alert.close) is kept around as a fallback and
  // for diagnostics.
  entryFill: number | null;
  qty: number | null;

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
      trailActive: false,
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
      trailActive: false,
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
      trailActive: false,
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
      trailActive: false,
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
      trailActive: false,
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
      trailActive: false,
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
    trailActive: false,
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

  constructor(private cfg: { checkpointsMin?: number[] }) {}

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
      entryFill: null,
      qty: null,

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
   * Override the session's entry price with the actual broker fill. Called
   * after we poll the broker for filled_avg_price on the entry market order.
   *
   * Side effects:
   *   - Resets the stop/target/BE prices around the real fill (so 1R is measured
   *     from the price the broker actually paid, not from alert.close).
   *   - Resets maxHigh/minLow so MFE/MAE are computed from the real entry.
   *
   * If polling fails the simulated entryRefPrice (alert.close) is left in place
   * and the trade is still tracked — outcomes will fall back to simulation.
   */
  setBrokerEntry(alertId: string, fillPx: number, qty: number): void {
    const s = this.sessionsById.get(alertId);
    if (!s) return;
    if (!isFiniteNum(fillPx) || fillPx <= 0) return;
    if (s.status !== "LIVE") return;

    s.entryFill = fillPx;
    s.qty = isFiniteNum(qty) && qty > 0 ? qty : null;

    // Re-anchor the simulated entry on the broker fill so the in-flight
    // stop/target/structure-break logic agrees with what the broker did.
    s.entryRefPrice = fillPx;
    s.maxHigh = fillPx;
    s.minLow = fillPx;

    if (s.execRules) {
      s.exec = computeExecState({
        dir: s.dir,
        entry: fillPx,
        structureLevel: s.structureLevel,
        execRules: s.execRules,
      });
    }
  }

  /**
   * Override the exit fill with the actual broker close price. Called from
   * index.ts after closePosition() + pollFill(). Recomputes exitReturnPct and
   * realizedPnlUsd from broker truth. Safe to call on already-finalized
   * sessions; in that case it returns the patched outcome the caller can
   * re-insert into the DB.
   */
  setBrokerExit(alertId: string, fillPx: number): { exitFill: number; exitReturnPct: number; realizedPnlUsd: number | null } | null {
    if (!isFiniteNum(fillPx) || fillPx <= 0) return null;
    const s = this.sessionsById.get(alertId);
    if (!s) return null;

    s.exec.exitFill = fillPx;
    s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, fillPx);

    const entryPx = s.entryFill ?? s.entryRefPrice;
    const realizedPnlUsd =
      s.qty != null && isFiniteNum(s.qty) && isFiniteNum(entryPx)
        ? Number(((s.dir === "LONG" ? fillPx - entryPx : entryPx - fillPx) * s.qty).toFixed(2))
        : null;

    return {
      exitFill: fillPx,
      exitReturnPct: s.returnsPct["exit"],
      realizedPnlUsd,
    };
  }

  onMinuteBar(args: { symbol: string; ts: number; high: number; low: number; close: number }): {
    completed: string[];
    beMoved: Array<{ alertId: string; symbol: string; newStopPx: number }>;
  } {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return { completed: [], beMoved: [] };

    const completed: string[] = [];
    const beMoved: Array<{ alertId: string; symbol: string; newStopPx: number }> = [];

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
              beMoved.push({ alertId: s.alertId, symbol: s.symbol, newStopPx: s.exec.entry });
            }
          } else {
            if (args.low <= s.exec.beTriggerPx) {
              s.exec.stopPx = s.exec.entry;
              s.exec.stopMovedToBE = true;
              beMoved.push({ alertId: s.alertId, symbol: s.symbol, newStopPx: s.exec.entry });
            }
          }
        }

        // Trailing stop: once MFE exceeds trailActivatePct, trail the stop
        // behind the running peak by trailDistancePct. Moves stop in the
        // favorable direction only — never widens. Overrides BE stop once
        // the trail is ahead of breakeven (trail is strictly tighter).
        if (
          s.execRules?.trailActivatePct != null &&
          s.execRules.trailActivatePct > 0 &&
          s.execRules?.trailDistancePct != null &&
          s.execRules.trailDistancePct > 0
        ) {
          const mfePct = s.entryRefPrice > 0 ? (s.mfeAbs / s.entryRefPrice) * 100 : 0;

          if (!s.exec.trailActive && mfePct >= s.execRules.trailActivatePct) {
            s.exec.trailActive = true;
          }

          if (s.exec.trailActive) {
            const trailDist = s.execRules.trailDistancePct / 100;
            if (s.dir === "LONG") {
              const newStop = s.maxHigh * (1 - trailDist);
              if (newStop > s.exec.stopPx) s.exec.stopPx = newStop;
            } else {
              const newStop = s.minLow * (1 + trailDist);
              if (newStop < s.exec.stopPx) s.exec.stopPx = newStop;
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

      // MFE gate: exit early if the trade hasn't shown minimum favorable movement
      // within the gate window. Catches trades that go sideways-or-against from the
      // start (e.g. MU chronic near-zero MFE pattern). Fires before TIME so we cut
      // losers faster rather than holding full hold duration for nothing.
      // Configured via mfeGateMinutes + mfeGatePct on ExecRules (wired from env vars).
      if (
        s.execRules?.mfeGateMinutes != null &&
        s.execRules.mfeGateMinutes > 0 &&
        s.execRules?.mfeGatePct != null &&
        s.execRules.mfeGatePct > 0 &&
        elapsedMin >= s.execRules.mfeGateMinutes
      ) {
        const curMfePct = s.entryRefPrice > 0 ? (s.mfeAbs / s.entryRefPrice) * 100 : 0;
        if (curMfePct < s.execRules.mfeGatePct) {
          s.status = "COMPLETED";
          s.exec.exitReason = "TIME"; // treated as early TIME exit in reporting
          s.exec.exitTs = args.ts;
          s.exec.exitFill = args.close;
          s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);
          completed.push(s.alertId);
          continue;
        }
      }

      // TIME exit: close at market once the position has been held for the
      // configured maximum. The break-&-retest thesis is time-bound — if it
      // hasn't paid by now, exit near-flat rather than feeding a structure
      // break or riding to EOD. This is the strategy's primary profit-taking
      // exit. Checked outside the s.exec.enabled gate so it still runs if
      // stop/target rules could not be built.
      if (
        s.execRules?.timeExitMinutes != null &&
        s.execRules.timeExitMinutes > 0 &&
        elapsedMin >= s.execRules.timeExitMinutes
      ) {
        s.status = "COMPLETED";
        s.exec.exitReason = "TIME";
        s.exec.exitTs = args.ts;
        s.exec.exitFill = args.close;
        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);
        completed.push(s.alertId);
        continue;
      }

      // EOD flatten: no positions held past 2:59 PM NY. Exit fill = current bar close.
      if (isPastEodFlattenNY(args.ts)) {
        s.status = "COMPLETED";

        s.exec.exitReason = "EOD";
        s.exec.exitTs = args.ts;
        s.exec.exitFill = args.close;

        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.close);

        completed.push(s.alertId);
      }
    }

    return { completed, beMoved };
  }

  /**
   * Retest invalidation. If a 5m bar that begins AFTER our entry opens on the
   * wrong side of the entry's retest level (structureLevel), the retest is
   * broken — exit immediately at that bar's open price. The retest level held
   * during entry must remain on the correct side of price; an open beyond it
   * means the structure is gone and the trade thesis is invalid.
   *
   * Runs alongside R-stop / target / BE in onMinuteBar — first trigger wins.
   */
  onBar5Close(args: { symbol: string; ts: number; open: number; close: number }): string[] {
    const ids = this.sessionsBySymbol.get(args.symbol);
    if (!ids || !ids.size) return [];

    const completed: string[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      // STRUCTURE_BREAK is a legacy fallback exit. When the managed exec
      // engine is active (stop / target / BE / TIME) it is redundant and
      // strictly worse: it fills at a 5m-bar open that has already run past
      // the level (0 wins / 23 trades, avg -0.8% per trade). The structure-
      // level stop in onMinuteBar fires first, intrabar, at a far better
      // fill. Only fall back to STRUCTURE_BREAK when exec is disabled.
      if (s.exec.enabled) continue;

      // Only check bars that opened AFTER entry — never exit on the bar we entered into.
      if (args.ts <= s.entryTs) continue;
      if (!isFiniteNum(args.open)) continue;

      const invalidated =
        s.dir === "LONG" ? args.open < s.structureLevel : args.open > s.structureLevel;
      if (!invalidated) continue;

      s.status = "STOPPED";
      s.stoppedOut = true;
      s.stopTs = args.ts;
      s.stopClose = args.open;
      s.barsToStop = s.bar1mCount;

      s.exec.exitReason = "STRUCTURE_BREAK";
      s.exec.exitTs = args.ts;
      s.exec.exitFill = args.open;

      s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, args.open);

      completed.push(s.alertId);
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

    // Realized $ P&L from broker truth where we have it. Falls back to null
    // if either fill or qty is missing — the UI shows that as "—" rather
    // than fabricating a number.
    const entryForPnl = s.entryFill ?? s.entryRefPrice;
    const realizedPnlUsd =
      s.qty != null && isFiniteNum(s.qty) && exitFill != null && isFiniteNum(exitFill) && isFiniteNum(entryForPnl)
        ? Number(((s.dir === "LONG" ? exitFill - entryForPnl : entryForPnl - exitFill) * s.qty).toFixed(2))
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

      exitReason,
      exitFill,
      exitReturnPct,
      stopMovedToBE: Boolean(s.exec.stopMovedToBE),

      entryFill: s.entryFill,
      qty: s.qty,
      realizedPnlUsd,

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

  /**
   * Immediately close all LIVE sessions for a symbol due to a manual broker close.
   * Returns the finalized TradeOutcome records so the caller can persist them.
   * exitPx is optional — when provided the exit return % is computed; otherwise
   * those fields are left null (e.g. if we don't know the fill price yet).
   */
  manualClose(symbol: string, exitPx?: number, exitTs?: number): TradeOutcome[] {
    const ids = this.sessionsBySymbol.get(symbol);
    if (!ids || ids.size === 0) return [];

    const now = exitTs ?? Date.now();
    const results: TradeOutcome[] = [];

    for (const id of Array.from(ids)) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;

      s.status = "COMPLETED";
      s.exec.exitReason = "MANUAL_CLOSE";
      s.exec.exitTs = now;
      s.exec.exitFill = exitPx ?? null;

      if (exitPx != null && isFiniteNum(exitPx)) {
        s.returnsPct["exit"] = computeReturnPct(s.dir, s.entryRefPrice, exitPx);
      }

      const out = this.finalize(id);
      if (out) results.push(out);
    }

    return results;
  }

  /**
   * Cancel a session that was never executed (e.g. broker order was SKIPPED/duplicate).
   * The session is removed from memory; no outcome is written.
   */
  cancelSession(alertId: string): void {
    const s = this.sessionsById.get(alertId);
    if (!s) return;
    this.sessionsById.delete(alertId);
    const set = this.sessionsBySymbol.get(s.symbol);
    if (set) {
      set.delete(alertId);
      if (set.size === 0) this.sessionsBySymbol.delete(s.symbol);
    }
  }

  /** IDs of all currently LIVE sessions (for reconciliation). */
  liveSessionIds(): string[] {
    return Array.from(this.sessionsById.values())
      .filter((s) => s.status === "LIVE")
      .map((s) => s.alertId);
  }

  /** Symbol for a given session id, or null. */
  sessionSymbol(alertId: string): string | null {
    return this.sessionsById.get(alertId)?.symbol ?? null;
  }

  /**
   * Wall-clock EOD flatten. Finalizes EVERY live session regardless of whether
   * a fresh bar arrived for it. The bar-driven EOD branch in onMinuteBar only
   * fires when a bar shows up — if a symbol's data feed dies mid-session that
   * branch never runs and the position hangs open forever (2026-05-20 incident:
   * AMZN + IWM lost their feed at 13:10 and were never flattened at 14:59).
   *
   * exitFill is left null — the caller closes the position at the broker and
   * patches the real fill via finalizeOutcomeWithBrokerFill().
   */
  eodFlattenAll(ts: number): TradeOutcome[] {
    const results: TradeOutcome[] = [];
    for (const id of Array.from(this.sessionsById.keys())) {
      const s = this.sessionsById.get(id);
      if (!s || s.status !== "LIVE") continue;
      s.status = "COMPLETED";
      s.exec.exitReason = "EOD";
      s.exec.exitTs = ts;
      s.exec.exitFill = null;
      const out = this.finalize(id);
      if (out) results.push(out);
    }
    return results;
  }

  /**
   * LIVE sessions whose last bar update (endTs) is older than maxAgeMs. A
   * healthy session updates endTs every minute via onMinuteBar; a large gap
   * means the symbol's data feed has stalled and the session is no longer
   * being risk-managed. Detection only — the caller decides what to do.
   */
  staleSessions(now: number, maxAgeMs: number): Array<{ alertId: string; symbol: string; lastBarTs: number; ageMs: number }> {
    const out: Array<{ alertId: string; symbol: string; lastBarTs: number; ageMs: number }> = [];
    for (const s of this.sessionsById.values()) {
      if (s.status !== "LIVE") continue;
      const ageMs = now - s.endTs;
      if (ageMs > maxAgeMs) {
        out.push({ alertId: s.alertId, symbol: s.symbol, lastBarTs: s.endTs, ageMs });
      }
    }
    return out;
  }
}