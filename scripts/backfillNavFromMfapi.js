/**
 * Backfills NAV history (mutual_fund_nav) from api.mfapi.in for every scheme
 * that has zero NAV rows but a valid AMFI schemeCode. Then recomputes period
 * returns (1D/1W/1M/3M/6M/1Y/3Y/5Y) from the fetched history, replacing the
 * placeholder returns rows.
 *
 * Usage: node scripts/backfillNavFromMfapi.js
 */
const axios = require('axios');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toIso(dmy) {
  const [d, m, y] = dmy.split('-');
  return `${y}-${m}-${d}`;
}

function periodReturn(navMap, days) {
  const dates = Object.keys(navMap).sort();
  if (!dates.length) return null;
  const latest = dates[dates.length - 1];
  const latestNav = navMap[latest];
  if (latestNav == null || latestNav <= 0) return null;
  const target = new Date(latest);
  target.setDate(target.getDate() - days);
  const targetIso = target.toISOString().slice(0, 10);
  // nearest NAV on/before target date
  let baseNav = null;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (dates[i] <= targetIso) { baseNav = navMap[dates[i]]; break; }
  }
  if (baseNav == null || baseNav <= 0) return null;
  return ((latestNav - baseNav) / baseNav) * 100;
}

async function main() {
  const missing = db.prepare(`
    SELECT s.id, s.schemeCode, s.schemeName FROM mutual_fund_schemes s
    WHERE s.schemeCode IS NOT NULL AND s.schemeCode != ''
      AND NOT EXISTS (SELECT 1 FROM mutual_fund_nav n WHERE n.schemeId = s.id)
  `).all();
  console.log(`[nav-backfill] Schemes with no NAV history: ${missing.length}`);

  let ok = 0, fail = 0;
  const insBlob = db.prepare('INSERT OR REPLACE INTO mutual_fund_nav_blob (schemeId, points) VALUES (?, ?)');  const delRet = db.prepare('DELETE FROM mutual_fund_returns WHERE schemeId = ?');
  const insRet = db.prepare('INSERT INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source, createdAt) VALUES (?, ?, ?, ?, ?, ?)');

  const run = db.transaction((scheme) => {
    // scheme.navData set outside
  });

  for (const s of missing) {
    try {
      const r = await axios.get(`https://api.mfapi.in/mf/${s.schemeCode}`, { timeout: 20000 });
      const data = r.data && r.data.data;
      if (!data || !data.length) { fail++; continue; }
      const navMap = {};
      const now = new Date().toISOString();
      for (const p of data) {
        const iso = toIso(p.date);
        const nav = parseFloat(p.nav);
        if (!isFinite(nav)) continue;
        navMap[iso] = nav;
      }
      // store full history compactly (single row per scheme) + recompute returns
      const points = Object.keys(navMap).sort().map((iso) => iso + ':' + navMap[iso]).join(',');
      insBlob.run(s.id, JSON.stringify(points));
      delRet.run(s.id);
      const periods = { '1D': 1, '1W': 7, '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095, '5Y': 1825 };
      const latest = Object.keys(navMap).sort().pop();
      for (const [p, d] of Object.entries(periods)) {
        const v = periodReturn(navMap, d);
        if (v != null) insRet.run(s.id, p, v, latest, 'mfapi-derived', now);
      }
      ok++;
      if (ok % 25 === 0) console.log(`[nav-backfill] ${ok} done...`);
      await sleep(350); // be polite to the free API
    } catch (e) {
      fail++;
      if (fail % 25 === 0) console.log(`[nav-backfill] failures so far: ${fail} (${e.message})`);
      await sleep(500);
    }
  }
  console.log(`[nav-backfill] Complete: ${ok} schemes got NAV history, ${fail} failed/skipped.`);
}

main();
