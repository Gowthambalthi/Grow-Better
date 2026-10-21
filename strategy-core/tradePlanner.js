/**
 * strategy-core/tradePlanner.js — the ONE place a trade gets its price levels.
 *
 * The strategy engines decide WHEN and WHICH WAY. They do not decide stop, T1 or
 * T2, and neither does the frontend. That separation is what makes the plan
 * auditable: one function, one risk rule, one reason string per level, used by
 * live and backtest alike.
 *
 * The two refusals that matter most:
 *   - RR CHECK: if the nearest honest target does not pay for the risk, the
 *     trade is REJECTED rather than given a further, invented target.
 *   - EXTENSION CHECK: if price has already made the move, the trade is
 *     rejected. This is a HARD GATE, not a confidence downgrade.
 */
'use strict';

const DEFAULTS = {
  stopBufferPct: 0.05,        // beyond the level that invalidates the setup
  minStopPct: 0.15,           // never tighter than this; structure noise would stop us
  maxStopPct: 1.50,           // allowed stop width
  minRR1: 1.2,                // Risk-to-Reward ratio floor
  targetMinRoomPct: 0.10,     // a target nearer than this is noise, not structure
  // --- extension gate ---
  maxMove3mPct: 2.50,
  maxMove5mPct: 3.50,
  maxVwapDistPct: 2.50,
  maxRangePosPct: 95,         // % of the day's range already travelled, same direction
  minAtrPct: 0.60,            // too quiet to reach a target
  maxAtrPct: 8.00,            // too wild to hold a stop
  // --- data completeness ---
  requireMeasured: true,
  measuredFields: ['atrPct', 'vwapDistPct', 'rangePosPct', 'move3mPct', 'move5mPct'],
};

function pct(a, b) { return b ? ((a / b) - 1) * 100 : null; }

/**
 * Pick the stop from STRUCTURE, not a flat percentage.
 * `invalidation` is the level that proves the setup wrong (sweep low, FVG low,
 * absorption low). The stop sits just beyond it, clamped into a sane band.
 */
function pickStop(side, entry, invalidation, cfg) {
  const buffer = entry * (cfg.stopBufferPct / 100);
  let stop = side === 'LONG' ? invalidation - buffer : invalidation + buffer;
  const minDist = entry * (cfg.minStopPct / 100);
  const maxDist = entry * (cfg.maxStopPct / 100);
  const dist = Math.abs(entry - stop);
  let basis = 'structure beyond ' + invalidation.toFixed(2);
  let clamp = null;

  // A STOP IS NEVER PULLED INSIDE ITS OWN INVALIDATION. The floor (a stop too
  // tight) widens AWAY from entry, so the stop stays beyond the level that
  // proves the setup wrong — that clamp is safe and stays. The ceiling was NOT:
  // capping at maxStopPct moved the stop back TOWARD entry, so for a LONG whose
  // structural stop sat below a 1.2%-wide invalidation the stop landed ABOVE the
  // invalidation — the trade could stop out while the setup was still valid, and
  // the engine was no longer testing its own idea. When the structure is wider
  // than the ceiling the plan is REFUSED instead of mis-stopped.
  let rejected = null;
  if (dist < minDist) {
    stop = side === 'LONG' ? entry - minDist : entry + minDist;
    basis = 'structure too tight (' + dist.toFixed(2) + ') — floored at ' + cfg.minStopPct + '%';
    clamp = 'FLOOR minStopPct';
  } else if (dist > maxDist) {
    stop = side === 'LONG' ? invalidation - buffer : invalidation + buffer;   // the TRUE structural stop
    basis = 'structure too far (' + dist.toFixed(2) + ') — the stop would have to sit inside ' +
      invalidation.toFixed(2) + ' to fit ' + cfg.maxStopPct + '%, so the plan is refused, not mis-stopped';
    clamp = 'REFUSED STOP_TOO_WIDE';
    rejected = 'STOP_TOO_WIDE';
  }
  const risk = Math.abs(entry - stop);
  return {
    stop, risk, basis, rejected,
    // THE WORKING, EMITTED BY THE FUNCTION THAT DID IT. The plan audit used to
    // recompute this arithmetic in its own copy, so there were two places that
    // could compute a stop and the page cross-checked one against the other.
    // Now the audit prints what this function actually did.
    steps: [
      { label: 'invalidation (the price that proves it wrong)', value: invalidation },
      { label: 'buffer = entry × ' + cfg.stopBufferPct + '%', value: buffer },
      { label: side === 'LONG' ? 'raw stop = invalidation − buffer' : 'raw stop = invalidation + buffer', value: side === 'LONG' ? invalidation - buffer : invalidation + buffer },
      { label: 'raw distance = |entry − raw stop|', value: dist },
      { label: 'min allowed distance = entry × ' + cfg.minStopPct + '%', value: minDist },
      { label: 'max allowed distance = entry × ' + cfg.maxStopPct + '%', value: maxDist },
      { label: 'clamp applied', value: clamp == null ? 'none' : clamp, text: true },
      { label: 'STOP', value: stop },
      { label: 'risk = |entry − stop|', value: risk },
      { label: 'riskPct = risk ÷ entry', value: (risk / entry) * 100, suffix: '%' },
    ],
  };
}

/**
 * Targets from opposing structure, nearest first. `candidates` is an array of
 * prices; anything on the wrong side of entry, or nearer than the minimum room,
 * is discarded rather than used.
 */
function pickTargets(side, entry, candidates, cfg) {
  const minRoom = entry * (cfg.targetMinRoomPct / 100);
  const considered = [];
  const valid = [];
  for (const c of (candidates || [])) {
    if (c == null || isNaN(c)) { considered.push({ price: c, verdict: 'not a number' }); continue; }
    const room = Math.abs(c - entry);
    const rightSide = (side === 'LONG' ? c > entry + minRoom : c < entry - minRoom);
    considered.push({
      price: c, room,
      verdict: rightSide ? 'kept' : (room <= minRoom ? 'too near entry (< ' + minRoom.toFixed(2) + ')' : 'wrong side of entry'),
    });
    if (rightSide) valid.push(c);
  }
  valid.sort((a, b) => (side === 'LONG' ? a - b : b - a));
  const uniq = [];
  for (const c of valid) if (!uniq.some((u) => Math.abs(u - c) < 0.01)) uniq.push(c);
  const t1 = uniq[0] == null ? null : uniq[0];
  const t2 = uniq[1] == null ? null : uniq[1];
  return {
    t1, t2,
    // the working, from the function that did it (see pickStop)
    minRoom, considered, kept: uniq,
    steps: [
      { label: 'minimum room a target needs = entry × ' + cfg.targetMinRoomPct + '%', value: minRoom },
      { label: 'candidate levels offered by the engine', value: (candidates || []).length, text: true },
      { label: 'candidates on the right side and far enough', value: uniq.length, text: true },
      { label: 'T1 = nearest opposing structure', value: t1 },
      { label: 'T2 = the next one', value: t2 },
    ],
  };
}

/**
 * The extension gate. Hard reject when the move has already happened, because
 * entering here means paying for someone else's profit.
 */
function extensionCheck(side, m) {
  const c = m.cfg || DEFAULTS;
  const bad = [];
  const dir = side === 'LONG' ? 1 : -1;
  const moved = (v) => v != null && v * dir > 0;

  // THE ROWS ARE THE CHECK. Each one carries the value it measured, the
  // threshold it compared against and the verdict, and it is built by the same
  // pass that decides `ok` — so a page that prints these rows cannot print a
  // verdict the gate did not reach. The audit used to keep its own copy of these
  // six comparisons, which is two places for one gate to live.
  const rows = [];
  // REQUIRED FIELDS. A missing measurement that the gate is REQUIRED to read is
  // a refusal, not a shrug. `unknown` is not `safe`: if the gate cannot see how
  // far price has already travelled it has no business calling the entry un-
  // extended. Fields not in `measuredFields` stay advisory (an unmeasured one
  // cannot refuse the trade), so widening the required set is a deliberate change.
  const required = new Set(c.requireMeasured ? (c.measuredFields || []) : []);
  const judge = (name, value, threshold, failed, why, field) => {
    const isRequired = field != null && required.has(field);
    const missing = value == null || value === '';
    rows.push({
      name, value, threshold,
      verdict: missing ? (isRequired ? 'FAIL' : 'unmeasured') : (failed ? 'FAIL' : 'pass'),
      why: missing
        ? (isRequired ? 'required measurement missing — refused as DATA_MISSING' : 'the value was not measurable, so it cannot refuse the trade')
        : (failed ? why : ''),
    });
    if (missing && isRequired) bad.push('DATA_MISSING: ' + field);
  };

  const m3Bad = m.move3mPct != null && moved(m.move3mPct) && Math.abs(m.move3mPct) > c.maxMove3mPct;
  judge('3-minute move same direction', m.move3mPct, '≤ ' + c.maxMove3mPct + '%', m3Bad,
    'already moved ' + (m.move3mPct == null ? '' : m.move3mPct.toFixed(2)) + '% in the trade direction', 'move3mPct');
  if (m3Bad) bad.push('3m already moved ' + m.move3mPct.toFixed(2) + '%');

  const m5Bad = m.move5mPct != null && moved(m.move5mPct) && Math.abs(m.move5mPct) > c.maxMove5mPct;
  judge('5-minute move same direction', m.move5mPct, '≤ ' + c.maxMove5mPct + '%', m5Bad,
    'already moved ' + (m.move5mPct == null ? '' : m.move5mPct.toFixed(2)) + '% in the trade direction', 'move5mPct');
  if (m5Bad) bad.push('5m already moved ' + m.move5mPct.toFixed(2) + '%');

  const vwBad = m.vwapDistPct != null && moved(m.vwapDistPct) && Math.abs(m.vwapDistPct) > c.maxVwapDistPct;
  judge('distance from VWAP, same direction', m.vwapDistPct, '≤ ' + c.maxVwapDistPct + '%', vwBad,
    'extended ' + (m.vwapDistPct == null ? '' : m.vwapDistPct.toFixed(2)) + '% from VWAP', 'vwapDistPct');
  if (vwBad) bad.push('extended from VWAP by ' + m.vwapDistPct.toFixed(2) + '%');

  const rangeOk = m.rangePosPct == null ? null
    : (side === 'LONG' ? m.rangePosPct <= c.maxRangePosPct : m.rangePosPct >= (100 - c.maxRangePosPct));
  judge("position in the day's range", m.rangePosPct,
    side === 'LONG' ? '≤ ' + c.maxRangePosPct + '%' : '≥ ' + (100 - c.maxRangePosPct) + '%',
    rangeOk === false, 'already ' + (m.rangePosPct == null ? '' : m.rangePosPct.toFixed(0)) + "% of the day's range", 'rangePosPct');
  if (rangeOk === false) bad.push('already ' + m.rangePosPct.toFixed(0) + "% of the day's range");

  const quiet = m.atrPct != null && m.atrPct < c.minAtrPct;
  judge('ATR% floor', m.atrPct, '≥ ' + c.minAtrPct + '%', quiet, 'too quiet to reach a target', 'atrPct');
  if (quiet) bad.push('ATR ' + m.atrPct.toFixed(2) + '% too quiet to reach a target');

  const wild = m.atrPct != null && m.atrPct > c.maxAtrPct;
  judge('ATR% ceiling', m.atrPct, '≤ ' + c.maxAtrPct + '%', wild, 'too wild to hold a stop', 'atrPct');
  if (wild) bad.push('ATR ' + m.atrPct.toFixed(2) + '% too wild to hold a stop');

  const onlyMissing = bad.length > 0 && bad.every((r) => r.startsWith('DATA_MISSING'));
  return { ok: bad.length === 0, reasons: bad, rows, gate: onlyMissing ? 'DATA_MISSING' : 'EXTENSION' };
}

/**
 * Build the plan. Returns { ok:false, reject:[...] } instead of a plan whenever
 * a gate refuses, so the refusal is visible in the record rather than silent.
 */
function plan({ side, entry, invalidation, targets, market, config }) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const extended = extensionCheck(side, Object.assign({ cfg }, market || {}));
  if (!extended.ok) return { ok: false, reject: extended.reasons, gate: extended.gate || 'EXTENSION' };

  const st = pickStop(side, entry, invalidation, cfg);
  // A stop that would have to sit inside its own invalidation is not a stop. The
  // planner refuses rather than capping; see pickStop.
  if (st.rejected) return { ok: false, reject: [st.basis], gate: st.rejected };
  if (!st.risk) return { ok: false, reject: ['zero risk'], gate: 'STOP' };

  const tg = pickTargets(side, entry, targets, cfg);
  if (tg.t1 == null) return { ok: false, reject: ['no opposing structure to target'], gate: 'TARGET' };

  const rr1 = Math.abs(tg.t1 - entry) / st.risk;
  const rr2 = tg.t2 == null ? null : Math.abs(tg.t2 - entry) / st.risk;
  if (rr1 < cfg.minRR1) {
    return { ok: false, reject: ['nearest target pays only ' + rr1.toFixed(2) + 'R, need ' + cfg.minRR1 + 'R'], gate: 'RR' };
  }

  return {
    ok: true,
    plan: {
      entry, stop: st.stop, t1: tg.t1, t2: tg.t2,
      risk: st.risk,
      riskPct: (st.risk / entry) * 100,
      rr1, rr2,
      stopBasis: st.basis,
      targetBasis: (rr2 == null ? 'T1 only — no second structure' : 'nearest opposing structure, then the next'),
    },
  };
}

module.exports = { DEFAULTS, plan, extensionCheck, pickStop, pickTargets };
