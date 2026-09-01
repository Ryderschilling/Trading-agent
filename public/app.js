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

// Alert ids the broker actually accepted an order for. The Activity feed shows
// only these, so it reads as "trades taken", not "signals seen". Populated from
// /api/dbrows (row.brokerSubmitted) on the 5s poll.
let brokerAlertIds = new Set();
let brokerIdsLoaded = false;

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
    if (g) {
      statusGhosts = Array.isArray(g?.ghosts) ? g.ghosts.length : 0;
      renderGhostBanner(g);
    }
    if (c) {
      statusStale = {
        staleCount: Number(c?.staleCount || (Array.isArray(c?.staleSymbols) ? c.staleSymbols.length : 0)),
        watchlistCount: Number(c?.watchlistCount || 0),
      };
      renderCoverageBanner(c);
    }
    renderStatusBar();
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

    statusFeed = { live, isRth, barsFresh, meta };
    renderStatusBar();
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
    statusFeed = { live: false, isRth: null, barsFresh: null, meta: "Server or data feed unreachable" };
    renderStatusBar();
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


// =======================================================================
// Workspace overview — hero tiles, Today scoreboard, equity curve.
//
// All of it reads two sources already polled by this page:
//   /api/broker/status  → account + open positions (the unrealized side)
//   /api/dbrows         → trades, filtered to brokerSubmitted (the realized side)
// plus /api/equity for the curve, which is the only new endpoint.
// =======================================================================

let latestAccount = null;
let latestPositions = [];
let dbRows = [];
let equityRange = "day";
let equityPoints = [];
let equityHoverIdx = -1;

const statEquityEl = document.getElementById("statEquity");
const statEquitySubEl = document.getElementById("statEquitySub");
const statTodayEl = document.getElementById("statToday");
const statTodaySubEl = document.getElementById("statTodaySub");
const statPositionsEl = document.getElementById("statPositions");
const statPnlEl = document.getElementById("statPnl");
const statExposureEl = document.getElementById("statExposure");
const statExposureSubEl = document.getElementById("statExposureSub");
const todayNetEl = document.getElementById("todayNet");
const todayGridEl = document.getElementById("todayGrid");
const equityCanvasEl = document.getElementById("equityChart");
const equityEmptyEl = document.getElementById("equityEmpty");
const equityHintEl = document.getElementById("equityHint");

/**
 * Did the broker actually take this trade? `brokerFilled` is the server's
 * answer (submitted AND filled, or still open); `brokerSubmitted` is the older
 * field and is only used as a fallback if the page is served by a build that
 * predates brokerFilled.
 */
function isTakenTrade(r) {
  if (!r) return false;
  if (r.brokerFilled != null) return Boolean(r.brokerFilled);
  return Boolean(r.brokerSubmitted);
}

function usd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signClass(v) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  return Number(v) > 0 ? "pos" : Number(v) < 0 ? "neg" : "";
}

/** Start of the current NY trading day, in epoch ms. */
function nyDayStartMs(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const secondsIntoDay = get("hour") * 3600 + get("minute") * 60 + get("second");
  return now - secondsIntoDay * 1000;
}

/** Broker-submitted rows from today, newest first. */
function todayRows() {
  const start = nyDayStartMs();
  return (dbRows || []).filter((r) => isTakenTrade(r) && Number(r.ts || 0) >= start);
}

/**
 * The alert row behind an open position: today's most recent broker-submitted
 * LIVE row for that symbol. Used for the entry marker and the level label.
 */
function findOpenAlertRowForSymbol(symbol) {
  const sym = String(symbol || "").toUpperCase();
  const candidates = todayRows()
    .filter((r) => String(r.symbol || "").toUpperCase() === sym)
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  return candidates.find((r) => String(r.status || "").toUpperCase() === "LIVE") || candidates[0] || null;
}

function renderHeroTiles() {
  const equity = latestAccount?.equity == null ? null : Number(latestAccount.equity);
  const positions = latestPositions || [];
  const unrealized = positions.reduce((s, p) => s + (Number(p?.unrealizedPl) || 0), 0);
  const exposure = positions.reduce((s, p) => s + Math.abs(Number(p?.marketValue) || 0), 0);

  const closed = todayRows().filter((r) => String(r.status || "").toUpperCase() !== "LIVE");
  const realized = closed
    .map((r) => Number(r.realizedPnlUsd))
    .filter((v) => Number.isFinite(v))
    .reduce((a, b) => a + b, 0);
  const hasRealized = closed.some((r) => Number.isFinite(Number(r.realizedPnlUsd)));

  const dayTotal = (hasRealized ? realized : 0) + (positions.length ? unrealized : 0);
  const hasDay = hasRealized || positions.length > 0;

  if (statEquityEl) statEquityEl.textContent = usd(equity);
  if (statEquitySubEl) {
    // The session's opening equity, taken from the first sample of the day.
    const open = equityPoints.length ? Number(equityPoints[0].equity) : null;
    if (equity != null && open != null && Number.isFinite(open) && equityRange === "day") {
      const delta = equity - open;
      statEquitySubEl.textContent = `${signedUsd(delta)} since open`;
      statEquitySubEl.className = "stat-tile-sub " + signClass(delta);
    } else {
      statEquitySubEl.innerHTML = "&nbsp;";
      statEquitySubEl.className = "stat-tile-sub";
    }
  }

  // Percent basis is the equity the day STARTED at, not the current equity —
  // dividing today's P&L by an equity figure that already contains it would
  // understate the move. Falls back to current equity before the first sample
  // of the day lands.
  const openEquity =
    equityPoints.length && Number.isFinite(Number(equityPoints[0].equity))
      ? Number(equityPoints[0].equity)
      : equity;
  const dayPct =
    hasDay && openEquity && Number.isFinite(openEquity) && openEquity > 0
      ? (dayTotal / openEquity) * 100
      : null;

  if (statTodayEl) {
    statTodayEl.textContent = hasDay ? signedUsd(dayTotal) : "—";
    if (hasDay && dayPct != null) {
      const pctEl = document.createElement("span");
      pctEl.style.fontSize = "0.72em";
      pctEl.style.opacity = "0.85";
      pctEl.style.marginLeft = "6px";
      pctEl.textContent = `${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}%`;
      statTodayEl.appendChild(pctEl);
    }
    statTodayEl.className = "stat-tile-value " + (hasDay ? signClass(dayTotal) : "");
  }
  if (statTodaySubEl) {
    statTodaySubEl.textContent = hasDay
      ? `${hasRealized ? signedUsd(realized) : "$0.00"} closed${positions.length ? ` · ${signedUsd(unrealized)} open` : ""}`
      : "No trades taken yet";
    statTodaySubEl.className = "stat-tile-sub";
  }

  if (statPositionsEl) statPositionsEl.textContent = String(positions.length);
  if (statPnlEl) {
    statPnlEl.textContent = positions.length ? `${signedUsd(unrealized)} unrealized` : "Flat";
    statPnlEl.className = "stat-tile-sub " + (positions.length ? signClass(unrealized) : "");
  }

  if (statExposureEl) statExposureEl.textContent = positions.length ? usd(exposure) : "$0.00";
  if (statExposureSubEl) {
    statExposureSubEl.textContent =
      positions.length && equity ? `${fmt2((exposure / equity) * 100)}% of equity` : "Nothing at risk";
    statExposureSubEl.className = "stat-tile-sub";
  }
}

function renderTodayCard() {
  if (!todayGridEl) return;

  const rows = todayRows();
  const closed = rows.filter((r) => String(r.status || "").toUpperCase() !== "LIVE");

  const dollars = closed.map((r) => Number(r.realizedPnlUsd)).filter((v) => Number.isFinite(v));
  const pcts = closed
    .map((r) => {
      if (Number.isFinite(Number(r.exitReturnPct))) return Number(r.exitReturnPct);
      if (r.stoppedOut && Number.isFinite(Number(r.stopReturnPct))) return Number(r.stopReturnPct);
      return null;
    })
    .filter((v) => v != null && Number.isFinite(v));

  const net = dollars.reduce((a, b) => a + b, 0);
  const wins = pcts.filter((v) => v > 0).length;
  const winRate = pcts.length ? (wins / pcts.length) * 100 : null;
  const best = pcts.length ? Math.max(...pcts) : null;
  const worst = pcts.length ? Math.min(...pcts) : null;

  if (todayNetEl) {
    todayNetEl.textContent = dollars.length ? signedUsd(net) : "—";
    todayNetEl.className = "today-net " + (dollars.length ? signClass(net) : "");
  }

  const pct = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmt2(v)}%`);
  const item = (label, value, cls) => `
    <div class="today-item">
      <div class="today-item-label">${label}</div>
      <div class="today-item-value ${cls || ""}">${value}</div>
    </div>`;

  const avg = pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null;
  const stopped = closed.filter((r) => r.stoppedOut).length;

  todayGridEl.innerHTML = [
    item("Taken", String(rows.length)),
    item("Closed", String(closed.length)),
    item("Win rate", winRate == null ? "—" : `${fmt2(winRate)}%`, winRate == null ? "" : winRate >= 50 ? "pos" : "neg"),
    item("Open", String(rows.length - closed.length)),
    item("Avg trade", pct(avg), signClass(avg)),
    item("Stopped out", String(stopped)),
    item("Best", pct(best), signClass(best)),
    item("Worst", pct(worst), signClass(worst)),
  ].join("");
}

// -----------------------
// Equity curve
// -----------------------
function drawEquityCurve() {
  if (!equityCanvasEl) return;

  const pts = (equityPoints || []).filter((p) => Number.isFinite(Number(p.equity)));
  if (equityEmptyEl) equityEmptyEl.classList.toggle("show", pts.length < 2);

  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const rect = equityCanvasEl.getBoundingClientRect();
  const w = Math.max(280, Math.round(rect.width || 600));
  const h = Math.max(160, Math.round(rect.height || 240));
  if (equityCanvasEl.width !== w * ratio || equityCanvasEl.height !== h * ratio) {
    equityCanvasEl.width = w * ratio;
    equityCanvasEl.height = h * ratio;
  }

  const ctx = equityCanvasEl.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (pts.length < 2) return;

  const padTop = 16;
  const padBottom = 22;
  const padLeft = 12;
  const padRight = 70;
  const plotW = Math.max(20, w - padLeft - padRight);
  const plotH = Math.max(20, h - padTop - padBottom);

  const values = pts.map((p) => Number(p.equity));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 0.01) { hi += 0.5; lo -= 0.5; }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;

  const xOf = (i) => padLeft + (i / (pts.length - 1)) * plotW;
  const yOf = (v) => padTop + plotH - ((v - lo) / (hi - lo)) * plotH;

  const first = values[0];
  const last = values[values.length - 1];
  const up = last >= first;
  const line = up ? "#22c55e" : "#ef4444";

  // Horizontal guides
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padTop + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
  }

  // Opening reference
  const openY = yOf(first);
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.moveTo(padLeft, openY);
  ctx.lineTo(padLeft + plotW, openY);
  ctx.stroke();
  ctx.restore();

  // Filled area
  const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  grad.addColorStop(0, up ? "rgba(34,197,94,0.26)" : "rgba(239,68,68,0.26)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
  ctx.lineTo(xOf(values.length - 1), padTop + plotH);
  ctx.lineTo(xOf(0), padTop + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(values[0]));
  for (let i = 1; i < values.length; i++) ctx.lineTo(xOf(i), yOf(values[i]));
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Right-edge price pill
  const py = yOf(last);
  const label = usd(last);
  ctx.font = "11px system-ui";
  const tw = ctx.measureText(label).width;
  const pw = tw + 12;
  const ph = 18;
  const px = Math.min(w - pw - 2, padLeft + plotW + 6);
  const pyc = Math.max(padTop, Math.min(py - ph / 2, padTop + plotH - ph));
  ctx.fillStyle = "rgba(15,22,38,0.95)";
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.rect(px, pyc, pw, ph);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(231,237,246,0.95)";
  ctx.textBaseline = "middle";
  ctx.fillText(label, px + 6, pyc + ph / 2 + 0.5);

  // Hover readout
  if (equityHoverIdx >= 0 && equityHoverIdx < pts.length) {
    const i = equityHoverIdx;
    const hx = xOf(i);
    const hy = yOf(values[i]);
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, padTop);
    ctx.lineTo(hx, padTop + plotH);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = line;
    ctx.beginPath();
    ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
    ctx.fill();

    const txt = `${fmtTime(pts[i].ts)}  ${usd(values[i])}`;
    ctx.font = "11px system-ui";
    const bw = ctx.measureText(txt).width + 14;
    const bx = Math.min(Math.max(padLeft, hx - bw / 2), padLeft + plotW - bw);
    ctx.fillStyle = "rgba(10,16,28,0.95)";
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.rect(bx, padTop - 2, bw, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(231,237,246,0.95)";
    ctx.fillText(txt, bx + 7, padTop + 8.5);
  }

  if (equityHintEl) {
    const delta = last - first;
    const pctDelta = first ? (delta / first) * 100 : 0;
    const rangeLabel = equityRange === "day" ? "today" : equityRange === "month" ? "last 30 days" : "all time";
    equityHintEl.textContent = `${signedUsd(delta)} (${delta >= 0 ? "+" : ""}${fmt2(pctDelta)}%) ${rangeLabel} · ${pts.length} samples`;
  }
}

async function refreshEquityCurve() {
  if (!equityCanvasEl) return;
  try {
    const res = await fetch(`/api/equity?range=${encodeURIComponent(equityRange)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = await res.json();
    equityPoints = Array.isArray(j?.points) ? j.points : [];
  } catch {
    equityPoints = [];
  }
  drawEquityCurve();
  renderHeroTiles();
}

if (equityCanvasEl) {
  equityCanvasEl.addEventListener("mousemove", (e) => {
    const pts = (equityPoints || []).filter((p) => Number.isFinite(Number(p.equity)));
    if (pts.length < 2) return;
    const rect = equityCanvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const padLeft = 12;
    const plotW = Math.max(20, rect.width - padLeft - 70);
    const t = Math.max(0, Math.min(1, (x - padLeft) / plotW));
    equityHoverIdx = Math.round(t * (pts.length - 1));
    drawEquityCurve();
  });
  equityCanvasEl.addEventListener("mouseleave", () => {
    equityHoverIdx = -1;
    drawEquityCurve();
  });
  window.addEventListener("resize", () => drawEquityCurve());

  for (const btn of document.querySelectorAll("#equityRange .range-toggle")) {
    btn.addEventListener("click", () => {
      const r = String(btn.dataset.range || "day");
      if (r === equityRange) return;
      equityRange = r;
      for (const b of document.querySelectorAll("#equityRange .range-toggle")) {
        b.classList.toggle("active", b === btn);
      }
      void refreshEquityCurve();
    });
  }
}


// -----------------------
// Status strip (replaces the Trading Paused / Data Coverage / Ghost banners)
// -----------------------
const statusBarEl = document.getElementById("statusBar");
const statusBarTextEl = document.getElementById("statusBarText");
const statusBarMetaEl = document.getElementById("statusBarMeta");

let statusFeed = null;   // { live, isRth, barsFresh, meta }
let statusStale = null;  // { staleCount, watchlistCount }
let statusGhosts = 0;

function renderStatusBar() {
  if (!statusBarEl || !statusBarTextEl) return;

  const live = Boolean(statusFeed?.live);
  const stale = Number(statusStale?.staleCount || 0);
  const watched = Number(statusStale?.watchlistCount || 0);

  // Ghost positions mean broker holdings nobody is tracking. That outranks
  // everything else on this bar, in any session.
  if (statusGhosts > 0) {
    statusBarEl.classList.remove("live");
    statusBarTextEl.textContent = `${statusGhosts} untracked broker position${statusGhosts === 1 ? "" : "s"} — reconcile on Brokers`;
    if (statusBarMetaEl) statusBarMetaEl.textContent = "Ghost positions";
    return;
  }

  statusBarEl.classList.toggle("live", live);

  if (live) {
    statusBarTextEl.textContent = "Live — trading armed";
    if (statusBarMetaEl) {
      statusBarMetaEl.textContent = watched
        ? `${watched - stale}/${watched} symbols streaming`
        : "Feed healthy";
    }
    return;
  }

  statusBarTextEl.textContent = statusFeed?.isRth === false
    ? "Paused — market closed"
    : statusFeed?.barsFresh === false
    ? "Paused — market data stale"
    : "Paused — feed not confirmed";

  if (statusBarMetaEl) {
    statusBarMetaEl.textContent = stale && watched
      ? `${stale}/${watched} symbols stale · ${statusFeed?.meta || ""}`.trim()
      : String(statusFeed?.meta || "");
  }
}

// -----------------------
// Rendering
// -----------------------
// A trade row for the feed, built from /api/dbrows — the DB is the only
// reliable source here. /api/alerts serves an in-memory array that is empty
// after a restart, which is exactly why this table used to read "No trades
// taken yet" on a day with four fills.
function row(r) {
  const tr = document.createElement("tr");
  tr.dataset.alertId = String(r.alertId || "");

  const td = (t) => {
    const el = document.createElement("td");
    el.textContent = t;
    return el;
  };

  const status = String(r.status || "LIVE").toUpperCase();

  const usdPnl = Number(r.realizedPnlUsd);
  const pctPnl = Number.isFinite(Number(r.exitReturnPct))
    ? Number(r.exitReturnPct)
    : r.stoppedOut && Number.isFinite(Number(r.stopReturnPct))
    ? Number(r.stopReturnPct)
    : null;

  let pnlTxt = "—";
  let pnlCls = "";
  if (Number.isFinite(usdPnl)) {
    pnlTxt = signedUsd(usdPnl) + (pctPnl == null ? "" : ` (${pctPnl > 0 ? "+" : ""}${fmt2(pctPnl)}%)`);
    pnlCls = signClass(usdPnl);
  } else if (pctPnl != null) {
    pnlTxt = `${pctPnl > 0 ? "+" : ""}${fmt2(pctPnl)}%`;
    pnlCls = signClass(pctPnl);
  }

  // Columns must match index.html thead:
  // Time | Symbol | Dir | Level | Market | RS | Status | Result
  tr.appendChild(td(fmtTime(r.ts)));
  tr.appendChild(td(r.symbol || ""));
  tr.appendChild(td(r.dir || "—"));
  tr.appendChild(td(r.level || "—"));
  tr.appendChild(td(r.market || "—"));
  tr.appendChild(td(r.rs || "—"));

  // Colour the status by the money, not by the word: a COMPLETED trade that
  // lost is a red row, the same as a stop.
  const statusTd = td(status === "LIVE" ? "OPEN" : status);
  statusTd.style.fontWeight = "700";
  statusTd.style.color =
    status === "LIVE" ? "var(--muted,#9aa6bb)"
    : pnlCls === "pos" ? "var(--pos,#22c55e)"
    : pnlCls === "neg" ? "var(--neg,#ef4444)"
    : status === "STOPPED" ? "var(--neg,#ef4444)"
    : "var(--muted,#9aa6bb)";
  tr.appendChild(statusTd);

  const pnlTd = td(pnlTxt);
  pnlTd.style.fontWeight = "700";
  if (pnlCls === "pos") pnlTd.style.color = "var(--pos,#22c55e)";
  if (pnlCls === "neg") pnlTd.style.color = "var(--neg,#ef4444)";
  tr.appendChild(pnlTd);

  tr.className = "clickable";
  tr.style.cursor = "pointer";
  tr.addEventListener("click", () => openTakenTradeModal(r));
  return tr;
}

function renderFeed() {
  if (!feedBody) return;
  feedBody.innerHTML = "";

  // Every entry the broker took, newest first — closed ones included, because
  // this is the trade log, not a list of what is still open.
  const ordered = (dbRows || [])
    .filter((r) => isTakenTrade(r))
    .slice()
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, FEED_MAX_ROWS);

  if (!ordered.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.className = "small";
    td.style.padding = "16px";
    td.style.opacity = "0.6";
    td.textContent = brokerIdsLoaded ? "No trades taken yet." : "Loading…";
    tr.appendChild(td);
    feedBody.appendChild(tr);
    return;
  }

  for (const r of ordered) feedBody.appendChild(row(r));
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
    <div class="trade-chart-stage"><canvas id="tradeChart"></canvas></div>
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

  // Chart — the same engine the Outcomes modal uses, so an open trade is read
  // the same way a closed one is: entry marked, structural levels drawn, 9 EMA
  // and VWAP on top.
  await drawTradeChartInto(
    document.getElementById("tradeChart"),
    sym,
    findOpenAlertRowForSymbol(sym),
    entry
  );

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


/**
 * Draws the Outcomes-grade chart into a canvas for one trade.
 * Shared by the open-position modal and the taken-trade modal so both read the
 * same way. `row` is a /api/dbrows row (may be null for a position with no
 * matching alert); `entryPrice` overrides the row when the broker fill is known.
 */
async function drawTradeChartInto(canvas, symbol, row, entryPrice) {
  if (!canvas) return;

  const endTs = row?.endTs && Number.isFinite(Number(row.endTs)) ? Number(row.endTs) : Date.now();
  try {
    const res = await fetch(
      `/api/candles?symbol=${encodeURIComponent(symbol)}&end=${endTs}&minutes=240`,
      { cache: "no-store" }
    );
    const j = await res.json().catch(() => null);
    const raw = Array.isArray(j?.bars) ? j.bars : [];

    if (!window.ChartCore) {
      drawCandleChart(canvas, raw);
      return;
    }

    // 2m candles: 240 one-minute bars is too dense to read in a 300px stage.
    const bars = window.ChartCore.aggregateBars(window.ChartCore.normalizeBars(raw), 2);

    const GREEN = "rgba(74, 222, 128, 0.95)";
    const RED = "rgba(248, 113, 113, 0.95)";
    const PINK = "rgba(255, 82, 172, 0.95)";
    const levels = [];
    const seen = new Set();
    for (const spec of [
      { key: "pdh", label: "PDH", color: GREEN },
      { key: "pdl", label: "PDL", color: RED },
      { key: "pmh", label: "PMH", color: PINK },
      { key: "pml", label: "PML", color: PINK },
    ]) {
      const v = Number(row?.[spec.key]);
      if (!Number.isFinite(v)) continue;
      const k = v.toFixed(4);
      if (seen.has(k)) continue;
      seen.add(k);
      levels.push({ price: v, color: spec.color, label: spec.label, dash: [5, 4], lineWidth: 1.4 });
    }

    const entry = Number.isFinite(Number(entryPrice))
      ? Number(entryPrice)
      : Number.isFinite(Number(row?.entryFill))
      ? Number(row.entryFill)
      : Number.isFinite(Number(row?.entryRef))
      ? Number(row.entryRef)
      : null;

    if (entry != null) {
      levels.push({
        price: entry,
        color: "rgba(255, 214, 102, 0.95)",
        label: "ENTRY",
        dash: [2, 3],
        lineWidth: 1.2,
      });
    }

    window.ChartCore.drawChart(canvas, bars, {
      entryTs: row?.ts ? Number(row.ts) : null,
      exitTs: row?.endTs ? Number(row.endTs) : null,
      showEntry: Boolean(row?.ts),
      showExit: Boolean(row?.endTs),
      showVwap: true,
      levels,
      emas: [{ period: 9, color: "rgba(255, 255, 255, 0.92)", lineWidth: 1.4, label: "9" }],
    });
  } catch {
    if (window.ChartCore) window.ChartCore.drawChart(canvas, [], {});
    else drawCandleChart(canvas, []);
  }
}

/** Read-only detail for a trade in the Trades Taken table. */
async function openTakenTradeModal(r) {
  if (!tradeModalEl || !tradeModalBodyEl || !tradeModalTitleEl) return;

  const sym = String(r.symbol || "");
  const status = String(r.status || "LIVE").toUpperCase();
  const usdPnl = Number(r.realizedPnlUsd);
  const pctPnl = Number.isFinite(Number(r.exitReturnPct))
    ? Number(r.exitReturnPct)
    : r.stoppedOut && Number.isFinite(Number(r.stopReturnPct))
    ? Number(r.stopReturnPct)
    : null;

  const cls = Number.isFinite(usdPnl) ? signClass(usdPnl) : signClass(pctPnl);
  const color = cls === "pos" ? "var(--pos,#22c55e)" : cls === "neg" ? "var(--neg,#ef4444)" : "var(--muted,#9aa6bb)";

  const cell = (label, value) => `
    <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:10px 12px;">
      <div style="font-size:11px; color:var(--muted,#888); margin-bottom:3px;">${label}</div>
      <div style="font-weight:600;">${value}</div>
    </div>`;

  const px = (v) => (Number.isFinite(Number(v)) ? "$" + fmt2(Number(v)) : "—");

  tradeModalTitleEl.textContent = `${sym} — ${r.dir || "—"} · ${status === "LIVE" ? "OPEN" : status}`;
  tradeModalBodyEl.innerHTML = `
    <div class="trade-chart-stage"><canvas id="tradeChart"></canvas></div>
    <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:16px;">
      ${cell("Entry", px(r.entryFill !== "" && r.entryFill != null ? r.entryFill : r.entryRef))}
      ${cell("Exit", px(r.exitFill))}
      ${cell("Qty", Number.isFinite(Number(r.qty)) ? escapeHtml(String(Number(r.qty))) : "—")}
      ${cell("Level", escapeHtml(String(r.level || "—")))}
    </div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px;">
      ${cell("Entered", escapeHtml(fmtDateTime(r.ts)))}
      ${cell("Exited", r.endTs ? escapeHtml(fmtDateTime(r.endTs)) : "Still open")}
      ${cell("Exit reason", escapeHtml(String(r.exitReason || (status === "LIVE" ? "—" : status))))}
    </div>
    <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center;">
      <span style="font-size:12px; color:var(--muted,#888);">Result</span>
      <span style="font-weight:700; font-size:16px; color:${color};">
        ${Number.isFinite(usdPnl) ? escapeHtml(signedUsd(usdPnl)) : "—"}
        <span style="font-size:13px;">${pctPnl == null ? "" : escapeHtml((pctPnl > 0 ? "+" : "") + fmt2(pctPnl) + "%")}</span>
      </span>
    </div>
  `;

  tradeModalOpen();
  await drawTradeChartInto(
    document.getElementById("tradeChart"),
    sym,
    r,
    r.entryFill !== "" && r.entryFill != null ? r.entryFill : null
  );
}

function renderLiveTrades(positions) {
  if (!liveTradesListEl || !liveTradesEmptyEl) return;

  const liveTradesTableEl = document.getElementById("liveTradesTable");
  const liveTradesSummaryEl = document.getElementById("liveTradesSummary");
  const liveTradesTotalPnlEl = document.getElementById("liveTradesTotalPnl");

  liveTradesListEl.innerHTML = "";

  const items = (Array.isArray(positions) ? positions : [])
    .filter((p) => p.qty != null && Math.abs(Number(p.qty)) > 0.0001);

  latestPositions = items;
  renderHeroTiles();

  if (!items.length) {
    liveTradesEmptyEl.style.display = "block";
    if (liveTradesTableEl) liveTradesTableEl.style.display = "none";
    if (liveTradesSummaryEl) liveTradesSummaryEl.textContent = "";
    if (liveTradesTotalPnlEl) liveTradesTotalPnlEl.textContent = "";
    return;
  }

  liveTradesEmptyEl.style.display = "none";
  if (liveTradesTableEl) liveTradesTableEl.style.display = "block";

  const totalPnl = items.reduce((sum, p) => sum + (Number(p?.unrealizedPl) || 0), 0);
  if (liveTradesSummaryEl) {
    liveTradesSummaryEl.textContent = `${items.length} open position${items.length === 1 ? "" : "s"}`;
  }
  if (liveTradesTotalPnlEl) {
    liveTradesTotalPnlEl.textContent = signedUsd(totalPnl);
    liveTradesTotalPnlEl.style.color = totalPnl >= 0 ? "var(--pos,#22c55e)" : "var(--neg,#ef4444)";
  }

  for (const p of items) {
    const sym = String(p.symbol || "");
    const qty = p.qty != null ? Number(p.qty) : null;
    const pnl = p.unrealizedPl != null ? Number(p.unrealizedPl) : null;
    const pnlPct = p.unrealizedPlPct != null ? Number(p.unrealizedPlPct) * 100 : null;
    const side = String(p.side || "long").toUpperCase();
    const entry = p.avgEntryPrice != null ? Number(p.avgEntryPrice) : null;
    const mv = p.marketValue != null ? Number(p.marketValue) : null;

    // Last price is not in the position payload, but market value / qty is the
    // broker's own mark, which is what the P&L was computed from.
    const last = mv != null && qty ? Math.abs(mv / qty) : null;

    // The alert this position came from, so the row can show the level that
    // triggered it and the modal can mark the entry on the chart.
    const alertRow = findOpenAlertRowForSymbol(sym);

    const cls = pnl == null ? "" : pnl > 0 ? "pos" : pnl < 0 ? "neg" : "";
    const row = document.createElement("div");
    row.className = "pos-row";

    const meta = [
      `Qty <b>${escapeHtml(qty != null ? (qty % 1 === 0 ? String(qty) : qty.toFixed(4)) : "—")}</b>`,
      `Entry <b>${entry != null ? "$" + fmt2(entry) : "—"}</b>`,
      `Last <b>${last != null ? "$" + fmt2(last) : "—"}</b>`,
      `Value <b>${mv != null ? "$" + fmt2(Math.abs(mv)) : "—"}</b>`,
    ];
    if (alertRow?.level) meta.push(`Level <b>${escapeHtml(String(alertRow.level))}</b>`);
    if (alertRow?.ts) meta.push(`In <b>${escapeHtml(fmtTime(alertRow.ts))}</b>`);

    row.innerHTML = `
      <div>
        <div class="pos-sym">${escapeHtml(sym)}</div>
        <div class="pos-side ${side === "SHORT" ? "short" : "long"}">${escapeHtml(side)}</div>
      </div>
      <div class="pos-meta">${meta.join("")}</div>
      <div>
        <div class="pos-pnl ${cls}">${pnl == null ? "—" : signedUsd(pnl)}</div>
        <div class="pos-pnl-sub">${pnlPct == null ? "" : (pnlPct >= 0 ? "+" : "") + fmt2(pnlPct) + "%"}</div>
      </div>
    `;

    row.addEventListener("click", () => openTradeModal(p));
    liveTradesListEl.appendChild(row);
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
    if (Array.isArray(j?.rows)) dbRows = rows;

    const next = new Set();
    const nextBroker = new Set();
    for (const r of rows) {
      const st = String(r?.status || "").toUpperCase();
      const id = String(r?.alertId || "");
      if (!id) continue;
      if (st === "COMPLETED" || st === "STOPPED") next.add(id);
      if (isTakenTrade(r)) nextBroker.add(id);
    }
    // Only update if we actually got rows; prevents accidental wipe on bad fetch
if (next.size) closedAlertIds = next;

    // The broker set is replaced even when empty — an empty result genuinely
    // means no orders were taken, and a stale set would show phantom trades.
    if (Array.isArray(j?.rows)) {
      let firstNew = null;
      if (brokerIdsLoaded) {
        for (const id of nextBroker) {
          if (!brokerAlertIds.has(id)) { firstNew = id; break; }
        }
      }
      brokerAlertIds = nextBroker;
      brokerIdsLoaded = true;
      if (firstNew) ding();
    }

    // The whole page below the tiles is derived from these rows — feed rows,
    // their statuses and P&L, and Today's numbers — so everything re-renders
    // here rather than on its own timer.
    if (Array.isArray(j?.rows)) {
      renderFeed();
      renderTodayCard();
      renderHeroTiles();
    }
  } catch {
    // ignore
  }
}

async function refreshBrokerStats() {
  const anyTile =
    document.getElementById("statEquity") ||
    document.getElementById("statPositions") ||
    document.getElementById("statToday");
  if (!anyTile) return;

  try {
    const res = await fetch("/api/broker/status", { cache: "no-store" });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = await res.json();

    latestAccount = j?.account || null;
    renderLiveTrades(Array.isArray(j?.positions) ? j.positions : []);
  } catch {
    // Broker not configured or offline — leave the tiles on dashes rather than
    // rendering a zero, which would read as a wiped account.
    latestAccount = null;
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

    // Finished trades are deliberately KEPT here now: the feed is the day's
    // trade log and shows how each entry ended. Open positions have their own
    // card, so nothing is duplicated by leaving these in.
    renderFeed();
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

    renderFeed();
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

    // The feed is broker-truth, so a new A+ ENTRY is NOT rendered on arrival —
    // the order is submitted a moment later and only then does the alert id
    // appear in /api/dbrows with brokerSubmitted. Poll a little early so the
    // row lands in ~2s instead of waiting out the 5s interval. The ding fires
    // from refreshClosedAlertIdsFromApi when a genuinely new order shows up.
    if (String(alert.message || "").includes("A+ ENTRY")) {
      window.setTimeout(async () => {
        await refreshClosedAlertIdsFromApi();
        renderFeed();
      }, 2000);
    }
  });

  socket.on("outcome", (payload) => {
    try {
      const o = payload?.outcome || null;
      const id = String(o?.alertId || "");
      if (!id) return;

      closedAlertIds.add(id);

      // The trade stays in the feed; it just changes from OPEN to its result,
      // which comes from /api/dbrows. Pull that immediately so the row does not
      // sit on a stale OPEN for up to 5 seconds.
      void refreshClosedAlertIdsFromApi().then(() => {
        renderFeed();
        renderTodayCard();
        renderHeroTiles();
      });
      renderFeed();
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

// First paint. Without these the page sat on its HTML defaults for a full 5s
// tick: no feed rows, no Today numbers, because both are derived from
// /api/dbrows and nothing fetched it before the first interval fired.
(async () => {
  await refreshClosedAlertIdsFromApi();
  await refreshAlertsFromApi();
  renderTodayCard();
  renderHeroTiles();
})();

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

// Equity curve: sampled server-side every 5 minutes, so polling it faster than
// once a minute would only redraw the same points.
void refreshEquityCurve();
setInterval(() => {
  void refreshEquityCurve();
}, 60_000);

setInterval(() => {
  refreshBrokerStats();
}, 15000);
