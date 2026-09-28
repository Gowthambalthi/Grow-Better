/**
 * gb_scoring_v2/orderflow/footprint.js — PHASE 2: FOOTPRINT / DELTA (tick-rule approximation).
 *
 * The plan's pseudo-code assumes best bid/ask are in hand:
 *
 *     if ltp >= best_ask -> BUY_AGGRESSOR ; elif ltp <= best_bid -> SELL_AGGRESSOR
 *     else same_as_previous_side
 *
 * THIS FEED DOES NOT CARRY BEST BID/ASK. The board subscribes in Angel's QUOTE mode (the socket
 * is at its 3-socket cap, and SNAP_QUOTE would roughly double the payload for 600 names), so
 * `bestBids`/`bestAsks` never arrive. Rather than pretend, the classifier uses the best evidence
 * the feed actually carries, in order, and RECORDS which one it used per bar:
 *
 *   1. 'bidask'        — the plan's strict rule, used the moment SNAP_QUOTE is ever wired in.
 *   2. 'exchange-qty'  — ΔtotalBuyQuantity vs ΔtotalSellQuantity, the exchange's own buy/sell quantity
 *                        pair. READ THIS BEFORE TRUSTING IT: the pair's SEMANTICS ARE UNVERIFIED.
 *                        Two readings fit the same two numbers — cumulative TRADED quantity split by
 *                        aggressor side (in which case the increment is a real footprint), or the
 *                        RESTING quantity at the bid vs the ask (in which case the increment is
 *                        liquidity added/pulled: a book-imbalance PROXY, and `side` is not the
 *                        aggressor at all). No aggressor field exists in the packet, and the vendor's
 *                        names do not disambiguate. `.freebuff/verify-bqsq.js` decides it on the first
 *                        captured session (monotonicity + the Δv===q / one-side identity + the
 *                        increment budget); the basis string stays 'exchange-qty' either way so old
 *                        artifacts keep parsing, but until that script returns TRADED-CUMULATIVE the
 *                        honest name for this basis is EXCHANGE-QUANTITY IMBALANCE, not executed volume.
 *   3. 'tickrule'      — uptick = buy, downtick = sell, unchanged = same side as the previous
 *                        trade (the plan's own fallback, and Lee-Ready's second rule).
 *
 * WHY THE BASIS IS REPORTED AND NOT JUST USED. Delta is the core new input of the whole plan; if
 * the classifier is silently running on rule 3 while the UI implies rule 1, every downstream
 * conclusion is unfalsifiable. Each sealed bar carries `basis`, and the board reports the mix.
 *
 * WEIGHTING. A tick contributes `lastTradedQuantity` when the feed provides it, else 1 (one
 * trade), and the basis says which. Volume-weighted with a real quantity is the plan's intent;
 * count-weighted is the honest degradation, not a silent substitution of a different quantity.
 *
 * PRICE BUCKETS. The plan buckets per `price`. A literal 0.05-wide bucket on a ₹40,000 stock and
 * a 1-paisa bucket on a ₹100 stock are different instruments' worth of resolution, so the bucket
 * width is chosen per token from the price's own scale (see bucketStep) and named in the output.
 */
const BAR_MS = 60000;
const BARS_KEEP = 480;               // one session
const PRICE_LEVELS_KEEP = 6000;      // session footprint cap, memory guard only

const state = new Map();             // token -> { bar, bars, levels, lastTick, lastSide, counts }
let _stepOverride = null;            // tests set this to make buckets deterministic

function bucketStep(p) {
  if (_stepOverride) return _stepOverride;
  if (p >= 5000) return 0.5;
  if (p >= 1000) return 0.1;
  if (p >= 200) return 0.05;
  if (p >= 50) return 0.02;
  return 0.01;
}

function bucketOf(p, step) { return +(Math.round(p / step) * step).toFixed(4); }

function blankBar(t) {
  return { t, o: null, h: null, l: null, c: null, vol: 0, buy: 0, sell: 0, delta: 0, trades: 0, basis: {} };
}

/**
 * classify(cur, prev, st) — the aggressor side of one trade, with its basis.
 * `prev` is the previous captured row for this token (may be null on the first tick).
 */
function classify(cur, prev, st) {
  const bid = Number(cur.bid), ask = Number(cur.ask);          // absent on this feed; present if it ever is
  if (bid > 0 && ask > 0 && bid < ask) {
    if (cur.p >= ask) return { side: 'buy', basis: 'bidask' };
    if (cur.p <= bid) return { side: 'sell', basis: 'bidask' };
  }
  if (prev) {
    const dbq = cur.bq - prev.bq, dsq = cur.sq - prev.sq;
    if ((dbq > 0 || dsq > 0) && dbq !== dsq) {
      // one side of the pair grew more than the other. Under the traded-cumulative reading that is
      // the aggressor; under the resting-book reading it is whoever posted/replenished more size.
      // The basis name is kept for artifact compatibility; verify-bqsq.js is what decides which it is.
      return { side: dbq > dsq ? 'buy' : 'sell', basis: 'exchange-qty' };
    }
  }
  if (prev && prev.p != null) {
    if (cur.p > prev.p) { st.lastSide = 'buy'; return { side: 'buy', basis: 'tickrule' }; }
    if (cur.p < prev.p) { st.lastSide = 'sell'; return { side: 'sell', basis: 'tickrule' }; }
    // an unchanged print with no prior side is the tick rule DECLINING, and it is reported as the
    // tick rule — a distinct 'unclassified' bucket is reserved for a first print with no evidence
    // at all, so the board can tell "this feed gives us nothing" from "this print gave us nothing".
    if (st.lastSide) return { side: st.lastSide, basis: 'tickrule' };
    return { side: null, basis: 'tickrule' };
  }
  return { side: null, basis: 'unclassified' };
}

function stFor(token) {
  let st = state.get(token);
  if (!st) {
    st = { bar: null, sealed: [], levels: new Map(), lastTick: null, lastSide: null, priceStep: null, counts: { ticks: 0, byBasis: {}, unclassified: 0 } };
    state.set(token, st);
  }
  return st;
}

/** seal(bar) — close the current bar and hand it to the sealed series. */
function seal(st) {
  const b = st.bar;
  if (!b) return null;
  st.sealed.push(b);
  if (st.sealed.length > BARS_KEEP) st.sealed.splice(0, st.sealed.length - BARS_KEEP);
  st.bar = null;
  return b;
}

/**
 * ingest(token, row) — one captured tick (tickCapture's row shape: {t, p, q, bq, sq, v}).
 * Rolls the 1m bar when the bucket changes and returns the SEALED bar when this tick closed one
 * (so the caller can run the layers exactly once per finished bar without polling).
 */
function ingest(token, row) {
  if (!token || !row || !(row.p > 0)) return null;
  const st = stFor(String(token));
  const bucket = Math.floor(row.t / BAR_MS) * BAR_MS;
  let sealed = null;
  if (st.bar && st.bar.t !== bucket) sealed = seal(st);
  if (!st.bar) st.bar = blankBar(bucket);
  const b = st.bar;

  if (st.priceStep == null) st.priceStep = bucketStep(row.p);
  const cls = classify(row, st.lastTick, st);
  const w = row.q > 0 ? row.q : 1;
  const key = bucketOf(row.p, st.priceStep);
  let lvl = st.levels.get(key);
  if (!lvl) { lvl = { p: key, b: 0, a: 0 }; st.levels.set(key, lvl); }
  if (cls.side === 'buy') { lvl.a += w; b.buy += w; b.delta += w; }
  else if (cls.side === 'sell') { lvl.b += w; b.sell += w; b.delta -= w; }
  else st.counts.unclassified++;
  if (st.levels.size > PRICE_LEVELS_KEEP) {
    // memory guard: drop the least-traded level rather than let a wild print balloon the table
    let worst = null;
    for (const [k, v] of st.levels) if (!worst || (v.a + v.b) < (worst[1].a + worst[1].b)) worst = [k, v];
    if (worst) st.levels.delete(worst[0]);
  }

  b.o = b.o == null ? row.p : b.o;
  b.h = b.h == null ? row.p : Math.max(b.h, row.p);
  b.l = b.l == null ? row.p : Math.min(b.l, row.p);
  b.c = row.p;
  b.vol += w;
  b.trades++;
  b.basis[cls.basis] = (b.basis[cls.basis] || 0) + 1;
  st.counts.ticks++;
  st.counts.byBasis[cls.basis] = (st.counts.byBasis[cls.basis] || 0) + 1;
  st.lastTick = row;
  return sealed;
}

/** currentBar(token) — the still-forming bar, or null. */
function currentBar(token) {
  const st = state.get(String(token));
  return st ? st.bar : null;
}

/** bars(token, n) — the last n SEALED bars, oldest first. */
function bars(token, n = BARS_KEEP) {
  const st = state.get(String(token));
  if (!st) return [];
  return n >= st.sealed.length ? st.sealed.slice() : st.sealed.slice(st.sealed.length - n);
}

/**
 * cumulativeDelta(token) — running session delta (every classified trade, sealed or forming).
 * The plan sums this across the session and reads its SHAPE (three falling readings = sellers
 * exhausting), so the series matters more than the level.
 */
function cumulativeDelta(token) {
  const st = state.get(String(token));
  if (!st) return 0;
  let d = 0;
  for (const b of st.sealed) d += b.delta;
  if (st.bar) d += st.bar.delta;
  return +d.toFixed(2);
}

/**
 * collapse(token) — is one side running out of fuel?
 *
 * THE PLAN'S FORMULA, APPLIED TO THE QUANTITY IT DESCRIBES. The plan writes
 *
 *     delta_collapsing_down = cumulative_delta[t] < cumulative_delta[t-1] < cumulative_delta[t-2]
 *
 * and labels it "delta_collapsing_down (sellers exhausting) # note: exhaustion of the move that's
 * ending, confirms reversal". As written on the CUMULATIVE series, those inequalities mean the
 * cumulative delta is falling faster and faster — selling ACCELERATING, which is the opposite of
 * the label. On the PER-BAR delta the same three-way shape test says what the label says: each bar
 * sells less than the one before. The gate needs the LABEL (a long is bought on seller exhaustion,
 * not on seller acceleration), so that is what `down`/`up` mean here. The literal cumulative test
 * is reported as `cumMonotone` alongside, so the difference between formula and intent is visible
 * in the replay log instead of being silently resolved in code.
 */
function collapse(token) {
  const st = state.get(String(token));
  if (!st) return { down: false, up: false, series: [], cumMonotone: null };
  const bars = st.sealed.slice(-3);
  const d = bars.map((b) => b.delta);
  const series = d.map((x) => +x.toFixed(2));
  const cum = [];
  let run = 0;
  for (const b of st.sealed) { run += b.delta; cum.push(run); }
  const ct = cum.slice(-3);
  return {
    // selling dying out: each bar sold less than the one before, and the move was a sell
    down: d.length === 3 && d[2] > d[1] && d[1] > d[0] && d[0] < 0,
    // buying dying out: the mirror
    up: d.length === 3 && d[2] < d[1] && d[1] < d[0] && d[0] > 0,
    series,
    cumDelta: cumulativeDelta(token),
    cumMonotone: ct.length === 3
      ? { falling: ct[2] < ct[1] && ct[1] < ct[0], rising: ct[2] > ct[1] && ct[1] > ct[0] }
      : null,
    barsRequired: 3,
    barsUsed: d.length,
  };
}

/**
 * pocFromLevels(levelVals, valueAreaPct) — the session POC and value area, from a plain array of
 * {p, b, a} levels. The live `poc(token)` below is this function applied to the live level map, and
 * the historical rebuild applies it to the levels it read back off disk — ONE definition, so a
 * day's POC and the live POC are the same statistic rather than two implementations that happen to
 * agree today.
 */
function pocFromLevels(levelVals, valueAreaPct = 0.7) {
  const rows = (levelVals || [])
    .map((v) => ({ p: v.p, v: v.a + v.b, b: v.b, a: v.a }))
    .sort((x, y) => y.v - x.v);
  if (!rows.length) return { poc: null, vah: null, val: null, levels: 0 };
  const total = rows.reduce((s, r) => s + r.v, 0);
  if (!(total > 0)) return { poc: null, vah: null, val: null, levels: rows.length };
  const byPrice = rows.slice().sort((x, y) => x.p - y.p);
  const pocRow = rows[0];
  const i0 = byPrice.findIndex((r) => r.p === pocRow.p);
  let lo = i0, hi = i0, held = byPrice[i0].v;
  while (held < total * valueAreaPct && (lo > 0 || hi < byPrice.length - 1)) {
    const below = lo > 0 ? byPrice[lo - 1].v : -1;
    const above = hi < byPrice.length - 1 ? byPrice[hi + 1].v : -1;
    if (above >= below) { hi++; held += byPrice[hi].v; } else { lo--; held += byPrice[lo].v; }
  }
  return {
    poc: pocRow.p,
    vah: byPrice[hi].p,
    val: byPrice[lo].p,
    levels: rows.length,
    total: +total.toFixed(2),
  };
}

/**
 * poc(token, valueAreaPct) — the session's point of control from the footprint and the value area
 * that holds `valueAreaPct` of traded volume. Returns nulls until at least one bar has closed,
 * because a POC built from a single forming bar is noise presented as a level.
 */
function poc(token, valueAreaPct = 0.7) {
  const st = state.get(String(token));
  if (!st || !st.levels.size) return { poc: null, vah: null, val: null, levels: 0, step: st ? st.priceStep : null };
  return Object.assign(pocFromLevels(Array.from(st.levels.values()), valueAreaPct), { step: st.priceStep });
}

/**
 * absorptionFromLevels(levelVals, opts) — a price level where one side absorbed the other:
 * imbalance (max/min >= 2.5) AND that level trading at least 1.5x the average of its neighbours.
 * The plan's definition, with the neighbour average computed over the price-sorted table so a
 * single wild print at the extremes cannot manufacture a level. Exported so the historical rebuild
 * reads the same absorption the live layer does.
 */
function absorptionFromLevels(levelVals, opts = {}) {
  const minImbalance = opts.minImbalance || 2.5;
  const minVsNeighbours = opts.minVsNeighbours || 1.5;
  const rows = (levelVals || [])
    .map((v) => ({ p: v.p, b: v.b, a: v.a, tot: v.a + v.b }))
    .filter((r) => r.tot > 0)
    .sort((x, y) => x.p - y.p);
  if (rows.length < 3) return null;
  let best = null;
  for (let i = 1; i < rows.length - 1; i++) {
    const r = rows[i];
    // BOTH SIDES MUST BE PRESENT, or this is not absorption. Absorption means one side absorbed the
    // other side's aggression, which requires the other side to have traded at all. A bucket where
    // the sell side executed exactly zero volume reported an imbalance of `max/1` — a threshold of
    // 2.5 was satisfied by ANY one-sided print, so every isolated buy above the range was labelled
    // "sellers absorbed" with an imbalance in the hundreds. That is the single-print artifact the
    // neighbour test below was written to prevent, arriving through the front door instead.
    const thin = Math.min(r.b, r.a);
    if (!(thin > 0)) continue;
    const imb = Math.max(r.b, r.a) / thin;
    if (imb < minImbalance) continue;
    const avgNear = (rows[i - 1].tot + rows[i + 1].tot) / 2;
    if (avgNear > 0 && r.tot >= avgNear * minVsNeighbours) {
      const side = r.a > r.b ? 'buyers-absorbed' : 'sellers-absorbed';
      if (!best || imb > best.imbalance) best = { price: r.p, imbalance: +imb.toFixed(2), side, vol: +r.tot.toFixed(2), vsNeighbours: +(r.tot / avgNear).toFixed(2) };
    }
  }
  return best;
}

/**
 * absorption(token, opts) — the live absorption: absorptionFromLevels over this token's levels.
 */
function absorption(token, opts = {}) {
  const st = state.get(String(token));
  if (!st || st.levels.size < 3) return null;
  return absorptionFromLevels(Array.from(st.levels.values()), opts);
}

/** snapshot(token) — everything the gate needs from this layer, in one object. */
function snapshot(token) {
  const st = state.get(String(token));
  const sealed = bars(token);
  const last = sealed.length ? sealed[sealed.length - 1] : null;
  return {
    bars: sealed.length,
    bar: last,
    forming: st ? st.bar : null,
    cumDelta: cumulativeDelta(token),
    collapse: collapse(token),
    poc: poc(token),
    absorption: absorption(token),
    basis: st ? st.counts.byBasis : {},
    unclassified: st ? st.counts.unclassified : 0,
    ticks: st ? st.counts.ticks : 0,
    step: st ? st.priceStep : null,
    lastBarDelta: last ? +last.delta.toFixed(2) : null,
  };
}

function reset() { state.clear(); }
function setStepOverride(s) { _stepOverride = s; }

module.exports = {
  ingest, currentBar, bars, cumulativeDelta, collapse, poc, absorption, snapshot, classify, bucketOf,
  // the level-array forms, so the HISTORICAL rebuild computes POC and absorption with the SAME code
  // the live layer uses rather than a second implementation that would drift
  pocFromLevels, absorptionFromLevels,
  // bucketStep is exported so the HISTORICAL rebuild (history.js) buckets the same price scale the
  // live footprint does. A second bucket-width rule in the reader would make a day's ladder a
  // different shape from the ladder the gate saw, and the page would show two footprints of one day.
  bucketStep, seal,
  reset, setStepOverride, state, BAR_MS, BARS_KEEP,
};
