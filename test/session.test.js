'use strict';

/**
 * test/session.test.js
 *
 * Unit test suite for strategy-core/session.js:
 * 1. Default rollover behavior (minSessionBars: 0): any session updates prevDay.
 * 2. minSessionBars guard: full session (>= minSessionBars) updates prevDay.
 * 3. minSessionBars guard: truncated session (< minSessionBars) sets prevDay to null.
 * 4. Recovery: a full session following a truncated session restores prevDay.
 * 5. Opening range, vwap, and rolling tail integrity across sessions.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../strategy-core/session');

function makeBar(dateStr, idx, o, h, l, c, v = 1000) {
  const m = idx % 60;
  const hr = 9 + Math.floor(idx / 60);
  const time = `${dateStr} ${String(hr).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return [time, o, h, l, c, v];
}

test('1. Default minSessionBars: 0 allows any session to update prevDay', () => {
  const session = createSession();
  
  // Day 1: 5 bars only
  for (let i = 0; i < 5; i++) {
    session.onBar(makeBar('2026-06-01', i, 100, 105, 95, 102));
  }
  assert.equal(session.day, '2026-06-01');
  assert.equal(session.prevDay, null, 'No prevDay during the first session');
  assert.equal(session.dayHigh, 105);
  assert.equal(session.dayLow, 95);

  // Day 2 rollover on bar 0
  const isNew = session.onBar(makeBar('2026-06-02', 0, 102, 103, 101, 102));
  assert.equal(isNew, true, 'First bar of Day 2 signals newDay');
  assert.equal(session.day, '2026-06-02');
  assert.notEqual(session.prevDay, null, 'prevDay must be populated with default config');
  assert.equal(session.prevDay.day, '2026-06-01');
  assert.equal(session.prevDay.high, 105);
  assert.equal(session.prevDay.low, 95);
});

test('2. minSessionBars: 375 accepts a full 375-bar session', () => {
  const session = createSession({ minSessionBars: 375 });

  // Day 1: exactly 375 bars
  for (let i = 0; i < 375; i++) {
    session.onBar(makeBar('2026-06-01', i, 100, 110, 90, 100));
  }
  assert.equal(session.dayLength, 375);

  // Day 2 rollover
  session.onBar(makeBar('2026-06-02', 0, 100, 101, 99, 100));
  assert.notEqual(session.prevDay, null, 'Full 375-bar session must qualify as prevDay');
  assert.equal(session.prevDay.day, '2026-06-01');
  assert.equal(session.prevDay.high, 110);
  assert.equal(session.prevDay.low, 90);
});

test('3. minSessionBars: 375 guards against truncated session, resetting prevDay to null', () => {
  const session = createSession({ minSessionBars: 375 });

  // Day 1: full 375 bars
  for (let i = 0; i < 375; i++) {
    session.onBar(makeBar('2026-06-01', i, 100, 110, 90, 100));
  }

  // Day 2 rollover: prevDay is Day 1
  session.onBar(makeBar('2026-06-02', 0, 100, 101, 99, 100));
  assert.notEqual(session.prevDay, null);
  assert.equal(session.prevDay.day, '2026-06-01');

  // Day 2 only completes 10 bars (truncated feed / Muhurat)
  for (let i = 1; i < 10; i++) {
    session.onBar(makeBar('2026-06-02', i, 100, 105, 98, 102));
  }
  assert.equal(session.dayLength, 10);

  // Day 3 rollover: Day 2 was truncated (< 375 bars), so prevDay must be set to null
  session.onBar(makeBar('2026-06-03', 0, 102, 104, 101, 103));
  assert.equal(session.prevDay, null, 'Truncated session cannot qualify as prevDay; must be null');
});

test('4. Recovery: Full session following truncated session restores prevDay', () => {
  const session = createSession({ minSessionBars: 375 });

  // Day 1: 10 bars (truncated)
  for (let i = 0; i < 10; i++) session.onBar(makeBar('2026-06-01', i, 100, 102, 98, 100));

  // Day 2 rollover: prevDay is null
  session.onBar(makeBar('2026-06-02', 0, 100, 101, 99, 100));
  assert.equal(session.prevDay, null);

  // Day 2 completes full 375 bars
  for (let i = 1; i < 375; i++) session.onBar(makeBar('2026-06-02', i, 100, 120, 85, 105));

  // Day 3 rollover: prevDay should be Day 2
  session.onBar(makeBar('2026-06-03', 0, 105, 106, 104, 105));
  assert.notEqual(session.prevDay, null);
  assert.equal(session.prevDay.day, '2026-06-02');
  assert.equal(session.prevDay.high, 120);
  assert.equal(session.prevDay.low, 85);
});
