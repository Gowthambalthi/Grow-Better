/**
 * strategies/grow/grow1.js - GROW 1.2: EMA Pullback & Trend Continuation
 *
 * WHAT 1.2 CHANGED, AND WHY (measured 2026-10-23, see docs/GROW1-BACKTEST-2026-10-23.md)
 *
 * 1.1 entered on a retest of the EMA9/EMA21 pocket with a 1.0x ATR stop and a 2.5x ATR
 * target. Replayed through the shipped harness that is a LOSS: 81 trades on 20 symbols /
 * 580 sessions, 23.5% win, grossPF 0.695, −0.318R per trade AFTER 0.05% cost.
 *
 * The reason is geometric, not incidental. A 2.5R target breaks even at 28.6% and the
 * setup hit it 20%; at 1.5R it breaks even at 40% and the setup hit 39%. Across three
 * target levels the hit rate TRACKS the breakeven line instead of beating it, which is
 * the signature of an entry with no edge rather than of a badly tuned one. Two changes
 * were kept because their sign agreed in BOTH samples (the tuning set AND a disjoint
 * symbol set in a later period, 158 trades together):
 *
 *   - target 2.5x ATR -> 1.75x ATR   (in-sample −0.318R -> −0.163R, OOS −0.275R -> −0.050R)
 *   - volumeRatioMin 1.2 -> 1.0       (a pullback that arrives on a volume SURGE is the
 *                                      worse half of the sample; the "surge confirmation"
 *                                      in 1.1's header was selecting against the setup)
 *
 * THIS MODULE IS STILL NOT PROFITABLE. 1.2 is −0.163R in-sample and −0.050R out-of-sample
 * at 0.05% cost: it bleeds less, it does not earn. Do not treat it as an armed edge, and
 * do not quote a positive number for it — there is no measured window in which it is one.
 *
 * What is unchanged and still true: the value-pocket retest, VWAP alignment, the ATR floor,
 * the blocked midday window, and one signal per day per symbol.
 */
'use strict';

const ind = require('../../strategy-core/indicators');
const planner = require('../../strategy-core/tradePlanner');
const marketCore = require('../../strategy-core/market');
const { createSession } = require('../../strategy-core/session');
const { replay } = require('../../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  emaFast: 9,
  emaSlow: 21,
  atrPeriod: 14,
  atrMultSL: 1.0,
  atrMultTP: 1.75,
  minAtrPct: 0.50,
  maxAtrPct: 5.0,
  volumeRatioMin: 1.0,
  cooldownBars: 10,
  maxSignalsPerDay: 2,
  minSignalTime: 925,
  maxSignalTime: 1445,
  blockedStart: 1130,
  blockedEnd: 1315,
  trailingBreakevenR: 1.0,
  sides: 'both',
  minEmaSepPct: 0.20,
  minAdx: 0,
  adxPeriod: 14,
  planner: {
    minRR1: 1.5,
    stopBufferPct: 0,
    minStopPct: 0.15,
    maxMove3mPct: 2.5,
    maxMove5mPct: 3.5,
    maxVwapDistPct: 2.5,
    maxRangePosPct: 92,
    minAtrPct: 0.50,
  },
};

const BASIS = 'GROW 1.2: EMA(9/21) Value Pocket Pullback with VWAP confirmation (no measured edge)';

function inEntryWindow(tStr, minT, maxT) {
  const m = /(\d{2}):(\d{2})/.exec(String(tStr));
  if (!m) return false;
  const num = Number(m[1]) * 100 + Number(m[2]);
  return num >= minT && num <= maxT;
}

function inBlockedTime(tStr, bStart, bEnd) {
  const m = /(\d{2}):(\d{2})/.exec(String(tStr));
  if (!m) return false;
  const num = Number(m[1]) * 100 + Number(m[2]);
  return num >= bStart && num <= bEnd;
}

/**
 * Wilder's ADX at `index`, read from the full bar series.
 */
function adxAt(bars, index, period) {
  const p = Math.max(2, period | 0);
  const start = index - 2 * p;
  if (start < 1) return null;
  const trs = [], plus = [], minus = [];
  for (let i = start; i <= index; i++) {
    const h = bars[i][T.HIGH], l = bars[i][T.LOW], pc = bars[i - 1][T.CLOSE];
    const ph = bars[i - 1][T.HIGH], pl = bars[i - 1][T.LOW];
    const up = h - ph, dn = pl - l;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    plus.push(up > dn && up > 0 ? up : 0);
    minus.push(dn > up && dn > 0 ? dn : 0);
  }
  let sTR = 0, sP = 0, sM = 0;
  for (let i = 0; i < p; i++) { sTR += trs[i]; sP += plus[i]; sM += minus[i]; }
  const dx = [];
  const push = () => {
    const pdi = sTR > 0 ? (100 * sP) / sTR : 0;
    const mdi = sTR > 0 ? (100 * sM) / sTR : 0;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0);
  };
  push();
  for (let i = p; i < trs.length; i++) {
    sTR = sTR - sTR / p + trs[i];
    sP = sP - sP / p + plus[i];
    sM = sM - sM / p + minus[i];
    push();
  }
  if (dx.length < p) return null;
  let a = 0;
  for (let i = 0; i < p; i++) a += dx[i];
  a /= p;
  for (let i = p; i < dx.length; i++) a = (a * (p - 1) + dx[i]) / p;
  return a;
}

function evaluate(bars1m, index, config) {
  return replay(module.exports, bars1m, index, config);
}

function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {}, {
    planner: Object.assign({}, DEFAULTS.planner, (config && config.planner) || {}),
  });
  const sideAllowed = (s) => cfg.sides === 'both' || cfg.sides === s.toLowerCase();
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;
  let emaFast = null, emaSlow = null;
  let barsSeen = 0, sumClose = 0, initialized = false;

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;
    const d = ind.dayOf(bar);

    const dayChanged = session.onBar(bar);
    if (dayChanged) {
      cooldownUntil = -1;
      signalsToday = 0;
      emaFast = null;
      emaSlow = null;
      barsSeen = 0;
      sumClose = 0;
      initialized = false;
    }

    if (index < cooldownUntil) return null;
    if (signalsToday >= cfg.maxSignalsPerDay) return null;

    const tStr = bar[T.TIME];
    if (!inEntryWindow(tStr, cfg.minSignalTime, cfg.maxSignalTime)) return null;
    if (inBlockedTime(tStr, cfg.blockedStart, cfg.blockedEnd)) return null;

    const close = bar[T.CLOSE];
    const open = bar[T.OPEN];
    const high = bar[T.HIGH];
    const low = bar[T.LOW];
    if (!(close > 0)) return null;

    if (!initialized) {
      barsSeen += 1;
      sumClose += close;
      if (barsSeen < cfg.emaSlow) return null;
      const sma = sumClose / barsSeen;
      emaFast = sma;
      emaSlow = sma;
      initialized = true;
      return null;
    }

    emaFast = (close - emaFast) * (2 / (cfg.emaFast + 1)) + emaFast;
    emaSlow = (close - emaSlow) * (2 / (cfg.emaSlow + 1)) + emaSlow;

    const m = marketCore.measure({ session, entry: close });
    if (!m || !(m.atr > 0) || !m.vwap) return null;

    if (m.atrPct == null || m.atrPct < cfg.minAtrPct || m.atrPct > cfg.maxAtrPct) return null;
    if (m.volumeRatio == null || m.volumeRatio < cfg.volumeRatioMin) return null;

    const isBullTrend = emaFast > emaSlow && close > m.vwap && emaFast > m.vwap;
    const isBearTrend = emaFast < emaSlow && close < m.vwap && emaFast < m.vwap;

    let side = null;
    if (isBullTrend) {
      const touchedPocket = low <= emaFast && low >= emaSlow * 0.998;
      const closedStrong = close > open && close > emaFast;
      if (touchedPocket && closedStrong) side = 'LONG';
    } else if (isBearTrend) {
      const touchedPocket = high >= emaFast && high <= emaSlow * 1.002;
      const closedWeak = close < open && close < emaFast;
      if (touchedPocket && closedWeak) side = 'SHORT';
    }

    if (!side) return null;
    if (!sideAllowed(side)) return null;

    if (cfg.minEmaSepPct > 0) {
      const sep = Math.abs((emaFast / emaSlow - 1) * 100);
      if (sep < cfg.minEmaSepPct) return null;
    }
    if (cfg.minAdx > 0) {
      const a = adxAt(bars, index, cfg.adxPeriod);
      if (a == null || a < cfg.minAdx) return null;
    }

    const atr = m.atr;
    const invalidation = side === 'LONG'
      ? close - atr * cfg.atrMultSL
      : close + atr * cfg.atrMultSL;

    const targetPrice = side === 'LONG'
      ? +(close + atr * cfg.atrMultTP).toFixed(2)
      : +(close - atr * cfg.atrMultTP).toFixed(2);

    const setupId = 'GROW1.1-' + (bar.symbol || '') + '-' + d + '-' + tStr;
    const base = marketCore.signalBase({
      engine: 'GROW',
      setup: 'GROW1.1',
      side,
      bar,
      index,
      setupId,
      market: m,
      targetCandidates: [targetPrice],
      setupData: {
        basis: BASIS,
        emaFast,
        emaSlow,
        atr,
        atrMultSL: cfg.atrMultSL,
        atrMultTP: cfg.atrMultTP,
        volumeRatio: m.volumeRatio,
        targetBasis: 'measured move ' + cfg.atrMultTP + 'x ATR',
        trailingBreakevenR: cfg.trailingBreakevenR,
      },
      extra: { invalidationForFill: invalidation },
    });

    const built = planner.plan({
      side,
      entry: close,
      invalidation,
      targets: [targetPrice],
      market: m,
      config: cfg.planner,
    });

    if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });

    cooldownUntil = index + cfg.cooldownBars;
    signalsToday += 1;

    return marketCore.withPlan(base, built, cfg);
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
  id: 'GROW',
  setup: 'GROW1.1',
  name: 'GROW 1.2 EMA Pullback Trend Follower',
  families: [{ setup: 'GROW1.1', label: 'GROW 1.2: EMA(9/21) Value Pocket Pullback' }],
  BASIS,
  DEFAULTS,
  evaluate,
  createEngine,
  adxAt,
};
