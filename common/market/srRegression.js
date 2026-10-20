/**
 * common/market/srRegression.js — WHERE PRICE IS, AND HOW OFTEN THAT LEVEL HAS HELD.
 *
 * Two location primitives from the three fluxchart listings, because they answer the same question
 * ("is price standing somewhere that matters?") and neither justifies a file on its own:
 *
 * A. SUPPORT & RESISTANCE LOGISTIC REGRESSION (Pine v6 listing, public source).
 *    A pivot high/low (`pivotLength` bars each side, confirmed `pivotLength` bars late) becomes a LEVEL
 *    candidate. Each candidate carries two binary features taken AT THE PIVOT — was RSI above 50, and
 *    was the pivot bar's body bigger than ATR. The interesting part, and the only reason this is worth
 *    porting rather than replacing with "a pivot is a level": the script learns, ONLINE, which FEATURE
 *    COMBINATIONS tend to produce levels that get RESPECTED, and only marks a candidate a real level
 *    when its predicted probability clears `probabilityThreshold` (0.7).
 *
 *    The learning rule is the source's own and is transcribed exactly, including its oddities:
 *      * the label is `timesRespected >= targetRespects ? 1 : -1` — i.e. the model is trained toward
 *        "would this level end up respected", scored by how the EARLIER levels of the same type
 *        actually behaved;
 *      * the two feature biases are updated by `bias -= lr * (p + loss) * feature`, ACCUMULATED down
 *        the list of prior pivots, so the loop is order-dependent and the second-to-last pivot has
 *        more influence than the fortieth. That is not textbook gradient descent and it is not
 *        corrected here: "fixing" it while claiming to port the indicator would measure a different
 *        model than the one on the user's chart.
 *    Events (both gated on the level having been regression-detected, and retests on a `retestCooldown`
 *    of 3 bars): RETEST (level pierced, reclaimed — the level HELD) and BREAK (closed beyond the level
 *    with no reclaim — the level FAILED, and that level ends).
 *
 * B. FIBONACCI GOLDEN ZONE (Pine v5 listing, public source, `usePivots` off as DEBUG ships it).
 *    top = highest high over the last `pivotRange` bars, bottom = lowest low, and the zone is the band
 *    between the two fib retracements of that leg (0.5 and 0.618 -> the "golden pocket"). It is a
 *    CONTEXT zone: the listing produces no entry, no stop and no target, and none are invented for it.
 *
 * CLOSED CANDLES ONLY, for the same reason as every other module here: the rules read `close`, and a
 * still-forming bar makes a level look reclaimed when it is not.
 */

'use strict';

const MS = 60000;
const DEFAULTS = {
  pivotLength: 14,          // Pine `Pivot Length`
  targetRespects: 3,        // Pine `Target Respects`
  probabilityThreshold: 0.7,
  retestCooldown: 3,
  lr: 0.008,                // Pine `lr`
  recentBars: 5,            // how long an event stays "the current reading"
};

/** Wilder's RMA smoothing (the shape Pine's ta.rsi and ta.atr both use). */
function rma(values, len) {
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < len) { prev = prev == null ? values[i] : (prev * (i) + values[i]) / (i + 1); continue; }
    prev = (prev * (len - 1) + values[i]) / len;
    out[i] = prev;
  }
  return out;
}

/** RSI(len), same definition as ta.rsi. */
function rsiSeries(bars, len) {
  const gains = [], losses = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) { gains.push(0); losses.push(0); continue; }
    const d = bars[i].c - bars[i - 1].c;
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = rma(gains, len), al = rma(losses, len);
  return bars.map((_, i) => {
    if (ag[i] == null || al[i] == null) return null;
    if (al[i] === 0) return 100;
    const rs = ag[i] / al[i];
    return 100 - 100 / (1 + rs);
  });
}

/** ATR(len), same definition as ta.atr. */
function atrSeries(bars, len) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.h - b.l;
    const p = bars[i - 1];
    return Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  });
  return rma(tr, len);
}

const logistic = (x1, x2, y0, y1, y2) => 1 / (1 + Math.exp(-(y0 + y1 * x1 + y2 * x2)));
const lossOf = (y, p) => {
  const pc = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  return -y * Math.log(pc) - (1 - y) * Math.log(1 - pc);
};

class SrRegression {
  constructor(opts) {
    this.C = Object.assign({}, DEFAULTS, opts || {});
    this.bars = [];
    this.levels = [];      // {isSupport, level, startIndex, timesRespected, rsiBin, bodyBin, byRegression, pred, endIndex, latestRetestIndex}
    this.events = [];      // newest last: {type, side, level, at}
    this.stats = { pivots: 0, detected: 0, retests: 0, breaks: 0, respected: 0 };
    this._rsi = [];
    this._atr = [];
    this._ag = null;      // running Wilder average gain
    this._al = null;      // running Wilder average loss
    this._atrV = null;    // running Wilder ATR
  }

  /**
   * _stepRsiAtr(i, b) — ONE bar of RSI(pivotLength) and ATR(pivotLength), carried forward.
   *
   * Wilder's RMA is sequential, so stepping it is the SAME series the up-front recompute produced —
   * but the recompute is O(bars) per bar, i.e. O(bars^2) for a session, and this is called once per
   * bar for every symbol in the registry. That was a real hang: on 53k bars per symbol the port never
   * finished a 60-name run. The emit rule is preserved exactly: null until `i >= len`.
   */
  _stepRsiAtr(i, b) {
    const len = this.C.pivotLength;
    const prevClose = i === 0 ? null : this.bars[i - 1].c;
    const d = prevClose == null ? 0 : b.c - prevClose;
    const mix = (prev, value) => {
      if (i === 0) return value;
      if (i < len) return (prev * i + value) / (i + 1);
      return (prev * (len - 1) + value) / len;
    };
    this._ag = mix(this._ag == null ? 0 : this._ag, Math.max(0, d));
    this._al = mix(this._al == null ? 0 : this._al, Math.max(0, -d));
    const tr = prevClose == null
      ? b.h - b.l
      : Math.max(b.h - b.l, Math.abs(b.h - prevClose), Math.abs(b.l - prevClose));
    this._atrV = mix(this._atrV == null ? 0 : this._atrV, tr);
    const rsi = i < len ? null : (this._al === 0 ? 100 : 100 - 100 / (1 + this._ag / this._al));
    return { rsi, atr: i < len ? null : this._atrV };
  }

  /** add(bar) — one SEALED bar. Returns { pivots, events } produced by it. */
  add(bar) {
    const b = Array.isArray(bar)
      ? { t: bar[0], o: bar[1], h: bar[2], l: bar[3], c: bar[4], v: bar[5] }
      : bar;
    const out = { pivots: [], events: [] };
    if (!b || !(b.c > 0) || !Number.isFinite(b.h) || !Number.isFinite(b.l)) return out;
    this.bars.push(b);
    const i = this.bars.length - 1;
    const C = this.C;

    const st = this._stepRsiAtr(i, b);
    this._rsi.push(st.rsi); this._atr.push(st.atr);

    // ---- pivots, confirmed `pivotLength` bars late (ta.pivothigh(L, L)) ----
    const L = C.pivotLength;
    if (i >= 2 * L) {
      const p = i - L;
      let isH = true, isL = true;
      for (let k = p - L; k <= p + L; k++) {
        if (k === p) continue;
        if (this.bars[k].h > this.bars[p].h) isH = false;
        if (this.bars[k].l < this.bars[p].l) isL = false;
      }
      if (isH) out.pivots.push(this._newLevel(false, this.bars[p].h, p, i));
      if (isL) out.pivots.push(this._newLevel(true, this.bars[p].l, p, i));
    }

    // ---- the live levels: respect, retest, break (the source's updateSRLine) ----
    for (const sr of this.levels) {
      if (sr.endIndex != null) continue;
      let retest = false, brk = false;
      if (sr.isSupport) {
        if (b.l < sr.level) {
          if (b.c > sr.level) {
            if (sr.byRegression && i > sr.latestRetestIndex + C.retestCooldown) { retest = true; sr.latestRetestIndex = i; }
            sr.timesRespected++;
            if (sr.timesRespected === C.targetRespects) this.stats.respected++;
          } else {
            if (sr.byRegression) brk = true;
            sr.endIndex = i;
          }
        }
      } else {
        if (b.h > sr.level) {
          if (b.c < sr.level) {
            if (sr.byRegression && i > sr.latestRetestIndex + C.retestCooldown) { retest = true; sr.latestRetestIndex = i; }
            sr.timesRespected++;
            if (sr.timesRespected === C.targetRespects) this.stats.respected++;
          } else {
            if (sr.byRegression) brk = true;
            sr.endIndex = i;
          }
        }
      }
      // SIDE MAPPING, stated because it is the trade: a SUPPORT that HELD is bullish, a support that
      // BROKE is bearish; a RESISTANCE that held is bearish, one that broke is bullish.
      if (retest) {
        this.stats.retests++;
        const ev = { type: sr.isSupport ? 'SUPPORT_RETEST' : 'RESISTANCE_RETEST', side: sr.isSupport ? 'BUY' : 'SHORT', level: sr.level, at: i, byRegression: !!sr.byRegression };
        this.events.push(ev); out.events.push(ev);
      }
      if (brk) {
        this.stats.breaks++;
        const ev = { type: sr.isSupport ? 'SUPPORT_BREAK' : 'RESISTANCE_BREAK', side: sr.isSupport ? 'SHORT' : 'BUY', level: sr.level, at: i, byRegression: !!sr.byRegression };
        this.events.push(ev); out.events.push(ev);
      }
    }
    while (this.levels.length > 400) this.levels.shift();
    while (this.events.length > 500) this.events.shift();
    return out;
  }

  /**
   * _newLevel — register a pivot candidate and run the source's `predict()` on it.
   * The bias updates are the source's, order-dependent and all; see the header.
   */
  _newLevel(isSupport, level, pivotIdx, at) {
    const C = this.C;
    this.stats.pivots++;
    const pivotRSI = this._rsi[pivotIdx];
    const pivotBody = Math.abs(this.bars[pivotIdx].c - this.bars[pivotIdx].o);
    const curAtr = this._atr[at];
    const rsiBin = (pivotRSI == null ? 0 : pivotRSI) > 50 ? 1 : -1;
    const bodyBin = curAtr != null && curAtr > 0 && pivotBody > curAtr ? 1 : -1;

    const sr = {
      isSupport, level, startIndex: pivotIdx, timesRespected: 0,
      rsiBin, bodyBin, byRegression: false, pred: null, endIndex: null, latestRetestIndex: 0, at,
    };

    // ---- predict(): the online logistic over the SAME-TYPE levels seen so far ----
    let baseBias = 1.0, rsiBias = 1.0, bodyBias = 1.0;
    const same = this.levels.filter((x) => x.isSupport === isSupport);
    let logRes = 0.0;
    if (same.length > 0) {
      for (const prev of same) {
        const y = prev.timesRespected >= C.targetRespects ? 1.0 : -1.0;
        const p = logistic(prev.rsiBin, prev.bodyBin, baseBias, rsiBias, bodyBias);
        const loss = lossOf(y, p);
        rsiBias -= C.lr * (p + loss) * prev.rsiBin;
        bodyBias -= C.lr * (p + loss) * prev.bodyBin;
        logRes = logistic(rsiBin, bodyBin, baseBias, rsiBias, bodyBias);
      }
    }
    if (logRes >= C.probabilityThreshold) {
      sr.byRegression = true;
      sr.pred = logRes;
      this.stats.detected++;
    }
    this.levels.push(sr);
    return sr;
  }

  /** Live levels whose band contains `price` (a small tolerance makes it a standing-in test). */
  levelsAt(price, tol = 0.0015) {
    return this.levels.filter((sr) => sr.endIndex == null && Math.abs(price - sr.level) <= Math.abs(sr.level) * tol);
  }

  /**
   * reading(i) — the engine-facing location vote, tri-state:
   *   ok:true   the most recent live event says UP (a support held, or a resistance broke)
   *   ok:false  it says DOWN
   *   ok:null   no event inside `recentBars` — an old level is not current evidence
   */
  reading(i) {
    const idx = i == null ? this.bars.length - 1 : i;
    const recent = this.events.filter((e) => e.at <= idx && idx - e.at <= this.C.recentBars);
    if (!recent.length) return { key: 'srRegression', ok: null, detail: null, grade: null };
    const e = recent[recent.length - 1];
    return {
      key: 'srRegression',
      ok: e.side === 'BUY',
      detail: e.type.toLowerCase().replace('_', ' ') + ' at ' + e.level.toFixed(2) + ' (regression-detected: ' + (e.byRegression ? 'yes' : 'no') + ')',
      grade: e.type.includes('RETEST') ? 'held' : 'broke',
      side: e.side,
      event: e,
    };
  }

  toJSON() {
    // The running Wilder state travels with the state, or a restart silently restarts the RSI/ATR.
    return {
      C: this.C, levels: this.levels, events: this.events, stats: this.stats,
      bars: this.bars.slice(-400), _rsi: this._rsi.slice(-400), _atr: this._atr.slice(-400),
      _ag: this._ag, _al: this._al, _atrV: this._atrV,
    };
  }

  static fromJSON(o) {
    const s = new SrRegression(o.C);
    s.levels = o.levels || []; s.events = o.events || []; s.stats = o.stats || s.stats; s.bars = o.bars || [];
    s._rsi = o._rsi || []; s._atr = o._atr || [];
    s._ag = o._ag == null ? null : o._ag; s._al = o._al == null ? null : o._al; s._atrV = o._atrV == null ? null : o._atrV;
    return s;
  }
}

/**
 * goldenZone(bars, i, opts) — the Fibonacci Golden Wave band at bar i.
 * With `usePivots` false (the shipped default) top/bottom come from a rolling highest-high /
 * lowest-low over `pivotRange` bars, and the band is the two retracements (0.5, 0.618) of that leg.
 * Returns { lo, hi, top, bottom, atr } or null. It is a CONTEXT zone: the listing has no entry.
 */
function goldenZone(bars, i, opts) {
  const C = Object.assign({ pivotRange: 20, fib1: 0.5, fib2: 0.618 }, opts || {});
  const from = i - C.pivotRange + 1;
  if (from < 0) return null;
  let top = -Infinity, bottom = Infinity;
  for (let k = from; k <= i; k++) {
    const b = bars[k];
    if (!b) return null;
    if (b.h > top) top = b.h;
    if (b.l < bottom) bottom = b.l;
  }
  if (!(top > bottom)) return null;
  const diff = top - bottom;
  const f1 = top - diff * C.fib1;
  const f2 = top - diff * C.fib2;
  const lo = Math.min(f1, f2), hi = Math.max(f1, f2);
  return { lo, hi, top, bottom, legPct: +(((hi - lo) / ((hi + lo) / 2)) * 100).toFixed(3) };
}

module.exports = { SrRegression, goldenZone, rsiSeries, atrSeries, rma, DEFAULTS };
