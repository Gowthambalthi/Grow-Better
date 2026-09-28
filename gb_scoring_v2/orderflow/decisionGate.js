/**
 * gb_scoring_v2/orderflow/decisionGate.js — PHASE 7: THE GATE.
 *
 * The plan, verbatim, for the LONG side:
 *
 *     huge_move (5m or 15m, red/down zscore)
 *     AND range_expansion
 *     AND delta_collapsing_down (sellers exhausting)
 *     AND at_location (absorption/VWAP/POC/pivot/FVG)
 *     AND ROC(20s) turning up, 2+ bars
 *     AND volume_confirmed
 *     AND candle shows rejection at that location
 *     -> SIGNAL
 *
 * and the note that decides how to read it: "delta_collapsing_down (sellers exhausting) # note:
 * exhaustion of the move that's ending, confirms reversal". So this is a REVERSAL gate: it takes
 * a move that has ALREADY happened and is losing its fuel, at a level, with the fast frame
 * turning, and calls the turn. It is NOT a momentum gate, and that is the whole point — the
 * engine that lost the money was buying moves that had already been made.
 *
 * EVERY CONDITION REPORTS ITSELF. The output carries `checks`, one entry per condition with its
 * value and a sentence, plus `passed`, `missing` and `total`. A gate that only answers
 * yes/no cannot be validated layer by layer later (Phase 8's whole purpose), and cannot tell the
 * user why the row they are staring at is not a trade.
 *
 * THE TWO WATCH-ONLY SHAPES ARE THE PLAN'S, NOT MINE:
 *   huge + range expansion but delta NOT confirming  -> likely chop
 *   huge + delta confirming but NO location          -> real move, undefined risk, skip
 * Both are exit paths from "no signal", and both are named so the board can say which one it is.
 */
const DIRS = { LONG: 'LONG', SHORT: 'SHORT' };

/**
 * evaluate(input) — one bar's verdict.
 *   input = {
 *     momentum:  momentumEngine.measure(...)   (huge, dir, roc5m/z5m, roc15m/z15m, fast)
 *     volume:    volumeEngine.measure(bars)
 *     footprint: footprint.snapshot(token)     (collapse, cumDelta)
 *     location:  locationEngine.atLocation(...)(at, hits, tol)
 *     candles:   candleReader.classify(...)    (pattern, dir, supports)
 *   }
 * Returns { verdict, side, checks, passed, missing, total, watchReason, note }.
 */
function evaluate(input) {
  const m = input.momentum || {};
  const v = input.volume || {};
  const fp = input.footprint || {};
  const loc = input.location || {};
  const can = input.candles || {};
  const collapse = fp.collapse || { down: false, up: false };

  const checks = [];
  const add = (name, pass, value, why) => checks.push({ name, pass: pass === true, value, why });

  // Which side is even being considered? The huge move points the OTHER way for a reversal:
  // a huge DOWN move is the candidate for a LONG (buy the exhaustion), and vice versa.
  const side = m.huge && m.dir === 'down' ? DIRS.LONG : m.huge && m.dir === 'up' ? DIRS.SHORT : null;
  add('huge_move', !!m.huge, { roc5m: m.roc5m, z5m: m.z5m, roc15m: m.roc15m, z15m: m.z15m, dir: m.dir },
    m.huge ? ('huge ' + m.dir + ' move (z5m ' + m.z5m + ' / z15m ' + m.z15m + ')') : (m.warmup || 'no |z| >= ' + (m.threshold || 1.5) + ' move on 5m or 15m'));
  add('huge_direction_clear', !!side, m.dir, side ? ('reversal candidate: ' + side) : (m.conflict ? '5m and 15m huge moves disagree — no side' : 'no huge move to reverse'));

  add('range_expansion', v.rangeExpansion === true, v.rangeRatio, v.rangeExpansion == null ? (v.warmup || 'range ratio unknown') : (v.rangeRatio + 'x the rolling average range'));
  add('volume_confirmed', v.volumeConfirmed === true, v.volRatio, v.volumeConfirmed == null ? (v.warmup || 'volume ratio unknown') : (v.volRatio + 'x the rolling average volume'));

  // DELTA COLLAPSE IS SIDE-SPECIFIC ON PURPOSE: a long needs SELLERS exhausting.
  const dPass = side === DIRS.LONG ? collapse.down === true : side === DIRS.SHORT ? collapse.up === true : false;
  add('delta_collapsing', dPass, collapse.series,
    dPass ? ('delta collapse ' + (side === DIRS.LONG ? 'down' : 'up') + ' (' + (collapse.series || []).join(' → ') + ')')
      : 'bar deltas ' + ((collapse.series || []).join(' → ') || 'n/a') + (side ? ' — not collapsing for a ' + side : ''));

  add('at_location', loc.at === true, (loc.hits || []).map((h) => h.name), loc.at ? ('at ' + (loc.hits || []).map((h) => h.name + ' (' + h.distPct + '%)').join(', ')) : 'no VWAP/POC/VA/pivot/absorption/FVG within ' + (loc.tolPct != null ? loc.tolPct + '%' : 'the tolerance'));

  const fastPass = side === DIRS.LONG ? m.fast && m.fast.turningUp === true : side === DIRS.SHORT ? m.fast && m.fast.turningDown === true : false;
  add('fast_frame_turning', fastPass, m.fast ? m.fast.series : null,
    fastPass ? ('ROC(20s) turning ' + (side === DIRS.LONG ? 'up' : 'down') + ' (' + (m.fast.series || []).join(' → ') + ')')
      : 'ROC(20s) ' + (m.fast && m.fast.roc20 != null ? m.fast.roc20 + '%' : 'unavailable') + ' — not turning ' + (side === DIRS.LONG ? 'up' : 'down'));

  const cPass = can.consulted === true && (side === DIRS.LONG ? can.dir === 'up' : side === DIRS.SHORT ? can.dir === 'down' : false);
  add('candle_rejection', cPass, can.pattern, can.consulted ? (can.note || can.pattern || 'none') : (can.atLocation === false ? 'not consulted — price is not at a level' : 'no rejection pattern at this location'));

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const missing = checks.filter((c) => !c.pass).map((c) => c.name);
  const allPass = passed === total && side != null;

  let verdict = 'NO-TRADE';
  let watchReason = null;
  let note = null;
  if (allPass) {
    verdict = 'SIGNAL';
    note = 'all ' + total + ' conditions met — ' + side + ' reversal of an exhausted ' + (side === DIRS.LONG ? 'down' : 'up') + ' move';
  } else if (m.huge && v.rangeExpansion === true && !dPass) {
    // the plan's first WATCH: the move is real and expanding, but nobody is exhausting
    verdict = 'WATCH';
    watchReason = 'likely chop — huge move with range expansion but delta is not confirming (flat or diverging)';
  } else if (m.huge && dPass && loc.at !== true) {
    // the plan's second WATCH: the turn may be real, the risk is not defined
    verdict = 'WATCH';
    watchReason = 'real move, undefined risk — delta confirms exhaustion but the price is not at a level';
  } else if (m.huge && side == null) {
    verdict = 'WATCH';
    watchReason = m.conflict ? 'the 5m and 15m huge moves point opposite ways' : 'huge move with no readable direction';
  } else {
    note = missing.length ? ('missing: ' + missing.join(', ')) : 'no huge move to reverse';
  }

  return {
    verdict,
    side: verdict === 'SIGNAL' ? side : null,
    candidateSide: side,
    checks,
    passed,
    missing,
    total,
    watchReason,
    note,
    inputs: {
      momentum: { huge: !!m.huge, dir: m.dir, roc5m: m.roc5m, z5m: m.z5m, roc15m: m.roc15m, z15m: m.z15m, decel: m.decel, fast20: m.fast ? m.fast.roc20 : null },
      volume: { volRatio: v.volRatio, rangeRatio: v.rangeRatio, volumeConfirmed: v.volumeConfirmed, rangeExpansion: v.rangeExpansion },
      delta: { cumDelta: fp.cumDelta, series: collapse.series, lastBarDelta: fp.lastBarDelta },
      location: { at: loc.at, hits: (loc.hits || []).map((h) => h.name), tolPct: loc.tolPct, vwap: loc.vwap, poc: loc.poc },
      candles: { pattern: can.pattern, dir: can.dir, consulted: can.consulted },
    },
  };
}

module.exports = { evaluate, DIRS };
