export type ExecDirection = "CALL" | "PUT";

export interface OptionContract {
  symbol: string;
  strike: number;
  expiry: string;
  midPrice: number;
}

export interface ExecutionEngineConfig {
  baseUrl: string;
  key: string;
  secret: string;
  riskPct: number;
}

export class ExecutionEngine {
  constructor(private cfg: ExecutionEngineConfig) {}

  private headers() {
    return {
      "APCA-API-KEY-ID": this.cfg.key,
      "APCA-API-SECRET-KEY": this.cfg.secret,
      "Content-Type": "application/json"
    };
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers()
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${path} → ${res.status} ${body}`);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${path} → ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
  }

  private async del(path: string): Promise<void> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers()
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text().catch(() => "");
      throw new Error(`DELETE ${path} → ${res.status} ${text}`);
    }
  }

  // -------------------------------------------------------
  // Account
  // -------------------------------------------------------
  async getAccountEquity(): Promise<number> {
    const account = await this.get<{ equity: string }>("/v2/account");
    const equity = parseFloat(account.equity);
    if (!Number.isFinite(equity) || equity <= 0) throw new Error(`Invalid equity: ${account.equity}`);
    return equity;
  }

  // -------------------------------------------------------
  // Options contract selection
  // -------------------------------------------------------
  async findOptionContract(
    underlying: string,
    dir: ExecDirection,
    currentPrice: number
  ): Promise<OptionContract | null> {
    const today = new Date();
    // Build date range: today through 7 days out
    const todayStr = this.dateStr(today);
    const weekOut = new Date(today);
    weekOut.setDate(weekOut.getDate() + 7);
    const weekOutStr = this.dateStr(weekOut);

    const type = dir === "CALL" ? "call" : "put";
    const params = new URLSearchParams({
      underlying_symbols: underlying,
      type,
      status: "active",
      expiration_date_gte: todayStr,
      expiration_date_lte: weekOutStr,
      limit: "200"
    });

    let contracts: AlpacaOptionContract[] = [];
    try {
      const resp = await this.get<{ option_contracts: AlpacaOptionContract[] }>(
        `/v2/options/contracts?${params}`
      );
      contracts = resp.option_contracts ?? [];
    } catch (e) {
      console.error("[exec] findOptionContract fetch error:", e);
      return null;
    }

    if (!contracts.length) {
      console.warn(`[exec] No ${type} contracts found for ${underlying}`);
      return null;
    }

    // Prefer 0DTE (expiry == today), then nearest expiry
    const byExpiry = [...contracts].sort((a, b) => a.expiration_date.localeCompare(b.expiration_date));
    const earliest = byExpiry[0].expiration_date;
    const pool = byExpiry.filter((c) => c.expiration_date === earliest);

    // Among that expiry, pick strike closest to current price
    const best = pool.reduce((prev, cur) => {
      return Math.abs(parseFloat(cur.strike_price) - currentPrice) <
        Math.abs(parseFloat(prev.strike_price) - currentPrice)
        ? cur
        : prev;
    });

    // Get live mid price from snapshot
    const midPrice = await this.getOptionMidPrice(best.symbol);
    if (midPrice == null || midPrice <= 0) {
      console.warn(`[exec] No valid mid price for ${best.symbol}`);
      return null;
    }

    return {
      symbol: best.symbol,
      strike: parseFloat(best.strike_price),
      expiry: best.expiration_date,
      midPrice
    };
  }

  private async getOptionMidPrice(contractSymbol: string): Promise<number | null> {
    try {
      const snap = await this.get<{ snapshot: { latestQuote?: { ap: number; bp: number } } }>(
        `/v2/options/contracts/${encodeURIComponent(contractSymbol)}/snapshot`
      );
      const q = snap?.snapshot?.latestQuote;
      if (!q) return null;
      const mid = (q.ap + q.bp) / 2;
      return Number.isFinite(mid) && mid > 0 ? mid : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------
  // Order placement
  // -------------------------------------------------------
  calculateQty(midPrice: number, equity: number): number {
    const maxRisk = equity * this.cfg.riskPct;
    const qty = Math.floor(maxRisk / (midPrice * 100));
    return Math.max(1, qty);
  }

  async placeMarketBuy(contractSymbol: string, qty: number): Promise<string> {
    const order = await this.post<{ id: string }>("/v2/orders", {
      symbol: contractSymbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "day"
    });
    return order.id;
  }

  // -------------------------------------------------------
  // Position close
  // -------------------------------------------------------
  async closePosition(contractSymbol: string): Promise<void> {
    await this.del(`/v2/positions/${encodeURIComponent(contractSymbol)}`);
  }

  // -------------------------------------------------------
  // Helpers
  // -------------------------------------------------------
  private dateStr(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }
}

// Alpaca API response shape for option contracts
interface AlpacaOptionContract {
  symbol: string;
  strike_price: string;
  expiration_date: string;
  type: "call" | "put";
}
