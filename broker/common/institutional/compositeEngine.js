/**
 * common/institutional/compositeEngine.js
 * AMFI Trend Bucketing, ADTV-Normalized Bulk Value, Delivery Z-Score & Composite Scoring Engine
 */

/**
 * Assigns AMFI Trend Bucket based on 1M and 3M weightage deltas
 * @param {number} weightage1mChange 1-month weightage change in percentage points
 * @param {number} weightage3mChange 3-month weightage change in percentage points
 * @returns {'strong'|'fresh'|'warning'|'exit'}
 */
function assignAmfiBucket(weightage1mChange, weightage3mChange) {
  const w1 = Number(weightage1mChange) || 0;
  const w3 = Number(weightage3mChange) || 0;

  if (w1 > 0 && w3 > 0) {
    return 'strong';   // Sustained accumulation & accelerating
  } else if (w1 > 0 && w3 <= 0) {
    return 'fresh';    // Early / just starting
  } else if (w1 <= 0 && w3 > 0) {
    return 'warning';  // Institutions trimming after a run (Exit-Watch)
  } else {
    return 'exit';     // Sustained institutional exit
  }
}

/**
 * Calculates Composite Conviction Score for a stock given ADTV-normalized bulk buying and delivery Z-score
 * @param {object} params
 * @param {number|null} params.bulkNetPctAdtv ADTV-normalized bulk net value (bulk_net_value / avg_daily_turnover)
 * @param {number|null} params.deliveryZScore Delivery Z-Score
 * @param {number} [params.w1=0.6] Bulk deal weight parameter
 * @param {number} [params.w2=0.4] Delivery Z-Score weight parameter (w2 = 1 - w1)
 * @returns {number|null} Composite score (-1.0 to +1.0) or null if data missing
 */
function calculateCompositeScore({ bulkNetPctAdtv = null, deliveryZScore = null, w1 = 0.6, w2 = 0.4 }) {
  const hasBulk = bulkNetPctAdtv != null && !isNaN(Number(bulkNetPctAdtv));
  const hasDelivery = deliveryZScore != null && !isNaN(Number(deliveryZScore));

  if (!hasBulk && !hasDelivery) {
    return null; // Both missing -> unranked
  }

  // Normalize component signals by clipping to [-3.0, +3.0] and scaling to [-1.0, +1.0]
  const normBulk = hasBulk ? Math.max(-1.0, Math.min(1.0, Number(bulkNetPctAdtv) / 3.0)) : 0;
  const normDeliv = hasDelivery ? Math.max(-1.0, Math.min(1.0, Number(deliveryZScore) / 3.0)) : 0;

  let score = 0;
  if (hasBulk && hasDelivery) {
    score = (w1 * normBulk) + (w2 * normDeliv);
  } else if (hasBulk) {
    score = normBulk; // Fallback: 100% bulk weight if delivery missing
  } else {
    score = normDeliv; // Fallback: 100% delivery weight if bulk missing
  }

  return Number(score.toFixed(3));
}

module.exports = {
  assignAmfiBucket,
  calculateCompositeScore
};
