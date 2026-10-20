'use strict';

/**
 * A NEW TAPE DAY MUST START FROM AN EMPTY ENGINE.
 *
 * Every per-session value the engine holds is session-scoped, but nothing cleared it: the
 * constructor was the only place `symBars`, `prevPrice`, `book`, `calls`, `closedCalls`,
 * `structRefusals` and `sessionClosed` were set. The scan walks the WHOLE `symBars` array to get
 * VWAP, day high/low and `firstPrice = bars[0].o` — and the array holds 390 bars, so ~375 of them
 * belong to the PREVIOUS session. On day two the `dayChangePct > 0.3` / `< -0.3` gates therefore
 * compared today's price against yesterday's open, and VWAP was a two-day average. Measured on the
 * recorded tapes 2026-10-14: the same 2026-10-13 tape, replayed ALONE, closed 40 calls for
 * +₹3,201; as the third day of a three-day replay it closed 192 for -₹99.50. The shape A/B that
 * produced those numbers was in-sample AND mis-scoped until this boundary existed.
 *
 * `sessionClosed` is the same defect with teeth: it is set at the 15:30 close and was only ever
 * initialised false in the constructor, so from day two onward `closeSession()` returned on its own
 * guard and a day's book was NEVER settled at its close. The 2026-10-13 replay ended holding six
 * calls still ARMED that a real session would have settled at 15:30.
 *
 * The boundary is decided by the TICK's own timestamp, so the same code path serves the live wire
 * and a replayed tape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads: settlement writes a day book.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'day-rollover-'));
process.env.GB_ORDERFLOW_DIR = DIR;

// AND THE SENDER IS STUBBED BEFORE THE ENGINE IS REQUIRED. Closing a session dispatches the daily
// scorecard, so an unstubbed run of this very test would page the owner from a unit test. The
// engine holds the function reference it read at require time, so the stub has to come first.
const telegram = require('../common/notifications/telegramService');
telegram.sendPhoneNotification = async () => ({ success: true, sentTo: ['STUBBED-IN-TEST'] });

const engine = require('../strategies/orderflow/liveMinuteEngine');

/** Epoch ms for an IST wall-clock moment. */
const ist = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 5, mm - 30);

const SYM = 'ROLLTEST';

function tick(ms, price, extra = {}) {
  return { s: SYM, p: price, q: 5, t: ms, ...extra };
}

function reset() {
  engine.today = '2026-10-07';
  engine.replayTimeMs = null;
  engine.lastRollover = null;
  engine.sessionClosed = false;
  engine.symBars.clear();
  engine.prevPrice.clear();
  engine.book.clear();
  engine.calls.clear();
  engine.closedCalls.length = 0;
  engine.structRefusals = { noStructure: 0, wrongSide: 0, tooFar: 0, long: 0, short: 0 };
}

test('a tick inside the same day never rolls the engine over', () => {
  reset();
  engine.ingestTick(tick(ist(2026, 10, 7, 10, 0), 100), true);
  engine.ingestTick(tick(ist(2026, 10, 7, 10, 5), 101), true);

  assert.equal(engine.lastRollover, null, 'no boundary was crossed');
  assert.equal(engine.today, '2026-10-07', 'the session day is unchanged');
  assert.equal(engine.symBars.get(SYM).length, 2, 'both bars of the day are still held');
});

test('a tick dated BEFORE today NEVER rolls the session backwards or clears the book', () => {
  // 2026-10-19: the log read `DAY ROLLOVER 2026-10-19 -> 2026-10-17` and the day's calls vanished
  // while their Telegram messages stayed in the chat. A stale/backfilled tick must not be treated
  // as a new session — it would settle and clear a book that is still live.
  reset();
  engine.ingestTick(tick(ist(2026, 10, 7, 10, 0), 100), true);
  engine.calls.set('CALL-ROLLTEST-LIVE', { id: 'CALL-ROLLTEST-LIVE', symbol: SYM, status: 'ARMED', limitEntry: 100 });

  // Five days in the past — the shape a backfilled bar or a replayed previous session takes.
  engine.ingestTick(tick(ist(2026, 10, 2, 10, 0), 90), true);

  assert.equal(engine.today, '2026-10-07', 'the session day is unchanged by a past tick');
  assert.equal(engine.lastRollover, null, 'no boundary was crossed');
  assert.equal(engine.calls.size, 1, 'THE LIVE BOOK SURVIVES — this is the bug that emptied the table');
  assert.equal(engine.symBars.get(SYM).length, 1, 'the past tick does not add a bar to today');
});

test('the first tick of a new day drops the closed day\'s bars, book, calls and latch', () => {
  reset();
  // Day one, including a level-1 book snapshot and an open call, then the 15:30 close's latch.
  engine.ingestTick(tick(ist(2026, 10, 7, 10, 0), 100, { bid: 99.9, bidq: 500, ask: 100.1, askq: 400 }), true);
  engine.ingestTick(tick(ist(2026, 10, 7, 10, 1), 101), true);
  engine.calls.set('CALL-ROLLTEST-X', { id: 'CALL-ROLLTEST-X', symbol: SYM, status: 'ARMED', limitEntry: 101 });
  engine.structRefusals.noStructure = 36;
  engine.sessionClosed = true;                       // as the 15:30 close leaves it

  assert.equal(engine.book.has(SYM), true, 'day one held a book snapshot');

  // Day two: a tick with NO book of its own. If the book had leaked, it would still be there.
  engine.ingestTick(tick(ist(2026, 10, 12, 10, 0), 200), true);

  assert.equal(engine.today, '2026-10-12', 'the engine moved to the new session day');
  assert.deepEqual(
    { from: engine.lastRollover.from, to: engine.lastRollover.to, carried: engine.lastRollover.carried },
    { from: '2026-10-07', to: '2026-10-12', carried: 1 },
    'the boundary is recorded with what it carried');
  assert.equal(engine.book.has(SYM), false, 'yesterday\'s book snapshot is gone');
  assert.equal(engine.calls.size, 0, 'yesterday\'s call book is gone');
  assert.equal(engine.closedCalls.length, 0, 'and so is its closed list');
  assert.equal(engine.structRefusals.noStructure, 0, 'the refusal ledger restarts');
  assert.equal(engine.sessionClosed, false, 'the 15:30 latch is released for the new session');

  const bars = engine.symBars.get(SYM);
  assert.equal(bars.length, 1, 'only the new day\'s bar is held');
  assert.ok(bars[0].t >= ist(2026, 10, 12, 0, 0), 'and it belongs to the new day');
});

test('day change and VWAP read today\'s bars only (the gate the leak corrupted)', () => {
  reset();
  // Day one: opens at 100 and closes at 130 — a +30% session.
  engine.ingestTick(tick(ist(2026, 10, 7, 9, 15), 100), true);
  engine.ingestTick(tick(ist(2026, 10, 7, 15, 20), 130), true);

  // Day two: opens at 200 and trades 201 — a +0.5% session.
  engine.ingestTick(tick(ist(2026, 10, 12, 9, 15), 200), true);
  engine.ingestTick(tick(ist(2026, 10, 12, 9, 20), 201), true);

  const bars = engine.symBars.get(SYM);
  // These are the exact expressions scanMinuteTape() derives from the array.
  const firstPrice = bars[0].o || bars[bars.length - 1].c;
  const dayChangePct = ((bars[bars.length - 1].c - firstPrice) / firstPrice) * 100;
  const vwapDen = bars.reduce((s, b) => s + b.v, 0);

  assert.equal(firstPrice, 200, 'the day-change baseline is today\'s open, not yesterday\'s');
  assert.ok(Math.abs(dayChangePct - 0.5) < 1e-9,
    `day change is today's 0.5%, not yesterday's +30% (got ${dayChangePct})`);
  assert.equal(vwapDen, 10, 'VWAP sums two bars of volume, not four (10 = 2 bars x 5 shares)');
});

test('a day whose tape ended before 15:30 has its open calls settled at the boundary', () => {
  reset();
  engine.ingestTick(tick(ist(2026, 10, 7, 14, 55), 100), true);
  engine.calls.set('CALL-ROLLTEST-OPEN', {
    id: 'CALL-ROLLTEST-OPEN', symbol: SYM, status: 'ARMED', action: 'BUY', side: 'LONG',
    limitEntry: 100, shares: 1, ltp: 101,
  });
  // No 15:30 close ever ran for this day (sessionClosed is still false).
  engine.ingestTick(tick(ist(2026, 10, 12, 9, 15), 200), true);

  assert.equal(engine.lastRollover.openSettled, 1,
    'the still-open call was settled at the boundary, not silently dropped');
});

test('the new day resumes its own book, written earlier by another engine or a restart', () => {
  reset();
  // A record already on disk for the INCOMING day: another engine (or an earlier restart) wrote
  // it. Dropping it would recreate the exact durability bug test/callBookDurability.test.js pins —
  // the boundary must clear YESTERDAY, not today's record.
  const priorRecord = {
    id: 'CALL-ROLLTEST-PRIOR', engine: 'SWEEP_FVG', symbol: 'OTHERENGINE',
    side: 'SHORT', status: 'WON', exitReason: 'target', netBps: 41,
  };
  const incoming = path.join(DIR, 'daily_calls_2026-10-13.json');
  fs.writeFileSync(incoming, JSON.stringify([priorRecord]), 'utf8');
  try {
    engine.ingestTick(tick(ist(2026, 10, 12, 10, 0), 100), true);   // day one, with a call of our own
    engine.ingestTick(tick(ist(2026, 10, 13, 9, 15), 200), true);   // boundary into day two

    assert.equal(engine.today, '2026-10-13', 'the engine moved to the incoming day');
    assert.equal(engine.calls.size, 1, 'the incoming day\'s own record is loaded, not dropped');
    assert.deepEqual(engine.calls.get('CALL-ROLLTEST-PRIOR'), priorRecord, 'and it comes back verbatim');
    assert.equal(engine.closedCalls.length, 1, 'a settled record reaches the closed list as at construction');
  } finally {
    fs.rmSync(incoming, { force: true });
  }
});

test('the released latch lets the new session settle its own 15:30 close', () => {
  reset();
  engine.sessionClosed = true;                       // day one already closed normally
  engine.ingestTick(tick(ist(2026, 10, 12, 9, 15), 200), true);
  engine.calls.set('CALL-ROLLTEST-Y', {
    id: 'CALL-ROLLTEST-Y', symbol: SYM, status: 'ARMED', action: 'BUY', side: 'LONG',
    limitEntry: 200, shares: 1, ltp: 205,
  });

  engine.closeSession(ist(2026, 10, 12, 15, 31));

  const settled = engine.calls.get('CALL-ROLLTEST-Y');
  assert.equal(settled.exitReason, 'SESSION_CLOSE', 'the new day\'s close settled the open call by session close, as live would');
  assert.equal(engine.closedCalls.length, 1, 'and it reached the closed list');
  // SETTLED, NOT WON. The entry was 200 and the last price 205, so the gross points are
  // positive — and this test used to require `status === 'WON'` for exactly that reason.
  // That is the defect the owner reported: the call never touched its target, it was
  // flattened at the bell, and it read as a win in every table that trusted `status`.
  // A level decides a winner; a 15:30 flatten only says where the price happened to be.
  assert.equal(settled.status, 'CLOSED',
    'a 15:30 flatten must not be stamped WON however positive its gross drift was');
  assert.notEqual(settled.status, 'WON', 'and specifically not a win');

  // The engine's own published win rate agrees, and it says so with the corrected rule:
  // the tally counts target hits, and this call hit no target.
  const { tallyOutcomes } = require('../common/market/callBookHistory');
  const tally = tallyOutcomes(engine.closedCalls);
  assert.equal(tally.targetHits, 0, 'no target was hit');
  assert.equal(tally.otherExits, 1, 'it is an exit without a level');
  assert.equal(tally.winRatePct, null, 'with nothing decided there is no rate to report');
  assert.equal(engine.getDailyNet().won, 0, 'and the daily payload counts no win');
});
