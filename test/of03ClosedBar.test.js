'use strict';

/**
 * THE OF03 ENGINE MUST BE FED **CLOSED** BARS, EACH ONE ONCE.
 *
 * On 2026-10-19 the GB03a row on the board read "ARMED · 25 measured trades · no live calls
 * today", the day's call book was EMPTY, and the funnel said `gb03: null` on all 256 scans —
 * a reading that is identical whether the engine found nothing or was never handed a bar worth
 * deciding on. It was the second one.
 *
 *   The scan fires at a fixed offset from boot — `hh:mm:09` all session on that tape — and
 *   `ingestTick` has already opened the current minute's bar by then, so `bars[length-1]` is the
 *   bar that is still FORMING: nine seconds old, carrying ~14% of a minute's volume. OF03 gates
 *   participation FIRST (`volumeRatio >= of03MinVolRatio`, 1.7) against this bar's own volume over
 *   the previous 20 bars, so a nine-second bar measured a mean ratio of 0.165 and cleared 1.7 on
 *   1.106% of symbol-minutes, against 15.813% for a full minute — a ~14x handicap on the very
 *   first gate, on a setup whose measured rate is 25 trades in 705 sessions. Approximately none
 *   is what the empty book showed. (docs/VERIFY-GB01-GB03A-2026-10-19.md §3, over 61,936
 *   symbol-minutes of that day's tape.)
 *
 * The FVG adapter (strategies/fvg/liveAdapter.js) never had this defect — it refuses to feed a bar
 * until `now >= bar.t + 60s`. The OF03 branch now applies that same rule, and it is the same rule
 * on purpose: two live engines disagreeing about "the newest bar we may act on" is how one of them
 * quietly stops trading.
 *
 * What these tests pin, driving real scans over synthetic tapes:
 *   1. what the engine is HANDED is the last closed bar, never the forming one (and never the
 *      forming bar's volume, which is the number that decides the first gate);
 *   2. each closed bar is handed over exactly once and in order, and a second scan with no new bar
 *      feeds nothing at all;
 *   3. a gap is WALKED bar by bar rather than jumped, and the "already fed" key is the bar's own
 *      timestamp, so `symBars` dropping its oldest bar past 390 cannot slide it into a re-feed;
 *   4. the funnel publishes how many symbols were EVALUATED, so "nothing set up" and "never
 *      reached" stop being the same reading for GB03a.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads, so a scan cannot write today's real call book.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'of03-closed-bar-'));
process.env.GB_ORDERFLOW_DIR = TMP;
process.env.GB_GATE_TELEMETRY = '0';

const live = require('../strategies/orderflow/liveMinuteEngine');
const { istBarTime } = require('../strategies/fvg/liveAdapter');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const MIN = 60000;
/** The 2026-10-19 scan offset: the scan ran at `hh:mm:09`, all session. */
const SCAN_MS = Date.parse('2026-10-15T11:00:09+05:30');
/** The minute the scan lands in — its bar is the one still FORMING at SCAN_MS. */
const FORMING_T = Math.floor(SCAN_MS / MIN) * MIN;

/** The corpus timestamp the engine indexes by — the same formatter the branch uses. */
const stamp = (ms) => istBarTime(ms);

/**
 * `n` one-minute bars ending at `endT`, all clocked. `formingVol` is what the last (forming)
 * bar carries: nine seconds of flow, not a minute's.
 */
function minuteBars(n, endT, { vol = 1000, formingVol = 120 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = endT - (n - 1 - i) * MIN;
    const isLast = i === n - 1;
    out.push({
      t, o: 100, h: 100.2, l: 99.8, c: 100,
      v: isLast ? formingVol : vol, delta: 0,
    });
  }
  return out;
}

/** An OF03 engine stand-in that records what it was handed and emits nothing. */
function recorder() {
  const fed = [];
  return {
    fed,
    onBar(formatted, index) {
      fed.push({ ts: formatted[index][0], index, len: formatted.length, v: formatted[index][5] });
      return null;
    },
  };
}

/** Run one scan with the given tape; `restore` must be called in the caller's `finally`. */
function withEngine(sym, engine) {
  const saved = {
    symBars: live.symBars, calls: live.calls, ofEngines: live.ofEngines,
    fedT: live.ofEngLastFedBarT, replayTimeMs: live.replayTimeMs,
    alert: live.dispatchTelegramNewCall, fvg: live.fvgLive,
  };
  live.calls = new Map();
  live.ofEngines = new Map([[sym, engine]]);
  live.ofEngLastFedBarT = new Map();
  live.replayTimeMs = SCAN_MS;
  // The FVG adapter is a different engine with its own wiring and its own tests; keep it out of
  // this one, but leave a `push` in place because the scan calls it for every symbol it walks.
  live.fvgLive = { push: () => null };
  live.dispatchTelegramNewCall = () => Promise.resolve();   // never alert from a test
  return () => {
    live.symBars = saved.symBars; live.calls = saved.calls; live.ofEngines = saved.ofEngines;
    live.ofEngLastFedBarT = saved.fedT; live.replayTimeMs = saved.replayTimeMs;
    live.dispatchTelegramNewCall = saved.alert; live.fvgLive = saved.fvg;
  };
}

test('the engine is handed the last CLOSED bar, not the forming one', () => {
  const SYM = 'TESTCLOSED';
  const engine = recorder();
  const bars = minuteBars(40, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanMinuteTape();

    // A cold start walks the whole tape: the engine's session tail, day range and VWAP are built
    // from it, exactly as the harness builds them. What must NOT be in there is the forming bar.
    assert.equal(engine.fed.length, bars.length - 1,
      'every bar up to the last closed one is fed: ' + engine.fed.length);
    assert.deepEqual(engine.fed.map((f) => f.index),
      Array.from({ length: bars.length - 1 }, (_, i) => i),
      'and they are fed oldest first, in order');

    const seen = engine.fed[engine.fed.length - 1];
    assert.equal(seen.ts, stamp(FORMING_T - MIN),
      'the decision bar is the 10:59 bar, the newest whose minute has ENDED');
    assert.equal(seen.index, bars.length - 2, 'the index handed over matches the bar handed over');
    assert.equal(seen.v, 1000,
      'and it carries a FULL minute of volume; the 120 in the forming bar is what made the first ' +
      'gate mathematically unreachable');
    assert.ok(!engine.fed.some((f) => f.ts === stamp(FORMING_T)),
      'the 11:00 bar was nine seconds old at 11:00:09 — the harness never scores a bar before it closes');
  } finally { restore(); }
});

test('each closed bar is fed once, in order, and a repeat scan feeds nothing', () => {
  const SYM = 'TESTONCE';
  const engine = recorder();
  const bars = minuteBars(40, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanMinuteTape();
    const cold = engine.fed.length;
    assert.equal(cold, bars.length - 1, 'the cold start walks the session tail once');

    // The same scan again, one second later and with no new bar: nothing may be re-read.
    live.replayTimeMs = SCAN_MS + 1000;
    live.scanMinuteTape();
    assert.equal(engine.fed.length, cold,
      'a bar already decided on must not be handed over again: ' +
      JSON.stringify(engine.fed.slice(cold).map((f) => f.ts)));

    // 11:01:09 — the 11:00 bar has now closed and is the next one to decide on.
    bars.push({ t: FORMING_T + MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 120, delta: 0 });
    live.replayTimeMs = SCAN_MS + MIN;
    live.scanMinuteTape();

    assert.equal(engine.fed.length, cold + 1, 'exactly one new bar was decided on');
    assert.equal(engine.fed[engine.fed.length - 1].ts, stamp(FORMING_T),
      'and it is the 11:00 bar that just closed');
  } finally { restore(); }
});

test('a gap is walked bar by bar, not jumped', () => {
  const SYM = 'TESTGAP';
  const engine = recorder();
  const bars = minuteBars(40, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanMinuteTape();
    const cold = engine.fed.length;

    // A restart: three minutes pass with the tape still recording, so three bars closed while
    // nothing was deciding. The engine's session tail and its expiry window are built from
    // consecutive bars, so all three must be fed — in order.
    for (let m = 1; m <= 3; m++) {
      bars.push({ t: FORMING_T + m * MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000, delta: 0 });
    }
    live.replayTimeMs = SCAN_MS + 3 * MIN;
    live.scanMinuteTape();

    assert.deepEqual(engine.fed.slice(cold).map((f) => f.ts),
      [stamp(FORMING_T), stamp(FORMING_T + MIN), stamp(FORMING_T + 2 * MIN)],
      'every bar between the last decision and now is fed, oldest first');
  } finally { restore(); }
});

test('the fed-key is a timestamp, so a dropped oldest bar cannot cause a re-feed', () => {
  const SYM = 'TESTSHIFT';
  const engine = recorder();
  // 400 bars: past the engine's own 390-bar cap, which is where `symBars` starts shifting.
  const bars = minuteBars(400, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanMinuteTape();
    const afterFirst = engine.fed.length;
    assert.equal(afterFirst, 399, 'every bar up to the last closed one is fed on a cold start');

    // The tape's own cap drops its oldest bar, sliding every index down by one.
    bars.shift();
    bars.push({ t: FORMING_T + MIN, o: 100, h: 100.2, l: 99.8, c: 100, v: 1000, delta: 0 });
    live.replayTimeMs = SCAN_MS + MIN;
    live.scanMinuteTape();

    const fresh = engine.fed.slice(afterFirst);
    assert.deepEqual(fresh.map((f) => f.ts), [stamp(FORMING_T)],
      'only the newly closed bar is fed — an index-keyed counter would have replayed ' +
      'hundreds of bars and reset the engine\'s session state');
  } finally { restore(); }
});

test('an emission the PLANNER refused is counted, with its gate', () => {
  const SYM = 'TESTREFUSED';
  // What `orderFlow.onBar` actually answers when the setup fires and no plan can be built —
  // on 2026-10-19 that was 47 RR and 6 EXTENSION, and all of them were dropped on the floor.
  const engine = {
    fed: [],
    onBar(formatted, index) {
      this.fed.push(formatted[index][0]);
      return { ok: false, gate: 'RR', setup: 'OF03', side: 'SHORT', reason: 'no target pays for the risk' };
    },
  };
  const bars = minuteBars(40, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanFunnel = null;
    live.scanMinuteTape();

    const f = live.getScanFunnel();
    assert.equal(f.gb03.refusedPlanner, 1,
      'the refusal must be visible on the board, not identical to a stopped engine: ' + JSON.stringify(f.gb03));
    assert.deepEqual(f.gb03.refusedGates, { RR: 1 }, 'and it names the gate that refused it');
    assert.equal(f.gb03.armed, 0, 'a refused emission arms nothing');
    assert.equal(f.qualified, 0, 'and reaches no table');
  } finally { restore(); }
});

test('the funnel says how many symbols were EVALUATED, so silence has a cause', () => {
  const SYM = 'TESTFUNNEL';
  const engine = recorder();
  const bars = minuteBars(40, FORMING_T);
  const restore = withEngine(SYM, engine);
  try {
    live.symBars = new Map([[SYM, bars]]);
    live.scanFunnel = null;
    live.scanMinuteTape();

    const f = live.getScanFunnel();
    assert.ok(f.gb03, 'an evaluated scan must publish the GB03a counters, not null: ' + JSON.stringify(f.gb03));
    assert.equal(f.gb03.evaluated, 1, 'the symbol\'s closed bar was handed to the engine');
    assert.equal(f.gb03.armed, 0, 'the stand-in engine emits nothing');
    assert.equal(f.gb03.sideRefused, 0, 'and refused no side either');
    assert.equal(f.gb03.refusedPlanner || 0, 0, 'and nothing was emitted for the planner to refuse');
    assert.equal(f.qualified, 0, 'so nothing reaches the board');

    // A tape with no clock cannot be placed in a session, so it is refused by name and NOT
    // counted as evaluated — the refusal that was already here, kept.
    live.scanFunnel = null;
    live.symBars = new Map([[SYM, minuteBars(40, FORMING_T).map(({ t, ...b }) => b)]]);
    live.replayTimeMs = SCAN_MS + 2 * MIN;
    live.scanMinuteTape();
    assert.equal(live.getScanFunnel().gb03 || null, null,
      'a bar without a timestamp is not evaluated, and the funnel must not claim it was');
  } finally { restore(); }
});
