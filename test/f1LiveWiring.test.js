'use strict';

/**
 * THE LIVE COMPOSITION: socket -> armCapture(onRow) -> tickCapture -> f1Live.
 *
 * The offline parity harness proves the EVALUATOR matches research. It cannot prove the WIRING
 * delivers anything to it, because it replays the stored FILE — where every field is present and
 * every tick is in order. Two live-only shape failures each produce a silent no-op that looks
 * exactly like "the mechanism never fired today", and each costs a whole session of tape:
 *
 *   1. attaching the evaluator to the raw socket `tick` event. The socket emits
 *      {token, lastTradedPrice, lastTradedQuantity, exchangeTimestamp, ...}; the evaluator reads
 *      {t, s, p, q, v, bq, sq}. Every field reads undefined and it returns on every tick.
 *   2. tickCapture.record() returned a row WITHOUT `s`, even though the line it persisted had it.
 *      A live consumer is handed the in-memory object, so `row.s === undefined` and it returns on
 *      every tick. Parity cannot see this — it reads the file.
 *
 * So this test drives the REAL modules over a synthetic raw feed and asserts the property the
 * harness cannot: the wiring actually produces bars, and a directly-fed evaluator agrees with it
 * exactly. Both failure modes above are asserted to be DETECTABLE, not just absent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// MUST be set before the module is required: tickCapture reads dir and ring size at load time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-wiring-'));
process.env.GB_ORDERFLOW_DIR = TMP;

const cap = require('../strategies/orderflow/tickCapture');
const { arm } = require('../strategies/orderflow/armCapture');
const { createF1Live } = require('../strategies/orderflow/f1Live');

const SYMS = [['RELIANCE', '2885'], ['INFY', '1594'], ['TCS', '11536']];
const SESSION_OPEN_UTC_MS = Date.UTC(2026, 9, 9, 3, 45, 0);   // 09:15 IST
const BARS = 75;                                              // a full 09:15-15:30 session

/** A synthetic raw feed in exactly the payload shape angelone/marketFeed emits. */
function rawStream() {
  const out = [];
  SYMS.forEach(([sym, token], si) => {
    let px = 500 + si * 100;
    let vol = 100000;
    for (let bar = 0; bar < BARS; bar++) {
      for (let k = 0; k < 4; k++) {
        const t = SESSION_OPEN_UTC_MS + (bar * 5 + k) * 60 * 1000;
        px = +(px + (k % 3 === 0 ? 0.45 : -0.3)).toFixed(2);
        vol += 300 + bar;
        out.push({
          sym,
          tick: {
            token,
            lastTradedPrice: px,
            lastTradedQuantity: 100 + k * 25,
            exchangeTimestamp: t,
            totalBuyQuantity: 5000 + bar * 10 + k,
            totalSellQuantity: 5000 - (bar % 7) * 5 + k,
            volumeTradedToday: vol,
            bestBids: [{ flag: 0, price: +(px - 0.05).toFixed(2), quantity: 40, numOrders: 2 }],
            bestAsks: [{ flag: 1, price: +(px + 0.05).toFixed(2), quantity: 55, numOrders: 3 }],
          },
        });
      }
    }
  });
  return out;
}

function fakeAngel() {
  const listeners = {};
  return {
    subs: [],
    subscribeLiveAngel(tokens, opts) { this.subs.push({ tokens, opts }); },
    on(e, f) { (listeners[e] ||= []).push(f); },
    off(e, f) { listeners[e] = (listeners[e] || []).filter((x) => x !== f); },
    emit(e, v) { (listeners[e] || []).slice().forEach((f) => f(v)); },
  };
}

const instrument = {
  findEquity(sym) {
    const hit = SYMS.find(([s]) => s === String(sym).toUpperCase());
    return hit ? { token: hit[1], exch_seg: 'NSE' } : null;
  },
};

const newLive = (name) => createF1Live({
  symbols: SYMS.map(([s]) => s),
  log: () => {},
  journalPath: path.join(TMP, name + '.jsonl'),
});

// Comparable projection: the raw feed counters and wall-clock stamps differ by construction.
const score = (f1) => {
  const p = f1.performance();
  return {
    armed: p.armed, closed: p.closed, skipped: p.skipped,
    overall: p.overall, bySide: p.bySide, byPattern: p.byPattern, byCell: p.byCell,
  };
};

test('the row hook feeds the evaluator real bars — the wiring is not a silent no-op', () => {
  cap.reset();
  const angel = fakeAngel();
  const wired = newLive('wired');
  const handle = arm({
    angel, capture: cap, instrument, symbols: SYMS.map(([s]) => s),
    onRow: wired.safeTick,
  });

  for (const { tick } of rawStream()) angel.emit('tick', tick);

  const q = wired.feedQuality();
  assert.ok(q.ticks > 0,
    'the evaluator saw ZERO ticks — the row hook is not delivering (raw socket ticks have no `s`)');
  assert.ok(q.barsSealed > 0, 'ZERO bars sealed: the rows reaching the evaluator are not row-shaped');
  assert.equal(q.symbolsSeen, SYMS.length, 'every subscribed symbol must reach its own bar series');

  // The tape is written FIRST and is unaffected by the observer.
  cap.flush();
  const file = fs.readdirSync(TMP).find((f) => f.startsWith('ticks-'));
  assert.ok(file, 'the raw tape must exist regardless of what the observer does');
  const lines = fs.readFileSync(path.join(TMP, file), 'utf8').trim().split('\n');
  assert.ok(lines.length > 0, 'the tape must not be empty');
  assert.ok(JSON.parse(lines[0]).s, 'a stored line carries its symbol, as it always has');

  handle.stop();
});

test('the returned row is self-describing: it carries `s`, like the persisted line', () => {
  cap.reset();
  cap.register('2885', 'RELIANCE');
  const row = cap.record({
    token: '2885', lastTradedPrice: 100.5, lastTradedQuantity: 40,
    exchangeTimestamp: SESSION_OPEN_UTC_MS, totalBuyQuantity: 10, totalSellQuantity: 20,
    volumeTradedToday: 300,
  });
  assert.ok(row);
  assert.equal(row.s, 'RELIANCE',
    'the in-memory row must carry `s`: a live consumer reads it and the file it was written to has it');
  assert.equal(row.q, 40);
});

test('attaching the evaluator to the raw socket event is DETECTABLY broken', () => {
  cap.reset();
  const angel = fakeAngel();
  const naive = newLive('naive');
  // The mistake that looks like a quiet market: the socket's payload is not the row shape.
  angel.on('tick', naive.safeTick);
  for (const { tick } of rawStream()) angel.emit('tick', tick);

  assert.equal(naive.feedQuality().ticks, 0,
    'a socket-attached evaluator must record nothing — this is why the row hook exists');
  assert.equal(naive.performance().armed, 0);
});

test('no neutral pattern can appear in the per-pattern table', () => {
  // NEUTRAL in SPEC 8.27F. A trade may show one of these on its bar, but it cannot be what armed
  // the trade, so attributing the trade to it would inflate that pattern's row - and that is
  // exactly what the table did before: it reported `outside_bar` / `doji` / `inside_bar` rows that
  // the research path cannot produce, because research records `pats & BULLISH` / `& BEARISH`.
  const NEUTRAL = ['doji', 'inside_bar', 'outside_bar'];
  cap.reset();
  const angel = fakeAngel();
  const live = newLive('neutralcheck');
  const h = arm({ angel, capture: cap, instrument, symbols: SYMS.map(([s]) => s), onRow: live.safeTick });
  for (const { tick } of rawStream()) angel.emit('tick', tick);
  h.stop();
  live.closeSession();

  for (const sig of live.signals()) {
    if (sig.status !== 'closed') continue;
    assert.ok(Array.isArray(sig.patternsArming), 'every signal must carry patternsArming');
    for (const p of sig.patternsArming) {
      assert.ok(sig.patterns.includes(p), 'patternsArming must be a subset of the patterns found');
      assert.ok(!NEUTRAL.includes(p), `neutral pattern "${p}" must not be an arming pattern`);
    }
  }
  for (const key of Object.keys(live.performance().byPattern)) {
    assert.ok(!NEUTRAL.includes(key),
      `byPattern contains neutral pattern "${key}" - research's table cannot contain it`);
  }
});

test('the wired path and a directly-fed evaluator agree exactly', () => {
  const stream = rawStream();

  // Run A — the real wiring: armCapture -> onRow -> evaluator.
  cap.reset();
  const angelA = fakeAngel();
  const a = newLive('runA');
  const h = arm({ angel: angelA, capture: cap, instrument, symbols: SYMS.map(([s]) => s), onRow: a.safeTick });
  for (const { tick } of stream) angelA.emit('tick', tick);
  h.stop();

  // Run B — the rows only: record() then feed the row straight in, bypassing armCapture.
  cap.reset();
  const b = newLive('runB');
  for (const [sym, token] of SYMS) cap.register(token, sym);
  for (const { sym, tick } of stream) {
    const row = cap.record(tick, sym);
    if (row) b.onTick(row);
  }

  assert.ok(a.feedQuality().barsSealed > 0);
  assert.equal(a.feedQuality().barsSealed, b.feedQuality().barsSealed,
    'the wiring must not drop or reorder a bar relative to the raw row stream');
  assert.deepEqual(score(a), score(b),
    'armCapture must hand the evaluator exactly the rows the tape would have carried');
});
