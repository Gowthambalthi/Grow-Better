/**
 * gb_scoring_v2/github/strategies.js — EXTERNAL STRATEGIES, PORTED AND MEASURED ON THE SAME TAPE.
 *
 * WHAT THIS IS. The user supplied a ranked list of public GitHub trading repos with their CLAIMED
 * numbers. The list's own conclusion was the important part: the higher the claim, the less vetting
 * behind it, and the one project that ran a strict out-of-sample + cost check publicly retired its
 * 90% win rate and replaced it with a single-digit annual return. So the claims are not the input
 * here — the RULES are. Each strategy below is the repo's own documented entry/exit logic, ported
 * to run on the same NSE 1-minute bars, through the same simulator (`raschke/backtest.simulate`),
 * with the same costs, so a claim can be replaced with a measurement.
 *
 * WHAT IS AND IS NOT FAITHFUL — read this before trusting a row:
 *   * The RULES are transcribed from the repo's source, and each strategy names the file it came
 *     from in `source`. Nothing here was tuned to make NSE data look good.
 *   * The ORDER TYPE is not. Two of these repos (AI-trader, options-lab) trade OPTION PREMIUM: the
 *     signal is a direction, and the P&L is the call/put's move, which needs an option chain, a
 *     strike, an expiry and a IV surface we do not have. Those are tested here as DIRECTIONAL
 *     signals on the underlying with an ATR stop, and `adaptation` says so on the row. An option
 *     buyer's premium can move several times faster than the underlying — which cuts BOTH ways, so
 *     this is not a conservative estimate, it is a different instrument.
 *   * The EXIT MODEL is supplied by the repo where the repo defines one (ORB, EMA-RSI, Bollinger,
 *     Supertrend, VWAP reversion, the trend algo) and is an explicit ATR adaptation where it does
 *     not. `exitSource` marks which.
 *   * nifty50's engine is a multi-stage ICT state machine (BOS/CHOCH -> FVG/order-block entry).
 *     The port keeps the documented CHAIN (first-candle liquidity touch -> direction -> structure
 *     confirmation -> retrace entry) but reduces the five entry detectors to the retracement one
 *     and marks itself `reduced` — it is not byte-equivalent to that repo.
 *   * options-lab is NOT ported. It is an options/Panel-IC project (iron condors, lot history,
 *     Android exporter) with no directional intraday equity signal to port, and its own author
 *     retired the headline number. It is listed in the output as `not-portable` rather than
 *     silently dropped — a table that only shows the testable entries implies the rest did not
 *     exist.
 *
 * HOW A STRATEGY IS EXPRESSED. `init(bars)` precomputes every series ONCE per symbol (a strategy
 * that recomputed a 50-period EMA per bar would make the whole scan unusably slow), and `at(bars, i,
 * state)` is an O(1) test at bar i that returns a candidate or null. A candidate is the same shape
 * the Raschke setups produce — `{ side, entry, stop, rewardRisk, setup }` — plus an optional
 * `policy` for exits that need to be evaluated as the trade runs. Because `at()` may only read
 * series values at or before `i`, a strategy cannot see the future even by accident.
 */
const IND = require('../raschke/indicators');
// The simulator's OWN side mapper, required here on purpose: a candidate's side is a claim about
// direction, and the rule for reading it must be the same one the simulator, the runner and the
// forward returns use. Duplicating that rule locally is how 'LONG' once became a short.
const { sideSign } = require('../raschke/backtest');

const MIN = 60000;

/** istMinutes(t) — minutes past IST midnight, for the session time gates the repos state. */
function istMinutes(t) {
  const d = new Date(t + 330 * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Precompute, for every bar, which session it is in and how far into it we are. */
function sessionIndex(bars) {
  const key = new Array(bars.length).fill(null);
  const start = new Array(bars.length).fill(0);
  const into = new Array(bars.length).fill(0);
  let cur = null, s = 0;
  for (let i = 0; i < bars.length; i++) {
    const k = IND.sessionKeyOf(bars[i].t);
    if (k !== cur) { cur = k; s = i; }
    key[i] = k; start[i] = s; into[i] = i - s;
  }
  return { key, start, into };
}

/** atrSeries(bars, n) — one ATR value per bar (the per-index ATR helper, walked forward). */
function atrSeries(bars, n) {
  const out = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) out[i] = IND.atr(bars, n, i);
  return out;
}

/**
 * adxSeries(bars, n) — one ADX value per bar.
 *
 * `IND.adx()` returns a RICH OBJECT ({ adx, plusDI, minusDI, up }), not a number. Storing that
 * object in the series made the trend strategy's `adx < 20` gate compare an object with a number
 * (always false, so the gate never refused anything) and then throw on `adx.toFixed(0)` — which the
 * runner's per-strategy try/catch swallowed, so the strategy produced ZERO trades and looked like a
 * strategy that simply never fires rather than one that was broken. The `.adx` field is read here,
 * and `.up` is carried alongside because the direction of DI is free information the caller may
 * want without a second O(n) pass.
 */
function adxSeries(bars, n) {
  const out = new Array(bars.length).fill(null);
  const outUp = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const a = IND.adx(bars, n, i);
    out[i] = a == null ? null : a.adx;
    outUp[i] = a == null ? null : !!a.up;
  }
  return { adx: out, up: outUp };
}

/**
 * htfTrendByBar(bars, mult, fast, slow, slopeLookback) — the higher-timeframe trend, mapped back
 * onto 1m bars WITHOUT LOOKAHEAD.
 *
 * The trap this exists to avoid: aggregating 1m bars into 4m bars and reading the 4m value for the
 * bucket the current 1m bar sits INSIDE. That bucket has not closed, so its close is partly the
 * future. Only buckets that have already CLOSED as of bar i are used, which is why there is an
 * explicit `bucketEnd <= bars[i].t` test rather than an index lookup.
 */
function htfTrendByBar(bars, mult, fast, slow, slopeLookback) {
  const out = new Array(bars.length).fill(0);
  const h = IND.aggregate(bars, mult);
  if (!h.length) return out;
  const hf = IND.emaSeries(h, fast), hs = IND.emaSeries(h, slow);
  const bucketMs = mult * MIN;
  const trend = new Array(h.length).fill(0);
  for (let k = 0; k < h.length; k++) {
    const slope = (k - slopeLookback >= 0 && hs[k] != null && hs[k - slopeLookback] != null)
      ? hs[k] - hs[k - slopeLookback] : null;
    if (hf[k] == null || hs[k] == null || slope == null) { trend[k] = 0; continue; }
    if (hf[k] > hs[k] && slope > 0) trend[k] = 1;
    else if (hf[k] < hs[k] && slope < 0) trend[k] = -1;
  }
  let lastClosed = -1;
  for (let i = 0; i < bars.length; i++) {
    while (lastClosed + 1 < h.length && h[lastClosed + 1].t + bucketMs <= bars[i].t) lastClosed++;
    out[i] = lastClosed >= 0 ? trend[lastClosed] : 0;
  }
  return out;
}

/** rollingVolumeRatio(bars, n) — bar volume vs the mean of the previous n bars. 1 = average. */
function rollingVolumeRatio(bars, n = 20) {
  const out = new Array(bars.length).fill(null);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i >= n) sum -= bars[i - n].v;
    if (i >= n && sum > 0) out[i] = bars[i].v / (sum / n);
    sum += bars[i].v;
  }
  return out;
}

// ===========================================================================
// REPO: vijaxx/algo-trading-system  (algotrade/strategies/*.py)
// ===========================================================================

/** ORB — algotrade/strategies/orb.py. range 15m, buffer 0.05%, rr 1.5, 1 trade/day. */
const orb = {
  id: 'orb',
  name: 'Opening Range Breakout',
  repo: 'vijaxx/algo-trading-system',
  source: 'algotrade/strategies/orb.py',
  exitSource: 'repo (stop = opposite side of range, target = rr x risk)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    const RANGE_MIN = 15, BUFFER = 0.0005, RR = 1.5;
    const hi = new Array(bars.length).fill(null);
    const lo = new Array(bars.length).fill(null);
    // the range must be COMPLETE before it can be broken: a bar inside the window sees nothing
    for (let i = 0; i < bars.length; i++) {
      const s = sess.start[i];
      const mins = istMinutes(bars[i].t);
      const inWindow = minutesSinceOpen(bars[s].t) >= 0 && minutesSinceOpen(bars[i].t) < RANGE_MIN;
      if (inWindow) continue;
      let h = -Infinity, l = Infinity;
      for (let j = s; j <= i; j++) {
        if (minutesSinceOpen(bars[j].t) >= RANGE_MIN) break;
        if (bars[j].h > h) h = bars[j].h;
        if (bars[j].l < l) l = bars[j].l;
      }
      if (isFinite(h) && isFinite(l) && h > l) { hi[i] = h; lo[i] = l; }
      void mins;
    }
    return { sess, hi, lo, traded: new Set(), RR, BUFFER };
  },
  at(bars, i, st) {
    if (st.hi[i] == null || st.lo[i] == null) return null;
    if (i + 1 >= bars.length) return null;
    const day = st.sess.key[i];
    if (st.traded.has(day)) return null;                    // max_trades_per_day = 1
    const c = bars[i].c;
    const up = st.hi[i] * (1 + st.BUFFER), dn = st.lo[i] * (1 - st.BUFFER);
    if (c > up) {
      const risk = c - st.lo[i];
      if (!(risk > 0)) return null;
      st.traded.add(day);
      return { side: 'BUY', entry: c, stop: st.lo[i], rewardRisk: st.RR, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'close beyond OR high' };
    }
    if (c < dn) {
      const risk = st.hi[i] - c;
      if (!(risk > 0)) return null;
      st.traded.add(day);
      return { side: 'SHORT', entry: c, stop: st.hi[i], rewardRisk: st.RR, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'close beyond OR low' };
    }
    return null;
  },
};

/** VWAP reversion — algotrade/strategies/vwap_reversion.py. dev 0.4%, stop 0.35%, target VWAP. */
const vwapReversion = {
  id: 'vwap_reversion',
  name: 'VWAP Mean Reversion',
  repo: 'vijaxx/algo-trading-system',
  source: 'algotrade/strategies/vwap_reversion.py',
  exitSource: 'repo (target = the session VWAP level at signal time)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    const vwap = IND.vwapSeries(bars);
    const ratios = rollingVolumeRatio(bars, 20);
    return { sess, vwap, ratios, traded: new Map(), ENTRY_DEV: 0.4, STOP_DEV: 0.35, MIN_BARS: 6, MAX: 3 };
  },
  at(bars, i, st) {
    if (st.sess.into[i] < st.MIN_BARS) return null;          // VWAP off 2-3 bars is noise
    if (i + 1 >= bars.length) return null;
    const vw = st.vwap[i];
    const c = bars[i].c;
    if (!(vw > 0)) return null;
    const day = st.sess.key[i];
    const used = st.traded.get(day) || 0;
    if (used >= st.MAX) return null;
    const dev = ((c - vw) / vw) * 100;
    const mk = (side, stop) => {
      // the repo's target is the VWAP LEVEL. It is carried as the R-multiple it implies, so the
      // simulator's re-anchoring to the real fill keeps the same structural distance — the same
      // treatment every other plan on this tape gets.
      const risk = Math.abs(c - stop);
      if (!(risk > 0)) return null;
      st.traded.set(day, used + 1);
      return { side, entry: c, stop, rewardRisk: Math.abs(vw - c) / risk, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: st.ratios[i] }, reason: 'stretched ' + dev.toFixed(2) + '% from VWAP' };
    };
    if (dev <= -st.ENTRY_DEV) return mk('BUY', c * (1 - st.STOP_DEV / 100));
    if (dev >= st.ENTRY_DEV) return mk('SHORT', c * (1 + st.STOP_DEV / 100));
    return null;
  },
};

/** EMA-RSI — algotrade/strategies/ema_rsi.py. EMA9/21 cross gated by RSI14, ATR stop, rr 1.5. */
const emaRsi = {
  id: 'ema_rsi',
  name: 'EMA Crossover + RSI gate',
  repo: 'vijaxx/algo-trading-system',
  source: 'algotrade/strategies/ema_rsi.py',
  exitSource: 'repo (ATR stop 1.5x, target = 1.5R; the repo also exits on the opposite EMA cross — the fixed target is used here)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    return {
      sess, f: IND.emaSeries(bars, 9), s: IND.emaSeries(bars, 21),
      rsi: IND.rsiSeries(bars, 14), atr: atrSeries(bars, 14),
      STOP_MULT: 1.5, RR: 1.5, RSI_LONG: 55, RSI_SHORT: 45,
    };
  },
  at(bars, i, st) {
    if (i < 2 || i + 1 >= bars.length) return null;
    const { f, s, rsi, atr } = { f: st.f[i], s: st.s[i], rsi: st.rsi[i], atr: st.atr[i] };
    const fp = st.f[i - 1], sp = st.s[i - 1];
    if (f == null || s == null || fp == null || sp == null || rsi == null || !(atr > 0)) return null;
    const c = bars[i].c, risk = st.STOP_MULT * atr;
    const up = fp <= sp && f > s, dn = fp >= sp && f < s;
    if (up && rsi >= st.RSI_LONG) return { side: 'BUY', entry: c, stop: c - risk, rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'EMA cross up, RSI ' + rsi.toFixed(1) };
    if (dn && rsi <= st.RSI_SHORT) return { side: 'SHORT', entry: c, stop: c + risk, rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'EMA cross down, RSI ' + rsi.toFixed(1) };
    return null;
  },
};

/** Bollinger breakout — algotrade/strategies/bollinger.py. BB20 2sigma, squeeze <= 1.2%, stop = mid. */
const bollinger = {
  id: 'bollinger',
  name: 'Bollinger breakout (squeeze)',
  repo: 'vijaxx/algo-trading-system',
  source: 'algotrade/strategies/bollinger.py',
  exitSource: 'repo (stop = basis/mid, target = 1.5R)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    const bb = IND.bollingerSeries(bars, 20, 2);
    return { sess, bb, MAX_BW: 1.2, SQ: 3, RR: 1.5 };
  },
  at(bars, i, st) {
    const { upper, mid, lower, bandwidth } = st.bb;
    if (i < 2 || i + 1 >= bars.length) return null;
    if (upper[i] == null || mid[i] == null || lower[i] == null) return null;
    // the squeeze is measured on the bars BEFORE the breakout bar
    let bwMin = Infinity, ok = true;
    for (let k = i - st.SQ; k <= i - 1; k++) {
      if (k < 0 || bandwidth[k] == null) { ok = false; break; }
      if (bandwidth[k] < bwMin) bwMin = bandwidth[k];
    }
    if (!ok || bwMin > st.MAX_BW) return null;
    const c = bars[i].c, pc = bars[i - 1].c;
    if (upper[i - 1] == null || lower[i - 1] == null) return null;
    if (c > upper[i] && pc <= upper[i - 1]) {
      const risk = c - mid[i];
      if (!(risk > 0)) return null;
      return { side: 'BUY', entry: c, stop: mid[i], rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'broke upper band after squeeze' };
    }
    if (c < lower[i] && pc >= lower[i - 1]) {
      const risk = mid[i] - c;
      if (!(risk > 0)) return null;
      return { side: 'SHORT', entry: c, stop: mid[i], rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'broke lower band after squeeze' };
    }
    return null;
  },
};

/** Supertrend — algotrade/strategies/supertrend_strategy.py. ST10 x2.0 flip, stop = the line. */
const supertrend = {
  id: 'supertrend',
  name: 'Supertrend flip',
  repo: 'vijaxx/algo-trading-system',
  source: 'algotrade/strategies/supertrend_strategy.py',
  exitSource: 'repo (the Supertrend line trails the stop; an opposite flip closes the trade)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    const st = IND.supertrendSeries(bars, 10, 2.0);
    return { sess, line: st.line, dir: st.dir, RR: 2.0 };
  },
  at(bars, i, st) {
    if (i < 2 || i + 1 >= bars.length) return null;
    const d = st.dir[i], dp = st.dir[i - 1], line = st.line[i];
    if (d == null || dp == null || line == null) return null;
    const c = bars[i].c;
    if (dp < 0 && d > 0) {
      const risk = c - line;
      if (!(risk > 0)) return null;
      return { side: 'BUY', entry: c, stop: line, rewardRisk: st.RR, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'Supertrend flipped up',
        // the line ratchets: it can tighten the stop, never loosen it (simulate enforces that too)
        policy: {
          stopAt: (j) => (st.dir[j] === 1 ? st.line[j] : null),
          shouldExit: (j) => st.dir[j] === -1,
        } };
    }
    if (dp > 0 && d < 0) {
      const risk = line - c;
      if (!(risk > 0)) return null;
      return { side: 'SHORT', entry: c, stop: line, rewardRisk: st.RR, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'Supertrend flipped down',
        policy: {
          stopAt: (j) => (st.dir[j] === -1 ? st.line[j] : null),
          shouldExit: (j) => st.dir[j] === 1,
        } };
    }
    return null;
  },
};

// ===========================================================================
// REPO: aaryansinha16/AI-trader  (strategy/signal_generator.py)
// ===========================================================================
// These three are OPTIONS signals in the source (buy ATM call / put). See the header: the
// DIRECTIONAL edge is tested on the underlying with an explicit ATR stop, and `adaptation` says so.

const AI_ADAPT = 'source trades option premium (no chain available here): directional signal tested on the underlying with a 1.5xATR stop, 1.5R target';

const aiVwapMomentum = {
  id: 'ai_vwap_momentum',
  name: 'AI-trader: VWAP momentum breakout',
  repo: 'aaryansinha16/AI-trader',
  source: 'strategy/signal_generator.py::vwap_momentum_breakout',
  exitSource: 'adaptation (repo defines no underlying stop)',
  adaptation: AI_ADAPT,
  init(bars) {
    const sess = sessionIndex(bars);
    return {
      sess, vwap: IND.vwapSeries(bars), rsi: IND.rsiSeries(bars, 14),
      e20: IND.emaSeries(bars, 20), e50: IND.emaSeries(bars, 50),
      vr: rollingVolumeRatio(bars, 20), atr: atrSeries(bars, 14), STOP: 1.5, RR: 1.5,
    };
  },
  at(bars, i, st) {
    if (i + 1 >= bars.length) return null;
    const c = bars[i].c, vw = st.vwap[i], rsi = st.rsi[i], e20 = st.e20[i], e50 = st.e50[i], vr = st.vr[i], a = st.atr[i];
    if (vw == null || rsi == null || e20 == null || e50 == null || !(a > 0)) return null;
    const cond = { price_above_vwap: c > vw, rsi_above_55: rsi > 55, ema20_above_ema50: e20 > e50, volume_spike: vr != null && vr > 1.5 };
    const met = Object.values(cond).filter(Boolean).length;
    if (met < 3) return null;
    return { side: 'BUY', entry: c, stop: c - st.STOP * a, rewardRisk: st.RR, setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: vr }, reason: met + '/4 conditions' };
  },
};

const aiBearishMomentum = {
  id: 'ai_bearish_momentum',
  name: 'AI-trader: bearish momentum',
  repo: 'aaryansinha16/AI-trader',
  source: 'strategy/signal_generator.py::bearish_momentum',
  exitSource: 'adaptation (repo defines no underlying stop)',
  adaptation: AI_ADAPT,
  init: aiVwapMomentum.init,
  at(bars, i, st) {
    if (i + 1 >= bars.length) return null;
    const c = bars[i].c, vw = st.vwap[i], rsi = st.rsi[i], e20 = st.e20[i], e50 = st.e50[i], vr = st.vr[i], a = st.atr[i];
    if (vw == null || rsi == null || e20 == null || e50 == null || !(a > 0)) return null;
    const cond = { price_below_vwap: c < vw, rsi_below_45: rsi < 45, ema20_below_ema50: e20 < e50, volume_spike: vr != null && vr > 1.5 };
    const met = Object.values(cond).filter(Boolean).length;
    if (met < 3) return null;
    return { side: 'SHORT', entry: c, stop: c + st.STOP * a, rewardRisk: st.RR, setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: vr }, reason: met + '/4 conditions' };
  },
};

const aiMeanReversion = {
  id: 'ai_mean_reversion',
  name: 'AI-trader: mean reversion',
  repo: 'aaryansinha16/AI-trader',
  source: 'strategy/signal_generator.py::mean_reversion',
  exitSource: 'adaptation (repo defines no underlying stop)',
  adaptation: AI_ADAPT,
  init(bars) {
    const sess = sessionIndex(bars);
    const bb = IND.bollingerSeries(bars, 20, 2);
    return { sess, bb, rsi: IND.rsiSeries(bars, 14), vwap: IND.vwapSeries(bars), atr: atrSeries(bars, 14), STOP: 1.5, RR: 1.5 };
  },
  at(bars, i, st) {
    if (i + 1 >= bars.length) return null;
    const c = bars[i].c, rsi = st.rsi[i], vw = st.vwap[i], a = st.atr[i];
    if (rsi == null || vw == null || !(a > 0) || vw <= 0) return null;
    const vwapDist = Math.abs((c - vw) / vw);
    const bbL = st.bb.lower[i], bbU = st.bb.upper[i];
    if (rsi < 30) {
      // the repo's dict always contains rsi_extreme; met >= 2 means "extreme AND one of the other two"
      const cond = { rsi_extreme: true, near_bb_lower: bbL != null && c <= bbL * 1.002, far_from_vwap: vwapDist > 0.003 };
      const met = Object.values(cond).filter(Boolean).length;
      if (met < 2) return null;
      return { side: 'BUY', entry: c, stop: c - st.STOP * a, rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'RSI ' + rsi.toFixed(1) + ' oversold at a band' };
    }
    if (rsi > 70) {
      const cond = { rsi_extreme: true, near_bb_upper: bbU != null && c >= bbU * 0.998, far_from_vwap: vwapDist > 0.003 };
      const met = Object.values(cond).filter(Boolean).length;
      if (met < 2) return null;
      return { side: 'SHORT', entry: c, stop: c + st.STOP * a, rewardRisk: st.RR, setup: this.id, evidenceTags: { rangeRatio: null, volRatio: null }, reason: 'RSI ' + rsi.toFixed(1) + ' overbought at a band' };
    }
    return null;
  },
};

// ===========================================================================
// REPO: anirudhatalmale6-alt/nifty-banknifty-intraday-trend-algo
//         (src/nifty_algo/strategy.py + config.py defaults)
// ===========================================================================

const niftyTrend = {
  id: 'nifty_trend',
  name: 'Nifty intraday trend (5-filter breakout)',
  repo: 'anirudhatalmale6-alt/nifty-banknifty-intraday-trend-algo',
  source: 'src/nifty_algo/strategy.py::generate_signals (config.py defaults: EMA9/21, ST10x2.5, Donchian20, ADX>=20, ATR%>=0.05%)',
  exitSource: 'repo (ATR stop 1.5x, break-even at +1xATR, Supertrend trail, EMA cross exit, 15:15 square-off, no fixed target)',
  adaptation: null,
  init(bars) {
    const sess = sessionIndex(bars);
    const st10 = IND.supertrendSeries(bars, 10, 2.5);
    return {
      sess,
      e9: IND.emaSeries(bars, 9), e21: IND.emaSeries(bars, 21),
      atr: atrSeries(bars, 14), adx: adxSeries(bars, 14).adx,
      stLine: st10.line, stDir: st10.dir,
      dc: IND.donchianSeries(bars, 20),
      htf: htfTrendByBar(bars, 4, 20, 50, 3),
      ADX_MIN: 20, ATR_PCT_MIN: 0.0005, STOP_MULT: 1.5, BE_MULT: 1.0,
      ENTRY_START: 9 * 60 + 30, ENTRY_CUTOFF: 14 * 60 + 45, SQUARE_OFF: 15 * 60 + 15,
    };
  },
  at(bars, i, st) {
    if (i + 1 >= bars.length) return null;
    const mins = istMinutes(bars[i].t);
    if (mins < st.ENTRY_START || mins > st.ENTRY_CUTOFF) return null;
    const c = bars[i].c, a = st.atr[i], adx = st.adx[i];
    const e9 = st.e9[i], e21 = st.e21[i], dcv = st.dc.upper[i], dcl = st.dc.lower[i];
    const htf = st.htf[i], dir = st.stDir[i];
    if (a == null || adx == null || e9 == null || e21 == null || dcv == null || dcl == null || dir == null) return null;
    if (!(a > 0) || a / c < st.ATR_PCT_MIN) return null;          // dead tape: stop would be noise
    if (adx < st.ADX_MIN) return null;                            // chopping: breakouts fail
    const up = htf === 1 && dir === 1 && c > dcv && e9 > e21;
    const dn = htf === -1 && dir === -1 && c < dcl && e9 < e21;
    const mk = (side) => {
      const risk = st.STOP_MULT * a;
      const stop = side === 'BUY' ? c - risk : c + risk;
      const be = st.BE_MULT * a;
      return {
        side, entry: c, stop, rewardRisk: 0, noTarget: true, setup: this.id,
        evidenceTags: { rangeRatio: null, volRatio: null },
        reason: '5 filters agree (htf ' + htf + ', ST ' + dir + ', ADX ' + adx.toFixed(0) + ')',
        // THE EXITS THE REPO DESCRIBES, in order: lose the stop, move to break-even once the trade
        // has run 1xATR, then let the Supertrend line trail it, and leave on the EMA cross or at
        // the square-off. No fixed target — the repo's own default is 0.0 precisely because a
        // trend system's money is in the tail.
        policy: {
          stopAt: (j, bs, ps) => {
            // THE POLICY IS HANDED THE SIMULATOR'S BARS, WHICH ARE ARRAYS. This strategy's own code
            // reads OBJECT bars (norm()'s view), so `bs[j].h` is undefined here and the comparison
            // `undefined - c >= be` is always false — the break-even move then never happens and the
            // trend plan is measured WITHOUT the exit model its repo defines. Read whichever shape
            // arrived instead of assuming the one this function was written against.
            const bj = bs[j], arr = Array.isArray(bj);
            const hi = arr ? bj[2] : bj.h, lo = arr ? bj[3] : bj.l;
            const moved = side === 'BUY' ? hi - c >= be : c - lo >= be;
            let s = ps.beSet ? ps.stop : (moved ? c : stop);
            if (moved) ps.beSet = true;
            const line = st.stLine[j];
            const d = st.stDir[j];
            if (line != null && d === (side === 'BUY' ? 1 : -1)) s = side === 'BUY' ? Math.max(s, line) : Math.min(s, line);
            return s;
          },
          shouldExit: (j, bs) => {
            const bj = bs[j];
            if (istMinutes(Array.isArray(bj) ? bj[0] : bj.t) >= st.SQUARE_OFF) return true;
            const f = st.e9[j], sl = st.e21[j];
            if (f == null || sl == null) return false;
            return side === 'BUY' ? f < sl : f > sl;
          },
        },
      };
    };
    if (up) return mk('BUY');
    if (dn) return mk('SHORT');
    return null;
  },
};

// ===========================================================================
// REPO: vijay158199/nifty50  (backend/app/strategy/*)
// ===========================================================================
// The source is an ICT/SMC engine: a first-candle liquidity touch, then a market-structure break
// (BOS/CHOCH), then an entry on the retracement into the FVG/order-block zone the displacement leg
// left behind. The port keeps that CHAIN and reduces the five entry-zone detectors to the
// retracement one. `reduced: true` marks it, because calling a reduction "the repo" would be a
// claim this port cannot support.
//
// ---- WITHDRAWN AS AN EDGE (2026-09-27): this row's ESTABLISHED number was a FABRICATION ----
// The entry rule armed a retracement entry at whatever the bar closed at, WITHOUT re-checking the
// invalidation level the stop is built from. When the pullback had already traded through that level,
// the candidate came back as a long whose stop sat ABOVE its fill — and the simulator credits the
// first touch of that level as a STOP-OUT, booking exactly +1.0000R on the next bar. On a 6-symbol
// sample: 186 of 452 trades carried the wrong-side stop, 270 booked that phantom +1R with an MFE of
// ZERO (a win the price path never offered), and the mean R WITHOUT them is −1.105R. On 20 symbols ×
// the last 43 sessions the honest numbers are 241 trades, gross −0.084R, net −0.380R, gross win 32%,
// PF 0.55. Same failure family as the liquiditySweep row: a structurally impossible trade booking a
// constant +1R. Two guards now make it unbookable — `BT.simulate` refuses a stop that is not beyond
// the entry in the losing direction, and `at()` below refuses a setup whose invalidation was already
// breached. Nothing here is ESTABLISHED; the +0.121R row was this bug.

const nifty50Ict = {
  id: 'nifty50_ict',
  name: 'nifty50 ICT: liquidity sweep -> structure -> retrace',
  repo: 'vijay158199/nifty50',
  source: 'backend/app/strategy/breakout_sweep.py + structure.py + entries.py (reduced: retracement entry only)',
  exitSource: 'adaptation (stop beyond the displacement extreme, target 2R; the repo computes its own risk module)',
  adaptation: 'five entry-zone detectors reduced to the retracement entry; first-candle window 30m',
  reduced: true,
  init(bars) {
    const sess = sessionIndex(bars);
    const FIRST_MIN = 30, LOOK = 60, RR = 2.0;
    // One plan per session, precomputed: the first-candle range, the first bar that touches it, the
    // displacement leg that follows, and the retracement level that becomes the entry.
    const plan = new Array(bars.length).fill(null);
    let s = 0;
    while (s < bars.length) {
      let e = s;
      while (e + 1 < bars.length && sess.key[e + 1] === sess.key[s]) e++;
      // first candle: the first FIRST_MIN minutes of the session
      let fh = -Infinity, fl = Infinity;
      let k = s;
      for (; k <= e; k++) {
        if (minutesSinceOpen(bars[k].t) >= FIRST_MIN) break;
        if (bars[k].h > fh) fh = bars[k].h;
        if (bars[k].l < fl) fl = bars[k].l;
      }
      if (isFinite(fh) && isFinite(fl) && fh > fl) {
        // ---- THE TRIGGER: the first bar that touches either first-candle level ----
        let j = -1, side = null, kind = null;
        for (let t = k; t <= Math.min(e, k + LOOK); t++) {
          const touchedHigh = bars[t].h >= fh, touchedLow = bars[t].l <= fl;
          if (!touchedHigh && !touchedLow) continue;
          if (touchedHigh && touchedLow) {
            // a wide bar spanning both: whichever level the open sat closer to came first
            const o = bars[t].o;
            if (Math.abs(o - fl) <= Math.abs(o - fh)) { side = 'BUY'; kind = bars[t].c < fl ? 'breakout' : 'sweep'; }
            else { side = 'SHORT'; kind = bars[t].c > fh ? 'breakout' : 'sweep'; }
          } else if (touchedHigh) {
            // break of the high continues up; a SWEEP (touch then close back inside) is the fade
            kind = bars[t].c > fh ? 'breakout' : 'sweep';
            side = kind === 'breakout' ? 'BUY' : 'SHORT';
          } else {
            kind = bars[t].c < fl ? 'breakout' : 'sweep';
            side = kind === 'breakout' ? 'SHORT' : 'BUY';
          }
          j = t;
          break;
        }
        // ---- THE DISPLACEMENT LEG, AS A FIXED FORWARD WINDOW ----
        // This was `scan forward and remember where the extreme landed, then arm the retracement
        // from there`. That reads as harmless and is NOT: the extreme is a maximum over a window
        // that can extend BEYOND the bar being decided, so the entry at bar k depended on bars
        // after k. A bar at k-1 could not know a later bar would not exceed it, so the code was
        // deciding k using the future — the one thing a bar backtest must never do.
        //
        // The leg is therefore a FIXED window that starts at the trigger and runs FIRST_MIN
        // minutes, fully independent of what price does inside it, and entries are armed only for
        // bars AFTER that window closes. Every input to the entry at bar m is then at or before
        // the window end, which is strictly before m.
        if (j >= 0) {
          const wEnd = Math.min(e, j + FIRST_MIN);
          if (wEnd > j) {
            let ext = side === 'BUY' ? -Infinity : Infinity;
            for (let m = j; m <= wEnd; m++) {
              if (side === 'BUY' && bars[m].h > ext) ext = bars[m].h;
              if (side === 'SHORT' && bars[m].l < ext) ext = bars[m].l;
            }
            const origin = side === 'BUY' ? bars[j].l : bars[j].h;
            const leg = Math.abs(ext - origin);
            if (isFinite(ext) && leg > 0) {
              const retrace = side === 'BUY' ? ext - leg * 0.5 : ext + leg * 0.5;   // golden-ratio zone
              for (let m = wEnd + 1; m <= e; m++) {
                const hit = side === 'BUY' ? bars[m].l <= retrace : bars[m].h >= retrace;
                if (hit) { plan[m] = { side, kind, stop: origin, rr: RR, retrace, origin, ext, legFrom: j, legTo: wEnd }; break; }
              }
            }
          }
        }
      }
      s = e + 1;
    }
    return { sess, plan, RR };
  },
  at(bars, i, st) {
    const p = st.plan[i];
    if (!p || i + 1 >= bars.length) return null;
    const c = bars[i].c;
    const risk = Math.abs(c - p.stop);
    if (!(risk > 0)) return null;
    // ---- THE INVALIDATION LEVEL IS PART OF THE PLAN ----
    // `p.stop` is the trigger bar's extreme: the level whose breach kills the idea. Arming the entry at
    // the first bar that trades back into the displacement zone never checked that the level survived
    // that pullback — and when it did not, this returned a long with its stop ABOVE the entry, which the
    // simulator then resolved as a stop-out booking exactly +1.00R on the next bar. That single missing
    // check is where this strategy's ESTABLISHED row came from: on a 6-symbol sample 186 of 452 trades
    // carried the wrong-side stop, 270 booked a fabricated +1R with an MFE of ZERO, and the mean R
    // without them is −1.105R. If price has already traded through the invalidation, the setup is dead.
    if (sideSign(p.side) === 1 ? !(c > p.stop) : !(c < p.stop)) return null;
    return {
      side: p.side, entry: c, stop: p.stop, rewardRisk: p.rr, setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: null },
      reason: p.kind + ' of the first 30m range, retraced into the displacement zone',
    };
  },
};

// ===========================================================================
// aggShortCircuit — a new external strategy, ported from the user's own plan's
// V3 order-flow gate logic (aggression step-up + candle confirmation + price-at-
// range/S-R location), both sides, ATR stop + ATR target, measured on NSE 1m.
//
// RULES (transcribed from the agreed plan, NOT tuned on this tape):
//   ENTRY BOTH SIDES, one condition set per side:
//     1. AGGRESSION STEP-UP — the current bar's range is meaningfully larger than the
//        rolling average bar range (the bar is "active", not a doji), AND the bar
//        closes toward its range extreme in the trade direction (bullish close = high
//        end of range, bearish close = low end). This is the plan's "aggression"
//        column idea made bar-local: a move with real participation, not a drift.
//     2. CANDLE CONFIRMATION — at least one of a small allowed pattern set must be
//        present on the bar: bullish/bearish engulfing, hammer/inverted-hammer on the
//        right side, or an inside-bar breakout on the prevailing side. This is the
//        plan's "candle confirmation" gate, swept here as a fixed allowed set so the
//        backtest can tell whether confirmation helps.
//     3. LOCATION — the signal bar's close must be at or past a meaningful reference:
//        either the session's anchored 15m range edge (ORB breakout entry) OR the
//        session high/low (structure breakout). A breakout into nowhere is not an entry;
//        the bar must be trading AT the place the move means something. The session
//        extreme is the plan's "S/R across timeframes" reduced to the session scale so
//        the rule is purely bar-local and never reads a future bar.
//   EXIT: ATR-based — stop = 1.5x ATR(14) beyond entry, target = 2.0R. The repo's own
//     logic is "exit on collapse OR ATR stop/target"; collapse (a reversal candle of
//     similar size to the entry bar) is a future-bar condition a bar backtest cannot
//     evaluate without peeking, so the fixed ATR stop/target is used as the honest
//     instrument, and `exitSource` says so.
//   TIME GATE: no entry in the last 15 minutes of the session (no holding into close),
//     and no entry before the 15m ORB window has completed (no believed-breakout before
//     the range exists) — both are plan decisions, not tunings.
//
// CLAIM: the repo/docs for this style claim a discretionary edge from "order-flow
// aggression + candle + location". No published win-rate number; the row says so.
// ===========================================================================
const aggShortCircuit = {
  id: 'aggShortCircuit',
  // NOT STRATEGY 1 — see STRATEGY_ONE_STATUS below. The name says what the code is so the leaderboard
  // cannot imply the plan's hypothesis was tested: this is a BREAKOUT that uses an OHLCV aggression
  // PROXY for its gate. The plan's Strategy 1 is "control flips mid-candle: exhausted aggression at
  // the POC", which needs EXECUTED delta at price. Improving this file's thresholds will never get
  // closer to that hypothesis, because it has no POC and no executed flow to act on.
  name: 'Aggression-proxy breakout + location filter (NOT the plan\'s Strategy 1)',
  strategyOne: false,
  repo: 'user-plan-v3 (order-flow gate: aggression + candle + location)',
  source: 'gb_scoring_v2 plan V3 gate logic (ShortCircuit-style aggression step-up + candle confirmation + price-at-range/S-R location), both sides',
  exitSource: 'adaptation (the plan says exit on collapse OR ATR stop/target; collapse is a future-bar condition a bar backtest cannot evaluate without peeking, so the fixed ATR stop/target is used as the honest instrument)',
  adaptation: 'both sides (plan is one-sided discretionary); candle confirmation reduced to a fixed allowed set {engulfing, hammer/inverted-hammer, inside-bar breakout} so the backtest can tell whether confirmation helps; location = session 15m range edge OR session high/low (plan S/R across timeframes reduced to session scale so the rule is bar-local)',
  init(bars) {
    const sess = sessionIndex(bars);
    const atr = atrSeries(bars, 14);
    // rolling bar-range (high-low) average over 10 bars — the "average bar size" the
    // aggression step-up is measured against. A bar must be clearly bigger than this to
    // count as an aggression event.
    const barRange = new Array(bars.length).fill(null);
    const barRangeAvg = new Array(bars.length).fill(null);
    const prevClose = new Array(bars.length).fill(null);
    const prevRange = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      barRange[i] = bars[i].h - bars[i].l;
      prevClose[i] = i > 0 ? bars[i - 1].c : null;
      prevRange[i] = i > 0 ? barRange[i - 1] : null;
    }
    // rolling mean of barRange over window n, null until the window exists
    const win = 10;
    for (let i = 0; i < bars.length; i++) {
      if (i < win - 1) continue;
      let s = 0;
      for (let j = i - win + 1; j <= i; j++) s += barRange[j];
      barRangeAvg[i] = s / win;
    }
    // candle-pattern flags, bar-local, no future:
    //   engulf: current bar's body engulfs the previous bar's body (same direction as the trade)
    //   hammer: small body at the top (buy) or bottom (sell) of the range with a long opposite wick
    //   insideBreakout: current bar is an inside bar of the prior, THEN breaks out in the trade direction
    const isEngulfBull = new Array(bars.length).fill(false);
    const isEngulfBear = new Array(bars.length).fill(false);
    const isHammerBull = new Array(bars.length).fill(false);
    const isHammerBear = new Array(bars.length).fill(false);
    const isInsideBreakBull = new Array(bars.length).fill(false);
    const isInsideBreakBear = new Array(bars.length).fill(false);
    for (let i = 1; i < bars.length; i++) {
      const cur = bars[i], prev = bars[i - 1];
      const cb = Math.abs(cur.c - cur.o), pb = Math.abs(prev.c - prev.o);
      const cr = cur.h - cur.l, pr = prev.h - prev.l;
      if (pb > 0 && cb > 0) {
        // bullish engulfing: prev red (close<open), cur green, cur body engulfs prev body
        if (prev.c < prev.o && cur.c > cur.o &&
            cur.o <= prev.c && cur.c >= prev.o) isEngulfBull[i] = true;
        // bearish engulfing: prev green, cur red, cur body engulfs prev body
        if (prev.c > prev.o && cur.c < cur.o &&
            cur.o >= prev.c && cur.c <= prev.o) isEngulfBear[i] = true;
      }
      // hammer (bullish): small body in top half, lower wick >= 2x body, upper wick small
      if (cr > 0 && cb <= cr * 0.33) {
        const lower = Math.min(cur.c, cur.o) - cur.l;
        const upper = cur.h - Math.max(cur.c, cur.o);
        if (lower >= cb * 2 && upper <= cb * 0.5) isHammerBull[i] = true;
        // inverted hammer (bullish): small body in lower half, upper wick >= 2x body
        if (upper >= cb * 2 && lower <= cb * 0.5) isHammerBull[i] = true;
        // bearish hanging-man/shooting star mirror
        if (upper >= cb * 2 && lower <= cb * 0.5) isHammerBear[i] = true;
        if (lower >= cb * 2 && upper <= cb * 0.5) isHammerBear[i] = true;
      }
      // inside-bar breakout: cur inside prev (cur high<=prev high, cur low>=prev low),
      // then THIS bar breaks out in the trade direction
      if (i >= 2) {
        const prev2 = bars[i - 2];
        if (cur.h <= prev.h && cur.l >= prev.l && prev.h > prev.l) {
          // inside bar formed; breakout = close beyond prev range extreme
          if (cur.c > prev.h) isInsideBreakBull[i] = true;
          if (cur.c < prev.l) isInsideBreakBear[i] = true;
        }
      }
    }
    return {
      sess, atr, barRange, barRangeAvg, prevClose, prevRange,
      isEngulfBull, isEngulfBear, isHammerBull, isHammerBear,
      isInsideBreakBull, isInsideBreakBear,
      range: rangeStorage(bars),
    };
  },
  at(bars, i, st) {
    if (i + 1 >= bars.length) return null;
    const day = st.sess.key[i];
    const nextDay = st.sess.key[i + 1];
    if (day !== nextDay) return null;              // do not enter across the close
    const moNext = minutesSinceOpen(bars[i + 1].t);
    if (moNext < 0 || moNext >= 15 * 60 - 15) return null; // no entry before ORB done or in last 15m
    const c = bars[i].c;
    const a = st.atr[i];
    if (!(a > 0)) return null;
    const br = st.barRange[i], bra = st.barRangeAvg[i];
    if (br == null || bra == null || bra <= 0) return null;
    const closePos = (c - bars[i].l) / (br || 1);  // 0..1 where in the bar the close sat
    const atrMult = 1.5, rr = 2.0;
    const risk = atrMult * a;

    // ---- helper: does this bar carry a candle confirmation for the given side? ----
    // Confirmation = a recognised reversal/continuation pattern (engulfing, hammer,
    // inside-bar breakout) OR a strong close toward the bar's range extreme in the trade
    // direction (a big bar closing in the direction IS evidence the aggression is real).
    // The pattern set is the stricter signal; the close-position is the fallback that keeps
    // the rule reachable on thinner data without becoming a no-op.
    const confirm = (side) => {
      const pat = side === 'BUY'
        ? st.isEngulfBull[i] || st.isHammerBull[i] || st.isInsideBreakBull[i]
        : st.isEngulfBear[i] || st.isHammerBear[i] || st.isInsideBreakBear[i];
      if (pat) return true;
      // strong close toward the extreme: bull bar closes in its top third, bear bar in its bottom third
      return side === 'BUY' ? closePos >= 0.62 : closePos <= 0.38;
    };

    // ---- location tests: is the close AT a meaningful reference on the right side? ----
    const orHi = st.range.orHi[i], orLo = st.range.orLo[i];
    const sessHi = st.range.sessHi[i], sessLo = st.range.sessLo[i];
    const atOrHigh = orHi != null && c >= orHi * (1 - 0.0015);     // at/past OR high (breakout entry)
    const atOrLow = orLo != null && c <= orLo * (1 + 0.0015);      // at/past OR low
    const atsessHigh = sessHi != null && c >= sessHi * (1 - 0.0015);
    const atsessLow = sessLo != null && c <= sessLo * (1 + 0.0015);

    // ---- AGGRESSION STEP-UP: bar range >= 1.5x avg AND close toward the trade extreme ----
    const aggUp = br >= 1.5 * bra && closePos >= 0.6;     // bullish aggression: big bar, closes high
    const aggDown = br >= 1.5 * bra && closePos <= 0.4;   // bearish aggression: big bar, closes low

    // ---- BUY: aggression UP + candle conf + at range edge / session high ----
    // The stop must sit BELOW the bar low: a stop inside the bar would be triggered by the
    // bar itself and is degenerate (the Raschke harness still refuses sub-0.15% stops, but
    // a stop inside the bar is structurally inside the day's noise, not a real invalidation).
    if (aggUp && confirm('BUY') && (atOrHigh || atsessHigh) && risk > 0) {
      const stop = c - risk;
      if (stop < bars[i].l) {
        return { side: 'BUY', entry: c, stop, rewardRisk: rr, setup: this.id,
          evidenceTags: { aggStepUp: (br / bra).toFixed(2), candle: 'yes', location: atOrHigh ? 'OR-high' : 'sess-high' },
          reason: 'aggression step-up (' + (br / bra).toFixed(1) + 'x avg bar) + candle conf + at ' + (atOrHigh ? 'OR high' : 'session high') };
      }
    }
    // ---- SHORT: aggression DOWN + candle conf + at range edge / session low ----
    if (aggDown && confirm('SHORT') && (atOrLow || atsessLow) && risk > 0) {
      const stop = c + risk;
      if (stop > bars[i].h) {
        return { side: 'SHORT', entry: c, stop, rewardRisk: rr, setup: this.id,
          evidenceTags: { aggStepUp: (br / bra).toFixed(2), candle: 'yes', location: atOrLow ? 'OR-low' : 'sess-low' },
          reason: 'aggression step-up (' + (br / bra).toFixed(1) + 'x avg bar) + candle conf + at ' + (atOrLow ? 'OR low' : 'session low') };
      }
    }
    return null;
  },
};

/** minutesSinceOpen(t) — minutes past the 09:15 IST session open for that timestamp. */
function minutesSinceOpen(t) {
  const m = istMinutes(t);
  return m - (9 * 60 + 15);
}

/**
 * rangeStorage(bars) — per-session anchored open-range bands used as location evidence.
 * For each session, the first 15-minute range (ORB window) high/low, plus the
 * running session high/low, are stored so the strategy can ask "is price at the
 * range edge" without peeking forward.
 */
function rangeStorage(bars) {
  const sess = sessionIndex(bars);
  const orHi = new Array(bars.length).fill(null);
  const orLo = new Array(bars.length).fill(null);
  const sessHi = new Array(bars.length).fill(null);
  const sessLo = new Array(bars.length).fill(null);
  const orDone = new Array(bars.length).fill(false);
  let curDay = null;
  let orH = -Infinity, orL = Infinity;
  let sh = -Infinity, sl = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const k = sess.key[i];
    if (k !== curDay) {
      curDay = k; orH = -Infinity; orL = Infinity; sh = -Infinity; sl = Infinity;
    }
    const mins = istMinutes(bars[i].t);
    const mo = minutesSinceOpen(bars[i].t);
    if (mo >= 0 && mo < 15) {
      if (bars[i].h > orH) orH = bars[i].h;
      if (bars[i].l < orL) orL = bars[i].l;
    }
    if (bars[i].h > sh) sh = bars[i].h;
    if (bars[i].l < sl) sl = bars[i].l;
    if (mo >= 15) orDone[i] = true;
    // store the RANGE AS OF bar i, computed from bars up to i — never from the future
    if (orH > -Infinity && orL < Infinity) { orHi[i] = orH; orLo[i] = orL; }
    if (sh > -Infinity && sl < Infinity) { sessHi[i] = sh; sessLo[i] = sl; }
  }
  return { orHi, orLo, sessHi, sessLo, orDone };
}

// ===========================================================================
// STRATEGY 3 — liquiditySweep: LIQUIDITY SWEEP REVERSAL (stop-hunt / "Judas swing")
//
// HYPOTHESIS (a genuinely DIFFERENT bet from the first two, which is the only reason to run it
// beside them): obvious swing highs/lows are where retail stops and breakout orders cluster, so
// price is drawn through them to trigger that flow and then reverses. Strategy 1 bets that control
// flips mid-candle; Strategy 2 bets that a broken level is ACCEPTED and continues; this one bets
// that a broken level is REJECTED — it was a trap. Three different mechanisms, not three flavours
// of one.
//
// THE 7 STEPS, AS IMPLEMENTED (each is bar-local; nothing reads a bar after i):
//   1. LIQUIDITY POOLS — prior-day high/low, the running session high/low once it is at least 5
//      bars STALE (a level price is returning to, not one it is setting right now), and confirmed
//      2-left/2-right pivot highs/lows from the last 60 bars (a pivot is only confirmed 2 bars
//      after it forms, exactly like IND.swings, so the newest bars can never be a "pivot").
//   2. SWEEP — a bar pierces a pool (high above a high level / low below a low level). If it closes
//      back inside, that single bar is both sweep and rejection; if it closes beyond, the sweep is
//      held PENDING and a close back inside within 2 bars completes it (the "brief close beyond").
//   3. REJECTION + DISPLACEMENT — the rejection bar must close in the reversal direction, and its
//      body must be >= dispMult x the rolling average body (a displacement, not a slow drift).
//   4. FLOW CONFIRMATION — the sweep/rejection must carry a volume spike (volume >= volMult x the
//      rolling 20-bar average) AND an "aggression step-up": the rejection bar's RANGE >= aggMult x
//      the rolling average range AND its volume >= flowStepUp x the PREVIOUS bar's volume.
//      ** READ THIS ** The tape here is OHLCV 1m. There is NO executed footprint, no bid/ask depth,
//      no true net delta. The plan's "previous-bucket net-delta step-up" is therefore approximated
//      by a volume/range step-up and LABELLED A PROXY everywhere it surfaces (`executedFlow` below,
//      `flowSource` on every candidate). Treating resting depth as executed aggression would be
//      inventing the missing half of the signal; this refuses to.
//   5. FVG / IMBALANCE — the rejection window must leave a 3-bar fair-value gap in the reversal
//      direction (bearish gap = bar[a].low > bar[a+2].high) at least fvgMinAtr x ATR(14) tall, so
//      it is a real displacement gap and not a rounding artefact. The gap IS the entry zone.
//   6. ROC CONFIRMATION — at the entry bar, ROC10 and ROC20 must both point in the reversal
//      direction (both < 0 for a sweep of a high, both > 0 for a sweep of a low).
//   7. STOP — beyond the sweep WICK extreme (the highest high / lowest low of the sweep, buffered
//      0.05%), which is the invalidation and makes the stop tight by construction. Target is an R
//      multiple of that structural risk; the R multiple is CONFIG, swept (1R / 1.5R / 2R) rather
//      than assumed, because a tight stop plus a fixed R:R is exactly the shape that flatters and
//      then fails.
//
// CONFIGURABLE ON PURPOSE (locked decisions 2 and 3): `aggMult` (1.5 / 2.0 / 3.0) and `candleReq`
// ('none' / 'engulf' / 'any1') are inputs, not constants, so the backtest can MEASURE whether the
// aggression threshold and the candle requirement add anything instead of assuming they do. Selection
// of a config happens on the development portion of the tape only (see `.freebuff/sweep-liquidity.js`).
//
// CLAIM: none. This setup is heavily popularised (ICT/SMC), which on liquid NSE names means the exact
// swing levels everyone watches may already be crowded — so popularity is treated here as a RISK to
// the hypothesis, not evidence for it. The row says "no published number".
// ===========================================================================
// SIDE NAMING IS CANONICAL HERE: 'BUY' / 'SHORT'.
//
// This strategy used to label its long side 'LONG'. The simulator mapped `side !== 'BUY'` to a SHORT,
// so every long candidate was simulated in the OPPOSITE direction: its stop sat below its entry, the
// first bar's high "hit" that stop, and the trade closed instantly at +1.00R gross. Every number this
// strategy produced before that fix was therefore inflated by a fabricated win on its long side —
// which is how it became the top row of the leaderboard. 'LONG' is now 'BUY', the simulator refuses
// unknown labels outright, and the runner's sign mapping goes through BT.sideSign.
function makeLiquiditySweep(cfg) {
  const C = Object.assign({
    aggMult: 2.0,       // aggression step-up: rejection-bar range vs rolling avg range
    flowStepUp: 1.5,    // net-delta PROXY step-up: bar volume vs PREVIOUS bar volume
    volMult: 1.5,       // sweep/rejection volume vs rolling 20-bar average volume
    candleReq: 'any1',  // 'none' | 'engulf' | 'any1' (engulfing OR hammer OR inside-bar breakout)
    dispMult: 1.1,      // rejection body vs rolling avg body
    fvgMinAtr: 0.10,    // gap must be >= 0.10 x ATR(14) to count as an imbalance
    ctxWait: 6,         // bars after the rejection during which the FVG may still form
    fvgWait: 20,        // bars an armed FVG zone stays live before it expires
    rr: 2.0,
    // ---- STOP WIDTH, ONE AXIS (swept; see .freebuff/sweep-stopwidth.js) ----
    // The sweep wick extreme is the STRUCTURAL invalidation and stays the basis of the stop; these
    // two options only decide how far BEYOND it the stop sits. `stopBuffer` is a fraction of the
    // wick-extreme price (0.0005 = the original 0.05% buffer), and `stopBufferAtrMult` > 0 overrides
    // it with ATR(14) at the arm bar x mult (an ABSOLUTE buffer). Both are swept against the target,
    // because a stop is where the risk denominator and therefore cost-in-R comes from: widening it
    // lowers cost/R and lowers the chance of being stopped on noise, at the price of a worse R:R on
    // every winner. That trade-off is measured on the grid, not assumed.
    stopBuffer: 0.0005,
    stopBufferAtrMult: 0,
  }, cfg || {});
  const id = (cfg && cfg.id) || 'liquiditySweep';
  return {
    id,
    name: 'Liquidity Sweep Reversal (stop-hunt)',
    repo: 'ICT/SMC stop-hunt (popularised, no single repo) — user plan v3 addendum',
    source: 'user plan v3 addendum: liquidity pools -> sweep -> rejection/displacement -> flow -> FVG entry -> ROC -> stop beyond the wick',
    exitSource: 'structural (stop beyond the sweep wick extreme, target = an R multiple of that risk; the wick is the invalidation, so the stop is tight by construction)',
    adaptation: 'FLOW CONFIRMATION IS A PROXY. The tape is OHLCV 1m, so there is no executed footprint, no order-book depth and no true net delta. The plan\'s "net-delta step-up" is approximated by a volume/range step-up and labelled proxy here and on every candidate — it is NOT executed aggression.',
    executedFlow: 'unavailable — OHLCV only; no footprint/bid-ask feed. Aggression step-up is a volume/range PROXY.',
    config: { aggMult: C.aggMult, flowStepUp: C.flowStepUp, volMult: C.volMult, candleReq: C.candleReq, dispMult: C.dispMult, fvgMinAtr: C.fvgMinAtr, ctxWait: C.ctxWait, fvgWait: C.fvgWait, rr: C.rr, stopBuffer: C.stopBuffer, stopBufferAtrMult: C.stopBufferAtrMult },
    init(bars) {
      const n = bars.length;
      const sess = sessionIndex(bars);

      // ---- rolling averages (strictly past-only, so the current bar is never its own baseline) ----
      const avgRange = new Array(n).fill(null);
      const avgBody = new Array(n).fill(null);
      const avgVol = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        if (i >= 10) {
          let r = 0, bd = 0;
          for (let j = i - 10; j < i; j++) { r += bars[j].h - bars[j].l; bd += Math.abs(bars[j].c - bars[j].o); }
          avgRange[i] = r / 10; avgBody[i] = bd / 10;
        }
        if (i >= 20) {
          let v = 0;
          for (let j = i - 20; j < i; j++) v += bars[j].v;
          avgVol[i] = v / 20;
        }
      }

      // ---- ROC10 / ROC20 (step 6) ----
      const roc10 = new Array(n).fill(null);
      const roc20 = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        if (i >= 10 && bars[i - 10].c > 0) roc10[i] = (bars[i].c - bars[i - 10].c) / bars[i - 10].c;
        if (i >= 20 && bars[i - 20].c > 0) roc20[i] = (bars[i].c - bars[i - 20].c) / bars[i - 20].c;
      }

      // ---- candle patterns, bar-local (the configurable confirmation of step 3) ----
      const bullEngulf = new Array(n).fill(false), bearEngulf = new Array(n).fill(false);
      const bullHammer = new Array(n).fill(false), bearHammer = new Array(n).fill(false);
      const insideBreakBull = new Array(n).fill(false), insideBreakBear = new Array(n).fill(false);
      for (let i = 1; i < n; i++) {
        const cur = bars[i], prev = bars[i - 1];
        const cb = Math.abs(cur.c - cur.o), cr = cur.h - cur.l;
        if (cb > 0) {
          if (prev.c < prev.o && cur.c > cur.o && cur.o <= prev.c && cur.c >= prev.o) bullEngulf[i] = true;
          if (prev.c > prev.o && cur.c < cur.o && cur.o >= prev.c && cur.c <= prev.o) bearEngulf[i] = true;
        }
        if (cr > 0 && cb <= cr * 0.34) {
          const lower = Math.min(cur.c, cur.o) - cur.l;
          const upper = cur.h - Math.max(cur.c, cur.o);
          // hammer (bullish): long LOWER wick; shooting star (bearish): long UPPER wick. An
          // inverted hammer is a bullish hammer whose long wick is on the upper side, so both
          // shapes are admitted on their respective sides.
          if (lower >= Math.max(cb, cr * 0.001) * 2 && upper <= cb * 0.5) { bullHammer[i] = true; bearHammer[i] = true; }
          if (upper >= Math.max(cb, cr * 0.001) * 2 && lower <= cb * 0.5) { bullHammer[i] = true; bearHammer[i] = true; }
        }
        if (i >= 2 && cur.h <= prev.h && cur.l >= prev.l && prev.h > prev.l) {
          if (cur.c > prev.h) insideBreakBull[i] = true;
          if (cur.c < prev.l) insideBreakBear[i] = true;
        }
      }

      // ---- confirmed pivots (step 1). A pivot at j needs 2 bars on EACH side, so it is only
      // usable from bar j+2 onwards — the standard no-lookahead swing definition. ----
      const isPivotHigh = new Array(n).fill(false);
      const isPivotLow = new Array(n).fill(false);
      for (let j = 2; j <= n - 3; j++) {
        const h = bars[j].h, l = bars[j].l;
        if (h > bars[j - 1].h && h > bars[j - 2].h && h > bars[j + 1].h && h > bars[j + 2].h) isPivotHigh[j] = true;
        if (l < bars[j - 1].l && l < bars[j - 2].l && l < bars[j + 1].l && l < bars[j + 2].l) isPivotLow[j] = true;
      }

      // ---- prior-SESSION high/low (step 1): the previous completed session's extremes, mapped onto
      // this session. A gap-up day has no prior level to sweep until a prior day exists. ----
      const priorHi = new Array(n).fill(null);
      const priorLo = new Array(n).fill(null);
      {
        let start = 0, prevH = null, prevL = null;
        while (start < n) {
          let end = start;
          while (end + 1 < n && sess.key[end + 1] === sess.key[start]) end++;
          if (prevH != null) for (let k = start; k <= end; k++) { priorHi[k] = prevH; priorLo[k] = prevL; }
          let hh = -Infinity, ll = Infinity;
          for (let k = start; k <= end; k++) { if (bars[k].h > hh) hh = bars[k].h; if (bars[k].l < ll) ll = bars[k].l; }
          prevH = hh; prevL = ll;
          start = end + 1;
        }
      }

      const PIVOT_KEEP = 6;         // how many recent swing levels stay live as liquidity pools
      const PIVOT_LOOKBACK = 60;    // ...and how far back they may sit
      const SESSION_STALE = 5;      // a session high/low is a pool only once it is >= 5 bars old

      // ---- stage counters. These exist because a strategy whose conditions are ALL conjunctions can
      // go silently DEAD (zero signals) and a dead row in a results table looks like "it just never
      // fired" rather than "one gate can never open". Counters make the failing gate visible.
      const dbg = { pierceHigh: 0, pierceLow: 0, pending: 0, rejections: 0, contexts: 0, fvgArmed: 0, entries: 0, fail: { vol: 0, agg: 0, volStep: 0, flip: 0, disp: 0, candle: 0, fvg: 0, risk: 0, roc: 0, time: 0 } };

      // ---- tryArm: given a completed sweep+rejection, test steps 3-5 and arm the FVG zone ----
      const tryArm = (side, info, i) => {
        dbg.rejections++;
        const cur = bars[i];
        const range = cur.h - cur.l;
        // ---- THE SWEEP IS THE WINDOW, NOT THE REJECTION BAR ALONE ----
        // The aggression/volume of a stop-hunt lives on the bar(s) that PIERCED the level; the
        // rejection bar then closes back inside and can be small. Testing the aggression gates only
        // on the rejection bar never opens (measured: 8/8 rejections failed the volume gate on the
        // fixture), which is how a conjunction quietly becomes a dead strategy. Each gate is
        // therefore taken as the MAXIMUM over the sweep window (pierce bar .. rejection bar).
        const maxVol = Math.max(cur.v, info.vol || 0);
        const maxRange = Math.max(range, info.range || 0);
        // step 4a: volume spike on the sweep/rejection
        const volOk = avgVol[i] > 0 && maxVol >= C.volMult * avgVol[i];
        // step 4b: aggression step-up (range) + net-delta PROXY (volume vs the bar BEFORE the sweep)
        const rangeRatio = avgRange[i] > 0 ? maxRange / avgRange[i] : 0;
        const aggOk = rangeRatio >= C.aggMult;
        const volStepOk = info.prevVol > 0 && maxVol >= C.flowStepUp * info.prevVol;
        // step 3a: the rejection bar closes in the reversal direction
        const closePos = range > 0 ? (cur.c - cur.l) / range : 0.5;
        const flipOk = side === 'SHORT' ? (cur.c < cur.o && closePos <= 0.45) : (cur.c > cur.o && closePos >= 0.55);
        // step 3b: displacement — a strong body, not a slow drift
        const body = Math.abs(cur.c - cur.o);
        const dispOk = avgBody[i] > 0 ? body >= C.dispMult * avgBody[i] : true;
        // step 3c: the configurable candle requirement
        let candleOk = true;
        if (C.candleReq === 'engulf') candleOk = side === 'SHORT' ? bearEngulf[i] : bullEngulf[i];
        else if (C.candleReq === 'any1') candleOk = side === 'SHORT'
          ? (bearEngulf[i] || bearHammer[i] || insideBreakBear[i])
          : (bullEngulf[i] || bullHammer[i] || insideBreakBull[i]);
        // step 6: ROC CONFIRMATION — applies HERE, at the moment the reversal is established, not
        // at the FVG retrace. The plan says "ROC10 turns down, ROC20 turns down" and the natural
        // reading is the TURN (the derivative), because the entry is a retrace INTO the reversal:
        // at the retrace bar the shorter ROC is frequently pointing the other way by construction,
        // so demanding an absolute negative there would make the rule unsatisfiable and the
        // strategy dead. "Turns" is therefore the sign of the change, in the reversal direction.
        const rocTurnOk = side === 'SHORT'
          ? (roc10[i] != null && roc20[i] != null && roc10[i - 1] != null && roc20[i - 1] != null
            && roc10[i] < roc10[i - 1] && roc20[i] < roc20[i - 1])
          : (roc10[i] != null && roc20[i] != null && roc10[i - 1] != null && roc20[i - 1] != null
            && roc10[i] > roc10[i - 1] && roc20[i] > roc20[i - 1]);
        if (!volOk) dbg.fail.vol++;
        if (!aggOk) dbg.fail.agg++;
        if (!volStepOk) dbg.fail.volStep++;
        if (!flipOk) dbg.fail.flip++;
        if (!dispOk) dbg.fail.disp++;
        if (!candleOk) dbg.fail.candle++;
        if (!rocTurnOk) dbg.fail.roc++;
        if (!(volOk && aggOk && volStepOk && flipOk && dispOk && candleOk && rocTurnOk)) return null;

        // A VALID REJECTION OPENS A CONTEXT, IT DOES NOT ARM THE ENTRY YET. The FVG is created by
        // the DISPLACEMENT leg, which typically runs for a bar or two AFTER the rejection — so
        // requiring the gap to be present on the rejection bar itself (the first cut of this) missed
        // the pattern almost everywhere. The context holds the sweep wick (the stop), the level (a
        // close back beyond it invalidates the whole idea), and a short window for the gap to form.
        dbg.contexts++;
        return { side, levelKind: info.levelKind, level: info.level, extreme: info.extreme, expire: i + C.ctxWait };
      };

      /** findFvg(side, i, a14) — the 3-bar imbalance the displacement left behind, ending at bar i.
       * Bearish gap: bar[a].low > bar[a+2].high. Bullish gap: bar[a].high < bar[a+2].low. */
      const findFvg = (side, i, a14) => {
        for (let a = Math.max(0, i - 3); a <= i - 2; a++) {
          if (side === 'SHORT') {
            const gap = bars[a].l - bars[a + 2].h;
            if (gap > 0 && (a14 == null || gap >= C.fvgMinAtr * a14)) return { lo: bars[a + 2].h, hi: bars[a].l };
          } else {
            const gap = bars[a + 2].l - bars[a].h;
            if (gap > 0 && (a14 == null || gap >= C.fvgMinAtr * a14)) return { lo: bars[a].h, hi: bars[a + 2].l };
          }
        }
        return null;
      };

      // ---- the forward pass: only bars[0..i] are ever read ----
      const sig = new Array(n).fill(null);
      let curKey = null, runHi = -Infinity, runLo = Infinity, runHiAt = -1, runLoAt = -1;
      let pivHi = [], pivLo = [], armed = null, pending = null, ctx = null;
      for (let i = 0; i < n; i++) {
        if (sess.key[i] !== curKey) {
          curKey = sess.key[i];
          runHi = -Infinity; runLo = Infinity; runHiAt = -1; runLoAt = -1;
          pivHi = []; pivLo = []; armed = null; pending = null; ctx = null;
        }
        const b = bars[i];
        const mo = minutesSinceOpen(b.t);

        // ---- step 5 continued: return into the armed FVG zone (step 6 gates the entry) ----
        if (armed && i >= armed.expire) armed = null;
        if (armed) {
          const z = armed;
          let hit = false, entryPx = null;
          if (z.side === 'SHORT') { if (b.h >= z.lo && b.l <= z.hi) { hit = true; entryPx = z.lo; } }
          else { if (b.l <= z.hi && b.h >= z.lo) { hit = true; entryPx = z.hi; } }
          if (hit) {
            const risk = z.side === 'SHORT' ? z.stop - entryPx : entryPx - z.stop;
            if (!(risk > 0)) dbg.fail.risk++;
            if (!(mo >= 15 && mo <= 355)) dbg.fail.time++;
            if (risk > 0 && mo >= 15 && mo <= 355 && i + 1 < n) {
              dbg.entries++;
              sig[i] = {
                side: z.side, entry: entryPx, stop: z.stop, rewardRisk: C.rr, setup: id,
                evidenceTags: {
                  rangeRatio: avgRange[i] > 0 ? +(b.h - b.l) / avgRange[i] : null,
                  volRatio: avgVol[i] > 0 ? +(b.v / avgVol[i]) : null,
                  flowSource: 'proxy(volume/range) — executed delta unavailable',
                },
                reason: 'swept ' + z.levelKind + ' -> rejection at the wick -> FVG retrace entry (' + z.side + ', flow=proxy)',
              };
            }
            armed = null;
          }
        }

        // ---- step 5: from the rejection CONTEXT, look for the FVG the displacement leaves behind.
        // The context survives up to ctxWait bars, but a close back BEYOND the swept level means the
        // rejection failed and the idea is void — the sweep was not a trap, it was a real break.
        // (Strategy 2 bets on exactly that break; this one must not take its own opposite's trade.) ----
        if (ctx) {
          if (i > ctx.expire) ctx = null;
          else if (ctx.side === 'SHORT' ? b.c > ctx.level : b.c < ctx.level) ctx = null;
        }
        if (ctx && !armed) {
          const a14 = IND.atr(bars, 14, i);
          const zone = findFvg(ctx.side, i, a14);
          if (zone) {
            // ---- STOP PLACEMENT (Strategy 3 stop-placement variant, now with a swept WIDTH) ----
            // The sweep wick extreme is the STRUCTURAL invalidation and remains the stop basis.
            // The original (extreme ± 0.05%) is tight by construction — that is the hypothesis being
            // tested — but when the implied risk from the current close to that extreme is under the
            // MIN_RISK_PCT floor (0.15%, the same degenerate-risk threshold the harness uses), the
            // stop is pushed out to that floor so it does not sit inside the spread and the noise.
            // This is the focused stop-placement change only: entry conditions, sweep/FVG/aggression
            // logic, and the target are untouched. The entry fills later on the FVG retrace; the
            // harness re-anchors risk from the real fill, so the risk guard at signal time reflects
            // the widened stop.
            const MIN_RISK_PCT = 0.15;   // matches the harness degenerate-risk floor
            const cur = bars[i];
            const armPrice = cur.c;      // bar-local proxy for where the eventual FVG retrace entry will sit
            // the WIDTH: how far beyond the wick the stop sits (fraction of price, or ATR x mult)
            const a14arm = C.stopBufferAtrMult > 0 ? IND.atr(bars, 14, i) : null;
            const buf = (a14arm != null && a14arm > 0)
              ? a14arm * C.stopBufferAtrMult
              : Math.max(0, ctx.extreme * C.stopBuffer);
            let stop = ctx.side === 'SHORT' ? ctx.extreme + buf : ctx.extreme - buf;
            const rawRiskPct = armPrice > 0 ? (Math.abs(armPrice - stop) / armPrice) * 100 : 0;
            if (rawRiskPct < MIN_RISK_PCT) {
              // widen the stop so risk is at least MIN_RISK_PCT of the arm-time price
              const minRisk = armPrice * (MIN_RISK_PCT / 100);
              stop = ctx.side === 'SHORT' ? armPrice + minRisk : armPrice - minRisk;
            }
            armed = { side: ctx.side, lo: zone.lo, hi: zone.hi, stop, expire: i + C.fvgWait, levelKind: ctx.levelKind };
            dbg.fvgArmed++;
            ctx = null;
          }
        }

        // ---- steps 1-3: detect a sweep of a liquidity pool, and its rejection ----
        const highLevels = [];
        const lowLevels = [];
        if (priorHi[i] != null) highLevels.push({ p: priorHi[i], k: 'prior-day high' });
        if (priorLo[i] != null) lowLevels.push({ p: priorLo[i], k: 'prior-day low' });
        if (isFinite(runHi) && i - runHiAt >= SESSION_STALE) highLevels.push({ p: runHi, k: 'session high' });
        if (isFinite(runLo) && i - runLoAt >= SESSION_STALE) lowLevels.push({ p: runLo, k: 'session low' });
        for (const ph of pivHi) highLevels.push(ph);
        for (const pl of pivLo) lowLevels.push(pl);

        // a sweep already beyond a level, waiting for the close back inside (the "brief close beyond")
        if (pending) {
          pending.age++;
          if (pending.side === 'SHORT') {
            if (b.h > pending.extreme) pending.extreme = b.h;
            if (b.v > pending.vol) pending.vol = b.v;
            if (b.h - b.l > pending.range) pending.range = b.h - b.l;
            if (b.c < pending.level) { if (!armed && !ctx) ctx = tryArm('SHORT', pending, i); pending = null; }
            else if (pending.age >= 2) pending = null;
          } else {
            if (b.l < pending.extreme) pending.extreme = b.l;
            if (b.v > pending.vol) pending.vol = b.v;
            if (b.h - b.l > pending.range) pending.range = b.h - b.l;
            if (b.c > pending.level) { if (!armed && !ctx) ctx = tryArm('BUY', pending, i); pending = null; }
            else if (pending.age >= 2) pending = null;
          }
        }

        if (!armed && !ctx) {
          let done = false;
          for (const L of highLevels) {
            if (b.h > L.p) {
              dbg.pierceHigh++;
              if (b.c < L.p) { ctx = tryArm('SHORT', { level: L.p, levelKind: L.k, extreme: b.h, vol: b.v, range: b.h - b.l, prevVol: i >= 1 ? bars[i - 1].v : 0 }, i); }
              else { pending = { side: 'SHORT', level: L.p, levelKind: L.k, extreme: b.h, age: 0, vol: b.v, range: b.h - b.l, prevVol: i >= 1 ? bars[i - 1].v : 0 }; dbg.pending++; }
              done = true;
              break;
            }
          }
          if (!done) {
            for (const L of lowLevels) {
              if (b.l < L.p) {
                dbg.pierceLow++;
                if (b.c > L.p) { ctx = tryArm('BUY', { level: L.p, levelKind: L.k, extreme: b.l, vol: b.v, range: b.h - b.l, prevVol: i >= 1 ? bars[i - 1].v : 0 }, i); }
                else { pending = { side: 'BUY', level: L.p, levelKind: L.k, extreme: b.l, age: 0, vol: b.v, range: b.h - b.l, prevVol: i >= 1 ? bars[i - 1].v : 0 }; dbg.pending++; }
                break;
              }
            }
          }
        }

        // ---- roll the session extremes and the confirmed-pivot pools forward (AFTER the checks, so
        // the current bar can never be its own liquidity level) ----
        if (b.h > runHi) { runHi = b.h; runHiAt = i; }
        if (b.l < runLo) { runLo = b.l; runLoAt = i; }
        if (i >= 2 && isPivotHigh[i - 2]) {
          pivHi.push({ p: bars[i - 2].h, k: 'swing high', i: i - 2 });
          if (pivHi.length > PIVOT_KEEP) pivHi.shift();
        }
        if (i >= 2 && isPivotLow[i - 2]) {
          pivLo.push({ p: bars[i - 2].l, k: 'swing low', i: i - 2 });
          if (pivLo.length > PIVOT_KEEP) pivLo.shift();
        }
      }
      return { sig, dbg };
    },
    at(bars, i, st) { return st.sig[i] || null; },
  };
}

/**
 * The headline config, and the honest state of Strategy 3.
 *
 * The sweep script (.freebuff/sweep-liquidity.js) chooses a config on the DEVELOPMENT portion of the
 * tape only (14 dev sessions); the last 7 sessions are out-of-sample and are read after the choice is
 * frozen. The config below is what dev selection actually returns: agg 3x, candle none, 2R target.
 *
 * ============================================================================
 * SIDE-NAMING BUG — READ THIS BEFORE TRUSTING ANY OLDER NUMBER FOR THIS STRATEGY.
 *
 * An earlier revision of this comment reported "OOS +0.201R, bootstrap [0.096, 0.316], clears both
 * guards" and labelled the strategy ESTABLISHED. That was an artifact, not a result.
 * makeLiquiditySweep labelled its long side 'LONG'. The shared simulator resolved the direction with
 * `cand.side === 'BUY' ? 1 : -1`, so EVERY long candidate was simulated as a SHORT — short at a bar
 * that had just sold off, so its stop sat above the entry and its target below it, and the pessimistic
 * intrabar fill resolves that as an immediate +1.00R gross. Roughly a third of the trade set was this
 * fabrication, and it was enough to flip the sign of the average.
 *
 * Fixed: both sides now use 'BUY'/'SHORT' as the simulator expects, and the simulator refuses an
 * unrecognised side (BT.sideSign returns 0) instead of silently defaulting it to short.
 * .freebuff/test-github-strategies.js carries a regression check that every registered strategy
 * reports a side the simulator can resolve.
 * ============================================================================
 *
 * STOP-PLACEMENT VARIANT (research variant). The stop is the sweep wick extreme ± a buffer; when the
 * implied risk from the arm-time close to that extreme is under the 0.15% degenerate-risk floor (the
 * same threshold the harness uses), the stop is widened to the floor so it does not sit inside the
 * spread and the noise. The entry conditions, sweep/FVG/aggression logic, and the target are
 * untouched — ONLY the stop placement changed.
 *
 * ---- THE STOP WIDTH AND THE TARGET, MEASURED HONESTLY ----
 * `.freebuff/sweep-stopwidth.js` → data/liquidity_stopwidth_grid.json. 498 symbols, 0.10% round trip,
 * 7 OOS sessions, targets run as separate replay passes over one signal stream:
 *
 *   width (498 symbols)   refusal  med risk%   oos grossR  oos costR   oos NET 1R / 1.5R / 2R
 *   wick + 0%               22.8%     0.30%      -0.01       0.34    -0.372 / -0.346 / -0.328
 *   wick + 0.05% (previous) 12.5%     0.32%       0.04       0.32    -0.296 / -0.276 / -0.282
 *   wick + 0.10%             5.0%     0.35%       0.05       0.29    -0.263 / -0.241 / -0.226
 *   wick + 0.20%             0.1%     0.44%       0.03       0.23    -0.188 / -0.202 / -0.201
 *   wick + 0.30%             0.1%     0.54%       0.03       0.18    -0.148 / -0.145 / -0.163
 *   wick + ATR(14)x0.25     18.7%     0.31%       0.03       0.32    -0.309 / -0.285 / -0.280
 *
 * READ IT AS A MECHANISM, NOT A TUNING. The stop-width lever is REAL and it works exactly as the
 * cost model says: widening the stop from the wick to wick + 0.30% halves cost-in-R (0.34 -> 0.18)
 * and collapses the degenerate-risk refusal rate (22.8% -> 0.1%). Gross R over the same cells is
 * FLAT (0.00-0.06) — so the entry logic was never where the money was, and equally, no stop width
 * creates an edge that was not already there. The gross never covers the cost at any width, which is
 * why every measured cell is negative. The ATR(14)-on-1-minute-bars cell is a NEAR NO-OP (0.31%
 * median risk): one minute of ATR is far too small a unit for a stop width on this tape, and the cell
 * is kept in the grid so that is visible rather than quietly dropped.
 *
 * Dev-selected cell: wick + 0.30% at 2R — dev -0.139R / 5,544 trades, OOS -0.163R / 2,728 trades,
 * bootstrap CI [-0.250, -0.063] over the 7 held-out sessions. NEGATIVE, and the CI excludes zero on
 * the wrong side. (At that width the three targets are indistinguishable on OOS, -0.145 to -0.163R;
 * dev prefers 2R over 1.5R by 0.002R, i.e. by noise. The config below takes the dev-selected cell.)
 *
 * VERDICT: NOT ESTABLISHED. Three independent checks agree, and none of them is the dev/OOS split:
 *   1. Walk-forward (`--folds=5`, expanding, 3 test sessions per fold): 0/5 folds held. Every fold's
 *      test mean is negative (-0.092 to -0.162R) — not one rolling split agrees with the story.
 *   2. Tail decomposition of the dev-selected cell on OOS: mean -0.163R, median -1.062R, 63.5% of
 *      trades negative, MFE median 0.86R (only 45% of trades ever reach +1R). Dropping the top 1% of
 *      winners makes it worse (-0.183R), so the result is not a few big winners carrying a flat book.
 *   3. Entry-config sweep (`.freebuff/sweep-liquidity.js` → data/liquidity_sweep_sweep.json, run at
 *      the ORIGINAL wick + 0.05% stop): the dev-selected entry config is negative OOS at -0.282R /
 *      2,833 trades, CI [-0.336, -0.223]. Matching the w005@2R cell of the grid above, as it should.
 *
 * THE LAST UNEXPLORED LEVER IS NOW CLOSED — THE MIN-STOP GATE (tested 2026-09-27). The one lever the
 * width grid could NOT reach was the cost ratio itself: refuse a setup whose STRUCTURAL stop is nearer
 * than some absolute % of price (the stop is never moved — only which setups are taken changes). The
 * identity it targets is exact, `costR = costPct / riskPct`, and at gate 1.0% the cost term DOES fall
 * as promised (0.177R -> 0.080R). But gross falls faster than cost rises: +0.028R ungated, +0.001R at
 * 0.5%, -0.038R at 1.0%, -0.131R at 2.0% — so net never crosses zero, and the best cell keeps 10.8% of
 * the stream. Dev-selected gate 1.0% reads OOS -0.132R over 1,494 trades, CI [-0.192, -0.076], and 0 of
 * 12 walk-forward folds held. MECHANICAL REASON, and it is not noise: a stop >= 1% of price on a
 * 1-minute name means the invalidation is far away because the move was ALREADY EXTENDED, so the same R
 * multiple is a far larger price move — MFE median shrinks from 0.9R to 0.6R and the share reaching 1R
 * falls from 45% to 33%. The gate selects a different and WORSE population, not the same signal cheaper.
 * `.freebuff/sweep-mingate.js` -> data/liquidity_mingate_grid.json.
 *
 * RETIRED, ON THE PRE-REGISTERED RULE: this exact config (and the gate on top of it) is the end of the
 * line for the current exit design. It comes back only with NEW INFORMATION — real executed orderflow
 * (Strategy 1's capture) to sharpen the sweep DETECTION, not another filter on the exit.
 *
 * WHAT WOULD CHANGE THE VERDICT is more tape, not more conditions: 7 OOS sessions is the entire
 * out-of-sample sample, and this strategy's gross is small enough that the sign of the mean is at the
 * mercy of a handful of sessions. No new filters have been added on top of a negative result.
 * ============================================================================
 */
const liquiditySweep = makeLiquiditySweep({ aggMult: 3.0, candleReq: 'none', rr: 2, stopBuffer: 0.003 });

// ===========================================================================
// STRATEGY 2 (locked v2) — orbRetest: OPENING RANGE BREAKOUT + VWAP RETEST.
//
// "Don't buy the breakout. Buy the successful retest." The locked specification is a LAYERED stack
// of distinct CONDITIONS, not one blended score, and the whole point is to measure each layer's
// INCREMENTAL value rather than assume more confirmation is better:
//
//   TEST A  ORB only                          -> conditions [S1]
//   TEST B  ORB + VWAP                        -> [S1, VWAP]
//   TEST C  ORB + VWAP + retest               -> [S1, VWAP, S2]
//   TEST D  ORB + VWAP + retest + participation + ROC -> [S1, VWAP, S2, VOL, ROC]
//
// SIGNAL LABELS. S1 is the opening-range BREAKOUT condition; S2 is the RETEST+CONFIRMATION
// condition. A candidate therefore reports `signalLabel` as 'BUY S1' (breakout entry) or
// 'BUY S1+S2' (retest entry) — the strategies are kept SEPARATE and labelled, never merged into an
// opaque "BUY". The full condition set rides along in `evidenceTags.conditions`.
//
// LOCKED PARAMETERS (frozen before the first run, per the spec):
//   opening range 09:15-09:30 · no new entries after 14:45 · square-off 15:15 · structural stop
//   must be 0.15%-3.00% of entry (the shared harness refuses and counts anything outside) ·
//   participation thresholds 1.0x / 1.25x / 1.5x / 2.0x (selected on DEV only) · targets 1R/1.5R/2R.
//
// NO LOOKAHEAD. The opening range is frozen at 09:30; the breakout is judged on a COMPLETED 5-minute
// candle (the bar at a 5-minute boundary reads the close of the 5m bucket that just finished); the
// signal is known only at the close of the bar that produces it. `init()` precomputes the plan in a
// forward pass so `at()` is a pure lookup — no spray of mutable state that would answer differently
// depending on call order.
//
// ADAPTATION: the spec says ROC 10s / 20s. This tape is 1-MINUTE bars, so ROC is measured over 10
// and 20 BARS (10/20 minutes) and labelled a proxy — the second-scale ROC lives in the live tick
// board, not in a historical OHLCV file. One entry per session, so the layers cannot be counted
// twice in a minute.
//
// ---------------------------------------------------------------------------
// CORRECTION, TWICE OVER (2026-09-27): NEITHER EARLIER LAYER TABLE IS USABLE — AND THE "FLIP" IS NOT ONE.
// (1) The pre-fix run (`.freebuff/orb-full.out`, 21:14) read B→C at OOS −0.075R and the retest layer was
// written off as falsified. (2) The post-fix run (`.freebuff/orb-retest-full.out`, 00:46) read B→C
// +0.013R / C→D@2x +0.040R, and that flip was briefly recorded here as the corrected result. BOTH are
// withdrawn: on the current code the same question emits 6-7x MORE candidates (Test A: 106,711 signals
// / 94,058 trades against 18,162 / 15,585), so the 00:46 table came from a code state that has since
// been fixed. Which state is right is settled WITHOUT shared code by `.freebuff/probe-orb-counts.js`,
// which re-derives Test A straight from the raw tape (OR = the 09:15-09:29 extreme; breakout = a
// 5-minute bucket close beyond it by 14:45, once per session): 1,020 of 1,130 sessions-with-OR = 90.3%,
// against the strategy's 1,014 = 89.7%, per-symbol within ~10. The CURRENT rate is the correct one; the
// 00:46 rate (~6% of sessions) was the broken one. It was not a tape change — `liquiditySweep`'s counts
// are byte-identical across the two code states (60,571 signals / 7,141 refusals at w005 in the 00:13
// width grid and in the 12:0x gate run).
// WHAT THE VERIFIED TABLE SAYS (OOS, dev-selected participation D@1x @2R): A→B +0.000 · B→C −0.041 ·
// C→D@1x +0.008. The retest layer does NOT add value on this tape — the old verdict was right by
// accident, and it is now right by measurement. The stack's gross is still POSITIVE and real (+0.052R at
// C, +0.046R at D@1x) and only the COST erases it: costR = costPct / riskPct, and this entry's
// structural stop is the retest pullback extreme — 0.29% of price at the median — so a 0.10% round trip
// costs 0.345R per trade. `data/orb_retest_gate.json`.
//
// THE MIN-STOP GATE RESULT (pre-registered before the run, measured the same day): the gate removes 56%
// of the loss and cannot close it. Gate 0.5% (dev-selected, keeping 23.8% of signals) → OOS −0.132R over
// 3,472 trades against −0.299R ungated; cost 0.345R → 0.145R; gross 0.046R → 0.012R; **12/12 expanding
// walk-forward folds improved on their own ungated control** (median +0.144R, worst +0.06R) — the first
// axis in this project to clear the fold rule — yet net stays negative at every eligible threshold, and
// the cells where break-even arithmetic demands the gate lives (≥1.0%) keep ≤3.1% of the book and are
// ineligible under the coverage floor. The 2.0% cell's +0.351R over 31 OOS trades is noise, not a
// result. AND GROSS FALLS AS THE GATE RISES (+0.046 → +0.012 → −0.018): wide structural stops select a
// WORSE population, not the same signal cheaper. At a 0.05% round trip the frozen cell is still −0.066R,
// and NSE cash equity does not trade that cheap — so no gate fixes a cost that exceeds the gross.
// Under the gate the retest step turns +0.018R OOS (from −0.041R): its failure was partly a
// STOP-POPULATION effect, not purely a signal failure. Next lever: entry/exit structure (gross), not cost.
// ===========================================================================

/** fiveMinSeries(bars) — completed-5m-bucket features, without lookahead. A bucket [mo-5, mo) is
 * only CLOSED at the bar whose minute is exactly `mo`, and its close is the prior bar's close. */
function fiveMinSeries(bars) {
  const n = bars.length;
  const isClose = new Array(n).fill(false);
  const bucketClose = new Array(n).fill(null);
  const bucketVol = new Array(n).fill(null);
  const bucketLow = new Array(n).fill(null);
  const bucketHigh = new Array(n).fill(null);
  const avgBucketVol = new Array(n).fill(null);
  const hist = [];
  for (let i = 0; i < n; i++) {
    const mo = minutesSinceOpen(bars[i].t);
    if (mo >= 20 && mo % 5 === 0 && i > 0) {
      let v = 0, lo = Infinity, hi = -Infinity;
      for (let j = Math.max(0, i - 5); j <= i - 1; j++) {
        v += bars[j].v;
        if (bars[j].l < lo) lo = bars[j].l;
        if (bars[j].h > hi) hi = bars[j].h;
      }
      isClose[i] = true;
      bucketClose[i] = bars[i - 1].c;
      bucketVol[i] = v;
      bucketLow[i] = lo;
      bucketHigh[i] = hi;
      if (hist.length >= 6) {
        let s = 0;
        for (let k = hist.length - 6; k < hist.length; k++) s += hist[k];
        avgBucketVol[i] = s / 6;
      }
      hist.push(v);
    }
  }
  return { isClose, bucketClose, bucketVol, bucketLow, bucketHigh, avgBucketVol };
}

/**
 * barMinutes(b, shapeKnown) — minutes past IST midnight for a bar in EITHER shape.
 *
 * An exit POLICY is handed the bars the simulator is walking, and the runners hand it ARRAY bars
 * while this strategy's own code reads OBJECT bars. `bb[j].t` on an array bar is undefined,
 * `minutesSinceOpen(undefined)` is NaN, and `NaN >= 360` is false — so the 15:15 square-off silently
 * never fired and trades ran on into the next session's bars. A dead exit rule is not a small thing:
 * it changes the measured holding time and every outcome that depended on it. The policies read the
 * timestamp through this helper so the rule survives whichever shape arrives.
 */
function barMinutes(b) {
  const t = Array.isArray(b) ? b[0] : b.t;
  return minutesSinceOpen(t);
}

function makeOrbRetest(cfg) {
  const C = Object.assign({
    useVwap: false, useRetest: false, useParticipation: false, useRoc: false,
    participMult: 1.25,
    rr: 2.0,
    retestTol: 0.0015,       // price returns to within 0.15% of the level = the retest
    maxPenetration: 0.006,   // a close more than 0.6% through the level destroys the breakout
    confirmMaxBars: 30,      // how long the confirmation-high break stays armed
    onePerDay: true,
    // STOP RULE. 'bucket' is the locked v2 rule: the stop is the breakout bucket's own extreme (or
    // the retest pullback's extreme), which is tight BY CONSTRUCTION and is the hypothesis this
    // strategy tests. 'range' is the REPO PORT's rule (algotrade/strategies/orb.py: stop = the
    // opposite side of the opening range) and exists ONLY so the two implementations can be run
    // with an identical stop and target for the ORB reconciliation — the same 5,365 losing trades
    // and the repo port's 56 winning ones were being compared as if they were one strategy when
    // they use different stops, different targets and (see reconcile-orb.js) different universes.
    // 'range' is never used by a locked test; every A-D row in data/orb_retest_tests.json ran with
    // the 'bucket' default.
    stopRule: 'bucket',
    id: 'orbRetest',
  }, cfg || {});
  const label = C.useRetest ? 'S1+S2' : 'S1';
  const cond = ['S1'].concat(C.useVwap ? ['VWAP'] : []).concat(C.useRetest ? ['S2'] : [])
    .concat(C.useParticipation ? ['VOL'] : []).concat(C.useRoc ? ['ROC'] : []);
  return {
    id: C.id,
    name: 'Opening Range Breakout + VWAP retest (Strategy 2 v2)',
    repo: 'user-plan (locked Strategy 2 v2 spec) — ORB continuation family',
    source: 'locked spec: OR 09:15-09:30 -> 5m breakout close -> VWAP -> retest -> confirmation-high break -> structural stop',
    exitSource: 'spec (structural stop below the pullback low / above the pullback high, target = an R multiple of that risk, 15:15 square-off policy)',
    adaptation: 'ROC measured over 10/20 BARS (the tape is 1-minute; the spec\'s 10s/20s ROC lives in the live tick board). One entry per session. Retest tolerance, max penetration and the confirmation window are fixed pre-run values, not tuned.',
    dependencies: { vwap: !!C.useVwap, retest: C.useRetest, participation: C.useParticipation ? C.participMult + 'x' : null, roc: !!C.useRoc, stopRule: C.stopRule, rr: C.rr },
    conditions: cond,
    // the LABEL reads the way a trader says it: 'BUY S1' / 'SELL S1+S2'. It reads the SIDE'S SIGN
    // rather than comparing the label to 'BUY', so a stray third label can never render as the
    // opposite direction — the same string-comparison pattern that fabricated the S3 row.
    signalLabelOf(side) { return (sideSign(side) === 1 ? 'BUY' : 'SELL') + ' ' + label; },
    init(bars) {
      const n = bars.length;
      const sess = sessionIndex(bars);
      const or = rangeStorage(bars);
      const five = fiveMinSeries(bars);
      const vwap = IND.vwapSeries(bars);
      const roc10 = new Array(n).fill(null);
      const roc20 = new Array(n).fill(null);
      for (let i = 0; i < n; i++) {
        if (i >= 10 && bars[i - 10].c > 0) roc10[i] = (bars[i].c - bars[i - 10].c) / bars[i - 10].c;
        if (i >= 20 && bars[i - 20].c > 0) roc20[i] = (bars[i].c - bars[i - 20].c) / bars[i - 20].c;
      }

      const sig = new Array(n).fill(null);
      let curKey = null;
      // per-session state machine
      let phase = null, dir = null, level = null, retestLo = Infinity, retestHi = -Infinity;
      let awaitBreak = null, awaitLow = null, confirmBars = 0, traded = false;
      const EE = { rangeRatio: null, volRatio: null };
      for (let i = 0; i < n; i++) {
        if (sess.key[i] !== curKey) {
          curKey = sess.key[i];
          phase = null; dir = null; level = null; retestLo = Infinity; retestHi = -Infinity;
          awaitBreak = null; awaitLow = null; confirmBars = 0; traded = false;
        }
        if (traded && C.onePerDay) continue;
        const b = bars[i];
        const mo = minutesSinceOpen(b.t);

        // ---- the confirmation-high break: entry is the break of the CONFIRMATION candle's high/low
        if (phase === 'await') {
          confirmBars++;
          if (confirmBars > C.confirmMaxBars) phase = null;
          else {
            const hit = dir === 'BUY' ? b.h > awaitBreak : b.l < awaitLow;
            if (hit && mo <= 330 && i + 1 < n) {
              const entry = dir === 'BUY' ? awaitBreak : awaitLow;
              const stop = C.stopRule === 'range'
                ? (dir === 'BUY' ? or.orLo[i] : or.orHi[i])
                : (dir === 'BUY' ? retestLo : retestHi);
              const risk = dir === 'BUY' ? entry - stop : stop - entry;
              if (risk > 0) {
                sig[i] = {
                  side: dir, entry, stop, rewardRisk: C.rr, setup: C.id,
                  signalLabel: (dir === 'BUY' ? 'BUY' : 'SELL') + ' ' + label,
                  evidenceTags: Object.assign({}, EE, { conditions: cond.join('+'), flowSource: 'book-only (OHLCV): no executed footprint' }),
                  policy: { shouldExit: (j, bb) => barMinutes(bb[j]) >= 360 },   // 15:15 square-off
                  reason: 'breakout of OR ' + dir.toLowerCase() + ' -> retest held -> break of the confirmation candle ' + label,
                };
                traded = true;
              }
              phase = null;
            }
          }
          continue;
        }

        // ---- waiting for the retest after a KEPT breakout
        if (phase === 'breakout') {
          const destroyed = dir === 'BUY'
            ? b.c < level * (1 - C.maxPenetration)
            : b.c > level * (1 + C.maxPenetration);
          if (destroyed) { phase = null; continue; }
          if (dir === 'BUY') {
            if (b.l < retestLo) retestLo = b.l;
            const touched = b.l <= level * (1 + C.retestTol);
            const holds = b.c >= level && b.c >= b.o;
            if (touched && holds) {
              const rocOk = !C.useRoc || (roc10[i] != null && roc20[i] != null && roc10[i] > roc10[i - 1] && roc20[i] > roc20[i - 1]);
              const vwapOk = !C.useVwap || (vwap[i] != null && b.c > vwap[i]);
              if (rocOk && vwapOk) { phase = 'await'; dir = 'BUY'; awaitBreak = b.h; confirmBars = 0; }
            }
          } else {
            if (b.h > retestHi) retestHi = b.h;
            const touched = b.h >= level * (1 - C.retestTol);
            const holds = b.c <= level && b.c <= b.o;
            if (touched && holds) {
              const rocOk = !C.useRoc || (roc10[i] != null && roc20[i] != null && roc10[i] < roc10[i - 1] && roc20[i] < roc20[i - 1]);
              const vwapOk = !C.useVwap || (vwap[i] != null && b.c < vwap[i]);
              if (rocOk && vwapOk) { phase = 'await'; dir = 'SHORT'; awaitLow = b.l; confirmBars = 0; }
            }
          }
          continue;
        }

        // ---- flat: look for a COMPLETED 5m breakout of the frozen opening range
        if (!phase && five.isClose[i] && or.orHi[i] != null && or.orLo[i] != null) {
          const bc = five.bucketClose[i];
          let d = null;
          if (bc > or.orHi[i]) d = 'BUY';
          else if (bc < or.orLo[i]) d = 'SHORT';
          if (d && mo <= 330) {
            const vw = vwap[i - 1];
            const vwapOk = !C.useVwap || (vw != null && (d === 'BUY' ? bc > vw : bc < vw));
            const volOk = !C.useParticipation || (five.avgBucketVol[i] > 0 && five.bucketVol[i] >= C.participMult * five.avgBucketVol[i]);
            if (vwapOk && volOk) {
              const lvl = d === 'BUY' ? or.orHi[i] : or.orLo[i];
              if (C.useRetest) {
                phase = 'breakout'; dir = d; level = lvl; retestLo = Infinity; retestHi = -Infinity;
              } else {
                // TEST A / B: enter on the breakout itself, stopped at the breakout bucket's extreme
                // (stopRule 'range' swaps in the repo port's stop — reconciliation only, see above)
                const entry = b.c;
                const stop = C.stopRule === 'range'
                  ? (d === 'BUY' ? or.orLo[i] : or.orHi[i])
                  : (d === 'BUY' ? five.bucketLow[i] : five.bucketHigh[i]);
                const risk = d === 'BUY' ? entry - stop : stop - entry;
                if (risk > 0 && stop != null) {
                  sig[i] = {
                    side: d, entry, stop, rewardRisk: C.rr, setup: C.id,
                    signalLabel: (d === 'BUY' ? 'BUY' : 'SELL') + ' ' + label,
                    evidenceTags: Object.assign({}, EE, { conditions: cond.join('+'), flowSource: 'book-only (OHLCV): no executed footprint' }),
                    policy: { shouldExit: (j, bb) => barMinutes(bb[j]) >= 360 },
                    reason: '5m close beyond OR ' + (d === 'BUY' ? 'high' : 'low') + ' (' + label + ')',
                  };
                  traded = true;
                }
              }
            }
          }
        }
      }
      return { sig };
    },
    at(bars, i, st) { return st.sig[i] || null; },
  };
}

// ===========================================================================
// THE REGISTRY
// ===========================================================================

/**
 * STRATEGY_ONE_STATUS — DECIDED ONCE, IN WRITING, SO IT IS NOT RE-ARGUED PER CONVERSATION.
 *
 * HYPOTHESIS (the plan's Strategy 1, unchanged): control flips mid-candle — aggression is EXHAUSTED at
 * the point of control, the aggressive side stops getting filled, and price reverses. The only evidence
 * that can test it is EXECUTED volume by side AT PRICE (a footprint: delta per price level, POC).
 *
 * WHAT THE FEED ACTUALLY CARRIES (read from `angelone/marketFeed.js` `_parseBinary`, not assumed):
 * every tick has an exchange timestamp and lastTradedPrice; QUOTE/SNAP_QUOTE add lastTradedQuantity,
 * averageTradedPrice, volumeTradedToday, totalBuyQuantity, totalSellQuantity and OHLC; SNAP_QUOTE adds
 * lastTradedTimestamp, open interest and a 5-level depth slice. **Nothing in the packet is an executed
 * side.** There is no aggressor flag and no per-trade buy/sell tag at any subscription mode.
 *
 * SO WHAT ARE bq/sq (totalBuyQuantity / totalSellQuantity), the only per-tick quantity pair?
 * Two readings are possible and they are NOT equivalent:
 *   (A) TRADED-CUMULATIVE — cumulative traded quantity split by aggressor side. Then the per-tick
 *       increment IS executed volume by side, and the footprint is real.
 *   (B) RESTING-BOOK — the quantity pending on the bid side vs the ask side of the book (NSE
 *       publishes exactly this beside depth). Then an increment is liquidity added or pulled: a
 *       book-imbalance signal, NOT a trade. Calling it delta would be manufacturing a footprint.
 * The vendor's field names do not settle it, so this file does not claim either. The repo's own
 * `gb_scoring_v2/verify-feed.js` had already tagged the family VERIFY for exactly this reason
 * ("may be RESTING order quantity, not executed. Confirm before use").
 *
 * THE CAPTURE DECIDES IT, WITH A TEST WRITTEN IN ADVANCE: `.freebuff/verify-bqsq.js` reads the first
 * captured session and separates the two readings on three tests fixed before the data exists —
 * monotonicity (a cumulative traded counter cannot fall; a book total does), the Δv === q identity on
 * print-ticks with exactly one of Δbq/Δsq moving by Δv, and the increment budget
 * (Σpositive increments vs the session's traded volume). It self-tests against synthetic tapes of both
 * hypotheses (node .freebuff/verify-bqsq.js --selftest, 4/4), so it cannot return a verdict by accident.
 *
 * WIRING IS VERIFIED; THE TAPE IS NOT. `Server.js` arms the engine (`orderflow.start()` → capture +
 * replay + `tickBoard.onTickHook`), the board subscribes the live socket in `MODE.QUOTE`, and the
 * hook receives the raw parsed tick — the log line `[orderflow] hooked to the tick board` is the
 * runtime proof. But `data/orderflow/` is EMPTY: the directory was created 2026-09-26 00:33, after
 * the last session closed, so NOT ONE SESSION of ticks has ever been written. Nothing here can be
 * backtested against history either: the 1m OHLCV tape carries no side information at all.
 *
 * WHAT WOULD UNBLOCK IT (concrete, in order):
 *   1. run the app with the broker session active through a full 09:15-15:30, which writes
 *      data/orderflow/ticks-<day>.jsonl with {t, p, q, bq, sq, v} per tick;
 *   2. run `.freebuff/verify-bqsq.js` on that file. RESTING-BOOK ends the thread here — S1 stays NOT
 *      BUILT and a footprint built on the increment is refused, not relabelled. TRADED-CUMULATIVE is
 *      the only way through;
 *   3. if it clears step 2: `orderflow/footprint.js` + `orderflow/history.js` rebuild the per-price
 *      ladder from those files — verify the rebuilt day agrees with the live rows for that session;
 *   4. collect enough sessions that a dev/OOS split is meaningful (the OHLCV tape needed ~15 sessions
 *      before any verdict was even eligible), then code the entry and test it through THIS simulator.
 * Until step 4, the honest status of Strategy 1 is NOT BUILT / NOT TESTED — not "failed".
 */
const STRATEGY_ONE_STATUS = {
  built: false,
  tested: false,
  gatedBy: 'no captured sessions (data/orderflow is empty) AND the semantics of its only per-tick quantity pair (bq/sq) are unverified',
  hypothesis: 'control flips mid-candle: aggression exhausted at the POC, price reverses',
  evidenceRequired: 'executed volume by side at price (footprint delta + POC)',
  evidenceAvailable: 'per tick: exchangeTimestamp, lastTradedPrice, lastTradedQuantity, volumeTradedToday, totalBuyQuantity/totalSellQuantity (QUOTE mode). NO executed/aggressor side exists in the packet at any mode; whether bq/sq are TRADED-cumulative or RESTING-book is unresolved, and only the traded reading would make a per-tick increment an executed side',
  evidenceVerdict: 'run .freebuff/verify-bqsq.js on the first captured session — TRADED-CUMULATIVE => fundable; RESTING-BOOK => the increment is a book-imbalance proxy and S1 is not fundable from this feed',
  missing: 'captured sessions (the historical 1m OHLCV tape carries no side information), plus the bq/sq verdict above',
  proxyMislabeledAsIt: 'aggShortCircuit (an OHLCV breakout with an aggression proxy) — comparisons between it and Strategies 2/3 are NOT like-for-like and it must not be read as a test of this hypothesis',
};

/**
 * ZARATTINI / AZIZ / BARBON INTRADAY MOMENTUM — "Beat the Market" (SSRN 24-97), via the repo
 * AleksandarMilosavljevic/intraday-trading-strategy (the README's headline: Sharpe 1.34, 24%
 * annualised over OOS on SPY, 2016-2025, Alpaca data).
 *
 * TRANSCRIPTION SOURCE: the paper's own rules as implemented in this repo's common/market/zarattiniMomentum.js
 * (built and unit-tested separately, 16 tests), so the logic here is a lookup, not a re-derivation:
 *   * sigma_t = mean over the LAST 14 sessions of |C/O - 1| at that minute-of-day, current session excluded
 *   * upper_t = max(O_D, C_{D-1}) * (1 + sigma_t);  lower_t = min(O_D, C_{D-1}) * (1 - sigma_t)
 *   * long when the checkpoint close is ABOVE both the upper bound and VWAP; short below both
 *   * exit when price crosses VWAP against the position; otherwise hold to the session close
 *   * stop = the OPPOSITE noise bound (the structural invalidation the band itself defines)
 *
 * ADAPTATION (the source is 09:30-16:00 ET on SPY): this is the NSE session, so the 30-minute entry
 * checkpoints are shifted to 09:45, 10:15, ..., 15:15 IST and the session close is the tape's last
 * bar. The source's position sizing (2% daily vol target, 4x cap) is NOT ported — the harness trades
 * one plan at a time and sizes nothing. Expected to fire rarely: a checkpoint close outside a 14-day
 * mean absolute move AND beyond VWAP is the paper's premise, not a frequent event.
 */
const zarattiniMomentum = {
  id: 'zarattini_momentum',
  name: 'Zarattini/Aziz/Barbon intraday momentum',
  repo: 'AleksandarMilosavljevic/intraday-trading-strategy',
  source: 'SSRN 24-97 baseline (noise-area bounds from a 14-session sigma profile, VWAP exit)',
  exitSource: 'paper (VWAP cross against the position; hold to the close otherwise; stop = the opposite noise bound)',
  adaptation: 'NSE 09:15-15:29 session with the checkpoints shifted -45min (source 09:30-16:00 ET); position sizing not ported (the harness sizes nothing)',
  init(bars) {
    const sess = sessionIndex(bars);
    const n = bars.length;
    const mo = new Array(n), isCk = new Array(n).fill(false);
    const vwap = new Array(n).fill(null);
    const upper = new Array(n).fill(null), lower = new Array(n).fill(null);

    // pass 1 — minutes since the 09:15 open, running VWAP, and each session's checkpoint closes
    const days = [];                       // [{ key, open, lastClose, ck: Map<mo, close> }]
    let cur = null, curRec = null, cumPV = 0, cumV = 0;
    for (let i = 0; i < n; i++) {
      const m = minutesSinceOpen(bars[i].t);
      mo[i] = m;
      const d = sess.key[i];
      if (d !== cur) {
        cur = d;
        curRec = { key: d, open: bars[i].o, lastClose: null, ck: new Map() };
        days.push(curRec);
        cumPV = 0; cumV = 0;
      }
      curRec.lastClose = bars[i].c;
      if (m >= 30 && m <= 360 && m % 30 === 0) { isCk[i] = true; curRec.ck.set(m, bars[i].c); }
      const v = bars[i].v || 0;
      const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
      cumPV += tp * v; cumV += v;
      if (cumV > 0) vwap[i] = cumPV / cumV;
    }

    // pass 2 — sigma for each session's checkpoints, from the 14 sessions BEFORE it (no lookahead),
    // and the gap-aware bounds it produces at each checkpoint bar
    const sigmaByDay = new Array(days.length);
    for (let di = 0; di < days.length; di++) {
      const prior = di >= 14 ? days.slice(di - 14, di) : [];
      const m = new Map();
      if (prior.length === 14) {
        for (const k of days[di].ck.keys()) {
          let sum = 0, cnt = 0;
          for (const p of prior) { const c = p.ck.get(k); if (c != null && p.open > 0) { sum += Math.abs(c / p.open - 1); cnt++; } }
          if (cnt) m.set(k, sum / cnt);
        }
      }
      sigmaByDay[di] = m;
    }
    let di = -1, cd = null;
    for (let i = 0; i < n; i++) {
      if (sess.key[i] !== cd) { cd = sess.key[i]; di++; }
      if (!isCk[i]) continue;
      const sig = sigmaByDay[di] && sigmaByDay[di].get(mo[i]);
      if (sig == null || di < 1) continue;          // no full lookback, or no previous session to close against
      const open = days[di].open, prevClose = days[di - 1].lastClose;
      if (!(open > 0) || !(prevClose > 0)) continue;
      const hi = Math.max(open, prevClose), lo = Math.min(open, prevClose);
      upper[i] = hi * (1 + sig);
      lower[i] = lo * (1 - sig);
    }

    return { mo, isCk, vwap, upper, lower };
  },
  at(bars, i, st) {
    if (!st.isCk[i]) return null;
    const up = st.upper[i], lo = st.lower[i], vw = st.vwap[i];
    if (up == null || lo == null || vw == null) return null;
    const c = bars[i].c;
    const long = c > up && c > vw;
    const short = c < lo && c < vw;
    if (!long && !short) return null;
    const stop = long ? lo : up;                    // the opposite noise bound = the structural stop
    const risk = Math.abs(c - stop);
    if (!(risk > 0)) return null;
    return {
      side: long ? 'BUY' : 'SHORT',
      entry: c,
      stop,
      noTarget: true,                               // the source has no target: VWAP cross or the close
      setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: null },
      reason: long
        ? 'checkpoint close ' + ((c / up - 1) * 100).toFixed(2) + '% above the noise area and above VWAP'
        : 'checkpoint close below the noise area and VWAP',
      policy: {
        shouldExit: (j, bb) => {
          const arr = Array.isArray(bb[0]);
          const cj = arr ? bb[j][4] : bb[j].c;
          const vj = st.vwap[j];
          if (cj == null || vj == null) return false;
          return long ? cj < vj : cj > vj;
        },
      },
    };
  },
};

/**
 * TREND DAY — quantrocket-codeload/trend_day, `trend_day/trend_day.py` (Ernie Chan, Algorithmic
 * Trading). Read from the source file, not the README:
 *
 *   MIN_PCT_CHANGE = 0.06;  DB_TIMES = ['14:00:00', '15:59:00']
 *   signal  = (OPEN of the 14:00 bar - yesterday's session close) / yesterday's close
 *   long if > +6%, short if < -6%; entry = CLOSE of the 14:00 bar; exit = the 15:59 session close.
 *
 * TWO ADAPTATIONS, BOTH DECLARED: (1) the source universe is LEVERAGED ETFs and the threshold is
 * therefore tuned for ~2x instruments — it is ported UNCHANGED at 6%, so this measures "does the
 * rule transfer to NSE cash", not "what threshold works here"; scaling it would be a parameter the
 * source never had. (2) the source holds to the close with NO stop, but every candidate on this tape
 * must declare a geometric stop inside the 0.15-3.00% risk band (the harness's rule), so a 1.00%
 * stop carries the geometry and `noTarget` leaves the exit to the session, as in the source.
 */
const trendDay = {
  id: 'trend_day',
  name: 'Trend Day (late-day momentum to the close)',
  repo: 'quantrocket-codeload/trend-day',
  source: 'trend_day/trend_day.py (Ernie Chan, Algorithmic Trading) — 6% move by 14:00, hold to close',
  exitSource: 'repo (market close; the source places MOC orders)',
  adaptation: 'leveraged-ETF 6% threshold NOT rescaled for NSE cash; source has no stop, so a 1.00% structural stop is declared to satisfy the risk band and the exit stays the session close',
  init(bars) {
    const sess = sessionIndex(bars);
    const n = bars.length;
    const signal = new Array(n).fill(null);         // -1 short | +1 long | null
    let cur = null, lastClose = null, prevClose = null;
    for (let i = 0; i < n; i++) {
      const d = sess.key[i];
      if (d !== cur) { if (cur !== null) prevClose = lastClose; cur = d; lastClose = null; }
      lastClose = bars[i].c;
      // minutesSinceOpen counts from 09:15, so 14:00 IST is 285 minutes in
      if (minutesSinceOpen(bars[i].t) === 285 && prevClose != null && prevClose > 0) {
        const ret = (bars[i].o - prevClose) / prevClose;
        signal[i] = ret > 0.06 ? 1 : (ret < -0.06 ? -1 : 0);
        if (signal[i] === 0) signal[i] = null;
        if (signal[i] != null) signal[i] = signal[i] > 0 ? ret : ret;   // keep the return for the reason line
      }
    }
    return { signal };
  },
  at(bars, i, st) {
    const s = st.signal[i];
    if (s == null) return null;
    const c = bars[i].c;
    const long = s > 0;
    return {
      side: long ? 'BUY' : 'SHORT',
      entry: c,
      stop: long ? c * 0.99 : c * 1.01,             // declared geometry (the source has no stop)
      noTarget: true,                               // hold to the session close, as the source does
      setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: null },
      reason: (long ? 'up ' : 'down ') + (Math.abs(s) * 100).toFixed(1) + '% vs prior close at 14:00',
    };
  },
};

/**
 * INTRADAY ROC+VWAP — the repo's own scripts/backtestIntradayRoc.js, ported to the shared harness on
 * the 1-minute tape (the original ran 15-min bars). Rules, verbatim from the source:
 *
 *   BUY when ROC5 > +0.3% AND ROC15 > 0 AND volume(5-bar avg) >= 1.1x day-avg AND close > session VWAP.
 *   Exit: stop −0.6%, T1 +1.2%, T2 +2.4% (stop checked first), EOD square-off.
 *
 * THRESHOLDS ARE TIMEFRAME-DEPENDENT, and this is declared, not hidden: ROC5 > 0.3% over FIVE
 * 1-minute bars is a much weaker momentum bar than over five 15-minute bars, so the 1m port will
 * fire far more often than the 15m original. The sweep in this repo's own grid (minStop/stop-width
 * studies) showed what that does to costR. Measured as-is first; tightening is a separate cell.
 * LONG ONLY by definition: the source has no short side. It is here because the user asked for the
 * intraday ROC strategy measured alongside (and mixed with) the others.
 */
const intradayRoc = {
  id: 'intraday_roc',
  name: 'Intraday ROC+VWAP (repo\'s own)',
  repo: 'this repo — scripts/backtestIntradayRoc.js',
  source: 'ROC5>+0.3% & ROC15>0 & volX>=1.1 & close>VWAP; stop 0.6%, T1 1.2%, T2 2.4%',
  exitSource: 'repo (fixed bracket + EOD square-off)',
  adaptation: 'source ran 15-minute bars; ported to the 1-minute tape with thresholds UNCHANGED (ROC thresholds are timeframe-dependent — the 1m port fires more often, which the cost-in-R arithmetic will punish if the entries are not better)',
  init(bars) {
    const n = bars.length;
    const sess = sessionIndex(bars);   // one pass: per-bar session key, session start index, bars into session
    const roc5 = new Array(n).fill(null), roc15 = new Array(n).fill(null);
    const volX = new Array(n).fill(null), vwap = new Array(n).fill(null);
    let pv = 0, vv = 0, vDay = 0, lastKey = null;
    for (let i = 0; i < n; i++) {
      const into = sess.into[i];
      // ---- SESSION-CONFINED, BECAUSE THE SOURCE IS. backtestIntradayRoc.js groups the tape by DAY and
      // evaluates each day from its own bar 16, so roc5, roc15 and the day-average volume are all
      // WITHIN the session. Reading a 15-bar window across a boundary compares 09:15 today against
      // 15:29 yesterday — a different rule wearing the same name — so the windows are gated on `into`.
      if (sess.key[i] !== lastKey) { pv = 0; vv = 0; vDay = 0; lastKey = sess.key[i]; }
      if (into >= 5 && bars[i - 5].c > 0) roc5[i] = ((bars[i].c - bars[i - 5].c) / bars[i - 5].c) * 100;
      if (into >= 15 && bars[i - 15].c > 0) roc15[i] = ((bars[i].c - bars[i - 15].c) / bars[i - 15].c) * 100;
      // session VWAP and the RUNNING session day-average volume (the source's vols.slice(0,i+1)/(i+1)),
      // both reset at the session's first bar and both causal. Running sums keep init O(n): the first
      // cut re-summed 0..i for every bar, which is ~1.4e9 additions per symbol over this tape and made
      // a single-strategy full-tape run take hours.
      pv += bars[i].c * bars[i].v; vv += bars[i].v; vDay += bars[i].v;
      vwap[i] = vv > 0 ? pv / vv : bars[i].c;
      if (into >= 4) {
        const v5 = (bars[i].v + bars[i - 1].v + bars[i - 2].v + bars[i - 3].v + bars[i - 4].v) / 5;
        const avgDay = vDay / (into + 1);
        volX[i] = avgDay > 0 ? v5 / avgDay : null;
      }
    }
    return { roc5, roc15, volX, vwap };
  },
  at(bars, i, st) {
    const r5 = st.roc5[i], r15 = st.roc15[i], vx = st.volX[i], vw = st.vwap[i];
    if (r5 == null || r15 == null || vx == null || vw == null) return null;
    if (!(r5 > 0.3 && r15 > 0 && vx >= 1.1 && bars[i].c > vw)) return null;
    const entry = bars[i].c;
    return {
      side: 'BUY',
      entry,
      stop: entry * (1 - 0.6 / 100),
      rewardRisk: 2.0,                       // T1 at 1.2% = 2x the 0.6% stop; the target IS the plan
      setup: this.id,
      evidenceTags: { rangeRatio: null, volRatio: vx },
      reason: 'ROC5 ' + r5.toFixed(2) + '% volX ' + vx.toFixed(2) + ' above VWAP',
    };
  },
};

const STRATEGIES = [
  niftyTrend, orb, vwapReversion, emaRsi, bollinger, supertrend,
  aiVwapMomentum, aiBearishMomentum, aiMeanReversion, nifty50Ict,
  aggShortCircuit, liquiditySweep, zarattiniMomentum, trendDay, intradayRoc,
];

/**
 * NOT PORTED — recorded so the table can say why, instead of the entry silently vanishing.
 */
const NOT_PORTABLE = [
  {
    id: 'options_lab', repo: 'mevishalsonawane-ai/options-lab',
    reason: 'options/panel-IC project (iron condors, lot history, Android exporter): no directional intraday equity signal to port, and it needs an option chain and IV surface this feed does not carry. Its author also publicly retired the 90%+ win-rate claim, replacing it with a single-digit annual return net of costs.',
  },
  {
    id: 'orstack', repo: 'ORSTAC (crypto)',
    reason: 'not NSE, not equities: crypto fractal-ATR targets on Jan-May 2026 crypto data. Testing it on NSE 1m bars would measure a different instrument and prove nothing about either.',
  },
  {
    id: 'hftbacktest', repo: 'nkaz001/hftbacktest',
    reason: 'a backtest FRAMEWORK, not a strategy: queue-position fills, L2/L3 book modelling and feed/order latency, with live bots for Binance/Bybit. There is no signal to port, and its only advantage needs tick/book data this repo does not have — data/orderflow/ has never held a session, and this tape is 1-minute OHLCV. Worth revisiting once Strategy 1 capture has produced files.',
  },
  {
    id: 'trading_orb', repo: 'sam-bateman/trading-orb',
    reason: 'Opening Range Breakout on US equities — the same logic family as the `orb` row that is already ported and measured here, so a second port would be a duplicate row (the table collapses by source family, not by claim). Its 2016-2026 US numbers also cannot be reproduced on this tape, which is the only thing that would make the row meaningful.',
  },
  {
    id: 'morning_surge_short', repo: 'Morning-surge-short-Strategy / bank-nifty VWAP repos',
    reason: 'named in the conversation but no repository URL was supplied and no published win-rate number to quote. Named-but-unlinked entries cannot be ported: the transcription needs the actual source, and guessing the rules would measure my guess instead of the repo.',
  },
];

const byId = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

module.exports = { STRATEGIES, NOT_PORTABLE, byId, STRATEGY_ONE_STATUS, istMinutes, sessionIndex, atrSeries, adxSeries, htfTrendByBar, rollingVolumeRatio, minutesSinceOpen, makeLiquiditySweep, makeOrbRetest, fiveMinSeries };
