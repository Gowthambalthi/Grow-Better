/**
 * strategies/institutionalOF.js — Institutional Order Flow & Trend Engine.
 *
 * Implements:
 * 1. Order Flow Exhaustion on marginal extreme with volume surge (>= 1.7x).
 * 2. Trend alignment on Longs: Close >= EMA20 (prevents counter-trend knife-catching).
 * 3. Prime Morning Liquidity Window (09:25 - 11:00 IST): cuts midday chop.
 * 4. Target Calculator integration (scratch/targetCalculator.js) with 35 bps stop floor and >= 1:1.50 R:R.
 */
'use strict';

const ind = require('../strategy-core/indicators');
const { T } = ind;
const { createSession } = require('../strategy-core/session');
const marketCore = require('../strategy-core/market');
const planner = require('../strategy-core/tradePlanner');
const { calculateTarget } = require('../scratch/targetCalculator');

const NAME = 'Institutional Order Flow Momentum';

const DEFAULTS = {
  enableOF: true,
  minVolRatio: 2.0,
  maxNewExtremeAtr: 0.20,
  maxCloseLoc: 0.35,
  triggerBars: 3,
  cooldownBars: 15,
  maxSignalsPerDay: 1,
  probeLookback: 10,
  minAtrPct: 0.05,
  measuredMoveR: 1.5,
  maxSignalTime: 1100, // 11:00 IST cutoff
  minSignalTime: 925,  // 09:25 IST start
  stopFloorBps: 35,
  minRR: 1.50,
  planner: {
    maxMove3mPct: 2.50,
    maxMove5mPct: 3.50,
    maxVwapDistPct: 2.50,
    maxRangePosPct: 95,
    minAtrPct: 0.10,
    maxAtrPct: 8.00,
    minRR1: 1.20,
    minStopPct: 0.15,
    maxStopPct: 1.50,
  }
};

function computeEma20(tail) {
  if (!tail || tail.length < 20) return null;
  const k = 2 / 21;
  let ema = tail[tail.length - 20][T.CLOSE];
  for (let i = tail.length - 19; i < tail.length; i++) {
    ema = tail[i][T.CLOSE] * k + ema * (1 - k);
  }
  return ema;
}

function detectExhaustion({ bar, market, priorHigh, priorLow, cfg, ema20 }) {
  if (!market || !market.atr) return null;
  if (market.volumeRatio == null || market.volumeRatio < cfg.minVolRatio) return null;

  const loc = ind.closeLocation(bar);
  if (loc == null) return null;
  const maxPush = cfg.maxNewExtremeAtr * market.atr;

  // SHORT: marginal new high that closes back down
  if (priorHigh != null && bar[T.HIGH] > priorHigh && (bar[T.HIGH] - priorHigh) <= maxPush && loc <= cfg.maxCloseLoc) {
    return {
      setup: 'IOF01', label: 'Institutional Exhaustion', side: 'SHORT',
      invalidation: bar[T.HIGH], probed: priorHigh, closeLoc: loc,
      triggerLevel: bar[T.LOW],
    };
  }

  // LONG: marginal new low that closes back up AND satisfies Trend Alignment (Close > EMA20 or Close > VWAP)
  if (priorLow != null && bar[T.LOW] < priorLow && (priorLow - bar[T.LOW]) <= maxPush && loc >= (1 - cfg.maxCloseLoc)) {
    const trendOk = (ema20 != null && bar[T.CLOSE] >= ema20) || (market.vwap != null && bar[T.CLOSE] >= market.vwap);
    if (!trendOk) return null; // Reject counter-trend knife-catch

    return {
      setup: 'IOF01', label: 'Institutional Exhaustion', side: 'LONG',
      invalidation: bar[T.LOW], probed: priorLow, closeLoc: loc,
      triggerLevel: bar[T.HIGH],
    };
  }

  return null;
}

function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;
  let pending = null;

  function emit(found, bar, index, m) {
    const d = ind.dayOf(bar);
    const entry = bar[T.CLOSE];
    const structure = [found.probed];

    // Compute structural stop & target via targetCalculator
    const targetResult = calculateTarget({
      entryPrice: entry,
      vwap: m.vwap,
      currentPrice: entry,
      side: found.side,
      structStopMode: true,
      stopBps: Math.max(cfg.stopFloorBps, Math.round((Math.abs(entry - found.invalidation) / entry) * 10000)),
      structTargetRr: cfg.minRR
    });

    const structureTargets = marketCore.targets({
      side: found.side, entry, market: m, structure, measuredMoveR: cfg.measuredMoveR,
    });
    const risk = Math.abs(entry - (targetResult.stopLoss || found.invalidation));
    const validTargets = risk > 0 ? structureTargets.filter(t => (Math.abs(t - entry) / risk) >= 1.2) : [];
    const targetCandidates = (targetResult && targetResult.target)
      ? [targetResult.target].concat(validTargets)
      : structureTargets;

    const id = found.setup + '-' + (bar.symbol || '') + '-' + d + '-' + bar[T.TIME];
    const evVol = found.eventVolumeRatio == null ? m.volumeRatio : found.eventVolumeRatio;
    const evRangeAtr = found.eventRangeAtr == null ? (m.atr ? (bar[T.HIGH] - bar[T.LOW]) / m.atr : null) : found.eventRangeAtr;

    const base = marketCore.signalBase({
      engine: 'IOF01', setup: found.setup, side: found.side, bar, index, setupId: id,
      market: m, targetCandidates,
      setupData: {
        basis: 'OHLCV proxy with Trend Alignment & Target Calculator',
        setupLabel: found.label,
        probedLevel: found.probed,
        closeLocation: found.closeLoc,
        volumeRatio: evVol,
        triggerVolumeRatio: m.volumeRatio,
        rangeAtr: evRangeAtr,
        atrPct: m.atrPct,
        eventAtrPct: found.eventAtrPct == null ? m.atrPct : found.eventAtrPct,
        invalidation: targetResult.stopLoss || found.invalidation,
        triggerLevel: found.triggerLevel,
        barsToTrigger: pending ? (index - pending.barIndex) : 0,
      },
      extra: { invalidationForFill: targetResult.stopLoss || found.invalidation },
    });

    const built = planner.plan({
      side: found.side, entry, invalidation: targetResult.stopLoss || found.invalidation,
      targets: targetCandidates, market: m, config: cfg.planner,
    });
    if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });

    cooldownUntil = index + cfg.cooldownBars;
    signalsToday += 1;

    const withPlan = marketCore.withPlan(base, built, cfg);
    withPlan.reason = [
      'INSTITUTIONAL EXHAUSTION with trend alignment on ' + evVol.toFixed(2) + 'x volume',
      'TARGET CALCULATOR plan: Stop ' + (targetResult.stopLoss ? targetResult.stopLoss.toFixed(2) : 'n/a') + ', Target ' + (targetResult.target ? targetResult.target.toFixed(2) : 'n/a'),
      'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
    ];
    return withPlan;
  }

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;

    if (session.onBar(bar)) { cooldownUntil = -1; signalsToday = 0; pending = null; }
    if (index < cooldownUntil) return null;

    // Time window gate (09:25 - 11:00 IST)
    const mTime = /(\d{2}):(\d{2})/.exec(String(bar[T.TIME]));
    if (mTime) {
      const tNum = Number(mTime[1]) * 100 + Number(mTime[2]);
      if (tNum < cfg.minSignalTime || tNum > cfg.maxSignalTime) {
        pending = null;
        return null;
      }
    }

    const entry = bar[T.CLOSE];
    const m = marketCore.measure({ session, entry });
    if (signalsToday >= cfg.maxSignalsPerDay) { pending = null; return null; }

    // Check pending event
    if (pending) {
      const p = pending;
      const breached = p.cand.side === 'LONG'
        ? bar[T.LOW] <= p.cand.invalidation
        : bar[T.HIGH] >= p.cand.invalidation;
      if (breached || index > p.expiryIndex) {
        pending = null;
      } else {
        const fired = p.cand.side === 'LONG'
          ? bar[T.CLOSE] > p.triggerLevel
          : bar[T.CLOSE] < p.triggerLevel;
        if (!fired) return null;
        const sig = emit(p.cand, bar, index, m);
        pending = null;
        return sig;
      }
    }

    // Measure lookback extremes
    const before = session.tail.slice(0, session.tail.length - 1);
    if (before.length < cfg.probeLookback) return null;
    const priorHigh = ind.highest(before, cfg.probeLookback);
    const priorLow = ind.lowest(before, cfg.probeLookback);

    if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;

    const ema20 = computeEma20(session.tail);
    const cand = cfg.enableOF ? detectExhaustion({ bar, market: m, priorHigh, priorLow, cfg, ema20 }) : null;
    if (!cand) return null;

    cand.eventVolumeRatio = m.volumeRatio;
    cand.eventRangeAtr = m.atr ? (bar[T.HIGH] - bar[T.LOW]) / m.atr : null;
    cand.eventAtrPct = m.atrPct;

    const expiryBars = cfg.triggerBars;
    pending = { cand, barIndex: index, barTime: bar[T.TIME], triggerLevel: cand.triggerLevel, expiryIndex: index + expiryBars };
    return null;
  }

  return {
    onBar,
    evaluate: (bars, idx) => onBar(bars, idx),
    cfg,
    session,
    state: () => ({ day: session.day, prevDay: session.prevDay, pending }),
  };
}

module.exports = {
  name: NAME,
  createEngine,
  DEFAULTS,
};
