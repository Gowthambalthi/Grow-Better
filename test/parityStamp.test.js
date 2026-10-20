'use strict';

/**
 * THE BACKTEST CROSS-CHECK ON A LIVE CALL.
 *
 * The owner's rule: a live call is only correct if the backtest, replaying the same stock's same
 * bars, takes the same trade at the same minute with the same stop and target. This stamps that
 * answer onto the call so the Telegram alert and the board can show it at the moment it matters.
 *
 * The case is real: FILATEX 2026-09-23, FG01 LONG on the 11:02 bar (stop 108.865, T1 109.987).
 * It is the trigger the live-vs-backtest parity run matched exactly, so it is also the case a
 * regression would break first.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { stamp, describe } = require('../strategies/orderflow/parityStamp');

const DAY = '2026-09-23';
const SYM = 'FILATEX';

function tsToMs(ts) {
  const s = String(ts).replace('T', ' ');
  return Date.parse(s.length <= 16 ? s + ':00+05:30' : s + '+05:30');
}

function corpusBars() {
  for (const d of ['data/ohlcv_1m_live', 'data/ohlcv_1m_live_b']) {
    const f = path.resolve(__dirname, '..', d, SYM + '.json');
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return j.candles
      .filter((c) => String(c[0]).slice(0, 10) === DAY)
      .map((c) => ({ t: tsToMs(c[0]), ts: String(c[0]), o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] }));
  }
  return null;
}

const all = corpusBars();

test('a call that matches the backtest on the same bar is stamped MATCH', (t) => {
  if (!all) return t.skip('corpus not present');
  const cut = all.findIndex((b) => b.ts === DAY + ' 11:02');
  assert.ok(cut > 0, 'the 11:02 bar must exist for this case to mean anything');

  const p = stamp({ symbol: SYM, setup: 'FG01', side: 'LONG', stopLoss: 108.865345, target: 109.98702 },
    all.slice(0, cut + 1));

  assert.equal(p.status, 'MATCH');
  assert.equal(p.decisionBar, DAY + ' 11:02');
  assert.ok(p.backtestTriggers >= 1, 'the replay must have found the trigger it is agreeing with');
  assert.match(describe(p), /MATCH/);
});

test('a moved stop is a difference, not agreement', (t) => {
  if (!all) return t.skip('corpus not present');
  const cut = all.findIndex((b) => b.ts === DAY + ' 11:02');
  const p = stamp({ symbol: SYM, setup: 'FG01', side: 'LONG', stopLoss: 100, target: 109.98702 },
    all.slice(0, cut + 1));

  assert.equal(p.status, 'PLAN_DIFFERS');
  assert.match(describe(p), /PLAN DIFFERS/);
});

test('a call inside the backtest warmup is UNMEASURED, never MATCH', (t) => {
  if (!all) return t.skip('corpus not present');
  // Bar 20 of the day: the live server may arm here, but the measured backtest never did.
  const p = stamp({ symbol: SYM, setup: 'FG01', side: 'LONG', stopLoss: 1, target: 2 }, all.slice(0, 20));
  assert.equal(p.status, 'OUTSIDE_WARMUP');
  assert.match(describe(p), /UNMEASURED/);
});

test('a setup with no backtest engine reports UNVERIFIED rather than a silent pass', () => {
  const p = stamp({ symbol: 'X', setup: 'OF_MOMENTUM', side: 'LONG', stopLoss: 1, target: 2 },
    [{ t: Date.now(), o: 1, h: 1, l: 1, c: 1, v: 1 }, { t: Date.now() + 60000, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
  assert.equal(p.status, 'UNVERIFIED');
  assert.match(describe(p), /UNVERIFIED/);
});

test('a call with no closed bar is not verified', () => {
  const p = stamp({ symbol: 'X', setup: 'FG01', side: 'LONG' }, []);
  assert.equal(p.status, 'UNVERIFIED');
});

test('the verdict reaches the board payload', () => {
  // The badge renders from the row, and every reader gets its row from `rowOf()`. A verdict
  // saved on the call but dropped in the conversion would be invisible on the page while the
  // Telegram alert showed it — the exact two-answers-to-one-question failure rowOf exists to
  // prevent.
  const engine = require('../strategies/orderflow/liveMinuteEngine');
  const id = 'CALL-TESTPARITY-2026-09-23-999';
  engine.calls.set(id, {
    id, date: '2026-09-23', timeIST: '11:03', timestamp: Date.UTC(2026, 8, 23, 5, 33),
    symbol: 'TESTPARITY', side: 'LONG', action: 'BUY', status: 'ARMED',
    limitEntry: 100, stopLoss: 98, target: 104, engine: 'FVG', strategyType: 'INTRADAY',
    parity: { status: 'MATCH', decisionBar: '2026-09-23 11:02', strategy: 'GB01' },
  });
  try {
    const row = engine.getActiveCandidates().find((r) => r.symbol === 'TESTPARITY');
    assert.ok(row, 'the call must appear on the board');
    assert.equal(row.parity.status, 'MATCH');
    assert.equal(row.parity.decisionBar, '2026-09-23 11:02');
  } finally {
    engine.calls.delete(id);
  }
});

test('a call with no verdict carries null, never a fake MATCH', () => {
  const engine = require('../strategies/orderflow/liveMinuteEngine');
  const id = 'CALL-TESTPARITY-2026-09-23-998';
  engine.calls.set(id, {
    id, date: '2026-09-23', timeIST: '11:03', timestamp: Date.UTC(2026, 8, 23, 5, 33),
    symbol: 'TESTPARITY2', side: 'LONG', action: 'BUY', status: 'ARMED',
    limitEntry: 100, stopLoss: 98, target: 104, engine: 'FVG', strategyType: 'INTRADAY',
  });
  try {
    const row = engine.getActiveCandidates().find((r) => r.symbol === 'TESTPARITY2');
    assert.equal(row.parity, null);
  } finally {
    engine.calls.delete(id);
  }
});
