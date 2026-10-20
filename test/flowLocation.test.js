'use strict';

/**
 * The other two halves of the premise: WHERE price is (S&R levels + the fib golden zone) and WHO is
 * trading (TRVO's time-relative volume and buy/sell split).
 *
 * The checks that matter most here are the two this engine has already been burned by:
 *   * the volume BASELINE. A rolling 20-bar average is manufactured by the very quiet it is meant to
 *     detect, so a dead minute drifts the average down with it and reads as "confirmed". TRVO's
 *     baseline is the same minute on prior sessions; these tests pin that it is built that way and
 *     that it is genuinely unreadable (null, not false) until a prior session exists.
 *   * the PROXY label. The buy/sell split is inferred from where the bar closed in its own range —
 *     there is no aggressor data on this feed (`data/orderflow/` has never held a session). A reading
 *     that can be mistaken for executed flow is worse than no reading, so every one carries the label.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Trvo, classicOsc } = require('../common/market/trvo');
const { SrRegression, goldenZone, rsiSeries, atrSeries } = require('../common/market/srRegression');

const T0 = Date.parse('2026-09-28T09:15:00.000+05:30');
const MS = 60000;

/** n sessions of `per` bars, volumes supplied per session so the baseline is checkable by hand. */
function sessions(volsBySession, per, { flatRange = false } = {}) {
  const bars = [];
  let t = T0;
  for (const vols of volsBySession) {
    for (let k = 0; k < per; k++) {
      bars.push({
        t, o: 100, h: flatRange ? 100 : 100.5, l: flatRange ? 100 : 99.5, c: 100.2, v: vols[k],
      });
      t += MS;
    }
    t += 17 * 3600 * 1000;     // jump to the next session
  }
  return bars;
}

// ---------------------------------------------------------------------------
// 1. TRVO — the volume baseline, which is the whole reason this module exists.
// ---------------------------------------------------------------------------
test('relative volume is measured against the SAME MINUTE on prior sessions, not a rolling window', () => {
  const per = 8;
  const day1 = new Array(per).fill(1000);
  const day2 = new Array(per).fill(2000);
  const day3 = new Array(per).fill(0);
  day3[5] = 6000;                                   // 4x the mean of 1000 and 2000
  const bars = sessions([day1, day2, day3], per);
  const t = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of bars) t.add(b);
  const s = t.series(bars.length - 1);
  const day3Start = 2 * per;
  assert.equal(s.rv[day3Start + 5], 4, '6000 against a mean of 1500 is 4x');
  assert.equal(s.rv[day3Start + 0], 0, 'a zero-volume minute is 0x, not "undefined"');
});

test('a rolling average would have called that dead minute normal — this baseline calls it 0x', () => {
  const per = 8;
  const bars = sessions([new Array(per).fill(1000), new Array(per).fill(1000), new Array(per).fill(0)], per);
  const t = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of bars) t.add(b);
  const s = t.series(bars.length - 1);
  assert.equal(s.rv[bars.length - 1], 0);
  // and with no volume there is no split to read at all: the reading refuses to vote rather than
  // calling zero volume "selling"
  assert.equal(t.reading(bars.length - 1).ok, null);
});

test('the classic oscillator has NO usable zero crossing — it is monotone, so the vote uses the split', () => {
  assert.ok(classicOsc(0) > 0, 'even a zero-volume minute plots above the source\'s zero line');
  assert.ok(Math.abs(classicOsc(0)) < 0.02);
  assert.ok(classicOsc(1.5) > classicOsc(1));
  assert.ok(classicOsc(3) > classicOsc(1.5));
  assert.ok(classicOsc(1e6) < 4, 'saturating, not linear');
});

test('the buy/sell split is a close-in-range PROXY and is labelled one', () => {
  const per = 4;
  const bars = sessions([new Array(per).fill(1000), new Array(per).fill(1000)], per);
  bars[bars.length - 1] = { t: bars[bars.length - 1].t, o: 100, h: 101, l: 99, c: 101, v: 1000 };  // closes at the high
  const t = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of bars) t.add(b);
  const s = t.series(bars.length - 1);
  assert.equal(s.buyPct[bars.length - 1], 1, 'a bar closing at its high is 100% "buy" volume');
  assert.equal(s.sellPct[bars.length - 1], 0);
  const r = t.reading(bars.length - 1);
  assert.equal(r.ok, true);
  assert.match(r.flowSource, /proxy/, 'the reading must never be presentable as executed flow');
  assert.equal(r.proxy, true);
  assert.equal(r.grade, 'normal');
});

test('an unreadable minute is null (no vote), never false (a sell)', () => {
  const per = 4;
  const first = sessions([new Array(per).fill(1000)], per);
  const t1 = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of first) t1.add(b);
  assert.equal(t1.reading(first.length - 1).ok, null, 'no prior session exists yet');
  assert.match(t1.reading(first.length - 1).detail, /baseline/);

  const flat = sessions([new Array(per).fill(1000), new Array(per).fill(1000)], per, { flatRange: true });
  const t2 = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of flat) t2.add(b);
  assert.equal(t2.reading(flat.length - 1).ok, null, 'a zero-range bar has no split to read');
  assert.equal(t2.reading(flat.length - 1).detail, 'flat bar');
});

test('state round-trips, so a restart keeps the same baseline', () => {
  const per = 6;
  const bars = sessions([new Array(per).fill(1000), new Array(per).fill(3000)], per);
  const t = new Trvo({ relativeLen: 6, barsPerSession: per });
  for (const b of bars) t.add(b);
  const back = Trvo.fromJSON(JSON.parse(JSON.stringify(t.toJSON())));
  assert.equal(back.bars.length, t.bars.length);
  assert.equal(back.reading(t.bars.length - 1).rv, t.reading(t.bars.length - 1).rv);
});

// ---------------------------------------------------------------------------
// 2. S&R — the level lifecycle.
//
// The fixtures are built so that exactly ONE pivot exists in the tape. A ramp out of a V also makes
// rising HIGHS, which would register a resistance level and break it several bars later — real
// behaviour, but it would make these tests about the wrong level.
// ---------------------------------------------------------------------------

/** A quiet tape with a single strict pivot LOW at bar 4 (level 90), confirmed at bar 6. */
function quietBase() {
  const rows = [
    { t: T0 + 0 * MS, o: 99.5, h: 100.0, l: 99.0, c: 99.4, v: 1000 },
    { t: T0 + 1 * MS, o: 99.0, h: 99.5, l: 98.5, c: 98.8, v: 1000 },
    { t: T0 + 2 * MS, o: 98.5, h: 99.2, l: 98.2, c: 98.4, v: 1000 },
    { t: T0 + 3 * MS, o: 98.4, h: 99.0, l: 98.0, c: 98.2, v: 1000 },
    { t: T0 + 4 * MS, o: 90.7, h: 91.0, l: 90.0, c: 90.5, v: 1000 },   // the pivot
    { t: T0 + 5 * MS, o: 91.0, h: 95.0, l: 94.0, c: 94.5, v: 1000 },
    { t: T0 + 6 * MS, o: 94.5, h: 94.0, l: 93.0, c: 93.5, v: 1000 },
    { t: T0 + 7 * MS, o: 93.0, h: 93.5, l: 92.0, c: 92.5, v: 1000 },
    { t: T0 + 8 * MS, o: 92.5, h: 92.5, l: 91.5, c: 92.0, v: 1000 },
    { t: T0 + 9 * MS, o: 92.0, h: 92.0, l: 91.0, c: 91.5, v: 1000 },
    { t: T0 + 10 * MS, o: 91.5, h: 91.5, l: 90.5, c: 91.0, v: 1000 },
    { t: T0 + 11 * MS, o: 91.0, h: 91.0, l: 90.0, c: 90.5, v: 1000 },
  ];
  return rows;
}
const withBars = (over) => quietBase().map((b, i) => (over[i] ? Object.assign({ t: b.t, v: 1000 }, over[i]) : b));
const feedSr = (m, rows) => rows.map((r) => m.add(r));

test('the FIRST pivot of a type can never be a regression level — the model has nothing to learn from', () => {
  const m = new SrRegression({ pivotLength: 2, probabilityThreshold: 0.7 });
  const outs = feedSr(m, quietBase());
  assert.equal(m.stats.pivots, 1);
  assert.equal(m.stats.detected, 0, 'predict() returns 0 with no history, and 0 is below any threshold');
  assert.equal(outs[6].pivots[0].byRegression, false);
  assert.equal(outs[6].pivots[0].level, 90);
});

test('a SUPPORT that is pierced and reclaimed is a RETEST (the level HELD) -> BUY', () => {
  const rows = withBars({ 7: { o: 92, h: 93.5, l: 89, c: 92.5 } });   // dips under 90, closes back above
  const m = new SrRegression({ pivotLength: 2, probabilityThreshold: 0 });  // threshold 0 = every level is detected
  const outs = feedSr(m, rows);
  const ev = outs[7].events.find((e) => e.type === 'SUPPORT_RETEST');
  assert.ok(ev, 'the retest must fire');
  assert.equal(ev.side, 'BUY');
  assert.equal(ev.level, 90);
  const r = m.reading(7);
  assert.equal(r.ok, true);
  assert.equal(r.grade, 'held');
});

test('a SUPPORT that closes beyond is a BREAK -> SHORT, and that level is finished', () => {
  const rows = withBars({ 7: { o: 91, h: 91, l: 87, c: 88 } });       // closes BELOW 90, no reclaim
  const m = new SrRegression({ pivotLength: 2, probabilityThreshold: 0 });
  const outs = feedSr(m, rows);
  const ev = outs[7].events.find((e) => e.type === 'SUPPORT_BREAK');
  assert.ok(ev);
  assert.equal(ev.side, 'SHORT');
  assert.equal(m.levels[0].endIndex, 7, 'a broken level ends');

  // and it is finished: a later bar that reclaims that same price produces nothing from it
  const after = m.add({ t: T0 + 12 * MS, o: 88, h: 94, l: 87, c: 93, v: 1000 });
  assert.equal(after.events.filter((e) => e.level === 90).length, 0);
  assert.equal(m.reading(8).grade, 'broke', 'the reading still names the break, not a new retest');
});

test('the retest cooldown suppresses repeats without losing the respect count', () => {
  const m = new SrRegression({ pivotLength: 2, probabilityThreshold: 0, retestCooldown: 3 });
  const outs = feedSr(m, withBars({ 7: { o: 92, h: 93.5, l: 89, c: 92.5 }, 8: { o: 92, h: 92.5, l: 89, c: 92 } }));
  assert.equal(outs[7].events.length, 1);
  assert.equal(outs[8].events.length, 0, 'inside the 3-bar cooldown');
  assert.equal(m.levels[0].timesRespected, 2, 'but the level was still respected twice');

  const m2 = new SrRegression({ pivotLength: 2, probabilityThreshold: 0, retestCooldown: 3 });
  const o2 = feedSr(m2, withBars({ 7: { o: 92, h: 93.5, l: 89, c: 92.5 }, 11: { o: 92, h: 92.5, l: 89, c: 92 } }));
  assert.ok(o2[11].events.some((e) => e.type === 'SUPPORT_RETEST'), 'past the cooldown it fires again');
});

test('a RESISTANCE floors the tape: pierced and rejected is SHORT, closed above is a BUY break', () => {
  const base = [
    { t: T0 + 0 * MS, o: 90.5, h: 91.0, l: 90.0, c: 90.8, v: 1000 },
    { t: T0 + 1 * MS, o: 90.8, h: 91.5, l: 90.5, c: 91.2, v: 1000 },
    { t: T0 + 2 * MS, o: 91.2, h: 91.8, l: 90.8, c: 91.5, v: 1000 },
    { t: T0 + 3 * MS, o: 91.5, h: 92.0, l: 91.0, c: 91.8, v: 1000 },
    { t: T0 + 4 * MS, o: 99.3, h: 100.0, l: 99.0, c: 99.5, v: 1000 },   // the pivot HIGH
    { t: T0 + 5 * MS, o: 95.0, h: 95.0, l: 94.0, c: 94.5, v: 1000 },
    { t: T0 + 6 * MS, o: 94.5, h: 94.0, l: 93.0, c: 93.5, v: 1000 },
    { t: T0 + 7 * MS, o: 93.0, h: 93.5, l: 92.0, c: 92.5, v: 1000 },
    { t: T0 + 8 * MS, o: 92.5, h: 92.5, l: 91.5, c: 92.0, v: 1000 },
    { t: T0 + 9 * MS, o: 92.0, h: 92.0, l: 91.0, c: 91.5, v: 1000 },
    { t: T0 + 10 * MS, o: 91.5, h: 91.5, l: 90.5, c: 91.0, v: 1000 },
    { t: T0 + 11 * MS, o: 91.0, h: 91.0, l: 90.0, c: 90.5, v: 1000 },
  ];
  const reject = base.map((b, i) => (i === 7 ? { t: b.t, o: 99, h: 101, l: 98, c: 98.5, v: 1000 } : b));
  const m1 = new SrRegression({ pivotLength: 2, probabilityThreshold: 0 });
  const o1 = feedSr(m1, reject);
  const rej = o1[7].events.find((e) => e.type === 'RESISTANCE_RETEST');
  assert.ok(rej);
  assert.equal(rej.side, 'SHORT');

  const thru = base.map((b, i) => (i === 7 ? { t: b.t, o: 99, h: 101, l: 98.5, c: 101, v: 1000 } : b));
  const m2 = new SrRegression({ pivotLength: 2, probabilityThreshold: 0 });
  const o2 = feedSr(m2, thru);
  const brk = o2[7].events.find((e) => e.type === 'RESISTANCE_BREAK');
  assert.ok(brk);
  assert.equal(brk.side, 'BUY');
});

test('an old level is not current evidence: the reading goes back to null', () => {
  const m = new SrRegression({ pivotLength: 2, probabilityThreshold: 0, recentBars: 2 });
  feedSr(m, withBars({ 7: { o: 92, h: 93.5, l: 89, c: 92.5 } }));
  assert.equal(m.reading(7).ok, true);
  assert.equal(m.reading(10).ok, null, 'three bars later the event is history, not a vote');
});

// ---------------------------------------------------------------------------
// 3. The incremental RSI/ATR must be the SAME series as the up-front recompute.
//
// This is the check that matters for a rewrite like this one: the module was made incremental because
// the recompute was O(bars^2) and hung a 60-name run, and "the rewrite is equivalent" is exactly the
// claim a rewrite must not be trusted without.
// ---------------------------------------------------------------------------
test('the carried-forward RSI and ATR equal the recomputed series, bar for bar', () => {
  const bars = [];
  // a tape with gaps, flat stretches and a spike, so the smoothing paths are all exercised
  for (let i = 0; i < 120; i++) {
    const drift = Math.sin(i / 7) * 3 + (i === 60 ? 8 : 0);
    const c = 200 + drift;
    bars.push({ t: T0 + i * MS, o: c - 0.4, h: c + 0.6, l: c - 0.8, c, v: 1000 });
  }
  const len = 14;
  const rsiUp = rsiSeries(bars, len);
  const atrUp = atrSeries(bars, len);
  const m = new SrRegression({ pivotLength: len });
  const rsiStep = [], atrStep = [];
  for (const b of bars) { m.add(b); rsiStep.push(m._rsi[m._rsi.length - 1]); atrStep.push(m._atr[m._atr.length - 1]); }
  for (let i = 0; i < bars.length; i++) {
    if (rsiUp[i] == null || rsiStep[i] == null) {
      assert.equal(rsiStep[i], rsiUp[i], 'RSI emit rule at bar ' + i);
      assert.equal(atrStep[i], atrUp[i], 'ATR emit rule at bar ' + i);
      continue;
    }
    assert.ok(Math.abs(rsiStep[i] - rsiUp[i]) < 1e-9, 'RSI at bar ' + i + ': ' + rsiStep[i] + ' vs ' + rsiUp[i]);
    assert.ok(Math.abs(atrStep[i] - atrUp[i]) < 1e-9, 'ATR at bar ' + i + ': ' + atrStep[i] + ' vs ' + atrUp[i]);
  }
});

// ---------------------------------------------------------------------------
// 4. The golden zone.
// ---------------------------------------------------------------------------
test('the golden zone is the 0.5-0.618 band of the rolling leg, low-first whatever the fib order', () => {
  const bars = [];
  for (let i = 0; i < 25; i++) {
    const h = 100 + i, l = 90 + i;
    bars.push({ t: T0 + i * MS, o: h - 1, h, l, c: h - 0.5, v: 1000 });
  }
  const z = goldenZone(bars, 24, { pivotRange: 20 });
  // the last 20 bars: high 124, low 95 -> 0.5 retracement 109.5, 0.618 retracement 106.078
  assert.equal(z.top, 124);
  assert.equal(z.bottom, 95);
  assert.ok(Math.abs(z.lo - (124 - 29 * 0.618)) < 1e-9);
  assert.ok(Math.abs(z.hi - (124 - 29 * 0.5)) < 1e-9);
  assert.ok(z.hi > z.lo);
  assert.equal(goldenZone(bars, 5, { pivotRange: 20 }), null, 'not enough history yet');
});
