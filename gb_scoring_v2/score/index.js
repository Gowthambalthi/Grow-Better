/**
 * Phase 11 — SCORE + DECISION.
 *
 * Turns MEASURED evidence into the spec's 58-point score and one of exactly three states:
 * SIGNAL / WATCH / BLOCKED. This is the only module in V3 permitted to say "this is a trade".
 * Everything upstream (adapter, gates, momentum, location, candles) reports evidence; nothing
 * upstream decides.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF ABSENCE — the distinction that makes SIGNAL reachable at all
 * ---------------------------------------------------------------------------
 * NOT-RUNNABLE  a sensor that was never fitted. RSI, ADX, sector return and beta do not exist
 *               in this feed at all. A not-runnable group leaves the DENOMINATOR: you do not
 *               refuse a trade because a gauge you never installed reads nothing.
 *
 * MISSING       a sensor we DO own that is silent on this row (late, stale, absent value).
 *               Its points stay in the denominator and score zero, so it can only ever make
 *               the engine MORE cautious. Unknown never gets the benefit of the doubt.
 *
 * The threshold therefore scales to AVAILABLE points. Demanding a fixed 34 of 58 while only
 * 33 points have any measurable source is a state machine in which SIGNAL can never occur —
 * which is precisely the trap the old board fell into (0 BUY across 545 rows, every row
 * capped at WATCH by construction).
 *
 * ---------------------------------------------------------------------------
 * WHAT STILL OWNS THE VETO
 * ---------------------------------------------------------------------------
 * Gates. A BLOCKED row is BLOCKED whatever the score says, and news can never change that
 * (plan §2). Coverage below config.score.coverage.capsAtWatchBelow also caps at WATCH.
 * Nothing here can promote a row past a gate.
 */
// NOTE the explicit /index path: gb_scoring_v2/config.js is a superseded draft FILE that
// shadows the config DIRECTORY under Node's resolution order.
const { CONFIG } = require('../config/index');

const TOTAL = CONFIG.score.totalPoints;

/** Clamp a signed conviction to 0..1 in the direction asked for. Disagreement scores 0. */
function agree(value, direction) {
  if (value == null || direction == null) return null;
  const v = Math.max(-1, Math.min(1, value));
  const want = direction === 'UP' ? 1 : -1;
  return v * want > 0 ? Math.abs(v) : 0;
}

function num(x) { return typeof x === 'number' && Number.isFinite(x) ? x : null; }

/**
 * Direction vocabularies differ across the codebase (LONG/SHORT upstream, UP/DOWN here).
 * Normalise at the boundary: a mismatch does not throw, it just makes every group score
 * zero and silently turns the whole engine into WATCH — the exact failure this phase exists
 * to end. So accept both spellings.
 */
function normDir(d) {
  const x = String(d == null ? '' : d).toUpperCase();
  if (x === 'UP' || x === 'LONG' || x === 'BUY' || x === 'BULL') return 'UP';
  if (x === 'DOWN' || x === 'SHORT' || x === 'SELL' || x === 'BEAR') return 'DOWN';
  return null;
}

/**
 * Which regions of the snapshot each group needs. `owned` says whether THIS SYSTEM has a
 * source for the group at all — that is what separates not-runnable from missing, and it is
 * declared rather than inferred so wiring a new source is one line here.
 */
const GROUPS = [
  {
    name: 'momentum', points: 15, owned: true,
    sub: [
      { name: 'fast', points: 6, read: (s, d) => agree(s.momentum && s.momentum.fast, d) },
      { name: 'structural', points: 6, read: (s, d) => agree(s.momentum && s.momentum.structural, d) },
      { name: 'acceleration', points: 3, read: (s, d) => agree(s.momentum && s.momentum.acceleration, d) },
    ],
  },
  {
    // Order flow exists in the raw feed but is INFERRED, not observed, and it is not carried
    // onto this board's rows yet. Declared not-owned rather than scored from a guess.
    name: 'flow', points: 16, owned: false,
    sub: [
      { name: 'direction', points: 5, read: (s, d) => agree(s.flow && s.flow.value, d) },
      { name: 'strength', points: 4, read: (s) => num(s.flow && s.flow.strength) },
      { name: 'persistence', points: 3, read: (s) => num(s.flow && s.flow.persistence) },
      { name: 'confirmation', points: 4, read: (s) => num(s.flow && s.flow.confirmation) },
    ],
  },
  {
    // No NIFTY series and no sector/beta source is wired yet — the documented blocker.
    name: 'relativeStrength', points: 4, owned: false,
    sub: [{ name: 'vsIndex', points: 4, read: (s) => num(s.relativeStrength && s.relativeStrength.value) }],
  },
  {
    name: 'location', points: 10, owned: true,
    sub: [{ name: 'position', points: 10, read: (s, d) => agree(s.location && s.location.value, d) }],
  },
  {
    // Trend is read from the candle trend and the structural momentum — both measured here,
    // so this group is owned. It is deliberately NOT a stand-in for RSI/ADX.
    name: 'trend', points: 8, owned: true,
    sub: [
      { name: 'candleTrend', points: 5, read: (s, d) => agree(s.candles && s.candles.trendValue, d) },
      { name: 'structure', points: 3, read: (s, d) => agree(s.candles && s.candles.structureValue, d) },
    ],
  },
  {
    name: 'rsi', points: 5, owned: false,
    sub: [{ name: 'rsi', points: 5, read: (s) => num(s.rsi) }],
  },
];

// How much of the measured weight must point one way before a side is claimed at all.
const DIRECTION_MIN_SHARE = 0.15;

/**
 * THE SIDE, DERIVED FROM THIS ENGINE'S OWN EVIDENCE.
 *
 * This closes a real defect found by running the scorer over the live board: direction was
 * being read from the OLD engine's row (`want`/`signal`), so every row the old engine had not
 * labelled scored ZERO in every group — only 10 of 552 live rows scored at all. That is not a
 * shadow read of the same market, it is a re-scoring of the old engine's own opinions, which
 * is exactly the dependency that has to go. The side now comes from measured evidence alone.
 *
 * Each conviction is weighted by the points it is worth in the score, so the side reflects
 * what actually moves the score rather than what is merely present. A net below the floor is
 * not a weak direction, it is NO direction: mixed evidence must not be forced into a trade.
 */
function directionFromEvidence(s) {
  const terms = [
    [s.momentum && s.momentum.fast, 6],
    [s.momentum && s.momentum.structural, 6],
    [s.location && s.location.value, 10],
    [s.candles && s.candles.trendValue, 5],
  ];
  let net = 0, weight = 0;
  for (const [v, w] of terms) {
    const x = num(v);
    if (x == null) continue;
    weight += w;
    net += Math.max(-1, Math.min(1, x)) * w;
  }
  if (weight === 0) return null;
  if (Math.abs(net) < DIRECTION_MIN_SHARE * weight) return null;
  return net > 0 ? 'UP' : 'DOWN';
}

/** ATR for the stop/target band, wherever the snapshot happens to carry it. */
function atrPctOf(s) {
  const cands = [
    s.atrPct,
    s.reference && s.reference.atrPct,
    s.screening && s.screening.atrPct,
    s.volatility && s.volatility.atrPct,
  ];
  for (const c of cands) if (typeof c === 'number' && c > 0) return c;
  return null;
}

// A stop that is closer than this is stopped by noise; one further than this is no longer
// about the setup being traded.
const RISK_MIN_PCT = 0.15;
const RISK_MAX_PCT = 3.0;

// ---------- TIMING AND FRAME QUALITY ----------
// THE MOST EXPENSIVE KIND OF WRONG SIGNAL IS A CORRECT DIRECTION ENTERED LATE. The board already
// measured the move's own lifecycle (`phase`: EARLY / MID / LATE / EXHAUSTED, from the ladder's
// magnitude plus the last-10s velocity) and the 1m/3m/5m/15m ladder — and NONE of it reached the
// decision: build-board computed the phase and then handed the scorer only momentum, location and
// candles. So the engine could score a row strongly on a move whose easy part was already gone,
// which is exactly the "wrong signal that creates a huge loss" the user reported. These are
// REFUSALS, not tuned thresholds: they say this row cannot be a trade on structural grounds.
const _guards = (CONFIG.score && CONFIG.score.guards) || {};
const PHASE_VETO = new Set((Array.isArray(_guards.phaseVeto) ? _guards.phaseVeto : ['LATE', 'EXHAUSTED'])
  .map((x) => String(x).toUpperCase()));
const COHERENCE_PCT = typeof _guards.coherencePct === 'number' ? _guards.coherencePct : 0.25;
const REQUIRE_SLOW_FRAME = _guards.requireSlowFrame !== false;
// THE FAST FRAME GETS A VETO TOO, and it is the one that would have caught the losing buys. The
// slow frames say what the session is doing; the 10-SECOND GRID (ROC 20s) says what the tape is
// doing RIGHT NOW. A buy whose own 20-second frame is falling by more than this is buying into
// the move it is supposed to be front-running — the single most common shape of a wrong signal.
// It is a refusal, not a scored point, and it is bounded by the grid's own slack so it can only
// fire on a frame that actually resolves.
const FAST_OPPOSE_PCT = typeof _guards.fastOpposePct === 'number' ? _guards.fastOpposePct : 0.15;

/**
 * Timing verdict for a snapshot that carries a `timing` block ({phase, phaseNote, roc1m, roc3m,
 * roc5m, roc15m}). Deliberately inert when the block is absent, so a caller that has only the
 * scored evidence (unit tests, replays of bare snapshots) is not silently vetoed for missing
 * something it was never given.
 *
 * Four refusals, each answering a distinct way a signal loses money:
 *   1. the move is over      — phase LATE/EXHAUSTED (chasing)
 *   2. the frame disagrees   — buying while BOTH the 5m and 15m frames fall, and the mirror;
 *                              the fast windows can be green inside a falling slow frame, which
 *                              is a bounce, not a trend
 *   3. there is no frame     — every slow frame unreadable, so the row's context rests on
 *                              tick-scale data alone
 *   4. the tape is opposite  — the 20s grid frame falls while the row wants to buy (mirror for
 *                              sells). Added with the 10-second sample grid: the slow frames are
 *                              a minute-scale statement, and a buy can look right on them while
 *                              the last 20 seconds are going the other way.
 */
function timingVerdict(s, direction) {
  const t = s.timing;
  if (!t || typeof t !== 'object') return { applied: false, blockers: [] };
  const blockers = [];
  const phase = t.phase == null ? null : String(t.phase).toUpperCase();
  if (phase && PHASE_VETO.has(phase)) {
    blockers.push('move already made (phase ' + phase + (t.phaseNote ? ' — ' + t.phaseNote : '') + ')');
  }
  const r5 = num(t.roc5m), r15 = num(t.roc15m);
  if (direction && COHERENCE_PCT > 0 && r5 != null && r15 != null) {
    const up = direction === 'UP';
    if (up && r5 <= -COHERENCE_PCT && r15 <= -COHERENCE_PCT) {
      blockers.push('buying into a falling 5m AND 15m frame (' + r5 + '% / ' + r15 + '%)');
    }
    if (!up && r5 >= COHERENCE_PCT && r15 >= COHERENCE_PCT) {
      blockers.push('selling into a rising 5m AND 15m frame (+' + r5 + '% / +' + r15 + '%)');
    }
  }
  // 4. the tape is going the other way — the 20s grid frame, read from the 10-second sample
  //    series, opposes the intended side by more than the noise floor.
  const r20s = num(t.roc20s);
  if (direction && r20s != null && FAST_OPPOSE_PCT > 0) {
    const up = direction === 'UP';
    if (up && r20s <= -FAST_OPPOSE_PCT) blockers.push('buying while the 20s frame falls (' + r20s + '% over 20s)');
    if (!up && r20s >= FAST_OPPOSE_PCT) blockers.push('selling while the 20s frame rises (+' + r20s + '% over 20s)');
  }
  const slowKnown = [num(t.roc3m), r5, r15].filter((v) => v != null).length;
  if (REQUIRE_SLOW_FRAME && slowKnown === 0) {
    blockers.push('no readable 3m/5m/15m frame — tick-scale read only');
  }
  return { applied: true, phase, slowKnown, roc10s: num(t.roc10s), roc20s: r20s, roc30s: num(t.roc30s), blockers };
}

/**
 * Entry / stop / target. Returns null rather than inventing a risk level: a SIGNAL with no
 * stop is not tradeable, and a fabricated one is worse than an absent one.
 *
 * The primary basis is STRUCTURAL, not a volatility multiple, because this feed carries no
 * ATR at all (verified: reference, screening and the top level all lack it). What it does
 * carry is measured levels — VWAP, value area, POC, day high/low, prior close — so the stop
 * goes at the nearest one that sits on the losing side and is between RISK_MIN_PCT and
 * RISK_MAX_PCT away. The basis is named on the plan so it can be challenged.
 *
 * Targets keep the two config multiples as one fixed reward:risk, reported rather than
 * implied. The ATR path stays as a fallback for the day a real ATR source is wired in.
 */
function planFor(s, direction) {
  const price = num(s.price);
  if (price == null || price <= 0 || !direction) return null;
  const up = direction === 'UP';
  const L = s.levels || {};
  const stopX = CONFIG.outcome.stopAtrX, tgtX = CONFIG.outcome.targetAtrX;
  const rrFixed = stopX > 0 ? tgtX / stopX : 2;

  const cands = [];
  const push = (name, v) => { const x = num(v); if (x != null && x > 0) cands.push({ name, v: x }); };
  push('VWAP', L.vwap);
  push('value-area low', L.val);
  push('value-area high', L.vah);
  push('POC', L.poc);
  push('day low', L.dayLow);
  push('day high', L.dayHigh);
  push('prior close', L.prevClose);

  const usable = cands
    .map((c) => Object.assign({}, c, { distPct: ((up ? price - c.v : c.v - price) / price) * 100 }))
    .filter((c) => c.distPct >= RISK_MIN_PCT && c.distPct <= RISK_MAX_PCT)
    .sort((a, b) => a.distPct - b.distPct)[0];

  if (usable) {
    const risk = Math.abs(price - usable.v);
    const t1 = up ? price + risk * rrFixed : price - risk * rrFixed;
    return {
      entry: +price.toFixed(2),
      stop: +usable.v.toFixed(2),
      t1: +t1.toFixed(2),
      rr: +rrFixed.toFixed(2),
      riskPct: +(((risk / price) * 100).toFixed(3)),
      basis: usable.name + ' (' + usable.distPct.toFixed(2) + '% away)',
    };
  }

  const atr = atrPctOf(s);
  if (atr == null) return null;
  const move = (x) => (price * x * atr) / 100;
  const stop = up ? price - move(stopX) : price + move(stopX);
  const t1 = up ? price + move(tgtX) : price - move(tgtX);
  const risk = Math.abs(price - stop);
  return {
    entry: +price.toFixed(2),
    stop: +stop.toFixed(2),
    t1: +t1.toFixed(2),
    rr: +rrFixed.toFixed(2),
    riskPct: +(((risk / price) * 100).toFixed(3)),
    basis: 'ATR ' + atr + '% x stopAtrX=' + stopX,
  };
}

/**
 * Score one row and decide.
 *
 * @param {object} s        a V3 snapshot, already enriched with momentum/location/candles
 * @param {object} opts     { gates } — the Phase 4 result, which owns the veto
 * @returns {{status,direction,points,availablePoints,requiredPoints,watchPoints,coverage,
 *            groups,missing,notRunnable,text,plan}}
 */
function score(s, opts = {}) {
  const gates = opts.gates || {};
  // An explicit direction is honoured (the caller may have one); otherwise the engine derives
  // its own from evidence. It no longer falls back to the old engine's row.
  const given = normDir(opts.direction) || normDir(s.direction);
  const direction = given || directionFromEvidence(s);
  const directionSource = given ? 'given' : (direction ? 'evidence' : null);

  let points = 0, availablePoints = 0, notRunnablePoints = 0, measuredPoints = 0;
  const groups = [], missing = [], notRunnable = [];

  for (const g of GROUPS) {
    const subs = [];
    let got = 0, measurable = 0, anyValue = false;

    for (const sub of g.sub) {
      let v = null;
      try { v = sub.read(s, direction); } catch (_) { v = null; }
      if (v != null) { anyValue = true; measurable += sub.points; got += Math.max(0, Math.min(1, v)) * sub.points; }
      subs.push({ name: sub.name, points: +got.toFixed(2), max: sub.points, measured: v != null, value: v == null ? null : +v.toFixed(3) });
    }

    let state;
    if (!g.owned) state = 'not-runnable';
    else if (anyValue) state = 'measured';
    else state = 'missing';

    // DENOMINATOR RULE: a source we own counts toward what is available whether or not this
    // row has a value — that is what makes a missing reading cost the row. A source we do not
    // own is removed from the denominator entirely.
    if (state === 'not-runnable') notRunnablePoints += g.points;
    else { availablePoints += g.points; if (state === 'measured') measuredPoints += g.points; }

    if (state === 'missing') missing.push(g.name);
    if (state === 'not-runnable') notRunnable.push(g.name);

    points += got;
    groups.push({ name: g.name, points: +got.toFixed(2), max: g.points, state, sub: subs });
  }

  points = +points.toFixed(2);
  const coverage = +(measuredPoints / TOTAL).toFixed(3);

  // THE THRESHOLD SCALES. Requiring the full-spec 34 while 25 points have no source at all
  // would make SIGNAL unreachable; the bar is the same FRACTION of what can actually be read.
  const scale = availablePoints / TOTAL;
  const requiredPoints = +(CONFIG.score.decision.signalThreshold * scale).toFixed(2);
  const watchPoints = +(CONFIG.score.decision.watchThreshold * scale).toFixed(2);

  // --- why this row is not a SIGNAL, in the order the engine actually refuses ---
  const blockers = [];
  const momentumGroup = groups.find((g) => g.name === 'momentum');
  const fastVal = momentumGroup && momentumGroup.sub.find((x) => x.name === 'fast');
  const structVal = momentumGroup && momentumGroup.sub.find((x) => x.name === 'structural');
  // Measured evidence pointing OPPOSITE ways is not weak evidence, it is contradictory
  // evidence — momentum up while structure is down is the shape that buys tops.
  const contradictory = fastVal && structVal && fastVal.value != null && structVal.value != null
    && fastVal.value > 0 && structVal.value > 0
    && ((s.momentum.fast > 0) !== (s.momentum.structural > 0));

  // TIMING IS CHECKED BEFORE THE SCORE, NOT AFTER IT. A row that already moved, or that is
  // fighting its own slow frame, must not become a SIGNAL no matter how many points it earned —
  // a high score on a finished move is precisely the trade that loses money.
  const timing = timingVerdict(s, direction);
  const timingBlocked = timing.blockers.length > 0;

  let status;
  if (gates.status === 'BLOCKED') { status = 'BLOCKED'; blockers.push('gate ' + (gates.blockedBy || 'BLOCK')); }
  else if (direction == null) { status = 'WATCH'; blockers.push('no direction'); }
  else if (timingBlocked) { status = 'WATCH'; blockers.push(...timing.blockers); }
  else if (contradictory) { status = 'WATCH'; blockers.push('momentum and structure disagree'); }
  else if (gates.coverageCapped) { status = 'WATCH'; blockers.push('coverage below the WATCH cap'); }
  else if (points >= requiredPoints) { status = 'SIGNAL'; }
  else { status = 'WATCH'; blockers.push('score ' + points + ' < ' + requiredPoints + ' needed'); }

  const plan = status === 'SIGNAL' ? planFor(s, direction) : null;
  // A SIGNAL WITHOUT A PLAN IS NOT A SIGNAL. If no stop can be derived there is nothing to
  // trade, so the row drops to WATCH rather than advertising an entry with no risk level.
  if (status === 'SIGNAL' && !plan) {
    status = 'WATCH';
    blockers.push('no usable level for a stop (VWAP / value area / POC / day extremes / prior close were all absent, or further than ' + RISK_MAX_PCT + '% away)');
  }

  const text = status + (direction ? ' ' + direction : '')
    + ' · ' + points + '/' + availablePoints + ' pts (need ' + requiredPoints + ')'
    + ' · coverage ' + Math.round(coverage * 100) + '%'
    + (blockers.length ? ' · ' + blockers.join('; ') : '');

  return {
    status, direction, directionSource, points, availablePoints, requiredPoints, watchPoints, coverage,
    totalPoints: TOTAL, notRunnablePoints,
    groups, missing, notRunnable, blockers, text, plan,
    // Reported separately so the UI can say WHY a strongly-scored row is still not a trade —
    // "timing" is a different refusal from "not enough points" and must not be read as one.
    timing: { applied: timing.applied, phase: timing.phase || null, slowKnown: timing.slowKnown == null ? null : timing.slowKnown, blocked: timingBlocked, reasons: timing.blockers },
  };
}

module.exports = { score, planFor, atrPctOf, agree, normDir, directionFromEvidence, timingVerdict, DIRECTION_MIN_SHARE, GROUPS, TOTAL };
