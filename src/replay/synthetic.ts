// src/replay/synthetic.ts
//
// Deterministic synthetic test-day generator for the replay harness.
//
// Each scenario produces a full NY trading day of 1m bars for:
//   - the test symbol (e.g. TEST_BULL)
//   - SPY (for market direction + RS)
//   - QQQ (for market direction)
//
// All scenarios use the same date (DAY) so DST math is fixed.
// All times are NY local; the helper converts to epoch ms.

import { nyPartsFromMs } from "../market/time";
import { ReplayBar1m, ReplayBarsBySymbol, Scenario } from "./types";

const DAY = { year: 2026, month: 5, day: 15 } as const; // Friday, EDT (UTC-4)
const DAY_KEY = `${DAY.year}-${String(DAY.month).padStart(2, "0")}-${String(DAY.day).padStart(2, "0")}`;

/**
 * Convert NY local (hh:mm on DAY) to UTC epoch ms.
 * Tries EDT (UTC-4) and EST (UTC-5) and picks whichever round-trips through
 * nyPartsFromMs — same trick used elsewhere in the codebase for DST safety.
 */
function nyTimeMs(hh: number, mm: number): number {
  for (const offsetHours of [4, 5]) {
    const guess = Date.UTC(DAY.year, DAY.month - 1, DAY.day, hh + offsetHours, mm, 0, 0);
    const p = nyPartsFromMs(guess);
    if (p.y === DAY.year && p.m === DAY.month && p.d === DAY.day && p.hh === hh && p.mm === mm) {
      return guess;
    }
  }
  throw new Error(`could not resolve NY time ${hh}:${mm} for ${DAY_KEY}`);
}

/** Single 1m bar at a given NY hh:mm. */
function bar(hh: number, mm: number, o: number, h: number, l: number, c: number, v = 1000): ReplayBar1m {
  return { t: nyTimeMs(hh, mm), o, h, l, c, v };
}

/** Generate flat-price 1m bars between two NY times (inclusive of from, exclusive of to). */
function flatRange(fromHH: number, fromMM: number, toHH: number, toMM: number, price: number, vol = 500): ReplayBar1m[] {
  const out: ReplayBar1m[] = [];
  const fromTs = nyTimeMs(fromHH, fromMM);
  const toTs = nyTimeMs(toHH, toMM);
  const ONE_MIN = 60_000;
  for (let t = fromTs; t < toTs; t += ONE_MIN) {
    // tiny jitter on high/low so bars aren't degenerate (some libs reject h==l)
    out.push({ t, o: price, h: price + 0.01, l: price - 0.01, c: price, v: vol });
  }
  return out;
}

/** Linear ramp 1m bars from priceFrom to priceTo over [from, to). */
function rampRange(
  fromHH: number,
  fromMM: number,
  toHH: number,
  toMM: number,
  priceFrom: number,
  priceTo: number,
  vol = 800
): ReplayBar1m[] {
  const out: ReplayBar1m[] = [];
  const fromTs = nyTimeMs(fromHH, fromMM);
  const toTs = nyTimeMs(toHH, toMM);
  const ONE_MIN = 60_000;
  const steps = Math.max(1, Math.round((toTs - fromTs) / ONE_MIN));
  for (let i = 0; i < steps; i++) {
    const a = i / steps;
    const o = priceFrom + (priceTo - priceFrom) * a;
    const c = priceFrom + (priceTo - priceFrom) * ((i + 1) / steps);
    const h = Math.max(o, c) + 0.02;
    const l = Math.min(o, c) - 0.02;
    out.push({ t: fromTs + i * ONE_MIN, o, h, l, c, v: vol });
  }
  return out;
}

/** Sort all bars in chronological order and freeze. */
function pack(map: Record<string, ReplayBar1m[]>): ReplayBarsBySymbol {
  for (const k of Object.keys(map)) {
    map[k].sort((a, b) => a.t - b.t);
  }
  return map;
}

// ---------------------------------------------------------------------------
// SPY/QQQ shapes — reused across scenarios to control market direction.
// computeMarketDirection (src/market/marketDirection.ts) reads SPY+QQQ levels
// and the latest closes to decide BULLISH / BEARISH / NEUTRAL.
// ---------------------------------------------------------------------------

/**
 * SPY/QQQ bullish day: premarket forms PMH ~$500/$450; RTH opens just under,
 * breaks above premarket high in the first 30 min, then trends up.
 */
function bullishSpyQqq(): { SPY: ReplayBar1m[]; QQQ: ReplayBar1m[] } {
  const spy: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 499.5),
    bar(9, 25, 499.5, 500.0, 499.4, 500.0, 5000), // PMH = 500.00
    ...flatRange(9, 25, 9, 30, 499.8),
    // RTH: break above 500 by 9:50, then trend
    ...rampRange(9, 30, 9, 45, 499.8, 500.5),
    ...rampRange(9, 45, 10, 30, 500.5, 503.0),
    ...flatRange(10, 30, 16, 0, 503.0),
  ];
  const qqq: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 449.5),
    bar(9, 25, 449.5, 450.0, 449.4, 450.0, 5000), // PMH = 450.00
    ...flatRange(9, 25, 9, 30, 449.8),
    ...rampRange(9, 30, 9, 45, 449.8, 450.5),
    ...rampRange(9, 45, 10, 30, 450.5, 453.0),
    ...flatRange(10, 30, 16, 0, 453.0),
  ];
  return { SPY: spy, QQQ: qqq };
}

/**
 * SPY/QQQ bearish day: premarket forms PML; RTH breaks BELOW it in first 30 min.
 */
function bearishSpyQqq(): { SPY: ReplayBar1m[]; QQQ: ReplayBar1m[] } {
  const spy: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 500.5),
    bar(9, 25, 500.5, 500.6, 500.0, 500.0, 5000), // PML = 500.00
    ...flatRange(9, 25, 9, 30, 500.2),
    ...rampRange(9, 30, 9, 45, 500.2, 499.5),
    ...rampRange(9, 45, 10, 30, 499.5, 497.0),
    ...flatRange(10, 30, 16, 0, 497.0),
  ];
  const qqq: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 450.5),
    bar(9, 25, 450.5, 450.6, 450.0, 450.0, 5000), // PML = 450.00
    ...flatRange(9, 25, 9, 30, 450.2),
    ...rampRange(9, 30, 9, 45, 450.2, 449.5),
    ...rampRange(9, 45, 10, 30, 449.5, 447.0),
    ...flatRange(10, 30, 16, 0, 447.0),
  ];
  return { SPY: spy, QQQ: qqq };
}

/**
 * SPY/QQQ neutral day: prices stay inside the premarket range all day.
 * computeMarketDirection should return NEUTRAL → engine emits no setups.
 */
function neutralSpyQqq(): { SPY: ReplayBar1m[]; QQQ: ReplayBar1m[] } {
  // PMH=501, PML=499 — wide-ish range, RTH chops in the middle.
  const spy: ReplayBar1m[] = [
    bar(4, 0, 500, 501, 499, 500, 2000),
    ...flatRange(4, 1, 9, 30, 500),
    ...flatRange(9, 30, 16, 0, 500),
  ];
  const qqq: ReplayBar1m[] = [
    bar(4, 0, 450, 451, 449, 450, 2000),
    ...flatRange(4, 1, 9, 30, 450),
    ...flatRange(9, 30, 16, 0, 450),
  ];
  return { SPY: spy, QQQ: qqq };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function scenarioCleanBullBreakRetest(): Scenario {
  const symbol = "TEST_BULL";
  const { SPY, QQQ } = bullishSpyQqq();

  // Test symbol: PMH = $100. RTH opens at $99.5. Rallies hard through $100
  // by 9:45, pulls back to ~$100.22 (inside tap tolerance but ~0.22% above
  // the level, so passes the min-1R filter), holds, runs to $103.
  const test: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 99.6),
    bar(9, 25, 99.6, 100.0, 99.5, 100.0, 4000), // PMH = $100.00
    ...flatRange(9, 25, 9, 30, 99.7),
    // RTH ramp up — stronger break so the tap can land further above PMH
    ...rampRange(9, 30, 9, 45, 99.7, 100.50),
    bar(9, 45, 100.5, 100.55, 100.45, 100.52, 6000), // 5m close > PMH
    // pullback / retest — bottoms at $100.18 (still inside 0.3% tap tolerance)
    ...rampRange(9, 46, 9, 51, 100.52, 100.20),
    bar(9, 51, 100.20, 100.22, 100.18, 100.22, 5000), // 1m tap, low touches 100.18
    // run-up — next bar opens ~$100.22, giving 1R = 0.22% (passes filter)
    ...rampRange(9, 52, 10, 15, 100.22, 103.0),
    ...flatRange(10, 15, 16, 0, 103.0),
  ];

  return {
    id: "clean_bull_break_retest_long",
    name: "Clean PMH break+retest, long entry should fire",
    description:
      "Test symbol breaks PMH at $100 with 5-min close, retests on a 1-min tap of 99.99, runs to $102. Market is bullish, RS is strong. Engine should emit FORMING then ENTRY (CALL).",
    testSymbol: symbol,
    dayKey: DAY_KEY,
    bars: pack({ [symbol]: test, SPY, QQQ }),
    expect: {
      expectFormingAlert: true,
      expectEntryAlert: true,
      expectedDir: "CALL",
      expectedLevel: "PMH",
      expectedExitReason: "TARGET",
    },
  };
}

function scenarioCleanBearBreakRetest(): Scenario {
  const symbol = "TEST_BEAR";
  const { SPY, QQQ } = bearishSpyQqq();

  // PML = $50. Clean down-up-down pattern:
  //   9:30-9:35  fast dump to $49.62 (5m close below PML, break confirmed)
  //   9:35-9:50  sit flat at $49.62 (no movement)
  //   9:50-9:55  retest up to $49.88 (back near PML, tap fires inside tolerance)
  //   9:56+      straight dump to $48 (clean post-entry move, no bounce to BE)
  const test: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 50.5),
    bar(9, 25, 50.5, 50.6, 50.0, 50.0, 4000), // PML = $50.00
    ...flatRange(9, 25, 9, 30, 50.3),
    // fast break
    ...rampRange(9, 30, 9, 35, 50.3, 49.62),
    // 5m bucket 9:30-9:34 closes when 9:35 arrives — c will be ~49.62
    ...flatRange(9, 35, 9, 50, 49.62),
    // retest up
    ...rampRange(9, 50, 9, 55, 49.62, 49.88),
    bar(9, 55, 49.88, 49.90, 49.86, 49.88, 5000), // 1m tap, high inside tolerance
    // clean dump — next bar opens ~$49.88 (1R = 0.24%, passes min-1R filter)
    ...rampRange(9, 56, 10, 20, 49.88, 48.0),
    ...flatRange(10, 20, 16, 0, 48.0),
  ];

  return {
    id: "clean_bear_break_retest_short",
    name: "Clean PML break+retest, short entry should fire",
    description:
      "Test symbol breaks PML at $50, retests, dumps to $48. Market is bearish, RS is weak. Engine should emit FORMING then ENTRY (PUT).",
    testSymbol: symbol,
    dayKey: DAY_KEY,
    bars: pack({ [symbol]: test, SPY, QQQ }),
    expect: {
      expectFormingAlert: true,
      expectEntryAlert: true,
      expectedDir: "PUT",
      expectedLevel: "PML",
      expectedExitReason: "TARGET",
    },
  };
}

function scenarioFailedBreakNoEntry(): Scenario {
  const symbol = "TEST_LAGGARD";
  const { SPY, QQQ } = bullishSpyQqq();

  // Market bullish, but test symbol UNDERPERFORMS SPY → RS=NONE, not STRONG.
  // SPY moves +0.6% by 9:45; test moves only +0.1%. Even if test closes above
  // its PMH, RS gate kills the signal.
  const test: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 99.9),
    bar(9, 25, 99.9, 100.0, 99.85, 100.0, 4000), // PMH = 100.00
    ...flatRange(9, 25, 9, 30, 99.95),
    // tiny move — underperforms SPY
    ...rampRange(9, 30, 9, 45, 99.95, 100.05),
    ...flatRange(9, 45, 16, 0, 100.05),
  ];

  return {
    id: "failed_break_rs_too_weak",
    name: "Break occurs but RS is not STRONG — no entry",
    description:
      "Test symbol closes barely above PMH but underperforms SPY's move. computeRS should return NONE, blocking the entry.",
    testSymbol: symbol,
    dayKey: DAY_KEY,
    bars: pack({ [symbol]: test, SPY, QQQ }),
    expect: {
      expectFormingAlert: false,
      expectEntryAlert: false,
      expectedExitReason: "NONE",
    },
  };
}

function scenarioNeutralMarketNoFire(): Scenario {
  const symbol = "TEST_NEUTRAL";
  const { SPY, QQQ } = neutralSpyQqq();

  // Test symbol breaks PMH but market is NEUTRAL → engine returns null
  // immediately in evaluateSymbol.
  const test: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 99.5),
    bar(9, 25, 99.5, 100.0, 99.4, 100.0, 4000), // PMH = 100
    ...flatRange(9, 25, 9, 30, 99.7),
    ...rampRange(9, 30, 10, 0, 99.7, 102.0),
    ...flatRange(10, 0, 16, 0, 102.0),
  ];

  return {
    id: "neutral_market_no_fire",
    name: "Neutral market suppresses all signals",
    description:
      "SPY/QQQ stay inside premarket range → marketDir = NEUTRAL. Test symbol's clean break of PMH must be ignored.",
    testSymbol: symbol,
    dayKey: DAY_KEY,
    bars: pack({ [symbol]: test, SPY, QQQ }),
    expect: {
      expectFormingAlert: false,
      expectEntryAlert: false,
      expectedExitReason: "NONE",
    },
  };
}

function scenarioChoppyNoSetup(): Scenario {
  const symbol = "TEST_CHOP";
  const { SPY, QQQ } = bullishSpyQqq();

  // Bullish market but test symbol chops inside premarket range — never closes
  // above PMH. No FORMING, no ENTRY.
  const test: ReplayBar1m[] = [
    ...flatRange(4, 0, 9, 25, 100.0),
    bar(9, 25, 100.0, 100.2, 99.8, 100.0, 4000), // PMH=100.20, PML=99.80
    ...flatRange(9, 25, 9, 30, 100.0),
    // chop inside [99.80, 100.20]
    ...rampRange(9, 30, 9, 40, 100.0, 100.10),
    ...rampRange(9, 40, 9, 50, 100.10, 99.95),
    ...rampRange(9, 50, 10, 0, 99.95, 100.15),
    ...rampRange(10, 0, 10, 15, 100.15, 99.90),
    ...flatRange(10, 15, 16, 0, 100.0),
  ];

  return {
    id: "choppy_inside_range_no_setup",
    name: "Choppy inside premarket range — no setup",
    description: "Test symbol stays inside [PML, PMH] all session. Engine should not emit FORMING or ENTRY.",
    testSymbol: symbol,
    dayKey: DAY_KEY,
    bars: pack({ [symbol]: test, SPY, QQQ }),
    expect: {
      expectFormingAlert: false,
      expectEntryAlert: false,
      expectedExitReason: "NONE",
    },
  };
}

export function buildAllScenarios(): Scenario[] {
  return [
    scenarioCleanBullBreakRetest(),
    scenarioCleanBearBreakRetest(),
    scenarioFailedBreakNoEntry(),
    scenarioNeutralMarketNoFire(),
    scenarioChoppyNoSetup(),
  ];
}

export const SYNTHETIC_DAY_KEY = DAY_KEY;
