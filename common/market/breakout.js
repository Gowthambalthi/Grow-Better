/**
 * common/market/breakout.js — Phase 3: breakout base detection & quality.
 *
 * Task 3.1  Base duration   — consolidation ranges ≥ minBaseBars (default 18,
 *             spec 15–20). Shorter ranges are returned separately as
 *             fast_momentum candidates, not as qualified bases.
 * Task 3.2  Vol contraction — ATR% at base end must be ≤ contractionPct
 *             (default 0.65, spec 0.60–0.70) of ATR% at base start.
 * Task 3.3  Resistance touches — ≥2 distinct rejections at the base resistance
 *             (same logic as zones Task 1.2 applied to highs: within
 *             touchBars bars after the pivot-high, price closes back below
 *             the level by ≥1×ATR).
 * Task 3.4  Volume dry-up   — average volume over the last third of the base
 *             must be ≤ dryUpPct (default 0.85) of the first third's average,
 *             i.e. volume declines through the base.
 *
 * Main API:
 *   detectBases(candles, opts) -> { bases, fast_momentum, rejected }
 *   Each base: { price_low, price_high, start_bar, end_bar, bars, duration,
 *                atr_start_pct, atr_end_pct, contraction_ratio,
 *                resistance_touches, volume_trend_ratio, flags: {...} }
 */
'use strict';

const DEFAULTS = {
  atrPeriod: 14,
  pivotLeft: 3,
  pivotRight: 3,
  minBaseBars: 18,       // spec 15–20
  fastMomentumBars: 10,  // ranges shorter than minBaseBars but ≥ this → fast_momentum
  contractionPct: 0.65,  // spec 0.60–0.70 (ATR% end / ATR% start)
  touchBars: 3,          // rejection window for resistance touches (mirrors Task 1.2)
  minResistanceTouches: 2,
  dryUpPct: 0.85,        // last-third avg vol ≤ 85% of first-third avg vol
  rangeAtrMult: 2.0,     // pivot may sit ≤ 2×medianATR(cluster) from cluster median
  minRangePivots: 3,     // fewer pivots than this is not a consolidation range
};

// ---------- indicators ----------
function atrSeries(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;
  const tr = [0];
  for (let i = 1; i < n; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  out[period] = s / period;
  for (let i = period + 1; i < n; i++) out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  return out;
}

// pivot highs (mirror of zones.pivotLows but for highs)
function pivotHighs(candles, left, right) {
  const n = candles.length;
  const pivots = [];
  for (let i = left; i < n - right; i++) {
    const h = candles[i][2];
    let isPivot = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k !== i && candles[k][2] > h) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, high: h });
  }
  return pivots;
}

function pivotLows(candles, left, right) {
  const n = candles.length;
  const pivots = [];
  for (let i = left; i < n - right; i++) {
    const l = candles[i][3];
    let isPivot = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k !== i && candles[k][3] < l) { isPivot = false; break; }
    }
    if (isPivot) pivots.push({ index: i, low: l });
  }
  return pivots;
}

// ---------- Task 3.1: base (consolidation range) identification ----------
/**
 * Resistance-anchored base detection: cluster pivot HIGHS by price level
 * (a pivot high joins the cluster if it sits within rangeAtrMult × ATR of the
 * cluster's median resistance — same clustering model as zones.js, applied to
 * the resistance side). Each cluster of ≥2 rejections defines a base:
 *
 *   span = first rejection bar → last rejection bar (a consolidation is
 *   *defined* by repeated rejections of the same ceiling)
 *   resistance = median of the clustered pivot highs
 *   support (price_low) = lowest low between the first and last rejection
 */
function findRanges(candles, atrs, opts) {
  const highs = pivotHighs(candles, opts.pivotLeft, opts.pivotRight);

  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // cluster pivot highs by resistance level (chronological)
  const clusters = [];
  let cur = null;
  for (const p of highs) {
    const atr = atrs[p.index];
    if (atr == null || atr <= 0) continue;
    if (!cur) { cur = { prices: [p.high], atrs: [atr], indices: [p.index] }; continue; }
    const med = median(cur.prices);
    const medAtr = median(cur.atrs);
    if (Math.abs(p.high - med) <= opts.rangeAtrMult * medAtr) {
      cur.prices.push(p.high);
      cur.atrs.push(atr);
      cur.indices.push(p.index);
    } else {
      clusters.push(cur);
      cur = { prices: [p.high], atrs: [atr], indices: [p.index] };
    }
  }
  if (cur) clusters.push(cur);

  // to ranges: ≥2 rejections make a base candidate
  const ranges = [];
  for (const cl of clusters) {
    if (cl.indices.length < 2) continue;
    const start_bar = cl.indices[0];
    const end_bar = cl.indices[cl.indices.length - 1];
    let lo = Infinity;
    for (let i = start_bar; i <= end_bar; i++) lo = Math.min(lo, candles[i][3]);
    ranges.push({
      start_bar,
      end_bar,
      bars: end_bar - start_bar + 1,
      price_high: +median(cl.prices).toFixed(2), // resistance level
      price_low: +lo.toFixed(2),
      pivot_highs: cl.indices,
      pivot_lows: [],
    });
  }
  return ranges;
}

// ---------- Task 3.2: volatility contraction ----------
/**
 * Volatility contraction: median bar range (as % of close) over the last third
 * of the base ≤ contractionPct × median bar range% over the first third.
 * Median (not ATR) is used deliberately: ATR is a 14-bar EMA that both lags the
 * contraction AND gets inflated by the rejection spikes that legitimately occur
 * inside the base — both would mask a genuine coil.
 */
function contractionOk(candles, atrs, range, opts) {
  const bars = range.end_bar - range.start_bar + 1;
  const third = Math.max(1, Math.floor(bars / 3));
  const rangePct = i => (candles[i][2] - candles[i][3]) / candles[i][4];
  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const startVals = [], endVals = [];
  for (let i = 0; i < third; i++) {
    startVals.push(rangePct(range.start_bar + i));
    endVals.push(rangePct(range.end_bar - i));
  }
  const atrStartPct = median(startVals);
  const atrEndPct = median(endVals);
  if (!atrStartPct) return { ok: false, reason: 'zero start volatility' };
  const ratio = atrEndPct / atrStartPct;
  return {
    ok: ratio <= opts.contractionPct,
    atr_start_pct: +atrStartPct.toFixed(4),
    atr_end_pct: +atrEndPct.toFixed(4),
    ratio: +ratio.toFixed(3),
    reason: ratio > opts.contractionPct ? `ATR% ratio ${ratio.toFixed(2)} > ${opts.contractionPct}` : null,
  };
}

// ---------- Task 3.3: resistance touch validation ----------
/**
 * A resistance touch = pivot high at/inside the base whose bar is followed,
 * within touchBars bars, by a CLOSE back below (level − 1×ATR of the pivot bar).
 * Distinct touches = qualifying pivot highs at least 3 bars apart.
 */
function validateResistanceTouches(candles, atrs, range, opts) {
  const level = range.price_high;
  const valid = [];
  for (const idx of range.pivot_highs) {
    const atr = atrs[idx];
    if (!atr || atr <= 0) continue;
    const threshold = level - atr; // rejection: closes back below by ≥1×ATR
    let ok = false;
    for (let k = idx + 1; k <= Math.min(idx + opts.touchBars, candles.length - 1); k++) {
      if (candles[k][4] <= threshold) { ok = true; break; }
    }
    if (ok) valid.push(idx);
  }
  // distinct: keep first of any touches within 3 bars of each other
  const distinct = [];
  for (const idx of valid) {
    if (!distinct.length || idx - distinct[distinct.length - 1] > 3) distinct.push(idx);
  }
  return distinct;
}

// ---------- Task 3.4: volume dry-up ----------
function volumeDryUpOk(candles, range, opts) {
  const bars = range.end_bar - range.start_bar + 1;
  if (bars < 9) return { ok: false, reason: 'base too short to split into thirds' };
  const third = Math.floor(bars / 3);
  let firstSum = 0, lastSum = 0;
  for (let i = 0; i < third; i++) firstSum += candles[range.start_bar + i][5];
  for (let i = 0; i < third; i++) lastSum += candles[range.end_bar - i][5];
  const firstAvg = firstSum / third;
  const lastAvg = lastSum / third;
  const ratio = firstAvg > 0 ? lastAvg / firstAvg : 1;
  return {
    ok: ratio <= opts.dryUpPct,
    volume_trend_ratio: +ratio.toFixed(3),
    reason: ratio > opts.dryUpPct ? `last-third volume ${Math.round(ratio * 100)}% of first-third (need ≤ ${Math.round(opts.dryUpPct * 100)}%)` : null,
  };
}

// ---------- main ----------
function detectBases(candles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const atrs = atrSeries(candles, opts.atrPeriod);
  const ranges = findRanges(candles, atrs, opts);

  const bases = [], fast_momentum = [], rejected = [];

  for (const r of ranges) {
    const base = {
      price_low: +r.price_low.toFixed(2),
      price_high: +r.price_high.toFixed(2),
      start_bar: r.start_bar,
      start_date: candles[r.start_bar][0],
      end_bar: r.end_bar,
      end_date: candles[r.end_bar][0],
      bars: r.bars,
      pivot_highs: r.pivot_highs,
      pivot_lows: r.pivot_lows,
      resistance_touches: [],
      flags: {},
      reject_reason: null,
    };

    // Task 3.1 — duration gate
    if (r.bars < opts.minBaseBars) {
      if (r.bars >= opts.fastMomentumBars) {
        base.flags.fast_momentum = true;
        fast_momentum.push(base);
      } else {
        base.reject_reason = `base ${r.bars} bars < ${opts.minBaseBars} (and < fast-momentum floor ${opts.fastMomentumBars})`;
        rejected.push(base);
      }
      continue;
    }

    // Task 3.2 — volatility contraction
    const vc = contractionOk(candles, atrs, r, opts);
    base.atr_start_pct = vc.atr_start_pct;
    base.atr_end_pct = vc.atr_end_pct;
    base.contraction_ratio = vc.ratio;
    if (!vc.ok) {
      base.reject_reason = vc.reason;
      rejected.push(base);
      continue;
    }

    // Task 3.3 — resistance touches
    base.resistance_touches = validateResistanceTouches(candles, atrs, r, opts);
    if (base.resistance_touches.length < opts.minResistanceTouches) {
      base.reject_reason = `resistance touches ${base.resistance_touches.length} < ${opts.minResistanceTouches}`;
      rejected.push(base);
      continue;
    }

    // Task 3.4 — volume dry-up
    const vd = volumeDryUpOk(candles, r, opts);
    base.volume_trend_ratio = vd.volume_trend_ratio;
    if (!vd.ok) {
      base.reject_reason = vd.reason;
      rejected.push(base);
      continue;
    }

    base.flags.qualified = true;
    bases.push(base);
  }

  bases.sort((a, b) => b.end_bar - a.end_bar); // most recent first
  return { bases, fast_momentum, rejected };
}

module.exports = { detectBases, findRanges, validateResistanceTouches, DEFAULTS };
