// src/replay/captureDay.ts
//
// Build a Scenario from real historical data for a given NY date + symbol(s).
// SPY and QQQ are always added (market direction needs them) — they're free
// since they're almost always already cached in candles_1m.
//
// Output JSON drops in data/replay-scenarios/<date>_<symbols>.json so you can
// re-run anytime without re-fetching.

import fs from "fs";
import path from "path";

import { getOneMinBars, nyDateToWindowMs } from "./dataSource";
import { ReplayBarsBySymbol, Scenario } from "./types";

export const SCENARIO_DIR = path.join(process.cwd(), "data", "replay-scenarios");

export type CaptureOptions = {
  /** YYYY-MM-DD (NY date). */
  date: string;
  /** Primary symbol the SignalEngine evaluates against. */
  testSymbol: string;
  /** Optional: write scenario JSON to this path. Defaults to SCENARIO_DIR. */
  outPath?: string;
  /** Skip writing the JSON file (still returns the Scenario). */
  noWrite?: boolean;
  /** Extra non-test symbols to capture alongside (SPY/QQQ are always added). */
  extraContextSymbols?: string[];
};

function defaultOutPath(date: string, testSymbol: string): string {
  const safeSym = testSymbol.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return path.join(SCENARIO_DIR, `${date}_${safeSym}.json`);
}

export async function captureDay(opts: CaptureOptions): Promise<{ scenario: Scenario; jsonPath: string | null }> {
  const testSymbol = opts.testSymbol.toUpperCase();
  if (!testSymbol) throw new Error("captureDay: testSymbol is required");

  const { startMs, endMs } = nyDateToWindowMs(opts.date);

  // Always include SPY + QQQ (market direction inputs). Deduplicate.
  const contextSymbols = new Set<string>(["SPY", "QQQ"]);
  for (const s of opts.extraContextSymbols ?? []) {
    if (s.toUpperCase() !== testSymbol) contextSymbols.add(s.toUpperCase());
  }

  const bars: ReplayBarsBySymbol = {};
  bars[testSymbol] = await getOneMinBars(testSymbol, startMs, endMs);
  for (const sym of contextSymbols) {
    bars[sym] = await getOneMinBars(sym, startMs, endMs);
  }

  // Sanity: refuse to write a scenario that has obvious gaps.
  for (const [sym, list] of Object.entries(bars)) {
    if (list.length === 0) {
      throw new Error(
        `captureDay: zero bars for ${sym} on ${opts.date}. ` +
          `Was the market open? Are Alpaca creds in env? (need APCA_API_KEY_ID + APCA_API_SECRET_KEY)`
      );
    }
  }

  const scenario: Scenario = {
    id: `real_${opts.date}_${testSymbol.toLowerCase()}`,
    name: `${testSymbol} real data, ${opts.date}`,
    description: `Captured 1m bars for ${testSymbol} + SPY + QQQ across the ${opts.date} NY session.`,
    testSymbol,
    dayKey: opts.date,
    bars,
    // No `expect` — observational scenario. Engine output is recorded, not asserted.
  };

  if (opts.noWrite) {
    return { scenario, jsonPath: null };
  }

  const jsonPath = opts.outPath ?? defaultOutPath(opts.date, testSymbol);
  if (!fs.existsSync(path.dirname(jsonPath))) {
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  }
  fs.writeFileSync(jsonPath, JSON.stringify(scenario, null, 2), "utf8");

  return { scenario, jsonPath };
}

export async function captureDayMulti(
  date: string,
  symbols: string[],
  opts: { outDir?: string } = {}
): Promise<Array<{ scenario: Scenario; jsonPath: string | null }>> {
  const results: Array<{ scenario: Scenario; jsonPath: string | null }> = [];
  for (const sym of symbols) {
    const outPath = opts.outDir ? path.join(opts.outDir, `${date}_${sym.toUpperCase()}.json`) : undefined;
    results.push(await captureDay({ date, testSymbol: sym, outPath }));
  }
  return results;
}
