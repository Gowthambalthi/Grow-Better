const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db'));

db.exec("CREATE TABLE IF NOT EXISTS fund_metrics (schemeId TEXT PRIMARY KEY, alpha_1y REAL, beta_1y REAL, sharpe_1y REAL, sortino_1y REAL, treynor_1y REAL, stdDev_1y REAL, alpha_3y REAL, beta_3y REAL, sharpe_3y REAL, sortino_3y REAL, treynor_3y REAL, stdDev_3y REAL, computedAt TEXT)");

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

const insert = db.prepare("INSERT OR REPLACE INTO fund_metrics (schemeId, alpha_1y, beta_1y, sharpe_1y, sortino_1y, treynor_1y, stdDev_1y, computedAt) VALUES (?,?,?,?,?,?,?,datetime('now'))");

const schemes = db.prepare("SELECT DISTINCT schemeId FROM mutual_fund_nav_history").all();
let computed = 0;

for (const s of schemes) {
  const navs = db.prepare("SELECT nav FROM mutual_fund_nav_history WHERE schemeId=? ORDER BY navDate").all(s.schemeId).map(r=>r.nav);
  const fRet = dr(navs);
  const n = Math.min(fRet.length, bRet.length);
  if (n < 60) continue;
  const f = fRet.slice(-252), b = bRet.slice(-252);
  const beta = cov(f,b)/(vr(b)||1e-10);
  const fM = mean(f)*252, bM = mean(b)*252;
  const alpha = fM - (RF*252 + beta*(bM - RF*252));
  const s2 = sd(f)*Math.sqrt(252);
  const sharpe = s2>0?(fM-RF*252)/s2:0;
  const down = f.filter(r=>r<RF);
  const dd = down.length>1?Math.sqrt(down.reduce((s,r)=>s+(r-RF)**2,0)/down.length)*Math.sqrt(252):s2;
  const sortino = dd>0?(fM-RF*252)/dd:0;
  const treynor = beta!==0?(fM-RF*252)/beta:0;
  insert.run(s.schemeId, Math.round(alpha*100)/100, Math.round(beta*100)/100, Math.round(sharpe*100)/100, Math.round(sortino*100)/100, Math.round(treynor*100)/100, Math.round(s2*100)/100);
  computed++;
}

console.log('Computed metrics for', computed, 'schemes');
const sample = db.prepare("SELECT * FROM fund_metrics LIMIT 3").all();
sample.forEach(r => console.log(r.schemeId + ': Alpha=' + r.alpha_1y + ' Beta=' + r.beta_1y + ' Sharpe=' + r.sharpe_1y + ' Sortino=' + r.sortino_1y + ' StdDev=' + r.stdDev_1y));
db.close();
