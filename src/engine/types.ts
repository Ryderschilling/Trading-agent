// src/engine/types.ts

export type Direction = "CALL" | "PUT";
export type TradeDirection = "LONG" | "SHORT";

export type RelativeStrength = "STRONG" | "WEAK" | "NONE";
export type MarketDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export type OutputMessage =
  | "FORMING"
  | "BREAK"
  | "BREAK_RETEST"
  | "INVALID"
  | "ENTRY"
  | "INFO";

export type SignalState = {
  symbol: string;
  lastLevel?: string;
  lastLevelPrice?: number;
  lastStructureLevel?: number;
  lastDir?: Direction;
  lastMsg?: OutputMessage;
  lastTs?: number;
};

export type Alert = {
  id: string;
  ts: number;
  symbol: string;

  market: MarketDirection;
  rs: RelativeStrength;

  dir: Direction | "—";
  level: string | "—";

  levelPrice: number | null;
  structureLevel: number | null;

  breakBarTime: number | null;
  close: number;

  message: string;
  meta?: any;
};

export type TradeOutcome = {
  alertId: string;
  symbol: string;
  dir: TradeDirection;

  structureLevel: number;

  entryTs: number;
  entryRefPrice: number;

  status: "LIVE" | "STOPPED" | "COMPLETED";
  endTs: number;

  mfeAbs: number;
  maeAbs: number;
  mfePct: number;
  maePct: number;
  timeToMfeSec: number | null;

  // stop rule: first 5m close breaches structure (legacy) OR broker-like stop
  stoppedOut: boolean;
  stopTs: number | null;
  stopClose: number | null;
  stopReturnPct: number | null;
  barsToStop: number | null;

  // broker-like execution (optional, persisted when available)
  exitReason?: "STOP" | "TARGET" | "TIME" | null;
  exitFill?: number | null;
  exitReturnPct?: number | null;
  stopMovedToBE?: boolean;

  // checkpoint returns (% from entry ref)
  returnsPct: Record<string, number>;
};