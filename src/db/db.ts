import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { normalizeBrokerConfig, normalizeExecutionPolicy } from "../broker/config";
import { BrokerActivityRow, BrokerConfig, BrokerOrderRecord } from "../broker/types";
import { normalizeRulesetConfig } from "../rules/executionPolicy";

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

function insertRuleChange(
  db: Database.Database,
  args: { ts: number; version: number; changedBy?: string; action: string; payload: string }
) {
  const cols: string[] = ["ts"];
  const values: any[] = [args.ts];

  if (hasColumn(db, "rule_changes", "ruleset_version")) {
    cols.push("ruleset_version");
    values.push(args.version);
  }
  if (hasColumn(db, "rule_changes", "version")) {
    cols.push("version");
    values.push(args.version);
  }
  if (hasColumn(db, "rule_changes", "changed_by")) {
    cols.push("changed_by");
    values.push(args.changedBy ?? null);
  }
  if (hasColumn(db, "rule_changes", "action")) {
    cols.push("action");
    values.push(args.action);
  }
  if (hasColumn(db, "rule_changes", "payload")) {
    cols.push("payload");
    values.push(args.payload);
  }
  if (hasColumn(db, "rule_changes", "diff_json")) {
    cols.push("diff_json");
    values.push(args.payload);
  }

  const placeholders = cols.map(() => "?").join(",");
  db.prepare(`INSERT INTO rule_changes(${cols.join(",")}) VALUES(${placeholders})`).run(...values);
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
      execution_json  TEXT,
      trading_enabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS broker_orders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      day_key           TEXT NOT NULL,
      alert_id          TEXT,
      symbol            TEXT NOT NULL,
      direction         TEXT NOT NULL,
      setup_key         TEXT NOT NULL,
      broker_key        TEXT NOT NULL,
      mode              TEXT NOT NULL,
      client_order_id   TEXT,
      broker_order_id   TEXT,
      status            TEXT NOT NULL,
      broker_status     TEXT,
      reason            TEXT,
      sizing_mode       TEXT NOT NULL,
      qty               REAL,
      notional          REAL,
      order_type        TEXT NOT NULL,
      time_in_force     TEXT NOT NULL,
      extended_hours    INTEGER NOT NULL DEFAULT 0,
      bracket_enabled   INTEGER NOT NULL DEFAULT 0,
      strategy_version  INTEGER,
      request_json      TEXT,
      response_json     TEXT
    );

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

  // Safety: older DBs may have a legacy rule_changes shape
  const hasLegacyRulesetVersion = hasColumn(db, "rule_changes", "ruleset_version");
  const hasLegacyDiffJson = hasColumn(db, "rule_changes", "diff_json");
  if (!hasColumn(db, "rule_changes", "version")) {
    db.exec(`ALTER TABLE rule_changes ADD COLUMN version INTEGER NOT NULL DEFAULT 0;`);
  }
  if (hasLegacyRulesetVersion) {
    db.exec(`
      UPDATE rule_changes
      SET version = COALESCE(NULLIF(version, 0), ruleset_version, 0)
      WHERE version IS NULL OR version = 0;
    `);
  }
  if (!hasColumn(db, "rule_changes", "action")) {
    db.exec(`ALTER TABLE rule_changes ADD COLUMN action TEXT;`);
  }
  db.exec(`UPDATE rule_changes SET action='legacy' WHERE action IS NULL OR TRIM(action)='';`);
  if (!hasColumn(db, "rule_changes", "payload")) {
    db.exec(`ALTER TABLE rule_changes ADD COLUMN payload TEXT;`);
  }
  if (hasLegacyDiffJson) {
    db.exec(`
      UPDATE rule_changes
      SET payload = diff_json
      WHERE payload IS NULL AND diff_json IS NOT NULL;
    `);
  }

  // Safety: older DBs may have broker_config without trading_enabled
  if (!hasColumn(db, "broker_config", "trading_enabled")) {
    db.exec(`ALTER TABLE broker_config ADD COLUMN trading_enabled INTEGER NOT NULL DEFAULT 0;`);
    db.exec(`UPDATE broker_config SET trading_enabled=0 WHERE trading_enabled IS NULL;`);
  }
  if (!hasColumn(db, "broker_config", "execution_json")) {
    db.exec(`ALTER TABLE broker_config ADD COLUMN execution_json TEXT;`);
    db.exec(`UPDATE broker_config SET execution_json='{}' WHERE execution_json IS NULL;`);
  }
  db.exec(`
    INSERT OR IGNORE INTO broker_config(id, broker_key, mode, config_json, execution_json, trading_enabled)
    VALUES (1, '', 'disabled', '{}', '{}', 0);
  `);

  // Safety: older DBs may have outcomes without exec columns
  if (!hasColumn(db, "outcomes", "exit_reason")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_reason TEXT;`);
  if (!hasColumn(db, "outcomes", "exit_fill")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_fill REAL;`);
  if (!hasColumn(db, "outcomes", "exit_return_pct")) db.exec(`ALTER TABLE outcomes ADD COLUMN exit_return_pct REAL;`);
  if (!hasColumn(db, "outcomes", "stop_moved_to_be"))
    db.exec(`ALTER TABLE outcomes ADD COLUMN stop_moved_to_be INTEGER NOT NULL DEFAULT 0;`);
}

export function migrateDb(db: Database.Database) {
  migrate(db);
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
  return {
    version: Number(row.version),
    name: String(row.name || `v${row.version}`),
    config: normalizeRulesetConfig(cfg, { name: String(row.name || `v${row.version}`) })
  };
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
    insertRuleChange(db, {
      ts: created,
      version,
      changedBy,
      action: "create",
      payload: JSON.stringify({ name, config })
    });
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
  return {
    version: Number(row.version),
    name: String(row.name || `v${row.version}`),
    active: Boolean(row.active),
    config: normalizeRulesetConfig(cfg, { name: String(row.name || `v${row.version}`) })
  };
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
    insertRuleChange(db, {
      ts: Date.now(),
      version: Number(version),
      changedBy,
      action: "update",
      payload: JSON.stringify({ name, config })
    });
  }

  return { ok: true };
}

export function loadBrokerConfig(db: Database.Database): BrokerConfig {
  const row = db.prepare(`SELECT broker_key, mode, config_json, execution_json, trading_enabled FROM broker_config WHERE id=1`).get() as any;
  if (!row) return normalizeBrokerConfig({ brokerKey: "", mode: "disabled", config: {}, execution: {}, tradingEnabled: false });
  let cfg: any = {};
  let execution: any = {};
  try { cfg = JSON.parse(String(row.config_json || "{}")); } catch { cfg = {}; }
  try { execution = JSON.parse(String(row.execution_json || "{}")); } catch { execution = {}; }
  return normalizeBrokerConfig({
    brokerKey: String(row.broker_key || ""),
    mode: String(row.mode || ""),
    config: cfg,
    execution,
    tradingEnabled: Boolean(row.trading_enabled)
  });
}

export function saveBrokerConfig(db: Database.Database, next: any) {
  const normalized = normalizeBrokerConfig(next);
  const brokerKey = String(normalized.brokerKey || "");
  const configJson = JSON.stringify(normalized.config || {});
  const executionJson = JSON.stringify(normalizeExecutionPolicy(normalized.execution));
  const tradingEnabled = normalized.tradingEnabled ? 1 : 0;

  db.prepare(`UPDATE broker_config SET broker_key=?, mode=?, config_json=?, execution_json=?, trading_enabled=? WHERE id=1`).run(
    brokerKey,
    normalized.mode,
    configJson,
    executionJson,
    tradingEnabled
  );

  return { ok: true };
}

export function insertBrokerOrder(db: Database.Database, row: BrokerOrderRecord) {
  db.prepare(
    `INSERT INTO broker_orders(
      ts, day_key, alert_id, symbol, direction, setup_key, broker_key, mode,
      client_order_id, broker_order_id, status, broker_status, reason,
      sizing_mode, qty, notional, order_type, time_in_force,
      extended_hours, bracket_enabled, strategy_version, request_json, response_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.ts,
    row.dayKey,
    row.alertId,
    row.symbol,
    row.direction,
    row.setupKey,
    row.brokerKey,
    row.mode,
    row.clientOrderId,
    row.brokerOrderId,
    row.status,
    row.brokerStatus,
    row.reason,
    row.sizingMode,
    row.qty,
    row.notional,
    row.orderType,
    row.timeInForce,
    row.extendedHours ? 1 : 0,
    row.bracketEnabled ? 1 : 0,
    row.strategyVersion,
    row.requestJson == null ? null : JSON.stringify(row.requestJson),
    row.responseJson == null ? null : JSON.stringify(row.responseJson)
  );
}

function parseJson(value: any) {
  try {
    return value == null ? null : JSON.parse(String(value));
  } catch {
    return null;
  }
}

export function listBrokerOrders(db: Database.Database, limit = 25): BrokerActivityRow[] {
  const rows = db
    .prepare(
      `SELECT
        id, ts, day_key, alert_id, symbol, direction, setup_key, broker_key, mode,
        client_order_id, broker_order_id, status, broker_status, reason, sizing_mode,
        qty, notional, order_type, time_in_force, extended_hours, bracket_enabled,
        strategy_version, request_json, response_json
       FROM broker_orders
       ORDER BY ts DESC, id DESC
       LIMIT ?`
    )
    .all(Math.max(1, Math.floor(limit))) as any[];

  return rows.map((row) => ({
    id: Number(row.id),
    ts: Number(row.ts),
    dayKey: String(row.day_key),
    alertId: row.alert_id == null ? null : String(row.alert_id),
    symbol: String(row.symbol),
    direction: String(row.direction) as BrokerOrderRecord["direction"],
    setupKey: String(row.setup_key),
    brokerKey: String(row.broker_key),
    mode: String(row.mode) as BrokerOrderRecord["mode"],
    clientOrderId: row.client_order_id == null ? null : String(row.client_order_id),
    brokerOrderId: row.broker_order_id == null ? null : String(row.broker_order_id),
    status: String(row.status) as BrokerOrderRecord["status"],
    brokerStatus: row.broker_status == null ? null : String(row.broker_status),
    reason: row.reason == null ? null : String(row.reason),
    sizingMode: String(row.sizing_mode) as BrokerOrderRecord["sizingMode"],
    qty: row.qty == null ? null : Number(row.qty),
    notional: row.notional == null ? null : Number(row.notional),
    orderType: String(row.order_type) as BrokerOrderRecord["orderType"],
    timeInForce: String(row.time_in_force) as BrokerOrderRecord["timeInForce"],
    extendedHours: Boolean(row.extended_hours),
    bracketEnabled: Boolean(row.bracket_enabled),
    strategyVersion: row.strategy_version == null ? null : Number(row.strategy_version),
    requestJson: parseJson(row.request_json),
    responseJson: parseJson(row.response_json),
  }));
}

export function findSubmittedBrokerOrderBySetup(db: Database.Database, dayKey: string, setupKey: string) {
  const row = db
    .prepare(
      `SELECT id
       FROM broker_orders
       WHERE day_key=? AND setup_key=? AND status='SUBMITTED'
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(dayKey, setupKey) as any;
  return row ? Number(row.id) : null;
}

export function countBrokerOrdersForSymbolDay(db: Database.Database, dayKey: string, symbol: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM broker_orders
       WHERE day_key=? AND symbol=? AND status='SUBMITTED'`
    )
    .get(dayKey, symbol) as any;
  return Number(row?.c || 0);
}

export function countBrokerOrdersForStrategySymbolDay(
  db: Database.Database,
  dayKey: string,
  symbol: string,
  strategyVersion: number
) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM broker_orders
       WHERE day_key=? AND symbol=? AND strategy_version=? AND status='SUBMITTED'`
    )
    .get(dayKey, symbol, strategyVersion) as any;
  return Number(row?.c || 0);
}

export function countBrokerOrdersForStrategyDay(db: Database.Database, dayKey: string, strategyVersion: number) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM broker_orders
       WHERE day_key=? AND strategy_version=? AND status='SUBMITTED'`
    )
    .get(dayKey, strategyVersion) as any;
  return Number(row?.c || 0);
}

export function sumSubmittedBrokerNotionalForDay(db: Database.Database, dayKey: string) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(notional), 0) AS total
       FROM broker_orders
       WHERE day_key=? AND status='SUBMITTED'`
    )
    .get(dayKey) as any;
  return Number(row?.total || 0);
}

export function sumSubmittedBrokerNotionalForStrategyDay(db: Database.Database, dayKey: string, strategyVersion: number) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(notional), 0) AS total
       FROM broker_orders
       WHERE day_key=? AND strategy_version=? AND status='SUBMITTED'`
    )
    .get(dayKey, strategyVersion) as any;
  return Number(row?.total || 0);
}

export function findLatestSuccessfulBrokerCheckTs(db: Database.Database): number | null {
  const row = db
    .prepare(
      `SELECT ts
       FROM broker_orders
       WHERE status='SUBMITTED'
       ORDER BY ts DESC, id DESC
       LIMIT 1`
    )
    .get() as any;
  return row?.ts == null ? null : Number(row.ts);
}
