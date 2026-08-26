/**
 * Backfills the day_regime table from candles_1m so the /regime page has
 * history on day one instead of starting empty.
 *
 * Read-only against everything except day_regime. Run with the agent stopped
 * (deploy-regime.sh does that for you).
 *
 *   npx ts-node scripts/backfill-day-regime.ts
 */
import "dotenv/config";
import path from "path";
import Database from "better-sqlite3";
import {
  computeDayRegime,
  saveDayRegime,
  ensureDayRegimeTable,
} from "../src/engine/dayRegime";
import { nyDayKey, nyPartsFromMs } from "../src/market/time";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "trading-agent.sqlite");
const db = new Database(DB_PATH);
ensureDayRegimeTable(db);

const watch = (db.prepare(`SELECT symbol FROM watchlist`).all() as any[])
  .map((r) => String(r.symbol || "").toUpperCase())
  .filter(Boolean);

if (!watch.length) {
  console.error("[regime-backfill] watchlist table is empty — aborting");
  process.exit(1);
}
console.log(`[regime-backfill] db=${DB_PATH}`);
console.log(`[regime-backfill] watchlist (${watch.length}): ${watch.join(", ")}`);

// Walk QQQ's RTH bars once, keep the first bar at or after 09:35 ET for each
// session. One indexed scan of a single ticker instead of a strftime full scan
// per day.
const t0 = Date.now();
const qqq = db
  .prepare(`SELECT ts FROM candles_1m WHERE ticker='QQQ' AND session='RTH' ORDER BY ts ASC`)
  .all() as any[];

const snapshotTsByDay = new Map<string, number>();
for (const row of qqq) {
  const ts = Number(row.ts);
  const p = nyPartsFromMs(ts);
  const mins = p.hh * 60 + p.mm;
  if (mins < 9 * 60 + 35) continue;
  const dk = nyDayKey(ts);
  if (!snapshotTsByDay.has(dk)) snapshotTsByDay.set(dk, ts);
}
console.log(`[regime-backfill] ${snapshotTsByDay.size} sessions found in ${Date.now() - t0}ms`);

let written = 0;
let skipped = 0;
for (const dk of Array.from(snapshotTsByDay.keys()).sort()) {
  const ts = snapshotTsByDay.get(dk)!;
  const regime = computeDayRegime(db, ts, watch);
  if (!regime) { skipped++; continue; }
  saveDayRegime(db, regime);
  written++;
  console.log(
    `  ${dk}  vol=${regime.volScore == null ? "n/a" : regime.volScore.toFixed(2)} ` +
    `Q${regime.volQuintile ?? "?"}  top5=${regime.topSymbols.join(",") || "none"}`
  );
}

const total = (db.prepare(`SELECT count(*) c FROM day_regime`).get() as any).c;
console.log(`[regime-backfill] wrote ${written}, skipped ${skipped} (insufficient history), table now holds ${total} rows`);
