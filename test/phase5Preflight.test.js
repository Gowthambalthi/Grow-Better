'use strict';

/**
 * PHASE 5 PREFLIGHT — fixture tests + synthetic proof.
 *
 * These tests exercise the infrastructure ONLY: identity, raw-capture integrity,
 * the live/replay journal wrapper, gate comparison, reason classification,
 * deterministic normalization and frozen-state verification. They never touch a
 * strategy threshold and never promote change30.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const identity = require('../backtest/phase5Identity');
const capture = require('../backtest/phase5Capture');
const preflight = require('../backtest/phase5Preflight');
const journal = require('../strategies/orderflow/liveEventJournal');
const em = require('../backtest/eventMicro');
const { T } = require('../strategy-core/indicators');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-'));
const tape = (name, lines) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return p;
};
const tick = (t, s, p, q) => ({ t, s, p, q: q == null ? 1 : q, v: 1, bq: 1, sq: 1 });

// A capture stub that always passes, so gate tests can drive B..F in isolation.
const PASS_SHA = 'deadbeefdeadbeef';
const passCapture = {
  async gateA() {
    return {
      ok: true,
      checks: [{ step: 1, name: 'file readable', ok: true }],
      report: {
        rawTickCount: 10, lines: 10, gaps: 0, malformedRows: 0, missingFields: 0,
        orderingViolations: 0, duplicates: 0, unresolvedSymbolToken: 0, symbols: 1,
        firstTickTs: 1, lastTickTs: 2,
      },
      postCaptureSha: PASS_SHA,
    };
  },
  preReplaySha() { return PASS_SHA; },
  gateG(p, pre) { return { ok: p === pre, postCaptureSha: p, preReplaySha: pre, reason: p === pre ? null : 'CAPTURE_FIDELITY' }; },
};
const passGateF = () => ({
  ok: true,
  checks: [{ file: 'strategies/orderFlow.js', expected: 'x', actual: 'x', ok: true }],
  engineHash: 'enginehash', plannerConfigHash: 'plannerhash', followHash: 'followhash',
});

function row(cid, extra) {
  return Object.assign({
    candidateId: cid, symbol: 'FAKE', setup: 'OF01', side: 'LONG', decisionBarTs: 1000,
    decision: { locationType: 'VWAP', probedLevel: 100, triggerLevel: 101, invalidation: 99, closeLocation: 0.5, volumeRatio: 1.5, atrPct: 0.3, price: 100 },
    eligibility: { eligible: true, gate: null, reason: null },
    plan: { entry: 100, stop: 99, t1: 105, t2: 110, rr1: 5 },
    outcome: 'T1', parentCandidateId: null,
    change30Input: { available: true, windowStart: 0, windowEnd: 1000, tickCount: 30, delta30: 0.2, deltaAccel30: -0.4, change30: true },
  }, extra || {});
}
const jrnl = (armed, eligible) => ({ armed, eligible, meta: { armedEvents: armed.length, eligible: eligible.length } });

async function run(opts) {
  return preflight.runPreflight(Object.assign({
    corpus: [], tapePath: path.join(TMP, 'ticks-2026-10-02.jsonl'),
    captureModule: passCapture, gateF: passGateF,
  }, opts));
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

test('decisionBarTs is the CLOSE of the existing 1-minute decision bar', () => {
  const open = em.barTimeMs('2026-10-02 09:20');
  assert.equal(identity.decisionBarTs('2026-10-02 09:20'), open + 60000,
    'the decision bar close is the bar stamp + 60s, on the tape epoch axis');
  assert.equal(identity.decisionBarTs('2026-10-02 09:24') - identity.decisionBarTs('2026-10-02 09:23'), 60000);
});

test('candidateId is shared and exact: symbol|setup|side|decisionBarTs', () => {
  const a = identity.identity({ symbol: 'FAKE', setup: 'OF01', side: 'LONG', barTime: '2026-10-02 09:20' });
  const b = identity.identity({ symbol: 'FAKE', setup: 'OF01', side: 'LONG', barTime: '2026-10-02 09:20' });
  assert.equal(a.candidateId, b.candidateId);
  assert.equal(a.candidateId, 'FAKE|OF01|LONG|' + a.decisionBarTs);
  const c = identity.identity({ symbol: 'FAKE', setup: 'OF01', side: 'LONG', barTime: '2026-10-02 09:21' });
  assert.notEqual(a.candidateId, c.candidateId, 'a one-minute difference is a different candidate');
});

// ---------------------------------------------------------------------------
// raw capture integrity
// ---------------------------------------------------------------------------

test('a clean capture passes Gate A with the seven ordered checks', async () => {
  const p = tape('ticks-2026-10-02.jsonl', [tick(1000, 'FAKE', 100), tick(61000, 'FAKE', 101)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.ok, true);
  assert.equal(g.checks.length, 7);
  assert.deepEqual(g.checks.map((c) => c.step), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(g.postCaptureSha);
});

test('malformed rows are detected and reported, never deleted', async () => {
  const p = tape('mal.jsonl', ['{not json', tick(1000, 'FAKE', 100), '{"s":"FAKE"}']);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.malformedRows, 1);
  assert.equal(g.report.missingFields, 1);
  assert.equal(g.report.rawTickCount, 1, 'only the valid row is counted as a raw tick');
  assert.equal(g.ok, false);
  assert.equal(fs.readFileSync(p, 'utf8').trim().split('\n').length, 3, 'the file is untouched');
});

test('out-of-order rows are detected and reported', async () => {
  const p = tape('ooo.jsonl', [tick(5000, 'FAKE', 100), tick(1000, 'FAKE', 101)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.orderingViolations, 1);
  assert.equal(g.checks[3].ok, true, 'ordering is reported, not repaired');
  assert.ok(JSON.stringify(g.checks[3].detail.samples).includes('FAKE'));
});

test('gaps are detected and reported', async () => {
  const base = 1790567000000;
  const p = tape('gap.jsonl', [tick(base, 'FAKE', 100), tick(base + 180000, 'FAKE', 101)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.gaps, 1);
  assert.equal(g.report.rawTickCount, 2);
  assert.equal(g.checks[4].ok, true, 'gaps are reported, not repaired');
});

test('duplicate candidates are counted, not silently collapsed', async () => {
  const p = tape('dup.jsonl', [tick(1000, 'FAKE', 100), tick(1000, 'FAKE', 100)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.duplicates, 1);
  assert.equal(g.report.duplicateCandidates[0].count, 2);
  assert.equal(g.checks[5].ok, true, 'duplicates are reported, never deleted');
  assert.equal(g.report.rawTickCount, 2, 'both rows survive in the count');
});

test('a tick from a foreign session day is reported as contamination', async () => {
  const base = 1790567000000;   // 2026-09-28-ish
  const p = tape('ticks-2026-10-02.jsonl', [tick(base, 'FAKE', 100)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.foreignDayTicks, 1);
});

test('an unresolved symbol/token mapping is detected', async () => {
  const p = tape('tok.jsonl', [tick(1000, '2885', 100)]);
  const g = await capture.gateA(p, { knownSymbols: ['FAKE'] });
  assert.equal(g.report.unresolvedSymbolToken, 1);
  assert.equal(g.ok, false);
});

test('a missing file is unreadable, not a crash', async () => {
  const g = await capture.gateA(path.join(TMP, 'nope.jsonl'), {});
  assert.equal(g.report.readable, false);
  assert.equal(g.ok, false);
});

// ---------------------------------------------------------------------------
// dual SHA
// ---------------------------------------------------------------------------

test('POST-CAPTURE SHA vs PRE-REPLAY SHA mismatch is CAPTURE_FIDELITY', () => {
  const g = capture.gateG('aaaa', 'bbbb');
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'CAPTURE_FIDELITY');
  assert.equal(capture.gateG('aaaa', 'aaaa').ok, true);
});

// ---------------------------------------------------------------------------
// reason classification — exactly the five codes
// ---------------------------------------------------------------------------

test('primary reason classification uses only the five fixed codes', () => {
  assert.equal(preflight.classifyReason('live-only', {}, null), 'DETECTOR_STATE');
  assert.equal(preflight.classifyReason('replay-only', null, {}), 'DETECTOR_STATE');
  assert.equal(preflight.classifyReason('field', {}, {}, 'change30Input'), 'FEED_TIMING');
  assert.equal(preflight.classifyReason('field', {}, {}, 'plan'), 'BRANCH_LOGIC');
  assert.equal(preflight.classifyReason('field', {}, {}, 'eligibility'), 'BRANCH_LOGIC');
  assert.equal(preflight.classifyReason('field', {}, {}, 'decision'), 'DETECTOR_STATE');
  for (const r of [preflight.classifyReason('live-only'), preflight.classifyReason('field', {}, {}, 'plan')]) {
    assert.ok(preflight.REASONS.includes(r), r + ' must be one of the fixed codes');
  }
});

// ---------------------------------------------------------------------------
// deterministic normalization
// ---------------------------------------------------------------------------

test('normalization sorts by candidateId and excludes transient metadata', () => {
  const a = row('B|OF01|LONG|2', { runId: 'run-1', processId: 111, eventTs: 1, receivedAt: 2, branch: 'x', ingestSeq: 9 });
  const b = row('A|OF01|LONG|1', { runId: 'run-2', processId: 222, eventTs: 99, receivedAt: 88, branch: 'y', ingestSeq: 3 });
  const n = identity.normalizeRows([a, b]);
  assert.deepEqual(n.map((r) => r.candidateId), ['A|OF01|LONG|1', 'B|OF01|LONG|2']);
  assert.equal(n[0].runId, undefined);
  assert.equal(n[0].processId, undefined);
  assert.equal(n[0].eventTs, undefined);
  assert.equal(n[0].receivedAt, undefined);
  assert.equal(n[0].branch, undefined);
  assert.equal(n[0].ingestSeq, undefined);
});

test('transient metadata cannot move the canonical hash', () => {
  const h1 = identity.canonicalHash([row('A|OF01|LONG|1', { runId: 'r1', processId: 1, eventTs: 5 })]);
  const h2 = identity.canonicalHash([row('A|OF01|LONG|1', { runId: 'r2', processId: 2, eventTs: 6 })]);
  assert.equal(h1, h2, 'only the decision/measurement fields may enter the hash');
  const h3 = identity.canonicalHash([row('A|OF01|LONG|1', { decision: { locationType: 'POC' } })]);
  assert.notEqual(h1, h3, 'a real decision change MUST move the hash');
});

// ---------------------------------------------------------------------------
// gates B..F through the harness
// ---------------------------------------------------------------------------

test('Gate B: a live-only candidate fails alignment (DETECTOR_STATE)', async () => {
  const live = jrnl([row('A|OF01|LONG|1')], []);
  const rep = await run({ liveJournal: live, replayJournal1: jrnl([], []), replayJournal2: jrnl([], []) });
  assert.equal(rep.gates.B.ok, false);
  assert.equal(rep.mismatches[0].reason, 'DETECTOR_STATE');
  assert.equal(rep.pass, false);
});

test('Gate B: a replay-only candidate fails alignment (DETECTOR_STATE)', async () => {
  const rep = await run({
    liveJournal: jrnl([], []),
    replayJournal1: jrnl([row('A|OF01|LONG|1')], []),
    replayJournal2: jrnl([row('A|OF01|LONG|1')], []),
  });
  assert.equal(rep.gates.B.ok, false);
  assert.equal(rep.mismatches[0].reason, 'DETECTOR_STATE');
});

test('Gate B: a planted decision-field mismatch is reported (DETECTOR_STATE)', async () => {
  const live = jrnl([row('A|OF01|LONG|1')], []);
  const replay = jrnl([row('A|OF01|LONG|1', { decision: { locationType: 'POC', probedLevel: 100, triggerLevel: 101, invalidation: 99, closeLocation: 0.5, volumeRatio: 1.5, atrPct: 0.3, price: 100 } })], []);
  const rep = await run({ liveJournal: live, replayJournal1: replay, replayJournal2: replay });
  assert.equal(rep.gates.B.ok, false);
  assert.equal(rep.mismatches[0].reason, 'DETECTOR_STATE');
});

test('Gate D: a planted change30Input mismatch is reported (FEED_TIMING)', async () => {
  const good = row('A|OF01|LONG|1');
  const bad = row('A|OF01|LONG|1', { change30Input: { available: true, windowStart: 0, windowEnd: 1000, tickCount: 29, delta30: 0.2, deltaAccel30: -0.4, change30: true } });
  const rep = await run({
    liveJournal: jrnl([good], []),
    replayJournal1: jrnl([bad], []),
    replayJournal2: jrnl([bad], []),
  });
  assert.equal(rep.gates.D.ok, false);
  assert.equal(rep.mismatches[0].reason, 'FEED_TIMING');
});

test('Gate E: replay#1 == replay#2 (normalized hash)', async () => {
  const j = () => jrnl([row('A|OF01|LONG|1', { runId: 'r', processId: 1 })], []);
  const rep = await run({ liveJournal: j(), replayJournal1: j(), replayJournal2: j() });
  assert.equal(rep.gates.E.ok, true);
  assert.equal(rep.gates.E.replay1Hash, rep.gates.E.replay2Hash);
  assert.equal(rep.pass, true);
});

test('Gate G: a SHA mismatch stops before any comparison (CAPTURE_FIDELITY)', async () => {
  const cap = {
    async gateA() { return passCapture.gateA(); },
    preReplaySha() { return 'CHANGED'; },
    gateG(p, pre) { return { ok: false, postCaptureSha: p, preReplaySha: pre, reason: 'CAPTURE_FIDELITY' }; },
  };
  const rep = await run({ captureModule: cap });
  assert.equal(rep.gates.G.ok, false);
  assert.equal(rep.mismatches[0].reason, 'CAPTURE_FIDELITY');
  assert.equal(rep.gates.B, undefined, 'a failed gate must stop downstream comparison');
  assert.equal(rep.pass, false);
});

test('a failed gate stops downstream comparison (Gate C not reached after B fails)', async () => {
  const rep = await run({ liveJournal: jrnl([row('A|OF01|LONG|1')], []), replayJournal1: jrnl([], []), replayJournal2: jrnl([], []) });
  assert.equal(rep.gates.C, undefined);
  assert.equal(rep.gates.D, undefined);
  assert.equal(rep.gates.E, undefined);
  assert.equal(rep.gates.F, undefined);
});

test('Gate F: frozen engine/planner/follow verification', () => {
  const g = preflight.gateF();
  assert.equal(g.ok, true, 'the recorded frozen hashes must match the live files');
  assert.ok(g.engineHash && g.plannerConfigHash && g.followHash);
  // The engine hash must equal the one the Phase 2 doc records.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'ORDERFLOW-PHASE2.md'), 'utf8');
  const m = /`strategies\/orderFlow\.js` \| `([0-9a-f]{16})`/.exec(doc);
  assert.equal(g.engineHash, m[1]);
});

test('Gate F: a drifted engine hash is CONFIG_DRIFT and fails', async () => {
  const rep = await run({
    liveJournal: jrnl([row('A|OF01|LONG|1')], []),
    replayJournal1: jrnl([row('A|OF01|LONG|1')], []),
    replayJournal2: jrnl([row('A|OF01|LONG|1')], []),
    gateF: () => ({ ok: false, checks: [{ file: 'strategies/orderFlow.js', expected: 'aaa', actual: 'bbb', ok: false }], engineHash: 'bbb', plannerConfigHash: 'p', followHash: 'f' }),
  });
  assert.equal(rep.gates.F.ok, false);
  assert.equal(rep.mismatches[0].reason, 'CONFIG_DRIFT');
});

// ---------------------------------------------------------------------------
// the journal wrapper itself (existing engine + measurement, no second detector)
// ---------------------------------------------------------------------------

function fakeEngine() {
  return {
    DEFAULTS: {},
    createEngine(cfg) {
      return {
        onBar(bars, i) {
          if (i === 5) {
            cfg.trace({
              stage: 'armed', setup: 'OF01', side: 'LONG', time: bars[i][T.TIME], barsToTrigger: 0,
              price: bars[i][T.CLOSE], locationType: 'VWAP', probedLevel: 100,
              triggerLevel: 101, invalidation: 99, closeLocation: 0.5, volumeRatio: 1.5, atrPct: 0.3,
            });
            return null;
          }
          if (i === 7) {
            return {
              ok: true, setup: 'OF01', side: 'LONG', signalTime: bars[i][T.TIME], barIndex: i,
              entry: 100, stop: 99, t1: 105, t2: 110, rr1: 5, invalidationForFill: 99,
              targetCandidates: [105], market: {}, config: { planner: { requireMeasured: false } },
              setupData: { barsToTrigger: 2 },
            };
          }
          return null;
        },
      };
    },
  };
}

function fakeCorpus() {
  const candles = [];
  for (let i = 0; i < 30; i++) {
    const mm = String(9 + Math.floor((15 + i) / 60)).padStart(2, '0');
    const ss = String((15 + i) % 60).padStart(2, '0');
    candles.push(['2026-10-02 ' + mm + ':' + ss, 100, 101, 99.5, 100.5, 1000]);
  }
  return [{ symbol: 'FAKE', candles }];
}

const fixedMeasure = async (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.candidateId, { available: true, windowStart: r.decisionBarTs - 30000, windowEnd: r.decisionBarTs, tickCount: 30, delta30: 0.2, deltaAccel30: -0.4, change30: true });
  return m;
};

test('the journal wrapper reads the existing engine and measurement — no second detector', async () => {
  const j = await journal.buildJournal(fakeCorpus(), { engineMod: fakeEngine(), measureArmed: fixedMeasure, warmup: 0 });
  assert.equal(j.armed.length, 1);
  assert.equal(j.eligible.length, 1);
  assert.equal(j.armed[0].candidateId, j.eligible[0].parentCandidateId, 'the eligible row joins its parent armed event by candidateId');
  assert.equal(j.armed[0].change30Input.change30, true);
  assert.equal(j.eligible[0].change30Input.change30, true, 'the eligible row inherits the parent measurement');
});

// ---------------------------------------------------------------------------
// SYNTHETIC PROOF: raw fixture -> live journal -> replay journal -> equality
// ---------------------------------------------------------------------------

test('SYNTHETIC PROOF: live and replay journals align exactly, then a planted mismatch is reported', async () => {
  // 1. a raw fixture capture that passes integrity
  const p = tape('ticks-2026-10-02.jsonl', [tick(1000, 'FAKE', 100), tick(61000, 'FAKE', 101)]);
  const corpus = fakeCorpus();
  const build = () => journal.buildJournal(corpus, { engineMod: fakeEngine(), measureArmed: fixedMeasure, warmup: 0 });

  // 2. live journal, 3. replay journal (run twice)
  const live = await build();
  const replay1 = await build();
  const replay2 = await build();

  // 4. exact candidateId equality
  const ids = (j) => j.armed.map((r) => r.candidateId).sort();
  assert.deepEqual(ids(live), ids(replay1), 'live and replay armed candidateId sets must match exactly');

  // 5. through the harness, all gates pass
  const clean = await preflight.runPreflight({
    corpus, tapePath: p, captureModule: capture, captureOpts: { knownSymbols: ['FAKE'] },
    liveJournal: live, replayJournal1: replay1, replayJournal2: replay2,
  });
  assert.equal(clean.pass, true, 'clean fixture must PASS: ' + clean.blocker);
  assert.equal(clean.gates.B.ok, true);
  assert.equal(clean.gates.C.ok, true);
  assert.equal(clean.gates.D.ok, true);
  assert.equal(clean.gates.E.ok, true);
  assert.equal(clean.gates.F.ok, true);

  // 6. deliberately plant ONE mismatch and prove it is reported
  const tampered = replay1.armed.map((r) => Object.assign({}, r, {
    decision: Object.assign({}, r.decision, { probedLevel: 999 }),
  }));
  const dirty = await preflight.runPreflight({
    corpus, tapePath: p, captureModule: capture, captureOpts: { knownSymbols: ['FAKE'] },
    liveJournal: live, replayJournal1: { armed: tampered, eligible: replay1.eligible, meta: replay1.meta }, replayJournal2: replay1,
  });
  assert.equal(dirty.pass, false);
  assert.equal(dirty.gates.B.ok, false);
  assert.equal(dirty.mismatches.length >= 1, true);
  assert.equal(dirty.mismatches[0].reason, 'DETECTOR_STATE');
});
