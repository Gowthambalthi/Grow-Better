'use strict';

/**
 * The Stage-B event study (MFE / MAE / reversal / turn time) — the measurement
 * the detector and trigger are to be judged against BEFORE either is changed.
 *
 * Direction is the whole point of these assertions: for a LONG event an UP move
 * is favourable, for a SHORT event a DOWN move is, and getting that backwards
 * would silently invert every reported result.
 *
 * Requiring this module must also be cheap — it runs main() only as a script, so
 * a test file can import the math without streaming three 300-460 MB tapes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { measure, RESPONSE_WINDOWS, WINDOWS } = require('../backtest/eventMicro');

const T0 = 1790567100000;
const tick = (dt, p, q) => ({ t: T0 + dt, p, q: q == null ? 100 : q });

/** Pre-event ticks so the 10/20/30/60s look-back windows all have data. */
const pre = () => [tick(-60000, 100), tick(-30000, 100), tick(-10000, 100), tick(-5000, 100)];

const event = (side) => ({
  symbol: 'X', day: '2026-09-28', ms: T0, setup: 'OF01', side,
  time: '2026-09-28 10:00', locationType: 'POC',
  price: 100, atrPct: 0.5, minute: 600, block: '10:30-12:00',
});

// Percent arithmetic on prices like 100.20 never lands on an exact float, so
// magnitudes are compared with a tolerance rather than by value.
const close = (actual, expected, msg) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg + ' (got ' + actual + ', want ' + expected + ')');
};

test('the module is importable without reading the tapes', () => {
  assert.equal(typeof measure, 'function');
  assert.deepEqual(RESPONSE_WINDOWS, [30, 60, 120]);
  assert.ok(WINDOWS.includes(60), 'the 1-minute look-back is measured too');
});

test('a LONG event: the dip is adverse, the recovery favourable', () => {
  const series = pre().concat([
    tick(10000, 100.00),   // base
    tick(20000, 99.90),    // -0.10% against the event
    tick(30000, 100.10),   // +0.10% in its favour → the turn
    tick(60000, 100.15),
    tick(120000, 100.20),
  ]);
  const m = measure(event('LONG'), series);
  assert.ok(m);

  close(m.mfe120, 0.20, 'best favourable excursion to 120s');
  close(m.mae120, 0.10, 'worst adverse excursion to 120s');
  close(m.response120, 0.20, 'net move in the event favour, +120s');
  close(m.responseRaw120, 0.20, 'raw price change for a LONG is unmodified');

  assert.equal(m.reversed30, true, 'it is up by 30s');
  assert.equal(m.reversed60, true);
  assert.equal(m.reversed120, true);
  assert.equal(m.turnSeconds, 30, 'first print >= +0.05% comes at 30s');
  close(m.mfe30, 0.10, 'within 30s the best was +0.10%');
});

test('a SHORT event: a FALL is favourable, a RISE is adverse', () => {
  const series = pre().concat([
    tick(10000, 100.00),   // base
    tick(20000, 100.10),   // +0.10% AGAINST a short
    tick(30000, 99.90),    // -0.10% in its favour → the turn
    tick(60000, 99.85),
    tick(120000, 99.80),
  ]);
  const m = measure(event('SHORT'), series);
  assert.ok(m);

  close(m.mfe120, 0.20, 'MFE is direction-aware: the fall is the win');
  close(m.mae120, 0.10, 'the rise is the adverse move');
  close(m.response120, 0.20, 'favourable');
  close(m.responseRaw120, -0.20, 'the RAW move is still negative - direction is applied separately');
  assert.equal(m.reversed120, true);
  assert.equal(m.turnSeconds, 30);
});

test('an event with no tape after it reports nulls, never a fake zero', () => {
  const m = measure(event('LONG'), pre());
  assert.ok(m, 'the look-back alone still measures');
  assert.equal(m.reversed120, null, 'no post-event prints cannot be a reversal');
  assert.equal(m.mfe120, null);
  assert.equal(m.mae120, null);
  assert.equal(m.response120, null);
  assert.equal(m.turnSeconds, null);
});

test('every Stage-C trigger is recorded separately, and baseline always fires', () => {
  const series = pre().concat([tick(10000, 100), tick(60000, 100.2), tick(120000, 100.2)]);
  const m = measure(event('LONG'), series);
  assert.ok(m.triggers, 'the trigger candidates must be stored on the event');
  for (const k of ['baseline', 'change30', 'change60', 'bothChange', 'effortChange', 'priceConfirm', 'deltaConfirm']) {
    assert.equal(typeof m.triggers[k], 'boolean', k + ' must be a plain boolean flag');
  }
  assert.equal(m.triggers.baseline, true, 'baseline is the 1-minute confirmation we already have');
});
