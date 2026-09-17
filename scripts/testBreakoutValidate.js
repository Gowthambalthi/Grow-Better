/**
 * scripts/testBreakoutValidate.js — synthetic unit tests per check, built in
 * the step order. Candle format: [date, open, high, low, close, volume].
 *
 * Run: node scripts/testBreakoutValidate.js
 */
const {
  detectBreakout, checkVolumeROC, checkVolumeAcceleration,
  checkPriceVolumeAlignment, calcCamarillaPivots, checkCamarillaContext,
  checkRecentCandleStructure, validateBreakout, scanBreakout,
} = require('../common/market/breakoutValidate');

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
function bar(date, o, h, l, c, v) { return [date, o, h, l, c, v]; }
function flatCandles(n, price, vol) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(bar(`d${i}`, price * 0.99, price * 1.01, price * 0.98, price, vol || 100000));
  }
  return out;
}
function d(i) { return `2026-09-${String(i).padStart(2, '0')}`; }

// ---------- Step 1: detectBreakout ----------
console.log('Step 1: detectBreakout');
{
  const c = flatCandles(30, 100);
  c[29][4] = 105; // close above all prior highs (101)
  let r = detectBreakout(c, 20);
  t('bullish breakout detected', r.direction === 'BULLISH_BREAKOUT' && r.level === 101);

  c[29][4] = 95; // close below all prior lows (98)
  r = detectBreakout(c, 20);
  t('bearish breakout detected', r.direction === 'BEARISH_BREAKOUT' && r.level === 98);

  c[29][4] = 100; // inside range
  r = detectBreakout(c, 20);
  t('no breakout inside range', r.direction === null);

  const short = flatCandles(15, 100);
  t('insufficient bars → null', detectBreakout(short, 20).direction === null);

  // current bar excluded from lookback: close above its own high would be impossible,
  // so verify a breakout is NOT detected when only the current bar is extreme
  const c2 = flatCandles(30, 100);
  c2[29][2] = 120; c2[29][3] = 118; c2[29][4] = 100;
  t('current bar excluded from window', detectBreakout(c2, 20).direction === null);
}

// ---------- Step 2: volume ROC + acceleration ----------
console.log('Step 2: volume ROC + acceleration');
{
  const c = flatCandles(25, 100, 100000);
  c[23][5] = 100000; c[24][5] = 100000; c[25 - 1][5] = 200000; // last = 2x prev
  t('ROC > 50% passes', checkVolumeROC(c, 0.5).ok === true);
  t('ROC value is 1.0', Math.abs(checkVolumeROC(c, 0.5).roc - 1.0) < 1e-9);

  const c2 = flatCandles(25, 100, 100000);
  c2[23][5] = 150000; c2[24][5] = 160000; // 6.7% jump → fail
  t('small ROC fails', checkVolumeROC(c2, 0.5).ok === false);

  // acceleration: 3rd-from-last→2nd diff 20k, 2nd→last diff 60k → increasing
  const a = flatCandles(25, 100, 100000);
  a[22][5] = 100000; a[23][5] = 120000; a[24][5] = 180000;
  t('accelerating volume passes', checkVolumeAcceleration(a).ok === true);
  a[24][5] = 110000; // now diff = -10k
  t('decelerating volume fails', checkVolumeAcceleration(a).ok === false);
}

// ---------- Step 3: price-volume alignment ----------
console.log('Step 3: price-volume alignment');
{
  const c = flatCandles(25, 100, 100000);
  c[23][4] = 100; c[24][4] = 102;
  c[23][5] = 100000; c[24][5] = 150000;
  t('bullish align: price+ and vol+ ', checkPriceVolumeAlignment(c, 'BULLISH_BREAKOUT').ok === true);
  t('bearish align fails on rising price', checkPriceVolumeAlignment(c, 'BEARISH_BREAKOUT').ok === false);
  c[24][5] = 80000;
  t('bullish fails when vol falls', checkPriceVolumeAlignment(c, 'BULLISH_BREAKOUT').ok === false);
  c[24][4] = 98;
  t('bearish align: price- and vol- ', checkPriceVolumeAlignment(c, 'BEARISH_BREAKOUT').ok === false); // vol fell
  c[24][5] = 150000;
  t('bearish align passes', checkPriceVolumeAlignment(c, 'BEARISH_BREAKOUT').ok === true);
}

// ---------- Step 4: Camarilla (manual example first) ----------
console.log('Step 4: Camarilla pivots');
{
  // Hand-computed: prevH=110, prevL=100, prevC=105 → range=10
  // R4 = 105 + 5.5 = 110.5, R3 = 105 + 2.75 = 107.75
  // S3 = 105 - 2.75 = 102.25, S4 = 105 - 5.5 = 99.5
  const p = calcCamarillaPivots(110, 100, 105);
  t('R4 = 110.5', Math.abs(p.R4 - 110.5) < 1e-9);
  t('R3 = 107.75', Math.abs(p.R3 - 107.75) < 1e-9);
  t('S3 = 102.25', Math.abs(p.S3 - 102.25) < 1e-9);
  t('S4 = 99.5', Math.abs(p.S4 - 99.5) < 1e-9);

  // context: bullish close above R3
  const c = flatCandles(25, 100);
  c[23] = bar('d23', 109, 110, 100, 105, 100000); // prior bar
  c[24] = bar('d24', 106, 112, 106, 108.5, 100000); // close 108.5 > R3 107.75
  t('bullish above R3 passes', checkCamarillaContext(c, 'BULLISH_BREAKOUT').ok === true);
  c[24][4] = 107; // below R3
  t('bullish below R3 fails', checkCamarillaContext(c, 'BULLISH_BREAKOUT').ok === false);
  c[24][4] = 101; // below S3 102.25
  t('bearish below S3 passes', checkCamarillaContext(c, 'BEARISH_BREAKOUT').ok === true);
}

// ---------- Step 5: candle structure ----------
console.log('Step 5: recent candle structure');
{
  // 6 bars with strictly higher lows
  const up = [];
  for (let i = 0; i < 6; i++) up.push(bar(d(i), 100 + i, 102 + i, 99 + i, 101 + i, 100000));
  t('higher lows pass (bullish)', checkRecentCandleStructure(up, 'BULLISH_BREAKOUT').ok === true);
  t('higher lows fail for bearish', checkRecentCandleStructure(up, 'BEARISH_BREAKOUT').ok === false);

  const down = [];
  for (let i = 0; i < 6; i++) down.push(bar(d(i), 100 - i, 101 - i, 98 - i, 99 - i, 100000));
  t('lower highs pass (bearish)', checkRecentCandleStructure(down, 'BEARISH_BREAKOUT').ok === false ? false : true);

  const chop = [];
  for (let i = 0; i < 6; i++) chop.push(bar(d(i), 100, 102, i % 2 === 0 ? 99 : 97, 100, 100000));
  t('choppy lows fail bullish', checkRecentCandleStructure(chop, 'BULLISH_BREAKOUT').ok === false);
}

// ---------- Step 6: validateBreakout outcomes ----------
console.log('Step 6: validateBreakout outcomes');
{
  // REAL: engineered breakout bar — big vol jump, rising, above Camarilla R3,
  // higher lows for 6 bars.
  const real = [];
  for (let i = 0; i < 25; i++) {
    real.push(bar(d(i), 99, 101, 98 + i * 0.1, 100, 100000));
  }
  real[23] = bar('d23', 99, 101, 99.5, 100, 100000);
  real[24] = bar('d24', 100.5, 108, 100, 107, 200000); // close 107 > hi 101; ROC 1.0; accel +; align +; R3 on (101,99.5,100)=102.475 → pass
  const vr = validateBreakout(real, 'BULLISH_BREAKOUT', 101);
  t('REAL verdict', vr.verdict === 'REAL');
  t('score 5/5', vr.score === 5 && vr.total === 5);

  // FAKE: breakout on falling volume, decelerating, no alignment, below R3, choppy
  const fake = [];
  for (let i = 0; i < 25; i++) {
    fake.push(bar(d(i), 99, 100.8, 98 + (i % 2) * 1.2, 100, 150000 - i * 2000));
  }
  fake[23] = bar('d23', 99, 104, 96, 100, 120000); // wide prior bar → R3 = 102.2
  fake[24] = bar('d24', 100, 100.9, 99.5, 100.5, 100000); // close 100.5 > hi 100.8? no — raise close:
  fake[24] = bar('d24', 100, 101.5, 99.5, 100.9, 100000); // close 100.9 > 100.8 breakout, < R3 102.2
  const vf = validateBreakout(fake, 'BULLISH_BREAKOUT', 100.8);
  t('FAKE verdict', vf.verdict === 'FAKE');
  t('fade direction SHORT', vf.fadeDirection === 'SHORT');

  // UNCLEAR: score 3/5 — ROC fails, accel fails (vol still rising but slower),
  // align/camarilla/structure pass
  const mid = [];
  for (let i = 0; i < 25; i++) mid.push(bar(d(i), 99, 101, 98 + i * 0.1, 100, 100000));
  mid[23] = bar('d23', 99, 101, 99.5, 100, 180000);
  mid[24] = bar('d24', 100.5, 108, 100, 107, 185000); // ROC 2.8% fail(<90%); accel 5k < 80k fail
  const vm = validateBreakout(mid, 'BULLISH_BREAKOUT', 101, { volumeRocThreshold: 0.9 });
  t('UNCLEAR verdict (3/5 middle score)', vm.verdict === 'UNCLEAR' && vm.score === 3);

  // stub check excluded from denominator
  const vs = validateBreakout(real, 'BULLISH_BREAKOUT', 101, { tickProvider: () => null });
  t('null tickProvider excluded from total', vs.total === 5);

  // scanBreakout convenience
  const sc = scanBreakout(flatCandles(30, 100));
  t('scanBreakout NO_BREAKOUT inside range', sc.verdict === 'NO_BREAKOUT');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
