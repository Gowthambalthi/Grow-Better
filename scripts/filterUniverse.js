/**
 * scripts/filterUniverse.js — Post-close universe quality filter.
 *
 * Runs daily after market close, BEFORE any scoring/scanning. Applies gates
 * in cheapest/most-decisive-first order so corrupt data never poisons later
 * checks:
 *
 *   F6  Data integrity   — bar with high < low, close <= 0, non-numeric OHLCV
 *   F5  Staleness        — last candle > maxStaleDays old, or < minBars bars
 *   F1  Price floor      — latest close < minPrice (₹100)
 *   F2  Turnover         — 20-day avg (close × volume) < minTurnoverCr (₹5 Cr)
 *   F4  Dead/circuit     — > maxDeadDays in last 60 with O=H=L=C, or volume < 1000
 *   F7  Volatility       — 20-day ATR% > maxAtrPct → reject; 2–8% → tag volBand:'high'
 *   F8  Ban list         — optional data/banned_symbols.txt (GSM/ASM/SME/T2T, manual)
 *
 * F3 (share-count floor) intentionally dropped: F2 subsumes it.
 *
 * Output:
 *   data/universe_filtered.json  { generatedAt, counts, stocks: [...] }
 *   data/universe_rejected.json  one row per rejection: { symbol, gate, value, reason }
 *
 * Usage: node scripts/filterUniverse.js
 */
const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_FILTERED = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_REJECTED = path.join(__dirname, '..', 'data', 'universe_rejected.json');
const BAN_FILE = path.join(__dirname, '..', 'data', 'banned_symbols.txt');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'universe_history.ndjson');
const HISTORY_FILE_REJ = path.join(__dirname, '..', 'data', 'universe_history_rejected.ndjson');

// ---------- configurable gates ----------
const CONFIG = {
  minBars: 205,          // F5: EMA200 is load-bearing in scoreEngines (alignment, TREND,
                         // ACCUMULATION) — 205 bars gives the EMA200 ~5 bars to warm up
                         // so alignment comparisons near the end of history are valid.
  maxStaleDays: 3,       // F5: last candle older than this many calendar days ≈ 2 trading days
  minPrice: 100,         // F1
  minTurnoverCr: 5,      // F2: ₹ Cr average daily turnover (close × volume), 20-day
  turnoverBars: 20,
  maxDeadDays: 5,        // F4: max dead/circuit days allowed in last 60
  deadWindow: 60,
  minVolume: 1000,       // F4: below this = effectively not trading
  minAtrPct: 1.5,        // F7 floor: ATR% below this = stock barely moves (dead money
                         // intraday — spreads and churn eat any edge)
  maxAtrPct: 8,          // F7 ceiling: reject above this ATR% (ATR/close, 20-day)
  highAtrPct: 4,         // F7: tag volBand 'high' above this (2–8% was too wide to
                         // discriminate — 93% of passers landed in one band; 4–8% is
                         // the genuinely-hot tail)
};

// ---------- gate helpers ----------
function gateF6_integrity(candles) {
  for (let i = 0; i < candles.length; i++) {
    const [, o, h, l, c, v] = candles[i];
    if (![o, h, l, c, v].every(x => typeof x === 'number' && isFinite(x))) {
      return { fail: `bar ${i} non-numeric OHLCV` };
    }
    if (h < l) return { fail: `bar ${i} (${candles[i][0]}) high < low` };
    if (c <= 0) return { fail: `bar ${i} (${candles[i][0]}) close <= 0` };
    if (v < 0) return { fail: `bar ${i} negative volume` };
  }
  return null;
}

function gateF5_staleness(candles) {
  if (candles.length < CONFIG.minBars) {
    return { fail: `only ${candles.length} bars < ${CONFIG.minBars}` };
  }
  const last = new Date(candles[candles.length - 1][0] + 'T00:00:00Z');
  const ageDays = (Date.now() - last.getTime()) / 86400000;
  if (ageDays > CONFIG.maxStaleDays) {
    return { fail: `last candle ${candles[candles.length - 1][0]} is ${Math.round(ageDays)}d old` };
  }
  return null;
}

function gateF1_price(candles) {
  const close = candles[candles.length - 1][4];
  if (close < CONFIG.minPrice) return { fail: `close ₹${close.toFixed(2)} < ₹${CONFIG.minPrice}` };
  return null;
}

function gateF2_turnover(candles) {
  const n = candles.length;
  if (n < CONFIG.turnoverBars) return { fail: 'insufficient bars' };
  let s = 0;
  for (let i = n - CONFIG.turnoverBars; i < n; i++) s += candles[i][4] * candles[i][5];
  const avg = s / CONFIG.turnoverBars;
  if (avg < CONFIG.minTurnoverCr * 1e7) {
    return { fail: `avg turnover ₹${(avg / 1e7).toFixed(2)} Cr < ₹${CONFIG.minTurnoverCr} Cr`, value: avg / 1e7 };
  }
  return { pass: avg / 1e7 };
}

function gateF4_dead(candles) {
  const w = candles.slice(-CONFIG.deadWindow);
  let flatDays = 0, thinDays = 0;
  for (const [, o, h, l, c, v] of w) {
    if (o === h && h === l && l === c) flatDays++;
    if (v < CONFIG.minVolume) thinDays++;
  }
  if (flatDays > CONFIG.maxDeadDays) return { fail: `${flatDays} flat O=H=L=C days in last ${CONFIG.deadWindow}` };
  if (thinDays > CONFIG.maxDeadDays) return { fail: `${thinDays} days with volume < ${CONFIG.minVolume} in last ${CONFIG.deadWindow}` };
  return null;
}

function gateF7_volatility(candles) {
  // 20-day ATR% at the latest bar
  const n = candles.length;
  const trs = [];
  for (let i = n - 21; i < n; i++) {
    if (i < 1) continue;
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < 20) return { fail: 'insufficient bars for ATR' };
  const atr = trs.reduce((a, b) => a + b, 0) / 20;
  const close = candles[n - 1][4];
  const atrPct = (atr / close) * 100;
  if (atrPct < CONFIG.minAtrPct) {
    return { fail: `ATR% ${atrPct.toFixed(2)} < ${CONFIG.minAtrPct}% (dead money)`, value: atrPct };
  }
  if (atrPct > CONFIG.maxAtrPct) {
    return { fail: `ATR% ${atrPct.toFixed(1)} > ${CONFIG.maxAtrPct}%`, value: atrPct };
  }
  return { pass: atrPct };
}

// ---------- history logging (append-only, one row per stock per day) ----------
// Passers → universe_history.ndjson; rejected → universe_history_rejected.ndjson
// (with ATR% where computable). Purpose: track the volatility distribution of
// BOTH populations over time, to answer whether the 4-8% ATR cluster is a
// market regime or a selection artifact of F1/F2. Review discipline: treat
// 2-3 weeks as a first checkpoint, 2-3 months before drawing real conclusions
// (NSE regimes shift with budget/RBI/earnings events).
function tradeDateOf(candles) {
  return candles[candles.length - 1][0];
}

function computeAtrPct(candles) {
  const n = candles.length;
  if (n < 22) return null;
  let s = 0;
  for (let i = n - 20; i < n; i++) {
    const h = candles[i][2], l = candles[i][3], pc = candles[i - 1][4];
    s += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const close = candles[n - 1][4];
  return close > 0 ? +(((s / 20) / close) * 100).toFixed(2) : null;
}

function appendHistory(file, rows) {
  if (!rows.length) return;
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// Idempotent per trading date: drop any existing rows for `date` (re-run after
// market close) and append the fresh set, so history never duplicates a day.
function rewriteDateRows(file, date, rows) {
  let existing = [];
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(r => r && r.date !== date);
  }
  const all = [...existing, ...rows];
  fs.writeFileSync(file, all.map(r => JSON.stringify(r)).join('\n') + (all.length ? '\n' : ''));
}

// ---------- main ----------
function main() {
  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);

  // F8 — optional manual ban list (GSM/ASM/SME/T2T etc.)
  let banned = new Set();
  if (fs.existsSync(BAN_FILE)) {
    banned = new Set(fs.readFileSync(BAN_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean));
    console.log(`F8 ban list loaded: ${banned.size} symbols`);
  }

  const counts = { integrity: 0, stale: 0, price: 0, turnover: 0, dead: 0, volatility: 0, banned: 0, missing: 0 };
  const stocks = [], rejected = [];
  const countGate = (gate) => {
    if (gate === 'F6') counts.integrity++;
    else if (gate === 'F5') counts.stale++;
    else if (gate === 'F1') counts.price++;
    else if (gate === 'F2') counts.turnover++;
    else if (gate === 'F4') counts.dead++;
    else if (gate === 'F7') counts.volatility++;
  };

  const candleMap = new Map(); // symbol → candles, for rejected-history ATR logging
  for (const sym of symbols) {
    if (banned.has(sym)) { counts.banned++; rejected.push({ symbol: sym, gate: 'F8', value: null, reason: 'on manual ban list' }); continue; }
    const f = path.join(OHLCV_DIR, sym + '.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (_) { counts.missing++; continue; }
    const candles = j.candles;
    if (!Array.isArray(candles) || candles.length === 0) { counts.missing++; continue; }
    candleMap.set(sym, candles);

    // Gate order: F6 → F5 → F1 → F2 → F4 → F7
    let g = gateF6_integrity(candles);
    if (g) { countGate('F6'); rejected.push({ symbol: sym, gate: 'F6', value: null, reason: g.fail }); continue; }

    g = gateF5_staleness(candles);
    if (g) { countGate('F5'); rejected.push({ symbol: sym, gate: 'F5', value: null, reason: g.fail }); continue; }

    g = gateF1_price(candles);
    if (g) { countGate('F1'); rejected.push({ symbol: sym, gate: 'F1', value: null, reason: g.fail }); continue; }

    const t = gateF2_turnover(candles);
    if (t.fail) { countGate('F2'); rejected.push({ symbol: sym, gate: 'F2', value: t.value, reason: t.fail }); continue; }

    g = gateF4_dead(candles);
    if (g) { countGate('F4'); rejected.push({ symbol: sym, gate: 'F4', value: null, reason: g.fail }); continue; }

    const v = gateF7_volatility(candles);
    if (v.fail) { countGate('F7'); rejected.push({ symbol: sym, gate: 'F7', value: v.value, reason: v.fail }); continue; }

    // passed all gates
    const n = candles.length;
    const close = candles[n - 1][4];
    const avgVol20 = candles.slice(-20).reduce((a, r) => a + r[5], 0) / 20;
    stocks.push({
      symbol: sym,
      close: +close.toFixed(2),
      atrPct: +v.pass.toFixed(2),
      avgTurnoverCr: +t.pass.toFixed(2),
      avgVol20: Math.round(avgVol20),
      volBand: v.pass > CONFIG.highAtrPct ? 'high' : 'normal',
    });
  }

  stocks.sort((a, b) => b.avgTurnoverCr - a.avgTurnoverCr);
  const out = {
    generatedAt: new Date().toISOString(),
    universe: symbols.length,
    passed: stocks.length,
    rejected: rejected.length,
    counts,
    config: CONFIG,
    stocks,
  };
  fs.writeFileSync(OUT_FILTERED, JSON.stringify(out));
  fs.writeFileSync(OUT_REJECTED, JSON.stringify({ generatedAt: out.generatedAt, rejected }));

  // Idempotent per trading date: if history already has rows for this date
  // (re-run after market close), replace that date's rows instead of duplicating.
  const date = stocks.length ? tradeDateOf(stocks[0] ? candleMap.get(stocks[0].symbol) : null) : null;
  if (date) rewriteDateRows(HISTORY_FILE, date, stocks.map(s => ({
    date, symbol: s.symbol, atrPct: s.atrPct, close: s.close,
    turnoverCr: s.avgTurnoverCr, volBand: s.volBand,
  })));
  if (date) rewriteDateRows(HISTORY_FILE_REJ, date, rejected.map(r => {
    const c = candleMap.get(r.symbol);
    return { date, symbol: r.symbol, gate: r.gate, atrPct: c ? computeAtrPct(c) : null, close: c ? c[c.length - 1][4] : null };
  }));

  console.log(`Universe: ${symbols.length} → passed ${stocks.length}, rejected ${rejected.length} (${counts.missing} missing files)`);
  console.log(`Rejections: F6 integrity=${counts.integrity}  F5 stale=${counts.stale}  F1 price=${counts.price}  F2 turnover=${counts.turnover}  F4 dead=${counts.dead}  F7 volat=${counts.volatility}  F8 banned=${counts.banned}`);
  const bands = { normal: 0, high: 0 };
  for (const s of stocks) bands[s.volBand]++;
  console.log(`volBand: normal(<${CONFIG.highAtrPct}%)=${bands.normal}  high(${CONFIG.highAtrPct}-${CONFIG.maxAtrPct}%)=${bands.high}`);
  console.log(`Output: ${OUT_FILTERED}`);
}

main();
