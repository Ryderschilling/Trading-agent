/**
 * Set up the retest-vs-chase A/B test.
 *
 * Run once, from the repo root, with the agent process STOPPED:
 *   npx ts-node scripts/setup-ab-test.ts            # dry run, prints the plan
 *   npx ts-node scripts/setup-ab-test.ts --apply    # writes to the database
 *
 * What it does:
 *   1. Backs up data/trading-agent.sqlite
 *   2. Deactivates v9 and inserts two active rulesets:
 *        v10  A - Retest   entryMode "retest",    0.40% stop, 2.0% target
 *        v11  B - Chase    entryMode "immediate", 1.00% stop, 2.5% target
 *      Both run no trailing stop, a 30-minute MFE gate and a 360-minute time
 *      exit, so the ONLY differences between them are the entry rule and the
 *      stop/target that entry implies.
 *   3. Turns on perStrategyGuards and lifts the account caps so the two
 *      strategies do not starve each other
 *   4. Expands the watchlist so the test reaches a decision faster
 *   5. Backfills outcomes.ruleset_version for existing rows
 *
 * Nothing here is destructive without --apply.
 */
import fs from "fs";
import net from "net";
import path from "path";
import Database from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const DB_PATH = process.env.DB_PATH || path.resolve("data/trading-agent.sqlite");

// ---------------------------------------------------------------- rulesets --
const SHARED_FILTERS = {
  session: "regular",
  universe: "watchlist",
  minVolume: null,
  minVolatilityPct: null,
  requireMarketBias: true,
  requireSpyQqqAlignment: true,
  requireVwapAgreement: true,
  requireRelativeStrength: true,
};

// Exits are identical across both arms except for the stop, which has to match
// the entry: entering AT the level supports a tight 0.40% stop, entering after
// the break is already ~0.85% past it and needs 1.0%.
const SHARED_RISK = {
  riskMode: "percent_account",
  riskValue: 1,
  stopMode: "percent",
  stopValueR: null,
  moveToBreakevenAtR: null,
  timeExitBars: 72, // 72 x 5m = 360 minutes
  maxOpenPositions: 3,
  trailActivatePct: 0, // 0 = explicitly off, and beats the TRAIL_* env vars
  trailDistancePct: 0,
  trailTightenPct: 0,
  trailTightenDistancePct: 0,
  mfeGateMinutes: 30,
  mfeGatePct: 0.05,
};

const RETEST = {
  version: 3,
  name: "A — Retest (v10)",
  description:
    "Break and retest as specified in STRATEGY.md. Waits for price to return to the broken level " +
    "within 0.2% before entering. 0.40% stop (sits just past the level), 2.0% target, no trailing stop.",
  setupType: "break_retest",
  timeframeMin: 5,
  direction: "both",
  setup: {
    levels: ["pmh", "pml", "vwap"],
    movingAverage: null,
    breakConfirmation: "wick_and_close",
    retestConfirmation: "reclaim_close",
    maxRetestBars: 12, // 60 minutes to retest before the setup is abandoned
    entryTrigger: "retest_close",
    entryMode: "retest",
    retestTolerancePct: 0.2,
  },
  filters: SHARED_FILTERS,
  risk: { ...SHARED_RISK, stopValuePct: 0.4, profitTargetR: 5 }, // 5R x 0.40% = 2.0%
  brokerCaps: { maxTradesPerDay: 4, maxCapital: null },
};

const CHASE = {
  version: 3,
  name: "B — Chase (v11)",
  description:
    "Breakout continuation. Enters on the first bar after the break, wherever price is. This is what " +
    "the retest tolerance bug produced by accident for 301 trades, kept as an explicit control arm. " +
    "1.0% stop (the entry is already well past the level), 2.5% target, no trailing stop.",
  setupType: "break_retest",
  timeframeMin: 5,
  direction: "both",
  setup: {
    levels: ["pmh", "pml", "vwap"],
    movingAverage: null,
    breakConfirmation: "wick_and_close",
    retestConfirmation: "reclaim_close",
    maxRetestBars: 12,
    entryTrigger: "retest_close",
    entryMode: "immediate",
    retestTolerancePct: 0.2,
  },
  filters: SHARED_FILTERS,
  risk: { ...SHARED_RISK, stopValuePct: 1.0, profitTargetR: 2.5 }, // 2.5R x 1.0% = 2.5%
  brokerCaps: { maxTradesPerDay: 4, maxCapital: null },
};

// --------------------------------------------------------------- watchlist --
// 10 -> 20. Liquid, high-volume names that actually build premarket structure.
// SPY and QQQ are the market-direction barometer and must stay.
const WATCHLIST: Array<[string, string | null]> = [
  ["SPY", null], ["QQQ", null], ["IWM", null],
  ["NVDA", "XLK"], ["AAPL", "XLK"], ["MSFT", "XLK"], ["AMD", "XLK"], ["AVGO", "XLK"],
  ["MU", "XLK"], ["SMCI", "XLK"], ["CRWD", "XLK"], ["PLTR", "XLK"],
  ["META", "XLC"], ["GOOGL", "XLC"], ["NFLX", "XLC"],
  ["AMZN", "XLY"], ["TSLA", "XLY"], ["UBER", "XLY"],
  ["HOOD", "XLF"], ["COIN", "XLF"],
];

// -------------------------------------------------- broker execution policy --
// Two strategies means roughly twice the orders. The old caps were sized for
// one: $25k of daily notional at $5k a position is five orders a day total,
// which is why "max daily notional reached" was the third most common skip.
const EXECUTION = {
  liveArmed: false,
  sizingMode: "notional",
  defaultNotional: 5000,
  defaultQty: 1,
  orderType: "market",
  timeInForce: "day",
  extendedHours: false,
  bracketEnabled: false,
  stopLossPct: null,
  takeProfitPct: null,
  maxDailyNotional: 120000,
  maxOpenPositions: 12,
  maxOrdersPerSymbolPerDay: 3,
  avoidExistingPosition: true,
  avoidOpenOrders: true,
  autoFlattenOrphans: false,
  maxEntriesPerMinute: 6,
  maxSameDirEntriesPer5Min: 8,
  perStrategyGuards: true,
};

/**
 * The agent has to be stopped before this runs. A live process holds its
 * watchlist, its runners and its broker policy in memory, so it would keep
 * trading the old config against a rewritten database until it restarts.
 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(700);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
}

/**
 * outcomes.ruleset_version is created by the migrations in src/db/db.ts, which
 * only run when the app boots. This script can legitimately run before the new
 * build has ever started, so it creates the column itself. Same statement, and
 * both are guarded, so whichever runs first wins and the other is a no-op.
 */
function ensureRulesetVersionColumn(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(outcomes)`).all() as any[];
  if (cols.some((c) => String(c.name) === "ruleset_version")) return;
  db.exec(`ALTER TABLE outcomes ADD COLUMN ruleset_version INTEGER;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_outcomes_ruleset ON outcomes(ruleset_version);`);
  console.log("added outcomes.ruleset_version");
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error(`database not found at ${DB_PATH}`);

  const port = Number(process.env.PORT || 3000);
  if (await portInUse(port)) {
    console.error("");
    console.error(`  The agent is still running on port ${port}.`);
    console.error("  Stop it first, or it will keep trading the old config from memory:");
    console.error("");
    console.error(`    kill $(lsof -ti tcp:${port})`);
    console.error("    pkill -f caffeinate");
    console.error("");
    console.error("  Then re-run this script.");
    process.exit(1);
  }

  console.log(`database   ${DB_PATH}`);
  console.log(`mode       ${APPLY ? "APPLY (writing)" : "DRY RUN (nothing will be written)"}`);
  console.log("");

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  const active = db.prepare(`SELECT version, name FROM rulesets WHERE active=1`).all() as any[];
  console.log(`currently active rulesets: ${active.map((r) => `v${r.version} ${r.name}`).join(", ") || "none"}`);

  const already = db
    .prepare(`SELECT version, name FROM rulesets WHERE name LIKE 'A — Retest%' OR name LIKE 'B — Chase%'`)
    .all() as any[];
  if (already.length) {
    console.log("");
    console.log(`the A/B rulesets already exist: ${already.map((r) => `v${r.version} ${r.name}`).join(", ")}`);
    console.log("nothing to do. delete or rename them first if you want a fresh pair.");
    db.close();
    return;
  }

  const maxVersion = Number(
    (db.prepare(`SELECT COALESCE(MAX(version),0) AS v FROM rulesets`).get() as any).v
  );
  const vRetest = Math.max(10, maxVersion + 1);
  const vChase = vRetest + 1;
  console.log(`will insert  v${vRetest} "${RETEST.name}"  and  v${vChase} "${CHASE.name}"`);
  console.log(`watchlist    ${WATCHLIST.length} symbols: ${WATCHLIST.map(([x]) => x).join(" ")}`);
  console.log(`execution    perStrategyGuards=true, maxDailyNotional=$${EXECUTION.maxDailyNotional}, maxOpenPositions=${EXECUTION.maxOpenPositions}`);
  console.log("");

  if (!APPLY) {
    console.log("dry run complete. re-run with --apply to write.");
    db.close();
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const backup = DB_PATH.replace(/\.sqlite$/, `.backup-ab-${stamp}.sqlite`);
  if (fs.existsSync(backup)) fs.unlinkSync(backup);
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`backup written to ${backup}`);

  // Must happen before the transaction: ALTER TABLE inside the same transaction
  // as the backfill is what blew up the first run.
  ensureRulesetVersionColumn(db);

  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE rulesets SET active=0 WHERE active=1`).run();

    const insert = db.prepare(
      `INSERT INTO rulesets(version, created_ts, name, active, config_json) VALUES(?,?,?,1,?)`
    );
    insert.run(vRetest, now, RETEST.name, JSON.stringify(RETEST));
    insert.run(vChase, now, CHASE.name, JSON.stringify(CHASE));

    try {
      const logChange = db.prepare(
        `INSERT INTO rule_changes(ts, version, action, payload) VALUES(?,?,?,?)`
      );
      logChange.run(now, vRetest, "created", JSON.stringify({ note: "A/B arm A - retest entry" }));
      logChange.run(now, vChase, "created", JSON.stringify({ note: "A/B arm B - chase entry (control)" }));
    } catch {
      // rule_changes shape varies across migrations; the audit line is optional
    }

    // watchlist. sector_etf is set from the static map in sectorResolver so the
    // sector-alignment filter has something to work with; updated_ts is NOT NULL.
    db.prepare(`DELETE FROM watchlist`).run();
    const addSymbol = db.prepare(
      `INSERT OR REPLACE INTO watchlist(symbol, sector_etf, updated_ts) VALUES(?,?,?)`
    );
    for (const [sym, etf] of WATCHLIST) addSymbol.run(sym, etf, now);

    // broker execution policy
    const row = db.prepare(`SELECT id, execution_json FROM broker_config WHERE broker_key='alpaca'`).get() as any;
    if (row) {
      const merged = { ...(row.execution_json ? JSON.parse(row.execution_json) : {}), ...EXECUTION };
      db.prepare(`UPDATE broker_config SET execution_json=? WHERE id=?`).run(JSON.stringify(merged), row.id);
    }

    // backfill ruleset_version on historical outcomes from the alert metadata
    const backfill = db.prepare(`
      UPDATE outcomes
      SET ruleset_version = (
        SELECT CAST(json_extract(a.meta_json, '$.rulesetVersion') AS INTEGER)
        FROM alerts a WHERE a.id = outcomes.alert_id
      )
      WHERE ruleset_version IS NULL
    `);
    const res = backfill.run();
    console.log(`backfilled ruleset_version on ${res.changes} historical outcome rows`);
    console.log(`activated v${vRetest} and v${vChase}; watchlist set to ${WATCHLIST.length} symbols`);
  });

  tx();
  db.close();

  console.log("");
  console.log("done. next steps:");
  console.log("  1. npm run build");
  console.log("  2. restart the process (./scripts/start-mac.sh) so both runners load");
  console.log("  3. watch the Compare page: /compare.html");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
