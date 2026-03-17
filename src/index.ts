import "dotenv/config";
import http from "http";
import https from "https";
import path from "path";
import { BacktestQueue } from "./sim/backtestQueue";

import {
  openDb,
  loadActiveRuleset,
  insertRuleset,
  setRulesetActive,
  loadBrokerConfig,
  saveBrokerConfig,
  getRulesetByVersion,
  deleteRuleset,
  updateRuleset
} from "./db/db";

import { resolveSectorEtf } from "./market/sectorResolver";
import { AlpacaStream, AlpacaBarMsg } from "./data/alpaca";
import { initLevels, onBarUpdateLevels } from "./market/levels";
import { Bar5, MarketDirection } from "./market/marketDirection";
import { nyDayKey } from "./market/time";
import { computeRS } from "./engine/rs";
import { SignalEngine } from "./engine/signalEngine";
import { Alert, TradeDirection, TradeOutcome } from "./engine/types";
import { OutcomeTracker } from "./engine/outcomeTracker";
import { createHttpApp } from "./server/http";
import { attachRealtime } from "./server/realtime";

const PORT = Number(process.env.PORT || 3000);

// -----------------------------
// Approved broker catalog (UI + validation only for now)
// -----------------------------
type BrokerAuthType = "api_key" | "oauth" | "gateway";

type BrokerField = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  type?: "text" | "number" | "password";
};

type BrokerDescriptor = {
  key: string;
  name: string;
  markets: Array<"stocks" | "options" | "crypto">;
  authType: BrokerAuthType;
  fields: BrokerField[];
  notes?: string;
};

const BROKERS: BrokerDescriptor[] = [
  {
    key: "ibkr",
    name: "Interactive Brokers (IBKR)",
    markets: ["stocks", "options"],
    authType: "gateway",
    fields: [
      { key: "host", label: "Host", placeholder: "127.0.0.1" },
      { key: "port", label: "Port", placeholder: "7497 (paper) / 7496 (live)", type: "number" },
      { key: "clientId", label: "Client ID", placeholder: "1", type: "number" },
      { key: "accountId", label: "Account ID", placeholder: "DU1234567" }
    ],
    notes: "Requires IB Gateway or TWS running with API enabled."
  },
  {
    key: "alpaca",
    name: "Alpaca",
    markets: ["stocks", "options", "crypto"],
    authType: "api_key",
    fields: [
      { key: "key", label: "API Key", placeholder: "APCA-...", secret: true, type: "password" },
      { key: "secret", label: "API Secret", placeholder: "********", secret: true, type: "password" }
    ]
  },
  {
    key: "tradier",
    name: "Tradier",
    markets: ["stocks", "options"],
    authType: "oauth",
    fields: [
      { key: "token", label: "Access Token", placeholder: "Bearer token", secret: true, type: "password" },
      { key: "accountId", label: "Account ID", placeholder: "12345678" },
      { key: "sandbox", label: "Sandbox (true/false)", placeholder: "true" }
    ]
  },
  {
    key: "kraken",
    name: "Kraken",
    markets: ["crypto"],
    authType: "api_key",
    fields: [
      { key: "key", label: "API Key", placeholder: "KRAKEN-...", secret: true, type: "password" },
      { key: "secret", label: "API Secret", placeholder: "********", secret: true, type: "password" }
    ]
  },
  {
    key: "coinbase",
    name: "Coinbase Advanced Trade",
    markets: ["crypto"],
    authType: "api_key",
    fields: [
      { key: "apiKey", label: "API Key", placeholder: "organizations/.../apiKeys/...", secret: true, type: "password" },
      { key: "apiSecret", label: "API Secret", placeholder: "-----BEGIN PRIVATE KEY-----", secret: true, type: "password" },
      { key: "apiPassphrase", label: "Passphrase", placeholder: "Passphrase", secret: true, type: "password" }
    ]
  }
];

const FEED = (process.env.ALPACA_FEED || "iex") as "iex" | "sip" | "delayed_sip";

const DEFAULT_TIMEFRAME_MIN = Number(process.env.TIMEFRAME_MINUTES || 5);
const RETEST_TOL = Number(process.env.RETEST_TOLERANCE_PCT || 0.001);
const STRUCTURE_WINDOW = Number(process.env.STRUCTURE_WINDOW || 3);
const RS_WINDOW_BARS = Number(process.env.RS_WINDOW_BARS_5M || 3);
const TRACK_WINDOW_MIN = Number(process.env.TRACK_WINDOW_MINUTES || 60);

const KEY = process.env.APCA_API_KEY_ID || "";
const SECRET = process.env.APCA_API_SECRET_KEY || "";
const HAS_KEYS = Boolean(KEY && SECRET);

console.log("[ENV CHECK]", {
  key: process.env.APCA_API_KEY_ID ? "loaded" : "missing",
  secretLen: (process.env.APCA_API_SECRET_KEY || "").length,
  feed: process.env.ALPACA_FEED
});

// -----------------------------
// DB + Rules
// -----------------------------
const db = openDb();

try {
  const cutoff = Date.now() - (14 * 24 * 60 * 60_000); // 14 days
  db.prepare(`
    DELETE FROM alerts
    WHERE ts < ?
      AND id NOT IN (SELECT alert_id FROM outcomes)
  `).run(cutoff);
} catch {}

// NOTE: loadActiveRuleset() returns the highest version with active=1 (per your db.ts query).
// With multi-enabled strategies, "activeRules" is "the latest enabled ruleset" and is used for:
// - /api/rules (editor default)
// - fallback UI naming
let activeRules = loadActiveRuleset(db);

const backtestQueue = new BacktestQueue(db);

// ------------------------------------------------------------------
// Ruleset name cache
// ------------------------------------------------------------------
let rulesetNameMap: Record<number, string> = {};
let rulesetMetaMap: Record<number, { timeframeMin: number; emaPeriods: number[]; showVwap: boolean }> = {};

function loadRulesetNames() {
  rulesetNameMap = {};
  rulesetMetaMap = {};

  try {
    const rows = db.prepare(`SELECT version, name, config_json FROM rulesets`).all() as any[];
    for (const r of rows) {
      const v = Number(r?.version ?? 0);
      if (!(v > 0)) continue;

      rulesetNameMap[v] = String(r?.name ?? "");

      let cfg: any = {};
      try {
        cfg = JSON.parse(String(r?.config_json || "{}"));
      } catch {
        cfg = {};
      }

      const tf = Number(cfg?.timeframeMin);
      const timeframeMin = Number.isFinite(tf) && tf >= 1 ? Math.floor(tf) : 1;

      const emaPeriods = Array.isArray(cfg?.emaPeriods)
        ? cfg.emaPeriods.map((x: any) => Number(x)).filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 500)
        : [];

      const showVwap = Boolean(cfg?.indicators?.vwap);

      rulesetMetaMap[v] = { timeframeMin, emaPeriods, showVwap };
    }
  } catch {
    rulesetNameMap = {};
    rulesetMetaMap = {};
  }
}
loadRulesetNames();

function getRules() {
  return activeRules;
}

function listRulesets() {
  return db.prepare(`SELECT version, created_ts, name, active FROM rulesets ORDER BY version DESC LIMIT 50`).all();
}

// -----------------------------
// OPTION 2: Multi-enabled strategies (per-strategy live runner)
// Shared: levelsMap + VWAP + lastPrice
// Per strategy: engine + aggregation + bar history + outcome tracker
// -----------------------------
type Agg = { bucketStart: number; o: number; h: number; l: number; c: number; lastMinTs: number };

type StrategyRunner = {
  version: number;
  name: string;
  cfg: any; // ruleset config JSON
  timeframeMin: number;

  engine: SignalEngine;
  outcomeTracker: OutcomeTracker;

  aggMap: Map<string, Agg>;
  barsMap: Map<string, Bar5[]>;
};

const runners = new Map<number, StrategyRunner>();

function getBars(r: StrategyRunner, symbol: string) {
  if (!r.barsMap.has(symbol)) r.barsMap.set(symbol, []);
  return r.barsMap.get(symbol)!;
}

function pushBar(r: StrategyRunner, symbol: string, bar: Bar5) {
  const arr = getBars(r, symbol);
  arr.push(bar);
  if (arr.length > 800) arr.shift();
  r.engine.ensureSymbol(symbol, getLevels(symbol));
  r.engine.pushBar5(symbol, bar);
}

function floorBucket(ms: number, minutes: number): number {
  const size = Math.max(1, Math.floor(minutes)) * 60_000;
  return Math.floor(ms / size) * size;
}

function listEnabledRulesets(): Array<{ version: number; name: string; active: boolean; config: any }> {
  const rows = db
    .prepare(`SELECT version, name, active, config_json FROM rulesets WHERE active=1 ORDER BY version DESC`)
    .all() as any[];

  return rows
    .map((r) => {
      let cfg: any = {};
      try {
        cfg = JSON.parse(String(r.config_json || "{}"));
      } catch {
        cfg = {};
      }
      return {
        version: Number(r.version),
        name: String(r.name || `v${r.version}`),
        active: Boolean(r.active),
        config: cfg
      };
    })
    .filter((x) => Number.isFinite(x.version) && x.version > 0);
}

function buildRunner(rs: { version: number; name: string; config: any }): StrategyRunner {
  const tfMinRaw = Number(rs.config?.timeframeMin ?? DEFAULT_TIMEFRAME_MIN);
  const timeframeMin = Number.isFinite(tfMinRaw) && tfMinRaw >= 1 ? Math.floor(tfMinRaw) : DEFAULT_TIMEFRAME_MIN;

  const retestTolRaw = Number(rs.config?.retestTolerancePct ?? RETEST_TOL);
  const rsWinRaw = Number(rs.config?.rsWindowBars5m ?? RS_WINDOW_BARS);

  const retestTolerancePct = Number.isFinite(retestTolRaw) && retestTolRaw >= 0 ? retestTolRaw : RETEST_TOL;
  const rsWindowBars5m = Number.isFinite(rsWinRaw) && rsWinRaw >= 1 ? Math.floor(rsWinRaw) : RS_WINDOW_BARS;

  return {
    version: rs.version,
    name: rs.name,
    cfg: rs.config,
    timeframeMin,

    engine: new SignalEngine({
      timeframeMin,
      retestTolerancePct,
      rsWindowBars5m,
      emaPeriods: Array.isArray(rs.config?.emaPeriods) ? rs.config.emaPeriods : undefined
    }),

    outcomeTracker: new OutcomeTracker({
      trackWindowMin: TRACK_WINDOW_MIN,
      checkpointsMin: [1, 3, 5, 10, 15, 30, 60]
    }),

    aggMap: new Map(),
    barsMap: new Map()
  };
}

function refreshRunners() {
  const enabled = listEnabledRulesets();
  const want = new Set(enabled.map((x) => x.version));

  // remove disabled runners
  for (const v of Array.from(runners.keys())) {
    if (!want.has(v)) runners.delete(v);
  }

  // add missing runners
  for (const rs of enabled) {
    if (!runners.has(rs.version)) {
      runners.set(rs.version, buildRunner({ version: rs.version, name: rs.name, config: rs.config }));
    }
  }

  // activeRules = highest enabled version (for /api/rules editor default)
  activeRules = loadActiveRuleset(db);
  loadRulesetNames();

  console.log(`[live] runners enabled: ${Array.from(runners.keys()).join(", ") || "none"}`);
}

// call once at boot
refreshRunners();

// -----------------------------
// Rules mutations (save / toggle / update / delete)
// -----------------------------
function saveRules(name: string, config: any, changedBy?: string) {
  if (!config || typeof config !== "object") throw new Error("config required");
  if (!Number.isFinite(config.timeframeMin) || config.timeframeMin < 1) throw new Error("bad timeframeMin");
  if (!Number.isFinite(config.retestTolerancePct) || config.retestTolerancePct < 0) throw new Error("bad retestTolerancePct");
  if (!Number.isFinite(config.rsWindowBars5m) || config.rsWindowBars5m < 1) throw new Error("bad rsWindowBars5m");
  if (!Number.isFinite(config.longMinBiasScore)) throw new Error("bad longMinBiasScore");
  if (!Number.isFinite(config.shortMaxBiasScore)) throw new Error("bad shortMaxBiasScore");

  // EMA periods (optional): allow user-defined periods 1..500
if (config.emaPeriods != null) {
  if (!Array.isArray(config.emaPeriods)) throw new Error("emaPeriods must be an array");
  const cleaned = Array.from(
    new Set<number>(
      config.emaPeriods
        .map((x: any) => Number(x))
        .filter((n: number) => Number.isFinite(n))
        .map((n: number) => Math.floor(n))
        .filter((n: number) => n >= 1 && n <= 500)
    )
  ).sort((a: number, b: number) => a - b);

  if (cleaned.length === 0) throw new Error("emaPeriods empty");
  if (cleaned.length > 50) throw new Error("emaPeriods max 50"); // prevents abuse

  config.emaPeriods = cleaned;
}

  const r = insertRuleset(db, name, config, changedBy) as any;
  const version = Number(r?.version ?? r);

  // insertRuleset() sets active=1 for the new ruleset; refresh runners
  refreshRunners();

  return { version };
}

function setRulesetActiveFn(version: number, active: boolean) {
  setRulesetActive(db, Number(version), Boolean(active));
  refreshRunners();
  return { ok: true, version: Number(version), active: Boolean(active) };
}

function updateRulesetFn(version: number, name: string, config: any, changedBy?: string) {
  // EMA periods (optional): allow user-defined periods 1..500
  if (config?.emaPeriods != null) {
    if (!Array.isArray(config.emaPeriods)) throw new Error("emaPeriods must be an array");
    const cleaned = Array.from(
      new Set<number>(
        config.emaPeriods
          .map((x: any) => Number(x))
          .filter((n: number) => Number.isFinite(n))
          .map((n: number) => Math.floor(n))
          .filter((n: number) => n >= 1 && n <= 500)
      )
    ).sort((a: number, b: number) => a - b);

    if (cleaned.length === 0) throw new Error("emaPeriods empty");
    if (cleaned.length > 50) throw new Error("emaPeriods max 50");

    config.emaPeriods = cleaned;
  }

  const out = updateRuleset(db, Number(version), name, config, changedBy);
  refreshRunners();

  // Rebuild the specific runner to ensure new cfg takes effect immediately
  const v = Number(version);
  const rs = getRulesetByVersion(db, v);
  if (rs && runners.has(v)) {
    runners.set(v, buildRunner({ version: v, name: String(rs.name || `v${v}`), config: rs.config }));
  }

  return out;
}

function deleteRulesetFn(version: number, _changedBy?: string) {
  const out = deleteRuleset(db, Number(version));
  refreshRunners();
  return out;
}

// -----------------------------
// Load persisted watchlist / alerts / outcomes
// -----------------------------
let watch: string[] = db.prepare(`SELECT symbol FROM watchlist ORDER BY symbol`).all().map((r: any) => String(r.symbol));

// Load only recent alerts so Workspace never shows “last week” stuff
const ALERT_TTL_MS = 6 * 60 * 60_000; // 6 hours

// (optional but recommended) prune old rows from DB so it stays small
try {
  db.prepare(`
    DELETE FROM alerts
    WHERE ts < ?
      AND id NOT IN (SELECT alert_id FROM outcomes)
  `).run(Date.now() - ALERT_TTL_MS);
} catch {}

// Load recent alerts + ANY alerts that have outcomes so /outcomes can show full history
let alerts: Alert[] = db
  .prepare(
`SELECT id, ts, symbol, message, dir, level, level_price, structure_level, close, market, rs, meta_json
 FROM alerts
 WHERE ts >= ?
    OR id IN (SELECT alert_id FROM outcomes)
 ORDER BY ts DESC
 LIMIT 50000`
  )
  .all(Date.now() - ALERT_TTL_MS)
  .reverse()
  .map((r: any) => {
    let meta: any = undefined;
    try {
      if (r.meta_json) meta = JSON.parse(String(r.meta_json));
    } catch {
      meta = undefined;
    }
    return {
      id: String(r.id),
      ts: Number(r.ts),
      symbol: String(r.symbol),
      market: (r.market as MarketDirection) ?? "NEUTRAL",
      rs: (r.rs as any) ?? "NONE",
      dir: (r.dir as any) ?? "—",
      level: (r.level as any) ?? "—",
      levelPrice: r.level_price == null ? null : Number(r.level_price),
      structureLevel: r.structure_level == null ? null : Number(r.structure_level),
      breakBarTime: null,
      close: Number(r.close ?? 0),
      message: (r.message as any) ?? "—",
      meta
    } as any;
  });

let outcomes: TradeOutcome[] = db
  .prepare(
    `SELECT
      alert_id, symbol, dir, structure_level, entry_ts, entry_ref_price, status, end_ts,
      mfe_abs, mae_abs, mfe_pct, mae_pct, time_to_mfe_sec,
      stopped_out, stop_ts, stop_close, stop_return_pct, bars_to_stop, returns_json
     FROM outcomes
     ORDER BY entry_ts DESC
     LIMIT 50000`
  )
  .all()
  .reverse()
  .map((r: any) => ({
    alertId: String(r.alert_id),
    symbol: String(r.symbol),
    dir: String(r.dir) as TradeDirection,
    structureLevel: Number(r.structure_level),
    entryTs: Number(r.entry_ts),
    entryRefPrice: Number(r.entry_ref_price),
    status: String(r.status) as TradeOutcome["status"],
    endTs: Number(r.end_ts),

    mfeAbs: Number(r.mfe_abs ?? 0),
    maeAbs: Number(r.mae_abs ?? 0),
    mfePct: Number(r.mfe_pct ?? 0),
    maePct: Number(r.mae_pct ?? 0),
    timeToMfeSec: Number(r.time_to_mfe_sec ?? 0),

    stoppedOut: Boolean(r.stopped_out),
    stopTs: Number(r.stop_ts ?? 0),
    stopClose: Number(r.stop_close ?? 0),
    stopReturnPct: Number(r.stop_return_pct ?? 0),
    barsToStop: Number(r.bars_to_stop ?? 0),

    returnsPct: r.returns_json ? JSON.parse(String(r.returns_json)) : {}
  }));

function dbInsertAlert(a: Alert) {
  db.prepare(
    `INSERT OR REPLACE INTO alerts
      (id, ts, symbol, message, dir, level, level_price, structure_level, close, market, rs, meta_json)
     VALUES
      (?,  ?,  ?,     ?,       ?,   ?,     ?,          ?,               ?,     ?,      ?,  ?)`
  ).run(
    a.id,
    a.ts,
    a.symbol,
    a.message ?? null,
    a.dir ?? null,
    a.level ?? null,
    a.levelPrice ?? null,
    a.structureLevel ?? null,
    Number(a.close ?? 0),
    a.market ?? null,
    a.rs ?? null,
    (a as any)?.meta != null ? JSON.stringify((a as any).meta) : null
  );
}

function dbInsertOutcome(o: TradeOutcome) {
  db.prepare(
    `INSERT OR REPLACE INTO outcomes(
      alert_id, symbol, dir, structure_level, entry_ts, entry_ref_price, status, end_ts,
      mfe_abs, mae_abs, mfe_pct, mae_pct, time_to_mfe_sec,
      stopped_out, stop_ts, stop_close, stop_return_pct, bars_to_stop, returns_json
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    o.alertId,
    o.symbol,
    o.dir,
    o.structureLevel,
    o.entryTs,
    o.entryRefPrice,
    String(o.status),
    o.endTs,

    Number((o as any).mfeAbs ?? 0),
    Number((o as any).maeAbs ?? 0),
    Number((o as any).mfePct ?? 0),
    Number((o as any).maePct ?? 0),
    Number((o as any).timeToMfeSec ?? 0),

    o.stoppedOut ? 1 : 0,
    Number((o as any).stopTs ?? 0),
    Number((o as any).stopClose ?? 0),
    Number((o as any).stopReturnPct ?? 0),
    Number((o as any).barsToStop ?? 0),

    JSON.stringify(o.returnsPct || {})
  );
}

// -----------------------------
// Stream stats (for /api/health)
// -----------------------------
type StreamStats = {
  barsTotal: number;
  barTimestamps: number[];
  lastBarTs: number | null;
  lastSpyTs: number | null;
  lastQqqTs: number | null;
};

const streamStats: StreamStats = {
  barsTotal: 0,
  barTimestamps: [],
  lastBarTs: null,
  lastSpyTs: null,
  lastQqqTs: null
};

function snapshotStreamStats() {
  const now = Date.now();
  streamStats.barTimestamps = streamStats.barTimestamps.filter((t) => now - t <= 60_000);
  const iso = (t: number | null) => (t ? new Date(t).toISOString() : null);

  return {
    barsTotal: streamStats.barsTotal,
    bars1m: streamStats.barTimestamps.length,
    lastBarTs: streamStats.lastBarTs,
    lastBarIso: iso(streamStats.lastBarTs),
    lastSpyTs: streamStats.lastSpyTs,
    lastSpyIso: iso(streamStats.lastSpyTs),
    lastQqqTs: streamStats.lastQqqTs,
    lastQqqIso: iso(streamStats.lastQqqTs)
  };
}


function computeMarketState() {
  const now = Date.now();
  const isRth = isRegularMarketHours(now);

  const lastBarTs = streamStats.lastBarTs;
  const lastBarAgeMs = lastBarTs != null ? now - lastBarTs : null;

  // 1m bars can arrive a bit late; keep this tolerant but meaningful
  const barsFresh = lastBarAgeMs != null ? lastBarAgeMs <= 180_000 : false;

  // "Data Live" should ONLY be true during RTH and fresh bars are arriving
  const dataLive = Boolean(isRth && barsFresh);

  return { isRth, barsFresh, dataLive, lastBarTs, lastBarAgeMs };
}

// -----------------------------
// Paths (stable even if process.cwd() changes)
// -----------------------------
const publicDir = path.join(__dirname, "..", "public");

// -----------------------------
// Canonical 1m candle persistence + 365d retention (on ingest)
// -----------------------------
const upsertCandle1m = db.prepare(
  `INSERT INTO candles_1m (ticker, ts, open, high, low, close, volume, session)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(ticker, ts) DO UPDATE SET
     open=excluded.open,
     high=excluded.high,
     low=excluded.low,
     close=excluded.close,
     volume=excluded.volume,
     session=excluded.session`
);

const deleteOldCandles = db.prepare(`DELETE FROM candles_1m WHERE ts < ?`);
let lastCandlePruneTs = 0;

function candleSessionNY(ts: number): "PREMARKET" | "RTH" | "AFTERHOURS" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const hh = Number(get("hour") || "0");
  const mm = Number(get("minute") || "0");
  const mins = hh * 60 + mm;

  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PREMARKET";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "RTH";
  return "AFTERHOURS";
}

function persistCandle1m(symbol: string, ts: number, o: number, h: number, l: number, c: number, v: number) {
  const sess = candleSessionNY(ts);
  upsertCandle1m.run(symbol, ts, o, h, l, c, Number(v || 0), sess);

  // prune at most once per ~10 minutes (avoid constant deletes)
  const now = Date.now();
  if (now - lastCandlePruneTs > 10 * 60_000) {
    lastCandlePruneTs = now;
    const cutoff = now - 365 * 24 * 60 * 60_000;
    deleteOldCandles.run(cutoff);
  }
}

// -----------------------------
// Watchlist hardening
// -----------------------------
function isValidSymbol(sym: string) {
  return /^[A-Z0-9.\-]{1,10}$/.test(sym);
}

function normalizedWatchlist(): string[] {
  const cleaned = (watch || [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean)
    .filter(isValidSymbol);

  return Array.from(new Set(cleaned)).slice(0, 50);
}

function streamSymbols(): string[] {
  return Array.from(new Set([...normalizedWatchlist(), "SPY", "QQQ"]));
}

// -----------------------------
// Levels (shared across strategies)
// -----------------------------
const levelsMap = new Map<string, ReturnType<typeof initLevels>>();

function getLevels(symbol: string) {
  if (!levelsMap.has(symbol)) levelsMap.set(symbol, initLevels(Date.now()));
  return levelsMap.get(symbol)!;
}

// -----------------------------
// VWAP + last price (shared)
// -----------------------------
type VwapState = { dayKey: string; pv: number; v: number; vwap: number | null };
const vwapMap = new Map<string, VwapState>();
const lastPriceMap = new Map<string, number>();

function updateVwap(symbol: string, ts: number, h: number, l: number, c: number, vol: number) {
  lastPriceMap.set(symbol, c);
  if (!Number.isFinite(vol) || vol <= 0) return;

  const dayKey = nyDayKey(ts);
  const typical = (h + l + c) / 3;
  const prev = vwapMap.get(symbol);

  if (!prev || prev.dayKey !== dayKey) {
    const pv = typical * vol;
    const v = vol;
    vwapMap.set(symbol, { dayKey, pv, v, vwap: pv / v });
    return;
  }

  prev.pv += typical * vol;
  prev.v += vol;
  prev.vwap = prev.pv / prev.v;
}

function getVwap(symbol: string): number | null {
  return vwapMap.get(symbol)?.vwap ?? null;
}

// -----------------------------
// Signals snapshot (single UI snapshot)
// NOTE: Market Snapshot can only display one set of columns;
// we build it from a “representative” runner + aggregate forming.
// -----------------------------
type SignalsSnapshot = {
  ts: number;
  marketBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  spy: { price: number | null; vwap: number | null; side: "ABOVE" | "BELOW" | "NA" };
  qqq: { price: number | null; vwap: number | null; side: "ABOVE" | "BELOW" | "NA" };
  strong: Array<{ symbol: string; price: number; vwap: number; rs: "STRONG" | "WEAK" | "NONE" }>;
  weak: Array<{ symbol: string; price: number; vwap: number; rs: "STRONG" | "WEAK" | "NONE" }>;
  forming: Array<{
    symbol: string;
    dir: "CALL" | "PUT";
    level: string;
    levelPrice: number;
    lastPrice: number | null;
    distancePct: number | null;
    score: number;
    rs: "STRONG" | "WEAK" | "NONE";
    market: "BULLISH" | "BEARISH" | "NEUTRAL";

    // optional tagging (safe additions)
    strategyVersion?: number;
    strategyName?: string;
    timeframeMin?: number;
  }>;
};

let latestSignals: SignalsSnapshot = {
  ts: Date.now(),
  marketBias: "NEUTRAL",
  spy: { price: null, vwap: null, side: "NA" },
  qqq: { price: null, vwap: null, side: "NA" },
  strong: [],
  weak: [],
  forming: []
};

function computeIndexSide(symbol: "SPY" | "QQQ") {
  const price = lastPriceMap.get(symbol) ?? null;
  const vwap = getVwap(symbol);
  if (price == null || vwap == null) return { price, vwap, side: "NA" as const };
  return { price, vwap, side: price >= vwap ? ("ABOVE" as const) : ("BELOW" as const) };
}

function computeMarketBiasFromVwap(symbols: string[]): "BULLISH" | "BEARISH" | "NEUTRAL" {
  let above = 0;
  let below = 0;

  for (const s of symbols) {
    const p = lastPriceMap.get(s);
    const v = getVwap(s);
    if (p == null || v == null) continue;
    if (p >= v) above++;
    else below++;
  }

  const total = above + below;

  if (total < 3) {
    const spy = computeIndexSide("SPY");
    const qqq = computeIndexSide("QQQ");
    if (spy.side === "ABOVE" && qqq.side === "ABOVE") return "BULLISH";
    if (spy.side === "BELOW" && qqq.side === "BELOW") return "BEARISH";
    return "NEUTRAL";
  }

  const ratio = above / total;
  if (ratio >= 0.6) return "BULLISH";
  if (ratio <= 0.4) return "BEARISH";
  return "NEUTRAL";
}

function biasToMarketDir(bias: "BULLISH" | "BEARISH" | "NEUTRAL"): MarketDirection {
  if (bias === "BULLISH") return "BULLISH";
  if (bias === "BEARISH") return "BEARISH";
  return "NEUTRAL";
}

function getEffectiveMarketDir(): MarketDirection {
  const spy = computeIndexSide("SPY");
  const qqq = computeIndexSide("QQQ");

  const indexAlignedBull = spy.side === "ABOVE" && qqq.side === "ABOVE";
  const indexAlignedBear = spy.side === "BELOW" && qqq.side === "BELOW";

  const symbols = normalizedWatchlist();
  const bias = computeMarketBiasFromVwap(symbols);

  if (bias === "BULLISH" && indexAlignedBull) return "BULLISH";
  if (bias === "BEARISH" && indexAlignedBear) return "BEARISH";
  return "NEUTRAL";
}

let lastSignalsBroadcast = 0;

// -----------------------------
// Helpers: market hours + time parsing
// -----------------------------
function isoToMsSafe(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function ymdToUtcMs(ymd: string): number {
  // expects YYYY-MM-DD
  const ms = new Date(`${ymd}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(ms)) throw new Error("bad date");
  return ms;
}

function isRegularMarketHours(ts: number): boolean {
  // NYSE RTH: 9:30–16:00 America/New_York, Mon–Fri
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(ts));

    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const wd = get("weekday") || "";
    const hh = Number(get("hour") || "0");
    const mm = Number(get("minute") || "0");

    if (wd === "Sat" || wd === "Sun") return false;

    const mins = hh * 60 + mm;
    return mins >= 9 * 60 + 30 && mins < 16 * 60;
  } catch {
    return false;
  }
}

// -----------------------------
// DB join rows
// -----------------------------
function isBlockedMsg(msg: string): boolean {
  const m = String(msg || "").toUpperCase();
  return m.includes("FORMING") || m.includes("INVALID");
}

/**
 * Trade-signal detection should NOT depend on message strings.
 * If the engine produced a directional alert with a usable level/structure,
 * we treat it as a trade entry for tracking/backtest.
 */
function isTradeSignal(a: Alert): boolean {
  if (!a) return false;

  const msg = String(a.message || "");
  if (isBlockedMsg(msg)) return false;

  const dirOk = a.dir === "CALL" || a.dir === "PUT";
  if (!dirOk) return false;

  const lp = a.levelPrice != null && Number.isFinite(Number(a.levelPrice)) ? Number(a.levelPrice) : null;
  const sl =
    a.structureLevel != null && Number.isFinite(Number(a.structureLevel))
      ? Number(a.structureLevel)
      : lp;

  return lp != null && sl != null && Number.isFinite(lp) && Number.isFinite(sl);
}

// keep old name used elsewhere (dbrows)
function isEntryAlert(a: Alert) {
  return isTradeSignal(a);
}

function getDbRows() {
  const outById = new Map(outcomes.map((o) => [o.alertId, o] as const));

  return alerts
    .filter(isEntryAlert)
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((a) => {
      const o = outById.get(a.id) ?? null;
      const r = (k: string) => (o?.returnsPct ? (o.returnsPct as any)[k] : null);

      const strategyVersion =
        (a as any)?.meta?.rulesetVersion != null
          ? Number((a as any).meta.rulesetVersion)
          : Number(activeRules?.version ?? 0);

      const strategyName =
        strategyVersion && rulesetNameMap[strategyVersion]
          ? rulesetNameMap[strategyVersion]
          : strategyVersion
          ? `v${strategyVersion}`
          : "";

          const meta = strategyVersion ? rulesetMetaMap[strategyVersion] : undefined;
const timeframeMin = meta?.timeframeMin ?? 1;
const emaPeriods = meta?.emaPeriods ?? [];
const showVwap = meta?.showVwap ?? false;

const stopTs = (o as any)?.stopTs ?? "";
const endTs = (o as any)?.endTs ?? "";

      return {
        alertId: a.id,
        ts: a.ts,
        time: new Date(a.ts).toISOString(),
        symbol: a.symbol,
        market: a.market,
        rs: a.rs,
        dir: a.dir === "CALL" ? "LONG" : a.dir === "PUT" ? "SHORT" : "—",
        level: a.level,
        levelPrice: a.levelPrice ?? "",
        structureLevel: a.structureLevel ?? a.levelPrice ?? "",
        entryRef: a.close ?? "",
        status: o?.status ?? "LIVE",
        stoppedOut: o?.stoppedOut ?? false,
        stopReturnPct: o?.stopReturnPct ?? "",
        barsToStop: o?.barsToStop ?? "",
        mfePct: o?.mfePct ?? "",
        maePct: o?.maePct ?? "",
        timeToMfeSec: o?.timeToMfeSec ?? "",
        ret5m: r("5m") ?? "",
        ret15m: r("15m") ?? "",
        ret30m: r("30m") ?? "",
        ret60m: r("60m") ?? "",
        strategyVersion,
strategyName,

// chart/meta fields
timeframeMin,
emaPeriods,
showVwap,
stopTs,
endTs,
      };
    });
}

// -----------------------------
// HTTP + realtime
// -----------------------------
let realtime: ReturnType<typeof attachRealtime>;

// Broker config wiring (single-tenant for now)
function getBrokers() {
  return BROKERS;
}

function getBrokerConfig() {
  return loadBrokerConfig(db);
}

/**
 * Persist tradingEnabled and allow clearing broker config.
 * Normalizes mode.
 */
function setBrokerConfig(next: any, _changedBy?: string) {
  const brokerKey = String(next?.brokerKey || "").trim();
  const mode = String(next?.mode || "paper") === "live" ? "live" : "paper";
  const config = next?.config && typeof next.config === "object" ? next.config : {};
  const tradingEnabled = Boolean(next?.tradingEnabled);

  // allow clearing config
  if (!brokerKey) {
    return saveBrokerConfig(db, { brokerKey: "", mode, config: {}, tradingEnabled: false });
  }

  const allowed = new Set(BROKERS.map((b) => b.key));
  if (!allowed.has(brokerKey)) throw new Error("unsupported broker");

  return saveBrokerConfig(db, { brokerKey, mode, config, tradingEnabled });
}

// -----------------------------
// Signals recompute + broadcast
// -----------------------------
function recomputeSignalsAndBroadcast() {
  const now = Date.now();
  if (now - lastSignalsBroadcast < 1500) return;
  lastSignalsBroadcast = now;

  const symbols = normalizedWatchlist();

  const spy = computeIndexSide("SPY");
  const qqq = computeIndexSide("QQQ");

  const indexAlignedBull = spy.side === "ABOVE" && qqq.side === "ABOVE";
  const indexAlignedBear = spy.side === "BELOW" && qqq.side === "BELOW";

  const marketBias = computeMarketBiasFromVwap(symbols);
  const marketDirForRS = biasToMarketDir(marketBias);

  // Choose one runner as representative for RS columns.
  const firstRunner = runners.values().next().value as StrategyRunner | undefined;
  const spyBars = firstRunner ? getBars(firstRunner, "SPY") : [];
  const qqqBars = firstRunner ? getBars(firstRunner, "QQQ") : [];

  const strong: SignalsSnapshot["strong"] = [];
  const weak: SignalsSnapshot["weak"] = [];

  if (!streamStats.lastBarTs || Date.now() - streamStats.lastBarTs > 15 * 60_000) {
    latestSignals = { ...latestSignals, ts: Date.now(), strong: [], weak: [], forming: [], marketBias: "NEUTRAL" };
    realtime?.broadcastSignals(latestSignals);
    return;
  }

  // Include SPY/QQQ themselves in Strong/Weak columns (based on representative runner bars)
  if (spyBars.length >= RS_WINDOW_BARS + 1 && qqqBars.length >= RS_WINDOW_BARS + 1) {
    const spySide = computeIndexSide("SPY");
    const qqqSide = computeIndexSide("QQQ");

    const rsSpy = computeRS({
      marketDir: marketDirForRS,
      symBars5: spyBars,
      spyBars5: qqqBars,
      windowBars: RS_WINDOW_BARS
    });

    const rsQqq = computeRS({
      marketDir: marketDirForRS,
      symBars5: qqqBars,
      spyBars5: spyBars,
      windowBars: RS_WINDOW_BARS
    });

    if (marketBias === "BULLISH" && indexAlignedBull) {
      if (spySide.price != null && spySide.vwap != null && spySide.price >= spySide.vwap && rsSpy === "STRONG") {
        strong.push({ symbol: "SPY", price: spySide.price, vwap: spySide.vwap, rs: rsSpy });
      }
      if (qqqSide.price != null && qqqSide.vwap != null && qqqSide.price >= qqqSide.vwap && rsQqq === "STRONG") {
        strong.push({ symbol: "QQQ", price: qqqSide.price, vwap: qqqSide.vwap, rs: rsQqq });
      }
    }

    if (marketBias === "BEARISH" && indexAlignedBear) {
      if (spySide.price != null && spySide.vwap != null && spySide.price <= spySide.vwap && rsSpy === "WEAK") {
        weak.push({ symbol: "SPY", price: spySide.price, vwap: spySide.vwap, rs: rsSpy });
      }
      if (qqqSide.price != null && qqqSide.vwap != null && qqqSide.price <= qqqSide.vwap && rsQqq === "WEAK") {
        weak.push({ symbol: "QQQ", price: qqqSide.price, vwap: qqqSide.vwap, rs: rsQqq });
      }
    }
  }

  // Normal watchlist symbols (based on representative runner bars)
  if (spyBars.length >= RS_WINDOW_BARS + 1) {
    for (const s of symbols) {
      const price = lastPriceMap.get(s);
      const vwap = getVwap(s);
      if (price == null || vwap == null) continue;

      const symBars = firstRunner ? getBars(firstRunner, s) : [];
      if (symBars.length < RS_WINDOW_BARS + 1) continue;

      const rs = computeRS({
        marketDir: marketDirForRS,
        symBars5: symBars,
        spyBars5: spyBars,
        windowBars: RS_WINDOW_BARS
      });

      if (marketBias === "BULLISH" && indexAlignedBull && price >= vwap && rs === "STRONG") {
        strong.push({ symbol: s, price, vwap, rs });
      }

      if (marketBias === "BEARISH" && indexAlignedBear && price <= vwap && rs === "WEAK") {
        weak.push({ symbol: s, price, vwap, rs });
      }
    }
  }

  // Forming: aggregate across ALL enabled strategies
  const rawForming: any[] = [];
  for (const r of runners.values()) {
    const fc = r.engine.getFormingCandidates({
      lastPrice: (sym) => lastPriceMap.get(sym) ?? null
    });

    for (const f of fc) {
      rawForming.push({
        ...f,
        strategyVersion: r.version,
        strategyName: r.name,
        timeframeMin: r.timeframeMin
      });
    }
  }

  const eff = getEffectiveMarketDir();
  const filtered = eff === "NEUTRAL" ? rawForming : rawForming.filter((f) => f.market === eff);

  const priorityRank = (sym: string) => (sym === "SPY" ? 0 : sym === "QQQ" ? 1 : 2);

  const forming = filtered
    .slice()
    .sort((a, b) => {
      const pa = priorityRank(a.symbol);
      const pb = priorityRank(b.symbol);
      if (pa !== pb) return pa - pb;
      return (b.score ?? 0) - (a.score ?? 0);
    })
    .slice(0, 12)
    .map((f) => ({
      symbol: f.symbol,
      dir: f.dir,
      level: f.levelType,
      levelPrice: f.levelPrice,
      lastPrice: f.lastPrice,
      distancePct: f.distancePct,
      score: f.score,
      rs: f.rs,
      market: f.market,
      strategyVersion: f.strategyVersion,
      strategyName: f.strategyName,
      timeframeMin: f.timeframeMin
    }));

  latestSignals = {
    ts: Date.now(),
    marketBias,
    spy,
    qqq,
    strong: strong.slice(0, 12),
    weak: weak.slice(0, 12),
    forming
  };

  realtime?.broadcastSignals(latestSignals);
}

function startOutcomeTrackingIfTrade(r: StrategyRunner, alert: Alert, ts: number) {
  try {
    if (!isTradeSignal(alert)) return;

    const dir =
      alert.dir === "CALL" ? ("LONG" as const) :
      alert.dir === "PUT" ? ("SHORT" as const) :
      null;

    if (!dir) return;

    const structureLevel =
      alert.structureLevel != null && Number.isFinite(Number(alert.structureLevel))
        ? Number(alert.structureLevel)
        : alert.levelPrice != null && Number.isFinite(Number(alert.levelPrice))
        ? Number(alert.levelPrice)
        : null;

    if (structureLevel == null || !Number.isFinite(structureLevel)) return;

    const rules = (() => {
      const risk = (r.cfg && typeof r.cfg === "object") ? (r.cfg as any).risk : null;
      if (!risk || typeof risk !== "object") return null;
      return {
        stopR: Number((risk as any).stopR),
        targetR: Number((risk as any).targetR),
        moveStopToBEAtR: (risk as any).moveStopToBEAtR == null ? null : Number((risk as any).moveStopToBEAtR)
      };
    })();

    console.log("[execRules]", "v"+r.version, r.name, rules);

    r.outcomeTracker.startSession({
      alertId: alert.id,
      symbol: alert.symbol,
      dir,
      structureLevel,
      entryTs: ts,
      entryRefPrice: Number(alert.close ?? 0),

      // NEW: pull broker-like execution rules from this strategy's config
      execRules: (() => {
        const risk = (r.cfg && typeof r.cfg === "object") ? (r.cfg as any).risk : null;
        if (!risk || typeof risk !== "object") return undefined;

        const stopR = Number((risk as any).stopR);
        const targetR = Number((risk as any).targetR);
        const moveStopToBEAtR =
          (risk as any).moveStopToBEAtR == null ? undefined : Number((risk as any).moveStopToBEAtR);

        if (!Number.isFinite(stopR) || stopR <= 0) return undefined;
        if (!Number.isFinite(targetR) || targetR <= 0) return undefined;

        return {
          stopR,
          targetR,
          moveStopToBEAtR:
            Number.isFinite(moveStopToBEAtR as any) && (moveStopToBEAtR as number) > 0
              ? (moveStopToBEAtR as number)
              : undefined
        };
      })()
    });
  } catch {
    // ignore
  }
}
// -----------------------------
// Per-strategy evaluation on bar close
// -----------------------------
function evaluateIfNeededForRunner(r: StrategyRunner, symbol: string, ts: number) {
  // Require enough bars for structure window
  const spyBars = getBars(r, "SPY");
  const qqqBars = getBars(r, "QQQ");
  if (spyBars.length < STRUCTURE_WINDOW || qqqBars.length < STRUCTURE_WINDOW) return;

  if (!isRegularMarketHours(ts)) return;

  const symBars = getBars(r, symbol);
  if (!symBars.length) return;

  r.engine.ensureSymbol(symbol, getLevels(symbol));

  const benchBars = symbol === "SPY" ? qqqBars : spyBars;

  const effDir = getEffectiveMarketDir();

  if (replayBacktestRunning) {
    if (effDir === "NEUTRAL") replayEffNeutral++;
    else if (effDir === "BULLISH") replayEffBull++;
    else if (effDir === "BEARISH") replayEffBear++;
  }
  
  if (effDir === "NEUTRAL") return;

  const alert = r.engine.evaluateSymbol({
    symbol,
    marketDir: effDir,
    spyBars5: benchBars,
    symBars5: symBars,
    symLevels: getLevels(symbol),
    nowTs: ts
  });

  if (alert) {
    if (replayBacktestRunning) {
      replayAlertsTotal++;
      if (isTradeSignal(alert)) replayAlertsEntry++;
    }
    (alert as any).meta = { rulesetVersion: r.version };

    startOutcomeTrackingIfTrade(r, alert, ts);

    alerts.push(alert);
    if (alerts.length > 2000) alerts = alerts.slice(-2000);
    dbInsertAlert(alert);
    realtime?.broadcastAlert(alert);
  }
}

// -----------------------------
// Ingest minute bar (LIVE + BACKFILL)
// Shared: VWAP + levels + candle persistence
// Per strategy: minute updates + aggregation + entries + stop/close
// -----------------------------
function ingestMinuteBar(
  symbol: string,
  ts: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  warmup: boolean
) {
  if (!symbol || !isValidSymbol(symbol)) return;
  if (!Number.isFinite(ts)) return;
  if (![o, h, l, c].every(Number.isFinite)) return;

  updateVwap(symbol, ts, h, l, c, v);
  onBarUpdateLevels(getLevels(symbol), ts, h, l);
  persistCandle1m(symbol, ts, o, h, l, c, v);

  const allowSignals = !warmup && isRegularMarketHours(ts);

// Per-strategy minute updates + possible 1m tap entries
if (!warmup && runners.size) {
  const effDir = getEffectiveMarketDir();

  for (const r of runners.values()) {
    // 0) 1m TAP entry (this is what makes replay behave like live)
    const tap = r.engine.onMinuteBar({
      symbol,
      ts,
      high: h,
      low: l,
      close: c,
      marketDir: effDir
    });

    if (tap) {

// DEBUG counters for replay
if (replayBacktestRunning) {
  replayAlertsTotal++;
  if (isTradeSignal(tap)) replayAlertsEntry++;
}

      (tap as any).meta = { ...(tap as any).meta, rulesetVersion: r.version };

      // start outcome tracking for this entry
      startOutcomeTrackingIfTrade(r, tap, ts);

      alerts.push(tap);
      if (alerts.length > 2000) alerts = alerts.slice(-2000);
      dbInsertAlert(tap);
      realtime?.broadcastAlert(tap);
    }

    // 1) outcome minute updates
    const doneFromMinute = r.outcomeTracker.onMinuteBar({ symbol, ts, high: h, low: l, close: c });
    for (const id of doneFromMinute) {
      const out = r.outcomeTracker.finalize(id);
      if (out) {
        outcomes.push(out);
        dbInsertOutcome(out);
        realtime?.broadcastOutcome(out);
      }
    }
  }
}

  // Per-strategy aggregation + bar-close evaluation
  if (runners.size) {
    for (const r of runners.values()) {
      const bucket = floorBucket(ts, r.timeframeMin);
      const cur = r.aggMap.get(symbol);

      if (!cur || cur.bucketStart !== bucket) {
        if (cur) {
          // finalize prior bar for this strategy
          pushBar(r, symbol, { t: cur.bucketStart, o: cur.o, h: cur.h, l: cur.l, c: cur.c });

          if (!warmup) {
            const closeTs = cur.bucketStart + r.timeframeMin * 60_000;

            // Stop/close is per-strategy timeframe (your requirement)
            const doneFromBar = r.outcomeTracker.onBar5Close({ symbol, ts: closeTs, close: cur.c });
            for (const id of doneFromBar) {
              const out = r.outcomeTracker.finalize(id);
              if (out) {
                outcomes.push(out);
                dbInsertOutcome(out);
                realtime?.broadcastOutcome(out);
              }
            }

            if (allowSignals) {
  if (replayBacktestRunning) replayEvalCalls++;
  evaluateIfNeededForRunner(r, symbol, closeTs);
}
          }
        }

        r.aggMap.set(symbol, { bucketStart: bucket, o, h, l, c, lastMinTs: ts });
      } else {
        cur.h = Math.max(cur.h, h);
        cur.l = Math.min(cur.l, l);
        cur.c = c;
        cur.lastMinTs = ts;
      }
    }
  }

  if (!warmup) recomputeSignalsAndBroadcast();
}

// -----------------------------
// Alpaca stream
// -----------------------------
let stream: AlpacaStream | null = null;

function onAlpacaBar(b: AlpacaBarMsg) {
  try {

    const symbol = String((b as any).S ?? (b as any).symbol ?? "").toUpperCase();
    if (!symbol || !isValidSymbol(symbol)) return;

    const ts = isoToMsSafe((b as any).t);
    if (ts == null) return;

    streamStats.barsTotal++;
    streamStats.lastBarTs = ts;
    streamStats.barTimestamps.push(Date.now());
    if (symbol === "SPY") streamStats.lastSpyTs = ts;
    if (symbol === "QQQ") streamStats.lastQqqTs = ts;

    ingestMinuteBar(
      symbol,
      ts,
      Number((b as any).o),
      Number((b as any).h),
      Number((b as any).l),
      Number((b as any).c),
      Number((b as any).v),
      false
    );
  } catch (e) {
    console.log("[alpaca] onBar error", e);
  }
}

if (HAS_KEYS) {
  let alpacaAuthed = false;

stream = new AlpacaStream(
  { key: KEY, secret: SECRET, feed: FEED },
  {
    onBar: onAlpacaBar,
    onStatus: (s) => {
      console.log(`[alpaca] ${s}`);
      const msg = String(s).toLowerCase();
    
      // If we ever see "authenticated", mark authed.
      if (msg.includes("authenticated")) alpacaAuthed = true;
    
      // On ANY connect/reconnect AFTER auth, resubscribe.
      if (alpacaAuthed && (msg.includes("connected") || msg.includes("reconnected") || msg.includes("authenticated"))) {
        currentSubs = [];
        refreshSubscriptions();
      }
    
      // If we see disconnect, keep authed=false so next connect requires auth again.
      if (msg.includes("disconnected")) alpacaAuthed = false;
    
    }
  }
);

  stream.connect();
}

let currentSubs: string[] = [];

function refreshSubscriptions() {
  if (!stream) return;

  const next = streamSymbols();
  const toUnsub = currentSubs.filter((s) => !next.includes(s));
  const toSub = next.filter((s) => !currentSubs.includes(s));

  console.log(`[alpaca] subscribe=${toSub.join(",") || "—"} unsubscribe=${toUnsub.join(",") || "—"}`);

  if (toUnsub.length) stream.unsubscribeBars(toUnsub);
  if (toSub.length) stream.subscribeBars(toSub);

  currentSubs = next;
}

setTimeout(() => refreshSubscriptions(), 5000);

// -----------------------------
// REST backfill (warm-up) + replay
// -----------------------------
function httpGetJson(url: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function backfillSymbol1m(symbol: string, limit = 300) {
  const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&limit=${limit}&feed=${encodeURIComponent(
    FEED
  )}`;

  const json = await httpGetJson(url, {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SECRET
  });

  const bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = json?.bars || [];
  for (const b of bars) {
    const ts = isoToMsSafe(b.t);
    if (ts == null) continue;
    ingestMinuteBar(symbol, ts, b.o, b.h, b.l, b.c, b.v, true);
  }
}

async function fetchBars1mRange(symbol: string, startMs: number, endMs: number) {
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();

  let pageToken: string | undefined = undefined;
  const out: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];

  // Alpaca endpoint supports pagination via page_token
  while (true) {
    const url =
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars` +
      `?timeframe=1Min&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}` +
      `&limit=10000&feed=${encodeURIComponent(FEED)}` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

    const json = await httpGetJson(url, {
      "APCA-API-KEY-ID": KEY,
      "APCA-API-SECRET-KEY": SECRET
    });

    const bars = (json?.bars || []) as any[];
    for (const b of bars) {
      if (b?.t) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }

    const next = json?.next_page_token;
    if (!next) break;
    pageToken = String(next);
  }

  return out;
}

async function replayBars(symbols: string[], minutes: number, emitAlerts: boolean) {
  const limit = Math.max(10, Math.min(1000, Number(minutes || 240)));
  const requested = (symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);

  const syms = requested.length ? requested : streamSymbols();
  const ordered = Array.from(new Set(["SPY", "QQQ", ...syms])).filter(Boolean);

  console.log(`[replay] start symbols=${ordered.length} minutes=${limit} emitAlerts=${emitAlerts}`);

  for (const s of ordered) {
    try {
      await backfillSymbol1m(s, limit);
    } catch {
      console.log(`[replay] failed ${s}`);
    }
  }

  recomputeSignalsAndBroadcast();

  // Optional (only if you want noisy replay alerts during current RTH)
  if (emitAlerts && isRegularMarketHours(Date.now())) {
    for (const r of runners.values()) {
      for (const s of ordered) {
        try {
          evaluateIfNeededForRunner(r, s, Date.now());
        } catch {}
      }
    }
  }

  console.log("[replay] done");
}

async function runStartupBackfill() {
  const syms = streamSymbols();
  console.log(`[backfill] starting for ${syms.length} symbols (1m)`);

  const ordered = ["SPY", "QQQ", ...syms.filter((s) => s !== "SPY" && s !== "QQQ")];

  for (const s of ordered) {
    try {
      await backfillSymbol1m(s, 300);
    } catch {
      console.log(`[backfill] failed ${s}`);
    }
  }

  recomputeSignalsAndBroadcast();
  console.log("[backfill] done");
}

const selectCandles1m = db.prepare(
  `SELECT ts,
          open  AS o,
          high  AS h,
          low   AS l,
          close AS c,
          volume AS v
   FROM candles_1m
   WHERE ticker = ? AND ts >= ? AND ts <= ?
   ORDER BY ts ASC
   LIMIT ?`
);

function getCandles1m(symbol: string, startTs: number, endTs: number, limit: number) {
  const lim = Math.max(10, Math.min(5000, Math.floor(Number(limit || 500))));
  const rows = selectCandles1m.all(symbol, startTs, endTs, lim) as any[];
  return rows.map((r) => ({
    ts: Number(r.ts),
    o: Number(r.o),
    h: Number(r.h),
    l: Number(r.l),
    c: Number(r.c),
    v: Number(r.v || 0)
  }));
}

let replayBacktestRunning = false;
let replayEvalCalls = 0;

let replayEffNeutral = 0;
let replayEffBull = 0;
let replayEffBear = 0;

let replayAlertsTotal = 0;
let replayAlertsEntry = 0;

async function runReplayBacktest(cfg: {
  tickers: string[];
  startDate: string;
  endDate: string;
  strategyVersion: number;
  warmupMinutes?: number;

  // --- NEW (optional) ---
  baseEquity?: number;     // starting account size
  compounding?: boolean;   // if true -> size off (base + pnl); if false -> size off base only
  positionPct?: number;    // 0..1 fraction of account per trade (default 1)
}) {
  if (replayBacktestRunning) throw new Error("replay backtest already running");
  if (!HAS_KEYS) throw new Error("Alpaca keys missing; replay backtest requires REST data access");

  replayBacktestRunning = true;
  replayEvalCalls = 0;

  replayEffNeutral = 0;
replayEffBull = 0;
replayEffBear = 0;

replayAlertsTotal = 0;
replayAlertsEntry = 0;

  // Normalize tickers
  const tickers = Array.from(
    new Set((cfg.tickers || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))
  );

  const startMs = ymdToUtcMs(cfg.startDate);
  const endMs = ymdToUtcMs(cfg.endDate) + 24 * 60 * 60_000 - 1; // inclusive end day
  const warmupMin = Number.isFinite(Number(cfg.warmupMinutes)) ? Math.max(0, Number(cfg.warmupMinutes)) : 2000;


// -----------------------------
// NEW: equity sizing toggle
// -----------------------------
const baseEquity = Number.isFinite(Number(cfg.baseEquity)) ? Number(cfg.baseEquity) : 100000; // default
const compounding = cfg.compounding == null ? true : Boolean(cfg.compounding);

const positionPctRaw = Number(cfg.positionPct);
const positionPct =
  Number.isFinite(positionPctRaw) ? Math.max(0, Math.min(1, positionPctRaw)) : 1; // default 100%

let cashPnl = 0; // realized PnL accumulated

function equityForSizing() {
  return compounding ? (baseEquity + cashPnl) : baseEquity;
}
  
  // Build symbol set (includes SPY/QQQ for market/RS logic)
  const symbols = Array.from(new Set(["SPY", "QQQ", ...tickers])).filter(Boolean);

  // ---- Snapshot live state so we can restore after replay ----
  const savedWatch = [...watch];
watch = [...tickers];
  
  const savedRealtime = realtime;
  const savedAlerts = alerts;
  const savedOutcomes = outcomes;

  const savedRunners = Array.from(runners.entries());

  const savedLevels = new Map(levelsMap);
  const savedVwap = new Map(vwapMap);
  const savedLastPrice = new Map(lastPriceMap);

  const savedStream = { ...streamStats, barTimestamps: [...streamStats.barTimestamps] };

  try {
    // Silence realtime broadcasts during replay
    (realtime as any) = undefined;

    // Clear live signal caches/maps to isolate replay
    levelsMap.clear();
    vwapMap.clear();
    lastPriceMap.clear();

    streamStats.barsTotal = 0;
    streamStats.barTimestamps = [];
    streamStats.lastBarTs = null;
    streamStats.lastSpyTs = null;
    streamStats.lastQqqTs = null;

    // Isolate to ONE runner (the strategy under test)
    runners.clear();

    const rs = getRulesetByVersion(db, Number(cfg.strategyVersion));
    if (!rs) throw new Error(`ruleset not found: ${cfg.strategyVersion}`);

    // rs.config is already parsed in your db layer; if not, ensure it’s an object
    const runner = buildRunner({
      version: Number(cfg.strategyVersion),
      name: String((rs as any).name || `v${cfg.strategyVersion}`),
      config: (rs as any).config || (rs as any).config_json || {}
    });

    runners.set(runner.version, runner);

    // Reset outputs for replay run
    alerts = [];
    outcomes = [];

    // ---- Fetch bars for each symbol, then merge by timestamp ----
    const warmupStartMs = Math.max(0, startMs - warmupMin * 60_000);

    const events: Array<{
      ts: number;
      symbol: string;
      o: number; h: number; l: number; c: number; v: number;
      warmup: boolean;
    }> = [];

    for (const s of symbols) {
      const bars = await fetchBars1mRange(s, warmupStartMs, endMs);
      for (const b of bars) {
        const ts = isoToMsSafe(b.t);
        if (ts == null) continue;
        events.push({
          ts,
          symbol: s,
          o: Number(b.o),
          h: Number(b.h),
          l: Number(b.l),
          c: Number(b.c),
          v: Number(b.v || 0),
          warmup: ts < startMs
        });
      }
    }

    // Sort chronologically to simulate live arrival
    events.sort((a, b) => a.ts - b.ts);

    // ---- Diagnostics ----
let warmupCount = 0;
let rthCount = 0;
let ingestedCount = 0;

// probe a few timestamps to confirm market hours alignment
const sampleTs: number[] = [];
for (let i = 0; i < events.length; i += Math.max(1, Math.floor(events.length / 10))) {
  sampleTs.push(events[i].ts);
}

    // Replay through the SAME ingestion pipeline
    for (const e of events) {
      if (e.warmup) warmupCount++;
if (isRegularMarketHours(e.ts)) rthCount++;
ingestedCount++;
      // Track stream stats like live does
      streamStats.barsTotal++;
      streamStats.lastBarTs = e.ts;
      streamStats.barTimestamps.push(Date.now());
      if (e.symbol === "SPY") streamStats.lastSpyTs = e.ts;
      if (e.symbol === "QQQ") streamStats.lastQqqTs = e.ts;

      ingestMinuteBar(e.symbol, e.ts, e.o, e.h, e.l, e.c, e.v, e.warmup);
    }

    // ---- Build summary ----
    const trades = outcomes.filter((o) => o && o.alertId);
    const total = trades.length;

    let wins = 0;
    for (const t of trades) {
      // define win: stopReturnPct > 0 for stopped, or 60m return > 0 if completed
      const r60 = (t.returnsPct as any)?.["60m"];
      const basis = t.stoppedOut ? t.stopReturnPct : (r60 != null ? Number(r60) : t.mfePct);
      if (Number.isFinite(Number(basis)) && Number(basis) > 0) wins++;
    }

    // -----------------------------
// NEW: equity curve + realized PnL using the SAME basis logic
// -----------------------------
const byTime = trades
.slice()
.sort((a, b) => Number(a.entryTs ?? 0) - Number(b.entryTs ?? 0));

const equityCurve: Array<{ ts: number; equity: number; pnl: number; retPct: number; alertId: string; symbol: string }> = [];
equityCurve.push({ ts: startMs, equity: baseEquity, pnl: 0, retPct: 0, alertId: "START", symbol: "" });

for (const t of byTime) {
  const exitPct = (t.returnsPct as any)?.["exit"];
  const r60 = (t.returnsPct as any)?.["60m"];
  
  const basisPct =
    exitPct != null
      ? Number(exitPct)
      : (t.stoppedOut ? Number(t.stopReturnPct) : (r60 != null ? Number(r60) : Number(t.mfePct)));

if (!Number.isFinite(basisPct)) continue;

const notional = equityForSizing() * positionPct;
const pnl = notional * (basisPct / 100);

cashPnl += pnl;

const stamp = Number(t.endTs ?? t.entryTs ?? Date.now());
equityCurve.push({
  ts: stamp,
  equity: baseEquity + cashPnl,
  pnl,
  retPct: basisPct,
  alertId: String(t.alertId),
  symbol: String(t.symbol)
});
}

const finalEquity = baseEquity + cashPnl;


    return {
      strategyVersion: runner.version,
      strategyName: runner.name,
      symbols,
      startDate: cfg.startDate,
      endDate: cfg.endDate,
      warmupMinutes: warmupMin,
    
      // --- NEW ---
      baseEquity,
      compounding,
      positionPct,
      finalEquity,
      equityCurve,
    
      totals: {
        trades: total,
        wins,
        winRate: total ? wins / total : 0
      },
      debug: {
        eventsTotal: events.length,
        ingestedCount,
        warmupCount,
        rthCount,
        replayEvalCalls,
        effDir: {
          neutral: replayEffNeutral,
          bullish: replayEffBull,
          bearish: replayEffBear
        },
        alerts: {
          total: replayAlertsTotal,
          entry: replayAlertsEntry
        },
        sampleTsIso: sampleTs.map((t) => new Date(t).toISOString())
      },
      outcomes: trades
    };
  } finally {
    // Restore everything back to live
    (realtime as any) = savedRealtime;

    alerts = savedAlerts;
    outcomes = savedOutcomes;

    runners.clear();
    for (const [k, v] of savedRunners) runners.set(k, v);

    levelsMap.clear();
    for (const [k, v] of savedLevels) levelsMap.set(k, v);

    vwapMap.clear();
    for (const [k, v] of savedVwap) vwapMap.set(k, v);

    lastPriceMap.clear();
    for (const [k, v] of savedLastPrice) lastPriceMap.set(k, v);

    streamStats.barsTotal = savedStream.barsTotal;
    streamStats.barTimestamps = savedStream.barTimestamps;
    streamStats.lastBarTs = savedStream.lastBarTs;
    streamStats.lastSpyTs = savedStream.lastSpyTs;
    streamStats.lastQqqTs = savedStream.lastQqqTs;

    watch = savedWatch;

    replayBacktestRunning = false;
  }
}

// -----------------------------
// HTTP app wiring
// -----------------------------
const app = createHttpApp({
  publicDir,

  // rules
  getRules,
  listRulesets,
  getRulesetByVersion: (version: number) => getRulesetByVersion(db, version),
  setRulesetActive: (version: number, active: boolean) => setRulesetActiveFn(version, active),
  saveRules: (name: string, config: any, changedBy?: string) => saveRules(name, config, changedBy),
  deleteRuleset: (version: number, changedBy?: string) => deleteRulesetFn(version, changedBy),
  updateRuleset: (version: number, name: string, config: any, changedBy?: string) => updateRulesetFn(version, name, config, changedBy),

  // backtests
  createBacktestRun: (cfg: any) => backtestQueue.createRun(cfg),
  getBacktestRun: (id: string) => backtestQueue.getRun(id),
  getBacktestTrades: (id: string) => backtestQueue.listTrades(id),
  getBacktestEquity: (id: string) => backtestQueue.getEquity(id),
  listBacktestRuns: (opts: { limit: number; strategyVersion?: number }) => backtestQueue.listRuns(opts),

  // data for UI
  getAlerts: () => alerts,
  getWatchlist: () => normalizedWatchlist(),
  getSignals: () => latestSignals,
  getStreamStats: () => snapshotStreamStats(),
  replay: (symbols, minutes, emitAlerts) => replayBars(symbols, minutes, emitAlerts),
  runReplayBacktest: (cfg) => runReplayBacktest(cfg),

  // broker integration endpoints
  getBrokers,
  getBrokerConfig,
  saveBrokerConfig: (cfg: any, changedBy?: string) => setBrokerConfig(cfg, changedBy),

  // used by /api/broker/status
  httpGetJson: (url: string, headers: Record<string, string>) => httpGetJson(url, headers),

  // outcomes
  getOutcomes: () => outcomes,
  getOutcomeByAlertId: (id: string) => outcomes.find((o) => o.alertId === id) ?? null,
  getDbRows,
  getCandles1m,

  getMarketState: () => computeMarketState(),

  addSymbol: async (s: string) => {
    const sym = String(s || "").trim().toUpperCase();
    if (!sym) return;
    if (!isValidSymbol(sym)) return;

    if (!watch.includes(sym)) {
      watch.push(sym);
      const etf = await resolveSectorEtf(sym);
      db.prepare(`INSERT OR REPLACE INTO watchlist(symbol, sector_etf, updated_ts) VALUES(?,?,?)`).run(sym, etf, Date.now());
    }

    refreshSubscriptions();
    realtime?.broadcastWatchlist(normalizedWatchlist());
  },

  removeSymbol: async (s: string) => {
    const sym = String(s || "").trim().toUpperCase();
    if (!sym) return;

    watch = watch.filter((x) => x !== sym);
    db.prepare(`DELETE FROM watchlist WHERE symbol=?`).run(sym);

    refreshSubscriptions();
    realtime?.broadcastWatchlist(normalizedWatchlist());
  }
});

// -----------------------------
// Server + realtime
// -----------------------------
const server = http.createServer(app);

realtime = attachRealtime(server, {
  getAlerts: () => alerts,
  getWatchlist: () => normalizedWatchlist(),
  getSignals: () => latestSignals
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);

  if (!HAS_KEYS) {
    console.log("NOTE: Alpaca keys missing in .env. UI will load, but no live data will stream yet.");
    return;
  }

  runStartupBackfill().catch((e) => console.log("[backfill] error", e));
});