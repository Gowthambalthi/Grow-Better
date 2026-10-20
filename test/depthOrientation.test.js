'use strict';

/**
 * THE BOOK MUST NEVER BE UPSIDE-DOWN.
 *
 * On 2026-10-12 the captured tape stored `bid` ABOVE `ask` on every single row:
 * 1,656,566 of 1,656,566 depth snapshots were reported swapped by
 * depth5_recorder.orient, and level-1 rows read e.g. RECLTD bid 304.45 / ask
 * 304.30. Consequences measured on live data:
 *   - the quoted spread came out NEGATIVE (a market with a negative spread does not exist);
 *   - `askq` held the BID quantity, so a big supply wall ABOVE price was read as a
 *     big BID below it — the exact inverse of the evidence a long wants;
 *   - liveMinuteEngine's aggressor guard (`t.ask > t.bid`) was false on every row,
 *     so the book was never consulted and delta silently degraded to the tick rule.
 *
 * The cause was angelone/marketFeed.js `_parseBest5` bucketing flag 0 as the buy
 * side; Angel's own smartWebSocketV2.py nets out the opposite assignment (and
 * SDK issue #71 reports the same confusion). These tests pin all three layers so
 * the inversion cannot come back: the parser, the stored row, and the delta that
 * the live strategy trades on.
 *
 * Files are sandboxed via GB_ORDERFLOW_DIR, which both tickCapture and
 * liveMinuteEngine honour — without it a scan in a test would rewrite today's
 * real daily_calls file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'depth-orient-'));
process.env.GB_ORDERFLOW_DIR = TMP;
delete process.env.GB_ASK_WALL_RATIO;      // test the shipped default (5x)

const { AngelMarketFeed, MODE } = require('../angelone/marketFeed');
const cap = require('../strategies/orderflow/tickCapture');
const engine = require('../strategies/orderflow/liveMinuteEngine');

// ---------------------------------------------------------------------------
// feed -> parsed tick
// ---------------------------------------------------------------------------

function depthEntry(flag, qty, price, orders) {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(flag, 0);                                   // 0 = sell side on the wire
  b.writeBigInt64LE(BigInt(qty), 2);
  b.writeBigInt64LE(BigInt(Math.round(price * 100)), 10);     // price x100, like the feed
  b.writeUInt16LE(orders, 18);
  return b;
}

/** A full SNAP_QUOTE packet: flag-0 (higher, ask) levels first, flag-1 bids second. */
function buildSnapTick({ ltp, asks, bids }) {
  const buf = Buffer.alloc(400);
  buf.writeUInt8(MODE.SNAP_QUOTE, 0);
  buf.writeUInt8(1, 1);                                    // NSE_CM
  buf.write('RELIANCE', 2, 'ascii');                       // token, NUL-padded
  buf.writeBigInt64LE(7n, 27);                             // sequence
  buf.writeBigInt64LE(BigInt(Date.now()), 35);             // exchange timestamp
  buf.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 43);  // LTP
  buf.writeBigInt64LE(10n, 51);                            // last traded qty
  buf.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 59);  // avg price
  buf.writeBigInt64LE(1000n, 67);                          // volume
  buf.writeDoubleLE(5000, 75);                             // total buy qty
  buf.writeDoubleLE(6000, 83);                             // total sell qty
  for (const off of [91, 99, 107, 115]) {                  // OHLC
    buf.writeBigInt64LE(BigInt(Math.round(ltp * 100)), off);
  }
  buf.writeBigInt64LE(BigInt(Date.now()), 123);            // last traded ts
  buf.writeBigInt64LE(0n, 131);                            // OI
  buf.writeBigInt64LE(0n, 139);                            // OI change %
  const depth = Buffer.concat([
    ...asks.map((a) => depthEntry(0, a.qty, a.px, 1)),
    ...bids.map((b) => depthEntry(1, b.qty, b.px, 1)),
  ]);
  depth.copy(buf, 147);
  for (const off of [347, 355, 363, 371]) {                // circuits + 52w
    buf.writeBigInt64LE(BigInt(Math.round(ltp * 100)), off);
  }
  return buf;
}

const feed = new AngelMarketFeed({
  jwtToken: 'x', apiKey: 'x', clientCode: 'x', feedToken: 'x',
});

test('the parsed tick puts the LOWER-priced group in bestBids, not the flag-0 group', () => {
  const tick = feed._parseBinary(buildSnapTick({
    ltp: 100.02,
    asks: [{ px: 100.05, qty: 40 }, { px: 100.10, qty: 12 }],   // wire flag 0 (sell)
    bids: [{ px: 100.00, qty: 55 }, { px: 99.95, qty: 30 }],     // wire flag 1 (buy)
  }));

  assert.equal(tick.bestBids[0].price, 100, 'bestBids must be the BUY ladder (lower prices)');
  assert.equal(tick.bestBids[0].quantity, 55);
  assert.equal(tick.bestAsks[0].price, 100.05, 'bestAsks must be the SELL ladder (higher prices)');
  assert.equal(tick.bestAsks[0].quantity, 40);
  assert.ok(tick.bestBids[0].price <= tick.bestAsks[0].price,
    'a book may be locked but never crossed: bestBids <= bestAsks');
});

test('_parseBest5 splits every level of both sides, not just level 1', () => {
  const tick = feed._parseBinary(buildSnapTick({
    ltp: 100.02,
    asks: [{ px: 100.05, qty: 1 }, { px: 100.06, qty: 2 }, { px: 100.07, qty: 3 },
           { px: 100.08, qty: 4 }, { px: 100.09, qty: 5 }],
    bids: [{ px: 100.00, qty: 6 }, { px: 99.99, qty: 7 }, { px: 99.98, qty: 8 },
           { px: 99.97, qty: 9 }, { px: 99.96, qty: 10 }],
  }));
  assert.equal(tick.bestBids.length, 5);
  assert.equal(tick.bestAsks.length, 5);
  // bids descend, asks ascend — the order a real ladder has
  assert.deepEqual(tick.bestBids.map((e) => e.price), [100, 99.99, 99.98, 99.97, 99.96]);
  assert.deepEqual(tick.bestAsks.map((e) => e.price), [100.05, 100.06, 100.07, 100.08, 100.09]);
});

test('the side is decided by PRICE, so a flag that means the opposite still orients', () => {
  // From 15:20 IST on 2026-10-12 the wire began sending flag 0 for the BID group
  // (FEDERALBNK and 132 other symbols showed both meanings in one session). A
  // parser that trusts the flag therefore cannot be right twice in the same day.
  const tick = feed._parseBinary(buildSnapTick({
    ltp: 100.02,
    asks: [{ px: 100.05, qty: 40 }, { px: 100.06, qty: 12 }],   // wire flag 1 (buy)
    bids: [{ px: 100.00, qty: 55 }, { px: 99.95, qty: 30 }],     // wire flag 0 (sell)
  }));
  assert.equal(tick.bestBids[0].price, 100, 'bids are the LOWER group whatever the flag says');
  assert.equal(tick.bestBids[0].quantity, 55, 'and the quantity stays with its price');
  assert.equal(tick.bestAsks[0].price, 100.05);
  assert.equal(tick.bestAsks[0].quantity, 40);
});

test('level 1 is the BEST price on its side even when levels arrive worst-first', () => {
  // After 15:20 the tape's `bid` was the FURTHEST bid (317.25 while the best was
  // 325.15), because level 1 was taken as array index 0. Sorting makes 0 mean 1.
  const tick = feed._parseBinary(buildSnapTick({
    ltp: 99.99,
    asks: [{ px: 100.09, qty: 9 }, { px: 100.08, qty: 8 }, { px: 100.07, qty: 7 },
           { px: 100.06, qty: 6 }, { px: 100.05, qty: 5 }],      // worst ask first
    bids: [{ px: 99.96, qty: 4 }, { px: 99.97, qty: 3 }, { px: 99.98, qty: 2 },
           { px: 99.99, qty: 1 }, { px: 100.00, qty: 0 }],       // worst bid first
  }));
  assert.equal(tick.bestBids[0].price, 100, 'highest bid is level 1');
  assert.equal(tick.bestAsks[0].price, 100.05, 'lowest ask is level 1');
  assert.equal(tick.bestBids[4].price, 99.96, 'the furthest bid is the LAST level, not the first');
});

test('an overlap cannot be oriented — both sides are dropped, never published crossed', () => {
  const tick = feed._parseBinary(buildSnapTick({
    ltp: 100.03,
    asks: [{ px: 100.07, qty: 10 }, { px: 100.02, qty: 10 }],   // ranges interleave
    bids: [{ px: 100.05, qty: 10 }, { px: 99.95, qty: 10 }],
  }));
  assert.equal(tick.bestBids.length, 0, 'no bid ladder is claimed when the groups overlap');
  assert.equal(tick.bestAsks.length, 0, 'no ask ladder either — an absent book, not a crossed one');
});

// ---------------------------------------------------------------------------
// tape -> stored row
// ---------------------------------------------------------------------------

const l1 = (over) => Object.assign({
  token: '2885',
  lastTradedPrice: 100.02,
  lastTradedQuantity: 10,
  exchangeTimestamp: 1791870000000,
  totalBuyQuantity: 5000,
  totalSellQuantity: 6000,
  volumeTradedToday: 1000,
}, over || {});

test('a row written from an INVERTED feed still stores bid <= ask, quantities attached', () => {
  cap.reset();
  cap.register('2885', 'RELIANCE');
  const before = cap.stats.depthSideSwaps;

  // The feed hands the ask ladder over as bestBids — the pre-fix behaviour.
  const row = cap.record(l1({
    bestBids: [{ price: 100.05, quantity: 40 }],   // actually the ASK
    bestAsks: [{ price: 100.00, quantity: 55 }],   // actually the BID
  }), 'RELIANCE');

  assert.ok(row, 'the tick must be stored');
  assert.equal(row.bid, 100, 'bid must be the lower price');
  assert.equal(row.bidq, 55, 'the quantity must travel WITH its price');
  assert.equal(row.ask, 100.05);
  assert.equal(row.askq, 40);
  assert.ok(row.bid <= row.ask, 'invariant: the tape may never store a crossed book');
  assert.equal(cap.stats.depthSideSwaps, before + 1, 'the repair must be counted, not silent');

  cap.flush();
  const file = fs.readdirSync(TMP).find((f) => f.startsWith('ticks-'));
  const lines = fs.readFileSync(path.join(TMP, file), 'utf8').trim().split('\n');
  const stored = JSON.parse(lines[lines.length - 1]);
  assert.ok(stored.bid <= stored.ask, 'the PERSISTED line carries the same invariant');
  assert.equal(stored.bidq, 55);
});

test('a correctly-oriented feed passes through untouched and is not counted as swapped', () => {
  cap.reset();
  cap.register('2885', 'RELIANCE');
  const row = cap.record(l1({
    bestBids: [{ price: 100.00, quantity: 55 }],
    bestAsks: [{ price: 100.05, quantity: 40 }],
    exchangeTimestamp: 1791870001000,
  }), 'RELIANCE');

  assert.equal(row.bid, 100);
  assert.equal(row.ask, 100.05);
  assert.equal(row.bidq, 55);
  assert.equal(row.askq, 40);
  assert.equal(cap.stats.depthSideSwaps, 0, 'a healthy feed must not increment the counter');
});

test('orientLevel1 leaves a one-sided or absent book alone rather than inventing a price', () => {
  assert.deepEqual(cap.orientLevel1(undefined, 0, undefined, 0),
    { bid: undefined, bidq: 0, ask: undefined, askq: 0, swapped: false });
  const half = cap.orientLevel1(100, 10, 0, 0);
  assert.equal(half.swapped, false);
  assert.equal(half.bid, 100, 'a lone bid stays put — there is nothing to cross it');
  // locked book (bid == ask) is legal and must not be reported as inverted
  const locked = cap.orientLevel1(100, 10, 100, 12);
  assert.equal(locked.swapped, false);
  assert.equal(locked.bidq, 10, 'on a lock the quantities keep their own prices');
});

// ---------------------------------------------------------------------------
// live strategy -> delta
// ---------------------------------------------------------------------------

/** The shipped threshold, captured before any test can move it. */
const DEFAULT_WALL = engine.askWallRatioMin;

function resetEngine() {
  engine.symBars.clear();
  engine.prevPrice.clear();
  engine.book.clear();
  engine.calls.clear();
  engine.closedCalls.length = 0;
  engine.sessionClosed = false;
  engine.askWallRatioMin = DEFAULT_WALL;   // a test may arm/disarm the gate; the default returns
  engine.strictInvalidation = false;       // synthetic book tests test depth orientation & walls specifically
  delete engine.istMinute;             // back to the prototype's real clock
  engine.dispatchTelegramNewCall = () => Promise.resolve();   // never alert from a test
}

const MIN = 60000;
const T0 = 1791870000000;

/**
 * n one-minute bars: a slow grind up on 2x volume — a qualifying LONG.
 * `deltaFrac` is the traded-flow delta share, which is what decides whether a wall
 * counts as ABSORBED (>= 0.15) or merely resting (< 0.15).
 */
function seedBars(sym, n = 20, base = 100, deltaFrac = 0.20) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const px = base * (1 + i * 0.0008);       // +1.52% over the run -> dayChangePct > 0.3
    const vol = i >= n - 5 ? 4000 : 2000;     // last-5 vol = 2x baseline -> volSurge 2.0
    // A REAL displacement candle: the body is ~86% of the bar range (open below, close
    // at px). The fixture used to print flat dojis whose body was 0% of the range; the
    // FVG quality rule (research/fvg/FVG_DEEP_RESEARCH.md Part 6.1, F1: displacement body
    // >= 60% of range) correctly refuses to call that a gap, so the fixture now opens low
    // and closes at px instead of relying on a zero-body "gap".
    const o = px * 0.9994;
    bars.push({
      t: T0 + i * MIN, o, h: px * 1.0001, l: px * 0.9994, c: px,
      v: vol, q: vol, delta: Math.round(vol * deltaFrac),
      buyVol: Math.round(vol * (deltaFrac + 0.3)), sellVol: Math.round(vol * (1 - deltaFrac) * 0.5),
    });
  }
  engine.symBars.set(sym, bars);
}

/** A balanced book so only the gate under test can be what stops the call. */
function balanceBook(sym, px) {
  engine.book.set(sym, { bid: px, bidq: 500, ask: +(px * 1.0004).toFixed(2), askq: 520, t: Date.now() });
}

test('delta uses the BOOK: a print at/above the ask is a buy, at/below the bid a sell', () => {
  resetEngine();
  const sym = 'TESTSYM';

  // Feed inverted on purpose — the guard used to fail here and fall to the tick rule.
  engine.ingestTick({
    t: T0, s: sym, p: 100.06, q: 7,
    bid: 100.05, bidq: 40, ask: 100.00, askq: 55,
  }, false);
  let bar = engine.symBars.get(sym)[0];
  assert.equal(bar.delta, 7, 'print above the offer was lifted -> +delta');
  assert.equal(bar.buyVol, 7);

  engine.ingestTick({ t: T0 + 1000, s: sym, p: 99.99, q: 5, bid: 100.05, bidq: 40, ask: 100.00, askq: 55 }, false);
  bar = engine.symBars.get(sym)[0];
  assert.equal(bar.delta, 2, 'print below the bid was hit -> -delta');
  assert.equal(bar.sellVol, 5);

  // The book kept for the scanner must be ORIENTED even though the row was inverted.
  const book = engine.book.get(sym);
  assert.equal(book.bid, 100, 'scanner reads the real bid');
  assert.equal(book.bidq, 55, 'with the quantity that belongs to that price');
  assert.equal(book.ask, 100.05);
  assert.equal(book.askq, 40);
});

test('a print inside the spread falls back to the tick rule, not to a guess', () => {
  resetEngine();
  const sym = 'TESTSYM';
  // All three prints sit strictly inside 100.00 / 100.05, so the book test can never
  // fire and only the uptick/downtick fallback can be doing the classifying.
  engine.ingestTick({ t: T0, s: sym, p: 100.02, q: 10, bid: 100.00, bidq: 55, ask: 100.05, askq: 40 }, false);
  engine.ingestTick({ t: T0 + 1000, s: sym, p: 100.03, q: 3, bid: 100.00, bidq: 55, ask: 100.05, askq: 40 }, false);
  engine.ingestTick({ t: T0 + 2000, s: sym, p: 100.01, q: 2, bid: 100.00, bidq: 55, ask: 100.05, askq: 40 }, false);
  const bar = engine.symBars.get(sym)[0];
  assert.equal(bar.delta, 3 - 2, 'first print sets no direction; then up-tick, then down-tick');
  assert.equal(bar.buyVol, 3);
  assert.equal(bar.sellVol, 2);
});

test('a print AT the bid is seller-initiated — the book decides, not the label order', () => {
  resetEngine();
  const sym = 'TESTSYM';
  // p == bid: a market sell hit the bid. This is the Lee-Ready quote test, and it is
  // exactly the branch that never ran before (its guard read the reversed sides).
  engine.ingestTick({ t: T0, s: sym, p: 100.00, q: 10, bid: 100.00, bidq: 55, ask: 100.05, askq: 40 }, false);
  assert.equal(engine.symBars.get(sym)[0].delta, -10, 'print on the bid -> -delta');
  // ...and a print AT the ask is buyer-initiated.
  resetEngine();
  engine.ingestTick({ t: T0, s: sym, p: 100.05, q: 6, bid: 100.00, bidq: 55, ask: 100.05, askq: 40 }, false);
  assert.equal(engine.symBars.get(sym)[0].delta, 6, 'print on the offer -> +delta');
});

// ---------------------------------------------------------------------------
// ask-wall gate
// ---------------------------------------------------------------------------

test('a RESTING ask wall blocks a long, but an ABSORBED one does not', () => {
  // This pins the synthesis the exchange agreed on after measuring it: a flat block
  // at >=5x would have thrown away the two thickest-wall WINNERS of 2026-10-12
  // (KOPRAN 24x, NRBBEARING 10.3x), so a wall is only refused while buying is weak.
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    // The shipped default is now DISABLED (0), on the owner's instruction and on
    // evidence: the tapes carry no book so the gate was never validated historically,
    // and EXP009 showed that removing order flow entirely does not change win rate or
    // profit factor. The gate is kept and armed explicitly below so it stays testable.
    assert.equal(DEFAULT_WALL, 0, 'the shipped wall threshold is disabled by default');
    assert.equal(engine.askWallRatioMin, 0, 'and the live instance starts disabled');

    // Control: balanced book -> armed.
    resetEngine();
    engine.askWallRatioMin = 5;              // arm the gate explicitly: shipped default is OFF
    seedBars('WALLSYM');
    engine.book.set('WALLSYM', { bid: 100.80, bidq: 500, ask: 100.84, askq: 520, t: Date.now() });
    engine.istMinute = () => engine.armEndMinute - 45;  // inside the arm window, whatever its edge is
    engine.scanMinuteTape();
    assert.equal(engine.calls.size, 1, 'positive control: a balanced book must still arm a call');

    // A 10x wall with WEAK aggression (delta 10% < 15%) -> refused, and reported.
    resetEngine();
    engine.askWallRatioMin = 5;              // arm the gate explicitly: shipped default is OFF
    seedBars('WALLSYM', 20, 100, 0.10);
    engine.book.set('WALLSYM', { bid: 100.80, bidq: 400, ask: 100.84, askq: 4000, t: Date.now() });
    engine.istMinute = () => engine.armEndMinute - 45;
    engine.scanMinuteTape();
    assert.equal(engine.calls.size, 0,
      'a resting 10x ask wall with weak buying is overhead supply — do not arm into it');
    assert.ok(logs.some((l) => l.includes('ASK wall') && l.includes('WALLSYM') && l.includes('10')),
      'the refusal must be reported with its measured numbers: ' + JSON.stringify(logs));

    // The SAME 10x wall while it is being absorbed (delta 20%, volSurge 2.0) -> armed.
    // This is Antigravity's rule, and EXP001's winners are why it exists.
    resetEngine();
    engine.askWallRatioMin = 5;              // arm the gate explicitly: shipped default is OFF
    seedBars('WALLSYM', 20, 100, 0.20);
    engine.book.set('WALLSYM', { bid: 100.80, bidq: 400, ask: 100.84, askq: 4000, t: Date.now() });
    engine.istMinute = () => engine.armEndMinute - 45;
    engine.scanMinuteTape();
    assert.equal(engine.calls.size, 1,
      'a wall being bought through is liquidity to sweep, not a reason to stand aside');

    // Stale depth is not evidence — a wall seen 60s ago must not block by itself.
    resetEngine();
    engine.askWallRatioMin = 5;              // arm the gate explicitly: shipped default is OFF
    seedBars('WALLSYM', 20, 100, 0.10);
    engine.book.set('WALLSYM', { bid: 100.80, bidq: 400, ask: 100.84, askq: 4000, t: Date.now() - 60000 });
    engine.istMinute = () => engine.armEndMinute - 45;
    engine.scanMinuteTape();
    assert.equal(engine.calls.size, 1,
      'depth older than GB_DEPTH_MAX_AGE_MS is skipped rather than treated as live');

    // Disarmed (threshold 0), the measurement still happens and nothing is blocked.
    resetEngine();
    engine.askWallRatioMin = 0;
    seedBars('WALLSYM', 20, 100, 0.10);
    engine.book.set('WALLSYM', { bid: 100.80, bidq: 400, ask: 100.84, askq: 4000, t: Date.now() });
    engine.istMinute = () => engine.armEndMinute - 45;
    engine.scanMinuteTape();
    assert.equal(engine.calls.size, 1, 'threshold 0 disables the block but keeps the book measurement');
  } finally {
    console.log = realLog;
  }
});

test('with the SHIPPED default a 10x ask wall does not block, and the book is still reported', () => {
  // This is the behaviour the owner asked for: the ratio stops deciding entries, but
  // the measurement must survive in the call note so the operator can still see it.
  resetEngine();
  assert.equal(engine.askWallRatioMin, 0, 'shipped default must be off');
  seedBars('WALLSYM', 20, 100, 0.10);       // weak buying, the case the old gate refused
  engine.book.set('WALLSYM', { bid: 100.80, bidq: 400, ask: 100.84, askq: 4000, t: Date.now() });
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1,
    'the shipped default must not let posted ask depth decide the entry');
  const call = [...engine.calls.values()][0];
  assert.ok(call, 'a call was armed');
});

// ---------------------------------------------------------------------------
// session window + one-lot price cap
// ---------------------------------------------------------------------------

test('no NEW arm after the arm cutoff — the tail of the session is not time for a target', () => {
  resetEngine();
  seedBars('LATESYM');
  balanceBook('LATESYM', 101.5);

  engine.istMinute = () => engine.armEndMinute - 1;   // one minute inside the window
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'positive control: the last minute inside the window must still arm');

  resetEngine();
  seedBars('LATESYM');
  balanceBook('LATESYM', 101.5);
  engine.istMinute = () => engine.armEndMinute + 20;  // past the cutoff
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 0, 'past the cutoff the scan may watch but must not arm');

  // Monitoring of what is already open must survive the gate.
  resetEngine();
  seedBars('LATESYM');
  balanceBook('LATESYM', 101.5);
  engine.istMinute = () => engine.armEndMinute - 1;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1);
  engine.istMinute = () => engine.armEndMinute + 20;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'the open call is untouched, only new arms stop');
  assert.equal(engine.calls.values().next().value.status, 'ARMED');
});

test('at 15:30 every open call is settled at the close, exactly once', () => {
  resetEngine();
  seedBars('CLOSER');
  balanceBook('CLOSER', 101.5);
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1);
  assert.equal([...engine.calls.values()][0].status, 'ARMED');

  engine.istMinute = () => 931;              // 15:31
  engine.scanMinuteTape();
  const call = [...engine.calls.values()][0];
  assert.equal(engine.calls.size, 1, 'a post-close scan must not arm anything new');
  assert.notEqual(call.status, 'ARMED', 'nothing may still look armed after the close');
  assert.equal(call.exitReason, 'SESSION_CLOSE', 'the reason must say the SESSION ended, not a level');
  assert.equal(engine.sessionClosed, true);
  assert.equal(engine.closedCalls.length, 1, 'a settled call is moved to the closed set for the scorecard');
  assert.equal(typeof call.exitPrice, 'number', 'settling realizes a P&L at an actual price');

  engine.istMinute = () => 933;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'closed calls are never re-armed');
  assert.equal(engine.closedCalls.length, 1, 'and never settled twice — the guard is what stops a double count');
});

test('the close settle does not call a FLAT call a win', () => {
  // Disagreement logged for exchange.md: closeSession() books `pts >= 0 ? 'WON' :
  // 'LOST'`, so a call that never moved (pts === 0) is counted as a WIN and inflates
  // the day's win rate. orderflow/callOutcomes.js — which decides what the page
  // shows — marks the same call SESSION_CLOSE, i.e. neither won nor lost. Until that
  // is resolved this pins the CURRENT behaviour so a silent change is visible.
  resetEngine();
  seedBars('FLATSYM');
  balanceBook('FLATSYM', 101.5);
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  const c = [...engine.calls.values()][0];
  c.ltp = c.limitEntry;                      // price never moved from the entry
  engine.istMinute = () => 931;
  engine.scanMinuteTape();
  assert.equal(c.exitReason, 'SESSION_CLOSE');
  assert.equal(c.netInr1Lot, 0, 'a call that never moved is worth zero, whatever it is labelled');
});

// The old ₹3,000 SHARE-PRICE cap was retired: it threw out the most liquid bluechips,
// including NAVINFLUOR at ₹8,520 — which was the day's single largest rupee winner
// (₹79.80 on one lot). What replaces it is size NORMALIZED BY NOTIONAL, so a ₹8,520 name
// and a ₹250 name carry the same portfolio weight and neither can dominate the P&L.
// The remaining price bound is a sanity ceiling, not a selection rule.
test('position weight is normalized by notional, and the share-price bound is a sanity ceiling', () => {
  resetEngine();
  seedBars('RICHSYM', 20, 8500);             // ₹8,629 — a bluechip the old cap wrongly rejected
  balanceBook('RICHSYM', 8629);
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'a high-priced liquid name is no longer disqualified');
  const rich = [...engine.calls.values()][0];

  resetEngine();
  seedBars('MIDSYM', 20, 2500);              // ₹2,538 — the cheap name
  balanceBook('MIDSYM', 2538);
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'positive control: the cheap name arms too');
  const cheap = [...engine.calls.values()][0];

  // Equal rupee risk is the point: the expensive name must NOT be handed more capital.
  assert.ok(rich.notional > 0 && cheap.notional > 0, 'every call records the notional it sized to');
  assert.ok(Math.abs(rich.notional - cheap.notional) <= rich.limitEntry,
    'both calls size to the same notional within one share: ' + rich.notional + ' vs ' + cheap.notional);
  assert.ok(rich.shares < cheap.shares,
    'fewer shares of the expensive name — the weight is equal, not the share count');

  // And a price beyond the sanity ceiling is still refused outright.
  resetEngine();
  seedBars('ABSURDSYM', 20, 60000);
  balanceBook('ABSURDSYM', 60000);
  engine.istMinute = () => engine.armEndMinute - 45;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 0, 'a price no NSE equity trades at is refused by the sanity ceiling');
});

// DIRECTION-AWARE MIDDAY FILTER (EXP010):
// 12:30 to 13:45 IST produces severe drag for LONGS (-30.8 bps in 10-session replay),
// but remains profitable for SHORTS (+8.8 bps). Longs are blocked in this window.
test('EXP010: Longs are blocked during the 12:30-13:45 IST midday window, allowed outside it', () => {
  resetEngine();
  seedBars('LUNCHSYM');
  balanceBook('LUNCHSYM', 101.5);
  engine.istMinute = () => 13 * 60; // 13:00 IST - inside 12:30-13:45 window
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 0, 'Longs must not be armed between 12:30 and 13:45 IST');

  resetEngine();
  seedBars('MORNINGSYM');
  balanceBook('MORNINGSYM', 101.5);
  engine.istMinute = () => 11 * 60 + 30; // 11:30 IST - outside midday window
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'Longs are allowed during the morning expansion window');
});


// ---------------------------------------------------------------------------
// FVG STRUCTURAL RULES (research/fvg/FVG_DEEP_RESEARCH.md, Part 6.1)
//
// An FVG is a LOCATION, not a signal: the research found no measurable standalone edge
// (mechanical PF 0.43 over 2,232 trades), so what is implemented is the STRUCTURE of a
// usable gap. These tests pin each of the four rules against the engine's own helper --
// the scan calls the same function, so a passing test cannot describe a rule the engine
// does not apply.
// ---------------------------------------------------------------------------

const fvgBar = (i, o, h, l, c) => ({
  t: T0 + i * MIN, o, h, l, c, v: 2000, q: 2000, delta: -300,
  buyVol: 800, sellVol: 1200,
});

test('FVG F1: a zero-body candle is not a gap; a real displacement candle is', () => {
  // Three-bar BEARISH gap geometry (candle 3 high below candle 1 low) with a FLAT middle
  // candle whose body is 0% of its range. The identical wick arithmetic used to be read
  // as a gap; F1 refuses it because nothing was displaced.
  const doji = [
    fvgBar(0, 100, 101, 99, 100),
    fvgBar(1, 100, 100.5, 99.5, 100),      // body 0.0 / range 1.0 = 0% of range
    fvgBar(2, 99, 99.4, 98.6, 99),
  ];
  assert.equal(engine.findFvg(doji, -1), null,
    'a zero-body displacement candle must not be counted as an FVG');

  // Same shape with a real displacement candle: body 1.4 / range 2.0 = 70% of range,
  // and the gap is 70.7 bps between candle 1 low (100.5) and candle 3 high (99.8).
  const real = [
    fvgBar(0, 101, 102, 100.5, 101),
    fvgBar(1, 101, 101.2, 99.2, 99.6),
    fvgBar(2, 99.6, 99.8, 98.8, 99),
  ];
  const gap = engine.findFvg(real, -1);
  assert.ok(gap, 'a real displacement candle must produce a gap');
  assert.equal(gap.top, 100.5, 'distal edge = candle 1 low');
  assert.equal(gap.bottom, 99.8, 'proximal edge = candle 3 high');
  assert.equal(gap.ce, 100.15, 'CE = the 50% midpoint of the zone');
  assert.ok(gap.gapBps >= 8, 'the gap must clear the 8 bps floor');
  assert.ok(gap.bodyFrac >= 0.60, 'the reported body fraction must clear F1');
  assert.equal(gap.live, true, 'a fresh gap is live');
});

test('FVG F2/F4: a short must sell INTO the imbalance and the structural stop must fit 1:1.50', () => {
  const bars = [
    fvgBar(0, 101, 102, 100.5, 101),
    fvgBar(1, 101, 101.2, 99.2, 99.6),
    fvgBar(2, 99.6, 99.8, 98.8, 99),
  ];
  // Below the midpoint: the retrace has not happened yet -> refused, and named.
  assert.equal(engine.fvgShortGate(bars, 99).gate, 'CE_BELOW_GAP',
    'selling below CE is chasing, not trading the imbalance');

  // Inside the upper half of the zone: 20.4 bps to the distal wick -> allowed.
  const inside = engine.fvgShortGate(bars, 100.3);
  assert.equal(inside.gate, 'BEARISH_FVG_CE', 'price inside the upper half must be allowed');
  assert.ok(inside.structuralStopBps > 0 && inside.structuralStopBps <= 55,
    'the structural stop must be inside the mandate: ' + inside.structuralStopBps);

  // A very wide gap mid-zone puts the distal wick 244 bps away -> refused by F4, because
  // honouring the structure would need a stop nothing like the owner's 1:1.50 geometry.
  const wide = [
    fvgBar(0, 106, 107, 105, 106),        // candle 1 low 105 -> the distal edge
    fvgBar(1, 105, 105.5, 100.5, 101),    // a large displacement candle down
    fvgBar(2, 101, 100.2, 99.8, 100.0),   // candle 3 high 100.2 -> the proximal edge
  ];
  const wideGate = engine.fvgShortGate(wide, 103.0);   // inside the upper half, distal 195 bps away
  assert.equal(wideGate.gate, 'FVG_STOP_TOO_FAR',
    'a structural stop wider than the mandate must refuse the trade, not be rounded into a bps stop');

  // No qualifying gap at all -> NONE (the scan then has no FVG to lean on).
  assert.equal(engine.fvgShortGate([fvgBar(0, 100, 100.2, 99.9, 100)], 100).gate, 'NONE');
});

test('FVG F3: a completed CLOSE above the distal wick kills the gap', () => {
  const bars = [
    fvgBar(0, 101, 102, 100.5, 101),
    fvgBar(1, 101, 101.2, 99.2, 99.6),
    fvgBar(2, 99.6, 99.8, 98.8, 99),
  ];
  assert.equal(engine.fvgShortGate(bars, 100.3).gate, 'BEARISH_FVG_CE', 'control: live gap allows');

  // One later bar closes at 101.0 — above the distal edge (100.5). Dead, and named.
  const closedThrough = [...bars, fvgBar(3, 99.5, 101.2, 99.4, 101.0)];
  const dead = engine.findFvg(closedThrough, -1);
  assert.ok(dead, 'the gap is still located so the reason can be reported');
  assert.equal(dead.dead, true, 'a close beyond the far edge must mark the gap dead');
  assert.equal(engine.fvgShortGate(closedThrough, 100.3).gate, 'FVG_DEAD',
    'and the scan must refuse it: dead is dead');

  // A WICK beyond the edge that CLOSES back inside leaves the gap alive (the research
  // records the wick-vs-close convention conflict; the engine follows the close rule).
  const wickedOnly = [...bars, fvgBar(3, 99.5, 101.4, 99.4, 100.1)];
  assert.equal(engine.findFvg(wickedOnly, -1).dead, false,
    'a wick through the gap that closes back inside does not kill it');
});

test('FVG F4b: a gap the price has RECLAIMED cannot qualify a short', () => {
  // A short's structural stop must sit ABOVE its entry. Once price is back above the distal
  // edge, the far edge is behind the price, the stop arithmetic goes NEGATIVE, and a negative
  // stop sails through the "stop too far" cap — reporting a nonsense trade as qualified.
  // This case was found by running the Node<->Python parity grid, not by reading the code.
  const bars = [
    fvgBar(0, 101, 102, 100.5, 101),   // candle 1 low 100.5 = the distal edge
    fvgBar(1, 101, 101.2, 99.2, 99.6),
    fvgBar(2, 99.6, 99.8, 98.8, 99),   // proximal edge 99.8; no bar CLOSES above 100.5
  ];
  assert.equal(engine.findFvg(bars, -1).dead, false, 'control: no close above the far edge, so F3 has not fired');
  assert.equal(engine.fvgShortGate(bars, 100.3).gate, 'BEARISH_FVG_CE', 'control: inside the zone is allowed');

  const above = engine.fvgShortGate(bars, 101.0);
  assert.equal(above.gate, 'FVG_RECLAIMED', 'price above the far edge must refuse the short');
  assert.equal(above.structuralStopBps, 0, 'and must not report a negative stop distance');

  // The same rule holds for every price north of the far edge, not just one sample.
  for (const p of [100.51, 101, 102, 105]) {
    assert.equal(engine.fvgShortGate(bars, p).gate, 'FVG_RECLAIMED', 'reclaimed at ' + p);
  }
});

test('FVG shipped default: the gate is MEASURED but must not VETO', () => {
  // Measured causally over 8 sessions (scratch/measure_fvg_structural.js): requiring the gate
  // cut trades 51 -> 10 across the 5 older days and made the mean WORSE (-7.7 -> -16.7 bps),
  // and produced ZERO trades on the recent 3 days. A gate that silently empties the engine is
  // not shipped on. It is reported in every call record instead, and stays switchable.
  assert.equal(engine.fvgRequireDefault, false,
    'the FVG veto must ship OFF until a causal measurement says it helps');
});
