/**
 * strategies/orderFlow.js — ENGINE 3. Absorption and aggressive continuation.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS ENGINE CAN AND CANNOT SEE — READ THIS FIRST
 * ---------------------------------------------------------------------------
 * Angel One's best-five packet is RESTING ORDER-BOOK DEPTH. It is not executed
 * aggressor volume: the broker does not send a trade-side field at all. So a
 * literal order-flow engine — "who hit the bid" — cannot be built on today's
 * feed, and any claim to the contrary would be a fabrication. This engine is an
 * OHLCV PROXY for the two order-flow ideas the project spec names, and it says
 * so on every signal (`setupData.basis`).
 *
 * What the proxy uses instead is the one honest tell in a single bar: LOTS of
 * volume with LITTLE travel means someone absorbed the other side, and lots of
 * volume with a CLOSE AT THE EXTREME means nobody did.
 *
 * ---------------------------------------------------------------------------
 * THE RULES, IN ORDER (1-minute bars, closed only)
 * ---------------------------------------------------------------------------
 * OF01 ABSORPTION REVERSAL — a raid that was met.
 *    - the bar must trade on at least `minVolRatio` × its own recent average;
 *    - its range must stay UNDER `absorbMaxRangeAtr` × ATR. Size, no travel.
 *    - it must PROBE a prior extreme: its low at/below the lowest low of the
 *      previous `probeLookback` bars (LONG), or its high at/above the highest
 *      high (SHORT);
 *    - and it must CLOSE BACK on the other side of that extreme, in the top
 *      (LONG) or bottom (SHORT) `minCloseLoc` share of its own range. That
 *      close is the absorption; a close through the level is a breakout.
 *    - entry = that close. Invalidation = that bar's own extreme.
 *
 * OF02 AGGRESSIVE BREAKOUT CONTINUATION — a level taken by force.
 *    - `minVolRatio` participation again;
 *    - range at least `breakoutMinRangeAtr` × ATR (a real expansion bar);
 *    - the bar's high clears the highest high of the previous `probeLookback`
 *      bars (LONG) / the mirror for SHORT;
 *    - and it CLOSES in the top/bottom `breakoutMinCloseLoc` share of its range
 *      — the extreme close is what distinguishes continuation from a raid.
 *    - entry = that close. Invalidation = the broken level itself, so a failure
 *      to hold the break is the stop.
 *
 * BOTH: `cooldownBars` between signals, `maxSignalsPerDay` per symbol, and a
 * plan from strategy-core/tradePlanner.js with the same RR and extension gates
 * every other engine obeys.
 */
'use strict';

const ind = require('../strategy-core/indicators');
const planner = require('../strategy-core/tradePlanner');
const marketCore = require('../strategy-core/market');
const { createSession } = require('../strategy-core/session');
const { replay } = require('../strategy-core/replay');
const { T } = ind;

const DEFAULTS = {
  minVolRatio: 1.8,            // OF01 participation floor
  probeLookback: 20,           // bars that define "the prior extreme"
  absorbMaxRangeAtr: 1.00,     // OF01: big volume, small travel (under one ATR)
  absorbMinCloseLoc: 0.55,     // OF01: close in the top/bottom 45%
  minAtrPct: 0.30,             // an ATR this small makes "×ATR" meaningless

  // --- OF02: DISABLED ---
  // Measured across five presets over 1,028 symbols, every variant of the rebuilt
  // breakout arm lost money (netPF 0.842 loose → 0.677 with every gate), and with
  // it enabled the whole Order Flow engine fell from netPF 1.292 (absorption
  // alone) to 0.950. The code is kept, and the measurement is kept, but it may
  // not contaminate the live signal set. Flip to true to bring it back.
  enableOF02: false,

  // --- OF01 v2: absorption as EVENT → CONFIRMATION → TRIGGER ---
  // The old OF01 fired on a single bar. An absorption is now a CANDIDATE that
  // must sit at a meaningful LOCATION, must show effort without result, and must
  // then be CONFIRMED by a trigger within a few bars. Nothing is emitted on the
  // candidate bar itself.
  of01RequireLocation: true,   // the absorption must sit at a level that means something
  of01LocationBandPct: 0.30,   // within this % of the location price to count as "at" it
  of01TriggerBars: 3,          // the trigger must arrive within this many bars or the event expires

  // --- OF03: exhaustion / failed aggression (independent of OF01) ---
  // Aggression RISES into a new extreme and the price RESPONSE falls: the new
  // extreme is marginal and the bar closes back away from it. This is the mirror
  // question to absorption — there, effort was absorbed at an old level; here,
  // effort spent making a NEW extreme fails to hold it.
  enableOF03: true,
  of03MinVolRatio: 1.5,
  of03MaxNewExtremeAtr: 0.25,  // the new extreme may exceed the prior one by at most this much ATR
  of03MaxCloseLoc: 0.40,       // for a high exhaustion, the close must sit in the bottom 40%
  of03TriggerBars: 3,

  // --- OF02 v2: BREAKOUT CONTINUATION, rebuilt from the setup definition ---
  // Each gate below is a separate, nameable condition so the variants
  // (backtest/of02Variants.js) can switch them on one at a time and measure what
  // each one is worth, instead of shipping one opaque rule. A threshold that
  // disables a gate (0 or 1) IS the switch.
  of02MinVolRatio: 1.5,        // participation: the breakout must be on volume
  of02MinBodyRatio: 0.60,      // the candle must be mostly body, not wick
  of02MinCloseLoc: 0.75,       // and close near the end it broke toward
  of02MinBreakoutPct: 0.05,    // a real clearance of the level, not a poke
  of02MinRangeAtr: 0.80,       // expansion: the bar's range vs ATR
  of02MinTravelAtr: 0.50,      // price RESPONSE: |close-open| vs ATR — volume alone is not enough
  of02HoldBufferAtr: 0.10,     // the close must clear the level by this much ATR
  // ATR is CONTEXTUAL for OF02, not a death sentence: a continuation setup can
  // be small and still reach the next structure, so the hard room gate is the
  // planner's R:R. Set true to restore a floor check in the engine.
  of02RequireAtrFloor: false,
  cooldownBars: 8,
  maxSignalsPerDay: 4,
  measuredMoveR: 1.2,
  // ENGINE-SPECIFIC EXTENSION GATE. A breakout's whole thesis is that a move
  // has started and will continue — so the planner's default "3m already moved
  // 1.20%" veto fires on precisely the bars this engine exists to find. The
  // gate is therefore widened here, but NOT removed: the hard reject stays, and
  // the setup is still never entered after the move is over (see the range
  // position at 92%). A tightening below 1.0 in `maxMove*` is what silenced this
  // engine entirely on the first replay.
  planner: {
    maxMove3mPct: 2.50,
    maxMove5mPct: 3.50,
    maxVwapDistPct: 2.50,
    maxRangePosPct: 92,
    // RECALIBRATED. The shared floor of 0.60% ATR was calibrated against an
    // engine that entered late; at 1-minute resolution the median ATR% at a
    // decision bar is ~0.15%, so that floor refused almost everything. For the
    // breakout arm the R:R gate is the hard one and ATR is context, so it is
    // lowered here, for this engine only.
    minAtrPct: 0.15,
  },
};

const BASIS = 'OHLCV proxy — best-five depth carries no executed aggressor side';

// ---------------------------------------------------------------------------
// OF01 ABSORPTION REVERSAL
// ---------------------------------------------------------------------------

/**
 * THE LOCATIONS an absorption is allowed to happen at. An absorption in the
 * middle of nowhere is not the same event as one at the previous day's low, and
 * the point of recording the type is to let the analysis say WHICH of these the
 * edge actually lives around rather than asserting one. Every price is read from
 * the session tracker, so it is a value known at this bar.
 */
function locations(session) {
  const out = [];
  const add = (type, price, label) => { if (price != null && !isNaN(price)) out.push({ type, price, label }); };
  // THE DAY HIGH/LOW ARE DELIBERATELY NOT HERE. An absorption probes a prior
  // extreme, and that extreme very often IS the day's low so far — so including
  // it made the location gate nearly vacuous (every candidate sat "at the day
  // low") and the location categories uninformative. The level being probed is
  // recorded separately as `probedLevel`; these are the EXTERNAL levels the event
  // can happen against, which is the question worth asking.
  if (session.prevDay) { add('PDH', session.prevDay.high, 'previous day high'); add('PDL', session.prevDay.low, 'previous day low'); }
  if (session.openingRange) { add('ORH', session.openingRange.high, 'opening range high'); add('ORL', session.openingRange.low, 'opening range low'); }
  add('VWAP', session.vwap(), 'VWAP');
  add('POC', session.poc(), 'point of control');
  return out;
}

/** The nearest location within the band, or null. */
function nearestLocation(session, price, bandPct) {
  const band = Math.abs(price) * (bandPct / 100);
  let best = null;
  for (const L of locations(session)) {
    const d = Math.abs(L.price - price);
    if (d <= band && (!best || d < best.distancePct)) {
      best = Object.assign({}, L, { distancePct: (d / price) * 100 });
    }
  }
  return best;
}

/**
 * OF01 v2 — ABSORPTION as a CANDIDATE, not a signal.
 *
 * EFFORT WITHOUT RESULT: heavy participation on a bar that barely travels, which
 * probes a prior extreme and closes back through it. The candidate now also has
 * to sit at a LOCATION, and it returns a `triggerLevel` (the candidate bar's own
 * extreme) that the engine waits for a later bar to take out — so the setup is
 * confirmed before it is a signal. See createEngine.
 */
function absorption({ bar, market, priorHigh, priorLow, cfg, session }) {
  const atr = market.atr;
  const range = bar[T.HIGH] - bar[T.LOW];
  if (!atr || atr <= 0 || range <= 0) return null;
  if (market.atrPct != null && market.atrPct < cfg.minAtrPct) return null;
  if (market.volumeRatio == null || market.volumeRatio < cfg.minVolRatio) return null;
  if (range > cfg.absorbMaxRangeAtr * atr) return null;        // travelled: not absorption

  const loc = ind.closeLocation(bar);
  if (loc == null) return null;

  // LOCATION: the event must sit at a level that means something.
  const at = (session && cfg.of01RequireLocation) ? nearestLocation(session, bar[T.CLOSE], cfg.of01LocationBandPct) : null;
  if (session && cfg.of01RequireLocation && !at) return null;

  if (priorLow != null && bar[T.LOW] <= priorLow && bar[T.CLOSE] > priorLow && loc >= cfg.absorbMinCloseLoc) {
    return {
      setup: 'OF01', label: 'Absorption Reversal', side: 'LONG',
      invalidation: bar[T.LOW], probed: priorLow, closeLoc: loc,
      location: at, triggerLevel: bar[T.HIGH],
    };
  }
  if (priorHigh != null && bar[T.HIGH] >= priorHigh && bar[T.CLOSE] < priorHigh && loc <= (1 - cfg.absorbMinCloseLoc)) {
    return {
      setup: 'OF01', label: 'Absorption Reversal', side: 'SHORT',
      invalidation: bar[T.HIGH], probed: priorHigh, closeLoc: loc,
      location: at, triggerLevel: bar[T.LOW],
    };
  }
  return null;
}

/**
 * OF03 — EXHAUSTION / FAILED AGGRESSION, the mirror question to absorption.
 *
 * Absorption asks whether effort at an OLD level was met. Exhaustion asks whether
 * effort spent making a NEW extreme failed to hold it: rising participation, a
 * new extreme that is only marginal, and a close back away from that extreme. The
 * trigger is the candidate bar's opposite extreme being taken out.
 */
function exhaustion({ bar, market, priorHigh, priorLow, cfg }) {
  const atr = market.atr;
  const range = bar[T.HIGH] - bar[T.LOW];
  if (!atr || atr <= 0 || range <= 0) return null;
  if (market.volumeRatio == null || market.volumeRatio < cfg.of03MinVolRatio) return null;
  const loc = ind.closeLocation(bar);
  if (loc == null) return null;
  const maxPush = cfg.of03MaxNewExtremeAtr * atr;

  // SHORT: a marginal new HIGH that closes back down = failed aggression
  if (priorHigh != null && bar[T.HIGH] > priorHigh && (bar[T.HIGH] - priorHigh) <= maxPush && loc <= cfg.of03MaxCloseLoc) {
    return {
      setup: 'OF03', label: 'Exhaustion / Failed Aggression', side: 'SHORT',
      invalidation: bar[T.HIGH], probed: priorHigh, closeLoc: loc,
      location: null, triggerLevel: bar[T.LOW],
    };
  }
  // LONG: a marginal new LOW that closes back up
  if (priorLow != null && bar[T.LOW] < priorLow && (priorLow - bar[T.LOW]) <= maxPush && loc >= (1 - cfg.of03MaxCloseLoc)) {
    return {
      setup: 'OF03', label: 'Exhaustion / Failed Aggression', side: 'LONG',
      invalidation: bar[T.LOW], probed: priorLow, closeLoc: loc,
      location: null, triggerLevel: bar[T.HIGH],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// OF02 AGGRESSIVE BREAKOUT CONTINUATION
// ---------------------------------------------------------------------------

/**
 * OF02 v2 — AGGRESSIVE BREAKOUT CONTINUATION, rebuilt from the definition.
 *
 * The old rule was "expansion vs the prior 20-bar extreme" with a volume floor
 * and a loose close-location test, and it measured netPF 0.986 over 110 trades
 * on the full corpus. The v2 rule asks a narrower question with explicit steps:
 *
 *   1. TAKE THE LEVEL   the bar must trade AND close beyond the prior extreme
 *                       (close beyond, not just a wick through — a poke is not a
 *                       breakout, and a close back inside is a sweep, which is
 *                       the Liquidity engine's job, not this one)
 *   2. REAL CLEARANCE   close beyond the level by at least `of02MinBreakoutPct`
 *   3. STRONG CANDLE    body/range >= `of02MinBodyRatio`
 *   4. CLOSE AT THE END closeLocation >= `of02MinCloseLoc`
 *   5. EXPANSION        range >= `of02MinRangeAtr` × ATR
 *   6. RESPONSE         |close−open| >= `of02MinTravelAtr` × ATR — volume with no
 *                       price travel is absorption, not continuation
 *   7. PARTICIPATION    volumeRatio >= `of02MinVolRatio`
 *   8. HELD             the close must clear the level by `of02HoldBufferAtr` × ATR,
 *                       so a one-tick poke that closes back at the level is out
 *
 * Entry is the close, the signal freezes there and the fill is the NEXT OPEN
 * (backtest/follow.js), and the invalidation is the broken level itself — for a
 * continuation setup, losing the level is losing the idea. Anti-chase, the R:R
 * room gate and "a missing measurement is a refusal" are the planner's, which
 * this engine already routes through.
 */
function breakout({ bar, market, priorHigh, priorLow, cfg }) {
  const atr = market.atr;
  const range = bar[T.HIGH] - bar[T.LOW];
  if (!atr || atr <= 0 || range <= 0) return null;
  if (cfg.of02RequireAtrFloor && market.atrPct != null && market.atrPct < cfg.minAtrPct) return null;

  // 7. participation
  const vol = market.volumeRatio;
  if (vol == null || vol < cfg.of02MinVolRatio) return null;

  const loc = ind.closeLocation(bar);
  if (loc == null) return null;
  const bodyRatio = Math.abs(bar[T.CLOSE] - bar[T.OPEN]) / range;          // 3
  const travelAtr = Math.abs(bar[T.CLOSE] - bar[T.OPEN]) / atr;           // 6
  const expansionAtr = range / atr;                                       // 5
  const holdBuffer = atr * cfg.of02HoldBufferAtr;                         // 8

  const shared = () => (bodyRatio >= cfg.of02MinBodyRatio
    && expansionAtr >= cfg.of02MinRangeAtr
    && travelAtr >= cfg.of02MinTravelAtr);

  // LONG
  if (priorHigh != null && bar[T.HIGH] > priorHigh && bar[T.CLOSE] > priorHigh) {
    const breakoutPct = ((bar[T.CLOSE] - priorHigh) / priorHigh) * 100;
    if (shared() && loc >= cfg.of02MinCloseLoc
      && breakoutPct >= cfg.of02MinBreakoutPct
      && bar[T.CLOSE] >= priorHigh + holdBuffer) {
      return {
        setup: 'OF02', label: 'Aggressive Breakout Continuation', side: 'LONG',
        invalidation: priorHigh, probed: priorHigh, closeLoc: loc, broke: 'prior ' + cfg.probeLookback + '-bar high',
        bodyRatio, travelAtr, expansionAtr, breakoutPct,
      };
    }
  }
  // SHORT
  if (priorLow != null && bar[T.LOW] < priorLow && bar[T.CLOSE] < priorLow) {
    const breakoutPct = ((priorLow - bar[T.CLOSE]) / priorLow) * 100;
    if (shared() && loc <= (1 - cfg.of02MinCloseLoc)
      && breakoutPct >= cfg.of02MinBreakoutPct
      && bar[T.CLOSE] <= priorLow - holdBuffer) {
      return {
        setup: 'OF02', label: 'Aggressive Breakout Continuation', side: 'SHORT',
        invalidation: priorLow, probed: priorLow, closeLoc: loc, broke: 'prior ' + cfg.probeLookback + '-bar low',
        bodyRatio, travelAtr, expansionAtr, breakoutPct,
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
  // Day bookkeeping (day array, extremes, previous day, rolling tail, carried
  // VWAP/POC) is the shared tracker's job; this engine keeps only its cooldowns.
  const session = createSession(cfg);
  let cooldownUntil = -1, signalsToday = 0;
  // THE ARMED CANDIDATE. An absorption or an exhaustion is not a signal when it
  // is seen — it is an EVENT that must be CONFIRMED by a later bar taking out the
  // candidate's own extreme. While one is armed the engine waits, so a single
  // event cannot become five signals, and an event whose invalidation breaks (or
  // that is not confirmed in time) simply expires.
  let pending = null;

  // RESEARCH HOOK. Recording every rejected candidate means seeing the ones that
  // are never emitted at all: events that were armed, events that expired before
  // a trigger, events whose invalidation broke first. A trace callback (opt-in,
  // never required) receives a plain record for each, and is isolated so a faulty
  // observer can never change what the engine does.
  function trace(rec) {
    if (typeof cfg.trace !== 'function') return;
    try { cfg.trace(Object.assign({ symbol: cfg.symbol || null }, rec)); } catch (_) { /* observe only */ }
  }

  /** Build the signal for a confirmed event and run it through the shared planner. */
  function emit(found, bar, index, m) {
    const d = ind.dayOf(bar);
    const entry = bar[T.CLOSE];
    const structure = [found.probed];
    const targetCandidates = marketCore.targets({
      side: found.side, entry, market: m, structure, measuredMoveR: cfg.measuredMoveR,
    });
    const id = found.setup + '-' + (bar.symbol || '') + '-' + d + '-' + bar[T.TIME];
    // THE EVENT BAR's OWN MEASUREMENTS vs THE TRIGGER BAR's. For OF01/OF03 the
    // signal is emitted bars after the event, so `m` here is the TRIGGER bar and
    // recording its numbers as `volumeRatio`/`rangeAtr` would misdescribe the
    // setup (the event is what passed the participation floor). Both are kept:
    // the event bar's values are the setup's own, the trigger bar's are context.
    const evVol = found.eventVolumeRatio == null ? m.volumeRatio : found.eventVolumeRatio;
    const evRangeAtr = found.eventRangeAtr == null ? (m.atr ? (bar[T.HIGH] - bar[T.LOW]) / m.atr : null) : found.eventRangeAtr;
    const base = marketCore.signalBase({
      engine: 'ORDERFLOW', setup: found.setup, side: found.side, bar, index, setupId: id,
      market: m, targetCandidates,
      setupData: {
        basis: BASIS,
        setupLabel: found.label,
        probedLevel: found.probed,
        closeLocation: found.closeLoc,
        volumeRatio: evVol,               // the EVENT bar — the setup's own participation
        triggerVolumeRatio: m.volumeRatio, // the bar that confirmed it
        rangeAtr: evRangeAtr,             // the EVENT bar's travel
        // THE VOLATILITY REGIME, recorded for the decomposition: an edge that only
        // exists in one ATR% regime is a regime, not a setup.
        atrPct: m.atrPct,
        eventAtrPct: found.eventAtrPct == null ? m.atrPct : found.eventAtrPct,
        broke: found.broke || null,
        invalidation: found.invalidation,
        bodyRatio: found.bodyRatio == null ? null : found.bodyRatio,
        travelAtr: found.travelAtr == null ? null : found.travelAtr,
        breakoutPct: found.breakoutPct == null ? null : found.breakoutPct,
        // OF01 v2: WHERE the absorption happened, and how far the location was.
        locationType: found.location ? found.location.type : null,
        locationPrice: found.location ? found.location.price : null,
        distanceToLocationPct: found.location ? found.location.distancePct : null,
        triggerLevel: found.triggerLevel == null ? null : found.triggerLevel,
        barsToTrigger: pending ? (index - pending.barIndex) : 0,
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
    const where = found.location
      ? ' at the ' + found.location.label + ' (' + found.location.distancePct.toFixed(2) + '% away)'
      : '';
    withPlan.reason = found.setup === 'OF01'
      ? [
          'ABSORPTION' + where + ' — ' + evVol.toFixed(2) + '× average volume on only ' +
            (evRangeAtr == null ? '?' : evRangeAtr.toFixed(2)) + '× ATR of travel',
          'PROBED ' + found.probed.toFixed(2) + ' and closed back through it (' +
            (found.closeLoc * 100).toFixed(0) + '% of range)',
          'CONFIRMED — the event bar\'s extreme ' + found.triggerLevel.toFixed(2) + ' was taken out',
          'INVALIDATION at the probe extreme ' + found.invalidation.toFixed(2),
          'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
          BASIS,
        ]
      : found.setup === 'OF03'
        ? [
            'EXHAUSTION — aggression into a marginal new extreme on ' + evVol.toFixed(2) + '× average volume',
            'THE NEW EXTREME FAILED TO HOLD — close at ' + (found.closeLoc * 100).toFixed(0) + '% of the range, back away from it',
            'CONFIRMED — the event bar\'s opposite extreme ' + found.triggerLevel.toFixed(2) + ' was taken out',
            'INVALIDATION at the failed extreme ' + found.invalidation.toFixed(2),
            'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
            BASIS,
          ]
        : [
            'EXPANSION ' + (found.expansionAtr == null ? '?' : found.expansionAtr.toFixed(2)) + '× ATR on ' +
              m.volumeRatio.toFixed(2) + '× average volume',
            'TOOK OUT  and CLOSED BEYOND  the ' + found.broke + ' at ' + found.probed.toFixed(2),
            'INVALIDATION back at the broken level ' + found.invalidation.toFixed(2),
            'RR1 = ' + built.plan.rr1.toFixed(2) + 'R',
            BASIS,
          ];
    return withPlan;
  }

  function onBar(bars, index) {
    const bar = bars[index];
    if (!bar) return null;
    const d = ind.dayOf(bar);

    if (session.onBar(bar)) { cooldownUntil = -1; signalsToday = 0; pending = null; }

    if (index < cooldownUntil) return null;

    const entry = bar[T.CLOSE];
    const m = marketCore.measure({ session, entry });

    if (signalsToday >= cfg.maxSignalsPerDay) { pending = null; return null; }

    // 1) A PENDING EVENT IS RESOLVED FIRST. The candidate's own extreme must be
    //    taken out by a CLOSED bar within the expiry window; if price breaks the
    //    invalidation first, or the window passes, the event is gone and the bar
    //    is free to look for a new one.
    if (pending) {
      const p = pending;
      const breached = p.cand.side === 'LONG'
        ? bar[T.LOW] <= p.cand.invalidation
        : bar[T.HIGH] >= p.cand.invalidation;
      if (breached || index > p.expiryIndex) {
        trace({
          stage: breached ? 'breached' : 'expired', setup: p.cand.setup, side: p.cand.side,
          time: p.barTime, barsToTrigger: index - p.barIndex, locationType: p.cand.location ? p.cand.location.type : null,
          volumeRatio: p.cand.eventVolumeRatio == null ? null : p.cand.eventVolumeRatio,
          closeLocation: p.cand.closeLoc, probedLevel: p.cand.probed,
        });
        pending = null;
      } else {
        const fired = p.cand.side === 'LONG'
          ? bar[T.CLOSE] > p.triggerLevel
          : bar[T.CLOSE] < p.triggerLevel;
        if (!fired) return null;                     // still waiting; nothing new is armed
        const sig = emit(p.cand, bar, index, m);
        pending = null;
        return sig;
      }
    }

    // the prior extreme, measured on CLOSED bars BEFORE this one
    const before = session.tail.slice(0, session.tail.length - 1);
    if (before.length < cfg.probeLookback) return null;
    const priorHigh = ind.highest(before, cfg.probeLookback);
    const priorLow = ind.lowest(before, cfg.probeLookback);

    if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;

    const cand = absorption({ bar, market: m, priorHigh, priorLow, cfg, session })
      || (cfg.enableOF03 ? exhaustion({ bar, market: m, priorHigh, priorLow, cfg }) : null)
      || (cfg.enableOF02 ? breakout({ bar, market: m, priorHigh, priorLow, cfg }) : null);
    if (!cand) return null;

    // FREEZE THE EVENT BAR'S MEASUREMENTS ON THE CANDIDATE. The signal may not be
    // emitted until several bars later, and the analysis has to be able to ask
    // what the EVENT looked like, not what the confirmation bar looked like.
    cand.eventVolumeRatio = m.volumeRatio;
    cand.eventRangeAtr = m.atr ? (bar[T.HIGH] - bar[T.LOW]) / m.atr : null;
    cand.eventAtrPct = m.atrPct;

    // OF02 is its own event — the breakout IS the trigger. OF01 and OF03 are
    // events that still have to be confirmed, so they are armed, not emitted.
    if (cand.setup === 'OF02') return emit(cand, bar, index, m);

    const expiryBars = cand.setup === 'OF03' ? cfg.of03TriggerBars : cfg.of01TriggerBars;
    pending = { cand, barIndex: index, barTime: bar[T.TIME], triggerLevel: cand.triggerLevel, expiryIndex: index + expiryBars };
    trace({
      stage: 'armed', setup: cand.setup, side: cand.side, time: bar[T.TIME], barsToTrigger: 0,
      price: entry, locationType: cand.location ? cand.location.type : null, locationPrice: cand.location ? cand.location.price : null,
      distanceToLocationPct: cand.location ? cand.location.distancePct : null,
      volumeRatio: cand.eventVolumeRatio == null ? null : cand.eventVolumeRatio,
      rangeAtr: cand.eventRangeAtr, atrPct: cand.eventAtrPct == null ? null : cand.eventAtrPct,
      closeLocation: cand.closeLoc, probedLevel: cand.probed,
      triggerLevel: cand.triggerLevel, invalidation: cand.invalidation, expiryBars,
    });
    return null;
  }

  return { onBar, cfg, state: () => ({ day: session.day, prevDay: session.prevDay, pending }) };
}

module.exports = {
  id: 'ORDERFLOW', setup: 'OF01', name: 'Order Flow (OHLCV proxy)',
  families: [
    { setup: 'OF01', label: 'Absorption Reversal' },
    { setup: 'OF02', label: 'Aggressive Breakout Continuation', disabled: true },
    { setup: 'OF03', label: 'Exhaustion / Failed Aggression' },
  ],
  BASIS, DEFAULTS, evaluate, createEngine, absorption, breakout, exhaustion, locations,
};
