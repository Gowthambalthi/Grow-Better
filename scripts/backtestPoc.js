/**
 * scripts/backtestPoc.js — backtest of the POC / order-flow strategy on 15m bars.
 *
 * Signals (evaluated at the close of bar i using ONLY bars up to i; entry = next bar open):
 *   LONG  poc_reject : prior bar dipped to POC and closed back above it, positive delta,
 *                      session flowBias not heavily negative
 *   LONG  va_break   : close crosses above the Value Area high with volume >= 1.2x day avg
 *                      and positive delta
 *   SHORT: mirrored (va_breakdown below valueLow, negative delta)
 *
 * Exit: stop below the signal bar's low (or above high for shorts), target 1.5R,
 *       EOD flat at the 15:00 bar. Cost model: 12 bps round trip, converted to R.
 *
 * Usage: node scripts/backtestPoc.js [--limit=N] [--targetR=1.5]
 */
const fs = require('fs');
const path = require('path');
const { buildProfile, groupBySession } = require('../common/market/pocEngine');

const DIR = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const COST_BPS = 12;
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const LIMIT = args.limit ? parseInt(args.limit, 10) : 0;
const TARGET_R = args.targetR ? parseFloat(args.targetR) : 1.5;
const SIDE = args.side || 'both';
const MTF = !!args.mtf; // higher-timeframe delta must agree (1h store)
const h1Cache = new Map();
function h1Deltas(sym) {
  if (h1Cache.has(sym)) return h1Cache.get(sym);
  const m = new Map(); // date -> delta of last completed 1h bar that day
  try {
    const cs = JSON.parse(fs.readFileSync(path.join(DIR.replace('ohlcv_15m', 'ohlcv_1h'), sym + '.json'), 'utf8')).candles;
    for (const row of cs) {
      const d = row[0].slice(0, 10);
      const mins = parseInt(row[0].slice(11, 13), 10) * 60 + parseInt(row[0].slice(14, 16), 10);
      if (mins < 555 || mins > 930) continue;
      const [, o, h, l, c, v] = row;
      m.set(d, { delta: v > 0 && h > l ? v * (2 * (c - l) / (h - l) - 1) : 0 });
    }
  } catch (_) {}
  h1Cache.set(sym, m);
  return m;
}

function run() {
  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  const use = LIMIT ? files.slice(0, LIMIT) : files;
  const trades = [];

  for (const f of use) {
    let candles;
    try { candles = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).candles; } catch (_) { continue; }
    if (!candles || candles.length < 100) continue;
    const sym = f.replace('.json', '');

    for (const [date, bars] of groupBySession(candles)) {
      if (bars.length < 8) continue;
      const dayAvgVol = bars.reduce((s, b) => s + b[5], 0) / bars.length;

      for (let i = 4; i < bars.length - 2; i++) {
        const prior = bars.slice(0, i + 1);          // info up to and incl bar i
        const prof = buildProfile(prior);
        if (!prof.poc) continue;
        const b = bars[i];
        const [, o, h, l, c, v] = b;
        if (!(v > 0)) continue;
        const range = h - l;
        const cp = range > 0 ? (c - l) / range : 0.5;
        const delta = v * (2 * cp - 1);              // this bar's directional read
        const prev = bars[i - 1];
        const pClose = prev[4];

        let side = null, kind = null, stop = null;
        if (prev[2] <= prof.poc && c > prof.poc && delta > 0 && prof.flowBias > -0.15 && c > o) {
          side = 'LONG'; kind = 'poc_reject'; stop = Math.min(l, prof.poc) * 0.999;
        } else if (pClose <= prof.valueHigh && c > prof.valueHigh && v >= 1.2 * dayAvgVol && delta > 0) {
          side = 'LONG'; kind = 'va_break'; stop = Math.min(l, prof.valueHigh) * 0.999;
        } else if (prev[3] >= prof.poc && c < prof.poc && delta < 0 && prof.flowBias < 0.15 && c < o) {
          side = 'SHORT'; kind = 'poc_reject'; stop = Math.max(h, prof.poc) * 1.001;
        } else if (pClose >= prof.valueLow && c < prof.valueLow && v >= 1.2 * dayAvgVol && delta < 0) {
          side = 'SHORT'; kind = 'va_breakdown'; stop = Math.max(h, prof.valueLow) * 1.001;
        }
        if (!side) continue;
        if (SIDE !== 'both' && side !== SIDE.toUpperCase()) continue;
        if (args.tightflow) { // strict order-flow agreement: session delta must tilt the trade's way
          if (side === 'SHORT' && prof.flowBias > -0.05) continue;
          if (side === 'LONG' && prof.flowBias < 0.05) continue;
        }
        if (MTF) { // higher-timeframe (1h) delta must agree with the trade
          const hd = h1Deltas(sym).get(date);
          if (hd == null) continue;
          if (side === 'SHORT' && hd.delta >= 0) continue;
          if (side === 'LONG' && hd.delta <= 0) continue;
        }
        // Candle-structure confirmation: last 3 bars must show higher-lows (long)
        // or lower-highs (short) — mirrors the tick-candle gate in the live board.
        if (args.candles) {
          const lows = [bars[i-2][3], bars[i-1][3], l];
          const highs = [bars[i-2][2], bars[i-1][2], h];
          if (side === 'LONG' && !(lows[1] > lows[0] && lows[2] >= lows[1])) continue;
          if (side === 'SHORT' && !(highs[1] < highs[0] && highs[2] <= highs[1])) continue;
        }
        // Big-buyer gate: the signal bar's |delta| must be outsized vs recent bars —
        // large directional participation, not drift. Mirrors the bigBuyer/bigSeller jump.
        if (args.bigbuyer) {
          const recent = bars.slice(Math.max(0, i - 8), i).map(b2 => {
            const [, o2, h2, l2, , v2] = b2; const r2 = h2 - l2;
            return v2 > 0 && r2 > 0 ? v2 * Math.abs(2 * ((b2[4] - l2) / r2) - 1) : 0;
          });
          const avgRecent = recent.reduce((s, x) => s + x, 0) / Math.max(1, recent.length);
          if (Math.abs(delta) < 1.5 * Math.max(avgRecent, 1)) continue;
        }

        const entry = bars[i + 1][1]; // next bar open
        const stopPct = Math.abs(entry - stop) / entry;
        if (stopPct < 0.002 || stopPct > 0.03) continue; // sane stops only
        const target = side === 'LONG' ? entry + TARGET_R * (entry - stop) : entry - TARGET_R * (stop - entry);
        const costR = (COST_BPS / 10000) / stopPct;

        // walk forward to exit
        let exitR = null, exitWhy = null;
        for (let j = i + 1; j < bars.length; j++) {
          const [, , bh, bl, , bv] = bars[j];
          if (j > i + 1 && bv === 0) continue;
          if (side === 'LONG') {
            if (bl <= stop) { exitR = (stop - entry) / (entry - stop); exitWhy = 'SL'; break; }
            if (bh >= target) { exitR = TARGET_R; exitWhy = 'TGT'; break; }
          } else {
            if (bh >= stop) { exitR = (entry - stop) / (stop - entry); exitWhy = 'SL'; break; }
            if (bl <= target) { exitR = TARGET_R; exitWhy = 'TGT'; break; }
          }
        }
        if (exitR === null) { // EOD flat at last bar close
          const lastC = bars[bars.length - 1][4];
          exitR = (side === 'LONG' ? lastC - entry : entry - lastC) / (side === 'LONG' ? entry - stop : stop - entry);
          exitWhy = 'EOD';
        }
        trades.push({ sym, date, time: b[0].slice(11), side, kind, stopPct, grossR: exitR, netR: exitR - costR, exitWhy });
      }
    }
  }

  const fmt = t => {
    const n = t.length, w = t.filter(x => x.grossR > 0).length;
    const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    const wins = t.filter(x => x.grossR > 0);
    const losses = t.filter(x => x.grossR <= 0);
    const pf = Math.abs(avg(wins.map(x => x.grossR)) * wins.length / (avg(losses.map(x => x.grossR)) * losses.length || 1));
    return `n=${n} win=${(100 * w / n).toFixed(1)}% gross=${avg(t.map(x => x.grossR)).toFixed(3)}R net=${avg(t.map(x => x.netR)).toFixed(3)}R PF=${pf.toFixed(2)}`;
  };
  const by = (key, fn) => {
    const m = {};
    for (const t of trades) { const k = fn(t); (m[k] = m[k] || []).push(t); }
    for (const k of Object.keys(m)) console.log(`  ${key} ${k}: ${fmt(m[k])}`);
  };

  console.log(`POC strategy backtest — ${use.length} symbols, target ${TARGET_R}R, cost ${COST_BPS}bps`);
  if (!trades.length) { console.log('no trades'); return; }
  console.log(`ALL: ${fmt(trades)}`);
  by('side', t => t.side);
  by('kind', t => t.kind);
  const top = [...trades].sort((a, b) => b.netR - a.netR).slice(0, 10);
  console.log('top-10 net R share of profit: ' + (100 * top.reduce((s, t) => s + Math.max(0, t.netR), 0) / trades.filter(t => t.netR > 0).reduce((s, t) => s + t.netR, 0)).toFixed(0) + '%');
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'backtest_poc.json'), JSON.stringify({ generatedAt: new Date().toISOString(), targetR: TARGET_R, costBps: COST_BPS, nTrades: trades.length, trades }, null, 1));
}

run();
