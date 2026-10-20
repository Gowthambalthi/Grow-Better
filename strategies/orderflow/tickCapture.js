/**
 * orderflow/tickCapture.js — PHASE 1: RAW TICK CAPTURE.
 *
 * Ported into the live tree from gb_scoring_v2 (which was deleted). Deliberately
 * dumb: it stores what arrives, counts what it cannot store, and never
 * interprets. Everything interpretive — aggressor side, delta, POC — lives above
 * it (see backtest/eventMicro.js).
 *
 * WHY IT EXISTS. The order-flow research is now gated on sub-minute tape that
 * only this layer can produce: 10s/20s/30s deltas are meaningless on a
 * 1-minute bar. The existing tapes (data/orderflow/ticks-2026-09-28..10-01) are
 * a FIXED four-session window written by the old stack, so the CHANGE condition
 * can never be validated out of sample unless capture runs again.
 *
 * THE LINE FORMAT MATCHES THE EXISTING TAPES exactly:
 *   {t (epoch ms), s (symbol), p, q, v, bq, sq}
 * so backtest/eventMicro.js reads new sessions without any change.
 * SNAP_QUOTE (forward capture) ADDITIONALLY stores best-5 level-1 prices when the
 * feed provides them: bid, bidq, ask, askq. Historical tapes simply lack those
 * keys; readers that ignore unknown keys are unaffected; OF-1 explicitly strips
 * them (research/pipeline/of1_record.py) so its proxy delta never changes.
 *
 * REQUIRED SUBSCRIPTION MODE. Angel's feed only parses `lastTradedQuantity`,
 * `volumeTradedToday`, `totalBuyQuantity` and `totalSellQuantity` when the
 * subscription mode is QUOTE (2) or SNAP_QUOTE (3). In LTP mode (1) a tick has
 * no quantity at all, which would make every stored `q` zero and every delta
 * unusable — see angelone/marketFeed.js `_parseBinary`. Capture therefore
 * subscribes in QUOTE mode, on its own correlation id, so it cannot disturb the
 * existing index feed.
 *
 * TIMESTAMP DISCIPLINE. `exchangeTimestamp` is the exchange's own stamp; wall
 * clock is only a fallback for a payload that omits it (and each fallback is
 * COUNTED, never silent). A tick older than the token's last is recorded as an
 * out-of-order violation and REJECTED, because "the price 20 seconds ago"
 * computed from a shuffled buffer is not a late number, it is a wrong one.
 *
 * OFF BY DEFAULT. The caller (Server.js) only arms this when GB_TICK_CAPTURE=1.
 */
const fs = require('fs');
const path = require('path');

// GB_ORDERFLOW_DIR lets a test (or a replay run) point the store at its own
// directory, so a captured session never contains a synthetic symbol.
const DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');
// MEMORY BUDGET. The original 20000 rows/token is ~25 min at 12 ticks/s, which is
// correct for the ladder this was written for — but at ~150 bytes/row and the
// board's ~254 symbols it reaches ~750 MB, past the 500 MB pm2 restart guard. The
// research needs ~2 minutes either side of an event, so 1500 rows (~2 min at
// 12 ticks/s) is both sufficient and cheap. Override with GB_ORDERFLOW_RING_MAX.
const RING_MAX = Math.max(100, Number(process.env.GB_ORDERFLOW_RING_MAX) || 1500);
const FLUSH_MS = 1000;           // append cadence: one second of ticks per write

const rings = new Map();         // symbol -> [{t, p, q, bq, sq, v}]
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
  depthSideSwaps: 0,             // rows whose bid/ask arrived inverted and were re-oriented
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
  // DATE ROLLOVER: a process that runs past midnight must start a new file rather
  // than append a second session to yesterday's — mixing sessions makes every
  // per-session statistic wrong.
  if (_file) console.log('[orderflow/capture] tick log rolling over to ' + path.basename(want));
  _file = want;
  stats.file = want;
  return want;
}

/**
 * register(token, symbol) — pre-seed the token→symbol index, so the stored line
 * carries a real symbol from the first tick rather than a numeric token.
 */
function register(token, symbol) {
  if (token == null || !symbol) return false;
  meta.set(String(token), String(symbol).replace(/-EQ$/i, '').toUpperCase());
  return true;
}

/**
 * orientLevel1(bidP, bidQ, askP, askQ) — THE ONE INVARIANT ABOUT THE BOOK: the bid
 * is never above the ask. Everything else in this file is "store what arrives",
 * but this is corrected, because the cost of getting it wrong is invisible.
 *
 * WHY IT IS NEEDED. Angel's depth blocks arrive with their side labels reversed
 * (see angelone/marketFeed.js `_parseBest5`: flag 0 is the sell side), so the raw
 * feed hands the ASK ladder over as `bestBids`. That produces a tape where every
 * row reads bid > ask: the spread comes out negative, `ask quantity` is really the
 * BID quantity (so a big supply wall above price looks like a big bid below it),
 * and any aggressor test that trusts the names inverts the trade side. Measured on
 * 2026-10-12: 1,656,566/1,656,566 depth snapshots arrived swapped.
 *
 * Prices decide, never field names: at any instant a real book has its bid at or
 * below its ask, so if the pair is crossed the two sides are simply mislabelled
 * and are swapped back together (price AND quantity travel as one unit). Called
 * from record() before a row reaches either the ring or the file, so the persisted
 * tape is correct whichever feed-side mapping is in force - including for tapes
 * written before the parser was fixed. Returns `swapped` when it had to intervene,
 * which is counted in stats.depthSideSwaps rather than hidden.
 *
 * A missing side (QUOTE mode, or a feed that dropped one group) passes through
 * untouched: there is nothing to cross, and inventing a price would be worse than
 * leaving the field absent.
 */
function orientLevel1(bidP, bidQ, askP, askQ) {
  const bid = Number(bidP), ask = Number(askP);
  if (!(bid > 0) || !(ask > 0)) {
    return { bid: bidP, bidq: bidQ, ask: askP, askq: askQ, swapped: false };
  }
  if (bid <= ask) return { bid, bidq: bidQ, ask, askq: askQ, swapped: false };
  return { bid: ask, bidq: askQ, ask: bid, askq: bidQ, swapped: true };
}

/**
 * record(tick, symbol) — one exchange tick. Accepts the marketFeed payload shape
 * directly (`token`, `lastTradedPrice`, `lastTradedQuantity`, `exchangeTimestamp`,
 * `totalBuyQuantity`, `totalSellQuantity`, `volumeTradedToday`) so the caller
 * never has to reshape it. Returns the stored row, or null when rejected (and
 * counted why).
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
  // BEST-5 QUOTE RECORDING (SNAP_QUOTE only): level-1 bid/ask price + size.
  // Absent on QUOTE-mode feeds and on all historical tapes — stored only when
  // genuinely present, never invented.
  const bb = Array.isArray(tick.bestBids) && tick.bestBids[0] ? tick.bestBids[0] : null;
  const ba = Array.isArray(tick.bestAsks) && tick.bestAsks[0] ? tick.bestAsks[0] : null;
  if (bb && Number(bb.price) > 0) { row.bid = Number(bb.price); row.bidq = Number(bb.quantity) || 0; }
  if (ba && Number(ba.price) > 0) { row.ask = Number(ba.price); row.askq = Number(ba.quantity) || 0; }
  // ORIENT BEFORE THE ROW LEAVES THIS FUNCTION, so the ring, the JSONL line and
  // every live onRow consumer (armCapture → sweep-fvg, liveMinuteEngine) all see
  // the same correctly-signed book. Correcting only one of the three would leave a
  // live strategy trading a book the replay then disagrees with.
  if (row.bid != null && row.ask != null) {
    const o = orientLevel1(row.bid, row.bidq, row.ask, row.askq);
    if (o.swapped) {
      row.bid = o.bid; row.bidq = o.bidq; row.ask = o.ask; row.askq = o.askq;
      stats.depthSideSwaps++;
    }
  }
  if (!arr) { rings.set(token, [row]); stats.tokens = rings.size; }
  else {
    arr.push(row);
    if (arr.length > RING_MAX) arr.splice(0, arr.length - RING_MAX);
  }
  if (symbol) meta.set(token, String(symbol).replace(/-EQ$/i, '').toUpperCase());

  // THE RETURNED ROW MUST CARRY ITS SYMBOL.
  //
  // The persisted JSONL line has always included `s`, and a consumer that reads the TAPE therefore
  // always had it. The in-memory row did not. That asymmetry is invisible to the offline parity
  // harness — which reads the file, so `row.s` is present and everything agrees — but a LIVE
  // consumer is handed the in-memory object through armCapture's `onRow` hook, finds
  // `row.s === undefined`, and returns on every single tick. The scoreboard then shows zero bars
  // and zero signals, which is indistinguishable from a quiet market rather than a broken wire.
  // OrderedFlow/f1Live routes ticks to per-symbol state by `r.s`, so the row is made
  // self-describing: the object returned here and the line written above are the same shape.
  row.s = meta.get(token) || token;

  stats.stored++;
  stats.lastTickAt = Date.now();
  if (!stats.startedAt) stats.startedAt = new Date().toISOString();

  if (pending.length < 50000) {
    const line = { t: ts, s: meta.get(token) || token, p, q: row.q, v: row.v, bq: row.bq, sq: row.sq };
    if (row.bid != null) { line.bid = row.bid; line.bidq = row.bidq; }
    if (row.ask != null) { line.ask = row.ask; line.askq = row.askq; }
    pending.push(JSON.stringify(line) + '\n');
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
    // NOT SILENT. Losing captured tape is the one failure that invalidates replay
    // validation later, so it is reported (throttled by the 1s cadence).
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
  flushTimer.unref();
  console.log('[orderflow/capture] armed — ticks append to ' + DIR + ' every 1s (ring ' + RING_MAX + '/symbol)');
  return true;
}

function stop() {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  flush();
}

/** ticks(token) — the captured rows for one token, oldest first (read-only). */
function ticks(token) { return rings.get(String(token)) || []; }

function symbolOf(token) { return meta.get(String(token)) || null; }
function tokenOf(symbol) {
  const want = String(symbol).replace(/-EQ$/i, '').toUpperCase();
  for (const [tok, sym] of meta) if (sym === want) return tok;
  return null;
}

/**
 * quality() — Phase 1's milestone check as a number. `monotonic` must stay true;
 * `coverage` is the share of received ticks that made it into the store, so a feed
 * that starts sending junk shows up as a falling ratio rather than as a quietly
 * thinner tape.
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
    // Non-zero means the feed handed sides over reversed and the invariant had to
    // repair them. A healthy, correctly-parsed feed should keep this at 0.
    depthSideSwaps: stats.depthSideSwaps,
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

function reset() {
  rings.clear(); meta.clear(); pending.length = 0; _file = null;
  // The counters go too, so `reset` really is a clean slate. Only tests call
  // this, and a half-reset would make their assertions depend on file order.
  Object.assign(stats, {
    startedAt: null, received: 0, stored: 0, droppedNoPrice: 0, droppedOutOfOrder: 0,
    droppedNoToken: 0, wallClockFallbacks: 0, depthSideSwaps: 0, tokens: 0, lastTickAt: null,
    lastFlushAt: null, flushed: 0, flushErrors: 0, lastFlushError: null, file: null,
  });
}

module.exports = { record, start, stop, flush, register, ticks, symbolOf, tokenOf, quality, reset,
  orientLevel1, stats, rings, RING_MAX, DIR };
