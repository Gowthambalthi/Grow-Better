/**
 * scripts/backtestBreakout.js — walk-forward backtest for the breakout
 * validator (Steps 7–8 of the build plan).
 *
 * No look-ahead: at every bar t, validateBreakout sees ONLY candles up to t.
 * Trade simulation:
 *   entry  = next bar open (realistic; no mid-candle fills)
 *   stop   = min(support30, entry − ATR14) for longs (mirror for shorts/fades)
 *   target = entry + 2 × risk (target2-style 2R)
 *   exit   = stop / target hit first (intrabar, high/low), else 35-bar time exit
 *   breakeven stop move once trade reaches +1R
 *
 * Usage:
 *   node scripts/backtestBreakout.js RELIANCE SBIN CIPLA   # specific stocks
 *   node scripts/backtestBreakout.js --limit 3             # first 3 filtered
 */
const fs = require('fs');
const path = require('path');
const { scanBreakout, validateBreakoutIndependent } = require('../common/market/breakoutValidate');

// Nifty proxy for RS checks: largest-liquidity ETF in the filtered universe
let NIFTY_CANDLES = null;
function loadNiftyProxy() {
  if (NIFTY_CANDLES) return NIFTY_CANDLES;
  for (const cand of ['NIFTYBEES', 'SETFNIF50', 'NIFTYIETF']) {
    try {
      NIFTY_CANDLES = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, cand + '.json'), 'utf8')).candles;
      console.log(`Nifty proxy: ${cand}`);
      return NIFTY_CANDLES;
    } catch (_) { /* try next */ }
  }
  console.log('Nifty proxy: none found (RS check will not block)');
  return null;
}

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const FILTERED_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'breakout_validator_backtest.json');

const CFG = {
  lookback: 20,
  warmup: 30,          // bars before signals start
  maxHold: 35,         // overridden by --hold N
  targetR: 2.0,
  breakevenR: 1.0,
  cooldownBars: 5,
  maxPerStock: Infinity, // backtest sample size: uncapped. Reintroduce a cap
                          // for LIVE risk management only, not backtests.
  independentChecks: false, // --ind: redesigned non-correlated check set
  rsMin: 0.02,               // RS check: require 2% outperformance vs benchmark
  // -- NET-R cost model: all reported R is net of round-trip costs.
  // costR = round-trip cost as a fraction of the trade's 1R unit, computed
  // per trade from its entry price: (costBpsEntry + costBpsExit) / risk%.
  // 12 bps round trip = brokerage+STT+exchange fees+slippage, typical NSE
  // delivery intraday-ish assumption. Applied on entry+exit in simulate().
  costBpsRoundTrip: 12,
};

function atrAt(candles, i, period = 14) {
  if (i < period + 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const h = candles[k][2], l = candles[k][3], pc = candles[k - 1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / period;
}

function simulate(candles, entryBar, direction, entry) {
  const atr = atrAt(candles, entryBar - 1);
  if (!atr || atr <= 0) return null;
  // support/resistance over 30 bars before entry
  let sup = Infinity, res = -Infinity;
  for (let i = Math.max(0, entryBar - 31); i < entryBar; i++) {
    sup = Math.min(sup, candles[i][3]);
    res = Math.max(res, candles[i][2]);
  }
  const isLong = direction === 'LONG';
  const stop = isLong
    ? Math.min(sup, entry - atr)
    : Math.max(res, entry + atr);
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const target = isLong ? entry + CFG.targetR * risk : entry - CFG.targetR * risk;

  // Net-R cost model: round-trip cost expressed in R units. Cost scales with
  // price, R scales with risk — a tight stop makes the SAME ₹-cost a bigger
  // R-drag, which is exactly the effect a net-R backtest must capture.
  const riskPct = risk / entry;
  const costR = riskPct > 0 ? (CFG.costBpsRoundTrip / 10000) / riskPct : 0;

  const rUnit = risk;
  const signedR = (exitPrice, label) => {
    const gross = (isLong ? exitPrice - entry : entry - exitPrice) / rUnit;
    return { gross, net: gross - costR };
  };
  let stopLevel = stop, beArmed = false;
  const end = Math.min(candles.length - 1, entryBar + CFG.maxHold);
  for (let i = entryBar + 1; i <= end; i++) {
    const [, o, h, l, c] = candles[i];
    // breakeven arm at +1R
    const fav = isLong ? h - entry : entry - l;
    if (!beArmed && fav >= CFG.breakevenR * risk) {
      stopLevel = entry;
      beArmed = true;
    }
    // stop check (conservative: stop before target within the same bar)
    const hitStop = isLong ? l <= stopLevel : h >= stopLevel;
    const hitTgt = isLong ? h >= target : l <= target;
    if (hitStop) {
      const { gross, net } = signedR(stopLevel, 'stop');
      return { exitDate: candles[i][0], exit: stopLevel, outcome: beArmed ? 'BE' : 'SL', r: +net.toFixed(3), grossR: +gross.toFixed(3), costR: +costR.toFixed(3), bars: i - entryBar, beArmed };
    }
    if (hitTgt) {
      const { gross, net } = signedR(target, 'tgt');
      return { exitDate: candles[i][0], exit: target, outcome: 'TGT', r: +(CFG.targetR - costR).toFixed(3), grossR: CFG.targetR, costR: +costR.toFixed(3), bars: i - entryBar, beArmed };
    }
  }
  const lastC = candles[end][4];
  const { gross, net } = signedR(lastC, 'time');
  return { exitDate: candles[end][0], exit: lastC, outcome: 'TIME', r: +net.toFixed(3), grossR: +gross.toFixed(3), costR: +costR.toFixed(3), bars: end - entryBar, beArmed };
}

function backtestStock(symbol, candles, verdicts) {
  const trades = [];
  let lastSignalBar = -Infinity;
  for (let t = CFG.warmup; t < candles.length - 1; t++) {
    if (t - lastSignalBar < CFG.cooldownBars) continue;
    const slice = candles.slice(0, t + 1); // as-of: no look-ahead
    let r;
    if (CFG.independentChecks) {
      r = validateBreakoutIndependent(slice, ...(() => {
        const d = require('../common/market/breakoutValidate').detectBreakout(slice, CFG.lookback);
        return [d.direction, d.level];
      })(), { niftyCandles: NIFTY_CANDLES ? NIFTY_CANDLES.slice(0, t + 1) : null, lookback: CFG.lookback, rsMin: CFG.rsMin });
      if (!r.direction) { lastSignalBar = t; continue; }
    } else {
      r = scanBreakout(slice, { lookback: CFG.lookback });
    }
    if (!['REAL', 'FAKE'].includes(r.verdict)) continue;

    const tradeDir = r.verdict === 'REAL'
      ? (r.direction === 'BULLISH_BREAKOUT' ? 'LONG' : 'SHORT')
      : r.fadeDirection;
    const entry = candles[t + 1][1]; // next bar open
    const sim = simulate(candles, t + 1, tradeDir, entry);
    lastSignalBar = t;
    if (!sim) continue;
    trades.push({
      symbol, verdict: r.verdict, engine: tradeDir, direction: r.direction,
      signalDate: candles[t][0], entryDate: candles[t + 1][0], entry,
      breakoutLevel: r.breakoutLevel, score: `${r.score}/${r.total}`,
      outcome: sim.outcome, r: +sim.r.toFixed(3), bars: sim.bars, beArmed: sim.beArmed,
      exitDate: sim.exitDate, exit: +sim.exit.toFixed(2),
      checks: Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v ? v.ok : null])),
    });
    if (trades.length >= CFG.maxPerStock) break;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0 };
  const wins = trades.filter(t => t.r > 0.05).length;
  const losses = trades.filter(t => t.r < -0.05).length;
  const avgR = trades.reduce((s, t) => s + t.r, 0) / trades.length;
  const grossW = trades.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const grossL = Math.abs(trades.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  return {
    n: trades.length,
    wins, losses,
    winRate: +(wins / trades.length * 100).toFixed(1),
    avgR: +avgR.toFixed(3),
    totalR: +trades.reduce((s, t) => s + t.r, 0).toFixed(2),
    profitFactor: grossL > 0 ? +(grossW / grossL).toFixed(2) : null,
    avgBars: +(trades.reduce((s, t) => s + t.bars, 0) / trades.length).toFixed(1),
    byOutcome: trades.reduce((m, t) => (m[t.outcome] = (m[t.outcome] || 0) + 1, m), {}),
    byVerdict: trades.reduce((m, t) => (m[t.verdict] = (m[t.verdict] || 0) + 1, m), {}),
  };
}

function main() {
  const args = process.argv.slice(2);
  // flags: --hold N (bars), --ind (independent check set), --limit N, symbols...
  let symbols = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { const f = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8')); symbols = f.stocks.slice(0, parseInt(args[++i], 10)).map(s => s.symbol); }
    else if (args[i] === '--hold') CFG.maxHold = parseInt(args[++i], 10);
    else if (args[i] === '--ind') CFG.independentChecks = true;
    else if (args[i] === '--rsmin') CFG.rsMin = parseFloat(args[++i]);
    else symbols.push(args[i]);
  }
  if (!symbols.length) { const f = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8')); symbols = f.stocks.slice(0, 3).map(s => s.symbol); }

  const all = [];
  const t0 = Date.now();
  if (CFG.independentChecks) loadNiftyProxy();
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const f = path.join(OHLCV_DIR, sym + '.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    all.push(...backtestStock(sym, j.candles, CFG));
    if (i % 100 === 0) console.log(`[${i + 1}/${symbols.length}] ${sym} — total trades: ${all.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  const out = { generatedAt: new Date().toISOString(), config: CFG, symbols, summary: summarize(all), trades: all };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log('\nSummary:', JSON.stringify(out.summary, null, 2));
  console.log(`Output: ${OUT_FILE}`);
}

main();
