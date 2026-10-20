/**
 * common/market/stopLevels.js — the engine IDENTIFIES the stop; it never guesses one.
 *
 * Every stop in the app comes from here. The old behaviour was a flat
 * percentage (0.6% below entry, or the session low/high for a position), which
 * is not a level at all: it can sit in the middle of nowhere, or 5% away when
 * the session extreme is far. This module reads the stock's OWN structure and
 * puts the stop under (long) / over (short) an actual level:
 *
 *   candidates, nearest-and-most-meaningful first:
 *     1. 3-bar micro low/high   — the pullback the current leg launched from
 *     2. VWAP                   — the session's real average price (buyers' line)
 *     3. 10-bar swing low/high  — the swing the move came out of
 *     4. Camarilla S3/R3        — prior-session level (intraday support/resistance)
 *     5. session low/high       — the day's extreme
 *     6. ATR band               — 0.6x ATR14 of the 1m bars, when no level is in range
 *
 * The first candidate whose distance from entry sits inside the risk band wins.
 * If nothing does, the band itself is applied and the basis SAYS so, so a stop
 * is never silently a made-up number.
 *
 * Usage:
 *   const sz = identifyStop({ side: 'LONG', ltp, bars, dayLow, dayHigh, cam });
 *   sz = { stop, riskPct, level, basis, candidates, vwap, atr, inBand }
 */

'use strict';

// ---- THE RISK BAND, RE-DERIVED FROM THE TAPE (was 0.20% - 0.80%) ----------------
// The old band was an assumption, and it was measured against 9.99 lakh 1-minute bars
// in .freebuff/backtest-geometry-sweep.js: THE SAME SIGNALS scored against 100 stop/
// target/horizon shapes, split into an earlier search half and a later TEST half,
// cost included in R. Two results matter here.
//
//  1. NOTHING in the grid is positive in both halves, so geometry is not a missing edge.
//  2. But the geometry ALONE was the dominant cause of the loss, and the old band sat at
//     the worst end of it. Net R per trade, engine's own signals:
//
//       CHASE LONG   0.4% stop   -0.282 train / -0.324 test   |  3.0% stop  -0.037 / -0.036
//       CHASE SHORT  0.4% stop   -0.267 / -0.248             |  3.0% stop  -0.036 / -0.032
//       FADE  LONG   0.4% stop   -0.279 / -0.311             |  3.0% stop  -0.035 / -0.035
//       FADE  SHORT  0.4% stop   -0.202 / -0.209             |  3.0% stop  -0.023 / -0.023
//
//   That is ~90% of the per-trade loss coming from the STOP DISTANCE, not the signal, and
//   EVERY best cell in the grid used the widest stop tested - the improvement had not
//   stopped at 3%.
//
// MEASURED AGAINST LIVE CALLS (data/live_calls.json, 489 calls with a stop): median risk
// 0.373%, p25 0.255%, p90 0.730%; 36.4% under 0.30% and 78.7% under 0.60%. With the old
// band that is not an accident, it is arithmetic: the band's CEILING was 0.80%, the
// engine takes the nearest preferred structure inside it, and a 1-minute entry with a
// 0.37% stop is stopped out by the ordinary pullback a 1m move always has.
//
// So the floor moves to 0.60% and the ceiling to 2.50%. HONESTY ABOUT WHAT THIS IS: it
// removes the loss, it does NOT create profit - the residual -0.02 to -0.04R in the
// wide-stop cells is the size of the round-trip cost assumption itself. Both values are
// env-overridable, so this is reversible without a code edit.
const DEFAULTS = {
  minRiskPct: Number(process.env.GB_MIN_STOP_RISK_PCT || 0.60),
  maxRiskPct: Number(process.env.GB_MAX_STOP_RISK_PCT || 2.50),
  atrMult: 0.6,       // ATR band distance
  atrPeriod: 14,
};

/** Accepts either a 1m bar array or a fetchIntradaySeries result ({ bars, dayLow, dayHigh }). */
function barArray(bars) {
  if (Array.isArray(bars)) return bars;
  if (bars && Array.isArray(bars.bars)) return bars.bars;
  return [];
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { return v == null ? null : +(Number(v).toFixed(2)); }
function riskPctOf(ltp, level, long) {
  if (!(ltp > 0) || !(level > 0)) return null;
  const risk = long ? (ltp - level) : (level - ltp);
  return +((risk / ltp) * 100).toFixed(3);
}

/** ATR over the last `period` completed 1m bars. */
function atrOf(bars, period) {
  const b = barArray(bars).slice(-(period + 1));
  if (b.length < 3) return null;
  let sum = 0, n = 0;
  for (let i = 1; i < b.length; i++) {
    const prev = b[i - 1], cur = b[i];
    if (!cur || cur.l == null) continue;
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    if (Number.isFinite(tr)) { sum += tr; n++; }
  }
  return n ? sum / n : null;
}

/** Session VWAP from the 1m bars (typical price weighted by volume). */
function vwapOf(bars) {
  let pv = 0, vv = 0;
  for (const b of barArray(bars)) {
    if (b == null || b.c == null) continue;
    const v = b.v || 0;
    const tp = (b.h != null && b.l != null) ? (b.h + b.l + b.c) / 3 : b.c;
    pv += tp * v; vv += v;
  }
  return vv > 0 ? pv / vv : null;
}

/**
 * Build the identified levels for a side.
 * levels: [{ name, price }] in priority order (tightest structure first).
 * Completed bars only: the last 1m bar is still forming, its low/high is noise.
 */
function buildLevels(input) {
  const o = Object.assign({}, DEFAULTS, (input && input.opts) || {});
  const long = input.side !== 'SHORT';
  const ltp = num(input.ltp);
  const cam = input.cam;
  // The caller may hand over a bar array or a fetchIntradaySeries result; the
  // module needs nothing but the 1m series to identify a level.
  const series = Array.isArray(input.bars) ? null : input.bars;
  const bars = barArray(input.bars);
  let dayLow = num(input.dayLow) != null ? num(input.dayLow) : (series ? num(series.dayLow) : null);
  let dayHigh = num(input.dayHigh) != null ? num(input.dayHigh) : (series ? num(series.dayHigh) : null);
  if (dayLow == null && bars.length) dayLow = Math.min(...bars.map(b => b.l));
  if (dayHigh == null && bars.length) dayHigh = Math.max(...bars.map(b => b.h));
  const out = [];
  const push = (name, price) => {
    const p = num(price);
    if (p == null || !(p > 0)) return;
    // a long's stop must sit BELOW the entry, a short's ABOVE it
    if (long ? p >= ltp : p <= ltp) return;
    out.push({ name, price: r2(p) });
  };

  const done = bars.slice(0, Math.max(0, bars.length - 1)); // drop the forming bar
  if (done.length >= 3) {
    const micro = done.slice(-3);
    push('3-bar micro ' + (long ? 'low' : 'high'), long ? Math.min(...micro.map(b => b.l)) : Math.max(...micro.map(b => b.h)));
  }
  const vwap = vwapOf(bars);
  if (vwap) push('VWAP', vwap);
  if (done.length >= 10) {
    const swing = done.slice(-10);
    push('10-bar swing ' + (long ? 'low' : 'high'), long ? Math.min(...swing.map(b => b.l)) : Math.max(...swing.map(b => b.h)));
  }
  if (cam) push('Camarilla ' + (long ? 'S3' : 'R3'), long ? cam.s3 : cam.r3);
  if (long) push('session low', dayLow); else push('session high', dayHigh);

  const atr = atrOf(bars, o.atrPeriod);
  if (atr && atr > 0) push('ATR band (' + o.atrMult + 'x)', long ? ltp - atr * o.atrMult : ltp + atr * o.atrMult);

  return { levels: out, vwap: vwap ? r2(vwap) : null, atr: atr ? r2(atr) : null };
}

/**
 * The stop for one stock. Returns null only when there is nothing to work with
 * (no price), so callers can refuse the trade rather than invent a level.
 */
function identifyStop(input) {
  const o = Object.assign({}, DEFAULTS, (input && input.opts) || {});
  const side = (input && input.side) === 'SHORT' ? 'SHORT' : 'LONG';
  const long = side === 'LONG';
  const ltp = num(input && input.ltp);
  if (!(ltp > 0)) return null;

  const { levels, vwap, atr } = buildLevels(Object.assign({}, input, { side, ltp, cam: input.cam, opts: o }));
  const scored = [];
  for (const lv of levels) {
    const rp = riskPctOf(ltp, lv.price, long);
    if (rp == null) continue;
    scored.push({ name: lv.name, price: lv.price, riskPct: rp });
  }

  const inBand = scored.find(s => s.riskPct >= o.minRiskPct && s.riskPct <= o.maxRiskPct);
  const base = {
    side, ltp: r2(ltp), vwap, atr,
    candidates: scored.slice(0, 8),
    band: { min: o.minRiskPct, max: o.maxRiskPct },
  };

  if (inBand) {
    return Object.assign(base, {
      stop: inBand.price,
      riskPct: inBand.riskPct,
      level: inBand.name,
      basis: 'identified: ' + inBand.name + ' @ ' + inBand.price + ' (' + inBand.riskPct + '% risk)',
      inBand: true,
    });
  }

  // Nothing sat in the band. Say exactly why, and use the band edge rather than
  // a level that is either inside the noise or too far to be an intraday stop.
  const tightest = scored.length ? scored[scored.length - 1] : null;  // widest
  const closest = scored.length ? scored[0] : null;
  if (!scored.length) {
    const stop = long ? ltp * (1 - o.maxRiskPct / 100) : ltp * (1 + o.maxRiskPct / 100);
    return Object.assign(base, {
      stop: r2(stop), riskPct: o.maxRiskPct, level: null, inBand: false,
      basis: 'no level readable (no candles/VWAP) — ' + o.maxRiskPct + '% guard used',
    });
  }
  if (closest.riskPct < o.minRiskPct) {
    // every level is inside the noise: back the stop off to the band floor
    const stop = long ? ltp * (1 - o.minRiskPct / 100) : ltp * (1 + o.minRiskPct / 100);
    return Object.assign(base, {
      stop: r2(stop), riskPct: o.minRiskPct, level: closest.name, inBand: false,
      basis: 'levels too tight (' + closest.name + ' only ' + closest.riskPct + '% away) — ' + o.minRiskPct + '% floor',
    });
  }
  // all levels are further than the band allows: cap it, and name the structure
  const stop = long ? ltp * (1 - o.maxRiskPct / 100) : ltp * (1 + o.maxRiskPct / 100);
  return Object.assign(base, {
    stop: r2(stop), riskPct: o.maxRiskPct, level: closest.name, inBand: false,
    basis: 'nearest structure ' + tightest.name + ' is ' + tightest.riskPct + '% away — capped at ' + o.maxRiskPct + '%',
  });
}

module.exports = { identifyStop, buildLevels, atrOf, vwapOf, DEFAULTS };
