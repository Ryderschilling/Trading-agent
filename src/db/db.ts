import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "trading-agent.sqlite");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    return rows.some((r) => String(r.name) === col);
  } catch {
    return false;
  }
}

function migrate(db: Database.Database) {
  // Core tables
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;

    CREATE TABLE IF NOT EXISTS rulesets (
      version     INTEGER PRIMARY KEY,
      created_ts  INTEGER NOT NULL,
      name        TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rule_changes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER NOT NULL,
      version    INTEGER NOT NULL,
      changed_by TEXT,
      action     TEXT,
      payload    TEXT
    );

    CREATE TABLE IF NOT EXISTS watchlist (
      symbol      TEXT PRIMARY KEY,
      sector_etf  TEXT,
      updated_ts  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id              TEXT PRIMARY KEY,
      ts              INTEGER NOT NULL,
      symbol          TEXT NOT NULL,
      message         TEXT,
      dir             TEXT,
      level           TEXT,
      level_price     REAL,
      structure_level REAL,
      close           REAL,
      market          TEXT,
      rs              TEXT,
      meta_json       TEXT
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      alert_id        TEXT PRIMARY KEY,
      symbol          TEXT NOT NULL,
      dir             TEXT NOT NULL,
      structure_level REAL NOT NULL,
      entry_ts        INTEGER NOT NULL,
      entry_ref_price REAL NOT NULL,
      status          TEXT NOT NULL,
      end_ts          INTEGER NOT NULL,

      -- broker-like execution (optional)
      exit_reason       TEXT,
      exit_fill         REAL,
      exit_return_pct   REAL,
      stop_moved_to_be  INTEGER NOT NULL DEFAULT 0,

      mfe_abs         REAL,
      mae_abs         REAL,
      mfe_pct         REAL,
      mae_pct         REAL,
      time_to_mfe_sec INTEGER,

      stopped_out     INTEGER NOT NULL DEFAULT 0,
      stop_ts         INTEGER,
      stop_close      REAL,
      stop_return_pct REAL,
      bars_to_stop    INTEGER,

      returns_json    TEXT
    );

    CREATE TABLE IF NOT EXISTS candles_1m (
      ticker  TEXT NOT NULL,
      ts      INTEGER NOT NULL,
      open    REAL NOT NULL,
      high    REAL NOT NULL,
      low     REAL NOT NULL,
      close   REAL NOT NULL,
      volume  REAL NOT NULL,
      session TEXT,
      PRIMARY KEY (ticker, ts)
    );

    CREATE TABLE IF NOT EXISTS broker_config (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      broker_key      TEXT,
      mode            TEXT,
      config_json     TEXT,
      trading_enabled INTEGER NOT NULL DEFAULT 0
    );

    INSERT OR IGNORE INTO broker_config(id, broker_key, mode, config_json, trading_enabled)
    VALUES (1, '', 'paper', '{}', 0);

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id            TEXT PRIMARY KEY,
      created_ts    INTEGER NOT NULL,
      updated_ts    INTEGER NOT NULL,
      status        TEXT NOT NULL,
      tickers_json  TEXT NOT NULL,
      timeframe     TEXT NOT NULL,
      start_date    TEXT NOT NULL,
      end_date      TEXT NOT NULL,
      strategy_ver  INTEGER,
      strategy_name TEXT
    );

    CREATE TABLE IF NOT EXISTS backtest_trades (
      run_id     TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      symbol     TEXT NOT NULL,
      dir        TEXT NOT NULL,
      entry      REAL,
      exit       REAL,
      pnl        REAL,
      meta_json  TEXT,
      PRIMARY KEY (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS backtest_equity (
      run_id   TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      ts       INTEGER NOT NULL,
      equity   REAL NOT NULL,
      drawdown REAL,
      PRIMARY KEY (run_id, seq)
    );

    CREATE TABLE IF NOT EXISTS backtest_metrics (
      run_id       TEXT PRIMARY KEY,
      metrics_json TEXT NOT NULL
    );
  `);

  // Safety: older DBs may have broker_config without trading_enabled
  if (!hasColumn(db, "broker_config", "trading_enabled")) {
    db.exec(`ALTER TABLE broker_config ADD COLUMN trading_enabled INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`UPDATE broker_config SET trading_enabled=0 WHERE trading_enabled IS NULL;`);
  }

  // Safety: older DBs may have outcomes without exec columns
  if (!hasColumn(db, "outcomes", "exit_reason")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_reason TEXT;`);
  if (!hasColumn(db, "outcomes", "exit_fill")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_fill REAL;`);
  if (!hasColumn(db, "outcomes", "exit_return_pct")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_return_pct REAL;`);
  if (!hasColumn(db, "outcomes", "stop_moved_to_be"))
    db.exec(`ALTER TABLE outcomes ADD COLUMN stop_moved_to_be INTEGER NOT NULL DEFAULT 0;`);
}

export function openDb() {
  ensureDataDir();
  const db = new Database(DB_PATH);
  migrate(db);
  return db;
}

// Minimal helpers used across app
export function loadActiveRuleset(db: Database.Database) {
  const row = db.prepare(`SELECT version, name, config_json FROM rulesets WHERE active=1 ORDER BY version DESC LIMIT 1`).get() as any;
  if (!row) return null;
  let cfg: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  return { version: Number(row.version), name: String(row.name || `v${row.version}`), config: cfg };
}

export function insertRuleset(db: Database.Database, name: string, config: any, changedBy?: string) {
  const created = Date.now();
  const verRow = db.prepare(`SELECT COALESCE(MAX(version),0)+1 AS v FROM rulesets`).get() as any;
  const version = Number(verRow?.v || 1);

  db.prepare(`INSERT INTO rulesets(version, created_ts, name, active, config_json) VALUES(?,?,?,?,?)`).run(
    version,
    created,
    String(name || `v${version}`),
    1,
    JSON.stringify(config ?? {})
  );

  if (changedBy) {
    db.prepare(`INSERT INTO rule_changes(ts, version, changed_by, action, payload) VALUES(?,?,?,?,?)`).run(
      created,
      version,
      changedBy,
      "create",
      JSON.stringify({ name, config })
    );
  }

  return { version };
}

export function setRulesetActive(db: Database.Database, version: number, active: boolean) {
  db.prepare(`UPDATE rulesets SET active=? WHERE version=?`).run(active ? 1 : 0, Number(version));
  return { ok: true };
}

export function getRulesetByVersion(db: Database.Database, version: number) {
  const row = db.prepare(`SELECT version, name, active, config_json FROM rulesets WHERE version=?`).get(Number(version)) as any;
  if (!row) return null;
  let cfg: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  return { version: Number(row.version), name: String(row.name || `v${row.version}`), active: Boolean(row.active), config: cfg };
}

export function deleteRuleset(db: Database.Database, version: number) {
  db.prepare(`DELETE FROM rulesets WHERE version=?`).run(Number(version));
  return { ok: true };
}

export function updateRuleset(db: Database.Database, version: number, name: string, config: any, changedBy?: string) {
  db.prepare(`UPDATE rulesets SET name=?, config_json=? WHERE version=?`).run(
    String(name || `v${version}`),
    JSON.stringify(config ?? {}),
    Number(version)
  );

  if (changedBy) {
    db.prepare(`INSERT INTO rule_changes(ts, version, changed_by, action, payload) VALUES(?,?,?,?,?)`).run(
      Date.now(),
      Number(version),
      changedBy,
      "update",
      JSON.stringify({ name, config })
    );
  }

  return { ok: true };
}

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

export function saveBrokerConfig(db: Database.Database, next: any) {
  const brokerKey = String(next?.brokerKey || "");
  const mode = String(next?.mode || "paper") === "live" ? "live" : "paper";
  const configJson = JSON.stringify(next?.config && typeof next.config === "object" ? next.config : {});
  const tradingEnabled = next?.tradingEnabled ? 1 : 0;

  db.prepare(`UPDATE broker_config SET broker_key=?, mode=?, config_json=?, trading_enabled=? WHERE id=1`).run(
    brokerKey,
    mode,
    configJson,
    tradingEnabled
  );

  return { ok: true };
}