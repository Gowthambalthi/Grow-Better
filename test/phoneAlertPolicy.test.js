'use strict';

/**
 * Phone-alert policy — what may reach the phone, and what may not.
 *
 * This exists because of a MEASURED failure on 2026-09-28. The user reported "i dont
 * get notifications for telegram to sell or buy", and data/phone_alerts_log.json
 * agreed with them: CALL sent 23, POSITION sent 45, EXIT held 30, EXITPLAN held 101,
 * transport errors 0. Every SELL had been classified DIGEST and queued for the 15:45
 * evening summary, so not one exit was even attempted in the moment — and the same
 * exit PLAN had been queued 101 times in a single hour, which is how a digest becomes
 * unreadable at exactly the moment it is carrying the day's stops.
 *
 * READ-ONLY ON PURPOSE. gate() only reads state, and this test never writes the
 * user's live alert state or digest: a test must not buzz a phone, and it must not
 * race the running engine for the files that decide whether a real stop-hit is sent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
// The digest path is relocated BEFORE the module loads, so the de-duplication can be
// exercised for real against a temp file without writing the digest the live session
// is about to deliver.
const TMP_DIGEST = path.join(os.tmpdir(), 'gb-phone-digest-' + process.pid + '.json');
process.env.GB_PHONE_DIGEST = TMP_DIGEST;
const phoneAlert = require('../common/notifications/phoneAlert');
test.after(() => { try { fs.unlinkSync(TMP_DIGEST); } catch (_) {} });

function liveState() {
  try { return JSON.parse(fs.readFileSync(phoneAlert.STATE_FILE, 'utf8')); } catch (_) { return { sent: {} }; }
}

test('a stop-hit is never queued for the evening summary', () => {
  assert.ok(!phoneAlert.DIGEST_KINDS.includes('EXIT'),
    'EXIT in DIGEST_KINDS is the exact regression that silenced every SELL on 28-Sep');
  assert.ok(phoneAlert.DIGEST_KINDS.includes('EXITPLAN'),
    'an exit PLAN still does not need to buzz the phone every minute');
});

test('an exit takes its own branch: once per call, and not the entry cooldown', () => {
  // An exit that has already been recorded is refused for ONE reason only — it is the
  // same call. It is never refused for "cooldown" or "daily cap reached", which are
  // the two reasons that would otherwise silence a stop-hit for the rest of the day.
  const st = liveState();
  const held = Object.keys(st.sent || {})[0];
  if (!held) return;                       // fresh state file: nothing to check yet
  const g = phoneAlert.gate(held, 'EXIT', Date.now(), {});
  assert.equal(g.ok, false);
  assert.match(g.why, /already alerted/);
  assert.ok(!/cooldown/.test(g.why), 'an exit must not be filtered by the entry cooldown');
  assert.ok(!/daily cap/.test(g.why), 'an exit must not be filtered by the entry cap');
});

test('the entry side still IS rate-limited, so the exemption is specific to exits', () => {
  // Contrast, not a re-test of EXIT: an ENTRY keyed to the same symbol is refused for
  // the cooldown. Uses the freshest key the live state has, and skips when none is
  // inside the cooldown window (off-hours, or a quiet day) rather than inventing one.
  const st = liveState();
  const sent = st.sent || {};
  const newest = Object.keys(sent).sort((a, b) => sent[b] - sent[a])[0];
  if (!newest) return;
  if (Date.now() - sent[newest] >= phoneAlert.status().entryCooldownMin * 60000) return;
  const g = phoneAlert.gate(newest, 'SIGNAL', Date.now(), { strong: true });
  assert.equal(g.ok, false, 'a fresh entry key must be refused');
  assert.match(g.why, /cooldown/, 'and refused for the cooldown, not by accident');
});

test('a plain SIGNAL stays dashboard-only unless it is marked strong', () => {
  const key = 'TESTSYM:entry:policy';
  assert.equal(phoneAlert.gate(key, 'SIGNAL', Date.now(), {}).dashboardOnly, true);
});

test('status() separates holds from failures, so "no alert" is diagnosable', () => {
  const s = phoneAlert.status();
  for (const k of ['sentToday', 'suppressedToday', 'failedToday', 'dayCount', 'dailyCap', 'lastError', 'entryCooldownMin']) {
    assert.ok(k in s, 'status must expose ' + k);
  }
  assert.equal(typeof s.sentToday, 'number');
  assert.equal(typeof s.failedToday, 'number');
});

test('an exit plan re-queued every scan becomes ONE digest entry (the 101-copy bug)', () => {
  const key = 'HEROMOTORS:SHORT:exitplan:0';
  let n = 0;
  for (let i = 0; i < 101; i++) {
    n = phoneAlert.digestAdd({ key, kind: 'EXITPLAN', symbol: 'HEROMOTORS', title: 'EXIT PLAN HEROMOTORS', message: 'stop 100' });
  }
  assert.equal(n, 1, '101 re-fires of the same plan must queue exactly one entry');
  const q = JSON.parse(fs.readFileSync(TMP_DIGEST, 'utf8'));
  assert.equal(q.items.length, 1);
  assert.equal(q.items[0].repeat, 101, 'the count is kept so a noisy plan is still visible');
  assert.equal(q.items[0].key, key);
});

test('different events still queue separately', () => {
  phoneAlert.digestAdd({ key: 'A:exitplan:0', kind: 'EXITPLAN', symbol: 'A' });
  phoneAlert.digestAdd({ key: 'B:exitplan:0', kind: 'EXITPLAN', symbol: 'B' });
  const q = JSON.parse(fs.readFileSync(TMP_DIGEST, 'utf8'));
  assert.equal(q.items.length, 3, 'two more events join the existing one');
  assert.deepEqual(q.items.map(i => i.symbol), ['HEROMOTORS', 'A', 'B']);
});
