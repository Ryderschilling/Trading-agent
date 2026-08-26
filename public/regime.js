/* Day Regime page — read-only view over GET /api/regime. */
(function () {
  var state = { data: null, strategy: null };

  function n(v, d) { return v == null || !isFinite(v) ? (d == null ? "—" : d) : v; }
  function pct(v) { return (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%"; }
  function usd(v) { return (v > 0 ? "+$" : v < 0 ? "-$" : "$") + Math.abs(Math.round(v)).toLocaleString(); }
  function cls(v) { return v > 0 ? "pos" : v < 0 ? "neg" : "mut"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function load() {
    var q = state.strategy == null ? "" : "?strategy=" + encodeURIComponent(state.strategy);
    fetch("/api/regime" + q)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) { document.getElementById("sub").textContent = (d && d.error) || "unavailable"; return; }
        state.data = d;
        render();
      })
      .catch(function (e) { document.getElementById("sub").textContent = "error: " + e.message; });
  }

  function renderFilters() {
    var d = state.data, el = document.getElementById("filters");
    var vs = (d.strategies || []);
    var html = '<button data-v="all" class="' + (state.strategy == null ? "on" : "") + '">All strategies</button>';
    vs.forEach(function (v) {
      html += '<button data-v="' + v + '" class="' + (state.strategy === v ? "on" : "") + '">v' + v + "</button>";
    });
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll("button"), function (b) {
      b.onclick = function () {
        var v = b.getAttribute("data-v");
        state.strategy = v === "all" ? null : Number(v);
        load();
      };
    });
  }

  function renderToday() {
    var d = state.data, el = document.getElementById("today");
    var t = (d.perDay || [])[0];
    if (!t) { el.innerHTML = '<div class="muted-note">No session recorded yet. The first snapshot writes at 09:35 ET.</div>'; return; }
    var qc = t.volQuintile ? "q" + t.volQuintile : "";
    el.innerHTML =
      '<div class="rgrid"><div class="rcard">' +
        "<h3>" + esc(t.dayKey) + "</h3>" +
        '<div class="desc">Snapshot taken at 09:35 ET.</div>' +
        '<div class="today">' +
          '<div class="tbox"><div class="k">Vol score</div><div class="v">' + n(t.volScore) + "</div></div>" +
          '<div class="tbox"><div class="k">Quintile</div><div class="v"><span class="qbadge ' + qc + '">Q' + (t.volQuintile || "?") + "</span></div></div>" +
          '<div class="tbox"><div class="k">Trades</div><div class="v">' + t.trades + "</div></div>" +
          '<div class="tbox"><div class="k">Result</div><div class="v ' + cls(t.sumPct) + '">' + pct(t.sumPct) + "</div></div>" +
        "</div></div>" +
      '<div class="rcard"><h3>Ranked movers at 09:35</h3>' +
        '<div class="desc">Top five by own 5-day average range plus first five minutes’ range. Green means the agent actually traded it today.</div>' +
        '<div>' + renderChips(t) + "</div>" +
      "</div></div>";
  }

  function renderChips(t) {
    var traded = {};
    (t.tradedSymbols || []).forEach(function (s) { traded[s] = 1; });
    return (t.ranks || []).slice(0, 10).map(function (r, i) {
      var top = i < 5;
      return '<span class="chip' + (top ? " hit" : "") + '">' + esc(r.symbol) +
             ' <span style="opacity:.6">' + (r.score * 100).toFixed(2) + "</span></span>";
    }).join("");
  }

  function row(label, s, note) {
    if (!s || !s.n) {
      return "<tr class='thin'><td>" + esc(label) + "</td><td>0</td><td>—</td><td>—</td><td>—</td><td>—</td><td>" + esc(note || "") + "</td></tr>";
    }
    return "<tr><td>" + esc(label) + "</td>" +
      "<td>" + s.n + "</td>" +
      "<td class='" + cls(s.sumPct) + "'>" + pct(s.sumPct) + "</td>" +
      "<td class='" + cls(s.avgPct) + "'>" + (s.avgPct > 0 ? "+" : "") + s.avgPct.toFixed(3) + "%</td>" +
      "<td>" + Math.round(s.winRate * 100) + "%</td>" +
      "<td class='" + cls(s.dollars) + "'>" + usd(s.dollars) + "</td>" +
      "<td class='mut'>" + esc(note || "") + "</td></tr>";
  }

  function renderQuintiles() {
    var d = state.data, q = d.byQuintile || {};
    var head = "<thead><tr><th>Quintile</th><th>Trades</th><th>Sum %</th><th>Avg %</th><th>Win rate</th><th>Dollars</th><th>Note</th></tr></thead><tbody>";
    var labels = { 1: "Q1 — most volatile", 2: "Q2", 3: "Q3", 4: "Q4", 5: "Q5 — quietest" };
    var body = "";
    [1, 2, 3, 4, 5].forEach(function (k) { body += row(labels[k], q[String(k)]); });
    body += row("No snapshot", q.unknown, "traded before the tracker existed");
    document.getElementById("qtbl").innerHTML = head + body + "</tbody>";
  }

  function renderRank() {
    var d = state.data, r = d.byRank || {};
    var head = "<thead><tr><th>Bucket</th><th>Trades</th><th>Sum %</th><th>Avg %</th><th>Win rate</th><th>Dollars</th><th>Note</th></tr></thead><tbody>";
    var body = row("Inside the day's top 5", r.inTop) +
               row("Outside the top 5", r.outside) +
               row("No snapshot", r.unknown, "traded before the tracker existed");
    document.getElementById("rtbl").innerHTML = head + body + "</tbody>";
  }

  function renderDays() {
    var d = state.data;
    var head = "<thead><tr><th>Session</th><th>Vol score</th><th>Q</th><th>Top 5 at 09:35</th><th>Trades</th><th>Sum %</th><th>Dollars</th></tr></thead><tbody>";
    var body = (d.perDay || []).map(function (t) {
      return "<tr><td>" + esc(t.dayKey) + "</td>" +
        "<td>" + n(t.volScore) + "</td>" +
        '<td><span class="qbadge q' + (t.volQuintile || "") + '">Q' + (t.volQuintile || "?") + "</span></td>" +
        '<td class="mut">' + esc((t.topSymbols || []).join(", ") || "—") + "</td>" +
        "<td>" + t.trades + "</td>" +
        "<td class='" + cls(t.sumPct) + "'>" + (t.trades ? pct(t.sumPct) : "—") + "</td>" +
        "<td class='" + cls(t.dollars) + "'>" + (t.trades ? usd(t.dollars) : "—") + "</td></tr>";
    }).join("");
    document.getElementById("dtbl").innerHTML = head + (body || "<tr class='thin'><td colspan='7'>Nothing recorded yet.</td></tr>") + "</tbody>";
  }

  function render() {
    var d = state.data;
    document.getElementById("sub").textContent =
      d.daysRecorded + " session" + (d.daysRecorded === 1 ? "" : "s") + " recorded · " +
      d.tradesScored + " scored trades · " + d.tradesWithRankCoverage + " with rank coverage" +
      (state.strategy == null ? "" : " · v" + state.strategy + " only");
    renderFilters();
    renderToday();
    renderQuintiles();
    renderRank();
    renderDays();
  }

  load();
  setInterval(load, 60000);
})();
