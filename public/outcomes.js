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
const dbSymEl = document.getElementById("dbSym");
const dbStatusEl = document.getElementById("dbStatus");
const dbRangeEl = document.getElementById("dbRange");
const dbStoppedOnlyEl = document.getElementById("dbStoppedOnly");
const refreshBtn = document.getElementById("refreshBtn");
const dbStrategyEl = document.getElementById("dbStrategy");

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

async function loadStrategies() {
  if (!dbStrategyEl) return;
  try {
    const res = await fetch("/api/rulesets", { cache: "no-store" });
    const j = await res.json();
    const list = Array.isArray(j?.rulesets) ? j.rulesets : [];

    dbStrategyEl.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "All strategies";
    dbStrategyEl.appendChild(defaultOpt);

    for (const rs of list) {
      const opt = document.createElement("option");
      opt.value = String(rs.version);
      opt.textContent = rs.name || `v${rs.version}`;
      dbStrategyEl.appendChild(opt);
    }
  } catch {
    // ignore
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
    lo = Math.min(lo, Number(b.l));
    hi = Math.max(hi, Number(b.h));
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
    const x = xOf(i);
    const wickX = wickXOf(i);
    const yH = yOf(b.h);
    const yL = yOf(b.l);
    const yO = yOf(b.o);
    const yC = yOf(b.c);
    const up = b.c >= b.o;

    ctx.strokeStyle = up ? "rgba(74, 222, 128, 0.75)" : "rgba(248, 113, 113, 0.78)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wickX, yH);
    ctx.lineTo(wickX, yL);
    ctx.stroke();

    ctx.fillStyle = up ? "rgba(74, 222, 128, 0.92)" : "rgba(248, 113, 113, 0.92)";
    const top = Math.min(yO, yC);
    const height = Math.max(1.5, Math.abs(yC - yO));
    const bodyLeft = Math.round((x - bodyW / 2) * 2) / 2;
    ctx.fillRect(bodyLeft, top, bodyW, height);
  }

  const markerY = padTop + 8;
  const markers = [
    {
      idx: entryIdx,
      label: "Entry",
      lineColor: "rgba(45, 212, 255, 0.88)",
      pillFill: "rgba(45, 212, 255, 0.16)",
      pillText: "#96ecff",
    },
    {
      idx: exitIdx,
      label: "Exit",
      lineColor: "rgba(251, 113, 133, 0.88)",
      pillFill: "rgba(251, 113, 133, 0.16)",
      pillText: "#ffb0bf",
    },
  ];

  for (const marker of markers) {
    if (marker.idx == null) continue;
    const x = wickXOf(marker.idx);
    ctx.strokeStyle = marker.lineColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();

    ctx.save();
    ctx.font = "10px system-ui";
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
}

function localDayWindow(ts) {
  const d = new Date(Number(ts || Date.now()));
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
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
  const dayWindow = localDayWindow(entryTs || Date.now());
  const fullDayMinutes = Math.min(2000, Math.max(390, Math.ceil((dayWindow.end - dayWindow.start) / 60_000)));
  const widestEnd = Math.max(Number(entryTs || 0), Number(exitTs || 0), Date.now() - 60_000) + 180 * 60_000;
  const candidates = [
    { label: "trade day", end: dayWindow.end, minutes: fullDayMinutes, weight: 30_000 },
    { label: "extended context", end: widestEnd, minutes: 2000, weight: 20_000 },
    { label: "widest available context", end: Number(entryTs || Date.now()), minutes: 2000, weight: 10_000 },
  ];

  let best = { bars1m: [], label: "No data" };

  for (const candidate of candidates) {
    try {
      const bars1m = await requestCandles(symbol, candidate.end, candidate.minutes);
      const score = scoreRange(bars1m, entryTs, exitTs, candidate.weight);
      const bestScore = scoreRange(best.bars1m, entryTs, exitTs, 0);
      if (score > bestScore) {
        best = { bars1m, label: candidate.label };
      }
      if (candidate.label === "trade day" && bars1m.length) {
        const first = Number(bars1m[0].ts);
        const last = Number(bars1m[bars1m.length - 1].ts) + 60_000;
        if (Number(entryTs) >= first && Number(entryTs) <= last) {
          best = { bars1m, label: candidate.label };
          break;
        }
      }
    } catch {
      // ignore and fall through
    }
  }

  return best;
}

function chooseDisplayTimeframe(baseTfMin, bars1mLength) {
  void baseTfMin;
  const totalBars = Math.max(0, Math.floor(Number(bars1mLength || 0)));
  if (totalBars <= 0 || totalBars <= DISPLAY_BAR_TARGET_MAX) return 1;

  const candidates = DISPLAY_TIMEFRAME_STEPS.map((tf) => ({
    tf,
    count: Math.max(1, Math.ceil(totalBars / tf)),
  }));
  const preferred = candidates
    .filter((candidate) => candidate.count >= DISPLAY_BAR_TARGET_MIN && candidate.count <= DISPLAY_BAR_TARGET_MAX)
    .sort((a, b) => Math.abs(a.count - DISPLAY_BAR_TARGET_IDEAL) - Math.abs(b.count - DISPLAY_BAR_TARGET_IDEAL) || a.tf - b.tf);
  if (preferred.length) return preferred[0].tf;

  const capped = candidates
    .filter((candidate) => candidate.count <= DISPLAY_BAR_TARGET_MAX)
    .sort((a, b) => b.count - a.count || a.tf - b.tf);
  if (capped.length) return capped[0].tf;

  return DISPLAY_TIMEFRAME_STEPS[DISPLAY_TIMEFRAME_STEPS.length - 1];
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
            <span class="outcome-chip">Entry</span>
            <span class="outcome-chip">Exit</span>
            ${showVwap ? `<span class="outcome-chip">VWAP</span>` : ""}
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
    const barsDisplay = aggregateBars(snapshot.bars1m, displayTfMin);

    drawChart(canvas, barsDisplay, {
      entryTs,
      exitTs,
      showVwap,
    });

    if (chartContextEl) {
      const rangeStart = barsDisplay.length ? fmtDateTime(barsDisplay[0].ts) : "—";
      const rangeEnd = barsDisplay.length ? fmtDateTime(barsDisplay[barsDisplay.length - 1].ts) : "—";
      chartContextEl.textContent =
        `Snapshot range: ${snapshot.label}. Showing ${displayTfMin}m candles built from 1m source so the broader move stays visible. ` +
        `Range ${rangeStart} to ${rangeEnd}.`;
    }

    const onResize = () => {
      drawChart(canvas, barsDisplay, {
        entryTs,
        exitTs,
        showVwap,
      });
    };
    window.addEventListener("resize", onResize);
    modalCleanup = () => window.removeEventListener("resize", onResize);
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
  const sym = String(dbSymEl?.value || "").trim().toUpperCase();
  const status = String(dbStatusEl?.value || "").trim().toUpperCase();
  const stoppedOnly = Boolean(dbStoppedOnlyEl?.checked);
  const strat = String(dbStrategyEl?.value || "").trim();

  const range = String(dbRangeEl?.value || "all").toLowerCase();
  const now = Date.now();
  let cutoff = 0;
  if (range === "day") cutoff = now - 1 * 24 * 60 * 60_000;
  else if (range === "week") cutoff = now - 7 * 24 * 60 * 60_000;
  else if (range === "month") cutoff = now - 30 * 24 * 60 * 60_000;
  else if (range === "year") cutoff = now - 365 * 24 * 60 * 60_000;

  return (rows || []).filter((r) => {
    if (sym && String(r.symbol || "").toUpperCase() !== sym) return false;
    if (status && String(r.status || "").toUpperCase() !== status) return false;
    if (stoppedOnly && !r.stoppedOut) return false;
    if (strat && String(r.strategyVersion || "") !== strat) return false;
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

function renderDbTable() {
  if (!dbBodyEl || !dbEmptyEl) return;

  const rows = applyDbFilters(dbRowsRaw);
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
    const pnl = computePnlPct(r);
    r.pnlPct = pnl;

    tr.appendChild(td(stratLabel));
    tr.appendChild(td(r.symbol || ""));
    tr.appendChild(td(fmtTime(r.ts)));
    tr.appendChild(td(r.market || "—"));
    tr.appendChild(td(r.rs || "—"));
    tr.appendChild(td(r.level || "—"));
    tr.appendChild(td(r.status || "—"));
    tr.appendChild(td(r.stoppedOut ? "YES" : "NO"));
    tr.appendChild(td(pnl == null ? "—" : `${fmt2(pnl)}%`));

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

dbSymEl?.addEventListener("input", renderDbTable);
dbStatusEl?.addEventListener("change", renderDbTable);
dbRangeEl?.addEventListener("change", renderDbTable);
dbStoppedOnlyEl?.addEventListener("change", renderDbTable);
dbStrategyEl?.addEventListener("change", renderDbTable);
refreshBtn?.addEventListener("click", fetchDbRowsStable);

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

loadStrategies().then(() => fetchDbRowsStable());
window.setInterval(fetchDbRowsStable, 6000);

refreshDataLiveDot();
window.setInterval(refreshDataLiveDot, 5000);
