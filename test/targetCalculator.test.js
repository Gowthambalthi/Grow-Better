'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTarget } = require('../scratch/targetCalculator');

test('targetCalculator: empty or missing params returns safe error object without throwing', () => {
  const res1 = calculateTarget();
  assert.equal(res1.target, null);
  assert.equal(res1.long, null);
  assert.equal(res1.short, null);
  assert.ok(res1.error);

  const res2 = calculateTarget({});
  assert.equal(res2.target, null);
  assert.ok(res2.error);
});

test('targetCalculator: resolves entry price when only currentPrice or entryPrice is provided', () => {
  const res1 = calculateTarget({ entryPrice: 1000, vwap: 1000 });
  assert.equal(typeof res1.long, 'number');
  assert.equal(typeof res1.short, 'number');
  assert.ok(!Number.isNaN(res1.long));
  assert.ok(!Number.isNaN(res1.short));

  const res2 = calculateTarget({ currentPrice: 1000, vwap: 1000 });
  assert.equal(typeof res2.long, 'number');
  assert.equal(typeof res2.short, 'number');
  assert.ok(!Number.isNaN(res2.long));
});

test('targetCalculator: handles zero or missing vwap gracefully without NaN or Infinity', () => {
  const res = calculateTarget({ entryPrice: 500, vwap: 0 });
  assert.ok(Number.isFinite(res.long));
  assert.ok(Number.isFinite(res.short));
  assert.equal(res.stopBps, 45); // clamped floor
});

test('targetCalculator: fixed mode respects 1:1.50 R:R mandate and short cap', () => {
  // vwapDist = 0% -> stopBps = 45 bps -> targetBps = 68 bps
  const res = calculateTarget({ entryPrice: 1000, currentPrice: 1000, vwap: 1000, shortTargetBps: 75 });
  assert.equal(res.stopBps, 45);
  // long target = 1000 * (1 + 68/10000) = 1006.8
  assert.equal(res.long, 1006.8);
  // short target = 1000 * (1 - 68/10000) = 993.2
  assert.equal(res.short, 993.2);
});

test('targetCalculator: directional resolution returns explicit plan for SHORT side', () => {
  const res = calculateTarget({
    entryPrice: 1000,
    currentPrice: 1000,
    vwap: 995,
    side: 'SHORT'
  });
  assert.equal(res.target, res.short);
  assert.ok(res.target < 1000);
  assert.ok(res.stopLoss > 1000);
  assert.ok(res.riskPts > 0);
  assert.ok(res.rewardPts > 0);
  assert.ok(res.riskReward.startsWith('1 : '));
});

test('targetCalculator: directional resolution returns explicit plan for LONG side', () => {
  const res = calculateTarget({
    entryPrice: 1000,
    currentPrice: 1000,
    vwap: 1005,
    side: 'LONG'
  });
  assert.equal(res.target, res.long);
  assert.ok(res.target > 1000);
  assert.ok(res.stopLoss < 1000);
  assert.ok(res.riskPts > 0);
  assert.ok(res.rewardPts > 0);
  assert.ok(res.riskReward.startsWith('1 : '));
});

test('targetCalculator: structural mode uses structural stopBps and structTargetRr', () => {
  const res = calculateTarget({
    entryPrice: 1000,
    structStopMode: true,
    stopBps: 80,
    structTargetRr: 1.0,
    side: 'SHORT'
  });
  assert.equal(res.stopBps, 80);
  assert.equal(res.targetBps, 80);
  assert.equal(res.target, 992.0); // 1000 * (1 - 80/10000)
  assert.equal(res.stopLoss, 1008.0); // 1000 * (1 + 80/10000)
  assert.equal(res.riskPts, 8.0);
  assert.equal(res.rewardPts, 8.0);
});
