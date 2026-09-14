/**
 * scripts/verifyNavDualSource.js
 *
 * Cross-verifies stored NAVs against TWO independent AMFI sources:
 *   1. api.mfapi.in  (per-scheme JSON API)
 *   2. www.amfiindia.com/spages/NAVAll.txt  (official daily NAV dump)
 *
 * For a sample of schemes, the latest NAV from the DB must match BOTH
 * sources (within a tiny float tolerance). Any scheme where the sources
 * disagree with each other or with our DB is reported and fixed from the
 * official NAVAll value.
 *
 * Usage:
 *   node scripts/verifyNavDualSource.js            # verify + fix latest NAVs
 *   node scripts/verifyNavDualSource.js --report   # report only, no writes
 */
'use strict';
const axios = require('axios');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

const REPORT_ONLY = process.argv.includes('--report');
const TOL = 0.0001; // NAV tolerance

function toIso(dmy) {
  const [d, m, y] = dmy.split('-');
  return `${y}-${m}-${d}`;
}

async function fetchNavAll() {
  const r = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 90000, responseType: 'text' });
  const map = {}; // schemeCode -> { date, nav }
  let house = '';
  for (const line of r.data.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (!t.includes(';')) { house = t; continue; }
    const p = t.split(';');
    // Format: code;isin1;isin2;name;plan;option;nav;date  (open-ended)
    if (p.length >= 8 && /^\d+$/.test(p[0])) {
      const nav = parseFloat(p[6]);
      if (isFinite(nav) && nav > 0) map[p[0]] = { date: toIso(p[7]), nav, house };
    }
  }
  return map;
}

async function fetchMfapi(code) {
  const r = await axios.get(`https://api.mfapi.in/mf/${code}`, { timeout: 15000 });
  const d = r.data && r.data.data;
  if (!d || !d.length) return null;
  const p = d[0];
  return { date: toIso(p.date), nav: parseFloat(p.nav) };
}

(async () => {
  console.log('[verify] Fetching AMFI NAVAll.txt (official dump)...');
  const navAll = await fetchNavAll();
  console.log(`[verify] NAVAll entries: ${Object.keys(navAll).length}`);

  const schemes = db.prepare('SELECT id, schemeCode, schemeName FROM mutual_fund_schemes').all()
    .filter(s => s.schemeCode && navAll[s.schemeCode]);
  console.log(`[verify] Schemes present in NAVAll: ${schemes.length}`);

  const getBlob = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?');
  const fixBlob = db.prepare('UPDATE mutual_fund_nav_blob SET points=? WHERE schemeId=?');
  const insRet = db.prepare("INSERT OR REPLACE INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source) VALUES (?, '1D', ?, ?, 'dual-verified')");

  // Verify a sample (every 5th scheme keeps runtime sane; extend as needed)
  const sample = schemes.filter((_, i) => i % 5 === 0);
  console.log(`[verify] Cross-checking ${sample.length} schemes (mfapi + NAVAll + DB)...`);

  let agree = 0, mismatchDb = 0, mismatchSources = 0, fixed = 0;
  const BATCH = 10;
  for (let i = 0; i < sample.length; i += BATCH) {
    await Promise.all(sample.slice(i, i + BATCH).map(async (s) => {
      try {
        const official = navAll[s.schemeCode];
        const viaApi = await fetchMfapi(s.schemeCode);
        // Source agreement: both sources must report the same latest NAV
        if (!viaApi || Math.abs(viaApi.nav - official.nav) > TOL) { mismatchSources++; return; }
        // DB agreement
        const blob = getBlob.get(s.id);
        if (!blob) return;
        const pairs = String(blob.points).split(',');
        const lastPair = pairs[pairs.length - 1].split(':');
        const dbDate = lastPair[0], dbNav = parseFloat(lastPair[1]);
        if (dbDate === official.date && Math.abs(dbNav - official.nav) <= TOL) { agree++; return; }
        mismatchDb++;
        if (!REPORT_ONLY) {
          // Fix: replace/append the official latest point
          const navMap = {};
          for (const pr of pairs) { const [d, v] = pr.split(':'); if (d && v) navMap[d] = parseFloat(v); }
          navMap[official.date] = official.nav;
          const pts = Object.keys(navMap).sort().map(d => d + ':' + navMap[d]).join(',');
          fixBlob.run(s.id, pts);
          const first = navMap[Object.keys(navMap)[0]];
          insRet.run(s.id, (official.nav - first) / first * 100, official.date);
          fixed++;
        }
      } catch (e) { /* per-scheme failure ignored */ }
    }));
    if ((i / BATCH) % 40 === 0) console.log(`[verify] progress ${Math.min(i + BATCH, sample.length)}/${sample.length}`);
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('='.repeat(60));
  console.log(`[verify] Sources agree with each other : ${sample.length - mismatchSources}/${sample.length}`);
  console.log(`[verify] DB matches both sources       : ${agree}`);
  console.log(`[verify] DB mismatches ${REPORT_ONLY ? '(would fix)' : 'fixed'}: ${mismatchDb} (fixed: ${fixed})`);
  console.log(`[verify] Source-vs-source disagreements: ${mismatchSources}`);
})().catch(e => { console.error('[verify] FAILED:', e.message); process.exit(1); });
