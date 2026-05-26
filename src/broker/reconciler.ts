// src/broker/reconciler.ts
//
// Orphan position reconciler.
//
// The OutcomeTracker drives every close path (STOP, TARGET, STRUCTURE_BREAK,
// EOD). If the broker holds a position that no OutcomeTracker session covers,
// that position is invisible to the engine:
//   - EOD flatten never fires for it
//   - It still consumes a maxOpenPositions slot
//   - It can collide with new orders (e.g. AMZN SHORT rejected because an
//     untracked AMZN LONG already exists)
//
// On startup `reconstructLiveSessionsFromDb()` rebuilds sessions for any
// broker_orders row with status='SUBMITTED' in the last 24h. Anything older or
// without a matching alert (e.g. a manual trade, a position carried across a
// >24h gap, or one whose alert was pruned) is an ORPHAN.
//
// This module:
//   1. Diffs broker positions against tracked sessions and returns the ghost set.
//   2. Optionally auto-flattens ghosts at market (config flag, default off).
//
// Pure module — no DB, no HTTP, no state. Caller wires dependencies.

import { BrokerPositionSnapshot } from "./types";

export type GhostPosition = {
  symbol: string;
  qty: number | null;
  side: string | null;
  avgEntryPrice: number | null;
  marketValue: number | null;
  unrealizedPl: number | null;
  unrealizedPlPct: number | null;
};

export type ReconcileDeps = {
  /** Pull current broker positions. */
  getBrokerPositions: () => Promise<BrokerPositionSnapshot[]>;
  /** Symbols currently tracked across every runner's OutcomeTracker. */
  getTrackedSymbols: () => Set<string>;
  /** Close a position at the broker. Returns the order id of the flatten order. */
  closePosition?: (symbol: string) => Promise<{ orderId: string } | null>;
  /** Whether to auto-flatten orphans. Safer default is false (log only). */
  autoFlatten: boolean;
  /** Logger — defaults to console.log. */
  log?: (msg: string) => void;
};

export type ReconcileResult = {
  checkedAt: number;
  ghosts: GhostPosition[];
  flattened: Array<{ symbol: string; orderId: string }>;
  errors: Array<{ symbol: string; error: string }>;
};

export function findGhostPositions(
  brokerPositions: BrokerPositionSnapshot[],
  trackedSymbols: Set<string>,
): GhostPosition[] {
  const ghosts: GhostPosition[] = [];
  for (const pos of brokerPositions || []) {
    const symbol = String(pos?.symbol || "").toUpperCase();
    if (!symbol) continue;
    if (trackedSymbols.has(symbol)) continue;
    const qty = Number(pos?.qty);
    if (!Number.isFinite(qty) || qty === 0) continue;
    ghosts.push({
      symbol,
      qty,
      side: pos?.side ?? (qty > 0 ? "long" : "short"),
      avgEntryPrice: pos?.avgEntryPrice ?? null,
      marketValue: pos?.marketValue ?? null,
      unrealizedPl: pos?.unrealizedPl ?? null,
      unrealizedPlPct: pos?.unrealizedPlPct ?? null,
    });
  }
  return ghosts;
}

export async function reconcileBrokerPositions(deps: ReconcileDeps): Promise<ReconcileResult> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const checkedAt = Date.now();

  let brokerPositions: BrokerPositionSnapshot[] = [];
  try {
    brokerPositions = await deps.getBrokerPositions();
  } catch (e: any) {
    log(`[reconciler] failed to fetch broker positions: ${e?.message || e}`);
    return { checkedAt, ghosts: [], flattened: [], errors: [{ symbol: "*", error: String(e?.message || e) }] };
  }

  const tracked = deps.getTrackedSymbols();
  const ghosts = findGhostPositions(brokerPositions, tracked);

  if (ghosts.length === 0) {
    return { checkedAt, ghosts: [], flattened: [], errors: [] };
  }

  const ghostSummary = ghosts
    .map((g) => `${g.symbol}(${g.side ?? "?"} ${g.qty ?? "?"})`)
    .join(", ");
  log(`[reconciler] ${ghosts.length} ghost position(s) detected: ${ghostSummary}`);

  if (!deps.autoFlatten) {
    log(`[reconciler] autoFlattenOrphans=false — leaving ghosts in place. Surface via /api/ghost-positions.`);
    return { checkedAt, ghosts, flattened: [], errors: [] };
  }

  if (!deps.closePosition) {
    log(`[reconciler] autoFlattenOrphans=true but no closePosition adapter — cannot flatten.`);
    return { checkedAt, ghosts, flattened: [], errors: ghosts.map((g) => ({ symbol: g.symbol, error: "no closePosition adapter" })) };
  }

  const flattened: Array<{ symbol: string; orderId: string }> = [];
  const errors: Array<{ symbol: string; error: string }> = [];

  for (const ghost of ghosts) {
    try {
      const result = await deps.closePosition(ghost.symbol);
      if (result?.orderId) {
        flattened.push({ symbol: ghost.symbol, orderId: result.orderId });
        log(`[reconciler] flattened ghost ${ghost.symbol} via order ${result.orderId}`);
      } else {
        errors.push({ symbol: ghost.symbol, error: "closePosition returned no orderId" });
        log(`[reconciler] flatten failed for ${ghost.symbol}: no orderId`);
      }
    } catch (e: any) {
      errors.push({ symbol: ghost.symbol, error: String(e?.message || e) });
      log(`[reconciler] flatten error for ${ghost.symbol}: ${e?.message || e}`);
    }
  }

  return { checkedAt, ghosts, flattened, errors };
}
