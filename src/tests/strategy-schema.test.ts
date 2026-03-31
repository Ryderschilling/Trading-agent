import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOutcomeExecRules,
  getStrategyBrokerControls,
  getStrategyEmaPeriods,
  getStrategyTimeframeMin,
  normalizeStrategyDefinition,
  strategyAllowsDirection,
} from "../rules/schema";

test("legacy nested rulesets migrate into the simplified two-setup schema", () => {
  const migrated = normalizeStrategyDefinition(
    {
      version: 2,
      general: {
        name: "Legacy MA",
        description: "Old builder payload",
        tradingStyle: "day",
        strategyCategory: "momentum",
        direction: "long_only",
        defaultTimeframeMin: 15,
      },
      entry: {
        operator: "AND",
        triggers: [{ id: "ma1", type: "moving_average_crossover", fastPeriod: 8, slowPeriod: 21, signal: "bullish_cross" }],
      },
      filters: {
        tradingHours: { mode: "regular", startTime: null, endTime: null },
        universe: "watchlist",
        minVolume: 1000000,
        minVolatilityPct: 0.8,
        lookbackWindowBars: 24,
        structureLookbackBars: 100,
        marketBias: { required: true, longMinScore: 60, shortMaxScore: 40 },
        sectorAlignment: true,
        indicators: {
          vwap: true,
          relativeStrength: true,
          volumeConfirmation: false,
          movingAverages: true,
          emaPeriods: [8, 21, 50],
          emaTrigger: "cross",
        },
      },
      exit: {
        profitTarget: { enabled: true, mode: "r_multiple", value: 3 },
        stopLoss: { enabled: true, mode: "r_multiple", value: 1 },
        trailingStop: {
          enabled: true,
          activationMode: "r_multiple",
          activationValue: 1,
          trailMode: "r_multiple",
          trailValue: 1,
          moveToBreakeven: true,
          moveToBreakevenAt: 1,
        },
        timeExit: { enabled: true, afterBars: 12, afterMinutes: null },
        positionReversal: { enabled: false, mode: "exit_only" },
        exitOnBiasFlip: false,
      },
      risk: {
        perTradeRisk: { mode: "percent_of_account", value: 0.75 },
        maxOpenPositions: 2,
      },
      broker: {
        maxTradesPerDay: 4,
        maxCapital: 12000,
      },
    },
    { name: "Legacy MA" }
  );

  assert.equal(migrated.version, 3);
  assert.equal(migrated.name, "Legacy MA");
  assert.equal(migrated.setupType, "ma_cross");
  assert.equal(migrated.timeframeMin, 15);
  assert.equal(migrated.direction, "long");
  assert.deepEqual(getStrategyEmaPeriods(migrated), [8, 21]);
  assert.deepEqual(getStrategyBrokerControls(migrated), { maxTradesPerDay: 4, maxCapital: 12000 });

  const execRules = buildOutcomeExecRules(migrated);
  assert.deepEqual(execRules, { stopR: 1, targetR: 3, moveStopToBEAtR: 1 });
});

test("current simplified strategies keep direction, timeframe, and broker caps intact", () => {
  const strategy = normalizeStrategyDefinition({
    version: 3,
    name: "PMH Retest",
    setupType: "break_retest",
    timeframeMin: 5,
    direction: "short",
    setup: {
      levels: ["pmh", "vwap"],
      movingAverage: null,
      breakConfirmation: "close_through",
      retestConfirmation: "close_hold",
      maxRetestBars: 4,
      entryTrigger: "retest_close",
    },
    filters: {
      session: "regular",
      universe: "watchlist",
      minVolume: 1500000,
      minVolatilityPct: 1.1,
      requireMarketBias: true,
      requireSpyQqqAlignment: false,
      requireVwapAgreement: true,
      requireRelativeStrength: true,
    },
    risk: {
      riskMode: "fixed_dollars",
      riskValue: 250,
      stopMode: "r_multiple",
      stopValueR: 1.2,
      profitTargetR: 2.5,
      moveToBreakevenAtR: 1,
      timeExitBars: 10,
      maxOpenPositions: 2,
    },
    brokerCaps: {
      maxTradesPerDay: 3,
      maxCapital: 9000,
    },
  });

  assert.equal(getStrategyTimeframeMin(strategy), 5);
  assert.deepEqual(getStrategyBrokerControls(strategy), { maxTradesPerDay: 3, maxCapital: 9000 });
  assert.equal(strategyAllowsDirection(strategy, "CALL"), false);
  assert.equal(strategyAllowsDirection(strategy, "PUT"), true);
  assert.equal(strategy.setupType, "break_retest");
});
