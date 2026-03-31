import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mergeSecretConfig, normalizeBrokerConfig } from "../broker/config";
import {
  BrokerExecutionService,
  buildClientOrderId,
  buildConnectionState,
  buildExecutionState,
  buildSetupKey
} from "../broker/service";
import { insertBrokerOrder, insertRuleset, migrateDb, saveBrokerConfig } from "../db/db";
import { SignalEngine } from "../engine/signalEngine";
import { Levels } from "../market/levels";
import { Bar5 } from "../market/marketDirection";

function makeLevels(overrides: Partial<Levels>): Levels {
  return {
    dayKey: "2026-03-23",
    pmh: null,
    pml: null,
    pdh: null,
    pdl: null,
    curRthHigh: null,
    curRthLow: null,
    lastUpdatedMs: Date.now(),
    ...overrides,
  };
}

function makeBars(closes: number[]): Bar5[] {
  return closes.map((close, idx) => ({
    t: 1_700_000_000_000 + idx * 300_000,
    o: close - 0.2,
    h: close + 0.2,
    l: close - 0.3,
    c: close,
  }));
}

test("mergeSecretConfig preserves masked and blank secret values", () => {
  const merged = mergeSecretConfig({
    existing: { key: "persist-me", secret: "persist-secret", accountId: "ABC" },
    next: { key: "********", secret: "", accountId: "XYZ" },
    secretKeys: ["key", "secret"],
  });

  assert.equal(merged.key, "persist-me");
  assert.equal(merged.secret, "persist-secret");
  assert.equal(merged.accountId, "XYZ");
});

test("setup keys and client order ids are deterministic", () => {
  const alert = {
    id: "a1",
    ts: 1_700_000_000_000,
    symbol: "AAPL",
    market: "BULLISH" as const,
    rs: "STRONG" as const,
    dir: "CALL" as const,
    level: "PMH" as const,
    levelPrice: 190.12,
    structureLevel: 190.12,
    close: 190.55,
    message: "A+ ENTRY (1m TAP)" as const,
    meta: { rulesetVersion: 7 },
  };

  const setupA = buildSetupKey(alert);
  const setupB = buildSetupKey(alert);
  assert.equal(setupA, setupB);
  assert.equal(buildClientOrderId("2026-03-23", setupA), buildClientOrderId("2026-03-23", setupB));
});

test("execution service records duplicate skips and failure isolation without throwing", async () => {
  const db = new Database(":memory:");
  migrateDb(db);

  saveBrokerConfig(db, {
    brokerKey: "alpaca",
    mode: "paper",
    config: { key: "", secret: "" },
    tradingEnabled: true,
    execution: {
      liveArmed: false,
      sizingMode: "notional",
      defaultNotional: 500,
      defaultQty: 1,
      extendedHours: false,
      bracketEnabled: false,
      maxDailyNotional: 5000,
      maxOpenPositions: 5,
      maxOrdersPerSymbolPerDay: 1,
    },
  });

  const duplicateRuleset = insertRuleset(db, "Duplicate Test Strategy", {
    timeframeMin: 5,
    retestTolerancePct: 0.15,
    rsWindowBars5m: 24,
    longMinBiasScore: 60,
    shortMaxBiasScore: 40,
    brokerExecution: {
      enabled: true,
      mode: "inherit",
      sizingMode: "inherit",
      allowLong: true,
      allowShort: true,
      sessionFilter: "inherit",
      duplicatePolicy: "inherit",
    },
  }) as { version: number };

  const service = new BrokerExecutionService(db);
  const alert = {
    id: "alert-1",
    ts: Date.parse("2026-03-23T14:35:00Z"),
    symbol: "MSFT",
    market: "BULLISH" as const,
    rs: "STRONG" as const,
    dir: "CALL" as const,
    level: "PMH" as const,
    levelPrice: 410,
    structureLevel: 410,
    close: 411,
    message: "A+ ENTRY (1m TAP)" as const,
    meta: { rulesetVersion: duplicateRuleset.version },
  };

  const first = await service.executeConfirmedAlert(alert);
  assert.notEqual(first.status, "SUBMITTED");
  assert.match(first.reason || "", /adapter init failed|preflight failed|credentials missing|unauthorized|forbidden|invalid/i);

  insertBrokerOrder(db, {
    ts: alert.ts,
    dayKey: "2026-03-23",
    alertId: alert.id,
    symbol: alert.symbol,
    direction: "CALL",
    setupKey: buildSetupKey(alert),
    brokerKey: "alpaca",
    mode: "paper",
    clientOrderId: "existing",
    brokerOrderId: "broker-1",
    status: "SUBMITTED",
    brokerStatus: "accepted",
    reason: null,
    sizingMode: "notional",
    qty: null,
    notional: 500,
    orderType: "market",
    timeInForce: "day",
    extendedHours: false,
    bracketEnabled: false,
    strategyVersion: duplicateRuleset.version,
    requestJson: null,
    responseJson: null,
  });

  const second = await service.executeConfirmedAlert(alert);
  assert.equal(second.status, "SKIPPED");
  assert.equal(second.reason, "duplicate setup blocked");
});

test("execution service uses strategy broker controls for skip reasons", async () => {
  const db = new Database(":memory:");
  migrateDb(db);

  saveBrokerConfig(db, {
    brokerKey: "alpaca",
    mode: "paper",
    config: { key: "", secret: "" },
    tradingEnabled: true,
    execution: {
      liveArmed: false,
      sizingMode: "notional",
      defaultNotional: 500,
      defaultQty: 1,
      extendedHours: false,
      bracketEnabled: false,
      maxDailyNotional: 5000,
      maxOpenPositions: 5,
      maxOrdersPerSymbolPerDay: 1,
    },
  });

  const cappedTrades = insertRuleset(db, "Capped Trades", {
    version: 2,
    general: {
      name: "Capped Trades",
      description: null,
      tradingStyle: "day",
      strategyCategory: "momentum",
      direction: "both",
      defaultTimeframeMin: 5,
    },
    entry: {
      operator: "AND",
      triggers: [{ id: "t1", type: "opening_range_breakout", rangeMinutes: 5, breakoutMode: "break_retest", bufferPct: 0.15 }],
    },
    filters: {
      tradingHours: { mode: "regular", startTime: null, endTime: null },
      universe: "watchlist",
      minVolume: null,
      minVolatilityPct: null,
      lookbackWindowBars: 24,
      structureLookbackBars: 100,
      marketBias: { required: true, longMinScore: 60, shortMaxScore: 40 },
      sectorAlignment: true,
      indicators: {
        vwap: true,
        relativeStrength: true,
        volumeConfirmation: false,
        movingAverages: false,
        emaPeriods: [],
        emaTrigger: "none",
      },
      fundamentals: { enabled: false, marketCapMin: null, earningsWithinDays: null, floatMin: null },
    },
    exit: {
      profitTarget: { enabled: true, mode: "r_multiple", value: 2 },
      stopLoss: { enabled: true, mode: "r_multiple", value: 1 },
      trailingStop: {
        enabled: false,
        activationMode: "r_multiple",
        activationValue: null,
        trailMode: "r_multiple",
        trailValue: null,
        moveToBreakeven: false,
        moveToBreakevenAt: null,
      },
      timeExit: { enabled: false, afterBars: null, afterMinutes: null },
      positionReversal: { enabled: false, mode: "exit_only" },
      exitOnBiasFlip: false,
    },
    risk: {
      perTradeRisk: { mode: "percent_of_account", value: 1 },
      maxOpenPositions: 2,
      pyramiding: false,
      maxPyramidEntries: 1,
      maxDrawdownPct: null,
    },
    broker: {
      maxTradesPerDay: 0,
      maxCapital: null,
    },
  }) as { version: number };

  const cappedCapital = insertRuleset(db, "Capped Capital", {
    version: 2,
    general: {
      name: "Capped Capital",
      description: null,
      tradingStyle: "day",
      strategyCategory: "momentum",
      direction: "both",
      defaultTimeframeMin: 5,
    },
    entry: {
      operator: "AND",
      triggers: [{ id: "t1", type: "opening_range_breakout", rangeMinutes: 5, breakoutMode: "break_retest", bufferPct: 0.15 }],
    },
    filters: {
      tradingHours: { mode: "regular", startTime: null, endTime: null },
      universe: "watchlist",
      minVolume: null,
      minVolatilityPct: null,
      lookbackWindowBars: 24,
      structureLookbackBars: 100,
      marketBias: { required: true, longMinScore: 60, shortMaxScore: 40 },
      sectorAlignment: true,
      indicators: {
        vwap: true,
        relativeStrength: true,
        volumeConfirmation: false,
        movingAverages: false,
        emaPeriods: [],
        emaTrigger: "none",
      },
      fundamentals: { enabled: false, marketCapMin: null, earningsWithinDays: null, floatMin: null },
    },
    exit: {
      profitTarget: { enabled: true, mode: "r_multiple", value: 2 },
      stopLoss: { enabled: true, mode: "r_multiple", value: 1 },
      trailingStop: {
        enabled: false,
        activationMode: "r_multiple",
        activationValue: null,
        trailMode: "r_multiple",
        trailValue: null,
        moveToBreakeven: false,
        moveToBreakevenAt: null,
      },
      timeExit: { enabled: false, afterBars: null, afterMinutes: null },
      positionReversal: { enabled: false, mode: "exit_only" },
      exitOnBiasFlip: false,
    },
    risk: {
      perTradeRisk: { mode: "percent_of_account", value: 1 },
      maxOpenPositions: 2,
      pyramiding: false,
      maxPyramidEntries: 1,
      maxDrawdownPct: null,
    },
    broker: {
      maxTradesPerDay: null,
      maxCapital: 400,
    },
  }) as { version: number };

  const service = new BrokerExecutionService(db);
  const baseAlert = {
    id: "alert-strategy-policy",
    ts: Date.parse("2026-03-23T14:35:00Z"),
    symbol: "NVDA",
    market: "BULLISH" as const,
    rs: "STRONG" as const,
    dir: "CALL" as const,
    level: "PMH" as const,
    levelPrice: 120,
    structureLevel: 120,
    close: 121,
    message: "A+ ENTRY (1m TAP)" as const,
  };

  const tradesResult = await service.executeConfirmedAlert({
    ...baseAlert,
    id: "alert-capped-trades",
    meta: { rulesetVersion: cappedTrades.version },
  });
  assert.equal(tradesResult.status, "SKIPPED");
  assert.equal(tradesResult.reason, "strategy max trades per day reached");

  const capitalResult = await service.executeConfirmedAlert({
    ...baseAlert,
    id: "alert-capped-capital",
    meta: { rulesetVersion: cappedCapital.version },
  });
  assert.equal(capitalResult.status, "SKIPPED");
  assert.equal(capitalResult.reason, "strategy max capital reached");
});

test("execution readiness separates connection and execution gates", () => {
  const cfg = normalizeBrokerConfig({
    brokerKey: "alpaca",
    mode: "paper",
    config: {},
    tradingEnabled: false,
    execution: {
      liveArmed: false,
      sizingMode: "notional",
      defaultNotional: 500,
      defaultQty: 1,
      extendedHours: false,
      bracketEnabled: false,
      maxDailyNotional: 5000,
      maxOpenPositions: 5,
      maxOrdersPerSymbolPerDay: 1,
    },
  });

  const connected = buildConnectionState({ cfg, connected: true, statusText: "ACTIVE" });
  const blocked = buildExecutionState({
    cfg,
    connectionState: connected,
    strategyCoverage: {
      enabledStrategies: 1,
      readyStrategies: 1,
      disabledStrategies: 0,
      missingPolicies: 0,
      summary: "1/1 strategies ready",
    },
  });
  assert.equal(blocked.code, "blocked_kill_switch");

  const readyCfg = normalizeBrokerConfig({
    ...cfg,
    tradingEnabled: true,
  });
  const blockedLive = buildExecutionState({
    cfg: normalizeBrokerConfig({
      ...readyCfg,
      mode: "live",
      execution: {
        ...readyCfg.execution,
        liveArmed: false,
      },
    }),
    connectionState: connected,
    strategyCoverage: {
      enabledStrategies: 1,
      readyStrategies: 1,
      disabledStrategies: 0,
      missingPolicies: 0,
      summary: "1/1 strategies ready",
    },
  });
  assert.equal(blockedLive.code, "blocked_live_not_armed");

  const ready = buildExecutionState({
    cfg: readyCfg,
    connectionState: connected,
    strategyCoverage: {
      enabledStrategies: 2,
      readyStrategies: 1,
      disabledStrategies: 1,
      missingPolicies: 0,
      summary: "1/2 strategies ready • 1 disabled",
    },
  });
  assert.equal(ready.code, "ready_paper");
  assert.equal(ready.canSubmit, true);
});

test("forming candidates stay separate for prebreak and retest states", () => {
  const engine = new SignalEngine({
    timeframeMin: 5,
    retestTolerancePct: 0.001,
    rsWindowBars5m: 3,
  });

  const spyBars = makeBars([100, 100.5, 101, 101.5]);
  const strongBars = makeBars([100, 101.5, 103, 104.8]);
  const breakBars = makeBars([100, 102, 104, 105.4]);

  engine.ensureSymbol("NVDA", makeLevels({ pmh: 105, pdh: 106 }));
  strongBars.forEach((bar) => engine.pushBar5("NVDA", bar));
  engine.evaluateSymbol({
    symbol: "NVDA",
    marketDir: "BULLISH",
    spyBars5: spyBars,
    symBars5: strongBars,
    symLevels: makeLevels({ pmh: 105, pdh: 106 }),
    nowTs: strongBars.at(-1)!.t,
  });

  const prebreak = engine.getFormingCandidates({ lastPrice: () => 104.8 }).find((row) => row.symbol === "NVDA");
  assert.equal(prebreak?.stage, "prebreak");
  assert.match(prebreak?.nextCatalyst || "", /5m close through/i);

  engine.ensureSymbol("AMD", makeLevels({ pmh: 105, pdh: 106 }));
  breakBars.forEach((bar) => engine.pushBar5("AMD", bar));
  const emitted = engine.evaluateSymbol({
    symbol: "AMD",
    marketDir: "BULLISH",
    spyBars5: spyBars,
    symBars5: breakBars,
    symLevels: makeLevels({ pmh: 105, pdh: 106 }),
    nowTs: breakBars.at(-1)!.t,
  });

  assert.equal(emitted?.message, "A+ SETUP FORMING — WAIT FOR RETEST");
  const retest = engine.getFormingCandidates({ lastPrice: (symbol) => (symbol === "AMD" ? 105.2 : 104.8) }).find((row) => row.symbol === "AMD");
  assert.equal(retest?.stage, "retest");
  assert.match((retest?.missingConditions || []).join(","), /retest/i);
});
