// src/replay/mockBroker.ts
//
// In-memory broker for the replay harness. Implements the BrokerAdapter
// interface so it can be dropped into BrokerExecutionService in Phase 2
// without further changes.
//
// Behavior:
//   - submitMarketOrder() always succeeds, logs the call, and returns an
//     immediately-filled response keyed by clientOrderId.
//   - Positions are tracked in memory keyed by symbol; one position per
//     symbol max (matches the live engine's one-open-trade-per-symbol model).
//   - getStatus() returns the in-memory snapshot.
//   - There is no network call. Ever.

import {
  BrokerAccountSnapshot,
  BrokerAdapter,
  BrokerOpenOrderSnapshot,
  BrokerPositionSnapshot,
  BrokerSubmitOrderRequest,
  BrokerSubmitOrderResult,
} from "../broker/types";
import { ReplayBrokerCall } from "./types";

export type MockBrokerOptions = {
  startingEquity?: number;
  /** Tag every captured call with the scenarioId currently being replayed. */
  scenarioIdAccessor: () => string;
  /**
   * The harness sets this before each submitMarketOrder call so the mock can
   * record the fill timestamp. Defaults to Date.now() if unset.
   */
  currentBarTsAccessor?: () => number | null;
  /**
   * Resolve a fair fill price for a given symbol at the current bar. The
   * harness wires this to "next bar's open" (the realistic assumption used by
   * the existing backtestEngine as well).
   */
  fillPriceResolver: (symbol: string) => number | null;
};

export class MockBroker implements BrokerAdapter {
  private equity: number;
  private positions = new Map<string, BrokerPositionSnapshot>();
  private fills: Array<{
    clientOrderId: string;
    brokerOrderId: string;
    symbol: string;
    side: "buy" | "sell";
    qty: number | null;
    notional: number | null;
    fillPrice: number;
    ts: number;
  }> = [];
  private calls: ReplayBrokerCall[] = [];
  private nextBrokerId = 1;

  constructor(private opts: MockBrokerOptions) {
    this.equity = opts.startingEquity ?? 100_000;
  }

  getCalls(): ReplayBrokerCall[] {
    return this.calls.slice();
  }

  reset() {
    this.positions.clear();
    this.fills = [];
    this.calls = [];
    this.nextBrokerId = 1;
  }

  // BrokerAdapter -----------------------------------------------------------

  async getStatus(): Promise<{
    account: BrokerAccountSnapshot;
    positions: BrokerPositionSnapshot[];
    orders: BrokerOpenOrderSnapshot[];
  }> {
    return {
      account: {
        status: "ACTIVE",
        equity: this.equity,
        cash: this.equity,
        buyingPower: this.equity * 2,
      },
      positions: Array.from(this.positions.values()),
      orders: [],
    };
  }

  async submitMarketOrder(input: BrokerSubmitOrderRequest): Promise<BrokerSubmitOrderResult> {
    const ts = this.opts.currentBarTsAccessor?.() ?? Date.now();
    const fillPrice = this.opts.fillPriceResolver(input.symbol);

    this.calls.push({
      scenarioId: this.opts.scenarioIdAccessor(),
      ts,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      notional: input.notional,
      clientOrderId: input.clientOrderId,
    });

    if (fillPrice == null || !Number.isFinite(fillPrice) || fillPrice <= 0) {
      throw Object.assign(new Error(`MockBroker: no fill price available for ${input.symbol}`), {
        statusCode: 500,
      });
    }

    const brokerOrderId = `mock-${this.nextBrokerId++}`;
    const qty = input.qty ?? (input.notional != null ? input.notional / fillPrice : 0);

    // update in-memory position (long for buy, short for sell)
    const direction = input.side === "buy" ? 1 : -1;
    const existing = this.positions.get(input.symbol);
    if (existing && Number.isFinite(existing.qty ?? 0)) {
      // simple netting — matches Alpaca paper behavior closely enough for replay
      const oldQty = Number(existing.qty || 0);
      const newQty = oldQty + direction * qty;
      if (Math.abs(newQty) < 1e-9) {
        this.positions.delete(input.symbol);
      } else {
        this.positions.set(input.symbol, {
          symbol: input.symbol,
          qty: newQty,
          avgEntryPrice: fillPrice,
          marketValue: newQty * fillPrice,
          unrealizedPl: 0,
          unrealizedPlPct: 0,
          side: newQty > 0 ? "long" : "short",
        });
      }
    } else {
      const signed = direction * qty;
      this.positions.set(input.symbol, {
        symbol: input.symbol,
        qty: signed,
        avgEntryPrice: fillPrice,
        marketValue: signed * fillPrice,
        unrealizedPl: 0,
        unrealizedPlPct: 0,
        side: signed > 0 ? "long" : "short",
      });
    }

    this.fills.push({
      clientOrderId: input.clientOrderId,
      brokerOrderId,
      symbol: input.symbol,
      side: input.side,
      qty,
      notional: input.notional,
      fillPrice,
      ts,
    });

    return {
      brokerOrderId,
      brokerStatus: "filled",
      raw: {
        mock: true,
        clientOrderId: input.clientOrderId,
        fillPrice,
        qty,
        side: input.side,
        ts,
      },
    };
  }

  async closePosition(symbol: string): Promise<{ orderId: string } | null> {
    const pos = this.positions.get(symbol);
    if (!pos || !Number.isFinite(pos.qty ?? 0) || (pos.qty ?? 0) === 0) return null;
    const orderId = `mock-close-${this.nextBrokerId++}`;
    this.positions.delete(symbol);
    return { orderId };
  }
}
