export type ExitReason = "STOP" | "TARGET" | "TIME" | "EOD";

export type ExecConfig = {
  // sizing
  baseEquity: number;
  compounding: boolean;
  positionPct: number; // 0..1
  maxConcurrent?: number; // optional

  // friction
  slippageBps?: number; // e.g. 2 = 0.02%
  feePerTrade?: number; // dollars

  // trade management (from strategy config)
  stopR?: number;    // 1.0 means -1R stop
  targetR?: number;  // 2.0 means +2R target
  moveStopToBEAtR?: number; // e.g. 1.0
  trailAfterR?: number;     // e.g. 1.5
  trailByR?: number;        // e.g. 0.5
  maxHoldMin?: number;      // time exit
};

export type Fill = { ts: number; price: number };

export type OpenPos = {
  alertId: string;
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: Fill;
  qty: number;
  riskPerShare: number; // defines 1R in price terms
  stopPrice: number;
  targetPrice: number;
  beArmed: boolean;
  trailActive: boolean;
};

export type ClosedTrade = {
  alertId: string;
  symbol: string;
  dir: "LONG" | "SHORT";
  entry: Fill;
  exit: Fill;
  reason: ExitReason;
  retPct: number;
  pnl: number;
  equityAfter: number;
};