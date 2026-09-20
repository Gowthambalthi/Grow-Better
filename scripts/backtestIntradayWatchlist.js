/**
 * scripts/backtestIntradayWatchlist.js — the honest test of the live strategy.
 *
 * Live flow: watchlist built from DAILY closes after market → next session the
 * engine trades INTRADAY. A 1% stop cannot be judged on daily bars (it sits
 * inside normal daily noise — that test showed ~76% first-bar stop-outs), so
 * exits here are resolved on 15-minute bars of the actual next session.
 *
 * Per setup:
 *   SIGNAL   daily close, membership per block (STRICT / DIVERSE)
 *   ENTRY    first 15-min bar open of the next session
 *   STOPS    1% fixed  vs  candle stop (first 30-min swing low, clamped)
 *   TARGETS  1% / 2% / 3%
 *   EXIT     whichever side is touched first on 15-min bars; EOD close if neither
 *   FILTERS  bigBuyers (up-volume share of the first 30 min >= 55%)
 *            rocOn (first 30-min return > 0)
 *
 * Costs: 12 bps round trip.
 *
 * Usage: node scripts/backtestIntradayWatchlist.js [--symbols=400]
 */
const fs = require('fs');
const path = require('path');
const { evaluate } = require('./scoreEngines');

const DAILY_3Y = path.join(__dirname, '..', 'data', 'ohlcv_3y');
const DAILY_1Y = path.join(__dirname, '..', 'data', 'ohlcv');
const M15 = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const UNIVERSE = path.join(__dirname, '..', 'data', 'nse_universe_3000.txt');
const COST_BPS = parseInt((process.argv.find(x => x.startsWith('--cost=')) || '').split('=')[1] ?? '12', 10);

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith('--' + k + '='));
  return a ? a.split('=')[1] : d;
};
const MAX_SYMBOLS = parseInt(arg('symbols', '400'), 10);

const storeDir = () => (fs.existsSync(DAILY_3Y) && fs.readdirSync(DAILY_3Y).length > 500)
  ? DAILY_3Y : DAILY_1Y;

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).candles; } catch (_) { return null; }
}

const RSI_BAND = { TREND: [55, 75], BREAKOUT: [55, 80], PULLBACK: [45, 65], 'SUPPORT BOUNCE': [30, 60], ACCUMULATION: [40, 70] };

/**
 * FRESH BUY — replicates scripts/buildTradeTable.js exactly, because that is what
 * the watchlist's FRESH BUY block is built from: score >= 7, no traps, and the
 * "freshness" rule (close within 1% of the engine's entry zone) plus volRatio > 1.2.
 * Note it has NO ADX floor and a lower score bar than STRICT/DIVERSE (>= 9).
 */
function memberFresh(r) {
  const i = r.indicators || {};
  if ((r.engineRate || 0) < 7) return false;
  if (i.rsi14 > 80 || i.volRatio < 0.8 || i.adx14 < 18) return false;
  if (!i.ema20 || r.close > i.ema20 * 1.10) return false;
  const zone = r.winningEngine === 'BREAKOUT' ? i.resistance30
    : r.winningEngine === 'SUPPORT BOUNCE' ? i.support30
    : i.ema20;
  if (!zone) return false;
  if (!(r.close >= zone * 0.99 && r.close <= zone * 1.01)) return false;   // within 1% of entry zone
  if ((i.volRatio || 0) <= 1.2) return false;
  return true;
}

function member(r, mode) {
  const i = r.indicators || {};
  if ((r.engineRate || 0) < 9) return false;
  if (i.rsi14 > 80 || i.volRatio < 0.8 || i.adx14 < 18) return false;
  if ((i.adx14 || 0) < 20 || (i.volRatio || 0) < 1.2) return false;
  const band = mode === 'STRICT' ? [55, 75] : (RSI_BAND[r.winningEngine] || [40, 80]);
  return i.rsi14 >= band[0] && i.rsi14 <= band[1];
}

// group 15-min bars by date
function byDay(bars) {
  const map = new Map();
  for (const b of bars) {
    const d = String(b[0]).slice(0, 10);
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(b);
  }
  return map;
}

/**
 * Simulate one intraday trade on the given session bars.
 * exitCfg: { kind:'pct'|'candle', stopPct, targetPct }
 */
// Entry bar index: the engine observes the 09:15-09:45 window (bars 0 and 1)
// to judge buyers/ROC, then enters at 10:00 (bar 2 open). Entering at the 09:15
// open while judging the first 30 minutes would be look-ahead — this is the
// earliest bar whose decision uses only CLOSED information.
const ENTRY_BAR = 2;

function simulateDay(session, exitCfg) {
  if (!session || session.length < ENTRY_BAR + 6) return null;
  const entry = session[ENTRY_BAR][1];            // 10:00 open, after observation window
  if (!entry) return null;
  let stop;
  if (exitCfg.kind === 'candle') {
    // swing low of the 09:15-10:00 window (bars 0..2) — fully known at entry
    let swing = Infinity;
    for (let k = 0; k < ENTRY_BAR; k++) swing = Math.min(swing, session[k][3]);
    stop = swing * 0.999;
    let risk = (entry - stop) / entry;
    if (risk < 0.004) stop = entry * 0.996;
    if (risk > 0.02) stop = entry * 0.98;
  } else {
    stop = entry * (1 - exitCfg.stopPct);
  }
  const target = entry * (1 + exitCfg.targetPct);
  const risk = entry - stop;
  if (risk <= 0) return null;

  for (let k = ENTRY_BAR + 1; k < session.length; k++) {
    const low = session[k][3], high = session[k][2];
    if (low <= stop) {                             // no same-bar fill on the entry bar
      const g = (stop - entry) / entry;
      return { R: (g - COST_BPS / 1e4) * (entry / risk), exit: 'STOP', bars: k - ENTRY_BAR };
    }
    if (high >= target) {
      const g = (target - entry) / entry;
      return { R: (g - COST_BPS / 1e4) * (entry / risk), exit: 'TARGET', bars: k - ENTRY_BAR };
    }
  }
  const g = (session[session.length - 1][4] - entry) / entry;
  return { R: (g - COST_BPS / 1e4) * (entry / risk), exit: 'EOD', bars: session.length - 1 - ENTRY_BAR };
}

/**
 * Volume-at-price buyer read over the CLOSED observation window (09:15-09:45).
 * Each bar's volume is split up/down by where its close sits inside its range
 * (closing at the highs = buyers absorbing there). Big single bars printing at
 * the highs are flagged as big buyers; big bars at the lows as big sellers.
 */
function buyerRead(session) {
  const obs = session.slice(0, ENTRY_BAR);
  if (!obs.length) return null;
  let up = 0, down = 0, total = 0, bigBuy = 0, bigSell = 0, halfA = 0, halfB = 0;
  const avgVol = obs.reduce((s, b) => s + (b[5] || 0), 0) / obs.length;
  obs.forEach((b, i) => {
    const o = b[1], h = b[2], l = b[3], c = b[4], v = b[5] || 0;
    const rng = (h - l) || 1e-9;
    const pos = Math.min(1, Math.max(0, (c - l) / rng));
    total += v; up += v * pos; down += v * (1 - pos);
    if (avgVol > 0 && v >= 1.8 * avgVol && pos >= 0.6) bigBuy++;
    if (avgVol > 0 && v >= 1.8 * avgVol && pos <= 0.4) bigSell++;
    if (i < obs.length / 2) halfA += v; else halfB += v;
  });
  const open = obs[0][1];
  const last = obs[obs.length - 1][4];
  const roc = open > 0 ? (last - open) / open : 0;
  return {
    upShare: total > 0 ? up / total : 0.5,
    bigBuy, bigSell, roc,
    volBuild: halfA > 0 ? halfB / halfA >= 1 : false,   // volume rate accelerating
  };
}

/** All the filter variants tested on top of a membership signal. */
function filterSet(session) {
  const r = buyerRead(session);
  if (!r) return {};
  const bigBuyers = r.upShare >= 0.55 && r.bigSell === 0;
  const rocOn = r.roc > 0;                       // adverse rate-of-change → removed
  return {
    bigBuyers,
    rocOn,
    volBuild: r.volBuild,
    confirmed: bigBuyers && rocOn,               // buyers + positive ROC together
    strict3: bigBuyers && rocOn && r.volBuild,   // + volume accelerating into the move
    // Extension read: how far the stock has ALREADY run by entry time.
    // Chasing an extended open is the classic fake-move entry.
    rocSweet: r.roc > 0 && r.roc <= 0.0075 && r.upShare >= 0.5,   // up, but not extended
    rocExt: r.roc > 0.015,                        // already +1.5% before entry — chasing
    notExt: r.roc <= 0.0075,                      // no extension at all
    read: r,
  };
}

function stats(rows) {
  const n = rows.length;
  if (!n) return { n: 0 };
  const wins = rows.filter(r => r.R > 0);
  const gw = wins.reduce((s, r) => s + r.R, 0);
  const gl = Math.abs(rows.filter(r => r.R <= 0).reduce((s, r) => s + r.R, 0));
  const exTop = rows.slice().sort((a, b) => b.R - a.R);
  const cut = Math.max(0, Math.floor(n * 0.1));
  const exTail = exTop.slice(cut);
  return {
    n,
    win: +((wins.length / n) * 100).toFixed(1),
    avgR: +(rows.reduce((s, r) => s + r.R, 0) / n).toFixed(3),
    pf: gl > 0 ? +(gw / gl).toFixed(2) : null,
    totalR: +rows.reduce((s, r) => s + r.R, 0).toFixed(1),
    exTailAvgR: exTail.length ? +(exTail.reduce((s, r) => s + r.R, 0) / exTail.length).toFixed(3) : null,
    tgt: +((rows.filter(r => r.exit === 'TARGET').length / n) * 100).toFixed(0),
    stop: +((rows.filter(r => r.exit === 'STOP').length / n) * 100).toFixed(0),
  };
}

(async () => {
  const dir = storeDir();
  // Symbols must exist in BOTH stores — the intraday store is the scarce one,
  // so drive the universe from it and keep daily-capable names only.
  let syms = fs.readdirSync(M15).map(f => f.replace(/\.json$/, ''));
  syms = syms.filter(s => fs.existsSync(path.join(dir, s + '.json')));
  syms.sort();
  syms = syms.slice(0, MAX_SYMBOLS);
  console.log(`daily store: ${path.basename(dir)} · intraday: ohlcv_15m · symbols: ${syms.length} · costs ${COST_BPS}bps\n`);

  const EXITS = [
    { name: '1% SL / 2% TGT', kind: 'pct', stopPct: 0.01, targetPct: 0.02 },
    { name: 'CANDLE SL / 2% TGT', kind: 'candle', targetPct: 0.02 },
    { name: 'CANDLE SL / 1.5% TGT', kind: 'candle', targetPct: 0.015 },
    { name: '1% SL / 1% TGT', kind: 'pct', stopPct: 0.01, targetPct: 0.01 },
    { name: '1% SL / 3% TGT', kind: 'pct', stopPct: 0.01, targetPct: 0.03 },
    // Wider risk -> cost per R falls (12bps / risk). Isolates cost drag from edge.
    { name: '1.5% SL / 3% TGT', kind: 'pct', stopPct: 0.015, targetPct: 0.03 },
    { name: '2% SL / 4% TGT', kind: 'pct', stopPct: 0.02, targetPct: 0.04 },
    { name: 'CANDLE SL / 4% TGT', kind: 'candle', targetPct: 0.04 },
  ];
  const MODES = ['ALL', 'FRESH', 'STRICT', 'DIVERSE'];
  const BUCKETS = ['base', 'bigBuyers', 'rocOn', 'volBuild', 'confirmed', 'strict3', 'rocSweet', 'rocExt', 'notExt'];
  const results = {};
  for (const m of MODES) {
    results[m] = {};
    for (const e of EXITS) {
      results[m][e.name] = {};
      for (const b of BUCKETS) results[m][e.name][b] = [];
    }
  }

  let used = 0;
  const signals = {};
  for (const sym of syms) {
    const daily = load(path.join(dir, sym + '.json'));
    const m15 = load(path.join(M15, sym + '.json'));
    if (!daily || !m15 || daily.length < 260 || m15.length < 100) continue;
    used++;
    const days = byDay(m15);
    const dayList = [...days.keys()].sort();

    for (let di = 0; di < dayList.length - 1; di++) {
      const sigDay = dayList[di];
      const session = days.get(dayList[di + 1]);
      if (!session || session.length < 12) continue;

      // daily bar index for the signal day (signals are computed on daily closes)
      let idx = -1;
      for (let k = daily.length - 1; k >= 0; k--) {
        if (String(daily[k][0]).slice(0, 10) <= sigDay) { idx = k; break; }
      }
      if (idx < 60) continue;

      let r;
      try { r = evaluate(daily.slice(0, idx + 1)); } catch (_) { continue; }
      if (!r) continue;
      r.symbol = sym;

      const f = filterSet(session);
      const inStrict = member(r, 'STRICT');
      const inDiverse = member(r, 'DIVERSE');
      const inAll = (r.engineRate || 0) >= 7;      // engine signal, no watchlist gate
      const membership = { ALL: inAll, FRESH: memberFresh(r), STRICT: inStrict, DIVERSE: inDiverse };
      for (const mode of MODES) {
        if (!membership[mode]) continue;
        signals[mode] = (signals[mode] || 0) + 1;
        for (const e of EXITS) {
          const t = simulateDay(session, e);
          if (!t) continue;
          const bucket = results[mode][e.name];
          bucket.base.push(t);
          if (f.bigBuyers) bucket.bigBuyers.push(t);
          if (f.rocOn) bucket.rocOn.push(t);
          if (f.volBuild) bucket.volBuild.push(t);
          if (f.confirmed) bucket.confirmed.push(t);
          if (f.strict3) bucket.strict3.push(t);
          if (f.rocSweet) bucket.rocSweet.push(t);
          if (f.rocExt) bucket.rocExt.push(t);
          if (f.notExt) bucket.notExt.push(t);
        }
      }
    }
  }

  console.log(`Symbols used: ${used}`);
  for (const m of MODES) console.log(`  ${m} signal-days: ${signals[m] || 0}`);
  console.log('');
  for (const mode of MODES) {
    console.log(`========== ${mode} ==========`);
    for (const e of EXITS) {
      const b = results[mode][e.name];
      console.log(`  ${e.name}`);
      for (const v of BUCKETS) {
        const s = stats(b[v]);
        if (!s.n) { console.log(`    ${v.padEnd(10)} no trades`); continue; }
        console.log(`    ${v.padEnd(10)} n=${String(s.n).padStart(5)} win=${String(s.win).padStart(5)}% avgR=${String(s.avgR).padStart(7)} pf=${String(s.pf).padStart(5)} totR=${String(s.totalR).padStart(7)} TGT=${String(s.tgt).padStart(3)}% STOP=${String(s.stop).padStart(3)}% exTail=${String(s.exTailAvgR).padStart(6)}`);
      }
    }
    console.log('');
  }
})();
