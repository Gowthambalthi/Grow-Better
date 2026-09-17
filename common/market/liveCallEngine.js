/**
 * common/market/liveCallEngine.js — Live Buy-Call engine for the GB Terminal.
 *
 * All automatic — no manual "start" required:
 *   1. DATA   — if the daily OHLCV store lacks today's candle, refetch the
 *               filtered universe (fetchUniverseOhlcv.js is resume-safe and
 *               only pulls missing/stale symbols).
 *   2. SCORE  — filterUniverse → scoreEngines → buildTradeTable pipeline,
 *               run in-process (they are plain scripts; invoked via child
 *               process to keep memory isolated).
 *   3. CALLS  — each confirmed fresh buy becomes a live call in
 *               data/live_calls.json: symbol, engine, frames, entry (LTP at
 *               call time), stop, targets, intraday Camarilla plan.
 *   4. TRACK  — every minute during market hours, active calls are checked
 *               against live LTP: SL / T1 / T2 / 35-bar time exit → status
 *               CLOSED with realized P&L; otherwise ACTIVE with unrealized.
 *   5. REPORT — today's totals: calls made, open P&L, realized P&L.
 *
 * Dedup: one open call per symbol. A symbol may re-ENTER only after its
 * previous call closed AND a new confirmed signal appears on a later day.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fetchLiveStockQuote } = require('./liveStockQuoteService');

const DATA = path.join(__dirname, '..', '..', 'data');
const CALLS_FILE = path.join(DATA, 'live_calls.json');
const TRADE_TABLE = path.join(DATA, 'trade_table_stocks.json');
const OHLCV = path.join(DATA, 'ohlcv');
const SCRIPTS = path.join(__dirname, '..', '..', 'scripts');

const TIME_EXIT_BARS = 35;

const state = {
  running: false,
  lastPipelineRun: null,   // Date ISO of last full data+score run
  lastPipelineSteps: null, // per-step ok/error for diagnosis
  lastScan: null,          // Date ISO of last minute scan
  pipelineRunning: false,
  timer: null,
  todayKey: null,          // 'YYYY-MM-DD' for per-day counters
  todayCalls: 0,
};

// ---------- persistence ----------

function loadCalls() {
  try { return JSON.parse(fs.readFileSync(CALLS_FILE, 'utf8')); }
  catch (_) { return { calls: [] }; }
}
function saveCalls(db) {
  fs.writeFileSync(CALLS_FILE, JSON.stringify(db));
}

function todayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// ---------- pipeline (data refresh + scoring) ----------

function runScript(script, args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(SCRIPTS, script), ...args],
      { cwd: path.join(SCRIPTS, '..'), timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

function hasAngelCreds() {
  return !!(process.env.ANGEL_API_KEY && process.env.ANGEL_CLIENT_CODE && process.env.ANGEL_TOTP_SECRET);
}

async function ohlcvStale() {
  // stale = trade table missing, or newest ohlcv file lacks today's (or
  // yesterday's, pre-market) candle
  try {
    const tt = JSON.parse(fs.readFileSync(TRADE_TABLE, 'utf8'));
    const ageOk = (Date.now() - fs.statSync(TRADE_TABLE).mtimeMs) < 24 * 3600e3;
    if (ageOk) return false;
  } catch (_) { /* missing → stale */ }
  return true;
}

async function runPipeline() {
  if (state.pipelineRunning) return { skipped: true };
  state.pipelineRunning = true;
  const steps = {};
  try {
    // 1. refresh candles if stale — only when Angel credentials exist.
    //    Without creds (e.g. Render free tier) skip fetching and serve the
    //    committed data instead of crashing the pipeline.
    const stale = await ohlcvStale();
    if (stale && hasAngelCreds()) {
      const r = await runScript('fetchUniverseOhlcv.js');
      steps.fetch = r.err ? 'error: ' + String(r.err.message || r.err).slice(0, 80) : 'ok';
    } else {
      steps.fetch = stale ? 'skipped (no Angel creds)' : 'fresh';
    }
    // 2. filter → score → trade table; each step independent so one failure
    //    doesn't stop the rest. CRITICAL: buildTradeTable must not run when
    //    scoring produced nothing (no candles on a fresh clone) — it would
    //    overwrite the committed trade table with an empty one.
    let r = await runScript('scoreEngines.js');
    steps.score = r.err ? 'error: ' + String(r.err.message || r.err).slice(0, 80) : 'ok';
    let scoresUsable = false;
    try {
      const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
      scoresUsable = es.scanned > 0 && Array.isArray(es.results) && es.results.length > 0;
    } catch (_) {}
    if (scoresUsable) {
      r = await runScript('buildTradeTable.js');
      steps.build = r.err ? 'error: ' + String(r.err.message || r.err).slice(0, 80) : 'ok';
    } else {
      steps.build = 'skipped (scores empty — keeping committed trade table)';
    }
    state.lastPipelineRun = new Date().toISOString();
    state.lastPipelineSteps = steps;
    return { ok: true, steps };
  } finally {
    state.pipelineRunning = false;
  }
}

// ---------- call creation ----------

async function scanForNewCalls() {
  let table;
  try { table = JSON.parse(fs.readFileSync(TRADE_TABLE, 'utf8')); }
  catch (_) { return { newCalls: 0, reason: 'no trade table yet' }; }

  const db = loadCalls();
  const openSyms = new Set(db.calls.filter(c => c.status === 'ACTIVE').map(c => c.symbol));
  const today = todayKey();
  if (state.todayKey !== today) { state.todayKey = today; state.todayCalls = 0; }

  let created = 0;
  for (const row of table.rows || []) {
    if (openSyms.has(row.symbol)) continue;                 // one open call per symbol
    if (db.calls.some(c => c.symbol === row.symbol && c.date === today)) continue; // one call/symbol/day

    const quote = await fetchLiveStockQuote(row.symbol);
    const ltp = quote && quote.ltp;
    if (!ltp || ltp <= 0) continue;

    db.calls.push({
      id: today + '-' + row.symbol,
      date: today,
      time: new Date().toISOString(),
      symbol: row.symbol,
      engine: row.engine,
      score: row.score,
      entry: ltp,                       // live price at call time
      stopLoss: row.stopLoss,
      target1: row.target1,
      target2: row.target2,
      confirm: row.confirm,
      intraday: row.intraday,
      status: 'ACTIVE',
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      pnlPct: null,
      barsHeld: 0,
      lastLtp: ltp,
    });
    created++;
    state.todayCalls++;
  }
  if (created) saveCalls(db);
  state.lastScan = new Date().toISOString();
  return { newCalls: created };
}

// ---------- tracking (minute tick) ----------

async function trackCalls() {
  const db = loadCalls();
  let changed = false;
  for (const c of db.calls) {
    if (c.status !== 'ACTIVE') continue;
    const quote = await fetchLiveStockQuote(c.symbol);
    const ltp = quote && quote.ltp;
    if (!ltp || ltp <= 0) continue;
    c.lastLtp = ltp;
    c.lastLtpAt = quote.lastUpdated;
    c.barsHeld += c.barsHeld === 0 ? 0 : 0; // bar counting happens daily below

    // exit checks — SL first (worst case), then targets
    if (ltp <= c.stopLoss) {
      c.status = 'CLOSED'; c.exitPrice = ltp; c.exitReason = 'SL';
    } else if (ltp >= c.target2) {
      c.status = 'CLOSED'; c.exitPrice = ltp; c.exitReason = 'TGT2';
    } else if (ltp >= c.target1) {
      // partial exit at T1: mark, keep trailing rest with stop→entry
      if (!c.t1Hit) { c.t1Hit = true; c.t1Price = ltp; }
      // stop moves to entry after T1
      if (ltp <= c.entry) { c.status = 'CLOSED'; c.exitPrice = c.entry; c.exitReason = 'T1-BE'; }
    }
    if (c.t1Hit && ltp <= c.entry && c.status === 'ACTIVE') {
      c.status = 'CLOSED'; c.exitPrice = c.entry; c.exitReason = 'T1-BE';
    }
    if (c.status === 'CLOSED') {
      c.closedAt = new Date().toISOString();
      c.pnlPct = +(((c.exitPrice - c.entry) / c.entry) * 100).toFixed(2);
      changed = true;
    } else {
      c.unrealPct = +(((ltp - c.entry) / c.entry) * 100).toFixed(2);
      changed = true;
    }
  }
  if (changed) saveCalls(db);
  return { tracked: true };
}

// daily bar count for time exit (runs at most once/day)
async function dailyTrack() {
  const db = loadCalls();
  let changed = false;
  for (const c of db.calls) {
    if (c.status !== 'ACTIVE') continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(OHLCV, c.symbol + '.json'), 'utf8'));
      const bars = j.candles.filter(x => x[0] >= c.date).length;
      c.barsHeld = bars;
      if (bars >= TIME_EXIT_BARS) {
        const lastC = j.candles[j.candles.length - 1][4];
        c.status = 'CLOSED'; c.exitPrice = lastC; c.exitReason = 'TIME';
        c.closedAt = new Date().toISOString();
        c.pnlPct = +(((c.exitPrice - c.entry) / c.entry) * 100).toFixed(2);
        changed = true;
      }
    } catch (_) {}
  }
  if (changed) saveCalls(db);
}

// ---------- reporting ----------

function todayReport() {
  const db = loadCalls();
  const today = todayKey();
  const todays = db.calls.filter(c => c.date === today);
  const open = todays.filter(c => c.status === 'ACTIVE');
  const closed = todays.filter(c => c.status === 'CLOSED');
  const sum = (a, k) => a.reduce((s, c) => s + (c[k] || 0), 0);
  return {
    date: today,
    totalCalls: todays.length,
    active: open.length,
    closed: closed.length,
    realizedPnlPct: +sum(closed, 'pnlPct').toFixed(2),
    unrealizedPnlPct: +sum(open, 'unrealPct').toFixed(2),
    wins: closed.filter(c => c.pnlPct > 0).length,
    losses: closed.filter(c => c.pnlPct <= 0).length,
    lastScan: state.lastScan,
    lastPipelineRun: state.lastPipelineRun,
  };
}

// ---------- public API ----------

async function tick(opts = {}) {
  // scan + track are cheap (quote fetches) and run every tick.
  // The heavy pipeline (candle fetch + scoring, minutes) runs only when the
  // data is stale AND at most once per hour — NOT on manual clicks. Pass
  // { forcePipeline: true } to override (used by the nightly refresh).
  const t0 = Date.now();
  const now = Date.now();
  const hourly = !state.lastPipelineRun || (now - new Date(state.lastPipelineRun).getTime()) > 3600e3;
  if (opts.forcePipeline || (hourly && await ohlcvStale().catch(() => false))) {
    await runPipeline().catch(() => {});
  }
  try {
    await scanForNewCalls();
    await trackCalls();
    if (state.todayKey !== todayKey()) await dailyTrack();
  } catch (_) {}
  return Date.now() - t0;
}

function start(intervalMs = 60000) {
  if (state.timer) return state.timer;
  state.todayKey = todayKey();
  state.timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
  // run one tick immediately (async, non-blocking)
  tick().catch(() => {});
  return state.timer;
}

function stop() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

function getCalls({ includeClosed = true } = {}) {
  const db = loadCalls();
  const calls = includeClosed ? db.calls : db.calls.filter(c => c.status === 'ACTIVE');
  // newest first
  calls.sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  return { calls, report: todayReport() };
}

function getCallDetail(symbol) {
  const db = loadCalls();
  const call = db.calls.filter(c => c.symbol === symbol).sort((a, b) => (b.time || '').localeCompare(a.time || ''))[0];
  if (!call) return null;
  // post-call candles (daily) from the call date onward
  let candles = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(OHLCV, symbol + '.json'), 'utf8'));
    candles = j.candles.filter(x => x[0] >= call.date).slice(-15)
      .map(x => ({ date: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] }));
  } catch (_) {}
  return { call, candles };
}

module.exports = { start, stop, tick, getCalls, getCallDetail, todayReport, runPipeline, state };
