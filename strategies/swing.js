/**
 * strategies/swing.js — SWING ENGINE. VWAP pullback continuation (intraday).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE IS — AND WHY IT IS NOT orderFlow.js
 * ---------------------------------------------------------------------------
 * This file arrived on 2026-10-17 byte-for-byte identical to
 * `strategies/orderFlow.js` apart from its header (97.8% content similarity —
 * strategy-core/engineIdentity.js is what measured it). A copy is not a second
 * strategy, so it was quarantined and this file replaces it with a rule of its
 * own.
 *
 * Despite the filename this is an INTRADAY engine — the shared harness ends
 * every hold at its own session close (rule 5), no registry entry can claim an
 * overnight hold it cannot be measured for, and this file does not pretend
 * otherwise. "SWING" names the move it trades: a single sustained swing away
 * from VWAP within one session, not a multi-day hold.
 *
 * THE RULE, IN ONE LINE: in an established day trend, a pullback that TOUCHES
 * VWAP and is REJECTED back to the trend side is the entry. OF03 fades a
 * failed extreme and CODEX buys a range break; SW01 buys the RESUMPTION — the
 * market returning to fair value and leaving it again. Its invalidation is the
 * extreme of the pullback bar itself: if price re-enters the pullback zone the
 * resumption never happened.
 *
 * SELF-REFERENTIAL CHECK — WHY LOTS OF VOLUME REFUSES HERE: the resumption bar
 * is allowed up to `pullbackMaxVolRatio` × average volume. A resumption on
 * CLIMACTIC volume is a climax, not a resume — that is OF03's territory, and
 * two engines firing on the same bar under opposite theories would be one
 * signal counted twice under two names, which is exactly the failure this
 * engine's predecessor was quarantined for.
 *
 * The feed caveat is the same one every engine here states: Angel One sends
 * resting depth, not executed aggressor volume, so everything below is OHLCV
 * and the signal says so (`setupData.basis`).
 *
 * RESULTS: none are claimed here. Numbers come only from `backtest/runAll.js`
 * under the shared five rules; until an artifact records them,
 * measuredRules() gives trades=0 and this engine may not put a direction on
 * the board (speak=false → the page prints its calls as WATCH).
 */
'use strict';

const ind = require('../strategy-core/indicators');
const planner = require('../strategy-core/tradePlanner');
const marketCore = require('../strategy-core/market');
const { createSession } = require('../strategy-core/session');
const { replay } = require('../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  // --- SW01 gates ---
  claimTolPct: 0.10,          // how far the pullback may protrude past VWAP
  reclaimPct: 0.05,           // the close must be back this far on the trend side
  pullbackMaxVolRatio: 1.5,   // resumption must NOT be climactic (see header)
  minAtrPct: 0.10,            // calibrated for 1m bars (median ATR% ~0.15%)

  cooldownBars: 8,
  maxSignalsPerDay: 3,
  measuredMoveR: 1.5,
  maxSignalTime: 1400,        // no new SW01 signals after 14:00 IST

  // ENGINE-SPECIFIC PLANNER GATE. This engine ENTERS near VWAP by design, so
  // the VWAP extension bound is the meaningful one: the entered bar must be at
  // most `maxVwapDistPct` beyond VWAP in the trade direction — a resumption
  // that has already run 2.5% away is not a pullback entry any more. The ATR
  // floor is recalibrated for 1-minute bars for the same reason stated in
  // strategies/codex.js (median ATR% ~0.15% at a decision bar).
  planner: {
    maxMove3mPct: 1.5,
    maxMove5mPct: 2.5,
    maxVwapDistPct: 0.8,      // tight: by definition we enter right at VWAP
    maxRangePosPct: 90,
    minAtrPct: 0.10,
  },
};

const BASIS = 'OHLCV proxy — best-five depth carries no executed aggressor side';

// ---------------------------------------------------------------------------
// SW01 — the pure detector, no state
// ---------------------------------------------------------------------------

/**
 * Did this CLOSED bar pull back to VWAP and get rejected back into the day
 * trend? Direction comes from where the day already is (close vs VWAP for the
 * trend proxy used: the bar's own close relative to its open — a down bar in
 * an up day is a pullback, an up bar in a down day is the mirror).
 *
 * Returns { side, invalidation, reclaimPct } or null. PURE: same function
 * answers for the harness, the live bridge and the unit tests.
 */
function pullback({ bar, market, cfg }) {
  const vwap = market.vwap;
  if (vwap == null || !isFinite(vwap) || vwap <= 0) return null;
  const hi = bar[T.HIGH], lo = bar[T.LOW], close = bar[T.CLOSE], open = bar[T.OPEN];

  // LONG: the bar dipped into/through VWAP from above (within the claim
  // tolerance) and CLOSED back above it — the pullback was rejected.
  if ((close / open) >= 1) {                       // the day leg is up on this bar
    const dipPct = ((vwap / lo) - 1) * 100;        // how deep VWAP sat above the low
    const reclaimPct = ((close / vwap) - 1) * 100;
    if (lo <= vwap * (1 + cfg.claimTolPct / 100) &&
        dipPct <= (cfg.claimTolPct * 3) &&          // the wick must actually reach VWAP
        reclaimPct >= cfg.reclaimPct) {
      return {
        setup: 'SW01', label: 'VWAP Pullback Resumption', side: 'LONG',
        invalidation: lo, vwap, reclaimPct,
      };
    }
  }
  // SHORT mirror: the bar spiked up into VWAP from below and closed back under.
  if ((close / open) <= 1) {
    const spikePct = ((hi / vwap) - 1) * 100;
    const reclaimPct = ((vwap / close) - 1) * 100;
    if (hi >= vwap * (1 - cfg.claimTolPct / 100) &&
        spikePct <= (cfg.claimTolPct * 3) &&
        reclaimPct >= cfg.reclaimPct) {
      return {
        setup: 'SW01', label: 'VWAP Pullback Resumption', side: 'SHORT',
        invalidation: hi, vwap, reclaimPct,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE ENGINE
// ---------------------------------------------------------------------------

/** Stateless wrapper — one line, shared (strategy-core/replay.js). O(n²). */
function evaluate(bars1m, index, config) { return replay(module.exports, bars1m, index, config); }

/** One pass, O(bars). The object a live loop and a backtest both drive. */
function createEngine(config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  // Day bookkeeping, extremes, rolling tail, VWAP/POC are the shared
  // tracker's job (strategy-core/session.js); this engine keeps cooldowns.
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;

    if (session.onBar(bar)) { cooldownUntil = -1; signalsToday = 0; } // day rollover
    if (index < cooldownUntil) return null;

    if (cfg.maxSignalTime != null) {
      const mTime = /(\d{2}):(\d{2})/.exec(String(bar[T.TIME]));
      if (mTime && Number(mTime[1]) * 100 + Number(mTime[2]) > cfg.maxSignalTime) return null;
    }

    const entry = bar[T.CLOSE];
    const m = marketCore.measure({ session, entry });
    if (m.vwap == null) return null;               // a resumption needs a fair value first
    if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;
    if (signalsToday >= cfg.maxSignalsPerDay) return null;
    if (session.bars.length < 20) return null;     // VVWAP needs a session to mean anything

    const found = pullback({ bar, market: m, cfg });
    if (!found) return null;

    // THE CLIMAX REFUSAL (see header): a resumption bar gushing more than
    // `pullbackMaxVolRatio` × average volume is a climax, not a resume.
    if (m.volumeRatio != null && m.volumeRatio > cfg.pullbackMaxVolRatio) return null;

    const d = ind.dayOf(bar);
    const structure = [found.vwap, session.dayHigh, session.dayLow];
    const targetCandidates = marketCore.targets({
      side: found.side, entry, market: m, structure, measuredMoveR: cfg.measuredMoveR,
    });
    const id = found.setup + '-' + (bar.symbol || '') + '-' + d + '-' + bar[T.TIME];
    const base = marketCore.signalBase({
      engine: 'SWING', setup: found.setup, side: found.side, bar, index, setupId: id,
      market: m, targetCandidates,
      setupData: {
        basis: BASIS,
        setupLabel: found.label,
        vwap: found.vwap,
        reclaimPct: found.reclaimPct,
        volumeRatio: m.volumeRatio,
        rangeAtr: m.atr ? (bar[T.HIGH] - bar[T.LOW]) / m.atr : null,
        atrPct: m.atrPct,
        invalidation: found.invalidation,
      },
      extra: { invalidationForFill: found.invalidation },
    });

    const built = planner.plan({
      side: found.side, entry, invalidation: found.invalidation,
      targets: targetCandidates, market: m, config: cfg.planner,
    });
    if (!built.ok) return Object.assign(base, { ok: false, gate: built.gate, reject: built.reject });

    cooldownUntil = index + cfg.cooldownBars;
    signalsToday += 1;

    const withPlan = marketCore.withPlan(base, built, cfg);
    withPlan.reason = [
      'RESUMPTION — price reclaimed ' + found.reclaimPct.toFixed(2) + '% beyond VWAP at ' + found.vwap.toFixed(2),
      'PULLBACK REJECTED — the extreme of the pullback bar (' + found.invalidation.toFixed(2) + ') is the invalidation',
      'NOT CLIMACTIC — ' + (m.volumeRatio == null ? 'n/a' : m.volumeRatio.toFixed(2)) + '× average volume (ceiling ' + cfg.pullbackMaxVolRatio + '×)',
      'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
      BASIS,
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
  id: 'SWING', setup: 'SW01', name: 'Swing VWAP Pullback (intraday)',
  families: [
    { setup: 'SW01', label: 'VWAP Pullback Resumption' },
  ],
  BASIS, DEFAULTS, evaluate, createEngine, pullback,
};