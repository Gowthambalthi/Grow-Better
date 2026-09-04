const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db'));

// Drop and recreate with full multi-period schema
db.exec("DROP TABLE IF EXISTS fund_metrics");
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

const RF = 6.5/100/252;
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
const sd = a => { const m=mean(a); return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1)); };
const cov = (a,b) => { const ma=mean(a),mb=mean(b); return a.reduce((s,v,i)=>s+(v-ma)*(b[i]-mb),0)/(a.length-1); };
const vr = a => { const m=mean(a); return a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1); };
const dr = n => { const r=[]; for(let i=1;i<n.length;i++){if(n[i-1]>0)r.push((n[i]-n[i-1])/n[i-1]);} return r; };

// Pick the scheme with most NAV data as benchmark
const bestBench = db.prepare("SELECT schemeId, COUNT(*) as cnt FROM mutual_fund_nav_history GROUP BY schemeId ORDER BY cnt DESC LIMIT 1").get();
console.log('Benchmark scheme:', bestBench ? bestBench.schemeId + ' (' + bestBench.cnt + ' days)' : 'NONE');

if (!bestBench) {
  console.log('No NAV data available. Run collectNavHistory.js first.');
  db.close();
  process.exit(0);
}

const bRet = dr(db.prepare("SELECT nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate").all(bestBench.schemeId).map(r=>r.nav));
console.log('Benchmark returns:', bRet.length, 'days');

// Build multi-period INSERT
const cols = ['alpha_1m','beta_1m','sharpe_1m','sortino_1m','treynor_1m','stdDev_1m',
  'alpha_3m','beta_3m','sharpe_3m','sortino_3m','treynor_3m','stdDev_3m',
  'alpha_6m','beta_6m','sharpe_6m','sortino_6m','treynor_6m','stdDev_6m',
  'alpha_1y','beta_1y','sharpe_1y','sortino_1y','treynor_1y','stdDev_1y',
  'alpha_3y','beta_3y','sharpe_3y','sortino_3y','treynor_3y','stdDev_3y',
  'alpha_5y','beta_5y','sharpe_5y','sortino_5y','treynor_5y','stdDev_5y',
  'alpha_10y','beta_10y','sharpe_10y','sortino_10y','treynor_10y','stdDev_10y'];
const placeholders = cols.map(() => '?').join(',');
const insert = db.prepare(`INSERT OR REPLACE INTO fund_metrics (schemeId, ${cols.join(',')}, computedAt) VALUES (?, ${placeholders}, datetime('now'))`);

function computeMetrics(fundReturns, benchmarkReturns) {
  const n = Math.min(fundReturns.length, benchmarkReturns.length);
  if (n < 15) return null;
  const f = fundReturns.slice(-n), b = benchmarkReturns.slice(-n);
  const beta = cov(f,b)/(vr(b)||1e-10);
  const fM = mean(f)*252, bM = mean(b)*252;
  const alpha = fM - (RF*252 + beta*(bM - RF*252));
  const s2 = sd(f)*Math.sqrt(252);
  const sharpe = s2>0?(fM-RF*252)/s2:0;
  const down = f.filter(r=>r<RF);
  const dd = down.length>1?Math.sqrt(down.reduce((s,r)=>s+(r-RF)**2,0)/down.length)*Math.sqrt(252):s2;
  const sortino = dd>0?(fM-RF*252)/dd:0;
  const treynor = beta!==0?(fM-RF*252)/beta:0;
  return {
    alpha: Math.round(alpha*100)/100, beta: Math.round(beta*100)/100,
    sharpe: Math.round(sharpe*100)/100, sortino: Math.round(sortino*100)/100,
    treynor: Math.round(treynor*100)/100, stdDev: Math.round(s2*100)/100
  };
}

const periods = { '1m':21, '3m':63, '6m':126, '1y':252, '3y':756, '5y':1260, '10y':2520 };
const schemes = db.prepare("SELECT DISTINCT schemeId FROM mutual_fund_nav_history").all();
let computed = 0;

for (const s of schemes) {
  const navs = db.prepare("SELECT nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate").all(s.schemeId).map(r=>r.nav);
  const fRet = dr(navs);
  const vals = {};
  let anyValid = false;
  for (const [label, days] of Object.entries(periods)) {
    if (fRet.length >= Math.min(days, 30)) {
      const ret = fRet.slice(-days);
      const bench = bRet.slice(-days);
      vals[label] = computeMetrics(ret, bench);
      if (vals[label]) anyValid = true;
    }
  }
  if (anyValid) {
    const m = p => vals[p] || {};
    insert.run(s.schemeId,
      m('1m').alpha||null, m('1m').beta||null, m('1m').sharpe||null, m('1m').sortino||null, m('1m').treynor||null, m('1m').stdDev||null,
      m('3m').alpha||null, m('3m').beta||null, m('3m').sharpe||null, m('3m').sortino||null, m('3m').treynor||null, m('3m').stdDev||null,
      m('6m').alpha||null, m('6m').beta||null, m('6m').sharpe||null, m('6m').sortino||null, m('6m').treynor||null, m('6m').stdDev||null,
      m('1y').alpha||null, m('1y').beta||null, m('1y').sharpe||null, m('1y').sortino||null, m('1y').treynor||null, m('1y').stdDev||null,
      m('3y').alpha||null, m('3y').beta||null, m('3y').sharpe||null, m('3y').sortino||null, m('3y').treynor||null, m('3y').stdDev||null,
      m('5y').alpha||null, m('5y').beta||null, m('5y').sharpe||null, m('5y').sortino||null, m('5y').treynor||null, m('5y').stdDev||null,
      m('10y').alpha||null, m('10y').beta||null, m('10y').sharpe||null, m('10y').sortino||null, m('10y').treynor||null, m('10y').stdDev||null
    );
    computed++;
  }
}

console.log('Computed metrics for', computed, 'schemes');
const sample = db.prepare("SELECT * FROM fund_metrics LIMIT 1").all();
if (sample.length) console.log('Sample:', JSON.stringify(sample[0]));
db.close();
