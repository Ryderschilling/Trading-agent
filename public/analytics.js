// public/analytics.js
// Strategy performance analytics dashboard.
// Fetches /api/analytics and renders head stats, equity curve, and breakdowns.

(function () {
  "use strict";

  // -----------------------------
  // Formatting helpers
  // -----------------------------
  function num(x) {
    return typeof x === "number" && isFinite(x) ? x : null;
  }

  function pct(x, digits) {
    const v = num(x);
    if (v === null) return "—";
    return v.toFixed(digits == null ? 2 : digits) + "%";
  }

  function signedPct(x, digits) {
    const v = num(x);
    if (v === null) return "—";
    const s = v > 0 ? "+" : "";
    return s + v.toFixed(digits == null ? 2 : digits) + "%";
  }

  function usd(x) {
    const v = num(x);
    if (v === null) return "—";
    const s = v < 0 ? "-" : "";
    return s + "$" + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function signedUsd(x) {
    const v = num(x);
    if (v === null) return "—";
    return (v >= 0 ? "+" : "") + usd(v);
  }

  function cls(x) {
    const v = num(x);
    if (v === null || v === 0) return "";
    return v > 0 ? "pos" : "neg";
  }

  function el(id) {
    return document.getElementById(id);
  }

  // -----------------------------
  // Head stats
  // -----------------------------
  function statCard(label, value, valueClass, sub) {
    const v = valueClass ? ' class="stat-value ' + valueClass + '"' : ' class="stat-value"';
    const s = sub ? '<div class="stat-sub">' + sub + "</div>" : "";
    return (
      '<div class="stat-card">' +
      '<div class="stat-label">' + label + "</div>" +
      "<div" + v + ">" + value + "</div>" +
      s +
      "</div>"
    );
  }

  function renderHead(data) {
    const o = data.overall || {};
    const cards = [];

    cards.push(
      statCard(
        "Trades",
        o.trades || 0,
        "",
        (o.wins || 0) + "W / " + (o.losses || 0) + "L" +
          (o.breakeven ? " / " + o.breakeven + " BE" : "")
      )
    );

    const wr = num(o.winRate);
    cards.push(
      statCard(
        "Win Rate",
        wr === null ? "—" : (wr * 100).toFixed(1) + "%",
        wr === null ? "" : wr >= 0.5 ? "pos" : "neg",
        "decided trades"
      )
    );

    cards.push(
      statCard(
        "Expectancy / Trade",
        signedPct(o.avgReturnPct, 3),
        cls(o.avgReturnPct),
        "avg return per trade"
      )
    );

    cards.push(
      statCard(
        "Avg R",
        o.avgR === null || o.avgR == null ? "—" : (o.avgR > 0 ? "+" : "") + o.avgR.toFixed(2) + "R",
        cls(o.avgR),
        "vs structure stop"
      )
    );

    const pf = o.profitFactor;
    cards.push(
      statCard(
        "Profit Factor",
        pf === null || pf == null ? "∞" : pf.toFixed(2),
        pf === null || pf == null ? "pos" : pf >= 1 ? "pos" : "neg",
        "gross win / gross loss"
      )
    );

    cards.push(
      statCard("Total Return", signedPct(o.totalReturnPct, 2), cls(o.totalReturnPct), "sum of returns")
    );

    cards.push(
      statCard(
        "Max Drawdown",
        data.maxDrawdownPct ? "-" + Number(data.maxDrawdownPct).toFixed(2) + "%" : "0.00%",
        data.maxDrawdownPct ? "neg" : "",
        "peak-to-trough"
      )
    );

    cards.push(
      statCard(
        "Realized P&L",
        signedUsd(o.pnlUsd),
        cls(o.pnlUsd),
        (o.pnlCount || 0) + " of " + (o.trades || 0) + " w/ broker fills"
      )
    );

    el("headStats").innerHTML = cards.join("");
  }

  // -----------------------------
  // Equity curve (canvas) + hover tooltip
  // -----------------------------
  let eqGeom = null; // geometry from the last drawEquity, for hover hit-testing
  let eqHoverIdx = null;

  function drawEquity(points, hoverIdx) {
    const canvas = el("equityChart");
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 800;
    const cssH = canvas.clientHeight || 320;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 52, padR = 16, padT = 16, padB = 26;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    if (!points || points.length === 0) {
      eqGeom = null;
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.font = "13px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No closed trades yet.", cssW / 2, cssH / 2);
      return;
    }

    // Series: cumulative %, indexed by trade order. Prepend a zero origin.
    const series = [0].concat(points.map(function (p) { return p.cumPct; }));
    let min = Math.min.apply(null, series);
    let max = Math.max.apply(null, series);
    if (min === max) { min -= 1; max += 1; }
    const range = max - min;
    min -= range * 0.08;
    max += range * 0.08;

    const n = series.length;
    function x(i) { return padL + (n <= 1 ? 0 : (i / (n - 1)) * plotW); }
    function y(v) { return padT + plotH - ((v - min) / (max - min)) * plotH; }

    // Cache geometry for hover hit-testing. series[0] is the origin (no trade);
    // series index i >= 1 maps to points[i - 1].
    eqGeom = { points: points, n: n, padL: padL, plotW: plotW };

    // Grid + Y labels
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const val = min + (t / ticks) * (max - min);
      const yy = y(val);
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(cssW - padR, yy);
      ctx.stroke();
      ctx.fillText(val.toFixed(1) + "%", padL - 8, yy);
    }

    // Zero line
    if (min < 0 && max > 0) {
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.beginPath();
      ctx.moveTo(padL, y(0));
      ctx.lineTo(cssW - padR, y(0));
      ctx.stroke();
    }

    const finalVal = series[n - 1];
    const lineColor = finalVal >= 0 ? "#4ade80" : "#f87171";

    // Area fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, finalVal >= 0 ? "rgba(74,222,128,0.22)" : "rgba(248,113,113,0.22)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.beginPath();
    ctx.moveTo(x(0), y(series[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(series[i]));
    ctx.lineTo(x(n - 1), padT + plotH);
    ctx.lineTo(x(0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(x(0), y(series[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(series[i]));
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // End dot
    ctx.beginPath();
    ctx.arc(x(n - 1), y(series[n - 1]), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();

    // Hover crosshair + marker
    if (hoverIdx != null && hoverIdx >= 1 && hoverIdx <= n - 1) {
      const hx = x(hoverIdx);
      const hy = y(series[hoverIdx]);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hx, padT);
      ctx.lineTo(hx, padT + plotH);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "#0b0f14";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = series[hoverIdx] >= 0 ? "#4ade80" : "#f87171";
      ctx.stroke();
    }

    // X label
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(points.length + " trades", padL + plotW / 2, cssH - 8);
  }

  // Hover tooltip — created once, appended to <body> so it is never clipped
  // by the chart card's overflow:hidden.
  let eqTip = null;
  function ensureTooltip() {
    if (eqTip) return eqTip;
    eqTip = document.createElement("div");
    eqTip.style.cssText =
      "position:fixed;z-index:50;pointer-events:none;display:none;" +
      "min-width:172px;padding:8px 10px;border-radius:10px;" +
      "background:rgba(10,14,20,0.97);border:1px solid rgba(255,255,255,0.14);" +
      "box-shadow:0 8px 24px rgba(0,0,0,0.45);font:12px system-ui,sans-serif;color:#e5e7eb;";
    document.body.appendChild(eqTip);
    return eqTip;
  }

  function tipRow(label, value, valueClass) {
    const c = valueClass === "pos" ? "#4ade80" : valueClass === "neg" ? "#f87171" : "#e5e7eb";
    return (
      '<div style="display:flex;justify-content:space-between;gap:14px;margin-top:3px">' +
      '<span style="color:rgba(255,255,255,0.5)">' + label + "</span>" +
      '<span style="font-weight:700;color:' + c + '">' + value + "</span></div>"
    );
  }

  function onEquityMove(evt) {
    if (!eqGeom || eqGeom.n <= 1) return;
    const canvas = el("equityChart");
    const rect = canvas.getBoundingClientRect();
    const mx = evt.clientX - rect.left;

    // Map cursor x -> nearest series index, clamped to a real trade (>= 1).
    let idx = Math.round(((mx - eqGeom.padL) / eqGeom.plotW) * (eqGeom.n - 1));
    if (idx < 1) idx = 1;
    if (idx > eqGeom.n - 1) idx = eqGeom.n - 1;

    if (idx !== eqHoverIdx) {
      eqHoverIdx = idx;
      drawEquity(eqGeom.points, idx);
    }

    const p = eqGeom.points[idx - 1];
    if (!p) return;

    const tip = ensureTooltip();
    const d = new Date(p.ts);
    const when =
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const meta = [p.dir, p.exitReason]
      .filter(function (s) { return s && s !== "—"; })
      .join(" · ");

    tip.innerHTML =
      '<div style="font-weight:800">' + p.symbol +
      '<span style="float:right;color:rgba(255,255,255,0.45);font-weight:600">' + when + "</span></div>" +
      (meta ? '<div style="color:rgba(255,255,255,0.4);font-size:10.5px;margin-top:1px">' + meta + "</div>" : "") +
      '<div style="height:1px;background:rgba(255,255,255,0.1);margin:6px 0"></div>' +
      tipRow("Trade", signedPct(p.retPct, 3), cls(p.retPct)) +
      tipRow("Cumulative", signedPct(p.cumPct, 2), cls(p.cumPct));

    tip.style.display = "block";

    // Position right of cursor; flip left near the viewport edge.
    const tw = tip.offsetWidth || 190;
    const th = tip.offsetHeight || 120;
    let left = evt.clientX + 16;
    if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 16;
    let top = evt.clientY - th / 2;
    if (top < 8) top = 8;
    if (top + th > window.innerHeight - 8) top = window.innerHeight - 8 - th;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function onEquityLeave() {
    if (eqTip) eqTip.style.display = "none";
    if (eqHoverIdx !== null && eqGeom) {
      eqHoverIdx = null;
      drawEquity(eqGeom.points, null);
    } else {
      eqHoverIdx = null;
    }
  }

  // -----------------------------
  // Breakdown tables
  // -----------------------------
  function renderTable(wrapId, keyHeader, groups, includePnl) {
    const wrap = el(wrapId);
    if (!wrap) return;

    if (!groups || groups.length === 0) {
      wrap.innerHTML = '<div class="empty-note">No closed trades.</div>';
      return;
    }

    let head =
      "<tr><th>" + keyHeader + "</th>" +
      '<th class="num">Trades</th>' +
      '<th class="num">Win %</th>' +
      '<th class="num">Avg Return</th>' +
      '<th class="num">Total Return</th>' +
      '<th class="num">Avg R</th>';
    if (includePnl) head += '<th class="num">Realized $</th>';
    head += "</tr>";

    const rows = groups
      .map(function (g) {
        const wr = num(g.winRate);
        const wrTxt = wr === null ? "—" : (wr * 100).toFixed(0) + "%";
        const avgR =
          g.avgR === null || g.avgR == null
            ? "—"
            : (g.avgR > 0 ? "+" : "") + g.avgR.toFixed(2) + "R";
        let r =
          "<tr>" +
          '<td><span class="pill">' + g.key + "</span></td>" +
          '<td class="num">' + g.trades + "</td>" +
          '<td class="num">' + wrTxt + "</td>" +
          '<td class="num ' + cls(g.avgReturnPct) + '">' + signedPct(g.avgReturnPct, 3) + "</td>" +
          '<td class="num ' + cls(g.totalReturnPct) + '">' + signedPct(g.totalReturnPct, 2) + "</td>" +
          '<td class="num ' + cls(g.avgR) + '">' + avgR + "</td>";
        if (includePnl) {
          r += '<td class="num ' + cls(g.pnlUsd) + '">' +
            (g.pnlUsd === null || g.pnlUsd == null ? "—" : signedUsd(g.pnlUsd)) + "</td>";
        }
        r += "</tr>";
        return r;
      })
      .join("");

    wrap.innerHTML = "<table><thead>" + head + "</thead><tbody>" + rows + "</tbody></table>";
  }

  // -----------------------------
  // Load + render
  // -----------------------------
  let lastData = null;

  function render(data) {
    lastData = data;
    renderHead(data);
    drawEquity(data.equityCurve || []);
    renderTable("exitReasonWrap", "Exit Reason", data.byExitReason, true);
    renderTable("directionWrap", "Direction", data.byDirection, true);
    renderTable("strategyWrap", "Strategy", data.byStrategy, false);
    renderTable("symbolWrap", "Symbol", data.bySymbol, true);

    const hint = el("rangeHint");
    if (hint && data.firstTradeTs && data.lastTradeTs) {
      const f = new Date(data.firstTradeTs).toLocaleDateString();
      const l = new Date(data.lastTradeTs).toLocaleDateString();
      hint.textContent =
        "Closed trades " + f + " → " + l +
        ". Scored on exit return %. Realized $ shown where broker fills exist.";
    }
  }

  function load() {
    const btn = el("refreshBtn");
    if (btn) btn.disabled = true;

    fetch("/api/analytics")
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok === false) {
          el("headStats").innerHTML =
            '<div class="empty-note">Analytics unavailable: ' +
            ((j && j.error) || "unknown error") + "</div>";
          return;
        }
        render(j);
      })
      .catch(function (e) {
        el("headStats").innerHTML =
          '<div class="empty-note">Failed to load analytics: ' + (e && e.message) + "</div>";
      })
      .finally(function () {
        if (btn) btn.disabled = false;
      });
  }

  window.addEventListener("resize", function () {
    eqHoverIdx = null;
    if (eqTip) eqTip.style.display = "none";
    if (lastData) drawEquity(lastData.equityCurve || []);
  });

  document.addEventListener("DOMContentLoaded", function () {
    const btn = el("refreshBtn");
    if (btn) btn.addEventListener("click", load);

    const eq = el("equityChart");
    if (eq) {
      eq.addEventListener("mousemove", onEquityMove);
      eq.addEventListener("mouseleave", onEquityLeave);
    }

    load();
  });
})();
