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

const { detectSupportZones, pivotLows, atrSeries: zoneAtrSeries } = require('./zones');
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
  // scanning mode: 'recent' = live scanner (touch near last bar), 'all' =
  // evaluate every historical touch (walk-forward backtest)
  recencyMode: 'recent',
  recencyBars: 5,
  // C1 — look-ahead protection: when true (used by backtests), zones are
  // RECOMPUTED as of each candidate touch bar so validity never uses future
  // bars. Slower; mandatory for honest backtests.
  asOfZones: false,
  // C3 — merge overlapping zones after clustering (post-ATR-buffer overlaps)
  mergeOverlappingZones: true,
  // C4 — recency-decayed zone strength (half-life in bars)
  zoneStrengthHalfLife: 30,
  // S3 — liquidity gate: min average daily turnover (price × volume) over 20 bars
  minAvgTurnover: 2e7, // ₹2 Cr default
  // S2 — market regime gate ('auto' | 'on' | 'off'): block bounce signals when
  // the benchmark (Nifty) is in a downtrend regime at signal time
  regimeFilter: 'auto',
  // S6 — per-stock cooldown: bars to wait after a signal before the next one
  cooldownBars: 10,
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

// ---------- C3 — merge overlapping zones (after clustering, before validation) ----------
function mergeOverlappingZones(zones) {
  if (!zones.length) return zones;
  const sorted = [...zones].sort((a, b) => a.price_low - b.price_low);
  const merged = [sorted[0]];
  for (const z of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (z.price_low <= last.price_high) {
      last.price_high = Math.max(last.price_high, z.price_high);
      last.price_low = Math.min(last.price_low, z.price_low);
      last.touch_indices = [...new Set([...last.touch_indices, ...z.touch_indices])].sort((a, b) => a - b);
    } else merged.push(z);
  }
  return merged;
}

// ---------- C4 — recency-decayed zone strength ----------
function zoneStrengthScore(zone, currentIdx, halfLifeBars = 30) {
  if (!zone.valid_touch_indices || !zone.valid_touch_indices.length) return 0;
  return zone.valid_touch_indices.reduce(
    (s, t) => s + Math.pow(0.5, (currentIdx - t) / halfLifeBars), 0);
}

// ---------- S2 — market regime ----------
/**
 * Regime of the benchmark at bar `bar`: 'uptrend' if close > 50MA > 100MA,
 * 'sideways' if close > 50MA or 50MA > 100MA (partial alignment), else
 * 'downtrend'. Bounce signals should only fire in up/sideways.
 */
function marketRegime(niftyCandles, bar, opts = {}) {
  if (!niftyCandles || niftyCandles.length < 100) return 'unknown';
  const closes = niftyCandles.map(c => c[4]);
  const sma = (end, p) => {
    if (end + 1 < p) return null;
    let s = 0;
    for (let i = end - p + 1; i <= end; i++) s += closes[i];
    return s / p;
  };
  const ma50 = sma(bar, 50), ma100 = sma(bar, 100);
  if (ma50 == null || ma100 == null) return 'unknown';
  const c = closes[bar];
  if (c > ma50 && ma50 > ma100) return 'uptrend';
  if (c > ma50 || ma50 > ma100) return 'sideways';
  return 'downtrend';
}

function regimeOk(niftyCandles, bar, opts) {
  if (opts.regimeFilter === 'off' || !niftyCandles) return { ok: true, regime: 'unknown' };
  const regime = marketRegime(niftyCandles, bar, opts);
  if (regime === 'unknown') return { ok: true, regime }; // no data → don't block
  const ok = regime !== 'downtrend';
  return { ok, regime, reason: ok ? null : `market regime ${regime} (Nifty below 50/100 MA)` };
}

// ---------- S3 — liquidity ----------
function liquidityOk(candles, bar, opts) {
  if (!opts.minAvgTurnover) return { ok: true, turnover: null };
  if (bar < 19) return { ok: false, reason: 'insufficient history for turnover' };
  let s = 0;
  for (let i = bar - 19; i <= bar; i++) s += candles[i][4] * candles[i][5];
  const avg = s / 20;
  const ok = avg >= opts.minAvgTurnover;
  return { ok, turnover: avg, reason: ok ? null : `avg turnover ₹${(avg / 1e7).toFixed(2)} Cr < ₹${(opts.minAvgTurnover / 1e7).toFixed(2)} Cr` };
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
  // Rejection evidence = lower wick OR a gap-up open above the zone (price
  // opened clear of the zone — the rejection already happened intrabar on the
  // touch bar; demanding a visible lower wick here kills gap-up follow-through
  // bars, which are the strongest kind).
  const gapUpOpen = o > zone.price_high;
  const rejection = lowerWick || gapUpOpen;
  const ok = closeAboveZone && upperHalf && rejection;
  return {
    ok,
    closeAboveZone, upperHalf, lowerWick, gapUpOpen,
    reason: !closeAboveZone ? 'close not above zone high'
      : !upperHalf ? 'close not in upper half of range'
      : !rejection ? 'no lower wick and no gap-up open (no rejection evidence)' : null,
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

// ---------- C1 — as-of zone validity (no look-ahead) ----------
/**
 * Recompute a zone's validity using ONLY data up to asOfIdx: touches after
 * the as-of bar are excluded, reaction windows are clipped at the as-of bar,
 * and the broken check runs over the as-of window only. Returns null when the
 * zone had no known touches yet.
 */
function getZoneAsOf(zone, candles, atrs, asOfIdx, opts = {}) {
  const reactionBars = opts.bounceBars || 3;
  const minReactionAtr = opts.bounceAtrMult || 1.0;
  const known = zone.touch_indices.filter(i => i < asOfIdx);
  if (!known.length) return null;

  const valid = [];
  for (const t of known) {
    const atr = atrs[t];
    if (atr == null || atr <= 0) continue;
    const windowEnd = Math.min(t + reactionBars, asOfIdx - 1);
    const threshold = zone.price_high + minReactionAtr * atr;
    let reacted = false;
    for (let k = t + 1; k <= windowEnd; k++) {
      if (candles[k][4] >= threshold) { reacted = true; break; } // C2: plain loop, no iterator overhead
    }
    if (reacted) valid.push(t);
  }

  // broken check over the as-of window only (2 consecutive closes below low)
  let broken = false;
  let consecutive = 0;
  for (let i = known[0]; i < asOfIdx; i++) {
    if (candles[i][4] < zone.price_low) {
      consecutive++;
      if (consecutive >= 2) { broken = true; break; }
    } else consecutive = 0;
  }

  return {
    ...zone,
    touch_indices: known,
    valid_touch_indices: valid,
    valid_touch_count: valid.length,
    status: broken ? 'broken' : 'pending',
    strength: zoneStrengthScore({ valid_touch_indices: valid }, asOfIdx, opts.zoneStrengthHalfLife || 30), // C4
  };
}

// ---------- main ----------
/**
 * Scan a stock's candles for Phase-2-qualified bounce signals on Phase-1 zones.
 *
 * recencyMode (default 'recent'): only touches within recencyBars (default 5)
 * of the last candle are actionable — live-scanner semantics.
 * recencyMode 'all' (or asOfZones: true): EVERY historical touch is evaluated
 * with zones recomputed AS OF that touch (no look-ahead) — walk-forward
 * backtest semantics used by scripts/backtestPhases.js.
 */
function detectBounceSignals(stockCandles, niftyCandles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const walkForward = opts.asOfZones || opts.recencyMode === 'all';
  const lastBar = stockCandles.length - 1;
  const signals = [], rejected = [];
  let zones = [], rejected_zones = [];

  if (!walkForward) {
    // live scanner: zones over the full history (all data is known "now")
    const z = detectSupportZones(stockCandles, opts.zoneOpts);
    zones = z.zones; rejected_zones = z.rejected_zones;
    for (const zone of zones) {
      for (const t of zone.valid_touch_indices) {
        if (lastBar - t > opts.recencyBars + 3) continue;
        const r = evaluateZoneTouch(zone, stockCandles, t, niftyCandles, opts);
        if (r.ok) {
          r.actionable = (lastBar - r.trigger.bounceBar) <= (opts.recencyBars || 5);
          r.zone_strength = zoneStrengthScore(zone, lastBar, opts.zoneStrengthHalfLife);
          signals.push({ symbol: null, ...r });
        } else rejected.push({ touchBar: t, date: stockCandles[t][0], reason: r.reason, detail: r });
      }
    }
    return { signals, rejected, zones, rejected_zones };
  }

  // ----- walk-forward: as-of evaluation at every candidate touch (C1) -----
  const atrs = zoneAtrSeries(stockCandles, (opts.zoneOpts && opts.zoneOpts.atrPeriod) || 14);
  const allPivots = pivotLows(stockCandles,
    (opts.zoneOpts && opts.zoneOpts.pivotLeft) || 3,
    (opts.zoneOpts && opts.zoneOpts.pivotRight) || 3).map(p => p.index);
  const lookback = (opts.zoneOpts && opts.zoneOpts.lookback) || 75;
  const minValidTouches = (opts.zoneOpts && opts.zoneOpts.minValidTouches) || 3;

  let lastSignalBar = -Infinity; // S6 — cooldown
  for (const t of allPivots) {
    if (lastBar - t > lookback) continue; // same live-window as the scanner
    if (t - lastSignalBar < opts.cooldownBars) continue; // S6

    // C1 — build zones from STRICTLY the history before t, but count the
    // current touch as a zone touch (a live scanner at bar t would see the
    // just-printed pivot). detectSupportZones on slice(0, t] = up to and
    // INCLUDING t, then getZoneAsOf clips validation windows to < t.
    const histSlice = stockCandles.slice(0, t + 1);
    if (histSlice.length < lookback + 4) continue;
    const zr = detectSupportZones(histSlice, opts.zoneOpts);
    let candZones = [...zr.zones, ...zr.rejected_zones.filter(z => z.status !== 'broken' && z.valid_touch_count >= minValidTouches - 1)];
    if (opts.mergeOverlappingZones) candZones = mergeOverlappingZones(candZones);
    if (!candZones.length) continue;

    // evaluate each as-of zone for a bounce at THIS touch
    for (const zone of candZones) {
      // the touch must actually be at/near this zone
      if (stockCandles[t][3] < zone.price_low - 0.5 * (atrs[t] || 0) || stockCandles[t][3] > zone.price_high + 1.0 * (atrs[t] || 0)) continue;
      const asOfZone = getZoneAsOf(zone, stockCandles, atrs, t, { ...opts, ...opts.zoneOpts });
      if (!asOfZone || asOfZone.status === 'broken') continue;
      if (asOfZone.valid_touch_count < minValidTouches - 1) continue; // current touch makes the Nth
      const r = evaluateZoneTouch(asOfZone, stockCandles, t, niftyCandles, opts);
      if (!r.ok) { rejected.push({ touchBar: t, date: stockCandles[t][0], reason: r.reason, detail: r }); continue; }

      // S2 — regime gate at signal time
      const reg = regimeOk(niftyCandles, r.trigger.bounceBar, opts);
      if (!reg.ok) { rejected.push({ touchBar: t, date: stockCandles[t][0], reason: reg.reason, detail: r }); continue; }

      // S3 — liquidity gate
      const liq = liquidityOk(stockCandles, r.trigger.bounceBar, opts);
      if (!liq.ok) { rejected.push({ touchBar: t, date: stockCandles[t][0], reason: liq.reason, detail: r }); continue; }

      r.actionable = (lastBar - r.trigger.bounceBar) <= (opts.recencyBars || 5);
      r.zone_strength = +asOfZone.strength.toFixed(2);
      r.regime = reg.regime;
      r.turnover_cr = liq.turnover != null ? +(liq.turnover / 1e7).toFixed(2) : null;
      signals.push({ symbol: null, ...r });
      lastSignalBar = r.trigger.bounceBar;
      break; // one signal per touch
    }
  }
  return { signals, rejected, zones, rejected_zones };
}

module.exports = {
  detectBounceSignals, evaluateZoneTouch,
  relativeStrengthOk, volumeSignatureOk, entryTriggerOk, stopTarget,
  marketRegime, regimeOk, liquidityOk, mergeOverlappingZones, zoneStrengthScore, getZoneAsOf,
  DEFAULTS,
};
