/**
 * gb_scoring_v2/orderflow/momentumEngine.js — PHASE 4: MOMENTUM, WITH THE LADDER COLLAPSED.
 *
 * The plan is explicit about the ridge that got us here: "ROC(20s) as the single fast
 * confirmation (drop the 10s/15s/30s/40s — redundant, this was the overfitting problem)". Five
 * correlated fast windows each had their own threshold, and five thresholds is five chances to
 * find a rule that only works on the data you tuned it on. So:
 *
 *   FAST   — ONE number: ROC(20s), computed from the 10-SECOND SAMPLE GRID (two buckets back, so
 *            every pair of points is exactly 20 seconds apart). It is a confirmation, never a
 *            trigger: it says the tape is turning, the location layer says it matters.
 *   SLOW   — ROC(5m) and ROC(15m), each z-scored against its OWN rolling 50-bar distribution.
 *            A fixed "0.5% is a big move" threshold is a different statement in a 1.5%-ATR name
 *            and a 6%-ATR name; `|z| >= 1.5` asks the only question that travels between names:
 *            is this move large FOR THIS SYMBOL, relative to its own recent behaviour?
 *
 * WHY THE Z-SCORE NEEDS A WINDOW THAT EXISTS. A 50-bar window over 1m bars is 50 minutes of the
 * session. Before that exists, z is null and `huge_move` is null — reported as `warmup`, never
 * guessed from 6 bars, because a z-score off a short window is a number with no meaning that
 * still looks like one. `closesFromMinuteBars` counts only bars inside the session.
 *
 * DECELERATION IS A WARNING, NOT A CONFIRMATION (the plan says so in as many words). A move whose
 * ROC is shrinking bar-on-bar while price is still extending is the shape that precedes the turn
 * — which is useful for the gate's reversal logic and dangerous as an entry reason.
 */
const FRESH = require('../../common/market/tickBoard');

const Z_HUGE = 1.5;             // the plan's threshold for "huge", in standard deviations
const Z_WINDOW = 50;            // rolling bars the z-score is measured against
const MIN_WINDOW = 20;          // below this the z-score is not reported at all
const GRID_SLACK_MS = 12500;    // one 10s bucket of slack on a grid anchor, as in tickBoard

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function sd(a) {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}

/** closes(rows) — {t, c} or bare numbers into a plain close series, oldest first. */
function closes(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => (typeof r === 'number' ? r : r && r.c)).filter((v) => v > 0);
}

/**
 * rocZ(closesArr, backBars, window) — the current ROC over `backBars` and its z-score against
 * the last `window` such readings. Returns samples 0 when the series cannot support the window.
 */
function rocZ(closesArr, backBars, window = Z_WINDOW) {
  const cs = closesArr;
  if (!Array.isArray(cs) || cs.length < backBars + MIN_WINDOW + 1) {
    return { roc: null, z: null, samples: 0, enough: false };
  }
  const series = [];
  for (let i = backBars; i < cs.length; i++) {
    const prev = cs[i - backBars];
    if (prev > 0) series.push(((cs[i] - prev) / prev) * 100);
  }
  if (series.length < MIN_WINDOW) return { roc: null, z: null, samples: series.length, enough: false };
  const win = series.slice(-window);
  const cur = win[win.length - 1];
  const mean = avg(win);
  const s = sd(win);
  return {
    roc: +cur.toFixed(3),
    z: s > 0 ? +((cur - mean) / s).toFixed(2) : null,
    mean: +mean.toFixed(3),
    sd: s == null ? null : +s.toFixed(3),
    samples: win.length,
    enough: win.length >= MIN_WINDOW,
    tail: win.slice(-3).map((v) => +v.toFixed(3)),
    // the move is still extending: the newest close is beyond the one before it in the same
    // direction as the ROC. Needed to tell "decelerating while rising" from "already turned".
    extending: cs.length >= 2 && cs[cs.length - 1] !== cs[cs.length - 2]
      ? Math.sign(cs[cs.length - 1] - cs[cs.length - 2]) : 0,
  };
}

/** Deceleration: the ROC shrinking three readings running while price still extends. */
function deceleration(z5) {
  const t = z5 && Array.isArray(z5.tail) ? z5.tail : null;
  if (!t || t.length < 3) return { decel: false, note: null };
  const [a, b, c] = t;
  if (z5.extending > 0 && c < b && b < a) return { decel: true, note: 'up-move losing pace (' + a + ' → ' + b + ' → ' + c + ')' };
  if (z5.extending < 0 && c > b && b > a) return { decel: true, note: 'down-move losing pace (' + a + ' → ' + b + ' → ' + c + ')' };
  return { decel: false, note: null };
}

// ---------- THE FAST FRAME, FROM THE 10-SECOND GRID ----------
/** ROC over `ms` ending at grid sample i (pct). null when the grid does not reach that far. */
function rocAtPoint(samples, i, ms) {
  if (!Array.isArray(samples) || i < 0 || i >= samples.length) return null;
  const pt = samples[i];
  const target = pt.t - ms;
  for (let j = i; j >= 0; j--) {
    if (samples[j].t <= target) return (target - samples[j].t > GRID_SLACK_MS) ? null : +(((pt.p - samples[j].p) / samples[j].p) * 100).toFixed(3);
  }
  return null;
}

/**
 * fastFrame(samples) — the collapsed fast read: ROC(20s) now, one bucket ago and two ago.
 * `turningUp` / `turningDown` require TWO rising (falling) readings, which is the plan's "ROC(20s)
 * turning up, 2+ bars" — one reading is a print, two is a direction.
 */
function fastFrame(samples) {
  if (!Array.isArray(samples) || samples.length < 4) return { roc20: null, turningUp: false, turningDown: false, samples: samples ? samples.length : 0 };
  const i = samples.length - 1;
  const r0 = rocAtPoint(samples, i, 20000);
  const r1 = rocAtPoint(samples, i - 1, 20000);
  const r2 = rocAtPoint(samples, i - 2, 20000);
  const have = [r0, r1, r2].filter((v) => v != null).length >= 2;
  return {
    roc20: r0,
    prev: r1,
    prev2: r2,
    series: [r2, r1, r0],
    turningUp: have && r0 != null && r1 != null && r0 > r1 && (r2 == null || r1 >= r2),
    turningDown: have && r0 != null && r1 != null && r0 < r1 && (r2 == null || r1 <= r2),
    samples: samples.length,
  };
}

/**
 * measure(token, opts) — the whole layer for one symbol: slow z-scores from its 1m closes plus the
 * fast grid frame. `opts.closes` lets a test/backtest inject the series instead of the live board.
 *
 * WHICH 1m SERIES. Two exist and they are not interchangeable:
 *   - the engine's OWN sealed bars (`opts.ownBars`, from the footprint), the exact minutes whose
 *     volume and delta the gate already judged; and
 *   - the tick board's minute bars, which are seeded from Yahoo and therefore reach back further
 *     than this process has been alive (that seeding is what makes a restart's first 20 minutes
 *     scoreable at all).
 * The LONGER of the two wins, and `closesSrc` says which was used. Preferring "own" always would
 * throw away the seeded history on every restart; preferring the board always would score the
 * z as a different series than the delta row beside it.
 */
function measure(token, opts = {}) {
  const own = closes(opts.ownBars || []);
  const histRows = opts.closes || (opts.minuteBars && opts.minuteBars.get(String(token))) || FRESH.minuteBars.get(String(token)) || [];
  const hist = closes(histRows);
  const useOwn = own.length >= hist.length;
  const cs = useOwn ? own : hist;
  const z5 = rocZ(cs, 5);
  const z15 = rocZ(cs, 15);
  const dec = deceleration(z5);
  const samples = opts.samples || FRESH.series10.get(String(token)) || [];
  const fast = fastFrame(samples);

  const huge5 = z5.z != null && Math.abs(z5.z) >= Z_HUGE;
  const huge15 = z15.z != null && Math.abs(z15.z) >= Z_HUGE;
  const dir5 = huge5 ? (z5.roc > 0 ? 'up' : 'down') : null;
  const dir15 = huge15 ? (z15.roc > 0 ? 'up' : 'down') : null;
  let dir = null;
  if (dir5 && dir15) dir = dir5 === dir15 ? dir5 : null;      // two frames disagreeing is not a huge move
  else dir = dir5 || dir15;
  const conflict = !!(dir5 && dir15 && dir5 !== dir15);

  return {
    roc5m: z5.roc, z5m: z5.z, samples5: z5.samples, huge5m: huge5,
    roc15m: z15.roc, z15m: z15.z, samples15: z15.samples, huge15m: huge15,
    huge: huge5 || huge15,
    dir,
    conflict,
    decel: dec.decel,
    decelNote: dec.note,
    fast,
    bars: cs.length,
    closesSrc: cs.length ? (useOwn ? 'orderflow-bars' : 'tickboard-minute-bars') : null,
    warmup: z5.samples === 0 ? 'no 1m history' : (z5.samples < MIN_WINDOW ? 'window still filling (' + z5.samples + '/' + MIN_WINDOW + ')' : null),
    threshold: Z_HUGE,
    window: Z_WINDOW,
  };
}

module.exports = { measure, rocZ, fastFrame, rocAtPoint, deceleration, closes, Z_HUGE, Z_WINDOW, MIN_WINDOW };
