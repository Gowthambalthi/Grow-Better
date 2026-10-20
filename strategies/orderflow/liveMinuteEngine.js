/**
 * orderflow/liveMinuteEngine.js
 * 
 * REAL-TIME CONTINUOUS INSTITUTIONAL ORDER FLOW ENGINE
 * - Reads live Angel One WebSocket ticks every second.
 * - Maintains in-memory 1-minute OHLCV, Volume, Delta, and VWAP for all ~700 Indian stocks.
 * - Runs Institutional Setup Scan every 60 seconds (every minute).
 * - Enforces minimum targets >= 0.70% (70-120 bps) with R:R >= 1:1.60.
 * - Applies FVG Support + Delta Footprint + Volume Surge + Anti-Climax Guard.
 * - Immediately pushes newly generated calls to Telegram (@GBTerminalAlertsBot).
 * - Real-time tick-by-tick monitoring: checks Target (WON) and Stop Loss (LOST) every second.
 * - Dispatches exit alerts to Telegram on Target Hit or Stop Hit.
 * - Dynamically calculates today's total recommendations scorecard: Won, Lost, Win Rate, Net INR, Net Verdict.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const tickCapture = require('./tickCapture');
// ONE VOCABULARY FOR OUTCOMES. The call-book history reader (used by /api/final/daily)
// and this engine must name a close the same way, or the closed-calls table and the
// daily table disagree about the same trade. The classifier is shared, not copied.
// strategyOf() answers "which engine made this call" from the record's OWN `engine` stamp (both
// live writers set one). It is imported rather than re-derived here because the board rows and the
// day's history must attribute a call identically: the rows below used to carry a hardcoded
// strategy name, so every Sweep+FVG call on the page was presented as the minute engine's.
const { classify: classifyCall, strategyOf, tallyOutcomes } = require('../../common/market/callBookHistory');
// THE MEASURED BLOCKED WINDOWS (12:15-12:45 and 13:15-13:45 IST by default) live
// in backtest/follow.js beside the entry window they sit inside, so the replay
// harness, the board and this engine all read ONE list instead of three copies
// that can drift. See BLOCKED_WINDOWS there for the study and the rule.
const { BLOCKED_WINDOWS } = require('../../backtest/follow');
// L3 gate telemetry — RECORDS gate outcomes, never gates. See strategies/orderflow/gateTelemetry.js.
const gateTelemetry = require('./gateTelemetry');
// Core backtested OF03 engine (strategies/orderFlow.js)
const orderFlowEngine = require('../orderFlow');
const parityStamp = require('./parityStamp');
// THE BACKTESTED FVG ENGINE, ON THE LIVE TAPE (GB01 / GB02). Until this existed the
// intraday tier's FVG row was the Sweep+FVG confluence engine — a different rule
// that reads gaps — so the strategy with 73 measured trades had no live row at all.
// See strategies/fvg/liveAdapter.js for the three rules it enforces (closed bars
// only, each fed once, stale answers are not signals).
const { createLiveAdapter, istBarTime } = require('../fvg/liveAdapter');
// THE MEASURED CONFIGURATION, NOT A SECOND OPINION. `createEngine()` below used to
// pass only `{ symbol, minAtrPct }`, so `maxSignalTime` fell through to the module's
// DEFAULTS (12:30) while `strategy-core/engines.js` pinned the MEASURED 11:00 — i.e.
// live could arm an OF03 call from 11:00 to 12:30 that the backtest that justifies
// this engine never took. Reading the registry entry here means the live engine and
// the harness that produced data/terminal/backtest_results.json cannot disagree about
// the cutoff again; re-tuning it is one edit, in the registry, with its own artifact.
let OF03_CONFIG = {};
try {
  const registry = require('../../strategy-core/engines');
  const entry = registry.BY_KEY && registry.BY_KEY.ORDERFLOW;
  if (entry && entry.config) OF03_CONFIG = entry.config;
} catch (_) { /* no registry: the engine's own DEFAULTS apply, as before */ }

let sendPhoneNotification = null;
try {
  const tel = require('../../common/notifications/telegramService');
  sendPhoneNotification = tel.sendPhoneNotification;
} catch (_) {}

// ---------------------------------------------------------------------------
// ALERTS — WHOSE CALL IT IS, AND WHICH WAY IT POINTS
// ---------------------------------------------------------------------------
// The old new-call card was hard-coded "NEW INSTITUTIONAL BUY CALL" and a hard-coded
// "BUY" in the log line. Once GB03a (OF03 exhaustion) is on the tape that is simply
// false: its measured positive side is the SHORT, and a short announced as a buy is
// the one wording error a reader cannot undo after acting on it. Every new-call
// message is therefore built from the CALL's own side and its own GB code.
// WHICH FVG SETUPS MAY ARM. GB02 is out (see the comment in the FVG branch below), so the list is
// one entry long; a future re-measurement adds a setup here rather than a second if-statement.
const FVG_SETUPS = ['FG01'];
const GB_CODE = {
  FG01: 'GB01', FG02: 'GB02', FVG: 'GB01',
  GB01: 'GB01', GB02: 'GB02',
  OF03: 'GB03a', ORDERFLOW: 'GB03a', GB03: 'GB03a', GB03A: 'GB03a',
  GB04: 'GB04',
  OF_MOMENTUM: 'OF_MOMENTUM',
  OF_LONG_MOMENTUM: 'OF_MOMENTUM',
  OF_SHORT_MOMENTUM: 'OF_MOMENTUM',
};
function isShortCall(c) {
  return String((c && c.action) || '').toUpperCase().includes('SELL') ||
    String((c && c.side) || '').toUpperCase() === 'SHORT';
}
function gbCodeOf(c) {
  const id = String((c && (c.strategyId || c.setup)) || '').trim().toUpperCase();
  return GB_CODE[id] || String((c && c.engine) || 'LIVE');
}

// WHAT ALERT AN EVENT NAMES, AND WHY IT IS A KEY AND NOT A FLAG.
//
// On 2026-10-19 the same exit was announced two or three times, and the whole morning's
// OF_MOMENTUM book came back in one burst at 13:19 — because "already announced" was a fact
// held in ONE process's memory. A restart rebuilt the book and announced it again; a second
// running instance announced it in parallel. The key is therefore derived from the EVENT —
// this call, this outcome — so it is the same string in every process, and it is enforced by
// the transport (common/notifications/telegramService.js) rather than by each sender.
//
// `id` is the call's own id (`CALL-<SYM>-<date>-NNN`), so two calls on the same symbol the
// same day are two events and both are announced; an exit key carries the reason, so a call
// that is scratched at breakeven and later re-read as a stop cannot collide with itself.
function alertEventKey(kind, c) {
  const id = (c && (c.id || c.callId)) ||
    ['noid', c && c.symbol, c && (c.timeIST || c.timestamp || '')].join(':');
  return kind === 'exit'
    ? `exit:${id}:${(c && (c.exitReason || c.status)) || 'CLOSED'}`
    : `new:${id}`;
}

/**
 * Clean human-readable strategy label with GB code, e.g. "GB01 — 5m FVG Retest",
 * "GB03a — OF03 Exhaustion Reversal", "OF_MOMENTUM — Order Flow Institutional Momentum".
 */
function strategyNameOf(c) {
  const code = gbCodeOf(c);
  let name = c && c.strategyName;
  if (!name) {
    try {
      const s = strategyOf(c);
      if (s && s.name) name = s.name;
    } catch (_) {}
  }
  if (!name || name === code || name === 'engine' || name === 'LIVE' || name === 'ORDERFLOW' || name === 'FVG') {
    if (code === 'GB01') name = '5m FVG Retest';
    else if (code === 'GB03a') name = 'OF03 Exhaustion Reversal';
    else if (code === 'GB04') name = 'PDH/PDL Support & Resistance';
    else if (code === 'OF_MOMENTUM' || (c && c.engine === 'OF_MOMENTUM')) name = 'Order Flow Institutional Momentum';
    else name = String((c && (c.setup || c.strategyType || c.engine)) || 'Intraday');
  }
  const cleanName = String(name).replace(new RegExp('^' + code + '\\s+[—–-]\\s+'), '');
  return `${code} — ${cleanName}`;
}

// ---------------------------------------------------------------------------
// GB03a — WHICH SIDE MAY ARM, AND WHY THE DEFAULT IS THE SHORT
// ---------------------------------------------------------------------------
// The published measure (docs/GB-LIVE-2026-10-18.md, 705 sessions, 12:30 pin):
//   shorts 13 trades, +19.27R (+1.48R/trade)   ·   longs 12 trades, −3.29R (−0.27R/trade)
// The long side is negative before and after the pin moved, so "GB03a is positive"
// is a statement about its SHORTS. Arming both and calling the setup positive would
// put a measured-negative side on the board under a positive label, which is the
// exact mismatch this file keeps fixing elsewhere.
//
// The caveat travels with the switch, not just this comment: inside the
// pre-committed 172-session window GB03a is −0.423R/trade overall (9 trades), and its
// shorts there are ~−0.27R/trade on 4 — so the short side is the measured-better side
// of a setup that is not yet proven in the one window the framework trusts. The env
// override exists so that judgement call is reversible without a code edit:
//   GB03_SIDES=short (default) | both | long
const GB03_SIDES = (() => {
  const raw = String(process.env.GB03_SIDES || 'short').trim().toLowerCase();
  return ['short', 'long', 'both'].includes(raw) ? raw : 'short';
})();
function gb03SideAllowed(side) {
  if (GB03_SIDES === 'both') return true;
  return GB03_SIDES === 'short' ? side === 'SHORT' : side === 'LONG';
}
// The row/alert sentence for a GB03a call. The numbers are the measured ones, split
// by the side the call actually took, so the row never borrows the setup's whole-corpus
// +0.639R to describe a LONG it refuses to arm.
const GB03_MEASURED = {
  SHORT: 'GB03a measured: SHORT 13 trades, +19.27R (+1.48R/trade) on 705 sessions; inside the authorized 172-session window 4 trades, −0.054R net (−0.014R/trade, breakeven). Long side −3.29R on 12 (−0.750R/trade in that window) — not armed.',
  LONG: 'GB03a measured: LONG 12 trades, −3.29R (−0.27R/trade); inside the authorized window −3.75R on 5 (−0.750R/trade) — the negative side of this setup.',
};
// THE PLAN HAS NO `rr1`. `marketCore.withPlan` publishes the ratio as `plan.rr` (and as the
// signal's own `rr1`); `plan.rr1` is NEVER set. Reading it here threw "Cannot read properties of
// undefined (reading 'toFixed')" on EVERY OF03 signal, and because the scan's catch wraps the
// whole pass, one such symbol aborted the minute for all ~500 names — so GB03a could never arm
// anything at all. Caught by the 2026-07-08 live-vs-backtest parity run: GODREJPROP 10:46 showed
// `gb03.armed: 1` with an empty book. The point-derived ratio is the last fallback because it is
// always present when the planner built a plan.
function gb03RiskReward(sig, riskPts, rewardPts) {
  const p = (sig && sig.plan) || {};
  const rr = Number.isFinite(p.rr1) ? p.rr1
    : Number.isFinite(p.rr) ? p.rr
      : Number.isFinite(sig && sig.rr1) ? sig.rr1
        : (riskPts > 0 ? rewardPts / riskPts : null);
  return rr == null ? null : `1 : ${rr.toFixed(2)}`;
}
function gb03Note(sig) {
  const d = (sig && sig.setupData) || {};
  const facts = [];
  if (d.volumeRatio != null) facts.push('vol ' + Number(d.volumeRatio).toFixed(2) + 'x');
  if (d.deltaRatio != null) facts.push('delta ' + (Number(d.deltaRatio) * 100).toFixed(1) + '%');
  return 'GB03a OF03 exhaustion reversal' + (facts.length ? ' · ' + facts.join(' · ') : '') +
    (sig && sig.reason ? ' · ' + String(sig.reason) : '') + '. ' +
    (GB03_MEASURED[String(sig && sig.side || '').toUpperCase()] || '') +
    ' The whole authorized window is 9 trades, −0.423R/trade: the short side is the better-measured half of an unproven setup, not a proven edge.';
}

function rupee(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}
/** One new-call Telegram message. Exported so the wording is testable without a send. */
function newCallTelegramText(c) {
  const short = isShortCall(c);
  const code = gbCodeOf(c);
  const entry = Number(c.limitEntry);
  const stop = Number(c.stopLoss);
  const t1 = Number(c.target);
  const t2 = Number(c.target2);
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(t1 - entry);
  const pct = (from, to) => (from > 0 && Number.isFinite(to) ? (Math.abs(to - from) / from) * 100 : null);
  const rr = risk > 0 && reward > 0 ? '1 : ' + (reward / risk).toFixed(2) : (c.riskReward || '—');
  const stopPct = pct(entry, stop);
  const targetPct = pct(entry, t1);
  const parts = [
    (short ? '🔻' : '🟢') + ' <b>NEW ' + (short ? 'SHORT' : 'LONG') + ' CALL · ' + code +
      ' · ' + c.symbol + '</b>',
    (short ? '🔻' : '🟢') + ' <b>' + (short ? 'SELL / SHORT' : 'BUY / LONG') + '</b> @ live LTP <b>₹' +
      rupee(entry) + '</b> · ' + (c.strategyType || 'INTRADAY'),
    '🛑 Stop ' + (short ? 'above' : 'below') + ' <b>₹' + rupee(stop) + '</b>' +
      (stopPct == null ? '' : ' (' + (short ? '+' : '−') + stopPct.toFixed(2) + '% of entry)'),
    // THE TARGET % FOLLOWS THE PRICE, not the trader's profit. A short's target sits BELOW
    // entry, so "+0.38%" beside ₹437.99 under a ₹439.65 entry read as a move upward.
    '🎯 Target 1 <b>₹' + rupee(t1) + '</b>' +
      (targetPct == null ? '' : ' (' + (short ? '−' : '+') + targetPct.toFixed(2) + '%)') +
      (Number.isFinite(t2) && t2 > 0 ? '  ·  Target 2 ₹' + rupee(t2) : ''),
    '⚖️ Risk : Reward <b>' + rr + '</b> · risk ₹' + rupee(risk) + '/share',
    // THE PAGE SAYS "NET OF GROW BROKERAGE & ALL CHARGES"; THIS MESSAGE DID NOT. Entry, stop
    // and target were gross while the board and the exit alert both report 15 bps round trip,
    // so the alert quoted a reward the account never receives. The same 15 bps is applied
    // here, per share, at the target and at the stop.
    '💸 Net/share after 15 bps round trip: <b>' + (reward - entry * 0.0015 >= 0 ? '+' : '−') +
      rupee(Math.abs(reward - entry * 0.0015)) + ' at T1</b> / <b>−' + rupee(risk + entry * 0.0015) +
      ' at stop</b>',
    '⚙️ Strategy: <b>' + strategyNameOf(c) + '</b>',
  ];
  // THE CROSS-CHECK IS PART OF THE ALERT, not a separate report. The owner's test is "does the
  // deployed server take the trade the backtest measured" — that answer is worth most at the
  // moment the call is sent, and worthless a day later in a scratch file.
  const backtestCheck = parityStamp.describe(c.parity);
  if (backtestCheck) parts.push(backtestCheck);
  if (c.note) parts.push('📋 ' + String(c.note));
  if (c.measured) parts.push('📊 ' + String(c.measured));
  parts.push('🕒 Armed ' + (c.timeIST || '—') + ' IST · the entry is the live LTP, not a re-quote');
  parts.push('Not investment advice.');
  return parts.join('\n');
}

/** One exit Telegram message. Exported so wording and strategy branding can be tested directly. */
function exitTelegramText(c) {
  const info = classifyCall(c);
  const EMOJI = { TARGET_HIT: '🎯', STOP_LOSS_HIT: '🛑', BREAKEVEN_EXIT: '🛡️', STAGNATION_EXIT: '⏱️', SESSION_CLOSE: '📌' };
  const TITLE = {
    TARGET_HIT: 'TARGET 1 REACHED (WON)',
    STOP_LOSS_HIT: 'STOP LOSS HIT (LOST)',
    BREAKEVEN_EXIT: 'BREAKEVEN SCRATCH (CLOSED)',
    STAGNATION_EXIT: '45-MIN STAGNATION EXIT (CLOSED)',
    SESSION_CLOSE: 'SESSION CLOSE (CLOSED)',
  };
  const emoji = EMOJI[info.key] || '📌';
  const title = TITLE[info.key] || `CLOSED (${info.key})`;
  const sign = (v) => (Number(v) >= 0 ? '+' : '') + v;
  const netVal = Number(c && c.netInr1Lot) || 0;
  const netSign = netVal >= 0 ? '+' : '-';
  const netFormatted = `${netSign}₹${Math.abs(netVal).toFixed(2)}`;
  const stratLabel = strategyNameOf(c);

  return `${emoji} <b>${title}</b>\n\n` +
    `Strategy: <b>${stratLabel}</b>\n` +
    `Symbol: <b>#${c.symbol}</b>\n` +
    `Action: <b>${c.action}</b>\n` +
    `Entry Price: ₹${Number(c.limitEntry).toFixed(2)}\n` +
    `Exit Price: <b>₹${Number(c.exitPrice).toFixed(2)}</b>\n` +
    `Result: <b>${sign(c.grossPoints1Lot)} pts (${sign(c.livePnLPct)}%)</b>\n` +
    `Net P&L (net of 15 bps costs): <b>${netFormatted}</b>\n` +
    `Exit Time: <b>${c.exitTimeIST} IST</b>\n\n` +
    `<i>Track live on http://localhost:4000/final</i>`;
}

// GB_ORDERFLOW_DIR is the SAME override tickCapture uses, so a test or a replay
// harness can point both the tape and this engine's journal at a sandbox instead of
// touching today's real calls file. Unset in production: the path is unchanged.
const DATA_DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');

// DEPTH TRUST WINDOW. A level-1 book older than this is not evidence about where
// the book is NOW — the depth snapshot is throttled at source, so an old reading is
// a record of a moment that has passed. When depth is stale the ask-wall gate is
// skipped rather than guessed: refusing a trade on a five-second-old book would be
// a different kind of wrong than refusing it on a live one.
const DEPTH_MAX_AGE_MS = Number(process.env.GB_DEPTH_MAX_AGE_MS) || 5000;
// ASK-WALL GATE (longs only). The ask quantity divided by the bid quantity at L1.
// A big ask is overhead supply sitting on top of price, and a price-only scanner
// cannot see it.
//
// THE GATE IS CONDITIONAL, and how it got here is worth recording — it is the first
// thing this two-AI exchange settled with a measurement rather than an opinion:
//   - Freebuff added a flat block at >= 5x, on the grounds that a wall is supply.
//   - Antigravity objected that in a real displacement the wall is what gets SWEPT,
//     so a flat block discards exactly the explosive breakouts, and asked for the
//     wall to be judged together with aggression.
//   - EXP001 (experiments/EXP001.md, 2026-10-12, 16 settled calls joined against the
//     L2-L5 book) measured the ratio AT ENTRY: winners averaged 8.03, losers 0.71.
//     The thickest walls at entry belonged to the WINNERS (KOPRAN 24x, NRBBEARING
//     10.3x), and persistence separated nothing (wallPct 22.5% winners vs 22.5%
//     losers). So a FLAT block is measurably wrong on day 1.
//   - Resolution for now: block a wall only when it is NOT being absorbed — see
//     isAbsorbingWall below, Antigravity's rule, kept as written. EXP001-B decides
//     whether even that survives (it needs the trade prints, not the resting book).
//
// WHAT SURVIVES EITHER WAY IS THE MEASUREMENT, which is what was actually broken:
// the book's real bid/ask quantities are now correct on every row and printed in the
// call note (Book BI, bid qty, ask qty), so the operator can see the wall and judge
// it. Threshold is per-instance (this.askWallRatioMin) so a study can arm/disarm it
// at runtime; 0 disables the block entirely and keeps the measurement.
// SHIPPED OFF (0). The owner's objection was that an intraday trader reacts to PRICE
// moving and does not read the resting ladder, so a wall of posted ask quantity is not
// what stops a move — and the measurements agree: (a) the historical tick tapes carry
// no bid/ask at all, so this gate has never been validated on a single past session;
// (b) EXP009's variant comparison shows that removing order flow from the entry
// entirely leaves win rate and profit factor unchanged (LONG PF 0.42 -> 0.49, SHORT
// +4.5 -> +5.1 bps); (c) the gate blocked 68% of candidates in the funnel while
// testing nothing measurable. The code and the measurement are KEPT — setting
// GB_ASK_WALL_RATIO=5 restores the old behaviour exactly, and the tests arm it
// explicitly, so the decision is reversible and the numbers stay visible in the call
// note. This is the owner's instruction, not a silent removal of another AI's work.
const ASK_WALL_RATIO = Number(process.env.GB_ASK_WALL_RATIO) || 0;

// ---- MOMENTUM / "IN PLAY" — MEASURED, AND DELIBERATELY NOT A VETO -------------------
//
// The owner's reading on 2026-10-16: the engines were arming names with no momentum, and a stock
// that is not moving reaches neither target nor stop. That is testable, so it was tested before any
// rule was written, on the 995-symbol / 5.03M-sample 1-minute corpus, with the features and the kill
// rule fixed in advance:
//
//   * scratch/PREREGISTERED_MOMENTUM_GATE_STUDY.md → scratch/momentum_gate_study_2026-10-16.md
//     The forward 30-minute move IN THE DIRECTION OF THE STOCK'S OWN 15-MINUTE IMPULSE is ~0 bps
//     GROSS in every bucket: RVOL quintiles (best +0.20), |imp15| quintiles (best +0.93), range
//     expansion (best +0.42), position-in-range (best +0.11), VWAP side (best +0.15) — against a
//     10 bps round trip. The 2-D gate cells (RVOL tertile × |imp15| tertile) all fail: the best is
//     −9.07 net with a CI that never reaches 0. The locked kill rule (net ≥ +5 bps, CI lower bound
//     > 0, both splits, opposite direction not also paying) passed on NO cell.
//
//     So a momentum VETO would suppress calls without evidence it improves them. What high impulse
//     does buy is MOVEMENT — the median moves against the impulse (median −11 bps while the mean is
//     ~0) and the hit rate on direction barely beats chance (28% → 40% across quintiles) — which is
//     a stop-loss problem, not a signal.
//
//   * scratch/PREREGISTERED_ENGINE_LONG_REACHABILITY.md → scratch/engine_long_gate_reachability_2026-10-16.md
//     What the corpus DOES show is that this engine's long branch can hardly fire at all. Its own
//     conjunction — uptrend (price ≥ EMA20 ≥ EMA50) + up day (> 0.3%) + above VWAP + price in the
//     LOWER HALF of the day's range — passed on 16,944 of 10,817,525 sampled symbol-minutes =
//     0.157%, i.e. 0.069 passes per symbol-session, with 63 of 578 sessions producing not one pass
//     universe-wide. Dropping ONLY the fibonacci-discount condition takes it to 9.46%; buying the
//     TOP of the range instead gives 2.55%. The discount rule is the binding constraint.
//
// Neither finding licenses a new rule, so what ships is the MEASUREMENT: every scan publishes how
// much of the universe is in play and which gate refused each name, so "Candidates: 0 qualified"
// comes with its cause instead of being silence. `GB_IN_PLAY_MOVE15_BPS=0` disables the count.
const IN_PLAY_MOVE15_BPS = process.env.GB_IN_PLAY_MOVE15_BPS !== undefined
  ? Number(process.env.GB_IN_PLAY_MOVE15_BPS)
  : 26;                       // the held-out |imp15| tertile edge from the momentum study
const IN_PLAY_VOLSURGE = Number(process.env.GB_IN_PLAY_VOLSURGE) || 1.3;

/** Every reason the long branch can refuse a name, in the ORDER the branch evaluates them. */
function emptyFunnel() {
  return {
    scanned: 0, activeSymbol: 0, thinBars: 0, priceCap: 0, nonPositivePrice: 0,
    inPlay: 0, qualified: 0, armed: 0,
    // GB01/GB02 telemetry, filled at the END of a scan that actually walked the universe
    // (see the assignment before the gate-telemetry write). Null until then, so a blank
    // funnel cannot be mistaken for "the measured FVG engine looked and found nothing".
    fvg: null,
    // GB03a side policy, per scan: `armed` counts the calls the measured side produced and
    // `sideRefused` the signals the non-armed side produced. Published (see getScanFunnel)
    // so "why did no GB03a row appear" has a number even when the answer is "its longs
    // fired and were refused", rather than the same silence a dead engine gives.
    // `evaluated` is the count of symbols whose last CLOSED bar was handed to the OF03
    // engine in this scan. Without it, "the engine looked and found nothing" and "the
    // engine was never reached" were the same reading — `null` — which is exactly the
    // question the 2026-10-19 empty book could not answer from the funnel alone.
    // …and when the engine DOES emit and the planner refuses, `refusedPlanner` /`refusedGates`
    // name that too: on 2026-10-19 the whole day was 53 emissions and 53 refusals, so an
    // all-zero GB03a block with `evaluated: 494` is now the tell for "the setup never fired",
    // rather than the same silence a stopped engine gives.
    gb03: null,
    // OF_MOMENTUM — armed only when Server.js says so, and capped when it is. Null until a scan
    // stamps it, so a blank funnel cannot be read as "the prototype is off".
    ofMomentum: null,
    long: {
      longs_disabled: 0, trend_alignment: 0, fib_discount: 0, poc_overhead: 0,
      midday_window: 0, nifty_cascading: 0, spread: 0, climax_spike: 0,
      vwap_side: 0, vwap_band: 0, day_change: 0, delta: 0, confluence: 0,
      no_structure: 0, armed: 0,
    },
    short: { armed: 0, no_structure: 0, refused: 0 },
  };
}

// SESSION WINDOW. This engine used to arm at ANY hour the process happened to be
// running — it armed a long at 15:09, with 21 minutes left for a target to be
// reached and no mechanism to square it off. ARM_END is when NEW setups stop;
// monitoring of what is already open continues tick-by-tick until SESSION_CLOSE,
// where every open call is stamped SESSION_CLOSE so nothing is left looking armed
// overnight (orderflow/callOutcomes.js reaches the same verdict independently).
// SESSION WINDOW. ARM_END is when NEW setups stop; monitoring of what is already
// open continues tick-by-tick until SESSION_CLOSE (15:30 IST).
// 14:45 IST cutoff gives every entry at least 45 minutes of expansion room.
const ARM_END_MINUTE = Number(process.env.GB_LIVE_ARM_END_MINUTE) || (14 * 60 + 45);
const SESSION_CLOSE_MINUTE = Number(process.env.GB_LIVE_SESSION_CLOSE_MINUTE) || (15 * 60 + 30);

// CAPITAL-NORMALIZED POSITION SIZING.
// Instead of an arbitrary share price cap that eliminates top-tier liquid bluechips
// (e.g. NAVINFLUOR @ 8520), sizing is normalized to a fixed notional allocation
// (default ₹50,000 per position) so each trade carries equal portfolio weight.
const POSITION_NOTIONAL = Number(process.env.GB_POSITION_NOTIONAL) || 50000.0;
const RISK_INR = Number(process.env.GB_RISK_INR) || 0;
const MAX_SHARE_PRICE = Number(process.env.GB_MAX_SHARE_PRICE) || 50000.0;

// BID-ASK SPREAD GATE. Any spread wider than 6.0 bps introduces heavy execution slippage
// (crossing the spread eats 6-12 bps gross, which combined with 15 bps statutory taxes
// consumes >35% of a 74 bps target). Names with spread > 6.0 bps are refused.
const MAX_SPREAD_BPS = Number(process.env.GB_MAX_SPREAD_BPS) || 6.0;

// SHORT SCALP & INTRADAY GEOMETRY (MANDATE: R:R <= 1:1.50):
// Stop 45-55 bps (default 50 bps), Target 60-75 bps (default 75 bps, <= 1:1.50 R:R).
// Wide target mode (250 bps) can be activated via GB_SHORT_TARGET_BPS=250.
const SHORT_TARGET_BPS = Number(process.env.GB_SHORT_TARGET_BPS) || 75;
const LONG_ENABLED = process.env.GB_LONG_ENABLED !== '0';
const STRICT_INVALIDATION = process.env.GB_STRICT_INVALIDATION !== '0';
// Removed the contradictory session-discount constraint on longs by default (GB_FIB_DISCOUNT_LONG=1 to re-enable).
// As measured in scratch/engine_long_gate_reachability_2026-10-16.md, this restores long reachability from 0.157% to 9.46%.
const FIB_DISCOUNT_LONG = process.env.GB_FIB_DISCOUNT_LONG === '1';
// OF_MOMENTUM is an unverified prototype. In live production it is disarmed so only verified
// setups (GB01 and GB03a) run. In tests without the env var it defaults on.
//
// UNDEFINED NOW MEANS OFF OUTSIDE A TEST. The old expression (`!== '0'`) made an ABSENT variable
// mean ON, so the prototype ran live on every machine that had not set the flag — which is how
// ~10 calls arrived in 10 minutes on 2026-10-19 from an engine the page does not even advertise
// while the board reported GB01/GB03a. Its own comment said "in live production it is disarmed";
// this makes the code agree with the comment. Tests keep the previous behaviour (node:test sets
// NODE_TEST_CONTEXT), and GB_ENABLE_OF_MOMENTUM=1 turns it on deliberately.
const ENABLE_OF_MOMENTUM = process.env.GB_ENABLE_OF_MOMENTUM !== undefined
  ? process.env.GB_ENABLE_OF_MOMENTUM !== '0'
  : Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test');

// ARMED FOR A LIVE SESSION ONLY WHEN THE PROCESS SAYS SO OUT LOUD — AND CAPPED WHEN IT IS.
//
// The owner's decision on 2026-10-19 was to bring OF_MOMENTUM onto the live board: it is the
// strategy whose calls he has been seeing, and the 2026-10-19 review's own instruction was "if it is
// re-armed, cap it, log every admission with its score and rank among that minute's candidates, and
// judge it on 100+ decisions, not 20". All three are implemented here:
//   * the flag is `enableOfMomentumLive()`, called by Server.js (the only process that is live);
//     a harness or a test never calls it, so nothing off-board can arm these calls;
//   * `maxSlots` keeps the measured setups' room on a six-slot board, and `maxPerSession` bounds
//     the day — the review's complaint was that this engine admits far more than the book can hold
//     (3,131 gate passes, 21 slot-days) and that nothing ranked them by forward outcome;
//   * every admission prints its score AND its rank in that minute's candidate list, which is the
//     data the ranking experiment needs and which no live run has ever recorded.
const OF_MOMENTUM_LIVE = {
  armed: false,
  maxSlots: Number(process.env.GB_OF_MOMENTUM_SLOTS) || 3,
  maxPerSession: Number(process.env.GB_OF_MOMENTUM_MAX_PER_SESSION) || 12,
};
function ofMomentumArmed() {
  return ENABLE_OF_MOMENTUM || OF_MOMENTUM_LIVE.armed;
}

// ---- FVG STRUCTURAL RULES (research/fvg/FVG_DEEP_RESEARCH.md, Part 6.1) -------------
// The research conclusion is that an FVG is a LOCATION, not a signal: a bare mechanical
// gap has no measurable edge (PF 0.43 over 2,232 trades; the FVG component alone is
// +0.45R with a confidence interval that crosses zero). What the sources DO agree on,
// and what is implemented here, is the structure of a usable gap:
//   F1 QUALITY    gap >= max(8 bps, 0.10 x ATR) and the displacement candle's body is
//                 >= 60% of its own range. Both are published tool DEFAULTS, not optima.
//   F2 CE         the 50% midpoint (consequent encroachment) is the reference level: a
//                 short must sell INTO the imbalance (price at/above CE), never below it.
//   F3 LIVENESS   a COMPLETED close above the distal wick kills the gap. Dead is dead.
//   F4 STOP FIT   the structural stop (beyond the distal wick) must fit the owner's
//                 1:1.50 mandate (<= GB_FVG_MAX_STOP_BPS); a wider structural stop is
//                 refused rather than silently converted into a bps stop.
// Every rule reads only bars already seen, so the whole block is CAUSAL — the exact bug
// (full-session high/low for the fib gate) that inflated a prior +16.4 bps claim is not
// repeated here.
// GB_FVG_STRUCTURAL=0 disables the block; GB_FVG_REQUIRE=0 keeps the measurements and
// diagnostics but stops the gate from vetoing a short.
const FVG_STRUCTURAL = process.env.GB_FVG_STRUCTURAL !== '0';
// SHIPPED DEFAULT: measurement ON, VETO OFF. Measured causally across 8 sessions
// (scratch/measure_fvg_structural.js) the veto cut trades 51 -> 10 over the 5 older days and
// made the mean WORSE (-7.7 -> -16.7 bps), and produced ZERO trades on the recent 3 days. So
// the rules are computed, reported in the call record and pinned by tests, but they do not
// block an entry until someone asks for it: GB_FVG_REQUIRE=1 turns the veto on. This is the
// same treatment the ask-wall gate got — measured, kept, and not allowed to decide silently.
const FVG_REQUIRE = process.env.GB_FVG_REQUIRE === '1';
const FVG_MIN_ATR_FRAC = Number(process.env.GB_FVG_MIN_ATR_FRAC) || 0.10;
const FVG_MIN_BODY_FRAC = Number(process.env.GB_FVG_MIN_BODY_FRAC) || 0.60;
const FVG_MAX_STOP_BPS = Number(process.env.GB_FVG_MAX_STOP_BPS) || 55;

// ---- FVG CONFLUENCE WEIGHT (exchange.md Round 24) -----------------------------------
// The engine counts an FVG as ONE of four confluence points (FVG / liquidity sweep /
// volume surge / strong delta), so a setup can qualify on gap + volume alone. Round 24
// isolated the gap on our own tapes with everything else held constant and it does not
// pay: FVG_CE minus NO_FVG measured -2.6 bps at the live 1:1.50 shape and -8.0 bps at 2R
// over the past 5 sessions, both 95% bootstrap intervals straddling zero, with 3 of 4
// panels running AGAINST the gap. A point that carries no measured information still
// spends one of the two confluence slots a trade needs.
//
// SHIPPED DEFAULT: 1 — today's behaviour, UNCHANGED. Setting GB_FVG_CONFLUENCE_WEIGHT=0
// demotes the gap out of the count, so qualification then needs 2 of the remaining three
// (sweep / volume surge / strong delta). That is a DIFFERENT and untested population, so
// it is armed by env or per-instance only after the Round 24 (C) forward test — the same
// treatment GB_FVG_REQUIRE got. The weight is the only knob here: nothing silently changes
// what the engine trades today.
const FVG_CONFLUENCE_WEIGHT = process.env.GB_FVG_CONFLUENCE_WEIGHT === '0' ? 0 : 1;

// ---- EXIT GEOMETRY: WHO SETS THE STOP? (owner request, 2026-10-13) -------------------
// The Sweep+FVG engine's shipped footer says it: "Risk strictly capped at structural
// invalidation level." This engine instead ran a FIXED bend: stop = clamp 45–55 bps of
// `|vwapDistPct| + 0.25`, target 1.5× the stop (shorts capped by shortTargetBps). The owner
// asked for the structural shape here too. The two shapes live behind ONE picker so a test
// measures the rule the scan actually applies.
//
//   GB_STRUCT_STOP        '1' = structural, default OFF until the tape measurement says it
//                         pays net (measure first, exactly like GB_FVG_REQUIRE and the ask
//                         wall gate before it). MEASURED 2026-10-14 — it does NOT pay, and the
//                         first measurement of that day had to be VOIDED. Three recorded tapes
//                         through this engine's own scan/exit code (scratch/measure_struct_stop.js;
//                         Telegram stubbed, sandbox book), all three days in one process per
//                         shape. The earlier run reported 308 / 462 closed and +₹11,712.70 /
//                         -₹9,989.08 — VOID, because the engine leaked day state across tapes
//                         (see rolloverIfNewDay), which let a multi-day replay skip its own
//                         15-bar warm-up and price on yesterday's bars. After that fix, with
//                         solo-vs-multi-day equivalence proven:
//                           fixed  : 118 closed, win 61.0%, NET +₹7,557.96, -1.1 bps/trade
//                           struct : 170 closed, win 50.6%, NET -₹2,772.24, -17.8 bps/trade
//                         Worse on each day (-24.2 / -15.8 / +2.3 vs -10.4 / +38.2 / +16.2
//                         bps/trade), 36 short setups on the one full-arming day refused for
//                         having no structural level, and it arms MORE calls — a tighter stop
//                         resolves sooner and frees board slots — so the same 15 bps of friction
//                         is paid more often. Only 2026-10-07 arms a full session (the 10-12 and
//                         10-13 tapes start at 09:52 and 10:11 IST), so the margin is thinner
//                         than the pooled line suggests. DIRECTIONAL ONLY: two of the three days
//                         arm 4 trades each — do not quote these magnitudes as if they were
//                         measured on full sessions. Report: scratch/STRUCT_STOP_AB_2026-10-14.md.
//   GB_STRUCT_TARGET_RR   target = R × the structural risk (R:R mandate satisfied for R <= 1.5).
//                         Default 1.0 — the Sweep engine's shipped `riskReward1to1` profile
//                         (target exactly as far as the setup's own stop).
//   GB_STRUCT_MAX_STOP_BPS a structural invalidation farther than this is REFUSED, not
//                         silently converted into a bps stop (same honesty as F4).
//   GB_STRUCT_STOP_BUFFER_BPS buffer past the invalidation level, default 5 bps.
const STRUCT_STOP_DEFAULT = process.env.GB_STRUCT_STOP === '1';
const STRUCT_TARGET_RR_DEFAULT = Number(process.env.GB_STRUCT_TARGET_RR) || 1.0;
const STRUCT_MAX_STOP_BPS_DEFAULT = Number(process.env.GB_STRUCT_MAX_STOP_BPS) || 150;
const STRUCT_STOP_BUFFER_BPS_DEFAULT = Number(process.env.GB_STRUCT_STOP_BUFFER_BPS) || 5;

/**
 * THE ONE PLACE THE ENGINE PICKS ITS EXIT GEOMETRY. Both scan branches call this; a test
 * that wants to know what the engine does calls it too.
 *
 * dir = +1 (long) | -1 (short).
 * Fixed shape (shipped default)  : stop = clamp(45, 55, |vwapDistPct|+0.25 in bps),
 *                                  target = 1.5 × the risk (shorts additionally capped by
 *                                  `inst.shortTargetBps`, exactly as shipped).
 * Structural shape (GB_STRUCT_STOP=1):
 *   stop = the SETUP'S OWN invalidation level — for a short, the nearer of the 20-bar swing
 *   high (25-bar window excluding the last 5, the same window the BSL sweep rule uses) and
 *   a live bearish FVG's distal edge; for a long the mirror — with `buffer` bps past it.
 *   target = `inst.structTargetRr` × that risk.
 *   Returns null (a REFUSAL, counted by the caller) when no structural level exists in the
 *   bars already seen, when the level sits on the wrong side of price, or when it is farther
 *   than `inst.structMaxStopBps` — the risk is capped, never widened, and never faked.
 *
 * CAUSAL by construction: bars already seen only.
 */
function pickStopGeometry(dir, inst, bars, price, vwapDistPct, liveFvg) {
  if (!inst.structStopMode) {
    const stopBps = Math.max(45, Math.min(55, Math.round((Math.abs(vwapDistPct) + 0.25) * 100)));
    const stopPrice = dir > 0 ? +(price * (1 - stopBps / 10000)).toFixed(2)
                              : +(price * (1 + stopBps / 10000)).toFixed(2);
    let targetBps = Math.round(stopBps * 1.50);                 // Mandate: R:R <= 1:1.50
    if (dir < 0) targetBps = Math.min(inst.shortTargetBps || 75, targetBps);
    return { mode: 'FIXED_CLAMP', stopBps, stopPrice, targetBps };
  }
  // Structural mode. Swing window matches the sweep rules' 25/5 split.
  let swing = null;
  if (bars.length >= 25) {
    const win = bars.slice(-25, -5);
    swing = dir > 0 ? Math.min(...win.map(b => b.l)) : Math.max(...win.map(b => b.h));
  }
  const fvgEdge = liveFvg ? (dir > 0 ? liveFvg.bottom : liveFvg.top) : null;
  // The CAP is the NEAREST invalidation on the stop's side of price: for a long, the highest
  // structure below (a stop farther down widens risk the mandate refuses to take); for a
  // short, the lowest structure above. "Strictly capped at structural invalidation level."
  let level = null;
  if (swing != null && fvgEdge != null) level = dir > 0 ? Math.max(swing, fvgEdge) : Math.min(swing, fvgEdge);
  else if (swing != null) level = swing;
  else if (fvgEdge != null) level = fvgEdge;
  if (level == null || !(level > 0)) return null;
  const buffer = Math.max(0.05, price * (inst.structStopBufferBps || 0) / 10000);
  const stopPriceRaw = dir > 0 ? level - buffer : level + buffer;
  const stopBps = dir > 0 ? ((price - stopPriceRaw) / price) * 10000
                          : ((stopPriceRaw - price) / price) * 10000;
  if (stopBps <= 0) return null;               // structure is BEHIND price for this side
  if (stopBps > inst.structMaxStopBps) return null; // F4-style honesty: refuse, don't widen
  const stopBps2 = +stopBps.toFixed(1);
  const targetBps = Math.round(inst.structTargetRr * stopBps2);
  return {
    mode: 'STRUCT_INVALIDATION',
    stopBps: stopBps2,
    stopPrice: +stopPriceRaw.toFixed(2),
    targetBps,
    structLevel: +level.toFixed(2),
  };
}

/**
 * The confluence count BOTH scan branches use — the single source of truth for what a
 * trade must accumulate, so a test cannot describe arithmetic the engine does not apply
 * (same arrangement as `fvgShortGate`).
 *
 *   dir = +1 (long): the delta point needs deltaRatio > +0.15
 *   dir = -1 (short): the delta point needs deltaRatio < -0.15
 *
 * `fvgWeight` is the only thing that varies: 1 counts a live gap as a full point (today's
 * shipped behaviour), 0 demotes it so the two points must come from sweep / volume surge /
 * strong delta. The threshold itself (>= 2, or >= 3 when Nifty is bearish) is NOT changed
 * by this function — demoting the gap therefore makes qualification stricter, never looser.
 */
function confluenceCount(dir, { hasFvg, swept, volSurge, deltaRatio }, fvgWeight) {
  const deltaPoint = dir > 0 ? deltaRatio > 0.15 : deltaRatio < -0.15;
  return (hasFvg ? fvgWeight : 0) + (swept ? 1 : 0) + (volSurge > 1.3 ? 1 : 0) + (deltaPoint ? 1 : 0);
}

/** Mean true range of the last 8 bars, computed from the bars themselves. */
function fvgAtr(bars) {
  const w = bars.slice(-8);
  if (!w.length) return 0;
  return w.reduce((s, b) => s + (b.h - b.l), 0) / w.length;
}

/**
 * Locate the most recent FVG in the last 8 completed bars together with its ZONE.
 *
 * dir = -1 -> BEARISH gap (candle 1's low above candle 3's high): zone = [c3.high, c1.low]
 * dir = +1 -> BULLISH gap (candle 3's low above candle 1's high): zone = [c1.high, c3.low]
 *
 * Returns null when no gap clears F1, otherwise
 *   { dir, top, bottom, ce, gapBps, bodyFrac, idx, dead, live }
 * `dead` is F3: a completed bar after the gap closed beyond its far edge.
 * CAUSAL by construction — it looks only at bars already in the array.
 */
/**
 * The two entry-state rules that turn a gap into an allow/refuse decision for a SHORT.
 * Single source of truth: the scan uses this function and the tests call it directly, so
 * a test can never pass against a rule the engine does not actually apply.
 *
 *   FVG_DEAD          a completed close above the distal wick killed the gap (F3)
 *   CE_BELOW_GAP      price has not retraced to the 50% midpoint yet (F2)
 *   FVG_STOP_TOO_FAR  the structural stop would exceed the 1:1.50 mandate (F4)
 *   FVG_RECLAIMED     price is back ABOVE the far edge: a short's stop would not be above it
 *   BEARISH_FVG_CE    the gap is live, price is selling into its upper half — ALLOW
 *   NONE              no qualifying gap at all
 */
function fvgShortGate(bars, price) {
  const gap = findFvg(bars, -1);
  if (!gap) return { gate: 'NONE', gap: null, structuralStopBps: 0 };
  if (gap.dead) return { gate: 'FVG_DEAD', gap, structuralStopBps: 0 };
  if (!(price >= gap.ce)) return { gate: 'CE_BELOW_GAP', gap, structuralStopBps: 0 };
  // Above the distal edge the gap has been RECLAIMED. For a SHORT the structural stop has to sit
  // ABOVE the entry; up here the far edge is behind the price, so the arithmetic yields a NEGATIVE
  // stop that sails through the F4 cap and would report a nonsense trade as a qualified one.
  // Found by running the Node<->Python parity grid (scratch/fvg_parity_check.js), not by reading.
  if (price > gap.top) return { gate: 'FVG_RECLAIMED', gap, structuralStopBps: 0 };
  const structuralStopBps = +(((gap.top * (1 + 0.00005) - price) / price) * 10000).toFixed(1);
  if (structuralStopBps > FVG_MAX_STOP_BPS) {
    return { gate: 'FVG_STOP_TOO_FAR', gap, structuralStopBps };
  }
  return { gate: 'BEARISH_FVG_CE', gap, structuralStopBps };
}

function findFvg(bars, dir) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  const atr = fvgAtr(bars);
  const ref = bars[bars.length - 1].c || bars[bars.length - 1].h || 1;
  const atrBps = ref > 0 ? (atr / ref) * 10000 : 0;
  const minGapBps = Math.max(8, atrBps * FVG_MIN_ATR_FRAC);
  for (let i = bars.length - 1; i >= Math.max(2, bars.length - 8); i--) {
    const c1 = bars[i - 2];
    const mid = bars[i - 1];
    const c3 = bars[i];
    if (!c1 || !mid || !c3) continue;
    let top = null, bottom = null;
    if (dir < 0 && c3.h < c1.l) { bottom = c3.h; top = c1.l; }
    else if (dir > 0 && c3.l > c1.h) { bottom = c1.h; top = c3.l; }
    if (top === null || !(top > bottom)) continue;
    const gapBps = ((top - bottom) / (c3.c || c3.h)) * 10000;
    if (gapBps < minGapBps) continue;
    const range = mid.h - mid.l;
    const bodyFrac = range > 0 ? Math.abs(mid.c - mid.o) / range : 0;
    if (FVG_STRUCTURAL && bodyFrac < FVG_MIN_BODY_FRAC) continue;
    let dead = false;
    for (let k = i + 1; k < bars.length; k++) {
      if (dir < 0 && bars[k].c > top) { dead = true; break; }
      if (dir > 0 && bars[k].c < bottom) { dead = true; break; }
    }
    return {
      dir, top: +top.toFixed(4), bottom: +bottom.toFixed(4),
      ce: +((top + bottom) / 2).toFixed(4),
      gapBps: +gapBps.toFixed(1), bodyFrac: +bodyFrac.toFixed(3),
      idx: i, dead, live: !dead,
    };
  }
  return null;
}

// The IST calendar date a timestamp belongs to. Separate from getTodayIST() because a tick
// carries its OWN moment: the day boundary is decided by the tick (tape or wire), never by the
// wall clock, or a replay of an old tape would be attributed to today.
function istDateKey(ms = Date.now()) {
  const d = new Date(ms + 330 * 60000);
  return d.toISOString().slice(0, 10);
}

function getTodayIST() {
  return istDateKey();
}

/**
 * THE ONE FRICTION RULE, IN RUPPES — and it must be the SAME rule `netBps` applies.
 * `netBps` charges a flat 15 bps of the entry for a full round trip (₹20×2 brokerage,
 * STT 0.025% sell-side, NSE 0.00297%, SEBI ₹10/cr, 18% GST on those, 0.003% stamp on
 * the buy — ≈13 bps on a ₹50,000 Angel One MIS round trip; 15 bps keeps the margin).
 * The rupee figure used to charge a FLAT ₹0.20 against a `pts × shares` P&L, i.e.
 * ₹0.20 of "taxes" on a ₹50,000-notional position that really costs ~₹75 to close.
 * Every closed call therefore overstated its net by ~₹75, and the day's verdict
 * (getDailyNet → Telegram scorecard → /final) inherited the whole difference while the
 * card claimed "net of brokerage and exchange taxes". Charging the same rate on the
 * same notional makes the two metrics agree exactly: netInr = netBps/10000 × entry ×
 * shares. A call that never moved still reports 0 — pinned by test/depthOrientation.
 */
function netInrAfterCosts(pts, entry, shares) {
  const sh = shares || 1;
  if (!pts) return 0;
  const notional = (Number(entry) || 0) * sh;
  return +(pts * sh - notional * 0.0015).toFixed(2);
}

function getISTTimeString(ms = Date.now()) {
  const d = new Date(ms + 330 * 60000);
  return d.toISOString().slice(11, 19);
}

class LiveMinuteEngine {
  constructor() {
    this.today = getTodayIST();
    this.calls = new Map(); // id -> call
    this.closedCalls = [];
    this.symBars = new Map(); // symbol -> array of 1m bars { t, o, h, l, c, v, q, delta, buyVol, sellVol }
    this.prevPrice = new Map(); // symbol -> last price
    this.book = new Map(); // symbol -> { bid, bidq, ask, askq, t } last ORIENTED level-1 book
    this.ofEngines = new Map(); // symbol -> OF03 engine instance (strategies/orderFlow.js)
    // symbol -> the timestamp of the newest CLOSED bar handed to its OF03 engine, so every
    // closed bar is fed exactly once and in order (the engine's cooldown and its pending-
    // confirmation window are index-keyed, and a replay walks them one bar at a time).
    this.ofEngLastFedBarT = new Map();
    // GB01/GB02: one FVG engine per symbol, driven by the adapter rather than
    // inline, so the "which bars are closed / fed once" logic is testable alone.
    this.fvgLive = createLiveAdapter({});
    this.sessionClosed = false;
    // Per-instance so a study (or a test) can arm/disarm the wall gate at runtime
    // without re-requiring the module to re-read the env.
    this.askWallRatioMin = ASK_WALL_RATIO;
    this.armEndMinute = ARM_END_MINUTE;
    this.sessionCloseMinute = SESSION_CLOSE_MINUTE;
    // Per-instance, like the gates above: a study can set blockedWindows = [] at
    // runtime to measure what the gate costs without re-requiring the module.
    this.blockedWindows = BLOCKED_WINDOWS;
    this.maxSpreadBps = MAX_SPREAD_BPS;
    this.shortTargetBps = SHORT_TARGET_BPS;
    this.longEnabled = LONG_ENABLED;
    this.strictInvalidation = STRICT_INVALIDATION;
    this.requireFibDiscountLong = FIB_DISCOUNT_LONG;
    // Per-instance, like the wall gate above: a study can demote the FVG from the
    // confluence count at runtime (this.fvgConfluenceWeight = 0) without re-requiring.
    this.fvgConfluenceWeight = FVG_CONFLUENCE_WEIGHT;
    // EXIT GEOMETRY knobs are per-instance too, so the A/B measurement can flip the shape
    // on a second instance at runtime and the scan measures only what the flags say.
    this.structStopMode = STRUCT_STOP_DEFAULT;
    this.structTargetRr = STRUCT_TARGET_RR_DEFAULT;
    this.structMaxStopBps = STRUCT_MAX_STOP_BPS_DEFAULT;
    this.structStopBufferBps = STRUCT_STOP_BUFFER_BPS_DEFAULT;
    // Refusal ledger for structural mode: a refused SETUP is a measured event, not silence.
    this.structRefusals = { noStructure: 0, wrongSide: 0, tooFar: 0, long: 0, short: 0 };
    // THE SCAN FUNNEL — why nothing armed, counted per gate. See IN_PLAY_MOVE15_BPS above for the
    // two studies that decided this is a measurement rather than a veto.
    this.inPlayMove15Bps = IN_PLAY_MOVE15_BPS;
    this.inPlayVolSurge = IN_PLAY_VOLSURGE;
    this.scanFunnel = emptyFunnel();
    // Replay clock override (null in live; see istMinute()).
    this.replayTimeMs = null;
    // The last day boundary this instance crossed (see rolloverIfNewDay). Null until one is
    // crossed; a harness reads it as the record that the reset really ran.
    this.lastRollover = null;
    this.isScanning = false;
    this.scanInterval = null;
    this.monitorInterval = null;

    this.loadExistingCalls();
  }

  loadExistingCalls() {
    const today = this.today;
    const callsFile = path.join(DATA_DIR, `daily_calls_${today}.json`);
    if (fs.existsSync(callsFile)) {
      try {
        const arr = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
        if (Array.isArray(arr)) {
          for (const c of arr) {
            this.calls.set(c.id, c);
            if (['WON', 'LOST', 'SESSION_CLOSE', 'TIME_EXIT', 'CLOSED'].includes(c.status)) {
              this.closedCalls.push(c);
            }
          }
          console.log(`[liveMinuteEngine] Loaded ${arr.length} existing calls for ${today} (${this.closedCalls.length} closed)`);
        }
      } catch (e) {
        console.error('[liveMinuteEngine] Error loading calls:', e.message);
      }
    }
  }

  /**
   * A DAY BOUNDARY MUST EMPTY THE ENGINE, NOT POLLUTE IT.
   *
   * Every per-session value this instance holds IS session-scoped, but nothing ever cleared it —
   * the constructor was the only place `symBars`, `prevPrice`, `book`, `calls`, `closedCalls`,
   * `structRefusals` and `sessionClosed` were set. The scan walks the WHOLE `symBars` array for
   * VWAP, day high/low and `firstPrice = bars[0].o` (the array holds 390 bars, so ~375 of them are
   * the previous session's), which means on day two the `dayChangePct > 0.3` / `< -0.3` gates
   * compare today's price against YESTERDAY'S open, and VWAP is a two-day average. Measured
   * 2026-10-14, same tape: 2026-10-13 replayed ALONE closed 40 calls for +₹3,201; as the third day
   * of a three-day replay it closed 192 for -₹99.50 — and once this boundary exists the two agree
   * to the rupee (40 closed / +₹3,201.44 both ways, pinned by test/dayRollover.test.js). The leak
   * also let a multi-day replay arm from a tape's first tick: `scanMinuteTape()` requires 15 of the
   * day's OWN bars, which yesterday's array already had.
   *
   * `sessionClosed` is the same defect with teeth. It is set at the 15:30 close and re-initialised
   * only in the constructor, so from day two onward `closeSession()` returns on its own guard and a
   * day's book is NEVER settled at its close — the 2026-10-13 replay ended holding six calls still
   * ARMED that a real session would have settled at 15:30.
   *
   * Order matters: the OUTGOING day is settled and its scorecard marked BEFORE `this.today` moves,
   * so both key to the day being closed. A tape that ended before 15:30 leaves open calls at the
   * boundary; they are settled here and counted in `lastRollover.openSettled`, never dropped in
   * silence and never carried onto the new day's board.
   */
  rolloverIfNewDay(ms) {
    const dayKey = istDateKey(ms);
    if (dayKey === this.today) return false;

    // A SESSION ONLY EVER MOVES FORWARD. An out-of-order or backfilled tick dated BEFORE today
    // is not a new session, and treating it as one settles the live book, CLEARS it, and re-fires
    // the session summary — all keyed to a day that is already over. That is what emptied the
    // 2026-10-19 book while its Telegram messages stayed in the chat: the log read
    // `DAY ROLLOVER 2026-10-19 -> 2026-10-17`, i.e. backwards, then forward again, wiping the
    // book twice. A tick from the past is ignored for rollover; only a LATER day rolls the day.
    // (ISO date keys compare correctly as strings.)
    if (dayKey < this.today) return false;

    const from = this.today;
    const carried = this.calls.size;
    let openSettled = 0;
    if (!this.sessionClosed) {
      for (const c of this.calls.values()) if (c.status === 'ARMED') openSettled++;
      this.closeSession(ms);
    }
    const symbolsCleared = this.symBars.size;
    this.today = dayKey;
    this.symBars.clear();
    this.prevPrice.clear();
    this.book.clear();
    if (this.ofEngines) this.ofEngines.clear();
    if (this.ofEngLastFedBarT) this.ofEngLastFedBarT.clear();
    // The FVG engines are per-session too: a zone formed yesterday is not a zone
    // today, and its frames must start from this morning's first bar.
    if (this.fvgLive) this.fvgLive.reset();
    this.calls.clear();
    this.closedCalls.length = 0;
    this.structRefusals = { noStructure: 0, wrongSide: 0, tooFar: 0, long: 0, short: 0 };
    // The funnel is per-session like every other counter here: yesterday's refusal counts next to
    // today's scan would say the gates refused names they never saw.
    this.scanFunnel = emptyFunnel();
    this.sessionClosed = false;
    this.lastRollover = { from, to: dayKey, carried, openSettled, symbolsCleared };
    // A restart earlier the same session may already have written this day's book (the engine
    // loads it at construction for exactly this reason); resuming is not the same as carrying
    // yesterday's state, so it happens AFTER the clear.
    this.loadExistingCalls();
    console.log(`[liveMinuteEngine] DAY ROLLOVER ${from} -> ${dayKey}: dropped ${symbolsCleared} symbol(s) of ` +
      `bars plus the book and ${carried} call(s) from the closed day; ${openSettled} open call(s) settled at the ` +
      `boundary. No yesterday VWAP, day range or day-change reaches the new session.`);
    return true;
  }

  /**
   * ONE FILE, TWO ENGINES — SO A WRITE MUST NOT ERASE WHAT IT DOES NOT HOLD.
   *
   * `data/orderflow/daily_calls_<date>.json` is the day's call book, and TWO live engines write
   * it: this one and the Sweep+FVG engine (orderflow/sweepFvgLive.js, same default journalDir,
   * same `CALL-<SYM>-<date>-NNN` id format). Sweep's own writer already refuses to erase records
   * it does not hold and says so loudly; this one used to serialise ONLY its in-memory map, so
   * every arm or close here rewrote the whole file with this engine's calls alone.
   *
   * That is not theoretical. It is visible on 2026-10-12: the Sweep+FVG signal journal has five
   * records at 11:24, the book was rewritten at 19:29 by this engine, and NOT ONE sweep record
   * survives in it. The owner's request — "history of what happened to the given calls" — is
   * precisely what a truncating write destroys, and it destroys it silently.
   *
   * Records the engine does not itself hold are therefore carried over, and carried over LOUDLY,
   * because a silent merge is indistinguishable from a bug. Identity is the `id` when the record
   * carries one and the setup itself otherwise, so re-reading never double-writes and a stale copy
   * of this engine's own call can never outlive the live one.
   */
  saveCalls() {
    // `this.today`, not the wall clock: the book belongs to the SESSION the engine is playing.
    // In live the two agree except across midnight (where this is the correct one); in a replay
    // this keys the book to the tape's day instead of to the day the study happens to run on.
    const today = this.today;
    const callsFile = path.join(DATA_DIR, `daily_calls_${today}.json`);
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const allCalls = Array.from(this.calls.values());
      const keyOf = (c) => (c && c.id)
        ? 'id:' + c.id
        : ['k:', c && c.symbol, c && c.side, c && c.timeIST, c && c.limitEntry, c && c.stopLoss].join('|');
      const held = new Set(allCalls.map(keyOf));
      // A BOOK WE CANNOT READ IS A BOOK WE MUST NOT OVERWRITE.
      //
      // This is the failure that emptied 2026-10-19's book. The read/parse used to sit in its own
      // try/catch whose fallback was "this engine's own records" — and when the file could not be
      // read (a second writer mid-`writeFileSync`, which on Windows truncates the target before it
      // writes it, or a locked handle), that fallback was an EMPTY array for an engine holding
      // nothing yet. It then wrote `[]` over the day. The file's own comment promised the opposite
      // ("an unreadable or half-written file must never cost the day"), and the code did exactly
      // that: the day's calls — six armed at 09:36, plus every call the other engine wrote — were
      // gone from the board and from the next restart's book, which is what the owner reported.
      //
      // So: read the raw text first. If the file exists and cannot be read OR does not parse, keep
      // it, keep a copy of it, keep this engine's records beside it, and refuse to write. The next
      // save retries, and a save that CAN read the file merges normally.
      const exists = fs.existsSync(callsFile);
      let raw = null;
      if (exists) {
        try { raw = fs.readFileSync(callsFile, 'utf8'); } catch (e) {
          console.error(`[liveMinuteEngine] cannot READ ${path.basename(callsFile)} (${e.message}) — refusing to ` +
            `overwrite it. The day's book is left exactly as it is until it can be read.`);
          return;
        }
      }
      let toWrite = allCalls;
      if (raw != null && raw.trim() !== '') {
        let onDisk = null;
        try { onDisk = JSON.parse(raw); } catch (_) { onDisk = null; }
        if (onDisk === null) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          try {
            fs.writeFileSync(`${callsFile}.corrupt-${stamp}`, raw, 'utf8');
            fs.writeFileSync(`${callsFile}.unmerged-${stamp}.json`, JSON.stringify(allCalls, null, 2), 'utf8');
          } catch (_) {}
          console.error(`[liveMinuteEngine] ${path.basename(callsFile)} is not readable JSON — REFUSING to ` +
            `overwrite it. Kept the file, wrote ${path.basename(callsFile)}.corrupt-${stamp} and this engine's ` +
            `${allCalls.length} record(s) to .unmerged-${stamp}.json. Reconcile, then save again.`);
          return;
        }
        const carried = Array.isArray(onDisk) ? onDisk.filter((c) => c && !held.has(keyOf(c))) : [];
        if (carried.length) {
          toWrite = allCalls.concat(carried);
          console.log(`[liveMinuteEngine] calls file carried over ${carried.length} record(s) this engine does not ` +
            `hold (${carried.map((c) => c.symbol).join(', ')}) - not erased. They stay in the day's record ` +
            `but not in this engine's own live book.`);
        }
      }
      // WRITTEN THROUGH A TEMP FILE AND RENAMED, so a reader in another process can never observe a
      // half-written document — which is what made the readers fail in the first place.
      const tmpFile = `${callsFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(toWrite, null, 2));
      fs.renameSync(tmpFile, callsFile);
    } catch (e) {
      console.error('[liveMinuteEngine] Error saving calls:', e.message);
    }
  }

  // Pre-seed today's bars from the tape file on startup
  async loadTapeBars() {
    const tapeFile = path.join(DATA_DIR, `ticks-${this.today}.jsonl`);
    if (!fs.existsSync(tapeFile)) {
      console.log('[liveMinuteEngine] No prior tape file found for today; starting clean from live stream.');
      return;
    }

    console.log(`[liveMinuteEngine] Pre-loading historical bars from ${path.basename(tapeFile)}...`);
    const fileStream = fs.createReadStream(tapeFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let count = 0;
    for await (const line of rl) {
      if (!line) continue;
      count++;
      try {
        const t = JSON.parse(line);
        // TODAY'S TAPE ONLY. A warm-up file can carry rows from an earlier session (the boot log
        // on 2026-10-19 showed a rollover to 2026-10-17), and those bars do not belong in today's
        // VWAP, day range or day-change. Rollover refuses to go back; this refuses to mix days.
        if (t.t && istDateKey(t.t) !== this.today) continue;
        this.ingestTick(t, false);
      } catch (_) {}
    }
    console.log(`[liveMinuteEngine] Pre-loaded ${count} ticks across ${this.symBars.size} symbols.`);
  }

  // Ingest a single tick in real-time
  ingestTick(t, live = true) {
    const sym = t.s;
    if (!sym || !(t.p > 0)) return;
    // THE DAY BOUNDARY IS DECIDED BY THE TICK. A new session must start from an empty engine,
    // or today's VWAP and day-change are computed over yesterday's bars (see rolloverIfNewDay).
    if (t.t) {
      this.rolloverIfNewDay(t.t);
      // A LIVE TICK FROM AN EARLIER DAY IS NOT TODAY'S DATA, and building a bar from it would put
      // an old price into today's series — corrupting VWAP, day range and day-change. Rollover
      // refuses to go back (see above); this stops the bar. A backtest/replay caller passes
      // `live = false` and is deliberately allowed to feed historical bars into its own session.
      if (live && istDateKey(t.t) < this.today) return;
    }

    const minKey = Math.floor(t.t / 60000) * 60000;
    let bars = this.symBars.get(sym);
    if (!bars) {
      bars = [];
      this.symBars.set(sym, bars);
    }

    // AGGRESSOR CLASSIFICATION — the book first, the tick rule only as the fallback
    // (the Lee-Ready convention). A print at or above the ask was lifted by a buyer,
    // a print at or below the bid was hit by a seller; only prints inside the spread
    // fall back to up-tick/down-tick.
    //
    // THIS BLOCK WAS DEAD CODE UNTIL NOW. The guard read `t.ask > t.bid`, but the
    // feed hands the sides over reversed (see tickCapture.orientLevel1), so the
    // guard was false on literally every row and the engine fell straight through
    // to the tick rule — the book was never consulted even though it was captured.
    // orientLevel1 normalises first, so the same code now works whether or not the
    // feed's side labels are trustworthy.
    let isBuy = false, isSell = false;
    const book = tickCapture.orientLevel1(t.bid, t.bidq, t.ask, t.askq);
    if (book.bid > 0 && book.ask > 0 && book.ask > book.bid) {
      if (t.p >= book.ask) isBuy = true;
      else if (t.p <= book.bid) isSell = true;
    }
    const prev = this.prevPrice.get(sym);
    if (!isBuy && !isSell && prev != null) {
      if (t.p > prev) isBuy = true;
      else if (t.p < prev) isSell = true;
    }
    this.prevPrice.set(sym, t.p);
    // Keep the level-1 book for the scanner: the ask wall and the book imbalance are
    // properties of the RESTING book, not of this print, so they are read from the
    // most recent orientation-correct snapshot rather than from the trade itself.
    if (book.bid > 0 && book.ask > 0 && book.ask > book.bid) {
      this.book.set(sym, {
        bid: book.bid, bidq: Number(book.bidq) || 0,
        ask: book.ask, askq: Number(book.askq) || 0,
        t: t.t || Date.now(),
      });
    }

    const q = t.q || 1;
    let currentBar = bars.length > 0 ? bars[bars.length - 1] : null;

    if (!currentBar || currentBar.t !== minKey) {
      currentBar = {
        t: minKey,
        o: t.p,
        h: t.p,
        l: t.p,
        c: t.p,
        v: q,
        delta: isBuy ? q : (isSell ? -q : 0),
        buyVol: isBuy ? q : 0,
        sellVol: isSell ? q : 0,
      };
      bars.push(currentBar);
      if (bars.length > 390) bars.shift(); // keep full 1-day 375 bars
    } else {
      currentBar.c = t.p;
      if (t.p > currentBar.h) currentBar.h = t.p;
      if (t.p < currentBar.l) currentBar.l = t.p;
      currentBar.v += q;
      if (isBuy) { currentBar.delta += q; currentBar.buyVol += q; }
      else if (isSell) { currentBar.delta -= q; currentBar.sellVol += q; }
    }

    // If live, monitor open positions on this symbol in real-time
    if (live) {
      this.checkPositionForTick(sym, t.p);
    }
  }

  // Hook called on every incoming tick from Angel One WebSocket
  onTick(tick) {
    if (!tick) return;
    this.ingestTick(tick, true);
  }

  // Check open calls for a specific symbol on every incoming tick
  checkPositionForTick(symbol, livePrice) {
    const nowIST = getISTTimeString(this.istNowMs());

    for (const c of this.calls.values()) {
      if (c.symbol !== symbol || ['WON', 'LOST', 'SESSION_CLOSE', 'TIME_EXIT', 'CLOSED'].includes(c.status)) continue;

      c.ltp = livePrice;
      c.ltpAt = Date.now();
      const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
      const entry = Number(c.limitEntry) || livePrice;

      const pts = isShort ? (entry - livePrice) : (livePrice - entry);
      const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;
      c.livePoints = +pts.toFixed(2);
      c.livePnLPct = +pnlPct.toFixed(2);
      c.livePnLVal = +pts.toFixed(2);
      c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
      c.mfePct = Math.max(c.mfePct || 0, pnlPct);

      // DYNAMIC BREAKEVEN LOCK (EXP004):
      // When trade reaches +0.50% profit (50 bps MFE), automatically trail stop to entry + 15 bps friction floor.
      // This protects winning runners from round-tripping into full stop-outs.
      if (!c.breakevenArmed) {
        if (!isShort && pnlPct >= 0.50) {
          c.breakevenArmed = true;
          const beStop = +(entry * 1.0015).toFixed(2); // entry + 15 bps to cover all taxes & brokerage
          if (beStop > c.stopLoss) {
            c.stopLoss = beStop;
            c.note = (c.note || '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]';
            console.log(`[liveMinuteEngine] 🛡️ BREAKEVEN LOCKED: ${c.symbol} reached +${pnlPct.toFixed(2)}% MFE, trailing SL to ₹${c.stopLoss}`);
          }
        } else if (isShort && pnlPct >= 0.50) {
          c.breakevenArmed = true;
          const beStop = +(entry * 0.9985).toFixed(2);
          if (beStop < c.stopLoss) {
            c.stopLoss = beStop;
            c.note = (c.note || '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]';
            console.log(`[liveMinuteEngine] 🛡️ BREAKEVEN LOCKED: ${c.symbol} reached +${pnlPct.toFixed(2)}% MFE, trailing SL to ₹${c.stopLoss}`);
          }
        }
      }

      // 45-MINUTE MOMENTUM STAGNATION STOP (EXP007B):
      // If position has been active for >= 45 minutes and failed to achieve >= +0.35% MFE,
      // order flow momentum has evaporated. Exit at market to free slot and prevent afternoon liquidation dumps.
      const elapsedMs = Date.now() - (c.timestamp || Date.now());
      const elapsedMin = elapsedMs / 60000;
      if (elapsedMin >= 45.0 && (c.mfePct || 0) < 0.35) {
        // NOT A WIN, NOT A LOSS. This used to be `pts >= 0 ? 'WON' : 'LOST'`, which
        // stamped ✅ WON on a call that was flattened because momentum faded — one paisa
        // of gross drift was enough. Nothing was touched: the target was not reached and
        // the stop was not hit. Only a level decides a winner; a time exit closes the
        // position and says why (exitReason below), and the shared classifier reports it
        // as TIME EXIT.
        c.status = 'CLOSED';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'STAGNATION_EXIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        c.note = (c.note || '') + ` [⏱️ 45M STAGNATION EXIT: Momentum faded (peak +${(c.mfePct || 0).toFixed(2)}% MFE)]`;
        this.closedCalls.push(c);
        this.saveCalls();
        const won = pts >= 0;
        console.log(`[liveMinuteEngine] ⏱️ STAGNATION EXIT: ${c.symbol} exited at ${nowIST} after ${elapsedMin.toFixed(0)}m (MFE: +${(c.mfePct || 0).toFixed(2)}%)`);
        this.dispatchTelegramExit(c, won);
        continue;
      }

      // Check Target Hit (WON)
      if (!isShort && livePrice >= c.target) {
        c.status = 'WON';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'TARGET_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        this.closedCalls.push(c);
        this.saveCalls();
        console.log(`[liveMinuteEngine] 🎯 TARGET REACHED: ${c.symbol} WON +${pts.toFixed(2)} pts (+${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, true);
      } else if (isShort && livePrice <= c.target) {
        c.status = 'WON';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'TARGET_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        this.closedCalls.push(c);
        this.saveCalls();
        console.log(`[liveMinuteEngine] 🎯 TARGET REACHED: ${c.symbol} WON +${pts.toFixed(2)} pts (+${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, true);
      }
      // Check Stop Loss Hit (LOST or BREAKEVEN)
      else if (!isShort && livePrice <= c.stopLoss) {
        // A BREAKEVEN SCRATCH IS NOT A WIN. `pts >= 0` counted +₹0.01 of gross drift as
        // ✅ WON on a call whose net was −15 bps after costs — the "0.01 shown as a win"
        // complaint. The breakeven lock closes the trade at its cost floor; that is a
        // CLOSED trade with reason BREAKEVEN_EXIT, and only a real stop is LOST.
        c.status = c.breakevenArmed ? 'CLOSED' : 'LOST';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = c.breakevenArmed ? 'BREAKEVEN_EXIT' : 'STOP_LOSS_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        this.closedCalls.push(c);
        this.saveCalls();
        const won = c.status === 'WON';
        console.log(`[liveMinuteEngine] ${c.exitReason === 'BREAKEVEN_EXIT' ? '🛡️ BREAKEVEN SCRATCH' : '🛑 STOP LOSS HIT'}: ${c.symbol} ${c.status} ${pts.toFixed(2)} pts (${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, won);
      } else if (isShort && livePrice >= c.stopLoss) {
        // A BREAKEVEN SCRATCH IS NOT A WIN. `pts >= 0` counted +₹0.01 of gross drift as
        // ✅ WON on a call whose net was −15 bps after costs — the "0.01 shown as a win"
        // complaint. The breakeven lock closes the trade at its cost floor; that is a
        // CLOSED trade with reason BREAKEVEN_EXIT, and only a real stop is LOST.
        c.status = c.breakevenArmed ? 'CLOSED' : 'LOST';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = c.breakevenArmed ? 'BREAKEVEN_EXIT' : 'STOP_LOSS_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        this.closedCalls.push(c);
        this.saveCalls();
        const won = c.status === 'WON';
        console.log(`[liveMinuteEngine] ${c.exitReason === 'BREAKEVEN_EXIT' ? '🛡️ BREAKEVEN SCRATCH' : '🛑 STOP LOSS HIT'}: ${c.symbol} ${c.status} ${pts.toFixed(2)} pts (${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, won);
      }
    }
  }

  /**
   * AN ALERT THAT DID NOT SEND IS A MEASURED EVENT, NOT SILENCE.
   *
   * `sendPhoneNotification()` answers `{success:false, reason:'Bot token is missing.'}`
   * when nothing is configured, and every dispatcher here used to throw that answer
   * away (`catch (_) {}`). The result was an operator who could not tell "no call was
   * made" from "the bot has no token": the alert path failed invisibly for as long as
   * the token was missing. The state is kept on the instance (and printed once), so
   * "no alert arrived" always has a reason attached to it.
   */
  noteAlertResult(res, err) {
    const ok = !!(res && res.success);
    const reason = ok ? null : ((res && res.reason) || (err && err.message) || 'send failed with no reason given');
    this.alertState = { ok, reason, at: new Date().toISOString() };
    if (!ok && !this.alertWarned) {
      this.alertWarned = true;
      // THE HINT ONLY APPLIES WHEN NOTHING IS CONFIGURED. It used to be appended to every
      // reason, so a valid bot token with no linked chat was reported as "add
      // TELEGRAM_BOT_TOKEN" — telling the operator to add what they already had.
      const nothingSet = /no TELEGRAM_BOT_TOKEN and no WHATSAPP_API_KEY/.test(reason);
      console.warn('[liveMinuteEngine] ⚠️ ALERTS ARE NOT BEING SENT: ' + reason +
        (nothingSet ? ' — add TELEGRAM_BOT_TOKEN (+ TELEGRAM_CHAT_ID) or WHATSAPP_API_KEY + USER_PHONE_NUMBER to .env and restart.' : ''));
    }
    return ok;
  }


  // Telegram Alert for Exit
  async dispatchTelegramExit(c, won) {
    if (!sendPhoneNotification) return;
    try {
      this.noteAlertResult(await sendPhoneNotification(exitTelegramText(c), {
        dedupeKey: alertEventKey('exit', c),
      }));
    } catch (e) { this.noteAlertResult(null, e); }
  }

  // Telegram Alert for New Call. The message states the CALL's own side and GB code;
  // the sender paces it TELEGRAM_GAP_MS behind any earlier message (see
  // common/notifications/sendPacer.js), so several calls armed in one scan arrive one
  // at a time instead of as one burst.
  async dispatchTelegramNewCall(c) {
    if (!sendPhoneNotification) return;
    try {
      this.noteAlertResult(await sendPhoneNotification(newCallTelegramText(c), {
        dedupeKey: alertEventKey('new', c),
      }));
    } catch (e) { this.noteAlertResult(null, e); }
  }

  // Current IST minute-of-day. A METHOD rather than a bare call so a test can pin
  // the clock without faking Date globally (which would also move the depth-age
  // check in the same breath).
  //
  // `this.replayTimeMs` (set per instance, null in live) pins the clock to a RECORDED
  // moment, so a replay harness can walk an old tape through this same code path: the
  // session gates (arm cutoff, close minute) then evaluate on the TAPE's minute, not
  // on the machine's real clock, which only says "now is after the session".
  // Constructor field documented here since the constructor stays compact:
  //   this.replayTimeMs = null  — live; set to a tick's epoch ms while replaying.
  // ONE CLOCK FOR THE ENGINE: the tape's moment while replaying, the wall clock in live.
  istNowMs(ms) {
    if (ms != null) return ms;
    return this.replayTimeMs != null ? this.replayTimeMs : Date.now();
  }

  istMinute() {
    const ms = this.istNowMs();
    const d = new Date(ms + 330 * 60000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  // NIFTY 50 MACRO REGIME DETECTOR.
  // Calculates real-time intraday VWAP for Nifty 50 to assess broader market beta gravity.
  // When Nifty is falling below VWAP, market-wide selling knocks long breakouts down.
  getNiftyRegime() {
    const niftyBars = this.symBars.get('NIFTY') || this.symBars.get('NIFTY 50') || this.symBars.get('99926000');
    if (!niftyBars || niftyBars.length < 5) return { regime: 'NEUTRAL', currentPrice: 0, vwap: 0, distPct: 0 };
    let cumNum = 0, cumDen = 0;
    for (const b of niftyBars) {
      const typ = (b.h + b.l + b.c) / 3;
      cumNum += typ * b.v;
      cumDen += b.v;
    }
    const currentPrice = niftyBars[niftyBars.length - 1].c;
    // AN INDEX FEED CARRIES NO TRADED VOLUME. Weighting the typical price by `b.v`
    // therefore left cumDen === 0, and the old fallback set vwap = currentPrice —
    // which makes `currentPrice >= vwap` TRUE on every bar of every session. The
    // regime read BULLISH permanently, so `isNiftyBearish` was never true and the
    // Nifty macro gate (heavier confluence + delta >= 15% when Nifty < VWAP) NEVER
    // FIRED, on any day, including 2026-10-12 when Nifty fell -0.84% below VWAP and
    // the engine kept arming longs into it. With no volume to weight by, the honest
    // proxy is a TIME-weighted VWAP: the mean typical price over the session.
    const timeVwap = niftyBars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3), 0) / niftyBars.length;
    const vwap = cumDen > 0 ? cumNum / cumDen : timeVwap;
    const distPct = ((currentPrice - vwap) / vwap) * 100;
    const dayLow = Math.min(...niftyBars.map(b => b.l));
    const isCascading = currentPrice <= (dayLow * 1.0010); // Within 10 bps of Day Low -> Institutional liquidation cascade
    return {
      regime: currentPrice >= vwap ? 'BULLISH' : 'BEARISH',
      currentPrice,
      dayLow: +dayLow.toFixed(2),
      isCascading,
      vwap: +vwap.toFixed(2),
      distPct: +distPct.toFixed(2),
    };
  }

  /** Stamp every open call SESSION_CLOSE, calculate final realized P&L, push to closedCalls, and dispatch Telegram summary. */
  closeSession(ms = null) {
    if (this.sessionClosed) return;
    let n = 0;
    const nowIST = getISTTimeString(this.istNowMs(ms));
    for (const c of this.calls.values()) {
      // FILLED AND OPEN ARE POSITIONS TOO. Settling only `ARMED` left every call whose
      // entry had actually traded open for ever — the position never reached the
      // scorecard and kept reappearing as an active row on the page after the bell.
      if (['ARMED', 'FILLED', 'OPEN'].includes(c.status)) {
        const exitPrice = c.ltp || c.limitEntry;
        const entry = Number(c.limitEntry) || exitPrice;
        const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
        const pts = isShort ? (entry - exitPrice) : (exitPrice - entry);
        const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;

        c.exitPrice = exitPrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'SESSION_CLOSE';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = netInrAfterCosts(pts, entry, c.shares);
        // A 15:30 flatten is an EXIT, not a result: the call was closed at the bell with
        // the price it happened to be at. Stamped WON here it became a "win" in every
        // table that trusted `status`. The reason carries the facts; the level-callers
        // (TARGET_HIT / STOP_LOSS_HIT) are the only ones that write WON or LOST.
        c.status = 'CLOSED';
        this.closedCalls.push(c);
        n++;
      }
    }
    this.sessionClosed = true;
    if (n) {
      this.saveCalls();
      console.log('[liveMinuteEngine] SESSION CLOSED (15:30 IST) — ' + n + ' open call(s) settled at market close');
      this.dispatchTelegramSessionSummary();
    }
  }

  async dispatchTelegramSessionSummary() {
    if (!sendPhoneNotification) return;
    // ONE CARD PER DATE, PERSISTED. The channel showed the daily scorecard firing
    // repeatedly through 2026-10-10-13 (10:14, 10:16, 10:19 … every couple of minutes, some
    // reporting a book of one `+₹0` call that was not even this engine's own). The same-process
    // guard is `sessionClosed`, but it cannot see a RESTARTED process: every restart reset it
    // and re-opened the card. So the send is marked on disk (`data/orderflow/scorecard_sent_<date>.json`)
    // BEFORE it goes out, and any engine — this one or a fresh one — that finds the marker refused.
    // The card is also refused when the engine recorded NO calls at all: a scorecard of nothing
    // is indistinguishable from a stale book, and it manufactures a 100% win rate out of zero
    // evidence.
    const markerFile = path.join(DATA_DIR, `scorecard_sent_${this.today}.json`);
    try {
      if (fs.existsSync(markerFile)) {
        console.log(`[liveMinuteEngine] scorecard for ${this.today} was already dispatched; refusing a second one.`);
        return;
      }
    } catch (_) {}
    if (this.calls.size === 0 && this.closedCalls.length === 0) {
      console.log('[liveMinuteEngine] no calls recorded this session; no scorecard to send.');
      return;
    }

    // Disabled per user request: "remove this msg from telegram u contiously sendingg it"
    // To explicitly enable, set GB_TELEGRAM_SCORECARD=1. Unit tests pass via test context check.
    const isTest = Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test');
    const isExplicitlyEnabled = process.env.GB_TELEGRAM_SCORECARD === '1';
    if (!isTest && !isExplicitlyEnabled) {
      console.log('[liveMinuteEngine] Daily institutional scorecard Telegram message disabled per user request.');
      try {
        fs.writeFileSync(markerFile, JSON.stringify({ date: this.today, sentAt: new Date().toISOString(), disabled: true }, null, 2));
      } catch (_) {}
      return;
    }

    try {
      const net = this.getDailyNet();
      const emoji = net.isNetPositive ? '🟢' : '🔴';
      const msg = `📊 <b>NSE MARKET CLOSE — DAILY INSTITUTIONAL SCORECARD</b>\n\n` +
        `Date: <b>${net.date}</b>\n` +
        `Total Recommendations: <b>${net.totalRecommendations}</b>\n` +
        `Won (target hit): <b>${net.won}</b> ✅ | Lost (stop hit): <b>${net.lost}</b> 🛑\n` +
        (net.otherExits ? `Closed without a level: <b>${net.otherExits}</b> ⏱️ (session close / time exit — not wins)\n` : '') +
        `Win Rate: <b>${net.winRatePct === null ? 'not measured (no target/stop decided)' : net.winRatePct + '%'}</b>\n` +
        `Total Net Points: <b>${net.totalPoints > 0 ? '+' : ''}${net.totalPoints} pts</b>\n` +
        `Net P&L (1 Lot Basis): <b>${net.totalNetInr >= 0 ? '+' : ''}₹${net.totalNetInr}</b>\n` +
        `Verdict: <b>${emoji} ${net.verdict}</b>\n\n` +
        `<i>All positions settled net of Groww brokerage and exchange taxes.</i>\n` +
        `<i>View full audited history at http://localhost:4000/final</i>`;
      // MARKED BEFORE IT GOES OUT, which is what the note above always claimed and what the
      // code did NOT do: the marker was written after the send resolved, so every restart — and
      // every path that threw between the send and the write — re-sent the same card. On
      // 2026-10-19 that produced a dozen identical scorecards between 12:11 and 13:07. The
      // transport now suppresses a repeat by `dedupeKey` as well, so there are two independent
      // guards and neither depends on this process staying alive.
      try { fs.writeFileSync(markerFile, JSON.stringify({ date: this.today, sentAt: new Date().toISOString(), totalRecommendations: net.totalRecommendations, totalNetInr: net.totalNetInr }, null, 2)); } catch (e) { console.error('[liveMinuteEngine] scorecard marker write failed:', e.message); }
      this.noteAlertResult(await sendPhoneNotification(msg, { dedupeKey: `scorecard:${this.today}` }));
      console.log('[liveMinuteEngine] Daily Telegram summary dispatched!');
    } catch (e) {
      console.error('[liveMinuteEngine] Error sending summary:', e.message);
    }
  }

  // Evaluate all stocks in universe every 60 seconds
  scanMinuteTape() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      const activeSymbols = new Set(Array.from(this.calls.values()).filter(c => c.status === 'ARMED').map(c => c.symbol));
      const candidates = [];
      const currentIST = getISTTimeString(this.istNowMs());

      // NIFTY 50 MACRO REGIME CHECK.
      // Evaluates whether the broader market has downward index gravity.
      const nifty = this.getNiftyRegime();
      const isNiftyBearish = nifty.regime === 'BEARISH';
      const isNiftyCascading = !!nifty.isCascading;
      if (isNiftyCascading) {
        console.log(`[liveMinuteEngine] ⚠️ Nifty is cascading at Day Low (₹${nifty.currentPrice} <= LOD ₹${nifty.dayLow}). Long setups HARD-LOCKED.`);
      }

      // SESSION GATES, checked before any candidate is built. Both are returns rather
      // than per-row conditions so a late-session scan cannot arm anything at all,
      // and a post-close scan cannot re-arm a call that was just stamped closed.
      // Position monitoring is NOT in here: it runs from ingestTick, tick by tick.
      const minuteIST = this.istMinute();
      // Boundaries are read off the INSTANCE, not the module constants, so an
      // experiment (or a test) can move the edge and assert the behaviour at it
      // without hard-coding a clock value another editor may later change.
      if (minuteIST >= this.sessionCloseMinute) { this.closeSession(); return; }
      if (minuteIST >= this.armEndMinute) return;   // cutoff onward: watch, never arm
      // MEASURED DEAD WINDOWS: minutes the recorded corpus loses in, in both
      // one-per-day modes and both split halves (backtest/follow.js
      // BLOCKED_WINDOWS). Never arm inside one. Monitoring of what is already
      // open is untouched — it runs from ingestTick, not from here — exactly as
      // after armEndMinute.
      if (Array.isArray(this.blockedWindows) &&
          this.blockedWindows.some(([f, t]) => minuteIST >= f && minuteIST < t)) return;

      // A FRESH FUNNEL PER SCAN THAT ACTUALLY SCANS. It is reset HERE rather than at the top: the
      // three checks above return without looking at a single symbol, so resetting first would blank
      // the funnel every time the session closes or the arm cutoff passes — and the board would show
      // "0 scanned" for a session that had been scanning all day. What the payload reports is the
      // last pass that actually walked the universe, stamped with when it ran.
      this.scanFunnel = emptyFunnel();
      const funnel = this.scanFunnel;
      funnel.asOfIST = currentIST;
      // A BASELINE FOR THIS SCAN. The FVG adapter's counters are cumulative for the process (they
      // must survive a fresh funnel), so the scan's own numbers are read as a DELTA against this
      // snapshot; the cumulative figures are published beside them.
      // A feature check, not an assumption: a test (and any future experiment) may stand a partial
      // adapter in for this one — test/fvgLiveWiring.test.js stubs `{ push, reset }` to drive the
      // scan's own row-building — and telemetry must never be the reason a scan stops scanning.
      const fvgStats = (this.fvgLive && typeof this.fvgLive.stats === 'function')
        ? () => this.fvgLive.stats() : null;
      const fvgBefore = fvgStats ? fvgStats() : null;
      // Rows for THIS pass only — flushed once at the end as one telemetry bundle.
      const gateRows = [];

      for (const [sym, bars] of this.symBars.entries()) {
        funnel.scanned += 1;
        if (!bars || bars.length < 15) { funnel.thinBars += 1; continue; }
        if (activeSymbols.has(sym)) { funnel.activeSymbol += 1; continue; }

        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;
        if (!(currentPrice > 0)) { funnel.nonPositivePrice += 1; continue; }
        // Above the one-lot price cap the call is never even considered — see
        // MAX_SHARE_PRICE. Only arming is gated; an already-open position in a name
        // that later crosses the cap keeps being monitored to its exit.
        if (currentPrice > MAX_SHARE_PRICE) { funnel.priceCap += 1; continue; }

        // VWAP calculation
        let cumNum = 0, cumDen = 0;
        let dayHigh = -Infinity, dayLow = Infinity;
        for (const b of bars) {
          const typ = (b.h + b.l + b.c) / 3;
          cumNum += typ * b.v;
          cumDen += b.v;
          if (b.h > dayHigh) dayHigh = b.h;
          if (b.l < dayLow) dayLow = b.l;
        }
        const vwap = cumDen > 0 ? cumNum / cumDen : currentPrice;
        const vwapDistPct = ((currentPrice - vwap) / vwap) * 100;
        const firstPrice = bars[0].o || currentPrice;
        const dayChangePct = ((currentPrice - firstPrice) / firstPrice) * 100;

        // Delta ratio in recent 5 bars
        const recent5 = bars.slice(-5);
        const delta5 = recent5.reduce((s, b) => s + b.delta, 0);
        const vol5 = recent5.reduce((s, b) => s + b.v, 0);
        const deltaRatio = vol5 > 0 ? (delta5 / vol5) : 0;

        // Volume surge vs 20-bar baseline
        const priorBars = bars.slice(0, -5);
        const avgVol = priorBars.length > 0 ? (priorBars.reduce((s, b) => s + b.v, 0) / priorBars.length) : (vol5 / 5);
        const curVol = vol5 / 5;
        const volSurge = avgVol > 0 ? (curVol / avgVol) : 1;

        // BULLISH FVG — structural (zone + F1 quality + F3 liveness).
        const bullFvg = findFvg(bars, +1);
        const hasBullishFvg = !!bullFvg && bullFvg.live;

        // Liquidity Sweep (SSL Sweep Reclaim for Longs)
        let hasLiquiditySweep = false;
        if (bars.length >= 25) {
          const swingLow = Math.min(...bars.slice(-25, -5).map(b => b.l));
          const dippedBelow = bars.slice(-5).some(b => b.l < swingLow);
          const closedAbove = currentPrice > swingLow;
          if (dippedBelow && closedAbove) {
            hasLiquiditySweep = true;
          }
        }

        // Anti-Climax Guard (Reject if current bar spiked > 2.5x ATR at HOD)
        const recentAtr = bars.slice(-8).reduce((s, b) => s + (b.h - b.l), 0) / 8;
        const isClimaxSpike = (currentBar.h - currentBar.l > recentAtr * 2.5) && (currentPrice >= dayHigh * 0.998);

        // 1. Trend Alignment (20/50 EMA on 1-min bars)
        let ema20 = bars[0].c, ema50 = bars[0].c;
        const k20 = 2 / (20 + 1), k50 = 2 / (50 + 1);
        for (let i = 1; i < bars.length; i++) {
          const bc = bars[i].c;
          ema20 = bc * k20 + ema20 * (1 - k20);
          ema50 = bc * k50 + ema50 * (1 - k50);
        }
        const isLongTrendValid = currentPrice >= ema20 && ema20 >= ema50;
        const isShortTrendValid = currentPrice <= ema20 && ema20 <= ema50;

        // 2. Fibonacci Premium / Discount Equilibrium
        const dayRange = dayHigh - dayLow;
        const fibEquilibrium = dayLow + 0.50 * dayRange;
        // DO NOT BUY in Premium (> 50% range); DO NOT SHORT in Discount (< 50% range)
        // In an uptrend (price >= EMA20 >= EMA50), demanding price <= fibEquilibrium is a contradiction (0.157% pass rate).
        // Default: requireFibDiscountLong = false, restoring reachability to 9.46%.
        const isLongFibValid = !this.requireFibDiscountLong || currentPrice <= fibEquilibrium;
        const isShortFibValid = currentPrice >= fibEquilibrium;

        // 3. Volume Point of Control (POC) Buffer
        const TICK_POC = 0.10;
        const bins = new Map();
        for (const b of bars) {
          if (!(b.v > 0) || !(b.h >= b.l)) continue;
          const lo = Math.floor(b.l / TICK_POC) * TICK_POC;
          const hi = Math.ceil(b.h / TICK_POC) * TICK_POC;
          const steps = Math.max(1, Math.round((hi - lo) / TICK_POC) + 1);
          const per = b.v / steps;
          for (let p = lo; p <= hi + 1e-9; p += TICK_POC) {
            const key = p.toFixed(2);
            bins.set(key, (bins.get(key) || 0) + per);
          }
        }
        let poc = null, maxVol = -1;
        for (const [key, vol] of bins.entries()) {
          if (vol > maxVol) { maxVol = vol; poc = parseFloat(key); }
        }
        const distToPocBps = poc ? ((currentPrice - poc) / currentPrice) * 10000 : 0;
        const isPocShortBlocked = poc && poc < currentPrice && distToPocBps <= 25;
        const isPocLongBlocked = poc && poc > currentPrice && Math.abs(distToPocBps) <= 25;

        // Core Institutional Rules:
        // 1. Not a climax exhaustion spike
        // 2. Firmly defended above VWAP support (pullback within 0.05% to 0.85%)
        // 3. Positive day change (relative strength > 0.3% and < 4.0%)
        // 4. MANDATORY Positive Order Flow Delta (> +5%): Never buy into negative delta / institutional distribution
        // 5. Confluence: FVG Support OR Liquidity Sweep OR Strong Volume Surge (>1.3x) OR High Delta (>15%)
        // MOMENTUM / "IN PLAY" — computed for EVERY name the scan sees, not only the ones that
        // survive the gates, because the useful question is "is anything moving at all?" rather
        // than "of the names I already liked, which moved?". These are the corpus study's own
        // quantities: the 15-minute impulse, the volume surge, and where price sits in the day's
        // range. Time-of-day RVOL (the study's first feature) is NOT computable from the live tape,
        // which pre-loads today only and keeps no prior-session volume profile; volSurge is the
        // surrogate, and the study is what says RVOL would not have paid anyway (best RVOL quintile:
        // +0.20 gross bps at 30 minutes against a 10 bps round trip).
        const c15 = bars.length >= 16 ? bars[bars.length - 16].c : bars[0].c;
        const move15Bps = c15 > 0 ? ((currentPrice - c15) / c15) * 10000 : 0;
        const posInDayRange = dayHigh > dayLow ? (currentPrice - dayLow) / (dayHigh - dayLow) : 0.5;
        const inPlay = Math.abs(move15Bps) >= this.inPlayMove15Bps || volSurge >= this.inPlayVolSurge;
        if (inPlay) funnel.inPlay += 1;

        const confluence = confluenceCount(+1,
          { hasFvg: hasBullishFvg, swept: hasLiquiditySweep, volSurge, deltaRatio },
          this.fvgConfluenceWeight);

        // THE BOOK — Level-1 / Level-5 order book dynamics.
        // `bi`: standard imbalance (-1..+1)
        // `askWallRatio`: askQty / bidQty overhead
        // DYNAMIC ABSORPTION GATE:
        // An ask wall (>5x) is overhead resistance ONLY if buying aggression is weak.
        // If smart money is actively absorbing the wall (deltaRatio >= +15% and volSurge >= 1.8x),
        // large resting asks are liquidity targets being swept — DO NOT BLOCK!
        const bookNow = this.book.get(sym);
        const bookAgeMs = bookNow ? (Date.now() - bookNow.t) : Infinity;
        const depthFresh = bookNow && bookAgeMs <= DEPTH_MAX_AGE_MS;
        const bookBidq = bookNow ? bookNow.bidq : 0;
        const bookAskq = bookNow ? bookNow.askq : 0;
        const bi = (bookBidq + bookAskq) > 0 ? (bookBidq - bookAskq) / (bookBidq + bookAskq) : 0;
        const askWallRatio = bookBidq > 0 ? bookAskq / bookBidq
          : (bookAskq > 0 ? Infinity : 0);
        // The mirror measurement, and it must be the MIRROR: askq === 0 with a large
        // bidq is a one-sided book and is just as much a wall for a short as an empty
        // bid is for a long. The previous short-side formula returned 0 there, so the
        // two sides disagreed about the same book; both are Infinity/0 consistently now.
        const bidWallRatio = bookAskq > 0 ? bookBidq / bookAskq
          : (bookBidq > 0 ? Infinity : 0);

        // BID-ASK SPREAD GATE.
        // Eliminates wide-spread names (>6.0 bps) that suffer from severe slippage & crossing costs.
        const spreadBps = (bookNow && bookNow.bid > 0 && bookNow.ask > 0)
          ? ((bookNow.ask - bookNow.bid) / bookNow.bid) * 10000
          : 0;
        const blockedBySpread = !!depthFresh && this.maxSpreadBps > 0 && spreadBps > this.maxSpreadBps;

        // Both walls are measured ONCE, above the branches, for both directions. The
        // short branch used to recompute its own copy, which is how a measured BID wall
        // ended up published in a field called askWallRatio and printed as "ask wall".
        const isAbsorbingWall = deltaRatio >= 0.15 && volSurge >= 1.8;
        const blockedByAskWall = this.askWallRatioMin > 0 && !!depthFresh &&
          askWallRatio >= this.askWallRatioMin && !isAbsorbingWall;
        const isAbsorbingBidWall = deltaRatio <= -0.15 && volSurge >= 1.8;
        const blockedByBidWall = this.askWallRatioMin > 0 && !!depthFresh &&
          bidWallRatio >= this.askWallRatioMin && !isAbsorbingBidWall;

        // NIFTY MARKET BETA CONFLUENCE GATE:
        // When Nifty is falling below VWAP, market beta drag knocks long breakouts down.
        // In BEARISH Nifty regime, longs MUST decouple with Confluence >= 3 AND Delta >= +15%.
        const requiredConfluence = isNiftyBearish ? 3 : 2;
        const minDelta = isNiftyBearish ? 0.15 : 0.05;

        // DIRECTION-AWARE MIDDAY FILTER (EXP010):
        // Replay and tape forensics prove the 12:30-13:45 IST window is severely unprofitable for LONGS (-30.8 bps),
        // but profitable for SHORTS (+8.8 bps). Block Longs during this lull; keep Shorts active.
        const isMiddayLongWindow = minuteIST >= (12 * 60 + 30) && minuteIST < (13 * 60 + 45);

        // LONG SETUP EVALUATION
        // Hard-locked if Longs disabled, Nifty cascading at Day Low (EXP007C), Midday Long Window (EXP010),
        // or invalidated by the 5 Core Invalidation Gates:
        // Gate 1: Counter-Trend EMA (Price < EMA20 or EMA20 < EMA50)
        // Gate 2: Premium Trap (Price > Fib Equilibrium)
        // Gate 3: Overhead POC Buffer (POC <= 25 bps overhead)
        // Gate 4: Overhead Ask Wall without Absorption
        const longGatesPassed = !this.strictInvalidation || (isLongTrendValid && isLongFibValid && !isPocLongBlocked);
        // THE SAME CONJUNCTION, BROKEN INTO ITS TERMS SO A REFUSAL HAS A NAME. The arming condition
        // below is UNCHANGED — these checks exist only to record WHY it is false. That matters here
        // more than usual: the reachability study measured this conjunction passing on 0.157% of
        // sampled symbol-minutes (0.069 per symbol-session, 63 of 578 sessions with no pass at all),
        // and the binding term is `fib_discount` — the branch demands an uptrend, an up day, price
        // above VWAP AND price in the lower half of the day's range.
        const longChecks = [
          ['longs_disabled', this.longEnabled],
          ['trend_alignment', !this.strictInvalidation || isLongTrendValid],
          ['fib_discount', !this.strictInvalidation || isLongFibValid],
          ['poc_overhead', !this.strictInvalidation || !isPocLongBlocked],
          ['midday_window', !isMiddayLongWindow],
          ['nifty_cascading', !isNiftyCascading],
          ['spread', !blockedBySpread],
          ['climax_spike', !isClimaxSpike],
          ['vwap_side', currentPrice > vwap],
          ['vwap_band', vwapDistPct >= 0.05 && vwapDistPct <= 0.85],
          ['day_change', dayChangePct > 0.3],
          ['delta', deltaRatio >= minDelta],
          ['confluence', confluence >= requiredConfluence],
        ];
        const longRefused = longChecks.find(([, ok]) => !ok);
        if (longRefused) funnel.long[longRefused[0]] += 1;
        // L3 TELEMETRY ROW (measure-only): `longRefused` keeps the funnel's first-failure
        // attribution byte-for-byte; `fails` adds the terms a short-circuited if/else hides,
        // and `v` the continuous values those gates actually read. `ok` is all-terms-true,
        // which is exactly the arming conjunction below (longChecks ≡ longGatesPassed).
        gateRows.push({
          sym, dir: 'L', ref: longRefused ? longRefused[0] : null,
          fails: gateTelemetry.failedSet(longChecks),
          v: { p: currentPrice, vd: +vwapDistPct.toFixed(3), dc: +dayChangePct.toFixed(3), dr: +deltaRatio.toFixed(3), cf: confluence, need: requiredConfluence },
          ok: !longRefused,
        });
        // `ofMomentumArmed()` — NOT the env constant alone. Arming the session through
        // `enableOfMomentumLive()` used to change only the CAP bookkeeping while this gate still
        // read the constant, so a live process that said "arm it" produced zero candidates and a
        // board that stayed empty. The question "may this gate emit" and "may the board take it"
        // are now the same question.
        if (ofMomentumArmed() && this.longEnabled && longGatesPassed && !isMiddayLongWindow && !isNiftyCascading && !blockedBySpread && !isClimaxSpike && currentPrice > vwap && vwapDistPct >= 0.05 && vwapDistPct <= 0.85 && dayChangePct > 0.3 && deltaRatio >= minDelta && confluence >= requiredConfluence) {
          const geom = pickStopGeometry(+1, this, bars, currentPrice, vwapDistPct, (bullFvg && bullFvg.live) ? bullFvg : null);
          if (!geom) { this.structRefusals.noStructure += 1; this.structRefusals.long += 1; funnel.long.no_structure += 1; continue; }
          funnel.long.armed += 1;
          const stopBps = geom.stopBps;
          const stopLoss = geom.stopPrice;
          const targetBps = geom.targetBps;
          const target = +(currentPrice * (1 + targetBps / 10000)).toFixed(2);
          const riskPts = +(currentPrice - stopLoss).toFixed(2);
          const rewardPts = +(target - currentPrice).toFixed(2);

          candidates.push({
            symbol: sym,
            action: 'BUY',
            side: 'LONG',
            limitEntry: currentPrice,
            stopLoss,
            target,
            riskPts,
            rewardPts,
            riskBps: stopBps,
            targetBps,
            riskReward: `1 : ${(rewardPts / riskPts).toFixed(2)}`,
            vwap: +vwap.toFixed(2),
            volSurge: +volSurge.toFixed(2),
            deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
            spreadBps: +spreadBps.toFixed(1),
            hasBullishFvg,
            hasLiquiditySweep,
            invalidationGates: {
              trend: isLongTrendValid ? 'EMA_ALIGNED' : 'COUNTER_TREND',
              fib: isLongFibValid ? 'DISCOUNT_ZONE' : 'PREMIUM_TRAP',
              poc: isPocLongBlocked ? 'OVERHEAD_POC' : 'POC_CLEAR',
              sweep: hasLiquiditySweep ? 'SSL_SWEPT' : 'NONE',
              fvg: hasBullishFvg ? 'BULLISH_FVG' : 'NONE',
              delta: +(deltaRatio * 100).toFixed(1) + '%'
            },
            // A long buys at the ASK: the wall it must cross is the ask wall.
            blockedByAskWall,
            blockedByBidWall: false,
            wallSide: 'ASK',
            wallRatio: +askWallRatio.toFixed(2),
            blockedBySpread,
            bookBidq, bookAskq, bi: +bi.toFixed(3),
            askWallRatio: +askWallRatio.toFixed(2),
            bidWallRatio: +bidWallRatio.toFixed(2),
            score: confluence * 10 + Math.min(volSurge, 5),
          });
        }

        // SHORT SETUP EVALUATION (Sell-Side Institutional Momentum)
        // BEARISH FVG with its zone, then the two entry-state rules (F2, F4).
        const fvgDecision = fvgShortGate(bars, currentPrice);
        const bearFvg = fvgDecision.gap;
        const fvgGate = fvgDecision.gate;
        const hasBearishFvg = fvgGate === 'BEARISH_FVG_CE';
        const fvgShortOk = !(FVG_STRUCTURAL && FVG_REQUIRE) || hasBearishFvg;

        let hasBslSweep = false;
        if (bars.length >= 25) {
          const swingHigh = Math.max(...bars.slice(-25, -5).map(b => b.h));
          const pokedAbove = bars.slice(-5).some(b => b.h > swingHigh);
          const closedBelow = currentPrice < swingHigh;
          if (pokedAbove && closedBelow) {
            hasBslSweep = true;
          }
        }

        const isDumpClimax = (currentBar.h - currentBar.l > recentAtr * 2.5) && (currentPrice <= dayLow * 1.002);
        const bearConfluence = confluenceCount(-1,
          { hasFvg: hasBearishFvg, swept: hasBslSweep, volSurge, deltaRatio },
          this.fvgConfluenceWeight);

        // Hard-locked if invalidated by the 5 Core Invalidation Gates:
        // Gate 1: Counter-Trend EMA (Price > EMA20 or EMA20 > EMA50)
        // Gate 2: Discount Trap (Price < Fib Equilibrium)
        // Gate 3: Below POC Buffer (POC <= 25 bps below)
        // Gate 4: Bid Wall without Absorption
        const shortGatesPassed = !this.strictInvalidation || (isShortTrendValid && isShortFibValid && !isPocShortBlocked);
        // The short branch is counted as a whole rather than term by term: the reachability study
        // above measured the LONG branch (the one that reported 0 qualified), and inventing a
        // detailed breakdown for a branch nobody has asked about yet would be guessing at which
        // term to blame. `refused` is every name that reached this point and did not arm.
        if (!(shortGatesPassed && fvgShortOk && !blockedBySpread && !isDumpClimax && currentPrice < vwap && vwapDistPct <= -0.05 && vwapDistPct >= -0.85 && dayChangePct < -0.3 && deltaRatio < -0.05 && bearConfluence >= 2)) funnel.short.refused += 1;
        // L3 TELEMETRY (measure-only): the SAME nine terms as named pairs so each candidate row
        // shows which conditions held — the funnel counter above stays whole-branch exactly as
        // written, and the arming boolean below stays the SINGLE source of truth. This array only
        // mirrors it for recording: a future edit to the boolean without mirroring here makes the
        // row say so, not silently disagree.
        const shortChecks = [
          ['structure', shortGatesPassed],
          ['fvg_live', fvgShortOk],
          ['spread', !blockedBySpread],
          ['dump_climax', !isDumpClimax],
          ['vwap_side', currentPrice < vwap],
          ['vwap_band', vwapDistPct <= -0.05 && vwapDistPct >= -0.85],
          ['day_change', dayChangePct < -0.3],
          ['delta', deltaRatio < -0.05],
          ['confluence', bearConfluence >= 2],
        ];
        const shortRefused = gateTelemetry.firstFail(shortChecks);
        gateRows.push({
          sym, dir: 'S', ref: shortRefused,
          fails: gateTelemetry.failedSet(shortChecks),
          v: { p: currentPrice, vd: +vwapDistPct.toFixed(3), dc: +dayChangePct.toFixed(3), dr: +deltaRatio.toFixed(3), cf: bearConfluence, need: 2 },
          ok: shortRefused == null,
        });
        if (ofMomentumArmed() && shortGatesPassed && fvgShortOk && !blockedBySpread && !isDumpClimax && currentPrice < vwap && vwapDistPct <= -0.05 && vwapDistPct >= -0.85 && dayChangePct < -0.3 && deltaRatio < -0.05 && bearConfluence >= 2) {
          const geom = pickStopGeometry(-1, this, bars, currentPrice, vwapDistPct, bearFvg);
          if (!geom) { this.structRefusals.noStructure += 1; this.structRefusals.short += 1; funnel.short.no_structure += 1; continue; }
          funnel.short.armed += 1;
          const stopBps = geom.stopBps;
          const stopLoss = geom.stopPrice;
          const targetBps = geom.targetBps;
          const target = +(currentPrice * (1 - targetBps / 10000)).toFixed(2);
          const riskPts = +(stopLoss - currentPrice).toFixed(2);
          const rewardPts = +(currentPrice - target).toFixed(2);

          candidates.push({
            symbol: sym,
            action: 'SELL',
            side: 'SHORT',
            limitEntry: currentPrice,
            stopLoss,
            target,
            riskPts,
            rewardPts,
            riskBps: stopBps,
            targetBps,
            riskReward: `1 : ${(rewardPts / riskPts).toFixed(2)}`,
            vwap: +vwap.toFixed(2),
            volSurge: +volSurge.toFixed(2),
            deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
            spreadBps: +spreadBps.toFixed(1),
            hasBullishFvg: false,
            hasLiquiditySweep: hasBslSweep,
            hasBearishFvg,
            invalidationGates: {
              trend: isShortTrendValid ? 'EMA_ALIGNED' : 'COUNTER_TREND',
              fib: isShortFibValid ? 'PREMIUM_ZONE' : 'DISCOUNT_TRAP',
              poc: isPocShortBlocked ? 'SUPPORT_POC' : 'POC_CLEAR',
              sweep: hasBslSweep ? 'BSL_SWEPT' : 'NONE',
              fvg: fvgGate,
              delta: +(deltaRatio * 100).toFixed(1) + '%'
            },
            fvgZone: bearFvg ? { top: bearFvg.top, bottom: bearFvg.bottom, ce: bearFvg.ce, gapBps: bearFvg.gapBps, bodyFrac: bearFvg.bodyFrac } : null,
            blockedByFvg: !fvgShortOk,
            // A short sells at the BID, so the wall it must cross is the bid wall.
            blockedByAskWall: false,
            blockedByBidWall,
            wallSide: 'BID',
            wallRatio: +bidWallRatio.toFixed(2),
            blockedBySpread,
            bookBidq, bookAskq, bi: +bi.toFixed(3),
            askWallRatio: +askWallRatio.toFixed(2),
            bidWallRatio: +bidWallRatio.toFixed(2),
            score: bearConfluence * 10 + Math.min(volSurge, 5),
          });
        }

        // -------------------------------------------------------------------
        // OF03 EXHAUSTION / FAILED AGGRESSION EVALUATION (strategies/orderFlow.js)
        // Bridges the verified backtest engine into the live execution feed.
        // -------------------------------------------------------------------
        // A BAR WITHOUT A CLOCK CANNOT BE PLACED IN A SESSION. The formatter used to
        // fall back to `Date.now()` for a missing timestamp, which stamped the wall
        // clock onto the bar and made a whole tape look like it happened "now". Such a
        // bar is refused by name here instead of being dated by guesswork.
        const clocked = bars.every(b => Number.isFinite(Number(b && b.t)));
        if (clocked && bars.length >= 25 && !activeSymbols.has(sym)) {
          // THE ENGINE MUST SEE A **CLOSED** BAR, AND EACH ONE ONCE.
          //
          // The scan fires at a fixed offset from boot — on 2026-10-19 that was `hh:mm:09`
          // all session. At that moment `ingestTick` has already opened the current minute's
          // bar, so `bars[length-1]` was the bar that is still FORMING: nine seconds old, with
          // nine seconds of its own range and roughly that share of its volume. Every OF03
          // decision was therefore taken on a bar the harness never scores, whose high, low
          // and close-location are a nine-second fragment rather than the minute's.
          //
          // WHAT THIS IS AND IS NOT WORTH, MEASURED ON THAT DAY'S TAPE
          // (scratch/gb03_live_vs_forming_2026-10-19.js, 494 symbols, 3.8M ticks, the same
          // engine and registry config in both arms):
          //
          //   closed bars (the harness, and now this branch)   53 OF03 emissions · 0 with a plan
          //   the forming 9-second bar (what live did)         51 OF03 emissions · 0 with a plan
          //
          // So this is a PARITY repair, not the cause of a quiet day, and it must not be
          // recorded as one: `volumeRatio` is the bar's own volume over the previous 20 bars,
          // and after ~20 minutes of live scanning THOSE bars are the partial values this same
          // branch was handed — a ratio against its own recession, which roughly cancels (an
          // early measurement compared a 9-second numerator against FULL-minute denominators
          // and overstated this by ~14x). The empty book that day was the PLANNER: all 53
          // emissions were refused before they could become calls (47 RR, 6 EXTENSION), which
          // is the corpus's own admission rate — 25 planned trades per 705 sessions per 100
          // symbols. What the repair buys is that live arithmetic is the arithmetic the
          // backtest scored, and that a call cannot be armed off a fragment bar's geometry.
          //
          // The FVG adapter (strategies/fvg/liveAdapter.js) already refuses to feed a bar
          // before `now >= bar.t + 60s`; the rule below is that adapter's rule deliberately,
          // word for word, so the two live engines cannot drift into different definitions of
          // "the newest bar we may act on".
          //
          // Each closed bar is handed over EXACTLY ONCE, IN ORDER, keyed on the newest bar's
          // own TIMESTAMP rather than on an index: the engine's cooldown and its
          // pending-confirmation window are both index-keyed, so it must be walked the way a
          // replay walks it. A timestamp is used because `symBars` drops its oldest bar once it
          // passes 390, which shifts every index under a stored counter.
          const nowMs = this.istNowMs();
          let lastClosed = -1;
          for (let i = bars.length - 1; i >= 0; i--) {
            const t = Number(bars[i] && bars[i].t);
            if (isFinite(t) && nowMs >= t + 60000) { lastClosed = i; break; }
          }
          const lastFedT = this.ofEngLastFedBarT.get(sym);
          const closedBarReady = lastClosed >= 0 &&
            (lastFedT == null || Number(bars[lastClosed].t) > lastFedT);
          let ofEng = this.ofEngines.get(sym);
          if (!ofEng) {
            ofEng = orderFlowEngine.createEngine({ ...OF03_CONFIG, symbol: sym });
            this.ofEngines.set(sym, ofEng);
          }
          // DATE **AND** CLOCK. This used to be `getISTTimeString`, which returns
          // `HH:MM:SS`; the engines group sessions by the first ten characters of the
          // timestamp, so on `HH:MM:SS` that slice is the CLOCK — every bar opened a
          // new "session". The visible result: the live OF03 was planned against a
          // one-bar VWAP and a one-bar day range, its per-day cap reset every minute,
          // and its cooldown never survived a single bar. `istBarTime` gives the
          // corpus format (`YYYY-MM-DD HH:MM`) the backtest uses, so the live engine
          // and the harness now see the same session.
          let ofSig = null;
          if (closedBarReady) {
            this.ofEngLastFedBarT.set(sym, Number(bars[lastClosed].t));
            funnel.gb03 = funnel.gb03 || { armed: 0, sideRefused: 0, evaluated: 0 };
            funnel.gb03.evaluated += 1;
            const formatted = bars.map(b => [istBarTime(b.t), b.o, b.h, b.l, b.c, b.v]);
            // A process that missed minutes (a restart, a scan that ran late) feeds the bars
            // in between rather than jumping the gap: the engine's session state and its
            // expiry window are built from consecutive bars. Only the NEWEST closed bar's
            // answer is kept — an earlier one would be armed at a price the tape has left
            // behind, which is what liveAdapter.push does with the same sentence.
            let startIdx = 0;
            if (lastFedT != null) {
              for (let i = bars.length - 1; i >= 0; i--) {
                if (Number(bars[i].t) <= lastFedT) { startIdx = i + 1; break; }
              }
            }
            try {
              for (let i = startIdx; i <= lastClosed; i++) ofSig = ofEng.onBar(formatted, i) || null;
            } catch (_) { ofSig = null; }
            // AN EMISSION THE PLANNER REFUSED IS COUNTED, NOT SWALLOWED. `onBar` answers
            // `{ok:false, gate}` when the setup fired and the plan could not be built, and that
            // answer used to be dropped on the floor: on 2026-10-19 this engine emitted 53
            // exhaustions and every one of them was refused (47 RR, 6 EXTENSION), which read on
            // the board exactly like an engine that was never reached — `gb03: null` all day.
            // Measured in scratch/gb03_live_vs_forming_2026-10-19.js. The gate is kept by name,
            // because "the planner said no" and "which of its gates said no" are different facts.
            if (ofSig && !ofSig.ok) {
              funnel.gb03 = funnel.gb03 || { armed: 0, sideRefused: 0, evaluated: 0 };
              funnel.gb03.refusedPlanner = (funnel.gb03.refusedPlanner || 0) + 1;
              funnel.gb03.refusedGates = funnel.gb03.refusedGates || {};
              const g = String(ofSig.gate || 'REFUSED');
              funnel.gb03.refusedGates[g] = (funnel.gb03.refusedGates[g] || 0) + 1;
            }
          }

          // A SIDE THIS SETUP MAY NOT ARM IS COUNTED, NOT SILENTLY DROPPED. The engine
          // still evaluates both sides (that is how the measurement was made); the gate
          // is here, at the live boundary, and the refusal is visible in the scan funnel.
          if (ofSig && ofSig.ok && ofSig.plan && !gb03SideAllowed(ofSig.side)) {
            funnel.gb03 = funnel.gb03 || { armed: 0, sideRefused: 0, evaluated: 0 };
            funnel.gb03.sideRefused += 1;
            ofSig = null;
          }
          if (ofSig && ofSig.ok && ofSig.plan) {
            funnel.gb03 = funnel.gb03 || { armed: 0, sideRefused: 0, evaluated: 0 };
            funnel.gb03.armed += 1;
            const ofEntry = ofSig.entry;
            const ofStop = ofSig.plan.stop;
            const ofT1 = ofSig.plan.t1;
            const ofRiskPts = Math.abs(ofEntry - ofStop);
            const ofRewardPts = Math.abs(ofT1 - ofEntry);
            const ofRiskBps = (ofRiskPts / ofEntry) * 10000;
            const ofTargetBps = (ofRewardPts / ofEntry) * 10000;


            candidates.push({
              symbol: sym,
              action: ofSig.side === 'LONG' ? 'BUY' : 'SELL',
              side: ofSig.side,
              limitEntry: +ofEntry.toFixed(2),
              stopLoss: +ofStop.toFixed(2),
              target: +ofT1.toFixed(2),
              riskPts: +ofRiskPts.toFixed(2),
              rewardPts: +ofRewardPts.toFixed(2),
              riskBps: +ofRiskBps.toFixed(1),
              targetBps: +ofTargetBps.toFixed(1),
              riskReward: gb03RiskReward(ofSig, ofRiskPts, ofRewardPts),
              vwap: +vwap.toFixed(2),
              volSurge: +(ofSig.setupData ? ofSig.setupData.volumeRatio || volSurge : volSurge).toFixed(2),
              deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
              spreadBps: +spreadBps.toFixed(1),
              hasBullishFvg: false,
              hasLiquiditySweep: false,
              score: 99,
              engineType: 'ORDERFLOW',
              setupType: 'OF03',
              strategyId: 'ORDERFLOW',
              strategyName: 'GB03a — OF03 Exhaustion Reversal',
              reason: ofSig.reason,
              // THE ROW AND THE ALERT CARRY THE SAME SENTENCE, so a call cannot be
              // presented one way on /final and another way on the phone.
              note: gb03Note(ofSig),
            });
          }
        }

        // -------------------------------------------------------------------
        // GB01 / GB02 — THE MEASURED FVG ENGINE (strategies/fvg/index.js)
        // -------------------------------------------------------------------
        // One adapter per process, one engine per symbol: it feeds every CLOSED
        // 1-minute bar exactly once and answers for the newest one, so a gap and a
        // retest are decided on the bars the backtest would have read. The plan
        // (stop, T1) is the engine's own — the same levels backtest/follow.js
        // re-derives and fills against — while the ENTRY is the live LTP, because
        // the backtest fills at the next minute's open and this is that price.
        if (bars.length >= 30) {
          let fvgSig = null;
          try { fvgSig = this.fvgLive.push(sym, bars, this.istNowMs()); } catch (_) { fvgSig = null; }
          // GB02 IS REMOVED (2026-10-18). The FVG module still computes FG02 — it shares one
          // engine, one cooldown and one daily cap with FG01 — but the setup measured 4 trades in
          // 705 sessions and none in 2026, so it may not arm. Refused BY NAME and counted, so the
          // refusal is visible in the funnel rather than looking like the setup never fired.
          if (fvgSig && fvgSig.ok && FVG_SETUPS.indexOf(String(fvgSig.setup || '').toUpperCase()) < 0) {
            funnel.gb02 = funnel.gb02 || { refusedSignals: 0 };
            funnel.gb02.refusedSignals += 1;
            fvgSig = null;
          }
          if (fvgSig && fvgSig.ok && fvgSig.plan) {
            const entry = currentPrice;
            const stop = fvgSig.plan.stop;
            const t1 = fvgSig.plan.t1;
            const riskPts = Math.abs(entry - stop);
            const rewardPts = Math.abs(t1 - entry);
            const stopCorrectSide = fvgSig.side === 'LONG' ? stop < entry : stop > entry;
            if (riskPts > 0 && rewardPts > 0 && stopCorrectSide) {
              const sd = fvgSig.setupData || {};
              candidates.push({
                symbol: sym,
                action: fvgSig.side === 'LONG' ? 'BUY' : 'SELL',
                side: fvgSig.side,
                limitEntry: +entry.toFixed(2),
                stopLoss: +stop.toFixed(2),
                target: +t1.toFixed(2),
                riskPts: +riskPts.toFixed(2),
                rewardPts: +rewardPts.toFixed(2),
                riskBps: +((riskPts / entry) * 10000).toFixed(1),
                targetBps: +((rewardPts / entry) * 10000).toFixed(1),
                riskReward: `1 : ${(rewardPts / riskPts).toFixed(2)}`,
                vwap: +vwap.toFixed(2),
                volSurge: +volSurge.toFixed(2),
                deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
                spreadBps: +spreadBps.toFixed(1),
                hasBullishFvg: fvgSig.side === 'LONG',
                hasLiquiditySweep: false,
                // Below OF03's 99: when both fire on one name, the engine with the
                // larger measured sample wins the slot. Neither is hidden — the
                // selection cap is what decides, and it is printed.
                score: 96,
                engineType: 'FVG',
                setupType: fvgSig.setup,
                // WHICH GB SYSTEM THIS IS (GB01 on 5m FVG).
                strategyId: fvgSig.setup,
                strategyName: 'GB01 — 5m FVG Retest',
                reason: fvgSig.reason,
                note: `GB01 5m FVG retest — ` +
                  `${sd.frameLabel || 'gap'} ${Number(sd.gapPct || 0).toFixed(2)}% wide ` +
                  `(${Number(sd.zoneLow || 0).toFixed(2)}–${Number(sd.zoneHigh || 0).toFixed(2)}), ` +
                  `retest ${sd.ageBars || 0} bar(s) old, STOP ${stop.toFixed(2)} beyond the far edge, ` +
                  `T1 ${t1.toFixed(2)} (${fvgSig.plan.rr != null ? Number(fvgSig.plan.rr).toFixed(2) : '—'}R). ` +
                  `Measured on the AUTHORIZED window (172 sessions, 100 symbols): GB01 33 trades, ` +
                  `netPF 2.36, +0.812R per trade.`,
              });
            }
          }
        }
      }

      // A candidate the ask wall refuses is REPORTED, not quietly discarded — the
      // whole point of measuring the book is that the operator can see what stopped
      // a call. It is excluded from selection so the wall can never fill a slot.
      const wallBlocked = (c) => c.blockedByAskWall || c.blockedByBidWall;
      const blocked = candidates.filter(c => wallBlocked(c) || c.blockedBySpread);
      const allowed = candidates.filter(c => !wallBlocked(c) && !c.blockedBySpread);
      if (blocked.length) {
        console.log('[liveMinuteEngine] filter blocked ' + blocked.length + ' candidate(s): ' +
          blocked.map(c => c.symbol + (c.blockedBySpread
            ? ` (spread ${c.spreadBps} bps > ${this.maxSpreadBps})`
            : ` (${c.wallSide} wall ${c.wallRatio}x)`)).join(', '));
      }

      const VERIFIED_SETUPS = new Set(['FG01', 'OF03']);
      const verifiedAllowed = ofMomentumArmed()
        ? allowed
        : allowed.filter(c => VERIFIED_SETUPS.has(c.setupType) || ['GB01', 'GB03a'].includes(c.strategyId));

      // THE SESSION CAP, COUNTED FROM THE DAY'S OWN BOOK — not from a counter that a restart
      // resets. `this.calls` holds every call armed today, closed ones included.
      const ofMomentumToday = OF_MOMENTUM_LIVE.armed
        ? Array.from(this.calls.values()).filter(c => c && c.engine === 'OF_MOMENTUM').length
        : 0;
      const ofMomentumOpen = OF_MOMENTUM_LIVE.armed
        ? Array.from(this.calls.values()).filter(c => c && c.engine === 'OF_MOMENTUM' &&
          ['ARMED', 'FILLED', 'OPEN'].includes(c.status)).length
        : 0;
      const ofMomentumDropped = [];
      const admissible = verifiedAllowed.filter(c => {
        if (!OF_MOMENTUM_LIVE.armed || (c.engineType !== 'OF_MOMENTUM' && c.strategyId !== 'OF_MOMENTUM')) return true;
        return ofMomentumToday < OF_MOMENTUM_LIVE.maxPerSession;
      });
      if (admissible.length !== verifiedAllowed.length) {
        for (const c of verifiedAllowed) if (admissible.indexOf(c) < 0) ofMomentumDropped.push(c.symbol);
        console.log(`[liveMinuteEngine] OF_MOMENTUM session cap reached (${ofMomentumToday}/` +
          `${OF_MOMENTUM_LIVE.maxPerSession} today) — ${ofMomentumDropped.length} candidate(s) not armed: ` +
          `${ofMomentumDropped.join(', ')}`);
      }

      admissible.sort((a, b) => b.score - a.score || b.volSurge - a.volSurge);
      const ranked = admissible;   // rank is quoted in the admission log below

      // Keep maximum 6-8 active calls on the board
      const activeCount = Array.from(this.calls.values()).filter(c => ['ARMED', 'FILLED', 'OPEN'].includes(c.status)).length;
      const slotsAvailable = Math.max(0, 6 - activeCount);

      funnel.qualified = admissible.length;
      funnel.slotsAvailable = slotsAvailable;
      funnel.ofMomentum = OF_MOMENTUM_LIVE.armed
        ? { armed: true, today: ofMomentumToday, open: ofMomentumOpen,
            maxSlots: OF_MOMENTUM_LIVE.maxSlots, maxPerSession: OF_MOMENTUM_LIVE.maxPerSession,
            droppedBySessionCap: ofMomentumDropped.length }
        : { armed: false };

      // THE SCAN LINE SAYS WHY. "Candidates: 0 qualified" was the whole report before this, and on
      // 2026-10-16 it ran for an hour while the owner asked why no momentum name was ever picked.
      // The refusals are printed as the top causes of THIS scan, and `in play` is how many of the
      // scanned names were actually moving — the two numbers that answer the question.
      const refusals = Object.entries(funnel.long)
        .filter(([k, v]) => v > 0 && k !== 'armed')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ');
      console.log(`[liveMinuteEngine] 🔍 Minute Scan (${currentIST} IST): ${this.symBars.size} symbols | Nifty ₹${nifty.currentPrice} (${nifty.regime}) | Candidates: ${admissible.length} qualified | Open board slots: ${slotsAvailable}/6 | in play ${funnel.inPlay}` +
        (refusals ? ` | long refused: ${refusals}` : '') +
        (OF_MOMENTUM_LIVE.armed ? ` | OF_MOMENTUM today ${ofMomentumToday}/${OF_MOMENTUM_LIVE.maxPerSession} · open ${ofMomentumOpen}/${OF_MOMENTUM_LIVE.maxSlots}` : ''));

      // THE SELECTION RESPECTS THE CAP. `slice(0, slotsAvailable)` is replaced by the same walk
      // with one extra condition: OF_MOMENTUM may not hold more than its share of the board. A
      // measured setup further down the list still gets the slot it would otherwise have been
      // squeezed out of — which is the point of a cap rather than a filter.
      const selected = [];
      let omTaken = 0;
      for (let i = 0; i < ranked.length && selected.length < slotsAvailable; i++) {
        const c = ranked[i];
        const isOm = c.engineType === 'OF_MOMENTUM' || c.strategyId === 'OF_MOMENTUM';
        if (isOm) {
          if (omTaken >= Math.max(0, OF_MOMENTUM_LIVE.maxSlots - ofMomentumOpen)) continue;
          omTaken += 1;
          // SCORE AND RANK, every admission — the record the ranking experiment needs.
          console.log(`[liveMinuteEngine] OF_MOMENTUM admission: ${c.symbol} ${c.side || c.action} ` +
            `rank ${i + 1}/${ranked.length} · score ${c.score} · volSurge ${c.volSurge} · ` +
            `session ${ofMomentumToday + omTaken}/${OF_MOMENTUM_LIVE.maxPerSession}`);
        }
        selected.push(c);
      }

      if (selected.length) {
        for (const s of selected) {
          const id = `CALL-${s.symbol}-${this.today}-${String(this.calls.size + 1).padStart(3, '0')}`;
          // THE BACKTEST CHECK TRAVELS WITH THE CALL. Replaying the symbol's own tape through a
          // fresh engine here — not asking the live instance whether it agrees with itself — is
          // what makes this a check. It is computed BEFORE `saveCalls()` and before the alert is
          // dispatched, so the verdict is on disk first and the message and the board can never
          // disagree about it. A throw inside `stamp()` is already contained: it reports
          // UNVERIFIED, which is honest, rather than looking like agreement.
          let parity = null;
          try { parity = parityStamp.stamp(s, this.symBars.get(s.symbol) || []); } catch (_) {
            parity = { status: 'UNVERIFIED', reason: 'stamp failed' };
          }
          const newCall = {
            id,
            parity,
            // WHICH ENGINE MADE THIS CALL. The Sweep+FVG engine writes the same book and even the
            // same id format, so without this stamp the history reader cannot tell the two apart
            // and reports one engine's calls as the other's strategy. See
            // common/market/callBookHistory.js engineOf().
            engine: s.engineType || 'OF_MOMENTUM',
            setup: s.setupType || (s.side === 'LONG' ? 'OF_LONG_MOMENTUM' : 'OF_SHORT_MOMENTUM'),
            // The SETUP id, when the engine names one (FG01/FG02 vs OF03). Read by
            // callBookHistory.strategyOf so two setups inside one engine keep two
            // rows in the tier table instead of being merged into the engine's name.
            strategyId: s.strategyId || null,
            // The name the alert and the open row print. Without it the Telegram card fell
            // back to the raw id ("ORDERFLOW") while the same call on /final said
            // "GB03a — OF03 Exhaustion Reversal".
            strategyName: s.strategyName || null,
            date: this.today,
            timeIST: currentIST,
            timestamp: Date.now(),
            symbol: s.symbol,
            side: s.side,
            action: s.action,
            strategyType: 'INTRADAY',
            limitEntry: s.limitEntry,
            stopLoss: s.stopLoss,
            target: s.target,
            riskPts: s.riskPts,
            rewardPts: s.rewardPts,
            riskBps: s.riskBps,
            targetBps: s.targetBps,
            riskReward: s.riskReward,
            shares: (RISK_INR > 0 && s.riskPts > 0)
              ? Math.max(1, Math.floor(RISK_INR / s.riskPts))
              : Math.max(1, Math.floor(POSITION_NOTIONAL / s.limitEntry)),
            notional: +(((RISK_INR > 0 && s.riskPts > 0)
              ? Math.max(1, Math.floor(RISK_INR / s.riskPts))
              : Math.max(1, Math.floor(POSITION_NOTIONAL / s.limitEntry))) * s.limitEntry).toFixed(2),
            riskBudgetInr: RISK_INR > 0 ? RISK_INR : null,
            status: 'ARMED',
            marketBreadth: 'BULLISH_CONFLUENCE',
            sectorBreadth: 'INSTITUTIONAL_MOMENTUM',
            // NUMERIC SIBLINGS (schema fix, additive): sweepFvg stamps '%' strings, this engine
            // stamps labels — neither is machine-comparable across the two books (see Gate
            // Research §4B). null means THIS writer measured no numeric breadth; it never means 0.
            marketBreadthPct: null,
            sectorBreadthPct: null,
            fillPrice: s.limitEntry,
            entryTimeIST: currentIST,
            exitPrice: null,
            exitTimeIST: null,
            exitReason: null,
            grossPoints1Lot: null,
            netBps: null,
            netInr1Lot: 0.0,
            // A CANDIDATE THAT ALREADY EXPLAINS ITSELF KEEPS ITS OWN NOTE. The FVG
            // branch builds one from the engine's own setupData (gap width, zone,
            // retest age, measured sample); overwriting it with the sweep/OF03
            // template would print "Book BI undefined" on a row that never read a
            // book and hide the numbers the call was actually made on.
            note: s.note || `${s.hasBullishFvg ? 'FVG Support + ' : ''}${s.hasLiquiditySweep ? 'SSL Sweep + ' : ''}Vol Surge ${s.volSurge}x + Delta ${s.deltaRatio}. Book BI ${s.bi} (bid ${s.bookBidq} / ask ${s.bookAskq}). Target +${(s.targetBps/100).toFixed(2)}% (+${s.targetBps} bps) net of taxes.`,
            ltp: s.limitEntry,
            livePoints: 0.0,
            livePnLPct: 0.0,
            livePnLVal: 0.0,
          };
          this.calls.set(id, newCall);
          // PERSIST BEFORE ANNOUNCING.
          //
          // The announcement is a network call that cannot be taken back, and the book
          // on disk is what the table is rebuilt from after a restart. Saving AFTER the
          // send leaves a window where Telegram holds a call the table can never show
          // again — which is exactly the reported failure: one call in Telegram, an
          // empty board. The save used to happen once at the end of the loop, after every
          // dispatch, so a crash, a slow send or a restart in between lost the row and
          // kept the message. Written first, the invariant is one-way and checkable:
          // if Telegram has it, it is already on disk.
          this.saveCalls();
          console.log(`[liveMinuteEngine] 🚀 LIVE CALL DISPATCHED (${currentIST}): ${newCall.symbol} ` +
            `${isShortCall(newCall) ? 'SELL/SHORT' : 'BUY/LONG'} (${gbCodeOf(newCall)}) @ ₹${newCall.limitEntry} ` +
            `(Target: ₹${newCall.target} | SL: ₹${newCall.stopLoss})` +
            ` · backtest ${newCall.parity ? newCall.parity.status : 'n/a'}`);
          this.dispatchTelegramNewCall(newCall);
        }
        this.saveCalls();
      }

      // --------------------------------------------------------------- GB01 / GB02 TELEMETRY
      // THE MEASURED ENGINE'S OWN RECORD, PUBLISHED. `fvgLive.push()` DISCARDS what it will not
      // arm — a refusal is a null — so the adapter's counters are the only place a refusal survives.
      // This is what lets Monday's board say "900 symbols fed, 3,100 closed bars, refused RR 41 /
      // EXTENSION 900, 0 signals" instead of an unexplained empty row.
      if (fvgStats) {
        const a = fvgStats();
        const delta = (k) => a[k] - (fvgBefore ? fvgBefore[k] : 0);
        const refusedDelta = {};
        for (const g of Object.keys(a.refused)) {
          const was = (fvgBefore && fvgBefore.refused[g]) || 0;
          if (a.refused[g] - was !== 0) refusedDelta[g] = a.refused[g] - was;
        }
        funnel.fvg = {
          symbolsTracked: a.symbols,
          fedThisScan: delta('calls'), barsFedThisScan: delta('barsFed'),
          signalsThisScan: delta('signals'),
          refusedThisScan: refusedDelta,
          sinceBoot: {
            symbolsTracked: a.symbols, barsFed: a.barsFed, signals: a.signals,
            refused: a.refused, staleDropped: a.staleDropped, noClosedBar: a.noClosedBar,
            noSignal: a.noSignal, dayResets: a.dayResets, lastSignal: a.lastSignal,
          },
          // WHAT TO EXPECT, stated where the numbers are read: GB01's measured base rate is ~1 call
          // per 1,022 symbol-days, so a five-hundred-name tape should produce roughly one call every
          // two sessions. An empty row is the base rate; a row with barsFed 0 is a fault.
          note: 'GB01 base rate ~1 per 1,022 symbol-days (authorized window: 33 trades / 172 sessions / 100 symbols, netPF 2.36, +0.812R per trade). barsFed 0 means the adapter never saw a closed bar.',
        };
      }

      // L3 GATE TELEMETRY WRITE (measure-only; see strategies/orderflow/gateTelemetry.js).
      // One bundle per actually-scanned pass: the published funnel UNCHANGED, the day's
      // call-status tally (CANCELLED_EXHAUSTION churn becomes countable), and every
      // evaluated candidate's gate outcomes — including terms a short-circuited if/else
      // would have hidden. Wrapped so a telemetry failure can never touch a decision;
      // GB_GATE_TELEMETRY=0 disables it, GB_ORDERFLOW_DIR sandboxes it for tests/replays.
      if (process.env.GB_GATE_TELEMETRY !== '0') {
        try {
          gateTelemetry.appendScan(DATA_DIR, this.today, {
            ist: currentIST,
            funnel,
            rows: gateRows,
            bookStatus: gateTelemetry.statusTally([...this.calls.values()]),
          });
        } catch (te) {
          console.error('[liveMinuteEngine] gate telemetry write note:', te.message);
        }
      }
    } catch (err) {
      // A SCAN ERROR ABORTS THE WHOLE PASS, so the message alone is not enough to fix it: it
      // names the symptom and hides the line. GB_SCAN_STACK=1 prints the stack, which is how
      // the 2026-07-08 harness run was traced to a single `.toFixed` on a symbol whose field
      // was never set. Never on by default — the message is what the board reads.
      console.error('[liveMinuteEngine] Scan error:', err.message);
      if (process.env.GB_SCAN_STACK === '1' && err && err.stack) console.error(err.stack);
    } finally {
      this.isScanning = false;
    }
  }

  async start() {
    console.log('[liveMinuteEngine] Initializing Institutional Live Engine...');
    await this.loadTapeBars();

    // Run initial scan
    this.scanMinuteTape();

    // 1-minute cadence for continuous live setup scanning (never unreferenced)
    this.scanInterval = setInterval(() => {
      this.scanMinuteTape();
    }, 60000);
    console.log('[liveMinuteEngine] Continuous 1-minute engine active!');
  }

  stop() {
    if (this.scanInterval) clearInterval(this.scanInterval);
  }

  getCalls() {
    return Array.from(this.calls.values());
  }

  /**
   * WHY THIS SCAN ARMED NOTHING — the funnel, for the payload and the board.
   *
   * `inPlay` is the count of scanned names whose 15-minute impulse or volume surge cleared the
   * MEASURED thresholds (see IN_PLAY_MOVE15_BPS), and `long` is the per-gate count of refusals, named
   * in the order the branch evaluates them. It is a copy: a caller polling this must not be able to
   * mutate the running scan's ledger.
   */
  getScanFunnel() {
    const f = this.scanFunnel || emptyFunnel();
    const asOf = f.asOfIST || null;
    return {
      scanned: f.scanned, inPlay: f.inPlay, qualified: f.qualified,
      asOfIST: asOf,
      // GB01/GB02: null until a scan has actually walked the universe, then the adapter's own
      // counters (see liveAdapter.stats) plus this scan's delta. The board reads `fvg.sinceBoot`
      // to tell "armed and quiet" from "never ran".
      fvg: f.fvg || null,
      gb03: f.gb03 || null,
      // OF_MOMENTUM's own line: whether it is armed for this session, how much of its cap is used,
      // and how many candidates the session cap refused — so "the prototype is filling the board"
      // and "the prototype is being held back" are both visible without reading the log.
      ofMomentum: f.ofMomentum || null,
      // A blank funnel must say WHY it is blank. After the arm cutoff or the session close the scan
      // returns before touching a symbol, and "scanned: 0" with no explanation is the same kind of
      // silence "Candidates: 0 qualified" was.
      note: asOf ? null : 'no symbol-level scan has walked the universe in this process yet — outside the session window, or before the first scan',
      slotsAvailable: f.slotsAvailable !== undefined ? f.slotsAvailable : null,
      activeSymbol: f.activeSymbol, thinBars: f.thinBars, priceCap: f.priceCap,
      inPlayMove15Bps: this.inPlayMove15Bps, inPlayVolSurge: this.inPlayVolSurge,
      long: Object.assign({}, f.long),
      short: Object.assign({}, f.short),
      basis: 'this scan only · long refusals named per gate in evaluation order',
      // The two studies behind the thresholds, so a number on the board can be traced back to the
      // measurement that produced it rather than to a comment nobody can find.
      studies: [
        'scratch/momentum_gate_study_2026-10-16.md (no momentum veto: forward 30m edge ~0 bps gross)',
        'scratch/engine_long_gate_reachability_2026-10-16.md (long conjunction fires on 0.157% of minutes)',
      ],
    };
  }

  /**
   * Today's measured win rate over CLOSED calls, or null when nothing has closed yet.
   * Null is the honest answer on a fresh session: there is no rate to report, and a
   * placeholder percentage is indistinguishable from a measurement.
   */
  todaysWinRate() {
    // THE ONE WIN RULE, via the shared tally: a win is a call whose TARGET was actually
    // hit, over decided trades (target or stop). This used to count `status === 'WON'`,
    // and the engine stamps that status on a 15:30 flatten when the GROSS points are
    // positive — so a +0.01-point close that never touched its target read as a win.
    return tallyOutcomes(this.closedCalls).winRatePct;
  }

  /** The denominator behind that rate, so a caller can weigh it. */
  todaysWinRateBasis() {
    const tally = tallyOutcomes(this.closedCalls);
    if (!tally.decided) {
      return tally.closed > 0
        ? `not measured — ${tally.closed} closed, none by target or stop`
        : 'not measured yet — no call has closed today';
    }
    return `${tally.targetHits}/${tally.decided} decided (target or stop)` +
      (tally.otherExits ? ` · ${tally.otherExits} closed without a level` : '');
  }

  getActiveCandidates() {
    // BUILT ON TOP OF rowOf(), NOT BESIDE IT. The engine has ONE call→row conversion; this
    // method only adds what an OPEN row needs and rowOf has no opinion about (the side label,
    // the signal clock, and the measured day rate with its denominator). Two shapes built by
    // two pieces of code is how a field ends up present in one table and missing in the next.
    return Array.from(this.calls.values()).filter(c => ['ARMED', 'FILLED', 'OPEN'].includes(c.status)).map(c => {
      const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
      const row = this.rowOf(c);
      return Object.assign(row, {
        // WHO MADE THIS CALL comes from rowOf (the record's own engine stamp, SWEEP_FVG /
        // OF_MOMENTUM), not from a fixed string: a fixed name made the Sweep+FVG engine's
        // live calls read as the minute engine's on every poll.
        tradeType: row.strategyName,
        action: c.action || (isShort ? 'SELL / SHORT' : 'BUY / LONG'),
        side: isShort ? 'SHORT' : 'LONG',
        signalTime: new Date(c.timestamp || Date.now()).toISOString(),
        // THE WIN RATE IS MEASURED OR IT IS NOTHING. This field used to be a hard-coded
        // '60.0%' — a number with no trades, no sample and no date behind it, displayed
        // on every open call. A caller cannot tell a measured rate from a decorative one,
        // so an absent rate is reported as null (rendered '—') along with the denominator
        // it is based on.
        winRate: this.todaysWinRate(),
        winRateBasis: this.todaysWinRateBasis(),
        filterNote: c.note || '5 Invalidation Gates Verified (EMA+Fib+POC+Sweep+Delta)',
        invalidationGates: c.invalidationGates || null,
      });
    });
  }

  /**
   * ONE CALL → ONE ROW. THE ONLY PLACE A CALL IS TURNED INTO SOMETHING THE PAGE READS.
   *
   * `getClosedHistory()`, `getActiveCandidates()` and `getBookRows()` all describe the same
   * book, and they used to describe it in three different shapes built by three different
   * pieces of code. That is how a company could sit in one table and be missing from the one
   * beside it: the closed list carried only `closedCalls`, so a call the engines CANCELLED
   * (never filled, invalidated, expired) appeared in the Sweep+FVG panel — which reads the
   * raw call book — and in neither of the tier tables. Every reader now gets the same row,
   * and the row states its own outcome (`outcomeKey`, `verdict`) and its own state (`closed`).
   */
  rowOf(c) {
    const entry = Number(c.limitEntry || c.entryPrice || 0);
    const exit = Number(c.exitPrice || entry);
    const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
    const pts = isShort ? (entry - exit) : (exit - entry);
    const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;
    const outcome = classifyCall(c);
    // ATTRIBUTED, NOT ASSERTED. Both live engines write one book (9 Sweep+FVG calls and 9
    // minute-engine calls on 2026-10-16's file), so a hardcoded OF_MOMENTUM here reported one
    // engine's calls as the other's — in the closed-calls table, the per-strategy master table
    // and the day's net R alike.
    const who = strategyOf(c);
    return {
      id: c.id,
      date: c.date,
      time: c.exitTimeIST || c.timeIST,
      symbol: c.symbol,
      engine: c.engine || who.id,
      category: c.strategyType || who.tier,
      strategyId: who.id,
      strategyName: who.name,
      action: c.action || 'BUY',
      entryPrice: entry,
      exitPrice: exit,
      stopLoss: c.stopLoss,
      target1: c.target,
      status: c.status,
      // THE BACKTEST CROSS-CHECK, ON EVERY ROW. Stamped when the call armed (parityStamp), it
      // rides the single call→row conversion so the open table, the closed table and the book
      // rows all read the same verdict — the reason rowOf exists. `null` means the call predates
      // the check; it is NOT "agreed", and the page must not paint it as one.
      parity: c.parity || null,
      // The readable outcome: TARGET ACHIEVED / STOP LOSS HIT / TIME EXIT / EXITED AT CLOSE
      // — or STILL OPEN / CANCELLED (never triggered) for a call that never became a
      // position. Same vocabulary as the history reader, by the same classifier.
      verdict: outcome.label,
      outcomeKey: outcome.key,
      // WHETHER THE POSITION ACTUALLY CLOSED, from the classifier rather than from a status
      // list each reader kept in its own head. A cancelled call and a live one are both
      // `closed: false`, and the row says which.
      closed: outcome.closed === true,
      // THE PRICE THIS ROW SHOWS WHILE IT IS OPEN, so one row shape serves an open call and
      // a closed one: the closed reader shows the exit, an open reader shows the mark.
      ltp: c.ltp || entry,
      marked: Number.isFinite(Number(c.ltpAt)),
      ltpAt: c.ltpAt || null,
      livePnLPct: Number.isFinite(Number(c.livePnLPct)) ? Number(c.livePnLPct) : null,
      livePnLVal: Number.isFinite(Number(c.livePnLVal)) ? Number(c.livePnLVal) : null,
      reason: c.exitReason || c.status,
      netBps: Number.isFinite(Number(c.netBps)) ? Number(c.netBps) : null,
      netInr1Lot: Number.isFinite(Number(c.netInr1Lot)) ? Number(c.netInr1Lot) : null,
      shares: c.shares || null,
      mfePct: Number.isFinite(Number(c.mfePct)) ? Number(c.mfePct) : null,
      riskReward: c.riskReward || '1 : 1.50',
      realizedPnLPct: +pnlPct.toFixed(2),
      realizedPnLVal: +pts.toFixed(2),
      closedAt: c.timestamp,
    };
  }

  /**
   * THE CLOSED CALLS — the ledger of what was actually held and exited.
   *
   * `verdict` used to be the raw status (WON or LOST), which answers "did it pay" but not
   * "what happened": a session flatten, a stop and a target all read the same way. The label
   * comes from the classifier in common/market/callBookHistory.js, so this table and the
   * daily history cannot use two vocabularies for one call.
   */
  getClosedHistory() {
    return this.closedCalls.map(c => this.rowOf(c));
  }

  /**
   * THE WHOLE DAY'S BOOK — every call the engines recorded, whether it became a position or
   * not, in the one row shape every reader gets.
   *
   * The tier tables were fed only the closed list plus the open calls, so a call the engines
   * CANCELLED (never filled, invalidated, expired) was missing from them while the Sweep+FVG
   * panel — which reads the raw call book — showed it. Two lists of "today's calls" built from
   * two different subsets of one book is exactly the "this table shows some companies and that
   * one shows others" complaint, so this is the list the page's tables are built from now.
   */
  getBookRows() {
    return Array.from(this.calls.values()).map(c => this.rowOf(c));
  }

  getDailyNet() {
    const all = Array.from(this.calls.values());
    const closed = this.closedCalls;
    // THE SAME ACTIVE SET THE PAGE AND THE PER-STRATEGY TABLE USE. This filtered
    // `status === 'ARMED'` while getActiveCandidates() admits ARMED + FILLED + OPEN, so the
    // daily card reported "0 ACTIVE out of 18 calls" beside a strategy table showing 3 open
    // positions — and the open calls' live P&L was left out of the day's total entirely.
    const active = all.filter(c => ['ARMED', 'FILLED', 'OPEN'].includes(c.status));

    // THE ONE WIN RULE AGAIN. These counts come from the shared classifier, so this
    // payload, the per-strategy table and the daily history all mean the same thing by
    // "won": the target was actually hit. Calls that closed without either level are
    // their own bucket and are never wins.
    const tally = tallyOutcomes(closed);
    const grossWon = closed.filter(c => c.status === 'WON').length;
    const grossLost = closed.filter(c => c.status === 'LOST').length;

    const closedPoints = closed.reduce((sum, c) => sum + (c.grossPoints1Lot || 0), 0);
    const closedNetInr = closed.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0);

    const activePoints = active.reduce((sum, c) => sum + (c.livePoints || 0), 0);
    const activeNetInr = active.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0);

    const totalNetInr = +(closedNetInr + activeNetInr).toFixed(2);
    const totalPoints = +(closedPoints + activePoints).toFixed(2);

    return {
      date: this.today,
      measured: true,
      totalRecommendations: all.length,
      totalCalls: all.length,
      activeCalls: active.length,
      closedCalls: closed.length,
      won: tally.targetHits,
      lost: tally.stopsHit,
      otherExits: tally.otherExits,
      decided: tally.decided,
      // The engine's own gross status counts, kept as a SEPARATE number: they are gross
      // points before cost, and the two views disagree on exactly the calls that do not
      // survive the round trip.
      grossWon,
      grossLost,
      winRatePct: tally.winRatePct,
      winRateBasis: tally.decided > 0
        ? `${tally.targetHits}/${tally.decided} decided (target or stop)`
        : 'not measured — nothing has hit a target or a stop today',
      positiveCalls: tally.targetHits + active.filter(c => (c.livePnLPct || 0) >= 0).length,
      closedNetInr: +closedNetInr.toFixed(2),
      activeNetInr: +activeNetInr.toFixed(2),
      totalNetInr,
      totalPoints,
      isNetPositive: totalNetInr >= 0,
      verdict: totalNetInr >= 0 ? `NET POSITIVE (+₹${Math.abs(totalNetInr)})` : `NET NEGATIVE (-₹${Math.abs(totalNetInr)})`,
      note: `Live measured today: ${tally.targetHits} target hit, ${tally.stopsHit} stopped, ` +
        `${tally.otherExits} closed without a level, ${active.length} ACTIVE out of ${all.length} calls`,
    };
  }
}

const liveEngine = new LiveMinuteEngine();

// Exposed on the exported instance so test/depthOrientation.test.js can exercise the FVG
// rules directly. The scan calls the SAME functions, so a passing test cannot describe a
// rule the engine does not apply.
liveEngine.findFvg = findFvg;
liveEngine.fvgShortGate = fvgShortGate;
liveEngine.fvgAtr = fvgAtr;
// The resolved shipped default of the FVG VETO, so a test can pin it. It must stay false
// until the causal measurement says the veto helps; see the constant's comment above.
liveEngine.fvgRequireDefault = FVG_REQUIRE;
// The resolved shipped default of the FVG CONFLUENCE WEIGHT, so a test can pin it. It must
// stay 1 (counted) until the Round 24 (C) forward test says demoting the gap helps.
liveEngine.fvgConfluenceWeightDefault = FVG_CONFLUENCE_WEIGHT;
// The confluence arithmetic itself, so a test can exercise the exact rule the scan applies.
liveEngine.confluenceCount = confluenceCount;
// The exit-geometry picker itself, pinned the same way: a test cannot pass against a rule
// the scan does not apply.
liveEngine.pickStopGeometry = pickStopGeometry;
// The resolved shipped default of the STRUCTURAL stop flag, so a test can pin that the
// default is OFF until the measurement (scratch/measure_struct_stop.js) says otherwise.
liveEngine.structStopDefault = STRUCT_STOP_DEFAULT;
// The OF03 configuration the LIVE scan hands to the backtested engine — the registry's,
// resolved. Pinned by test/ofEngine.test.js so a live/backtest drift is a failing test
// instead of a call the harness never measured.
liveEngine.of03Config = OF03_CONFIG;
// WHICH SIDE OF GB03a MAY ARM, and the rule that decides it, exposed so a test can pin
// the shipped default (short) and the two overrides without arming a scan.
liveEngine.gb03Sides = GB03_SIDES;
liveEngine.gb03SideAllowed = gb03SideAllowed;
liveEngine.gb03RiskReward = gb03RiskReward;
// The new-call and exit alert wording, so its side, its GB code and strategy branding are pinned without a send.
liveEngine.newCallTelegramText = newCallTelegramText;
liveEngine.exitTelegramText = exitTelegramText;
liveEngine.strategyNameOf = strategyNameOf;
liveEngine.gbCodeOf = gbCodeOf;
// WHAT EVENT AN ALERT NAMES — the dedupe key the transport enforces, exposed so a test can pin
// that two calls on one symbol, and one call re-read under a different outcome, are distinct.
liveEngine.alertEventKey = alertEventKey;
/**
 * ARM OF_MOMENTUM FOR THIS LIVE SESSION — called by Server.js, and by nothing else.
 *
 * Passing the decision in this way (rather than defaulting the flag on) keeps the property the
 * 2026-10-19 audit was about: nothing arms these calls unless the live process says so, so a
 * harness or a test cannot put them on the owner's board by accident. `maxSlots` reserves the
 * measured setups' room; `maxPerSession` bounds the day; every admission prints its score and its
 * rank in that minute's candidate list.
 */
liveEngine.enableOfMomentumLive = function enableOfMomentumLive(opts = {}) {
  if (opts.maxSlots !== undefined) OF_MOMENTUM_LIVE.maxSlots = Number(opts.maxSlots);
  if (opts.maxPerSession !== undefined) OF_MOMENTUM_LIVE.maxPerSession = Number(opts.maxPerSession);
  OF_MOMENTUM_LIVE.armed = true;
  console.log(`[liveMinuteEngine] OF_MOMENTUM ARMED LIVE — capped at ${OF_MOMENTUM_LIVE.maxSlots} of 6 ` +
    `board slots and ${OF_MOMENTUM_LIVE.maxPerSession} calls/session, every admission logged with its ` +
    `score and rank. This strategy is measured but NOT verified (2026-10-19 review): judge it on the ` +
    `logged admissions, not on the row count.`);
  return { ...OF_MOMENTUM_LIVE };
};
liveEngine.ofMomentumLiveState = () => ({ ...OF_MOMENTUM_LIVE });
// The ONE predicate the two arming gates read, exposed so a test can prove that arming the
// session opens them — the defect this replaced was a cap that flipped while the gates stayed
// shut on the env constant, so a "yes" from the server produced an empty board.
liveEngine.ofMomentumArmed = ofMomentumArmed;
liveEngine.structDefaults = {
  targetRr: STRUCT_TARGET_RR_DEFAULT,
  maxStopBps: STRUCT_MAX_STOP_BPS_DEFAULT,
  stopBufferBps: STRUCT_STOP_BUFFER_BPS_DEFAULT,
};

module.exports = liveEngine;
