// src/sim/executionSim.ts
export type ExecDir = "LONG" | "SHORT";

export type ExecRules = {
  // Example: stop = 1R, target = 2R
  stopR: number;       // e.g. 1
  targetR: number;     // e.g. 2

  // Optional management
  moveStopToBEAtR?: number; // e.g. 1 means once +1R reached, stop becomes breakeven
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
  if (!(rules.stopR > 0)) throw new Error("stopR must be > 0");
  if (!(rules.targetR > 0)) throw new Error("targetR must be > 0");

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) throw new Error("bad entryPrice");
  if (!Number.isFinite(structureLevel)) throw new Error("bad structureLevel");

  const oneRAbs = Math.abs(entryPrice - structureLevel);
  if (!Number.isFinite(oneRAbs) || oneRAbs <= 0) {
    throw new Error("structureLevel equals entryPrice (1R would be 0)");
  }

  const stopPrice =
    dir === "LONG"
      ? entryPrice - (rules.stopR * oneRAbs)
      : entryPrice + (rules.stopR * oneRAbs);

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
    beActivated: false
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