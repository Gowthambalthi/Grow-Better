/**
 * test/telegramApprovals.test.js
 *
 * The transport's pure half — how a button is encoded, who is allowed to press it, and what the
 * message promises. The network half is deliberately not tested here; what matters before a rupee
 * moves is that a stranger's tap is DROPPED and that the text cannot describe a different order
 * from the one the approval carries.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callbackData, parseCallbackData, parseTextCommand, isAllowedChat, proposalText, keyboard,
} = require('../common/notifications/telegramApprovals');

const APPROVAL = {
  id: 'BA1X2',
  expiresAt: Date.now() + 120000,
  proposal: {
    symbol: 'BANKINDIA', side: 'BUY', entry: 135.49, stop: 134.74, target: 136.61,
    quantity: 8, capital: 1115.0,
  },
};

test('a button round-trips to exactly one decision', () => {
  assert.deepEqual(parseCallbackData(callbackData('BA1X2', 'approve')), { id: 'BA1X2', decision: 'approve' });
  assert.deepEqual(parseCallbackData(callbackData('BA1X2', 'cancel')), { id: 'BA1X2', decision: 'cancel' });
});

test('anything that is not our callback is ignored rather than guessed at', () => {
  for (const junk of ['', null, 'yes', 'ord:', 'ord:BA1X2', 'ord:BA1X2:maybe', 'settings:1', 'ord:ba1x2:yes']) {
    assert.equal(parseCallbackData(junk), null, 'rejected: ' + JSON.stringify(junk));
  }
});

test('a tap from any chat but the configured one is refused', () => {
  assert.equal(isAllowedChat(555, '555'), true);
  assert.equal(isAllowedChat(555, 555), true, 'a numeric chat id must match its string form');
  assert.equal(isAllowedChat(999, '555'), false, 'a stranger must not be able to buy');
  assert.equal(isAllowedChat(555, ''), false, 'an unconfigured chat authorizes nobody');
  assert.equal(isAllowedChat(555, null), false);
});

test('typed replies work, with or without the id', () => {
  assert.deepEqual(parseTextCommand('yes BA1X2'), { decision: 'approve', id: 'BA1X2' });
  assert.deepEqual(parseTextCommand('No ba1x2'), { decision: 'cancel', id: 'BA1X2' });
  assert.deepEqual(parseTextCommand('yes'), { decision: 'approve', id: null });
  assert.deepEqual(parseTextCommand('approve'), { decision: 'approve', id: null });
  assert.equal(parseTextCommand('what is the price'), null);
  assert.equal(parseTextCommand(''), null);
});

test('the message states the order it will place, including size and both legs', () => {
  const text = proposalText(APPROVAL);
  assert.match(text, /BUY/);
  assert.match(text, /BANKINDIA/);
  assert.match(text, /Quantity: <b>8<\/b>/);
  assert.match(text, /₹135\.49/, 'entry is shown');
  assert.match(text, /₹134\.74/, 'stop is shown');
  assert.match(text, /₹136\.61/, 'target is shown');
  // 1.12 reward over 0.75 risk is 1.49 on THIS proposal; the point is that it is derived from the
  // same numbers the message prints, not copied from the call's own label.
  assert.match(text, /R:R 1:1\.49/, 'the reward-to-risk is derived from the same numbers');
  assert.match(text, /₹1,115\.00|₹1115\.00/, 'the balance the size came from is shown');
  assert.match(text, /re-checked against the live balance/);
  assert.match(text, /BA1X2/, 'the id is on the message so a typed reply can name it');
});

test('a sell is labelled as a sell and uses the short geometry', () => {
  const text = proposalText({
    id: 'SE1', expiresAt: Date.now() + 60000,
    proposal: { symbol: 'INFY', side: 'SELL', entry: 1148.75, stop: 1152.43, target: 1141.28, quantity: 3 },
  });
  assert.match(text, /SELL INFY/);
  assert.match(text, /₹3\.68/, 'risk is the absolute distance from 1148.75 to 1152.43, not a negative number');
});

test('both buttons are present and carry the approval id', () => {
  const kb = keyboard(APPROVAL).inline_keyboard.flat();
  assert.equal(kb.length, 2);
  assert.equal(kb[0].callback_data, 'ord:BA1X2:yes');
  assert.equal(kb[1].callback_data, 'ord:BA1X2:no');
});
