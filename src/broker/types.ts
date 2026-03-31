export type BrokerMode = "disabled" | "paper" | "live";

export type BrokerSizingMode = "notional" | "qty";

export type BrokerOrderType = "market";

export type BrokerTimeInForce = "day";

export type BrokerExecutionPolicy = {
  liveArmed: boolean;
  sizingMode: BrokerSizingMode;
  defaultNotional: number | null;
  defaultQty: number | null;
  orderType: BrokerOrderType;
  timeInForce: BrokerTimeInForce;
  extendedHours: boolean;
  bracketEnabled: boolean;
  stopLossPct: number | null;
  takeProfitPct: number | null;
  maxDailyNotional: number | null;
  maxOpenPositions: number | null;
  maxOrdersPerSymbolPerDay: number | null;
  avoidExistingPosition: boolean;
  avoidOpenOrders: boolean;
};

export type BrokerConfig = {
  brokerKey: string;
  mode: BrokerMode;
  config: Record<string, unknown>;
  tradingEnabled: boolean;
  execution: BrokerExecutionPolicy;
};

export type BrokerOrderStatus =
  | "SKIPPED"
  | "SUBMITTED"
  | "REJECTED"
  | "ERROR";

export type BrokerOrderRecord = {
  id?: number;
  ts: number;
  dayKey: string;
  alertId: string | null;
  symbol: string;
  direction: "CALL" | "PUT";
  setupKey: string;
  brokerKey: string;
  mode: BrokerMode;
  clientOrderId: string | null;
  brokerOrderId: string | null;
  status: BrokerOrderStatus;
  brokerStatus: string | null;
  reason: string | null;
  sizingMode: BrokerSizingMode;
  qty: number | null;
  notional: number | null;
  orderType: BrokerOrderType;
  timeInForce: BrokerTimeInForce;
  extendedHours: boolean;
  bracketEnabled: boolean;
  strategyVersion: number | null;
  requestJson: any;
  responseJson: any;
};

export type BrokerActivityRow = BrokerOrderRecord;

export type BrokerAccountSnapshot = {
  status: string;
  equity: number | null;
  cash: number | null;
  buyingPower: number | null;
};

export type BrokerPositionSnapshot = {
  symbol: string;
  qty: number | null;
  avgEntryPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
  side: string | null;
};

export type BrokerOpenOrderSnapshot = {
  id: string;
  clientOrderId: string | null;
  symbol: string;
  side: string | null;
  qty: number | null;
  notional: number | null;
  type: string | null;
  status: string | null;
  submittedAt: string | null;
};

export type BrokerDuplicateProtectionStatus = {
  active: boolean;
  strategy: string;
};

export type BrokerConnectionStateCode =
  | "connected"
  | "unauthorized"
  | "disconnected"
  | "unsupported"
  | "disabled";

export type BrokerConnectionState = {
  code: BrokerConnectionStateCode;
  label: string;
  reason: string | null;
};

export type BrokerExecutionStateCode =
  | "blocked_kill_switch"
  | "blocked_live_not_armed"
  | "blocked_strategy_disabled"
  | "ready_paper"
  | "ready_live"
  | "blocked_missing_policy"
  | "blocked_other";

export type BrokerExecutionState = {
  code: BrokerExecutionStateCode;
  label: string;
  canSubmit: boolean;
  reason: string;
};

export type BrokerGlobalSafetySnapshot = {
  executionEnabled: boolean;
  killSwitchEnabled: boolean;
  liveArmed: boolean;
};

export type BrokerStrategyCoverageSnapshot = {
  enabledStrategies: number;
  readyStrategies: number;
  disabledStrategies: number;
  missingPolicies: number;
  summary: string;
};

export type BrokerSkipSummary = {
  ts: number;
  reason: string;
  symbol: string;
  strategyVersion: number | null;
} | null;

export type BrokerStatusSnapshot = {
  ok: boolean;
  provider: string;
  mode: BrokerMode;
  configured: boolean;
  supported: boolean;
  connectionStatus: string;
  connectionState: BrokerConnectionState;
  statusText: string;
  checkedAt: number | null;
  lastSuccessfulCheckTs: number | null;
  duplicateProtection: BrokerDuplicateProtectionStatus;
  account: BrokerAccountSnapshot | null;
  positions: BrokerPositionSnapshot[];
  orders: BrokerOpenOrderSnapshot[];
  execution: BrokerExecutionPolicy | null;
  globalSafety: BrokerGlobalSafetySnapshot;
  executionState: BrokerExecutionState;
  strategyCoverage: BrokerStrategyCoverageSnapshot;
  lastSkip: BrokerSkipSummary;
  recentActivity: BrokerActivityRow[];
  warnings: string[];
  ignoredSettings: string[];
};

export type BrokerSubmitOrderRequest = {
  symbol: string;
  side: "buy" | "sell";
  clientOrderId: string;
  qty: number | null;
  notional: number | null;
  extendedHours: boolean;
};

export type BrokerSubmitOrderResult = {
  brokerOrderId: string | null;
  brokerStatus: string | null;
  raw: any;
};

export interface BrokerAdapter {
  getStatus(): Promise<{
    account: BrokerAccountSnapshot;
    positions: BrokerPositionSnapshot[];
    orders: BrokerOpenOrderSnapshot[];
  }>;
  submitMarketOrder(input: BrokerSubmitOrderRequest): Promise<BrokerSubmitOrderResult>;
}
