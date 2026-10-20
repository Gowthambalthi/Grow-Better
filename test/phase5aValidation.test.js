'use strict';

/**
 * PHASE 5A — session selection and the acceptance rule, pinned so the DECISION
 * LOGIC cannot drift. These tests never read tape and never touch a strategy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const p5a = require('../backtest/phase5aValidation');

test('the discovery window is read from the Phase 2 doc, not guessed', () => {
  const w = p5a.discoveryWindow();
  assert.equal(w.from, '2026-09-28');
  assert.equal(w.to, '2026-10-01');
});

test('selectSessions excludes the discovery sessions from validation', () => {
  const sel = p5a.selectSessions();
  for (const d of sel.discovery) assert.ok(d >= sel.discoveryWindow.from && d <= sel.discoveryWindow.to);
  for (const d of sel.validation) assert.ok(d > sel.discoveryWindow.to, d + ' must be after the discovery window');
  // No session may appear in both lists.
  assert.equal(sel.discovery.filter((d) => sel.validation.includes(d)).length, 0);
});

test('detailedMetrics adds wins/losses/avg fields on top of the shared metrics()', () => {
  const trades = [
    { r: 2, entry: 100, stop: 99, outcome: 'T2', barsHeld: 5, side: 'LONG', day: 'd', rr1: 2, rr2: 4, riskPct: 1 },
    { r: -1, entry: 100, stop: 99, outcome: 'STOP', barsHeld: 3, side: 'LONG', day: 'd', rr1: 2, rr2: 4, riskPct: 1 },
  ];
  const m = p5a.detailedMetrics(trades, 0.05);
  assert.equal(m.trades, 2);
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 1);
  assert.equal(m.grossProfitR, 2);
  assert.equal(m.grossLossR, 1);
  assert.ok(m.avgRR1 != null && m.avgRiskPct != null);
});

function sess(day, bNetPF, bExp, cNetPF, cExp, samePop) {
  return {
    day,
    baseline: { metrics: { netPF: bNetPF, expectancyR: bExp } },
    change30: { metrics: { netPF: cNetPF, expectancyR: cExp } },
    population: { samePopulation: samePop !== false },
  };
}

test('acceptance: PASS only when net PF and expectancy improve across multiple sessions', () => {
  const sessions = [sess('d1', 1.0, 0.1, 1.5, 0.3), sess('d2', 1.1, 0.2, 1.6, 0.4), sess('d3', 1.0, 0.1, 1.2, 0.25)];
  const acc = p5a.evaluateAcceptance(sessions, { netPF: 1.05, expectancyR: 0.15, trades: 40 }, { netPF: 1.4, expectancyR: 0.32, trades: 35 });
  assert.equal(acc.conditions.netPFImproves, true);
  assert.equal(acc.conditions.expectancyImproves, true);
  assert.equal(acc.conditions.multipleSessions, true);
  assert.equal(acc.change30BetterSessions, 3);
});

test('acceptance: a single-session improvement is not enough', () => {
  const sessions = [sess('d1', 1.0, 0.1, 2.0, 0.9), sess('d2', 1.2, 0.3, 1.0, 0.1)];
  const acc = p5a.evaluateAcceptance(sessions, { netPF: 1.05, expectancyR: 0.15, trades: 40 }, { netPF: 1.3, expectancyR: 0.3, trades: 30 });
  assert.equal(acc.conditions.multipleSessions, false);
  assert.ok(acc.reasons.includes('improvement is not visible across multiple independent sessions'));
});

test('acceptance: a major sign reversal is flagged and blocks', () => {
  const sessions = [sess('d1', 1.0, 0.1, 0.5, -0.2), sess('d2', 1.1, 0.2, 0.6, -0.1), sess('d3', 1.0, 0.1, 1.2, 0.3)];
  const acc = p5a.evaluateAcceptance(sessions, { netPF: 1.1, expectancyR: 0.15, trades: 40 }, { netPF: 1.2, expectancyR: 0.2, trades: 35 });
  assert.equal(acc.signReversal, true);
  assert.ok(acc.reasons.includes('session results show a major sign reversal'));
});

test('acceptance: a population mismatch blocks', () => {
  const sessions = [sess('d1', 1.0, 0.1, 1.5, 0.3, false), sess('d2', 1.0, 0.1, 1.5, 0.3, true)];
  const acc = p5a.evaluateAcceptance(sessions, { netPF: 1.0, expectancyR: 0.1, trades: 40 }, { netPF: 1.5, expectancyR: 0.3, trades: 35 });
  assert.equal(acc.conditions.noPopulationMismatch, false);
  assert.ok(acc.reasons.includes('population mismatch present'));
});

test('acceptance: a tiny sample is called out, not promoted', () => {
  const sessions = [sess('d1', 1.0, 0.1, 1.5, 0.3), sess('d2', 1.0, 0.1, 1.5, 0.3)];
  const acc = p5a.evaluateAcceptance(sessions, { netPF: 1.0, expectancyR: 0.1, trades: 3 }, { netPF: 1.5, expectancyR: 0.3, trades: 2 });
  assert.ok(acc.reasons.includes('sample too small to decide (trades < 30)'));
});

test('the harness never modifies the strategy files', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backtest', 'phase5aValidation.js'), 'utf8');
  for (const forbidden of ['strategies/orderFlow.js', "require('../strategies/orderFlow')"]) {
    // It may reference the engine only to RUN it, never to write it.
    assert.ok(!/writeFileSync\([^)]*orderFlow/.test(src), 'must not write the engine');
  }
  assert.ok(!src.includes('enableOF02: true'));
});
