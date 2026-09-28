/**
 * gb_scoring_v2/baseline.js — PHASE 0 DONE-WHEN: "Old-engine score distribution
 * and status counts documented."
 *
 * Why this is not busywork. Spec Section 18: "Signal and watch thresholds are
 * placeholders set from the Phase 0 baseline distribution and then tuned on
 * tuning sessions only." Without a recorded baseline there is no way to know
 * whether the new engine's thresholds are meaningful or arbitrary -- and no way
 * to answer the Section 21.3 question "did the new engine beat the old one on
 * the SAME episodes?" later, because nobody wrote down what the old one said.
 *
 * This module READS; it writes only its own report under data/v2_sessions.
 */
const fs = require('fs');
const path = require('path');
const { loadGB, snapshots } = require('./adapter');
const { DIR, sessionDay } = require('./recorder');
// NOTE: the path is explicit ('./config/index'). A superseded draft's config.js
// sits beside the V3 config directory and Node resolves a FILE before a DIRECTORY,
// so a bare './config' would silently load the wrong module.
const { hash } = require('./config/index');

function bucket(n, edges) {
  for (let i = 0; i < edges.length; i++) if (n < edges[i]) return '<' + edges[i];
  return '>=' + edges[edges.length - 1];
}

function tally(rows, keyFn) {
  const out = {};
  for (const r of rows) { const k = keyFn(r); const kk = (k === null || k === undefined || k === '') ? '(none)' : String(k); out[kk] = (out[kk] || 0) + 1; }
  return out;
}

function quantiles(nums) {
  const a = nums.filter(n => typeof n === 'number' && Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return { n: 0 };
  const at = p => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return { n: a.length, min: at(0), p25: at(0.25), median: at(0.5), p75: at(0.75), p90: at(0.9), max: at(1), mean: +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(3) };
}

/**
 * baseline(gb) -> the documented baseline object.
 * Separates DEEP rows (the ones the old engine actually scored) from TRACK rows,
 * because mixing them would make the score distribution look like it has a spike
 * at zero that is really just the un-read rows.
 */
function baseline(gb) {
  if (!gb || !gb.ok) return { ok: false, reason: gb ? gb.reason : 'no payload' };
  const rows = gb.rows || [];
  const deep = rows.filter(r => !r.tickOnly);
  const track = rows.filter(r => r.tickOnly);
  const scored = deep.filter(r => typeof r.score === 'number');

  const statuses = tally(deep, r => r.signal);
  const phases = tally(deep, r => r.phase);
  const engines = tally(deep, r => r.engine);
  const labels = tally(deep, r => r.label);

  const edges = [0, 5, 10, 15, 20, 25, 30, 35, 40, 50];
  const hist = {};
  for (const edge of ['<5', '<10', '<15', '<20', '<25', '<30', '<35', '<40', '<50', '>=50']) hist[edge] = 0;
  for (const r of scored) hist[bucket(r.score, edges)]++;

  // Section 21.3 baselines need the "signal-like" population, not every row.
  const actionable = deep.filter(r => r.signal === 'BUY' || r.signal === 'SELL');
  const report = {
    ok: true,
    kind: 'old-engine-baseline',
    configHash: hash(),
    sessionDay: sessionDay(),
    generatedAt: gb.generatedAt,
    ageMs: gb.ageMs,
    marketOpen: gb.marketOpen,
    market: gb.market,
    counts: gb.counts,
    population: { total: rows.length, deep: deep.length, trackOnly: track.length, scored: scored.length, actionable: actionable.length },
    scoreDistribution: { hist, quantiles: quantiles(scored.map(r => r.score)), of: scored.length },
    statusCounts: { signal: statuses, phase: phases, engine: engines, label: labels },
    // The spec's own caution: a board frozen after the close is not a session.
    caveat: gb.marketOpen === false ? 'market closed at capture -- this is the last live scan, not a fresh session' : null,
  };
  return report;
}

function writeReport(report, tag = 'baseline') {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, tag + '_' + sessionDay() + '.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  } catch (e) { return null; }
}

function summarise(report) {
  if (!report || !report.ok) return 'baseline unavailable: ' + (report && report.reason);
  const l = [];
  l.push('OLD-ENGINE BASELINE  (generated ' + report.generatedAt + ', marketOpen=' + report.marketOpen + ')');
  l.push('  rows ' + report.population.total + '  = deep ' + report.population.deep + ' + track-only ' + report.population.trackOnly);
  l.push('  scored ' + report.population.scored + '  actionable(BUY/SELL) ' + report.population.actionable);
  const q = report.scoreDistribution.quantiles;
  l.push('  score: min ' + q.min + '  p25 ' + q.p25 + '  median ' + q.median + '  p75 ' + q.p75 + '  p90 ' + q.p90 + '  max ' + q.max);
  l.push('  hist: ' + Object.entries(report.scoreDistribution.hist).filter(([, v]) => v).map(([k, v]) => k + ':' + v).join('  '));
  l.push('  signal: ' + JSON.stringify(report.statusCounts.signal));
  l.push('  phase:  ' + JSON.stringify(report.statusCounts.phase));
  l.push('  engine: ' + JSON.stringify(report.statusCounts.engine));
  if (report.caveat) l.push('  CAVEAT: ' + report.caveat);
  return l.join('\n');
}

module.exports = { baseline, writeReport, summarise, quantiles, tally, bucket };

if (require.main === module) {
  const gb = loadGB();
  const rep = baseline(gb);
  console.log(summarise(rep));
  const f = writeReport(rep);
  if (f) console.log('\nwritten: ' + f);
  // Touch the snapshot path too, so a Phase 0 run proves Phase 2 wiring end to end.
  const snaps = snapshots(gb);
  console.log('snapshots produced: ' + snaps.length + (snaps[0] ? '  (first: ' + snaps[0].symbol + ', missing ' + snaps[0].missing.length + ' fields, coverage ' + snaps[0].coverage.overall + ')' : ''));
}
