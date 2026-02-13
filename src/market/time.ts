export type NYParts = { y: number; m: number; d: number; hh: number; mm: number };

const dtf = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

export function nyPartsFromMs(ms: number): NYParts {
  const parts = dtf.formatToParts(new Date(ms));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour),
    mm: Number(map.minute)
  };
}

export function nyDayKey(ms: number): string {
  const p = nyPartsFromMs(ms);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function isPremarketNY(ms: number): boolean {
  const p = nyPartsFromMs(ms);
  const mins = p.hh * 60 + p.mm;
  return mins >= 4 * 60 && mins < 9 * 60 + 30;
}

export function isRegularSessionNY(ms: number): boolean {
  const p = nyPartsFromMs(ms);
  const mins = p.hh * 60 + p.mm;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// NEW: after-hours (16:00–20:00 ET)
export function isAfterHoursNY(ms: number): boolean {
  const p = nyPartsFromMs(ms);
  const mins = p.hh * 60 + p.mm;
  return mins >= 16 * 60 && mins < 20 * 60;
}

// NEW: extended session (premarket OR after-hours)
export function isExtendedSessionNY(ms: number): boolean {
  return isPremarketNY(ms) || isAfterHoursNY(ms);
}