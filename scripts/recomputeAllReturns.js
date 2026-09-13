/**
 * scripts/recomputeAllReturns.js
 *
 * Recomputes ALL period returns (1D/1W/1M/3M/6M/1Y/3Y/5Y/ALL) for every scheme
 * from its stored NAV history. 'ALL' = since inception (first available NAV vs
 * latest). Older windows are recomputed too so they always agree with the NAV
 * history.
 *
 * Usage: node scripts/recomputeAllReturns.js
 */
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

function navBlobToSeries(points) {
  if (!points) return [];
  const out = [];
  let i = 0;
  const n = points.length;
  while (i < n) {
    const c = points.indexOf(':', i);
    if (c < 0) break;
    const navDate = points.slice(i, c);
    let e = points.indexOf(',', c + 1);
    if (e < 0) e = n;
    const nav = parseFloat(points.slice(c + 1, e));
    if (!isNaN(nav) && nav > 0) out.push({ navDate, nav });
    i = e + 1;
  }
  return out;
}

/** Trailing return: % change from the NAV nearest on/before (latest - days) to latest. */
function trailingReturn(series, days) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  if (!last.nav || last.nav <= 0) return null;
  const cutoff = new Date(new Date(last.navDate + 'T00:00:00').getTime() - days * 86400000).toISOString().slice(0, 10);
  let base = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].navDate <= cutoff) { base = series[i]; break; }
  }
  if (!base || !base.nav || base.nav <= 0 || base.navDate === last.navDate) return null;
  return (last.nav - base.nav) / base.nav * 100;
}

const WINDOWS = { '1D': 1, '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095, '5Y': 1825, 'ALL': null };

const delRet = db.prepare('DELETE FROM mutual_fund_returns WHERE schemeId = ?');
const insRet = db.prepare("INSERT OR REPLACE INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source) VALUES (?, ?, ?, ?, 'nav-recomputed')");

const rows = db.prepare('SELECT schemeId, points FROM mutual_fund_nav_blob').all();
console.log('[recompute] schemes with NAV history:', rows.length);

let updated = 0, skipped = 0;
const tx = db.transaction(() => {
  for (const row of rows) {
    const series = navBlobToSeries(row.points);
    if (series.length < 2) { skipped++; continue; }
    delRet.run(row.schemeId);
    const latest = series[series.length - 1].navDate;
    for (const [period, days] of Object.entries(WINDOWS)) {
      let v;
      if (days === null) {
        // ALL = since inception: first vs latest NAV
        const first = series[0], last = series[series.length - 1];
        if (first.nav > 0 && first.navDate !== last.navDate) v = (last.nav - first.nav) / first.nav * 100;
      } else {
        v = trailingReturn(series, days);
      }
      if (v != null && isFinite(v)) insRet.run(row.schemeId, period, v, latest);
    }
    updated++;
  }
});
tx();

console.log('[recompute] done. schemes updated:', updated, '| skipped (insufficient history):', skipped);
