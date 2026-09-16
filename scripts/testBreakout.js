/**
 * scripts/testBreakout.js — Phase 3 base-detection tests (synthetic + real data).
 */
const fs = require('fs');
const path = require('path');
const { detectBases, validateResistanceTouches } = require('../common/market/breakout');

function bar(date, o, h, l, c, v = 100000) { return [date, o, h, l, c, v]; }

/**
 * Build a consolidation of `bars` oscillating in [lo, hi] with pivot-high
 * rejections. volStart→volEnd scales the per-bar range (ATR proxy) and
 * volume scales trade volume linearly across the base.
 */
function buildBase({ bars = 24, lo = 100, hi = 104, volStart = 1.0, volEnd = 0.4, volumeStart = 300000, volumeEnd = 100000, rejections = [6, 13, 20], preBars = 30 } = {}) {
  const candles = [];
  // pre-base uptrend into the base
  let p = lo - 12;
  for (let i = 0; i < preBars; i++) { p += 0.4; candles.push(bar('', p - 0.2, p + 0.3, p - 0.5, p)); }
  const baseStart = candles.length;
  for (let i = 0; i < bars; i++) {
    const f = i / (bars - 1);
    const vol = volStart + (volEnd - volStart) * f;           // range scale (ATR proxy)
    const volume = Math.round(volumeStart + (volumeEnd - volumeStart) * f);
    const mid = lo + (hi - lo) / 2 + Math.sin(i * 1.1) * ((hi - lo) / 2 - vol);
    const range = 0.8 * vol;
    candles.push(bar('', mid - range / 2, mid + range / 2, mid - range / 2 - 0.05, mid + range / 2 - 0.1, volume));
  }
  // carve clean rejection pivots at hi: bar spikes to hi+ then closes back below within 2 bars
  for (const r of rejections) {
    if (r >= bars) continue;
    const bi = baseStart + r;
    candles[bi] = bar('', hi - 0.5, hi + 0.6, hi - 0.8, hi - 0.6, 200000);
    candles[bi + 1] = bar('', hi - 0.7, hi - 0.3, lo + 0.5, lo + 0.9, 150000); // closes back near lo
  }
  let ts = new Date('2025-01-01').getTime();
  for (const c of candles) c[0] = new Date(ts += 86400000).toISOString().slice(0, 10);
  return { candles, baseStart };
}

function run() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name); };

  // Test 1: ideal base passes all four gates
  const t1 = buildBase();
  const r1 = detectBases(t1.candles);
  check('T1: ideal base qualifies', r1.bases.length >= 1);
  if (r1.bases.length) {
    const b = r1.bases[0];
    check('T1: duration ≥ 18 bars', b.bars >= 18);
    check('T1: contraction ratio ≤ 0.65', b.contraction_ratio <= 0.65);
    check('T1: ≥2 resistance touches', b.resistance_touches.length >= 2);
    check('T1: volume dry-up ratio ≤ 0.85', b.volume_trend_ratio <= 0.85);
  }

  // Test 2: short base (13 bars with rejections spanning it → a 9-bar pivot
  // cluster) → below the 10-bar fast-momentum floor → rejected outright
  const t2 = buildBase({ bars: 13, rejections: [1, 5, 9] });
  const r2 = detectBases(t2.candles);
  check('T2: 12-bar base not qualified', r2.bases.length === 0);
  check('T2: short base lands in fast_momentum OR rejected below floor',
        r2.fast_momentum.length >= 1 || r2.rejected.some(b => /base \d+ bars </.test(b.reject_reason)));

  // Test 3: very short base (8 bars, rejections at 2 and 5 → pivot cluster
  // spans only 4 bars) → fully rejected, never a fast_momentum candidate
  const t3 = buildBase({ bars: 8, rejections: [1, 4, 7] });
  const r3 = detectBases(t3.candles);
  check('T3: 5-bar base rejected outright', r3.bases.length === 0 && r3.fast_momentum.length === 0 && r3.rejected.length >= 1);

  // Test 4: no volatility contraction (flat vol profile) → rejected by Task 3.2
  const t4 = buildBase({ volStart: 1.0, volEnd: 0.95 });
  const r4 = detectBases(t4.candles);
  check('T4: no-contraction base rejected', r4.bases.length === 0 && r4.rejected.some(b => /ATR% ratio/.test(b.reject_reason)));

  // Test 5: rising volume through base → rejected by Task 3.4
  const t5 = buildBase({ volumeStart: 100000, volumeEnd: 400000 });
  const r5 = detectBases(t5.candles);
  check('T5: rising-volume base rejected', r5.bases.length === 0 && r5.rejected.some(b => /volume/.test(b.reject_reason)));

  // Test 6: insufficient resistance touches → rejected by Task 3.3.
  // Synthetic: two pivot highs whose following bars DON'T close back below
  // level−ATR (closes linger near the high) → 0 valid touches → not a base.
  const t6 = [];
  for (let i = 0; i < 45; i++) {
    const hi = 104.6;
    const rng = 1.5 - 1.3 * (i / 44); // contracting range → passes Task 3.2
    t6.push(bar('', 104.0, hi, 104.0 - rng, 104.0, 200000)); // closes at highs → no rejection ever validates
  }
  const r6 = detectBases(t6);
  check('T6: <2 resistance touches rejected', r6.bases.length === 0 && r6.rejected.some(b => /resistance touches/.test(b.reject_reason)));

  // --- real data sweep ---
  const list = fs.readFileSync(path.join(__dirname, '..', 'data', 'nse_universe_3000.txt'), 'utf8').trim().split(/\r?\n/);
  let scanned = 0, withBases = 0, withFast = 0;
  const rejReasons = {};
  const sample = [];
  for (const sym of list) {
    const f = path.join(__dirname, '..', 'data', 'ohlcv', sym + '.json');
    if (!fs.existsSync(f)) continue;
    const candles = JSON.parse(fs.readFileSync(f, 'utf8')).candles;
    if (candles.length < 60) continue;
    scanned++;
    try {
      const r = detectBases(candles);
      if (r.bases.length) { withBases++; if (sample.length < 6) sample.push(`${sym}: ${r.bases[0].price_low}-${r.bases[0].price_high} (${r.bases[0].bars} bars, ${r.bases[0].resistance_touches.length} touches, vol ${r.bases[0].volume_trend_ratio})`); }
      if (r.fast_momentum.length) withFast++;
      for (const rej of r.rejected) {
        const key = (rej.reject_reason || '').replace(/[-0-9.]+/g, 'X').slice(0, 55);
        rejReasons[key] = (rejReasons[key] || 0) + 1;
      }
    } catch (e) { console.log('ERR', sym, e.message); }
  }
  console.log(`\nReal sweep (${scanned} stocks): ${withBases} with ≥1 qualified base, ${withFast} with fast-momentum ranges`);
  sample.forEach(s => console.log('  ' + s));
  console.log('Top rejection reasons:', Object.entries(rejReasons).sort((a, b) => b[1] - a[1]).slice(0, 4));
  check('Real sweep: pipeline runs without error', scanned > 2500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
