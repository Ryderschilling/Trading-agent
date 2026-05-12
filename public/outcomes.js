/* global io */

let socket = null;
try {
  if (typeof io === "function") socket = io();
} catch {
  socket = null;
}

const socketDot = document.getElementById("socketDot");

const dbBodyEl = document.getElementById("dbBody");
const dbEmptyEl = document.getElementById("dbEmpty");
const rangeToggleEls = Array.from(document.querySelectorAll(".range-toggle"));
let activeRange = "day"; // 1D default

const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");
const modalSubEl = document.getElementById("modalSub");
const modalBodyEl = document.getElementById("modalBody");

let dbRowsRaw = [];
let allAlerts = [];
let modalCleanup = null;
let activeModalToken = 0;
const DISPLAY_TIMEFRAME_STEPS = [1, 2, 3, 5];
const DISPLAY_BAR_TARGET_MIN = 80;
const DISPLAY_BAR_TARGET_MAX = 180;
const DISPLAY_BAR_TARGET_IDEAL = 140;

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  } catch {
    return "—";
  }
}

function fmtDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString();
}

function fmt2(x) {
  if (x == null || x === "" || Number.isNaN(Number(x))) return "—";
  return Number(x).toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    })[m]
  );
}

function findAlertById(id) {
  return (allAlerts || []).find((a) => String(a.id) === String(id)) || null;
}

async function refreshDataLiveDot() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const j = await r.json();
    const live = Boolean(j?.market?.dataLive);

    if (socketDot) {
      socketDot.classList.toggle("live", live);
      socketDot.title = live ? "DATA LIVE (RTH + fresh bars)" : "Data not live";
    }
  } catch {
    if (socketDot) {
      socketDot.classList.remove("live");
      socketDot.title = "Health check failed";
    }
  }
}


function clearModalCleanup() {
  if (typeof modalCleanup === "function") modalCleanup();
  modalCleanup = null;
}

function modalOpen() {
  if (!modalEl) return;
  modalEl.style.display = "flex";
}

function modalClose() {
  activeModalToken += 1;
  clearModalCleanup();
  if (!modalEl) return;
  modalEl.style.display = "none";
}

modalCloseEl?.addEventListener("click", modalClose);
modalEl?.addEventListener("click", (e) => {
  if (e.target === modalEl) modalClose();
});

function normalizeBars(bars1m) {
  return (bars1m || [])
    .map((b) => ({
      ts: Number(b.ts),
      o: Number(b.o),
      h: Number(b.h),
      l: Number(b.l),
      c: Number(b.c),
      v: Number(b.v || 0),
    }))
    .filter((b) => Number.isFinite(b.ts) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
    .sort((a, b) => a.ts - b.ts);
}

function aggregateBars(bars1m, timeframeMin) {
  const tf = Math.max(1, Math.floor(Number(timeframeMin || 1)));
  if (!bars1m.length || tf === 1) return bars1m.slice();

  const out = [];
  let cur = null;
  const bucketOf = (ts) => Math.floor(ts / (tf * 60_000)) * (tf * 60_000);

  for (const b of bars1m) {
    const bucket = bucketOf(b.ts);
    if (!cur || cur.bucket !== bucket) {
      if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });
      cur = { bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }

  if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });
  return out;
}

function vwapSeries(bars) {
  let pv = 0;
  let v = 0;
  const out = [];

  for (const b of bars) {
    const typical = (Number(b.h) + Number(b.l) + Number(b.c)) / 3;
    const vol = Number(b.v || 0);
    if (Number.isFinite(typical) && Number.isFinite(vol) && vol > 0) {
      pv += typical * vol;
      v += vol;
    }
    out.push(v > 0 ? pv / v : null);
  }

  return out;
}

function closestIdxByTs(bars, ts) {
  if (!Array.isArray(bars) || !bars.length || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return null;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = Math.abs(Number(bars[i].ts) - Number(ts));
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

function syncCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(320, Math.round(rect.width || 1100));
  const height = Math.max(260, Math.round(rect.height || 440));
  const ratio = Math.max(1, window.devicePixelRatio || 1);

  if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height };
}

function emaOf(bars, period) {
  if (!bars.length || period <= 0) return [];
  const k = 2 / (period + 1);
  const out = new Array(bars.length).fill(null);
  let ema = null;
  for (let i = 0; i < bars.length; i++) {
    const c = Number(bars[i].c);
    if (!Number.isFinite(c)) continue;
    ema = ema === null ? c : c * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function drawRoundedLabel(ctx, x, y, text, fillStyle, textStyle) {
  ctx.save();
  ctx.font = "10px system-ui";
  const padX = 6;
  const padY = 3;
  const w = ctx.measureText(text).width + padX * 2;
  const h = 18;
  const r = 8;

  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = textStyle;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + padX, y + h / 2);
  ctx.restore();
}

function drawChart(canvas, bars, opts) {
  if (!canvas) return;

  const { ctx, width: w, height: h } = syncCanvasSize(canvas);
  ctx.clearRect(0, 0, w, h);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#0a1220");
  bg.addColorStop(1, "#0d1626");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (!Array.isArray(bars) || !bars.length) {
    ctx.fillStyle = "rgba(231, 237, 246, 0.78)";
    ctx.font = "14px system-ui";
    ctx.fillText("No candles found for this snapshot.", 18, 28);
    return;
  }

  const padTop = 24;
  const padRight = 62;
  const padBottom = 32;
  const padLeft = 14;
  const plotW = Math.max(40, w - padLeft - padRight);
  const plotH = Math.max(40, h - padTop - padBottom);

  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    const lv = Number(b.l);
    const hv = Number(b.h);
    if (Number.isFinite(lv)) lo = Math.min(lo, lv);
    if (Number.isFinite(hv)) hi = Math.max(hi, hv);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }

  const padPct = (hi - lo) * 0.05;
  lo -= padPct;
  hi += padPct;

  const slotW = plotW / Math.max(1, bars.length);
  const xOf = (idx) => padLeft + slotW * idx + slotW / 2;
  const wickXOf = (idx) => Math.round(xOf(idx)) + 0.5;
  const yOf = (price) => padTop + ((hi - Number(price)) / Math.max(0.0001, hi - lo)) * plotH;

  const gridLevels = 4;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 8]);
  ctx.font = "11px system-ui";
  ctx.fillStyle = "rgba(154, 166, 187, 0.82)";
  for (let i = 0; i < gridLevels; i++) {
    const t = i / Math.max(1, gridLevels - 1);
    const y = padTop + plotH * t;
    const price = hi - (hi - lo) * t;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight + 10, y);
    ctx.stroke();
    ctx.fillText(fmt2(price), w - padRight + 14, y + 4);
  }
  ctx.setLineDash([]);

  const entryIdx = closestIdxByTs(bars, opts?.entryTs);
  const exitIdx = closestIdxByTs(bars, opts?.exitTs);

  if (entryIdx != null && exitIdx != null && entryIdx !== exitIdx) {
    const firstIdx = Math.min(entryIdx, exitIdx);
    const lastIdx = Math.max(entryIdx, exitIdx);
    const left = padLeft + slotW * firstIdx;
    const right = padLeft + slotW * (lastIdx + 1);
    ctx.fillStyle = "rgba(93, 169, 255, 0.05)";
    ctx.fillRect(left, padTop, Math.max(2, right - left), plotH);
  }

  // Horizontal S/R levels
  if (Array.isArray(opts?.levels)) {
    for (const lvl of opts.levels) {
      const price = Number(lvl.price);
      if (!Number.isFinite(price) || price < lo || price > hi) continue;
      const y = Math.round(yOf(price)) + 0.5;
      ctx.save();
      ctx.strokeStyle = lvl.color || "rgba(255, 220, 60, 0.7)";
      ctx.lineWidth = lvl.lineWidth || 1.5;
      ctx.setLineDash(lvl.dash || [6, 5]);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight + 10, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (lvl.label) {
        ctx.font = "10px system-ui";
        ctx.fillStyle = lvl.color || "rgba(255, 220, 60, 0.85)";
        ctx.fillText(`${lvl.label} ${fmt2(price)}`, w - padRight + 14, y - 3);
      }
      ctx.restore();
    }
  }

  // EMA lines
  if (Array.isArray(opts?.emas)) {
    for (const emaCfg of opts.emas) {
      const values = emaOf(bars, emaCfg.period);
      ctx.save();
      ctx.strokeStyle = emaCfg.color || "rgba(255, 165, 0, 0.8)";
      ctx.lineWidth = emaCfg.lineWidth || 1.4;
      ctx.setLineDash([]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v == null) continue;
        const x = xOf(i);
        const y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // Label at end
      if (started && values[values.length - 1] != null) {
        const lastVal = values[values.length - 1];
        const ly = yOf(lastVal);
        ctx.font = "9px system-ui";
        ctx.fillStyle = emaCfg.color || "rgba(255, 165, 0, 0.85)";
        ctx.fillText(`${emaCfg.label || `EMA${emaCfg.period}`}`, w - padRight + 14, ly + 3);
      }
      ctx.restore();
    }
  }

  if (opts?.showVwap) {
    const vwap = vwapSeries(bars);
    ctx.strokeStyle = "rgba(125, 191, 255, 0.82)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < vwap.length; i++) {
      const v = vwap[i];
      if (v == null) continue;
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  const widthScale =
    bars.length >= 160 ? 0.5 : bars.length >= 120 ? 0.54 : bars.length >= 90 ? 0.58 : 0.62;
  const bodyW = Math.max(1.8, Math.min(7.5, slotW * widthScale));

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (!Number.isFinite(Number(b.o)) || !Number.isFinite(Number(b.c))) continue;
    const x = xOf(i);
    const wickX = wickXOf(i);
    const yH = yOf(b.h);
    const yL = yOf(b.l);
    const yO = yOf(b.o);
    const yC = yOf(b.c);
    const up = b.c >= b.o;

    ctx.strokeStyle = up ? "rgba(74, 222, 128, 0.85)" : "rgba(248, 113, 113, 0.88)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(wickX, yH);
    ctx.lineTo(wickX, yL);
    ctx.stroke();

    ctx.fillStyle = up ? "rgba(74, 222, 128, 0.95)" : "rgba(248, 113, 113, 0.95)";
    const top = Math.min(yO, yC);
    const height = Math.max(1.5, Math.abs(yC - yO));
    const bodyLeft = Math.round((x - bodyW / 2) * 2) / 2;
    ctx.fillRect(bodyLeft, top, bodyW, height);
  }

  const markerY = padTop + 8;
  const markers = [
    {
      idx: opts?.showEntry !== false ? entryIdx : null,
      label: "Entry",
      lineColor: "rgba(45, 212, 255, 0.95)",
      pillFill: "rgba(45, 212, 255, 0.22)",
      pillText: "#b0f0ff",
    },
    {
      idx: opts?.showExit !== false ? exitIdx : null,
      label: "Exit",
      lineColor: "rgba(251, 113, 133, 0.95)",
      pillFill: "rgba(251, 113, 133, 0.22)",
      pillText: "#ffd0da",
    },
  ];

  for (const marker of markers) {
    if (marker.idx == null) continue;
    const x = wickXOf(marker.idx);

    // Full-height vertical line — dashed
    ctx.save();
    ctx.strokeStyle = marker.lineColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font = "11px system-ui";
    const labelWidth = ctx.measureText(marker.label).width + 14;
    ctx.restore();
    const clampedX = Math.max(6, Math.min(x - labelWidth / 2, w - labelWidth - 6));
    drawRoundedLabel(ctx, clampedX, markerY, marker.label, marker.pillFill, marker.pillText);
  }

  const labelIndices = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
  const seen = new Set();
  ctx.fillStyle = "rgba(154, 166, 187, 0.84)";
  ctx.font = "11px system-ui";
  for (const idx of labelIndices) {
    if (seen.has(idx) || bars[idx] == null) continue;
    seen.add(idx);
    const x = xOf(idx);
    const ts = Number(bars[idx].ts);
    const text = bars.length > 120 ? fmtTime(ts) : fmtDateTime(ts);
    const measured = ctx.measureText(text).width;
    const clampedX = Math.max(6, Math.min(x - measured / 2, w - measured - 6));
    ctx.fillText(text, clampedX, h - 10);
  }

  // Hover crosshair — vertical line at hovered bar + time/price labels.
  const hoverIdx = Number.isFinite(Number(opts?.hoverIdx)) ? Math.floor(Number(opts.hoverIdx)) : -1;
  if (hoverIdx >= 0 && hoverIdx < bars.length) {
    const hb = bars[hoverIdx];
    const x = wickXOf(hoverIdx);

    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Bottom time pill
    const timeText = fmtDateTime(Number(hb.ts));
    ctx.save();
    ctx.font = "11px system-ui";
    const padX = 8;
    const padY = 4;
    const textW = ctx.measureText(timeText).width;
    const pillW = textW + padX * 2;
    const pillH = 20;
    const pillX = Math.max(4, Math.min(x - pillW / 2, w - pillW - 4));
    const pillY = h - pillH - 2;

    ctx.fillStyle = "rgba(15, 22, 38, 0.95)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const r = 6;
    ctx.moveTo(pillX + r, pillY);
    ctx.lineTo(pillX + pillW - r, pillY);
    ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + r);
    ctx.lineTo(pillX + pillW, pillY + pillH - r);
    ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - r, pillY + pillH);
    ctx.lineTo(pillX + r, pillY + pillH);
    ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - r);
    ctx.lineTo(pillX, pillY + r);
    ctx.quadraticCurveTo(pillX, pillY, pillX + r, pillY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "rgba(231, 237, 246, 0.95)";
    ctx.textBaseline = "middle";
    ctx.fillText(timeText, pillX + padX, pillY + pillH / 2 + 0.5);
    ctx.restore();

    // Right-side price pill at the bar's close
    const closePx = Number(hb.c);
    if (Number.isFinite(closePx)) {
      const py = yOf(closePx);
      const priceText = fmt2(closePx);
      ctx.save();
      ctx.font = "11px system-ui";
      const tW = ctx.measureText(priceText).width;
      const ppadX = 6;
      const pW = tW + ppadX * 2;
      const pH = 18;
      const pX = Math.min(w - pW - 2, padLeft + plotW + 4);
      const pY = Math.max(padTop, Math.min(py - pH / 2, padTop + plotH - pH));

      ctx.fillStyle = "rgba(15, 22, 38, 0.95)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1;
      const rr = 5;
      ctx.beginPath();
      ctx.moveTo(pX + rr, pY);
      ctx.lineTo(pX + pW - rr, pY);
      ctx.quadraticCurveTo(pX + pW, pY, pX + pW, pY + rr);
      ctx.lineTo(pX + pW, pY + pH - rr);
      ctx.quadraticCurveTo(pX + pW, pY + pH, pX + pW - rr, pY + pH);
      ctx.lineTo(pX + rr, pY + pH);
      ctx.quadraticCurveTo(pX, pY + pH, pX, pY + pH - rr);
      ctx.lineTo(pX, pY + rr);
      ctx.quadraticCurveTo(pX, pY, pX + rr, pY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "rgba(231, 237, 246, 0.95)";
      ctx.textBaseline = "middle";
      ctx.fillText(priceText, pX + ppadX, pY + pH / 2 + 0.5);
      ctx.restore();
    }
  }
}

// NY trading session window: 4:00 AM ET (premarket open) → 4:00 PM ET (RTH close).
// Returns absolute UTC ms for the trading day that contains `ts` in NY time.
// Handles DST automatically by probing the offset from the trade-day's noon.
function nySessionWindow(ts) {
  const probeMs = Number(ts) || Date.now();

  // Resolve which NY calendar day the timestamp belongs to.
  const dayParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  }).formatToParts(new Date(probeMs));
  const dp = Object.fromEntries(dayParts.map((p) => [p.type, p.value]));
  const y = Number(dp.year);
  const m = Number(dp.month);
  const d = Number(dp.day);

  // Probe the NY-vs-UTC offset on that NY day at noon (well clear of any DST flip).
  const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
  const noonNyParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(new Date(noonUtc));
  const np = Object.fromEntries(noonNyParts.map((p) => [p.type, p.value]));
  const noonHr = np.hour === "24" ? 0 : Number(np.hour);
  const noonAsIfUtc = Date.UTC(Number(np.year), Number(np.month) - 1, Number(np.day), noonHr, Number(np.minute), Number(np.second));
  const nyOffsetMs = noonAsIfUtc - noonUtc; // negative for NY (e.g. -4h or -5h)

  // 7:00 AM NY (= 6:00 AM CT premarket) → 4:00 PM NY (= 3:00 PM CT close).
  const start = Date.UTC(y, m - 1, d, 7, 0, 0) - nyOffsetMs;
  const end   = Date.UTC(y, m - 1, d, 16, 0, 0) - nyOffsetMs;
  return { start, end };
}

async function requestCandles(symbol, endTs, minutes) {
  const res = await fetch(
    `/api/candles?symbol=${encodeURIComponent(symbol)}&end=${encodeURIComponent(endTs)}&minutes=${encodeURIComponent(
      minutes
    )}`,
    { cache: "no-store" }
  );
  const j = await res.json().catch(() => null);
  return normalizeBars(Array.isArray(j?.bars) ? j.bars : []);
}

function scoreRange(bars, entryTs, exitTs, preferenceWeight) {
  if (!bars.length) return -Infinity;
  const first = Number(bars[0].ts);
  const last = Number(bars[bars.length - 1].ts) + 60_000;
  const coversEntry = Number(entryTs) >= first && Number(entryTs) <= last;
  const coversExit = !Number(exitTs) || (Number(exitTs) >= first && Number(exitTs) <= last);
  return bars.length + (coversEntry ? 20_000 : 0) + (coversExit ? 10_000 : 0) + preferenceWeight;
}

async function fetchSnapshotBars(symbol, entryTs, exitTs) {
  // Always pin the chart window to the NY trading session of the trade's day:
  // 7:00 AM ET (= 6:00 AM CT premarket) → 4:00 PM ET (= 3:00 PM CT close) = 540 minutes.
  const win = nySessionWindow(entryTs || Date.now());
  const sessionMinutes = Math.ceil((win.end - win.start) / 60_000); // 540

  let bars1m = [];
  try {
    bars1m = await requestCandles(symbol, win.end, sessionMinutes);
  } catch {
    bars1m = [];
  }

  // Strict clamp to the NY session window so we never spill into other days.
  bars1m = bars1m.filter((b) => Number(b.ts) >= win.start && Number(b.ts) < win.end);

  // Score is informational only now; we no longer fall back to wider windows.
  void scoreRange(bars1m, entryTs, exitTs, 0);

  return {
    bars1m,
    label: "NY trading session (premarket → close)",
    windowStart: win.start,
    windowEnd: win.end,
  };
}

// Always render 5-minute candles, regardless of how much data is available.
function chooseDisplayTimeframe(_baseTfMin, _bars1mLength) {
  return 5;
}

function buildMetric(label, value) {
  return `
    <div class="outcome-metric">
      <div class="outcome-metric-label">${label}</div>
      <div class="outcome-metric-value">${value}</div>
    </div>
  `;
}

function buildDetailItem(label, value) {
  return `
    <div class="outcome-detail-item">
      <div class="outcome-detail-label">${label}</div>
      <div class="outcome-detail-value">${value}</div>
    </div>
  `;
}

async function openModalForRow(r) {
  if (!modalEl || !modalBodyEl || !modalSubEl) return;
  clearModalCleanup();
  const modalToken = ++activeModalToken;

  const strat = r.strategyName || (r.strategyVersion != null ? `v${r.strategyVersion}` : "—");
  modalSubEl.textContent = `${r.symbol || ""} • ${strat}`;
  modalBodyEl.innerHTML = "Loading…";
  modalOpen();

  const entryTs = Number(r.ts || Date.now());
  const exitTs =
    r.stopTs != null && Number.isFinite(Number(r.stopTs)) && Number(r.stopTs) > 0
      ? Number(r.stopTs)
      : r.endTs != null && Number.isFinite(Number(r.endTs)) && Number(r.endTs) > 0
      ? Number(r.endTs)
      : 0;

  const strategyTfMin = Math.max(1, Math.floor(Number(r.timeframeMin || 1)));
  const showVwap = Boolean(r.showVwap);
  const statusText = escapeHtml(r.status || "—");
  const pnlText = r.pnlPct != null ? `${fmt2(r.pnlPct)}%` : "—";

  modalBodyEl.innerHTML = `
    <div class="outcome-detail">
      <div class="outcome-metrics">
        ${buildMetric("Symbol", `<b>${escapeHtml(r.symbol || "—")}</b>`)}
        ${buildMetric("Strategy", escapeHtml(strat))}
        ${buildMetric("Status", `<b>${statusText}</b>`)}
        ${buildMetric("PnL", `<b>${escapeHtml(pnlText)}</b>`)}
        ${buildMetric("Entry", escapeHtml(fmtDateTime(entryTs)))}
        ${buildMetric("Exit", escapeHtml(exitTs ? fmtDateTime(exitTs) : "Still open / checkpoint"))}
      </div>

      <section class="outcome-chart-panel">
        <div class="outcome-chart-head">
          <div>
            <div class="outcome-chart-title">Trade Context Snapshot</div>
            <div class="outcome-chart-caption" id="outcomeChartContext">
              Loading broader ticker context for this trade…
            </div>
          </div>

          <div class="outcome-chart-legend">
            <button class="outcome-chip outcome-chip-btn active" id="toggleEntry" title="Toggle entry marker">● Entry</button>
            <button class="outcome-chip outcome-chip-btn" id="toggleExit" title="Toggle exit marker">● Exit</button>
            <button class="outcome-chip outcome-chip-btn active" id="toggleVwap" title="Toggle VWAP line">● VWAP</button>
            <button class="outcome-chip outcome-chip-btn active" id="toggleEma" title="Toggle EMA 9" style="color:#ffffff;">● EMA 9</button>
            <button class="outcome-chip outcome-chip-btn active" id="toggleLevels" title="Toggle PDH/PDL/PMH/PML levels">● Levels</button>
          </div>
        </div>

        <div class="outcome-chart-stage">
          <canvas id="outcomeChart"></canvas>
        </div>
      </section>

      <div class="outcome-detail-grid">
        ${buildDetailItem("Market / RS", `${escapeHtml(r.market || "—")} • ${escapeHtml(r.rs || "—")}`)}
        ${buildDetailItem("Level / Structure", `${escapeHtml(r.level || "—")} • ${r.structureLevel != null ? fmt2(r.structureLevel) : "—"}`)}
        ${buildDetailItem("Stopped Out", r.stoppedOut ? "YES" : "NO")}
        ${buildDetailItem("Timeframe", `${strategyTfMin}m strategy timeframe`)}
        ${buildDetailItem("Trade Window", exitTs ? `${fmtTime(entryTs)} → ${fmtTime(exitTs)}` : `${fmtTime(entryTs)} → open`)}
        ${buildDetailItem("Alert ID", escapeHtml(r.alertId || "—"))}
      </div>
    </div>
  `;

  const chartContextEl = document.getElementById("outcomeChartContext");
  const canvas = document.getElementById("outcomeChart");
  if (!canvas) return;

  try {
    const snapshot = await fetchSnapshotBars(r.symbol, entryTs, exitTs);
    if (modalToken !== activeModalToken) return;
    const displayTfMin = chooseDisplayTimeframe(strategyTfMin, snapshot.bars1m.length);
    const aggregated = aggregateBars(snapshot.bars1m, displayTfMin);

    // Pad the display series with empty 5m slots so the chart axis always
    // spans the full NY session window (e.g. 6:00 AM CT → 3:00 PM CT),
    // even if the broker feed only returned data for part of it.
    const slotMs = displayTfMin * 60_000;
    const wStart = Number(snapshot.windowStart);
    const wEnd   = Number(snapshot.windowEnd);
    const barsDisplay = [];
    if (Number.isFinite(wStart) && Number.isFinite(wEnd) && wEnd > wStart) {
      const real = new Map(aggregated.map((b) => [Math.floor(Number(b.ts) / slotMs) * slotMs, b]));
      for (let ts = Math.floor(wStart / slotMs) * slotMs; ts < wEnd; ts += slotMs) {
        const hit = real.get(ts);
        barsDisplay.push(hit || { ts, o: NaN, h: NaN, l: NaN, c: NaN, v: 0 });
      }
    } else {
      barsDisplay.push(...aggregated);
    }

    // Named structural levels: PDH (green), PDL (red), PMH/PML (purple)
    const GREEN  = "rgba(74, 222, 128, 0.95)";
    const RED    = "rgba(248, 113, 113, 0.95)";
    const PURPLE = "rgba(170, 100, 255, 0.95)";
    const namedLevels = [
      { key: "pdh", label: "PDH", color: GREEN  },
      { key: "pdl", label: "PDL", color: RED    },
      { key: "pmh", label: "PMH", color: PURPLE },
      { key: "pml", label: "PML", color: PURPLE },
    ];

    const chartLevels = [];
    const seenPrices = new Set();
    for (const spec of namedLevels) {
      const v = Number(r[spec.key]);
      if (!Number.isFinite(v)) continue;
      const key = v.toFixed(4);
      if (seenPrices.has(key)) continue;
      seenPrices.add(key);
      chartLevels.push({
        price: v,
        color: spec.color,
        label: spec.label,
        dash: [5, 4],
        lineWidth: 1.4,
      });
    }

    // Backward compat: older alerts (before level snapshotting) only have a
    // single triggering level on the row. Color it by `r.level` when known.
    if (chartLevels.length === 0 && r.structureLevel != null && Number.isFinite(Number(r.structureLevel))) {
      const lvlKey = String(r.level || "").toUpperCase();
      const fallbackColor =
        lvlKey === "PDH" ? GREEN  :
        lvlKey === "PDL" ? RED    :
        lvlKey === "PMH" || lvlKey === "PML" ? PURPLE :
        "rgba(200, 200, 200, 0.7)";
      chartLevels.push({
        price: Number(r.structureLevel),
        color: fallbackColor,
        label: lvlKey || "S/R",
        dash: [5, 4],
        lineWidth: 1.4,
      });
    }

    // EMA: only the 9, in white
    const chartEmas = [
      { period: 9, color: "rgba(255, 255, 255, 0.92)", lineWidth: 1.4, label: "9" },
    ];

    // Toggle state
    let showEntry = true;
    let showExit = Boolean(exitTs);
    let showVwapToggle = showVwap;

    function redraw() {
      drawChart(canvas, barsDisplay, {
        entryTs,
        exitTs,
        showVwap: showVwapToggle,
        showEntry,
        showExit,
        levels: chartLevels,
        emas: chartEmas,
      });
    }

    redraw();

    if (chartContextEl) {
      const rangeStart = barsDisplay.length ? fmtDateTime(barsDisplay[0].ts) : "—";
      const rangeEnd = barsDisplay.length ? fmtDateTime(barsDisplay[barsDisplay.length - 1].ts) : "—";
      chartContextEl.textContent =
        `Snapshot range: ${snapshot.label}. Showing ${displayTfMin}m candles built from 1m source so the broader move stays visible. ` +
        `Range ${rangeStart} to ${rangeEnd}.`;
    }

    // Wire toggle buttons
    const btnEntry  = document.getElementById("toggleEntry");
    const btnExit   = document.getElementById("toggleExit");
    const btnVwap   = document.getElementById("toggleVwap");
    const btnEma    = document.getElementById("toggleEma");
    const btnLevels = document.getElementById("toggleLevels");

    let showEmas   = true;
    let showLevels = true;
    let hoverIdx   = -1;

    function redrawWithToggles() {
      drawChart(canvas, barsDisplay, {
        entryTs,
        exitTs,
        showVwap: showVwapToggle,
        showEntry,
        showExit,
        levels: showLevels ? chartLevels : [],
        emas: showEmas ? chartEmas : [],
        hoverIdx,
      });
    }

    // Replace the simpler redraw with the full-toggle version
    // (redraw is still used by resize handler — repoint it)
    const redrawFull = redrawWithToggles;
    // Re-draw now with toggles applied
    redrawFull();

    if (btnEntry) {
      btnEntry.classList.toggle("active", showEntry);
      btnExit?.classList.toggle("active", showExit);
      btnVwap?.classList.toggle("active", showVwapToggle);
      btnEma?.classList.toggle("active", showEmas);
      btnLevels?.classList.toggle("active", showLevels);

      btnEntry.onclick = () => { showEntry = !showEntry; btnEntry.classList.toggle("active", showEntry); redrawFull(); };
      if (btnExit)   btnExit.onclick   = () => { showExit = !showExit; btnExit.classList.toggle("active", showExit); redrawFull(); };
      if (btnVwap)   btnVwap.onclick   = () => { showVwapToggle = !showVwapToggle; btnVwap.classList.toggle("active", showVwapToggle); redrawFull(); };
      if (btnEma)    btnEma.onclick    = () => { showEmas = !showEmas; btnEma.classList.toggle("active", showEmas); redrawFull(); };
      if (btnLevels) btnLevels.onclick = () => { showLevels = !showLevels; btnLevels.classList.toggle("active", showLevels); redrawFull(); };
    }

    // Hover crosshair: map cursor X to nearest bar index using the same
    // padding constants drawChart uses.
    const onMove = (e) => {
      if (!barsDisplay.length) return;
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const padLeft = 14;
      const padRight = 62;
      const plotW = Math.max(40, rect.width - padLeft - padRight);
      const slotW = plotW / barsDisplay.length;
      const idx = Math.floor((localX - padLeft) / slotW);
      const clamped = idx < 0 ? -1 : (idx >= barsDisplay.length ? -1 : idx);
      if (clamped !== hoverIdx) {
        hoverIdx = clamped;
        redrawFull();
      }
    };
    const onLeave = () => {
      if (hoverIdx !== -1) {
        hoverIdx = -1;
        redrawFull();
      }
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.style.cursor = "crosshair";

    const onResize = () => redrawFull();
    window.addEventListener("resize", onResize);
    modalCleanup = () => {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  } catch {
    if (modalToken !== activeModalToken) return;
    drawChart(canvas, [], {});
    if (chartContextEl) {
      chartContextEl.textContent = "Unable to load chart candles for this outcome snapshot.";
    }
  }

  const a = findAlertById(r.alertId);
  if (a) {
    const raw = document.createElement("div");
    raw.className = "outcome-raw";
    raw.innerHTML = `
      <div class="outcome-detail-label">Raw Message</div>
      <div class="outcome-raw-body">${escapeHtml(String(a.message || ""))}</div>
    `;
    modalBodyEl.querySelector(".outcome-detail")?.appendChild(raw);
  }
}

function applyDbFilters(rows) {
  const now = Date.now();
  let cutoff = 0;
  if (activeRange === "day") cutoff = now - 1 * 24 * 60 * 60_000;
  else if (activeRange === "month") cutoff = now - 30 * 24 * 60 * 60_000;
  else if (activeRange === "year") cutoff = now - 365 * 24 * 60 * 60_000;

  return (rows || []).filter((r) => {
    if (cutoff && Number(r.ts || 0) < cutoff) return false;
    return true;
  });
}

function computePnlPct(row) {
  if (row?.exitReturnPct !== "" && row?.exitReturnPct != null && Number.isFinite(Number(row.exitReturnPct))) {
    return Number(row.exitReturnPct);
  }

  if (row?.stoppedOut && row?.stopReturnPct !== "" && row?.stopReturnPct != null && Number.isFinite(Number(row.stopReturnPct))) {
    return Number(row.stopReturnPct);
  }

  if (!row?.stoppedOut && row?.retExit !== "" && row?.retExit != null && Number.isFinite(Number(row.retExit))) {
    return Number(row.retExit);
  }

  const candidates = [row?.ret60m, row?.ret30m, row?.ret15m, row?.ret5m];
  for (const v of candidates) {
    if (v !== "" && v != null && Number.isFinite(Number(v))) return Number(v);
  }

  return null;
}

function renderStats(rows) {
  const el = document.getElementById("statsBar");
  if (!el) return;

  const upper = (s) => String(s || "").toUpperCase();

  // Closed = anything that has a settled PnL (completed or stopped). Live rows are excluded.
  const closedPnl = rows
    .filter((r) => upper(r.status) !== "LIVE")
    .map((r) => Number(r.pnlPct))
    .filter((v) => Number.isFinite(v));

  const wins = closedPnl.filter((v) => v > 0).length;
  const winRate = closedPnl.length ? (wins / closedPnl.length) * 100 : null;
  const avgPnl = closedPnl.length ? closedPnl.reduce((a, b) => a + b, 0) / closedPnl.length : null;
  const totalPnl = closedPnl.length ? closedPnl.reduce((a, b) => a + b, 0) : null;
  const best = closedPnl.length ? Math.max(...closedPnl) : null;
  const worst = closedPnl.length ? Math.min(...closedPnl) : null;

  const signedPct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt2(v)}%`);
  const colorOf = (v) => (v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : "");
  const card = (label, value, cls) =>
    `<div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value ${cls || ""}">${value}</div>
    </div>`;

  el.innerHTML = [
    card("Total", String(rows.length)),
    card(
      "Win Rate",
      winRate == null ? "—" : `${fmt2(winRate)}%`,
      winRate == null ? "" : winRate >= 50 ? "pos" : "neg"
    ),
    card("Avg PnL", signedPct(avgPnl), colorOf(avgPnl)),
    card("Total PnL", signedPct(totalPnl), colorOf(totalPnl)),
    card("Best", signedPct(best), colorOf(best)),
    card("Worst", signedPct(worst), colorOf(worst)),
  ].join("");
}

function renderDbTable() {
  if (!dbBodyEl || !dbEmptyEl) return;

  const rows = applyDbFilters(dbRowsRaw);

  // Pre-compute pnlPct on every row so stats and the table stay consistent.
  for (const r of rows) {
    r.pnlPct = computePnlPct(r);
  }
  renderStats(rows);

  dbBodyEl.innerHTML = "";

  if (!rows.length) {
    dbEmptyEl.style.display = "block";
    return;
  }
  dbEmptyEl.style.display = "none";

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "clickable";

    const td = (t) => {
      const el = document.createElement("td");
      el.textContent = t;
      return el;
    };

    const stratLabel = r.strategyName || (r.strategyVersion != null ? `v${r.strategyVersion}` : "");
    const pnl = r.pnlPct;

    tr.appendChild(td(stratLabel));
    tr.appendChild(td(r.symbol || ""));
    tr.appendChild(td(fmtTime(r.ts)));
    tr.appendChild(td(r.market || "—"));
    tr.appendChild(td(r.rs || "—"));
    tr.appendChild(td(r.level || "—"));

    // Status — color coded
    const statusTd = document.createElement("td");
    const statusColors = { LIVE: "#60a5fa", STOPPED: "#f87171", COMPLETED: "#34d399" };
    const sc = statusColors[r.status] || "";
    statusTd.innerHTML = sc
      ? `<span style="color:${sc};font-weight:700;">${escapeHtml(r.status || "—")}</span>`
      : escapeHtml(r.status || "—");
    tr.appendChild(statusTd);

    // Stopped — highlight yes in red
    const stopTd = document.createElement("td");
    stopTd.innerHTML = r.stoppedOut
      ? `<span style="color:#f87171;font-weight:700;">YES</span>`
      : `<span style="color:rgba(255,255,255,0.3);">NO</span>`;
    tr.appendChild(stopTd);

    // PnL — green/red
    const pnlTd = document.createElement("td");
    if (pnl == null) {
      pnlTd.textContent = "—";
    } else {
      const pnlColor = pnl > 0 ? "#34d399" : pnl < 0 ? "#f87171" : "inherit";
      pnlTd.innerHTML = `<span style="color:${pnlColor};font-weight:700;">${fmt2(pnl)}%</span>`;
    }
    tr.appendChild(pnlTd);

    tr.addEventListener("click", () => openModalForRow(r));
    dbBodyEl.appendChild(tr);
  }
}

let lastDbrowsHash = "";
async function fetchDbRowsStable() {
  try {
    const r = await fetch("/api/dbrows", { cache: "no-store" });
    const j = await r.json();
    const rows = Array.isArray(j?.rows) ? j.rows : [];

    const hash = rows.map((x) => `${x.alertId}:${x.status}:${x.endTs || ""}`).join("|");
    if (hash === lastDbrowsHash) return;

    lastDbrowsHash = hash;
    dbRowsRaw = rows;
    renderDbTable();
  } catch {
    // ignore
  }
}

for (const btn of rangeToggleEls) {
  btn.addEventListener("click", () => {
    const r = String(btn.dataset.range || "all");
    if (r === activeRange) return;
    activeRange = r;
    for (const b of rangeToggleEls) b.classList.toggle("active", b === btn);
    renderDbTable();
  });
}

if (socket) {
  socket.on("init", (payload) => {
    allAlerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    fetchDbRowsStable();
  });

  socket.on("alert", (a) => {
    allAlerts.push(a);
    fetchDbRowsStable();
  });
} else {
  socketDot?.classList.remove("live");
}

fetchDbRowsStable();
window.setInterval(fetchDbRowsStable, 6000);

refreshDataLiveDot();
window.setInterval(refreshDataLiveDot, 5000);
