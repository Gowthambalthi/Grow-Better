/**
 * gb_scoring_v2/v3.js — THE V3 ENTRY POINT.
 *
 * NAMING NOTE. The spec's Section 24 module list wants an `index` at the root of
 * gb_scoring_v2/. A root `index.js` already exists there: an earlier, superseded
 * draft (a mock-demo 3-stage sketch with a hardcoded RELIANCE universe and a
 * `demo()` that fakes ticks). It is NOT referenced by the backend, and rather
 * than quietly overwrite work that is not mine to delete, V3 lives beside it at
 * `v3.js`. Requiring this file is how you get the real engine.
 *
 * WHAT IS BUILT (Phases 0-2 of the spec's phase list): the observability floor.
 * The spec is emphatic that this comes first, before any scoring:
 *   Phase 0 — baseline old engine + start raw recording
 *   Phase 1 — feed verification
 *   Phase 2 — adapter + normalized snapshot
 *   Phase 3 — replay harness
 * Sections 9-20 (momentum, flow, exhaustion, location, trend, RSI, score,
 * decision, episodes, outcomes) are NOT built yet, and the spec's own rule says
 * they arrive one at a time, each validated against the frozen v1 baseline:
 * "if it does not improve out-of-sample separation it stays display-only or is
 * removed."
 *
 * Sections 8's gates exist as CONFIGURATION only. No gate is enforced yet,
 * because enforcing a gate whose input is absent (spread, latency) would silently
 * block every candidate -- the exact failure the spec's "unknown input caps at
 * WATCH, never silently passes" rule is written to prevent. Phase 4 builds them.
 */

const CONFIG_MOD = require('./config/index');   // explicit: the draft config.js sits beside config/
const adapter = require('./adapter');
const gates = require('./gates');
const momentum = require('./momentum');
const recorder = require('./recorder');
const replay = require('./replay');
const baseline = require('./baseline');
const verifyFeed = require('./verify-feed');

// The spec's phase list (Section 25), as data, so status is inspectable rather
// than a claim in a comment.
const PHASES = [
  { n: 0, name: 'Baseline old engine + start raw recording', status: 'built' },
  { n: 1, name: 'Feed verification', status: 'built' },
  { n: 2, name: 'Adapter + snapshot', status: 'built' },
  { n: 3, name: 'Replay harness', status: 'built' },
  { n: 4, name: 'Gates', status: 'built' },
  { n: 5, name: 'Normalized ROC (fast, structural, acceleration)', status: 'built' },
  { n: 6, name: 'Relative strength', status: 'pending' },
  { n: 7, name: 'Executed flow + persistence', status: 'pending' },
  { n: 8, name: 'Price/flow + exhaustion veto', status: 'pending' },
  { n: 9, name: 'Location', status: 'pending' },
  { n: 10, name: 'Trend + RSI', status: 'pending' },
  { n: 11, name: 'Score + decision + reasons + episodes', status: 'pending' },
  { n: 12, name: 'Outcome simulator + logger', status: 'pending' },
  { n: 13, name: 'Validation v1', status: 'pending' },
  { n: 14, name: 'Tuning on tuning sessions', status: 'pending' },
  { n: 15, name: 'Out-of-sample validation', status: 'pending' },
  { n: 16, name: 'Shadow UI', status: 'pending' },
  { n: 17, name: 'Paper observation', status: 'pending' },
  { n: 18, name: 'Controlled promotion', status: 'pending' },
];

/** status() -- what is built, what is not, and the current config hash. */
function status() {
  const gb = adapter.loadGB();
  return {
    schemaVersion: CONFIG_MOD.SCHEMA_VERSION,
    configHash: CONFIG_MOD.hash(),
    weightsLocked: CONFIG_MOD.CONFIG.score.weightsLocked,
    primaryMetricLocked: CONFIG_MOD.CONFIG.validation.locked,
    isolation: 'reads data/live_signals.json only; writes only under data/v2_sessions',
    phases: PHASES,
    sources: adapter.FILES,
    gbAvailable: gb.ok,
    gbAgeMs: gb.ageMs,
    sessions: recorder.listSessions().length,
    deferred: CONFIG_MOD.CONFIG.deferred,
    removed: CONFIG_MOD.CONFIG.removed,
  };
}

/** snapshotAll() -- the adapter's one-snapshot-per-symbol answer (Phase 2). */
function snapshotAll() {
  const gb = adapter.loadGB();
  if (!gb.ok) return { ok: false, reason: gb.reason, snapshots: [] };
  return { ok: true, generatedAt: gb.generatedAt, ageMs: gb.ageMs, snapshots: adapter.snapshots(gb), provenance: adapter.provenanceSummary(adapter.snapshots(gb)) };
}

/**
 * gateReport({ direction }) -- run the Phase 4 gates over the whole live board and
 * report the status distribution plus a reason-code histogram.
 *
 * This is the Phase-4 acceptance evidence: it shows WHICH gates fire, HOW OFTEN,
 * and -- via `notRunnable` -- which gates never got to run at all. A gate layer
 * that cannot be audited this way is one nobody will trust enough to tune
 * (spec Section 21.4, the blocked audit).
 */
function gateReport(opts = {}) {
  const gb = adapter.loadGB();
  if (!gb.ok) return { ok: false, reason: gb.reason };
  const snaps = adapter.snapshots(gb);
  const ctx = {
    direction: opts.direction || null,
    now: opts.now != null ? opts.now : Date.now(),
    receiptTs: gb.receiptTs,
    market: gb.market ? { state: gb.market } : null,
    banned: (gb.banned || []).map(b => (b && b.symbol) || b),
  };
  const status = {}, codes = {}, naGates = {}, risks = {};
  // Split by depth. Tick-only rows are never entry candidates, and they have no
  // quality meta, so lumping them in makes the audit read as if the gate layer
  // rejects nearly everything when it is really rejecting rows that were never
  // eligible. The DEEP split is the one worth tuning against (spec Section 21.4).
  const deepStatus = {}, deepCodes = {};
  let coverageCapped = 0, deepN = 0;
  for (const s of snaps) {
    const r = gates.runGates(s, ctx);
    status[r.status] = (status[r.status] || 0) + 1;
    if (r.blockedBy) codes[r.blockedBy] = (codes[r.blockedBy] || 0) + 1;
    for (const c of r.reasons) if (!c.caps) codes[c.code] = (codes[c.code] || 0) + 1;
    for (const n of r.notRunnable) naGates[n.code] = (naGates[n.code] || 0) + 1;
    for (const k of r.risks) risks[k] = (risks[k] || 0) + 1;
    if (r.coverageCapped) coverageCapped++;
    if (s.depth === 'deep') {
      deepN++;
      deepStatus[r.status] = (deepStatus[r.status] || 0) + 1;
      if (r.blockedBy) deepCodes[r.blockedBy] = (deepCodes[r.blockedBy] || 0) + 1;
      for (const c of r.reasons) if (!c.caps) deepCodes[c.code] = (deepCodes[c.code] || 0) + 1;
    }
  }
  return { ok: true, scanned: snaps.length, status, codes, notRunnable: naGates, risks, coverageCapped, direction: ctx.direction,
    deep: { scanned: deepN, status: deepStatus, codes: deepCodes } };
}

module.exports = {
  status, snapshotAll, gateReport, momentumReport,
  // the pieces, so a caller never has to reach into the subtree by path
  config: CONFIG_MOD, adapter, recorder, replay, baseline, verifyFeed, gates, momentum, PHASES,
};

/**
 * momentumReport(opts) -- the Phase 5 evidence over the whole live board.
 * Reports the SHAPE of the evidence (bounded, how many names produced a value, how
 * much the horizons agreed) rather than a score, because Phase 5 emits no points.
 */
function momentumReport(opts = {}) {
  const gb = adapter.loadGB();
  if (!gb.ok) return { ok: false, reason: gb.reason };
  const snaps = adapter.snapshots(gb);
  const now = opts.now != null ? opts.now : Date.now();
  const out = { ok: true, scanned: snaps.length, now, fast: {}, struct: {}, bounded: true, noAtr: 0, noRoc: 0, threeMinute: 0, agreements: [] };
  for (const s of snaps) {
    const ev = momentum.momentumEvidence(s, { now });
    if (ev.fast == null && ev.structural == null) {
      if (ev.missing.some(m => /no ATR/.test(m))) out.noAtr++; else out.noRoc++;
      continue;
    }
    if (ev.groups.structural.threeMinuteIncluded) out.threeMinute++;
    for (const v of [ev.fast, ev.structural, ev.acceleration]) {
      if (v != null && (v < -1 || v > 1)) out.bounded = false;
    }
    const bucket = (v) => (v == null ? 'n/a' : v <= -0.5 ? '<=-0.5' : v < -0.1 ? '-0.5..-0.1' : v <= 0.1 ? '-0.1..0.1' : v <= 0.5 ? '0.1..0.5' : '>0.5');
    out.fast[bucket(ev.fast)] = (out.fast[bucket(ev.fast)] || 0) + 1;
    out.struct[bucket(ev.structural)] = (out.struct[bucket(ev.structural)] || 0) + 1;
    if (ev.groups.fast.agreement != null) out.agreements.push(ev.groups.fast.agreement);
  }
  const ag = out.agreements.slice().sort((a, b) => a - b);
  out.medianFastAgreement = ag.length ? +ag[Math.floor(ag.length / 2)].toFixed(3) : null;
  delete out.agreements;
  return out;
}

if (require.main === module) {
  const s = status();
  console.log('GB SCORING V3  ·  schema ' + s.schemaVersion + '  ·  config ' + s.configHash);
  console.log('isolation: ' + s.isolation);
  console.log('gb available: ' + s.gbAvailable + (s.gbAgeMs != null ? '  (scan age ' + Math.round(s.gbAgeMs / 1000) + 's)' : ''));
  console.log('recorded sessions: ' + s.sessions);
  const mr = momentumReport();
  if (mr.ok) {
    const bins = (o) => Object.keys(o).sort().map(k => k + ':' + o[k]).join('  ');
    console.log('momentum evidence (Phase 5, no points) over ' + mr.scanned + ' live snapshots:');
    console.log('  fast       ' + bins(mr.fast));
    console.log('  structural ' + bins(mr.struct));
    console.log('  bounded [-1,+1] everywhere: ' + mr.bounded + '  | 3m contributed on ' + mr.threeMinute
      + '  | no-ATR ' + mr.noAtr + '  | no-ROC ' + mr.noRoc + '  | median fast agreement ' + mr.medianFastAgreement);
  } else console.log('momentum: ' + mr.reason);
  const gr = gateReport();
  if (gr.ok) {
    console.log('gates over ' + gr.scanned + ' live snapshots (direction=' + gr.direction + '):');
    console.log('  ALL   status ' + JSON.stringify(gr.status) + '  reasons ' + JSON.stringify(gr.codes));
    console.log('  DEEP  status ' + JSON.stringify(gr.deep.status) + '  reasons ' + JSON.stringify(gr.deep.codes) + '  (of ' + gr.deep.scanned + ')');
    console.log('  not runnable ' + JSON.stringify(gr.notRunnable));
  } else console.log('gates: ' + gr.reason);
  console.log('');
  for (const p of PHASES) console.log('  phase ' + String(p.n).padStart(2) + '  ' + p.status.padEnd(12) + p.name);
}
