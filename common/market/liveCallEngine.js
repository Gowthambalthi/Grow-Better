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
const { fetchLiveStockQuote, fetchIntradaySeries, fetchAngelQuotes } = require('./liveStockQuoteService');
const { readCandleFrames } = require('./candleFrames');
const { calcCamarillaPivots, camarillaContext } = require('./camarilla');

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
  // Live window: 09:15-15:00 IST. Nothing after 3 PM — the last half hour
  // is choppy square-off tape, no fresh entries or signals there.
  return day >= 1 && day <= 5 && mins >= 555 && mins < 900;
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

async function runPipeline(opts = {}) {
  if (state.pipelineRunning) return { skipped: true };
  state.pipelineRunning = true;
  const steps = {};
  try {
    // 1. refresh candles if stale — only when Angel credentials exist.
    //    Without creds (e.g. Render free tier) skip fetching and serve the
    //    committed data instead of crashing the pipeline.
    const stale = opts.forcePipeline ? true : await ohlcvStale();
    if (stale) {
      const r = await runScript('fetchUniverseOhlcv.js');
      steps.fetch = r.err ? 'error: ' + String(r.err.message || r.err).slice(0, 80) : 'ok';
    } else {
      steps.fetch = 'fresh';
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
  // Fast frames (1m/3m) read the immediate move; 5m/15m carry the trend.
  const roc1 = rocN(1), roc3 = rocN(3);
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
  // 5-bar VWAP: fastest confirmation frame
  let pv5 = 0, vv5 = 0;
  for (const b of bars.slice(-5)) { pv5 += b.c * b.v; vv5 += b.v; }
  const vwap5 = vv5 > 0 ? pv5 / vv5 : last;
  // volume ROC: rate of change of VOLUME (vol now vs 5 bars ago)
  const volNow = vols[vols.length - 1];
  const volPrev5 = vols[vols.length - 6] || 0;
  const volRoc = volPrev5 > 0 ? +(((volNow - volPrev5) / volPrev5) * 100).toFixed(1) : null;
  // volume-at-price position: where the LTP sits in the last-5-min range —
  // near the high = buyers lifting the offer (real demand), mid/low = absorption
  const last5 = bars.slice(-5);
  let hi5 = -Infinity, lo5 = Infinity;
  for (const b of last5) { if (b.c > hi5) hi5 = b.c; if (b.c < lo5) lo5 = b.c; }
  const posInRange = hi5 > lo5 ? +(((last - lo5) / (hi5 - lo5)) * 100).toFixed(0) : 50;
  // VOLUME-AT-PRICE on the signal bar: where did the biggest volume of the
  // last 5 bars trade, and at which end of that bar's range? 3y/15-min
  // backtest (419k bars): heavy volume closing in the TOP 20% of its bar
  // averages -9.3bps next bar (bull trap — 59% win fading it), while heavy
  // volume closing in the BOTTOM 20% averages +3.5bps next bar (selling gets
  // absorbed). So: heavy-at-top = DANGER for longs, heavy-at-bottom = bounce
  // fuel. Light volume = no information either way.
  let volAtPrice = 'NONE';
  {
    let hv = -Infinity, hb = null;
    for (const b of last5) { if (b.v > hv) { hv = b.v; hb = b; } }
    const hbRange = (hb.h != null ? hb.h : hb.c) - (hb.l != null ? hb.l : hb.c);
    const hbPos = hbRange > 0 ? ((hb.c - (hb.l != null ? hb.l : hb.c)) / hbRange) : 0.5;
    const hbVolRel = dayAvg > 0 ? hv / dayAvg : 0;
    if (hbVolRel >= 1.5) volAtPrice = hbPos >= 0.8 ? 'HEAVY-TOP' : hbPos < 0.2 ? 'HEAVY-BOT' : 'HEAVY-MID';
    else volAtPrice = 'LIGHT';
  }
  return {
    roc1, roc3, roc5, roc15,
    volX: dayAvg > 0 ? +(recentAvg / dayAvg).toFixed(2) : 1,
    volRoc, posInRange, volAtPrice,
    // Multi-timeframe VWAP stack + previous-day levels (confirmation context,
    // NOT hard gates): 5-bar, 15-bar and day VWAPs; PDH/PDL/PDC.
    vwap5, vwap15,
    vwapStack: (vwap5 != null && vwap15 != null)
      ? (last > vwap5 && last > vwap15 && last > vwap) ? 'ABOVE ALL'
        : (last < vwap5 && last < vwap15 && last < vwap) ? 'BELOW ALL' : 'MIXED'
      : null,
    dayHigh: series.dayHigh || null,
    dayLow: (series.dayLow != null && series.dayLow !== Infinity) ? series.dayLow : null,
    posVsPD: (series.dayHigh && series.dayLow != null && series.dayLow !== Infinity)
      ? (last > series.dayHigh ? 'AT DAY HIGH' : last < series.dayLow ? 'AT DAY LOW' : 'INSIDE RANGE')
      : null,
    vwap: +vwap.toFixed(2),
    vwap5: +vwap5.toFixed(2),
    vwap15: +vwap15.toFixed(2),
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

// Signal decision from ROC momentum + buyer structure + the fast tick window:
//   BUY  = the move is STARTING now (20s window up, 5-min not yet extended)
//   LATE = the move has already happened (5m/15m extended) — buying here is
//          buying the top of someone else's move. This is the rule that stops
//          the table reading "all green" on stocks that already ran.
//   SELL = momentum flipping negative, big selling structure, or stop breach
function rocSignal(roc, ltp, stopLoss, inPosition, tick) {
  if (!roc || ltp == null) return { signal: 'HOLD', reason: 'no data' };
  const { roc5, roc15, volX } = roc;
  if (inPosition && stopLoss != null && ltp <= stopLoss) return { signal: 'EXIT', reason: 'at stop loss' };
  if (roc5 < -0.10 && roc15 < 0) return { signal: 'SHORT', reason: 'momentum flipped down (ROC5 ' + roc5 + '%, ROC15 ' + roc15 + '%) - breakdown setup' };
  const s20 = tick && tick.s20 != null ? tick.s20 : null;
  // ALREADY-MOVED veto runs before any BUY: past these levels the run is history.
  if (roc5 >= 0.80 || roc15 >= 1.50) {
    return { signal: 'LATE', reason: 'already moved (ROC5 +' + roc5 + '%) - buying now is chasing, wait for a pullback' };
  }
  // FRESH TURN: when tick data exists, the 20-second window must also be up —
  // that is "happening now" instead of "already ran".
  const freshOk = s20 == null ? true : s20 > 0.03;
  if (roc5 > 0.05 && roc15 > 0 && volX >= 1.1 && freshOk) {
    return { signal: 'BUY', reason: 'fresh turn: ROC5 +' + roc5 + '%, 20s ' + (s20 == null ? 'n/a' : s20 + '%') + ', vol ' + volX + 'x' };
  }
  if (s20 != null && s20 >= 0.25 && roc5 > 0) return { signal: 'BUY', reason: '20s burst +' + s20 + '% with the 5m still up' };
  if (roc5 > 0.10 && roc15 > 0 && !freshOk) return { signal: 'HOLD', reason: 'late entry refused: 5m up but the 20s has stalled (' + s20 + '%)' };
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
  // Angel quote rate budget: ~200 symbols per tick (25s), rotating across ticks
  // so every stock gets a fresh authed quote at least every ~5 minutes.
  const quoteBudget = 200;
  const allSyms = candidates.map(c => c.symbol);
  if (!state._quoteCursor) state._quoteCursor = 0;
  const start = state._quoteCursor % allSyms.length;
  const quoted = new Set();
  for (let k = 0; k < Math.min(quoteBudget, allSyms.length); k++) quoted.add(allSyms[(start + k) % allSyms.length]);
  state._quoteCursor = (start + quoteBudget) % Math.max(1, allSyms.length);
  let quoteMap = {};
  if (hasAngelCreds()) {
    try { quoteMap = await fetchAngelQuotes([...quoted]); } catch (_) {}
  }
  // Fast tick windows (10s / 20s / 30s) from the Angel tick board — the freshest
  // read on what is moving RIGHT NOW. A 5m/15m ROC is already history by the
  // time it looks strong, which is what made the board read "all green".
  let tickMap = {};
  try {
    const tb = tickBoard.getBoard();
    for (const r of tb.stocks || []) {
      if (r.s10 != null || r.s20 != null || r.s30 != null) tickMap[r.symbol] = r;
    }
  } catch (_) {}
  for (let i = 0; i < candidates.length; i += CONC) {
    const batch = candidates.slice(i, i + CONC);
    // use the pre-fetched batch quotes (no per-batch Angel call — rate budget)
    const batchQuotes = quoteMap;
    const res = await Promise.all(batch.map(async c => {
      const series = await fetchIntradaySeries(c.symbol);
      if (!series) return null;
      const ltp = series.last;
      if (ltp == null || ltp < MIN_PRICE) return null;   // price floor
      // LIVE-DATA RULE: during market hours, refuse to signal on bars older
      // than 5 minutes — that is dead data for intraday, not late data.
      if (isMarketOpen() && series.lastBarAgeSec != null && series.lastBarAgeSec > 300) return null;
      const roc = computeRoc(series);
      const candlesMtf = readCandleFrames(series.bars);   // 3/5/15/30-min candle structure
      const struct = buyerStructure(roc, ltp);
      const openCall = openBySym[c.symbol];
      const tick = tickMap[c.symbol] || null;
      const sig = rocSignal(roc, ltp, openCall ? openCall.stopLoss : null, !!openCall, tick);
      // opening validation (09:15-09:20 mandatory; revalidated after) + new-buyer
      const q = batchQuotes[c.symbol] || {};
      const open = openingCheck(series, q, series.prevClose || q.close || 0);
      const buyer = newBuyerCheck(q);
      const valid = open.ok;                 // failed = INVALID: no BUY recommendation
      let signal = sig.signal;
      const volRocOk = roc && (roc.volRoc == null || roc.volRoc >= -10);
      const posOk = roc && roc.posInRange != null ? roc.posInRange >= 40 : true;
      // VOLUME-AT-PRICE gate (3y-validated): heavy volume closing at the TOP
      // of its bar is a bull trap (-9.3bps next bar, 59% win fading) — no BUY.
      // Heavy-at-bottom is fine (absorption, bounce fuel). Light = neutral.
      const vapOk = !(roc && roc.volAtPrice === 'HEAVY-TOP');
      // MTF candle gate (STRICT): micro TFs (1m/2m) must both be UP-trending,
      // fast TFs (3m/5m) UP or UP-LEAN, and slow TFs (15m/30m) not DOWN —
      // six timeframes of structure must agree before a BUY.
      const ct = candlesMtf ? { m1: candlesMtf.frames.m1?.trend, m2: candlesMtf.frames.m2?.trend, m3: candlesMtf.frames.m3?.trend, m5: candlesMtf.frames.m5?.trend, m15: candlesMtf.frames.m15?.trend, m30: candlesMtf.frames.m30?.trend } : {};
      const microUp = ct.m1 === 'UP' && (ct.m2 === 'UP' || ct.m2 === 'UP-LEAN');
      const fastUp = (ct.m3 === 'UP' || ct.m3 === 'UP-LEAN') && (ct.m5 === 'UP' || ct.m5 === 'UP-LEAN');
      const slowOk = ct.m15 !== 'DOWN' && ct.m30 !== 'DOWN';
      const mtfOk = microUp && fastUp && slowOk;
      if (signal === 'BUY' && (!valid || !buyer.ok)) signal = 'WAIT';
      if (signal === 'BUY' && !volRocOk) signal = 'WAIT';
      if (signal === 'BUY' && !posOk) signal = 'WAIT';
      if (signal === 'BUY' && !vapOk) signal = 'WAIT';
      if (signal === 'BUY' && !mtfOk) signal = 'WAIT';
      return { symbol: c.symbol, engine: c.engine, score: c.score, ltp,
        s10: tick ? tick.s10 : null, s20: tick ? tick.s20 : null, s30: tick ? tick.s30 : null,
        roc1: roc ? roc.roc1 : null, roc3: roc ? roc.roc3 : null,
        roc5: roc ? roc.roc5 : null, roc15: roc ? roc.roc15 : null, volX: roc ? roc.volX : null,
        volRoc: roc ? roc.volRoc : null, posInRange: roc ? roc.posInRange : null,
        volAtPrice: roc ? roc.volAtPrice : null,
        candlesAgree: candlesMtf ? candlesMtf.agree : null,
        candlePattern: candlesMtf && candlesMtf.frames.m5 ? candlesMtf.frames.m5.pattern : null,
        candleTrend: candlesMtf ? { m1: candlesMtf.frames.m1?.trend, m2: candlesMtf.frames.m2?.trend, m3: candlesMtf.frames.m3?.trend, m5: candlesMtf.frames.m5?.trend, m15: candlesMtf.frames.m15?.trend, m30: candlesMtf.frames.m30?.trend } : null,
        swingAgree: candlesMtf ? candlesMtf.swingAgree : null,
        vwap5: roc ? roc.vwap5 : null, vwap15: roc ? roc.vwap15 : null,
        vwapStack: roc ? roc.vwapStack : null,
        dayHigh: roc ? roc.dayHigh : null, dayLow: roc ? roc.dayLow : null,
        posVsPD: roc ? roc.posVsPD : null,
        vwap: roc ? roc.vwap : null, vwapDrift: roc ? roc.vwapDrift : null,
        structure: struct.structure, structNote: struct.note,
        volume: q.volume || null, totBuy: q.totBuy || null, totSell: q.totSell || null,
        dayValue: q.volume && q.ltp ? Math.round(q.volume * q.ltp) : null,
        openCheck: valid ? 'OK' : 'INVALID', openReason: open.reason,
        newBuyer: buyer.ok, buyerReason: buyer.reason,
        signal, reason: signal === 'WAIT' ? (!valid ? 'INVALID: ' + open.reason : !buyer.ok ? 'WAIT: ' + buyer.reason : !volRocOk ? 'WAIT: volume drying (' + roc.volRoc + '%)' : !vapOk ? 'WAIT: heavy volume at bar top (bull trap risk)' : !mtfOk ? 'WAIT: candles not aligned (1m+2m up, 3m/5m up-lean, 15m/30m not down — got ' + [ct.m1, ct.m2, ct.m3, ct.m5, ct.m15, ct.m30].join('/') + ')' : 'WAIT: mid-range close (' + roc.posInRange + '%, need top 40%)') : sig.reason,
        inPosition: !!openCall, entry: openCall ? openCall.entry : null,
        stopLoss: openCall ? openCall.stopLoss : null,
        time: now };
    }));
    out.push(...res.filter(Boolean));
  }
  // Rank by what is moving NOW: the 20-second tick window first; names without
  // ticks follow, ordered by the 5m ROC as before.
  out.sort((a, b) => {
    const at = a.s20 != null, bt = b.s20 != null;
    if (at && bt) return b.s20 - a.s20;
    if (at !== bt) return at ? -1 : 1;
    return (b.roc5 || -99) - (a.roc5 || -99);
  });
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify({ generatedAt: now, marketOpen: isMarketOpen(), signals: out }));
  return { signals: out.length, buys: out.filter(s => s.signal === 'BUY').length, waits: out.filter(s => s.signal === 'WAIT').length, sells: out.filter(s => s.signal === 'SHORT' || s.signal === 'SELL').length };
}


// ---------- real-time movers board (strictly 09:15-15:15 IST) ----------
// UPGRADED: market hours run on Angel One TICKS (tickBoard.js, full universe,
// no delay). Yahoo batch board (moversBoard.js) serves OFF-HOURS viewing only.
const moversBoard = require('./moversBoard');
const tickBoard = require('./tickBoard');

function computeMove(series) {
  if (!series || !series.bars || series.bars.length < 6) return null;
  const bars = series.bars;
  const last = bars[bars.length - 1].c;
  const prev1 = bars[bars.length - 2].c;
  const prev2 = bars[bars.length - 3] ? bars[bars.length - 3].c : null;
  const prev5 = bars[bars.length - 6] ? bars[bars.length - 6].c : null;
  const prevClose = series.prevClose || 0;
  const m1 = prev1 > 0 ? ((last - prev1) / prev1) * 100 : 0;
  const m2 = prev2 > 0 ? ((last - prev2) / prev2) * 100 : null;
  const m5 = prev5 > 0 ? ((last - prev5) / prev5) * 100 : null;
  const mDay = prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : null;
  // direction trail: last 5 one-min closes up/down pattern
  const trail = [];
  for (let i = Math.max(1, bars.length - 5); i < bars.length; i++) {
    trail.push(bars[i].c >= bars[i - 1].c ? 'up' : 'down');
  }
  return { ltp: last, m1: +m1.toFixed(2), m2: m2 == null ? null : +m2.toFixed(2), m5: m5 == null ? null : +m5.toFixed(2), mDay: mDay == null ? null : +mDay.toFixed(2), trail };
}

async function scanMovers() {
  // Angel tick board owns the market-hours board (no delay). Yahoo NEVER
  // serves the board — not even off-hours. Its ONLY role is the scheduled
  // 45-min pool job (dry/active classification) inside tickBoard.
  if (tickBoard.isMarketOpenNow()) {
    if (!fs.existsSync(path.join(DATA, 'live_tick_movers.json'))) {
      await tickBoard.start().catch(() => {});   // lazy boot if server gate missed
    }
    if (fs.existsSync(path.join(DATA, 'live_tick_movers.json'))) {
      await tickBoard.buildBoard().catch(() => {});
      return { source: 'angel-ticks' };
    }
    return { source: 'angel-pending' };
  }
  return { source: 'closed', closed: true };   // off-hours: last tick snapshot persists on disk
}

function getMovers({ onlyMovers = false, minMove = 0 } = {}) {
  return moversBoard.getMovers({ onlyMovers, minMove });
}


// ---------- opening validation window + new-buyer recommendation ----------

// Session pre-check (09:15-09:20): the first 5-min bar must CONFIRM —
//   price up vs prev close, volume healthy, traded value not negligible.
//   Stocks that fail are marked INVALID and get NO buy recommendation until
//   a later tick re-validates them.
function istMinutesNow(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  return ist.getHours() * 60 + ist.getMinutes();
}

// Validate one stock's opening 5-min bar. quote = Angel quote (volume/totBuy).
function openingCheck(series, quote, prevClose) {
  if (!series || !series.bars || series.bars.length < 1) return { ok: false, reason: 'no bars yet' };
  const first = series.bars[0];
  const priceOk = prevClose > 0 ? first.c >= prevClose : true;      // not gapping down hard
  const volOk = (quote.volume || 0) > 0;                            // real trading happened
  const value = first.c * (quote.volume || 0);
  const valueOk = value > 5e6;                                      // >= Rs50L traded: real participation
  const reasons = [];
  if (!priceOk) reasons.push('price below prev close');
  if (!volOk) reasons.push('no volume');
  if (!valueOk) reasons.push('traded value too low');
  const gapPct = prevClose > 0 ? +(((first.o != null ? first.o : first.c) - prevClose) / prevClose * 100).toFixed(2) : null;
  const gapOk = gapPct == null || (gapPct > -2 && gapPct < 7);
  if (!gapOk) reasons.push('gap ' + gapPct + '% too extreme');
  return { ok: priceOk && volOk && valueOk && gapOk, reason: reasons.join(', ') || 'all correct', priceOk, volOk, valueOk, value, gapPct };
}

// New-buyer check from Angel quote: buyers stepping in = LTP up AND total buy
// quantity dominating (totBuy > totSell). Only then is a BUY recommendation made.
function newBuyerCheck(quote) {
  if (!quote || quote.ltp == null) return { ok: false, reason: 'no quote' };
  const up = (quote.changePct || 0) > 0;
  const buyersDominate = (quote.totBuy || 0) > (quote.totSell || 0);
  return { ok: up && buyersDominate,
    reason: up ? (buyersDominate ? 'new buyers stepping in (buy qty ' + quote.totBuy + ' > sell qty ' + quote.totSell + ')' : 'price up but sellers dominate') : 'price not up' };
}

const MIN_CALL_GAP_MIN = 30;    // same symbol can re-call after 30 min
const MAX_CALLS_PER_TICK = 8;   // cap per minute tick

async function scanForNewCalls() {
  // 09:20 CONFIRMATION GATE: the first 5 minutes are opening noise. No new
  // BUY calls before 09:20 IST — at 09:20 the opening bar has completed and
  // gap%, volume interest and the first candles can actually be judged.
  if (istMinutesNow() < 560) return { newCalls: 0, reason: 'awaiting 09:20 opening confirmation' };
  // 14:30 CUTOFF (backtest-validated): entries in the 14:00-15:00 band hit
  // targets only ~6% of the time (61% exit at close) — there isn't enough
  // session left for a 2R intraday target. No new calls after 14:30 IST.
  if (istMinutesNow() > 870) return { newCalls: 0, reason: 'past 14:30 IST cutoff — late entries are structurally weak' };
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
        candidates.push({ symbol: r.symbol, engine: r.winningEngine || r.engine, score: r.engineRate, source: 'ENGINE', i });
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
      // LIVE-DATA RULE: no new calls on stale series during market hours.
      if (isMarketOpen() && (!series || (series.lastBarAgeSec != null && series.lastBarAgeSec > 300)))
        return { ...c, ltp: null, vel: 0, series };
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

    // ENTRY GATE — new-buyer check: only enter when buyers are actually
    // stepping in (price up + totBuy > totSell). If conditions are not met,
    // do NOT enter — the stock stays on the board as WAIT.
    const cQuote = await fetchLiveStockQuote(c.symbol);
    const buyerGate = newBuyerCheck(cQuote);
    if (!buyerGate.ok) continue;

    // DAILY SWING GATE (horizon tag): read the last 20 daily bars. A close in
    // the top 40% of the 20-day range with the 10-day average rising = the
    // intraday move rides a daily uptrend → tag SWING-SUITABLE (also fine to
    // hold overnight). Otherwise INTRADAY-ONLY. Also persist the MTF candle
    // trends so every call carries its full multi-timeframe evidence.
    let horizon = 'INTRADAY-ONLY', swing = null;
    try {
      const dj = JSON.parse(fs.readFileSync(path.join(OHLCV, c.symbol + '.json'), 'utf8'));
      const d20 = dj.candles.slice(-20);
      if (d20.length >= 15) {
        const hi20 = Math.max(...d20.map(b => b[2]));
        const lo20 = Math.min(...d20.map(b => b[3]));
        const pos = hi20 > lo20 ? ((c.ltp - lo20) / (hi20 - lo20)) * 100 : 50;
        const d10 = d20.slice(-10);
        const avg10 = d10.reduce((s, b) => s + b[4], 0) / d10.length;
        const avg10Prev = d20.slice(-11, -1).reduce((s, b) => s + b[4], 0) / 10;
        swing = { pos20d: +pos.toFixed(1), avg10Rising: avg10 > avg10Prev };
        if (pos >= 40 && avg10 > avg10Prev) horizon = 'SWING-SUITABLE';
      }
    } catch (_) {}
    let mtfTrends = null;
    try {
      const cf = readCandleFrames((c.series && c.series.bars) || c.series);
      if (cf) mtfTrends = { m1: cf.frames.m1?.trend, m2: cf.frames.m2?.trend, m3: cf.frames.m3?.trend, m5: cf.frames.m5?.trend, m15: cf.frames.m15?.trend, m30: cf.frames.m30?.trend };
      // swing read: 5m/15m/30m all UP strengthens the SWING-SUITABLE tag;
      // mixed/down slow TFs on a SWING tag downgrade it to intraday-only
      if (cf && horizon === 'SWING-SUITABLE' && cf.swingAgree !== 'UP') {
        horizon = 'INTRADAY-ONLY';
        swing = swing || {}; swing.swingAgree = cf.swingAgree; swing.downgraded = true;
      }
    } catch (_) {}
    // Camarilla pivots from the prior session (backtest-validated read: confirmed
    // trend-day continuation — longs above R3, shorts below S3 — is net-positive;
    // fade-at-level entries were tail-dependent and are NOT gated on).
    let cam = null;
    try {
      const dj = JSON.parse(fs.readFileSync(path.join(OHLCV, c.symbol + '.json'), 'utf8'));
      const dBefore = dj.candles.filter(b2 => b2[0] < today);
      const pd = dBefore[dBefore.length - 1];
      if (pd) {
        cam = camarillaContext(c.ltp, calcCamarillaPivots(pd[2], pd[3], pd[4]));
      }
    } catch (_) {}

    // INTRADAY levels: candle-based stop from the live 1-min series — 10-bar
    // swing low (the pullback low the move launched from) with 0.1% buffer,
    // clamped to a 0.25%-0.6% risk band. Falls back to 0.6% below entry when
    // no series is available. T1 +2R, T2 +4R.
    let stop = +(c.ltp * 0.994).toFixed(2);
    let stopBasis = 'cap0.6pct';
    try {
      const recent = (c.series && c.series.length >= 12) ? c.series.slice(-11, -1) : null; // last 10 completed 1-min bars
      if (recent && c.ltp) {
        const swing = Math.min(...recent.map(b => b[3]));
        let cand = swing * 0.999;
        const riskPct = (c.ltp - cand) / c.ltp;
        if (riskPct < 0.0025) cand = c.ltp * (1 - 0.0025);   // min 0.25% risk
        if (riskPct > 0.006) cand = c.ltp * (1 - 0.006);     // max 0.6% risk
        if (cand > stop) { stop = +(cand.toFixed(2)); stopBasis = 'candles10'; }
      }
    } catch (_) {}
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
      horizon,
      swing,
      mtfTrends,
      cam,
      stopBasis,
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

// ---------- notifications ----------
// In-memory + file-persisted notification feed:
//   - STRONG BUY: an UP surge (>=0.5% between 5s ticks) on a high-score name
//   - DAY REPORT: generated at 15:15 IST with the day's calls P&L + predictions
const NOTIF_FILE = path.join(DATA, 'live_notifications.json');
function pushNotif(type, title, body, extra) {
  try {
    let db = { notifs: [] };
    try { db = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')); } catch (_) {}
    const item = Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), type, title, body, time: new Date().toISOString(), read: false }, extra || {});
    db.notifs.unshift(item);
    db.notifs = db.notifs.slice(0, 200);
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(db));
  } catch (_) {}
}
function getNotifs() {
  try {
    const db = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    return { time: new Date().toISOString(), unread: (db.notifs || []).filter(x => !x.read).length, notifs: (db.notifs || []).slice(0, 50) };
  } catch (_) { return { time: new Date().toISOString(), unread: 0, notifs: [] }; }
}
function markNotifsRead() {
  try {
    const db = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    for (const x of db.notifs || []) x.read = true;
    fs.writeFileSync(NOTIF_FILE, JSON.stringify(db));
  } catch (_) {}
}

// ---------- day report: 15:15 IST end-of-day predictions summary ----------
function buildDayReport() {
  const rep = todayReport();
  const db = loadCalls();
  const today = todayKey();
  const active = db.calls.filter(c => c.status === 'ACTIVE' && c.date === today);
  // predictions for tomorrow: top 5 confirmed/scored names from the watch box
  let picks = [];
  try {
    const wl = JSON.parse(fs.readFileSync(path.join(DATA, 'watchlist.json'), 'utf8'));
    picks = (wl.watch || wl.stocks || wl.rows || []).slice(0, 5).map(w => (w.symbol || w.sym || String(w)));
  } catch (_) {}
  const verdict = rep.realizedPnlPct > 0 ? 'PROFITABLE DAY' : rep.realizedPnlPct < 0 ? 'LOSING DAY' : 'FLAT DAY';
  return { verdict, ...rep, openPositions: active.length, tomorrowPicks: picks };
}
let _dayReportSent = null;
function maybeSendDayReport() {
  // fires once when IST time passes 15:15 (915) on a trading day
  const key = todayKey();
  if (_dayReportSent === key) return;
  if (istMinutesNow() >= 915 && istMinutesNow() < 1200) {
    _dayReportSent = key;
    const r = buildDayReport();
    pushNotif('DAY_REPORT', 'Day Report 15:15 — ' + r.verdict,
      'Calls today: ' + r.totalCalls + ' | Booked: ' + r.realizedPnlPct + '% | Open: ' + r.active + ' (unrealized ' + r.unrealizedPnlPct + '%)' +
      (r.tomorrowPicks.length ? ' | Tomorrow picks: ' + r.tomorrowPicks.join(', ') : ''),
      { report: r });
  }
}

// ---------- fast surge detector (STRONG BUY, sub-5s reaction) ----------
// Polls the top watchset with ONE batched Angel call every tick (~5s) and
// flags stocks whose LTP jumped vs the previous tick (sudden move) — these
// surface instantly as STRONG BUY candidates instead of waiting up to a
// minute for the heavy 60s scan. Falls back to Yahoo 1-min series when
// Angel creds are absent.
async function scanSurges() {
  if (!isMarketOpen()) return { surges: 0 };
  let watch = [];
  try {
    const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
    watch = (es.results || []).slice(0, 120).map(r => r.symbol);
  } catch (_) {}
  if (!watch.length) return { surges: 0 };
  if (!state._surgePrev) state._surgePrev = {};
  if (!state.surges) state.surges = [];
  const now = Date.now();
  const TH = 0.5;
  const prev = state._surgePrev;
  const cur = {};
  if (hasAngelCreds()) {
    try {
      const qm = await fetchAngelQuotes(watch);
      for (const sym of Object.keys(qm)) cur[sym] = qm[sym].ltp;
    } catch (_) {}
  }
  const missed = watch.filter(x => cur[x] == null).slice(0, 6);
  await Promise.all(missed.map(async sym => {
    const sr = await fetchIntradaySeries(sym).catch(() => null);
    if (sr && sr.last != null) cur[sym] = sr.last;
  }));
  let hits = 0;
  for (const sym of Object.keys(cur)) {
    const ltp = cur[sym];
    if (ltp == null || ltp < MIN_PRICE) continue;
    const p = prev[sym];
    prev[sym] = ltp;
    if (p == null || p <= 0) continue;
    const movePct = +(((ltp - p) / p) * 100).toFixed(2);
    if (Math.abs(movePct) >= TH) {
      hits++;
      state.surges.push({ symbol: sym, time: new Date().toISOString(), movePct, ltp, direction: movePct > 0 ? 'UP' : 'DOWN' });
      if (movePct > 0 && ltp >= MIN_PRICE) {
        // STRONG BUY notification: sudden UP move between ticks
        const lastNotif = (state.surges || []).filter(x => x.symbol === sym).length;
        if (lastNotif < 3) pushNotif('STRONG_BUY', 'STRONG BUY: ' + sym + ' ' + (movePct > 0 ? '+' : '') + movePct + '%',
          sym + ' surged +' + movePct + '% in seconds, now Rs' + ltp + '. Buyers stepping in — momentum candidate.',
          { symbol: sym, movePct, ltp });
      }
    }
  }
  state.surges = state.surges.filter(x => now - new Date(x.time).getTime() < 600000).slice(-200).reverse();
  return { surges: hits };
}

// ---------- dead-stock volume revival (news-driven interest) ----------
// A quiet stock (last ~15 one-min bars mostly near-zero volume) suddenly
// printing a bar at >=4x its recent average = VOLUME REVIVAL. News usually
// shows up as volume first. Notified once per symbol per day.
let _revivalNotified = {};   // symbol -> dateKey
async function scanVolumeRevival() {
  if (!isMarketOpen()) return { revivals: 0 };
  let watch = [];
  try {
    const es = JSON.parse(fs.readFileSync(path.join(DATA, 'engine_scores.json'), 'utf8'));
    watch = (es.results || []).slice(0, 200).map(r => r.symbol);
  } catch (_) {}
  if (!watch.length) return { revivals: 0 };
  if (state._revivalCursor == null) state._revivalCursor = 0;
  // rotate: ~40 symbols per call, full cycle every few ticks
  const CH = 40;
  const batch = [];
  for (let k = 0; k < Math.min(CH, watch.length); k++) batch.push(watch[(state._revivalCursor + k) % watch.length]);
  state._revivalCursor = (state._revivalCursor + CH) % Math.max(1, watch.length);
  const today = todayKey();
  let hits = 0;
  const CONC = 8;
  for (let i = 0; i < batch.length; i += CONC) {
    const res = await Promise.all(batch.slice(i, i + CONC).map(async sym => {
      try {
        if (_revivalNotified[sym] === today) return null;
        const sr = await fetchIntradaySeries(sym);
        if (!sr || !sr.bars || sr.bars.length < 30) return null;
        const vols = sr.bars.map(b => b.v || 0);
        const recent = vols.slice(-15);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (avg <= 0) return null;
        const last = vols[vols.length - 1];
        // dead baseline: recent average tiny (<= 500 shares/min) ...
        const wasDead = avg <= 500;
        // ... and the last bar explodes to >=4x that average
        if (!(wasDead && last >= avg * 4 && last >= 2000)) return null;
        const bars = sr.bars;
        const up = bars[bars.length - 1].c >= bars[bars.length - 1].o;
        _revivalNotified[sym] = today;
        return { sym, avg: Math.round(avg), last, up, ltp: sr.last };
      } catch (_) { return null; }
    }));
    for (const r of res.filter(Boolean)) {
      hits++;
      const mult = r.avg > 0 ? Math.round(r.last / r.avg) : 0;
      pushNotif('VOLUME_REVIVAL', 'VOLUME REVIVAL: ' + r.sym + ' (' + mult + 'x volume)',
        r.sym + ' was dead (~' + r.avg + ' sh/min) and just printed ' + r.last + ' shares in one minute' +
        (r.up ? ' with price pushing UP' : '') + ' at Rs' + r.ltp + '. Sudden interest — often news. Watch closely.' +
        (r.up ? ' Price confirming — momentum candidate.' : ' Price not confirming yet — wait for direction.'),
        { symbol: r.sym, volMultiple: mult, ltp: r.ltp, up: r.up });
      if (r.up) {
        pushNotif('STRONG_BUY', 'STRONG BUY: ' + r.sym + ' (volume revival ' + mult + 'x)',
          r.sym + ' came alive from dead volume with price UP — ' + mult + 'x its recent average at Rs' + r.ltp + '.',
          { symbol: r.sym, volMultiple: mult, ltp: r.ltp });
      }
    }
  }
  return { revivals: hits };
}

function getSurges() {
  return { time: new Date().toISOString(), surges: state.surges || [] };
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
  // MARKET-OPEN TRIGGER: on the first tick of a trading day (09:15 IST or
  // later), force the full pipeline once — refresh daily candles, rescore
  // engines, rebuild the trade table/watchlist. This is what makes Render
  // update its dates and scans at open instead of serving yesterday's data.
  const istNow = istMinutesNow();
  if (istNow >= 555 && state._pipelineDayKey !== todayKey()) {
    state._pipelineDayKey = todayKey();
    state.lastPipelineRun = null;   // force the stale check below to fire
  }
  const hourly = !state.lastPipelineRun || (now - new Date(state.lastPipelineRun).getTime()) > 3600e3;
  if (opts.forcePipeline || (hourly && await ohlcvStale().catch(() => false))) {
    await runPipeline(opts).catch(() => {});
  }
  try {
    // Fast loop (5s): call tracking runs EVERY tick so SL/T1/T2 exits fire
    // within seconds of price touching the level. Heavy scans (candidate
    // velocity ranking + signal board + movers, minutes of API budget) stay
    // on a 60s throttle.
    const heavyDue = !state.lastHeavyTick || (Date.now() - state.lastHeavyTick) >= 60000;
    if (isMarketOpen()) {
      if (heavyDue) {
        state.lastHeavyTick = Date.now();
        await scanForNewCalls();
        await scanSignals();        // per-minute ROC + buyer-structure board
        await scanMovers();         // real-time movers board (1%/5% flags)
      }
      await scanSurges();
      scanVolumeRevival().catch(() => {});   // dead-stock news-volume revival
      await trackCalls();
    }
    // Day report fires AFTER the 15:00 live stop — the tick keeps running
    // so the 15:15 IST end-of-day notification (verdict + tomorrow picks)
    // actually gets sent.
    maybeSendDayReport();   // 15:15 IST end-of-day report notification
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

module.exports = { start, stop, tick, getCalls, getCallDetail, todayReport, runPipeline, scanForNewCalls, scanSignals, getSignals, getSurges, scanVolumeRevival, getNotifs, markNotifsRead, buildDayReport, scanSurges, scanMovers, getMovers, isMarketOpen, state };
