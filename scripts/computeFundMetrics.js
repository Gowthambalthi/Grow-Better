/**
 * Compute Alpha/Beta/Sharpe/Sortino/Treynor/StdDev for all schemes
 * Uses NAV history + benchmark returns
 * Runs as: node scripts/computeFundMetrics.js
 */
const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const RISK_FREE_RATE = 6.5; // annualized % — 91-day T-bill approx

// Category -> Benchmark mapping
const BENCHMARK_MAP = {
  large: 'NIFTY 50',
  mid: 'NIFTY Midcap 150',
  small: 'NIFTY Smallcap 250',
  index: 'NIFTY 500',
  tax: 'NIFTY 500',
  money: 'NIFTY Money Market Index',
  other: 'NIFTY 500'
};

function mapCategory(cat) {
  cat = (cat || '').toLowerCase();
  if (cat.includes('large')) return 'large';
  if (cat.includes('mid') || cat.includes('flexi') || cat.includes('focused') || cat.includes('multi') || cat.includes('contra') || cat.includes('value')) return 'mid';
  if (cat.includes('small')) return 'small';
  if (cat.includes('index') || cat.includes('etf')) return 'index';
  if (cat.includes('tax') || cat.includes('elss')) return 'tax';
  if (cat.includes('money') || cat.includes('liquid') || cat.includes('overnight')) return 'money';
  return 'other';
}

// Statistical helpers
function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function covariance(a, b) {
  const ma = mean(a), mb = mean(b);
  return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length - 1);
}

function variance(arr) {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
}

// Compute daily returns from NAV series (sorted ascending by date)
function dailyReturns(navs) {
  const returns = [];
  for (let i = 1; i < navs.length; i++) {
    if (navs[i - 1] > 0) {
      returns.push((navs[i] - navs[i - 1]) / navs[i - 1]);
    }
  }
  return returns;
}

// Compute metrics for a rolling window
function computeMetrics(fundReturns, benchmarkReturns, riskFreeDaily) {
  const n = Math.min(fundReturns.length, benchmarkReturns.length);
  if (n < 30) return null; // need at least 30 days

  const fr = fundReturns.slice(-n);
  const br = benchmarkReturns.slice(-n);

  const beta = covariance(fr, br) / (variance(br) || 1e-10);
  const fundMean = mean(fr) * 252; // annualized
  const benchMean = mean(br) * 252;
  const alpha = fundMean - (riskFreeDaily * 252 + beta * (benchMean - riskFreeDaily * 252));
  const sd = stddev(fr) * Math.sqrt(252);
  const sharpe = sd > 0 ? (fundMean - riskFreeDaily * 252) / sd : 0;

  // Sortino: downside deviation
  const downsideReturns = fr.filter(r => r < riskFreeDaily);
  const downsideDev = downsideReturns.length > 1
    ? Math.sqrt(downsideReturns.reduce((s, r) => s + (r - riskFreeDaily) ** 2, 0) / downsideReturns.length) * Math.sqrt(252)
    : sd;
  const sortino = downsideDev > 0 ? (fundMean - riskFreeDaily * 252) / downsideDev : 0;

  // Treynor
  const treynor = beta !== 0 ? (fundMean - riskFreeDaily * 252) / beta : 0;

  return {
    alpha: Math.round(alpha * 100) / 100,
    beta: Math.round(beta * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100,
    sortino: Math.round(sortino * 100) / 100,
    treynor: Math.round(treynor * 100) / 100,
    stdDev: Math.round(sd * 100) / 100
  };
}

async function compute() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Create fund_metrics table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS fund_metrics (
      schemeId TEXT PRIMARY KEY,
      alpha_1y REAL, beta_1y REAL, sharpe_1y REAL, sortino_1y REAL, treynor_1y REAL, stdDev_1y REAL,
      alpha_3y REAL, beta_3y REAL, sharpe_3y REAL, sortino_3y REAL, treynor_3y REAL, stdDev_3y REAL,
      computedAt TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id)
    )
  `);

  // Load all schemes with categories
  const schemes = db.prepare('SELECT id, category FROM mutual_fund_schemes').all();
  console.log(`[Metrics] Processing ${schemes.length} schemes`);

  // Load ALL benchmark returns into memory (NIFTY 50 as primary proxy)
  // For simplicity, use NIFTY 50 returns as benchmark for all categories
  // A more accurate approach would load category-specific benchmarks
  const benchNavRows = db.prepare(
    "SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId IN (SELECT id FROM mutual_fund_schemes WHERE schemeName LIKE '%Nifty 50 Index%' OR schemeName LIKE '%NIFTY 50%' LIMIT 1) ORDER BY navDate"
  ).all();

  let benchReturns = [];
  if (benchNavRows.length > 100) {
    const benchNavs = benchNavRows.map(r => r.nav);
    benchReturns = dailyReturns(benchNavs);
    console.log(`[Metrics] Loaded ${benchReturns.length} benchmark return days from Nifty 50`);
  } else {
    // Generate synthetic benchmark returns (market-like random walk)
    console.log('[Metrics] No benchmark data found, using synthetic benchmark');
    const seed = 42;
    let val = 100;
    for (let i = 0; i < 2500; i++) {
      val *= (1 + (Math.sin(seed + i * 0.01) * 0.001 + 0.0003));
      benchReturns.push((Math.sin(seed + i * 0.01) * 0.001 + 0.0003));
    }
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO fund_metrics 
    (schemeId, alpha_1y, beta_1y, sharpe_1y, sortino_1y, treynor_1y, stdDev_1y,
     alpha_3y, beta_3y, sharpe_3y, sortino_3y, treynor_3y, stdDev_3y, computedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let computed = 0, skipped = 0;

  for (const scheme of schemes) {
    const navRows = db.prepare(
      "SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId = ? ORDER BY navDate"
    ).all(scheme.id);

    if (navRows.length < 60) { skipped++; continue; }

    const navs = navRows.map(r => r.nav);
    const fundReturns = dailyReturns(navs);

    // 1Y = ~252 trading days
    const returns1y = fundReturns.slice(-252);
    const bench1y = benchReturns.slice(-252);
    const metrics1y = computeMetrics(returns1y, bench1y, RISK_FREE_RATE / 100 / 252);

    // 3Y = ~756 trading days
    const returns3y = fundReturns.slice(-756);
    const bench3y = benchReturns.slice(-756);
    const metrics3y = computeMetrics(returns3y, bench3y, RISK_FREE_RATE / 100 / 252);

    if (metrics1y || metrics3y) {
      insert.run(
        scheme.id,
        metrics1y ? metrics1y.alpha : null,
        metrics1y ? metrics1y.beta : null,
        metrics1y ? metrics1y.sharpe : null,
        metrics1y ? metrics1y.sortino : null,
        metrics1y ? metrics1y.treynor : null,
        metrics1y ? metrics1y.stdDev : null,
        metrics3y ? metrics3y.alpha : null,
        metrics3y ? metrics3y.beta : null,
        metrics3y ? metrics3y.sharpe : null,
        metrics3y ? metrics3y.sortino : null,
        metrics3y ? metrics3y.treynor : null,
        metrics3y ? metrics3y.stdDev : null
      );
      computed++;
    } else {
      skipped++;
    }

    if (computed % 100 === 0 && computed > 0) {
      process.stdout.write(`\r  Progress: ${computed + skipped}/${schemes.length} | Computed: ${computed} | Skipped: ${skipped}`);
    }
  }

  console.log(`\n[Metrics] Done: ${computed} computed, ${skipped} skipped`);
  db.close();
}

compute().catch(e => { console.error('Fatal:', e); process.exit(1); });
