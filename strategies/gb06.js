'use strict';

/**
 * GB06 — EMA(9)/EMA(21) crossover scalping.
 *
 * WHAT WAS WRONG. The strategy could not take a single trade. It fired 8,255 signals over 20
 * sessions and the planner refused every one of them with `TARGET`, because the target it
 * handed the planner was
 *
 *     LONG:  bar.high - 0.1 * ATR
 *
 * which on a bar that closed off its high sits BELOW the entry — a target on the wrong side of
 * the trade. Two other things were hiding behind that: an `atrScaleFactor = 20` that multiplied
 * the measured ATR (and ATR%) by twenty so the shared `minAtrPct: 0.60` floor would pass, which
 * inflated every stop it produced, and a `detectSignal()` stub that always returned null.
 *
 * WHAT IT IS NOW. The rule the registry describes: cross of a fast and a slow EMA, a stop one
 * ATR beyond the entry, a target two ATR beyond it, at most two trades a day, a ten-bar
 * cooldown, nothing after 14:00 IST. Every number the planner sees is a measured number.
 *
 * THE ATR FLOOR IS CALIBRATED, NOT SCALED. `atrPct` is a true percent (ATR / entry * 100). On
 * one-minute bars the median at a decision bar is ~0.15%, so the shared 0.60% floor refuses
 * almost everything — `strategies/orderFlow.js` recalibrated the same floor to 0.10% for the
 * same reason. Multiplying the ATR instead would corrupt the stop; overriding the floor changes
 * only which bars are considered tradable, and it says so.
 *
 * THE TARGET IS THE MEASURED MOVE, AND ONLY THE MEASURED MOVE. `pickTargets()` takes the
 * NEAREST candidate that is on the right side of the entry, so offering structural levels
 * (VWAP, POC, the day's high) would make the nearest one the pick and the RR check would refuse
 * the trade — which is exactly the trap this strategy was stuck in. An ATR-based system aims at
 * an ATR-based target: RR is then `atrMultiplierTP / atrMultiplierSL` by construction, and the
 * plan's `targetBasis` says it is a projection rather than a level that printed.
 */

const ind = require('../strategy-core/indicators');
const planner = require('../strategy-core/tradePlanner');
const marketCore = require('../strategy-core/market');
const { createSession } = require('../strategy-core/session');
const { replay } = require('../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  emaFast: 9,
  emaSlow: 21,
  // STOP AND TARGET IN ATR. 1.0 / 2.0 is RR 2 before the planner's own clamps, which is above
  // its 1.2 floor. Both are config so the pair can be measured rather than asserted.
  atrMultiplierSL: 1.0,
  atrMultiplierTP: 2.0,
  cooldownBars: 10,
  maxSignalsPerDay: 2,
  maxSignalTime: 1400, // 14:00 IST, no new signals after
  planner: {
    // See the header: 1-minute ATR% medians ~0.15%, so the shared 0.60% floor is not usable here.
    minAtrPct: 0.10,
  },
};

const BASIS = 'EMA Crossover Scalping';

function evaluate(bars1m, index, config) { return replay(module.exports, bars1m, index, config); }

function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;
  let emaFast = null, emaSlow = null;
  let prevEmaFast = null, prevEmaSlow = null;
  let barsSeen = 0;
  let sumClose = 0;
  let initialized = false;

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;
    const dayChanged = session.onBar(bar);
    if (dayChanged) {
      cooldownUntil = -1;
      signalsToday = 0;
      emaFast = null;
      emaSlow = null;
      prevEmaFast = null;
      prevEmaSlow = null;
      barsSeen = 0;
      sumClose = 0;
      initialized = false;
    }
    if (index < cooldownUntil) return null;
    if (signalsToday >= cfg.maxSignalsPerDay) return null;

    const close = bar[T.CLOSE];
    if (!(close > 0)) return null;

    // Seed both EMAs from the SMA of the first `emaSlow` bars, then walk them forward.
    if (!initialized) {
      barsSeen += 1;
      sumClose += close;
      if (barsSeen < cfg.emaSlow) return null;
      const sma = sumClose / barsSeen;
      emaFast = sma;
      emaSlow = sma;
      initialized = true;
      return null;   // the seed bar has no previous value, so it cannot be a cross
    }

    prevEmaFast = emaFast;
    prevEmaSlow = emaSlow;
    emaFast = (close - emaFast) * (2 / (cfg.emaFast + 1)) + emaFast;
    emaSlow = (close - emaSlow) * (2 / (cfg.emaSlow + 1)) + emaSlow;

    // A CROSS NEEDS TWO VALUES. `null <= null` is true in JS, so without this guard the bar
    // after the seed compares an EMA against nothing.
    if (prevEmaFast == null || prevEmaSlow == null) return null;

    const bullish = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
    const bearish = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;
    if (!bullish && !bearish) return null;

    // Time filter, read off the bar's own clock.
    if (cfg.maxSignalTime != null) {
      const mTime = /(\d{2}):(\d{2})/.exec(String(bar[T.TIME]));
      if (mTime && Number(mTime[1]) * 100 + Number(mTime[2]) > cfg.maxSignalTime) return null;
    }

    const market = marketCore.measure({ session, entry: close });
    if (!market || !(market.atr > 0)) return null;

    const atr = market.atr;
    const side = bullish ? 'LONG' : 'SHORT';
    const invalidation = side === 'LONG'
      ? close - atr * cfg.atrMultiplierSL
      : close + atr * cfg.atrMultiplierSL;
    // The target is a MEASURED MOVE on the same scale as the stop — never a structural level
    // nearer than the RR floor, which is what made every signal unplannable before.
    const targetPrice = side === 'LONG'
      ? close + atr * cfg.atrMultiplierTP
      : close - atr * cfg.atrMultiplierTP;

    const d = ind.dayOf(bar);
    const base = marketCore.signalBase({
      engine: 'GB06',
      setup: 'EMA01',
      side,
      bar,
      index,
      setupId: 'EMA01-' + d + '-' + bar[T.TIME],
      market,
      // NUMBERS, NOT OBJECTS — AND THIS ONE IS LOAD-BEARING. `backtest/follow.js` re-derives
      // the plan at the FILL by handing `signal.targetCandidates` straight back to the planner,
      // so an object here makes `isNaN()` true at the fill and every trade dies as
      // REFILL_TARGET (1,362 of 1,386 signals, measured). The target's description lives in
      // `setupData`/`reason` instead, where nothing parses it.
      targetCandidates: [targetPrice],
      setupData: { basis: BASIS, atr, emaFast, emaSlow, targetBasis: 'measured move ' + cfg.atrMultiplierTP + 'x ATR' },
      extra: { invalidationForFill: invalidation },
    });

    // `targets` IS A LIST OF NUMBERS. `pickTargets()` runs `isNaN()` on each entry, and
    // `isNaN({ price: ... })` is TRUE — passing the reporting objects here throws the target
    // away as "not a number" and the plan is refused with gate TARGET, which is the same
    // zero-signal outcome by a different route. The objects live in `targetCandidates`, which is
    // for the record; the planner gets prices.
    const built = planner.plan({
      side,
      entry: close,
      invalidation,
      targets: [targetPrice],
      market,
      config: cfg.planner,
    });

    if (!built.ok) {
      return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });
    }

    cooldownUntil = index + cfg.cooldownBars;
    signalsToday += 1;

    const withPlan = marketCore.withPlan(base, built, cfg);
    withPlan.reason = [
      'EMA CROSSOVER — fast ' + cfg.emaFast + ' crossed ' + (bullish ? 'above' : 'below') +
        ' slow ' + cfg.emaSlow + ' (fast ' + emaFast.toFixed(4) + ', slow ' + emaSlow.toFixed(4) + ')',
      'STOP ' + cfg.atrMultiplierSL + 'x ATR (' + atr.toFixed(4) + ') beyond the close',
      'TARGET ' + cfg.atrMultiplierTP + 'x ATR — a measured move, not a printed level',
      'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
    ];
    return withPlan;
  }

  return {
    onBar,
    evaluate: (bars, idx) => onBar(bars, idx),
    cfg,
    session,
    state: () => ({ day: session.day, prevDay: session.prevDay, emaFast, emaSlow }),
  };
}

module.exports = {
  id: 'GB06',
  setup: 'EMA01',
  name: 'GB06 EMA Crossover Scalping Strategy',
  families: [
    { setup: 'EMA01', label: 'GB06: EMA Crossover (9/21)' },
  ],
  BASIS,
  DEFAULTS,
  evaluate,
  createEngine,
};
