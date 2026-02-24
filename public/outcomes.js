/* global io */

const socket = io();
const socketDot = document.getElementById("socketDot");

const dbBodyEl = document.getElementById("dbBody");
const dbEmptyEl = document.getElementById("dbEmpty");
const dbSymEl = document.getElementById("dbSym");
const dbStatusEl = document.getElementById("dbStatus");
const dbStoppedOnlyEl = document.getElementById("dbStoppedOnly");
const refreshBtn = document.getElementById("refreshBtn");

// Strategy selector
const dbStrategyEl = document.getElementById("dbStrategy");

// Load list of strategies from the backend and populate the dropdown.
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
    /* ignore */
  }
}

// Modal
const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");
const modalSubEl = document.getElementById("modalSub");
const modalBodyEl = document.getElementById("modalBody");

let dbRowsRaw = [];
let allAlerts = []; // pulled from socket init

// socket dot
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

// helpers
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

// modal helpers (unchanged)
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
async function openModalForAlert(a) {
  if (!modalEl || !modalBodyEl || !modalSubEl) return;
  modalSubEl.textContent = `${a.symbol || ""} • ${a.message || ""}`;
  modalBodyEl.textContent = "Loading…";
  modalOpen();
  const id = String(a.id || "");
  const structure = a.structureLevel != null ? a.structureLevel : a.levelPrice;
  const snapshot = `
    <div style="margin-bottom:12px;">
      <div><b>Signal snapshot</b></div>
      <div>Time: ${escapeHtml(fmtTime(a.ts))}</div>
      <div>Dir: ${escapeHtml(a.dir || "—")} • Market: ${escapeHtml(a.market || "—")} • RS: ${escapeHtml(a.rs || "—")}</div>
      <div>Level: ${escapeHtml(a.level || "—")} • Structure: ${structure != null ? fmt2(structure) : "—"}</div>
      <div>Entry ref close: ${a.close != null ? fmt2(a.close) : "—"}</div>
      <div class="small" style="margin-top:6px;">Stop rule: first 5m close breaches structure</div>
    </div>
  `;
  if (!id) {
    modalBodyEl.innerHTML = snapshot + `<div class="small">Missing alert id.</div>`;
    return;
  }
  try {
    const r = await fetch(`/api/outcomes/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!r.ok) {
      modalBodyEl.innerHTML = snapshot + `<div class="small">Outcome: still tracking (not finalized yet) or no data.</div>`;
      return;
    }
    const j = await r.json();
    const o = j?.outcome;
    if (!o) {
      modalBodyEl.innerHTML = snapshot + `<div class="small">Outcome: not available.</div>`;
      return;
    }
    const returns = o.returnsPct || {};
    const keys = Object.keys(returns).sort((x, y) => parseInt(x) - parseInt(y));
    const returnsHtml = keys.length
      ? keys.map((k) => `<div>${escapeHtml(k)}: <b>${fmt2(returns[k])}%</b></div>`).join("")
      : `<div class="small">No checkpoint returns recorded yet.</div>`;
    modalBodyEl.innerHTML = snapshot + `
      <div style="margin-top:10px;">
        <div><b>Outcome</b> (${escapeHtml(o.status || "—")})</div>
        <div>MFE: <b>${fmt2(o.mfePct)}%</b> • MAE: <b>${fmt2(o.maePct)}%</b> • Time to MFE: ${o.timeToMfeSec != null ? escapeHtml(String(o.timeToMfeSec)) + "s" : "—"}</div>
        <div>Stopped out: ${o.stoppedOut ? "YES" : "NO"} ${o.stoppedOut ? `• Stop return: <b>${fmt2(o.stopReturnPct)}%</b> • 5m bars to stop: ${escapeHtml(String(o.barsToStop || "—"))}` : ""}</div>
        <div style="margin-top:10px;"><b>Checkpoint returns</b></div>
        ${returnsHtml}
      </div>
    `;
  } catch {
    modalBodyEl.innerHTML = snapshot + `<div class="small">Outcome: unable to load.</div>`;
  }
}

// -----------------------
// DB render
// -----------------------
function applyDbFilters(rows) {
  const sym = String(dbSymEl?.value || "").trim().toUpperCase();
  const status = String(dbStatusEl?.value || "").trim().toUpperCase();
  const stoppedOnly = Boolean(dbStoppedOnlyEl?.checked);
  const strat = String(dbStrategyEl?.value || "").trim();
  return (rows || []).filter((r) => {
    if (sym && String(r.symbol || "").toUpperCase() !== sym) return false;
    if (status && String(r.status || "").toUpperCase() !== status) return false;
    if (stoppedOnly && !r.stoppedOut) return false;
    if (strat && String(r.strategyVersion || "") !== strat) return false;
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
    const td = (t) => {
      const el = document.createElement("td");
      el.textContent = t;
      return el;
    };
    tr.appendChild(td(fmtTime(r.ts)));
    tr.appendChild(td(r.symbol || ""));
    tr.appendChild(td(r.market || ""));
    tr.appendChild(td(r.rs || ""));
    tr.appendChild(td(r.dir || ""));
    tr.appendChild(td(r.level || ""));
    // Level price
    tr.appendChild(td(r.levelPrice !== "" && r.levelPrice != null ? fmt2(r.levelPrice) : "—"));
    // Structure level
    tr.appendChild(td(r.structureLevel !== "" && r.structureLevel != null ? fmt2(r.structureLevel) : "—"));
    // Entry reference price
    tr.appendChild(td(r.entryRef !== "" && r.entryRef != null ? fmt2(r.entryRef) : "—"));
    // Status
    tr.appendChild(td(r.status || "—"));
    // Stopped out
    tr.appendChild(td(r.stoppedOut ? "YES" : "NO"));
    // Stop return percentage
    tr.appendChild(td(r.stopReturnPct !== "" && r.stopReturnPct != null ? fmt2(r.stopReturnPct) : "—"));
    // Bars to stop
    tr.appendChild(td(r.barsToStop !== "" && r.barsToStop != null ? String(r.barsToStop) : "—"));
    // MFE %
    tr.appendChild(td(r.mfePct !== "" && r.mfePct != null ? fmt2(r.mfePct) : "—"));
    // MAE %
    tr.appendChild(td(r.maePct !== "" && r.maePct != null ? fmt2(r.maePct) : "—"));
    // Time to MFE seconds
    tr.appendChild(td(r.timeToMfeSec !== "" && r.timeToMfeSec != null ? String(r.timeToMfeSec) : "—"));
    // Returns at checkpoints
    tr.appendChild(td(r.ret5m !== "" && r.ret5m != null ? fmt2(r.ret5m) : "—"));
    tr.appendChild(td(r.ret15m !== "" && r.ret15m != null ? fmt2(r.ret15m) : "—"));
    tr.appendChild(td(r.ret30m !== "" && r.ret30m != null ? fmt2(r.ret30m) : "—"));
    tr.appendChild(td(r.ret60m !== "" && r.ret60m != null ? fmt2(r.ret60m) : "—"));
    // Strategy name/version
    tr.appendChild(td(r.strategyName || (r.strategyVersion != null ? `v${r.strategyVersion}` : "")));
    tr.addEventListener("click", () => {
      const a = findAlertById(r.alertId);
      if (a) openModalForAlert(a);
    });
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
    /* ignore */
  }
}

// Bind filters
dbSymEl?.addEventListener("input", renderDbTable);
dbStatusEl?.addEventListener("change", renderDbTable);
dbStoppedOnlyEl?.addEventListener("change", renderDbTable);
dbStrategyEl?.addEventListener("change", renderDbTable);
refreshBtn?.addEventListener("click", fetchDbRows);

// Initial load: first load strategies, then fetch rows
loadStrategies().then(() => {
  fetchDbRows();
});
setInterval(fetchDbRows, 6000);