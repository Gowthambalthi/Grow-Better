/**
 * common/market/candleQuality.js — Tasks 1.6 / 2.6 / 2.7 / 2.8.
 *
 * Candle-quality gates reusable across engines (Support Bounce, MTF Trend,
 * Breakout):
 *
 *   isFullBodied(candle)            — body ≥ minBodyRatio of range, small
 *                                     upper wick, bullish close
 *   isThreeWhiteSoldiers(candles,i) — 3 rising full-bodied bullish candles,
 *                                     each opening ≥ prior open
 *   isGenuineReaction(candle, atr, volAvg) — body ≥ minBodyAtr×ATR,
 *                                     volume ≥ minVolMult×avg, body ≥
 *                                     minBodyRatio of range (no wick-only
 *                                     indecision)
 *   isValidBuySignal(...)           — full-bodied AND (genuine reaction OR
 *                                     three soldiers)
 *
 * Candle format: [date, open, high, low, close, volume] (array, like ohlcv).
 */
'use strict';

const DEFAULTS = {
  minBodyRatio: 0.65,       // 2.7 — body ≥ 65% of full range
  maxWickRatio: 0.20,       // 2.7 — either wick ≤ 20% of range
  soldiersMinBodyRatio: 0.6,      // 2.6
  soldiersMaxUpperWick: 0.25,     // 2.6
  minBodyAtr: 0.8,          // 1.6 — body ≥ 0.8×ATR
  minVolMult: 1.5,          // 1.6 — volume ≥ 1.5× 20-day avg
  reactionMinBodyRatio: 0.55,     // 1.6 — body ≥ 55% of range
};

function bodyOf(c) { return Math.abs(c[4] - c[1]); }
function rangeOf(c) { const r = c[2] - c[3]; return r > 0 ? r : 0; }

/** Task 2.7 — full-bodied bullish buy candle. */
function isFullBodied(candle, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const range = rangeOf(candle);
  if (range <= 0) return false;
  const body = bodyOf(candle);
  const upperWick = candle[2] - Math.max(candle[4], candle[1]);
  const lowerWick = Math.min(candle[4], candle[1]) - candle[3];
  return body / range >= o.minBodyRatio
    && upperWick / range <= o.maxWickRatio
    && lowerWick / range <= o.maxWickRatio
    && candle[4] > candle[1]; // bullish
}

/** Task 2.6 — three white soldiers ending at index i (inclusive). */
function isThreeWhiteSoldiers(candles, i, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (i < 2) return false;
  const cs = [candles[i - 2], candles[i - 1], candles[i]];
  // closes strictly rising
  if (!(cs[0][4] < cs[1][4] && cs[1][4] < cs[2][4])) return false;
  for (const c of cs) {
    const range = rangeOf(c);
    if (range <= 0) return false;
    const body = c[4] - c[1]; // must be bullish
    if (body <= 0) return false;
    const upperWick = c[2] - c[4];
    if (body / range < o.soldiersMinBodyRatio) return false;
    if (upperWick / range > o.soldiersMaxUpperWick) return false;
  }
  // each open ≥ prior open (no gap-down opens)
  if (cs[1][1] < cs[0][1] || cs[2][1] < cs[1][1]) return false;
  return true;
}

/** Task 1.6 — genuine reaction: displacement + volume + conviction body. */
function isGenuineReaction(candle, atr, volAvg, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const range = rangeOf(candle);
  if (range <= 0 || !(atr > 0) || !(volAvg > 0)) return false;
  const body = bodyOf(candle);
  const volMult = candle[5] / volAvg;
  return body / atr >= o.minBodyAtr
    && volMult >= o.minVolMult
    && body / range >= o.reactionMinBodyRatio;
}

/** Task 2.8 — final buy gate: full-bodied AND (genuine reaction OR soldiers). */
function isValidBuySignal(candles, i, atr, volAvg, opts = {}) {
  const candle = candles[i];
  if (!isFullBodied(candle, opts)) {
    return { ok: false, reason: 'trigger candle not full-bodied' };
  }
  if (isGenuineReaction(candle, atr, volAvg, opts)) return { ok: true, via: 'genuine_reaction' };
  if (isThreeWhiteSoldiers(candles, i, opts)) return { ok: true, via: 'three_white_soldiers' };
  return { ok: false, reason: 'no genuine reaction and no three-soldiers confirmation' };
}

module.exports = {
  isFullBodied, isThreeWhiteSoldiers, isGenuineReaction, isValidBuySignal,
  DEFAULTS,
};
