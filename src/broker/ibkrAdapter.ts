import https from "https";
import {
  BrokerAccountSnapshot,
  BrokerAdapter,
  BrokerOpenOrderSnapshot,
  BrokerPositionSnapshot,
  BrokerSubmitOrderRequest,
  BrokerSubmitOptionsOrderRequest,
  BrokerSubmitOrderResult,
} from "./types";

// IBKR Client Portal Gateway uses self-signed certs — rejectUnauthorized must be false
const INSECURE_AGENT = new https.Agent({ rejectUnauthorized: false });
const CONID_CACHE = new Map<string, number>();

function toNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ibkrRequest(args: {
  method: "GET" | "POST";
  baseUrl: string;
  path: string;
  body?: any;
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = args.body == null ? null : JSON.stringify(args.body);
    const url = new URL(args.path, args.baseUrl);

    const options: https.RequestOptions = {
      method: args.method,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: url.pathname + url.search,
      agent: INSECURE_AGENT,
      headers: {
        "Content-Type": "application/json",
        ...(payload ? { "Content-Length": String(Buffer.byteLength(payload)) } : {}),
      },
    };

    const req = https.request(options, (res) => {
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
          const err = new Error(
            `IBKR HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`
          ) as Error & { response?: any; statusCode?: number };
          err.response = parsed;
          err.statusCode = res.statusCode || 500;
          reject(err);
          return;
        }

        resolve(parsed);
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class IbkrAdapter implements BrokerAdapter {
  private baseUrl: string;
  private accountId: string;

  constructor(host: string, port: number, accountId: string) {
    this.baseUrl = `https://${host}:${port}`;
    this.accountId = accountId;
  }

  private async resolveAccountId(): Promise<string> {
    if (this.accountId) return this.accountId;
    const data = await ibkrRequest({ method: "GET", baseUrl: this.baseUrl, path: "/v1/api/iserver/accounts" });
    const accounts: string[] = Array.isArray(data?.accounts) ? data.accounts : [];
    if (!accounts.length) throw new Error("IBKR: no accounts found");
    this.accountId = accounts[0];
    return this.accountId;
  }

  private async resolveConid(symbol: string, secType = "STK"): Promise<number> {
    const cacheKey = `${this.baseUrl}:${symbol}`;
    const cached = secType === "STK" ? CONID_CACHE.get(cacheKey) : undefined;
    if (cached != null) return cached;

    const data = await ibkrRequest({
      method: "GET",
      baseUrl: this.baseUrl,
      path: `/v1/api/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}&secType=${encodeURIComponent(secType)}`,
    });

    const results: any[] = Array.isArray(data) ? data : [];
    const first = results[0];
    if (!first?.conid) throw new Error(`IBKR: could not resolve conid for ${symbol}`);

    const conid = Number(first.conid);
    if (secType === "STK") {
      CONID_CACHE.set(cacheKey, conid);
    }
    return conid;
  }

  async getStatus(): Promise<{
    account: BrokerAccountSnapshot;
    positions: BrokerPositionSnapshot[];
    orders: BrokerOpenOrderSnapshot[];
  }> {
    const accountId = await this.resolveAccountId();

    const [summary, rawPositions, rawOrders] = await Promise.all([
      ibkrRequest({ method: "GET", baseUrl: this.baseUrl, path: `/v1/api/portfolio/${accountId}/summary` }),
      ibkrRequest({ method: "GET", baseUrl: this.baseUrl, path: `/v1/api/portfolio/${accountId}/positions/0` }),
      ibkrRequest({ method: "GET", baseUrl: this.baseUrl, path: "/v1/api/iserver/account/orders" }),
    ]);

    const account: BrokerAccountSnapshot = {
      status: "ACTIVE",
      equity: toNumber(summary?.netliquidationvalue?.amount ?? summary?.NetLiquidation?.amount),
      cash: toNumber(summary?.totalcashvalue?.amount ?? summary?.TotalCashValue?.amount),
      buyingPower: toNumber(summary?.buyingpower?.amount ?? summary?.BuyingPower?.amount),
    };

    const positions: BrokerPositionSnapshot[] = Array.isArray(rawPositions)
      ? rawPositions.map((p: any) => ({
          symbol: String(p?.ticker || p?.contractDesc || ""),
          qty: toNumber(p?.position),
          avgEntryPrice: toNumber(p?.avgCost),
          marketValue: toNumber(p?.mktValue),
          unrealizedPl: toNumber(p?.unrealizedPnl),
          unrealizedPlPct: toNumber(p?.unrealizedPnlPercent),
          side: (p?.position ?? 0) >= 0 ? "long" : "short",
        }))
      : [];

    const orderList: any[] = Array.isArray(rawOrders?.orders) ? rawOrders.orders : [];
    const orders: BrokerOpenOrderSnapshot[] = orderList.map((o: any) => ({
      id: String(o?.orderId || o?.id || ""),
      clientOrderId: o?.cOID == null ? null : String(o.cOID),
      symbol: String(o?.ticker || o?.symbol || ""),
      side: o?.side == null ? null : String(o.side).toLowerCase(),
      qty: toNumber(o?.remainingQuantity ?? o?.quantity),
      notional: null,
      type: o?.orderType == null ? null : String(o.orderType),
      status: o?.status == null ? null : String(o.status),
      submittedAt: null,
    }));

    return { account, positions, orders };
  }

  async submitMarketOrder(input: BrokerSubmitOrderRequest): Promise<BrokerSubmitOrderResult> {
    const accountId = await this.resolveAccountId();
    const conid = await this.resolveConid(input.symbol);

    const orderBody = {
      orders: [
        {
          conid,
          secType: "STK",
          orderType: "MKT",
          side: input.side === "buy" ? "BUY" : "SELL",
          quantity: input.qty ?? 1,
          tif: "DAY",
          cOID: input.clientOrderId,
        },
      ],
    };

    let raw = await ibkrRequest({
      method: "POST",
      baseUrl: this.baseUrl,
      path: `/v1/api/iserver/account/${accountId}/orders`,
      body: orderBody,
    });

    // Handle IBKR "question" confirmation flow
    if (Array.isArray(raw) && raw[0]?.questions) {
      const replyId = String(raw[0].id || "");
      if (replyId) {
        raw = await ibkrRequest({
          method: "POST",
          baseUrl: this.baseUrl,
          path: `/v1/api/iserver/reply/${replyId}`,
          body: { confirmed: true },
        });
      }
    }

    const result = Array.isArray(raw) ? raw[0] : raw;
    return {
      brokerOrderId: result?.order_id != null ? String(result.order_id) : null,
      brokerStatus: result?.order_status != null ? String(result.order_status) : null,
      raw,
    };
  }

  async submitOptionsOrder(_input: BrokerSubmitOptionsOrderRequest): Promise<BrokerSubmitOrderResult> {
    throw new Error("IBKR options order submission not yet implemented — coming in next phase");
  }
}

export function getIbkrAdapter(cfg: {
  host: string;
  port: number;
  accountId: string;
}): BrokerAdapter {
  return new IbkrAdapter(cfg.host, cfg.port, cfg.accountId);
}
