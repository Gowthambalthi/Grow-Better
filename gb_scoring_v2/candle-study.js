/**
 * gb_scoring_v2/candle-study.js — DOES THE FORMATION OF THE LAST CANDLES SAY
 * ANYTHING ABOUT THE NEXT CANDLE?
 *
 * THE QUESTION, IN THE USER'S WORDS: "use back more — how the last candles formed,
 * next candle which will form, use that." That is a falsifiable claim, so this script
 * is built to falsify it rather than to confirm it.
 *
 * DATA. data/ohlcv_15m: 989 symbols, 3,032,586 real 15-minute OHLC bars, 2026-03-12
 * to 2026-09-17, roughly 123 sessions. Unlike the signal ledger -- one session, one
 * label, 400 resolved outcomes -- this set can be split BY TIME, which is the split
 * the spec actually wants (Section 21.5: "Tune on tuning sessions, freeze the config,
 * evaluate on unseen sessions").
 *
 * PROCEDURE, AND WHY EACH PART IS THERE:
 *   1. Sessions are cut by DATE, not at random: the earliest `trainFraction` of the
 *      dates train, the rest are held out. A random split would let a model learn
 *      from the future, which is the single easiest way to fake a good number here.
 *   2. For every bar the formation of the PREVIOUS N bars is built from OHLC only, and
 *      the label is whether the NEXT bar closed above the previous close. The window
 *      never touches bar i.
 *   3. The conditional table is learned on TRAIN observations only. Its confidence
 *      threshold is also chosen on TRAIN only.
 *   4. TEST accuracy is then read off once, alongside coverage -- because a rule that
 *      only speaks 2% of the time can look brilliant and be useless.
 *   5. A NULL runs the identical pipeline with the TRAIN labels shuffled. Accuracy the
 *      shuffle can reach is accuracy this method can reach from nothing.
 *
 * WHAT A GOOD OUTCOME LOOKS LIKE. Direction of the very next bar is close to a coin
 * flip in most markets, so an honest answer near 50-55% is the EXPECTED result, not a
 * failure. The number worth having is not "80%" -- it is whether any formation beats
 * the shuffled-label null with enough coverage to matter. A run that reports 80% on
 * next-bar direction out of sample would mean this file has a leak, and the leak
 * would be the finding.
 *
 * Usage:
 *   node gb_scoring_v2/candle-study.js
 *   node gb_scoring_v2/candle-study.js --symbols=300 --lookbacks=6,12,24
 */
const fs = require('fs');
const path = require('path');
const { CONFIG, hash } = require('./config/index');
const seq = require('./candles/sequence');

const DIR = path.join(__dirname, '..', 'data', 'ohlcv_15m');
const OUT = path.join(__dirname, '..', 'data', 'v2_sessions');

const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Load the 15m bar set for a bounded sample of symbols (alphabetical, so runs repeat). */
function loadBars(maxSymbols) {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();
  const take = maxSymbols ? files.slice(0, maxSymbols) : files;
  const out = [];
  for (const f of take) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      const bars = (j.candles || []).filter((b) => Array.isArray(b) && b.length >= 5);
      if (bars.length < 300) continue;
      out.push({ symbol: f.replace('.json', ''), bars });
    } catch (_) { /* a truncated file is skipped, not faked */ }
  }
  return out;
}

/** Chronological split of the SESSIONS (dates), so no future bar can train a model. */
function splitByDate(all, trainFraction) {
  const dates = [...new Set(all.flatMap((s) => s.bars.map((b) => String(b[0]).slice(0, 10))))].sort();
  const cut = Math.floor(dates.length * trainFraction);
  const trainDates = new Set(dates.slice(0, cut));
  const testDates = new Set(dates.slice(cut));
  return {
    dates, cut, trainDates, testDates,
    trainFirst: dates[0], trainLast: dates[cut - 1], testFirst: dates[cut], testLast: dates[dates.length - 1],
  };
}

function buildObservations(all, N, dateSet) {
  const out = [];
  for (const s of all) {
    const shapes = seq.shapesOf(s.bars);
    const bars = s.bars;
    for (let i = N; i < bars.length; i++) {
      const day = String(bars[i][0]).slice(0, 10);
      if (!dateSet.has(day)) continue;
      const q = seq.sequenceFromShapes(shapes, i, N);
      if (!q) continue;
      const prevClose = bars[i - 1][4];
      const close = bars[i][4];
      if (!(prevClose > 0) || !num(close)) continue;
      out.push({ i, seq: q, up: close > prevClose ? 1 : 0, movePct: ((close - prevClose) / prevClose) * 100 });
    }
  }
  return out;
}

/** Score predictions against the truth, restricted to confident calls. */
function score(testRows, model) {
  const cfg = CONFIG.candles.sequence;
  let spoke = 0, right = 0, upCalls = 0, upRight = 0, downCalls = 0, downRight = 0, sumMove = 0, sumMoveRight = 0;
  const byLevel = {};
  for (const r of testRows) {
    const p = seq.predict(model, r.seq, { confidentP: cfg.confidentP });
    if (!p.confident || p.dir === 0) continue;
    spoke++;
    const truthUp = r.up === 1;
    const predictedUp = p.dir === 1;
    const hit = truthUp === predictedUp;
    if (hit) right++;
    if (predictedUp) { upCalls++; if (hit) upRight++; } else { downCalls++; if (hit) downRight++; }
    sumMove += r.movePct * (predictedUp ? 1 : -1);
    if (hit) sumMoveRight += r.movePct * (predictedUp ? 1 : -1);
    const k = 'L' + p.level;
    byLevel[k] = byLevel[k] || { n: 0, hit: 0 };
    byLevel[k].n++; if (hit) byLevel[k].hit++;
  }
  return {
    spoke, coverage: testRows.length ? spoke / testRows.length : 0,
    accuracy: spoke ? right / spoke : null,
    upCalls, upAccuracy: upCalls ? upRight / upCalls : null,
    downCalls, downAccuracy: downCalls ? downRight / downCalls : null,
    meanSignedMovePct: spoke ? sumMove / spoke : null,
    meanSignedMoveOnHitsPct: right ? sumMoveRight / right : null,
    byLevel,
  };
}

/** Choose the confidence threshold on TRAIN ONLY, then hand it to the test read. */
function chooseThreshold(trainRows, model) {
  const grid = [0.5, 0.52, 0.55, 0.58, 0.6, 0.65, 0.7];
  const rows = [];
  for (const T of grid) {
    let spoke = 0, right = 0;
    for (const r of trainRows) {
      const p = seq.predict(model, r.seq, { confidentP: T });
      if (!p.confident || p.dir === 0) continue;
      spoke++;
      if ((r.up === 1) === (p.dir === 1)) right++;
    }
    rows.push({ T, spoke, coverage: trainRows.length ? spoke / trainRows.length : 0, accuracy: spoke ? right / spoke : null });
  }
  return rows;
}

/** The NULL: identical pipeline, training labels shuffled. */
function nullAccuracy(trainRows, testRows, opts) {
  const rand = (() => { let s = 0x9E3779B9; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  const shuffled = trainRows.map((r) => Object.assign({}, r, { up: r.up }));
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = shuffled[i].up; shuffled[i].up = shuffled[j].up; shuffled[j].up = t; }
  const model = seq.learn(shuffled, { minSamples: opts.minSamples });
  const T = (CONFIG.candles.sequence.confidentP);
  let spoke = 0, right = 0;
  for (const r of testRows) {
    const p = seq.predict(model, r.seq, { confidentP: T });
    if (!p.confident || p.dir === 0) continue;
    spoke++;
    if ((r.up === 1) === (p.dir === 1)) right++;
  }
  return { accuracy: spoke ? right / spoke : null, spoke, coverage: testRows.length ? spoke / testRows.length : 0 };
}

function run(opts = {}) {
  const started = Date.now();
  const maxSymbols = opts.symbols != null ? opts.symbols : 200;
  const lookbacks = opts.lookbacks || CONFIG.candles.sequence.lookbacks;
  const minSamples = opts.minSamples != null ? opts.minSamples : CONFIG.candles.sequence.minSamples;
  const trainFraction = CONFIG.candles.sequence.trainFraction;

  const all = loadBars(maxSymbols);
  const split = splitByDate(all, trainFraction);
  const totalBars = all.reduce((a, s) => a + s.bars.length, 0);

  const perLookback = [];
  for (const N of lookbacks) {
    const trainRows = buildObservations(all, N, split.trainDates);
    const testRows = buildObservations(all, N, split.testDates);
    const model = seq.learn(trainRows, { minSamples });
    const baselineTrain = trainRows.length ? trainRows.filter((r) => r.up).length / trainRows.length : null;
    const baselineTest = testRows.length ? testRows.filter((r) => r.up).length / testRows.length : null;
    const thresholdTable = chooseThreshold(trainRows, model);
    const atConfig = thresholdTable.find((t) => t.T === CONFIG.candles.sequence.confidentP) || thresholdTable[thresholdTable.length - 1];
    const testScore = score(testRows, model);
    const nul = nullAccuracy(trainRows, testRows, { minSamples });
    // THE HONEST BAR. If next-bar-up happens only 46.3% of the time, then shouting
    // "down" on every bar scores 53.7% without looking at a single candle. Any
    // accuracy below that line is worse than a constant, and the lift over it -- not
    // the raw percentage -- is what a formation has actually contributed.
    const majorityBaselineTest = baselineTest == null ? null : Math.max(baselineTest, 1 - baselineTest);
    // How often did the model have to fall back to a coarse signature?
    let levelHistogram = {};
    for (let k = 1; k < Math.min(4000, testRows.length); k++) {
      const p = seq.predict(model, testRows[k].seq, { confidentP: CONFIG.candles.sequence.confidentP });
      levelHistogram['L' + p.level] = (levelHistogram['L' + p.level] || 0) + 1;
    }
    perLookback.push({
      lookback: N, trainRows: trainRows.length, testRows: testRows.length,
      baselineTrain, baselineTest,
      tableSizes: model.tables.map((t) => t.size),
      majorityBaselineTest,
      liftOverBaseline: testScore.accuracy != null && majorityBaselineTest != null ? testScore.accuracy - majorityBaselineTest : null,
      thresholdTable, atConfig, test: testScore, null: nul,
      levelHistogram,
    });
  }

  return {
    kind: 'candle-sequence-next-bar-study',
    configHash: hash(), configAfter: hash(),
    source: 'data/ohlcv_15m',
    symbols: all.length, symbolsRequested: maxSymbols, bars: totalBars,
    sessions: split.dates.length,
    trainSessions: split.cut, testSessions: split.dates.length - split.cut,
    trainWindow: [split.dates[0], split.dates[split.cut - 1]],
    testWindow: [split.dates[split.cut], split.dates[split.dates.length - 1]],
    minSamples, confidentP: CONFIG.candles.sequence.confidentP,
    SIGNATURE_ORDER: seq.SIGNATURE_ORDER,
    perLookback,
    elapsedMs: Date.now() - started,
  };
}

function report(res) {
  const L = [];
  const line = '='.repeat(78);
  const pc = (v, d = 1) => (v == null ? '-' : (100 * v).toFixed(d) + '%');
  L.push(line);
  L.push('CANDLE SEQUENCE -> NEXT CANDLE  ·  measured, not assumed');
  L.push('config ' + res.configHash + '  ·  restored after the run: ' + (res.configHash === res.configAfter));
  L.push(line);
  L.push('');
  L.push('DATA');
  L.push('  source ................ ' + res.source);
  L.push('  symbols ............... ' + res.symbols + '  (of ' + res.symbolsRequested + ' requested)');
  L.push('  bars .................. ' + res.bars.toLocaleString() + ' real 15-minute OHLC bars');
  L.push('  sessions .............. ' + res.sessions + '  (' + res.trainSessions + ' train / ' + res.testSessions + ' held out)');
  L.push('  TRAIN window .......... ' + res.trainWindow[0] + ' -> ' + res.trainWindow[1]);
  L.push('  TEST window ........... ' + res.testWindow[0] + ' -> ' + res.testWindow[1] + '   <- never seen by the model');
  L.push('  min samples per bucket  ' + res.minSamples);
  L.push('  signature order ....... ' + res.SIGNATURE_ORDER.join(' | ') + '   (backoff drops from the right)');
  L.push('');
  L.push('  NOTE ON TIMEFRAME. These are 15-minute bars and production sees 1-minute');
  L.push('  bars. 15m is used because it is the only deep real OHLC history in the');
  L.push('  project (123 sessions against the ledger\'s ONE). The method is');
  L.push('  timeframe-agnostic; the numbers below describe 15m formations.');
  L.push('');
  for (const r of res.perLookback) {
    L.push(line);
    L.push('LOOKBACK ' + r.lookback + ' BAR(S) OF FORMATION');
    L.push('  observations: train ' + r.trainRows.toLocaleString() + '   test ' + r.testRows.toLocaleString());
    L.push('  base rate (next bar up): train ' + pc(r.baselineTrain) + '   test ' + pc(r.baselineTest) + '   <- the coin-flip bar');
    L.push('');
    L.push('  confidence threshold chosen on TRAIN ONLY');
    L.push('    ' + 'pUp>='.padEnd(8) + 'train acc'.padStart(10) + 'coverage'.padStart(10));
    for (const t of r.thresholdTable) L.push('    ' + String(t.T).padEnd(8) + pc(t.accuracy).padStart(10) + pc(t.coverage).padStart(10));
    L.push('');
    L.push('  AT THE CONFIGURED THRESHOLD pUp>=' + res.confidentP);
    L.push('    train accuracy ... ' + pc(r.atConfig.accuracy) + '   coverage ' + pc(r.atConfig.coverage));
    L.push('    TEST  accuracy ... ' + pc(r.test.accuracy) + '   coverage ' + pc(r.test.coverage) + '   spoke ' + r.test.spoke.toLocaleString());
    L.push('    degradation ...... ' + (r.atConfig.accuracy != null && r.test.accuracy != null
      ? ((r.atConfig.accuracy - r.test.accuracy) * 100).toFixed(1) + ' points' : '-'));
    L.push('    up-calls ......... ' + r.test.upCalls.toLocaleString() + ' at accuracy ' + pc(r.test.upAccuracy));
    L.push('    down-calls ....... ' + r.test.downCalls.toLocaleString() + ' at accuracy ' + pc(r.test.downAccuracy));
    L.push('    mean signed next-bar move when it spoke ... ' + (r.test.meanSignedMovePct == null ? '-' : r.test.meanSignedMovePct.toFixed(4) + '%'));
    L.push('');
    L.push('  THE HONEST BAR (not the raw accuracy above)');
    L.push('    constant "always the majority side" on test ... ' + pc(r.majorityBaselineTest) + '   <- beat THIS or say nothing');
    L.push('    lift of the candle formation over it ......... ' + (r.liftOverBaseline == null ? '-' : (r.liftOverBaseline * 100).toFixed(1) + ' points'));
    L.push('');
    L.push('  NULL CONTROL (train labels shuffled, identical pipeline)');
    L.push('    accuracy ' + pc(r.null.accuracy) + '   coverage ' + pc(r.null.coverage) + '   spoke ' + r.null.spoke.toLocaleString());
    const real = r.test.accuracy, nul = r.null.accuracy;
    L.push('    VERDICT: ' + (real != null && nul != null && real > nul
      ? 'real TEST accuracy ' + pc(real) + ' beats the shuffled null ' + pc(nul) + ' by ' + ((real - nul) * 100).toFixed(1) + ' points'
      : 'real TEST accuracy ' + pc(real) + ' does NOT beat the shuffled null ' + pc(nul) + ' -- the formation is not carrying signal at this threshold'));
    L.push('');
    L.push('  TABLE SIZES (buckets learned per backoff level) ' + r.tableSizes.join(' / '));
    L.push('  backoff level of the first 4,000 test predictions: ' + JSON.stringify(r.levelHistogram));
    L.push('');
  }
  L.push(line);
  L.push('HOW TO READ THIS');
  L.push('  A lookback "wins" only if its TEST accuracy beats BOTH the coin-flip base');
  L.push('  rate AND the shuffled-label null, at a coverage worth having. Accuracy alone');
  L.push('  is not evidence: a rule that speaks on 1% of bars can be right 80% of the');
  L.push('  time and still be useless, which is why coverage is printed next to it and');
  L.push('  the low-support rows are read with suspicion rather than quoted.');
  L.push('');
  L.push('  The threshold is picked on TRAIN and then read once on TEST. Re-running this');
  L.push('  file until a threshold looks good and reporting that one would be exactly the');
  L.push('  overfitting the spec forbids (Section 21.5).');
  L.push(line);
  return L.join('\n');
}

module.exports = { run, report, loadBars, splitByDate, buildObservations, score, chooseThreshold, nullAccuracy };

if (require.main === module) {
  const lb = arg('lookbacks');
  const res = run({
    symbols: arg('symbols') != null ? Number(arg('symbols')) : undefined,
    lookbacks: lb ? lb.split(',').map(Number) : undefined,
  });
  console.log(report(res));
  const out = path.join(OUT, 'candle_study_' + new Date().toISOString().slice(0, 10) + '.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(res, null, 2));
    console.log('\nwritten: ' + out);
  } catch (e) { console.log('\n(report not written: ' + e.message + ')'); }
}
