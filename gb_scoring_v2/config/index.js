/**
 * gb_scoring_v2/config/index.js — THE ONE VERSIONED CONFIG (V3 spec Section 2, 17, 24).
 *
 * Spec rule 5: "Weights and thresholds live in one versioned config. Every logged
 * result carries a config hash."
 *
 * Spec rule (Section 17): "No final point weights are fixed before replay validation."
 * So every number below is a PLACEHOLDER. They are collected here, named, and hashed
 * so that a logged outcome can always be traced back to the exact numbers that
 * produced it -- but none of them is a validated tuning decision yet. `weightsLocked`
 * stays false until Phase 15 freezes the config on unseen sessions.
 *
 * Isolation rule: this module is new, and nothing in it writes to or requires the
 * existing backend. The old engine keeps running untouched.
 */
const crypto = require('crypto');

// Bumped by hand when the shape of the config changes (not for value tweaks --
// value tweaks are captured by the hash alone).
const SCHEMA_VERSION = '3.0.0-phase0';

// ---------------------------------------------------------------------------
// STABLE SERIALIZATION. JSON.stringify follows insertion order, which makes the
// hash depend on how the object happens to be written. A config hash that moves
// when nobody changed a value is worse than no hash at all, so keys are sorted.
// ---------------------------------------------------------------------------
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

const CONFIG = {
  schemaVersion: SCHEMA_VERSION,

  // -------------------------------------------------------------------------
  // PRE-REGISTRATION — fixed 25-Sep, BEFORE the first backtest run.
  // Why it is in the config and not in a document: the config is hashed and logged with every
  // result, so the report can PROVE these rules predate the numbers they judge. A kill criterion
  // chosen after seeing results is not a kill criterion, and this repo's own rule (Section 21.1)
  // is that changing a locked decision starts a new validation cycle rather than editing history.
  // -------------------------------------------------------------------------
  preRegistration: {
    lockedAt: '2026-09-25',
    // The three verdicts. FAIL is a real outcome, not a soft pass: the layers that individually
    // worked are kept as evidence and the gate gets no live authority.
    outcomes: {
      PASS: 'every kill condition holds — the rehost may proceed',
      FAIL: 'any kill condition fails — the gate is NOT rehosted',
      INCONCLUSIVE: 'the interval spans zero, or fewer than 5 usable sessions — layers validated, gate stay paper-only',
    },
    killCriterion: {
      K1: 'the new engine\'s signed forward mean must not be worse than the old engine\'s on the identical episodes',
      K2: 'the new engine\'s stop-before-target rate must be STRICTLY lower than the old engine\'s (this is the shape behind a very bad day, so it gets its own rule)',
      K3: 'the sign of the edge must survive with the delta layer EXCLUDED — if only the bar-level proxy carries it, the gate is not certified',
      K4: 'the primary metric must be positive in the MAJORITY of sessions, not only in aggregate',
      minSessions: 5,
      note: 'conditions are ANDed; a single failure is FAIL, not a lower grade',
    },
    // The signal precedence table. Total order, no ambiguity: a reviewer must be able to predict
    // the result of any engine pair without reading the code.
    signalSources: {
      mode: 'veto-only',              // 'veto-only' (live) | 'strict' (reported as a backtest arm)
      requireSameSide: true,
      blockedOutranks: true,          // a governance veto from EITHER engine is BLOCKED
      conflictResult: 'WATCH',
      conflictReason: 'the two engines disagree on side',
      ofOnlyTag: 'OF only (V3 under-scored)',
      whyVetoOnly: 'V3 scores momentum-CONTINUATION evidence; the order-flow gate is a REVERSAL gate. Requiring V3\'s own SIGNAL would make a gate that fires on exhausted moves almost unfireable, and the strict variant is measured in the backtest instead of being assumed',
    },
  },

  // -------------------------------------------------------------------------
  // Section 21.1 -- THE PRIMARY METRIC, LOCKED BEFORE THE FIRST VALIDATION RUN.
  // It is in the config on purpose: changing it is a visible, hashed act, not a
  // quiet edit after seeing results. Spec: "Once locked, it cannot change after
  // results are seen without starting a new validation cycle."
  // -------------------------------------------------------------------------
  validation: {
    metric: 'mean market-adjusted net return at +5m, top-tercile minus bottom-tercile of new-engine score',
    aggregation: 'computed per session, then averaged across sessions',
    interval: 'confidence interval from resampling SESSIONS (day-level, not tick-level)',
    passCondition: 'interval excludes zero AND spread exceeds the old engine on the same episodes',
    locked: false,               // flips true at Phase 13, before the first run
    lockedAt: null,
    // Spec 21.2 -- the unit of analysis is the deduplicated EPISODE and the SESSION.
    effectiveSampleGuideline: { episodes: 'several hundred', sessions: '>= 15', note: 'the interval decides, not the count' },
    // Spec 21.5 -- only the pre-registered metric is a result; everything else is a hypothesis.
    multipleTesting: 'only the pre-registered primary metric counts; other findings are hypotheses for the next cycle',
  },

  // -------------------------------------------------------------------------
  // Section 8 -- GATES. Placeholders, cheapest-first evaluation order.
  // `onMissing`: 'block' | 'watch'  (spec: BLOCK vs cap-at-WATCH)
  // -------------------------------------------------------------------------
  gates: {
    order: ['data', 'latency', 'liquidity', 'exclusion', 'priceBand', 'spread', 'time', 'warmup', 'event', 'cost', 'direction', 'conflict', 'market'],
    // NOTE (25-Sep): the gates' coarse location read now delegates to
    // gb_scoring_v2/location, so POC and the value area participate in GATE_DIRECTION
    // and GATE_CONFLICT instead of VWAP alone. That also removed a 200x scale bug in
    // the old read which made location almost never register as opposing.
    data:      { code: 'GATE_DATA',       onMissing: 'block', requirePricePositive: true, requireFieldsForSetup: true },
    latency:   { code: 'GATE_LATENCY',    onMissing: 'watch', maxReceiptLagMs: 5000 },
    liquidity: {
      code: 'GATE_LIQUIDITY', onMissing: 'block',
      minClose: 100,
      // MEASURED CORRECTION to the spec. Section 8 lists this as "8 lakh (existing GB
      // starting values)", but GB's actual floor is 3,00,000 and the measured
      // distribution of the 995-name quality set is:
      //   avgVol20  min 3,406 | p10 78,861 | p25 207,375 | p50 539,530 | p90 3,886,328
      // The MEDIAN name does 5,39,530 -- below 8,00,000. At 8 lakh the gate blocked
      // 224 of 380 deep rows (62% of the universe) for a number the spec claims to
      // have inherited from GB. Decision (25-Sep): align with GB's existing value,
      // which is what the spec says these thresholds ARE. Override with
      // GB_GATE_MIN_AVGVOL20 to restore the spec's literal 800000.
      minAvgVol20: Number(process.env.GB_GATE_MIN_AVGVOL20 || 300000),
      minTurnoverCr: 5, minMarketCapCr: 500,
      minAtrPct: 1.5, maxAtrPct: 6,      // existing GB starting values (spec Section 8)
    },
    exclusion: { code: 'GATE_EXCLUDED',    onMissing: 'watch', excludeSme: true, excludeT2T: true, excludeBanned: true, excludeLocked: true },
    priceBand: { code: 'GATE_PRICE_BAND',  onMissing: 'watch', minDistanceToCircuitPct: 1.0 },
    spread:    { code: 'GATE_SPREAD',      onMissing: 'watch', maxSpreadPct: 0.15, requiresBestBidAsk: true },
    time:      { code: 'GATE_TIME',        onMissing: 'block', noSignalFirstMin: 15, noSignalLastMin: 15 },
    warmup:    { code: 'GATE_WARMUP',      onMissing: 'watch', rsiPeriod: 14 },
    event:     { code: 'GATE_EVENT',       onMissing: 'watch', blockOnResultsDay: false },
    cost:      { code: 'GATE_COST',        onMissing: 'watch', minAtrMultipleOfCost: 2.5 },
    direction: { code: 'GATE_DIRECTION',   onMissing: 'block', minIndependentGroups: 3 },
    conflict:  { code: 'GATE_CONFLICT',    onMissing: 'block', strongOpposition: 0.5 },
    market:    { code: 'GATE_MARKET',      onMissing: 'watch', blockWhenNiftyOpposed: true },
  },

  // -------------------------------------------------------------------------
  // Section 9 -- VOLATILITY-NORMALIZED ROC.
  // z_h = ROC_h / sigma_h ; e_h = clip(z_h, -3, +3) / 3   -> bounded [-1, +1]
  // -------------------------------------------------------------------------
  roc: {
    clipZ: 3,
    fastHorizons: ['10s', '20s', '30s'],
    structuralHorizons: ['1m', '5m', '15m'],
    optionalHorizons: ['3m'],          // spec: only if GB already builds 3m bars
    // sigma_h starting estimate: ATR14% scaled to the horizon. PLACEHOLDER scaling.
    // Expected move over each horizon, as a FRACTION of ATR14%.
    // '3m' is present because the feed verifiably builds a 3m ROC (measured), so the
    // spec's optional structural input is included. Without an entry here the 3m
    // reading silently contributes nothing while still being reported as included.
    sigmaFromAtr: { '10s': 0.06, '20s': 0.09, '30s': 0.12, '1m': 0.20, '3m': 0.60, '5m': 1.00, '15m': 2.00 },
    timeOfDayAdjust: { enabled: true, openFactor: 1.4, closeFactor: 1.2 },   // PLACEHOLDER
  },

  // -------------------------------------------------------------------------
  // Section 11 -- EXECUTED FLOW. Spec 11 + Appendix A: flow = 16 points total.
  // "Buy value, delta and pressure describe one phenomenon and collapse into one
  // flow value per window; volume ratio modifies strength."
  // -------------------------------------------------------------------------
  flow: {
    windows: ['10s', '20s', '30s', '1m'],
    points: { direction: 5, strength: 4, persistence: 3, confirmation: 4 },   // = 16
    persistenceMinWindows: 3,
    // Section 12 -- price vs flow states. DIVERGENT has no points of its own.
    states: { CONFIRMED: 'full', WEAK: 'partial', DIVERGENT: 'zero + feeds exhaustion', UNKNOWN: 'no points; caps at WATCH' },
  },

  // -------------------------------------------------------------------------
  // Section 10 -- RELATIVE STRENGTH vs NIFTY / sector. 4 points. Stock-specific.
  // The NIFTY market GATE is context only and carries no points, so the two
  // cannot double-count.
  // -------------------------------------------------------------------------
  relativeStrength: { points: 4, windows: ['5m', '15m'], beta: 1.0, betaPlaceholder: true },

  // -------------------------------------------------------------------------
  // Section 13 -- EXHAUSTION. VETO / REASON ONLY in v1 (no counter-trend signals).
  // -------------------------------------------------------------------------
  exhaustion: {
    v1Mode: 'veto-and-reason-only',
    priorMoveHorizons: ['5m', '15m'],
    minPriorMoveZ: 1.5,                       // PLACEHOLDER
    conditions: ['priorMove', 'notAccelerating', 'freshFlowDeteriorating', 'divergent', 'rsiExtended', 'atLevel'],
    severity: { HIGH: { kOfN: 4, action: 'BLOCKED', code: 'VETO_EXHAUSTION' }, WARNING: { kOfN: 2, action: 'cap WATCH', code: 'RISK_EXHAUSTION_WARN' } },
    logForwardOutcomes: true,                 // "every WARNING/HIGH event is logged with forward outcomes"
  },

  // -------------------------------------------------------------------------
  // Section 14 -- LOCATION (VWAP / POC / value area). 10 points, direction-aligned.
  // `fullPct` is the distance that counts as FULL conviction for each reading, as a
  // fraction: 0.5% away from VWAP is a full read, half the value-area width away from
  // POC is a full read, and one stack step is worth 0.5. These are placeholders and
  // they are the values the gates and the location engine SHARE -- a second copy is
  // how the two drifted apart before.
  // -------------------------------------------------------------------------
  location: {
    points: 10,
    valueAreaFromVwapPct: 0.10,
    rejectFromLevelPct: 0.05,
    pocFallbackPct: 0.005,                       // used only when VAH/VAL are absent
    fullPct: { vwap: 0.005, poc: 0.5, valueArea: 0.5, stack: 0.5 },
  },

  // -------------------------------------------------------------------------
  // CANDLE CONTEXT (spec 17 "Display-only in v1"; spec 26 deferred; spec 4 removed
  // micro-gap logic). GB computes all of this already and the adapter used to throw it
  // away before recording, which meant it could never be backtested. It is surfaced and
  // recorded now, but `scored` stays FALSE: spec 17 gives candle context 0 points, and
  // spec 21.6 says a deferred component earns points only by improving out-of-sample
  // separation. Flipping `scored` to true is a deliberate, hashed act.
  // -------------------------------------------------------------------------
  candles: {
    scored: false,
    points: 0,
    displayOnlyPer: 'spec Section 17 (candle context: 0, display-only in v1)',
    deferredPer: 'spec Section 26 (re-entry condition: scored only at meaningful levels with confirming flow, small weight)',
    gap: {
      fullAtrX: 0.5,          // a gap of half an ATR is a full-size gap
      proximityPct: 0.4,      // an unfilled gap within this % is a magnet risk, not evidence
    },
    // Candle GEOMETRY thresholds, for the real-OHLC path (candles/sequence.js). These
    // are the boundaries that turn OHLC into a label, so they are config, not magic
    // numbers buried in the classifier: a reader can move them and re-run.
    geometry: {
      dojiBodyPct: 0.1,       // body <= 10% of range -> DOJI (indecision wins over every other test)
      marubozuBodyPct: 0.9,   // body >= 90% of range -> MARUBOZU
      wickMultiple: 2.0,      // a wick at least 2x the body, with a small opposite wick -> HAMMER / SHOOTING STAR
      flatGapPct: 0.05,       // bar-to-bar gap within +/-0.05% counts as FLAT, not a gap
    },
    // The measured next-candle study (candles/sequence.js + candle-study.js).
    sequence: {
      lookbacks: [3, 6, 12, 24],   // "use back more" is tested, not assumed
      minSamples: 200,             // a bucket thinner than this is refused, not guessed
      confidentP: 0.55,            // pUp at or beyond this, either way, counts as a directional call
      trainFraction: 0.7,          // sessions: earliest 70% train, latest 30% held out
    },
  },

  // -------------------------------------------------------------------------
  // Section 15/16 -- TREND (8) and RSI (5).
  // Spec 16: RSI is context and extension, NEVER the reason for a decision.
  // -------------------------------------------------------------------------
  trend: { points: 8, horizons: ['1m', '5m', '15m'], useStructureNotRoc: true },
  rsi: {
    points: 5,
    setupTimeframe: '1m',                     // may adjust RSI points by at most +/-1
    contextTimeframes: ['5m', '15m'],
    contextBandsLong: [                        // SHORT mirrors (100 - RSI)
      { max: 45, points: 0 }, { max: 50, points: 1 }, { max: 55, points: 3 },
      { max: 65, points: 5 }, { max: 70, points: 3 }, { max: 75, points: 1 },
      { max: 100, points: 0, extension: true },
    ],
    extensionFlagAt: 70,
  },

  // -------------------------------------------------------------------------
  // Section 17 -- THE 58-POINT LEDGER. Appendix A fixes the split that the
  // previous plan left inconsistent: momentum 15, flow 16, RS 4, location 10,
  // trend 8, RSI 5 = 58.
  // -------------------------------------------------------------------------
  score: {
    totalPoints: 58,
    groups: {
      momentum: { points: 15, fast: 6, structural: 6, acceleration: 3 },
      flow:     { points: 16, direction: 5, strength: 4, persistence: 3, confirmation: 4 },
      relativeStrength: { points: 4 },
      location: { points: 10 },
      trend:    { points: 8 },
      rsi:      { points: 5 },
    },
    weightsLocked: false,                     // spec: "not fixed before replay"
    note: 'weights are chosen only after the baseline and replay show which groups add out-of-sample separation',
    // Section 17 -- coverage.
    coverage: { minForSignal: 0.7, capsAtWatchBelow: 0.5 },
    // Section 18 -- three states only.
    //
    // CALIBRATED, AND LABELLED AS PROVISIONAL. The spec's "34 of 58" was never reachable on
    // this feed: the score only spends points on MEASURED evidence, and this feed has no
    // flow, RSI, sector or beta -- so 33 points have a source and the rest leave the
    // denominator. Measured on 2026-09-25 over 322 eligible (non-BLOCKED) rows, the score max
    // was 10.2 and 34/58 would have required 19.3 -> ZERO signals, forever, by construction.
    //
    // The bar is therefore set by a RULE rather than a taste: SIGNAL = p97 of the eligible
    // score distribution, WATCH = p85. On that session p97 = 8.46 and p85 = 5.49 of 33
    // available, which is 14.9 / 9.7 when expressed against the full 58 and scaled back at
    // score time. It is selective (a few percent of eligible rows) and it is AUDITABLE.
    //
    // This is calibration on the EVIDENCE distribution, NOT on outcomes -- no trade result
    // informed it, and the standing rule against tuning on the current day's outcomes holds.
    // It is provisional: re-derive once 15 sessions exist, and expect/accept drift.
    decision: { signalThreshold: 14.9, watchThreshold: 9.7, allowWatchTrigger: true },
    // TIMING AND FRAME-QUALITY GUARDS. REFUSALS, not tuned thresholds — each states a way a
    // signal loses money that has nothing to do with how many points it scored:
    //   phaseVeto       the move's own lifecycle (measured magnitude + last-10s velocity).
    //                   Entering LATE/EXHAUSTED is chasing a move that already happened, which
    //                   is the most common way a CORRECT direction still loses.
    //   coherencePct    buying while BOTH the 5m and 15m frames fall (and the mirror). The fast
    //                   10-50s windows can be green inside a falling slow frame — that is a
    //                   bounce inside a downtrend, not a trend.
    //   requireSlowFrame a row whose whole context is tick-scale data has no frame to trade in.
    // Chosen from market mechanism, NOT from outcomes; `provisional: true` records that they
    // have not been replay-validated, and the standing rule against tuning on the current day's
    // results applies to them exactly as it does to the score threshold.
    guards: {
      phaseVeto: ['LATE', 'EXHAUSTED'],
      coherencePct: 0.25,
      requireSlowFrame: true,
      // The 20-second frame (read from the 10-second sample grid) vetoes the OPPOSITE side past
      // this. Refusal, not a scored point; 0 disables it. The slow frames are a minute-scale
      // statement, so this is the only guard that speaks for the last few seconds of tape.
      fastOpposePct: 0.15,
      provisional: true,
      note: 'refusals, not scored points; a timing refusal is reported separately from a low score',
    },
    calibration: {
      at: '2026-09-25',
      rule: 'SIGNAL = p97 and WATCH = p85 of the eligible (non-BLOCKED) score distribution',
      calibratedAgainst: 'evidence distribution only — no outcome data used',
      specThreshold: 34,
      specThresholdVerdict: 'unreachable on this feed: required 19.3 of 33 available against a measured max of 10.2',
      measured: { rows: 322, p50: 0, p85: 5.49, p90: 6.5, p95: 7.87, p97: 8.46, p99: 8.83, max: 10.2, unit: 'points of 33 available' },
      provisional: true,
      revalidateAfter: '15 sessions',
    },
  },

  // -------------------------------------------------------------------------
  // Section 19 -- EPISODES. A 10-second scanner rediscovers the same setup
  // repeatedly; identical persistent states must not be counted as trades.
  // -------------------------------------------------------------------------
  episodes: {
    key: 'symbol+direction',
    startOn: 'SIGNAL',
    trackWatchSeparately: true,
    endOn: ['belowThresholdForMs', 'blocked', 'directionFlip'],
    belowThresholdForMs: 60000,
    cooldownMs: 120000,
    requireNewTrigger: true,
    sectorClusterWindowMs: 300000,
  },

  // -------------------------------------------------------------------------
  // Section 20 -- OUTCOME SIM. Entry realism: NOT the signal-time price.
  // "No hard-coded fee numbers in this specification" -> costs are parameters.
  // -------------------------------------------------------------------------
  outcome: {
    latencyMs: 800,                           // entry at first tradable price after signal + L
    horizons: ['1m', '3m', '5m', '10m'],
    entry: { longAtAsk: true, shortAtBid: true, fallbackHalfSpread: true },
    stopAtrX: 0.6, targetAtrX: 1.2, timeStopMin: 20,      // PLACEHOLDER (mirrors GB's existing ATR band)
    costs: { brokeragePerOrder: null, sttPct: null, exchangePct: null, gstPct: null, stampPct: null, slippagePct: null, note: 'parameterized for the user broker/segment -- values not fixed in this spec' },
    latencySensitivity: ['800ms', '2500ms'],
  },

  // -------------------------------------------------------------------------
  // Section 7.1 -- RECORDING + RETENTION (defined up front; raw data is the
  // most valuable asset in the project).
  // -------------------------------------------------------------------------
  recording: {
    dir: 'data/v2_sessions',
    format: 'jsonl-append-only',
    retentionDays: 400,
    writeQueueMax: 20000,
    flushIntervalMs: 250,
    onOverflow: 'drop-and-count',              // recording must NEVER slow the live path
  },

  // Section 26 -- what is explicitly deferred, so a later reader cannot mistake
  // a missing feature for an oversight.
  deferred: ['frvp', 'candleContext', 'camarillaScoring', 'regimeDetection', 'orderBookDynamics', 'absorption', 'sweeps', 'tape', 'top5DepthImbalance'],
  removed: ['microGap', 'gapFill', 'fastRsi', 'rsi10s20s30s', 'standalone3m'],
};

/** sha1 of the stably-serialized config, 12 hex chars. Every logged result carries this. */
function hash(cfg = CONFIG) {
  return crypto.createHash('sha1').update(stableStringify(cfg)).digest('hex').slice(0, 12);
}

/** The header that stamps every logged record. */
function stamp(cfg = CONFIG) {
  return { configHash: hash(cfg), schemaVersion: SCHEMA_VERSION, weightsLocked: cfg.score.weightsLocked, metricLocked: cfg.validation.locked };
}

module.exports = { CONFIG, SCHEMA_VERSION, hash, stamp, stableStringify };
