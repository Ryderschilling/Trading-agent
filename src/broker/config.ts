import {
  BrokerConfig,
  BrokerExecutionPolicy,
  BrokerMode,
} from "./types";

export const MASKED_SECRET = "********";

export const DEFAULT_EXECUTION_POLICY: BrokerExecutionPolicy = {
  liveArmed: false,
  sizingMode: "notional",
  defaultNotional: 1000,
  defaultQty: 1,
  orderType: "market",
  timeInForce: "day",
  extendedHours: false,
  bracketEnabled: false,
  stopLossPct: null,
  takeProfitPct: null,
  maxDailyNotional: 5000,
  maxOpenPositions: 5,
  maxOrdersPerSymbolPerDay: 1,
  avoidExistingPosition: true,
  avoidOpenOrders: true,
};

function finitePositive(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function finiteInteger(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

export function normalizeBrokerMode(value: any, brokerKey?: string): BrokerMode {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "live") return "live";
  if (mode === "paper") return "paper";
  if (mode === "disabled") return "disabled";
  return brokerKey ? "paper" : "disabled";
}

export function normalizeExecutionPolicy(input: any): BrokerExecutionPolicy {
  const src = input && typeof input === "object" ? input : {};
  const sizingMode = String(src.sizingMode || DEFAULT_EXECUTION_POLICY.sizingMode) === "qty" ? "qty" : "notional";

  return {
    liveArmed: Boolean(src.liveArmed),
    sizingMode,
    defaultNotional: finitePositive(src.defaultNotional) ?? DEFAULT_EXECUTION_POLICY.defaultNotional,
    defaultQty: finitePositive(src.defaultQty) ?? DEFAULT_EXECUTION_POLICY.defaultQty,
    orderType: "market",
    timeInForce: "day",
    extendedHours: Boolean(src.extendedHours),
    bracketEnabled: Boolean(src.bracketEnabled),
    stopLossPct: finitePositive(src.stopLossPct),
    takeProfitPct: finitePositive(src.takeProfitPct),
    maxDailyNotional: finitePositive(src.maxDailyNotional) ?? DEFAULT_EXECUTION_POLICY.maxDailyNotional,
    maxOpenPositions: finiteInteger(src.maxOpenPositions) ?? DEFAULT_EXECUTION_POLICY.maxOpenPositions,
    maxOrdersPerSymbolPerDay: finiteInteger(src.maxOrdersPerSymbolPerDay) ?? DEFAULT_EXECUTION_POLICY.maxOrdersPerSymbolPerDay,
    avoidExistingPosition: src.avoidExistingPosition == null ? true : Boolean(src.avoidExistingPosition),
    avoidOpenOrders: src.avoidOpenOrders == null ? true : Boolean(src.avoidOpenOrders),
  };
}

export function normalizeBrokerConfig(input: any): BrokerConfig {
  const brokerKey = String(input?.brokerKey || "").trim();
  return {
    brokerKey,
    mode: normalizeBrokerMode(input?.mode, brokerKey),
    config: input?.config && typeof input.config === "object" ? { ...input.config } : {},
    tradingEnabled: Boolean(input?.tradingEnabled),
    execution: normalizeExecutionPolicy(input?.execution),
  };
}

export function maskSecretConfig(config: Record<string, unknown>, secretKeys: string[]): Record<string, unknown> {
  const out = { ...config };
  for (const key of secretKeys) {
    if (out[key]) out[key] = MASKED_SECRET;
  }
  return out;
}

export function mergeSecretConfig(args: {
  existing: Record<string, unknown>;
  next: Record<string, unknown>;
  secretKeys: string[];
}): Record<string, unknown> {
  const out = { ...args.existing };
  for (const [key, value] of Object.entries(args.next || {})) {
    if (!args.secretKeys.includes(key)) {
      out[key] = value;
      continue;
    }

    const nextValue = String(value ?? "");
    if (!nextValue || nextValue === MASKED_SECRET) continue;
    out[key] = value;
  }
  return out;
}
