// src/db/db.ts
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

// Ensure ./data exists and DB lives there
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "trading-agent.sqlite");

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function migrate(db: Database.Database) {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS watchlist (
      symbol TEXT PRIMARY KEY,
      sector_etf TEXT,
      updated_ts INTEGER
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      ts INTEGER,
      symbol TEXT,
      message TEXT,
      dir TEXT,
      level TEXT,
      level_price REAL,
      structure_level REAL,
      close REAL,
      market TEXT,
      rs TEXT,
      meta_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
    CREATE INDEX IF NOT EXISTS idx_alerts_symbol_ts ON alerts(symbol, ts);

    CREATE TABLE IF NOT EXISTS outcomes (
      alert_id TEXT PRIMARY KEY,
      symbol TEXT,
      dir TEXT,
      structure_level REAL,
      entry_ts INTEGER,
      entry_ref_price REAL,
      status TEXT,
      end_ts INTEGER,

      -- broker-like execution fields (optional)
      exit_reason TEXT,
      exit_fill REAL,
      exit_return_pct REAL,
      stop_moved_to_be INTEGER,

      mfe_abs REAL,
      mae_abs REAL,
      mfe_pct REAL,
      mae_pct REAL,
      time_to_mfe_sec INTEGER,

      stopped_out INTEGER,
      stop_ts INTEGER,
      stop_close REAL,
      stop_return_pct REAL,
      bars_to_stop INTEGER,

      returns_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_entry_ts ON outcomes(entry_ts);
    CREATE INDEX IF NOT EXISTS idx_outcomes_symbol_entry ON outcomes(symbol, entry_ts);

    CREATE TABLE IF NOT EXISTS candles_1m (
      ticker TEXT,
      ts INTEGER,
      open REAL,
      high REAL,
      low REAL,
      close REAL,
      volume REAL,
      session TEXT,
      PRIMARY KEY (ticker, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_candles_1m_ticker_ts ON candles_1m(ticker, ts);

    CREATE TABLE IF NOT EXISTS rulesets (
      version INTEGER PRIMARY KEY,
      created_ts INTEGER,
      name TEXT,
      active INTEGER DEFAULT 0,
      config_json TEXT
    );

    CREATE TABLE IF NOT EXISTS rule_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      version INTEGER,
      changed_by TEXT,
      action TEXT,
      payload_json TEXT
    );

    CREATE TABLE IF NOT EXISTS broker_config (
      id INTEGER PRIMARY KEY CHECK (id=1),
      broker_key TEXT,
      mode TEXT,
      config_json TEXT,
      trading_enabled INTEGER
    );
    INSERT OR IGNORE INTO broker_config(id, broker_key, mode, config_json, trading_enabled)
    VALUES(1, '', 'paper', '{}', 0);

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      created_ts INTEGER,
      started_ts INTEGER,
      finished_ts INTEGER,
      status TEXT,
      cfg_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_ts);

    CREATE TABLE IF NOT EXISTS backtest_trades (
      run_id TEXT,
      seq INTEGER,
      ts INTEGER,
      symbol TEXT,
      dir TEXT,
      entry REAL,
      exit REAL,
      ret_pct REAL,
      meta_json TEXT,
      PRIMARY KEY (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS backtest_equity (
      run_id TEXT,
      seq INTEGER,
      ts INTEGER,
      equity REAL,
      drawdown REAL,
      PRIMARY KEY (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS backtest_metrics (
      run_id TEXT PRIMARY KEY,
      metrics_json TEXT
    );
  `);
}

export function openDb() {
  ensureDir(DATA_DIR);
  const db = new Database(DB_PATH);
  migrate(db);
  return db;
}

// -------------------------
// Rulesets
// -------------------------
export function insertRuleset(db: Database.Database, name: string, config: any, changedBy?: string) {
  const now = Date.now();

  const row = db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM rulesets`).get() as any;
  const nextVersion = Number(row?.v || 0) + 1;

  db.prepare(
    `INSERT INTO rulesets(version, created_ts, name, active, config_json)
     VALUES(?, ?, ?, 1, ?)`
  ).run(nextVersion, now, name, JSON.stringify(config || {}));

  db.prepare(
    `INSERT INTO rule_changes(ts, version, changed_by, action, payload_json)
     VALUES(?,?,?,?,?)`
  ).run(now, nextVersion, changedBy || "admin", "INSERT", JSON.stringify({ name, config }));

  return { version: nextVersion };
}

export function updateRuleset(db: Database.Database, version: number, name: string, config: any, changedBy?: string) {
  const now = Date.now();
  db.prepare(`UPDATE rulesets SET name=?, config_json=? WHERE version=?`).run(name, JSON.stringify(config || {}), version);

  db.prepare(
    `INSERT INTO rule_changes(ts, version, changed_by, action, payload_json)
     VALUES(?,?,?,?,?)`
  ).run(now, version, changedBy || "admin", "UPDATE", JSON.stringify({ name, config }));

  return { ok: true };
}

export function deleteRuleset(db: Database.Database, version: number) {
  db.prepare(`DELETE FROM rulesets WHERE version=?`).run(version);
  return { ok: true };
}

export function setRulesetActive(db: Database.Database, version: number, active: boolean) {
  db.prepare(`UPDATE rulesets SET active=? WHERE version=?`).run(active ? 1 : 0, version);
  return { ok: true };
}

export function loadActiveRuleset(db: Database.Database) {
  const row = db
    .prepare(`SELECT version, name, config_json FROM rulesets WHERE active=1 ORDER BY version DESC LIMIT 1`)
    .get() as any;

  if (!row) return { version: 0, name: "DEFAULT", config: {} };

  let cfg: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  return { version: Number(row.version), name: String(row.name || `v${row.version}`), config: cfg };
}

export function getRulesetByVersion(db: Database.Database, version: number) {
  const row = db.prepare(`SELECT version, name, active, config_json FROM rulesets WHERE version=?`).get(version) as any;
  if (!row) return null;
  let cfg: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  return { version: Number(row.version), name: String(row.name || `v${row.version}`), active: Boolean(row.active), config: cfg };
}

// -------------------------
// Broker config
// -------------------------
export function loadBrokerConfig(db: Database.Database) {
  const row = db.prepare(`SELECT broker_key, mode, config_json, trading_enabled FROM broker_config WHERE id=1`).get() as any;
  if (!row) return { brokerKey: "", mode: "paper", config: {}, tradingEnabled: false };
  let cfg: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  return {
    brokerKey: String(row.broker_key || ""),
    mode: String(row.mode || "paper") === "live" ? "live" : "paper",
    config: cfg,
    tradingEnabled: Boolean(row.trading_enabled)
  };
}

export function saveBrokerConfig(db: Database.Database, next: { brokerKey: string; mode: string; config: any; tradingEnabled: boolean }) {
  db.prepare(
    `UPDATE broker_config
     SET broker_key=?, mode=?, config_json=?, trading_enabled=?
     WHERE id=1`
  ).run(
    next.brokerKey || "",
    next.mode === "live" ? "live" : "paper",
    JSON.stringify(next.config || {}),
    next.tradingEnabled ? 1 : 0
  );
  return { ok: true };
}