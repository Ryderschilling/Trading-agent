import type { ExecRules } from "../engine/outcomeTracker";

export const STRATEGY_SCHEMA_VERSION = 3 as const;

export type StrategySetupType = "break_retest" | "ma_cross";
export type StrategyDirection = "both" | "long" | "short";
export type MovingAverageType = "EMA" | "SMA";
export type BreakRetestLevel = "pmh" | "pml" | "vwap" | "moving_average";
export type BreakConfirmation = "close_through" | "wick_and_close";
export type RetestConfirmation = "wick_hold" | "reclaim_close" | "close_hold";
export type BreakRetestEntryTrigger = "retest_close" | "next_bar_break";
export type MaCrossEntryReference =
  | "cross"
  | "fast_ma_pullback"
  | "slow_ma_pullback"
  | "vwap_pullback"
  | "cross_zone_pullback";
export type SessionMode = "regular" | "premarket" | "both";
export type RiskMode = "percent_account" | "fixed_dollars";
export type StopMode = "structure_close" | "ma_fail_close" | "r_multiple";

export type BreakRetestSetup = {
  levels: BreakRetestLevel[];
  movingAverage: {
    type: MovingAverageType;
    values: number[];
  } | null;
  breakConfirmation: BreakConfirmation;
  retestConfirmation: RetestConfirmation;
  maxRetestBars: number;
  entryTrigger: BreakRetestEntryTrigger;
};

export type MaCrossSetup = {
  maType: MovingAverageType;
  fastValue: number;
  slowValue: number;
  entryReference: MaCrossEntryReference;
  requireCloseAfterCross: boolean;
  requireRetest: boolean;
  maxEntryBarsAfterCross: number;
  requireVwapAgreement: boolean;
};

export type StrategyFilters = {
  session: SessionMode;
  universe: "watchlist";
  minVolume: number | null;
  minVolatilityPct: number | null;
  requireMarketBias: boolean;
  requireSpyQqqAlignment: boolean;
  requireVwapAgreement: boolean;
  requireRelativeStrength: boolean;
};

export type StrategyRisk = {
  riskMode: RiskMode;
  riskValue: number;
  stopMode: StopMode;
  stopValueR: number | null;
  profitTargetR: number | null;
  moveToBreakevenAtR: number | null;
  timeExitBars: number | null;
  maxOpenPositions: number;
};

export type StrategyBrokerControls = {
  maxTradesPerDay: number | null;
  maxCapital: number | null;
};

export type StrategyDefinition = {
  version: typeof STRATEGY_SCHEMA_VERSION;
  name: string | null;
  description: string | null;
  setupType: StrategySetupType;
  timeframeMin: number;
  direction: StrategyDirection;
  setup: BreakRetestSetup | MaCrossSetup;
  filters: StrategyFilters;
  risk: StrategyRisk;
  brokerCaps: StrategyBrokerControls;
};

type PartialRecord = Record<string, unknown>;

function asObject(value: unknown): PartialRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as PartialRecord) : {};
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function finiteNumber(value: unknown): number | null {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function finitePositive(value: unknown): number | null {
  const n = finiteNumber(value);
  return n != null && n > 0 ? n : null;
}

function finiteNonNegative(value: unknown): number | null {
  const n = finiteNumber(value);
  return n != null && n >= 0 ? n : null;
}

function finiteInteger(value: unknown, min = 0): number | null {
  const n = finiteNumber(value);
  return n != null && n >= min ? Math.floor(n) : null;
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value == null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeStrategySetupType(value: unknown, fallback: StrategySetupType): StrategySetupType {
  return value === "ma_cross" || value === "break_retest" ? value : fallback;
}

function normalizeDirection(value: unknown, fallback: StrategyDirection): StrategyDirection {
  if (value === "both" || value === "long" || value === "short") return value;
  if (value === "long_only") return "long";
  if (value === "short_only") return "short";
  return fallback;
}

function normalizeSession(value: unknown, fallback: SessionMode): SessionMode {
  if (value === "regular" || value === "premarket" || value === "both") return value;
  if (value === "extended" || value === "after_hours" || value === "custom") return "both";
  return fallback;
}

function normalizeRiskMode(value: unknown, fallback: RiskMode): RiskMode {
  if (value === "fixed_dollars" || value === "fixed_dollar") return "fixed_dollars";
  if (value === "percent_account" || value === "percent_of_account") return "percent_account";
  return fallback;
}

function normalizeStopMode(value: unknown, fallback: StopMode): StopMode {
  if (value === "structure_close" || value === "ma_fail_close" || value === "r_multiple") return value;
  return fallback;
}

function normalizeMovingAverageType(value: unknown, fallback: MovingAverageType): MovingAverageType {
  return String(value || "").trim().toUpperCase() === "SMA" ? "SMA" : fallback;
}

function normalizeBreakConfirmation(value: unknown, fallback: BreakConfirmation): BreakConfirmation {
  return value === "wick_and_close" || value === "close_through" ? value : fallback;
}

function normalizeRetestConfirmation(value: unknown, fallback: RetestConfirmation): RetestConfirmation {
  return value === "wick_hold" || value === "reclaim_close" || value === "close_hold" ? value : fallback;
}

function normalizeBreakRetestEntryTrigger(value: unknown, fallback: BreakRetestEntryTrigger): BreakRetestEntryTrigger {
  return value === "next_bar_break" || value === "retest_close" ? value : fallback;
}

function normalizeMaCrossEntryReference(value: unknown, fallback: MaCrossEntryReference): MaCrossEntryReference {
  if (
    value === "cross" ||
    value === "fast_ma_pullback" ||
    value === "slow_ma_pullback" ||
    value === "vwap_pullback" ||
    value === "cross_zone_pullback"
  ) {
    return value;
  }
  return fallback;
}

function normalizeBreakRetestLevels(value: unknown, fallback: BreakRetestLevel[]): BreakRetestLevel[] {
  if (!Array.isArray(value)) return fallback;
  const allowed = new Set<BreakRetestLevel>(["pmh", "pml", "vwap", "moving_average"]);
  const out = value
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item): item is BreakRetestLevel => allowed.has(item as BreakRetestLevel));
  const deduped = Array.from(new Set(out));
  return deduped.length ? deduped : fallback;
}

function normalizeMaValues(value: unknown): number[] {
  if (Array.isArray(value)) {
    return Array.from(
      new Set(
        value.map((item) => finiteInteger(item, 1)).filter((item): item is number => item != null && item <= 500)
      )
    ).sort((a, b) => a - b);
  }

  if (typeof value === "string") {
    return Array.from(
      new Set(
        value
          .split(",")
          .map((item) => finiteInteger(item.trim(), 1))
          .filter((item): item is number => item != null && item <= 500)
      )
    ).sort((a, b) => a - b);
  }

  return [];
}

export function inferTradingStyleFromTimeframe(timeframeMin: number): "scalping" | "day" | "swing" | "position" {
  if (timeframeMin <= 5) return "scalping";
  if (timeframeMin <= 60) return "day";
  if (timeframeMin <= 240) return "swing";
  return "position";
}

export function defaultStrategyDefinition(setupType: StrategySetupType = "break_retest", name?: string | null): StrategyDefinition {
  return {
    version: STRATEGY_SCHEMA_VERSION,
    name: name?.trim() || null,
    description: null,
    setupType,
    timeframeMin: 5,
    direction: "both",
    setup:
      setupType === "ma_cross"
        ? {
            maType: "EMA",
            fastValue: 9,
            slowValue: 20,
            entryReference: "cross",
            requireCloseAfterCross: true,
            requireRetest: false,
            maxEntryBarsAfterCross: 3,
            requireVwapAgreement: true,
          }
        : {
            levels: ["pmh", "pml", "vwap"],
            movingAverage: null,
            breakConfirmation: "close_through",
            retestConfirmation: "reclaim_close",
            maxRetestBars: 3,
            entryTrigger: "retest_close",
          },
    filters: {
      session: "regular",
      universe: "watchlist",
      minVolume: 1000000,
      minVolatilityPct: 0.75,
      requireMarketBias: true,
      requireSpyQqqAlignment: true,
      requireVwapAgreement: true,
      requireRelativeStrength: true,
    },
    risk: {
      riskMode: "percent_account",
      riskValue: 1,
      stopMode: setupType === "ma_cross" ? "ma_fail_close" : "structure_close",
      stopValueR: 1,
      profitTargetR: 2,
      moveToBreakevenAtR: 1,
      timeExitBars: 20,
      maxOpenPositions: 3,
    },
    brokerCaps: {
      maxTradesPerDay: 4,
      maxCapital: 10000,
    },
  };
}

function normalizeBreakRetestSetup(value: unknown, fallback?: BreakRetestSetup): BreakRetestSetup {
  const src = asObject(value);
  const base = fallback ?? (defaultStrategyDefinition("break_retest").setup as BreakRetestSetup);
  const movingAverageSrc = asObject(src.movingAverage);
  const levels = normalizeBreakRetestLevels(src.levels, base.levels);
  const includeMovingAverage = levels.includes("moving_average");
  const values = normalizeMaValues(movingAverageSrc.values);

  return {
    levels,
    movingAverage: includeMovingAverage
      ? {
          type: normalizeMovingAverageType(movingAverageSrc.type, "EMA"),
          values: values.length ? values : [9, 20],
        }
      : null,
    breakConfirmation: normalizeBreakConfirmation(src.breakConfirmation, base.breakConfirmation),
    retestConfirmation: normalizeRetestConfirmation(src.retestConfirmation, base.retestConfirmation),
    maxRetestBars: finiteInteger(src.maxRetestBars, 1) ?? base.maxRetestBars,
    entryTrigger: normalizeBreakRetestEntryTrigger(src.entryTrigger, base.entryTrigger),
  };
}

function normalizeMaCrossSetup(value: unknown, fallback?: MaCrossSetup): MaCrossSetup {
  const src = asObject(value);
  const base = fallback ?? (defaultStrategyDefinition("ma_cross").setup as MaCrossSetup);
  const fastValue = finiteInteger(src.fastValue, 1) ?? base.fastValue;
  const slowValue = finiteInteger(src.slowValue, fastValue + 1) ?? Math.max(base.slowValue, fastValue + 1);

  return {
    maType: normalizeMovingAverageType(src.maType, base.maType),
    fastValue,
    slowValue: slowValue > fastValue ? slowValue : fastValue + 1,
    entryReference: normalizeMaCrossEntryReference(src.entryReference, base.entryReference),
    requireCloseAfterCross: normalizeBool(src.requireCloseAfterCross, base.requireCloseAfterCross),
    requireRetest: normalizeBool(src.requireRetest, base.requireRetest),
    maxEntryBarsAfterCross: finiteInteger(src.maxEntryBarsAfterCross, 1) ?? base.maxEntryBarsAfterCross,
    requireVwapAgreement: normalizeBool(src.requireVwapAgreement, base.requireVwapAgreement),
  };
}

function normalizeCurrentShape(input: unknown, opts?: { name?: string | null }): StrategyDefinition {
  const src = asObject(input);
  const setupType = normalizeStrategySetupType(src.setupType, "break_retest");
  const base = defaultStrategyDefinition(setupType, opts?.name ?? asTrimmedString(src.name));
  const filtersSrc = asObject(src.filters);
  const riskSrc = asObject(src.risk);
  const brokerCapsSrc = asObject(src.brokerCaps);

  return {
    version: STRATEGY_SCHEMA_VERSION,
    name: opts?.name?.trim() || asTrimmedString(src.name) || base.name,
    description: asTrimmedString(src.description),
    setupType,
    timeframeMin: finiteInteger(src.timeframeMin, 1) ?? base.timeframeMin,
    direction: normalizeDirection(src.direction, base.direction),
    setup: setupType === "ma_cross" ? normalizeMaCrossSetup(src.setup, base.setup as MaCrossSetup) : normalizeBreakRetestSetup(src.setup, base.setup as BreakRetestSetup),
    filters: {
      session: normalizeSession(filtersSrc.session, base.filters.session),
      universe: "watchlist",
      minVolume: finiteNonNegative(filtersSrc.minVolume),
      minVolatilityPct: finiteNonNegative(filtersSrc.minVolatilityPct),
      requireMarketBias: normalizeBool(filtersSrc.requireMarketBias, base.filters.requireMarketBias),
      requireSpyQqqAlignment: normalizeBool(filtersSrc.requireSpyQqqAlignment, base.filters.requireSpyQqqAlignment),
      requireVwapAgreement: normalizeBool(filtersSrc.requireVwapAgreement, base.filters.requireVwapAgreement),
      requireRelativeStrength: normalizeBool(filtersSrc.requireRelativeStrength, base.filters.requireRelativeStrength),
    },
    risk: {
      riskMode: normalizeRiskMode(riskSrc.riskMode, base.risk.riskMode),
      riskValue: finitePositive(riskSrc.riskValue) ?? base.risk.riskValue,
      stopMode: normalizeStopMode(riskSrc.stopMode, base.risk.stopMode),
      stopValueR: finitePositive(riskSrc.stopValueR),
      profitTargetR: finitePositive(riskSrc.profitTargetR),
      moveToBreakevenAtR: finitePositive(riskSrc.moveToBreakevenAtR),
      timeExitBars: finiteInteger(riskSrc.timeExitBars, 1),
      maxOpenPositions: finiteInteger(riskSrc.maxOpenPositions, 1) ?? base.risk.maxOpenPositions,
    },
    brokerCaps: {
      maxTradesPerDay: finiteInteger(brokerCapsSrc.maxTradesPerDay, 0),
      maxCapital: finitePositive(brokerCapsSrc.maxCapital),
    },
  };
}

function mapLegacySession(value: unknown, fallback: SessionMode): SessionMode {
  const text = String(value || "").trim().toUpperCase();
  if (text === "RTH" || text === "REGULAR") return "regular";
  if (text === "ALL") return "both";
  return normalizeSession(value, fallback);
}

function migrateLegacyFlat(input: unknown, opts?: { name?: string | null }): StrategyDefinition {
  const legacy = asObject(input);
  const timeframeMin = finiteInteger(legacy.timeframeMin, 1) ?? 5;
  const triggerType = String(legacy.triggerType || "").trim().toUpperCase();
  const indicators = asObject(legacy.indicators);
  const brokerExecution = asObject(legacy.brokerExecution);
  const post = asObject(legacy.post);
  const orb = asObject(legacy.orb);
  const emaPeriods = normalizeMaValues(legacy.emaPeriods);
  const setupType: StrategySetupType = triggerType === "MA_CROSS" || (normalizeBool(indicators.movingAverages, false) && emaPeriods.length >= 2)
    ? "ma_cross"
    : "break_retest";

  const base = defaultStrategyDefinition(setupType, opts?.name ?? asTrimmedString(legacy.name));

  const setup =
    setupType === "ma_cross"
      ? normalizeMaCrossSetup({
          maType: "EMA",
          fastValue: emaPeriods[0] ?? 9,
          slowValue: emaPeriods[1] ?? 20,
          entryReference: normalizeBool(legacy.premarketEnabled, false) ? "vwap_pullback" : "cross",
          requireCloseAfterCross: true,
          requireRetest: String(legacy.emaTrigger || "").trim().toUpperCase().includes("RETEST"),
          maxEntryBarsAfterCross: 3,
          requireVwapAgreement: normalizeBool(indicators.vwap, true),
        })
      : normalizeBreakRetestSetup({
          levels: normalizeBool(legacy.premarketEnabled, false) ? ["pmh", "pml"] : ["pmh", "pml", normalizeBool(indicators.vwap, true) ? "vwap" : null].filter(Boolean),
          movingAverage: emaPeriods.length
            ? {
                type: "EMA",
                values: emaPeriods,
              }
            : null,
          breakConfirmation: orb.entryMode === "BREAK" ? "close_through" : "wick_and_close",
          retestConfirmation: "reclaim_close",
          maxRetestBars: 3,
          entryTrigger: orb.entryMode === "BREAK" ? "next_bar_break" : "retest_close",
        });

  return {
    version: STRATEGY_SCHEMA_VERSION,
    name: opts?.name?.trim() || asTrimmedString(legacy.name) || base.name,
    description: asTrimmedString(legacy.description),
    setupType,
    timeframeMin,
    direction:
      normalizeBool(brokerExecution.allowLong, true) && !normalizeBool(brokerExecution.allowShort, true)
        ? "long"
        : !normalizeBool(brokerExecution.allowLong, true) && normalizeBool(brokerExecution.allowShort, true)
        ? "short"
        : "both",
    setup,
    filters: {
      session: mapLegacySession(legacy.scanSession, base.filters.session),
      universe: "watchlist",
      minVolume: null,
      minVolatilityPct: null,
      requireMarketBias: normalizeBool(legacy.marketBiasRequired, base.filters.requireMarketBias),
      requireSpyQqqAlignment: normalizeBool(legacy.sectorAlignmentEnabled, base.filters.requireSpyQqqAlignment),
      requireVwapAgreement: normalizeBool(indicators.vwap, base.filters.requireVwapAgreement),
      requireRelativeStrength: normalizeBool(indicators.relativeStrength, true),
    },
    risk: {
      riskMode: "percent_account",
      riskValue: 1,
      stopMode: finitePositive(post.stopR) != null ? "r_multiple" : setupType === "ma_cross" ? "ma_fail_close" : "structure_close",
      stopValueR: finitePositive(post.stopR) ?? 1,
      profitTargetR: finitePositive(post.targetR) ?? 2,
      moveToBreakevenAtR: normalizeBool(post.moveBeEnabled, false) ? finitePositive(post.moveBeAtR) ?? 1 : null,
      timeExitBars: finiteInteger(post.maxHoldBars, 1),
      maxOpenPositions: finiteInteger(brokerExecution.maxOpenPositionsForStrategy, 1) ?? base.risk.maxOpenPositions,
    },
    brokerCaps: {
      maxTradesPerDay:
        normalizeBool(brokerExecution.enabled, true) === false
          ? 0
          : finiteInteger(brokerExecution.maxOrdersPerSymbolPerDay, 0),
      maxCapital: null,
    },
  };
}

function migrateLegacyNested(input: unknown, opts?: { name?: string | null }): StrategyDefinition {
  const src = asObject(input);
  const general = asObject(src.general);
  const entry = asObject(src.entry);
  const filters = asObject(src.filters);
  const indicators = asObject(filters.indicators);
  const marketBias = asObject(filters.marketBias);
  const exit = asObject(src.exit);
  const profitTarget = asObject(exit.profitTarget);
  const stopLoss = asObject(exit.stopLoss);
  const trailingStop = asObject(exit.trailingStop);
  const timeExit = asObject(exit.timeExit);
  const risk = asObject(src.risk);
  const perTradeRisk = asObject(risk.perTradeRisk);
  const broker = asObject(src.broker);
  const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];

  const maTrigger = triggers.find((item) => asObject(item).type === "moving_average_crossover");
  const breakTrigger = triggers.find((item) => {
    const type = asObject(item).type;
    return type === "breakout_retest" || type === "opening_range_breakout" || type === "premarket_breakout";
  });

  const timeframeMin = finiteInteger(general.defaultTimeframeMin, 1) ?? finiteInteger(src.timeframeMin, 1) ?? 5;
  const setupType: StrategySetupType = maTrigger ? "ma_cross" : "break_retest";
  const base = defaultStrategyDefinition(setupType, opts?.name ?? asTrimmedString(general.name));
  const emaPeriods = normalizeMaValues(indicators.emaPeriods);
  const maTriggerObj = asObject(maTrigger);
  const breakTriggerObj = asObject(breakTrigger);
  const breakTriggerType = String(breakTriggerObj.type || "");

  const setup =
    setupType === "ma_cross"
      ? normalizeMaCrossSetup({
          maType: "EMA",
          fastValue: finiteInteger(maTriggerObj.fastPeriod, 1) ?? emaPeriods[0] ?? 9,
          slowValue: finiteInteger(maTriggerObj.slowPeriod, 2) ?? emaPeriods[1] ?? 20,
          entryReference:
            indicators.emaTrigger === "retest" || indicators.emaTrigger === "break_retest"
              ? "cross_zone_pullback"
              : "cross",
          requireCloseAfterCross: true,
          requireRetest: indicators.emaTrigger === "retest" || indicators.emaTrigger === "break_retest",
          maxEntryBarsAfterCross: 3,
          requireVwapAgreement: normalizeBool(indicators.vwap, true),
        })
      : normalizeBreakRetestSetup({
          levels: [
            breakTriggerType === "premarket_breakout" || breakTriggerType === "opening_range_breakout" ? "pmh" : "pmh",
            breakTriggerType === "premarket_breakout" || breakTriggerType === "opening_range_breakout" ? "pml" : "pml",
            normalizeBool(indicators.vwap, false) ? "vwap" : null,
            normalizeBool(indicators.movingAverages, false) || emaPeriods.length ? "moving_average" : null,
          ].filter(Boolean),
          movingAverage:
            normalizeBool(indicators.movingAverages, false) || emaPeriods.length
              ? {
                  type: "EMA",
                  values: emaPeriods.length ? emaPeriods : [9, 20],
                }
              : null,
          breakConfirmation: breakTriggerType === "opening_range_breakout" ? "wick_and_close" : "close_through",
          retestConfirmation: "reclaim_close",
          maxRetestBars: 3,
          entryTrigger: breakTriggerType === "opening_range_breakout" ? "next_bar_break" : "retest_close",
        });

  return {
    version: STRATEGY_SCHEMA_VERSION,
    name: opts?.name?.trim() || asTrimmedString(general.name) || base.name,
    description: asTrimmedString(general.description),
    setupType,
    timeframeMin,
    direction: normalizeDirection(general.direction, "both"),
    setup,
    filters: {
      session: normalizeSession(asObject(filters.tradingHours).mode, base.filters.session),
      universe: "watchlist",
      minVolume: finiteNonNegative(filters.minVolume),
      minVolatilityPct: finiteNonNegative(filters.minVolatilityPct),
      requireMarketBias: normalizeBool(marketBias.required, base.filters.requireMarketBias),
      requireSpyQqqAlignment: normalizeBool(filters.sectorAlignment, base.filters.requireSpyQqqAlignment),
      requireVwapAgreement: normalizeBool(indicators.vwap, base.filters.requireVwapAgreement),
      requireRelativeStrength: normalizeBool(indicators.relativeStrength, true),
    },
    risk: {
      riskMode: normalizeRiskMode(perTradeRisk.mode, base.risk.riskMode),
      riskValue: finitePositive(perTradeRisk.value) ?? base.risk.riskValue,
      stopMode:
        stopLoss.mode === "r_multiple"
          ? "r_multiple"
          : setupType === "ma_cross"
          ? "ma_fail_close"
          : "structure_close",
      stopValueR: finitePositive(stopLoss.value) ?? 1,
      profitTargetR: finitePositive(profitTarget.value) ?? 2,
      moveToBreakevenAtR: normalizeBool(trailingStop.moveToBreakeven, false) ? finitePositive(trailingStop.moveToBreakevenAt) ?? 1 : null,
      timeExitBars: finiteInteger(timeExit.afterBars, 1),
      maxOpenPositions: finiteInteger(risk.maxOpenPositions, 1) ?? base.risk.maxOpenPositions,
    },
    brokerCaps: {
      maxTradesPerDay: finiteInteger(broker.maxTradesPerDay, 0),
      maxCapital: finitePositive(broker.maxCapital),
    },
  };
}

export function normalizeStrategyDefinition(input: unknown, opts?: { name?: string | null }): StrategyDefinition {
  const src = asObject(input);
  if ("setupType" in src || "brokerCaps" in src) return normalizeCurrentShape(input, opts);
  if ("general" in src || "entry" in src || "filters" in src || "risk" in src || "broker" in src) {
    return migrateLegacyNested(input, opts);
  }
  return migrateLegacyFlat(input, opts);
}

export function getStrategyTimeframeMin(strategy: StrategyDefinition): number {
  return finiteInteger(strategy.timeframeMin, 1) ?? 5;
}

export function getStrategyLookbackWindowBars(strategy: StrategyDefinition): number {
  const tf = getStrategyTimeframeMin(strategy);
  if (tf <= 5) return 24;
  if (tf <= 60) return 30;
  return 40;
}

export function getStrategyStructureLookbackBars(strategy: StrategyDefinition): number {
  const tf = getStrategyTimeframeMin(strategy);
  if (tf <= 5) return 100;
  if (tf <= 60) return 120;
  return 180;
}

export function getStrategyRetestTolerancePct(strategy: StrategyDefinition): number {
  if (strategy.setupType === "ma_cross") return 0.1;
  const setup = strategy.setup as BreakRetestSetup;
  if (setup.breakConfirmation === "wick_and_close") return 0.2;
  return 0.15;
}

export function getStrategyEmaPeriods(strategy: StrategyDefinition): number[] {
  if (strategy.setupType === "ma_cross") {
    const setup = strategy.setup as MaCrossSetup;
    return Array.from(new Set([setup.fastValue, setup.slowValue])).sort((a, b) => a - b);
  }
  const setup = strategy.setup as BreakRetestSetup;
  if (setup.movingAverage?.type === "EMA") {
    return normalizeMaValues(setup.movingAverage.values);
  }
  return [];
}

export function getStrategyShowVwap(strategy: StrategyDefinition): boolean {
  if (strategy.setupType === "break_retest" && (strategy.setup as BreakRetestSetup).levels.includes("vwap")) return true;
  if (
    strategy.setupType === "ma_cross" &&
    ((strategy.setup as MaCrossSetup).requireVwapAgreement || (strategy.setup as MaCrossSetup).entryReference === "vwap_pullback")
  ) {
    return true;
  }
  return Boolean(strategy.filters.requireVwapAgreement);
}

export function getStrategyBrokerControls(strategy: StrategyDefinition): StrategyBrokerControls {
  return {
    maxTradesPerDay: finiteInteger(strategy.brokerCaps.maxTradesPerDay, 0),
    maxCapital: finitePositive(strategy.brokerCaps.maxCapital),
  };
}

export function strategyAllowsDirection(strategy: StrategyDefinition, direction: "CALL" | "PUT" | "LONG" | "SHORT"): boolean {
  const wantLong = direction === "CALL" || direction === "LONG";
  if (strategy.direction === "both") return true;
  if (strategy.direction === "long") return wantLong;
  return !wantLong;
}

export function buildOutcomeExecRules(strategy: StrategyDefinition): ExecRules | undefined {
  if (strategy.risk.stopMode !== "r_multiple" || strategy.risk.stopValueR == null) return undefined;
  if (strategy.risk.profitTargetR == null) return undefined;

  const out: ExecRules = {
    stopR: strategy.risk.stopValueR,
    targetR: strategy.risk.profitTargetR,
  };

  if (strategy.risk.moveToBreakevenAtR != null) {
    out.moveStopToBEAtR = strategy.risk.moveToBreakevenAtR;
  }

  return out;
}
