import express from "express";
import path from "path";

export function createHttpApp(args: {
  publicDir: string;
  getAlerts: () => any[];
  getWatchlist: () => string[];
  addSymbol: (s: string) => void;
  removeSymbol: (s: string) => void;
}) {
  const app = express();
  app.use(express.json());

  // Serve UI
    // Serve UI (force correct MIME types for older Safari)
    app.get("/styles.css", (_req, res) => {
        res.type("text/css");
        res.sendFile(path.join(args.publicDir, "styles.css"));
      });
    
      app.get("/app.js", (_req, res) => {
        res.type("application/javascript");
        res.sendFile(path.join(args.publicDir, "app.js"));
      });
    
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
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false });
    args.addSymbol(symbol);
    res.json({ ok: true, symbols: args.getWatchlist() });
  });

  app.post("/api/watchlist/remove", (req, res) => {
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false });
    args.removeSymbol(symbol);
    res.json({ ok: true, symbols: args.getWatchlist() });
  });

  return app;
}
