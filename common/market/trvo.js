/**
 * common/market/trvo.js — TIME-RELATIVE VOLUME, AND WHO IS DOING THE TRADING.
 *
 * Ported from fluxchart's "Time Relative Volume Oscillator | TRVO" (Pine v5 listing, public source).
 * Two things in it matter, and the first one matters more than the oscillator does:
 *
 * 1. THE VOLUME BASELINE IS THE SAME MINUTE ON PRIOR SESSIONS, NOT THE LAST 20 BARS.
 *    `total_volume = sum(volume[tfMultiplier * i] for i = 1..relativeLen)` where `tfMultiplier` is the
 *    number of bars in a session (375 for 1-minute NSE), so `relativeVolume = this bar's volume /
 *    mean volume of THIS BAR-OF-SESSION over the last 6 sessions`.
 *
 *    That is the right normalizer and it is worth stating why, because the engine's rolling-20-bar
 *    ratio is the wrong one and this repo has the measurement to prove it: a 20-bar average is
 *    manufactured BY the tape being measured, so on a dead stock the mid-session minutes drag the
 *    average down with them and a 20-share print reads as "volume confirmed" (measured: at a 1.0x
 *    threshold, a dead minute earned no penalty at all). A same-minute-of-day baseline cannot be
 *    dragged down by the very quiet it is supposed to detect — 09:20 today is compared against 09:20
 *    on the previous six sessions, which is the only comparison that answers "is this minute busy?".
 *    The tape here is 142 sessions, so six lookbacks are available after the first week.
 *
 * 2. THE BUY/SELL SPLIT IS A PROXY, AND IT IS LABELLED ONE EVERYWHERE IT SURFACES.
 *    `buyRelativeVolume = relativeVolume * (close - low) / (high - low)` attributes a bar's volume to
 *    buyers by WHERE THE BAR CLOSED in its own range, and to sellers by `(high - close) / (high - low)`.
 *    That is a guess about aggression made from OHLCV — there is no executed footprint, no bid/ask
 *    and no true delta on this feed (`data/orderflow/` has never held a session). The Pine source
 *    itself is only doing this because TradingView has no aggressor data either. So every output
 *    that comes from it is named `proxy` here, and nothing in this module may be described as
 *    "buying volume" — because it is not.
 *
 * THE THREE MODES are the source's three, and they answer different questions:
 *   classic    osc = 4/(1+e^(-2*rv+3)) - 0.18, plotted scaled by volume200  -> "is THIS MINUTE busy"
 *   oscillator buyVsSell = buyPct - sellPct, EMA(21) - EMA(36), smoothed   -> "who is winning"
 *   delta      the same difference scaled by volume200, crossovers signalled -> the tradeable one
 *
 * A NOTE ON THE CLASSIC OSCILLATOR'S SHAPE, because it is easy to read a threshold into it and there
 * is not one. `osc(rv) = 4/(1+e^(3-2*rv)) - 0.18` is monotone increasing on rv >= 0, runs from
 * +0.0097 at rv = 0 to a saturation of +3.82, and crosses zero only at rv = -0.028 — that is, the
 * source's plotted zero line is NOT a "1.5x" or "1x" volume threshold; every real bar is above it.
 * The -0.18 offset just puts the floor of the curve at the pane's zero. So classic mode answers
 * "how busy is this minute" as a positive number and carries no direction, and the buy/sell split is
 * where the only sign lives. That is why `reading()` votes on the split and never on `relativePlot`.
 * The curve is left exactly as the source has it: re-centring it would be a silent strategy edit
 * inside a port.
 */

'use strict';

const MS = 60000;

const DEFAULTS = {
  relativeLen: 6,       // sessions to average over (Pine min 1, max 10)
  oscillatorShort: 21,
  oscillatorLong: 36,
  deltaSmoothing: 9,
  volSmaLen: 200,
  barsPerSession: null, // inferred from the tape when null (the source infers it too)
};

/** Exponential moving average with Pine's alpha, seeded on the first value (ta.ema's shape). */
function emaSeries(values, len) {
  const out = new Array(values.length).fill(null);
  const a = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { out[i] = null; continue; }
    prev = prev == null ? v : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}

function smaOf(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] == null ? 0 : values[i];
    if (i >= len) sum -= values[i - len] == null ? 0 : values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

/** The source's classic response: monotone in rv, ~0 at zero volume, saturating ~3.82 at high rv. */
function classicOsc(rv) {
  return 4 / (1 + Math.pow(Math.E, (-2 * rv + 3))) - 0.18;
}

/**
 * Trvo — one instance per symbol. Feed SEALED bars in order; `value(i)` reads the finished series.
 *
 * The module is array-based rather than incremental because the volume lookback is
 * `tfMultiplier * i` bars (375, 750, 1125, ... for 1m), so it needs history by construction — and
 * because a same-minute-of-day baseline is only meaningful once the earlier session exists.
 */
class Trvo {
  constructor(opts) {
    this.C = Object.assign({}, DEFAULTS, opts || {});
    this.bars = [];
  }

  /** add(bar) — one sealed bar. Returns false for a bar that is not usable. */
  add(bar) {
    const b = Array.isArray(bar)
      ? { t: bar[0], o: bar[1], h: bar[2], l: bar[3], c: bar[4], v: bar[5] }
      : bar;
    if (!b || !(b.c > 0) || !Number.isFinite(b.h) || !Number.isFinite(b.l)) return false;
    this.bars.push(b);
    return true;
  }

  /**
   * sessionLengths() — bars per session, in order. The source infers `barsInSession` as a RUNNING
   * MAX of (bars until the daily close), which on a 1-minute session resolves to that session's own
   * length; a half-day resolves to the half-day, which is why the length is recomputed per session
   * here rather than hardcoded to 375.
   */
  sessionLengths() {
    const out = [];
    let cur = null;
    for (const b of this.bars) {
      const day = new Date((typeof b.t === 'number' ? b.t : Date.parse(String(b.t).replace(' ', 'T').slice(0, 16) + ':00+05:30')) + 330 * MS).toISOString().slice(0, 10);
      if (!cur || cur.day !== day) { cur = { day, n: 0 }; out.push(cur); }
      cur.n++;
    }
    return out.map((s) => s.n);
  }

  /**
   * series(barIndex) — the whole computation up to (and including) `barIndex`, or the last bar.
   * Returns arrays for the three modes plus the buy/sell split. PURE: no state is mutated here, so
   * the same bar can be asked about twice and answer the same thing.
   */
  series(barIndex) {
    const C = this.C;
    const n = barIndex == null ? this.bars.length - 1 : barIndex;
    const bars = this.bars;
    if (n < 0) return null;
    const perSession = C.barsPerSession || (this.sessionLengths().length ? this.sessionLengths()[Math.floor(this.sessionLengths().length / 2)] : 375);

    const vol = bars.map((b) => (Number.isFinite(b.v) ? b.v : 0));
    const rv = new Array(bars.length).fill(null);
    const buyPct = new Array(bars.length).fill(null);
    const sellPct = new Array(bars.length).fill(null);
    const classic = new Array(bars.length).fill(null);

    for (let i = 0; i < bars.length; i++) {
      // ---- relative volume against the SAME MINUTE on prior sessions ----
      let sum = 0, got = 0;
      for (let k = 1; k <= C.relativeLen; k++) {
        const j = i - perSession * k;
        if (j >= 0) { sum += vol[j]; got++; }
      }
      if (got > 0) {
        const base = sum / got;
        if (base > 0) rv[i] = vol[i] / base;
      }
      // ---- the buy/sell split: a PROXY from where the bar closed in its own range ----
      const b = bars[i];
      const range = b.h - b.l;
      if (range > 0 && rv[i] != null) {
        const buy = rv[i] * ((b.c - b.l) / range);
        const sell = rv[i] * ((b.h - b.c) / range);
        const tot = buy + sell;
        if (tot > 0) { buyPct[i] = buy / tot; sellPct[i] = sell / tot; }
      }
      if (rv[i] != null) classic[i] = classicOsc(rv[i]);
    }

    const vol200 = smaOf(vol, C.volSmaLen);
    const relativePlot = classic.map((v, i) => (v == null || vol200[i] == null ? null : v * vol200[i]));
    const buyVsSell = buyPct.map((v, i) => (v == null || sellPct[i] == null ? null : v - sellPct[i]));

    const cleanBvS = buyVsSell.map((v) => (v == null ? 0 : v));
    const shortEma = emaSeries(cleanBvS, C.oscillatorShort);
    const longEma = emaSeries(cleanBvS, C.oscillatorLong);
    const diffRaw = shortEma.map((v, i) => (v == null || longEma[i] == null ? null : v - longEma[i]));
    const diff = emaSeries(diffRaw.map((v) => (v == null ? null : v)), 9);
    const boundSma = smaOf(diff.map((v) => (v == null ? 0 : Math.abs(v))), C.volSmaLen);
    const oscillator = diff.map((v, i) => {
      if (v == null || boundSma[i] == null || !(boundSma[i] > 0)) return null;
      return 2.4 / (1 + Math.pow(Math.e, ((-1 / boundSma[i]) * v))) - 1.2;
    });

    // ---- delta mode: the same difference, scaled by volume200, smoothed ----
    const bvsScaled = buyVsSell.map((v, i) => (v == null || vol200[i] == null ? null : v * vol200[i] * 20));
    const sE = emaSeries(bvsScaled.map((v) => (v == null ? 0 : v)), C.oscillatorShort);
    const lE = emaSeries(bvsScaled.map((v) => (v == null ? 0 : v)), C.oscillatorLong);
    const dRaw = sE.map((v, i) => v - lE[i]);
    const delta = emaSeries(dRaw, C.deltaSmoothing);

    return { n, perSession, rv, buyPct, sellPct, classic, vol200, relativePlot, buyVsSell, oscillator, delta };
  }

  /**
   * reading(i) — the engine-facing vote, tri-state like every other reading:
   *   ok:true   the proxy says buyers are in control of this bar
   *   ok:false  sellers are
   *   ok:null   unreadable (no prior-session baseline yet, or a zero-range bar) — and null NEVER
   *             blocks a call, which is the whole difference between a quiet reading and a no vote.
   * `flowSource` is attached to every non-null reading so nothing downstream can present a proxy as
   * executed aggression.
   */
  reading(i) {
    const s = this.series(i);
    if (!s) return { key: 'trvo', ok: null, detail: 'no bars', flowSource: 'proxy(close-in-range)', proxy: true };
    const bvs = s.buyVsSell[s.n];
    const rv = s.rv[s.n];
    if (bvs == null || rv == null) {
      return { key: 'trvo', ok: null, detail: rv == null ? 'no same-minute baseline yet' : 'flat bar', flowSource: 'proxy(close-in-range)', proxy: true };
    }
    const buyers = bvs > 0;
    return {
      key: 'trvo',
      ok: buyers,
      detail: (buyers ? 'buyers' : 'sellers') + ' ' + Math.abs(bvs * 100).toFixed(0) + '% of the split · volume '
        + rv.toFixed(2) + 'x the same minute on prior sessions',
      rv: +rv.toFixed(3),
      buyVsSell: +bvs.toFixed(4),
      grade: rv >= 1.5 ? 'busy' : (rv < 0.7 ? 'thin' : 'normal'),
      flowSource: 'proxy(close-in-range) — no executed footprint on this feed',
      proxy: true,
    };
  }

  /** The delta-mode crossover: +1 when the smoothed buy/sell difference turns up, -1 down, 0 otherwise. */
  deltaSignal(i) {
    const s = this.series(i);
    if (!s) return 0;
    const cur = s.delta[s.n], prev = s.delta[s.n - 1];
    if (cur == null || prev == null) return 0;
    if (cur > 0 && prev <= 0) return 1;
    if (cur < 0 && prev >= 0) return -1;
    return 0;
  }

  toJSON() { return { C: this.C, bars: this.bars.slice(-2000) }; }

  static fromJSON(o) {
    const t = new Trvo(o.C);
    t.bars = o.bars || [];
    return t;
  }
}

module.exports = { Trvo, emaSeries, smaOf, classicOsc, DEFAULTS };
