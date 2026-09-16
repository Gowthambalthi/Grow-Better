/**
 * scripts/testBounceSignals.js — Phase 2 filter tests (synthetic + real data).
 */
const fs = require('fs');
const path = require('path');
const { structureState } = require('../common/market/swings');
const { detectBounceSignals, entryTriggerOk, stopTarget, DEFAULTS } = require('../common/market/bounceSignals');

function bar(date, o, h, l, c, v = 100000) { return [date, o, h, l, c, v]; }

// Flat base at 102 with 4 touches of 99.4 (bars 30/55/80/94) that each bounce.
// Structure is sideways; the bar-94 touch + bar-95 bounce is the actionable signal.
// Variants break one filter at a time.
function rangeWithBounce({ breakIt = false, weakBounce = false, noWick = false, lowVolumeBounce = false } = {}) {
  const candles = [];
  for (let i = 0; i < 100; i++) candles.push(bar('', 102, 102.4, 101.8, 102.1));
  for (const t of [30, 55, 80]) {
    candles[t] = bar('', 101, 101.2, 99.4, 99.8);
    candles[t + 1] = bar('', 99.9, 101.3, 99.7, 100.9, 250000);
  }
  candles[94] = bar('', 101, 101.2, 99.4, 99.8); // touch
  if (breakIt) {
    for (let i = 95; i <= 99; i++) candles[i] = bar('', 99.6, 99.9, 99.0, 99.2);
  } else if (weakBounce) {
    candles[95] = bar('', 99.9, 100.1, 99.7, 99.3, 300000); // close below zone high (99.4)
    for (let i = 96; i <= 99; i++) candles[i] = bar('', 99.5, 99.9, 99.3, 99.6);
  } else if (noWick) {
    // gap-up open at top of candle, no lower wick, close above zone high
    candles[95] = bar('', 100.4, 100.65, 100.38, 100.6, 300000);
    for (let i = 96; i <= 99; i++) candles[i] = bar('', 100.5, 100.8, 100.3, 100.6);
  } else if (lowVolumeBounce) {
    candles[95] = bar('', 99.9, 100.5, 99.7, 100.2, 50000); // 0.5× avg — fails surge
    for (let i = 96; i <= 99; i++) candles[i] = bar('', 100.2, 100.6, 100, 100.4);
  } else {
    candles[95] = bar('', 99.9, 100.5, 99.7, 100.2, 300000); // strong bounce, 2.8× avg
    for (let i = 96; i <= 99; i++) candles[i] = bar('', 100.2, 100.6, 100, 100.4);
  }
  let ts = new Date('2025-01-01').getTime();
  for (const c of candles) c[0] = new Date(ts += 86400000).toISOString().slice(0, 10);
  return candles;
}

// Downtrend: series of LH/LL steps
function downtrendSeries() {
  const candles = [];
  let p = 150;
  for (let leg = 0; leg < 6; leg++) {
    for (let i = 0; i < 8; i++) { p -= 0.8; candles.push(bar('', p + 0.3, p + 0.5, p - 0.4, p)); }
    for (let i = 0; i < 5; i++) { p += 0.5; candles.push(bar('', p - 0.2, p + 0.4, p - 0.3, p)); }
  }
  let ts = new Date('2025-01-01').getTime();
  for (const c of candles) c[0] = new Date(ts += 86400000).toISOString().slice(0, 10);
  return candles;
}

function run() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name); };

  // --- structure classifier (Task 2.1) ---
  check('Structure: sideways on flat range', structureState(rangeWithBounce()).state === 'sideways');
  check('Structure: downtrend on LH/LL staircase', structureState(downtrendSeries()).state === 'downtrend');

  // --- Task 2.4 trigger mechanics ---
  const zA = { price_low: 100, price_high: 101.2 };
  const goodCandle = bar('', 100.5, 102.6, 99.9, 102.2);
  check('Trigger: strong bounce candle passes', entryTriggerOk(goodCandle, zA, 1.5, DEFAULTS).ok);
  const noWickCandle = bar('', 101.8, 102.4, 101.75, 102.2);
  check('Trigger: no-lower-wick candle rejected', !entryTriggerOk(noWickCandle, zA, 1.5, DEFAULTS).ok);
  const lowClose = bar('', 100.5, 102.6, 99.9, 100.8);
  check('Trigger: close in lower half rejected', !entryTriggerOk(lowClose, zA, 1.5, DEFAULTS).ok);

  // --- Task 2.5 stop/target + R:R gate ---
  // entry 102.2, zone 100–101.2, ATR 1.5 → stop 99.55, risk 2.65, ATR target 105.2 → RR 1.13 → rejected
  const st1 = stopTarget(102.2, zA, 1.5, [], 10, DEFAULTS);
  check('Stop/target: ATR-min target but RR<2 rejected', !st1.ok && st1.target === 105.2 && Math.abs(st1.stop - 99.55) < 1e-9);
  const st2 = stopTarget(102.2, zA, 1.5, [{ index: 5, price: 110 }], 10, DEFAULTS);
  check('Stop/target: swing target ≥ ATR min wins, RR≥2 passes', st2.ok && st2.target === 110);
  const st3 = stopTarget(102.2, zA, 1.5, [{ index: 5, price: 103.4 }], 10, DEFAULTS);
  check('Stop/target: max(swing, 2×ATR) rule + gate', !st3.ok && st3.target === 105.2);
  const st4 = stopTarget(100.9, { price_low: 100, price_high: 101.2 }, 1.5, [{ index: 5, price: 101.9 }], 10, DEFAULTS);
  check('Stop/target: valid low-entry setup passes', st4.ok && Math.abs(st4.rr - 2.22) < 0.01);

  // --- end-to-end ---
  const r1 = detectBounceSignals(rangeWithBounce(), null);
  check('E2E: sideways + strong bounce yields exactly 1 signal', r1.signals.length === 1);
  if (r1.signals.length) {
    const s = r1.signals[0];
    check('E2E: entry/stop/target coherent with RR ≥ 2', s.rr >= 2 && s.entry > s.stop && s.target > s.entry);
    check('E2E: structure not downtrend', s.structure.state !== 'downtrend');
    check('E2E: bounce volume ≥ 1.4× avg', s.volume.bounceVolMult >= 1.4);
    check('E2E: stop = zone_low − 0.3×ATR (below zone)', s.stop < s.symbol_zone.price_low);
  }

  const r2 = detectBounceSignals(downtrendSeries(), null);
  check('E2E: downtrend structure blocks all signals', r2.signals.length === 0);

  const r3 = detectBounceSignals(rangeWithBounce({ weakBounce: true }), null);
  check('E2E: weak bounce (close below zone high) rejected', r3.signals.length === 0);

  const r4 = detectBounceSignals(rangeWithBounce({ noWick: true }), null);
  check('E2E: bounce without lower wick rejected', r4.signals.length === 0);

  const r5 = detectBounceSignals(rangeWithBounce({ lowVolumeBounce: true }), null);
  check('E2E: bounce volume < 1.4× avg rejected', r5.signals.length === 0);

  const r6 = detectBounceSignals(rangeWithBounce({ breakIt: true }), null);
  check('E2E: broken zone yields no signals', r6.signals.length === 0 && r6.zones.length === 0);

  // --- real data sweep ---
  const list = fs.readFileSync(path.join(__dirname, '..', 'data', 'nse_universe_3000.txt'), 'utf8').trim().split(/\r?\n/);
  let sigCount = 0, scanned = 0; const rejReasons = {};
  const sigSymbols = [];
  for (const sym of list) {
    const f = path.join(__dirname, '..', 'data', 'ohlcv', sym + '.json');
    if (!fs.existsSync(f)) continue;
    const candles = JSON.parse(fs.readFileSync(f, 'utf8')).candles;
    if (candles.length < 100) continue;
    scanned++;
    try {
      const r = detectBounceSignals(candles, null);
      for (const s of r.signals) { s.symbol = sym; sigSymbols.push(s); }
      sigCount += r.signals.length;
      for (const rej of r.rejected) {
        const key = (rej.reason || '').replace(/[-0-9.]+/g, 'X').slice(0, 55);
        rejReasons[key] = (rejReasons[key] || 0) + 1;
      }
    } catch (e) { console.log('ERR', sym, e.message); }
  }
  console.log(`\nReal-data sweep (${scanned} stocks): ${sigCount} signals`);
  sigSymbols.slice(0, 8).forEach(s => console.log(`  SIG ${s.symbol} entry ${s.entry} stop ${s.stop} target ${s.target} RR 1:${s.rr} (${s.structure.state}, vol ${s.volume.bounceVolMult}×)`));
  console.log('Top rejection reasons:', Object.entries(rejReasons).sort((a, b) => b[1] - a[1]).slice(0, 5));
  check('Real sweep: pipeline runs without error', scanned > 2500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
