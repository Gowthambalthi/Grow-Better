/**
 * strategy-core/indicators.js — the measurements, and nothing else.
 *
 * Pure functions over CLOSED bars. No state, no I/O, no time source: the same
 * input always gives the same output, which is what lets live and backtest
 * share one implementation and be trusted to agree.
 *
 * Every function takes a bar array shaped [time, open, high, low, close, volume]
 * (the vendor's order, unchanged) and never looks past the last element.
 */
'use strict';

const T = { TIME: 0, OPEN: 1, HIGH: 2, LOW: 3, CLOSE: 4, VOLUME: 5 };

/** True range of one bar, against the previous close. */
function trueRange(bar, prevClose) {
  const high = bar[T.HIGH], low = bar[T.LOW];
  if (prevClose == null) return high - low;
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * ATR over `period` closed bars, ending at the last bar given.
 * Returns null when there is not enough history — never a guess, never 0.
 */
function atr(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  let sum = 0;
  const start = bars.length - period;
  for (let i = start; i < bars.length; i++) {
    sum += trueRange(bars[i], bars[i - 1][T.CLOSE]);
  }
  return sum / period;
}

/** Percentage move from `bars[n]` back to the last close. Null if too short. */
function roc(bars, n) {
  if (!Array.isArray(bars) || bars.length <= n) return null;
  const then = bars[bars.length - 1 - n][T.CLOSE];
  const now = bars[bars.length - 1][T.CLOSE];
  if (!then) return null;
  return ((now / then) - 1) * 100;
}

/**
 * Session VWAP from the bars given, using typical price weighted by volume.
 * Returns null when no volume has traded — a VWAP of 0 is a lie, not a level.
 */
function vwap(bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  let pv = 0, vol = 0;
  for (const b of bars) {
    const typical = (b[T.HIGH] + b[T.LOW] + b[T.CLOSE]) / 3;
    pv += typical * b[T.VOLUME];
    vol += b[T.VOLUME];
  }
  if (!vol) return null;
  return pv / vol;
}

/**
 * Volume-at-price: the price bucket that traded the most volume this session.
 * `bucketPct` is the bucket width as a percentage of price (0.05% here). This is
 * the approximation the spec asks for — an honest bucket histogram, not a
 * claimed true profile.
 *
 * THE GRID IS ANCHORED TO THE SESSION'S FIRST BAR, AND THAT IS A FIX.
 * The width used to be taken from the LAST bar's close (`last * bucketPct/100`),
 * which meant the whole price grid MOVED every time the latest tick moved: the
 * same volume landed in different buckets from one bar to the next, so the POC
 * jittered for a reason that had nothing to do with where volume actually
 * traded — and no incremental form of it existed, which forced a full-session
 * histogram to be rebuilt on every single bar. That rebuild was the real cost of
 * the sweep engine (the O(n²) `bars.slice` that was cut first turned out to be
 * the smaller half of it). Anchoring the grid to a price that does not move makes
 * POC a stable level AND makes it streamable, so `createProfile()` can serve the
 * live loop and this one-shot function can serve a replay, from ONE bucket
 * routine, and be relied on to agree.
 */
function profileWidth(anchorPrice, bucketPct) {
  return Math.max(anchorPrice * (bucketPct / 100), 0.01);
}

/** Spread one bar's volume across the price buckets it actually traded through. */
function profileAdd(book, bar, width) {
  const lo = Math.floor(bar[T.LOW] / width);
  const hi = Math.floor(bar[T.HIGH] / width);
  const span = Math.max(hi - lo + 1, 1);
  const per = bar[T.VOLUME] / span;
  for (let k = lo; k <= hi; k++) {
    const key = k * width;
    const e = book.get(key);
    if (e) e.vol += per;
    else book.set(key, { vol: per, seq: book.size });
  }
}

/** The bucket that traded the most, ties going to the first one created. */
function profileTop(book, width) {
  let bestKey = null, bestVol = -1;
  for (const [price, e] of book) if (e.vol > bestVol) { bestVol = e.vol; bestKey = price; }
  return bestKey == null ? null : bestKey + width / 2;
}

function poc(bars, bucketPct = 0.05, anchorPrice) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const anchor = anchorPrice != null ? anchorPrice : bars[0][T.CLOSE];
  if (!anchor) return null;
  const width = profileWidth(anchor, bucketPct);
  const book = new Map();
  for (const b of bars) profileAdd(book, b, width);
  return profileTop(book, width);
}

/**
 * A streaming POC over one session. `reset(anchorPrice)` starts a new session's
 * profile; `add(bar)` folds one closed bar in; `value()` is the current POC.
 * The best bucket is carried, not rescanned, so a bar costs the handful of
 * buckets it touched rather than the whole session.
 */
function createProfile(bucketPct = 0.05) {
  let width = null, book = null, bestKey = null, bestVol = -1, bestSeq = -1;
  return {
    reset(anchorPrice) {
      if (!anchorPrice) { width = null; return; }
      width = profileWidth(anchorPrice, bucketPct);
      book = new Map();
      bestKey = null; bestVol = -1; bestSeq = -1;
    },
    add(bar) {
      if (width == null || !bar) return;
      const lo = Math.floor(bar[T.LOW] / width);
      const hi = Math.floor(bar[T.HIGH] / width);
      const span = Math.max(hi - lo + 1, 1);
      const per = bar[T.VOLUME] / span;
      for (let k = lo; k <= hi; k++) {
        const key = k * width;
        let e = book.get(key);
        if (!e) { e = { vol: 0, seq: book.size }; book.set(key, e); }
        e.vol += per;
        // strictly greater wins; an exact tie goes to the bucket created FIRST,
        // which is the same tie-break the one-shot `poc()` gets from Map order.
        if (e.vol > bestVol || (e.vol === bestVol && e.seq < bestSeq)) {
          bestVol = e.vol; bestKey = key; bestSeq = e.seq;
        }
      }
    },
    value() { return bestKey == null ? null : bestKey + width / 2; },
  };
}

/**
 * A streaming VWAP over one session: running Σ(typical × volume) ÷ Σ(volume).
 * Arithmetic on two accumulators, so it is exactly the same number the one-shot
 * `vwap()` returns over the same bars, at O(1) a bar instead of O(session).
 */
function createVwap() {
  let pv = 0, vol = 0;
  return {
    reset() { pv = 0; vol = 0; },
    add(bar) {
      if (!bar) return;
      pv += ((bar[T.HIGH] + bar[T.LOW] + bar[T.CLOSE]) / 3) * bar[T.VOLUME];
      vol += bar[T.VOLUME];
    },
    value() { return vol ? pv / vol : null; },
  };
}

/** Volume of the last bar against the average of the `lookback` before it. */
function volumeRatio(bars, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback + 1) return null;
  let sum = 0;
  for (let i = bars.length - 1 - lookback; i < bars.length - 1; i++) sum += bars[i][T.VOLUME];
  const avg = sum / lookback;
  if (!avg) return null;
  return bars[bars.length - 1][T.VOLUME] / avg;
}

/**
 * Aggregate 1-minute bars into N-minute bars, on the clock (09:15, 09:20, …),
 * so a 5m bar is never a rolling window that a live feed could not produce.
 * Only COMPLETE buckets are returned, plus a flag for the last partial one.
 */
function aggregate(bars, minutes) {
  const out = [];
  let bucketKey = null, cur = null, partial = null;
  for (const b of bars) {
    const key = bucketOf(b[T.TIME], minutes);
    if (key !== bucketKey) {
      // FOLD, DON'T LEAK. This used to push `cur` — the raw
      // `{ start, bars: [...] }` bucket — for every completed bucket, and only
      // ever folded the LAST one. So `aggregate()` returned a mixed array of
      // bucket objects and one real bar, which is why every engine silently
      // produced nothing when it was fed one (a bar-shaped bucket has no
      // [high] / [close], so each `onBar` returned null). Nothing had called it.
      if (cur) out.push(fold(cur.bars, cur.start));
      bucketKey = key;
      cur = { start: key, bars: [] };
    }
    cur.bars.push(b);
  }
  if (cur) {
    const bar = fold(cur.bars, cur.start);
    if (cur.bars.length >= minutes) out.push(bar); else partial = bar;
  }
  return { bars: out, partial };
}

function bucketOf(time, minutes) {
  const m = /(\d+):(\d+)/.exec(String(time));           // "YYYY-MM-DD HH:MM"
  if (!m) return time;
  const day = String(time).slice(0, 10);
  const mins = Number(m[1]) * 60 + Number(m[2]);
  const base = 9 * 60 + 15;                            // NSE opens 09:15 IST
  const idx = Math.floor((mins - base) / minutes);
  return day + '#' + idx;
}

function fold(bars, start) {
  const first = bars[0], last = bars[bars.length - 1];
  let high = -Infinity, low = Infinity, vol = 0;
  for (const b of bars) {
    if (b[T.HIGH] > high) high = b[T.HIGH];
    if (b[T.LOW] < low) low = b[T.LOW];
    vol += b[T.VOLUME];
  }
  return [last[T.TIME], first[T.OPEN], high, low, last[T.CLOSE], vol, start];
}

/** The session (calendar date) a bar belongs to. */
function dayOf(bar) { return String(bar[T.TIME]).slice(0, 10); }

/** Highest of the field in the LAST `n` bars. Null when there are not `n` bars. */
function highest(bars, n, key = T.HIGH) {
  if (!Array.isArray(bars) || bars.length < n) return null;
  let best = -Infinity;
  for (let i = bars.length - n; i < bars.length; i++) if (bars[i][key] > best) best = bars[i][key];
  return best === -Infinity ? null : best;
}

/** Lowest of the field in the LAST `n` bars. Null when there are not `n` bars. */
function lowest(bars, n, key = T.LOW) {
  if (!Array.isArray(bars) || bars.length < n) return null;
  let best = Infinity;
  for (let i = bars.length - n; i < bars.length; i++) if (bars[i][key] < best) best = bars[i][key];
  return best === Infinity ? null : best;
}

/** Mean volume of the last `n` bars. Null when there is not enough history. */
function avgVolume(bars, n) {
  if (!Array.isArray(bars) || bars.length < n) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) sum += bars[i][T.VOLUME];
  const avg = sum / n;
  return avg || null;
}

/**
 * Where the close sits inside the bar's own range: 0 at the low, 1 at the high.
 * This is the cheapest honest read of who won the bar, and the Order Flow engine
 * leans on it because executed aggressor side is not in the broker packet.
 * Null for a zero-range bar — a division by zero is not a location.
 */
function closeLocation(bar) {
  const range = bar[T.HIGH] - bar[T.LOW];
  if (!range) return null;
  return (bar[T.CLOSE] - bar[T.LOW]) / range;
}

module.exports = {
  T, trueRange, atr, roc, vwap, poc, volumeRatio, aggregate, dayOf,
  highest, lowest, avgVolume, closeLocation,
  profileWidth, profileAdd, profileTop, createProfile, createVwap,
};
