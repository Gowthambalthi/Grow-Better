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
  // Shape 1: { data: [ { data: [rows], meta } ] }
  if (Array.isArray(j) && j[0] && j[0].data) {
    const inner = j[0].data;
    if (Array.isArray(inner)) return inner;
    if (inner && Array.isArray(inner.data)) return inner.data;
  }
  // Shape 2: { data: [rows] }
  if (j && Array.isArray(j.data)) return j.data;
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
        const er = parseFloat(row.D_BER) || parseFloat(row.R_BER) || parseFloat(row.D_TER) || parseFloat(row.R_TER) || null;
        if (er && row.Scheme_Name) out.push({ name: row.Scheme_Name, code: row.NSDLSchemeCode, er });
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
  const terByCode = {};
  const terByName = {};
  let total = 0;
  for (const id of FUND_IDS_ITER()) {
    const rows = await fetchTerForFund(id, month);
    for (const r of rows) {
      if (r.code) terByCode[r.code] = r.er;
      terByName[norm(r.name)] = r.er;
      total++;
    }
    if (rows.length) console.log(`[ter-backfill] MF_ID ${id}: ${rows.length} rows`);
  }
  console.log(`[ter-backfill] Total TER rows: ${total}`);

  const schemes = db.prepare("SELECT id, schemeCode, schemeName FROM mutual_fund_schemes WHERE expenseRatio IS NULL").all();
  console.log(`[ter-backfill] Schemes missing ER: ${schemes.length}`);

  const upd = db.prepare('UPDATE mutual_fund_schemes SET expenseRatio = ? WHERE id = ?');
  let filled = 0, unfilled = 0;
  const txn = db.transaction(() => {
    for (const s of schemes) {
      let er = s.schemeCode ? terByCode[s.schemeCode] : null;
      if (er == null) er = terByName[norm(s.schemeName)];
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
        er = terByName[key2];
      }
      if (er != null) { upd.run(er, s.id); filled++; } else unfilled++;
    }
  });
  txn();
  console.log(`[ter-backfill] Filled ER for ${filled} schemes; ${unfilled} remain unmatched.`);
}

function FUND_IDS_ITER() {
  const ids = [];
  for (let i = 1; i <= 120; i++) ids.push(i);
  return ids;
}

main().catch(e => { console.error('[ter-backfill] FAILED:', e.message); process.exit(1); });
