import crypto from "crypto";
import Database from "better-sqlite3";
import { Alert } from "../engine/types";
import { nyDayKey } from "../market/time";
import {
  countBrokerOrdersForStrategyDay,
  countBrokerOrdersForSymbolDay,
  findLatestSuccessfulBrokerCheckTs,
  findSubmittedBrokerOrderBySetup,
  insertBrokerOrder,
  listBrokerOrders,
  loadBrokerConfig,
  sumSubmittedBrokerNotionalForDay,
  sumSubmittedBrokerNotionalForStrategyDay,
} from "../db/db";
import { AlpacaBrokerAdapter } from "./alpacaAdapter";
import { getIbkrAdapter } from "./ibkrAdapter";
import { normalizeBrokerConfig } from "./config";
import {
  BrokerActivityRow,
  BrokerAdapter,
  BrokerConfig,
  BrokerConnectionState,
  BrokerExecutionState,
  BrokerOrderRecord,
  BrokerSkipSummary,
  BrokerStatusSnapshot,
  BrokerStrategyCoverageSnapshot,
} from "./types";
import { getStrategyBrokerControls, normalizeStrategyDefinition, StrategyBrokerControls } from "../rules/schema";

function round(value: number | null): number | null {
  if (value == null) return null;
  return Number(value.toFixed(4));
}

function localStatus(error: any): "REJECTED" | "ERROR" {
  const code = Number(error?.statusCode || 0);
  return code >= 400 && code < 500 ? "REJECTED" : "ERROR";
}

function isUnauthorizedError(error: any): boolean {
  const code = Number(error?.statusCode || error?.response?.status || 0);
  const msg = String(error?.message || "").toLowerCase();
  return code === 401 || code === 403 || msg.includes("unauthorized") || msg.includes("forbidden");
}

export function buildSetupKey(alert: Alert): string {
  const strategyVersion = alert?.meta?.rulesetVersion != null ? Number(alert.meta.rulesetVersion) : 0;
  const raw = [
    String(alert.symbol || ""),
    String(alert.dir || ""),
    String(alert.level || ""),
    alert.levelPrice != null ? Number(alert.levelPrice).toFixed(4) : "na",
    alert.structureLevel != null ? Number(alert.structureLevel).toFixed(4) : "na",
    String(strategyVersion || 0),
  ].join("|");
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 20);
}

export function buildClientOrderId(dayKey: string, setupKey: string): string {
  return `ta-${dayKey.replace(/-/g, "")}-${setupKey}`.slice(0, 48);
}

type StrategyPolicyRow = {
  version: number;
  name: string;
  controls: StrategyBrokerControls;
};

function summarizeStrategyCoverage(rows: StrategyPolicyRow[]): BrokerStrategyCoverageSnapshot {
  const enabledStrategies = rows.length;
  const readyStrategies = rows.length;
  const disabledStrategies = 0;
  const missingPolicies = 0;

  let summary = "No enabled strategies are active.";
  if (enabledStrategies > 0) {
    summary = `${enabledStrategies} enabled strategies using the shared strategy schema`;
  }

  return {
    enabledStrategies,
    readyStrategies,
    disabledStrategies,
    missingPolicies,
    summary,
  };
}

export function buildConnectionState(args: {
  cfg: BrokerConfig;
  connected: boolean;
  statusText?: string | null;
  error?: any;
}): BrokerConnectionState {
  const statusText = String(args.statusText || "").trim();

  if (!args.cfg.brokerKey) {
    return {
      code: "disabled",
      label: "Disabled",
      reason: "No broker provider is configured.",
    };
  }

  const SUPPORTED_BROKERS = new Set(["alpaca", "ibkr"]);
  if (!SUPPORTED_BROKERS.has(args.cfg.brokerKey)) {
    return {
      code: "unsupported",
      label: "Unsupported",
      reason: "The configured broker provider is not supported in this execution pass.",
    };
  }

  if (args.cfg.mode === "disabled") {
    return {
      code: "disabled",
      label: "Disabled",
      reason: "Broker mode is disabled.",
    };
  }

  if (args.connected) {
    return {
      code: "connected",
      label: "Connected",
      reason: statusText || "Broker status check succeeded.",
    };
  }

  if (isUnauthorizedError(args.error)) {
    return {
      code: "unauthorized",
      label: "Unauthorized",
      reason: statusText || "Broker credentials were rejected.",
    };
  }

  return {
    code: "disconnected",
    label: "Disconnected",
    reason: statusText || "Broker status could not be refreshed.",
  };
}

export function buildExecutionState(args: {
  cfg: BrokerConfig;
  connectionState: BrokerConnectionState;
  strategyCoverage: BrokerStrategyCoverageSnapshot;
}): BrokerExecutionState {
  const { cfg, connectionState, strategyCoverage } = args;

  if (!cfg.brokerKey) {
    return {
      code: "blocked_other",
      label: "Blocked — No Broker",
      canSubmit: false,
      reason: "Configure a broker provider before execution can submit orders.",
    };
  }

  const SUPPORTED_BROKERS_EXEC = new Set(["alpaca", "ibkr"]);
  if (!SUPPORTED_BROKERS_EXEC.has(cfg.brokerKey)) {
    return {
      code: "blocked_other",
      label: "Blocked — Unsupported Broker",
      canSubmit: false,
      reason: "The configured broker provider does not support execution in this pass.",
    };
  }

  if (cfg.mode === "disabled") {
    return {
      code: "blocked_other",
      label: "Blocked — Broker Disabled",
      canSubmit: false,
      reason: "Broker mode is disabled.",
    };
  }

  if (connectionState.code !== "connected") {
    return {
      code: "blocked_other",
      label: "Blocked — Connection Required",
      canSubmit: false,
      reason: connectionState.reason || "Broker connection must be healthy before orders can submit.",
    };
  }

  if (!cfg.tradingEnabled) {
    return {
      code: "blocked_kill_switch",
      label: "Blocked — Kill Switch",
      canSubmit: false,
      reason: "Broker execution is disabled by the master kill switch.",
    };
  }

  if (cfg.mode === "live" && !cfg.execution.liveArmed) {
    return {
      code: "blocked_live_not_armed",
      label: "Blocked — Live Not Armed",
      canSubmit: false,
      reason: "Live broker mode is selected, but live execution is not armed.",
    };
  }

  if (strategyCoverage.enabledStrategies <= 0) {
    return {
      code: "blocked_other",
      label: "Blocked — No Active Strategy",
      canSubmit: false,
      reason: "Enable at least one strategy before expecting broker submissions.",
    };
  }

  if (cfg.mode === "live") {
    return {
      code: "ready_live",
      label: "Ready — Live",
      canSubmit: true,
      reason: "Broker connection, global safety checks, and at least one enabled strategy allow live submission.",
    };
  }

  return {
    code: "ready_paper",
    label: "Ready — Paper",
    canSubmit: true,
    reason: "Broker connection, global safety checks, and at least one enabled strategy allow paper submission.",
  };
}

function findLatestSkip(activity: BrokerActivityRow[]): BrokerSkipSummary {
  const row = activity.find((item) => String(item.status || "").toUpperCase() === "SKIPPED" && item.reason);
  if (!row || !row.reason) return null;
  return {
    ts: Number(row.ts),
    reason: String(row.reason),
    symbol: String(row.symbol || ""),
    strategyVersion: row.strategyVersion ?? null,
  };
}

function buildAdapter(cfg: BrokerConfig): BrokerAdapter {
  if (cfg.brokerKey === "alpaca") {
    const key = String(cfg.config?.key || "");
    const secret = String(cfg.config?.secret || "");
    return new AlpacaBrokerAdapter(cfg.mode, { key, secret });
  } else if (cfg.brokerKey === "ibkr") {
    const host = String(cfg.config?.host || "localhost");
    const port = Number(cfg.config?.port || 5000);
    const accountId = String(cfg.config?.accountId || "");
    return getIbkrAdapter({ host, port, accountId });
  }
  throw new Error("unsupported broker");
}

function makeActivity(args: Partial<BrokerOrderRecord> & Pick<BrokerOrderRecord, "dayKey" | "symbol" | "direction" | "setupKey">): BrokerOrderRecord {
  return {
    ts: Date.now(),
    alertId: args.alertId ?? null,
    dayKey: args.dayKey,
    symbol: args.symbol,
    direction: args.direction,
    optionType: args.optionType ?? null,
    setupKey: args.setupKey,
    brokerKey: args.brokerKey ?? "",
    mode: args.mode ?? "disabled",
    clientOrderId: args.clientOrderId ?? null,
    brokerOrderId: args.brokerOrderId ?? null,
    status: args.status ?? "SKIPPED",
    brokerStatus: args.brokerStatus ?? null,
    reason: args.reason ?? null,
    sizingMode: args.sizingMode ?? "notional",
    qty: args.qty ?? null,
    notional: args.notional ?? null,
    orderType: "market",
    timeInForce: "day",
    extendedHours: Boolean(args.extendedHours),
    bracketEnabled: Boolean(args.bracketEnabled),
    strategyVersion: args.strategyVersion ?? null,
    requestJson: args.requestJson ?? null,
    responseJson: args.responseJson ?? null,
  };
}

// Rolling window of recent SUBMITTED entries — used by the anti-cluster gate
// inside executeConfirmedAlert. Lives in-process; cleared on restart, which is
// fine because clusters only matter intraday.
type RecentSubmission = { ts: number; symbol: string; direction: "LONG" | "SHORT" };
const recentSubmissions: RecentSubmission[] = [];
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;

function pruneRecentSubmissions(now: number): void {
  while (recentSubmissions.length && now - recentSubmissions[0].ts > FIVE_MINUTES_MS) {
    recentSubmissions.shift();
  }
}

function countRecentSubmissions(now: number, withinMs: number, direction?: "LONG" | "SHORT"): number {
  let n = 0;
  for (let i = recentSubmissions.length - 1; i >= 0; i--) {
    const r = recentSubmissions[i];
    if (now - r.ts > withinMs) break;
    if (direction && r.direction !== direction) continue;
    n++;
  }
  return n;
}

export class BrokerExecutionService {
  constructor(private db: Database.Database) {}

  getActivity(limit = 25): BrokerActivityRow[] {
    return listBrokerOrders(this.db, limit);
  }

  /**
   * Returns the active broker policy. Useful for callers (e.g. the orphan
   * reconciler) that need to know flags like autoFlattenOrphans without
   * re-reading the DB themselves.
   */
  getPolicy() {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    return cfg.execution;
  }

  /**
   * Fetch live broker positions (used by the orphan reconciler). Returns an
   * empty array if the broker isn't configured or the status call fails — the
   * caller decides what to do with that.
   */
  async getLivePositions() {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    if (!cfg.brokerKey || cfg.mode === "disabled") return [];
    const adapter = buildAdapter(cfg);
    const status = await adapter.getStatus();
    return status.positions;
  }

  async closePosition(symbol: string): Promise<{ orderId: string; adapter: any } | null> {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    if (!cfg.brokerKey) throw new Error("no broker configured");
    if (cfg.mode === "disabled") throw new Error("broker mode disabled");
    const adapter = buildAdapter(cfg);
    if (!adapter.closePosition) throw new Error("broker does not support closePosition");
    const result = await adapter.closePosition(symbol);
    if (!result?.orderId) return null;
    return { orderId: result.orderId, adapter };
  }

  async setStopOrder(symbol: string, stopPrice: number, qty: number | null): Promise<any> {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    if (!cfg.brokerKey) throw new Error("no broker configured");
    if (cfg.mode === "disabled") throw new Error("broker mode disabled");
    const adapter = buildAdapter(cfg);
    if (!adapter.setStopOrder) throw new Error("broker does not support stop orders");
    return adapter.setStopOrder(symbol, stopPrice, qty);
  }

  /**
   * Poll the broker for filled_avg_price + filled_qty of a given order. Returns
   * null on timeout or if the order never filled. Used to capture broker-truth
   * entry/exit fills so the Outcomes page shows what actually happened at the
   * broker, not just the simulated price the OutcomeTracker computed.
   */
  async pollOrderFill(orderId: string, timeoutMs = 6000): Promise<{ price: number; qty: number | null } | null> {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    if (!cfg.brokerKey) return null;
    if (cfg.mode === "disabled") return null;
    let adapter: BrokerAdapter;
    try {
      adapter = buildAdapter(cfg);
    } catch {
      return null;
    }
    if (!adapter.pollFill) return null;
    const price = await adapter.pollFill(orderId, timeoutMs);
    if (price == null) return null;
    // Best-effort qty grab: the alpaca adapter's pollFill doesn't return qty,
    // so we re-fetch the order. If that fails we still return the price.
    let qty: number | null = null;
    try {
      const a: any = adapter as any;
      if (a?.getOrder) {
        const order = await a.getOrder(orderId);
        const q = Number(order?.filled_qty ?? order?.qty);
        if (Number.isFinite(q) && q > 0) qty = q;
      }
    } catch {
      qty = null;
    }
    return { price, qty };
  }

  private listEnabledStrategyPolicies(): StrategyPolicyRow[] {
    const rows = this.db
      .prepare(`SELECT version, name, config_json FROM rulesets WHERE active=1 ORDER BY version DESC`)
      .all() as any[];

    return rows.map((row) => {
      let cfg: any = {};
      try {
        cfg = JSON.parse(String(row?.config_json || "{}"));
      } catch {
        cfg = {};
      }
      const strategy = normalizeStrategyDefinition(cfg, { name: String(row?.name || `v${row?.version}`) });
      return {
        version: Number(row?.version || 0),
        name: String(row?.name || `v${row?.version}`),
        controls: getStrategyBrokerControls(strategy),
      };
    });
  }

  private loadStrategyPolicy(strategyVersion: number | null): StrategyPolicyRow | null {
    let row: any;
    if (strategyVersion != null && Number.isFinite(strategyVersion) && strategyVersion > 0) {
      row = this.db.prepare(`SELECT version, name, config_json FROM rulesets WHERE version=? LIMIT 1`).get(strategyVersion);
    } else {
      row = this.db.prepare(`SELECT version, name, config_json FROM rulesets WHERE active=1 ORDER BY version DESC LIMIT 1`).get();
    }
    if (!row) return null;

    let cfg: any = {};
    try {
      cfg = JSON.parse(String(row?.config_json || "{}"));
    } catch {
      cfg = {};
    }
    const strategy = normalizeStrategyDefinition(cfg, { name: String(row?.name || `v${row?.version}`) });
    return {
      version: Number(row?.version || 0),
      name: String(row?.name || `v${row?.version}`),
      controls: getStrategyBrokerControls(strategy),
    };
  }

  async getStatus(): Promise<BrokerStatusSnapshot> {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    const recentActivity = this.getActivity(12);
    const lastSuccessfulCheckTs = findLatestSuccessfulBrokerCheckTs(this.db);
    const strategyCoverage = summarizeStrategyCoverage(this.listEnabledStrategyPolicies());
    const initialConnectionState = buildConnectionState({ cfg, connected: false });
    const ignoredSettings: string[] = [];
    if (cfg.execution.extendedHours) ignoredSettings.push("extended hours is stored but not used for market orders in V1");
    if (cfg.execution.bracketEnabled) ignoredSettings.push("bracket orders are stored but not submitted in V1");

    const base: BrokerStatusSnapshot = {
      ok: false,
      provider: cfg.brokerKey || "none",
      mode: cfg.mode,
      configured: Boolean(cfg.brokerKey),
      supported: cfg.brokerKey === "" || cfg.brokerKey === "alpaca" || cfg.brokerKey === "ibkr",
      connectionStatus: initialConnectionState.code,
      connectionState: initialConnectionState,
      statusText: initialConnectionState.reason || (cfg.brokerKey ? "Not checked" : "No broker configured"),
      checkedAt: null,
      lastSuccessfulCheckTs,
      duplicateProtection: {
        active: true,
        strategy: "NY day + symbol + direction + level + strategy version",
      },
      account: null,
      positions: [],
      orders: [],
      execution: cfg.execution,
      globalSafety: {
        executionEnabled: cfg.tradingEnabled,
        killSwitchEnabled: !cfg.tradingEnabled,
        liveArmed: cfg.execution.liveArmed,
      },
      executionState: buildExecutionState({ cfg, connectionState: initialConnectionState, strategyCoverage }),
      strategyCoverage,
      lastSkip: findLatestSkip(recentActivity),
      recentActivity,
      warnings: [],
      ignoredSettings,
    };

    if (!cfg.brokerKey) {
      base.connectionStatus = "disabled";
      return base;
    }
    if (cfg.brokerKey !== "alpaca" && cfg.brokerKey !== "ibkr") {
      base.statusText = "Configured provider is not supported in this pass";
      base.warnings.push("Only Alpaca and IBKR are operational in this pass.");
      return base;
    }
    if (cfg.mode === "disabled") {
      base.connectionStatus = "disabled";
      base.statusText = "Broker mode disabled";
      return base;
    }

    try {
      const adapter = buildAdapter(cfg);
      const status = await adapter.getStatus();
      const connectionState = buildConnectionState({
        cfg,
        connected: true,
        statusText: status.account.status || "OK",
      });
      return {
        ...base,
        ok: true,
        connectionStatus: connectionState.code,
        connectionState,
        statusText: status.account.status || "OK",
        checkedAt: Date.now(),
        account: status.account,
        positions: status.positions,
        orders: status.orders,
        executionState: buildExecutionState({ cfg, connectionState, strategyCoverage }),
      };
    } catch (error: any) {
      const connectionState = buildConnectionState({
        cfg,
        connected: false,
        statusText: error?.message || "Status check failed",
        error,
      });
      return {
        ...base,
        connectionStatus: connectionState.code,
        connectionState,
        checkedAt: Date.now(),
        statusText: error?.message || "Status check failed",
        warnings: [...base.warnings, "Broker status could not be refreshed."],
        executionState: buildExecutionState({ cfg, connectionState, strategyCoverage }),
      };
    }
  }

  async executeConfirmedAlert(alert: Alert): Promise<BrokerOrderRecord> {
    const cfg = normalizeBrokerConfig(loadBrokerConfig(this.db));
    const dayKey = nyDayKey(alert.ts);
    const setupKey = buildSetupKey(alert);
    const clientOrderId = buildClientOrderId(dayKey, setupKey);
    const requestedStrategyVersion = alert?.meta?.rulesetVersion != null ? Number(alert.meta.rulesetVersion) : null;
    const strategyPolicyRow = this.loadStrategyPolicy(requestedStrategyVersion);
    const strategyVersion = strategyPolicyRow?.version ?? requestedStrategyVersion;
    const strategyControls = strategyPolicyRow?.controls ?? { maxTradesPerDay: null, maxCapital: null };
    const refPrice = Number(alert.close || 0);
    const side: "buy" | "sell" = alert.dir === "CALL" ? "buy" : "sell";
    const sizingMode = cfg.execution.sizingMode;
    const defaultNotional = sizingMode === "notional" ? cfg.execution.defaultNotional : null;
    const defaultQty = sizingMode === "qty" ? cfg.execution.defaultQty : null;
    let notional = defaultNotional != null ? round(defaultNotional) : defaultQty != null && refPrice > 0 ? round(defaultQty * refPrice) : null;
    let qty = defaultQty != null ? round(defaultQty) : null;

    // Alpaca does not allow fractional shorts. When we would otherwise submit a
    // short via notional sizing (which produces fractional shares), convert it
    // to floor(notional / refPrice) whole shares. If the resulting qty < 1, the
    // order is marked for SKIPPED below rather than letting the broker reject it
    // with HTTP 422 ("fractional orders cannot be sold short"), which is what
    // happened to every SHORT signal on 2026-05-15.
    let shortFractionalSkipReason: string | null = null;
    if (side === "sell" && qty == null && notional != null && refPrice > 0) {
      const wholeQty = Math.floor(notional / refPrice);
      if (wholeQty >= 1) {
        qty = wholeQty;
        notional = round(wholeQty * refPrice);
      } else {
        shortFractionalSkipReason = `notional $${notional} below 1-share price $${refPrice.toFixed(2)} — shorts require >=1 whole share (fractional shorts unsupported)`;
      }
    }

    const baseActivity = makeActivity({
      alertId: alert.id,
      dayKey,
      symbol: alert.symbol,
      direction: alert.dir === "CALL" ? "LONG" : "SHORT",
      setupKey,
      brokerKey: cfg.brokerKey,
      mode: cfg.mode,
      clientOrderId,
      sizingMode,
      qty,
      notional,
      extendedHours: cfg.execution.extendedHours,
      bracketEnabled: cfg.execution.bracketEnabled,
      strategyVersion,
      requestJson: {
        symbol: alert.symbol,
        side,
        orderType: "market",
        timeInForce: "day",
        sizingMode,
        qty,
        notional,
        strategyBrokerControls: {
          requestedStrategyVersion,
          resolvedStrategyVersion: strategyVersion,
          maxTradesPerDay: strategyControls.maxTradesPerDay,
          maxCapital: strategyControls.maxCapital,
        },
      },
    });

    // Anti-cluster reservation (Fix C, 2026-05-20). The cluster gate below
    // reserves a slot in `recentSubmissions` SYNCHRONOUSLY the instant its
    // checks pass — no await between check and reserve — so concurrent entries
    // firing in the same tick can't all pass a stale count. If the order then
    // fails to reach SUBMITTED for any reason, `persist` releases the slot.
    let clusterReservation: RecentSubmission | null = null;
    const releaseClusterReservation = () => {
      if (!clusterReservation) return;
      const i = recentSubmissions.indexOf(clusterReservation);
      if (i >= 0) recentSubmissions.splice(i, 1);
      clusterReservation = null;
    };

    const persist = (record: BrokerOrderRecord) => {
      // Any terminal record that isn't a live SUBMITTED order must give the
      // reserved cluster slot back.
      if (record.status !== "SUBMITTED") releaseClusterReservation();
      insertBrokerOrder(this.db, record);
      return record;
    };

    if (!cfg.brokerKey) return persist({ ...baseActivity, status: "SKIPPED", reason: "no broker configured" });
    if (cfg.brokerKey !== "alpaca" && cfg.brokerKey !== "ibkr") return persist({ ...baseActivity, status: "SKIPPED", reason: "broker provider unsupported" });
    if (cfg.mode === "disabled") return persist({ ...baseActivity, status: "SKIPPED", reason: "broker mode disabled" });
    if (!cfg.tradingEnabled) return persist({ ...baseActivity, status: "SKIPPED", reason: "kill switch enabled" });
    if (cfg.mode === "live" && !cfg.execution.liveArmed) return persist({ ...baseActivity, status: "SKIPPED", reason: "live mode not armed" });
    if (!strategyPolicyRow) return persist({ ...baseActivity, status: "SKIPPED", reason: "strategy unavailable" });

    if ((sizingMode === "notional" && !(defaultNotional && defaultNotional > 0)) || (sizingMode === "qty" && !(defaultQty && defaultQty > 0))) {
      return persist({ ...baseActivity, status: "SKIPPED", reason: "invalid default size" });
    }

    if (shortFractionalSkipReason) {
      return persist({ ...baseActivity, status: "SKIPPED", reason: shortFractionalSkipReason });
    }

    // ──────────────────────────────────────────────────────────────────────
    // MIN-RISK FILTER (Fix #1, wired 2026-05-17)
    //
    // Drops trades where the structure-based stop is too close to the entry
    // to survive normal noise. Across 4 days × 5 symbols of replay data,
    // every entry with 1R < 0.15% stopped out at 0.00% return — pure
    // wasted broker calls + slippage.
    //
    // Configured via MIN_RISK_PCT env var. Default 0.0015 (0.15%).
    // Set MIN_RISK_PCT=0 to disable.
    //
    // 1R is computed from alert.close (the 5-min close that produced the
    // signal) vs alert.structureLevel (the broken PMH/PML/PDH/PDL). The
    // real fill price is whatever the broker prints — alert.close is a
    // good-enough proxy for pre-trade risk sizing.
    // ──────────────────────────────────────────────────────────────────────
    const minRiskPctRaw = process.env.MIN_RISK_PCT;
    const minRiskPct = minRiskPctRaw == null || minRiskPctRaw === ""
      ? 0.0015
      : Number(minRiskPctRaw);
    if (Number.isFinite(minRiskPct) && minRiskPct > 0) {
      const structureLevel = Number(alert.structureLevel);
      const ref = Number(refPrice);
      if (Number.isFinite(structureLevel) && structureLevel !== 0 && Number.isFinite(ref) && ref > 0) {
        const oneRPct = Math.abs(ref - structureLevel) / Math.abs(ref);
        if (oneRPct < minRiskPct) {
          return persist({
            ...baseActivity,
            status: "SKIPPED",
            reason: `risk too tight: 1R=${(oneRPct * 100).toFixed(3)}% below MIN_RISK_PCT=${(minRiskPct * 100).toFixed(2)}%`,
          });
        }
      }
    }

    if (findSubmittedBrokerOrderBySetup(this.db, dayKey, setupKey)) {
      return persist({ ...baseActivity, status: "SKIPPED", reason: "duplicate setup blocked" });
    }

    // ──────────────────────────────────────────────────────────────────────
    // ANTI-CLUSTER GATE (Fix #5, wired 2026-05-19)
    //
    // 2026-05-19 fired 4 nearly-identical bearish PML-weak shorts in the same
    // minute (IWM, SPY, TSLA, GOOGL). All hit a reversal and stopped out for
    // a combined -$120. Strategy quality issue, but the broker layer should
    // also cap correlated-bunch risk.
    //
    //   - maxEntriesPerMinute: total entries across all symbols per 60s
    //   - maxSameDirEntriesPer5Min: directional concentration
    //
    // Either set to null disables the gate. Rolling window is in-process.
    // ──────────────────────────────────────────────────────────────────────
    const now = Date.now();
    pruneRecentSubmissions(now);
    const direction: "LONG" | "SHORT" = alert.dir === "CALL" ? "LONG" : "SHORT";

    // The check + reserve below is a single synchronous block. JS is
    // single-threaded, so no other executeConfirmedAlert call can interleave
    // between countRecentSubmissions() and recentSubmissions.push(). That makes
    // the gate race-free even when N entries fire in the same tick.
    if (cfg.execution.maxEntriesPerMinute != null) {
      const recentTotal = countRecentSubmissions(now, ONE_MINUTE_MS);
      if (recentTotal >= cfg.execution.maxEntriesPerMinute) {
        return persist({
          ...baseActivity,
          status: "SKIPPED",
          reason: `max entries per minute reached (${recentTotal}/${cfg.execution.maxEntriesPerMinute})`,
        });
      }
    }

    if (cfg.execution.maxSameDirEntriesPer5Min != null) {
      const recentSameDir = countRecentSubmissions(now, FIVE_MINUTES_MS, direction);
      if (recentSameDir >= cfg.execution.maxSameDirEntriesPer5Min) {
        return persist({
          ...baseActivity,
          status: "SKIPPED",
          reason: `max ${direction} entries per 5 min reached (${recentSameDir}/${cfg.execution.maxSameDirEntriesPer5Min})`,
        });
      }
    }

    // Gate passed — reserve the slot NOW, before any await. persist() releases
    // it if the order doesn't end up SUBMITTED.
    clusterReservation = { ts: now, symbol: alert.symbol, direction };
    recentSubmissions.push(clusterReservation);

    const ordersForSymbol = countBrokerOrdersForSymbolDay(this.db, dayKey, alert.symbol);
    if (cfg.execution.maxOrdersPerSymbolPerDay != null && ordersForSymbol >= cfg.execution.maxOrdersPerSymbolPerDay) {
      return persist({ ...baseActivity, status: "SKIPPED", reason: "max orders per symbol reached" });
    }
    const notionalUsed = sumSubmittedBrokerNotionalForDay(this.db, dayKey);
    if (cfg.execution.maxDailyNotional != null && notional != null && notionalUsed + notional > cfg.execution.maxDailyNotional) {
      return persist({ ...baseActivity, status: "SKIPPED", reason: "max daily notional reached" });
    }
    if (strategyVersion != null && strategyControls.maxTradesPerDay != null) {
      const strategyTradesForDay = countBrokerOrdersForStrategyDay(this.db, dayKey, strategyVersion);
      if (strategyTradesForDay >= strategyControls.maxTradesPerDay) {
        return persist({ ...baseActivity, status: "SKIPPED", reason: "strategy max trades per day reached" });
      }
    }
    if (strategyVersion != null && strategyControls.maxCapital != null && notional != null) {
      const strategyCapitalUsed = sumSubmittedBrokerNotionalForStrategyDay(this.db, dayKey, strategyVersion);
      if (strategyCapitalUsed + notional > strategyControls.maxCapital) {
        return persist({ ...baseActivity, status: "SKIPPED", reason: "strategy max capital reached" });
      }
    }

    let adapter: BrokerAdapter;
    try {
      adapter = buildAdapter(cfg);
    } catch (error: any) {
      return persist({ ...baseActivity, status: "ERROR", reason: error?.message || "adapter init failed" });
    }

    try {
      const status = await adapter.getStatus();
      if (cfg.execution.maxOpenPositions != null && status.positions.length >= cfg.execution.maxOpenPositions) {
        return persist({
          ...baseActivity,
          status: "SKIPPED",
          reason: "max open positions reached",
          responseJson: { positions: status.positions.length },
        });
      }

      if (cfg.execution.avoidExistingPosition && status.positions.some((row) => row.symbol === alert.symbol)) {
        return persist({ ...baseActivity, status: "SKIPPED", reason: "existing position on symbol" });
      }

      if (cfg.execution.avoidOpenOrders && status.orders.some((row) => row.symbol === alert.symbol)) {
        return persist({ ...baseActivity, status: "SKIPPED", reason: "existing open order on symbol" });
      }
    } catch (error: any) {
      return persist({ ...baseActivity, status: localStatus(error), reason: `preflight failed: ${error?.message || "unknown error"}` });
    }

    try {
      if (cfg.execution.bracketEnabled) {
        console.warn(
          "[broker] WARNING: bracketEnabled=true but bracket orders are not yet implemented. " +
          "Submitting plain market order instead. Implement bracket order logic before enabling in live mode."
        );
      }
    } catch (bracketErr: any) {
      console.warn("[broker] bracket check error (non-fatal):", bracketErr?.message || bracketErr);
    }

    try {
      const response = await adapter.submitMarketOrder({
        symbol: alert.symbol,
        side,
        clientOrderId,
        qty,
        notional: qty != null ? null : notional,
        extendedHours: false,
      });

      // SUBMITTED — the cluster reservation made at the gate stands (persist
      // only releases it on non-SUBMITTED outcomes).
      return persist({
        ...baseActivity,
        status: "SUBMITTED",
        brokerOrderId: response.brokerOrderId,
        brokerStatus: response.brokerStatus,
        responseJson: response.raw,
      });
    } catch (error: any) {
      return persist({
        ...baseActivity,
        status: localStatus(error),
        reason: error?.message || "submission failed",
        responseJson: error?.response ?? null,
      });
    }
  }
}
