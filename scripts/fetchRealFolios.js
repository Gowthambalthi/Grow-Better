/**
 * scripts/fetchRealFolios.js
 * 
 * Fetches REAL per-scheme folio/investor counts from official AMC websites.
 * 
 * AMFI only provides category-level folio data (e.g., "Flexi Cap: 24.4 Cr folios
 * across 45 schemes"). To get scheme-level data, we must scrape individual AMC
 * websites or use Groww's SSR data.
 * 
 * Sources tried:
 * - AMFI MCR: Category-level only ❌
 * - mfapi.in: NAV only, no folio ❌
 * - Groww SSR: Works on Render, may have folio data ✅
 * - Individual AMC websites: Best source ✅
 * 
 * Usage: node scripts/fetchRealFolios.js
 */

'use strict';

const axios = require('axios');
const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'hdfc_mutual_funds.db');

/**
 * Fetch per-scheme folio data from Groww SSR for a given scheme
 */
async function fetchGrowwFolio(schemeCode, growwSlug) {
  if (!growwSlug) return null;
  
  try {
    const url = `https://groww.in/mutual-funds/${growwSlug}`;
    const res = await axios.get(url, {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return null;

    const nextData = JSON.parse(match[1]);
    const ss = nextData.props?.pageProps?.mfServerSideData;
    if (!ss) return null;

    // Deep search for folio/investor fields
    const found = {};
    function search(obj, path) {
      if (!obj || typeof obj !== 'object') return;
      for (const [k, v] of Object.entries(obj)) {
        const fp = path ? `${path}.${k}` : k;
        if (/folio|investor|holder|subscriber|account|num_fol/i.test(k)) {
          found[fp] = v;
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          search(v, fp);
        }
      }
    }
    search(ss, '');

    // Also check top-level for common field names
    const possibleFields = ['folio_count', 'total_folios', 'num_folios', 'investors',
      'investor_count', 'total_investors', 'folioCount', 'investorCount',
      'num_investors', 'total_accounts', 'scheme_folio', 'folios'];
    
    for (const field of possibleFields) {
      if (ss[field] !== undefined && ss[field] !== null) {
        found[`top.${field}`] = ss[field];
      }
    }

    return Object.keys(found).length > 0 ? found : null;
  } catch (e) {
    return null;
  }
}

/**
 * Main function
 */
async function main() {
  const db = new Database(DB_PATH);
  
  // Get all schemes with growwSlug
  const schemes = db.prepare(
    'SELECT id, schemeCode, schemeName, amc FROM mutual_fund_schemes WHERE status = ?'
  ).all('active');

  console.log(`Checking ${schemes.length} schemes for real folio data...`);
  
  // Test with a few known schemes
  const testSlugs = [
    { id: 'HDFC_118955', slug: 'hdfc-flexi-cap-fund-direct-growth' },
    { id: 'HDFC_118989', slug: 'hdfc-mid-cap-fund-direct-growth' },
    { id: 'HDFC_153861', slug: 'hdfc-small-cap-fund-direct-growth' },
    { id: 'SBI_148685', slug: 'sbi-magnum-mid-cap-fund-direct-growth' },
  ];

  for (const test of testSlugs) {
    console.log(`\nChecking ${test.id} (${test.slug})...`);
    const result = await fetchGrowwFolio(test.id.split('_')[1], test.slug);
    if (result) {
      console.log('Found folio data:', JSON.stringify(result, null, 2));
    } else {
      console.log('No folio data found');
    }
    // Small delay
    await new Promise(r => setTimeout(r, 1000));
  }

  db.close();
}

main().catch(console.error);
