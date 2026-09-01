/**
 * scripts/importAmfiFolios.js
 *
 * Downloads the AMFI monthly report (MCR sheet) and distributes
 * category-level folio counts to individual schemes proportionally
 * by AUM.
 *
 * AMFI publishes category-level folio data, not scheme-level.
 * This script estimates scheme-level folio counts by distributing
 * category folios based on each scheme's AUM share within its category.
 *
 * Usage: node scripts/importAmfiFolios.js
 */

'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'hdfc_mutual_funds.db');

// ─── AMFI Category Mapping ────────────────────────────────────────────────
// Maps AMFI MCR category names to the category strings stored in our DB
const AMFI_CATEGORY_MAP = {
  // Equity
  'multi cap fund': 'Equity: Multi Cap',
  'large cap fund': 'Equity: Large Cap',
  'large & mid cap fund': 'Equity: Large & Mid Cap',
  'large & mid cap': 'Equity: Large & Mid Cap',
  'mid cap fund': 'Equity: Mid Cap',
  'small cap fund': 'Equity: Small Cap',
  'dividend yield fund': 'Equity: Dividend Yield',
  'value fund/contra fund': 'Equity: Value',
  'focused fund': 'Equity: Focused',
  'sectoral/thematic funds': 'Equity: Sectoral',
  'elss': 'Equity: ELSS',
  'flexi cap fund': 'Equity: Flexi Cap',
  // Debt
  'overnight fund': 'Debt: Overnight',
  'liquid fund': 'Debt: Liquid',
  'ultra short duration fund': 'Debt: Ultra Short',
  'low duration fund': 'Debt: Low Duration',
  'money market fund': 'Debt: Money Market',
  'short duration fund': 'Debt: Short Duration',
  'medium duration fund': 'Debt: Medium Duration',
  'medium to long duration fund': 'Debt: Medium to Long',
  'long duration fund': 'Debt: Long Duration',
  'dynamic bond fund': 'Debt: Dynamic Bond',
  'corporate bond fund': 'Debt: Corporate Bond',
  'credit risk fund': 'Debt: Credit Risk',
  'banking and psu fund': 'Debt: Banking & PSU',
  'banking & psu fund': 'Debt: Banking & PSU',
  'gilt fund': 'Debt: Gilt',
  'gilt fund with 10 year constant duration': 'Debt: Gilt 10Y',
  'floater fund': 'Debt: Floater',
  // Hybrid
  'conservative hybrid fund': 'Hybrid: Conservative',
  'balanced hybrid fund/aggressive hybrid fund': 'Hybrid: Aggressive',
  'dynamic asset allocation/balanced advantage fund': 'Hybrid: BAF',
  'multi asset allocation fund': 'Hybrid: Multi Asset',
  'arbitrage fund': 'Hybrid: Arbitrage',
  'equity savings fund': 'Hybrid: Equity Savings',
  // Solution Oriented
  'retirement fund': 'Solution: Retirement',
  "childrens fund": 'Solution: Children',
  // Index / ETF
  'index funds': 'Index',
  'gold etf': 'ETF: Gold',
  'other etfs': 'ETF: Other',
  'fund of funds investing overseas': 'FoF: Overseas',
  'fund of funds scheme (domestic)**': 'FoF: Domestic',
  'fixed term plan': 'Debt: Fixed Term',
  'infrastructure debt fund': 'Debt: Infra',
  'other debt scheme': 'Debt: Other',
};

/**
 * Normalize category name for matching
 */
function normalizeCategory(cat) {
  return (cat || '').toLowerCase().trim()
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&')
    .trim();
}

/**
 * Guess the AMFI category for a scheme based on its name and category from DB
 */
function guessAmfiCategory(scheme) {
  var name = (scheme.schemeName || '').toLowerCase();
  var cat = (scheme.category || '').toLowerCase();
  
  // Direct category matching
  if (cat.includes('flexi cap') || cat.includes('flexicap')) return 'Equity: Flexi Cap';
  if (cat.includes('large cap') && cat.includes('mid cap')) return 'Equity: Large & Mid Cap';
  if (cat.includes('large cap')) return 'Equity: Large Cap';
  if (cat.includes('mid cap')) return 'Equity: Mid Cap';
  if (cat.includes('small cap')) return 'Equity: Small Cap';
  if (cat.includes('multi cap')) return 'Equity: Multi Cap';
  if (cat.includes('focused')) return 'Equity: Focused';
  if (cat.includes('value') || cat.includes('contra')) return 'Equity: Value';
  if (cat.includes('sectoral') || cat.includes('thematic')) return 'Equity: Sectoral';
  if (cat.includes('dividend yield')) return 'Equity: Dividend Yield';
  if (cat.includes('elss') || cat.includes('tax saver')) return 'Equity: ELSS';
  
  // Name-based matching
  if (name.includes('flexi cap') || name.includes('flexicap')) return 'Equity: Flexi Cap';
  if (name.includes('large & mid cap') || name.includes('large mid cap')) return 'Equity: Large & Mid Cap';
  if (name.includes('large cap')) return 'Equity: Large Cap';
  if (name.includes('mid cap') || name.includes('midcap')) return 'Equity: Mid Cap';
  if (name.includes('small cap') || name.includes('smallcap')) return 'Equity: Small Cap';
  if (name.includes('multi cap') || name.includes('multicap')) return 'Equity: Multi Cap';
  if (name.includes('focused')) return 'Equity: Focused';
  if (name.includes('contra') || name.includes('value fund')) return 'Equity: Value';
  if (name.includes('sectoral') || name.includes('banking') || name.includes('pharma') || name.includes('technology') || name.includes('infrastructure') || name.includes('manufacturing')) return 'Equity: Sectoral';
  if (name.includes('dividend yield')) return 'Equity: Dividend Yield';
  if (name.includes('elss') || name.includes('tax saver') || name.includes('tax saving')) return 'Equity: ELSS';
  
  if (name.includes('liquid fund')) return 'Debt: Liquid';
  if (name.includes('overnight')) return 'Debt: Overnight';
  if (name.includes('ultra short')) return 'Debt: Ultra Short';
  if (name.includes('low duration')) return 'Debt: Low Duration';
  if (name.includes('money market')) return 'Debt: Money Market';
  if (name.includes('short duration')) return 'Debt: Short Duration';
  if (name.includes('medium duration') && !name.includes('long')) return 'Debt: Medium Duration';
  if (name.includes('long duration') || name.includes('medium to long')) return 'Debt: Medium to Long';
  if (name.includes('dynamic bond')) return 'Debt: Dynamic Bond';
  if (name.includes('corporate bond')) return 'Debt: Corporate Bond';
  if (name.includes('credit risk')) return 'Debt: Credit Risk';
  if (name.includes('banking & psu') || name.includes('banking and psu') || name.includes('banking psu')) return 'Debt: Banking & PSU';
  if (name.includes('gilt')) return 'Debt: Gilt';
  if (name.includes('floater')) return 'Debt: Floater';
  
  if (name.includes('conservative hybrid') || name.includes('regular saver') || name.includes('monthly income')) return 'Hybrid: Conservative';
  if (name.includes('aggressive hybrid') || name.includes('balanced hybrid') || name.includes('equity hybrid')) return 'Hybrid: Aggressive';
  if (name.includes('balanced advantage') || name.includes('dynamic asset') || name.includes('baf') || name.includes('dap')) return 'Hybrid: BAF';
  if (name.includes('multi asset')) return 'Hybrid: Multi Asset';
  if (name.includes('arbitrage')) return 'Hybrid: Arbitrage';
  if (name.includes('equity savings')) return 'Hybrid: Equity Savings';
  
  if (name.includes('index fund') || name.includes('nifty') || name.includes('sensex') || name.includes('bse') || name.includes('equal weight') || name.includes('momentum') || name.includes('quality') || name.includes('low volatility')) return 'Index';
  if (name.includes('gold etf') || name.includes('gold be')) return 'ETF: Gold';
  if (name.includes('etf') || name.includes('exchange traded')) return 'ETF: Other';
  if (name.includes('fund of funds') || name.includes('fof')) return 'FoF: Overseas';
  if (name.includes('retirement')) return 'Solution: Retirement';
  if (name.includes('children') || name.includes('child')) return 'Solution: Children';
  
  // If it looks like an equity scheme based on common equity keywords
  if (cat.includes('equity') || name.includes('fund') && !name.includes('debt') && !name.includes('liquid') && !name.includes('overnight') && !name.includes('gilt')) {
    return 'Equity: Large Cap'; // Default equity category
  }
  
  return null; // Unknown category
}

/**
 * Download the latest AMFI monthly report
 */
async function downloadAmfiReport(monthYear) {
  // monthYear format: 'jul2026'
  var url = `https://portal.amfiindia.com/spages/am${monthYear}repo.xls`;
  var response = await axios.get(url, {
    timeout: 30000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  
  var filePath = path.join(DATA_DIR, `amfi_monthly_${monthYear}.xls`);
  fs.writeFileSync(filePath, Buffer.from(response.data));
  console.log(`[AMFI] Downloaded ${response.data.byteLength} bytes to ${filePath}`);
  return filePath;
}

/**
 * Parse AMFI MCR sheet and extract category-level folio data
 */
function parseAmfiMcr(filePath) {
  var wb = XLSX.readFile(filePath);
  var ws = wb.Sheets['MCR'];
  if (!ws) throw new Error('MCR sheet not found in ' + filePath);
  
  var data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  var categories = [];
  var asOfDate = null;
  
  // Extract the report date from header
  var headerRow = data[1] || data[0] || [];
  var headerText = String(headerRow[0] || '');
  var dateMatch = headerText.match(/(\w+)\s+(\d{4})/);
  if (dateMatch) {
    var months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
                   july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    var monthNum = months[dateMatch[1].toLowerCase()];
    asOfDate = `${dateMatch[2]}-${monthNum}-31`;
  }
  
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var name = String(row[1] || '').trim();
    var numSchemes = Number(row[2]) || 0;
    var folios = Number(row[3]) || 0;
    var aum = Number(row[7]) || 0;
    
    // Skip subtotals, headers, and empty rows
    if (!name || name.toLowerCase().includes('sub total') || name.toLowerCase().includes('grand total') || 
        name.toLowerCase().includes('total a') || name.toLowerCase().includes('total b') || 
        name.toLowerCase().includes('total c') || numSchemes === 0 || folios === 0) continue;
    
    var normalized = normalizeCategory(name);
    var mapped = AMFI_CATEGORY_MAP[normalized];
    
    if (mapped && folios > 0) {
      categories.push({
        amfiCategory: name,
        normalizedCategory: normalized,
        mappedCategory: mapped,
        numSchemes,
        folios,
        aum
      });
    }
  }
  
  return { categories, asOfDate };
}

/**
 * Distribute category folios to schemes proportionally by AUM
 */
function distributeFolios(schemes, categories, rawDb, reportDate) {
  // Group schemes by their guessed AMFI category
  var schemesByCategory = {};
  for (var scheme of schemes) {
    var cat = guessAmfiCategory(scheme);
    if (!cat) continue;
    if (!schemesByCategory[cat]) schemesByCategory[cat] = [];
    schemesByCategory[cat].push(scheme);
  }
  
  // For each category, get the total AUM from DB and distribute folios
  var totalUpdated = 0;
  var totalSkipped = 0;
  
  for (var cat of categories) {
    var mappedCat = cat.mappedCategory;
    var schemeList = schemesByCategory[mappedCat];
    if (!schemeList || schemeList.length === 0) {
      console.log(`  [SKIP] ${mappedCat}: no schemes in DB`);
      continue;
    }
    
    // Get AUM for each scheme from the NAV table
    var totalAum = 0;
    var schemeAums = [];
    for (var s of schemeList) {
      var navRow = rawDb.prepare('SELECT aum FROM mutual_fund_aum WHERE schemeId = ?').get(s.id);
      var aum = navRow && navRow.aum ? Number(navRow.aum) : 0;
      schemeAums.push({ scheme: s, aum });
      totalAum += aum;
    }
    
    if (totalAum <= 0) {
      // Fallback: distribute equally
      var foliosPerScheme = Math.round(cat.folios / schemeList.length);
      for (var sa of schemeAums) {
        rawDb.prepare(`INSERT INTO mutual_fund_investors (schemeId, investorCount, investorDate, source) VALUES (?, ?, ?, ?) ON CONFLICT(schemeId) DO UPDATE SET investorCount = excluded.investorCount, investorDate = excluded.investorDate, source = excluded.source`).run(sa.scheme.id, foliosPerScheme, reportDate, 'amfi-category-estimated');
        totalUpdated++;
      }
      console.log(`  [${mappedCat}] ${schemeList.length} schemes: ${cat.folios.toLocaleString('en-IN')} folios (equal split, no AUM data)`);
      continue;
    }
    
    // Distribute proportionally by AUM
    for (var sa of schemeAums) {
      var share = sa.aum / totalAum;
      var estimatedFolios = Math.round(cat.folios * share);
      estimatedFolios = Math.max(estimatedFolios, 1); // At least 1 folio
      
      rawDb.prepare(`INSERT INTO mutual_fund_investors (schemeId, investorCount, investorDate, source) VALUES (?, ?, ?, ?) ON CONFLICT(schemeId) DO UPDATE SET investorCount = excluded.investorCount, investorDate = excluded.investorDate, source = excluded.source`).run(sa.scheme.id, estimatedFolios, reportDate, 'amfi-category-estimated');
      totalUpdated++;
    }
    console.log(`  [${mappedCat}] ${schemeList.length} schemes: ${cat.folios.toLocaleString('en-IN')} folios distributed by AUM`);
  }
  
  return { totalUpdated, totalSkipped };
}

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  // Determine which month to fetch (default: latest available)
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth(); // 0-indexed
  
  // AMFI reports are typically available 1-2 months after the month
  // Go back one month if current month is too recent
  if (now.getDate() < 15) month--;
  if (month < 0) { month = 11; year--; }
  
  var monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var targetMonth = process.argv[2] || `${monthNames[month]}${year}`;
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('AMFI FOLIO IMPORTER');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Target: ${targetMonth}`);
  console.log('');
  
  // Step 1: Download AMFI report
  console.log('Step 1: Downloading AMFI monthly report...');
  var filePath;
  try {
    filePath = await downloadAmfiReport(targetMonth);
  } catch (err) {
    // Try previous month
    var prevMonth = month - 1;
    if (prevMonth < 0) { prevMonth = 11; year--; }
    var prevTarget = `${monthNames[prevMonth]}${year}`;
    console.log(`  Failed for ${targetMonth}, trying ${prevTarget}...`);
    filePath = await downloadAmfiReport(prevTarget);
    targetMonth = prevTarget;
  }
  
  // Step 2: Parse MCR sheet
  console.log('\nStep 2: Parsing AMFI MCR sheet...');
  var { categories, asOfDate } = parseAmfiMcr(filePath);
  console.log(`  Found ${categories.length} categories with folio data`);
  console.log(`  As of date: ${asOfDate || 'unknown'}`);
  
  // Step 3: Load schemes from DB
  console.log('\nStep 3: Loading schemes from database...');
  var Database = require('better-sqlite3');
  var rawDb = new Database(DB_PATH);
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');
  
  var schemes = rawDb.prepare('SELECT id, schemeName, amc, category FROM mutual_fund_schemes WHERE status = ?').all('active');
  console.log(`  Loaded ${schemes.length} active schemes`);
  
  // Step 4: Distribute folios
  console.log('\nStep 4: Distributing folios to schemes by AUM proportion...');
  var result = distributeFolios(schemes, categories, rawDb, asOfDate);
  console.log(`\n  Updated: ${result.totalUpdated} schemes`);
  console.log(`  Skipped: ${result.totalSkipped} schemes`);
  
  // Step 5: Summary
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  var totalInvestors = rawDb.prepare('SELECT COUNT(*) as c FROM mutual_fund_investors WHERE source = ?').get('amfi-category-estimated');
  console.log(`  Schemes with estimated investor count: ${totalInvestors ? totalInvestors.c : 0}`);
  
  // Show top 10 by investor count
  var topInvestors = rawDb.prepare(`
    SELECT s.amc, s.schemeName, i.investorCount, i.investorDate 
    FROM mutual_fund_investors i 
    JOIN mutual_fund_schemes s ON i.schemeId = s.id 
    WHERE i.source = 'amfi-category-estimated'
    ORDER BY i.investorCount DESC 
    LIMIT 10
  `).all();
  
  console.log('\n  Top 10 schemes by estimated investor count:');
  for (var t of topInvestors) {
    console.log(`    ${t.amc} | ${t.schemeName.substring(0, 40)} | ${Number(t.investorCount).toLocaleString('en-IN')}`);
  }
  
  rawDb.close();
  console.log('\nDone!');
}

main().catch(function(err) {
  console.error('FATAL:', err);
  process.exit(1);
});
