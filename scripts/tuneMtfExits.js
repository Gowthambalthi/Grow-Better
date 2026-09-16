/**
 * scripts/tuneMtfExits.js — MTF exit-tuning sweep.
 *
 * Re-simulates every walk-forward trade from data/phaseD_mtf_backtest.json
 * over the stored candles with different exit rules (no re-detection):
 *
 *   targetR: 1.0 / 1.2 / 1.5 / 2.0   (planned target in R)
 *   trail:   none | atr1 | atr1.5    (ATR trail armed after +1R)
 *   breakeven: move stop to entry once trade is +1R
 *
 * Reports win rate / avg realized R / expectancy per combination and picks
 * the best by profit factor × signal retention.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const IN_FILE = path.join(__dirname, '..', 'data', 'phaseD_mtf_backtest.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'phaseD_mtf_tuning.json');

const ATR_BARS = 14;

function atrAt(candles, i, bars = ATR_BARS) {
  if (i < bars) return null;
  let s = 0;
  for (let k = i - bars + 1; k <= i; k++) {
    const c = candles[k];
    const tr = Math.max(c[2] - c[3], Math.abs(c[2] - candles[k - 1][4]), Math.abs(c[3] - candles[k - 1][4]));
    s += tr;
  }
  return s / bars;
}

/** Simulate with variable target, optional ATR trail (armed at +armR), optional breakeven. */
function simVariant(candles, entryBar, entry, stop0, targetR, trailAtr, armR = 1, horizon = 35) {
  const risk = entry - stop0;
  if (!(risk > 0)) return null;
  const target = entry + targetR * risk;
  const atr = atrAt(candles, entryBar);
  let stop = stop0;
  let trailArmed = false, trailLevel = null;
  for (let k = entryBar + 1; k < Math.min(candles.length, entryBar + 1 + horizon); k++) {
    const lo = candles[k][3], hi = candles[k][2];
    // trail arm
    if (trailAtr && !trailArmed && hi >= entry + armR * risk) { trailArmed = true; trailLevel = hi; }
    if (trailArmed && trailAtr && atr) {
      trailLevel = Math.max(trailLevel, hi);
      stop = Math.max(stop, trailLevel - trailAtr * atr);
    }
    // breakeven
    if (hi >= entry + armR * risk) stop = Math.max(stop, entry);
    // exit checks (conservative: SL first on ambiguous bars)
    if (lo <= stop) return { exit: stop, reason: trailArmed && stop > entry + armR * risk ? 'TRAIL' : (stop >= entry ? 'BE' : 'SL') };
    if (hi >= target) return { exit: target, reason: 'TGT' };
  }
  const k = Math.min(candles.length - 1, entryBar + horizon);
  if (candles[k] == null) return { exit: entry, reason: 'NOFWD' };
  return { exit: candles[k][4], reason: 'TIME' };
}

function summarize(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.rr > 0).length;
  const grossW = trades.filter(t => t.rr > 0).reduce((s, t) => s + t.rr, 0);
  const grossL = Math.abs(trades.filter(t => t.rr <= 0).reduce((s, t) => s + t.rr, 0));
  return {
    n,
    winRate: +(100 * wins / n).toFixed(1),
    avgR: +(trades.reduce((s, t) => s + t.rr, 0) / n).toFixed(3),
    totalR: +grossW - grossL > 0 ? +(grossW - grossL).toFixed(1) : +(grossW - grossL).toFixed(1),
    profitFactor: grossL > 0 ? +(grossW / grossL).toFixed(2) : null,
    exits: trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {}),
  };
}

function main() {
  const bt = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  const candleCache = new Map();
  const getCandles = sym => {
    if (!candleCache.has(sym)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8'));
        candleCache.set(sym, j.candles);
      } catch (_) { candleCache.set(sym, null); }
    }
    return candleCache.get(sym);
  };

  // Resolve entry_bar from entry_date (walk-forward JSON doesn't store it)
  let missing = 0;
  for (const t of bt.trades) {
    const candles = getCandles(t.symbol);
    if (!candles) { t.entry_bar = null; missing++; continue; }
    let idx = candles.findIndex(c => c[0] === t.entry_date);
    if (idx < 0) { // date mismatch fallback: nearest close match
      idx = candles.findIndex(c => Math.abs(c[4] - t.entry) < 1e-6 && c[0] >= t.entry_date);
    }
    t.entry_bar = idx;
    if (idx < 0) missing++;
  }
  const usable = bt.trades.filter(t => t.entry_bar != null && t.entry_bar + 1 < (getCandles(t.symbol) || []).length);
  console.log(`trades=${bt.trades.length} usable=${usable.length} missingBars=${missing}\n`);

  const variants = [];
  for (const targetR of [1.0, 1.2, 1.5, 2.0]) {
    for (const trail of [0, 1.0, 1.5]) {
      variants.push({ targetR, trailAtr: trail, breakeven: trail === 0 });
      if (trail === 0) variants.push({ targetR, trailAtr: 0, breakeven: false });
    }
  }

  const results = [];
  for (const v of variants) {
    const label = `tgt=${v.targetR}R trail=${v.trailAtr ? v.trailAtr + 'xATR' : 'none'} be=${v.breakeven ? 'y' : 'n'}`;
    const trades = [];
    const seen = new Set();
    for (const t of usable) {
      const key = t.symbol + '|' + t.entry_bar;
      if (seen.has(key)) continue;
      seen.add(key);
      const candles = getCandles(t.symbol);
      const sim = simVariant(candles, t.entry_bar, t.entry, t.stop, v.targetR, v.trailAtr);
      if (sim) {
        const risk = t.entry - t.stop;
        trades.push({ symbol: t.symbol, rr: +((sim.exit - t.entry) / risk).toFixed(2), reason: sim.reason });
      }
    }
    const s = summarize(trades);
    results.push({ ...v, label, ...s });
  }

  // baseline = current config (tgt 2R, no trail, no BE)
  const base = results.find(r => r.targetR === 2.0 && !r.trailAtr && !r.breakeven) || results[0];
  results.sort((a, b) => (b.avgR * (b.n || 0)) - (a.avgR * (a.n || 0))); // rank by total expectancy x count

  console.log('Baseline (tgt=2R, no trail):', JSON.stringify(base));
  console.log('\nRanked by total R (expectancy × count):');
  for (const r of results) console.log(r.label.padEnd(34), `n=${String(r.n).padStart(3)}`, `win=${String(r.winRate).padStart(5)}%`, `avgR=${String(r.avgR).padStart(6)}`, `totalR=${String(r.totalR).padStart(7)}`, `PF=${r.profitFactor}`, JSON.stringify(r.exits || {}));

  fs.writeFileSync(OUT_FILE, JSON.stringify({ baseline: base, results }, null, 2));
  console.log('\nSaved →', OUT_FILE);
}

main();
