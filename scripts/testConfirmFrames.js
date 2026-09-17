/**
 * scripts/testConfirmFrames.js — unit tests for the 5 confirmation frames.
 *
 * Synthetic fixtures with known outcomes:
 *  - Weekly structure: monotonic uptrend → uptrend; stair-step down → not uptrend
 *  - RS: stock outperforms / underperforms a flat benchmark
 *  - Volume quality: known ratios (0.5x, 1.6x, 2.5x)
 *  - Base quality: score arithmetic on stub signals
 *  - Extension: known MA/ATR distance
 */
const { frameWeeklyStructure, frameRelativeStrength, frameVolumeQuality,
        frameBaseQuality, frameExtension, frameIntradayClose, frameIntradayHold,
        frameNiftyDirection, frameVolumeAtPrice } = require('../common/market/confirmFrames');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ok - ${name}`); }
  else { failed++; console.log(`  FAIL - ${name} ${extra}`); }
}

// Weekly structure needs multi-week legs (swingLeft/Right=3 on weekly bars).
function mkDates(n, startStr = '2024-01-01') {
  const out = [];
  const d = new Date(startStr + 'T00:00:00Z');
  for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
// Up: 30 rising days, 15 falling days, growing amplitude → HH/HL weekly.
function mkWave(n, start, dirInit, upStep, dnStep) {
  const ds = mkDates(n);
  const c = [];
  let p = start, dir = dirInit, ph = 0, leg = 0;
  for (let i = 0; i < n; i++) {
    const step = dir === dirInit ? upStep + leg * 0.2 : dnStep + leg * 0.1;
    p += dir * step;
    c.push([ds[i], p - 1, p + 1, p - 2, p, 1000]);
    ph++;
    if (ph >= (dir === dirInit ? 30 : 15)) { dir *= -1; ph = 0; leg++; }
  }
  return c;
}
function uptrend(n, start = 100) { return mkWave(n, start, 1, 1.0, 3.0); }
// mirror the uptrend around a constant — structure tags are symmetric
function downtrend(n, start = 400) {
  const up = uptrend(n, start);
  return up.map(c => [c[0], 2 * start - c[1], 2 * start - c[2] + 3, 2 * start - c[3] - 3, 2 * start - c[4], c[5]]);
}
// linear candles for F2/F3/F5 (no structure needed)
function linear(n, start = 100, slope = 0.5, vol = 100000) {
  const ds = mkDates(n);
  const c = [];
  for (let i = 0; i < n; i++) {
    const cl = start + i * slope;
    c.push([ds[i], cl - 0.5, cl + 0.6, cl - 1.0, cl, vol]);
  }
  return c;
}

console.log('F1 weekly structure');
{
  const up = uptrend(400);
  const f = frameWeeklyStructure(up, 399);
  ok('uptrend detected', f.pass === true, JSON.stringify(f));
  const dn = downtrend(400);
  const f2 = frameWeeklyStructure(dn, 399);
  ok('downtrend not uptrend', f2.pass === false && f2.state === 'downtrend', JSON.stringify(f2));
  const f3 = frameWeeklyStructure(up, 30);
  ok('insufficient history → null pass', f3.pass === null, JSON.stringify(f3));
}

console.log('F2 relative strength');
{
  const stock = linear(60, 100, 1.0);   // +59 over 59 bars
  const bench = linear(60, 100, 0.1);   // +5.9 — much slower
  const f = frameRelativeStrength(stock, 59, bench, 20);
  ok('stock outperforming → pass', f.pass === true && f.rs > 0, JSON.stringify(f));
  const f2 = frameRelativeStrength(bench, 59, stock, 20);
  ok('stock underperforming → fail', f2.pass === false && f2.rs < 0, JSON.stringify(f2));
  const f3 = frameRelativeStrength(stock, 10, bench, 20);
  ok('insufficient stock history → null', f3.pass === null, JSON.stringify(f3));
  const f4 = frameRelativeStrength(stock, 59, null, 20);
  ok('no benchmark → null', f4.pass === null, JSON.stringify(f4));
}

console.log('F3 volume quality');
{
  const c = linear(30, 100, 0.5, 100000);
  c[29][5] = 160000; // 1.6x avg
  const f = frameVolumeQuality(c, 29, 20);
  ok('1.6x → pass, grade ok', f.pass === true && f.grade === 'ok', JSON.stringify(f));
  c[29][5] = 50000; // 0.5x
  const f2 = frameVolumeQuality(c, 29, 20);
  ok('0.5x → fail, weak', f2.pass === false && f2.grade === 'weak', JSON.stringify(f2));
  c[29][5] = 260000; // 2.6x
  const f3 = frameVolumeQuality(c, 29, 20);
  ok('2.6x → pass, strong/heavy', f3.pass === true && (f3.grade === 'strong' || f3.grade === 'heavy'), JSON.stringify(f3));
  const f4 = frameVolumeQuality(c, 10, 20);
  ok('short history → null', f4.pass === null, JSON.stringify(f4));
}

console.log('F4 base quality');
{
  const strong = { base: { bars: 45, touches: 4, contraction_ratio: 0.45 } };
  ok('strong base scores 5, pass', frameBaseQuality(strong).pass === true && frameBaseQuality(strong).score === 5);
  const weak = { base: { bars: 10, touches: 1, contraction_ratio: 1.2 } };
  ok('weak base scores 0, fail', frameBaseQuality(weak).pass === false && frameBaseQuality(weak).score === 0);
  const mid = { base: { bars: 25, touches: 3, contraction_ratio: 0.8 } };
  ok('mid base scores 2, fail', frameBaseQuality(mid).pass === false && frameBaseQuality(mid).score === 2);
  const noBase = {};
  ok('missing base → null-ish fail without crash', frameBaseQuality(noBase).score === 0);
}

console.log('F5 extension');
{
  const c = linear(40, 100, 0.15);  // gentle trend: close well within 2.5 ATR of MA20
  const f = frameExtension(c, 39);
  ok('gentle trend not over-extended', f.pass === true && f.ext !== null && Math.abs(f.ext) < 2.5, JSON.stringify(f));
  // engineer a spike: last close far above MA
  const c2 = linear(40, 100, 0.15);
  c2[39][4] = c2[39][4] * 1.5; // +50% gap
  const f2 = frameExtension(c2, 39);
  ok('vertical bar flagged extended', f2.pass === false, JSON.stringify(f2));
  const f3 = frameExtension(c, 5);
  ok('short history → null', f3.pass === null, JSON.stringify(f3));
}

console.log('F6 intraday close');
{
  // strong close: rises all day, closes at highs, heavy last hour
  const strong = [];
  for (let i = 0; i < 25; i++) {
    const cl = 100 + i * 0.4;
    strong.push([`09:${String(15 + i).padStart(2, '0')}`, cl - 0.2, cl + 0.3, cl - 0.4, cl, i < 4 ? 3000 : 4000 + i * 100]);
  }
  const f = frameIntradayClose(strong);
  ok('rising day, building volume → pass', f.pass === true, JSON.stringify(f));

  // fake: pops early, fades all afternoon on dying volume
  const fake = [];
  for (let i = 0; i < 25; i++) {
    const cl = i < 4 ? 100 + i * 0.5 : 102 - (i - 4) * 0.05; // early spike then flat-drift
    fake.push([`09:${String(15 + i).padStart(2, '0')}`, cl - 0.2, cl + 0.3, cl - 0.4, cl, i < 4 ? 5000 : Math.max(500, 5000 - i * 200)]);
  }
  const f2 = frameIntradayClose(fake);
  ok('fading close → fail', f2.pass === false, JSON.stringify(f2));

  const f3 = frameIntradayClose(null);
  ok('no intraday data → null', f3.pass === null, JSON.stringify(f3));
  const f4 = frameIntradayClose(strong.slice(0, 8));
  ok('too few bars → null', f4.pass === null, JSON.stringify(f4));
}

console.log('F7 intraday hold');
{
  const level = 100, atr = 2;
  const holds = Array.from({ length: 25 }, (_, i) => {
    const cl = 100.5 + Math.sin(i / 3) * 0.3; // oscillates just above level
    return [`t${i}`, cl - 0.2, cl + 0.3, cl - 0.5, cl, 1000];
  });
  const f = frameIntradayHold(holds, level, atr);
  ok('level held all day → pass', f.pass === true && f.dips === 0, JSON.stringify(f));

  // intraday breakdown: several 15-min closes well below the level, recover at close
  const breaks = Array.from({ length: 25 }, (_, i) => {
    const cl = i >= 8 && i < 16 ? 99.2 : 100.6; // 8 bars below, −0.8% deep vs 0.25×ATR=0.5%
    return [`t${i}`, cl - 0.2, cl + 0.3, cl - 0.5, cl, 1000];
  });
  const f2 = frameIntradayHold(breaks, level, atr);
  ok('intraday breakdown → fail', f2.pass === false, JSON.stringify(f2));

  const f3 = frameIntradayHold(null, level, atr);
  ok('no next-day data → null', f3.pass === null, JSON.stringify(f3));
}

console.log('F8 Nifty direction');
{
  // rising benchmark: accelerating uptrend linear → close > EMA20, EMA5 > EMA20
  const up = linear(60, 100, 0.5);
  const f = frameNiftyDirection(up, up[59][0]);
  ok('rising Nifty → up, pass', f.pass === true && f.direction === 'up', JSON.stringify(f));
  const dn = linear(60, 200, -0.5);
  const f2 = frameNiftyDirection(dn, dn[59][0]);
  ok('falling Nifty → down, fail', f2.pass === false && f2.direction === 'down', JSON.stringify(f2));
  // sideways: alternating steps around a flat mean → 'side'
  const flat = [];
  const dsf = mkDates(60);
  for (let i = 0; i < 60; i++) {
    const cl = 100 + ((i % 10) < 5 ? (i % 5) : 5 - (i % 5));
    flat.push([dsf[i], cl - 0.5, cl + 0.6, cl - 1.0, cl, 1000]);
  }
  const f3 = frameNiftyDirection(flat, flat[59][0]);
  ok('sideways Nifty → side, fail (long-only)', f3.pass === false && f3.direction === 'side', JSON.stringify(f3));
  const f4 = frameNiftyDirection(up, '2024-01-15'); // too early for EMA20
  ok('early date → null', f4.pass === null, JSON.stringify(f4));
  const f5 = frameNiftyDirection(null, up[59][0]);
  ok('no benchmark → null', f5.pass === null, JSON.stringify(f5));
}

console.log('F9 volume-at-price proxy');
{
  const ds = mkDates(10);
  const strong = [[ds[9], 99, 110, 98.5, 109.5, 50000]];   // close at top of range
  const f = frameVolumeAtPrice(strong, 0);
  ok('close at high → pass', f.pass === true && f.upperShare >= 0.9, JSON.stringify(f));
  const weak = [[ds[9], 95, 110, 94.5, 102, 50000]];       // close mid-range
  const f2 = frameVolumeAtPrice(weak, 0);
  ok('close mid-range → fail', f2.pass === false, JSON.stringify(f2));
  const flat2 = [[ds[9], 100, 100, 100, 100, 50000]];      // zero range
  const f3 = frameVolumeAtPrice(flat2, 0);
  ok('zero-range bar → null', f3.pass === null, JSON.stringify(f3));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
