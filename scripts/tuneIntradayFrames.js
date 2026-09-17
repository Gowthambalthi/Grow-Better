/**
 * scripts/tuneIntradayFrames.js — measure the intraday frames (F6 close
 * quality, F7 next-day hold) on the daily Breakout-engine signals, using
 * data/ohlcv_15m. Only signals whose breakout/entry dates are covered by
 * the 15-min window (~last 6 months) can be scored.
 *
 * For every 3y signal:
 *   - F6: 15-min bars of the breakout day → frameIntradayClose
 *   - F7: 15-min bars of the day AFTER breakout → frameIntradayHold(level, ATR)
 * Then slice net-R (baseline config) by each frame's pass/fail, plus the
 * combined gate f5+f2+f3+F6 and f5+f2+f3+F6+F7.
 */
const fs = require('fs');
const path = require('path');
const { detectBreakoutSignals } = require('../common/market/breakoutEntry');
const { frameIntradayClose, frameIntradayHold, atrAt, scoreFrames } = require('../common/market/confirmFrames');

const OHLCV_3Y = path.join(__dirname, '..', 'data', 'ohlcv_3y');
const OHLCV_15M = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const FILTERED_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const COST_R_BPS = 12;

function dateOf(ts) { return ts.slice(0, 10); }
function barsForDate(candles, date) { return candles.filter(c => c[0].slice(0, 10) === date); }
function nextDate(d) { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }

function simBaseline(candles, sig) {
  const entryBar = sig.entry_bar;
  const entry = sig.entry, risk = entry - sig.stop;
  if (!(risk > 0) || entryBar == null) return null;
  const riskPct = risk / entry;
  const costR = (COST_R_BPS / 10000) / riskPct;
  const end = Math.min(candles.length - 1, entryBar + 35);
  for (let k = entryBar + 1; k <= end; k++) {
    const hi = candles[k][2], lo = candles[k][3];
    if (lo <= sig.stop) return { r: -1 - costR, outcome: 'SL' };
    if (hi >= sig.target) return { r: 2 - costR, outcome: 'TGT' };
  }
  const lastC = candles[end][4];
  return { r: (lastC - entry) / risk - costR, outcome: 'TIME' };
}

function summarize(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(t => t.r > 0).length;
  const gW = rows.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gL = Math.abs(rows.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  const sorted = rows.map(t => t.r).sort((a, b) => a - b);
  const top = sorted.slice(-Math.ceil(n * 0.1));
  return {
    n, winRate: +(wins / n * 100).toFixed(1),
    avgR: +(rows.reduce((s, t) => s + t.r, 0) / n).toFixed(3),
    PF: gL > 0 ? +(gW / gL).toFixed(2) : null,
    top10Share: +(100 * top.reduce((a, b) => a + b, 0) / sorted.reduce((a, b) => a + b, 0)).toFixed(0),
    exTop: +((sorted.reduce((a, b) => a + b, 0) - top.reduce((a, b) => a + b, 0)) / (n - top.length)).toFixed(3),
  };
}

function main() {
  const filtered = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8'));
  const symbols = filtered.stocks.map(s => s.symbol);
  const rows = [];
  let scored = 0, no15m = 0;

  for (const sym of symbols) {
    let daily, intraday;
    try { daily = JSON.parse(fs.readFileSync(path.join(OHLCV_3Y, sym + '.json'), 'utf8')).candles; } catch (_) { continue; }
    try { intraday = JSON.parse(fs.readFileSync(path.join(OHLCV_15M, sym + '.json'), 'utf8')).candles; } catch (_) { intraday = null; }
    if (!daily || daily.length < 210) continue;
    if (!intraday || intraday.length < 100) { no15m++; continue; }

    const intradayDates = new Set(intraday.map(c => dateOf(c[0])));
    let r;
    try { r = detectBreakoutSignals(daily, null, { retestEntry: true }); } catch (_) { continue; }

    for (const sig of r.signals) {
      const bDate = daily[sig.breakout_bar][0];
      if (!intradayDates.has(bDate)) continue; // outside 15m coverage
      const sim = simBaseline(daily, sig);
      if (!sim) continue;
      scored++;

      // F6 — breakout day intraday close
      const f6 = frameIntradayClose(barsForDate(intraday, bDate));

      // F7 — next day hold of the breakout level
      const nDate = nextDate(bDate);
      const nBars = barsForDate(intraday, nDate);
      const atr = atrAt(daily, sig.breakout_bar);
      const f7 = frameIntradayHold(nBars, sig.level, atr || 0);

      rows.push({
        symbol: sym, breakout_date: bDate, entry_type: sig.entry_type, ...sim,
        f6: f6.pass, f6_closePos: f6.closePos,
        f7: f7.pass, f7_dips: f7.dips, f7_deepest: f7.deepest,
      });
    }
  }

  console.log(`Signals with 15m coverage: ${rows.length} (${no15m} symbols had no 15m data)\n`);
  if (!rows.length) { console.log('No overlap between signals and 15m data yet.'); return; }

  console.log('=== INTRADAY FRAME MARGINAL CONTRIBUTION (net R) ===');
  for (const f of ['f6', 'f7']) {
    const pass = rows.filter(t => t[f] === true);
    const fail = rows.filter(t => t[f] === false);
    const fmt = a => a.length ? `n=${String(a.length).padStart(3)} win=${summarize(a).winRate}% avgR=${summarize(a).avgR}` : 'n=  0';
    console.log(`${f}  PASS ${fmt(pass)}  | FAIL ${fmt(fail)}`);
  }

  // combined with the existing confirmed gate
  const out = { generatedAt: new Date().toISOString(), rows };
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'intraday_frames_tuning.json'), JSON.stringify(out));
  console.log('\nOutput: data/intraday_frames_tuning.json');
}

main();
