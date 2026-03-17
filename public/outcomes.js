/* global io */

// -----------------------
// Safe Socket.IO init
// -----------------------
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

// Modal
const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");
const modalSubEl = document.getElementById("modalSub");
const modalBodyEl = document.getElementById("modalBody");

let dbRowsRaw = [];
let allAlerts = [];

// -----------------------
// helpers
// -----------------------
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

function fmt2(x) {
  if (x == null || x === "" || Number.isNaN(Number(x))) return "—";
  return Number(x).toFixed(2);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[m]));
}

function findAlertById(id) {
  return (allAlerts || []).find((a) => String(a.id) === String(id)) || null;
}

// -----------------------
// DATA LIVE dot
// -----------------------
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

// -----------------------
// strategies dropdown
// -----------------------
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

// -----------------------
// modal helpers
// -----------------------
function modalOpen() {
  if (!modalEl) return;
  modalEl.style.display = "block";
}
function modalClose() {
  if (!modalEl) return;
  modalEl.style.display = "none";
}
modalCloseEl?.addEventListener("click", modalClose);
modalEl?.addEventListener("click", (e) => {
  if (e.target === modalEl) modalClose();
});

// -----------------------
// Candle aggregation + indicators
// -----------------------
function aggregateBars(bars1m, timeframeMin) {
  const tf = Math.max(1, Math.floor(Number(timeframeMin || 1)));
  if (!Array.isArray(bars1m) || !bars1m.length || tf === 1) {
    return (bars1m || []).map((b) => ({
      ts: Number(b.ts),
      o: Number(b.o),
      h: Number(b.h),
      l: Number(b.l),
      c: Number(b.c),
      v: Number(b.v || 0)
    }));
  }

  const out = [];
  let cur = null;

  const bucketOf = (ts) => Math.floor(ts / (tf * 60_000)) * (tf * 60_000);

  for (const b of bars1m) {
    const ts = Number(b.ts);
    const o = Number(b.o);
    const h = Number(b.h);
    const l = Number(b.l);
    const c = Number(b.c);
    const v = Number(b.v || 0);
    if (!Number.isFinite(ts) || ![o, h, l, c].every(Number.isFinite)) continue;

    const bucket = bucketOf(ts);

    if (!cur || cur.bucket !== bucket) {
      if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });
      cur = { bucket, o, h, l, c, v };
    } else {
      cur.h = Math.max(cur.h, h);
      cur.l = Math.min(cur.l, l);
      cur.c = c;
      cur.v += v;
    }
  }

  if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });

  return out;
}

function emaSeries(closes, period) {
  const p = Math.max(1, Math.floor(Number(period || 0)));
  if (!p || !Array.isArray(closes) || closes.length === 0) return [];
  const k = 2 / (p + 1);
  const out = [];
  let ema = null;
  for (const x of closes) {
    const c = Number(x);
    if (!Number.isFinite(c)) {
      out.push(null);
      continue;
    }
    if (ema == null) ema = c;
    else ema = c * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function vwapSeries(bars) {
  let pv = 0;
  let v = 0;
  const out = [];
  for (const b of bars) {
    const h = Number(b.h), l = Number(b.l), c = Number(b.c), vol = Number(b.v || 0);
    const typical = (h + l + c) / 3;
    if (Number.isFinite(typical) && Number.isFinite(vol) && vol > 0) {
      pv += typical * vol;
      v += vol;
      out.push(v ? (pv / v) : null);
    } else {
      out.push(v ? (pv / v) : null);
    }
  }
  return out;
}

// -----------------------
// Chart render (canvas)
// -----------------------
function drawChart(canvas, bars, opts) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = "#0b0f1a";
  ctx.fillRect(0, 0, w, h);

  if (!Array.isArray(bars) || !bars.length) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "14px system-ui";
    ctx.fillText("No candles found for this window.", 18, 28);
    return;
  }

  const pad = 18;
  const volH = 70;
  const chartH = h - pad * 2 - volH - 10;

  let lo = Infinity, hi = -Infinity, vmax = 0;
  for (const b of bars) {
    lo = Math.min(lo, Number(b.l));
    hi = Math.max(hi, Number(b.h));
    vmax = Math.max(vmax, Number(b.v || 0));
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;

  const plotW = w - pad * 2;
  const n = bars.length;
  const candleW = Math.max(3, Math.floor(plotW / n));

  const yOf = (price) => {
    const t = (Number(price) - lo) / (hi - lo);
    return pad + (1 - t) * chartH;
  };

  const xOf = (i) => pad + i * candleW + Math.floor(candleW / 2);

  const entryTs = Number(opts?.entryTs || 0);
  const exitTs = Number(opts?.exitTs || 0);

  const closestIdx = (ts) => {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(Number(bars[i].ts) - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const entryIdx = closestIdx(entryTs);
  const exitIdx = closestIdx(exitTs);

  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let i = 0; i <= 4; i++) {
    const y = pad + (chartH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  const closes = bars.map((b) => Number(b.c));
  const emaPeriods = Array.isArray(opts?.emaPeriods) ? opts.emaPeriods : [];
  const emaMap = {};
  for (const p of emaPeriods) emaMap[p] = emaSeries(closes, p);

  const vwap = opts?.showVwap ? vwapSeries(bars) : [];

  if (vwap.length) {
    ctx.strokeStyle = "rgba(120,180,255,0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = vwap[i];
      if (v == null) continue;
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  const emaColors = [
    "rgba(255,255,255,0.75)",
    "rgba(255,220,120,0.85)",
    "rgba(180,255,180,0.75)",
    "rgba(255,140,200,0.75)"
  ];
  let ci = 0;
  for (const p of emaPeriods) {
    const s = emaMap[p] || [];
    ctx.strokeStyle = emaColors[ci % emaColors.length];
    ci++;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = s[i];
      if (v == null) continue;
      const x = xOf(i);
      const y = yOf(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const o = Number(b.o), c = Number(b.c), hh = Number(b.h), ll = Number(b.l);
    const vol = Number(b.v || 0);

    const x = xOf(i);

    ctx.strokeStyle = "rgba(255,255,255,0.50)";
    ctx.beginPath();
    ctx.moveTo(x, yOf(hh));
    ctx.lineTo(x, yOf(ll));
    ctx.stroke();

    const up = c >= o;
    ctx.fillStyle = up ? "rgba(80,200,120,0.85)" : "rgba(255,120,80,0.85)";
    const bodyTop = Math.min(yOf(o), yOf(c));
    const bodyBot = Math.max(yOf(o), yOf(c));
    const bw = Math.max(2, candleW - 2);
    ctx.fillRect(x - Math.floor(bw / 2), bodyTop, bw, Math.max(2, bodyBot - bodyTop));

    const vh = vmax ? Math.round((vol / vmax) * volH) : 0;
    ctx.fillStyle = up ? "rgba(80,200,120,0.35)" : "rgba(255,120,80,0.35)";
    ctx.fillRect(x - Math.floor(bw / 2), pad + chartH + 10 + (volH - vh), bw, vh);
  }

  const levelPrice = opts?.levelPrice;
  const structureLevel = opts?.structureLevel;

  const drawHLine = (price, color) => {
    if (price == null || !Number.isFinite(Number(price))) return;
    const y = yOf(price);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  };

  drawHLine(levelPrice, "rgba(255,255,255,0.25)");
  drawHLine(structureLevel, "rgba(255,255,0,0.35)");

  if (entryIdx != null && exitIdx != null && exitIdx !== entryIdx) {
    const leftIdx = Math.min(entryIdx, exitIdx);
    const rightIdx = Math.max(entryIdx, exitIdx);

    const xL = xOf(leftIdx);
    const xR = xOf(rightIdx);

    const topY = pad;
    const botY = pad + chartH;

    ctx.save();

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(pad, topY, Math.max(0, xL - pad), botY - topY);
    ctx.fillRect(xR, topY, Math.max(0, (w - pad) - xR), botY - topY);

    const feather = 28;

    const gradL = ctx.createLinearGradient(xL - feather, 0, xL + feather, 0);
    gradL.addColorStop(0, "rgba(0,0,0,0.55)");
    gradL.addColorStop(0.5, "rgba(0,0,0,0.25)");
    gradL.addColorStop(1, "rgba(0,0,0,0.00)");
    ctx.fillStyle = gradL;
    ctx.fillRect(xL - feather, topY, feather * 2, botY - topY);

    const gradR = ctx.createLinearGradient(xR - feather, 0, xR + feather, 0);
    gradR.addColorStop(0, "rgba(0,0,0,0.00)");
    gradR.addColorStop(0.5, "rgba(0,0,0,0.25)");
    gradR.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = gradR;
    ctx.fillRect(xR - feather, topY, feather * 2, botY - topY);

    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.strokeRect(xL, topY, Math.max(1, xR - xL), botY - topY);

    ctx.restore();
  }

  if (entryIdx != null) {
    const x = xOf(entryIdx);
    ctx.strokeStyle = "rgba(0,200,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad + chartH);
    ctx.stroke();
  }

  if (exitIdx != null) {
    const x = xOf(exitIdx);
    ctx.strokeStyle = "rgba(255,80,80,0.95)";
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad + chartH);
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,0.78)";
  ctx.font = "12px system-ui";
  const legend = [
    opts?.tfLabel ? `TF: ${opts.tfLabel}` : null,
    opts?.builtFrom ? opts.builtFrom : null,
    opts?.showVwap ? "VWAP" : null,
    emaPeriods.length ? `EMA: ${emaPeriods.join(",")}` : null
  ].filter(Boolean).join(" • ");
  if (legend) ctx.fillText(legend, pad, h - pad);
}

// -----------------------
// Smooth pan/zoom viewport
// -----------------------
async function openModalForRow(r) {
  if (!modalEl || !modalBodyEl || !modalSubEl) return;

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

  const tfMin = Math.max(1, Math.floor(Number(r.timeframeMin || 1)));
  const tfLabel = `${tfMin}m`;

  const emaPeriods = Array.isArray(r.emaPeriods) ? r.emaPeriods : [];
  const showVwap = Boolean(r.showVwap);

  const detailHtml = `
    <div style="margin-bottom:12px;">
      <div><b>Details</b></div>
      <div>Strategy: <b>${escapeHtml(strat)}</b></div>
      <div>Time: ${escapeHtml(fmtTime(r.ts))}</div>
      <div>Symbol: <b>${escapeHtml(r.symbol || "")}</b></div>
      <div>Market: ${escapeHtml(r.market || "—")} • RS: ${escapeHtml(r.rs || "—")}</div>
      <div>Level: ${escapeHtml(r.level || "—")} • Structure: ${r.structureLevel != null ? fmt2(r.structureLevel) : "—"}</div>
      <div>Status: <b>${escapeHtml(r.status || "—")}</b> • Stopped: <b>${r.stoppedOut ? "YES" : "NO"}</b> • PnL: <b>${r.pnlPct != null ? fmt2(r.pnlPct) + "%" : "—"}</b></div>
    </div>

    <div class="small muted" style="margin-bottom:8px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
      <div>
        Chart snapshot (${escapeHtml(tfLabel)} candles built from 1m source) • Entry (cyan) • Exit (red)
        <span class="small" style="opacity:0.7;">(wheel = zoom, drag = pan)</span>
      </div>
      <button id="recenterBtn" class="btn small">Recenter</button>
    </div>

    <canvas id="outcomeChart"
      width="1100"
      height="440"
      style="width:100%; border-radius:12px; border:1px solid rgba(255,255,255,0.10);"></canvas>
  `;

  modalBodyEl.innerHTML = detailHtml;

  function closestIdxByTs(bars, ts) {
    if (!Array.isArray(bars) || !bars.length) return 0;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const d = Math.abs(Number(bars[i].ts) - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  let barsTfAll = [];
  try {
    const minutes = 2000;
    const res = await fetch(
      `/api/candles?symbol=${encodeURIComponent(r.symbol)}&end=${encodeURIComponent(entryTs)}&minutes=${minutes}`,
      { cache: "no-store" }
    );
    const j = await res.json().catch(() => null);
    const bars1m = Array.isArray(j?.bars) ? j.bars : [];
    barsTfAll = aggregateBars(bars1m, tfMin);
  } catch {
    barsTfAll = [];
  }

  const canvas = document.getElementById("outcomeChart");
  if (!canvas || !canvas.getContext) return;

  const total = barsTfAll.length;
  let visible = total ? Math.max(30, Math.min(90, total)) : 30;

  const entryIdxAll = total ? closestIdxByTs(barsTfAll, entryTs) : 0;
  let start = total ? Math.max(0, Math.min(entryIdxAll - Math.floor(visible * 0.6), Math.max(0, total - visible))) : 0;

  const initialVisible = visible;
  const initialStart = start;

  let raf = 0;
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!total) return;

      start = Math.max(0, Math.min(start, Math.max(0, total - visible)));
      const end = Math.max(0, Math.min(start + visible, total));
      const slice = barsTfAll.slice(start, end);

      drawChart(canvas, slice, {
        entryTs,
        exitTs,
        tfLabel,
        emaPeriods,
        showVwap,
        levelPrice: r.levelPrice != null && r.levelPrice !== "" ? Number(r.levelPrice) : null,
        structureLevel: r.structureLevel != null && r.structureLevel !== "" ? Number(r.structureLevel) : null
      });
    });
  };

  if (total) redraw();

  document.getElementById("recenterBtn")?.addEventListener("click", () => {
    visible = initialVisible;
    start = initialStart;
    redraw();
  });

  canvas.style.cursor = "grab";

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!total) return;

      const rect = canvas.getBoundingClientRect();
      const mx = Math.max(0, Math.min((e.clientX - rect.left) / Math.max(1, rect.width), 1));
      const anchor = start + Math.floor(visible * mx);

      const factor = e.deltaY < 0 ? 0.98 : 1.02;
      const nextVisible = Math.max(30, Math.min(Math.round(visible * factor), Math.max(30, total)));
      const nextStart = Math.max(0, Math.min(anchor - Math.floor(nextVisible * mx), Math.max(0, total - nextVisible)));

      visible = nextVisible;
      start = nextStart;

      redraw();
    },
    { passive: false }
  );

  let dragging = false;
  let dragStartX = 0;
  let dragStartStart = 0;

  canvas.addEventListener("mousedown", (e) => {
    if (!total) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartStart = start;
    canvas.style.cursor = "grabbing";
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    canvas.style.cursor = "grab";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging || !total) return;

    const rect = canvas.getBoundingClientRect();
    const dx = e.clientX - dragStartX;

    const barsPerPx = visible / Math.max(1, rect.width);
    const PAN_MULT = 0.6;
    const deltaBars = Math.round(dx * barsPerPx * PAN_MULT);
    start = Math.max(0, Math.min(dragStartStart - deltaBars, Math.max(0, total - visible)));
    redraw();
  });

  const a = findAlertById(r.alertId);
  if (a) {
    const msg = escapeHtml(String(a.message || ""));
    modalBodyEl.insertAdjacentHTML("beforeend", `<div style="margin-top:10px;"><b>Raw message:</b> ${msg}</div>`);
  }
}

// -----------------------
// DB filters + render
// -----------------------
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
  else cutoff = 0;

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
  // Prefer explicit exit return if present (DB-native)
  if (row?.exitReturnPct !== "" && row?.exitReturnPct != null && Number.isFinite(Number(row.exitReturnPct))) {
    return Number(row.exitReturnPct);
  }

  // STOP is authoritative
  if (row?.stoppedOut && row?.stopReturnPct !== "" && row?.stopReturnPct != null && Number.isFinite(Number(row.stopReturnPct))) {
    return Number(row.stopReturnPct);
  }

  // Legacy broker-like exit stored inside returns_json
  if (!row?.stoppedOut && row?.retExit !== "" && row?.retExit != null && Number.isFinite(Number(row.retExit))) {
    return Number(row.retExit);
  }

  // Fallback to checkpoint returns
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

// filters
dbSymEl?.addEventListener("input", renderDbTable);
dbStatusEl?.addEventListener("change", renderDbTable);
dbRangeEl?.addEventListener("change", renderDbTable);
dbStoppedOnlyEl?.addEventListener("change", renderDbTable);
dbStrategyEl?.addEventListener("change", renderDbTable);
refreshBtn?.addEventListener("click", fetchDbRowsStable);

// socket wiring
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

// boot
loadStrategies().then(() => fetchDbRowsStable());
setInterval(fetchDbRowsStable, 6000);

refreshDataLiveDot();
setInterval(refreshDataLiveDot, 5000);