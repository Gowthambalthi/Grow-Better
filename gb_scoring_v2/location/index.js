/**
 * gb_scoring_v2/location/index.js — PHASE 9: THE LOCATION ENGINE.
 *
 * V3 spec Section 14:
 *   "Price relative to VWAP, and VWAP slope where available. Price relative to POC.
 *    Inside / outside the value area; approach or break of VAH/VAL; rejection from a
 *    level. One normalized location value in [-1, +1] mapped to 0-10 points,
 *    direction-aligned."
 *
 * The spec also draws a hard line inside this component:
 *   "FRVP and Camarilla scoring are deferred. Existing GB Camarilla context may be
 *    displayed but is not scored in v1."
 *
 * So this module scores exactly three readings -- VWAP, POC and the value-area
 * position -- and DISPLAYS the rest (Camarilla zone, day-range position, VWAP stack
 * beyond its scored read). A module that quietly scored Camarilla would be the
 * Section 17 "weights fixed before replay" failure in a different disguise.
 *
 * WHY POC AND THE VALUE AREA MATTER HERE, AND WHY THEY ARE NOT MOMENTUM. A stock can
 * be moving fast while sitting at the bottom of its value area, or drifting while
 * accepting above the POC. Those are different situations and Section 3 keeps them
 * separate on purpose. Location answers "where is it happening", never "is it
 * happening".
 *
 * THE SCALE BUG THIS MODULE ALSO FIXES. The gates module's coarse location read used
 * to divide the VWAP distance by VWAP_FULL_PCT and then by 100 again, making the read
 * ~200x too small: a 0.5% move away from VWAP produced 0.01 instead of 1.0. The
 * gates therefore almost never registered location as opposing, which silently
 * weakened GATE_CONFLICT and GATE_DIRECTION. The scaling here is the one the comment
 * always claimed, and the gates now share it rather than keeping a second copy.
 */
const { CONFIG } = require('./../config/index');
const { isKnown } = require('./../adapter/provenance');

const bounded = (v) => (v == null ? null : Math.max(-1, Math.min(1, v)));
const num = (v) => (isKnown(v) && typeof v === 'number' ? v : null);

/**
 * GB's Camarilla zone -> a display lean. NOT SCORED (spec 14), listed so the output
 * shows it without letting it into the value.
 */
const CAM_ZONE_LEAN = {
  'BELOW_S4': -1, 'BELOW_S3': -0.7, 'BELOW_S2': -0.4,
  'IN_RANGE': 0,
  'ABOVE_R2': 0.4, 'ABOVE_R3': 0.7, 'ABOVE_R4': 1,
};

/** GB's VWAP stack -> a lean. This one IS part of the VWAP reading (spec 14). */
const STACK_LEAN = { 'ABOVE ALL': 1, 'MIXED': 0, 'BELOW ALL': -1 };

/**
 * THE SCORED FAMILY: three (four with the stack) readings of one phenomenon -- where
 * price sits relative to the levels GB already computes. They are combined by the
 * same bounded mean-times-agreement rule the momentum groups use, because they are
 * correlated views of the same location and must not add up as independent votes.
 */
function subReads(snapshot) {
  const L = (snapshot && snapshot.location) || {};
  const price = num(snapshot && snapshot.price);
  const cfg = CONFIG.location;
  const out = [], missing = [];

  // --- VWAP position -------------------------------------------------------
  const vwap = num(L.vwap);
  if (price != null && vwap != null && vwap > 0) {
    out.push({ name: 'vwap', value: bounded(((price - vwap) / vwap) / cfg.fullPct.vwap),
      detail: 'price ' + (((price - vwap) / vwap) * 100).toFixed(3) + '% from VWAP' });
  } else missing.push('location.vwap');

  // --- POC position --------------------------------------------------------
  // Normalized by HALF the value-area width, so "one unit" means "half the day's
  // accepted range" -- a scale that travels across stocks, unlike rupees.
  const poc = num(L.poc);
  const vah = num(L.vah), val = num(L.val);
  const halfVa = (vah != null && val != null && vah > val) ? (vah - val) / 2 : null;
  if (price != null && poc != null && poc > 0) {
    const denom = halfVa != null && halfVa > 0 ? halfVa : (poc * cfg.pocFallbackPct);
    out.push({ name: 'poc', value: bounded(((price - poc) / (denom || 1)) * cfg.fullPct.poc),
      detail: 'price ' + (((price - poc) / poc) * 100).toFixed(3) + '% from POC' + (halfVa == null ? ' (no value area: scaled by fallback)' : '') });
  } else missing.push('location.poc');

  // --- Value-area position -------------------------------------------------
  if (price != null && vah != null && val != null && vah > val) {
    out.push({ name: 'valueArea', value: bounded((2 * ((price - val) / (vah - val)) - 1) * cfg.fullPct.valueArea),
      detail: 'inside/outside value area: ' + (price > vah ? 'above VAH' : price < val ? 'below VAL' : 'inside') });
  } else missing.push('location.vah/val');

  // --- VWAP stack ----------------------------------------------------------
  const stack = isKnown(L.stack) ? String(L.stack).toUpperCase() : null;
  if (stack != null && STACK_LEAN[stack] !== undefined) {
    out.push({ name: 'stack', value: bounded(STACK_LEAN[stack] * cfg.fullPct.stack), detail: 'VWAP stack ' + stack });
  } else missing.push('location.stack');

  return { out, missing, halfVa, vah, val, poc, vwap, stack, price };
}

/**
 * locationEvidence(snapshot, opts) -> ONE bounded, direction-aligned location value,
 * its parts, what was missing, and the levels price is sitting on.
 *
 * `raw` is the price-vs-level read with no side attached (positive = price is on the
 * higher side of the levels). `value` is `raw` aligned to the trade: a SHORT wants
 * price BELOW the levels, so a SHORT at a high-location price scores negative
 * location, which is exactly what a location group should say.
 */
function locationEvidence(snapshot, opts = {}) {
  const dir = opts.direction === 'LONG' ? 1 : opts.direction === 'SHORT' ? -1 : null;
  const cfg = CONFIG.location;
  const { out, missing, halfVa, vah, val, poc, vwap, stack, price } = subReads(snapshot);
  const L = (snapshot && snapshot.location) || {};

  // The scored family as a group: bounded mean damped by agreement, identical rule to
  // momentum's group(). Two readings in violent disagreement must not average out to
  // a confident middle.
  let raw = null, agreement = null, mean = null;
  if (out.length) {
    const vals = out.map((p) => p.value);
    const sum = vals.reduce((a, b) => a + b, 0);
    const absSum = vals.reduce((a, b) => a + Math.abs(b), 0);
    mean = +(sum / vals.length).toFixed(4);
    agreement = absSum > 0 ? +(Math.abs(sum) / absSum).toFixed(3) : 0;
    raw = bounded(mean * agreement);
  }
  const value = raw == null ? null : (dir == null ? raw : bounded(raw * dir));

  // --- rejection from a level (spec 14) -----------------------------------
  // A risk, never a score. Sitting ON a level is not evidence about direction; it is
  // a reason to expect a fight, and the spec lists it under location rather than
  // under exhaustion.
  const nearLevels = [];
  const pctFrom = (level, name) => {
    if (price == null || level == null || level <= 0) return;
    const dist = Math.abs((price - level) / level) * 100;
    if (dist <= cfg.rejectFromLevelPct) nearLevels.push({ level: name, distancePct: +dist.toFixed(3) });
  };
  pctFrom(vwap, 'vwap');
  pctFrom(poc, 'poc');
  pctFrom(vah, 'vah');
  pctFrom(val, 'val');
  const posInRange = num(L.posInRange);
  const camZone = isKnown(L.camZone) ? String(L.camZone).toUpperCase() : null;

  // --- display-only context (NOT scored, spec 14) --------------------------
  const display = {
    camZone,
    camLean: camZone != null && CAM_ZONE_LEAN[camZone] !== undefined ? CAM_ZONE_LEAN[camZone] : null,
    posInRange,
    rangeLean: posInRange == null ? null : bounded((posInRange - 50) / 50),
    stack,
    vwapSlope: num(L.vwapSlope),
    valueAreaWidthPct: (vah != null && val != null && vah > 0) ? +(((vah - val) / vah) * 100).toFixed(3) : null,
    note: 'camZone and posInRange are DISPLAY-ONLY: spec Section 14 defers Camarilla scoring, and no point weight was pre-registered for range position.',
  };

  const risks = [];
  if (nearLevels.length) risks.push('RISK_LOCATION: price at ' + nearLevels.map((n) => n.level + ' (' + n.distancePct + '%)').join(', '));
  if (agreement != null && agreement < 0.5) risks.push('RISK_LOCATION_DISAGREEMENT: readings agree only ' + (100 * agreement).toFixed(0) + '%');

  return {
    value, raw, direction: opts.direction || null,
    parts: out.map((p) => Object.assign({}, p, { aligned: dir == null || p.value == null ? p.value : bounded(p.value * dir) })),
    mean, agreement, n: out.length,
    halfVa,
    nearLevels, risks, display,
    missing, legible: raw != null,
    // What this component could not do, said out loud rather than approximated.
    notRunnable: [
      'FRVP (spec 14 deferred: adds many level inputs at once)',
      'Camarilla scoring (spec 14: GB Camarilla context may be displayed but is NOT scored in v1)',
      'prior-session levels — GB carries posVsPD as a constant "INSIDE RANGE" on every row, so it has no variance to score',
    ],
    text: raw == null
      ? 'no location reading (missing: ' + missing.join(', ') + ')'
      : 'raw ' + (raw > 0 ? '+' : '') + raw.toFixed(2) + ' from ' + out.length + ' read(s)'
        + (agreement == null ? '' : ' (' + (100 * agreement).toFixed(0) + '% agree)')
        + (value == null ? '' : ' · aligned ' + (value > 0 ? '+' : '') + value.toFixed(2)),
  };
}

/** The single bounded read the gates need, so gates and scoring cannot disagree. */
function locationRead(snapshot) {
  const ev = locationEvidence(snapshot, {});
  return ev.raw;
}

const LOCATION_FIELDS = [
  'location.vwap', 'location.poc', 'location.vah', 'location.val',
  'location.posInRange', 'location.stack', 'location.camZone', 'location.vwapSlope',
];

module.exports = {
  locationEvidence, locationRead, subReads, CAM_ZONE_LEAN, STACK_LEAN, LOCATION_FIELDS, bounded,
};
