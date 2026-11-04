'use strict';

/**
 * strategy-core/patternLibrary.js — A LOT OF PATTERNS, each defined once, no look-ahead.
 *
 * Every detector takes `sessions` whose LAST element is the decision day, and may read only
 * bars at or before it. Each returns `null` when the shape is absent, or an object with at
 * least `{ hit }` (true = the decision day completed the pattern's trigger).
 *
 * The library exists so that a pattern can be compared against every other pattern on the
 * SAME outcome, instead of one at a time and never ranked. It is deliberately mechanical:
 * textbook definitions with explicit windows, thresholds as parameters.
 */

const { cupAndHandle } = require('./patterns');

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const hh = (s, from, to) => { let m = -Infinity; for (let i = from; i < to; i++) if (s[i].high > m) m = s[i].high; return m; };
const ll = (s, from, to) => { let m = Infinity; for (let i = from; i < to; i++) if (s[i].low < m) m = s[i].low; return m; };

function ema(values, period) {
  if (!values.length) return null;
  const k = 2 / (period + 1);
  let v = values[0];
  for (let i = 1; i < values.length; i++) v = (values[i] - v) * k + v;
  return v;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - (100 / (1 + rs));
}

function swings(s, from, to) {
  // local minima by low, spacing 1
  const out = [];
  for (let i = from + 1; i < to - 1; i++) {
    if (s[i].low <= s[i - 1].low && s[i].low <= s[i + 1].low) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the patterns
// ---------------------------------------------------------------------------
function doubleBottom(s, o) {
  const cfg = { win: 60, tol: 0.05, peakPct: 0.06, ...o };
  const n = s.length; if (n < cfg.win + 1) return null;
  const a = n - cfg.win, b = n - 1;
  const mid = Math.floor((a + b) / 2);
  const low1 = ll(s, a, mid), low2 = ll(s, mid, b);
  if (!(low1 > 0) || !(low2 > 0)) return null;
  if (Math.abs(low2 / low1 - 1) > cfg.tol) return null;
  const peak = hh(s, a, b);
  const neck = peak;
  if ((neck / Math.min(low1, low2)) - 1 < cfg.peakPct) return null;
  return { hit: s[b].close > neck, neck, low1, low2, depthPct: ((neck - Math.min(low1, low2)) / neck) * 100 };
}

function tripleBottom(s, o) {
  const cfg = { win: 80, tol: 0.04, peakPct: 0.05, ...o };
  const n = s.length; if (n < cfg.win + 1) return null;
  const a = n - cfg.win, b = n - 1;
  const w = Math.floor(cfg.win / 3);
  const l1 = ll(s, a, a + w), l2 = ll(s, a + w, a + 2 * w), l3 = ll(s, a + 2 * w, b);
  if (!(l1 > 0 && l2 > 0 && l3 > 0)) return null;
  const m = (l1 + l2 + l3) / 3;
  if (Math.max(Math.abs(l1 / m - 1), Math.abs(l2 / m - 1), Math.abs(l3 / m - 1)) > cfg.tol) return null;
  const neck = hh(s, a, b);
  if (neck / m - 1 < cfg.peakPct) return null;
  return { hit: s[b].close > neck, neck };
}

function inverseHeadShoulders(s, o) {
  const cfg = { win: 80, shoulderTol: 0.06, ...o };
  const n = s.length; if (n < cfg.win + 1) return null;
  const a = n - cfg.win, b = n - 1;
  const w = Math.floor(cfg.win / 3);
  const ls = ll(s, a, a + w);
  const head = ll(s, a + w, a + 2 * w);
  const rs = ll(s, a + 2 * w, b);
  if (!(ls > 0 && head > 0 && rs > 0)) return null;
  if (!(head < ls && head < rs)) return null;                 // head must be the lowest
  if (Math.abs(rs / ls - 1) > cfg.shoulderTol) return null;    // shoulders roughly level
  const neck = Math.min(hh(s, a, a + w), hh(s, a + 2 * w, b));
  return { hit: s[b].close > neck, neck, head, ls, rs };
}

function ascendingTriangle(s, o) {
  const cfg = { win: 50, flatTol: 0.02, minTouchSep: 12, minPullbackPct: 3.5, ...o };
  const n = s.length; if (n < cfg.win + 1) return null;
  const a = n - cfg.win, b = n - 1;
  const res = hh(s, a, b);

  // Find distinct ceiling touches
  const touchIndices = [];
  for (let i = a; i < b; i++) if (s[i].high >= res * (1 - cfg.flatTol)) touchIndices.push(i);
  if (touchIndices.length < 2) return null;

  // Separation: First and last touch must be separated by at least minTouchSep bars
  if (touchIndices[touchIndices.length - 1] - touchIndices[0] < cfg.minTouchSep) return null;

  // Intervening trough pullback check
  let midTrough = Infinity;
  for (let i = touchIndices[0]; i <= touchIndices[touchIndices.length - 1]; i++) {
    if (s[i].low < midTrough) midTrough = s[i].low;
  }
  const pullbackPct = ((res - midTrough) / res) * 100;
  if (pullbackPct < cfg.minPullbackPct) return null; // Reject flat clumps

  // Confirmed rising swing lows
  const mid = a + Math.floor(cfg.win / 2);
  const firstHalfLow = ll(s, a, mid);
  const secondHalfLow = ll(s, mid, b);
  if (!(secondHalfLow >= firstHalfLow * 1.015)) return null; // Lows must strictly RISE

  return { hit: s[b].close > res, resistance: res, touches: touchIndices.length, pullbackPct };
}

function rectangleBreakout(s, o) {
  const cfg = { win: 30, maxRangePct: 12, ...o };
  const n = s.length; if (n < cfg.win + 1) return null;
  const a = n - cfg.win, b = n - 1;
  const hi = hh(s, a, b), lo = ll(s, a, b);
  const rangePct = ((hi - lo) / lo) * 100;
  if (!(rangePct <= cfg.maxRangePct)) return null;
  return { hit: s[b].close > hi, hi, lo, rangePct };
}

function bullFlag(s, o) {
  const cfg = { poleWin: 12, flagWin: 7, minPolePct: 12, maxRetraceFrac: 0.6, ...o };
  const n = s.length; if (n < cfg.poleWin + cfg.flagWin + 2) return null;
  const poleEnd = n - cfg.flagWin;
  const poleStart = poleEnd - cfg.poleWin;
  const poleLow = ll(s, poleStart, poleEnd), poleHigh = hh(s, poleStart, poleEnd);
  const polePct = ((poleHigh / poleLow) - 1) * 100;
  if (polePct < cfg.minPolePct) return null;
  const flagHigh = hh(s, poleEnd, n - 1), flagLow = ll(s, poleEnd, n - 1);
  if (!(flagLow > 0)) return null;
  const retrace = (flagHigh - flagLow) / (poleHigh - poleLow);
  if (retrace > cfg.maxRetraceFrac) return null;
  return { hit: s[n - 1].close > flagHigh, polePct, retrace };
}

function highTightFlag(s, o) {
  const cfg = { runWin: 15, flagWin: 10, minRunPct: 25, maxFlagPct: 12, ...o };
  const n = s.length; if (n < cfg.runWin + cfg.flagWin + 2) return null;
  const flagStart = n - cfg.flagWin;
  const runStart = flagStart - cfg.runWin;
  const runLow = ll(s, runStart, flagStart), runHigh = hh(s, runStart, flagStart);
  const runPct = ((runHigh / runLow) - 1) * 100;
  if (runPct < cfg.minRunPct) return null;
  const fh = hh(s, flagStart, n - 1), fl = ll(s, flagStart, n - 1);
  const flagPct = ((fh / fl) - 1) * 100;
  if (!(flagPct <= cfg.maxFlagPct)) return null;
  return { hit: s[n - 1].close > fh, runPct, flagPct };
}

function baseOnBase(s, o) {
  const cfg = { boxWin: 20, maxRangePct: 14, ...o };
  const n = s.length; if (n < cfg.boxWin * 2 + 2) return null;
  const b2a = n - cfg.boxWin, b1a = b2a - cfg.boxWin;
  const h1 = hh(s, b1a, b2a), l1 = ll(s, b1a, b2a);
  const h2 = hh(s, b2a, n - 1), l2 = ll(s, b2a, n - 1);
  const r1 = ((h1 - l1) / l1) * 100, r2 = ((h2 - l2) / l2) * 100;
  if (!(r1 <= cfg.maxRangePct && r2 <= cfg.maxRangePct)) return null;
  if (!(l2 >= l1)) return null;             // the second box must sit ON the first
  return { hit: s[n - 1].close > h2, h1, h2 };
}

function vReversal(s, o) {
  const cfg = { dropWin: 10, riseWin: 5, minDropPct: 15, minRisePct: 8, ...o };
  const n = s.length; if (n < cfg.dropWin + cfg.riseWin + 2) return null;
  const riseStart = n - cfg.riseWin;
  const dropStart = riseStart - cfg.dropWin;
  const from = s[dropStart].close, bottom = ll(s, dropStart, riseStart);
  const dropPct = ((from - bottom) / from) * 100;
  if (dropPct < cfg.minDropPct) return null;
  const risePct = ((s[n - 1].close / bottom) - 1) * 100;
  return { hit: risePct >= cfg.minRisePct, dropPct, risePct };
}

function nr7Breakout(s, o) {
  const cfg = { look: 7, ...o };
  const n = s.length; if (n < cfg.look + 2) return null;
  const ranges = [];
  for (let i = n - cfg.look; i < n - 1; i++) ranges.push(s[i].high - s[i].low);
  const minRange = Math.min(...ranges);
  const narrows = ranges.every((r) => r >= minRange);
  if (!narrows) return null;
  const trig = hh(s, n - cfg.look, n - 1);
  return { hit: s[n - 1].close > trig, trig };
}

function squeezeBreakout(s, o) {
  const cfg = { look: 10, ratio: 0.7, ...o };
  const n = s.length; if (n < 30) return null;
  const atr = (from, to) => {
    let sum = 0;
    for (let i = from + 1; i < to; i++) {
      const pc = s[i - 1].close;
      sum += Math.max(s[i].high - s[i].low, Math.abs(s[i].high - pc), Math.abs(s[i].low - pc));
    }
    return sum / (to - from - 1);
  };
  const a5 = atr(n - 6, n - 1), a20 = atr(n - 21, n - 1);
  if (!(a20 > 0)) return null;
  if (a5 / a20 > cfg.ratio) return null;
  const trig = hh(s, n - cfg.look, n - 1);
  return { hit: s[n - 1].close > trig, squeeze: a5 / a20 };
}

function gapUpBreakaway(s, o) {
  const cfg = { minGapPct: 2, priorWin: 20, ...o };
  const n = s.length; if (n < cfg.priorWin + 2) return null;
  const d = s[n - 1], p = s[n - 2];
  const gapPct = ((d.open / p.close) - 1) * 100;
  if (gapPct < cfg.minGapPct) return null;
  const priorHigh = hh(s, n - 1 - cfg.priorWin, n - 1);
  return { hit: d.close > priorHigh, gapPct, priorHigh };
}

function insideBarBreakout(s, o) {
  const cfg = { ...o };
  const n = s.length; if (n < 4) return null;
  const y = s[n - 2], py = s[n - 3];
  if (!(y.high <= py.high && y.low >= py.low)) return null;
  return { hit: s[n - 1].close > y.high, trigger: y.high };
}

function pullbackToEMA20(s, o) {
  const cfg = { maxDistPct: 1.5, ...o };
  const n = s.length; if (n < 210) return null;
  // ctx carries the EMAs precomputed once per symbol; recomputing them per day would make
  // this O(n^2) for no reason.
  let e20, e50, e200;
  if (cfg.ctx) { e20 = cfg.ctx.ema20; e50 = cfg.ctx.ema50; e200 = cfg.ctx.ema200; }
  else {
    const closes = s.map((x) => x.close);
    e20 = ema(closes.slice(-260), 20); e50 = ema(closes.slice(-300), 50); e200 = ema(closes.slice(-320), 200);
  }
  if (!(e20 && e50 && e200)) return null;
  const d = s[n - 1];
  if (!(d.close > e50 && e50 > e200)) return null;
  const dist = ((d.close / e20) - 1) * 100;
  if (Math.abs(dist) > cfg.maxDistPct) return null;
  return { hit: true, dist };
}

function new52wHighTight(s, o) {
  const cfg = { hiWin: 250, nearPct: 2, tightWin: 10, maxTightPct: 6, ...o };
  const n = s.length; if (n < cfg.hiWin + 1) return null;
  const hi = cfg.ctx && cfg.ctx.hi250 != null ? cfg.ctx.hi250 : hh(s, n - cfg.hiWin, n);
  const d = s[n - 1];
  const fromHigh = ((d.close / hi) - 1) * 100;
  if (fromHigh < -cfg.nearPct) return null;
  const th = hh(s, n - cfg.tightWin, n), tl = ll(s, n - cfg.tightWin, n);
  const tightPct = ((th / tl) - 1) * 100;
  if (tightPct > cfg.maxTightPct) return null;
  return { hit: true, fromHigh, tightPct };
}

function threeUpCloses(s, o) {
  const n = s.length; if (n < 4) return null;
  for (let i = n - 3; i < n; i++) if (!(s[i].close > s[i - 1].close)) return null;
  const d = s[n - 1];
  const loc = (d.close - d.low) / Math.max(1e-9, d.high - d.low);
  return { hit: loc >= 0.6, closeLocation: loc };
}

function oversoldBounce(s, o) {
  const cfg = { minRsi: 30, ...o };
  const n = s.length; if (n < 20) return null;
  for (let i = n - 3; i < n; i++) if (!(s[i].close < s[i - 1].close)) return null;
  const r = rsi(s.map((x) => x.close).slice(-40), 14);
  if (r == null || r > cfg.minRsi) return null;
  return { hit: true, rsi: r };
}

function pocketPivot(s, o) {
  const cfg = { minUpPct: 1, look: 10, ...o };
  const n = s.length; if (n < cfg.look + 2) return null;
  const d = s[n - 1], p = s[n - 2];
  if (!(d.close > p.close * (1 + cfg.minUpPct / 100))) return null;
  let maxDownVol = 0;
  for (let i = n - 1 - cfg.look; i < n - 1; i++) {
    if (s[i].close < s[i - 1].close && s[i].volume > maxDownVol) maxDownVol = s[i].volume;
  }
  if (!(maxDownVol > 0)) return null;
  return { hit: d.volume > maxDownVol, volRatio: d.volume / maxDownVol };
}

function ema20Reclaim(s, o) {
  const n = s.length; if (n < 210) return null;
  let e20Now, e20Prev, e50;
  if (o && o.ctx) { e20Now = o.ctx.ema20; e20Prev = o.ctx.ema20Prev; e50 = o.ctx.ema50; }
  else {
    const closes = s.map((x) => x.close);
    e20Now = ema(closes.slice(-260), 20);
    e20Prev = ema(closes.slice(-261, -1), 20);
    e50 = ema(closes.slice(-300), 50);
  }
  if (!(e20Now && e20Prev && e50)) return null;
  const d = s[n - 1], p = s[n - 2];
  return { hit: p.close < e20Prev && d.close > e20Now && d.close > e50, e20: e20Now };
}

function cupHandle(s, o) {
  const shape = cupAndHandle(s, o);
  if (!shape) return null;
  // the TRIGGER is the close clearing the rim — a formed cup that has not broken out is not
  // the pattern being traded, so it must not be counted as one.
  return Object.assign({ hit: s[s.length - 1].close > shape.rim }, shape);
}

// name -> {fn, note}. `note` is what the shape is, in one line.
const PATTERNS = {
  cupHandle: { fn: cupHandle, note: 'cup and handle, rim cleared' },
  doubleBottom: { fn: doubleBottom, note: 'two equal lows, above the middle peak' },
  tripleBottom: { fn: tripleBottom, note: 'three equal lows, above the peak' },
  inverseHS: { fn: inverseHeadShoulders, note: 'inverse head & shoulders, above neckline' },
  ascendingTri: { fn: ascendingTriangle, note: 'flat resistance, rising lows, break' },
  rectangle: { fn: rectangleBreakout, note: 'tight box, close above the box' },
  bullFlag: { fn: bullFlag, note: 'pole then shallow flag, break' },
  highTightFlag: { fn: highTightFlag, note: 'big run then tight flag, break' },
  baseOnBase: { fn: baseOnBase, note: 'second box stacked on the first' },
  vReversal: { fn: vReversal, note: 'sharp drop then sharp recovery' },
  nr7: { fn: nr7Breakout, note: 'narrowest range of 7, break of the range' },
  squeeze: { fn: squeezeBreakout, note: 'volatility contraction, break' },
  gapUp: { fn: gapUpBreakaway, note: 'gap above 20-session high' },
  insideBar: { fn: insideBarBreakout, note: 'inside day, break of its high' },
  pullbackEMA20: { fn: pullbackToEMA20, note: 'uptrend, price back at the 20 EMA' },
  new52wHighTight: { fn: new52wHighTight, note: 'at the 52-week high, 10-day range tight' },
  threeUp: { fn: threeUpCloses, note: 'three up closes, close near the high' },
  oversold: { fn: oversoldBounce, note: 'three down days with RSI below 30' },
  pocketPivot: { fn: pocketPivot, note: 'up day on volume above all down days' },
  ema20Reclaim: { fn: ema20Reclaim, note: 'crosses back above the 20 EMA' },
};

module.exports = { PATTERNS, ema, rsi };
