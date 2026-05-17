// src/replay/index.ts
//
// CLI entry point for the replay harness.
//
// Three ways to invoke:
//
//   (1) Synthetic scenarios (hand-crafted unit tests for the engine):
//       npm run replay
//       npm run replay -- --scenario=clean_bull
//
//   (2) Real historical day from your Alpaca cache (or fresh fetch):
//       npm run replay -- --date=2026-05-16 --symbol=AAPL
//       npm run replay -- --date=2026-05-16 --symbol=AAPL,NVDA,TSLA
//
//   (3) Pre-captured scenario JSON files:
//       npm run replay -- --scenario-file=data/replay-scenarios/2026-05-16_AAPL.json
//
// Common flags:
//   --agent          — run an OpenAI critique pass at the end
//   --verbose / -v   — per-scenario progress lines
//   --quiet / -q     — one-line summary, CI-friendly
//   --out=DIR        — override report output directory
//
// Exit code 0 = all scenarios passed.
// Exit code 1 = at least one scenario failed.

import "dotenv/config"; // load Alpaca + OpenAI creds from .env if present

import fs from "fs";
import path from "path";

import { diffReports, printDiffSummary } from "./compareReports";
import { runReplay } from "./harness";
import { loadScenarioDir, loadScenarioFromFile } from "./loadScenario";
import { buildAllScenarios } from "./synthetic";
import { HarnessOptions, ReplayReport, Scenario } from "./types";
// captureDay is imported lazily because it depends on better-sqlite3 (a native
// module). JSON-mode and synthetic-mode runs should not require that binary,
// so importing captureDay only when --date is actually used keeps the harness
// portable across machines/CI.

type CliArgs = {
  scenario?: string;       // filter synthetic scenarios by id substring
  scenarioFile?: string;   // load a single Scenario JSON
  scenarioDir?: string;    // load every *.json in a directory
  date?: string;           // YYYY-MM-DD, real-data mode
  dateRange?: { from: string; to: string }; // YYYY-MM-DD..YYYY-MM-DD
  symbols?: string[];      // for --date / --date-range mode
  compareTo?: string;      // path to a prior report.json
  agent: boolean;
  verbose: boolean;
  quiet: boolean;
  reportDir: string;
};

function parseArgs(argv: string[]): CliArgs {
  let scenario: string | undefined;
  let scenarioFile: string | undefined;
  let scenarioDir: string | undefined;
  let date: string | undefined;
  let dateRange: { from: string; to: string } | undefined;
  let symbols: string[] | undefined;
  let compareTo: string | undefined;
  let agent = false;
  let verbose = false;
  let quiet = false;
  let reportDir = path.join(process.cwd(), "data", "replay-reports");

  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) scenario = arg.slice("--scenario=".length);
    else if (arg.startsWith("--scenario-file=")) scenarioFile = arg.slice("--scenario-file=".length);
    else if (arg.startsWith("--scenario-dir=")) scenarioDir = arg.slice("--scenario-dir=".length);
    else if (arg.startsWith("--date=")) date = arg.slice("--date=".length);
    else if (arg.startsWith("--date-range=")) {
      const raw = arg.slice("--date-range=".length);
      const parts = raw.split("..");
      if (parts.length !== 2) throw new Error(`bad --date-range (want YYYY-MM-DD..YYYY-MM-DD): ${raw}`);
      dateRange = { from: parts[0].trim(), to: parts[1].trim() };
    } else if (arg.startsWith("--symbol=")) {
      symbols = arg
        .slice("--symbol=".length)
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else if (arg.startsWith("--compare-to=")) compareTo = arg.slice("--compare-to=".length);
    else if (arg === "--agent" || arg === "--agent=on") agent = true;
    else if (arg === "--agent=off") agent = false;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (arg === "--quiet" || arg === "-q") quiet = true;
    else if (arg.startsWith("--out=")) reportDir = arg.slice("--out=".length);
  }

  return { scenario, scenarioFile, scenarioDir, date, dateRange, symbols, compareTo, agent, verbose, quiet, reportDir };
}

/** Expand "2026-05-01..2026-05-15" to weekday dates inclusive. */
function expandDateRange(from: string, to: string): string[] {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  if (!re.test(from) || !re.test(to)) throw new Error(`bad date in range: ${from}..${to}`);
  const start = new Date(`${from}T12:00:00Z`).getTime();
  const end = new Date(`${to}T12:00:00Z`).getTime();
  if (end < start) throw new Error(`date-range "to" is before "from"`);
  const out: string[] = [];
  for (let t = start; t <= end; t += 24 * 60 * 60_000) {
    const d = new Date(t);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow === 0 || dow === 6) continue;
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const da = String(d.getUTCDate()).padStart(2, "0");
    out.push(`${y}-${m}-${da}`);
  }
  return out;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

function printSummary(report: ReplayReport, quiet: boolean) {
  const { totals } = report;

  if (!quiet) {
    console.log("");
    console.log("─".repeat(78));
    console.log(" Replay Report");
    console.log("─".repeat(78));
    console.log(` duration:   ${report.durationMs} ms`);
    console.log(` scenarios:  ${totals.scenarios} (${totals.passed} pass / ${totals.failed} fail)`);
    console.log(` alerts:     ${totals.alerts}`);
    console.log(` fills:      ${totals.fills}`);
    console.log(` broker:     ${totals.brokerCalls}`);
    console.log(` errors:     ${totals.errors}`);
    console.log("─".repeat(78));

    for (const r of report.scenarioResults) {
      const tag = r.pass ? "PASS" : "FAIL";
      const obs = r.expect ? "expected" : "observational";
      console.log(` [${tag}] ${r.scenarioId} (${obs})`);
      console.log(`        ${r.name}`);
      console.log(
        `        observed: forming=${r.observed.formingAlerts} entry=${r.observed.entryAlerts} ` +
          `invalid=${r.observed.invalidatedAlerts} skipped=${r.observed.skippedLowRisk} ` +
          `dir=${r.observed.firstDir ?? "—"} level=${r.observed.firstLevel ?? "—"} ` +
          `exit=${r.observed.finalExitReason ?? "—"}`
      );
      if (r.fills.length) {
        for (const f of r.fills) {
          console.log(
            `        fill:     ${f.dir} ${f.symbol} @ ${f.entryPrice.toFixed(4)} → ` +
              `${f.exitPrice?.toFixed(4) ?? "—"} (${f.exitReason ?? "open"}, ret=${fmtPct(f.retPct)})`
          );
        }
      }
      if (!r.pass) {
        for (const fail of r.failures) console.log(`        ✗ ${fail}`);
        for (const err of r.errors) {
          console.log(`        ! [${err.phase}] ${err.symbol ?? "—"} @ ${err.ts ?? "—"}: ${err.message}`);
          if (err.stack) {
            const lines = err.stack.split("\n").slice(0, 4).map((l) => `          ${l}`).join("\n");
            console.log(lines);
          }
        }
      }
    }
    console.log("─".repeat(78));
  } else {
    console.log(
      `[replay] ${totals.passed}/${totals.scenarios} passed (${totals.errors} errors) in ${report.durationMs}ms`
    );
  }

  if (report.agentEnabled && report.agentReview) {
    console.log("");
    console.log(" Agent review");
    console.log("─".repeat(78));
    console.log(report.agentReview);
    console.log("─".repeat(78));
  }
}

function writeReport(report: ReplayReport, dir: string): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(report.startedAt)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const fname = path.join(dir, `replay-${stamp}.json`);
  fs.writeFileSync(fname, JSON.stringify(report, null, 2), "utf8");
  return fname;
}

async function resolveScenarios(args: CliArgs): Promise<Scenario[]> {
  // Mode 1: explicit scenario file
  if (args.scenarioFile) {
    const scenario = loadScenarioFromFile(args.scenarioFile);
    return [scenario];
  }

  // Mode 1b: scenario directory
  if (args.scenarioDir) {
    const list = loadScenarioDir(args.scenarioDir);
    return args.scenario ? list.filter((s) => s.id.includes(args.scenario!)) : list;
  }

  // Mode 2: capture from real date(s)
  if (args.date || args.dateRange) {
    if (!args.symbols || args.symbols.length === 0) {
      throw new Error("--date / --date-range requires --symbol=AAPL[,NVDA,TSLA,...]");
    }
    // Lazy import — pulls in better-sqlite3 only when needed.
    const { captureDay } = await import("./captureDay");
    const dates = args.dateRange
      ? expandDateRange(args.dateRange.from, args.dateRange.to)
      : [args.date!];

    const out: Scenario[] = [];
    for (const date of dates) {
      for (const sym of args.symbols) {
        try {
          const { scenario, jsonPath } = await captureDay({ date, testSymbol: sym });
          if (!args.quiet) console.log(`[replay] captured ${date} ${sym} → ${jsonPath ?? "(memory)"}`);
          out.push(scenario);
        } catch (e: any) {
          // Common case: market closed on the date (weekend / holiday).
          if (!args.quiet) console.warn(`[replay] skipped ${date} ${sym}: ${String(e?.message || e).split("\n")[0]}`);
        }
      }
    }
    return out;
  }

  // Mode 3: synthetic, optionally filtered
  const synthetic = buildAllScenarios();
  return args.scenario ? synthetic.filter((s) => s.id.includes(args.scenario!)) : synthetic;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let scenarios: Scenario[];
  try {
    scenarios = await resolveScenarios(args);
  } catch (e: any) {
    console.error(`[replay] could not resolve scenarios: ${String(e?.message || e)}`);
    process.exit(2);
  }

  if (scenarios.length === 0) {
    console.error(`[replay] no scenarios to run.`);
    process.exit(2);
  }

  const opts: HarnessOptions = {
    enableAgentReview: args.agent,
    verbose: args.verbose,
  };

  if (!args.quiet) {
    const modeLabel = args.scenarioFile
      ? "file"
      : args.date
        ? `date=${args.date} symbols=${(args.symbols ?? []).join(",")}`
        : args.scenario
          ? `synthetic filter="${args.scenario}"`
          : "synthetic (all)";
    console.log(`[replay] starting ${scenarios.length} scenarios (${modeLabel})${args.agent ? " — agent ON" : ""}`);
  }

  const report = await runReplay(scenarios, opts);
  const reportPath = writeReport(report, args.reportDir);
  printSummary(report, args.quiet);
  if (!args.quiet) console.log(` report written: ${reportPath}`);

  if (args.compareTo) {
    try {
      const diff = diffReports(args.compareTo, reportPath);
      printDiffSummary(diff);
    } catch (e: any) {
      console.error(`[replay] compare failed: ${String(e?.message || e)}`);
    }
  }

  process.exit(report.totals.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[replay] uncaught error:", e);
  process.exit(2);
});
