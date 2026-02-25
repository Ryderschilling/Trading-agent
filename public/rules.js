/* global fetch */

(() => {
  const $ = (id) => document.getElementById(id);

  // Elements
  const bootStatus = $("bootStatus");
  const strategiesList = $("strategiesList");
  const adminTokenInput = $("adminToken");

  const strategyName = $("strategyName");
  const saveRulesBtn = $("saveRulesBtn");
  const newStrategyBtn = $("newStrategyBtn");

  // Form fields
  const timeframeMin = $("timeframeMin");
  const scanSession = $("scanSession");
  const scanUniverse = $("scanUniverse");
  const premarketEnabled = $("premarketEnabled");
  const marketBiasRequired = $("marketBiasRequired");

  const retestTolerancePct = $("retestTolerancePct");
  const rsWindowBars5m = $("rsWindowBars5m");
  const structureWindow = $("structureWindow");

  const sectorAlignmentEnabled = $("sectorAlignmentEnabled");
  const triggerType = $("triggerType");
  const longMinBiasScore = $("longMinBiasScore");
  const shortMaxBiasScore = $("shortMaxBiasScore");

  const indVwap = $("indVwap");
  const indMa = $("indMa");
  const indRs = $("indRs");
  const indVol = $("indVol");

  const targetR = $("targetR");
  const stopR = $("stopR");
  const maxHoldBars = $("maxHoldBars");
  const trailStop = $("trailStop");
  const exitOnBiasFlip = $("exitOnBiasFlip");

  // State
  let activeRules = null;

  const DEFAULT_RULES = {
    timeframeMin: 1,
    scanSession: "RTH",
    scanUniverse: "WATCHLIST",
    premarketEnabled: true,
    marketBiasRequired: true,

    retestTolerancePct: 0.15,
    rsWindowBars5m: 24,
    structureWindow: 100,

    sectorAlignmentEnabled: true,
    triggerType: "BREAK_RETEST",
    longMinBiasScore: 60,
    shortMaxBiasScore: 40,

    indicators: {
      vwap: true,
      movingAverages: false,
      relativeStrength: true,
      volume: false
    },

    post: {
      targetR: 2,
      stopR: 1,
      maxHoldBars: 60,
      trailStop: "OFF",
      exitOnBiasFlip: false
    }
  };

  // ---------- helpers ----------
  function setStatus(msg) {
    if (bootStatus) bootStatus.textContent = msg || "";
  }

  function getAdminHeaders() {
    const tok = String(adminTokenInput?.value || "").trim();
    return tok ? { "x-admin-token": tok } : {};
  }

  async function jget(url) {
    const res = await fetch(url, { headers: { ...getAdminHeaders() } });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${url} ${res.status} ${txt}`.trim());
    }
    return res.json();
  }

  async function jpost(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getAdminHeaders()
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${url} ${res.status} ${txt}`.trim());
    }
    return res.json();
  }

  function asBool(v) {
    if (typeof v === "boolean") return v;
    const s = String(v).toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "on";
  }

  function asNum(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  // ---------- form IO ----------
  function fill(cfg) {
    const c = cfg || DEFAULT_RULES;

    if (timeframeMin) timeframeMin.value = String(c.timeframeMin ?? DEFAULT_RULES.timeframeMin);
    if (scanSession) scanSession.value = String(c.scanSession ?? DEFAULT_RULES.scanSession);
    if (scanUniverse) scanUniverse.value = String(c.scanUniverse ?? DEFAULT_RULES.scanUniverse);
    if (premarketEnabled) premarketEnabled.value = String(Boolean(c.premarketEnabled ?? DEFAULT_RULES.premarketEnabled));
    if (marketBiasRequired) marketBiasRequired.value = String(Boolean(c.marketBiasRequired ?? DEFAULT_RULES.marketBiasRequired));

    if (retestTolerancePct) retestTolerancePct.value = String(c.retestTolerancePct ?? DEFAULT_RULES.retestTolerancePct);
    if (rsWindowBars5m) rsWindowBars5m.value = String(c.rsWindowBars5m ?? DEFAULT_RULES.rsWindowBars5m);
    if (structureWindow) structureWindow.value = String(c.structureWindow ?? DEFAULT_RULES.structureWindow);

    if (sectorAlignmentEnabled) sectorAlignmentEnabled.value = String(Boolean(c.sectorAlignmentEnabled ?? DEFAULT_RULES.sectorAlignmentEnabled));
    if (triggerType) triggerType.value = String(c.triggerType ?? DEFAULT_RULES.triggerType);
    if (longMinBiasScore) longMinBiasScore.value = String(c.longMinBiasScore ?? DEFAULT_RULES.longMinBiasScore);
    if (shortMaxBiasScore) shortMaxBiasScore.value = String(c.shortMaxBiasScore ?? DEFAULT_RULES.shortMaxBiasScore);

    const inds = c.indicators || DEFAULT_RULES.indicators;
    if (indVwap) indVwap.checked = Boolean(inds.vwap);
    if (indMa) indMa.checked = Boolean(inds.movingAverages);
    if (indRs) indRs.checked = Boolean(inds.relativeStrength);
    if (indVol) indVol.checked = Boolean(inds.volume);

    const post = c.post || DEFAULT_RULES.post;
    if (targetR) targetR.value = String(post.targetR ?? DEFAULT_RULES.post.targetR);
    if (stopR) stopR.value = String(post.stopR ?? DEFAULT_RULES.post.stopR);
    if (maxHoldBars) maxHoldBars.value = String(post.maxHoldBars ?? DEFAULT_RULES.post.maxHoldBars);
    if (trailStop) trailStop.value = String(post.trailStop ?? DEFAULT_RULES.post.trailStop);
    if (exitOnBiasFlip) exitOnBiasFlip.value = String(Boolean(post.exitOnBiasFlip ?? DEFAULT_RULES.post.exitOnBiasFlip));
  }

  function readForm() {
    return {
      timeframeMin: asNum(timeframeMin?.value, DEFAULT_RULES.timeframeMin),
      scanSession: String(scanSession?.value || DEFAULT_RULES.scanSession),
      scanUniverse: String(scanUniverse?.value || DEFAULT_RULES.scanUniverse),
      premarketEnabled: asBool(premarketEnabled?.value ?? DEFAULT_RULES.premarketEnabled),
      marketBiasRequired: asBool(marketBiasRequired?.value ?? DEFAULT_RULES.marketBiasRequired),

      retestTolerancePct: asNum(retestTolerancePct?.value, DEFAULT_RULES.retestTolerancePct),
      rsWindowBars5m: asNum(rsWindowBars5m?.value, DEFAULT_RULES.rsWindowBars5m),
      structureWindow: asNum(structureWindow?.value, DEFAULT_RULES.structureWindow),

      sectorAlignmentEnabled: asBool(sectorAlignmentEnabled?.value ?? DEFAULT_RULES.sectorAlignmentEnabled),
      triggerType: String(triggerType?.value || DEFAULT_RULES.triggerType),
      longMinBiasScore: asNum(longMinBiasScore?.value, DEFAULT_RULES.longMinBiasScore),
      shortMaxBiasScore: asNum(shortMaxBiasScore?.value, DEFAULT_RULES.shortMaxBiasScore),

      indicators: {
        vwap: Boolean(indVwap?.checked),
        movingAverages: Boolean(indMa?.checked),
        relativeStrength: Boolean(indRs?.checked),
        volume: Boolean(indVol?.checked)
      },

      post: {
        targetR: asNum(targetR?.value, DEFAULT_RULES.post.targetR),
        stopR: asNum(stopR?.value, DEFAULT_RULES.post.stopR),
        maxHoldBars: asNum(maxHoldBars?.value, DEFAULT_RULES.post.maxHoldBars),
        trailStop: String(trailStop?.value || DEFAULT_RULES.post.trailStop),
        exitOnBiasFlip: asBool(exitOnBiasFlip?.value ?? DEFAULT_RULES.post.exitOnBiasFlip)
      }
    };
  }

  // ---------- strategies UI ----------
  function renderStrategies(list) {
    if (!strategiesList) return;
    strategiesList.innerHTML = "";

    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) {
      strategiesList.innerHTML = `<div class="small">No saved strategies yet.</div>`;
      return;
    }

    for (const rs of arr) {
      const isActive =
        (activeRules && Number(activeRules.activeVersion) === Number(rs.version)) ||
        Boolean(rs.active);

      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.justifyContent = "space-between";
      row.style.gap = "10px";
      row.style.padding = "8px 0";
      row.style.borderBottom = "1px solid rgba(0,0,0,0.08)";

      const created = rs.created_ts ? new Date(Number(rs.created_ts)).toLocaleString() : "";

      row.innerHTML = `
        <div style="min-width:0;">
          <div style="font-weight:700;">${escapeHtml(rs.name || "Ruleset")}</div>
          <div class="small" style="opacity:0.8;">v${escapeHtml(rs.version)}${created ? ` • ${escapeHtml(created)}` : ""}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          ${isActive ? '<span class="pill pill-good">ACTIVE</span>' : ""}
          <button class="btn" data-act="view" data-version="${escapeHtml(rs.version)}">View</button>
          <button class="btn" data-act="load" data-version="${escapeHtml(rs.version)}">Load</button>
          <button class="btn" data-act="activate" data-version="${escapeHtml(rs.version)}">Activate</button>
        </div>
      `;

      strategiesList.appendChild(row);
    }
  }

  async function refreshStrategies() {
    const rsRes = await jget("/api/rulesets");
    const rulesets = Array.isArray(rsRes?.rulesets) ? rsRes.rulesets : (Array.isArray(rsRes) ? rsRes : []);
    renderStrategies(rulesets);
  }

  async function loadRuleset(version) {
    // We don’t have a dedicated endpoint to fetch a ruleset by version;
    // MVP approach: “View” and “Load” are placeholders unless you add a fetch-by-version endpoint later.
    // For now, we just notify.
    setStatus(`Load/View is MVP-stub (needs ruleset fetch endpoint). Version: ${version}`);
  }

  async function activateRuleset(version) {
    await jpost(`/api/rules/activate/${encodeURIComponent(version)}`, { changedBy: "ui" });
    await boot(); // reload active + list
  }

  // ---------- actions ----------
  async function onSaveRules() {
    try {
      setStatus("Saving…");
      const name = String(strategyName?.value || "Ruleset").trim() || "Ruleset";
      const config = readForm();
      await jpost("/api/rules", { name, config, changedBy: "ui" });
      setStatus("Saved.");
      await boot();
    } catch (e) {
      setStatus(`Save failed: ${String(e?.message || e)}`);
    }
  }

  async function onNewStrategy() {
    // MVP: clear form and set a blank name; saving creates a new version in DB
    strategyName.value = "";
    fill(DEFAULT_RULES);
    setStatus("New strategy draft loaded. Set a name, then Save Rules.");
  }

  // ---------- boot ----------
  async function boot() {
    try {
      setStatus("");

      // 1) Strategies list
      const rsRes = await jget("/api/rulesets");
      const rulesets = Array.isArray(rsRes?.rulesets) ? rsRes.rulesets : (Array.isArray(rsRes) ? rsRes : []);
      renderStrategies(rulesets);

      // 2) Active rules
      const activeRes = await jget("/api/rules");
      const active = activeRes?.rules || null;

      activeRules = active;
      if (active?.config) {
        fill(active.config);
        strategyName.value = String(active?.name || "");
      } else {
        fill(DEFAULT_RULES);
      }

      setStatus("");
    } catch (e) {
      setStatus(`Boot failed: ${String(e?.message || e)}`);
    }
  }

  // ---------- init ----------
  function init() {
    if (saveRulesBtn) saveRulesBtn.addEventListener("click", onSaveRules);
    if (newStrategyBtn) newStrategyBtn.addEventListener("click", onNewStrategy);

    if (strategiesList) {
      strategiesList.addEventListener("click", async (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if (!btn) return;
        const act = String(btn.getAttribute("data-act") || "");
        const version = String(btn.getAttribute("data-version") || "");

        try {
          if (act === "view" || act === "load") return await loadRuleset(version);
          if (act === "activate") return await activateRuleset(version);
        } catch (e) {
          setStatus(String(e?.message || e));
        }
      });
    }

    boot();
  }

  init();
})();