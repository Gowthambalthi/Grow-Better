/**
 * common/market/mtfTrend.js — MTF Trend Follow (Frames A/B/C).
 *
 * Frame 1 — Weekly (HTF):
 *   A.1  trend_state: HH/HL tagging on weekly candles → uptrend|downtrend|sideways
 *   A.2  resistance zones: pivot-HIGH clustering on weekly (zones.js model,
 *        mirrored to the resistance side) with touch_count
 *   A.3  extension: weekly close distance from 20/50 weekly MA in ATR units;
 *        extended = distance > maxExtensionMult (default 2.5) — the GRANULES
 *        failure mode (ATR spike + reversal at highs) this filter blocks.
 *   A.4  gate: { trend_state, nearest_resistance_zone, distance_to_resistance_atr,
 *        extended } — only uptrend + !extended proceeds to Frame 2.
 *
 * Frame 2 — Daily confirmation:
 *   B.1  daily structure must agree with weekly (daily downtrend diverging from
 *        weekly uptrend → reject; early-warning divergence)
 *   B.2  pullback/base identification via breakout.js detectBases (or a recent
 *        pullback vs swing high when no full base qualifies)
 *   B.3  volume contracts through the pullback/base (selling interest fading)
 *   B.4  daily close distance to A.2 resistance ≥ minDistToResAtr (default 1.0)
 *        unless explicitly a breakout variant.
 *
 * Frame 3 — Entry trigger (C):
 *   NOTE: only daily OHLCV is stored in data/ohlcv (no 1H/15m history), so the
 *   entry frame runs on DAILY bars as the lowest available timeframe:
 *   C.1  trigger = close breaking above the previous daily swing high within
 *        the pullback zone (local structure break)
 *   C.2  trigger-day volume ≥ volMult × its 20-day average
 *   C.3  stop = trigger swing low − 0.3×ATR (entry-frame ATR)
 *   C.4  target = A.2 weekly resistance zone (or next weekly swing high if
 *        already past the first). R:R gate min 2.
 *
 * Main API:
 *   weeklyResample(dailyCandles) -> weekly candles
 *   htfGate(dailyCandles, opts)  -> Frame 1 object (or { reject_reason })
 *   detectMtfSignals(stockCandles, opts) -> { signals, rejected, htf }
 */
'use strict';

const { structureState, findSwings } = require('./swings');
const { isValidBuySignal } = require('./candleQuality');
const { atrSeries } = require('./zones');
const { detectBases } = require('./breakout');

const DEFAULTS = {
  // A.1 — weekly structure
  wSwingLeft: 3,
  wSwingRight: 3,
  // A.2 — weekly resistance clustering
  wZoneAtrMult: 1.0,        // ± ATR a pivot high may sit from zone median
  wMinTouches: 2,           // resistance zone needs ≥2 weekly rejections
  // A.3 — extension (weekly MAs; 1y of daily data ≈ 52 weekly bars, so the
  // slow MA defaults to 30w ≈ 150d rather than 50w which needs 2y+ of data)
  maFast: 10,
  maSlow: 30,
  maxExtensionMult: 2.5,    // weekly close ≤ 2.5×ATR above the faster MA
  // B.4 — daily distance to resistance
  minDistToResAtr: 1.0,
  // B.3 — volume contraction through the pullback
  pullbackVolDropPct: 0.85, // last-third avg vol ≤ 85% of first-third
  // C.2 — trigger volume
  volMult: 1.2,             // trigger-day volume ≥ 1.2× 20-day avg
  // C.3 — stop
  stopAtrMult: 0.3,
  // C.4 — target / R:R
  minRR: 2.0,
  // scanning
  lookbackBars: 120,        // scan trigger candidates within recent bars
  recencyBars: 5,           // actionable = trigger within N bars of last candle
  // E.4 — candle-quality gate on the trigger candle. Default OFF: backtest
  // showed the strict full-bodied gate HURTS MTF (reclaim-style wick candles
  // outperform: 52% vs 44% win). Kept as an option for A/B.
  candleQuality: false,
  // E-exits — tuned exit rules (see scripts/tuneMtfE.js sweep results)
  breakevenAtR: 1.0,        // E.1: move stop to entry at +1R
  targetRMfePct: 65,        // E.2: target = p65 of MFE distribution (1.11R)
  stallBars: 6,             // E.3: no new high above entry in N bars → exit
};

// ---------- weekly resample ----------
function weeklyResample(daily) {
  const weeks = [];
  let cur = null;
  for (const c of daily) {
    const d = new Date(c[0]);
    // ISO week key: year-week via Thursday trick (simple Monday bucket is fine for resampling)
    const day = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - day);
    const key = monday.toISOString().slice(0, 10);
    if (!cur || cur.key !== key) {
      if (cur) weeks.push(cur.bar);
      cur = { key, bar: [key, c[1], c[2], c[3], c[4], c[5]] };
    } else {
      cur.bar[2] = Math.max(cur.bar[2], c[2]); // high
      cur.bar[3] = Math.min(cur.bar[3], c[3]); // low
      cur.bar[4] = c[4];                        // close (last)
      cur.bar[5] += c[5];                       // volume
    }
  }
  if (cur) weeks.push(cur.bar);
  return weeks;
}

function sma(values, endIdx, period) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
  return s / period;
}

// ---------- A.2 — weekly resistance zones (pivot-high clustering) ----------
function weeklyResistanceZones(weekly, atrs, opts) {
  const { findSwings: fs2 } = require('./swings');
  const { highs } = fs2(weekly, { swingLeft: opts.wSwingLeft, swingRight: opts.wSwingRight });
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2; };
  const clusters = [];
  let cur = null;
  for (const p of highs) {
    const atr = atrs[p.index];
    if (atr == null || atr <= 0) continue;
    if (!cur) { cur = { prices: [p.price], indices: [p.index], atrs: [atr] }; continue; }
    if (Math.abs(p.price - median(cur.prices)) <= opts.wZoneAtrMult * median(cur.atrs)) {
      cur.prices.push(p.price); cur.indices.push(p.index); cur.atrs.push(atr);
    } else { clusters.push(cur); cur = { prices: [p.price], indices: [p.index], atrs: [atr] }; }
  }
  if (cur) clusters.push(cur);
  return clusters
    .filter(cl => cl.indices.length >= opts.wMinTouches)
    .map(cl => ({
      price_low: +Math.min(...cl.prices).toFixed(2),
      price_high: +Math.max(...cl.prices).toFixed(2),
      touch_count: cl.indices.length,
      indices: cl.indices,
    }))
    .sort((a, b) => a.price_low - b.price_low);
}

// ---------- A.3 — extension check ----------
function extensionCheck(weekly, bar, atrs, opts) {
  const closes = weekly.map(c => c[4]);
  const maF = sma(closes, bar, opts.maFast);
  const maS = sma(closes, bar, opts.maSlow);
  const atr = atrs[bar];
  if (maF == null || maS == null || atr == null || atr <= 0) return { ok: false, reason: 'insufficient weekly history' };
  const c = closes[bar];
  const extFast = (c - maF) / atr;
  const extSlow = (c - maS) / atr;
  const ext = Math.max(extFast, extSlow); // extended vs EITHER MA
  return {
    ok: ext <= opts.maxExtensionMult,
    extended: ext > opts.maxExtensionMult,
    ext_fast_atr: +extFast.toFixed(2),
    ext_slow_atr: +extSlow.toFixed(2),
    ma_fast: +maF.toFixed(2),
    ma_slow: +maS.toFixed(2),
    reason: ext > opts.maxExtensionMult ? `weekly close ${ext.toFixed(1)}×ATR above ${extFast > extSlow ? opts.maFast : opts.maSlow}-MA > ${opts.maxExtensionMult}× (extended)` : null,
  };
}

// ---------- Frame 1 — HTF gate ----------
function htfGate(dailyCandles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const weekly = weeklyResample(dailyCandles);
  const atrs = atrSeries(weekly, 14);
  const w = weekly.length - 1;
  if (weekly.length < opts.maSlow + 5) return { ok: false, reason: 'insufficient weekly history' };

  // A.1
  const struct = structureState(weekly, { swingLeft: opts.wSwingLeft, swingRight: opts.wSwingRight });
  const trend_state = struct.state;

  // A.2
  const resZones = weeklyResistanceZones(weekly, atrs, opts);

  // A.3
  const ext = extensionCheck(weekly, w, atrs, opts);

  // A.4 — distance to nearest resistance ABOVE current weekly close
  const c = weekly[w][4];
  const above = resZones.filter(z => z.price_low > c);
  const nearest = above.length ? above.reduce((m, z) => (z.price_low < m.price_low ? z : m)) : null;
  const distAtr = nearest && atrs[w] ? (nearest.price_low - c) / atrs[w] : null;

  return {
    ok: trend_state === 'uptrend' && !ext.extended,
    trend_state,
    extended: ext.extended,
    ext_fast_atr: ext.ext_fast_atr,
    ext_slow_atr: ext.ext_slow_atr,
    nearest_resistance_zone: nearest,
    resistance_zones: resZones,
    distance_to_resistance_atr: distAtr != null ? +distAtr.toFixed(2) : null,
    weekly_bars: weekly.length,
    reason: trend_state !== 'uptrend' ? `weekly trend ${trend_state}` : ext.extended ? ext.reason : null,
  };
}

// ---------- Frame 2 — daily confirmation ----------
function dailyConfirm(candles, triggerScanStart, htf, atrs, opts) {
  const lastBar = candles.length - 1;

  // B.1 — daily structure agrees (not diverging into downtrend)
  const dStruct = structureState(candles, { swingLeft: 3, swingRight: 3, asOf: lastBar });
  if (dStruct.state === 'downtrend') return { ok: false, reason: `daily structure ${dStruct.state} diverges from weekly uptrend` };

  // B.2 — pullback/base on the daily: any qualified base OR recent pullback
  // (swing low below current price within the last ~40 bars after an advance)
  const bases = detectBases(candles).bases;
  const recentBase = bases.find(b => b.end_bar >= triggerScanStart);
  let pullback = null;
  if (recentBase) {
    pullback = { low: recentBase.price_low, end_bar: recentBase.end_bar, kind: 'base' };
  } else {
    const { lows } = findSwings(candles, { swingLeft: 3, swingRight: 3 });
    const recentLows = lows.filter(s => s.index >= lastBar - 40 && s.price < candles[lastBar][4]);
    if (!recentLows.length) return { ok: false, reason: 'no qualifying pullback/base on daily' };
    const pl = recentLows[recentLows.length - 1];
    pullback = { low: pl.price, end_bar: pl.index, kind: 'pullback' };
  }

  // B.3 — volume contraction through the pullback: first-third vs last-third
  // of the pullback span (origin swing-high → pullback low), mirroring the
  // breakout base's dry-up rule. Only applied when the span is long enough
  // to split into thirds (≥9 bars); short pullbacks skip the check.
  const vEnd = pullback.end_bar;
  const { highs: dHighs } = findSwings(candles, { swingLeft: 3, swingRight: 3 });
  const origin = dHighs.filter(s => s.index < vEnd).pop();
  if (origin && vEnd - origin.index >= 9) {
    const span = vEnd - origin.index;
    const third = Math.floor(span / 3);
    let s1 = 0, s2 = 0;
    for (let i = origin.index + 1; i <= origin.index + third; i++) s1 += candles[i][5]; // skip origin bar (low-vol spike top)
    for (let i = vEnd - third + 1; i <= vEnd; i++) s2 += candles[i][5];
    const ratio = (s2 / third) / (s1 / third);
    pullback.vol_ratio = +ratio.toFixed(2);
    if (ratio > opts.pullbackVolDropPct) return { ok: false, reason: `pullback volume ${(ratio * 100).toFixed(0)}% of prior (need ≤ ${(opts.pullbackVolDropPct * 100).toFixed(0)}%)`, pullback };
  }

  // B.4 — distance to HTF resistance on the DAILY close (spec: recompute at
  // daily level; the weekly-close distance from A.4 can differ materially)
  if (htf.nearest_resistance_zone) {
    const atrNow = atrs[lastBar];
    if (atrNow != null && atrNow > 0) {
      const dDist = (htf.nearest_resistance_zone.price_low - candles[lastBar][4]) / atrNow;
      pullback.daily_dist_to_res_atr = +dDist.toFixed(2);
      if (dDist < opts.minDistToResAtr) {
        return { ok: false, reason: `daily close only ${dDist.toFixed(2)}×ATR under weekly resistance (≥ ${opts.minDistToResAtr} required — breakout variant, not trend-continuation)`, pullback };
      }
    }
  }
  return { ok: true, pullback, dStruct };
}

// ---------- Frame 3 — entry trigger on the lowest stored timeframe (daily) ----------
function findTrigger(candles, pullback, startBar, atrs, opts) {
  const n = candles.length;
  for (let i = Math.max(startBar, pullback.end_bar + 1); i < n; i++) {
    // C.1 — local structure break: close above the highest high of the
    // pullback's last 10 bars (before bar i)
    const ws = Math.max(0, i - 10);
    let swingHigh = 0;
    for (let k = ws; k < i; k++) swingHigh = Math.max(swingHigh, candles[k][2]);
    const c = candles[i][4];
    if (c <= swingHigh) continue;
    if (c <= candles[i][1]) continue; // need a bullish close vs open

    // C.2 — trigger volume ≥ volMult × 20-day avg
    if (i < 20) continue;
    let vs = 0;
    for (let k = i - 20; k < i; k++) vs += candles[k][5];
    const volAvg = vs / 20;
    const volMult = candles[i][5] / volAvg;
    if (volMult < opts.volMult) continue;

    // E.4 — candle-quality gate (Task 2.8): the trigger candle must be
    // full-bodied AND confirmed by a genuine reaction or three soldiers.
    if (opts.candleQuality) {
      const atr = atrs[i];
      if (atr == null) continue;
      const cq = isValidBuySignal(candles, i, atr, volAvg);
      if (!cq.ok) continue;
    }

    // C.3 — stop: entry-frame swing low (pullback low) − 0.3×ATR
    const atr = atrs[i];
    if (atr == null) continue;
    const _atr = atr; // (shadow-safe)
    const stop = pullback.low - opts.stopAtrMult * atr;
    const risk = c - stop;
    if (risk <= 0) continue;

    // C.4 — target: HTF resistance zone above entry (or next weekly swing high)
    let target = null, targetKind = null;
    if (swingHigh > c) { target = swingHigh; targetKind = 'daily_swing'; }
    const rr = target ? (target - c) / risk : null;
    return {
      ok: true, entry_bar: i, entry: +c.toFixed(2), stop: +stop.toFixed(2),
      atr: +atr.toFixed(2), vol_mult: +volMult.toFixed(2), swing_high: +swingHigh.toFixed(2),
      target, target_rr: rr != null ? +rr.toFixed(2) : null, targetKind,
      // Frame-1 target resolved by caller (needs htf swing data)
    };
  }
  return { ok: false, reason: 'no qualifying structure-break trigger with volume' };
}

// ---------- main ----------
function detectMtfSignals(stockCandles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const n = stockCandles.length;
  const atrsDaily = atrSeries(stockCandles, 14);

  // Frame 1 — weekly gate
  const htf = htfGate(stockCandles, opts);
  const rejected = [];
  if (!htf.ok) return { signals: [], rejected: [{ frame: 'A', reason: htf.reason }], htf };
  // D.2 tracking
  const extInfo = { extended: htf.extended, ext_fast_atr: htf.ext_fast_atr, ext_slow_atr: htf.ext_slow_atr };

  // Frame 2 — daily confirmation
  const scanStart = Math.max(0, n - opts.lookbackBars);
  const dc = dailyConfirm(stockCandles, scanStart, htf, atrsDaily, opts);
  if (!dc.ok) return { signals: [], rejected: [{ frame: 'B', reason: dc.reason }], htf, extInfo };

  // Frame 3 — trigger
  const trig = findTrigger(stockCandles, dc.pullback, scanStart, atrsDaily, opts);
  if (!trig.ok) return { signals: [], rejected: [{ frame: 'C', reason: trig.reason }], htf, extInfo };

  // C.4 — resolve HTF target: build the ladder of every HTF level above the
  // entry (weekly resistance zones, low AND high edges, plus weekly swing
  // highs), sorted nearest-first, and take the NEAREST level whose R:R
  // clears minRR. If no HTF level clears minRR, fall back to a measured-move
  // floor target (entry + minRR × risk) so good triggers aren't discarded
  // just because the first resistance sits close.
  const weekly = weeklyResample(stockCandles);
  const { highs: wHighs } = findSwings(weekly, { swingLeft: opts.wSwingLeft, swingRight: opts.wSwingRight });
  const risk = trig.entry - trig.stop;
  const ladder = [];
  const resZonesAbove = (htf.resistance_zones || []).filter(z => z.price_high > trig.entry);
  for (const z of resZonesAbove) {
    if (z.price_low > trig.entry) ladder.push({ price: z.price_low, kind: 'htf_resistance' });
    ladder.push({ price: z.price_high, kind: 'htf_resistance_top' });
  }
  for (const s of wHighs) if (s.price > trig.entry) ladder.push({ price: s.price, kind: 'htf_swing_high' });
  ladder.sort((a, b) => a.price - b.price);
  let target = null, targetKind = null;
  for (const lv of ladder) {
    if ((lv.price - trig.entry) / risk >= opts.minRR) { target = lv.price; targetKind = lv.kind; break; }
  }
  if (target == null) {
    target = trig.entry + opts.minRR * risk;
    targetKind = 'measured_move';
  }

  const lastBar = n - 1;
  const rr = (target - trig.entry) / risk;
  const signal = {
    engine: 'MTF TREND',
    entry_type: 'trend_continuation',
    actionable: (lastBar - trig.entry_bar) <= opts.recencyBars,
    entry_bar: trig.entry_bar,
    entry_date: stockCandles[trig.entry_bar][0],
    entry: trig.entry,
    stop: trig.stop,
    target: +target.toFixed(2),
    target_kind: targetKind,
    rr: +rr.toFixed(2),
    vol_mult: trig.vol_mult,
    swing_high: trig.swing_high,
    trend_state: htf.trend_state,
    distance_to_resistance_atr: htf.distance_to_resistance_atr,
    ext_fast_atr: htf.ext_fast_atr,
    ext_slow_atr: htf.ext_slow_atr,
    pullback: dc.pullback,
  };
  return { signals: [signal], rejected, htf, extInfo };
}

module.exports = {
  detectMtfSignals, htfGate, dailyConfirm, findTrigger,
  weeklyResample, weeklyResistanceZones, extensionCheck,
  DEFAULTS,
};
