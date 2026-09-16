/**
 * scripts/testZones.js — sanity tests + real-data demo for Phase 1 zones.
 *
 * 1. Synthetic candles with a known triple-touch support → must return 1 zone.
 * 2. Synthetic zone that price later breaks → must come back as broken.
 * 3. Real data: QUICKHEAL + RELIANCE from data/ohlcv.
 */
const fs = require('fs');
const path = require('path');
const { detectSupportZones } = require('../common/market/zones');

function bar(date, o, h, l, c, v = 100000) { return [date, o, h, l, c, v]; }

function synthCandles() {
  // 120 bars. Price ~100, three dips to ~95 (bars 55, 70, 85) each bouncing
  // back above 97 quickly → one valid 3-touch zone. Touches sit inside the
  // last-75-bar lookback window the detector scans.
  const candles = [];
  let d = new Date('2025-01-01');
  for (let i = 0; i < 120; i++) {
    d = new Date(d.getTime() + 86400000);
    const date = d.toISOString().slice(0, 10);
    let l = 99.5 + Math.sin(i) * 0.3;
    let c = 100 + Math.sin(i * 0.7) * 0.5;
    let o = c - 0.2;
    let h = Math.max(o, c) + 0.4;
    candles.push(bar(date, o, h, l, c));
  }
  // carve the three support touches: dip to 95, close back above 97 within 2 bars
  for (const t of [55, 70, 85]) {
    candles[t] = bar(candles[t][0], 99, 99.2, 95.0, 95.5);
    candles[t + 1] = bar(candles[t + 1][0], 95.6, 98.5, 95.4, 98.0);
    candles[t + 2] = bar(candles[t + 2][0], 98, 99.5, 97.6, 99.0);
  }
  return candles;
}

function brokenCandles() {
  // Same base, but after bar 95 price closes below 94 for 3 straight bars.
  const candles = synthCandles();
  for (let i = 96; i < 99; i++) {
    candles[i] = bar(candles[i][0], 95, 95.2, 92, 92.5);
  }
  return candles;
}

function run() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name); };

  // Test 1: triple-touch zone detected and passes quality gate
  const r1 = detectSupportZones(synthCandles());
  check('Test1: exactly 1 zone passes gate', r1.zones.length === 1);
  if (r1.zones.length) {
    const z = r1.zones[0];
    check('Test1: 3 valid touches', z.valid_touch_count === 3);
    check('Test1: zone bounds around 95', z.price_low <= 95 && z.price_high >= 95 && z.price_high < 96.5);
    check('Test1: status active', z.status === 'active');
  }

  // Test 2: same setup but price breaks below → zone rejected as broken
  const r2 = detectSupportZones(brokenCandles());
  const z2 = r2.zones.find(z => z.price_low < 96 && z.price_high > 94);
  check('Test2: support zone marked broken (not in zones)', !z2);
  check('Test2: broken zone appears in rejected_zones', r2.rejected_zones.some(z => z.status === 'broken' && z.reject_reason.includes('closed below')));

  // Test 3: quality gate — single touch doesn't pass
  const c3 = synthCandles();
  // remove touches at 70 and 85 (flatten to range noise)
  for (const t of [70, 85]) {
    c3[t] = bar(c3[t][0], 99.4, 99.8, 99.0, 99.5);
    c3[t + 1] = bar(c3[t + 1][0], 99.5, 99.9, 99.2, 99.6);
  }
  const r3 = detectSupportZones(c3);
  check('Test3: 1-touch zone rejected by quality gate', !r3.zones.some(z => z.price_low < 96) && r3.rejected_zones.some(z => z.valid_touch_count < 3));

  // Test 4: real data
  for (const sym of ['QUICKHEAL', 'RELIANCE', 'SBIN']) {
    const f = path.join(__dirname, '..', 'data', 'ohlcv', sym + '.json');
    if (!fs.existsSync(f)) { console.log('⚠ skip ' + sym); continue; }
    const candles = JSON.parse(fs.readFileSync(f, 'utf8')).candles;
    const r = detectSupportZones(candles);
    console.log(`\n${sym}: ${r.zones.length} zones pass, ${r.rejected_zones.length} rejected (of ${r.pivots.length} pivots in window)`);
    r.zones.slice(0, 3).forEach(z => console.log(`  PASS ${z.price_low}-${z.price_high} touches=${z.touch_count} valid=${z.valid_touch_count} last=${z.last_touch_date} status=${z.status}`));
    r.rejected_zones.slice(0, 2).forEach(z => console.log(`  REJ  ${z.price_low}-${z.price_high} valid=${z.valid_touch_count} reason=${z.reject_reason}`));
    check(`Test4[${sym}]: module runs and returns arrays`, Array.isArray(r.zones) && Array.isArray(r.rejected_zones));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
