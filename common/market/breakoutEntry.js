/**
 * common/market/breakoutEntry.js — Phase 4: breakout entry logic.
 *
 * Takes Phase 3 bases (breakout.js detectBases) and turns them into live
 * breakout signals:
 *
 *   Task 4.1  Breakout candle   — close above base resistance, in the upper
 *             third of the day's range, clearing resistance by ≥ clearAtrMult
 *             (default 0.3) ×ATR. A high that pierces but closes in the lower
 *             half is rejected.
 *   Task 4.2  Volume confirm    — breakout-day volume ≥ breakoutVolMult
 *             (default 1.5, spec 1.5–2) × the volAvgBars (default 50) average.
 *             Failures are marked unconfirmed and excluded from the primary set.
 *   Task 4.3  Follow-through    — if followThroughBars ≥ 1, price must hold
 *             above the level for that many subsequent bars (close > level)
 *             before the signal is live. entryBar shifts accordingly; the
 *             backtest can A/B same-bar (0) vs delayed (1–2) via config.
 *   Task 4.4  Retest entries    — if retestEntry is on, a pullback to the
 *             breakout level that CLOSES back above it within retestBars is
 *             also a valid entry (flagged entry_type='retest', tracked
 *             separately for win-rate/R:R comparison).
 *   Task 4.5  Don't-chase       — reject if close > maxExtensionMult
 *             (default 2.5) ×ATR above the 20-bar MA at breakout time, and
 *             require RS vs benchmark ≥ 0 over the base period (rsBars).
 *
 * Main API:
 *   detectBreakoutSignals(stockCandles, niftyCandles, opts) -> { signals, unconfirmed, rejected, bases }
 *   Each signal: { entry_type, breakout_bar, entry_bar, entry, level, stop,
 *                  target, rr, volume_mult, extension_atr, rs, base: {...} }
 */
'use strict';

const { detectBases } = require('./breakout');

function atrSeries(candles, period = 14) {
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

function sma(values, endIdx, period) {
  if (endIdx + 1 < period) return null;
  let s = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) s += values[i];
  return s / period;
}

const DEFAULTS = {
  // Task 4.1
  clearAtrMult: 0.3,     // close must clear level by ≥ 0.3×ATR
  // Task 4.2
  breakoutVolMult: 1.5,  // spec 1.5–2 × average
  volAvgBars: 50,        // 20/50-day average (default 50; set 20 for faster)
  // Task 4.3
  followThroughBars: 1,  // 0 = same-bar entry (backtest A/B toggle), 1–2 = hold bars
  // Task 4.4
  retestEntry: true,     // allow retest entries alongside breakout entries
  retestBars: 5,         // pullback window after breakout to find the retest
  retestTolAtrMult: 0.25, // how far below the level a retest may dip (intrabar) — must still CLOSE back above
  // Task 4.5
  maxExtensionMult: 2.5, // close ≤ 2.5×ATR above 20MA
  maBars: 20,
  rsBars: 20,            // RS measured over the base period (≈ base length, floor 10)
  // scanning
  recencyBars: 5,        // breakout must be within N bars of the last candle to be actionable
  minRR: 1.5,            // stop/target sanity: stop = level − stopAtrMult×ATR
  targetRiskMult: 2.0,   // target ≥ entry + 2×(entry − stop) when entry sits above the level
  stopAtrMult: 0.3,
  baseOpts: {},          // passthrough to detectBases
};

// ---------- Task 4.1 ----------
function breakoutCandleOk(candle, level, atr, opts) {
  const [, o, h, l, c] = candle;
  const range = h - l;
  if (range <= 0) return { ok: false, reason: 'zero-range breakout candle' };
  const clearsBy = c - level;
  if (clearsBy < opts.clearAtrMult * atr) {
    return { ok: false, reason: `close clears level by ${clearsBy.toFixed(2)} < ${opts.clearAtrMult}×ATR (${(opts.clearAtrMult * atr).toFixed(2)})` };
  }
  const position = (c - l) / range;
  if (position < 2 / 3) {
    return { ok: false, reason: `close in ${position <= 0.5 ? 'lower half' : 'middle third'} of range (position ${position.toFixed(2)})` };
  }
  return { ok: true, clearsBy: +clearsBy.toFixed(2), position: +position.toFixed(2) };
}

// ---------- Task 4.2 ----------
function volumeConfirmOk(candles, bar, opts) {
  if (bar < opts.volAvgBars) return { ok: false, mult: null, reason: 'insufficient history for volume average' };
  let s = 0;
  for (let i = bar - opts.volAvgBars; i < bar; i++) s += candles[i][5];
  const avg = s / opts.volAvgBars;
  const mult = avg > 0 ? candles[bar][5] / avg : 0;
  return {
    ok: mult >= opts.breakoutVolMult,
    mult: +mult.toFixed(2),
    reason: mult >= opts.breakoutVolMult ? null : `breakout volume ${mult.toFixed(2)}× ${opts.volAvgBars}-day avg < ${opts.breakoutVolMult}×`,
  };
}

// ---------- Task 4.5 ----------
function extensionOk(candles, bar, atr, opts) {
  const closes = candles.map(c => c[4]);
  const ma = sma(closes, bar, opts.maBars);
  if (ma == null) return { ok: false, reason: 'insufficient history for MA' };
  const ext = (candles[bar][4] - ma) / atr;
  return {
    ok: ext <= opts.maxExtensionMult,
    extension_atr: +ext.toFixed(2),
    ma: +ma.toFixed(2),
    reason: ext > opts.maxExtensionMult ? `close ${(ext).toFixed(1)}×ATR above ${opts.maBars}MA > ${opts.maxExtensionMult}× (don't chase)` : null,
  };
}

function rsOk(stockCandles, niftyCandles, bar, opts) {
  const startBar = bar - opts.rsBars;
  if (startBar < 0) return { ok: false, reason: 'insufficient history for RS' };
  const a = stockCandles[startBar][4], b = stockCandles[bar][4];
  if (!a) return { ok: false, reason: 'insufficient history for RS' };
  const stockRet = (b - a) / a;
  let niftyRet = 0;
  if (niftyCandles && niftyCandles.length > opts.rsBars) {
    const nb = Math.min(bar, niftyCandles.length - 1);
    const na = niftyCandles[nb - opts.rsBars][4];
    if (na) niftyRet = (niftyCandles[nb][4] - na) / na;
  }
  const rs = stockRet - niftyRet;
  return { ok: rs >= 0, rs: +rs.toFixed(4), reason: rs >= 0 ? null : `RS ${(rs * 100).toFixed(1)}% < 0 over ${opts.rsBars} bars` };
}

// ---------- Task 4.3 / 4.4 entry construction ----------
/**
 * Given a validated breakout at `breakoutBar` on `base`, construct the entry:
 *   - follow-through: advance entryBar until close held above level for
 *     followThroughBars consecutive bars (signal dies if price falls back below).
 *   - retest: optionally, look for a dip to the level that closes back above.
 * Returns { ok, entry_type, entry_bar, entry, reason } or !ok with reason.
 */
function buildEntry(candles, level, atr, breakoutBar, opts) {
  const n = candles.length;

  // ---- Task 4.3: follow-through path ----
  if (opts.followThroughBars <= 0) {
    // same-bar A/B lane: enter at the breakout candle's own close
    return { ok: true, entry_type: 'breakout', entry_bar: breakoutBar, entry: candles[breakoutBar][4] };
  }
  let holdCount = 0;
  let entryBar = null;
  for (let k = breakoutBar + 1; k < n; k++) {
    if (candles[k][4] > level) {
      holdCount++;
      if (holdCount >= opts.followThroughBars) { entryBar = k; break; }
    } else {
      // hold chain broken — fall through to the retest path instead of dying:
      // a dip to the level that CLOSES back above is exactly a retest entry
      break;
    }
  }
  if (entryBar == null && !opts.retestEntry) {
    return { ok: false, entry_type: 'breakout', reason: 'follow-through failed: close back below level before hold confirmed' };
  }
  const followEntry = entryBar != null
    ? { ok: true, entry_type: 'breakout', entry_bar: entryBar, entry: candles[entryBar][4] }
    : null;

  // ---- Task 4.4: retest path ----
  if (opts.retestEntry) {
    const retestEnd = Math.min(breakoutBar + opts.retestBars, n - 1);
    for (let k = breakoutBar + 1; k <= retestEnd; k++) {
      const [, o, h, l, c] = candles[k];
      const dipped = l <= level + opts.retestTolAtrMult * atr;
      const heldAbove = c > level;
      if (dipped && heldAbove) { // dipped to the level and CLOSED back above it
        return { ok: true, entry_type: 'retest', entry_bar: k, entry: c };
      }
      if (c < level - opts.retestTolAtrMult * atr) {
        // level lost on close — retest dead
        if (!followEntry) return { ok: false, entry_type: 'breakout', reason: 'retest failed: level lost on close' };
        break;
      }
    }
  }
  if (!followEntry) return { ok: false, entry_type: 'breakout', reason: 'no follow-through and no qualifying retest' };
  return followEntry;
}

// ---------- stop / target ----------
function stopTarget(entry, level, atr, opts) {
  // stop lives just below the structure (level − stopAtrMult×ATR); measured
  // from the ENTRY (which may sit above the level after follow-through)
  const stop = level - opts.stopAtrMult * atr;
  const risk = entry - stop;
  if (risk <= 0) return { ok: false, reason: 'non-positive risk' };
  // measured move: projection = full structural risk (level→stop) from the
  // level, and target must clear the entry by ≥ 2× the entry's own risk
  const projection = level + (level - stop);
  const target = Math.max(projection, entry + opts.targetRiskMult * risk);
  const rr = (target - entry) / risk;
  if (rr < opts.minRR) return { ok: false, reason: `R:R 1:${rr.toFixed(2)} < 1:${opts.minRR}`, stop, target, rr };
  return { ok: true, stop, target, rr };
}

// ---------- main ----------
function detectBreakoutSignals(stockCandles, niftyCandles, userOpts = {}) {
  const opts = { ...DEFAULTS, ...userOpts };
  const { bases, fast_momentum, rejected: rejectedBases } = detectBases(stockCandles, opts.baseOpts);
  const atrs = atrSeries(stockCandles, 14);
  const n = stockCandles.length;
  const signals = [], unconfirmed = [], rejected = [];

  for (const base of bases) {
    const level = base.price_high;
    // scan bars from the base end onward for the breakout candle
    for (let bar = base.end_bar; bar < Math.min(n, base.end_bar + 15); bar++) {
      const atr = atrs[bar];
      if (atr == null) continue;

      // Task 4.5 — don't chase + RS (checked at breakout time)
      const ext = extensionOk(stockCandles, bar, atr, opts);
      if (!ext.ok) { rejected.push({ bar, date: stockCandles[bar][0], base_level: level, reason: ext.reason }); continue; }
      const rs = rsOk(stockCandles, niftyCandles, bar, { ...opts, rsBars: Math.max(10, Math.min(opts.rsBars, bar - base.start_bar)) });
      if (!rs.ok) { rejected.push({ bar, date: stockCandles[bar][0], base_level: level, reason: rs.reason }); continue; }

      // Task 4.1 — breakout candle
      const bc = breakoutCandleOk(stockCandles[bar], level, atr, opts);
      if (!bc.ok) { rejected.push({ bar, date: stockCandles[bar][0], base_level: level, reason: bc.reason }); continue; }

      // Task 4.2 — volume confirmation
      const vc = volumeConfirmOk(stockCandles, bar, opts);
      if (!vc.ok) {
        unconfirmed.push({ bar, date: stockCandles[bar][0], base_level: level, volume_mult: vc.mult, reason: vc.reason });
        continue;
      }

      // Task 4.3/4.4 — entry construction
      const ent = buildEntry(stockCandles, level, atr, bar, opts);
      if (!ent.ok) { rejected.push({ bar, date: stockCandles[bar][0], base_level: level, reason: ent.reason }); continue; }

      const st = stopTarget(ent.entry, level, atrs[ent.entry_bar] || atr, opts);
      if (!st.ok) { rejected.push({ bar, date: stockCandles[bar][0], base_level: level, reason: st.reason }); continue; }

      signals.push({
        entry_type: ent.entry_type,
        breakout_bar: bar,
        breakout_date: stockCandles[bar][0],
        entry_bar: ent.entry_bar,
        entry_date: stockCandles[ent.entry_bar][0],
        entry: +ent.entry.toFixed(2),
        level,
        stop: +st.stop.toFixed(2),
        target: +st.target.toFixed(2),
        rr: +st.rr.toFixed(2),
        volume_mult: vc.mult,
        clears_by: bc.clearsBy,
        close_position: bc.position,
        extension_atr: ext.extension_atr,
        ma: ext.ma,
        rs: rs.rs,
        base: { price_low: base.price_low, price_high: base.price_high, bars: base.bars, touches: base.resistance_touches.length, contraction_ratio: base.contraction_ratio },
      });
      break; // one signal per base
    }
  }

  // actionable = entry near the present
  for (const s of signals) s.actionable = (n - 1 - s.entry_bar) <= opts.recencyBars;
  bases.sort((a, b) => b.end_bar - a.end_bar);
  return { signals, unconfirmed, rejected, bases, fast_momentum, rejected_bases: rejectedBases };
}

module.exports = {
  detectBreakoutSignals,
  breakoutCandleOk, volumeConfirmOk, extensionOk, rsOk, buildEntry, stopTarget,
  DEFAULTS,
};
