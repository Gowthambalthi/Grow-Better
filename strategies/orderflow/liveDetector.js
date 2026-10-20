/**
 * orderflow/liveDetector.js — PHASE 5: the LIVE detector + event-journal loop.
 *
 * WHY THIS EXISTS. Tick capture records the raw tape, but Phase 5 needs the LIVE
 * DECISIONS too — which candidates the frozen detector ARMED and made ELIGIBLE at
 * the moment they happened. Until now nothing in the running server produced
 * that: the Board is built offline from historical candles. This module runs the
 * frozen OF01/OF03 engine live and writes a journal.
 *
 * IT DOES NOT DETECT ANYTHING NEW. It aggregates ticks into the SAME 1-minute
 * bars the replay reads, feeds them to the SAME engine (strategies/orderFlow.js)
 * through the SAME `onBar(bars, i)` call the backtest uses, and records the trace
 * the engine already emits. The change30 input comes from the SAME measurement
 * (backtest/eventMicro.measure()) over the captured tick ring — never recomputed.
 *
 * IT IS PASSIVE. The journal is written to disk; it never feeds a signal, a
 * planner gate or the Board. It is armed only when tick capture is armed.
 *
 * IDENTITY. Every row is keyed by the shared identity: candidateId =
 * symbol|setup|side|decisionBarTs, decisionBarTs being the CLOSE of the 1-minute
 * decision bar (see backtest/phase5Identity.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const { T } = require('../../strategy-core/indicators');
const { BY_KEY } = require('../../strategy-core/engines');
const identity = require('../../backtest/phase5Identity');
const journal = require('./liveEventJournal');
const em = require('../../backtest/eventMicro');

const ROOT = path.resolve(__dirname, '..');
const CORPUS = path.join(ROOT, 'data', 'ohlcv_1m');
const OUT_DIR = path.join(ROOT, 'data', 'terminal');
// Enough seed bars to warm the engine's rolling tail (25) and ATR/VWAP trackers
// before the first live minute — the replay warms up the same way.
const SEED_BARS = 120;
const FLUSH_MS = 5000;
const HOLD = BY_KEY.ORDERFLOW.maxHoldBars;

/** The IST minute bucket a tick belongs to, as "YYYY-MM-DD HH:MM". */
function minuteKey(ts) {
  const d = new Date(Number(ts) + 330 * 60000);
  return d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
}

/** Seed a symbol's bar array from the corpus, replaying it to warm the engine. */
function seedBars(symbol) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(CORPUS, symbol + '.json'), 'utf8'));
    const c = j && Array.isArray(j.candles) ? j.candles : [];
    return c.slice(-SEED_BARS);
  } catch (_) { return []; }
}

/**
 * createLiveDetector({ capture, symbols, log, outPath }) → { onTick, flush, close, stats }
 *
 * `capture` is orderflow/tickCapture — used only to resolve token→symbol and to
 * read the captured tick ring for the change30 measurement.
 */
function createLiveDetector(opts) {
  const o = opts || {};
  const capture = o.capture || require('./tickCapture');
  const say = o.log || ((m) => console.log(m));
  const symbols = (o.symbols || []).map((s) => String(s).replace(/-EQ$/i, '').toUpperCase());
  const outPath = o.outPath || path.join(OUT_DIR, 'phase5-live-journal-' + new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10) + '.jsonl');

  const state = new Map();   // symbol -> { bars, cur, eng, token }
  let rows = 0, armed = 0, eligible = 0, flushes = 0, writeErrors = 0, lastError = null;
  let timer = null;

  function initSymbol(symbol) {
    const bars = seedBars(symbol);
    const st = { symbol, bars, cur: null, token: capture.tokenOf ? capture.tokenOf(symbol) : null, eng: null, warming: true };
    st.eng = require('../../strategies/orderFlow').createEngine({
      symbol,
      trace: (rec) => onTrace(symbol, st, rec),
    });
    // Warm the engine over the seed the same way the replay does. WARMING MUST
    // NOT JOURNAL: the seed is historical replay, not a live decision, and a
    // journal row for it would claim the live path saw a bar it never saw.
    for (let i = 0; i < bars.length; i++) { try { st.eng.onBar(bars, i); } catch (_) { /* keep going */ } }
    st.warming = false;
    state.set(symbol, st);
    return st;
  }

  function onTrace(symbol, st, rec) {
    if (!rec) return;
    if (st && st.warming) return;          // seed replay is not a live decision
    if (rec.stage !== 'armed') return;
    const id = identity.identity({ symbol, setup: rec.setup, side: rec.side, barTime: rec.time });
    const input = measureFromRing(st, id.decisionBarTs, rec);
    const row = Object.assign(id, {
      stage: 'armed',
      decisionBarTime: rec.time,
      barsToTrigger: rec.barsToTrigger == null ? 0 : rec.barsToTrigger,
      decision: journal.decisionFrom(rec),
      change30Input: input,
      captureMeta: { ingestSeq: armed, receivedAt: new Date().toISOString() },
    });
    append(row);
    armed += 1;
  }

  /** The existing measurement over the live tick ring — one implementation. */
  function measureFromRing(st, ms, rec) {
    try {
      const series = (st.token ? capture.ticks(st.token) : []).map((r) => ({ t: r.t, p: r.p, q: r.q }));
      const e = {
        symbol: st.symbol, day: String(rec.time).slice(0, 10), ms,
        setup: rec.setup, side: rec.side, time: rec.time, price: rec.price,
        atrPct: rec.atrPct, minute: -1, block: 'other', locationType: rec.locationType,
      };
      const m = em.measure(e, series);
      return journal.change30InputFrom(e, m);
    } catch (_) {
      return { available: false, windowStart: null, windowEnd: null, tickCount: null, delta30: null, deltaAccel30: null, change30: null };
    }
  }

  function append(row) {
    pending.push(JSON.stringify(row));
    rows += 1;
  }
  const pending = [];

  function flush() {
    if (!pending.length) return 0;
    const batch = pending.splice(0, pending.length).join('\n') + '\n';
    try {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.appendFileSync(outPath, batch);
      flushes += 1;
      return batch.length;
    } catch (e) {
      writeErrors += 1;
      lastError = (e && e.message) || String(e);
      return 0;
    }
  }

  /** One tick: aggregate into the symbol's current 1-minute bar. */
  function onTick(tick) {
    if (!tick || tick.token == null) return;
    const symbol = capture.symbolOf ? capture.symbolOf(String(tick.token)) : null;
    if (!symbol) return;
    const p = Number(tick.lastTradedPrice);
    if (!(p > 0)) return;
    const ts = Number(tick.exchangeTimestamp) || Date.now();
    const key = minuteKey(ts);

    let st = state.get(symbol);
    if (!st) st = initSymbol(symbol);
    if (!st.token) st.token = String(tick.token);

    if (st.cur && key !== st.cur.key) closeBar(st, st.cur);
    if (!st.cur) {
      st.cur = { key, o: p, h: p, l: p, c: p, v: Number(tick.lastTradedQuantity) || 0 };
    } else {
      st.cur.h = Math.max(st.cur.h, p);
      st.cur.l = Math.min(st.cur.l, p);
      st.cur.c = p;
      st.cur.v += Number(tick.lastTradedQuantity) || 0;
    }
  }

  function closeBar(st, bar) {
    const row = [bar.key, bar.o, bar.h, bar.l, bar.c, bar.v];
    st.bars.push(row);
    const i = st.bars.length - 1;
    let s = null;
    try { s = st.eng.onBar(st.bars, i); } catch (_) { return; }
    if (s && s.ok) {
      // eligible row: keyed on the TRIGGER bar's close (the decision bar).
      const time = s.signalTime || bar.key;
      const id = identity.identity({ symbol: st.symbol, setup: s.setup, side: s.side, barTime: time });
      append(Object.assign(id, {
        stage: 'eligible',
        decisionBarTime: time,
        eligibility: { eligible: true, gate: null, reason: null },
        plan: { entry: s.entry, stop: s.stop, t1: s.t1, t2: s.t2, rr1: s.rr1 },
        outcome: null,
        barsToTrigger: (s.setupData && s.setupData.barsToTrigger) == null ? null : s.setupData.barsToTrigger,
        change30Input: null,
      }));
      eligible += 1;
    }
  }

  function start() {
    if (timer) return true;
    timer = setInterval(() => { try { flush(); } catch (_) { /* reported in stats */ } }, FLUSH_MS);
    timer.unref();
    say('[orderflow/journal] live detector armed on ' + symbols.length + ' symbols → ' + path.relative(ROOT, outPath));
    return true;
  }

  function close() {
    if (timer) { clearInterval(timer); timer = null; }
    for (const st of state.values()) if (st.cur) { closeBar(st, st.cur); st.cur = null; }
    flush();
    return stats();
  }

  function stats() {
    return { outPath, rows, armed, eligible, flushes, writeErrors, lastError, symbols: state.size };
  }

  return { onTick, flush, close, start, stats };
}

module.exports = { createLiveDetector, minuteKey, seedBars, SEED_BARS };
