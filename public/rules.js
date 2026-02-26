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
  const exitOnBiasFlip = $("exitOnBiasFlip");

  // NEW: ORB fields
  const orbFields = $("orbFields");
  const orbRangeMin = $("orbRangeMin");
  const orbEntryMode = $("orbEntryMode");
  const orbTolerancePct = $("orbTolerancePct");

  // NEW: trailing controls
  const moveBeEnabled = $("moveBeEnabled");
  const trailEnabled = $("trailEnabled");
  const moveBeFields = $("moveBeFields");
  const trailFields = $("trailFields");
  const moveBeAtR = $("moveBeAtR");
  const trailStartR = $("trailStartR");
  const trailByR = $("trailByR");

  // State
  let activeRules = null;
  let lastLoadedVersion = null; // for “you’re editing vX” context only

  // Defaults (safe)
  const DEFAULT_RULES = {
    timeframeMin: 1,
    scanSession: "RTH",
    scanUniverse: "WATCHLIST",
    premarketEnabled: false,
    marketBiasRequired: true,

    retestTolerancePct: 0.15,
    rsWindowBars5m: 24,
    structureWindow: 100,

    sectorAlignmentEnabled: true,
    triggerType: "BREAK_RETEST",

    // Bias scale (stored; can be used later)
    longMinBiasScore: 60,
    shortMaxBiasScore: 40,

    indicators: {
      vwap: true,
      movingAverages: false,
      relativeStrength: true,
      volume: false
    },

    // ORB stored config
    orb: {
      rangeMin: 15,
      entryMode: "BREAK_RETEST",
      tolerancePct: 0.15
    },

    post: {
      targetR: 2,
      stopR: 1,
      maxHoldBars: 60,
      exitOnBiasFlip: false,

      // NEW: trailing controls
      moveBeEnabled: false,
      moveBeAtR: 1,

      trailEnabled: false,
      trailStartR: 1,
      trailByR: 1
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

  function clamp(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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
      hour12: false
    }).format(d);
  }

  // ---------- conditional UI ----------
  function applyConditionalUI() {
    const trig = String(triggerType?.value || DEFAULT_RULES.triggerType);

    if (orbFields) orbFields.style.display = trig === "ORB" ? "block" : "none";

    const mbe = Boolean(moveBeEnabled?.checked);
    const trl = Boolean(trailEnabled?.checked);
    if (moveBeFields) moveBeFields.style.display = mbe ? "block" : "none";
    if (trailFields) trailFields.style.display = trl ? "block" : "none";
  }

  // ---------- form IO ----------
  function fill(cfg) {
    const c = cfg || DEFAULT_RULES;

    if (timeframeMin) timeframeMin.value = String(c.timeframeMin ?? DEFAULT_RULES.timeframeMin);
    if (scanSession) scanSession.value = String(c.scanSession ?? DEFAULT_RULES.scanSession);
    if (scanUniverse) scanUniverse.value = String(c.scanUniverse ?? DEFAULT_RULES.scanUniverse);

    // force sane default: if UI no longer offers PREMARKET, normalize
    const sess = String(c.scanSession ?? DEFAULT_RULES.scanSession);
    if (scanSession && sess === "PREMARKET") scanSession.value = "ALL";

    if (premarketEnabled) premarketEnabled.value = String(Boolean(c.premarketEnabled ?? DEFAULT_RULES.premarketEnabled));
    if (marketBiasRequired) marketBiasRequired.value = String(Boolean(c.marketBiasRequired ?? DEFAULT_RULES.marketBiasRequired));

    if (retestTolerancePct) retestTolerancePct.value = String(c.retestTolerancePct ?? DEFAULT_RULES.retestTolerancePct);
    if (rsWindowBars5m) rsWindowBars5m.value = String(c.rsWindowBars5m ?? DEFAULT_RULES.rsWindowBars5m);
    if (structureWindow) structureWindow.value = String(c.structureWindow ?? DEFAULT_RULES.structureWindow);

    if (sectorAlignmentEnabled) sectorAlignmentEnabled.value = String(Boolean(c.sectorAlignmentEnabled ?? DEFAULT_RULES.sectorAlignmentEnabled));
    if (triggerType) triggerType.value = String(c.triggerType ?? DEFAULT_RULES.triggerType);

    // bias clamp
    if (longMinBiasScore) longMinBiasScore.value = String(clamp(c.longMinBiasScore ?? DEFAULT_RULES.longMinBiasScore, 0, 100));
    if (shortMaxBiasScore) shortMaxBiasScore.value = String(clamp(c.shortMaxBiasScore ?? DEFAULT_RULES.shortMaxBiasScore, 0, 100));

    const inds = c.indicators || DEFAULT_RULES.indicators;
    if (indVwap) indVwap.checked = Boolean(inds.vwap);
    if (indMa) indMa.checked = Boolean(inds.movingAverages);
    if (indRs) indRs.checked = Boolean(inds.relativeStrength);
    if (indVol) indVol.checked = Boolean(inds.volume);

    // ORB
    const orb = c.orb || DEFAULT_RULES.orb;
    if (orbRangeMin) orbRangeMin.value = String(asNum(orb.rangeMin, DEFAULT_RULES.orb.rangeMin));
    if (orbEntryMode) orbEntryMode.value = String(orb.entryMode || DEFAULT_RULES.orb.entryMode);
    if (orbTolerancePct) orbTolerancePct.value = String(asNum(orb.tolerancePct, DEFAULT_RULES.orb.tolerancePct));

    const post = c.post || DEFAULT_RULES.post;
    if (targetR) targetR.value = String(post.targetR ?? DEFAULT_RULES.post.targetR);
    if (stopR) stopR.value = String(post.stopR ?? DEFAULT_RULES.post.stopR);
    if (maxHoldBars) maxHoldBars.value = String(post.maxHoldBars ?? DEFAULT_RULES.post.maxHoldBars);
    if (exitOnBiasFlip) exitOnBiasFlip.value = String(Boolean(post.exitOnBiasFlip ?? DEFAULT_RULES.post.exitOnBiasFlip));

    // trailing controls
    if (moveBeEnabled) moveBeEnabled.checked = Boolean(post.moveBeEnabled);
    if (trailEnabled) trailEnabled.checked = Boolean(post.trailEnabled);

    if (moveBeAtR) moveBeAtR.value = String(asNum(post.moveBeAtR, DEFAULT_RULES.post.moveBeAtR));
    if (trailStartR) trailStartR.value = String(asNum(post.trailStartR, DEFAULT_RULES.post.trailStartR));
    if (trailByR) trailByR.value = String(asNum(post.trailByR, DEFAULT_RULES.post.trailByR));

    applyConditionalUI();
  }

  function readForm() {
    const trig = String(triggerType?.value || DEFAULT_RULES.triggerType);

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
      triggerType: trig,

      longMinBiasScore: clamp(asNum(longMinBiasScore?.value, DEFAULT_RULES.longMinBiasScore), 0, 100),
      shortMaxBiasScore: clamp(asNum(shortMaxBiasScore?.value, DEFAULT_RULES.shortMaxBiasScore), 0, 100),

      indicators: {
        vwap: Boolean(indVwap?.checked),
        movingAverages: Boolean(indMa?.checked),
        relativeStrength: Boolean(indRs?.checked),
        volume: Boolean(indVol?.checked)
      },

      orb: {
        rangeMin: asNum(orbRangeMin?.value, DEFAULT_RULES.orb.rangeMin),
        entryMode: String(orbEntryMode?.value || DEFAULT_RULES.orb.entryMode),
        tolerancePct: asNum(orbTolerancePct?.value, DEFAULT_RULES.orb.tolerancePct)
      },

      post: {
        targetR: asNum(targetR?.value, DEFAULT_RULES.post.targetR),
        stopR: asNum(stopR?.value, DEFAULT_RULES.post.stopR),
        maxHoldBars: asNum(maxHoldBars?.value, DEFAULT_RULES.post.maxHoldBars),
        exitOnBiasFlip: asBool(exitOnBiasFlip?.value ?? DEFAULT_RULES.post.exitOnBiasFlip),

        moveBeEnabled: Boolean(moveBeEnabled?.checked),
        moveBeAtR: asNum(moveBeAtR?.value, DEFAULT_RULES.post.moveBeAtR),

        trailEnabled: Boolean(trailEnabled?.checked),
        trailStartR: asNum(trailStartR?.value, DEFAULT_RULES.post.trailStartR),
        trailByR: asNum(trailByR?.value, DEFAULT_RULES.post.trailByR)
      }
    };
  }

  // ---------- strategies modal (View) ----------
  function ensureModal() {
    let wrap = document.getElementById("rsModalWrap");
    if (wrap) return wrap;

    wrap = document.createElement("div");
    wrap.id = "rsModalWrap";
    wrap.style.position = "fixed";
    wrap.style.inset = "0";
    wrap.style.background = "rgba(0,0,0,0.35)";
    wrap.style.display = "none";
    wrap.style.alignItems = "center";
    wrap.style.justifyContent = "center";
    wrap.style.zIndex = "9999";
    wrap.innerHTML = `
      <div class="card" style="width:min(860px, calc(100vw - 40px)); max-height: calc(100vh - 40px); overflow:auto;">
        <div class="card-head">
          <div style="min-width:0;">
            <div class="card-title" id="rsModalTitle">Strategy</div>
            <div class="small muted" id="rsModalSub"></div>
          </div>
          <div class="card-actions">
            <button class="btn" id="rsModalClose">Close</button>
          </div>
        </div>
        <div style="padding:14px;">
          <div class="small muted" style="margin-bottom:6px;">Summary</div>
          <div id="rsModalSummary" class="small" style="margin-bottom:14px;"></div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px;">
            <button class="btn" id="rsModalEdit">Edit (Load into form)</button>
            <button class="btn" id="rsModalToggle">Enable</button>
          </div>

          <div class="small muted" style="margin-bottom:6px;">Recent backtests</div>
          <div id="rsModalBacktests" class="small"></div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);

    const closeBtn = document.getElementById("rsModalClose");
    closeBtn.addEventListener("click", () => {
      wrap.style.display = "none";
    });

    wrap.addEventListener("click", (ev) => {
      if (ev.target === wrap) wrap.style.display = "none";
    });

    return wrap;
  }

  function summarizeConfig(cfg) {
    const c = cfg || {};
    const trig = String(c.triggerType || "—");

    const inds = c.indicators || {};
    const enabledInds = [];
    if (inds.vwap) enabledInds.push("VWAP");
    if (inds.movingAverages) enabledInds.push("MAs");
    if (inds.relativeStrength) enabledInds.push("RS");
    if (inds.volume) enabledInds.push("Volume");

    const parts = [];
    parts.push(`Trigger: <b>${escapeHtml(trig)}</b>`);
    parts.push(`Timeframe: <b>${escapeHtml(String(c.timeframeMin || "—"))}m</b>`);
    parts.push(`Session: <b>${escapeHtml(String(c.scanSession || "—"))}</b>`);
    parts.push(`Universe: <b>${escapeHtml(String(c.scanUniverse || "—"))}</b>`);
    parts.push(`Retest tol: <b>${escapeHtml(String(c.retestTolerancePct ?? "—"))}%</b>`);
    parts.push(`Indicators: <b>${escapeHtml(enabledInds.join(", ") || "None")}</b>`);

    if (trig === "ORB") {
      const orb = c.orb || {};
      parts.push(`ORB range: <b>${escapeHtml(String(orb.rangeMin ?? "—"))}m</b>`);
      parts.push(`ORB entry: <b>${escapeHtml(String(orb.entryMode || "—"))}</b>`);
    }

    const post = c.post || {};
    if (post.moveBeEnabled) parts.push(`Move BE @ <b>${escapeHtml(String(post.moveBeAtR ?? "—"))}R</b>`);
    if (post.trailEnabled) parts.push(`Trail start <b>${escapeHtml(String(post.trailStartR ?? "—"))}R</b> by <b>${escapeHtml(String(post.trailByR ?? "—"))}R</b>`);

    return parts.join(" &nbsp;•&nbsp; ");
  }

  async function fetchRulesetByVersion(version) {
    // requires backend endpoint: GET /api/rulesets/:version
    const out = await jget(`/api/rulesets/${encodeURIComponent(version)}`);
    if (!out || !out.ok || !out.ruleset) throw new Error("ruleset fetch failed");
    return out.ruleset;
  }

  async function fetchRecentBacktests(strategyVersion, limit = 5) {
    // requires backend endpoint: GET /api/backtests?limit=..&strategyVersion=..
    const res = await jget(`/api/backtests?limit=${encodeURIComponent(limit)}&strategyVersion=${encodeURIComponent(strategyVersion)}`);
    const runs = Array.isArray(res?.runs) ? res.runs : [];
    return runs;
  }

  async function openViewModal(rsRow) {
    const version = Number(rsRow?.version);
    if (!Number.isFinite(version)) throw new Error("bad version");

    const wrap = ensureModal();
    wrap.style.display = "flex";

    const titleEl = document.getElementById("rsModalTitle");
    const subEl = document.getElementById("rsModalSub");
    const summaryEl = document.getElementById("rsModalSummary");
    const btEl = document.getElementById("rsModalBacktests");
    const editBtn = document.getElementById("rsModalEdit");
    const toggleBtn = document.getElementById("rsModalToggle");

    titleEl.textContent = rsRow?.name ? String(rsRow.name) : `Strategy v${version}`;
    subEl.textContent = `v${version}${rsRow?.created_ts ? ` • ${new Date(Number(rsRow.created_ts)).toLocaleString()}` : ""}`;

    // fetch full ruleset config
    let ruleset = null;
    try {
      ruleset = await fetchRulesetByVersion(version);
    } catch (e) {
      summaryEl.innerHTML = `<span class="small muted">View requires backend endpoint: GET /api/rulesets/:version</span>`;
      btEl.innerHTML = `<span class="small muted">Backtest snapshot requires: GET /api/backtests?strategyVersion=…</span>`;
      editBtn.disabled = true;
      toggleBtn.disabled = true;
      return;
    }

    const cfg = ruleset?.config || ruleset?.config_json || ruleset?.configJson || null;
    summaryEl.innerHTML = summarizeConfig(cfg);

    // recent backtests
    btEl.innerHTML = `<span class="small muted">Loading…</span>`;
    try {
      const runs = await fetchRecentBacktests(version, 5);
      const done = runs
        .filter((r) => String(r?.status || "").toUpperCase() === "DONE")
        .slice(0, 5);

      if (!done.length) {
        btEl.innerHTML = `<span class="small muted">No completed runs found for this strategy.</span>`;
      } else {
        btEl.innerHTML = done
          .map((r) => {
            const m = r?.metrics?.meta ? r.metrics : r?.metrics; // tolerate different shapes
            const total = m?.totalTrades ?? m?.metrics?.totalTrades ?? "—";
            const winRate = m?.winRate ?? m?.metrics?.winRate ?? null;
            const avgR = m?.avgR ?? m?.metrics?.avgR ?? null;
            const pf = m?.profitFactor ?? m?.metrics?.profitFactor ?? null;

            const wr = winRate != null ? `${(Number(winRate) * 100).toFixed(1)}%` : "—";
            const aR = avgR != null ? Number(avgR).toFixed(2) : "—";
            const pF = pf != null ? (Number.isFinite(Number(pf)) ? Number(pf).toFixed(2) : String(pf)) : "—";

            return `
              <div style="padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; margin-bottom:8px;">
                <div><b>Run</b> ${escapeHtml(String(r?.id || ""))}</div>
                <div class="small muted">Finished: ${escapeHtml(fmtTs(r?.finishedTs))}</div>
                <div class="small">Trades: <b>${escapeHtml(String(total))}</b> • Win: <b>${escapeHtml(wr)}</b> • AvgR: <b>${escapeHtml(aR)}</b> • PF: <b>${escapeHtml(pF)}</b></div>
              </div>
            `;
          })
          .join("");
      }
    } catch {
      btEl.innerHTML = `<span class="small muted">Backtest listing endpoint missing or failed.</span>`;
    }

    // edit = load into form
    editBtn.disabled = false;
    editBtn.onclick = () => {
      try {
        const cfgObj = cfg && typeof cfg === "object" ? cfg : DEFAULT_RULES;
        fill(cfgObj);
        strategyName.value = String(ruleset?.name || rsRow?.name || `Ruleset v${version}`);
        lastLoadedVersion = version;
        setStatus(`Loaded v${version} into editor. Make changes and click Save Rules to create a new version.`);
        wrap.style.display = "none";
      } catch (e) {
        setStatus(`Load failed: ${String(e?.message || e)}`);
      }
    };

    // toggle active
    const isActive = Boolean(rsRow?.active) || Boolean(ruleset?.active);
    toggleBtn.disabled = false;
    toggleBtn.textContent = isActive ? "Disable" : "Enable";
    toggleBtn.onclick = async () => {
      try {
        await toggleRuleset(version, !isActive);
        wrap.style.display = "none";
        await boot();
      } catch (e) {
        setStatus(String(e?.message || e));
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
      const isActive = Boolean(rs.active);

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
          ${isActive ? '<span class="pill pill-good">ENABLED</span>' : ""}
          <button class="btn" data-act="view" data-version="${escapeHtml(rs.version)}">View</button>
          <button class="btn" data-act="load" data-version="${escapeHtml(rs.version)}">Load</button>
          <button class="btn" data-act="toggle" data-version="${escapeHtml(rs.version)}" data-active="${isActive ? "1" : "0"}">
            ${isActive ? "Disable" : "Enable"}
          </button>
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

  async function loadRulesetIntoEditor(version) {
    const v = Number(version);
    if (!Number.isFinite(v)) throw new Error("bad version");

    const ruleset = await fetchRulesetByVersion(v);
    const cfg = ruleset?.config || null;

    if (!cfg) throw new Error("ruleset has no config");

    fill(cfg);
    strategyName.value = String(ruleset?.name || `Ruleset v${v}`);
    lastLoadedVersion = v;
    setStatus(`Loaded v${v} into editor. Edit and Save Rules to create a new version.`);
  }

  async function toggleRuleset(version, active) {
    // requires backend endpoint: POST /api/rules/toggle/:version
    await jpost(`/api/rules/toggle/${encodeURIComponent(version)}`, { active: Boolean(active), changedBy: "ui" });
  }

  // ---------- actions ----------
  async function onSaveRules() {
    try {
      setStatus("Saving…");
      const name = String(strategyName?.value || "Ruleset").trim() || "Ruleset";
      const config = readForm();
      await jpost("/api/rules", { name, config, changedBy: "ui" });
      setStatus("Saved. (New version created)");
      lastLoadedVersion = null;
      await boot();
    } catch (e) {
      setStatus(`Save failed: ${String(e?.message || e)}`);
    }
  }

  async function onNewStrategy() {
    strategyName.value = "";
    lastLoadedVersion = null;
    fill(DEFAULT_RULES);
    setStatus("New strategy draft loaded. Set a name, then Save Rules.");
  }

  // ---------- boot ----------
  async function boot() {
    try {
      setStatus("");

      // strategies list
      await refreshStrategies();

      // active rules (this endpoint may still return only one “active” ruleset)
      // we treat it as “default editor content” for now.
      const activeRes = await jget("/api/rules");
      const active = activeRes?.rules || null;

      activeRules = active;
      if (active?.config) {
        fill(active.config);
        strategyName.value = String(active?.name || "");
        lastLoadedVersion = Number(active?.version) || null;
      } else {
        fill(DEFAULT_RULES);
      }

      applyConditionalUI();
      setStatus("");
    } catch (e) {
      // Make this “premium”: actionable, not scary
      setStatus(`Rules page loaded with warnings: ${String(e?.message || e)}`);
    }
  }

  // ---------- init ----------
  function init() {
    if (saveRulesBtn) saveRulesBtn.addEventListener("click", onSaveRules);
    if (newStrategyBtn) newStrategyBtn.addEventListener("click", onNewStrategy);

    if (triggerType) triggerType.addEventListener("change", applyConditionalUI);
    if (moveBeEnabled) moveBeEnabled.addEventListener("change", applyConditionalUI);
    if (trailEnabled) trailEnabled.addEventListener("change", applyConditionalUI);

    if (strategiesList) {
      strategiesList.addEventListener("click", async (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest("button") : null;
        if (!btn) return;
        const act = String(btn.getAttribute("data-act") || "");
        const version = String(btn.getAttribute("data-version") || "");
        const active = String(btn.getAttribute("data-active") || "0") === "1";

        try {
          if (act === "view") {
            // pass row data for modal; version fetch fills details
            return await openViewModal({ version: Number(version), name: btn.closest("div")?.querySelector("div div")?.textContent || "", active });
          }
          if (act === "load") return await loadRulesetIntoEditor(version);
          if (act === "toggle") {
            await toggleRuleset(version, !active);
            await boot();
            return;
          }
        } catch (e) {
          setStatus(String(e?.message || e));
        }
      });
    }

    boot();
  }

  init();
})();