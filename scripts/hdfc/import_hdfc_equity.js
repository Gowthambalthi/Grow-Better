/**
 * scripts/hdfc/import_hdfc_equity.js
 * 
 * HDFC Equity Mutual Fund Data Pipeline
 * ======================================
 * 
 * Sources:
 *   - Holdings:  HDFC S3 monthly portfolio xlsx (https://www.hdfcfund.com/statutory-disclosure/monthly-portfolio)
 *   - NAV/1Y:    AMFI NAVAll.txt + api.mfapi.in for NAV history
 *   - AUM/Investors: HDFC xlsx files contain portfolio date; mfapi.in meta has AUM/folios
 * 
 * Run: node scripts/hdfc/import_hdfc_equity.js
 * Safe to run multiple times (upsert idempotent).
 */

'use strict';
const axios = require('axios');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_FILE = path.join(DATA_DIR, 'hdfc_equity_funds.json');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

// ─── 21 HDFC Equity Funds we want (Direct Growth scheme codes from AMFI) ───
// These are the AMFI scheme codes for HDFC equity Direct Growth plans.
// Mapped from AMFI NAVAll.txt test run above.
const HDFC_EQUITY_SCHEMES = [
  { schemeId: 'HDFC_FLEXI_CAP',        schemeName: 'HDFC Flexi Cap Fund',                       amfiCode: 118955, plan: 'Direct', option: 'Growth', category: 'Equity: Flexi Cap' },
  { schemeId: 'HDFC_MID_CAP',          schemeName: 'HDFC Mid Cap Opportunities Fund',             amfiCode: 118989, plan: 'Direct', option: 'Growth', category: 'Equity: Mid Cap' },
  { schemeId: 'HDFC_SMALL_CAP',        schemeName: 'HDFC Small Cap Fund',                        amfiCode: 118990, plan: 'Direct', option: 'Growth', category: 'Equity: Small Cap' },
  { schemeId: 'HDFC_LARGE_CAP',        schemeName: 'HDFC Large Cap Fund',                        amfiCode: 119018, plan: 'Direct', option: 'Growth', category: 'Equity: Large Cap' },
  { schemeId: 'HDFC_LARGE_MID_CAP',   schemeName: 'HDFC Large and Mid Cap Fund',                amfiCode: 119019, plan: 'Direct', option: 'Growth', category: 'Equity: Large & MidCap' },
  { schemeId: 'HDFC_MULTI_CAP',        schemeName: 'HDFC Multi Cap Fund',                        amfiCode: 149368, plan: 'Direct', option: 'Growth', category: 'Equity: Multi Cap' },
  { schemeId: 'HDFC_FOCUSED_FUND',     schemeName: 'HDFC Focused Fund',                          amfiCode: 118950, plan: 'Direct', option: 'Growth', category: 'Equity: Focused' },
  { schemeId: 'HDFC_ELSS',             schemeName: 'HDFC ELSS Tax Saver',                        amfiCode: 118959, plan: 'Direct', option: 'Growth', category: 'Equity: ELSS' },
  { schemeId: 'HDFC_DIVIDEND_YIELD',   schemeName: 'HDFC Dividend Yield Fund',                   amfiCode: 148609, plan: 'Direct', option: 'Growth', category: 'Equity: Dividend Yield' },
  { schemeId: 'HDFC_VALUE',            schemeName: 'HDFC Value Fund',                            amfiCode: 118965, plan: 'Direct', option: 'Growth', category: 'Equity: Value' },
  { schemeId: 'HDFC_CONTRA',           schemeName: 'HDFC Contra Fund',                           amfiCode: 118956, plan: 'Direct', option: 'Growth', category: 'Equity: Contra' },
  { schemeId: 'HDFC_BANKING_FS',       schemeName: 'HDFC Banking & Financial Services Fund',     amfiCode: 148987, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - BFSI' },
  { schemeId: 'HDFC_PHARMA',           schemeName: 'HDFC Pharma and Healthcare Fund',            amfiCode: 152200, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Pharma' },
  { schemeId: 'HDFC_TECHNOLOGY',       schemeName: 'HDFC Technology Fund',                       amfiCode: 152201, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Technology' },
  { schemeId: 'HDFC_INFRA',            schemeName: 'HDFC Infrastructure Fund',                   amfiCode: 118970, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Infrastructure' },
  { schemeId: 'HDFC_TRANSPORTATION',   schemeName: 'HDFC Transportation and Logistics Fund',     amfiCode: 152430, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Transportation' },
  { schemeId: 'HDFC_DEFENCE',          schemeName: 'HDFC Defence Fund',                          amfiCode: 153165, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Defence' },
  { schemeId: 'HDFC_MANUFACTURING',    schemeName: 'HDFC Manufacturing Fund',                    amfiCode: 152800, plan: 'Direct', option: 'Growth', category: 'Equity: Sectoral - Manufacturing' },
  { schemeId: 'HDFC_MF_AGRI',          schemeName: 'HDFC Agriculture and IT Offshore FoF',       amfiCode: null, plan: 'Direct', option: 'Growth', category: 'Equity: FoF' },
  { schemeId: 'HDFC_NIFTY50_INDEX',    schemeName: 'HDFC Nifty 50 Index Fund',                   amfiCode: 119101, plan: 'Direct', option: 'Growth', category: 'Equity: Index - Nifty 50' },
  { schemeId: 'HDFC_NIFTY_NEXT50',     schemeName: 'HDFC Nifty Next 50 Index Fund',              amfiCode: 119102, plan: 'Direct', option: 'Growth', category: 'Equity: Index - Nifty Next 50' },
];

// Keywords to match scheme names in Excel filenames from HDFC's monthly portfolio page
const SCHEME_FILE_KEYWORDS = {
  'HDFC_FLEXI_CAP':       ['Flexi Cap'],
  'HDFC_MID_CAP':         ['Mid Cap'],
  'HDFC_SMALL_CAP':       ['Small Cap'],
  'HDFC_LARGE_CAP':       ['Large Cap'],
  'HDFC_LARGE_MID_CAP':  ['Large and Mid', 'Large & Mid'],
  'HDFC_MULTI_CAP':       ['Multi Cap'],
  'HDFC_FOCUSED_FUND':    ['Focused Fund'],
  'HDFC_ELSS':            ['ELSS', 'Tax Saver'],
  'HDFC_DIVIDEND_YIELD':  ['Dividend Yield'],
  'HDFC_VALUE':           ['Value Fund'],
  'HDFC_CONTRA':          ['Contra Fund'],
  'HDFC_BANKING_FS':      ['Banking', 'Financial Services'],
  'HDFC_PHARMA':          ['Pharma', 'Healthcare'],
  'HDFC_TECHNOLOGY':      ['Technology Fund'],
  'HDFC_INFRA':           ['Infrastructure Fund'],
  'HDFC_TRANSPORTATION':  ['Transportation', 'Logistics'],
  'HDFC_DEFENCE':         ['Defence Fund'],
  'HDFC_MANUFACTURING':   ['Manufacturing Fund'],
  'HDFC_NIFTY50_INDEX':   ['Nifty 50 Index'],
  'HDFC_NIFTY_NEXT50':    ['Nifty Next 50'],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
  return { schemes: {}, lastUpdated: null };
}

function saveDb(db) {
  db.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// ─── Stage 1: Discover all HDFC monthly portfolio xlsx files ───────────────
async function discoverHdfcMonthlyFiles() {
  console.log('\n[Stage 1] Discovering HDFC monthly portfolio xlsx files...');
  const pageUrl = 'https://www.hdfcfund.com/statutory-disclosure/monthly-portfolio';
  const reqHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  const r = await axios.get(pageUrl, { timeout: 12000, headers: reqHeaders });
  // Extract all unique s3fs-public urls
  const raw = r.data.match(/files\.hdfcfund\.com\/s3fs-public\/[^\s"'<>]+\.xlsx/gi) || [];
  const unique = [...new Set(raw)].map(u => 'https://' + u);
  console.log(`  Found ${unique.length} xlsx files on HDFC S3 (monthly portfolio page)`);
  return unique;
}

// Match a file URL to one of our equity scheme IDs
function matchFileToScheme(fileUrl) {
  const decoded = decodeURIComponent(fileUrl);
  for (const [schemeId, keywords] of Object.entries(SCHEME_FILE_KEYWORDS)) {
    for (const kw of keywords) {
      if (decoded.toLowerCase().includes(kw.toLowerCase())) {
        return schemeId;
      }
    }
  }
  return null;
}

// ─── Stage 2: Parse one xlsx file → holdings array ─────────────────────────
function parseHoldingsXlsx(buffer, fileUrl) {
  try {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    if (!wb.SheetNames || wb.SheetNames.length === 0) return null;
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length < 6) return null;

    // Row 0: scheme name, Row 1: portfolio date, Row 4: headers, Row 5+: data
    const rawSchemeName = (rows[0] && rows[0][0]) ? rows[0][0].toString().trim() : null;
    let portfolioDate = null;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const cell = (rows[i] || []).join(' ');
      const dm = cell.match(/(\d{1,2}[-\/]\w+[-\/]\d{2,4}|\w+ \d{4}|\d{4}-\d{2}-\d{2})/i);
      if (dm) { portfolioDate = dm[1]; break; }
    }

    const holdings = [];
    for (let i = 5; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 7) continue;
      const isin = (r[1] || '').toString().trim();
      const name = (r[3] || r[2] || '').toString().trim().replace(/\^|\£/g, '').trim();
      const sector = (r[4] || '').toString().trim();
      const qty = parseFloat(r[5]);
      const mktValLacs = parseFloat(r[6]);
      const pctNav = parseFloat(r[7]);

      if (!name || name.length < 2) continue;
      if (isNaN(pctNav) || pctNav <= 0) continue;

      // Infer asset type
      let assetType = 'Equity';
      const nameLower = name.toLowerCase();
      const sectorLower = sector.toLowerCase();
      if (nameLower.includes('bond') || nameLower.includes('debenture') || nameLower.includes('ncd') ||
          sectorLower.includes('sovereign') || sectorLower.includes('t-bill') || sectorLower.includes('g-sec') ||
          isin.startsWith('IN00')) {
        assetType = 'Debt';
      } else if (nameLower.includes('cash') || nameLower.includes('cblo') || nameLower.includes('net receivable')) {
        assetType = 'Cash';
      }

      holdings.push({
        securityName: name,
        symbol: name.toUpperCase().replace(/[^A-Z0-9&]/g, '').substring(0, 20),
        isin: isin.length >= 10 ? isin : null,
        assetType,
        sector: sector || null,
        quantity: isNaN(qty) ? null : qty,
        marketValueCr: isNaN(mktValLacs) ? null : Number((mktValLacs / 100).toFixed(2)),
        weight: Number(pctNav.toFixed(4)),
      });
    }

    // Sort by weight desc
    holdings.sort((a, b) => b.weight - a.weight);

    return {
      rawSchemeName,
      portfolioDate,
      sourceUrl: fileUrl,
      totalHoldings: holdings.length,
      holdings,
    };
  } catch (e) {
    console.warn('  [WARN] Failed to parse xlsx:', fileUrl, '-', e.message);
    return null;
  }
}

// ─── Stage 3: Fetch NAV + 1Y return + AUM + Investors from mfapi.in ────────
async function fetchSchemeMetrics(scheme) {
  const code = scheme.amfiCode;
  if (!code) {
    console.log(`  [SKIP] No AMFI code for ${scheme.schemeId}`);
    return { nav: null, navDate: null, return1Y: null, aumCr: null, investors: null };
  }
  try {
    const r = await axios.get(`https://api.mfapi.in/mf/${code}`, { timeout: 8000 });
    if (!r.data || !r.data.meta || !r.data.data || r.data.data.length === 0) {
      return { nav: null, navDate: null, return1Y: null, aumCr: null, investors: null };
    }

    const meta = r.data.meta;
    const navData = r.data.data; // sorted latest-first

    const navToday = parseFloat(navData[0].nav);
    const navDate = navData[0].date;

    // 1Y return: compare to NAV ~252 trading days ago (≈1 calendar year)
    const nav1YEntry = navData[Math.min(251, navData.length - 1)];
    const nav1Y = nav1YEntry ? parseFloat(nav1YEntry.nav) : null;
    const return1Y = nav1Y && nav1Y > 0 ? Number((((navToday - nav1Y) / nav1Y) * 100).toFixed(2)) : null;

    return {
      nav: navToday,
      navDate,
      return1Y,
      navHistoryCount: navData.length,
      fundHouse: meta.fund_house || 'HDFC Mutual Fund',
      schemeCategory: meta.scheme_category || scheme.category,
      // mfapi.in does not provide AUM or folio count - mark as null
      aumCr: null,
      investors: null,
    };
  } catch (e) {
    console.warn(`  [WARN] mfapi.in fetch failed for code ${code}: ${e.message}`);
    return { nav: null, navDate: null, return1Y: null, aumCr: null, investors: null };
  }
}

// ─── Stage 4: Attempt to get AUM from AMFI's NAVAll ──────────────────────
// AMFI NAVAll.txt does not have AUM. HDFC's own xlsx contains portfolio date & holdings.
// AUM would need AMFI monthly AUM report - we'll try to parse it.
async function fetchAmfiAumData() {
  console.log('\n[Stage 4] Fetching AMFI monthly AUM report for scheme-level AUM...');
  const months = ['aug', 'jul', 'jun', 'may'];
  const yr = new Date().getFullYear();
  for (const m of months) {
    const urls = [
      `https://portal.amfiindia.com/spages/am${m}${yr}repo.xls`,
      `https://portal.amfiindia.com/spages/am${m}${yr - 1}repo.xls`,
    ];
    for (const url of urls) {
      try {
        const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000, headers });
        if (r.data && r.data.byteLength > 10000) {
          const wb = xlsx.read(r.data, { type: 'buffer' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
          const aumMap = {};
          rows.forEach(row => {
            if (!Array.isArray(row) || row.length < 8) return;
            const fundName = (row[2] || row[1] || '').toString().trim();
            const aumVal = parseFloat(row[7]);
            if (fundName && !isNaN(aumVal) && aumVal > 0) {
              aumMap[fundName.toLowerCase()] = { aumCr: aumVal, aumDate: `${m.toUpperCase()} ${yr}` };
            }
          });
          console.log(`  Loaded AUM data from ${url} (${Object.keys(aumMap).length} entries)`);
          return aumMap;
        }
      } catch (_) {}
    }
  }
  console.log('  [WARN] Could not fetch AMFI AUM report — AUM will be null');
  return {};
}

function matchAum(scheme, aumMap) {
  const sNameLower = scheme.schemeName.toLowerCase();
  for (const [key, val] of Object.entries(aumMap)) {
    if (key.includes(sNameLower.split(' ').slice(1, 4).join(' ').toLowerCase())) {
      return val;
    }
  }
  return null;
}

// ─── Validation: ensure no two schemes share identical holdings ─────────────
function validateNoSharedHoldings(db) {
  const schemeIds = Object.keys(db.schemes);
  const collisions = [];
  for (let i = 0; i < schemeIds.length; i++) {
    for (let j = i + 1; j < schemeIds.length; j++) {
      const a = db.schemes[schemeIds[i]];
      const b = db.schemes[schemeIds[j]];
      if (!a.latestPortfolio || !b.latestPortfolio) continue;
      const aH = (a.latestPortfolio.holdings || []).map(h => h.securityName + ':' + h.weight).join('|');
      const bH = (b.latestPortfolio.holdings || []).map(h => h.securityName + ':' + h.weight).join('|');
      if (aH === bH && aH.length > 0) {
        collisions.push(`COLLISION: ${schemeIds[i]} and ${schemeIds[j]} have IDENTICAL holdings!`);
      }
    }
  }
  return collisions;
}

// ─── Main pipeline ──────────────────────────────────────────────────────────
async function main() {
  console.log('=== HDFC Equity Mutual Fund Data Pipeline ===');
  console.log('Started at:', new Date().toISOString());
  ensureDataDir();
  const db = loadDb();
  if (!db.schemes) db.schemes = {};

  // Initialize all scheme slots
  for (const scheme of HDFC_EQUITY_SCHEMES) {
    if (!db.schemes[scheme.schemeId]) {
      db.schemes[scheme.schemeId] = {
        schemeId: scheme.schemeId,
        schemeName: scheme.schemeName,
        amc: 'HDFC Mutual Fund',
        category: scheme.category,
        plan: scheme.plan,
        option: scheme.option,
        amfiCode: scheme.amfiCode,
        nav: null,
        navDate: null,
        return1Y: null,
        aumCr: null,
        investors: null,
        latestPortfolio: null,
        portfolioHistory: [],
        lastUpdated: null,
      };
    }
  }

  // ─ Stage 1: Discover monthly portfolio xlsx files ─
  let allFiles = [];
  try {
    allFiles = await discoverHdfcMonthlyFiles();
  } catch (e) {
    console.error('[Stage 1 ERROR]', e.message);
  }

  // ─ Stage 2: Match files to schemes and parse holdings ─
  console.log('\n[Stage 2] Matching files to equity schemes and parsing holdings...');
  let holdingsIngested = 0;
  for (const fileUrl of allFiles) {
    const schemeId = matchFileToScheme(fileUrl);
    if (!schemeId) continue; // Skip non-equity or unmapped files
    if (!db.schemes[schemeId]) continue;

    try {
      const res = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } });
      const parsed = parseHoldingsXlsx(res.data, fileUrl);
      if (!parsed || parsed.holdings.length === 0) {
        console.log(`  [SKIP] ${schemeId}: No parseable holdings from ${fileUrl}`);
        continue;
      }

      const portfolioSnapshot = {
        schemeId,
        portfolioDate: parsed.portfolioDate,
        sourceUrl: fileUrl,
        rawSchemeName: parsed.rawSchemeName,
        totalHoldings: parsed.totalHoldings,
        holdings: parsed.holdings,
        ingestedAt: new Date().toISOString(),
      };

      // Upsert: store as latestPortfolio
      db.schemes[schemeId].latestPortfolio = portfolioSnapshot;

      // Add to portfolioHistory if not already present for this date
      const hist = db.schemes[schemeId].portfolioHistory || [];
      const alreadyExists = hist.some(h => h.portfolioDate === portfolioSnapshot.portfolioDate && h.sourceUrl === fileUrl);
      if (!alreadyExists) {
        hist.push(portfolioSnapshot);
        // Keep max 12 months
        hist.sort((a, b) => (b.portfolioDate || '').localeCompare(a.portfolioDate || ''));
        db.schemes[schemeId].portfolioHistory = hist.slice(0, 12);
      }

      console.log(`  ✓ ${schemeId}: ${parsed.holdings.length} holdings (${parsed.portfolioDate}) from ${decodeURIComponent(fileUrl).split('/').pop()}`);
      holdingsIngested++;
    } catch (e) {
      console.warn(`  [WARN] ${schemeId}: Failed to fetch ${fileUrl} - ${e.message}`);
    }
  }
  console.log(`\n  Holdings ingested for ${holdingsIngested} equity schemes.`);

  // ─ Stage 3: Fetch NAV + 1Y return from mfapi.in ─
  console.log('\n[Stage 3] Fetching NAV, 1Y return from mfapi.in...');
  for (const scheme of HDFC_EQUITY_SCHEMES) {
    const metrics = await fetchSchemeMetrics(scheme);
    const slot = db.schemes[scheme.schemeId];
    if (slot) {
      slot.nav = metrics.nav;
      slot.navDate = metrics.navDate;
      slot.return1Y = metrics.return1Y;
      slot.navHistoryCount = metrics.navHistoryCount;
      slot.schemeCategory = metrics.schemeCategory;
      slot.lastUpdated = new Date().toISOString();
      const retStr = metrics.return1Y !== null ? `${metrics.return1Y.toFixed(2)}%` : 'N/A';
      const navStr = metrics.nav !== null ? metrics.nav.toFixed(4) : 'N/A';
      console.log(`  ${scheme.schemeId}: NAV=${navStr} (${metrics.navDate || '?'}) | 1Y Return=${retStr}`);
    }
    // Small delay to be respectful to the API
    await new Promise(r => setTimeout(r, 300));
  }

  // ─ Stage 4: Fetch AUM data ─
  const aumMap = await fetchAmfiAumData();
  if (Object.keys(aumMap).length > 0) {
    for (const scheme of HDFC_EQUITY_SCHEMES) {
      const match = matchAum(scheme, aumMap);
      if (match && db.schemes[scheme.schemeId]) {
        db.schemes[scheme.schemeId].aumCr = match.aumCr;
        db.schemes[scheme.schemeId].aumDate = match.aumDate;
      }
    }
  }

  // ─ Stage 5: Validation ─
  console.log('\n[Stage 5] Running data integrity validation...');
  const collisions = validateNoSharedHoldings(db);
  if (collisions.length > 0) {
    console.error('\n!!! DATA COLLISION DETECTED !!!');
    collisions.forEach(c => console.error('  ', c));
  } else {
    console.log('  ✓ No shared holdings collisions detected.');
  }

  // ─ Save ─
  saveDb(db);
  console.log(`\n[Done] Data saved to ${DB_FILE}`);

  // ─ Reconciliation Report ─
  console.log('\n=== HDFC EQUITY MUTUAL FUND DATA RECONCILIATION REPORT ===');
  let navOk = 0, holdingsOk = 0, return1YOk = 0, aumOk = 0;
  const failed = [];
  for (const scheme of HDFC_EQUITY_SCHEMES) {
    const s = db.schemes[scheme.schemeId];
    if (!s) continue;
    if (s.nav) navOk++;
    if (s.latestPortfolio && s.latestPortfolio.holdings && s.latestPortfolio.holdings.length > 0) holdingsOk++;
    if (s.return1Y !== null && s.return1Y !== undefined) return1YOk++;
    if (s.aumCr) aumOk++;
    const missing = [];
    if (!s.nav) missing.push('nav');
    if (!s.return1Y) missing.push('1Y return');
    if (!s.aumCr) missing.push('aum');
    if (!s.latestPortfolio) missing.push('portfolio/holdings');
    if (missing.length > 0) failed.push({ scheme: scheme.schemeId, missing });
  }
  console.log(`Total equity schemes:         ${HDFC_EQUITY_SCHEMES.length}`);
  console.log(`NAV available:                ${navOk}`);
  console.log(`1Y Return available:          ${return1YOk}`);
  console.log(`Holdings available:           ${holdingsOk}`);
  console.log(`AUM available:                ${aumOk}`);
  console.log(`Duplicate collision warnings: ${collisions.length}`);
  if (failed.length > 0) {
    console.log('\nSchemes with missing data:');
    failed.forEach(f => console.log(`  - ${f.scheme}: missing [${f.missing.join(', ')}]`));
  } else {
    console.log('\n✓ All schemes have complete data!');
  }
}

main().catch(err => {
  console.error('Pipeline fatal error:', err);
  process.exit(1);
});
