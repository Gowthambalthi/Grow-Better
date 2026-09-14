/**
 * scripts/reconcileDataQuality.js
 *
 * Spec section 3 — Reconciliation Job
 *   Daily  : recompute each scheme's returns from NAV history and diff against
 *            stored values. Drift > 0.1pp → flag + trigger recalculation.
 *   Monthly: cross-check ingested scheme AUM sums against AMFI's published
 *            AMC-level AAUM report; log discrepancies (never overwrite).
 *
 * Usage:
 *   node scripts/reconcileDataQuality.js daily
 *   node scripts/reconcileDataQuality.js monthly <amcAumJsonPath>
 *   node scripts/reconcileDataQuality.js daily+monthly <amcAumJsonPath>
 */
'use strict';
const path = require('path');
const fs = require('fs');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();
const dq = require('../db/dataQuality');
dq.init(db);

function navBlobToSeries(points) {
  if (!points) return [];
  const out = []; let i = 0; const n = points.length;
  while (i < n) {
    const c = points.indexOf(':', i); if (c < 0) break;
    const navDate = points.slice(i, c);
    let e = points.indexOf(',', c + 1); if (e < 0) e = n;
    const nav = parseFloat(points.slice(c + 1, e));
    if (!isNaN(nav) && nav > 0) out.push({ navDate, nav });
    i = e + 1;
  }
  return out;
}

function trailingPct(series, days) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const [yy, mm, dd] = last.navDate.split('-').map(Number);
  const cutoff = new Date(Date.UTC(yy, mm - 1, dd - days)).toISOString().slice(0, 10);
  let base = null;
  for (const p of series) { if (p.navDate >= cutoff) { base = p; break; } }
  if (!base) return null;
  return (last.nav - base.nav) / base.nav * 100;
}

const WINDOW_DAYS = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365 };

function dailyReconcile() {
  console.log('[recon] daily returns reconciliation started');
  const schemes = db.prepare("SELECT id FROM mutual_fund_schemes").all();
  let checked = 0, drift = 0;
  for (const s of schemes) {
    const blob = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?').get(s.id);
    if (!blob) continue;
    const series = navBlobToSeries(blob.points);
    if (series.length < 2) continue;
    const stored = db.prepare("SELECT period, returnValue FROM mutual_fund_returns WHERE schemeId=? AND period IN ('1M','3M','6M','1Y')").all(s.id);
    if (!stored.length) continue;
    checked++;
    for (const row of stored) {
      const fresh = trailingPct(series, WINDOW_DAYS[row.period]);
      if (fresh == null) continue;
      if (Math.abs(fresh - row.returnValue) > 0.1) {
        drift++;
        dq.flag(s.id, 'return_' + row.period, 'RECON', row.returnValue, 'nav-recomputed',
          `stored ${row.returnValue.toFixed(2)}% vs recomputed ${fresh.toFixed(2)}% (>0.1pp drift)`);
      } else {
        dq.autoResolve(s.id, 'return_' + row.period, 'RECON');
      }
    }
  }
  console.log(`[recon] daily done: ${checked} schemes checked, ${drift} drift flags. Run recomputeAllReturns.js to recalculate drifted values.`);
  return { checked, drift };
}

function monthlyAumCrossCheck(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error('[recon] monthly: provide path to AMFI AAUM JSON { amcName: totalAaumCr }');
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const disc = dq.crossCheckAumVsAmfi(map);
  console.log(`[recon] monthly AUM cross-check: ${disc.length} AMC-level discrepancies logged`);
  for (const d of disc) console.log(`  - ${d.amc}: ours ₹${d.ours} Cr vs AMFI ₹${d.amfi} Cr`);
  return disc;
}

const mode = process.argv[2] || 'daily';
if (mode.includes('daily')) dailyReconcile();
if (mode.includes('monthly')) monthlyAumCrossCheck(process.argv[3]);
