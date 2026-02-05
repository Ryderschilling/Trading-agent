import { LevelType } from "../market/levels";
import { MarketDirection } from "../market/marketDirection";

export type OutputMessage =
  | "A+ SETUP FORMING — WAIT FOR RETEST"
  | "A+ ENTRY — BUY ON THIS 5-MIN CLOSE"
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
};
