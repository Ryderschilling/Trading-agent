// Brokers page controller
// Keeps the same platform UX patterns: simple forms, clear status pill, card + list layout.

const $ = (id) => document.getElementById(id);

const els = {
  brokerSelect: $("brokerSelect"),
  modeSelect: $("modeSelect"),
  brokerFields: $("brokerFields"),
  saveCfg: $("saveCfg"),
  saveStatus: $("saveStatus"),

  tradingEnabled: $("tradingEnabled"),
  saveExec: $("saveExec"),

  refreshBtn: $("refreshBtn"),
  statusPill: $("brokerStatusPill"),

  kpiEquity: $("kpiEquity"),
  kpiCash: $("kpiCash"),
  kpiBuyingPower: $("kpiBuyingPower"),

  positionsList: $("positionsList"),
  ordersList: $("ordersList"),
  positionsEmpty: $("positionsEmpty"),
  ordersEmpty: $("ordersEmpty"),

  kvBroker: $("kvBroker"),
  kvMode: $("kvMode"),
  kvStatus: $("kvStatus"),
};

let BROKERS = [];
let CURRENT_CFG = null;

function showSavePill(text, kind) {
  els.saveStatus.style.display = "inline-flex";
  els.saveStatus.textContent = text;
  // kind: "ok" | "bad" | "neutral"
  if (kind === "ok") {
    els.saveStatus.style.borderColor = "#bfe6c3";
    els.saveStatus.style.background = "#eef9ef";
  } else if (kind === "bad") {
    els.saveStatus.style.borderColor = "#f0c2c2";
    els.saveStatus.style.background = "#fff1f1";
  } else {
    els.saveStatus.style.borderColor = "";
    els.saveStatus.style.background = "";
  }
  setTimeout(() => {
    els.saveStatus.style.display = "none";
  }, 2500);
}

function fmtMoney(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  try {
    return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function fmtNum(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function setStatusPill(text, ok) {
  els.statusPill.textContent = text;
  if (ok) {
    els.statusPill.style.borderColor = "#bfe6c3";
    els.statusPill.style.background = "#eef9ef";
  } else {
    els.statusPill.style.borderColor = "#f0c2c2";
    els.statusPill.style.background = "#fff1f1";
  }
}

function renderFields(desc, cfg) {
  els.brokerFields.innerHTML = "";
  if (!desc) return;

  const config = (cfg && cfg.config) || {};

  desc.fields.forEach((f) => {
    const row = document.createElement("div");
    row.className = "form-row";
    const label = document.createElement("label");
    label.textContent = f.label;

    const input = document.createElement("input");
    input.id = `bf_${f.key}`;
    input.type = f.type || (f.secret ? "password" : "text");
    input.placeholder = f.placeholder || "";
    input.value = config[f.key] != null ? String(config[f.key]) : "";
    if (f.type === "number") input.inputMode = "numeric";

    row.appendChild(label);
    row.appendChild(input);
    els.brokerFields.appendChild(row);
  });
}

function getSelectedBroker() {
  const key = String(els.brokerSelect.value || "");
  return BROKERS.find((b) => b.key === key) || null;
}

function buildCfgFromForm() {
  const desc = getSelectedBroker();
  const brokerKey = desc ? desc.key : "";
  const mode = String(els.modeSelect.value || "paper") === "live" ? "live" : "paper";

  const config = {};
  if (desc) {
    desc.fields.forEach((f) => {
      const el = $("bf_" + f.key);
      if (!el) return;
      let v = el.value;
      if (f.type === "number") {
        const n = Number(v);
        if (Number.isFinite(n)) v = n;
      }
      config[f.key] = v;
    });
  }

  return { brokerKey, mode, config };
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (json && json.error) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

function clearLists() {
  els.positionsList.innerHTML = "";
  els.ordersList.innerHTML = "";
  els.positionsEmpty.style.display = "none";
  els.ordersEmpty.style.display = "none";
}

function rowEl({ sym, metaLeft, rightTop, rightBottom, pnlClass }) {
  const row = document.createElement("div");
  row.className = "row";
  const left = document.createElement("div");
  left.className = "left";
  const s = document.createElement("div");
  s.className = "sym";
  s.textContent = sym;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = metaLeft;
  left.appendChild(s);
  left.appendChild(meta);

  const right = document.createElement("div");
  right.className = "right";
  const top = document.createElement("div");
  top.className = pnlClass ? `pnl ${pnlClass}` : "pnl";
  top.textContent = rightTop;
  const bottom = document.createElement("div");
  bottom.className = "small";
  bottom.textContent = rightBottom;
  right.appendChild(top);
  right.appendChild(bottom);

  row.appendChild(left);
  row.appendChild(right);
  return row;
}

function setConnDetails({ brokerKey, mode, statusText }) {
  els.kvBroker.textContent = brokerKey || "—";
  els.kvMode.textContent = mode || "—";
  els.kvStatus.textContent = statusText || "—";
}

async function loadBrokers() {
  const data = await api("/api/brokers");
  BROKERS = Array.isArray(data.brokers) ? data.brokers : [];

  els.brokerSelect.innerHTML = "";
  BROKERS.forEach((b) => {
    const opt = document.createElement("option");
    opt.value = b.key;
    opt.textContent = b.name;
    els.brokerSelect.appendChild(opt);
  });
}

async function loadCfg() {
  const data = await api("/api/broker-config");
  CURRENT_CFG = data.brokerConfig || null;

  const brokerKey = CURRENT_CFG?.brokerKey || (BROKERS[0] ? BROKERS[0].key : "");
  const mode = CURRENT_CFG?.mode || "paper";

  if (brokerKey) els.brokerSelect.value = brokerKey;
  els.modeSelect.value = mode;
  els.tradingEnabled.checked = Boolean(CURRENT_CFG?.tradingEnabled);

  const desc = getSelectedBroker();
  renderFields(desc, CURRENT_CFG);

  setConnDetails({ brokerKey, mode, statusText: "—" });
}

async function saveCfg() {
  const cfg = buildCfgFromForm();
  // Keep any existing tradingEnabled flag
  cfg.tradingEnabled = Boolean(CURRENT_CFG?.tradingEnabled);

  const out = await api("/api/broker-config", {
    method: "POST",
    body: JSON.stringify({ ...cfg, changedBy: "ui" }),
  });

  showSavePill("Saved", "ok");
  await loadCfg();
  await loadStatus();
  return out;
}

async function saveExecution() {
  const enabled = Boolean(els.tradingEnabled.checked);
  await api("/api/broker/trading-enabled", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  showSavePill(enabled ? "Execution ON" : "Execution OFF", enabled ? "bad" : "ok");
  await loadCfg();
  await loadStatus();
}

async function loadStatus() {
  clearLists();

  // Defaults
  els.kpiEquity.textContent = "—";
  els.kpiCash.textContent = "—";
  els.kpiBuyingPower.textContent = "—";

  try {
    const st = await api("/api/broker/status");
    if (!st || !st.ok) {
      const err = st?.error || "Not connected";
      setStatusPill(err, false);
      setConnDetails({ brokerKey: st?.brokerKey || CURRENT_CFG?.brokerKey, mode: st?.mode || CURRENT_CFG?.mode, statusText: err });
      return;
    }

    const brokerKey = st.brokerKey || CURRENT_CFG?.brokerKey || "—";
    const mode = st.mode || CURRENT_CFG?.mode || "—";

    setStatusPill("Connected", true);
    setConnDetails({ brokerKey, mode, statusText: String(st.account?.status || "OK") });

    // KPIs (Alpaca returns strings)
    els.kpiEquity.textContent = fmtMoney(st.account?.equity);
    els.kpiCash.textContent = fmtMoney(st.account?.cash);
    els.kpiBuyingPower.textContent = fmtMoney(st.account?.buying_power);

    // Positions
    const positions = Array.isArray(st.positions) ? st.positions : [];
    if (!positions.length) {
      els.positionsEmpty.style.display = "block";
    } else {
      positions
        .slice()
        .sort((a, b) => Math.abs(Number(b.market_value || 0)) - Math.abs(Number(a.market_value || 0)))
        .slice(0, 12)
        .forEach((p) => {
          const sym = String(p.symbol || p.asset_id || "—");
          const qty = fmtNum(p.qty);
          const avg = fmtMoney(p.avg_entry_price);
          const mv = fmtMoney(p.market_value);
          const pnl = Number(p.unrealized_pl || 0);
          const pnlPct = Number(p.unrealized_plpc || 0) * 100;

          els.positionsList.appendChild(
            rowEl({
              sym,
              metaLeft: `Qty ${qty} • Avg ${avg}`,
              rightTop: `${pnl >= 0 ? "+" : ""}${fmtMoney(pnl)}`,
              rightBottom: `${mv} • ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
            })
          );
        });
    }

    // Orders
    const orders = Array.isArray(st.orders) ? st.orders : [];
    if (!orders.length) {
      els.ordersEmpty.style.display = "block";
    } else {
      orders
        .slice(0, 12)
        .forEach((o) => {
          const sym = String(o.symbol || "—");
          const side = String(o.side || "").toUpperCase();
          const type = String(o.type || "").toUpperCase();
          const qty = fmtNum(o.qty);
          const price =
            o.limit_price != null ? fmtMoney(o.limit_price) :
            o.stop_price != null ? fmtMoney(o.stop_price) :
            "MKT";
          const status = String(o.status || "").toUpperCase();

          els.ordersList.appendChild(
            rowEl({
              sym,
              metaLeft: `${side} ${qty} • ${type}`,
              rightTop: price,
              rightBottom: status,
            })
          );
        });
    }
  } catch (e) {
    setStatusPill(e?.message || "Status error", false);
    setConnDetails({ brokerKey: CURRENT_CFG?.brokerKey, mode: CURRENT_CFG?.mode, statusText: e?.message || "error" });
  }
}

function wireEvents() {
  els.brokerSelect.addEventListener("change", () => {
    const desc = getSelectedBroker();
    renderFields(desc, CURRENT_CFG);
  });

  els.saveCfg.addEventListener("click", async () => {
    try {
      await saveCfg();
    } catch (e) {
      showSavePill(e?.message || "Save failed", "bad");
    }
  });

  els.saveExec.addEventListener("click", async () => {
    try {
      await saveExecution();
    } catch (e) {
      showSavePill(e?.message || "Toggle failed", "bad");
    }
  });

  els.refreshBtn.addEventListener("click", async () => {
    await loadCfg();
    await loadStatus();
  });
}

(async function init() {
  try {
    wireEvents();
    await loadBrokers();
    await loadCfg();
    await loadStatus();
  } catch (e) {
    setStatusPill(e?.message || "Init error", false);
  }
})();