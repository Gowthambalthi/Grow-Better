'use strict';

/**
 * THE BOT MUST ANSWER, FROM THE ENGINES, AND ONLY TO THE OWNER.
 *
 * The 2026-10-19 question — "the phone shows calls, the page shows none" — could only be asked
 * from a laptop, because alerts were one-way. These tests pin the four commands and the three
 * rules the poller keeps: no replay of history, no reply to another chat, and a poll failure that
 * does not take the inbox down.
 *
 * The router is pure, so no token and no network are involved; the poller is driven with an
 * injected transport, so no message leaves the machine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInbox, startInbox, HELP } = require('../common/notifications/telegramInbox');

const OPEN_ROWS = [
  {
    id: 'CALL-SAMBHV-2026-10-19-001', symbol: 'SAMBHV', engine: 'OF_MOMENTUM',
    strategyId: 'OF_MOMENTUM', strategyName: 'Order Flow Institutional Momentum',
    side: 'LONG', action: 'BUY', status: 'ARMED', entryPrice: 101.2, stopLoss: 99.8,
    target1: 103.5, livePnLPct: 0.64,
  },
  {
    id: 'CALL-OLECTRA-2026-10-19-002', symbol: 'OLECTRA', engine: 'OF_MOMENTUM',
    strategyId: 'GB03a', strategyName: 'GB03a — OF03 Exhaustion Reversal',
    side: 'SHORT', action: 'SELL', status: 'OPEN', entryPrice: 1500, stopLoss: 1518,
    target1: 1470, livePnLPct: -0.2,
  },
];

const FUNNEL = {
  scanned: 512, inPlay: 87, qualified: 0, asOfIST: '10:14:00',
  slotsAvailable: 6, long: { armed: 0, vwap: 44, delta: 12 }, short: { armed: 0, confluence: 30 },
  gb03: { evaluated: 494, emitted: 53, refusedPlanner: 53 },
  ofMomentum: { armed: true, today: 2, open: 2, maxSlots: 3, maxPerSession: 12, droppedBySessionCap: 1 },
};

const DAILY = {
  date: '2026-10-19', totalCalls: 8, activeCalls: 2, closedCalls: 6,
  won: 3, lost: 1, otherExits: 2, decided: 4, totalPoints: 12.4, totalNetInr: 1240,
  winRateBasis: '3/4 decided (target or stop)', verdict: 'NET POSITIVE (+₹1240)',
};

function inboxOf(overrides = {}) {
  return createInbox(Object.assign({
    engine: {
      getActiveCandidates: () => OPEN_ROWS,
      getScanFunnel: () => FUNNEL,
      getDailyNet: () => DAILY,
      ofMomentumLiveState: () => ({ armed: true, maxSlots: 3, maxPerSession: 12 }),
    },
    session: () => ({ state: 'ACTIVE_TRADING', signalAllowed: true, marketOpen: true }),
    alerts: () => ({ configured: true, telegram: true, reason: null }),
    feed: () => ({ connected: true, lastTickAt: '10:14:02' }),
  }, overrides));
}

test('/calls prints the open book with the call\'s own entry, stop, target and setup', () => {
  const reply = inboxOf().handle('/calls');
  assert.match(reply, /OPEN CALLS — 2/);
  assert.match(reply, /SAMBHV/, 'the long is listed');
  assert.match(reply, /OLECTRA/, 'the short is listed');
  assert.match(reply, /entry 101\.20 · SL 99\.80 · T 103\.50/, 'the numbers are the call\'s own');
  assert.match(reply, /OF_MOMENTUM/, 'the setup that produced the call is named');
  assert.match(reply, /GB03a/, 'a call from a different setup keeps its own name');
  assert.match(reply, /10:14:00 IST/, 'the scan that armed them is stamped');
});

test('an empty board ANSWERS THE QUESTION instead of showing a blank list', () => {
  const reply = inboxOf({
    engine: { getActiveCandidates: () => [], getScanFunnel: () => FUNNEL, getDailyNet: () => DAILY },
  }).handle('/calls');
  assert.match(reply, /OPEN CALLS — 0/);
  assert.match(reply, /Nothing armed/);
  assert.match(reply, /scanned 512 · in play 87 · qualified 0/, 'the funnel explains the silence');
  assert.match(reply, /long vwap 44/, 'the leading refusals are named, with counts');
});

test('/book reports the day\'s outcomes and net, in the same words as the page', () => {
  const reply = inboxOf().handle('/book');
  assert.match(reply, /calls 8 · open 2 · closed 6/);
  assert.match(reply, /won 3 · lost 1 · exited without a level 2/);
  assert.match(reply, /12\.40 pts/, 'net points are the engine\'s own total');
  assert.match(reply, /\+₹1240/);
  assert.match(reply, /NET POSITIVE/);
});

test('/status says whether alerts can send at all, and whether OF_MOMENTUM is armed', () => {
  const live = inboxOf().handle('/status');
  assert.match(live, /ACTIVE_TRADING/);
  assert.match(live, /signals open/);
  assert.match(live, /feed connected/);
  assert.match(live, /alerts configured/);
  assert.match(live, /OF_MOMENTUM armed · 3\/6 slots · 12\/session/);

  const off = inboxOf({
    engine: { ofMomentumLiveState: () => ({ armed: false, maxSlots: 3, maxPerSession: 12 }) },
    alerts: () => ({ configured: false, reason: 'bot token is valid but no chat is linked' }),
  }).handle('/status');
  assert.match(off, /alerts NOT configured/, 'a send that cannot happen is never reported as fine');
  assert.match(off, /no chat is linked/, 'and the reason names the missing piece');
  assert.match(off, /OF_MOMENTUM off/);
});

test('/why names the gate that refused, and the cap when it is the cap', () => {
  const reply = inboxOf().handle('/why');
  assert.match(reply, /as of 10:14:00 IST/);
  assert.match(reply, /GB03a: evaluated 494 · emitted 53 · refused 53/);
  assert.match(reply, /today 2\/12 · open 2\/3/);
  assert.match(reply, /1 refused by the cap/);
});

test('a command typed without the slash, or in a group, is still the same command', () => {
  const inbox = inboxOf();
  assert.match(inbox.handle('calls'), /OPEN CALLS — 2/);
  assert.match(inbox.handle('/calls@GBTerminalAlertsBot'), /OPEN CALLS — 2/);
  assert.equal(inbox.handle('/help'), HELP);
  assert.equal(inbox.handle(''), HELP);
  assert.match(inbox.handle('/nonsense'), /commands/, 'an unknown command gets the list, not silence');
});

test('a text that is not a board command is left for the other handler — null, not help text', () => {
  const inbox = inboxOf();
  // "holdings" and "pnl" belong to the older P&L handler; answering them with the command list
  // would replace that reply instead of adding one.
  assert.equal(inbox.maybeAnswer('holdings'), null);
  assert.equal(inbox.maybeAnswer('today pnl'), null);
  assert.equal(inbox.maybeAnswer(''), null);
  assert.match(inbox.maybeAnswer('/calls'), /OPEN CALLS/);
  assert.match(inbox.maybeAnswer('status'), /STATUS/);
});

test('a dependency that throws is reported, not posted as a stack trace', () => {
  const reply = inboxOf({
    engine: { getActiveCandidates: () => { throw new Error('book is locked'); } },
  }).handle('/calls');
  assert.match(reply, /OPEN CALLS — 0/, 'the command still answers with what it knows');
});

test("the poller does not replay the chat's history when the server starts", async () => {
  const sent = [];
  const calls = [];
  let n = 0;
  const transport = {
    async getUpdates(offset) {
      calls.push(offset);
      n += 1;
      if (n === 1) {
        // History exists: one old message the owner sent hours ago.
        return { updates: [{ update_id: 900, message: { text: '/calls', chat: { id: 7 } } }], nextOffset: 901 };
      }
      if (n === 2) {
        return { updates: [{ update_id: 901, message: { text: '/book', chat: { id: 7 } } }], nextOffset: 902 };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { updates: [], nextOffset: 902 };
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
  };
  const inbox = startInbox({ token: 'T', chatId: '7', inbox: inboxOf(), transport, pollMs: 5, logger: { log() {}, warn() {} } });
  await new Promise((r) => setTimeout(r, 40));
  await inbox.stop();
  assert.equal(sent.length, 1, 'exactly one reply — the old message was primed past, not answered');
  assert.match(sent[0].text, /TODAY'S BOOK/, 'and it answers the NEW command');
  assert.equal(sent[0].chatId, '7');
  assert.equal(calls[0], null, 'the first probe asks for the offset, not for messages');
});

test('another chat gets no reply — not even an error', async () => {
  const sent = [];
  let n = 0;
  const transport = {
    async getUpdates(offset) {
      n += 1;
      if (n === 1) return { updates: [], nextOffset: null };
      // A FRESH message, so the chat filter — not the history guard — is what refuses it.
      if (n === 2) return {
        updates: [{ update_id: 1, message: { text: '/calls', chat: { id: 999 }, date: Math.floor(Date.now() / 1000) } }],
        nextOffset: 2,
      };
      await new Promise((r) => setTimeout(r, 5));
      return { updates: [], nextOffset: 2 };
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); },
  };
  const inbox = startInbox({ token: 'T', chatId: '7', inbox: inboxOf(), transport, pollMs: 5, logger: { log() {}, warn() {} } });
  await new Promise((r) => setTimeout(r, 40));
  await inbox.stop();
  assert.equal(sent.length, 0, 'the owner\'s positions never leave for a stranger');
});

test('a failing poll backs off and the inbox keeps answering', async () => {
  const sent = [];
  let n = 0;
  const transport = {
    async getUpdates() {
      n += 1;
      if (n === 1) return { updates: [], nextOffset: null };     // the priming probe
      if (n === 2) throw new Error('ETIMEDOUT');
      if (n === 3) throw new Error('ETIMEDOUT');
      if (n === 4) return {
        updates: [{ update_id: 5, message: { text: '/status', chat: { id: 7 }, date: Math.floor(Date.now() / 1000) } }],
        nextOffset: 6,
      };
      await new Promise((r) => setTimeout(r, 5));
      return { updates: [], nextOffset: 6 };
    },
    async sendMessage(chatId, text) { sent.push(text); },
  };
  const inbox = startInbox({
    token: 'T', chatId: '7', inbox: inboxOf(), transport, pollMs: 5, retryMs: 5,
    logger: { log() {}, warn() {} },
  });
  // The first probe failed, so the poller must still be alive on the retry that follows.
  await new Promise((r) => setTimeout(r, 200));
  await inbox.stop();
  assert.ok(sent.length >= 1, 'a transient network failure does not silence the bot: ' + JSON.stringify(sent));
  assert.match(sent[0], /STATUS/);
});

test('no token means no poller, and the reason is logged rather than thrown', () => {
  const warned = [];
  const out = startInbox({ token: '', inbox: inboxOf(), logger: { log() {}, warn: (m) => warned.push(m) } });
  assert.equal(out, null);
  assert.match(warned.join(' '), /no bot token/);
});
