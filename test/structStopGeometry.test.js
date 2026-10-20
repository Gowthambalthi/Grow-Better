'use strict';

/**
 * THE EXIT GEOMETRY THE ENGINE RUNS IS THE ONE THE TESTS PIN.
 *
 * `pickStopGeometry` is the ONE place the momentum engine picks its stop and target. Until
 * 2026-10-13 the shape was fixed (stop clamp 45–55 bps off |vwapDist|+0.25, target 1.5× the
 * risk). The owner asked for the Sweep engine's structural shape here too ("risk strictly
 * capped at structural invalidation level"), and it is gated behind GB_STRUCT_STOP=1 until
 * the tape measurement (scratch/measure_struct_stop.js) says it pays net. Both shapes are
 * pinned here so neither can change silently:
 *
 *   - the FIXED shape must be numerically identical to the shipped line it replaced;
 *   - the STRUCTURAL shape puts the stop at the setup's own invalidation level (20-bar swing,
 *     or the nearer of swing and a live FVG's distal edge) with a buffer past it, and refuses
 *   - rather than widening: no structure, wrong side, or farther than maxStop → null.
 *
 * The scorecard guard is pinned too: one dispatch per date, persisted on disk, and no card
 * at all when the engine recorded no calls — the channel shipped the same scorecard
 * repeatedly through 2026-10-13 and one of them scored a single +₹0 call as a 100% win.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads: a scan would otherwise write today's real daily_calls
// file into the repo, and the Telegram sender must not page anyone from a test. The SEND LEDGER
// is sandboxed with it: this file exercises the real scorecard dispatcher, whose key is
// `scorecard:<today>` — written to the app's own ledger, that key would silently suppress the
// session's actual scorecard, and a missing card is a symptom nobody would trace back to a test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'struct-geometry-'));
process.env.GB_ORDERFLOW_DIR = TMP;
process.env.GB_TELEGRAM_LEDGER = path.join(TMP, 'telegram_sent_ledger.json');
const tel = require('../common/notifications/telegramService');
let telegramCalls = 0;
const realSender = tel.sendPhoneNotification;
tel.sendPhoneNotification = async () => { telegramCalls++; return { success: true }; };

const engine = require('../strategies/orderflow/liveMinuteEngine'); // the singleton instance

// The picker must be reachable for direct assertions (same arrangement as fvgShortGate).
assert.equal(typeof engine.pickStopGeometry, 'function', 'pickStopGeometry must be exposed on the instance');

/** Bars for `pickStopGeometry`: rising close series with a swing high at index i. */
function series(closes, hh) {
  return closes.map((c) => ({ o: c, h: hh || c + 1, l: c - 1, c, v: 10 }));
}

test('fixed shape matches the shipped line exactly (default, not structural)', () => {
  const live = engine;
  assert.equal(live.structStopMode, false, 'shipped default stays the fixed clamp until the measurement passes');
  // |vwapDist| = 0.10% → bps = (0.10 + 0.25) * 100 = 35 → clamped to 45; target = 1.5x = 68.
  const g = engine.pickStopGeometry(-1, live, series(Array(30).fill(100)), 100, -0.10, null);
  assert.equal(g.mode, 'FIXED_CLAMP');
  assert.equal(g.stopBps, 45);
  assert.equal(g.stopPrice, +(100 * (1 + 45 / 10000)).toFixed(2));
  assert.equal(g.targetBps, Math.min(live.shortTargetBps || 75, Math.round(45 * 1.5)));
});

test('fixed shape long side is the mirror with the same clamp', () => {
  const live = engine;
  const g = engine.pickStopGeometry(+1, live, series(Array(30).fill(100)), 100, 0.10, null);
  assert.equal(g.mode, 'FIXED_CLAMP');
  assert.equal(g.stopBps, 45);
  assert.equal(g.stopPrice, +(100 * (1 - 45 / 10000)).toFixed(2));
  assert.equal(g.targetBps, Math.round(45 * 1.5));
});

test('structural short: stop at the nearer of swing high and FVG distal edge, target = RR x risk', () => {
  const live = engine;
  const prevMode = live.structStopMode, prevRr = live.structTargetRr, prevMax = live.structMaxStopBps;
  try {
    live.structStopMode = true; live.structTargetRr = 1.0; live.structMaxStopBps = 150;
    // Price 100, swing high of the 25-excluding-5 window = 100.60 (60 bps swing, bars below).
    const closes = Array(30).fill(100);
    const bars = closes.map((c, i) => ({ o: c, h: i >= 5 ? 100.60 : c + 0.1, l: c - 0.1, c, v: 10 }));
    const g = engine.pickStopGeometry(-1, live, bars, 100.00, -0.10, null);
    assert.equal(g.mode, 'STRUCT_INVALIDATION');
    // stop = swing + 5 bps buffer → distance = 60 + 5 = 65 bps
    assert.equal(g.stopBps, 65);
    assert.equal(g.stopPrice, 100.65);
    assert.equal(g.targetBps, 65);
    assert.equal(g.structLevel, 100.60);
  } finally {
    live.structStopMode = prevMode; live.structTargetRr = prevRr; live.structMaxStopBps = prevMax;
  }
});

test('structural mode refuses what it cannot cap: no structure, wrong side, too far', () => {
  const live = engine;
  const prevMode = live.structStopMode, prevMax = live.structMaxStopBps;
  try {
    live.structStopMode = true; live.structMaxStopBps = 150;
    // No bars at all → no swing, no FVG → refusal.
    assert.equal(engine.pickStopGeometry(-1, live, [], 100, -0.10, null), null);
    // Structure BEHIND the short's entry (swing high below price) → refusal.
    const bars = Array(30).fill(0).map(() => ({ o: 100, h: 99, l: 98, c: 100, v: 10 }));
    assert.equal(engine.pickStopGeometry(-1, live, bars, 100, -0.10, null), null);
    // Farther than the cap → refusal, never a widened stop.
    const far = Array(30).fill(0).map(() => ({ o: 100, h: 102, l: 99, c: 100, v: 10 }));
    assert.equal(engine.pickStopGeometry(-1, live, far, 100, -0.10, null), null);
  } finally {
    live.structStopMode = prevMode; live.structMaxStopBps = prevMax;
  }
});

test('structural FVG edge is used when it is nearer than the swing (short)', () => {
  const live = engine;
  const prevMode = live.structStopMode;
  try {
    live.structStopMode = true;
    const bars = Array(30).fill(0).map(() => ({ o: 100, h: 100.60, l: 99, c: 100, v: 10 }));
    // FVG top at 100.20 (nearer than swing 100.60).
    const fvg = { top: 100.20, bottom: 100.10, ce: 100.15, gapBps: 10, bodyFrac: 0.8, live: true };
    const g = engine.pickStopGeometry(-1, live, bars, 100, -0.10, fvg);
    assert.equal(g.structLevel, 100.20);
    // stop = level + buffer, where buffer = max(0.05, price x 5 bps) = 0.05 here.
    assert.equal(g.stopPrice, 100.25);
    assert.equal(g.stopBps, +(((100.25) - 100) / 100 * 10000).toFixed(1));
  } finally {
    live.structStopMode = prevMode;
  }
});

test('live clock default is bit-identical to the pre-replay formula (replayTimeMs null)', () => {
  // The replay clock is a pin, not a replacement: with replayTimeMs unset, istMinute() must
  // compute exactly what it computed before the replay override existed, or every live session
  // gate (arm cutoff, 15:30 close) would move.
  const live = engine;
  assert.equal(live.replayTimeMs, null, 'live default has no replay pin set');
  const got = live.istMinute();
  const d = new Date(Date.now() + 330 * 60000);
  const want = d.getUTCHours() * 60 + d.getUTCMinutes();
  // Allow the boundary case where the two calls straddle a minute.
  assert.ok(Math.abs(got - want) <= 1, `istMinute ${got} must match the live formula ${want}`);

  // And the pin moves it to the TAPE minute when set.
  live.replayTimeMs = Date.UTC(2026, 9, 13, 6, 0, 0); // 11:30 IST
  assert.equal(live.istMinute(), 11 * 60 + 30, 'a pinned replay clock drives the session gates');
  live.replayTimeMs = null;
});

test('the scorecard dispatches once per date and never for an empty book', async () => {
  const live = engine;
  const DATA_DIR = process.env.GB_ORDERFLOW_DIR;
  const marker = path.join(DATA_DIR, `scorecard_sent_${live.today}.json`);
  try { fs.unlinkSync(marker); } catch (_) {}

  // Empty book: no card at all.
  const bookKeys = Array.from(live.calls.keys());
  const closedCopy = live.closedCalls.slice();
  live.calls.clear(); live.closedCalls.length = 0;
  const callsBefore = telegramCalls;
  await live.dispatchTelegramSessionSummary();
  assert.equal(telegramCalls, callsBefore, 'an empty book must not produce a scorecard');
  assert.equal(fs.existsSync(marker), false, 'nothing recorded, nothing marked');
  live.calls.clear();
  for (const id of bookKeys) live.calls.set(id, live.calls.get(id) || { id });
  // Restore the engine's own book from disk (it re-loads what the sandbox holds).
  live.calls.clear();
  live.closedCalls.length = 0;
  live.loadExistingCalls();

  // A real record: exactly one card, then the marker refuses any second one.
  live.calls.set('TEST-1', {
    id: 'TEST-1', engine: 'OF_MOMENTUM', date: live.today, symbol: 'TEST', action: 'BUY',
    limitEntry: 100, stopLoss: 99, target: 101, riskBps: 100, targetBps: 150, riskReward: '1 : 1.50',
    shares: 1, status: 'ARMED', exitPrice: null, netInr1Lot: 0, ltp: 100,
  });
  live.sessionClosed = false;
  await live.closeSession(); // settles the ARMED record and (only now) sends the summary
  assert.equal(telegramCalls, callsBefore + 1, 'a session with calls ships exactly one card');
  assert.equal(fs.existsSync(marker), true, 'the send is marked on disk');
  live.sessionClosed = false;
  await live.dispatchTelegramSessionSummary();
  assert.equal(telegramCalls, callsBefore + 1, 'a second dispatch on the same date is refused');
  live.sessionClosed = true;
  try { fs.unlinkSync(marker); } catch (_) {}
  live.calls.clear(); live.closedCalls.length = 0;
  live.loadExistingCalls();
  tel.sendPhoneNotification = realSender;
});
