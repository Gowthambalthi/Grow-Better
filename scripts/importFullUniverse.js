#!/usr/bin/env node
/**
 * scripts/importFullUniverse.js
 *
 * Import the ENTIRE AMFI NAVAll universe — every scheme row (~14.3k) across
 * all ~52 AMCs and all plan/option variants, no caps.
 *
 * Category assignment:
 *   - Schemes matching one of the 7 Smart Money cards get that card as category
 *     (Large Cap / Flexi Cap / Small Cap / Index / ELSS / Money Market / Commodities)
 *   - Everything else gets its SEBI family from the AMFI header
 *     (Equity / Debt / Hybrid / Index / ETF / FoF / Commodities / Other)
 *
 * Runs as: node scripts/importFullUniverse.js
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const axios = require('axios');

const DB_PATH = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ─── Card category detection (matches frontend card keys) ───────────────────
const CARDS = [
  { key: 'Large Cap',   match: n => n.indexOf('large cap') !== -1 || n.indexOf('bluechip') !== -1 || n.indexOf('top 100') !== -1 },
  { key: 'Flexi Cap',   match: n => n.indexOf('flexi cap') !== -1 || n.indexOf('flexicap') !== -1 },
  { key: 'Small Cap',   match: n => n.indexOf('small cap') !== -1 || n.indexOf('smallcap') !== -1 },
  { key: 'Index',       match: n => n.indexOf('index') !== -1 || n.indexOf('etf') !== -1 },
  { key: 'ELSS',        match: n => n.indexOf('elss') !== -1 || n.indexOf('tax saver') !== -1 || n.indexOf('80c') !== -1 },
  { key: 'Money Market', match: n => n.indexOf('money market') !== -1 || n.indexOf('liquid') !== -1 || n.indexOf('overnight') !== -1 },
  { key: 'Commodities', match: n => n.indexOf('gold') !== -1 || n.indexOf('silver') !== -1 || n.indexOf('commodit') !== -1 },
];

// AMFI header -> SEBI family for non-card schemes
function sebiFamily(header) {
  const h = header || '';
  if (h.indexOf('Equity Scheme') !== -1 || h.indexOf('Equity Schemes') !== -1 || h.indexOf('ELSS') !== -1) return 'Equity';
  if (h.indexOf('Debt Scheme') !== -1 || h.indexOf('Income/Debt') !== -1) return 'Debt';
  if (h.indexOf('Hybrid') !== -1) return 'Hybrid';
  if (h.indexOf('Index Funds') !== -1 || h.indexOf('Index Fund') !== -1) return 'Index';
  if (h.indexOf('ETF') !== -1) return 'ETF';
  if (h.indexOf('FoF') !== -1 || h.indexOf('Fund of Funds') !== -1 || h.indexOf('Fund Of Funds') !== -1) return 'FoF';
  if (h.indexOf('Commod') !== -1 || h.indexOf('Gold') !== -1 || h.indexOf('Silver') !== -1) return 'Commodities';
  return 'Other';
}

// Normalize AMC name -> id token (uppercase, underscore-separated)
function amcToken(raw) {
  let t = (raw || '').replace(/mutual\s*fund/gi, '').trim();
  t = t.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return t || 'AMC';
}

async function main() {
  console.log('[ImportFullUniverse] Fetching AMFI NAVAll.txt...');
  const res = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 60000 });
  const lines = res.data.split('\n');

  let amc = '', header = '';
  const rawSchemes = [];
  for (const line of lines) {
    const l = line.trim().replace(/\r/g, '');
    if (!l) continue;
    if (l.startsWith('Open Ended Schemes') || l.startsWith('Close Ended Schemes')) { header = l; continue; }
    if (l.includes('Mutual Fund') && !l.includes(';')) { amc = l; continue; }
    if (l.includes(';')) {
      const p = l.split(';');
      if (p.length >= 7 && p[0] !== 'Scheme Code' && !isNaN(parseInt(p[0]))) {
        rawSchemes.push({
          schemeCode: p[0].trim(),
          isin: p[1] || '',
          schemeName: (p[3] || '').trim(),
          plan: (p[4] || '').trim(),
          option: (p[5] || '').trim(),
          nav: parseFloat(p[6]),
          navDate: (p[7] || '').trim().replace(/\r/g, ''),
          amc,
          header,
        });
      }
    }
  }
  console.log(`[ImportFullUniverse] Parsed ${rawSchemes.length} scheme rows, ${new Set(rawSchemes.map(s => s.amc)).size} AMCs`);

  // Existing ids by schemeCode (reuse to avoid dupes)
  const existingByCode = new Map();
  for (const r of db.prepare('SELECT id, schemeCode FROM mutual_fund_schemes WHERE schemeCode IS NOT NULL').all()) {
    if (r.schemeCode && !existingByCode.has(r.schemeCode)) existingByCode.set(r.schemeCode, r.id);
  }
  console.log(`[ImportFullUniverse] Existing schemeCodes in DB: ${existingByCode.size}`);

  // Assign category: card key if matched, else SEBI family
  let cardAssigned = 0;
  const withCategory = rawSchemes.map(s => {
    const name = s.schemeName.toLowerCase();
    let cat = null;
    for (const c of CARDS) {
      if (c.match(name)) { cat = c.key; cardAssigned++; break; }
    }
    if (!cat) cat = sebiFamily(s.header);
    return { ...s, category: cat };
  });

  // Category tally
  const tally = {};
  for (const s of withCategory) tally[s.category] = (tally[s.category] || 0) + 1;
  console.log('[ImportFullUniverse] Category tally (card-assigned: ' + cardAssigned + '):');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(k).padEnd(14)} ${v}`);
  }

  // Upsert all
  const upsert = db.prepare(`
    INSERT INTO mutual_fund_schemes (id, schemeCode, schemeName, amc, category, plan, option, isin, status, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      schemeCode = excluded.schemeCode,
      schemeName = excluded.schemeName,
      amc = excluded.amc,
      category = excluded.category,
      plan = excluded.plan,
      option = excluded.option,
      isin = excluded.isin,
      status = 'active',
      updatedAt = datetime('now')
  `);

  let inserted = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const s of withCategory) {
      const id = existingByCode.get(s.schemeCode) || `${amcToken(s.amc)}_${s.schemeCode}`;
      const info = upsert.run(id, s.schemeCode, s.schemeName, s.amc.replace(/Mutual\s*Fund/i, '').trim() || s.amc, s.category, s.plan || 'Direct', s.option || 'Growth', s.isin || null);
      if (info.changes > 0) {
        if (existingByCode.has(s.schemeCode)) updated++; else inserted++;
        existingByCode.set(s.schemeCode, id);
      }
    }
  });
  tx();

  const total = db.prepare('SELECT COUNT(*) c FROM mutual_fund_schemes').get().c;
  console.log(`[ImportFullUniverse] Done: ${inserted} new, ${updated} existing touched. Total schemes now: ${total}`);
  db.close();
}

if (require.main === module) {
  main().catch(e => { console.error('Import failed:', e); process.exit(1); });
}