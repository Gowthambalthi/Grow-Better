/**
 * common/market/breakoutValidate.js — Breakout detection + validation scoring.
 *
 * Core idea (spec):
 *   1. DETECT breakout (price closes above 20-bar swing high / below swing low)
 *   2. VALIDATE with independent checks (volume ROC, volume acceleration,
 *      price-volume alignment, Camarilla context, candle structure)
 *   3. SCORE how many checks confirm vs contradict
 *   4. DECIDE: REAL → go with breakout; FAKE → fade it; UNCLEAR → skip
 *
 * Candle format (codebase convention): [date, open, high, low, close, volume]
 *
 * Volume-at-price (Check 5 in the original spec) is stubbed: no tick data.
 * It returns null and is excluded from the score denominator when absent,
 * so the score runs over 5 checks. Wire real tick data in later via
 * opts.tickProvider.
 */
'use strict';

// ---------- Step 1: detection ----------
/**
 * Breakout trigger: current close above the recent swing high (bullish) or
 * below the recent swing low (bearish). Current bar is EXCLUDED from the
 * lookback window.
 */
function detectBreakout(candles, lookback = 20) {
  const n = candles.length;
  if (n < lookback + 1) return { direction: null, level: null };
  const last = candles[n - 1];
  const close = last[4];
  let hi = -Infinity, lo = Infinity;
  for (let i = n - lookback - 1; i < n - 1; i++) {
    if (candles[i][2] > hi) hi = candles[i][2];
    if (candles[i][3] < lo) lo = candles[i][3];
  }
  if (close > hi) return { direction: 'BULLISH_BREAKOUT', level: hi };
  if (close < lo) return { direction: 'BEARISH_BREAKOUT', level: lo };
  return { direction: null, level: null };
}

// ---------- Step 2: volume ROC + acceleration ----------
function checkVolumeROC(candles, threshold = 0.5) {
  const n = candles.length;
  const vNow = candles[n - 1][5], vPrev = candles[n - 2][5];
  if (vPrev <= 0) return { ok: false, roc: null, reason: 'zero prior volume' };
  const roc = (vNow - vPrev) / vPrev;
  return { ok: roc > threshold, roc };
}

function checkVolumeAcceleration(candles) {
  const n = candles.length;
  const rocNow = candles[n - 1][5] - candles[n - 2][5];
  const rocPrev = candles[n - 2][5] - candles[n - 3][5];
  return { ok: rocNow > rocPrev, rocNow, rocPrev };
}

// ---------- Step 3: price-volume alignment ----------
function checkPriceVolumeAlignment(candles, direction) {
  const n = candles.length;
  const priceChange = candles[n - 1][4] - candles[n - 2][4];
  const volChange = candles[n - 1][5] - candles[n - 2][5];
  let ok;
  if (direction === 'BULLISH_BREAKOUT') ok = priceChange > 0 && volChange > 0;
  else ok = priceChange < 0 && volChange > 0;
  return { ok, priceChange, volChange };
}

// ---------- Step 4: Camarilla ----------
/**
 * Standard Camarilla levels from the PRIOR bar's high/low/close.
 * R4 = C + 1.1*range/2, R3 = C + 1.1*range/4
 * S3 = C - 1.1*range/4, S4 = C - 1.1*range/2
 */
function calcCamarillaPivots(prevHigh, prevLow, prevClose) {
  const range = prevHigh - prevLow;
  return {
    R4: prevClose + range * 1.1 / 2,
    R3: prevClose + range * 1.1 / 4,
    S3: prevClose - range * 1.1 / 4,
    S4: prevClose - range * 1.1 / 2,
  };
}

function checkCamarillaContext(candles, direction) {
  const n = candles.length;
  const [, , prevHigh, prevLow, prevClose] = candles[n - 2];
  const current = candles[n - 1][4];
  const p = calcCamarillaPivots(prevHigh, prevLow, prevClose);
  if (direction === 'BULLISH_BREAKOUT') return { ok: current > p.R3, pivots: p };
  return { ok: current < p.S3, pivots: p };
}

// ---------- Step 5: recent candle structure ----------
function checkRecentCandleStructure(candles, direction, n = 6) {
  const recent = candles.slice(-n);
  if (recent.length < n) return { ok: false, ratio: null, reason: 'insufficient bars' };
  let count = 0;
  for (let i = 1; i < recent.length; i++) {
    if (direction === 'BULLISH_BREAKOUT') {
      if (recent[i][3] > recent[i - 1][3]) count++; // higher lows
    } else {
      if (recent[i][2] < recent[i - 1][2]) count++; // lower highs
    }
  }
  const pairs = n - 1;
  const ratio = count / pairs;
  return { ok: ratio >= 0.6, ratio };
}

// ---------- Step 6: scorer ----------
/**
 * Validate a detected breakout. Returns REAL (trade with direction),
 * FAKE (fade it), or UNCLEAR (skip). volumeAtPrice is optional: when a
 * provider is given it is scored and included in the denominator.
 */
function validateBreakout(candles, direction, breakoutLevel, opts = {}) {
  const checks = {
    volume_roc: checkVolumeROC(candles, opts.volumeRocThreshold),
    volume_accel: checkVolumeAcceleration(candles),
    price_vol_align: checkPriceVolumeAlignment(candles, direction),
    camarilla: checkCamarillaContext(candles, direction),
    candle_structure: checkRecentCandleStructure(candles, direction, opts.structureBars),
  };
  if (opts.tickProvider) {
    checks.volume_at_price = opts.tickProvider(candles[candles.length - 1], direction);
  }

  const entries = Object.entries(checks);
  const active = entries.filter(([, v]) => v && v.ok != null); // exclude null/stub checks
  const score = active.filter(([, v]) => v.ok).length;
  const total = active.length;
  const realThreshold = opts.realThreshold != null ? opts.realThreshold : Math.ceil(total * 0.7);
  const fakeThreshold = opts.fakeThreshold != null ? opts.fakeThreshold : Math.floor(total * 0.3);

  let verdict;
  if (score >= realThreshold) verdict = 'REAL';
  else if (score <= fakeThreshold) verdict = 'FAKE';
  else verdict = 'UNCLEAR';

  return {
    verdict,
    direction,
    score,
    total,
    fadeDirection: verdict === 'FAKE'
      ? (direction === 'BULLISH_BREAKOUT' ? 'SHORT' : 'LONG')
      : null,
    checks,
    breakoutLevel,
  };
}

/** Convenience: detect + validate on the latest bar. */
function scanBreakout(candles, opts = {}) {
  const { direction, level } = detectBreakout(candles, opts.lookback);
  if (!direction) return { verdict: 'NO_BREAKOUT', direction: null, level };
  return validateBreakout(candles, direction, level, opts);
}

// ---------- D2: independent check set (anti-correlation redesign) ----------
// The 5 spec checks measured 99-100% correlated with volume_roc at daily
// resolution (11,325-trade backtest, PF 0.95) — 5 checks = 1 signal. This
// alternative set uses genuinely different signal sources, reusing engines
// already validated in this codebase:
//   C1 volume_roc        — keep (the core participation signal)
//   C2 htf_trend         — MTF weekly structure (swings.js), must not be downtrend
//   C3 relative_strength — stock vs Nifty-proxy over 15 bars, must be >= 0
//   C4 breakout_quality  — close clears the level by >= 0.3xATR AND closes in
//                          upper third of its range (was Phase 4.1 logic)
//   C5 atf_extension     — close < 2.5xATR above its own 20EMA (not chasing a
//                          blow-off; the GRANULES guard from Frame A.3)
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function atrAtIdx(candles, i, period = 14) {
  if (i < period + 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const h = candles[k][2], l = candles[k][3], pc = candles[k - 1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / period;
}

function checkHtfTrend(candles) {
  // weekly resample of last ~130 daily bars (~26 weeks), then structure via
  // swing comparison: uptrend if last weekly close > prior swing high and
  // higher lows dominate; downtrend if lower highs dominate.
  const n = candles.length;
  if (n < 60) return { ok: null, reason: 'insufficient history' };
  const weeks = [];
  let cur = null;
  for (let i = Math.max(0, n - 130); i < n; i++) {
    // candle date may be 'YYYY-MM-DD' (daily) or 'YYYY-MM-DD HH:MM' (intraday)
    const d = new Date(candles[i][0].slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) continue; // skip malformed stamps
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!cur || cur.key !== key) { cur = { key, close: candles[i][4], high: candles[i][2], low: candles[i][3] }; weeks.push(cur); }
    else { cur.close = candles[i][4]; cur.high = Math.max(cur.high, candles[i][2]); cur.low = Math.min(cur.low, candles[i][3]); }
  }
  if (weeks.length < 10) return { ok: null, reason: 'few weekly bars' };
  let higherLows = 0, lowerHighs = 0;
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i].low > weeks[i - 1].low) higherLows++;
    if (weeks[i].high < weeks[i - 1].high) lowerHighs++;
  }
  const bull = higherLows >= lowerHighs * 1.5 && weeks[weeks.length - 1].close > weeks[0].close;
  const bear = lowerHighs >= higherLows * 1.5;
  return { ok: bull ? true : bear ? false : true, detail: { higherLows, lowerHighs } }; // sideways passes
}

function checkRelativeStrength(candles, niftyCandles, bars = 15, rsMin = 0) {
  const n = candles.length;
  if (n < bars + 1) return { ok: null, reason: 'insufficient history' };
  const stockRet = candles[n - 1][4] / candles[n - 1 - bars][4] - 1;
  if (!niftyCandles || niftyCandles.length < bars + 1) return { ok: true, stockRet }; // no benchmark: don't block
  const m = niftyCandles.length;
  const niftyRet = niftyCandles[m - 1][4] / niftyCandles[m - 1 - bars][4] - 1;
  const rs = stockRet - niftyRet;
  // rsMin: minimum outperformance required. Default 0 was too lenient at
  // daily resolution (99.6% pass rate, n=5 fails = untested, not validated).
  return { ok: rs >= rsMin, rs: +rs.toFixed(4), stockRet: +stockRet.toFixed(4), niftyRet: +niftyRet.toFixed(4) };
}

/**
 * Breakout candle quality, DIRECTION-AWARE: bullish breakouts must clear the
 * level by ≥0.3×ATR and close in the upper third of their range; bearish
 * breakouts mirror (clear below level, close in the LOWER third). The
 * original long-only version failed ~100% of bearish breakouts (closePos is
 * near 0 on a down bar by construction), silently excluding the short side
 * and colliding with the RS check.
 */
function checkBreakoutQuality(candles, level, direction) {
  const n = candles.length;
  const last = candles[n - 1];
  const atr = atrAtIdx(candles, n - 1);
  if (!atr) return { ok: null, reason: 'no ATR' };
  const range = last[2] - last[3];
  const closePos = range > 0 ? (last[4] - last[3]) / range : 0;
  const isBull = direction !== 'BEARISH_BREAKOUT';
  const clears = isBull
    ? (last[4] - level) >= 0.3 * atr
    : (level - last[4]) >= 0.3 * atr;
  const strongClose = isBull ? closePos >= 0.667 : closePos <= 0.333;
  return { ok: clears && strongClose, clears, closePos: +closePos.toFixed(2) };
}

function checkAtrExtension(candles, maxExt = 2.5) {
  const n = candles.length;
  const closes = candles.map(c => c[4]);
  const e20 = emaSeries(closes, 20)[n - 1];
  const atr = atrAtIdx(candles, n - 1);
  if (e20 == null || !atr) return { ok: null, reason: 'no EMA20/ATR' };
  const ext = (candles[n - 1][4] - e20) / atr;
  return { ok: ext < maxExt, ext: +ext.toFixed(2) };
}

/**
 * Independent-check validation. Same verdict thresholds (>=70% REAL,
 * <=30% FAKE) but over 5 genuinely-different signal sources.
 */
function validateBreakoutIndependent(candles, direction, breakoutLevel, opts = {}) {
  const checks = {
    volume_roc: checkVolumeROC(candles, opts.volumeRocThreshold),
    htf_trend: checkHtfTrend(candles),
    relative_strength: checkRelativeStrength(candles, opts.niftyCandles, opts.rsBars, opts.rsMin),
    breakout_quality: checkBreakoutQuality(candles, breakoutLevel, direction),
    atr_extension: checkAtrExtension(candles, opts.maxExtension),
  };
  const entries = Object.entries(checks);
  const active = entries.filter(([, v]) => v && v.ok != null);
  const score = active.filter(([, v]) => v.ok).length;
  const total = active.length;
  let verdict;
  if (score >= Math.ceil(total * 0.7)) verdict = 'REAL';
  else if (score <= Math.floor(total * 0.3)) verdict = 'FAKE';
  else verdict = 'UNCLEAR';
  return {
    verdict, direction, score, total,
    fadeDirection: verdict === 'FAKE' ? (direction === 'BULLISH_BREAKOUT' ? 'SHORT' : 'LONG') : null,
    checks, breakoutLevel,
  };
}

module.exports = {
  detectBreakout,
  checkVolumeROC,
  checkVolumeAcceleration,
  checkPriceVolumeAlignment,
  calcCamarillaPivots,
  checkCamarillaContext,
  checkRecentCandleStructure,
  validateBreakout,
  scanBreakout,
  validateBreakoutIndependent,
  checkHtfTrend,
  checkRelativeStrength,
  checkBreakoutQuality,
  checkAtrExtension,
};
