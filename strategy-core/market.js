/**
 * strategy-core/market.js — the measurements EVERY engine hands to the planner.
 *
 * The Liquidity Sweep engine grew its own copy of this first. Engines 2 and 3
 * need the same numbers (VWAP distance, the 3m/5m move, ATR%, where in the day's
 * range we are), and the planner's extension gate reads exactly these fields. If
 * each engine spelled them differently, "not extended" would mean three things
 * and the backtest could not be compared across engines. So they are spelled
 * once, here.
 *
 * `targets()` is the same idea for the other half of the plan: the opposing
 * prices a target may be drawn from. Any level handed back is a real price that
 * has already printed, plus (when asked) one measured-move projection, which is
 * arithmetic on the structure rather than a level — flagged as such in the plan.
 */
'use strict';

const ind = require('./indicators');
const { T } = ind;

/**
 * The market state at the close of the bar the engine is deciding on.
 *
 * IT READS THE SESSION TRACKER, rather than slicing arrays itself.
 * `strategy-core/session.js` owns the rolling tail (the last ~25 closed bars,
 * which is all atr(…,14), roc(…,5) and volumeRatio(…,20) can read), today's bars,
 * the day's extremes, the previous day, and the two carried measurements — VWAP
 * and POC — that used to be rebuilt from the whole session on every single bar.
 * One tracker, one set of numbers, shared by the live loop, the backtest and the
 * board, so "not extended" cannot mean three different things.
 */
function measure({ session, entry }) {
  const tail = session.tail;
  const dayBars = session.bars;
  const prevDay = session.prevDay;
  const A = ind.atr(tail, 14);
  const V = session.vwap();
  const P = session.poc();
  const dayHigh = session.dayHigh;
  const dayLow = session.dayLow;
  const rangePos = (dayHigh != null && dayLow != null && dayHigh > dayLow)
    ? ((entry - dayLow) / (dayHigh - dayLow)) * 100 : null;
  const r3 = ind.roc(tail, 3), r5 = ind.roc(tail, 5);
  return {
    ltp: entry,
    vwap: V,
    poc: P,
    roc1m: ind.roc(tail, 1),
    roc3m: r3,
    roc5m: r5,
    move3mPct: r3,
    move5mPct: r5,
    vwapDistPct: V ? ((entry / V) - 1) * 100 : null,
    pocDistPct: P ? ((entry / P) - 1) * 100 : null,
    rangePosPct: rangePos,
    atrPct: A ? (A / entry) * 100 : null,
    atr: A,
    volumeRatio: ind.volumeRatio(tail, 20),
    dayHigh, dayLow,
    prevDayHigh: prevDay ? prevDay.high : null,
    prevDayLow: prevDay ? prevDay.low : null,
  };
}

/**
 * Every price a target may be taken from, on the correct side of `entry`.
 * `structure` is the engine's own level set (zones, violated levels, pivots);
 * it is passed in rather than guessed at, because only the engine knows which
 * structure the setup is actually aiming at.
 */
function targets({ side, entry, market, structure, measuredMoveR }) {
  const pool = [];
  const add = (p) => { if (p != null && !isNaN(p)) pool.push(p); };

  add(market.dayHigh);
  add(market.dayLow);
  add(market.prevDayHigh);
  add(market.prevDayLow);
  add(market.vwap);
  add(market.poc);
  for (const p of (structure || [])) add(p);

  if (measuredMoveR != null && market.atr != null) {
    add(side === 'LONG' ? entry + market.atr * measuredMoveR : entry - market.atr * measuredMoveR);
  }

  const ok = (p) => (side === 'LONG' ? p > entry : p < entry);
  const uniq = [];
  for (const p of pool.filter(ok).sort((a, b) => (side === 'LONG' ? a - b : b - a))) {
    if (!uniq.some((u) => Math.abs(u - p) < 0.005)) uniq.push(p);
  }
  return uniq;
}

/** The common shape every engine returns, accepted or refused. */
function signalBase({ engine, setup, side, bar, index, setupId, market, targetCandidates, setupData, extra }) {
  return Object.assign({
    engine, setup, side,
    signalTime: bar[T.TIME], barIndex: index,
    setupId, market, targetCandidates, setupData,
  }, extra || {});
}

/** Attach a planner result to the base signal — refusal and acceptance alike. */
function withPlan(base, built, cfg) {
  if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });
  const p = built.plan;
  return Object.assign(base, {
    ok: true, status: 'TRIGGERED',
    entry: p.entry,
    plan: { entry: p.entry, stop: p.stop, t1: p.t1, rr: p.rr1, riskPct: p.riskPct },
    stop: p.stop, t1: p.t1, t2: p.t2,
    risk: p.risk, riskPct: p.riskPct, rr1: p.rr1, rr2: p.rr2,
    stopBasis: p.stopBasis, targetBasis: p.targetBasis,
    config: cfg,
  });
}

module.exports = { measure, targets, signalBase, withPlan };
