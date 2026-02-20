async function jget(url) {
  const r = await fetch(url);
  return r.json();
}

async function jpost(url, body, token) {
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-admin-token": token } : {})
    },
    body: JSON.stringify(body)
  });
  return r.json();
}

function el(id) { return document.getElementById(id); }

function setStatus(msg) {
  el("status").textContent = msg;
}

function setBrokerStatus(msg) {
  el("brokerStatus").textContent = msg;
}

function fill(cfg) {
  el("timeframeMin").value = cfg.timeframeMin;
  el("retestTol").value = cfg.retestTolerancePct;
  el("rsWindow").value = cfg.rsWindowBars5m;
  el("premarketEnabled").value = String(cfg.premarketEnabled);
  el("sectorEnabled").value = String(cfg.sectorAlignmentEnabled);
  el("longMinBias").value = cfg.longMinBiasScore;
  el("shortMaxBias").value = cfg.shortMaxBiasScore;
}

function readCfg() {
  return {
    timeframeMin: Number(el("timeframeMin").value),
    retestTolerancePct: Number(el("retestTol").value),
    structureWindow: 3,
    rsWindowBars5m: Number(el("rsWindow").value),
    premarketEnabled: el("premarketEnabled").value === "true",
    longMinBiasScore: Number(el("longMinBias").value),
    shortMaxBiasScore: Number(el("shortMaxBias").value),
    sectorAlignmentEnabled: el("sectorEnabled").value === "true"
  };
}

function renderHistory(items) {
  const wrap = el("history");
  wrap.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.display = "flex";
    row.style.justifyContent = "space-between";
    row.style.alignItems = "center";
    row.style.gap = "10px";
    row.style.padding = "10px 12px";

    row.innerHTML = `
      <div>
        <div style="font-weight:700;">v${it.version} • ${it.name}</div>
        <div class="small">${new Date(it.created_ts).toISOString()} ${it.active ? "• ACTIVE" : ""}</div>
      </div>
      <button class="btn btn-ghost" data-activate="${it.version}">Activate</button>
    `;

    wrap.appendChild(row);
  }

  wrap.querySelectorAll("[data-activate]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const v = Number(btn.getAttribute("data-activate"));
      const token = el("adminToken").value.trim();
      const out = await jpost(`/api/rules/activate/${v}`, {}, token);
      setStatus(out.ok ? `Activated v${v}` : `Error: ${out.error || "failed"}`);
      await boot();
    });
  });
}

/**
 * -----------------------------
 * Broker UI
 * -----------------------------
 */
let BROKERS = [];
let BROKER_CFG = null;

function brokerByKey(key) {
  return BROKERS.find((b) => String(b.key) === String(key)) || null;
}

function renderBrokerSelect() {
  const sel = el("brokerKey");
  sel.innerHTML = "";

  for (const b of BROKERS) {
    const opt = document.createElement("option");
    opt.value = b.key;
    opt.textContent = `${b.name} (${b.key})`;
    sel.appendChild(opt);
  }
}

function getFieldValue(current, key) {
  if (!current || typeof current !== "object") return "";
  const v = current[key];
  return v == null ? "" : String(v);
}

function renderBrokerFields() {
  const key = el("brokerKey").value;
  const broker = brokerByKey(key);
  const wrap = el("brokerFields");
  wrap.innerHTML = "";

  if (!broker) {
    wrap.innerHTML = `<div class="small">No broker selected.</div>`;
    return;
  }

  const existingCfg = (BROKER_CFG && BROKER_CFG.brokerKey === key) ? (BROKER_CFG.config || {}) : {};
  const fields = Array.isArray(broker.fields) ? broker.fields : [];

  for (const f of fields) {
    const id = `bf_${f.key}`;
    const label = document.createElement("label");
    label.className = "small";
    label.innerHTML = `${f.label || f.key}`;

    let input;
    if (f.type === "select" && Array.isArray(f.options)) {
      input = document.createElement("select");
      input.className = "input";
      input.id = id;
      for (const opt of f.options) {
        const o = document.createElement("option");
        o.value = String(opt.value);
        o.textContent = String(opt.label ?? opt.value);
        input.appendChild(o);
      }
      input.value = getFieldValue(existingCfg, f.key) || (f.options[0] ? String(f.options[0].value) : "");
    } else {
      input = document.createElement("input");
      input.className = "input";
      input.id = id;

      const t = String(f.type || "text");
      input.type = f.secret ? "password" : (t === "number" ? "number" : "text");

      if (f.placeholder) input.placeholder = String(f.placeholder);
      input.value = getFieldValue(existingCfg, f.key);

      if (t === "number") {
        input.step = "1";
      }
    }

    label.appendChild(input);
    wrap.appendChild(label);
  }
}

function readBrokerConfigFromUI() {
  const brokerKey = el("brokerKey").value;
  const mode = el("brokerMode").value === "live" ? "live" : "paper";
  const broker = brokerByKey(brokerKey);
  const fields = Array.isArray(broker?.fields) ? broker.fields : [];

  const config = {};
  for (const f of fields) {
    const node = document.getElementById(`bf_${f.key}`);
    if (!node) continue;

    let v = node.value;
    if (String(f.type) === "number") v = Number(v);

    config[f.key] = v;
  }

  return { brokerKey, mode, config };
}

async function bootBrokerUI() {
  const b = await jget("/api/brokers");
  BROKERS = Array.isArray(b.brokers) ? b.brokers : [];
  renderBrokerSelect();

  const c = await jget("/api/broker-config");
  BROKER_CFG = c.brokerConfig || null;

  // set selects from saved config if available
  if (BROKER_CFG?.brokerKey) {
    el("brokerKey").value = BROKER_CFG.brokerKey;
  }
  if (BROKER_CFG?.mode) {
    el("brokerMode").value = BROKER_CFG.mode === "live" ? "live" : "paper";
  }

  renderBrokerFields();
  setBrokerStatus(BROKER_CFG ? "Loaded saved broker config." : "No broker config saved yet.");
}

/**
 * -----------------------------
 * Boot
 * -----------------------------
 */
async function boot() {
  const r = await jget("/api/rules");
  if (r?.rules?.config) fill(r.rules.config);

  const h = await jget("/api/rulesets");
  renderHistory(h.rulesets || []);

  await bootBrokerUI();
}

el("saveBtn").addEventListener("click", async () => {
  const name = el("rulesetName").value.trim() || "Ruleset";
  const token = el("adminToken").value.trim();
  const config = readCfg();

  const out = await jpost("/api/rules", { name, config, changedBy: "ui" }, token);
  setStatus(out.ok ? `Saved + activated v${out.result?.version}` : `Error: ${out.error || "failed"}`);
  await boot();
});

el("brokerKey").addEventListener("change", () => {
  renderBrokerFields();
});

el("saveBrokerBtn").addEventListener("click", async () => {
  try {
    const token = el("adminToken").value.trim();
    const payload = readBrokerConfigFromUI();
    const out = await jpost("/api/broker-config", { ...payload, changedBy: "ui" }, token);
    setBrokerStatus(out.ok ? "Saved broker config." : `Error: ${out.error || "failed"}`);

    // re-load from server to confirm persistence
    const c = await jget("/api/broker-config");
    BROKER_CFG = c.brokerConfig || null;
  } catch (e) {
    setBrokerStatus("Error: failed to save broker config.");
  }
});

boot().catch(() => setStatus("Failed to load rules."));