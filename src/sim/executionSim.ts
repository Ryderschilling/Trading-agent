// src/sim/executionSim.ts
export type ExecDir = "LONG" | "SHORT";

export type ExecRules = {
  // Example: stop = 1R, target = 1.5R
  stopR: number;       // e.g. 1 (set to 1 for percent mode)
  stopPct?: number;    // flat % stop from entry (e.g. 2 = 2%); overrides structure-based 1R
  targetR: number;     // e.g. 1.5

  // Optional management
  moveStopToBEAtR?: number;  // e.g. 1 means once +1R reached, stop becomes breakeven
  trailActivatePct?: number; // % MFE to activate trailing stop (e.g. 0.5 = 0.5%)
  trailDistancePct?: number; // % below peak to trail stop (e.g. 0.3 = 0.3%)
};

export type ExecState = {
  open: boolean;
  entryTs: number;
  entryPrice: number;

  // 1R in absolute $ terms (derived from entry vs structure)
  oneRAbs: number;

  stopPrice: number;
  targetPrice: number;

  beActivated: boolean;
  trailActive: boolean;
  maxHigh: number;  // running peak high (for trailing stop)
  minLow: number;   // running trough low (for trailing stop)
};

export type ExecFill = {
  exitTs: number;
  exitPrice: number;
  exitReason: "STOP" | "TARGET";
  retPct: number; // % return on the underlying from entry to exit
};

function pctMove(dir: ExecDir, entry: number, exit: number): number {
  const raw = (exit - entry) / entry;
  return dir === "LONG" ? raw : -raw;
}

/**
 * Initialize a broker-like execution state using structure-based risk.
 * 1R = abs(entryPrice - structureLevel)
 */
export function initExec(
  dir: ExecDir,
  entryTs: number,
  entryPrice: number,
  structureLevel: number,
  rules: ExecRules
): ExecState {
  if (!(rules.targetR > 0)) throw new Error("targetR must be > 0");
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("bad entryPrice");

  const percentMode = rules.stopPct != null && rules.stopPct > 0;

  // 1R: percent-based uses entry * stopPct/100; structure-based uses |entry - structure|
  let oneRAbs: number;
  if (percentMode) {
    oneRAbs = entryPrice * (rules.stopPct! / 100);
  } else {
    if (!(rules.stopR > 0)) throw new Error("stopR must be > 0");
    if (!Number.isFinite(structureLevel)) throw new Error("bad structureLevel");
    oneRAbs = Math.abs(entryPrice - structureLevel);
    if (!Number.isFinite(oneRAbs) || oneRAbs <= 0) {
      throw new Error("structureLevel equals entryPrice (1R would be 0)");
    }
  }

  const effectiveStopR = percentMode ? 1 : rules.stopR;

  const stopPrice =
    dir === "LONG"
      ? entryPrice - (effectiveStopR * oneRAbs)
      : entryPrice + (effectiveStopR * oneRAbs);

  const targetPrice =
    dir === "LONG"
      ? entryPrice + (rules.targetR * oneRAbs)
      : entryPrice - (rules.targetR * oneRAbs);

  return {
    open: true,
    entryTs,
    entryPrice,
    oneRAbs,
    stopPrice,
    targetPrice,
    beActivated: false,
    trailActive: false,
    maxHigh: entryPrice,
    minLow: entryPrice
  };
}

// Process a new 1-minute bar and determine if exit happened on this bar
export function onMinuteBarExec(
  dir: ExecDir,
  state: ExecState,
  rules: ExecRules,
  ts: number,
  high: number,
  low: number,
  close: number
): ExecFill | null {
  if (!state.open) return null;

  // Update running peak/trough for trailing stop
  if (high > state.maxHigh) state.maxHigh = high;
  if (low < state.minLow) state.minLow = low;

  // 1) Breakeven activation (if configured)
  if (rules.moveStopToBEAtR != null && rules.moveStopToBEAtR > 0 && !state.beActivated) {
    const beTrigger =
      dir === "LONG"
        ? state.entryPrice + (rules.moveStopToBEAtR * state.oneRAbs)
        : state.entryPrice - (rules.moveStopToBEAtR * state.oneRAbs);

    const touched = dir === "LONG" ? high >= beTrigger : low <= beTrigger;
    if (touched) {
      state.beActivated = true;
      state.stopPrice = state.entryPrice; // move stop to breakeven
    }
  }

  // 1b) Trailing stop: activate once MFE crosses trailActivatePct, then
  // trail stop behind the running peak by trailDistancePct.
  if (
    rules.trailActivatePct != null && rules.trailActivatePct > 0 &&
    rules.trailDistancePct != null && rules.trailDistancePct > 0
  ) {
    const mfePct = dir === "LONG"
      ? (state.maxHigh - state.entryPrice) / state.entryPrice * 100
      : (state.entryPrice - state.minLow) / state.entryPrice * 100;

    if (!state.trailActive && mfePct >= rules.trailActivatePct) {
      state.trailActive = true;
    }

    if (state.trailActive) {
      const trailDist = rules.trailDistancePct / 100;
      if (dir === "LONG") {
        const newStop = state.maxHigh * (1 - trailDist);
        if (newStop > state.stopPrice) state.stopPrice = newStop;
      } else {
        const newStop = state.minLow * (1 + trailDist);
        if (newStop < state.stopPrice) state.stopPrice = newStop;
      }
    }
  }

  // 2) Determine if stop/target hit on this bar
  // Conservative order: STOP first if both hit same bar.
  const stopHit = dir === "LONG" ? low <= state.stopPrice : high >= state.stopPrice;
  if (stopHit) {
    state.open = false;
    const exitPrice = state.stopPrice;
    return {
      exitTs: ts,
      exitPrice,
      exitReason: "STOP",
      retPct: pctMove(dir, state.entryPrice, exitPrice) * 100
    };
  }

  const targetHit = dir === "LONG" ? high >= state.targetPrice : low <= state.targetPrice;
  if (targetHit) {
    state.open = false;
    const exitPrice = state.targetPrice;
    return {
      exitTs: ts,
      exitPrice,
      exitReason: "TARGET",
      retPct: pctMove(dir, state.entryPrice, exitPrice) * 100
    };
  }

  return null;
}