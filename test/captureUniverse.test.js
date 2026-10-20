/**
 * test/captureUniverse.test.js — WHICH NAMES THE LIVE CAPTURE SUBSCRIBES TO.
 *
 * WHY THIS EXISTS. On 2026-10-18 the capture armed `board.rows` — the rows the board DISPLAYS,
 * which was three symbols — plus backtest/f1/universe.json, for 136 in total, while its own
 * comment claimed the scope was "the board's own OK universe" and board.json reported
 * `notBlocked: 2017`. The cost is not abstract: GB01 measures 1 call per 1,022 symbol-days, so a
 * 136-name tape leaves its tier-2 row empty for about a week, and that silence is indistinguishable
 * from a wiring fault. board.json now publishes `universe.okSymbols` (the LIST, not just a counter)
 * and the decision below is a pure function, so it is pinned here instead of in Server.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { chooseCaptureSymbols, DEFAULT_CAPTURE_LIMIT } = require('../strategies/orderflow/armCapture');

const boardWithList = {
  universe: { okSymbols: ['HDFCBANK', 'reliance', 'TCS-EQ'] },
  rows: [{ symbol: 'AAA', blocked: false }, { symbol: 'BBB', blocked: true }, { symbol: 'CCC' }],
};

test('the board\'s OK LIST is armed, not the rows the board displays', () => {
  const c = chooseCaptureSymbols({ board: boardWithList, extras: [], limit: 100 });
  assert.equal(c.source, 'board.universe.okSymbols');
  assert.deepEqual(c.symbols, ['HDFCBANK', 'RELIANCE', 'TCS'],
    'names are upper-cased and the -EQ suffix is stripped: the broker resolves the plain symbol');
  assert.equal(c.counts.fromOkList, 3);
  assert.equal(c.counts.armed, 3);
});

test('a board.json from before the list existed still arms its unblocked rows', () => {
  const legacy = { rows: [{ symbol: 'AAA' }, { symbol: 'BBB', blocked: true }, { symbol: 'ccc-eq' }] };
  const c = chooseCaptureSymbols({ board: legacy, extras: [], limit: 100 });
  assert.equal(c.source, 'board.rows (legacy shape)');
  assert.deepEqual(c.symbols, ['AAA', 'CCC'], 'a blocked row is never subscribed');
  assert.equal(c.counts.fromRows, 2);
});

test('extras are added, deduped against the board list, and the cap is reported', () => {
  const c = chooseCaptureSymbols({ board: boardWithList, extras: ['RELIANCE', 'INFY'], limit: 3 });
  assert.deepEqual(c.symbols, ['HDFCBANK', 'RELIANCE', 'TCS'], 'the cap keeps the board list first');
  assert.equal(c.counts.available, 4);
  assert.equal(c.counts.armed, 3);
  assert.equal(c.counts.cap, 3);
  assert.equal(c.counts.droppedByCap, 1, 'the drop is counted, so the startup log can state it');
});

test('a cap of 0 means no cap, and the module default applies when nothing is passed', () => {
  const many = { universe: { okSymbols: Array.from({ length: 1200 }, (_, i) => 'SYM' + i) } };
  assert.equal(chooseCaptureSymbols({ board: many, limit: 0 }).symbols.length, 1200,
    'GB_TICK_CAPTURE_LIMIT=0 asks for everything');
  assert.equal(chooseCaptureSymbols({ board: many }).symbols.length, DEFAULT_CAPTURE_LIMIT,
    'unset lands on the module default rather than subscribing to the whole market');
  assert.ok(DEFAULT_CAPTURE_LIMIT > 0 && DEFAULT_CAPTURE_LIMIT <= 1000);
});

test('an empty board yields nothing rather than an invented list', () => {
  const c = chooseCaptureSymbols({ board: {}, extras: [], limit: 500 });
  assert.deepEqual(c.symbols, []);
  assert.equal(c.counts.available, 0);
  assert.equal(c.source, 'extras only');
});
