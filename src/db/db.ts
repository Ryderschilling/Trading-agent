import path from "path";
import fs from "fs";
import Database from "better-sqlite3";

export type RuleConfig = {
  timeframeMin: number;
  retestTolerancePct: number;
  structureWindow: number;
  rsWindowBars5m: number;

  // session control
  premarketEnabled: boolean;

  // bias gating thresholds (score = market + sector)
  longMinBiasScore: number;  // e.g. +1
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

    db.prepare(
      `INSERT INTO rulesets(created_ts,name,active,config_json) VALUES(?,?,1,?)`
    ).run(Date.now(), "Default", JSON.stringify(defaultCfg));
  }
}

export function loadActiveRuleset(db: Database.Database): ActiveRuleset {
  const row = db
    .prepare(`SELECT version, config_json FROM rulesets WHERE active=1 ORDER BY version DESC LIMIT 1`)
    .get() as any;

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

export function insertRuleset(db: Database.Database, name: string, cfg: RuleConfig, changedBy?: string) {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE rulesets SET active=0 WHERE active=1`).run();
    const info = db
      .prepare(`INSERT INTO rulesets(created_ts,name,active,config_json) VALUES(?,?,1,?)`)
      .run(Date.now(), name, JSON.stringify(cfg));
    const version = Number(info.lastInsertRowid);

    db.prepare(`INSERT INTO rule_changes(ts,ruleset_version,changed_by,diff_json) VALUES(?,?,?,?)`)
      .run(Date.now(), version, changedBy || null, null);

    return version;
  });
  return tx();
}
export type BrokerMode = "paper" | "live";

export type BrokerConfig = {
  brokerKey: string;
  mode: BrokerMode;
  config: Record<string, any>;
  tradingEnabled?: boolean; // NEW
};

export function loadBrokerConfig(db: any): BrokerConfig | null {
  const row = db
    .prepare("SELECT broker_key, mode, config_json FROM broker_config WHERE id = 1")
    .get() as any;

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