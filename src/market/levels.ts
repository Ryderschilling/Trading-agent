import { isExtendedSessionNY, isRegularSessionNY, nyDayKey } from "./time";

export type LevelType = "PMH" | "PML" | "PDH" | "PDL";

export type Levels = {
  dayKey: string;

  pmh: number | null;
  pml: number | null;

  // previous regular session high/low (yesterday RTH)
  pdh: number | null;
  pdl: number | null;

  // tracking current regular session to roll into pdh/pdl for next day
  curRthHigh: number | null;
  curRthLow: number | null;

  lastUpdatedMs: number;
};

export function initLevels(nowMs: number): Levels {
  return {
    dayKey: nyDayKey(nowMs),
    pmh: null,
    pml: null,
    pdh: null,
    pdl: null,
    curRthHigh: null,
    curRthLow: null,
    lastUpdatedMs: nowMs
  };
}

export function onBarUpdateLevels(levels: Levels, barTimeMs: number, high: number, low: number) {
  const barDay = nyDayKey(barTimeMs);

  // New NY day rollover: yesterday's tracked regular session becomes new PDH/PDL
  if (barDay !== levels.dayKey) {
    if (levels.curRthHigh != null && levels.curRthLow != null) {
      levels.pdh = levels.curRthHigh;
      levels.pdl = levels.curRthLow;
    }
    levels.dayKey = barDay;
    levels.pmh = null;
    levels.pml = null;
    levels.curRthHigh = null;
    levels.curRthLow = null;
  }

  // EXTENDED session levels (premarket OR after-hours)
  if (isExtendedSessionNY(barTimeMs)) {
    levels.pmh = levels.pmh == null ? high : Math.max(levels.pmh, high);
    levels.pml = levels.pml == null ? low : Math.min(levels.pml, low);
  }

  // Regular session tracking (for tomorrow's PDH/PDL)
  if (isRegularSessionNY(barTimeMs)) {
    levels.curRthHigh = levels.curRthHigh == null ? high : Math.max(levels.curRthHigh, high);
    levels.curRthLow = levels.curRthLow == null ? low : Math.min(levels.curRthLow, low);
  }

  levels.lastUpdatedMs = barTimeMs;
}

export function getLevelPrice(levels: Levels, level: LevelType): number | null {
  if (level === "PMH") return levels.pmh;
  if (level === "PML") return levels.pml;
  if (level === "PDH") return levels.pdh;
  return levels.pdl;
}