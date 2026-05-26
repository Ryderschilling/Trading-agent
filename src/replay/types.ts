// src/replay/types.ts
//
// Shared types for the replay harness. The harness drives the LIVE SignalEngine
// (src/engine/signalEngine.ts) with synthetic deterministic data, so any
// divergence between expected and actual behavior surfaces real bugs in the
// production path rather than the parallel backtestEngine.ts implementation.

import { Alert } from "../engine/types";

export type ReplayBar1m = {
  t: number; // epoch ms (UTC)
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type ReplayBarsBySymbol = Record<string, ReplayBar1m[]>;

/**
 * What we predict the SignalEngine should do for a given scenario.
 * - At least one FORMING alert and one ENTRY alert => scenario expects a full setup
 * - NO_FIRE => the engine should produce no entry alert (chop / neutral / failed)
 */
export type ReplayExpectation = {
  /** Whether the engine should emit at least one "A+ SETUP FORMING" alert. */
  expectFormingAlert: boolean;
  /** Whether the engine should emit at least one entry alert (tap or close-through). */
  expectEntryAlert: boolean;
  /** Optional expected direction. */
  expectedDir?: "CALL" | "PUT";
  /** Optional expected level that should be broken (PMH/PML/PDH/PDL). */
  expectedLevel?: "PMH" | "PML" | "PDH" | "PDL";
  /**
   * Optional expected exit reason from executionSim once an entry fires.
   * Useful to verify stop/target hit on the synthetic price action you laid out.
   */
  expectedExitReason?: "STOP" | "TARGET" | "EOD" | "NONE";
};

/**
 * One synthetic scenario = one trading day on one test symbol, plus SPY+QQQ.
 * The harness will drive bars in strict time order so SignalEngine sees the
 * market context (SPY/QQQ direction) before evaluating the test symbol.
 */
export type Scenario = {
  id: string;          // e.g. "clean_pmh_break_retest_long"
  name: string;        // human-readable
  description: string; // what this scenario tests
  testSymbol: string;  // synthetic ticker, e.g. "TEST_BULL"
  dayKey: string;      // YYYY-MM-DD (NY) — the synthetic trading day
  bars: ReplayBarsBySymbol; // 1m bars for testSymbol + "SPY" + "QQQ"
  /**
   * Optional. Present for hand-crafted synthetic scenarios where we know the
   * expected outcome. Omit for real-data captures — those are "observational":
   * they always pass unless an uncaught error happens.
   */
  expect?: ReplayExpectation;
};

export type ReplayAlert = {
  alert: Alert;
  scenarioId: string;
};

export type ReplayFill = {
  scenarioId: string;
  symbol: string;
  dir: "LONG" | "SHORT";
  entryTs: number;
  entryPrice: number;
  exitTs: number | null;
  exitPrice: number | null;
  exitReason: "STOP" | "TARGET" | "EOD" | "OPEN" | null;
  retPct: number | null;
  stopPrice: number;
  targetPrice: number;
};

export type ReplayBrokerCall = {
  scenarioId: string;
  ts: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number | null;
  notional: number | null;
  clientOrderId: string;
};

export type ReplayError = {
  scenarioId: string;
  phase:
    | "data-prep"
    | "engine-eval"
    | "engine-tap"
    | "execution-init"
    | "execution-bar"
    | "broker-submit"
    | "agent-review";
  ts: number | null;
  symbol: string | null;
  message: string;
  stack: string | null;
};

export type ScenarioResult = {
  scenarioId: string;
  name: string;
  testSymbol: string;
  pass: boolean;
  failures: string[]; // expectation mismatches in plain English
  alerts: ReplayAlert[];
  fills: ReplayFill[];
  brokerCalls: ReplayBrokerCall[];
  errors: ReplayError[];
  expect: ReplayExpectation | null;
  observed: {
    formingAlerts: number;
    entryAlerts: number;
    invalidatedAlerts: number;
    skippedLowRisk: number;       // entries dropped by min-1R filter
    firstDir: "CALL" | "PUT" | null;
    firstLevel: "PMH" | "PML" | "PDH" | "PDL" | null;
    finalExitReason: "STOP" | "TARGET" | "EOD" | "OPEN" | null;
  };
  skippedEntries: Array<{
    ts: number;
    symbol: string;
    dir: "CALL" | "PUT" | "—";
    entryPrice: number;
    structureLevel: number;
    oneRPct: number;
    reason: "low_risk";
  }>;
};

export type ReplayReport = {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  agentEnabled: boolean;
  agentReview: string | null;
  scenarioResults: ScenarioResult[];
  totals: {
    scenarios: number;
    passed: number;
    failed: number;
    alerts: number;
    fills: number;
    brokerCalls: number;
    errors: number;
  };
};

export type HarnessOptions = {
  /** Only run scenarios whose id matches this string (substring match). */
  scenarioFilter?: string;
  /** When true and OPENAI_API_KEY is set, call AiOperatorService for a post-run review. */
  enableAgentReview?: boolean;
  /**
   * Default order size for the mock broker. Production reads this from
   * BrokerExecutionPolicy, but Phase 1 of the replay harness uses a constant.
   */
  defaultNotional?: number;
  /** Console.log scenario-level progress lines as the harness runs. */
  verbose?: boolean;
  /**
   * Minimum 1R distance as a fraction of entry price. Entries with risk
   * windows below this threshold are skipped (they're guaranteed-stop-on-entry
   * trades — wasted broker calls in production).
   * Default 0.0015 = 0.15%. Set to 0 to disable.
   */
  minRiskPct?: number;
  /**
   * Enforce production time gates (default: true).
   *   - 1m tap entries only fire when isFirstHourNY(ts) is true
   *     AND isPastEntryCutoffNY(ts) is false
   *   - Open positions are force-closed at isPastEodFlattenNY(ts)
   *
   * Live trading enforces these in src/index.ts and the outcomeTracker.
   * Set this to false to see the engine's raw alerts without the gates —
   * useful for diagnosing why entries don't fire, but doesn't reflect
   * production behavior.
   */
  enforceLiveTimeGates?: boolean;
  /**
   * Enable the 4h trend regime filter (EMA9 vs SMA21 on 4h bars per symbol).
   * Default false. When true the harness preloads `preload4hDays` trading
   * days of 5m bars before each scenario so the filter has enough history.
   */
  trendFilter4h?: boolean;
  /**
   * Number of prior trading days of 5m bars to preload per symbol so the
   * 4h filter has a warm regime by the time the scenario starts. Default 21
   * (covers 21 4h bars worth of history × buffer). Ignored when
   * trendFilter4h is false.
   */
  preload4hDays?: number;
};
