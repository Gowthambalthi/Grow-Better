/**
 * gb_scoring_v2/raschke/indicators.js — THE MEASURES THE SETUPS ARE BUILT ON.
 *
 * Linda Raschke's framework is "structure first, tactic second", and the documented setups name
 * their own measures: 14-period ADX above 30, a 20-period EMA for the pullback, swing extremes for
 * invalidation, and increases in range/volume/activity as evidence that real participation arrived.
 * So this module implements exactly those, and nothing speculative on top:
 *
 *   ema(n)          — the pullback magnet (the documented setup uses the 20 EMA)
 *   atr(n)          — Wilders ATR: how big this symbol's bars actually are, which is what makes
 *                     "a 0.4% pullback" mean the same thing on a ₹120 stock and a ₹5,000 one
 *   adx(n)          — Wilder's ADX with +DI/-DI. The >30 threshold is the plan's own number
 *   swings()        — the last confirmed swing high/low: where a stop goes, and the only thing
 *                     that can say a counter-move "failed" without looking at candle counts
 *   rangeStats()    — expansion vs the rolling average range and volume (Raschke's "increase in
 *                     volume, range and activity")
 *   congestion()    — the compression that a breakout must break out OF
 *
 * EVERY FUNCTION IS PURE AND INDEX-BASED, so a backtest can step bar by bar without copying arrays
 * and cannot accidentally read a future bar. That last property is the whole reason this is a
 * separate module: the classic way a bar backtest lies is by measuring a swing with bars that had
 * not happened yet, and `swings(bars, i)` only ever sees `bars[0..i]`.
 *
 * Bars are normalized to { t, o, h, l, c, v } by `norm()`; raw Angel rows ([ts,o,h,l,c,v]) are
 * accepted directly so the same functions run on live bars and on the fetched dataset.
 */

function norm(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((b) => {
      if (Array.isArray(b)) {
        const t = b[0] && typeof b[0] === 'string' && b[0].includes('T') || typeof b[0] === 'string'
          ? Date.parse(String(b[0]).replace(' ', 'T') + (String(b[0]).length === 16 ? ':00+05:30' : ''))
          : Number(b[0]);
        return { t, o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[5] };
      }
      return { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +b.v };
    })
    .filter((b) => b && b.c > 0 && isFinite(b.c));
}

/** ema(bars, n, i) — EMA of closes up to and including index i. */
function ema(bars, n, i = bars.length - 1) {
  if (i < n - 1) return null;
  const k = 2 / (n + 1);
  let e = bars[i - n + 1].c;                  // seed with the first close in the window
  for (let j = i - n + 2; j <= i; j++) e = bars[j].c * k + e * (1 - k);
  return e;
}

/** Whole-series EMA (one pass) — for callers that need every value (charts, studies). */
function emaSeries(bars, n) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < n) return out;
  const k = 2 / (n + 1);
  let e = bars[n - 1].c;
  for (let j = n; j < bars.length; j++) e = bars[j].c * k + e * (1 - k);
  // forward-fill backwards so every index >= n-1 has a value
  let cur = bars[n - 1].c;
  out[n - 1] = cur;
  for (let j = n; j < bars.length; j++) { cur = bars[j].c * k + cur * (1 - k); out[j] = cur; }
  return out;
}

/** trueRange(bars, i) — Wilder's true range for one bar. */
function trueRange(bars, i) {
  const b = bars[i];
  if (!b) return null;
  if (i === 0) return b.h - b.l;
  const pc = bars[i - 1].c;
  return Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
}

/** atr(bars, n, i) — Wilder ATR up to index i (null until the window exists). */
function atr(bars, n = 14, i = bars.length - 1) {
  if (i < n) return null;
  let a = 0;
  for (let j = i - n + 1; j <= i; j++) a += trueRange(bars, j);
  return a / n;
}

/**
 * adx(bars, n, i) — Wilder's ADX with +DI/-DI up to index i.
 * Returns { adx, plusDI, minusDI, up } or null while the window is still filling.
 * The documented setup's threshold is 30, and the DIRECTION comes from which DI dominates — an
 * ADX above 30 with -DI on top is a strong DOWN trend, which the naive "adx > 30 = trending" read
 * gets exactly backwards.
 */
function adx(bars, n = 14, i = bars.length - 1) {
  if (i < 2 * n) return null;
  let tr = 0, pdm = 0, ndm = 0;
  const start = i - n + 1;
  for (let j = start; j <= i; j++) {
    const b = bars[j], p = bars[j - 1];
    tr += trueRange(bars, j);
    const up = b.h - p.h;
    const dn = p.l - b.l;
    pdm += up > dn && up > 0 ? up : 0;
    ndm += dn > up && dn > 0 ? dn : 0;
  }
  if (tr <= 0) return null;
  const pDI = (pdm / tr) * 100;
  const nDI = (ndm / tr) * 100;
  const sum = pDI + nDI;
  const dx = sum > 0 ? (Math.abs(pDI - nDI) / sum) * 100 : 0;
  // one more smoothing pass over successive DX values, the standard Wilder approximation
  let dxSum = 0, cnt = 0;
  for (let k = Math.max(n, i - n); k <= i; k++) {
    const r = adxRaw(bars, n, k);
    if (r != null) { dxSum += r.dx; cnt++; }
  }
  const smoothed = cnt ? dxSum / cnt : dx;
  return { adx: +smoothed.toFixed(1), plusDI: +pDI.toFixed(1), minusDI: +nDI.toFixed(1), up: pDI > nDI };
}

function adxRaw(bars, n, i) {
  if (i < n) return null;
  let tr = 0, pdm = 0, ndm = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const b = bars[j], p = bars[j - 1];
    tr += trueRange(bars, j);
    const up = b.h - p.h;
    const dn = p.l - b.l;
    pdm += up > dn && up > 0 ? up : 0;
    ndm += dn > up && dn > 0 ? dn : 0;
  }
  if (tr <= 0) return null;
  const pDI = (pdm / tr) * 100, nDI = (ndm / tr) * 100;
  const s = pDI + nDI;
  return { dx: s > 0 ? (Math.abs(pDI - nDI) / s) * 100 : 0, pDI, nDI };
}

/**
 * swings(bars, i, lookback, strength) — the last CONFIRMED swing high and low at or before i.
 * A pivot needs `strength` bars on EACH side with lower highs (or higher lows), so the newest
 * `strength` bars can never be a confirmed pivot: no look-ahead, by construction.
 */
function swings(bars, i = bars.length - 1, lookback = 30, strength = 2) {
  let high = null, highAt = null, low = null, lowAt = null;
  const from = Math.max(strength, i - lookback);
  for (let j = from; j <= i - strength; j++) {
    let isHigh = true, isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (bars[j].h <= bars[j - k].h || bars[j].h <= bars[j + k].h) isHigh = false;
      if (bars[j].l >= bars[j - k].l || bars[j].l >= bars[j + k].l) isLow = false;
    }
    if (isHigh && (highAt == null || j > highAt)) { high = bars[j].h; highAt = j; }
    if (isLow && (lowAt == null || j > lowAt)) { low = bars[j].l; lowAt = j; }
  }
  return { high, highAt, low, lowAt };
}

/** rangeStats(bars, i, n) — the CURRENT bar against the rolling average range and volume. */
function rangeStats(bars, i = bars.length - 1, n = 20) {
  if (i < n) return null;
  const cur = bars[i];
  let rSum = 0, vSum = 0;
  for (let j = i - n; j < i; j++) { rSum += bars[j].h - bars[j].l; vSum += bars[j].v; }
  const avgRange = rSum / n, avgVol = vSum / n;
  const curRange = cur.h - cur.l;
  return {
    curRange, avgRange,
    curVol: cur.v, avgVol,
    rangeRatio: avgRange > 0 ? +(curRange / avgRange).toFixed(3) : null,
    volRatio: avgVol > 0 ? +(cur.v / avgVol).toFixed(3) : null,
  };
}

/**
 * congestion(bars, i, minBars, maxRangeFrac) — is the market rotating inside a tight range?
 * True when each of the last `minBars` bars' ranges is under `maxRangeFrac` of the symbol's ATR,
 * and the closed range of that stretch is itself small. This is the "consolidation" the plan's
 * Impulse step comes out of, and the box a congestion breakout must escape.
 */
function congestion(bars, i = bars.length - 1, minBars = 8, maxRangeFrac = 0.9) {
  const a = atr(bars, 14, i);
  if (a == null || i < minBars) return null;
  let hi = -Infinity, lo = Infinity, wide = 0;
  for (let j = i - minBars + 1; j <= i; j++) {
    if (bars[j].h - bars[j].l > a * maxRangeFrac) wide++;
    hi = Math.max(hi, bars[j].h);
    lo = Math.min(lo, bars[j].l);
  }
  return { hi, lo, width: hi - lo, widthAtr: a > 0 ? +((hi - lo) / a).toFixed(2) : null, wide, tight: wide === 0, atr: a };
}

/** slopePct(closes, n) — the % change of an EMA over `n` bars, the trend's own strength. */
function slopePct(series, i, n) {
  if (!series || i < n || series[i] == null || series[i - n] == null || series[i - n] === 0) return null;
  return +(((series[i] - series[i - n]) / series[i - n]) * 100).toFixed(3);
}

/** aggregate(bars, minutes) — 1m bars into higher-timeframe bars (5m/15m) for context and structure. */
function aggregate(bars, minutes) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const bucketMs = minutes * 60000;
  const out = [];
  for (const b of bars) {
    const bucket = Math.floor(b.t / bucketMs) * bucketMs;
    const last = out[out.length - 1];
    if (last && last.t === bucket) {
      last.h = Math.max(last.h, b.h);
      last.l = Math.min(last.l, b.l);
      last.c = b.c;
      last.v += b.v;
    } else {
      out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
  }
  return out;
}

/*
 * ---------------------------------------------------------------------------
 * INDICATORS ADDED FOR THE EXTERNAL (GITHUB) STRATEGIES
 * ---------------------------------------------------------------------------
 * The strategies ported from the reviewed public repos name measures Raschke's setups do not:
 * RSI, session VWAP, Bollinger bands, Supertrend and Donchian channels. They live HERE rather than
 * in the porting module so there is one implementation of each, and so they inherit the same
 * causality rule the rest of this file is built on: a value at index i is computed from bars[0..i]
 * only. Every series below is a single forward pass with no backward reference, which is what makes
 * a bar-by-bar backtest on them honest.
 */

/** rsiSeries(bars, n) — Wilder's RSI, one pass, null until the window fills. */
function rsiSeries(bars, n = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / n, al = loss / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    ag = (ag * (n - 1) + (d > 0 ? d : 0)) / n;
    al = (al * (n - 1) + (d < 0 ? -d : 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** sessionKeyOf(ts) — the IST session day (YYYY-MM-DD) a timestamp belongs to. */
function sessionKeyOf(ts) {
  return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
}

/**
 * vwapSeries(bars) — session-anchored VWAP (typical price weighted by volume), reset each IST day.
 *
 * THE RESET IS THE POINT. A "VWAP" carried across days is a moving average with a fancy name, and
 * the two strategies that use this (the VWAP reversion fade and the AI-trader momentum breakout)
 * both mean the intraday benchmark their own docs describe: price's distance from where the session
 * actually traded. A long-lived process must not blend yesterday's volume into today's level.
 */
function vwapSeries(bars) {
  const out = new Array(bars.length).fill(null);
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const k = sessionKeyOf(bars[i].t);
    if (k !== day) { day = k; pv = 0; vol = 0; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    const v = bars[i].v > 0 ? bars[i].v : 1;      // a zero-volume bar must not blank the level
    pv += tp * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

/**
 * bollingerSeries(bars, n, k) — SMA mid, k-sigma bands, and the bandwidth as a PERCENT of the mid.
 * `bandwidth` is in percent (not a fraction) because that is the unit the squeezing strategy states
 * its threshold in (1.2 = 1.2%), and mixing the two is the classic way a filter silently stops
 * filtering.
 */
function bollingerSeries(bars, n = 20, k = 2) {
  const upper = new Array(bars.length).fill(null);
  const mid = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  const bandwidth = new Array(bars.length).fill(null);
  if (bars.length < n) return { upper, mid, lower, bandwidth };
  let sum = 0, sum2 = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].c;
    sum += c; sum2 += c * c;
    if (i >= n) { const o = bars[i - n].c; sum -= o; sum2 -= o * o; }
    if (i < n - 1) continue;
    const m = sum / n;
    const varr = Math.max(0, sum2 / n - m * m);
    const sd = Math.sqrt(varr);
    mid[i] = m; upper[i] = m + k * sd; lower[i] = m - k * sd;
    bandwidth[i] = m > 0 ? ((upper[i] - lower[i]) / m) * 100 : null;
  }
  return { upper, mid, lower, bandwidth };
}

/**
 * supertrendSeries(bars, n, mult) — ATR-banded trailing stop plus its direction (+1/-1).
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE INDICATOR, and getting it wrong is silent. The bands ratchet
 * against the PREVIOUS bar's final bands and the PREVIOUS close; the direction flip is then tested
 * against those PREVIOUS bands. This implementation first computed the new bands, then tested the
 * flip against them — which is a much harder test to satisfy, and the result was a direction series
 * that never flipped at all (890 bars of +1, zero of -1, zero flips) while still looking like a
 * plausible trending line. A strategy built on it would have traded one direction for a year and
 * appeared to be a working trend system rather than a broken indicator.
 *
 * So: read the previous state, ratchet from it, test the flip from it, then store. `prevDir` carries
 * the last direction forward so a bar that breaks neither band keeps the trend it was in.
 */
function supertrendSeries(bars, n = 10, mult = 2) {
  const line = new Array(bars.length).fill(null);
  const dir = new Array(bars.length).fill(null);
  if (bars.length < n + 1) return { line, dir };
  let fu = null, fl = null, prevDir = null;
  for (let i = 0; i < bars.length; i++) {
    const a = atr(bars, n, i);
    if (a == null || !isFinite(a)) continue;
    const hl2 = (bars[i].h + bars[i].l) / 2;
    const ub = hl2 + mult * a, lb = hl2 - mult * a;
    const prevC = i > 0 ? bars[i - 1].c : bars[i].c;
    const c = bars[i].c;

    // --- the bands, ratcheted from the PREVIOUS bar's final bands ---
    const fuPrev = fu, flPrev = fl;
    fu = (fuPrev == null || ub < fuPrev || prevC > fuPrev) ? ub : fuPrev;
    fl = (flPrev == null || lb > flPrev || prevC < flPrev) ? lb : flPrev;

    // --- the flip, tested against the PREVIOUS bar's final bands ---
    let d;
    if (fuPrev == null || flPrev == null) d = c >= hl2 ? 1 : -1;      // seed on the first usable bar
    else if (c > fuPrev) d = 1;
    else if (c < flPrev) d = -1;
    else d = prevDir == null ? 1 : prevDir;

    dir[i] = d;
    line[i] = d === 1 ? fl : fu;
    prevDir = d;
  }
  return { line, dir };
}

/**
 * donchianSeries(bars, n) — the highest high / lowest low of the PREVIOUS n bars, shifted by one.
 *
 * THE SHIFT IS LOAD-BEARING. Including bar i would make the level the bar is being tested against
 * partly defined by the bar itself, so "price closed above the 20-bar high" would be true for any
 * new high — i.e. always. Excluding the current bar is what makes the breakout test test anything.
 */
function donchianSeries(bars, n = 20) {
  const upper = new Array(bars.length).fill(null);
  const lower = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    if (i < n) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - n; j < i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
    upper[i] = hi; lower[i] = lo;
  }
  return { upper, lower };
}

module.exports = {
  norm, ema, emaSeries, atr, trueRange, adx, adxRaw, swings, rangeStats, congestion, slopePct, aggregate,
  rsiSeries, vwapSeries, bollingerSeries, supertrendSeries, donchianSeries, sessionKeyOf,
};
