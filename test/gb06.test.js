'use strict';

/**
 * GB06 — THE EMA CROSSOVER MUST BE ABLE TO TRADE, AND MUST TRADE A SANE PLAN.
 *
 * Before this test existed GB06 fired 8,255 signals over 20 sessions and the planner refused
 * every one of them. Three separate causes, each of which reads as "no trades" and none of which
 * throws:
 *
 *   1. the target was priced on the WRONG SIDE of the entry (`bar.high - 0.1 * ATR` for a LONG,
 *      which sits below the close whenever the bar closed off its high) → gate TARGET;
 *   2. `signal.targetCandidates` held `{price, basis}` OBJECTS, and `backtest/follow.js` feeds
 *      that array back to the planner at the FILL, where `isNaN(object)` is true → REFILL_TARGET;
 *   3. the measured ATR was multiplied by 20 so the shared `minAtrPct: 0.60` floor would pass,
 *      which inflated every stop the strategy produced.
 *
 * Each is pinned below, because each failure mode is silent: the engine keeps returning without
 * an error and the report says "no trades".
 */

const test = require('node:test');
const assert = require('node:assert');

const gb06 = require('../strategies/gb06');

/** 40 bars drifting down, then 40 rising: a fast/slow cross must happen in both directions. */
function crossSeries() {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    const c = +(p - 0.04).toFixed(4); p = c;
    bars.push(['2026-09-01 09:' + String(i).padStart(2, '0'), c + 0.05, c + 0.2, c - 0.2, c, 10000]);
  }
  for (let i = 0; i < 40; i++) {
    const c = +(p + 0.06).toFixed(4); p = c;
    bars.push(['2026-09-01 10:' + String(i).padStart(2, '0'), c - 0.05, c + 0.2, c - 0.2, c, 12000]);
  }
  return bars;
}

function walk() {
  const eng = gb06.createEngine({});
  const bars = crossSeries();
  const ok = [], refused = [];
  for (let i = 0; i < bars.length; i++) {
    const s = eng.onBar(bars, i);
    if (!s) continue;
    (s.ok ? ok : refused).push(s);
  }
  return { ok, refused };
}

test('a crossover produces a plannable trade', () => {
  const { ok } = walk();
  assert.ok(ok.length >= 1, 'the cross must produce at least one accepted plan, not just refusals');
});

test('targetCandidates is a list of NUMBERS — follow() re-plans from it at the fill', () => {
  const { ok, refused } = walk();
  for (const s of [...ok, ...refused]) {
    assert.ok(Array.isArray(s.targetCandidates) && s.targetCandidates.length === 1,
      'one ATR target per signal');
    for (const c of s.targetCandidates) {
      assert.equal(typeof c, 'number', 'a target handed back to the planner must be a number');
      assert.ok(Number.isFinite(c), 'a target must be a real price');
    }
  }
});

test('every accepted plan has its levels on the right side and clears the RR floor', () => {
  const { ok } = walk();
  for (const s of ok) {
    const entry = s.entry, stop = s.plan.stop, t1 = s.plan.t1;
    if (s.side === 'LONG') {
      assert.ok(stop < entry, 'LONG stop below entry, got ' + stop + ' vs ' + entry);
      assert.ok(t1 > entry, 'LONG target above entry, got ' + t1 + ' vs ' + entry);
    } else {
      assert.ok(stop > entry, 'SHORT stop above entry, got ' + stop + ' vs ' + entry);
      assert.ok(t1 < entry, 'SHORT target below entry, got ' + t1 + ' vs ' + entry);
    }
    assert.ok(s.plan.rr >= 1.2, 'RR1 ' + s.plan.rr + ' is under the planner floor');
  }
});

test('the stop is a real ATR distance, not a scaled-up one', () => {
  // The old `atrScaleFactor = 20` produced stops that had to be clamped by the planner's
  // maxStopPct (1.5%) on nearly every bar. A stop wider than that ceiling means the strategy is
  // quoting a risk no sane position could carry.
  const { ok } = walk();
  for (const s of ok) assert.ok(s.riskPct <= 1.5, 'risk ' + s.riskPct.toFixed(2) + '% is past the planner ceiling');
});

test('the engine never throws on a thin series', () => {
  const eng = gb06.createEngine({});
  const thin = [['2026-09-01 09:15', 100, 100.1, 99.9, 100, 1000]];
  for (let i = 0; i < thin.length; i++) assert.doesNotThrow(() => eng.onBar(thin, i));
});

test('at most maxSignalsPerDay accepted signals per session', () => {
  const eng = gb06.createEngine({});
  const bars = crossSeries();
  let count = 0;
  for (let i = 0; i < bars.length; i++) {
    const s = eng.onBar(bars, i);
    if (s && s.ok) count++;
  }
  assert.ok(count <= gb06.DEFAULTS.maxSignalsPerDay,
    'accepted ' + count + ' signals in one session, cap is ' + gb06.DEFAULTS.maxSignalsPerDay);
});
