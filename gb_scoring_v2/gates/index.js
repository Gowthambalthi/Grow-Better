/**
 * gb_scoring_v2/gates/index.js — PHASE 4: THE GATES.
 *
 * V3 spec Section 8: "Gates run cheapest-first. A failed gate returns BLOCKED with
 * a reason code. Unknown gate input (data unavailable) caps the status at WATCH and
 * adds a data reason code; it does not silently pass."
 *
 * Phase 4 done-when: "All gates implemented with reason codes; unknown-input capping
 * verified."
 *
 * THREE DISTINCT OUTCOMES, because confusing them is how a gate layer goes wrong:
 *
 *   BLOCK  — this name is not tradable (bad data, untradable instrument, opposing
 *            evidence). A high score must never rescue it (spec rule 7).
 *   WATCH  — we could not prove it is tradable. Caps the status; the candidate
 *            survives as information, it just cannot become a SIGNAL.
 *   PASS   — the gate was satisfied.
 *
 * ...PLUS A FOURTH, WHICH THE SPEC DOES NOT NAME AND WHICH THIS MODULE MAKES LOUD:
 *
 *   NOT-RUNNABLE — the gate's INPUT SOURCE does not exist in this feed at all.
 *
 * Why that fourth state is necessary rather than a loophole. Phase 1 MEASURED that
 * the tick feed carries no bid/ask (0/814 rows), no exchange timestamp, no ADX and
 * no RSI. Taken literally, "an unknown gate input caps the status at WATCH" would
 * make GATE_SPREAD and GATE_LATENCY cap EVERY candidate, every session, forever --
 * meaning the engine could never emit a SIGNAL at all. That is not a stricter engine,
 * it is a dead one.
 *
 * So the two cases are separated, and the distinction is the whole point:
 *   * a ROW-LEVEL unknown (the source exists, this row lacks the value) -> caps at
 *     WATCH, exactly as the spec says. Nothing is excused.
 *   * a SOURCE-LEVEL absence (no such field exists anywhere in the feed, verified in
 *     Phase 1) -> the gate is reported as NOT-RUNNABLE with the measured reason, is
 *     listed in the output and in `risks[]`, and does not constrain. It is loud,
 *     counted, and auditable -- which is the opposite of silently passing.
 *
 * A `notRunnable` gate is also the honest input to Section 21.4's blocked audit:
 * a gate that never runs has no blocked candidates to audit, and that fact belongs
 * in the report rather than being papered over by a fake WATCH.
 */
const { CONFIG } = require('../config/index');
const { isKnown } = require('../adapter/provenance');

const OUT = { PASS: 'pass', BLOCK: 'block', WATCH: 'watch', NA: 'na' };

// ---------------------------------------------------------------------------
// COARSE DIRECTIONAL READS (gates only).
//
// The direction and conflict gates need to know whether momentum, flow and
// location AGREE, not how many points they deserve. Points are Phases 5-9 and the
// spec forbids fixing them before replay, so a gate must not invent a score.
// These are deliberately simple sign reads and they are labelled as such in the
// output, so nobody mistakes them for the validated evidence values.
// ---------------------------------------------------------------------------
// SCALE MATTERS, AND THE THREE GROUPS SPEAK DIFFERENT UNITS.
// Momentum arrives as a % ROC, flow as an already-normalized bias in [-1,+1], and
// location as a distance from VWAP. Comparing or thresholding those raw would be
// meaningless -- and an earlier version of this file did exactly that, blocking 326
// of 380 depth rows because |+0.001%| and |-0.001| counted as "opposition".
// Each read is therefore mapped to a bounded [-1,+1] conviction:
//   momentum: a 0.5% average move across the six horizons is full conviction
//   location: 0.5% away from VWAP is full conviction
//   flow:     already bounded by construction
const bounded = (v) => (v == null ? null : Math.max(-1, Math.min(1, v)));
const MOMENTUM_FULL_PCT = 0.5;

function readMomentum(s) {
  const p = s.price_evidence || {};
  const vals = [p.roc10, p.roc20, p.roc30, p.roc1m, p.roc5m, p.roc15m].filter(isKnown);
  if (!vals.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return bounded(avg / MOMENTUM_FULL_PCT);
}
function readFlow(s) {
  const f = s.flow || {};
  const vals = [f.delta, isKnown(f.buyPressure) && isKnown(f.sellPressure) ? f.buyPressure - f.sellPressure : null].filter(isKnown);
  if (!vals.length) return null;
  return bounded(vals.reduce((a, b) => a + b, 0) / vals.length);
}
// LOCATION now delegates to the Phase-9 engine instead of reimplementing a VWAP-only
// read. Two reasons, both measured:
//   * the old read scaled the VWAP distance by VWAP_FULL_PCT and then divided by 100
//     again, making it ~200x too small -- a 0.5% move off VWAP read 0.01 instead of
//     1.0, so location almost never registered as opposing and GATE_CONFLICT and
//     GATE_DIRECTION were quietly weaker than their comments claimed.
//   * POC and the value area are available on every ledger row (measured 10,508/
//     10,508) and belong in a location read; VWAP alone was leaving them unused.
// One reader, one scale, shared by gates and scoring.
function readLocation(s) {
  try { return require('../location').locationRead(s); }
  catch (e) { return null; }
}
function sign(v) { return v == null ? null : (v > 0 ? 1 : v < 0 ? -1 : 0); }

// ---------------------------------------------------------------------------
// TIME HELPERS — IST, because the spec's windows are exchange windows.
// ---------------------------------------------------------------------------
function istMinutes(now) {
  const d = new Date(now + (5.5 * 60 + new Date(now).getTimezoneOffset()) * 60000);
  return d.getHours() * 60 + d.getMinutes();
}
const OPEN_MIN = 9 * 60 + 15;    // 09:15 IST
const CLOSE_MIN = 15 * 60 + 30;  // 15:30 IST (broker square-off placeholder)

// ---------------------------------------------------------------------------
// THE GATES. Cheapest first: pure field checks, then arithmetic, then the
// evidence-reasoning gates that need several groups to agree.
// ---------------------------------------------------------------------------
const GATES = {
  /** DATA — BLOCK. Nothing downstream can run on a missing or malformed price. */
  data(s) {
    if (!isKnown(s.price) || !(s.price > 0)) return { outcome: OUT.BLOCK, detail: 'no positive price' };
    if (typeof s.price !== 'number' || Number.isNaN(s.price)) return { outcome: OUT.BLOCK, detail: 'malformed price' };
    // "required fields for the setup present": this engine is momentum-first, so
    // at least one momentum input must exist or there is no setup to judge.
    const anyRoc = [s.price_evidence.roc10, s.price_evidence.roc20, s.price_evidence.roc30,
      s.price_evidence.roc1m, s.price_evidence.roc5m, s.price_evidence.roc15m].some(isKnown);
    if (!anyRoc) return { outcome: OUT.BLOCK, detail: 'no momentum input at all' };
    return { outcome: OUT.PASS };
  },

  /**
   * LATENCY — cap WATCH. Needs an exchange print time on the ENTRY evidence.
   * SOURCE-LEVEL ABSENCE (Phase 1): the tick payload has no exchangeTs anywhere,
   * so this gate cannot run on entry evidence. The Yahoo screening quote DOES carry
   * regularMarketTime, but it also DECLARES a 15-minute delay -- feeding a delayed
   * screening source into an entry-timing latency check would be a category error.
   */
  latency(s, ctx) {
    if (ctx.latencySource && isKnown(ctx.latencySource.exchangeTs)) {
      const lag = ctx.receiptTs - ctx.latencySource.exchangeTs;
      return lag <= CONFIG.gates.latency.maxReceiptLagMs
        ? { outcome: OUT.PASS, detail: 'lag ' + lag + 'ms' }
        : { outcome: OUT.WATCH, detail: 'lag ' + lag + 'ms > ' + CONFIG.gates.latency.maxReceiptLagMs + 'ms' };
    }
    return { outcome: OUT.NA, detail: 'no exchange timestamp on the entry feed (Phase 1: 0/814 rows)', source: 'entry-feed' };
  },

  /**
   * LIQUIDITY — BLOCK (spec table). Static quality inputs. They are absent from the
   * tick row but present in the funnel's quality set, which the adapter merges in,
   * so this gate is runnable for deep rows.
   */
  liquidity(s) {
    const g = CONFIG.gates.liquidity;
    const r = s.reference || {};
    const atr = s.price_evidence && s.price_evidence.atrPct;
    const tvCr = isKnown(r.turnover) ? r.turnover / 1e7 : null;
    const mcCr = isKnown(r.marketCap) ? r.marketCap / 1e7 : null;

    // MEASURED FAILURES BLOCK. A field we actually read and found below the floor
    // is a real, defensible reason to remove the name.
    if (isKnown(s.price) && s.price < g.minClose) return { outcome: OUT.BLOCK, detail: 'price ' + s.price + ' < ' + g.minClose };
    if (isKnown(r.avgVol20) && r.avgVol20 < g.minAvgVol20) return { outcome: OUT.BLOCK, detail: '20d avg vol ' + r.avgVol20 + ' < ' + g.minAvgVol20 };
    if (tvCr != null && tvCr < g.minTurnoverCr) return { outcome: OUT.BLOCK, detail: 'turnover ' + tvCr.toFixed(2) + ' Cr < ' + g.minTurnoverCr + ' Cr' };
    if (mcCr != null && mcCr < g.minMarketCapCr) return { outcome: OUT.BLOCK, detail: 'cap ' + mcCr.toFixed(0) + ' Cr < ' + g.minMarketCapCr + ' Cr' };
    if (isKnown(atr) && (atr < g.minAtrPct || atr > g.maxAtrPct)) return { outcome: OUT.BLOCK, detail: 'ATR% ' + atr + ' outside ' + g.minAtrPct + '-' + g.maxAtrPct };

    // UNKNOWNS CAP AT WATCH. This resolves a genuine conflict inside the spec:
    // Section 8 states the general rule ("unknown gate input ... caps the status at
    // WATCH and adds a data reason code; it does not silently pass") while its gate
    // TABLE lists BLOCK for liquidity. The general rule is the stated principle and
    // the safer reading on two counts:
    //   * blocking on absence REMOVES a candidate for a reason we cannot name, and
    //     the Section 21.4 blocked audit would then be dominated by "the reference
    //     file did not cover this symbol" instead of "this name is illiquid" -- a
    //     gate you cannot tune from its own audit;
    //   * the reference sets are previous-day artifacts, so coverage gaps are
    //     expected and are not evidence of illiquidity.
    // Only a measured failure blocks. Nothing is silently passed.
    const unknown = [];
    if (!isKnown(r.avgVol20)) unknown.push('avgVol20');
    if (mcCr == null) unknown.push('marketCap');
    if (tvCr == null) unknown.push('turnover');
    if (!isKnown(atr)) unknown.push('atrPct');
    if (unknown.length) return { outcome: OUT.WATCH, detail: 'cannot prove liquidity: unknown ' + unknown.join(', ') };
    return { outcome: OUT.PASS };
  },

  /**
   * EXCLUSION — a POSITIVE match is a BLOCK (the word "exclude" means remove), while
   * an UNKNOWN surveillance status caps at WATCH. The banned list is available at
   * payload level, so this is a real check rather than a formality.
   */
  exclusion(s, ctx) {
    const banned = ctx.banned || [];
    if (banned.length && banned.indexOf(s.symbol) !== -1) return { outcome: OUT.BLOCK, detail: 'banned (whipsaw) for the day' };
    if (s.reference && s.reference.tickOnly) return { outcome: OUT.PASS, detail: 'track-only row, never an entry' };
    if (isKnown(s.reference && s.reference.surveillance)) {
      return s.reference.surveillance ? { outcome: OUT.WATCH, detail: 'flagged by surveillance / restricted tier' } : { outcome: OUT.PASS };
    }
    // The spec's table says "data missing -> cap at WATCH" for exclusion, which
    // assumes the surveillance feed EXISTS and merely lacks this row. It does not
    // exist in this feed at all (Phase 1), so the source-level rule applies: report
    // it loudly as not-runnable. Capping here would be a permanent, invisible
    // WATCH on every candidate -- the deadlock this layer is built to avoid.
    return { outcome: OUT.NA, detail: 'no SME / T2T / ASM-GSM surveillance source (Phase 1)', source: 'surveillance-feed' };
  },

  /** PRICE BAND — cap WATCH. No circuit-band source in this feed (Phase 1). */
  priceBand(s) {
    if (s.reference && isKnown(s.reference.circuitBand)) {
      const d = Math.abs((s.price - s.reference.circuitBand) / s.reference.circuitBand) * 100;
      return d >= CONFIG.gates.priceBand.minDistanceToCircuitPct
        ? { outcome: OUT.PASS, detail: 'distance to circuit ' + d.toFixed(2) + '%' }
        : { outcome: OUT.WATCH, detail: 'within ' + d.toFixed(2) + '% of the circuit limit' };
    }
    return { outcome: OUT.NA, detail: 'no circuit-band source (Phase 1 open item)', source: 'circuit-band' };
  },

  /**
   * SPREAD — cap WATCH. Needs best bid/ask on the ENTRY evidence.
   * SOURCE-LEVEL ABSENCE (Phase 1): 0/814 tick rows carry bid/ask/spread. The Yahoo
   * screening quote does carry them (probed) but returns 0 outside REGULAR and is a
   * 15-minute-delayed source, so it cannot back an entry-cost gate. A row that DOES
   * have a spread is evaluated normally.
   */
  spread(s, ctx) {
    // Entry-grade spread first; the SCREENING spread only as a fallback, and it is
    // labelled as such by the snapshot's separate `screening` block (a delayed
    // source must never be mistaken for entry-grade evidence).
    const entryGrade = isKnown(s.spreadPct);
    const sp = entryGrade ? s.spreadPct : (s.screening && isKnown(s.screening.spreadPct) ? s.screening.spreadPct : null);
    if (!isKnown(sp)) return { outcome: OUT.NA, detail: 'no bid/ask on the entry feed (Phase 1: 0/814 rows)', source: 'entry-feed' };
    return sp <= CONFIG.gates.spread.maxSpreadPct
      ? { outcome: OUT.PASS, detail: 'spread ' + sp + '%' + (entryGrade ? '' : ' (screening-grade)') }
      : { outcome: OUT.WATCH, detail: 'spread ' + sp + '% > ' + CONFIG.gates.spread.maxSpreadPct + '%' + (entryGrade ? '' : ' (screening-grade)'), screeningGrade: !entryGrade };
  },

  /** TIME — clock-only, so it always runs and can never be "unknown". */
  time(s, ctx) {
    const mins = istMinutes(ctx.now);
    const g = CONFIG.gates.time;
    if (mins < OPEN_MIN + g.noSignalFirstMin) return { outcome: OUT.WATCH, detail: 'inside the first ' + g.noSignalFirstMin + ' min after open' };
    if (mins > CLOSE_MIN - g.noSignalLastMin) return { outcome: OUT.WATCH, detail: 'inside the last ' + g.noSignalLastMin + ' min before square-off' };
    return { outcome: OUT.PASS };
  },

  /**
   * WARM-UP — "Indicator marked unknown". This MARKS, it does not cap: RSI and ADX
   * do not exist in this feed at all, so capping on them would cap everything. The
   * affected indicators are named so a later reader sees why the RSI and trend
   * groups score 0 rather than assuming they were evaluated and agreed.
   */
  warmup(s) {
    const unknown = [];
    if (!isKnown(s.structure.rsi1m) && !isKnown(s.structure.rsi5m) && !isKnown(s.structure.rsi15m)) unknown.push('rsi1m', 'rsi5m', 'rsi15m');
    if (!isKnown(s.structure.adx)) unknown.push('adx');
    if (!unknown.length) return { outcome: OUT.PASS };
    return { outcome: OUT.PASS, detail: 'indicators marked unknown: ' + unknown.join(', '), unknownIndicators: unknown, marksOnly: true };
  },

  /** EVENT — cap WATCH. No event-flag source (spec Section 28 lists it as open). */
  event(s) {
    if (s.reference && isKnown(s.reference.eventFlags)) {
      return s.reference.eventFlags ? { outcome: OUT.WATCH, detail: 'event flag set' } : { outcome: OUT.PASS };
    }
    return { outcome: OUT.NA, detail: 'no event-flag source (spec Section 28 open item)', source: 'event-calendar' };
  },

  /** COST VIABILITY — cap WATCH. Needs a spread AND configured cost parameters. */
  cost(s) {
    const c = CONFIG.outcome.costs;
    const costsConfigured = Object.keys(c).filter(k => k !== 'note').every(k => isKnown(c[k]));
    if (!costsConfigured) return { outcome: OUT.NA, detail: 'cost parameters not set (spec: no hard-coded fees)', source: 'cost-config' };
    if (!isKnown(s.spreadPct)) return { outcome: OUT.NA, detail: 'no spread on the entry feed', source: 'entry-feed' };
    const atr = s.price_evidence && s.price_evidence.atrPct;
    if (!isKnown(atr)) return { outcome: OUT.WATCH, detail: 'unknown ATR, cannot size the expected move' };
    return atr >= CONFIG.gates.cost.minAtrMultipleOfCost * s.spreadPct
      ? { outcome: OUT.PASS, detail: 'ATR% ' + atr + ' clears the cost hurdle' }
      : { outcome: OUT.WATCH, detail: 'ATR% ' + atr + ' too small against costs' };
  },

  /**
   * DIRECTION — BLOCK when independent evidence clearly opposes the trade.
   * The spec allows evaluation on available groups, so a group that is unknown is
   * EXCLUDED from the count rather than treated as dissent (treating unknown as
   * dissent would block on absence, which is the failure mode this whole layer is
   * written to avoid). A block needs at least `minIndependentGroups`.
   */
  direction(s, ctx) {
    const dir = ctx.direction;
    if (dir !== 'LONG' && dir !== 'SHORT') return { outcome: OUT.WATCH, detail: 'no direction supplied' };
    const want = dir === 'LONG' ? 1 : -1;
    const groups = [
      { name: 'momentum', v: sign(readMomentum(s)) },
      { name: 'flow', v: sign(readFlow(s)) },
      { name: 'location', v: sign(readLocation(s)) },
      { name: 'structure', v: sign(s.structure.trend5m) },
    ].filter(g => g.v !== null);
    if (groups.length < CONFIG.gates.direction.minIndependentGroups) {
      return { outcome: OUT.WATCH, detail: 'only ' + groups.length + ' independent group(s) available (need ' + CONFIG.gates.direction.minIndependentGroups + ')' };
    }
    const against = groups.filter(g => g.v === -want);
    if (against.length >= CONFIG.gates.direction.minIndependentGroups) {
      return { outcome: OUT.BLOCK, detail: dir + ' blocked: ' + against.map(g => g.name).join(' + ') + ' oppose' };
    }
    return { outcome: OUT.PASS, detail: against.length + ' of ' + groups.length + ' groups oppose' };
  },

  /** CONFLICT — BLOCK on strong opposition between momentum, flow and location. */
  conflict(s) {
    const parts = [['momentum', readMomentum(s)], ['flow', readFlow(s)], ['location', readLocation(s)]].filter(([, v]) => v !== null);
    if (parts.length < 2) return { outcome: OUT.WATCH, detail: 'fewer than 2 groups available to conflict' };
    // "STRONG opposition" (spec Section 8). BOTH sides must clear the threshold:
    // a strong momentum read against a negligible flow read is not conflict, it is
    // noise, and blocking on it would reject most of the board.
    const th = CONFIG.gates.conflict.strongOpposition;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i], b = parts[j];
        const opposing = sign(a[1]) !== 0 && sign(b[1]) !== 0 && sign(a[1]) !== sign(b[1]);
        if (opposing && Math.abs(a[1]) >= th && Math.abs(b[1]) >= th) {
          return { outcome: OUT.BLOCK, detail: 'strong opposition: ' + a[0] + ' ' + a[1].toFixed(2) + ' vs ' + b[0] + ' ' + b[1].toFixed(2) + ' (threshold ' + th + ')' };
        }
      }
    }
    const weakest = parts.reduce((w, p) => (Math.abs(p[1]) < Math.abs(w[1]) ? p : w), parts[0]);
    return { outcome: OUT.PASS, detail: parts.length + ' groups, strongest disagreement below the ' + th + ' threshold (weakest ' + weakest[0] + ' ' + weakest[1].toFixed(2) + ')' };
  },

  /**
   * MARKET — cap WATCH when NIFTY opposes the trade. The NIFTY state is a
   * MARKET-WIDE fact, so it comes from the payload rather than per row (only 54/814
   * rows carry it individually). Unknown still caps at WATCH.
   */
  market(s, ctx) {
    const state = (ctx.market && ctx.market.state) || s.context.niftyState || null;
    if (!isKnown(state)) return { outcome: OUT.WATCH, detail: 'NIFTY state unknown' };
    const dir = ctx.direction;
    if (dir !== 'LONG' && dir !== 'SHORT') return { outcome: OUT.WATCH, detail: 'no direction supplied' };
    const up = /UP|BULL/i.test(String(state));
    const down = /DOWN|BEAR/i.test(String(state));
    if (CONFIG.gates.market.blockWhenNiftyOpposed && ((dir === 'LONG' && down) || (dir === 'SHORT' && up))) {
      return { outcome: OUT.WATCH, detail: 'NIFTY ' + state + ' opposes ' + dir };
    }
    return { outcome: OUT.PASS, detail: 'NIFTY ' + state };
  },
};

/**
 * runGates(snapshot, ctx) -> the decision input.
 *
 * ctx: { direction, now, receiptTs, market {state}, banned[], screening?, latencySource? }
 *
 * Returns { status, blockedBy, capped (bool), results[], reasons[], risks[],
 *           notRunnable[], coverageCapped }
 *   status: 'BLOCKED' | 'WATCH' | 'PASS'
 * A BLOCK short-circuits the rest (cheapest-first means we stop paying for gates
 * once the answer cannot change), but every gate that DID run is still reported.
 */
function runGates(snapshot, ctx = {}) {
  const cfg = CONFIG.gates;
  const c = Object.assign({ now: Date.now(), direction: null, banned: [], market: null }, ctx);
  if (c.receiptTs == null && snapshot.receiptTs) c.receiptTs = Date.parse(snapshot.receiptTs);

  const results = [], reasons = [], risks = [], notRunnable = [];
  let blockedBy = null;

  for (const name of cfg.order) {
    const fn = GATES[name];
    if (!fn) continue;
    const def = cfg[name] || {};
    let r;
    try { r = fn(snapshot, c) || { outcome: OUT.PASS }; }
    catch (e) { r = { outcome: OUT.WATCH, detail: 'gate error: ' + e.message }; }

    const entry = { gate: name, code: def.code || ('GATE_' + name.toUpperCase()), outcome: r.outcome, detail: r.detail || null };
    if (r.source) entry.source = r.source;
    if (r.unknownIndicators) entry.unknownIndicators = r.unknownIndicators;
    results.push(entry);

    if (r.outcome === OUT.BLOCK) { reasons.push({ code: entry.code, gate: name, detail: entry.detail }); blockedBy = entry.code; break; }
    if (r.outcome === OUT.WATCH) reasons.push({ code: entry.code, gate: name, detail: entry.detail, caps: 'WATCH' });
    if (r.outcome === OUT.NA) { notRunnable.push({ gate: name, code: entry.code, why: entry.detail }); risks.push('RISK_GATE_NOT_RUN:' + entry.code); }
    if (entry.unknownIndicators) risks.push('RISK_UNKNOWN_INDICATOR');
  }

  // Section 17: coverage below the configured level caps at WATCH. Points whose
  // inputs are unknown score 0 but are FLAGGED, which is exactly what coverage is.
  const cov = snapshot.coverage ? snapshot.coverage.overall : null;
  const coverageCapped = cov != null && cov < CONFIG.score.coverage.capsAtWatchBelow;
  if (coverageCapped) reasons.push({ code: 'RISK_LOW_COVERAGE', detail: 'coverage ' + cov + ' < ' + CONFIG.score.coverage.capsAtWatchBelow, caps: 'WATCH' });
  // Inferred-only directional flow is a risk, not a cap (spec 6.2: it can score).
  if (snapshot.flow && snapshot.flow.provenance && snapshot.flow.provenance.inferredOnly) risks.push('RISK_INFERRED_FLOW');

  const status = blockedBy ? 'BLOCKED' : (reasons.some(r => r.caps === 'WATCH') ? 'WATCH' : 'PASS');
  return {
    status,
    blockedBy,
    capped: status === 'WATCH',
    results,
    reasons,
    risks,
    notRunnable,
    coverageCapped,
    // Explainability (spec Section 18): the output must name what fired.
    text: status + (blockedBy ? ' by ' + blockedBy : '') + (notRunnable.length ? ' · ' + notRunnable.length + ' gate(s) not runnable' : ''),
  };
}

/** The gate inventory, for the Phase-4 report: which run, which cannot, and why. */
function inventory() {
  return CONFIG.gates.order.map(name => {
    const def = CONFIG.gates[name] || {};
    return { gate: name, code: def.code, onMissing: def.onMissing };
  });
}

module.exports = { runGates, inventory, GATES, OUT, readMomentum, readFlow, readLocation, istMinutes, OPEN_MIN, CLOSE_MIN };
