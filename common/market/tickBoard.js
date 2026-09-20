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
  stocks.sort((a, b) => (a.stale - b.stale) || (b.isMover - a.isMover) || (b.bestMove - a.bestMove));
  for (const s of stocks) delete s.bestMove;
  const out = {
    generatedAt: new Date(now).toISOString(),
    marketOpen: isMarketOpenNow(),
    source: 'Angel One ticks',
    feedDead,
    movers: stocks.filter(s => s.isMover).length,
    tracked: buffers.size,
    stocks,
  };
  try { fs.writeFileSync(BOARD_FILE, JSON.stringify(out)); } catch (_) {}
  return { stocks: stocks.length, movers: out.movers };
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

module.exports = { start, stop, buildBoard, getBoard, isMarketOpenNow, WINDOWS };
