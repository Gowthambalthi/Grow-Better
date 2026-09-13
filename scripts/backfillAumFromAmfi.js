/**
 * scripts/backfillAumFromAmfi.js
 *
 * Fills missing AUM rows (mutual_fund_aum) for ALL schemes using AMFI's
 * scheme-wise Average AUM API (www.amfiindia.com/api/average-aum-schemewise).
 * Matches by normalized SchemeNAVName and AMFI_Code where possible.
 *
 * Usage: node scripts/backfillAumFromAmfi.js
 */
'use strict';

const axios = require('axios');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

const API = 'https://www.amfiindia.com/api/average-aum-schemewise?strType=Typewise&fyId=1&periodId=1&MF_ID=';

function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\(erstwhile[^)]*\)/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function fetchAllFundAum() {
  // Discover fund-house ids from the fundwise periods endpoint trick: ids 1..70
  const map = { byCode: {}, byName: {} };
  let total = 0;
  for (let id = 1; id <= 120; id++) {
    let rows;
    try {
      const r = await axios.get(API + id, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const d = r.data && r.data.data;
      if (!Array.isArray(d)) continue;
      rows = [];
      for (const grp of d) {
        for (const s of (grp.schemes || [])) {
          const aumObj = s.AverageAumForTheMonth || {};
          const aum = aumObj.ExcludingFundOfFundsDomesticButIncludingFundOfFundsOverseas || aumObj.FundOfFundsDomestic || 0;
          if (aum > 0 && s.SchemeNAVName) {
            rows.push({ name: s.SchemeNAVName, code: s.AMFI_Code, aum });
          }
        }
      }
    } catch (e) { continue; }
    for (const row of rows) {
      if (row.code) map.byCode[row.code] = row.aum;
      map.byName[norm(row.name)] = row.aum;
      total++;
    }
    if (rows.length) console.log(`[backfill] MF_ID ${id}: ${rows.length} schemes`);
  }
  console.log(`[backfill] Total AMFI AAUM entries: ${total}`);
  return map;
}

async function main() {
  const aumMap = await fetchAllFundAum();

  const schemes = db.prepare('SELECT id, schemeCode, schemeName, plan, option FROM mutual_fund_schemes').all();
  const hasAum = new Set(db.prepare('SELECT schemeId FROM mutual_fund_aum').all().map(r => r.schemeId));
  const missing = schemes.filter(s => !hasAum.has(s.id));
  console.log(`[backfill] Schemes missing AUM: ${missing.length} / ${schemes.length}`);

  const today = new Date().toISOString().slice(0, 10);
  const upsert = dbm.upsertAum;
  const aumSnapshot = db.prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?, ?, ?, ?)');
  let filled = 0, unfilled = 0;

  const txn = db.transaction(() => {
    for (const s of missing) {
      // 1) match by AMFI scheme code
      let aum = s.schemeCode ? aumMap.byCode[s.schemeCode] : null;
      // 2) match by normalized full NAV name
      if (aum == null) aum = aumMap.byName[norm(s.schemeName)];
      // 3) strip plan/option suffixes from our name
      if (aum == null) {
        const key2 = norm((s.schemeName || '')
          .replace(/\s*-\s*direct plan.*$/i, '')
          .replace(/\s*-\s*regular plan.*$/i, '')
          .replace(/direct plan/gi, '')
          .replace(/regular plan/gi, '')
          .replace(/growth option/gi, '')
          .replace(/idcw option/gi, '')
          .replace(/\s*-\s*growth.*$/i, '')
          .replace(/\s*-\s*idcw.*$/i, ''));
        aum = aumMap.byName[key2];
      }
      if (aum != null) {
        // AMFI AAUM is in Rs. Crores already
        upsert({ schemeId: s.id, aum: aum, asOfDate: today, source: 'amfi-aaum' });
        aumSnapshot.run(s.id, aum, today, 'amfi-aaum');
        filled++;
      } else unfilled++;
    }
  });
  txn();
  console.log(`[backfill] Filled AUM for ${filled} schemes; ${unfilled} remain unmatched (retired funds, NFOs, ETFs not in the AAUM list).`);
}

main().catch(e => { console.error('[backfill] FAILED:', e.message); process.exit(1); });
