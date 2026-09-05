/**
 * Compute Alpha/Beta/Sharpe/Sortino/Treynor/StdDev for all schemes with NAV history.
 * Real values computed from DAILY NAV returns vs a real Nifty 50 index-fund benchmark,
 * with strict date alignment (fund & benchmark compared on the SAME calendar days).
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

// ─── Multi-period INSERT ─────────────────────────────────────────────────────
const cols = ['alpha_1m', 'beta_1m', 'sharpe_1m', 'sortino_1m', 'treynor_1m', 'stdDev_1m',
  'alpha_3m', 'beta_3m', 'sharpe_3m', 'sortino_3m', 'treynor_3m', 'stdDev_3m',
  'alpha_6m', 'beta_6m', 'sharpe_6m', 'sortino_6m', 'treynor_6m', 'stdDev_6m',
  'alpha_1y', 'beta_1y', 'sharpe_1y', 'sortino_1y', 'treynor_1y', 'stdDev_1y',
  'alpha_3y', 'beta_3y', 'sharpe_3y', 'sortino_3y', 'treynor_3y', 'stdDev_3y',
  'alpha_5y', 'beta_5y', 'sharpe_5y', 'sortino_5y', 'treynor_5y', 'stdDev_5y',
  'alpha_10y', 'beta_10y', 'sharpe_10y', 'sortino_10y', 'treynor_10y', 'stdDev_10y'];
const placeholders = cols.map(() => '?').join(',');
const insert = db.prepare(`INSERT OR REPLACE INTO fund_metrics (schemeId, ${cols.join(',')}, computedAt) VALUES (?, ${placeholders}, datetime('now'))`);

// lookback calendar days per metric window
const lookbacks = { '1m': 55, '3m': 120, '6m': 210, '1y': 390, '3y': 1150, '5y': 1900, '10y': 3750 };

const schemes = db.prepare('SELECT DISTINCT schemeId FROM mutual_fund_nav_history').all();
let computed = 0, skipped = 0;

for (const s of schemes) {
  const fundNavs = db.prepare('SELECT navDate, nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate').all(s.schemeId);
  const vals = {};
  let anyValid = false;
  for (const [label, lb] of Object.entries(lookbacks)) {
    const aligned = alignedReturns(fundNavs, benchNavs, lb);
    if (aligned) {
      const m = metricsFor(aligned);
      if (m) { vals[label] = m; anyValid = true; }
    }
  }
  if (anyValid) {
    const m = p => vals[p] || {};
    insert.run(s.schemeId,
      m('1m').alpha || null, m('1m').beta || null, m('1m').sharpe || null, m('1m').sortino || null, m('1m').treynor || null, m('1m').stdDev || null,
      m('3m').alpha || null, m('3m').beta || null, m('3m').sharpe || null, m('3m').sortino || null, m('3m').treynor || null, m('3m').stdDev || null,
      m('6m').alpha || null, m('6m').beta || null, m('6m').sharpe || null, m('6m').sortino || null, m('6m').treynor || null, m('6m').stdDev || null,
      m('1y').alpha || null, m('1y').beta || null, m('1y').sharpe || null, m('1y').sortino || null, m('1y').treynor || null, m('1y').stdDev || null,
      m('3y').alpha || null, m('3y').beta || null, m('3y').sharpe || null, m('3y').sortino || null, m('3y').treynor || null, m('3y').stdDev || null,
      m('5y').alpha || null, m('5y').beta || null, m('5y').sharpe || null, m('5y').sortino || null, m('5y').treynor || null, m('5y').stdDev || null,
      m('10y').alpha || null, m('10y').beta || null, m('10y').sharpe || null, m('10y').sortino || null, m('10y').treynor || null, m('10y').stdDev || null
    );
    computed++;
  } else skipped++;
}

console.log('Computed metrics for', computed, 'schemes (' + skipped + ' skipped)');
const sample = db.prepare('SELECT schemeId, alpha_1m, beta_1m, sharpe_1m, alpha_1y, beta_1y, sharpe_1y, stdDev_1y FROM fund_metrics WHERE schemeId=?').get('HDFC_118955');
console.log('HDFC Flexi Cap sample:', sample ? JSON.stringify(sample) : 'NONE');
db.close();
