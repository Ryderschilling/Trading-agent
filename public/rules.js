/* global fetch */

(() => {
  const $ = (id) => document.getElementById(id);
  const STRATEGY_SCHEMA_VERSION = 3;
  const ADMIN_TOKEN_STORAGE_KEY = "ADMIN_TOKEN";

  const els = {
    strategiesList: $("strategiesList"),
    builderContext: $("builderContext"),
    saveRulesBtn: $("saveRulesBtn"),
    updateRulesBtn: $("updateRulesBtn"),
    resetBuilderBtn: $("resetBuilderBtn"),

    strategyName: $("strategyName"),
    setupType: $("setupType"),
    timeframeMin: $("timeframeMin"),
    strategyDirection: $("strategyDirection"),

    breakRetestFields: $("breakRetestFields"),
    maCrossFields: $("maCrossFields"),
    brLevels: $("brLevels"),
    brMovingAverageFields: $("brMovingAverageFields"),
    brMaType: $("brMaType"),
    brMaValues: $("brMaValues"),
    brBreakConfirmation: $("brBreakConfirmation"),
    brRetestConfirmation: $("brRetestConfirmation"),
    brMaxRetestBars: $("brMaxRetestBars"),
    brEntryTrigger: $("brEntryTrigger"),

    maType: $("maType"),
    maFastValue: $("maFastValue"),
    maSlowValue: $("maSlowValue"),
    maEntryReference: $("maEntryReference"),
    maRequireCloseAfterCross: $("maRequireCloseAfterCross"),
    maRequireRetest: $("maRequireRetest"),
    maMaxEntryBarsAfterCross: $("maMaxEntryBarsAfterCross"),
    maRequireVwapAgreement: $("maRequireVwapAgreement"),

    sessionMode: $("sessionMode"),
    minVolume: $("minVolume"),
    minVolatilityPct: $("minVolatilityPct"),
    requireMarketBias: $("requireMarketBias"),
    requireSpyQqqAlignment: $("requireSpyQqqAlignment"),
    requireVwapAgreement: $("requireVwapAgreement"),
    requireRelativeStrength: $("requireRelativeStrength"),

    riskMode: $("riskMode"),
    riskValue: $("riskValue"),
    stopMode: $("stopMode"),
    stopValueRWrap: $("stopValueRWrap"),
    stopValueR: $("stopValueR"),
    profitTargetR: $("profitTargetR"),
    moveToBreakevenAtR: $("moveToBreakevenAtR"),
    timeExitBars: $("timeExitBars"),
    maxOpenPositions: $("maxOpenPositions"),

    brokerMaxTradesPerDay: $("brokerMaxTradesPerDay"),
    brokerMaxCapital: $("brokerMaxCapital"),
  };

  const EMPTY_STRATEGIES_HTML = `<div class="rules-empty-state">No saved strategies yet.</div>`;

  const state = {
    currentVersion: null,
    strategies: [],
    form: defaultStrategy("break_retest"),
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function numberOrNull(value) {
    if (value == null || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function integerOrNull(value) {
    const n = numberOrNull(value);
    return n == null ? null : Math.floor(n);
  }

  function boolFromString(value, fallback) {
    if (value === "true") return true;
    if (value === "false") return false;
    return fallback;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getStoredAdminToken() {
    try {
      return String(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function storeAdminToken(token) {
    try {
      const next = String(token || "").trim();
      if (next) {
        localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, next);
      } else {
        localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      }
    } catch {}
  }

  function promptForAdminToken(message) {
    const entered = window.prompt(message, getStoredAdminToken());
    if (entered == null) return null;
    const token = String(entered || "").trim();
    storeAdminToken(token);
    return token;
  }

  function getAdminHeaders(token = getStoredAdminToken()) {
    return token ? { "x-admin-token": token } : {};
  }

  function selectedValues(select) {
    return Array.from(select?.selectedOptions || []).map((option) => String(option.value || ""));
  }

  function setMultiSelectValues(select, values) {
    const wanted = new Set((values || []).map((value) => String(value)));
    Array.from(select?.options || []).forEach((option) => {
      option.selected = wanted.has(String(option.value || ""));
    });
  }

  function parseMaValues(value) {
    return Array.from(
      new Set(
        String(value || "")
          .split(",")
          .map((part) => integerOrNull(part.trim()))
          .filter((item) => item != null && item > 0 && item <= 500)
      )
    ).sort((a, b) => a - b);
  }

  function defaultStrategy(setupType) {
    if (setupType === "ma_cross") {
      return {
        version: STRATEGY_SCHEMA_VERSION,
        name: "",
        description: null,
        setupType,
        timeframeMin: 5,
        direction: "both",
        setup: {
          maType: "EMA",
          fastValue: 9,
          slowValue: 20,
          entryReference: "cross",
          requireCloseAfterCross: true,
          requireRetest: false,
          maxEntryBarsAfterCross: 3,
          requireVwapAgreement: true,
        },
        filters: defaultFilters(),
        risk: defaultRisk("ma_cross"),
        brokerCaps: defaultBrokerCaps(),
      };
    }

    return {
      version: STRATEGY_SCHEMA_VERSION,
      name: "",
      description: null,
      setupType: "break_retest",
      timeframeMin: 5,
      direction: "both",
      setup: {
        levels: ["pmh", "pml", "vwap"],
        movingAverage: null,
        breakConfirmation: "close_through",
        retestConfirmation: "reclaim_close",
        maxRetestBars: 3,
        entryTrigger: "retest_close",
      },
      filters: defaultFilters(),
      risk: defaultRisk("break_retest"),
      brokerCaps: defaultBrokerCaps(),
    };
  }

  function defaultFilters() {
    return {
      session: "regular",
      universe: "watchlist",
      minVolume: 1000000,
      minVolatilityPct: 0.75,
      requireMarketBias: true,
      requireSpyQqqAlignment: true,
      requireVwapAgreement: true,
      requireRelativeStrength: true,
    };
  }

  function defaultRisk(setupType) {
    return {
      riskMode: "percent_account",
      riskValue: 1,
      stopMode: setupType === "ma_cross" ? "ma_fail_close" : "structure_close",
      stopValueR: 1,
      profitTargetR: 2,
      moveToBreakevenAtR: 1,
      timeExitBars: 20,
      maxOpenPositions: 3,
    };
  }

  function defaultBrokerCaps() {
    return {
      maxTradesPerDay: 4,
      maxCapital: 10000,
    };
  }

  function normalizeLoadedStrategy(config, name) {
    const src = config && typeof config === "object" ? clone(config) : {};
    const setupType = src.setupType === "ma_cross" ? "ma_cross" : "break_retest";
    const base = defaultStrategy(setupType);
    const setup = src.setup && typeof src.setup === "object" ? src.setup : {};
    const filters = src.filters && typeof src.filters === "object" ? src.filters : {};
    const risk = src.risk && typeof src.risk === "object" ? src.risk : {};
    const brokerCaps = src.brokerCaps && typeof src.brokerCaps === "object" ? src.brokerCaps : {};

    const normalized = {
      version: STRATEGY_SCHEMA_VERSION,
      name: String(src.name || name || "").trim(),
      description: typeof src.description === "string" ? src.description : null,
      setupType,
      timeframeMin: integerOrNull(src.timeframeMin) || base.timeframeMin,
      direction: src.direction === "long" || src.direction === "short" || src.direction === "both" ? src.direction : base.direction,
      setup:
        setupType === "ma_cross"
          ? {
              maType: setup.maType === "SMA" ? "SMA" : "EMA",
              fastValue: integerOrNull(setup.fastValue) || 9,
              slowValue: Math.max(integerOrNull(setup.slowValue) || 20, (integerOrNull(setup.fastValue) || 9) + 1),
              entryReference:
                ["cross", "fast_ma_pullback", "slow_ma_pullback", "vwap_pullback", "cross_zone_pullback"].includes(setup.entryReference)
                  ? setup.entryReference
                  : "cross",
              requireCloseAfterCross: Boolean(setup.requireCloseAfterCross),
              requireRetest: Boolean(setup.requireRetest),
              maxEntryBarsAfterCross: integerOrNull(setup.maxEntryBarsAfterCross) || 3,
              requireVwapAgreement: setup.requireVwapAgreement !== false,
            }
          : {
              levels: Array.isArray(setup.levels) && setup.levels.length ? setup.levels : base.setup.levels,
              movingAverage:
                Array.isArray(setup?.movingAverage?.values) || typeof setup?.movingAverage?.values === "string"
                  ? {
                      type: setup?.movingAverage?.type === "SMA" ? "SMA" : "EMA",
                      values: parseMaValues(setup?.movingAverage?.values || "").length ? parseMaValues(setup?.movingAverage?.values || "") : [9, 20],
                    }
                  : null,
              breakConfirmation: setup.breakConfirmation === "wick_and_close" ? "wick_and_close" : "close_through",
              retestConfirmation:
                setup.retestConfirmation === "wick_hold" || setup.retestConfirmation === "close_hold"
                  ? setup.retestConfirmation
                  : "reclaim_close",
              maxRetestBars: integerOrNull(setup.maxRetestBars) || 3,
              entryTrigger: setup.entryTrigger === "next_bar_break" ? "next_bar_break" : "retest_close",
            },
      filters: {
        session: ["regular", "premarket", "both"].includes(filters.session) ? filters.session : base.filters.session,
        universe: "watchlist",
        minVolume: numberOrNull(filters.minVolume),
        minVolatilityPct: numberOrNull(filters.minVolatilityPct),
        requireMarketBias: filters.requireMarketBias !== false,
        requireSpyQqqAlignment: filters.requireSpyQqqAlignment !== false,
        requireVwapAgreement: filters.requireVwapAgreement !== false,
        requireRelativeStrength: filters.requireRelativeStrength !== false,
      },
      risk: {
        riskMode: risk.riskMode === "fixed_dollars" ? "fixed_dollars" : "percent_account",
        riskValue: numberOrNull(risk.riskValue) || 1,
        stopMode: ["structure_close", "ma_fail_close", "r_multiple"].includes(risk.stopMode) ? risk.stopMode : base.risk.stopMode,
        stopValueR: numberOrNull(risk.stopValueR),
        profitTargetR: numberOrNull(risk.profitTargetR) || 2,
        moveToBreakevenAtR: numberOrNull(risk.moveToBreakevenAtR),
        timeExitBars: integerOrNull(risk.timeExitBars),
        maxOpenPositions: integerOrNull(risk.maxOpenPositions) || 3,
      },
      brokerCaps: {
        maxTradesPerDay: integerOrNull(brokerCaps.maxTradesPerDay),
        maxCapital: numberOrNull(brokerCaps.maxCapital),
      },
    };

    if (normalized.setupType === "break_retest") {
      const levels = Array.isArray(normalized.setup.levels) ? normalized.setup.levels.filter(Boolean) : [];
      normalized.setup.levels = levels.length ? Array.from(new Set(levels)) : ["pmh", "pml", "vwap"];
      if (!normalized.setup.levels.includes("moving_average")) {
        normalized.setup.movingAverage = null;
      }
    }

    if (normalized.risk.stopMode !== "r_multiple") {
      normalized.risk.stopValueR = null;
    } else if (!normalized.risk.stopValueR) {
      normalized.risk.stopValueR = 1;
    }

    return normalized;
  }

  async function jget(url) {
    const res = await fetch(url);
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }

  async function adminRequest(url, { method = "POST", body = null, promptMessage = "Enter admin token to continue." } = {}) {
    let token = getStoredAdminToken();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = {
        ...getAdminHeaders(token),
      };

      if (body != null) {
        headers["Content-Type"] = "application/json";
      }

      const res = await fetch(url, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);

      if (res.ok) return json;

      if (res.status === 401 && attempt === 0) {
        const prompted = promptForAdminToken(promptMessage);
        if (prompted == null) throw new Error("Action canceled.");
        token = prompted;
        continue;
      }

      if (res.status === 401) {
        storeAdminToken("");
      }

      throw new Error(json?.error || `HTTP ${res.status}`);
    }

    throw new Error("Admin request failed.");
  }

  function enhanceTooltips(scope = document) {
    scope.querySelectorAll(".field-help").forEach((node) => {
      const tip = String(node.getAttribute("data-tooltip") || node.getAttribute("title") || "").trim();
      if (!tip) return;
      node.setAttribute("data-tooltip", tip);
      node.setAttribute("aria-label", tip);
      node.setAttribute("tabindex", "0");
      node.removeAttribute("title");
    });
  }

  function collectFormFromDom() {
    const setupType = els.setupType.value === "ma_cross" ? "ma_cross" : "break_retest";
    const base = defaultStrategy(setupType);

    const next = {
      version: STRATEGY_SCHEMA_VERSION,
      name: String(els.strategyName.value || "").trim(),
      description: null,
      setupType,
      timeframeMin: integerOrNull(els.timeframeMin.value) || 5,
      direction: ["both", "long", "short"].includes(els.strategyDirection.value) ? els.strategyDirection.value : "both",
      setup:
        setupType === "ma_cross"
          ? {
              maType: els.maType.value === "SMA" ? "SMA" : "EMA",
              fastValue: integerOrNull(els.maFastValue.value) || 9,
              slowValue: Math.max(integerOrNull(els.maSlowValue.value) || 20, (integerOrNull(els.maFastValue.value) || 9) + 1),
              entryReference: els.maEntryReference.value,
              requireCloseAfterCross: boolFromString(els.maRequireCloseAfterCross.value, true),
              requireRetest: boolFromString(els.maRequireRetest.value, false),
              maxEntryBarsAfterCross: integerOrNull(els.maMaxEntryBarsAfterCross.value) || 3,
              requireVwapAgreement: boolFromString(els.maRequireVwapAgreement.value, true),
            }
          : {
              levels: selectedValues(els.brLevels),
              movingAverage: selectedValues(els.brLevels).includes("moving_average")
                ? {
                    type: els.brMaType.value === "SMA" ? "SMA" : "EMA",
                    values: parseMaValues(els.brMaValues.value).length ? parseMaValues(els.brMaValues.value) : [9, 20],
                  }
                : null,
              breakConfirmation: els.brBreakConfirmation.value === "wick_and_close" ? "wick_and_close" : "close_through",
              retestConfirmation: ["wick_hold", "reclaim_close", "close_hold"].includes(els.brRetestConfirmation.value)
                ? els.brRetestConfirmation.value
                : "reclaim_close",
              maxRetestBars: integerOrNull(els.brMaxRetestBars.value) || 3,
              entryTrigger: els.brEntryTrigger.value === "next_bar_break" ? "next_bar_break" : "retest_close",
            },
      filters: {
        session: ["regular", "premarket", "both"].includes(els.sessionMode.value) ? els.sessionMode.value : "regular",
        universe: "watchlist",
        minVolume: numberOrNull(els.minVolume.value),
        minVolatilityPct: numberOrNull(els.minVolatilityPct.value),
        requireMarketBias: boolFromString(els.requireMarketBias.value, true),
        requireSpyQqqAlignment: boolFromString(els.requireSpyQqqAlignment.value, true),
        requireVwapAgreement: boolFromString(els.requireVwapAgreement.value, true),
        requireRelativeStrength: boolFromString(els.requireRelativeStrength.value, true),
      },
      risk: {
        riskMode: els.riskMode.value === "fixed_dollars" ? "fixed_dollars" : "percent_account",
        riskValue: numberOrNull(els.riskValue.value) || 1,
        stopMode: ["structure_close", "ma_fail_close", "r_multiple"].includes(els.stopMode.value) ? els.stopMode.value : base.risk.stopMode,
        stopValueR: els.stopMode.value === "r_multiple" ? numberOrNull(els.stopValueR.value) || 1 : null,
        profitTargetR: numberOrNull(els.profitTargetR.value),
        moveToBreakevenAtR: numberOrNull(els.moveToBreakevenAtR.value),
        timeExitBars: integerOrNull(els.timeExitBars.value),
        maxOpenPositions: integerOrNull(els.maxOpenPositions.value) || 1,
      },
      brokerCaps: {
        maxTradesPerDay: integerOrNull(els.brokerMaxTradesPerDay.value),
        maxCapital: numberOrNull(els.brokerMaxCapital.value),
      },
    };

    if (next.setupType === "break_retest" && next.setup.levels.length <= 0) {
      next.setup.levels = clone(base.setup.levels);
    }

    state.form = next;
    return next;
  }

  function applyFormToDom() {
    const form = state.form;
    els.strategyName.value = form.name || "";
    els.setupType.value = form.setupType;
    els.timeframeMin.value = String(form.timeframeMin || 5);
    els.strategyDirection.value = form.direction;

    if (form.setupType === "break_retest") {
      setMultiSelectValues(els.brLevels, form.setup.levels || []);
      els.brMaType.value = form.setup.movingAverage?.type || "EMA";
      els.brMaValues.value = Array.isArray(form.setup.movingAverage?.values) ? form.setup.movingAverage.values.join(",") : "";
      els.brBreakConfirmation.value = form.setup.breakConfirmation;
      els.brRetestConfirmation.value = form.setup.retestConfirmation;
      els.brMaxRetestBars.value = form.setup.maxRetestBars ?? "";
      els.brEntryTrigger.value = form.setup.entryTrigger;
    } else {
      els.maType.value = form.setup.maType;
      els.maFastValue.value = form.setup.fastValue ?? "";
      els.maSlowValue.value = form.setup.slowValue ?? "";
      els.maEntryReference.value = form.setup.entryReference;
      els.maRequireCloseAfterCross.value = String(Boolean(form.setup.requireCloseAfterCross));
      els.maRequireRetest.value = String(Boolean(form.setup.requireRetest));
      els.maMaxEntryBarsAfterCross.value = form.setup.maxEntryBarsAfterCross ?? "";
      els.maRequireVwapAgreement.value = String(Boolean(form.setup.requireVwapAgreement));
    }

    els.sessionMode.value = form.filters.session;
    els.minVolume.value = form.filters.minVolume ?? "";
    els.minVolatilityPct.value = form.filters.minVolatilityPct ?? "";
    els.requireMarketBias.value = String(Boolean(form.filters.requireMarketBias));
    els.requireSpyQqqAlignment.value = String(Boolean(form.filters.requireSpyQqqAlignment));
    els.requireVwapAgreement.value = String(Boolean(form.filters.requireVwapAgreement));
    els.requireRelativeStrength.value = String(Boolean(form.filters.requireRelativeStrength));

    els.riskMode.value = form.risk.riskMode;
    els.riskValue.value = form.risk.riskValue ?? "";
    els.stopMode.value = form.risk.stopMode;
    els.stopValueR.value = form.risk.stopValueR ?? "";
    els.profitTargetR.value = form.risk.profitTargetR ?? "";
    els.moveToBreakevenAtR.value = form.risk.moveToBreakevenAtR ?? "";
    els.timeExitBars.value = form.risk.timeExitBars ?? "";
    els.maxOpenPositions.value = form.risk.maxOpenPositions ?? "";

    els.brokerMaxTradesPerDay.value = form.brokerCaps.maxTradesPerDay ?? "";
    els.brokerMaxCapital.value = form.brokerCaps.maxCapital ?? "";

    syncVisibility();
    updateContext();
    updateSummary();
  }

  function syncVisibility() {
    const setupType = els.setupType.value === "ma_cross" ? "ma_cross" : "break_retest";
    els.breakRetestFields.hidden = setupType !== "break_retest";
    els.maCrossFields.hidden = setupType !== "ma_cross";
    els.brMovingAverageFields.hidden = !selectedValues(els.brLevels).includes("moving_average");
    els.stopValueRWrap.hidden = els.stopMode.value !== "r_multiple";
  }

  function updateContext() {
    const setupLabel = state.form.setupType === "ma_cross" ? "MA Cross" : "Break & Retest";
    const versionText = state.currentVersion ? `Editing strategy v${state.currentVersion}` : "Creating a new strategy version";
    if (els.builderContext) {
      els.builderContext.textContent = `${versionText}. Current setup family: ${setupLabel}. Save New Version creates a fresh ruleset; Update Current modifies the selected one.`;
    }
    if (els.updateRulesBtn) {
      els.updateRulesBtn.disabled = !state.currentVersion;
    }
  }

  function updateSummary() {
    collectFormFromDom();
  }

  function reportActionError(error) {
    const message = String(error?.message || error || "");
    if (!message || message === "Action canceled.") return;
    alert(message);
  }

  function validateForm() {
    const form = collectFormFromDom();
    if (!form.name) throw new Error("Strategy name is required.");
    if (form.setupType === "break_retest" && form.setup.levels.length <= 0) throw new Error("Select at least one break and retest level.");
    if (form.setupType === "ma_cross" && form.setup.fastValue >= form.setup.slowValue) throw new Error("Fast MA must be smaller than Slow MA.");
    if (form.risk.riskValue == null || form.risk.riskValue <= 0) throw new Error("Risk value must be greater than zero.");
    if (form.risk.stopMode === "r_multiple" && (form.risk.stopValueR == null || form.risk.stopValueR <= 0)) {
      throw new Error("Stop R value is required when Stop Mode is R Multiple.");
    }
    if (form.risk.maxOpenPositions == null || form.risk.maxOpenPositions < 1) throw new Error("Max open positions must be at least 1.");
    return form;
  }

  async function loadStrategy(version) {
    const result = await jget(`/api/rulesets/${encodeURIComponent(version)}`);
    const ruleset = result?.ruleset;
    if (!ruleset) throw new Error("Strategy not found.");
    state.currentVersion = Number(ruleset.version);
    state.form = normalizeLoadedStrategy(ruleset.config, ruleset.name);
    applyFormToDom();
  }

  async function saveNewVersion() {
    const payload = clone(validateForm());
    await adminRequest("/api/rules", {
      body: { name: payload.name, config: payload, changedBy: "ui" },
      promptMessage: "Enter admin token to save a new strategy version.",
    });
    state.currentVersion = null;
    await boot();
  }

  async function updateCurrent() {
    if (!state.currentVersion) throw new Error("Load a strategy before updating it.");
    const payload = clone(validateForm());
    await adminRequest(`/api/rulesets/${encodeURIComponent(state.currentVersion)}/update`, {
      body: { name: payload.name, config: payload, changedBy: "ui" },
      promptMessage: "Enter admin token to update this strategy version.",
    });
    await boot();
    await loadStrategy(state.currentVersion);
  }

  async function deleteStrategy(version) {
    const ok = window.confirm(`Delete strategy v${version}? This cannot be undone.`);
    if (!ok) return;
    await adminRequest(`/api/rulesets/${encodeURIComponent(version)}`, {
      method: "DELETE",
      promptMessage: `Enter admin token to delete strategy v${version}.`,
    });
    if (state.currentVersion === version) {
      state.currentVersion = null;
      state.form = defaultStrategy(state.form.setupType);
      applyFormToDom();
    }
    await boot();
  }

  function renderStrategies() {
    if (!els.strategiesList) return;
    const rows = Array.isArray(state.strategies) ? state.strategies : [];
    if (!rows.length) {
      els.strategiesList.innerHTML = EMPTY_STRATEGIES_HTML;
      return;
    }

    els.strategiesList.innerHTML = rows
      .map((row) => `
        <div class="strategy-row">
          <div class="strategy-row-main">
            <div class="strategy-title">${escapeHtml(String(row.name || `Strategy v${row.version}`))}</div>
            <div class="small muted">v${escapeHtml(row.version)}${row.created_ts ? ` • ${escapeHtml(new Date(Number(row.created_ts)).toLocaleString())}` : ""}</div>
          </div>
          <div class="strategy-actions">
            <button class="btn" data-act="edit" data-v="${escapeHtml(row.version)}">Edit</button>
            <button class="btn" data-act="toggle" data-v="${escapeHtml(row.version)}">${row.active ? "Enabled" : "Enable"}</button>
            <button class="btn" data-act="delete" data-v="${escapeHtml(row.version)}">Delete</button>
          </div>
        </div>
      `)
      .join("");

    els.strategiesList.querySelectorAll("[data-act]").forEach((button) => {
      button.addEventListener("click", async () => {
        const version = Number(button.getAttribute("data-v"));
        const action = button.getAttribute("data-act");
        const row = rows.find((item) => Number(item.version) === version);

        try {
          if (action === "edit") {
            await loadStrategy(version);
            window.scrollTo({ top: 0, behavior: "smooth" });
            return;
          }
          if (action === "toggle") {
            await adminRequest(`/api/rules/toggle/${encodeURIComponent(version)}`, {
              body: { active: !Boolean(row?.active) },
              promptMessage: `Enter admin token to ${row?.active ? "disable" : "enable"} strategy v${version}.`,
            });
            await boot();
            return;
          }
          if (action === "delete") {
            await deleteStrategy(version);
          }
        } catch (error) {
          reportActionError(error);
        }
      });
    });
  }

  async function boot() {
    const data = await jget("/api/rulesets");
    state.strategies = Array.isArray(data?.rulesets) ? data.rulesets : [];
    renderStrategies();
    updateContext();
    updateSummary();
  }

  function switchSetupType(nextType) {
    const current = collectFormFromDom();
    if (current.setupType === nextType) return;
    const fresh = defaultStrategy(nextType);
    state.form = {
      ...fresh,
      name: current.name,
      description: current.description,
      timeframeMin: current.timeframeMin,
      direction: current.direction,
      filters: clone(current.filters),
      risk: {
        ...clone(current.risk),
        stopMode: nextType === "ma_cross" && current.risk.stopMode === "structure_close" ? "ma_fail_close" : current.risk.stopMode,
      },
      brokerCaps: clone(current.brokerCaps),
    };
    applyFormToDom();
  }

  function bindInputs() {
    [
      els.strategyName,
      els.setupType,
      els.timeframeMin,
      els.strategyDirection,
      els.brLevels,
      els.brMaType,
      els.brMaValues,
      els.brBreakConfirmation,
      els.brRetestConfirmation,
      els.brMaxRetestBars,
      els.brEntryTrigger,
      els.maType,
      els.maFastValue,
      els.maSlowValue,
      els.maEntryReference,
      els.maRequireCloseAfterCross,
      els.maRequireRetest,
      els.maMaxEntryBarsAfterCross,
      els.maRequireVwapAgreement,
      els.sessionMode,
      els.minVolume,
      els.minVolatilityPct,
      els.requireMarketBias,
      els.requireSpyQqqAlignment,
      els.requireVwapAgreement,
      els.requireRelativeStrength,
      els.riskMode,
      els.riskValue,
      els.stopMode,
      els.stopValueR,
      els.profitTargetR,
      els.moveToBreakevenAtR,
      els.timeExitBars,
      els.maxOpenPositions,
      els.brokerMaxTradesPerDay,
      els.brokerMaxCapital,
    ]
      .filter(Boolean)
      .forEach((el) => {
        el.addEventListener("input", () => {
          syncVisibility();
          updateSummary();
        });
        el.addEventListener("change", () => {
          if (el === els.setupType) {
            switchSetupType(els.setupType.value === "ma_cross" ? "ma_cross" : "break_retest");
            return;
          }
          syncVisibility();
          updateSummary();
        });
      });
  }

  function initButtons() {
    if (els.resetBuilderBtn) {
      els.resetBuilderBtn.addEventListener("click", () => {
        state.currentVersion = null;
        state.form = defaultStrategy(els.setupType.value === "ma_cross" ? "ma_cross" : "break_retest");
        applyFormToDom();
      });
    }

    if (els.saveRulesBtn) {
      els.saveRulesBtn.addEventListener("click", async () => {
        try {
          await saveNewVersion();
        } catch (error) {
          reportActionError(error);
        }
      });
    }

    if (els.updateRulesBtn) {
      els.updateRulesBtn.addEventListener("click", async () => {
        try {
          await updateCurrent();
        } catch (error) {
          reportActionError(error);
        }
      });
    }

  }

  function init() {
    enhanceTooltips(document);
    bindInputs();
    initButtons();
    applyFormToDom();
    boot().catch((error) => {
      console.error(error);
      alert(`Rules boot failed: ${String(error?.message || error)}`);
    });
  }

  init();
})();
