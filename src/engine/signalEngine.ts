import crypto from "crypto";
import { Bar5, MarketDirection } from "../market/marketDirection";
import { LevelType, Levels, getLevelPrice } from "../market/levels";
import { computeRS } from "./rs";
import { Alert, Direction, OutputMessage, RelativeStrength, SignalState } from "./types";

export type EngineConfig = {
  timeframeMin: number;
  retestTolerancePct: number;
  rsWindowBars5m: number;
};

export type SymbolContext = {
  levels: Levels;
  bars5: Bar5[];
  state: SignalState;

  lastMarket?: MarketDirection;
  lastRS?: RelativeStrength;

  tapState?: {
    key: string;
    canFire: boolean;
    tol: number;
  };
};

export type FormingCandidate = {
  symbol: string;
  dir: Direction;
  levelType: LevelType;
  levelPrice: number;
  lastPrice: number | null;
  distancePct: number | null;
  rs: RelativeStrength;
  market: MarketDirection;
  score: number;
};

export class SignalEngine {
  private cfg: EngineConfig;
  private ctx: Map<string, SymbolContext> = new Map();

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
  }

  getFormingCandidates(args: { lastPrice: (symbol: string) => number | null }): FormingCandidate[] {
    const out: FormingCandidate[] = [];
    for (const [symbol, ctx] of this.ctx.entries()) {
      if (ctx.state.state !== "BROKEN") continue;
      const s = ctx.state;
      const p = args.lastPrice(symbol);
      const distPct = p != null && s.levelPrice !== 0 ? Math.abs(p - s.levelPrice) / Math.abs(s.levelPrice) : null;
      const score = distPct == null ? 0 : Math.max(0, Math.min(100, 100 - distPct * 5000));
      out.push({
        symbol,
        dir: s.dir,
        levelType: s.levelType,
        levelPrice: s.levelPrice,
        lastPrice: p,
        distancePct: distPct != null ? Number((distPct * 100).toFixed(3)) : null,
        rs: ctx.lastRS ?? "NONE",
        market: ctx.lastMarket ?? "NEUTRAL",
        score: Number(score.toFixed(1))
      });
    }
    out.sort((a, b) => (b.score - a.score) || ((a.distancePct ?? 1e9) - (b.distancePct ?? 1e9)));
    return out;
  }

  ensureSymbol(symbol: string, levels: Levels) {
    if (!this.ctx.has(symbol)) {
      this.ctx.set(symbol, { levels, bars5: [], state: { state: "IDLE" } });
    } else {
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

    ctx.lastMarket = marketDir;

    if (marketDir === "NEUTRAL") {
      ctx.lastRS = "NONE";
      if (ctx.state.state === "BROKEN") {
        return this.emitAndCooldown(symbol, marketDir, "NONE", "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      return null;
    }

    const dir: Direction = marketDir === "BULLISH" ? "CALL" : "PUT";

    const rs: RelativeStrength = computeRS({
      marketDir,
      symBars5,
      spyBars5,
      windowBars: this.cfg.rsWindowBars5m
    });
    ctx.lastRS = rs;

    if (ctx.state.state === "COOLDOWN") {
      if (Date.now() > ctx.state.untilBarTime) ctx.state = { state: "IDLE" };
      else return null;
    }

    if (ctx.state.state === "BROKEN") {
      const s = ctx.state;

      if (s.dir !== dir) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      if (dir === "CALL" && rs !== "STRONG") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      if (dir === "PUT" && rs !== "WEAK") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      if (s.dir === "CALL" && last.c < s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }
      if (s.dir === "PUT" && last.c > s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN");
      }

      return null;
    }

    if (dir === "CALL") {
      const candidates: LevelType[] = ["PMH", "PDH"];
      for (const lt of candidates) {
        const lp = getLevelPrice(symLevels, lt);
        if (lp == null) continue;
        if (last.c > lp && rs === "STRONG") {
          ctx.state = { state: "BROKEN", dir: "CALL", levelType: lt, levelPrice: lp, breakBarTime: last.t };
          const tol = Math.abs(lp) * this.cfg.retestTolerancePct;
          ctx.tapState = { key: `${symbol}|CALL|${lt}|${lp}`, canFire: true, tol };
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
          const tol = Math.abs(lp) * this.cfg.retestTolerancePct;
          ctx.tapState = { key: `${symbol}|PUT|${lt}|${lp}`, canFire: true, tol };
          return this.emit(symbol, marketDir, rs, "PUT", lt, lp, last.c, "A+ SETUP FORMING — WAIT FOR RETEST");
        }
      }
    }

    return null;
  }

  onMinuteBar(args: {
    symbol: string;
    ts: number;
    high: number;
    low: number;
    close: number;
    marketDir: MarketDirection;
  }): Alert | null {
    const { symbol, ts, high, low, close, marketDir } = args;

    const ctx = this.ctx.get(symbol);
    if (!ctx) return null;

    if (ctx.state.state !== "BROKEN") return null;

    const s = ctx.state;

    if (ts <= s.breakBarTime) return null;
    if (marketDir === "NEUTRAL") return null;

    const expectedDir: Direction = marketDir === "BULLISH" ? "CALL" : "PUT";
    if (s.dir !== expectedDir) return null;

    const rs = ctx.lastRS ?? "NONE";
    if (s.dir === "CALL" && rs !== "STRONG") return null;
    if (s.dir === "PUT" && rs !== "WEAK") return null;

    if (!ctx.tapState || ctx.tapState.key !== `${symbol}|${s.dir}|${s.levelType}|${s.levelPrice}`) {
      const tol = Math.abs(s.levelPrice) * this.cfg.retestTolerancePct;
      ctx.tapState = { key: `${symbol}|${s.dir}|${s.levelType}|${s.levelPrice}`, canFire: true, tol };
    }

    const tol = ctx.tapState.tol;
    const touched = low <= s.levelPrice + tol && high >= s.levelPrice - tol;

    const disengageDist = tol * 2;

    if (!ctx.tapState.canFire) {
      if (s.dir === "CALL") {
        if (close > s.levelPrice + disengageDist) ctx.tapState.canFire = true;
      } else {
        if (close < s.levelPrice - disengageDist) ctx.tapState.canFire = true;
      }
      return null;
    }

    if (!touched) return null;

    ctx.tapState.canFire = false;

    return this.emit(symbol, marketDir, rs, s.dir, s.levelType, s.levelPrice, close, "A+ ENTRY (1m TAP)");
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
      ctx.state = { state: "COOLDOWN", untilBarTime: Date.now() + 2 * this.cfg.timeframeMin * 60_000 };
      ctx.tapState = undefined;
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
    const ctx = this.ctx.get(symbol);
    const broken = ctx?.state.state === "BROKEN" ? ctx.state : null;
    const structureLevel = broken ? broken.levelPrice : levelPrice;
    const breakBarTime = broken ? broken.breakBarTime : null;

    return {
      id: crypto.randomBytes(12).toString("hex"),
      ts: Date.now(),
      symbol,
      market: marketDir,
      rs,
      dir,
      level,
      levelPrice,
      structureLevel: structureLevel ?? null,
      breakBarTime,
      close,
      message
    };
  }
}