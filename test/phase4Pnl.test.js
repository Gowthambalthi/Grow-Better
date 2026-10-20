'use strict';

/**
 * Phase 4 harness tests — backtest/phase4TriggerPnl.js.
 *
 * The comparison's honesty rests on four properties, asserted here against a
 * scripted stub engine (the frozen ORDERFLOW engine is deliberately NOT loaded —
 * these tests are about the harness's own logic, not the engine's):
 *
 *  1. ONE EXECUTION PATH. Any trade that appears in both branches carries the
 *     identical follow() result — the branch condition may only decide WHETHER a
 *     candidate trades, never HOW.
 *  2. THE DAY IS NOT BURNED. In the change30 branch a candidate that fails the
 *     condition leaves the one-per-day slot free for a later same-day candidate
 *     (what the variant would do live), while the baseline still takes the first.
 *  3. THE FUNNEL LIES ABOUT NOTHING. Refusals are counted under their real name
 *     (CHANGE30_NOT_MET / MICRO_NO_DATA / join miss), never silently absorbed.
 *  4. EXCURSIONS ARE DIRECTION-AWARE MEASUREMENTS of the followed trade, not a
 *     second simulation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { T } = require('../strategy-core/indicators');
const { follow } = require('../backtest/follow');
const phase4 = require('../backtest/phase4TriggerPnl');

// ---------- synthetic corpus ------------------------------------------------

/** One-minute bars for one day: `n` bars from `hh:mm`, prices drifting with i. */
function mkDayBars(day, hh, mm, n) {
  const pad = (x) => String(x).padStart(2, '0');
  const bars = [];
  let m = hh * 60 + mm;
  for (let i = 0; i < n; i++, m++) {
    const t = day + ' ' + pad(Math.floor(m / 60)) + ':' + pad(m % 60);
    const p = 100 + ((i % 5) * 0.05);
    bars.push([t, p, p, p, p, 1000]);        // [TIME, OPEN, HIGH, LOW, CLOSE, VOLUME]
  }
  return bars;
}

function mkCorpus() {
  return [{ symbol: 'STUB', candles: [...mkDayBars('2026-09-28', 9, 15, 120), ...mkDayBars('2026-09-29', 9, 15, 120)] }];
}

const SCOPE = new Set(['2026-09-28', '2026-09-29']);

// ---------- stub engine ------------------------------------------------------

/** A planner-clean signal at decision bar i: stop 0.55R wide, T1 at ~2.2R. */
function makeSignal(candles, i, spec) {
  const side = spec.side || 'LONG';
  const entry = candles[i + 1][T.OPEN];
  const invalidation = side === 'LONG' ? entry - 0.5 : entry + 0.5;
  const t1 = side === 'LONG' ? entry + 1.2 : entry - 1.2;
  const t2 = side === 'LONG' ? entry + 2.2 : entry - 2.2;
  return {
    ok: true, setup: spec.setup || 'OF01', side,
    barIndex: i, signalTime: candles[i][T.TIME],
    setupData: { barsToTrigger: spec.barsToTrigger || 0, invalidation, locationType: 'DAYL' },
    invalidationForFill: invalidation,
    targetCandidates: [t1, t2],
    market: { atr: 0.6, atrPct: 0.8, vwapDistPct: 0.2, rangePosPct: 40, move3mPct: 0.3, move5mPct: 0.4 },
    config: {},
  };
}

/**
 * ops: Map<barIndex, { arm, emit, expire }> — arm fires the armed trace with the
 * bar's own time; emit returns a signal (barsToTrigger from spec); expire fires
 * an expired trace so the harness's join bookkeeping can be exercised.
 */
function stubEngine(ops) {
  return {
    key: 'STUB', name: 'stub', maxHoldBars: 30,
    createEngine({ trace }) {
      return {
        onBar(candles, i) {
          const op = ops.get(i);
          if (!op) return null;
          if (op.arm) trace({ stage: 'armed', setup: op.arm.setup || 'OF01', side: op.arm.side || 'LONG', time: candles[i][T.TIME], price: candles[i][T.CLOSE] });
          if (op.expire) trace({ stage: 'expired', setup: op.expire.setup || 'OF01', side: op.expire.side || 'LONG', time: candles[i][T.TIME] });
          if (op.emit) return makeSignal(candles, i, op.emit);
          return null;
        },
      };
    },
  };
}

const flag = (v) => ({ change30: v === true, measured: v !== 'nodata', volume30: 500 });

function run(engine, flags) {
  const corpus = mkCorpus();
  const b = phase4.replayBranch(corpus, { label: 'baseline', engineMod: engine, flags, scopeDays: SCOPE });
  const c = phase4.replayBranch(corpus, { label: 'change30', engineMod: engine, flags, scopeDays: SCOPE });
  return { b, c };
}

// ---------- 1 · excursion math ------------------------------------------------

test('excursionsR is direction-aware and measures the trade life only', () => {
  const bars = [
    ['t0', 100, 101.5, 99.5, 100, 1],   // [TIME, OPEN, HIGH, LOW, CLOSE, VOLUME]
    ['t1', 100, 100.4, 99.8, 100, 1],
  ];
  const long = phase4.excursionsR(bars, 0, 1, 100, 1, 'LONG');
  assert.ok(Math.abs(long.mfeR - 1.5) < 1e-9, 'LONG MFE from the high');
  assert.ok(Math.abs(long.maeR - 0.5) < 1e-9, 'LONG MAE from the low');
  const short = phase4.excursionsR(bars, 0, 1, 100, 1, 'SHORT');
  assert.ok(Math.abs(short.mfeR - 0.5) < 1e-9, 'SHORT MFE from the low');
  assert.ok(Math.abs(short.maeR - 1.5) < 1e-9, 'SHORT MAE from the high');
});

test('a stopped LONG shows MAE >= 1R by construction', () => {
  // entry 100, stop hit when the low reaches 99.0 (risk 1.0)
  const bars = [['t0', 100, 100.2, 98.9, 99, 1]];
  const exc = phase4.excursionsR(bars, 0, 0, 100, 1, 'LONG');
  assert.ok(exc.maeR >= 1, 'the bar that hit the stop must carry MAE >= 1R, got ' + exc.maeR);
});

// ---------- 2 · one execution path ---------------------------------------------

test('a candidate approved by both branches is executed identically', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  const ops = new Map([[65, { arm: {}, emit: { barsToTrigger: 0 } }]]);
  const flags = new Map([[phase4.eventKeyOf('STUB', '2026-09-28', candles[65][T.TIME], 'OF01', 'LONG'), flag(true)]]);
  const { b, c } = run(stubEngine(ops), flags);

  assert.equal(b.trades.length, 1, 'baseline trades the first candidate');
  assert.equal(c.trades.length, 1, 'change30 trades the same candidate');
  for (const f of ['entry', 'stop', 't1', 't2', 'rr1', 'riskPct', 'barsHeld', 'outcome', 'r', 'exitReason', 'sessionEnded']) {
    assert.deepEqual(c.trades[0][f], b.trades[0][f], 'branch condition must not change ' + f);
  }
  // ...and the recorded result IS what follow() produces for that signal:
  const direct = follow(candles, makeSignal(candles, 65, { barsToTrigger: 0 }), 30);
  assert.deepEqual(c.trades[0].entry, direct.entry);
  assert.deepEqual(c.trades[0].stop, direct.stop);
  assert.deepEqual(c.trades[0].rr1, direct.rr1);
  assert.equal(c.trades[0].change30, true, 'the trade carries the flag it was approved on');
  assert.equal(b.funnel.filled, 1);
  assert.equal(c.funnel.filled, 1);
  assert.equal(b.funnel.eligible, 1, 'eligible counts the candidates handed to follow()');
  assert.equal(c.funnel.eligible, 1);
  assert.deepEqual(c.funnel.triggerNotMet, {});
});

// ---------- 3 · the day is not burned ------------------------------------------

test('retake: baseline takes the first candidate, change30 takes the later approved one', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  const ops = new Map([
    [65, { arm: {}, emit: { barsToTrigger: 0 } }],    // NOT approved
    [95, { arm: {}, emit: { barsToTrigger: 0 } }],    // approved
  ]);
  const flags = new Map([
    [phase4.eventKeyOf('STUB', '2026-09-28', candles[65][T.TIME], 'OF01', 'LONG'), flag(false)],
    [phase4.eventKeyOf('STUB', '2026-09-28', candles[95][T.TIME], 'OF01', 'LONG'), flag(true)],
  ]);
  const { b, c } = run(stubEngine(ops), flags);

  assert.equal(b.trades.length, 1);
  assert.equal(b.trades[0].time, candles[65][T.TIME], 'baseline took the FIRST candidate');
  assert.equal(b.funnel.dedupSkipped, 1, 'the second candidate was deduped away in baseline');

  assert.equal(c.trades.length, 1);
  assert.equal(c.trades[0].time, candles[95][T.TIME], 'change30 skipped the refused candidate and took the later one');
  assert.deepEqual(c.funnel.triggerNotMet, { CHANGE30_NOT_MET: 1 });
  assert.equal(c.funnel.dedupSkipped, 0, 'the refused candidate must not have consumed the day');
  assert.equal(c.trades[0].change30, true);
});

test('change30 stays flat on a day whose only candidate is not approved', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  const ops = new Map([[65, { arm: {}, emit: { barsToTrigger: 0 } }]]);
  const flags = new Map([[phase4.eventKeyOf('STUB', '2026-09-28', candles[65][T.TIME], 'OF01', 'LONG'), flag(false)]]);
  const { b, c } = run(stubEngine(ops), flags);

  assert.equal(b.trades.length, 1, 'baseline trades as always');
  assert.equal(c.trades.length, 0, 'change30 has no trade — and no invented one');
  assert.deepEqual(c.funnel.triggerNotMet, { CHANGE30_NOT_MET: 1 });
});

test('no tape evidence refuses the candidate as MICRO_NO_DATA, never as a guessed false', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  const ops = new Map([[65, { arm: {}, emit: { barsToTrigger: 0 } }]]);
  const { b, c } = run(stubEngine(ops), new Map());       // flags empty: the event has no record

  assert.equal(b.trades.length, 1);
  assert.equal(c.trades.length, 0);
  assert.deepEqual(c.funnel.triggerNotMet, { MICRO_NO_DATA: 1 });
});

// ---------- 4 · the join is checked, not guessed --------------------------------

test('an armed/signal mismatch is counted as a join miss, not silently joined', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  // The signal claims barsToTrigger 2 but the armed event sits ON the signal bar:
  // the self-check must refuse the lookup instead of joining on a guess.
  const ops = new Map([[65, { arm: {}, emit: { barsToTrigger: 2 } }]]);
  const flags = new Map([[phase4.eventKeyOf('STUB', '2026-09-28', candles[65][T.TIME], 'OF01', 'LONG'), flag(true)]]);
  const { b, c } = run(stubEngine(ops), flags);

  assert.equal(c.funnel.joinMisses, 1, 'the mismatch is visible in the funnel');
  assert.equal(c.trades.length, 0, 'change30 cannot approve what it could not join');
  assert.deepEqual(c.funnel.triggerNotMet, { MICRO_NO_DATA: 1 });
  assert.equal(b.trades.length, 1, 'baseline is unaffected by the research join');
});

test('an expired event is no longer joined to a later signal', () => {
  const corpus = mkCorpus();
  const candles = corpus[0].candles;
  // armed at 60, expired at 70, a signal at 95 with barsToTrigger 0: the parent
  // slot was vacated, so the join must miss rather than reach back to the corpse.
  const ops = new Map([
    [60, { arm: {} }],
    [70, { expire: {} }],
    [95, { emit: { barsToTrigger: 0 } }],
  ]);
  const flags = new Map([[phase4.eventKeyOf('STUB', '2026-09-28', candles[95][T.TIME], 'OF01', 'LONG'), flag(true)]]);
  const { b, c } = run(stubEngine(ops), flags);

  assert.equal(c.funnel.joinMisses, 1);
  assert.equal(c.trades.length, 0);
  assert.equal(b.trades.length, 1);
});

// ---------- 5 · approve() semantics ---------------------------------------------

test('approve() distinguishes the three refusal reasons from approval', () => {
  assert.deepEqual(phase4.approve('baseline', null), { ok: true });
  assert.deepEqual(phase4.approve('change30', { change30: true, measured: true, volume30: 1 }), { ok: true });
  assert.deepEqual(phase4.approve('change30', { change30: false, measured: true, volume30: 1 }), { ok: false, reason: 'CHANGE30_NOT_MET' });
  assert.deepEqual(phase4.approve('change30', null), { ok: false, reason: 'MICRO_NO_DATA' });
  assert.deepEqual(phase4.approve('change30', { change30: false, measured: false, volume30: 0 }), { ok: false, reason: 'MICRO_NO_DATA' });
});
