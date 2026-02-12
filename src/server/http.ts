import express from "express";

function toCsv(rows: any[]): string {
  if (!rows.length) return "No data\n";
  const cols = Object.keys(rows[0]);
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    if (s.includes('"') || s.includes(",") || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

export function createHttpApp(args: {
  publicDir: string;

  // Data sources
  getAlerts: () => any[];
  getWatchlist: () => string[];
  getSignals: () => any;

  getOutcomes: () => any[];
  getOutcomeByAlertId: (id: string) => any | null;

  getDbRows: () => any[];

  // Watchlist mutation
  addSymbol: (s: string) => void;
  removeSymbol: (s: string) => void;
}) {
  const app = express();

  app.use(express.json());

  app.get("/api/alerts", (_req, res) => {
    res.json({ alerts: args.getAlerts() });
  });

  app.get("/api/signals", (_req, res) => {
    res.json({ signals: args.getSignals() });
  });

  app.get("/api/outcomes", (_req, res) => {
    res.json({ outcomes: args.getOutcomes() });
  });

  app.get("/api/outcomes/:alertId", (req, res) => {
    const id = String(req.params.alertId || "").trim();
    if (!id) return res.status(400).json({ ok: false, error: "Missing alertId" });
    const out = args.getOutcomeByAlertId(id);
    if (!out) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, outcome: out });
  });

  // Database view: joined alerts + outcomes
  app.get("/api/db", (_req, res) => {
    res.json({ rows: args.getDbRows() });
  });

  // Optional: CSV export
  app.get("/api/db.csv", (_req, res) => {
    const rows = args.getDbRows();
    const csv = toCsv(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="trading-agent-db.csv"');
    res.send(csv);
  });

  app.get("/api/watchlist", (_req, res) => {
    res.json({ symbols: args.getWatchlist() });
  });

  app.post("/api/watchlist/add", (req, res) => {
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "Missing symbol" });

    args.addSymbol(symbol);
    return res.json({ ok: true, symbols: args.getWatchlist() });
  });

  app.post("/api/watchlist/remove", (req, res) => {
    const symbol = String(req.body?.symbol || "").trim().toUpperCase();
    if (!symbol) return res.status(400).json({ ok: false, error: "Missing symbol" });

    args.removeSymbol(symbol);
    return res.json({ ok: true, symbols: args.getWatchlist() });
  });

  app.use(express.static(args.publicDir));
  return app;
}