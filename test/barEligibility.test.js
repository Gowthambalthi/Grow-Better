'use strict';

/**
 * Day eligibility on the 1-minute tape — the rule behind "give sell to this" on a
 * 20-share minute.
 *
 * What is pinned here is the DAY test, not a per-signal veto, because the arithmetic
 * that produced the bad call is a property of the whole session: `volX` divides the
 * recent average by the day's average, `volPace` divides by the session MEDIAN bar,
 * and on a name whose minutes are routinely 11-30 shares the RATIO still reads ~1.0 —
 * a dead tape forms its own average. So a bar floor alone changes nothing; refusing
 * the day does.
 *
 * The numbers in these fixtures are the MEASURED Yahoo 1m volume for NSE on 28-Sep
 * (360 regular-session bars per name), which is why the default allows 20% thin bars
 * rather than zero: RELIANCE itself prints a 0-volume minute and 1 bar under 500 out
 * of 360, so "any one thin bar refuses the day" would refuse the whole market — a
 * filter that reads as "not performing" while it silently discards every candidate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { eligibility, DEFAULT_MIN_SHARES, DEFAULT_MAX_THIN_SHARE } = require('../common/market/barEligibility');

// A tape of `n` bars at a fixed volume, with optional nulls or thin bars mixed in.
function tape(n, vol, opts = {}) {
  const { nulls = 0, thin = 0, thinVol = 10 } = opts;
  const bars = [];
  for (let i = 0; i < n - nulls - thin; i++) bars.push({ t: i * 60000, c: 100, v: vol });
  for (let i = 0; i < thin; i++) bars.push({ t: 0, c: 100, v: thinVol });
  for (let i = 0; i < nulls; i++) bars.push({ t: 0, c: 100, v: null });
  return bars;
}

test('a liquid tape is eligible', () => {
  const r = eligibility(tape(360, 26973));            // RELIANCE's median minute
  assert.equal(r.ok, true, 'RELIANCE-like tape must pass');
  assert.equal(r.thin, 0);
  assert.equal(r.thinShare, 0);
  assert.equal(r.worst, 26973);
});

test('RELIANCE\u2019s REAL shape passes the default and fails the literal rule', () => {
  // 360 bars: one 0-volume minute and one sub-500 bar (both measured on 28-Sep).
  const rel = tape(360, 26973, { thin: 1, thinVol: 0 });
  const byDefault = eligibility(rel);
  assert.equal(byDefault.ok, true, '0.6% thin bars must not refuse the most liquid name');
  assert.equal(byDefault.thin, 1);

  const literal = eligibility(rel, { maxThinShare: 0 });   // GB_MAX_THIN_BAR_SHARE=0
  assert.equal(literal.ok, false, 'the literal any-bar rule refuses it, as asked');
  assert.match(literal.why, /1\/360 bars/);
});

test('a null 1m volume counts as a thin bar, not as a missing field', () => {
  // Yahoo returns null for minutes with NO trade. WENDT (measured): 167 nulls of 360.
  const r = eligibility(tape(360, 7, { nulls: 167 }));
  assert.equal(r.ok, false);
  assert.equal(r.nullVol, 167, 'nulls must be counted');
  assert.match(r.why, /167 with no volume at all/);
  assert.ok(r.thinShare > DEFAULT_MAX_THIN_SHARE);
});

test('the measured dead names are refused; the measured live names are kept', () => {
  const cases = [
    // symbol,      bars, median vol, nulls, thin bars — all measured 28-Sep
    ['RELIANCE', 360, 26973, 0, 1, true],
    ['HBLENGINE', 360, 4958, 0, 5, true],
    ['PFOCUS', 360, 2329, 1, 93, false],       // 25.8% thin -> refused
    ['JKCEMENT', 360, 22, 97, 262, false],     // Nifty-50, Yahoo median 22 -> refused
    ['QUESS', 360, 258, 3, 225, false],        // the name in the report, 62.5% thin
    ['WENDT', 360, 7, 167, 193, false],
  ];
  for (const [sym, n, vol, nulls, thin, ok] of cases) {
    const r = eligibility(tape(n, vol, { nulls, thin }));
    assert.equal(r.ok, ok, sym + ' should be ' + (ok ? 'eligible' : 'refused') + ' (thin ' + (r.thinShare * 100).toFixed(1) + '%)');
  }
});

test('the floor and the tolerance are the PUBLISHED defaults and are overridable', () => {
  assert.equal(DEFAULT_MIN_SHARES, 500, 'the asked-for per-bar floor');
  assert.equal(DEFAULT_MAX_THIN_SHARE, 0.20);
  const t = tape(100, 1000, { thin: 30 });                  // 30% thin
  assert.equal(eligibility(t).ok, false);
  assert.equal(eligibility(t, { maxThinShare: 0.35 }).ok, true, 'a looser tolerance admits it');
  assert.equal(eligibility(tape(100, 400)).ok, false, 'a tape under the floor everywhere is refused');
  assert.equal(eligibility(tape(100, 400), { minShares: 300 }).ok, true, 'a lower floor admits it');
});

test('a refusal always carries the number that caused it', () => {
  const r = eligibility(tape(50, 5));
  assert.equal(r.ok, false);
  assert.match(r.why, /thin 1m tape: 50\/50 bars/);
  assert.match(r.why, /under 500 shares/);
  assert.match(r.why, /smallest 5/);
  assert.equal(r.worst, 5);
});

test('an empty or absent series is refused rather than crashing', () => {
  assert.equal(eligibility([]).ok, false);
  assert.equal(eligibility(null).ok, false);
  assert.equal(eligibility(undefined, {}).bars, 0);
  assert.equal(eligibility([{ v: 'nonsense' }]).ok, false, 'a non-numeric volume is thin');
  assert.equal(eligibility([{ v: '900' }]).ok, true, 'a numeric string is read as its number');
});

test('null bars do not corrupt `worst`', () => {
  const bars = [{ v: null }, { v: 900 }, { v: 12 }, { c: 5 }];   // the last has no v at all
  const r = eligibility(bars);
  assert.equal(r.worst, 12, 'worst is the smallest FINITE volume');
  assert.equal(r.nullVol, 2, 'both the null and the missing volume count');
});
