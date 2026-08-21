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

  const percentiles = new Array(len);
  for (let rank = 0; rank < len; rank++) {
    const originalIdx = indexed[rank].idx;
    // Standard percentile formula: (rank / (N - 1)) * 100
    const pct = Number(((rank / (len - 1)) * 100).toFixed(2));
    percentiles[originalIdx] = pct;
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
    let velocityMultiplier = 1.0;
    if (s.netFlowCr > 0 && s.netFlowTotalCr > 0) {
      const velocityRatio = s.netFlowLatestCr / s.netFlowTotalCr;
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
 * Calculates Institute Growth Score (0–100 Scale for 24 AMCs)
 *
 * GrowthScore = Percentile(AUMGrowth%) * 0.40 + Percentile(DeploymentRatio) * 0.35 + Percentile(NewPositions) * 0.15 - Percentile(ExitRatio) * 0.10
 */
function computeInstituteGrowthScores(instituteData) {
  if (!instituteData || instituteData.length === 0) return [];

  const rawAumGrowth = instituteData.map(d => d.aumGrowthPct);
  const rawDeployment = instituteData.map(d => d.deploymentRatio);
  const rawNewPositions = instituteData.map(d => d.newPositionCount);
  const rawExits = instituteData.map(d => d.exitRatio);

  const pctAum = calculatePercentiles(rawAumGrowth);
  const pctDep = calculatePercentiles(rawDeployment);
  const pctNew = calculatePercentiles(rawNewPositions);
  const pctExit = calculatePercentiles(rawExits);

  return instituteData.map((d, i) => {
    const score = (pctAum[i] * 0.40) + (pctDep[i] * 0.35) + (pctNew[i] * 0.15) - (pctExit[i] * 0.10);
    const finalScore = Number(Math.min(100, Math.max(0, score)).toFixed(1));

    return {
      instituteId: d.instituteId,
      name: d.name,
      growthScore: finalScore,
      aumGrowthPct: Number(d.aumGrowthPct.toFixed(2)),
      deploymentRatio: Number(d.deploymentRatio.toFixed(3)),
      newPositionCount: d.newPositionCount,
      exitRatio: Number(d.exitRatio.toFixed(3))
    };
  });
}

/**
 * Calculates Scheme Growth Score (0–100 Scale for ~2,000 Schemes)
 */
function computeSchemeGrowthScores(schemeData) {
  if (!schemeData || schemeData.length === 0) return [];

  const rawAumGrowth = schemeData.map(d => d.aumGrowthPct);
  const rawDeployment = schemeData.map(d => d.deploymentRatio);
  const rawNewPositions = schemeData.map(d => d.newPositionCount);
  const rawExits = schemeData.map(d => d.exitRatio);

  const pctAum = calculatePercentiles(rawAumGrowth);
  const pctDep = calculatePercentiles(rawDeployment);
  const pctNew = calculatePercentiles(rawNewPositions);
  const pctExit = calculatePercentiles(rawExits);

  return schemeData.map((d, i) => {
    const score = (pctAum[i] * 0.40) + (pctDep[i] * 0.35) + (pctNew[i] * 0.15) - (pctExit[i] * 0.10);
    const finalScore = Number(Math.min(100, Math.max(0, score)).toFixed(1));

    return {
      schemeId: d.schemeId,
      instituteId: d.instituteId,
      schemeName: d.schemeName,
      instituteName: d.instituteName,
      growthScore: finalScore,
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
  computeInstituteGrowthScores,
  computeSchemeGrowthScores
};
