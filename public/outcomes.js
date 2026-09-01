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

// Strategy filter — "all" or a ruleset version as a string. Keyed on the
// version, never the display name, because two versions can share a name
// (v6 and v9 are both "Improved Break and Retest Strategy").
const stratTogglesEl = document.getElementById("stratToggles");
let activeStrategy = "all";
let stratSignature = "";

// Source filter — "broker" (default) shows only alerts the broker actually
// accepted an order for; "all" shows every A+ signal including untraded ones.
const sourceTogglesEl = document.getElementById("sourceToggles");
let activeSource = "broker";

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

// "18 May, 2026" — short month, no leading zero on day.
function fmtDate(ts) {
  try {
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return "—";
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${d.getFullYear()}`;
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

// Chart engine lives in chart-core.js so the Workspace page can draw the same
// chart. Pulled in here as locals to keep the call sites below unchanged.
const {
  drawChart,
  normalizeBars,
  aggregateBars,
  vwapSeries,
  emaOf,
  closestIdxByTs,
  syncCanvasSize,
} = window.ChartCore;


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

  // Broker-truth display values. Prefer broker fills; fall back to simulated.
  const hasEntryFill = r.entryFill !== "" && r.entryFill != null && Number.isFinite(Number(r.entryFill));
  const hasExitFill  = r.exitFill  !== "" && r.exitFill  != null && Number.isFinite(Number(r.exitFill));
  const entryFillTxt = hasEntryFill
    ? `$${fmt2(Number(r.entryFill))}`
    : (r.entryRef !== "" && r.entryRef != null ? `$${fmt2(Number(r.entryRef))} <span style="color:rgba(255,255,255,0.45);font-style:italic;">(sim)</span>` : "—");
  const exitFillTxt = hasExitFill ? `$${fmt2(Number(r.exitFill))}` : "—";
  const qtyTxt = (r.qty !== "" && r.qty != null && Number.isFinite(Number(r.qty))) ? String(Number(r.qty)) : "—";
  const pnlUsdNum = (r.realizedPnlUsd !== "" && r.realizedPnlUsd != null && Number.isFinite(Number(r.realizedPnlUsd))) ? Number(r.realizedPnlUsd) : null;
  const pnlUsdTxt = pnlUsdNum == null
    ? "—"
    : `<span style="color:${pnlUsdNum > 0 ? "#34d399" : pnlUsdNum < 0 ? "#f87171" : "inherit"};font-weight:700;">${pnlUsdNum > 0 ? "+$" : pnlUsdNum < 0 ? "-$" : "$"}${Math.abs(pnlUsdNum).toFixed(2)}</span>`;

  modalBodyEl.innerHTML = `
    <div class="outcome-detail">
      <div class="outcome-metrics">
        ${buildMetric("Symbol", `<b>${escapeHtml(r.symbol || "—")}</b>`)}
        ${buildMetric("Strategy", escapeHtml(strat))}
        ${buildMetric("Status", `<b>${statusText}</b>`)}
        ${buildMetric("PnL %", `<b>${escapeHtml(pnlText)}</b>`)}
        ${buildMetric("PnL $", pnlUsdTxt)}
        ${buildMetric("Entry Fill", entryFillTxt)}
        ${buildMetric("Exit Fill", exitFillTxt)}
        ${buildMetric("Qty", escapeHtml(qtyTxt))}
        ${buildMetric("Entry Time", escapeHtml(fmtDateTime(entryTs)))}
        ${buildMetric("Exit Time", escapeHtml(exitTs ? fmtDateTime(exitTs) : "Still open / checkpoint"))}
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

    // Named structural levels: PDH (green), PDL (red), PMH/PML (pink)
    const GREEN  = "rgba(74, 222, 128, 0.95)";
    const RED    = "rgba(248, 113, 113, 0.95)";
    const PINK   = "rgba(255, 82, 172, 0.95)";
    const namedLevels = [
      { key: "pdh", label: "PDH", color: GREEN  },
      { key: "pdl", label: "PDL", color: RED    },
      { key: "pmh", label: "PMH", color: PINK   },
      { key: "pml", label: "PML", color: PINK   },
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
        lvlKey === "PMH" || lvlKey === "PML" ? PINK :
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
    if (activeStrategy !== "all" && String(r.strategyVersion ?? "") !== activeStrategy) return false;
    if (activeSource === "broker" && !r.brokerSubmitted) return false;
    return true;
  });
}

// Broker / all-signals toggle. Static two-button group, rendered once.
function renderSourceToggles() {
  if (!sourceTogglesEl || sourceTogglesEl.dataset.built === "1") return;
  sourceTogglesEl.dataset.built = "1";

  const make = (value, text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab range-toggle" + (activeSource === value ? " active" : "");
    b.textContent = text;
    b.title = title;
    b.dataset.source = value;
    b.addEventListener("click", () => {
      if (activeSource === value) return;
      activeSource = value;
      for (const el of sourceTogglesEl.querySelectorAll("button")) {
        el.classList.toggle("active", el.dataset.source === value);
      }
      renderDbTable();
    });
    return b;
  };

  sourceTogglesEl.appendChild(
    make("broker", "Broker trades", "Only alerts the broker actually accepted an order for")
  );
  sourceTogglesEl.appendChild(
    make("all", "All signals", "Every A+ signal, including ones no order was sent for")
  );
}

// Build the strategy filter buttons from whatever strategies exist in the
// loaded rows. Rebuilt only when the strategy set changes, so the active
// button never flickers on the 6s refresh.
function renderStrategyToggles() {
  if (!stratTogglesEl) return;

  const byVersion = new Map();
  for (const r of dbRowsRaw || []) {
    const v = r?.strategyVersion;
    if (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0) continue;
    const key = String(Number(v));
    const cur = byVersion.get(key);
    if (cur) cur.trades += 1;
    else byVersion.set(key, { version: Number(v), name: String(r.strategyName || ""), trades: 1 });
  }

  const list = [...byVersion.values()].sort((a, b) => b.version - a.version);
  const sig = list.map((s) => `${s.version}:${s.name}:${s.trades}`).join("|") + `@${activeStrategy}`;
  if (sig === stratSignature) return;
  stratSignature = sig;

  if (activeStrategy !== "all" && !byVersion.has(activeStrategy)) activeStrategy = "all";

  const label = (s) => {
    let nm = s.name && s.name.trim() ? s.name.trim() : `v${s.version}`;
    if (!new RegExp(`v\\s*${s.version}\\b`, "i").test(nm)) nm += ` (v${s.version})`;
    if (nm.length > 26) nm = nm.slice(0, 25) + "…";
    return nm;
  };

  stratTogglesEl.innerHTML = "";

  const makeBtn = (value, text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab range-toggle" + (activeStrategy === value ? " active" : "");
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener("click", () => {
      if (activeStrategy === value) return;
      activeStrategy = value;
      stratSignature = ""; // force button re-render with new active state
      renderDbTable();
    });
    return b;
  };

  stratTogglesEl.appendChild(makeBtn("all", "All strategies", "Every strategy combined"));
  for (const s of list) {
    const full = s.name ? `${s.name} (v${s.version})` : `v${s.version}`;
    stratTogglesEl.appendChild(makeBtn(String(s.version), label(s), full));
  }
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

  renderSourceToggles();
  renderStrategyToggles();

  const rows = applyDbFilters(dbRowsRaw);

  // Pre-compute pnlPct on every row so stats and the table stay consistent.
  for (const r of rows) {
    r.pnlPct = computePnlPct(r);
  }
  renderStats(rows);

  dbBodyEl.innerHTML = "";

  if (!rows.length) {
    dbEmptyEl.textContent =
      activeSource === "broker"
        ? "No broker-submitted trades in this range."
        : "No rows.";
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

    const pnl = r.pnlPct;

    tr.appendChild(td(fmtDate(r.ts)));
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

    // Entry Fill — broker truth (filled_avg_price). Falls back to alert close
    // when broker fill not available. Italicized in muted color when simulated.
    const entryFillTd = document.createElement("td");
    const hasEntryFill = r.entryFill !== "" && r.entryFill != null && Number.isFinite(Number(r.entryFill));
    if (hasEntryFill) {
      entryFillTd.textContent = fmt2(Number(r.entryFill));
    } else if (r.entryRef !== "" && r.entryRef != null && Number.isFinite(Number(r.entryRef))) {
      entryFillTd.innerHTML = `<span style="color:rgba(255,255,255,0.4);font-style:italic;" title="Simulated — broker fill not available">${fmt2(Number(r.entryRef))}</span>`;
    } else {
      entryFillTd.textContent = "—";
    }
    tr.appendChild(entryFillTd);

    // Exit Fill — broker truth on close. Simulated if no broker fill.
    const exitFillTd = document.createElement("td");
    const hasExitFill = r.exitFill !== "" && r.exitFill != null && Number.isFinite(Number(r.exitFill));
    if (hasExitFill) {
      exitFillTd.textContent = fmt2(Number(r.exitFill));
    } else {
      exitFillTd.textContent = "—";
    }
    tr.appendChild(exitFillTd);

    // Qty
    const qtyTd = document.createElement("td");
    if (r.qty !== "" && r.qty != null && Number.isFinite(Number(r.qty))) {
      qtyTd.textContent = String(Number(r.qty));
    } else {
      qtyTd.textContent = "—";
    }
    tr.appendChild(qtyTd);

    // PnL % — green/red
    const pnlTd = document.createElement("td");
    if (pnl == null) {
      pnlTd.textContent = "—";
    } else {
      const pnlColor = pnl > 0 ? "#34d399" : pnl < 0 ? "#f87171" : "inherit";
      pnlTd.innerHTML = `<span style="color:${pnlColor};font-weight:700;">${fmt2(pnl)}%</span>`;
    }
    tr.appendChild(pnlTd);

    // PnL $ — realized dollar P&L from broker fills
    const pnlUsdTd = document.createElement("td");
    const pnlUsd = (r.realizedPnlUsd !== "" && r.realizedPnlUsd != null && Number.isFinite(Number(r.realizedPnlUsd)))
      ? Number(r.realizedPnlUsd)
      : null;
    if (pnlUsd == null) {
      pnlUsdTd.textContent = "—";
    } else {
      const c = pnlUsd > 0 ? "#34d399" : pnlUsd < 0 ? "#f87171" : "inherit";
      const sign = pnlUsd > 0 ? "+$" : pnlUsd < 0 ? "-$" : "$";
      pnlUsdTd.innerHTML = `<span style="color:${c};font-weight:700;">${sign}${Math.abs(pnlUsd).toFixed(2)}</span>`;
    }
    tr.appendChild(pnlUsdTd);

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
