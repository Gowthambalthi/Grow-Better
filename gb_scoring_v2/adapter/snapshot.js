/**
 * gb_scoring_v2/adapter/snapshot.js — ONE NORMALIZED SNAPSHOT PER SYMBOL PER SCAN.
 *
 * V3 spec Section 6.1 and Phase 2:
 *   "Unavailable fields are stored as null and listed in a missing[] array."
 *   Phase 2 done-when: "One normalized snapshot per symbol; missing[] populated;
 *    no writes to old engine."
 *
 * The shape below is the spec's Section 6.1 grouping verbatim (identity/time,
 * price, flow, location, structure, context, reference) so a reader holding the
 * spec can find every field. Every value carries its provenance tag, and the
 * flow block gets the Section 6.2 inferred-only flag.
 *
 * HARD RULES honored here:
 *   - missing is null, never 0 (spec Section 2 rule 3)
 *   - every field is classified observed/derived/inferred/verify (Section 2 rule 4)
 *   - nothing is written anywhere: this is a pure function of the GB row
 */
const { TAGS, tagOf, isKnown, classify, flowProvenance, FIELD_REGISTRY } = require('./provenance');

// Directional text -> [-1, +1]. GB speaks in words ("UP", "DOWN-LEAN", "MIXED");
// the engine needs a number, and the mapping has to be one place so trend and
// RSI cannot disagree about what "DOWN-LEAN" meant.
const DIRECTION_WORDS = {
  'UP': 1, 'UP-LEAN': 0.5, 'BULLISH': 1, 'RISING': 1,
  'DOWN': -1, 'DOWN-LEAN': -0.5, 'BEARISH': -1, 'FALLING': -1,
  'MIXED': 0, 'FLAT': 0, 'SIDEWAYS': 0, 'NEUTRAL': 0, 'NONE': 0,
};
function dirWord(w) {
  if (!isKnown(w)) return null;
  const v = DIRECTION_WORDS[String(w).toUpperCase()];
  return v === undefined ? null : v;
}

// Spec Section 6.2: these are the fields whose provenance decides the validation
// breakdown, so they are listed once and read from the registry.
const FLOW_KEYS = ['buyValue', 'sellValue', 'netOrderValue', 'delta', 'buyPressure', 'sellPressure', 'volume', 'volumeRatio', 'volumeRoc', 'rawBuyQty', 'rawSellQty'];

/**
 * toSnapshot(row, ctx) -> normalized snapshot.
 * `row` is one row from GB's data/live_signals.json. `ctx` carries the payload-level
 * facts (scan time, market state) because they are not repeated on every row.
 */
function toSnapshot(row, ctx = {}) {
  if (!row || !row.symbol) return null;
  const receiptTs = ctx.receiptTs != null ? ctx.receiptTs : Date.now();
  const receiptIso = new Date(receiptTs).toISOString();

  // CROSS-SOURCE ENRICHMENT (read-only). The tick row carries the LIVE evidence;
  // the funnel's quality set and screening shortlist carry the STATIC facts (20-day
  // volume, market cap, ATR) that the tick feed never has. Phase 4's liquidity gate
  // needs both, so they are merged here rather than leaving the gate unrunnable.
  // `quality` = a universe_filtered row; `screened` = a universe_shortlist row.
  const q = ctx.quality || null;
  const sc = ctx.screened || null;
  const first = (...vals) => { for (const v of vals) if (isKnown(v)) return v; return null; };

  // ---- price block -------------------------------------------------------
  const price = isKnown(row.ltp) ? row.ltp : null;
  const bid = null;   // MEASURED: absent from the feed (see FIELD_REGISTRY)
  const ask = null;
  const spreadPct = (isKnown(bid) && isKnown(ask) && bid > 0 && ask > 0) ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;

  // ---- flow block --------------------------------------------------------
  const rawBuyQty = isKnown(row.totBuy) ? row.totBuy : null;
  const rawSellQty = isKnown(row.totSell) ? row.totSell : null;
  const qtySum = (rawBuyQty || 0) + (rawSellQty || 0);
  // Pressure is only meaningful when BOTH sides exist -- one side alone would
  // manufacture a 100% imbalance out of a missing field.
  const haveBothSides = isKnown(rawBuyQty) && isKnown(rawSellQty) && qtySum > 0;
  const flow = {
    buyValue: null,            // no traded value by side in GB
    sellValue: null,
    netOrderValue: null,
    delta: isKnown(row.flowBias) ? row.flowBias : null,     // INFERRED bias, not exchange delta
    buyPressure: haveBothSides ? rawBuyQty / qtySum : null,
    sellPressure: haveBothSides ? rawSellQty / qtySum : null,
    volume: isKnown(row.volume) ? row.volume : null,
    volumeRatio: isKnown(row.volX) ? row.volX : null,
    volumeRoc: isKnown(row.volRoc) ? row.volRoc : null,
    rawBuyQty, rawSellQty,
  };

  // ---- location block ----------------------------------------------------
  const location = {
    vwap: isKnown(row.vwap) ? row.vwap : null,
    vwapSlope: isKnown(row.vwapDrift) ? row.vwapDrift : null,
    poc: isKnown(row.poc) ? row.poc : null,
    vah: isKnown(row.vaHigh) ? row.vaHigh : null,
    val: isKnown(row.vaLow) ? row.vaLow : null,
    // MEASURED: present on every ledger row (10,508/10,508) and on 380/380 deep live
    // rows. They were dropped here before, so POC/value-area evidence never reached a
    // backtest. `posInRange` and `camZone` are carried for DISPLAY ONLY (spec 14).
    posInRange: isKnown(row.posInRange) ? row.posInRange : null,
    stack: isKnown(row.vwapStack) ? row.vwapStack : null,
    camZone: isKnown(row.camZone) ? row.camZone : null,
  };

  // ---- structure block ---------------------------------------------------
  const ct = row.candleTrend || {};
  const structure = {
    trend1m: dirWord(ct.m1),
    trend5m: dirWord(ct.m5),
    trend15m: dirWord(ct.m15),
    trend3m: dirWord(ct.m3),
    adx: null,                 // MEASURED: absent
    rsi1m: null, rsi5m: null, rsi15m: null,
    // kept verbatim for the structure group, which the spec says must read
    // structure rather than ROC so it stays independent of the momentum group
    swingAgree: dirWord(row.swingAgree),
    structureNote: isKnown(row.structure) ? row.structure : null,
    structNote: isKnown(row.structNote) ? row.structNote : null,
    trendDaily: dirWord(row.dailyTrend),
  };

  // ---- candle context block (spec 17: display-only in v1; spec 26 deferred) ----
  // GB computes all of this and the adapter used to discard it, which is why the
  // recorded sessions contain ZERO candle evidence (measured: grep -c candlePattern
  // over data/v2_sessions/raw_*.jsonl returned 0 before this change). Recording it is
  // the only way Section 21.6 can ever judge whether it earns points.
  const gp = row.gap || {};
  const ctrend = row.candleTrend || {};
  const candles = {
    gapOpenPct: isKnown(gp.openPct) ? gp.openPct : null,
    gapOpenDir: isKnown(gp.openDir) ? gp.openDir : null,
    gapFillPct: isKnown(gp.fillPct) ? gp.fillPct : null,
    gapSizeVsAtrX: isKnown(gp.sizeVsAtrX) ? gp.sizeVsAtrX : null,
    gapNearestUpPct: isKnown(gp.nearestUpPct) ? gp.nearestUpPct : null,
    gapNearestDownPct: isKnown(gp.nearestDownPct) ? gp.nearestDownPct : null,
    gapText: isKnown(row.gapTxt) ? row.gapTxt : null,
    pattern: isKnown(row.candlePattern) ? row.candlePattern : null,
    trendCounts: {
      m1: isKnown(ctrend.m1) ? ctrend.m1 : null, m2: isKnown(ctrend.m2) ? ctrend.m2 : null, m3: isKnown(ctrend.m3) ? ctrend.m3 : null,
      m5: isKnown(ctrend.m5) ? ctrend.m5 : null, m15: isKnown(ctrend.m15) ? ctrend.m15 : null, m30: isKnown(ctrend.m30) ? ctrend.m30 : null,
    },
    trendAgree: isKnown(row.candlesAgree) ? row.candlesAgree : null,
    swingAgree: isKnown(row.swingAgree) ? row.swingAgree : null,
    volAtPrice: isKnown(row.volAtPrice) ? row.volAtPrice : null,
    dayHigh: isKnown(row.dayHigh) ? row.dayHigh : null,
    dayLow: isKnown(row.dayLow) ? row.dayLow : null,
  };

  // ---- context block ----------------------------------------------------
  const context = {
    niftyState: isKnown(row.market) ? row.market : null,
    niftyReturn: null,
    sectorReturn: null,
    beta: null,                // placeholder 1.0 lives in config, not here
    setup: isKnown(row.engine) ? row.engine : (isKnown(row.label) ? row.label : null),
  };

  // ---- reference block --------------------------------------------------
  const reference = {
    close: first(q && q.close, sc && sc.close),
    avgVol20: first(q && q.avgVol20),
    // Turnover is kept in RUPEES (the gate divides by 1e7 for Cr). The screening
    // shortlist speaks in Cr, so it is converted rather than silently mixed.
    turnover: first(isKnown(row.dayValue) ? row.dayValue : null, sc && isKnown(sc.valueCr) ? sc.valueCr * 1e7 : null),
    marketCap: first(sc && sc.marketCap, sc && isKnown(sc.marketCapCr) ? sc.marketCapCr * 1e7 : null),
    circuitBand: null,
    surveillance: null,
    eventFlags: null,
    dayPct: isKnown(row.dayPct) ? row.dayPct : first(q && q.dayPct, sc && sc.dayPct),
    phase: isKnown(row.phase) ? row.phase : null,
    tickOnly: !!row.tickOnly,
    volBand: first(q && q.volBand, sc && sc.volBand),
    activity: first(sc && sc.activity),
  };

  const snapshot = {
    symbol: String(row.symbol),
    // exchangeTs is unknown: GB stamps the scan, not the print. recording the scan
    // time under a different name keeps the two from being confused downstream.
    scanTs: isKnown(row.givenAt) ? row.givenAt : (ctx.generatedAt || null),
    exchangeTs: null,
    receiptTs: receiptIso,
    depth: isKnown(row.tickOnly) && row.tickOnly ? 'tick-only' : 'deep',
    price, bid, ask, spreadPct,
    price_evidence: {
      // THE 10s/20s/30s FRAMES COME FROM THE 10-SECOND SAMPLE GRID, not from the raw tick
      // window. The user's reason is a measurement, not a preference: a raw window asks "what
      // did this print at 20s ago", so a name with two prints in that window returns a number
      // made of one order, while the grid is one price per 10s bucket and every pair of points
      // is exactly 10 seconds apart. `row.s10/s20/s30` stay as the fallback for a row that
      // predates the grid (or a process the grid is younger than) so the fast group is never
      // simply missing — but when the grid exists it is what these three mean.
      roc10: isKnown(row.roc10) ? row.roc10 : (isKnown(row.s10) ? row.s10 : null),
      roc20: isKnown(row.roc20) ? row.roc20 : (isKnown(row.s20) ? row.s20 : null),
      roc30: isKnown(row.roc30) ? row.roc30 : (isKnown(row.s30) ? row.s30 : null),
      roc15s: isKnown(row.s15) ? row.s15 : null,
      roc1m: isKnown(row.roc1) ? row.roc1 : null,
      // 3m IS built by GB (measured: 380/814 live rows, and every ledger row), so
      // the spec's optional structural input is INCLUDED rather than deferred.
      roc3m: isKnown(row.roc3) ? row.roc3 : null,
      roc5m: isKnown(row.roc5) ? row.roc5 : null,
      roc15m: isKnown(row.roc15) ? row.roc15 : null,
      roc60m: isKnown(row.roc60) ? row.roc60 : null,
      atrPct: first(isKnown(row.daily) ? row.daily.atrPct : null, q && q.atrPct, sc && sc.atrPct),
      ivEst: null,
    },
    flow,
    location,
    candles,
    structure,
    context,
    reference,
  };

  // ---- provenance + missing ---------------------------------------------
  // SCREENING BLOCK: Yahoo's delayed, screening-grade quote fields, kept separate
  // from the entry evidence on purpose. Gates may read them (the spread gate does,
  // when a row has no entry-grade spread) but nothing here may back an entry-timing
  // claim: measured, Yahoo declares a 15-minute delay.
  snapshot.screening = {
    spreadPct: first(sc && sc.spreadPct),
    delayedBy: first(sc && sc.delayedBy),
    close: first(sc && sc.close),
    marketCapCr: first(sc && sc.marketCapCr),
    source: (sc || q) ? 'funnel-screening' : null,
  };
  snapshot.flow.provenance = flowProvenance(flow);
  snapshot.provenance = buildProvenance(snapshot);
  snapshot.missing = collectMissing(snapshot);
  snapshot.coverage = coverage(snapshot);
  return snapshot;
}

/** Walks the spec's grouped fields and tags each one, so the tags travel with the value. */
function buildProvenance(s) {
  const p = {};
  const put = (section, field, value) => { p[section + '.' + field] = classify(field, value); };
  put('identity', 'price', s.price);
  put('identity', 'exchangeTs', s.exchangeTs);
  for (const k of Object.keys(s.price_evidence)) put('price', k, s.price_evidence[k]);
  for (const k of FLOW_KEYS) put('flow', k, s.flow[k]);
  for (const k of ['vwap', 'vwapSlope', 'poc', 'vah', 'val', 'posInRange', 'stack', 'camZone']) put('location', k, s.location[k]);
  for (const k of ['gapOpenPct', 'gapOpenDir', 'gapFillPct', 'gapSizeVsAtrX', 'gapNearestUpPct', 'gapNearestDownPct', 'gapText', 'pattern', 'trendCounts', 'trendAgree', 'swingAgree', 'volAtPrice']) put('candles', k, s.candles[k]);
  for (const k of ['trend1m', 'trend5m', 'trend15m', 'adx', 'rsi1m', 'rsi5m', 'rsi15m', 'swingAgree']) put('structure', k, s.structure[k]);
  for (const k of ['niftyState', 'niftyReturn', 'sectorReturn', 'beta', 'setup']) put('context', k, s.context[k]);
  for (const k of Object.keys(s.reference)) put('reference', k, s.reference[k]);
  return p;
}

/**
 * missing[] -- every spec field that could not be seen, by dotted path.
 * Deliberately driven by the registry, not by a hand-written list, so a field
 * that is expected but absent shows up on its own.
 */
function collectMissing(s) {
  const out = [];
  const check = (path, field, value) => { if (!isKnown(value)) out.push(path); };
  check('identity.exchangeTs', 'exchangeTs', s.exchangeTs);
  if (!isKnown(s.bid)) out.push('identity.bid');
  if (!isKnown(s.ask)) out.push('identity.ask');
  if (!isKnown(s.spreadPct)) out.push('identity.spreadPct');
  for (const k of Object.keys(s.price_evidence)) check('price.' + k, k, s.price_evidence[k]);
  for (const k of FLOW_KEYS) check('flow.' + k, k, s.flow[k]);
  for (const k of ['vwap', 'vwapSlope', 'poc', 'vah', 'val', 'posInRange', 'stack', 'camZone']) check('location.' + k, k, s.location[k]);
  for (const k of ['gapOpenPct', 'gapFillPct', 'gapSizeVsAtrX', 'pattern', 'trendCounts', 'trendAgree']) check('candles.' + k, k, s.candles[k]);
  for (const k of ['trend1m', 'trend5m', 'trend15m', 'adx', 'rsi1m', 'rsi5m', 'rsi15m']) check('structure.' + k, k, s.structure[k]);
  for (const k of ['niftyState', 'niftyReturn', 'sectorReturn', 'beta']) check('context.' + k, k, s.context[k]);
  for (const k of ['close', 'avgVol20', 'turnover', 'marketCap', 'circuitBand', 'surveillance', 'eventFlags']) check('reference.' + k, k, s.reference[k]);
  if (!isKnown(s.screening.spreadPct)) out.push('screening.spreadPct');
  return out;
}

/**
 * Coverage = share of the 58-point ledger whose inputs were available (spec Section 17).
 * Only the groups the score actually draws on are counted; gate-only fields are
 * excluded because a missing gate input caps at WATCH (Section 8), it does not
 * dilute coverage.
 */
function coverage(s) {
  const groups = {
    momentum: ['roc10', 'roc20', 'roc30', 'roc1m', 'roc5m', 'roc15m'],
    flow: ['delta', 'buyPressure', 'sellPressure', 'volumeRatio'],
    location: ['vwap', 'poc', 'vah', 'val'],
    trend: ['trend1m', 'trend5m', 'trend15m', 'adx'],
    rsi: ['rsi1m', 'rsi5m', 'rsi15m'],
    relativeStrength: ['niftyReturn', 'sectorReturn'],
  };
  const src = { momentum: s.price_evidence, flow: s.flow, location: s.location, trend: s.structure, rsi: s.structure, relativeStrength: s.context };
  const per = {};
  let have = 0, total = 0;
  for (const g of Object.keys(groups)) {
    const vals = groups[g].map(k => src[g][k]);
    const h = vals.filter(isKnown).length;
    per[g] = { available: h, of: vals.length, share: vals.length ? +(h / vals.length).toFixed(3) : 0 };
    have += h; total += vals.length;
  }
  return { perGroup: per, overall: total ? +(have / total).toFixed(3) : 0, fields: have + '/' + total };
}

module.exports = { toSnapshot, dirWord, DIRECTION_WORDS, collectMissing, coverage, FLOW_KEYS };
