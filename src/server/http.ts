import express from "express";
import fs from "fs";
import path from "path";
import {
  requireAuth,
  getAuthMode,
  createAuthCookie,
  clearAuthCookie,
  isLoginLocked,
  recordLoginFailure,
  recordLoginSuccess,
} from "./auth";

console.log("[HTTP.TS] LOADED createHttpApp vRULESET");

// Computed once per server restart — used to cache-bust static assets
const BUILD_TS = Date.now().toString();

type AgentAsyncRequest = {
  message: string;
  dryRun?: boolean;
  mode?: "chat" | "strategy";
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};

type AgentJobRecord = {
  id: string;
  status: "running" | "done" | "error";
  request: AgentAsyncRequest;
  createdAt: number;
  updatedAt: number;
  result?: any;
  error?: string;
};

function createAgentJobId() {
  return `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}


export function createHttpApp(args: {
  publicDir: string;

  getAlerts: () => any[];
  getWatchlist: () => string[];
  addSymbol: (s: string) => void | Promise<void>;
  removeSymbol: (s: string) => void | Promise<void>;

  updateRuleset?: (version: number, name: string, config: any, changedBy?: string) => any;

  getSignals?: () => any;
  getOutcomes?: () => any[];
  getOutcomeByAlertId?: (id: string) => any | null;
  getDbRows?: () => any[];
  getAnalytics?: () => any;
  // From remote — used by /api/candles/:symbol route below. Optional so HEAD's
  // existing multi-strategy main file isn't forced to provide it immediately.
  getBars1?: (symbol: string) => any[];

  getStreamStats?: () => any;
  replay?: (symbols: string[], minutes: number, emitAlerts: boolean) => Promise<void>;

  runReplayBacktest?: (cfg: {
    tickers: string[];
    startDate: string; // YYYY-MM-DD
    endDate: string;   // YYYY-MM-DD
    strategyVersion: number;
    warmupMinutes?: number;

    // NEW
    baseEquity?: number;
    compounding?: boolean;
    positionPct?: number;
  }) => Promise<any>;

  getMarketState?: () => {
    isRth: boolean;
    barsFresh: boolean;
    dataLive: boolean;
    lastBarTs: number | null;
    lastBarAgeMs: number | null;
  };

  // rules
  getRules?: () => any;
  listRulesets?: () => any[];
  getRulesetByVersion?: (version: number) => any | null; // NEW
  saveRules?: (name: string, config: any, changedBy?: string) => any;

  // NEW: delete a ruleset
deleteRuleset?: (version: number, changedBy?: string) => any;

  // IMPORTANT: make this a TOGGLE (multi-active), not exclusive
  setRulesetActive?: (version: number, active: boolean) => any; // NEW

  // brokers
  getBrokers?: () => any[];
  getBrokerConfig?: () => any;
  saveBrokerConfig?: (cfg: any, changedBy?: string) => any;
  getBrokerStatus?: () => Promise<any>;
  getBrokerActivity?: (limit?: number) => any[];
  closeBrokerPosition?: (symbol: string) => Promise<void>;
  setBrokerStop?: (symbol: string, stopPrice: number, qty: number | null) => Promise<any>;

  // reconciler + coverage (Fix #1 / Fix #4)
  getGhostPositions?: () => any;
  reconcileNow?: () => Promise<any>;
  getDataCoverage?: () => any;

  httpGetJson: (url: string, headers: Record<string, string>) => Promise<any>;

    // candles (1m) for chart snapshots
    getCandles1m?: (
      symbol: string,
      startTs: number,
      endTs: number,
      limit: number
    ) => Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }>;

  // backtests
  createBacktestRun?: (cfg: any) => { runId: string; reused?: boolean };
  getBacktestRun?: (id: string) => any | null;
  getBacktestTrades?: (id: string) => any[];
  getBacktestEquity?: (id: string) => any[];

  // NEW: list runs for strategy “View” modal
  listBacktestRuns?: (opts: { limit: number; strategyVersion?: number }) => any[];
  getAiOperatorStatus?: () => any;
  runAiOperator?: (request: {
    message: string;
    dryRun?: boolean;
    mode?: "chat" | "strategy";
    history?: Array<{ role: "user" | "assistant"; text: string }>;
  }) => Promise<any>;
}) {
  const app = express();
  app.use(express.json());

  // -----------------------------
  // Auth gate (all routes except /api/login and /login)
  // -----------------------------
  app.use(requireAuth);

  // -----------------------------
  // GET /api/auth/mode — lets the login page render the right form
  // -----------------------------
  app.get("/api/auth/mode", (_req, res) => {
    res.json({ ok: true, mode: getAuthMode() });
  });

  // -----------------------------
  // POST /api/login
  //   userpass mode: { username, password } → sets persistent agent_auth cookie
  //   token mode (legacy AGENT_SECRET): { token } → sets agent_token cookie
  //   open mode: always ok
  // -----------------------------
  app.post("/api/login", (req, res) => {
    const mode = getAuthMode();

    if (mode === "open") return res.json({ ok: true });

    const lock = isLoginLocked(req);
    if (lock.locked) {
      res.setHeader("Retry-After", String(lock.retryAfterSec));
      return res
        .status(429)
        .json({ ok: false, error: `Too many attempts. Try again in ${lock.retryAfterSec}s.` });
    }

    if (mode === "userpass") {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const expectedUser = process.env.AUTH_USERNAME || "";
      const expectedPass = process.env.AUTH_PASSWORD || "";

      if (!username || !password || username !== expectedUser || password !== expectedPass) {
        recordLoginFailure(req);
        return res.status(401).json({ ok: false, error: "Invalid username or password" });
      }

      recordLoginSuccess(req);
      res.setHeader("Set-Cookie", createAuthCookie(username));
      return res.json({ ok: true });
    }

    // mode === "token" — legacy single-token
    const secret = process.env.AGENT_SECRET || "";
    const token = String(req.body?.token || "").trim();
    if (!token || token !== secret) {
      recordLoginFailure(req);
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }
    recordLoginSuccess(req);
    res.setHeader(
      "Set-Cookie",
      `agent_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`
    );
    return res.json({ ok: true });
  });

  // -----------------------------
  // POST /api/logout — clear auth cookie
  // -----------------------------
  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", [
      clearAuthCookie(),
      `agent_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    ]);
    res.json({ ok: true });
  });

  // -----------------------------
// Backtests (REPLAY = live engine path)
// -----------------------------
app.post("/api/backtests/replay", express.json(), async (req, res) =>{
  try {
    if (!args.runReplayBacktest) return res.status(400).json({ ok: false, error: "replay backtest not enabled" });

    const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
    const startDate = String(req.body?.startDate || "").trim();
    const endDate = String(req.body?.endDate || "").trim();
    const strategyVersion = Number(req.body?.strategyVersion);

    if (!startDate || !endDate) return res.status(400).json({ ok: false, error: "startDate/endDate required" });
    if (!Number.isFinite(strategyVersion) || strategyVersion <= 0)
      return res.status(400).json({ ok: false, error: "strategyVersion required" });

    const warmupMinutes = req.body?.warmupMinutes != null ? Number(req.body.warmupMinutes) : undefined;

    const baseEquity = req.body?.baseEquity != null ? Number(req.body.baseEquity) : undefined;
    const compounding = req.body?.compounding != null ? Boolean(req.body.compounding) : undefined;
    const positionPct = req.body?.positionPct != null ? Number(req.body.positionPct) : undefined;

    const out = await args.runReplayBacktest({
      tickers,
      startDate,
      endDate,
      strategyVersion,
      warmupMinutes,
      baseEquity,
      compounding,
      positionPct
    });

    res.json({ ok: true, result: out });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

  // -----------------------------
  // Admin auth (optional)
  // -----------------------------
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
  function requireAdmin(req: express.Request, res: express.Response) {
    if (!ADMIN_TOKEN) return true; // allow if not set (dev)
    const tok = String(req.header("x-admin-token") || "");
    if (tok !== ADMIN_TOKEN) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return false;
    }
    return true;
  }

  // -----------------------------
  // Page routes (CLEAN URLS)
  // -----------------------------
  function sendPage(res: express.Response, file: string) {
    const filePath = path.join(args.publicDir, file);
    try {
      const html = fs.readFileSync(filePath, "utf8").replace(/BUILD_TS/g, BUILD_TS);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    } catch {
      return res.sendFile(filePath);
    }
  }

  app.get("/login", (_req, res) => sendPage(res, "login.html"));
  app.get("/login.html", (_req, res) => res.redirect(301, "/login"));

  app.get("/", (_req, res) => sendPage(res, "index.html"));
  app.get("/outcomes", (_req, res) => sendPage(res, "outcomes.html"));
  app.get("/analytics", (_req, res) => sendPage(res, "analytics.html"));
  app.get("/watch", (_req, res) => sendPage(res, "watchlist.html"));
  app.get("/watchlist", (_req, res) => sendPage(res, "watchlist.html")); // backward compat
  app.get("/rules", (_req, res) => sendPage(res, "rules.html"));
  app.get("/brokers", (_req, res) => sendPage(res, "brokers.html"));
  app.get("/backtest", (_req, res) => sendPage(res, "backtest.html"));
  app.get("/__ping_backtest", (_req, res) => res.send("ok"));

  app.get("/outcomes.html", (_req, res) => res.redirect(301, "/outcomes"));
  app.get("/analytics.html", (_req, res) => res.redirect(301, "/analytics"));
  app.get("/watchlist.html", (_req, res) => res.redirect(301, "/watch"));
  app.get("/rules.html", (_req, res) => res.redirect(301, "/rules"));
  app.get("/brokers.html", (_req, res) => res.redirect(301, "/brokers"));
  app.get("/backtest.html", (_req, res) => res.redirect(301, "/backtest"));

  app.use(express.static(args.publicDir));

  const agentJobs = new Map<string, AgentJobRecord>();

  function pruneAgentJobs() {
    const now = Date.now();
    for (const [jobId, job] of agentJobs.entries()) {
      const ageMs = now - job.updatedAt;
      if (ageMs > 30 * 60_000) {
        agentJobs.delete(jobId);
      }
    }
  }

  function getAgentJobResponse(job: AgentJobRecord) {
    return {
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        error: job.error || null,
        result: job.result ?? null,
      },
    };
  }

  // -----------------------------
  // API: alerts
  // -----------------------------
  app.get("/api/alerts", (_req, res) => res.json({ alerts: args.getAlerts() }));

  // -----------------------------
  // API: watchlist
  // -----------------------------
  app.get("/api/watchlist", (_req, res) => res.json({ symbols: args.getWatchlist() }));

  app.post("/api/watchlist/add", async (req, res) => {
    try {
      const s = String(req.body?.symbol || "").trim();
      if (s) await Promise.resolve(args.addSymbol(s));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.post("/api/watchlist/remove", async (req, res) => {
    try {
      const s = String(req.body?.symbol || "").trim();
      if (s) await Promise.resolve(args.removeSymbol(s));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // -----------------------------
// API: brokers
// -----------------------------
app.get("/api/brokers", (_req, res) => {
  try {
    const brokers = args.getBrokers ? args.getBrokers() : [];
    res.json({ ok: true, brokers });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

app.get("/api/broker-config", (_req, res) => {
  try {
    const cfg = args.getBrokerConfig ? args.getBrokerConfig() : null;
    res.json({ ok: true, config: cfg, brokerConfig: cfg });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

app.post("/api/broker-config", express.json(), (req, res) => {
  try {
    if (!args.saveBrokerConfig) return res.status(400).json({ ok: false, error: "broker config not enabled" });
    const changedBy = String(req.header("x-changed-by") || req.body?.changedBy || "admin");
    const out = args.saveBrokerConfig(req.body, changedBy);
    res.json({ ok: true, result: out });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "failed" });
  }
});

app.get("/api/broker/status", async (_req, res) => {
  try {
    if (!args.getBrokerStatus) return res.status(400).json({ ok: false, error: "broker status not enabled" });
    const status = await args.getBrokerStatus();
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

app.post("/api/broker/close-position", async (req, res) => {
  try {
    if (!args.closeBrokerPosition) return res.status(400).json({ ok: false, error: "close position not enabled" });
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
    await args.closeBrokerPosition(symbol);
    res.json({ ok: true, symbol });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

app.post("/api/broker/set-stop", async (req, res) => {
  try {
    if (!args.setBrokerStop) return res.status(400).json({ ok: false, error: "set stop not enabled" });
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    const stopPrice = Number(req.body?.stopPrice);
    const qty = req.body?.qty != null ? Number(req.body.qty) : null;
    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) return res.status(400).json({ ok: false, error: "valid stopPrice required" });
    const result = await args.setBrokerStop(symbol, stopPrice, qty);
    res.json({ ok: true, symbol, stopPrice, result });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

app.get("/api/broker/activity", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
    const activity = args.getBrokerActivity ? args.getBrokerActivity(limit) : [];
    res.json({ ok: true, activity });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || "failed" });
  }
});

  // -----------------------------
  // API: signals snapshot
  // -----------------------------
  app.get("/api/signals", (_req, res) => res.json({ signals: args.getSignals ? args.getSignals() : null }));

  app.get("/api/agent/status", (_req, res) => {
    try {
      res.json({ ok: true, status: args.getAiOperatorStatus ? args.getAiOperatorStatus() : { configured: false } });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.post("/api/agent/run", async (req, res) => {
    try {
      if (!args.runAiOperator) return res.status(400).json({ ok: false, error: "ai operator not enabled" });
      const message = String(req.body?.message || "").trim();
      const dryRun = Boolean(req.body?.dryRun);
      const mode = req.body?.mode === "strategy" ? "strategy" : "chat";
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      if (!message) return res.status(400).json({ ok: false, error: "message required" });

      const out = await args.runAiOperator({ message, dryRun, mode, history });
      res.json(out);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.post("/api/agent/jobs", async (req, res) => {
    try {
      if (!args.runAiOperator) return res.status(400).json({ ok: false, error: "ai operator not enabled" });
      pruneAgentJobs();

      const message = String(req.body?.message || "").trim();
      const dryRun = Boolean(req.body?.dryRun);
      const mode = req.body?.mode === "strategy" ? "strategy" : "chat";
      const history = Array.isArray(req.body?.history) ? req.body.history : [];
      if (!message) return res.status(400).json({ ok: false, error: "message required" });

      const job: AgentJobRecord = {
        id: createAgentJobId(),
        status: "running",
        request: { message, dryRun, mode, history },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      agentJobs.set(job.id, job);

      void args
        .runAiOperator(job.request)
        .then((out) => {
          job.status = "done";
          job.result = out;
          job.updatedAt = Date.now();
        })
        .catch((e: any) => {
          job.status = "error";
          job.error = e?.message || "failed";
          job.updatedAt = Date.now();
        });

      res.json({ ok: true, jobId: job.id, status: job.status });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.get("/api/agent/jobs/:id", (req, res) => {
    pruneAgentJobs();
    const jobId = String(req.params.id || "").trim();
    const job = agentJobs.get(jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: "job not found" });
    }
    return res.json(getAgentJobResponse(job));
  });

  // -----------------------------
  // API: outcomes
  // -----------------------------
  app.get("/api/outcomes", (_req, res) => res.json({ outcomes: args.getOutcomes ? args.getOutcomes() : [] }));

  app.get("/api/outcomes/:id", (req, res) => {
    const id = String(req.params.id || "");
    const o = args.getOutcomeByAlertId ? args.getOutcomeByAlertId(id) : null;
    res.json({ outcome: o });
  });

  app.get("/api/dbrows", (_req, res) => res.json({ rows: args.getDbRows ? args.getDbRows() : [] }));

  // Strategy performance analytics — aggregated win rate, expectancy, R,
  // drawdown, equity curve, and breakdowns by exit reason / direction /
  // symbol / strategy.
  app.get("/api/analytics", (_req, res) => {
    if (!args.getAnalytics) return res.json({ ok: false, error: "analytics not enabled" });
    try {
      res.json({ ok: true, ...args.getAnalytics() });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "analytics failed" });
    }
  });

  // Ghost positions — broker holdings with no tracked OutcomeTracker session.
  // UI banners on Workspace + Outcomes poll this to surface zombie positions.
  app.get("/api/ghost-positions", (_req, res) => {
    if (!args.getGhostPositions) return res.json({ ok: true, checkedAt: 0, ghosts: [], flattened: [], errors: [] });
    res.json({ ok: true, ...args.getGhostPositions() });
  });

  // Trigger a reconcile run on demand (e.g. after a manual broker close).
  app.post("/api/ghost-positions/reconcile", async (_req, res) => {
    if (!args.reconcileNow) return res.status(404).json({ ok: false, error: "reconciler not enabled" });
    try {
      const result = await args.reconcileNow();
      res.json({ ok: true, result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "reconcile failed" });
    }
  });

  // Data coverage — per-symbol last bar timestamp + stale flag.
  app.get("/api/data-coverage", (_req, res) => {
    if (!args.getDataCoverage) return res.json({ ok: true, checkedAt: 0, watchlistCount: 0, staleCount: 0, staleSymbols: [], symbols: [] });
    res.json({ ok: true, ...args.getDataCoverage() });
  });

    // Candles (for Outcomes detail chart)
  // GET /api/candles?symbol=IWM&end=TIMESTAMP_MS&minutes=240
  app.get("/api/candles", (req, res) => {
    if (!args.getCandles1m) return res.status(404).json({ ok: false, error: "candles endpoint not enabled" });

    const symbol = String(req.query.symbol || "").trim().toUpperCase();
    const end = Number(req.query.end || Date.now());
    const minutes = Math.max(30, Math.min(2000, Number(req.query.minutes || 240)));

    if (!symbol) return res.status(400).json({ ok: false, error: "symbol required" });
    if (!Number.isFinite(end)) return res.status(400).json({ ok: false, error: "bad end" });

    const start = end - minutes * 60_000;
    const bars = args.getCandles1m(symbol, start, end, minutes + 50); // small buffer

    return res.json({ ok: true, symbol, start, end, bars });
  });

  // -----------------------------
  // API: health
  // -----------------------------
  app.get("/api/health", (_req, res) => {
    const now = Date.now();
    const stream = args.getStreamStats ? args.getStreamStats() : null;
    const market = args.getMarketState ? args.getMarketState() : null;
  
    res.json({
      ok: true,
      now,
      iso: new Date(now).toISOString(),
      stream,
      market,
      build: "health_fingerprint_v3_2026-03-15_2156"
    });
  });

  // -----------------------------
  // API: replay
  // -----------------------------
  app.post("/api/replay", async (req, res) => {
    try {
      if (!args.replay) return res.status(400).json({ ok: false, error: "replay not enabled" });

      const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
      const minutes = Number(req.body?.minutes || 240);
      const emitAlerts = Boolean(req.body?.emitAlerts || false);

      await args.replay(symbols, minutes, emitAlerts);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // -----------------------------
  // Backtests
  // -----------------------------
  app.post("/api/backtests", (req, res) => {
    try {
      if (!args.createBacktestRun) return res.status(400).json({ ok: false, error: "backtests not enabled" });

      const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
      // Client timeframe is ignored. BacktestQueue will derive timeframe from strategyVersion ruleset.
// If strategyVersion is missing, queue will fall back to normalized default.
const timeframe = "1m";
      const startDate = String(req.body?.startDate || "");
      const endDate = String(req.body?.endDate || "");

      const strategyVersion =
        Number.isFinite(Number(req.body?.strategyVersion)) ? Number(req.body.strategyVersion) : undefined;
      const strategyName = typeof req.body?.strategyName === "string" ? String(req.body.strategyName) : undefined;

      const out = args.createBacktestRun({
        tickers,
        timeframe,
        startDate,
        endDate,
        strategyVersion,
        strategyName
      });

      res.json({ ok: true, runId: out.runId, reused: Boolean(out.reused) });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // list recent runs (used by rules “View” modal)
  app.get("/api/backtests", (req, res) => {
    try {
      if (!args.listBacktestRuns) return res.status(400).json({ ok: false, error: "backtest listing not enabled" });

      const limit = Math.min(50, Math.max(1, Number(req.query.limit || 10)));
      const sv = req.query.strategyVersion == null ? undefined : Number(req.query.strategyVersion);
      const strategyVersion = Number.isFinite(sv as any) ? (sv as number) : undefined;

      const runs = args.listBacktestRuns({ limit, strategyVersion }) || [];
      res.json({ ok: true, runs });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.get("/api/backtests/:id", (req, res) => {
    try {
      if (!args.getBacktestRun) return res.status(400).json({ ok: false, error: "backtests not enabled" });

      const id = String(req.params.id || "");
      const run = args.getBacktestRun(id);
      if (!run) return res.status(404).json({ ok: false, error: "not found" });

      res.json(run);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.get("/api/backtests/:id/trades", (req, res) => {
    try {
      if (!args.getBacktestTrades) return res.status(400).json({ ok: false, error: "backtests not enabled" });

      const id = String(req.params.id || "");
      res.json(args.getBacktestTrades(id) || []);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  app.get("/api/backtests/:id/equity", (req, res) => {
    try {
      if (!args.getBacktestEquity) return res.status(400).json({ ok: false, error: "backtests not enabled" });

      const id = String(req.params.id || "");
      res.json(args.getBacktestEquity(id) || []);
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // -----------------------------
  // Rules
  // -----------------------------
  app.get("/api/rules", (_req, res) => res.json({ ok: true, rules: args.getRules ? args.getRules() : null }));

  app.get("/api/rulesets", (_req, res) =>
    res.json({ ok: true, rulesets: args.listRulesets ? args.listRulesets() : [] })
  );

  // NEW: fetch a single ruleset for “Load/Edit”
  app.get("/api/rulesets/:version", (req, res) => {
    console.log("[HTTP.TS] /api/rulesets hit, hasGetter=", Boolean(args.getRulesetByVersion));
    try {
      if (!args.getRulesetByVersion) return res.status(400).json({ ok: false, error: "ruleset fetch not enabled" });
      const v = Number(req.params.version);
      const rs = args.getRulesetByVersion(v);
      if (!rs) return res.status(404).json({ ok: false, error: "not found" });
      res.json({ ok: true, ruleset: rs });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // NEW: delete a ruleset (admin)
app.delete("/api/rulesets/:version", (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!args.deleteRuleset) return res.status(400).json({ ok: false, error: "ruleset delete not enabled" });

    const v = Number(req.params.version);
    const changedBy = String(req.header("x-changed-by") || req.body?.changedBy || "admin");
    const out = args.deleteRuleset(v, changedBy);
    res.json({ ok: true, result: out });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "failed" });
  }
});

  app.post("/api/rules", (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!args.saveRules) return res.status(400).json({ ok: false, error: "rules not enabled" });

      const name = String(req.body?.name || "Ruleset");
      const config = req.body?.config ?? null;
      const changedBy = String(req.body?.changedBy || "admin");

      const out = args.saveRules(name, config, changedBy);
      res.json({ ok: true, result: out });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // NEW: toggle active (multi-active)
  app.post("/api/rules/toggle/:version", (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!args.setRulesetActive) return res.status(400).json({ ok: false, error: "rules toggle not enabled" });

      const v = Number(req.params.version);
      const active = Boolean(req.body?.active);
      const out = args.setRulesetActive(v, active);
      res.json({ ok: true, result: out });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // Update ruleset (used by modal Done)
app.post("/api/rulesets/:version/update", (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    if (!args.updateRuleset) return res.status(400).json({ ok: false, error: "ruleset update not enabled" });

    const v = Number(req.params.version);
    const name = String(req.body?.name || "").trim();
    const config = req.body?.config ?? null;
    const changedBy = String(req.body?.changedBy || "admin");

    const out = args.updateRuleset(v, name, config, changedBy);
    res.json({ ok: true, result: out });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "failed" });
  }
});

  return app;
}
