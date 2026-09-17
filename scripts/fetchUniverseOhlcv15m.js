/**
 * scripts/fetchUniverseOhlcv15m.js — 15-minute OHLCV for the filtered universe.
 *
 * Adapted from fetchUniverseOhlcv1h.js:
 *   interval: FIFTEEN_MINUTE
 *   output:   data/ohlcv_15m/<SYMBOL>.json (timestamps "YYYY-MM-DD HH:MM")
 *
 * Angel bar caps (measured 2026-09-17, RELIANCE probe):
 *   FIFTEEN_MINUTE returns at most ~3362 bars ≈ 133 trading days ≈ 6.3
 *   months, regardless of the requested start. So the effective max window
 *   is ~6 months; --days is clamped accordingly.
 *
 * Stub policy: the 15:15 bar is a REAL 15-minute bar (15:15–15:30) at this
 * interval, so it is KEPT (unlike 1h). Only zero-volume bars are dropped.
 *
 * Usage:
 *   node scripts/fetchUniverseOhlcv15m.js                 # max window
 *   node scripts/fetchUniverseOhlcv15m.js --days=30
 *   node scripts/fetchUniverseOhlcv15m.js --force --limit=50
 */
const fs = require('fs');
const path = require('path');

const { refresh, search, findBySymbol } = require('../common/instruments/angelInstruments');
const { getCandleData } = require('../angelone/historical');

const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_DIR = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const LOG_FILE = path.join(__dirname, '..', '.freebuff', 'ohlcv15m-progress.log');

const FORCE = process.argv.includes('--force');
const DAYS_ARG = process.argv.find(a => a.startsWith('--days='));
const DAYS = DAYS_ARG ? Number(DAYS_ARG.split('=')[1]) : 190; // calendar; ~130 trading days ≈ the API cap
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1]) : Infinity;

const CONCURRENCY = 4;
const RETRIES = 4;
// 15min bars: 25/day. Angel cap ~3362 bars/request means the WHOLE window
// fits in one request up to ~130 trading days; use 45-day windows for safety.
const WINDOW_DAYS = 45;
const TO_DATE = '2026-09-17 15:30';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  process.stdout.write(line + '\n');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function dateWindows(days) {
  const windows = [];
  const end = new Date(TO_DATE.replace(' ', 'T') + ':00Z');
  let cur = new Date(end.getTime() - days * 86400000);
  while (cur < end) {
    const from = new Date(cur);
    const to = new Date(Math.min(cur.getTime() + WINDOW_DAYS * 86400000, end.getTime()));
    const fmt = d => d.toISOString().slice(0, 16).replace('T', ' ');
    windows.push([fmt(from), fmt(to)]);
    cur = to;
  }
  return windows;
}

// zero-volume bars only (15:15 is a real bar at this interval)
function filterBars(candles, symbol) {
  const kept = [];
  let droppedZeroVol = 0;
  for (const c of candles) {
    if (c[5] === 0) { droppedZeroVol++; continue; }
    kept.push(c);
  }
  if (droppedZeroVol) log(`  ${symbol}: dropped ${droppedZeroVol} zero-vol bars → ${kept.length} kept`);
  return kept;
}

async function fetchOne(symbol, token, windows) {
  const candles = [];
  for (const [from, to] of windows) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const rows = await getCandleData({
          symboltoken: token, fromdate: from, todate: to,
          interval: 'FIFTEEN_MINUTE', exchange: 'NSE',
        });
        for (const r of rows || []) {
          const ts = String(r[0]);
          const norm = ts.length > 16 ? ts.slice(0, 16).replace('T', ' ') : ts;
          if (candles.length && candles[candles.length - 1][0] === norm) continue;
          candles.push([norm, r[1], r[2], r[3], r[4], r[5]]);
        }
        break;
      } catch (e) {
        const msg = String(e.message || e);
        const wait = attempt === RETRIES ? 0 : 1500 * attempt;
        log(`  RETRY ${attempt}/${RETRIES} ${symbol} [${from}→${to}]: ${msg.slice(0, 100)}${wait ? ` (wait ${wait}ms)` : ''}`);
        if (wait) await sleep(wait);
        else return { ok: false, err: msg.slice(0, 160) };
      }
    }
  }
  const kept = filterBars(candles, symbol);
  const out = { symbol, token, interval: 'FIFTEEN_MINUTE', from: windows[0][0], to: windows[windows.length - 1][1], candles: kept };
  fs.writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(out));
  return { ok: true, n: kept.length };
}

async function main() {
  log(`=== 15m OHLCV fetch started (force=${FORCE}, days=${DAYS}, limit=${LIMIT === Infinity ? 'all' : LIMIT}) ===`);
  await refresh();

  const filtered = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const symbols = filtered.stocks.map(s => s.symbol);
  log(`Universe (filtered): ${symbols.length} symbols`);

  const tokenMap = new Map();
  const unresolved = [];
  for (const sym of symbols) {
    let pick = findBySymbol('NSE', `${sym}-EQ`) || findBySymbol('NSE', sym);
    if (!pick) {
      const hits = search(sym) || [];
      pick =
        hits.find(h => h.exch_seg === 'NSE' && h.symbol === `${sym}-EQ`) ||
        hits.find(h => h.exch_seg === 'NSE' && h.symbol === sym) ||
        hits.find(h => h.exch_seg === 'NSE');
    }
    if (pick) tokenMap.set(sym, pick.token);
    else unresolved.push(sym);
  }
  log(`Token map resolved: ${tokenMap.size}/${symbols.length} (unresolved: ${unresolved.length})`);

  const todo = [];
  for (const sym of symbols) {
    if (!tokenMap.has(sym)) continue;
    const f = path.join(OUT_DIR, `${sym}.json`);
    if (!FORCE && fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j.candles && j.candles.length > 20) continue;
      } catch (_) { /* refetch corrupt */ }
    }
    todo.push(sym);
  }
  log(`To fetch: ${todo.length}`);
  const workList = todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT);

  const windows = dateWindows(DAYS);
  log(`Windows: ${windows.length} (${windows[0][0]} → ${windows[windows.length - 1][1]})`);

  let done = 0, failed = 0, thin = 0;
  const started = Date.now();
  async function worker(queue) {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      const r = await fetchOne(sym, tokenMap.get(sym), windows);
      done++;
      if (!r.ok) { failed++; log(`FAIL ${sym}: ${r.err}`); }
      else if (r.n < 20) { thin++; }
      if (done % 50 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        log(`PROGRESS ${done}/${workList.length} (${rate.toFixed(2)}/s, failed=${failed}, thin=${thin})`);
      }
      await sleep(120);
    }
  }
  const queue = [...workList];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  log(`=== DONE: fetched ${done}, failed ${failed}, thin(<20 bars) ${thin} ===`);
}

main();
