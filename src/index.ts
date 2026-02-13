import "dotenv/config";
import http from "http";
import path from "path";
import fs from "fs";
import https from "https";

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
// Stream stats (for /api/health)
// -----------------------------
type StreamStats = {
  barsTotal: number;
  barTimestamps: number[]; // rolling window (last 60s)
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
// Files
// -----------------------------
const dataDir = path.resolve(process.cwd(), "data");
const publicDir = path.resolve(process.cwd(), "public");
const alertsPath = path.join(dataDir, "alerts.json");
const outcomesPath = path.join(dataDir, "outcomes.json");
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

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(alertsPath)) writeJson(alertsPath, []);
if (!fs.existsSync(outcomesPath)) writeJson(outcomesPath, []);
if (!fs.existsSync(watchlistPath)) writeJson(watchlistPath, { symbols: [] });

let alerts: Alert[] = readJson<Alert[]>(alertsPath, []);
let outcomes: TradeOutcome[] = readJson<TradeOutcome[]>(outcomesPath, []);
let watch = readJson<{ symbols: string[] }>(watchlistPath, { symbols: [] }).symbols;

// -----------------------------
// Watchlist hardening
// -----------------------------
function normalizedWatchlist(): string[] {
  const cleaned = (watch || [])
    .map((s) => String(s ?? "").trim().toUpperCase())
    .filter(Boolean)
    .filter((s) => /^[A-Z0-9.\-]{1,10}$/.test(s))
    .filter((s) => s !== "SPY" && s !== "QQQ");

  return Array.from(new Set(cleaned)).slice(0, 50);
}

function streamSymbols(): string[] {
  return Array.from(new Set([...normalizedWatchlist(), "SPY", "QQQ"]));
}

function persistAlerts() {
  if (alerts.length > 2000) alerts = alerts.slice(-2000);
  writeJson(alertsPath, alerts);
}
function persistOutcomes() {
  if (outcomes.length > 5000) outcomes = outcomes.slice(-5000);
  writeJson(outcomesPath, outcomes);
}
function persistWatchlist() {
  writeJson(watchlistPath, { symbols: watch });
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

  // fallback to SPY/QQQ VWAP side if breadth is thin
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
  timeframeMin: TIMEFRAME_MIN,
  retestTolerancePct: RETEST_TOL,
  rsWindowBars5m: RS_WINDOW_BARS
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
function isoToMs(iso: string): number {
  return new Date(iso).getTime();
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
      const r = (k: string) => (o?.returnsPct ? o.returnsPct[k] : null);

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
        ret60m: r("60m") ?? ""
      };
    });
}

// -----------------------------
// HTTP + realtime
// -----------------------------
let realtime: ReturnType<typeof attachRealtime>;

const app = createHttpApp({
  publicDir,
  getAlerts: () => alerts,
  getWatchlist: () => normalizedWatchlist(),
  getSignals: () => latestSignals,
  getStreamStats: () => snapshotStreamStats(),
  replay: (symbols, minutes, emitAlerts) => replayBars(symbols, minutes, emitAlerts),

  getOutcomes: () => outcomes,
  getOutcomeByAlertId: (id: string) => outcomes.find((o) => o.alertId === id) ?? null,

  getDbRows,

  addSymbol: (s: string) => {
    const sym = s.toUpperCase();
    if (!watch.includes(sym)) watch.push(sym);
    persistWatchlist();
    refreshSubscriptions();
    realtime?.broadcastWatchlist(normalizedWatchlist());
  },

  removeSymbol: (s: string) => {
    const sym = s.toUpperCase();
    watch = watch.filter((x) => x !== sym);
    persistWatchlist();
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

  // STARTUP BACKFILL (warm engine immediately)
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

    // SPY RS benchmarked vs QQQ
    const rsSpy = computeRS({
      marketDir: marketDirForRS,
      symBars5: spyBars5,
      spyBars5: qqqBars5,
      windowBars: RS_WINDOW_BARS
    });

    // QQQ RS benchmarked vs SPY
    const rsQqq = computeRS({
      marketDir: marketDirForRS,
      symBars5: qqqBars5,
      spyBars5: spyBars5,
      windowBars: RS_WINDOW_BARS
    });

    if (marketBias === "BULLISH" && indexAlignedBull) {
      if (
        spySide.price != null &&
        spySide.vwap != null &&
        spySide.price >= spySide.vwap &&
        rsSpy === "STRONG"
      ) {
        strong.push({ symbol: "SPY", price: spySide.price, vwap: spySide.vwap, rs: rsSpy });
      }
      if (
        qqqSide.price != null &&
        qqqSide.vwap != null &&
        qqqSide.price >= qqqSide.vwap &&
        rsQqq === "STRONG"
      ) {
        strong.push({ symbol: "QQQ", price: qqqSide.price, vwap: qqqSide.vwap, rs: rsQqq });
      }
    }

    if (marketBias === "BEARISH" && indexAlignedBear) {
      if (
        spySide.price != null &&
        spySide.vwap != null &&
        spySide.price <= spySide.vwap &&
        rsSpy === "WEAK"
      ) {
        weak.push({ symbol: "SPY", price: spySide.price, vwap: spySide.vwap, rs: rsSpy });
      }
      if (
        qqqSide.price != null &&
        qqqSide.vwap != null &&
        qqqSide.price <= qqqSide.vwap &&
        rsQqq === "WEAK"
      ) {
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

  // Priority: SPY then QQQ at the top when present, then highest score
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
  const symbol = String((b as any).S ?? (b as any).symbol ?? "").toUpperCase();
  const ts = isoToMs(b.t);

  // stream stats
  streamStats.barsTotal++;
  streamStats.lastBarTs = ts;
  streamStats.barTimestamps.push(Date.now());
  if (symbol === "SPY") streamStats.lastSpyTs = ts;
  if (symbol === "QQQ") streamStats.lastQqqTs = ts;

  // ingest (live = alerts allowed)
  ingestMinuteBar(symbol, ts, b.o, b.h, b.l, b.c, b.v, false);
}

// -----------------------------
// Ingest minute bar (used by LIVE + BACKFILL)
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
  updateVwap(symbol, ts, h, l, c, v);
  onBarUpdateLevels(getLevels(symbol), ts, h, l);

  // During warmup we only build state. No outcomes, no alerts.
  if (!warmup) {
    const doneFromMinute = outcomeTracker.onMinuteBar({
      symbol,
      ts,
      high: h,
      low: l,
      close: c
    });

    for (const id of doneFromMinute) {
      const out = outcomeTracker.finalize(id);
      if (out) {
        outcomes.push(out);
        persistOutcomes();
      }
    }

    const effDir = getEffectiveMarketDir();
    const entry =
      effDir === "NEUTRAL"
        ? null
        : engine.onMinuteBar({
            symbol,
            ts,
            high: h,
            low: l,
            close: c,
            marketDir: effDir
          });

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

      alerts.push(entry);
      persistAlerts();
      realtime.broadcastAlert(entry);
    }
  }

  // 5m aggregation (always, to warm bars5 + engine)
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
            persistOutcomes();
          }
        }

        evaluateIfNeeded(symbol);
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

function evaluateIfNeeded(symbol: string) {
  const spyBars5 = getBars5("SPY");
  const qqqBars5 = getBars5("QQQ");
  if (spyBars5.length < STRUCTURE_WINDOW || qqqBars5.length < STRUCTURE_WINDOW) return;

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
    alerts.push(alert);
    persistAlerts();
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
          resolve(JSON.parse(data));
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
  const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(
    symbol
  )}/bars?timeframe=1Min&limit=${limit}&feed=${encodeURIComponent(FEED)}`;

  const json = await httpGetJson(url, {
    "APCA-API-KEY-ID": KEY,
    "APCA-API-SECRET-KEY": SECRET
  });

  const bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = json?.bars || [];
  for (const b of bars) {
    const ts = isoToMs(b.t);
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
        evaluateIfNeeded(s);
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