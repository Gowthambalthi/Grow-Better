/**
 * test/bracketOrder.test.js
 *
 * A press that buys without protecting is the failure this module exists to prevent, so the tests
 * pin the sequence rather than just the happy path: read the money, size, send the entry, wait for
 * the fill, attach the stop and the target. The two states worth being able to name are tested
 * explicitly — the entry refused (nothing live, nothing to clean up) and the entry LIVE with the
 * protection FAILED (something live and unguarded), because that second one is the state an
 * operator must never have to guess about.
 *
 * The broker, the GTT client, the clock and the sleep are all fakes, so the whole press runs with
 * no network, no session and no money.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { executeBracket, buildProtectionRule, geometry, cashFrom } = require('../common/risk/bracketOrder');

const LONG = {
  side: 'BUY', symbol: 'RELIANCE', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885',
  exchange: 'NSE', entry: 100, stop: 95, target: 110, productType: 'DELIVERY',
};

/** A broker that fills every order at its own limit price, and a GTT that always accepts. */
function happyDeps(overrides = {}) {
  const calls = { orders: [], rules: [] };
  return {
    calls,
    placeOrder: async (o) => { calls.orders.push(o); return { orderId: 'ORD-1' }; },
    getOrderBook: async () => [{ orderid: 'ORD-1', orderstatus: 'complete', fillqty: String(o0(calls)), averageprice: '100' }],
    getFunds: async () => ({ net: 50000, availablecash: 50000 }),
    gtt: { createRule: async (rule) => { calls.rules.push(rule); return { ruleId: 'GTT-9' }; } },
    sleep: async () => {},
    ...overrides,
  };
  function o0(c) { return c.orders.length ? c.orders[c.orders.length - 1].quantity : 0; }
}

test('a long is protected by a SELL OCO rule whose legs are the call\'s own stop and target', () => {
  const rule = buildProtectionRule({
    side: 'BUY', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885', exchange: 'NSE',
    quantity: 25, entry: 100, stop: 95, target: 110, productType: 'DELIVERY',
  });
  assert.equal(rule.transactiontype, 'SELL', 'a long is closed by selling it');
  assert.equal(rule.gttType, 'OCO', 'one leg firing must cancel the other');
  assert.equal(rule.quantity, 25);
  assert.equal(rule.stoploss.triggerprice, 95);
  assert.equal(rule.target.triggerprice, 110);
  assert.equal(rule.stoploss.quantity, 25, 'both legs cover the whole position');
  assert.equal(rule.target.quantity, 25);
});

test('a short is protected by a BUY-back OCO rule', () => {
  const rule = buildProtectionRule({
    side: 'SELL', tradingsymbol: 'RELIANCE-EQ', symboltoken: '2885', exchange: 'NSE',
    quantity: 10, entry: 100, stop: 105, target: 90, productType: 'DELIVERY',
  });
  assert.equal(rule.transactiontype, 'BUY', 'a short is closed by buying it back');
  assert.equal(rule.stoploss.triggerprice, 105);
  assert.equal(rule.target.triggerprice, 90);
});

test('the full press: read the money, size, send the entry, attach the bracket', async () => {
  const deps = happyDeps();
  const res = await executeBracket(deps, LONG);

  assert.equal(res.ok, true, JSON.stringify(res.problems || []));
  assert.equal(res.stage, 'done');
  assert.equal(res.capitalSource, 'rms', 'the balance must come from the live RMS read');
  assert.equal(res.entryOrder.orderId, 'ORD-1');

  // The whole balance is under the ₹3,000 floor only when it is; ₹50,000 is not, so the risk
  // budget binds: 1% of ₹50,000 is ₹500 over a ₹5 stop is 100 shares, capped by the money.
  assert.equal(res.sizing.allIn, false);
  assert.ok(res.quantity > 0, 'a quantity must be decided from the money, not guessed');

  assert.equal(deps.calls.rules.length, 1, 'exactly one protection rule');
  assert.equal(deps.calls.rules[0].gttType, 'OCO');
  assert.equal(deps.calls.rules[0].quantity, res.fill.quantity, 'the bracket must match what actually filled');
  assert.equal(res.protection.ok, true);
  assert.equal(res.protection.ruleId, 'GTT-9');
});

test('the quantity asked for is a ceiling, never a promise that outruns the money', async () => {
  const deps = happyDeps();
  // ₹2,500 is under the floor -> all-in = 25 shares. Asking for 100 must not buy 100.
  const res = await executeBracket(deps, { ...LONG, entry: 100, stop: 95, target: 110, quantity: 100, capital: 2500 });
  assert.equal(res.ok, true);
  assert.equal(res.sizing.allIn, true, '₹2,500 is below the ₹3,000 floor, so the whole balance is the position');
  assert.equal(res.quantity, 25, 'the money, not the request, decides the size');
  assert.equal(deps.calls.orders[0].quantity, 25);
});

test('a stop on the wrong side of the entry is refused before a rupee moves', async () => {
  const deps = happyDeps();
  const res = await executeBracket(deps, { ...LONG, stop: 105 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'geometry');
  assert.match(res.problems[0], /stop must be BELOW its entry/);
  assert.equal(deps.calls.orders.length, 0, 'nothing may be sent');
  assert.equal(deps.calls.rules.length, 0, 'no rule may exist');
});

test('a target on the wrong side is refused too', async () => {
  const res = await executeBracket(happyDeps(), { ...LONG, target: 90 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'geometry');
  assert.match(res.problems[0], /target must be ABOVE its entry/);
});

test('a long whose stop and target are crossed is refused', async () => {
  const res = await executeBracket(happyDeps(), { ...LONG, stop: 105, target: 95 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'geometry');
});

test('a refused entry names the broker\'s words and sends no protection', async () => {
  const deps = happyDeps({
    placeOrder: async () => { const e = new Error('RMS limit exceeded'); e.message = 'RMS limit exceeded'; throw e; },
  });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'rejected');
  assert.match(res.problems[0], /RMS limit exceeded/, "the broker's own reason, not a paraphrase");
  assert.equal(deps.calls.rules.length, 0, 'nothing was filled, so nothing needs protecting');
});

test('an entry that goes LIVE with the protection FAILED says so loudly, with the manual fix', async () => {
  const deps = happyDeps({
    gtt: { createRule: async () => { throw new Error('GTT rejected: quantity exceeds holding'); } },
  });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, false, 'a live unguarded position is NOT a success');
  assert.equal(res.stage, 'protection');
  assert.match(res.problems[0], /entry is LIVE but the stop and target are NOT attached/);
  assert.match(res.problems[1], /place it yourself/, 'the second problem is the manual instruction');
  assert.equal(res.protection.ok, false);
  assert.equal(res.entryOrder.orderId, 'ORD-1', 'the entry order id is still reported for the cleanup');
});

test('a balance that cannot buy one whole share is refused with the reason, not sized to zero', async () => {
  const deps = happyDeps({ getFunds: async () => ({ availablecash: 50 }) });
  const res = await executeBracket(deps, { ...LONG, entry: 100, stop: 95, target: 110, riskPct: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'sizing');
  assert.equal(deps.calls.orders.length, 0);
});

test('a NEGATIVE balance is named as the reason, not reported as an unreadable one', async () => {
  // This is the real shape Angel returned on 2026-10-19: availablecash -115.2885 with the account
  // fully utilised. Sizing from it can only be zero, and the operator has to be told the figure —
  // "no capital was available" reads like a broken connection and hides the number to act on.
  const deps = happyDeps({ getFunds: async () => ({ net: -115.2885, availablecash: -115.2885 }) });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'sizing');
  assert.equal(deps.calls.orders.length, 0, 'nothing is sent on an account with no cash');
  assert.equal(res.capitalSource, 'rms', 'the balance WAS read — it is the value that is the problem');
  assert.equal(res.cashAvailable, -115.29, 'the figure is reported, rounded like every other price');
  assert.match(res.problems[0], /available cash of ₹-115\.29/, 'the sentence carries the real number');
  assert.doesNotMatch(res.problems[0], /no capital was available/, 'that phrasing means "unknown", not "empty"');
});

test('a zero balance is refused the same way, and never falls through to the supplied quantity', async () => {
  const deps = happyDeps({ getFunds: async () => ({ availablecash: 0 }) });
  const res = await executeBracket(deps, { ...LONG, quantity: 5 });
  assert.equal(res.ok, false, 'a quantity typed by hand does not make the account solvent');
  assert.equal(res.stage, 'sizing');
  assert.equal(deps.calls.orders.length, 0);
  assert.match(res.problems[0], /available cash of ₹0/);
});

test('a SELL still goes out on an account with no cash — exiting must never be blocked', async () => {
  // The guard above refuses BUYs on an empty balance. A sell frees margin rather than consuming
  // it, so applying the same rule to it would trap an operator in a position they are closing.
  const deps = happyDeps({ getFunds: async () => ({ availablecash: -115.2885 }) });
  const res = await executeBracket(deps, {
    side: 'SELL', symbol: 'MOMSBELIEF', tradingsymbol: 'MOMSBELIEF-EQ', symboltoken: '1234',
    exchange: 'NSE', entry: 265.24, stop: 268.0, target: 259.0, quantity: 20, productType: 'INTRADAY',
  });
  assert.equal(res.ok, true, JSON.stringify(res.problems || []));
  assert.equal(deps.calls.orders.length, 1, 'the exit order is sent');
  assert.equal(deps.calls.orders[0].transactionType, 'SELL');
  assert.equal(deps.calls.orders[0].quantity, 20, 'the typed quantity is used when nothing can be sized');
});

test('an unreadable balance with nothing typed says so in words the operator can distinguish', async () => {
  const deps = happyDeps({ getFunds: async () => { throw new Error('session expired'); } });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, false);
  assert.equal(res.stage, 'sizing');
  assert.equal(res.capitalSource, null);
  assert.match(res.problems[0], /could not be read \(session expired\)/, 'the underlying error is kept');
  assert.equal(res.capital, null, 'no figure is invented for a balance that was never read');
});

test('with no balance readable, the supplied quantity is used and the sizing says why', async () => {
  const deps = happyDeps({ getFunds: async () => { throw new Error('session expired'); } });
  const res = await executeBracket(deps, { ...LONG, quantity: 7 });
  assert.equal(res.ok, true, 'a trade the operator sized by hand still goes');
  assert.equal(res.quantity, 7);
  assert.equal(res.capitalSource, null);
  assert.match(res.sizingNote, /quantity supplied/);
});

test('an explicitly supplied capital figure wins over the live RMS read', async () => {
  const deps = happyDeps();
  const res = await executeBracket(deps, { ...LONG, capital: 2500, quantity: 40 });
  assert.equal(res.capitalSource, 'supplied');
  assert.equal(res.quantity, 25, '₹2,500 at ₹100 is 25 shares even though 40 were asked for');
});

test('an unfilled entry still gets protection for the quantity it asked for', async () => {
  const deps = happyDeps({
    getOrderBook: async () => [{ orderid: 'ORD-1', orderstatus: 'open', fillqty: '0' }],
  });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, true, 'a resting limit still needs its bracket');
  assert.equal(res.fill.filled, false);
  assert.equal(deps.calls.rules[0].quantity, res.quantity, 'protected at the requested size, not zero');
});

test('a partially filled entry is protected for what actually filled', async () => {
  const deps = happyDeps({
    getOrderBook: async () => [{ orderid: 'ORD-1', orderstatus: 'complete', fillqty: '40', averageprice: '99.5' }],
  });
  const res = await executeBracket(deps, LONG);
  assert.equal(res.ok, true);
  assert.equal(deps.calls.rules[0].quantity, 40, 'the bracket matches the fill, not the ask');
  assert.equal(deps.calls.rules[0].stoploss.triggerprice, 95, 'the levels are the call\'s own');
});

test('cash is read from whichever shape the broker answered in', () => {
  assert.equal(cashFrom({ availablecash: 1234.5 }), 1234.5);
  assert.equal(cashFrom({ availableCash: 99 }), 99);
  assert.equal(cashFrom({ net: 42 }), 42);
  assert.equal(cashFrom(null), null);
  assert.equal(cashFrom({ availablecash: 'not a number' }), null);
});

test('the geometry helper reports every crossed level, not just the first', () => {
  const g = geometry('BUY', 100, 105, 90);
  assert.equal(g.ok, false);
  assert.equal(g.problems.length, 2, 'both the stop and the target are wrong, and both must be said');
});
