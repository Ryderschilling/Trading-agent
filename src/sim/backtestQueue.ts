import crypto from "crypto";
import https from "https";
import type Database from "better-sqlite3";

import { runBacktest, BacktestConfig, Candle } from "./backtestEngine";

export type BacktestRunStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export function hashConfig(cfg: BacktestConfig): string {
  // IMPORTANT: keep hash independent of strategy tags (tags should not change candle coverage)
  const canon = {
    tickers: (cfg.tickers || [])
      .slice()
      .map((s) => String(s).toUpperCase())
      .sort(),
    timeframe: cfg.timeframe,
    startDate: cfg.startDate,
    endDate: cfg.endDate
  };
  return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

function genId() {
  return crypto.randomBytes(16).toString("hex");
}

function parseYmdNY(s: string): { y: number; m: number; d: number } | null {
  const m = /^\d{4}-\d{2}-\d{2}$/.exec(String(s));
  if (!m) return null;
  const [y, mo, d] = s.split("-").map((x) => Number(x));
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
  return { y, m: mo, d };
}

function nyMidnightToUtcMs(ymd: string): number {
  const parts = parseYmdNY(ymd);
  if (!parts) return Date.now();
  const approxUtc = Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0, 0);

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(approxUtc))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  const nyAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  const offsetMs = nyAsUtc - approxUtc;
  return approxUtc - offsetMs;
}

function candleSessionNY(ts: number): "PREMARKET" | "RTH" | "AFTERHOURS" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const hh = Number(get("hour") || "0");
  const mm = Number(get("minute") || "0");
  const mins = hh * 60 + mm;

  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PREMARKET";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "RTH";
  return "AFTERHOURS";
}

function httpGetJson(url: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function msToIso(ms: number) {
  return new Date(ms).toISOString();
}

function safeJson(s: any) {
  if (!s || typeof s !== "string") return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export class BacktestQueue {
    private q: Array<{ runId: string; config: any }> = [];
  private running = false;

  private upsertCandle1m: Database.Statement;
  private stmtCoverage: Database.Statement;
  private stmtSelectCandles: Database.Statement;

  constructor(private db: Database.Database) {
    this.upsertCandle1m = this.db.prepare(
      `INSERT INTO candles_1m (ticker, ts, open, high, low, close, volume, session)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker, ts) DO UPDATE SET
         open=excluded.open,
         high=excluded.high,
         low=excluded.low,
         close=excluded.close,
         volume=excluded.volume,
         session=excluded.session`
    );

    this.stmtCoverage = this.db.prepare(
      `SELECT MIN(ts) as minTs, MAX(ts) as maxTs, COUNT(*) as c
       FROM candles_1m
       WHERE ticker=? AND ts>=? AND ts<=?`
    );

    this.stmtSelectCandles = this.db.prepare(
      `SELECT ticker, ts, open, high, low, close, volume
       FROM candles_1m
       WHERE ticker=? AND ts>=? AND ts<=?
       ORDER BY ts ASC`
    );
  }

  createRun(config: any) {
    const cfg: any = {
      tickers: (config.tickers || [])
        .map((s: string) => String(s).toUpperCase())
        .filter(Boolean),
  
      timeframe: config.timeframe === "5m" ? "5m" : "1m",
      startDate: String(config.startDate || ""),
      endDate: String(config.endDate || ""),
  
      // Strategy tagging
      strategyVersion: Number.isFinite(Number(config.strategyVersion))
        ? Number(config.strategyVersion)
        : undefined,
  
      strategyName:
        config.strategyName != null
          ? String(config.strategyName)
          : undefined,
  
      // -----------------------------
      // NEW ENGINE FIELDS (CRITICAL)
      // -----------------------------
  
      levelSource:
        config.levelSource === "REPEAT" ||
        config.levelSource === "BOTH"
          ? config.levelSource
          : "DAILY",
  
      entryMode:
        config.entryMode === "BREAK" ||
        config.entryMode === "RETEST"
          ? config.entryMode
          : "BREAK_RETEST",
  
      repeatSr: {
        tolerancePct:
          Number.isFinite(Number(config?.repeatSr?.tolerancePct)) &&
          Number(config.repeatSr.tolerancePct) > 0
            ? Number(config.repeatSr.tolerancePct)
            : 0.05,
  
        touchCount:
          Number.isFinite(Number(config?.repeatSr?.touchCount)) &&
          Number(config.repeatSr.touchCount) >= 2
            ? Math.floor(Number(config.repeatSr.touchCount))
            : 3,
  
        lookbackBars:
          Number.isFinite(Number(config?.repeatSr?.lookbackBars)) &&
          Number(config.repeatSr.lookbackBars) >= 20
            ? Math.floor(Number(config.repeatSr.lookbackBars))
            : 150
      }
    };
  
    if (!cfg.tickers.length) throw new Error("tickers required");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.startDate)) throw new Error("bad startDate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cfg.endDate)) throw new Error("bad endDate");
  
    const runId = genId();
    const now = Date.now();
    const h = hashConfig(cfg);
  
    this.db
      .prepare(
        `INSERT INTO backtest_runs(id, created_ts, status, config_json, config_hash)
         VALUES(?,?,?,?,?)`
      )
      .run(runId, now, "QUEUED", JSON.stringify(cfg), h);
  
    this.enqueue(runId, cfg);
    return { runId, reused: false };
  }

  getRun(runId: string) {
    const row = this.db
      .prepare(`SELECT id, created_ts, started_ts, finished_ts, status, config_json, error FROM backtest_runs WHERE id=?`)
      .get(String(runId)) as any;
    if (!row) return null;

    let cfg: any = null;
    try {
      cfg = JSON.parse(String(row.config_json || "{}"));
    } catch {
      cfg = null;
    }

    const metricsRow = this.db
      .prepare(`SELECT metrics_json FROM backtest_metrics WHERE run_id=?`)
      .get(String(runId)) as any;

    let metrics: any = null;
    if (metricsRow?.metrics_json) {
      try {
        metrics = JSON.parse(String(metricsRow.metrics_json));
      } catch {
        metrics = null;
      }
    }

    return {
      id: String(row.id),
      createdTs: Number(row.created_ts || 0),
      startedTs: row.started_ts == null ? null : Number(row.started_ts),
      finishedTs: row.finished_ts == null ? null : Number(row.finished_ts),
      status: String(row.status || "QUEUED") as BacktestRunStatus,
      config: cfg,
      metrics,
      error: row.error ? String(row.error) : null
    };
  }

  // NEW: list recent runs (for Rules "View" modal)
  // This does NOT change existing backtest behavior.
  listRuns(opts: { limit: number; strategyVersion?: number }) {
    const limit = Math.min(50, Math.max(1, Number(opts.limit || 10)));
    const sv = opts.strategyVersion;

    const rows = this.db
      .prepare(
        `SELECT id, created_ts, started_ts, finished_ts, status, config_json, error
         FROM backtest_runs
         ORDER BY created_ts DESC
         LIMIT ?`
      )
      .all(limit) as any[];

    const out = rows.map((r) => {
      const cfg = safeJson(r.config_json) || null;

      const metricsRow = this.db
        .prepare(`SELECT metrics_json FROM backtest_metrics WHERE run_id=?`)
        .get(String(r.id)) as any;

      const metrics = metricsRow?.metrics_json ? safeJson(metricsRow.metrics_json) : null;

      return {
        id: String(r.id),
        createdTs: Number(r.created_ts || 0),
        startedTs: r.started_ts == null ? null : Number(r.started_ts),
        finishedTs: r.finished_ts == null ? null : Number(r.finished_ts),
        status: String(r.status || "QUEUED") as BacktestRunStatus,
        config: cfg,
        metrics,
        error: r.error ? String(r.error) : null
      };
    });

    if (Number.isFinite(Number(sv))) {
      const want = Number(sv);
      return out.filter((x) => Number(x?.config?.strategyVersion) === want);
    }

    return out;
  }

  listTrades(runId: string, limit = 5000) {
    const rows = this.db
      .prepare(
        `SELECT trade_id, ticker, dir, level_key, level_price, entry_ts, entry_price, stop_price, target_price, exit_ts, exit_price, exit_reason, r_mult, bars_held, meta_json
         FROM backtest_trades
         WHERE run_id=?
         ORDER BY trade_id ASC
         LIMIT ?`
      )
      .all(String(runId), Number(limit)) as any[];

    return rows.map((r) => {
      let meta: any = null;
      try {
        meta = r.meta_json ? JSON.parse(String(r.meta_json)) : null;
      } catch {
        meta = null;
      }
      return {
        tradeId: Number(r.trade_id),
        ticker: String(r.ticker),
        dir: String(r.dir),
        levelKey: String(r.level_key),
        levelPrice: Number(r.level_price),
        entryTs: Number(r.entry_ts),
        entryPrice: Number(r.entry_price),
        stopPrice: Number(r.stop_price),
        targetPrice: Number(r.target_price),
        exitTs: Number(r.exit_ts),
        exitPrice: Number(r.exit_price),
        exitReason: String(r.exit_reason),
        rMult: Number(r.r_mult),
        barsHeld: Number(r.bars_held),
        meta
      };
    });
  }

  getEquity(runId: string, limit = 100_000) {
    const rows = this.db
      .prepare(`SELECT seq, ts, equity, drawdown FROM backtest_equity WHERE run_id=? ORDER BY seq ASC LIMIT ?`)
      .all(String(runId), Number(limit)) as any[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: Number(r.ts),
      equity: Number(r.equity),
      drawdown: Number(r.drawdown)
    }));
  }

  private enqueue(runId: string, config: BacktestConfig) {
    this.q.push({ runId, config });
    this.pump();
  }

  private pump() {
    if (this.running) return;
    const job = this.q.shift();
    if (!job) return;

    this.running = true;
    setImmediate(() => {
      this.runJob(job)
        .catch(() => {})
        .finally(() => {
          this.running = false;
          this.pump();
        });
    });
  }

  private async ensureCandlesRange(ticker: string, startMs: number, endMs: number) {
    const row = this.stmtCoverage.get(String(ticker), startMs, endMs) as any;
    const c = Number(row?.c ?? 0);
    const minTs = row?.minTs == null ? null : Number(row.minTs);
    const maxTs = row?.maxTs == null ? null : Number(row.maxTs);

    const missing =
      c <= 0 ||
      minTs == null ||
      maxTs == null ||
      minTs > startMs + 60 * 60_000 ||
      maxTs < endMs - 60 * 60_000;

    if (!missing) return;

    const key = process.env.APCA_API_KEY_ID || "";
    const secret = process.env.APCA_API_SECRET_KEY || "";
    const feed = String(process.env.ALPACA_FEED || "iex");

    if (!key || !secret) {
      throw new Error("Missing APCA_API_KEY_ID / APCA_API_SECRET_KEY in .env (required to fetch historical candles).");
    }

    console.log(
      `[backtest] fetching ${ticker} 1m bars: ${msToIso(startMs)} → ${msToIso(endMs)} feed=${feed} (existing c=${c})`
    );

    let pageToken: string | null = null;
    let total = 0;

    for (;;) {
        const qs = new URLSearchParams({
            timeframe: "1Min",
            start: msToIso(startMs),
            end: msToIso(endMs),
            limit: "10000",
            feed,
            sort: "asc"
          });

      if (pageToken) qs.set("page_token", pageToken);

      const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars?${qs.toString()}`;

      const json = await httpGetJson(url, {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
      });

      const bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = json?.bars || [];
      for (const b of bars) {
        const ts = new Date(b.t).getTime();
        if (!Number.isFinite(ts)) continue;

        const sess = candleSessionNY(ts);
        this.upsertCandle1m.run(
          ticker,
          ts,
          Number(b.o),
          Number(b.h),
          Number(b.l),
          Number(b.c),
          Number(b.v || 0),
          sess
        );
      }

      total += bars.length;

      const next = json?.next_page_token ? String(json.next_page_token) : "";
      if (!next) break;
      pageToken = next;
    }

    const after = this.stmtCoverage.get(String(ticker), startMs, endMs) as any;
    console.log(
      `[backtest] fetched ${ticker} bars=${total}. coverage now c=${Number(after?.c ?? 0)} min=${after?.minTs} max=${after?.maxTs}`
    );
  }

  private async runJob(job: { runId: string; config: BacktestConfig }) {
    const { runId, config } = job;
    const started = Date.now();
    this.db.prepare(`UPDATE backtest_runs SET status='RUNNING', started_ts=? WHERE id=?`).run(started, runId);

    try {
      const candlesByTicker: Record<string, Candle[]> = {};
      const startMs = nyMidnightToUtcMs(config.startDate);
      const endMs = nyMidnightToUtcMs(config.endDate) + 24 * 60 * 60_000 - 1;

      for (const t of config.tickers) {
        await this.ensureCandlesRange(String(t), startMs, endMs);

        const rows = this.stmtSelectCandles.all(String(t), startMs, endMs) as any[];
        candlesByTicker[t] = rows.map((r) => ({
          ticker: String(r.ticker),
          ts: Number(r.ts),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume)
        }));
      }

      const result = runBacktest({ config, candlesByTicker });

      const tx = this.db.transaction(() => {
        this.db.prepare(`DELETE FROM backtest_trades WHERE run_id=?`).run(runId);
        this.db.prepare(`DELETE FROM backtest_metrics WHERE run_id=?`).run(runId);
        this.db.prepare(`DELETE FROM backtest_equity WHERE run_id=?`).run(runId);

        const insTrade = this.db.prepare(
          `INSERT INTO backtest_trades(
            run_id, ticker, dir, level_key, level_price,
            entry_ts, entry_price, stop_price, target_price,
            exit_ts, exit_price, exit_reason, r_mult, bars_held, meta_json
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        );

        for (const tr of result.trades) {
          insTrade.run(
            runId,
            tr.ticker,
            tr.dir,
            tr.levelKey,
            tr.levelPrice,
            tr.entryTs,
            tr.entryPrice,
            tr.stopPrice,
            tr.targetPrice,
            tr.exitTs,
            tr.exitPrice,
            tr.exitReason,
            tr.rMult,
            tr.barsHeld,
            tr.meta ? JSON.stringify(tr.meta) : null
          );
        }

        this.db.prepare(`INSERT INTO backtest_metrics(run_id, metrics_json) VALUES(?,?)`).run(
          runId,
          JSON.stringify({
            ...result.metrics,
            meta: result.meta
          })
        );

        const insEq = this.db.prepare(`INSERT INTO backtest_equity(run_id, seq, ts, equity, drawdown) VALUES(?,?,?,?,?)`);
        for (let i = 0; i < result.equity.length; i++) {
          const p = result.equity[i];
          insEq.run(runId, i, p.ts, p.equity, p.drawdown);
        }

        this.db
          .prepare(`UPDATE backtest_runs SET status='DONE', finished_ts=?, error=NULL WHERE id=?`)
          .run(Date.now(), runId);
      });

      tx();
    } catch (e: any) {
      const msg = String(e?.message || e || "backtest failed");
      this.db
        .prepare(`UPDATE backtest_runs SET status='FAILED', finished_ts=?, error=? WHERE id=?`)
        .run(Date.now(), msg, runId);
    }
  }
}