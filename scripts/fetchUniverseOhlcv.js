/**
 * scripts/fetchUniverseOhlcv.js
 *
 * Fetches 1 year of daily OHLCV candles for EVERY symbol in
 * data/nse_universe_3000.txt (2,934 NSE mainboard equities) via the
 * Angel One SmartAPI historical endpoint, and stores one JSON file per
 * symbol under data/ohlcv/:
 *
 *   data/ohlcv/<SYMBOL>.json  ->  { symbol, token, from, to, candles: [[ts,o,h,l,c,v], ...] }
 *
 * Features:
 *  - Resume-safe: symbols that already have a valid file are skipped
 *    (delete a file or run with --force to refetch).
 *  - Concurrency-limited (default 4 parallel requests) + polite pacing.
 *  - Automatic retry with backoff on rate-limit / network errors.
 *  - Token resolution via the Angel instrument master (loaded at start).
 *  - Progress written to .freebuff/ohlcv-progress.log
 *
 * Usage:
 *   node scripts/fetchUniverseOhlcv.js            # fetch all (resumes)
 *   node scripts/fetchUniverseOhlcv.js --force    # refetch everything
 *   node scripts/fetchUniverseOhlcv.js --limit=50 # only first N missing
 */

const fs = require('fs');
const path = require('path');

const { refresh, search, findBySymbol } = require('../common/instruments/angelInstruments');
const { getCandleData } = require('../angelone/historical');

const UNIVERSE_FILE = process.env.UNIVERSE_FILE || path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'data', 'ohlcv');
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', '.freebuff', 'ohlcv-progress.log');

const FORCE = process.argv.includes('--force');
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = LIMIT_ARG ? Number(LIMIT_ARG.split('=')[1]) : Infinity;

const CONCURRENCY = 4;
const RETRIES = 4;
const TO_DATE = process.env.TO_DATE || '2026-09-15 15:30';
const FROM_DATE = process.env.FROM_DATE || '2025-09-15 09:15';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  fs.appendFileSync(LOG_FILE, line + '\n');
  process.stdout.write(line + '\n');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchOne(symbol, token) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const rows = await getCandleData({
        symboltoken: token,
        fromdate: FROM_DATE,
        todate: TO_DATE,
        interval: 'ONE_DAY',
        exchange: 'NSE',
      });
      // rows: [timestamp, open, high, low, close, volume]
      const candles = (rows || []).map(r => [
        String(r[0]).slice(0, 10), r[1], r[2], r[3], r[4], r[5],
      ]);
      const out = { symbol, token, from: FROM_DATE.slice(0, 10), to: TO_DATE.slice(0, 10), candles };
      fs.writeFileSync(path.join(OUT_DIR, `${symbol}.json`), JSON.stringify(out));
      return { ok: true, n: candles.length };
    } catch (e) {
      const msg = String(e.message || e);
      // Rate limited / session hiccup: wait progressively longer
      const wait = attempt === RETRIES ? 0 : 1500 * attempt + Math.floor(Math.random() * 800);
      log(`  RETRY ${attempt}/${RETRIES} ${symbol}: ${msg.slice(0, 120)}${wait ? ` (wait ${wait}ms)` : ''}`);
      if (wait) await sleep(wait);
      else return { ok: false, err: msg.slice(0, 160) };
    }
  }
}

async function main() {
  log(`=== OHLCV fetch started (force=${FORCE}, limit=${LIMIT === Infinity ? 'all' : LIMIT}) ===`);
  await refresh(); // load instrument master (25k instruments)

  const symbols = fs.readFileSync(UNIVERSE_FILE, 'utf8').trim().split('\n').map(s => s.trim()).filter(Boolean);
  log(`Universe: ${symbols.length} symbols`);

  // Resolve tokens
  const tokenMap = new Map();
  let unresolved = [];
  for (const sym of symbols) {
    // Prefer the "-EQ" (regular) series instrument, fall back to plain match
    const hits = search(sym) || [];
    // Exact-symbol lookup FIRST: search() is fuzzy and for short symbols can
    // omit the target entirely (search('LT') lacks LT-EQ), making the third
    // fallback grab a WRONG instrument (LT resolved to the Nifty Realty index;
    // BI to IFBIND). Found via cross-checking all 1,001 resolutions.
    let pick = null;
    const exact = findBySymbol('NSE', `${sym}-EQ`) || findBySymbol('NSE', sym);
    if (exact) pick = exact;
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
  if (unresolved.length) log(`Unresolved symbols: ${unresolved.slice(0, 40).join(', ')}${unresolved.length > 40 ? ' ...' : ''}`);

  // Skip already-fetched (resume-safe)
  const todo = [];
  for (const sym of symbols) {
    if (!tokenMap.has(sym)) continue;
    const f = path.join(OUT_DIR, `${sym}.json`);
    if (!FORCE && fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (j.candles && j.candles.length > 100) continue; // valid — skip
      } catch (_) { /* corrupt file → refetch */ }
    }
    todo.push(sym);
  }
  const skipped = symbols.length - todo.length - unresolved.length;
  log(`To fetch: ${todo.length} (skipped valid: ${skipped})`);
  const workList = todo.slice(0, LIMIT === Infinity ? todo.length : LIMIT);

  // Concurrency-limited worker pool
  let done = 0, failed = 0, empty = 0;
  const started = Date.now();
  async function worker(queue) {
    while (queue.length) {
      const sym = queue.shift();
      if (!sym) break;
      const r = await fetchOne(sym, tokenMap.get(sym));
      done++;
      if (!r.ok) { failed++; log(`FAIL ${sym}: ${r.err}`); }
      else if (r.n < 50) { empty++; }
      if (done % 25 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        log(`PROGRESS ${done}/${workList.length} (${rate.toFixed(2)}/s, failed=${failed})`);
      }
      await sleep(120); // pacing
    }
  }
  const queue = [...workList];
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

  log(`=== DONE: fetched ${done}, failed ${failed}, low-data ${empty}, skipped-valid ${skipped}, unresolved ${unresolved.length} ===`);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
