/**
 * common/market/swings.py — swing structure analysis for Phase 2.
 *
 * Task 2.1 dependency: tag swing highs/lows and classify structure state
 * (uptrend / sideways / downtrend) from HH/HL/LH/LL sequences.
 *
 * Ported to JS to match the project (no Python runtime deps in prod code);
 * kept the .py-style API surface described in the spec.
 */
'use strict';

const DEFAULTS = {
  swingLeft: 3,   // bars to the left for swing detection
  swingRight: 3,  // bars to the right for swing detection
  tagTolerance: 0.002, // ±0.2%: equal highs/lows within tolerance are 'EQ', not lower
};

/**
 * Detect swing highs and lows.
 * Swing high: high[i] is strict max of [i-left, i+right].
 * Swing low:  low[i]  is strict min of [i-left, i+right].
 * Returns { highs: [{index, price}], lows: [{index, price}] }
 */
function findSwings(candles, opts = {}) {
  const { swingLeft: left, swingRight: right } = { ...DEFAULTS, ...opts };
  const n = candles.length;
  const highs = [], lows = [];
  for (let i = left; i < n - right; i++) {
    const h = candles[i][2], l = candles[i][3];
    let isHigh = true, isLow = true;
    for (let k = i - left; k <= i + right; k++) {
      if (k === i) continue;
      if (candles[k][2] > h) isHigh = false;
      if (candles[k][3] < l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: h });
    if (isLow) lows.push({ index: i, price: l });
  }
  return { highs, lows };
}

/**
 * Tag each swing vs the previous same-type swing: HH / HL / LH / LL.
 * First swing of each type is untagged (null tag).
 * Returns { highs: [{index, price, tag}], lows: [{index, price, tag}] }
 */
function tagSwings(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const tol = o.tagTolerance;
  const { highs, lows } = findSwings(candles, opts);
  for (let i = 1; i < highs.length; i++) {
    const prev = highs[i - 1].price, cur = highs[i].price;
    highs[i].tag = cur > prev * (1 + tol) ? 'HH' : cur < prev * (1 - tol) ? 'LH' : 'EQH';
  }
  if (highs.length) highs[0].tag = null;
  for (let i = 1; i < lows.length; i++) {
    const prev = lows[i - 1].price, cur = lows[i].price;
    lows[i].tag = cur > prev * (1 + tol) ? 'HL' : cur < prev * (1 - tol) ? 'LL' : 'EQL';
  }
  if (lows.length) lows[0].tag = null;
  return { highs, lows };
}

/**
 * Structure state at a given bar (default: latest confirmed bar).
 *
 *  - 'uptrend':   last two tagged swings are (HH or equal-high) AND (HL)
 *  - 'downtrend': last two tagged swings are (LH) AND (LL)  ← confirmed LH/LL sequence
 *  - 'sideways':  everything else
 *
 * Only CONFIRMED swings (fully formed `swingRight` bars ago) are used, so the
 * state at bar `asOf` never looks into the future.
 */
function structureState(candles, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const asOf = opts.asOf != null ? opts.asOf : candles.length - 1;
  const { highs, lows } = tagSwings(candles, o);

  // last confirmed swing high/low strictly before asOf (needs right bars after it)
  const confirmed = arr => arr.filter(s => s.index + o.swingRight <= asOf && s.tag);
  const hs = confirmed(highs);
  const ls = confirmed(lows);

  const lastHigh = hs[hs.length - 1] || null;
  const prevHigh = hs[hs.length - 2] || null;
  const lastLow = ls[ls.length - 1] || null;
  const prevLow = ls[ls.length - 2] || null;

  const detail = {
    asOfBar: asOf,
    lastHigh: lastHigh && { index: lastHigh.index, price: lastHigh.price, tag: lastHigh.tag },
    prevHigh: prevHigh && { index: prevHigh.index, price: prevHigh.price, tag: prevHigh.tag },
    lastLow: lastLow && { index: lastLow.index, price: lastLow.price, tag: lastLow.tag },
    prevLow: prevLow && { index: prevLow.index, price: prevLow.price, tag: prevLow.tag },
  };

  // Downtrend: confirmed LH/LL sequence (spec Task 2.1). Equal highs/lows
  // (EQH/EQL, within tolerance) count as sideways, not lower.
  if (lastHigh && lastHigh.tag === 'LH' && lastLow && lastLow.tag === 'LL') {
    return { state: 'downtrend', ...detail };
  }
  // Uptrend: HH (not EQH/LH) AND HL
  if (lastHigh && lastHigh.tag === 'HH' && lastLow && lastLow.tag === 'HL') {
    return { state: 'uptrend', ...detail };
  }
  return { state: 'sideways', ...detail };
}

module.exports = { findSwings, tagSwings, structureState, DEFAULTS };
