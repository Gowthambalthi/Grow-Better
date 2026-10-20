'use strict';

/**
 * THE CALL HISTORY MUST NOT MANUFACTURE A TRACK RECORD.
 *
 * Two things are easy to get wrong here and both flatter the engine:
 *
 *  1. COUNTING CALLS THAT NEVER TRIGGERED. The books contain
 *     `CANCELLED_EXHAUSTION`, `EXPIRED` and `INVALIDATED` — setups the engine withdrew
 *     before any position existed. On 2026-10-07 that is 34 of the 50 records. A reader
 *     that divides wins by TOTAL records reports 8% instead of 25%, and a reader that
 *     pretends they were never written hides that the engine changes its mind.
 *
 *  2. CALLING EVERY CLOSE A TARGET. On 2026-10-12 five calls were flattened at 15:30
 *     (one for -35.4 bps). They are at-close exits, not stop losses and not wins. The
 *     engine's own `status` is WON/LOST on GROSS points, so the net view disagrees with
 *     it on the calls that do not survive the round trip — and BOTH numbers are
 *     reported rather than one being silently preferred.
 *
 * A third failure mode is asserted too: a session where nothing closed must yield a
 * NULL win rate. `0%` and `100%` are claims; null is the truth.
 *
 * AND THE WIN RULE ITSELF, because four different formulas used to run over this one
 * book: the history counted net-positive closes as wins, the sweep scorecard counted
 * netInr > 0 (so a +₹0.01 flatten was a "win"), the minute engine counted its own gross
 * WON status (so a 15:30 flatten was a win), and the server counted any verdict whose
 * string contained 'WON'. The chosen rule is the only one that cannot flatter the
 * engine: A WIN IS A CALL WHOSE TARGET WAS ACTUALLY HIT, a loss is a stop hit, and a
 * close that touched neither level is `otherExits` — reported, never counted as a win.
 * The headline rate is over DECIDED trades and is null when nothing decided.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { callBookHistory, classify, tallyOutcomes, liveRollingRecord } = require('../common/market/callBookHistory');

const FIXTURE = [
  // A target, a stop, a breakeven scratch, an at-close exit — the four real closes.
  { id: 'a', status: 'WON', exitReason: 'TARGET_HIT', netBps: 60, grossPoints1Lot: 3.0, strategyType: 'INTRADAY' },
  { id: 'b', status: 'LOST', exitReason: 'STOP_LOSS_HIT', netBps: -74, grossPoints1Lot: -3.6, strategyType: 'INTRADAY' },
  { id: 'c', status: 'WON', exitReason: 'BREAKEVEN_EXIT', netBps: 15, grossPoints1Lot: 0.9, strategyType: 'INTRADAY' },
  { id: 'd', status: 'LOST', exitReason: 'SESSION_CLOSE', netBps: -35.4, grossPoints1Lot: -1.2, strategyType: 'INTRADAY' },
  // GROSS WIN, NET LOSS: +0.2% does not survive the costs. The engine calls it WON.
  { id: 'e', status: 'WON', exitReason: 'SESSION_CLOSE', netBps: -8, grossPoints1Lot: 0.2, strategyType: 'INTRADAY' },
  // Never triggered — must NOT enter the win rate.
  { id: 'f', status: 'CANCELLED_EXHAUSTION', strategyType: 'INTRADAY' },
  { id: 'g', status: 'EXPIRED', strategyType: 'INTRADAY' },
  { id: 'h', status: 'ARMED', strategyType: 'INTRADAY' },
];

/** An old-format book: lower-case reasons and no net fields at all. */
const LEGACY = [
  { id: 'x', status: 'WON', exitReason: 'target', strategyType: 'SCALPING' },
  { id: 'y', status: 'LOST', exitReason: 'stop', strategyType: 'SCALPING' },
  { id: 'z', status: 'SESSION_CLOSE', exitReason: 'session_close', strategyType: 'SCALPING' },
  { id: 'w', status: 'INVALIDATED', strategyType: 'SCALPING' },
];

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'callbook-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body), 'utf8');
  }
  return dir;
}

const read = (dir, opts) => callBookHistory(Object.assign({ dir, days: 4 }, opts));

test('a call that never triggered is NOT counted as a win or a loss', () => {
  const dir = sandbox({ 'daily_calls_2026-10-07.json': FIXTURE });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  assert.equal(day.calls, 8, 'all eight records are accounted for');
  assert.equal(day.closed, 5, 'only five became positions: target, stop, breakeven, two closes');
  assert.equal(day.cancelled, 2, 'the cancelled and expired setups are their own bucket');
  assert.equal(day.stillOpen, 1, 'the ARMED call was still open when the file was written');
  assert.equal(day.closed + day.cancelled + day.stillOpen, day.calls,
    'every record lands in exactly one bucket');
});

test('a target, a stop and an at-close exit are three DIFFERENT verdicts', () => {
  const dir = sandbox({ 'daily_calls_2026-10-07.json': FIXTURE });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  assert.equal(day.outcomes.TARGET_HIT, 1);
  assert.equal(day.outcomes.STOP_LOSS_HIT, 1);
  assert.equal(day.outcomes.BREAKEVEN_EXIT, 1);
  assert.equal(day.outcomes.SESSION_CLOSE, 2, 'both closes are at-close exits, not stops');
  assert.equal(day.outcomes.CANCELLED, 2);
  assert.equal(day.outcomes.STILL_OPEN, 1);
  // THE ONE WIN RULE, on this fixture: one target and one stop decided the day, and the
  // breakeven plus the two at-close exits closed WITHOUT touching either level.
  assert.equal(day.targetHits, 1, 'exactly one call hit its target');
  assert.equal(day.stopsHit, 1, 'exactly one call hit its stop');
  assert.equal(day.otherExits, 3, 'breakeven + two at-close exits are their own bucket');
  assert.equal(day.decided, 2, 'the rate\'s denominator is the decided trades');
  assert.equal(day.winRatePct, 50.0,
    '1 target over 2 decided — NOT 40% (which folds the three level-less closes into the denominator) and NOT 66.7% (which would count the +₹ net closes as wins)');
});

test('the labels are what a trader reads, in the classifier itself', () => {
  assert.equal(classify({ status: 'WON', exitReason: 'TARGET_HIT' }).label, 'TARGET ACHIEVED');
  assert.equal(classify({ status: 'LOST', exitReason: 'STOP_LOSS_HIT' }).label, 'STOP LOSS HIT');
  assert.equal(classify({ status: 'LOST', exitReason: 'SESSION_CLOSE' }).label, 'EXITED AT CLOSE');
  assert.equal(classify({ status: 'WON', exitReason: 'BREAKEVEN_EXIT' }).label, 'BREAKEVEN (cost)');
  assert.equal(classify({ status: 'WON', exitReason: 'STAGNATION_EXIT', netBps: -4 }).label, 'TIME EXIT (no progress)');
  assert.equal(classify({ status: 'CANCELLED_EXHAUSTION' }).label, 'CANCELLED (never triggered)');
  assert.equal(classify({ status: 'ARMED' }).label, 'STILL OPEN AT CLOSE');
});

test('a bare WON with no recorded reason is NOT upgraded into a target hit', () => {
  const o = classify({ status: 'WON' });
  assert.equal(o.key, 'UNRECORDED');
  assert.equal(o.closed, true, 'it was a real position — it just did not say how it ended');
  assert.notEqual(o.key, 'TARGET_HIT', 'an unlabelled win must not be reported as a target achieved');
});

test('a time exit is judged on NET, not on which way the engine leaned', () => {
  assert.equal(classify({ status: 'WON', exitReason: 'STAGNATION_EXIT', netBps: -12 }).won, false,
    'gross-positive but net-negative is a losing call');
  assert.equal(classify({ status: 'LOST', exitReason: 'STAGNATION_EXIT', netBps: 3 }).won, true);
});

test('the engine gross verdict and the net verdict are BOTH reported when they differ', () => {
  const dir = sandbox({ 'daily_calls_2026-10-07.json': FIXTURE });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  // Closes: target (+), stop (-), breakeven (+), close (-35.4), close (-8, gross +0.2).
  assert.equal(day.wins, 2, 'net wins: the target and the breakeven scratch');
  assert.equal(day.winsGross, 3, "gross wins: those two plus the close that cost flipped");
  assert.equal(day.flippedByCost, 1, 'exactly one call changes verdict under cost');
  assert.match(day.netNote, /flippedByCost/, 'the discrepancy is named, not buried');
});

test('the win rate carries its denominator, and is NULL when nothing closed', () => {
  const dir = sandbox({
    'daily_calls_2026-10-07.json': FIXTURE,
    'daily_calls_2026-10-08.json': [{ id: 'p', status: 'CANCELLED_EXHAUSTION' }],
    'daily_calls_2026-10-09.json': [],
  });
  const r = read(dir, { now: Date.parse('2026-10-09T10:00:00Z') });
  const d08 = r.days.find((d) => d.date === '2026-10-08');
  const d09 = r.days.find((d) => d.date === '2026-10-09');

  assert.equal(d08.winRatePct, null, 'a session with only cancelled calls has NO win rate');
  assert.equal(d08.netPct, null, 'and no net, because nothing was measured');
  assert.equal(d09.winRatePct, null);
  assert.equal(d09.hasBook, false);
  assert.match(d09.note, /call book exists but the engine took no calls/,
    'an empty book says why instead of showing zeros');
  assert.ok(r.notMeasured.includes('2026-10-08') && r.notMeasured.includes('2026-10-09'),
    'both empty sessions are listed as not measured: ' + JSON.stringify(r.notMeasured));
  assert.ok(!r.notMeasured.includes('2026-10-07'),
    'the session with real closes DOES have a win rate');
});

test('a session with no file at all still gets a row, with a reason', () => {
  const dir = sandbox({});
  const r = read(dir, { now: Date.parse('2026-10-12T10:00:00Z') });
  assert.equal(r.days[0].date, '2026-10-12');
  assert.equal(r.days[0].isToday, true);
  assert.equal(r.days[0].hasBook, false);
  assert.equal(r.days[0].calls, 0);
  assert.equal(r.days[0].winRatePct, null);
  assert.match(r.days[0].note, /no call book for this session/);
  assert.ok(r.days.length === 4, 'the window is still four sessions');
});

test('weekends are not sessions, so the window walks back over them', () => {
  // 2026-10-12 is a Monday; walking back must give Mon, Fri, Thu, Wed — no Sat/Sun rows.
  const r = read(sandbox({}), { now: Date.parse('2026-10-12T10:00:00Z') });
  assert.deepEqual(r.days.map((d) => d.date), ['2026-10-12', '2026-10-09', '2026-10-08', '2026-10-07']);
});

test('the OLD file vocabulary is read too — lower-case reasons, no net fields', () => {
  const dir = sandbox({ 'daily_calls_2026-09-29.json': LEGACY });
  const day = read(dir, { now: Date.parse('2026-09-29T10:00:00Z') }).days.find((d) => d.date === '2026-09-29');
  assert.equal(day.calls, 4);
  assert.equal(day.closed, 3, 'target + stop + session_close');
  assert.equal(day.cancelled, 1, 'INVALIDATED never became a position');
  assert.equal(day.outcomes.TARGET_HIT, 1, "lower-case 'target' is still a target");
  assert.equal(day.outcomes.STOP_LOSS_HIT, 1, "lower-case 'stop' is still a stop");
  assert.equal(day.outcomes.SESSION_CLOSE, 1);
  // No net fields exist in that generation, so the net view says so rather than guessing.
  assert.equal(day.netPct, null, 'nothing measured net in that file — null, not zero');
  assert.equal(day.netMeasured, 0);
  // With no net data the recorded exit reasons are the only evidence: one target, one
  // stop, one at-close flatten. The flatten is neither a win nor a loss, so the headline
  // rate is 1 target over the 2 DECIDED trades.
  assert.equal(day.targetHits, 1);
  assert.equal(day.stopsHit, 1);
  assert.equal(day.otherExits, 1, 'the at-close flatten closed without a level');
  assert.equal(day.winRatePct, 50.0,
    'the at-close exit is not a win (+0.01 or not) and not a stop — it leaves the decided rate at 50%');
});

test('the tier map and the by-strategy table are the page\'s own contract', () => {
  const dir = sandbox({ 'daily_calls_2026-10-07.json': FIXTURE });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  assert.ok(day.tiers.INTRADAY, 'the tier key is the strategy tier the page renders');
  assert.equal(day.tiers.INTRADAY.calls, 8);
  assert.equal(day.byStrategy[0].id, 'OF_MOMENTUM');
  assert.equal(day.byStrategy[0].tier, 'INTRADAY');
  assert.equal(day.byStrategy[0].closed, 5);
});

test('tallyOutcomes gives ANY caller the same win rate as the day it came from', () => {
  // The server's strategy table, the sweep panel and the engines all call this with the
  // same records, so they cannot disagree with the history over the same book.
  const t = tallyOutcomes(FIXTURE);
  const dir = sandbox({ 'daily_calls_2026-10-07.json': FIXTURE });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  assert.equal(t.winRatePct, day.winRatePct, 'the one rule, applied to one book, gives one rate');
  assert.equal(t.targetHits, 1);
  assert.equal(t.stopsHit, 1);
  assert.equal(t.otherExits, 3);
  assert.equal(t.decided, 2);
});

test('a +0.01 net close is NOT a win under the one rule', () => {
  // The exact record class the user saw reported as a win: a session flatten whose net
  // came out one paisa positive. It is an exit without a level.
  const t = tallyOutcomes([
    { id: 'p', status: 'SESSION_CLOSE', exitReason: 'session_close', netBps: 0.02, netInr1Lot: 0.01, strategyType: 'INTRADAY' },
  ]);
  assert.equal(t.targetHits, 0, 'a paisa-positive flatten never hit its target');
  assert.equal(t.otherExits, 1);
  assert.equal(t.winRatePct, null, 'with nothing decided there is no rate to report — not 100%');
});

// ---------------------------------------------------------------------------------------------
// WHO MADE THE CALL, AND WHAT A RECORD THAT NEVER CLOSED ACTUALLY MEANS.
// Both are measured against the real books, not invented, and both were wrong before this test.
// ---------------------------------------------------------------------------------------------

/** A Sweep+FVG call exactly as that engine writes it: it stamps the sector and says who it is. */
const SWEEP_CALL = {
  id: 'CALL-SAMBHV-2026-10-12-001',
  engine: 'SWEEP_FVG',
  sector: 'INDUSTRIALS',
  side: 'SHORT',
  action: 'SELL',
  strategyType: 'SCALPING',
  status: 'FILLED',
  exitReason: null,
};

test('a FILLED call is an OPEN POSITION, never "CANCELLED (never triggered)"', () => {
  const o = classify({ status: 'FILLED', exitReason: null });
  assert.equal(o.key, 'STILL_OPEN',
    'FILLED means the entry traded; reporting it as cancelled deletes a live position from the day');
  assert.equal(o.closed, false);
  assert.notEqual(o.key, 'CANCELLED');
});

test('a TIME_EXIT status is a time exit even with no reason string recorded', () => {
  const o = classify({ status: 'TIME_EXIT', exitReason: null, netBps: -6 });
  assert.equal(o.key, 'STAGNATION_EXIT');
  assert.equal(o.closed, true);
  assert.equal(o.won, false, 'a time exit is judged on NET');
});

test('two engines share the call book, and each call keeps its own engine', () => {
  const dir = sandbox({
    'daily_calls_2026-10-12.json': [
      ...FIXTURE.slice(0, 5),                       // unstamped, minute-engine vocabulary
      Object.assign({}, SWEEP_CALL),                // stamped, sweep vocabulary
      Object.assign({}, SWEEP_CALL, { id: 'CALL-SAMBHV-2026-10-12-002', status: 'TARGET_HIT', exitReason: 'target', netBps: 41 }),
    ],
  });
  const day = read(dir, { now: Date.parse('2026-10-12T10:00:00Z') }).days.find((d) => d.date === '2026-10-12');
  const ids = day.byStrategy.map((s) => s.id).sort();
  assert.deepEqual(ids, ['OF_MOMENTUM', 'SWEEP_FVG'],
    'the book holds two engines and the page must show two strategies: ' + ids.join(','));
  // A MIXED book reports the WEAKER basis: with any record tagged from evidence, part of this
  // session's attribution is an inference, and the day must say so rather than claim a fact.
  assert.equal(day.engineBasis, 'record evidence', 'a partly-inferred day must not claim a stamp');
  const sweep = day.byStrategy.find((s) => s.id === 'SWEEP_FVG');
  assert.equal(sweep.calls, 2, 'both sweep records are attributed to the sweep engine');
  assert.equal(sweep.closed, 1, 'the FILLED one is still open; only the target closed');
  assert.equal(sweep.stillOpen, 1);
  assert.equal(sweep.name, 'Sweep + FVG (5m cadence)', 'the row names the engine, not just an id');
  const momentum = day.byStrategy.find((s) => s.id === 'OF_MOMENTUM');
  assert.equal(momentum.calls, 5, 'the minute engine keeps exactly its own calls');
  assert.ok(!/liveMinuteEngine$/.test(day.source),
    'the day must not name one engine as the source of a book both engines write');

  // THE TIER ROW COUNTS EVERY ENGINE IN IT. The sweep call here declares SCALPING and the minute
  // calls declare INTRADAY, so the two engines land in different tiers — and that map used to be
  // overwritten once per strategy rather than summed, which silently reduced a tier to whichever
  // strategy was read last.
  assert.equal(day.tiers.INTRADAY.calls, 5, 'the INTRADAY tier is the minute engine\'s five calls');
  assert.deepEqual(day.tiers.INTRADAY.engines, ['OF_MOMENTUM']);
  assert.equal(day.tiers.SCALPING.calls, 2, 'and the SCALPING tier is the sweep engine\'s two');
  assert.equal(day.tiers.SCALPING.closed, 1, 'its FILLED call is open; only its target closed');
  assert.deepEqual(day.tiers.SCALPING.engines, ['SWEEP_FVG']);
  assert.equal(day.tiers.INTRADAY.calls + day.tiers.SCALPING.calls, day.calls,
    'every record is in exactly one tier');
});

test('a session where every record is stamped reports the stamp as the basis', () => {
  const dir = sandbox({
    'daily_calls_2026-10-12.json': [
      Object.assign({}, SWEEP_CALL),
      Object.assign({}, SWEEP_CALL, { id: 'CALL-SAMBHV-2026-10-12-009', status: 'ARMED' }),
    ],
  });
  const day = read(dir, { now: Date.parse('2026-10-12T10:00:00Z') }).days.find((d) => d.date === '2026-10-12');
  assert.equal(day.engineBasis, 'engine field',
    'every record carried its engine, so the attribution is a fact and the page may say so');
  assert.deepEqual(day.byStrategy.map((s) => s.id), ['SWEEP_FVG'], 'one engine took every call');
  assert.equal(day.byStrategy[0].calls, 2);
  assert.equal(day.byStrategy[0].closed, 0, 'one FILLED (open) and one ARMED (open) — nothing closed');
  assert.equal(day.byStrategy[0].stillOpen, 2);
  assert.equal(day.winRatePct, null, 'and with nothing closed there is no win rate to report');
});

// ---------------------------------------------------------------------------
// THE MULTI-SESSION LIVE RECORD (server's `liveRecord`, the page's banner)
// ---------------------------------------------------------------------------

test('the rolling live record counts every session and NAMES the dates with no book', () => {
  // Wednesday 2026-10-14 and Thursday 2026-10-15 have no file — a gap, not two flat days.
  const dir = sandbox({
    'daily_calls_2026-10-12.json': [
      { id: 'a', status: 'WON', exitReason: 'target', netBps: 50, strategyType: 'INTRADAY' },
      { id: 'b', status: 'LOST', exitReason: 'stop', netBps: -60, strategyType: 'INTRADAY' },
    ],
    'daily_calls_2026-10-13.json': [
      { id: 'c', status: 'WON', exitReason: 'target', netBps: 40, strategyType: 'INTRADAY' },
    ],
    'daily_calls_2026-10-16.json': [
      { id: 'd', status: 'LOST', exitReason: 'stop', netBps: -55, strategyType: 'INTRADAY' },
      { id: 'e', status: 'ARMED', strategyType: 'INTRADAY' },
    ],
  });
  const rec = liveRollingRecord({ dir, sessions: 3, now: Date.parse('2026-10-17T10:00:00Z') });

  assert.deepEqual(rec.sessionsIncluded, ['2026-10-12', '2026-10-13', '2026-10-16'],
    'the most recent three sessions WITH a book, in chronological order');
  assert.deepEqual(rec.missing, ['2026-10-14', '2026-10-15'],
    'the weekday dates walked past with no book must be reported, not silently skipped');
  assert.match(rec.windowLabel, /last 3 recorded sessions/);
  assert.equal(rec.overall.calls, 5);
  assert.equal(rec.overall.decided, 4, 'two targets and two stops decide');
  assert.equal(rec.overall.winRatePct, 50, '2 of 4 decided — the ARMED call never enters the rate');
  assert.equal(rec.overall.netPF, +((50 + 40) / (60 + 55)).toFixed(2), 'PF from measured nets only');
});

test('a session that recorded nothing is a session of zero calls, not a missing one', () => {
  const dir = sandbox({
    'daily_calls_2026-10-13.json': [{ id: 'a', status: 'WON', exitReason: 'target', netBps: 40, strategyType: 'INTRADAY' }],
    'daily_calls_2026-10-16.json': [],   // the file exists and is empty — today looks like this
  });
  const rec = liveRollingRecord({ dir, sessions: 2, now: Date.parse('2026-10-17T10:00:00Z') });
  assert.deepEqual(rec.sessionsIncluded, ['2026-10-13', '2026-10-16']);
  assert.equal(rec.sessions.find((s) => s.date === '2026-10-16').calls, 0);
  assert.equal(rec.overall.winRatePct, 100, 'one target, no stops');
});

test('an OLDER record with no stamp is attributed from the evidence in the record', () => {
  // The real 2026-10-07 book: 50 records, every one carrying `sector`, and statuses the minute
  // engine never writes (32 CANCELLED_EXHAUSTION, 2 EXPIRED). They were reported for 12 sessions
  // as "Order Flow Institutional Momentum". They are not that engine's calls.
  const dir = sandbox({
    'daily_calls_2026-10-07.json': [
      { id: 's1', sector: 'PHARMA', status: 'CANCELLED_EXHAUSTION', strategyType: 'INTRADAY' },
      { id: 's2', sector: 'PHARMA', status: 'EXPIRED', strategyType: 'INTRADAY' },
      { id: 's3', sector: 'PHARMA', status: 'WON', exitReason: 'target', netBps: 55, strategyType: 'INTRADAY' },
      { id: 'm1', status: 'LOST', exitReason: 'stop', netBps: -60, strategyType: 'INTRADAY' },
    ],
  });
  const day = read(dir, { now: Date.parse('2026-10-07T10:00:00Z') }).days.find((d) => d.date === '2026-10-07');
  assert.equal(day.engineBasis, 'record evidence',
    'with no stamp the page says the attribution is an inference, not a fact');
  const sweep = day.byStrategy.find((s) => s.id === 'SWEEP_FVG');
  const momentum = day.byStrategy.find((s) => s.id === 'OF_MOMENTUM');
  assert.equal(sweep.calls, 3, 'the sector is the sweep engine\'s own field: ' + JSON.stringify(day.byStrategy.map((s) => s.id)));
  assert.equal(momentum.calls, 1, 'the unstamped, minute-engine-vocabulary record stays with the minute engine');
});
