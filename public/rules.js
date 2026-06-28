/* global fetch */
/* Strategy Builder — rules.js */
(() => {
  const root = document.getElementById('strategyPage');

  // ── state ──────────────────────────────────────────────────────────────────
  let state = {
    rulesets: [],
    watchlist: [],
    mode: 'loading', // 'loading' | 'view' | 'edit'
    draft: null,
    editingVersion: null,
    saving: false,
  };

  // ── auth ───────────────────────────────────────────────────────────────────
  const adminToken = () => { try { return localStorage.getItem('ADMIN_TOKEN') || ''; } catch { return ''; } };
  const authHdrs = () => {
    const t = adminToken();
    return t ? { Authorization: `Bearer ${t}`, 'x-admin-token': t } : {};
  };
  const jsonHdrs = () => ({ ...authHdrs(), 'Content-Type': 'application/json' });

  // ── api ────────────────────────────────────────────────────────────────────
  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, opts);
    let json;
    try { json = await res.json(); } catch { json = {}; }
    if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
    return json;
  }

  // ── defaults (mirrors schema.ts defaultStrategyDefinition) ─────────────────
  function defaultDraft(setupType = 'break_retest') {
    const base = {
      version: 3, name: '', description: '',
      setupType,
      timeframeMin: 5,
      direction: 'both',
      filters: {
        session: 'regular', universe: 'watchlist',
        minVolume: 1000000, minVolatilityPct: 0.75,
        requireMarketBias: true, requireSpyQqqAlignment: true,
        requireVwapAgreement: true, requireRelativeStrength: true,
      },
      risk: {
        riskMode: 'percent_account', riskValue: 1,
        stopMode: setupType === 'ma_cross' ? 'ma_fail_close' : 'structure_close',
        stopValueR: 1, profitTargetR: 2, moveToBreakevenAtR: 1,
        timeExitBars: 20, maxOpenPositions: 3,
      },
      brokerCaps: { maxTradesPerDay: 4, maxCapital: 10000 },
    };
    if (setupType === 'ma_cross') {
      base.setup = {
        maType: 'EMA', fastValue: 9, slowValue: 20,
        entryReference: 'cross',
        requireCloseAfterCross: true, requireRetest: false,
        maxEntryBarsAfterCross: 3, requireVwapAgreement: true,
      };
    } else {
      base.setup = {
        levels: ['pmh', 'pml', 'vwap'],
        movingAverage: null,
        breakConfirmation: 'close_through',
        retestConfirmation: 'reclaim_close',
        maxRetestBars: 3,
        entryTrigger: 'retest_close',
      };
    }
    return base;
  }

  // ── display helpers ────────────────────────────────────────────────────────
  const fmt = (v) => (v == null || v === '') ? '—' : String(v);

  function paramGrid(items) {
    return `<div class="param-grid">${items.map(([label, value]) => `
      <div class="param-item">
        <div class="param-label">${label}</div>
        <div class="param-value">${fmt(value)}</div>
      </div>`).join('')}</div>`;
  }

  function checkItem(on, label) {
    return `<div class="check-item ${on ? 'on' : 'off'}">
      <span class="icon">${on ? '✓' : '✗'}</span>
      <span>${label}</span>
    </div>`;
  }

  function sectionCard(title, subtitle, body, actions = '') {
    return `<section class="card">
      <div class="card-head">
        <div>
          <div class="card-title">${title}</div>
          ${subtitle ? `<div class="card-hint">${subtitle}</div>` : ''}
        </div>
        ${actions ? `<div>${actions}</div>` : ''}
      </div>
      <div style="padding:0 20px 20px;">${body}</div>
    </section>`;
  }

  // ── setup description ──────────────────────────────────────────────────────
  function describeSetup(cfg) {
    if (!cfg) return '';
    const s = cfg.setup || {};
    if (cfg.setupType === 'break_retest') {
      const levels = (s.levels || []).map(l => l.toUpperCase().replace('_', ' ')).join(', ') || 'PMH · PML';
      return `Waits for price to break a key level (${levels}), then retests it as support/resistance. Entry fires on the 1m retest tap.`;
    }
    if (cfg.setupType === 'ma_cross') {
      return `Triggers when the ${s.maType || 'EMA'} ${s.fastValue || '9'} crosses the ${s.maType || 'EMA'} ${s.slowValue || '21'} on the configured timeframe.`;
    }
    return '';
  }

  // ── VIEW MODE ──────────────────────────────────────────────────────────────
  function renderView() {
    const { rulesets, watchlist } = state;
    const strategy = rulesets.find(r => r.active) || rulesets[rulesets.length - 1] || null;

    if (!strategy) {
      return `<div class="no-strategy">No strategy yet.</div>
        <div style="text-align:center;margin-top:16px;">
          <button class="btn btn-primary" onclick="window.__newStrategy()">+ New Strategy</button>
        </div>`;
    }

    const cfg = strategy.config || {};
    const s = cfg.setup || {};
    const f = cfg.filters || {};
    const r = cfg.risk || {};
    const b = cfg.brokerCaps || {};
    const isActive = strategy.active !== false;
    const desc = describeSetup(cfg);

    const headerActions = `<div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn" onclick="window.__newStrategy()">+ New</button>
      <button class="btn btn-primary" onclick="window.__editStrategy(${strategy.version})">Edit Strategy</button>
    </div>`;

    let html = `<section class="card" style="padding:20px 22px 20px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <div class="strategy-status-bar">
            <span class="strategy-badge ${isActive ? 'active' : 'inactive'}">
              <span class="dot"></span>${isActive ? 'Active' : 'Inactive'}
            </span>
            <span class="strategy-version">v${strategy.version}</span>
          </div>
          <div class="strategy-name">${strategy.name || `Strategy v${strategy.version}`}</div>
          ${desc ? `<div class="strategy-description">${desc}</div>` : ''}
        </div>
        ${headerActions}
      </div>
    </section>`;

    // Setup card
    const setupLabel = cfg.setupType === 'break_retest' ? 'Break & Retest' : cfg.setupType === 'ma_cross' ? 'MA Cross' : fmt(cfg.setupType);
    const dirLabel = cfg.direction === 'both' ? 'Long & Short' : cfg.direction === 'long' ? 'Long only' : 'Short only';
    const setupParams = [
      ['Setup', setupLabel],
      ['Timeframe', cfg.timeframeMin ? `${cfg.timeframeMin}m` : '5m'],
      ['Direction', dirLabel],
    ];
    if (cfg.setupType === 'break_retest') {
      const levels = (s.levels || []).filter(l => l !== 'moving_average').map(l => l.toUpperCase()).join(', ') || 'PMH, PML';
      const ma = s.movingAverage ? `${s.movingAverage.type} ${(s.movingAverage.values || []).join(', ')}` : 'None';
      setupParams.push(
        ['Key Levels', levels], ['Confirm MA', ma],
        ['Break Confirm', fmt(s.breakConfirmation).replace(/_/g, ' ')],
        ['Retest Confirm', fmt(s.retestConfirmation).replace(/_/g, ' ')],
        ['Entry Trigger', fmt(s.entryTrigger).replace(/_/g, ' ')],
        ['Max Retest Bars', fmt(s.maxRetestBars)]
      );
    } else if (cfg.setupType === 'ma_cross') {
      setupParams.push(
        ['MA Type', fmt(s.maType)], ['Fast MA', fmt(s.fastValue)], ['Slow MA', fmt(s.slowValue)],
        ['Entry Reference', fmt(s.entryReference).replace(/_/g, ' ')],
        ['Max Entry Bars', fmt(s.maxEntryBarsAfterCross)]
      );
    }
    html += sectionCard('Setup Rules', 'Exact logic scanned on every bar close.', paramGrid(setupParams));

    // Filters card
    html += sectionCard('Filters', 'All must pass before a signal fires.',
      paramGrid([
        ['Session', fmt(f.session)],
        ['Min Volume', f.minVolume ? Number(f.minVolume).toLocaleString() : '—'],
        ['Min Volatility', f.minVolatilityPct != null ? `${f.minVolatilityPct}%` : '—'],
      ]) +
      `<div style="margin-top:14px;" class="check-list">
        ${checkItem(f.requireMarketBias !== false, 'Market bias required (SPY + QQQ vs VWAP)')}
        ${checkItem(f.requireSpyQqqAlignment !== false, 'SPY / QQQ alignment required')}
        ${checkItem(f.requireVwapAgreement !== false, 'VWAP agreement required')}
        ${checkItem(f.requireRelativeStrength !== false, 'Relative strength vs SPY required')}
      </div>`
    );

    // Risk card
    html += sectionCard('Risk & Exits', 'Sizing and exit rules applied to every trade.',
      paramGrid([
        ['Risk Mode', fmt(r.riskMode).replace(/_/g, ' ')],
        ['Risk per Trade', r.riskMode === 'fixed_dollars' ? `$${r.riskValue}` : `${r.riskValue}%`],
        ['Stop Mode', fmt(r.stopMode).replace(/_/g, ' ')],
        ['Profit Target', r.profitTargetR != null ? `${r.profitTargetR}R` : '—'],
        ['Move to BE at', r.moveToBreakevenAtR != null ? `${r.moveToBreakevenAtR}R` : 'Off'],
        ['Time Exit', r.timeExitBars ? `${r.timeExitBars} bars` : '—'],
        ['Max Positions', fmt(r.maxOpenPositions)],
        ['Max Trades/Day', fmt(b.maxTradesPerDay)],
        ['Max Capital', b.maxCapital ? `$${Number(b.maxCapital).toLocaleString()}` : '—'],
      ])
    );

    // Watchlist card
    if (watchlist && watchlist.length) {
      const chips = watchlist.map(sym => `<span class="sym-chip">${sym}</span>`).join('');
      html += sectionCard('Active Watchlist', `${watchlist.length} symbols monitored in real time.`, `<div class="watchlist-chips">${chips}</div>`);
    }

    // Version history
    if (rulesets.length > 0) {
      html += renderVersionHistory(rulesets);
    }

    return html;
  }

  function renderVersionHistory(rulesets) {
    const sorted = [...rulesets].sort((a, b) => b.version - a.version);
    const rows = sorted.map(rs => {
      const active = rs.active;
      return `<div class="version-row">
        <div class="version-info">
          <span class="version-num">v${rs.version}</span>
          <span class="version-name">${rs.name || `Strategy v${rs.version}`}</span>
          ${active ? '<span class="version-badge">Active</span>' : ''}
        </div>
        <div class="version-actions">
          ${!active
            ? `<button class="btn btn-xs" onclick="window.__activateStrategy(${rs.version}, true)">Activate</button>`
            : `<button class="btn btn-xs btn-muted" onclick="window.__activateStrategy(${rs.version}, false)">Deactivate</button>`
          }
          <button class="btn btn-xs" onclick="window.__editStrategy(${rs.version})">Edit</button>
        </div>
      </div>`;
    }).join('');

    return `<section class="card" style="margin-top:16px;">
      <div class="card-head"><div class="card-title">All Versions</div></div>
      <div class="version-list">${rows}</div>
    </section>`;
  }

  // ── EDITOR MODE ────────────────────────────────────────────────────────────
  function renderEditor() {
    const cfg = state.draft || defaultDraft();
    const s = cfg.setup || {};
    const f = cfg.filters || {};
    const r = cfg.risk || {};
    const b = cfg.brokerCaps || {};
    const isNew = state.editingVersion == null;
    const isBreakRetest = cfg.setupType !== 'ma_cross';
    const hasMaLevel = isBreakRetest && (s.levels || []).includes('moving_average');
    const isRMultiple = r.stopMode === 'r_multiple';
    const isPercent = r.stopMode === 'percent';

    const field = (label, inputHtml, hint = '') =>
      `<div class="ed-field">
        <label class="ed-label">${label}</label>
        ${inputHtml}
        ${hint ? `<div class="ed-hint">${hint}</div>` : ''}
      </div>`;

    const sel = (name, val, opts) =>
      `<select class="input" name="${name}">${opts.map(([v, l]) =>
        `<option value="${v}"${String(v) === String(val) ? ' selected' : ''}>${l}</option>`
      ).join('')}</select>`;

    const num = (name, val, min = 0, step = 1, ph = '') =>
      `<input class="input" type="number" name="${name}" value="${val != null ? val : ''}" min="${min}" step="${step}" placeholder="${ph}" />`;

    const txt = (name, val, ph = '') =>
      `<input class="input" type="text" name="${name}" value="${val || ''}" placeholder="${ph}" />`;

    const toggle = (name, val, label) =>
      `<label class="ed-toggle">
        <input type="checkbox" name="${name}"${val ? ' checked' : ''} />
        <span class="ed-toggle-track"><span class="ed-toggle-thumb"></span></span>
        <span class="ed-toggle-label">${label}</span>
      </label>`;

    // Level checkboxes
    const levels = new Set(isBreakRetest ? (s.levels || []) : []);
    const levelOpts = [
      ['pmh', 'PMH — Prior Market High'],
      ['pml', 'PML — Prior Market Low'],
      ['vwap', 'VWAP'],
      ['moving_average', 'Moving Average'],
    ];
    const levelsHtml = levelOpts.map(([v, l]) =>
      `<label class="ed-check">
        <input type="checkbox" name="level_${v}"${levels.has(v) ? ' checked' : ''} />
        <span>${l}</span>
      </label>`
    ).join('');

    return `<section class="card ed-card">
      <!-- header -->
      <div class="card-head" style="padding:16px 20px;">
        <div>
          <div class="card-title">${isNew ? '+ New Strategy' : `Edit Strategy v${state.editingVersion}`}</div>
          <div class="card-hint">${isNew ? 'Creates a new versioned strategy.' : 'Save as new version or overwrite current.'}</div>
        </div>
        <button class="btn" id="edCancelBtn">Cancel</button>
      </div>

      <div class="ed-body">

        <!-- ── Strategy Info ── -->
        <div class="ed-section">
          <div class="ed-section-title">Strategy Info</div>
          <div class="ed-grid">
            ${field('Name', txt('name', cfg.name, 'e.g. Break & Retest — Conservative'))}
          </div>
        </div>

        <!-- ── Core Setup ── -->
        <div class="ed-section">
          <div class="ed-section-title">Setup</div>
          <div class="ed-grid ed-grid-3">
            ${field('Setup Type', sel('setupType', cfg.setupType, [['break_retest', 'Break & Retest'], ['ma_cross', 'MA Cross']]))}
            ${field('Timeframe', sel('timeframeMin', cfg.timeframeMin, [['1','1m'],['3','3m'],['5','5m'],['15','15m'],['30','30m'],['60','1h / 60m'],['240','4h / 240m']]))}
            ${field('Direction', sel('direction', cfg.direction, [['both','Both (Long & Short)'],['long','Long only'],['short','Short only']]))}
          </div>
        </div>

        <!-- ── Break & Retest ── -->
        <div class="ed-section" data-show-when="break_retest" ${!isBreakRetest ? 'style="display:none"' : ''}>
          <div class="ed-section-title">Break &amp; Retest</div>
          <div class="ed-grid">
            ${field('Key Levels', `<div class="ed-check-group">${levelsHtml}</div>`)}
          </div>
          <div class="ed-grid ed-grid-3 ed-ma-fields" ${!hasMaLevel ? 'style="display:none"' : ''}>
            ${field('MA Type', sel('br_maType', (s.movingAverage || {}).type || 'EMA', [['EMA','EMA'],['SMA','SMA']]))}
            ${field('MA Values', txt('br_maValues', ((s.movingAverage || {}).values || []).join(', '), '9, 21'), 'Comma-separated periods')}
          </div>
          <div class="ed-grid ed-grid-3">
            ${field('Break Confirmation', sel('breakConfirmation', s.breakConfirmation, [['close_through','Close Through'],['wick_and_close','Wick & Close']]))}
            ${field('Retest Confirmation', sel('retestConfirmation', s.retestConfirmation, [['reclaim_close','Reclaim Close'],['wick_hold','Wick Hold'],['close_hold','Close Hold']]))}
            ${field('Entry Trigger', sel('entryTrigger', s.entryTrigger, [['retest_close','Retest Close'],['next_bar_break','Next Bar Break']]))}
            ${field('Max Retest Bars', num('maxRetestBars', s.maxRetestBars, 1, 1, '3'))}
          </div>
        </div>

        <!-- ── MA Cross ── -->
        <div class="ed-section" data-show-when="ma_cross" ${isBreakRetest ? 'style="display:none"' : ''}>
          <div class="ed-section-title">MA Cross</div>
          <div class="ed-grid ed-grid-3">
            ${field('MA Type', sel('mac_maType', s.maType || 'EMA', [['EMA','EMA'],['SMA','SMA']]))}
            ${field('Fast MA Period', num('fastValue', s.fastValue, 1, 1, '9'))}
            ${field('Slow MA Period', num('slowValue', s.slowValue, 2, 1, '21'))}
            ${field('Entry Reference', sel('entryReference', s.entryReference, [['cross','Cross'],['fast_ma_pullback','Fast MA Pullback'],['slow_ma_pullback','Slow MA Pullback'],['vwap_pullback','VWAP Pullback'],['cross_zone_pullback','Cross Zone Pullback']]))}
            ${field('Max Entry Bars After Cross', num('maxEntryBarsAfterCross', s.maxEntryBarsAfterCross, 1, 1, '3'))}
          </div>
          <div class="ed-toggles" style="margin-top:10px;">
            ${toggle('mac_requireCloseAfterCross', s.requireCloseAfterCross, 'Require close after cross')}
            ${toggle('mac_requireRetest', s.requireRetest, 'Require retest')}
            ${toggle('mac_requireVwapAgreement', s.requireVwapAgreement, 'Require VWAP agreement')}
          </div>
        </div>

        <!-- ── Filters ── -->
        <div class="ed-section">
          <div class="ed-section-title">Filters</div>
          <div class="ed-grid ed-grid-3">
            ${field('Session', sel('session', f.session, [['regular','Regular (RTH)'],['premarket','Premarket'],['both','Both']]))}
            ${field('Min Volume', num('minVolume', f.minVolume, 0, 100000, '1000000'))}
            ${field('Min Volatility %', num('minVolatilityPct', f.minVolatilityPct, 0, 0.1, '0.75'))}
          </div>
          <div class="ed-toggles" style="margin-top:12px;">
            ${toggle('requireMarketBias', f.requireMarketBias, 'Require market bias (SPY + QQQ vs VWAP)')}
            ${toggle('requireSpyQqqAlignment', f.requireSpyQqqAlignment, 'Require SPY / QQQ alignment')}
            ${toggle('requireVwapAgreement', f.requireVwapAgreement, 'Require VWAP agreement')}
            ${toggle('requireRelativeStrength', f.requireRelativeStrength, 'Require relative strength vs SPY')}
          </div>
        </div>

        <!-- ── Risk & Exits ── -->
        <div class="ed-section">
          <div class="ed-section-title">Risk &amp; Exits</div>
          <div class="ed-grid ed-grid-3">
            ${field('Risk Mode', sel('riskMode', r.riskMode, [['percent_account','% of Account'],['fixed_dollars','Fixed Dollars']]))}
            ${field('Risk per Trade', num('riskValue', r.riskValue, 0.01, 0.01, '1'), r.riskMode === 'fixed_dollars' ? 'In dollars ($)' : 'Percent of account (%)')}
            ${field('Stop Mode', sel('stopMode', r.stopMode, [['structure_close','Structure Close (1R)'],['ma_fail_close','MA Fail Close (1R)'],['r_multiple','R-Multiple'],['percent','Percent (%)']]))}
            <div class="ed-field ed-stop-r" ${!isRMultiple ? 'style="display:none"' : ''}>
              <label class="ed-label">Stop Distance (R)</label>
              ${num('stopValueR', r.stopValueR, 0.1, 0.1, '1')}
            </div>
            <div class="ed-field ed-stop-pct" ${!isPercent ? 'style="display:none"' : ''}>
              <label class="ed-label">Stop Loss (%)</label>
              ${num('stopValuePct', r.stopValuePct, 0.1, 0.1, '2')}
            </div>
            ${field('Profit Target', num('profitTargetR', r.profitTargetR, 0.1, 0.1, '2'), 'In R-multiples')}
            ${field('Move to Breakeven at', num('moveToBreakevenAtR', r.moveToBreakevenAtR, 0.1, 0.1, '1'), 'R-multiple — blank to disable')}
            ${field('Time Exit (bars)', num('timeExitBars', r.timeExitBars, 1, 1, '20'), 'Strategy-timeframe bars — blank to disable')}
            ${field('Max Open Positions', num('maxOpenPositions', r.maxOpenPositions, 1, 1, '3'))}
          </div>
        </div>

        <!-- ── Broker Caps ── -->
        <div class="ed-section">
          <div class="ed-section-title">Broker Caps</div>
          <div class="ed-grid ed-grid-3">
            ${field('Max Trades / Day', num('maxTradesPerDay', b.maxTradesPerDay, 0, 1, '4'), 'Blank = unlimited')}
            ${field('Max Capital ($)', num('maxCapital', b.maxCapital, 0, 100, '10000'), 'Blank = unlimited')}
          </div>
        </div>

        <!-- ── Actions ── -->
        <div class="ed-actions">
          <button class="btn" id="edCancelBtn2">Cancel</button>
          ${!isNew ? `<button class="btn ed-update-btn" id="edUpdateBtn">Update v${state.editingVersion}</button>` : ''}
          <button class="btn btn-primary" id="edSaveBtn">
            ${isNew ? 'Save New Strategy' : 'Save as New Version'}
          </button>
        </div>

      </div>
    </section>`;
  }

  // ── editor bindings ────────────────────────────────────────────────────────
  function bindEditorEvents() {
    const cancel = () => { state.mode = 'view'; render(); };
    document.getElementById('edCancelBtn')?.addEventListener('click', cancel);
    document.getElementById('edCancelBtn2')?.addEventListener('click', cancel);
    document.getElementById('edSaveBtn')?.addEventListener('click', () => saveStrategy(true));
    document.getElementById('edUpdateBtn')?.addEventListener('click', () => saveStrategy(false));

    // reactive conditionals
    const form = root.querySelector('.ed-card');
    form?.querySelector('[name="setupType"]')?.addEventListener('change', syncConditionals);
    form?.querySelectorAll('[name^="level_"]').forEach(el => el.addEventListener('change', syncConditionals));
    form?.querySelector('[name="stopMode"]')?.addEventListener('change', syncConditionals);
  }

  function syncConditionals() {
    const form = root.querySelector('.ed-card');
    if (!form) return;
    const setupType = form.querySelector('[name="setupType"]')?.value || 'break_retest';

    form.querySelectorAll('[data-show-when]').forEach(el => {
      el.style.display = el.dataset.showWhen === setupType ? '' : 'none';
    });

    const hasMaLevel = form.querySelector('[name="level_moving_average"]')?.checked;
    const maFields = form.querySelector('.ed-ma-fields');
    if (maFields) maFields.style.display = hasMaLevel ? '' : 'none';

    const stopMode = form.querySelector('[name="stopMode"]')?.value;
    const stopRField = form.querySelector('.ed-stop-r');
    if (stopRField) stopRField.style.display = stopMode === 'r_multiple' ? '' : 'none';
    const stopPctField = form.querySelector('.ed-stop-pct');
    if (stopPctField) stopPctField.style.display = stopMode === 'percent' ? '' : 'none';
  }

  // ── collect form → strategy definition ────────────────────────────────────
  function collectFormData() {
    const form = root.querySelector('.ed-card');
    const get = name => form.querySelector(`[name="${name}"]`)?.value ?? null;
    const num = name => { const v = get(name); return (v === '' || v == null) ? null : Number(v); };
    const bool = name => form.querySelector(`[name="${name}"]`)?.checked ?? false;

    const setupType = get('setupType') || 'break_retest';

    let setup;
    if (setupType === 'break_retest') {
      const levs = [];
      ['pmh', 'pml', 'vwap', 'moving_average'].forEach(l => {
        if (form.querySelector(`[name="level_${l}"]`)?.checked) levs.push(l);
      });
      const hasMa = levs.includes('moving_average');
      setup = {
        levels: levs,
        movingAverage: hasMa ? {
          type: get('br_maType') || 'EMA',
          values: (get('br_maValues') || '').split(',').map(v => parseInt(v.trim(), 10)).filter(v => Number.isFinite(v) && v > 0),
        } : null,
        breakConfirmation: get('breakConfirmation') || 'close_through',
        retestConfirmation: get('retestConfirmation') || 'reclaim_close',
        maxRetestBars: num('maxRetestBars') || 3,
        entryTrigger: get('entryTrigger') || 'retest_close',
      };
    } else {
      setup = {
        maType: get('mac_maType') || 'EMA',
        fastValue: num('fastValue') || 9,
        slowValue: num('slowValue') || 21,
        entryReference: get('entryReference') || 'cross',
        requireCloseAfterCross: bool('mac_requireCloseAfterCross'),
        requireRetest: bool('mac_requireRetest'),
        maxEntryBarsAfterCross: num('maxEntryBarsAfterCross') || 3,
        requireVwapAgreement: bool('mac_requireVwapAgreement'),
      };
    }

    const stopMode = get('stopMode') || 'structure_close';

    return {
      version: 3,
      name: get('name')?.trim() || null,
      description: null,
      setupType,
      timeframeMin: num('timeframeMin') || 5,
      direction: get('direction') || 'both',
      setup,
      filters: {
        session: get('session') || 'regular',
        universe: 'watchlist',
        minVolume: num('minVolume'),
        minVolatilityPct: num('minVolatilityPct'),
        requireMarketBias: bool('requireMarketBias'),
        requireSpyQqqAlignment: bool('requireSpyQqqAlignment'),
        requireVwapAgreement: bool('requireVwapAgreement'),
        requireRelativeStrength: bool('requireRelativeStrength'),
      },
      risk: {
        riskMode: get('riskMode') || 'percent_account',
        riskValue: num('riskValue') || 1,
        stopMode,
        stopValueR: stopMode === 'r_multiple' ? num('stopValueR') : null,
        stopValuePct: stopMode === 'percent' ? num('stopValuePct') : null,
        profitTargetR: num('profitTargetR'),
        moveToBreakevenAtR: num('moveToBreakevenAtR'),
        timeExitBars: num('timeExitBars'),
        maxOpenPositions: num('maxOpenPositions') || 3,
      },
      brokerCaps: {
        maxTradesPerDay: num('maxTradesPerDay'),
        maxCapital: num('maxCapital'),
      },
    };
  }

  // ── save ───────────────────────────────────────────────────────────────────
  async function saveStrategy(asNew) {
    if (state.saving) return;
    state.saving = true;

    // Disable save buttons
    ['edSaveBtn', 'edUpdateBtn'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    });

    try {
      const config = collectFormData();
      const name = config.name || `Strategy v${Date.now()}`;

      if (asNew) {
        await apiFetch('/api/rules', {
          method: 'POST',
          headers: jsonHdrs(),
          body: JSON.stringify({ name, config }),
        });
        window.showToast?.('New version saved', 'success');
      } else {
        await apiFetch(`/api/rulesets/${state.editingVersion}/update`, {
          method: 'POST',
          headers: jsonHdrs(),
          body: JSON.stringify({ name, config }),
        });
        window.showToast?.('Strategy updated', 'success');
      }

      await reload();
      state.mode = 'view';
      render();
    } catch (err) {
      window.showToast?.(err.message || 'Save failed', 'error');
      // re-enable buttons
      ['edSaveBtn', 'edUpdateBtn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) { btn.disabled = false; btn.textContent = btn.id === 'edSaveBtn' ? (state.editingVersion == null ? 'Save New Strategy' : 'Save as New Version') : `Update v${state.editingVersion}`; }
      });
    } finally {
      state.saving = false;
    }
  }

  // ── global action handlers ─────────────────────────────────────────────────
  window.__newStrategy = function () {
    state.draft = defaultDraft();
    state.editingVersion = null;
    state.mode = 'edit';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.__editStrategy = function (version) {
    const rs = state.rulesets.find(r => r.version === version);
    if (!rs) return;
    state.draft = JSON.parse(JSON.stringify(rs.config || defaultDraft()));
    state.editingVersion = version;
    state.mode = 'edit';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.__activateStrategy = async function (version, active) {
    try {
      await apiFetch(`/api/rules/toggle/${version}`, {
        method: 'POST',
        headers: jsonHdrs(),
        body: JSON.stringify({ active }),
      });
      window.showToast?.(active ? 'Strategy activated' : 'Strategy deactivated', 'success');
      await reload();
      render();
    } catch (err) {
      window.showToast?.(err.message || 'Toggle failed', 'error');
    }
  };

  // ── render dispatcher ──────────────────────────────────────────────────────
  function render() {
    if (state.mode === 'loading') {
      root.innerHTML = `<div class="loading-spinner">Loading strategy…</div>`;
      return;
    }
    if (state.mode === 'edit') {
      root.innerHTML = renderEditor();
      bindEditorEvents();
      return;
    }
    root.innerHTML = renderView();
  }

  // ── data load ──────────────────────────────────────────────────────────────
  async function reload() {
    const [rsRes, wlRes] = await Promise.all([
      fetch('/api/rulesets', { headers: authHdrs() }),
      fetch('/api/watchlist', { headers: authHdrs() }),
    ]);
    const rsJson = rsRes.ok ? await rsRes.json() : {};
    const wlJson = wlRes.ok ? await wlRes.json() : {};
    state.rulesets = Array.isArray(rsJson) ? rsJson : (rsJson.rulesets ?? []);
    state.watchlist = Array.isArray(wlJson.symbols) ? wlJson.symbols : (Array.isArray(wlJson) ? wlJson : []);
  }

  async function load() {
    render();
    try {
      await reload();
      state.mode = 'view';
    } catch (err) {
      root.innerHTML = `<div class="no-strategy">Failed to load: ${err.message}</div>`;
      return;
    }
    render();
  }

  load();
})();
