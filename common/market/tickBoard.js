/**
 * common/market/tickBoard.js — TICK-LEVEL movers board (Angel One WebSocket).
 *
 * WHY: Yahoo quotes are delayed and per-symbol. During market hours the
 * board must run on real exchange ticks with zero added delay. Angel One's
 * SmartAPI WebSocket allows up to 3,000 instruments across connections —
 * enough for the whole 2,934-stock universe in 3 sockets of ~1,000 tokens.
 *
 * Source policy (strict, per user):
 *   - Market hours (09:15-15:15 IST, Mon-Fri): Angel One ticks ONLY.
 *     Yahoo is never consulted — its delay would fake "live" moves.
 *   - Outside market hours: no live board at all (the Yahoo moversBoard
 *     continues to serve its last swept snapshot for off-hours viewing).
 *
 * Windows: 10s / 20s / 30s / 1m / 3m / 5m — computed from each symbol's
 * rolling tick buffer (8 min retention) at read time.
 *
 * Tick semantics (exchange trade feed): if a stock has not traded inside
 * a window, its price HAS NOT CHANGED — the reference price is simply the
 * last tick at or before (now - window). A move is only null when the
 * buffer doesn't reach back far enough (symbol started trading recently
 * or was just subscribed).
 *
 * Feed-level staleness: if NO token has ticked for 45s, the feed itself is
 * presumed dead and every row is flagged stale:true (never shown as live).
 */
const fs = require('fs');
const path = require('path');
const { AngelMarketFeed, MODE, EXCHANGE_TYPE } = require('../../angelone/marketFeed');
const angelAuth = require('../../angelone/auth');
const angelInstruments = require('../instruments/angelInstruments');

const DATA = path.join(__dirname, '..', '..', 'data');
const BOARD_FILE = path.join(DATA, 'live_tick_movers.json');
const UNIVERSE_FILE = path.join(DATA, 'nse_universe_3000.txt');

const MIN_PRICE = 100;
const MOVER_TH = 1.0;          // % move on any window flags a MOVER
const FEED_DEAD_MS = 45000;    // no tick at all for this long = feed dead
const HIST_MS = 8 * 60000;     // rolling tick buffer retention
const SOCKETS = 3;             // Angel allows 3 concurrent sockets
const MAX_TOKENS_PER_SOCKET = 1000;

const WINDOWS = [
  { key: 's10', ms: 10000 },
  { key: 's20', ms: 20000 },
  { key: 's30', ms: 30000 },
  { key: 'm1', ms: 60000 },
  { key: 'm3', ms: 180000 },
  { key: 'm5', ms: 300000 },
];

// ---------- state ----------
const buffers = new Map();     // token -> [{t, p}]
const tokenToSym = new Map();  // token -> {symbol, engine, score}
const closes = new Map();      // token -> prev close (for day %)
let feeds = [];
let running = false;
let starting = null;           // in-flight start promise
let lastTickAt = 0;

function isMarketOpenNow(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const day = ist.getDay();
  return day >= 1 && day <= 5 && mins >= 555 && mins < 915;
}

// ---------- startup ----------
async function start(opts = {}) {
  if (running) return true;
  if (starting) return starting;
  starting = (async () => {
    try {
      // 1. session
      let session = opts.session;
      if (!session || !session.jwtToken) {
        const authRes = await angelAuth.login();
        session = authRes && authRes.session;
      }
      if (!session || !session.jwtToken) { console.error('[tickBoard] no Angel session — board disabled'); return false; }

      // 2. tokens for the universe
      await angelInstruments.refresh().catch(() => {});
      const uni = loadUniverse();
      const resolved = []; // [{token, symbol, engine, score, close}]
      for (const u of uni) {
        const rec = angelInstruments.findEquity(u.symbol);
        if (!rec || !rec.token) continue;
        resolved.push({ token: String(rec.token), symbol: u.symbol, engine: u.engine, score: u.score });
      }
      if (!resolved.length) { console.error('[tickBoard] zero tokens resolved — board disabled'); return false; }
      console.log(`[tickBoard] resolved ${resolved.length}/${uni.length} symbols to Angel tokens`);

      // 3. sockets
      const per = Math.ceil(resolved.length / SOCKETS);
      for (let s = 0; s < SOCKETS; s++) {
        const slice = resolved.slice(s * per, (s + 1) * per);
        if (!slice.length) break;
        const feed = new AngelMarketFeed(session);
        feed.on('tick', (t) => onTick(t));
        feed.on('error', (e) => console.error('[tickBoard] feed error:', e.message));
        for (const r of slice) { tokenToSym.set(r.token, r); buffers.set(r.token, []); }
        feed.connect();
        feeds.push(feed);
        // subscribe in chunks of 200 tokens once open
        feed.once('open', () => {
          for (let i = 0; i < slice.length; i += 200) {
            feed.subscribe(`tb${s}`, MODE.QUOTE, [{ exchangeType: EXCHANGE_TYPE.NSE_CM, tokens: slice.slice(i, i + 200).map(r => r.token) }]);
          }
          console.log(`[tickBoard] socket ${s + 1}/${SOCKETS}: subscribed ${slice.length} tokens`);
        });
        await new Promise(res => setTimeout(res, 10000 * (s + 1))); // Angel rate-limits socket opens — stagger hard
      }
      running = true;
      // periodic board build
      if (!buildTimer) buildTimer = setInterval(() => { buildBoard().catch(() => {}); }, 5000);
      return true;
    } finally { starting = null; }
  })();
  return starting;
}

let buildTimer = null;

function stop() {
  for (const f of feeds) { try { f.close(); } catch (_) {} }
  feeds = [];
  running = false;
  if (buildTimer) { clearInterval(buildTimer); buildTimer = null; }
}

function onTick(t) {
  if (!t || t.token == null) return;
  lastTickAt = Date.now();
  const arr = buffers.get(String(t.token));
  if (!arr) return;
  const p = t.lastTradedPrice;
  if (!p || p <= 0) return;
  if (t.close) closes.set(String(t.token), t.close);
  const ts = t.exchangeTimestamp || Date.now(); // Angel sends epoch ms
  const last = arr[arr.length - 1];
  if (last && last.t >= ts && last.p === p) return; // duplicate
  arr.push({ t: ts, p });
  while (arr.length && arr[0].t < Date.now() - HIST_MS) arr.shift();
}

function loadUniverse() {
  const map = new Map();
  try {
    const txt = fs.readFileSync(UNIVERSE_FILE, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim().toUpperCase();
      if (s && /^[A-Z0-9&_-]+$/.test(s)) map.set(s, { symbol: s, engine: null, score: null });
    }
  } catch (_) {}
  try {
    const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
    for (const r of es.results || []) {
      const s = String(r.symbol || '').replace(/-EQ$/i, '').toUpperCase();
      if (map.has(s)) { map.get(s).engine = r.winningEngine; map.get(s).score = r.engineRate; }
    }
  } catch (_) {}
  return [...map.values()];
}

// ---------- board ----------
function refPrice(arr, ms, now) {
  const target = now - ms;
  let best = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].t <= target) { best = arr[i]; break; }
  }
  return best ? best.p : null;   // null = buffer doesn't reach this far back yet
}

function pct(a, b) { return (a != null && b > 0) ? +(((a - b) / b) * 100).toFixed(2) : null; }

async function buildBoard() {
  const now = Date.now();
  const feedDead = lastTickAt && (now - lastTickAt) > FEED_DEAD_MS;
  const stocks = [];
  for (const [token, arr] of buffers) {
    if (!arr.length) continue;
    const meta = tokenToSym.get(token) || {};
    const ltp = arr[arr.length - 1].p;
    if (ltp < MIN_PRICE) continue;
    const row = { symbol: meta.symbol || token, engine: meta.engine, score: meta.score, ltp, time: new Date(now).toISOString(), stale: feedDead };
    let best = 0;
    for (const w of WINDOWS) {
      const ref = refPrice(arr, w.ms, now);
      const v = ref == null ? null : pct(ltp, ref);
      row[w.key] = v;
      if (v != null && Math.abs(v) > best) best = Math.abs(v);
    }
    const close = closes.get(token);
    row.mDay = close > 0 ? +(((ltp - close) / close) * 100).toFixed(2) : null;
    row.isMover = !feedDead && WINDOWS.some(w => row[w.key] != null && Math.abs(row[w.key]) >= MOVER_TH);
    row.bestMove = best;
    stocks.push(row);
  }
  // pool tag: stocks the 45-min Yahoo job marked ACTIVE rank first; DRY sink
  const pool = loadPool();
  const poolMap = new Map((pool.active || []).map(s => [s, 'active']));
  for (const s of pool.dry || []) poolMap.set(s, 'dry');
  for (const s of stocks) s.pool = poolMap.get(s.symbol) || 'active';   // no pool data yet = treat as active
  stocks.sort((a, b) => (a.stale - b.stale) || (a.pool === 'dry') - (b.pool === 'dry') ||
    (b.isMover - a.isMover) || (b.bestMove - a.bestMove));
  for (const s of stocks) delete s.bestMove;
  const activeCount = stocks.filter(s => s.pool !== 'dry').length;
  const out = {
    generatedAt: new Date(now).toISOString(),
    marketOpen: isMarketOpenNow(),
    source: 'Angel One ticks',
    feedDead,
    movers: stocks.filter(s => s.isMover).length,
    tracked: buffers.size,
    poolActive: activeCount,
    poolDry: stocks.length - activeCount,
    stocks,
  };
  try { fs.writeFileSync(BOARD_FILE, JSON.stringify(out)); } catch (_) {}
  maybePoolJob(now);
  return { stocks: stocks.length, movers: out.movers };
}

// ---------- 45-min Yahoo pool job (DELETE dry / ADD active) ----------
// Yahoo (delayed) is NEVER used for the live board. Its only job: at fixed
// times during market hours (09:45, 10:30, 11:15, 12:00, 12:45, 13:30, 14:15
// IST) sweep the whole universe and re-classify each stock:
//   ACTIVE — still moving (|Yahoo 5-min move| >= 0.4%) or ticked in the last
//            45 min on the Angel feed with meaningful volume.
//   DRY    — no Angel tick in 45 min AND |Yahoo 5-min move| < 0.2% → dropped
//            from the ranked board (rows stay available but sink + flagged).
// A stock marked DRY that later shows activity is ADDED back automatically.
const POOL_TIMES_MIN = [585, 630, 675, 720, 765, 810, 855]; // 09:45..14:15 IST
const POOL_FILE = path.join(DATA, 'movers_pool.json');
let _lastPoolKey = null;

function istNow(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  return { mins: ist.getHours() * 60 + ist.getMinutes(), day: ist.getDay(), time: `${String(ist.getHours()).padStart(2, '0')}:${String(ist.getMinutes()).padStart(2, '0')}` };
}

function maybePoolJob(now) {
  if (!running) return;
  const { mins, day, time } = istNow(new Date(now));
  const key = `${new Date(now).toISOString().slice(0, 10)}:${mins}`;
  if (day < 1 || day > 5) return;
  if (!POOL_TIMES_MIN.includes(mins) || _lastPoolKey === key) return;
  _lastPoolKey = key;
  poolJob(time).catch(e => console.error('[tickBoard] pool job error:', e.message));
}

async function poolJob(atTime) {
  const moversBoard = require('./moversBoard');
  console.log(`[tickBoard] 45-min pool job @ ${atTime} IST — sweeping Yahoo for dry/active classification`);
  await moversBoard.sweep();            // batched Yahoo quotes, whole universe
  const yb = moversBoard.getMovers({});
  const yMap = new Map((yb.stocks || []).map(s => [s.symbol, s]));
  const now = Date.now();
  const active = [], dry = [];
  for (const [token, arr] of buffers) {
    const meta = tokenToSym.get(token) || {};
    const sym = meta.symbol || token;
    const lastTickAge = arr.length ? (now - arr[arr.length - 1].t) / 60000 : Infinity; // minutes
    const y = yMap.get(sym);
    const yMove = Math.max(Math.abs(y && y.m1 || 0), Math.abs(y && y.m5 || 0));
    const isActive = (lastTickAge <= 45 && yMove >= 0.2) || yMove >= 0.4;
    (isActive ? active : dry).push(sym);
  }
  const pool = { at: new Date(now).toISOString(), jobTime: atTime, activeCount: active.length, dryCount: dry.length, active, dry };
  try { fs.writeFileSync(POOL_FILE, JSON.stringify(pool)); } catch (_) {}
  console.log(`[tickBoard] pool job done: ${active.length} active / ${dry.length} dry`);
  return pool;
}

function loadPool() {
  try {
    const j = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    // pool older than 2 hours or from a previous day: ignore (everything active)
    if (!j.at || Date.now() - new Date(j.at).getTime() > 2 * 3600e3) return {};
    return j;
  } catch (_) { return {}; }
}

function getBoard({ onlyMovers = false, minMove = 0 } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8'));
    let stocks = j.stocks || [];
    if (onlyMovers) stocks = stocks.filter(s => s.isMover);
    if (minMove > 0) stocks = stocks.filter(s => WINDOWS.some(w => s[w.key] != null && Math.abs(s[w.key]) >= minMove));
    return { ...j, stocks };
  } catch (_) { return { generatedAt: null, stocks: [] }; }
}

module.exports = { start, stop, buildBoard, getBoard, isMarketOpenNow, poolJob, WINDOWS };
