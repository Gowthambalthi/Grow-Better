/**
 * common/market/camarilla.js — Camarilla pivot engine.
 *
 * Pivots from the PRIOR session's high/low/close:
 *   R4 = C + (H-L) * 1.1/2     — breakout level (above = strong trend day)
 *   R3 = C + (H-L) * 1.1/4     — resistance; close above R3 = bullish breakout
 *   S3 = C - (H-L) * 1.1/4     — support; close below S3 = bearish breakdown
 *   S4 = C - (H-L) * 1.1/2     — breakdown level
 * Classic intraday read: price between S3-R3 = mean-revert range day;
 * outside R3/S3 = trend day — fade setups near R3/S3 lose their edge.
 *
 * Pure functions — used by both the backtest and the live engine.
 */

function calcCamarillaPivots(prevHigh, prevLow, prevClose) {
  const range = prevHigh - prevLow;
  if (!(range > 0) || !(prevClose > 0)) return null;
  return {
    r4: prevClose + range * 1.1 / 2,
    r3: prevClose + range * 1.1 / 4,
    s3: prevClose - range * 1.1 / 4,
    s4: prevClose - range * 1.1 / 2,
    prevHigh, prevLow, prevClose,
  };
}

/**
 * Camarilla context for the current price:
 *   zone: 'ABOVE_R4' | 'ABOVE_R3' | 'IN_RANGE' | 'BELOW_S3' | 'BELOW_S4'
 *   pctToR3 / pctToS3: % distance to the nearest breakout levels
 * For a LONG: IN_RANGE near S3 (bounce zone) is good; ABOVE_R3 = trend day,
 * chasing mid-range is weak. For a SHORT mirrored.
 */
function camarillaContext(price, piv) {
  if (!piv || !(price > 0)) return null;
  let zone;
  if (price > piv.r4) zone = 'ABOVE_R4';
  else if (price > piv.r3) zone = 'ABOVE_R3';
  else if (price < piv.s4) zone = 'BELOW_S4';
  else if (price < piv.s3) zone = 'BELOW_S3';
  else zone = 'IN_RANGE';
  return {
    zone,
    pctToR3: +(((piv.r3 - price) / price) * 100).toFixed(2),
    pctToS3: +(((price - piv.s3) / price) * 100).toFixed(2),
    r3: +piv.r3.toFixed(2), r4: +piv.r4.toFixed(2),
    s3: +piv.s3.toFixed(2), s4: +piv.s4.toFixed(2),
  };
}

/** Prior-session OHLC from a bar list keyed by date prefix. bars = [[ts,o,h,l,c,v]] */
function priorSession(bars, dateStr) {
  let prev = null;
  for (const b of bars) {
    const d = String(b[0]).slice(0, 10);
    if (d >= dateStr) break;
    prev = d;
  }
  return prev; // last session date before dateStr
}

module.exports = { calcCamarillaPivots, camarillaContext, priorSession };
