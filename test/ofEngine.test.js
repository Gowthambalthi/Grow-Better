'use strict';

/**
 * The ORDERFLOW engine's EVENT → CONFIRMATION → TRIGGER loop, on OF03.
 *
 * THIS FILE WAS REWRITTEN ON 2026-10-15. It used to pin the LOCATION gate on
 * OF01 absorption and a few OF02 breakout edges. Both setups were removed from
 * the engine (numbers in strategies/orderFlow.js's header), so those tests were
 * removed WITH them — a test for code that no longer exists is not coverage, it
 * is a red light that gets ignored. What was kept is the part that still
 * applies, re-pointed at the setup that remains, and the OF03 gate properties
 * that did NOT exist before are now pinned in their own right rather than only
 * as a side effect of the engine loop.
 *
 * The properties pinned here are the ones the rebuild changed:
 *
 *  - an exhaustion is NOT a signal on the bar that shows it — it is armed, and a
 *    later bar must take out the event bar's OPPOSITE extreme before anything is
 *    emitted;
 *  - the new extreme must be MARGINAL (`of03MaxNewExtremeAtr` × ATR). A violent
 *    break is continuation, not exhaustion;
 *  - the bar must CLOSE BACK AWAY from that extreme (`of03MaxCloseLoc`);
 *  - the recorded `volumeRatio` is the EVENT bar's, not the confirmation bar's.
 *    Getting that backwards is exactly how the analysis harness once reported
 *    trades below a participation floor the setup had actually cleared.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const of = require('../strategies/orderFlow');
const ind = require('../strategy-core/indicators');
const { T } = ind;

// `[time, open, high, low, close, volume]` — the engine indexes by T, so the
// time element is not optional decoration, it is index 0.
const bar = (time, o, h, l, c, v) => [time, o, h, l, c, v];

const market = (over) => Object.assign({ atr: 0.8, atrPct: 1.0, volumeRatio: 2.0 }, over || {});

// ---------------------------------------------------------------------------
// The pure gate: what OF03 accepts and what it refuses.
// ---------------------------------------------------------------------------

test('OF03 fires on a marginal new high that closes back down', () => {
  // prior high 100.2, the bar pushes to 100.30 — 0.10 beyond it, inside the
  // 0.16 allowance (of03MaxNewExtremeAtr 0.20 × ATR 0.8) — and closes at 99.95,
  // the bottom 12.5% of its own range. That is aggression that failed to hold.
  const found = of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.30, 99.90, 99.95),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  });
  assert.ok(found, 'a marginal, rejected new high is the setup');
  assert.equal(found.side, 'SHORT');
  assert.equal(found.triggerLevel, 99.90, 'the trigger is the event bar\'s OPPOSITE extreme');
  assert.equal(found.invalidation, 100.30, 'the invalidation is the extreme that failed to hold');
});

test('OF03 refuses a new extreme that is not marginal — that is continuation', () => {
  // 100.60 is 0.40 beyond the prior high, twice the allowance. A break that big
  // is the opposite of exhaustion, so the setup must not fire.
  assert.equal(of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.60, 99.90, 99.95),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }), null);
});

test('OF03 refuses a new extreme it did NOT close back away from', () => {
  // same marginal push, but the close sits at 88% of the range: the new high
  // HELD, so there is no failed aggression to trade.
  assert.equal(of.exhaustion({
    bar: bar('2026-01-05 10:00', 99.90, 100.30, 99.85, 100.25),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }), null);
});

test('OF03 refuses when participation did not rise', () => {
  assert.equal(of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.30, 99.90, 99.95),
    market: market({ volumeRatio: 1.0 }), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }), null, 'the of03MinVolRatio floor is part of the setup, not a filter on top');
});

// ---------------------------------------------------------------------------
// THE v2 VALUES, PINNED. Six values were tightened together on 2026-10-17
// (docs/ORDERFLOW-PHASE2.md, OF03-v2). A REVERT IS SILENT WITHOUT THESE: every
// case below passes under v1's looser value and fails under v2's, so putting
// 1.5 back, or 0.25, or 0.40, turns this file red instead of quietly shipping
// thresholds nobody measured.
// ---------------------------------------------------------------------------

test('v2 PIN: participation must clear 1.7×, not v1\'s 1.5×', () => {
  const evt = (volRatio) => of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.30, 99.90, 99.95),
    market: market({ volumeRatio: volRatio }), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  });
  assert.equal(evt(1.6), null, '1.6× cleared v1 and must NOT clear v2');
  assert.ok(evt(1.75), '1.75× clears 1.7×');
});

test('v2 PIN: the new extreme may exceed the prior one by 0.20×ATR, not 0.25×', () => {
  // ATR 0.8 → v2 allows 0.16 beyond, v1 allowed 0.20. A push of 0.18 is the
  // discriminating case: marginal under v1, continuation under v2.
  assert.equal(of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.38, 99.90, 99.95),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }), null, '0.18 beyond is over the v2 allowance of 0.16');
});

test('v2 PIN: the close must sit in the bottom 35% of the range, not 40%', () => {
  // `closeLocation` is measured UP FROM THE LOW: (close − low) / range. Range
  // 99.90 → 100.30 = 0.40, so a close at 100.052 sits 38% of the way up — inside
  // v1's 0.40 band, outside v2's 0.35. That is the discriminating case.
  assert.equal(of.exhaustion({
    bar: bar('2026-01-05 10:00', 100.25, 100.30, 99.90, 100.052),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }), null, '38% from the low is inside v1\'s band and outside v2\'s');
  // 33% from the low is inside both, so the setup itself must still fire here.
  assert.ok(of.exhaustion({
    bar: bar('2026-01-05 10:01', 100.25, 100.30, 99.90, 100.032),
    market: market(), priorHigh: 100.2, priorLow: 99.0, cfg: of.DEFAULTS,
  }));
});

test('v2 PIN: no event may be armed after the 12:30 IST cutoff', () => {
  // THE CUTOFF LIVES IN THE ENGINE LOOP, not in the pure gate, so it has to be
  // driven through onBar: a textbook exhaustion at 12:31 must neither arm nor emit.
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(clockBar(12 * 60 + i, 100, 100.2, 99.8, 100, 1000));
  const eventIdx = bars.length;
  bars.push(clockBar(12 * 60 + 31, 100.15, 100.25, 99.95, 100.00, 3000));
  bars.push(clockBar(12 * 60 + 32, 99.90, 99.95, 99.50, 99.60, 1000));

  const eng = of.createEngine();
  const out = bars.map((_, i) => eng.onBar(bars, i));
  assert.equal(out[eventIdx], null);
  assert.equal(out[eventIdx + 1], null, 'nothing may be emitted after the cutoff');
  assert.equal(eng.state().pending, null, 'the event must not even be armed past 12:30');
});

test('OF03 mirrors: a marginal new low that closes back up is a LONG', () => {
  const found = of.exhaustion({
    bar: bar('2026-01-05 10:00', 99.75, 100.00, 99.70, 99.95),
    market: market(), priorHigh: 101.0, priorLow: 99.8, cfg: of.DEFAULTS,
  });
  assert.ok(found, 'the short side must not be the only one implemented');
  assert.equal(found.side, 'LONG');
  assert.equal(found.triggerLevel, 100.00);
  assert.equal(found.invalidation, 99.70);
});

// ---------------------------------------------------------------------------
// The engine loop: armed, then confirmed one bar later.
// ---------------------------------------------------------------------------

const clockBar = (minute, o, h, l, c, v) => bar('2026-01-05 ' + String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0'), o, h, l, c, v);

/** 30 flat bars so the session has a tail and a prior high of 100.20. */
function warmup() {
  const bars = [];
  for (let i = 0; i < 30; i++) bars.push(clockBar(9 * 60 + 15 + i, 100, 100.2, 99.8, 100, 1000));
  return bars;
}

test('an exhaustion is armed, then emitted only once its extreme is taken out', () => {
  const bars = warmup();
  const eventIdx = bars.length;
  // the EVENT bar: a marginal new high on 3× volume, closing back at the low end
  bars.push(clockBar(9 * 60 + 45, 100.15, 100.25, 99.95, 100.00, 3000));
  // the CONFIRMATION bar: its close takes out the event bar's LOW (99.95)
  bars.push(clockBar(9 * 60 + 46, 99.90, 99.95, 99.50, 99.60, 1000));

  // Drive every bar in order — the session has to see the warm-up to have a tail.
  const eng = of.createEngine();
  const out = bars.map((_, i) => eng.onBar(bars, i));

  assert.equal(out[eventIdx], null, 'the event bar itself must not be a signal');
  const s = out[eventIdx + 1];
  assert.ok(s, 'the confirmation bar emits');
  assert.equal(s.setup, 'OF03');
  assert.equal(s.side, 'SHORT', 'a failed new high is a SHORT');
  assert.equal(s.setupData.barsToTrigger, 1, 'confirmed one bar later');

  // WHERE THE ENGINE'S JOB ENDS. On this synthetic tape the plan is refused —
  // the only structure available is the probed level, which for a SHORT sits
  // ABOVE the entry, so no target can pay for the risk. WHICH planner gate
  // refuses is the planner's call and is NOT pinned here: this same bar has
  // already moved from the RR gate to the EXTENSION gate when the RR floor was
  // relaxed, so naming one gate would be asserting a planner internal through
  // the engine's door, and would break on the next planner change that has
  // nothing to do with this engine. What IS pinned is the engine's contract:
  // the confirmation bar produces a well-formed signal attempt, either planned
  // or carrying the name of the gate that refused it.
  assert.ok(s.ok === true || typeof s.gate === 'string',
    'the signal must either carry a plan or name the gate that refused it; got ' +
    JSON.stringify({ ok: s.ok, gate: s.gate }));

  // THE MEASUREMENT THAT WAS WRONG: the event bar carried 3000 against a ~1000
  // average, so its own ratio is 3.0; the confirmation bar carried 1000 and is
  // under the participation floor the setup actually cleared.
  assert.ok(s.setupData.volumeRatio > 2.5, 'volumeRatio is the EVENT bar\'s participation, got ' + s.setupData.volumeRatio);
  assert.ok(s.setupData.triggerVolumeRatio < 1.5, 'triggerVolumeRatio is the CONFIRMATION bar\'s, got ' + s.setupData.triggerVolumeRatio);
  assert.notEqual(s.setupData.volumeRatio, s.setupData.triggerVolumeRatio,
    'the two bars are different bars and must not be conflated');

  // THE VOLATILITY REGIME is recorded at the EVENT bar too, so the decomposition
  // can ask whether the edge lives in one ATR% band.
  assert.ok(s.setupData.eventAtrPct > 0, 'the event bar\'s ATR% must be recorded');
  assert.equal(typeof s.setupData.atrPct, 'number', 'the decision-bar ATR% is recorded as well');
});

test('an event whose invalidation breaks first is dropped, not fired', () => {
  const bars = warmup();
  const eventIdx = bars.length;
  bars.push(clockBar(9 * 60 + 45, 100.15, 100.25, 99.95, 100.00, 3000));
  // the next bar runs back THROUGH the event high (100.25): the push held after all
  bars.push(clockBar(9 * 60 + 46, 100.10, 100.40, 100.00, 100.30, 1000));
  const eng = of.createEngine();
  const out = bars.map((_, i) => eng.onBar(bars, i));
  assert.equal(out[eventIdx], null);
  assert.equal(out[eventIdx + 1], null, 'invalidation broken — the event is void');
});

// ---------------------------------------------------------------------------
// LIVE / BACKTEST PARITY ON THE CUTOFF
//
// The live minute engine builds this engine through `createEngine()`. It used to pass
// only `{ symbol, minAtrPct }`, which left `maxSignalTime` at the module DEFAULT (12:30)
// while strategy-core/engines.js pinned the MEASURED 11:00 — so live could arm a call
// between 11:00 and 12:30 that the backtest justifying OF03 never took. The cutoff is
// now read from the registry entry, and this pin makes a future drift fail here instead
// of showing up as a live call with no measurement behind it.
test('the live scan hands the backtested engine the REGISTRY configuration', () => {
  const live = require('../strategies/orderflow/liveMinuteEngine');
  const { BY_KEY } = require('../strategy-core/engines');
  const measured = BY_KEY.ORDERFLOW.config || {};
  // IDENTITY, NOT JUST EQUALITY. The old pin compared the values, which stopped
  // proving anything once the registry was corrected to agree with the engine's
  // own DEFAULTS: "/=" between two equal numbers is the only thing that made it a
  // test of READ-THROUGH. Holding the object itself proves live reads the registry
  // entry whatever the number becomes.
  assert.equal(live.of03Config, measured,
    'live OF03 must hold the registry entry itself, not a copy of one of its fields');
  assert.equal(measured.maxSignalTime, of.DEFAULTS.maxSignalTime,
    'the registry pin and the engine default must agree — 11:00 vs 12:30 was exactly the drift');
  assert.equal(measured.maxSignalTime, 1230,
    'cutoff re-measured 2026-10-18 on 705 sessions: 12:30 = 25 trades netPF 1.997 / +15.97R vs 11:00 = 21 / 1.746 / +9.24R');
});

test('an event that is never confirmed expires instead of firing late', () => {
  const bars = warmup();
  const eventIdx = bars.length;
  bars.push(clockBar(9 * 60 + 45, 100.15, 100.25, 99.95, 100.00, 3000));
  // four bars that neither take out the low nor break the high: the window is
  // `of03TriggerBars` (3) bars of CLOSED bars, so this must simply expire.
  for (let i = 0; i < 4; i++) bars.push(clockBar(9 * 60 + 46 + i, 100.0, 100.2, 99.96, 100.0, 1000));
  const eng = of.createEngine();
  const out = bars.map((_, i) => eng.onBar(bars, i));
  assert.equal(out[eventIdx], null);
  for (let i = eventIdx + 1; i < bars.length; i++) {
    assert.equal(out[i], null, 'nothing may be emitted after the trigger window closes');
  }
});
