// src/replay/loadScenario.ts
//
// Load a Scenario JSON file from disk with shape validation. Permissive — if
// the file is missing `expect`, we treat it as an observational scenario.

import fs from "fs";
import path from "path";

import { ReplayBar1m, Scenario } from "./types";

function isBar(x: unknown): x is ReplayBar1m {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b.t === "number" &&
    typeof b.o === "number" &&
    typeof b.h === "number" &&
    typeof b.l === "number" &&
    typeof b.c === "number" &&
    typeof b.v === "number"
  );
}

export function loadScenarioFromFile(filePath: string): Scenario {
  if (!fs.existsSync(filePath)) {
    throw new Error(`scenario file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`scenario file is not valid JSON (${filePath}): ${e?.message || e}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`scenario file did not parse to an object: ${filePath}`);
  }
  if (typeof parsed.id !== "string" || !parsed.id) {
    throw new Error(`scenario missing string "id": ${filePath}`);
  }
  if (typeof parsed.testSymbol !== "string" || !parsed.testSymbol) {
    throw new Error(`scenario missing string "testSymbol": ${filePath}`);
  }
  if (typeof parsed.dayKey !== "string" || !parsed.dayKey) {
    throw new Error(`scenario missing string "dayKey": ${filePath}`);
  }
  if (!parsed.bars || typeof parsed.bars !== "object") {
    throw new Error(`scenario missing "bars" object: ${filePath}`);
  }

  const bars: Record<string, ReplayBar1m[]> = {};
  for (const [sym, list] of Object.entries(parsed.bars as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      throw new Error(`scenario.bars.${sym} is not an array (${filePath})`);
    }
    const cleaned: ReplayBar1m[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (!isBar(item)) {
        throw new Error(`scenario.bars.${sym}[${i}] is malformed (${filePath})`);
      }
      cleaned.push(item as ReplayBar1m);
    }
    cleaned.sort((a, b) => a.t - b.t);
    bars[sym] = cleaned;
  }

  return {
    id: String(parsed.id),
    name: typeof parsed.name === "string" ? parsed.name : parsed.id,
    description: typeof parsed.description === "string" ? parsed.description : "",
    testSymbol: String(parsed.testSymbol).toUpperCase(),
    dayKey: String(parsed.dayKey),
    bars,
    expect: parsed.expect && typeof parsed.expect === "object" ? parsed.expect : undefined,
  };
}

/** Load every *.json under a directory. */
export function loadScenarioDir(dir: string): Scenario[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
  return files.map((f) => loadScenarioFromFile(path.join(dir, f)));
}
