'use strict';

/**
 * The tick-capture path that the ORDERFLOW research now depends on.
 *
 * Two things are pinned because both fail SILENTLY and cost a whole session of
 * tape when they do:
 *   - a tick recorded in LTP mode carries no quantity, so every delta built from
 *     it would be a zero — the subscription mode is asserted, not assumed;
 *   - the stored line must carry a SYMBOL, not a token, or backtest/eventMicro.js
 *     can never join an event to its tape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// MUST be set before the module is required: tickCapture reads dir and ring size
// once, at load time. `node --test` runs this file in its own process.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'of-capture-'));
process.env.GB_ORDERFLOW_DIR = TMP;
process.env.GB_ORDERFLOW_RING_MAX = '100';

const cap = require('../strategies/orderflow/tickCapture');
const { arm, CAPTURE_CORRELATION } = require('../strategies/orderflow/armCapture');
const { MODE } = require('../angelone/marketFeed');

const tick = (over) => Object.assign({
  token: '2885',
  lastTradedPrice: 100.5,
  lastTradedQuantity: 40,
  exchangeTimestamp: 1790567100000,
  totalBuyQuantity: 1134,
  totalSellQuantity: 2477,
  volumeTradedToday: 235,
}, over || {});

// ---------------------------------------------------------------------------
// record()
// ---------------------------------------------------------------------------

test('a stored line carries the SYMBOL and the quantity fields, not a token', () => {
  cap.reset();
  cap.register('2885', 'RELIANCE');
  const row = cap.record(tick());
  assert.ok(row, 'the tick must be stored');
  assert.equal(row.q, 40, 'last traded quantity must survive — QUOTE mode is what supplies it');
  assert.equal(row.bq, 1134);
  assert.equal(row.sq, 2477);

  cap.flush();
  const file = fs.readdirSync(TMP).find((f) => f.startsWith('ticks-'));
  assert.ok(file, 'a ticks-<day>.jsonl file must exist');
  const lines = fs.readFileSync(path.join(TMP, file), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.s, 'RELIANCE', 'r.s must be a symbol — eventMicro joins events to tape on it');
  assert.equal(rec.q, 40);
  assert.ok(rec.t > 0 && rec.p > 0 && rec.v != null, 't/p/v are the fields every reader assumes');
});

test('an LTP-mode tick (no quantity fields) stores q=0 — the mode matters', () => {
  cap.reset();
  // Exactly what angelone/marketFeed produces in MODE.LTP: only price and time.
  const row = cap.record({ token: '99926000', lastTradedPrice: 22780.25, exchangeTimestamp: 1790567101000 });
  assert.ok(row);
  assert.equal(row.q, 0, 'no quantity parses in LTP mode — this is why capture subscribes in QUOTE');
  assert.equal(row.bq, 0);
  cap.stop();
});

test('out-of-order ticks are rejected and counted, and stay monotonic', () => {
  cap.reset();
  const t0 = 1790567100000;
  assert.ok(cap.record(tick({ exchangeTimestamp: t0 })));
  assert.equal(cap.record(tick({ exchangeTimestamp: t0 - 5000 })), null,
    'a tick older than the last must be refused — a reshuffled buffer is a wrong number');
  const q = cap.quality();
  assert.equal(q.dropped.outOfOrder, 1, 'the violation must be counted');
  assert.equal(q.monotonic, false, 'monotonic turns false the moment an out-of-order tick arrives');

  assert.ok(cap.record(tick({ exchangeTimestamp: t0 + 10000 })), 'the next in-order tick is still accepted');

  // THE ACTUAL MILESTONE: whatever was ACCEPTED is in order. `monotonic` only
  // says whether a violation was ever seen; the promise that matters is that no
  // reordered tick ever reached the store.
  const ts = cap.ticks('2885').map((r) => r.t);
  assert.equal(ts.length, 2, 'the refused tick never entered the ring');
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i] >= ts[i - 1], 'stored ticks must be non-decreasing');
});

test('an identical repeat is a duplicate, not a violation', () => {
  cap.reset();
  const t0 = 1790567100000;
  cap.record(tick({ exchangeTimestamp: t0 }));
  assert.equal(cap.record(tick({ exchangeTimestamp: t0 })), null);
  assert.equal(cap.quality().dropped.outOfOrder, 0, 'a true duplicate is not an ordering failure');
});

test('a missing exchange timestamp falls back to wall clock AND is counted', () => {
  cap.reset();
  const row = cap.record({ token: '1', lastTradedPrice: 50, lastTradedQuantity: 1 });
  assert.ok(row, 'the tick is still captured');
  assert.equal(cap.quality().wallClockFallbacks, 1, 'the fallback must never be silent');
});

test('the ring is capped at GB_ORDERFLOW_RING_MAX', () => {
  cap.reset();
  for (let i = 0; i < 250; i++) cap.record(tick({ exchangeTimestamp: 1790567100000 + i * 1000 }));
  const rows = cap.ticks('2885');
  assert.equal(rows.length, 100, 'ring must hold 100 rows (the env cap in this file)');
  assert.equal(rows[rows.length - 1].p, 100.5);
  cap.stop();
});

// ---------------------------------------------------------------------------
// arm()
// ---------------------------------------------------------------------------

function fakeAngel() {
  const listeners = {};
  return {
    subs: [],
    subscribeLiveAngel(tokens, opts) { this.subs.push({ tokens, opts }); },
    on(e, f) { (listeners[e] ||= []).push(f); },
    off(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    emit(e, v) { (listeners[e] || []).slice().forEach((f) => f(v)); },
    count(e) { return (listeners[e] || []).length; },
  };
}

function fakeCapture() {
  return {
    registered: [], started: 0, rows: [],
    register(token, symbol) { this.registered.push([token, symbol]); return true; },
    start() { this.started++; return true; },
    stop() { this.stopped = true; },
    record(tickObj, symbol) { this.rows.push([tickObj.token, symbol]); return true; },
  };
}

const instrumentFrom = (map) => ({
  findEquity(sym, exch) {
    const k = String(sym).toUpperCase();
    return map[k] ? { token: map[k], exch_seg: 'NSE' } : null;
  },
});

test('arm subscribes in SNAP_QUOTE mode on its own correlation id (best-5 forward)', () => {
  const angel = fakeAngel(), capture = fakeCapture();
  const h = arm({
    angel, capture,
    instrument: instrumentFrom({ RELIANCE: '2885', INFY: '1594' }),
    symbols: ['RELIANCE', 'INFY'],
  });
  assert.equal(angel.subs.length, 1);
  // Forward best-5 quote recording (OF-1 instruction section 7): SNAP_QUOTE
  // parses every QUOTE field PLUS best-bid/ask prices. LTP remains forbidden.
  assert.equal(angel.subs[0].opts.mode, MODE.SNAP_QUOTE,
    'SNAP_QUOTE parses quantity AND best-5 bid/ask prices — LTP/QUOTE alone does not record quotes');
  assert.equal(angel.subs[0].opts.correlationId, CAPTURE_CORRELATION,
    'capture must not share the index feed correlation id or it will fight over mode');
  assert.notEqual(angel.subs[0].opts.correlationId, 'sub1');
  assert.equal(capture.started, 1, 'the 1s flush timer must be armed');
  assert.equal(capture.registered.length, 2, 'tokens are registered BEFORE the first tick');
  assert.equal(h.tokens.length, 2);
  h.stop();
});

test('GB_CAPTURE_MODE=quote forces the legacy QUOTE-only subscription', () => {
  process.env.GB_CAPTURE_MODE = 'quote';
  try {
    const angel = fakeAngel(), capture = fakeCapture();
    const h = arm({
      angel, capture,
      instrument: instrumentFrom({ RELIANCE: '2885' }),
      symbols: ['RELIANCE'],
    });
    assert.equal(angel.subs[0].opts.mode, MODE.QUOTE,
      'the documented fallback must actually select QUOTE');
    h.stop();
  } finally {
    delete process.env.GB_CAPTURE_MODE;
  }
});

test('SNAP_QUOTE ticks store level-1 bid/ask; plain QUOTE ticks carry none', () => {
  cap.reset();
  cap.register('2885', 'RELIANCE');   // reset() clears the token->symbol index
  const t0 = 1790567100000;
  const withDepth = tick({
    exchangeTimestamp: t0,
    bestBids: [{ flag: 0, price: 100.4, quantity: 12, numOrders: 1 }],
    bestAsks: [{ flag: 1, price: 100.6, quantity: 9, numOrders: 1 }],
  });
  const row = cap.record(withDepth);
  assert.equal(row.bid, 100.4, 'best bid price must be stored when present');
  assert.equal(row.bidq, 12);
  assert.equal(row.ask, 100.6, 'best ask price must be stored when present');
  assert.equal(row.askq, 9);
  const plain = cap.record(tick({ exchangeTimestamp: t0 + 5000 }));
  assert.equal(plain.bid, undefined, 'no depth on the wire means NO bid/ask keys — never invented');
  assert.equal(plain.ask, undefined);
  cap.flush();
  const file = fs.readdirSync(TMP).find((f) => f.startsWith('ticks-'));
  const lines = fs.readFileSync(path.join(TMP, file), 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  assert.equal(rec.s, 'RELIANCE');
  assert.ok(rec.t > 0 && rec.p > 0 && rec.v != null,
    'the historical 6-field shape must still parse for readers of old tapes');
  cap.stop();
});

test('each tick is recorded against its SYMBOL', () => {
  const angel = fakeAngel(), capture = fakeCapture();
  const h = arm({
    angel, capture,
    instrument: instrumentFrom({ RELIANCE: '2885', INFY: '1594' }),
    symbols: ['RELIANCE', 'INFY'],
  });
  angel.emit('tick', { token: '1594', lastTradedPrice: 1400, exchangeTimestamp: 1 });
  assert.deepEqual(capture.rows, [['1594', 'INFY']]);
  h.stop();
  assert.equal(angel.count('tick'), 0, 'stop() must detach the listener');
  assert.ok(capture.stopped, 'stop() must stop the flush timer');
});

test('an unresolved symbol is skipped, not fatal', () => {
  const angel = fakeAngel(), capture = fakeCapture();
  const h = arm({
    angel, capture,
    instrument: instrumentFrom({ RELIANCE: '2885' }),
    symbols: ['RELIANCE', 'NOSUCHCO'],
  });
  assert.deepEqual(h.tokens, ['2885']);
  assert.deepEqual(h.skipped, ['NOSUCHCO']);
  assert.ok(angel.subs.length === 1, 'capture still arms on the symbols that resolved');
  h.stop();
});

test('arm refuses to start when nothing resolves — a session of nothing is worse', () => {
  const angel = fakeAngel(), capture = fakeCapture();
  assert.throws(() => arm({
    angel, capture,
    instrument: instrumentFrom({}),
    symbols: ['NOSUCHCO'],
  }), /0 of 1 symbols resolved/);
  assert.equal(angel.subs.length, 0, 'nothing must be subscribed');
  assert.equal(capture.started, 0, 'the flush timer must not be armed');
});
