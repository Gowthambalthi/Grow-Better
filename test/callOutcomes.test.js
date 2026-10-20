'use strict';

/**
 * test/callOutcomes.test.js
 *
 * WHAT THE TAPE SAYS, VERSUS WHAT THE PAGE USED TO SAY. The calls page marked a call WON the moment
 * the last price was past its target, whether or not its limit had ever been reached - a call nobody
 * could have taken, credited with money nobody could have made. This module replays the engine's OWN
 * rules (fill on a strictly traded-through price, book the fill at the resting limit, refuse a setup
 * that ran 60% of the way to target first, exit at the level) and prices the result with the engine's
 * own toll, so the table and the 15:30 scorecard cannot disagree.
 *
 * Every test below builds a synthetic day in a temp directory and drives the real code path end to
 * end - the module's data directory is redirected with setDataDir, so nothing here can read or write
 * the live record.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const co = require('../strategies/orderflow/callOutcomes');
const { calcItemizedToll } = co;

const DAY = '2026-10-12';
const OPEN_MS = Date.UTC(2026, 9, 12, 3, 45, 0);      // 09:15 IST
const at = (h, m, s = 0) => OPEN_MS + ((h * 60 + m - 555) * 60 + s) * 1000;   // IST clock -> ms

/**
 * Files are written as JSONL by default (the tape and journal are JSONL), as one JSON document when
 * wrapped as { json: [...] } (the day's calls file is JSON), and an empty array writes the valid empty
 * document - which is NOT the same as an empty JSONL file, and is how this test learned the difference.
 */
function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-outcomes-'));
  for (const [name, value] of Object.entries(files)) {
    let text;
    if (value && !Array.isArray(value) && Array.isArray(value.json)) text = JSON.stringify(value.json, null, 2);
    else if (Array.isArray(value) && value.length === 0) text = '[]';
    else if (Array.isArray(value)) text = value.map((r) => JSON.stringify(r)).join('\n') + '\n';
    else text = JSON.stringify(value, null, 2);
    fs.writeFileSync(path.join(dir, name), text, 'utf8');
  }
  co.setDataDir(dir);
  return dir;
}

const tick = (sym, t, p) => ({ t, s: sym, p });

/** A LONG call at 100.00 with a 99.00 stop and a 102.00 target, armed at 10:00. */
const call = (over = {}) => Object.assign({
  id: 'CALL-X-2026-10-12-001', symbol: 'TESTSYM', side: 'LONG', action: 'BUY',
  limitEntry: 100, stopLoss: 99, target: 102, timestamp: at(10, 0), timeIST: '10:00:00', shares: 1
}, over);

test('a limit that is never traded through is NOT a trade, and is worth nothing', () => {
  // Prints stay ABOVE the limit (a LONG fills at <= 99.95) and below the anti-chase band (101.20 for
  // entry 100 / target 102) - so nothing fills and nothing is refused. Close is not filled.
  const rows = [tick('TESTSYM', at(10, 1), 100.6), tick('TESTSYM', at(10, 5), 101.0), tick('TESTSYM', at(10, 30), 100.2)];
  const r = co.evaluateCall(call(), rows);
  assert.equal(r.state, 'NOT_FILLED');
  assert.equal(r.filled, false);
  assert.equal(r.netInr, 0, 'a call that never filled earned Rs 0, however close it came');
  assert.equal(r.grossPt, null);
});

test('a call that runs 101.90 before its limit is refused, not marked as a miss (live engine parity)', () => {
  const rows = [tick('TESTSYM', at(10, 1), 100.6), tick('TESTSYM', at(10, 5), 101.9)];
  assert.equal(co.evaluateCall(call(), rows).state, 'CANCELLED_EXHAUSTION');
});

test('one tick through the limit fills, and the target pays the target', () => {
  const rows = [tick('TESTSYM', at(10, 1), 99.90), tick('TESTSYM', at(10, 2), 100.4), tick('TESTSYM', at(10, 20), 102)];
  const r = co.evaluateCall(call(), rows);
  assert.equal(r.state, 'WON');
  assert.equal(r.filled, true);
  assert.equal(r.fillPx, 100, 'the fill is booked AT the resting limit, never at a better print');
  assert.equal(r.exitPx, 102);
  const gross = 2;
  const toll = calcItemizedToll('target');
  assert.equal(r.grossPt, gross);
  assert.equal(r.netInr, +(gross - 100 * (toll / 1e4)).toFixed(2));
  assert.equal(r.netBps, +((gross / 100) * 1e4 - toll).toFixed(1));
});

test('the stop comes first when it comes first, and the loss is booked at the stop', () => {
  const rows = [tick('TESTSYM', at(10, 1), 99.90), tick('TESTSYM', at(10, 2), 99.0), tick('TESTSYM', at(10, 9), 102)];
  const r = co.evaluateCall(call(), rows);
  assert.equal(r.state, 'LOST');
  assert.equal(r.exitPx, 99);
  assert.equal(r.grossPt, -1);
  assert.ok(r.netInr < -1, 'costs make a one-point loss a shade worse than one point');
});

test('a setup that runs 60% to target before the limit is refused, exactly as the live engine refuses it', () => {
  // LONG, entry 100, target 102: 60% of the way is 101.20. A print at 101.25 arrives before the limit.
  const rows = [tick('TESTSYM', at(10, 1), 101.25), tick('TESTSYM', at(10, 2), 99.90), tick('TESTSYM', at(10, 3), 102)];
  const r = co.evaluateCall(call(), rows);
  assert.equal(r.state, 'CANCELLED_EXHAUSTION');
  assert.equal(r.filled, false);
  assert.equal(r.netInr, 0);
  assert.match(r.note, /anti-chase/);
});

test('a collapse through the limit still fills it - the stop is booked, not the paper loss it flew past', () => {
  // 98.00 is far below the 99.00 stop, but a LONG limit at 100.00 fills on the way down (98.00 trades
  // through it) and the engine books the exit AT the stop, not at the price it fell to. Booking the
  // collapse instead would invent a loss several times the risk the call ever took on.
  const rows = [tick('TESTSYM', at(10, 1), 100.5), tick('TESTSYM', at(10, 2), 98.0)];
  const r = co.evaluateCall(call(), rows);
  assert.equal(r.filled, true);
  assert.equal(r.state, 'LOST');
  assert.equal(r.fillPx, 100);
  assert.equal(r.exitPx, 99, 'the exit is the stop level, as the engine books it');
});

test('after 15:30 a filled position is squared off, not left OPEN for the night', () => {
  // Intraday: the day's record must not carry a paper number overnight. Same tape, two clocks.
  const rows = [tick('TESTSYM', at(10, 1), 99.5), tick('TESTSYM', at(14, 0), 100.4)];
  const during = co.evaluateCall(call(), rows, { nowMs: at(14, 5) });
  assert.equal(during.state, 'OPEN', 'while the market is open it is genuinely open');
  assert.equal(during.exitReason, 'session_close');
  const after = co.evaluateCall(call(), rows, { nowMs: at(15, 45) });
  assert.equal(after.state, 'SESSION_CLOSE');
  assert.equal(after.exitPx, 100.4, 'squared off at the last print');
  assert.match(after.note, /squared off at the 15:30 close/);
  assert.ok(after.netInr > 0 && after.netInr < 0.4, 'gross 0.40 minus the exit toll');
});

test('a SHORT fills on a print through its limit and wins on the way down', () => {
  const rows = [tick('TESTSYM', at(11, 0), 100.2), tick('TESTSYM', at(11, 1), 98)];
  const r = co.evaluateCall(call({ side: 'SHORT', action: 'SELL', limitEntry: 100, stopLoss: 101, target: 98 }),
    rows);
  assert.equal(r.state, 'WON');
  assert.equal(r.fillPx, 100);
  assert.equal(r.exitPx, 98);
  assert.equal(r.grossPt, 2);
});

test('the day reconciles: journal-only calls reappear, artifacts are excluded, and the money is split by who decided', () => {
  const dir = sandbox({
    [`daily_calls_${DAY}.json`]: { json: [call({ id: 'IN-FILE-1', symbol: 'AAA' })] },
    [`ticks-${DAY}.jsonl`]: [
      tick('AAA', at(10, 1), 99.9), tick('AAA', at(10, 30), 102),          // in-file call: WON
      tick('BBB', at(10, 1), 49.9), tick('BBB', at(10, 30), 52),            // journal-only call: WON
      tick('CCC', at(10, 1), 19.9), tick('CCC', at(10, 30), 18.9)           // artifact: priced at zero
    ],
    [`sweep-fvg-signals-${DAY}.jsonl`]: [
      { type: 'SETUP_ARMED', side: 'LONG', symbol: 'BBB', barIndex: 3, limitEntry: 50, stopLoss: 49.5, target: 52, riskBps: 100, timestamp: at(10, 0) },
      { type: 'SETUP_ARMED', side: 'LONG', symbol: 'CCC', barIndex: 4, limitEntry: 20, stopLoss: 19.5, target: 22, riskBps: 250, timestamp: at(10, 0) }
    ]
  });
  // The evidence file the repair script writes when a replay clobbers a day: CCC's setup is in it.
  const evidenceDir = path.join(__dirname, '..', 'scratch', `evidence_${DAY}`);
  const evidenceFile = path.join(evidenceDir, `daily_calls_${DAY}.json.as-overwritten-by-replay`);
  const hadEvidence = fs.existsSync(evidenceFile);
  let original = null;
  if (hadEvidence) original = fs.readFileSync(evidenceFile);
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify([{ symbol: 'CCC', side: 'LONG', limitEntry: 20, stopLoss: 19.5 }]), 'utf8');

  try {
    const day = co.evaluateDay(DAY);
    assert.equal(day.calls.length, 3, 'the in-file call, the journal-recovered call and the artifact');
    assert.equal(day.recoveredFromJournal, 1, 'the call the file lost is recovered from the journal');
    assert.equal(day.replayArtifacts, 1);
    const ccc = day.results.find((r) => r.symbol === 'CCC');
    assert.equal(ccc.artifact, true);
    assert.equal(ccc.netInr, 0, 'a replay artifact is priced at zero - nobody could take it');
    assert.equal(day.summary.artifacts, 1);
    assert.equal(day.summary.calls, 2, 'the counts price only the tradeable calls');

    // The ledger: mark one taken, one skipped, and watch the totals move to the decisions.
    co.writeLedger(DAY, 'IN-FILE-1', 'TAKEN');
    co.writeLedger(DAY, 'JRN-BBB-' + Math.round(at(10, 0) / 1000), 'SKIPPED');
    const after = co.evaluateDay(DAY);
    assert.equal(after.summary.myCalls, 1);
    assert.equal(after.summary.missedCalls, 1);
    assert.equal(after.summary.undecidedCalls, 0);
    assert.equal(after.myNet, after.results.find((r) => r.id === 'IN-FILE-1').netInr);
    assert.equal(after.skippedNet, after.results.find((r) => r.symbol === 'BBB').netInr);
    assert.ok(after.summary.engineNet > 0, 'both tradeable calls won, so the engine net is positive');
  } finally {
    if (hadEvidence) fs.writeFileSync(evidenceFile, original);
    else fs.rmSync(evidenceFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symbol with a regex metacharacter is still read off the tape (M&M, A+B)', () => {
  // The tape filter is a single regex over 1.5M lines, so the symbols go into it - and an unescaped
  // one either fails to match or matches something else. Real NSE names do contain '&' and '-', and
  // a matcher that quietly stops finding a call is the worst possible failure here: it reads as
  // "never filled" and the money looks safe.
  const dir = sandbox({
    [`daily_calls_${DAY}.json`]: { json: [call({ id: 'MM-1', symbol: 'M&M' }), call({ id: 'AB-2', symbol: 'A+B', limitEntry: 50, stopLoss: 49, target: 52 })] },
    [`ticks-${DAY}.jsonl`]: [
      tick('M&M', at(10, 1), 99.9), tick('M&M', at(10, 30), 102),
      tick('A+B', at(10, 1), 49.9), tick('A+B', at(10, 30), 52)
    ]
  });
  try {
    const day = co.evaluateDay(DAY, { nowMs: at(11, 0) });
    assert.equal(day.results.length, 2);
    const mm = day.results.find((r) => r.symbol === 'M&M');
    const ab = day.results.find((r) => r.symbol === 'A+B');
    assert.equal(mm.state, 'WON', 'M&M must be found on the tape');
    assert.equal(ab.state, 'WON', 'A+B must be found on the tape');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tape is read incrementally, and an appended line changes the verdict', () => {
  // The live tape grows every second while the page polls every five, so the read continues from the
  // last offset. What that must never do is miss the appended ticks - so this test appends a real
  // target touch and requires the verdict to move from OPEN to WON.
  const dir = sandbox({
    [`daily_calls_${DAY}.json`]: { json: [call()] },
    [`ticks-${DAY}.jsonl`]: [tick('TESTSYM', at(10, 1), 99.9), tick('TESTSYM', at(10, 30), 100.4)]
  });
  const file = path.join(dir, `ticks-${DAY}.jsonl`);
  try {
    const first = co.evaluateDay(DAY, { nowMs: at(11, 0) });
    assert.equal(first.results[0].state, 'OPEN', 'filled, no exit yet');
    assert.equal(first.tapeThroughIST, '10:30:00');

    // Append as the writer does: one more line, no newline-terminated rewrite of the file.
    fs.appendFileSync(file, JSON.stringify(tick('TESTSYM', at(10, 45), 102)) + '\n', 'utf8');
    const second = co.evaluateDay(DAY, { nowMs: at(11, 0) });
    assert.equal(second.results[0].state, 'WON', 'the appended tick must be seen');
    assert.equal(second.results[0].exitPx, 102);
    assert.equal(second.tapeThroughIST, '10:45:00');

    // A partial final line (a writer mid-flush) must not be parsed as a tick, and must not be lost.
    fs.appendFileSync(file, '{"t":' + at(10, 50) + ',"s":"TESTSYM","p":10', 'utf8');
    const third = co.evaluateDay(DAY, { nowMs: at(11, 0) });
    assert.equal(third.results[0].state, 'WON', 'an unfinished line changes nothing yet');
    fs.appendFileSync(file, '1.5}\n', 'utf8');
    const fourth = co.evaluateDay(DAY, { nowMs: at(11, 0) });
    assert.equal(fourth.tapeThroughIST, '10:50:00', 'the completed line is read on the next pass');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger refuses nonsense rather than storing it', () => {
  const dir = sandbox({ [`daily_calls_${DAY}.json`]: { json: [] } });
  try {
    assert.throws(() => co.writeLedger(DAY, '', 'TAKEN'), /call id/);
    assert.throws(() => co.writeLedger(DAY, 'X', 'MAYBE'), /TAKEN, SKIPPED or null/);
    co.writeLedger(DAY, 'X', 'TAKEN');
    assert.equal(co.readLedger(DAY).decisions.X.state, 'TAKEN');
    co.writeLedger(DAY, 'X', null);
    assert.equal(co.readLedger(DAY).decisions.X, undefined, 'null clears the decision');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => co.setDataDir(path.join(__dirname, '..', 'data', 'orderflow')));
