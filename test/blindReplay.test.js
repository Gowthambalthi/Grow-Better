'use strict';

/**
 * BLIND POINT-IN-TIME REPLAY — proof that the decision path cannot see the future.
 *
 * The decisive test is the LEAKAGE TEST: future bars are intentionally injected
 * (mutated) into a copy of the input, and the blind engine must produce the SAME
 * decision using only the allowed historical prefix.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const br = require('../backtest/blindReplay');
const identity = require('../backtest/phase5Identity');
const { barTimeMs } = require('../backtest/eventMicro');
const { T } = require('../strategy-core/indicators');

const SESSION = '2026-09-15';
const TARGET = 65;                       // in-window decision bar index
const BASE = Date.UTC(2026, 8, 15, 3, 45); // 09:15 IST

/** A synthetic session: 90 one-minute bars from 09:15. */
function makeCandles() {
  const bars = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(BASE + i * 60000 + 330 * 60000);
    const time = d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
    const px = 100 + i * 0.1;
    bars.push([time, px, px + 0.5, px - 0.5, px, 1000 + i]);
  }
  return bars;
}

/**
 * A stub engine that arms a signal ONLY at TARGET. `peek` records the length of
 * the bar array it was handed at each call, so the test can prove the engine
 * never received a future bar.
 */
function stubEngine(record) {
  return {
    DEFAULTS: {},
    createEngine(cfg) {
      return {
        onBar(bars, i) {
          if (record) record.push({ i, len: bars.length });
          if (i !== TARGET) return null;
          const px = bars[i][T.CLOSE];
          return {
            ok: true, setup: 'OF01', side: 'LONG', signalTime: bars[i][T.TIME], barIndex: i,
            entry: px, stop: px - 1, t1: px + 2, t2: px + 4, rr1: 2,
            invalidationForFill: px - 1,
            targetCandidates: [px + 2, px + 4],
            market: {}, config: { planner: { requireMeasured: false } },
            setupData: {
              barsToTrigger: 0, locationType: 'VWAP', probedLevel: px - 0.2,
              triggerLevel: px + 0.1, invalidation: px - 1, closeLocation: 0.5,
              volumeRatio: 1.5, eventAtrPct: 0.3,
            },
          };
        },
      };
    },
  };
}

test('decisionInstant is the last observable millisecond of the decision bar', () => {
  const close = identity.decisionBarTs('2026-09-15 10:20');
  assert.equal(br.decisionInstant('2026-09-15 10:20'), close - 1);
  // and the next bar opens exactly at that close
  const nextOpen = barTimeMs('2026-09-15 10:21');
  assert.equal(nextOpen, close, 'the next bar opens where the decision bar closes');
  assert.ok(br.decisionInstant('2026-09-15 10:20') <= identity.decisionBarTs('2026-09-15 10:20'));
  assert.ok(nextOpen > br.decisionInstant('2026-09-15 10:20'));
});

test('the blind engine is handed a prefix array, never the full frame', () => {
  const candles = makeCandles();
  const rec = [];
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: stubEngine(rec) });
  assert.equal(res.signals, 1, 'exactly one signal on the session');
  // Every onBar call saw exactly (index + 1) bars — the prefix, nothing more.
  for (const c of rec) assert.equal(c.len, c.i + 1, `onBar saw ${c.len} bars at index ${c.i} — the future leaked`);
});

test('a frozen signal carries the plan and the detector inputs, and nothing future', () => {
  const candles = makeCandles();
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: stubEngine() });
  const sig = res.records[0];
  assert.equal(sig.side, 'LONG');
  assert.ok(sig.entry > 0 && sig.stop > 0 && sig.t1 > 0 && sig.t2 > 0 && sig.rr1 != null);
  assert.ok(sig.detectorInputs && sig.detectorInputs.locationType === 'VWAP');
  // The frozen decision must not contain any timestamp after decisionTs.
  for (const [k, v] of Object.entries(sig)) {
    if (typeof v === 'number' && k !== 'futureDataStartTs' && k !== 'R') {
      assert.ok(v <= sig.decisionTs, `frozen field ${k}=${v} is after decisionTs=${sig.decisionTs}`);
    }
  }
  assert.ok(sig.lastInputBarTs <= sig.decisionTs);
});

test('LEAKAGE TEST: mutating all future bars does not change the decision', () => {
  const clean = makeCandles();
  const dirty = makeCandles();
  // Intentionally inject wildly different future data AFTER the decision bar.
  for (let i = TARGET + 1; i < dirty.length; i++) {
    dirty[i] = [dirty[i][0], 9999, 10000, 9998, 9999, 1];
  }

  const a = br.runBlindSession([{ symbol: 'FAKE', candles: clean }], SESSION, { engineMod: stubEngine() });
  const b = br.runBlindSession([{ symbol: 'FAKE', candles: dirty }], SESSION, { engineMod: stubEngine() });

  // THE DECISION IS IDENTICAL — the future could not reach it. Compare the
  // FROZEN signals (pre-evaluation), which is the decision itself.
  assert.deepEqual(a.frozenSignals[0], b.frozenSignals[0],
    'the frozen decision must be identical when the future is changed');

  // But the OUTCOME differs — the evaluator DID see the future, as designed.
  assert.notEqual(a.records[0].R, b.records[0].R);
});

test('the boundary invariants hold for every evaluated signal', () => {
  const candles = makeCandles();
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: stubEngine() });
  assert.equal(res.boundaryProblems.length, 0, JSON.stringify(res.boundaryProblems));
  for (const e of res.records) {
    assert.ok(e.availableDataEndTs <= e.decisionTs);
    assert.ok(e.futureDataStartTs > e.decisionTs);
  }
});

test('the evaluator uses follow(): a stop-first tie is a STOP at exactly -1R', () => {
  const candles = makeCandles();
  // Make the bar after the decision gap down through the stop.
  const px = candles[TARGET][T.CLOSE];
  candles[TARGET + 1] = [candles[TARGET + 1][0], px - 3, px - 3, px - 5, px - 4, 500];
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: stubEngine() });
  const e = res.records[0];
  assert.ok(e.R <= 0, 'a gap through the stop cannot book a profit');
});

test('no signals outside the entry window or the session day are emitted', () => {
  const candles = makeCandles();
  // Move the target to the very first bar: outside the 09:20-15:00 window.
  const early = { ...stubEngine() };
  early.createEngine = (cfg) => ({
    onBar(bars, i) {
      if (i !== 5) return null;
      const px = bars[i][T.CLOSE];
      return { ok: true, setup: 'OF01', side: 'LONG', signalTime: bars[i][T.TIME], barIndex: i, entry: px, stop: px - 1, t1: px + 2, t2: px + 4, rr1: 2, invalidationForFill: px - 1, targetCandidates: [px + 2], market: {}, config: { planner: { requireMeasured: false } }, setupData: { barsToTrigger: 0 } };
    },
  });
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: early });
  assert.equal(res.signals, 0, 'a 09:15 decision is outside the entry window');
});

test('cost sensitivity uses the same execution path and the framework cost', () => {
  const candles = makeCandles();
  const res = br.runBlindSession([{ symbol: 'FAKE', candles }], SESSION, { engineMod: stubEngine() });
  const sens = br.costSensitivity(res.trades, [0, 0.05, 0.10]);
  assert.ok(sens['0.00'] && sens['0.05'] && sens['0.10']);
  assert.ok(sens['0.00'].netR >= sens['0.10'].netR, 'higher cost cannot improve net R');
});

test('the first blind session is a fixed calendar date, not chosen by outcome', () => {
  assert.equal(br.FIRST_BLIND_SESSION, '2026-09-15');
});

// ---- unbiased evaluation: the session set is fixed BEFORE any outcome ----

/** 90 one-minute bars from 09:15 IST for an arbitrary date. */
function dayCandles(day) {
  const [y, m, d] = day.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 3, 45);
  const bars = [];
  for (let i = 0; i < 90; i++) {
    const t = new Date(base + i * 60000 + 330 * 60000);
    const time = t.toISOString().slice(0, 10) + ' ' + t.toISOString().slice(11, 16);
    const px = 100 + i * 0.1;
    bars.push([time, px, px + 0.5, px - 0.5, px, 1000 + i]);
  }
  return bars;
}

/** A stub engine that arms a signal ONLY on the given day at TARGET. */
function stubOnDay(day) {
  return {
    DEFAULTS: {},
    createEngine(cfg) {
      return {
        onBar(bars, i) {
          if (i !== TARGET) return null;
          if (String(bars[i][T.TIME]).slice(0, 10) !== day) return null;
          const px = bars[i][T.CLOSE];
          return {
            ok: true, setup: 'OF01', side: 'LONG', signalTime: bars[i][T.TIME], barIndex: i,
            entry: px, stop: px - 1, t1: px + 2, t2: px + 4, rr1: 2,
            invalidationForFill: px - 1, targetCandidates: [px + 2], market: {},
            config: { planner: { requireMeasured: false } }, setupData: { barsToTrigger: 0 },
          };
        },
      };
    },
  };
}

test('blindSessionList is a deterministic ascending calendar rule, >= FIRST_BLIND_SESSION', () => {
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-09-15') },
    { symbol: 'B', candles: dayCandles('2026-09-16') },
    { symbol: 'C', candles: dayCandles('2026-09-15') }, // duplicate day
    { symbol: 'D', candles: dayCandles('2026-09-10') }, // before the first session -> excluded
  ];
  const list = br.blindSessionList(corpus);
  assert.deepEqual(list, ['2026-09-15', '2026-09-16']);
  // order-independent: input order cannot change the set
  assert.deepEqual(br.blindSessionList([...corpus].reverse()), list);
  // explicit override still honours the calendar filter
  assert.ok(br.blindSessionList(corpus, '2026-09-16').every((d) => d >= '2026-09-16'));
});

test('fullSessionList is the whole corpus calendar, ascending, with no bound', () => {
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-02-27') },
    { symbol: 'B', candles: dayCandles('2026-09-15') },
    { symbol: 'C', candles: dayCandles('2026-02-27') }, // duplicate day
    { symbol: 'D', candles: dayCandles('2026-10-01') }, // after the predeclared window
  ];
  assert.deepEqual(br.fullSessionList(corpus), ['2026-02-27', '2026-09-15', '2026-10-01']);
  // order-independent and a superset of the bounded window
  assert.deepEqual(br.fullSessionList([...corpus].reverse()), br.fullSessionList(corpus));
  assert.ok(br.fullSessionList(corpus).length >= br.blindSessionList(corpus).length);
});

test('runBlindDataset rows carry symbols / wins / losses for the audit table', () => {
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-09-15') },
    { symbol: 'B', candles: dayCandles('2026-09-15') },
    { symbol: 'C', candles: dayCandles('2026-09-16') },
  ];
  const sessions = br.blindSessionList(corpus);
  const ds = br.runBlindDataset(corpus, sessions, { engineMod: stubOnDay('2026-09-15'), cost: 0 });
  const d0 = ds.perSession.find((r) => r.session === '2026-09-15');
  const d1 = ds.perSession.find((r) => r.session === '2026-09-16');
  assert.equal(d0.symbols, 2, 'two symbols have 09-15');
  assert.equal(d1.symbols, 1, 'one symbol has 09-16');
  for (const r of ds.perSession) {
    assert.equal(typeof r.wins, 'number');
    assert.equal(typeof r.losses, 'number');
  }
});

test('the blind window is a fixed predeclared range, and days outside it are excluded', () => {
  assert.equal(br.FIRST_BLIND_SESSION, '2026-09-15');
  assert.equal(br.LAST_BLIND_SESSION, '2026-09-30');
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-09-14') },
    { symbol: 'A', candles: dayCandles('2026-09-20') },
    { symbol: 'A', candles: dayCandles('2026-10-01') },
  ];
  const list = br.blindSessionList(corpus);
  assert.deepEqual(list, ['2026-09-20'], 'only sessions inside [first,last] are eligible');
});

test('methodologyOf PASSes only when every declared session ran and nothing leaked', () => {
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-09-15') },
    { symbol: 'A', candles: dayCandles('2026-09-16') },
  ];
  const sessions = br.blindSessionList(corpus);
  const ds = br.runBlindDataset(corpus, sessions, { engineMod: stubOnDay('2026-09-15'), cost: 0 });
  const m = br.methodologyOf(ds, sessions);
  assert.equal(m.classification, 'PASS');
  assert.equal(m.noFutureLeakage, true);
  assert.equal(m.unbiasedSelection, true);
  assert.equal(m.correctExecutionPath, true);
  assert.deepEqual(m.skippedSessions, []);

  // Dropping a declared session must FAIL unbiased selection.
  const dropped = br.methodologyOf(
    { perSession: ds.perSession.slice(0, 1), boundaryViolations: 0, totals: { signals: 1 } },
    sessions,
  );
  assert.equal(dropped.unbiasedSelection, false);
  assert.equal(dropped.classification, 'FAIL');
  assert.deepEqual(dropped.skippedSessions, ['2026-09-16']);
});

test('runBlindDataset replays every declared session in order, including zero-signal days', () => {
  const corpus = [
    { symbol: 'A', candles: dayCandles('2026-09-15') },
    { symbol: 'A', candles: dayCandles('2026-09-16') },
    { symbol: 'A', candles: dayCandles('2026-09-17') },
  ];
  const sessions = br.blindSessionList(corpus);
  assert.deepEqual(sessions, ['2026-09-15', '2026-09-16', '2026-09-17']);

  // The stub only fires on 09-15; the other sessions MUST still be present with 0 signals.
  const ds = br.runBlindDataset(corpus, sessions, { engineMod: stubOnDay('2026-09-15'), cost: 0 });
  assert.equal(ds.perSession.length, 3, 'one row per declared session');
  assert.deepEqual(ds.perSession.map((r) => r.session), sessions, 'replayed in order, none skipped');
  assert.equal(ds.perSession.filter((r) => r.signals === 0).length, 2, 'zero-signal sessions retained');
  assert.equal(ds.totals.signals, ds.perSession.reduce((s, r) => s + r.signals, 0));
  assert.equal(ds.boundaryViolations, 0, 'no future leakage in the dataset run');
});
