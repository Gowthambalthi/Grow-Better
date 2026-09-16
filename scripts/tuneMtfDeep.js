/**
 * scripts/tuneMtfDeep.js — deep exit + filter tuning for MTF trades.
 * Re-simulates stored walk-forward trades under target/trail/breakeven
 * variants, split by target_kind (the signal-quality axis that matters).
 */
const fs = require('fs'), path = require('path');
const OHLCV = path.join(__dirname, '..', 'data', 'ohlcv');
const bt = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'phaseD_mtf_backtest.json'), 'utf8'));
const load = s => { try { return JSON.parse(fs.readFileSync(path.join(OHLCV, s + '.json'), 'utf8')).candles; } catch (_) { return null; } };

function atrAt(c, i, b = 14) {
  if (i < b) return null;
  let s = 0;
  for (let k = i - b + 1; k <= i; k++) {
    const bar = c[k];
    s += Math.max(bar[2] - bar[3], Math.abs(bar[2] - c[k - 1][4]), Math.abs(bar[3] - c[k - 1][4]));
  }
  return s / b;
}

function sim(c, eb, entry, stop0, tgtR, trailAtr, be) {
  const risk = entry - stop0;
  if (!(risk > 0)) return null;
  const tgt = entry + tgtR * risk;
  const atr = atrAt(c, eb);
  let stop = stop0, trail = null, armed = false;
  for (let k = eb + 1; k < c.length; k++) {
    const lo = c[k][3], hi = c[k][2];
    if (hi >= entry + risk) {
      if (be) stop = Math.max(stop, entry);
      if (trailAtr && !armed) { armed = true; trail = hi; }
    }
    if (armed && trailAtr && atr) { trail = Math.max(trail, hi); stop = Math.max(stop, trail - trailAtr * atr); }
    if (lo <= stop) return { exit: stop, reason: armed && stop > entry + risk ? 'TRAIL' : (stop >= entry ? 'BE' : 'SL') };
    if (hi >= tgt) return { exit: tgt, reason: 'TGT' };
    if (k - eb > 35) return { exit: c[k][4], reason: 'TIME' };
  }
  return { exit: entry, reason: 'NOFWD' };
}

function run(filter, tgtR, trail, be, label) {
  const rs = [];
  for (const t of bt.trades) {
    if (filter && !filter(t)) continue;
    const c = load(t.symbol);
    if (!c) continue;
    const eb = c.findIndex(x => x[0] === t.entry_date);
    if (eb < 0 || eb + 1 >= c.length) continue;
    const s = sim(c, eb, t.entry, t.stop, tgtR, trail, be);
    if (s) rs.push((s.exit - t.entry) / (t.entry - t.stop));
  }
  const w = rs.filter(r => r > 0).length;
  console.log(label.padEnd(44), 'n=' + String(rs.length).padStart(3),
    'win=' + String((100 * w / rs.length).toFixed(0)).padStart(3) + '%',
    'avgR=' + (rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(3),
    'totalR=' + rs.reduce((s, r) => s + r, 0).toFixed(1));
}

const sh = t => t.target_kind === 'htf_swing_high';

run(null, 2, 0, false, 'ALL tgt=2R none (baseline)');
run(null, 1.5, 1.0, true, 'ALL tgt=1.5R trail1xATR+BE');
run(sh, 2, 0, false, 'swingHighTgt tgt=2R none');
run(sh, 1.5, 1.0, true, 'swingHighTgt tgt=1.5R trail+BE');
run(sh, 1.2, 1.0, true, 'swingHighTgt tgt=1.2R trail+BE');
run(sh, 1.0, 1.0, true, 'swingHighTgt tgt=1.0R trail+BE');
run(sh, 1.5, 1.5, true, 'swingHighTgt tgt=1.5R trail1.5+BE');
run(sh, 2.0, 1.0, true, 'swingHighTgt tgt=2R trail+BE');
