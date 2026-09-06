/**
 * Compute Alpha/Beta/Sharpe/Sortino/Treynor/StdDev + official-benchmark returns for all schemes.
 * Real values computed from DAILY NAV returns vs a real Nifty 50 index-fund benchmark,
 * with strict date alignment (fund & benchmark compared on the SAME calendar days).
 * Benchmark % for each scheme comes from its OFFICIAL benchmark index (TRI), measured via
 * a matching index fund / ETF in the DB (an index fund's NAV tracks the index TRI, so its
 * return over a window IS the benchmark's return).
 * Runs as: node scripts/runMetricsNow.js
 */
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db'));
db.pragma('journal_mode = WAL');

// ─── Schema ──────────────────────────────────────────────────────────────────
db.exec('DROP TABLE IF EXISTS fund_metrics');
db.exec(`CREATE TABLE fund_metrics (
  schemeId TEXT PRIMARY KEY,
  alpha_1m REAL, beta_1m REAL, sharpe_1m REAL, sortino_1m REAL, treynor_1m REAL, stdDev_1m REAL,
  alpha_3m REAL, beta_3m REAL, sharpe_3m REAL, sortino_3m REAL, treynor_3m REAL, stdDev_3m REAL,
  alpha_6m REAL, beta_6m REAL, sharpe_6m REAL, sortino_6m REAL, treynor_6m REAL, stdDev_6m REAL,
  alpha_1y REAL, beta_1y REAL, sharpe_1y REAL, sortino_1y REAL, treynor_1y REAL, stdDev_1y REAL,
  alpha_3y REAL, beta_3y REAL, sharpe_3y REAL, sortino_3y REAL, treynor_3y REAL, stdDev_3y REAL,
  alpha_5y REAL, beta_5y REAL, sharpe_5y REAL, sortino_5y REAL, treynor_5y REAL, stdDev_5y REAL,
  alpha_10y REAL, beta_10y REAL, sharpe_10y REAL, sortino_10y REAL, treynor_10y REAL, stdDev_10y REAL,
  benchmarkName TEXT,
  benchmark_1m REAL, benchmark_3m REAL, benchmark_6m REAL, benchmark_1y REAL,
  computedAt TEXT
)`);

const RF_ANNUAL = 6.5; // 91-day T-bill approx
const RF_DAILY = RF_ANNUAL / 100 / 252;

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const cov = (a, b) => { const ma = mean(a), mb = mean(b); return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length - 1); };
const vr = a => { const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1); };
const r4 = x => Math.round(x * 10000) / 10000;

/** Date-ALIGNED daily returns for the trailing N calendar windows.
 *  Returns { days, fundRet, benchRet } computed over the SAME trading days. */
function alignedReturns(fundNavs, benchNavs, lookbackDays) {
  // Map by date
  const fMap = new Map(fundNavs.map(r => [r.navDate, r.nav]));
  const bMap = new Map(benchNavs.map(r => [r.navDate, r.nav]));
  // Union of dates that BOTH have, ascending
  const dates = [];
  for (const d of fundNavs.map(r => r.navDate)) {
    if (bMap.has(d)) dates.push(d);
  }
  dates.sort();
  if (dates.length < 2) return null;

  // Trailing window by calendar days
  const endDate = dates[dates.length - 1];
  const cutoff = new Date(new Date(endDate).getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const win = dates.filter(d => d >= cutoff);
  if (win.length < 20) return null;

  const fRet = [], bRet = [];
  for (let i = 1; i < win.length; i++) {
    const pv = fMap.get(win[i - 1]), cv = fMap.get(win[i]);
    const pb = bMap.get(win[i - 1]), cb = bMap.get(win[i]);
    if (pv > 0 && pb > 0) {
      fRet.push((cv - pv) / pv);
      bRet.push((cb - pb) / pb);
    }
  }
  if (fRet.length < 15) return null;
  return { days: win.length, fundRet: fRet, benchRet: bRet };
}

function metricsFor(aligned) {
  const f = aligned.fundRet, b = aligned.benchRet;
  const n = Math.min(f.length, b.length);
  const fr = f.slice(-n), br = b.slice(-n);

  const beta = cov(fr, br) / (vr(br) || 1e-10);
  const fM = mean(fr) * 252;                       // annualized (decimal)
  const bM = mean(br) * 252;
  const rfA = RF_DAILY * 252;
  const alpha = fM - (rfA + beta * (bM - rfA));
  const vol = sd(fr) * Math.sqrt(252);
  const sharpe = vol > 0 ? (fM - rfA) / vol : 0;
  const down = fr.filter(r => r < RF_DAILY);
  const dd = down.length > 1 ? Math.sqrt(down.reduce((s, r) => s + (r - RF_DAILY) ** 2, 0) / down.length) * Math.sqrt(252) : vol;
  const sortino = dd > 0 ? (fM - rfA) / dd : 0;
  const treynor = beta !== 0 ? (fM - rfA) / beta : 0;

  return {
    alpha: r4(alpha), beta: r4(beta), sharpe: r4(sharpe),
    sortino: r4(sortino), treynor: r4(treynor), stdDev: r4(vol)
  };
}

// ─── Benchmark: a Nifty 50 index fund with the most NAV data ─────────────────
const benchRow = db.prepare(`
  SELECT schemeId, COUNT(*) AS cnt
  FROM mutual_fund_nav_history
  WHERE schemeId IN (
    SELECT id FROM mutual_fund_schemes
    WHERE schemeName LIKE '%Nifty 50%' OR schemeName LIKE '%NIFTY 50%'
  )
  GROUP BY schemeId ORDER BY cnt DESC LIMIT 1
`).get();

const bench = benchRow && benchRow.cnt > 100
  ? benchRow
  : db.prepare('SELECT schemeId, COUNT(*) AS cnt FROM mutual_fund_nav_history GROUP BY schemeId ORDER BY cnt DESC LIMIT 1').get();

if (!bench) {
  console.log('No NAV data available. Run collectNavHistory.js first.');
  db.close();
  process.exit(0);
}

const benchName = db.prepare('SELECT schemeName FROM mutual_fund_schemes WHERE id = ?').get(bench.schemeId);
console.log('Benchmark scheme:', bench.schemeId, '—', benchName ? benchName.schemeName : '', '(' + bench.cnt + ' days)');

const benchNavs = db.prepare('SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate').all(bench.schemeId);

// ─── Official benchmark detection ────────────────────────────────────────────
// Ordered list: first matching rule wins. Each entry: [searchTokens(lowercase), benchmarkLabel]
const BENCH_RULES = [
  [['nifty 50 equal weight'], 'NIFTY50 Equal Weight TRI'],
  [['nifty 100 equal weight'], 'NIFTY100 Equal Weight TRI'],
  [['nifty 500 momentum 50'], 'NIFTY500 Momentum 50 TRI'],
  [['nifty 500 quality 50'], 'NIFTY500 Quality 50 TRI'],
  [['nifty 500 value 50'], 'NIFTY500 Value 50 TRI'],
  [['nifty 500 equal weight'], 'NIFTY500 Equal Weight TRI'],
  [['nifty 200 momentum 30'], 'NIFTY200 Momentum 30 TRI'],
  [['nifty 200 quality 30'], 'NIFTY200 Quality 30 TRI'],
  [['nifty 200 value 30'], 'NIFTY200 Value 30 TRI'],
  [['nifty 100 quality 30'], 'NIFTY100 Quality 30 TRI'],
  [['nifty 100 low volatility 30'], 'NIFTY100 Low Volatility 30 TRI'],
  [['nifty 50 value 20'], 'NIFTY50 Value 20 TRI'],
  [['nifty midcap 150'], 'NIFTY Midcap 150 TRI'],
  [['nifty midcap 100'], 'NIFTY Midcap 100 TRI'],
  [['nifty midcap 50'], 'NIFTY Midcap 50 TRI'],
  [['nifty smallcap 250'], 'NIFTY Smallcap 250 TRI'],
  [['nifty smallcap 50'], 'NIFTY Smallcap 50 TRI'],
  [['nifty largemidcap 250'], 'NIFTY LargeMidcap 250 TRI'],
  [['nifty next 50'], 'NIFTY Next 50 TRI'],
  [['nifty microcap 250'], 'NIFTY Microcap 250 TRI'],
  [['nifty total market'], 'NIFTY Total Market TRI'],
  [['nifty 200'], 'NIFTY 200 TRI'],
  [['nifty 100'], 'NIFTY 100 TRI'],
  [['nifty 500'], 'NIFTY 500 TRI'],
  [['nifty 50'], 'NIFTY 50 TRI'],
  [['nifty bank'], 'NIFTY Bank TRI'],
  [['nifty it'], 'NIFTY IT TRI'],
  [['nifty auto'], 'NIFTY Auto TRI'],
  [['nifty pharma'], 'NIFTY Pharma TRI'],
  [['nifty realty'], 'NIFTY Realty TRI'],
  [['nifty metal'], 'NIFTY Metal TRI'],
  [['nifty india defence'], 'NIFTY India Defence TRI'],
  [['nifty india manufacturing'], 'NIFTY India Manufacturing TRI'],
  [['nifty private bank'], 'NIFTY Private Bank TRI'],
  [['nifty infrastructure'], 'NIFTY Infrastructure TRI'],
  [['nifty pse'], 'NIFTY PSE TRI'],
  [['nifty commodity'], 'NIFTY Commodities TRI'],
  [['nifty alpha'], 'NIFTY Alpha TRI'],
  [['nifty financial services'], 'NIFTY Financial Services TRI'],
  [['financial services'], 'NIFTY Financial Services TRI'],
  [['nifty healthcare'], 'NIFTY Healthcare TRI'],
  [['healthcare'], 'NIFTY Healthcare TRI'],
  [['nifty india consumption'], 'NIFTY India Consumption TRI'],
  [['nifty consumption'], 'NIFTY India Consumption TRI'],
  [['consumption'], 'NIFTY India Consumption TRI'],
  [['nifty india digital'], 'NIFTY India Digital TRI'],
  [['nifty digital'], 'NIFTY India Digital TRI'],
  [['nifty india tourism'], 'NIFTY India Tourism TRI'],
  [['nifty tourism'], 'NIFTY India Tourism TRI'],
  [['nifty india railways'], 'NIFTY India Railways PSU TRI'],
  [['nifty india internet'], 'NIFTY India Internet TRI'],
  [['nifty internet'], 'NIFTY India Internet TRI'],
  [['nifty capital market'], 'NIFTY Capital Market TRI'],
  [['nifty capital markets'], 'NIFTY Capital Market TRI'],
  [['nifty midsmall healthcare'], 'NIFTY MidSmall Healthcare TRI'],
  [['nifty midsmall india consumption'], 'NIFTY MidSmall India Consumption TRI'],
  [['nifty ev & new age automotive'], 'NIFTY EV & New Age Automotive TRI'],
  [['nifty realty'], 'NIFTY Realty TRI'],
  [['bse healthcare'], 'BSE Healthcare TRI'],
  [['bse housing'], 'BSE Housing TRI'],
  [['bse psu'], 'BSE PSU TRI'],
  [['bse india sector leaders'], 'BSE India Sector Leaders TRI'],
  [['sector leaders'], 'BSE India Sector Leaders TRI'],
  [['bse 500 momentum 50'], 'BSE 500 Momentum 50 TRI'],
  [['bse 500 quality 50'], 'BSE 500 Quality 50 TRI'],
  [['bse 500'], 'BSE 500 TRI'],
  [['bse india infrastructure'], 'BSE India Infrastructure TRI'],
  [['bse 1000'], 'BSE 1000 TRI'],
  [['bse sensex'], 'S&P BSE SENSEX TRI'],
  [['sensex'], 'S&P BSE SENSEX TRI'],
  [['bse midcap'], 'BSE Midcap TRI'],
  [['bse healthcare'], 'BSE Healthcare TRI'],
  [['bse housing'], 'BSE Housing TRI'],
  [['bse psu'], 'BSE PSU TRI'],
];

// Category fallbacks when no index name is in the scheme name (SEBI official benchmark norms)
function categoryBenchmark(nameLower) {
  if (nameLower.indexOf('elss') !== -1) return 'NIFTY 50 TRI';
  if (nameLower.indexOf('flexi cap') !== -1 || nameLower.indexOf('focused') !== -1) return 'BSE 500 TRI';
  if (nameLower.indexOf('large & mid cap') !== -1 || nameLower.indexOf('large and mid cap') !== -1) return 'NIFTY LargeMidcap 250 TRI';
  if (nameLower.indexOf('small cap') !== -1) return 'NIFTY Smallcap 250 TRI';
  if (nameLower.indexOf('mid cap') !== -1) return 'NIFTY Midcap 150 TRI';
  if (nameLower.indexOf('large cap') !== -1 || nameLower.indexOf('bluechip') !== -1 || nameLower.indexOf('top 100') !== -1) return 'NIFTY 100 TRI';
  if (nameLower.indexOf('multi cap') !== -1 || nameLower.indexOf('value') !== -1 || nameLower.indexOf('contra') !== -1) return 'NIFTY 500 TRI';
  if (nameLower.indexOf('momentum') !== -1) return 'NIFTY500 Momentum 50 TRI';
  if (nameLower.indexOf('quality') !== -1) return 'NIFTY500 Quality 50 TRI';
  return null;
}

// Equity categories only — debt/liquid/money-market/commodity/hybrid funds have no single equity benchmark
const NON_EQUITY = ['Debt', 'Commodities', 'Hybrid', 'ETF/FoF'];

function detectBenchmark(schemeName, category) {
  if (NON_EQUITY.includes(category)) return null;
  const lc = (schemeName || '').toLowerCase();
  for (const [tokens, label] of BENCH_RULES) {
    if (tokens.every(t => lc.indexOf(t) !== -1)) return label;
  }
  return categoryBenchmark(lc);
}

// Cache benchmark returns per benchmark label so we only compute once per index
const benchProxyCache = {};  // label -> { proxyId, navs }
const benchProxyStmt = db.prepare(`
  SELECT s.id AS schemeId, COUNT(h.navDate) AS cnt
  FROM mutual_fund_schemes s
  LEFT JOIN mutual_fund_nav_history h ON h.schemeId = s.id
  WHERE (s.schemeName LIKE ? OR s.schemeName LIKE ?)
    AND (s.schemeName LIKE '%Index%' OR s.schemeName LIKE '%ETF%' OR s.schemeName LIKE '%ETF FOF%' OR s.schemeName LIKE '%ETF FoF%')
  GROUP BY s.id ORDER BY cnt DESC LIMIT 1
`);

// Map benchmark label -> index-fund name fragment(s) to find a proxy in the DB
const PROXY_FRAGMENTS = {
  'NIFTY 50 TRI': ['%Nifty 50 Index%', '%NIFTY 50 Index%'],
  'NIFTY 100 TRI': ['%Nifty 100 Index%', '%NIFTY 100 Index%'],
  'NIFTY 200 TRI': ['%Nifty 200 Index%', '%NIFTY 200 Index%'],
  'NIFTY 500 TRI': ['%Nifty 500 Index%', '%NIFTY 500 Index%'],
  'NIFTY Next 50 TRI': ['%Nifty Next 50 Index%', '%NIFTY Next 50 Index%'],
  'NIFTY Midcap 150 TRI': ['%Nifty Midcap 150 Index%', '%NIFTY Midcap 150 Index%'],
  'NIFTY Midcap 100 TRI': ['%Nifty Midcap 100 Index%', '%NIFTY Midcap 100 Index%'],
  'NIFTY Midcap 50 TRI': ['%Nifty Midcap 50 Index%', '%NIFTY Midcap 50 Index%'],
  'NIFTY Smallcap 250 TRI': ['%Nifty Smallcap 250 Index%', '%NIFTY Smallcap 250 Index%'],
  'NIFTY Smallcap 50 TRI': ['%Nifty Smallcap 50 Index%', '%NIFTY Smallcap 50 Index%'],
  'NIFTY LargeMidcap 250 TRI': ['%Nifty LargeMidcap 250 Index%', '%NIFTY LargeMidcap 250 Index%'],
  'NIFTY Microcap 250 TRI': ['%Nifty Microcap 250 Index%', '%NIFTY Microcap 250 Index%'],
  'NIFTY Total Market TRI': ['%Nifty Total Market Index%', '%NIFTY Total Market Index%'],
  'NIFTY Bank TRI': ['%Nifty Bank Index%', '%NIFTY Bank Index%'],
  'NIFTY IT TRI': ['%Nifty IT Index%', '%NIFTY IT Index%'],
  'NIFTY Auto TRI': ['%Nifty Auto Index%', '%NIFTY Auto Index%'],
  'NIFTY Pharma TRI': ['%Nifty Pharma Index%', '%NIFTY Pharma Index%'],
  'NIFTY Realty TRI': ['%Nifty Realty Index%', '%NIFTY Realty Index%'],
  'NIFTY Metal TRI': ['%Nifty Metal Index%', '%NIFTY Metal Index%'],
  'NIFTY India Defence TRI': ['%Nifty India Defence Index%', '%NIFTY India Defence Index%'],
  'NIFTY India Manufacturing TRI': ['%Nifty India Manufacturing Index%', '%NIFTY India Manufacturing Index%'],
  'NIFTY Private Bank TRI': ['%Nifty Private Bank Index%', '%NIFTY Private Bank Index%'],
  'NIFTY Infrastructure TRI': ['%Nifty Infrastructure Index%', '%NIFTY Infrastructure Index%'],
  'NIFTY PSE TRI': ['%Nifty PSE Index%', '%NIFTY PSE Index%'],
  'NIFTY Commodities TRI': ['%Nifty Commodities Index%', '%NIFTY Commodities Index%'],
  'NIFTY Alpha TRI': ['%Nifty Alpha%Index%', '%NIFTY Alpha%Index%'],
  'NIFTY Financial Services TRI': ['%Nifty Financial Services Index%', '%NIFTY Financial Services Index%'],
  'NIFTY Healthcare TRI': ['%Nifty Healthcare Index%', '%NIFTY Healthcare Index%'],
  'NIFTY India Consumption TRI': ['%Nifty India Consumption Index%', '%Nifty India Consumption Index%'],
  'NIFTY India Digital TRI': ['%Nifty India Digital Index%', '%NIFTY India Digital Index%'],
  'NIFTY India Tourism TRI': ['%Nifty India Tourism Index%', '%NIFTY India Tourism Index%'],
  'NIFTY India Railways PSU TRI': ['%Nifty India Railways PSU Index%', '%Nifty India Railways PSU Index%'],
  'NIFTY India Internet TRI': ['%Nifty India Internet Index%', '%Nifty India Internet Index%'],
  'NIFTY Capital Market TRI': ['%Nifty Capital Market Index%', '%Nifty Capital Markets Index%'],
  'NIFTY MidSmall Healthcare TRI': ['%Nifty MidSmall Healthcare Index%', '%Nifty MidSmall Healthcare Index%'],
  'NIFTY MidSmall India Consumption TRI': ['%Nifty MidSmall India Consumption Index%', '%Nifty MidSmall India Consumption Index%'],
  'NIFTY EV & New Age Automotive TRI': ['%Nifty EV & New Age Automotive%Index%', '%Nifty EV%New Age Automotive%Index%'],
  'BSE India Sector Leaders TRI': ['%BSE India Sector Leaders Index%', '%BSE India Sector Leaders Index%'],
  'NIFTY50 Equal Weight TRI': ['%Nifty 50 Equal Weight Index%', '%NIFTY 50 Equal Weight Index%'],
  'NIFTY100 Equal Weight TRI': ['%Nifty 100 Equal Weight Index%', '%NIFTY 100 Equal Weight Index%'],
  'NIFTY500 Equal Weight TRI': ['%Nifty 500 Equal Weight Index%', '%NIFTY 500 Equal Weight Index%'],
  'NIFTY500 Momentum 50 TRI': ['%Nifty 500 Momentum 50 Index%', '%NIFTY 500 Momentum 50 Index%'],
  'NIFTY500 Quality 50 TRI': ['%Nifty 500 Quality 50 Index%', '%NIFTY 500 Quality 50 Index%'],
  'NIFTY500 Value 50 TRI': ['%Nifty 500 Value 50 Index%', '%NIFTY 500 Value 50 Index%'],
  'NIFTY200 Momentum 30 TRI': ['%Nifty 200 Momentum 30 Index%', '%NIFTY 200 Momentum 30 Index%'],
  'NIFTY200 Quality 30 TRI': ['%Nifty 200 Quality 30 Index%', '%NIFTY 200 Quality 30 Index%'],
  'NIFTY200 Value 30 TRI': ['%Nifty 200 Value 30 Index%', '%NIFTY 200 Value 30 Index%'],
  'NIFTY100 Quality 30 TRI': ['%Nifty 100 Quality 30 Index%', '%NIFTY 100 Quality 30 Index%'],
  'NIFTY100 Low Volatility 30 TRI': ['%Nifty 100 Low Volatility 30 Index%', '%NIFTY 100 Low Volatility 30 Index%'],
  'NIFTY50 Value 20 TRI': ['%Nifty 50 Value 20 Index%', '%NIFTY 50 Value 20 Index%'],
  'BSE 500 TRI': ['%BSE 500 Index%', '%BSE 500 Index%'],
  'BSE 500 Momentum 50 TRI': ['%BSE 500 Momentum 50 Index%', '%BSE 500 Momentum 50 Index%'],
  'BSE 500 Quality 50 TRI': ['%BSE 500 Quality 50 Index%', '%BSE 500 Quality 50 Index%'],
  'BSE India Infrastructure TRI': ['%BSE India Infrastructure Index%', '%BSE India Infrastructure Index%'],
  'BSE 1000 TRI': ['%BSE 1000 Index%', '%BSE 1000 Index%'],
  'S&P BSE SENSEX TRI': ['%BSE Sensex Index%', '%Sensex Index%'],
  'BSE Midcap TRI': ['%BSE Midcap%Index%', '%BSE Midcap%Index%'],
  'BSE Healthcare TRI': ['%BSE Healthcare Index%', '%BSE Healthcare Index%'],
  'BSE Housing TRI': ['%BSE Housing Index%', '%BSE Housing Index%'],
  'BSE PSU TRI': ['%BSE PSU Index%', '%BSE PSU Index%'],
};

function getBenchmarkProxy(label) {
  if (benchProxyCache[label]) return benchProxyCache[label];
  const frags = PROXY_FRAGMENTS[label] || ['%' + label.replace(' TRI', '').replace('S&P BSE SENSEX', 'Sensex') + '%Index%'];
  let best = null;
  for (const f of frags) {
    const row = benchProxyStmt.get(f, f);
    if (row && (!best || row.cnt > best.cnt)) best = row;
  }
  if (!best || !best.cnt) { benchProxyCache[label] = null; return null; }
  const navs = db.prepare('SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate').all(best.schemeId);
  benchProxyCache[label] = { proxyId: best.schemeId, navs };
  return benchProxyCache[label];
}

/** Benchmark's own cumulative return over trailing lookback calendar days (decimal). */
function benchmarkReturn(navs, lookbackDays) {
  if (!navs || navs.length < 2) return null;
  const endDate = navs[navs.length - 1].navDate;
  const cutoff = new Date(new Date(endDate).getTime() - lookbackDays * 86400000).toISOString().slice(0, 10);
  const win = navs.filter(r => r.navDate >= cutoff);
  if (win.length < 2) return null;
  const first = win[0].nav, last = win[win.length - 1].nav;
  if (!first || !last || first <= 0) return null;
  return (last - first) / first;
}

// ─── Multi-period INSERT ─────────────────────────────────────────────────────
const cols = ['alpha_1m', 'beta_1m', 'sharpe_1m', 'sortino_1m', 'treynor_1m', 'stdDev_1m',
  'alpha_3m', 'beta_3m', 'sharpe_3m', 'sortino_3m', 'treynor_3m', 'stdDev_3m',
  'alpha_6m', 'beta_6m', 'sharpe_6m', 'sortino_6m', 'treynor_6m', 'stdDev_6m',
  'alpha_1y', 'beta_1y', 'sharpe_1y', 'sortino_1y', 'treynor_1y', 'stdDev_1y',
  'alpha_3y', 'beta_3y', 'sharpe_3y', 'sortino_3y', 'treynor_3y', 'stdDev_3y',
  'alpha_5y', 'beta_5y', 'sharpe_5y', 'sortino_5y', 'treynor_5y', 'stdDev_5y',
  'alpha_10y', 'beta_10y', 'sharpe_10y', 'sortino_10y', 'treynor_10y', 'stdDev_10y',
  'benchmarkName', 'benchmark_1m', 'benchmark_3m', 'benchmark_6m', 'benchmark_1y'];
const placeholders = cols.map(() => '?').join(',');
const insert = db.prepare(`INSERT OR REPLACE INTO fund_metrics (schemeId, ${cols.join(',')}, computedAt) VALUES (?, ${placeholders}, datetime('now'))`);

// lookback calendar days per metric window
const lookbacks = { '1m': 55, '3m': 120, '6m': 210, '1y': 390, '3y': 1150, '5y': 1900, '10y': 3750 };
const benchLookbacks = { '1m': 55, '3m': 120, '6m': 210, '1y': 390 };

const schemes = db.prepare('SELECT id, schemeName, category FROM mutual_fund_schemes').all();
let computed = 0, skipped = 0, benchMatched = 0, benchMissed = 0;

for (const s of schemes) {
  const fundNavs = db.prepare('SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate').all(s.id);
  if (!fundNavs.length) { skipped++; continue; }
  const vals = {};
  let anyValid = false;
  for (const [label, lb] of Object.entries(lookbacks)) {
    const aligned = alignedReturns(fundNavs, benchNavs, lb);
    if (aligned) {
      const m = metricsFor(aligned);
      if (m) { vals[label] = m; anyValid = true; }
    }
  }

  // Official benchmark return for this scheme
  let benchLabel = null, benchVals = {};
  try { benchLabel = detectBenchmark(s.schemeName, s.category); } catch (e) {}
  if (benchLabel) {
    const proxy = getBenchmarkProxy(benchLabel);
    if (proxy) {
      for (const [label, lb] of Object.entries(benchLookbacks)) {
        benchVals[label] = benchmarkReturn(proxy.navs, lb);
      }
      benchMatched++;
    } else {
      benchMissed++;
    }
  }

  if (anyValid || Object.keys(benchVals).length) {
    const m = p => vals[p] || {};
    insert.run(s.id,
      m('1m').alpha || null, m('1m').beta || null, m('1m').sharpe || null, m('1m').sortino || null, m('1m').treynor || null, m('1m').stdDev || null,
      m('3m').alpha || null, m('3m').beta || null, m('3m').sharpe || null, m('3m').sortino || null, m('3m').treynor || null, m('3m').stdDev || null,
      m('6m').alpha || null, m('6m').beta || null, m('6m').sharpe || null, m('6m').sortino || null, m('6m').treynor || null, m('6m').stdDev || null,
      m('1y').alpha || null, m('1y').beta || null, m('1y').sharpe || null, m('1y').sortino || null, m('1y').treynor || null, m('1y').stdDev || null,
      m('3y').alpha || null, m('3y').beta || null, m('3y').sharpe || null, m('3y').sortino || null, m('3y').treynor || null, m('3y').stdDev || null,
      m('5y').alpha || null, m('5y').beta || null, m('5y').sharpe || null, m('5y').sortino || null, m('5y').treynor || null, m('5y').stdDev || null,
      m('10y').alpha || null, m('10y').beta || null, m('10y').sharpe || null, m('10y').sortino || null, m('10y').treynor || null, m('10y').stdDev || null,
      benchLabel || null,
      benchVals['1m'] != null ? r4(benchVals['1m']) : null,
      benchVals['3m'] != null ? r4(benchVals['3m']) : null,
      benchVals['6m'] != null ? r4(benchVals['6m']) : null,
      benchVals['1y'] != null ? r4(benchVals['1y']) : null
    );
    computed++;
  } else skipped++;
}

console.log('Computed metrics for', computed, 'schemes (' + skipped + ' skipped)');
console.log('Benchmark matched:', benchMatched, '| missed (no index-fund proxy):', benchMissed);

// Sanity samples
for (const probe of ['360 ONE ELSS Tax Saver Nifty 50 Index Fund Direct Growth', 'HDFC Flexi Cap Fund Direct Growth', 'Abakkus Small Cap Fund Direct Growth', 'Aditya Birla Sun Life BSE 500 Momentum 50 Index Fund Direct Growth']) {
  const s = db.prepare('SELECT id FROM mutual_fund_schemes WHERE schemeName=?').get(probe);
  if (s) {
    const row = db.prepare('SELECT benchmarkName, benchmark_1m, benchmark_3m, benchmark_6m, benchmark_1y, alpha_1y, beta_1y FROM fund_metrics WHERE schemeId=?').get(s.id);
    console.log(probe.slice(0, 60), '=>', row ? JSON.stringify(row) : 'NONE');
  }
}
db.close();