/**
 * strategies/fvg/liveAdapter.js — GB01 / GB02 ON THE LIVE TAPE.
 *
 * WHY THIS EXISTS. `strategies/fvg/index.js` is the measured engine: 73 trades on
 * the canonical corpus, the numbers the board quotes. It is driven by
 * `createEngine().onBar(bars, i)`, and until now NOTHING in the live path ever
 * called it — the intraday tier's FVG row was the Sweep+FVG confluence engine, a
 * different rule that happens to read gaps. So the strategy with a measurement
 * behind it had no live row, and the row that existed had no measurement. This
 * adapter is the bridge, and it is deliberately the ONLY place that knows how a
 * live tape becomes the engine's input.
 *
 * THREE RULES, AND THEY MATTER MORE THAN THE PLUMBING:
 *
 *  1. ONLY CLOSED MINUTES ARE FED. `symBars` ends with the minute still forming;
 *     handing that to an incremental engine tells it a candle closed when it has
 *     not, which fabricates gaps and retests that never existed. A bar is fed
 *     only once `now >= bar.t + 60s`.
 *
 *  2. EACH BAR IS FED EXACTLY ONCE, IN ORDER. The engine carries frames, zones
 *     and cooldowns across bars, so a repeated feed would double-count a bar and
 *     a skipped one would leave a hole in a frame. `fed` is an index into the
 *     tape array; a tape that gets shorter (a new session, or a rewind) resets
 *     the engine rather than being stitched onto yesterday's state.
 *
 *  3. A STALE ANSWER IS NOT A SIGNAL. On the first scan of a session the adapter
 *     replays every closed bar of that session to rebuild state; if the LAST of
 *     those bars produced a signal it is current, but anything older than
 *     `staleMs` is history and is returned as null rather than armed at a price
 *     the market left minutes ago.
 *
 *  4. NOTHING IS SILENT. A refusal from the engine's own gate is counted under the
 *     gate's name, a signal dropped for staleness is counted separately, and a tape
 *     whose newest minute has not closed is counted as such. `stats()` publishes all
 *     of it, because on a quiet day "no calls" must not be the same answer for
 *     "nothing set up" and "the adapter is not running".
 *
 * THE TIMESTAMP IS A DATE AND A CLOCK. The live formatter elsewhere in the tree
 * returns `HH:MM:SS`, and the engines group sessions by `String(time).slice(0,10)`
 * — which on `HH:MM:SS` is the clock itself, so every bar would open a new
 * "session". That is why this file builds `YYYY-MM-DD HH:MM` itself.
 */
'use strict';

const fvg = require('./index');

/**
 * Epoch ms → the corpus format the engines parse: "YYYY-MM-DD HH:MM" in IST.
 * A bar with no clock gets NULL, not a guess: the previous formatter defaulted a
 * missing timestamp to `Date.now()`, which stamped a live wall clock onto a bar
 * that never carried one — the kind of substitution that reads as data.
 */
function istBarTime(ms) {
  const n = Number(ms);
  if (!isFinite(n)) return null;
  const shifted = new Date(n + 330 * 60000).toISOString();
  return shifted.slice(0, 10) + ' ' + shifted.slice(11, 16);
}

/**
 * `createLiveAdapter({ config, staleMs })` — one adapter for the whole process.
 * `push(symbol, bars, nowMs)` returns the engine's signal for the newest closed
 * bar, or null. `reset()` drops every per-symbol engine (used at the day
 * rollover and by tests).
 */
function createLiveAdapter(opts) {
  const config = Object.assign({}, (opts && opts.config) || {});
  const staleMs = (opts && opts.staleMs != null) ? opts.staleMs : 3 * 60 * 1000;
  const states = new Map();   // symbol -> { engine, rows, fed, day }
  // THE LAST TWO OBSERVED SESSION CLOSES, PER SYMBOL. They live OUTSIDE `states`
  // because that map is thrown away at every rollover — and yesterday's close is
  // exactly the fact that must survive it. Without this, every live session
  // starts with `prevDay === null`, so "was this stock up yesterday?" can never be
  // answered on the tape that matters. Entries are stamped with their day so a
  // rewind inside one session cannot record the same close twice.
  const sessionCloses = new Map(); // symbol -> [{ day, close }, …] oldest first, max 2

  // WHY COUNTERS. Without them the live board cannot answer the only question that matters on a
  // quiet day: is GB01 silent because nothing set up, or because the adapter never ran / the engine
  // refuses everything at one gate? A refusal is DISCARDED here (push returns null), so an
  // un-instrumented adapter reports "no calls" identically for all three. Every branch below that
  // throws an answer away increments something, and `stats()` is what the scan funnel publishes.
  const counters = {
    calls: 0,            // push() invocations that got as far as looking at a tape
    skippedNoSymbol: 0, skippedNoBars: 0, skippedBadClock: 0,
    noClosedBar: 0,      // the newest minute had not ended — nothing to decide on yet
    barsFed: 0,          // closed bars actually handed to an engine
    newStates: 0, dayResets: 0,       // first sighting of a symbol / a new session or a rewind
    noSignal: 0,         // the engine had no setup on the newest closed bar
    refused: {},         // refused BY GATE: the engine's own gate names, counted
    staleDropped: 0,     // a real signal, but older than staleMs — history, not a call
    signals: 0,
    lastSignal: null,    // { symbol, setup, side, barTimeIST, at } of the newest one returned
  };

  /** Remember a finished session's close, deduped by day, keeping the newest two. */
  function rememberClose(sym, st) {
    if (!st || st.day == null || !st.rows.length) return;
    const last = st.rows[st.rows.length - 1][4];
    if (!(Number(last) > 0)) return;              // no close, no history: never seed a zero
    const hist = (sessionCloses.get(sym) || []).filter((h) => h.day !== st.day);
    hist.push({ day: st.day, close: Number(last) });
    sessionCloses.set(sym, hist.slice(-2));
  }

  function fresh(symbol, day) {
    const prior = (sessionCloses.get(symbol) || []).map((h) => h.close);
    return {
      engine: fvg.createEngine(Object.assign({}, config, { symbol, priorDayCloses: prior })),
      rows: [], fed: 0, day,
    };
  }

  /**
   * Feed the tape and answer for its newest CLOSED bar.
   * `bars` is the engine's own `symBars` shape: [{ t, o, h, l, c, v }, …].
   */
  function push(symbol, bars, nowMs) {
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) { counters.skippedNoSymbol++; return null; }
    if (!Array.isArray(bars) || !bars.length) { counters.skippedNoBars++; return null; }
    const now = nowMs == null ? Date.now() : Number(nowMs);
    if (!isFinite(now)) { counters.skippedBadClock++; return null; }
    counters.calls++;

    // 1. the newest bar whose minute has ENDED
    let lastClosed = -1;
    for (let i = bars.length - 1; i >= 0; i--) {
      const t = Number(bars[i] && bars[i].t);
      if (isFinite(t) && now >= t + 60000) { lastClosed = i; break; }
    }
    if (lastClosed < 0) { counters.noClosedBar++; return null; }

    const newest = bars[lastClosed];
    const day = istBarTime(newest.t).slice(0, 10);
    let st = states.get(sym);
    // 2. a new session, or a tape that no longer contains the bars we already fed
    if (!st || st.day !== day || lastClosed + 1 < st.fed) {
      // Only a GENUINE session change is history. A rewind inside the same day
      // (a tape that got shorter) is not a completed session, and recording it
      // would make today's price look like a close.
      if (st && st.day !== day) rememberClose(sym, st);
      if (st) counters.dayResets++; else counters.newStates++;
      st = fresh(sym, day);
      states.set(sym, st);
    }

    let signal = null;
    for (let i = st.fed; i <= lastClosed; i++) {
      const b = bars[i];
      const t = Number(b && b.t);
      if (!isFinite(t)) continue;                         // no clock, no place in a frame
      st.rows.push([istBarTime(t), b.o, b.h, b.l, b.c, b.v]);
      // The newest bar's answer is the only one worth returning: an earlier bar's
      // signal would be armed at a price the tape has already left behind.
      signal = st.engine.onBar(st.rows, st.rows.length - 1) || null;
    }
    counters.barsFed += (lastClosed + 1) - st.fed;
    st.fed = lastClosed + 1;

    if (!signal) { counters.noSignal++; return null; }
    // A REFUSAL IS COUNTED, NOT SWALLOWED. `signal.ok === false` is the engine's own gate saying
    // why (EXTENSION/RR/VOLUME/STOP_TOO_WIDE/BLOCKED_TIME_WINDOW…), and on the live tape it is the
    // difference between "no gap formed today" and "a gap formed and the inherited ATR floor
    // refused it" — the exact question the canonical measurement raised about this engine.
    if (!signal.ok) {
      const gate = String(signal.gate || 'REFUSED');
      counters.refused[gate] = (counters.refused[gate] || 0) + 1;
      return null;
    }
    // 3. stale answers are history, not calls
    if (now - (Number(newest.t) + 60000) > staleMs) { counters.staleDropped++; return null; }
    counters.signals++;
    counters.lastSignal = {
      symbol: sym, setup: signal.setup || null, side: signal.side || null,
      barTimeIST: istBarTime(newest.t), at: new Date(now).toISOString(),
    };
    return Object.assign({}, signal, { barMs: Number(newest.t), barTimeIST: istBarTime(newest.t) });
  }

  return {
    push,
    istBarTime,
    /**
     * Forget every per-symbol engine (day rollover, or a replay restarting).
     *
     * THE SESSION-CLOSE MEMORY SURVIVES THIS ON PURPOSE. The engine's state is
     * today's state and it is correct to drop it at a rollover; yesterday's close
     * is not state, it is history, and dropping it here would reset the day-context
     * numbers at exactly the moment they start being meaningful.
     */
    reset(symbol) {
      if (symbol == null) {
        for (const [sym, st] of states) rememberClose(sym, st);
        states.clear();
      } else {
        const sym = String(symbol).toUpperCase();
        rememberClose(sym, states.get(sym));
        states.delete(sym);
      }
    },
    /** Read-only view for tests and diagnostics. */
    stateOf(symbol) {
      const st = states.get(String(symbol).toUpperCase());
      return st ? { day: st.day, fed: st.fed, bars: st.rows.length } : null;
    },
    /** The prior closes the next engine for this symbol would be seeded with. */
    priorClosesOf(symbol) {
      return (sessionCloses.get(String(symbol).toUpperCase()) || []).map((h) => h.close);
    },
    size: () => states.size,
    /**
     * CUMULATIVE telemetry since the process started. Copied, with the refusal map copied too,
     * so a caller (the scan funnel, the board payload, a test) cannot mutate the live counters.
     */
    stats() {
      return Object.assign({}, counters, { symbols: states.size, refused: Object.assign({}, counters.refused) });
    },
    /** Zero the telemetry without dropping any engine state — for a new session's baseline. */
    resetStats() {
      for (const k of Object.keys(counters)) {
        if (k === 'refused') counters.refused = {};
        else if (k === 'lastSignal') counters.lastSignal = null;
        else counters[k] = 0;
      }
    },
  };
}

module.exports = { createLiveAdapter, istBarTime };
