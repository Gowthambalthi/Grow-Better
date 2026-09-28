/**
 * gb_scoring_v2/candles/sequence.js — THE CANDLE SEQUENCE, NOT ONE LABEL.
 *
 * THE COMPLAINT THIS ANSWERS, AND IT WAS FAIR: the first version of the candle
 * module read ONE field -- GB's own `candlePattern` string -- and treated it as "the
 * candle reading". That is a single label about a single bar. It says nothing about
 * HOW the last candles formed, nothing about the gap between one candle's close and
 * the next candle's open, and nothing about what the next candle tends to do after a
 * formation like this one.
 *
 * This module works with REAL OHLC bars and does three separate things:
 *
 *   1. GEOMETRY. For each bar: body, both wicks, close position inside the range,
 *      and the gap between this bar's open and the PREVIOUS bar's close. The pattern
 *      label is then DERIVED from that geometry by an ordered, documented rule set --
 *      not read from a vendor string.
 *   2. SEQUENCE. The last N bars as a formation: run length of same-direction bars,
 *      higher-high/higher-low integrity, range compression vs expansion, where the
 *      last close sits inside the window's range, and the last few pattern labels in
 *      order. N is a parameter because the question "how far back" is an empirical
 *      one -- see LOOKBACKS.
 *   3. NEXT-CANDLE EXPECTATION, MEASURED. A conditional table learned from history:
 *      given a formation signature, what fraction of the time was the NEXT candle up,
 *      and by how much did it move. With a hierarchical backoff so a thin bucket
 *      borrows from a coarser signature instead of guessing, and a minimum-sample
 *      guard so it refuses rather than opines.
 *
 * WHAT THIS IS NOT. It is not a price predictor and it does not know the future. If
 * the next candle were predictable at 80% from the last twelve bars, this file would
 * be the most valuable code in the repository and every reader should be suspicious
 * of that claim. `gb_scoring_v2/candle-study.js` measures the honest accuracy, on a
 * held-out slice of time, against a shuffled-label null, and reports all of it.
 *
 * WHY 15-MINUTE BARS. data/ohlcv_15m is the deepest real OHLC history in this
 * project (989 symbols, ~123 sessions, 3.03M bars). The live engine sees 1-minute
 * bars, so a 15m study is not the same timeframe as production -- it is the only
 * place with enough bars to LEARN a conditional distribution instead of eyeballing
 * twelve of them. The module is timeframe-agnostic by construction: it takes bars.
 */
const { CONFIG } = require('./../config/index');
const { isKnown } = require('./../adapter/provenance');

const num = (v) => (isKnown(v) && typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 4) => (v == null ? null : +v.toFixed(d));

// ---------------------------------------------------------------------------
// 1. GEOMETRY
// ---------------------------------------------------------------------------

/**
 * shape(bar, priorBar) -> the geometry of one candle, plus the gap to the previous
 * one. `bar` is [time, open, high, low, close, volume] exactly as Angel's historical
 * API returns it, which is also the layout data/ohlcv_15m uses.
 *
 * All ratios are returned as fractions of the bar's own range, so they travel across
 * a Rs 90 stock and a Rs 4,000 stock without rescaling -- the same argument the spec
 * makes for volatility-normalized ROC in Section 9.1.
 */
function shape(bar, priorBar) {
  if (!bar || bar.length < 5) return null;
  const [t, o, h, l, c] = bar;   // [time, open, high, low, close, volume], as Angel returns it
  if (![o, h, l, c].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const range = h - l;
  const body = Math.abs(c - o);
  const dir = c > o ? 1 : c < o ? -1 : 0;
  const bodyPct = range > 0 ? body / range : 0;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const closePos = range > 0 ? (c - l) / range : 0.5;

  // THE GAP BETWEEN CANDLES, bar to bar. This is the number the earlier module could
  // not see: GB stores only the SESSION opening gap, so the close-to-open gap between
  // consecutive candles inside the day existed nowhere.
  const pc = priorBar && typeof priorBar[4] === 'number' ? priorBar[4] : null;
  const gapPct = pc != null && pc > 0 ? round(((o - pc) / pc) * 100, 4) : null;

  // THE RAW WICKS MUST REACH THE CLASSIFIER. An earlier version of this function
  // passed only `upperWickPct` / `lowerWickPct`, so every rule that compares a wick
  // against the body read `undefined`, every comparison was false, and HAMMER,
  // SHOOTING STAR, both ENGULFs, INSIDE BAR and OUTSIDE BAR could never fire. The
  // classifier was silently reduced to DOJI / MARUBOZU / NONE -- a no-op dressed as a
  // pattern engine, which is why the raw values are named explicitly here.
  // KEY NAMES MATTER, and this was the second half of the same no-op bug: the object
  // used to be built with `o/h/l/c`, but the classifier reads `open/high/low/close`,
  // so every engulf and every range-containment comparison was `undefined >= 90`.
  // Full names are used so the two sides are forced to agree.
  const geometry = { open: o, high: h, low: l, close: c, dir, bodyPct, closePos, upperWick, lowerWick, body, range };

  return {
    t, open: o, high: h, low: l, close: c,
    range, body, dir, bodyPct: round(bodyPct, 4),
    upperWick: round(upperWick, 4), lowerWick: round(lowerWick, 4),
    upperWickPct: round(range > 0 ? upperWick / range : 0, 4),
    lowerWickPct: round(range > 0 ? lowerWick / range : 0, 4),
    closePos: round(closePos, 4),
    gapPct,
    pattern: classifyPattern(geometry, priorBar),
  };
}

/**
 * classifyPattern(g, priorBar) -> one label DERIVED from geometry.
 *
 * PRECEDENCE IS PART OF THE RULE, because a bar can satisfy several descriptions at
 * once. The order below is fixed and documented so a reader can disagree with the
 * order rather than guess at it:
 *
 *   1. DOJI          body is at most `dojiBodyPct` of the range -- indecision wins,
 *                    because every engulf/hammer test below would misread it
 *   2. MARUBOZU      body is at least `marubozuBodyPct` of the range -- no wicks
 *   3. HAMMER        long lower wick, small upper wick, close near the high
 *   4. SHOOTING STAR mirror of HAMMER
 *   5. BULL/BEAR ENGULF  body swallows the previous bar's body, opposite direction
 *   6. OUTSIDE / INSIDE  range engulfs / is contained by the previous bar's range
 *   7. NONE
 *
 * Accuracy of these names is not the point and is not claimed. The POINT is that the
 * name is reproducible from the OHLC and is one of SEVERAL sequence features rather
 * than the whole reading.
 */
function classifyPattern(g, priorBar) {
  const cfg = (CONFIG.candles && CONFIG.candles.geometry) || {};
  const doji = isKnown(cfg.dojiBodyPct) ? cfg.dojiBodyPct : 0.1;
  const maru = isKnown(cfg.marubozuBodyPct) ? cfg.marubozuBodyPct : 0.9;
  const wickX = isKnown(cfg.wickMultiple) ? cfg.wickMultiple : 2.0;
  // DEFENSIVE, AND IT EARNED ITS PLACE: this classifier was once fed an object with
  // the wrong key names, and every wick rule silently evaluated `undefined >= n` and
  // returned NONE. A shape whose geometry is not fully present is refused outright, so
  // a future key mismatch fails loudly instead of producing a plausible label.
  if (!isKnown(g.body) || !isKnown(g.range) || g.range <= 0) return 'NONE';
  if (!isKnown(g.open) || !isKnown(g.high) || !isKnown(g.low) || !isKnown(g.close)) return 'NONE';

  if (g.bodyPct <= doji) return 'DOJI';
  if (g.bodyPct >= maru) return 'MARUBOZU';
  if (g.lowerWick >= wickX * g.body && g.upperWick <= g.body && g.closePos >= 0.6) return 'HAMMER';
  if (g.upperWick >= wickX * g.body && g.lowerWick <= g.body && g.closePos <= 0.4) return 'SHOOTING STAR';
  if (priorBar && priorBar.length >= 5) {
    const po = priorBar[1], ph = priorBar[2], pl = priorBar[3], pc = priorBar[4];
    const pdir = pc > po ? 1 : pc < po ? -1 : 0;
    if (g.dir === 1 && pdir === -1 && g.close >= po && g.open <= pc) return 'BULL ENGULF';
    if (g.dir === -1 && pdir === 1 && g.close <= po && g.open >= pc) return 'BEAR ENGULF';
    if (g.high >= ph && g.low <= pl) return 'OUTSIDE BAR';
    if (g.high <= ph && g.low >= pl) return 'INSIDE BAR';
  }
  return 'NONE';
}

// ---------------------------------------------------------------------------
// 2. SEQUENCE — "how the last candles formed"
// ---------------------------------------------------------------------------

/** Coarse buckets, because fine buckets are how a signature overfits. */
const bucket = (v, lo, hi) => (v == null ? 'n/a' : v <= lo ? 'L' : v >= hi ? 'H' : 'M');
const closePosBucket = (v) => (v == null ? 'n/a' : v <= 1 / 3 ? 'BOT' : v >= 2 / 3 ? 'TOP' : 'MID');
const gapBucket = (pct) => {
  if (pct == null) return 'n/a';
  const cfg = (CONFIG.candles && CONFIG.candles.geometry) || {};
  const flat = isKnown(cfg.flatGapPct) ? cfg.flatGapPct : 0.05;
  if (pct > flat) return 'GAP_UP';
  if (pct < -flat) return 'GAP_DOWN';
  return 'FLAT';
};
const runBucket = (n) => (n >= 3 ? '3+' : String(n));

/**
 * sequence(bars, i, N) -> the formation as of bar i, looking back N bars.
 *
 * It never looks at bar i or later: bar i is the NEXT candle, the one to be
 * predicted, so touching it would be a look-ahead leak in the shape of a feature.
 * The window is bars [i-N .. i-1] inclusive.
 */
function sequence(bars, i, N = 12) {
  return sequenceFromShapes(shapesOf(bars), i, N);
}

/**
 * shapesOf(bars) — every bar's geometry, computed once. A study over millions of
 * observations cannot afford to recompute a window's shapes per lookback, and the
 * geometry of bar k never depends on which lookback is asking for it.
 */
function shapesOf(bars) {
  const out = new Array(bars.length);
  for (let k = 0; k < bars.length; k++) out[k] = shape(bars[k], bars[k - 1]);
  return out;
}

/** sequenceFromShapes(shapes, i, N) — the window ending at bar i-1, from precomputed shapes. */
function sequenceFromShapes(shapes, i, N = 12) {
  if (i < N) return null;
  const win = [];
  for (let k = i - N; k < i; k++) {
    const s = shapes[k];
    if (!s) return null;
    win.push(s);
  }
  const last = win[win.length - 1];
  const prev = win.length > 1 ? win[win.length - 2] : null;

  // Run length of consecutive same-direction candles ending at the last bar.
  let run = 0;
  for (let k = win.length - 1; k >= 0; k--) {
    if (win[k].dir === last.dir && last.dir !== 0) run++; else break;
  }

  // Structure: does the window still make higher highs AND higher lows?
  let higherHighs = 0, higherLows = 0;
  for (let k = 1; k < win.length; k++) {
    if (win[k].high > win[k - 1].high) higherHighs++;
    if (win[k].low > win[k - 1].low) higherLows++;
  }
  const struct = higherHighs + higherLows >= win.length ? 'UP' : (higherHighs + higherLows <= win.length * 0.4 ? 'DOWN' : 'MIXED');

  // Range expansion / compression: the last bar against the window's own average.
  const avgRange = win.reduce((a, s) => a + s.range, 0) / win.length;
  const rangeRatio = avgRange > 0 ? round(last.range / avgRange, 3) : null;

  // Where the last close sits inside the window's whole range.
  const hi = Math.max(...win.map((s) => s.high));
  const lo = Math.min(...win.map((s) => s.low));
  const posInWindow = hi > lo ? round((last.close - lo) / (hi - lo), 3) : 0.5;

  // The last few labels IN ORDER -- this is the part a single-pattern read cannot say.
  const labelRun = win.slice(-3).map((s) => s.pattern).join('>');

  return {
    N, last, prev, window: win,
    run, upCount: win.filter((s) => s.dir === 1).length, downCount: win.filter((s) => s.dir === -1).length,
    higherHighs, higherLows, struct,
    rangeRatio, rangeState: bucket(rangeRatio, 0.7, 1.4),
    posInWindow, posBucket: closePosBucket(posInWindow),
    labelRun,
    lastPattern: last.pattern,
    lastClosePos: closePosBucket(last.closePos),
    lastGap: gapBucket(last.gapPct),
    runBucket: runBucket(run),
  };
}

/**
 * SIGNATURE, COARSE-FIRST. The order is the backoff order: when a bucket is too thin
 * the LAST component is dropped first, so the most specific information is sacrificed
 * before the most general. Components were chosen so that each is a different
 * question -- shape, position, gap, persistence, structure -- rather than five
 * restatements of "the last candle went up".
 */
const SIGNATURE_ORDER = ['lastPattern', 'lastClosePos', 'lastGap', 'runBucket', 'struct', 'rangeState', 'posBucket'];

function signature(seq, level = SIGNATURE_ORDER.length) {
  return SIGNATURE_ORDER.slice(0, level).map((k) => seq[k]).join('|');
}

/** All backoff levels for one observation, coarsest last. */
function signatureLevels(seq) {
  const out = [];
  for (let L = SIGNATURE_ORDER.length; L >= 1; L--) out.push({ level: L, key: signature(seq, L) });
  return out;
}

// ---------------------------------------------------------------------------
// 3. THE MEASURED NEXT-CANDLE MODEL
// ---------------------------------------------------------------------------

/**
 * learn(rows, opts) -> { tables: [{level,key} -> {n,up,sumMove}], baseRate, minSamples }
 *
 * `rows` are { seq, up, movePct } observations. One table per backoff level, so a
 * prediction can walk down the levels instead of falling back to a single global
 * average the moment a specific bucket is thin.
 *
 * Nothing here is a threshold chosen after seeing the test set -- learn() sees only
 * what it is given, and the study script only ever gives it the training sessions.
 */
function learn(rows, opts = {}) {
  const minSamples = isKnown(opts.minSamples) ? opts.minSamples : 200;
  const tables = [];
  for (let L = SIGNATURE_ORDER.length; L >= 1; L--) tables.push(new Map());
  let n = 0, up = 0;
  for (const r of rows) {
    n++; if (r.up) up++;
    const levels = signatureLevels(r.seq);
    for (const { level, key } of levels) {
      const T = tables[SIGNATURE_ORDER.length - level];
      let e = T.get(key);
      if (!e) { e = { n: 0, up: 0, sumMove: 0 }; T.set(key, e); }
      e.n++; if (r.up) e.up++; e.sumMove += (r.movePct || 0);
    }
  }
  return { tables, baseRate: n ? up / n : null, n, minSamples, order: SIGNATURE_ORDER.slice() };
}

/**
 * predict(model, seq, opts) -> { key, level, n, pUp, expectMovePct, confident, reason }
 *
 * Walks from the most specific signature down to the coarsest and takes the first
 * bucket with at least `minSamples`. If even the coarsest bucket is too thin it
 * refuses (`confident: false`) rather than reporting a number nobody should act on --
 * which is the same rule the gates follow for unknown inputs.
 */
function predict(model, seq, opts = {}) {
  const wantP = isKnown(opts.confidentP) ? opts.confidentP : 0.55;
  for (let L = SIGNATURE_ORDER.length; L >= 1; L--) {
    const key = signature(seq, L);
    const T = model.tables[SIGNATURE_ORDER.length - L];
    const e = T && T.get(key);
    if (e && e.n >= model.minSamples) {
      const pUp = e.up / e.n;
      return {
        key, level: L, n: e.n, pUp: round(pUp, 4), expectMovePct: round(e.sumMove / e.n, 4),
        dir: pUp > 0.5 ? 1 : pUp < 0.5 ? -1 : 0,
        confident: pUp >= wantP || pUp <= 1 - wantP,
        reason: 'matched at backoff level ' + L + '/' + SIGNATURE_ORDER.length + ' on ' + e.n + ' training bars',
      };
    }
  }
  return { key: signature(seq, 1), level: 0, n: 0, pUp: null, expectMovePct: null, dir: 0, confident: false, reason: 'no bucket reached ' + model.minSamples + ' training bars — refusing rather than guessing' };
}

/** Base rate is the bar every prediction has to clear. */
function baseline(model) { return model.baseRate; }

/**
 * LOOKBACKS. "Use back more" is a testable claim, not a preference, so the study
 * sweeps these and reports accuracy and coverage for each. If looking back 24 bars
 * were better than 6, this table would show it -- and if it is not better, that is
 * worth knowing before the window is hard-coded anywhere.
 */
const LOOKBACKS = [3, 6, 12, 24];

/** Build { seq, up, movePct } observations from a bar array. NEVER peeks past i. */
function observations(bars, N, from = 0, to = null, shapes = null) {
  const sh = shapes || shapesOf(bars);
  const out = [];
  const end = to == null ? bars.length : Math.min(to, bars.length);
  for (let i = Math.max(N, from); i < end; i++) {
    const seq = sequenceFromShapes(sh, i, N);
    if (!seq) continue;
    const prevClose = bars[i - 1][4];
    const close = bars[i][4];
    if (!isKnown(prevClose) || !isKnown(close) || prevClose <= 0) continue;
    out.push({ i, seq, up: close > prevClose ? 1 : 0, movePct: ((close - prevClose) / prevClose) * 100 });
  }
  return out;
}

module.exports = {
  shape, shapesOf, classifyPattern, sequence, sequenceFromShapes, signature, signatureLevels, SIGNATURE_ORDER,
  learn, predict, baseline, observations, bucket, closePosBucket, gapBucket, runBucket,
  LOOKBACKS, num,
};
