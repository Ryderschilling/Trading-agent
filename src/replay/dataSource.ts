// src/replay/dataSource.ts
//
// Pulls 1-minute bars for a symbol+date from the existing candles_1m SQLite
// cache. If the cache doesn't have the data, fetches from Alpaca and writes
// back to the cache (so the next run is instant).
//
// This module is read-mostly against the live DB. WAL mode (already enabled
// in db.ts) allows the live trading server to keep writing while we read.
// We do NOT modify any other table.

import fs from "fs";
import https from "https";
import path from "path";
import Database from "better-sqlite3";

import { nyPartsFromMs } from "../market/time";
import { ReplayBar1m } from "./types";

const DB_PATH = path.join(process.cwd(), "data", "trading-agent.sqlite");

/** Convert a NY YYYY-MM-DD date to [startMs, endMs] window (UTC ms). */
export function nyDateToWindowMs(dateYmd: string): { startMs: number; endMs: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) throw new Error(`bad date format (want YYYY-MM-DD): ${dateYmd}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);

  // 04:00 NY → 20:00 NY covers premarket + RTH + afterhours
  const startMs = nyHmToUtcMs(y, mo, d, 4, 0);
  const endMs = nyHmToUtcMs(y, mo, d, 20, 0);
  return { startMs, endMs };
}

function nyHmToUtcMs(y: number, mo: number, d: number, hh: number, mm: number): number {
  for (const offsetHours of [4, 5]) {
    const guess = Date.UTC(y, mo - 1, d, hh + offsetHours, mm, 0, 0);
    const p = nyPartsFromMs(guess);
    if (p.y === y && p.m === mo && p.d === d && p.hh === hh && p.mm === mm) return guess;
  }
  throw new Error(`unable to resolve NY time ${y}-${mo}-${d} ${hh}:${mm}`);
}

function openDbReadable(): Database.Database | null {
  if (!fs.existsSync(DB_PATH)) return null;
  // open in read-write so we can also cache new fetches; WAL keeps live server safe
  return new Database(DB_PATH);
}

function readCachedBars(db: Database.Database, symbol: string, startMs: number, endMs: number): ReplayBar1m[] {
  const rows = db
    .prepare(
      `SELECT ts, open, high, low, close, volume
       FROM candles_1m
       WHERE ticker = ? AND ts >= ? AND ts <= ?
       ORDER BY ts ASC`
    )
    .all(symbol.toUpperCase(), startMs, endMs) as any[];

  return rows.map((r) => ({
    t: Number(r.ts),
    o: Number(r.open),
    h: Number(r.high),
    l: Number(r.low),
    c: Number(r.close),
    v: Number(r.volume),
  }));
}

function coverageLooksGood(bars: ReplayBar1m[], startMs: number, endMs: number): boolean {
  if (bars.length < 60) return false;
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  // accept if we cover at least premarket->close-ish window (12:00 NY to 19:30 UTC roughly)
  // Tolerant: must have data within first 2h of window and within last 2h.
  return first <= startMs + 2 * 60 * 60_000 && last >= endMs - 6 * 60 * 60_000;
}

function httpGetJson(url: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data || "{}");
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`Alpaca HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
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

function candleSessionTag(ts: number): "PREMARKET" | "RTH" | "AFTERHOURS" {
  const p = nyPartsFromMs(ts);
  const mins = p.hh * 60 + p.mm;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PREMARKET";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "RTH";
  return "AFTERHOURS";
}

async function fetchFromAlpaca(symbol: string, startMs: number, endMs: number): Promise<ReplayBar1m[]> {
  const key = process.env.APCA_API_KEY_ID || "";
  const secret = process.env.APCA_API_SECRET_KEY || "";
  const feed = String(process.env.ALPACA_FEED || "iex");
  if (!key || !secret) {
    throw new Error(
      `Need APCA_API_KEY_ID + APCA_API_SECRET_KEY in env to fetch ${symbol}. ` +
        `Either set them in .env or pre-cache the day via your existing backtest UI.`
    );
  }

  const bars: ReplayBar1m[] = [];
  let pageToken: string | null = null;
  do {
    const qs = new URLSearchParams({
      timeframe: "1Min",
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
      limit: "10000",
      feed,
      sort: "asc",
    });
    if (pageToken) qs.set("page_token", pageToken);

    const url = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars?${qs.toString()}`;
    const json: any = await httpGetJson(url, {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    });

    const page: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }> = json?.bars || [];
    for (const b of page) {
      const ts = new Date(b.t).getTime();
      if (!Number.isFinite(ts)) continue;
      bars.push({ t: ts, o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c), v: Number(b.v || 0) });
    }

    pageToken = json?.next_page_token ? String(json.next_page_token) : null;
  } while (pageToken);

  return bars;
}

function writeBackToCache(db: Database.Database, symbol: string, bars: ReplayBar1m[]) {
  const stmt = db.prepare(
    `INSERT INTO candles_1m (ticker, ts, open, high, low, close, volume, session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticker, ts) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, volume=excluded.volume, session=excluded.session`
  );
  const tx = db.transaction((rows: ReplayBar1m[]) => {
    for (const b of rows) {
      stmt.run(symbol.toUpperCase(), b.t, b.o, b.h, b.l, b.c, b.v, candleSessionTag(b.t));
    }
  });
  tx(bars);
}

/**
 * Get 1-minute bars for a symbol over the given UTC window. Tries SQLite first,
 * falls back to Alpaca and writes back to the cache. Caller closes nothing.
 */
export async function getOneMinBars(symbol: string, startMs: number, endMs: number): Promise<ReplayBar1m[]> {
  const sym = symbol.toUpperCase();
  const db = openDbReadable();

  if (db) {
    try {
      const cached = readCachedBars(db, sym, startMs, endMs);
      if (coverageLooksGood(cached, startMs, endMs)) {
        db.close();
        return cached;
      }
    } catch {
      // continue to fetch
    }
  }

  const fresh = await fetchFromAlpaca(sym, startMs, endMs);

  if (db) {
    try {
      writeBackToCache(db, sym, fresh);
    } catch {
      // cache write failures are non-fatal
    } finally {
      db.close();
    }
  }

  return fresh;
}
