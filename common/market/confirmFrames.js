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
 *   F6 intradayClose   — 15-min close quality on the breakout day: close in
 *                        the top third of the day range, last-hour closes
 *                        rising, volume building into the close.
 *   F7 intradayHold    — 15-min hold of the level the day after the break:
 *                        few/no 15-min closes below the level, none deeply so.
 *                        The daily bar hides intraday breakdowns; F7 catches them.
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

// ---------- F6: intraday close quality (15-min bars, breakout day) ----------

/**
 * How did the breakout day END? Slice the day's 15-min bars and check the
 * last hour: a genuine breakout closes near its high with rising 15-min
 * closes and expanding volume; a fake drifts up on fading participation.
 *
 * intradayCandles: 15-min bars for the breakout day (or the day containing
 * the breakout close). pass = all of:
 *   - last-15min close in the top third of the day's range
 *   - mean of last 4 (1h of) 15-min closes >= mean of prior 4
 *   - last-hour volume >= first-hour volume (participation building, not fading)
 */
function frameIntradayClose(intradayCandles) {
  if (!intradayCandles || intradayCandles.length < 12) {
    return { pass: null, closePos: null, lastHourUp: null, volBuilding: null, reason: 'insufficient intraday bars' };
  }
  const n = intradayCandles.length;
  const dayHigh = Math.max(...intradayCandles.map(c => c[2]));
  const dayLow = Math.min(...intradayCandles.map(c => c[3]));
  const range = dayHigh - dayLow;
  const lastClose = intradayCandles[n - 1][4];
  const closePos = range > 0 ? (lastClose - dayLow) / range : null;

  const last4 = intradayCandles.slice(-4);
  const prior4 = intradayCandles.slice(-8, -4);
  const m = a => a.reduce((s, c) => s + c[4], 0) / a.length;
  const lastHourUp = prior4.length ? m(last4) >= m(prior4) : null;

  const firstHourVol = intradayCandles.slice(0, 4).reduce((s, c) => s + c[5], 0);
  const lastHourVol = last4.reduce((s, c) => s + c[5], 0);
  const volBuilding = firstHourVol > 0 ? lastHourVol >= firstHourVol : null;

  const pass = closePos != null && closePos >= 2 / 3 && lastHourUp === true && volBuilding === true;
  return { pass, closePos: closePos != null ? +closePos.toFixed(2) : null, lastHourUp, volBuilding, reason: null };
}

// ---------- F7: intraday hold after breakout (15-min bars, next day) ----------

/**
 * Did price HOLD the breakout level on 15-min bars the day after the break?
 * Fakes: intraday dips back BELOW the level that only recover at close —
 * the daily bar hides this. pass = on the day AFTER the breakout, no more
 * than maxDipBelowLevel 15-min closes were strictly below the level, and
 * none closed more than dipAtrFrac × daily ATR below it.
 */
function frameIntradayHold(nextDayCandles, level, dailyAtr, opts = {}) {
  const { maxDipBelowLevel = 2, dipAtrFrac = 0.25 } = opts;
  if (!nextDayCandles || !nextDayCandles.length) {
    return { pass: null, dips: null, deepest: null, reason: 'no next-day intraday data' };
  }
  let dips = 0, deepest = 0;
  for (const c of nextDayCandles) {
    if (c[4] < level) {
      dips++;
      const depth = level > 0 ? (level - c[4]) / level : 0;
      if (depth > deepest) deepest = depth;
    }
  }
  const deepOk = dailyAtr > 0 && level > 0 ? deepest <= dipAtrFrac * (dailyAtr / level) : true;
  const pass = dips <= maxDipBelowLevel && deepOk;
  return { pass, dips, deepest: +deepest.toFixed(4), reason: null };
}

// ---------- F8: Nifty direction frame ----------

/**
 * Which direction is the INDEX moving, and does the stock follow it?
 * Stocks breakout more reliably in the direction the benchmark is already
 * moving. Measured on the benchmark's own 5/20-bar EMA slope + position:
 *   'up'   = Nifty close > EMA20 AND EMA5 > EMA20
 *   'down' = Nifty close < EMA20 AND EMA5 < EMA20
 *   'side' = otherwise
 * pass = nifty direction is 'up' (long-only book) — but the RAW direction
 * is always reported so the marginal contribution of side/down can be
 * measured rather than assumed.
 */
function frameNiftyDirection(benchCandles, asOfDate, fast = 5, slow = 20) {
  if (!benchCandles || !benchCandles.length) return { pass: null, direction: null, slope: null, reason: 'no benchmark data' };
  let bIdx = -1;
  for (let k = benchCandles.length - 1; k >= 0; k--) {
    if (benchCandles[k][0] <= asOfDate) { bIdx = k; break; }
  }
  if (bIdx < slow) return { pass: null, direction: null, slope: null, reason: 'insufficient benchmark history' };
  const ema = (period, end) => {
    const k = 2 / (period + 1);
    let e = benchCandles[end - period + 1][4];
    for (let i = end - period + 2; i <= end; i++) e = benchCandles[i][4] * k + e * (1 - k);
    return e;
  };
  const e5 = ema(fast, bIdx), e20 = ema(slow, bIdx), c = benchCandles[bIdx][4];
  const slope = e20 > 0 ? (e5 - e20) / e20 : 0;
  const direction = c > e20 && e5 > e20 ? 'up' : c < e20 && e5 < e20 ? 'down' : 'side';
  return { pass: direction === 'up', direction, slope: +slope.toFixed(4), reason: null };
}

// ---------- F9: volume-at-price proxy ----------

/**
 * True volume-at-price needs tick data; this is the daily-bar proxy: where
 * did the breakout day trade INSIDE its own range? Estimate via typical
 * price weighting across the bar's 3 sub-ranges (approximating a
 * triangular distribution — close-biased when the close is at an extreme):
 *   vpHigh  ≈ share of volume assumed traded in the upper third
 * Formula: upper-third weight = (close − low) / range if range > 0.
 * A breakout closing near the day's high concentrated buying up there —
 * conviction. Closing mid-range = absorption/no conviction.
 */
function frameVolumeAtPrice(candles, bar) {
  const c = candles[bar];
  const range = c[2] - c[3];
  if (range <= 0) return { pass: null, upperShare: null, reason: 'zero-range bar' };
  const upperShare = (c[4] - c[3]) / range; // 0..1, where in the range the close sits
  return { pass: upperShare >= 0.7, upperShare: +upperShare.toFixed(2), reason: null };
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
  const f8 = frameNiftyDirection(benchmarkCandles, stockCandles[bar][0]);
  const f9 = frameVolumeAtPrice(stockCandles, bar);
  return {
    f1, f2, f3, f4, f5, f8, f9,
    confirm,
    confirmMax: nonNull.length,
  };
}

module.exports = {
  scoreFrames,
  frameWeeklyStructure, frameRelativeStrength, frameVolumeQuality,
  frameBaseQuality, frameExtension, frameIntradayClose, frameIntradayHold,
  frameNiftyDirection, frameVolumeAtPrice,
  atrAt, smaClose, retN,
};
