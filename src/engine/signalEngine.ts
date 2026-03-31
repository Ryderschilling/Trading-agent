import crypto from "crypto";
import { Bar5, MarketDirection } from "../market/marketDirection";
import { LevelType, Levels, getLevelPrice } from "../market/levels";
import { computeRS } from "./rs";
import { Alert, Direction, OutputMessage, RelativeStrength, SignalState } from "./types";

export type EngineConfig = {
  timeframeMin: number;
  retestTolerancePct: number;
  rsWindowBars5m: number;

  /**
   * Optional EMA periods to compute on the engine's bar timeframe.
   * Allowed: integers 1..500
   * Example: [9, 20, 50, 200]
   */
  emaPeriods?: number[];
};

export type SymbolContext = {
  levels: Levels;
  bars5: Bar5[];
  state: SignalState;

  lastMarket?: MarketDirection;
  lastRS?: RelativeStrength;

  // EMA values keyed by period
  ema?: Record<number, number>;

  tapState?: {
    key: string;
    canFire: boolean;
    tol: number; // absolute price tolerance
  };
};

export type FormingCandidate = {
  symbol: string;
  dir: Direction;
  stage: "prebreak" | "retest";
  levelType: LevelType;
  levelPrice: number;
  lastPrice: number | null;
  distanceToTriggerPct: number | null;
  rs: RelativeStrength;
  market: MarketDirection;
  readinessScore: number;
  passedConditions: string[];
  missingConditions: string[];
  nextCatalyst: string;
};

function clampInt(n: any, lo: number, hi: number): number | null {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const i = Math.floor(x);
  if (i < lo || i > hi) return null;
  return i;
}

function uniqSorted(nums: number[]): number[] {
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

function sanitizeEmaPeriods(input: any): number[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((x) => clampInt(x, 1, 500))
    .filter((x): x is number => x != null);

  // cap to avoid heavy CPU
  const unique = uniqSorted(cleaned);
  return unique.slice(0, 50);
}

function emaAlpha(period: number) {
  return 2 / (period + 1);
}

export class SignalEngine {
  private cfg: EngineConfig;
  private ctx: Map<string, SymbolContext> = new Map();
  private emaPeriods: number[] = [];

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.emaPeriods = sanitizeEmaPeriods(cfg.emaPeriods);
  }

  getFormingCandidates(args: { lastPrice: (symbol: string) => number | null }): FormingCandidate[] {
    const out: FormingCandidate[] = [];
    for (const [symbol, ctx] of this.ctx.entries()) {
      const p = args.lastPrice(symbol);
      const retest = this.buildRetestCandidate(symbol, ctx, p);
      if (retest) out.push(retest);

      const prebreak = this.buildPrebreakCandidate(symbol, ctx, p);
      if (prebreak) out.push(prebreak);
    }

    out.sort(
      (a, b) =>
        (b.readinessScore - a.readinessScore) ||
        ((a.distanceToTriggerPct ?? 1e9) - (b.distanceToTriggerPct ?? 1e9))
    );
    return out;
  }

  private buildRetestCandidate(symbol: string, ctx: SymbolContext, lastPrice: number | null): FormingCandidate | null {
    if (ctx.state.state !== "BROKEN") return null;
    if (ctx.lastMarket === "NEUTRAL") return null;
    if (ctx.state.dir === "CALL" && ctx.lastRS !== "STRONG") return null;
    if (ctx.state.dir === "PUT" && ctx.lastRS !== "WEAK") return null;

    const distPct = lastPrice != null && ctx.state.levelPrice !== 0
      ? Math.abs(lastPrice - ctx.state.levelPrice) / Math.abs(ctx.state.levelPrice)
      : null;
    const proximityScore = distPct == null ? 0 : Math.max(0, Math.min(18, 18 - distPct * 1800));

    return {
      symbol,
      dir: ctx.state.dir,
      stage: "retest",
      levelType: ctx.state.levelType,
      levelPrice: ctx.state.levelPrice,
      lastPrice,
      distanceToTriggerPct: distPct != null ? Number((distPct * 100).toFixed(3)) : null,
      rs: ctx.lastRS ?? "NONE",
      market: ctx.lastMarket ?? "NEUTRAL",
      readinessScore: Number((82 + proximityScore).toFixed(1)),
      passedConditions: [
        `Market aligned ${ctx.lastMarket}`,
        `Relative strength ${ctx.lastRS ?? "NONE"}`,
        `${ctx.state.levelType} break confirmed`,
        "Setup waiting for retest entry",
      ],
      missingConditions: ["1m retest touch at structure"],
      nextCatalyst: `Retest ${ctx.state.levelType} ${ctx.state.levelPrice.toFixed(2)} and hold`,
    };
  }

  private buildPrebreakCandidate(symbol: string, ctx: SymbolContext, lastPrice: number | null): FormingCandidate | null {
    if (ctx.state.state !== "IDLE") return null;
    const last = ctx.bars5.at(-1);
    if (!last) return null;
    if (ctx.lastMarket === "NEUTRAL") return null;

    const dir: Direction = ctx.lastMarket === "BULLISH" ? "CALL" : "PUT";
    const rsNeeded: RelativeStrength = dir === "CALL" ? "STRONG" : "WEAK";
    if (ctx.lastRS !== rsNeeded) return null;

    const candidates: LevelType[] = dir === "CALL" ? ["PMH", "PDH"] : ["PML", "PDL"];
    const nearBreakPct = Math.max(this.cfg.retestTolerancePct * 4, 0.0035);

    let best: { levelType: LevelType; levelPrice: number; distPct: number } | null = null;
    for (const levelType of candidates) {
      const levelPrice = getLevelPrice(ctx.levels, levelType);
      if (levelPrice == null || !Number.isFinite(levelPrice) || levelPrice === 0) continue;

      const ref = lastPrice ?? last.c;
      if (!Number.isFinite(ref)) continue;

      if (dir === "CALL" && ref > levelPrice) continue;
      if (dir === "PUT" && ref < levelPrice) continue;

      const distPct = Math.abs(ref - levelPrice) / Math.abs(levelPrice);
      if (distPct > nearBreakPct) continue;

      if (!best || distPct < best.distPct) best = { levelType, levelPrice, distPct };
    }

    if (!best) return null;

    const readiness = Math.max(55, Math.min(84, 84 - best.distPct * 4000));
    const nextMove = dir === "CALL" ? "5m close through" : "5m close below";

    return {
      symbol,
      dir,
      stage: "prebreak",
      levelType: best.levelType,
      levelPrice: best.levelPrice,
      lastPrice,
      distanceToTriggerPct: Number((best.distPct * 100).toFixed(3)),
      rs: ctx.lastRS ?? "NONE",
      market: ctx.lastMarket ?? "NEUTRAL",
      readinessScore: Number(readiness.toFixed(1)),
      passedConditions: [
        `Market aligned ${ctx.lastMarket}`,
        `Relative strength ${ctx.lastRS ?? "NONE"}`,
        `${best.levelType} level defined`,
      ],
      missingConditions: [`${nextMove} ${best.levelType}`],
      nextCatalyst: `${nextMove} ${best.levelType} ${best.levelPrice.toFixed(2)}`,
    };
  }

  ensureSymbol(symbol: string, levels: Levels) {
    if (!this.ctx.has(symbol)) {
      this.ctx.set(symbol, { levels, bars5: [], state: { state: "IDLE" }, ema: {} });
    } else {
      const c = this.ctx.get(symbol)!;
      c.levels = levels;
      if (!c.ema) c.ema = {};
    }
  }

  pushBar5(symbol: string, bar: Bar5) {
    const c = this.ctx.get(symbol);
    if (!c) return;

    c.bars5.push(bar);
    if (c.bars5.length > 500) c.bars5.shift();

    // Update EMA snapshot incrementally
    if (this.emaPeriods.length) {
      if (!c.ema) c.ema = {};
      const close = Number(bar.c);
      if (Number.isFinite(close)) {
        for (const p of this.emaPeriods) {
          const prev = c.ema[p];
          if (!Number.isFinite(prev)) {
            c.ema[p] = close;
          } else {
            const a = emaAlpha(p);
            c.ema[p] = prev + a * (close - prev);
          }
        }
      }
    }
  }

  evaluateSymbol(args: {
    symbol: string;
    marketDir: MarketDirection;
    spyBars5: Bar5[];
    symBars5: Bar5[];
    symLevels: Levels;
    nowTs?: number; // pass bar-close ts from caller for replay determinism
  }): Alert | null {
    const { symbol, marketDir, spyBars5, symBars5, symLevels, nowTs } = args;

    const last = symBars5.at(-1);
    if (!last) return null;

    const ctx = this.ctx.get(symbol);
    if (!ctx) return null;

    ctx.lastMarket = marketDir;

    if (marketDir === "NEUTRAL") {
      ctx.lastRS = "NONE";
      if (ctx.state.state === "BROKEN") {
        return this.emitAndCooldown(symbol, marketDir, "NONE", "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
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
      // compare against bar timestamps, not wall-clock
      if (last.t > ctx.state.untilBarTime) ctx.state = { state: "IDLE" };
      else return null;
    }

    if (ctx.state.state === "BROKEN") {
      const s = ctx.state;

      if (s.dir !== dir) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
      }

      if (dir === "CALL" && rs !== "STRONG") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
      }
      if (dir === "PUT" && rs !== "WEAK") {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
      }

      if (s.dir === "CALL" && last.c < s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
      }
      if (s.dir === "PUT" && last.c > s.levelPrice) {
        return this.emitAndCooldown(symbol, marketDir, rs, "—", "—", null, last.c, "SETUP INVALID — STAND DOWN", nowTs ?? last.t);
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
          return this.emit(symbol, marketDir, rs, "CALL", lt, lp, last.c, "A+ SETUP FORMING — WAIT FOR RETEST", nowTs ?? last.t);
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
          return this.emit(symbol, marketDir, rs, "PUT", lt, lp, last.c, "A+ SETUP FORMING — WAIT FOR RETEST", nowTs ?? last.t);
        }
      }
    }

    return null;
  }

  /**
   * 1m “tap” entry. Caller supplies the current effective market direction.
   * This is what makes replay behave like live (entry can happen inside a timeframe bucket).
   */
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

    // must occur after break bar
    if (ts <= s.breakBarTime) return null;

    if (marketDir === "NEUTRAL") return null;

    const expectedDir: Direction = marketDir === "BULLISH" ? "CALL" : "PUT";
    if (s.dir !== expectedDir) return null;

    const rs = ctx.lastRS ?? "NONE";
    if (s.dir === "CALL" && rs !== "STRONG") return null;
    if (s.dir === "PUT" && rs !== "WEAK") return null;

    // ensure tap state
    const key = `${symbol}|${s.dir}|${s.levelType}|${s.levelPrice}`;
    if (!ctx.tapState || ctx.tapState.key !== key) {
      const tol = Math.abs(s.levelPrice) * this.cfg.retestTolerancePct;
      ctx.tapState = { key, canFire: true, tol };
    }

    const tol = ctx.tapState.tol;

    // touched if the 1m candle range overlaps the level +/- tol
    const touched = low <= s.levelPrice + tol && high >= s.levelPrice - tol;

    const disengageDist = tol * 2;

    if (!ctx.tapState.canFire) {
      // re-arm if we moved away enough
      if (s.dir === "CALL") {
        if (close > s.levelPrice + disengageDist) ctx.tapState.canFire = true;
      } else {
        if (close < s.levelPrice - disengageDist) ctx.tapState.canFire = true;
      }
      return null;
    }

    if (!touched) return null;

    // fire entry
    ctx.tapState.canFire = false;

    // IMPORTANT: cooldown must be bar-time-based (use ts), not Date.now()
    ctx.state = { state: "COOLDOWN", untilBarTime: ts + 2 * this.cfg.timeframeMin * 60_000 };
    ctx.tapState = undefined;

    return this.emit(symbol, marketDir, rs, s.dir, s.levelType, s.levelPrice, close, "A+ ENTRY (1m TAP)", ts);
  }

  private emitAndCooldown(
    symbol: string,
    marketDir: MarketDirection,
    rs: RelativeStrength,
    dir: Direction | "—",
    level: LevelType | "—",
    levelPrice: number | null,
    close: number,
    message: OutputMessage,
    nowTs?: number
  ): Alert {
    const alert = this.emit(symbol, marketDir, rs, dir, level, levelPrice, close, message, nowTs);

    const ctx = this.ctx.get(symbol);
    if (ctx) {
      const lastBarT = ctx.bars5.at(-1)?.t ?? (nowTs ?? Date.now());
      ctx.state = { state: "COOLDOWN", untilBarTime: lastBarT + 2 * this.cfg.timeframeMin * 60_000 };
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
    message: OutputMessage,
    nowTs?: number
  ): Alert {
    const ctx = this.ctx.get(symbol);
    const broken = ctx?.state.state === "BROKEN" ? ctx.state : null;
    const structureLevel = broken ? broken.levelPrice : levelPrice;
    const breakBarTime = broken ? broken.breakBarTime : null;

    const a: Alert = {
      id: crypto.randomBytes(12).toString("hex"),
      ts: nowTs ?? Date.now(),
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

    // Safe additive metadata: EMA snapshot for UI/debug
    if (ctx?.ema && Object.keys(ctx.ema).length) {
      (a as any).meta = { ...(a as any).meta, ema: ctx.ema };
    }

    return a;
  }
}
