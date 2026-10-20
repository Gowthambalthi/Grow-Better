'use strict';

/**
 * THE FUNNEL MUST NAME THE GATE THAT REFUSED A NAME.
 *
 * "Candidates: 0 qualified" was the whole report a scan gave, and on 2026-10-16 it repeated for an
 * hour while the owner asked why no momentum name was ever picked. The reason was measurable the
 * whole time: the long branch demands an uptrend AND an up day AND price above VWAP AND price in the
 * LOWER HALF of the day's range — its own reachability study (scratch/engine_long_gate_reachability_2026-10-16.md)
 * put it at 0.157% of sampled symbol-minutes, with `fib_discount` the binding term.
 *
 * These tests drive real scans over synthetic bars and assert:
 *   1. a name in an uptrend sitting at the TOP of its day range is refused by `fib_discount`,
 *      and by nothing earlier in the order (trend passed),
 *   2. a name whose trend is broken is refused by `trend_alignment` — the counter names whichever
 *      gate fired first, in the order the branch evaluates them,
 *   3. `inPlay` counts a name whose 15-minute impulse cleared the measured threshold, and does not
 *      count a flat one,
 *   4. the counts describe THIS scan only (reset per scan, not accumulated by accident),
 *   5. the getter hands back a COPY, so a poller cannot mutate the running scan's ledger,
 *   6. the payload carries the studies behind the numbers, so a figure on the board is traceable.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads: a scan would otherwise write today's real
// daily_calls file into the repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-funnel-'));
process.env.GB_ORDERFLOW_DIR = TMP;

const engine = require('../strategies/orderflow/liveMinuteEngine');

/** 11:00 IST on a plain weekday — outside the blocked windows and before the arm cutoff. */
const REPLAY_MS = Date.parse('2026-10-15T11:00:00+05:30');

/**
 * `n` one-minute bars walking strictly upward with volume `vol`, so the EMA stack is aligned and
 * the only thing that can refuse a long is a later term in the conjunction. `o` is carried because
 * the engine reads `firstPrice = bars[0].o` for its day-change gate.
 */
function risingBars(n, from, step, vol) {
  const out = [];
  let prev = from;
  for (let i = 0; i < n; i++) {
    const c = +(from + step * (i + 1)).toFixed(2);
    out.push({ o: prev, h: c + 0.5, l: prev - 0.5, c, v: vol, delta: 0 });
    prev = c;
  }
  return out;
}

/** The mirror: strictly downward, so trend alignment cannot hold. */
function fallingBars(n, from, step, vol) {
  const out = [];
  let prev = from;
  for (let i = 0; i < n; i++) {
    const c = +(from - step * (i + 1)).toFixed(2);
    out.push({ o: prev, h: prev + 0.5, l: c - 0.5, c, v: vol, delta: 0 });
    prev = c;
  }
  return out;
}

function withBars(entries) {
  engine.symBars.clear();
  for (const [sym, bars] of entries) engine.symBars.set(sym, bars);
  engine.replayTimeMs = REPLAY_MS;
  engine.calls.clear();
  engine.scanFunnel = null; // the scan must build its own
}

test('a name in an uptrend at the TOP of its day range is refused by fib_discount, not earlier', () => {
  const saved = engine.requireFibDiscountLong;
  try {
    engine.requireFibDiscountLong = true;
    // 60 rising bars, ~4.5 bps each: EMA20 ≥ EMA50 holds (trend passes) and the price ends at the
    // session high, i.e. in the PREMIUM half of the range — the state the reachability study says
    // makes the branch arithmetically unreachable.
    withBars([['TESTPREMIUM', risingBars(60, 1000, 0.45, 5000)]]);
    engine.scanMinuteTape();

    const f = engine.getScanFunnel();
    assert.equal(f.scanned, 1, 'the funnel sees the name it scanned');
    assert.equal(f.long.trend_alignment, 0,
      'an aligned uptrend must PASS trend_alignment — refusing it there would misreport the cause');
    assert.ok(f.long.fib_discount >= 1,
      'price above the day midpoint must be refused by fib_discount: got ' + JSON.stringify(f.long));
    assert.equal(f.long.armed, 0, 'and the refusal must keep it off the board');
    assert.equal(f.qualified, 0, 'so nothing qualifies');
  } finally {
    engine.requireFibDiscountLong = saved;
  }
});

test('a name whose trend is broken is refused by trend_alignment (first gate in order)', () => {
  withBars([['TESTFALLING', fallingBars(60, 1000, 0.45, 5000)]]);
  engine.scanMinuteTape();

  const f = engine.getScanFunnel();
  assert.equal(f.long.trend_alignment, 1,
    'a falling series must be counted against trend_alignment: ' + JSON.stringify(f.long));
  assert.equal(f.long.fib_discount, 0,
    'fib_discount is evaluated AFTER trend, so it must stay at 0 — the counter names the FIRST failure');
});

test('inPlay counts a 15-minute impulse above the measured threshold and not a flat name', () => {
  // A flat series (step 0) has no 15-minute impulse and no volume surge: not in play, and the
  // measurement must say so rather than counting everything as active.
  const flat = Array.from({ length: 40 }, (_, i) => ({
    o: 500, h: 500.2, l: 499.8, c: 500, v: 5000, delta: 0,
  }));
  // ~45 bps of movement across 15 bars: clears the 26 bps threshold the study's held-out tertile
  // edge put at IN_PLAY_MOVE15_BPS.
  const moving = risingBars(40, 500, 0.15, 5000);
  withBars([['FLATNAME', flat], ['MOVINGNAME', moving]]);
  engine.scanMinuteTape();

  const f = engine.getScanFunnel();
  assert.equal(f.scanned, 2, 'both names are scanned');
  assert.ok(f.inPlay >= 1, 'the moving name must count as in play: ' + JSON.stringify(f));
  assert.ok(f.inPlay < 2,
    'the flat name must not be counted in play — a funnel that counts everything cannot tell ' +
    'a dead tape from a live one');
  assert.equal(f.inPlayMove15Bps, 26, 'the threshold the payload publishes is the measured one');
});

test('the funnel describes THIS scan only', () => {
  withBars([['TESTCOUNT', fallingBars(60, 1000, 0.45, 5000)]]);
  engine.scanMinuteTape();
  const first = engine.getScanFunnel();
  assert.equal(first.scanned, 1);

  engine.scanMinuteTape();
  const second = engine.getScanFunnel();
  assert.equal(second.scanned, 1, 'a second scan must start fresh, not report 2 scanned');
  assert.equal(second.long.trend_alignment, 1,
    'per-scan counts must not accumulate across scans');
});

test('getScanFunnel hands back a copy a poller cannot mutate', () => {
  withBars([['TESTCOPY', fallingBars(60, 1000, 0.45, 5000)]]);
  engine.scanMinuteTape();

  const a = engine.getScanFunnel();
  a.long.trend_alignment = 9999;
  a.inPlay = 9999;

  const b = engine.getScanFunnel();
  assert.notEqual(b.long.trend_alignment, 9999,
    'the running ledger must be protected from a caller writing through the payload object');
  assert.notEqual(b.inPlay, 9999);
});

test('the payload names the studies behind its numbers', () => {
  withBars([['TESTPROVENANCE', fallingBars(60, 1000, 0.45, 5000)]]);
  engine.scanMinuteTape();

  const f = engine.getScanFunnel();
  assert.ok(Array.isArray(f.studies) && f.studies.length === 2,
    'both pre-registered studies must be cited so the figure on the board is traceable');
  assert.ok(f.studies.some((s) => s.includes('momentum_gate_study')),
    'the momentum study (which killed the veto) must be cited');
  assert.ok(f.studies.some((s) => s.includes('engine_long_gate_reachability')),
    'the reachability study (which found the binding gate) must be cited');
  assert.ok(/this scan only/.test(f.basis), 'the scope must be stated, not implied');
});

test('a GB03a candidate survives a plan that carries `rr` and no `rr1`', () => {
  // `marketCore.withPlan` publishes the ratio as `plan.rr` (and as the signal's own `rr1`).
  // `plan.rr1` is never set. Reading `plan.rr1.toFixed(2)` when the candidate was built threw
  // on EVERY OF03 signal, and the scan's catch wraps the whole pass — so one such symbol
  // aborted the minute for the entire universe and GB03a could never arm anything:
  // GODREJPROP 2026-07-08 10:46 showed `gb03.armed: 1` with an empty book.
  const withPlanShape = { plan: { stop: 99, t1: 101, rr: 1.82 }, rr1: 1.82 };
  assert.equal(engine.gb03RiskReward(withPlanShape, 1, 2), '1 : 1.82');

  // Older/other shapes still resolve rather than throwing.
  assert.equal(engine.gb03RiskReward({ plan: { rr1: 2.4 } }, 1, 2.4), '1 : 2.40');
  assert.equal(engine.gb03RiskReward({ plan: {} }, 2, 5), '1 : 2.50');
  assert.equal(engine.gb03RiskReward({}, 0, 0), null, 'no ratio is null, never a crash or a fake 0');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
