/**
 * scripts/backtestMtf.js — Phase D: MTF Trend Follow backtest (D.1 + D.2).
 *
 * Walk-forward, as-of evaluation (no look-ahead): for each stock we run
 * detectMtfSignals on candle slices ending at successive bars; a signal is
 * taken only when actionable at that slice end (trigger within recencyBars),
 * with a per-stock cooldown. The trade is then simulated on the forward bars.
 *
 * D.2 — counts Frame-A rejections caused by the extension filter
 * specifically (the GRANULES-style exhaustion guard).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { detectMtfSignals } = require('../common/market/mtfTrend');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_FILE = path.join(__dirname, '..', 'data', 'phaseD_mtf_backtest.json');

const STEP = 5;          // evaluate every 5th slice end
const MIN_HIST = 200;    // minimum history before first evaluation
const COOLDOWN = 10;     // bars between signals per stock

function simulate(candles, entryBar, sig, horizon = 35) {
  const entry = sig.entry, stop = sig.stop, target = sig.target;
  const risk = entry - stop;
  if (!(risk > 0)) return null;
  let mfe = 0, mae = 0;
  for (let k = entryBar + 1; k < Math.min(candles.length, entryBar + 1 + horizon); k++) {
    const lo = candles[k][3], hi = candles[k][2];
    mfe = Math.max(mfe, (hi - entry) / risk);
    mae = Math.min(mae, (lo - entry) / risk);
    if (lo <= stop) return { exit: stop, reason: 'SL', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
    if (hi >= target) return { exit: target, reason: 'TGT', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
  }
  const k = Math.min(candles.length - 1, entryBar + horizon);
  return { exit: candles[k][4], reason: 'TIME', exitBar: k, mfe: +mfe.toFixed(2), mae: +mae.toFixed(2) };
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { signals: 0 };
  const wins = trades.filter(t => t.rr > 0).length;
  const exits = {};
  for (const t of trades) exits[t.reason] = (exits[t.reason] || 0) + 1;
  return {
    signals: n,
    winRate: +(100 * wins / n).toFixed(1),
    avgR: +(trades.reduce((s, t) => s + t.rr, 0) / n).toFixed(2),
    avgHoldDays: +(trades.reduce((s, t) => s + t.holdDays, 0) / n).toFixed(1),
    avgMFE: +(trades.reduce((s, t) => s + (t.mfe || 0), 0) / n).toFixed(2),
    avgMAE: +(trades.reduce((s, t) => s + (t.mae || 0), 0) / n).toFixed(2),
    exits,
  };
}

function main() {
  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const trades = [];
  const rejectedByFrame = { A_trend: 0, A_extended: 0, B: 0, C: 0 };
  const rejections = [];
  let scanned = 0, slices = 0;
  const t0 = Date.now();

  for (const sym of symbols) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8')); } catch (_) { continue; }
    const candles = j.candles;
    if (!Array.isArray(candles) || candles.length < MIN_HIST + 40) continue;
    scanned++;
    let lastSignalBar = -Infinity;

    for (let end = MIN_HIST; end <= candles.length; end += STEP) {
      slices++;
      const slice = candles.slice(0, end);
      let r;
      try { r = detectMtfSignals(slice, {}); } catch (_) { continue; }

      if (!r.signals.length) {
        // only count rejections on the final slice (avoid re-counting the
        // same standing rejection every 5 bars)
        if (end + STEP > candles.length) {
          for (const rej of (r.rejected || [])) {
            if (rej.frame === 'A') {
              if (/extended/.test(rej.reason || '')) { rejectedByFrame.A_extended++; rejections.push({ sym, frame: 'A', reason: 'extended', detail: rej.reason }); }
              else { rejectedByFrame.A_trend++; rejections.push({ sym, frame: 'A', reason: rej.reason }); }
            } else if (rej.frame === 'B') { rejectedByFrame.B++; rejections.push({ sym, frame: 'B', reason: rej.reason }); }
            else if (rej.frame === 'C') { rejectedByFrame.C++; rejections.push({ sym, frame: 'C', reason: rej.reason }); }
          }
        }
        continue;
      }
      const sig = r.signals[0];
      if (!sig.actionable) continue;
      if (sig.entry_bar - lastSignalBar < COOLDOWN) continue;
      lastSignalBar = sig.entry_bar;

      const sim = simulate(candles, sig.entry_bar, sig);
      if (sim) {
        const risk = sig.entry - sig.stop;
        const realized = (sim.exit - sig.entry) / risk; // realized R, not planned
        trades.push({
          symbol: sym, entry_date: sig.entry_date, entry: sig.entry, stop: sig.stop,
          target: sig.target, target_kind: sig.target_kind, rr: +realized.toFixed(2),
          ...sim, holdDays: sim.exitBar - sig.entry_bar,
        });
      }
    }
  }

  const out = { mode: 'walk-forward as-of', scanned, slices, elapsedSec: +((Date.now() - t0) / 1000).toFixed(1), summary: summarize(trades), rejectedByFrame, trades, rejections };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ scanned, slices, summary: out.summary, rejectedByFrame, elapsedSec: out.elapsedSec }, null, 2));
}

main();
