/* chart-core.js — shared candle chart used by the Outcomes modal and the
   Workspace open-trade modal. Extracted verbatim from outcomes.js so both pages
   render the identical chart. Everything lives inside an IIFE and is published
   on window.ChartCore; nothing here touches the global namespace, which matters
   because app.js and outcomes.js both declare top-level consts of their own. */
(function () {
  "use strict";

  function fmt2(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n.toFixed(2) : "—";
  }

  function normalizeBars(bars1m) {
    return (bars1m || [])
      .map((b) => ({
        ts: Number(b.ts),
        o: Number(b.o),
        h: Number(b.h),
        l: Number(b.l),
        c: Number(b.c),
        v: Number(b.v || 0),
      }))
      .filter((b) => Number.isFinite(b.ts) && [b.o, b.h, b.l, b.c].every(Number.isFinite))
      .sort((a, b) => a.ts - b.ts);
  }

  function aggregateBars(bars1m, timeframeMin) {
    const tf = Math.max(1, Math.floor(Number(timeframeMin || 1)));
    if (!bars1m.length || tf === 1) return bars1m.slice();

    const out = [];
    let cur = null;
    const bucketOf = (ts) => Math.floor(ts / (tf * 60_000)) * (tf * 60_000);

    for (const b of bars1m) {
      const bucket = bucketOf(b.ts);
      if (!cur || cur.bucket !== bucket) {
        if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });
        cur = { bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      } else {
        cur.h = Math.max(cur.h, b.h);
        cur.l = Math.min(cur.l, b.l);
        cur.c = b.c;
        cur.v += b.v;
      }
    }

    if (cur) out.push({ ts: cur.bucket, o: cur.o, h: cur.h, l: cur.l, c: cur.c, v: cur.v });
    return out;
  }

  function vwapSeries(bars) {
    let pv = 0;
    let v = 0;
    const out = [];

    for (const b of bars) {
      const typical = (Number(b.h) + Number(b.l) + Number(b.c)) / 3;
      const vol = Number(b.v || 0);
      if (Number.isFinite(typical) && Number.isFinite(vol) && vol > 0) {
        pv += typical * vol;
        v += vol;
      }
      out.push(v > 0 ? pv / v : null);
    }

    return out;
  }

  function closestIdxByTs(bars, ts) {
    if (!Array.isArray(bars) || !bars.length || !Number.isFinite(Number(ts)) || Number(ts) <= 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < bars.length; i++) {
      const d = Math.abs(Number(bars[i].ts) - Number(ts));
      if (d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }

  function syncCanvasSize(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 1100));
    const height = Math.max(260, Math.round(rect.height || 440));
    const ratio = Math.max(1, window.devicePixelRatio || 1);

    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio;
      canvas.height = height * ratio;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width, height };
  }

  function emaOf(bars, period) {
    if (!bars.length || period <= 0) return [];
    const k = 2 / (period + 1);
    const out = new Array(bars.length).fill(null);
    let ema = null;
    for (let i = 0; i < bars.length; i++) {
      const c = Number(bars[i].c);
      if (!Number.isFinite(c)) continue;
      ema = ema === null ? c : c * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  function drawRoundedLabel(ctx, x, y, text, fillStyle, textStyle) {
    ctx.save();
    ctx.font = "10px system-ui";
    const padX = 6;
    const padY = 3;
    const w = ctx.measureText(text).width + padX * 2;
    const h = 18;
    const r = 8;

    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = textStyle;
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + padX, y + h / 2);
    ctx.restore();
  }

  function drawChart(canvas, bars, opts) {
    if (!canvas) return;

    const { ctx, width: w, height: h } = syncCanvasSize(canvas);
    ctx.clearRect(0, 0, w, h);

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a1220");
    bg.addColorStop(1, "#0d1626");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (!Array.isArray(bars) || !bars.length) {
      ctx.fillStyle = "rgba(231, 237, 246, 0.78)";
      ctx.font = "14px system-ui";
      ctx.fillText("No candles found for this snapshot.", 18, 28);
      return;
    }

    const padTop = 24;
    // Right gutter holds the price axis and the level labels ("PMH 320.41").
    // 62px fit the wide Outcomes modal and clipped everywhere narrower, so the
    // gutter is sized to the widest label this chart can draw.
    const padRight = 96;
    const padBottom = 32;
    const padLeft = 14;
    const plotW = Math.max(40, w - padLeft - padRight);
    const plotH = Math.max(40, h - padTop - padBottom);

    let lo = Infinity;
    let hi = -Infinity;
    for (const b of bars) {
      const lv = Number(b.l);
      const hv = Number(b.h);
      if (Number.isFinite(lv)) lo = Math.min(lo, lv);
      if (Number.isFinite(hv)) hi = Math.max(hi, hv);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return;
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }

    const padPct = (hi - lo) * 0.05;
    lo -= padPct;
    hi += padPct;

    const slotW = plotW / Math.max(1, bars.length);
    const xOf = (idx) => padLeft + slotW * idx + slotW / 2;
    const wickXOf = (idx) => Math.round(xOf(idx)) + 0.5;
    const yOf = (price) => padTop + ((hi - Number(price)) / Math.max(0.0001, hi - lo)) * plotH;

    const gridLevels = 4;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.font = "11px system-ui";
    ctx.fillStyle = "rgba(154, 166, 187, 0.82)";
    for (let i = 0; i < gridLevels; i++) {
      const t = i / Math.max(1, gridLevels - 1);
      const y = padTop + plotH * t;
      const price = hi - (hi - lo) * t;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(w - padRight + 10, y);
      ctx.stroke();
      ctx.fillText(fmt2(price), w - padRight + 14, y + 4);
    }
    ctx.setLineDash([]);

    const entryIdx = closestIdxByTs(bars, opts?.entryTs);
    const exitIdx = closestIdxByTs(bars, opts?.exitTs);

    if (entryIdx != null && exitIdx != null && entryIdx !== exitIdx) {
      const firstIdx = Math.min(entryIdx, exitIdx);
      const lastIdx = Math.max(entryIdx, exitIdx);
      const left = padLeft + slotW * firstIdx;
      const right = padLeft + slotW * (lastIdx + 1);
      ctx.fillStyle = "rgba(93, 169, 255, 0.05)";
      ctx.fillRect(left, padTop, Math.max(2, right - left), plotH);
    }

    // Horizontal S/R levels
    if (Array.isArray(opts?.levels)) {
      for (const lvl of opts.levels) {
        const price = Number(lvl.price);
        if (!Number.isFinite(price) || price < lo || price > hi) continue;
        const y = Math.round(yOf(price)) + 0.5;
        ctx.save();
        ctx.strokeStyle = lvl.color || "rgba(255, 220, 60, 0.7)";
        ctx.lineWidth = lvl.lineWidth || 1.5;
        ctx.setLineDash(lvl.dash || [6, 5]);
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(w - padRight + 10, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (lvl.label) {
          ctx.font = "10px system-ui";
          ctx.fillStyle = lvl.color || "rgba(255, 220, 60, 0.85)";
          ctx.fillText(`${lvl.label} ${fmt2(price)}`, w - padRight + 14, y - 3);
        }
        ctx.restore();
      }
    }

    // EMA lines
    if (Array.isArray(opts?.emas)) {
      for (const emaCfg of opts.emas) {
        const values = emaOf(bars, emaCfg.period);
        ctx.save();
        ctx.strokeStyle = emaCfg.color || "rgba(255, 165, 0, 0.8)";
        ctx.lineWidth = emaCfg.lineWidth || 1.4;
        ctx.setLineDash([]);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          if (v == null) continue;
          const x = xOf(i);
          const y = yOf(v);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        // Label at end
        if (started && values[values.length - 1] != null) {
          const lastVal = values[values.length - 1];
          const ly = yOf(lastVal);
          ctx.font = "9px system-ui";
          ctx.fillStyle = emaCfg.color || "rgba(255, 165, 0, 0.85)";
          ctx.fillText(`${emaCfg.label || `EMA${emaCfg.period}`}`, w - padRight + 14, ly + 3);
        }
        ctx.restore();
      }
    }

    if (opts?.showVwap) {
      const vwap = vwapSeries(bars);
      ctx.strokeStyle = "rgba(125, 191, 255, 0.82)";
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < vwap.length; i++) {
        const v = vwap[i];
        if (v == null) continue;
        const x = xOf(i);
        const y = yOf(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    const widthScale =
      bars.length >= 160 ? 0.5 : bars.length >= 120 ? 0.54 : bars.length >= 90 ? 0.58 : 0.62;
    const bodyW = Math.max(1.8, Math.min(7.5, slotW * widthScale));

    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!Number.isFinite(Number(b.o)) || !Number.isFinite(Number(b.c))) continue;
      const x = xOf(i);
      const wickX = wickXOf(i);
      const yH = yOf(b.h);
      const yL = yOf(b.l);
      const yO = yOf(b.o);
      const yC = yOf(b.c);
      const up = b.c >= b.o;

      ctx.strokeStyle = up ? "rgba(74, 222, 128, 0.85)" : "rgba(248, 113, 113, 0.88)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(wickX, yH);
      ctx.lineTo(wickX, yL);
      ctx.stroke();

      ctx.fillStyle = up ? "rgba(74, 222, 128, 0.95)" : "rgba(248, 113, 113, 0.95)";
      const top = Math.min(yO, yC);
      const height = Math.max(1.5, Math.abs(yC - yO));
      const bodyLeft = Math.round((x - bodyW / 2) * 2) / 2;
      ctx.fillRect(bodyLeft, top, bodyW, height);
    }

    const markerY = padTop + 8;
    const markers = [
      {
        idx: opts?.showEntry !== false ? entryIdx : null,
        label: "Entry",
        lineColor: "rgba(45, 212, 255, 0.95)",
        pillFill: "rgba(45, 212, 255, 0.22)",
        pillText: "#b0f0ff",
      },
      {
        idx: opts?.showExit !== false ? exitIdx : null,
        label: "Exit",
        lineColor: "rgba(251, 113, 133, 0.95)",
        pillFill: "rgba(251, 113, 133, 0.22)",
        pillText: "#ffd0da",
      },
    ];

    for (const marker of markers) {
      if (marker.idx == null) continue;
      const x = wickXOf(marker.idx);

      // Full-height vertical line — dashed
      ctx.save();
      ctx.strokeStyle = marker.lineColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.font = "11px system-ui";
      const labelWidth = ctx.measureText(marker.label).width + 14;
      ctx.restore();
      const clampedX = Math.max(6, Math.min(x - labelWidth / 2, w - labelWidth - 6));
      drawRoundedLabel(ctx, clampedX, markerY, marker.label, marker.pillFill, marker.pillText);
    }

    const labelIndices = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
    const seen = new Set();
    ctx.fillStyle = "rgba(154, 166, 187, 0.84)";
    ctx.font = "11px system-ui";
    for (const idx of labelIndices) {
      if (seen.has(idx) || bars[idx] == null) continue;
      seen.add(idx);
      const x = xOf(idx);
      const ts = Number(bars[idx].ts);
      const text = bars.length > 120 ? fmtTime(ts) : fmtDateTime(ts);
      const measured = ctx.measureText(text).width;
      const clampedX = Math.max(6, Math.min(x - measured / 2, w - measured - 6));
      ctx.fillText(text, clampedX, h - 10);
    }

    // Hover crosshair — vertical line at hovered bar + time/price labels.
    const hoverIdx = Number.isFinite(Number(opts?.hoverIdx)) ? Math.floor(Number(opts.hoverIdx)) : -1;
    if (hoverIdx >= 0 && hoverIdx < bars.length) {
      const hb = bars[hoverIdx];
      const x = wickXOf(hoverIdx);

      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Bottom time pill
      const timeText = fmtDateTime(Number(hb.ts));
      ctx.save();
      ctx.font = "11px system-ui";
      const padX = 8;
      const padY = 4;
      const textW = ctx.measureText(timeText).width;
      const pillW = textW + padX * 2;
      const pillH = 20;
      const pillX = Math.max(4, Math.min(x - pillW / 2, w - pillW - 4));
      const pillY = h - pillH - 2;

      ctx.fillStyle = "rgba(15, 22, 38, 0.95)";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const r = 6;
      ctx.moveTo(pillX + r, pillY);
      ctx.lineTo(pillX + pillW - r, pillY);
      ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + r);
      ctx.lineTo(pillX + pillW, pillY + pillH - r);
      ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - r, pillY + pillH);
      ctx.lineTo(pillX + r, pillY + pillH);
      ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - r);
      ctx.lineTo(pillX, pillY + r);
      ctx.quadraticCurveTo(pillX, pillY, pillX + r, pillY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "rgba(231, 237, 246, 0.95)";
      ctx.textBaseline = "middle";
      ctx.fillText(timeText, pillX + padX, pillY + pillH / 2 + 0.5);
      ctx.restore();

      // Right-side price pill at the bar's close
      const closePx = Number(hb.c);
      if (Number.isFinite(closePx)) {
        const py = yOf(closePx);
        const priceText = fmt2(closePx);
        ctx.save();
        ctx.font = "11px system-ui";
        const tW = ctx.measureText(priceText).width;
        const ppadX = 6;
        const pW = tW + ppadX * 2;
        const pH = 18;
        const pX = Math.min(w - pW - 2, padLeft + plotW + 4);
        const pY = Math.max(padTop, Math.min(py - pH / 2, padTop + plotH - pH));

        ctx.fillStyle = "rgba(15, 22, 38, 0.95)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
        ctx.lineWidth = 1;
        const rr = 5;
        ctx.beginPath();
        ctx.moveTo(pX + rr, pY);
        ctx.lineTo(pX + pW - rr, pY);
        ctx.quadraticCurveTo(pX + pW, pY, pX + pW, pY + rr);
        ctx.lineTo(pX + pW, pY + pH - rr);
        ctx.quadraticCurveTo(pX + pW, pY + pH, pX + pW - rr, pY + pH);
        ctx.lineTo(pX + rr, pY + pH);
        ctx.quadraticCurveTo(pX, pY + pH, pX, pY + pH - rr);
        ctx.lineTo(pX, pY + rr);
        ctx.quadraticCurveTo(pX, pY, pX + rr, pY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "rgba(231, 237, 246, 0.95)";
        ctx.textBaseline = "middle";
        ctx.fillText(priceText, pX + ppadX, pY + pH / 2 + 0.5);
        ctx.restore();
      }
    }
  }

  window.ChartCore = {
    drawChart,
    normalizeBars,
    aggregateBars,
    vwapSeries,
    emaOf,
    closestIdxByTs,
    syncCanvasSize,
    drawRoundedLabel,
  };
})();
