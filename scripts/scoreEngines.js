/**
 * scripts/scoreEngines.js
 *
 * Reads data/ohlcv/<SYMBOL>.json (1y daily candles) for every symbol in
 * data/nse_universe_3000.txt, computes indicators on the latest bar and
 * scores each stock on the 5 GB engines:
 *
 *   BREAKOUT, TREND, PULLBACK, SUPPORT BOUNCE, ACCUMULATION
 *
 * Output: data/engine_scores.json  -> { generatedAt, scanned, results: [...] }
 *
 * Usage: node scripts/scoreEngines.js
 */
const fs = require('fs');
const path = require('path');

const OHLCV_DIR = path.join(__dirname, '..', 'data', 'ohlcv');
const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_FILE = path.join(__dirname, '..', 'data', 'engine_scores.json');

// ---------- indicator helpers ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out; // undefined before period-1
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function trueRanges(c, h, l) {
  const trs = [null];
  for (let i = 1; i < c.length; i++) {
    trs.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  return trs;
}

function atr(c, h, l, period = 14) {
  const trs = trueRanges(c, h, l);
  const out = new Array(c.length).fill(null);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += trs[i];
  out[period] = sum / period;
  for (let i = period + 1; i < c.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
  }
  return out;
}

function adx(c, h, l, period = 14) {
  const n = c.length;
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < n; i++) {
    const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  const trs = trueRanges(c, h, l);
  const smooth = (arr) => {
    const s = new Array(n).fill(null);
    let acc = 0;
    for (let i = 1; i <= period; i++) acc += arr[i];
    s[period] = acc;
    for (let i = period + 1; i < n; i++) {
      s[i] = s[i - 1] - s[i - 1] / period + arr[i];
    }
    return s;
  };
  const sTR = smooth(trs), sP = smooth(plusDM), sM = smooth(minusDM);
  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (!sTR[i]) continue;
    const pdi = 100 * sP[i] / sTR[i];
    const mdi = 100 * sM[i] / sTR[i];
    dx[i] = pdi + mdi === 0 ? 0 : 100 * Math.abs(pdi - mdi) / (pdi + mdi);
  }
  const adxArr = new Array(n).fill(null);
  let acc = 0, cnt = 0;
  for (let i = period; i < n; i++) {
    if (dx[i] == null) continue;
    if (cnt < period) { acc += dx[i]; cnt++; if (cnt === period) adxArr[i] = acc / period; }
    else adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
  }
  // also return latest DI+/DI-
  const last = n - 1;
  const pdi = sTR[last] ? 100 * sP[last] / sTR[last] : null;
  const mdi = sTR[last] ? 100 * sM[last] / sTR[last] : null;
  return { adx: adxArr, pdi, mdi };
}

// ---------- candle patterns (latest bar) ----------
function candlePatterns(c, o, h, l, nearSupport) {
  const i = c.length - 1;
  const body = Math.abs(c[i] - o[i]);
  const upper = h[i] - Math.max(o[i], c[i]);
  const lower = Math.min(o[i], c[i]) - l[i];
  const range = h[i] - l[i];
  const doji = range > 0 && body <= range * 0.10;
  const marubozu = range > 0 && body >= range * 0.95;
  const hammer = range > 0 && lower > body * 2 && upper < body * 0.5;
  const bullEngulf = c[i] > o[i] && c[i - 1] < o[i - 1] && o[i] <= c[i - 1] && c[i] >= o[i - 1];
  const insideBar = h[i] < h[i - 1] && l[i] > l[i - 1] && body < Math.abs(c[i - 1] - o[i - 1]) * 0.7;
  const morningStar =
    c[i - 2] < o[i - 2] &&
    (dojiAt(i - 1) || Math.abs(c[i - 1] - o[i - 1]) < Math.abs(c[i - 2] - o[i - 2])) &&
    c[i] > o[i] && c[i] > o[i - 2] + Math.abs(c[i - 2] - o[i - 2]) / 2;
  function dojiAt(j) {
    const r = h[j] - l[j];
    return r > 0 && Math.abs(c[j] - o[j]) <= r * 0.10;
  }
  let name = 'NEUTRAL', rating = 5;
  if (marubozu) { name = 'MARUBOZU'; rating = 10; }
  else if (morningStar) { name = 'MORNING STAR'; rating = 10; }
  else if (hammer && nearSupport) { name = 'HAMMER'; rating = 9; }
  else if (bullEngulf) { name = 'BULL ENGULF'; rating = 8; }
  else if (insideBar) { name = 'INSIDE BAR'; rating = 6; }
  else if (doji) { name = 'DOJI'; rating = 4; }
  return { name, rating };
}

// ---------- weekly trend approximation ----------
// Approximate weekly bars by grouping the last ~120 daily candles into
// calendar-week buckets (Monday-based); bullish = last weekly close > last
// weekly EMA20 AND weekly RSI > 55, matching the Pine logic's weekly bull.
function weeklyBullish(candles) {
  if (candles.length < 60) return false;
  const weeks = [];
  let cur = null;
  for (const [date, , , , close] of candles) {
    const d = new Date(date + 'T00:00:00Z');
    const day = d.getUTCDay();
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    if (!cur || cur.key !== key) { cur = { key, close }; weeks.push(cur); }
    else cur.close = close;
  }
  const closes = weeks.map(w => w.close);
  if (closes.length < 20) return false;
  const e = ema(closes, 20);
  const r = rsi(closes, 14);
  const emaLast = e[e.length - 1], rsiLast = r[r.length - 1];
  if (emaLast == null || rsiLast == null) return false;
  return closes[closes.length - 1] > emaLast && rsiLast > 55;
}

// ---------- per-stock evaluation ----------
function evaluate(candles) {
  if (candles.length < 60) return null; // not enough history for the indicators
  const dates = candles.map(r => r[0]);
  const o = candles.map(r => r[1]);
  const h = candles.map(r => r[2]);
  const l = candles.map(r => r[3]);
  const c = candles.map(r => r[4]);
  const v = candles.map(r => r[5]);
  const n = c.length;

  const e20 = ema(c, 20), e50 = ema(c, 50), e200arr = ema(c, 200);
  const ema20 = e20[n - 1], ema50 = e50[n - 1], ema200 = e200arr[n - 1];
  const ema20_5 = e20[n - 6]; // EMA20 5 bars ago
  const ema200_20 = n - 21 >= 199 ? e200arr[n - 21] : null; // EMA200 20 bars ago
  const rsi14 = rsi(c, 14)[n - 1];
  const atr14 = atr(c, h, l, 14)[n - 1];
  const { adx: adxArr, pdi, mdi } = adx(c, h, l, 14);
  const adxVal = adxArr[n - 1];

  const avgVol = v.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol > 0 ? v[n - 1] / avgVol : 0;

  const support30 = Math.min(...l.slice(-30));
  const resistance30 = Math.max(...h.slice(-30));
  const close = c[n - 1];
  const nearSupport = Math.abs(close - support30) < atr14 * 1.5;

  const bullishAlignment = ema20 > ema50 && ema50 > ema200;
  const strongTrend = close > ema50 && bullishAlignment;

  const pat = candlePatterns(c, o, h, l, nearSupport);

  // volume falling 2 days straight (dry volume)
  const dryVolume = v[n - 1] < v[n - 2] && v[n - 2] < v[n - 3];

  // 20-day base tightness
  const hi20 = Math.max(...h.slice(-20));
  const lo20 = Math.min(...l.slice(-20));
  const baseRange = ((hi20 - lo20) / lo20) * 100;
  const tightBase = baseRange < 10;

  const weeklyBull = weeklyBullish(candles);

  // ---------- engine scores ----------
  const parts = {};

  // BREAKOUT (max 12)
  let breakout = 0; const bp = [];
  if (close > resistance30 * 1.001) { breakout += 4; bp.push('close>res30'); }
  if (volRatio >= 1.5) { breakout += 3; bp.push('vol>=1.5x'); }
  if (adxVal >= 20) { breakout += 2; bp.push('ADX>=20'); }
  if (rsi14 > 55 && rsi14 < 80) { breakout += 2; bp.push('RSI 55-80'); }
  if (bullishAlignment) { breakout += 1; bp.push('EMA align'); }
  parts.breakout = bp;

  // TREND (max 12)
  let trend = 0; const tp = [];
  if (close > ema20) { trend += 2; tp.push('close>EMA20'); }
  if (ema20 > ema50) { trend += 2; tp.push('EMA20>50'); }
  if (ema50 > ema200) { trend += 2; tp.push('EMA50>200'); }
  if (rsi14 > 55 && rsi14 < 75) { trend += 2; tp.push('RSI 55-75'); }
  if (adxVal > 20) { trend += 1; tp.push('ADX>20'); }
  if (bullishAlignment) { trend += 1; tp.push('EMA align'); }
  if (ema20 > ema20_5) { trend += 2; tp.push('EMA20 rising5'); }
  parts.trend = tp;

  // PULLBACK (max 12)
  let pullback = 0; const pp = [];
  if (close > ema50) { pullback += 2; pp.push('close>EMA50'); }
  if (close < ema20) { pullback += 2; pp.push('close<EMA20'); }
  if (strongTrend) { pullback += 2; pp.push('strong trend'); }
  if (pat.rating >= 6) { pullback += 2; pp.push('candle>=' + pat.rating); }
  if (rsi14 > 45 && rsi14 < 65) { pullback += 2; pp.push('RSI 45-65'); }
  if (dryVolume) { pullback += 2; pp.push('vol drying'); }
  parts.pullback = pp;

  // SUPPORT BOUNCE (max 15)
  let bounce = 0; const sp = [];
  if (close > ema200 * 0.90) { bounce += 2; sp.push('close>0.9*EMA200'); }
  if (nearSupport) { bounce += 3; sp.push('near support30'); }
  if (['HAMMER', 'BULL ENGULF', 'MORNING STAR'].includes(pat.name) || (pat.name === 'HAMMER')) { bounce += 3; sp.push(pat.name); }
  if (rsi14 < 35) { bounce += 3; sp.push('RSI<35'); }
  else if (rsi14 >= 35 && rsi14 < 45) { bounce += 1; sp.push('RSI 35-45'); }
  if (volRatio > 1.5) { bounce += 3; sp.push('vol>1.5x'); }
  else if (volRatio > 1.2 && volRatio <= 1.5) { bounce += 1; sp.push('vol 1.2-1.5x'); }
  parts.bounce = sp;

  // ACCUMULATION (max 10)
  let accum = 0; const ap = [];
  if (tightBase) { accum += 3; ap.push('tight base'); }
  if (close > ema200) { accum += 2; ap.push('close>EMA200'); }
  if (ema200_20 != null && ema200 > ema200_20) { accum += 2; ap.push('EMA200 rising'); }
  if (weeklyBull) { accum += 2; ap.push('weekly bull'); }
  if (volRatio < 1) { accum += 1; ap.push('vol<1x'); }
  parts.accum = ap;

  const engines = [
    { engine: 'BREAKOUT', score: breakout },
    { engine: 'TREND', score: trend },
    { engine: 'PULLBACK', score: pullback },
    { engine: 'SUPPORT BOUNCE', score: bounce },
    { engine: 'ACCUMULATION', score: accum },
  ];
  engines.sort((a, b) => b.score - a.score);
  // Tie-break by signature condition: an engine only "wins" a tie if its
  // defining condition actually fired (e.g. BREAKOUT requires close above
  // 30-day resistance; SUPPORT BOUNCE requires proximity to support30).
  const signatureFired = {
    'BREAKOUT': close > resistance30 * 1.001,
    'TREND': true,
    'PULLBACK': close > ema50 && close < ema20,
    'SUPPORT BOUNCE': nearSupport,
    'ACCUMULATION': tightBase,
  };
  let winner = engines[0];
  for (const e of engines) {
    if (e.score < engines[0].score) break; // only consider top-score ties
    if (signatureFired[e.engine]) { winner = e; break; }
  }
  engines.forEach(e => { e.won = e === winner; });

  return {
    symbol: null, // filled by caller
    date: dates[n - 1],
    close: +close.toFixed(2),
    indicators: {
      ema20: +ema20.toFixed(2), ema50: +ema50.toFixed(2), ema200: ema200 ? +ema200.toFixed(2) : null,
      rsi14: +rsi14.toFixed(1), atr14: +atr14.toFixed(2),
      adx14: adxVal != null ? +adxVal.toFixed(1) : null, diPlus: pdi != null ? +pdi.toFixed(1) : null, diMinus: mdi != null ? +mdi.toFixed(1) : null,
      avgVol20: Math.round(avgVol), volRatio: +volRatio.toFixed(2),
      support30: +support30.toFixed(2), resistance30: +resistance30.toFixed(2),
      candlePattern: pat.name, candleRating: pat.rating,
      weeklyBull, nearSupport,
    },
    engineScores: { BREAKOUT: breakout, TREND: trend, PULLBACK: pullback, 'SUPPORT BOUNCE': bounce, ACCUMULATION: accum },
    engineHits: parts,
    engineRate: winner.score,
    winningEngine: winner.engine,
  };
}

// ---------- main ----------
function main() {
  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const results = [];
  let skipped = 0, missing = 0;

  for (const sym of symbols) {
    const f = path.join(OHLCV_DIR, sym + '.json');
    let j;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (_) { missing++; continue; }
    // Liquidity/quality floor: stocks priced below ₹100 are excluded from
    // the entire application (user requirement).
    if (j.candles[j.candles.length - 1][4] < 100) { skipped++; continue; }
    if (!Array.isArray(j.candles) || j.candles.length < 60) { skipped++; continue; }
    const r = evaluate(j.candles);
    if (!r) { skipped++; continue; }
    r.symbol = sym;
    results.push(r);
  }

  results.sort((a, b) => b.engineRate - a.engineRate);
  const out = {
    generatedAt: new Date().toISOString(),
    universe: symbols.length,
    scanned: results.length,
    skippedShortHistory: skipped,
    missingFiles: missing,
    results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Scanned ${results.length} stocks (${skipped} short-history skipped, ${missing} missing files)`);
  console.log(`Output: ${OUT_FILE}`);
  const buys = results.filter(r => r.engineRate >= 7);
  console.log(`engineRate >= 7 (buy setups): ${buys.length}`);
  console.log(`Top 10: ${results.slice(0, 10).map(r => `${r.symbol} ${r.winningEngine}(${r.engineRate})`).join(', ')}`);
}

main();
