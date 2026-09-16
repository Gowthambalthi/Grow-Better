/**
 * scripts/tuneMtfE.js — Tasks E.1–E.3: exit re-simulation on stored trades.
 *
 * E.1  breakeven stop-move at +1R
 * E.2  target from the MFE distribution (60–70th pct) instead of round numbers
 * E.3  early-stall exit: no new high above entry within N bars → exit
 *
 * Pure re-simulation on data/phaseD_mtf_backtest.json — no re-detection.
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

/** E.1+E.2+E.3 combined simulator. */
function sim(c, eb, entry, stop0, { tgtR, breakeven, stallBars, horizon = 35 }) {
  const risk = entry - stop0;
  if (!(risk > 0)) return null;
  const tgt = entry + tgtR * risk;
  let bestHigh = -Infinity; // highest high since entry
  let bestSinceEntry = -Infinity; // E.3 stall tracker
  for (let k = eb + 1; k < c.length; k++) {
    const lo = c[k][3], hi = c[k][2];
    bestSinceEntry = Math.max(bestSinceEntry, hi);
    // E.1 breakeven
    let stop = stop0;
    if (breakeven && bestHigh >= entry + risk) stop = Math.max(stop, entry);
    // E.3 stall: within first stallBars, price must exceed entry
    if (stallBars && k - eb > stallBars && bestSinceEntry <= entry) {
      return { exit: c[k][4], reason: 'STALL' };
    }
    if (lo <= stop) return { exit: stop, reason: stop >= entry ? 'BE' : 'SL' };
    if (hi >= tgt) return { exit: tgt, reason: 'TGT' };
    if (k - eb > horizon) return { exit: c[k][4], reason: 'TIME' };
    bestHigh = Math.max(bestHigh, hi);
  }
  return { exit: entry, reason: 'NOFWD' };
}

function run(filter, cfg, label) {
  const rs = [];
  for (const t of bt.trades) {
    if (filter && !filter(t)) continue;
    const c = load(t.symbol);
    if (!c) continue;
    const eb = c.findIndex(x => x[0] === t.entry_date);
    if (eb < 0 || eb + 1 >= c.length) continue;
    const s = sim(c, eb, t.entry, t.stop, cfg);
    if (s) rs.push({ x: (s.exit - t.entry) / (t.entry - t.stop), reason: s.reason });
  }
  const n = rs.length, w = rs.filter(o => o.x > 0).length, tot = rs.reduce((s, o) => s + o.x, 0);
  const gw = rs.filter(o => o.x > 0).reduce((s, o) => s + o.x, 0);
  const gl = Math.abs(rs.filter(o => o.x <= 0).reduce((s, o) => s + o.x, 0));
  const exits = rs.reduce((m, o) => ((m[o.reason] = (m[o.reason] || 0) + 1), m), {});
  const hold = '—';
  console.log(label.padEnd(46), 'n=' + String(n).padStart(3),
    'win=' + String((100 * w / n).toFixed(0)).padStart(3) + '%',
    'avgR=' + (tot / n).toFixed(3).padStart(7), 'totR=' + tot.toFixed(1).padStart(7),
    'PF=' + (gl > 0 ? (gw / gl).toFixed(2) : '∞'), JSON.stringify(exits));
  return { label, n, winPct: 100 * w / n, avgR: tot / n, totalR: tot, pf: gl > 0 ? gw / gl : null, exits };
}

// ----- E.2: MFE percentile target -----
const mfeVals = bt.trades.map(t => t.mfe).filter(m => m > 0).sort((a, b) => a - b);
const pct = p => mfeVals[Math.floor(mfeVals.length * p / 100)];
console.log('MFE distribution: p40=' + pct(40).toFixed(2), 'p50=' + pct(50).toFixed(2),
  'p60=' + pct(60).toFixed(2), 'p65=' + pct(65).toFixed(2), 'p70=' + pct(70).toFixed(2), '\n');

const base = { tgtR: 2.0, breakeven: false, stallBars: 0 };
const sh = t => t.target_kind === 'htf_swing_high';
const shOrResTop = t => t.target_kind === 'htf_swing_high' || t.target_kind === 'htf_resistance_top';

console.log('--- ALL 388 trades ---');
run(null, base, 'E0 baseline tgt=2R');
run(null, { ...base, breakeven: true }, 'E1 +breakeven@1R');
run(null, { ...base, breakeven: true, tgtR: +pct(65).toFixed(2) }, 'E1+E2 be + tgt=p65 MFE');
run(null, { ...base, breakeven: true, tgtR: +pct(65).toFixed(2), stallBars: 6 }, 'E1+E2+E3 be + p65 + stall6');
run(null, { ...base, breakeven: true, tgtR: +pct(60).toFixed(2), stallBars: 6 }, 'E1+E2+E3 be + p60 + stall6');
run(null, { ...base, breakeven: true, tgtR: +pct(70).toFixed(2), stallBars: 5 }, 'E1+E2+E3 be + p70 + stall5');
run(null, { ...base, breakeven: true, tgtR: +pct(65).toFixed(2), stallBars: 8 }, 'be + p65 + stall8');

console.log('\n--- Quality-filtered (swing-high / resistance-top targets) ---');
run(shOrResTop, base, 'filtered baseline');
run(shOrResTop, { ...base, breakeven: true, tgtR: +pct(65).toFixed(2), stallBars: 6 }, 'filtered be+p65+stall6');
run(shOrResTop, { ...base, breakeven: true, tgtR: +pct(60).toFixed(2), stallBars: 6 }, 'filtered be+p60+stall6');
