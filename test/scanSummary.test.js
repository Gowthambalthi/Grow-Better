'use strict';

/**
 * THE 30-MINUTE SCAN COUNT.
 *
 * The request was narrow: while the market is open, tell Telegram every half hour
 * how many stocks were scanned. The things that can go wrong with a timer like this
 * are all invisible in a log, so they are pinned here:
 *
 *   1. it fires OUTSIDE market hours and wakes the owner at 09:00 or 20:00;
 *   2. it reports 0 scanned when the truth is "the feed never ran" — the exact
 *      silence this board keeps having to disambiguate;
 *   3. a refused Telegram call becomes an unhandled rejection and kills the timer;
 *   4. it reports the count but not WHEN the pass happened, so a stalled scan looks
 *      like a live one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  initScheduler,
  marketOpenAt,
  formatScanSummary,
  sendScanSummary,
  SCAN_SUMMARY_CRON,
} = require('../common/scheduler/cronJobs');

/** A weekday timestamp in IST. 2026-10-19 is a Monday. */
const ist = (h, m) => new Date(`2026-10-19T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);
const sunday = (h, m) => new Date(`2026-10-18T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+05:30`);

const FUNNEL = { scanned: 494, inPlay: 172, qualified: 0, asOfIST: '12:08:46' };

test('the message leads with the number of stocks scanned', () => {
  const text = formatScanSummary(FUNNEL, '12:30:00');
  assert.match(text, /12:30:00/);
  assert.match(text, /<b>494<\/b> stocks scanned/, 'the count asked for is the headline: ' + text);
  assert.match(text, /172 in play/, 'and in-play is beside it, because 494 scanned alone cannot tell a quiet tape from a broken one');
  assert.match(text, /0 qualified/);
});

test('a stale pass prints the time it ran, so a stalled scan cannot look live', () => {
  const text = formatScanSummary(FUNNEL, '15:00:00');
  assert.match(text, /last pass 12:08:46/,
    'during CUTOFF the scan stops walking the universe and the numbers keep their last values; ' +
    'the timestamp is what says so');
});

test('no scan yet is SAID, not reported as zero', () => {
  const text = formatScanSummary(null, '09:30:00');
  assert.match(text, /No symbol-level scan/,
    'zero scanned and "the scan never ran" are different facts: ' + text);
  assert.doesNotMatch(text, /<b>0<\/b> stocks scanned/);

  // The funnel's own blank shape — every counter at zero with no timestamp — is the
  // same fact and must read the same way. This is `emptyFunnel()`: what a fresh process,
  // or one restarted inside the 12:15-12:45 no-entry window, actually holds. Calling it
  // "0 stocks scanned" was measured on 2026-10-19 at 12:30 and read exactly like a dead feed.
  const blank = formatScanSummary({ scanned: 0, inPlay: 0, qualified: 0, asOfIST: null }, '12:30:00');
  assert.match(blank, /No symbol-level scan/,
    'an empty funnel is "never looked", not "looked and found zero": ' + blank);
  assert.doesNotMatch(blank, /<b>0<\/b> stocks scanned/);

  // A REAL pass that walked zero symbols is different: it carries its own timestamp,
  // because the scan stamps `asOfIST` before it walks anything.
  const realZero = formatScanSummary({ scanned: 0, inPlay: 0, qualified: 0, asOfIST: '12:14:15' }, '12:30:00');
  assert.match(realZero, /<b>0<\/b> stocks scanned/,
    'a stamped pass with an empty universe still reports 0, with the time that says when');
  assert.match(realZero, /last pass 12:14:15/);
});

test('market hours are the boundary, not the cron expression', () => {
  assert.equal(marketOpenAt(ist(9, 30)), true, 'active trading');
  assert.equal(marketOpenAt(ist(12, 0)), true);
  assert.equal(marketOpenAt(ist(15, 5)), true, 'CUTOFF still has a live tape and open positions');
  assert.equal(marketOpenAt(ist(15, 20)), true, 'SQUARE_OFF still manages positions');

  assert.equal(marketOpenAt(ist(9, 0)), false, 'PRE_OPEN must send nothing');
  assert.equal(marketOpenAt(ist(9, 15)), false, 'OBSERVATION must send nothing');
  assert.equal(marketOpenAt(ist(15, 30)), false, 'CLOSED at 15:30, which is exactly when the next tick lands');
  assert.equal(marketOpenAt(ist(20, 0)), false);
  assert.equal(marketOpenAt(sunday(12, 0)), false, 'Sunday');
});

/** A node-cron stand-in that records jobs instead of running them. */
function fakeCron() {
  const jobs = [];
  return {
    jobs,
    schedule(expr, fn, opts) { jobs.push({ expr, fn, opts }); },
    byExpr(expr) { return jobs.find((j) => j.expr === expr); },
  };
}

test('the scheduler registers a half-hourly job, not a daily one', () => {
  const cron = fakeCron();
  initScheduler({ cron, now: () => ist(12, 0), sendScanSummary: () => {} });
  const job = cron.byExpr(SCAN_SUMMARY_CRON);
  assert.ok(job, 'no */30 job was registered: ' + JSON.stringify(cron.jobs.map((j) => j.expr)));
  assert.equal(SCAN_SUMMARY_CRON, '*/30 * * * *', 'every 30 minutes, every hour');
  assert.equal(job.opts.timezone, 'Asia/Kolkata', 'IST, or the schedule drifts with the host clock');
});

test('node-cron accepts the expression — an invalid one is silently never scheduled', () => {
  let cron;
  try { cron = require('node-cron'); } catch (_) { cron = null; }
  if (!cron) return;                       // the scheduler logs and degrades without it
  assert.equal(cron.validate(SCAN_SUMMARY_CRON), true,
    SCAN_SUMMARY_CRON + ' must be a valid node-cron expression, or the job is never registered ' +
    'and the only symptom is silence');
  assert.equal(cron.validate('0 18 * * *'), true, 'the existing evening scan stays valid too');
});

test('the job has a REAL next fire time, on :00 or :30 IST', () => {
  // The expression being valid is not the same as the job being runnable: this asks
  // node-cron to compute the actual next fire and checks it lands on the half hour.
  // It is the closest a test can get to watching the clock, without waiting for one.
  let cron;
  try { cron = require('node-cron'); } catch (_) { return; }

  const task = cron.schedule(SCAN_SUMMARY_CRON, () => {}, { timezone: 'Asia/Kolkata', scheduled: false });
  try {
    if (typeof task.getNextRun !== 'function') return;   // older node-cron: nothing to assert
    const next = task.getNextRun();
    assert.ok(next instanceof Date && isFinite(next.getTime()),
      'node-cron must resolve a concrete next run, got ' + next);
    const ist = new Date(next.getTime() + 330 * 60000);
    assert.equal(ist.getUTCMinutes() % 30, 0,
      'next run must land on :00 or :30 IST, got :' + String(ist.getUTCMinutes()).padStart(2, '0'));
    assert.equal(ist.getUTCSeconds(), 0, 'with no seconds offset');
    assert.ok(next.getTime() > Date.now(), 'and it must be in the future');
  } finally {
    if (typeof task.destroy === 'function') task.destroy();
  }
});

test('the job sends while open and stays silent when closed', () => {
  let sent = 0;
  const send = () => { sent += 1; };

  const open = fakeCron();
  initScheduler({ cron: open, now: () => ist(12, 0), sendScanSummary: send });
  open.byExpr(SCAN_SUMMARY_CRON).fn();
  assert.equal(sent, 1, 'mid-session, one message per tick');

  const closed = fakeCron();
  initScheduler({ cron: closed, now: () => ist(20, 0), sendScanSummary: send });
  closed.byExpr(SCAN_SUMMARY_CRON).fn();
  assert.equal(sent, 1, 'after hours the same tick must send nothing');

  const weekend = fakeCron();
  initScheduler({ cron: weekend, now: () => sunday(12, 0), sendScanSummary: send });
  weekend.byExpr(SCAN_SUMMARY_CRON).fn();
  assert.equal(sent, 1, 'and nothing on a Sunday');
});

test('a refused send is logged, never thrown at the scheduler', async () => {
  const engine = { getScanFunnel: () => FUNNEL };
  const text = await sendScanSummary({
    engine,
    notify: async () => ({ success: false, reason: 'Bot token is missing' }),
  });
  assert.match(text, /494/, 'the summary is still produced when delivery fails');

  await assert.doesNotReject(
    () => sendScanSummary({ engine, notify: async () => { throw new Error('network'); } }),
    'a transport failure must not become an unhandled rejection on a timer'
  );

  await assert.doesNotReject(
    () => sendScanSummary({ engine: { getScanFunnel() { throw new Error('boom'); } }, notify: async () => ({ success: true }) }),
    'a funnel read failure must not take the scheduler down either'
  );
});

test('a throttled tick does not throw when the send is synchronous', () => {
  const cron = fakeCron();
  initScheduler({
    cron,
    now: () => ist(12, 0),
    sendScanSummary: () => { throw new Error('sync failure'); },
  });
  assert.doesNotThrow(() => cron.byExpr(SCAN_SUMMARY_CRON).fn(),
    'the callback must contain its own failure, because nothing upstream catches it');
});
