/**
 * gb_scoring_v2/adapter/provenance.js — OBSERVED vs INFERRED, AND EVERYTHING BETWEEN.
 *
 * V3 spec Section 2 rule 4: "Every flow field is tagged observed or inferred."
 * Section 6.2 gives the four tags plus the reason the distinction matters:
 * "Values that look like 'order value' are usually inferred... so the engine, the
 * output and the validation can distinguish evidence types."
 *
 * The practical consequence (Section 6.2): "an inferred-only flow reading can
 * score, but the output labels it inferred, and validation reports results split
 * by provenance." So the tag is not decoration -- it decides which validation
 * breakdown a row lands in.
 *
 * Section 2 rule 3 is the other half: "Missing data is explicit null, never
 * silently zero." A tag of UNKNOWN means "we could not see this", which is a
 * different fact from a tag of INFERRED with a real value of 0.
 */

const TAGS = {
  OBSERVED: 'OBSERVED',   // the feed handed it to us directly (LTP, cumulative volume)
  DERIVED: 'DERIVED',     // deterministic from observed inputs (VWAP, ROC, ATR, RSI)
  INFERRED: 'INFERRED',   // produced by a classification we imposed (tick-rule buy/sell)
  VERIFY: 'VERIFY',       // the field EXISTS but its meaning is unconfirmed -- see below
  UNKNOWN: 'UNKNOWN',     // not available from this feed at all
};

/**
 * The field registry: GB's actual output field -> tag + where the value comes from.
 * Built from a measured census of data/live_signals.json (814 rows, 24-Sep), not
 * from assumption. Fields the spec names but GB does not carry are listed as
 * UNKNOWN so the gaps are explicit rather than discovered later.
 */
const FIELD_REGISTRY = {
  // ---- identity / time ----
  symbol:          { tag: TAGS.OBSERVED, from: 'row.symbol' },
  price:           { tag: TAGS.OBSERVED, from: 'row.ltp', note: 'last traded price' },
  exchangeTs:      { tag: TAGS.UNKNOWN,  from: null, note: 'GB rows carry scan time, not exchange print time' },
  receiptTs:       { tag: TAGS.OBSERVED, from: 'recorded at read time' },
  bid:             { tag: TAGS.UNKNOWN,  from: null, note: 'MEASURED: 0/814 rows carry bid -- spread gate cannot run (spec Section 8)' },
  ask:             { tag: TAGS.UNKNOWN,  from: null, note: 'MEASURED: 0/814 rows carry ask' },
  spreadPct:       { tag: TAGS.UNKNOWN,  from: null, note: 'requires best bid/ask' },

  // ---- price evidence ----
  roc10:           { tag: TAGS.DERIVED,  from: 'row.roc10 (10s sample grid) | row.s10', unit: '%' },
  roc20:           { tag: TAGS.DERIVED,  from: 'row.roc20 (10s sample grid) | row.s20', unit: '%' },
  roc30:           { tag: TAGS.DERIVED,  from: 'row.roc30 (10s sample grid) | row.s30', unit: '%' },
  roc1m:           { tag: TAGS.DERIVED,  from: 'row.roc1', unit: '%' },
  roc3m:           { tag: TAGS.DERIVED,  from: 'row.roc3', unit: '%', note: 'MEASURED present (380/814 live, all ledger rows) -> the spec optional 3m input is included' },
  roc5m:           { tag: TAGS.DERIVED,  from: 'row.roc5', unit: '%' },
  roc15m:          { tag: TAGS.DERIVED,  from: 'row.roc15', unit: '%' },
  roc60m:          { tag: TAGS.DERIVED,  from: 'row.roc60', unit: '%' },
  atrPct:          { tag: TAGS.DERIVED,  from: 'row.daily.atrPct', unit: '%' },
  ivEst:           { tag: TAGS.DERIVED,  from: 'row.s30 + row.roc5 spread', note: 'intraday volatility estimate' },

  // ---- executed flow ----
  buyValue:        { tag: TAGS.UNKNOWN,  from: null, note: 'GB has no traded VALUE by side' },
  sellValue:       { tag: TAGS.UNKNOWN,  from: null },
  netOrderValue:   { tag: TAGS.UNKNOWN,  from: null },
  delta:           { tag: TAGS.INFERRED, from: 'row.flowBias', note: 'INFERRED normalized bias (-1..+1), NOT exchange-classified delta' },
  buyPressure:     { tag: TAGS.INFERRED, from: 'rawBuyQty / (rawBuyQty+rawSellQty)', note: 'inherits the classification error' },
  sellPressure:    { tag: TAGS.INFERRED, from: 'rawSellQty / (rawBuyQty+rawSellQty)' },
  volume:          { tag: TAGS.OBSERVED, from: 'row.volume', note: 'MEASURED: only deep-read rows carry it' },
  volumeRatio:     { tag: TAGS.DERIVED,  from: 'row.volX' },
  volumeRoc:       { tag: TAGS.DERIVED,  from: 'row.volRoc' },
  rawBuyQty:       { tag: TAGS.VERIFY,   from: 'row.totBuy',  note: 'SPEC 6.2 CAUTION: may be RESTING order quantity, not executed. Confirm before use as order value.' },
  rawSellQty:      { tag: TAGS.VERIFY,   from: 'row.totSell', note: 'same caution as rawBuyQty' },

  // ---- location ----
  vwap:            { tag: TAGS.DERIVED,  from: 'row.vwap' },
  vwapSlope:       { tag: TAGS.DERIVED,  from: 'row.vwapDrift', note: 'GB calls it a drift; treated as slope evidence' },
  poc:             { tag: TAGS.DERIVED,  from: 'row.poc' },
  vah:             { tag: TAGS.DERIVED,  from: 'row.vaHigh' },
  val:             { tag: TAGS.DERIVED,  from: 'row.vaLow' },
  // MEASURED (25-Sep): these three are present on 380/380 deep rows AND on every one of
  // the 10,508 ledger rows, so the location engine is runnable historically. They were
  // being dropped at the adapter boundary before, which is why POC and value-area
  // evidence never reached a single backtest.
  posInRange:      { tag: TAGS.DERIVED,  from: 'row.posInRange', note: '0-100 position in the day range; DISPLAY-ONLY per spec 14 (no pre-registered weight)' },
  stack:           { tag: TAGS.DERIVED,  from: 'row.vwapStack', note: 'ABOVE ALL / MIXED / BELOW ALL' },
  camZone:         { tag: TAGS.DERIVED,  from: 'row.camZone', note: 'DISPLAY-ONLY: spec 14 defers Camarilla scoring' },

  // ---- candle context (spec 17: display-only in v1; spec 26 deferred) ----
  gapOpenPct:        { tag: TAGS.DERIVED, from: 'row.gap.openPct', note: 'THE GAP BETWEEN CANDLES: session open vs previous close, in %' },
  gapOpenDir:        { tag: TAGS.DERIVED, from: 'row.gap.openDir' },
  gapFillPct:        { tag: TAGS.DERIVED, from: 'row.gap.fillPct', note: '>=100 FILLED, <=0 UNFILLED, between PARTIAL' },
  gapSizeVsAtrX:     { tag: TAGS.DERIVED, from: 'row.gap.sizeVsAtrX', note: 'gap size in ATR units' },
  gapNearestUpPct:   { tag: TAGS.DERIVED, from: 'row.gap.nearestUpPct', note: 'distance to the nearest UNFILLED gap above' },
  gapNearestDownPct: { tag: TAGS.DERIVED, from: 'row.gap.nearestDownPct' },
  gapText:           { tag: TAGS.DERIVED, from: 'row.gapTxt' },
  pattern:           { tag: TAGS.DERIVED, from: 'row.candlePattern', note: "GB's own candle label (BULL ENGULF / HAMMER / DOJI / ...)" },
  trendCounts:       { tag: TAGS.DERIVED, from: 'row.candleTrend', note: 'm1/m2/m3/m5/m15/m30 candle trend words' },
  trendAgree:        { tag: TAGS.DERIVED, from: 'row.candlesAgree' },
  swingAgree:        { tag: TAGS.DERIVED, from: 'row.swingAgree' },
  volAtPrice:        { tag: TAGS.DERIVED, from: 'row.volAtPrice', note: 'e.g. HEAVY-TOP / HEAVY-BOTTOM; display context only' },
  dayHigh:           { tag: TAGS.OBSERVED, from: 'row.dayHigh' },
  dayLow:            { tag: TAGS.OBSERVED, from: 'row.dayLow' },

  // ---- structure ----
  trend1m:         { tag: TAGS.DERIVED,  from: 'row.candleTrend.m1' },
  trend5m:         { tag: TAGS.DERIVED,  from: 'row.candleTrend.m5' },
  trend15m:        { tag: TAGS.DERIVED,  from: 'row.candleTrend.m15' },
  trendDaily:      { tag: TAGS.DERIVED,  from: 'row.dailyTrend' },
  adx:             { tag: TAGS.UNKNOWN,  from: null, note: 'MEASURED: 0/814 rows carry ADX' },
  rsi1m:           { tag: TAGS.UNKNOWN,  from: null, note: 'MEASURED: 0/814 rows carry RSI' },
  rsi5m:           { tag: TAGS.UNKNOWN,  from: null },
  rsi15m:          { tag: TAGS.UNKNOWN,  from: null },

  // ---- context ----
  niftyState:      { tag: TAGS.DERIVED,  from: 'payload.market', note: 'MEASURED: only 54/814 rows carry it' },
  niftyReturn:     { tag: TAGS.UNKNOWN,  from: null },
  sectorReturn:    { tag: TAGS.UNKNOWN,  from: null, note: 'no sector map verified yet (spec Section 10)' },
  beta:            { tag: TAGS.UNKNOWN,  from: null, note: 'placeholder 1.0 per spec Section 10' },

  // ---- reference / static ----
  close:           { tag: TAGS.UNKNOWN,  from: null, note: 'previous close not on the row' },
  avgVol20:        { tag: TAGS.UNKNOWN,  from: null },
  turnover:        { tag: TAGS.DERIVED,  from: 'row.dayValue', note: 'TODAY value, not the 20D average the liquidity gate wants' },
  marketCap:       { tag: TAGS.UNKNOWN,  from: null },
  circuitBand:     { tag: TAGS.UNKNOWN,  from: null },
  surveillance:    { tag: TAGS.UNKNOWN,  from: null },
  eventFlags:      { tag: TAGS.UNKNOWN,  from: null, note: 'event source unverified (spec Section 28 open items)' },
};

/** Tag for a registry field, defaulting to UNKNOWN so an unregistered field is never assumed clean. */
function tagOf(field) {
  const entry = FIELD_REGISTRY[field];
  return entry ? entry.tag : TAGS.UNKNOWN;
}

/** True when a value is genuinely present. `0` IS present; null/undefined/'' are not. */
function isKnown(v) {
  return v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && Number.isNaN(v));
}

/**
 * Classify a value's provenance given the field it came from.
 * A missing value is UNKNOWN regardless of what the field would normally be --
 * "we could not see it" outranks "it would have been derived".
 */
function classify(field, value) {
  if (!isKnown(value)) return TAGS.UNKNOWN;
  return tagOf(field);
}

/**
 * DIRECTIONAL vs MAGNITUDE. The spec's 6.2 concern is specifically about the
 * fields that claim to say WHO was aggressive: "Buy traded value / sell traded
 * value -> INFERRED ... Delta, buy/sell pressure -> INFERRED ... inherits the
 * classification error."
 *
 * Volume, volumeRatio and volumeRoc say HOW MUCH traded, not which side pushed.
 * Treating them as flow-direction evidence is a category error, and it is exactly
 * the error that made an earlier version of this function report "0 inferred-only
 * rows" while every directional reading on the board was in fact inferred.
 */
const DIRECTIONAL_FLOW_KEYS = ['buyValue', 'sellValue', 'netOrderValue', 'delta', 'buyPressure', 'sellPressure'];
const MAGNITUDE_FLOW_KEYS = ['volume', 'volumeRatio', 'volumeRoc'];

/**
 * flowProvenance(flow) -- what kind of evidence is this flow reading, really?
 *
 * `inferredOnly` means: there IS directional flow evidence and NONE of it is
 * observed. That is the reading the spec says may score but must be labelled in
 * validation. A flow block with no directional evidence at all is a different
 * fact (`noDirectional`) and must not be reported as inferred flow.
 */
function flowProvenance(flow = {}) {
  const keys = Object.keys(flow).filter(k => k !== 'provenance');
  const seen = keys.filter(k => isKnown(flow[k]));
  const seenDirectional = seen.filter(k => DIRECTIONAL_FLOW_KEYS.indexOf(k) !== -1);
  const seenMagnitude = seen.filter(k => MAGNITUDE_FLOW_KEYS.indexOf(k) !== -1);
  const hasObservedDirectional = seenDirectional.some(k => tagOf(k) === TAGS.OBSERVED);
  const hasNoDirectional = seenDirectional.length === 0;
  const inferredOnly = !hasNoDirectional && !hasObservedDirectional;
  return {
    observed: seen.filter(k => tagOf(k) === TAGS.OBSERVED),
    derived: seen.filter(k => tagOf(k) === TAGS.DERIVED),
    inferred: seen.filter(k => tagOf(k) === TAGS.INFERRED),
    verify: seen.filter(k => tagOf(k) === TAGS.VERIFY),
    directional: seenDirectional,
    magnitude: seenMagnitude,
    hasObservedDirectional,
    hasNoDirectional,
    inferredOnly,
    note: inferredOnly
      ? 'SPEC 6.2: inferred-only directional flow may score but must be labelled inferred in validation'
      : (hasNoDirectional ? 'no directional flow evidence at all (magnitude only or nothing)' : null),
  };
}

module.exports = { TAGS, FIELD_REGISTRY, DIRECTIONAL_FLOW_KEYS, MAGNITUDE_FLOW_KEYS, tagOf, isKnown, classify, flowProvenance };
