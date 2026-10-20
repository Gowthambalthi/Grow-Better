'use strict';

/**
 * THE CALL BOOK, DAY BY DAY — what was called, and what happened to it.
 *
 * The live engines write one file per session (`data/orderflow/daily_calls_<date>.json`)
 * holding every call they armed, the entry, the stop, the target, and — once the trade
 * resolved — the exit price, the exit time and WHY it exited. The page has always asked
 * for a multi-session view of that (`/api/final/daily`), and no server route ever
 * existed, so the "TODAY + LAST 3 DAYS" and "EVERY STRATEGY" tables have been reading a
 * 404. This module is the missing reader.
 *
 * TWO ENGINES SHARE THAT FILE — the minute order-flow engine and the Sweep+FVG engine —
 * and they even share an id format, so the reader attributes each call to the engine that
 * wrote it (see engineOf) instead of reporting one engine's calls as another's.
 *
 * THREE THINGS IT REFUSES TO DO, each for a measured reason:
 *
 * 1. IT DOES NOT COUNT A CALL THAT WAS NEVER TRIGGERED AS A WIN OR A LOSS. The books
 *    contain `CANCELLED_EXHAUSTION`, `EXPIRED` and `INVALIDATED` calls — setups the
 *    engine withdrew before any trade happened — plus `ARMED` calls still open when the
 *    file was last written. They are reported in their own buckets. Counting a withdrawn
 *    call as a loss (or a win, because a cancelled short would have been right) is the
 *    single easiest way to manufacture a track record that does not exist.
 *
 * 2. IT DOES NOT CALL EVERY CLOSE A TARGET. "TARGET HIT", "STOP LOSS HIT",
 *    "EXITED AT CLOSE" and "TIME EXIT" are different outcomes and are labelled
 *    separately; a call the engine flattened at 15:30 for -35 bps is at-close exit,
 *    not a stop loss and certainly not a win.
 *
 * 3. IT DOES NOT INVENT A WIN RATE, AND IT USES THE ONLY WIN RULE IN THE APP.
 *    A WIN is a call whose TARGET was actually hit. A LOSS is a call whose STOP was
 *    actually hit. Everything else that closed — session close, breakeven, time exit,
 *    unrecorded — is an exit WITHOUT a level (`otherExits`) and is never a win, however
 *    small its net came out (a +₹0.01 net is not a win). The headline `winRatePct` is
 *    therefore targetHits / (targetHits + stopsHit) over DECIDED trades, with the
 *    other-exit count always carried beside it so nothing is hidden. It is null, never
 *    0 or 100, when nothing has decided. `netPct` is likewise null when nothing resolved.
 *    The page renders a null as a dash.
 *
 *    This is the single source of the win-rate rule: the daily history, the per-strategy
 *    rows, the tier rows, the server's strategy-performance table, the Sweep+FVG scorecard
 *    and the minute engine's own "today's win rate" all go through this classifier. Before
 *    this existed there were four different formulas on the same book, which is how one
 *    table could show a company the other did not and two tables could disagree on the
 *    same call's verdict.
 *
 * TWO VOCABULARIES EXIST IN THE FILES and both are normalised here, because the books
 * span a change in the engine's own naming: older sessions use lower-case reasons
 * (`target`, `stop`, `session_close`) and statuses such as `CANCELLED_EXHAUSTION`,
 * while the current engine writes `TARGET_HIT` / `STOP_LOSS_HIT` / `SESSION_CLOSE`.
 * Reading only one vocabulary would silently drop sessions.
 */

const fs = require('fs');
const path = require('path');

/** Outcome labels, worded the way a trader reads a call sheet. */
const OUTCOME = {
  TARGET_HIT: 'TARGET ACHIEVED',
  STOP_LOSS_HIT: 'STOP LOSS HIT',
  BREAKEVEN_EXIT: 'BREAKEVEN (cost)',
  STAGNATION_EXIT: 'TIME EXIT (no progress)',
  SESSION_CLOSE: 'EXITED AT CLOSE',
  CANCELLED: 'CANCELLED (never triggered)',
  STILL_OPEN: 'STILL OPEN AT CLOSE',
  UNRECORDED: 'CLOSED (reason not recorded)',
};

/** Outcomes that mean a position actually existed and was closed. */
const CLOSED_KEYS = new Set(['TARGET_HIT', 'STOP_LOSS_HIT', 'BREAKEVEN_EXIT', 'STAGNATION_EXIT', 'SESSION_CLOSE', 'UNRECORDED']);

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'orderflow');

function istDate(nowMs = Date.now()) {
  return new Date(nowMs + 330 * 60000).toISOString().slice(0, 10);
}

/** Saturday/Sunday are not sessions. Dates are IST calendar days. */
function isWeekend(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

function shiftDate(dateStr, deltaDays) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Classify one call record from any generation of the file format.
 * Returns { key, label, closed, won }.
 */
function classify(call) {
  const raw = String(call.exitReason || '').trim();
  const reason = raw.toLowerCase();
  const status = String(call.status || '').trim().toUpperCase();

  // 1. A recorded exit reason is the most specific evidence, so it wins.
  if (reason === 'target_hit' || reason === 'target') {
    return { key: 'TARGET_HIT', label: OUTCOME.TARGET_HIT, closed: true, won: true };
  }
  if (reason === 'stop_loss_hit' || reason === 'stop' || reason === 'sl_hit') {
    return { key: 'STOP_LOSS_HIT', label: OUTCOME.STOP_LOSS_HIT, closed: true, won: false };
  }
  if (reason === 'breakeven_exit' || reason === 'breakeven') {
    return { key: 'BREAKEVEN_EXIT', label: OUTCOME.BREAKEVEN_EXIT, closed: true, won: Number(call.netBps) >= 0 };
  }
  if (reason === 'stagnation_exit' || reason === 'time_exit') {
    return { key: 'STAGNATION_EXIT', label: OUTCOME.STAGNATION_EXIT, closed: true, won: Number(call.netBps) >= 0 };
  }
  if (reason === 'session_close') {
    return { key: 'SESSION_CLOSE', label: OUTCOME.SESSION_CLOSE, closed: true, won: Number(call.netBps) >= 0 };
  }

  // 2. No reason recorded — fall back to the status, and never upgrade a bare close
  //    into a target hit: `WON` today always carries TARGET_HIT, so an unlabelled WON
  //    is untrusted and is reported as an unrecorded close.
  if (status === 'SESSION_CLOSE') return { key: 'SESSION_CLOSE', label: OUTCOME.SESSION_CLOSE, closed: true, won: Number(call.netBps) >= 0 };
  if (status === 'TIME_EXIT') return { key: 'STAGNATION_EXIT', label: OUTCOME.STAGNATION_EXIT, closed: true, won: Number(call.netBps) >= 0 };
  // `CLOSED` IS A CLOSED POSITION, NOT ONE THAT NEVER TRIGGERED. The live engines stamp it
  // on an exit that touched no level (session flatten, breakeven floor, stagnation), whose
  // `exitReason` above already named the outcome. Reaching the catch-all below without a
  // reason would report the trade as CANCELLED — the opposite of the record — so it is an
  // unrecorded close, the same bucket a bare WON/LOST falls into.
  if (status === 'CLOSED') {
    return { key: 'UNRECORDED', label: OUTCOME.UNRECORDED, closed: true, won: false };
  }
  if (status === 'WON' || status === 'LOST') {
    return { key: 'UNRECORDED', label: OUTCOME.UNRECORDED, closed: true, won: status === 'WON' };
  }

  // 3. A position that EXISTS but has no exit yet, or one that never became a position.
  //
  // `FILLED` belongs in the first group, and getting that wrong is how a reader fabricates a
  // track record: the Sweep+FVG engine stamps `FILLED` on the call whose entry actually traded and
  // whose exit simply had not happened when the file was written. Falling through to the
  // catch-all below labelled every such call "CANCELLED (never triggered)" — the exact opposite of
  // the recorded fact, and it would have deleted a live position from the day's history while
  // still telling the owner the setup never triggered.
  if (status === 'ARMED' || status === 'PENDING' || status === 'FILLED') {
    return { key: 'STILL_OPEN', label: OUTCOME.STILL_OPEN, closed: false, won: false };
  }
  return { key: 'CANCELLED', label: OUTCOME.CANCELLED, closed: false, won: false };
}

/**
 * WHICH ENGINE MADE THIS CALL — two engines write the one book.
 *
 * `data/orderflow/daily_calls_<date>.json` holds the calls of BOTH live engines: the minute
 * order-flow engine and the Sweep+FVG engine. They share a journalDir and even the same
 * `CALL-<SYM>-<date>-NNN` id format, so "every strategy" table was in fact showing one strategy and
 * silently attributing the other engine's calls to it.
 *
 * The `engine` stamp is read when a record carries one (both writers now do; records written
 * before the stamp existed do not). Where it is absent, attribution falls back to evidence in the
 * record rather than to a guess: the sweep engine writes a `sector` this one never writes, and it
 * uses statuses (`EXPIRED`, `FILLED`, `INVALIDATED`, `CANCELLED_EXHAUSTION`,
 * `CANCELLED_TRADE_LIMIT`, `REJECTED_RISK`, `TIME_EXIT`) that the minute engine does not. The
 * evidence used is returned with the day so the page can say how it knows instead of asserting it.
 */
const ENGINE_NAMES = {
  OF_MOMENTUM: 'Order Flow Institutional Momentum',
  SWEEP_FVG: 'Sweep + FVG (5m cadence)',
  // THE GB CODES ARE THE NAMES THE BACKTESTS USE, so a live row and the measured
  // table can be compared without a translation step. The descriptive tail stays,
  // because "GB03a" alone does not tell a reader what the trade is.
  ORDERFLOW: 'GB03a — OF03 Exhaustion Reversal',
  OF03: 'GB03a — OF03 Exhaustion Reversal',
  FVG: 'GB01 / GB02 — Fair-Value-Gap Retest',
  FG01: 'GB01 — 5m FVG Retest',
  FG02: 'GB02 — 15m FVG Retest',
  GB01: 'GB01 — 5m FVG Retest',
  GB02: 'GB02 — 15m FVG Retest',
  GB03: 'GB03a — OF03 Exhaustion Reversal',
  GB03A: 'GB03a — OF03 Exhaustion Reversal',
  GB04: 'GB04 — PDH/PDL Support & Resistance',
  CODEX: 'CodeX Opening Range (ORB01)',
  SWING: 'Swing VWAP Pullback (SW01)',
};
const SWEEP_ONLY_STATUSES = new Set([
  'EXPIRED', 'FILLED', 'INVALIDATED', 'CANCELLED_EXHAUSTION',
  'CANCELLED_TRADE_LIMIT', 'REJECTED_RISK', 'TIME_EXIT',
]);

function engineOf(call) {
  const stamped = String(call.engine || '').trim().toUpperCase();
  if (stamped) return { id: stamped, basis: 'engine field' };
  const status = String(call.status || '').trim().toUpperCase();
  if (call.sector || SWEEP_ONLY_STATUSES.has(status)) return { id: 'SWEEP_FVG', basis: 'record evidence' };
  return { id: 'OF_MOMENTUM', basis: 'record evidence' };
}

/** Strategy identity: the engine that wrote the call, at the tier it declares. */
function strategyOf(call) {
  const tier = String(call.strategyType || 'INTRADAY').toUpperCase();
  // A WRITER THAT NAMES ITS SETUP IS BELIEVED. One engine can host two measured
  // systems (the FVG engine makes GB01 on 5m and GB02 on 15m), and attributing
  // both to "FVG" would merge two rows the backtest reports separately — the same
  // failure the engine stamp fixed one level up. Records written before this field
  // existed have none, so their attribution is unchanged.
  const stampedId = String(call.strategyId || '').trim().toUpperCase();
  if (stampedId) {
    return {
      id: stampedId,
      name: call.strategyName || ENGINE_NAMES[stampedId] || String(call.strategyId),
      tier,
      basis: 'strategyId field',
    };
  }
  const who = engineOf(call);
  return { id: who.id, name: ENGINE_NAMES[who.id] || who.id, tier, basis: who.basis };
}

function emptyBucket() {
  return { calls: 0, closed: 0, wins: 0, winsGross: 0, flippedByCost: 0, cancelled: 0, stillOpen: 0,
           targetHits: 0, stopsHit: 0, otherExits: 0,
           netBpsSum: 0, netMeasured: 0, winBps: 0, lossBps: 0,
           // THE DAY'S NET IN RUPEES FOR ONE LOT, summed over the CLOSED calls this bucket
           // already decided are closed. Every surface used to add this up for itself from
           // its own idea of which rows were closed and which field held the rupee figure,
           // so a page-side filter that did not know about `CLOSED`-stamped exits quietly
           // dropped real rupees from the total. One sum, in the one place that classifies.
           netInrSum: 0, netInrMeasured: 0 };
}

/**
 * GROSS AND NET DISAGREE ON SOME CLOSES, AND BOTH ARE REPORTED.
 *
 * The engine resolves a position at 15:30 with `status = pts >= 0 ? WON : LOST` — gross
 * POINTS, before costs — and then stores `netBps` with the cost subtracted. On
 * 2026-10-12 that produced one call the engine counts as WON and the net view counts as
 * a loss: a +0.2% close that does not survive the round trip. `wins` here is the NET
 * count (it is the one consistent with `netPct`, which is also net), `winsGross` is the
 * engine's own gross verdict, and `flippedByCost` is exactly how many calls differ — so
 * the discrepancy is a number on the page rather than a silent preference.
 */
function addToBucket(bucket, outcome, call) {
  bucket.calls += 1;
  if (outcome.closed) {
    bucket.closed += 1;
    // THE WIN RULE, APPLIED IN ONE PLACE. Target hit = win, stop hit = loss, and any
    // other close (session close, breakeven, time exit, unrecorded) lands in otherExits
    // — never in wins, however small its net came out.
    if (outcome.key === 'TARGET_HIT') bucket.targetHits += 1;
    else if (outcome.key === 'STOP_LOSS_HIT') bucket.stopsHit += 1;
    else bucket.otherExits += 1;
    const net = Number(call.netBps);
    const gross = Number(call.grossPoints1Lot);
    const netWin = Number.isFinite(net) ? net >= 0 : outcome.won;
    const grossWin = Number.isFinite(gross) ? gross >= 0 : outcome.won;
    if (netWin) bucket.wins += 1;
    if (grossWin) bucket.winsGross += 1;
    if (grossWin && Number.isFinite(net) && net < 0) bucket.flippedByCost += 1;
    const netInr = Number(call.netInr1Lot);
    if (Number.isFinite(netInr)) {
      bucket.netInrSum += netInr;
      bucket.netInrMeasured += 1;
    }
    if (Number.isFinite(net)) {
      bucket.netBpsSum += net;
      bucket.netMeasured += 1;
      // The two halves of the PROFIT FACTOR, kept so the ledger's PF column is the
      // quotient of measured calls and not a re-derivation from the rounded row.
      if (net >= 0) bucket.winBps += net; else bucket.lossBps += Math.abs(net);
    }
  } else if (outcome.key === 'STILL_OPEN') {
    bucket.stillOpen += 1;
  } else {
    bucket.cancelled += 1;
  }
  return bucket;
}

/** The page shows a per-day net as the sum of every measured call's net-percent. */
function published(bucket) {
  return {
    calls: bucket.calls,
    closed: bucket.closed,
    wins: bucket.wins,
    winsGross: bucket.winsGross,
    flippedByCost: bucket.flippedByCost,
    cancelled: bucket.cancelled,
    stillOpen: bucket.stillOpen,
    // THE HEADLINE WIN RATE. Target hits over DECIDED trades (target hit or stop hit).
    // Calls that closed without either level are reported in otherExits beside it, never
    // folded into wins, and never used as a hidden denominator. Null when nothing decided.
    targetHits: bucket.targetHits,
    stopsHit: bucket.stopsHit,
    otherExits: bucket.otherExits,
    decided: bucket.targetHits + bucket.stopsHit,
    winRatePct: (bucket.targetHits + bucket.stopsHit) > 0
      ? +((bucket.targetHits / (bucket.targetHits + bucket.stopsHit)) * 100).toFixed(1)
      : null,
    // NULL, NOT ZERO. The older books carry no net field at all, so "the net was flat"
    // and "the net was never measured" are different states and only one of them is a
    // number. A fabricated 0.0 would read as a break-even session that never happened.
    // BPS -> PERCENT. This returned the raw bps sum under a name the page prints with a '%',
    // so a session of -218.8 bps was shown as "-218.8%" — a hundred-fold overstatement in the
    // very column the owner reads to judge a day.
    netPct: bucket.netMeasured > 0 ? +(bucket.netBpsSum / 100).toFixed(2) : null,
    netMeasured: bucket.netMeasured,
    // Null, not 0, when no closed call carried a rupee figure — "flat" and "never measured"
    // are different states and only one of them is a number.
    netInrSum: bucket.netInrMeasured > 0 ? +bucket.netInrSum.toFixed(2) : null,
    netInrMeasured: bucket.netInrMeasured,
    // PROFIT FACTOR over measured calls: gross net wins / gross net losses, in bps.
    // Null when there is no losing side to divide by — an infinite PF is not a number
    // a ledger should print, and with no measured calls there is nothing to report.
    netPF: bucket.lossBps > 0 ? +(bucket.winBps / bucket.lossBps).toFixed(2) : null,
  };
}

/**
 * ONE ROW PER CALL, ACROSS EVERY STRATEGY — with the verdict the reader asked for.
 *
 * The history panel could name a session's totals and, separately, each strategy's totals, but
 * never the individual calls behind them: "all calls of different strategies, positive or
 * negative" had no surface. The verdict is NET, not gross (the engine's own WON/LOST is on gross
 * points and a +0.2% close can fail the round trip), and a call that never became a position is
 * NOT a loss — it is reported as NOT TAKEN, because counting it either way would invent a trade.
 */
function callRow(call) {
  const outcome = classify(call);
  const s = strategyOf(call);
  const net = Number(call.netBps);
  const netInr = Number(call.netInr1Lot);
  const entry = Number(call.limitEntry != null ? call.limitEntry : (call.entryPrice != null ? call.entryPrice : call.entry));
  const exit = Number(call.exitPrice != null ? call.exitPrice : call.exit);
  let verdict;
  if (!outcome.closed) verdict = outcome.key === 'STILL_OPEN' ? 'OPEN' : 'NOT TAKEN';
  else if (Number.isFinite(net)) verdict = net >= 0 ? 'POSITIVE' : 'NEGATIVE';
  else verdict = 'UNMEASURED';
  return {
    id: call.id || null,
    strategy: s.id,
    strategyName: s.name,
    tier: s.tier,
    symbol: call.symbol || call.tradingSymbol || null,
    side: call.side || call.action || null,
    entry: Number.isFinite(entry) ? +entry.toFixed(2) : null,
    exit: Number.isFinite(exit) ? +exit.toFixed(2) : null,
    // PERCENT, from basis points — the field above is bps of entry and a reader must not see
    // 61.6 rendered as "+61.6%". Only a CLOSED call has a result: a cancelled record carries
    // netBps 0 as a placeholder, and printing that as "0%" would read as a break-even trade
    // that never happened.
    netPct: outcome.closed && Number.isFinite(net) ? +(net / 100).toFixed(2) : null,
    netInr: outcome.closed && Number.isFinite(netInr) ? +netInr.toFixed(2) : null,
    outcome: outcome.key,
    outcomeLabel: outcome.label,
    verdict,
    closed: !!outcome.closed,
  };
}

function summariseDay(date, calls, opts) {
  const isToday = date === opts.today;
  const all = emptyBucket();
  const outcomes = {};
  const byStrategy = new Map();
  const bases = new Set();

  for (const call of calls) {
    const outcome = classify(call);
    addToBucket(all, outcome, call);
    outcomes[outcome.key] = (outcomes[outcome.key] || 0) + 1;

    const s = strategyOf(call);
    bases.add(s.basis);
    if (!byStrategy.has(s.id)) {
      byStrategy.set(s.id, { id: s.id, tier: s.tier, bucket: emptyBucket() });
    }
    addToBucket(byStrategy.get(s.id).bucket, outcome, call);
  }

  // HOW THE PAGE KNOWS WHO MADE EACH CALL. A stamped `engine` is a fact; the fallback is an
  // inference from the record and is labelled as one, so the page never presents the second
  // as the first.
  const engineBasis = calls.length === 0 ? null
    : (bases.size === 1 && bases.has('engine field') ? 'engine field' : 'record evidence');

  const usable = calls.length > 0;
  const pub = published(all);

  // A TIER ROW MUST COUNT EVERY ENGINE IN IT, NOT JUST THE LAST ONE READ.
  // This map was keyed by tier and assigned in a loop over strategies, which was invisible while
  // only one strategy ever existed. It is not invisible now: the tier is INTRADAY for both live
  // engines, so the assignment kept only whichever came second, and the tier row silently reported
  // one engine's calls as the whole tier's. The counters are additive (winRatePct, netPct and netPF
  // are all re-derived from them by published()), so the fix is to sum the buckets and name both
  // engines rather than to pick one.
  const tierBuckets = new Map();
  const tierEngines = new Map();
  for (const [id, entry] of byStrategy.entries()) {
    const b = tierBuckets.get(entry.tier) || emptyBucket();
    for (const k of Object.keys(b)) b[k] += Number(entry.bucket[k]) || 0;
    tierBuckets.set(entry.tier, b);
    tierEngines.set(entry.tier, (tierEngines.get(entry.tier) || []).concat(id));
  }
  const tiers = {};
  for (const [tier, bucket] of tierBuckets.entries()) {
    const t = published(bucket);
    const who = tierEngines.get(tier);
    tiers[tier] = {
      calls: t.calls, closed: t.closed, wins: t.wins, winRatePct: t.winRatePct, netPct: t.netPct,
      targetHits: t.targetHits, stopsHit: t.stopsHit, otherExits: t.otherExits,
      decided: t.decided,
      // Both engines named, so a reader can see the tier is not one engine's book.
      strategyId: who.join('+'),
      engines: who,
    };
  }
  const flipped = pub.flippedByCost;

  return Object.assign(pub, {
    date,
    isToday,
    hasBook: usable,
    // Every call this session made, whichever strategy wrote it, with its POSITIVE/NEGATIVE
    // verdict. Newest last is the file order; the page sorts. Capped so a freak 5,000-call
    // file cannot bloat the payload — the cap is stated rather than silent.
    callRows: calls.slice(-500).map(callRow),
    callRowsTruncated: calls.length > 500 ? calls.length - 500 : 0,
    // NOT one engine's name: both live engines write this book, and naming only the minute
    // engine here is how 50 Sweep+FVG calls on 2026-10-07 came to be read as its calls. The
    // engines that actually appear in the file are listed per row under byStrategy.
    source: 'live call book · both live engines (see byStrategy)',
    netBasis: 'net of cost · ₹50,000 notional per call',
    tierBasis: 'ENGINE_CALLS',
    note: usable
      ? null
      : (opts.fileExists ? 'call book exists but the engine took no calls that session' : 'no call book for this session'),
    outcomes,
    tiers,
    engineBasis,
    netNote: flipped > 0
      ? flipped + ' call(s) counted WON on gross points turned negative after cost — see flippedByCost'
      : null,
    byStrategy: Array.from(byStrategy.values())
      .map((e) => Object.assign({ id: e.id, name: ENGINE_NAMES[e.id] || e.id, tier: e.tier }, published(e.bucket)))
      .sort((a, b) => (b.netPct === null ? -Infinity : b.netPct) - (a.netPct === null ? -Infinity : a.netPct)),
  });
}

/**
 * @param {object} [opts] { days, dir, now }
 * @returns {{ days: object[], tierBasisNote: object, notMeasured: string[] }}
 */
function callBookHistory(opts) {
  const options = opts || {};
  const dir = options.dir || DEFAULT_DIR;
  const wanted = Math.max(1, Math.min(60, Number(options.days) || 4));
  const today = istDate(options.now || Date.now());  // Walk back over sessions (weekdays) from today — a session with no book renders as
  // a dash plus its reason, never as zeros, so the row still appears.

  const dates = [today];
  for (let d = shiftDate(today, -1); dates.length < wanted; d = shiftDate(d, -1)) {
    if (isWeekend(d)) continue;
    dates.push(d);
  }
  const ordered = dates.slice().sort().reverse().slice(0, wanted);

  const days = ordered.map((date) => {
    const file = path.join(dir, `daily_calls_${date}.json`);
    let calls = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      calls = Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      calls = null;
    }
    return summariseDay(date, calls || [], { today, fileExists: fs.existsSync(file) });
  });

  const notMeasured = days.filter((d) => d.winRatePct === null).map((d) => d.date);

  return {
    days,
    tierBasisNote: {
      ENGINE_CALLS: 'live engine call book — every call the engine armed, tracked to target / stop / close',
    },
    notMeasured,
  };
}

// THE WIN RATE FOR ANY LIST OF CALL RECORDS, BY THE ONE RULE.
//
// Server routes and the engines used to re-derive a win rate with their own filters —
// `netInr1Lot > 0` counted a +₹0.01 close as a win, and a 15:30 flatten counted as a
// win or a loss depending on which file read it. Every surface now asks this function,
// so the same book always produces the same numbers.
function tallyOutcomes(records) {
  const bucket = emptyBucket();
  const list = Array.isArray(records) ? records : [];
  for (const call of list) addToBucket(bucket, classify(call), call);
  return published(bucket);
}

/**
 * THE LIVE RECORD ACROSS SESSIONS — the number the page could not show.
 *
 * WHY THIS EXISTS. Every surface read ONE day. `/api/final/board` builds its
 * per-strategy rows from `getActiveCandidates()` + `getClosedHistory()`, and the
 * engine drops both at the day rollover — so on a quiet morning, or on a weekend,
 * the page honestly printed "no measured calls yet today" and the owner read that
 * as "the strategy has never been measured live". It has; the books are on disk,
 * one file per session, and nothing was aggregating them.
 *
 * WHAT IT DOES NOT DO. It does not invent a session. A date with no file is
 * reported in `missing` and excluded from the numbers, so a three-session record
 * can say "these three, and these two never recorded" instead of silently reading
 * two gaps as two flat days. It also does not re-derive a win rate: every call
 * goes through `classify` + `addToBucket`, the same pair the daily ledger uses.
 *
 * @param {object} [opts] { sessions, dir, now }
 * @returns {{ sessions: object[], missing: string[], overall: object, byStrategy: object[] }}
 */
function liveRollingRecord(opts) {
  const options = opts || {};
  const dir = options.dir || DEFAULT_DIR;
  const wanted = Math.max(1, Math.min(30, Number(options.sessions) || 3));
  const today = istDate(options.now || Date.now());

  const picked = [];
  const missing = [];
  // Walk back from today over weekdays, stopping once `wanted` sessions WITH a book
  // have been collected. 90 days is a guard so a directory with no books at all
  // terminates instead of looping.
  for (let d = today, steps = 0; picked.length < wanted && steps < 90; steps++) {
    if (!isWeekend(d)) {
      const file = path.join(dir, `daily_calls_${d}.json`);
      if (fs.existsSync(file)) picked.push(d); else missing.push(d);
    }
    d = shiftDate(d, -1);
  }

  const all = emptyBucket();
  const byEngine = new Map();
  const sessionRows = [];

  for (const date of picked) {
    let calls = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, `daily_calls_${date}.json`), 'utf8'));
      calls = Array.isArray(parsed) ? parsed : [];
    } catch (_) { calls = []; }
    const day = emptyBucket();
    const dayByEngine = new Map();
    for (const call of calls) {
      const outcome = classify(call);
      addToBucket(day, outcome, call);
      addToBucket(all, outcome, call);
      const who = engineOf(call);
      if (!byEngine.has(who.id)) byEngine.set(who.id, emptyBucket());
      if (!dayByEngine.has(who.id)) dayByEngine.set(who.id, emptyBucket());
      addToBucket(byEngine.get(who.id), outcome, call);
      addToBucket(dayByEngine.get(who.id), outcome, call);
    }
    const pub = published(day);
    sessionRows.push({
      date, calls: pub.calls, decided: pub.decided, targetHits: pub.targetHits,
      stopsHit: pub.stopsHit, winRatePct: pub.winRatePct, netPct: pub.netPct, netPF: pub.netPF,
      byStrategy: Array.from(dayByEngine.entries())
        .map(([id, b]) => Object.assign({ id, name: ENGINE_NAMES[id] || id }, published(b))),
    });
  }

  const overall = published(all);
  return {
    // THE WINDOW IS STATED, NOT IMPLIED: which sessions are in the number, and which
    // dates in between had no book at all.
    sessionsIncluded: picked.slice().reverse(),
    missing: missing.slice().reverse(),
    windowLabel: picked.length
      ? ('last ' + picked.length + ' recorded session' + (picked.length === 1 ? '' : 's') +
         ' (' + picked.slice().reverse().join(', ') + ')')
      : 'no recorded session on disk',
    sessions: sessionRows.slice().reverse(),
    overall: Object.assign({}, overall, {
      sessions: picked.length,
      // The same net-in-R convention backtest/metrics.js uses is not derivable from a book
      // that stores bps, so net is reported in bps and percent — no R figure is invented here.
      basis: 'every call the engines wrote, classified by the one win rule: target hit = win, stop hit = loss',
    }),
    byStrategy: Array.from(byEngine.entries())
      .map(([id, b]) => Object.assign({ id, name: ENGINE_NAMES[id] || id }, published(b)))
      .sort((a, b) => b.calls - a.calls),
  };
}

// engineOf / strategyOf are exported because the LIVE engine builds its own rows for the board
// and the page polls them every three seconds. Both surfaces must name a call the same way —
// while the board's rows were stamped with one hardcoded strategy name and this reader
// attributed the same call to whichever engine actually wrote it, the per-strategy table and
// the day's history disagreed about the same trade.
module.exports = {
  callBookHistory, classify, tallyOutcomes, OUTCOME, istDate, engineOf, strategyOf, ENGINE_NAMES,
  liveRollingRecord,
};
