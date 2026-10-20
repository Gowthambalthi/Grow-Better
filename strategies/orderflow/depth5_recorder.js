#!/usr/bin/env node
/**
 * orderflow/depth5_recorder.js -- Standalone depth recorder.
 *
 * Records the full best-5 order book per symbol to data/orderflow/depth5-YYYY-MM-DD.jsonl
 * (IST date).
 *
 * It accepts the same tick shape that angelone/marketFeed.js produces in SNAP_QUOTE mode:
 *   { token, exchangeTimestamp, lastTradedPrice, volumeTradedToday, totalBuyQuantity,
 *     totalSellQuantity, bestBids:[{flag,quantity,price,orders}...], bestAsks:[...] }
 *
 * ORIENTATION IS DECIDED FROM PRICES, NOT FROM FLAGS:
 *     o:"n"  groups arrived as labelled (bestBids = lower prices)
 *     o:"s"  groups arrived swapped (bestBids held the higher prices)
 *     o:"x"  overlapping / locked / one side empty (auction, halt): raw groups kept as g1, g2
 *
 * Line format (prices in INR; levels best first):
 *   {"t":ms,"s":"HDFCBANK","p":706.2,"v":6937271,"bq":..,"sq":..,"o":"s",
 *    "B":[[price,qty,orders],...<=5],"A":[[price,qty,orders],...<=5]}
 *
 * Volume control: a snapshot is written only if the book changed AND at least
 * minIntervalMs (default 500) passed for that symbol.
 */
const fs = require('fs');
const path = require('path');

const IST_MS = 5.5 * 3600 * 1000;
const PENDING_MAX = 100000;

function istDate(ts) {
  return new Date(ts + IST_MS).toISOString().slice(0, 10);
}

function levels(group) {
  const out = [];
  for (const e of Array.isArray(group) ? group : []) {
    const price = Number(e && e.price), qty = Number(e && e.quantity);
    if (price > 0 && qty >= 0) out.push([price, qty, Number(e.numOrders != null ? e.numOrders : e.orders) || 0]);
  }
  return out;
}

/** Returns { o, B, A } or { o:'x', g1, g2 }. */
function orient(g1raw, g2raw) {
  const g1 = levels(g1raw), g2 = levels(g2raw);
  if (!g1.length || !g2.length) return { o: 'x', g1, g2 };
  const max1 = Math.max(...g1.map((l) => l[0])), min1 = Math.min(...g1.map((l) => l[0]));
  const max2 = Math.max(...g2.map((l) => l[0])), min2 = Math.min(...g2.map((l) => l[0]));
  if (max1 < min2) {      // g1 lower => g1 are bids (labels normal)
    return { o: 'n', B: g1.sort((a, b) => b[0] - a[0]), A: g2.sort((a, b) => a[0] - b[0]) };
  }
  if (max2 < min1) {      // g2 lower => g2 are bids (labels swapped)
    return { o: 's', B: g2.sort((a, b) => b[0] - a[0]), A: g1.sort((a, b) => a[0] - b[0]) };
  }
  return { o: 'x', g1, g2 };
}

function createDepthRecorder(opts = {}) {
  const dir = opts.dir || path.join(__dirname, '..', '..', 'data', 'orderflow');
  const minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : 500;
  const meta = new Map();            // token -> symbol
  const last = new Map();            // token -> { t, key }
  const stats = { received: 0, written: 0, unchanged: 0, throttled: 0, noDepth: 0,
                  orient: { n: 0, s: 0, x: 0 }, droppedBackpressure: 0 };
  let pending = [], stream = null, streamDay = null;

  function open(day) {
    if (stream) stream.end();
    fs.mkdirSync(dir, { recursive: true });
    stream = fs.createWriteStream(path.join(dir, `depth5-${day}.jsonl`), { flags: 'a' });
    streamDay = day;
  }

  function flush() {
    if (!pending.length) return;
    const batch = pending; pending = [];
    for (const [day, line] of batch) {
      if (day !== streamDay) open(day);
      stream.write(line);
    }
  }
  const timer = setInterval(flush, 1000);
  if (timer.unref) timer.unref();

  function record(tick, symbol) {
    if (!tick || tick.token == null) return null;
    stats.received++;
    const token = String(tick.token);
    if (symbol) meta.set(token, String(symbol).replace(/-EQ$/i, '').toUpperCase());
    if (!tick.bestBids && !tick.bestAsks) { stats.noDepth++; return null; }
    const ts = Number(tick.exchangeTimestamp) || Date.now();
    const book = orient(tick.bestBids, tick.bestAsks);
    stats.orient[book.o]++;
    const body = book.o === 'x' ? { g1: book.g1, g2: book.g2 } : { B: book.B, A: book.A };
    const key = JSON.stringify(body);
    const prev = last.get(token);
    if (prev && prev.key === key) { stats.unchanged++; return null; }
    if (prev && ts - prev.t < minIntervalMs) { stats.throttled++; return null; }
    last.set(token, { t: ts, key });
    const line = JSON.stringify({
      t: ts, s: meta.get(token) || token, p: Number(tick.lastTradedPrice) || 0,
      v: Number(tick.volumeTradedToday) || 0, bq: Number(tick.totalBuyQuantity) || 0,
      sq: Number(tick.totalSellQuantity) || 0, o: book.o, ...body }) + '\n';
    if (pending.length >= PENDING_MAX) { stats.droppedBackpressure++; return null; }
    pending.push([istDate(ts), line]);
    stats.written++;
    return line;
  }

  function attach(feed, eventName = 'tick') {
    if (!feed || typeof feed.on !== 'function') throw new Error('feed has no .on(); call record() manually');
    feed.on(eventName, (tick) => record(tick, tick && (tick.symbol || null)));
  }

  function close() { clearInterval(timer); flush(); if (stream) stream.end(); }
  return { record, attach, flush, close, stats: () => ({ ...stats, orient: { ...stats.orient } }) };
}

module.exports = { createDepthRecorder, orient, istDate };

if (require.main === module && process.argv.includes('--selftest')) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depth5-'));
  const rec = createDepthRecorder({ dir, minIntervalMs: 0 });
  const mk = (arr) => arr.map(([price, quantity, orders], i) => ({ flag: 0, price, quantity, orders }));
  const t0 = Date.UTC(2026, 9, 7, 5, 30);           // 11:00 IST
  const swapped = {                                   // like your HDFCBANK lines: bestBids hold the HIGHER prices
    token: '1333', exchangeTimestamp: t0, lastTradedPrice: 706.2, volumeTradedToday: 1000,
    totalBuyQuantity: 10, totalSellQuantity: 20,
    bestBids: mk([[706.20, 569, 3], [706.25, 800, 4], [706.30, 120, 2], [706.35, 90, 1], [706.40, 60, 1]]),
    bestAsks: mk([[706.15, 194, 2], [706.10, 300, 2], [706.05, 150, 1], [706.00, 75, 1], [705.95, 50, 1]]),
  };
  const normal = { ...swapped, token: '2', exchangeTimestamp: t0 + 1000, bestBids: swapped.bestAsks, bestAsks: swapped.bestBids };
  const crossed = { ...swapped, token: '3', exchangeTimestamp: t0 + 2000,
                    bestBids: mk([[100, 1, 1], [99, 1, 1]]), bestAsks: mk([[99.5, 1, 1]]) };
  rec.record(swapped, 'HDFCBANK-EQ'); rec.record(swapped, 'HDFCBANK-EQ');     // 2nd = unchanged
  rec.record(normal, 'TESTN-EQ'); rec.record(crossed, 'TESTX-EQ');
  rec.close();
  setTimeout(() => {
    const f = path.join(dir, 'depth5-2026-10-07.jsonl');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
    const h = lines.find((l) => l.s === 'HDFCBANK'), n = lines.find((l) => l.s === 'TESTN');
    const ok = lines.length === 3 && h.o === 's' && h.B[0][0] === 706.15 && h.A[0][0] === 706.2 &&
               n.o === 'n' && n.B[0][0] === 706.15 && lines.find((l) => l.s === 'TESTX').o === 'x';
    console.log(ok ? 'SELFTEST PASS' : 'SELFTEST FAIL', JSON.stringify(rec.stats()));
    console.log('sample:', JSON.stringify(h));
    process.exit(ok ? 0 : 1);
  }, 300);
}
