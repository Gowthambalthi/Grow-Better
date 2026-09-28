/**
 * gb_scoring_v2/tune.js — TUNE ON ONE SET, CHECK ON ANOTHER. PHASES 13-15 SCAFFOLD.
 *
 * THE REQUEST THIS ANSWERS: "use backtest until it gets 80%, then run it on a
 * different set and it should also come ~75%."
 *
 * That is the right instinct and it is exactly what Section 21 prescribes: choose
 * the knob values on a TRAINING set, freeze them, and measure the SAME knobs on a
 * HELD-OUT set you were not allowed to look at. The gap between the two numbers is
 * the whole point. If train is 80 and test is 75 the values are real; if train is 80
 * and test is 37 then the 80 was the sweep fitting noise.
 *
 * WHAT THIS HARNESS REFUSES TO DO:
 *
 *   1. It will not print a train number without the test number beside it.
 *   2. It will not let the probe scorer's standardization see the test rows
 *      (mean/sd come from TRAIN ONLY, then are applied to test).
 *   3. It will not choose a config by test performance. Best is chosen on TRAIN
 *      ONLY, subject to a minimum trade count; test is then read off, once.
 *   4. It will not accept a train number at face value. Every run also sweeps a
 *      NULL -- the same grid, the same rule, with the OUTCOME LABELS SHUFFLED. The
 *      best-train the shuffle can reach is what this sweep can reach from nothing,
 *      and a real best-train has to beat it to mean anything.
 *
 * WHAT IT IS HONEST ABOUT NOT HAVING:
 *
 *   * data/signal_ledger.json holds ONE session (2026-09-24), so "a different set"
 *     can only mean a different set of NAMES or a different slice of the CLOCK
 *     inside that one afternoon. Both splits are offered. Both are weaker than a
 *     held-out DAY, which is what the spec requires (>= 15 sessions). A one-day
 *     result cannot be promoted on, no matter how good it looks.
 *   * All 400 resolved episodes carry the old engine's `aligned` label. The
 *     held-out set is therefore that engine's own accepted bucket, not a sample of
 *     the board.
 *   * The ranking uses the PROBE SCORER below, not the V3 engine. Phases 6-11 are
 *     unbuilt, and the ledger itself carries no ATR% -- but the adapter merges the
 *     funnel's quality set, which DOES supply ATR% for 392/400 of these episodes.
 *     So the real Phase-5 volatility-normalized momentum IS computable here and its
 *     scaling knobs are in the grid. The rest of the 58-point ledger is not.
 *   * A lookahead caveat: universe_filtered.json was generated at 13:14 on the same
 *     session, so the static reference values merged into rows from earlier in the
 *     day had not been published yet. ATR% and 20-day volume move slowly, so the
 *     effect should be small -- but it is a real one and it is not zero.
 *
 * Usage:
 *   node gb_scoring_v2/tune.js                       # both splits, with null
 *   node gb_scoring_v2/tune.js --split=symbol
 *   node gb_scoring_v2/tune.js --nulls=1000
 */
const fs = require('fs');
const path = require('path');
const { CONFIG, hash } = require('./config/index');
const { runGates } = require('./gates');
const momentum = require('./momentum');
const location = require('./location');
const candles = require('./candles');
const { loadQuality, loadScreened } = require('./adapter');
const { loadLedger, dedupeEpisodes, directionOf, rowToSnapshot } = require('./backtest');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// THE TUNING SURFACE. Every entry is a REAL config path, so a value this harness
// likes can be written back into gb_scoring_v2/config/index.js and hashed -- it is
// never a private copy. Values not listed are held fixed.
//
// Grouped because the two families cost differently: a gate knob changes which rows
// are BLOCKED, a momentum knob changes how the survivors RANK. The sweep recomputes
// each family once per distinct signature rather than once per grid point.
// ---------------------------------------------------------------------------
const GATE_KNOBS = [
  { path: 'gates.conflict.strongOpposition',      values: [0.25, 0.5, 1.0] },
  { path: 'gates.direction.minIndependentGroups', values: [2, 3] },
  { path: 'gates.liquidity.minAvgVol20',          values: [300000, 800000, 2000000] },
  { path: 'gates.spread.maxSpreadPct',            values: [0.15, 0.5] },
];
const MOM_KNOBS = [
  { path: 'roc.clipZ',            values: [2, 3, 4] },
  { path: "roc.sigmaFromAtr.1m",  values: [0.15, 0.20, 0.30] },
  { path: "roc.sigmaFromAtr.5m",  values: [0.60, 1.00, 1.40] },
];
const KNOBS = GATE_KNOBS.concat(MOM_KNOBS);

// How much of the candidate set the engine may take: a percentile of the TRAIN
// score distribution, applied to the test rows as an absolute value so the test set
// never contributes to its own cut.
const TAKE_SHARES = [1.0, 0.5, 0.3, 0.2, 0.1];

const MIN_TRAIN_TAKEN = 40;   // pre-registered floor on trade count for the choice
const REALLY_SMALL_N = 10;    // used only to show how cheap a high train number is

// Non-momentum probe inputs, direction-aligned (a SHORT wants negative ROC).
const PLAIN_FEATURES = ['roc1', 'roc3', 'roc5', 'roc15', 'volRoc', 'flowBias'];
const NODIR_FEATURES = ['volX'];

// ---------------------------------------------------------------------------
// SECTION 21.6 INCREMENTAL VALIDATION. "Each deferred component is added to the
// frozen v1 baseline and validated on its own. If it does not improve out-of-sample
// separation, it stays display-only, is simplified, or is removed."
//
// So the sweep is not run once over one pile of features. It is run once per STAGE,
// each stage adding exactly one component family to the stage before it, and each
// stage reports its own train and test numbers against the same null. That is the
// difference between "we used everything and it looked better" and "this component
// earned its place".
// ---------------------------------------------------------------------------
const STAGES = [
  { name: 'baseline (momentum + ROC + flow)', families: ['plain'] },
  { name: '+ location (VWAP / POC / value area)', families: ['plain', 'location'] },
  { name: '+ candle context (gap + patterns)', families: ['plain', 'location', 'candles'] },
];

// ---------------------------------------------------------------------------
// SPLITS.
// ---------------------------------------------------------------------------
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h >>> 0;
}
function istHour(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 5.5 * 3600e3).getUTCHours() : null;
}

const SPLITS = {
  /**
   * symbol — GROUP holdout. 70% of NAMES train, 30% test. The closest thing to "a
   * different set" that one session can offer: held-out names never appear in
   * training, so a value that only works for particular symbols cannot survive.
   */
  symbol(rows) {
    const train = [], test = [];
    for (const r of rows) ((fnv(String(r.symbol)) % 100) < 70 ? train : test).push(r);
    return { name: 'symbol (70% of names train / 30% held out)', train, test };
  },
  /**
   * time — CLOCK holdout. IST 11:00-12:59 train, 13:00-14:59 test. Every name may
   * appear on both sides, so this is weaker than the symbol split against
   * symbol-specific fitting, but it does exercise a different part of the session.
   */
  time(rows) {
    const train = [], test = [];
    for (const r of rows) {
      const h = istHour(r.time);
      if (h == null) continue;
      (h <= 12 ? train : test).push(r);
    }
    return { name: 'time (IST 11-12 train / 13-14 held out)', train, test };
  },
};

// ---------------------------------------------------------------------------
// THE PROBE SCORER. Equal-weighted, direction-aligned, TRAIN-standardized.
//
// Components:
//   momNorm  — the real Phase-5 normalized momentum: mean of the bounded e_h over
//              every horizon that has BOTH a ROC and an ATR. This is the V3 math,
//              computed by the V3 module, so its scaling knobs are exercised for
//              real. Scaled x100 because e is in [-1,1] and the ROC features are in
//              percent; without the scale the standardization would compress it away.
//   plain    — the ledger's own ROC / volume-ROC / flow-bias, direction-aligned.
//   nodir    — volume ratio, NOT direction-aligned (high activity is high activity).
//
// A row with no direction, or with no usable component at all, scores null and is
// not a trade. Silently scoring it 0 would invent an opinion the data does not have.
// ---------------------------------------------------------------------------
function makeProbeScorer(components, dirSigns, trainIdx) {
  const stats = {};
  for (const f of Object.keys(components)) {
    const vals = trainIdx.map((i) => components[f](i)).filter((v) => v != null);
    if (vals.length < 20) { stats[f] = null; continue; }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    stats[f] = sd > 0 ? { mean, sd } : null;
  }
  const used = Object.keys(components).filter((f) => stats[f]);
  // Directionality is per-component and declared, never inferred. The location and
  // candle engines already return a DIRECTION-ALIGNED value (they take `direction`),
  // so multiplying them by dirSign again here would flip them twice. Components that
  // arrive raw are aligned once, right here.
  const RAW = { volX: 0, roc1: 1, roc3: 1, roc5: 1, roc15: 1, volRoc: 1, flowBias: 1, momNorm: 1 };
  const score = (i) => {
    const d = dirSigns[i];
    if (d !== 1 && d !== -1) return null;
    let s = 0, n = 0;
    for (const f of used) {
      const v = components[f](i);
      if (v == null) continue;
      const mul = RAW[f] === 0 ? 1 : (RAW[f] === 1 ? d : 1);
      s += ((v - stats[f].mean) / stats[f].sd) * mul;
      n++;
    }
    return n ? s / n : null;
  };
  return { score, stats, used, standardizedOn: 'train only' };
}

/** Phase-5 normalized momentum, reduced to one number. Null when ATR is unknown. */
function momNormOf(snapshot, opts) {
  const ev = momentum.normalizedRoc(snapshot, opts);
  const es = Object.keys(ev.horizons).map((h) => ev.horizons[h].e).filter((e) => e != null);
  if (!es.length) return null;
  return es.reduce((a, b) => a + b, 0) / es.length;
}

/**
 * Component extractors that do NOT depend on any knob. They take an INDEX, not a row,
 * because the location and candle families read the SNAPSHOT (one per index) while the
 * ROC/flow family reads the ledger row. Mixing those two domains is the bug an earlier
 * version of this file had, so the index is the single key for everything here.
 */
function baseComponents(rows) {
  const c = {};
  for (const f of PLAIN_FEATURES) c[f] = (i) => num(rows[i][f]);
  for (const f of NODIR_FEATURES) c[f] = (i) => num(rows[i][f]);
  return c;
}

// ---------------------------------------------------------------------------
// CONFIG MUTATION. Sweeping mutates the live CONFIG in place (the modules read it
// at call time), so every touched path is snapshotted and restored. The hash after
// the sweep must equal the hash before, and the report prints both.
// ---------------------------------------------------------------------------
function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, p, v) {
  const parts = p.split('.');
  const last = parts.pop();
  parts.reduce((o, k) => o[k], obj)[last] = v;
}
function gridPoints(knobs) {
  let points = [{}];
  for (const k of knobs) {
    const next = [];
    for (const p of points) for (const v of k.values) next.push(Object.assign({}, p, { [k.path]: v }));
    points = next;
  }
  return points;
}
const sig = (point, knobs) => knobs.map((k) => k.path + '=' + point[k.path]).join('|');

// ---------------------------------------------------------------------------
// METRICS.
// ---------------------------------------------------------------------------
/** Wilson 95% interval — correct at these sample sizes; the normal one is not. */
function wilson(hits, n, z = 1.96) {
  if (!n) return null;
  const p = hits / n;
  const den = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const sp = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [+((c - sp) / den).toFixed(3), +((c + sp) / den).toFixed(3)];
}
function metric(yFlags, indices) {
  let n = 0, hits = 0;
  for (let k = 0; k < indices.length; k++) { const i = indices[k]; if (yFlags[i] == null) continue; n++; if (yFlags[i]) hits++; }
  return { n, hits, hitRate: n ? hits / n : null, ci: wilson(hits, n) };
}
const pct = (v, d = 1) => (v == null ? '-' : (100 * v).toFixed(d) + '%');
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function sameArr(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// THE MATRIX.
//
// Gate verdicts depend only on the row's own fields, and momentum normalization
// depends only on the momentum knobs — neither depends on the OUTCOME. Both are
// therefore computed once per distinct signature and reused by every metric and
// every label shuffle below, which is what makes the null control affordable.
// ---------------------------------------------------------------------------
function buildMatrix(split) {
  const rows = split.train.concat(split.test);
  const n = rows.length;
  const quality = loadQuality();
  const screened = loadScreened();
  const snaps = rows.map((r) => rowToSnapshot(
    r, quality.get(String(r.symbol || '').toUpperCase()), screened.get(String(r.symbol || '').toUpperCase())));

  const gateSigs = new Map();
  const momSigs = new Map();
  const gatePoints = gridPoints(GATE_KNOBS);
  const momPoints = gridPoints(MOM_KNOBS);
  const original = KNOBS.map((k) => getPath(CONFIG, k.path));
  const dirSigns = rows.map((r) => num(r.dirSign));
  const trainIdx = split.train.map((_, i) => i);

  // KNOB-INDEPENDENT FAMILY VALUES, computed once. Location and candle evidence do
  // not depend on any knob in the grid, so recomputing them per grid point would burn
  // time for an identical answer.
  const locVal = rows.map((r, i) => (snaps[i] ? location.locationEvidence(snaps[i], {}).raw : null));
  const candleVal = rows.map((r, i) => (snaps[i] ? candles.candleEvidence(snaps[i], { direction: directionOf(r) }).value : null));
  const familyCoverage = {
    momentum: rows.filter((r) => num(r.roc1) != null || num(r.roc3) != null || num(r.roc5) != null || num(r.roc15) != null).length,
    location: locVal.filter((v) => v != null).length,
    candles: candleVal.filter((v) => v != null).length,
  };

  try {
    for (const point of gatePoints) {
      for (const k of GATE_KNOBS) setPath(CONFIG, k.path, point[k.path]);
      const blocked = new Uint8Array(n);
      const blockedBy = {};
      rows.forEach((r, i) => {
        const s = snaps[i];
        if (!s) { blocked[i] = 1; blockedBy.NO_SNAPSHOT = (blockedBy.NO_SNAPSHOT || 0) + 1; return; }
        const res = runGates(s, {
          direction: directionOf(r), now: Date.parse(r.time) || Date.now(),
          receiptTs: Date.parse(r.time) || Date.now(), market: null, banned: [],
        });
        if (res.blockedBy) { blocked[i] = 1; blockedBy[res.blockedBy] = (blockedBy[res.blockedBy] || 0) + 1; return; }
      });
      gateSigs.set(sig(point, GATE_KNOBS), { blocked, blockedBy, point });
    }

    for (const point of momPoints) {
      for (const k of MOM_KNOBS) setPath(CONFIG, k.path, point[k.path]);
      const momNorm = rows.map((r, i) => (snaps[i] ? momNormOf(snaps[i], { now: Date.parse(r.time) || Date.now() }) : null));
      const components = Object.assign(baseComponents(rows), {
        momNorm: (i) => momNorm[i],
        // The location and candle engines return a DIRECTION-ALIGNED value themselves,
        // so they are handed the direction and are NOT multiplied by dirSign again in
        // the scorer (see RAW in makeProbeScorer).
        location: (i) => locVal[i],
        candles: (i) => candleVal[i],
      });
      // One scorer PER STAGE, each standardized on the train rows only, and each
      // adding exactly one family to the stage before it (spec 21.6).
      const scorers = {}, scores = {};
      for (const st of STAGES) {
        const sub = {};
        const wanted = st.families.includes('plain') ? Object.keys(baseComponents(rows)) : [];
        for (const f of wanted) sub[f] = components[f];
        if (st.families.includes('location')) sub.location = components.location;
        if (st.families.includes('candles')) sub.candles = components.candles;
        // `momNorm` is the momentum family and is present in every stage: it is the
        // baseline, not an added component.
        sub.momNorm = components.momNorm;
        // rows = train.concat(test), so train occupies indices 0..train.length-1.
        const sc = makeProbeScorer(sub, dirSigns, trainIdx);
        scorers[st.name] = sc;
        scores[st.name] = rows.map((r, i) => sc.score(i));
      }
      momSigs.set(sig(point, MOM_KNOBS), { point, momNorm, scorers, scores });
    }
  } finally {
    // Restore, so a sweep can never leave the process running on tuned-but-unfrozen
    // values, and so the hash the report prints is the committed one.
    KNOBS.forEach((k, i) => setPath(CONFIG, k.path, original[i]));
  }

  // WHICH KNOBS ACTUALLY DID ANYTHING. A knob that never changed a verdict (or never
  // moved the ranking) is not evidence of anything; it is a value this data cannot
  // speak to, and the report says so rather than presenting it as a tuning decision.
  // Attribution compares only points that differ in exactly one knob.
  const attribution = {};
  for (const k of KNOBS) attribution[k.path] = false;
  // Gate knobs: compare BLOCK masks.
  for (let a = 0; a < gatePoints.length; a++) {
    for (let b = a + 1; b < gatePoints.length; b++) {
      const diff = GATE_KNOBS.filter((k) => gatePoints[a][k.path] !== gatePoints[b][k.path]);
      if (diff.length !== 1 || attribution[diff[0].path]) continue;
      const A = gateSigs.get(sig(gatePoints[a], GATE_KNOBS));
      const B = gateSigs.get(sig(gatePoints[b], GATE_KNOBS));
      if (!A || !B) continue;
      let differs = false;
      for (let i = 0; i < n; i++) if (A.blocked[i] !== B.blocked[i]) { differs = true; break; }
      if (differs) attribution[diff[0].path] = true;
    }
  }
  // Momentum knobs: compare SCORE vectors (a knob can re-rank without unblocking).
  for (let a = 0; a < momPoints.length; a++) {
    for (let b = a + 1; b < momPoints.length; b++) {
      const diff = MOM_KNOBS.filter((k) => momPoints[a][k.path] !== momPoints[b][k.path]);
      if (diff.length !== 1 || attribution[diff[0].path]) continue;
      const A = momSigs.get(sig(momPoints[a], MOM_KNOBS));
      const B = momSigs.get(sig(momPoints[b], MOM_KNOBS));
      if (!A || !B) continue;
      if (!sameArr(A.scores[STAGES[0].name], B.scores[STAGES[0].name])) attribution[diff[0].path] = true;
    }
  }

  return { rows, snaps, n, gateSigs, momSigs, attribution, gatePoints, momPoints, familyCoverage, dirSigns };
}

/** Expand gate x momentum x takeShare into the list of candidate configs, for ONE stage. */
function expand(matrix, idx, stageName) {
  const out = [];
  for (const g of matrix.gateSigs.values()) {
    for (const m of matrix.momSigs.values()) {
      const scoreVec = m.scores[stageName];
      // Cut is the TRAIN quantile of the score among rows this point would take.
      const trainScores = [];
      for (const i of idx.train) {
        if (g.blocked[i]) continue;
        const s = scoreVec[i];
        if (s != null) trainScores.push(s);
      }
      trainScores.sort((a, b) => b - a);
      for (const takeShare of TAKE_SHARES) {
        const k = Math.max(1, Math.floor(trainScores.length * takeShare));
        const cut = trainScores.length ? trainScores[Math.min(k, trainScores.length) - 1] : Infinity;
        const tr = [], te = [];
        for (let i = 0; i < matrix.n; i++) {
          if (g.blocked[i]) continue;
          const s = scoreVec[i];
          if (s == null || s < cut) continue;
          (idx.train.has(i) ? tr : te).push(i);
        }
        out.push({
          point: Object.assign({}, g.point, m.point), takeShare, tr, te,
          blockedBy: g.blockedBy, gateSig: sig(g.point, GATE_KNOBS), momSig: sig(m.point, MOM_KNOBS),
        });
      }
    }
  }
  return out;
}

/**
 * bestOnTrain — the pre-registered choice rule. Highest TRAIN hit rate among configs
 * that took at least `minN` train candidates. Ties break toward the larger train
 * sample, then toward the more conservative take share. Test is never consulted.
 */
function bestOnTrain(results, minN) {
  const eligible = results.filter((r) => r.train.n >= minN);
  if (!eligible.length) return null;
  eligible.sort((a, b) => (b.train.hitRate - a.train.hitRate) || (b.train.n - a.train.n) || (a.takeShare - b.takeShare));
  return eligible[0];
}

// ---------------------------------------------------------------------------
// ORCHESTRATION.
// ---------------------------------------------------------------------------
function run(opts = {}) {
  const splitNames = opts.split ? [opts.split] : ['symbol', 'time'];
  const nulls = opts.nulls != null ? opts.nulls : 400;
  const reports = [];

  const raw = loadLedger();
  const resolved = dedupeEpisodes(raw)
    .filter((r) => r.outcome && num(r.outcome.rMultiple) != null && !r.outcome.unreliable);
  const y = resolved.map((r) => (num(r.outcome.rMultiple) > 0 ? 1 : 0));
  const noDirection = resolved.filter((r) => directionOf(r) == null).length;

  for (const name of splitNames) {
    const split = SPLITS[name](resolved);
    const idx = { train: new Set(), test: new Set() };
    for (let i = 0; i < split.train.length; i++) idx.train.add(i);
    for (let i = split.train.length; i < resolved.length; i++) idx.test.add(i);

    const matrix = buildMatrix(split);
    const base = { train: metric(y, [...idx.train]), test: metric(y, [...idx.test]) };
    const q = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null);
    const momList = [...matrix.momSigs.values()];
    const stageReports = [];

    for (const stage of STAGES) {
      const points = expand(matrix, idx, stage.name);
      const results = points.map((p) => ({
        point: p.point, takeShare: p.takeShare, blockedBy: p.blockedBy,
        train: metric(y, p.tr), test: metric(y, p.te),
      }));
      const chosen = bestOnTrain(results, MIN_TRAIN_TAKEN);
      const chosenSmall = bestOnTrain(results, REALLY_SMALL_N);
      // THE GRID CEILING, AT ANY TRADE COUNT. This is the number a "keep sweeping
      // until train reaches X%" loop would actually find, and printing it is the
      // fastest way to answer whether such a loop can ever terminate at X.
      const ceil = results.slice().sort((a, b) => (b.train.hitRate - a.train.hitRate) || (b.train.n - a.train.n))[0] || null;

      // NULL CONTROL — same grid, same rule, shuffled labels.
      const rand = rng(0xC0FFEE);
      const nullBest = [], nullAtChosen = [];
      const chosenIdx = chosen ? points.findIndex((p) => p.gateSig === sig(chosen.point, GATE_KNOBS)
        && p.momSig === sig(chosen.point, MOM_KNOBS) && p.takeShare === chosen.takeShare) : -1;
      for (let it = 0; it < nulls; it++) {
        const yv = y.slice();
        for (let i = yv.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = yv[i]; yv[i] = yv[j]; yv[j] = t; }
        let bh = -1, bn = 0, bi = -1;
        for (let e = 0; e < points.length; e++) {
          const m = metric(yv, points[e].tr);
          if (m.n < MIN_TRAIN_TAKEN) continue;
          if (m.hitRate > bh || (m.hitRate === bh && m.n > bn)) { bh = m.hitRate; bn = m.n; bi = e; }
        }
        if (bi >= 0) nullBest.push(bh);
        if (chosenIdx >= 0) nullAtChosen.push(metric(yv, points[chosenIdx].tr).hitRate);
      }
      nullBest.sort((a, b) => a - b);

      // The ceiling: best train hit rate from taking only a handful of names, ordered
      // by THIS stage's score. Shown to make the point that a high TRAIN number is cheap.
      let tiny = null;
      {
        const one = points.find((p) => p.takeShare === 1.0);
        const m = one && matrix.momSigs.get(one.momSig);
        const g = one && matrix.gateSigs.get(one.gateSig);
        const vec = m ? m.scores[stage.name] : null;
        const all = [];
        if (one && vec && g) {
          for (const i of idx.train) {
            if (g.blocked[i]) continue;
            const s = vec[i];
            if (s == null) continue;
            all.push({ i, s, y: y[i] });
          }
          all.sort((a, b) => b.s - a.s);
        }
        const top = all.slice(0, REALLY_SMALL_N);
        tiny = { n: top.length, hit: top.length ? top.filter((o) => o.y).length / top.length : null, of: all.length };
      }

      stageReports.push({
        stage: stage.name, families: stage.families,
        gridSize: points.length,
        results, chosen, chosenSmall,
        // Below MIN_TRAIN_TAKEN names, deliberately: what a 10-name subset can claim.
        chosenSmallReported: chosenSmall
          ? { train: chosenSmall.train, test: chosenSmall.test, point: chosenSmall.point, takeShare: chosenSmall.takeShare } : null,
        nullControl: {
          iterations: nullBest.length,
          bestTrainMedian: q(nullBest, 0.5), bestTrainP95: q(nullBest, 0.95),
          bestTrainMax: nullBest.length ? nullBest[nullBest.length - 1] : null,
          atChosenMedian: q(nullAtChosen, 0.5), atChosenP95: q(nullAtChosen, 0.95),
        },
        componentsUsed: momList.length && momList[0].scorers[stage.name] ? momList[0].scorers[stage.name].used : [],
        ceiling: ceil ? {
          train: ceil.train, test: ceil.test, nTrain: ceil.train.n, nTest: ceil.test.n,
          takeShare: ceil.takeShare, point: ceil.point,
        } : null,
        tiny,
        distinctMomRankings: new Set(momList.map((m) => m.scores[stage.name].map((s) => (s == null ? 'n' : s.toFixed(4))).join(','))).size,
      });
    }

    reports.push({
      split: split.name,
      trainN: split.train.length, testN: split.test.length,
      base, stages: stageReports,
      gateGrid: matrix.gatePoints.length, momGrid: matrix.momPoints.length,
      attribution: matrix.attribution,
      familyCoverage: matrix.familyCoverage,
      noDirection,
      atrAvailable: resolved.filter((r, i) => {
        const s = matrix.snaps[i]; return s && s.price_evidence && s.price_evidence.atrPct != null;
      }).length,
    });
  }

  return {
    kind: 'train-test-tuning',
    configHashBefore: hash(), configHashAfter: hash(),
    source: 'data/signal_ledger.json',
    sessions: [...new Set(raw.map((r) => String(r.time || '').slice(0, 10)))],
    resolvedRows: resolved.length,
    baseRateR: resolved.length ? y.reduce((a, b) => a + b, 0) / resolved.length : null,
    splits: reports,
    primaryMetric: CONFIG.validation.metric,
    metricLocked: CONFIG.validation.locked,
    weightsLocked: CONFIG.score.weightsLocked,
    minTrainTaken: MIN_TRAIN_TAKEN,
  };
}

// ---------------------------------------------------------------------------
// REPORT.
// ---------------------------------------------------------------------------
function report(res) {
  const L = [];
  const line = '='.repeat(78);
  L.push(line);
  L.push('TRAIN / TEST TUNING  ·  Phase 13-15 scaffold');
  L.push('config ' + res.configHashBefore + '  ·  restored after every sweep: ' + (res.configHashBefore === res.configHashAfter));
  L.push('source: ' + res.source + '  ·  sessions: ' + res.sessions.join(', '));
  L.push(line);
  L.push('');
  L.push('WHAT WAS TUNED, AND ON WHAT');
  L.push('  resolved episodes (numeric rMultiple) . ' + res.resolvedRows);
  L.push('  base hit rate (rMultiple > 0) ........ ' + pct(res.baseRateR) + '   <- the number to beat');
  L.push('  primary metric ....................... ' + res.primaryMetric);
  L.push('  primary metric LOCKED ................ ' + res.metricLocked + '   <- spec 21.1 wants this true');
  L.push('  weights LOCKED ....................... ' + res.weightsLocked + '   <- spec 17 wants this false until Phase 15');
  L.push('');
  L.push('  *** THE THREE FACTS THAT LIMIT EVERY NUMBER BELOW ***');
  L.push('  1. ONE session (' + res.sessions.join(', ') + '). The spec needs >= 15 for a day-level');
  L.push('     interval. "A different set" here can only be a different set of NAMES or');
  L.push('     a different slice of the CLOCK inside one afternoon. Neither can detect a');
  L.push('     day-regime effect, and a one-day result cannot be promoted.');
  L.push('  2. All 400 resolved episodes carry the old engine\'s `aligned` label, so the');
  L.push('     held-out set is that engine\'s own accepted bucket, not a sample of the board.');
  L.push('  3. The static reference merged in (ATR%, 20d volume) comes from');
  L.push('     universe_filtered.json, generated 13:14 on the same session -- so rows from');
  L.push('     the morning carry a mild lookahead. ATR% and 20d volume move slowly, so the');
  L.push('     effect is small, but it is not zero.');

  for (const s of res.splits) {
    L.push('');
    L.push(line);
    L.push('SPLIT: ' + s.split);
    L.push('  train ' + s.trainN + ' episodes  ·  test ' + s.testN + ' episodes  ·  grid per stage '
      + (s.gateGrid * s.momGrid * TAKE_SHARES.length) + ' configs (' + s.gateGrid + ' gate x ' + s.momGrid + ' momentum x ' + TAKE_SHARES.length + ' take shares)');
    L.push('  base train ' + pct(s.base.train.hitRate) + ' (n ' + s.base.train.n + ')   base test '
      + pct(s.base.test.hitRate) + ' (n ' + s.base.test.n + ')');
    L.push('  train episodes with ATR% available (Phase-5 runnable): ' + s.atrAvailable);
    L.push('  component families LEGIBLE on this data (ALL ' + (s.trainN + s.testN) + ' episodes):');
    L.push('    momentum (normalized ROC + ROC + flow) ... ' + s.familyCoverage.momentum);
    L.push('    location (VWAP / POC / value area / stack) . ' + s.familyCoverage.location);
    L.push('    candle context (gap + patterns) .......... ' + s.familyCoverage.candles);
    if (s.familyCoverage.candles === 0) {
      L.push('  !! CANDLE CONTEXT IS ZERO ON THIS DATA, BY RECORDING GAP, NOT BY FINDING.');
      L.push('     The ledger stores no gap / candlePattern / candleTrend (measured 0/10,508), so');
      L.push('     the "+ candle context" stage below cannot move any number -- its row is identical');
      L.push('     to the stage before it by construction. The snapshot recorder NOW persists those');
      L.push('     fields, so the next recorded session makes this stage measurable.');
    }
    L.push('');
    L.push('  WHICH KNOBS ACTUALLY DID ANYTHING');
    for (const k of Object.keys(s.attribution)) L.push('    ' + (s.attribution[k] ? 'BIT  ' : 'INERT') + '  ' + k);
    L.push('');
    L.push('  SECTION 21.6 INCREMENTAL VALIDATION — one family added per stage');
    L.push('    ' + 'stage'.padEnd(40) + 'train'.padStart(8) + 'test'.padStart(8) + 'n_tr'.padStart(6) + 'nullp95'.padStart(9) + '  verdict');
    for (const st of s.stages) {
      const c = st.chosen;
      const n95 = st.nullControl.bestTrainP95;
      const v = !c ? 'no config cleared n>=' + res.minTrainTaken
        : (c.train.hitRate != null && n95 != null && c.train.hitRate > n95 ? 'BEATS null' : 'within null (noise)');
      L.push('    ' + st.stage.padEnd(40)
        + String(c ? pct(c.train.hitRate) : '-').padStart(8)
        + String(c ? pct(c.test.hitRate) : '-').padStart(8)
        + String(c ? c.train.n : '-').padStart(6)
        + String(pct(n95)).padStart(9) + '  ' + v);
    }
    L.push('');
    for (const st of s.stages) {
      L.push('  --- ' + st.stage + ' ---');
      L.push('    components: ' + st.componentsUsed.join(', '));
      if (!st.chosen) { L.push('    NO CONFIG CLEARED MIN ' + res.minTrainTaken + ' TRADES.'); L.push(''); continue; }
      L.push('    chosen on TRAIN only (test unread at choice time):');
      L.push('      train  ' + pct(st.chosen.train.hitRate) + '   CI ' + JSON.stringify(st.chosen.train.ci) + '   n ' + st.chosen.train.n);
      L.push('      TEST   ' + pct(st.chosen.test.hitRate) + '   CI ' + JSON.stringify(st.chosen.test.ci) + '   n ' + st.chosen.test.n);
      L.push('      degradation train->test: ' + (st.chosen.train.hitRate != null && st.chosen.test.hitRate != null
        ? ((st.chosen.train.hitRate - st.chosen.test.hitRate) * 100).toFixed(1) + ' points' : '-'));
      L.push('      takeShare ' + st.chosen.takeShare + '   config ' + JSON.stringify(st.chosen.point));
      L.push('    null over ' + st.nullControl.iterations + ' label shuffles: median '
        + pct(st.nullControl.bestTrainMedian) + '   p95 ' + pct(st.nullControl.bestTrainP95) + '   max ' + pct(st.nullControl.bestTrainMax));
      if (st.ceiling) L.push('    GRID CEILING, any trade count (what a "sweep until train hits X%" loop\n      would find): train ' + pct(st.ceiling.train.hitRate) + ' at n ' + st.ceiling.nTrain
        + '  ->  test ' + pct(st.ceiling.test.hitRate) + ' at n ' + st.ceiling.nTest
        + '  -- the highest train value in the grid');
      if (st.tiny) L.push('    top ' + st.tiny.n + ' train names by score: ' + pct(st.tiny.hit) + '  (of ' + st.tiny.of + ' taken) -- proves nothing at that size');
      if (st.chosenSmallReported) L.push('    for reference, best at only n>=' + REALLY_SMALL_N + ': train ' + pct(st.chosenSmallReported.train.hitRate)
        + ' (n ' + st.chosenSmallReported.train.n + ')  ->  test ' + pct(st.chosenSmallReported.test.hitRate) + ' (n ' + st.chosenSmallReported.test.n + ')');
      L.push('');
    }
    L.push('  TOP TRAIN CONFIGS AT THE FULLEST STAGE AND WHAT THEY DID OUT OF SAMPLE');
    L.push('    ' + 'train'.padEnd(9) + 'test'.padEnd(9) + 'n_tr'.padStart(5) + 'n_te'.padStart(6) + '  config');
    const lastStage = s.stages[s.stages.length - 1];
    const sorted = lastStage.results.slice().sort((a, b) => (b.train.hitRate - a.train.hitRate) || (b.train.n - a.train.n)).slice(0, 6);
    for (const r of sorted) {
      L.push('    ' + pct(r.train.hitRate).padEnd(9) + pct(r.test.hitRate).padEnd(9)
        + String(r.train.n).padStart(5) + String(r.test.n).padStart(6) + '  ' + JSON.stringify(r.point) + ' take ' + r.takeShare);
    }
  }

  L.push('');
  L.push(line);
  L.push('HOW TO READ THIS');
  L.push('  The request was: tune until train reaches ~80%, then expect ~75-78% on a');
  L.push('  different set. That is the right procedure and it is what the stages above');
  L.push('  run. Three things decide whether the numbers can land there, and all three');
  L.push('  are properties of the DATA, not of the grid:');
  L.push('    1. Is there a held-out set at all? Here: one session, so the held-out set is');
  L.push('       made of a different set of names or hours inside one afternoon.');
  L.push('    2. Are the labels a sample of the board, or one bucket of it? Here: all 400');
  L.push('       resolved episodes are the old engine\'s own `aligned` picks.');
  L.push('    3. Does the best-train beat the SHUFFLED-LABEL null? If it does not, then');
  L.push('       re-running the sweep until train reaches 80% would be selecting noise, and');
  L.push('       the test number would not follow it upward. Spec 21.5 forbids exactly that.');
  L.push('');
  L.push('  The honest fix is not a wider grid and not another feature family. It is');
  L.push('  LABELED data: 10,108 of the 10,508 ledger rows have no resolved outcome and');
  L.push('  no held-out value at all, and every one of them is a name some filter rejected.');
  L.push('  Recording outcomes for the candidates the gates BLOCK and the status caps at');
  L.push('  WATCH (spec Section 23) is what turns 400 biased rows into a set that can be');
  L.push('  split, tuned and checked. Feature families are recorded now too (candle context');
  L.push('  included), so the next session loses no evidence the way this one did.');
  L.push(line);
  return L.join('\n');
}

module.exports = {
  run, report, SPLITS, GATE_KNOBS, MOM_KNOBS, KNOBS, TAKE_SHARES,
  makeProbeScorer, metric, wilson, bestOnTrain, momNormOf, expand, buildMatrix,
  MIN_TRAIN_TAKEN, REALLY_SMALL_N, PLAIN_FEATURES, NODIR_FEATURES, fnv, istHour,
};

if (require.main === module) {
  const arg = (n) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.split('=')[1] : null; };
  const res = run({ split: arg('split'), nulls: arg('nulls') != null ? Number(arg('nulls')) : undefined });
  console.log(report(res));
  const out = path.join(__dirname, '..', 'data', 'v2_sessions', 'tune_' + new Date().toISOString().slice(0, 10) + '.json');
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(res, null, 2));
    console.log('\nwritten: ' + out);
  } catch (e) { console.log('\n(report not written: ' + e.message + ')'); }
}
