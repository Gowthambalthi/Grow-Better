'use strict';

/**
 * THE CALLS ON THE PHONE: WHICH SIDE, WHICH SYSTEM, AND HOW FAST THEY ARRIVE.
 *
 * Three defects this pins, all of them silent until a human reads the phone:
 *
 *   1. The new-call card was hard-coded "NEW INSTITUTIONAL BUY CALL". GB03a's measured
 *      positive side is its SHORT — a short announced as a buy is the one wording error a
 *      reader cannot undo after acting on it. The message is now built from the call's own
 *      side and carries its GB code.
 *   2. Every message went out the moment it was armed, so several calls in one scan arrived
 *      as one burst. The owner asked for a 3-second gap; the gap lives in the sender
 *      (common/notifications/sendPacer.js) so it applies to every caller.
 *   3. GB03a armed both sides while being advertised as positive. Its long side is negative
 *      before and after the pin moved (705-session corpus: shorts +19.27R/13, longs
 *      −3.29R/12), so the live boundary now arms the measured side and COUNTS the refusal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Sandboxed before the engine loads, so requiring it cannot touch the real journal.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-telegram-test-'));
process.env.GB_ORDERFLOW_DIR = sandbox;
process.env.GB_GATE_TELEMETRY = '0';

const { createPacer } = require('../common/notifications/sendPacer');
const telegramService = require('../common/notifications/telegramService');
const live = require('../strategies/orderflow/liveMinuteEngine');

test.after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {} });

// ---------------------------------------------------------------------------
// 1. THE PACER — one queue, a gap measured from the END of the previous send
// ---------------------------------------------------------------------------

test('three messages leave the phone 3 seconds apart, in order', async () => {
  let clock = 0;
  const starts = [];
  const pacer = createPacer({
    gapMs: 3000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });
  await Promise.all([0, 1, 2].map((i) => pacer.run(async () => {
    starts.push(clock);
    clock += 200;                 // a send that takes 200ms
    return i;
  })));
  assert.deepEqual(starts, [0, 3200, 6400],
    'each message must start at least 3000ms after the previous one FINISHED');
});

test('the gap is measured from the end of a slow send, not from its start', async () => {
  let clock = 0;
  const starts = [];
  const pacer = createPacer({ gapMs: 3000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await Promise.all([
    pacer.run(async () => { starts.push(clock); clock += 5000; }),   // slow: Telegram took 5s
    pacer.run(async () => { starts.push(clock); }),
  ]);
  assert.deepEqual(starts, [0, 8000], 'the next send waits 3s after the slow one completed');
});

test('a failed send releases the queue instead of wedging every later alert', async () => {
  let clock = 0;
  const pacer = createPacer({ gapMs: 3000, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await assert.rejects(pacer.run(async () => { throw new Error('telegram said no'); }), /telegram said no/);
  const after = await pacer.run(async () => 'second message still goes');
  assert.equal(after, 'second message still goes');
});

test('gapMs 0 disables pacing, and the shipped default is 3000', () => {
  const saved = process.env.TELEGRAM_GAP_MS;
  delete process.env.TELEGRAM_GAP_MS;
  assert.equal(telegramService.telegramGapMs(), 3000, 'unset must mean 3 seconds');
  process.env.TELEGRAM_GAP_MS = '0';
  assert.equal(telegramService.telegramGapMs(), 0, '0 is the documented off switch');
  process.env.TELEGRAM_GAP_MS = 'nonsense';
  assert.equal(telegramService.telegramGapMs(), 3000, 'a typo must not silently disable pacing');
  if (saved === undefined) delete process.env.TELEGRAM_GAP_MS; else process.env.TELEGRAM_GAP_MS = saved;
});

test('the SENDER enforces the gap end to end: two calls in one scan leave 3s apart', async () => {
  // The real sender, with only the transport stubbed: this proves the wiring, not just
  // the pacer's arithmetic. axios is patched on the module object telegramService holds.
  const axios = require('axios');
  const savedPost = axios.post;
  const savedGap = process.env.TELEGRAM_GAP_MS;
  const at = [];
  // Credentials are passed explicitly, so the test cannot depend on — or page — the
  // real chat, and no auto-detect call is made against a live token.
  const creds = { botToken: 'test-token', chatId: 'test-chat' };
  // THE ONE OVERRIDE IN THE SUITE, and it is earned here: the transport below IS stubbed AND the
  // credentials are the dummy pair above, so there is no path from this test to the owner's chat.
  // (Unset elsewhere on purpose — test/depthOrientation.test.js used to reach the real channel
  // through this same sender, which is how the suite posted scorecards on 2026-10-19.)
  const savedAllow = process.env.GB_TELEGRAM_ALLOW_FROM_TESTS;
  try {
    process.env.GB_TELEGRAM_ALLOW_FROM_TESTS = '1';
    process.env.TELEGRAM_GAP_MS = '300';            // 3s would make the suite crawl; same rule
    axios.post = async () => { at.push(Date.now()); return { data: { ok: true } }; };
    const [a, b] = await Promise.all([
      telegramService.sendPhoneNotification('call one', creds),
      telegramService.sendPhoneNotification('call two', creds),
    ]);
    assert.equal(a.success, true);
    assert.equal(b.success, true);
    assert.equal(at.length, 2, 'both calls reach the transport — the queue must not drop one');
    assert.ok(at[1] - at[0] >= 290, 'the second message left ' + (at[1] - at[0]) + 'ms after the first');
  } finally {
    axios.post = savedPost;
    if (savedAllow === undefined) delete process.env.GB_TELEGRAM_ALLOW_FROM_TESTS;
    else process.env.GB_TELEGRAM_ALLOW_FROM_TESTS = savedAllow;
    if (savedGap === undefined) delete process.env.TELEGRAM_GAP_MS; else process.env.TELEGRAM_GAP_MS = savedGap;
  }
});

// ---------------------------------------------------------------------------
// 2. THE MESSAGE — the call's own side, and its own GB code
// ---------------------------------------------------------------------------

test('a GB03a SHORT is announced as a SHORT, never as a BUY', () => {
  const msg = live.newCallTelegramText({
    symbol: 'ACMESOLAR', action: 'SELL', side: 'SHORT', strategyId: 'ORDERFLOW',
    setup: 'OF03', engine: 'ORDERFLOW', strategyType: 'INTRADAY',
    strategyName: 'GB03a — OF03 Exhaustion Reversal',
    limitEntry: 439.65, stopLoss: 440.31, target: 437.99,
    riskReward: '1 : 2.51', timeIST: '09:48:00', riskBps: 15, targetBps: 39,
    note: 'GB03a OF03 exhaustion reversal',
  });
  assert.match(msg, /NEW SHORT CALL · GB03a · ACMESOLAR/);
  assert.match(msg, /SELL \/ SHORT/);
  assert.match(msg, /Stop above/);
  assert.ok(!/NEW LONG CALL/.test(msg), 'a short must never be headed LONG');
  assert.ok(!/\bBUY\b/.test(msg.replace(/BUY \/ LONG/g, '')), 'a short must not contain a BUY label');
  assert.match(msg, /09:48:00 IST/);
});

test('a GB01 LONG is announced as a LONG with its GB code', () => {
  const msg = live.newCallTelegramText({
    symbol: 'ANTELOPUS', action: 'BUY', side: 'LONG', strategyId: 'FG01', setup: 'FG01',
    engine: 'FVG', strategyType: 'INTRADAY', strategyName: 'GB01 — 5m FVG Retest',
    limitEntry: 1187.15, stopLoss: 1182.41, target: 1202.74, riskReward: '1 : 3.29', timeIST: '09:55:00',
    note: 'GB01 5m FVG retest',
  });
  assert.match(msg, /NEW LONG CALL · GB01 · ANTELOPUS/);
  assert.match(msg, /BUY \/ LONG/);
  assert.match(msg, /Stop below/);
});

test('the GB code comes from the call, not from the sender', () => {
  assert.equal(live.gbCodeOf({ strategyId: 'FG01' }), 'GB01');
  assert.equal(live.gbCodeOf({ setup: 'FG02' }), 'GB02');
  assert.equal(live.gbCodeOf({ strategyId: 'ORDERFLOW', setup: 'OF03' }), 'GB03a');
  assert.equal(live.gbCodeOf({ engine: 'SWEEP_FVG' }), 'SWEEP_FVG', 'an unknown engine keeps its own name');
});

// ---------------------------------------------------------------------------
// 3. THE SIDE POLICY — the measured side arms, the other is counted out loud
// ---------------------------------------------------------------------------

test('GB03a ships arming its measured SHORT side only', () => {
  assert.equal(live.gb03Sides, 'short', 'the shipped default must be the measured side');
  assert.equal(live.gb03SideAllowed('SHORT'), true);
  assert.equal(live.gb03SideAllowed('LONG'), false,
    'the long side is −3.29R over 705 sessions and −0.750R/trade in the authorized window');
});

/**
 * 2026-10-15 11:00 IST — inside the OF03 window (the 12:30 pin) and inside no blocked
 * window, so a signal from the engine is decided by the side policy and nothing else.
 */
const REPLAY_MS = Date.parse('2026-10-15T11:00:00+05:30');

/** `n` clocked 1-minute bars — the OF03 branch refuses a bar without a timestamp by name. */
function clockedBars(n, from, step) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = +(from + step * i).toFixed(2);
    out.push({
      t: REPLAY_MS - (n - i) * 60000,
      o: +(c - step / 2).toFixed(2), h: +(c + 0.5).toFixed(2),
      l: +(c - 0.5).toFixed(2), c, v: 5000, delta: 0,
    });
  }
  return out;
}

test('a GB03a LONG is refused at the live boundary and the refusal is counted', () => {
  const sig = {
    ok: true, side: 'LONG', entry: 1000, reason: 'test exhaustion long',
    setupData: { volumeRatio: 2.1 }, plan: { stop: 990, t1: 1025, rr1: 2.5 },
  };
  const savedEngines = live.ofEngines;
  const savedAlert = live.dispatchTelegramNewCall;
  const savedBars = live.symBars;
  const savedTime = live.replayTimeMs;
  const savedCalls = live.calls;
  try {
    live.dispatchTelegramNewCall = () => Promise.resolve();   // never alert from a test
    live.calls = new Map();
    live.symBars = new Map([['TESTGB03L', clockedBars(40, 1000, 0.1)]]);
    live.ofEngines = new Map([['TESTGB03L', { onBar: () => sig }]]);
    live.replayTimeMs = REPLAY_MS;
    live.scanFunnel = null;
    live.scanMinuteTape();

    const f = live.getScanFunnel();
    assert.equal(f.gb03.sideRefused, 1,
      'the long side must be counted where it is refused: ' + JSON.stringify(f.gb03));
    assert.equal(f.gb03.armed, 0, 'and nothing may be armed from it');
    assert.equal(f.qualified, 0, 'so the refused long cannot reach the board');
  } finally {
    live.ofEngines = savedEngines;
    live.dispatchTelegramNewCall = savedAlert;
    live.symBars = savedBars;
    live.replayTimeMs = savedTime;
    live.calls = savedCalls;
  }
});

test('a GB03a SHORT from the same engine is armed with its own note', () => {
  const sig = {
    ok: true, side: 'SHORT', entry: 1000, reason: 'test exhaustion short',
    setupData: { volumeRatio: 2.1 }, plan: { stop: 1010, t1: 975, rr1: 2.5 },
  };
  const savedEngines = live.ofEngines;
  const savedAlert = live.dispatchTelegramNewCall;
  const savedBars = live.symBars;
  const savedTime = live.replayTimeMs;
  const savedCalls = live.calls;
  try {
    live.dispatchTelegramNewCall = () => Promise.resolve();
    live.calls = new Map();
    live.symBars = new Map([['TESTGB03S', clockedBars(40, 1000, 0.1)]]);
    live.ofEngines = new Map([['TESTGB03S', { onBar: () => sig }]]);
    live.replayTimeMs = REPLAY_MS;
    live.scanFunnel = null;
    live.scanMinuteTape();

    const f = live.getScanFunnel();
    assert.equal(f.gb03.sideRefused || 0, 0, 'a short is not a refused side');
    const call = Array.from(live.calls.values()).find((c) => c.symbol === 'TESTGB03S');
    assert.ok(call, 'the short must arm: ' + JSON.stringify(f.gb03));
    assert.equal(call.strategyId, 'ORDERFLOW');
    assert.equal(call.strategyName, 'GB03a — OF03 Exhaustion Reversal');
    assert.match(call.note, /GB03a measured: SHORT 13 trades, \+19\.27R/,
      'the row must carry the measured side, not the setup-wide number');
    assert.match(call.note, /−0\.423R\/trade/, 'and the authorized-window caveat');
  } finally {
    live.ofEngines = savedEngines;
    live.dispatchTelegramNewCall = savedAlert;
    live.symBars = savedBars;
    live.replayTimeMs = savedTime;
    live.calls = savedCalls;
  }
});

// ---------------------------------------------------------------------------
// 4. STRATEGY NAME & EXIT TELEGRAM ALERTS
// ---------------------------------------------------------------------------

test('exit Telegram alert carries Strategy Name and clean Net P&L (Target Won)', () => {
  const call = {
    symbol: 'BELRISE',
    action: 'BUY',
    engine: 'OF_MOMENTUM',
    strategyId: 'OF_MOMENTUM',
    limitEntry: 232.16,
    exitPrice: 234.01,
    grossPoints1Lot: 1.85,
    livePnLPct: 0.8,
    netInr1Lot: 322.88,
    exitTimeIST: '10:52:44',
    exitReason: 'TARGET_HIT',
    status: 'WON',
  };
  const msg = live.exitTelegramText(call);
  assert.match(msg, /🎯 <b>TARGET 1 REACHED \(WON\)<\/b>/);
  assert.match(msg, /Strategy: <b>OF_MOMENTUM — Order Flow Institutional Momentum<\/b>/);
  assert.match(msg, /Symbol: <b>#BELRISE<\/b>/);
  assert.match(msg, /Net P&L \(net of 15 bps costs\): <b>\+₹322\.88<\/b>/);
  assert.ok(!/\+322\.88₹322\.88/.test(msg), 'net P&L must not repeat number before currency sign');
});

test('exit Telegram alert carries Strategy Name and clean Net P&L (Stop Lost)', () => {
  const call = {
    symbol: 'QUADFUTURE',
    action: 'BUY',
    engine: 'OF_MOMENTUM',
    strategyId: 'OF_MOMENTUM',
    limitEntry: 458.00,
    exitPrice: 455.20,
    grossPoints1Lot: -2.80,
    livePnLPct: -0.61,
    netInr1Lot: -380.08,
    exitTimeIST: '10:56:35',
    exitReason: 'STOP_LOSS_HIT',
    status: 'LOST',
  };
  const msg = live.exitTelegramText(call);
  assert.match(msg, /🛑 <b>STOP LOSS HIT \(LOST\)<\/b>/);
  assert.match(msg, /Strategy: <b>OF_MOMENTUM — Order Flow Institutional Momentum<\/b>/);
  assert.match(msg, /Symbol: <b>#QUADFUTURE<\/b>/);
  assert.match(msg, /Net P&L \(net of 15 bps costs\): <b>-₹380\.08<\/b>/);
  assert.ok(!/-380\.08₹-380\.08/.test(msg), 'negative net P&L must not repeat number');
});

test('exit Telegram alert formats GB01 and GB03a strategy names accurately', () => {
  const gb01Call = {
    symbol: 'TATASTEEL', action: 'BUY', strategyId: 'FG01', setup: 'FG01', engine: 'FVG',
    strategyName: 'GB01 — 5m FVG Retest', limitEntry: 150.00, exitPrice: 153.00,
    grossPoints1Lot: 3.00, livePnLPct: 2.0, netInr1Lot: 285.50, exitTimeIST: '11:15:00',
    exitReason: 'TARGET_HIT', status: 'WON',
  };
  const gb01Msg = live.exitTelegramText(gb01Call);
  assert.match(gb01Msg, /Strategy: <b>GB01 — 5m FVG Retest<\/b>/);

  const gb03Call = {
    symbol: 'RELIANCE', action: 'SELL', side: 'SHORT', strategyId: 'ORDERFLOW', setup: 'OF03', engine: 'ORDERFLOW',
    strategyName: 'GB03a — OF03 Exhaustion Reversal', limitEntry: 2900.00, exitPrice: 2870.00,
    grossPoints1Lot: 30.00, livePnLPct: 1.03, netInr1Lot: 450.00, exitTimeIST: '12:05:00',
    exitReason: 'TARGET_HIT', status: 'WON',
  };
  const gb03Msg = live.exitTelegramText(gb03Call);
  assert.match(gb03Msg, /Strategy: <b>GB03a — OF03 Exhaustion Reversal<\/b>/);
});
