import express from "express";

export function createHttpApp(args: {
  publicDir: string;
  getAlerts: () => any[];
  getWatchlist: () => string[];
  addSymbol: (s: string) => void;
  removeSymbol: (s: string) => void;

  // existing additions you've already made:
  getSignals?: () => any;
  getOutcomes?: () => any[];
  getOutcomeByAlertId?: (id: string) => any | null;
  getDbRows?: () => any[];

  // NEW: health + replay
  getStreamStats?: () => any;
  replay?: (symbols: string[], minutes: number, emitAlerts: boolean) => Promise<void>;
}) {
  const app = express();
  app.use(express.json());

  // Serve UI
  app.use(express.static(args.publicDir));

  // API: alerts
  app.get("/api/alerts", (_req, res) => {
    res.json({ alerts: args.getAlerts() });
  });

  // API: watchlist
  app.get("/api/watchlist", (_req, res) => {
    res.json({ symbols: args.getWatchlist() });
  });

  app.post("/api/watchlist/add", (req, res) => {
    const s = String(req.body?.symbol || "").trim();
    if (s) args.addSymbol(s);
    res.json({ ok: true });
  });

  app.post("/api/watchlist/remove", (req, res) => {
    const s = String(req.body?.symbol || "").trim();
    if (s) args.removeSymbol(s);
    res.json({ ok: true });
  });

  // API: signals snapshot
  app.get("/api/signals", (_req, res) => {
    res.json({ signals: args.getSignals ? args.getSignals() : null });
  });

  // API: outcomes
  app.get("/api/outcomes", (_req, res) => {
    res.json({ outcomes: args.getOutcomes ? args.getOutcomes() : [] });
  });

  app.get("/api/outcomes/:id", (req, res) => {
    const id = String(req.params.id || "");
    const o = args.getOutcomeByAlertId ? args.getOutcomeByAlertId(id) : null;
    res.json({ outcome: o });
  });

  // API: outcomes DB rows
  app.get("/api/dbrows", (_req, res) => {
    res.json({ rows: args.getDbRows ? args.getDbRows() : [] });
  });

  // NEW: health
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      now: Date.now(),
      iso: new Date().toISOString(),
      stream: args.getStreamStats ? args.getStreamStats() : null
    });
  });

  // NEW: replay (for off-hours testing)
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
    } catch (e) {
      res.status(500).json({ ok: false });
    }
  });

  return app;
}