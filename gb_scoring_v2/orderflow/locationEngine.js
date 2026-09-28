/**
 * gb_scoring_v2/orderflow/locationEngine.js — PHASE 3: WHERE IS THE PRICE?
 *
 * The plan's decision gate will not fire on a delta flip alone; it fires when that flip happens
 * AT A LEVEL. This module answers "is there a level here, and how close is it", from five
 * independent families so a single missing source cannot silently make every row "not at a level":
 *
 *   VWAP        — running session VWAP, accumulated incrementally (O(1) per tick) so it covers
 *                 the WHOLE session. Reading it from the capture ring would only ever cover the
 *                 ring's last ~25 minutes, which is a different, moving number wearing VWAP's name.
 *   POC / VA    — from the footprint table (Phase 2), which is volume at price, not closes.
 *   Camarilla   — previous-day OHLC from data/ohlcv/<SYMBOL>.json, standard 1.1 divisors.
 *   FVG         — a 3-candle unfilled imbalance on the sealed 1m bars, with the gap's own bounds
 *                 as the levels rather than its midpoint.
 *   Absorption  — a level where one side absorbed the other (Phase 2).
 *
 * TOLERANCE IS PER INSTRUMENT, NAMED, AND PLACEHOLDER. "Within N ticks" cannot be a constant: 5
 * ticks is 0.01% of a ₹40,000 stock and 0.5% of a ₹100 one. So the tolerance is derived from the
 * symbol's OWN measured 1m range (mean of the last 20 sealed bars) with a floor and a cap, and the
 * value actually used is returned so it can be challenged instead of guessed at.
 */
const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', '..', 'data', 'ohlcv');
const TOL_FLOOR_PCT = 0.05;      // never tighter than this — a spread would trigger it
const TOL_CAP_PCT = 0.60;        // never looser than this — everything would be "at a level"
const TOL_RANGE_FRAC = 0.30;     // 30% of the symbol's own mean 1m range
const MIN_BARS_FOR_RANGE = 5;

const vwapState = new Map();     // token -> {sumPV, sumV, ticks, basis}
const pvCache = new Map();       // symbol -> {at, ohlc}

function todayIST(ts = Date.now()) {
  return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
}

/** observe(token, row) — the VWAP accumulator, fed one captured tick. */
function observe(token, row) {
  if (!token || !row || !(row.p > 0)) return;
  const key = String(token);
  let s = vwapState.get(key);
  if (!s) { s = { sumPV: 0, sumV: 0, ticks: 0, qtyTicks: 0, basis: 'tick' }; vwapState.set(key, s); }
  const w = row.q > 0 ? row.q : 1;
  if (row.q > 0) { s.qtyTicks++; s.basis = s.qtyTicks >= s.ticks * 0.5 ? 'qty' : 'tick'; }
  s.sumPV += row.p * w;
  s.sumV += w;
  s.ticks++;
}

function vwap(token) {
  const s = vwapState.get(String(token));
  if (!s || !(s.sumV > 0)) return null;
  return +(s.sumPV / s.sumV).toFixed(2);
}

/** vwapBasis(token) — 'qty' when most ticks carried a traded quantity, else 'tick'. */
function vwapBasis(token) {
  const s = vwapState.get(String(token));
  return s ? s.basis : null;
}

/** prevDayOHLC(symbol) — last daily candle strictly before today, cached for the session. */
function prevDayOHLC(symbol) {
  const sym = String(symbol || '').replace(/-EQ$/i, '').toUpperCase();
  if (!sym) return null;
  const hit = pvCache.get(sym);
  if (hit && Date.now() - hit.at < 3600e3) return hit.ohlc;
  let ohlc = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8'));
    const today = todayIST();
    const prior = (j.candles || []).filter((c) => Array.isArray(c) && c[0] < today);
    if (prior.length) {
      const c = prior[prior.length - 1];
      // [date, open, high, low, close, volume]
      if (c[2] > 0 && c[3] > 0 && c[4] > 0) ohlc = { date: c[0], open: c[1], high: c[2], low: c[3], close: c[4] };
    }
  } catch (e) { ohlc = null; }
  pvCache.set(sym, { at: Date.now(), ohlc });
  return ohlc;
}

/**
 * camarilla(ohlc) — the STANDARD 1.1-divisor Camarilla pivots off the previous day's OHLC:
 *
 *   R4 = C + range*1.1/2     R3 = C + range*1.1/4     R2 = C + range*1.1/6     R1 = C + range*1.1/12
 *   S1 = C - range*1.1/12    S2 = C - range*1.1/6     S3 = C - range*1.1/4     S4 = C - range*1.1/2
 *
 * The ordering is not cosmetic: a first version of this module labelled the previous day's HIGH as
 * "R4", which put the top reaction level BELOW R3 and made every band test above it meaningless.
 * R4 is the widest reaction level by construction — R4 > R3 > R2 > R1 > C > S1 > S2 > S3 > S4 — and
 * the test suite now locks that ordering rather than trusting the naming.
 */
function camarilla(ohlc) {
  if (!ohlc) return null;
  const range = ohlc.high - ohlc.low;
  if (!(range > 0)) return null;
  const c = ohlc.close;
  const u = range * 1.1;
  const up = (k) => +(c + u / k).toFixed(2);
  const dn = (k) => +(c - u / k).toFixed(2);
  return {
    r1: up(12), r2: up(6), r3: up(4), r4: up(2),
    s1: dn(12), s2: dn(6), s3: dn(4), s4: dn(2),
    prevHigh: +ohlc.high.toFixed(2), prevLow: +ohlc.low.toFixed(2), prevClose: +c.toFixed(2),
    range: +range.toFixed(3), from: ohlc.date,
  };
}

/** camZone(price, cam) — which Camarilla band the price is in (widest band named first). */
function camZone(price, cam) {
  if (!cam || !(price > 0)) return null;
  if (price >= cam.r4) return 'ABOVE_R4';
  if (price >= cam.r3) return 'R3-R4';
  if (price >= cam.r2) return 'R2-R3';
  if (price >= cam.r1) return 'R1-R2';
  if (price <= cam.s4) return 'BELOW_S4';
  if (price <= cam.s3) return 'S3-S4';
  if (price <= cam.s2) return 'S2-S3';
  if (price <= cam.s1) return 'S1-S2';
  return 'MID';
}

/**
 * fvg(bars) — the nearest UNFILLED 3-candle imbalance, oldest-to-newest scan keeping the latest.
 * A bullish gap (bar[i-2].h < bar[i].l) is filled when price later trades back below its floor;
 * until then its floor is a support level. Mirror for bearish.
 */
function fvg(bars) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  let best = null;
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    if (!(a && c) || a.h == null || c.l == null) continue;
    let g = null;
    if (a.h < c.l) g = { dir: 'bull', low: a.h, high: c.l, at: c.t };
    else if (a.l > c.h) g = { dir: 'bear', low: c.h, high: a.l, at: c.t };
    if (!g) continue;
    // filled? any later bar traded through the far edge of the gap
    let filled = false;
    for (let j = i + 1; j < bars.length; j++) {
      const b = bars[j];
      if (!b) continue;
      if (g.dir === 'bull' && b.l != null && b.l <= g.low) { filled = true; break; }
      if (g.dir === 'bear' && b.h != null && b.h >= g.high) { filled = true; break; }
    }
    if (filled) continue;
    best = { dir: g.dir, low: +g.low.toFixed(2), high: +g.high.toFixed(2), at: new Date(g.at).toISOString(), ageBars: bars.length - 1 - i };
  }
  return best;
}

/** typicalRange(bars) — the symbol's own mean 1m range, the basis for the tolerance. */
function typicalRange(bars) {
  if (!Array.isArray(bars) || bars.length < MIN_BARS_FOR_RANGE) return null;
  const win = bars.slice(-20).filter((b) => b && b.h != null && b.l != null);
  if (win.length < MIN_BARS_FOR_RANGE) return null;
  const rs = win.map((b) => b.h - b.l).sort((x, y) => x - y);
  return rs[Math.floor(rs.length / 2)];    // median: one violent bar must not widen the tolerance
}

/**
 * atLocation(token, symbol, price, fp, bars) — is the price at a level, and which one?
 * Returns { at, hits, tol, tolPct, range, levels, note }.
 */
function atLocation(token, symbol, price, fp, bars) {
  const p = Number(price);
  if (!(p > 0)) return { at: false, hits: [], tol: null, tolPct: null, levels: [], note: 'no price' };
  const tr = typicalRange(bars);
  const rangePct = tr != null ? (tr / p) * 100 : null;
  const tolPct = rangePct == null
    ? TOL_FLOOR_PCT
    : Math.min(TOL_CAP_PCT, Math.max(TOL_FLOOR_PCT, rangePct * TOL_RANGE_FRAC));
  const tol = (tolPct / 100) * p;

  const levels = [];
  const push = (name, value) => {
    const v = Number(value);
    if (v > 0) levels.push({ name, value: +v.toFixed(2), distPct: +(((p - v) / v) * 100).toFixed(2), distAbs: +Math.abs(p - v).toFixed(3) });
  };
  push('VWAP', vwap(token));
  const P = fp && fp.poc ? fp.poc : {};
  push('POC', P.poc); push('VAH', P.vah); push('VAL', P.val);
  const cam = camarilla(prevDayOHLC(symbol));
  // The two REACTION levels each side, not all four: R1/S1 sit inside the previous day's range and
  // are touched constantly, R4/S4 are the extremes. R2/R3 and S2/S3 are the levels a reversal
  // actually has to reach to be a reversal, which is what this layer is asked to judge.
  if (cam) { push('R3', cam.r3); push('R2', cam.r2); push('S2', cam.s2); push('S3', cam.s3); }
  const ab = fp && fp.absorption ? fp.absorption : null;
  if (ab) push('ABSORPTION(' + ab.side + ')', ab.price);
  const gap = fvg(bars);
  if (gap) { push('FVG-' + gap.dir + ' floor', gap.low); push('FVG-' + gap.dir + ' top', gap.high); }

  const hits = levels.filter((l) => l.distAbs <= tol).sort((a, b) => a.distAbs - b.distAbs);
  return {
    at: hits.length > 0,
    hits,
    tol: +tol.toFixed(3),
    tolPct: +tolPct.toFixed(3),
    range: tr == null ? null : +tr.toFixed(3),
    levels: levels.sort((a, b) => a.distAbs - b.distAbs).slice(0, 8),
    cam,
    camZone: camZone(p, cam),
    fvg: gap,
    vwap: vwap(token),
    poc: P.poc != null ? P.poc : null,
    vah: P.vah != null ? P.vah : null,
    val: P.val != null ? P.val : null,
    absorption: ab,
    note: tr == null ? 'range from fewer than ' + MIN_BARS_FOR_RANGE + ' sealed bars — floor tolerance in use' : null,
  };
}

function reset() { vwapState.clear(); }

module.exports = {
  observe, vwap, vwapBasis, prevDayOHLC, camarilla, camZone, fvg, typicalRange, atLocation, reset,
  TOL_FLOOR_PCT, TOL_CAP_PCT, TOL_RANGE_FRAC,
};
