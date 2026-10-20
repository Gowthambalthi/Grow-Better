'use strict';

/**
 * ONE EVENT, ONE MESSAGE.
 *
 * On 2026-10-19 the channel flooded: the daily scorecard arrived a dozen times between 12:11
 * and 13:07, the morning's exits were re-announced at 12:56, 13:02, 13:06, 13:08 and 13:11, and
 * the whole OF_MOMENTUM book came back at 13:19-13:24 carrying exit times from 09:30-11:38.
 * Every one of those messages was correct in content — the repetition was the defect, and its
 * cause is structural: "already announced" was held in ONE process's memory, so a restart
 * rebuilt the day's book and announced it again, and a second running instance announced it in
 * parallel. (On Windows a second `listen(4000)` even succeeds, which is why Server.js carries
 * its own /health pidfile lock.)
 *
 * The invariant therefore has to live at the TRANSPORT, where every sender in every process
 * passes: a caller that names its event (`dedupeKey`) gets at most one delivery per key. These
 * tests pin the four properties that make that true rather than hopeful:
 *
 *   1. a key that has been sent is never sent again — and the answer says WHY it was dropped, so
 *      a suppressed duplicate cannot be mistaken for a configured bot;
 *   2. the marker is written BEFORE the send, so two processes racing on the same event cannot
 *      both pass the check (the lease window is what closes that race);
 *   3. a send that FAILS leaves the event retryable — a dropped alert is a worse failure than a
 *      repeated one, so the claim is released on failure and taken over once its lease expires;
 *   4. a caller that does not name its event is untouched, so no existing sender changes shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

// The ledger lives beside the call book; sandbox it before the module loads so a test never
// writes the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-dedupe-'));
process.env.GB_ORDERFLOW_DIR = TMP;
// The ledger is a per-event record with REAL consequences — a `sent` key suppresses that event.
// A test that exercises a real dispatcher must therefore write its own, never the app's.
process.env.GB_TELEGRAM_LEDGER = path.join(TMP, 'telegram_sent_ledger.json');
// This file is the ONE place that means to exercise the sender, and its transport (axios.post) is
// stubbed below, so it is allowed past the "a test may not post to the live channel" guard — and
// the assertion right under this proves it is still the stub it thinks it is.
process.env.GB_TELEGRAM_ALLOW_FROM_TESTS = '1';

const axios = require('axios');
const tel = require('../common/notifications/telegramService');

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const LEDGER = tel.dedupeLedgerFile();
assert.equal(LEDGER, process.env.GB_TELEGRAM_LEDGER,
  'this test must resolve the SANDBOX ledger, not the app\'s');

/**
 * THE NETWORK IS STUBBED, NOT THE SENDER.
 *
 * `data/notification_settings.json` holds a real bot token, so this file must be unable to post to
 * the owner's phone. Stubbing `sendPhoneNotificationNow` would be the wrong seam twice over: it is
 * the function that CONTAINS the dedupe logic under test, so the test would be asserting nothing
 * about it. `axios.post` is the actual boundary — the Telegram call — and with it replaced the
 * real sender, the real ledger and the real config are all exercised, and no socket is opened.
 */
const sent = [];
let telegramOk = true;
let sendThrows = null;
const origPost = axios.post;

axios.post = async (url, body) => {
  if (/\/sendMessage$/.test(String(url))) {
    sent.push(String(body && body.text));
    if (sendThrows) throw new Error(sendThrows);
    return { data: telegramOk ? { ok: true } : { ok: false, description: 'stubbed refusal' } };
  }
  return { data: {} };
};

test.after(() => { axios.post = origPost; });

// Belt AND braces: even with the guard overridden, the transport is not axios until this asserts it.
assert.notEqual(axios.post, origPost, 'this file must stub axios.post before any send');

function resetTransport(opts = {}) {
  sent.length = 0;
  telegramOk = opts.telegramOk !== false;
  sendThrows = opts.throw || null;
}

// `sendPhoneNotification` is the paced entry point; the pacer is a queue, so tests call the
// transport directly through it with pacing disabled.
const GAP = process.env.TELEGRAM_GAP_MS;
test.before(() => { process.env.TELEGRAM_GAP_MS = '0'; });
test.after(() => {
  if (GAP === undefined) delete process.env.TELEGRAM_GAP_MS; else process.env.TELEGRAM_GAP_MS = GAP;
});

test('a key that was sent is never sent again, and the refusal names the key', async () => {
  resetTransport();
  const key = 'exit:CALL-TEST-2026-10-19-001:STOP_LOSS_HIT';
  const first = await tel.sendPhoneNotification('<b>one</b>', { dedupeKey: key });
  assert.equal(first.success, true, 'the first copy goes out');

  const second = await tel.sendPhoneNotification('<b>one</b>', { dedupeKey: key });
  assert.equal(second.success, false);
  assert.equal(second.deduped, true, 'the second is refused as a duplicate: ' + JSON.stringify(second));
  assert.match(second.reason, /already sent/);
  assert.equal(sent.length, 1,
    'ONE delivery reached the transport — this is the whole invariant: ' + JSON.stringify(sent));
});

test('the marker is written BEFORE the send, so a race cannot pass the check twice', async () => {
  const key = 'exit:CALL-RACE-2026-10-19-002:TARGET_HIT';
  let stateWhenSending = null;
  // Ask the ledger what it says AT THE MOMENT the send is in flight — synchronously inside the
  // network stub, which is as close as a test can get to the second process looking at the same
  // instant.
  resetTransport();
  const innerPost = axios.post;
  axios.post = async (url, body) => {
    const out = await innerPost(url, body);
    stateWhenSending = tel.dedupeState(key);
    return out;
  };
  try {
    await tel.sendPhoneNotification('<b>race</b>', { dedupeKey: key });
  } finally { axios.post = innerPost; }
  assert.equal(stateWhenSending, 'inflight',
    'the claim must already be on disk while the message is in flight, got ' + stateWhenSending);
  assert.equal(tel.dedupeState(key), 'sent', 'and settled to `sent` once the sender confirmed it');
});

test('a FAILED send stays retryable — a lost alert is worse than a repeated one', async () => {
  const key = 'new:CALL-RETRY-2026-10-19-003';
  resetTransport({ telegramOk: false });
  const failed = await tel.sendPhoneNotification('<b>retry</b>', { dedupeKey: key });
  assert.equal(failed.success, false);
  assert.notEqual(failed.deduped, true, 'a transport failure is not a duplicate');
  assert.equal(tel.dedupeState(key), 'clear',
    'nothing was delivered, so the event must be sendable again');

  resetTransport();
  const retried = await tel.sendPhoneNotification('<b>retry</b>', { dedupeKey: key });
  assert.equal(retried.success, true, 'the retry goes out');
  assert.equal(sent.length, 1);
});

test('an abandoned claim is taken over after its lease, not trusted forever', async () => {
  const key = 'new:CALL-STALE-2026-10-19-004';
  resetTransport();
  // A process that claimed the key and died mid-send: the claim is on disk and old.
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  const ledger = JSON.parse(fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8') : '{}');
  ledger[key] = { state: 'sending', at: new Date(Date.now() - (tel.DEDUPE_LEASE_MS + 5000)).toISOString() };
  fs.writeFileSync(LEDGER, JSON.stringify(ledger), 'utf8');

  const res = await tel.sendPhoneNotification('<b>stale</b>', { dedupeKey: key });
  assert.equal(res.success, true,
    'a claim older than the lease must be taken over, or one crash loses that alert permanently');
  assert.equal(sent.length, 1);
});

test('a caller with NO key is untouched — no dedupe, no ledger entry', async () => {
  resetTransport();
  const a = await tel.sendPhoneNotification('<b>anon</b>');
  const b = await tel.sendPhoneNotification('<b>anon</b>');
  assert.equal(a.success, true);
  assert.equal(b.success, true, 'two identical anonymous messages are two real events as far as this layer knows');
  assert.equal(sent.length, 2);
});

test('the engine\'s own exit dispatcher sends ONE message for one exit', async () => {
  // THIS IS THE REPORTED FAILURE, as a test: the same settled call, dispatched twice — which is
  // what a second instance and a restart-after-close both do. Before the ledger, both reached the
  // channel; the owner's phone showed the same #EXIDEIND scratch twice, and the whole morning book
  // again at 13:19. The engine is required here (not stubbed), so this pins the WIRING too: the
  // dispatchers must actually pass a key, not merely be able to.
  const live = require('../strategies/orderflow/liveMinuteEngine');
  resetTransport();
  const call = {
    id: 'CALL-EXIDEIND-2026-10-19-001', symbol: 'EXIDEIND', action: 'BUY',
    limitEntry: 413.85, exitPrice: 414.45, status: 'CLOSED', exitReason: 'BREAKEVEN_EXIT',
    exitTimeIST: '09:46:58', grossPoints1Lot: 0.6, livePnLPct: 0.14, netInr1Lot: -2.49,
    timeIST: '09:45:00', strategyId: 'OF_MOMENTUM',
  };
  await live.dispatchTelegramExit(call, false);
  await live.dispatchTelegramExit(call, false);
  assert.equal(sent.length, 1,
    'one exit, one message — got ' + sent.length + ' deliveries');
  assert.match(sent[0], /BREAKEVEN SCRATCH/);

  // A DIFFERENT call, and the same call under a different outcome, must both still go out.
  await live.dispatchTelegramExit(Object.assign({}, call, { id: 'CALL-EXIDEIND-2026-10-19-002' }), false);
  await live.dispatchTelegramExit(Object.assign({}, call, { status: 'LOST', exitReason: 'STOP_LOSS_HIT' }), false);
  assert.equal(sent.length, 3, 'a second call, and a re-read outcome, are new events');
});

test('the engine names its events, so its exits, calls and scorecard can never double-send', () => {
  // The key must be a property of the EVENT, not of the process: same call, same outcome, same
  // key in any process, and different outcomes (or different calls) must not collide.
  const call = {
    id: 'CALL-EXIDEIND-2026-10-19-001', symbol: 'EXIDEIND', timeIST: '09:46:58',
    exitReason: 'BREAKEVEN_EXIT',
  };
  const live = require('../strategies/orderflow/liveMinuteEngine');
  assert.equal(typeof live.alertEventKey, 'function',
    'the key builder must be exported so the wording of an event id is pinned, not implied');
  assert.equal(live.alertEventKey('new', call), 'new:CALL-EXIDEIND-2026-10-19-001');
  assert.equal(live.alertEventKey('exit', call), 'exit:CALL-EXIDEIND-2026-10-19-001:BREAKEVEN_EXIT');
  assert.notEqual(
    live.alertEventKey('exit', call),
    live.alertEventKey('exit', Object.assign({}, call, { exitReason: 'STOP_LOSS_HIT' })),
    'the same call re-read under a different outcome is a different fact and must not be suppressed');
  assert.notEqual(
    live.alertEventKey('exit', call),
    live.alertEventKey('exit', Object.assign({}, call, { id: 'CALL-EXIDEIND-2026-10-19-002' })),
    'two calls on one symbol in one session are two events');
});
