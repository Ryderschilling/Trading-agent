/**
 * One-off backfill: pull last N days of 1m bars (premarket + RTH + after-hours)
 * from Alpaca REST and upsert into `candles_1m`.
 *
 * Uses `feed=sip` for historical, which works for free accounts on data older
 * than 15 minutes. Live streaming feed (ALPACA_FEED) is unaffected.
 *
 * Usage:
 *   npx ts-node scripts/backfill-premarket.ts            # default: yesterday only
 *   npx ts-node scripts/backfill-premarket.ts --days 5
 *   npx ts-node scripts/backfill-premarket.ts --symbols AAPL,SPY,QQQ
 *
 * Safe to run while the live agent is running (WAL mode + upsert).
 */

import "dotenv/config";
import * as path from "path";
import * as https from "https";
import Database from "better-sqlite3";

const KEY =
  process.env.APCA_API_KEY_ID ||
  process.env.ALPACA_API_KEY ||
  process.env.ALPACA_KEY ||
  "";
const SECRET =
  process.env.APCA_API_SECRET_KEY ||
  process.env.ALPACA_API_SECRET ||
  process.env.ALPACA_SECRET ||
  "";
const HISTORICAL_FEED = "sip";

if (!KEY || !SECRET) {
  console.error("[backfill] Missing APCA_API_KEY_ID / APCA_API_SECRET_KEY in .env");
  process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────
function arg(flag: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}

const days = Math.max(1, Math.min(30, Number(arg("--days", "1"))));
const symbolsArg = arg("--symbols");

// ── DB ────────────────────────────────────────────────────────────────────────
const dbPath = path.resolve(process.cwd(), "data", "trading-agent.sqlite");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const upsertCandle1m = db.prepare(
  `INSERT OR REPLACE INTO candles_1m
   (ticker, ts, open, high, low, close, volume, session)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

// ── helpers ───────────────────────────────────────────────────────────────────
function httpGetJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "APCA-API-KEY-ID": KEY,
          "APCA-API-SECRET-KEY": SECRET,
        },
      },
      (res) => {
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
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Mirrors src/index.ts candleSessionNY for table consistency.
function candleSessionNY(ts: number): "PREMARKET" | "RTH" | "AFTERHOURS" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (t: string) => parts.find((p) => p.type === t)?.value;
  const hh = Number(get("hour") || "0");
  const mm = Number(get("minute") || "0");
  const mins = hh * 60 + mm;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PREMARKET";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "RTH";
  return "AFTERHOURS";
}

async function fetchBarsForSymbol(symbol: string, startMs: number, endMs: number) {
  let pageToken: string | undefined = undefined;
  const out: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = [];

  while (true) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const url =
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars` +
      `?timeframe=1Min&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}` +
      `&limit=10000&feed=${encodeURIComponent(HISTORICAL_FEED)}` +
      `&adjustment=raw` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "");

    const json = await httpGetJson(url);
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

function loadWatchlist(): string[] {
  if (symbolsArg) {
    return symbolsArg
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  // Pull from the same DB the agent uses.
  try {
    const row = db
      .prepare(`SELECT json FROM kv WHERE key='watchlist'`)
      .get() as any;
    if (row?.json) {
      const arr = JSON.parse(String(row.json));
      if (Array.isArray(arr)) return arr.map((s) => String(s).toUpperCase());
    }
  } catch {
    // table may not exist
  }

  // Fallback: read data/watchlist.json
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), "data", "watchlist.json"),
      "utf-8"
    );
    const arr = JSON.parse(raw);
    if (Array.isArray(arr?.symbols)) return arr.symbols.map((s: string) => String(s).toUpperCase());
    if (Array.isArray(arr)) return arr.map((s: string) => String(s).toUpperCase());
  } catch {
    /* ignore */
  }

  return [];
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const watchlist = loadWatchlist();
  const symbols = Array.from(new Set(["SPY", "QQQ", ...watchlist])).filter(Boolean);
  if (!symbols.length) {
    console.error("[backfill] No symbols to backfill (watchlist empty + no --symbols arg).");
    process.exit(1);
  }

  // Build a window aligned to NY calendar days so we always cover full premarket
  // (4:00 AM ET) through after-hours (8:00 PM ET). Look back N days from today.
  // 16-min cushion on the end to stay outside the paid SIP real-time window.
  function nyDayBounds(daysBack: number): { start: number; end: number } {
    const now = new Date();
    const dayParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const dp = Object.fromEntries(dayParts.map((p) => [p.type, p.value]));
    const baseUtcMidnight = Date.UTC(Number(dp.year), Number(dp.month) - 1, Number(dp.day));

    // Probe NY offset at this NY-noon to handle DST.
    const noonUtc = baseUtcMidnight + 12 * 3600_000;
    const noonParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(new Date(noonUtc));
    const np = Object.fromEntries(noonParts.map((p) => [p.type, p.value]));
    const nyAsUtc = Date.UTC(
      Number(np.year), Number(np.month) - 1, Number(np.day),
      np.hour === "24" ? 0 : Number(np.hour), Number(np.minute), Number(np.second)
    );
    const nyOffsetMs = nyAsUtc - noonUtc;

    // start = N days ago at 4:00 AM ET; end = today at 8:00 PM ET
    const startUtc = baseUtcMidnight - daysBack * 24 * 3600_000 + 4 * 3600_000 - nyOffsetMs;
    const endUtc   = baseUtcMidnight                            + 20 * 3600_000 - nyOffsetMs;
    return { start: startUtc, end: endUtc };
  }

  const bounds = nyDayBounds(days);
  const cushionEnd = Date.now() - 16 * 60_000;
  const startMs = bounds.start;
  const endMs = Math.min(bounds.end, cushionEnd);

  console.log(`[backfill] feed=${HISTORICAL_FEED} days=${days} symbols=${symbols.length}`);
  console.log(`[backfill] window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}`);
  console.log(`[backfill]   (NY: ${new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",dateStyle:"short",timeStyle:"short"}).format(new Date(startMs))} → ${new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",dateStyle:"short",timeStyle:"short"}).format(new Date(endMs))})`);

  let totalInserted = 0;

  for (const sym of symbols) {
    try {
      const bars = await fetchBarsForSymbol(sym, startMs, endMs);
      if (!bars.length) {
        console.log(`[backfill] ${sym} — 0 bars`);
        continue;
      }

      const insertMany = db.transaction(
        (rows: typeof bars) => {
          for (const b of rows) {
            const ts = new Date(b.t).getTime();
            if (!Number.isFinite(ts)) continue;
            upsertCandle1m.run(
              sym,
              ts,
              Number(b.o),
              Number(b.h),
              Number(b.l),
              Number(b.c),
              Number(b.v || 0),
              candleSessionNY(ts)
            );
          }
        }
      );
      insertMany(bars);

      totalInserted += bars.length;
      console.log(`[backfill] ${sym} — ${bars.length} bars`);
    } catch (e: any) {
      console.error(`[backfill] ${sym} FAILED: ${e?.message || e}`);
    }
  }

  console.log(`[backfill] done — inserted ~${totalInserted} bars across ${symbols.length} symbols.`);
  console.log(`[backfill] Refresh /outcomes to see newly filled premarket candles.`);
  db.close();
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
