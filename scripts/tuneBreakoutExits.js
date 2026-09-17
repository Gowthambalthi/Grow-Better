/**
 * scripts/tuneBreakoutExits.js — apply the MTF exit-tuning toolkit to the
 * Breakout engine: re-detect the 85 signals, then re-simulate each under
 * multiple exit configurations with NET-R costs (12 bps round trip):
 *
 *   A. baseline   : fixed stop / 2R target / 35-bar horizon  (current)
 *   B. BE@1R      : move stop to entry at +1R
 *   C. B + target 1.5R
 *   D. B + target 1.2R
 *   E. B + 1×ATR trail after +1R (trail replaces fixed target)
 *
 * Also: per-entry-type (retest vs breakout) split under the best config,
 * and tail-dependence (top-10% R share) per config.
 *
 * Usage: node scripts/tuneBreakoutExits.js
 */
const fs = require('fs');
const path = require('path');
const { detectBreakoutSignals } = require('../common/market/breakoutEntry');
const { scoreFrames } = require('../common/market/confirmFrames');

const OHLCV_DIR = process.env.OHLCV_DIR || path.join(__dirname, '..', 'data', 'ohlcv');
const FILTERED_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_FILE = path.join(__dirname, '..', 'data', 'breakout_exit_tuning.json');

const COST_R_BPS = 12; // net-R round trip, same as daily validator harness

function atrAt(candles, i, period = 14) {
  if (i < period + 1) return null;
  let s = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const h = candles[k][2], l = candles[k][3], pc = candles[k - 1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  return s / period;
}

function simConfig(candles, sig, cfg) {
  const entryBar = sig.entry_bar;
  const entry = sig.entry, risk = entry - sig.stop;
  if (!(risk > 0) || entryBar == null) return null;
  const riskPct = risk / entry;
  const costR = (COST_R_BPS / 10000) / riskPct;
  const atr = atrAt(candles, entryBar - 1) || risk;
  const target = cfg.targetR != null ? entry + cfg.targetR * risk : null;

  let stop = sig.stop, beArmed = false;
  const end = Math.min(candles.length - 1, entryBar + 35);
  for (let k = entryBar + 1; k <= end; k++) {
    const hi = candles[k][2], lo = candles[k][3];
    const favR = (hi - entry) / risk;
    if (!beArmed && favR >= 1.0 && cfg.be) { stop = entry; beArmed = true; }
    // trail: once +1R, stop trails 1×ATR below the highest close/high
    if (cfg.trail && favR >= 1.0) {
      const trailStop = hi - 1.0 * atr;
      if (trailStop > stop) stop = Math.max(stop, entry); // never below BE
    }
    const hitStop = lo <= stop;
    const hitTgt = target != null && hi >= target;
    if (hitStop) {
      const gross = (stop - entry) / risk;
      return { r: gross - costR, outcome: beArmed && stop === entry ? 'BE' : 'SL' };
    }
    if (hitTgt) {
      return { r: cfg.targetR - costR, outcome: 'TGT' };
    }
  }
  const lastC = candles[end][4];
  const gross = (lastC - entry) / risk;
  return { r: gross - costR, outcome: 'TIME' };
}

const CONFIGS = {
  baseline: { be: false, trail: false, targetR: 2.0 },
  be_only: { be: true, trail: false, targetR: 2.0 },
  be_tgt15: { be: true, trail: false, targetR: 1.5 },
  be_tgt12: { be: true, trail: false, targetR: 1.2 },
  be_trail: { be: true, trail: true, targetR: null },
};

function summarize(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(t => t.r > 0).length;
  const gW = rows.filter(t => t.r > 0).reduce((s, t) => s + t.r, 0);
  const gL = Math.abs(rows.filter(t => t.r < 0).reduce((s, t) => s + t.r, 0));
  const sorted = rows.map(t => t.r).sort((a, b) => a - b);
  const top = sorted.slice(-Math.ceil(n * 0.1));
  return {
    n,
    winRate: +(wins / n * 100).toFixed(1),
    avgR: +(rows.reduce((s, t) => s + t.r, 0) / n).toFixed(3),
    totalR: +rows.reduce((s, t) => s + t.r, 0).toFixed(1),
    profitFactor: gL > 0 ? +(gW / gL).toFixed(2) : null,
    top10SharePct: total_R(sorted) !== 0 ? +(100 * top.reduce((a, b) => a + b, 0) / total_R(sorted)).toFixed(0) : null,
    exTop10AvgR: n - top.length > 0 ? +((sorted.reduce((a, b) => a + b, 0) - top.reduce((a, b) => a + b, 0)) / (n - top.length)).toFixed(3) : null,
  };
}
function total_R(sorted) { return sorted.reduce((a, b) => a + b, 0); }

function main() {
  const filtered = JSON.parse(fs.readFileSync(FILTERED_FILE, 'utf8'));
  const symbols = filtered.stocks.map(s => s.symbol);
  const collected = {}; // cfgName → rows
  for (const k of Object.keys(CONFIGS)) collected[k] = [];

  // benchmark candles for the RS frame (same dir as the OHLCV data)
  let bench = null;
  try { bench = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, 'SETFNIF50.json'), 'utf8')).candles; } catch (_) { bench = null; }

  let scanned = 0;
  for (const sym of symbols) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(OHLCV_DIR, sym + '.json'), 'utf8')); } catch (_) { continue; }
    const candles = j.candles;
    if (!candles || candles.length < 210) continue;
    scanned++;
    let r;
    try { r = detectBreakoutSignals(candles, null, { retestEntry: true }); } catch (_) { continue; }
    for (const sig of r.signals) {
      const frames = scoreFrames({ stockCandles: candles, sig, benchmarkCandles: bench });
      for (const [name, cfg] of Object.entries(CONFIGS)) {
        const sim = simConfig(candles, sig, cfg);
        if (sim) collected[name].push({
          symbol: sym, entry_date: candles[sig.entry_bar][0], entry_type: sig.entry_type, ...sim,
          f1: frames.f1.pass, f2: frames.f2.pass, f3: frames.f3.pass, f4: frames.f4.pass, f5: frames.f5.pass,
          confirm: frames.confirm, confirmMax: frames.confirmMax,
          f2_rs: frames.f2.rs, f3_ratio: frames.f3.ratio, f4_score: frames.f4.score, f5_ext: frames.f5.ext,
        });
      }
    }
  }

  const out = { generatedAt: new Date().toISOString(), scanned, costBps: COST_R_BPS, configs: {} };
  // persist trades with dates for downstream slicing (per-year etc.)
  out.trades = collected.baseline.map(t => ({ ...t }));
  console.log(`Scanned ${scanned} stocks (filtered universe)\n`);
  for (const [name, rows] of Object.entries(collected)) {
    out.configs[name] = { summary: summarize(rows), byEntryType: {} };
    for (const et of ['retest', 'breakout']) {
      out.configs[name].byEntryType[et] = summarize(rows.filter(r => r.entry_type === et));
    }
    const s = out.configs[name].summary;
    console.log(`${name.padEnd(10)} n=${String(s.n).padStart(4)}  win=${String(s.winRate).padStart(5)}%  avgR=${s.avgR}  totalR=${s.totalR}  PF=${s.profitFactor}  top10R=${s.top10SharePct}%  exTop=${s.exTop10AvgR}`);
  }
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`\nOutput: ${OUT_FILE}`);

  // ---- frame marginal-contribution report (baseline config) ----
  const base = collected.baseline;
  console.log('\n=== FRAME MARGINAL CONTRIBUTION (baseline, net R) ===');
  for (const f of ['f1', 'f2', 'f3', 'f4', 'f5']) {
    const pass = base.filter(t => t[f] === true);
    const fail = base.filter(t => t[f] === false);
    const fmt = rows => rows.length ? `n=${String(rows.length).padStart(3)} win=${String(summarize(rows).winRate).padStart(5)}% avgR=${summarize(rows).avgR}` : 'n=  0';
    console.log(`${f}  PASS ${fmt(pass)}   | FAIL ${fmt(fail)}`);
  }
  // combined gates
  console.log('\n=== COMBINED GATES ===');
  const gates = {
    f1_f2: t => t.f1 === true && t.f2 === true,
    f1_f3: t => t.f1 === true && t.f3 === true,
    f2_f3: t => t.f2 === true && t.f3 === true,
    f1_f2_f3: t => t.f1 === true && t.f2 === true && t.f3 === true,
    f1_f2_f4: t => t.f1 === true && t.f2 === true && t.f4 === true,
    confirm4: t => t.confirmMax >= 4 && t.confirm >= 4,
  };
  for (const [g, fn] of Object.entries(gates)) {
    const rows = base.filter(fn);
    const s = summarize(rows);
    console.log(`${g.padEnd(10)} n=${String(s.n).padStart(3)} win=${String(s.winRate).padStart(5)}% avgR=${s.avgR} PF=${s.profitFactor} top10=${s.top10SharePct}% exTop=${s.exTop10AvgR}`);
  }
}

main();
