/**
 * common/market/confirmFrames.js — Multi-frame confirmation scoring for
 * Breakout-engine signals.
 *
 * Five independently-derived frames, each computed AS-OF a given bar
 * (no look-ahead). Used two ways:
 *   1. Backtest: score every historical signal, slice pass/fail per frame,
 *      keep only frames that measurably discriminate (marginal contribution).
 *   2. Live: attach frame scores to each Terminal buy so the reason a signal
 *      passed is visible.
 *
 * Frames:
 *   F1 weeklyStructure — weekly HH/HL trend (mtfTrend.weeklyResample +
 *                        swings.structureState). uptrend = pass.
 *   F2 relativeStrength — stock 20-bar return minus benchmark 20-bar
 *                        return >= 0 (date-aligned benchmark candles).
 *   F3 volumeQuality   — breakout-day volume vs its 20-day average, graded.
 *   F4 baseQuality     — composite of base contraction, touches, duration.
 *   F5 extension       — |close − MA20| in ATR units; passed through
 *                        neutrally (measured, not assumed — it has shown
 *                        context-dependent behavior in prior backtests).
 *
 * Candles are [date, open, high, low, close, volume] arrays.
 */
'use strict';

const { weeklyResample } = require('./mtfTrend');
const { structureState } = require('./swings');

// ---------- helpers ----------

function atrAt(candles, i, period = 14) {
  if (i < period + 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const h = candles[k][2], l = candles[k][3], pc = candles[k - 1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / period;
}

function smaClose(candles, endIdx, period) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += candles[i][4];
  return s / period;
}

function retN(candles, i, n) {
  if (i < n || n <= 0) return null;
  const base = candles[i - n][4];
  return base > 0 ? (candles[i][4] - base) / base : null;
}

// ---------- F1: weekly structure ----------

function frameWeeklyStructure(dailyCandles, asOfBar) {
  if (asOfBar < 60) return { pass: null, state: null, reason: 'insufficient history' };
  const weekly = weeklyResample(dailyCandles.slice(0, asOfBar + 1));
  if (weekly.length < 12) return { pass: null, state: null, reason: 'insufficient weekly bars' };
  const st = structureState(weekly, { asOf: weekly.length - 1 });
  return { pass: st.state === 'uptrend', state: st.state, reason: null };
}

// ---------- F2: relative strength vs benchmark ----------

function frameRelativeStrength(stockCandles, asOfBar, benchCandles, bars = 20) {
  const sr = retN(stockCandles, asOfBar, bars);
  if (sr == null) return { pass: null, rs: null, reason: 'insufficient stock history' };
  if (!benchCandles || !benchCandles.length) return { pass: null, rs: null, reason: 'no benchmark data' };
  // align benchmark by date: last bench bar with date <= stock bar date
  const d = stockCandles[asOfBar][0];
  let bIdx = -1;
  for (let k = benchCandles.length - 1; k >= 0; k--) {
    if (benchCandles[k][0] <= d) { bIdx = k; break; }
  }
  const br = retN(benchCandles, bIdx, bars);
  if (br == null) return { pass: null, rs: null, reason: 'insufficient benchmark history' };
  const rs = sr - br;
  return { pass: rs >= 0, rs: +rs.toFixed(4), reason: null };
}

// ---------- F3: volume quality ----------

function frameVolumeQuality(candles, breakoutBar, avgBars = 20) {
  if (breakoutBar < avgBars) return { pass: null, ratio: null, grade: null, reason: 'insufficient history' };
  let s = 0;
  for (let k = breakoutBar - avgBars; k < breakoutBar; k++) s += candles[k][5];
  const avg = s / avgBars;
  if (avg <= 0) return { pass: null, ratio: null, grade: null, reason: 'zero avg volume' };
  const ratio = candles[breakoutBar][5] / avg;
  // pass = clearly above average participation, not just the 1.5x gate
  const grade = ratio >= 3 ? 'heavy' : ratio >= 2 ? 'strong' : ratio >= 1.5 ? 'ok' : 'weak';
  return { pass: ratio >= 1.5, ratio: +ratio.toFixed(2), grade, reason: null };
}

// ---------- F4: base quality ----------

function frameBaseQuality(sig) {
  const base = sig.base || {};
  const bars = base.bars ?? null;
  const touches = base.touches ?? null;
  const contraction = base.contraction_ratio ?? null;
  let score = 0;
  if (bars != null && bars >= 20) score++;
  if (bars != null && bars >= 40) score++;
  if (touches != null && touches >= 3) score++;
  if (contraction != null && contraction <= 0.7) score++;
  if (contraction != null && contraction <= 0.5) score++;
  return { pass: score >= 3, score, bars, touches, contraction, reason: null };
}

// ---------- F5: extension (measured neutrally) ----------

function frameExtension(candles, bar) {
  const ma = smaClose(candles, bar, 20);
  const atr = atrAt(candles, bar);
  if (ma == null || atr == null || atr <= 0) return { pass: null, ext: null, reason: 'insufficient history' };
  const ext = (candles[bar][4] - ma) / atr;
  // pass = NOT extended beyond 2.5 ATR (the GRANULES failure mode), but the
  // exact threshold is a measurement question — the raw value is reported.
  return { pass: ext <= 2.5, ext: +ext.toFixed(2), reason: null };
}

// ---------- aggregate ----------

/**
 * scoreFrames({ stockCandles, sig, benchmarkCandles }) -> frame object:
 *   { f1: {pass, state}, f2: {pass, rs}, f3: {pass, ratio, grade},
 *     f4: {pass, score,...}, f5: {pass, ext}, confirm, confirmMax }
 * `confirm` = count of non-null passes; `confirmMax` = count of non-null frames.
 */
function scoreFrames({ stockCandles, sig, benchmarkCandles }) {
  const bar = sig.breakout_bar != null ? sig.breakout_bar : sig.entry_bar;
  const f1 = frameWeeklyStructure(stockCandles, bar);
  const f2 = frameRelativeStrength(stockCandles, bar, benchmarkCandles);
  const f3 = frameVolumeQuality(stockCandles, bar);
  const f4 = frameBaseQuality(sig);
  const f5 = frameExtension(stockCandles, bar);
  const frames = [f1, f2, f3, f4, f5];
  const nonNull = frames.filter(f => f.pass !== null);
  const confirm = nonNull.filter(f => f.pass).length;
  return {
    f1, f2, f3, f4, f5,
    confirm,
    confirmMax: nonNull.length,
  };
}

module.exports = {
  scoreFrames,
  frameWeeklyStructure, frameRelativeStrength, frameVolumeQuality,
  frameBaseQuality, frameExtension,
  atrAt, smaClose, retN,
};
