'use strict';

/**
 * THE MEASURED TIME-OF-DAY GATES (2026-10-16).
 *
 * The recorded corpus was bucketed into 30-minute entry windows — every engine,
 * both one-per-day modes, cost 0.05% charged in R on both legs — then split
 * odd/even sessions for stability (scratch/time_buckets_deep.js +
 * time_buckets_report.js; report in scratch/time_buckets_2026-10-16.md). A
 * window earns a block only when it is net-negative in BOTH modes AND negative
 * in BOTH halves. Exactly two did: 12:15-12:45 and 13:15-13:45.
 *
 * What these tests pin:
 *   1. The DEFAULT list is exactly those two windows, half-open [from, to).
 *   2. inEntryWindow refuses them — and keeps the CONTESTED windows (12:45-13:15,
 *      13:45-14:15, 11:15-11:45) whose split halves flip sign. A gate that
 *      grows past its evidence is the failure mode this study exists to avoid.
 *   3. GB_ENTRY_BLOCKED overrides the list; "" disables blocking (the bucket
 *      study must be able to SEE the minutes it is deciding about).
 *   4. The live scanner refuses to arm inside a block and monitoring of what is
 *      already open survives the gate (same contract as armEndMinute).
 *   5. runAll reports the block and counts it under its OWN counter
 *      (BLOCKED_TIME_WINDOW), never as OUTSIDE_ENTRY_WINDOW — two different
 *      claims must not share one number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Sandbox BEFORE the engine is required — without it a scan in a test would
// rewrite today's real daily_calls file (same discipline as depthOrientation).
process.env.GB_ORDERFLOW_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'time-gates-'));
// The default list is what this file pins, so an ambient override in the shell
// must not silently change what is being tested (depthOrientation does the same
// for GB_ASK_WALL_RATIO). The override itself is exercised explicitly below.
delete process.env.GB_ENTRY_BLOCKED;

const followPath = require.resolve('../backtest/follow');
const fill = require('../backtest/follow');
const engine = require('../strategies/orderflow/liveMinuteEngine');

// ---------------------------------------------------------------------------
// 1-2. THE LIST AND ITS SEMANTICS
// ---------------------------------------------------------------------------

test('the default blocked windows are exactly the two measured losers', () => {
  assert.deepEqual(fill.BLOCKED_WINDOWS, [[12 * 60 + 15, 12 * 60 + 45], [13 * 60 + 15, 13 * 60 + 45]],
    '12:15-12:45 and 13:15-13:45 — net-negative in both one-per-day modes and both split halves');
  assert.equal(fill.BLOCKED_WINDOWS_LABEL, '12:15–12:45 · 13:15–13:45');
  // The live engine reads the SAME list, not a copy.
  assert.deepEqual(engine.blockedWindows, fill.BLOCKED_WINDOWS,
    'the live scanner must read backtest/follow.js, not its own second copy');
});

test('minuteInBlockedWindow is half-open [from, to): the boundary minute flips', () => {
  assert.equal(fill.minuteInBlockedWindow(12 * 60 + 14), false, '12:14 — last open minute');
  assert.equal(fill.minuteInBlockedWindow(12 * 60 + 15), true, '12:15 — first blocked minute');
  assert.equal(fill.minuteInBlockedWindow(12 * 60 + 44), true, '12:44 — last blocked minute');
  assert.equal(fill.minuteInBlockedWindow(12 * 60 + 45), false, '12:45 — half-open: the edge is open');
  assert.equal(fill.minuteInBlockedWindow(13 * 60 + 14), false, '13:14 — inside the KEP window between the blocks');
  assert.equal(fill.minuteInBlockedWindow(13 * 60 + 15), true, '13:15 — second block starts');
  assert.equal(fill.minuteInBlockedWindow(13 * 60 + 44), true, '13:44');
  assert.equal(fill.minuteInBlockedWindow(13 * 60 + 45), false, '13:45 — second block ends');
  assert.equal(fill.minuteInBlockedWindow(null), false, 'an unparseable minute is not blocked');
});

test('inBlockedWindow reads a decision-bar stamp, and only that', () => {
  assert.equal(fill.inBlockedWindow('2026-10-15 12:30'), true);
  assert.equal(fill.inBlockedWindow('2026-10-15 13:20'), true);
  assert.equal(fill.inBlockedWindow('2026-10-15 12:50'), false, 'the contested 12:45-13:15 gap stays open');
  assert.equal(fill.inBlockedWindow('2026-10-15 13:50'), false, 'the contested 13:45+ window stays open');
  assert.equal(fill.inBlockedWindow('2026-10-15 09:30'), false);
  assert.equal(fill.inBlockedWindow('nonsense'), false, 'a formatting error must never become a block');
});

test('inEntryWindow refuses blocked minutes and keeps every contested window', () => {
  // BLOCKED (the measured rule).
  assert.equal(fill.inEntryWindow('2026-10-15 12:30'), false, '12:15-12:45 is net-negative in both modes and halves');
  assert.equal(fill.inEntryWindow('2026-10-15 13:20'), false, '13:15-13:45 likewise');
  // KEPT — the study explicitly did NOT earn these blocks (halves flip sign).
  assert.equal(fill.inEntryWindow('2026-10-15 11:30'), true, '11:15-11:45 contested: split halves disagree');
  assert.equal(fill.inEntryWindow('2026-10-15 12:50'), true, '12:45-13:15 contested: shorts positive, half A positive');
  assert.equal(fill.inEntryWindow('2026-10-15 13:50'), true, '13:45-14:15 contested: near-zero, halves disagree');
  // THE SURROUNDING WINDOW STILL DECIDES.
  assert.equal(fill.inEntryWindow('2026-10-15 09:19'), false, 'before 09:20');
  assert.equal(fill.inEntryWindow('2026-10-15 10:00'), true);
  assert.equal(fill.inEntryWindow('2026-10-15 15:01'), false, 'after 15:00');
});

// ---------------------------------------------------------------------------
// 3. THE OVERRIDE
// ---------------------------------------------------------------------------

test('GB_ENTRY_BLOCKED replaces the list; "" disables blocking entirely', () => {
  const cached = require.cache[followPath];
  delete require.cache[followPath];
  process.env.GB_ENTRY_BLOCKED = '';
  try {
    const off = require(followPath);
    assert.deepEqual(off.BLOCKED_WINDOWS, [], 'empty spec means no blocks');
    assert.equal(off.inEntryWindow('2026-10-15 12:30'), true,
      'the bucket study must be able to SEE every minute it is deciding about');

    process.env.GB_ENTRY_BLOCKED = '1300-1330';
    delete require.cache[followPath];
    const custom = require(followPath);
    assert.deepEqual(custom.BLOCKED_WINDOWS, [[13 * 60, 13 * 60 + 30]]);
    assert.equal(custom.inEntryWindow('2026-10-15 13:10'), false, 'the custom block applies');
    assert.equal(custom.inEntryWindow('2026-10-15 12:30'), true, 'the default list is REPLACED, not merged');
    assert.equal(custom.BLOCKED_WINDOWS_LABEL, '13:00–13:30');

    process.env.GB_ENTRY_BLOCKED = 'garbage,1360-1300';
    delete require.cache[followPath];
    assert.deepEqual(require(followPath).BLOCKED_WINDOWS, [],
      'a malformed spec must degrade to no blocks, never to a wrong block');
  } finally {
    delete process.env.GB_ENTRY_BLOCKED;
    delete require.cache[followPath];
    require.cache[followPath] = cached;   // restore the instance everything else holds
  }
  assert.equal(fill.inEntryWindow('2026-10-15 12:30'), false, 'the shared instance is untouched');
});

// ---------------------------------------------------------------------------
// 4. THE LIVE SCANNER
// ---------------------------------------------------------------------------

const MIN = 60000;
const T0 = 1791870000000;

function resetEngine() {
  engine.symBars.clear();
  engine.prevPrice.clear();
  engine.book.clear();
  engine.calls.clear();
  engine.closedCalls.length = 0;
  engine.sessionClosed = false;
  engine.blockedWindows = fill.BLOCKED_WINDOWS;   // the default returns between tests
  engine.askWallRatioMin = 0;                     // the wall gate defaults off; keep it off here
  engine.strictInvalidation = false;              // as depthOrientation does for synthetic bars
  delete engine.istMinute;                        // back to the prototype's real clock
  engine.dispatchTelegramNewCall = () => Promise.resolve();
}

/** The depthOrientation fixture: 20 bars grinding up on 2x volume — a qualifying LONG. */
function seedBars(sym, n = 20, base = 100) {
  const bars = [];
  for (let i = 0; i < n; i++) {
    const px = base * (1 + i * 0.0008);
    const vol = i >= n - 5 ? 4000 : 2000;
    const o = px * 0.9994;
    bars.push({
      t: T0 + i * MIN, o, h: px * 1.0001, l: px * 0.9994, c: px,
      v: vol, q: vol, delta: Math.round(vol * 0.20),
      buyVol: Math.round(vol * 0.5), sellVol: Math.round(vol * 0.4),
    });
  }
  engine.symBars.set(sym, bars);
}

function balanceBook(sym, px) {
  engine.book.set(sym, { bid: px, bidq: 500, ask: +(px * 1.0004).toFixed(2), askq: 520, t: Date.now() });
}

test('the live scanner refuses NEW arms inside a blocked window, and the block is the only cause', () => {
  // Control: the last minute before the first block still arms.
  resetEngine(); seedBars('TGSYM'); balanceBook('TGSYM', 101.5);
  engine.istMinute = () => 12 * 60 + 14;        // 12:14
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, '12:14 is inside the entry window and must arm');

  // The same fixture one minute later: refused.
  resetEngine(); seedBars('TGSYM'); balanceBook('TGSYM', 101.5);
  engine.istMinute = () => 12 * 60 + 15;        // 12:15 — first blocked minute
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 0, '12:15 is the first minute of the measured block');

  // THE CAUSE CHECK: identical fixture, the list disarmed on the instance.
  // (The EXP010 midday LONG block starts at 12:30, so at 12:15 nothing else in
  // the engine refuses — if this arms, the blocked-windows gate is what fired.)
  resetEngine(); engine.blockedWindows = [];
  seedBars('TGSYM'); balanceBook('TGSYM', 101.5);
  engine.istMinute = () => 12 * 60 + 15;
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1,
    'with blockedWindows=[] the very same minute arms — the gate, not a side effect, refused it');
});

test('the second block is live, and 13:45 arms again', () => {
  resetEngine(); seedBars('TGSYM2'); balanceBook('TGSYM2', 101.5);
  engine.istMinute = () => 13 * 60 + 15;        // 13:15
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 0, '13:15 is inside the second measured block');

  resetEngine(); seedBars('TGSYM2'); balanceBook('TGSYM2', 101.5);
  engine.istMinute = () => 13 * 60 + 45;        // 13:45 — after both my block and EXP010's
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1,
    '13:45 is past the second block (and past EXP010\'s 12:30-13:45 LONG block) and must arm');
});

test('monitoring of an open call survives the gate, exactly as after armEndMinute', () => {
  resetEngine(); seedBars('TGSYM3'); balanceBook('TGSYM3', 101.5);
  engine.istMinute = () => 12 * 60 + 14;        // arm just before the block
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1);

  engine.istMinute = () => 12 * 60 + 30;        // 12:30 — inside the block
  engine.scanMinuteTape();
  assert.equal(engine.calls.size, 1, 'the open call is untouched, only NEW arms stop');
  assert.equal(engine.calls.values().next().value.status, 'ARMED');
});

// ---------------------------------------------------------------------------
// 5. THE HARNESS AND THE BOARD READ THE SAME RULE
// ---------------------------------------------------------------------------

test('runAll prints the block and reports it beside the entry window', () => {
  const out = path.join(process.env.GB_ORDERFLOW_DIR, 'runall_timegates.json');
  const stdout = execFileSync(process.execPath, ['backtest/runAll.js', '--symbols=5', '--out=' + out], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
  });
  assert.match(stdout, /blocked: 12:15–12:45 · 13:15–13:45/,
    'the harness must STATE the block it applied: ' + stdout.slice(0, 1200));
  const results = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(results.entryWindow.blockedWindows, [[735, 765], [795, 825]]);
  assert.equal(results.entryWindow.blockedLabel, '12:15–12:45 · 13:15–13:45');
});

test('every entry path reads the one list in backtest/follow.js', () => {
  // sweepFvgLive: loads without a require cycle, and gates its arm window on
  // the SHARED list rather than a second copy of the minutes.
  const sweep = require('../strategies/fvg/sweepFvgLive');
  assert.equal(typeof sweep.createSweepFvgLive, 'function');
  const sweepSrc = fs.readFileSync(path.join(ROOT, 'strategies/fvg/sweepFvgLive.js'), 'utf8');
  assert.match(sweepSrc, /require\('\.\.\/\.\.\/backtest\/follow'\)/, 'sweepFvgLive must import the shared list');
  assert.match(sweepSrc, /!inBlockedMinute/, 'its arm window must be gated on the shared list');

  // The harness and the board refuse under their OWN counter name.
  const runAllSrc = fs.readFileSync(path.join(ROOT, 'backtest/runAll.js'), 'utf8');
  assert.match(runAllSrc, /BLOCKED_TIME_WINDOW/, 'runAll must count blocked minutes separately');
  const boardSrc = fs.readFileSync(path.join(ROOT, 'scripts/buildBoard.js'), 'utf8');
  assert.match(boardSrc, /BLOCKED_TIME_WINDOW/, 'the board must count blocked minutes separately');
  assert.match(boardSrc, /blockedWindows/, 'the board must PUBLISH the block with its entryWindow rule');
});
