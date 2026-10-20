'use strict';

/**
 * NEWS DIRECTION TAGS — pinned against the cases the 2026-10-20 cross-verification
 * audit got wrong, so the fixes cannot erode:
 *
 *   * "stirring up trouble" used to match the bare word "up" and tag a
 *     Middle-East escalation UP;
 *   * a rate CUT read bearish because the bare word "cuts" was in the bear list,
 *     when a cut is usually bullish for equities (and a hike bearish);
 *   * "Shares Fall Despite Record Orders" tied and read MIXED when the market
 *     had already answered the record orders — the stock's own move now
 *     outranks everything else;
 *   * "record loss" used to match the bare word "record".
 *
 * The empirical side (tags vs realized market-adjusted returns) lives in
 * scratch/news_tag_audit.js; this file pins the SEMANTIC rules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../common/news/newsStore');

const CASES = [
  // the audit's concrete failures
  ['Conflict in the Middle East escalates, Trump says Houthi rebels are deliberately stirring up trouble', 'DOWN'],
  ['Bond yields rise to 7.27%, rupee declines as RBI hikes rates by 25 bps', 'DOWN'],
  ['RBI cuts repo rate by 25 bps, keeps stance neutral', 'UP'],
  ['ABB Shares Fall Despite Record Orders', 'DOWN'],
  ['Gartner warns AI data center capex is unsustainable as $3.5T write-down risk looms', 'DOWN'],
  // direction reads that must keep working
  ['TCS Q2 profit jumps 22% beats estimates', 'UP'],
  ['Oil prices rise near five-month high as traders weigh Middle East risks', 'UP'],
  ['Infosys downgraded by Morgan Stanley on weak demand', 'DOWN'],
  ['Sebi approves new F&O norms for brokers', 'UP'],
  ['Zomato shares surge 8% as brokerages upgrade stock', 'UP'],
  ['ONGC shares rise 3% as crude climbs past $110', 'UP'],
  ['Market wrap: Sensex falls 400 pts, Nifty tests 24,000', 'DOWN'],
  ['Fed keeps rates unchanged, signals caution', 'NEUTRAL'],
  ['Promoter stake in XYZ rises to 52% from 48%', 'UP'],
];

test('every audited headline reads the intended direction', () => {
  for (const [title, want] of CASES) {
    assert.equal(store.directionOf(title), want, title);
  }
});

test('an empty headline is NEUTRAL, not UP or DOWN', () => {
  assert.equal(store.directionOf(''), 'NEUTRAL');
  assert.equal(store.directionOf(null), 'NEUTRAL');
});

test('alias tagging matches whole words — half-year must not tag HAL', () => {
  // The substring read tagged Hindustan Aeronautics on every "half-year"
  // headline and on Halliburton stories; both were caught by the live signals
  // board before the fix.
  assert.ok(!store.tagSymbols('UK advisory reports half-year profit falls 20%', '').includes('HAL'),
    'a half-year headline must not tag HAL');
  assert.ok(!store.tagSymbols('Halliburton beats expectations with quarterly results', '').includes('HAL'),
    'Halliburton is not Hindustan Aeronautics');
  assert.ok(store.tagSymbols('Hindustan Aeronautics bags order from Indian Air Force', '').includes('HAL'),
    'the real company name must still tag HAL');
});

test('tagging reads the FULL price corpus, not the trimmed scratch one', () => {
  // data/ohlcv_1m was trimmed to 20 files; a recategorize against it silently
  // dropped 15,373 symbol tags to 202. The full corpus must be the one read.
  const syms = store.corpusSymbols();
  assert.ok(syms.size > 100,
    'expected the full corpus, got ' + syms.size + ' symbols — check corpusDir() in newsStore.js');
  assert.ok(syms.has('RELIANCE') || syms.has('INFY'),
    'the household large-caps must be taggable');
});
