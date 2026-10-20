'use strict';

/**
 * NEWS LEANS → TRADE RULE — the pieces the Telegram digest and the page share,
 * pinned so they cannot drift apart:
 *
 *   * a lean only comes from a (category, direction) class whose measured hit
 *     rate (DIRECTION-ADJUSTED — posRate is the share with positive abnormal
 *     return, so a DOWN class's hit rate is its complement) clears 55% on 30+
 *     events;
 *   * the digest states the backtested rule — next-open entry, skip if already
 *     gapped ≥ the class's expected move (the rule that turned the holdout book
 *     from PF 0.95 to PF 1.09), SL 1.5%, exit next close — with the holdout
 *     numbers beside it, and says so plainly when no measurement exists;
 *   * the policy travels with /api/news/signals, so the page and the phone quote
 *     the same rule.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const newsSignals = require('../common/news/newsSignals');
const { formatLeanDigest } = require('../common/scheduler/cronJobs');

/** A minimal reaction fixture: one strong class, one weak one. */
function fakeReaction() {
  const cls = (n, posRate, mean) => ({ n, posRate, mean, t: null, median: 0 });
  return {
    byCategory: {
      results: { byDirection: { UP: { horizons: { 0: cls(600, 0.60, 0.01) } }, DOWN: { horizons: { 0: cls(350, 0.33, -0.011) } } } },
      war: { byDirection: { UP: { horizons: { 0: cls(50, 0.40, -0.002) } } } },  // mean sign wrong: no lean
    },
  };
}

function fakeItems() {
  return [
    { date: '2026-10-19', category: 'results', direction: 'UP', symbols: ['INFY'], title: 'Infosys profit rises 20%', url: '' },
    { date: '2026-10-19', category: 'results', direction: 'DOWN', symbols: ['DLF'], title: 'DLF profit falls 30%', url: '' },
    { date: '2026-10-19', category: 'war', direction: 'UP', symbols: ['TCS'], title: 'TCS gains amid war', url: '' }, // unreliable class
  ];
}

test('only classes with a measured, direction-adjusted edge produce leans', () => {
  const sig = newsSignals.computeSignals(fakeItems(), fakeReaction(), 14, new Date('2026-10-20T12:00:00Z'));
  const syms = sig.stocks.map((s) => s.symbol).sort();
  assert.deepEqual(syms, ['DLF', 'INFY'], 'TCS (war_UP, weak/wrong-signed class) must not lean');
  const dlf = sig.stocks.find((s) => s.symbol === 'DLF');
  assert.equal(dlf.lean, 'DOWN');
  // DOWN hit rate is 1 - posRate = 0.67 — the direction adjustment itself.
  assert.ok(Math.abs(dlf.hitRate - 0.67) < 1e-9, 'DOWN hit rate must be the complement of posRate');
});

test('the digest states the measured rule with its numbers', () => {
  const policy = {
    measuredAt: '2026-10-20T14:48:26.891Z', slPct: 1.5, horizon: 1, filter: 'gap',
    stats: { n: 395, hit: 0.377, meanNetPct: 0.000863, pf: 1.09 },
  };
  const sig = newsSignals.computeSignals(fakeItems(), fakeReaction(), 14, new Date('2026-10-20T12:00:00Z'));
  const text = formatLeanDigest(sig, policy);
  assert.match(text, /DLF/, 'the lean must be named');
  assert.match(text, /▼/, 'DOWN leans carry the down arrow');
  assert.match(text, /SL 1\.5%/, 'the stop must be stated');
  assert.match(text, /NOT already gapped/, 'the skip rule must be stated');
  assert.match(text, /n=395/, 'the holdout sample must be stated');
  assert.match(text, /PF 1\.09/, 'the holdout profit factor must be stated');
});

test('with no measurement the digest says the rule is unmeasured instead of inventing one', () => {
  const sig = newsSignals.computeSignals(fakeItems(), fakeReaction(), 14, new Date('2026-10-20T12:00:00Z'));
  const text = formatLeanDigest(sig, newsSignals.DEFAULT_POLICY);
  assert.match(text, /NOT yet measured/);
  assert.doesNotMatch(text, /SL 1\.5%/);
});

test('the shared module reads the measured policy file when it exists', () => {
  const p = newsSignals.readPolicy();
  assert.equal(typeof p.slPct, 'number');
  // The file is written by scratch/news_lean_backtest.js; if it is present it
  // must carry the measured holdout stats, not just the shape.
  if (p.measuredAt) {
    assert.ok(p.stats && p.stats.n >= 30, 'a measured policy must carry its holdout sample');
  }
});
