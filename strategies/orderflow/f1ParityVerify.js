/**
 * orderflow/f1ParityVerify.js — the live module's acceptance test.
 *
 * Replays the DISCOVERY tapes through orderflow/f1Live.js and asserts that it reproduces the
 * research run exactly: the same signals, the same entry/exit prices, the same gross bps and the
 * same exit reason. Signal parity alone is NOT enough - an earlier version of the module matched
 * 100% of signals while getting 55 of 323 trades' P&L wrong, because its early-exit test was too
 * loose. Only comparing the money catches that.
 *
 * The default run is the two DISCOVERY sessions - the frozen acceptance test, unchanged. Pass a
 * session (and optionally its split) to verify any other session the research path has also been
 * run on, e.g. the held-out day:
 *
 *   node orderflow/f1ParityVerify.js                     # 10-06 + 10-07, discovery
 *   node orderflow/f1ParityVerify.js 2026-10-08 heldout  # held-out cross-check
 *
 * NOTE ON 8.27K. This tool does not decide what may be run - it compares the two implementations
 * on whatever the research path wrote. A session it can verify is a session the research path
 * already produced trades for.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { createF1Live } = require('./f1Live');

const F1DIR = path.join(__dirname, '..', '..', 'backtest', 'f1');
const DISCOVERY = ['2026-10-06', '2026-10-07'];
// Default stays the two discovery sessions, so the frozen acceptance test is byte-for-byte the
// same check it was. An explicit session switches to it and infers the split from its name.
const ARG_DAY = process.argv[2] || null;
const DAYS = ARG_DAY ? [ARG_DAY] : DISCOVERY;
// ONLY an explicitly named, non-discovery session counts as held out. Defaulting the other way
// made the no-argument run look for `trades_heldout_*`, find no files, compare zero trades and
// print PASS - a green result from having checked nothing. The prefix must never be able to
// select an empty file set.
const SPLIT = process.argv[3] || (ARG_DAY && !DISCOVERY.includes(ARG_DAY) ? 'heldout' : 'discovery');
const CSV_PREFIX = 'trades_' + SPLIT + '_';
const TOL = 1e-6;

function readCsv(file, onlyDay) {
  const out = [];
  const txt = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const line of txt.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c[1] !== onlyDay) continue;
    out.push(c);
  }
  return out;
}

async function runDay(day) {
  const uni = JSON.parse(fs.readFileSync(path.join(F1DIR, 'universe.json'), 'utf8'));
  const live = createF1Live({
    symbols: uni.selected, log: () => {},
    journalPath: path.join(os.tmpdir(), 'f1-parity-' + day + '.jsonl'),
  });
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(__dirname, '..', '..', 'data', 'orderflow', 'ticks-' + day + '.jsonl')),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    try { live.onTick(JSON.parse(line)); } catch (e) { /* counted by the module */ }
  }
  live.closeSession();

  const mine = new Map();
  for (const s of live.signals()) {
    if (s.status !== 'closed' || s.usable === false) continue;
    mine.set(s.sym + '|' + s.barIdx + '|' + s.side + '|' + s.cell, s);
  }

  const theirs = new Map();
  for (const f of fs.readdirSync(F1DIR)) {
    if (!f.startsWith(CSV_PREFIX) || !f.endsWith('.csv')) continue;
    for (const c of readCsv(path.join(F1DIR, f), day)) {
      theirs.set(c[0] + '|' + c[16] + '|' + c[3] + '|' + c[2], c);
    }
  }

  // THE CSV IS WRITTEN TO 4 DECIMALS, so any column read back from it can only ever agree to
  // ~5e-5. Asserting the tight TOL against those columns would flag the FILE'S precision as a
  // failure; asserting nothing at all is how a real defect hid here. `mfe`/`mae` were floored at
  // -Infinity instead of 0, so a monotone winner reported a NEGATIVE adverse excursion
  // (ASIANPAINT 10-07 bar 71: 0.0000 vs -17.7590) while gross, exit reason and signal parity all
  // stayed perfect. Excursions and geometry get their own tolerance for that reason.
  const CSV_TOL = 2e-4;
  const GEOM = { mfe: 11, mae: 12, risk_bps: 9, tgt_bps: 10, fi: 13, bi: 14 };
  let matched = 0, grossBad = 0, whyBad = 0, maxDiff = 0, sumDiff = 0;
  const geomBad = {}, geomMax = {};
  for (const [k, c] of theirs) {
    const m = mine.get(k);
    if (!m) { grossBad++; continue; }
    matched++;
    const d = Math.abs(parseFloat(c[6]) - m.grossBps);
    sumDiff += d;
    if (d > maxDiff) maxDiff = d;
    if (d > TOL) grossBad++;
    const jsOf = { mfe: m.mfe, mae: m.mae, risk_bps: m.riskBps, tgt_bps: m.targetBps, fi: m.fi, bi: m.bi };
    for (const [col, idx] of Object.entries(GEOM)) {
      const py = parseFloat(c[idx]), js = jsOf[col];
      if (!Number.isFinite(py) || js == null) continue;
      const dd = Math.abs(py - js);
      geomMax[col] = Math.max(geomMax[col] || 0, dd);
      if (dd > CSV_TOL) geomBad[col] = (geomBad[col] || 0) + 1;
    }
    // `opposite-flow-close` is a research-only label for the last-bar case; the live module
    // reports the same price under its own name, so the two are compared as one group.
    const whyPy = c[15] === 'opposite-flow-close' ? 'opposite-flow' : c[15];
    const whyJs = m.why === 'opposite-flow-close' ? 'opposite-flow' : m.why;
    if (whyPy !== whyJs) whyBad++;
  }

  const geomMismatch = Object.values(geomBad).reduce((a, b) => a + b, 0);
  // VACUITY GUARD. Comparing nothing is not agreement. If the research trade files for this
  // session+split are absent (wrong prefix, wrong split, research never run), `theirs` is empty
  // and every mismatch counter stays at zero - which is indistinguishable from a perfect match.
  // That is how a wrong prefix reported PASS on the default run.
  const vacuous = theirs.size === 0;
  if (vacuous) {
    console.log('  ERROR: no research trades found for ' + SPLIT + ' / ' + day +
      ' (looked for ' + CSV_PREFIX + '*.csv in ' + F1DIR + ') - nothing was compared');
  }
  const mismatch = vacuous || grossBad || whyBad || geomMismatch;
  console.log('=== ' + day + ' ===');
  console.log('  research trades (all cells) : ' + theirs.size);
  console.log('  live trades matched         : ' + matched);
  console.log('  signals live missed         : ' + [...theirs.keys()].filter((k) => !mine.has(k)).length);
  console.log('  signals live invented       : ' + [...mine.keys()].filter((k) => !theirs.has(k)).length);
  console.log('  gross-bps mismatches >' + TOL + ' : ' + grossBad + '  (max |diff| = ' + maxDiff.toExponential(2) + ')');
  console.log('  exit-reason mismatches      : ' + whyBad);
  console.log('  excursion/geometry columns  : ' + (geomMismatch
    ? 'MISMATCHES ' + JSON.stringify(geomBad)
    : 'exact within CSV precision (max |diff| = ' +
      Math.max(...Object.values(geomMax).concat([0])).toExponential(2) + ')'));
  console.log('  VERDICT                     : ' + (mismatch ? 'FAIL' : 'PASS — live == research'));
  return mismatch;
}

(async () => {
  let failed = 0;
  for (const d of DAYS) failed += await runDay(d);
  console.log('\n' + (failed ? 'PARITY VERIFY: FAIL'
    : 'PARITY VERIFY: PASS (' + SPLIT + ': ' + DAYS.join(', ') + ')'));
  process.exitCode = failed ? 1 : 0;
})();
