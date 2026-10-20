/**
 * common/institutional/institutesEngine.js
 * Core Calculation & Pipeline Engine for Institutes & Institutes Symbol Tracker
 *
 * Implements:
 * 1. Derived Position Statuses: NEW, INCREASED, DECREASED, EXIT, HOLD
 * 2. Stock Weightage Score (0-100): NetFlow, Breadth, VelocityMultiplier, Percentile Normalization
 * 3. Institute Growth Score (0-100): AUM Growth, Deployment Ratio, New Position Count, Exit Ratio
 * 4. Scheme Growth Score (0-100): Scheme-level portfolio growth & deployment aggressiveness
 * 5. Percentile Rank Helper for Full Universe Normalization
 */

/**
 * Calculates percentile rank of each value in an array (0 to 100)
 * @param {Array<number>} values 
 * @returns {Array<number>}
 */
function calculatePercentiles(values) {
  const len = values.length;
  if (len === 0) return [];
  if (len === 1) return [50];

  // Pair values with original indices
  const indexed = values.map((val, idx) => ({ val, idx }));
  indexed.sort((a, b) => a.val - b.val);

  // ---- TIED VALUES SHARE A PERCENTILE (midrank) ----
  // Ranking strictly by sort position gave two identical inputs 0 and 100 — a 100-point spread
  // invented out of nothing, and the single largest distortion this composite can produce.
  // Measured on live data 2026-09-28: in institute_growth_score, THREE of the four component columns
  // (aum_growth_pct, deployment_ratio, exit_ratio) hold one constant value across all 24 rows, so the
  // old code assigned those identical inputs an arbitrary 0..100 by array position — which, at a
  // combined weight of 0.65, injected up to 65 points of pure row-order noise into a ranking whose only
  // real signal is new_position_count. Equal inputs must now produce equal percentiles, which leaves
  // the ranking driven by the metric that actually varies.
  const percentiles = new Array(len);
  for (let rank = 0; rank < len; rank++) {
    let end = rank;
    while (end + 1 < len && indexed[end + 1].val === indexed[rank].val) end++;
    const midRank = (rank + end) / 2;                       // mean of the tied positions
    const pct = Number(((midRank / (len - 1)) * 100).toFixed(2));
    for (let k = rank; k <= end; k++) percentiles[indexed[k].idx] = pct;
    rank = end;
  }
  return percentiles;
}

/**
 * Resolves Derived Position Status comparing current vs previous month quantities
 */
function resolvePositionStatus(prevQty, currQty) {
  const p = Number(prevQty || 0);
  const c = Number(currQty || 0);

  if (p === 0 && c > 0) return 'NEW';
  if (p > 0 && c > p) return 'INCREASED';
  if (p > 0 && c > 0 && c < p) return 'DECREASED';
  if (p > 0 && c === 0) return 'EXIT';
  return 'HOLD';
}

/**
 * Derives the two flow fields the velocity multiplier needs from a month-by-month net-flow series.
 *
 * Definitions, stated because the composite previously had none and could not be fed at all:
 *   netFlowTotalCr  = SUM(|monthly flow|) — the GROSS flow over the window, so `latest / total` is a
 *                     concentration share in [-1, 1] rather than a ratio that explodes when a quiet
 *                     month sits next to a loud one.
 *   netFlowLatestCr = the most recent month's net flow.
 * A window needs at least two months to say anything about shape; one month returns nulls, which
 * leaves the multiplier neutral (1.0) instead of silently inventing a boost.
 *
 * @param {Array<number>} monthlyFlows net flow per month, OLDEST FIRST, in ₹ crore
 * @param {number} [netFlowCrFallback] the caller's own net-flow figure, used only for the gate
 */
function deriveFlowVelocity(monthlyFlows, netFlowCrFallback = null) {
  // A MISSING month is not a ZERO month. `Number(null)` and `Number('')` are both 0, so coercing first
  // would insert a fabricated zero-flow month into the series, understating gross flow and inventing a
  // flat spell that never happened. Absent entries are dropped; a real 0 the caller passes is kept.
  const series = (Array.isArray(monthlyFlows) ? monthlyFlows : [])
    .filter(v => v != null && v !== '')
    .map(Number).filter(v => Number.isFinite(v));
  if (series.length < 2) {
    return { netFlowCr: netFlowCrFallback, netFlowTotalCr: null, netFlowLatestCr: null, months: series.length };
  }
  const net = series.reduce((s, v) => s + v, 0);
  const gross = series.reduce((s, v) => s + Math.abs(v), 0);
  return {
    netFlowCr: netFlowCrFallback != null ? netFlowCrFallback : net,
    netFlowTotalCr: gross,
    netFlowLatestCr: series[series.length - 1],
    months: series.length,
  };
}

/**
 * Calculates Stock Weightage Score (0–100 Scale)
 *
 * Step 1: NetFlow = NewEntryFlow + AccumFlow - ExitFlow - ReduceFlow
 * Step 2: BreadthScore = (schemes_end - schemes_start) / schemes_start
 * Step 3: VelocityMultiplier = 1.0 + max(0, (NetFlow_latest / NetFlow_total - 0.33) * 0.5)
 * Step 4: Percentile Normalization
 * Step 5: Final Score = clip((NetFlowScore * 0.55 + BreadthScoreNorm * 0.25 + NewEntryScore * 0.20) * VelocityMultiplier, 0, 100)
 */
function computeStockWeightageScores(stockFlowData) {
  if (!stockFlowData || stockFlowData.length === 0) return [];

  // Extract raw arrays for percentile ranking
  const rawNetFlows = stockFlowData.map(s => s.netFlowCr);
  const rawBreadths = stockFlowData.map(s => s.breadthScore);
  const rawNewEntries = stockFlowData.map(s => s.newEntryFlowCr);

  const netFlowScores = calculatePercentiles(rawNetFlows);
  const breadthScoresNorm = calculatePercentiles(rawBreadths);
  const newEntryScores = calculatePercentiles(rawNewEntries);

  return stockFlowData.map((s, i) => {
    const netFlowScore = netFlowScores[i] || 50;
    const breadthScoreNorm = breadthScoresNorm[i] || 50;
    const newEntryScore = newEntryScores[i] || 50;

    // Velocity Multiplier calculation
    //
    // AUDIT NOTE (2026-09-28): this gate could never pass as the code stood. It requires
    // `netFlowTotalCr` and divides by it, but nothing in this codebase produced `netFlowTotalCr` or
    // `netFlowLatestCr` — a repo-wide search found them only on these two lines — so the condition was
    // always false, the multiplier was always 1.0, and the documented VelocityMultiplier feature was
    // inert. Callers may now either supply the pair directly, or supply `monthlyFlows` and have the
    // pair derived by deriveFlowVelocity() below. The three fields are NOT interchangeable:
    // `netFlowCr` is the GATE (is this name accumulating at all?), the ratio is the SHAPE of that flow.
    const flow = (s.netFlowTotalCr != null && s.netFlowLatestCr != null)
      ? { netFlowCr: s.netFlowCr, netFlowTotalCr: s.netFlowTotalCr, netFlowLatestCr: s.netFlowLatestCr }
      : deriveFlowVelocity(s.monthlyFlows, s.netFlowCr);

    let velocityMultiplier = 1.0;
    if (flow.netFlowCr > 0 && flow.netFlowTotalCr > 0) {
      const velocityRatio = flow.netFlowLatestCr / flow.netFlowTotalCr;
      velocityMultiplier = Math.max(1.0, 1.0 + (velocityRatio - 0.33) * 0.5);
    }
    velocityMultiplier = Number(velocityMultiplier.toFixed(2));

    const rawComposite = (netFlowScore * 0.55 + breadthScoreNorm * 0.25 + newEntryScore * 0.20) * velocityMultiplier;
    const finalScore = Number(Math.min(100, Math.max(0, rawComposite)).toFixed(1));

    return {
      isin: s.isin,
      symbol: s.symbol,
      weightageScore: finalScore,
      netFlowCr: Number(s.netFlowCr.toFixed(2)),
      breadthScoreNorm: Number(breadthScoreNorm.toFixed(1)),
      pctIncreaseHolding: Number(s.pctIncreaseHolding.toFixed(2)),
      velocityMultiplier,
      netBuyers: s.netBuyers || 0,
      netSellers: s.netSellers || 0
    };
  });
}

/**
 * THE GROWTH-SCORE COMPOSITE, IN ONE PLACE (both public scorers below call it).
 *
 * GrowthScore = Pct(AUMGrowth)*0.40 + Pct(Deployment)*0.35 + Pct(NewPositions)*0.15 - Pct(ExitRatio)*0.10
 *
 * The weights sum to 0.90, not 1.00, because the exit term is a PENALTY rather than a fourth positive
 * weight. The raw composite therefore lives on [-10, +90], and clipping that to [0, 100] left the
 * documented ceiling unreachable: the best institute that CAN exist — 100th percentile on AUM growth,
 * deployment and new positions, 0th on exits — scored exactly 90, and every score on the page was
 * squeezed into [0, 90]. An "85/100 institute" was really a 94, which understates conviction and makes
 * cross-institute comparison misleading.
 *
 * FIX: add the penalty's own magnitude back. That maps the attainable range [-10, +90] onto [0, 100]
 * EXACTLY, needs no clipping, and keeps the percentile reading intact — an institute at the median on
 * all four metrics scores 50, where the old form gave it 40 and the old ceiling gave nobody 100.
 */
const GROWTH_WEIGHTS = { aum: 0.40, deployment: 0.35, newPositions: 0.15, exitPenalty: 0.10 };
const GROWTH_OFFSET = GROWTH_WEIGHTS.exitPenalty * 100;   // 10 percentile points: the penalty's magnitude

/**
 * Percentile vectors plus the final [0,100] score for each row. Shared by the institute and scheme
 * scorers so the two can never drift apart again (they were copy-pasted with identical formulas).
 * @param {Array<object>} rows each with aumGrowthPct, deploymentRatio, newPositionCount, exitRatio
 */
function computeGrowthScores(rows) {
  if (!rows || rows.length === 0) return { scores: [], pctAum: [], pctDep: [], pctNew: [], pctExit: [] };

  const pctAum = calculatePercentiles(rows.map(d => d.aumGrowthPct));
  const pctDep = calculatePercentiles(rows.map(d => d.deploymentRatio));
  const pctNew = calculatePercentiles(rows.map(d => d.newPositionCount));
  const pctExit = calculatePercentiles(rows.map(d => d.exitRatio));

  const scores = rows.map((d, i) => {
    const raw = (pctAum[i] * GROWTH_WEIGHTS.aum) + (pctDep[i] * GROWTH_WEIGHTS.deployment)
      + (pctNew[i] * GROWTH_WEIGHTS.newPositions) - (pctExit[i] * GROWTH_WEIGHTS.exitPenalty);
    return Number(Math.min(100, Math.max(0, raw + GROWTH_OFFSET)).toFixed(1));
  });

  return { scores, pctAum, pctDep, pctNew, pctExit };
}

/**
 * Calculates Institute Growth Score (0–100 Scale for 24 AMCs)
 */
function computeInstituteGrowthScores(instituteData) {
  if (!instituteData || instituteData.length === 0) return [];

  const { scores } = computeGrowthScores(instituteData);

  return instituteData.map((d, i) => {
    return {
      instituteId: d.instituteId,
      name: d.name,
      growthScore: scores[i],
      aumGrowthPct: Number(d.aumGrowthPct.toFixed(2)),
      deploymentRatio: Number(d.deploymentRatio.toFixed(3)),
      newPositionCount: d.newPositionCount,
      exitRatio: Number(d.exitRatio.toFixed(3))
    };
  });
}

/**
 * Calculates Scheme Growth Score (0–100 Scale for ~2,000 Schemes)
 * Same composite as the institute scorer, via computeGrowthScores — see the note above for why the
 * penalty offset is added.
 */
function computeSchemeGrowthScores(schemeData) {
  if (!schemeData || schemeData.length === 0) return [];

  const { scores } = computeGrowthScores(schemeData);

  return schemeData.map((d, i) => {
    return {
      schemeId: d.schemeId,
      instituteId: d.instituteId,
      schemeName: d.schemeName,
      instituteName: d.instituteName,
      growthScore: scores[i],
      aumGrowthPct: Number(d.aumGrowthPct.toFixed(2)),
      deploymentRatio: Number(d.deploymentRatio.toFixed(3)),
      newPositionCount: d.newPositionCount,
      exitRatio: Number(d.exitRatio.toFixed(3))
    };
  });
}

module.exports = {
  calculatePercentiles,
  resolvePositionStatus,
  computeStockWeightageScores,
  computeGrowthScores,
  deriveFlowVelocity,
  GROWTH_WEIGHTS,
  GROWTH_OFFSET,
  computeInstituteGrowthScores,
  computeSchemeGrowthScores
};
