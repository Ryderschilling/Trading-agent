/* global io, LightweightCharts */

const socket = io();
const socketDot = document.getElementById("socketDot");

let dbRowsRaw = [];
let allAlerts = [];

// Active modal chart instance — destroy before re-creating
let activeTradeChart = null;
let activeVwapSeries = null;
let showVwap = true;

// Active returns chart
let returnsChart = null;

// ─── Socket ────────────────────────────────────────────────────────────────
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

// ─── Helpers ───────────────────────────────────────────────────────────────
function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return "—"; }
}

function fmtDatetime(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString("en-US", {
      month: "numeric", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true
    });
  } catch { return "—"; }
}

function fmt2(x) {
  if (x == null || x === "" || Number.isNaN(Number(x))) return "—";
  return Number(x).toFixed(2);
}

function fmt2pct(x) {
  const v = fmt2(x);
  return v === "—" ? "—" : v + "%";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}

function findAlertById(id) {
  return (allAlerts || []).find((a) => String(a.id) === String(id)) || null;
}

function pctClass(v) {
  const n = Number(v);
  if (isNaN(n) || v === "" || v == null) return "";
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

// ─── Modal ─────────────────────────────────────────────────────────────────
const modalEl = document.getElementById("modal");
const modalCloseEl = document.getElementById("modalClose");

function modalOpen() { if (modalEl) modalEl.style.display = "block"; }
function modalClose() {
  if (modalEl) modalEl.style.display = "none";
  // Destroy chart to free memory
  if (activeTradeChart) { activeTradeChart.remove(); activeTradeChart = null; activeVwapSeries = null; }
}
modalCloseEl?.addEventListener("click", modalClose);
modalEl?.addEventListener("click", (e) => { if (e.target === modalEl) modalClose(); });

// ─── Chart toggle buttons ──────────────────────────────────────────────────
let entryTs = null;
let exitTs = null;
let candleSeries = null;
let entryMarkerVisible = true;
let exitMarkerVisible = false;

document.getElementById("btnEntry")?.addEventListener("click", () => {
  entryMarkerVisible = !entryMarkerVisible;
  document.getElementById("btnEntry").classList.toggle("active", entryMarkerVisible);
  updateMarkers();
});
document.getElementById("btnExit")?.addEventListener("click", () => {
  exitMarkerVisible = !exitMarkerVisible;
  document.getElementById("btnExit").classList.toggle("active", exitMarkerVisible);
  updateMarkers();
});
document.getElementById("btnVwap")?.addEventListener("click", () => {
  showVwap = !showVwap;
  document.getElementById("btnVwap").classList.toggle("active", showVwap);
  if (activeVwapSeries) activeVwapSeries.applyOptions({ visible: showVwap });
});

function updateMarkers() {
  if (!candleSeries) return;
  const markers = [];
  if (entryMarkerVisible && entryTs != null) {
    markers.push({ time: Math.floor(entryTs / 1000), position: "belowBar", shape: "arrowUp", color: "#3b82f6", text: "Entry" });
  }
  if (exitMarkerVisible && exitTs != null) {
    markers.push({ time: Math.floor(exitTs / 1000), position: "aboveBar", shape: "arrowDown", color: "#ef5350", text: "Exit" });
  }
  markers.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(markers);
}

// ─── Aggregate 1m bars into N-minute candles ────────────────────────────────
function aggregateBars(bars1m, bucketMin) {
  if (!bars1m || !bars1m.length) return { candles: [], vwapLine: [] };
  const size = bucketMin * 60 * 1000;
  const buckets = new Map();

  for (const b of bars1m) {
    const key = Math.floor(b.t / size) * size;
    if (!buckets.has(key)) {
      buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, vwap: b.vwap });
    } else {
      const bk = buckets.get(key);
      bk.h = Math.max(bk.h, b.h);
      bk.l = Math.min(bk.l, b.l);
      bk.c = b.c;
      if (b.vwap != null) bk.vwap = b.vwap; // last vwap in bucket
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => a.t - b.t);
  const candles = sorted.map((b) => ({ time: Math.floor(b.t / 1000), open: b.o, high: b.h, low: b.l, close: b.c }));
  const vwapLine = sorted.filter((b) => b.vwap != null).map((b) => ({ time: Math.floor(b.t / 1000), value: b.vwap }));
  return { candles, vwapLine };
}

function pickBucketMin(bars1m) {
  if (!bars1m || bars1m.length < 2) return 3;
  const spanMs = bars1m[bars1m.length - 1].t - bars1m[0].t;
  const spanHours = spanMs / (1000 * 60 * 60);
  if (spanHours <= 1.5) return 1;
  if (spanHours <= 4) return 2;
  return 3;
}

// ─── Render trade chart ────────────────────────────────────────────────────
function renderTradeChart(bars1m, alertTs, outcomeExitTs) {
  const container = document.getElementById("tradeChartContainer");
  const loadingEl = document.getElementById("chartLoading");
  const noDataEl = document.getElementById("chartNoData");

  container.style.display = "block";
  if (loadingEl) loadingEl.style.display = "none";
  if (noDataEl) noDataEl.style.display = "none";

  if (!bars1m || !bars1m.length) {
    container.style.display = "none";
    if (noDataEl) noDataEl.style.display = "block";
    return;
  }

  // Destroy any previous chart
  if (activeTradeChart) { activeTradeChart.remove(); activeTradeChart = null; activeVwapSeries = null; candleSeries = null; }

  const bucketMin = pickBucketMin(bars1m);
  const { candles, vwapLine } = aggregateBars(bars1m, bucketMin);

  // Update subtitle
  const first = bars1m[0];
  const last = bars1m[bars1m.length - 1];
  const subEl = document.getElementById("snapshotSub");
  if (subEl && first && last) {
    const fmtTs = (ms) => new Date(ms).toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
    subEl.textContent = `Showing ${bucketMin}m candles built from 1m source. Range ${fmtTs(first.t)} to ${fmtTs(last.t)}`;
  }

  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 320,
    layout: {
      background: { color: "#0b1220" },
      textColor: "#94a3b8",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.04)" },
      horzLines: { color: "rgba(255,255,255,0.04)" },
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 1 },
      horzLine: { color: "rgba(255,255,255,0.15)", width: 1, style: 1 },
    },
    rightPriceScale: {
      borderColor: "rgba(255,255,255,0.06)",
      textColor: "#64748b",
    },
    timeScale: {
      borderColor: "rgba(255,255,255,0.06)",
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time) => {
        const d = new Date(time * 1000);
        return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      },
    },
  });

  activeTradeChart = chart;

  // Candlestick series
  const cs = chart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderUpColor: "#26a69a",
    borderDownColor: "#ef5350",
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });
  cs.setData(candles);
  candleSeries = cs;

  // VWAP line
  const vs = chart.addLineSeries({
    color: "#60a5fa",
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: true,
    crosshairMarkerVisible: false,
  });
  vs.setData(vwapLine);
  activeVwapSeries = vs;
  vs.applyOptions({ visible: showVwap });

  // Entry / exit timestamps
  entryTs = alertTs || null;
  exitTs = outcomeExitTs || null;

  // Reset toggle buttons
  entryMarkerVisible = true;
  exitMarkerVisible = exitTs != null;
  document.getElementById("btnEntry")?.classList.toggle("active", entryMarkerVisible);
  document.getElementById("btnExit")?.classList.toggle("active", exitMarkerVisible);
  document.getElementById("btnExit").style.opacity = exitTs ? "1" : "0.4";

  updateMarkers();

  // Scroll to entry time if available
  if (entryTs) {
    chart.timeScale().scrollToPosition(0, false);
    try {
      chart.timeScale().setVisibleRange({
        from: Math.floor((entryTs - 90 * 60 * 1000) / 1000),
        to: Math.floor((entryTs + 90 * 60 * 1000) / 1000),
      });
    } catch { /* best-effort */ }
  }

  // Responsive resize
  const ro = new ResizeObserver(() => {
    if (activeTradeChart) activeTradeChart.applyOptions({ width: container.clientWidth });
  });
  ro.observe(container);
}

// ─── Open modal ────────────────────────────────────────────────────────────
async function openModalForRow(row) {
  const a = findAlertById(row.alertId);
  if (!a) return;

  // Reset
  document.getElementById("modalTitle").textContent = "Outcome Detail";
  document.getElementById("modalSub").textContent = `${a.symbol || "—"} • Break & Retest Strategy`;
  document.getElementById("mcSymbol").textContent = a.symbol || "—";
  document.getElementById("mcStrategy").textContent = "Break & Retest";
  document.getElementById("mcStatus").textContent = row.status || "—";
  document.getElementById("mcStatus").className = "metric-value " + (row.status === "LIVE" ? "live" : row.status === "STOPPED" ? "neg" : "");
  document.getElementById("mcPnl").textContent = "—";
  document.getElementById("mcPnl").className = "metric-value";
  document.getElementById("mcEntry").textContent = fmtDatetime(a.ts);
  document.getElementById("mcExit").textContent = "—";
  document.getElementById("snapshotSub").textContent = "Loading…";
  document.getElementById("outcomeDetails").textContent = "—";
  document.getElementById("tradeChartContainer").style.display = "none";

  const chartLoading = document.getElementById("chartLoading");
  const chartNoData = document.getElementById("chartNoData");
  if (chartLoading) { chartLoading.style.display = "block"; }
  if (chartNoData) { chartNoData.style.display = "none"; }

  // Reset toggles
  showVwap = true;
  document.getElementById("btnVwap")?.classList.add("active");
  document.getElementById("btnEntry")?.classList.add("active");
  document.getElementById("btnExit")?.classList.remove("active");

  modalOpen();

  let outcomeExitTs = null;

  // Fetch outcome
  try {
    const or = await fetch(`/api/outcomes/${encodeURIComponent(a.id)}`, { cache: "no-store" });
    if (or.ok) {
      const oj = await or.json();
      const o = oj?.outcome;
      if (o) {
        // PNL from 5m return if available, else MFE direction
        const ret5 = o.returnsPct?.["5m"];
        let pnlText = "—";
        let pnlClass = "metric-value";
        if (ret5 != null) {
          pnlText = fmt2pct(ret5);
          pnlClass = "metric-value " + (ret5 > 0 ? "pos" : ret5 < 0 ? "neg" : "");
        }
        document.getElementById("mcPnl").textContent = pnlText;
        document.getElementById("mcPnl").className = pnlClass;

        // Exit time
        if (o.stoppedOut && o.stopTs) {
          document.getElementById("mcExit").textContent = fmtDatetime(o.stopTs);
          outcomeExitTs = o.stopTs;
        } else if (o.status === "COMPLETED" && o.endTs) {
          document.getElementById("mcExit").textContent = fmtDatetime(o.endTs);
          outcomeExitTs = o.endTs;
        } else {
          document.getElementById("mcExit").textContent = "Still open / checkpoint";
        }

        // Outcome detail text
        const returns = o.returnsPct || {};
        const keys = Object.keys(returns).sort((x, y) => parseInt(x) - parseInt(y));
        const retText = keys.length
          ? keys.map((k) => `${k}: ${fmt2pct(returns[k])}`).join("  |  ")
          : "No checkpoints yet";

        document.getElementById("outcomeDetails").innerHTML =
          `MFE: <b>${fmt2pct(o.mfePct)}</b> &nbsp;·&nbsp; MAE: <b>${fmt2pct(o.maePct)}</b>` +
          (o.stoppedOut ? ` &nbsp;·&nbsp; <span class="neg">Stopped out ${fmt2pct(o.stopReturnPct)}</span>` : "") +
          `<br><span style="color:var(--muted)">Returns: ${escapeHtml(retText)}</span>`;
      }
    }
  } catch { /* ignore */ }

  // Fetch candles
  try {
    const cr = await fetch(`/api/candles/${encodeURIComponent(a.symbol)}`, { cache: "no-store" });
    if (cr.ok) {
      const cj = await cr.json();
      if (chartLoading) chartLoading.style.display = "none";
      renderTradeChart(cj.bars || [], a.ts, outcomeExitTs);
    } else {
      if (chartLoading) chartLoading.style.display = "none";
      if (chartNoData) chartNoData.style.display = "block";
    }
  } catch {
    if (chartLoading) chartLoading.style.display = "none";
    if (chartNoData) chartNoData.style.display = "block";
  }
}

// ─── Returns histogram ─────────────────────────────────────────────────────
function renderReturnsChart(rows) {
  const container = document.getElementById("returnsChart");
  if (!container || typeof LightweightCharts === "undefined") return;

  // Destroy previous
  if (returnsChart) { returnsChart.remove(); returnsChart = null; }

  // Bucket 5m returns
  const buckets = [
    { label: "< -3%", min: -Infinity, max: -3, color: "#ef5350" },
    { label: "-3 to -1%", min: -3, max: -1, color: "#f87171" },
    { label: "-1 to 0%", min: -1, max: 0, color: "#fca5a5" },
    { label: "0 to 1%", min: 0, max: 1, color: "#6ee7b7" },
    { label: "1 to 3%", min: 1, max: 3, color: "#34d399" },
    { label: "> 3%", min: 3, max: Infinity, color: "#10b981" },
  ];

  const counts = buckets.map(() => 0);
  for (const r of rows) {
    const v = Number(r.ret5m);
    if (r.ret5m === "" || isNaN(v)) continue;
    for (let i = 0; i < buckets.length; i++) {
      if (v >= buckets[i].min && v < buckets[i].max) { counts[i]++; break; }
    }
  }

  // Build chart with a baseline histogram using fake time keys
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: 140,
    layout: { background: { color: "transparent" }, textColor: "#64748b", fontSize: 10 },
    grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,0.04)" } },
    rightPriceScale: { borderVisible: false },
    timeScale: {
      borderVisible: false,
      tickMarkFormatter: (time) => {
        const idx = time - 1;
        return buckets[idx]?.label || "";
      },
    },
    handleScroll: false,
    handleScale: false,
  });
  returnsChart = chart;

  const hist = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  const data = buckets.map((b, i) => ({
    time: i + 1,
    value: counts[i],
    color: b.color + (counts[i] === 0 ? "44" : "cc"),
  }));
  hist.setData(data);

  chart.timeScale().fitContent();

  const ro = new ResizeObserver(() => { if (returnsChart) returnsChart.applyOptions({ width: container.clientWidth }); });
  ro.observe(container);
}

// ─── Stats strip ───────────────────────────────────────────────────────────
function renderStats(rows) {
  const total = rows.length;
  document.getElementById("statTotal").textContent = total || "0";

  const withMfe = rows.filter((r) => r.mfePct !== "" && Number(r.mfePct) > 0);
  const winRate = total > 0 ? Math.round((withMfe.length / total) * 100) : null;
  const statWr = document.getElementById("statWinRate");
  statWr.textContent = winRate != null ? winRate + "%" : "—";
  statWr.className = "stat-value " + (winRate != null ? (winRate >= 50 ? "pos" : "neg") : "");

  const ret5vals = rows.map((r) => Number(r.ret5m)).filter((v) => !isNaN(v) && v !== 0);
  const avgRet = ret5vals.length ? ret5vals.reduce((a, b) => a + b, 0) / ret5vals.length : null;
  const statAvg = document.getElementById("statAvgRet");
  statAvg.textContent = avgRet != null ? fmt2pct(avgRet) : "—";
  statAvg.className = "stat-value " + (avgRet != null ? (avgRet > 0 ? "pos" : "neg") : "");

  const mfeVals = rows.map((r) => Number(r.mfePct)).filter((v) => !isNaN(v));
  const bestMfe = mfeVals.length ? Math.max(...mfeVals) : null;
  const statBest = document.getElementById("statBestMfe");
  statBest.textContent = bestMfe != null ? fmt2pct(bestMfe) : "—";
  statBest.className = "stat-value pos";

  const stops = rows.filter((r) => r.stoppedOut).length;
  document.getElementById("statStops").textContent = total > 0 ? `${stops} / ${total}` : "—";
}

// ─── DB table render ───────────────────────────────────────────────────────
function applyDbFilters(rows) {
  const sym = String(document.getElementById("dbSym")?.value || "").trim().toUpperCase();
  const status = String(document.getElementById("dbStatus")?.value || "").trim().toUpperCase();
  const stoppedOnly = Boolean(document.getElementById("dbStoppedOnly")?.checked);
  return (rows || []).filter((r) => {
    if (sym && String(r.symbol || "").toUpperCase() !== sym) return false;
    if (status && String(r.status || "").toUpperCase() !== status) return false;
    if (stoppedOnly && !r.stoppedOut) return false;
    return true;
  });
}

function renderDbTable() {
  const dbBodyEl = document.getElementById("dbBody");
  const dbEmptyEl = document.getElementById("dbEmpty");
  if (!dbBodyEl || !dbEmptyEl) return;

  const rows = applyDbFilters(dbRowsRaw);
  dbBodyEl.innerHTML = "";

  if (!rows.length) { dbEmptyEl.style.display = "block"; return; }
  dbEmptyEl.style.display = "none";

  for (const r of rows) {
    const tr = document.createElement("tr");

    const td = (text, cls) => {
      const el = document.createElement("td");
      el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };

    const statusColor = r.status === "LIVE" ? "#60a5fa" : r.status === "STOPPED" ? "#ef5350" : r.status === "COMPLETED" ? "#26a69a" : "";

    tr.appendChild(td(fmtTime(r.ts)));
    tr.appendChild(td(r.symbol || ""));
    tr.appendChild(td(r.dir || ""));
    tr.appendChild(td(r.structureLevel !== "" ? fmt2(r.structureLevel) : "—"));
    tr.appendChild(td(r.entryRef !== "" ? fmt2(r.entryRef) : "—"));

    const statusTd = document.createElement("td");
    statusTd.innerHTML = `<span style="color:${statusColor}; font-weight:700;">${escapeHtml(r.status || "—")}</span>`;
    tr.appendChild(statusTd);

    tr.appendChild(td(r.stopReturnPct !== "" ? fmt2pct(r.stopReturnPct) : "—", pctClass(r.stopReturnPct)));
    tr.appendChild(td(r.mfePct !== "" ? fmt2pct(r.mfePct) : "—", r.mfePct !== "" && Number(r.mfePct) > 0 ? "pos" : ""));
    tr.appendChild(td(r.maePct !== "" ? fmt2pct(r.maePct) : "—"));
    tr.appendChild(td(r.ret5m !== "" ? fmt2pct(r.ret5m) : "—", pctClass(r.ret5m)));
    tr.appendChild(td(r.ret15m !== "" ? fmt2pct(r.ret15m) : "—", pctClass(r.ret15m)));
    tr.appendChild(td(r.ret30m !== "" ? fmt2pct(r.ret30m) : "—", pctClass(r.ret30m)));
    tr.appendChild(td(r.ret60m !== "" ? fmt2pct(r.ret60m) : "—", pctClass(r.ret60m)));

    tr.addEventListener("click", () => openModalForRow(r));
    dbBodyEl.appendChild(tr);
  }
}

async function fetchDbRows() {
  try {
    const r = await fetch("/api/db", { cache: "no-store" });
    const j = await r.json();
    dbRowsRaw = Array.isArray(j?.rows) ? j.rows : [];
    renderDbTable();
    renderStats(dbRowsRaw);
    renderReturnsChart(dbRowsRaw);
  } catch { /* ignore */ }
}

// ─── Wire filters + refresh ────────────────────────────────────────────────
document.getElementById("dbSym")?.addEventListener("input", renderDbTable);
document.getElementById("dbStatus")?.addEventListener("change", renderDbTable);
document.getElementById("dbStoppedOnly")?.addEventListener("change", renderDbTable);
document.getElementById("refreshBtn")?.addEventListener("click", fetchDbRows);

fetchDbRows();
setInterval(fetchDbRows, 6000);
