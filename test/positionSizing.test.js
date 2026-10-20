/**
 * test/positionSizing.test.js
 *
 * POSITION SIZE HAS TWO HARD LIMITS AND A ROUNDING RULE. Each is pinned here on its own, because
 * the failure that matters is a size that is quietly too big: a quantity that honours the risk
 * budget while costing more than the account holds, or one rounded UP to reach a target size.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { sizePosition } = require('../common/risk/positionSizing');

test('the risk budget sets the size: 1% of ₹1,00,000 over a ₹5 stop is 200 shares', () => {
  const s = sizePosition({ entry: 100, stop: 95, capital: 100000, riskPct: 1 });
  assert.equal(s.ok, true);
  assert.equal(s.budgetInr, 1000, 'the budget must be 1% of capital');
  assert.equal(s.riskPerShare, 5);
  assert.equal(s.qty, 200);
  assert.equal(s.riskInr, 1000, 'the realised risk must equal the budget when the risk rule binds');
  assert.equal(s.binding, 'risk');
  assert.equal(s.notional, 20000);
  assert.ok(s.notional <= s.capital, 'the position must be payable from the capital');
});

test('the money available sets the size when it is the smaller limit', () => {
  // ₹1,000 of capital cannot buy 200 shares at ₹100, however small the risk budget is.
  const s = sizePosition({ entry: 100, stop: 99, capital: 1000, riskPct: 5 });
  assert.equal(s.ok, true);
  assert.equal(s.qtyByCapital, 10);
  assert.equal(s.qty, 10, 'capital is the binding limit here');
  assert.equal(s.binding, 'capital', 'and the row must SAY that, so a small size is explainable');
  assert.equal(s.notional, 1000);
  assert.ok(s.riskInr <= s.budgetInr, 'the size must never exceed the risk budget');
});

test('rounding is DOWN to whole lots, never up', () => {
  // ₹5 risk per share on a ₹1,000 budget = 200 shares, which is exactly 8 lots of 25.
  const exact = sizePosition({ entry: 100, stop: 95, capital: 100000, riskPct: 1, lotSize: 25 });
  assert.equal(exact.qty, 200);
  assert.equal(exact.qty % 25, 0);

  // A ₹4.90 stop gives 204.08 shares of budget — 8.16 lots. The order is 8 lots (200), never 225:
  // rounding UP would spend ₹1,102.50 of a ₹1,000 budget to reach a nicer quantity.
  const odd = sizePosition({ entry: 100, stop: 95.1, capital: 100000, riskPct: 1, lotSize: 25 });
  assert.equal(odd.qty, 200, 'a partial lot must be dropped, not rounded up');
  assert.equal(odd.qty % 25, 0, 'a quantity must be a whole number of lots');
  assert.ok(odd.riskInr <= odd.budgetInr, 'lot rounding must not break the risk budget');
});

test('an unaffordable trade is refused with a reason, not sized to zero silently', () => {
  const s = sizePosition({ entry: 5000, stop: 4900, capital: 1000, riskPct: 1 });
  assert.equal(s.ok, false);
  assert.equal(s.qty, 0);
  assert.match(s.reason, /capital cannot buy one share/);
  assert.equal(s.affordable, false);
});

test('a risk budget below one share of risk is refused, and says so', () => {
  // ₹5 of risk against a ₹10 stop distance: even one share would breach the budget.
  const s = sizePosition({ entry: 100, stop: 90, capital: 100000, riskInr: 5 });
  assert.equal(s.ok, false);
  assert.equal(s.qty, 0);
  assert.match(s.reason, /smaller than one share/);
});

test('the exposure cap binds when the stop is very tight', () => {
  // ₹1 risk per share, 1% of ₹1,00,000 = 1,000 shares = ₹1,00,000 notional; cap at 25% -> 250.
  const s = sizePosition({ entry: 100, stop: 99, capital: 100000, riskPct: 1, maxNotionalPct: 25 });
  assert.equal(s.qty, 250);
  assert.equal(s.binding, 'exposure');
  assert.ok(s.notional <= 25000);
});

test('an explicit rupee risk overrides the percentage', () => {
  const s = sizePosition({ entry: 250, stop: 240, capital: 50000, riskPct: 5, riskInr: 500 });
  assert.equal(s.budgetInr, 500, 'the typed rupee amount wins over 5% of capital');
  assert.equal(s.qty, 50);
  assert.equal(s.riskInr, 500);
});

test('missing or contradictory inputs are refused with a specific reason', () => {
  assert.match(sizePosition({ entry: 0, stop: 10, capital: 1000, riskPct: 1 }).reason, /entry price/);
  assert.match(sizePosition({ entry: 100, stop: 0, capital: 1000, riskPct: 1 }).reason, /stop price/);
  assert.match(sizePosition({ entry: 100, stop: 100, capital: 1000, riskPct: 1 }).reason, /zero risk/);
  assert.match(sizePosition({ entry: 100, stop: 90, capital: 0, riskPct: 1 }).reason, /no capital/);
  // The budget is still demanded ABOVE the all-in floor — the refusal only stops applying
  // below it, where the whole balance is the size by rule.
  assert.match(sizePosition({ entry: 100, stop: 90, capital: 25000 }).reason, /no risk budget/);
});

test('below ₹3,000 the whole balance is the position and no budget is needed', () => {
  // The rule this pins: a small account cannot express risk as a percent (1% of ₹2,500 is
  // ₹25, which buys nothing), so under the floor the money available is the only limit.
  const s = sizePosition({ entry: 100, stop: 99, capital: 2500 });
  assert.equal(s.ok, true, 'no risk % was supplied and none is required under the floor');
  assert.equal(s.allIn, true);
  assert.equal(s.qtyByCapital, 25);
  assert.equal(s.qty, 25, 'the whole balance buys as many whole shares as it can');
  assert.equal(s.notional, 2500, 'every rupee available is deployed');
  assert.ok(s.notional <= s.capital);
  assert.equal(s.binding, 'capital', 'money is still what capped it — all-in only waives the risk rule');
  assert.match(s.note, /all-in/);
});

test('above ₹3,000 the risk budget binds again and all-in does not apply', () => {
  // ₹4,000 available, 1% = ₹40 budget, ₹2 risk/share -> 20 shares (₹400), NOT the whole ₹4,000.
  const s = sizePosition({ entry: 100, stop: 98, capital: 4000, riskPct: 1 });
  assert.equal(s.ok, true);
  assert.equal(s.allIn, false, 'the floor is ₹3,000 — this account is above it');
  assert.equal(s.qty, 20);
  assert.equal(s.riskInr, 40, 'the realised risk must equal the budget when the risk rule binds');
  assert.equal(s.binding, 'risk');
});

test('all-in is the same size with or without a budget, and respects the lot', () => {
  const withBudget = sizePosition({ entry: 100, stop: 95, capital: 2500, riskPct: 1 });
  const withoutBudget = sizePosition({ entry: 100, stop: 95, capital: 2500 });
  assert.equal(withBudget.qty, withoutBudget.qty, 'a budget under the floor must not shrink the size');
  assert.equal(withoutBudget.qty, 25);

  // A lot bigger than one share still rounds DOWN — ₹2,500 at ₹100 is 25 shares = 5 lots of 5,
  // and a balance that cannot buy a whole lot is refused rather than borrowed up to.
  const lotted = sizePosition({ entry: 100, stop: 95, capital: 2500, lotSize: 5 });
  assert.equal(lotted.qty, 25);
  assert.equal(lotted.qty % 5, 0);
  const tooSmall = sizePosition({ entry: 100, stop: 95, capital: 2400, lotSize: 25 });
  assert.equal(tooSmall.ok, false, '24 shares cannot make a 25-share lot — refuse, never round up');
  assert.match(tooSmall.reason, /costs more than the balance/);
});

test('the floor is a parameter, so a caller can move or disable it', () => {
  // Move it down: ₹2,500 is now above the floor, so the budget is demanded.
  assert.match(sizePosition({ entry: 100, stop: 95, capital: 2500, allInBelowInr: 2000 }).reason, /no risk budget/);
  // Move it up: ₹9,000 is now under it and sizes all-in with no budget.
  const s = sizePosition({ entry: 100, stop: 95, capital: 9000, allInBelowInr: 10000 });
  assert.equal(s.allIn, true);
  assert.equal(s.qty, 90);
  // Disable it with 0: no capital is ever all-in, the old behaviour for every balance.
  assert.equal(sizePosition({ entry: 100, stop: 95, capital: 2500, allInBelowInr: 0 }).allIn, false);
});

test('a short is sized from the same absolute distance as a long', () => {
  const long = sizePosition({ entry: 100, stop: 95, capital: 100000, riskPct: 1, side: 'LONG' });
  const short = sizePosition({ entry: 100, stop: 105, capital: 100000, riskPct: 1, side: 'SHORT' });
  assert.equal(short.riskPerShare, long.riskPerShare, 'a stop 5 above entry risks the same as 5 below');
  assert.equal(short.qty, long.qty);
  assert.equal(short.riskInr, long.riskInr);
});
