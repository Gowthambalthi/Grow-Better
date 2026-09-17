/**
 * scripts/backtestBreakout1h.js — intraday (1h) backtest of the breakout
 * validator, 3-CHECK ISOLATION run (per sequencing decision):
 *
 *   Score over: htf_trend + breakout_quality + relative_strength ONLY.
 *   volume_roc and atr_extension are EXCLUDED this run — they re-enter one
 *   at a time afterward with marginal-contribution measurement. This way a
 *   mediocre result indicts the daily-proven checks, not untested thresholds.
 *
 * Trade simulation (hourly):
 *   entry  = next bar open
 *   stop   = recent swing low − 0.3×ATR (entry-timeframe, tighter than daily)
 *   target = 2R
 *   exit   = stop/target first, else maxHold hours (default 8 = 1 session)
 *   breakeven stop at +1R
 *   NET-R: 8 bps round-trip (intraday: lower STT, higher slippage sensitivity)
 *
 * Usage: node scripts/backtestBreakout1h.js --limit=N | symbols...
 */
const fs = require('fs');
const path = require('path');
const {
  detectBreakout, checkBreakoutQuality, checkHtfTrend, checkRelativeStrength,
} = require('../common/market/breakoutValidate');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv_1h');
const FILTERED_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'breakout_validator_1h_backtest.json');

const CFG = {
  lookback: 20,        // bars = hours; 20h ≈ 2.5 sessions
  warmup: 26,          // ~1 week of hourly bars
  maxHold: 8,          // one trading session (6.25h) + buffer
  targetR: 2.0,
  breakevenR: 1.0,
  cooldownBars: 3,
  costBpsRoundTrip: 8, // intraday net-R
  minAtrPct: 0.15,     // skip dead-hour bars (ATR floor in % of close)
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

// entry-timeframe stop: lowest low of last 10 bars − 0.3×ATR
function stopFor(candles, entryBar, entry) {
  const atr = atrAt(candles, entryBar - 1);
  if (!atr || atr <= 0) return null;
  let sup = Infinity;
  for (let i = Math.max(0, entryBar - 11); i < entryBar; i++) sup = Math.min(sup, candles[i][3]);
  return { stop: sup - 0.3 * atr, atr };
}

function simulate(candles, entryBar, direction, entry) {
  const st = stopFor(candles, entryBar, entry);
  if (!st) return null;
  const isLong = direction === 'LONG';
  const stop = isLong ? st.stop : entry + (entry - st.stop);
  const risk = Math.abs(entry - stop);
  if (risk <= 0 || risk / entry < CFG.minAtrPct / 10) return null; // degenerate risk
  const target = isLong ? entry + CFG.targetR * risk : entry - CFG.targetR * risk;
  const riskPct = risk / entry;
  const costR = (CFG.costBpsRoundTrip / 10000) / riskPct;

  let stopLevel = stop, beArmed = false;
  const end = Math.min(candles.length - 1, entryBar + CFG.maxHold);
  for (let i = entryBar + 1; i <= end; i++) {
    const [, , h, l] = candles[i];
    const fav = isLong ? h - entry : entry - l;
    if (!beArmed && fav >= CFG.breakevenR * risk) { stopLevel = entry; beArmed = true; }
    const hitStop = isLong ? l <= stopLevel : h >= stopLevel;
    const hitTgt = isLong ? h >= target : l <= target;
    if (hitStop) {
      const gross = (isLong ? stopLevel - entry : entry - stopLevel) / risk;
      return { exit: candles[i][0], outcome: beArmed ? 'BE' : 'SL', r: +(gross - costR).toFixed(3), grossR: +gross.toFixed(3), costR: +costR.toFixed(3), bars: i - entryBar, beArmed };
    }
    if (hitTgt) {
      return { exit: candles[i][0], outcome: 'TGT', r: +(CFG.targetR - costR).toFixed(3), grossR: CFG.targetR, costR: +costR.toFixed(3), bars: i - entryBar, beArmed };
    }
  }
  const lastC = candles[end][4];
  const gross = (isLong ? lastC - entry : entry - lastC) / risk;
  return { exit: candles[end][0], outcome: 'TIME', r: +(gross - costR).toFixed(3), grossR: +gross.toFixed(3), costR: +costR.toFixed(3), bars: end - entryBar, beArmed };
}

/** 3-check scorer (isolation): trend, quality, RS. HTF trend comes from
 *  DAILY candles (proper MTF): 40 days of hourly resamples to only ~5 weekly
 *  bars — below the check's 10-week minimum, so it must take the daily series
 *  (247 bars ≈ 50 weeks), aligned by date (all daily bars ≤ signal date). */
function validate3(candles, direction, level, nifty, dailyCandles) {
  const tDate = candles[candles.length - 1][0].slice(0, 10);
  const dailyAsOf = dailyCandles ? dailyCandles.filter(c => c[0] <= tDate) : null;
  const checks = {
    htf_trend: checkHtfTrend(dailyAsOf && dailyAsOf.length >= 60 ? dailyAsOf : null || []),
    breakout_quality: checkBreakoutQuality(candles, level, direction),
    relative_strength: checkRelativeStrength(candles, nifty, 15),
  };
  const active = Object.values(checks).filter(v => v && v.ok != null);
  const score = active.filter(v => v.ok).length;
  const total = active.length;
  // isolation thresholds: ≥2/3 REAL, ≤1/3 FAKE
  const verdict = score >= Math.ceil(total * 0.66) ? 'REAL' : score <= 1 ? 'FAKE' : 'UNCLEAR';
  return { verdict, score, total, checks, direction, level };
}

function backtestStock(symbol, candles, nifty, dailyCandles) {
  const trades = [];
  let lastSignalBar = -Infinity;
  for (let t = CFG.warmup; t < candles.length - 1; t++) {
    if (t - lastSignalBar < CFG.cooldownBars) continue;
    const slice = candles.slice(0, t + 1);
    const { direction, level } = detectBreakout(slice, CFG.lookback);
    if (!direction) continue;
    const v = validate3(slice, direction, level, nifty ? nifty.slice(0, t + 1) : null, dailyCandles);
    if (v.verdict !== 'REAL') continue; // isolation run: REAL only
    const tradeDir = direction === 'BULLISH_BREAKOUT' ? 'LONG' : 'SHORT';
    const entry = candles[t + 1][1];
    const sim = simulate(candles, t + 1, tradeDir, entry);
    lastSignalBar = t;
    if (!sim) continue;
    trades.push({
      symbol, score: `${v.score}/${v.total}`,
      signalDate: candles[t][0], entryDate: candles[t + 1][0], entry,
      direction: tradeDir, breakoutLevel: level,
      outcome: sim.outcome, r: sim.r, grossR: sim.grossR, costR: sim.costR,
      bars: sim.bars, beArmed: sim.beArmed,
      checks: Object.fromEntries(Object.entries(v.checks).map(([k, x]) => [k, x ? x.ok : null])),
    });
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0 };
  const wins = trades.filter(t => t.r > 0).length;
  const avgR = trades.reduce((s, t) => s + t.r, 0) / trades.length;
  const gW = trades.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gL = Math.abs(trades.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  return {
    n: trades.length,
    winRate: +(wins / trades.length * 100).toFixed(1),
    avgR: +avgR.toFixed(3),
    totalR: +trades.reduce((s, t) => s + t.r, 0).toFixed(1),
    profitFactor: gL > 0 ? +(gW / gL).toFixed(2) : null,
    avgBars: +(trades.reduce((s, t) => s + t.bars, 0) / trades.length).toFixed(1),
    byOutcome: trades.reduce((m, t) => (m[t.outcome] = (m[t.outcome] || 0) + 1, m), {}),
  };
}

function main() {
  const args = process.argv.slice(2);
  let symbols = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') { const f = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8')); symbols = f.stocks.slice(0, parseInt(args[++i], 10)).map(s => s.symbol); }
    else symbols.push(args[i]);
  }
  if (!symbols.length) { const f = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8')); symbols = f.stocks.map(s => s.symbol); }

  let nifty = null;
  try { nifty = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, 'SETFNIF50.json'), 'utf8')).candles; console.log('Nifty proxy loaded:', nifty.length, 'bars'); } catch (_) { console.log('no proxy — RS passes vacuously'); }
  const DAILY_DIR = path.join(__dirname, '..', 'data', 'ohlcv');

  const all = [];
  const t0 = Date.now();
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    if (sym === 'SETFNIF50') continue;
    let j, dj;
    try { j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8')); } catch (_) { continue; }
    try { dj = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, sym + '.json'), 'utf8')).candles; } catch (_) { dj = null; }
    all.push(...backtestStock(sym, j.candles, nifty, dj));
    if (i % 100 === 0) console.log(`[${i + 1}/${symbols.length}] trades: ${all.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const out = { generatedAt: new Date().toISOString(), config: CFG, checks: ['htf_trend', 'breakout_quality', 'relative_strength'], summary: summarize(all), trades: all };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log('\nSummary (3-check isolation, net-R):', JSON.stringify(out.summary, null, 1));
  console.log(`Output: ${OUT_FILE}`);
}

main();
