import { LevelType } from "../market/levels";
import { MarketDirection } from "../market/marketDirection";

export type OutputMessage =
  | "A+ SETUP FORMING — WAIT FOR RETEST"
  | "A+ ENTRY — BUY ON THIS 5-MIN CLOSE"
  | "A+ ENTRY (1m TAP)"
  | "NO TRADE — DOES NOT MEET RULES"
  | "SETUP INVALID — STAND DOWN";

export type Direction = "CALL" | "PUT";
export type RelativeStrength = "STRONG" | "WEAK" | "NONE";

export type SignalState =
  | { state: "IDLE" }
  | {
      state: "BROKEN";
      dir: Direction;
      levelType: LevelType;
      levelPrice: number;
      breakBarTime: number;
    }
  | { state: "COOLDOWN"; untilBarTime: number };

export type Alert = {
  id: string;
  ts: number;
  symbol: string;
  market: MarketDirection;
  rs: RelativeStrength;
  dir: Direction | "—";
  level: LevelType | "—";
  levelPrice: number | null;
  close: number;
  message: OutputMessage;

  // Frozen structure used for stop logic + outcome tracking
  structureLevel?: number | null;
  breakBarTime?: number | null;

  // optional runtime metadata
  meta?: any;
};

export type TradeDirection = "LONG" | "SHORT";
export type TradeSessionStatus = "LIVE" | "STOPPED" | "COMPLETED";

export type TradeExitReason = "STOP" | "TARGET" | "TIME" | "STOP_CLOSE" | "STRUCTURE_BREAK" | "EOD" | "MANUAL_CLOSE" | "SKIPPED";

export type TradeOutcome = {
  alertId: string;
  symbol: string;
  dir: TradeDirection;
  structureLevel: number;
  entryTs: number;
  entryRefPrice: number;

  status: TradeSessionStatus;
  endTs: number;

  // broker-like execution (optional)
  exitReason?: TradeExitReason | null;
  exitFill?: number | null;
  exitReturnPct?: number | null;
  stopMovedToBE?: boolean;

  // Broker-truth fields (populated from real fills, not simulation).
  // entryFill = filled_avg_price of the entry market order at the broker.
  // qty       = filled shares (or filled options contracts) at the broker.
  // realizedPnlUsd = qty * (exit - entry) signed by direction, in USD.
  // These are set after we poll the broker for fill prices. If polling fails
  // they stay null and the row falls back to simulated entryRefPrice / exitFill.
  entryFill?: number | null;
  qty?: number | null;
  realizedPnlUsd?: number | null;

  // excursions
  mfeAbs: number;
  maeAbs: number;
  mfePct: number;
  maePct: number;
  timeToMfeSec: number | null;

  // stop info
  stoppedOut: boolean;
  stopTs: number | null;
  stopClose: number | null;
  stopReturnPct: number | null;
  barsToStop: number | null;

  // checkpoint returns (% from entry ref). May include "exit".
  returnsPct: Record<string, number>;
};