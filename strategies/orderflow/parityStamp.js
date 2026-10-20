'use strict';

/**
 * BACKTEST CROSS-CHECK FOR A LIVE CALL.
 *
 * The owner's requirement (2026-10-20): *"when the backtest shows buy at 2:30, the live code must
 * show buy at 2:30 with the same stop and target — only then is the deployment correct."*
 *
 * This module answers that question FOR THE CALL BEING ARMED, at the moment it is armed, and the
 * answer travels with the call: it is saved in the book, printed in the Telegram alert, and shown
 * on the board. A verdict that only exists in a scratch report cannot be read at the moment a
 * trade is taken, which is the only moment it is worth anything.
 *
 * HOW IT CHECKS — a fresh engine, not the live one. The live path arms from a per-symbol engine
 * that has been fed incrementally all day; asking that same instance whether it agrees with itself
 * would always say yes. So a NEW engine is built and replayed over the symbol's day bars exactly as
 * `backtest/runAll.js` drives it (tuple bars, `onBar(bars, i)`, 60-bar warmup, entry window), and
 * its answer is compared with the call the live server just produced.
 *
 * WHAT A VERDICT CAN SAY
 *   MATCH              same setup, same bar, same side, stop and T1 within 1% — the deployment is
 *                      taking exactly the trade the measurement describes.
 *   PLAN_DIFFERS       same setup/bar/side, but the stop or the target moved. A real defect.
 *   OTHER_MINUTE       the backtest fired that day on this setup and side, but on another bar.
 *   NO_BACKTEST_TRIGGER the replay found nothing for this setup that day.
 *   OUTSIDE_WARMUP     the bar is inside the backtest's 60-bar warmup, so the measured edge never
 *                      covered it. Reported by name because it is the live server acting on
 *                      evidence the backtest does not have — not a wrong call, an unmeasured one.
 *   OUTSIDE_WINDOW     the engine fired but `runAll` would have refused the bar (entry window or a
 *                      measured dead window).
 *   UNVERIFIED         the replay threw. Never silently treated as agreement.
 *
 * COST. One replay per armed call — at a handful of calls a day this is milliseconds, and it is
 * paid only when a call is actually made, never per scan or per symbol.
 */

const orderFlow = require('../orderFlow');
const fvg = require('../fvg/index');
const follow = require('../../backtest/follow');
const { WARMUP_MINUTES } = require('../../backtest/runAll');
const { istBarTime } = require('../fvg/liveAdapter');

const WARMUP = Number.isFinite(WARMUP_MINUTES) ? WARMUP_MINUTES : 60;
const TOL = 0.01;   // 1%, the same tolerance the parity harness uses

/** Which engine owns this setup id. FG01/FG02 are GB01's FVG engine; OF03 is GB03a's. */
function engineFor(setupId) {
  const id = String(setupId || '').toUpperCase();
  if (id === 'OF03') return { mod: orderFlow, key: 'GB03a' };
  if (id === 'FG01' || id === 'FG02') return { mod: fvg, key: 'GB01' };
  return null;
}

const normSide = (s) => {
  const u = String(s || '').toUpperCase();
  return u.includes('SHORT') || u.includes('SELL') ? 'SHORT' : 'LONG';
};

/**
 * Replay one symbol's bars through a FRESH engine and return every trigger it reports.
 * Bars are the live engine's own `{t,o,h,l,c,v}` objects; the tuple form is what the
 * engines read, and the timestamp string is the corpus format the backtest uses.
 */
function replay(symbol, bars, mod) {
  const tup = bars.map((b) => [istBarTime(b.t), b.o, b.h, b.l, b.c, b.v]);
  const eng = mod.createEngine(Object.assign({}, mod.DEFAULTS, { symbol }));
  const out = [];
  for (let i = 0; i < tup.length; i++) {
    let sig;
    try { sig = eng.onBar(tup, i); } catch (_) { continue; }
    if (!sig || !sig.ok || !sig.plan) continue;
    out.push({
      i, ts: tup[i][0], setup: sig.setup, side: normSide(sig.side),
      stop: sig.plan.stop, t1: sig.plan.t1,
    });
  }
  return out;
}

const near = (a, b) => {
  if (a == null || b == null || !Number.isFinite(+a) || !Number.isFinite(+b)) return false;
  const x = +a, y = +b;
  return Math.abs(x - y) / Math.max(1e-9, Math.abs(x)) <= TOL;
};

/** Would `runAll` have taken a decision on this bar at all? */
function tradableAt(ts) {
  try {
    if (follow.inBlockedWindow && follow.inBlockedWindow(ts)) return false;
    if (follow.inEntryWindow && !follow.inEntryWindow(ts)) return false;
  } catch (_) { /* an unreadable window must not turn a check into a pass */ }
  return true;
}

/**
 * Stamp one armed call with its backtest verdict.
 *
 * `call` is the candidate the scan built: `{ symbol, setup, side, stopLoss, target }`.
 * `bars` is the symbol's CURRENT tape — the closed bars the live engine armed from, so the
 * decision bar is its last element.
 */
function stamp(call, bars) {
  const setupId = String((call && (call.setup || call.strategyId)) || '').toUpperCase();
  const decisionIdx = Array.isArray(bars) ? bars.length - 1 : -1;
  if (decisionIdx < 1) {
    return { status: 'UNVERIFIED', reason: 'no closed bar to check', checkedAt: new Date().toISOString() };
  }
  const decisionBar = istBarTime(bars[decisionIdx].t);
  const eng = engineFor(setupId);
  if (!eng) {
    return {
      status: 'UNVERIFIED', reason: 'no backtest engine for setup ' + (setupId || '(none)'),
      decisionBar, strategy: null, checkedAt: new Date().toISOString(),
    };
  }

  let triggers;
  try {
    triggers = replay(call.symbol, bars, eng.mod);
  } catch (e) {
    return {
      status: 'UNVERIFIED', reason: String(e && e.message || e),
      decisionBar, strategy: eng.key, checkedAt: new Date().toISOString(),
    };
  }

  const side = normSide(call.side);
  const same = triggers.filter((t) => String(t.setup).toUpperCase() === setupId && t.side === side);
  const onBar = same.find((t) => t.ts === decisionBar);
  const base = {
    strategy: eng.key,
    decisionBar,
    barIndex: decisionIdx,
    backtestTriggers: same.length,
    backtestBars: same.slice(0, 5).map((t) => t.ts.slice(11, 16)),
    checkedAt: new Date().toISOString(),
  };

  // The warmup and the window are reported BEFORE agreement, because a bar the measured corpus
  // never covered cannot be "verified" by it — saying MATCH there would be a false reassurance.
  if (decisionIdx < WARMUP) {
    return Object.assign(base, {
      status: 'OUTSIDE_WARMUP',
      reason: 'bar ' + (decisionIdx + 1) + ' of the day — inside the backtest\'s ' + WARMUP + '-bar warmup',
      backtest: onBar ? { at: onBar.ts, stop: onBar.stop, t1: onBar.t1 } : null,
    });
  }
  if (!tradableAt(decisionBar)) {
    return Object.assign(base, {
      status: 'OUTSIDE_WINDOW',
      reason: 'runAll refuses this bar (entry window or a measured dead window)',
      backtest: onBar ? { at: onBar.ts, stop: onBar.stop, t1: onBar.t1 } : null,
    });
  }
  if (!onBar) {
    return Object.assign(base, {
      status: same.length ? 'OTHER_MINUTE' : 'NO_BACKTEST_TRIGGER',
      backtest: same.length ? { at: same[0].ts, stop: same[0].stop, t1: same[0].t1 } : null,
    });
  }
  const okPlan = near(call.stopLoss, onBar.stop) && near(call.target, onBar.t1);
  return Object.assign(base, {
    status: okPlan ? 'MATCH' : 'PLAN_DIFFERS',
    backtest: { at: onBar.ts, stop: onBar.stop, t1: onBar.t1 },
    live: { stop: call.stopLoss, t1: call.target },
  });
}

/** The one line a human reads. Exported so the Telegram wording is testable without a send. */
function describe(parity) {
  if (!parity || !parity.status) return null;
  const bt = parity.backtest;
  switch (parity.status) {
    case 'MATCH':
      return '🔎 Backtest check: <b>MATCH</b> — same bar, same side, same stop/T1';
    case 'PLAN_DIFFERS':
      return '🔎 Backtest check: <b>PLAN DIFFERS</b> — backtest stop ₹' +
        (bt ? Number(bt.stop).toFixed(2) : '—') + ' / T1 ₹' + (bt ? Number(bt.t1).toFixed(2) : '—');
    case 'OTHER_MINUTE':
      return '🔎 Backtest check: <b>OTHER MINUTE</b> — backtest fired at ' +
        (bt ? bt.at.slice(11, 16) : '—') + ' IST';
    case 'NO_BACKTEST_TRIGGER':
      return '🔎 Backtest check: <b>NO BACKTEST TRIGGER</b> that day for this setup';
    case 'OUTSIDE_WARMUP':
      return '🔎 Backtest check: <b>UNMEASURED WINDOW</b> — inside the backtest warmup, no edge measured here';
    case 'OUTSIDE_WINDOW':
      return '🔎 Backtest check: <b>OUTSIDE ENTRY WINDOW</b> — the backtest refuses this bar';
    default:
      return '🔎 Backtest check: <b>UNVERIFIED</b> — ' + (parity.reason || 'the replay did not run');
  }
}

module.exports = { stamp, describe, replay, engineFor, WARMUP };
