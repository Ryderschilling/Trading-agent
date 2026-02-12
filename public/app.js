/* global io */

const socket = io();
const socketDot = document.getElementById("socketDot");

const feedBody = document.getElementById("feedBody");

const marketBiasEl = document.getElementById("marketBias");
const overallBiasPillEl = document.getElementById("overallBiasPill");
const indexStatusEl = document.getElementById("indexStatus");
const strongListEl = document.getElementById("strongList");
const weakListEl = document.getElementById("weakList");
const formingListEl = document.getElementById("formingList");

const symInput = document.getElementById("symInput");
const addBtn = document.getElementById("addBtn");
const watchChips = document.getElementById("watchChips");

const enableSoundBtn = document.getElementById("enableSound");

// A+ Pings card
const aPlusListEl = document.getElementById("aPlusList");
const aPlusEmptyEl = document.getElementById("aPlusEmpty");

// Modal
const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");
const modalSubEl = document.getElementById("modalSub");
const modalBodyEl = document.getElementById("modalBody");

let soundEnabled = false;
let audioCtx = null;

let allAlerts = [];
let watchSymbols = [];
let latestSignals = null;

// -----------------------
// Sound (user gesture gated)
// -----------------------
enableSoundBtn?.addEventListener("click", async () => {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume();
    soundEnabled = true;
    enableSoundBtn.textContent = "Sound Enabled";
  } catch {
    // ignore
  }
});

function ding() {
  if (!soundEnabled || !audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = "sine";
  o.frequency.value = 880;
  g.gain.value = 0.08;
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  setTimeout(() => {
    o.stop();
    o.disconnect();
    g.disconnect();
  }, 140);
}

// -----------------------
// Helpers
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
  if (x == null || Number.isNaN(x)) return "—";
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

function classifyAlert(a) {
  const msg = String(a?.message || "");
  if (msg.includes("A+ ENTRY")) return "ENTRY";
  if (msg.includes("FORMING")) return "FORMING";
  if (msg.includes("INVALID")) return "INVALID";
  return "INFO";
}

// -----------------------
// Modal
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
// Rendering
// -----------------------
function row(a) {
  const tr = document.createElement("tr");
  tr.dataset.alertId = String(a.id || "");

  const td = (t) => {
    const el = document.createElement("td");
    el.textContent = t;
    return el;
  };

  tr.appendChild(td(fmtTime(a.ts)));
  tr.appendChild(td(a.symbol || ""));
  tr.appendChild(td(a.message || ""));
  tr.appendChild(td(a.market || ""));
  tr.appendChild(td(a.rs || ""));
  tr.appendChild(td(a.dir || ""));
  tr.appendChild(td(a.level || ""));
  tr.appendChild(td(a.levelPrice != null ? String(a.levelPrice) : ""));
  tr.appendChild(td(a.close != null ? String(a.close) : ""));

  tr.addEventListener("click", () => openModalForAlert(a));
  return tr;
}

function renderFeed(alerts) {
  feedBody.innerHTML = "";
  const ordered = (alerts || []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  for (const a of ordered) feedBody.appendChild(row(a));
}

function renderAPlusPings(alerts) {
  if (!aPlusListEl || !aPlusEmptyEl) return;

  aPlusListEl.innerHTML = "";

  const items = (alerts || [])
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .filter((a) => {
      const k = classifyAlert(a);
      return k === "ENTRY" || k === "FORMING" || k === "INVALID";
    })
    .slice(0, 6);

  if (!items.length) {
    aPlusEmptyEl.style.display = "block";
    return;
  }

  aPlusEmptyEl.style.display = "none";

  for (const a of items) {
    const kind = classifyAlert(a);
    const div = document.createElement("div");
    div.className = "item";

    const badgeClass = kind === "ENTRY" ? "green" : kind === "FORMING" ? "amber" : "red";

    div.innerHTML = `
      <div>
        <div><b>${escapeHtml(a.symbol || "")}</b> — ${escapeHtml(kind)}</div>
        <div class="small">${escapeHtml(a.message || "")} • ${escapeHtml(a.level || "—")} ${a.levelPrice != null ? fmt2(a.levelPrice) : ""}</div>
      </div>
      <div class="badge ${badgeClass}">${escapeHtml(kind)}</div>
    `;

    div.addEventListener("click", () => openModalForAlert(a));
    aPlusListEl.appendChild(div);
  }
}

function renderWatchlist(symbols) {
  watchChips.innerHTML = "";

  for (const s of symbols) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `
      <span class="chip-text">${escapeHtml(s)}</span>
      <button class="chip-x" aria-label="remove">×</button>
    `;

    chip.querySelector(".chip-x").addEventListener("click", async () => {
      await fetch("/api/watchlist/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: s })
      });
    });

    watchChips.appendChild(chip);
  }
}

function renderSignals(s) {
  if (!s) return;
// Top-center bias pill (watchlist breadth vs VWAP)
if (overallBiasPillEl) {
    const bias = String(s.marketBias || "NEUTRAL").toUpperCase();
    overallBiasPillEl.textContent = bias;
    overallBiasPillEl.classList.remove("bullish", "bearish", "neutral");
    if (bias === "BULLISH") overallBiasPillEl.classList.add("bullish");
    else if (bias === "BEARISH") overallBiasPillEl.classList.add("bearish");
    else overallBiasPillEl.classList.add("neutral");
  }

  marketBiasEl.textContent = `Market Bias: ${s.marketBias} • Updated ${fmtTime(s.ts)}`;

  const spy = s.spy || {};
  const qqq = s.qqq || {};
  indexStatusEl.textContent =
    `SPY: ${fmt2(spy.price)} vs VWAP ${fmt2(spy.vwap)} (${spy.side || "NA"}) • ` +
    `QQQ: ${fmt2(qqq.price)} vs VWAP ${fmt2(qqq.vwap)} (${qqq.side || "NA"})`;

  function fillList(el, arr, label) {
    el.innerHTML = "";
    if (!arr || !arr.length) {
      el.innerHTML = `<div class="small">No ${label} tickers right now.</div>`;
      return;
    }
    for (const it of arr) {
      const div = document.createElement("div");
      div.className = "item";
      const sep = (it.price - it.vwap);

      div.innerHTML = `
        <div>
          <div><b>${escapeHtml(it.symbol)}</b> — ${escapeHtml(it.rs)}</div>
          <div class="small">Price ${fmt2(it.price)} • VWAP ${fmt2(it.vwap)} • Δ ${fmt2(sep)}</div>
        </div>
        <div class="badge ${label === "strong" ? "green" : "red"}">${label.toUpperCase()}</div>
      `;
      el.appendChild(div);
    }
  }

  fillList(strongListEl, s.strong, "strong");
  fillList(weakListEl, s.weak, "weak");

  if (formingListEl) {
    formingListEl.innerHTML = "";
    const arr = s.forming || [];
    if (!arr.length) {
      formingListEl.innerHTML = `<div class="small">No armed A+ setups right now.</div>`;
    } else {
      for (const it of arr) {
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
          <div>
            <div><b>${escapeHtml(it.symbol)}</b> — ${escapeHtml(it.dir)} • ${escapeHtml(it.level)} ${fmt2(it.levelPrice)}</div>
            <div class="small">Last ${it.lastPrice != null ? fmt2(it.lastPrice) : "—"} • Dist ${it.distancePct != null ? fmt2(it.distancePct) + "%" : "—"} • Score ${fmt2(it.score)} • RS ${escapeHtml(it.rs)}</div>
          </div>
          <div class="badge amber">FORMING</div>
        `;
        formingListEl.appendChild(div);
      }
    }
  }
}

// -----------------------
// Watchlist actions
// -----------------------
addBtn?.addEventListener("click", async () => {
  const symbol = String(symInput.value || "").trim().toUpperCase();
  if (!symbol) return;

  symInput.value = "";
  await fetch("/api/watchlist/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbol })
  });
});

symInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.click();
});

// -----------------------
// Socket wiring
// -----------------------
socket.on("connect", () => {
  if (socketDot) socketDot.classList.add("on");
});

socket.on("disconnect", () => {
  if (socketDot) socketDot.classList.remove("on");
});

socket.on("init", (payload) => {
  allAlerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  watchSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  latestSignals = payload.signals || null;

  // Execution feed = ENTRY only
  renderFeed(allAlerts.filter((a) => String(a.message || "").includes("A+ ENTRY")));
  renderAPlusPings(allAlerts);
  renderWatchlist(watchSymbols);
  renderSignals(latestSignals);
});

socket.on("watchlist", (payload) => {
  watchSymbols = Array.isArray(payload.symbols) ? payload.symbols : watchSymbols;
  renderWatchlist(watchSymbols);
});

socket.on("signals", (payload) => {
  latestSignals = payload?.signals || null;
  renderSignals(latestSignals);
});

socket.on("alert", (alert) => {
  allAlerts.push(alert);

  renderAPlusPings(allAlerts);

  // Sound + feed only on ENTRY
  if (String(alert.message || "").includes("A+ ENTRY")) {
    ding();
    const r = row(alert);
    r.classList.add("new-animate");
    feedBody.prepend(r);
  }
});