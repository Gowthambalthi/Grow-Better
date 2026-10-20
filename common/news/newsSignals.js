'use strict';

/**
 * common/news/newsSignals.js — THE ONE IMPLEMENTATION of the stock-lean board.
 *
 * `/api/news/signals` (Server.js), the morning Telegram digest
 * (common/scheduler/cronJobs.js) and the tests all read THIS. Two copies of the
 * reliability rule is two chances for the page and the phone to disagree about
 * which headlines may speak — the same failure `strategy-core/engines.js`
 * exists to prevent for the strategy registry.
 *
 * A lean is a (category, direction) class that MEASURED an edge in the event
 * study (data/news/reaction.json, learning window ≤ 2026-05-29): at least
 * MIN_EVENTS events, at least MIN_HIT_RATE of them right (direction-adjusted —
 * `posRate` is the share with positive abnormal return, so a DOWN class's hit
 * rate is its complement), and the mean abnormal return on the tag's side.
 * Everything else stays a headline; macro categories never lean on one stock.
 */

const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, '..', '..', 'data', 'news', 'lean_policy.json');

const MIN_EVENTS = 30;
const MIN_HIT_RATE = 0.55;

// The trade rule, measured by scripts/news_lean_backtest.js (2026-10-20) and
// written to lean_policy.json by it. These defaults are the fallback until a
// measurement says otherwise — they are NOT a claim of measurement.
const DEFAULT_POLICY = {
  slPct: 1.5,
  horizon: 1,
  skip: { none: true },
  measuredAt: null,
  note: 'no backtest result on disk — showing the fallback rule, not a measured one',
};

/** The measured trade rule, or the honest fallback. */
function readPolicy() {
  try {
    const p = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
    if (p && typeof p.slPct === 'number') return Object.assign({}, DEFAULT_POLICY, p);
  } catch (e) { /* no measurement yet */ }
  return Object.assign({}, DEFAULT_POLICY);
}

/**
 * `classes[key]` — measured reliability of a (category, direction) class, or
 * false when it may not produce a lean.
 */
function makeReliable(reaction) {
  const cache = {};
  return function reliable(cat, dir) {
    const key = cat + '_' + dir;
    if (cache[key] !== undefined) return cache[key];
    const c = reaction && reaction.byCategory && reaction.byCategory[cat];
    const d = c && c.byDirection && c.byDirection[dir];
    const h0 = d && d.horizons && d.horizons[0];
    const hit = h0 ? (dir === 'UP' ? h0.posRate : 1 - h0.posRate) : 0;
    const ok = !!(h0 && h0.n >= MIN_EVENTS && hit >= MIN_HIT_RATE &&
      (dir === 'UP' ? h0.mean > 0 : h0.mean < 0));
    cache[key] = ok ? { n: h0.n, hitRate: hit, meanAr: h0.mean } : false;
    return cache[key];
  };
}

const MACRO = new Set(['oil', 'war', 'fed']);

/**
 * @param {Array} items    stored headlines (newsStore.readItems())
 * @param {Object} reaction data/news/reaction.json (newsStore.readReaction())
 * @param {number} days    lookback window (1–14)
 * @param {Date}  now      injectable clock for tests
 */
function computeSignals(items, reaction, days, now) {
  const win = Math.min(Math.max(Number(days) || 3, 1), 14);
  const clock = now || new Date();
  const since = new Date(clock.getTime() - win * 86400000).toISOString().slice(0, 10);
  const reliable = makeReliable(reaction);

  const classes = {};
  const bySymbol = new Map();
  const marketContext = [];

  for (const it of items) {
    if (it.date < since) continue;
    if (MACRO.has(it.category) && marketContext.length < 10) {
      marketContext.push({ date: it.date, category: it.category, direction: it.direction, title: it.title, url: it.url });
    }
    if (!(it.symbols || []).length) continue;
    if (it.direction !== 'UP' && it.direction !== 'DOWN') continue;
    const cls = reliable(it.category, it.direction);
    if (!cls) continue;
    classes[it.category + '_' + it.direction] = cls;
    for (const sym of it.symbols) {
      let e = bySymbol.get(sym);
      if (!e) { e = { symbol: sym, headlines: [] }; bySymbol.set(sym, e); }
      if (e.headlines.length < 4) {
        e.headlines.push({ date: it.date, category: it.category, direction: it.direction, title: it.title, url: it.url });
      }
    }
  }

  const stocks = [...bySymbol.values()].map((e) => {
    e.headlines.sort((a, b) => (a.date < b.date ? 1 : -1));
    const top = e.headlines[0];
    const cls = reliable(top.category, top.direction);
    return {
      symbol: e.symbol, lean: top.direction, date: top.date, category: top.category,
      title: top.title, url: top.url,
      hitRate: cls.hitRate, meanAr: cls.meanAr, classN: cls.n,
      headlines: e.headlines,
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));

  return {
    generatedAt: clock.toISOString(),
    windowDays: win, since,
    classes, stocks, marketContext,
    policy: readPolicy(),
    note: 'A lean is a headline tag with its MEASURED hit rate beside it — how often that ' +
      '(category, direction) class beat the market on its news day (learning window ≤ 2026-05-29). ' +
      'A lean is a probability, not a signal, and trades nothing.',
  };
}

module.exports = { computeSignals, makeReliable, readPolicy, POLICY_FILE, MIN_EVENTS, MIN_HIT_RATE, DEFAULT_POLICY };
