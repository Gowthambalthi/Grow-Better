/**
 * gb_scoring_v2/orderflow/tickCapture.js — PHASE 1: RAW TICK CAPTURE.
 *
 * The plan's first line is the one that matters: "nothing works without this", and its milestone
 * check is equally blunt — "verify tick capture doesn't drop ticks and timestamps are monotonic.
 * This is boring but if it's wrong everything above it is wrong silently."
 *
 * So this module is deliberately dumb: it stores what arrives, it counts what it cannot store,
 * and it never interprets. Everything interpretive (aggressor side, delta, POC) lives above it.
 *
 * WHY IT EXISTS AT ALL, given tickBoard already keeps a tick ring. tickBoard keeps ONLY
 * {t, p, bq, sq} — the fields the fast ladder needs. The order-flow layers need the fields it
 * throws away: last-traded QUANTITY (VWAP and footprint weight), volume traded today (bar volume
 * without needing a second REST call) and, when the feed carries them, best bid/ask. And they
 * need them tomorrow: tickBoard's ring is RAM and dies with the process, while replay validation
 * (Phase 8) requires the day's tape to still be on disk. So capture is a superset store plus a
 * JSONL append log, fed by the same socket rather than a second subscription (Angel charges a
 * socket, and the board is already at the 3-socket cap).
 *
 * TIMESTAMP DISCIPLINE. `exchangeTimestamp` is the exchange's own stamp; wall clock is only a
 * fallback for a payload that omits it (and each fallback is COUNTED, never silent). A tick whose
 * stamp is older than the token's last is recorded as an out-of-order violation and REJECTED for
 * the layers, because "the price 20 seconds ago" computed from a shuffled buffer is not a late
 * number, it is a wrong one.
 */
const fs = require('fs');
const path = require('path');

// GB_ORDERFLOW_DIR lets a test (or a replay analysis run) point the engine at its own directory,
// so the session's captured tape never contains a synthetic symbol.
const DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');
const RING_MAX = 20000;          // per token: ~25 min at 12 ticks/s, plenty for a 15m frame
const FLUSH_MS = 1000;           // append cadence: one second of ticks per write
const MAX_LINE_BYTES = 400;

const rings = new Map();         // token -> [{t, p, q, bq, sq, v}]
const meta = new Map();          // token -> symbol
const pending = [];              // buffered JSONL lines awaiting the flush
let flushTimer = null;
let _file = null;                // resolved lazily so the date rollover is picked up mid-run

const stats = {
  startedAt: null,
  received: 0,
  stored: 0,
  droppedNoPrice: 0,
  droppedOutOfOrder: 0,
  droppedNoToken: 0,
  wallClockFallbacks: 0,
  tokens: 0,
  lastTickAt: null,
  lastFlushAt: null,
  flushed: 0,
  flushErrors: 0,
  lastFlushError: null,
  file: null,
};

function dayKey(ts = Date.now()) {
  // IST session day: a 00:30 IST tick belongs to that day, not to the previous UTC one.
  const d = new Date(ts + 330 * 60000);
  return d.toISOString().slice(0, 10);
}

function fileFor(ts) {
  const want = path.join(DIR, 'ticks-' + dayKey(ts) + '.jsonl');
  if (_file === want) return _file;
  // DATE ROLLOVER: a process that runs past midnight must start a new file rather than append a
  // new session to yesterday's — mixing two sessions makes every per-session statistic wrong.
  if (_file) console.log('[orderflow/capture] tick log rolling over to ' + path.basename(want));
  _file = want;
  stats.file = want;
  return want;
}

/**
 * record(tick, symbol) — one exchange tick. Accepts the marketFeed payload shape directly
 * (`token`, `lastTradedPrice`, `lastTradedQuantity`, `exchangeTimestamp`, `totalBuyQuantity`,
 * `totalSellQuantity`, `volumeTradedToday`) so the caller never has to reshape it.
 * Returns the stored row, or null when the tick was rejected (and counted why).
 */
function record(tick, symbol) {
  if (!tick || tick.token == null) { stats.droppedNoToken++; return null; }
  stats.received++;
  const token = String(tick.token);
  const p = Number(tick.lastTradedPrice);
  if (!(p > 0)) { stats.droppedNoPrice++; return null; }

  let ts = Number(tick.exchangeTimestamp) || 0;
  if (!(ts > 0)) { ts = Date.now(); stats.wallClockFallbacks++; }

  const arr = rings.get(token);
  const last = arr && arr.length ? arr[arr.length - 1] : null;
  if (last && ts < last.t) {
    // Out of order. Kept in the counters, refused by the store: a reshuffled buffer makes every
    // lookback ("what did this trade at 20s ago") answer with the wrong print.
    stats.droppedOutOfOrder++;
    return null;
  }
  if (last && ts === last.t && last.p === p) return null;   // true duplicate, not a violation

  const row = {
    t: ts,
    p,
    q: Number(tick.lastTradedQuantity) || 0,
    bq: Number(tick.totalBuyQuantity) || 0,
    sq: Number(tick.totalSellQuantity) || 0,
    v: Number(tick.volumeTradedToday) || 0,
  };
  if (!arr) { rings.set(token, [row]); stats.tokens = rings.size; }
  else {
    arr.push(row);
    if (arr.length > RING_MAX) arr.splice(0, arr.length - RING_MAX);
  }
  if (symbol) meta.set(token, String(symbol).replace(/-EQ$/i, '').toUpperCase());

  stats.stored++;
  stats.lastTickAt = Date.now();
  if (!stats.startedAt) stats.startedAt = new Date().toISOString();

  // queue the durable line (bounded: a runaway socket can never grow this without bound)
  //
  // bq/sq ARE WRITTEN, and that is not padding: without them a day rebuilt from disk could only ever
  // be classified by the tick rule while the same day's LIVE rows were classified by the exchange's own
  // quantity pair, so a historical footprint would disagree with the live one it is supposed to explain.
  // WHAT THEY MEAN IS NOT SETTLED HERE. `totalBuyQuantity`/`totalSellQuantity` read either as cumulative
  // TRADED quantity split by aggressor side (then the per-tick increment is a genuine footprint) or as
  // the RESTING quantity at the bid vs the ask (then the increment is a book-imbalance proxy and NOT an
  // executed side — see footprint.js item 2). No aggressor field exists in the packet at any mode; the
  // pair's semantics are decided on the first captured session by `.freebuff/verify-bqsq.js`, which is
  // what keeps this file from quietly implying an executed side it may not have.
  if (pending.length < 50000) {
    pending.push(JSON.stringify({ t: ts, s: meta.get(token) || token, p, q: row.q, v: row.v, bq: row.bq, sq: row.sq }) + '\n');
  }
  return row;
}

function flush() {
  if (!pending.length) return 0;
  const batch = pending.splice(0, pending.length).join('');
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(Date.now()), batch);
    stats.flushed++;
    stats.lastFlushAt = new Date().toISOString();
    return batch.length;
  } catch (e) {
    // NOT SILENT. Losing captured tape is the one failure that invalidates replay validation
    // later, so it is reported (throttled by the caller's 1s cadence).
    stats.flushErrors++;
    stats.lastFlushError = (e && e.message) || String(e);
    console.log('[orderflow/capture] tick log write failed:', stats.lastFlushError);
    return 0;
  }
}

/** start() — arms the 1s append timer. Idempotent. */
function start() {
  if (flushTimer) return true;
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {
    console.log('[orderflow/capture] cannot create ' + DIR + ':', (e && e.message) || String(e));
  }
  flushTimer = setInterval(() => { try { flush(); } catch (e) { console.log('[orderflow/capture] flush threw:', (e && e.message) || String(e)); } }, FLUSH_MS);
  console.log('[orderflow/capture] armed — ticks append to data/orderflow/ticks-<day>.jsonl every 1s');
  return true;
}

function stop() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flush();
}

/** ticks(token) — the captured rows for one token, oldest first (read-only intent). */
function ticks(token) { return rings.get(String(token)) || []; }

/** symbolOf(token) / tokenOf(symbol) — the two-way index the layers need. */
function symbolOf(token) { return meta.get(String(token)) || null; }
function tokenOf(symbol) {
  const want = String(symbol).replace(/-EQ$/i, '').toUpperCase();
  for (const [tok, sym] of meta) if (sym === want) return tok;
  return null;
}

/**
 * quality() — Phase 1's milestone check as a number.
 * `monotonic` is the headline: it must stay true. `coverage` is the share of received ticks that
 * made it into the store, so a feed that starts sending junk shows up as a falling ratio rather
 * than as a quietly thinner fingerprint.
 */
function quality() {
  const now = Date.now();
  return {
    uptimeMs: stats.startedAt ? now - Date.parse(stats.startedAt) : 0,
    received: stats.received,
    stored: stats.stored,
    tokens: rings.size,
    dropped: {
      noPrice: stats.droppedNoPrice,
      outOfOrder: stats.droppedOutOfOrder,
      noToken: stats.droppedNoToken,
    },
    monotonic: stats.droppedOutOfOrder === 0,
    coverage: stats.received ? +(stats.stored / stats.received).toFixed(4) : null,
    wallClockFallbacks: stats.wallClockFallbacks,
    lastTickAt: stats.lastTickAt ? new Date(stats.lastTickAt).toISOString() : null,
    tickAgeMs: stats.lastTickAt ? now - stats.lastTickAt : null,
    lastFlushAt: stats.lastFlushAt,
    flushes: stats.flushed,
    flushErrors: stats.flushErrors,
    lastFlushError: stats.lastFlushError,
    file: stats.file,
    ringMax: RING_MAX,
  };
}

function reset() { rings.clear(); meta.clear(); pending.length = 0; }

module.exports = { record, start, stop, flush, ticks, symbolOf, tokenOf, quality, reset, stats, rings, RING_MAX };
