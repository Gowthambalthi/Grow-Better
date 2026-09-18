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
const { fetchLiveStockQuote, fetchIntradaySeries } = require('./liveStockQuoteService');

const DATA = path.join(__dirname, '..', '..', 'data');
const CALLS_FILE = path.join(DATA, 'live_calls.json');
const TRADE_TABLE = path.join(DATA, 'trade_table_stocks.json');
const SIGNALS_FILE = path.join(DATA, 'live_signals.json');
const MIN_PRICE = 100;   // hard floor: no calls/signals on stocks under Rs 100
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

function isMarketOpen(d = new Date()) {
  // NSE session 09:15–15:30 IST, Mon–Fri (approx; ignores holidays)
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  const day = ist.getDay(); const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
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

// ---------- intraday velocity ----------

// Momentum/velocity score from the live 1-minute series (0-100):
//   60% last-15-min move % (current burst) + 40% volume burst vs day average.
// Higher = faster mover right NOW — what you asked to prioritize.
function velocityScore(series) {
  if (!series || !series.bars || series.bars.length < 20) return 0;
  const bars = series.bars;
  const last = bars[bars.length - 1].c;
  const n15 = bars[Math.max(0, bars.length - 16)].c;
  const burstPct = n15 > 0 ? ((last - n15) / n15) * 100 : 0;
  const vols = bars.map(b => b.v);
  const dayAvg = vols.reduce((s, v) => s + v, 0) / vols.length;
  const recentAvg = vols.slice(-15).reduce((s, v) => s + v, 0) / 15;
  const volBurst = dayAvg > 0 ? recentAvg / dayAvg : 1;
  // map: 0.3% burst ≈ 50, 1%+ ≈ 90+; vol 2x ≈ 70
  const pScore = Math.max(0, Math.min(100, 50 + burstPct * 40));
  const vScore = Math.max(0, Math.min(100, volBurst * 35));
  return +(0.6 * pScore + 0.4 * vScore).toFixed(1);
}

// ---------- rate of change (ROC) + per-minute BUY/SELL signals ----------

// ROC over n minutes from the 1-min series: % price change. Plus volume ratio
// (last-15-min avg vs day avg) and big-buyer proxy: where price sits vs the
// day's VWAP. Volume-weighted price tells who is in control:
//   price > VWAP with rising volume = big buyers holding / accumulating
//   price falling below VWAP on high volume = big buyers distributing (SELL)
//   price flat around VWAP = neutral / absorption
function computeRoc(series) {
  if (!series || !series.bars || series.bars.length < 20) return null;
  const bars = series.bars;
  const last = bars[bars.length - 1].c;
  const rocN = (n) => {
    if (bars.length <= n) return null;
    const ref = bars[bars.length - 1 - n].c;
    return ref > 0 ? +(((last - ref) / ref) * 100).toFixed(2) : null;
  };
  const roc5 = rocN(5), roc15 = rocN(15);
  const vols = bars.map(b => b.v);
  const dayAvg = vols.reduce((s, v) => s + v, 0) / vols.length;
  const recentAvg = vols.slice(-15).reduce((s, v) => s + v, 0) / 15;
  // VWAP over the day so far
  let pv = 0, vv = 0;
  for (const b of bars) { pv += b.c * b.v; vv += b.v; }
  const vwap = vv > 0 ? pv / vv : last;
  // last 15-min VWAP vs day VWAP: short-term money flow direction
  let pv15 = 0, vv15 = 0;
  for (const b of bars.slice(-15)) { pv15 += b.c * b.v; vv15 += b.v; }
  const vwap15 = vv15 > 0 ? pv15 / vv15 : last;
  return {
    roc5, roc15,
    volX: dayAvg > 0 ? +(recentAvg / dayAvg).toFixed(2) : 1,
    vwap: +vwap.toFixed(2),
    vwapDrift: vwap > 0 ? +(((vwap15 - vwap) / vwap) * 100).toFixed(2) : 0,
  };
}

// Buyer-structure read from price/volume/VWAP (swing volume logic compressed
// to intraday):
function buyerStructure(roc, ltp) {
  if (!roc || ltp == null) return { structure: 'UNKNOWN', note: 'no data' };
  const aboveVwap = ltp > roc.vwap;
  if (aboveVwap && roc.vwapDrift > 0.05 && roc.volX >= 1.2) return { structure: 'BIG BUYERS HOLDING', note: 'price above VWAP, short-term flow rising on volume' };
  if (aboveVwap && roc.vwapDrift <= 0.05) return { structure: 'BUYERS NEUTRAL', note: 'above VWAP but short-term flow flat' };
  if (!aboveVwap && roc.vwapDrift < -0.05 && roc.volX >= 1.2) return { structure: 'BIG SELLING', note: 'below VWAP, flow falling on volume - distribution' };
  if (!aboveVwap) return { structure: 'SMALL SELLING', note: 'below VWAP, mild flow' };
  return { structure: 'NEUTRAL', note: 'at VWAP' };
}

// Signal decision from ROC momentum + buyer structure:
//   BUY  = positive 5-min ROC accelerating with volume AND buyers in control
//   SELL = momentum flipping negative, big selling structure, or stop breach
function rocSignal(roc, ltp, stopLoss) {
  if (!roc || ltp == null) return { signal: 'HOLD', reason: 'no data' };
  const { roc5, roc15, volX } = roc;
  if (stopLoss != null && ltp <= stopLoss) return { signal: 'SELL', reason: 'at stop loss' };
  if (roc5 < -0.10 && roc15 < 0) return { signal: 'SELL', reason: 'momentum flipped down (ROC5 ' + roc5 + '%, ROC15 ' + roc15 + '%)' };
  if (roc5 > 0.10 && roc15 > 0 && volX >= 1.1) return { signal: 'BUY', reason: 'ROC accelerating up (ROC5 +' + roc5 + '%, ROC15 +' + roc15 + '%, vol ' + volX + 'x)' };
  if (roc5 > 0.25 && roc15 >= 0) return { signal: 'BUY', reason: 'strong price burst (ROC5 +' + roc5 + '%)' };
  return { signal: 'HOLD', reason: 'flat (ROC5 ' + (roc5 == null ? '-' : roc5) + '%)' };
}

// Minute scan across the whole scored universe (price >= MIN_PRICE): computes
// ROC + buyer structure + BUY/SELL/HOLD for each and persists the board.
async function scanSignals(candidatesOverride) {
  let candidates = candidatesOverride;
  if (!candidates) {
    candidates = [];
    try {
      const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
      for (const r of es.results || []) candidates.push({ symbol: r.symbol, engine: r.winningEngine, score: r.engineRate });
    } catch (_) {}
  }
  if (!candidates.length) return { signals: 0 };

  const db = loadCalls();
  const openBySym = {};
  for (const c of db.calls) if (c.status === 'ACTIVE') openBySym[c.symbol] = c;

  const CONC = 14;
  const out = [];
  const now = new Date().toISOString();
  for (let i = 0; i < candidates.length; i += CONC) {
    const batch = candidates.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async c => {
      const series = await fetchIntradaySeries(c.symbol);
      if (!series) return null;
      const ltp = series.last;
      if (ltp == null || ltp < MIN_PRICE) return null;   // price floor
      const roc = computeRoc(series);
      const struct = buyerStructure(roc, ltp);
      const openCall = openBySym[c.symbol];
      const sig = rocSignal(roc, ltp, openCall ? openCall.stopLoss : null);
      return { symbol: c.symbol, engine: c.engine, score: c.score, ltp,
        roc5: roc ? roc.roc5 : null, roc15: roc ? roc.roc15 : null, volX: roc ? roc.volX : null,
        vwap: roc ? roc.vwap : null, vwapDrift: roc ? roc.vwapDrift : null,
        structure: struct.structure, structNote: struct.note,
        signal: sig.signal, reason: sig.reason,
        inPosition: !!openCall, entry: openCall ? openCall.entry : null,
        stopLoss: openCall ? openCall.stopLoss : null,
        time: now };
    }));
    out.push(...res.filter(Boolean));
  }
  out.sort((a, b) => (b.roc5 || -99) - (a.roc5 || -99));
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ generatedAt: now, marketOpen: isMarketOpen(), signals: out }));
  return { signals: out.length, buys: out.filter(s => s.signal === 'BUY').length, sells: out.filter(s => s.signal === 'SELL').length };
}

const MIN_CALL_GAP_MIN = 30;    // same symbol can re-call after 30 min
const MAX_CALLS_PER_TICK = 8;   // cap per minute tick

async function scanForNewCalls() {
  // Candidate pool: the confirmed trade table (4-frame gate) PLUS the wider
  // engine-score list, so minute scans can surface fresh movers beyond the
  // few daily fresh buys.
  let candidates = [];
  try {
    const tt = JSON.parse(fs.readFileSync(TRADE_TABLE, 'utf8'));
    candidates = (tt.rows || []).map(r => ({ symbol: r.symbol, engine: r.engine, score: r.score,
      stopLoss: r.stopLoss, target1: r.target1, target2: r.target2, confirm: r.confirm, intraday: r.intraday, source: 'FRESH BUY' }));
  } catch (_) {}
  try {
    const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
    const known = new Set(candidates.map(c => c.symbol));
    for (const r of es.results || []) {
      if (known.has(r.symbol)) continue;
      // wider pool: any engine >= 7, not trapped — the confirmed table is a subset
      const i = r.indicators || {};
      if ((r.engineRate || 0) >= 7 && !(i.rsi14 > 80 || i.volRatio < 0.8 || i.adx14 < 18)) {
        candidates.push({ symbol: r.symbol, engine: r.engine, score: r.engineRate, source: 'ENGINE', i });
      }
    }
  } catch (_) {}
  if (!candidates.length) return { newCalls: 0, reason: 'no candidates' };

  const db = loadCalls();
  const openSyms = new Set(db.calls.filter(c => c.status === 'ACTIVE').map(c => c.symbol));
  const today = todayKey();
  if (state.todayKey !== today) { state.todayKey = today; state.todayCalls = 0; }

  // measure live velocity for every candidate (parallel, capped)
  const CONC = 12;
  const scored = [];
  for (let i = 0; i < candidates.length; i += CONC) {
    const batch = candidates.slice(i, i + CONC);
    const res = await Promise.all(batch.map(async c => {
      const series = await fetchIntradaySeries(c.symbol);
      const q = await fetchLiveStockQuote(c.symbol);
      return { ...c, ltp: q && q.ltp, vel: velocityScore(series), series };
    }));
    scored.push(...res);
  }

  // rank by velocity — fastest movers first
  scored.sort((a, b) => b.vel - a.vel);

  let created = 0;
  for (const c of scored) {
    if (created >= MAX_CALLS_PER_TICK) break;
    if (!c.ltp || c.ltp <= 0) continue;
    if (c.vel < 35) continue;                       // moving too slow — skip
    if (openSyms.has(c.symbol)) continue;           // one open call per symbol
    // re-call gap: same symbol not re-called within 30 min of ANY prior call
    const lastCall = db.calls.filter(x => x.symbol === c.symbol).sort((a, b) => (b.time || '').localeCompare(a.time || ''))[0];
    if (lastCall && (Date.now() - new Date(lastCall.time).getTime()) < MIN_CALL_GAP_MIN * 60000) continue;

    // stop/target: confirmed table levels when present, else velocity-scan defaults (2x/4x of 2% risk)
    // INTRADAY levels: tight stop (max 0.6% below entry), T1 +2R, T2 +4R.
    let stop = c.stopLoss && (c.ltp - c.stopLoss) / c.ltp <= 0.01 ? c.stopLoss : +(c.ltp * 0.994).toFixed(2);
    stop = Math.max(stop, +(c.ltp * 0.994).toFixed(2)); // never wider than 0.6%
    const risk = c.ltp - stop;
    db.calls.push({
      id: today + '-' + c.symbol + '-' + Date.now(),
      date: today,
      time: new Date().toISOString(),
      symbol: c.symbol,
      engine: c.engine,
      score: c.score,
      velocity: c.vel,
      source: c.source,
      entry: c.ltp,
      stopLoss: stop,
      target1: +(c.ltp + risk * 2).toFixed(2),
      target2: +(c.ltp + risk * 4).toFixed(2),
      confirm: c.confirm || null,
      intraday: c.intraday || null,
      status: 'ACTIVE',
      closedAt: null,
      exitPrice: null,
      exitReason: null,
      pnlPct: null,
      barsHeld: 0,
      lastLtp: c.ltp,
    });
    created++;
    state.todayCalls++;
    openSyms.add(c.symbol);
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
  // The heavy pipeline runs ONLY when the daily candle data is genuinely
  // stale (once per day effectively) — never on an hourly loop. On hosts
  // without Angel creds (Render) fetch is skipped inside runPipeline, so
  // staleness would stay true forever and re-run every hour for nothing.
  const hourly = !state.lastPipelineRun || (now - new Date(state.lastPipelineRun).getTime()) > 3600e3;
  if (opts.forcePipeline || (hourly && hasAngelCreds() && await ohlcvStale().catch(() => false))) {
    await runPipeline().catch(() => {});
  }
  try {
    if (isMarketOpen()) {
      await scanForNewCalls();
      await scanSignals();          // per-minute ROC + buyer-structure board      // velocity-ranked fresh calls, throttled per symbol
      await trackCalls();
    }
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

function getSignals() {
  try { return JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8')); }
  catch (_) { return { generatedAt: null, signals: [] }; }
}

module.exports = { start, stop, tick, getCalls, getCallDetail, todayReport, runPipeline, scanForNewCalls, scanSignals, getSignals, isMarketOpen, state };
