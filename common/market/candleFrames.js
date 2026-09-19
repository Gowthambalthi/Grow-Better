/**
 * common/market/candleFrames.js — multi-timeframe candle-structure engine.
 *
 * Aggregates the live 1-min series into 3 / 5 / 15 / 30-min candles and reads
 * pure price-action structure on each timeframe:
 *   trend      — higher-highs/higher-lows over the last ~8 candles of the TF
 *   pattern    — bullish/bearish engulfing, hammer, shooting star, doji on
 *                the latest candle of the TF
 *   wickRead   — rejection wick on the last candle (lower wick = buyers
 *                defending, upper wick = sellers pressing)
 *   agree      — UP / DOWN / MIXED across the four TFs
 *
 * Pure function over the same bars fetchIntradaySeries already returns —
 * no extra network calls.
 */

const TF_MINUTES = [3, 5, 15, 30];

function aggregate(bars, minutes) {
  if (!bars || bars.length < minutes) return [];
  const bucketMs = minutes * 60000;
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / bucketMs) * bucketMs;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: b.o ?? b.c, h: b.h ?? b.c, l: b.l ?? b.c, c: b.c, v: b.v || 0 };
    } else {
      cur.h = Math.max(cur.h, b.h ?? b.c);
      cur.l = Math.min(cur.l, b.l ?? b.c);
      cur.c = b.c;
      cur.v += b.v || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function classify(candles) {
  if (!candles || candles.length < 5) return null;
  const last = candles[candles.length - 1];
  const range = (last.h - last.l);
  const body = Math.abs(last.c - last.o);
  const lowerWick = Math.min(last.c, last.o) - last.l;
  const upperWick = last.h - Math.max(last.c, last.o);

  // pattern on the latest candle
  let pattern = 'NONE';
  if (range > 0) {
    if (body / range <= 0.1) pattern = 'DOJI';
    else if (lowerWick > body * 2 && upperWick < body) pattern = 'HAMMER';
    else if (upperWick > body * 2 && lowerWick < body) pattern = 'SHOOTING STAR';
  }
  const prev = candles[candles.length - 2];
  if (prev) {
    if (last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c) pattern = 'BULL ENGULF';
    else if (last.c < last.o && prev.c > prev.o && last.c <= prev.o && last.o >= prev.c) pattern = 'BEAR ENGULF';
  }

  // trend over last 8 candles: higher lows + higher highs = UP
  const seg = candles.slice(-8);
  let hh = 0, hl = 0, lh = 0, ll = 0;
  for (let i = 1; i < seg.length; i++) {
    if (seg[i].h > seg[i - 1].h) hh++; else lh++;
    if (seg[i].l > seg[i - 1].l) hl++; else ll++;
  }
  const trend = (hh >= seg.length * 0.5 && hl >= seg.length * 0.5) ? 'UP'
    : (lh >= seg.length * 0.5 && ll >= seg.length * 0.5) ? 'DOWN'
    : (hl > ll) ? 'UP-LEAN' : (ll > hl) ? 'DOWN-LEAN' : 'SIDEWAYS';

  // wick read on last candle
  const wickRead = range > 0
    ? (lowerWick > range * 0.4) ? 'LOWER REJECTION (buyers)'
      : (upperWick > range * 0.4) ? 'UPPER REJECTION (sellers)' : 'BALANCED'
    : 'BALANCED';

  return {
    candles: candles.length,
    lastClose: last.c,
    pattern, trend, wickRead,
    bodyPct: range > 0 ? +((body / range) * 100).toFixed(0) : null,
  };
}

/**
 * Main entry: bars (1-min) → per-TF structure + agreement verdict.
 */
function readCandleFrames(bars) {
  if (!bars || bars.length < 30) return null;
  const frames = {};
  for (const m of TF_MINUTES) {
    const r = classify(aggregate(bars, m));
    if (r) frames['m' + m] = r;
  }
  const trends = Object.values(frames).map(f => f.trend);
  const ups = trends.filter(t => t.startsWith('UP')).length;
  const downs = trends.filter(t => t.startsWith('DOWN')).length;
  const agree = ups >= 3 ? 'UP' : downs >= 3 ? 'DOWN' : 'MIXED';
  return { frames, agree, ups, downs };
}

module.exports = { readCandleFrames, aggregate, classify, TF_MINUTES };
