/**
 * grow/charges.js
 *
 * Groww's own published charge structure (as of Aug 2026, post their
 * June 2025 revision). Unlike Angel One, Groww does NOT offer free
 * equity delivery — same brokerage formula applies to delivery and
 * intraday. Verify against your actual contract note for anything
 * tax-sensitive — these are publicly published rates and will drift
 * out of date as Groww revises pricing.
 * Sources: groww.in/pricing, groww.in/help (pricing articles),
 *          business-standard.com (June 2025 fee revision article)
 */

const RATES = {
  // Brokerage — same formula for delivery AND intraday (Groww doesn't
  // waive delivery brokerage the way Angel One does)
  BROKERAGE_PCT: 0.001,                     // 0.1% of trade value
  BROKERAGE_CAP: 20,                        // ...or ₹20, whichever is lower
  BROKERAGE_MIN: 5,                         // minimum ₹5 per order (raised from ₹2, June 2025)
  FNO_BROKERAGE_FLAT: 20,                   // flat ₹20 per executed order

  // STT/CTT — same statutory rates as the rest of the industry
  STT_DELIVERY_PCT: 0.001,                  // 0.1% on BOTH buy and sell value
  STT_INTRADAY_SELL_PCT: 0.00025,           // 0.025% on sell value only
  STT_FUTURES_PCT: 0.000125,
  STT_OPTIONS_SELL_PCT: 0.000625,

  EXCHANGE_TXN_PCT: 0.0000297,              // ~0.00297%, NSE equity approx

  STAMP_DUTY_DELIVERY_PCT: 0.00015,         // 0.015%, uniform pan-India, buy side only
  STAMP_DUTY_INTRADAY_PCT: 0.00003,

  SEBI_FEES_PCT: 0.0000001,                 // ₹10 per crore
  GST_PCT: 0.18,                            // on (brokerage + exchange charges + SEBI + DP) — NOT on STT/stamp duty

  DP_CHARGE_PER_SELL: 20,                   // ₹20 per sell transaction (raised from ₹18.5/day/stock, June 2025)

  // MTF interest is tiered by funded amount (per the June 2025 revision) —
  // most retail positions fall in the first tier.
  MTF_INTEREST_PCT_PER_ANNUM_UNDER_25L: 0.1495, // 14.95% p.a. for funded amount < ₹25L
  MTF_INTEREST_PCT_PER_ANNUM_OVER_25L: 0.0975,  // 9.75% p.a. for funded amount >= ₹25L
  MTF_TIER_THRESHOLD: 2500000,
};

/**
 * @param {object} trade { transactionType: 'BUY'|'SELL', productType: 'DELIVERY'|'INTRADAY'|'MARGIN', quantity, price }
 */
function calculateTradeCharges(trade) {
  const { transactionType, productType, quantity, price } = trade;
  const value = quantity * price;
  const isBuy = transactionType === 'BUY';
  const isDelivery = productType === 'DELIVERY' || productType === 'MARGIN'; // MTF settles as delivery
  const isIntraday = productType === 'INTRADAY';

  let brokerage;
  if (isDelivery || isIntraday) {
    brokerage = Math.max(RATES.BROKERAGE_MIN, Math.min(RATES.BROKERAGE_CAP, value * RATES.BROKERAGE_PCT));
  } else {
    brokerage = RATES.FNO_BROKERAGE_FLAT;
  }

  let stt = 0;
  if (isDelivery) {
    stt = value * RATES.STT_DELIVERY_PCT;
  } else if (isIntraday && !isBuy) {
    stt = value * RATES.STT_INTRADAY_SELL_PCT;
  }

  const exchangeTxnCharges = value * RATES.EXCHANGE_TXN_PCT;
  const sebiFees = value * RATES.SEBI_FEES_PCT;
  const dpCharges = !isBuy && isDelivery ? RATES.DP_CHARGE_PER_SELL : 0;
  const gst = RATES.GST_PCT * (brokerage + exchangeTxnCharges + sebiFees + dpCharges);

  let stampDuty = 0;
  if (isBuy) {
    stampDuty = value * (isDelivery ? RATES.STAMP_DUTY_DELIVERY_PCT : RATES.STAMP_DUTY_INTRADAY_PCT);
  }

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
 * @param {number} borrowedAmount amount funded by Groww (MTF)
 * @param {number} daysHeld days since T+1 of the buy date
 */
function calculateMtfInterest(borrowedAmount, daysHeld) {
  const days = Math.max(0, daysHeld);
  const annualRate = borrowedAmount >= RATES.MTF_TIER_THRESHOLD
    ? RATES.MTF_INTEREST_PCT_PER_ANNUM_OVER_25L
    : RATES.MTF_INTEREST_PCT_PER_ANNUM_UNDER_25L;
  const dailyRate = annualRate / 365;
  return borrowedAmount * dailyRate * days;
}

module.exports = { RATES, calculateTradeCharges, calculateMtfInterest };