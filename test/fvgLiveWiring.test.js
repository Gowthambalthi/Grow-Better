'use strict';

/**
 * GB01 / GB02 MUST BE ON THE LIVE BOARD, NOT ONLY IN THE BACKTEST.
 *
 * Before this wiring existed the intraday tier's "FVG" row was the Sweep+FVG
 * confluence engine — a different rule that happens to read gaps — so the strategy
 * with 69 measured trades had no live row at all, and the row that existed had no
 * measurement behind it. These tests pin the bridge:
 *
 *   1. the adapter feeds CLOSED one-minute bars only, each exactly once;
 *   2. a gap + retest on the tape becomes an FG01 signal with the engine's plan;
 *   3. the shipped configuration refuses the same synthetic tape (the ATR regime
 *      reported in strategies/fvg/index.js is real — the adapter does not bypass it);
 *   4. a scan turns that signal into a call whose row is stamped FG01 / INTRADAY,
 *      which is what makes it a ROW IN TIER 2 rather than one merged "FVG" line;
 *   5. the timestamp carries a DATE, so one session is one session (the live
 *      `HH:MM:SS` format made every bar its own session).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed BEFORE the engine loads: a scan writes today's daily_calls file.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fvg-live-'));
process.env.GB_ORDERFLOW_DIR = TMP;
process.env.GB_GATE_TELEMETRY = '0';

const { createLiveAdapter, istBarTime } = require('../strategies/fvg/liveAdapter');
const { strategyOf } = require('../common/market/callBookHistory');
const engine = require('../strategies/orderflow/liveMinuteEngine');

const T0 = Date.parse('2026-10-15T09:15:00+05:30');
const MIN = 60000;

/**
 * A 5-minute imbalance and its first legal retest, in one-minute bars:
 *   09:15–09:19 (candle A) high 100.6
 *   09:20–09:24 (candle B) travels up
 *   09:25–09:29 (candle C) low 101.7  → bullish zone [100.6, 101.7]
 *   09:30               does not touch it; the zone becomes known here
 *   09:31               dips to 100.6, closes 101.6 → the retest
 */
const SPEC = [
  [0, 100.0, 100.2, 99.9, 100.0, 5000],
  [1, 100.0, 100.1, 99.6, 99.8, 5000],
  [2, 99.8, 100.4, 99.7, 100.2, 5000],
  [3, 100.2, 100.6, 100.0, 100.4, 5000],
  [4, 100.4, 100.5, 99.9, 100.6, 5000],
  [5, 100.7, 101.0, 100.5, 100.9, 5000],
  [6, 100.9, 101.4, 100.8, 101.2, 5000],
  [7, 101.2, 101.8, 101.1, 101.6, 5000],
  [8, 101.6, 101.9, 101.3, 101.8, 5000],
  [9, 101.9, 102.2, 101.5, 102.0, 5000],
  [10, 102.0, 102.4, 101.7, 102.2, 5000],
  [11, 102.2, 102.6, 101.9, 102.4, 5000],
  [12, 102.4, 102.7, 102.0, 102.5, 5000],
  [13, 102.5, 102.8, 102.1, 102.6, 5000],
  [14, 102.6, 103.0, 102.2, 102.8, 5000],
  [15, 102.8, 103.0, 102.4, 102.9, 5000],
  [16, 102.9, 103.0, 100.6, 101.6, 9000],
];
const BARS = SPEC.map(([m, o, h, l, c, v]) => ({ t: T0 + m * MIN, o, h, l, c, v }));

/** The planner's ATR floor is the measured regime gate; a wiring test must not be
 *  blocked by it, so the permissive arm opens the gates the shipped arm leaves shut. */
const PERMISSIVE = { confirmMtfTrend: false, planner: { minAtrPct: 0, maxRangePosPct: 100, minRR1: 0.5 } };

/** Feed the whole tape bar by bar, as the scan would, returning the last signal. */
function walk(adapter, bars, opts) {
  const first = (opts && opts.from) || 0;
  const staleAfterMs = (opts && opts.staleAfterMs) || 0;
  let sig = null;
  for (let i = first; i < bars.length; i++) {
    const now = bars[i].t + MIN + 1 + staleAfterMs;
    const s = adapter.push('TESTFVG', bars.slice(0, i + 1), now);
    if (s) sig = s;
  }
  return sig;
}

test('the adapter emits the retest as FG01 with the engine\'s own plan', () => {
  const sig = walk(createLiveAdapter({ config: PERMISSIVE }), BARS);
  assert.ok(sig, 'the crafted gap + retest must produce a signal');
  assert.equal(sig.setup, 'FG01');
  assert.equal(sig.side, 'LONG');
  assert.equal(sig.ok, true);
  assert.ok(sig.plan, 'a signal a live board can use carries its plan');
  assert.ok(sig.plan.stop < sig.entry, 'a long stop sits below the entry');
  assert.ok(sig.plan.t1 > sig.entry, 'T1 sits above the entry');
  const rr = Math.abs(sig.plan.t1 - sig.entry) / Math.abs(sig.entry - sig.plan.stop);
  assert.ok(Math.abs(Number(sig.plan.rr) - rr) < 1e-9,
    'the plan carries its own RR — the note on the board prints it');
  assert.equal(sig.barTimeIST, '2026-10-15 09:31', 'the signal is stamped with the bar that produced it');
});

test('the shipped configuration refuses the same tape — the ATR regime is not bypassed', () => {
  const sig = walk(createLiveAdapter({}), BARS);
  assert.equal(sig, null,
    'the live adapter must not loosen the measured gate: GB01 fires ~once per 700 symbol-days, ' +
    'and this synthetic tape is an ordinary-volatility name');
});

test('only CLOSED bars are fed, and each bar is fed once', () => {
  const adapter = createLiveAdapter({ config: PERMISSIVE });
  // The newest bar is still forming: nine seconds into minute 09:31.
  adapter.push('TESTFVG', BARS, BARS[16].t + 9000);
  assert.equal(adapter.stateOf('TESTFVG').fed, 16, 'the in-progress bar must not be consumed');

  // Its minute ends: now it is a bar, and exactly one new bar is fed.
  adapter.push('TESTFVG', BARS, BARS[16].t + MIN);
  assert.equal(adapter.stateOf('TESTFVG').fed, 17);

  // A repeated scan must not re-feed anything.
  const again = adapter.push('TESTFVG', BARS, BARS[16].t + MIN + 5000);
  assert.equal(adapter.stateOf('TESTFVG').fed, 17, 'a second scan in the same minute feeds nothing');
  assert.equal(again, null, 'and cannot duplicate the call');
});

test('an answer older than the staleness window is history, not a call', () => {
  const adapter = createLiveAdapter({ config: PERMISSIVE, staleMs: 60000 });
  const sig = walk(adapter, BARS, { staleAfterMs: 5 * MIN });
  assert.equal(sig, null, 'a signal five minutes old must not be armed at a price the tape left behind');
});

test('the timestamp carries a DATE, so a session is a session', () => {
  assert.equal(istBarTime(T0), '2026-10-15 09:15');
  assert.equal(istBarTime(T0).slice(0, 10), '2026-10-15');
  // The live formatter that fed the engines before this returned HH:MM:SS; the
  // engines group sessions by the first ten characters, so that slice WAS the clock.
  assert.notEqual(istBarTime(T0), '09:15');
  const adapter = createLiveAdapter({ config: PERMISSIVE });
  walk(adapter, BARS);
  assert.equal(adapter.stateOf('TESTFVG').day, '2026-10-15',
    'every bar of one session must resolve to one day, or the engine resets every minute');
});

test('a stamped setup id survives into the row the tier table paints', () => {
  const row = strategyOf({ engine: 'FVG', strategyId: 'FG01', strategyType: 'INTRADAY' });
  assert.equal(row.id, 'FG01', 'one engine hosting two setups must not merge them into one row');
  assert.equal(row.name, 'GB01 — 5m FVG Retest');
  assert.equal(row.tier, 'INTRADAY', 'GB01 belongs to the intraday tier');
  // An older record with no setup stamp is attributed exactly as before.
  assert.equal(strategyOf({ engine: 'ORDERFLOW' }).id, 'ORDERFLOW');
});

// ---------------------------------------------------------------------------------------------
// 6-9. TELEMETRY. The adapter DISCARDS what it will not arm, so without these counters the live
// board answers "no calls" identically for "no gap formed", "the gate refused a gap" and "the
// adapter never saw a closed bar" — three different situations with three different responses.
// ---------------------------------------------------------------------------------------------

test('a refusal is counted under the gate\'s own name, not swallowed', () => {
  const adapter = createLiveAdapter({});            // shipped config: this tape IS refused
  const sig = walk(adapter, BARS);
  assert.equal(sig, null, 'the shipped gate refuses the synthetic tape (pinned above)');
  const st = adapter.stats();
  assert.equal(st.signals, 0);
  assert.ok(st.barsFed > 0, 'the bars were fed — the silence is a decision, not a missing feed');
  assert.ok(Object.keys(st.refused).length > 0,
    'a refusal must name its gate so the board can say WHICH gate is eating the signal: ' +
    JSON.stringify(st.refused));
  assert.ok(Object.values(st.refused).reduce((a, b) => a + b, 0) > 0);
});

test('a stale signal and a refusal are counted as the two different things they are', () => {
  const fresh = createLiveAdapter({ config: PERMISSIVE, staleMs: 60000 });
  walk(fresh, BARS);
  assert.ok(fresh.stats().signals >= 1, 'a current answer is a signal');

  const stale = createLiveAdapter({ config: PERMISSIVE, staleMs: 60000 });
  const sig = walk(stale, BARS, { staleAfterMs: 5 * MIN });
  assert.equal(sig, null);
  const st = stale.stats();
  assert.equal(st.signals, 0, 'nothing was armed');
  assert.ok(st.staleDropped >= 1, 'and the drop is counted as staleness, not as a refusal');
  assert.equal(Object.keys(st.refused).length, 0, 'the engine did not refuse it — time did');
});

test('an armed signal is stamped, so the funnel can name the last one', () => {
  const adapter = createLiveAdapter({ config: PERMISSIVE });
  walk(adapter, BARS);
  const st = adapter.stats();
  assert.ok(st.signals >= 1);
  assert.equal(st.lastSignal.setup, 'FG01');
  assert.equal(st.lastSignal.side, 'LONG');
  assert.equal(st.lastSignal.barTimeIST, '2026-10-15 09:31',
    'the stamp is the BAR that produced it, not the moment the scan happened');
  assert.ok(st.lastSignal.symbol);
  // stats() is a COPY: a caller cannot reach in and rewrite the live counters.
  st.refused.DELETED = 1;
  assert.equal(adapter.stats().refused.DELETED, undefined);
});

test('the scan funnel publishes the adapter counters, and keeps a per-scan delta', () => {
  const savedAdapter = engine.fvgLive;
  const savedTelegram = engine.dispatchTelegramNewCall;
  try {
    engine.fvgLive = createLiveAdapter({});
    engine.dispatchTelegramNewCall = () => {};
    const bars = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      const c = +(price + 0.05).toFixed(2);
      bars.push({ t: T0 + i * MIN, o: price, h: c + 0.1, l: price - 0.2, c, v: 5000, delta: 0 });
      price = c;
    }
    engine.symBars.clear();
    engine.symBars.set('TESTFUNNEL', bars);
    engine.calls.clear();
    engine.replayTimeMs = Date.parse('2026-10-15T11:00:00+05:30');
    engine.scanMinuteTape();

    const f1 = engine.getScanFunnel().fvg;
    assert.ok(f1, 'a scan that walked the universe must publish the FVG counters');
    assert.ok(f1.sinceBoot.barsFed > 0, 'the adapter must have been fed closed bars: ' + JSON.stringify(f1));
    assert.ok(f1.barsFedThisScan > 0, 'and the scan reports its own share of them');
    assert.match(f1.note, /1,022 symbol-days/, 'the note states the expected rate where the numbers are read');

    // A SECOND scan in the same minute adds no bars. The cumulative figure must survive the fresh
    // funnel, and the delta must return to zero — otherwise the board reads a stale delta as new work.
    engine.scanMinuteTape();
    const f2 = engine.getScanFunnel().fvg;
    assert.equal(f2.barsFedThisScan, 0, 'no new closed bar, no new feed');
    assert.equal(f2.sinceBoot.barsFed, f1.sinceBoot.barsFed, 'the cumulative counter is not reset by a scan');
  } finally {
    engine.fvgLive = savedAdapter;
    engine.dispatchTelegramNewCall = savedTelegram;
    engine.symBars.clear();
    engine.calls.clear();
  }
});

test('the live scan hands the engines a DATE, so one session is one session', () => {
  // The bug this pins: the live path formatted bar times as HH:MM:SS, and the engines
  // group sessions by the first ten characters — which on HH:MM:SS is the clock. Every
  // bar was its own session: one-bar VWAP, one-bar day range, a cooldown that never
  // survived a bar, and a daily cap that reset every minute.
  const savedTelegram = engine.dispatchTelegramNewCall;
  try {
    engine.dispatchTelegramNewCall = () => {};
    engine.fvgLive = { push: () => null, reset() {} };
    const bars = [];
    let price = 500;
    for (let i = 0; i < 40; i++) {
      const c = +(price + 0.1).toFixed(2);
      bars.push({ t: T0 + i * MIN, o: price, h: c + 0.4, l: price - 0.4, c, v: 5000, delta: 0 });
      price = c;
    }
    engine.symBars.clear();
    engine.symBars.set('TESTCLOCK', bars);
    engine.ofEngines.clear();
    engine.calls.clear();
    engine.replayTimeMs = Date.parse('2026-10-15T11:00:00+05:30');
    engine.scanMinuteTape();

    const ofEng = engine.ofEngines.get('TESTCLOCK');
    assert.ok(ofEng, 'the scan must have handed the bars to the OF03 engine');
    assert.equal(ofEng.state().day, '2026-10-15',
      'the engine must see the DATE, not HH:MM:SS — otherwise every bar opens a new session');

    // A tape with no clock is refused by name rather than dated with Date.now().
    engine.symBars.clear();
    engine.symBars.set('TESTNOCLOCK', bars.map(({ o, h, l, c, v }) => ({ o, h, l, c, v, delta: 0 })));
    engine.ofEngines.clear();
    engine.scanMinuteTape();
    assert.equal(engine.ofEngines.size, 0, 'a bar with no clock must not be placed in a session');
  } finally {
    engine.dispatchTelegramNewCall = savedTelegram;
    engine.symBars.clear();
    engine.ofEngines.clear();
    engine.calls.clear();
  }
});

test('a live scan puts the FVG signal on the book as an FG01 intraday row', () => {
  const saved = engine.fvgLive;
  const savedTelegram = engine.dispatchTelegramNewCall;
  try {
    // Stub only the ADAPTER: the scan, the call shape, the row mapper and the tier
    // label are the real ones. (The adapter's own behaviour is covered above.)
    engine.fvgLive = {
      push: () => ({
        setup: 'FG01', side: 'LONG', ok: true,
        plan: { stop: 100.55, t1: 110.0, rr: 3.4 },
        setupData: { frameLabel: '5m FVG', gapPct: 1.10, zoneLow: 100.6, zoneHigh: 101.7, ageBars: 1 },
        reason: ['test'],
      }),
      reset() {},
    };
    engine.dispatchTelegramNewCall = () => {};

    const bars = [];
    let price = 100;
    for (let i = 0; i < 60; i++) {
      const c = +(price + 0.05).toFixed(2);
      bars.push({ t: T0 + i * MIN, o: price, h: c + 0.1, l: price - 0.2, c, v: 5000, delta: 0 });
      price = c;
    }
    engine.symBars.clear();
    engine.symBars.set('TESTWIRE', bars);
    engine.calls.clear();
    engine.replayTimeMs = Date.parse('2026-10-15T11:00:00+05:30');
    engine.scanMinuteTape();

    const rows = engine.getActiveCandidates();
    const row = rows.find((r) => r.strategyId === 'FG01');
    assert.ok(row, 'the FVG signal must be on the live book: ' + JSON.stringify(rows.map((r) => r.strategyId)));
    assert.equal(row.category, 'INTRADAY', 'GB01 is an intraday call');
    assert.equal(row.strategyName, 'GB01 — 5m FVG Retest', 'the row names the measured system, not the engine');
    assert.ok(row.stopLoss < row.entryPrice, 'the row carries the plan stop');
    assert.ok(row.target1 > row.entryPrice, 'and the plan target');
  } finally {
    engine.fvgLive = saved;
    engine.dispatchTelegramNewCall = savedTelegram;
    engine.calls.clear();
    engine.symBars.clear();
  }
});
