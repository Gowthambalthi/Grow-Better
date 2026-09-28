/**
 * gb_scoring_v2/momentum/index.js — PHASE 5: VOLATILITY-NORMALIZED ROC.
 *
 * V3 Section 9. Phase 5 done-when: "Bounded evidence values; 3m included only if
 * already present."
 *
 * THE PROBLEM THIS SOLVES (spec Section 9.1): "Fixed ROC thresholds mean different
 * things in a 1.5% ATR stock and a 6% ATR stock." A 0.5% move in ten seconds is a
 * violent event in a sleepy large-cap and noise in a small-cap that swings 6% a day.
 * So each horizon's ROC is divided by that name's OWN expected move over the same
 * horizon, and the result is squashed to [-1, +1]:
 *
 *     z_h = ROC_h / sigma_h
 *     e_h = clip(z_h, -3, +3) / 3
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It produces EVIDENCE, not points.
 * Section 17's ranges (fast 0-6, structural 0-6, acceleration 0-3) belong to
 * Phase 11, whose done-when is the scored decision. The spec's own update is
 * explicit here: "components produce normalized evidence first" with "final
 * weights determined after replay/baseline validation".
 * Emitting points here would quietly fix weights before replay, which is the one
 * thing the build rules forbid.
 *
 * THREE GROUPS, NOT EIGHT VOTES (spec Section 9.2). "Each group produces one bounded
 * value; agreement between horizons raises the value, disagreement lowers it. Six
 * ROC readings are not six votes." So a group is NOT the mean of its horizons: the
 * mean is multiplied by an AGREEMENT ratio (|sum| / sum|.|). Three horizons that all
 * say +0.4 give +0.4; two that say +0.4 and one that says -0.4 give roughly +0.09,
 * because the group does not actually agree. That is the whole point -- correlated
 * readings must not add up as if they were independent confirmations.
 */
const { CONFIG } = require('../config/index');
const { isKnown } = require('../adapter/provenance');

const bounded = (v) => (v == null ? null : Math.max(-1, Math.min(1, v)));
const clipZ = (z, n) => Math.max(-n, Math.min(n, z));

function istMinutes(now) {
  const d = new Date(now + (5.5 * 60 + new Date(now).getTimezoneOffset()) * 60000);
  return d.getHours() * 60 + d.getMinutes();
}
const OPEN_MIN = 9 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

/**
 * timeOfDayFactor(now) — the expected move is larger just after the open and into
 * the close, so the same ROC deserves more credit mid-session than at 09:16.
 * PLACEHOLDER shape (linear decay over the first hour, ramp into the last 30 min);
 * the spec says this scaling is "later replaced or checked against realized
 * same-horizon volatility from recorded data".
 */
function timeOfDayFactor(now = Date.now()) {
  const adj = CONFIG.roc.timeOfDayAdjust;
  if (!adj || !adj.enabled) return 1;
  const mins = istMinutes(now);
  const fromOpen = mins - OPEN_MIN;
  const toClose = CLOSE_MIN - mins;
  if (fromOpen < 0 || toClose < 0) return 1;             // outside the session: no adjustment
  if (fromOpen < 60) return +(1 + (adj.openFactor - 1) * (1 - fromOpen / 60)).toFixed(4);
  if (toClose < 30) return +(1 + (adj.closeFactor - 1) * (1 - toClose / 30)).toFixed(4);
  return 1;
}

/**
 * sigmaFor(horizon, atrPct, factor) — the name's expected move over that horizon.
 * Built from ATR14% scaled by a per-horizon fraction (CONFIG.roc.sigmaFromAtr).
 * Returns null when ATR is unknown: a missing ATR must NOT default to a "typical"
 * volatility, because that would silently invent the denominator of every score.
 */
function sigmaFor(horizon, atrPct, factor = 1) {
  if (!isKnown(atrPct) || atrPct <= 0) return null;
  const frac = CONFIG.roc.sigmaFromAtr[horizon];
  if (!isKnown(frac)) return null;
  const s = atrPct * frac * factor;
  return s > 0 ? +s.toFixed(6) : null;
}

/** The horizon -> snapshot field map. 3m is optional and only used when present. */
const HORIZON_FIELD = {
  '10s': 'roc10', '20s': 'roc20', '30s': 'roc30',
  '1m': 'roc1m', '3m': 'roc3m', '5m': 'roc5m', '15m': 'roc15m',
};

/**
 * normalizedRoc(snapshot, opts) -> per-horizon { roc, sigma, z, e } + what was missing.
 * An unknown ROC or an unknown ATR yields e = null, never 0. A zero would claim
 * "this horizon is flat"; null says "this horizon was not observed".
 */
function normalizedRoc(snapshot, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const factor = opts.timeFactor != null ? opts.timeFactor : timeOfDayFactor(now);
  const atrPct = snapshot && snapshot.price_evidence ? snapshot.price_evidence.atrPct : null;
  const pe = (snapshot && snapshot.price_evidence) || {};
  const horizons = {}, missing = [];
  const keys = ['10s', '20s', '30s', '1m', '3m', '5m', '15m'];
  for (const h of keys) {
    const field = HORIZON_FIELD[h];
    const roc = isKnown(pe[field]) ? pe[field] : null;
    const sigma = sigmaFor(h, atrPct, factor);
    if (roc == null || sigma == null) {
      horizons[h] = { roc, sigma, z: null, e: null };
      missing.push('momentum.' + h + (roc == null ? ' (no ROC)' : ' (no ATR for sigma)'));
      continue;
    }
    const z = roc / sigma;
    horizons[h] = { roc, sigma, z: +z.toFixed(4), e: +(clipZ(z, CONFIG.roc.clipZ) / CONFIG.roc.clipZ).toFixed(4) };
  }
  return { atrPct, timeFactor: factor, horizons, missing, clippedAt: CONFIG.roc.clipZ };
}

/**
 * group(vals, horizons) -> ONE bounded value for the group.
 * value = bounded(mean(e) * agreement), agreement = |sum e| / sum |e|.
 * A group with a single usable horizon has agreement 1, so it passes its own read
 * through rather than being penalised for being alone.
 */
function group(horizons, keys) {
  const parts = keys.map((h) => ({ horizon: h, e: horizons[h] ? horizons[h].e : null, roc: horizons[h] ? horizons[h].roc : null }))
    .filter((p) => isKnown(p.e));
  if (!parts.length) return { value: null, n: 0, agreement: null, mean: null, parts, why: 'no horizon in this group had both a ROC and an ATR' };
  const es = parts.map((p) => p.e);
  const sum = es.reduce((a, b) => a + b, 0);
  const absSum = es.reduce((a, b) => a + Math.abs(b), 0);
  const mean = sum / es.length;
  const agreement = absSum > 0 ? Math.abs(sum) / absSum : 0;
  const value = bounded(mean * agreement);
  return {
    value, n: es.length, agreement: +agreement.toFixed(3), mean: +mean.toFixed(4), parts,
    why: agreement >= 0.999 ? 'horizons agree' : 'horizons disagree (' + (100 * agreement).toFixed(0) + '% agreement) — the value is damped accordingly',
  };
}

/** The group's horizon list, with 3m appended only when the feed actually carries it. */
function structuralHorizons(snapshot) {
  const base = CONFIG.roc.structuralHorizons.slice();      // ['1m','5m','15m']
  if (!CONFIG.roc.optionalHorizons.includes('3m')) return base;
  const has3m = snapshot && snapshot.price_evidence && isKnown(snapshot.price_evidence.roc3m);
  if (!has3m) return base;
  // Inserted in time order so the group reads naturally and the agreement arithmetic
  // never changes because of ordering.
  return ['1m', '3m', '5m', '15m'];
}

function fastGroup(snapshot, opts = {}) {
  const nr = opts.normalized || normalizedRoc(snapshot, opts);
  return Object.assign({ group: 'fast', horizons: CONFIG.roc.fastHorizons.slice() }, group(nr.horizons, CONFIG.roc.fastHorizons));
}
function structuralGroup(snapshot, opts = {}) {
  const nr = opts.normalized || normalizedRoc(snapshot, opts);
  const hs = structuralHorizons(snapshot);
  const g = group(nr.horizons, hs);
  // HONEST FLAG. "Included" must mean the 3m read actually CONTRIBUTED, not merely
  // that the field existed -- otherwise the report claims a four-horizon group
  // while three horizons did the work, and a missing sigma would be invisible.
  const contributed = g.parts.some(p => p.horizon === '3m');
  return Object.assign({ group: 'structural', horizons: hs, threeMinuteIncluded: hs.includes('3m') && contributed }, g);
}

/**
 * acceleration — "Fast rate vs structural rate: is the move speeding up or fading?"
 * (spec 9.2). It only means something when the two groups point the SAME way: if the
 * fast read is up and the structural read is down, there is no acceleration to
 * measure, only disagreement, and 0 is the honest answer (the disagreement is
 * already reported by the direction/conflict gates).
 */
function acceleration(fast, structural) {
  const f = fast ? fast.value : null;
  const s = structural ? structural.value : null;
  if (!isKnown(f) || !isKnown(s)) {
    return { group: 'acceleration', value: null, fast: f, structural: s, why: 'needs both the fast and structural groups' };
  }
  const sf = Math.sign(f);
  if (sf === 0 || Math.sign(s) !== sf) {
    return { group: 'acceleration', value: 0, fast: f, structural: s, why: 'fast and structural disagree — no coherent acceleration to measure' };
  }
  const delta = Math.abs(f) - Math.abs(s);
  const value = bounded(sf * delta);
  return {
    group: 'acceleration', value, fast: f, structural: s, delta: +delta.toFixed(4),
    why: value > 0 ? 'fast exceeds structural — the move is speeding up'
      : value < 0 ? 'fast is below structural — the move is fading'
      : 'fast and structural are equal',
  };
}

/**
 * momentumEvidence(snapshot, opts) -> the three bounded values, their inputs, and
 * the prior-move read the exhaustion detector needs (spec 9.2: "the 5m/15m
 * normalized move also provides the prior move size input to the exhaustion
 * detector").
 */
function momentumEvidence(snapshot, opts = {}) {
  const nr = normalizedRoc(snapshot, opts);
  const fast = fastGroup(snapshot, { normalized: nr });
  const structural = structuralGroup(snapshot, { normalized: nr });
  const accel = acceleration(fast, structural);
  const pe = (snapshot && snapshot.price_evidence) || {};
  // Prior move: the magnitude (not sign) of the larger structural horizons, because
  // exhaustion asks "has it ALREADY moved a lot", and that question is directional-
  // neutral until the direction gate picks a side.
  const priorKeys = CONFIG.exhaustion.priorMoveHorizons;      // ['5m','15m']
  const priorVals = priorKeys.map((h) => (nr.horizons[h] ? nr.horizons[h].e : null)).filter(isKnown);
  const priorMove = priorVals.length ? +Math.max(...priorVals.map(Math.abs)).toFixed(4) : null;
  return {
    fast: fast.value, structural: structural.value, acceleration: accel.value,
    priorMove,
    bounded: [fast.value, structural.value, accel.value].every((v) => v == null || (v >= -1 && v <= 1)),
    groups: { fast, structural, acceleration: accel },
    normalized: nr,
    missing: nr.missing,
    text: momentumText(fast, structural, accel),
  };
}

function momentumText(fast, structural, accel) {
  const f = (v) => (v == null ? 'n/a' : (v > 0 ? '+' : '') + v.toFixed(2));
  return 'fast ' + f(fast.value) + ' (' + (fast.agreement == null ? 'n/a' : (100 * fast.agreement).toFixed(0) + '% agree') + ')'
    + ' · structural ' + f(structural.value) + (structural.threeMinuteIncluded ? ' [incl 3m]' : '')
    + ' · accel ' + f(accel.value);
}

module.exports = {
  normalizedRoc, fastGroup, structuralGroup, acceleration, momentumEvidence,
  sigmaFor, timeOfDayFactor, structuralHorizons, group, HORIZON_FIELD,
};
