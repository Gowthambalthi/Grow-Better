'use strict';

/**
 * orderflow/callOutcomes.js
 *
 * WHAT A CALL ACTUALLY DID, read off the recorded tape instead of the latest price.
 *
 * WHY THIS EXISTS. The calls page marked a call WON as soon as the last traded price was past its
 * target - whether or not the limit was ever reached, and several hours after the fact. That credits
 * a trade nobody could have taken: a limit order that price never came back to is not a trade, and a
 * call armed at 12:39 that ran past its target at 12:44 without ever trading through its limit made
 * its owner Rs 0.00, not the target's worth. The three questions worth answering per call are
 * therefore separate, and this module answers each from the same tape:
 *
 *   1. WAS IT FILLED?      The engine's own rule (identical to onTick in sweepFvgLive.js): a SHORT
 *                          limit fills when the price trades THROUGH it by a tick (p >= limit+0.05),
 *                          a LONG when p <= limit-0.05, and the fill is booked AT the resting limit,
 *                          never at a better price. The engine's anti-chase rule is mirrored too: a
 *                          setup that travels 60% of the way to its target before filling is
 *                          CANCELLED_EXHAUSTION, and it was never a trade either.
 *   2. WHAT HAPPENED NEXT? Target first, stop first, or still open at the last captured tick. The
 *                          exit is booked at the level itself, exactly as the engine books it.
 *   3. WHAT IS IT WORTH?   Gross points and NET RUPEES for one share, using the engine's own toll -
 *                          calcItemizedToll(why) = 5.384 bps statutory + measured exit slippage - so
 *                          this table and the 15:30 scorecard cannot disagree about costs.
 *
 * THE TAPE ENDS WHEN CAPTURE ENDS. Every result carries `coveredUntil` so an "OPEN" row is never read
 * as "still open in the market" when it only means "still open when the recorder stopped".
 *
 * Usage:
 *   node orderflow/callOutcomes.js                 # today, as a table
 *   node orderflow/callOutcomes.js 2026-10-12      # one day
 *   node orderflow/callOutcomes.js --json          # machine-readable
 */

const fs = require('fs');
const path = require('path');
const STATUTORY_BPS = 5.384;
const SLIPPAGE_BPS = {
  stop: 4.0,
  target: 1.0,
  session_close: 2.0,
  time_exit: 2.0
};

function calcItemizedToll(exitReason) {
  if (!Object.prototype.hasOwnProperty.call(SLIPPAGE_BPS, exitReason)) {
    throw new Error('calcItemizedToll: unknown exit reason ' + JSON.stringify(exitReason) +
      ' - refusing to assume the cheapest slippage. Add it to SLIPPAGE_BPS with a measured value.');
  }
  return STATUTORY_BPS + SLIPPAGE_BPS[exitReason];
}

// Where the day's record lives. Overridable ONLY so a test can drive a synthetic day in a temp
// directory instead of reading - or worse, writing - the live one (see setDataDir).
let DATA_DIR = path.join(__dirname, '..', '..', 'data', 'orderflow');
function setDataDir(dir) { DATA_DIR = dir; }

// One tick, and the engine's construction: a limit fills on a strictly traded-through price, so a
// quote that merely TOUCHES the limit does not fill. Kept in step with TICK_SIZE in sweepFvgLive.js.
const TICK_SIZE = 0.05;
// The engine's default anti-chase band (maxPremovePct). A setup that ran this far towards its target
// before the limit was reached is refused by the live engine, so it is not a trade here either.
const MAX_PREMOVE = 0.60;
const IST_MS = 5 * 3600 * 1000 + 30 * 60 * 1000;

const norm = (s) => String(s == null ? '' : s).replace(/-EQ$/i, '').toUpperCase();
const istTime = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 19);
const istDay = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10);
const istMinute = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// INTRADAY, SO IT MUST BE FLAT BY 15:30. A position still open when the session ends is squared off - and
// every intraday call in this engine is closed the same day, which is the whole reason one lot is a fair
// way to price these calls.
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
const round = (v, dp = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(dp));

function tapePath(date) { return path.join(DATA_DIR, `ticks-${date}.jsonl`); }
function callsPath(date) { return path.join(DATA_DIR, `daily_calls_${date}.json`); }
function signalsPath(date) { return path.join(DATA_DIR, `sweep-fvg-signals-${date}.jsonl`); }
function ledgerPath(date) { return path.join(DATA_DIR, `taken_${date}.json`); }
function evidencePath(date) {
  return path.join(__dirname, '..', '..', 'scratch', `evidence_${date}`, `daily_calls_${date}.json.as-overwritten-by-replay`);
}

/**
 * ONE PASS OVER THE TAPE. Only the symbols asked for are kept, in file order (the tape is written in
 * arrival order, which is the order the engine saw it in).
 */
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * ONE PASS OVER THE TAPE, CONTINUED WHERE IT LEFT OFF.
 *
 * The tape is append-only and, while the market is open, it grows every second - so a naive full read is
 * not merely slow, it is slow *on every poll*: a full parse of 337 MB measured 7.0 s of the server's
 * single thread, the same thread that has to keep capturing ticks. Reading FROM THE LAST OFFSET makes
 * each pass cost the bytes that arrived since the previous one (a few hundred KB), and the symbol filter
 * is a plain string test so JSON.parse runs only on the lines that matter.
 *
 * Two shapes of change are handled on purpose, because both happen in practice: a PARTIAL LAST LINE (a
 * writer mid-flush is not an error - the tail is re-read next time) and a file that SHRANK (truncated or
 * replaced), which resets the read rather than serving a stale prefix forever.
 */
const tapeState = new Map();   // date -> { path, offset, want:Set, bySymbol:Map, from, until }

function loadTape(date, symbols) {
  const file = tapePath(date);
  let st = tapeState.get(date);
  if (!st || st.path !== file) {
    st = { path: file, offset: 0, want: new Set(), bySymbol: new Map(), from: null, until: null };
    tapeState.set(date, st);
  }
  let added = false;
  for (const s of symbols.map(norm)) {
    if (!st.want.has(s)) { st.want.add(s); added = true; }
  }
  if (!fs.existsSync(file)) return { bySymbol: new Map(), coveredFrom: null, coveredUntil: null };
  let size;
  try { size = fs.statSync(file).size; } catch (e) { size = 0; }
  // A symbol asked for the first time: its ticks live in the bytes already read past, so the read starts
  // over. Rare (once per new call) and correct - filtering from the middle would silently lose them.
  if (added) { st.offset = 0; st.bySymbol = new Map(); st.from = null; st.until = null; }
  if (size < st.offset) { st.offset = 0; st.bySymbol = new Map(); st.from = null; st.until = null; }

  if (size > st.offset) {
    const len = size - st.offset;
    const buf = Buffer.allocUnsafe(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    let consume = text.length;
    let carry = '';
    if (!text.endsWith('\n')) {
      const i = text.lastIndexOf('\n');
      if (i === -1) { consume = 0; carry = text; } else { consume = i + 1; carry = text.slice(i + 1); }
    }
    const prefix = consume > 0 ? text.slice(0, consume) : '';
    if (prefix) {
      const symRe = st.want.size
        ? new RegExp('"s":"(' + [...st.want].map(escapeRe).join('|') + ')"')
        : null;
      for (const line of prefix.split('\n')) {
        if (!line || !symRe || !symRe.test(line)) continue;
        let rec;
        try { rec = JSON.parse(line); } catch (e) { continue; }
        if (rec.t) { if (st.from == null) st.from = rec.t; st.until = rec.t; }
        if (!rec.s || !(rec.p > 0)) continue;
        const s = norm(rec.s);
        if (!st.want.has(s)) continue;
        let arr = st.bySymbol.get(s);
        if (!arr) { arr = []; st.bySymbol.set(s, arr); }
        arr.push({ t: rec.t, p: rec.p });
      }
    }
    st.offset = size - Buffer.byteLength(carry, 'utf8');
  }
  return { bySymbol: st.bySymbol, coveredFrom: st.from, coveredUntil: st.until };
}

/** The side, from either record shape (engine calls carry `side`, the 1-minute engine's carry `action`). */
function sideOf(call) {
  const s = String(call.side || '').toUpperCase();
  if (s === 'SHORT' || s === 'LONG') return s;
  const a = String(call.action || '').toUpperCase();
  return a.includes('SELL') ? 'SHORT' : 'LONG';
}

/**
 * ONE CALL, ONE ANSWER. `ticks` are that symbol's tape rows; `armTs` is when the call was emitted -
 * ticks before it are not this call's business.
 */
function evaluateCall(call, ticks, opts = {}) {
  const side = sideOf(call);
  const entry = Number(call.limitEntry);
  const sl = Number(call.stopLoss);
  const tgt = Number(call.target);
  const shares = Number(call.shares) || Number(opts.shares) || 1;
  const armTs = Number(call.timestamp) || null;
  const rows = (ticks || []).filter((r) => (armTs == null || r.t >= armTs));

  const base = {
    id: call.id || null,
    symbol: norm(call.symbol),
    side,
    entry, stopLoss: sl, target: tgt,
    armedAtIST: call.timeIST || (armTs ? istTime(armTs) : null),
    shares
  };

  if (!rows.length) {
    return Object.assign(base, {
      state: 'NO_TAPE', filled: false, filledAtIST: null, exitPx: null, exitAtIST: null,
      grossPt: null, netInr: null, netBps: null, tollBps: null, lastPx: null, lastAtIST: null,
      note: 'no tape rows for this symbol at or after the call'
    });
  }

  // 1. FILL - or the engine's own refusal to fill.
  let fill = null;
  let refused = null;
  for (let i = 0; i < rows.length; i++) {
    const { t, p } = rows[i];
    if (side === 'SHORT') {
      const totalDist = entry - tgt;
      if (totalDist > 0 && (entry - p) >= MAX_PREMOVE * totalDist) {
        refused = { reason: 'CANCELLED_EXHAUSTION', p, t, atIST: istTime(t) };
        break;
      }
      if (p >= entry + TICK_SIZE) { fill = { px: entry, t }; break; }
    } else {
      const totalDist = tgt - entry;
      if (totalDist > 0 && (p - entry) >= MAX_PREMOVE * totalDist) {
        refused = { reason: 'CANCELLED_EXHAUSTION', p, t, atIST: istTime(t) };
        break;
      }
      if (p <= entry - TICK_SIZE) { fill = { px: entry, t }; break; }
    }
  }

  const last = rows[rows.length - 1];
  if (!fill) {
    return Object.assign(base, {
      state: refused ? refused.reason : 'NOT_FILLED',
      filled: false,
      filledAtIST: null,
      refusedAtIST: refused ? refused.atIST : null,
      refusedPx: refused ? +refused.p.toFixed(2) : null,
      exitPx: null, exitAtIST: null,
      grossPt: null, netInr: 0, netBps: null, tollBps: null,
      lastPx: +last.p.toFixed(2), lastAtIST: istTime(last.t), coveredUntilIST: istTime(last.t),
      note: refused
        ? `refused by the anti-chase rule at Rs ${refused.p} (60% of the way to target before the limit)`
        : `the limit was never traded through (closest tape print Rs ${last.p}) - no trade, Rs 0`
    });
  }

  // 2. TARGET OR STOP, first touch, exit booked AT the level (the engine's own booking).
  let exit = null;
  for (const { t, p } of rows) {
    if (t < fill.t) continue;
    if (side === 'SHORT') {
      if (p >= sl) { exit = { px: sl, t, reason: 'stop' }; break; }
      if (p <= tgt) { exit = { px: tgt, t, reason: 'target' }; break; }
    } else {
      if (p <= sl) { exit = { px: sl, t, reason: 'stop' }; break; }
      if (p >= tgt) { exit = { px: tgt, t, reason: 'target' }; break; }
    }
  }

  // SESSION CLOSE. While the market is open, a filled position with no target/stop hit is genuinely
  // OPEN and marked to the last print. After 15:30 IST it is not open any more - it was squared off,
  // which is what intraday means - so the day's record closes it instead of carrying an OPEN row into
  // the night and reporting a paper figure as if it were the day's result.
  const nowMs = Number(opts.nowMs) || Date.now();
  const sessionEnded = istMinute(nowMs) >= SESSION_CLOSE_MINUTE;
  const open = !exit && !sessionEnded;
  const exitPx = exit ? exit.px : last.p;
  const reason = exit ? exit.reason : 'session_close';
  const grossPt = side === 'SHORT' ? entry - exitPx : exitPx - entry;
  const tollBps = calcItemizedToll(reason);
  const netInr = grossPt * shares - entry * shares * (tollBps / 1e4);
  const grossBps = (grossPt / entry) * 1e4;

  return Object.assign(base, {
    state: exit ? (reason === 'target' ? 'WON' : 'LOST') : (sessionEnded ? 'SESSION_CLOSE' : 'OPEN'),
    filled: true,
    filledAtIST: istTime(fill.t),
    fillPx: +fill.px.toFixed(2),
    exitPx: +exitPx.toFixed(2),
    exitAtIST: istTime(exit ? exit.t : last.t),
    exitReason: reason,
    grossPt: round(grossPt),
    grossBps: round(grossBps, 1),
    tollBps: round(tollBps, 2),
    netBps: round(grossBps - tollBps, 1),
    netInr: round(netInr),
    lastPx: +last.p.toFixed(2),
    lastAtIST: istTime(last.t),
    coveredUntilIST: istTime(last.t),
    note: exit
      ? `filled at Rs ${fill.px.toFixed(2)} at ${istTime(fill.t)}, ${reason.toUpperCase()} at Rs ${exitPx.toFixed(2)}`
      : (sessionEnded
        ? `filled at Rs ${fill.px.toFixed(2)} at ${istTime(fill.t)}, squared off at the 15:30 close at Rs ${last.p}`
        : `filled at Rs ${fill.px.toFixed(2)} at ${istTime(fill.t)}, still open at Rs ${last.p} - ` +
          `Rs ${round(grossPt)} if closed there`)
  });
}

/**
 * CALLS THE LIVE ENGINE NEVER EMITTED. When a replay harness clobbers a day's record, its own calls are
 * kept as evidence next to the reconstruction (scratch/evidence_<date>/daily_calls_<date>.json
 * .as-overwritten-by-replay, written by scratch/repair_2026-10-12_journal.py). Any journal arm matching
 * one of those setups is labelled, and priced at zero: the research harness constructed the engine and
 * replayed synthetic bars through it, so the call was never tradeable by anyone. Read from the file
 * rather than hard-coded, so the rule follows the evidence instead of one day's symbols.
 */
function replayArtifacts(date) {
  const file = evidencePath(date);
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(arr)) {
      for (const c of arr) keys.add([norm(c.symbol), sideOf(c), Number(c.limitEntry), Number(c.stopLoss)].join('|'));
    }
  } catch (e) { /* unreadable evidence is a reason to show the calls, not to hide them */ }
  return keys;
}

/** Every SETUP_ARMED line that the day's calls file no longer holds (a restart or a second writer). */
function armsFromJournal(date) {
  const file = signalsPath(date);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    if (rec.type !== 'SETUP_ARMED') continue;
    out.push({
      // A journal line has no call id (the file that held one was overwritten), but a decision about it
      // still has to be storable and stable across runs - so the identity is the setup's own time and
      // symbol, which cannot change between reads.
      id: 'JRN-' + norm(rec.symbol) + '-' + Math.round(Number(rec.timestamp) / 1000),
      symbol: rec.symbol, side: rec.side, action: rec.side === 'SHORT' ? 'SELL' : 'BUY',
      limitEntry: rec.limitEntry, stopLoss: rec.stopLoss, target: rec.target,
      timestamp: rec.timestamp, timeIST: istTime(rec.timestamp), shares: 1,
      strategyType: rec.strategyType, source: 'journal'
    });
  }
  return out;
}

/**
 * THE DAY, RECONCILED. The calls file is the record; the journal is the append-only truth. Anything
 * the file lost is added back, labelled with where it came from, and de-duplicated by setup identity
 * (symbol + side + entry + stop) so the same call cannot be counted twice.
 */
function collectCalls(date) {
  const calls = [];
  let fileError = null;
  const file = callsPath(date);
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(arr)) for (const c of arr) calls.push(Object.assign({ source: 'file' }, c));
      else fileError = `${path.basename(file)} is not a JSON array`;
    } catch (e) {
      // An unreadable day file must NOT look like a day with no calls - the two are opposites and the
      // quieter one is the lie. The error travels with the payload so the page can say so.
      fileError = `${path.basename(file)} could not be parsed: ${e.message}`;
    }
  }
  const key = (c) => [norm(c.symbol), sideOf(c), Number(c.limitEntry), Number(c.stopLoss)].join('|');
  const seen = new Set(calls.map(key));
  const artifacts = replayArtifacts(date);
  let recovered = 0;
  let artifactCount = 0;
  for (const c of armsFromJournal(date)) {
    if (seen.has(key(c))) continue;
    seen.add(key(c));
    if (artifacts.has(key(c))) {
      c.source = 'replay-artifact';
      c.artifact = true;
      c.note = 'written by a replay harness, not by the live engine - shown for completeness, priced at zero';
      artifactCount++;
    } else {
      recovered++;
    }
    calls.push(c);
  }
  calls.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  return { calls, recovered, artifactCount, fileError };
}

// ---------------------------------------------------------------------------------------------
// THE TAKEN LEDGER. "Did I take this order?" is the one thing the tape cannot answer, and it is the
// only thing that changes the money: a call the user skipped is Rs 0 to them however well it did.
// Stored next to the day's record, keyed by call id, so the answer survives a page reload.
// ---------------------------------------------------------------------------------------------
function readLedger(date) {
  const file = ledgerPath(date);
  if (!fs.existsSync(file)) return { decisions: {} };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { decisions: (j && j.decisions) || {} };
  } catch (e) {
    return { decisions: {} };
  }
}

function writeLedger(date, id, state) {
  if (!id) throw new Error('writeLedger: a decision needs the call id it belongs to');
  if (state !== 'TAKEN' && state !== 'SKIPPED' && state !== null) {
    throw new Error(`writeLedger: state must be TAKEN, SKIPPED or null (clear), got ${JSON.stringify(state)}`);
  }
  const ledger = readLedger(date);
  if (state === null) delete ledger.decisions[id];
  else ledger.decisions[id] = { state, at: Date.now() };
  fs.writeFileSync(ledgerPath(date), JSON.stringify(ledger, null, 2), 'utf8');
  return ledger.decisions[id] || null;
}

/**
 * THE MONEY, SPLIT BY WHO DECIDED IT. `engineNet` prices every call the engine emitted (the signal
 * quality). `myNet` prices only what the user says they took (their actual result). `missedNet` is
 * what the skipped calls did - worth showing, because that is the number that argues with the
 * decision to skip.
 */
function summarize(results, ledger) {
  const decided = (ledger && ledger.decisions) || {};
  const sum = (rows) => round(rows.reduce((s, r) => s + (r.netInr || 0), 0)) || 0;
  // Replay artifacts are shown but never counted: nobody could have taken them.
  const real = results.filter((r) => !r.artifact);
  const taken = real.filter((r) => decided[r.id] && decided[r.id].state === 'TAKEN');
  const skipped = real.filter((r) => decided[r.id] && decided[r.id].state === 'SKIPPED');
  const undecided = real.filter((r) => !decided[r.id]);
  const filled = real.filter((r) => r.filled);
  const closed = real.filter((r) => r.state === 'WON' || r.state === 'LOST');
  return {
    calls: real.length,
    artifacts: results.length - real.length,
    filled: filled.length,
    notFilled: real.length - filled.length,
    won: real.filter((r) => r.state === 'WON').length,
    lost: real.filter((r) => r.state === 'LOST').length,
    open: real.filter((r) => r.state === 'OPEN').length,
    cancelled: real.filter((r) => r.state === 'CANCELLED_EXHAUSTION').length,
    sessionClosed: real.filter((r) => r.state === 'SESSION_CLOSE').length,
    engineNet: sum(real),
    engineNetClosedOnly: sum(closed),
    myNet: sum(taken),
    myCalls: taken.length,
    missedNet: sum(skipped),
    missedCalls: skipped.length,
    undecidedCalls: undecided.length
  };
}

// THE TAPE IS RE-READ ONLY WHEN IT CHANGES. Replaying a 300 MB day takes seconds, and the page asks
// for this every 15 seconds - so the verdicts are memoised against the identity of every file they
// depend on (tape, day record, journal, replay evidence). The LEDGER is never cached: it is tiny, it
// changes when the user clicks, and a stale decision is the one error this feature cannot make.
const cache = new Map();

function fileKey(p) {
  try { const st = fs.statSync(p); return st.size + '@' + Math.round(st.mtimeMs); } catch (e) { return 'missing'; }
}
function dayKey(date) {
  // DATA_DIR is part of the identity: two different directories can hold a same-named, same-sized day.
  return [DATA_DIR, fileKey(tapePath(date)), fileKey(callsPath(date)), fileKey(signalsPath(date)),
    fileKey(evidencePath(date))].join('|');
}

function evaluateDay(date = istDay(Date.now()), opts = {}) {
  const nowMs = Number(opts.nowMs) || Date.now();
  let hit = cache.get(date);
  if (!hit || hit.key !== dayKey(date)) {
    const { calls, recovered, artifactCount, fileError } = collectCalls(date);
    const tape = loadTape(date, calls.map((c) => c.symbol));
    const results = calls.map((c) => {
      const r = evaluateCall(c, tape.bySymbol.get(norm(c.symbol)), { nowMs });
      if (c.artifact) {
        r.artifact = true;
        r.note = c.note + ' · ' + (r.note || '');
        r.netInr = 0;   // a call nobody could take is worth nothing, however well it would have done
        r.grossPt = 0;
      }
      if (c.source) r.source = c.source;
      return r;
    });
    hit = {
      key: dayKey(date),
      tapeFromIST: tape.coveredFrom ? istTime(tape.coveredFrom) : null,
      tapeThroughIST: tape.coveredUntil ? istTime(tape.coveredUntil) : null,
      recovered, artifactCount, fileError, results
    };
    cache.set(date, hit);
  }
  const { recovered, artifactCount, fileError, results } = hit;
  const ledger = readLedger(date);
  return {
    date,
    tapeFromIST: hit.tapeFromIST,
    tapeThroughIST: hit.tapeThroughIST,
    recoveredFromJournal: recovered,
    replayArtifacts: artifactCount,
    fileError: fileError || null,
    results,
    ledger: ledger.decisions,
    summary: summarize(results, ledger),
    engineNet: results.reduce((s, r) => s + (r.netInr || 0), 0),
    myNet: results.filter((r) => ledger.decisions[r.id] && ledger.decisions[r.id].state === 'TAKEN')
      .reduce((s, r) => s + (r.netInr || 0), 0),
    skippedNet: results.filter((r) => ledger.decisions[r.id] && ledger.decisions[r.id].state === 'SKIPPED')
      .reduce((s, r) => s + (r.netInr || 0), 0),
    undecided: results.filter((r) => !r.artifact && !ledger.decisions[r.id]),
    decisions: ledger.decisions,
    calls: results
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function money(v) { return v == null ? '     -' : (v >= 0 ? '+' : '-') + 'Rs ' + Math.abs(v).toFixed(2); }
function pts(v) { return v == null ? '    -' : (v >= 0 ? '+' : '') + v.toFixed(2); }

function printTable(day) {
  const pad = (s, n) => String(s == null ? '' : s).padEnd(n);
  console.log(`\n${day.date} · tape ${day.tapeFromIST || '?'}..${day.tapeThroughIST || '?'} IST` +
    `${day.recoveredFromJournal ? ` · ${day.recoveredFromJournal} call(s) recovered from the journal` : ''}` +
    `${day.replayArtifacts ? ` · ${day.replayArtifacts} replay artifact(s) excluded from the money` : ''}` +
    `${!day.tapeThroughIST ? ' · NO TAPE' : ''}\n`);
  console.log(pad('TIME', 9) + pad('SYMBOL', 12) + pad('SIDE', 6) + pad('ENTRY', 10) + pad('STATUS', 20) +
    pad('FILLED', 10) + pad('GROSS', 8) + pad('NET', 11) + pad('MY PICK', 9) + 'WHAT HAPPENED');
  for (const r of day.results) {
    const pick = day.decisions[r.id] ? day.decisions[r.id].state : 'undecided';
    console.log(
      pad(r.armedAtIST, 9) + pad(r.symbol, 12) + pad(r.side, 6) + pad(r.entry.toFixed(2), 10) +
      pad(r.state, 20) + pad(r.filledAtIST || '-', 10) +
      pad(r.grossPt == null ? '-' : pts(r.grossPt), 8) + pad(money(r.netInr), 11) +
      pad(r.artifact ? 'artifact' : (pick === 'undecided' ? '-' : pick.toLowerCase()), 9) + (r.note || ''));
  }
  const s = day.summary;
  console.log(`\nCALLS ${s.calls}${s.artifacts ? ` (+${s.artifacts} artifact(s))` : ''} · filled ${s.filled} · never filled ${s.notFilled} · ` +
    `won ${s.won} · lost ${s.lost} · open ${s.open} · squared off at close ${s.sessionClosed} · anti-chase refused ${s.cancelled}`);
  console.log(`IF YOU TOOK EVERY CALL: ${money(s.engineNet)} over ${s.calls} calls`);
  console.log(`WHAT YOU MARKED TAKEN:  ${money(s.myNet)} over ${s.myCalls} call(s)` +
    (s.missedCalls ? ` · skipped ${s.missedCalls} call(s) worth ${money(s.missedNet)}` : '') +
    (s.undecidedCalls ? ` · ${s.undecidedCalls} still undecided` : ''));
  console.log('');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || istDay(Date.now());
  const day = evaluateDay(date);
  if (asJson) console.log(JSON.stringify(day, null, 2));
  else printTable(day);
}

module.exports = {
  TICK_SIZE, MAX_PREMOVE,
  STATUTORY_BPS, SLIPPAGE_BPS, calcItemizedToll,
  setDataDir, getDataDir: () => DATA_DIR,
  resetCache: () => { cache.clear(); tapeState.clear(); },
  loadTape, evaluateCall, collectCalls, armsFromJournal,
  readLedger, writeLedger, summarize, evaluateDay
};
