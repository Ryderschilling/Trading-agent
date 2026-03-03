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

// Strategy selector
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
  modalEl.style.display = "flex";
}
function modalClose() {
  if (!modalEl) return;
  modalEl.style.display = "none";
}

modalCloseEl?.addEventListener("click", modalClose);
modalEl?.addEventListener("click", (e) => {
  if (e.target === modalEl) modalClose();
});

// Draw a candle snapshot into a canvas (simple + deterministic)
function drawCandleSnapshot(canvas, bars, entryTs) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, 0, w, h);

  if (!Array.isArray(bars) || !bars.length) {
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "14px system-ui";
    ctx.fillText("No candles found for this window.", 18, 28);
    return;
  }

  let lo = Infinity, hi = -Infinity;
  for (const b of bars) {
    lo = Math.min(lo, Number(b.l));
    hi = Math.max(hi, Number(b.h));
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;

  const pad = 18;
  const plotW = w - pad * 2;
  const plotH = h - pad * 2;

  const n = bars.length;
  const candleW = Math.max(2, Math.floor(plotW / n));

  const yOf = (price) => {
    const t = (Number(price) - lo) / (hi - lo);
    return pad + (1 - t) * plotH;
  };

  // candles
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const o = Number(b.o), c = Number(b.c), hh = Number(b.h), ll = Number(b.l);
    const x = pad + i * candleW + Math.floor(candleW / 2);

    const yH = yOf(hh);
    const yL = yOf(ll);
    const yO = yOf(o);
    const yC = yOf(c);

    // wick
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.beginPath();
    ctx.moveTo(x, yH);
    ctx.lineTo(x, yL);
    ctx.stroke();

    // body
    const up = c >= o;
    ctx.fillStyle = up ? "rgba(80,200,120,0.85)" : "rgba(255,120,80,0.85)";
    const bodyTop = Math.min(yO, yC);
    const bodyBot = Math.max(yO, yC);
    const bw = Math.max(2, candleW - 2);

    ctx.fillRect(x - Math.floor(bw / 2), bodyTop, bw, Math.max(2, bodyBot - bodyTop));
  }

  // entry line
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(Number(bars[i].ts) - entryTs);
    if (d < bestD) { bestD = d; bestIdx = i; }
  }

  const xEntry = pad + bestIdx * candleW + Math.floor(candleW / 2);
  ctx.strokeStyle = "rgba(255,255,0,0.9)";
  ctx.beginPath();
  ctx.moveTo(xEntry, pad);
  ctx.lineTo(xEntry, h - pad);
  ctx.stroke();
}

async function openModalForRow(r) {
  if (!modalEl || !modalBodyEl || !modalSubEl) return;

  modalSubEl.textContent = `${r.symbol || ""} • ${r.strategyName || `v${r.strategyVersion || ""}`}`;
  modalBodyEl.innerHTML = "Loading…";
  modalOpen();

  const endTs = Number(r.ts || Date.now());

  // Build detail HTML (simple + useful)
  const detailHtml = `
    <div style="margin-bottom:12px;">
      <div><b>Details</b></div>
      <div>Strategy: <b>${escapeHtml(r.strategyName || `v${r.strategyVersion || ""}`)}</b></div>
      <div>Time: ${escapeHtml(fmtTime(r.ts))}</div>
      <div>Symbol: <b>${escapeHtml(r.symbol || "")}</b></div>
      <div>Market: ${escapeHtml(r.market || "—")} • RS: ${escapeHtml(r.rs || "—")}</div>
      <div>Level: ${escapeHtml(r.level || "—")} • Structure: ${r.structureLevel != null ? fmt2(r.structureLevel) : "—"}</div>
      <div>Status: <b>${escapeHtml(r.status || "—")}</b> • Stopped: <b>${r.stoppedOut ? "YES" : "NO"}</b></div>
    </div>
    <div class="small muted" style="margin-bottom:8px;">Chart snapshot (from stored 1m candles)</div>
    <canvas id="outcomeChart" width="1000" height="340" style="width:100%; border-radius:12px; border:1px solid rgba(255,255,255,0.10);"></canvas>
  `;

  modalBodyEl.innerHTML = detailHtml;

  // Render chart
  try {
    const res = await fetch(`/api/candles?symbol=${encodeURIComponent(r.symbol)}&end=${encodeURIComponent(endTs)}&minutes=240`, { cache: "no-store" });
    const j = await res.json().catch(() => null);
    const bars = Array.isArray(j?.bars) ? j.bars : [];
    const canvas = document.getElementById("outcomeChart");
    drawCandleSnapshot(canvas, bars, endTs);
  } catch {
    // leave the canvas blank
  }

  // If alert exists, optionally append raw message underneath
  const a = findAlertById(r.alertId);
  if (a) {
    const msg = escapeHtml(String(a.message || ""));
    modalBodyEl.innerHTML += `<div style="margin-top:10px;"><b>Raw message:</b> ${msg}</div>`;
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

  const range = String(dbRangeEl?.value || "ALL").toUpperCase();
  const now = Date.now();
  const cutoff =
    range === "DAY" ? now - 1 * 24 * 60 * 60_000 :
    range === "WEEK" ? now - 7 * 24 * 60 * 60_000 :
    range === "MONTH" ? now - 30 * 24 * 60 * 60_000 :
    range === "YEAR" ? now - 365 * 24 * 60 * 60_000 :
    null;

  return (rows || []).filter((r) => {
    if (sym && String(r.symbol || "").toUpperCase() !== sym) return false;
    if (status && String(r.status || "").toUpperCase() !== status) return false;
    if (stoppedOnly && !r.stoppedOut) return false;
    if (strat && String(r.strategyVersion || "") !== strat) return false;
    if (cutoff != null && Number(r.ts || 0) < cutoff) return false;
    return true;
  });
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

    const pickPnl = (row) => {
      // Prefer explicit stop return
      if (row?.stoppedOut && row?.stopReturnPct !== "" && row?.stopReturnPct != null && Number.isFinite(Number(row.stopReturnPct))) {
        return Number(row.stopReturnPct);
      }

      // Prefer latest available checkpoint return
      const candidates = [row?.ret60m, row?.ret30m, row?.ret15m, row?.ret5m];
      for (const v of candidates) {
        if (v !== "" && v != null && Number.isFinite(Number(v))) return Number(v);
      }

      return null;
    };

    // Table columns (must match outcomes.html <thead>):
    // Strategy | Symbol | Time | Market | RS | Level | Status | Stopped | PnL %
    tr.appendChild(td(r.strategyName || (r.strategyVersion != null ? `v${r.strategyVersion}` : "")));
    tr.appendChild(td(r.symbol || ""));
    tr.appendChild(td(fmtTime(r.ts)));
    tr.appendChild(td(r.market || "—"));
    tr.appendChild(td(r.rs || "—"));
    tr.appendChild(td(r.level || "—"));
    tr.appendChild(td(r.status || "—"));
    tr.appendChild(td(r.stoppedOut ? "YES" : "NO"));

    const pnl = pickPnl(r);
    tr.appendChild(td(pnl == null ? "—" : `${fmt2(pnl)}%`));

    // ✅ make it open your detail modal
    tr.addEventListener("click", () => openModalForRow(r));

    // ✅ THIS is the missing piece that makes rows appear
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