/**
 * scripts/backfillTerFromAmfi.js
 *
 * Fills missing expenseRatio for mutual fund schemes using AMFI's TER
 * disclosure API (www.amfiindia.com/api/populate-te-rdata-revised).
 * Matches by normalized scheme name. Uses D_BER (direct) when present,
 * else R_TER.
 *
 * Usage: node scripts/backfillTerFromAmfi.js [month, default 08-2026]
 */
'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dbm = require('../db/mutualFunds');
const db = dbm.getDb();

const BASE = 'https://www.amfiindia.com/api/populate-te-rdata-revised';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\(erstwhile[^)]*\)/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function extractRows(j) {
  // Shape A: { data: [rows] }  (current AMFI response)
  if (j && Array.isArray(j.data)) return j.data;
  // Shape B: [ { data: [rows] } ]
  if (Array.isArray(j) && j[0] && j[0].data) {
    const inner = j[0].data;
    if (Array.isArray(inner)) return inner;
    if (inner && Array.isArray(inner.data)) return inner.data;
  }
  return null; // request rejected / empty
}

async function fetchTerForFund(mfId, month) {
  const out = [];
  const strTypes = ['1', '2'];
  for (const strType of strTypes) {
    let page = 1;
    while (true) {
      let rows = null, attempt = 0;
      while (attempt < 3 && rows === null) {
        try {
          const r = await axios.get(`${BASE}?MF_ID=${mfId}&Month=${month}&strCat=-1&strType=${strType}&page=${page}&pageSize=25`, { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
          rows = extractRows(r.data);
          if (rows === null) { rows = []; } // legit empty
        } catch (e) {
          attempt++;
          if (attempt >= 3) rows = [];
          else await sleep(3000);
        }
      }
      if (!rows.length) break;
      for (const row of rows) {
        if (!row.Scheme_Name) continue;
        // Use TOTAL TER (incl. brokerage/statutory levies) — matches what Groww/ET Money display
        const d = parseFloat(row.D_TER) || parseFloat(row.D_BER) || null;
        const r = parseFloat(row.R_TER) || parseFloat(row.R_BER) || null;
        if (d == null && r == null) continue;
        out.push({ name: row.Scheme_Name, code: row.NSDLSchemeCode, direct: d, regular: r });
      }
      page++;
      await sleep(700);
      if (page > 60) break;
    }
  }
  return out;
}

async function main() {
  const month = process.argv[2] || '08-2026';
  const overwriteAll = process.argv.includes('--all');
  const terByCode = {};   // NSDL code -> {direct, regular}
  const terByName = {};   // normalized name -> {direct, regular}
  let total = 0;
  for (const id of FUND_IDS_ITER()) {
    const rows = await fetchTerForFund(id, month);
    for (const r of rows) {
      const pair = { direct: r.direct, regular: r.regular };
      if (r.code) terByCode[r.code] = pair;
      terByName[norm(r.name)] = pair;
      total++;
    }
    if (rows.length) console.log(`[ter-backfill] MF_ID ${id}: ${rows.length} rows`);
  }
  console.log(`[ter-backfill] Total TER rows: ${total}`);

  const schemes = overwriteAll
    ? db.prepare("SELECT id, schemeCode, schemeName, plan FROM mutual_fund_schemes").all()
    : db.prepare("SELECT id, schemeCode, schemeName, plan FROM mutual_fund_schemes WHERE expenseRatio IS NULL").all();
  console.log(`[ter-backfill] Schemes to update: ${schemes.length}`);

  const upd = db.prepare('UPDATE mutual_fund_schemes SET expenseRatio = ?, terDirect = ?, terRegular = ? WHERE id = ?');
  let filled = 0, unfilled = 0;
  const txn = db.transaction(() => {
    for (const s of schemes) {
      const isDirect = /direct/i.test(s.schemeName || '') || /direct/i.test(s.plan || '');
      const pick = (p) => p ? (isDirect ? (p.direct != null ? p.direct : p.regular) : (p.regular != null ? p.regular : p.direct)) : null;
      const pair = s.schemeCode ? terByCode[s.schemeCode] : null;
      const pair2 = pair || terByName[norm(s.schemeName)] || null;
      let er = pick(pair);
      if (er == null) er = pick(terByName[norm(s.schemeName)]);
      if (er == null) {
        const key2 = norm((s.schemeName || '')
          .replace(/\s*-\s*direct plan.*$/i, '')
          .replace(/\s*-\s*regular plan.*$/i, '')
          .replace(/direct plan/gi, '')
          .replace(/regular plan/gi, '')
          .replace(/growth option/gi, '')
          .replace(/idcw option/gi, '')
          .replace(/\s*-\s*growth.*$/i, '')
          .replace(/\s*-\s*idcw.*$/i, ''));
        er = pick(terByName[key2]);
      }
      if (er != null) { upd.run(er, pair2 ? pair2.direct : null, pair2 ? pair2.regular : null, s.id); filled++; } else unfilled++;
    }
  });
  txn();
  console.log(`[ter-backfill] Filled ER for ${filled} schemes; ${unfilled} remain unmatched.`);
}

function FUND_IDS_ITER() {
  // Real house ids from AMFI's TER page (data/ter_mf_ids.json) — regenerate
  // anytime with: node scripts/fetchTerHouseIds.js
  const idsFile = path.join(__dirname, '..', 'data', 'ter_mf_ids.json');
  if (fs.existsSync(idsFile)) {
    const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8')).map(h => h.id);
    console.log(`[ter-backfill] Using ${ids.length} real house ids from ter_mf_ids.json`);
    return ids;
  }
  console.log('[ter-backfill] WARNING: ter_mf_ids.json missing — run scripts/fetchTerHouseIds.js. Falling back to 1-120.');
  const ids = [];
  for (let i = 1; i <= 120; i++) ids.push(i);
  return ids;
}

main().catch(e => { console.error('[ter-backfill] FAILED:', e.message); process.exit(1); });
