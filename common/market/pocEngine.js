/**
 * common/market/pocEngine.js — Point-of-Control (volume-at-price) + order-flow engine.
 *
 * POC: the price level carrying the most traded volume in a session. Big players
 * defend it; price reacting at POC / the Value Area edges is the core order-flow read.
 *
 * We have no tick data, so each bar's volume is spread uniformly across its
 * high-low range (a standard OHLCV approximation) and each bar gets a directional
 * delta proxy: volume signed by where the close sits in the bar's range
 * (close near high = buy aggression, near low = sell aggression).
 *
 * Session = all bars sharing the same calendar date, strictly 09:15-15:15.
 */

const TICK = 0.05; // price-bin size; ~ fine enough for 15m volume profiles

function buildProfile(bars) {
  const bins = new Map(); // priceKey -> {vol, delta}
  for (const [, o, h, l, c, v] of bars) {
    if (!(v > 0) || !(h >= l)) continue;
    const lo = Math.floor(l / TICK) * TICK;
    const hi = Math.ceil(h / TICK) * TICK;
    const nBins = Math.max(1, Math.round((hi - lo) / TICK));
    const per = v / nBins;
    // close position in range: 1 = at high (buying), 0 = at low (selling)
    const cp = h > l ? (c - l) / (h - l) : 0.5;
    const delta = v * (2 * cp - 1);
    for (let p = lo; p <= hi + 1e-9; p += TICK) {
      const k = p.toFixed(2);
      let b = bins.get(k);
      if (!b) { b = { vol: 0, delta: 0 }; bins.set(k, b); }
      b.vol += per;
      b.delta += delta / nBins;
    }
  }
  let poc = null, maxVol = -1, totalVol = 0;
  for (const [k, b] of bins) {
    totalVol += b.vol;
    if (b.vol > maxVol) { maxVol = b.vol; poc = parseFloat(k); }
  }
  // 70% value area: expand around POC by taking the heavier neighbour each step.
  // Work on a dense grid array to avoid float-key rounding traps.
  const keys = [...bins.keys()].map(parseFloat).sort((a, b) => a - b);
  const gridLo = keys[0];
  const n = Math.round((keys[keys.length - 1] - gridLo) / TICK) + 1;
  const arr = new Array(n).fill(null);
  for (const [k, b] of bins) arr[Math.round((parseFloat(k) - gridLo) / TICK)] = b;
  let pi = Math.round((poc - gridLo) / TICK), li = pi, hii = pi, acc = arr[pi].vol;
  while (acc < 0.7 * totalVol) {
    const below = li - 1 >= 0 ? arr[li - 1] : null;
    const above = hii + 1 < n ? arr[hii + 1] : null;
    if (!below && !above) break;
    if (above && (!below || above.vol >= below.vol)) { hii++; acc += above.vol; }
    else { li--; acc += below.vol; }
  }
  const valueLow = gridLo + li * TICK, valueHigh = gridLo + hii * TICK;
  // session order-flow tilt: net delta vs total volume
  let netDelta = 0;
  for (const b of bins.values()) netDelta += b.delta;
  return {
    poc, valueLow, valueHigh,
    netDelta, totalVol,
    flowBias: totalVol > 0 ? netDelta / totalVol : 0, // -1..+1
  };
}

function groupBySession(candles) {
  const days = new Map();
  for (const row of candles) {
    const [ts] = row;
    const d = ts.slice(0, 10);
    const mins = parseInt(ts.slice(11, 13), 10) * 60 + parseInt(ts.slice(14, 16), 10);
    if (mins < 555 || mins > 915) continue; // 09:15..15:15 only
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(row);
  }
  return [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

module.exports = { buildProfile, groupBySession, TICK };
