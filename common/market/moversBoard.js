/**
 * common/market/moversBoard.js — FULL-UNIVERSE live movers board.
 *
 * Previous implementation polled Yahoo's 1-min chart API once per symbol
 * (concurrency 14) and only covered ~700 engine-scored stocks — too slow
 * for the full 2,934-name universe and too coarse for a live board.
 *
 * This module instead:
 *   1. Fetches ALL ~2,934 NSE stocks via Yahoo's batch quote endpoint
 *      (v7/finance/quote, cookie+crumb auth) — ~150 symbols per request,
 *      ~20 requests per cycle with modest parallelism.
 *   2. Keeps a rolling in-memory price history per symbol ({t, p}, last
 *      8 minutes) built from the batch cycles (~every 15-60s).
 *   3. Computes 1-min / 2-min / 5-min % moves from that history at read
 *      time — the reference price is the sample closest to (now - window),
 *      never the day's data.
 *   4. STALENESS GATE: a symbol whose newest quote is > 90s old is marked
 *      stale and EXCLUDED from the ranked board — delayed data must never
 *      look like a live move.
 *
 * Output shape matches the old live_movers.json consumers exactly:
 *   { generatedAt, marketOpen, movers, stocks: [{symbol, engine, score,
 *      ltp, m1, m2, m5, mDay, trail, isMover, stale, time}] }
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DATA = path.join(__dirname, '..', '..', 'data');
const MOVERS_FILE = path.join(DATA, 'live_movers.json');
const UNIVERSE_FILE = path.join(DATA, 'nse_universe_3000.txt');

const MIN_PRICE = 100;      // same floor as the call engine
const MOVER_TH = 1.0;       // % move on any window flags a MOVER
const STALE_SEC = 90;       // quote older than this = delayed, excluded
const BATCH = 150;          // symbols per quote request
const CONC = 5;             // parallel batches
const HIST_MS = 8 * 60000;  // rolling history retention
const CYCLE_MS = 20000;     // min gap between quote sweeps

const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

// ---------- cookie + crumb session (v7 quote endpoint auth) ----------
let _sess = { cookie: '', crumb: '', at: 0 };

async function ensureSession(force = false) {
  const fresh = _sess.cookie && _sess.crumb && (Date.now() - _sess.at) < 30 * 60000;
  if (fresh && !force) return _sess;
  let cookie = '';
  try {
    const r = await axios.get('https://fc.yahoo.com/', { headers: H, timeout: 8000 });
    cookie = (r.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  } catch (e) {
    cookie = ((e.response && e.response.headers['set-cookie']) || []).map(s => s.split(';')[0]).join('; ');
  }
  const cr = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...H, Cookie: cookie }, timeout: 8000 });
  _sess = { cookie, crumb: String(cr.data).trim(), at: Date.now() };
  return _sess;
}

// ---------- state ----------
const hist = new Map();          // symbol -> [{t, p}] ascending
let _lastSweep = 0;
let _sweeping = false;
let _universe = null;            // [{symbol, engine, score}] | null

function loadUniverse() {
  if (_universe && _universe.length) return _universe;
  const map = new Map(); // symbol -> {symbol, engine, score}
  // universe file: the full 2,934 mainboard list
  try {
    const txt = fs.readFileSync(UNIVERSE_FILE, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim().toUpperCase();
      if (s && /^[A-Z0-9&_-]+$/.test(s)) map.set(s, { symbol: s, engine: null, score: null });
    }
  } catch (_) {}
  // annotate with engine scores where available
  try {
    const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
    for (const r of es.results || []) {
      const s = String(r.symbol || '').replace(/-EQ$/i, '').toUpperCase();
      if (map.has(s)) { map.get(s).engine = r.winningEngine; map.get(s).score = r.engineRate; }
      else map.set(s, { symbol: s, engine: r.winningEngine, score: r.engineRate });
    }
  } catch (_) {}
  _universe = [...map.values()];
  if (!_universe.length) {
    // absolute fallback: engine scores only
    try {
      const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
      _universe = (es.results || []).map(r => ({ symbol: String(r.symbol).replace(/-EQ$/i, '').toUpperCase(), engine: r.winningEngine, score: r.engineRate }));
    } catch (_) { _universe = []; }
  }
  return _universe;
}

// ---------- quote sweep ----------
async function sweep() {
  if (_sweeping) return;
  const uni = loadUniverse();
  if (!uni.length) return;
  _sweeping = true;
  const t0 = Date.now();
  try {
    const batches = [];
    const syms = uni.map(u => u.symbol + '.NS');
    for (let i = 0; i < syms.length; i += BATCH) batches.push(syms.slice(i, i + BATCH));

    let session = await ensureSession();
    const now = Date.now();
    let got = 0;

    const runBatch = async (b) => {
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(b.join(','))}&crumb=${encodeURIComponent(session.crumb)}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await axios.get(url, { headers: { ...H, Cookie: session.cookie }, timeout: 6000 });
          const q = (r.data.quoteResponse && r.data.quoteResponse.result) || [];
          for (const x of q) {
            const sym = String(x.symbol || '').replace(/\.NS$/i, '');
            const p = Number(x.regularMarketPrice);
            const qt = Number(x.regularMarketTime || 0) * 1000;
            if (!sym || !p || p <= 0 || !qt) continue;
            let arr = hist.get(sym);
            if (!arr) { arr = []; hist.set(sym, arr); }
            // only append if newer than the last stored sample (in-cycle dupes skipped)
            if (!arr.length || qt > arr[arr.length - 1].t) arr.push({ t: qt, p });
            while (arr.length && arr[0].t < now - HIST_MS) arr.shift();
          }
          got += q.length;
          return;
        } catch (e) {
          if (e.response && e.response.status === 401 && attempt === 0) {
            session = await ensureSession(true); // crumb expired — refresh and retry once
            continue;
          }
          return; // skip this batch this cycle
        }
      }
    };

    for (let i = 0; i < batches.length; i += CONC) {
      await Promise.all(batches.slice(i, i + CONC).map(runBatch));
    }
    _lastSweep = Date.now();
    if (process.env.MOVERS_DEBUG === '1') console.log(`[moversBoard] sweep ${got}/${uni.length} symbols in ${Date.now() - t0}ms`);
  } finally { _sweeping = false; }
}

// ---------- move computation ----------
function refPrice(arr, windowMs, now) {
  // price at (or just before) now - window
  const target = now - windowMs;
  let best = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= target) { best = arr[i]; break; }
  }
  if (!best && arr.length) best = arr[0];      // window spans history start — use oldest
  if (!best) return null;
  if (now - best.t > (windowMs + 120e3)) return null; // no sample near the window — refuse
  return best.p;
}

function pct(a, b) { return (a != null && b > 0) ? +(((a - b) / b) * 100).toFixed(2) : null; }

function buildBoard() {
  const uni = loadUniverse();
  const meta = new Map(uni.map(u => [u.symbol, u]));
  const now = Date.now();
  const stocks = [];
  for (const [sym, arr] of hist) {
    if (!arr.length) continue;
    const m = meta.get(sym);
    const ltp = arr[arr.length - 1].p;
    if (ltp < MIN_PRICE) continue;
    const stale = (now - arr[arr.length - 1].t) / 1000 > STALE_SEC;
    const m1 = pct(ltp, refPrice(arr, 60000, now));
    const m2 = pct(ltp, refPrice(arr, 120000, now));
    const m5 = pct(ltp, refPrice(arr, 300000, now));
    if (m1 == null && m2 == null && m5 == null) continue;
    // trail: direction of the last 5 stored samples
    const trail = [];
    for (let i = Math.max(1, arr.length - 5); i < arr.length; i++) trail.push(arr[i].p >= arr[i - 1].p ? 'up' : 'down');
    const isMover = !stale && [m1, m2, m5].some(v => v != null && Math.abs(v) >= MOVER_TH);
    const bestMove = Math.max(Math.abs(m1 || 0), Math.abs(m2 || 0), Math.abs(m5 || 0));
    stocks.push({ symbol: sym, engine: m ? m.engine : null, score: m ? m.score : null, time: new Date(now).toISOString(), ltp, m1, m2, m5, mDay: null, trail, isMover, stale, bestMove });
  }
  // movers first, biggest move first; then the rest by best move. Stale rows sink.
  stocks.sort((a, b) => (a.stale - b.stale) || (b.isMover - a.isMover) || (b.bestMove - a.bestMove));
  for (const s of stocks) delete s.bestMove;
  const movers = stocks.filter(s => s.isMover).length;
  const out = { generatedAt: new Date(now).toISOString(), marketOpen: true, movers, stocks, universe: uni.length, swept: hist.size };
  try { fs.writeFileSync(MOVERS_FILE, JSON.stringify(out)); } catch (_) {}
  return { stocks: stocks.length, movers };
}

// ---------- public API ----------
async function scanMovers() {
  const marketOpen = isMarketOpenNow();
  if (!marketOpen) return { stocks: 0, movers: 0, closed: true };
  if (Date.now() - _lastSweep >= CYCLE_MS) await sweep().catch(() => {});
  return buildBoard();
}

function isMarketOpenNow(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const day = ist.getDay();
  return day >= 1 && day <= 5 && mins >= 555 && mins < 915;
}

function getMovers({ onlyMovers = false, minMove = 0 } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(MOVERS_FILE, 'utf8'));
    let stocks = j.stocks || [];
    if (onlyMovers) stocks = stocks.filter(s => s.isMover);
    if (minMove > 0) stocks = stocks.filter(s => Math.abs(s.m1 || 0) >= minMove || Math.abs(s.m2 || 0) >= minMove || Math.abs(s.m5 || 0) >= minMove);
    return { generatedAt: j.generatedAt, marketOpen: j.marketOpen, movers: j.movers, universe: j.universe, swept: j.swept, stocks };
  } catch (_) { return { generatedAt: null, stocks: [] }; }
}

module.exports = { scanMovers, getMovers, sweep, isMarketOpenNow };
