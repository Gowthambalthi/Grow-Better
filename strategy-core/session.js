/**
 * strategy-core/session.js — the session state EVERY engine needs, once.
 *
 * WHY THIS EXISTS. All three engines were carrying the same forty lines: notice
 * the day changed, freeze yesterday's high/low as `prevDay`, start a fresh day
 * array, keep a rolling tail for the trailing indicators, track the day's
 * extremes, and build the opening range. Three copies of one piece of bookkeeping
 * is three places for it to drift, and it had already drifted into a bug: the
 * sweep engine indexed its day array with CORPUS positions, so its "untouched"
 * gate compared a session index against a global one and could never fire.
 * The bookkeeping now lives here, and each engine adds only what is genuinely its
 * own (the sweep's level set, the FVG engine's frames, nothing for order flow).
 *
 * It also owns the two measurements that used to be recomputed from scratch on
 * every bar. `vwap()` and `poc()` were O(bars-so-far-in-session) PER BAR, which
 * is what made the sweep engine quadratic in practice — the classic
 * `bars.slice(0, i+1)` was only the smaller half of that cost. Both are now
 * carried forward as the session grows, from the same routines
 * (`indicators.createVwap` / `indicators.createProfile`) that the one-shot
 * `vwap(bars)` / `poc(bars)` functions use, so live and replay cannot disagree.
 *
 * NOTHING HERE SEES THE FUTURE. `onBar(bar)` folds in one CLOSED bar; every
 * accessor answers about the bars folded in so far.
 */
'use strict';

const ind = require('./indicators');
const { T } = ind;

const TAIL_BARS = 25;             // covers atr(…,14), roc(…,5) and volumeRatio(…,20)

function createSession(opts) {
  const cfg = Object.assign({
    tailBars: TAIL_BARS,
    openingRangeMinutes: 15,
    bucketPct: 0.05,
    minSessionBars: 0,
  }, opts || {});

  let day = null;
  // { high, low, close, day } of the last COMPLETED session. `close` was added
  // for day-context questions ("was yesterday up?"), which cannot be answered
  // from high/low: a stock can close up while never printing a new high. It is
  // additive — every existing reader takes only high/low.
  let prevDay = null;
  let prevPrevDay = null;         // the same shape, two sessions back
  let bars = [];                  // this session's bars, in order
  const tail = [];                // rolling last N bars, spanning sessions on purpose
  let high = null, low = null;
  let openingRange = null;
  const vwapTracker = ind.createVwap();
  const profile = ind.createProfile(cfg.bucketPct);

  function openSession(d) {
    day = d;
    bars = [];
    high = null; low = null;
    openingRange = null;
    vwapTracker.reset();
    profile.reset(null);
  }

  /**
   * Fold one closed bar in. Returns true when that bar OPENED a new session —
   * the engines that keep their own per-day state clear it on that signal.
   */
  function onBar(bar) {
    if (!bar) return false;
    const d = ind.dayOf(bar);
    let newDay = false;
    if (d !== day) {
      if (day !== null) {
        const finished = (!cfg.minSessionBars || bars.length >= cfg.minSessionBars)
          ? { high, low, close: bars.length ? bars[bars.length - 1][T.CLOSE] : null, day }
          : null;
        // Shift BEFORE assigning: two days back is what yesterday's move is
        // measured against, and after this line prevDay is the day that just
        // ended. Both are cleared together so a too-short session never leaves
        // a stale pair that would read as a real two-day comparison.
        prevPrevDay = finished ? prevDay : null;
        prevDay = finished;
      }
      openSession(d);
      newDay = true;
    }

    bars.push(bar);
    high = high == null ? bar[T.HIGH] : Math.max(high, bar[T.HIGH]);
    low = low == null ? bar[T.LOW] : Math.min(low, bar[T.LOW]);

    tail.push(bar);
    if (tail.length > cfg.tailBars) tail.shift();

    // The profile's price grid is anchored to the session's FIRST close, so it
    // does not move under the volume it is measuring. See indicators.poc().
    if (bars.length === 1) profile.reset(bar[T.CLOSE]);
    profile.add(bar);
    vwapTracker.add(bar);

    if (!openingRange && bars.length >= cfg.openingRangeMinutes) {
      let hi = -Infinity, lo = Infinity;
      for (let i = 0; i < cfg.openingRangeMinutes; i++) {
        if (bars[i][T.HIGH] > hi) hi = bars[i][T.HIGH];
        if (bars[i][T.LOW] < lo) lo = bars[i][T.LOW];
      }
      openingRange = { high: hi, low: lo };
    }
    return newDay;
  }

  /**
   * Seed the two sessions BEFORE this one from their CLOSES ALONE.
   *
   * WHY THIS EXISTS. On the live tape each session starts a FRESH engine fed only
   * today's bars, so `prevDay` is always null and any question about yesterday
   * ("was it up?") is unanswerable — permanently, not just before 09:30. The
   * adapter remembers the last two observed session closes and hands them here.
   *
   * high/low are null on a seeded day, deliberately: a close is known and a
   * range is not, and inventing a range would make `prevDayHigh` a level that
   * never printed. Every reader already treats a null as "not available".
   * Anything unparseable or non-positive is dropped rather than seeded as 0,
   * because a zero close would produce an infinite move.
   */
  function seedPriorCloses(closes) {
    const list = (Array.isArray(closes) ? closes : [])
      .map(Number)
      .filter((c) => isFinite(c) && c > 0)
      .slice(-2);
    prevPrevDay = list.length >= 2 ? { high: null, low: null, close: list[0], day: null } : null;
    prevDay = list.length >= 1 ? { high: null, low: null, close: list[list.length - 1], day: null } : null;
  }

  return {
    onBar,
    seedPriorCloses,
    get day() { return day; },
    get prevDay() { return prevDay; },
    get prevPrevDay() { return prevPrevDay; },
    /**
     * Today's first open — the reference the day's move is measured from.
     * Null before the first bar, never a guess: substituting `entry` here would
     * report every stock as exactly 0.00% on the day.
     */
    get dayOpen() { return bars.length ? bars[0][T.OPEN] : null; },
    /** This session's bars so far — a day array, i.e. indexed from 0 each day. */
    get bars() { return bars; },
    get dayHigh() { return high; },
    get dayLow() { return low; },
    /** The rolling tail the trailing indicators read. Spans sessions, as ATR should. */
    get tail() { return tail; },
    get openingRange() { return openingRange; },
    vwap: () => vwapTracker.value(),
    poc: () => profile.value(),
    /** How many bars of THIS session have closed. */
    get dayLength() { return bars.length; },
  };
}

module.exports = { createSession, TAIL_BARS };
