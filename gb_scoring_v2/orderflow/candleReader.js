/**
 * gb_scoring_v2/orderflow/candleReader.js — PHASE 6: THE CANDLES, AS CONTEXT ONLY.
 *
 * The plan's rule is the important part, not the patterns: "Only consulted *when at_location is
 * True* — never a standalone trigger." A hammer in the middle of nowhere is not information; a
 * hammer on the value-area low after three bars of seller delta is. So this module classifies
 * honestly and returns `consulted: false` when it is being asked about a price that is not at a
 * level — the gate reads that flag rather than being trusted to remember the rule.
 *
 * PATTERNS, all on SEALED 1m bars (a forming bar can change shape after the decision is made):
 *   rejection  — a wick at least `WICK_FRAC` of the range on the side being tested, closing back
 *                inside. The classic exhaustion print at a level.
 *   engulfing  — the last bar's body swallows the previous bar's body, in the opposite direction.
 *   inside     — the last bar sits inside the previous bar's range: compression, no information.
 *   indecision — a body under `DOJI_FRAC` of the range: neither side won.
 *
 * The direction is always reported RELATIVE TO THE PRICE ACTION, never to the intended trade:
 * a rejection wick at the LOW is `dir: 'up'` (buyers rejected lower prices), and it is the gate's
 * job to decide whether an up-rejection at a level supports the trade it is considering.
 */
const WICK_FRAC = 0.5;      // wick must be at least half the bar's range
const DOJI_FRAC = 0.2;      // body under a fifth of the range is indecision
const MIN_BARS = 2;

function body(bar) { return bar && bar.o != null && bar.c != null ? Math.abs(bar.c - bar.o) : null; }
function rng(bar) { return bar && bar.h != null && bar.l != null ? (bar.h - bar.l) : null; }

/** wick(bar) — {up, down} wick lengths, computed from the body's own top/bottom. */
function wick(bar) {
  if (!bar || bar.h == null || bar.l == null || bar.o == null || bar.c == null) return null;
  const top = Math.max(bar.o, bar.c), bot = Math.min(bar.o, bar.c);
  return { up: bar.h - top, down: bot - bar.l };
}

/**
 * classify(bars, opts) — the last-five read.
 * `opts.atLocation` (bool) decides whether the patterns are CONSULTED, and `opts.side`
 * ('up'|'down') names the side the caller is testing so the rejection test looks at the right wick.
 */
function classify(bars, opts = {}) {
  const list = Array.isArray(bars) ? bars.filter(Boolean) : [];
  const atLocation = opts.atLocation === true;
  const side = opts.side === 'up' ? 'up' : opts.side === 'down' ? 'down' : null;
  const out = {
    consulted: false,
    atLocation,
    bars: list.length,
    pattern: null,
    dir: null,
    wickPct: null,
    bodyPct: null,
    note: null,
  };
  if (list.length < MIN_BARS) { out.note = 'fewer than ' + MIN_BARS + ' sealed candles'; return out; }

  const last = list[list.length - 1];
  const prev = list[list.length - 2];
  const r = rng(last), b = body(last), w = wick(last);
  out.wickPct = (r && r > 0 && w) ? +(Math.max(w.up, w.down) / r * 100).toFixed(1) : null;
  out.bodyPct = (r && r > 0 && b != null) ? +(b / r * 100).toFixed(1) : null;

  // pattern detection ALWAYS runs (so the layer's raw output is replayable); `consulted` is what
  // says whether the gate is allowed to read it.
  if (r && r > 0 && w) {
    const upWickFrac = w.up / r, downWickFrac = w.down / r;
    if (downWickFrac >= WICK_FRAC) { out.pattern = 'rejection-down'; out.dir = 'up'; out.note = 'lower prices rejected (down wick ' + (downWickFrac * 100).toFixed(0) + '% of range)'; }
    else if (upWickFrac >= WICK_FRAC) { out.pattern = 'rejection-up'; out.dir = 'down'; out.note = 'higher prices rejected (up wick ' + (upWickFrac * 100).toFixed(0) + '% of range)'; }
  }
  if (!out.pattern && b != null && r && r > 0) {
    if (b <= r * DOJI_FRAC) { out.pattern = 'indecision'; out.dir = null; out.note = 'body ' + (b / r * 100).toFixed(0) + '% of range — neither side won'; }
  }
  const pb = body(prev), pr = rng(prev);
  if (!out.pattern && pb != null && b != null && prev.o != null && last.o != null) {
    const prevTop = Math.max(prev.o, prev.c), prevBot = Math.min(prev.o, prev.c);
    const top = Math.max(last.o, last.c), bot = Math.min(last.o, last.c);
    if (prev.c < prev.o && last.c > last.o && top >= prevTop && bot <= prevBot) { out.pattern = 'engulfing-up'; out.dir = 'up'; out.note = 'bullish engulfing of the prior bar'; }
    else if (prev.c > prev.o && last.c < last.o && bot <= prevBot && top >= prevTop) { out.pattern = 'engulfing-down'; out.dir = 'down'; out.note = 'bearish engulfing of the prior bar'; }
  }
  if (!out.pattern && pr != null && r != null && prev.h != null && prev.l != null && last.h != null && last.l != null
      && last.h <= prev.h && last.l >= prev.l) {
    out.pattern = 'inside'; out.dir = null; out.note = 'inside bar — compression, no information';
  }
  if (!out.pattern) out.note = 'no pattern';

  // CONSULTED ONLY AT A LEVEL. Reported, so the gate has nothing to remember and the replay log
  // shows exactly when a candle was allowed to mean something.
  out.consulted = atLocation && out.pattern != null && out.pattern !== 'inside' && out.pattern !== 'indecision';
  out.supports = (!out.consulted || !side) ? null : (out.dir === side ? true : out.dir == null ? null : false);
  if (!atLocation) out.note = (out.note || 'no pattern') + ' · not consulted (price is not at a level)';
  return out;
}

module.exports = { classify, wick, body, rng, WICK_FRAC, DOJI_FRAC };
