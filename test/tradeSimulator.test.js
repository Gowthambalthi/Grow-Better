'use strict';

/**
 * test/tradeSimulator.test.js
 *
 * Constructed-data unit tests for the canonical trade simulator module (scratch/trade_simulator.js).
 *
 * Validates:
 * 1. Target fill with fill-anchored fixed R:R (zero target-entry mismatch).
 * 2. Normal stop fill.
 * 3. Gap-down through stop at open (slippage model).
 * 4. Gap-up above target at open (limit open fill).
 * 5. Dual same-bar hit (conservative stop-first resolution).
 * 6. Session end / EOD settlement on truncated data.
 * 7. Dropped trade classification:
 *    - No next bar (tape ends on signal).
 *    - Open gaps below stop before entry.
 *    - Structural target fails minRR gate.
 *    - Stop exceeds maxRiskBps cap.
 * 8. Two-way cluster bootstrap reproducibility.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { simulateTrade, twoWayClusterBootstrap } = require('../scratch/trade_simulator.js');

function makeBar(time, o, h, l, c, v = 1000) {
  return { time, t: `2026-08-04 ${time}`, o, h, l, c, v };
}

test('1. Normal target fill: target is strictly anchored to entry open', () => {
  // Signal at 09:49. Close = 100. Stop = 98.
  // Next bar opens at 101 (gap up from signal close!).
  // With fill-anchored geometry:
  //   entryPrice = 101.0
  //   initialRisk = 101.0 - 98.0 = 3.0
  //   targetPrice = 101.0 + (3.0 * 1.5) = 105.5
  const bars = [
    makeBar('09:49', 99.5, 100.5, 99.0, 100.0), // signal bar (idx 0)
    makeBar('09:50', 101.0, 102.0, 100.5, 101.5), // entry bar (idx 1)
    makeBar('09:51', 101.5, 105.5, 101.0, 105.0), // target hit bar (idx 2)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.entryPrice, 101.0);
  assert.equal(res.trade.initialRisk, 3.0);
  assert.equal(res.trade.targetPrice, 105.5);
  assert.equal(res.trade.exitPrice, 105.5);
  assert.equal(res.trade.exitReason, 'TARGET');
  assert.equal(res.trade.grossR, 1.5);
});

test('2. Normal stop fill: exits at stopLoss', () => {
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // signal (idx 0)
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry (idx 1), risk = 2.0
    makeBar('09:51', 100.0, 100.5, 97.5, 98.0),  // stop hit (idx 2)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.entryPrice, 100.0);
  assert.equal(res.trade.initialRisk, 2.0);
  assert.equal(res.trade.exitPrice, 98.0);
  assert.equal(res.trade.exitReason, 'STOP');
  assert.equal(res.trade.grossR, -1.0);
});

test('3. Gap-down through stop at bar open: captures open slippage', () => {
  // Stop is 98.0. Next bar opens at 96.0 (gap down through stop!).
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // signal (idx 0)
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry (idx 1)
    makeBar('09:51', 96.0, 97.0, 95.5, 96.5),   // gap open at 96.0 (idx 2)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.exitPrice, 96.0); // Filled at the gapped open
  assert.equal(res.trade.exitReason, 'STOP');
  // Initial risk was 2.0 (100 - 98). Exit at 96.0 -> loss is -4.0 pts -> grossR = -2.0R
  assert.equal(res.trade.grossR, -2.0);
});

test('4. Gap-up above target at bar open: fills at gapped open, not clamped target', () => {
  // Target is 103.0. Next bar opens at 104.5.
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // signal (idx 0)
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry (idx 1), risk = 2.0, target = 103.0
    makeBar('09:51', 104.5, 105.0, 104.0, 104.8), // gap open at 104.5 (idx 2)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.exitPrice, 104.5);
  assert.equal(res.trade.exitReason, 'TARGET');
  // Profit is +4.5 pts on 2.0 risk -> grossR = +2.25R
  assert.equal(res.trade.grossR, 2.25);
});

test('5. Dual same-bar hit: resolves conservatively as STOP_DUAL', () => {
  // Candle expands to touch both stop (98.0) and target (103.0) in the same bar
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // signal (idx 0)
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry (idx 1), stop = 98.0, target = 103.0
    makeBar('09:51', 100.5, 104.0, 97.0, 101.0), // wide candle: H=104 >= 103, L=97 <= 98
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.exitPrice, 98.0);
  assert.equal(res.trade.exitReason, 'STOP_DUAL');
  assert.equal(res.trade.dualHit, true);
  assert.equal(res.trade.grossR, -1.0);
});

test('6. EOD settlement on truncated session (e.g. 15:14 end)', () => {
  const bars = [
    makeBar('15:10', 100.0, 100.5, 99.5, 100.0), // signal (idx 0)
    makeBar('15:11', 100.0, 100.5, 99.5, 100.0), // entry (idx 1), stop = 98.0, target = 103.0
    makeBar('15:12', 100.2, 100.8, 99.8, 100.5),
    makeBar('15:13', 100.5, 101.0, 100.2, 100.8),
    makeBar('15:14', 100.8, 101.2, 100.5, 101.0), // last bar in truncated feed (idx 4)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5,
    eodTime: '15:25'
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.exitBarIdx, 4);
  assert.equal(res.trade.exitTime, '15:14');
  assert.equal(res.trade.exitPrice, 101.0);
  assert.equal(res.trade.exitReason, 'EOD');
  // Points = +1.0 on 2.0 risk -> grossR = +0.5R
  assert.equal(res.trade.grossR, 0.5);
});

test('7. Dropped trade accounting: all rejection paths tracked', () => {
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // idx 0
    makeBar('09:50', 97.0, 98.0, 96.0, 97.5),   // idx 1 (opens at 97.0, below stop 98.0!)
  ];

  // Case A: Next bar opens at or below stop (gap down before entry)
  const resGap = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    gapOnOpenAction: 'DROP'
  });
  assert.equal(resGap.status, 'DROPPED');
  assert.equal(resGap.dropReason, 'GAP_THROUGH_STOP_ON_OPEN');

  // Case B: Signal on last bar of day (no next bar to enter)
  const resNoNext = simulateTrade(bars, 1, {
    stopLoss: 95.0,
    targetType: 'FIXED_RR'
  });
  assert.equal(resNoNext.status, 'DROPPED');
  assert.equal(resNoNext.dropReason, 'NO_NEXT_BAR');

  // Case C: Structural target yields realized RR < minRR (e.g. Model E filter)
  const barsStruct = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0),
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry = 100.0, stop = 98.0 (risk = 2.0)
    makeBar('09:51', 100.0, 102.5, 99.5, 102.0),
  ];
  const resRR = simulateTrade(barsStruct, 0, {
    stopLoss: 98.0,
    targetType: 'STRUCTURAL',
    structuralTarget: 102.5, // RR = 2.5 / 2.0 = 1.25 < 2.0 required!
    minRR: 2.0
  });
  assert.equal(resRR.status, 'DROPPED');
  assert.equal(resRR.dropReason, 'INSUFFICIENT_RR');
  assert.equal(resRR.realizedRR, 1.25);

  // Case D: Max stop risk cap exceeded (> 150 bps)
  const resWide = simulateTrade(barsStruct, 0, {
    stopLoss: 95.0, // Risk = 5.0 on 100.0 = 500 bps > 150 bps cap!
    targetType: 'FIXED_RR',
    targetRR: 1.5,
    maxRiskBps: 150
  });
  assert.equal(resWide.status, 'DROPPED');
  assert.equal(resWide.dropReason, 'STOP_TOO_WIDE');
  assert.equal(resWide.riskBps, 500);

  // Case E: Structural target not above entry price (inverted target)
  const resInverted = simulateTrade(barsStruct, 0, {
    stopLoss: 98.0,
    targetType: 'STRUCTURAL',
    structuralTarget: 99.0 // Target 99.0 < entry 100.0!
  });
  assert.equal(resInverted.status, 'DROPPED');
  assert.equal(resInverted.dropReason, 'TARGET_NOT_ABOVE_ENTRY');
});

test('8. Two-way cluster bootstrap is deterministic with fixed seed', () => {
  const dummyTrades = [
    { date: '2026-08-04', sym: 'RELIANCE', grossBps: 30, riskBps: 20 },
    { date: '2026-08-04', sym: 'TCS', grossBps: -20, riskBps: 20 },
    { date: '2026-08-05', sym: 'RELIANCE', grossBps: -25, riskBps: 25 },
    { date: '2026-08-05', sym: 'INFY', grossBps: 40, riskBps: 20 },
    { date: '2026-08-06', sym: 'TCS', grossBps: 50, riskBps: 25 },
  ];

  const run1 = twoWayClusterBootstrap(dummyTrades, 100, 15, 42);
  const run2 = twoWayClusterBootstrap(dummyTrades, 100, 15, 42);

  assert.equal(run1.meanR, run2.meanR);
  assert.equal(run1.ciLower, run2.ciLower);
  assert.equal(run1.ciUpper, run2.ciUpper);
});

test('9. Two-way cluster bootstrap matches exact analytical brute-force distribution across seeds', () => {
  // 2x2 grid: 2 dates, 2 symbols, 4 trades
  // t1: (D1, S1) netR = 1.0
  // t2: (D1, S2) netR = 2.0
  // t3: (D2, S1) netR = 3.0
  // t4: (D2, S2) netR = 4.0
  // Analytical distribution over all 16 equally likely draws:
  // Expected value = 2.500 (tested by res.meanR on the empirical sample)
  // 2.5th percentile = 1.000, 97.5th percentile = 4.000
  const trades = [
    { date: 'D1', sym: 'S1', grossBps: 100, riskBps: 100 },
    { date: 'D1', sym: 'S2', grossBps: 200, riskBps: 100 },
    { date: 'D2', sym: 'S1', grossBps: 300, riskBps: 100 },
    { date: 'D2', sym: 'S2', grossBps: 400, riskBps: 100 },
  ];

  // Verify across multiple seeds that CI lower is strictly 1.0 and upper is strictly 4.0
  for (const seed of [42, 100, 777, 9999]) {
    const res = twoWayClusterBootstrap(trades, 20000, 0, seed);
    assert.equal(res.meanR, 2.5); // Sample mean
    assert.equal(res.ciLower, 1); // 2.5th percentile
    assert.equal(res.ciUpper, 4); // 97.5th percentile
  }
});

test('10. Gap precedence: open gap above target takes precedence over subsequent intrabar drop', () => {
  // Bar 1 (entry): open 100, stop 98, target 103
  // Bar 2: opens at 104.0 (gapped above target on open!).
  // Later in the same bar, it crashes to low 97.0 (touching stop).
  // Because the open was >= targetPrice, limit exit executes on open at 104.0, BEFORE any intrabar drop.
  const bars = [
    makeBar('09:49', 100.0, 101.0, 99.5, 100.0), // signal (idx 0)
    makeBar('09:50', 100.0, 101.0, 99.5, 100.0), // entry (idx 1), stop=98, target=103
    makeBar('09:51', 104.0, 105.0, 97.0, 97.5),  // open 104 (gap target), low 97 (stop breached later)
  ];

  const res = simulateTrade(bars, 0, {
    stopLoss: 98.0,
    targetType: 'FIXED_RR',
    targetRR: 1.5
  });

  assert.equal(res.status, 'ENTERED');
  assert.equal(res.trade.exitPrice, 104.0);
  assert.equal(res.trade.exitReason, 'TARGET');
  assert.equal(res.trade.grossR, 2.0); // (104 - 100) / 2 = 2.0R
});

