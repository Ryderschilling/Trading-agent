import { normalizeStrategyDefinition, StrategyDefinition } from "./schema";

export type NormalizedRulesetConfig = StrategyDefinition;

export function normalizeRulesetConfig(config: unknown, opts?: { name?: string | null }): StrategyDefinition {
  return normalizeStrategyDefinition(config, { name: opts?.name ?? null });
}
