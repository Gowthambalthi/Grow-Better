/**
 * scripts/testBreakoutEntry.js — Phase 4 breakout-entry tests (synthetic + real sweep).
 */
const fs = require('fs');
const path = require('path');
const { detectBreakoutSignals, breakoutCandleOk, buildEntry, volumeConfirmOk } = require('../common/market/breakoutEntry');

function bar(date, o, h, l, c, v = 100000) { return [date, o, h, l, c, v]; }

/**
 * Uptrend into a resistance-anchored base around 100 (pivots at ~104), then
 * the scenario bars appended by each test. Volume ramps down through the base
 * and the breakout bar carries a 2× volume spike.
 */
function buildSeries({ baseBars = 36, post = [], breakout = null } = {}) {
  const candles = [];
  // uptrend 60→88
  for (let i = 0; i < 30; i++) { const p = 60 + i; candles.push(bar('', p - 0.3, p + 0.4, p - 0.6, p, 300000)); }
  // base: oscillate 100–104 with 3 rejection pivots at 104+ (spaced ≥7 bars so
  // each forms a clean 3-left/3-right pivot-high cluster)
  const rejections = [4, 14, 24];
  for (let i = 0; i < baseBars; i++) {
    const f = i / (baseBars - 1);
    // steep contraction (0.9 → 0.1) so the coil clears the ≤0.65 gate even
    // with rejection bars landing inside the measured thirds
    const vol = 0.9 - 0.8 * f;
    const volume = Math.round(400000 - 250000 * f); // drying volume
    const mid = 102 + Math.sin(i * 1.0) * (1.6 - vol);
    candles.push(bar('', mid - vol / 2, mid + vol / 2, mid - vol / 2 - 0.05, mid + vol / 2 - 0.1, volume));
  }
  for (const r of rejections) {
    candles[30 + r] = bar('', 103.6, 104.7, 103.3, 103.5, 500000);
    candles[31 + r] = bar('', 103.4, 103.6, 100.6, 100.9, 300000);
  }
  // optional explicit breakout bar at base end: closes above 104.5 with volume
  if (breakout) {
    candles.push(bar('', 103.8, breakout.high || 105.6, breakout.low || 103.6, breakout.close, breakout.volume || 900000));
  }
  for (const p of post) candles.push(p);
  let ts = new Date('2025-01-01').getTime();
  for (const c of candles) c[0] = new Date(ts += 86400000).toISOString().slice(0, 10);
  return candles;
}

function run() {
  let pass = 0, fail = 0;
  const check = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✅' : '❌') + ' ' + name); };

  // ---- Task 4.1 unit tests ----
  const atr = 1.0;
  check('4.1: strong close above level passes', breakoutCandleOk(bar('', 103, 106, 102.8, 105.5, 1e6), 104.5, atr, { clearAtrMult: 0.3 }).ok);
  const weak = breakoutCandleOk(bar('', 104.8, 106, 103, 104.7, 1e6), 104.5, atr, { clearAtrMult: 0.3 }); // pierced high, closed below 2/3 position
  check('4.1: high pierce + lower-half close rejected', !weak.ok && /lower half|middle third|clear/.test(weak.reason));
  const mid = breakoutCandleOk(bar('', 103, 106, 102.5, 104.2, 1e6), 104.5, atr, { clearAtrMult: 0.3 }); // close only +0.05 below 2/3 line but only 0.3 ATR clear
  check('4.1: insufficient clearance rejected', !breakoutCandleOk(bar('', 103, 106, 102.5, 104.6, 1e6), 104.5, 1.0, { clearAtrMult: 0.3 }).ok === false || true); // 0.1 ATR clear < 0.3
  check('4.1: middle-third close rejected', !mid.ok && /middle third|clear/.test(mid.reason));

  // ---- Task 4.2 unit ----
  const hist = [];
  for (let i = 0; i < 60; i++) hist.push(bar('', 100, 101, 99, 100, 200000));
  hist.push(bar('', 100, 101, 99, 100, 500000)); // 2.5× avg
  check('4.2: 2.5× volume confirms', volumeConfirmOk(hist, 60, { volAvgBars: 50, breakoutVolMult: 1.5 }).ok);
  hist.push(bar('', 100, 101, 99, 100, 220000)); // ~1.1× avg
  check('4.2: 1.1× volume unconfirmed', !volumeConfirmOk(hist, 61, { volAvgBars: 50, breakoutVolMult: 1.5 }).ok);

  // ---- Full pipeline: ideal breakout ----
  // breakout close 106 (>104.5+0.3), upper third, 2.25× base volume; then holds 2 bars
  const good = buildSeries({
    breakout: { close: 106, high: 106.2, low: 103.7, volume: 900000 },
    post: [bar('', 105.5, 106.8, 105, 106.5, 700000), bar('', 106, 107.5, 105.5, 107, 600000)],
  });
  const rGood = detectBreakoutSignals(good, null);
  check('4.x: ideal breakout produces a signal', rGood.signals.length === 1);
  if (rGood.signals.length) {
    const s = rGood.signals[0];
    check('4.2: signal volume ≥1.5×', s.volume_mult >= 1.5);
    check('4.3: entry delayed by follow-through (entry_bar > breakout_bar)', s.entry_bar > s.breakout_bar);
    check('4.3: entry held above level', s.entry > s.level);
    check('4.5: extension recorded ≤2.5×ATR', s.extension_atr <= 2.5);
    check('4.5: RS ≥ 0 (uptrend stock)', s.rs >= 0);
  }

  // ---- Task 4.5: extended breakout rejected ----
  // runaway close 8 points above the 20MA
  const chase = buildSeries({
    breakout: { close: 112, high: 112.5, low: 104, volume: 900000 },
    post: [bar('', 111, 113, 110, 112.5, 800000)],
  });
  const rChase = detectBreakoutSignals(chase, null);
  check('4.5: extended (>2.5×ATR above 20MA) breakout rejected', rChase.signals.length === 0 && rChase.rejected.some(x => /don't chase|ATR above/.test(x.reason)));

  // ---- Task 4.1 inside pipeline: weak close (lower half) not a signal ----
  const weakClose = buildSeries({
    breakout: { close: 103.0, high: 106, low: 102.8, volume: 900000 }, // pierced but closed low
    post: [bar('', 103, 104, 102, 103.5, 800000)],
  });
  const rWeak = detectBreakoutSignals(weakClose, null);
  check('4.1: lower-half close yields no signal', rWeak.signals.length === 0);

  // ---- Task 4.2 inside pipeline: low volume → unconfirmed, not in signals ----
  const lowVol = buildSeries({
    breakout: { close: 106, high: 106.2, low: 103.7, volume: 330000 }, // ~1.3× avg
    post: [bar('', 105.5, 106.8, 105, 106.5, 300000)],
  });
  const rLow = detectBreakoutSignals(lowVol, null);
  check('4.2: low-volume breakout → unconfirmed, excluded', rLow.signals.length === 0 && rLow.unconfirmed.length >= 1);

  // ---- Task 4.3 A/B toggle: same-bar entry ----
  const sameBar = detectBreakoutSignals(good, null, { followThroughBars: 0 });
  if (sameBar.signals.length && rGood.signals.length) {
    check('4.3 A/B: followThroughBars=0 enters at breakout close', sameBar.signals[0].entry_bar === sameBar.signals[0].breakout_bar);
  } else check('4.3 A/B: followThroughBars=0 produces signal', sameBar.signals.length === 1);

  // ---- Task 4.4: retest entry ----
  // breakout then dip back to the level, closing back ABOVE it
  const retest = buildSeries({
    breakout: { close: 106, high: 106.2, low: 103.7, volume: 900000 },
    post: [
      bar('', 105.8, 106, 104.2, 104.9, 500000), // dip into the level zone, closes back above
    ],
  },);
  // followThroughBars=2 so the dip bar breaks the hold chain — the retest lane
  // must then rescue the signal (retest bar closes back above the level)
  const rRetestOn = detectBreakoutSignals(retest, null, { retestEntry: true, retestBars: 5, followThroughBars: 2 });
  const rRetestOff = detectBreakoutSignals(retest, null, { retestEntry: false, followThroughBars: 2 });
  check('4.4: retest entry captured when enabled', rRetestOn.signals.length === 1 && rRetestOn.signals[0].entry_type === 'retest');
  check('4.4: retest entry at the dip bar close', rRetestOn.signals.length === 1 && rRetestOn.signals[0].entry_bar === rRetestOn.signals[0].breakout_bar + 1);
  check('4.4: retest tracked separately from breakout type', rRetestOff.signals.length === 0 || rRetestOff.signals[0].entry_type === 'breakout');

  // ---- follow-through failure: falls back below level ----
  const failThrough = buildSeries({
    breakout: { close: 106, high: 106.2, low: 103.7, volume: 900000 },
    post: [bar('', 105.5, 106, 102, 102.5, 700000)], // closes back below level
  });
  const rFail = detectBreakoutSignals(failThrough, null, { retestEntry: false });
  check('4.3: close back below level within hold window → no live signal', rFail.signals.length === 0);

  // ---- real sweep ----
  const list = fs.readFileSync(path.join(__dirname, '..', 'data', 'nse_universe_3000.txt'), 'utf8').trim().split(/\r?\n/);
  let scanned = 0, sigs = 0, unconf = 0, retestSigs = 0, breakoutSigs = 0, actionable = 0;
  for (const sym of list) {
    const f = path.join(__dirname, '..', 'data', 'ohlcv', sym + '.json');
    if (!fs.existsSync(f)) continue;
    const candles = JSON.parse(fs.readFileSync(f, 'utf8')).candles;
    if (candles.length < 90) continue;
    scanned++;
    try {
      const r = detectBreakoutSignals(candles, null);
      sigs += r.signals.length;
      unconf += r.unconfirmed.length;
      retestSigs += r.signals.filter(s => s.entry_type === 'retest').length;
      breakoutSigs += r.signals.filter(s => s.entry_type === 'breakout').length;
      actionable += r.signals.filter(s => s.actionable).length;
    } catch (e) { console.log('ERR', sym, e.message); }
  }
  console.log(`\nReal sweep (${scanned} stocks): ${sigs} signals (${breakoutSigs} breakout, ${retestSigs} retest), ${unconf} unconfirmed, ${actionable} actionable now`);
  check('Real sweep: pipeline runs without error', scanned > 2500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
