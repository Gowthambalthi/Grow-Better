'use strict';

/**
 * DAY CONTEXT ON GB01 — RECORDED, NOT FILTERED.
 *
 * The proposed gate was "do not go long a stock that is down X% today after being
 * up yesterday". It was measured on 1031 symbols and came back UNSUPPORTED and
 * unmeasurable: the cell holds 3-6 trades out of 227 longs, and zero above 1.5%.
 * See the block comment on `blockLongAfterUpDay` in strategies/fvg/index.js.
 *
 * So the shipped state is: the two numbers are recorded on every signal, and the
 * filter is null. These tests pin exactly that, because the failure mode to guard
 * against is not "the gate is wrong" — it is "the gate turned itself on", which
 * is the OF_MOMENTUM bug in a different costume.
 *
 *   1. the DEFAULTS gate is off, and a signal that WOULD be blocked still fires;
 *   2. the recorded numbers are the real ones (today's move from today's open,
 *      yesterday's close over the close before it) — not zeros, not nulls;
 *   3. when enabled deliberately, the gate refuses by name and records the two
 *      numbers it refused on, and it does NOT fire when yesterday was down.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const fvg = require('../strategies/fvg');
const { createLiveAdapter } = require('../strategies/fvg/liveAdapter');

const MIN = 60000;
const DAY1 = '2026-10-13';
const DAY2 = '2026-10-14';
const DAY3 = '2026-10-15';

/** "YYYY-MM-DD HH:MM" from a minute offset after 09:15. */
function at(day, minute) {
  const m = 9 * 60 + 15 + minute;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return day + ' ' + hh + ':' + mm;
}

/** A flat, boring session. Only its CLOSE matters: it is what the next day reads. */
function flatDay(day, price, bars) {
  const out = [];
  for (let i = 0; i < bars; i++) {
    out.push([at(day, i), price, price + 0.2, price - 0.2, price, 5000]);
  }
  return out;
}

/**
 * Day 3 opens at 110 and falls ~4%, then rallies enough to print a bullish 5m
 * imbalance BELOW the open and retests it once. The entry therefore sits below
 * the day's first open, which is the only situation the proposed gate describes.
 *
 * THE MINUTE OFFSETS ARE BUCKET-ALIGNED. 5m frames are bucketed from 09:15, so
 * offsets 0-4 are the first candle, 5-9 the second, and so on. Getting this wrong
 * puts the "gap" inside a single bucket, where it cannot exist.
 *
 *   09:15-09:34  (offsets 0-19)  decline 110.0 -> 104.7, no zone
 *   09:35-09:39  (20-24) candle A, high 104.8
 *   09:40-09:44  (25-29) candle B rallies to 107.1
 *   09:45-09:49  (30-34) candle C, low 105.6  -> A.high 104.8 < C.low 105.6
 *                                                zone [104.8, 105.6]
 *   09:50        (35)   first bar of the next bucket; the zone becomes knowable,
 *                       and this bar must NOT touch it
 *   09:51        (36)   dips to 105.0, closes 105.5 -> the retest, entry 105.5
 */
function day3Rows() {
  const rows = [];
  // A steady decline from 110.0 to 104.7 over twenty minutes.
  let px = 110.0;
  for (let i = 0; i < 20; i++) {
    const next = +(px - 0.28).toFixed(2);
    rows.push([i, px, +(px + 0.12).toFixed(2), +(next - 0.08).toFixed(2), next, 6000]);
    px = next;
  }
  // A — 09:35-09:39, high 104.8
  rows.push([20, 104.7, 104.8, 104.1, 104.3, 6000]);
  rows.push([21, 104.3, 104.6, 104.0, 104.5, 6000]);
  rows.push([22, 104.5, 104.7, 104.2, 104.6, 6000]);
  rows.push([23, 104.6, 104.8, 104.3, 104.7, 6000]);
  rows.push([24, 104.7, 104.8, 104.4, 104.7, 6000]);
  // B — 09:40-09:44, the rally that leaves the imbalance behind
  rows.push([25, 104.7, 105.4, 104.6, 105.2, 9000]);
  rows.push([26, 105.2, 105.9, 105.1, 105.7, 9000]);
  rows.push([27, 105.7, 106.4, 105.6, 106.2, 9000]);
  rows.push([28, 106.2, 106.8, 106.1, 106.6, 9000]);
  rows.push([29, 106.6, 107.1, 106.5, 107.0, 9000]);
  // C — 09:45-09:49, low 105.6 (above A's high of 104.8, so the zone is real)
  rows.push([30, 107.0, 107.2, 106.4, 106.6, 9000]);
  rows.push([31, 106.6, 106.8, 106.2, 106.4, 9000]);
  rows.push([32, 106.4, 106.6, 106.2, 106.5, 9000]);
  rows.push([33, 106.5, 106.7, 106.3, 106.6, 9000]);
  rows.push([34, 106.6, 106.8, 105.6, 105.8, 9000]);
  // 09:50 — zone is knowable here; deliberately does not touch it
  rows.push([35, 105.8, 106.2, 105.9, 106.1, 7000]);
  // 09:51 — the retest: dips into 105.0, closes 105.5, 42% of its range on the
  // rejection side (> wickRatio 0.35), on heavy volume (> minVolRatio 1.0)
  rows.push([36, 106.1, 106.2, 105.0, 105.5, 11000]);
  return rows;
}

/** The planner's ATR floor is the measured regime gate; a wiring test must not be
 *  blocked by it (same permissive arm the other GB01 tests use). */
const PERMISSIVE = { confirmMtfTrend: false, planner: { minAtrPct: 0, maxRangePosPct: 100, minRR1: 0.1 } };

/**
 * One continuous tape across three sessions — which is what the engine sees in
 * the backtest — so `prevDay` and `prevPrevDay` are built by the session tracker
 * itself rather than handed in as fixtures.
 */
/**
 * The engines read BARS AS TUPLES — [time, open, high, low, close, volume] — not
 * objects. Handing them objects leaves every OHLC read undefined and the engine
 * silently produces nothing, which is exactly how this fixture failed the first
 * time it ran.
 */
function tape(options) {
  const opts = options || {};
  const day1Close = opts.day1Close != null ? opts.day1Close : 100;
  const day2Close = opts.day2Close != null ? opts.day2Close : 103;
  return [
    ...flatDay(DAY1, day1Close, 30),
    ...flatDay(DAY2, day2Close, 30),
    ...day3Rows().map(([m, o, h, l, c, v]) => [at(DAY3, m), o, h, l, c, v]),
  ];
}

function run(config) {
  const engine = fvg.createEngine(Object.assign({}, PERMISSIVE, config || {}));
  const bars = tape(config && config.__tape);
  let last = null;
  for (let i = 0; i < bars.length; i++) {
    const s = engine.onBar(bars, i);
    if (s) last = s;
  }
  return last;
}

test('the gate ships OFF, and a long that WOULD be blocked still fires', () => {
  assert.equal(fvg.DEFAULTS.blockLongAfterUpDay, null,
    'the day-context filter must default to null: absent configuration means OFF, ' +
    'never "on because nobody set the variable"');

  const sig = run({});
  assert.ok(sig, 'with the filter off, the crafted retest must still produce a signal');
  assert.equal(sig.ok, true);
  assert.equal(sig.side, 'LONG');
  assert.equal(sig.gate, undefined, 'nothing refused it');
});

test('the day moved and yesterday moved are RECORDED, and they are not zeros', () => {
  const sig = run({});
  assert.ok(sig && sig.ok, 'precondition: a signal fired');

  // Entry 105.5 from a day open of 110.0.
  const expectedDay = ((105.5 / 110.0) - 1) * 100;
  assert.ok(Math.abs(sig.setupData.dayChangePct - expectedDay) < 1e-9,
    'dayChangePct is measured from TODAY\'S FIRST OPEN (' + expectedDay.toFixed(3) + '%), got ' +
    sig.setupData.dayChangePct);
  assert.ok(sig.setupData.dayChangePct < -4,
    'this tape is genuinely a down day, so the fixture is testing the right situation');

  // Yesterday closed 103, the day before 100.
  const expectedPrev = ((103 / 100) - 1) * 100;
  assert.ok(Math.abs(sig.setupData.prevDayPct - expectedPrev) < 1e-9,
    'prevDayPct is yesterday\'s close over the close before it (' + expectedPrev.toFixed(3) +
    '%), got ' + sig.setupData.prevDayPct);
});

test('the numbers are NULL when the history is too short, never zero', () => {
  // Only today's tape: there is no yesterday to compare with. A missing yesterday
  // is not a flat yesterday, and a zero here would silently bucket the stock.
  const engine = fvg.createEngine(Object.assign({}, PERMISSIVE));
  const bars = day3Rows().map(([m, o, h, l, c, v]) => [at(DAY3, m), o, h, l, c, v]);
  let last = null;
  for (let i = 0; i < bars.length; i++) {
    const s = engine.onBar(bars, i);
    if (s) last = s;
  }
  assert.ok(last && last.ok, 'precondition: the retest still fires without prior days');
  assert.equal(last.setupData.prevDayPct, null,
    'no yesterday means null, not 0.00% — they are different facts');
  assert.equal(typeof last.setupData.dayChangePct, 'number',
    'today\'s move is knowable from the first bar of today');
});

test('when enabled deliberately, the gate refuses by name and says what it refused on', () => {
  const sig = run({ blockLongAfterUpDay: { dropPct: 0.5, minPrevDayPct: 0 } });
  assert.ok(sig, 'a refusal is still an answer the caller must see');
  assert.equal(sig.ok, false, 'down 4.2% after an up day is exactly the case the gate names');
  assert.equal(sig.gate, 'DAY_CONTEXT', 'the refusal carries its own gate name, not a generic one');
  assert.ok(Array.isArray(sig.reject) && sig.reject.length >= 2,
    'the refusal must show the two numbers it used: ' + JSON.stringify(sig.reject));
  assert.ok(/-4\.0/.test(sig.reject[0]) || /-4\.1/.test(sig.reject[0]),
    'the reject line quotes the day move: ' + sig.reject[0]);
  // The numbers are still recorded on the refused signal.
  assert.ok(sig.setupData.dayChangePct < -4);
  assert.ok(Math.abs(sig.setupData.prevDayPct - 3) < 1e-9);
});

test('the gate does not fire when yesterday was DOWN — that is a different situation', () => {
  // Yesterday fell (100 -> 97). "Down today after an up day" does not describe it.
  const engine = fvg.createEngine(Object.assign({}, PERMISSIVE, {
    blockLongAfterUpDay: { dropPct: 0.5, minPrevDayPct: 0 },
  }));
  const bars = tape({ day1Close: 100, day2Close: 97 });
  let last = null;
  for (let i = 0; i < bars.length; i++) {
    const s = engine.onBar(bars, i);
    if (s) last = s;
  }
  assert.ok(last, 'the setup is still there');
  assert.equal(last.ok, true, 'a down day after a DOWN day is not what the gate describes');
  assert.ok(last.setupData.prevDayPct < 0, 'and the recorded number proves it: ' + last.setupData.prevDayPct);
});

test('the LIVE adapter carries yesterday\'s close across the session reset', () => {
  // The live adapter builds a fresh engine every session fed only today's bars,
  // so without a carried close `prevDay` is null for the whole live day and the
  // numbers can never be collected from the tape this was built for.
  const adapter = createLiveAdapter({ config: PERMISSIVE });
  const SYM = 'CTX';
  const live = (rows) => rows.map(([time, o, h, l, c, v]) => ({
    t: Date.parse(time.replace(' ', 'T') + ':00+05:30'), o, h, l, c, v,
  }));
  const feedDay = (rows) => {
    const bars = live(rows);
    let sig = null;
    for (let i = 0; i < bars.length; i++) {
      const s = adapter.push(SYM, bars.slice(0, i + 1), bars[i].t + 61000);
      if (s) sig = s;
    }
    return sig;
  };

  assert.equal(feedDay(flatDay(DAY1, 100, 30)), null, 'day 1 has no gap');
  assert.equal(adapter.priorClosesOf(SYM).length, 0, 'nothing is remembered before a day ends');
  assert.equal(feedDay(flatDay(DAY2, 103, 30)), null, 'day 2 has no gap');
  assert.deepEqual(adapter.priorClosesOf(SYM), [100], 'day 1\'s close is remembered at the reset');

  const sig = feedDay(day3Rows().map(([m, o, h, l, c, v]) => [at(DAY3, m), o, h, l, c, v]));
  assert.ok(sig, 'the third session\'s retest must reach the live caller');
  assert.equal(sig.ok, true);
  assert.deepEqual(adapter.priorClosesOf(SYM), [100, 103], 'both prior closes are kept, oldest first');
  assert.ok(Math.abs(sig.setupData.prevDayPct - 3) < 1e-9,
    'on the LIVE path yesterday is known: expected +3%, got ' + sig.setupData.prevDayPct);
  assert.ok(sig.setupData.dayChangePct < -4,
    'and today\'s move is measured from today\'s open: ' + sig.setupData.dayChangePct);

  // A reset IS a session boundary: it must keep the history and add today's close,
  // in order, rather than wiping either. That is what the engine asks for at a
  // rollover — drop the engines, keep the days.
  adapter.reset();
  assert.deepEqual(adapter.priorClosesOf(SYM), [103, 105.5],
    'the rollover records today\'s close and keeps the two-day window in order');
});

test('the threshold is the configured one, not a hidden constant', () => {
  // dropPct 10% cannot be met by a 4.2% decline.
  const sig = run({ blockLongAfterUpDay: { dropPct: 10, minPrevDayPct: 0 } });
  assert.ok(sig && sig.ok === true,
    'a threshold the tape does not meet must not refuse — the gate reads its config');
});
