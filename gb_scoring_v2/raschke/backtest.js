/**
 * gb_scoring_v2/raschke/backtest.js — THE SIMULATOR THE RASCHKE FRAMEWORK AND THE GITHUB
 * STRATEGIES BOTH RUN THROUGH.
 *
 * WHAT IT IS. A single, honest execution model shared by the Raschke setups (setups.js) and the
 * ported external strategies (github/strategies.js), so a strategy's measured R is the same quantity
 * whichever module produced it. The contract is the candidate shape both produce:
 *
 *   { side: 'BUY'|'SHORT', entry, stop, rewardRisk, setup, [policy], [signalLabel], [evidenceTags], reason }
 *
 * AND the pessimistic intrabar assumption the framework states explicitly: when one bar contains both
 * the stop and the target, the STOP is assumed hit first. That is not an edge-flattening choice, it
 * is the only choice that does not invent intrabar order that the OHLCV tape cannot show.
 *
 * THE RISK BAND. MIN_RISK_PCT / MAX_RISK_PCT are declared here for documentation — the github
 * backtest applies them at signal time before calling simulate, so a candidate whose stop sits inside
 * the spread never reaches the simulator at all. They are kept here as the canonical definition of
 * what "degenerate risk" means for the whole framework.
 *
 * NO LOOKAHEAD. simulate() reads bars[i] (the signal bar) and bars[i+1..] (the holding bars) only.
 * The signal bar's C is used as the entry only when the candidate carries no explicit entry; otherwise
 * the candidate's own entry is used. Either way, the simulator never reads a bar before i to decide
 * what happened after i.
 */
const fs = require('fs');
const path = require('path');
const IND = require('./indicators');

const ROOT = path.resolve(path.join(__dirname, '..', '..'));
const DATA = path.join(ROOT, 'data', 'ohlcv_1m');

const MIN_RISK_PCT = 0.15;
const MAX_RISK_PCT = 3.0;
const COST_PCT = 0.10;

/**
 * sideSign(side) — +1 for a long, -1 for a short, 0 for anything this harness does not recognise.
 *
 * THIS FUNCTION EXISTS BECAUSE A ONE-LINE SIDE MAPPING SILENTLY INVERTED A WHOLE STRATEGY. The
 * simulator used `cand.side === 'BUY' ? 1 : -1`, so a candidate labelled 'LONG' — which is what
 * Strategy 3 emits — was simulated as a SHORT. A long plan's stop sits BELOW its entry, so with the
 * direction flipped the very first bar's high "hit the stop" and the trade closed instantly at
 * +1.00R gross: a fabricated win, on roughly a third of that strategy's trades, in the direction that
 * made it look like the best row in the table. Unknown labels are now REFUSED (0) instead of being
 * guessed at, and the outward labels are explicit rather than a default branch.
 */
function sideSign(side) {
  if (side == null) return 0;
  const u = String(side).toUpperCase();
  if (u === 'BUY' || u === 'LONG') return 1;
  if (u === 'SHORT' || u === 'SELL') return -1;
  return 0;
}

// ---------------------------------------------------------------------------
// the entry gate: the risk band PLUS the stop-distance / cost ratio
// ---------------------------------------------------------------------------

/**
 * stopPctOf(entry, stop) — the planned risk as a PERCENT of entry. The number the risk band and the
 * cost ratio are both stated in: `riskPct` for a 100.00 entry with a 99.65 stop is 0.35.
 */
function stopPctOf(entry, stop) {
  if (!(entry > 0) || !isFinite(stop)) return null;
  return (Math.abs(entry - stop) / entry) * 100;
}

/**
 * costRAt(riskPct, costPct) — cost-in-R, EXACTLY. The identity is a division, not an approximation:
 *
 *     cost fraction = costPct / 100        (0.10% round trip = 0.001 of price)
 *     risk fraction = riskPct / 100        (0.35% of price    = 0.0035)
 *     costR = cost fraction / risk fraction = (costPct / 100) / (riskPct / 100) = costPct / riskPct
 *
 * So a 0.35% structural stop pays 0.10 / 0.35 = 0.286R of cost per trade before the entry is even
 * judged, and a 2.5% stop pays 0.040R. `simulate()` computes the same quantity from the price
 * distance; this is the same number reachable from the plan alone, which is what a gate can act on
 * at signal time (the fill is not known yet).
 */
function costRAt(riskPct, costPct) {
  const c = costPct == null ? COST_PCT : costPct;
  if (!(riskPct > 0)) return null;
  return c / riskPct;
}

/** minStopPctForCostR(costPct, maxCostR) — the INVERSE: the stop distance a trade needs for cost to
 * stay at or under `maxCostR`. At 0.10% round trip, costR <= 0.10 needs a stop >= 1.00% of price;
 * costR <= 0.05 needs >= 2.00%. Stated here so a gate threshold can be read as a cost target
 * instead of a naked percentage. */
function minStopPctForCostR(costPct, maxCostR) {
  const c = costPct == null ? COST_PCT : costPct;
  if (!(maxCostR > 0)) return null;
  return c / maxCostR;
}

/**
 * entryGate(cand, entryPx, opts) — THE ENTRY GATE EVERY RUNNER SHARES, so the risk band and the
 * minimum-stop filter cannot drift between strategies or sweeps.
 *
 * `minStopPct` IS A SELECTION, NOT A STOP WIDENING. It does not move any stop: it refuses a plan
 * whose STRUCTURAL stop is nearer than the threshold. That distinction is the whole point. Widening
 * the stop changes the trade (better cost ratio, worse R:R on every winner) and was measured on S3's
 * width grid; gating keeps the geometry of the trades it takes and drops the ones whose cost is
 * oversized — a different experiment, so it gets a different axis.
 *
 * `opts`: { minRiskPct = MIN_RISK_PCT, maxRiskPct = MAX_RISK_PCT, minStopPct = 0, costPct = COST_PCT }
 * Returns { ok, riskPct, costR, reason } — a REASON, not a boolean, because "refused" now has four
 * different meanings and a runner that pools them cannot say which filter did the work.
 *   'ok'          the plan clears every band
 *   'minRiskPct'  stop inside the spread / degenerate risk (framework floor)
 *   'maxRiskPct'  stop so far away the plan risks more than the framework allows
 *   'minStopPct'  the gate under test refused it (cost-in-R too high for this stop distance)
 *   'noSide'      side label the harness does not recognise (never guessed at — see sideSign)
 *   'noPlan'      entry/stop not finite or entry === stop
 */
function entryGate(cand, entryPx, opts) {
  const o = opts || {};
  const minRiskPct = o.minRiskPct == null ? MIN_RISK_PCT : o.minRiskPct;
  const maxRiskPct = o.maxRiskPct == null ? MAX_RISK_PCT : o.maxRiskPct;
  const minStopPct = o.minStopPct == null ? 0 : o.minStopPct;
  const costPct = o.costPct == null ? COST_PCT : o.costPct;
  const side = cand ? sideSign(cand.side) : 0;
  if (!side) return { ok: false, riskPct: null, costR: null, reason: 'noSide' };
  const entry = entryPx != null && isFinite(entryPx) ? entryPx
    : (cand.entry != null && isFinite(cand.entry) ? cand.entry : null);
  const stop = cand.stop;
  if (entry == null || !(entry > 0) || !(stop > 0) || entry === stop) {
    return { ok: false, riskPct: null, costR: null, reason: 'noPlan' };
  }
  // the stop must sit beyond the entry in the LOSING direction — the same geometry the simulator
  // refuses, checked here so a sweep can count it instead of losing the trade silently
  if (side === 1 ? !(stop < entry) : !(stop > entry)) return { ok: false, riskPct: null, costR: null, reason: 'wrongSide' };
  const riskPct = stopPctOf(entry, stop);
  const costR = costRAt(riskPct, costPct);
  if (!(riskPct >= minRiskPct)) return { ok: false, riskPct, costR, reason: 'minRiskPct' };
  if (riskPct > maxRiskPct) return { ok: false, riskPct, costR, reason: 'maxRiskPct' };
  if (minStopPct > 0 && !(riskPct >= minStopPct)) return { ok: false, riskPct, costR, reason: 'minStopPct' };
  return { ok: true, riskPct, costR, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

function load(symbol) {
  const file = path.join(DATA, symbol + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = j.candles || j.bars || (Array.isArray(j) ? j : []);
    if (!Array.isArray(rows) || !rows.length) return null;
    return { candles: rows, symbol };
  } catch (e) { return null; }
}

function niftySeries() {
  const j = load('NIFTY');
  if (!j) return new Map();
  const m = new Map();
  for (const c of j.candles) {
    const t = toMs(c[0]);
    if (t == null) continue;
    m.set(t, +c[4]);
  }
  return m;
}

function toMs(ts) {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
    if (m) return Date.parse(m[1] + 'T' + m[2] + ':00+05:30');
    return Date.parse(ts);
  }
  return null;
}

function sessionOf(bar) {
  const t = Array.isArray(bar) ? bar[0] : bar.t;
  return IND.sessionKeyOf(toMs(t));
}

// ---------------------------------------------------------------------------
// the simulator
// ---------------------------------------------------------------------------

function simulate(bars, i, cand, costPct) {
  if (!Array.isArray(bars) || i < 0 || i >= bars.length - 1) return null;
  if (!cand || typeof cand.side !== 'string') return null;

  const cost = (costPct == null ? COST_PCT : costPct) / 100;
  const side = sideSign(cand.side);
  if (!side) return null;          // an unrecognised side is refused, never guessed at (see sideSign)
  const up = side === 1;

  // ---- BARS MAY ARRIVE IN EITHER SHAPE ----
  // The runners hand this simulator ARRAY bars ([t,o,h,l,c,v]) while the indicator strategies are
  // handed OBJECT bars (norm()'s {t,o,h,l,c,v}) — two views of one series. A caller may pass either,
  // and the exit policy callbacks below are called with the SAME array the loop is walking, so
  // reading `b[2]` on object bars (or `b.h` on array bars) silently yields undefined: the stop and
  // target comparisons then never fire, and a policy exit writes `undefined` into exitPx. That is a
  // silent wrong answer, not a crash, which is why the shape is probed ONCE here instead.
  const arrBars = Array.isArray(bars[0]);
  const BH = (b) => (arrBars ? b[2] : b.h);
  const BL = (b) => (arrBars ? b[3] : b.l);
  const BC = (b) => (arrBars ? b[4] : b.c);
  // ---- THE SESSION OF A BAR, FROM EITHER SHAPE ----
  // This used to be `String(b[0]).slice(0, 10)`, which is right for the tape's own bars
  // ("2026-09-25 09:15" → "2026-09-25") and WRONG for the object bars norm() hands the strategies:
  // those carry epoch milliseconds, and slicing the first 10 digits of a 13-digit number yields units
  // of one SECOND — so every bar looked like a new session, and every trade was closed on the bar after
  // the signal as an immediate square-off. The failure was silent because the trade still produced an
  // R (a pure-cost one). Both shapes now go through the same IST calendar the harness's session keys
  // use, so `BD(bars[i]) !== BD(bars[i + 1])` means a real session break in both.
  const BD = (b) => IND.sessionKeyOf(toMs(arrBars ? b[0] : b.t));

  const entry = cand.entry != null && isFinite(cand.entry) ? cand.entry : BC(bars[i]);

  // THE RE-ANCHORING RULE: risk is measured from the ACTUAL entry to the declared stop, and the
  // target is an R multiple of THAT risk — not of whatever distance the strategy assumed at signal
  // time. The runners pass the candidate's own entry, so the two coincide there; the rule matters
  // when a caller simulates the same plan from a different fill.
  const stop = cand.stop;
  if (entry <= 0 || stop <= 0 || entry === stop) return null;

  // ---- THE STOP MUST BE BEYOND THE ENTRY, IN THE LOSING DIRECTION ----
  // A long whose stop sits ABOVE its fill is not a plan: the first touch of that level is a PROFIT, and
  // the loop below credits it as a stop-out — booking exactly +1.0000R on the next bar. That is the
  // structural shape of BOTH fabrications this harness has produced: the liquiditySweep 'LONG' row, and
  // nifty50_ict, whose entry rule armed a retracement entry at whatever the bar closed at, even when
  // the pullback had already traded through the invalidation level the stop was built from. Measured on
  // a 6-symbol sample: 186 of 452 ICT trades had the stop on the wrong side, 270 booked +1.0000R with an
  // MFE of ZERO — a win the price path never offered — and without them the strategy's mean R is −1.105.
  // Refused here, so no strategy, runner or sweep can book it; the runners count it as its own refusal.
  if (up ? !(stop < entry) : !(stop > entry)) return null;

  const riskPx = Math.abs(entry - stop);
  const riskPct = (riskPx / entry) * 100;
  if (riskPct < MIN_RISK_PCT || riskPct > MAX_RISK_PCT) return null;

  const rr = cand.rewardRisk != null && isFinite(cand.rewardRisk) ? cand.rewardRisk : 1;
  // `noTarget: true` is how a TREND plan says "there is no fixed target — the exit is the trail, the
  // policy or the session". Without this flag a rewardRisk of 0 would put the target AT the entry and
  // every such trade would "exit" instantly at 0R, which is a fabricated result rather than a flat one.
  const hasTarget = !cand.noTarget && rr > 0;
  const target = up ? entry + riskPx * rr : entry - riskPx * rr;

  // `endOfData` and `squareOff` are DIFFERENT findings and must not share a code: one says the tape
  // ran out while the trade was still open (a data boundary), the other says the session ended and
  // the position was closed by the plan's own rule. Reporting both as "squareOff" hides a truncated
  // dataset behind a normal exit, which is exactly the kind of thing this harness exists to avoid.
  let held = 0, reason = 'endOfData', exitPx = entry;
  let finalStop = stop;                 // the stop as it actually stood when the trade left
  // ---- REDUNDANT EXCURSION STATISTICS, ON PURPOSE ----
  // mfeR/maeR are the trade's best and worst excursion in units of risk, read off the bars' own
  // high/low rather than off the exit logic. They do not feed any decision: they exist to make the
  // exit bookkeeping CHECKABLE. The liquiditySweep fabrication (+1.00R booked on longs resolved as
  // shorts) was caught by exactly this kind of redundant pair — a booked outcome that the price path
  // could not support — and no single statistic would have shown it. Invariants any consumer can
  // assert: grossR <= mfeR, grossR >= -maeR, target exits imply mfeR >= rewardRisk, stop exits imply
  // maeR >= the distance to the stop that actually stood.
  let mfeR = 0, maeR = 0;
  const ps = {};                        // policy state (a policy may need to remember a ratchet step)
  const start = i + 1;
  const day0 = BD(bars[i]);
  // ---- A TRADE IS NOT ENTERED ACROSS A SESSION BREAK ----
  // A candidate signalled on the final bar of a session fills on the NEXT session's first bar, and
  // the session rule below would then close it on that bar at the SIGNAL bar's close: a zero-minute
  // round trip that books exactly −costR, no matter what the strategy predicted. It counted as a
  // loss for every strategy whose signals cluster near the close (measured 1–2.3% of trades for
  // bollinger/ai_* on a 6-symbol sample, .freebuff/audit-metrics.js) and it inflated trade counts.
  // Refused here — the caller counts it — so no harness in this repo can book it.
  if (BD(bars[start]) !== day0) return null;
  for (let j = start; j < bars.length; j++) {
    // ---- A TRADE DOES NOT SURVIVE INTO THE NEXT SESSION ----
    // Both runners' method blocks state this as part of the model ("a trade must exit before its
    // session ends"), and the reason code `squareOff` exists for it. Without the check a late signal
    // runs on into the next session's bars, where a later day's stop or target closes it — which is
    // not the trade that was planned, and it showed up as a materially different holding time and
    // mean R between two harnesses running the SAME candidates.
    if (BD(bars[j]) !== day0) {
      reason = 'squareOff';
      exitPx = BC(bars[j - 1]);
      held = Math.max(1, (j - 1) - i);
      break;
    }
    held = j - i;
    const h = BH(bars[j]), l = BL(bars[j]), c = BC(bars[j]);
    if (h != null && l != null && isFinite(h) && isFinite(l)) {
      const fav = up ? (h - entry) / riskPx : (entry - l) / riskPx;
      const adv = up ? (entry - l) / riskPx : (h - entry) / riskPx;
      if (fav > mfeR) mfeR = fav;
      if (adv > maeR) maeR = adv;
    }
    // ---- A POLICY MAY MOVE THE STOP, BUT ONLY TO TIGHTEN IT ----
    // The ratchet (Supertrend line, Nifty-trend trail, break-even move) is part of the exit model
    // those repos define. It is clamped here so a policy cannot WIDEN the stop and quietly buy the
    // trade more room than the plan declared at signal time — tightening is the strategy's right,
    // loosening is not.
    if (cand.policy && cand.policy.stopAt) {
      const want = cand.policy.stopAt(j, bars, ps);
      if (want != null && isFinite(want)) finalStop = up ? Math.max(finalStop, want) : Math.min(finalStop, want);
    }
    // the pessimistic intrabar rule: when one bar contains both levels, the STOP is assumed first
    if (up ? l <= finalStop : h >= finalStop) { reason = 'stop'; exitPx = finalStop; break; }
    if (hasTarget && (up ? h >= target : l <= target)) { reason = 'target'; exitPx = target; break; }
    if (cand.policy && cand.policy.shouldExit && cand.policy.shouldExit(j, bars, ps)) {
      reason = 'policy exit'; exitPx = c; break;
    }
  }

  const grossR = up ? (exitPx - entry) / riskPx : (entry - exitPx) / riskPx;
  const costR = cost / (riskPct / 100);
  const netR = grossR - costR;
  const netPct = (netR * riskPct) / 100;

  return {
    R: +netR.toFixed(4),
    grossR: +grossR.toFixed(4),
    costR: +costR.toFixed(4),
    netPct: +netPct.toFixed(4),
    barsHeld: held,
    reason,
    riskPct: +riskPct.toFixed(3),
    // `finalStop` is the stop as it ended up (a trail may have moved it); `stop` stays the ORIGINAL
    // plan stop, because "what did this trade risk when it was taken" and "where did it leave" are
    // different questions and a report that conflates them cannot tell a trail from a stop-out.
    entry, stop, finalStop, target: +target.toFixed(2), exitPx: +exitPx.toFixed(2),
    trailed: finalStop !== stop,
    mfeR: +mfeR.toFixed(4), maeR: +maeR.toFixed(4),
  };
}

// ---------------------------------------------------------------------------
// forward returns (relative to NIFTY)
// ---------------------------------------------------------------------------

/**
 * forwardReturn(bars, i, horizonMinutes, niftyMap) — the symbol's move over the horizon, minus
 * NIFTY's, for the signal at bar i.
 *
 * THIS WAS THE 20-MINUTE JOB, NOT THE STRATEGIES. Both lookups below used to walk forward from the
 * FIRST bar / the FIRST map entry for every call:
 *   * `barAtOrAfter` scanned the symbol's bars (`toMs` on each) — ~7,000 string parses per call;
 *   * the NIFTY end-price loop scanned the 7,589-entry Map from the start, again per call.
 * With three horizons per trade and tens of thousands of trades that is well over a billion
 * operations for a run whose entire strategy work is ~3 minutes (measured: 167 ms/symbol for all 12
 * strategies, so 995 symbols = 2.8 min). Both are now BINARY SEARCHES over the same ordered data
 * with the same semantics (first bar at or after the target instant), which is ~13 probes instead of
 * ~7,000 scans. Same numbers, no other change.
 */
function forwardReturn(bars, i, horizonMinutes, niftyMap) {
  if (i < 0 || i >= bars.length - 1) return null;
  const startT = toMs(bars[i][0]);
  if (startT == null) return null;
  const endT = startT + horizonMinutes * 60000;
  const endC = barAtOrAfter(bars, endT);
  if (endC == null) return null;
  const startC = bars[i][4];
  if (!(startC > 0)) return null;
  const symRet = (endC - startC) / startC;
  const nStart = niftyMap.get(startT);
  if (nStart == null || nStart <= 0) return null;
  const nEnd = niftyAtOrAfter(niftyMap, endT);
  if (nEnd == null || nEnd <= 0) return null;
  const nRet = (nEnd - nStart) / nStart;
  return { raw: symRet, adjusted: symRet - nRet };
}

/**
 * timeIndex(bars) — the parse of every bar's timestamp, ONCE per bars array (WeakMap-keyed). A
 * malformed timestamp or an out-of-order tape disables the fast path, and the ORIGINAL linear scan
 * is used instead: the point of the change is speed, never a different answer on odd data.
 */
const _timeCache = new WeakMap();
function timeIndex(bars) {
  const hit = _timeCache.get(bars);
  if (hit) return hit;
  const ms = new Float64Array(bars.length);
  let parseable = true, sorted = true, prev = -Infinity;
  for (let i = 0; i < bars.length; i++) {
    const t = toMs(bars[i][0]);
    if (t == null) { parseable = false; ms[i] = NaN; continue; }
    ms[i] = t;
    if (t < prev) sorted = false;
    prev = t;
  }
  const idx = { ms, parseable, sorted };
  _timeCache.set(bars, idx);
  return idx;
}

/** niftyAtOrAfter(map, ts) — first close at or after ts, binary-searched over a once-built sorted
 * array; falls back to the original forward walk if the map is not in ascending order. */
let _niftySorted = null, _niftySortedFor = null;
function niftyAtOrAfter(niftyMap, ts) {
  if (_niftySortedFor !== niftyMap) {
    const a = Array.from(niftyMap.entries());
    let sorted = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] < a[i - 1][0]) { sorted = false; break; }
    _niftySorted = { a: sorted ? a : null, sorted };
    _niftySortedFor = niftyMap;
  }
  const S = _niftySorted;
  if (!S || !S.a) {
    for (const [t, c] of niftyMap) if (t >= ts) return c;
    return null;
  }
  const a = S.a;
  if (!a.length || ts > a[a.length - 1][0]) return null;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid][0] >= ts) hi = mid; else lo = mid + 1;
  }
  return a[lo][1];
}

/** barAtOrAfter(bars, ts) — the close of the first bar at or after ts. */
function barAtOrAfter(bars, ts) {
  const idx = timeIndex(bars);
  if (!idx.parseable || !idx.sorted) {
    for (let j = 0; j < bars.length; j++) {
      const t = toMs(bars[j][0]);
      if (t == null) continue;
      if (t >= ts) return bars[j][4];
    }
    return null;
  }
  const a = idx.ms;
  let lo = 0, hi = a.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] >= ts) { found = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return found >= 0 ? bars[found][4] : null;
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

function mean(arr) {
  if (!arr || !arr.length) return null;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function pct(arr, q) {
  if (!arr || !arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * mulberry32(seed) — a seeded PRNG. The bootstrap used Math.random(), which made the CI — and with
 * it the ESTABLISHED verdict — different on every run of the same data (measured |Δlo| up to 0.003
 * between two calls in one process, .freebuff/audit-metrics.js). A gate that cannot be reproduced is
 * not a gate, so the interval is now a deterministic function of the data and a fixed seed.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * sessionCI(bySession, opts) — the bootstrap interval over SESSIONS, on the SAME estimator as the
 * mean R that is actually reported.
 *
 * THE ESTIMATOR MATCHES NOW. The reported mean R is trade-weighted (every trade counts once), but
 * this interval used to resample the MEAN OF SESSION MEANS — a different statistic, in which a
 * session with 3 trades weighs as much as one with 300. A trade-weighted mean can sit outside its own
 * interval, and the audit found it doing so for strategies with uneven trades-per-session. Default is
 * now the CLUSTER bootstrap: resample sessions with replacement, POOL their trades, average over
 * trades — the same quantity as the reported mean, with the session as the unit of resampling (trades
 * inside one session are not independent). `estimator: 'sessionMeanMean'` keeps the old statistic
 * available for comparison, which is how the two are shown side by side instead of silently swapped.
 */
function sessionCI(bySession, opts) {
  const o = opts || {};
  const days = Object.keys(bySession);
  if (days.length < 5) return null;
  const reps = o.reps || 2000;
  const rnd = mulberry32(o.seed || 20260927);
  const estimator = o.estimator || 'cluster';
  const dayMeans = days.map((d) => mean(bySession[d]));
  const repsOut = new Array(reps);
  for (let r = 0; r < reps; r++) {
    let s = 0, n = 0;
    for (let k = 0; k < days.length; k++) {
      const d = bySession[days[Math.floor(rnd() * days.length)]];
      if (estimator === 'cluster') { for (let x = 0; x < d.length; x++) { s += d[x]; n++; } }
      else { s += mean(d); n++; }
    }
    repsOut[r] = estimator === 'cluster' ? (n ? s / n : 0) : s / n;
  }
  repsOut.sort((a, b) => a - b);
  return {
    lo: +repsOut[Math.floor(reps * 0.025)].toFixed(3),
    hi: +repsOut[Math.floor(reps * 0.975)].toFixed(3),
    days: days.length,
    estimator,
    seed: o.seed || 20260927,
  };
}

/** sessionMeanCI(bySession, opts) — the pre-2026-09-27 statistic, kept so the two can be compared. */
function sessionMeanCI(bySession, opts) {
  return sessionCI(bySession, Object.assign({}, opts, { estimator: 'sessionMeanMean' }));
}

// ---------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------
module.exports = {
  MIN_RISK_PCT, MAX_RISK_PCT, COST_PCT, sideSign,
  stopPctOf, costRAt, minStopPctForCostR, entryGate,
  load,
  niftySeries,
  sessionOf,
  simulate,
  forwardReturn,
  mean,
  pct,
  sessionCI,
  sessionMeanCI,
};
