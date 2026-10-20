/**
 * orderflow/liveEventJournal.js — PHASE 5: the LIVE EVENT JOURNAL.
 *
 * WHY THIS EXISTS. Phase 5 has to prove that what the live path SAW and what the
 * replay path RECONSTRUCTS are the same decisions. That proof needs the live side
 * to emit a journal in the same shape the replay emits. This module produces that
 * shape.
 *
 * IT DOES NOT DETECT ANYTHING. There is exactly one detector in this repo
 * (strategies/orderFlow.js) and exactly one change30 measurement
 * (backtest/eventMicro.js measure()). This file wraps both: it runs the frozen
 * engine and reads the trace callback the engine already emits, and it reads
 * change30 from the existing measurement path. It never computes a second
 * change30 and never creates a second detector.
 *
 * IDENTITY. Every journal row is keyed by the shared identity
 * (backtest/phase5Identity.js): candidateId = symbol|setup|side|decisionBarTs,
 * where decisionBarTs is the CLOSE of the existing 1-minute decision bar.
 *
 * change30Input is recorded ONLY when the existing measurement path produced a
 * measurement. A thin tape yields `available:false` with null fields — no
 * evidence, never a guessed number.
 */
'use strict';

const path = require('path');
const { BY_KEY } = require('../../strategy-core/engines');
const { T } = require('../../strategy-core/indicators');
const { follow, inEntryWindow } = require('../../backtest/follow');
const identity = require('../../backtest/phase5Identity');
const em = require('../../backtest/eventMicro');

const WARMUP = 60;

/** The existing change30 measurement inputs, read (never recomputed) from measure(). */
function change30InputFrom(e, m) {
  if (!m) {
    return {
      available: false, windowStart: null, windowEnd: null, tickCount: null,
      delta30: null, deltaAccel30: null, change30: null,
    };
  }
  const windowEnd = e.ms;
  const windowStart = e.ms - 30 * 1000;
  return {
    available: true,
    windowStart,
    windowEnd,
    tickCount: m.ticks30 == null ? null : m.ticks30,
    delta30: m.deltaRatio30 == null ? null : m.deltaRatio30,
    deltaAccel30: m.deltaAccel == null ? null : m.deltaAccel,
    change30: !!(m.triggers && m.triggers.change30 === true),
  };
}

/** The decision fields the engine itself made the armed decision on. */
function decisionFrom(rec) {
  return {
    locationType: rec.locationType == null ? null : rec.locationType,
    probedLevel: rec.probedLevel == null ? null : rec.probedLevel,
    triggerLevel: rec.triggerLevel == null ? null : rec.triggerLevel,
    invalidation: rec.invalidation == null ? null : rec.invalidation,
    closeLocation: rec.closeLocation == null ? null : rec.closeLocation,
    volumeRatio: rec.volumeRatio == null ? null : rec.volumeRatio,
    atrPct: rec.atrPct == null ? null : rec.atrPct,
    price: rec.price == null ? null : rec.price,
  };
}

/**
 * Build the journal for one corpus + scope. Returns { armed, eligible, meta }:
 *   armed    — one row per ARMED event (the decision bar that armed), keyed by
 *              candidateId, carrying decision + change30Input.
 *   eligible — one row per candidate handed to follow(), keyed by candidateId of
 *              the TRIGGER (decision) bar, carrying eligibility + plan + the
 *              parent event's change30Input.
 *
 * `opts.measureArmed(armedList)` lets a test inject the measurement map. The
 * default uses eventMicro's existing readWindows + measure, unchanged.
 */
async function buildJournal(corpus, opts) {
  const o = opts || {};
  const engineMod = o.engineMod || require('../../strategies/orderFlow');
  const scopeDays = o.scopeDays || null;             // Set of YYYY-MM-DD, or null = all
  const hold = o.hold == null ? BY_KEY.ORDERFLOW.maxHoldBars : o.hold;
  const warmup = o.warmup == null ? WARMUP : o.warmup;
  const onRow = typeof o.onRow === 'function' ? o.onRow : null;

  const armed = new Map();       // candidateId -> row
  const eligible = new Map();    // candidateId -> row
  const meta = { armedEvents: 0, signals: 0, eligible: 0, outsideScope: 0, outsideEntryWindow: 0 };

  for (const { symbol, candles } of corpus) {
    const armedBySetupSide = new Map();
    const perDay = new Set();
    const eng = engineMod.createEngine({
      symbol,
      trace: (rec) => {
        if (!rec) return;
        const id = identity.identity({ symbol, setup: rec.setup, side: rec.side, barTime: rec.time });
        if (rec.stage === 'armed') {
          armedBySetupSide.set(rec.setup + '|' + rec.side, rec);
          const day = String(rec.time).slice(0, 10);
          if (scopeDays && !scopeDays.has(day)) return;
          const row = Object.assign(id, {
            stage: 'armed',
            decisionBarTime: rec.time,
            barsToTrigger: rec.barsToTrigger == null ? 0 : rec.barsToTrigger,
            decision: decisionFrom(rec),
            change30Input: null,      // filled after the measurement pass
            captureMeta: { ingestSeq: meta.armedEvents, receivedAt: null },
          });
          armed.set(id.candidateId, row);
          meta.armedEvents += 1;
          if (onRow) onRow('armed', row);
        } else if (rec.stage === 'expired' || rec.stage === 'breached') {
          armedBySetupSide.delete(rec.setup + '|' + rec.side);
        }
      },
    });

    for (let i = warmup; i < candles.length - 1; i++) {
      let s;
      try { s = eng.onBar(candles, i); } catch (_) { continue; }
      if (!s) continue;
      meta.signals += 1;
      const time = s.signalTime || candles[i][T.TIME];
      const day = String(time).slice(0, 10);
      if (scopeDays && !scopeDays.has(day)) { meta.outsideScope += 1; continue; }
      if (!inEntryWindow(time)) { meta.outsideEntryWindow += 1; continue; }

      const id = identity.identity({ symbol, setup: s.setup, side: s.side, barTime: time });
      const parent = armedBySetupSide.get(s.setup + '|' + s.side) || null;
      const parentId = parent
        ? identity.identity({ symbol, setup: s.setup, side: s.side, barTime: parent.time }).candidateId
        : null;
      armedBySetupSide.delete(s.setup + '|' + s.side);

      const followOut = follow(candles, s, hold);
      const rejected = followOut && followOut.rejected ? followOut.rejected : null;
      const filled = followOut && !followOut.rejected ? followOut : null;
      const sd = s.setupData || {};
      const row = Object.assign(id, {
        stage: 'eligible',
        decisionBarTime: time,
        parentCandidateId: parentId,
        eligibility: {
          eligible: !!s.ok && !rejected,
          gate: s.ok ? null : (s.gate || null),
          reason: s.ok ? (rejected || null) : (s.reject || s.gate || null),
        },
        plan: {
          entry: filled ? filled.entry : (s.entry == null ? null : s.entry),
          stop: filled ? filled.stop : (s.stop == null ? null : s.stop),
          t1: filled ? filled.t1 : (s.t1 == null ? null : s.t1),
          t2: filled ? filled.t2 : (s.t2 == null ? null : s.t2),
          rr1: filled ? filled.rr1 : (s.rr1 == null ? null : s.rr1),
        },
        outcome: filled ? filled.outcome : (rejected || null),
        barsToTrigger: sd.barsToTrigger == null ? null : sd.barsToTrigger,
        triggerTime: time,
        change30Input: null,        // inherited from the parent armed row after measurement
      });
      eligible.set(id.candidateId, row);
      meta.eligible += 1;
      if (onRow) onRow('eligible', row);
    }
  }

  // The measurement pass — the EXISTING path. Armed events are measured with
  // eventMicro.collectEvents-equivalent windows; the caller may inject instead.
  let measurement;
  if (typeof o.measureArmed === 'function') {
    measurement = await o.measureArmed([...armed.values()]);
  } else {
    measurement = await defaultMeasureArmed(armed, corpus, scopeDays);
  }
  for (const [cid, input] of measurement) {
    const row = armed.get(cid);
    if (row) row.change30Input = input;
  }
  // Eligible rows inherit the parent event's change30Input.
  for (const row of eligible.values()) {
    const parent = row.parentCandidateId ? armed.get(row.parentCandidateId) : null;
    row.change30Input = parent ? parent.change30Input : null;
  }

  return { armed: [...armed.values()], eligible: [...eligible.values()], meta };
}

/**
 * Default measurement: reuse eventMicro's existing collectEvents/readWindows/
 * measure. `armed` rows already carry symbol/day/decisionBarTs; we rebuild the
 * minimal event objects measure() expects and stream the tape once per day.
 */
async function defaultMeasureArmed(armedMap, corpus, scopeDays) {
  const out = new Map();
  const rows = [...armedMap.values()];
  const byDay = new Map();
  for (const r of rows) {
    const day = String(r.decisionBarTime).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, dayRows] of byDay) {
    // measure() needs {symbol, ms, side, price, atrPct, minute, block, locationType, setup, time}
    const events = dayRows.map((r) => ({
      symbol: r.symbol, day, ms: r.decisionBarTs, setup: r.setup, side: r.side,
      time: r.decisionBarTime, price: r.decision.price, atrPct: r.decision.atrPct,
      minute: -1, block: 'other', locationType: r.decision.locationType,
      volumeRatio: r.decision.volumeRatio, closeLocation: r.decision.closeLocation,
      probedLevel: r.decision.probedLevel, triggerLevel: r.decision.triggerLevel,
      invalidation: r.decision.invalidation,
    }));
    let windows;
    try { windows = await em.readWindows(day, events); } catch (_) { windows = { ticks: new Map() }; }
    for (const e of events) {
      const m = em.measure(e, windows.ticks.get(e));
      const cid = identity.candidateIdOf({ symbol: e.symbol, setup: e.setup, side: e.side, decisionBarTs: e.ms });
      out.set(cid, change30InputFrom(e, m));
    }
  }
  return out;
}

module.exports = { WARMUP, change30InputFrom, decisionFrom, buildJournal, defaultMeasureArmed };
