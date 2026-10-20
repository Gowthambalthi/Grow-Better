'use strict';

/**
 * Charges parity tests. These exist because `DELIVERY_BROKERAGE: 0` was stale: Angel One revised its
 * rate card in Oct 2024 to charge equity delivery the same as intraday (lower of ₹20 or 0.1% per
 * executed order, minimum ₹5). This module feeds the ledger and portfolio P&L, so a zero here made
 * every delivery/MTF trade look cheaper than it was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { RATES, calculateTradeCharges, calculateMtfInterest } = require('../angelone/charges');

const DELIVERY_BUY = (value) => calculateTradeCharges({
  transactionType: 'BUY', productType: 'DELIVERY', quantity: 1, price: value,
});
const DELIVERY_SELL = (value) => calculateTradeCharges({
  transactionType: 'SELL', productType: 'DELIVERY', quantity: 1, price: value,
});

test('delivery brokerage is no longer zero', () => {
  assert.equal(RATES.DELIVERY_BROKERAGE, undefined, 'the stale ₹0 constant must be gone, not merely unused');
  assert.ok(DELIVERY_BUY(100000).brokerage > 0, 'a ₹1,00,000 delivery trade cannot be free');
});

test('delivery follows the tiered rule: 0.1% of value, capped at ₹20', () => {
  // ₹1,00,000 * 0.1% = ₹100 -> capped to ₹20.
  assert.equal(DELIVERY_BUY(100000).brokerage, 20);
  // ₹10,000 * 0.1% = ₹10, under the cap.
  assert.equal(DELIVERY_BUY(10000).brokerage, 10);
});

test('delivery has a ₹5 floor, which binds on small trades', () => {
  // ₹1,000 * 0.1% = ₹1 -> floored to ₹5.
  assert.equal(DELIVERY_BUY(1000).brokerage, RATES.DELIVERY_BROKERAGE_MIN);
  assert.equal(DELIVERY_BUY(1000).brokerage, 5);
});

test('the floor and cap are exactly the documented Angel One figures', () => {
  assert.equal(RATES.DELIVERY_BROKERAGE_MIN, 5);
  assert.equal(RATES.DELIVERY_BROKERAGE_CAP, 20);
  assert.equal(RATES.DELIVERY_BROKERAGE_PCT, 0.001);
});

test('intraday keeps its own identical tier (unchanged by the delivery fix)', () => {
  const intraday = calculateTradeCharges({ transactionType: 'BUY', productType: 'INTRADAY', quantity: 1, price: 100000 });
  assert.equal(intraday.brokerage, 20);
  const small = calculateTradeCharges({ transactionType: 'BUY', productType: 'INTRADAY', quantity: 1, price: 1000 });
  assert.equal(small.brokerage, 5);
});

test('a round trip now pays brokerage on BOTH delivery legs', () => {
  // Per executed order, so a ₹50,000 delivery buy and sell cost 2 x ₹20, not 2 x ₹0.
  const value = 50000;
  const roundTrip = DELIVERY_BUY(value).brokerage + DELIVERY_SELL(value).brokerage;
  assert.equal(roundTrip, 40);
});

test('delivery pays STT on both legs while intraday pays it on the sell leg only', () => {
  const buy = DELIVERY_BUY(100000);
  const sell = DELIVERY_SELL(100000);
  assert.equal(buy.stt, 100);                       // 0.1% of value
  assert.equal(sell.stt, 100);
  const intradayBuy = calculateTradeCharges({ transactionType: 'BUY', productType: 'INTRADAY', quantity: 1, price: 100000 });
  assert.equal(intradayBuy.stt, 0);
});

test('stamp duty is buy-side only, and delivery pays the higher rate', () => {
  const near = (got, want) => Math.abs(got - want) < 1e-9;   // 100000 * 0.00015 is 14.999999999999998
  assert.equal(DELIVERY_SELL(100000).stampDuty, 0);
  assert.ok(near(DELIVERY_BUY(100000).stampDuty, 15), 'delivery: 0.015% of value');
  const intradayBuy = calculateTradeCharges({ transactionType: 'BUY', productType: 'INTRADAY', quantity: 1, price: 100000 });
  assert.ok(near(intradayBuy.stampDuty, 3), 'intraday: 0.003% of value');
});

test('DP charge applies to a delivery sell only, and carries GST', () => {
  const near = (got, want) => Math.abs(got - want) < 1e-9;
  assert.equal(DELIVERY_BUY(100000).dpCharges, 0);
  assert.ok(near(DELIVERY_SELL(100000).dpCharges, RATES.DP_CHARGE_PER_SELL_SCRIP * 1.18));
});

test('GST is 18% of brokerage + exchange charges + SEBI fees', () => {
  const t = DELIVERY_BUY(100000);
  const base = t.brokerage + t.exchangeTxnCharges + t.sebiFees;
  assert.ok(Math.abs(t.gst - base * RATES.GST_PCT) < 1e-9, `gst ${t.gst} should be 18% of ${base}`);
});

test('totalCharges is the sum of its parts (no silent component)', () => {
  const t = DELIVERY_SELL(100000);
  const sum = t.brokerage + t.stt + t.exchangeTxnCharges + t.sebiFees + t.gst + t.stampDuty + t.dpCharges;
  assert.ok(Math.abs(t.totalCharges - sum) < 1e-9);
});

test('MTF interest accrues per day and never goes negative', () => {
  assert.equal(calculateMtfInterest(100000, 0), 0);
  assert.equal(calculateMtfInterest(100000, 10), Number((100000 * RATES.MTF_INTEREST_PCT_PER_DAY * 10).toFixed(10)));
  assert.equal(calculateMtfInterest(100000, -5), 0, 'a negative holding period must not credit interest');
});
