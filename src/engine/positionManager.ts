import { Alert } from "./types";
import { ExecutionEngine } from "./executionEngine";
import { nyDayKey } from "../market/time";

export interface PositionManagerConfig {
  maxTradesPerDay: number;
  dailyLossLimitPct: number; // e.g. 0.05 = 5%
}

interface OpenPosition {
  contractSymbol: string;
  qty: number;
  entryMidPrice: number;
}

export class PositionManager {
  private openPositions = new Map<string, OpenPosition>(); // alertId → position
  private dailyTradesPlaced = 0;
  private dailyRealizedLoss = 0; // in dollars, always positive = loss
  private dailyLossLimitAbs = 0; // computed from equity at first trade of day
  private currentDayKey = "";

  constructor(
    private exec: ExecutionEngine,
    private cfg: PositionManagerConfig
  ) {}

  // -------------------------------------------------------
  // Daily reset
  // -------------------------------------------------------
  resetIfNewDay(nowMs: number): void {
    const key = nyDayKey(nowMs);
    if (key !== this.currentDayKey) {
      this.currentDayKey = key;
      this.dailyTradesPlaced = 0;
      this.dailyRealizedLoss = 0;
      this.dailyLossLimitAbs = 0;
      console.log(`[exec] New trading day: ${key} — daily counters reset`);
    }
  }

  // -------------------------------------------------------
  // Risk gate
  // -------------------------------------------------------
  canTrade(): boolean {
    if (this.dailyTradesPlaced >= this.cfg.maxTradesPerDay) {
      console.log(
        `[exec] Daily limit reached (${this.dailyTradesPlaced}/${this.cfg.maxTradesPerDay}) — no more trades today`
      );
      return false;
    }
    if (this.dailyLossLimitAbs > 0 && this.dailyRealizedLoss >= this.dailyLossLimitAbs) {
      console.log(
        `[exec] Daily loss limit hit ($${this.dailyRealizedLoss.toFixed(2)} >= $${this.dailyLossLimitAbs.toFixed(2)}) — no more trades today`
      );
      return false;
    }
    return true;
  }

  // -------------------------------------------------------
  // Open a position when a signal fires
  // -------------------------------------------------------
  async onSignal(alert: Alert, currentPrice: number): Promise<void> {
    if (!this.canTrade()) return;

    const dir = alert.dir === "CALL" ? "CALL" : alert.dir === "PUT" ? "PUT" : null;
    if (!dir) {
      console.warn(`[exec] Signal ${alert.id} has no direction — skipping`);
      return;
    }

    // Don't double-trade the same alert
    if (this.openPositions.has(alert.id)) {
      console.warn(`[exec] Alert ${alert.id} already has an open position — skipping`);
      return;
    }

    let equity: number;
    try {
      equity = await this.exec.getAccountEquity();
    } catch (e) {
      console.error("[exec] getAccountEquity failed:", e);
      return;
    }

    // Set daily loss limit on first trade of day (or if not yet set)
    if (this.dailyLossLimitAbs === 0) {
      this.dailyLossLimitAbs = equity * this.cfg.dailyLossLimitPct;
      console.log(`[exec] Daily loss limit set to $${this.dailyLossLimitAbs.toFixed(2)}`);
    }

    // Re-check after fresh equity
    if (this.dailyRealizedLoss >= this.dailyLossLimitAbs) {
      console.log("[exec] Daily loss limit hit — skipping trade");
      return;
    }

    const contract = await this.exec.findOptionContract(alert.symbol, dir, currentPrice);
    if (!contract) {
      console.warn(`[exec] No valid contract found for ${alert.symbol} ${dir} @ ${currentPrice}`);
      return;
    }

    const qty = this.exec.calculateQty(contract.midPrice, equity);

    let orderId: string;
    try {
      orderId = await this.exec.placeMarketBuy(contract.symbol, qty);
    } catch (e) {
      console.error(`[exec] placeMarketBuy failed for ${contract.symbol}:`, e);
      return;
    }

    this.openPositions.set(alert.id, {
      contractSymbol: contract.symbol,
      qty,
      entryMidPrice: contract.midPrice
    });
    this.dailyTradesPlaced++;

    console.log(
      `[exec] OPENED | alert=${alert.id} sym=${alert.symbol} dir=${dir} contract=${contract.symbol}` +
        ` qty=${qty} mid=$${contract.midPrice.toFixed(2)} orderId=${orderId}` +
        ` | trades today=${this.dailyTradesPlaced}/${this.cfg.maxTradesPerDay}`
    );
  }

  // -------------------------------------------------------
  // Close a position when the stop is hit
  // -------------------------------------------------------
  async onStopHit(alertId: string): Promise<void> {
    const pos = this.openPositions.get(alertId);
    if (!pos) return; // no open position for this alert

    try {
      await this.exec.closePosition(pos.contractSymbol);
    } catch (e) {
      console.error(`[exec] closePosition failed for ${pos.contractSymbol}:`, e);
      // Still remove from tracking so we don't keep retrying
    }

    // Record loss as max possible (premium paid) — we don't have real fill data in paper
    const lossDollars = pos.entryMidPrice * 100 * pos.qty;
    this.dailyRealizedLoss += lossDollars;
    this.openPositions.delete(alertId);

    console.log(
      `[exec] CLOSED (stop) | alert=${alertId} contract=${pos.contractSymbol}` +
        ` qty=${pos.qty} est_loss=$${lossDollars.toFixed(2)}` +
        ` | total daily loss=$${this.dailyRealizedLoss.toFixed(2)}`
    );
  }

  // -------------------------------------------------------
  // Accessors for logging / UI (optional)
  // -------------------------------------------------------
  getDailyStats() {
    return {
      tradesPlaced: this.dailyTradesPlaced,
      realizedLoss: this.dailyRealizedLoss,
      lossLimit: this.dailyLossLimitAbs,
      openCount: this.openPositions.size
    };
  }
}
