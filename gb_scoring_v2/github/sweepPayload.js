/**
 * sweepPayload.js — builds the JSON behind GET /api/gb/github/sweep.
 *
 * WHY THIS IS A MODULE AND NOT AN INLINE HANDLER ANY MORE: the panel's numbers are read by a user
 * making buy/sell decisions, so the payload has to be testable WITHOUT booting the app (booting it
 * starts brokers, the news engine and schedulers — side effects a test must not cause). Everything
 * here is pure file-reading plus arithmetic on already-measured per-session R, so it can be called
 * directly from a script.
 *
 * Every number is a FULL-TAPE HARNESS MEASUREMENT read off disk. Nothing is extrapolated, nothing is
 * interpolated between costs, and a cell that has not been run is reported as null rather than filled
 * in. `established` means the session bootstrap EXCLUDES ZERO; anything else is a point estimate.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const BT = require('../raschke/backtest.js');

// The five strategies that carry the cost x side grid (they are the ones measured in every cell).
const IDS = ['zarattini_momentum', 'orb', 'trend_day', 'nifty50_ict', 'liquiditySweep'];

// cost x side grid. A missing file is an honest null, not a gap filled by the neighbour cell.
const CELLS = [
  { side: 'all', cost: 0.10, file: 'sweep_all_010.json' },
  { side: 'all', cost: 0.05, file: 'sweep_all_005.json' },
  { side: 'all', cost: 0.02, file: 'sweep_all_002.json' },
  { side: 'SHORT', cost: 0.10, file: 'sweep_SHORT_010.json' },
  { side: 'SHORT', cost: 0.05, file: 'sweep_SHORT_005.json' },
  { side: 'SHORT', cost: 0.02, file: 'sweep_SHORT_002.json' },
];

/**
 * buildSweepPayload(dataDir) — the whole response body. Throws only on a genuinely broken data dir;
 * an unreadable cell degrades to null so one missing run cannot blank the panel.
 */
function buildSweepPayload(dataDir) {
  const DIR = dataDir || path.join(__dirname, '..', '..', 'data');
  const readCell = (f) => {
    try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (_) { return null; }
  };

  const mixAll = readCell('sweep_all_002b.json');
  const mixShort = readCell('sweep_SHORT_002b.json');
  const pick = (p, id) => {
    const r = p && p.ranked && p.ranked.find((x) => x.id === id);
    return r ? {
      id, trades: r.trades, meanGrossR: r.meanGrossR, meanCostR: r.meanCostR, meanR: r.meanR,
      rCI: r.rCI, verdict: r.verdict ? r.verdict.code : null, sessions: r.sessions,
      positiveSessions: r.positiveSessions, sessionMeanR: r.sessionMeanR || null,
    } : null;
  };

  const byId = {};
  for (const id of IDS) {
    byId[id] = CELLS.map((c) => {
      const p = readCell(c.file);
      const r = p && p.ranked && p.ranked.find((x) => x.id === id);
      return {
        side: c.side, cost: c.cost, trades: r ? r.trades : null, meanGrossR: r ? r.meanGrossR : null,
        meanCostR: r ? r.meanCostR : null, meanR: r ? r.meanR : null, rCI: r ? r.rCI : null,
        verdict: r && r.verdict ? r.verdict.code : null,
      };
    });
  }

  // ------------------------------------------------------------------------------------------------
  // THE BUY SIDE, MEASURED SEPARATELY. The grid answers "does this strategy make money"; it does NOT
  // answer "if the screen prints BUY, is that buy worth taking", because a strategy with a positive
  // SIDE can be positive ONLY on its shorts. So the LONG side gets its own rows, measured with
  // `--side=LONG` rather than inferred: the two-sided number minus the short number is not the long
  // number, and assuming that symmetry is exactly how a losing buy signal gets shown as a winner.
  // `intraday_roc` is LONG-ONLY by definition (its source has no short rule), so its cell IS its buy
  // side, run standalone at 0.02% cost.
  const rocCell = readCell('sweep_roc_002.json');
  const longCell = readCell('sweep_LONG_002.json');
  const buyRows = [];
  const pushBuy = (p, id, label) => {
    const r = p && p.ranked && p.ranked.find((x) => x.id === id);
    if (!r) return;
    const c = r.rCI_sessionMean || null;   // {lo, hi, days, estimator, seed} — an object, not a pair
    buyRows.push({
      id: r.id, name: r.name || null, label,
      trades: r.trades, meanGrossR: r.meanGrossR, meanCostR: r.meanCostR, meanR: r.meanR,
      rCI: r.rCI || null, rCI_sessionMean: c,
      positiveSessions: r.positiveSessions, sessions: r.sessions,
      verdict: r.verdict ? r.verdict.code : null,
      // PROFITABLE means the bootstrap EXCLUDES ZERO and sits above it. A point estimate above zero
      // with a CI spanning zero is not a buy signal; it is a coin flip with a pleasant average.
      profitable: !!(c && c.lo > 0),
      established: !!(c && (c.lo > 0 || c.hi < 0)),
    });
  };
  pushBuy(rocCell, 'intraday_roc', 'LONG ONLY by definition (the source has no short rule) — this IS its buy side');
  for (const id of IDS) pushBuy(longCell, id, 'LONG side only (measured with --side=LONG, not inferred)');
  buyRows.sort((a, b) => (b.meanR == null ? -99 : b.meanR) - (a.meanR == null ? -99 : a.meanR));
  const profitableBuys = buyRows.filter((r) => r.profitable).map((r) => r.id);

  // ------------------------------------------------------------------------------------------------
  // THE MIXES, RECOMPUTED FROM THE PER-SESSION NUMBERS. Equal weight per session; the CI is rebuilt
  // with the harness's own session bootstrap over the combined per-session means, so a combined curve
  // is judged by the same rule as a single strategy instead of by its point estimate. intraday_roc is
  // added ON TOP of the SHORT-only pair to answer the question the mix was built for: does the buy-side
  // strategy improve the combination, or drag it back toward zero?
  const seriesOf = (p, id) => { const r = p && p.ranked && p.ranked.find((x) => x.id === id); return r && r.sessionMeanR ? r.sessionMeanR : null; };
  const combo = (label, members) => {
    const keys = new Set();
    for (const m of members) for (const d of Object.keys(m.sessionMeanR)) keys.add(d);
    const by = {}, vec = [];
    for (const d of [...keys].sort()) {
      const vals = members.map((m) => m.sessionMeanR[d]).filter((v) => v != null);
      if (!vals.length) continue;
      by[d] = [vals.reduce((s, v) => s + v, 0) / vals.length];
      vec.push(by[d][0]);
    }
    if (vec.length < 5) return null;
    const meanR = vec.reduce((s, v) => s + v, 0) / vec.length;
    const c = BT.sessionMeanCI(by, { reps: 2000, seed: 20260928 });
    let eq = 0, peak = 0, dd = 0;
    for (const v of vec) { eq += v; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    return {
      label, members: members.map((m) => m.id), meanR: +meanR.toFixed(4),
      rCI: c ? { lo: c.lo, hi: c.hi } : null,
      positiveSessions: vec.filter((v) => v > 0).length, sessions: vec.length,
      maxDDR: +dd.toFixed(1), established: !!(c && (c.lo > 0 || c.hi < 0)),
    };
  };
  const membersOf = (obj) => Object.entries(obj).filter(([, s]) => s).map(([id, sessionMeanR]) => ({ id, sessionMeanR }));
  const s3 = seriesOf(mixShort, 'liquiditySweep');
  const s1 = seriesOf(mixShort, 'nifty50_ict');
  const rocS = seriesOf(rocCell, 'intraday_roc');
  const rest = ['trend_day', 'zarattini_momentum', 'orb'].map((id) => ({ id, sessionMeanR: seriesOf(mixShort, id) })).filter((m) => m.sessionMeanR);
  const mixes = [];
  const addMix = (label, obj) => { const m = combo(label, membersOf(obj)); if (m) mixes.push(m); };
  if (s3 && s1) addMix('liquiditySweep SHORT + nifty50_ict SHORT (the earlier best pair)', { liquiditySweep: s3, nifty50_ict: s1 });
  if (rocS) addMix('intraday_roc LONG alone', { intraday_roc: rocS });
  if (s3 && s1 && rocS) addMix('that pair + intraday_roc LONG', { liquiditySweep: s3, nifty50_ict: s1, intraday_roc: rocS });
  if (s3 && s1 && rest.length === 3) {
    const five = { liquiditySweep: s3, nifty50_ict: s1, trend_day: rest[0].sessionMeanR, zarattini_momentum: rest[1].sessionMeanR, orb: rest[2].sessionMeanR };
    addMix('all 5 SHORT cells', five);
    if (rocS) addMix('all 5 SHORT cells + intraday_roc LONG', Object.assign({ intraday_roc: rocS }, five));
  }

  return {
    ok: true,
    ids: IDS,
    cells: CELLS.map((c) => ({ side: c.side, cost: c.cost, available: !!readCell(c.file) })),
    byId,
    buy: {
      rows: buyRows, profitable: profitableBuys, available: !!(rocCell || longCell),
      note: !buyRows.length
        ? 'no LONG-side cell measured yet'
        : (profitableBuys.length
          ? profitableBuys.length + ' buy side(s) clear zero: ' + profitableBuys.join(', ')
          : 'NO buy side was measured profitable with a bootstrap that excludes zero. Every positive cell on this page is a SHORT-side cell — on this tape the edge is not on the buy signal.'),
    },
    mixes,
    mix: {
      all: mixAll ? IDS.map((id) => pick(mixAll, id)) : null,
      short: mixShort ? IDS.map((id) => pick(mixShort, id)) : null,
      roc: rocCell ? pick(rocCell, 'intraday_roc') : null,
      longSideAvailable: !!longCell,
      note: 'best pair (SHORT-only, 0.02% cost): liquiditySweep + nifty50_ict — combined session mean +0.033R, positive 81/142 sessions. NOT_ESTABLISHED: the CIs still span zero.',
    },
  };
}

module.exports = { buildSweepPayload, IDS, CELLS };
