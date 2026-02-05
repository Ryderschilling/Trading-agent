import "dotenv/config";
import http from "http";
import path from "path";
import fs from "fs";

import { AlpacaStream, AlpacaBarMsg } from "./data/alpaca";
import { initLevels, onBarUpdateLevels } from "./market/levels";
import { computeMarketDirection, Bar5 } from "./market/marketDirection";
import { SignalEngine } from "./engine/signalEngine";
import { Alert } from "./engine/types";
import { createHttpApp } from "./server/http";
import { attachRealtime } from "./server/realtime";

const PORT = Number(process.env.PORT || 3000);
const FEED = (process.env.ALPACA_FEED || "iex") as "iex" | "sip" | "delayed_sip";

const TIMEFRAME_MIN = Number(process.env.TIMEFRAME_MINUTES || 5);
const RETEST_TOL = Number(process.env.RETEST_TOLERANCE_PCT || 0.001);
const STRUCTURE_WINDOW = Number(process.env.STRUCTURE_WINDOW || 3);
const RS_WINDOW_BARS = Number(process.env.RS_WINDOW_BARS_5M || 3);

const KEY = process.env.APCA_API_KEY_ID || "";
const SECRET = process.env.APCA_API_SECRET_KEY || "";

// Allow boot without keys so you can paste everything first.
// If keys are missing we’ll run "UI only" mode.
const HAS_KEYS = Boolean(KEY && SECRET);

const dataDir = path.resolve(process.cwd(), "data");
const publicDir = path.resolve(process.cwd(), "public");
const alertsPath = path.join(dataDir, "alerts.json");
const watchlistPath = path.join(dataDir, "watchlist.json");

function readJson<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p: string, v: any) {
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}

// Ensure data files exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(alertsPath)) writeJson(alertsPath, []);
if (!fs.existsSync(watchlistPath)) writeJson(watchlistPath, { symbols: [] });

let alerts: Alert[] = readJson<Alert[]>(alertsPath, []);
let watch = readJson<{ symbols: string[] }>(watchlistPath, { symbols: [] }).symbols;

function normalizedWatchlist(): string[] {
  // Always include SPY and QQQ as market comparators
  const base = ["SPY", "QQQ"];
  const extra = watch.map((s) => s.toUpperCase()).filter((s) => s && s !== "SPY" && s !== "QQQ");
  return [...base, ...Array.from(new Set(extra))].slice(0, 30);
}

function persistAlerts() {
  if (alerts.length > 2000) alerts = alerts.slice(-2000);
  writeJson(alertsPath, alerts);
}

function persistWatchlist() {
  writeJson(watchlistPath, { symbols: watch });
}

// Engine setup
const engine = new SignalEngine({
  timeframeMin: TIMEFRAME_MIN,
  retestTolerancePct: RETEST_TOL,
  rsWindowBars5m: RS_WINDOW_BARS
});

// Per-symbol minute aggregation into 5m
type Agg = { bucketStart: number; o: number; h: number; l: number; c: number; lastMinTs: number };
const aggMap = new Map<string, Agg>();

// symbol contexts
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

function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

// Build server + realtime
const app = createHttpApp({
  publicDir,
  getAlerts: () => alerts,
  getWatchlist: () => normalizedWatchlist(),
  addSymbol: (s: string) => {
    const sym = s.toUpperCase();
    if (sym === "SPY" || sym === "QQQ") return;
    if (!watch.includes(sym)) watch.push(sym);
    persistWatchlist();
    refreshSubscriptions();
    realtime.broadcastWatchlist(normalizedWatchlist());
  },
  removeSymbol: (s: string) => {
    const sym = s.toUpperCase();
    if (sym === "SPY" || sym === "QQQ") return;
    watch = watch.filter((x) => x !== sym);
    persistWatchlist();
    refreshSubscriptions();
    realtime.broadcastWatchlist(normalizedWatchlist());
  }
});

const server = http.createServer(app);
const realtime = attachRealtime(server, {
  getAlerts: () => alerts,
  getWatchlist: () => normalizedWatchlist()
});

server.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  if (!HAS_KEYS) {
    console.log("NOTE: Alpaca keys missing in .env. UI will load, but no live data will stream yet.");
  }
});

// Alpaca stream (only if keys exist)
let stream: AlpacaStream | null = null;

if (HAS_KEYS) {
  stream = new AlpacaStream(
    { key: KEY, secret: SECRET, feed: FEED },
    {
      onBar: onAlpacaBar,
      onStatus: (s) => console.log(`[alpaca] ${s}`)
    }
  );

  stream.connect();
}

let currentSubs: string[] = [];
function refreshSubscriptions() {
  if (!stream) return;
  const next = normalizedWatchlist();
  const toUnsub = currentSubs.filter((s) => !next.includes(s));
  const toSub = next.filter((s) => !currentSubs.includes(s));

  if (toUnsub.length) stream.unsubscribeBars(toUnsub);
  if (toSub.length) stream.subscribeBars(toSub);

  currentSubs = next;
}

// initial subscribe after connect
setTimeout(() => refreshSubscriptions(), 1500);

function onAlpacaBar(b: AlpacaBarMsg) {
  const symbol = b.S.toUpperCase();
  const ts = isoToMs(b.t);

  // Update levels from the incoming minute bar values
  onBarUpdateLevels(getLevels(symbol), ts, b.h, b.l);

  // Aggregate minute bars into 5m candles
  const bucket = floorBucket(ts, TIMEFRAME_MIN);
  const cur = aggMap.get(symbol);

  if (!cur || cur.bucketStart !== bucket) {
    // close prior bucket
    if (cur) {
      pushBar5(symbol, { t: cur.bucketStart, o: cur.o, h: cur.h, l: cur.l, c: cur.c });
      evaluateIfNeeded(symbol);
    }
    aggMap.set(symbol, { bucketStart: bucket, o: b.o, h: b.h, l: b.l, c: b.c, lastMinTs: ts });
  } else {
    cur.h = Math.max(cur.h, b.h);
    cur.l = Math.min(cur.l, b.l);
    cur.c = b.c;
    cur.lastMinTs = ts;
  }
}

function evaluateIfNeeded(symbol: string) {
  const spyBars5 = getBars5("SPY");
  const qqqBars5 = getBars5("QQQ");

  if (spyBars5.length < STRUCTURE_WINDOW || qqqBars5.length < STRUCTURE_WINDOW) return;

  const marketDir = computeMarketDirection({
    spyBars5,
    qqqBars5,
    spyLevels: getLevels("SPY"),
    qqqLevels: getLevels("QQQ"),
    structureWindow: STRUCTURE_WINDOW
  });

  if (symbol === "SPY" || symbol === "QQQ") return;

  const symBars5 = getBars5(symbol);
  const last = symBars5.at(-1);
  if (!last) return;

  engine.ensureSymbol(symbol, getLevels(symbol));

  const alert = engine.evaluateSymbol({
    symbol,
    marketDir,
    spyBars5,
    symBars5,
    symLevels: getLevels(symbol)
  });

 if (symbol === "AMZN") {
    console.log('[5m] ${symbol} close=${last.c} market=${marketDir}');
}

 if (alert) {
    alerts.push(alert);
    persistAlerts();
    realtime.broadcastAlert(alert);
    console.log(`[ALERT] ${alert.symbol} ${alert.message}`);
  }
}
