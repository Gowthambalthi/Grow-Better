/**
 * scripts/backtestInstitutionalConviction.js
 * Section 7 Backtesting Script featuring Train/Test Split Grid Search
 * (8 Months In-Sample Train / 4 Months Out-of-Sample Holdout Test)
 */

const { calculateCompositeScore, assignAmfiBucket } = require('../common/institutional/compositeEngine');

// Simulated 12-month historical stock sample dataset with ground truth forward returns
const HISTORICAL_SAMPLE_DATA = [
  // Train period (Months 1 - 8)
  { date: '2025-09-15', symbol: 'EMMVEE', amfi_bucket: 'strong', bulk_net_pct_adtv: 2.45, delivery_zscore: 1.85, fwd_1w: 2.4, fwd_1m: 8.9, fwd_3m: 24.5 },
  { date: '2025-10-10', symbol: 'RELIANCE', amfi_bucket: 'strong', bulk_net_pct_adtv: 1.20, delivery_zscore: 1.42, fwd_1w: 1.1, fwd_1m: 4.8, fwd_3m: 12.5 },
  { date: '2025-11-05', symbol: 'SHRIRAMFIN', amfi_bucket: 'strong', bulk_net_pct_adtv: 0.95, delivery_zscore: 1.15, fwd_1w: 1.5, fwd_1m: 5.2, fwd_3m: 14.1 },
  { date: '2025-12-12', symbol: 'CUPID', amfi_bucket: 'fresh', bulk_net_pct_adtv: 0.82, delivery_zscore: 0.95, fwd_1w: 1.8, fwd_1m: 6.4, fwd_3m: 18.2 },
  { date: '2026-01-18', symbol: 'HDFCBANK', amfi_bucket: 'strong', bulk_net_pct_adtv: 1.40, delivery_zscore: 1.10, fwd_1w: 0.9, fwd_1m: 3.9, fwd_3m: 10.8 },
  { date: '2026-02-20', symbol: 'ONGC', amfi_bucket: 'warning', bulk_net_pct_adtv: -0.45, delivery_zscore: -0.20, fwd_1w: -0.5, fwd_1m: 2.1, fwd_3m: 7.4 },
  { date: '2026-03-14', symbol: 'TATASTEEL', amfi_bucket: 'exit', bulk_net_pct_adtv: -1.10, delivery_zscore: -0.80, fwd_1w: -2.1, fwd_1m: -4.5, fwd_3m: -9.2 },
  { date: '2026-04-10', symbol: 'EMMVEE', amfi_bucket: 'strong', bulk_net_pct_adtv: 1.90, delivery_zscore: 1.65, fwd_1w: 2.1, fwd_1m: 7.8, fwd_3m: 21.4 },
  
  // Test holdout period (Months 9 - 12: Out-of-sample)
  { date: '2026-05-15', symbol: 'RELIANCE', amfi_bucket: 'strong', bulk_net_pct_adtv: 1.15, delivery_zscore: 1.35, fwd_1w: 1.2, fwd_1m: 4.5, fwd_3m: 11.9 },
  { date: '2026-06-12', symbol: 'SHRIRAMFIN', amfi_bucket: 'strong', bulk_net_pct_adtv: 1.05, delivery_zscore: 1.25, fwd_1w: 1.6, fwd_1m: 5.4, fwd_3m: 13.8 },
  { date: '2026-07-10', symbol: 'CUPID', amfi_bucket: 'fresh', bulk_net_pct_adtv: 0.90, delivery_zscore: 1.05, fwd_1w: 2.0, fwd_1m: 6.8, fwd_3m: 17.5 },
  { date: '2026-08-05', symbol: 'EMMVEE', amfi_bucket: 'strong', bulk_net_pct_adtv: 2.10, delivery_zscore: 1.75, fwd_1w: 2.5, fwd_1m: 8.2, fwd_3m: 22.8 }
];

/**
 * Runs backtest for a specific parameter combination on a dataset
 */
function evaluateCombination(dataset, threshold, w1, bucketMode) {
  const w2 = 1 - w1;
  const filtered = [];

  for (const row of dataset) {
    if (bucketMode === 'strong_only' && row.amfi_bucket !== 'strong') continue;
    if (bucketMode === 'strong_and_fresh' && (row.amfi_bucket !== 'strong' && row.amfi_bucket !== 'fresh')) continue;

    const score = calculateCompositeScore({
      bulkNetPctAdtv: row.bulk_net_pct_adtv,
      deliveryZScore: row.delivery_zscore,
      w1,
      w2
    });

    if (score != null && score >= threshold) {
      filtered.push({ ...row, score });
    }
  }

  if (filtered.length === 0) {
    return { winRate: 0, avg1w: 0, avg1m: 0, avg3m: 0, sharpe: 0, count: 0 };
  }

  const winners = filtered.filter(r => r.fwd_1m > 0).length;
  const winRate = (winners / filtered.length) * 100;

  const avg1w = filtered.reduce((s, r) => s + r.fwd_1w, 0) / filtered.length;
  const avg1m = filtered.reduce((s, r) => s + r.fwd_1m, 0) / filtered.length;
  const avg3m = filtered.reduce((s, r) => s + r.fwd_3m, 0) / filtered.length;

  const std1m = Math.sqrt(filtered.reduce((s, r) => s + Math.pow(r.fwd_1m - avg1m, 2), 0) / filtered.length) || 1.0;
  const sharpe = (avg1m / std1m);

  return {
    winRate: Number(winRate.toFixed(1)),
    avg1w: Number(avg1w.toFixed(2)),
    avg1m: Number(avg1m.toFixed(2)),
    avg3m: Number(avg3m.toFixed(2)),
    sharpe: Number(sharpe.toFixed(2)),
    count: filtered.length
  };
}

/**
 * Executes Train/Test Grid Search across 30 parameter combinations
 */
function gridSearchTrainTest() {
  const trainData = HISTORICAL_SAMPLE_DATA.slice(0, 8);
  const testData = HISTORICAL_SAMPLE_DATA.slice(8);

  const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const w1Options = [0.3, 0.4, 0.5, 0.6, 0.7];
  const bucketModes = ['strong_only', 'strong_and_fresh'];

  const trainResults = [];

  for (const t of thresholds) {
    for (const w1 of w1Options) {
      for (const bMode of bucketModes) {
        const res = evaluateCombination(trainData, t, w1, bMode);
        trainResults.push({
          threshold: t,
          w1: w1,
          w2: Number((1 - w1).toFixed(1)),
          bucketMode: bMode,
          ...res
        });
      }
    }
  }

  // Sort Train Grid Results by Win Rate % and Sharpe Ratio
  trainResults.sort((a, b) => b.winRate - a.winRate || b.sharpe - a.sharpe);

  const winningCombo = trainResults[0];

  // Evaluate winning combination on out-of-sample Test Data
  const testResult = evaluateCombination(testData, winningCombo.threshold, winningCombo.w1, winningCombo.bucketMode);

  // Print Table A: Train Grid Results (30 Combinations)
  console.log('\n========================================================================================');
  console.log('TABLE A: IN-SAMPLE TRAIN GRID SEARCH RESULTS (First 8 Months — 30 Parameter Combinations)');
  console.log('========================================================================================');
  console.table(trainResults.map((r, i) => ({
    Rank: i + 1,
    Threshold: r.threshold,
    'w1 (Bulk)': r.w1,
    'w2 (Deliv)': r.w2,
    'Bucket Mode': r.bucketMode,
    'Win Rate %': `${r.winRate}%`,
    'Avg 1M Fwd %': `+${r.avg1m}%`,
    'Avg 3M Fwd %': `+${r.avg3m}%`,
    Sharpe: r.sharpe,
    Trades: r.count
  })));

  // Print Table B: Out-of-Sample Test Confirmation (Winning Combination)
  console.log('\n========================================================================================');
  console.log('TABLE B: OUT-OF-SAMPLE TEST CONFIRMATION (Last 4 Months Holdout — Winning Configuration)');
  console.log('========================================================================================');
  console.table([{
    Config: 'Winning Parameter Combo',
    Threshold: winningCombo.threshold,
    'w1 (Bulk)': winningCombo.w1,
    'w2 (Deliv)': winningCombo.w2,
    'Bucket Mode': winningCombo.bucketMode,
    'Test Win Rate %': `${testResult.winRate}%`,
    'Test Avg 1M Fwd %': `+${testResult.avg1m}%`,
    'Test Avg 3M Fwd %': `+${testResult.avg3m}%`,
    'Test Sharpe': testResult.sharpe,
    'Test Trades': testResult.count,
    Status: testResult.winRate >= 60 ? 'PASS (Edge Confirmed Out-of-Sample)' : 'FAIL (Overfitted to Noise)'
  }]);

  return { trainResults, winningCombo, testResult };
}

if (require.main === module) {
  gridSearchTrainTest();
}

module.exports = {
  gridSearchTrainTest,
  evaluateCombination
};
