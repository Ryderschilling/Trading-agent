import https from "https";
import {
  BrokerAccountSnapshot,
  BrokerAdapter,
  BrokerMode,
  BrokerOpenOrderSnapshot,
  BrokerPositionSnapshot,
  BrokerSubmitOrderRequest,
  BrokerSubmitOrderResult,
} from "./types";

type AlpacaCredentials = {
  key: string;
  secret: string;
};

function toNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function baseUrlForMode(mode: BrokerMode) {
  return mode === "live" ? "https://api.alpaca.markets" : "https://paper-api.alpaca.markets";
}

function requestJson(args: {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: any;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = args.body == null ? null : JSON.stringify(args.body);
    const req = https.request(
      args.url,
      {
        method: args.method,
        headers: {
          ...args.headers,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: any = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }

          if ((res.statusCode || 0) >= 400) {
            const error = new Error(
              typeof parsed === "string"
                ? `HTTP ${res.statusCode}: ${parsed.slice(0, 300)}`
                : `HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`
            ) as Error & { response?: any; statusCode?: number };
            error.response = parsed;
            error.statusCode = res.statusCode || 500;
            reject(error);
            return;
          }

          resolve(parsed);
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class AlpacaBrokerAdapter implements BrokerAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(mode: BrokerMode, credentials: AlpacaCredentials) {
    if (!credentials.key || !credentials.secret) {
      throw new Error("alpaca credentials missing");
    }

    this.baseUrl = baseUrlForMode(mode);
    this.headers = {
      "APCA-API-KEY-ID": credentials.key,
      "APCA-API-SECRET-KEY": credentials.secret,
    };
  }

  async getStatus(): Promise<{
    account: BrokerAccountSnapshot;
    positions: BrokerPositionSnapshot[];
    orders: BrokerOpenOrderSnapshot[];
  }> {
    const [account, positions, orders] = await Promise.all([
      requestJson({ method: "GET", url: `${this.baseUrl}/v2/account`, headers: this.headers }),
      requestJson({ method: "GET", url: `${this.baseUrl}/v2/positions`, headers: this.headers }),
      requestJson({ method: "GET", url: `${this.baseUrl}/v2/orders?status=open&limit=50&nested=false&direction=desc`, headers: this.headers }),
    ]);

    return {
      account: {
        status: String(account?.status || "UNKNOWN"),
        equity: toNumber(account?.equity),
        cash: toNumber(account?.cash),
        buyingPower: toNumber(account?.buying_power),
      },
      positions: Array.isArray(positions)
        ? positions.map((row: any) => ({
            symbol: String(row?.symbol || ""),
            qty: toNumber(row?.qty),
            avgEntryPrice: toNumber(row?.avg_entry_price),
            marketValue: toNumber(row?.market_value),
            unrealizedPl: toNumber(row?.unrealized_pl),
            unrealizedPlPct: toNumber(row?.unrealized_plpc),
            side: row?.side == null ? null : String(row.side),
          }))
        : [],
      orders: Array.isArray(orders)
        ? orders.map((row: any) => ({
            id: String(row?.id || ""),
            clientOrderId: row?.client_order_id == null ? null : String(row.client_order_id),
            symbol: String(row?.symbol || ""),
            side: row?.side == null ? null : String(row.side),
            qty: toNumber(row?.qty),
            notional: toNumber(row?.notional),
            type: row?.type == null ? null : String(row.type),
            status: row?.status == null ? null : String(row.status),
            submittedAt: row?.submitted_at == null ? null : String(row.submitted_at),
          }))
        : [],
    };
  }

  async submitMarketOrder(input: BrokerSubmitOrderRequest): Promise<BrokerSubmitOrderResult> {
    const body: Record<string, unknown> = {
      symbol: input.symbol,
      side: input.side,
      type: "market",
      time_in_force: "day",
      client_order_id: input.clientOrderId,
    };

    if (input.qty != null) body.qty = String(input.qty);
    if (input.notional != null) body.notional = String(input.notional);

    const raw = await requestJson({
      method: "POST",
      url: `${this.baseUrl}/v2/orders`,
      headers: this.headers,
      body,
    });

    return {
      brokerOrderId: raw?.id == null ? null : String(raw.id),
      brokerStatus: raw?.status == null ? null : String(raw.status),
      raw,
    };
  }
}
