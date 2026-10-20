'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../common/institutional/institutesEngine');
const C = require('../common/institutional/compositeEngine');

// ---------------------------------------------------------------------------
// calculatePercentiles — the base of every composite below, so it is tested first.
// ---------------------------------------------------------------------------

test('percentiles: sorted input maps linearly onto 0..100', () => {
  assert.deepEqual(E.calculatePercentiles([10, 20, 30, 40, 50]), [0, 25, 50, 75, 100]);
});

test('percentiles: the rank is assigned back to the ORIGINAL index, not the sorted one', () => {
  // 10 is lowest, 30 the middle, 50 the highest — whatever order they arrive in.
  assert.deepEqual(E.calculatePercentiles([30, 10, 50]), [50, 0, 100]);
});

test('percentiles: degenerate inputs do not produce NaN', () => {
  assert.deepEqual(E.calculatePercentiles([]), []);
  // One value has no distribution to rank against; 50 (the median of a single point) is the only
  // defensible answer, and it is what the growth composite's offset is designed to keep meaningful.
  assert.deepEqual(E.calculatePercentiles([7]), [50]);
});

test('percentiles: TIED values share a percentile (midrank)', () => {
  // Ranking strictly by sort position gave two identical inputs 0 and 100 — a 100-point spread out of
  // nothing. This is not hypothetical: in the live institute table THREE of the four component columns
  // are constant across all 24 rows, so the old split injected up to 65 points of row-order noise into
  // a ranking that has only one genuinely varying metric.
  assert.deepEqual(E.calculatePercentiles([5, 5]), [50, 50]);
  assert.deepEqual(E.calculatePercentiles([5, 5, 5]), [50, 50, 50]);
  // A tie in the middle stays a tie; the values around it keep their own ranks.
  assert.deepEqual(E.calculatePercentiles([1, 5, 5, 9]), [0, 50, 50, 100]);
});

test('percentiles: an all-equal column carries no information at all', () => {
  // The old code turned this into a full 0..100 spread, i.e. it invented a ranking from row order.
  const flat = E.calculatePercentiles([7, 7, 7, 7, 7, 7]);
  assert.ok(flat.every(v => v === flat[0]), 'identical inputs must not produce different percentiles');
});

// ---------------------------------------------------------------------------
// The growth composite. This is the fix for the 0-90 ceiling.
// ---------------------------------------------------------------------------

/** Best on the three positive metrics and lowest on exits; the reverse for the last row. */
const GROWTH_ROWS = [
  { id: 'best', aumGrowthPct: 10, deploymentRatio: 0.90, newPositionCount: 30, exitRatio: 0.01 },
  { id: 'up', aumGrowthPct: 8, deploymentRatio: 0.80, newPositionCount: 24, exitRatio: 0.02 },
  { id: 'mid', aumGrowthPct: 6, deploymentRatio: 0.70, newPositionCount: 18, exitRatio: 0.03 },
  { id: 'down', aumGrowthPct: 4, deploymentRatio: 0.60, newPositionCount: 12, exitRatio: 0.04 },
  { id: 'worst', aumGrowthPct: 2, deploymentRatio: 0.50, newPositionCount: 6, exitRatio: 0.05 },
];

test('growth: the documented ceiling of 100 is actually REACHABLE', () => {
  const { scores } = E.computeGrowthScores(GROWTH_ROWS);
  // 100th percentile on all three positive metrics and 0th on exits: the best institute that can exist.
  // Before the offset this returned 90, because the weights sum to 0.90 and the clip hid it.
  assert.equal(scores[0], 100, 'the best possible row must score 100');
});

test('growth: the floor is 0 and the attainable range is the full 0..100', () => {
  const { scores } = E.computeGrowthScores(GROWTH_ROWS);
  assert.equal(scores[scores.length - 1], 0, 'the worst possible row must score 0');
  assert.equal(Math.min(...scores), 0);
  assert.equal(Math.max(...scores), 100);
});

test('growth: a median performer reads 50, not 40', () => {
  const { scores } = E.computeGrowthScores(GROWTH_ROWS);
  // 50th percentile on all four metrics -> 0.40*50 + 0.35*50 + 0.15*50 - 0.10*50 = 40, which the
  // offset lifts back to 50. This is what makes a growth score readable as a percentile.
  assert.equal(scores[2], 50);
});

test('growth: the offset equals the exit penalty, and the weights sum to 0.90', () => {
  const w = E.GROWTH_WEIGHTS;
  assert.equal(w.aum + w.deployment + w.newPositions, 0.9);
  assert.equal(E.GROWTH_OFFSET, w.exitPenalty * 100);
});

test('growth: the institute and scheme scorers can no longer drift apart', () => {
  const inst = E.computeInstituteGrowthScores(GROWTH_ROWS.map(r => ({ ...r, instituteId: r.id, name: r.id })));
  const scheme = E.computeSchemeGrowthScores(GROWTH_ROWS.map(r => ({ ...r, schemeId: r.id, schemeName: r.id })));
  assert.deepEqual(inst.map(r => r.growthScore), scheme.map(r => r.growthScore));
  assert.deepEqual(inst.map(r => r.growthScore), E.computeGrowthScores(GROWTH_ROWS).scores);
});

test('growth: empty and missing input return empty rather than throwing', () => {
  assert.deepEqual(E.computeInstituteGrowthScores([]), []);
  assert.deepEqual(E.computeInstituteGrowthScores(null), []);
  assert.deepEqual(E.computeSchemeGrowthScores(undefined), []);
  assert.deepEqual(E.computeGrowthScores([]).scores, []);
});

test('growth: higher on every metric can never score lower', () => {
  const { scores } = E.computeGrowthScores(GROWTH_ROWS);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1] >= scores[i], `row ${i - 1} (${scores[i - 1]}) should not rank below row ${i} (${scores[i]})`);
  }
});

// ---------------------------------------------------------------------------
// compositeEngine — the conviction score and the AMFI bucket.
// ---------------------------------------------------------------------------

test('conviction: both signals missing is null (unranked), not zero', () => {
  assert.equal(C.calculateCompositeScore({}), null);
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: null, deliveryZScore: null }), null);
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: NaN, deliveryZScore: 'x' }), null);
});

test('conviction: each component is normalised by 3 and clipped to +/-1', () => {
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: 3, deliveryZScore: 3 }), 1);
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: -3, deliveryZScore: -3 }), -1);
  // 30 is 10x the normalisation scale and must clip, not propagate.
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: 30, deliveryZScore: 3 }), 1);
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: -30, deliveryZScore: -30 }), -1);
});

test('conviction: the default weights are 0.6 bulk / 0.4 delivery', () => {
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: 3, deliveryZScore: -3 }), 0.2);
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: -3, deliveryZScore: 3 }), -0.2);
});

test('conviction: a missing component falls back to 100% weight on the other (documented)', () => {
  // Deliberate: a stock with only bulk data can score as strongly as one with both signals. Pinned
  // here so the behaviour is a decision on record rather than an accident.
  assert.equal(C.calculateCompositeScore({ bulkNetPctAdtv: 3 }), 1);
  assert.equal(C.calculateCompositeScore({ deliveryZScore: 3 }), 1);
});

test('amfi bucket: the four (1M, 3M) quadrants', () => {
  assert.equal(C.assignAmfiBucket(1, 1), 'strong');
  assert.equal(C.assignAmfiBucket(1, -1), 'fresh');
  assert.equal(C.assignAmfiBucket(-1, 1), 'warning');
  assert.equal(C.assignAmfiBucket(-1, -1), 'exit');
  // Zero is not an increase: a flat month must not read as accumulation.
  assert.equal(C.assignAmfiBucket(0, 0), 'exit');
  assert.equal(C.assignAmfiBucket(0, 1), 'warning');
});

test('amfi bucket: missing values are treated as zero rather than throwing', () => {
  assert.equal(C.assignAmfiBucket(undefined, undefined), 'exit');
  assert.equal(C.assignAmfiBucket('1.5', 1), 'strong');
});

// ---------------------------------------------------------------------------
// The velocity multiplier: previously unreachable (its two inputs had no producer anywhere in the
// repo, so the gate was always false and the multiplier always 1.0). It is now derivable from a
// monthly flow series.
// ---------------------------------------------------------------------------

test('flow velocity: needs at least two months to say anything about shape', () => {
  const none = E.deriveFlowVelocity([]);
  assert.equal(none.netFlowTotalCr, null);
  assert.equal(none.netFlowLatestCr, null);
  const one = E.deriveFlowVelocity([12]);
  assert.equal(one.netFlowTotalCr, null, 'one month cannot describe a trend');
  assert.equal(one.months, 1);
});

test('flow velocity: total is GROSS flow, so the ratio stays a concentration share', () => {
  const f = E.deriveFlowVelocity([100, -60, 20]);
  assert.equal(f.netFlowTotalCr, 180, 'gross: |100| + |-60| + |20|');
  assert.equal(f.netFlowLatestCr, 20, 'latest is the most recent month');
  assert.equal(f.netFlowCr, 60, 'net is the signed sum, and it gates the multiplier');
  assert.ok(Math.abs(f.netFlowLatestCr / f.netFlowTotalCr) <= 1, 'the ratio cannot exceed 1');
});

test('flow velocity: the caller-supplied net flow gates the ratio when present', () => {
  const f = E.deriveFlowVelocity([10, 20], 5);
  assert.equal(f.netFlowCr, 5, 'the gate uses the caller figure, not a recomputed one');
  assert.equal(f.netFlowTotalCr, 30);
});

test('flow velocity: junk input collapses to neutral rather than a fake boost', () => {
  const f = E.deriveFlowVelocity([1, null, 'x', NaN, 3]);
  assert.equal(f.months, 2, 'non-numeric entries are dropped, not coerced to 0');
  assert.equal(E.deriveFlowVelocity('nope').netFlowTotalCr, null);
});

test('velocity multiplier: a concentrated recent burst actually moves the score now', () => {
  const base = {
    isin: 'INE000A01001', symbol: 'AAA', breadthScore: 0, newEntryFlowCr: 0, pctIncreaseHolding: 0,
    netBuyers: 1, netSellers: 1,
  };
  // Two names with IDENTICAL scoring inputs; only the flow SHAPE differs. Back-loaded flow (most of the
  // window's activity in the latest month) must out-score front-loaded flow, and both must beat the
  // name with no flow history at all, whose multiplier stays neutral.
  const backLoaded = { ...base, netFlowCr: 60, monthlyFlows: [10, 10, 60] };
  const frontLoaded = { ...base, netFlowCr: 60, monthlyFlows: [60, 10, 10] };
  const noHistory = { ...base, netFlowCr: 60 };
  const out = E.computeStockWeightageScores([backLoaded, frontLoaded, noHistory]);
  const [b, f, n] = out;
  assert.ok(b.velocityMultiplier > 1.0, 'a back-loaded burst should boost');
  assert.equal(f.velocityMultiplier, 1.0, 'front-loaded flow has no recent acceleration to reward');
  assert.equal(n.velocityMultiplier, 1.0, 'no history stays neutral');
  assert.ok(b.weightageScore > f.weightageScore, 'the boost must reach the score');
});

test('velocity multiplier: a net-SELLING name gets no boost even if the latest month is its biggest', () => {
  const name = {
    isin: 'INE000A01002', symbol: 'BBB', breadthScore: 0, newEntryFlowCr: 0, pctIncreaseHolding: 0,
    netBuyers: 0, netSellers: 1, netFlowCr: -5, monthlyFlows: [-5, -4, -5],
  };
  const [row] = E.computeStockWeightageScores([name]);
  assert.equal(row.velocityMultiplier, 1.0);
});
