const $ = (id) => document.getElementById(id);

const els = {
  brokerSelect: $("brokerSelect"),
  modeSelect: $("modeSelect"),
  brokerFields: $("brokerFields"),
  saveCfg: $("saveCfg"),
  saveSafety: $("saveSafety"),
  saveStatus: $("saveStatus"),
  refreshBtn: $("refreshBtn"),

  statusProviderPill: $("statusProviderPill"),
  statusConnectionPill: $("statusConnectionPill"),
  toggleExecutionBtn: $("toggleExecutionBtn"),
  modePaperBtn: $("modePaperBtn"),
  modeLiveBtn: $("modeLiveBtn"),
  blockingAlert: $("blockingAlert"),
  blockingAlertText: $("blockingAlertText"),

  openSettingsBtn: $("openSettingsBtn"),
  closeSettingsBtn: $("closeSettingsBtn"),
  settingsModal: $("settingsModal"),
  settingsBackdrop: $("settingsBackdrop"),

  tradingEnabled: $("tradingEnabled"),
  liveArmed: $("liveArmed"),
  revertPaperBtn: $("revertPaperBtn"),

  sizingMode: $("sizingMode"),
  defaultNotional: $("defaultNotional"),
  defaultQty: $("defaultQty"),
  extendedHours: $("extendedHours"),
  bracketEnabled: $("bracketEnabled"),
  stopLossPct: $("stopLossPct"),
  takeProfitPct: $("takeProfitPct"),
  maxDailyNotional: $("maxDailyNotional"),
  maxOpenPositions: $("maxOpenPositions"),
  maxOrdersPerSymbolPerDay: $("maxOrdersPerSymbolPerDay"),

  kpiEquity: $("kpiEquity"),
  kpiCash: $("kpiCash"),
  kpiBuyingPower: $("kpiBuyingPower"),
  kpiOpenPositions: $("kpiOpenPositions"),
  kpiOpenOrders: $("kpiOpenOrders"),
  kpiProvider: $("kpiProvider"),
  accountProviderBadge: $("accountProviderBadge"),
  accountModeBadge: $("accountModeBadge"),
  accountStatusBadge: $("accountStatusBadge"),
  accountBarChart: $("accountBarChart"),
  accountChartCaption: $("accountChartCaption"),
  accountChartEmpty: $("accountChartEmpty"),

  executionReadinessBadge: $("executionReadinessBadge"),
  executionModeBadge: $("executionModeBadge"),
  executionStateAlert: $("executionStateAlert"),
  executionStateAlertTitle: $("executionStateAlertTitle"),
  executionStateAlertBody: $("executionStateAlertBody"),
  execStateValue: $("execStateValue"),
  execConnectionValue: $("execConnectionValue"),
  execLiveArmValue: $("execLiveArmValue"),
  execKillSwitchValue: $("execKillSwitchValue"),
  execCoverageValue: $("execCoverageValue"),
  execNextActionValue: $("execNextActionValue"),
  execLastSkipValue: $("execLastSkipValue"),
  executionHistoricalNote: $("executionHistoricalNote"),
  activityContext: $("activityContext"),

  positionsList: $("positionsList"),
  ordersList: $("ordersList"),
  positionsEmpty: $("positionsEmpty"),
  ordersEmpty: $("ordersEmpty"),
  activityList: $("activityList"),
  activityEmpty: $("activityEmpty"),

  kvBroker: $("kvBroker"),
  kvMode: $("kvMode"),
  kvStatus: $("kvStatus"),
  kvLastCheck: $("kvLastCheck"),
  kvStatusDetail: $("kvStatusDetail"),
  kvKillSwitch: $("kvKillSwitch"),
  kvLastGoodCheckMirror: $("kvLastGoodCheckMirror"),
  dupStatus: $("dupStatus"),
  lastGoodCheck: $("lastGoodCheck"),
  connSummary: $("connSummary"),
  connectionAlert: $("connectionAlert"),
  connectionAlertTitle: $("connectionAlertTitle"),
  connectionAlertBody: $("connectionAlertBody"),
};

let BROKERS = [];
let CURRENT_CFG = null;
let LAST_STATUS = null;

function fmtMoney(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Date(n).toLocaleString();
}

function maskedField(field) {
  const key = String(field?.key || "");
  return Boolean(field?.secret) || /key|secret|token/i.test(key);
}

function badgeToneClasses(base, tone) {
  return [base, tone ? `is-${tone}` : null].filter(Boolean).join(" ");
}

function setStatusBadge(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.className = badgeToneClasses("broker-status-badge", tone || "neutral");
}

function setPill(el, text, tone) {
  if (!el) return;
  el.textContent = text;
  el.className = badgeToneClasses("broker-pill", tone || "subtle");
}

function showSavePill(text, tone) {
  if (!els.saveStatus) return;
  setStatusBadge(els.saveStatus, text, tone || "neutral");
  els.saveStatus.style.display = "inline-flex";
  window.clearTimeout(showSavePill._timer);
  showSavePill._timer = window.setTimeout(() => {
    els.saveStatus.style.display = "none";
  }, 2600);
}

function api(path, opts) {
  return fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  }).then(async (res) => {
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.error) || `HTTP ${res.status}`);
    return json;
  });
}

function providerKey(status) {
  return String(status?.provider || CURRENT_CFG?.brokerKey || "—");
}

function providerLabel(status) {
  return providerKey(status).toUpperCase();
}

function modeValue(status) {
  return String(status?.mode || CURRENT_CFG?.mode || "disabled");
}

function modeLabel(status) {
  return modeValue(status).toUpperCase();
}

function getBrokerName(key) {
  if (!key || key === "—" || key === "none") return "Disabled";
  const broker = BROKERS.find((row) => row.key === key);
  return broker?.name || key || "Disabled";
}

function renderFields() {
  const brokerKey = String(els.brokerSelect?.value || "");
  const broker = BROKERS.find((row) => row.key === brokerKey);
  const config = CURRENT_CFG?.config || {};

  if (!els.brokerFields) return;
  els.brokerFields.innerHTML = "";
  if (!broker) return;

  for (const field of broker.fields || []) {
    const row = document.createElement("div");
    row.className = "form-row";

    const label = document.createElement("label");
    label.htmlFor = `bf_${field.key}`;
    label.textContent = field.label;

    const input = document.createElement("input");
    input.id = `bf_${field.key}`;
    input.type = maskedField(field) ? "password" : field.type || "text";
    input.className = "input broker-control";
    input.placeholder = field.placeholder || "";
    input.value = config[field.key] != null ? String(config[field.key]) : "";
    input.autocomplete = "off";
    if (field.type === "number") input.inputMode = "decimal";

    row.appendChild(label);
    row.appendChild(input);
    els.brokerFields.appendChild(row);
  }
}

function readOptionalNumberInput(el, fallback) {
  if (!el) return fallback ?? null;
  if (el.value === "") return null;
  const n = Number(el.value);
  return Number.isFinite(n) ? n : fallback ?? null;
}

function buildConfigFromForm() {
  const brokerKey = String(els.brokerSelect?.value || "");
  const broker = BROKERS.find((row) => row.key === brokerKey);
  const config = {};
  const existingExec = CURRENT_CFG?.execution || {};

  if (broker) {
    for (const field of broker.fields || []) {
      const input = $(`bf_${field.key}`);
      if (!input) continue;
      let value = input.value;
      if (field.type === "number") {
        const n = Number(value);
        value = Number.isFinite(n) ? n : value;
      }
      config[field.key] = value;
    }
  }

  return {
    brokerKey,
    mode: String(els.modeSelect?.value || CURRENT_CFG?.mode || "disabled"),
    config,
    tradingEnabled: Boolean(els.tradingEnabled?.checked ?? CURRENT_CFG?.tradingEnabled),
    execution: {
      liveArmed: Boolean(els.liveArmed?.checked ?? existingExec.liveArmed),
      sizingMode: String(els.sizingMode?.value || existingExec.sizingMode || "notional"),
      defaultNotional: readOptionalNumberInput(els.defaultNotional, existingExec.defaultNotional),
      defaultQty: readOptionalNumberInput(els.defaultQty, existingExec.defaultQty),
      extendedHours: Boolean(els.extendedHours?.checked ?? existingExec.extendedHours),
      bracketEnabled: Boolean(els.bracketEnabled?.checked ?? existingExec.bracketEnabled),
      stopLossPct: readOptionalNumberInput(els.stopLossPct, existingExec.stopLossPct),
      takeProfitPct: readOptionalNumberInput(els.takeProfitPct, existingExec.takeProfitPct),
      maxDailyNotional: readOptionalNumberInput(els.maxDailyNotional, existingExec.maxDailyNotional),
      maxOpenPositions: readOptionalNumberInput(els.maxOpenPositions, existingExec.maxOpenPositions),
      maxOrdersPerSymbolPerDay: readOptionalNumberInput(
        els.maxOrdersPerSymbolPerDay,
        existingExec.maxOrdersPerSymbolPerDay
      ),
    },
  };
}

function fillExecutionControls(cfg) {
  const exec = cfg?.execution || {};
  if (els.sizingMode) els.sizingMode.value = exec.sizingMode || "notional";
  if (els.defaultNotional) els.defaultNotional.value = exec.defaultNotional != null ? String(exec.defaultNotional) : "";
  if (els.defaultQty) els.defaultQty.value = exec.defaultQty != null ? String(exec.defaultQty) : "";
  if (els.extendedHours) els.extendedHours.checked = Boolean(exec.extendedHours);
  if (els.bracketEnabled) els.bracketEnabled.checked = Boolean(exec.bracketEnabled);
  if (els.stopLossPct) els.stopLossPct.value = exec.stopLossPct != null ? String(exec.stopLossPct) : "";
  if (els.takeProfitPct) els.takeProfitPct.value = exec.takeProfitPct != null ? String(exec.takeProfitPct) : "";
  if (els.maxDailyNotional) els.maxDailyNotional.value = exec.maxDailyNotional != null ? String(exec.maxDailyNotional) : "";
  if (els.maxOpenPositions) els.maxOpenPositions.value = exec.maxOpenPositions != null ? String(exec.maxOpenPositions) : "";
  if (els.maxOrdersPerSymbolPerDay) {
    els.maxOrdersPerSymbolPerDay.value =
      exec.maxOrdersPerSymbolPerDay != null ? String(exec.maxOrdersPerSymbolPerDay) : "";
  }
  if (els.liveArmed) els.liveArmed.checked = Boolean(exec.liveArmed);
  if (els.tradingEnabled) els.tradingEnabled.checked = Boolean(cfg?.tradingEnabled);
  syncMainControls();
}

function clearLists() {
  if (els.positionsList) els.positionsList.innerHTML = "";
  if (els.ordersList) els.ordersList.innerHTML = "";
  if (els.activityList) els.activityList.innerHTML = "";
  if (els.positionsEmpty) els.positionsEmpty.style.display = "none";
  if (els.ordersEmpty) els.ordersEmpty.style.display = "none";
}

function getConnectionState(status) {
  if (status?.connectionState) return status.connectionState;
  const code = String(status?.connectionStatus || "disconnected");
  return {
    code,
    label: code ? code.replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Disconnected",
    reason: String(status?.statusText || ""),
  };
}

function getGlobalSafety(status) {
  if (status?.globalSafety) return status.globalSafety;
  const executionEnabled = Boolean(CURRENT_CFG?.tradingEnabled);
  return {
    executionEnabled,
    killSwitchEnabled: !executionEnabled,
    liveArmed: Boolean(CURRENT_CFG?.execution?.liveArmed),
  };
}

function getExecutionState(status) {
  if (status?.executionState) return status.executionState;
  const safety = getGlobalSafety(status);
  if (safety.killSwitchEnabled) {
    return {
      code: "blocked_kill_switch",
      label: "Blocked — Kill Switch",
      canSubmit: false,
      reason: "Broker execution is disabled by the master kill switch.",
    };
  }
  if (String(CURRENT_CFG?.mode || "") === "live" && !safety.liveArmed) {
    return {
      code: "blocked_live_not_armed",
      label: "Blocked — Live Not Armed",
      canSubmit: false,
      reason: "Live broker mode is selected, but live execution is not armed.",
    };
  }
  return {
    code: "blocked_other",
    label: "Blocked — Connection Required",
    canSubmit: false,
    reason: String(status?.statusText || "Broker status is unavailable."),
  };
}

function getStrategyCoverage(status) {
  return (
    status?.strategyCoverage || {
      enabledStrategies: 0,
      readyStrategies: 0,
      disabledStrategies: 0,
      missingPolicies: 0,
      summary: "Strategy coverage unavailable.",
    }
  );
}

function describeStatus(status) {
  const configured = Boolean(status?.configured ?? CURRENT_CFG?.brokerKey);
  const connection = getConnectionState(status);
  const reason = String(connection?.reason || status?.statusText || "");

  if (!configured) {
    return {
      badgeText: "Disabled",
      tone: "neutral",
      alertTone: "warn",
      alertTitle: "Broker connection is not configured",
      alertBody: "Choose a provider and save credentials to enable broker account snapshots and execution controls.",
      emptyText: "Connect a broker to populate account data.",
    };
  }

  if (connection.code === "connected") {
    return {
      badgeText: connection.label || "Connected",
      tone: "ok",
      alertTone: null,
      alertTitle: "",
      alertBody: "",
      emptyText: "No open positions or orders right now.",
    };
  }

  if (connection.code === "unauthorized") {
    return {
      badgeText: connection.label || "Unauthorized",
      tone: "bad",
      alertTone: "bad",
      alertTitle: "Broker credentials were rejected",
      alertBody: reason || "The configured provider returned an authorization failure.",
      emptyText: "Account data is unavailable while authentication is failing.",
    };
  }

  if (connection.code === "unsupported") {
    return {
      badgeText: connection.label || "Unsupported",
      tone: "warn",
      alertTone: "warn",
      alertTitle: "Configured provider is not available in this execution pass",
      alertBody: reason || "Only the currently supported broker adapter can return live account data here.",
      emptyText: "No account data is available for the selected provider.",
    };
  }

  if (connection.code === "disabled") {
    return {
      badgeText: connection.label || "Disabled",
      tone: "warn",
      alertTone: "warn",
      alertTitle: "Broker mode is disabled",
      alertBody: reason || "Switch the broker to paper or live mode to resume status checks.",
      emptyText: "Enable paper or live mode to populate account data.",
    };
  }

  return {
    badgeText: connection.label || "Disconnected",
    tone: "bad",
    alertTone: "bad",
    alertTitle: "Broker status is unavailable",
    alertBody: reason || "The latest broker health check failed, so account and order data could not be refreshed.",
    emptyText: "Account data is unavailable until broker status recovers.",
  };
}

function setConnectionAlert(state) {
  if (!els.connectionAlert || !els.connectionAlertTitle || !els.connectionAlertBody) return;

  if (!state?.alertTone) {
    els.connectionAlert.style.display = "none";
    els.connectionAlert.className = "broker-alert";
    els.connectionAlertTitle.textContent = "";
    els.connectionAlertBody.textContent = "";
    return;
  }

  els.connectionAlert.style.display = "block";
  els.connectionAlert.className = badgeToneClasses("broker-alert", state.alertTone);
  els.connectionAlertTitle.textContent = state.alertTitle;
  els.connectionAlertBody.textContent = state.alertBody;
}

function setAccountBadges(status, state) {
  const connection = getConnectionState(status);
  if (els.accountProviderBadge) els.accountProviderBadge.textContent = `Provider ${providerLabel(status)}`;
  if (els.accountModeBadge) els.accountModeBadge.textContent = `Mode ${modeLabel(status)}`;
  if (els.accountStatusBadge) {
    els.accountStatusBadge.textContent = connection?.label || state?.badgeText || "Status —";
    els.accountStatusBadge.className = badgeToneClasses("broker-pill", state?.tone || "subtle");
  }
}

function setConnDetails(status, state) {
  const safety = getGlobalSafety(status);
  const connection = getConnectionState(status);

  if (els.kvBroker) els.kvBroker.textContent = providerLabel(status);
  if (els.kvMode) els.kvMode.textContent = modeLabel(status);
  if (els.kvStatus) els.kvStatus.textContent = connection?.label || state?.badgeText || "—";
  if (els.kvLastCheck) els.kvLastCheck.textContent = fmtTime(status?.checkedAt);
  if (els.kvStatusDetail) els.kvStatusDetail.textContent = String(status?.statusText || connection?.reason || "—");
  if (els.kvKillSwitch) els.kvKillSwitch.textContent = safety.killSwitchEnabled ? "ON" : "OFF";
  if (els.kvLastGoodCheckMirror) els.kvLastGoodCheckMirror.textContent = fmtTime(status?.lastSuccessfulCheckTs);
  if (els.dupStatus) els.dupStatus.textContent = status?.duplicateProtection?.active ? "ACTIVE" : "OFF";
  if (els.lastGoodCheck) els.lastGoodCheck.textContent = fmtTime(status?.lastSuccessfulCheckTs);
  if (els.connSummary) els.connSummary.textContent = connection?.label || "—";
}

function executionTone(code) {
  const c = String(code || "");
  if (c === "ready_paper" || c === "ready_live") return "ok";
  if (c === "blocked_other") return "bad";
  return "warn";
}

function findRecentSkip(activity) {
  const rows = Array.isArray(activity) ? activity : [];
  return rows.find((item) => String(item?.status || "").toUpperCase() === "SKIPPED" && item?.reason) || null;
}

function getPrimaryIssue(status, activity) {
  const connection = getConnectionState(status);
  const execution = getExecutionState(status);
  const safety = getGlobalSafety(status);
  const coverage = getStrategyCoverage(status);
  const lastSkip =
    (status?.lastSkip && {
      reason: status.lastSkip.reason,
      ts: status.lastSkip.ts,
      symbol: status.lastSkip.symbol,
    }) ||
    findRecentSkip(activity || status?.recentActivity);

  if (!CURRENT_CFG?.brokerKey) {
    return {
      tone: "warn",
      body: "Broker not configured. Open Broker Settings to choose a provider and save credentials.",
      nextAction: "Configure a broker connection.",
    };
  }

  if (connection.code !== "connected") {
    return {
      tone: connection.code === "unauthorized" ? "bad" : "warn",
      body: connection.reason || "Broker connection is not healthy.",
      nextAction: "Fix the connection details and refresh status.",
    };
  }

  if (safety.killSwitchEnabled) {
    return {
      tone: "warn",
      body: "Execution is blocked because the master kill switch is off.",
      nextAction: "Turn execution on when ready.",
    };
  }

  if (modeValue(status) === "live" && !safety.liveArmed) {
    return {
      tone: "warn",
      body: "Live mode is selected, but live arm is still off.",
      nextAction: "Arm live in Broker Settings before expecting live submissions.",
    };
  }

  if (coverage.readyStrategies <= 0) {
    return {
      tone: "warn",
      body: execution.reason || "No enabled strategy is active.",
      nextAction: "Enable a strategy on the Rules page.",
    };
  }

  return {
    tone: "ok",
    body: lastSkip?.reason ? `Recent skip is historical: ${lastSkip.reason}.` : "No current execution blocker is present.",
    nextAction: "Monitor broker activity.",
  };
}

function buildChartMetrics(status) {
  const account = status?.account || null;
  const positions = Array.isArray(status?.positions) ? status.positions : [];
  const exposure = positions.reduce((sum, item) => {
    const marketValue = Number(item?.marketValue);
    return sum + (Number.isFinite(marketValue) ? Math.abs(marketValue) : 0);
  }, 0);

  const metrics = [
    { key: "equity", label: "Equity", value: Number(account?.equity) },
    { key: "buying-power", label: "Buying Power", value: Number(account?.buyingPower) },
    { key: "cash", label: "Cash", value: Number(account?.cash) },
  ];

  if (exposure > 0) metrics.push({ key: "exposure", label: "Exposure", value: exposure });
  return metrics.filter((item) => Number.isFinite(item.value) && item.value >= 0);
}

function resetAccountChart(message) {
  if (els.accountBarChart) els.accountBarChart.innerHTML = "";
  if (els.accountChartCaption) {
    els.accountChartCaption.textContent =
      message || "No account snapshot is available yet, so the graph is waiting on a successful broker status check.";
  }
  if (els.accountChartEmpty) els.accountChartEmpty.style.display = "block";
}

function renderAccountChart(status) {
  if (!els.accountBarChart || !els.accountChartCaption || !els.accountChartEmpty) return;

  const metrics = buildChartMetrics(status);
  const max = Math.max(...metrics.map((item) => item.value), 0);
  els.accountBarChart.innerHTML = "";

  if (!status?.ok || !metrics.length || max <= 0) {
    resetAccountChart("Current snapshot data is unavailable, so the chart is waiting on a successful broker status response.");
    return;
  }

  els.accountChartCaption.textContent =
    metrics.some((item) => item.key === "exposure")
      ? "Snapshot comparison using current account values plus open-position exposure."
      : "Snapshot comparison using the current account values returned by the broker.";
  els.accountChartEmpty.style.display = "none";

  metrics.forEach((item) => {
    const row = document.createElement("div");
    row.className = "broker-chart-card";

    const label = document.createElement("div");
    label.className = "broker-mini-label";
    label.textContent = item.label;

    const track = document.createElement("div");
    track.className = "broker-chart-track";

    const bar = document.createElement("div");
    const pct = max > 0 ? (item.value / max) * 100 : 0;
    bar.className = `broker-chart-bar is-${item.key}`;
    bar.style.width = `${Math.max(item.value > 0 ? 8 : 0, pct)}%`;
    track.appendChild(bar);

    const value = document.createElement("div");
    value.className = "broker-chart-value";
    value.textContent = fmtMoney(item.value);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(value);
    els.accountBarChart.appendChild(row);
  });
}

function renderExecutionReadiness(status, activity) {
  const execution = getExecutionState(status);
  const safety = getGlobalSafety(status);
  const connection = getConnectionState(status);
  const coverage = getStrategyCoverage(status);
  const priority = getPrimaryIssue(status, activity);
  const lastSkip =
    (status?.lastSkip && {
      reason: status.lastSkip.reason,
      ts: status.lastSkip.ts,
      symbol: status.lastSkip.symbol,
    }) ||
    findRecentSkip(activity || status?.recentActivity);
  const tone = executionTone(execution.code);

  setPill(els.executionReadinessBadge, execution.label || "Execution —", tone);
  setPill(els.executionModeBadge, `Mode ${modeLabel(status)}`, "subtle");

  if (els.executionStateAlert) {
    els.executionStateAlert.style.display = "block";
    els.executionStateAlert.className = badgeToneClasses("broker-alert", tone);
  }
  if (els.executionStateAlertTitle) els.executionStateAlertTitle.textContent = execution.label || "Execution readiness";
  if (els.executionStateAlertBody) els.executionStateAlertBody.textContent = execution.reason || "Execution readiness is unavailable.";

  if (els.execStateValue) els.execStateValue.textContent = execution.label || "—";
  if (els.execConnectionValue) els.execConnectionValue.textContent = connection?.label || "—";
  if (els.execLiveArmValue) {
    els.execLiveArmValue.textContent =
      modeValue(status) === "live" ? (safety.liveArmed ? "ARMED FOR LIVE" : "LIVE ARM OFF") : safety.liveArmed ? "ARMED (STORED)" : "NOT ARMED";
  }
  if (els.execKillSwitchValue) {
    els.execKillSwitchValue.textContent = safety.killSwitchEnabled ? "ON — SUBMISSIONS BLOCKED" : "OFF — SUBMISSIONS ALLOWED";
  }
  if (els.execCoverageValue) {
    els.execCoverageValue.textContent = coverage.summary || "Strategy coverage unavailable.";
  }
  if (els.execNextActionValue) {
    els.execNextActionValue.textContent = priority.nextAction || "No next action available.";
  }
  if (els.execLastSkipValue) {
    els.execLastSkipValue.textContent = lastSkip?.reason ? `${lastSkip.reason} • ${fmtTime(lastSkip.ts)}` : "No recent skip";
  }
  if (els.executionHistoricalNote) {
    els.executionHistoricalNote.textContent =
      "Connected does not mean execution enabled. Activity rows below stay historical and reflect the gate state that existed when each alert was evaluated.";
  }
  if (els.activityContext) {
    els.activityContext.textContent =
      "Recent activity is historical. Current connection and readiness above may differ from the skip reason recorded when a row was created.";
  }
}

function resetAccountSnapshot(emptyText) {
  if (els.kpiEquity) els.kpiEquity.textContent = "—";
  if (els.kpiCash) els.kpiCash.textContent = "—";
  if (els.kpiBuyingPower) els.kpiBuyingPower.textContent = "—";
  if (els.kpiOpenPositions) els.kpiOpenPositions.textContent = "—";
  if (els.kpiOpenOrders) els.kpiOpenOrders.textContent = "—";
  if (els.kpiProvider) els.kpiProvider.textContent = "—";
  if (els.positionsEmpty) {
    els.positionsEmpty.textContent = emptyText;
    els.positionsEmpty.style.display = "block";
  }
  if (els.ordersEmpty) {
    els.ordersEmpty.textContent = emptyText;
    els.ordersEmpty.style.display = "block";
  }
  resetAccountChart("Current snapshot data is unavailable, so the chart is waiting on a successful broker status response.");
}

function buildListRow({ title, meta, value, detail, rightNode }) {
  const row = document.createElement("div");
  row.className = "broker-list-row";

  const main = document.createElement("div");
  main.className = "broker-list-main";

  const titleEl = document.createElement("strong");
  titleEl.textContent = title;
  const metaEl = document.createElement("span");
  metaEl.textContent = meta;
  main.appendChild(titleEl);
  main.appendChild(metaEl);

  const side = document.createElement("div");
  side.className = "broker-list-side";
  if (rightNode) {
    side.appendChild(rightNode);
  } else {
    const valueEl = document.createElement("strong");
    valueEl.textContent = value;
    const detailEl = document.createElement("span");
    detailEl.textContent = detail;
    side.appendChild(valueEl);
    side.appendChild(detailEl);
  }

  row.appendChild(main);
  row.appendChild(side);
  return row;
}

function buildPill(text, tone) {
  const pill = document.createElement("span");
  pill.className = badgeToneClasses("broker-pill", tone || "subtle");
  pill.textContent = text;
  return pill;
}

function activityTone(status) {
  const s = String(status || "").toUpperCase();
  if (s === "SUBMITTED") return "ok";
  if (s === "SKIPPED") return "warn";
  if (s === "REJECTED" || s === "ERROR") return "bad";
  return "subtle";
}

function activityRow(item) {
  const right = document.createElement("div");
  right.className = "broker-activity-side";

  right.appendChild(buildPill(String(item.status || "—").toUpperCase(), activityTone(item.status)));

  const meta = document.createElement("div");
  meta.className = "broker-activity-pills";
  meta.appendChild(buildPill(String(item.mode || "—").toUpperCase(), "subtle"));
  meta.appendChild(
    buildPill(
      item.notional != null ? fmtMoney(item.notional) : item.qty != null ? `Qty ${fmtNum(item.qty)}` : "—",
      "subtle"
    )
  );
  right.appendChild(meta);

  return buildListRow({
    title: `${item.symbol || "—"} ${item.direction || ""}`.trim(),
    meta: `${fmtTime(item.ts)} • ${item.reason || item.brokerStatus || "No additional detail"}${
      item.strategyVersion != null ? ` • Strategy v${item.strategyVersion}` : ""
    }`,
    rightNode: right,
  });
}

function renderMainStatus(status, state) {
  const connection = getConnectionState(status);

  setPill(els.statusProviderPill, `Provider ${providerLabel(status)}`, CURRENT_CFG?.brokerKey ? "subtle" : "warn");
  setPill(els.statusConnectionPill, connection?.label || state?.badgeText || "Status —", state?.tone || "subtle");
}

function renderBlockingAlert(status, activity) {
  if (!els.blockingAlert || !els.blockingAlertText) return;
  const issue = getPrimaryIssue(status, activity);

  if (issue.tone === "ok") {
    els.blockingAlert.style.display = "none";
    els.blockingAlert.className = "broker-compact-alert";
    els.blockingAlertText.textContent = "";
    return;
  }

  els.blockingAlert.style.display = "flex";
  els.blockingAlert.className = badgeToneClasses("broker-compact-alert", issue.tone);
  els.blockingAlertText.textContent = issue.body;
}

function syncMainControls() {
  const executionEnabled = Boolean(els.tradingEnabled?.checked);
  const mode = String(els.modeSelect?.value || CURRENT_CFG?.mode || "disabled");

  if (els.toggleExecutionBtn) {
    els.toggleExecutionBtn.textContent = executionEnabled ? "ON" : "OFF";
    els.toggleExecutionBtn.className = `btn broker-toggle-btn ${executionEnabled ? "is-on" : "is-off"}`;
  }

  if (els.modePaperBtn) {
    els.modePaperBtn.className = `btn broker-segment-btn ${mode === "paper" ? "is-active-paper" : ""}`.trim();
  }
  if (els.modeLiveBtn) {
    els.modeLiveBtn.className = `btn broker-segment-btn ${mode === "live" ? "is-active-live" : ""}`.trim();
  }
}

function accordionItems() {
  return Array.from(document.querySelectorAll(".broker-accordion"));
}

function setAccordionItemOpen(target, open) {
  const item =
    typeof target === "string" ? document.querySelector(`[data-accordion-item="${target}"]`) : target;
  if (!item) return;
  item.classList.toggle("is-open", open);
  const toggle = item.querySelector(".broker-accordion-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function resetAccordionState(status) {
  accordionItems().forEach((item) => setAccordionItemOpen(item, false));
  if (!status) return;

  const connection = getConnectionState(status);
  const safety = getGlobalSafety(status);
  const execution = getExecutionState(status);
  const coverage = getStrategyCoverage(status);

  if (!CURRENT_CFG?.brokerKey) {
    setAccordionItemOpen("connection_settings", true);
    return;
  }

  if (connection.code !== "connected") {
    setAccordionItemOpen("connection_details", true);
    if (connection.code === "unauthorized" || connection.code === "disconnected") {
      setAccordionItemOpen("connection_settings", true);
    }
  }

  if (safety.killSwitchEnabled || (modeValue(status) === "live" && !safety.liveArmed)) {
    setAccordionItemOpen("global_safety", true);
  }

  if (coverage.readyStrategies <= 0 || execution.code === "blocked_other") {
    setAccordionItemOpen("execution_diagnostics", true);
  }
}

function setModalOpen(open) {
  if (!els.settingsModal) return;
  if (open) resetAccordionState(LAST_STATUS);
  els.settingsModal.hidden = !open;
  els.settingsModal.classList.toggle("is-open", open);
  document.body.style.overflow = open ? "hidden" : "";
}

function applyConfigToUi(cfg) {
  CURRENT_CFG = cfg;
  if (els.brokerSelect) els.brokerSelect.value = cfg?.brokerKey || "";
  if (els.modeSelect) els.modeSelect.value = cfg?.mode || "disabled";
  fillExecutionControls(cfg);
  renderFields();
  syncMainControls();
}

async function loadBrokers() {
  const data = await api("/api/brokers");
  BROKERS = Array.isArray(data.brokers) ? data.brokers : [];
  if (!els.brokerSelect) return;

  els.brokerSelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "Disabled";
  els.brokerSelect.appendChild(empty);

  for (const broker of BROKERS) {
    const option = document.createElement("option");
    option.value = broker.key;
    option.textContent = broker.name;
    els.brokerSelect.appendChild(option);
  }
}

async function loadConfig() {
  const data = await api("/api/broker-config");
  const cfg = data.config || data.brokerConfig || {
    brokerKey: "",
    mode: "disabled",
    config: {},
    tradingEnabled: false,
    execution: {},
  };
  applyConfigToUi(cfg);
}

async function saveCurrentForm(successText = "Saved") {
  const payload = buildConfigFromForm();
  await api("/api/broker-config", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  showSavePill(successText, "ok");
  await loadConfig();
  await refreshStatus();
  await refreshActivity();
}

async function handleSave(successText) {
  try {
    await saveCurrentForm(successText);
  } catch (error) {
    try {
      await loadConfig();
      await refreshStatus();
      await refreshActivity();
    } catch {}
    showSavePill(error.message || "Save failed", "bad");
  }
}

async function refreshStatus() {
  clearLists();

  let status = null;
  try {
    status = await api("/api/broker/status");
  } catch (error) {
    const safety = getGlobalSafety(LAST_STATUS);
    status = {
      ok: false,
      provider: CURRENT_CFG?.brokerKey || "none",
      mode: CURRENT_CFG?.mode || "disabled",
      configured: Boolean(CURRENT_CFG?.brokerKey),
      connectionStatus: "disconnected",
      connectionState: {
        code: "disconnected",
        label: "Disconnected",
        reason: error.message || "Status error",
      },
      statusText: error.message || "Status error",
      checkedAt: Date.now(),
      lastSuccessfulCheckTs: LAST_STATUS?.lastSuccessfulCheckTs || null,
      duplicateProtection: LAST_STATUS?.duplicateProtection || { active: true },
      positions: [],
      orders: [],
      account: null,
      execution: CURRENT_CFG?.execution || null,
      globalSafety: safety,
      executionState: getExecutionState({
        statusText: error.message || "Status error",
        globalSafety: safety,
      }),
      strategyCoverage: getStrategyCoverage(LAST_STATUS),
      recentActivity: LAST_STATUS?.recentActivity || [],
    };
  }

  LAST_STATUS = status;
  const state = describeStatus(status);
  setConnDetails(status, state);
  setConnectionAlert(state);
  renderMainStatus(status, state);
  renderBlockingAlert(status, status?.recentActivity);
  setAccountBadges(status, state);
  renderExecutionReadiness(status, status?.recentActivity);

  if (!status?.ok || status.account == null) {
    resetAccountSnapshot(state.emptyText);
    return;
  }

  if (els.kpiEquity) els.kpiEquity.textContent = fmtMoney(status.account?.equity);
  if (els.kpiCash) els.kpiCash.textContent = fmtMoney(status.account?.cash);
  if (els.kpiBuyingPower) els.kpiBuyingPower.textContent = fmtMoney(status.account?.buyingPower);
  if (els.kpiOpenPositions) els.kpiOpenPositions.textContent = fmtNum((status.positions || []).length);
  if (els.kpiOpenOrders) els.kpiOpenOrders.textContent = fmtNum((status.orders || []).length);
  if (els.kpiProvider) els.kpiProvider.textContent = providerLabel(status);
  renderAccountChart(status);

  const positions = Array.isArray(status.positions) ? status.positions : [];
  if (!positions.length) {
    if (els.positionsEmpty) {
      els.positionsEmpty.textContent = "No open positions.";
      els.positionsEmpty.style.display = "block";
    }
  } else {
    positions.slice(0, 12).forEach((item) => {
      els.positionsList?.appendChild(
        buildListRow({
          title: item.symbol || "—",
          meta: `Qty ${fmtNum(item.qty)} • Avg ${fmtMoney(item.avgEntryPrice)}`,
          value: fmtMoney(item.marketValue),
          detail: `${String(item.side || "—").toUpperCase()} • ${
            item.unrealizedPlPct != null ? `${(item.unrealizedPlPct * 100).toFixed(2)}%` : "—"
          }`,
        })
      );
    });
  }

  const orders = Array.isArray(status.orders) ? status.orders : [];
  if (!orders.length) {
    if (els.ordersEmpty) {
      els.ordersEmpty.textContent = "No open orders.";
      els.ordersEmpty.style.display = "block";
    }
  } else {
    orders.slice(0, 12).forEach((item) => {
      const submittedText = item.submittedAt ? ` • ${new Date(item.submittedAt).toLocaleString()}` : "";
      els.ordersList?.appendChild(
        buildListRow({
          title: item.symbol || "—",
          meta: `${String(item.side || "").toUpperCase()} • ${String(item.type || "").toUpperCase()}`,
          value: item.notional != null ? fmtMoney(item.notional) : `Qty ${fmtNum(item.qty)}`,
          detail: `${item.status || "—"}${submittedText}`,
        })
      );
    });
  }
}

async function refreshActivity() {
  if (!els.activityList || !els.activityEmpty) return;

  try {
    const data = await api("/api/broker/activity?limit=20");
    const activity = Array.isArray(data.activity) ? data.activity : [];
    els.activityList.innerHTML = "";

    if (!activity.length) {
      els.activityEmpty.textContent = "No recent broker activity.";
      els.activityEmpty.style.display = "block";
      if (LAST_STATUS) {
        renderExecutionReadiness(LAST_STATUS, []);
        renderBlockingAlert(LAST_STATUS, []);
      }
      return;
    }

    els.activityEmpty.style.display = "none";
    activity.forEach((item) => els.activityList.appendChild(activityRow(item)));
    if (LAST_STATUS) {
      LAST_STATUS.recentActivity = activity;
      renderExecutionReadiness(LAST_STATUS, activity);
      renderBlockingAlert(LAST_STATUS, activity);
    }
  } catch {
    els.activityList.innerHTML = "";
    els.activityEmpty.textContent = "Broker activity could not be loaded.";
    els.activityEmpty.style.display = "block";
    if (LAST_STATUS) {
      renderExecutionReadiness(LAST_STATUS, LAST_STATUS?.recentActivity || []);
      renderBlockingAlert(LAST_STATUS, LAST_STATUS?.recentActivity || []);
    }
  }
}

function wireEvents() {
  els.brokerSelect?.addEventListener("change", renderFields);

  els.openSettingsBtn?.addEventListener("click", () => setModalOpen(true));
  els.closeSettingsBtn?.addEventListener("click", () => setModalOpen(false));
  els.settingsBackdrop?.addEventListener("click", () => setModalOpen(false));

  document.querySelectorAll(".broker-accordion-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const item = toggle.closest(".broker-accordion");
      if (!item) return;
      setAccordionItemOpen(item, !item.classList.contains("is-open"));
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.settingsModal?.classList.contains("is-open")) {
      setModalOpen(false);
    }
  });

  els.saveCfg?.addEventListener("click", () => handleSave("Connection Saved"));
  els.saveSafety?.addEventListener("click", () => handleSave("Safety Saved"));

  els.toggleExecutionBtn?.addEventListener("click", async () => {
    if (els.tradingEnabled) els.tradingEnabled.checked = !els.tradingEnabled.checked;
    syncMainControls();
    await handleSave(els.tradingEnabled?.checked ? "Execution Enabled" : "Execution Disabled");
  });

  els.modePaperBtn?.addEventListener("click", async () => {
    if (els.modeSelect) els.modeSelect.value = "paper";
    if (els.liveArmed) els.liveArmed.checked = false;
    syncMainControls();
    await handleSave("Mode Set To Paper");
  });

  els.modeLiveBtn?.addEventListener("click", async () => {
    if (els.modeSelect) els.modeSelect.value = "live";
    syncMainControls();
    await handleSave("Mode Set To Live");
  });

  els.revertPaperBtn?.addEventListener("click", async () => {
    if (els.modeSelect) els.modeSelect.value = "paper";
    if (els.liveArmed) els.liveArmed.checked = false;
    syncMainControls();
    await handleSave("Reverted To Paper");
  });

  els.refreshBtn?.addEventListener("click", async () => {
    try {
      await loadConfig();
      await refreshStatus();
      await refreshActivity();
      showSavePill("Status Refreshed", "ok");
    } catch (error) {
      showSavePill(error.message || "Refresh failed", "bad");
    }
  });
}

(async function init() {
  try {
    wireEvents();
    await loadBrokers();
    await loadConfig();
    await refreshStatus();
    await refreshActivity();
    window.setInterval(() => {
      refreshStatus();
      refreshActivity();
    }, 10000);
  } catch (error) {
    renderBlockingAlert(
      {
        connectionStatus: "disconnected",
        connectionState: { code: "disconnected", label: "Disconnected", reason: error.message || "Init error" },
        statusText: error.message || "Init error",
      },
      []
    );
    showSavePill(error.message || "Init error", "bad");
  }
})();
