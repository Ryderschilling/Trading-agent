/* global fetch */

(() => {
    // ---------- DOM helpers ----------
    const $ = (id) => document.getElementById(id);
  
    const tickerSelect = $("tickersSelect");   // matches backtest.html
    const strategySelect = $("strategySelect");
    const timeframeSelect = $("timeframeSelect");
    const startDateInput = $("startDate");
    const endDateInput = $("endDate");
  
    const runBtn = $("runBtn");
    const refreshBtn = $("refreshBtn");
  
    const statusPill = $("btStatusPill");
    const runMeta = $("runMeta");
  
    const metricsGrid = $("metricsGrid");
    const equityCanvas = $("equityCanvas");
    const tradeTableBody = $("tradesBody");
    const sortSelect = $("sortSelect");
  
    // Optional (only used if present; will not affect layout if missing)
    const startEquityInput = $("startEquity"); // you may add later; safe if absent
  
    // ---------- state ----------
    let activeRunId = null;
    let pollTimer = null;
    let lastTrades = [];
    let lastEquity = [];
  
    let equityPlot = null; // cached plot geometry for hover: { pts, xForIdx, yForVal, w, h }
  
    // ---------- utilities ----------
    function setPill(text, cls) {
      if (!statusPill) return;
      statusPill.textContent = text;
  
      statusPill.classList.remove("pill-idle", "pill-running", "pill-done", "pill-failed", "pill-queued");
      if (cls) statusPill.classList.add(cls);
    }
  
    function setRunMeta(text) {
      if (runMeta) runMeta.textContent = text || "";
    }
  
    function ymdTodayNY() {
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      return fmt.format(new Date()); // YYYY-MM-DD
    }
  
    function ymdOneYearAgoNY() {
      const d = new Date();
      d.setDate(d.getDate() - 365);
      const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });
      return fmt.format(d);
    }
  
    function money(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return "—";
      return x.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
    }
    
    function num(n, digits = 2) {
      const x = Number(n);
      if (!Number.isFinite(x)) return "—";
      return x.toFixed(digits);
    }
  
    function getStartEquityValue() {
      const v = Number(startEquityInput?.value);
      if (Number.isFinite(v) && v > 0) return v;
  
      const p = Number(startEquityInput?.placeholder);
      if (Number.isFinite(p) && p > 0) return p;
  
      return 10000;
    }
  
    function ensureEquityHeaderStatsEl() {
      if (!equityCanvas) return null;
  
      const card = equityCanvas.closest(".card");
      const head = card ? card.querySelector(".card-head") : null;
      if (!head) return null;
  
      let el = head.querySelector("#equityHeaderStats");
      if (el) return el;
  
      el = document.createElement("div");
      el.id = "equityHeaderStats";
      el.className = "small";
      el.style.flex = "1";
      el.style.textAlign = "center";
      el.style.alignSelf = "center";
      el.style.pointerEvents = "none";
      el.style.whiteSpace = "nowrap";
      el.style.color = "var(--muted)";
  
      const actions = head.querySelector(".card-actions");
      if (actions) head.insertBefore(el, actions);
      else head.appendChild(el);
  
      return el;
    }
  
    // ---------- UI reset ----------
    function clearUI() {
      if (metricsGrid) metricsGrid.innerHTML = "";
  
      lastEquity = [];
      drawEquity([]);
  
      lastTrades = [];
      if (tradeTableBody) tradeTableBody.innerHTML = "";
  
      setRunMeta("");
      setPill("Idle", "pill-idle");
    }
  
    // ---------- watchlist ----------
    async function loadWatchlistIntoSelect() {
      if (!tickerSelect) {
        console.warn("[backtest] Missing #tickersSelect in HTML");
        setRunMeta("ERROR: Missing tickersSelect element (id mismatch in backtest.html).");
        return;
      }
  
      tickerSelect.innerHTML = "";
  
      try {
        const res = await fetch("/api/watchlist");
        if (!res.ok) throw new Error(`watchlist ${res.status}`);
  
        const data = await res.json();
  
        let symbols = [];
        if (Array.isArray(data?.symbols)) {
          symbols = data.symbols;
        } else if (Array.isArray(data?.items)) {
          symbols = data.items.map((it) => it?.symbol);
        } else if (Array.isArray(data)) {
          symbols = data;
        }
  
        for (const s of symbols) {
          const sym = String(s || "").toUpperCase().trim();
          if (!sym) continue;
          const opt = document.createElement("option");
          opt.value = sym;
          opt.textContent = sym;
          tickerSelect.appendChild(opt);
        }
  
        if (tickerSelect.options.length === 0) {
          setRunMeta("Watchlist loaded but returned 0 tickers.");
        }
  
      } catch (e) {
        console.error("[backtest] watchlist load failed", e);
        setRunMeta(`Watchlist load failed: ${String(e?.message || e)}`);
      }
    }
  
    function getSelectedTickers() {
      if (!tickerSelect) return [];
      const selected = Array.from(tickerSelect.selectedOptions || []).map((o) => String(o.value || "").toUpperCase());
      return selected.filter(Boolean);
    }
  
    // ---------- rulesets/strategies ----------
    async function loadStrategiesIntoSelect() {
      if (!strategySelect) return;
      try {
        const res = await fetch("/api/rulesets");
        if (!res.ok) return;
        const json = await res.json();
        const rulesets = Array.isArray(json?.rulesets) ? json.rulesets : [];
  
        const prev = String(strategySelect.value || "active");
        strategySelect.innerHTML = "";
  
        const optActive = document.createElement("option");
        optActive.value = "active";
        optActive.textContent = "Active strategy";
        strategySelect.appendChild(optActive);
  
        for (const r of rulesets) {
          const v = Number(r?.version);
          if (!Number.isFinite(v)) continue;
          const name = String(r?.name || `Ruleset v${v}`);
          const active = Boolean(r?.active);
  
          const opt = document.createElement("option");
          opt.value = String(v);
          opt.textContent = active ? `${name} (ACTIVE)` : name;
          strategySelect.appendChild(opt);
        }
  
        strategySelect.value = prev;
      } catch {
        // ignore
      }
    }
  
    // ---------- API ----------
    async function createBacktestRun(payload) {
      const res = await fetch("/api/backtests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`Create run failed (${res.status}) ${txt}`);
      }
      return res.json(); // {ok, runId, reused}
    }
  
    async function fetchRun(runId) {
      const res = await fetch(`/api/backtests/${encodeURIComponent(runId)}`);
      if (!res.ok) throw new Error(`Run fetch failed (${res.status})`);
      return res.json();
    }
  
    async function fetchTrades(runId) {
      const res = await fetch(`/api/backtests/${encodeURIComponent(runId)}/trades?limit=5000`);
      if (!res.ok) throw new Error(`Trades fetch failed (${res.status})`);
      return res.json();
    }
  
    async function fetchEquity(runId) {
      const res = await fetch(`/api/backtests/${encodeURIComponent(runId)}/equity?limit=100000`);
      if (!res.ok) throw new Error(`Equity fetch failed (${res.status})`);
      return res.json();
    }
  
    // ---------- rendering ----------
    function renderMetrics(metrics) {
      if (!metricsGrid) return;
      metricsGrid.innerHTML = "";
  
      const pairs = [
        ["Total Trades", metrics?.totalTrades],
        ["Win Rate", metrics?.winRatePct != null ? `${num(metrics.winRatePct, 1)}%` : metrics?.winRate],
        ["Avg R", metrics?.avgR],
        ["Expectancy", metrics?.expectancy],
        ["Profit Factor", metrics?.profitFactor],
        ["Max Drawdown (R)", metrics?.maxDrawdownR],
        ["Win Streak", metrics?.winStreak],
        ["Loss Streak", metrics?.lossStreak],
        ["Avg Hold (bars)", metrics?.avgHoldBars]
      ];
  
      for (const [label, value] of pairs) {
        const card = document.createElement("div");
        card.className = "metricCard";
        card.innerHTML = `
          <div class="metricLabel">${label}</div>
          <div class="metricValue">${value == null ? "—" : String(value)}</div>
        `;
        metricsGrid.appendChild(card);
      }
    }
  
    function drawEquity(points, hoverIdx = null) {
      if (!equityCanvas) return;
      const ctx = equityCanvas.getContext("2d");
      if (!ctx) return;
  
      const cssW = Math.max(1, equityCanvas.clientWidth || 1);
      const cssH = Math.max(1, equityCanvas.clientHeight || 220);
      const dpr = window.devicePixelRatio || 1;
  
      const targetW = Math.floor(cssW * dpr);
      const targetH = Math.floor(cssH * dpr);
  
      if (equityCanvas.width !== targetW || equityCanvas.height !== targetH) {
        equityCanvas.width = targetW;
        equityCanvas.height = targetH;
      }
  
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  
      const w = cssW;
      const h = cssH;
  
      ctx.clearRect(0, 0, w, h);
  
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.15)";
      ctx.beginPath();
      ctx.moveTo(0, h - 1);
      ctx.lineTo(w, h - 1);
      ctx.stroke();
  
      const raw = Array.isArray(points) ? points : [];
      const pts = [];
      for (const p of raw) {
        const ev = Number(p?.equity);
        const ts = Number(p?.ts);
        if (!Number.isFinite(ev)) continue;
        pts.push({ ts, equity: ev });
      }
  
      equityPlot = null;
      if (pts.length < 2) return;
  
      const ys = pts.map((p) => p.equity);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const pad = (maxY - minY) * 0.08 || 1;
  
      const lo = minY - pad;
      const hi = maxY + pad;
  
      const xForIdx = (i) => (i / (pts.length - 1)) * (w - 2) + 1;
      const yForVal = (v) => {
        const t = (v - lo) / (hi - lo);
        return (1 - t) * (h - 2) + 1;
      };
  
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0,0,0,0.70)";
      ctx.beginPath();
      for (let i = 0; i < pts.length; i++) {
        const x = xForIdx(i);
        const y = yForVal(pts[i].equity);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
  
      if (hoverIdx != null && Number.isFinite(hoverIdx)) {
        const i = Math.min(pts.length - 1, Math.max(0, Number(hoverIdx)));
        const cx = xForIdx(i);
        const cy = yForVal(pts[i].equity);
  
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.fill();
  
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }
  
      equityPlot = { pts, xForIdx, yForVal, w, h };
    }
  
    function renderTrades(trades) {
      if (!tradeTableBody) return;
      tradeTableBody.innerHTML = "";
  
      const rows = Array.isArray(trades) ? trades.slice() : [];
      const sortMode = sortSelect ? String(sortSelect.value || "entryTs_desc") : "entryTs_desc";
  
      rows.sort((a, b) => {
        const ae = Number(a?.entryTs || 0);
        const be = Number(b?.entryTs || 0);
        const ar = Number(a?.rMult || 0);
        const br = Number(b?.rMult || 0);
  
        if (sortMode === "r_desc") return br - ar;
        if (sortMode === "r_asc") return ar - br;
  
        if (sortMode === "entryTs_asc") return ae - be;
        if (sortMode === "entryTs_desc") return be - ae;
        return be - ae;
      });
  
      for (const tr of rows) {
        const trEl = document.createElement("tr");
        trEl.innerHTML = `
          <td>${String(tr.ticker || "")}</td>
          <td>${String(tr.dir || "")}</td>
          <td>${String(tr.levelKey || "")} @ ${num(tr.levelPrice, 2)}</td>
          <td>${fmtTs(tr.entryTs)}<div class="sub">${num(tr.entryPrice, 2)}</div></td>
          <td>${num(tr.stopPrice, 2)}</td>
          <td>${num(tr.targetPrice, 2)}</td>
          <td>${fmtTs(tr.exitTs)}<div class="sub">${num(tr.exitPrice, 2)}</div></td>
          <td>${String(tr.exitReason || "")}</td>
          <td>${num(tr.rMult, 2)}</td>
          <td>${String(tr.barsHeld ?? "")}</td>
        `;
        tradeTableBody.appendChild(trEl);
      }
    }
  
    function fmtTs(ms) {
      const x = Number(ms);
      if (!Number.isFinite(x) || x <= 0) return "—";
      const d = new Date(x);
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(d);
    }
  
    // ---------- polling ----------
    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  
    function startPolling(runId) {
      stopPolling();
      pollTimer = setInterval(async () => {
        try {
          const run = await fetchRun(runId);
          const status = String(run?.status || "QUEUED");
  
          if (status === "RUNNING") setPill("RUNNING", "pill-running");
          else if (status === "DONE") setPill("DONE", "pill-done");
          else if (status === "FAILED") setPill("FAILED", "pill-failed");
          else setPill(status, "pill-queued");
  
          setRunMeta(
            `Run: ${String(run.id || runId)} • Created: ${fmtTs(run.createdTs)} • Started: ${run.startedTs ? fmtTs(run.startedTs) : "—"} • Finished: ${run.finishedTs ? fmtTs(run.finishedTs) : "—"}`
          );
  
          if (status === "DONE") {
            stopPolling();
  
            const [tradesRes, eqRes] = await Promise.all([fetchTrades(runId), fetchEquity(runId)]);
            lastTrades = Array.isArray(tradesRes) ? tradesRes : (Array.isArray(tradesRes?.trades) ? tradesRes.trades : []);
            lastEquity = Array.isArray(eqRes) ? eqRes : (Array.isArray(eqRes?.equity) ? eqRes.equity : []);
  
            renderMetrics(run?.metrics || {});
            drawEquity(lastEquity);
            renderTrades(lastTrades);
          }
  
          if (status === "FAILED") {
            stopPolling();
            if (run?.error) setRunMeta(`FAILED: ${String(run.error)}`);
          }
        } catch {
          // keep polling
        }
      }, 1000);
    }
  
    // ---------- actions ----------
    async function onRunClick() {
      const tickers = getSelectedTickers();
      const tfRaw = timeframeSelect ? String(timeframeSelect.value || "1m") : "1m";
      const timeframe = (["1m","2m","5m","15m","30m","1h","4h","1d","1w"].includes(tfRaw) ? tfRaw : "1m");
  
      const startDate = startDateInput ? String(startDateInput.value || "") : "";
      const endDate = endDateInput ? String(endDateInput.value || "") : "";
  
      if (!tickers.length) {
        setRunMeta("Select at least one ticker.");
        return;
      }
  
      setPill("QUEUED", "pill-queued");
      setRunMeta("Submitting run…");
  
      try {
        const created = await createBacktestRun({ tickers, timeframe, startDate, endDate });
        activeRunId = String(created?.runId || "");
        if (!activeRunId) throw new Error("No runId returned");
  
        startPolling(activeRunId);
      } catch (e) {
        setPill("FAILED", "pill-failed");
        setRunMeta(String(e?.message || e || "Failed to start backtest"));
      }
    }
  
    function onResetClick() {
      activeRunId = null;
      stopPolling();
      clearUI();
    }
  
    // ---------- init ----------
    async function init() {
      if (startDateInput && !startDateInput.value) startDateInput.value = ymdOneYearAgoNY();
      if (endDateInput && !endDateInput.value) endDateInput.value = ymdTodayNY();
  
      await loadWatchlistIntoSelect();
      await loadStrategiesIntoSelect();
  
      if (runBtn) runBtn.addEventListener("click", onRunClick);
      if (refreshBtn) refreshBtn.addEventListener("click", onResetClick);
  
      if (sortSelect) {
        sortSelect.addEventListener("change", () => renderTrades(lastTrades));
      }
  
      if (startEquityInput) {
        startEquityInput.addEventListener("change", () => {});
      }
  
      if (equityCanvas) {
        const statsEl = ensureEquityHeaderStatsEl();
  
        equityCanvas.addEventListener("mousemove", (ev) => {
          if (!equityPlot) return;
  
          const rect = equityCanvas.getBoundingClientRect();
          const x = ev.clientX - rect.left;
  
          const n = equityPlot.pts.length;
          const t = Math.min(1, Math.max(0, x / Math.max(1, rect.width)));
          const idx = Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
          const p = equityPlot.pts[idx];
  
          const startEq = getStartEquityValue();
          const pnl = startEq * (p.equity * 0.01);
          const pct = p.equity;
          const acct = startEq + pnl;
  
          if (statsEl) {
            statsEl.innerHTML =
              `P/L <b>${money(pnl)}</b> &nbsp;•&nbsp; ` +
              `<b>${num(pct, 2)}%</b> &nbsp;•&nbsp; ` +
              `Account <b>${money(acct)}</b> &nbsp;•&nbsp; ` +
              `<b>${fmtTs(p.ts)}</b>`;
          }
  
          drawEquity(lastEquity, idx);
        });
  
        equityCanvas.addEventListener("mouseleave", () => {
          const statsEl2 = ensureEquityHeaderStatsEl();
          if (statsEl2) statsEl2.innerHTML = "";
          drawEquity(lastEquity, null);
        });
      }
  
      clearUI();
    }
  
    init().catch(() => clearUI());
  })();