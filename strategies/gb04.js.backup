'use strict';

/**
 * GB04 — previous-day high/low as support and resistance.
 *
 * THE RULE. Price trades through yesterday's low and closes back above it → LONG (the level held
 * as support). Price trades through yesterday's high and closes back below it → SHORT (the level
 * held as resistance).
 *
 * WHAT WAS WRONG (measured 2026-10-20, 40 symbols / 20 sessions):
 *
 *   1. THE STOP WAS THE BAR'S WICK. `invalidation = bar.low` on a reclaim bar. A reclaim bar has
 *      a long wick through the level by construction, so the risk was set by how far the spike
 *      went rather than by where the idea is wrong — and 68-75% of trades stopped out.
 *   2. THE TARGET WAS THE NEAREST STRUCTURE. VWAP and POC usually sit closer than the trade pays
 *      for, so half of all signals (901 of 1,835) died at the fill re-plan as REFILL_RR.
 *   3. The two sides were never separated. They are not the same trade: on that sample the
 *      resistance rejection made PF 1.273 and the support bounce 0.603.
 *
 * WHAT IT IS NOW. Three changes, each addressing one of those, each configurable so the choice
 * can be measured instead of asserted:
 *
 *   * STOP AT THE LEVEL, not the wick: `stopBufferAtr` beyond the previous-day extreme. The risk
 *     is then the distance from the close to the level, which is what the setup actually wagers.
 *   * CONFIRMATION MARGIN: the close must be `confirmAtr` beyond the level, so a one-tick poke
 *     that closes a hair over it is not a reclaim.
 *   * TARGETS THAT PAY: structural levels are offered only if they are at least `targetR` away,
 *     and the measured move at `targetR` is always offered, so `pickTargets()` (which takes the
 *     NEAREST valid candidate) cannot hand the planner something that fails the RR gate.
 *
 * `sides` exists because a side with no edge should be switchable off by the measurement, not
 * quietly carried in production.
 */

const ind = require('../strategy-core/indicators');
const planner = require('../strategy-core/tradePlanner');
const marketCore = require('../strategy-core/market');
const { createSession } = require('../strategy-core/session');
const { replay } = require('../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  cooldownBars: 10,
  maxSignalsPerDay: 3,
  maxSignalTime: 1400,          // no new signals after 14:00 IST
  sides: 'both',                // 'both' | 'long' | 'short'
  confirmAtr: 0.10,             // close must clear the level by this many ATR
  stopBufferAtr: 0.25,          // stop sits this far ATR beyond the level
  targetR: 2.0,                 // minimum measured move, in R
  requireDirectionalClose: true, // LONG bar must close above its open, SHORT below
  // TRADE WITH THE VWAP SIDE, OR NOT AT ALL. Measured on the full corpus, the resistance
  // rejection (SHORT) made +0.12R per trade and the support bounce (LONG) −0.07R; the short
  // side is the one with an edge, and a rejection is a trend-continuation idea. 'aligned'
  // keeps a SHORT only below VWAP and a LONG only above it; 'none' takes every reclaim.
  vwapFilter: 'none',           // 'none' | 'aligned'
  minAtrPct: 0.10,
  planner: { minAtrPct: 0.10 },
};

const BASIS = 'Previous day high/low as real support/resistance';

function evaluate(bars1m, index, config) { return replay(module.exports, bars1m, index, config); }

function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;

  const allowLong = cfg.sides === 'both' || cfg.sides === 'long';
  const allowShort = cfg.sides === 'both' || cfg.sides === 'short';

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;

    if (session.onBar(bar)) {
      cooldownUntil = -1;
      signalsToday = 0;
    }
    if (index < cooldownUntil) return null;

    if (cfg.maxSignalTime != null) {
      const mTime = /(\d{2}):(\d{2})/.exec(String(bar[T.TIME]));
      if (mTime && Number(mTime[1]) * 100 + Number(mTime[2]) > cfg.maxSignalTime) return null;
    }

    const prev = session.prevDay;
    if (!prev) return null;                 // nothing to lean on before the first full day
    if (signalsToday >= cfg.maxSignalsPerDay) return null;

    const close = bar[T.CLOSE];
    const low = bar[T.LOW];
    const high = bar[T.HIGH];
    const open = bar[T.OPEN];
    if (!(close > 0)) return null;

    const m = marketCore.measure({ session, entry: close });
    if (!m || !(m.atr > 0)) return null;
    if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;

    const atr = m.atr;
    const support = prev.low;
    const resistance = prev.high;
    const margin = atr * cfg.confirmAtr;

    let side = null, setup = null, level = null;
    if (allowLong && low < support && close > support + margin &&
      (!cfg.requireDirectionalClose || close > open)) {
      side = 'LONG'; setup = 'RL'; level = support;
    } else if (allowShort && high > resistance && close < resistance - margin &&
      (!cfg.requireDirectionalClose || close < open)) {
      side = 'SHORT'; setup = 'RS'; level = resistance;
    }
    if (!side) return null;
    if (cfg.vwapFilter === 'aligned' && m.vwap != null) {
      if (side === 'SHORT' && !(close < m.vwap)) return null;
      if (side === 'LONG' && !(close > m.vwap)) return null;
    }

    // STOP AT THE LEVEL, NOT THE WICK — see the header.
    const invalidation = side === 'LONG'
      ? level - atr * cfg.stopBufferAtr
      : level + atr * cfg.stopBufferAtr;
    const risk = Math.abs(close - invalidation);
    if (!(risk > 0)) return null;

    // TARGETS THAT PAY. Only levels at least `targetR` away are offered, plus the measured move,
    // so the nearest candidate the planner sees cannot fail the RR gate by construction.
    const minRoom = risk * cfg.targetR;
    const structural = marketCore.targets({ side, entry: close, market: m });
    const farEnough = structural.filter((p) => (side === 'LONG' ? p - close : close - p) >= minRoom);
    const measuredMove = side === 'LONG' ? close + minRoom : close - minRoom;
    const targets = farEnough.length ? farEnough.concat([measuredMove]) : [measuredMove];

    const base = marketCore.signalBase({
      engine: 'GB04',
      setup,
      side,
      bar,
      index,
      setupId: setup + '-' + ind.dayOf(bar) + '-' + bar[T.TIME],
      market: m,
      // NUMBERS, because `backtest/follow.js` re-plans from this array at the fill.
      targetCandidates: targets,
      setupData: { basis: BASIS, level, atr, bufferAtr: cfg.stopBufferAtr, targetR: cfg.targetR },
      extra: { invalidationForFill: invalidation },
    });

    const built = planner.plan({
      side,
      entry: close,
      invalidation,
      targets,
      market: m,
      config: cfg.planner,
    });
    if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });

    cooldownUntil = index + cfg.cooldownBars;
    signalsToday += 1;

    const withPlan = marketCore.withPlan(base, built, cfg);
    withPlan.reason = [
      (side === 'LONG' ? 'SUPPORT HELD — traded through ' : 'RESISTANCE HELD — traded through ') +
        level.toFixed(2) + ' and closed ' + (side === 'LONG' ? 'back above' : 'back below') + ' it',
      'STOP ' + cfg.stopBufferAtr + 'x ATR beyond the level (' + invalidation.toFixed(2) + ')',
      'TARGET at least ' + cfg.targetR + 'R (' + built.plan.t1.toFixed(2) + ')',
      'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
    ];
    return withPlan;
  }

  return {
    onBar,
    evaluate: (bars, idx) => onBar(bars, idx),
    cfg,
    session,
    state: () => ({ day: session.day, prevDay: session.prevDay }),
  };
}

module.exports = {
  id: 'GB04', setup: 'GB04', name: 'GB04: Real Support / Resistance',
  families: [
    { setup: 'GB04', label: 'GB04 Real Support/Resistance' }
  ],
  BASIS, DEFAULTS, evaluate, createEngine
};
