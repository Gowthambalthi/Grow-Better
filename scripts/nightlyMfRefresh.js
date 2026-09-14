/**
 * scripts/nightlyMfRefresh.js
 *
 * Long-running scheduler process. Every night, ONCE, between 16:00 (4 PM) and
 * 08:30 the next morning, it refreshes ALL mutual-fund data:
 *
 *   1. Fetches latest NAV history from AMFI's public API (api.mfapi.in) for
 *      every scheme whose latest stored NAV is 30+ days old (or missing) —
 *      this automatically includes newly added funds, since they have no
 *      history yet. Also refreshes everything at least once per month
 *      regardless, so returns stay accurate.
 *   2. Recomputes all period returns (1D..5Y + ALL/since-inception) from NAV
 *      history for every scheme.
 *   3. Backfills AUM + expense ratio from AMFI's official disclosures for
 *      schemes missing them.
 *
 * Run it once (e.g. at boot / logon) and leave it open overnight:
 *   node scripts/nightlyMfRefresh.js
 * It idles between runs, so keep the terminal open until morning.
 */
const axios = require('axios');
const path = require('path');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

const REFRESH_STALE_DAYS = 4;       // refresh schemes whose NAV is older than this (latest trading day can be 1-3 days back)
const WINDOW_START_H = 16;          // 4 PM
const WINDOW_END_H = 8.5;           // 8:30 AM
const API_DELAY_MS = 350;           // be polite to the free AMFI API
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function inWindow(now) {
  const h = now.getHours() + now.getMinutes() / 60;
  return h >= WINDOW_START_H || h < WINDOW_END_H;
}

function toIso(dmy) { const [d, m, y] = dmy.split('-'); return `${y}-${m}-${d}`; }

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

// Target day (latest - days) may be a weekend/holiday — use the NEXT trading
// day's NAV (first >= cutoff); fall back to previous trading day only if none.
function trailingReturn(series, days) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  if (!last.nav || last.nav <= 0) return null;
  const [yy, mm, dd] = last.navDate.split('-').map(Number);
  const cutoff = new Date(Date.UTC(yy, mm - 1, dd - days)).toISOString().slice(0, 10);
  let base = null;
  for (let i = 0; i < series.length; i++) { if (series[i].navDate >= cutoff) { base = series[i]; break; } }
  if (!base) { for (let i = series.length - 1; i >= 0; i--) { if (series[i].navDate <= cutoff) { base = series[i]; break; } } }
  if (!base || !base.nav || base.nav <= 0 || base.navDate === last.navDate) return null;
  const pct = (last.nav - base.nav) / base.nav * 100;
  // 3Y/5Y shown annualised (CAGR), matching industry convention
  if (days >= 1095) {
    const yrs = days / 365;
    return (Math.pow(1 + pct / 100, 1 / yrs) - 1) * 100;
  }
  return pct;
}

const WINDOWS = { '1D': 1, '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095, '5Y': 1825, 'ALL': null };
const insBlob = db.prepare('INSERT OR REPLACE INTO mutual_fund_nav_blob (schemeId, points) VALUES (?, ?)');
const delRet = db.prepare('DELETE FROM mutual_fund_returns WHERE schemeId = ?');
const insRet = db.prepare("INSERT OR REPLACE INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source) VALUES (?, ?, ?, ?, 'nightly')");

// ── Step 1: refresh NAV history for stale/missing schemes ───────────────────
async function refreshStaleNavs() {
  const stale = db.prepare(`
    SELECT s.id, s.schemeCode, s.schemeName,
      (SELECT MAX(substr(points, length(points) - 30)) FROM mutual_fund_nav_blob b WHERE b.schemeId = s.id) AS tail
    FROM mutual_fund_schemes s
    WHERE s.schemeCode IS NOT NULL AND s.schemeCode != ''
  `).all();

  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - REFRESH_STALE_DAYS * 86400000).toISOString().slice(0, 10);
  const targets = [];
  for (const s of stale) {
    const blob = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?').get(s.id);
    if (!blob) { targets.push(s); continue; }
    const series = navBlobToSeries(blob.points);
    const latest = series.length ? series[series.length - 1].navDate : null;
    if (!latest || latest < cutoff) targets.push(s);
  }
  console.log(`[nightly] ${new Date().toISOString()} — NAV refresh: ${targets.length} stale/missing of ${stale.length} schemes`);

  let ok = 0, fail = 0;
  const BATCH = 12;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s) => {
      try {
        const r = await axios.get(`https://api.mfapi.in/mf/${s.schemeCode}`, { timeout: 12000 });
        const data = r.data && r.data.data;
        if (data && data.length) {
          const existing = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?').get(s.id);
          const navMap = {};
          for (const p of navBlobToSeries(existing && existing.points)) navMap[p.navDate] = p.nav;
          for (const p of data) {
            const iso = toIso(p.date); const nav = parseFloat(p.nav);
            if (isFinite(nav) && nav > 0) navMap[iso] = nav;
          }
          const pts = Object.keys(navMap).sort().map((d) => d + ':' + navMap[d]).join(',');
          insBlob.run(s.id, pts);
          ok++;
        }
      } catch (e) { fail++; }
    }));
    if ((i / BATCH) % 20 === 0) console.log(`[nightly] NAV progress: ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
    await sleep(200);
  }
  console.log(`[nightly] NAV refresh done: ${ok} updated, ${fail} failed`);
  
  // DUAL-SOURCE VERIFICATION (spec G-gates): sample cross-check against AMFI
  // NAVAll.txt (primary) for a slice of just-refreshed schemes.
  try {
    const dq = require('../db/dataQuality');
    const sample = targets.slice(0, 200);
    let verified = 0, mismatch = 0;
    for (const s of sample) {
      const blob = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?').get(s.id);
      if (!blob) continue;
      const series = navBlobToSeries(blob.points);
      const last = series[series.length - 1];
      if (!last) continue;
      const v = await dq.verifyNavCrossSource(s.id, s.schemeCode, last.nav, last.navDate);
      if (v.ok) verified++; else mismatch++;
    }
    console.log(`[nightly] dual-source NAV verify: ${verified} ok, ${mismatch} mismatched of ${sample.length} sampled`);
  } catch (e) { console.warn('[nightly] dual-source verify skipped:', e.message); }
}

// ── Step 2: recompute all period returns for every scheme ───────────────────
function recomputeReturns() {
  const dq = require('../db/dataQuality');
  const rows = db.prepare('SELECT schemeId, points FROM mutual_fund_nav_blob').all();
  let updated = 0, flagged = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const series = navBlobToSeries(row.points);
      if (series.length < 2) continue;
      delRet.run(row.schemeId);
      const latest = series[series.length - 1].navDate;
      const rets = {};
      for (const [period, days] of Object.entries(WINDOWS)) {
        let v;
        if (days === null) {
          const first = series[0], last = series[series.length - 1];
          if (first.nav > 0 && first.navDate !== last.navDate) v = (last.nav - first.nav) / first.nav * 100;
        } else v = trailingReturn(series, days);
        if (v != null && isFinite(v)) { insRet.run(row.schemeId, period, v, latest); rets[period] = v; }
      }
      // VALIDATION GATES before values are used in scoring
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
  console.log(`[nightly] returns recomputed for ${updated} schemes (${flagged} flagged by validation gates)`);
}

// ── Step 3: AUM + expense-ratio backfill from AMFI ──────────────────────────
function normName(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

async function backfillAumAndTer() {
  // AUM
  try {
    const missingAum = db.prepare(`
      SELECT COUNT(*) c FROM mutual_fund_schemes s
      WHERE NOT EXISTS (SELECT 1 FROM mutual_fund_aum a WHERE a.schemeId = s.id)
    `).get().c;
    if (missingAum > 50) {
      console.log(`[nightly] ${missingAum} schemes missing AUM — running AMFI backfill`);
      require(path.join(__dirname, 'backfillAumFromAmfi.js'));
    }
  } catch (e) { console.log('[nightly] AUM backfill error:', e.message); }

  // Expense ratio — only in the 4 PM..midnight half ( TER API is slow; once is enough)
  try {
    const missingEr = db.prepare('SELECT COUNT(*) c FROM mutual_fund_schemes WHERE expenseRatio IS NULL').get().c;
    if (missingEr > 50) {
      console.log(`[nightly] ${missingEr} schemes missing expense ratio — running TER backfill (background)`);
      const { spawn } = require('child_process');
      const month = String(new Date().getMonth() + 1).padStart(2, '0') + '-' + new Date().getFullYear();
      const child = spawn(process.execPath, [path.join(__dirname, 'backfillTerFromAmfi.js'), month], { detached: true, stdio: 'ignore' });
      child.unref();
    }
  } catch (e) { console.log('[nightly] TER backfill error:', e.message); }
}

// ── Main loop ────────────────────────────────────────────────────────────────
let lastRunDate = null;
async function maybeRun() {
  const now = new Date();
  const key = now.toISOString().slice(0, 10) + (now.getHours() < WINDOW_END_H ? '-early' : '');
  if (!inWindow(now) || lastRunDate === key) return;
  lastRunDate = key;
  console.log('='.repeat(60));
  console.log(`[nightly] starting nightly refresh at ${now.toLocaleString()}`);
  try {
    await refreshStaleNavs();
    recomputeReturns();
    await backfillAumAndTer();
  } catch (e) {
    console.log('[nightly] refresh error:', e.message);
  }
  console.log(`[nightly] refresh complete at ${new Date().toLocaleString()}. Next run: tomorrow's window (4 PM – 8:30 AM).`);
}

async function main() {
  // One-shot mode: `node scripts/nightlyMfRefresh.js --now` runs the full refresh
  // immediately regardless of the 4 PM–8:30 AM window, then exits.
  if (process.argv.includes('--now')) {
    console.log('[nightly] FORCED one-shot refresh (--now), ignoring window.');
    lastRunDate = 'forced';
    console.log('='.repeat(60));
    try {
      await refreshStaleNavs();
      recomputeReturns();
      await backfillAumAndTer();
    } catch (e) { console.log('[nightly] refresh error:', e.message); }
    console.log(`[nightly] forced refresh complete at ${new Date().toLocaleString()}`);
    process.exit(0);
  }
  console.log('[nightly] Mutual-fund nightly refresher started.');
  console.log('[nightly] Runs ONCE per day inside the 16:00–08:30 window. Keep this terminal open.');
  // run immediately if we're already inside the window
  await maybeRun();
  // check every 10 minutes
  setInterval(maybeRun, 10 * 60 * 1000);
}

main();
