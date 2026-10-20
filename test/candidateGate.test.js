'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Gate } = require('../research/candidateGate');

const makeTrade = (netR, win, day, hour) => ({ netR, win, day, hour });

/**
 * A SEEDED generator, so the fixture is the same trades every run.
 *
 * This fixture used `Math.random()`, and the "CONDITIONAL fragile but positive" case
 * therefore failed about ONE RUN IN TEN. That was not the gate being wrong: with n=70
 * and a 45% win rate the realised win count is Binomial(70, 0.45), and a run that lands
 * below the break-even rate w > 0.375 earns a correct REJECT from a correct gate. The
 * flake was a false alarm about the code, produced by a test whose whole subject is the
 * boundary — so the fixture is now reproducible and the assertion keeps its teeth.
 *
 * The product below stays under 2^53, so `>>> 0` is exact and the sequence is identical
 * on every platform (unlike reusing Math.random with a shuffle).
 */
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const DEFAULT_SEED = 20260206;

function baseCandidate(opts) {
  const n = opts.n || 80;
  const trades = [];
  const sessions = [];
  const rnd = makeRng(opts.seed == null ? DEFAULT_SEED : opts.seed);
  const hourOf = (i) => String(9 + ((i % 7) + 6) % 7);
  const dayOf = (i) => '2026-02-' + String(1 + (i % 28)).padStart(2, '0');
  for (let i = 0; i < n; i++) {
    const win = rnd() < opts.winPct;
    const netR = win ? opts.avgWinR : -opts.avgLossR;
    trades.push(makeTrade(netR, win, dayOf(i), hourOf(i)));
  }
  for (let s = 0; s < 10; s++) {
    const sTrades = trades.slice(s * (n / 10), (s + 1) * (n / 10));
    let sum = 0, wins = 0;
    for (const t of sTrades) { sum += t.netR; if (t.win) wins++; }
    sessions.push({
      label: 's' + s,
      trades: sTrades.length,
      netExpectancyR: sTrades.length ? sum / sTrades.length : null,
      netPF: (sum > 0 ? sum : 0) / Math.max(1, -sum) || null,
      winPct: sTrades.length ? wins / sTrades.length : null,
    });
  }
  return { candidateId: opts.candidateId || 'X', track: opts.track || 'SCALPING', nativeFrame: opts.nativeFrame || '1m', costPctAssumed: opts.costPctAssumed ?? 0.05, trades, sessions,
    top1Share: opts.top1Share, top2Share: opts.top2Share, top5Share: opts.top5Share, top10Share: opts.top10Share,
    signalCount: opts.signalCount,
    independentObservations: opts.independentObservations ?? n,
    maxAdversePct: opts.maxAdversePct ?? 0.8,
    selectivity: opts.selectivity ?? (n / 5000),
    costCurve: [{ costPct: 0.05, netExpectancyR: (opts.avgNetExpR ?? (sumNetR(trades) / n)) }, { costPct: 0.10, netExpectancyR: (opts.avgNetExpR ?? (sumNetR(trades) / n)) - 0.05 }],
  };
}

function sumNetR(trades) { let s = 0; for (const t of trades) s += t.netR; return s; }

test('PASSES candidate with robust after-cost shape', () => {
  const c = baseCandidate({
    candidateId: 'SCALP-FAKE-1', track: 'SCALPING', nativeFrame: '1m',
    winPct: 0.42, avgWinR: 1.5, avgLossR: 1.0, n: 120, signalCount: 200,
    top1Share: 0.12, top2Share: 0.18, top5Share: 0.32, top10Share: 0.48,
    maxAdversePct: 0.7,
  });
  // net expect = 0.42 * 1.5 - 0.58 * 1.0 = 0.63 - 0.58 = 0.05
  // With cost 0.05 this is ~0.0 netR per trade. That is too thin for the gate. Boost winners.
  c.trades.forEach((t, i) => { t.netR = t.win ? 1.9 : -1.0; });
  const a = Gate.evaluate(c);
  assert.ok(a.verdict === 'PASSES' || a.verdict === 'CONDITIONAL', 'expected at least conditional for a robustish shape; got ' + a.verdict);
});

test('REJECT thin sample', () => {
  const c = baseCandidate({ candidateId: 'THIN', n: 10, signalCount: 10, independentObservations: 10, top10Share: 0.2, winPct: 0.5, avgWinR: 2.0, avgLossR: 1.0 });
  const a = Gate.evaluate(c);
  assert.equal(a.verdict, 'REJECT');
});

test('REJECT fatally concentrated tail', () => {
  const c = baseCandidate({ candidateId: 'TAIL', n: 90, signalCount: 200, top1Share: 0.95, top2Share: 0.98, top5Share: 1.0, top10Share: 1.0, winPct: 0.5, avgWinR: 2.0, avgLossR: 1.0, independentObservations: 60 });
  const a = Gate.evaluate(c);
  assert.equal(a.verdict, 'REJECT');
  assert.ok(a.fails.some(f => /top-10%/i.test(f)));
});

test('REJECT negative after cost', () => {
  const c = baseCandidate({ candidateId: 'NEG', n: 60, winPct: 0.4, avgWinR: 0.9, avgLossR: 1.0, top10Share: 0.3, independentObservations: 60 });
  const a = Gate.evaluate(c);
  assert.equal(a.verdict, 'REJECT');
  assert.ok(a.fails.some(f => /net expectancy/i.test(f)));
});

test('REJECT fatally concentrated top-10 tail', () => {
  const c = baseCandidate({ candidateId: 'REJECT-TAIL', n: 70, signalCount: 180, top1Share: 0.48, top2Share: 0.72, top5Share: 0.96, top10Share: 1.0, winPct: 0.48, avgWinR: 1.8, avgLossR: 1.0, independentObservations: 70 });
  const a = Gate.evaluate(c);
  assert.equal(a.verdict, 'REJECT');
  assert.ok(a.fails.some(f => /top-10%/i.test(f)), 'fatal tail dependence must be named')
});
test('CONDITIONAL fragile but positive', () => {
  const c = baseCandidate({ candidateId: 'FRAGILE', n: 70, signalCount: 180, top1Share: 0.18, top2Share: 0.32, top5Share: 0.66, top10Share: 0.86, winPct: 0.45, avgWinR: 1.8, avgLossR: 1.0, independentObservations: 70 });
  const a = Gate.evaluate(c);
  assert.equal(a.verdict, 'CONDITIONAL');
});

test('track field is preserved and reused by both tracks', () => {
  const c = baseCandidate({ candidateId: 'INTRA-1', track: 'INTRADAY', nativeFrame: '1m', n: 90, top10Share: 0.3, winPct: 0.45, avgWinR: 1.8, avgLossR: 1.0 });
  const a = Gate.evaluate(c);
  assert.equal(a.track, 'INTRADAY');
});

test('best-hour and best-DOW shares are computed when provided', () => {
  const c = baseCandidate({ candidateId: 'HOURLY', n: 100, top10Share: 0.3, winPct: 0.45, avgWinR: 1.8, avgLossR: 1.0 });
  c.byHour = { '09': { trades: 60, netExpectancyR: 0.8 }, '12': { trades: 40, netExpectancyR: -0.4 } };
  c.byDayOfWeek = { 'Mon': { trades: 50, netExpectancyR: 0.7 }, 'Fri': { trades: 50, netExpectancyR: -0.1 } };
  const a = Gate.evaluate(c);
  assert.ok(a.bestHourShareOfNetR != null);
  assert.ok(a.bestDayOfWeekShareOfNetR != null);
});

test('double-cost survival is checked from the cost curve', () => {
  const c = baseCandidate({ candidateId: 'DOUBLE', n: 100, top10Share: 0.28, winPct: 0.48, avgWinR: 1.8, avgLossR: 1.0, costPctAssumed: 0.05 });
  c.costCurve = [{ costPct: 0.05, netExpectancyR: 0.2 }, { costPct: 0.10, netExpectancyR: -0.1 }];
  const a = Gate.evaluate(c);
  assert.ok(a.flags.some(f => /double cost/i.test(f)));
});

test('precomputed aggregates are assessed without a per-trade array', () => {
  const a = Gate.evaluate({
    candidateId: 'AGG', track: 'INTRADAY', nativeFrame: '1m', costPctAssumed: 0.05,
    n: 500, netExpectancyR: 0.3, netPF: 1.6, grossPF: 1.9, winPct: 0.5, sumNetR: 150,
    sessions: [
      { label: 'm1', trades: 250, netExpectancyR: 0.4, netPF: 1.8, winPct: 0.5 },
      { label: 'm2', trades: 250, netExpectancyR: 0.2, netPF: 1.4, winPct: 0.5 },
    ],
    long: { trades: 250, netExpectancyR: 0.35 }, short: { trades: 250, netExpectancyR: 0.25 },
    byHour: { '10': { trades: 500, netExpectancyR: 0.3 } },
    byDayOfWeek: { Mon: { trades: 500, netExpectancyR: 0.3 } },
    costCurve: [{ costPct: 0.05, netExpectancyR: 0.3 }, { costPct: 0.10, netExpectancyR: 0.1 }],
    top1Share: 0.1, top2Share: 0.15, top5Share: 0.3, top10Share: 0.45, independentObservations: 500,
  });
  assert.equal(a.n, 500);
  assert.equal(a.netExpectancyR, 0.3);
  assert.equal(a.netPF, 1.6);
  assert.ok(a.verdict === 'PASSES' || a.verdict === 'CONDITIONAL', 'aggregate candidate must be gradeable; got ' + a.verdict);
});

test('best-hour/DOW shares stay interpretable when bucket net R nearly cancels', () => {
  const c = baseCandidate({ candidateId: 'BUCKET', n: 40, top10Share: 0.3, winPct: 0.45, avgWinR: 1.8, avgLossR: 1.0 });
  c.byHour = { '10': { trades: 20, netExpectancyR: 1.0 }, '11': { trades: 20, netExpectancyR: -1.0 } };
  c.byDayOfWeek = { Mon: { trades: 20, netExpectancyR: 1.0 }, Tue: { trades: 20, netExpectancyR: -1.0 } };
  const a = Gate.evaluate(c);
  assert.ok(a.bestHourShareOfNetR == null || (a.bestHourShareOfNetR >= 0 && a.bestHourShareOfNetR <= 1), 'hour share must be a fraction, got ' + a.bestHourShareOfNetR);
  assert.ok(a.bestDayOfWeekShareOfNetR == null || (a.bestDayOfWeekShareOfNetR >= 0 && a.bestDayOfWeekShareOfNetR <= 1), 'dow share must be a fraction, got ' + a.bestDayOfWeekShareOfNetR);
});

test('summary prints the verdict', () => {
  const c = baseCandidate({ candidateId: 'SUM', n: 20, winPct: 0.4, avgWinR: 1.0, avgLossR: 1.0, top10Share: 0.3, independentObservations: 20 });
  const a = Gate.evaluate(c);
  const txt = Gate.summary(a);
  assert.ok(txt.includes(a.verdict));
});
