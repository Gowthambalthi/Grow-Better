/**
 * strategies/codex.js — CODEX ENGINE. Opening-range breakout continuation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE IS — AND WHY IT IS NOT orderFlow.js
 * ---------------------------------------------------------------------------
 * This file arrived on 2026-10-17 as a byte-for-byte copy of
 * `strategies/orderFlow.js` with `setup: 'OF03'` renamed to `'CODEX'` (94.8%
 * content similarity — see strategy-core/engineIdentity.js for the measurement).
 * A renamed copy is not a second strategy: it would publish a second row and a
 * second artifact for one rule. It was quarantined, and this file replaces it
 * with a rule that is genuinely its own: a BREAKOUT engine instead of a fade
 * engine.
 *
 * WHERE THE IDEA MATHECTICIAN COMES FROM is the opposite of OF03. OF03 FADES a
 * marginal new extreme that failed to hold — mean reversion. CODEX TRADES THE
 * BREAK of a well-defined range with rising participation — trend continuation.
 * One buys acceptance above a level the market spent the opening minutes
 * discovering; the other sells rejection of a level the market just probed.
 * Two engines can share the harness, the planner and the session tracker and
 * still be opposite theories of where money is made.
 *
 * WHAT THE FEED CAN AND CANNOT SEE is unchanged from engine 3: Angel One's
 * best-five packet is resting depth, not executed aggressor volume, so this
 * engine reads OHLCV only and says so on every signal (`setupData.basis`).
 *
 * ---------------------------------------------------------------------------
 * ORB01 — OPENING-RANGE BREAKOUT CONTINUATION (1-minute bars, closed only)
 * ---------------------------------------------------------------------------
 * The opening range is the first `openingRangeMinutes` (15) minutes of the
 * session — computed by the shared tracker (strategy-core/session.js), same
 * number for live, replay and the board.
 *
 * A bar CLOSES beyond an edge of that range by at least `minBreakPct`, with
 * participation at `orbMinVolRatio` × its own recent average — the break must
 * be paid for. The edge itself becomes the invalidation: a close back inside
 * the range without follow-through is exactly the failed breakout this setup
 * is not. One decision per bar, `cooldownBars` between signals,
 * `maxSignalsPerDay` per symbol/day, and a no-new-signals-after cutoff
 * (`maxSignalTime`) so an evening gap-fill "break" of a range formed hours ago
 * never becomes a call.
 *
 * DEVIATION FROM THE BACKTEST WARM-UP, STATED: the harness warms 60 minutes
 * before the first decision bar. The live bridge (liveMinuteEngine.bridgeSig)
 * mirrors that exactly — the engine's first decision bar is index 60 of its
 * day, so a setup measured at 10:15 sees the same opening range live.
 *
 * RESULTS: nothing here is claimed. An engine's numbers come only from
 * `backtest/runAll.js` under the shared five rules; until an artifact records
 * it, the registry's measuredRules() gives it trades=0 and it may NOT put a
 * direction on the board (speak=false → the page prints its calls as WATCH).
 */
'use strict';

const ind = require('../strategy-core/indicators');
const planner = require('../strategy-core/tradePlanner');
const marketCore = require('../strategy-core/market');
const { createSession } = require('../strategy-core/session');
const { replay } = require('../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  // --- the range itself (shared tracker: openingRangeMinutes) ---
  openingRangeMinutes: 15,

  // --- ORB01 gates ---
  minBreakPct: 0.10,        // close must exceed the edge by ≥ this share of price
  orbMinVolRatio: 1.4,      // the break must be paid for with participation
  minAtrPct: 0.10,          // calibrated for 1m bars (median ATR% ~0.15%)

  cooldownBars: 10,
  maxSignalsPerDay: 3,
  measuredMoveR: 1.5,
  maxSignalTime: 1400,      // no new ORB signals after 14:00 IST

  // ENGINE-SPECIFIC PLANNER GATE. Defaults would refuse a valid break: the
  // shared 0.60% ATR floor was calibrated against a late-entry engine, and at
  // 1-minute resolution the median ATR% is ~0.15%, so that floor alone turned
  // nearly every break off. The other bounds stay TIGHTER than the shared
  // defaults — a breakout is by definition already extended at entry, so the
  // extension gate has to be the thing that refuses the LATE ones.
  planner: {
    maxMove3mPct: 1.5,
    maxMove5mPct: 2.5,
    maxVwapDistPct: 2.0,
    maxRangePosPct: 90,
    minAtrPct: 0.10,
  },
};

const BASIS = 'OHLCV proxy — best-five depth carries no executed aggressor side';

// ---------------------------------------------------------------------------
// ORB01 — the pure detector, no state
// ---------------------------------------------------------------------------

/**
 * Did this CLOSED bar break out of the opening range with participation?
 *
 * Returns { side, invalidation, edge, penetrationPct } or null. PURE: same
 * function answers for the harness, the live bridge and the unit tests.
 */
function breakout({ bar, market, or, cfg }) {
  if (!or || or.high == null || or.low == null || or.high <= or.low) return null;
  if (market.volumeRatio == null || market.volumeRatio < cfg.orbMinVolRatio) return null;
  const close = bar[T.CLOSE];
  const penLong = ((close / or.high) - 1) * 100;
  const penShort = ((close / or.low) - 1) * -100;

  // LONG: the close accepts ABOVE the range's high.
  if (penLong >= cfg.minBreakPct) {
    return {
      setup: 'ORB01', label: 'Opening Range Breakout Continuation', side: 'LONG',
      invalidation: or.high, edge: or.high, penetrationPct: penLong,
    };
  }
  // SHORT: the close accepts BELOW the range's low.
  if (penShort >= cfg.minBreakPct) {
    return {
      setup: 'ORB01', label: 'Opening Range Breakout Continuation', side: 'SHORT',
      invalidation: or.low, edge: or.low, penetrationPct: penShort,
    };
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
  // Day bookkeeping, extremes, previous day, rolling tail and the opening
  // range itself are the shared tracker's job (see strategy-core/session.js);
  // this engine keeps only its own cooldowns.
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
    if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;
    if (signalsToday >= cfg.maxSignalsPerDay) return null;

    // THE RANGE MUST BE CLOSED: the decision bar must sit strictly AFTER the
    // probe window (and there must be a range at all — early bars have none).
    const orInfo = session.openingRange;
    if (!orInfo || session.bars.length <= cfg.openingRangeMinutes) return null;

    const found = breakout({ bar, market: m, or: orInfo, cfg });
    if (!found) return null;

    const d = ind.dayOf(bar);
    const structure = [orInfo.high, orInfo.low, session.dayHigh];
    const targetCandidates = marketCore.targets({
      side: found.side, entry, market: m, structure, measuredMoveR: cfg.measuredMoveR,
    });
    const id = found.setup + '-' + (bar.symbol || '') + '-' + d + '-' + bar[T.TIME];
    const base = marketCore.signalBase({
      engine: 'CODEX', setup: found.setup, side: found.side, bar, index, setupId: id,
      market: m, targetCandidates,
      setupData: {
        basis: BASIS,
        setupLabel: found.label,
        openingRangeHigh: orInfo.high,
        openingRangeLow: orInfo.low,
        penetrationPct: found.penetrationPct,
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
      'BREAKOUT — the close accepted ' + found.penetrationPct.toFixed(2) + '% beyond the ' +
        (found.side === 'LONG' ? 'opening-range HIGH ' : 'opening-range LOW ') + found.edge.toFixed(2),
      'PAID FOR — ' + (m.volumeRatio == null ? 'n/a' : m.volumeRatio.toFixed(2)) + '× average volume on the break bar',
      'THE RANGE ITSELF IS THE INVALIDATION — ' + found.invalidation.toFixed(2),
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
  id: 'CODEX', setup: 'ORB01', name: 'CodeX Opening Range (ORB)',
  families: [
    { setup: 'ORB01', label: 'Opening Range Breakout Continuation' },
  ],
  BASIS, DEFAULTS, evaluate, createEngine, breakout,
};