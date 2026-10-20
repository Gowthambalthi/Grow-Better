'use strict';

/**
 * INTRADAY STRATEGY SANITY — structural defects, not market results.
 *
 * These tests pin two classes of bug that produce actively MISLEADING numbers:
 *
 *  1. THE SELF-CANCELLING SETUP. A strategy whose exit condition is already true
 *     when it enters closes on its own entry bar. "Gap fade to VWAP" did exactly
 *     this (entry required close < VWAP; exit fired on close <= VWAP) and 92% of
 *     its 88,345 trades lasted one bar, so its measured PF 0.310 was the collision
 *     rather than the idea. A strategy like that must not be read as evidence
 *     about the market, and it must not come back unnoticed.
 *
 *  2. SIZING OFF THE WRONG LIMIT. portfolioSim() took a concurrency limit but sized
 *     every position as capital/20 regardless, so changing the enforced slot count
 *     silently simulated a different account.
 *
 * Whether a setup EARNS its place is the sweep's question, not this file's. These
 * assert only that it can express its own logic and that the account is the one
 * it says it is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SWEEP = require(path.join(ROOT, 'backtest', 'intradayStrategies.js'));
const { STRATEGIES, runStrategy, portfolioSim } = SWEEP;
const CORPUS = path.join(ROOT, 'data', 'ohlcv_1m');

// A small, deterministic slice keeps this fast enough for the default suite.
const SYMBOLS = Number(process.env.SANITY_SYMBOLS || 12);

function loadSlice() {
  if (!fs.existsSync(CORPUS)) return [];
  const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.json')).sort().slice(0, SYMBOLS);
  const out = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CORPUS, f), 'utf8'));
      const bars = (j.candles || [])
        .map((c) => [String(c[0]), +c[1], +c[2], +c[3], +c[4], +c[5]])
        .filter((b) => b[4] > 0);
      if (bars.length >= 200) out.push({ symbol: j.symbol || f, bars });
    } catch (_) { /* unreadable symbol is not this test's failure */ }
  }
  return out;
}

const SLICE = loadSlice();

test('corpus slice is available for the strategy audit', () => {
  assert.ok(SLICE.length > 0,
    'no usable symbols under data/ohlcv_1m — the audit cannot run, which is not the same as passing');
});

test('no strategy exits on its entry bar for the bulk of its trades', () => {
  // Normal setups here sit at 0.1%–25%. A self-cancelling setup sat at 92%.
  // The bound is deliberately loose: this catches a collapse, it does not police
  // a strategy's holding period.
  const MAX_ONE_BAR_SHARE = 0.45;
  const offenders = [];
  for (const def of STRATEGIES) {
    let total = 0, one = 0;
    for (const { symbol, bars } of SLICE) {
      let trades;
      try { trades = runStrategy(def, symbol, bars, null, {}); } catch (_) { continue; }
      for (const t of trades) { total++; if (t.barsHeld === 1) one++; }
    }
    if (total < 20) continue;                       // too few to judge
    const share = one / total;
    if (share > MAX_ONE_BAR_SHARE) offenders.push(def.name + ': ' + (share * 100).toFixed(1) + '% one-bar of ' + total);
  }
  assert.deepEqual(offenders, [],
    'these setups close on their own entry bar — their measured PF is the exit/entry collision, not the idea:\n  ' + offenders.join('\n  '));
});

test('Gap fade to VWAP holds a position long enough to reach its target', () => {
  // The regression this pins: the setup shorted BELOW VWAP and exited AT VWAP, so a
  // trade could not survive its own entry bar (mean hold was 2.23 bars). Entering
  // above VWAP gives the short an actual downside target, so holds must be real.
  const def = STRATEGIES.find((d) => /fade/i.test(d.name));
  assert.ok(def, 'Gap fade to VWAP must remain in the registry');
  let total = 0, held = 0;
  for (const { symbol, bars } of SLICE) {
    let trades;
    try { trades = runStrategy(def, symbol, bars, null, {}); } catch (_) { continue; }
    for (const t of trades) { total++; held += t.barsHeld; }
  }
  if (total < 10) return;            // not enough evidence on this slice to assert
  const meanHold = held / total;
  assert.ok(meanHold > 5,
    'Gap fade to VWAP mean hold is ' + meanHold.toFixed(2) + ' bars — a setup that exits as it enters cannot reach VWAP');
});

test('portfolio sizing follows the enforced concurrency limit', () => {
  const mk = (i) => ({
    entryTs: 1000 + i * 10, exitTs: 1005 + i * 10,
    grossPct: 0.1, symbol: 'S' + i, day: '2026-01-05',
  });
  const trades = Array.from({ length: 8 }, (_, i) => mk(i));

  for (const limit of [4, 10, 20]) {
    const r = portfolioSim(trades, 0, limit);
    assert.equal(r.concurrentLimit, limit, 'limit is reported honestly');
    assert.equal(r.initialNotionalPerPosition, +(100 / limit).toFixed(3),
      'per-position notional must be capital/limit, not capital/20 (limit=' + limit + ')');
  }
});

test('every booked exit price was actually traded in its exit bar', () => {
  // THE UNOBTAINABLE FILL. A stop or target is a LEVEL; booking it is only honest if
  // the bar traded there. When a bar gaps through the level it sits outside that bar's
  // [low, high], and the old code recorded the level anyway — 2.4% of 269,834 trades,
  // always in the optimistic direction. The fill must be the level when the bar traded
  // there, otherwise the bar's open (the first price actually available).
  const offenders = [];
  for (const { symbol, bars } of SLICE) {
    const idx = new Map();
    bars.forEach((b, i) => idx.set(Date.parse(b[0]), i));
    for (const def of STRATEGIES) {
      let trades;
      try { trades = runStrategy(def, symbol, bars, null, {}); } catch (_) { continue; }
      for (const t of trades) {
        const xi = idx.get(t.exitTs);
        if (xi == null) { offenders.push(def.name + '/' + symbol + ': exitTs not a bar'); continue; }
        const b = bars[xi];
        if (t.exit < b[3] - 1e-6 || t.exit > b[2] + 1e-6) {
          offenders.push(def.name + '/' + symbol + ': exit ' + t.exit + ' outside [' + b[3] + ',' + b[2] + ']');
        }
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [],
    'these exits book a price the bar never traded:\n  ' + offenders.slice(0, 10).join('\n  '));
});

test('entry is the OPEN of the bar after the signal bar', () => {
  // A look-ahead entry would be invisible in the aggregate numbers and would make every
  // strategy look better. Pin it directly.
  const offenders = [];
  for (const { symbol, bars } of SLICE.slice(0, 4)) {
    const idx = new Map();
    bars.forEach((b, i) => idx.set(Date.parse(b[0]), i));
    for (const def of STRATEGIES) {
      let trades;
      try { trades = runStrategy(def, symbol, bars, null, {}); } catch (_) { continue; }
      for (const t of trades) {
        const i = idx.get(t.entryTs);
        if (i == null) { offenders.push(def.name + ': entryTs not a bar'); continue; }
        if (Math.abs(bars[i][1] - t.entry) > 1e-6) {
          offenders.push(def.name + '/' + symbol + ': entry ' + t.entry + ' != bar open ' + bars[i][1]);
        }
      }
    }
  }
  assert.deepEqual(offenders.slice(0, 10), [],
    'these trades did not enter at a bar open:\n  ' + offenders.slice(0, 10).join('\n  '));
});

test('requiring the harness does not run the sweep', () => {
  // The gate test and this file both `require` the harness. If it ran main() on
  // import it would rewrite data/terminal/*.json as a side effect of a test run.
  assert.equal(typeof SWEEP.loadManifest, 'function');
  assert.equal(typeof SWEEP.portfolioSim, 'function');
  assert.ok(Array.isArray(SWEEP.STRATEGIES) && SWEEP.STRATEGIES.length > 0);
});

// ---------------------------------------------------------------- THE WINDOW
// sliceFor() is the one part of the harness the trade-level parity check does not
// cover (that runs on full bars), and it is the part whose failure mode is the
// quietest: a window off by a session or two leaves every individual trade correct
// and only changes the AGGREGATE. It was hoisted out of main() and given explicit
// arguments so it could be pinned here — and it earned it: a 2-trade divergence in
// one strategy turned out to be a floating-point gap in an indicator, which would
// have been invisible without a window that could be tested on its own.
test('sliceFor keeps exactly WARMUP sessions of context before the first authorized session', () => {
  const days = ['2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09'];
  const bars = [];
  for (const d of days) {
    for (const hm of ['09:15', '09:16', '09:17']) bars.push([d + ' ' + hm + ':00', 100, 101, 99, 100, 1000]);
  }
  const w = SWEEP.sliceFor(bars, '2026-01-07', '2026-01-08', 1);
  assert.equal(w[0][0], '2026-01-06 09:15:00', 'the window must open one warmup session earlier');
  assert.equal(w[w.length - 1][0], '2026-01-08 09:17:00', 'the window must stop at the last authorized session');
  assert.equal(w.length, 9, 'one warmup session + two authorized sessions');
});

test('sliceFor never hands a strategy a bar after the last authorized session', () => {
  // THE NO-LEAK PROPERTY, asserted directly. Bars after the last authorized session
  // are VALIDATION / FINAL / SEALED data; if one reached a strategy, no result from
  // this harness could be trusted regardless of what the manifest said.
  const days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-29', '2026-09-30'];
  const bars = [];
  for (const d of days) bars.push([d + ' 09:15:00', 100, 101, 99, 100, 1000], [d + ' 09:16:00', 100, 101, 99, 100, 1000]);
  const w = SWEEP.sliceFor(bars, '2026-09-24', '2026-09-24', 1);
  const leaked = w.filter((b) => String(b[0]).slice(0, 10) > '2026-09-24');
  assert.deepEqual(leaked.map((b) => b[0]), [], 'SEALED sessions must not be readable here');
  assert.equal(w.length, 4, 'one warmup session plus the authorized session');
});

test('sliceFor returns nothing when the authorized window is absent from the bars', () => {
  const bars = [['2026-01-05 09:15:00', 100, 101, 99, 100, 1000]];
  const w = SWEEP.sliceFor(bars, '2026-06-01', '2026-06-30', 6);
  assert.deepEqual(w, [], 'a symbol with no authorized session must contribute no window');
});
