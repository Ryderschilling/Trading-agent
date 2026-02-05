import { Bar5 } from "../market/marketDirection";
import { RelativeStrength } from "./types";

/**
 * Deterministic relative strength:
 * - Compare last N (default 3) completed 5-minute bars vs SPY
 * - STRONG = outperforming in bullish market
 * - WEAK   = underperforming in bearish market
 * - Otherwise NONE
 */
export function computeRS(args: {
  marketDir: "BULLISH" | "BEARISH" | "NEUTRAL";
  symBars5: Bar5[];
  spyBars5: Bar5[];
  windowBars: number;
}): RelativeStrength {
  const { marketDir, symBars5, spyBars5, windowBars } = args;

  if (marketDir === "NEUTRAL") return "NONE";
  if (symBars5.length < windowBars + 1) return "NONE";
  if (spyBars5.length < windowBars + 1) return "NONE";

  const symNow = symBars5.at(-1)!;
  const symPast = symBars5.at(-(windowBars + 1))!;
  const spyNow = spyBars5.at(-1)!;
  const spyPast = spyBars5.at(-(windowBars + 1))!;

  const symRet = (symNow.c - symPast.c) / symPast.c;
  const spyRet = (spyNow.c - spyPast.c) / spyPast.c;

  if (marketDir === "BULLISH") {
    return symRet > spyRet ? "STRONG" : "NONE";
  }

  // BEARISH
  return symRet < spyRet ? "WEAK" : "NONE";
}
