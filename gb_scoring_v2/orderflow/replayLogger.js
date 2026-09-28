/**
 * gb_scoring_v2/orderflow/replayLogger.js — PHASE 8: REPLAY LOGGING (mandatory before any money).
 *
 * The plan's requirement, which this module exists to satisfy literally: "Every bar, log all raw
 * layer outputs (not just final decision) — huge_move flag, delta value, at_location flag, ROC
 * values, volume ratio, candle class. This lets you test layers individually later, per your own
 * instinct to not assume every condition helps."
 *
 * So a line is written for EVERY SEALED BAR of EVERY tracked symbol, whether or not anything
 * happened. Writing only decisions would produce a file that can answer "did the gate work?" and
 * cannot answer "did huge_move alone predict anything?" — which is the question the plan's
 * validation steps 2 and 3 actually ask.
 *
 * ONE LINE PER BAR PER SYMBOL, JSONL, APPEND ONLY. Nothing in the live path ever reads it back
 * (a reader on the hot path is how logging starts changing behaviour); `tail()` and `read()` exist
 * for offline analysis, and `summarize()` gives the per-layer flag rates the validation sequence
 * needs before any layer is allowed into the gate.
 */
const fs = require('fs');
const path = require('path');

// GB_ORDERFLOW_DIR lets a test (or a replay analysis run) point the engine at its own directory.
// Without it a test suite appends its synthetic symbols to the SESSION's log, and a file whose
// whole purpose is "what did the gate actually see today" stops being that.
const DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');
const FLUSH_MS = 2000;
const BUFFER_MAX = 20000;

const buffer = [];
let timer = null;
let _file = null;
const stats = { lines: 0, flushed: 0, flushErrors: 0, lastFlushAt: null, lastError: null, file: null };

function dayKey(ts = Date.now()) { return new Date(ts + 330 * 60000).toISOString().slice(0, 10); }

function fileFor(ts) {
  const want = path.join(DIR, 'replay-' + dayKey(ts) + '.jsonl');
  if (_file !== want) { if (_file) console.log('[orderflow/replay] log rolling over to ' + path.basename(want)); _file = want; stats.file = want; }
  return want;
}

/**
 * logBar(rec) — one sealed bar's complete layer output. The caller passes the objects the layers
 * already returned; nothing here recomputes or reshapes them, so the log is exactly what the gate
 * saw rather than a summary of it.
 */
function logBar(rec) {
  if (!rec || !rec.symbol) return null;
  const line = {
    at: new Date().toISOString(),
    ts: rec.ts || Date.now(),
    symbol: rec.symbol,
    price: rec.price != null ? rec.price : null,
    bar: rec.bar || null,
    momentum: rec.momentum || null,
    volume: rec.volume || null,
    footprint: rec.footprint || null,
    location: rec.location || null,
    candles: rec.candles || null,
    gate: rec.gate || null,
    layerFlags: rec.layerFlags || null,
    configHash: rec.configHash || null,
  };
  if (buffer.length >= BUFFER_MAX) buffer.shift();   // bound memory; the disk copy is the truth
  buffer.push(JSON.stringify(line) + '\n');
  stats.lines++;
  return line;
}

function flush() {
  if (!buffer.length) return 0;
  const batch = buffer.splice(0, buffer.length).join('');
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(fileFor(Date.now()), batch);
    stats.flushed++;
    stats.lastFlushAt = new Date().toISOString();
    return batch.length;
  } catch (e) {
    stats.flushErrors++;
    stats.lastError = (e && e.message) || String(e);
    console.log('[orderflow/replay] write failed:', stats.lastError);
    return 0;
  }
}

function start() {
  if (timer) return true;
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { console.log('[orderflow/replay] cannot create ' + DIR + ':', (e && e.message) || String(e)); }
  timer = setInterval(() => { try { flush(); } catch (e) { console.log('[orderflow/replay] flush threw:', (e && e.message) || String(e)); } }, FLUSH_MS);
  console.log('[orderflow/replay] armed — one line per sealed bar to data/orderflow/replay-<day>.jsonl');
  return true;
}

function stop() { if (timer) { clearInterval(timer); timer = null; } flush(); }

/** tail(n) — the last n logged lines as objects (for /api/gb/orderflow/replay). */
function tail(n = 50) {
  try {
    const file = fileFor(Date.now());
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.slice(-4000000).split('\n').filter(Boolean).slice(-n);
    return lines.map((l) => { try { return JSON.parse(l); } catch (e) { return { parseError: (e && e.message) || 'bad line' }; } });
  } catch (e) { return []; }
}

/** read(day) — every line for a day, as objects. Offline use only (Phase 8 validation). */
function read(day) {
  const file = path.join(DIR, 'replay-' + (day || dayKey()) + '.jsonl');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

/**
 * summarize(day) — Phase 8 step 2, in one call: for each LAYER, how often its flag fired and how
 * often it fired ALONE (the gate did not fire). That is the input to "find out which layers
 * actually carry signal before combining".
 */
function summarize(day) {
  const rows = read(day);
  const flag = (name, fn) => {
    let fired = 0, alone = 0, gate = 0;
    for (const r of rows) {
      const f = fn(r) === true;
      if (f) { fired++; if (!(r.gate && r.gate.verdict === 'SIGNAL')) alone++; }
      if (r.gate && r.gate.verdict === 'SIGNAL') gate++;
    }
    return { layer: name, fired, share: rows.length ? +(fired / rows.length).toFixed(3) : null, withoutSignal: alone };
  };
  return {
    day: day || dayKey(),
    rows: rows.length,
    gateSignals: rows.filter((r) => r.gate && r.gate.verdict === 'SIGNAL').length,
    gateWatch: rows.filter((r) => r.gate && r.gate.verdict === 'WATCH').length,
    layers: [
      flag('huge_move', (r) => r.momentum && r.momentum.huge),
      flag('range_expansion', (r) => r.volume && r.volume.rangeExpansion === true),
      flag('volume_confirmed', (r) => r.volume && r.volume.volumeConfirmed === true),
      flag('at_location', (r) => r.location && r.location.at === true),
      flag('candle_consulted', (r) => r.candles && r.candles.consulted === true),
      flag('fast_turning', (r) => r.momentum && r.momentum.fast && (r.momentum.fast.turningUp || r.momentum.fast.turningDown)),
    ],
    note: 'a layer that fires everywhere and never alone carries no selection power — check this before adding a condition to the gate',
  };
}

function statsOut() { return Object.assign({}, stats, { buffered: buffer.length }); }
function reset() { buffer.length = 0; }

module.exports = { logBar, start, stop, flush, tail, read, summarize, stats: statsOut, reset, DIR };
