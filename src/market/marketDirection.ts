import { Levels, getLevelPrice } from "./levels";

export type Bar5 = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type MarketDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

function higherLows(bars: Bar5[], n: number): boolean {
  if (bars.length < n) return false;
  const slice = bars.slice(-n);
  for (let i = 1; i < slice.length; i++) {
    if (!(slice[i].l > slice[i - 1].l)) return false;
  }
  return true;
}

function lowerHighs(bars: Bar5[], n: number): boolean {
  if (bars.length < n) return false;
  const slice = bars.slice(-n);
  for (let i = 1; i < slice.length; i++) {
    if (!(slice[i].h < slice[i - 1].h)) return false;
  }
  return true;
}

export function computeMarketDirection(args: {
  spyBars5: Bar5[];
  qqqBars5: Bar5[];
  spyLevels: Levels;
  qqqLevels: Levels;
  structureWindow: number;
}): MarketDirection {
  const { spyBars5, qqqBars5, spyLevels, qqqLevels, structureWindow } = args;
  const spy = spyBars5.at(-1);
  const qqq = qqqBars5.at(-1);
  if (!spy || !qqq) return "NEUTRAL";

  const spyPMH = getLevelPrice(spyLevels, "PMH");
  const spyPML = getLevelPrice(spyLevels, "PML");
  const spyPDH = getLevelPrice(spyLevels, "PDH");
  const spyPDL = getLevelPrice(spyLevels, "PDL");

  const qqqPMH = getLevelPrice(qqqLevels, "PMH");
  const qqqPML = getLevelPrice(qqqLevels, "PML");
  const qqqPDH = getLevelPrice(qqqLevels, "PDH");
  const qqqPDL = getLevelPrice(qqqLevels, "PDL");

  const brokeBear =
    (spyPML != null && spy.c < spyPML) ||
    (spyPDL != null && spy.c < spyPDL) ||
    (qqqPML != null && qqq.c < qqqPML) ||
    (qqqPDL != null && qqq.c < qqqPDL) ||
    (lowerHighs(spyBars5, structureWindow) && lowerHighs(qqqBars5, structureWindow));

  if (brokeBear) return "BEARISH";

  const brokeBull =
    (spyPMH != null && spy.c > spyPMH) ||
    (spyPDH != null && spy.c > spyPDH) ||
    (qqqPMH != null && qqq.c > qqqPMH) ||
    (qqqPDH != null && qqq.c > qqqPDH) ||
    (higherLows(spyBars5, structureWindow) && higherLows(qqqBars5, structureWindow));

  if (brokeBull) return "BULLISH";

  // Neutral definition: inside premarket range
  const spyInsidePM = spyPMH != null && spyPML != null && spy.c <= spyPMH && spy.c >= spyPML;
  const qqqInsidePM = qqqPMH != null && qqqPML != null && qqq.c <= qqqPMH && qqq.c >= qqqPML;

  if (spyInsidePM && qqqInsidePM) return "NEUTRAL";

  return "NEUTRAL";
}
