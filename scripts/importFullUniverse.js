#!/usr/bin/env node
/**
 * scripts/importFullUniverse.js
 *
 * Import the FULL AMFI NAVAll universe (all ~52 AMCs, all plan/option variants)
 * for the 7 Smart Money category cards, capped per card at the target counts:
 *   Large Cap 200, Flexi Cap 200, Small Cap 200, Index 200, ELSS 150,
 *   Money Market 150, Commodities 50+.
 *
 * Priority order per category: Direct Growth first, then Direct IDCW,
 * Regular Growth, Regular IDCW — so caps fill with the most useful variants.
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
// Each card: key, cap, name-matching tokens (lowercase)
const CARDS = [
  { key: 'Large Cap',   cap: 200, match: n => n.indexOf('large cap') !== -1 || n.indexOf('bluechip') !== -1 || n.indexOf('top 100') !== -1 },
  { key: 'Flexi Cap',   cap: 200, match: n => n.indexOf('flexi cap') !== -1 || n.indexOf('flexicap') !== -1 },
  { key: 'Small Cap',   cap: 200, match: n => n.indexOf('small cap') !== -1 || n.indexOf('smallcap') !== -1 },
  { key: 'Index',       cap: 200, match: n => n.indexOf('index') !== -1 || n.indexOf('etf') !== -1 },
  { key: 'ELSS',        cap: 150, match: n => n.indexOf('elss') !== -1 || n.indexOf('tax saver') !== -1 || n.indexOf('80c') !== -1 },
  { key: 'Money Market', cap: 150, match: n => n.indexOf('money market') !== -1 || n.indexOf('liquid') !== -1 || n.indexOf('overnight') !== -1 },
  { key: 'Commodities', cap: 60,  match: n => n.indexOf('gold') !== -1 || n.indexOf('silver') !== -1 || n.indexOf('commodit') !== -1 },
];

// Variant priority: Direct Growth best
function variantRank(plan, option) {
  const p = (plan || '').toLowerCase();
  const o = (option || '').toLowerCase();
  const direct = p.indexOf('direct') !== -1;
  const growth = o.indexOf('growth') !== -1;
  if (direct && growth) return 0;
  if (direct) return 1;                 // Direct IDCW
  if (growth) return 2;                 // Regular Growth
  return 3;                             // Regular IDCW
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

  let amc = '', category = '';
  const rawSchemes = [];
  for (const line of lines) {
    const l = line.trim().replace(/\r/g, '');
    if (!l) continue;
    if (l.startsWith('Open Ended Schemes') || l.startsWith('Close Ended Schemes')) { category = l; continue; }
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
          amfiCategory: category,
        });
      }
    }
  }
  console.log(`[ImportFullUniverse] Parsed ${rawSchemes.length} scheme rows, ${new Set(rawSchemes.map(s => s.amc)).size} AMCs`);

  // Existing ids by schemeCode (so we reuse the same id for schemes already in DB)
  const existingByCode = new Map();
  for (const r of db.prepare('SELECT id, schemeCode FROM mutual_fund_schemes WHERE schemeCode IS NOT NULL').all()) {
    if (r.schemeCode && !existingByCode.has(r.schemeCode)) existingByCode.set(r.schemeCode, r.id);
  }
  console.log(`[ImportFullUniverse] Existing schemeCodes in DB: ${existingByCode.size}`);

  // Map each scheme to its card (a scheme may match multiple cards — pick first in card order)
  const cardOf = {};
  const cardBuckets = {};
  for (const c of CARDS) cardBuckets[c.key] = [];
  const unmatched = [];

  for (const s of rawSchemes) {
    const name = s.schemeName.toLowerCase();
    let assigned = null;
    for (const c of CARDS) {
      if (c.match(name)) { assigned = c.key; break; }
    }
    if (!assigned) { unmatched.push(s); continue; }
    s.card = assigned;
    cardBuckets[assigned].push(s);
  }

  // Cap each bucket with variant priority
  const selected = [];
  let cardStats = [];
  for (const c of CARDS) {
    const bucket = cardBuckets[c.key] || [];
    bucket.sort((a, b) => {
      const r = variantRank(a.plan, a.option) - variantRank(b.plan, b.option);
      if (r !== 0) return r;
      return a.schemeName.localeCompare(b.schemeName);
    });
    const take = bucket.slice(0, c.cap);
    selected.push(...take);
    cardStats.push(`${c.key}=${take.length}/${bucket.length}`);
  }
  console.log('[ImportFullUniverse] Card buckets:', cardStats.join('  '));
  console.log('[ImportFullUniverse] Total to import:', selected.length, '| unmatched (non-card):', unmatched.length);

  // Upsert
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
    for (const s of selected) {
      // Prefer existing id by schemeCode to avoid dupes
      const id = existingByCode.get(s.schemeCode) || `${amcToken(s.amc)}_${s.schemeCode}`;
      const info = upsert.run(id, s.schemeCode, s.schemeName, s.amc.replace(/Mutual\s*Fund/i, '').trim() || s.amc, s.card, s.plan || 'Direct', s.option || 'Growth', s.isin || null);
      if (info.changes > 0) {
        if (existingByCode.has(s.schemeCode)) updated++; else inserted++;
        existingByCode.set(s.schemeCode, id);
      }
    }
  });
  tx();

  const total = db.prepare('SELECT COUNT(*) c FROM mutual_fund_schemes').get().c;
  console.log(`[ImportFullUniverse] Done: ${inserted} new, ${updated} existing touched. Total schemes now: ${total}`);

  // Verify per-card real counts using same matcher as frontend (category + name)
  const all = db.prepare('SELECT id, schemeName, category FROM mutual_fund_schemes').all();
  console.log('--- Real per-card counts after import (frontend matcher) ---');
  for (const c of CARDS) {
    let n = 0;
    for (const s of all) {
      const lc = (s.category || '').toLowerCase() + ' ' + (s.schemeName || '').toLowerCase();
      if (c.match(lc)) n++;
    }
    console.log(`  ${c.key.padEnd(13)} ${n}`);
  }
  db.close();
}

if (require.main === module) {
  main().catch(e => { console.error('Import failed:', e); process.exit(1); });
}