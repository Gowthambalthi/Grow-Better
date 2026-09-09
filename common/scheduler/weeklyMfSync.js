/**
 * common/scheduler/weeklyMfSync.js
 *
 * Weekly new-fund check — runs Sunday 2:00 PM IST (after the app is running),
 * or on first app start each week if that slot was missed.
 *
 * What it does:
 *   1. Fetches AMFI's official NAVAll.txt master (all ~18k scheme rows).
 *   2. Upserts EVERY new scheme code not already in the DB — all categories,
 *      so new funds of any type appear in "all mutual funds" automatically.
 *   3. New large-cap funds are identified with the shared matcher
 *      (common/mf-engine/largeCapMatcher.js) and logged/counted explicitly.
 *
 * No values are fabricated: only rows AMFI actually publishes are imported.
 */
'use strict';

const axios = require('axios');
const path = require('path');
const { isLargeCapName } = require('../mf-engine/largeCapMatcher');

function amcToken(raw) {
  let t = (raw || '').replace(/mutual\s*fund/gi, '').trim();
  t = t.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return t || 'AMC';
}

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

/**
 * Fetch AMFI master and upsert any scheme codes missing from the DB.
 * @returns {Promise<{added: number, largeCapAdded: number, total: number}>}
 */
async function syncNewFunds() {
  const db = require('../../db/mutualFunds');
  console.log('[Weekly MF Sync] Fetching AMFI NAVAll.txt master...');
  const res = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 60000 });
  const lines = res.data.split('\n');

  let amc = '', header = '';
  const rows = [];
  for (const line of lines) {
    const l = line.trim().replace(/\r/g, '');
    if (!l) continue;
    if (l.startsWith('Open Ended Schemes') || l.startsWith('Close Ended Schemes')) { header = l; continue; }
    if (l.includes('Mutual Fund') && !l.includes(';')) { amc = l; continue; }
    if (l.includes(';')) {
      const p = l.split(';');
      if (p.length >= 7 && p[0] !== 'Scheme Code' && !isNaN(parseInt(p[0]))) {
        rows.push({
          schemeCode: p[0].trim(),
          isin: p[1] || '',
          schemeName: (p[3] || '').trim(),
          plan: (p[4] || '').trim(),
          option: (p[5] || '').trim(),
          amc,
          header,
        });
      }
    }
  }
  console.log(`[Weekly MF Sync] Parsed ${rows.length} AMFI rows`);

  const raw = db.getDb();
  const existing = new Set(
    raw.prepare('SELECT schemeCode FROM mutual_fund_schemes WHERE schemeCode IS NOT NULL')
      .all().map(r => r.schemeCode)
  );

  const fresh = rows.filter(r => !existing.has(r.schemeCode));
  if (!fresh.length) {
    console.log('[Weekly MF Sync] No new funds found. DB is current with AMFI master.');
    return { added: 0, largeCapAdded: 0, total: existing.size };
  }

  const upsert = db.upsertScheme.bind(db);
  let added = 0, largeCapAdded = 0;
  const seenCodes = new Set();

  for (const s of fresh) {
    if (seenCodes.has(s.schemeCode)) continue;
    seenCodes.add(s.schemeCode);
    const nameLc = s.schemeName.toLowerCase();
    const isLc = isLargeCapName(s.schemeName, s.header);
    // Card categories for matchable funds; SEBI family otherwise
    let category;
    if (isLc) category = 'Large Cap';
    else if (nameLc.indexOf('flexi cap') !== -1 || nameLc.indexOf('flexicap') !== -1) category = 'Flexi Cap';
    else if (nameLc.indexOf('small cap') !== -1 || nameLc.indexOf('smallcap') !== -1) category = 'Small Cap';
    else if (nameLc.indexOf('mid cap') !== -1 || nameLc.indexOf('midcap') !== -1) category = 'Mid Cap';
    else if (nameLc.indexOf('elss') !== -1 || nameLc.indexOf('tax saver') !== -1) category = 'ELSS';
    else if (nameLc.indexOf('index') !== -1 || nameLc.indexOf('etf') !== -1) category = 'Index';
    else category = sebiFamily(s.header);

    upsert({
      id: `${amcToken(s.amc)}_${s.schemeCode}`,
      schemeCode: s.schemeCode,
      schemeName: s.schemeName,
      amc: s.amc.replace(/Mutual\s*Fund/i, '').trim() || s.amc,
      category,
      plan: s.plan || 'Direct',
      option: s.option || 'Growth',
      isin: s.isin || null,
    });
    added++;
    if (isLc) largeCapAdded++;
  }

  console.log(`[Weekly MF Sync] Added ${added} new funds (${largeCapAdded} large-cap). Total schemes now: ${raw.prepare('SELECT COUNT(*) c FROM mutual_fund_schemes').get().c}`);
  return { added, largeCapAdded, total: raw.prepare('SELECT COUNT(*) c FROM mutual_fund_schemes').get().c };
}

module.exports = { syncNewFunds };
