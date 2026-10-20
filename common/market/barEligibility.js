/**
 * common/market/barEligibility.js — "is this name tradeable TODAY", judged on the
 * 1-MINUTE TAPE rather than on the day's cumulative volume.
 *
 * THE RULE (the user's, as asked): "if in a day volume of a 1m is null or below
 * 500 [then] that day was not eligible" — and judged on Yahoo Finance data, because
 * that is the feed the intraday engine actually reads (fetchIntradaySeries).
 *
 * WHY THE DAY AND NOT JUST THE SIGNAL BAR: a single 20-share minute is not the
 * problem on its own; the problem is that it is REPRESENTATIVE. On a name whose
 * minutes are routinely 11-30 shares, every volume reading is a number about one
 * ticket, and worse, the RATIOS still read healthy: volX divides the recent average
 * by the day's average, volPace divides by the session MEDIAN bar, and a dead tape
 * forms its own tiny average — so 20 shares reads as "1.0x, volume confirmed".
 * Refusing the DAY is the only form of this rule that survives that arithmetic.
 *
 * ============================ MEASURED, 28-Sep ============================
 * Yahoo 1m volume for NSE, regular session only (09:15-15:15), 360 bars/name:
 *
 *   symbol      nulls   min     median    max       bars < 500
 *   RELIANCE        0      0     26,973   245,924      0.3%
 *   HBLENGINE       0      0      4,958   152,448      1.4%
 *   PFOCUS          1      0      2,329    71,747     25.8%
 *   SPAL          192      0         22     1,114     45.8%
 *   JAGSNPHARM     91      0        201   103,112     50.0%
 *   ICICIGI         1      0        411    19,959     53.9%
 *   WENDT         167      0          7       421     53.6%
 *   QUESS           3      0        258    74,057     62.5%
 *   NEOGEN          1      0        212     9,777     71.4%
 *   JKCEMENT       97      0         22       513     72.8%
 *
 * TWO THINGS FOLLOW, AND BOTH ARE WHY THIS MODULE HAS A SHARE THRESHOLD:
 *
 *  1. "ANY thin bar disqualifies the day" cannot be applied to Yahoo volume as-is.
 *     RELIANCE — the most liquid name on the exchange — has a 0-volume minute and
 *     one bar under 500 out of 360. A literal any-bar rule would empty the board,
 *     which is what "it not performing" looks like from the outside: a filter that
 *     passes a dead tape and refuses a good one.
 *  2. The <500 SHARE separates cleanly where "any" does not: 0.3% and 1.4% for the
 *     liquid names, 26-73% for everything Yahoo cannot measure. AND the hard cases
 *     are Yahoo's fault, not the market's: JKCEMENT is a Nifty-50 name whose Yahoo
 *     median minute reads 22 shares. So the rule is honest about which feed it is
 *     judging, and the fix for that case is real exchange volume (the tick board's
 *     own tape), not a looser rule.
 *
 * DEFAULT: refuse the day when MORE THAN 20% of its 1m bars are null or below 500.
 * GB_MAX_THIN_BAR_SHARE=0 gives the user's literal any-bar rule; GB_MIN_BAR_SHARES_1M
 * moves the per-bar floor. Both are read by the caller, so the rule stays pure here.
 */

const DEFAULT_MIN_SHARES = 500;      // per 1-minute bar
const DEFAULT_MAX_THIN_SHARE = 0.20; // refuse the day above this share of thin bars

/**
 * eligibility(bars, opts) -> { ok, why, bars, thin, nullVol, thinShare, worst, floor }
 *
 * bars — the 1m series the engine reads: [{ t, o, h, l, c, v }], v possibly null
 *        (Yahoo returns null for minutes with no trade; that is a reading, not a
 *        missing field, so it counts as thin rather than being skipped).
 *
 * A bar counts as thin when its volume is null, not finite, or below minShares.
 * `worst` is the smallest FINITE volume seen (null when there was none), so a
 * refusal can always be reported with the number that caused it.
 */
function eligibility(bars, opts = {}) {
  const minShares = opts.minShares != null ? Number(opts.minShares) : DEFAULT_MIN_SHARES;
  const maxThinShare = opts.maxThinShare != null ? Number(opts.maxThinShare) : DEFAULT_MAX_THIN_SHARE;
  const list = Array.isArray(bars) ? bars : [];
  if (!list.length) return { ok: false, why: 'no 1m bars to judge', bars: 0, thin: 0, nullVol: 0, thinShare: null, worst: null, floor: minShares };

  let thin = 0, nullVol = 0;
  let worst = null;
  let worstAt = null;
  for (const b of list) {
    const raw = b && b.v;
    const v = raw == null ? null : Number(raw);
    if (v == null || !Number.isFinite(v)) { nullVol++; thin++; continue; }
    if (worst == null || v < worst) { worst = v; worstAt = b.t != null ? b.t : null; }
    if (v < minShares) thin++;
  }
  const thinShare = +(thin / list.length).toFixed(4);
  const ok = thinShare <= maxThinShare;
  let why = null;
  if (!ok) {
    why = 'thin 1m tape: ' + thin + '/' + list.length + ' bars (' + (thinShare * 100).toFixed(1)
      + '%) null or under ' + minShares + ' shares'
      + (nullVol ? ' — ' + nullVol + ' with no volume at all' : '')
      + (worst != null ? ' (smallest ' + worst + ')' : '');
  }
  return {
    ok, why,
    bars: list.length, thin, nullVol, thinShare, worst, worstAt,
    floor: minShares, maxThinShare,
  };
}

module.exports = { eligibility, DEFAULT_MIN_SHARES, DEFAULT_MAX_THIN_SHARE };
