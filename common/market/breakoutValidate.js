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
};
