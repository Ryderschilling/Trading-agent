// src/replay/preloadHistory.ts
//
// Replay-only helper: read prior 5m bars for a symbol from the candles_1m
// SQLite cache and aggregate them up to 5-minute resolution. Used by the
// harness to pre-warm the SignalEngine's per-symbol bar history before each
// scenario, so filters that need long context (like the 4h trend regime) are
// not in UNKNOWN/cold state when the scenario begins.
//
// Imports better-sqlite3 lazily — harness.ts only imports this module when
// trendFilter4h is enabled, so the native dependency stays optional.

import fs from "fs";
import path from "path";

import { Bar5 } from "../market/marketDirection";

const DB_PATH = path.join(process.cwd(), "data", "trading-agent.sqlite");
const JSON_SIDECAR_DIR = path.join(process.cwd(), "data", "replay-preload");

const FIVE_MIN_MS = 5 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

type Preload5mArgs = {
  symbol: string;
  /** Load bars strictly BEFORE this timestamp (exclusive). Usually scenario start. */
  beforeTs: number;
  /** How many trading days back to load. Calendar days are used as the upper
   *  bound; non-trading days contribute zero bars. */
  tradingDays: number;
};

/**
 * Aggregate 1m → 5m. Buckets are aligned to UTC 5-minute boundaries (same as
 * the live trading server). Returns an array of Bar5 sorted ascending by ts.
 */
function aggregate1mTo5m(rows: Array<{ ts: number; o: number; h: number; l: number; c: number }>): Bar5[] {
  if (!rows.length) return [];
  const out: Bar5[] = [];
  let cur: Bar5 | null = null;

  for (const r of rows) {
    if (!Number.isFinite(r.ts)) continue;
    const slot = Math.floor(r.ts / FIVE_MIN_MS) * FIVE_MIN_MS;
    if (!cur || cur.t !== slot) {
      if (cur) out.push(cur);
      cur = { t: slot, o: r.o, h: r.h, l: r.l, c: r.c };
    } else {
      cur.h = Math.max(cur.h, r.h);
      cur.l = Math.min(cur.l, r.l);
      cur.c = r.c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Read prior 5m bars for `symbol`. Prefers a pre-exported JSON sidecar at
 * data/replay-preload/<SYMBOL>.json — useful in sandboxes / CI where the
 * native better-sqlite3 binary won't load (e.g. macOS-built binary on Linux).
 * Falls back to opening the live SQLite DB directly.
 *
 * Returns [] if neither source is available — callers treat that as "no
 * preload available" and proceed with a cold filter.
 */
export async function preload5mHistoryFromSqlite(args: Preload5mArgs): Promise<Bar5[]> {
  const lowerBoundMs = args.beforeTs - args.tradingDays * ONE_DAY_MS * 2; // 2x calendar buffer for weekends
  const upperBoundMs = args.beforeTs - 1;

  // Sidecar first: avoids loading better-sqlite3 in environments that can't.
  const sidecar = path.join(JSON_SIDECAR_DIR, `${args.symbol.toUpperCase()}.json`);
  if (fs.existsSync(sidecar)) {
    try {
      const raw: Array<{ t: number; o: number; h: number; l: number; c: number }> = JSON.parse(
        fs.readFileSync(sidecar, "utf8")
      );
      const filtered = raw
        .filter((r) => r.t >= lowerBoundMs && r.t <= upperBoundMs && Number.isFinite(r.t))
        .map((r) => ({ ts: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
      return aggregate1mTo5m(filtered);
    } catch {
      // sidecar parse failure — fall through to SQLite
    }
  }

  if (!fs.existsSync(DB_PATH)) return [];

  // Lazy require so environments without better-sqlite3 (e.g. Linux sandbox
  // with macOS-baked binary in iCloud) only fail at this point if they need
  // it — which they don't when the sidecar is present.
  let Database: any;
  try {
    Database = require("better-sqlite3");
  } catch {
    return [];
  }

  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT ts, open AS o, high AS h, low AS l, close AS c
         FROM candles_1m
         WHERE ticker = ? AND ts >= ? AND ts <= ?
         ORDER BY ts ASC`
      )
      .all(args.symbol.toUpperCase(), lowerBoundMs, upperBoundMs) as any[];

    return aggregate1mTo5m(
      rows.map((r: any) => ({
        ts: Number(r.ts),
        o: Number(r.o),
        h: Number(r.h),
        l: Number(r.l),
        c: Number(r.c),
      }))
    );
  } finally {
    db.close();
  }
}
