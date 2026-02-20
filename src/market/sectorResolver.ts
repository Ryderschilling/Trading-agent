import https from "https";

const STATIC_MAP: Record<string, string> = {
  // Tech
  AAPL: "XLK", MSFT: "XLK", NVDA: "XLK", AMD: "XLK", AVGO: "XLK", ORCL: "XLK",
  // Communication
  META: "XLC", GOOGL: "XLC", GOOG: "XLC", NFLX: "XLC",
  // Consumer Discretionary
  AMZN: "XLY", TSLA: "XLY",
  // Financials
  JPM: "XLF", BAC: "XLF",
  // Healthcare
  LLY: "XLV", UNH: "XLV",
  // Semis (alternate sector ETF if you prefer)
  // NVDA: "SMH"
};

const cache = new Map<string, string | null>();

export async function resolveSectorEtf(symbol: string): Promise<string | null> {
  const sym = symbol.toUpperCase();
  if (cache.has(sym)) return cache.get(sym)!;

  // 1) static map
  if (STATIC_MAP[sym]) {
    cache.set(sym, STATIC_MAP[sym]);
    return STATIC_MAP[sym];
  }

  // 2) optional external resolver (OFF by default)
  // If you later add an API key, you can switch this on.
  // Example: Financial Modeling Prep profile endpoint (requires key).
  const key = process.env.SECTOR_RESOLVER_KEY;
  if (!key) {
    cache.set(sym, null);
    return null;
  }

  const url = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(sym)}?apikey=${encodeURIComponent(
    key
  )}`;

  const sector = await fetchJson(url).then((arr) => (Array.isArray(arr) ? arr[0]?.sector : null)).catch(() => null);

  const etf = sectorToSpdrEtf(String(sector || ""));
  cache.set(sym, etf);
  return etf;
}

function sectorToSpdrEtf(sector: string): string | null {
  const s = sector.toLowerCase();
  if (s.includes("technology")) return "XLK";
  if (s.includes("communication")) return "XLC";
  if (s.includes("consumer cyclical") || s.includes("consumer discretionary")) return "XLY";
  if (s.includes("consumer defensive") || s.includes("consumer staples")) return "XLP";
  if (s.includes("financial")) return "XLF";
  if (s.includes("health")) return "XLV";
  if (s.includes("energy")) return "XLE";
  if (s.includes("industrial")) return "XLI";
  if (s.includes("utilities")) return "XLU";
  if (s.includes("materials")) return "XLB";
  if (s.includes("real estate")) return "XLRE";
  return null;
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}