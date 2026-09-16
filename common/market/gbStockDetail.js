/**
 * common/market/gbStockDetail.js — per-timeframe detail for a GB buy stock.
 *
 * Timeframes built from stored daily OHLCV:
 *   weekly / daily / 1h proxy: daily→weekly resample; intraday NOT stored, so
 *   detail covers weekly + daily. For '1h' we approximate with the last N daily
 *   bars sliced (labelled 'daily_last30') — real intraday needs a feed.
 *
 * Per timeframe output:
 *   ma7, ma20, ma50, volume (20d avg), rvol (today's vol / 20d avg),
 *   last 15 candles [{date,o,h,l,c,v}]
 */
'use strict';

function sma(vals, n) {
  if (vals.length < n) return null;
  return vals.slice(-n).reduce((s, v) => s + v, 0) / n;
}

function atr14(candles) {
  if (candles.length < 15) return null;
  let s = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const c = candles[i];
    s += Math.max(c[2] - c[3], Math.abs(c[2] - candles[i - 1][4]), Math.abs(c[3] - candles[i - 1][4]));
  }
  return s / 14;
}

function rsi14(candles) {
  if (candles.length < 15) return null;
  let g = 0, l = 0;
  for (let i = candles.length - 14; i < candles.length; i++) {
    const d = candles[i][4] - candles[i - 1][4];
    if (d > 0) g += d; else l -= d;
  }
  if (l === 0) return 100;
  return 100 - 100 / (1 + g / l);
}

function weeklyResample(daily) {
  const weeks = [];
  let cur = null;
  for (const c of daily) {
    const d = new Date(c[0]);
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - day);
    const key = monday.toISOString().slice(0, 10);
    if (!cur || cur.key !== key) {
      if (cur) weeks.push(cur.bar);
      cur = { key, bar: [key, c[1], c[2], c[3], c[4], c[5]] };
    } else {
      cur.bar[2] = Math.max(cur.bar[2], c[2]);
      cur.bar[3] = Math.min(cur.bar[3], c[3]);
      cur.bar[4] = c[4];
      cur.bar[5] += c[5];
    }
  }
  if (cur) weeks.push(cur.bar);
  return weeks;
}

function tfDetail(candles) {
  const closes = candles.map(c => c[4]);
  const vols = candles.map(c => c[5]);
  const volAvg = sma(vols.slice(0, -1), 20); // 20-bar avg excluding today
  const last = candles[candles.length - 1];
  return {
    ma7: sma(closes, 7) != null ? +sma(closes, 7).toFixed(2) : null,
    ma20: sma(closes, 20) != null ? +sma(closes, 20).toFixed(2) : null,
    ma50: sma(closes, 50) != null ? +sma(closes, 50).toFixed(2) : null,
    volume: last[5],
    volAvg20: volAvg != null ? Math.round(volAvg) : null,
    rvol: volAvg > 0 ? +(last[5] / volAvg).toFixed(2) : null,
    rsi: rsi14(candles),
    atr: atr14(candles) != null ? +atr14(candles).toFixed(2) : null,
    candles15: candles.slice(-15).map(c => ({
      date: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5],
    })),
  };
}

function buildDetail(dailyCandles) {
  if (!Array.isArray(dailyCandles) || dailyCandles.length < 60) return null;
  const weekly = weeklyResample(dailyCandles);
  return {
    daily: tfDetail(dailyCandles),
    weekly: tfDetail(weekly),
  };
}

module.exports = { buildDetail, tfDetail, weeklyResample, sma, rsi14, atr14 };
