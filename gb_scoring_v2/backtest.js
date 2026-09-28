/**
 * gb_scoring_v2/backtest.js — BACKTESTING THE GATE LOGIC, HONESTLY.
 *
 * WHAT THIS IS FOR. `data/signal_ledger.json` is the only historical store that
 * carries BOTH the snapshot fields the gates read AND a forward outcome per row,
 * so it is the only place the gate layer can be replayed against real outcomes.
 * This script runs the Phase 4 gates over every ledger row and asks one question:
 *
 *     do the rows the gates BLOCK have worse forward outcomes than the rows they
 *     let through?
 *
 * WHAT THIS IS NOT. It is NOT the Section 21 validation, and the report says so
 * loudly. Section 21.1 requires a pre-registered primary metric, Section 21.2 a
 * day-level resampled confidence interval, and Section 21.3 four baselines. None
 * of those are computable from this data, for reasons the report prints:
 *
 *   * the ledger is ONE session (2026-09-24). With one day there is no
 *     across-session average and no day-level confidence interval at all.
 *   * only 509 of 10,508 rows have a resolved numeric outcome (firstHit is "none"
 *     for 9,972) -- the outcome writer did not fill most of them.
 *   * the ledger ROW has no ATR% and no 20-day volume, but the adapter MERGES the
 *     funnel's quality set, which supplies both for 392 of the 400 resolved episodes
 *     (measured 25-Sep). So the LIQUIDITY gate IS runnable on history, and so is the
 *     volatility-normalized momentum of Phase 5 -- an earlier version of this comment
 *     claimed otherwise and was simply wrong. What is genuinely absent is market cap,
 *     turnover and (as ever) the caveat that the quality file is a same-day artifact.
 *   * candle context (gap, pattern, candle trend) is written nowhere in the ledger:
 *     measured 0/10,508 rows. That component is NOT-RUNNABLE on history until the
 *     snapshot recorder stores it, which it now does.
 *   * there is no NIFTY series here, so returns are GROSS, not market-adjusted.
 *
 * A backtest that hides those four facts is worse than no backtest, because it
 * launders one session of 5%-resolved data into something that looks like evidence.
 * The point of running it anyway is to prove the harness works end to end, to
 * measure how much data the real validation needs, and to see whether the gate
 * logic shows any separation worth pursuing.
 */
const fs = require('fs');
const path = require('path');
const { CONFIG, hash } = require('./config/index');
const { runGates } = require('./gates');
const { toSnapshot } = require('./adapter/snapshot');
const { isKnown } = require('./adapter/provenance');
const adapter = require('./adapter');

const LEDGER = path.join(__dirname, '..', 'data', 'signal_ledger.json');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')).rows || []; } catch (_) { return []; }
}

/**
 * rowToSnapshot(row) — replay a LEDGER row through the SAME snapshot normalizer the
 * live path uses. Anything the ledger does not carry stays null, which is the whole
 * point: the gates must see the same absence the live path would see.
 */
function rowToSnapshot(r, quality, screened) {
  const mapped = {
    symbol: r.symbol,
    ltp: r.ltp,
    s10: num(r.s10), s15: null, s20: num(r.s20), s30: num(r.s30),
    roc1: num(r.roc1), roc3: num(r.roc3), roc5: num(r.roc5), roc15: num(r.roc15), roc60: null,
    flowBias: num(r.flowBias),
    volume: null, volX: num(r.volX), volRoc: num(r.volRoc),
    totBuy: null, totSell: null,
    vwap: num(r.vwap), vwapDrift: null, poc: num(r.poc), vaHigh: num(r.vaHigh), vaLow: num(r.vaLow),
    // MEASURED present on 10,508/10,508 ledger rows. Without these the Phase-9
    // location engine is blind on history for no reason.
    posInRange: num(r.posInRange), vwapStack: isKnown(r.vwapStack) ? r.vwapStack : null,
    camZone: isKnown(r.camZone) ? r.camZone : null,
    // Candle context is genuinely ABSENT from the ledger: gap, candlePattern and
    // candleTrend are written nowhere historical (measured 0/10,508). Left null so the
    // module reports NOT-RUNNABLE instead of inventing a candle.
    gap: null, gapTxt: null, candlePattern: null, candleTrend: null, candlesAgree: null, swingAgree: null,
    // The ledger carries `structure` as prose ("BIG SELLING"), not a 1m/5m/15m set,
    // so the structure group is genuinely unavailable -- it is NOT filled in.
    candleTrend: null, swingAgree: null, market: null,
    daily: { atrPct: null }, dayPct: null, dayValue: null,
    engine: r.label || r.signal || null, phase: null,
    givenAt: r.time, tickOnly: false,
  };
  return toSnapshot(mapped, { receiptTs: Date.parse(r.time) || Date.now(), quality: quality || null, screened: screened || null });
}

/** Direction from the ledger's own sign record, never guessed from the outcome. */
function directionOf(r) {
  if (num(r.dirSign) === 1) return 'LONG';
  if (num(r.dirSign) === -1) return 'SHORT';
  if (r.signal === 'BUY') return 'LONG';
  if (r.signal === 'SHORT') return 'SHORT';
  return null;
}

/**
 * Deduplicate into EPISODES (spec Section 19 / 21.2). A 10-second scanner
 * rediscovers the same setup repeatedly, so counting rows would multiply one
 * market event by however many scans happened to look at it. The unit here is
 * symbol + direction + 5-minute bucket.
 */
function dedupeEpisodes(rows) {
  const seen = new Map();
  for (const r of rows) {
    const t = Date.parse(r.time);
    if (!Number.isFinite(t)) continue;
    const bucket = Math.floor(t / (5 * 60000));
    const key = r.symbol + '|' + (directionOf(r) || 'N') + '|' + bucket;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

function stats(vals) {
  const a = vals.filter((v) => v != null);
  if (!a.length) return { n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  const mean = a.reduce((p, c) => p + c, 0) / a.length;
  const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / Math.max(1, a.length - 1));
  return {
    n: a.length, mean: +mean.toFixed(4), median: +s[Math.floor(a.length / 2)].toFixed(4),
    sd: +sd.toFixed(4), se: +(sd / Math.sqrt(a.length)).toFixed(4),
    // A crude 95% band. NOT the spec's resampled session interval -- see the report.
    ci95: [+(mean - 1.96 * sd / Math.sqrt(a.length)).toFixed(4), +(mean + 1.96 * sd / Math.sqrt(a.length)).toFixed(4)],
    min: s[0], max: s[a.length - 1],
  };
}
function hitRate(vals) {
  const a = vals.filter((v) => v != null);
  if (!a.length) return { n: 0 };
  return { n: a.length, hit: +(a.filter((v) => v > 0).length / a.length).toFixed(3) };
}

function run(opts = {}) {
  const rows = loadLedger();
  const quality = adapter.loadQuality();
  const screened = adapter.loadScreened();
  const episodeRows = opts.dedupe === false ? rows : dedupeEpisodes(rows);

  const groups = new Map();
  const bump = (name, r) => { if (!groups.has(name)) groups.set(name, { name, rows: [] }); groups.get(name).rows.push(r); };

  let resolved = 0, scanned = 0;
  for (const r of episodeRows) {
    const s = rowToSnapshot(r, quality.get(String(r.symbol || '').toUpperCase()), screened.get(String(r.symbol || '').toUpperCase()));
    if (!s) continue;
    scanned++;
    // The audit's own clock cannot be the row's clock: GATE_TIME would reject every
    // historical row recorded outside the current minute. Use the row's own time.
    const res = runGates(s, {
      direction: directionOf(r),
      now: Date.parse(r.time) || Date.now(),
      receiptTs: Date.parse(r.time) || Date.now(),
      market: null, banned: [],
    });
    const verdict = res.blockedBy ? 'BLOCKED:' + res.blockedBy : 'not-blocked';
    bump(verdict, r);
    bump('ALL', r);
    if (r.outcome) resolved++;
  }

  // The old engine's own gate-style label, as an independent baseline (Section 21.3).
  const labelGroups = new Map();
  for (const r of episodeRows) {
    const k = 'label:' + (r.label || '(none)');
    if (!labelGroups.has(k)) labelGroups.set(k, []);
    labelGroups.get(k).push(r);
  }

  const describe = (rs) => {
    const out = rs.map((r) => r.outcome).filter(Boolean);
    return {
      rows: rs.length,
      resolved: out.filter((o) => num(o.m5) != null || num(o.rMultiple) != null || num(o.mfe) != null).length,
      m5: stats(out.map((o) => num(o.m5))),
      rMultiple: stats(out.map((o) => num(o.rMultiple))),
      rHit: hitRate(out.map((o) => num(o.rMultiple))),
      mfe: stats(out.map((o) => num(o.mfe))),
      mae: stats(out.map((o) => num(o.mae))),
    };
  };

  // RESOLVED means a real number, not merely an outcome object. The distinction is
  // the difference between "we wrote a placeholder" and "we know what happened".
  const isResolved = (r) => !!r.outcome && (num(r.outcome.m5) != null || num(r.outcome.rMultiple) != null || num(r.outcome.mfe) != null);
  const resolvedRows = episodeRows.filter(isResolved);

  // SELECTION BIAS CHECK. This is the question that decides whether ANY comparison
  // below means anything: are the rows with outcomes a fair sample of the rows, or
  // only the ones some earlier filter already liked? If outcomes exist for a strict
  // subset of labels, then "blocked rows have no outcome" is not a missing value --
  // it is the bias itself, and the backtest cannot answer the question it was built
  // to answer no matter how many sessions accumulate.
  const labelsAll = {}, labelsResolved = {};
  for (const r of episodeRows) { const k = r.label || '(none)'; labelsAll[k] = (labelsAll[k] || 0) + 1; }
  for (const r of resolvedRows) { const k = r.label || '(none)'; labelsResolved[k] = (labelsResolved[k] || 0) + 1; }
  const labelsTotal = Object.keys(labelsAll).length;
  const labelsWithOutcomes = Object.keys(labelsResolved).length;
  const resolvedShare = episodeRows.length ? +(resolvedRows.length / episodeRows.length).toFixed(4) : 0;
  const selectionBias = {
    labelsTotal, labelsWithOutcomes,
    confinedToSubset: labelsWithOutcomes < labelsTotal,
    perLabel: Object.keys(labelsAll).sort((a, b) => labelsAll[b] - labelsAll[a]).map(k => ({
      label: k, episodes: labelsAll[k], resolved: labelsResolved[k] || 0,
      share: +(((labelsResolved[k] || 0) / labelsAll[k])).toFixed(3),
    })),
  };

  return {
    kind: 'gate-logic-backtest',
    configHash: hash(),
    source: 'data/signal_ledger.json',
    scanned, episodes: episodeRows.length,
    rawRows: rows.length,
    resolvedWithAnyOutcome: resolved,
    resolvedNumeric: resolvedRows.length,
    resolvedShare,
    selectionBias,
    sessions: [...new Set(rows.map((r) => String(r.time || '').slice(0, 10)))],
    groups: [...groups.values()].map((g) => Object.assign({ name: g.name }, describe(g.rows))),
    labelBaseline: [...labelGroups.entries()].map(([k, rs]) => Object.assign({ name: k }, describe(rs))).sort((a, b) => b.rows - a.rows),
    // What the gate layer could NOT evaluate, and why -- printed, never implied.
    unrunnableOnThisData: {
      liquidity: 'market cap and turnover are absent; ATR% and 20d volume ARE merged from the quality set for 392/400 resolved episodes (corrected 25-Sep)',
      candles: 'gap / candlePattern / candleTrend are written nowhere in the ledger (measured 0/10508) -> candle context is NOT-RUNNABLE on history',
      spread: 'no bid/ask in the ledger',
      latency: 'no exchange timestamps in the ledger',
      priceBand: 'no circuit band in the ledger',
      event: 'no event flags in the ledger',
      cost: 'cost parameters unset by design (spec: no hard-coded fees)',
      exclusion: 'no surveillance feed',
    },
  };
}

function report(res) {
  const L = [];
  L.push('GATE-LOGIC BACKTEST  ·  config ' + res.configHash);
  L.push('source: ' + res.source + '  ·  sessions: ' + res.sessions.join(', '));
  L.push('');
  L.push('!! DATA SUFFICIENCY AND BIAS — READ BEFORE ANY NUMBER BELOW');
  L.push('   sessions present ........ ' + res.sessions.length + '  (the spec needs >= 15 for a day-level interval)');
  L.push('   ledger rows ............. ' + res.rawRows);
  L.push('   deduped episodes ........ ' + res.episodes);
  L.push('   outcome OBJECT present .. ' + res.resolvedWithAnyOutcome + '  (' + (100 * res.resolvedWithAnyOutcome / Math.max(1, res.rawRows)).toFixed(1) + '%)  <- placeholder, mostly null fields');
  L.push('   RESOLVED numeric outcome  ' + res.resolvedNumeric + '  (' + (100 * res.resolvedShare).toFixed(1) + '% of episodes)  <- the only rows a result can come from');
  if (res.selectionBias.confinedToSubset) {
    L.push('');
    L.push('   *** SELECTION BIAS — THIS IS THE BLOCKER, NOT THE SAMPLE SIZE ***');
    L.push('   Outcomes exist for only ' + res.selectionBias.labelsWithOutcomes + ' of ' + res.selectionBias.labelsTotal + ' labels:');
    for (const p of res.selectionBias.perLabel) L.push('     ' + p.label.padEnd(22) + String(p.episodes).padStart(6) + ' episodes' + String(p.resolved).padStart(6) + ' resolved  (' + (100 * p.share).toFixed(0) + '%)');
    L.push('   The resolved set is NOT a sample of the board — it is the old engine\'s own');
    L.push('   accepted bucket. Every other label has ZERO resolved outcomes, so "did the');
    L.push('   gates block the losers?" is UNANSWERABLE here: the blocked rows have no');
    L.push('   outcome to be losers with. More sessions will not fix this. Only recording');
    L.push('   outcomes for BLOCKED and WATCH candidates fixes it (Spec Section 23: log');
    L.push('   every candidate, including WATCH and BLOCKED).');
  }
  L.push('');
  L.push('   -> ONE session. No across-session average, no resampled interval, no market');
  L.push('      adjustment. HARNESS CHECK ONLY — it cannot promote anything.');
  L.push('');
  L.push('outcome by gate verdict (episodes, m5 = forward 5-min % return, r = rMultiple)');
  L.push('  group'.padEnd(34) + 'n'.padStart(5) + 'res'.padStart(5) + 'mean m5'.padStart(10) + 'hit%'.padStart(8) + 'mean r'.padStart(9));
  for (const g of res.groups) {
    L.push('  ' + g.name.padEnd(32) + String(g.rows).padStart(5) + String(g.resolved).padStart(5)
      + String(g.m5.n ? g.m5.mean : '-').padStart(10)
      + String(g.rHit.n ? (100 * g.rHit.hit).toFixed(1) : '-').padStart(8)
      + String(g.rMultiple.n ? g.rMultiple.mean : '-').padStart(9));
  }
  L.push('');
  L.push('old-engine label baseline (Section 21.3: the new layer must beat this)');
  L.push('  group'.padEnd(34) + 'n'.padStart(5) + 'res'.padStart(5) + 'mean m5'.padStart(10) + 'hit%'.padStart(8));
  for (const g of res.labelBaseline.slice(0, 8)) {
    L.push('  ' + g.name.padEnd(32) + String(g.rows).padStart(5) + String(g.resolved).padStart(5)
      + String(g.m5.n ? g.m5.mean : '-').padStart(10)
      + String(g.rHit.n ? (100 * g.rHit.hit).toFixed(1) : '-').padStart(8));
  }
  L.push('');
  L.push('gates that could NOT be evaluated on this data:');
  for (const k of Object.keys(res.unrunnableOnThisData)) L.push('   - ' + k + ': ' + res.unrunnableOnThisData[k]);
  return L.join('\n');
}

module.exports = { run, report, rowToSnapshot, directionOf, dedupeEpisodes, stats, hitRate, loadLedger };

if (require.main === module) {
  const res = run({ dedupe: !process.argv.includes('--no-dedupe') });
  console.log(report(res));
  const out = path.join(__dirname, '..', 'data', 'v2_sessions', 'backtest_gates_' + new Date().toISOString().slice(0, 10) + '.json');
  try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); console.log('\nwritten: ' + out); } catch (e) { console.log('\n(report not written: ' + e.message + ')'); }
}
