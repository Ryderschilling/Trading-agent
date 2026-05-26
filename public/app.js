/* global io */

// -----------------------
// Safe Socket.IO init (DO NOT crash if io is missing in production)
// -----------------------
let socket = null;
try {
  if (typeof io === "function") socket = io();
} catch {
  socket = null;
}

const socketDot = document.getElementById("socketDot");

const feedBody = document.getElementById("feedBody");

const marketBiasEl = document.getElementById("marketBias");
const overallBiasPillEl = document.getElementById("overallBiasPill");
const dataLivePillEl = document.getElementById("dataLivePill");
const indexStatusEl = document.getElementById("indexStatus");
const dataHealthBannerEl = document.getElementById("dataHealthBanner");
const dataHealthTitleEl = document.getElementById("dataHealthTitle");
const dataHealthMetaEl = document.getElementById("dataHealthMeta");
const dataHealthBodyEl = document.getElementById("dataHealthBody");
const ghostBannerEl = document.getElementById("ghostPositionsBanner");
const ghostBannerMetaEl = document.getElementById("ghostBannerMeta");
const ghostBannerBodyEl = document.getElementById("ghostBannerBody");
const coverageBannerEl = document.getElementById("coverageBanner");
const coverageBannerMetaEl = document.getElementById("coverageBannerMeta");
const coverageBannerBodyEl = document.getElementById("coverageBannerBody");
const strongListEl = document.getElementById("strongList");
const weakListEl = document.getElementById("weakList");
const formingListEl = document.getElementById("formingList");
const formingEmptyEl = document.getElementById("formingEmpty");

const enableSoundBtn = document.getElementById("enableSound");

// Live Trades card
const liveTradesListEl = document.getElementById("liveTradesList");
const liveTradesEmptyEl = document.getElementById("liveTradesEmpty");

// Watchlist page elements (only exist on watchlist page)
const symInput = document.getElementById("symInput");
const addBtn = document.getElementById("addBtn");
const watchChips = document.getElementById("watchChips");

// Modal
const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");
const modalSubEl = document.getElementById("modalSub");
const modalBodyEl = document.getElementById("modalBody");
const aiOperatorStatusEl = document.getElementById("aiOperatorStatus");
const aiOperatorPromptEl = document.getElementById("aiOperatorPrompt");
const aiOperatorAskBtn = document.getElementById("aiOperatorAskBtn");
const aiOperatorOutputEl = document.getElementById("aiOperatorOutput");
const aiOperatorLauncherEl = document.getElementById("aiOperatorLauncher");
const aiOperatorPanelEl = document.getElementById("aiOperatorPanel");
const aiOperatorCloseBtnEl = document.getElementById("aiOperatorCloseBtn");
const aiOperatorNewChatBtnEl = document.getElementById("aiOperatorNewChatBtn");
const sharedAiHandled = Boolean(window.__taAiHandledByUi);

let soundEnabled = false;
let audioCtx = null;

let allAlerts = [];
let watchSymbols = [];
let latestSignals = null;
let dataIsLive = false;
let lastKnownSignals = null;
let aiChatHistory = [];

// Alerts that are no longer "open" (COMPLETED or STOPPED)
let closedAlertIds = new Set();

// Perf caps
const FEED_MAX_ROWS = 200;
const ALERTS_KEEP_MAX = 2000;

// Health polling
const HEALTH_POLL_MS = 3000;
const AI_CHAT_STORAGE_KEY = "ta_ai_chat_history_v1";
// Consider data "live" if we've received a bar within the last 5 minutes.
// Your health screenshot shows bar ages ~1–2 minutes; 15s was far too strict.
const LIVE_THRESHOLD_MS = 300_000;

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

function cleanMessage(msg) {
  return String(msg || "")
    .replace(/\s*\(1m\s*tap\)\s*/gi, "")
    .trim();
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#96;");
}

function classifyAlert(a) {
  const msg = String(a?.message || "");
  if (msg.includes("A+ ENTRY")) return "ENTRY";
  if (msg.includes("FORMING")) return "FORMING";
  if (msg.includes("INVALID")) return "INVALID";
  return "INFO";
}

function trimAlerts() {
  if (allAlerts.length > ALERTS_KEEP_MAX) {
    allAlerts = allAlerts.slice(-ALERTS_KEEP_MAX);
  }
}

function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

function fmtDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  try {
    return new Date(n).toLocaleString();
  } catch {
    return "—";
  }
}

function renderDataHealthBanner(state) {
  if (!dataHealthBannerEl || !dataHealthTitleEl || !dataHealthMetaEl || !dataHealthBodyEl) return;

  const live = Boolean(state?.live);
  if (live) {
    dataHealthBannerEl.style.display = "none";
    return;
  }

  const reason = String(state?.reason || "Waiting for fresh market data.");
  const detail = String(
    state?.detail ||
      "Fresh bars are required before the platform can surface new setups or submit trades."
  );
  const meta = String(state?.meta || "");

  dataHealthTitleEl.textContent = "Trading Paused";
  dataHealthMetaEl.textContent = meta || "Waiting for live market data.";
  dataHealthBodyEl.textContent = `${reason} ${detail}`.trim();
  dataHealthBannerEl.style.display = "block";
}

function renderGhostBanner(payload) {
  if (!ghostBannerEl || !ghostBannerMetaEl || !ghostBannerBodyEl) return;
  const ghosts = Array.isArray(payload?.ghosts) ? payload.ghosts : [];
  const stale = Array.isArray(payload?.staleSessions) ? payload.staleSessions : [];
  if (ghosts.length === 0 && stale.length === 0) {
    ghostBannerEl.style.display = "none";
    return;
  }
  const chip = (txt) => `<code style="background:#1a0a0a; padding:2px 6px; border-radius:3px; margin-right:6px;">${txt}</code>`;
  const fmtGhost = (g) => {
    const qty = g.qty != null ? Number(g.qty).toFixed(2) : "?";
    const px = g.avgEntryPrice != null ? `@$${Number(g.avgEntryPrice).toFixed(2)}` : "";
    const pnl = g.unrealizedPlPct != null ? ` (${Number(g.unrealizedPlPct).toFixed(2)}%)` : "";
    return `${g.symbol} ${String(g.side || "?").toUpperCase()} ${qty} ${px}${pnl}`.trim();
  };
  const fmtStale = (s) => `${s.symbol} — no bar ${Math.round(Number(s.ageMs || 0) / 60000)}min`;

  const metaBits = [];
  if (ghosts.length) metaBits.push(`${ghosts.length} untracked`);
  if (stale.length) metaBits.push(`${stale.length} stale session${stale.length === 1 ? "" : "s"}`);
  ghostBannerMetaEl.textContent = metaBits.join(" · ");

  const parts = [];
  if (ghosts.length) {
    parts.push(`<div style="margin-bottom:6px;"><strong>Untracked broker positions:</strong> ${ghosts.map((g) => chip(fmtGhost(g))).join(" ")}</div>`);
  }
  if (stale.length) {
    parts.push(`<div style="margin-bottom:6px;"><strong>Stale sessions (data feed stalled):</strong> ${stale.map((s) => chip(fmtStale(s))).join(" ")}</div>`);
  }
  parts.push(`<div class="small" style="opacity:0.85;">Untracked positions are not driven by the OutcomeTracker. Stale sessions have lost their data feed and are no longer risk-managed. The clock-driven EOD sweep will flatten both at 14:59 ET — but check the broker now.</div>`);
  ghostBannerBodyEl.innerHTML = parts.join("");
  ghostBannerEl.style.display = "block";
}

function renderCoverageBanner(payload) {
  if (!coverageBannerEl || !coverageBannerMetaEl || !coverageBannerBodyEl) return;
  const stale = Array.isArray(payload?.staleSymbols) ? payload.staleSymbols : [];
  if (stale.length === 0) {
    coverageBannerEl.style.display = "none";
    return;
  }
  const threshold = Number(payload?.thresholdMs || 180000) / 1000;
  coverageBannerMetaEl.textContent = `${stale.length}/${payload.watchlistCount} symbol${stale.length === 1 ? "" : "s"} stale`;
  coverageBannerBodyEl.innerHTML =
    `<div>No fresh bars in &gt;${threshold.toFixed(0)}s for: <strong>${stale.join(", ")}</strong>.</div>` +
    `<div class="small" style="opacity:0.85; margin-top:4px;">Strategy will not evaluate setups on stale symbols. Check the data feed.</div>`;
  coverageBannerEl.style.display = "block";
}

async function pollGhostAndCoverage() {
  try {
    const [g, c] = await Promise.all([
      fetch("/api/ghost-positions").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/data-coverage").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (g) renderGhostBanner(g);
    if (c) renderCoverageBanner(c);
  } catch {
    // best effort — banners stay in last state
  }
}

// Start polling after a short delay so it doesn't compete with initial bootstrap.
setTimeout(() => {
  void pollGhostAndCoverage();
  setInterval(pollGhostAndCoverage, 30_000);
}, 2000);

function loadAiChatHistory() {
  try {
    const raw = localStorage.getItem(AI_CHAT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    aiChatHistory = Array.isArray(parsed)
      ? parsed
          .map((item) => ({
            role: item?.role === "assistant" ? "assistant" : "user",
            text: String(item?.text || "").trim(),
          }))
          .filter((item) => item.text)
      : [];
  } catch {
    aiChatHistory = [];
  }
}

function saveAiChatHistory() {
  try {
    localStorage.setItem(AI_CHAT_STORAGE_KEY, JSON.stringify(aiChatHistory.slice(-30)));
  } catch {}
}

function renderAiChatThread() {
  if (!aiOperatorOutputEl) return;

  if (!aiChatHistory.length) {
    aiOperatorOutputEl.innerHTML = `<div class="small">Type a message below. Ask questions or tell it what to do inside the platform.</div>`;
    return;
  }

  aiOperatorOutputEl.innerHTML = aiChatHistory
    .map((item) => `
      <div class="ai-chat-message ai-chat-message-${escapeHtml(item.role)}">
        <div class="ai-chat-message-label">${item.role === "assistant" ? "Trading Friend" : "You"}</div>
        <div class="ai-chat-message-text">${escapeHtml(item.text)}</div>
      </div>
    `)
    .join("");

  aiOperatorOutputEl.scrollTop = aiOperatorOutputEl.scrollHeight;
}

function resetAiChatHistory() {
  aiChatHistory = [];
  saveAiChatHistory();
  renderAiChatThread();
}

function renderAiOperatorResult(payload) {
  if (!aiOperatorOutputEl) return;

  const assumptions = Array.isArray(payload?.assumptions) ? payload.assumptions : [];
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
  const results = Array.isArray(payload?.results) ? payload.results : [];

  const assumptionsHtml = assumptions.length
    ? `<h3>Assumptions</h3><ul>${assumptions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";

  const warningsHtml = warnings.length
    ? `<h3>Warnings</h3><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : "";

  const resultsHtml = results.length
    ? `<h3>${payload?.dryRun ? "Planned Actions" : "Execution Results"}</h3><ul>${results
        .map((item) => `<li><b>${escapeHtml(item.status || "planned")}</b> - ${escapeHtml(item.message || "")}</li>`)
        .join("")}</ul>`
    : `<div class="small">No actions returned.</div>`;

  if (payload?.mode === "chat") {
    aiChatHistory.push({ role: "assistant", text: String(payload?.assistantMessage || "").trim() });
    saveAiChatHistory();
    aiOperatorOutputEl.classList.remove("is-loading");
    renderAiChatThread();
    return;
  }

  aiOperatorOutputEl.classList.remove("is-loading");
  aiOperatorOutputEl.innerHTML = `
    <p><b>${escapeHtml(payload?.summary || "Strategy plan ready.")}</b></p>
    <p>${escapeHtml(payload?.assistantMessage || "")}</p>
    ${assumptionsHtml}
    ${warningsHtml}
    ${resultsHtml}
  `;
}

function primeAiOperatorOutputLoading(message) {
  if (!aiOperatorOutputEl) return;
  aiOperatorOutputEl.classList.add("is-loading");
  aiOperatorOutputEl.innerHTML = `<div class="small">${message}</div>`;
}

function setAiOperatorOpen(nextOpen) {
  if (!aiOperatorLauncherEl || !aiOperatorPanelEl) return;
  aiOperatorPanelEl.classList.toggle("open", nextOpen);
  aiOperatorPanelEl.setAttribute("aria-hidden", nextOpen ? "false" : "true");
  aiOperatorLauncherEl.setAttribute("aria-expanded", nextOpen ? "true" : "false");

  if (nextOpen) {
    window.setTimeout(() => aiOperatorPromptEl?.focus(), 40);
  }
}

async function refreshAiOperatorStatus() {
  if (!aiOperatorStatusEl) return;

  try {
    const res = await fetch("/api/agent/status", { cache: "no-store" });
    const json = await res.json();
    const configured = Boolean(json?.status?.configured);

    aiOperatorStatusEl.textContent = configured ? "Ready" : "Missing OpenAI key";
    aiOperatorStatusEl.className = `badge ${configured ? "success" : "error"}`;
  } catch {
    aiOperatorStatusEl.textContent = "Agent offline";
    aiOperatorStatusEl.className = "badge error";
  }
}

async function runAiOperator(mode, dryRun) {
  if (!aiOperatorPromptEl || !aiOperatorOutputEl) return;

  const message = String(aiOperatorPromptEl.value || "").trim();
  if (!message) {
    window.showToast?.("Enter a prompt for the AI operator.", "error");
    aiOperatorPromptEl.focus();
    return;
  }

  primeAiOperatorOutputLoading("Thinking...");

  try {
    const chatHistoryForRequest =
      mode === "chat"
        ? aiChatHistory.slice(-12).map((item) => ({ role: item.role, text: item.text }))
        : [];

    if (mode === "chat") {
      aiChatHistory.push({ role: "user", text: message });
      saveAiChatHistory();
      renderAiChatThread();
      aiOperatorOutputEl.classList.add("is-loading");
    }

    const res = await fetch("/api/agent/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message, dryRun, mode, history: chatHistoryForRequest }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || `Request failed (${res.status})`);
    }

    renderAiOperatorResult(json);
    aiOperatorPromptEl.value = "";
    window.showToast?.("Reply ready.", "success");
  } catch (error) {
    if (mode === "chat" && aiChatHistory.length && aiChatHistory[aiChatHistory.length - 1]?.role === "user") {
      aiChatHistory.pop();
      saveAiChatHistory();
    }
    aiOperatorOutputEl.classList.remove("is-loading");
    if (mode === "chat") {
      renderAiChatThread();
    } else {
      aiOperatorOutputEl.innerHTML = `<div class="small">Unable to run AI operator: ${escapeHtml(error?.message || "Unknown error")}</div>`;
    }
    window.showToast?.("AI request failed.", "error");
  }
}

// -----------------------
// DATA LIVE dot (truthy): green only when RTH + fresh bars
// -----------------------
async function refreshDataLiveDot() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const j = await r.json();
    const market = j?.market || {};
    const live = Boolean(market?.dataLive);
    const isRth = Boolean(market?.isRth);
    const barsFresh = Boolean(market?.barsFresh);
    const lastBarTs = Number(market?.lastBarTs || 0) || null;
    const lastBarAgeMs = Number.isFinite(Number(market?.lastBarAgeMs)) ? Number(market.lastBarAgeMs) : null;

    // Dot = live only
    if (socketDot) {
      socketDot.classList.toggle("live", live);
      socketDot.title = live ? "DATA LIVE (RTH + fresh bars)" : "Data not live";
    }

    // Pill (optional): keep consistent with dot
    if (dataLivePillEl) {
      dataIsLive = live;
      dataLivePillEl.textContent = live ? "DATA: LIVE" : "DATA: —";
      dataLivePillEl.classList.remove("bullish", "bearish", "neutral");
      dataLivePillEl.classList.add(live ? "bullish" : "neutral");
    }

    let reason = "Waiting for fresh market data.";
    let detail = "Fresh bars are required before the platform can surface new setups or submit trades.";
    let meta = "Waiting for live market data.";

    if (!isRth) {
      reason = "Regular market hours are closed.";
      detail = "The strategy only evaluates setups during RTH, so new trade discovery and order submission stay paused outside the session.";
      meta = "Market outside RTH";
    } else if (!barsFresh) {
      reason = "Live market data is stale.";
      detail = "The dashboard clears forming candidates and the engine will not produce fresh entries until new bars arrive.";
      meta = lastBarTs
        ? `Last bar ${fmtDateTime(lastBarTs)} • age ${fmtAge(lastBarAgeMs)}`
        : "No recent bars received";
    } else {
      meta = "Data live";
    }

    renderDataHealthBanner({
      live,
      reason,
      detail,
      meta,
    });
  } catch {
    if (socketDot) {
      socketDot.classList.remove("live");
      socketDot.title = "Health check failed";
    }
    if (dataLivePillEl) {
      dataIsLive = false;
      dataLivePillEl.textContent = "DATA: —";
      dataLivePillEl.classList.remove("bullish", "bearish", "neutral");
      dataLivePillEl.classList.add("neutral");
    }
    renderDataHealthBanner({
      live: false,
      reason: "Health check failed.",
      detail: "The workspace cannot confirm that fresh bars are arriving, so setup discovery and trade placement should be treated as paused until the feed reconnects.",
      meta: "Server or data feed unreachable",
    });
  }
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
<div style="margin-top:6px;"><b>Message:</b> ${escapeHtml(cleanMessage(a.message))}</div>
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

  // Columns must match index.html thead:
  // Time | Symbol | Market | RS | Dir | Message
  tr.appendChild(td(fmtTime(a.ts)));
  tr.appendChild(td(a.symbol || ""));
  tr.appendChild(td(a.market || "—"));
  tr.appendChild(td(a.rs || "—"));
  tr.appendChild(td(a.dir || "—"));
  tr.appendChild(td(cleanMessage(a.message)));

  tr.addEventListener("click", () => openModalForAlert(a));
  return tr;
}
  
function renderFeed(alerts) {
  if (!feedBody) return;
  feedBody.innerHTML = "";

  const ordered = (alerts || [])
    .slice()
    .filter((a) => String(a.message || "").includes("A+ ENTRY") && !closedAlertIds.has(String(a.id || "")))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, FEED_MAX_ROWS);

  for (const a of ordered) feedBody.appendChild(row(a));
}

// -----------------------
// Trade modal
// -----------------------
const tradeModalEl = document.getElementById("tradeModal");
const tradeModalCloseEl = document.getElementById("tradeModalClose");
const tradeModalTitleEl = document.getElementById("tradeModalTitle");
const tradeModalBodyEl = document.getElementById("tradeModalBody");

function tradeModalOpen() { if (tradeModalEl) tradeModalEl.style.display = "flex"; }
function tradeModalClose() { if (tradeModalEl) tradeModalEl.style.display = "none"; }
tradeModalCloseEl?.addEventListener("click", tradeModalClose);
tradeModalEl?.addEventListener("click", (e) => { if (e.target === tradeModalEl) tradeModalClose(); });

function drawCandleChart(canvas, bars) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (!bars || !bars.length) {
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "12px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("No chart data", w / 2, h / 2);
    return;
  }

  const maxH = Math.max(...bars.map((b) => b.h));
  const minL = Math.min(...bars.map((b) => b.l));
  const range = maxH - minL || 0.01;
  const pad = { top: 8, bottom: 8, left: 2, right: 2 };
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const slotW = cw / bars.length;
  const bodyW = Math.max(1, slotW * 0.6);
  const toY = (p) => pad.top + ch - ((p - minL) / range) * ch;

  bars.forEach((bar, i) => {
    const x = pad.left + i * slotW + slotW / 2;
    const up = bar.c >= bar.o;
    const color = up ? "#26a69a" : "#ef5350";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, toY(bar.h));
    ctx.lineTo(x, toY(bar.l));
    ctx.stroke();
    const bodyTop = toY(Math.max(bar.o, bar.c));
    const bodyBot = toY(Math.min(bar.o, bar.c));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, Math.max(1, bodyBot - bodyTop));
  });
}

async function openTradeModal(pos) {
  if (!tradeModalEl || !tradeModalBodyEl || !tradeModalTitleEl) return;

  const sym = String(pos.symbol || "");
  const qty = pos.qty != null ? Number(pos.qty) : null;
  const entry = pos.avgEntryPrice != null ? Number(pos.avgEntryPrice) : null;
  const mv = pos.marketValue != null ? Number(pos.marketValue) : null;
  const pnl = pos.unrealizedPl != null ? Number(pos.unrealizedPl) : null;
  const pnlPct = pos.unrealizedPlPct != null ? Number(pos.unrealizedPlPct) * 100 : null;
  const side = String(pos.side || "long").toUpperCase();

  const pnlStr = pnl != null && Number.isFinite(pnl) ? (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2) : "—";
  const pnlPctStr = pnlPct != null && Number.isFinite(pnlPct) ? (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(2) + "%" : "";
  const pnlColor = pnl != null && pnl >= 0 ? "#26a69a" : "#ef5350";
  const qtyDisplay = qty != null ? (qty % 1 === 0 ? qty : qty.toFixed(4)) : "—";

  tradeModalTitleEl.textContent = `${sym} — ${side}`;
  tradeModalBodyEl.innerHTML = `
    <canvas id="tradeChart" style="width:100%; height:160px; display:block; border-radius:8px; background:rgba(255,255,255,0.03); margin-bottom:16px;"></canvas>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px;">
      <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11px; color:var(--muted,#888); margin-bottom:3px;">Qty</div>
        <div style="font-weight:600;">${escapeHtml(String(qtyDisplay))}</div>
      </div>
      <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11px; color:var(--muted,#888); margin-bottom:3px;">Avg Entry</div>
        <div style="font-weight:600;">${entry != null ? "$" + entry.toFixed(2) : "—"}</div>
      </div>
      <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:10px 12px;">
        <div style="font-size:11px; color:var(--muted,#888); margin-bottom:3px;">Market Value</div>
        <div style="font-weight:600;">${mv != null ? "$" + mv.toFixed(2) : "—"}</div>
      </div>
    </div>
    <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:12px 14px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
      <span style="font-size:12px; color:var(--muted,#888);">Unrealized P&amp;L</span>
      <span style="font-weight:700; font-size:16px; color:${pnlColor};">${escapeHtml(pnlStr)} <span style="font-size:13px;">${escapeHtml(pnlPctStr)}</span></span>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <button id="tradeModalSellBtn" style="flex:1; padding:10px 0; background:#e53935; color:#fff; border:none; border-radius:8px; cursor:pointer; font-size:14px; font-weight:700; letter-spacing:0.3px;">
        Sell Out
      </button>
      <div style="display:flex; gap:6px; flex:1; align-items:center;">
        <input id="tradeModalStopInput" type="number" step="0.01" placeholder="Stop price"
          style="flex:1; padding:9px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); border-radius:8px; color:inherit; font-size:13px; outline:none; min-width:0;" />
        <button id="tradeModalStopBtn" style="padding:9px 14px; background:#f59e0b; color:#000; border:none; border-radius:8px; cursor:pointer; font-size:13px; font-weight:700; white-space:nowrap;">
          Set Stop
        </button>
      </div>
    </div>
  `;

  tradeModalOpen();

  // Draw chart
  const canvas = document.getElementById("tradeChart");
  if (canvas) {
    try {
      const res = await fetch(`/api/candles?symbol=${encodeURIComponent(sym)}&end=${Date.now()}&minutes=90`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      drawCandleChart(canvas, j?.bars || []);
    } catch {
      drawCandleChart(canvas, []);
    }
  }

  // Sell Out
  document.getElementById("tradeModalSellBtn")?.addEventListener("click", async () => {
    if (!confirm(`Close full position in ${sym}?`)) return;
    const btn = document.getElementById("tradeModalSellBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Closing…"; }
    try {
      const res = await fetch("/api/broker/close-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `status ${res.status}`);
      window.showToast?.(`${sym} position closed`, "success");
      tradeModalClose();
      await refreshBrokerStats();
    } catch (err) {
      window.showToast?.(`Failed to close ${sym}: ${err.message}`, "error");
      if (btn) { btn.disabled = false; btn.textContent = "Sell Out"; }
    }
  });

  // Set Stop
  document.getElementById("tradeModalStopBtn")?.addEventListener("click", async () => {
    const input = document.getElementById("tradeModalStopInput");
    const stopPrice = input ? parseFloat(input.value) : NaN;
    if (!Number.isFinite(stopPrice) || stopPrice <= 0) {
      window.showToast?.("Enter a valid stop price", "error");
      return;
    }
    const btn = document.getElementById("tradeModalStopBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Setting…"; }
    try {
      const res = await fetch("/api/broker/set-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym, stopPrice, qty })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || `status ${res.status}`);
      window.showToast?.(`Stop set at $${stopPrice.toFixed(2)} for ${sym}`, "success");
      if (input) input.value = "";
    } catch (err) {
      window.showToast?.(`Failed to set stop: ${err.message}`, "error");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Set Stop"; }
    }
  });
}

function renderLiveTrades(positions) {
  if (!liveTradesListEl || !liveTradesEmptyEl) return;

  liveTradesListEl.innerHTML = "";

  const items = (Array.isArray(positions) ? positions : [])
    .filter((p) => p.qty != null && Math.abs(Number(p.qty)) > 0.0001);

  if (!items.length) {
    liveTradesEmptyEl.style.display = "block";
    return;
  }

  liveTradesEmptyEl.style.display = "none";

  for (const p of items) {
    const sym = String(p.symbol || "");
    const qty = p.qty != null ? Number(p.qty) : null;
    const pnl = p.unrealizedPl != null ? Number(p.unrealizedPl) : null;
    const pnlPct = p.unrealizedPlPct != null ? Number(p.unrealizedPlPct) * 100 : null;
    const side = String(p.side || "long").toUpperCase();

    const pnlStr = pnl != null && Number.isFinite(pnl) ? (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2) : "—";
    const pnlPctStr = pnlPct != null && Number.isFinite(pnlPct) ? " (" + (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(2) + "%)" : "";
    const pnlClass = pnl != null && pnl >= 0 ? "pos" : "neg";
    const qtyDisplay = qty != null ? (qty % 1 === 0 ? qty : qty.toFixed(2)) : "—";

    const div = document.createElement("div");
    div.className = "item";
    div.style.cursor = "pointer";

    div.innerHTML = `
      <div>
        <div style="font-weight:600;">${escapeHtml(sym)}</div>
        <div class="small" style="margin-top:2px;">${escapeHtml(side)} × ${escapeHtml(String(qtyDisplay))}</div>
      </div>
      <div class="${pnlClass}" style="font-weight:600; text-align:right;">
        ${escapeHtml(pnlStr)}<span class="small">${escapeHtml(pnlPctStr)}</span>
      </div>
    `;

    div.addEventListener("click", () => openTradeModal(p));
    liveTradesListEl.appendChild(div);
  }
}

async function refreshWatchlistFromApi() {
  try {
    const res = await fetch("/api/watchlist", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`watchlist fetch failed: ${res.status}`);
    const data = await res.json();
    watchSymbols = Array.isArray(data.symbols) ? data.symbols : watchSymbols;
    renderWatchlist(watchSymbols);
  } catch (err) {
    console.warn("[watchlist] refresh failed", err);
  }
}

async function refreshClosedAlertIdsFromApi() {
  try {
    const res = await fetch("/api/dbrows", { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json().catch(() => null);
    const rows = Array.isArray(j?.rows) ? j.rows : [];

    const next = new Set();
    for (const r of rows) {
      const st = String(r?.status || "").toUpperCase();
      const id = String(r?.alertId || "");
      if (!id) continue;
      if (st === "COMPLETED" || st === "STOPPED") next.add(id);
    }
    // Only update if we actually got rows; prevents accidental wipe on bad fetch
if (next.size) closedAlertIds = next;
  } catch {
    // ignore
  }
}

async function refreshBrokerStats() {
  const equity = document.getElementById("statEquity");
  const cash = document.getElementById("statCash");
  const pnl = document.getElementById("statPnl");
  const positions = document.getElementById("statPositions");

  if (!equity && !cash && !pnl && !positions) return;

  try {
    const res = await fetch("/api/broker/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = await res.json();

    const acc = j?.account;
    const pos = Array.isArray(j?.positions) ? j.positions : [];

    const fmtCurrency = (n) => {
      if (n == null || !Number.isFinite(Number(n))) return "—";
      return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    if (equity) equity.textContent = fmtCurrency(acc?.equity);
    if (cash) cash.textContent = fmtCurrency(acc?.cash);

    const totalPnl = pos.reduce((sum, p) => sum + (Number(p?.unrealizedPl) || 0), 0);
    if (pnl) {
      pnl.textContent = Number.isFinite(totalPnl) && pos.length ? fmtCurrency(totalPnl) : "—";
      pnl.classList.remove("pos", "neg");
      if (Number.isFinite(totalPnl) && pos.length) {
        pnl.classList.add(totalPnl >= 0 ? "pos" : "neg");
      }
    }

    if (positions) positions.textContent = pos.length > 0 ? String(pos.length) : "0";
    renderLiveTrades(pos);
  } catch {
    // Broker not configured or offline — leave dashes
    renderLiveTrades([]);
  }
}

async function refreshSignalsFromApi() {
  try {
    const res = await fetch("/api/signals", { headers: { "Accept": "application/json" }, cache: "no-store" });
    if (!res.ok) throw new Error(`signals fetch failed: ${res.status}`);
    const data = await res.json();
    latestSignals = data?.signals || null;
    renderSignals(latestSignals);
  } catch (err) {
    console.warn("[signals] refresh failed", err);
  }
}

async function refreshAlertsFromApi() {
  try {
    const res = await fetch("/api/alerts", {
      headers: { "Accept": "application/json" },
      cache: "no-store"
    });
    if (!res.ok) throw new Error(`alerts fetch failed: ${res.status}`);

    const data = await res.json().catch(() => null);

    // /api/alerts returns { alerts: [...] }
    const alerts = Array.isArray(data?.alerts) ? data.alerts : (Array.isArray(data) ? data : []);
    allAlerts = alerts;
    trimAlerts();

    // Remove anything already finished so lists match your "active-only" UX
    allAlerts = (allAlerts || []).filter((a) => !closedAlertIds.has(String(a?.id || "")));

    renderFeed(allAlerts);
    refreshBrokerStats();
  } catch (err) {
    console.warn("[alerts] refresh failed", err);
  }
}

function renderWatchlist(symbols) {
  if (!watchChips) return;
  watchChips.innerHTML = "";

  for (const s of symbols || []) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `
      <span class="chip-text">${escapeHtml(s)}</span>
      <button class="chip-x" aria-label="remove">×</button>
    `;

    chip.querySelector(".chip-x")?.addEventListener("click", async () => {
      watchSymbols = watchSymbols.filter((x) => x !== s);
      renderWatchlist(watchSymbols);

      try {
        const res = await fetch("/api/watchlist/remove", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: s })
        });
        if (!res.ok) throw new Error(`remove failed: ${res.status}`);
        await refreshWatchlistFromApi();
      } catch (err) {
        console.error("[watchlist] remove error", err);
        showToast("Could not remove symbol. Your server/API may not be running in this deployment.", "error");
        if (!watchSymbols.includes(s)) watchSymbols = [...watchSymbols, s];
        renderWatchlist(watchSymbols);
      }
    });

    watchChips.appendChild(chip);
  }
}

function renderSignals(s) {
  // Preserve last known signals when data is not live (CHANGE 8)
  if (dataIsLive && s) {
    lastKnownSignals = s;
  }

  const displaySignals = dataIsLive ? s : lastKnownSignals;
  const isStale = !dataIsLive;

  if (!displaySignals) {
    if (overallBiasPillEl) {
      overallBiasPillEl.textContent = "NEUTRAL";
      overallBiasPillEl.classList.remove("bullish", "bearish", "neutral");
      overallBiasPillEl.classList.add("neutral");
    }
    if (marketBiasEl) marketBiasEl.textContent = "Market Bias: —";
    if (indexStatusEl) indexStatusEl.textContent = "SPY: — • QQQ: —";
    if (strongListEl) strongListEl.innerHTML = "";
    if (weakListEl) weakListEl.innerHTML = "";
    if (formingListEl) formingListEl.innerHTML = "";
    return;
  }

  if (overallBiasPillEl) {
    const bias = String(displaySignals.marketBias || "NEUTRAL").toUpperCase();
    const biasLabel = isStale ? "LAST KNOWN" : bias;
    overallBiasPillEl.textContent = biasLabel;
    overallBiasPillEl.classList.remove("bullish", "bearish", "neutral");
    if (!isStale && bias === "BULLISH") overallBiasPillEl.classList.add("bullish");
    else if (!isStale && bias === "BEARISH") overallBiasPillEl.classList.add("bearish");
    else overallBiasPillEl.classList.add("neutral");
  }

  if (marketBiasEl) {
    const suffix = isStale ? " • (last known)" : ` • Updated ${fmtTime(displaySignals.ts)}`;
    marketBiasEl.textContent = `Market Bias: ${displaySignals.marketBias}${suffix}`;
  }

  const spy = displaySignals.spy || {};
  const qqq = displaySignals.qqq || {};
  if (indexStatusEl) {
    indexStatusEl.textContent =
      `SPY: ${fmt2(spy.price)} vs VWAP ${fmt2(spy.vwap)} (${spy.side || "NA"}) • ` +
      `QQQ: ${fmt2(qqq.price)} vs VWAP ${fmt2(qqq.vwap)} (${qqq.side || "NA"})`;
  }

  function fillList(el, arr, label) {
    if (!el) return;
    el.innerHTML = "";
    if (!arr || !arr.length) {
      el.innerHTML = `<div class="small">No ${label} tickers right now.</div>`;
      return;
    }
    for (const it of arr) {
      const div = document.createElement("div");
      div.className = "ticker-item";
      div.innerHTML = `
        <span class="ticker-pill ${label === "strong" ? "bullish" : "bearish"}">
          ${escapeHtml(it.symbol)}
        </span>
      `;
      el.appendChild(div);
    }
  }

  fillList(strongListEl, displaySignals.strong, "strong");
  fillList(weakListEl, displaySignals.weak, "weak");

  if (formingListEl) {
    formingListEl.innerHTML = "";
    const arr = displaySignals.forming || [];
    if (!arr.length) {
      if (formingEmptyEl) formingEmptyEl.style.display = "block";
    } else {
      if (formingEmptyEl) formingEmptyEl.style.display = "none";
      for (const it of arr) {
        // CHANGE 10: Distance badge coloring by proximity
        const dist = it.distanceToTriggerPct;
        let badgeClass = "amber";
        let distLabel = dist != null ? fmt2(dist) + "%" : "—";
        if (dist != null) {
          if (dist < 0.2) {
            badgeClass = "red";
            distLabel = "⚡ " + distLabel;
          } else if (dist < 0.5) {
            badgeClass = "amber";
            distLabel = "🔥 " + distLabel;
          }
        }

        // CHANGE 10: Readiness progress bar
        const scoreWidth = Math.min(100, Math.max(0, Number(it.readinessScore) || 0));

        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
          <div style="flex:1;min-width:0;">
            <div><b>${escapeHtml(it.symbol)}</b> — ${escapeHtml(it.dir)} • ${escapeHtml(it.stage || "forming")} • ${escapeHtml(it.level)} ${fmt2(it.levelPrice)}${isStale ? ' <span class="small" style="opacity:0.6;">(last known)</span>' : ""}</div>
            <div class="small">Last ${it.lastPrice != null ? fmt2(it.lastPrice) : "—"} • Dist <span style="color:${dist != null && dist < 0.2 ? "var(--neg)" : dist != null && dist < 0.5 ? "#d97706" : "inherit"}">${escapeHtml(distLabel)}</span> • Score ${fmt2(it.readinessScore)} • RS ${escapeHtml(it.rs)}</div>
            <div style="margin:4px 0 2px;height:3px;background:var(--line);border-radius:2px;overflow:hidden;">
              <div style="width:${scoreWidth}%;height:100%;background:var(--accent);border-radius:2px;transition:width 0.3s;"></div>
            </div>
            <div class="small">Passed: ${escapeHtml((it.passedConditions || []).join(", ") || "—")}</div>
            <div class="small">Missing: ${escapeHtml((it.missingConditions || []).join(", ") || "—")}</div>
            <div class="small">Next: ${escapeHtml(it.nextCatalyst || "—")}</div>
          </div>
          <div class="badge ${badgeClass}" style="margin-left:8px;flex-shrink:0;">${isStale ? "LAST KNOWN" : "FORMING"}</div>
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
  const symbol = String(symInput?.value || "").trim().toUpperCase();
  if (!symbol) return;

  // This is the key: user sees something even if backend fails
  if (symInput) symInput.value = "";

  if (!watchSymbols.includes(symbol)) {
    watchSymbols = [...watchSymbols, symbol];
    renderWatchlist(watchSymbols);
  }

  try {
    addBtn.disabled = true;

    const res = await fetch("/api/watchlist/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol })
    });

    if (!res.ok) throw new Error(`add failed: ${res.status}`);
    await refreshWatchlistFromApi();
  } catch (err) {
    console.error("[watchlist] add error", err);
    watchSymbols = watchSymbols.filter((s) => s !== symbol);
    renderWatchlist(watchSymbols);
    showToast("Could not add symbol. Your server/API may not be running in this deployment.", "error");
  } finally {
    addBtn.disabled = false;
  }
});

symInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn?.click();
});

if (!sharedAiHandled) {
  aiOperatorAskBtn?.addEventListener("click", () => {
    runAiOperator("chat", true);
  });

  aiOperatorPromptEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runAiOperator("chat", true);
    }
  });

  aiOperatorLauncherEl?.addEventListener("click", () => {
    const isOpen = aiOperatorPanelEl?.classList.contains("open");
    setAiOperatorOpen(!isOpen);
  });

  aiOperatorCloseBtnEl?.addEventListener("click", () => {
    setAiOperatorOpen(false);
  });

  aiOperatorNewChatBtnEl?.addEventListener("click", () => {
    resetAiChatHistory();
    aiOperatorPromptEl?.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setAiOperatorOpen(false);
  });
}

// -----------------------
// Socket wiring (only if socket exists)
// -----------------------
if (socket) {

  socket.on("init", (payload) => {
    allAlerts = Array.isArray(payload.alerts) ? payload.alerts : [];
    trimAlerts();

    watchSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
    latestSignals = payload.signals || null;

    renderFeed(allAlerts);
    refreshBrokerStats();
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
    trimAlerts();

    refreshBrokerStats();

    if (String(alert.message || "").includes("A+ ENTRY")) {
      ding();

      if (feedBody) {
        const r = row(alert);
        r.classList.add("new-animate");
        feedBody.prepend(r);

        while (feedBody.children.length > FEED_MAX_ROWS) {
          feedBody.removeChild(feedBody.lastChild);
        }
      }
    }
  });

  socket.on("outcome", (payload) => {
    try {
      const o = payload?.outcome || null;
      const id = String(o?.alertId || "");
      if (!id) return;

      closedAlertIds.add(id);
  
      // Remove from local alerts so Activity Feed + A+ list can re-render cleanly
      allAlerts = (allAlerts || []).filter((a) => String(a?.id || "") !== id);
  
      // Re-render the pieces that show "active" items
      renderFeed(allAlerts);
      refreshBrokerStats();
    } catch {
      // ignore
    }
  });


} else {
  // No socket available (likely static deployment). Still keep UI functional.
  if (socketDot) socketDot.classList.remove("live");
}

// -----------------------
// Always-on polling (works with or without sockets)
// -----------------------

refreshDataLiveDot();
refreshBrokerStats();
if (!sharedAiHandled) {
  refreshAiOperatorStatus();
  loadAiChatHistory();
  renderAiChatThread();
}

setInterval(() => {
  refreshWatchlistFromApi();
  refreshSignalsFromApi();
  refreshClosedAlertIdsFromApi();
  refreshAlertsFromApi();
  refreshDataLiveDot();
  if (!sharedAiHandled) refreshAiOperatorStatus();
}, 5000);

setInterval(() => {
  refreshBrokerStats();
}, 15000);
