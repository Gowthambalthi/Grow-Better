/**
 * gb_scoring_v2/phase4-baseline.js — FREEZE PHASE 4.
 *
 * Phase 4 is DONE and this file is the record of it. Nothing here tunes anything: it
 * counts, it names, it hashes, and it stops.
 *
 * WHY A FROZEN BASELINE RATHER THAN "THE CURRENT NUMBERS". Spec Section 2 lists the
 * build rules in order, and rule 6 is the one that matters here: "Add one component at
 * a time. Each addition is validated separately against the frozen v1 baseline."
 * A baseline that moves whenever someone edits a threshold cannot validate anything,
 * because every later comparison silently changes both sides. So the baseline is
 * written once, with the config hash in its FILENAME, and never edited in place.
 *
 * WHAT IS FROZEN, AND WHAT IS DELIBERATELY NOT CLAIMED:
 *
 *   * The 3,00,000 20-day volume floor is the CURRENT BASELINE CONFIGURATION. It is
 *     NOT a tuned value and NOT claimed optimal. It was chosen (25-Sep) to align with
 *     GB's own existing floor, because spec Section 8 describes its "8 lakh" as
 *     "(existing GB starting values)" and GB's actual floor is 3,00,000. Measured on
 *     the 995-name quality set: the MEDIAN name trades 5,39,530, so an 8-lakh floor
 *     would remove roughly 62% of the board for a number the spec believed it was
 *     inheriting. The right way to settle it is the blocked audit (Section 21.4) once
 *     outcomes exist for blocked rows -- not a threshold sweep on one afternoon.
 *   * No threshold in this file is justified by today's outcomes. Today produced no
 *     outcomes; the ledger's 400 resolved rows are all one biased label, and the
 *     tuner's own grid ceiling is ~45%, so there is nothing to optimize against yet.
 *
 * REPRODUCIBILITY. `now` is pinned to the GB scan timestamp, not wall-clock. A gate
 * audit run twice against the same scan therefore returns identical counts, which is
 * what makes it a baseline rather than a snapshot of whichever second it ran in.
 *
 * Usage:
 *   node gb_scoring_v2/phase4-baseline.js            # write the frozen baseline
 *   node gb_scoring_v2/phase4-baseline.js --check    # recompute and diff (exit 1 on drift)
 *   node gb_scoring_v2/phase4-baseline.js --dir=GB   # run against GB's own live file
 *   node gb_scoring_v2/phase4-baseline.js --reissue  # re-render the SAME frozen scan
 *                                                    # under a new report revision (.rN),
 *                                                    # refusing if the counts no longer reproduce
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CONFIG, hash, stamp, stableStringify } = require('./config/index');
const adapter = require('./adapter');
const { runGates, GATES, OUT } = require('./gates');

const SESS = path.join(__dirname, '..', 'data', 'v2_sessions');

/**
 * A hash of ONE config block, so "the gate thresholds changed" is distinguishable from
 * "some unrelated part of the config changed and moved the whole-config hash". The
 * volume floor, the spread cap and the conflict opposition are the knobs that most
 * directly move Phase 4 counts; pinning their hash separately means a re-issued report
 * can state that the gate layer is byte-identical or not, without a full re-freeze.
 */
const hashOf = (v) => crypto.createHash('sha256').update(stableStringify(v)).digest('hex').slice(0, 12);

/** One line per gate: code, the onMissing policy, then every threshold it owns. */
function gateLines(cfg) {
  const out = [];
  for (const name of cfg.order) {
    const g = cfg[name] || {};
    const bits = Object.keys(g).filter((k) => k !== 'code' && k !== 'onMissing')
      .sort()
      .map((k) => k + '=' + (g[k] && typeof g[k] === 'object' ? stableStringify(g[k]) : g[k]));
    out.push('  ' + (name + ' [' + (g.code || '?') + ']').padEnd(28)
      + 'onMissing=' + String(g.onMissing || '?').padEnd(7) + '  ' + bits.join('  '));
  }
  return out;
}

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };

// ---------------------------------------------------------------------------
// COLLECT
// ---------------------------------------------------------------------------
function collect(opts = {}) {
  const gb = adapter.loadGB();
  const rows = gb.rows || gb.signals || [];
  // PINNED AUX INPUTS. Without opts.aux the pins are taken live, which is correct for a
  // freeze and WRONG for a re-check: universe_shortlist.json is regenerated every 5
  // minutes, and 53 of 289 verdicts on this scan depend on it (see adapter.captureAux).
  const aux = opts.aux || adapter.captureAux();
  const auxMaps = adapter.auxToMaps(aux);
  const snaps = adapter.snapshots(gb, auxMaps);
  // Hash the rows ACTUALLY USED, not the source files. The pin stores exactly the
  // used rows, so a re-check against the pin hashes the same bytes and the auxHash
  // matches instead of differing only because the live files carry extra symbols.
  const usedAuxHash = adapter.auxHash({
    quality: { rows: [...auxMaps.quality.values()] },
    screened: { rows: [...auxMaps.screened.values()] },
  });
  const bySymbol = new Map(rows.map((r) => [String(r.symbol).toUpperCase(), r]));

  // PINNED CLOCK. GATE_TIME and the momentum time-of-day factor both read it, so a
  // wall-clock audit would produce a different baseline every minute.
  const scannedAt = gb.generatedAt ? Date.parse(gb.generatedAt) : null;
  const now = Number.isFinite(scannedAt) ? scannedAt : Date.now();

  const gateOrder = CONFIG.gates.order.slice();
  const perGate = {};
  for (const name of gateOrder) perGate[name] = { gate: name, code: (CONFIG.gates[name] || {}).code || null, pass: 0, watch: 0, block: 0, na: 0, notReached: 0 };
  const set = new Set(snaps.map((s) => s.symbol));

  const status = { BLOCKED: 0, WATCH: 0, PASS: 0 };
  const blockedBy = {};
  const reasonCodes = {};
  const riskCodes = {};
  const notRunnableByGate = {};
  const codeToGate = {};
  for (const name of gateOrder) codeToGate[(CONFIG.gates[name] || {}).code] = name;

  // EVIDENCE FIELD CENSUS, per snapshot field. "missing-field coverage" is abstract
  // until it is turned into "this feed carried s10/s20/s30 and POC, and did NOT carry
  // roc1m/5m/15m, VWAP, volume ratio, the gap or the candle trend at all". The gates
  // can only ever be as good as this list, so the list is part of the baseline.
  const evidenceCensus = {};
  const bump = (k) => { evidenceCensus[k] = (evidenceCensus[k] || 0) + 1; };
  for (const k of Object.keys(snaps[0] ? snaps[0].price_evidence : {})) evidenceCensus['price_evidence.' + k] = 0;
  // `flow.provenance` is metadata, not an evidence value, and `candles.trendCounts` is a
  // container of six labels -- counting a present-but-empty container as "present" would
  // claim the candle trend was available on rows where every timeframe is null, which is
  // exactly the sort of overstatement this census exists to prevent.
  for (const k of Object.keys(snaps[0] ? snaps[0].flow : {})) if (k !== 'provenance') evidenceCensus['flow.' + k] = 0;
  for (const k of Object.keys(snaps[0] ? snaps[0].location : {})) evidenceCensus['location.' + k] = 0;
  for (const k of Object.keys(snaps[0] ? snaps[0].structure : {})) evidenceCensus['structure.' + k] = 0;
  for (const k of Object.keys(snaps[0] ? snaps[0].candles : {})) evidenceCensus['candles.' + k] = 0;
  for (const k of Object.keys(snaps[0] ? snaps[0].context : {})) evidenceCensus['context.' + k] = 0;

  const missingFieldFreq = {};
  const missingCounts = [];
  const coverageOverall = [];
  const coveragePerGroup = {};
  const provenanceTotals = { OBSERVED: 0, DERIVED: 0, INFERRED: 0, VERIFY: 0, UNKNOWN: 0 };
  const provenancePerRow = {};
  const depth = { deep: 0, 'tick-only': 0 };

  const examples = { blocked: {}, watch: {}, notRunnable: {}, pass: [] };
  const pushEx = (bucket, key, it) => {
    if (!bucket[key]) bucket[key] = [];
    if (bucket[key].length < 3) bucket[key].push(it);
  };

  for (const s of snaps) {
    const row = bySymbol.get(String(s.symbol).toUpperCase()) || {};
    depth[s.depth === 'deep' ? 'deep' : 'tick-only']++;
    const res = runGates(s, {
      direction: adapter.directionOf(row), now,
      receiptTs: Number.isFinite(scannedAt) ? scannedAt : Date.now(),
      market: gb.market || null, banned: gb.banned || [],
    });

    status[res.status] = (status[res.status] || 0) + 1;
    if (res.blockedBy) blockedBy[res.blockedBy] = (blockedBy[res.blockedBy] || 0) + 1;

    // Per-gate tallies. A gate AFTER the blocking one never ran, and counting that as
    // "0 blocks" would make a dead gate look satisfied, so it is recorded separately.
    const ran = new Set(res.results.map((r) => r.gate));
    for (const name of gateOrder) {
      const r = res.results.find((x) => x.gate === name);
      if (!r) { perGate[name].notReached++; continue; }
      if (r.outcome === OUT.PASS) perGate[name].pass++;
      else if (r.outcome === OUT.WATCH) perGate[name].watch++;
      else if (r.outcome === OUT.BLOCK) perGate[name].block++;
      else if (r.outcome === OUT.NA) perGate[name].na++;
    }
    for (const rr of res.reasons) reasonCodes[rr.code] = (reasonCodes[rr.code] || 0) + 1;
    for (const rc of res.risks) riskCodes[rc] = (riskCodes[rc] || 0) + 1;
    for (const nr of res.notRunnable) notRunnableByGate[nr.code] = (notRunnableByGate[nr.code] || 0) + 1;

    const ex = { symbol: s.symbol, depth: s.depth, price: s.price, direction: adapter.directionOf(row),
      missing: s.missing.length, firstReason: res.reasons[0] ? res.reasons[0].code + ': ' + res.reasons[0].detail : null,
      gate: res.blockedBy || (res.results.find((r) => r.outcome === OUT.WATCH) || {}).gate || null };
    if (res.blockedBy) pushEx(examples.blocked, res.blockedBy, ex);
    else if (res.status === 'WATCH') {
      const firstCap = res.reasons.find((r) => r.caps === 'WATCH');
      pushEx(examples.watch, (firstCap && firstCap.code) || 'WATCH_NO_CAP_REASON', ex);
    } else pushEx(examples.pass, 'pass', ex);
    for (const nr of res.notRunnable) pushEx(examples.notRunnable, nr.code, ex);

    for (const k of Object.keys(evidenceCensus)) {
      const [block, field] = k.split('.');
      if (k === 'candles.trendCounts') {
        const tc = (s.candles && s.candles.trendCounts) || {};
        if (Object.keys(tc).some((f) => adapter.isKnown(tc[f]))) evidenceCensus[k]++;
        continue;
      }
      if (adapter.isKnown(s[block] && s[block][field])) evidenceCensus[k]++;
    }

    for (const m of s.missing) missingFieldFreq[m] = (missingFieldFreq[m] || 0) + 1;
    missingCounts.push(s.missing.length);
    coverageOverall.push(s.coverage.overall);
    for (const g of Object.keys(s.coverage.perGroup)) {
      const e = s.coverage.perGroup[g];
      if (!coveragePerGroup[g]) coveragePerGroup[g] = { available: 0, of: 0, rowsFullyAvailable: 0, rowsFullyMissing: 0 };
      coveragePerGroup[g].available += e.available;
      coveragePerGroup[g].of += e.of;
      if (e.available === e.of) coveragePerGroup[g].rowsFullyAvailable++;
      if (e.available === 0) coveragePerGroup[g].rowsFullyMissing++;
    }
    let inferredOnly = false, tagged = 0;
    for (const k of Object.keys(s.provenance)) {
      const t = s.provenance[k];
      provenanceTotals[t] = (provenanceTotals[t] || 0) + 1;
      tagged++;
    }
    provenancePerRow[s.symbol] = tagged;
    if (s.flow && s.flow.provenance && s.flow.provenance.inferredOnly) inferredOnly = true;
    if (inferredOnly) provenanceTotals.rowsInferredOnlyFlow = (provenanceTotals.rowsInferredOnlyFlow || 0) + 1;
    set.add(s.symbol);
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const r3 = (v) => (v == null ? null : +v.toFixed(3));

  // The upstream funnel is read, never invoked: the baseline records the architecture
  // the gate layer sits inside, with the numbers it actually produced this cycle.
  let funnel = null;
  try {
    const f = require('../common/market/universeFunnel');
    const st = f.getState ? f.getState() : null;
    if (st) funnel = { cycle: st.cycle, stageA: st.stageA ? { universe: st.stageA.universe, quoted: st.stageA.quoted, passed: st.stageA.passed, cap: st.stageA.cap, carried: st.stageA.carried, gateCounts: st.stageA.gateCounts, delayedBy: st.stageA.delayedBy } : null, stageB: st.stageB, pool: st.pool };
  } catch (e) { funnel = { error: e.message }; }

  return {
    kind: 'phase4-gate-baseline',
    phase: 4,
    frozen: true,
    frozenAt: new Date().toISOString(),
    // Reproducibility contract: same scan + same hash => same counts.
    pinnedClock: Number.isFinite(scannedAt) ? new Date(scannedAt).toISOString() : null,
    configHash: hash(),
    configStamp: stamp(CONFIG),
    gateConfig: JSON.parse(stableStringify(CONFIG.gates)),
    gateConfigHash: hashOf(CONFIG.gates),
    scoreConfigHash: hashOf(CONFIG.score),
    // Which bytes were measured. generatedAt alone is not enough: GB rewrites
    // live_signals.json in place and the aux files move under it.
    scanHash: hashOf(rows),
    auxHash: usedAuxHash,
    auxPinned: opts.aux
      ? null   // a re-check carries the PIN forward; re-storing it would double the file
      : {
        note: 'The exact aux inputs behind this baseline. universe_shortlist.json is regenerated by GB\'s 5-minute funnel cycle, and 53 of 289 gate verdicts on this scan are sensitive to it, so a re-check must re-read THESE rows, not the live files.',
        capturedAt: aux.capturedAt,
        quality: { file: aux.quality.file, rows: [...auxMaps.quality.values()] },
        screened: { file: aux.screened.file, rows: [...auxMaps.screened.values()] },
      },
    scoreConfig: JSON.parse(stableStringify(CONFIG.score)),
    thresholdsStatus: 'BASELINE CONFIGURATION — NOT tuned, NOT claimed optimal',
    validationStatus: 'locked=' + !!(CONFIG.validation && CONFIG.validation.locked) + '  metric="' + ((CONFIG.validation || {}).metric || '') + '"',
    volumeFloorNote: 'gates.liquidity.minAvgVol20 = ' + CONFIG.gates.liquidity.minAvgVol20
      + ' is preserved as the current baseline (aligned with GB\'s own existing floor). The spec\'s literal 8,00,000 is reachable with GB_GATE_MIN_AVGVOL20=800000. Settle it with the Section 21.4 blocked audit once blocked rows have outcomes, not with a sweep on one session.',
    notOptimizedAgainst: 'today\'s outcomes (none exist for blocked rows; the resolved ledger is 400 rows of one biased label)',
    universe: {
      source: (() => {
        const f = adapter.FILES || {};
        const v = f.signals || f.live || null;
        return typeof v === 'string' ? path.basename(v) : null;
      })(),
      generatedAt: gb.generatedAt || null,
      ageMs: gb.generatedAt ? Date.now() - Date.parse(gb.generatedAt) : null,
      marketOpen: !!gb.marketOpen,
      market: gb.market || null,
      rowsInFile: rows.length,
      snapshotsBuilt: snaps.length,
      uniqueSymbols: set.size,
      depth,
      funnel,
      scanAgeMs: gb.generatedAt ? Date.now() - Date.parse(gb.generatedAt) : null,
      scanAgeWarning: (() => {
        const a = gb.generatedAt ? Date.now() - Date.parse(gb.generatedAt) : 0;
        if (a > 10 * 60000) {
          return 'SCAN IS ' + Math.round(a / 60000) + ' MINUTES OLD at freeze time. The counts below describe that scan, '
            + 'not the current market. GB populates the longer horizons and the candle/gap block only later in the session, '
            + 'so an early scan exercises FEWER gates than a full one. Freeze a later scan as a SECOND baseline (same config hash, '
            + 'different scan stamp) rather than overwriting this one.';
        }
        return null;
      })(),
    },
    evidenceCensus,
    evidenceCensusNote: 'PER-ROW availability of each evidence field on THIS scan. Fields at 0 are absent from the feed at this time of day, which is why their gates and groups cannot be exercised yet.',
    status,
    blockedBy,
    perGate,
    reasonCodes,
    riskCodes,
    notRunnableByGate,
    missing: {
      rows: missingCounts.length,
      avgPerRow: r3(avg(missingCounts)),
      min: Math.min(...missingCounts), max: Math.max(...missingCounts),
      fieldFrequency: Object.entries(missingFieldFreq).sort((a, b) => b[1] - a[1]).map(([field, n]) => ({ field, rows: n, share: r3(n / Math.max(1, snapshotsCount(snaps))) })),
    },
    coverage: {
      overallAvg: r3(avg(coverageOverall.filter((v) => v != null))),
      overallMin: Math.min(...coverageOverall.filter((v) => v != null)),
      overallMax: Math.max(...coverageOverall.filter((v) => v != null)),
      cappedAtWatchBelow: CONFIG.score.coverage.capsAtWatchBelow,
      rowsCappedAtWatch: coverageOverall.filter((v) => v != null && v < CONFIG.score.coverage.capsAtWatchBelow).length,
      perGroup: coveragePerGroup,
    },
    provenance: {
      totals: provenanceTotals,
      note: 'TOTALS ARE PER FIELD, NOT PER ROW: every row tags every registered field, so totals sum to rows x registered-fields. rowsInferredOnlyFlow is a PER-ROW count and is the one to quote for Section 6.2.',
    },
    examples,
    auxInputs: opts.aux
      ? { quality: { file: opts.aux.quality.file }, screened: { file: opts.aux.screened.file },
          note: 're-check against the PINNED inputs stored in the frozen artifact, not the live files' }
      : { quality: { file: aux.quality.file }, screened: { file: aux.screened.file },
          note: 'live at freeze time, pinned into this artifact' },
    isolatedFrom: 'live decisions — this file writes only to data/v2_sessions and reads GB strictly read-only',
  };
}
const snapshotsCount = (snaps) => snaps.length;

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------
function report(r) {
  const L = [];
  const line = '='.repeat(78);
  // Fixed widths, sized for the longest label ('warmup [GATE_WARMUP]'), so the numbers
  // stay in columns instead of sliding left when a gate name is long.
  const row = (a, b, c, d, e) => '  ' + String(a).padEnd(30) + String(b).padStart(6) + String(c).padStart(7) + String(d).padStart(7) + String(e).padStart(12);
  L.push(line);
  L.push('PHASE 4 BASELINE — FROZEN');
  L.push('config ' + r.configHash + '  ·  frozen ' + r.frozenAt);
  L.push('pinned clock ' + (r.pinnedClock || 'n/a') + '  (gate audits are reproducible: same scan, same counts)');
  if (r.reissue) {
    L.push('RE-ISSUE r' + r.reissue.revision + ' — ' + r.reissue.reason);
    L.push('  same scan, same pinned clock; counts were re-computed and verified EQUAL to');
    L.push('  ' + r.reissue.originalArtifact + ' before this file was written. No number here moved.');
  }
  L.push(line);
  L.push('');
  L.push('THRESHOLD STATUS');
  L.push('  ' + r.thresholdsStatus);
  L.push('  ' + r.volumeFloorNote);
  L.push('  NOT optimized against: ' + r.notOptimizedAgainst);
  L.push('');
  // The EXACT configuration, rendered. It is also in the JSON, but a baseline nobody
  // can read without a JSON viewer is not a record — "exact gate configuration" means
  // every threshold AND the order the gates are evaluated in, in the artifact itself.
  L.push('GATE CONFIGURATION  (exact · gates block ' + (r.gateConfigHash || 'n/a') + ')');
  L.push('  evaluation order: ' + r.gateConfig.order.join(' -> '));
  for (const l of gateLines(r.gateConfig)) L.push(l);
  const sc = r.scoreConfig || {};
  if (sc.groups) {
    L.push('');
    L.push('SCORE CONFIGURATION  (exact · score block ' + (r.scoreConfigHash || 'n/a') + ')'
      + '   weightsLocked=' + sc.weightsLocked);
    for (const name of Object.keys(sc.groups).sort()) {
      const g = sc.groups[name];
      const bits = Object.keys(g).filter((k) => k !== 'points').sort()
        .map((k) => k + '=' + g[k]);
      L.push('  ' + name.padEnd(20) + String(g.points).padStart(3) + ' pts' + (bits.length ? '   ' + bits.join('  ') : ''));
    }
    if (sc.coverage) L.push('  coverage           capsAtWatchBelow=' + sc.coverage.capsAtWatchBelow + '  minForSignal=' + sc.coverage.minForSignal);
    if (sc.decision) L.push('  decision           signalThreshold=' + sc.decision.signalThreshold + '  watchThreshold=' + sc.decision.watchThreshold
      + '  allowWatchTrigger=' + sc.decision.allowWatchTrigger);
    if (sc.totalPoints != null) L.push('  totalPoints        ' + sc.totalPoints);
  }
  if (r.validationStatus) L.push('  validation         ' + r.validationStatus);
  L.push('');
  L.push('AUX INPUTS  (static facts the gates cannot get from the tick feed)');
  L.push('  quality set .............. ' + (r.auxInputs ? r.auxInputs.quality.file : 'n/a'));
  L.push('  screening shortlist ...... ' + (r.auxInputs ? r.auxInputs.screened.file : 'n/a'));
  L.push('  content hashes ........... scan ' + (r.scanHash || 'n/a') + '  aux ' + (r.auxHash || 'n/a') + '  gates ' + (r.gateConfigHash || 'n/a'));
  L.push('  ' + (r.auxInputs ? r.auxInputs.note : 'n/a'));
  L.push('  The shortlist is regenerated every 5 minutes by GB\'s funnel cycle. A baseline that');
  L.push('  reads it live reports a different number depending on when it is asked, so the rows');
  L.push('  used are pinned in this artifact and re-read by --check / --reissue.');
  L.push('');
  L.push('UNIVERSE (the architecture this layer sits inside)');
  L.push('  source file .............. ' + r.universe.source);
  L.push('  GB scan .................. ' + r.universe.generatedAt + '   market ' + (r.universe.marketOpen ? 'OPEN' : 'CLOSED')
    + '   scan age at freeze ' + (r.universe.scanAgeMs == null ? 'n/a' : Math.round(r.universe.scanAgeMs / 60000) + ' min'));
  if (r.universe.scanAgeWarning) L.push('  !! ' + r.universe.scanAgeWarning);
  L.push('  rows in file ............. ' + r.universe.rowsInFile);
  L.push('  snapshots built .......... ' + r.universe.snapshotsBuilt);
  L.push('  unique symbols ........... ' + r.universe.uniqueSymbols);
  L.push('  deep / tick-only ......... ' + r.universe.depth.deep + ' / ' + r.universe.depth['tick-only']);
  if (r.universe.funnel && r.universe.funnel.stageA) {
    const a = r.universe.funnel.stageA;
    L.push('  --- Yahoo stage A (universe filter, decides NOTHING) ---');
    L.push('    universe ' + a.universe + ' -> quoted ' + a.quoted + ' -> passed ' + a.passed + ' (cap ' + a.cap + ', carried ' + a.carried + ')');
    L.push('    declared delay ' + a.delayedBy + ' min   eliminations ' + JSON.stringify(a.gateCounts));
  }
  L.push('');
  L.push('STATUS');
  L.push('  BLOCKED ' + r.status.BLOCKED + '   WATCH ' + r.status.WATCH + '   PASS ' + r.status.PASS);
  L.push('');
  L.push('PER-GATE TALLY  (notReached = the gate never ran, because an earlier gate blocked)');
  L.push(row('gate', 'pass', 'watch', 'block', 'notReached'));   // columns are fixed-width; see row()
  for (const name of Object.keys(r.perGate)) {
    const g = r.perGate[name];
    L.push(row(name + ' [' + (g.code || '') + ']', g.pass, g.watch, g.block, g.notReached));
  }
  L.push('');
  L.push('BLOCKED BY (first blocking gate)');
  const bb = Object.entries(r.blockedBy).sort((a, b) => b[1] - a[1]);
  if (!bb.length) L.push('  (none)');
  for (const [code, n] of bb) L.push('  ' + code.padEnd(20) + String(n).padStart(6));
  L.push('');
  L.push('UNKNOWN / NOT-RUNNABLE (source-level absence, not a row-level unknown)');
  const nr = Object.entries(r.notRunnableByGate).sort((a, b) => b[1] - a[1]);
  if (!nr.length) L.push('  (none)');
  for (const [code, n] of nr) L.push('  ' + code.padEnd(20) + String(n).padStart(6));
  L.push('');
  L.push('EVIDENCE FIELD CENSUS ON THIS SCAN  (present / ' + r.universe.snapshotsBuilt + ' rows)');
  const census = Object.entries(r.evidenceCensus).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of census) L.push('  ' + k.padEnd(26) + String(n).padStart(6) + (n === 0 ? '   ABSENT on every row at this time of day' : ''));
  L.push('  ' + r.evidenceCensusNote);
  L.push('');
  L.push('MISSING-FIELD COVERAGE  (avg ' + r.missing.avgPerRow + ' missing per row, min ' + r.missing.min + ', max ' + r.missing.max + ')');
  for (const f of r.missing.fieldFrequency.slice(0, 20)) L.push('  ' + f.field.padEnd(34) + String(f.rows).padStart(6) + '  ' + (100 * f.share).toFixed(0) + '%');
  L.push('');
  L.push('COVERAGE  (spec 17: below ' + r.coverage.cappedAtWatchBelow + ' caps at WATCH)');
  L.push('  average ' + r.coverage.overallAvg + '  min ' + r.coverage.overallMin + '  max ' + r.coverage.overallMax
    + '   rows capped at WATCH: ' + r.coverage.rowsCappedAtWatch + '/' + r.universe.snapshotsBuilt);
  for (const g of Object.keys(r.coverage.perGroup)) {
    const c = r.coverage.perGroup[g];
    L.push('  ' + g.padEnd(18) + c.available + '/' + c.of + ' fields present   fully available rows ' + c.rowsFullyAvailable
      + '   fully missing rows ' + c.rowsFullyMissing);
  }
  L.push('');
  L.push('PROVENANCE DISTRIBUTION');
  for (const k of Object.keys(r.provenance.totals)) L.push('  ' + k.padEnd(26) + String(r.provenance.totals[k]).padStart(8));
  L.push('  ' + r.provenance.note);
  L.push('');
  L.push('EXAMPLES');
  for (const kind of ['blocked', 'watch', 'notRunnable']) {
    L.push('  --- ' + kind + ' ---');
    for (const key of Object.keys(r.examples[kind]).sort()) {
      for (const e of r.examples[kind][key]) {
        L.push('    ' + key.padEnd(20) + e.symbol.padEnd(14) + (e.depth || '').padEnd(10) + 'price ' + String(e.price).padStart(9)
          + '  missing ' + String(e.missing).padStart(3) + '  ' + (e.firstReason || ''));
      }
    }
  }
  L.push('  --- pass ---');
  const p = r.examples.pass.pass || [];
  if (!p.length) L.push('    (no row reached PASS — expected while coverage is below the cap and no trade side is supplied)');
  for (const e of p) L.push('    ' + e.symbol.padEnd(14) + 'price ' + e.price + '  missing ' + e.missing);
  L.push('');
  L.push(line);
  L.push('FROZEN. Do not edit this file in place. A threshold change means a NEW baseline');
  L.push('with a new config hash in the filename, so "before" and "after" are both recorded');
  L.push('and no comparison quietly moves both sides.');
  L.push(line);
  return L.join('\n');
}

/**
 * Baseline filenames carry the config hash AND the scan stamp, so two scans of the
 * same frozen config are two artifacts rather than one file overwriting another. A
 * later, fuller scan therefore becomes a SECOND baseline -- "before" is never lost.
 */
const stampOf = (r) => (r.universe && r.universe.generatedAt ? r.universe.generatedAt.replace(/[-:]/g, '').replace(/\..*$/, '') : 'noscants');
// The AUX content hash belongs in the name. Two freezes of the same scan against
// different aux content are two different measurements, and a filename that hid that
// would let one silently replace the other.
const baselineFile = (hashStr, scanStamp, aux) => path.join(SESS, 'phase4_baseline_' + hashStr + '_' + (scanStamp || 'unknown') + (aux ? '_aux' + aux : '') + '.json');
const baselineText = (hashStr, scanStamp, aux) => path.join(SESS, 'phase4_baseline_' + hashStr + '_' + (scanStamp || 'unknown') + (aux ? '_aux' + aux : '') + '.txt');

/** Every frozen baseline for a config hash, newest first. */
function listBaselines(hashStr) {
  try {
    return fs.readdirSync(SESS)
      .filter((f) => f.startsWith('phase4_baseline_' + hashStr + '_') && f.endsWith('.json'))
      .sort().reverse();
  } catch (_) { return []; }
}

/** Compare a fresh collection against the frozen file. Returns a list of drift findings. */
function compare(fresh, frozen) {
  const drift = [];
  if (fresh.configHash !== frozen.configHash) drift.push('config hash changed: ' + frozen.configHash + ' -> ' + fresh.configHash);
  for (const k of ['BLOCKED', 'WATCH', 'PASS']) {
    if (fresh.status[k] !== frozen.status[k]) drift.push('status.' + k + ': ' + frozen.status[k] + ' -> ' + fresh.status[k]);
  }
  for (const name of Object.keys(frozen.perGate)) {
    const a = frozen.perGate[name], b = fresh.perGate[name] || {};
    for (const f of ['pass', 'watch', 'block', 'na', 'notReached']) {
      if ((a[f] || 0) !== (b[f] || 0)) drift.push('gate ' + name + '.' + f + ': ' + (a[f] || 0) + ' -> ' + (b[f] || 0));
    }
  }
  if (fresh.universe.snapshotsBuilt !== frozen.universe.snapshotsBuilt) {
    drift.push('rows: ' + frozen.universe.snapshotsBuilt + ' -> ' + fresh.universe.snapshotsBuilt + ' (a different scan, not necessarily a regression)');
  }
  return drift;
}

module.exports = { collect, report, compare, baselineFile, baselineText, listBaselines, stampOf };

if (require.main === module) {
  const wantCheck = process.argv.includes('--check');
  const wantReissue = process.argv.includes('--reissue');

  // CHECK / RE-ISSUE read the frozen artifact's PINNED aux inputs and pass them back in,
  // so the recomputation measures the same bytes the freeze measured. Reading the live
  // shortlist instead would make the check depend on which side of GB's 5-minute funnel
  // cycle it ran on.
  const findFrozen = () => {
    // Filenames from before the aux-hash change have no _aux suffix; accept either.
    const exact = (scanStamp, aux) => path.join(SESS, 'phase4_baseline_' + hash() + '_' + scanStamp + (aux ? '_aux' + aux : '') + '.json');
    try {
      const cands = fs.readdirSync(SESS)
        .filter((f) => f.startsWith('phase4_baseline_' + hash() + '_') && f.endsWith('.json') && !/\.r\d+\.json$/.test(f))
        .sort().reverse();
      return cands.length ? path.join(SESS, cands[0]) : null;
    } catch (_) { return null; }
  };
  const r0 = collect();
  const scanStamp = stampOf(r0);
  const outJson = baselineFile(r0.configHash, scanStamp, r0.auxHash);
  const outTxt = baselineText(r0.configHash, scanStamp, r0.auxHash);
  fs.mkdirSync(SESS, { recursive: true });

  if (wantCheck || wantReissue) {
    const frozenPath = findFrozen();
    if (!frozenPath) {
      console.log('no frozen baseline for config ' + hash() + ' — run without flags to freeze one');
      process.exit(2);
    }
    const frozen = JSON.parse(fs.readFileSync(frozenPath, 'utf8'));
    const pin = frozen.auxPinned;
    if (!pin || !pin.screened) {
      console.log('frozen baseline ' + path.basename(frozenPath) + ' predates aux pinning — re-freeze it (delete the old file is NOT required; the new freeze supersedes it)');
      process.exit(2);
    }
    const aux = {
      capturedAt: pin.capturedAt,
      quality: { file: pin.quality.file, rows: pin.quality.rows },
      screened: { file: pin.screened.file, rows: pin.screened.rows },
    };
    const r = collect({ aux });
    console.log('comparing against ' + path.basename(frozenPath));
    const drift = compare(r, frozen);
    console.log('config ' + r.configHash + ' vs frozen ' + frozen.configHash + ' (frozen ' + frozen.frozenAt + ')'
      + '   scan ' + (r.scanHash || 'n/a') + ' vs ' + (frozen.scanHash || 'n/a')
      + '   aux ' + (r.auxHash || 'n/a') + ' vs ' + (frozen.auxHash || 'n/a'));

    if (wantCheck) {
      if (!drift.length) { console.log('NO DRIFT — gate layer matches the frozen Phase 4 baseline'); process.exit(0); }
      console.log('DRIFT (' + drift.length + ' finding(s)):');
      for (const d of drift) console.log('  - ' + d);
      process.exit(1);
    }

    // re-issue
    if (drift.length) {
      console.log('REFUSING to re-issue: the recomputation does NOT reproduce the frozen counts');
      for (const d of drift) console.log('  - ' + d);
      process.exit(1);
    }
    const jr = frozenPath.replace(/\.json$/, '');
    let rev = 2;
    while (fs.existsSync(jr + '.r' + rev + '.json')) rev++;
    r.reissue = {
      revision: rev,
      reason: 'report format revision — the exact gate/score configuration and pinned aux inputs are now rendered in the artifact',
      originalArtifact: path.basename(frozenPath),
      countsVerifiedEqualAgainst: path.basename(frozenPath),
    };
    r.frozenAt = frozen.frozenAt;      // the freeze time is a fact about the scan, not about this file
    fs.writeFileSync(jr + '.r' + rev + '.json', JSON.stringify(r, null, 2));
    fs.writeFileSync(jr.replace(/\.json$/, '') + '.r' + rev + '.txt', report(r));
    console.log(report(r));
    console.log('\nre-issued: ' + jr + '.r' + rev + '.json');
    process.exit(0);
  }

  const r = r0;

  if (fs.existsSync(outJson)) {
    const frozen = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    console.log('!! this exact scan is already frozen for config ' + r.configHash + ' (at ' + frozen.frozenAt + ').');
    console.log('   overwriting would destroy the reference the later phases validate against.');
    console.log('   re-run with --check to diff, or wait for GB to publish a newer scan.');
    process.exit(3);
  }
  fs.writeFileSync(outJson, JSON.stringify(r, null, 2));
  fs.writeFileSync(outTxt, report(r));
  console.log(report(r));
  console.log('\nfrozen: ' + outJson);
  console.log('        ' + outTxt);
}
