/**
 * scripts/hdfc/fetchHdfcSchemeMaster.js
 *
 * Discovers the complete HDFC Mutual Fund scheme list from:
 * 1. HDFC's monthly portfolio disclosure page (xlsx file names → scheme names)
 * 2. AMFI NAVAll.txt (official scheme codes, NAV, plan/option)
 *
 * Produces a deduplicated scheme master with unique schemeId.
 * Save to data/hdfc_scheme_master.json
 *
 * Run: node scripts/hdfc/fetchHdfcSchemeMaster.js
 */

'use strict';

const axios = require('axios');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const MASTER_FILE = path.join(DATA_DIR, 'hdfc_scheme_master.json');
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Stage 1: Discover all HDFC monthly portfolio xlsx files from HDFC website.
 * Each xlsx file name contains the scheme name.
 */
async function discoverHdfcPortfolioFiles() {
  console.log('[Stage 1] Discovering HDFC monthly portfolio xlsx files from hdfcfund.com...');

  const pageUrls = [
    'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio',
    'https://www.hdfcfund.com/statutory-disclosure/monthly-portfolio',
    'https://www.hdfcfund.com/statutory-disclosure/portfolio/fortnightly-portfolio'
  ];

  const allFiles = new Set();

  for (const pageUrl of pageUrls) {
    try {
      const res = await axios.get(pageUrl, { timeout: 15000, headers: HEADERS });
      const matches = res.data.match(/https?:\/\/files\.hdfcfund\.com\/[^\s"'<>]+\.xlsx/gi) || [];
      for (const url of matches) {
        allFiles.add(url.startsWith('http') ? url : 'https://' + url);
      }
      console.log(`  ${pageUrl} → ${matches.length} xlsx files found`);
    } catch (err) {
      console.warn(`  ${pageUrl} → failed: ${err.message}`);
    }
  }

  // Also check AMFI portal for HDFC portfolio files
  try {
    const amfiRes = await axios.get('https://portal.amfiindia.com/DownloadNAVDetailsReport.aspx', { timeout: 10000, headers: HEADERS });
    console.log(`  AMFI portal → status ${amfiRes.status}`);
  } catch (err) {
    console.warn(`  AMFI portal → ${err.message}`);
  }

  console.log(`  Total unique xlsx files discovered: ${allFiles.size}`);
  return [...allFiles];
}

/**
 * Stage 2: Parse xlsx file headers to extract scheme names.
 * Row 0 of each HDFC portfolio xlsx contains the scheme name.
 */
async function extractSchemeNamesFromXlsx(fileUrls) {
  console.log('\n[Stage 2] Extracting scheme names from xlsx files...');

  const schemes = [];
  const seen = new Set();

  for (const fileUrl of fileUrls) {
    try {
      const res = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        timeout: 12000,
        headers: HEADERS
      });

      if (!res.data || res.data.byteLength < 1000) continue;

      const wb = xlsx.read(res.data, { type: 'buffer' });
      if (!wb.SheetNames || wb.SheetNames.length === 0) continue;

      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

      if (rows.length < 1) continue;

      // Row 0 typically contains the scheme name
      const rawName = (rows[0] && rows[0][0]) ? rows[0][0].toString().trim() : null;
      if (!rawName || rawName.length < 5) continue;

      // Also try row 1 if row 0 looks like a header
      let schemeName = rawName;
      if (rawName.toLowerCase().includes('portfolio') || rawName.toLowerCase().includes('hdfc mutual')) {
        const alt = (rows[1] && rows[1][0]) ? rows[1][0].toString().trim() : null;
        if (alt && alt.length > 5) schemeName = alt;
      }

      // Clean scheme name — remove parenthetical notes
      schemeName = schemeName.replace(/\s*\(.*?\)\s*$/, '').trim();

      // Extract date from the file URL or rows
      let portfolioDate = null;
      for (let i = 0; i < Math.min(5, rows.length); i++) {
        const cell = (rows[i] || []).join(' ');
        const dm = cell.match(/(\d{1,2}[-/]\w{3}[-/]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
        if (dm) {
          portfolioDate = dm[1];
          break;
        }
      }

      // Determine plan and option from scheme name
      const lowerName = schemeName.toLowerCase();
      let plan = 'Direct';
      let option = 'Growth';

      if (lowerName.includes('regular')) plan = 'Regular';
      else if (lowerName.includes('institutional')) plan = 'Institutional';
      else if (lowerName.includes('retail')) plan = 'Retail';

      if (lowerName.includes('idcw') || lowerName.includes('dividend')) option = 'IDCW';
      else if (lowerName.includes('growth')) option = 'Growth';

      // Determine category from scheme name
      const category = extractCategory(schemeName);

      // Create unique schemeId
      const schemeId = createSchemeId(schemeName, plan, option);

      if (!seen.has(schemeId)) {
        seen.add(schemeId);
        schemes.push({
          id: schemeId,
          schemeName,
          amc: 'HDFC Mutual Fund',
          category,
          plan,
          option,
          sourceUrl: fileUrl,
          portfolioDate
        });
      }
    } catch (err) {
      // Skip individual file errors
    }
  }

  console.log(`  Extracted ${schemes.length} unique schemes from xlsx files`);
  return schemes;
}

/**
 * Stage 3: Fetch AMFI NAVAll.txt to get official HDFC scheme codes and NAV.
 */
async function fetchAmfiHdfcSchemes() {
  console.log('\n[Stage 3] Fetching HDFC schemes from AMFI NAVAll.txt...');

  try {
    const res = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', {
      timeout: 15000,
      headers: HEADERS
    });

    const lines = res.data.split('\n');
    const hdfcSchemes = [];
    let currentAmc = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Detect AMC headers
      if (trimmed.includes('Mutual Fund') && !trimmed.includes(';')) {
        if (trimmed.toLowerCase().includes('hdfc')) {
          currentAmc = trimmed;
        } else {
          currentAmc = '';
        }
        continue;
      }

      // Parse scheme data lines (contain semicolons)
      if (trimmed.includes(';') && currentAmc) {
        const parts = trimmed.split(';');
        if (parts.length >= 6) {
          const code = Number(parts[0]);
          const rawName = (parts[3] || parts[1] || '').trim();
          const plan = (parts[4] || '').trim();
          const option = (parts[5] || '').trim();
          const nav = parseFloat(parts[6]);
          const date = (parts[7] || '').trim();

          if (code && rawName) {
            let fullName = rawName;
            if (plan && !fullName.toLowerCase().includes(plan.toLowerCase())) {
              fullName += ' ' + plan;
            }
            if (option && !fullName.toLowerCase().includes(option.toLowerCase())) {
              fullName += ' ' + option;
            }
            fullName = fullName.replace(/\s+/g, ' ').trim();

            // Only keep Direct Growth / Direct IDCW (the main variants)
            const lower = fullName.toLowerCase();
            const isDirect = lower.includes('direct');
            const isGrowth = lower.includes('growth');
            const isIdcw = lower.includes('idcw') || lower.includes('dividend');

            if (isDirect && (isGrowth || isIdcw)) {
              hdfcSchemes.push({
                schemeCode: code,
                schemeName: fullName,
                nav: isNaN(nav) ? null : nav,
                navDate: date,
                planTag: 'Direct',
                optionTag: isIdcw ? 'IDCW' : 'Growth'
              });
            }
          }
        }
      }
    }

    console.log(`  Found ${hdfcSchemes.length} HDFC Direct schemes from AMFI`);
    return hdfcSchemes;
  } catch (err) {
    console.warn(`  AMFI fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Stage 4: Merge xlsx-discovered schemes with AMFI codes.
 * AMFI codes are the authoritative source for schemeCode.
 */
function mergeSchemes(xlsxSchemes, amfiSchemes) {
  console.log('\n[Stage 4] Merging scheme sources...');

  const merged = new Map();

  // Start with xlsx-discovered schemes (they have portfolio URLs)
  for (const s of xlsxSchemes) {
    merged.set(s.id, { ...s, schemeCode: null, amfiCode: null, isin: null });
  }

  // Match AMFI schemes by name similarity
  for (const amfi of amfiSchemes) {
    const amfiClean = amfi.schemeName.toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/-?\s*direct\s*plan\s*/gi, '')
      .replace(/-?\s*(growth|idcw|dividend)\s*(option)?\s*/gi, '')
      .trim();

    let matched = false;
    for (const [id, scheme] of merged) {
      const schemeClean = scheme.schemeName.toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/-?\s*direct\s*plan\s*/gi, '')
        .replace(/-?\s*(growth|idcw|dividend)\s*(option)?\s*/gi, '')
        .trim();

      if (amfiClean === schemeClean || amfiClean.includes(schemeClean) || schemeClean.includes(amfiClean)) {
        scheme.schemeCode = amfi.schemeCode;
        scheme.amfiCode = amfi.schemeCode;
        scheme.amfiNav = amfi.nav;
        scheme.amfiNavDate = amfi.navDate;
        matched = true;
        break;
      }
    }

    // If no match found in xlsx schemes, add as new
    if (!matched) {
      const plan = amfi.planTag || 'Direct';
      const option = amfi.optionTag || 'Growth';
      const schemeId = createSchemeId(amfi.schemeName, plan, option);

      if (!merged.has(schemeId)) {
        merged.set(schemeId, {
          id: schemeId,
          schemeName: amfi.schemeName,
          amc: 'HDFC Mutual Fund',
          category: extractCategory(amfi.schemeName),
          plan,
          option,
          schemeCode: amfi.schemeCode,
          amfiCode: amfi.schemeCode,
          amfiNav: amfi.nav,
          amfiNavDate: amfi.navDate,
          isin: null,
          sourceUrl: null,
          portfolioDate: null
        });
      }
    }
  }

  const result = [...merged.values()];
  console.log(`  Merged total: ${result.length} unique HDFC schemes`);
  return result;
}

/**
 * Create a stable unique schemeId from scheme name, plan, and option.
 */
function createSchemeId(schemeName, plan, option) {
  // Extract base fund name (remove plan/option suffixes)
  let base = schemeName
    .replace(/\s+/g, ' ')
    .replace(/-\s*(Direct|Regular|Retail|Institutional)\s*Plan/gi, '')
    .replace(/-\s*(Growth|IDCW|Dividend)\s*(Option|Payout|Re-investment|Reinvestment)?/gi, '')
    .replace(/\s*(Direct|Regular)\s*Plan/gi, '')
    .replace(/\s*(Growth|IDCW|Dividend)\s*(Option|Payout|Re-investment|Reinvestment)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Create slug
  let slug = base.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 60);

  // Append plan and option
  const planSlug = (plan || 'direct').toLowerCase().replace(/[^a-z]/g, '');
  const optionSlug = (option || 'growth').toLowerCase().replace(/[^a-z]/g, '');

  return `HDFC_${slug}_${planSlug}_${optionSlug}`;
}

/**
 * Extract category from scheme name using keyword matching.
 */
function extractCategory(schemeName) {
  const s = (schemeName || '').toLowerCase();

  if (s.includes('large & mid') || s.includes('large and mid')) return 'Equity: Large & Mid Cap';
  if (s.includes('small cap') || s.includes('smallcap')) return 'Equity: Small Cap';
  if (s.includes('mid cap') || s.includes('midcap')) return 'Equity: Mid Cap';
  if (s.includes('large cap') || s.includes('largecap') || s.includes('top 100') || s.includes('bluechip')) return 'Equity: Large Cap';
  if (s.includes('flexi cap') || s.includes('flexicap')) return 'Equity: Flexi Cap';
  if (s.includes('multi cap') || s.includes('multicap')) return 'Equity: Multi Cap';
  if (s.includes('focused')) return 'Equity: Focused';
  if (s.includes('contra')) return 'Equity: Contra';
  if (s.includes('value')) return 'Equity: Value';
  if (s.includes('dividend yield')) return 'Equity: Dividend Yield';
  if (s.includes('elss') || s.includes('tax saver')) return 'Equity: ELSS Tax Saver';
  if (s.includes('nifty 50') || s.includes('nifty50') || s.includes('sensex')) return 'Index: Nifty 50';
  if (s.includes('nifty next 50') || s.includes('nifty next50')) return 'Index: Nifty Next 50';
  if (s.includes('nifty')) return 'Index: Nifty';
  if (s.includes('banking') || s.includes('financial services') || s.includes('bfsi')) return 'Sectoral: Banking & Financial Services';
  if (s.includes('pharma') || s.includes('healthcare')) return 'Sectoral: Pharma & Healthcare';
  if (s.includes('technology') || s.includes('it ')) return 'Sectoral: Technology';
  if (s.includes('infra')) return 'Sectoral: Infrastructure';
  if (s.includes('transport') || s.includes('logistics')) return 'Sectoral: Transportation & Logistics';
  if (s.includes('defence')) return 'Sectoral: Defence';
  if (s.includes('manufacturing')) return 'Sectoral: Manufacturing';
  if (s.includes('power') || s.includes('energy')) return 'Sectoral: Power & Energy';
  if (s.includes('consumption') || s.includes('retail')) return 'Sectoral: Consumption';
  if (s.includes('agriculture') || s.includes('agri')) return 'Sectoral: Agriculture';
  if (s.includes('communication') || s.includes('media')) return 'Sectoral: Communication & Media';
  if (s.includes('psu') || s.includes('public sector')) return 'Sectoral: PSU';
  if (s.includes('capital') || s.includes('investment')) return 'Sectoral: Capital Market';
  if (s.includes('housing') || s.includes('real estate')) return 'Sectoral: Housing & Real Estate';
  if (s.includes('retirement')) return 'Equity: Retirement';
  if (s.includes('pension')) return 'Equity: Pension';
  if (s.includes('fof') || s.includes('fund of fund')) return 'FoF: Fund of Funds';
  if (s.includes('liquid')) return 'Debt: Liquid Fund';
  if (s.includes('money market')) return 'Debt: Money Market';
  if (s.includes('gilt') || s.includes('g-sec') || s.includes('gsec')) return 'Debt: Gilt & Sovereign';
  if (s.includes('banking & psu') || s.includes('psu debt')) return 'Debt: Banking & PSU Debt';
  if (s.includes('short') && s.includes('term')) return 'Debt: Short Duration';
  if (s.includes('medium') && s.includes('term')) return 'Debt: Medium Duration';
  if (s.includes('long') && s.includes('term')) return 'Debt: Long Duration';
  if (s.includes('credit')) return 'Debt: Credit Risk';
  if (s.includes('dynamic')) return 'Debt: Dynamic Bond';
  if (s.includes('overnight')) return 'Debt: Overnight Fund';
  if (s.includes('ultra short')) return 'Debt: Ultra Short Duration';
  if (s.includes('low duration')) return 'Debt: Low Duration';
  if (s.includes('money market') || s.includes('treasury') || s.includes('fmp')) return 'Debt: Money Market';
  if (s.includes('arbitrage')) return 'Hybrid: Arbitrage';
  if (s.includes('balanced') || s.includes('hybrid') || s.includes('equity savings')) return 'Hybrid: Balanced';
  if (s.includes('monthly income') || s.includes('mip')) return 'Hybrid: MIP';
  if (s.includes('retirement benefit')) return 'Hybrid: Retirement';

  // Default to Equity if nothing else matches
  return 'Equity: Other';
}

/**
 * Save master to disk.
 */
function saveMaster(schemes) {
  ensureDataDir();
  const master = {
    version: 1,
    amc: 'HDFC Mutual Fund',
    generatedAt: new Date().toISOString(),
    totalSchemes: schemes.length,
    schemes
  };
  fs.writeFileSync(MASTER_FILE, JSON.stringify(master, null, 2), 'utf8');
  console.log(`\n[Saved] ${MASTER_FILE}`);
  return master;
}

/**
 * Print reconciliation summary.
 */
function printSummary(schemes) {
  console.log('\n=== HDFC SCHEME MASTER SUMMARY ===');
  console.log(`Total schemes: ${schemes.length}`);

  const categories = {};
  for (const s of schemes) {
    const cat = s.category || 'Unknown';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  console.log('\nBy category:');
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  const withAmfi = schemes.filter(s => s.amfiCode).length;
  const withPortfolio = schemes.filter(s => s.sourceUrl).length;
  console.log(`\nWith AMFI code: ${withAmfi}`);
  console.log(`With portfolio file: ${withPortfolio}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== HDFC SCHEME MASTER GENERATOR ===');
  console.log('Started at:', new Date().toISOString());

  // 1. Discover xlsx files from HDFC website
  const fileUrls = await discoverHdfcPortfolioFiles();

  // 2. Extract scheme names from xlsx files
  const xlsxSchemes = await extractSchemeNamesFromXlsx(fileUrls);

  // 3. Fetch AMFI scheme codes
  const amfiSchemes = await fetchAmfiHdfcSchemes();

  // 4. Merge and deduplicate
  const merged = mergeSchemes(xlsxSchemes, amfiSchemes);

  // 5. Save
  saveMaster(merged);

  // 6. Summary
  printSummary(merged);

  return merged;
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main, createSchemeId, extractCategory };
