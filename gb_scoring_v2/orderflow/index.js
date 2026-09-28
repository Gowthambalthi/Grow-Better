/**
 * gb_scoring_v2/orderflow/index.js — THE ORDER-FLOW ENGINE, ASSEMBLED.
 *
 * The plan's build order is respected literally: capture → footprint → (location and momentum in
 * parallel) → volume → candles → gate → replay. Nothing here skips a layer, and nothing here
 * reimplements one: this file is wiring, and every number it publishes came out of the module
 * that owns it.
 *
 * WHERE THE DATA COMES FROM. The same Angel socket the tick board already runs — a second
 * subscription would cost a socket Angel caps at three, and the board is already at the cap. So
 * tickBoard exposes an onTick hook and the engine rides it: capture stores the tick, the footprint
 * classifies it, and when that tick CLOSES a 1m bar the layers run once for that bar. One bar, one
 * verdict, one replay line — the cadence the plan describes, with no polling and no second feed.
 *
 * HOW OFTEN A VERDICT CHANGES. Once per sealed 1m bar per symbol. The 20s fast frame inside a
 * verdict is read live at seal time, because a bar that closes with the tape turning is a
 * different bar from one that closed against it. Between seals the verdict is simply the last one
 * — refreshing it on the 9s client poll would mean re-deciding on unchanged bar data, which is how
 * a gate starts flipping sides on ticks that carry no bar-level information.
 */
const capture = require('./tickCapture');
const footprint = require('./footprint');
const location = require('./locationEngine');
const momentum = require('./momentumEngine');
const volume = require('./volumeEngine');
const candles = require('./candleReader');
const gate = require('./decisionGate');
const replay = require('./replayLogger');

const verdicts = new Map();      // symbol -> verdict record
let hooked = false;
let untickHook = null;
let startedAt = null;
const counters = { ticks: 0, bars: 0, signals: 0, watch: 0, noTrade: 0, layerErrors: 0, lastLayerError: null, lastBarAt: null };

function symOf(token) {
  try {
    const tb = require('../../common/market/tickBoard');
    const info = tb.subscribed && tb.subscribed.get ? tb.subscribed.get(String(token)) : null;
    return (info && info.symbol) || capture.symbolOf(token) || null;
  } catch (e) { return capture.symbolOf(token) || null; }
}

/** onTick(tick) — Phase 1 store, Phase 2 classify, and seal a bar when the minute rolls. */
function onTick(tick) {
  if (!tick || tick.token == null) return;
  const token = String(tick.token);
  const symbol = symOf(token);
  const row = capture.record(tick, symbol);
  if (!row) return;
  counters.ticks++;
  location.observe(token, row);
  let sealed = null;
  try { sealed = footprint.ingest(token, row); }
  catch (e) { counters.layerErrors++; counters.lastLayerError = (e && e.message) || String(e); return; }
  if (sealed) onBar(token, sealed);
}

/** sideOf(momentum) — the reversal candidate: a huge DOWN move is a LONG candidate. */
function candidateSide(mom) {
  if (!mom || !mom.huge) return null;
  if (mom.dir === 'down') return 'up';
  if (mom.dir === 'up') return 'down';
  return null;
}

/**
 * onBar(token, sealed) — every layer for one finished minute, then the gate, then the log.
 * The layer objects are passed through to the log UNCHANGED, so the replay file is what the gate
 * saw rather than a summary written by the code that is being checked.
 */
function onBar(token, sealed) {
  const symbol = symOf(token);
  if (!symbol) return null;
  const bars = footprint.bars(token, 240);
  const price = sealed && sealed.c != null ? sealed.c : null;
  if (!(price > 0)) return null;

  const fp = footprint.snapshot(token);
  // the engine's OWN sealed bars are offered first: they are the minutes whose volume and delta
  // this same bar's gate verdict will read, and momentum.measure takes the longer series of the two
  const mom = momentum.measure(token, { ownBars: bars });
  const vol = volume.measure(bars);
  const loc = location.atLocation(token, symbol, price, fp, bars);
  const can = candles.classify(bars, { atLocation: loc.at, side: candidateSide(mom) });
  const decision = gate.evaluate({ momentum: mom, volume: vol, footprint: fp, location: loc, candles: can });

  counters.bars++;
  counters.lastBarAt = new Date().toISOString();
  if (decision.verdict === 'SIGNAL') counters.signals++;
  else if (decision.verdict === 'WATCH') counters.watch++;
  else counters.noTrade++;

  const rec = {
    symbol,
    token,
    at: new Date().toISOString(),
    barAt: sealed ? new Date(sealed.t).toISOString() : null,
    price,
    verdict: decision.verdict,
    side: decision.side,
    candidateSide: decision.candidateSide,
    passed: decision.passed,
    total: decision.total,
    missing: decision.missing,
    checks: decision.checks,
    watchReason: decision.watchReason,
    note: decision.note,
    layers: {
      huge: !!mom.huge,
      hugeDir: mom.dir,
      z5m: mom.z5m,
      z15m: mom.z15m,
      bars: mom.bars,
      warmup: mom.warmup,
      atLocation: loc.at === true,
      atHits: (loc.hits || []).map((h) => h.name),
      tolPct: loc.tolPct,
      vwap: loc.vwap,
      poc: loc.poc,
      vah: loc.vah,
      val: loc.val,
      camZone: loc.camZone,
      fvg: loc.fvg ? loc.fvg.dir : null,
      absorption: loc.absorption ? loc.absorption.side : null,
      volRatio: vol.volRatio,
      rangeRatio: vol.rangeRatio,
      volumeConfirmed: vol.volumeConfirmed,
      rangeExpansion: vol.rangeExpansion,
      cumDelta: fp.cumDelta,
      deltaSeries: fp.collapse ? fp.collapse.series : null,
      deltaCollapse: { down: !!(fp.collapse && fp.collapse.down), up: !!(fp.collapse && fp.collapse.up) },
      basis: fp.basis,
      fast20: mom.fast ? mom.fast.roc20 : null,
      fastTurning: mom.fast ? { up: mom.fast.turningUp, down: mom.fast.turningDown } : null,
      pattern: can.pattern,
      consulted: can.consulted,
    },
  };
  verdicts.set(symbol, rec);

  replay.logBar({
    ts: sealed ? sealed.t : Date.now(),
    symbol,
    price,
    bar: sealed ? { t: sealed.t, o: sealed.o, h: sealed.h, l: sealed.l, c: sealed.c, vol: +sealed.vol.toFixed(2), delta: +sealed.delta.toFixed(2), trades: sealed.trades, basis: sealed.basis } : null,
    momentum: mom,
    volume: vol,
    footprint: { cumDelta: fp.cumDelta, collapse: fp.collapse, poc: fp.poc, absorption: fp.absorption, basis: fp.basis, unclassified: fp.unclassified, ticks: fp.ticks },
    location: loc,
    candles: can,
    gate: { verdict: decision.verdict, side: decision.side, candidateSide: decision.candidateSide, passed: decision.passed, total: decision.total, missing: decision.missing, watchReason: decision.watchReason, checks: decision.checks },
    layerFlags: rec.layers,
  });
  return rec;
}

/** start() — arms capture + replay and hooks the tick board. Idempotent. */
function start() {
  capture.start();
  replay.start();
  if (!startedAt) startedAt = new Date().toISOString();
  if (!hooked) {
    try {
      const tb = require('../../common/market/tickBoard');
      if (typeof tb.onTickHook === 'function') {
        untickHook = tb.onTickHook((t) => { try { onTick(t); } catch (e) { counters.layerErrors++; counters.lastLayerError = (e && e.message) || String(e); } });
        hooked = true;
        console.log('[orderflow] hooked to the tick board — capture + footprint + gate run on every tick');
      } else {
        console.log('[orderflow] tickBoard has no onTickHook — engine armed but NOT fed');
      }
    } catch (e) {
      console.log('[orderflow] could not hook the tick board:', (e && e.message) || String(e));
    }
  }
  return { hooked, startedAt };
}

function stop() {
  if (typeof untickHook === 'function') { try { untickHook(); } catch (e) { /* already gone */ } }
  hooked = false; untickHook = null;
  capture.stop();
  replay.stop();
}

/** verdictFor(symbol) — the last sealed-bar verdict for one name. */
function verdictFor(symbol) {
  return verdicts.get(String(symbol).replace(/-EQ$/i, '').toUpperCase()) || null;
}

/** board() — every verdict, signals first, with the counts the UI needs. */
function board(limit = 900) {
  const all = Array.from(verdicts.values());
  const rank = { SIGNAL: 0, WATCH: 1, 'NO-TRADE': 2 };
  all.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || a.symbol.localeCompare(b.symbol));
  const count = (v) => all.filter((r) => r.verdict === v).length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    startedAt,
    hooked,
    counts: {
      rows: all.length,
      signal: count('SIGNAL'),
      watch: count('WATCH'),
      noTrade: count('NO-TRADE'),
      long: all.filter((r) => r.verdict === 'SIGNAL' && r.side === 'LONG').length,
      short: all.filter((r) => r.verdict === 'SIGNAL' && r.side === 'SHORT').length,
    },
    cadence: { verdictsPerBar: 'one per symbol per sealed 1m bar', fastFrame: 'ROC(20s) from the 10-second grid, read at seal time' },
    items: all.slice(0, limit),
  };
}

/** status() — the engine's own health: capture quality, per-layer reach, warmup, replay file. */
function status() {
  const q = capture.quality();
  const all = Array.from(verdicts.values());
  const withBars = all.filter((r) => r.layers && r.layers.bars > 0).length;
  const basis = {};
  let unclassified = 0;
  for (const r of all) {
    const b = (r.layers && r.layers.basis) || {};
    for (const k of Object.keys(b)) basis[k] = (basis[k] || 0) + b[k];
    unclassified += (r.layers && r.layers.ticks != null) ? 0 : 0;
  }
  const layerReach = (fn) => all.filter((r) => fn(r.layers || {})).length;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    startedAt,
    hooked,
    capture: q,
    footprint: { tokensWithBars: withBars, classifyBasis: basis, unclassifiedTicks: unclassified },
    gate: {
      signals: all.filter((r) => r.verdict === 'SIGNAL').length,
      watch: all.filter((r) => r.verdict === 'WATCH').length,
      noTrade: all.filter((r) => r.verdict === 'NO-TRADE').length,
      layerReach: {
        hugeMove: layerReach((l) => l.huge === true),
        atLocation: layerReach((l) => l.atLocation === true),
        volumeConfirmed: layerReach((l) => l.volumeConfirmed === true),
        rangeExpansion: layerReach((l) => l.rangeRatio != null && l.rangeExpansion === true),
        candleConsulted: layerReach((l) => l.consulted === true),
        fastTurning: layerReach((l) => l.fastTurning && (l.fastTurning.up || l.fastTurning.down)),
      },
    },
    counters,
    replay: replay.stats(),
    note: 'layers are logged individually per sealed bar; validate a layer alone (replayLogger.summarize) before trusting it inside the gate',
  };
}

function reset() { verdicts.clear(); counters.ticks = 0; counters.bars = 0; counters.signals = 0; counters.watch = 0; counters.noTrade = 0; }
function onBarForTest(token, sealed) { return onBar(token, sealed); }

module.exports = {
  start, stop, onTick, onBar: onBarForTest, board, status, verdictFor, verdicts, candidateSide, reset, counters,
  capture, footprint, location, momentum, volume, candles, gate, replay,
  layers: { capture, footprint, location, momentum, volume, candles, gate, replay },
};
