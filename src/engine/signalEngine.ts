import crypto from "crypto";
import { Bar5, MarketDirection } from "../market/marketDirection";
import { LevelType, Levels, getLevelPrice } from "../market/levels";
import { computeRS } from "./rs";
import { Alert, Direction, OutputMessage, RelativeStrength, SignalState } from "./types";

export type EngineConfig = {
  timeframeMin: number;
  retestTolerancePct: number; // 0.001 = 0.10%
  rsWindowBars5m: number; // 3 = 15 minutes
};

export type SymbolContext = {
  levels: Levels;
  bars5: Bar5[];
  state: SignalState;
};

export class SignalEngine {
  private cfg: EngineConfig;
  private ctx: Map<string, SymbolContext> = new Map();

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
  }

  ensureSymbol(symbol: string, levels: Levels) {
    if (!this.ctx.has(symbol)) {
      this.ctx.set(symbol, { levels, bars5: [], state: { state: "IDLE" } });
    } else {
      // keep levels reference updated
      this.ctx.get(symbol)!.levels = levels;
    }
  }

  pushBar5(symbol: string, bar: Bar5) {
    const c = this.ctx.get(symbol);
    if (!c) return;
    c.bars5.push(bar);
    if (c.bars5.length > 500) c.bars5.shift();
  }

  evaluateSymbol(args: {
    symbol: string;
    marketDir: MarketDirection;
    spyBars5: Bar5[];
    symBars5: Bar5[];
    symLevels: Levels;
  }): Alert | null {
    const { symbol, marketDir, spyBars5, symBars5, symLevels } = args;

    const last = symBars5.at(-1);
    if (!last) return null;

    const ctx = this.ctx.get(symbol);
    if (!ctx) return null;

    // Gate 0: market neutral blocks all signals
    if (marketDir === "NEUTRAL") {
      if (ctx.state.state === "BROKEN") {
        return this.emitAndCooldown(symbol, marketDir, "NONE", "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      return null;
    }

    const dir: Direction = marketDir === "BULLISH" ? "CALL" : "PUT";

    // Gate 2: RS filter
    const rs: RelativeStrength = computeRS({
      marketDir,
      symBars5,
      spyBars5,
      windowBars: this.cfg.rsWindowBars5m
    });

    // Cooldown expiry
    if (ctx.state.state === "COOLDOWN") {
      if (Date.now() > ctx.state.untilBarTime) ctx.state = { state: "IDLE" };
      else return null;
    }

    // If we were BROKEN, monitor retest / invalidation
    if (ctx.state.state === "BROKEN") {
      const s = ctx.state;

      // invalidation: market flips
      if (s.dir !== dir) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      // invalidation: RS lost
      if (dir === "CALL" && rs !== "STRONG") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      if (dir === "PUT" && rs !== "WEAK") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      // invalidation: closes back inside the range (wrong side of broken level)
      if (s.dir === "CALL" && last.c < s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      if (s.dir === "PUT" && last.c > s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      // retest must occur after break candle
      if (last.t <= s.breakBarTime) return null;

      // retest = price returns near the level (touch/near-touch)
      const tol = Math.abs(s.levelPrice) * this.cfg.retestTolerancePct;
      const touched = last.l <= s.levelPrice + tol && last.h >= s.levelPrice - tol;
      if (!touched) return null;

      // retest candle must close on correct side
      if (s.dir === "CALL") {
        if (last.c > s.levelPrice) {
          return this.emitAndCooldown(symbol, marketDir, rs, "CALL", s.levelType, s.levelPrice, last.c, "A+ ENTRY — BUY ON THIS 5-MIN CLOSE");
        }
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      } else {
        if (last.c < s.levelPrice) {
          return this.emitAndCooldown(symbol, marketDir, rs, "PUT", s.levelType, s.levelPrice, last.c, "A+ ENTRY — BUY ON THIS 5-MIN CLOSE");
        }
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
    }

    // IDLE: find a break (only allowed levels)
    if (dir === "CALL") {
      const candidates: LevelType[] = ["PMH", "PDH"];
      for (const lt of candidates) {
        const lp = getLevelPrice(symLevels, lt);
        if (lp == null) continue;
        if (last.c > lp && rs === "STRONG") {
          ctx.state = { state: "BROKEN", dir: "CALL", levelType: lt, levelPrice: lp, breakBarTime: last.t };
          return this.emit(symbol, marketDir, rs, "CALL", lt, lp, last.c, "A+ SETUP FORMING — WAIT FOR RETEST");
        }
      }
    } else {
      const candidates: LevelType[] = ["PML", "PDL"];
      for (const lt of candidates) {
        const lp = getLevelPrice(symLevels, lt);
        if (lp == null) continue;
        if (last.c < lp && rs === "WEAK") {
          ctx.state = { state: "BROKEN", dir: "PUT", levelType: lt, levelPrice: lp, breakBarTime: last.t };
          return this.emit(symbol, marketDir, rs, "PUT", lt, lp, last.c, "A+ SETUP FORMING — WAIT FOR RETEST");
        }
      }
    }

    // If not clearly strong/weak -> no signal (silence)
    return null;
  }

  private emitAndCooldown(
    symbol: string,
    marketDir: MarketDirection,
    rs: RelativeStrength,
    dir: Direction | "—",
    level: LevelType | "—",
    levelPrice: number | null,
    close: number,
    message: OutputMessage
  ): Alert {
    const alert = this.emit(symbol, marketDir, rs, dir, level, levelPrice, close, message);
    const ctx = this.ctx.get(symbol);
    if (ctx) {
      // cooldown for 2 completed 5m candles
      ctx.state = { state: "COOLDOWN", untilBarTime: Date.now() + 2 * this.cfg.timeframeMin * 60_000 };
    }
    return alert;
  }

  private emit(
    symbol: string,
    marketDir: MarketDirection,
    rs: RelativeStrength,
    dir: Direction | "—",
    level: LevelType | "—",
    levelPrice: number | null,
    close: number,
    message: OutputMessage
  ): Alert {
    return {
      id: crypto.randomBytes(12).toString("hex"),
      ts: Date.now(),
      symbol,
      market: marketDir,
      rs,
      dir,
      level,
      levelPrice,
      close,
      message
    };
  }
}