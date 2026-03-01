import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

export type RuleConfig = {
  [key: string]: any; // allow UI to store additional fields safely
  timeframeMin: number;
  retestTolerancePct: number;
  structureWindow: number;
  rsWindowBars5m: number;

  // session control
  premarketEnabled: boolean;

  // bias gating thresholds (score = market + sector)
  longMinBiasScore: number; // e.g. +1
  shortMaxBiasScore: number; // e.g. -1

  // sector alignment
  sectorAlignmentEnabled: boolean;

  // admin
  updatedBy?: string;
};

export type ActiveRuleset = { version: number; config: RuleConfig };

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export function openDb() {
  const dataDir = path.resolve(process.cwd(), "data");
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, "trading-agent.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist (
      symbol TEXT PRIMARY KEY,
      sector_etf TEXT,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_alerts_symbol ON alerts(symbol);

    CREATE TABLE IF NOT EXISTS outcomes (
      alert_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      dir TEXT NOT NULL,
      structure_level REAL NOT NULL,
      entry_ts INTEGER NOT NULL,
      entry_ref_price REAL NOT NULL,
      status TEXT NOT NULL,
      end_ts INTEGER NOT NULL,
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
      returns_json TEXT,
      FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_outcomes_entry_ts ON outcomes(entry_ts DESC);

    CREATE TABLE IF NOT EXISTS rulesets (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      created_ts INTEGER NOT NULL,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_rulesets_active ON rulesets(active);

    CREATE TABLE IF NOT EXISTS rule_changes (
      ts INTEGER NOT NULL,
      ruleset_version INTEGER NOT NULL,
      changed_by TEXT,
      diff_json TEXT
    );

    -- Broker integration (single-tenant for now; multi-tenant later)
    CREATE TABLE IF NOT EXISTS broker_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      broker_key TEXT NOT NULL,
      mode TEXT NOT NULL, -- 'paper' | 'live'
      config_json TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    -- Canonical 1m candle store (rolling 365d retention enforced on ingest)
    CREATE TABLE IF NOT EXISTS candles_1m (
      ticker TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL,
      session TEXT NOT NULL, -- PREMARKET | RTH | AFTERHOURS
      PRIMARY KEY (ticker, ts)
    );

    CREATE INDEX IF NOT EXISTS idx_candles_1m_ts ON candles_1m(ts);
    CREATE INDEX IF NOT EXISTS idx_candles_1m_ticker_ts ON candles_1m(ticker, ts);

    -- Backtest run + results storage
    CREATE TABLE IF NOT EXISTS backtest_runs (
      id TEXT PRIMARY KEY,
      created_ts INTEGER NOT NULL,
      started_ts INTEGER,
      finished_ts INTEGER,
      status TEXT NOT NULL,
      config_json TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_backtest_runs_hash ON backtest_runs(config_hash);

    CREATE TABLE IF NOT EXISTS backtest_trades (
      run_id TEXT NOT NULL,
      trade_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT NOT NULL,
      dir TEXT NOT NULL,
      level_key TEXT NOT NULL,
      level_price REAL NOT NULL,
      entry_ts INTEGER NOT NULL,
      entry_price REAL NOT NULL,
      stop_price REAL NOT NULL,
      target_price REAL NOT NULL,
      exit_ts INTEGER NOT NULL,
      exit_price REAL NOT NULL,
      exit_reason TEXT NOT NULL,
      r_mult REAL NOT NULL,
      bars_held INTEGER NOT NULL,
      meta_json TEXT,
      FOREIGN KEY(run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(run_id, trade_id);
    CREATE INDEX IF NOT EXISTS idx_backtest_trades_entry ON backtest_trades(entry_ts);

    CREATE TABLE IF NOT EXISTS backtest_metrics (
      run_id TEXT PRIMARY KEY,
      metrics_json TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS backtest_equity (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      equity REAL NOT NULL,
      drawdown REAL NOT NULL,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY(run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_equity_run ON backtest_equity(run_id, seq);
  `);

  // seed default ruleset if none exist
  const cnt = db.prepare(`SELECT COUNT(*) as c FROM rulesets`).get() as any;
  if ((cnt?.c ?? 0) === 0) {
    const defaultCfg: RuleConfig = {
      timeframeMin: Number(process.env.TIMEFRAME_MINUTES || 5),
      retestTolerancePct: Number(process.env.RETEST_TOLERANCE_PCT || 0.001),
      structureWindow: Number(process.env.STRUCTURE_WINDOW || 3),
      rsWindowBars5m: Number(process.env.RS_WINDOW_BARS_5M || 3),

      premarketEnabled: true,

      longMinBiasScore: 1,
      shortMaxBiasScore: -1,

      sectorAlignmentEnabled: true
    };

    db.prepare(`INSERT INTO rulesets(created_ts,name,active,config_json) VALUES(?,?,1,?)`).run(Date.now(), "Default", JSON.stringify(defaultCfg));
  }
}

export function loadActiveRuleset(db: Database.Database): ActiveRuleset {
  const row = db.prepare(`SELECT version, config_json FROM rulesets WHERE active=1 ORDER BY version DESC LIMIT 1`).get() as any;

  const version = Number(row?.version ?? 1);
  const config = JSON.parse(String(row?.config_json ?? "{}"));
  return { version, config };
}

export function setActiveRuleset(db: Database.Database, version: number) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE rulesets SET active=0 WHERE active=1`).run();
    db.prepare(`UPDATE rulesets SET active=1 WHERE version=?`).run(version);
  });
  tx();
}

export function setRulesetActive(db: Database.Database, version: number, active: boolean) {
  db.prepare(`UPDATE rulesets SET active=? WHERE version=?`).run(active ? 1 : 0, Number(version));
}

// Hard delete a ruleset (used by UI "Delete" button).
// Note: backtests reference strategyVersion inside run.config JSON, so they remain intact.
export function deleteRuleset(db: Database.Database, version: number) {
  const v = Number(version);
  if (!Number.isFinite(v) || v <= 0) throw new Error("bad version");

  const row = db.prepare(`SELECT active FROM rulesets WHERE version=?`).get(v) as any;
  if (!row) return { ok: true, deleted: false };

  db.prepare(`DELETE FROM rulesets WHERE version=?`).run(v);

  // If we deleted the active one, promote newest remaining ruleset to active.
  if (Number(row.active) === 1) {
    const newest = db.prepare(`SELECT version FROM rulesets ORDER BY version DESC LIMIT 1`).get() as any;
    if (newest?.version != null) {
      db.prepare(`UPDATE rulesets SET active=0`).run();
      db.prepare(`UPDATE rulesets SET active=1 WHERE version=?`).run(Number(newest.version));
    }
  }

  return { ok: true, deleted: true, version: v };
}

export function insertRuleset(db: Database.Database, name: string, cfg: RuleConfig, changedBy?: string) {
  const tx = db.transaction(() => {
    // OPTION 2: Do NOT disable other enabled strategies.
    // "active" means "enabled".
    const info = db
      .prepare(`INSERT INTO rulesets(created_ts,name,active,config_json) VALUES(?,?,1,?)`)
      .run(Date.now(), name, JSON.stringify(cfg));

    const version = Number(info.lastInsertRowid);

    db.prepare(`INSERT INTO rule_changes(ts,ruleset_version,changed_by,diff_json) VALUES(?,?,?,?)`).run(
      Date.now(),
      version,
      changedBy || null,
      null
    );

    return version;
  });
  return tx();
}

export function updateRuleset(db: Database.Database, version: number, name: string, config: any, _changedBy?: string) {
  const v = Number(version);
  if (!Number.isFinite(v) || v < 1) throw new Error("bad version");
  if (!config || typeof config !== "object") throw new Error("config required");

  const nm = String(name || "").trim() || `v${v}`;

  const info = db
    .prepare(`UPDATE rulesets SET name=?, config_json=? WHERE version=?`)
    .run(nm, JSON.stringify(config), v);

  if (!info || info.changes !== 1) throw new Error("ruleset not found");
  return { ok: true, version: v };
}

/**
 * NEW: fetch a single ruleset by version (used by Rules modal "Overview")
 */
export function getRulesetByVersion(db: Database.Database, version: number) {
  const row = db
    .prepare(`SELECT version, name, active, config_json FROM rulesets WHERE version = ?`)
    .get(Number(version)) as any;

  if (!row) return null;

  return {
    version: Number(row.version),
    name: String(row.name),
    active: Boolean(row.active),
    config: JSON.parse(String(row.config_json || "{}"))
  };
}

export type BrokerMode = "paper" | "live";

export type BrokerConfig = {
  brokerKey: string;
  mode: BrokerMode;
  config: Record<string, any>;
  tradingEnabled?: boolean; // NEW
};

export function loadBrokerConfig(db: any): BrokerConfig | null {
  const row = db.prepare("SELECT broker_key, mode, config_json FROM broker_config WHERE id = 1").get() as any;

  if (!row) return null;

  let cfgAll: any = {};
  try {
    cfgAll = JSON.parse(String(row.config_json || "{}"));
  } catch {
    cfgAll = {};
  }

  const tradingEnabled = Boolean(cfgAll?.tradingEnabled);
  if (cfgAll && typeof cfgAll === "object") delete cfgAll.tradingEnabled;

  const mode = (String(row.mode || "paper") === "live" ? "live" : "paper") as BrokerMode;
  const brokerKey = String(row.broker_key || "alpaca");

  return { brokerKey, mode, config: cfgAll, tradingEnabled };
}

export function saveBrokerConfig(db: any, next: BrokerConfig) {
  const now = Date.now();
  const brokerKey = String(next.brokerKey || "alpaca");
  const mode = (next.mode === "live" ? "live" : "paper") as BrokerMode;

  const cfgAll = {
    ...(next.config ?? {}),
    tradingEnabled: Boolean(next.tradingEnabled)
  };

  const config_json = JSON.stringify(cfgAll);

  db.prepare(
    "INSERT INTO broker_config (id, broker_key, mode, config_json, updated_ts) VALUES (1, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET broker_key=excluded.broker_key, mode=excluded.mode, config_json=excluded.config_json, updated_ts=excluded.updated_ts"
  ).run(brokerKey, mode, config_json, now);

  return { ok: true, brokerKey, mode, tradingEnabled: Boolean(next.tradingEnabled), updatedTs: now };
}