// scripts/force-avoid-existing-position.ts
//
// One-off DB fix. Sets execution policy flags that should never be off in
// production:
//
//   - avoidExistingPosition: true   (prevents AMZN-style direction conflicts)
//   - avoidOpenOrders:       true   (prevents duplicate working-order pileups)
//
// Run with:
//   npx ts-node scripts/force-avoid-existing-position.ts
//   # or, after build:
//   node dist/scripts/force-avoid-existing-position.js
//
// Idempotent. Prints before/after and exits 0 on success, 1 on error.

import "dotenv/config";
import { openDb, loadBrokerConfig, saveBrokerConfig } from "../src/db/db";

function main() {
  const db = openDb();
  const before = loadBrokerConfig(db);

  console.log("[force-avoid] BEFORE:");
  console.log(`  avoidExistingPosition = ${before.execution.avoidExistingPosition}`);
  console.log(`  avoidOpenOrders       = ${before.execution.avoidOpenOrders}`);
  console.log(`  autoFlattenOrphans    = ${before.execution.autoFlattenOrphans}`);

  const nextExecution = {
    ...before.execution,
    avoidExistingPosition: true,
    avoidOpenOrders: true,
  };

  saveBrokerConfig(db, {
    brokerKey: before.brokerKey,
    mode: before.mode,
    config: before.config,
    execution: nextExecution,
    tradingEnabled: before.tradingEnabled,
  });

  const after = loadBrokerConfig(db);
  console.log("[force-avoid] AFTER:");
  console.log(`  avoidExistingPosition = ${after.execution.avoidExistingPosition}`);
  console.log(`  avoidOpenOrders       = ${after.execution.avoidOpenOrders}`);
  console.log(`  autoFlattenOrphans    = ${after.execution.autoFlattenOrphans}`);

  if (after.execution.avoidExistingPosition && after.execution.avoidOpenOrders) {
    console.log("[force-avoid] OK — flags pinned to true.");
    process.exit(0);
  } else {
    console.error("[force-avoid] FAILED — flags did not stick. Inspect broker_config table.");
    process.exit(1);
  }
}

try {
  main();
} catch (e: any) {
  console.error(`[force-avoid] error: ${e?.message || e}`);
  process.exit(1);
}
