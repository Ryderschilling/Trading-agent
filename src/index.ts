import "dotenv/config";
import http from "http";
import https from "https";
import path from "path";
import { BacktestQueue } from "./sim/backtestQueue";

import {
  openDb,
  loadActiveRuleset,
  insertRuleset,
  setActiveRuleset,
  setRulesetActive,
  loadBrokerConfig,
  saveBrokerConfig,
  getRulesetByVersion,
  deleteRuleset,
  updateRuleset  // <-- add
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

const TIMEFRAME_MIN = Number(process.env.TIMEFRAME_MINUTES || 5);
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
let activeRules = loadActiveRuleset(db);
const backtestQueue = new BacktestQueue(db);

// ------------------------------------------------------------------
// Ruleset name cache
// ------------------------------------------------------------------
let rulesetNameMap: Record<number, string> = {};

function loadRulesetNames() {
  rulesetNameMap = {};
  try {
    const rows = db.prepare(`SELECT version, name FROM rulesets`).all() as any[];
    for (const r of rows) {
      const v = Number(r?.version ?? 0);
      if (v > 0) rulesetNameMap[v] = String(r?.name ?? "");
    }
  } catch {
    rulesetNameMap = {};
  }
}
loadRulesetNames();

function getRules() {
  return activeRules;
}

function listRulesets() {
  return db.prepare(`SELECT version, created_ts, name, active FROM rulesets ORDER BY version DESC LIMIT 50`).all();
}

function saveRules(name: string, config: any, changedBy?: string) {
  if (!config || typeof config !== "object") throw new Error("config required");
  if (!Number.isFinite(config.timeframeMin) || config.timeframeMin < 1) throw new Error("bad timeframeMin");
  if (!Number.isFinite(config.retestTolerancePct) || config.retestTolerancePct < 0) throw new Error("bad retestTolerancePct");
  if (!Number.isFinite(config.rsWindowBars5m) || config.rsWindowBars5m < 1) throw new Error("bad rsWindowBars5m");
  if (!Number.isFinite(config.longMinBiasScore)) throw new Error("bad longMinBiasScore");
  if (!Number.isFinite(config.shortMaxBiasScore)) throw new Error("bad shortMaxBiasScore");

  const r = insertRuleset(db, name, config, changedBy) as any;
  const version = Number(r?.version ?? r);

  activeRules = loadActiveRuleset(db);
  loadRulesetNames();

  const maybeUpdate = (engine as any).updateConfig;
  if (typeof maybeUpdate === "function") {
    maybeUpdate.call(engine, {
      timeframeMin: activeRules.config.timeframeMin,
      retestTolerancePct: activeRules.config.retestTolerancePct,
      rsWindowBars5m: activeRules.config.rsWindowBars5m
    });
  }

  return { version };
}

function activateRuleset(version: number) {
  setActiveRuleset(db, version);
  activeRules = loadActiveRuleset(db);
  loadRulesetNames();

  const maybeUpdate = (engine as any).updateConfig;
  if (typeof maybeUpdate === "function") {
    maybeUpdate.call(engine, {
      timeframeMin: activeRules.config.timeframeMin,
      retestTolerancePct: activeRules.config.retestTolerancePct,
      rsWindowBars5m: activeRules.config.rsWindowBars5m
    });
  }

  return { version };
}

function setRulesetActiveFn(version: number, active: boolean) {
  setRulesetActive(db, Number(version), Boolean(active));
  return { ok: true, version: Number(version), active: Boolean(active) };
}

function updateRulesetFn(version: number, name: string, config: any, changedBy?: string) {
  const out = updateRuleset(db, Number(version), name, config, changedBy);
  activeRules = loadActiveRuleset(db);
  loadRulesetNames();

  const maybeUpdate = (engine as any).updateConfig;
  if (typeof maybeUpdate === "function") {
    maybeUpdate.call(engine, {
      timeframeMin: activeRules.config.timeframeMin,
      retestTolerancePct: activeRules.config.retestTolerancePct,
      rsWindowBars5m: activeRules.config.rsWindowBars5m
    });
  }

  return out;
}

function deleteRulesetFn(version: number, _changedBy?: string) {
  const out = deleteRuleset(db, Number(version));
  activeRules = loadActiveRuleset(db);
  loadRulesetNames();

  const maybeUpdate = (engine as any).updateConfig;
  if (typeof maybeUpdate === "function") {
    maybeUpdate.call(engine, {
      timeframeMin: activeRules.config.timeframeMin,
      retestTolerancePct: activeRules.config.retestTolerancePct,
      rsWindowBars5m: activeRules.config.rsWindowBars5m
    });
  }

  return out;
}

// -----------------------------
// Load persisted watchlist / alerts / outcomes
// -----------------------------
let watch: string[] = db.prepare(`SELECT symbol FROM watchlist ORDER BY symbol`).all().map((r: any) => String(r.symbol));

let alerts: Alert[] = db
  .prepare(
    `SELECT id, ts, symbol, message, dir, level, level_price, structure_level, close, market, rs, meta_json
     FROM alerts
     ORDER BY ts DESC
     LIMIT 2000`
  )
  .all()
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
     LIMIT 5000`
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
    .filter(isValidSymbol)
    .filter((s) => s !== "SPY" && s !== "QQQ");

  return Array.from(new Set(cleaned)).slice(0, 50);
}

function streamSymbols(): string[] {
  return Array.from(new Set([...normalizedWatchlist(), "SPY", "QQQ"]));
}

// -----------------------------
// VWAP + last price
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
// Signals snapshot
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
// Engine + tracker
// -----------------------------
const engine = new SignalEngine({
  timeframeMin: activeRules.config.timeframeMin ?? TIMEFRAME_MIN,
  retestTolerancePct: activeRules.config.retestTolerancePct ?? RETEST_TOL,
  rsWindowBars5m: activeRules.config.rsWindowBars5m ?? RS_WINDOW_BARS
});

const outcomeTracker = new OutcomeTracker({
  trackWindowMin: TRACK_WINDOW_MIN,
  checkpointsMin: [1, 3, 5, 10, 15, 30, 60]
});

// -----------------------------
// 5m aggregation
// -----------------------------
type Agg = { bucketStart: number; o: number; h: number; l: number; c: number; lastMinTs: number };
const aggMap = new Map<string, Agg>();

const levelsMap = new Map<string, ReturnType<typeof initLevels>>();
const bars5Map = new Map<string, Bar5[]>();

function getLevels(symbol: string) {
  if (!levelsMap.has(symbol)) levelsMap.set(symbol, initLevels(Date.now()));
  return levelsMap.get(symbol)!;
}

function getBars5(symbol: string) {
  if (!bars5Map.has(symbol)) bars5Map.set(symbol, []);
  return bars5Map.get(symbol)!;
}

function pushBar5(symbol: string, bar: Bar5) {
  const arr = getBars5(symbol);
  arr.push(bar);
  if (arr.length > 500) arr.shift();
  engine.ensureSymbol(symbol, getLevels(symbol));
  engine.pushBar5(symbol, bar);
}

function floorBucket(ms: number, minutes: number): number {
  const size = minutes * 60_000;
  return Math.floor(ms / size) * size;
}

function isoToMsSafe(iso: string): number | null {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
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
function isEntryAlert(a: Alert) {
  return String(a.message || "").includes("A+ ENTRY");
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
        (a as any)?.meta?.rulesetVersion != null ? Number((a as any).meta.rulesetVersion) : Number(activeRules?.version ?? 0);

      const strategyName =
        strategyVersion && rulesetNameMap[strategyVersion]
          ? rulesetNameMap[strategyVersion]
          : strategyVersion
          ? `v${strategyVersion}`
          : "";

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
        strategyName
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

const app = createHttpApp({
  publicDir,

// rules
getRules,
listRulesets,
getRulesetByVersion: (version: number) => getRulesetByVersion(db, version),
setRulesetActive: (version: number, active: boolean) => setRulesetActiveFn(version, active),
saveRules: (name: string, config: any, changedBy?: string) => saveRules(name, config, changedBy),
deleteRuleset: (version: number, changedBy?: string) => deleteRulesetFn(version, changedBy),

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

  // broker integration endpoints (http.ts must call these)
  getBrokers,
  getBrokerConfig,
  saveBrokerConfig: (cfg: any, changedBy?: string) => setBrokerConfig(cfg, changedBy),

  // used by /api/broker/status (Alpaca calls)
  httpGetJson: (url: string, headers: Record<string, string>) => httpGetJson(url, headers),

  // outcomes
  getOutcomes: () => outcomes,
  getOutcomeByAlertId: (id: string) => outcomes.find((o) => o.alertId === id) ?? null,
  getDbRows,

  updateRuleset: (version: number, name: string, config: any, changedBy?: string) =>
    updateRulesetFn(version, name, config, changedBy),

  addSymbol: async (s: string) => {
    const sym = String(s || "").trim().toUpperCase();
    if (!sym) return;
    if (!isValidSymbol(sym)) return;
    if (sym === "SPY" || sym === "QQQ") return;

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

// -----------------------------
// Alpaca stream
// -----------------------------
let stream: AlpacaStream | null = null;

if (HAS_KEYS) {
  stream = new AlpacaStream(
    { key: KEY, secret: SECRET, feed: FEED },
    {
      onBar: onAlpacaBar,
      onStatus: (s) => {
        console.log(`[alpaca] ${s}`);
        const msg = String(s).toLowerCase();

        if (msg.includes("connected")) currentSubs = [];
        if (msg.includes("authenticated")) {
          currentSubs = [];
          refreshSubscriptions();
        }
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

  if (toUnsub.length) stream.unsubscribeBars(toUnsub);
  if (toSub.length) stream.subscribeBars(toSub);

  currentSubs = next;
}

setTimeout(() => refreshSubscriptions(), 5000);

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

  const spyBars5 = getBars5("SPY");
  const qqqBars5 = getBars5("QQQ");

  const strong: SignalsSnapshot["strong"] = [];
  const weak: SignalsSnapshot["weak"] = [];

  if (!streamStats.lastBarTs || Date.now() - streamStats.lastBarTs > 15 * 60_000) {
    latestSignals = { ...latestSignals, ts: Date.now(), strong: [], weak: [], forming: [], marketBias: "NEUTRAL" };
    realtime.broadcastSignals(latestSignals);
    return;
  }

  // Include SPY/QQQ themselves in Strong/Weak columns
  if (spyBars5.length >= RS_WINDOW_BARS + 1 && qqqBars5.length >= RS_WINDOW_BARS + 1) {
    const spySide = computeIndexSide("SPY");
    const qqqSide = computeIndexSide("QQQ");

    const rsSpy = computeRS({
      marketDir: marketDirForRS,
      symBars5: spyBars5,
      spyBars5: qqqBars5,
      windowBars: RS_WINDOW_BARS
    });

    const rsQqq = computeRS({
      marketDir: marketDirForRS,
      symBars5: qqqBars5,
      spyBars5: spyBars5,
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

  // Normal watchlist symbols
  if (spyBars5.length >= RS_WINDOW_BARS + 1) {
    for (const s of symbols) {
      const price = lastPriceMap.get(s);
      const vwap = getVwap(s);
      if (price == null || vwap == null) continue;

      const symBars5 = getBars5(s);
      if (symBars5.length < RS_WINDOW_BARS + 1) continue;

      const rs = computeRS({
        marketDir: marketDirForRS,
        symBars5,
        spyBars5,
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

  const eff = getEffectiveMarketDir();

  const rawForming = engine.getFormingCandidates({
    lastPrice: (sym) => lastPriceMap.get(sym) ?? null
  });

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
      market: f.market
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

  realtime.broadcastSignals(latestSignals);
}

// -----------------------------
// Bar handler (LIVE)
// -----------------------------
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

    ingestMinuteBar(symbol, ts, Number((b as any).o), Number((b as any).h), Number((b as any).l), Number((b as any).c), Number((b as any).v), false);
  } catch (e) {
    console.log("[alpaca] onBar error", e);
  }
}

// -----------------------------
// Ingest minute bar (LIVE + BACKFILL)
// -----------------------------
function ingestMinuteBar(symbol: string, ts: number, o: number, h: number, l: number, c: number, v: number, warmup: boolean) {
  // Hardening: ignore broken payloads
  if (!symbol || !isValidSymbol(symbol)) return;
  if (!Number.isFinite(ts)) return;
  if (![o, h, l, c].every(Number.isFinite)) return;

  updateVwap(symbol, ts, h, l, c, v);
  onBarUpdateLevels(getLevels(symbol), ts, h, l);
  persistCandle1m(symbol, ts, o, h, l, c, v);

  // ✅ FIX: single source of truth, scoped for full function
  const allowSignals = !warmup && isRegularMarketHours(ts);

  if (!warmup) {
    const doneFromMinute = outcomeTracker.onMinuteBar({ symbol, ts, high: h, low: l, close: c });

    for (const id of doneFromMinute) {
      const out = outcomeTracker.finalize(id);
      if (out) {
        outcomes.push(out);
        if (outcomes.length > 5000) outcomes = outcomes.slice(-5000);
        dbInsertOutcome(out);
      }
    }

    const effDir = getEffectiveMarketDir();

    const entry =
      !allowSignals || effDir === "NEUTRAL"
        ? null
        : engine.onMinuteBar({ symbol, ts, high: h, low: l, close: c, marketDir: effDir });

    if (entry) {
      const structureLevel = entry.structureLevel ?? entry.levelPrice ?? null;
      if (structureLevel != null && Number.isFinite(structureLevel)) {
        const tradeDir: TradeDirection = entry.dir === "CALL" ? "LONG" : entry.dir === "PUT" ? "SHORT" : "LONG";
        outcomeTracker.startSession({
          alertId: entry.id,
          symbol: entry.symbol,
          dir: tradeDir,
          structureLevel,
          entryTs: entry.ts,
          entryRefPrice: entry.close
        });
      }

      // Tag entry with current ruleset version for strategy filtering
      (entry as any).meta = { rulesetVersion: activeRules.version };

      alerts.push(entry);
      if (alerts.length > 2000) alerts = alerts.slice(-2000);
      dbInsertAlert(entry);
      realtime.broadcastAlert(entry);
    }
  }

  const bucket = floorBucket(ts, TIMEFRAME_MIN);
  const cur = aggMap.get(symbol);

  if (!cur || cur.bucketStart !== bucket) {
    if (cur) {
      pushBar5(symbol, { t: cur.bucketStart, o: cur.o, h: cur.h, l: cur.l, c: cur.c });

      if (!warmup) {
        const closeTs = cur.bucketStart + TIMEFRAME_MIN * 60_000;
        const doneFromBar5 = outcomeTracker.onBar5Close({ symbol, ts: closeTs, close: cur.c });

        for (const id of doneFromBar5) {
          const out = outcomeTracker.finalize(id);
          if (out) {
            outcomes.push(out);
            if (outcomes.length > 5000) outcomes = outcomes.slice(-5000);
            dbInsertOutcome(out);
          }
        }

        // ✅ allowSignals is in-scope and correct for this bar's timestamp
        if (allowSignals) evaluateIfNeeded(symbol, closeTs);
      }
    }

    aggMap.set(symbol, { bucketStart: bucket, o, h, l, c, lastMinTs: ts });
  } else {
    cur.h = Math.max(cur.h, h);
    cur.l = Math.min(cur.l, l);
    cur.c = c;
    cur.lastMinTs = ts;
  }

  if (!warmup) recomputeSignalsAndBroadcast();
}

function evaluateIfNeeded(symbol: string, ts: number) {
  const spyBars5 = getBars5("SPY");
  const qqqBars5 = getBars5("QQQ");
  if (spyBars5.length < STRUCTURE_WINDOW || qqqBars5.length < STRUCTURE_WINDOW) return;

  // Use the bar timestamp (not Date.now) so backfill/replay stays sane
  if (!isRegularMarketHours(ts)) return;

  const symBars5 = getBars5(symbol);
  if (!symBars5.length) return;

  engine.ensureSymbol(symbol, getLevels(symbol));

  const benchBars5 = symbol === "SPY" ? qqqBars5 : spyBars5;

  const effDir = getEffectiveMarketDir();
  if (effDir === "NEUTRAL") return;

  const alert = engine.evaluateSymbol({
    symbol,
    marketDir: effDir,
    spyBars5: benchBars5,
    symBars5,
    symLevels: getLevels(symbol)
  });

  if (alert) {
    (alert as any).meta = { rulesetVersion: activeRules.version };

    alerts.push(alert);
    if (alerts.length > 2000) alerts = alerts.slice(-2000);
    dbInsertAlert(alert);
    realtime.broadcastAlert(alert);
  }
}

// -----------------------------
// REST backfill (warm-up)
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

  if (emitAlerts) {
    for (const s of ordered) {
      try {
        // Use "now" for replay alert eval, but evaluateIfNeeded also checks RTH by ts
        evaluateIfNeeded(s, Date.now());
      } catch {}
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