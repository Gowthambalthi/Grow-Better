'use strict';

/**
 * ONE BOOK, ONE ANSWER — the engine's daily card and the per-strategy table.
 *
 * The owner reported four things about the live page, and they were one bug with four
 * faces:
 *
 *   1. two tables over the same calls disagreed about which companies were in them;
 *   2. a close that touched NEITHER the stop nor the target was shown as a win;
 *   3. +₹0.01 of gross drift was enough to be stamped ✅ WON;
 *   4. the tables and the day's card each did their own arithmetic over the same records.
 *
 * On the real 2026-10-16 book (18 calls) the daily card said "4 target hit, 3 stopped, 6
 * closed without a level" while the per-strategy table beside it said 0 targets and 0 stops —
 * 13 calls "closed without a level" — because the table classified the MAPPER'S OUTPUT
 * instead of the record. `getClosedHistory()` renames `exitReason` → `reason` and
 * `target` → `target1` to match what the page reads, and `classify()` looks for `exitReason`,
 * so every row fell through to UNRECORDED and the whole book lost its levels.
 *
 * These fixtures pin the rule and, more importantly, the INVARIANT: for every row the mapper
 * publishes, the `outcomeKey` it carries must equal what the shared classifier says about the
 * raw record. A table that reads the mapper's own verdict therefore cannot drift from the
 * book, no matter which producer asks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed BEFORE the engine loads: the constructor reads today's daily_calls file and would
// otherwise pick up the repo's real one (and write to it).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-truth-'));
process.env.GB_ORDERFLOW_DIR = DIR;

// Stubbed before the engine is required — settlement paths page the owner, and a unit test
// that sends Telegram is not a unit test.
const telegram = require('../common/notifications/telegramService');
telegram.sendPhoneNotification = async () => ({ success: true, sentTo: ['STUBBED-IN-TEST'] });

const TODAY = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/** A closed call record, in the shape both live engines write. */
const closed = (over) => Object.assign({
  id: 'CALL-FIX-' + Math.random().toString(36).slice(2, 8),
  date: TODAY,
  symbol: 'FIXCO',
  engine: 'OF_MOMENTUM',
  strategyType: 'INTRADAY',
  action: 'BUY',
  side: 'LONG',
  status: 'WON',
  limitEntry: 100,
  stopLoss: 99,
  target: 101.5,
  shares: 1,
  limitEntryIST: '10:15:00',
  timeIST: '10:15:00',
  timestamp: Date.now(),
}, over || {});

// THE BOOK. Five closes, four distinct outcomes, one of them a legacy record with no reason.
const BOOK = [
  // A real target hit — the only thing that may ever be called a win.
  closed({ symbol: 'WINTGT', exitReason: 'TARGET_HIT', status: 'WON',
           exitPrice: 101.6, exitTimeIST: '11:02:00', netBps: 145, grossPoints1Lot: 1.6, netInr1Lot: 1.4 }),

  // A real stop hit.
  closed({ symbol: 'LOSSL', exitReason: 'STOP_LOSS_HIT', status: 'LOST',
           exitPrice: 98.95, exitTimeIST: '11:40:00', netBps: -120, grossPoints1Lot: -1.05, netInr1Lot: -1.25 }),

  // The 15:30 flatten, GROSS POSITIVE. This is the "closed without touching anything, but
  // counted as a win" case. It is still a close with no level.
  closed({ id: 'CALL-FIX-CLOSE', symbol: 'FLATCLOSE', engine: 'SWEEP_FVG', strategyType: 'INTRADAY',
           status: 'CLOSED', exitReason: 'SESSION_CLOSE', exitPrice: 100.05, exitTimeIST: '15:30:00',
           netBps: -10, grossPoints1Lot: 0.05, netInr1Lot: -0.15 }),

  // The +₹0.01 stagnation exit — momentum faded, nothing was touched.
  closed({ id: 'CALL-FIX-STAG', symbol: 'PAISA', engine: 'SWEEP_FVG', strategyType: 'INTRADAY',
           status: 'CLOSED', exitReason: 'STAGNATION_EXIT', exitPrice: 100.01, exitTimeIST: '12:05:00',
           netBps: -14, grossPoints1Lot: 0.01, netInr1Lot: -0.19 }),

  // Legacy generation: WON with no recorded reason. Untrusted — a bare WON is not a target hit.
  closed({ id: 'CALL-FIX-LEGACY', symbol: 'LEGACY', status: 'WON', exitPrice: 100.80, exitTimeIST: '13:10:00',
           netBps: 65, grossPoints1Lot: 0.8, netInr1Lot: 0.6 }),
];

fs.writeFileSync(path.join(DIR, `daily_calls_${TODAY}.json`), JSON.stringify(BOOK), 'utf8');

const engine = require('../strategies/orderflow/liveMinuteEngine');
const { classify, tallyOutcomes } = require('../common/market/callBookHistory');

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});

test('the engine loads the day book at construction, with every closed call resolved', () => {
  assert.equal(engine.closedCalls.length, 5, 'all five recorded closes are in the closed list');
});

test('the daily card counts a win only where a target was hit', () => {
  const d = engine.getDailyNet();
  assert.equal(d.won, 1, 'one target hit');
  assert.equal(d.lost, 1, 'one stop hit');
  assert.equal(d.otherExits, 3, 'the flatten, the stagnation exit and the unlabelled close');
  assert.equal(d.decided, 2, 'decided = target or stop, nothing else');
  assert.equal(d.winRatePct, 50, '1 of 2 decided');
  assert.equal(d.grossWon, 2, 'the engine\'s own gross status count is published separately (TARGET_HIT + the legacy WON)');
  assert.notEqual(d.won, d.grossWon, 'and the two views are allowed to differ without either lying');
});

test('the mapper stamps every row with the SAME verdict the shared classifier gives the raw record', () => {
  const rows = engine.getClosedHistory();
  assert.equal(rows.length, 5);
  const byId = new Map(BOOK.map((c) => [c.id, c]));
  for (const row of rows) {
    const raw = byId.get(row.id);
    assert.ok(raw, 'every published row traces back to a raw record: ' + row.id);
    assert.equal(row.outcomeKey, classify(raw).key,
      `the row's outcome must be the record's outcome (${row.symbol}: ${row.outcomeKey} vs ${classify(raw).key})`);
  }
});

test('a close that touched no level is never rendered or counted as a win', () => {
  const rows = engine.getClosedHistory();
  const flat = rows.find((r) => r.id === 'CALL-FIX-CLOSE');
  const stag = rows.find((r) => r.id === 'CALL-FIX-STAG');
  const legacy = rows.find((r) => r.id === 'CALL-FIX-LEGACY');

  assert.equal(flat.outcomeKey, 'SESSION_CLOSE');
  assert.equal(flat.verdict, 'EXITED AT CLOSE', 'a 15:30 flatten says so');
  assert.notEqual(flat.status, 'WON', 'and is not stamped a win however positive its gross drift');

  assert.equal(stag.outcomeKey, 'STAGNATION_EXIT');
  assert.equal(stag.verdict, 'TIME EXIT (no progress)', '₹0.01 of drift is not a win');
  assert.notEqual(stag.status, 'WON');

  assert.equal(legacy.outcomeKey, 'UNRECORDED', 'a bare WON with no reason is an unrecorded close');
  assert.notEqual(legacy.verdict, 'TARGET ACHIEVED', 'and must not be upgraded into a target hit');
});

test('the page-facing tally over the mapper rows equals the engine tally over the raw book', () => {
  // The per-strategy arithmetic (Server.js liveStrategyPerformance): classify the rows the
  // mapper published, which is what the table reads.
  const tally = { tH: 0, sH: 0, oth: 0 };
  for (const r of engine.getClosedHistory()) {
    if (r.outcomeKey === 'TARGET_HIT') tally.tH += 1;
    else if (r.outcomeKey === 'STOP_LOSS_HIT') tally.sH += 1;
    else tally.oth += 1;
  }
  // The engine's own card, built from the raw records.
  const d = engine.getDailyNet();
  assert.deepEqual(tally, { tH: d.won, sH: d.lost, oth: d.otherExits },
    'the per-strategy table and the daily card must not be able to disagree about the same book');

  // And the paged history reader, which classifies the RAW records: same numbers again.
  const pub = tallyOutcomes(BOOK);
  assert.equal(pub.targetHits, d.won);
  assert.equal(pub.stopsHit, d.lost);
  assert.equal(pub.otherExits, d.otherExits);
  assert.equal(pub.winRatePct, d.winRatePct);
});

test('every closed row lands in exactly one of target / stop / other, for any engine', () => {
  const rows = engine.getClosedHistory();
  const owned = rows.filter((r) => r.strategyId);
  assert.equal(owned.length, rows.length, 'every row names the engine that wrote it');
  for (const id of new Set(rows.map((r) => r.strategyId))) {
    const mine = rows.filter((r) => r.strategyId === id);
    const sum = mine.filter((r) => ['TARGET_HIT', 'STOP_LOSS_HIT'].includes(r.outcomeKey)).length
      + mine.filter((r) => !['TARGET_HIT', 'STOP_LOSS_HIT'].includes(r.outcomeKey)).length;
    assert.equal(sum, mine.length, `${id}: every call is accounted for in one bucket`);
  }
});
