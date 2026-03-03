/* global fetch */

let modalVersion = null;

(() => {
  const $ = (id) => document.getElementById(id);

  // Elements
  const strategiesList = $("strategiesList");

  const strategyName = $("strategyName");
  const saveRulesBtn = $("saveRulesBtn");

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
  const emaBlock = $("emaBlock");
  const emaPeriods = $("emaPeriods");
  const emaTrigger = $("emaTrigger");
  const indRs = $("indRs");
  const indVol = $("indVol");

  const targetR = $("targetR");
  const stopR = $("stopR");
  const maxHoldBars = $("maxHoldBars");
  const exitOnBiasFlip = $("exitOnBiasFlip");

  // ORB fields
  const orbFields = $("orbFields");
  const orbRangeMin = $("orbRangeMin");
  const orbEntryMode = $("orbEntryMode");
  const orbTolerancePct = $("orbTolerancePct");

  // trailing controls
  const moveBeEnabled = $("moveBeEnabled");
  const trailEnabled = $("trailEnabled");
  const moveBeFields = $("moveBeFields");
  const trailFields = $("trailFields");
  const moveBeAtR = $("moveBeAtR");
  const trailStartR = $("trailStartR");
  const trailByR = $("trailByR");

  // Section summaries
  const sumScan = $("sumScan");
  const sumTrigger = $("sumTrigger");
  const sumFilters = $("sumFilters");
  const sumIndicators = $("sumIndicators");
  const sumMgmt = $("sumMgmt");

  // State
  let lastLoadedVersion = null;

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

    longMinBiasScore: 60,
    shortMaxBiasScore: 40,

    indicators: {
      vwap: true,
      movingAverages: false,
      relativeStrength: true,
      volume: false
    },

    // MA config (top-level)
    emaPeriods: [],
    emaTrigger: "NONE",

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

      moveBeEnabled: false,
      moveBeAtR: 1,

      trailEnabled: false,
      trailStartR: 1,
      trailByR: 1
    }
  };

  // ---------- helpers ----------
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

  function parseEmaPeriods(s) {
    const out = String(s || "")
      .split(",")
      .map((x) => parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 500);

    return Array.from(new Set(out)).sort((a, b) => a - b).slice(0, 50);
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

  // ---------- admin headers (optional) ----------
  // If you later re-add an admin token input, it will work automatically if present.
  function getAdminHeaders() {
    const tok = String(document.getElementById("adminToken")?.value || "").trim();
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

  // ---------- conditional UI ----------
  function applyConditionalUI() {
    const trig = String(triggerType?.value || DEFAULT_RULES.triggerType);
    if (orbFields) orbFields.style.display = trig === "ORB" ? "block" : "none";

    const maOn = Boolean(indMa?.checked);
    if (emaBlock) emaBlock.style.display = maOn ? "block" : "none";

    const mbe = Boolean(moveBeEnabled?.checked);
    const trl = Boolean(trailEnabled?.checked);
    if (moveBeFields) moveBeFields.style.display = mbe ? "block" : "none";
    if (trailFields) trailFields.style.display = trl ? "block" : "none";
  }

  // ---------- summaries ----------
  function updateSummaries() {
    const tf = String(timeframeMin?.value || "—");
    const sess = String(scanSession?.value || "—");
    const uni = String(scanUniverse?.value || "—");
    const pm = String(premarketEnabled?.value || "false") === "true" ? "On" : "Off";
    const biasReq = String(marketBiasRequired?.value || "false") === "true" ? "On" : "Off";

    if (sumScan) {
      sumScan.textContent = `${tf}m • ${sess} • ${uni} • Premarket: ${pm} • Bias required: ${biasReq}`;
    }

    const trig = String(triggerType?.value || "—");
    if (sumTrigger) {
      if (trig === "ORB") {
        const r = String(orbRangeMin?.value || "—");
        const m = String(orbEntryMode?.value || "—");
        const t = String(orbTolerancePct?.value || "—");
        sumTrigger.textContent = `ORB • Range ${r}m • Mode ${m} • Tol ${t}%`;
      } else {
        sumTrigger.textContent = `Break & Retest`;
      }
    }

    const rt = String(retestTolerancePct?.value || "—");
    const rs = String(rsWindowBars5m?.value || "—");
    const sw = String(structureWindow?.value || "—");
    const sec = String(sectorAlignmentEnabled?.value || "false") === "true" ? "On" : "Off";
    const lb = String(longMinBiasScore?.value || "—");
    const sb = String(shortMaxBiasScore?.value || "—");

    if (sumFilters) {
      sumFilters.textContent = `Retest ${rt}% • RS ${rs} • Structure ${sw} • Sector align: ${sec} • Bias L≥${lb} / S≤${sb}`;
    }

    const inds = [];
    if (indVwap?.checked) inds.push("VWAP");
    if (indMa?.checked) inds.push("MAs");
    if (indRs?.checked) inds.push("RS");
    if (indVol?.checked) inds.push("Volume");

    if (sumIndicators) {
      if (!inds.length) sumIndicators.textContent = "None";
      else {
        const maExtra = indMa?.checked
          ? ` • EMA: ${String(emaPeriods?.value || "—")} • Trigger: ${String(emaTrigger?.value || "NONE")}`
          : "";
        sumIndicators.textContent = `${inds.join(", ")}${maExtra}`;
      }
    }

    const tr = String(targetR?.value || "—");
    const sr = String(stopR?.value || "—");
    const mh = String(maxHoldBars?.value || "—");
    const flip = String(exitOnBiasFlip?.value || "false") === "true" ? "On" : "Off";

    const mbe = Boolean(moveBeEnabled?.checked);
    const trl = Boolean(trailEnabled?.checked);

    const parts = [`${tr}R target`, `${sr}R stop`, `Max hold ${mh}`, `Bias flip: ${flip}`];
    if (mbe) parts.push(`Move BE @ ${String(moveBeAtR?.value || "—")}R`);
    if (trl) parts.push(`Trail start ${String(trailStartR?.value || "—")}R by ${String(trailByR?.value || "—")}R`);

    if (sumMgmt) sumMgmt.textContent = parts.join(" • ");
  }

  // ---------- form IO ----------
  function fill(cfg) {
    const c = cfg || DEFAULT_RULES;

    if (timeframeMin) timeframeMin.value = String(c.timeframeMin ?? DEFAULT_RULES.timeframeMin);

    const sess = String(c.scanSession ?? DEFAULT_RULES.scanSession);
    if (scanSession) scanSession.value = (sess === "PREMARKET") ? "ALL" : sess;

    if (scanUniverse) scanUniverse.value = String(c.scanUniverse ?? DEFAULT_RULES.scanUniverse);
    if (premarketEnabled) premarketEnabled.value = String(Boolean(c.premarketEnabled ?? DEFAULT_RULES.premarketEnabled));
    if (marketBiasRequired) marketBiasRequired.value = String(Boolean(c.marketBiasRequired ?? DEFAULT_RULES.marketBiasRequired));

    if (retestTolerancePct) retestTolerancePct.value = String(c.retestTolerancePct ?? DEFAULT_RULES.retestTolerancePct);
    if (rsWindowBars5m) rsWindowBars5m.value = String(c.rsWindowBars5m ?? DEFAULT_RULES.rsWindowBars5m);
    if (structureWindow) structureWindow.value = String(c.structureWindow ?? DEFAULT_RULES.structureWindow);

    if (sectorAlignmentEnabled) sectorAlignmentEnabled.value = String(Boolean(c.sectorAlignmentEnabled ?? DEFAULT_RULES.sectorAlignmentEnabled));
    if (triggerType) triggerType.value = String(c.triggerType ?? DEFAULT_RULES.triggerType);

    if (longMinBiasScore) longMinBiasScore.value = String(clamp(c.longMinBiasScore ?? DEFAULT_RULES.longMinBiasScore, 0, 100));
    if (shortMaxBiasScore) shortMaxBiasScore.value = String(clamp(c.shortMaxBiasScore ?? DEFAULT_RULES.shortMaxBiasScore, 0, 100));

    const inds = c.indicators || DEFAULT_RULES.indicators;
    if (indVwap) indVwap.checked = Boolean(inds.vwap);
    if (indMa) indMa.checked = Boolean(inds.movingAverages);
    if (indRs) indRs.checked = Boolean(inds.relativeStrength);
    if (indVol) indVol.checked = Boolean(inds.volume);

    // MA settings only meaningful if MA enabled
    if (emaPeriods) {
      const arr = Array.isArray(c.emaPeriods) ? c.emaPeriods : [];
      emaPeriods.value = arr.length ? arr.join(",") : "";
    }
    if (emaTrigger) emaTrigger.value = String(c.emaTrigger || "NONE");

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

    if (moveBeEnabled) moveBeEnabled.checked = Boolean(post.moveBeEnabled);
    if (trailEnabled) trailEnabled.checked = Boolean(post.trailEnabled);

    if (moveBeAtR) moveBeAtR.value = String(asNum(post.moveBeAtR, DEFAULT_RULES.post.moveBeAtR));
    if (trailStartR) trailStartR.value = String(asNum(post.trailStartR, DEFAULT_RULES.post.trailStartR));
    if (trailByR) trailByR.value = String(asNum(post.trailByR, DEFAULT_RULES.post.trailByR));

    applyConditionalUI();
    updateSummaries();
  }

  function readForm() {
    const trig = String(triggerType?.value || DEFAULT_RULES.triggerType);

    let tf = asNum(timeframeMin?.value, DEFAULT_RULES.timeframeMin);
    tf = Math.max(1, Math.floor(tf));

    let orbRange = asNum(orbRangeMin?.value, DEFAULT_RULES.orb.rangeMin);
    orbRange = Math.max(1, Math.floor(orbRange));

    // If ORB, force orb.rangeMin == timeframeMin so live/backtest can’t drift
    if (trig === "ORB") orbRange = tf;

    const maOn = Boolean(indMa?.checked);
    const emaArr = maOn ? parseEmaPeriods(emaPeriods?.value) : undefined;
    const emaTrig = maOn ? String(emaTrigger?.value || "NONE") : "NONE";

    const config = {
      timeframeMin: tf,
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
        movingAverages: maOn,
        relativeStrength: Boolean(indRs?.checked),
        volume: Boolean(indVol?.checked)
      },

      // ORB config always present (safe)
      orb: {
        rangeMin: orbRange,
        entryMode: String(orbEntryMode?.value || DEFAULT_RULES.orb.entryMode),
        tolerancePct: asNum(orbTolerancePct?.value, DEFAULT_RULES.orb.tolerancePct)
      },

      // post
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

// Only include emaPeriods/emaTrigger when MA is enabled.
// Backend throws if emaPeriods exists but is empty.
if (maOn) {
  const arr = Array.isArray(emaArr) ? emaArr : [];
  config.emaPeriods = arr.length ? arr : [9, 20, 50, 200]; // safe default to avoid "emaPeriods empty"
  config.emaTrigger = emaTrig || "NONE";
} else {
  // omit entirely
  delete config.emaPeriods;
  delete config.emaTrigger;
}

    return config;
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
    <div class="card rs-modal-card" style="width:min(980px, calc(100vw - 40px)); max-height: calc(100vh - 40px); overflow:auto;">
      <div class="card-head">
        <div style="min-width:0;">
          <div class="card-title" id="rsModalTitle">Strategy</div>
          <div class="small muted" id="rsModalSub"></div>
        </div>
        <div class="card-actions">
          <button class="btn" id="rsModalClose">Close</button>
        </div>
      </div>

      <div class="rs-modal-body" id="rsModalView">
        <div class="small muted" style="margin-bottom:8px;">Overview</div>
        <div id="rsModalOverview" class="rs-kv"></div>

        <div class="rs-divider"></div>

        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;">
          <button class="btn btn-primary" id="rsModalEdit">Edit</button>
          <button class="btn" id="rsModalToggle">Enable</button>
        </div>

        <div class="small muted" style="margin-bottom:8px;">Recent backtests</div>
        <div id="rsModalBacktests" class="small"></div>
      </div>

      <div class="rs-modal-body" id="rsModalEditView" style="display:none;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px;">
          <div class="small muted">Editing in popup</div>
          <div style="display:flex; gap:10px; align-items:center;">
            <button class="btn" id="rsModalDelete">Delete</button>
            <button class="btn" id="rsModalDone">Done</button>
          </div>
        </div>
        <div id="rsModalEditMount" class="rs-edit-mount"></div>
      </div>
    </div>
  `;
    document.body.appendChild(wrap);

    const doneBtn = document.getElementById("rsModalDone");
    const delBtn = document.getElementById("rsModalDelete");

    doneBtn.addEventListener("click", async () => {
      try {
        if (!modalVersion) return;

        const name = String(strategyName?.value || "").trim() || `v${modalVersion}`;
        const config = readForm();

        await jpost(`/api/rulesets/${modalVersion}/update`, { name, config, changedBy: "ui" });

        restoreEditorFromModal();
        showModalView("view");
        wrap.style.display = "none";
        await boot();
      } catch (e) {
        alert(`Save failed: ${String(e?.message || e)}`);
      }
    });

    delBtn.addEventListener("click", async () => {
      try {
        if (!modalVersion) return;
        const ok = confirm(`Delete strategy v${modalVersion}? This cannot be undone.`);
        if (!ok) return;

        const res = await fetch(`/api/rulesets/${modalVersion}`, { method: "DELETE", headers: { ...getAdminHeaders() } });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) throw new Error(json?.error || `Delete failed (HTTP ${res.status})`);

        restoreEditorFromModal();
        showModalView("view");
        wrap.style.display = "none";
        await boot();
      } catch (e) {
        alert(`Delete failed: ${String(e?.message || e)}`);
      }
    });

    const closeBtn = document.getElementById("rsModalClose");
    closeBtn.addEventListener("click", () => {
      restoreEditorFromModal();
      showModalView("view");
      wrap.style.display = "none";
    });

    wrap.addEventListener("click", (ev) => {
      if (ev.target === wrap) {
        restoreEditorFromModal();
        showModalView("view");
        wrap.style.display = "none";
      }
    });

    return wrap;
  }

  function buildOverviewKVs(cfg) {
    const c = cfg || {};
    const inds = c.indicators || {};
    const post = c.post || {};
    const orb = c.orb || {};

    const enabledInds = [];
    if (inds.vwap) enabledInds.push("VWAP");
    if (inds.movingAverages) enabledInds.push("MAs");
    if (inds.relativeStrength) enabledInds.push("RS");
    if (inds.volume) enabledInds.push("Volume");

    const kv = [
      ["Trigger", c.triggerType ?? "—"],
      ["Timeframe", c.timeframeMin != null ? `${c.timeframeMin}m` : "—"],
      ["Session", c.scanSession ?? "—"],
      ["Universe", c.scanUniverse ?? "—"],
      ["Retest tol", c.retestTolerancePct != null ? `${c.retestTolerancePct}%` : "—"],
      ["Indicators", enabledInds.length ? enabledInds.join(", ") : "None"],
      ["Long bias min", c.longMinBiasScore != null ? String(c.longMinBiasScore) : "—"],
      ["Short bias max", c.shortMaxBiasScore != null ? String(c.shortMaxBiasScore) : "—"],
      ["Target (R)", post.targetR != null ? String(post.targetR) : "—"],
      ["Stop (R)", post.stopR != null ? String(post.stopR) : "—"],
      ["Max hold (bars)", post.maxHoldBars != null ? String(post.maxHoldBars) : "—"],
      ["Exit on bias flip", post.exitOnBiasFlip ? "Yes" : "No"]
    ];

    if (String(c.triggerType) === "ORB") {
      kv.push(["ORB range", orb.rangeMin != null ? `${orb.rangeMin}m` : "—"]);
      kv.push(["ORB entry", orb.entryMode ?? "—"]);
      kv.push(["ORB tol", orb.tolerancePct != null ? `${orb.tolerancePct}%` : "—"]);
    }

    if (inds.movingAverages) {
      kv.push(["EMA periods", Array.isArray(c.emaPeriods) ? c.emaPeriods.join(",") : "—"]);
      kv.push(["EMA trigger", c.emaTrigger ?? "NONE"]);
    }

    if (post.moveBeEnabled) kv.push(["Move BE @", post.moveBeAtR != null ? `${post.moveBeAtR}R` : "—"]);
    if (post.trailEnabled) kv.push(["Trail", `start ${post.trailStartR ?? "—"}R by ${post.trailByR ?? "—"}R`]);

    return kv;
  }

  async function fetchRulesetByVersion(version) {
    const out = await jget(`/api/rulesets/${encodeURIComponent(version)}`);
    if (!out || !out.ok || !out.ruleset) throw new Error("ruleset fetch failed");
    return out.ruleset;
  }

  async function fetchRecentBacktests(strategyVersion, limit = 5) {
    const res = await jget(`/api/backtests?limit=${encodeURIComponent(limit)}&strategyVersion=${encodeURIComponent(strategyVersion)}`);
    const runs = Array.isArray(res?.runs) ? res.runs : [];
    return runs;
  }

  let editorHome = null;

  function moveEditorIntoModal() {
    const editor = document.getElementById("rulesEditor");
    const mount = document.getElementById("rsModalEditMount");
    if (!editor || !mount) return false;

    if (!editorHome) {
      editorHome = { editor, parent: editor.parentNode, next: editor.nextSibling };
    }

    mount.appendChild(editor);
    return true;
  }

  function restoreEditorFromModal() {
    if (!editorHome) return;
    const { editor, parent, next } = editorHome;
    try {
      if (parent) parent.insertBefore(editor, next || null);
    } finally {
      editorHome = null;
    }
  }

  function showModalView(mode) {
    const view = document.getElementById("rsModalView");
    const edit = document.getElementById("rsModalEditView");
    if (!view || !edit) return;

    if (mode === "edit") {
      view.style.display = "none";
      edit.style.display = "block";
    } else {
      edit.style.display = "none";
      view.style.display = "block";
    }
  }

  async function openViewModal(rsRow) {
    const version = Number(rsRow?.version);
    if (!Number.isFinite(version)) throw new Error("bad version");
    modalVersion = version;

    const wrap = ensureModal();
    wrap.style.display = "flex";

    const titleEl = document.getElementById("rsModalTitle");
    const subEl = document.getElementById("rsModalSub");
    const ovEl = document.getElementById("rsModalOverview");
    const btEl = document.getElementById("rsModalBacktests");
    const editBtn = document.getElementById("rsModalEdit");
    const toggleBtn = document.getElementById("rsModalToggle");

    titleEl.textContent = rsRow?.name ? String(rsRow.name) : `Strategy v${version}`;
    subEl.textContent = `v${version}${rsRow?.created_ts ? ` • ${new Date(Number(rsRow.created_ts)).toLocaleString()}` : ""}`;

    // fetch full ruleset config
    let ruleset = null;
    try {
      ruleset = await fetchRulesetByVersion(version);
    } catch {
      if (ovEl) ovEl.innerHTML = `<span class="small muted">Couldn’t load this strategy.</span>`;
      if (btEl) btEl.innerHTML = `<span class="small muted">Backtests unavailable.</span>`;
      if (editBtn) editBtn.disabled = true;
      if (toggleBtn) toggleBtn.disabled = true;
      return;
    }

    let cfg =
      ruleset?.config ??
      ruleset?.config_json ??
      ruleset?.configJson ??
      ruleset?.configJsonStr ??
      null;

    if (typeof cfg === "string") {
      try { cfg = JSON.parse(cfg); } catch { cfg = null; }
    }

    const cfgObj = (cfg && typeof cfg === "object") ? cfg : DEFAULT_RULES;

    if (ovEl) {
      const kv = buildOverviewKVs(cfgObj);
      ovEl.innerHTML = kv.map(([k, v]) => `
        <div>
          <div class="rs-k">${escapeHtml(k)}</div>
          <div class="rs-v">${escapeHtml(String(v))}</div>
        </div>
      `).join("");
    }

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
        btEl.innerHTML = done.map((r) => {
          const m = r?.metrics?.meta ? r.metrics : r?.metrics;
          const meta = m?.meta || r?.meta || {};
          const ticker =
            meta?.ticker || meta?.symbol || r?.ticker || r?.symbol || r?.request?.ticker || r?.request?.symbol || "—";

          const winRate = m?.winRate ?? m?.metrics?.winRate ?? null;
          const avgWin =
            m?.avgWin ?? m?.avgWinningTrade ?? m?.avgWinner ?? m?.avgWinR ?? m?.metrics?.avgWin ?? m?.metrics?.avgWinningTrade ?? null;

          const wr = winRate != null ? `${(Number(winRate) * 100).toFixed(1)}%` : "—";
          const aw = avgWin != null ? (Number.isFinite(Number(avgWin)) ? Number(avgWin).toFixed(2) : String(avgWin)) : "—";

          return `
            <div style="padding:10px; border:1px solid rgba(0,0,0,0.08); border-radius:10px; margin-bottom:8px;">
              <div class="small">
                Ticker: <b>${escapeHtml(String(ticker))}</b> • Win: <b>${escapeHtml(wr)}</b> • Avg win: <b>${escapeHtml(aw)}</b>
              </div>
              <div class="small muted" style="margin-top:4px;">Finished: ${escapeHtml(fmtTs(r?.finishedTs))}</div>
            </div>
          `;
        }).join("");
      }
    } catch {
      btEl.innerHTML = `<span class="small muted">Backtest listing endpoint missing or failed.</span>`;
    }

    // Edit button
    editBtn.disabled = false;
    editBtn.onclick = () => {
      // load config into editor, then move editor into modal for editing
      fill(cfgObj);
      moveEditorIntoModal();
      showModalView("edit");
    };

    // Enable/Disable button
    toggleBtn.disabled = false;
    toggleBtn.textContent = rsRow?.enabled ? "Disable" : "Enable";
    toggleBtn.onclick = async () => {
      try {
        const to = !Boolean(rsRow?.active);
await jpost(`/api/rules/toggle/${version}`, { active: to });
        wrap.style.display = "none";
        restoreEditorFromModal();
        showModalView("view");
        await boot();
      } catch (e) {
        alert(`Toggle failed: ${String(e?.message || e)}`);
      }
    };
  }

  // ---------- strategies list rendering ----------
  function renderStrategies(list) {
    if (!strategiesList) return;
    const rows = Array.isArray(list) ? list : [];

    strategiesList.innerHTML = rows.map((r) => {
      const name = r?.name ? escapeHtml(String(r.name)) : `v${escapeHtml(String(r?.version ?? "—"))}`;
      const v = escapeHtml(String(r?.version ?? "—"));
      const enabled = Boolean(r?.active);

      return `
        <div class="strategy-row">
          <div style="min-width:0;">
            <div class="strategy-title">${name}</div>
            <div class="small muted">v${v}${r?.created_ts ? ` • ${escapeHtml(new Date(Number(r.created_ts)).toLocaleString())}` : ""}</div>
          </div>
          <div class="strategy-actions">
            <button class="btn" data-act="view" data-v="${v}">View</button>
            <button class="btn strategy-enable-btn ${enabled ? "is-enabled" : ""}" data-act="toggle" data-v="${v}">
              ${enabled ? "Enabled" : "Enable"}
            </button>
          </div>
        </div>
      `;
    }).join("");

    strategiesList.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.getAttribute("data-act");
        const v = Number(btn.getAttribute("data-v"));

        const row = rows.find((x) => Number(x?.version) === v) || null;

        if (act === "view") {
          try { await openViewModal(row); } catch (e) { alert(String(e?.message || e)); }
          return;
        }

        if (act === "toggle") {
          try {
            const to = !Boolean(row?.enabled);
            await jpost(`/api/rules/toggle/${v}`, { active: to });
            await boot();
          } catch (e) {
            alert(`Toggle failed: ${String(e?.message || e)}`);
          }
        }
      });
    });
  }

  // ---------- events ----------
  function bindLiveSummaryListeners() {
    const els = [
      timeframeMin, scanSession, scanUniverse, premarketEnabled, marketBiasRequired,
      triggerType, orbRangeMin, orbEntryMode, orbTolerancePct,
      retestTolerancePct, rsWindowBars5m, structureWindow, sectorAlignmentEnabled, longMinBiasScore, shortMaxBiasScore,
      indVwap, indMa, indRs, indVol, emaPeriods, emaTrigger,
      targetR, stopR, maxHoldBars, exitOnBiasFlip,
      moveBeEnabled, moveBeAtR, trailEnabled, trailStartR, trailByR
    ].filter(Boolean);

    els.forEach((el) => {
      el.addEventListener("input", () => {
        applyConditionalUI();
        updateSummaries();
      });
      el.addEventListener("change", () => {
        applyConditionalUI();
        updateSummaries();
      });
    });
  }

  // ---------- load + save ----------
  async function boot() {
    const res = await jget("/api/rulesets");
    const rows = Array.isArray(res?.rulesets) ? res.rulesets : [];
    renderStrategies(rows);

    // pick active ruleset if provided
    const active = rows.find((r) => r?.active) || rows.find((r) => r?.enabled) || rows[0] || null;
    if (active?.version != null) {
      lastLoadedVersion = Number(active.version);
      const full = await fetchRulesetByVersion(Number(active.version));

      let cfg =
        full?.config ??
        full?.config_json ??
        full?.configJson ??
        full?.configJsonStr ??
        null;

      if (typeof cfg === "string") {
        try { cfg = JSON.parse(cfg); } catch { cfg = null; }
      }

      fill((cfg && typeof cfg === "object") ? cfg : DEFAULT_RULES);
      if (strategyName && active?.name) strategyName.value = String(active.name);
    } else {
      fill(DEFAULT_RULES);
    }
  }

  async function saveNewVersion() {
    const name = String(strategyName?.value || "").trim() || "Strategy";
    const config = readForm();
  
    // Create new ruleset version (correct backend route)
    const out = await jpost("/api/rules", { name, config, changedBy: "ui" });
    if (!out?.ok) throw new Error(out?.error || "save failed");
  
    await boot();
  }

  // ---------- init ----------
  function init() {
    bindLiveSummaryListeners();
    applyConditionalUI();
    updateSummaries();

    // persist admin token (optional)
const adminEl = document.getElementById("adminToken");
if (adminEl) {
  adminEl.value = localStorage.getItem("ADMIN_TOKEN") || "";
  adminEl.addEventListener("input", () => {
    localStorage.setItem("ADMIN_TOKEN", adminEl.value || "");
  });
}

    if (saveRulesBtn) {
      saveRulesBtn.addEventListener("click", async () => {
        try {
          await saveNewVersion();
        } catch (e) {
          alert(`Save failed: ${String(e?.message || e)}`);
        }
      });
    }

    boot().catch((e) => {
      console.error(e);
      alert(`Rules boot failed: ${String(e?.message || e)}`);
      fill(DEFAULT_RULES);
    });
  }

  init();
})();