/**
 * gb_scoring_v2/orderflow/volumeEngine.js — PHASE 5: IS ANYONE ACTUALLY TRADING THIS MOVE?
 *
 * Two independent questions, both from the SEALED 1m bars the footprint layer already builds, so
 * this costs no extra data:
 *
 *   volume_confirmed — is the current bar's traded volume at least the rolling 20-bar average?
 *                      A move on falling volume is a move nobody is joining.
 *   range_expansion  — is the current bar's range at least 1.3x the rolling average range?
 *                      The plan's own expansion test; it distinguishes a bar that TRENDED from a
 *                      bar that merely closed a little away from where it opened.
 *
 * AVERAGE INCLUDES THE CURRENT BAR, DELIBERATELY. Excluding it makes the test compare a move
 * against a baseline the move cannot influence — but it also makes one huge bar set its own
 * baseline, so the numerator always clears it. Including it is the plan's literal form and the
 * conservative one: a bar must beat an average it is already part of.
 *
 * WARMUP IS REPORTED, NOT ASSUMED. Below `MIN_BARS` sealed bars there is no rolling average worth
 * the name, so both flags are null and `warmup` is set. null is not false: the gate must be able
 * to tell "volume did not confirm" from "we do not know yet".
 */
const MIN_BARS = 5;
const ROLL = 20;

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** rangeOf(bar) — high - low, or null when the bar has no both-sided print. */
function rangeOf(bar) {
  if (!bar || bar.h == null || bar.l == null) return null;
  return Math.max(0, bar.h - bar.l);
}

/**
 * measure(bars, opts) — the volume/range read for a symbol's sealed bars (oldest first).
 * `current` compares the LAST sealed bar, which is the bar the rest of the gate is judging.
 */
function measure(bars, opts = {}) {
  const roll = opts.roll || ROLL;
  const minVolRatio = opts.minVolRatio || 1.0;
  const minRangeRatio = opts.minRangeRatio || 1.3;
  const list = Array.isArray(bars) ? bars.filter((b) => b && b.vol != null) : [];
  if (list.length < MIN_BARS) {
    return { bars: list.length, volumeConfirmed: null, rangeExpansion: null, volRatio: null, rangeRatio: null, avgVol: null, avgRange: null, warmup: 'fewer than ' + MIN_BARS + ' sealed bars' };
  }
  const win = list.slice(-roll);
  const cur = win[win.length - 1];
  const avgVol = avg(win.map((b) => b.vol || 0));
  const ranges = win.map(rangeOf).filter((v) => v != null);
  const avgRange = ranges.length >= MIN_BARS ? avg(ranges) : null;
  const curRange = rangeOf(cur);
  const volRatio = avgVol > 0 ? +(cur.vol / avgVol).toFixed(3) : null;
  const rangeRatio = (avgRange != null && avgRange > 0 && curRange != null) ? +(curRange / avgRange).toFixed(3) : null;
  return {
    bars: list.length,
    window: win.length,
    volumeConfirmed: volRatio == null ? null : volRatio >= minVolRatio,
    rangeExpansion: rangeRatio == null ? null : rangeRatio >= minRangeRatio,
    volRatio,
    rangeRatio,
    avgVol: +avgVol.toFixed(2),
    avgRange: avgRange == null ? null : +avgRange.toFixed(3),
    curVol: +cur.vol.toFixed(2),
    curRange: curRange == null ? null : +curRange.toFixed(3),
    warmup: rangeRatio == null ? 'range needs ' + MIN_BARS + ' bars with both sides printed' : null,
    thresholds: { minVolRatio, minRangeRatio, roll },
  };
}

module.exports = { measure, rangeOf, MIN_BARS, ROLL };
