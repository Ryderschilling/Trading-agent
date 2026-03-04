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
    if (!Number.isFinite(c)) { out.push(null); continue; }
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
// bars = viewport slice only (for smoothness)
// -----------------------
function drawChart(canvas, bars, opts) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // solid panel background
  ctx.fillStyle = "#0b0f1a";
  ctx.fillRect(0, 0, w, h);

  if (!Array.isArray(bars) || !bars.length) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "14px system-ui";
    ctx.fillText("No candles found for this window.", 18, 28);
    return;
  }

  // layout
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

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  for (let i = 0; i <= 4; i++) {
    const y = pad + (chartH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  // overlays
  const closes = bars.map((b) => Number(b.c));
  const emaPeriods = Array.isArray(opts?.emaPeriods) ? opts.emaPeriods : [];
  const emaMap = {};
  for (const p of emaPeriods) emaMap[p] = emaSeries(closes, p);

  const vwap = opts?.showVwap ? vwapSeries(bars) : [];

  // VWAP line
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
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  // EMA lines
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
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // candles + volume
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const o = Number(b.o), c = Number(b.c), hh = Number(b.h), ll = Number(b.l);
    const vol = Number(b.v || 0);

    const x = xOf(i);

    // wick
    ctx.strokeStyle = "rgba(255,255,255,0.50)";
    ctx.beginPath();
    ctx.moveTo(x, yOf(hh));
    ctx.lineTo(x, yOf(ll));
    ctx.stroke();

    // body
    const up = c >= o;
    ctx.fillStyle = up ? "rgba(80,200,120,0.85)" : "rgba(255,120,80,0.85)";
    const bodyTop = Math.min(yOf(o), yOf(c));
    const bodyBot = Math.max(yOf(o), yOf(c));
    const bw = Math.max(2, candleW - 2);
    ctx.fillRect(x - Math.floor(bw / 2), bodyTop, bw, Math.max(2, bodyBot - bodyTop));

    // volume bar
    const vh = vmax ? Math.round((vol / vmax) * volH) : 0;
    ctx.fillStyle = up ? "rgba(80,200,120,0.35)" : "rgba(255,120,80,0.35)";
    ctx.fillRect(x - Math.floor(bw / 2), pad + chartH + 10 + (volH - vh), bw, vh);
  }

  // horizontal lines: level / structure
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

  // Level = white-ish, Structure = yellow (this is your yellow line)
  drawHLine(levelPrice, "rgba(255,255,255,0.25)");
  drawHLine(structureLevel, "rgba(255,255,0,0.35)");

  // entry / exit markers (cyan = entry, red = exit)
  const entryTs = Number(opts?.entryTs || 0);
  const exitTs = Number(opts?.exitTs || 0);

  const closestIdx = (ts) => {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(Number(bars[i].ts) - ts);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const entryIdx = closestIdx(entryTs);
  if (entryIdx != null) {
    const x = xOf(entryIdx);
    ctx.strokeStyle = "rgba(0,200,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad + chartH);
    ctx.stroke();
  }

  const exitIdx = closestIdx(exitTs);
  if (exitIdx != null) {
    const x = xOf(exitIdx);
    ctx.strokeStyle = "rgba(255,80,80,0.95)";
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, pad + chartH);
    ctx.stroke();
  }

  // legend
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
// Smooth pan/zoom viewport (no refetch per wheel)
// -----------------------
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function openModalForRow(r) {
  if (!modalEl || !modalBodyEl || !modalSubEl) return;

  // --------- basics ----------
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

  const tfMin = Math.max(1, Math.floor(Number(r.timeframeMin || 1))); // strategy timeframe (ex: 15)
  console.log("[outcomes] timeframeMin from row:", r.timeframeMin, "-> tfMin used:", tfMin);
  const tfLabel = `${tfMin}m`;

  const emaPeriods = Array.isArray(r.emaPeriods) ? r.emaPeriods : [];
  const showVwap = Boolean(r.showVwap);

  // --------- modal html ----------
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

  // --------- helpers ----------
  const clampLocal = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

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

  // --------- fetch once (max 2000 minutes), aggregate to strategy TF ----------
  let barsTfAll = [];
  try {
    const minutes = 2000; // server clamps to 2000 anyway
    const res = await fetch(
      `/api/candles?symbol=${encodeURIComponent(r.symbol)}&end=${encodeURIComponent(entryTs)}&minutes=${minutes}`,
      { cache: "no-store" }
    );
    const j = await res.json().catch(() => null);
    const bars1m = Array.isArray(j?.bars) ? j.bars : [];
    barsTfAll = aggregateBars(bars1m, tfMin); // IMPORTANT: displayed candles are strategy TF
    console.log("[chart] tfMin", tfMin, "bars1m", bars1m.length, "barsTf", barsTfAll.length);
  } catch {
    barsTfAll = [];
  }

  const canvas = document.getElementById("outcomeChart");
  if (!canvas || !canvas.getContext) {
    const a = findAlertById(r.alertId);
    if (a) {
      const msg = escapeHtml(String(a.message || ""));
      modalBodyEl.insertAdjacentHTML("beforeend", `<div style="margin-top:10px;"><b>Raw message:</b> ${msg}</div>`);
    }
    return;
  }

  // --------- viewport state (index-based, smooth) ----------
  const total = barsTfAll.length;

  // choose initial visible count: not too wide, not too tight
  let visible = total ? clampLocal(90, 30, Math.max(30, total)) : 30;

  const entryIdxAll = total ? closestIdxByTs(barsTfAll, entryTs) : 0;

  // place entry around 60% across the window
  let start = total ? clampLocal(entryIdxAll - Math.floor(visible * 0.6), 0, Math.max(0, total - visible)) : 0;

  const initialVisible = visible;
  const initialStart = start;

  // RAF throttle redraw
  let raf = 0;
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (!total) return;

      start = clampLocal(start, 0, Math.max(0, total - visible));
      const end = clampLocal(start + visible, 0, total);
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

  // initial draw
  if (total) redraw();

  // --------- recenter ----------
  const recenterBtn = document.getElementById("recenterBtn");
  recenterBtn?.addEventListener("click", () => {
    visible = initialVisible;
    start = initialStart;
    redraw();
  });

  // --------- zoom (less sensitive) anchored at cursor ----------
  canvas.style.cursor = "grab";

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!total) return;

      const rect = canvas.getBoundingClientRect();
      const mx = clampLocal((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const anchor = start + Math.floor(visible * mx);

      // smaller steps = less touchy
      const factor = e.deltaY < 0 ? 0.98 : 1.02; // 2% step (much smoother)
      const nextVisible = clampLocal(Math.round(visible * factor), 30, Math.max(30, total));

      const nextStart = clampLocal(anchor - Math.floor(nextVisible * mx), 0, Math.max(0, total - nextVisible));

      visible = nextVisible;
      start = nextStart;

      redraw();
    },
    { passive: false }
  );

  // --------- pan (drag) ----------
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

    // lower sensitivity: bars-per-pixel based on viewport
    const barsPerPx = visible / Math.max(1, rect.width);
    const PAN_MULT = 0.6; // <— lower = less sensitive
const deltaBars = Math.round(dx * barsPerPx * PAN_MULT);
start = clampLocal(dragStartStart - deltaBars, 0, Math.max(0, total - visible));
    redraw();
  });

  // --------- raw message ----------
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
  if (row?.stoppedOut && row?.stopReturnPct !== "" && row?.stopReturnPct != null && Number.isFinite(Number(row.stopReturnPct))) {
    return Number(row.stopReturnPct);
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

    // keep pnl on row for modal
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

async function fetchDbRows() {
  try {
    const r = await fetch("/api/dbrows", { cache: "no-store" });
    const j = await r.json();
    dbRowsRaw = Array.isArray(j?.rows) ? j.rows : [];
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
refreshBtn?.addEventListener("click", fetchDbRows);

// -----------------------
// socket wiring
// -----------------------
if (socket) {
  socket.on("connect", () => socketDot?.classList.add("on"));
  socket.on("disconnect", () => socketDot?.classList.remove("on"));

  socket.on("init", (payload) => {
    allAlerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    fetchDbRows();
  });

  socket.on("alert", (a) => {
    allAlerts.push(a);
    fetchDbRows();
  });
} else {
  socketDot?.classList.remove("on");
}

// boot
loadStrategies().then(() => fetchDbRows());
setInterval(fetchDbRows, 6000);