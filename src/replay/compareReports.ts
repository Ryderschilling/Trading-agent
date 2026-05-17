// src/replay/compareReports.ts
//
// Diff two replay reports — same scenarios run before and after a code change.
// Produces a human-readable summary of what got better, what got worse, and
// which scenarios are now firing/silenced.

import fs from "fs";

import { ReplayReport, ScenarioResult } from "./types";

export type ReportDiff = {
  oldPath: string;
  newPath: string;
  totals: {
    alertsDelta: number;
    fillsDelta: number;
    brokerCallsDelta: number;
    errorsDelta: number;
    skippedLowRiskDelta: number;
    totalReturnPctOld: number;
    totalReturnPctNew: number;
    totalReturnPctDelta: number;
    winsOld: number;
    winsNew: number;
    lossesOld: number;
    lossesNew: number;
    flatOld: number; // 0% return — stop at entry
    flatNew: number;
  };
  perScenario: Array<{
    scenarioId: string;
    formingDelta: number;
    entryDelta: number;
    fillsDelta: number;
    skippedLowRiskDelta: number;
    returnPctOld: number;
    returnPctNew: number;
    returnPctDelta: number;
    status: "improved" | "regressed" | "unchanged" | "new" | "removed";
  }>;
};

function loadReport(p: string): ReplayReport {
  if (!fs.existsSync(p)) throw new Error(`report not found: ${p}`);
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw) as ReplayReport;
}

function totalReturnPct(scenario: ScenarioResult): number {
  return scenario.fills.reduce((acc, f) => acc + (f.retPct ?? 0), 0);
}

function classifyFill(retPct: number | null): "win" | "loss" | "flat" {
  if (retPct == null) return "flat";
  if (retPct > 0) return "win";
  if (retPct < 0) return "loss";
  return "flat";
}

function countOutcomes(scenarios: ScenarioResult[]) {
  let wins = 0;
  let losses = 0;
  let flat = 0;
  for (const s of scenarios) {
    for (const f of s.fills) {
      const k = classifyFill(f.retPct);
      if (k === "win") wins++;
      else if (k === "loss") losses++;
      else flat++;
    }
  }
  return { wins, losses, flat };
}

export function diffReports(oldPath: string, newPath: string): ReportDiff {
  const oldR = loadReport(oldPath);
  const newR = loadReport(newPath);

  const oldById = new Map(oldR.scenarioResults.map((s) => [s.scenarioId, s]));
  const newById = new Map(newR.scenarioResults.map((s) => [s.scenarioId, s]));
  const allIds = new Set<string>([...oldById.keys(), ...newById.keys()]);

  const perScenario: ReportDiff["perScenario"] = [];
  let totalReturnOld = 0;
  let totalReturnNew = 0;

  for (const id of allIds) {
    const o = oldById.get(id);
    const n = newById.get(id);
    const oRet = o ? totalReturnPct(o) : 0;
    const nRet = n ? totalReturnPct(n) : 0;
    totalReturnOld += oRet;
    totalReturnNew += nRet;

    let status: ReportDiff["perScenario"][number]["status"];
    const retSame = Math.abs(nRet - oRet) < 1e-6;
    const oFills = o?.fills.length ?? 0;
    const nFills = n?.fills.length ?? 0;
    if (!o) status = "new";
    else if (!n) status = "removed";
    else if (retSame && oFills === nFills) status = "unchanged";
    // fewer fills with the same return = avoided wasted broker calls = improvement
    else if (nRet > oRet || (retSame && nFills < oFills)) status = "improved";
    else status = "regressed";

    perScenario.push({
      scenarioId: id,
      formingDelta: (n?.observed.formingAlerts ?? 0) - (o?.observed.formingAlerts ?? 0),
      entryDelta: (n?.observed.entryAlerts ?? 0) - (o?.observed.entryAlerts ?? 0),
      fillsDelta: (n?.fills.length ?? 0) - (o?.fills.length ?? 0),
      skippedLowRiskDelta:
        (n?.observed.skippedLowRisk ?? 0) - (o?.observed.skippedLowRisk ?? 0),
      returnPctOld: oRet,
      returnPctNew: nRet,
      returnPctDelta: nRet - oRet,
      status,
    });
  }

  const oldOutcomes = countOutcomes(oldR.scenarioResults);
  const newOutcomes = countOutcomes(newR.scenarioResults);

  return {
    oldPath,
    newPath,
    totals: {
      alertsDelta: newR.totals.alerts - oldR.totals.alerts,
      fillsDelta: newR.totals.fills - oldR.totals.fills,
      brokerCallsDelta: newR.totals.brokerCalls - oldR.totals.brokerCalls,
      errorsDelta: newR.totals.errors - oldR.totals.errors,
      skippedLowRiskDelta:
        newR.scenarioResults.reduce((a, s) => a + (s.observed.skippedLowRisk ?? 0), 0) -
        oldR.scenarioResults.reduce((a, s) => a + (s.observed.skippedLowRisk ?? 0), 0),
      totalReturnPctOld: totalReturnOld,
      totalReturnPctNew: totalReturnNew,
      totalReturnPctDelta: totalReturnNew - totalReturnOld,
      winsOld: oldOutcomes.wins,
      winsNew: newOutcomes.wins,
      lossesOld: oldOutcomes.losses,
      lossesNew: newOutcomes.losses,
      flatOld: oldOutcomes.flat,
      flatNew: newOutcomes.flat,
    },
    perScenario,
  };
}

function fmtDelta(n: number, suffix = ""): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n}${suffix}`;
}

function fmtDeltaPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function printDiffSummary(diff: ReportDiff): void {
  const t = diff.totals;
  console.log("");
  console.log("─".repeat(78));
  console.log(` Diff: ${diff.newPath}`);
  console.log(`   vs: ${diff.oldPath}`);
  console.log("─".repeat(78));
  console.log(` alerts:           ${fmtDelta(t.alertsDelta)}`);
  console.log(` fills:            ${fmtDelta(t.fillsDelta)}`);
  console.log(` broker calls:     ${fmtDelta(t.brokerCallsDelta)}`);
  console.log(` skipped low-risk: ${fmtDelta(t.skippedLowRiskDelta)}`);
  console.log(` errors:           ${fmtDelta(t.errorsDelta)}`);
  console.log(
    ` outcomes: wins ${t.winsOld}→${t.winsNew} (${fmtDelta(t.winsNew - t.winsOld)}), ` +
      `losses ${t.lossesOld}→${t.lossesNew} (${fmtDelta(t.lossesNew - t.lossesOld)}), ` +
      `flat ${t.flatOld}→${t.flatNew} (${fmtDelta(t.flatNew - t.flatOld)})`
  );
  console.log(
    ` total return:     ${t.totalReturnPctOld.toFixed(2)}% → ${t.totalReturnPctNew.toFixed(2)}% (${fmtDeltaPct(t.totalReturnPctDelta)})`
  );
  console.log("─".repeat(78));

  const sorted = [...diff.perScenario].sort((a, b) => Math.abs(b.returnPctDelta) - Math.abs(a.returnPctDelta));
  for (const s of sorted) {
    const tag = s.status.toUpperCase().padEnd(9);
    console.log(
      ` [${tag}] ${s.scenarioId.padEnd(36)} ` +
        `fills ${fmtDelta(s.fillsDelta)}, ` +
        `entries ${fmtDelta(s.entryDelta)}, ` +
        `ret ${s.returnPctOld.toFixed(2)}%→${s.returnPctNew.toFixed(2)}% (${fmtDeltaPct(s.returnPctDelta)})`
    );
  }
  console.log("─".repeat(78));
}
