/* global fetch */

(() => {
  const root = document.getElementById("strategyPage");

  // ─── helpers ───────────────────────────────────────────────────────────────

  function fmt(val) {
    if (val == null || val === "") return "—";
    return String(val);
  }

  function yesNo(val) {
    const on = val === true || val === "true";
    return `<span class="param-value ${on ? "yes" : "no"}">${on ? "Yes" : "No"}</span>`;
  }

  function checkItem(on, label) {
    return `<div class="check-item ${on ? "on" : "off"}">
      <span class="icon">${on ? "✓" : "✗"}</span>
      <span>${label}</span>
    </div>`;
  }

  function card(title, subtitle, body) {
    return `<section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${title}</div>
          ${subtitle ? `<div class="small muted">${subtitle}</div>` : ""}
        </div>
      </div>
      <div style="padding: 0 20px 20px;">
        ${body}
      </div>
    </section>`;
  }

  function paramGrid(items) {
    return `<div class="param-grid">
      ${items.map(([label, value]) => `
        <div class="param-item">
          <div class="param-label">${label}</div>
          <div class="param-value">${fmt(value)}</div>
        </div>`).join("")}
    </div>`;
  }

  // ─── strategy description ──────────────────────────────────────────────────

  function describeSetup(cfg) {
    if (!cfg) return "";
    const s = cfg.setup || {};
    if (cfg.setupType === "break_retest") {
      const levels = (s.levels || []).map(l => l.toUpperCase().replace("_", " ")).join(", ") || "PMH · PML";
      const ma = s.movingAverage ? `${s.movingAverage.type} ${(s.movingAverage.values || []).join("/")}` : null;
      return [
        `Waits for price to break a key level (${levels})${ma ? ` or ${ma}` : ""}`,
        "then retests it as new support/resistance.",
        "Entry fires on the 1m retest tap.",
        "Bias confirmed by VWAP position and 8 EMA.",
        "Market direction gated by SPY + QQQ vs VWAP and watchlist majority.",
      ].join(" ");
    }
    if (cfg.setupType === "ma_cross") {
      return `Triggers when the ${s.maType || "EMA"} ${s.fastValue || "9"} crosses the ${s.maType || "EMA"} ${s.slowValue || "21"} on the configured timeframe, confirming momentum.`;
    }
    return "";
  }

  // ─── render ────────────────────────────────────────────────────────────────

  function render(strategy, watchlist) {
    if (!strategy) {
      root.innerHTML = `<div class="no-strategy">No active strategy found. Start the server — it will seed a default on first boot.</div>`;
      return;
    }

    const cfg = strategy.config || {};
    const s = cfg.setup || {};
    const f = cfg.filters || {};
    const r = cfg.risk || {};
    const b = cfg.brokerCaps || {};

    const isActive = strategy.active !== false;
    const description = describeSetup(cfg);

    // ── header card ──────────────────────────────────────────────────────────
    let html = `<section class="card" style="padding:20px 22px;">
      <div class="strategy-status-bar">
        <span class="strategy-badge ${isActive ? "active" : "inactive"}">
          <span class="dot"></span>
          ${isActive ? "Active" : "Inactive"}
        </span>
        <span class="strategy-version">v${strategy.version}</span>
      </div>
      <div class="strategy-name">${strategy.name || `Strategy v${strategy.version}`}</div>
      ${description ? `<div class="strategy-description">${description}</div>` : ""}
    </section>`;

    // ── setup card ───────────────────────────────────────────────────────────
    const setupType = cfg.setupType === "break_retest" ? "Break & Retest" : cfg.setupType === "ma_cross" ? "MA Cross" : fmt(cfg.setupType);
    const dir = cfg.direction === "both" ? "Long & Short" : cfg.direction === "long" ? "Long only" : cfg.direction === "short" ? "Short only" : fmt(cfg.direction);

    const setupParams = [
      ["Setup", setupType],
      ["Timeframe", cfg.timeframeMin ? `${cfg.timeframeMin}m` : "5m"],
      ["Direction", dir],
    ];

    if (cfg.setupType === "break_retest") {
      const levels = (s.levels || []).filter(l => l !== "moving_average").map(l => l.toUpperCase()).join(", ") || "PMH, PML";
      const ma = s.movingAverage ? `${s.movingAverage.type} ${(s.movingAverage.values || []).join(", ")}` : "None";
      setupParams.push(
        ["Key Levels", levels],
        ["Confirmation MA", ma],
        ["Break Confirm", fmt(s.breakConfirmation).replace("_", " ")],
        ["Retest Confirm", fmt(s.retestConfirmation).replace("_", " ")],
        ["Entry Trigger", fmt(s.entryTrigger).replace("_", " ")],
        ["Max Retest Bars", fmt(s.maxRetestBars)],
      );
    } else if (cfg.setupType === "ma_cross") {
      setupParams.push(
        ["MA Type", fmt(s.maType)],
        ["Fast MA", fmt(s.fastValue)],
        ["Slow MA", fmt(s.slowValue)],
        ["Entry Reference", fmt(s.entryReference).replace("_", " ")],
        ["Max Entry Bars", fmt(s.maxEntryBarsAfterCross)],
      );
    }

    html += card(
      "Setup Rules",
      "The exact setup logic the system scans for on every bar close.",
      paramGrid(setupParams)
    );

    // ── filters card ─────────────────────────────────────────────────────────
    const filterChecks = [
      [f.requireMarketBias !== false, "Market bias required (SPY + QQQ vs VWAP)"],
      [f.requireSpyQqqAlignment !== false, "SPY / QQQ alignment required"],
      [f.requireVwapAgreement !== false, "VWAP agreement required (price above/below VWAP)"],
      [f.requireRelativeStrength !== false, "Relative strength vs SPY required"],
    ];
    const filterExtras = paramGrid([
      ["Session", fmt(f.session).charAt(0).toUpperCase() + fmt(f.session).slice(1)],
      ["Min Volume", f.minVolume ? Number(f.minVolume).toLocaleString() : "—"],
      ["Min Volatility", f.minVolatilityPct != null ? `${f.minVolatilityPct}%` : "—"],
    ]);

    html += card(
      "Filters",
      "All must pass before a signal is allowed to fire.",
      filterExtras +
      `<div style="margin-top:14px;" class="check-list">
        ${filterChecks.map(([on, label]) => checkItem(on, label)).join("")}
      </div>`
    );

    // ── risk card ─────────────────────────────────────────────────────────────
    html += card(
      "Risk & Exits",
      "Sizing and exit rules applied to every executed trade.",
      paramGrid([
        ["Risk Mode", fmt(r.riskMode).replace("_", " ")],
        ["Risk per Trade", r.riskMode === "fixed_dollars" ? `$${r.riskValue}` : `${r.riskValue}%`],
        ["Stop Mode", fmt(r.stopMode).replace(/_/g, " ")],
        ["Profit Target", r.profitTargetR != null ? `${r.profitTargetR}R` : "—"],
        ["Move to BE at", r.moveToBreakevenAtR != null ? `${r.moveToBreakevenAtR}R` : "Off"],
        ["Time Exit", r.timeExitBars ? `${r.timeExitBars} bars` : "—"],
        ["Max Positions", fmt(r.maxOpenPositions)],
        ["Max Trades/Day", fmt(b.maxTradesPerDay)],
        ["Max Capital", b.maxCapital ? `$${Number(b.maxCapital).toLocaleString()}` : "—"],
      ])
    );

    // ── watchlist card ───────────────────────────────────────────────────────
    if (watchlist && watchlist.length) {
      const chips = watchlist.map(s => `<span class="sym-chip">${s}</span>`).join("");
      html += card(
        "Active Watchlist",
        `${watchlist.length} symbols the engine monitors in real time.`,
        `<div class="watchlist-chips">${chips}</div>`
      );
    }

    root.innerHTML = html;
  }

  // ─── fetch data ────────────────────────────────────────────────────────────

  async function authHeaders() {
    const token = localStorage.getItem("ADMIN_TOKEN") || "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function load() {
    try {
      const headers = await authHeaders();

      const [rsRes, wlRes] = await Promise.all([
        fetch("/api/rulesets", { headers }),
        fetch("/api/watchlist", { headers }),
      ]);

      const rsJson  = rsRes.ok ? await rsRes.json() : {};
      const rulesets = Array.isArray(rsJson) ? rsJson : (rsJson.rulesets ?? []);
      const wlData   = wlRes.ok ? await wlRes.json() : {};
      const watchlist = Array.isArray(wlData.symbols) ? wlData.symbols : (Array.isArray(wlData) ? wlData : []);

      // prefer the active strategy, otherwise take the latest version
      const active = rulesets.find(r => r.active) || rulesets[rulesets.length - 1] || null;
      render(active, watchlist);
    } catch (err) {
      root.innerHTML = `<div class="no-strategy">Failed to load strategy: ${err.message}</div>`;
    }
  }

  load();
})();
