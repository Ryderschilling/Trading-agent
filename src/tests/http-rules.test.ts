import test from "node:test";
import assert from "node:assert/strict";
import { createHttpApp } from "../server/http";

type MockRes = {
  statusCode: number;
  body: any;
  status: (code: number) => MockRes;
  json: (payload: any) => MockRes;
};

function makeRes(): MockRes {
  return {
    statusCode: 200,
    body: null,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}

function getRouteHandler(app: any, path: string, method: string) {
  const layer = app._router.stack.find((entry: any) => entry.route?.path === path && entry.route?.methods?.[method]);
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.at(-1)?.handle;
}

test("rules save handler accepts the simplified two-setup payload", () => {
  let captured: any = null;
  const app = createHttpApp({
    publicDir: process.cwd(),
    getAlerts: () => [],
    getWatchlist: () => [],
    addSymbol: () => undefined,
    removeSymbol: () => undefined,
    httpGetJson: async () => ({}),
    saveRules: (name, config, changedBy) => {
      captured = { name, config, changedBy };
      return { version: 12 };
    },
  });

  const handler = getRouteHandler(app, "/api/rules", "post");
  const res = makeRes();

  handler(
    {
      body: {
        name: "Focused Builder",
        changedBy: "test",
        config: {
          version: 3,
          name: "Focused Builder",
          setupType: "break_retest",
          timeframeMin: 5,
          direction: "both",
          setup: {
            levels: ["pmh", "vwap"],
            movingAverage: null,
            breakConfirmation: "close_through",
            retestConfirmation: "reclaim_close",
            maxRetestBars: 3,
            entryTrigger: "retest_close",
          },
          filters: {
            session: "regular",
            universe: "watchlist",
            minVolume: 1000000,
            minVolatilityPct: 0.75,
            requireMarketBias: true,
            requireSpyQqqAlignment: true,
            requireVwapAgreement: true,
            requireRelativeStrength: true,
          },
          risk: {
            riskMode: "percent_account",
            riskValue: 1,
            stopMode: "structure_close",
            stopValueR: null,
            profitTargetR: 2,
            moveToBreakevenAtR: 1,
            timeExitBars: 20,
            maxOpenPositions: 3,
          },
          brokerCaps: { maxTradesPerDay: 4, maxCapital: 10000 },
        },
      },
      header: () => "",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(captured?.name, "Focused Builder");
  assert.equal(captured?.changedBy, "test");
  assert.equal(captured?.config?.setupType, "break_retest");
});

test("rules update handler forwards simplified MA cross strategies", () => {
  let captured: any = null;
  const app = createHttpApp({
    publicDir: process.cwd(),
    getAlerts: () => [],
    getWatchlist: () => [],
    addSymbol: () => undefined,
    removeSymbol: () => undefined,
    httpGetJson: async () => ({}),
    updateRuleset: (version, name, config, changedBy) => {
      captured = { version, name, config, changedBy };
      return { ok: true };
    },
  });

  const handler = getRouteHandler(app, "/api/rulesets/:version/update", "post");
  const res = makeRes();

  handler(
    {
      params: { version: "7" },
      body: {
        name: "MA Pullback",
        changedBy: "test",
        config: {
          version: 3,
          name: "MA Pullback",
          setupType: "ma_cross",
          timeframeMin: 15,
          direction: "long",
          setup: {
            maType: "EMA",
            fastValue: 9,
            slowValue: 21,
            entryReference: "cross_zone_pullback",
            requireCloseAfterCross: true,
            requireRetest: true,
            maxEntryBarsAfterCross: 4,
            requireVwapAgreement: true,
          },
          filters: {
            session: "regular",
            universe: "watchlist",
            minVolume: 1500000,
            minVolatilityPct: 1.0,
            requireMarketBias: true,
            requireSpyQqqAlignment: true,
            requireVwapAgreement: true,
            requireRelativeStrength: true,
          },
          risk: {
            riskMode: "fixed_dollars",
            riskValue: 300,
            stopMode: "ma_fail_close",
            stopValueR: null,
            profitTargetR: 2.5,
            moveToBreakevenAtR: 1,
            timeExitBars: 12,
            maxOpenPositions: 2,
          },
          brokerCaps: { maxTradesPerDay: 2, maxCapital: 15000 },
        },
      },
      header: () => "",
    },
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body?.ok, true);
  assert.equal(captured?.version, 7);
  assert.equal(captured?.name, "MA Pullback");
  assert.equal(captured?.config?.setupType, "ma_cross");
});
