import express from "express";
import path from "path";

console.log("[HTTP.TS] LOADED createHttpApp vRULESET");


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

  getStreamStats?: () => any;
  replay?: (symbols: string[], minutes: number, emitAlerts: boolean) => Promise<void>;

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

  httpGetJson: (url: string, headers: Record<string, string>) => Promise<any>;

  // backtests
  createBacktestRun?: (cfg: any) => { runId: string; reused?: boolean };
  getBacktestRun?: (id: string) => any | null;
  getBacktestTrades?: (id: string) => any[];
  getBacktestEquity?: (id: string) => any[];

  // NEW: list runs for strategy “View” modal
  listBacktestRuns?: (opts: { limit: number; strategyVersion?: number }) => any[];
}) {
  const app = express();
  app.use(express.json());

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
    return res.sendFile(path.join(args.publicDir, file));
  }

  app.get("/", (_req, res) => sendPage(res, "index.html"));
  app.get("/outcomes", (_req, res) => sendPage(res, "outcomes.html"));
  app.get("/watch", (_req, res) => sendPage(res, "watchlist.html"));
  app.get("/watchlist", (_req, res) => sendPage(res, "watchlist.html")); // backward compat
  app.get("/rules", (_req, res) => sendPage(res, "rules.html"));
  app.get("/brokers", (_req, res) => sendPage(res, "brokers.html"));
  app.get("/backtest", (_req, res) => sendPage(res, "backtest.html"));
  app.get("/__ping_backtest", (_req, res) => res.send("ok"));

  app.get("/outcomes.html", (_req, res) => res.redirect(301, "/outcomes"));
  app.get("/watchlist.html", (_req, res) => res.redirect(301, "/watch"));
  app.get("/rules.html", (_req, res) => res.redirect(301, "/rules"));
  app.get("/brokers.html", (_req, res) => res.redirect(301, "/brokers"));
  app.get("/backtest.html", (_req, res) => res.redirect(301, "/backtest"));

  app.use(express.static(args.publicDir));

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
  // API: signals snapshot
  // -----------------------------
  app.get("/api/signals", (_req, res) => res.json({ signals: args.getSignals ? args.getSignals() : null }));

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

  // -----------------------------
  // API: health
  // -----------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      now: Date.now(),
      iso: new Date().toISOString(),
      stream: args.getStreamStats ? args.getStreamStats() : null
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