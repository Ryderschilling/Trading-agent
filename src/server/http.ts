import express from "express";
import path from "path";

export function createHttpApp(args: {
  publicDir: string;

  getAlerts: () => any[];
  getWatchlist: () => string[];
  addSymbol: (s: string) => void | Promise<void>;
  removeSymbol: (s: string) => void | Promise<void>;

  // existing additions
  getSignals?: () => any;
  getOutcomes?: () => any[];
  getOutcomeByAlertId?: (id: string) => any | null;
  getDbRows?: () => any[];

  // health + replay
  getStreamStats?: () => any;
  replay?: (symbols: string[], minutes: number, emitAlerts: boolean) => Promise<void>;

  // rules
  getRules?: () => any;
  listRulesets?: () => any[];
  saveRules?: (name: string, config: any, changedBy?: string) => any;
  activateRuleset?: (version: number) => any;

  // brokers
  getBrokers?: () => any[];
  getBrokerConfig?: () => any;
  saveBrokerConfig?: (cfg: any, changedBy?: string) => any;

  // helper for broker status fetches
  httpGetJson: (url: string, headers: Record<string, string>) => Promise<any>;
    // -----------------------------
  // Backtests (optional)
  // -----------------------------
  createBacktestRun?: (cfg: any) => { runId: string; reused?: boolean };
  getBacktestRun?: (id: string) => any | null;
  getBacktestTrades?: (id: string) => any[];
  getBacktestEquity?: (id: string) => any[];
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
  // This is the key fix: /brokers, /rules, etc must serve HTML files.
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

  // optional backward-compat for old direct links
  app.get("/outcomes.html", (_req, res) => res.redirect(301, "/outcomes"));
  app.get("/watchlist.html", (_req, res) => res.redirect(301, "/watch"));
  app.get("/rules.html", (_req, res) => res.redirect(301, "/rules"));
  app.get("/brokers.html", (_req, res) => res.redirect(301, "/brokers"));
  app.get("/backtest.html", (_req, res) => res.redirect(301, "/backtest"));
  // Serve static assets (css/js/images)
  app.use(express.static(args.publicDir));

  // -----------------------------
  // API: alerts
  // -----------------------------
  app.get("/api/alerts", (_req, res) => {
    res.json({ alerts: args.getAlerts() });
  });

  // -----------------------------
  // API: watchlist
  // -----------------------------
  app.get("/api/watchlist", (_req, res) => {
    res.json({ symbols: args.getWatchlist() });
  });

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
  app.get("/api/signals", (_req, res) => {
    res.json({ signals: args.getSignals ? args.getSignals() : null });
  });

  // -----------------------------
  // API: outcomes
  // -----------------------------
  app.get("/api/outcomes", (_req, res) => {
    res.json({ outcomes: args.getOutcomes ? args.getOutcomes() : [] });
  });

  app.get("/api/outcomes/:id", (req, res) => {
    const id = String(req.params.id || "");
    const o = args.getOutcomeByAlertId ? args.getOutcomeByAlertId(id) : null;
    res.json({ outcome: o });
  });

  app.get("/api/dbrows", (_req, res) => {
    res.json({ rows: args.getDbRows ? args.getDbRows() : [] });
  });

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
  // API: replay (off-hours testing)
  // -----------------------------
  app.post("/api/replay", async (req, res) => {
    try {
      if (!args.replay) {
        return res.status(400).json({ ok: false, error: "replay not enabled" });
      }

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
  // Brokers
  // -----------------------------
  app.get("/api/brokers", (_req, res) => {
    const brokers = args.getBrokers ? args.getBrokers() : [];
    res.json({ ok: true, brokers });
  });

  app.get("/api/broker-config", (_req, res) => {
    const brokerConfig = args.getBrokerConfig ? args.getBrokerConfig() : null;
    res.json({ ok: true, brokerConfig });
  });

  app.post("/api/broker-config", (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!args.saveBrokerConfig) return res.status(400).json({ ok: false, error: "broker config not enabled" });

      const cfg = req.body ?? null;
      const changedBy = String(req.body?.changedBy || "admin");
      const out = args.saveBrokerConfig(cfg, changedBy);

      res.json({ ok: true, result: out });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  // --- Broker dashboard/status (Alpaca first) ---
  app.get("/api/broker/status", async (_req, res) => {
    try {
      const cfg = args.getBrokerConfig ? args.getBrokerConfig() : null;
      if (!cfg || !cfg.brokerKey) {
        return res.json({ ok: false, error: "No broker configured." });
      }

      if (cfg.brokerKey !== "alpaca") {
        return res.json({
          ok: false,
          brokerKey: cfg.brokerKey,
          mode: cfg.mode,
          error: "Status only implemented for Alpaca right now."
        });
      }

      const key = String(cfg.config?.key || cfg.config?.apiKey || "");
      const secret = String(cfg.config?.secret || cfg.config?.apiSecret || "");
      if (!key || !secret) {
        return res.json({
          ok: false,
          brokerKey: cfg.brokerKey,
          mode: cfg.mode,
          error: "Missing Alpaca API key/secret in broker config."
        });
      }

      const mode = String(cfg.mode || "paper") === "live" ? "live" : "paper";
      const base = mode === "live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";

      async function alpacaGet(p: string) {
        const url = `${base}${p}`;
        return await args.httpGetJson(url, {
          "APCA-API-KEY-ID": key,
          "APCA-API-SECRET-KEY": secret
        });
      }

      const [account, positions, orders] = await Promise.all([
        alpacaGet("/v2/account"),
        alpacaGet("/v2/positions"),
        alpacaGet("/v2/orders?status=open&limit=200")
      ]);

      return res.json({
        ok: true,
        brokerKey: cfg.brokerKey,
        mode,
        tradingEnabled: Boolean((cfg as any).tradingEnabled),
        account,
        positions: Array.isArray(positions) ? positions : [],
        orders: Array.isArray(orders) ? orders : []
      });
    } catch (e: any) {
      return res.json({ ok: false, error: e?.message || "broker status error" });
    }
  });

  // --- Execution toggle (OFF by default) ---
  app.post("/api/broker/trading-enabled", async (req, res) => {
    try {
      const enabled = Boolean(req.body?.enabled);

      const cfg = (args.getBrokerConfig ? args.getBrokerConfig() : null) || {};
      const next = {
        brokerKey: cfg.brokerKey || "",
        mode: cfg.mode || "paper",
        config: cfg.config || {},
        tradingEnabled: enabled
      };

      if (!args.saveBrokerConfig) return res.status(400).json({ ok: false, error: "broker config not enabled" });
      args.saveBrokerConfig(next, "ui");
      return res.json({ ok: true, tradingEnabled: enabled });
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: e?.message || "toggle error" });
    }
  });
  
    // -----------------------------
  // Backtests
  // -----------------------------
  app.post("/api/backtests", (req, res) => {
    try {
      if (!args.createBacktestRun) return res.status(400).json({ ok: false, error: "backtests not enabled" });

      const tickers = Array.isArray(req.body?.tickers) ? req.body.tickers : [];
      const timeframe = String(req.body?.timeframe || "1m");
      const startDate = String(req.body?.startDate || "");
      const endDate = String(req.body?.endDate || "");

      const out = args.createBacktestRun({ tickers, timeframe, startDate, endDate });
      res.json({ ok: true, runId: out.runId, reused: Boolean(out.reused) });
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
  app.get("/api/rules", (_req, res) => {
    res.json({ ok: true, rules: args.getRules ? args.getRules() : null });
  });

  app.get("/api/rulesets", (_req, res) => {
    res.json({ ok: true, rulesets: args.listRulesets ? args.listRulesets() : [] });
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

  app.post("/api/rules/activate/:version", (req, res) => {
    try {
      if (!requireAdmin(req, res)) return;
      if (!args.activateRuleset) return res.status(400).json({ ok: false, error: "rules not enabled" });

      const v = Number(req.params.version);
      const out = args.activateRuleset(v);
      res.json({ ok: true, result: out });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || "failed" });
    }
  });

  return app;
}