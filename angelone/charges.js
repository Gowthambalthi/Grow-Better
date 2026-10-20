/**
 * angelone/charges.js
 *
 * Angel One's own published charge structure (as of Aug 2026). These are
 * publicly documented rates, not pulled from an account-specific API —
 * Angel One does have a "Brokerage Calculator API" for exact per-trade
 * figures (apiconnect.angelbroking.com, needs an orderid), but that only
 * works after a trade has actually executed. This module estimates
 * charges from trade details alone (works for both manual backfill and
 * live trades) using their published rate card. Verify against your
 * actual contract note if this needs to be precise for tax purposes —
 * rates change periodically and these constants will drift out of date.
 * Sources: angelone.in/calculators/brokerage-calculator,
 *          angelone.in/margin-trading-facility
 */

const RATES = {
  // Brokerage
  //
  // EQUITY DELIVERY IS NO LONGER FREE. Angel One revised this rate card in Oct 2024: delivery is now
  // charged exactly like intraday — the lower of ₹20 or 0.1% of trade value per EXECUTED ORDER, with a
  // ₹5 minimum. The old `DELIVERY_BROKERAGE: 0` under-reported every delivery and MTF trade by up to
  // ₹23.60 per leg (₹20 + 18% GST) — and this module feeds real ledger and portfolio P&L, not just
  // backtests, so those numbers were wrong in the optimistic direction. Source (checked 2026-09-28):
  // angelone.in/exchange-transaction-charges and angelone.in/calculators/brokerage-calculator, both of
  // which list delivery as "lower of ₹20 or 0.1% per executed order, minimum ₹5".
  DELIVERY_BROKERAGE_PCT: 0.001,            // 0.1% of trade value
  DELIVERY_BROKERAGE_CAP: 20,               // ...or ₹20, whichever is lower
  DELIVERY_BROKERAGE_MIN: 5,                // minimum ₹5 per executed order
  INTRADAY_BROKERAGE_PCT: 0.001,            // 0.1% of trade value
  INTRADAY_BROKERAGE_CAP: 20,               // ...or ₹20, whichever is lower
  INTRADAY_BROKERAGE_MIN: 5,                // minimum ₹5 per order
  FNO_COMMODITY_BROKERAGE_FLAT: 20,         // flat ₹20 per executed order

  // STT/CTT
  STT_DELIVERY_PCT: 0.001,                  // 0.1% on BOTH buy and sell value
  STT_INTRADAY_SELL_PCT: 0.00025,           // 0.025% on sell value only
  STT_FUTURES_PCT: 0.000125,                // 0.0125% of turnover
  STT_OPTIONS_SELL_PCT: 0.000625,           // 0.0625% of premium, sell side only

  // Exchange transaction charges (NSE equity, approximate — exchanges
  // revise these periodically)
  EXCHANGE_TXN_PCT: 0.0000297,              // ~0.00297%

  // Stamp duty (uniform pan-India since July 2020, buy side only)
  STAMP_DUTY_DELIVERY_PCT: 0.00015,         // 0.015%
  STAMP_DUTY_INTRADAY_PCT: 0.00003,         // 0.003%
  STAMP_DUTY_FNO_PCT: 0.00002,              // 0.002%

  SEBI_FEES_PCT: 0.0000001,                 // ₹10 per crore = 0.0001%... expressed per-rupee: 0.0000001
  GST_PCT: 0.18,                            // on (brokerage + exchange txn charges + SEBI fees)

  DP_CHARGE_PER_SELL_SCRIP: 20,             // approx, + GST, charged once per scrip per sell day

  MTF_INTEREST_PCT_PER_DAY: 0.00041,        // 0.041%/day ≈ 15% p.a.
};

/**
 * @param {object} trade { transactionType: 'BUY'|'SELL', productType: 'DELIVERY'|'INTRADAY'|'MARGIN', quantity, price }
 * @returns {object} breakdown + total
 */
function calculateTradeCharges(trade) {
  const { transactionType, productType, quantity, price } = trade;
  const value = quantity * price;
  const isBuy = transactionType === 'BUY';
  const isDelivery = productType === 'DELIVERY' || productType === 'MARGIN'; // MTF settles as delivery
  const isIntraday = productType === 'INTRADAY';

  let brokerage = 0;
  if (isDelivery) {
    // Same tiered rule as intraday since the Oct-2024 revision (min ₹5, cap ₹20, 0.1% of value).
    brokerage = Math.max(RATES.DELIVERY_BROKERAGE_MIN, Math.min(RATES.DELIVERY_BROKERAGE_CAP, value * RATES.DELIVERY_BROKERAGE_PCT));
  } else if (isIntraday) {
    brokerage = Math.max(RATES.INTRADAY_BROKERAGE_MIN, Math.min(RATES.INTRADAY_BROKERAGE_CAP, value * RATES.INTRADAY_BROKERAGE_PCT));
  } else {
    brokerage = RATES.FNO_COMMODITY_BROKERAGE_FLAT;
  }

  let stt = 0;
  if (isDelivery) {
    stt = value * RATES.STT_DELIVERY_PCT; // charged on both buy and sell for delivery
  } else if (isIntraday && !isBuy) {
    stt = value * RATES.STT_INTRADAY_SELL_PCT; // sell side only
  }
  // F&O STT not covered here — this module is written for equity/MTF/MCX cash-style trades.

  const exchangeTxnCharges = value * RATES.EXCHANGE_TXN_PCT;
  const sebiFees = value * RATES.SEBI_FEES_PCT;
  const gst = RATES.GST_PCT * (brokerage + exchangeTxnCharges + sebiFees);

  let stampDuty = 0;
  if (isBuy) {
    stampDuty = value * (isDelivery ? RATES.STAMP_DUTY_DELIVERY_PCT : RATES.STAMP_DUTY_INTRADAY_PCT);
  }

  const dpCharges = !isBuy && isDelivery ? RATES.DP_CHARGE_PER_SELL_SCRIP * (1 + RATES.GST_PCT) : 0;

  const total = brokerage + stt + exchangeTxnCharges + sebiFees + gst + stampDuty + dpCharges;

  return {
    tradeValue: value,
    brokerage,
    stt,
    exchangeTxnCharges,
    sebiFees,
    gst,
    stampDuty,
    dpCharges,
    totalCharges: total,
  };
}

/**
 * @param {number} borrowedAmount amount funded by the broker (MTF)
 * @param {number} daysHeld days since T+1 of the buy date
 */
function calculateMtfInterest(borrowedAmount, daysHeld) {
  const days = Math.max(0, daysHeld);
  return borrowedAmount * RATES.MTF_INTEREST_PCT_PER_DAY * days;
}

module.exports = { RATES, calculateTradeCharges, calculateMtfInterest };