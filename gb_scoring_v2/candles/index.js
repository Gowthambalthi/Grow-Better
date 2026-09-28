/**
 * gb_scoring_v2/candles/index.js — CANDLE CONTEXT: PATTERNS AND THE GAP BETWEEN CANDLES.
 *
 * WHY THIS FILE EXISTS. GB already computes candle structure and the opening gap on
 * every deep row, and until now the V3 adapter discarded all of it at the boundary --
 * a measured `grep -c candlePattern` over the recorded session returned 0. Free,
 * already-computed evidence was being thrown away before it could be recorded, so it
 * could never be backtested. This module stops that, tags it, and reports coverage.
 *
 * WHAT THE SPEC SAYS ABOUT IT, HONESTLY:
 *   * Section 17 lists Candle context as "Display-only in v1 ... 0 (display-only in
 *     v1)". It contributes no points by default.
 *   * Section 26 defers it: "Weak standalone edge. Re-entry condition: Scored only at
 *     meaningful levels with confirming flow, small weight."
 *   * Section 4 / Appendix A REMOVE micro-gap logic: "On continuous time bars the
 *     open is almost the previous close; the gap is mostly one tick or bid-ask
 *     bounce." Its re-entry condition (Section 26) is "only if tick-level evidence
 *     shows it carries information beyond range/volume expansion."
 *
 * So this module does NOT quietly give candle evidence points. It:
 *   1. surfaces the fields, with provenance, so they are RECORDED and replayable;
 *   2. computes one bounded value per sub-question under a documented, simple rule;
 *   3. marks that value `scored: false` unless the config is explicitly flipped;
 *   4. names exactly what it could NOT compute, rather than approximating it.
 * Section 21.6 is the arbiter: this component is added to the frozen baseline and
 * kept only if it improves out-of-sample separation.
 *
 * THE HONEST GAP IN THE DATA. GB's row carries the gap as a DERIVED summary
 * (open %, fill %, size vs ATR, distance to the nearest unfilled gap). It does NOT
 * carry OHLC for the last N candles, so body/wick geometry -- real "candle pattern"
 * shape -- cannot be computed here; only GB's own `candlePattern` label can be read.
 * That limit is reported, not papered over with an invented candle.
 */
const { CONFIG } = require('./../config/index');
const { isKnown } = require('./../adapter/provenance');
const sequence = require('./sequence');

const bounded = (v) => (v == null ? null : Math.max(-1, Math.min(1, v)));
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (isKnown(v) && typeof v === 'number' ? v : null);

/**
 * GB's candle-pattern labels -> a directional lean in [-1, +1].
 * A pattern is evidence about the LAST candle's shape, not about the trade: DOJI and
 * NONE are explicitly 0 because indecision is not a direction. SHORT trades mirror
 * the sign downstream (see directionAlign), never here.
 */
const PATTERN_LEAN = {
  'BULL ENGULF': 1, 'BEAR ENGULF': -1,
  'HAMMER': 0.6, 'SHOOTING STAR': -0.6,
  'BULL MARUBOZU': 1, 'BEAR MARUBOZU': -1,
  'MORNING STAR': 1, 'EVENING STAR': -1,
  'DOJI': 0, 'NONE': 0, 'INSIDE BAR': 0, 'OUTSIDE BAR': 0,
};
/** GB's trend words -> sign. Shared shape with the adapter's DIRECTION_WORDS. */
const TREND_SIGN = { 'UP': 1, 'UP-LEAN': 0.5, 'DOWN': -1, 'DOWN-LEAN': -0.5, 'MIXED': 0, 'FLAT': 0, 'NEUTRAL': 0 };

const trendSign = (w) => {
  if (!isKnown(w)) return null;
  const v = TREND_SIGN[String(w).toUpperCase()];
  return v === undefined ? null : v;
};

// ---------------------------------------------------------------------------
// GAP STATE — "the gap between candles" in the only form GB provides it.
//
// GB's `gap` block describes the OPENING gap: open vs the previous session's close,
// how much of it has since been filled, and how far the nearest UNFILLED gap sits.
// Three states, because they mean different things and collapsing them would hide
// the one the spec warns about (a filled gap is not a gap any more):
//   FILLED    fillPct >= 100 -- the gap edge is gone; it is a level, not an edge.
//   PARTIAL   0 < fillPct < 100 -- still open, but already contested.
//   UNFILLED  fillPct <= 0 -- untouched.
// ---------------------------------------------------------------------------
function gapState(snapshot) {
  const c = (snapshot && snapshot.candles) || {};
  const openPct = num(c.gapOpenPct);
  const fillPct = num(c.gapFillPct);
  const sizeVsAtrX = num(c.gapSizeVsAtrX);
  const nearestUpPct = num(c.gapNearestUpPct);
  const nearestDownPct = num(c.gapNearestDownPct);
  const dir = isKnown(c.gapOpenDir) ? c.gapOpenDir : (openPct == null ? null : (openPct > 0 ? 'UP' : 'DOWN'));
  let state = null;
  if (fillPct != null) state = fillPct >= 100 ? 'FILLED' : (fillPct <= 0 ? 'UNFILLED' : 'PARTIAL');
  const missing = [];
  if (openPct == null) missing.push('candles.gapOpenPct');
  if (fillPct == null) missing.push('candles.gapFillPct');
  if (sizeVsAtrX == null) missing.push('candles.gapSizeVsAtrX');
  return {
    openPct, dir, fillPct, state, sizeVsAtrX,
    nearestUpPct, nearestDownPct,
    text: isKnown(c.gapText) ? c.gapText : null,
    // The open gap has no meaning against a missing previous close; that is stated.
    why: openPct == null ? 'no opening-gap figure on the row' : (state ? 'gap ' + state.toLowerCase() + ', ' + openPct + '%' : 'gap size known, fill state unknown'),
    missing,
  };
}

/**
 * gapEvidence(snapshot, opts) -> bounded [-1, +1] in RAW terms (positive = the gap
 * favours the upside), plus the sub-values it was built from.
 *
 * THE RULE, STATED SO IT CAN BE ARGUED WITH: an unfilled gap in the gap's own
 * direction is continuation evidence; the more of the gap that has been filled, the
 * less of it remains, and the value is damped by the unfilled share. Size is scaled
 * against ATR (sizeVsAtrX / gapFullAtrX), because a 0.2% gap in a 5% ATR stock is
 * noise while the same gap in a 1.5% ATR stock is an event -- the same argument the
 * spec makes for volatility-normalized ROC in Section 9.1.
 *
 * A PROXIMITY RISK IS NOT A DIRECTION. An unfilled gap sitting 0.4% ahead of the
 * trade is a magnet that price often trades into; that is reported as a risk and used
 * to damp the value, never as evidence FOR the trade.
 */
function gapEvidence(snapshot, opts = {}) {
  const g = gapState(snapshot);
  const cfg = (CONFIG.candles && CONFIG.candles.gap) || {};
  const fullAtrX = isKnown(cfg.fullAtrX) ? cfg.fullAtrX : 0.5;
  const sizeSign = g.dir === 'UP' ? 1 : g.dir === 'DOWN' ? -1 : 0;
  const sizeRead = g.sizeVsAtrX == null ? null : clip(g.sizeVsAtrX / fullAtrX, -1, 1);
  const unfilledShare = g.fillPct == null ? null : clip(1 - g.fillPct / 100, 0, 1);
  const proximityPct = isKnown(cfg.proximityPct) ? cfg.proximityPct : 0.4;

  const obstacles = [];
  if (g.nearestUpPct != null && g.nearestUpPct <= proximityPct) obstacles.push({ side: 'up', pct: g.nearestUpPct });
  if (g.nearestDownPct != null && g.nearestDownPct <= proximityPct) obstacles.push({ side: 'down', pct: g.nearestDownPct });

  let value = null, why = g.why;
  if (g.openPct != null && sizeSign !== 0 && sizeRead != null && unfilledShare != null) {
    value = bounded(sizeSign * Math.abs(sizeRead) * unfilledShare);
    why = 'gap ' + g.dir + ' ' + g.sizeVsAtrX + 'x ATR, ' + (g.state || 'state unknown').toLowerCase()
      + ' (' + (100 * unfilledShare).toFixed(0) + '% of it still open)';
  } else if (g.openPct != null) {
    why = 'gap present but not scorable: ' + (sizeRead == null ? 'size vs ATR unknown' : 'fill state unknown');
  }
  return {
    value, raw: value, parts: {
      openPct: g.openPct, dir: g.dir, state: g.state, sizeVsAtrX: g.sizeVsAtrX,
      sizeRead, unfilledShare, obstacles,
    },
    obstacles, why, missing: g.missing,
  };
}

/**
 * patternEvidence(snapshot) -> bounded [-1, +1] in RAW terms, from GB's own candle
 * label and its multi-timeframe candle trend. Agreement is required the same way it
 * is required in the momentum groups: one bullish 1m candle inside a bearish 15m
 * structure is not a bullish pattern, it is a bullish candle.
 */
function patternEvidence(snapshot) {
  const c = (snapshot && snapshot.candles) || {};
  const pattern = isKnown(c.pattern) ? String(c.pattern).toUpperCase() : null;
  const lean = pattern == null ? null : (PATTERN_LEAN[pattern] !== undefined ? PATTERN_LEAN[pattern] : null);
  const tc = c.trendCounts || {};
  const signs = ['m1', 'm2', 'm3', 'm5', 'm15', 'm30'].map((k) => trendSign(tc[k])).filter((v) => v != null);
  const agree = isKnown(c.trendAgree) ? String(c.trendAgree).toUpperCase() : null;

  const missing = [];
  if (pattern == null) missing.push('candles.pattern');
  if (!signs.length) missing.push('candles.trendCounts');
  if (!isKnown(agree)) missing.push('candles.trendAgree');

  // Trend agreement = mean sign damped by how unanimous the six timeframes were.
  let trendValue = null, trendAgreement = null;
  if (signs.length) {
    const sum = signs.reduce((a, b) => a + b, 0);
    const absSum = signs.reduce((a, b) => a + Math.abs(b), 0);
    trendAgreement = absSum > 0 ? +Math.abs(sum / absSum).toFixed(3) : 0;
    trendValue = bounded((sum / signs.length) * trendAgreement);
  }

  const parts = { pattern, patternLean: lean, trendValue, trendAgreement, timeframes: signs.length, agree };
  // One value from two correlated readings: the label and the multi-timeframe trend.
  // They are averaged only when both exist; a single reading is not up-weighted.
  const available = [lean, trendValue].filter((v) => v != null);
  const value = available.length ? bounded(available.reduce((a, b) => a + b, 0) / available.length) : null;
  return {
    value, raw: value, parts, missing,
    why: value == null ? 'no usable candle label or candle trend on the row'
      : 'pattern ' + (pattern || 'n/a') + (trendValue == null ? '' : ' with ' + (100 * (trendAgreement || 0)).toFixed(0) + '% timeframe agreement'),
  };
}

/**
 * candleEvidence(snapshot, opts) -> the full candle-context block.
 *
 * `scored` is read from config and defaults FALSE: the spec makes candle context
 * display-only in v1, and a module that silently scored it would violate Section 17
 * and change the 58-point denominator behind the user's back.
 *
 * `notRunnable` names the sub-features this feed cannot compute at all, so a later
 * reader cannot mistake their absence for "the candles looked neutral".
 */
function candleEvidence(snapshot, opts = {}) {
  const dir = opts.direction === 'LONG' ? 1 : opts.direction === 'SHORT' ? -1 : null;
  const gap = gapEvidence(snapshot, opts);
  const pattern = patternEvidence(snapshot);
  const cfg = (CONFIG.candles) || {};

  const rawParts = [gap.value, pattern.value].filter((v) => v != null);
  const raw = rawParts.length ? bounded(rawParts.reduce((a, b) => a + b, 0) / rawParts.length) : null;
  // Direction alignment happens ONCE, here: a component inside a group is never
  // pre-aligned, or a SHORT would end up with a flipped gap AND a flipped pattern.
  const value = raw == null ? null : (dir == null ? raw : bounded(raw * dir));

  const missing = [...new Set([...gap.missing, ...pattern.missing])];
  const obstacles = gap.obstacles.slice();
  // A gap magnet sitting directly against the trade is a risk worth naming even
  // before exhaustion exists: it is where the move tends to stall.
  const against = dir == null ? [] : obstacles.filter((o) => (dir === 1 ? o.side === 'up' : o.side === 'down'));

  return {
    value, raw, direction: opts.direction || null,
    scored: !!cfg.scored,
    points: cfg.scored ? (cfg.points || 0) : 0,
    gap, pattern,
    obstacles, obstaclesAgainstTrade: against,
    missing,
    // Coverage of THIS component, so a later report can say how often it was legible.
    legible: raw != null,
    notRunnable: [
      'candle body/wick geometry — GB carries no OHLC on the row, only its own label',
      'true 1m candle-by-candle gap series — GB carries the opening gap, not each bar-to-bar gap',
    ],
    displayOnlyNote: cfg.scored
      ? 'SCORED: config.candles.scored is true, so this is counted in the score. Spec 17 makes this display-only in v1 — flip it back unless a Section 21.6 run earned it.'
      : 'DISPLAY-ONLY (spec 17): reported and recorded, contributing 0 points',
    text: 'gap ' + (gap.raw == null ? 'n/a' : (gap.raw > 0 ? '+' : '') + gap.raw.toFixed(2)) + ' (' + (gap.parts.state || 'state?') + ')'
      + ' · pattern ' + (pattern.parts.pattern || 'n/a')
      + (value == null ? ' · no candle value' : ' · aligned ' + (value > 0 ? '+' : '') + value.toFixed(2)),
  };
}

/** The fields this module reads, for the feed-verification and coverage reports. */
const CANDLE_FIELDS = [
  'candles.gapOpenPct', 'candles.gapOpenDir', 'candles.gapFillPct', 'candles.gapSizeVsAtrX',
  'candles.gapNearestUpPct', 'candles.gapNearestDownPct', 'candles.gapText',
  'candles.pattern', 'candles.trendCounts', 'candles.trendAgree',
];

/**
 * sequenceEvidence(bars, opts) -> the REAL-OHLC candle read, when a caller has bars.
 *
 * WHY THIS IS SEPARATE FROM candleEvidence(). The snapshot-level function above can
 * only read the fields GB puts on its row, and GB's row carries ONE derived label.
 * This one takes an actual bar series (1-minute bars live, 15-minute bars in the
 * study) and returns the formation of the last N candles plus a measured next-candle
 * read. Keeping them apart is deliberate: the adapter stays a pure function of the
 * GB row, and the bar-based read is available wherever the caller genuinely holds
 * bars, instead of being faked from a label.
 *
 * `model` is required for the prediction and comes from candles/sequence.learn().
 * Without one, the formation is still returned and the prediction is marked
 * not-runnable -- refusing beats inventing a probability.
 */
function sequenceEvidence(bars, opts = {}) {
  const N = opts.lookback != null ? opts.lookback : 12;
  if (!Array.isArray(bars) || bars.length < N + 1) {
    return {
      formation: null, prediction: null, lookback: N, bars: Array.isArray(bars) ? bars.length : 0,
      notRunnable: ['needs at least ' + (N + 1) + ' bars; got ' + (Array.isArray(bars) ? bars.length : 0)],
      scored: false, points: 0,
    };
  }
  const shapes = sequence.shapesOf(bars);
  const formation = sequence.sequenceFromShapes(shapes, bars.length, N);
  const prediction = opts.model ? sequence.predict(opts.model, formation, opts) : null;
  return {
    formation, prediction, lookback: N, bars: bars.length,
    // Still display-only: this read was measured at ~59% on 15m next-bar direction
    // against a 54% majority baseline, which is an edge worth tracking and nothing
    // like a signal. Spec 17 keeps it at 0 points until a Section 21.6 run on the
    // PRODUCTION timeframe says otherwise.
    scored: !!CONFIG.candles.scored,
    points: CONFIG.candles.scored ? (CONFIG.candles.points || 0) : 0,
    notRunnable: opts.model ? [] : ['no next-candle model supplied — the formation is measured history, not a forecast'],
  };
}

/** The bar-to-bar gap between the last two candles, straight from the bars. */
function lastBarGap(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const s = sequence.shape(bars[bars.length - 1], bars[bars.length - 2]);
  return s ? s.gapPct : null;
}

module.exports = {
  candleEvidence, gapState, gapEvidence, patternEvidence, sequenceEvidence, lastBarGap,
  PATTERN_LEAN, TREND_SIGN, CANDLE_FIELDS, bounded, trendSign,
};
