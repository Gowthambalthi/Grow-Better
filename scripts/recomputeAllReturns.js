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
const dq = require('../db/dataQuality');
dq.init(db);

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

/**
 * Trailing return: % change from the NAV nearest ON-OR-AFTER (latest - days) to latest.
 * Logic: the target day (e.g. 1Y ago) may be a weekend/holiday — use the NEXT
 * trading day's NAV in that case (first NAV >= cutoff), so the window always
 * spans a true year. Falls back to the previous trading day only if no later
 * NAV exists (e.g. fund suspended).
 */
function trailingReturn(series, days, isCommodity) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  if (!last.nav || last.nav <= 0) return null;
  // Pure date-string arithmetic (no timezone drift): subtract days from the
  // calendar date so the target is exact.
  const [yy, mm, dd] = last.navDate.split('-').map(Number);
  // Commodities (Gold/Silver funds): prices move on global markets regardless
  // of Indian NAV publishing days — for 1Y use the exact calendar-year date
  // (e.g. Sep 13 → Sep 13), picking the nearest available NAV on/after it.
  const cut = isCommodity && days >= 365
    ? new Date(Date.UTC(yy - Math.round(days / 365), mm - 1, dd))
    : new Date(Date.UTC(yy, mm - 1, dd - days));
  const cutoff = cut.toISOString().slice(0, 10);
  let base = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].navDate >= cutoff) { base = series[i]; break; }
  }
  if (!base) {
    for (let i = series.length - 1; i >= 0; i--) { if (series[i].navDate <= cutoff) { base = series[i]; break; } }
  }      if (!base || !base.nav || base.nav <= 0 || base.navDate === last.navDate) return null;
  const pct = (last.nav - base.nav) / base.nav * 100;
  // 3Y/5Y are shown annualised (CAGR), matching industry convention
  if (days >= 1095) {
    const yrs = days / 365;
    return (Math.pow(1 + pct / 100, 1 / yrs) - 1) * 100;
  }
  return pct;
}

const WINDOWS = { '1D': 1, '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095, '5Y': 1825, 'ALL': null };

const delRet = db.prepare('DELETE FROM mutual_fund_returns WHERE schemeId = ?');
const insRet = db.prepare("INSERT OR REPLACE INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source) VALUES (?, ?, ?, ?, 'nav-recomputed')");

const rows = db.prepare('SELECT schemeId, points FROM mutual_fund_nav_blob').all();
console.log('[recompute] schemes with NAV history:', rows.length);
// Gold/Silver schemes: calendar-year date logic for 1Y/3Y/5Y
const commodityIds = new Set(
  db.prepare("SELECT id FROM mutual_fund_schemes WHERE schemeName LIKE '%gold%' OR schemeName LIKE '%silver%'").all().map(r => r.id)
);
console.log('[recompute] commodity schemes (Gold/Silver):', commodityIds.size);

let updated = 0, skipped = 0, flagged = 0;
const tx = db.transaction(() => {
  for (const row of rows) {
    const series = navBlobToSeries(row.points);
    if (series.length < 2) { skipped++; continue; }
    delRet.run(row.schemeId);
    const latest = series[series.length - 1].navDate;
    const rets = {};
    for (const [period, days] of Object.entries(WINDOWS)) {
      let v;
      if (days === null) {
        // ALL = since inception: first vs latest NAV
        const first = series[0], last = series[series.length - 1];
        if (first.nav > 0 && first.navDate !== last.navDate) v = (last.nav - first.nav) / first.nav * 100;
      } else {
        v = trailingReturn(series, days, commodityIds.has(row.schemeId));
      }
      if (v != null && isFinite(v)) { insRet.run(row.schemeId, period, v, latest); rets[period] = v; }
    }
    // VALIDATION GATES — flag implausible values; excluded from scoring via openFlagMap
    const sch = db.prepare(`SELECT s.category, a.aum AS aumCr FROM mutual_fund_schemes s
      LEFT JOIN mutual_fund_aum a ON a.schemeId = s.id
      WHERE s.id = ?`).get(row.schemeId) || {};
    const res = dq.validateSchemeMetrics(row.schemeId, {
      returns: rets, category: sch.category, aumCr: sch.aumCr,
      navDate: latest, source: 'nav-recomputed'
    });
    if (!res.valid) flagged++;
    updated++;
  }
});
tx();

console.log('[recompute] done. schemes updated:', updated, '| skipped (insufficient history):', skipped, '| flagged by validation gates:', flagged);
