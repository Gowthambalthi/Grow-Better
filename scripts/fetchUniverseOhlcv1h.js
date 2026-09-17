/**
 * scripts/fetchUniverseOhlcv1h.js — 1-hour OHLCV for the filtered universe.
 *
 * Clone of fetchUniverseOhlcv.js with:
 *   interval: ONE_HOUR
 *   output:   data/ohlcv_1h/<SYMBOL>.json (timestamps kept full: "YYYY-MM-DDTHH:MM")
 *   universe: data/universe_filtered.json (1,001 quality-filtered stocks, not 2,934)
 *   date range: last ~40 trading days by default (--days=N to override, max
 *     ~100 for Angel's per-request candle cap on intraday intervals)
 *
 * Angel SmartAPI historical API caps: intraday intervals return limited bars
 * per request (ONE_HOUR ~ 100 candles/request historically). We chunk the
 * date range into windows to cover --days.
 *
 * Usage:
 *   node scripts/fetchUniverseOhlcv1h.js                 # last 40 trading days
 *   node scripts/fetchUniverseOhlcv1h.js --days=15
 *   node scripts/fetchUniverseOhlcv1h.js --force --limit=50
 */
const fs = require('fs');
const path = require('path');

const { refresh, search } = require('../common/instruments/angelInstruments');
const { getCandleData } = require('../angelone/historical');

const UNIVERSE_FILE = path.join(__dirname, '..', 'data', 'universe_filtered.json');
const OUT_DIR = path.join(__dirname, '..', 'data', 'ohlcv_1h');
const LOG_FILE = path.join(__dirname, '..', '.freebuff', 'ohlcv1h-progress.log');

const FORCE = process.argv.includes('--force');
const DAYS_ARG = process.argv.find(a => a.startsWith('--days='));
const DAYS = DAYS_ARG ? Number(DAYS_ARG.split('=')[1]) : 40;
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1]) : Infinity;

const CONCURRENCY = 4;
const RETRIES = 4;
// Chunking: Angel intraday caps bars/request; ~30 calendar days ≈ 20 trading
// days ≈ 125 hourly bars — right at the edge, so use 25-calendar-day windows.
const WINDOW_DAYS = 25;
const TO_DATE = '2026-09-15 15:30';

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

async function fetchOne(symbol, token, windows) {
  const candles = [];
  for (const [from, to] of windows) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const rows = await getCandleData({
          symboltoken: token, fromdate: from, todate: to,
          interval: 'ONE_HOUR', exchange: 'NSE',
        });
        for (const r of rows || []) {
          const ts = String(r[0]);
          const norm = ts.length > 16 ? ts.slice(0, 16).replace('T', ' ') : ts;
          if (candles.length && candles[candles.length - 1][0] === norm) continue; // window overlap dedup
          candles.push([norm, r[1], r[2], r[3], r[4], r[5]]);
        }
        break; // window done
      } catch (e) {
        const msg = String(e.message || e);
        const wait = attempt === RETRIES ? 0 : 1500 * attempt;
        log(`  RETRY ${attempt}/${RETRIES} ${symbol} [${from}→${to}]: ${msg.slice(0, 100)}${wait ? ` (wait ${wait}ms)` : ''}`);
        if (wait) await sleep(wait);
        else return { ok: false, err: msg.slice(0, 160) };
      }
    }
  }
  const out = { symbol, token, interval: 'ONE_HOUR', from: windows[0][0], to: windows[windows.length - 1][1], candles };
  fs.writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(out));
  return { ok: true, n: candles.length };
}

async function main() {
  log(`=== 1h OHLCV fetch started (force=${FORCE}, days=${DAYS}, limit=${LIMIT === Infinity ? 'all' : LIMIT}) ===`);
  await refresh();

  const filtered = JSON.parse(fs.readFileSync(UNIVERSE_FILE, 'utf8'));
  const symbols = filtered.stocks.map(s => s.symbol);
  log(`Universe (filtered): ${symbols.length} symbols`);

  const tokenMap = new Map();
  let unresolved = [];
  for (const sym of symbols) {
    const hits = search(sym) || [];
    const pick =
      hits.find(h => h.exch_seg === 'NSE' && h.symbol === `${sym}-EQ`) ||
      hits.find(h => h.exch_seg === 'NSE' && h.symbol === sym) ||
      hits.find(h => h.exch_seg === 'NSE');
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
      if (done % 25 === 0) {
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

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
