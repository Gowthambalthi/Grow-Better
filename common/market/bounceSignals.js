/**
 * common/market/bounceSignals.js — Phase 2: bounce entry filters.
 *
 * Combines Phase 1 zones (zones.js) with structure (swings.js) and applies:
 *
 *   Task 2.1  Structural context  — structureState (swings.js) must NOT be
 *             'downtrend' (confirmed LH/LL). Uptrend + sideways allowed.
 *   Task 2.2  Relative strength   — stock return vs Nifty over trailing
 *             rsBars (default 15, spec 10–20) must be >= 0 at signal time.
 *   Task 2.3  Volume signature    — volume declining/flat over the volTrendBars
 *             (default 8, spec 5–10) approaching the touch, AND bounce-day
 *             volume >= bounceVolMult (default 1.4, spec 1.3–1.5) × its 20-day avg.
 *   Task 2.4  Entry trigger       — bounce candle closes above zone high, in
 *             the upper half of its range, with a lower wick present. Entry =
 *             this candle's close (or next bar's open with entryOn='nextOpen').
 *   Task 2.5  Stop/target         — stop = zone_low − 0.3×ATR. Target = max(
 *             nearest prior swing high, 2×ATR above entry). Reject if R:R < 2.
 *
 * Main API:
 *   detectBounceSignals(stockCandles, niftyCandles, opts) -> { signals, rejected }
 *   evaluateZoneTouch(zone, candles, touchBar, opts)       -> per-touch detail
 */
'use strict';

const { detectSupportZones } = require('./zones');
const { structureState, findSwings } = require('./swings');

const DEFAULTS = {
  // structure
  swingLeft: 3,
  swingRight: 3,
  // relative strength
  rsBars: 15,          // spec 10–20
  // volume signature
  volTrendBars: 8,     // spec 5–10 bars approaching the zone
  volTrendMaxRise: 0.15, // "declining/flat": last vs first of window ≤ +15%
  bounceVolMult: 1.4,  // spec 1.3–1.5 × 20-day avg
  volAvgBars: 20,
  // entry trigger
  maxUpperWick: 0.6,   // bounce close must sit in upper (1-maxUpperWick) of range
  minLowerWickPct: 0.1, // lower wick ≥ 10% of range ("lower wick present")
  entryOn: 'close',    // 'close' = signal candle close | 'nextOpen' = next bar open
  // stop/target
  stopAtrMult: 0.3,
  minAtrTargetMult: 2.0,
  minRR: 2.0,
  // zone passthrough (Phase 1 defaults)
  zoneOpts: {},
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

function pctReturn(candles, endBar, bars) {
  const startBar = endBar - bars;
  if (startBar < 0) return null;
  const a = candles[startBar][4], b = candles[endBar][4];
  if (!a) return null;
  return (b - a) / a;
}

// ---------- Task 2.2 ----------
function relativeStrengthOk(stockCandles, niftyCandles, bar, opts) {
  const stockRet = pctReturn(stockCandles, bar, opts.rsBars);
  const niftyRet = niftyCandles ? pctReturn(niftyCandles, Math.min(bar, niftyCandles.length - 1), opts.rsBars) : 0;
  if (stockRet == null) return { ok: false, reason: 'insufficient history for RS' };
  const rs = stockRet - (niftyRet || 0);
  return { ok: rs >= 0, rs, stockRet, niftyRet, reason: rs >= 0 ? null : `RS ${ (rs * 100).toFixed(1) }% < 0 over ${opts.rsBars} bars` };
}

// ---------- Task 2.3 ----------
function volumeSignatureOk(candles, touchBar, bounceBar, opts) {
  // volume trend approaching the zone: declining/flat over volTrendBars
  const start = touchBar - opts.volTrendBars;
  if (start < opts.volAvgBars) return { ok: false, reason: 'insufficient history for volume checks' };
  const vStart = candles[start][5];
  const vEnd = candles[touchBar][5];
  const trend = vStart > 0 ? (vEnd - vStart) / vStart : 0;
  const trendOk = trend <= opts.volTrendMaxRise; // declining or flat

  // bounce-day volume vs 20-day avg (avg ending the bar before the bounce)
  let sum = 0;
  for (let i = bounceBar - opts.volAvgBars; i < bounceBar; i++) sum += candles[i][5];
  const avg = sum / opts.volAvgBars;
  const bounceVol = candles[bounceBar][5];
  const mult = avg > 0 ? bounceVol / avg : 0;
  const surgeOk = mult >= opts.bounceVolMult;

  return {
    ok: trendOk && surgeOk,
    volTrend: trend,
    bounceVolMult: mult,
    reason: !trendOk ? `volume rising ${(trend * 100).toFixed(0)}% into zone (need flat/declining)`
      : !surgeOk ? `bounce volume ${mult.toFixed(2)}× avg < ${opts.bounceVolMult}×`
      : null,
  };
}

// ---------- Task 2.4 ----------
function entryTriggerOk(candle, zone, atr, opts) {
  const [, o, h, l, c] = candle;
  const range = h - l;
  if (range <= 0) return { ok: false, reason: 'zero-range bounce candle' };
  const closeAboveZone = c > zone.price_high;
  const upperHalf = (c - l) / range >= (1 - opts.maxUpperWick); // close in upper 60% (default)
  const lowerWick = (Math.min(o, c) - l) / range >= opts.minLowerWickPct;
  const ok = closeAboveZone && upperHalf && lowerWick;
  return {
    ok,
    closeAboveZone, upperHalf, lowerWick,
    reason: !closeAboveZone ? 'close not above zone high'
      : !upperHalf ? 'close not in upper half of range'
      : !lowerWick ? 'no lower wick (rejection) present' : null,
  };
}

// ---------- Task 2.5 ----------
function stopTarget(entry, zone, atr, swingsHighs, entryBar, opts) {
  const stop = zone.price_low - opts.stopAtrMult * atr;
  const risk = entry - stop;
  if (risk <= 0) return { ok: false, reason: 'non-positive risk (entry below stop)' };

  // nearest prior swing high ABOVE entry, formed before the entry bar
  let nearestSwing = null;
  for (const s of swingsHighs) {
    if (s.index + opts.swingRight <= entryBar && s.price > entry) {
      if (nearestSwing == null || s.price < nearestSwing.price) nearestSwing = s;
    }
  }
  const swingTarget = nearestSwing ? nearestSwing.price : null;
  const atrTarget = entry + opts.minAtrTargetMult * atr;
  const target = swingTarget != null ? Math.max(swingTarget, atrTarget) : atrTarget;
  const reward = target - entry;
  const rr = reward / risk;
  if (rr < opts.minRR) {
    return { ok: false, reason: `R:R 1:${rr.toFixed(2)} < 1:${opts.minRR}`, stop, target, rr, swingTarget };
  }
  return { ok: true, stop, target, rr, swingTarget };
}

// ---------- per-touch evaluation ----------
/**
 * Evaluate a single zone touch as a potential bounce signal.
 * touchBar = pivot-low bar; bounceBar = the bar whose candle satisfies the
 * entry trigger within bounceBars after the touch (searched here).
 */
function evaluateZoneTouch(zone, candles, touchBar, niftyCandles, opts) {
  const atrs = atrSeries(candles, 14);
  const reject = (reason, extra = {}) => ({ ok: false, reason, ...extra });

  // Task 2.1 — structure
  const struct = structureState(candles, { swingLeft: opts.swingLeft, swingRight: opts.swingRight, asOf: touchBar });
  if (struct.state === 'downtrend') {
    return reject(`downtrend structure (LH ${struct.lastHigh && struct.lastHigh.price} / LL ${struct.lastLow && struct.lastLow.price})`, { structure: struct });
  }

  // find the bounce bar: first bar within [touch+1, touch+3] passing the trigger
  let bounceBar = null, trigger = null;
  for (let k = touchBar + 1; k <= Math.min(touchBar + 3, candles.length - 1); k++) {
    const t = entryTriggerOk(candles[k], zone, atrs[k], opts);
    if (t.ok) { bounceBar = k; trigger = t; break; }
  }
  if (bounceBar == null) {
    return reject('no qualifying bounce candle within 3 bars of touch', { structure: struct });
  }

  // Task 2.2 — relative strength at signal time
  const rs = relativeStrengthOk(candles, niftyCandles, bounceBar, opts);
  if (!rs.ok) return reject(rs.reason, { structure: struct, trigger });

  // Task 2.3 — volume signature
  const vol = volumeSignatureOk(candles, touchBar, bounceBar, opts);
  if (!vol.ok) return reject(vol.reason, { structure: struct, trigger, rs });

  // Task 2.5 — stop/target
  const entry = opts.entryOn === 'nextOpen'
    ? (candles[bounceBar + 1] ? candles[bounceBar + 1][1] : candles[bounceBar][4])
    : candles[bounceBar][4];
  const { highs } = findSwings(candles, { swingLeft: opts.swingLeft, swingRight: opts.swingRight });
  const st = stopTarget(entry, zone, atrs[bounceBar], highs, bounceBar, opts);
  if (!st.ok) return reject(st.reason, { structure: struct, trigger, rs, vol, stop: st.stop, target: st.target, rr: st.rr });

  return {
    ok: true,
    symbol_zone: { price_low: zone.price_low, price_high: zone.price_high, valid_touch_count: zone.valid_touch_count },
    structure: struct,
    rs: { rs: rs.rs, stockRet: rs.stockRet, niftyRet: rs.niftyRet },
    volume: { trend: vol.volTrend, bounceVolMult: vol.bounceVolMult },
    trigger: { bounceBar, bounceDate: candles[bounceBar][0], entry },
    entry,
    stop: +st.stop.toFixed(2),
    target: +st.target.toFixed(2),
    rr: +st.rr.toFixed(2),
    swingTarget: st.swingTarget != null ? +st.swingTarget.toFixed(2) : null,
  };
}

// ---------- main ----------
/**
 * Scan a stock's candles for Phase-2-qualified bounce signals on Phase-1 zones.
 * Only touches NEAR the current price are considered actionable: the signal's
 * bounce bar must be within `recencyBars` (default 5) of the last candle.
 */
function detectBounceSignals(stockCandles, niftyCandles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const { zones, rejected_zones } = detectSupportZones(stockCandles, opts.zoneOpts);
  const signals = [], rejected = [];
  const lastBar = stockCandles.length - 1;

  for (const zone of zones) {
    for (const t of zone.valid_touch_indices) {
      // only fresh touches can be actionable entries
      if (lastBar - t > 5 + 3) continue; // touch + bounce window must reach near present
      const r = evaluateZoneTouch(zone, stockCandles, t, niftyCandles, opts);
      if (r.ok) signals.push({ symbol: null, ...r });
      else rejected.push({ touchBar: t, date: stockCandles[t][0], reason: r.reason, detail: r });
    }
  }
  return { signals, rejected, zones, rejected_zones };
}

module.exports = {
  detectBounceSignals, evaluateZoneTouch,
  relativeStrengthOk, volumeSignatureOk, entryTriggerOk, stopTarget,
  DEFAULTS,
};
