/**
 * gb_scoring_v2/raschke/setups.js — THE THREE SETUPS, AND RISK BEFORE ENTRY.
 *
 * The framework translated to this market with the timeframes it names:
 *
 *     15m → context      (which game are we playing: trend, rotation, or breakout)
 *      5m → structure    (ADX > 30 and the 20 EMA are the documented measures)
 *      1m → execution    (the setup bar, the trigger, the swing that invalidates it)
 *
 * The three setups, from the documented material:
 *
 *   PULLBACK-REENTRY ("Holy Grail") — strong trend, ADX > 30, pullback toward the 20 EMA, trigger
 *       beyond the pullback bar's extreme, stop beyond the swing. Entry is NOT the breakout and
 *       NOT the pullback: it is the resumption.
 *   ANTI — a strong impulse, a short counter-move that FAILS, then a re-entry in the DIRECTION OF
 *       THE ORIGINAL MOMENTUM. This is the one that is easy to get wrong: it is not "five candles
 *       up, so sell". The counter-move has to fail against a structural level (the impulse's own
 *       retracement limit and the impulse origin), and the trade joins the impulse, not the fade.
 *   CONGESTION-BREAKOUT — a tight box, a bar that escapes it on expanding range and volume, with
 *       the documented FAIL-BACK rule (a close back inside the box is a failure, not a hold).
 *
 * RISK COMES BEFORE THE ENTRY, as the material insists: every setup must produce its invalidation
 * level from STRUCTURE (the swing, the failed counter-move's extreme, the box edge) before the
 * trade is considered, and `planForSetup` refuses a setup whose structural stop is too tight to be
 * real (under the floor) or so wide that the position is unmanageable. A setup with no derivable
 * stop is not a candidate — it is dropped, never given an arbitrary one.
 *
 * CONFIRMATIONS ARE TAGS, NOT GATES. The brief is explicit: "I would start with just Impulse →
 * Pullback → Re-entry, rather than combining ROC + FVG + POC + VWAP + many other filters
 * immediately." So the fast ROC ladder, the last-5-candle read and the location levels are
 * attached to each candidate as EVIDENCE with their values, and the backtest measures the setup
 * with and without them — the filter's contribution is a question for data, not an assumption in
 * code.
 */
const IND = require('./indicators');

const DEF = {
  // structure (5m)
  adxMin: 30,               // the documented threshold
  emaPullback: 20,          // the documented pullback magnet
  pullbackTouchAtr: 0.35,   // "toward the 20 EMA" — a touch, not a break
  // impulse / anti
  impulseBars: 4,
  impulseAtrX: 1.5,         // the impulse must be this many ATRs of expansion
  antiFailFrac: 0.618,      // the counter-move may not retrace more than this
  antiMaxCounterBars: 3,
  // congestion
  congestionBars: 8,
  congestionMaxRangeFrac: 0.9,
  // expansion evidence (range/volume/activity)
  minRangeRatio: 1.2,
  minVolRatio: 0.9,
  // risk
  minRiskPct: 0.15,
  maxRiskPct: 3.0,
  rewardRisk: 2.0,
  timeExitBars: 60,         // an intraday trade is not held past its own session
  swingLookback: 30,
  swingStrength: 2,
};

function lastCompleteBucketIndex(bars1m, i, minutes) {
  // the 1m index i belongs to the bucket starting at floor(t/bucket); the last COMPLETE bucket is
  // the one before it, so structure never reads a half-formed 5m or 15m bar
  const bucket = Math.floor(bars1m[i].t / (minutes * 60000)) * (minutes * 60000);
  // find the newest 1m bar whose bucket started before that one
  for (let j = i; j >= 0; j--) {
    const b = Math.floor(bars1m[j].t / (minutes * 60000)) * (minutes * 60000);
    if (b < bucket) return j;
  }
  return -1;
}

/**
 * buildContext(bars1m) — every measure the setups read, aligned to the 1m index, computed once in a
 * forward pass. This is what keeps a 7,500-bar × 1,000-symbol replay affordable, and more
 * importantly it keeps the 5m/15m reads on the timeframe boundary rather than recomputed ad hoc.
 */
function buildContext(bars1m, opts = {}) {
  const o = Object.assign({}, DEF, opts);
  const n = bars1m.length;
  const ctx = { m5: new Array(n).fill(null), m15: new Array(n).fill(null), atr: new Array(n).fill(null), ema20: new Array(n).fill(null) };
  const m5From = new Array(n).fill(-1);
  const m15From = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    m5From[i] = lastCompleteBucketIndex(bars1m, i, 5);
    m15From[i] = lastCompleteBucketIndex(bars1m, i, 15);
  }
  // cache the higher-timeframe series by "bars up to index j" so each distinct j is aggregated once
  const memo = { m5: new Map(), m15: new Map() };
  const seriesUpTo = (minutes, j) => {
    const key = j;
    const m = minutes === 5 ? memo.m5 : memo.m15;
    if (m.has(key)) return m.get(key);
    const agg = IND.aggregate(bars1m.slice(0, j + 1), minutes);
    // drop the last bucket: it is the one containing bar j and is still forming
    if (agg.length > 1) agg.pop();
    m.set(key, agg);
    return agg;
  };
  for (let i = 0; i < n; i++) {
    ctx.atr[i] = IND.atr(bars1m, 14, i);
    const m5 = m5From[i] >= 0 ? seriesUpTo(5, m5From[i]) : [];
    const m15 = m15From[i] >= 0 ? seriesUpTo(15, m15From[i]) : [];
    if (m5.length >= 20) {
      const a = IND.adx(m5, 14, m5.length - 1);
      const e = IND.ema(m5, o.emaPullback, m5.length - 1);
      const es = IND.emaSeries(m5, o.emaPullback);
      ctx.m5[i] = {
        adx: a ? a.adx : null, plusDI: a ? a.plusDI : null, minusDI: a ? a.minusDI : null, up: a ? a.up : null,
        ema: e, emaSlope: IND.slopePct(es, m5.length - 1, 3),
        bars: m5.length, last: m5[m5.length - 1], prev: m5[m5.length - 2] || null,
      };
    }
    if (m15.length >= 20) {
      const a = IND.adx(m15, 14, m15.length - 1);
      const e = IND.ema(m15, o.emaPullback, m15.length - 1);
      const es = IND.emaSeries(m15, o.emaPullback);
      ctx.m15[i] = {
        adx: a ? a.adx : null, plusDI: a ? a.plusDI : null, minusDI: a ? a.minusDI : null, up: a ? a.up : null,
        ema: e, emaSlope: IND.slopePct(es, m15.length - 1, 2), bars: m15.length,
      };
    }
  }
  return ctx;
}

/** regimeAt(ctx, i) — trending / rotating / breaking out, with the numbers behind the label. */
function regimeAt(ctx, i) {
  const m15 = ctx.m15[i], m5 = ctx.m5[i];
  if (!m15 && !m5) return { regime: 'UNKNOWN', note: 'not enough higher-timeframe history yet' };
  const src = m15 || m5;
  const adx = src.adx, up = src.up;
  const slope = src.emaSlope;
  if (adx == null) return { regime: 'UNKNOWN', adx: null, note: 'ADX window still filling' };
  if (adx >= 30) return { regime: up ? 'UP-TREND' : 'DOWN-TREND', adx, slope, note: 'strong ' + (up ? 'up' : 'down') + ' trend (ADX ' + adx + ')' };
  if (adx <= 20 && Math.abs(slope == null ? 0 : slope) < 0.1) return { regime: 'ROTATION', adx, slope, note: 'no trend — rotation (ADX ' + adx + ')' };
  return { regime: up ? 'UP-LEAN' : 'DOWN-LEAN', adx, slope, note: 'directional but not trending (ADX ' + adx + ')' };
}

/**
 * SETUP 1 — pullbackReentry(bars, ctx, i, o)
 * Strong trend (5m ADX > 30 in the same direction as the 15m read), a pullback that came toward the
 * 20 EMA, and a bar now closing back beyond the pullback bar's extreme. Stop beyond the swing.
 */
function pullbackReentry(bars, ctx, i, o = {}) {
  const opt = Object.assign({}, DEF, o);
  const m5 = ctx.m5[i];
  if (!m5 || m5.adx == null || m5.adx < opt.adxMin || m5.ema == null) return null;
  const m15 = ctx.m15[i];
  // CONTEXT AGREEMENT. The 15m decides which game we are in; a long pulled back inside a 15m down
  // trend is the classic way this setup gets misapplied.
  if (m15 && m15.adx != null && m15.adx >= 25) {
    const m15Up = !!m15.up;
    if (m15Up !== m5.up) return null;
  }
  const side = m5.up ? 'BUY' : 'SELL';
  const atr5 = IND.atr([m5.last], 1, 0);   // bar scale of the structure timeframe
  const tol = Math.max((ctx.atr[i] || 0) * opt.pullbackTouchAtr, (m5.last.h - m5.last.l) * 0.5);
  const touched = side === 'BUY' ? m5.last.l <= m5.ema + tol : m5.last.h >= m5.ema - tol;
  if (!touched) return null;
  // TRIGGER: the current 1m bar closing beyond the pullback bar's extreme, back in the trend
  // direction. This is "the resumption", not the pullback and not the original breakout.
  const cur = bars[i];
  const trigger = side === 'BUY' ? m5.last.h : m5.last.l;
  const fired = side === 'BUY' ? cur.c > trigger : cur.c < trigger;
  if (!fired) return null;
  const sw = IND.swings(bars, i, opt.swingLookback, opt.swingStrength);
  const swing = side === 'BUY' ? sw.low : sw.high;
  if (swing == null) return null;
  // the expansion evidence the framework names as confirmation (volume, range, activity). Carried on
  // the candidate rather than used as a filter, so a backtest can measure whether it selects.
  const rs = IND.rangeStats(bars, i, 20);
  return {
    setup: 'PULLBACK-REENTRY',
    side,
    entry: +cur.c.toFixed(2),
    stop: +swing.toFixed(2),
    stopBasis: (side === 'BUY' ? 'swing low ' : 'swing high ') + swing,
    evidenceTags: rs ? { rangeRatio: rs.rangeRatio, volRatio: rs.volRatio } : null,
    structure: { adx5: m5.adx, ema20_5m: +m5.ema.toFixed(2), pullbackTrigger: +trigger.toFixed(2), regime: regimeAt(ctx, i).regime },
    why: 'ADX(5m) ' + m5.adx + ' ' + (side === 'BUY' ? 'up' : 'down') + ' trend, pullback to the 20 EMA (' + (+m5.ema.toFixed(2)) + '), resumption through ' + (+trigger.toFixed(2)),
  };
}

/**
 * SETUP 2 — anti(bars, ctx, i, o)
 * Strong impulse → short counter-move that FAILS → re-entry with the original momentum.
 * The failure test is structural, and that is deliberate: the counter-move may not retrace more
 * than `antiFailFrac` of the impulse NOR take out the impulse origin. Only after that failure does a
 * bar closing back beyond the counter-move's extreme qualify. There is no path in this function
 * that shorts a strong up impulse merely because it went up.
 */
/**
 * impulseThenCounter(bars, i, impulseBars, maxBars, dir) — the impulse and the move against it.
 *
 * THE ORDER MATTERS AND AN EARLIER VERSION GOT IT WRONG. Finding "the bars that fell, backwards
 * from i-1" swallowed the LAST IMPULSE BAR into the counter-move, because a bar only has to be
 * lower than its predecessor to belong to a falling run — so the bar the impulse ended on was
 * counted as part of the pullback, the retracement came out short, and the setup fired on histories
 * that were not impulses at all. The extreme is located FIRST (the highest high for an up impulse),
 * and the counter-move is strictly the bars AFTER it. That is what the framework describes.
 */
function impulseThenCounter(bars, i, impulseBars, maxBars, dir) {
  const win = Math.min(i, impulseBars + maxBars);
  let exIdx = -1, exVal = dir === 'UP' ? -Infinity : Infinity;
  for (let j = Math.max(1, i - win); j <= i - 1; j++) {
    if (dir === 'UP' ? bars[j].h > exVal : bars[j].l < exVal) { exVal = dir === 'UP' ? bars[j].h : bars[j].l; exIdx = j; }
  }
  if (exIdx < 0) return null;
  const cmStart = exIdx + 1, cmEnd = i - 1;
  const cmBars = cmEnd - cmStart + 1;
  if (cmBars < 1 || cmBars > maxBars) return null;
  // the counter-move must be net AGAINST the impulse (an inside doji inside a pullback is allowed;
  // a leg that keeps advancing is not a counter-move)
  const netCounter = bars[cmEnd].c - bars[exIdx].c;
  if (dir === 'UP' && netCounter >= 0) return null;
  if (dir === 'DOWN' && netCounter <= 0) return null;
  return { exIdx, exVal, cmStart, cmEnd, cmBars, netCounter };
}

function anti(bars, ctx, i, o = {}) {
  const opt = Object.assign({}, DEF, o);
  const a = ctx.atr[i];
  if (a == null || i < opt.impulseBars + 4) return null;
  const cur = bars[i];
  // two candidate histories: impulse up then a down counter-move, and the mirror
  for (const dir of ['UP', 'DOWN']) {
    const cm = impulseThenCounter(bars, i, opt.impulseBars, opt.antiMaxCounterBars, dir);
    if (!cm) continue;
    const impEnd = cm.exIdx;                           // the impulse ENDS at its extreme
    const impStart = Math.max(0, impEnd - opt.impulseBars + 1);
    if (impEnd - impStart + 1 < 2) continue;
    let impLow = Infinity, impHigh = -Infinity;
    for (let j = impStart; j <= impEnd; j++) {
      impLow = Math.min(impLow, bars[j].l);
      impHigh = Math.max(impHigh, bars[j].h);
    }
    const impRange = impHigh - impLow;
    if (!(impRange > a * opt.impulseAtrX)) continue;   // no impulse, no Anti
    // the impulse must be net directional, not a wide whip: the leg's close moved with the extreme
    const beforeWindow = bars[Math.max(0, impStart - 1)].c;
    const net = bars[impEnd].c - beforeWindow;
    if (dir === 'UP' && net <= 0) continue;
    if (dir === 'DOWN' && net >= 0) continue;
    const origin = dir === 'UP' ? impLow : impHigh;    // where the impulse began
    if (dir === 'UP') {
      let cmLow = Infinity, cmHigh = -Infinity;
      for (let j = cm.cmStart; j <= cm.cmEnd; j++) { cmLow = Math.min(bars[j].l, cmLow); cmHigh = Math.max(bars[j].h, cmHigh); }
      const retrace = impRange > 0 ? (impHigh - cmLow) / impRange : 1;
      if (retrace > opt.antiFailFrac) continue;        // the counter-move SUCCEEDED — no Anti
      if (cmLow <= origin) continue;                   // origin taken out — this is a reversal, not an Anti
      if (!(cur.c > cmHigh)) continue;                 // no re-entry trigger yet
      const rs = IND.rangeStats(bars, i, 20);
      return {
        setup: 'ANTI',
        side: 'BUY',
        entry: +cur.c.toFixed(2),
        stop: +Math.min(cmLow, origin).toFixed(2),
        stopBasis: 'failed counter-move low ' + (+cmLow.toFixed(2)),
        structure: { impulseAtrX: +(impRange / a).toFixed(2), retrace: +retrace.toFixed(3), counterBars: cm.cmBars, regime: regimeAt(ctx, i).regime },
        evidenceTags: rs ? { rangeRatio: rs.rangeRatio, volRatio: rs.volRatio } : null,
        why: 'up impulse (' + (impRange / a).toFixed(1) + ' ATR) then a ' + cm.cmBars + '-bar counter-move that FAILED at ' + (retrace * 100).toFixed(0) + '% retrace, origin intact; re-entry through ' + (+cmHigh.toFixed(2)),
      };
    }
    // mirror for a down impulse
    let cmHigh = -Infinity, cmLow = Infinity;
    for (let j = cm.cmStart; j <= cm.cmEnd; j++) { cmHigh = Math.max(bars[j].h, cmHigh); cmLow = Math.min(bars[j].l, cmLow); }
    const retrace = impRange > 0 ? (cmHigh - impLow) / impRange : 1;
    if (retrace > opt.antiFailFrac) continue;
    if (cmHigh >= origin) continue;
    if (!(cur.c < cmLow)) continue;
    const rs2 = IND.rangeStats(bars, i, 20);
    return {
      setup: 'ANTI',
      side: 'SELL',
      entry: +cur.c.toFixed(2),
      stop: +Math.max(cmHigh, origin).toFixed(2),
      stopBasis: 'failed counter-move high ' + (+cmHigh.toFixed(2)),
      structure: { impulseAtrX: +(impRange / a).toFixed(2), retrace: +retrace.toFixed(3), counterBars: cm.cmBars, regime: regimeAt(ctx, i).regime },
      evidenceTags: rs2 ? { rangeRatio: rs2.rangeRatio, volRatio: rs2.volRatio } : null,
      why: 'down impulse (' + (impRange / a).toFixed(1) + ' ATR) then a ' + cm.cmBars + '-bar counter-move that FAILED at ' + (retrace * 100).toFixed(0) + '% retrace, origin intact; re-entry through ' + (+cmLow.toFixed(2)),
    };
  }
  return null;
}



/**
 * SETUP 3 — congestionBreakout(bars, ctx, i, o)
 * A tight box, then a bar that escapes it on expanding range and volume. The documented failure
 * mode is a FAIL-BACK into the box, so the invalidation is the box edge (the retest level) with an
 * ATR buffer, and `failBackLevel` is reported so a replay can apply the rule as its own exit.
 */
function congestionBreakout(bars, ctx, i, o = {}) {
  const opt = Object.assign({}, DEF, o);
  const i0 = i - 1;                                  // the box excludes the breakout bar itself
  if (i0 < opt.congestionBars) return null;
  const box = IND.congestion(bars, i0, opt.congestionBars, opt.congestionMaxRangeFrac);
  if (!box || !box.tight) return null;
  const cur = bars[i];
  const a = ctx.atr[i];
  if (a == null) return null;
  const rs = IND.rangeStats(bars, i, 20);
  if (!rs || rs.rangeRatio == null || rs.rangeRatio < opt.minRangeRatio) return null;
  if (rs.volRatio != null && rs.volRatio < opt.minVolRatio) return null;
  const side = cur.c > box.hi ? 'BUY' : cur.c < box.lo ? 'SELL' : null;
  if (!side) return null;
  const edge = side === 'BUY' ? box.hi : box.lo;
  const stop = side === 'BUY' ? Math.min(edge, cur.c) - a * 0.5 : Math.max(edge, cur.c) + a * 0.5;
  return {
    setup: 'CONGESTION-BREAKOUT',
    side,
    entry: +cur.c.toFixed(2),
    stop: +stop.toFixed(2),
    stopBasis: 'box edge ' + (+edge.toFixed(2)) + ' minus 0.5 ATR (a failed breakout buffer)',
    structure: { boxHi: +box.hi.toFixed(2), boxLo: +box.lo.toFixed(2), boxWidthAtr: box.widthAtr, congestionBars: opt.congestionBars, regime: regimeAt(ctx, i).regime },
    evidenceTags: { rangeRatio: rs.rangeRatio, volRatio: rs.volRatio },
    failBackLevel: +edge.toFixed(2),
    why: opt.congestionBars + '-bar box ' + (+box.lo.toFixed(2)) + '–' + (+box.hi.toFixed(2)) + ' (width ' + box.widthAtr + ' ATR) broken on ' + rs.rangeRatio + 'x range / ' + rs.volRatio + 'x volume',
  };
}

/**
 * candidatesAt(bars, ctx, i, o) — every setup that fires on bar i, each with a validated plan.
 * `planForSetup` can drop a candidate whose stop is not usable; a dropped candidate never reaches
 * the board or the backtest, because a trade without a location for its invalidation is not a
 * trade — it is a guess wearing a setup's name.
 */
function candidatesAt(bars, ctx, i, o = {}) {
  const raw = [
    pullbackReentry(bars, ctx, i, o),
    anti(bars, ctx, i, o),
    congestionBreakout(bars, ctx, i, o),
  ].filter(Boolean);
  return raw.map((c) => planForSetup(c, o)).filter(Boolean);
}

function planForSetup(c, o = {}) {
  const opt = Object.assign({}, DEF, o);
  const entry = c.entry, stop = c.stop;
  if (!(entry > 0) || !(stop > 0) || entry === stop) return null;
  const risk = Math.abs(entry - stop);
  const riskPct = (risk / entry) * 100;
  if (riskPct < opt.minRiskPct) return null;      // too tight to be a real invalidation
  if (riskPct > opt.maxRiskPct) return null;      // wider than a position can be managed at
  const up = c.side === 'BUY';
  return Object.assign({}, c, {
    riskPct: +riskPct.toFixed(3),
    target: +(up ? entry + risk * opt.rewardRisk : entry - risk * opt.rewardRisk).toFixed(2),
    rewardRisk: opt.rewardRisk,
    timeExitBars: opt.timeExitBars,
  });
}

module.exports = { DEF, buildContext, regimeAt, pullbackReentry, anti, congestionBreakout, candidatesAt, planForSetup, lastCompleteBucketIndex, impulseThenCounter };
