'use strict';

/**
 * THE NIFTY MACRO GATE MUST BE ABLE TO SAY "BEARISH".
 *
 * V1.3 advertises a Nifty 50 Macro Regime Gate: when Nifty trades below its
 * intraday VWAP, longs must prove extra relative strength (confluence >= 3 AND
 * delta >= +15%), because index-basket selling drags single names down with it.
 *
 * It has never fired. The regime is computed from the Nifty bars' traded volume,
 * and an INDEX FEED CARRIES NO TRADED VOLUME — every index print carries q = 0.
 * So the cumulative denominator was always 0, the fallback set vwap = currentPrice,
 * and `currentPrice >= vwap` was therefore TRUE on every bar:
 *
 *     regime === 'BEARISH'   was unreachable, on every session, always.
 *     isNiftyBearish         was always false, so the stricter gate never applied.
 *
 * On 2026-10-12 Nifty fell -0.84% and traded below its intraday VWAP for most of
 * the session; the engine armed longs into it all afternoon and 8 of them stopped
 * out. A gate that cannot be true is worse than no gate, because its presence is
 * recorded as protection.
 *
 * These tests use `v: 0` bars deliberately — a volume-carrying series already
 * worked, and the bug lived precisely in the zero-volume case a real index produces.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads: a scan would otherwise write today's real
// daily_calls file into the repo.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nifty-regime-'));
process.env.GB_ORDERFLOW_DIR = TMP;

const engine = require('../strategies/orderflow/liveMinuteEngine');

/** `n` one-minute Nifty bars walking from `from` to `to`, with NO traded volume. */
function indexBars(n, from, to) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = from + ((to - from) * i) / (n - 1);
    out.push({ h: c + 1, l: c - 1, c, v: 0 });
  }
  return out;
}

/** One bounded, deliberate test at a time — this module is a shared singleton. */
function withNifty(bars) {
  engine.symBars.clear();
  if (bars) engine.symBars.set('NIFTY', bars);
}

test('a zero-volume index FALLING below its own time-weighted VWAP reads BEARISH', () => {
  // 40 bars from 22,500 down to 22,300: price ends below the session mean, which is
  // the definition the gate needs. With the volume-weighted formula this returned
  // BULLISH, because vwap collapsed onto the last price.
  withNifty(indexBars(40, 22500, 22300));
  const r = engine.getNiftyRegime();
  assert.equal(r.regime, 'BEARISH',
    'a falling index must not read BULLISH — that made the macro gate dead code');
  assert.ok(r.vwap > 0, 'the VWAP must be a real price level, not zero');
  assert.ok(r.distPct < 0, 'price below VWAP is a negative distance: ' + r.distPct);
});

test('a zero-volume index RISING above its own time-weighted VWAP reads BULLISH', () => {
  withNifty(indexBars(40, 22300, 22500));
  const r = engine.getNiftyRegime();
  assert.equal(r.regime, 'BULLISH');
  assert.ok(r.distPct > 0, 'price above VWAP is a positive distance: ' + r.distPct);
});

test('the volume-weighted VWAP is still used when the series DOES carry volume', () => {
  // One heavy high-volume bar at the open pins the VWAP near 22,600; price then
  // drifts to 22,450 and must still read BEARISH against that volume-weighted mean.
  // This proves the index fallback did not replace the normal calculation.
  withNifty([
    { h: 22610, l: 22590, c: 22600, v: 100000 },
    { h: 22470, l: 22440, c: 22450, v: 10 },
    { h: 22470, l: 22440, c: 22450, v: 10 },
    { h: 22470, l: 22440, c: 22450, v: 10 },
    { h: 22470, l: 22440, c: 22450, v: 10 },
  ]);
  const r = engine.getNiftyRegime();
  assert.equal(r.regime, 'BEARISH',
    'with real volume the weighted mean must dominate the last price');
  assert.ok(r.vwap > 22500, 'the VWAP must sit near the heavy bar, not the last close: ' + r.vwap);
});

test('too few bars is NEUTRAL rather than a guess', () => {
  withNifty(indexBars(3, 22500, 22400));
  assert.equal(engine.getNiftyRegime().regime, 'NEUTRAL');

  withNifty(null);
  const missing = engine.getNiftyRegime();
  assert.equal(missing.regime, 'NEUTRAL', 'a missing index series must not fabricate a regime');
});

test.after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
