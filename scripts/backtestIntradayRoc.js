/**
 * scripts/backtestIntradayRoc.js — Backtest of the intraday ROC + VWAP strategy
 * on the 15-min store (989 symbols, ~6 months).
 *
 * Strategy (15-min bars standing in for 1-min — thresholds scaled x3):
 *   BUY when: ROC5 > +0.3% AND ROC15 > 0 AND volume(5-bar avg) >= 1.1x day avg
 *             AND close > day VWAP (buyers in control)
 *   STOP: 0.6% below entry.  T1: +1.2%.  T2: +2.4%.
 *   Exit at whichever hits first; EOD flat exit otherwise (intraday, no overnight).
 *   Costs: 12 bps round trip (mirrors the daily engine's net-R convention).
 *
 * Usage: node scripts/backtestIntradayRoc.js [--limit=N] [--no-vwap]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const STOP_PCT = 0.6, T1_PCT = 1.2, T2_PCT = 2.4;
const ROC5_TH = 0.3, VOLX_TH = 1.1;
const COST_PCT = 0.12; // round-trip, % of entry
const args = process.argv.slice(2);
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;
const NO_VWAP = args.includes('--no-vwap'); // A/B: drop the buyer-structure gate

function dayGroups(candles) {
  const days = new Map();
  for (const c of candles) {
    const d = String(c[0]).slice(0, 10); // 'YYYY-MM-DD HH:MM' raw stamp
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(c);
  }
  return [...days.values()];
}

function backtestDay(bars) {
  if (bars.length < 20) return []; // NSE 15-min day = 25 bars; some days truncated
  const trades = [];
  let pv = 0, vv = 0;
  const runningVwap = [];
  for (let i = 0; i < bars.length; i++) {
    const [t, o, h, l, c, v] = bars[i];
    pv += c * v; vv += v;
    runningVwap.push(vv > 0 ? pv / vv : c);
  }
  let inTrade = false, entry = 0, stop = 0, t1 = 0, t2 = 0, entryIdx = 0;
  const vols = bars.map(b => b[5]);
  for (let i = 16; i < bars.length - 1; i++) { // need i-15 for roc15
    const c = bars[i][4], v = bars[i][5];
    if (!inTrade) {
      // indicators as-of bar i
      const roc5 = ((c - bars[i - 5][4]) / bars[i - 5][4]) * 100;
      const roc15 = ((c - bars[i - 15][4]) / bars[i - 15][4]) * 100;
      const v5 = (vols.slice(i - 4, i + 1).reduce((s, x) => s + x, 0)) / 5;
      const vDay = (vols.slice(0, i + 1).reduce((s, x) => s + x, 0)) / (i + 1);
      const volX = vDay > 0 ? v5 / vDay : 1;
      const aboveVwap = NO_VWAP || c > runningVwap[i];
      if (roc5 > ROC5_TH && roc15 > 0 && volX >= VOLX_TH && aboveVwap) {
        inTrade = true; entry = c; entryIdx = i;
        stop = c * (1 - STOP_PCT / 100);
        t1 = c * (1 + T1_PCT / 100);
        t2 = c * (1 + T2_PCT / 100);
      }
    } else {
      const [, o2, h2, l2, c2] = bars[i];
      let exit = null, reason = null;
      // conservative: stop checked before targets within the bar
      if (l2 <= stop) { exit = stop; reason = 'SL'; }
      else if (h2 >= t2) { exit = t2; reason = 'T2'; }
      else if (h2 >= t1) { exit = t1; reason = 'T1'; }
      if (!exit && i === bars.length - 2) { exit = c2; reason = 'EOD'; }
      if (exit) {
        const grossPct = ((exit - entry) / entry) * 100;
        trades.push({ symbol: '', date: String(bars[entryIdx][0]).slice(0, 10),
          entry, exit, grossPct: +grossPct.toFixed(2), netPct: +(grossPct - COST_PCT).toFixed(2),
          reason, bars: i - entryIdx });
        inTrade = false;
      }
    }
  }
  return trades;
}

function main() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')).slice(0, LIMIT);
  let all = [];
  let symCount = 0;
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!Array.isArray(j.candles) || j.candles.length < 400) continue;
      symCount++;
      const sym = f.replace('.json', '');
      for (const day of dayGroups(j.candles)) if (day.length >= 20) all.push(...backtestDay(day).map(t => ({ ...t, symbol: sym })));
    } catch (_) {}
  }
  const n = all.length;
  const wins = all.filter(t => t.netPct > 0);
  const avg = a => a.length ? +(a.reduce((s, t) => s + t.netPct, 0) / a.length).toFixed(3) : 0;
  const gp = all.reduce((s, t) => s + Math.max(0, t.netPct), 0);
  const gl = Math.abs(all.reduce((s, t) => s + Math.min(0, t.netPct), 0));
  const byReason = {};
  for (const t of all) { (byReason[t.reason] = byReason[t.reason] || []).push(t); }
  console.log('=== INTRADAY ROC+VWAP BACKTEST (15-min bars, 6 months) ===');
  console.log(`symbols: ${symCount} | signals/trades: ${n}`);
  console.log(`win rate: ${(100 * wins.length / n).toFixed(1)}% | avg net: ${avg(all)}% | median net: ${all.map(t => t.netPct).sort((a, b) => a - b)[Math.floor(n / 2)]}%`);
  console.log(`profit factor: ${gl > 0 ? (gp / gl).toFixed(2) : 'inf'} | total net: ${all.reduce((s, t) => s + t.netPct, 0).toFixed(0)}% (summed, unweighted)`);
  for (const [r, ts] of Object.entries(byReason)) {
    console.log(`  ${r}: n=${ts.length} win=${(100 * ts.filter(t => t.netPct > 0).length / ts.length).toFixed(1)}% avg=${avg(ts)}%`);
  }
  // per-month stability
  const byMonth = {};
  for (const t of all) { const m = t.date.slice(0, 7); (byMonth[m] = byMonth[m] || []).push(t); }
  console.log('per-month avg net %:', Object.entries(byMonth).sort().map(([m, ts]) => `${m}:${avg(ts)}`).join('  '));
  console.log('best 5:', all.sort((a, b) => b.netPct - a.netPct).slice(0, 5).map(t => `${t.symbol} +${t.netPct}%`).join(', '));
  console.log('worst 5:', all.slice(-5).map(t => `${t.symbol} ${t.netPct}%`).join(', '));
}

main();
