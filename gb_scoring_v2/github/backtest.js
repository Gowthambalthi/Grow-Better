/**
 * gb_scoring_v2/github/backtest.js — EVERY EXTERNAL STRATEGY, MEASURED ON ONE TAPE.
 *
 * WHY THIS FILE EXISTS. The user's list of public repos was ranked by CLAIMED number, and the list
 * itself contained the finding that matters: the highest claims had the least vetting, and the one
 * project that ran a strict out-of-sample + cost check retired its 90% win rate and replaced it with
 * a single-digit annual return. So a ranking of claims is not usable. This produces the ranking you
 * can actually act on: every ported strategy run over the SAME bars, through the SAME simulator,
 * with the SAME costs, and the claim printed next to the measurement so the gap is visible instead
 * of argued.
 *
 * THE RANKING IS BY NET MEAN R, AND IT REFUSES TO CROWN A WINNER ON NOISE. Two guards sit in front
 * of the "best" label:
 *   * a minimum trade count, because a strategy with 12 trades and a lucky mean R is not a result;
 *   * the session bootstrap CI, because the unit of evidence here is the SESSION, not the trade
 *     (trades inside one day are not independent, so a naive per-trade t-test overstates
 *     significance by roughly the square root of the trades-per-day).
 * A strategy whose CI spans zero is labelled "not established" even when it ranks first. If nothing
 * clears both guards, the output says so and names nothing — which is a legitimate outcome, and the
 * one the Raschke backtest already produced once.
 *
 * Usage:
 *   node gb_scoring_v2/github/backtest.js
 *   node gb_scoring_v2/github/backtest.js --limit=200 --cost=0.10 --out=data/github_strategies.json
 */
const fs = require('fs');
const path = require('path');
const IND = require('../raschke/indicators');
const BT = require('../raschke/backtest');
const G = require('./strategies');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'ohlcv_1m');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const a = argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const LIMIT = Number(argOf('limit', 0)) || 0;
const SAMPLE = Number(argOf('sample', 0)) || 0;
const COST_PCT = Number(argOf('cost', 0.10));
const OUT = path.resolve(ROOT, argOf('out', 'data/github_strategies.json'));
const MIN_TRADES = Number(argOf('minTrades', 50));
// COVERAGE FILTER. 0 = measure every symbol the tape has, and report the cohorts apart (the default,
// because a filtered universe must be an explicit choice). Set it (e.g. --minSessions=100) to measure
// only symbols that carry the full calendar, which is the right universe for a dev/OOS claim.
const MIN_SESSIONS = Number(argOf('minSessions', 0)) || 0;
// IMPROVEMENT-SWEEP FILTERS (2026-09-27). Both are REPORTING filters, not strategy edits: --ids
// limits which strategies run (fewer rows, same numbers); --side=SHORT drops LONG candidates before
// simulation so a shorts-only variant is measured on its own, the same way a cost change is.
const IDS = (argOf('ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SIDE_FILTER = (argOf('side', '') || '').toUpperCase() || null;
const WARMUP = 45;
// THE RISK BAND, APPLIED. `raschke/backtest.js` declared MIN_RISK_PCT/MAX_RISK_PCT and never used
// them, so nothing stopped a setup whose structural stop sat a fraction of a paisa from the entry
// from being simulated. That is not a tight stop, it is a DEGENERATE one: cost/risk then divides by
// almost nothing, and two of these strategies printed mean gross R in the BILLIONS before this
// guard existed. A stop under 0.15% of price is inside the spread and the noise; one over 3% is not
// an intraday stop at all. Refused candidates are counted per strategy and reported, because a
// strategy that only works on degenerate stops should be visible as exactly that.
const MIN_RISK_PCT = Number(argOf('minRisk', 0.15));
const MAX_RISK_PCT = Number(argOf('maxRisk', 3.0));
// ---- VISIBILITY, BECAUSE A JOB YOU CANNOT SEE IS A JOB YOU KILL ----
// This run has twice been started over the full universe and killed at a timeout with NOTHING to
// show for it, because the only write was at the very end. Now: a progress line and a machine-readable
// progress file every PROGRESS_EVERY symbols, and a real (clearly-marked partial) table every
// PARTIAL_EVERY symbols, so an interrupted run still leaves evidence of where it got to.
const PROGRESS_EVERY = Number(argOf('progressEvery', 50)) || 0;
const PARTIAL_EVERY = Number(argOf('partialEvery', 250)) || 0;

/**
 * WHAT EACH REPO CLAIMED. Kept here rather than on the strategy, because a claim is a property of
 * the report, not of the rules — the rules are the same whether the author over-claimed or not.
 * `null` means the repo published no win-rate number, and the row says that instead of implying 0.
 */
const CLAIMS = {
  ai_vwap_momentum: { claim: '60-76% win rate (best strategy across risk profiles)', from: 'AI-trader README' },
  ai_bearish_momentum: { claim: '60-76% win rate (as part of the same set)', from: 'AI-trader README' },
  ai_mean_reversion: { claim: '60-76% win rate (as part of the same set)', from: 'AI-trader README' },
  // WITHDRAWN NUMBER (2026-09-27): this row's ESTABLISHED measurement was a FABRICATION. The port armed
  // a retracement entry without re-checking the invalidation level its stop is built from, so when the
  // pullback had already traded through that level it emitted a LONG whose stop sat ABOVE its fill — and
  // the simulator booked the first touch of that level as a stop-out paying exactly +1.0000R on the next
  // bar. Measured: 270 of 452 trades on a 6-symbol sample booked a phantom +1R with an MFE of ZERO (a win
  // the price path never offered); without them the mean R is −1.105R, and on 20 symbols × the last 43
  // sessions the honest row is 241 trades / gross −0.084R / net −0.380R / gross win 32% / PF 0.55. Same
  // failure family as liquiditySweep. `BT.simulate` now refuses a stop that is not beyond the entry in
  // the losing direction, and the port refuses a setup whose invalidation was already breached.
  nifty50_ict: { claim: '64.7% win rate', caveat: 'WITHDRAWN NUMBER: the measured ESTABLISHED row was a fabrication — retracement entries were armed without re-checking the invalidation level the stop is built from, so a breached setup produced a long whose stop sat ABOVE its fill and booked exactly +1.00R on the next bar (270 of 452 sampled trades, at an MFE of ZERO). Honest re-measurement on 20 symbols × 43 sessions: 241 trades, gross −0.084R, net −0.380R, win 32%, PF 0.55. Source caveat (unchanged): the repo states 34 trades over 2 months — too small to mean anything.', from: 'nifty50 README' },
  // The row aggregates ALL sessions with the repo's stop (opposite side of the opening range). The
  // other ORB number on this dashboard — Strategy 2 Test A — is the OOS-7 slice with a tight bucket
  // stop. They are not comparable readings of one thing, and saying so on the row is cheaper than
  // having the contradiction re-raised every session (see data/orb_reconcile.json).
  orb: { claim: 'best strategy of the set, net -Rs 3.4k over 60 days after costs', caveat: 'NOT COMPARABLE to Strategy 2 Test A: this row is ALL sessions with the repo\'s WIDE stop (opposite side of the range, median 1.49% of price); Test A is the OOS-7 slice with a TIGHT bucket stop (0.46%). Their gross R agree (-0.028 vs -0.027) and the whole visible gap is cost-in-R, which is why the win rates differ (42% vs 34%). Matched on sessions AND stop rule the two ports agree within 0.02R.', from: 'algo-trading-system README · reconciliation: data/orb_reconcile.json' },
  vwap_reversion: { claim: '22.6% win rate', from: 'algo-trading-system README' },
  ema_rsi: { claim: null, from: 'algo-trading-system (no headline number)' },
  bollinger: { claim: null, from: 'algo-trading-system (no headline number)' },
  supertrend: { claim: null, from: 'algo-trading-system (no headline number)' },
  nifty_trend: { claim: 'profit factor 1.10-1.92', caveat: 'holds up on 15-year DAILY bars; the author says the intraday version is "a friction-and-runway problem"', from: 'nifty-banknifty README' },
  // NOT the plan's Strategy 1: its gate is an OHLCV aggression PROXY and it has no POC/executed delta.
  // The claim row says so, because a row labelled "Strategy 1" in a leaderboard implies the plan's
  // hypothesis was tested and it was not (see STRATEGY_ONE_STATUS in strategies.js).
  aggShortCircuit: { claim: null, caveat: 'this is NOT the plan\'s Strategy 1 — it is an OHLCV breakout with an aggression proxy; Strategy 1 (control flips via exhausted aggression at the POC) is NOT BUILT, and the feed has no executed/aggressor side at any subscription mode — whether its only quantity pair (bq/sq) is traded-cumulative or resting-book is decided by .freebuff/verify-bqsq.js on the first captured session', from: 'user-plan-v3 proxy port, no published win-rate number' },
  liquiditySweep: {
    claim: null,
    caveat: 'WITHDRAWN NUMBER: an earlier revision of this harness reported OOS +0.201R with a bootstrap CI excluding zero and called this strategy ESTABLISHED. That was a side-naming bug, not a result — the long side was labelled so that the simulator resolved every long candidate as a SHORT, booking a CONSTANT +1.00R gross on the next bar whether the sweep held or failed (.freebuff/verify-side-bug.js reproduces it). Every post-fix measurement is negative. Separately: heavily popularised (ICT/SMC), no published number, and popularity is a RISK here: on liquid NSE names the exact swing levels everyone watches may already be crowded.',
    from: 'user-plan-v3 addendum (liquidity sweep reversal: pools -> sweep -> rejection -> flow(proxy) -> FVG -> ROC -> wick stop), no published win-rate number',
  },
  // The paper's headline is a Sharpe, not a win rate — recorded as such, because converting one into
  // the other would be a number the source never published.
  zarattini_momentum: {
    claim: 'Sharpe ratio 1.34 (net of costs, SPY 2016-2025)',
    caveat: 'a Sharpe, NOT a win rate — no win-rate number is published for this rule, and the claim is on SPY (US, T+0 settlement, 09:30-16:00) rather than NSE cash. The separate NSE run is data/zarattini_backtest.json.',
    from: 'AleksandarMilosavljevic/intraday-trading-strategy README (SSRN 24-97 baseline)',
  },
  trend_day: {
    claim: null,
    caveat: 'no published win-rate number; the source threshold (6% by 14:00) is tuned for LEVERAGED ETFs and is ported unchanged, so this row measures transfer to NSE cash, not a tuned rule.',
    from: 'quantrocket-codeload/trend-day (trend_day.py — no headline number in the repo)',
  },
  intraday_roc: {
    claim: null,
    caveat: 'NO CLAIM TO CHECK — this is this repo\'s own script, not a third-party strategy, so there is no published number to falsify. It is graded on the same tape, cost, guards and CI as every ported row. DECLARED ADAPTATION: the source ran 15-MINUTE bars; ROC thresholds are timeframe-dependent, so ported unchanged to 1-minute bars, ROC5 > 0.3% is a far weaker momentum bar and the row fires more often at worse cost-in-R. LONG ONLY by definition (the source has no short side).',
    from: 'this repo — scripts/backtestIntradayRoc.js (15-min store, 12 bps round trip)',
  },
};

/**
 * SOURCE FAMILIES — which rows came out of the same repo and the same rule set.
 *
 * WHY THIS EXISTS. Twelve rows from four sources read as twelve independent results, and they are not:
 * six of them port the same repo's rule set and three more come from one "AI" bundle. The user's
 * instruction was to stop padding the table with near-duplicates and keep one row per logic — so the
 * collapse rule has to be MEASURED, not assumed. Measured first (.freebuff/audit-metrics.js, 20 symbols
 * × 43 sessions): the highest signal-bar overlap between any two of the twelve is Jaccard 0.146
 * (ai_vwap_momentum ~ ai_mean_reversion) and NO pair reaches 0.5, i.e. not one pair fires on the same
 * bar on the same symbol. So nothing here is a duplicate SIGNAL, and nothing is dropped on those
 * grounds. What is collapsed is the ROW COUNT per source: the best net-R row of each family is the row
 * shown, and its siblings' numbers stay on it (payload `twins`) instead of being deleted.
 */
const FAMILIES = {
  nifty50_ict: { repo: 'ict-smc', logic: 'index-bias ICT/SMC retest' },
  orb: { repo: 'algo-trading-system', logic: 'opening-range breakout' },
  vwap_reversion: { repo: 'algo-trading-system', logic: 'VWAP mean reversion' },
  ema_rsi: { repo: 'algo-trading-system', logic: 'EMA + RSI trend' },
  bollinger: { repo: 'algo-trading-system', logic: 'Bollinger' },
  supertrend: { repo: 'algo-trading-system', logic: 'Supertrend trend-follow' },
  nifty_trend: { repo: 'algo-trading-system', logic: 'index trend (5-filter)' },
  ai_vwap_momentum: { repo: 'ai-bundle', logic: 'VWAP momentum' },
  ai_bearish_momentum: { repo: 'ai-bundle', logic: 'bearish momentum' },
  ai_mean_reversion: { repo: 'ai-bundle', logic: 'mean reversion' },
  // The plan's own two rows are kept as SEPARATE families on purpose: they are two different
  // hypotheses (an OHLCV aggression proxy, and the sweep reversal), not two ports of one rule set.
  aggShortCircuit: { repo: 'plan-v3-s1proxy', logic: 'aggression-proxy breakout' },
  liquiditySweep: { repo: 'plan-v3-s3', logic: 'liquidity sweep reversal' },
  // Two single-member families, each its own repo: neither shares a signal with anything else here.
  zarattini_momentum: { repo: 'intraday-trading-strategy', logic: 'checkpoint exit outside the 14-session noise area' },
  trend_day: { repo: 'trend-day', logic: 'late-day trend-day hold to the close' },
  // The repo's own buy-side script — its own family because it shares no rule with the ports above.
  intraday_roc: { repo: 'this-repo', logic: 'buy-side ROC+VWAP momentum, volume-confirmed' },
};

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, median: null, win: null, ci: null };
  return { n: arr.length, mean: BT.mean(arr), median: BT.pct(arr, 0.5), win: arr.filter((x) => x > 0).length / arr.length };
}

// ---- THE FOUR NUMBERS A DECISION NEEDS, NEXT TO THE TWO IT WAS BEING MADE ON ----
// Mean R and win rate alone cannot tell a 55%-win/1:1 system from a 35%-win/1:3 one, and neither says
// how deep the equity curve went. These are computed from the same trade list as the mean, so they
// cannot drift from it, and .freebuff/audit-metrics.js re-derives every one of them independently.
function pfOf(R) {
  let win = 0, loss = 0;
  for (const r of R) { if (r > 0) win += r; else loss += -r; }
  if (loss > 0) return +(win / loss).toFixed(3);
  return win > 0 ? 'INF' : null;      // no losing trade: a ratio with a zero denominator is not a number
}
function maxDDR(R) {
  let eq = 0, peak = 0, dd = 0;
  for (const r of R) { eq += r; if (eq > peak) peak = eq; const d = peak - eq; if (d > dd) dd = d; }
  return +dd.toFixed(2);
}
function lossStreak(R) {
  let cur = 0, worst = 0;
  for (const r of R) { if (r <= 0) { cur++; if (cur > worst) worst = cur; } else cur = 0; }
  return worst;
}

/** verdictFor(agg) — the honest label, applied in a fixed order so it cannot flatter a strategy. */
function verdictFor(trades, meanR, ci) {
  // ZERO TRADES IS ITS OWN ANSWER. Checked BEFORE the trade-count guard, because "no trades at all"
  // and "only a handful of trades" are different findings: the first says the strategy never fired
  // (a broken condition, a filter that can never be satisfied, a transcription error), the second
  // says it fired and the sample is thin. Reporting the first as the second is how a dead strategy
  // gets carried in a table as merely "promising".
  if (!trades) return { code: 'NO_TRADES', text: 'never fired — no trades at all' };
  if (trades < MIN_TRADES) return { code: 'TOO_FEW', text: 'too few trades to judge (' + trades + ' < ' + MIN_TRADES + ')' };
  if (meanR == null) return { code: 'NO_DATA', text: 'no measurable outcome' };
  if (meanR <= 0) return { code: 'NO_EDGE', text: 'no edge after costs (mean ' + meanR + 'R)' };
  if (ci && ci.lo > 0) return { code: 'ESTABLISHED', text: 'positive, and the session bootstrap excludes zero' };
  return { code: 'NOT_ESTABLISHED', text: 'positive point estimate, but the session bootstrap spans zero — not established' };
}

function main() {
  if (!fs.existsSync(DATA)) { console.error('no ' + DATA + ' — run scripts/fetchOhlcv1m.js first'); process.exit(1); }
  let files = fs.readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'NIFTY.json');
  files.sort();
  if (SAMPLE) files = files.filter((_, idx) => idx % SAMPLE === 0);
  if (LIMIT) files = files.slice(0, LIMIT);

  const niftyMap = BT.niftySeries();
  const activeStrats = G.STRATEGIES.filter((s) => !IDS.length || IDS.includes(s.id));
  console.log('symbols ' + files.length + ' · nifty bars ' + niftyMap.size + ' · cost ' + COST_PCT + '% round trip · ' + activeStrats.length + ' strategies' + (SIDE_FILTER ? ' · side=' + SIDE_FILTER : ''));

  // One accumulator per strategy. Trades carry their session and their signed forward returns.
  const acc = {};
  for (const sDef of G.STRATEGIES) if (!IDS.length || IDS.includes(sDef.id)) acc[sDef.id] = { def: sDef, trades: [], bySession: {}, fwd: { f5: [], f15: [], f30: [] }, refused: 0, refusedCrossSession: 0, cohorts: { full: [], thin: [] } };

  // ---- THE TAPE'S OWN CALENDAR, and the per-symbol coverage inside it ----
  // The tape is not the same shape for every symbol: 83% of them carry the full calendar while 16.5%
  // were added late and carry ~21 sessions (data/tape_coverage.json). A mean over both silently mixes
  // two populations — and the thin ones exist ONLY inside the out-of-sample window, so part of every
  // OOS read is a read of a different universe. Each trade is tagged with its symbol's coverage and
  // the payload reports the cohorts apart, so the mix is visible instead of absorbed.
  let CAL_SESSIONS = 0;
  try {
    const nj = BT.load('NIFTY');
    if (nj && Array.isArray(nj.candles)) {
      const set = new Set();
      for (const b of nj.candles) set.add(BT.sessionOf(b));
      CAL_SESSIONS = set.size;
    }
  } catch (e) { /* no calendar: cohorts are reported as 'unknown' rather than guessed */ }
  const countSessions = (bars) => {
    let n = 0, last = null;
    for (let i = 0; i < bars.length; i++) { const d = BT.sessionOf(bars[i]); if (d !== last) { n++; last = d; } }
    return n;
  };
  let skippedThin = 0;

  const t0 = Date.now();
  let scanned = 0, misaligned = 0;

  const progressFile = path.join(ROOT, 'data', 'github_strategies.progress.json');
  const partialOut = path.join(ROOT, 'data', 'github_strategies.partial.json');
  function reportProgress() {
    const elapsed = (Date.now() - t0) / 1000;
    const rate = scanned / Math.max(1e-9, elapsed);
    const eta = (files.length - scanned) / Math.max(1e-9, rate);
    let trades = 0;
    for (const s of activeStrats) trades += acc[s.id] ? acc[s.id].trades.length : 0;
    console.log('  ... ' + scanned + '/' + files.length + ' symbols · ' + elapsed.toFixed(0) + 's elapsed · ETA '
      + eta.toFixed(0) + 's · trades so far ' + trades);
    try {
      fs.writeFileSync(progressFile, JSON.stringify({
        at: new Date().toISOString(), scanned, total: files.length, elapsedSec: +elapsed.toFixed(1),
        symbolsPerSec: +rate.toFixed(2), etaSec: +eta.toFixed(1), tradesSoFar: trades,
        perStrategy: Object.fromEntries(activeStrats.map((s) => [s.id, { trades: acc[s.id] ? acc[s.id].trades.length : 0, refused: acc[s.id] ? acc[s.id].refused : 0 }])),
      }, null, 1));
    } catch (e) { /* progress is best-effort and must never break the run */ }
    if (PARTIAL_EVERY && scanned % PARTIAL_EVERY === 0) {
      const p = assemble(true);
      try {
        fs.mkdirSync(path.dirname(partialOut), { recursive: true });
        fs.writeFileSync(partialOut, JSON.stringify(p, null, 1));
        console.log('    partial table (NOT the answer — ' + scanned + '/' + files.length + ' symbols): ' + partialOut);
      } catch (e) { /* same */ }
    }
  }

  for (const f of files) {
    const symbol = f.replace(/\.json$/, '');
    const j = BT.load(symbol);
    if (!j) continue;
    const bars = j.candles;
    if (bars.length < WARMUP + 60) continue;
    const nbars = IND.norm(bars);
    if (nbars.length < WARMUP + 60) continue;
    // ---- INDEX ALIGNMENT IS A CORRECTNESS REQUIREMENT, NOT A CONVENIENCE ----
    // The indicator strategies read OBJECT bars (nbars) while the shared simulator and the forward
    // returns read ARRAY bars (bars) — they are two views of one series and every index must mean
    // the same bar in both. `norm()` DROPS bars it cannot use, so one dropped bar would shift every
    // index after it and let a strategy "enter" on a bar whose price the simulator reads from a
    // different minute. That failure is silent and would look like an edge, so the symbol is
    // refused and counted instead.
    if (nbars.length !== bars.length) { misaligned++; continue; }
    const symSessions = countSessions(bars);
    if (MIN_SESSIONS && symSessions < MIN_SESSIONS) { skippedThin++; continue; }
    const cohort = !CAL_SESSIONS ? 'unknown' : (symSessions >= CAL_SESSIONS * 0.9 ? 'full' : 'thin');
    scanned++;

    for (const strat of G.STRATEGIES) {
      if (!acc[strat.id]) continue;          // --ids filter: strategy not in this run
      let state;
      try { state = strat.init(nbars); } catch (e) { continue; }
      const a = acc[strat.id];
      let open = null;                       // one position at a time per symbol, as in the harness
      for (let i = WARMUP; i < nbars.length - 2; i++) {
        if (open && i - open.i < open.hold) continue;
        let cand;
        try { cand = strat.at(nbars, i, state); } catch (e) { continue; }
        if (!cand) continue;
        if (SIDE_FILTER) { const sg = BT.sideSign(cand.side); if (SIDE_FILTER === 'SHORT' && sg !== -1) continue; if (SIDE_FILTER === 'LONG' && sg !== 1) continue; }
        // THE RISK GUARD, BEFORE THE SIMULATION. Refusing here (rather than filtering the results
        // afterwards) means a refused candidate cannot influence the trade sequence at all: it never
        // occupies the "one position at a time" slot, so the next real signal is evaluated on its
        // own merits.
        const entryPx = cand.entry != null ? cand.entry : bars[i][4];
        const riskPct = entryPx > 0 ? (Math.abs(entryPx - cand.stop) / entryPx) * 100 : 0;
        if (!(riskPct >= MIN_RISK_PCT) || riskPct > MAX_RISK_PCT) { a.refused++; continue; }
        // A candidate whose fill lands in the NEXT session is refused by the simulator (there is no
        // trade there — it would book exactly −costR). Counted HERE as well, so the refusal is visible
        // in the table instead of looking like a strategy that simply did not fire.
        if (i + 1 < bars.length && BT.sessionOf(bars[i + 1]) !== BT.sessionOf(bars[i])) { a.refusedCrossSession++; continue; }
        const r = BT.simulate(bars, i, Object.assign({}, cand, { tagsOk: null }), COST_PCT);
        if (!r) continue;
        const sess = BT.sessionOf(bars[i]);
        // the sign goes through the harness's own side mapper: a candidate labelled 'LONG' was being
        // scored as a SHORT here too, which inverted every forward-return statistic for that strategy
        const sign = BT.sideSign(cand.side) || 1;
        const f5 = BT.forwardReturn(bars, i, 5, niftyMap);
        const f15 = BT.forwardReturn(bars, i, 15, niftyMap);
        const f30 = BT.forwardReturn(bars, i, 30, niftyMap);
        a.trades.push(Object.assign({ symbol, session: sess, at: bars[i][0], setup: cand.setup, reason: cand.reason, side: cand.side, cohort }, r));
        (a.bySession[sess] = a.bySession[sess] || []).push(r.R);
        if (cohort === 'full') a.cohorts.full.push(r.R); else if (cohort === 'thin') a.cohorts.thin.push(r.R);
        if (f5) a.fwd.f5.push(f5.adjusted * sign);
        if (f15) a.fwd.f15.push(f15.adjusted * sign);
        if (f30) a.fwd.f30.push(f30.adjusted * sign);
        open = { i, hold: Math.max(1, r.barsHeld) };
      }
    }
    if (PROGRESS_EVERY && scanned % PROGRESS_EVERY === 0) reportProgress();
  }
  const ms = Date.now() - t0;
  console.log('evaluated ' + scanned + ' symbols in ' + (ms / 1000).toFixed(1) + 's'
    + (misaligned ? ' (' + misaligned + ' refused: norm() would have shifted the bar indices)' : ''));

  // ---- aggregate + rank ----
  // Built by a FUNCTION so the partial writer above can call it mid-run; `isPartial` marks the
  // result so a half-finished ranking can never be read as a finished one.
  function assemble(isPartial) {
  const rows = [];
  for (const sId of Object.keys(acc)) {
    const a = acc[sId];
    const s = a.def;
    const T = a.trades;
    const R = T.map((t) => t.R);
    const st = stats(R);
    const Gs = T.map((t) => t.grossR);
    const ci = BT.sessionCI(a.bySession);
    const ciSessionMean = BT.sessionMeanCI(a.bySession);
    const sessionDays = Object.keys(a.bySession);
    const wins = R.filter((x) => x > 0), losses = R.filter((x) => x <= 0);
    // the equity curve in TIME order (trades are collected symbol by symbol, so the raw list is not
    // chronological — a drawdown read off it would be an artefact of the file order)
    const timeOrdered = T.map((t) => ({ at: t.at, R: t.R })).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).map((x) => x.R);
    const claim = CLAIMS[s.id] || { claim: null, from: s.repo };
    rows.push({
      id: s.id,
      name: s.name,
      repo: s.repo,
      source: s.source,
      exitSource: s.exitSource,
      adaptation: s.adaptation || null,
      reduced: !!s.reduced,
      trades: T.length,
      winRate: st.win == null ? null : +st.win.toFixed(3),
      meanR: st.mean == null ? null : +st.mean.toFixed(3),
      medianR: st.median == null ? null : +st.median.toFixed(3),
      meanGrossR: T.length ? +BT.mean(T.map((t) => t.grossR)).toFixed(3) : null,
      meanCostR: T.length ? +BT.mean(T.map((t) => t.costR)).toFixed(3) : null,
      meanNetPct: T.length ? +BT.mean(T.map((t) => t.netPct)).toFixed(3) : null,
      stopRate: T.length ? +(T.filter((t) => /stop/.test(t.reason)).length / T.length).toFixed(3) : null,
      targetRate: T.length ? +(T.filter((t) => t.reason === 'target').length / T.length).toFixed(3) : null,
      policyExitRate: T.length ? +(T.filter((t) => /policy/.test(t.reason)).length / T.length).toFixed(3) : null,
      // ---- the numbers the strategy table was missing ----
      grossWinRate: Gs.length ? +(Gs.filter((x) => x > 0).length / Gs.length).toFixed(3) : null,
      netWinRate: st.win == null ? null : +st.win.toFixed(3),
      profitFactor: pfOf(R),
      profitFactorGross: pfOf(Gs),
      avgWinR: wins.length ? +BT.mean(wins).toFixed(3) : null,
      avgLossR: losses.length ? +BT.mean(losses).toFixed(3) : null,
      expectancyR: st.mean == null ? null : +st.mean.toFixed(4),
      maxDrawdownR: R.length ? maxDDR(timeOrdered) : null,
      longestLossStreak: R.length ? lossStreak(timeOrdered) : null,
      // a trade that leaves at exactly its entry price: gross 0, full cost paid. A high share means the
      // exit policy (a break-even ratchet) is what the gross R mostly measures, not the signals.
      flatExitShare: T.length ? +(T.filter((t) => t.grossR === 0 && t.exitPx === t.entry).length / T.length).toFixed(3) : null,
      // ---- the excursion cross-check (redundant by design; see raschke/backtest.js) ----
      meanMFER: T.length ? +BT.mean(T.map((t) => t.mfeR)).toFixed(3) : null,
      medianMFER: T.length ? +BT.pct(T.map((t) => t.mfeR), 0.5).toFixed(3) : null,
      shareMFE1R: T.length ? +(T.filter((t) => t.mfeR >= 1).length / T.length).toFixed(3) : null,
      meanMAER: T.length ? +BT.mean(T.map((t) => t.maeR)).toFixed(3) : null,
      // how much of the best excursion the exit gives back, in R: the single number that separates
      // "the entry finds the move" from "the exit keeps it"
      excursionGiveBackR: T.length ? +(BT.mean(T.map((t) => t.mfeR)) - BT.mean(T.map((t) => t.grossR))).toFixed(3) : null,
      cohorts: {
        full: a.cohorts.full.length ? { trades: a.cohorts.full.length, meanR: +BT.mean(a.cohorts.full).toFixed(4), win: +(a.cohorts.full.filter((x) => x > 0).length / a.cohorts.full.length).toFixed(3) } : null,
        thin: a.cohorts.thin.length ? { trades: a.cohorts.thin.length, meanR: +BT.mean(a.cohorts.thin).toFixed(4), win: +(a.cohorts.thin.filter((x) => x > 0).length / a.cohorts.thin.length).toFixed(3) } : null,
      },
      refusedCrossSession: a.refusedCrossSession,
      rCI: ci,
      rCI_sessionMean: ciSessionMean,
      positiveSessions: sessionDays.filter((d) => BT.mean(a.bySession[d]) > 0).length,
      // per-session mean R, for the mix/diversification analysis (session P&L correlations between
      // strategies). Small: one number per session, not per trade.
      sessionMeanR: Object.fromEntries(sessionDays.map((d) => [d, +BT.mean(a.bySession[d]).toFixed(4)])),
      sessions: sessionDays.length,
      meanF5: a.fwd.f5.length ? +BT.mean(a.fwd.f5).toFixed(4) : null,
      meanF15: a.fwd.f15.length ? +BT.mean(a.fwd.f15).toFixed(4) : null,
      meanF30: a.fwd.f30.length ? +BT.mean(a.fwd.f30).toFixed(4) : null,
      // how many signals this strategy produced that the risk band refused — a strategy whose
      // signals are mostly degenerate stops is a strategy that was never tradeable at this cost
      refusedDegenerateRisk: a.refused,
      signalled: T.length + a.refused + a.refusedCrossSession,
      claim: claim.claim,
      claimCaveat: claim.caveat || null,
      claimFrom: claim.from || null,
    });
  }
  for (const r of rows) r.verdict = verdictFor(r.trades, r.meanR, r.rCI);

  // RANKED BY NET MEAN R over strategies that produced trades. The verifier below decides whether
  // the top row is allowed to be CALLED the best.
  const ranked = rows.slice().sort((x, y) => (y.meanR == null ? -99 : y.meanR) - (x.meanR == null ? -99 : x.meanR));
  ranked.forEach((r, i) => { r.rank = i + 1; });

  // ---- one row per source family, the family's best net-R row as the representative ----
  const families = {};
  for (const r of ranked) {
    const f = FAMILIES[r.id] || { repo: 'unknown', logic: r.id };
    r.repoFamily = f.repo;
    r.logicFamily = f.logic;
    (families[f.repo] = families[f.repo] || []).push(r.id);
  }
  for (const idsInFam of Object.values(families)) {
    const famRows = idsInFam.map((id) => ranked.find((r) => r.id === id));
    const judgeable = famRows.filter((r) => r.verdict.code !== 'NO_TRADES' && r.verdict.code !== 'TOO_FEW');
    const pool = judgeable.length ? judgeable : famRows;
    const bestRow = pool.slice().sort((x, y) => (y.meanR == null ? -99 : y.meanR) - (x.meanR == null ? -99 : x.meanR))[0];
    for (const r of famRows) {
      r.groupBest = r.id === bestRow.id;
      r.twins = famRows.filter((x) => x.id !== r.id).map((x) => ({ id: x.id, logic: x.logicFamily, meanR: x.meanR, trades: x.trades, verdict: x.verdict.code }));
    }
  }
  const eligible = ranked.filter((r) => r.verdict.code === 'ESTABLISHED');
  // A strategy that never fired, or fired too rarely to judge, is not a "best" of anything.
  const judgeable = ranked.filter((r) => r.verdict.code !== 'NO_TRADES' && r.verdict.code !== 'TOO_FEW');
  const best = eligible.length ? eligible[0].id : (judgeable.length ? judgeable[0].id : null);

  const payload = {
    at: new Date().toISOString(),
    partial: !!isPartial,
    progress: { symbolsScanned: scanned, symbolsTotal: files.length, elapsedMs: Date.now() - t0 },
    costPct: COST_PCT,
    symbols: scanned,
    misaligned,
    minTrades: MIN_TRADES,
    riskBand: { min: MIN_RISK_PCT, max: MAX_RISK_PCT },
    tape: {
      calendarSessions: CAL_SESSIONS || null,
      minSessionsFilter: MIN_SESSIONS || null,
      skippedThin,
      cohortRule: 'full = at least 90% of the tape calendar; thin = the rest (they were added late and exist only inside the out-of-sample window)',
      coverageArtifact: 'data/tape_coverage.json',
    },
    strategies: ranked.length,
    ranked,
    best,
    bestEstablished: eligible.length ? eligible[0].id : null,
    note: eligible.length
      ? 'ranked by net mean R; the top row also clears the session bootstrap, so it is marked established'
      : 'no strategy cleared both the trade-count and the session-bootstrap guards — the ranking is a ranking of estimates, not of established edges',
    notPortable: G.NOT_PORTABLE,
    families,
    strategyOne: G.STRATEGY_ONE_STATUS,
    method: {
      fills: 'signal at the close of bar i, entry at the OPEN of bar i+1',
      intrabar: 'when one bar contains both the stop and the target, the STOP is assumed hit first',
      costs: COST_PCT + '% round trip charged on every trade; gross and net both reported',
      riskBand: 'candidates whose structural stop is < ' + MIN_RISK_PCT + '% or > ' + MAX_RISK_PCT + '% of price are refused before simulation and counted',
      session: 'a trade must exit before its session ends; one position at a time per symbol; a candidate whose fill would land in the next session is REFUSED (it is not a trade, it is a cost-paying artifact) and counted',
      significance: 'bootstrap CI over SESSIONS (trades within a day are not independent), CLUSTER resampled (sessions drawn, their trades pooled) so the interval brackets the trade-weighted mean R that is reported; rCI_sessionMean keeps the older mean-of-session-means statistic for comparison; the bootstrap is seeded, so a verdict is reproducible',
      excursion: 'mfeR/maeR are measured off each held bar\'s own high/low in units of risk and are NOT used by any decision — they make the exit bookkeeping checkable (grossR <= mfeR, grossR >= -maeR). excursionGiveBackR = meanMFER - meanGrossR: how much of the best excursion the exit hands back.',
      drawdown: 'maxDrawdownR is the deepest peak-to-trough fall of the cumulative-R curve in TIME order, not file order',
      duplicateRule: 'rows are collapsed by SOURCE FAMILY (same repo, same rule set): the family\'s best net-R row is shown and the siblings\' numbers are carried on it in `twins`. Signal overlap was measured first (max Jaccard 0.146 over 20 symbols × 43 sessions, .freebuff/audit-metrics.js) — no pair of rows fires on the same bar, so nothing was dropped as a duplicate signal.',
    },
  };

  return payload;
  }   // ---- end assemble ----

  const payload = assemble(false);
  const ranked = payload.ranked;
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(payload, null, 1)); }
  catch (e) { console.log('could not write ' + OUT + ': ' + e.message); }

  // ---- the table ----
  console.log('\n=== EXTERNAL STRATEGIES — NSE 1m, ' + COST_PCT + '% round trip, ' + scanned + ' symbols ===');
  console.log('rank  strategy              trades  grossWin netWin  grossR   costR    netR    PF    maxDD   CI(low,high)      verdict');
  for (const r of ranked) {
    const ci = r.rCI ? '[' + String(r.rCI.lo).padStart(6) + ',' + String(r.rCI.hi).padStart(6) + ']' : '        n/a      ';
    console.log(
      String(r.rank).padStart(4) + '  ' + r.id.padEnd(20) +
      String(r.trades).padStart(6) + '  ' +
      (r.grossWinRate == null ? '   -  ' : (r.grossWinRate * 100).toFixed(1).padStart(6)) + '  ' +
      (r.winRate == null ? '  -  ' : (r.winRate * 100).toFixed(1).padStart(5)) + '  ' +
      (r.meanGrossR == null ? '   -  ' : String(r.meanGrossR).padStart(7)) + '  ' +
      (r.meanCostR == null ? '  -  ' : String(r.meanCostR).padStart(6)) + '  ' +
      (r.meanR == null ? '  -  ' : String(r.meanR).padStart(6)) + '  ' +
      (r.profitFactor == null ? '  - ' : String(r.profitFactor).padStart(5)) + '  ' +
      (r.maxDrawdownR == null ? '  -  ' : String(r.maxDrawdownR).padStart(6)) + '  ' +
      ci + '  ' + r.verdict.code
    );
  }
  const refused = ranked.filter((r) => r.refusedDegenerateRisk).map((r) => r.id + ' ' + r.refusedDegenerateRisk);
  if (refused.length) console.log('\nrefused on degenerate risk (<' + MIN_RISK_PCT + '% or >' + MAX_RISK_PCT + '% stop): ' + refused.join(' · '));
  const xref = ranked.filter((r) => r.refusedCrossSession).map((r) => r.id + ' ' + r.refusedCrossSession);
  if (xref.length) console.log('refused as cross-session fills (signal on the session\'s last bar, fill on the next session\'s first — NOT trades): ' + xref.join(' · '));
  if (CAL_SESSIONS) console.log('tape calendar ' + CAL_SESSIONS + ' sessions' + (skippedThin ? ' · ' + skippedThin + ' symbols skipped by --minSessions=' + MIN_SESSIONS : '') + ' · cohorts per row: full (>= ' + Math.round(CAL_SESSIONS * 0.9) + ' sessions) vs thin');
  console.log('collapsed by source family (twins carried on the surviving row): ' + Object.entries(payload.families || {}).filter(([, ids]) => ids.length > 1).map(([fam, ids]) => fam + ' ' + ids.length + '→1').join(' · '));
  console.log('excursion cross-check (meanMFE → net grossR · give-back · share that ever reached +1R): '
    + ranked.filter((r) => r.meanMFER != null).slice(0, 5).map((r) => r.id + ' ' + r.meanMFER + 'R → ' + r.meanGrossR + 'R · ' + r.excursionGiveBackR + 'R · ' + (r.shareMFE1R * 100).toFixed(0) + '%').join(' · '));
  const flat = ranked.filter((r) => r.flatExitShare != null && r.flatExitShare > 0.35).map((r) => r.id + ' ' + (r.flatExitShare * 100).toFixed(0) + '%');
  if (flat.length) console.log('flat-exit clustering (>35% of trades leave at exactly their entry price — the break-even ratchet is what gross R mostly measures): ' + flat.join(' · '));
  console.log('\nBEST: ' + (payload.best || 'none') + (payload.bestEstablished ? ' (established)' : ' (no strategy cleared both guards)'));
  console.log('\nclaim vs measurement:');
  for (const r of ranked) {
    if (!r.claim) { console.log('  ' + r.id.padEnd(20) + ' no published number'); continue; }
    console.log('  ' + r.id.padEnd(20) + ' claimed: ' + String(r.claim).slice(0, 58));
    console.log('  ' + ' '.repeat(20) + ' measured: win ' + (r.winRate == null ? 'n/a' : (r.winRate * 100).toFixed(1) + '%') + ' · net ' + r.meanR + 'R over ' + r.trades + ' trades');
    if (r.claimCaveat) console.log('  ' + ' '.repeat(20) + ' source caveat: ' + r.claimCaveat);
  }
  console.log('\nnot ported:');
  for (const n of G.NOT_PORTABLE) console.log('  ' + n.repo + ' — ' + n.reason.slice(0, 100) + '...');
  console.log('\nwritten: ' + OUT);
}

if (require.main === module) main();
module.exports = { main, CLAIMS, verdictFor, pfOf, maxDDR, lossStreak, stats };
