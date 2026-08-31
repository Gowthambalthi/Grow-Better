/**
 * scripts/hdfc/importHdfcPipeline.js
 *
 * Complete HDFC Mutual Fund Data Import Pipeline
 * ================================================
 *
 * For EVERY individual HDFC scheme, fetches:
 *   1. 1-Year Return (from mfapi.in)
 *   2. AUM (from AMFI monthly report)
 *   3. Investor Count (from HDFC disclosures if available)
 *   4. Monthly Holdings (latest 12 months from HDFC S3 xlsx files)
 *
 * Data is stored in SQLite: data/hdfc_mutual_funds.db
 *
 * Run: node scripts/hdfc/importHdfcPipeline.js
 * Safe to run multiple times (upsert idempotent).
 */

'use strict';

const axios = require('axios');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

const db = require('../../db/mutualFunds');

const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const DELAY_MS = 800; // respectful delay between API calls
const MAX_RETRIES = 3;

async function fetchWithRetry(url, opts, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      const isRateLimit = err.response && (err.response.status === 429 || err.response.status === 502 || err.response.status === 503);
      if (isRateLimit && attempt < retries) {
        const backoff = attempt * 2000; // 2s, 4s, 6s
        console.log(`    Rate limited (${err.response.status}), retrying in ${backoff}ms (attempt ${attempt}/${retries})...`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Stage 1: Load Scheme Master ────────────────────────────────────────────

async function loadSchemeMaster() {
  console.log('\n[Stage 1] Loading HDFC scheme master...');

  // Try to load existing master
  const masterFile = path.join(__dirname, '../../data/hdfc_scheme_master.json');
  if (fs.existsSync(masterFile)) {
    const master = JSON.parse(fs.readFileSync(masterFile, 'utf8'));
    console.log(`  Loaded ${master.schemes.length} schemes from master (generated: ${master.generatedAt})`);
    return master.schemes;
  }

  // If no master exists, run the master generator first
  console.log('  No scheme master found. Running fetchHdfcSchemeMaster...');
  const { main: generateMaster } = require('./fetchHdfcSchemeMaster');
  const schemes = await generateMaster();
  return schemes;
}

// ─── Stage 2: Upsert Schemes into DB ────────────────────────────────────────

function upsertSchemes(schemes) {
  console.log('\n[Stage 2] Upserting schemes into database...');

  let count = 0;
  for (const s of schemes) {
    db.upsertScheme({
      id: s.id,
      schemeCode: s.schemeCode || s.amfiCode || null,
      schemeName: s.schemeName,
      amc: 'HDFC Mutual Fund',
      category: s.category,
      plan: s.plan || 'Direct',
      option: s.option || 'Growth',
      isin: s.isin || null,
      status: 'active'
    });
    count++;
  }

  console.log(`  Upserted ${count} schemes`);
  return count;
}

// ─── Stage 3: Fetch 1Y Returns from mfapi.in ────────────────────────────────

async function fetchReturns(schemes) {
  console.log('\n[Stage 3] Fetching 1Y returns from mfapi.in...');

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const scheme of schemes) {
    const code = scheme.amfiCode || scheme.schemeCode;
    if (!code) {
      skipped++;
      continue;
    }

    try {
      const res = await fetchWithRetry(`https://api.mfapi.in/mf/${code}`, { timeout: 15000 });

      if (!res.data || !res.data.data || res.data.data.length === 0) {
        failed++;
        continue;
      }

      const navData = res.data.data; // sorted latest-first

      const navToday = parseFloat(navData[0].nav);
      const navDate = navData[0].date;

      // 1Y return: compare to NAV ~252 trading days ago
      const nav1YEntry = navData[Math.min(251, navData.length - 1)];
      const nav1Y = nav1YEntry ? parseFloat(nav1YEntry.nav) : null;
      const return1Y = (nav1Y && nav1Y > 0) ? Number((((navToday - nav1Y) / nav1Y) * 100).toFixed(2)) : null;

      if (return1Y !== null) {
        db.upsertReturn(scheme.id, '1Y', return1Y, navDate, 'mfapi.in');
        success++;
      } else {
        failed++;
      }

      const retStr = return1Y !== null ? `${return1Y >= 0 ? '+' : ''}${return1Y.toFixed(2)}%` : 'N/A';
      console.log(`  ${scheme.id}: 1Y = ${retStr} (as of ${navDate})`);
    } catch (err) {
      console.warn(`  ${scheme.id}: FAILED - ${err.message}`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n  Returns: ${success} success, ${failed} failed, ${skipped} skipped (no AMFI code)`);
  return { success, failed, skipped };
}

// ─── Stage 4: Fetch AUM from AMFI Monthly Report ────────────────────────────

async function fetchAum(schemes) {
  console.log('\n[Stage 4] Fetching scheme-level AUM from AMFI monthly report...');

  let aumMap = {};

  // Try AMFI monthly AUM report
  const months = ['jul', 'jun', 'may', 'apr', 'mar'];
  const currentYear = new Date().getFullYear();

  for (const m of months) {
    const urls = [
      `https://portal.amfiindia.com/spages/am${m}${currentYear}repo.xls`,
      `https://portal.amfiindia.com/spages/am${m}${currentYear - 1}repo.xls`
    ];

    for (const url of urls) {
      try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 12000, headers: HEADERS });
        if (res.data && res.data.byteLength > 10000) {
          const wb = xlsx.read(res.data, { type: 'buffer' });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

          // Parse rows to find HDFC scheme-level AUM
          for (const row of rows) {
            if (!Array.isArray(row) || row.length < 8) continue;

            const fundName = (row[2] || row[1] || '').toString().trim();
            const aumVal = parseFloat(row[7]);

            if (fundName && !isNaN(aumVal) && aumVal > 0) {
              aumMap[fundName.toLowerCase()] = {
                aumCr: aumVal,
                aumDate: `${m.toUpperCase()} ${currentYear}`,
                source: 'AMFI Monthly Report'
              };
            }
          }

          console.log(`  Loaded AUM data from ${url} (${Object.keys(aumMap).length} entries)`);
          break;
        }
      } catch (err) {
        // Try next URL
      }
    }

    if (Object.keys(aumMap).length > 0) break;
  }

  // Match AUM to schemes
  let matched = 0;
  for (const scheme of schemes) {
    const schemeNameLower = scheme.schemeName.toLowerCase();

    // Try exact match first
    let bestMatch = null;
    let bestScore = 0;

    for (const [key, val] of Object.entries(aumMap)) {
      // Check if the AUM entry name is a substring of the scheme name or vice versa
      if (schemeNameLower.includes(key) || key.includes(schemeNameLower)) {
        bestMatch = val;
        bestScore = 100;
        break;
      }

      // Partial match — try matching the base fund name
      const schemeWords = schemeNameLower.split(/\s+/).filter(w => w.length > 3);
      const keyWords = key.split(/\s+/).filter(w => w.length > 3);
      const commonWords = schemeWords.filter(w => keyWords.includes(w));

      if (commonWords.length > bestScore && commonWords.length >= 3) {
        bestScore = commonWords.length;
        bestMatch = val;
      }
    }

    if (bestMatch) {
      db.upsertAum(scheme.id, bestMatch.aumCr, bestMatch.aumDate, bestMatch.source);
      matched++;
    }
  }

  console.log(`  AUM matched: ${matched}/${schemes.length} schemes`);
  return { matched, total: schemes.length };
}

// ─── Stage 5: Fetch Investor Counts ──────────────────────────────────────────

async function fetchInvestors(schemes) {
  console.log('\n[Stage 5] Fetching investor counts...');

  // Try HDFC's monthly portfolio page for investor data
  let investorData = {};

  try {
    const res = await axios.get('https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio', {
      timeout: 12000,
      headers: HEADERS
    });

    // HDFC may publish investor/folio counts in the page or linked xlsx files
    // For now, mark as unavailable — we'll set null
    console.log('  HDFC portfolio page fetched. Investor count extraction: checking xlsx files...');
  } catch (err) {
    console.warn(`  Could not reach HDFC portfolio page: ${err.message}`);
  }

  // Investor counts are typically not available in standard API sources.
  // Set null for all schemes — frontend will show "Not available"
  let count = 0;
  for (const scheme of schemes) {
    db.upsertInvestors(scheme.id, null, null, 'Not available from public sources');
    count++;
  }

  console.log(`  Investor counts: set to null for ${count} schemes (not available from public sources)`);
  return { available: 0, total: count };
}

// ─── Stage 6: Fetch Monthly Portfolios from HDFC S3 ─────────────────────────

async function fetchPortfolios(schemes) {
  console.log('\n[Stage 6] Fetching monthly portfolios from HDFC S3...');

  // Discover all xlsx files from HDFC website
  const fileUrls = new Set();

  const pageUrls = [
    'https://www.hdfcfund.com/statutory-disclosure/portfolio/monthly-portfolio',
    'https://www.hdfcfund.com/statutory-disclosure/monthly-portfolio',
    'https://www.hdfcfund.com/statutory-disclosure/portfolio/fortnightly-portfolio'
  ];

  for (const pageUrl of pageUrls) {
    try {
      const res = await axios.get(pageUrl, { timeout: 15000, headers: HEADERS });
      const matches = res.data.match(/https?:\/\/files\.hdfcfund\.com\/[^\s"'<>]+\.xlsx/gi) || [];
      for (const url of matches) {
        fileUrls.add(url.startsWith('http') ? url : 'https://' + url);
      }
    } catch (err) {
      // Skip
    }
  }

  console.log(`  Discovered ${fileUrls.size} xlsx files on HDFC S3`);

  // Step 1: Extract scheme name from each xlsx filename
  // HDFC files are named like: "Monthly HDFC Value Fund - 31 July 2026.xlsx"
  // or: "HDFC Liquid Fund - 15-Aug-2026.xlsx"
  const fileInfos = [];
  for (const fileUrl of fileUrls) {
    const decoded = decodeURIComponent(fileUrl);
    const filename = decoded.split('/').pop().replace(/\.xlsx$/i, '');
    
    // Extract scheme name from filename (remove "Monthly " prefix and date suffix)
    let extractedName = filename
      .replace(/^Monthly\s+/i, '')  // Remove "Monthly " prefix
      .replace(/\s*-\s*\d{1,2}\s+\w+\s+\d{4}$/i, '')  // Remove " - 31 July 2026"
      .replace(/\s*-\s*\d{1,2}-\w{3}-\d{4}$/i, '')  // Remove " - 15-Aug-2026"
      .trim();

    const dateStr = extractDateFromUrl(decoded.toLowerCase());
    
    fileInfos.push({ url: fileUrl, decodedUrl: decoded.toLowerCase(), filename, extractedName, dateStr });
  }

  console.log(`  Extracted scheme names from ${fileInfos.length} filenames`);

  // Step 2: Match each file to exactly one scheme (best match only)
  const schemeFileMap = new Map(); // schemeId -> [{ url, date }]
  const usedFiles = new Set(); // track which files have been assigned

  for (const scheme of schemes) {
    const schemeNameLower = scheme.schemeName.toLowerCase()
      .replace(/-\s*(Direct|Regular)\s*Plan/gi, '')
      .replace(/-\s*(Growth|IDCW|Dividend)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    let bestMatch = null;
    let bestScore = 0;

    for (const fileInfo of fileInfos) {
      if (usedFiles.has(fileInfo.url)) continue;

      const extractedLower = fileInfo.extractedName.toLowerCase();

      // Exact match (highest priority)
      if (extractedLower === schemeNameLower) {
        bestMatch = fileInfo;
        bestScore = 1000;
        break;
      }

      // The extracted name contains the scheme name or vice versa
      if (extractedLower.includes(schemeNameLower) || schemeNameLower.includes(extractedLower)) {
        const lenRatio = Math.min(extractedLower.length, schemeNameLower.length) / Math.max(extractedLower.length, schemeNameLower.length);
        if (lenRatio > 0.7 && lenRatio > bestScore / 1000) {
          bestScore = lenRatio * 1000;
          bestMatch = fileInfo;
        }
      }

      // Word-level matching
      const schemeWords = schemeNameLower.split(/\s+/).filter(w => w.length > 3);
      const fileWords = extractedLower.split(/\s+/).filter(w => w.length > 3);
      const commonWords = schemeWords.filter(w => fileWords.includes(w));
      const wordScore = commonWords.length / Math.max(schemeWords.length, 1);

      if (wordScore >= 0.8 && wordScore * 100 > bestScore) {
        bestScore = wordScore * 100;
        bestMatch = fileInfo;
      }
    }

    if (bestMatch && bestScore >= 50) {
      usedFiles.add(bestMatch.url);
      if (!schemeFileMap.has(scheme.id)) {
        schemeFileMap.set(scheme.id, []);
      }
      schemeFileMap.get(scheme.id).push(bestMatch);
    }
  }

  console.log(`  Matched xlsx files to ${schemeFileMap.size} schemes (unique assignment)`);

  // Step 3: For each matched scheme, fetch and parse the xlsx file
  for (const [schemeId, files] of schemeFileMap) {
    // Sort by date (most recent first)
    files.sort((a, b) => b.dateStr.localeCompare(a.dateStr));

    // Take only the latest unique month (HDFC monthly page has one file per scheme per month)
    const seenMonths = new Set();
    const latestFiles = [];
    for (const file of files) {
      const monthKey = file.dateStr.substring(0, 7);
      if (!seenMonths.has(monthKey) && latestFiles.length < 12) {
        seenMonths.add(monthKey);
        latestFiles.push(file);
      }
    }

    // Fetch and parse each xlsx
    let schemeSnapshots = 0;
    let schemeHoldings = 0;

    for (const file of latestFiles) {
      try {
        const res = await fetchWithRetry(file.url, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: HEADERS
        });

        if (!res.data || res.data.byteLength < 1000) continue;

        const holdings = parseHoldingsXlsx(res.data, file.url);
        if (!holdings || holdings.holdings.length === 0) continue;

        const portfolioId = db.upsertPortfolio(
          schemeId,
          holdings.portfolioDate || file.dateStr,
          'HDFC Official Monthly Portfolio',
          file.url,
          holdings.holdings
        );

        schemeSnapshots++;
        schemeHoldings += holdings.holdings.length;
      } catch (err) {
        // Skip individual file errors
      }

      await sleep(DELAY_MS);
    }

    totalSnapshots += schemeSnapshots;
    totalHoldings += schemeHoldings;

    if (schemeSnapshots > 0) {
      console.log(`  ${schemeId}: ${schemeSnapshots} months, ${schemeHoldings} holdings`);
    }
  }

  console.log(`\n  Portfolios: ${totalSnapshots} snapshots, ${totalHoldings} holdings records`);
  return { snapshots: totalSnapshots, holdings: totalHoldings };
}

/**
 * Extract a date string from a URL (best effort).
 */
function extractDateFromUrl(decodedUrl) {
  // Try various date patterns in URLs
  const patterns = [
    /(\d{4})[_-](\d{2})[_-](\d{2})/,
    /(\d{2})[_-](\w{3})[_-](\d{4})/,
    /(\d{2})(\d{2})(\d{4})/,
    /(\d{4})(\d{2})/
  ];

  for (const pat of patterns) {
    const m = decodedUrl.match(pat);
    if (m) {
      if (m[0].length === 8 && m[0].startsWith('20')) {
        // YYYYMMDD
        return `${m[0].substring(0, 4)}-${m[0].substring(4, 6)}-${m[0].substring(6, 8)}`;
      }
      if (m.length >= 4) {
        const monthMap = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
          jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

        if (monthMap[m[2].toLowerCase()]) {
          return `${m[3]}-${monthMap[m[2].toLowerCase()]}-28`;
        }
      }
    }
  }

  // Fallback: use today's date
  return new Date().toISOString().substring(0, 10);
}

/**
 * Parse a single HDFC portfolio xlsx file into holdings array.
 * Returns { portfolioDate, holdings[] }
 */
function parseHoldingsXlsx(buffer, fileUrl) {
  try {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    if (!wb.SheetNames || wb.SheetNames.length === 0) return null;

    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
    if (!rows || rows.length < 6) return null;

    // Row 0: scheme name
    const rawSchemeName = (rows[0] && rows[0][0]) ? rows[0][0].toString().trim() : null;

    // Find portfolio date in first 5 rows
    let portfolioDate = null;
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      const cell = (rows[i] || []).join(' ');
      const dm = cell.match(/(\d{1,2}[-/]\w+[-/]\d{2,4}|\w+\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
      if (dm) {
        portfolioDate = parseDateString(dm[1]);
        break;
      }
    }

    // Find the header row (contains ISIN, Name, Sector, etc.)
    let headerRow = 4; // default
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const rowStr = (rows[i] || []).join(' ').toLowerCase();
      if (rowStr.includes('isin') || rowStr.includes('security') || rowStr.includes('stock') || rowStr.includes('company')) {
        headerRow = i;
        break;
      }
    }

    const holdings = [];
    for (let i = headerRow + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!Array.isArray(r) || r.length < 5) continue;

      // HDFC xlsx format: ISIN(1), Symbol(2), Security Name(3), Rating/Sector(4), Qty(5), MktVal Lacs(6), % NAV(7)
      const isin = (r[1] || '').toString().trim();
      const name = (r[3] || r[2] || '').toString().trim().replace(/\^|£/g, '').trim();
      const sector = (r[4] || '').toString().trim();
      const qty = parseFloat(r[5]);
      const mktValLacs = parseFloat(r[6]);
      const pctNav = parseFloat(r[7]);

      if (!name || name.length < 2) continue;
      if (isNaN(pctNav) || pctNav <= 0) continue;

      // Skip header-like rows
      if (name.toLowerCase() === 'security name' || name.toLowerCase() === 'company name') continue;

      // Infer asset type
      let assetType = 'Equity';
      const nameLower = name.toLowerCase();
      const sectorLower = sector.toLowerCase();
      if (nameLower.includes('bond') || nameLower.includes('debenture') || nameLower.includes('ncd') ||
          sectorLower.includes('sovereign') || sectorLower.includes('t-bill') || sectorLower.includes('g-sec') ||
          (isin.startsWith('IN00') && isin.length >= 12)) {
        assetType = 'Debt';
      } else if (nameLower.includes('cash') || nameLower.includes('cblo') || nameLower.includes('net receivable') ||
                 nameLower.includes('margin') || nameLower.includes('repo')) {
        assetType = 'Cash';
      }

      holdings.push({
        securityName: name,
        isin: isin.length >= 10 ? isin : null,
        assetType,
        sector: sector || null,
        quantity: isNaN(qty) ? null : qty,
        marketValue: isNaN(mktValLacs) ? null : mktValLacs,
        marketValueCr: isNaN(mktValLacs) ? null : Number((mktValLacs / 100).toFixed(4)),
        weight: Number(pctNav.toFixed(4))
      });
    }

    // Sort by weight descending
    holdings.sort((a, b) => (b.weight || 0) - (a.weight || 0));

    return {
      schemeName: rawSchemeName,
      portfolioDate,
      holdings
    };
  } catch (e) {
    return null;
  }
}

/**
 * Parse a date string into ISO format (best effort).
 */
function parseDateString(raw) {
  if (!raw) return new Date().toISOString().substring(0, 10);

  const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
  };

  // Try YYYY-MM-DD
  const m1 = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;

  // Try DD-Mon-YYYY or Mon DD, YYYY
  const m2 = raw.match(/(\d{1,2})[-/\s](\w{3,9})[-/\s](\d{4})/i);
  if (m2) {
    const mon = monthMap[m2[2].toLowerCase()];
    if (mon) return `${m2[3]}-${mon}-${m2[1].padStart(2, '0')}`;
  }

  const m3 = raw.match(/(\w{3,9})\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m3) {
    const mon = monthMap[m3[1].toLowerCase()];
    if (mon) return `${m3[3]}-${mon}-${m3[2].padStart(2, '0')}`;
  }

  return new Date().toISOString().substring(0, 10);
}

// ─── Stage 7: Validation ────────────────────────────────────────────────────

function validate() {
  console.log('\n[Stage 7] Running data integrity validation...');

  const report = db.validateIntegrity();

  console.log(`  Total schemes:           ${report.totalSchemes}`);
  console.log(`  Total portfolio snapshots: ${report.totalPortfolios}`);
  console.log(`  Total holdings records:  ${report.totalHoldings}`);
  console.log(`  Schemes with 12 months:  ${report.schemesWith12Months}`);
  console.log(`  Schemes with <12 months: ${report.schemesWithLessThan12Months}`);

  if (report.duplicateWarnings.length > 0) {
    console.log('\n  !!! DUPLICATE HOLDINGS WARNINGS !!!');
    report.duplicateWarnings.forEach(w => console.log(`    ${w}`));
  } else {
    console.log('  ✓ No duplicate holdings detected');
  }

  if (report.missingData.length > 0) {
    console.log(`\n  Schemes with missing data: ${report.missingData.length}`);
    report.missingData.slice(0, 10).forEach(m => {
      console.log(`    ${m.scheme}: missing [${m.missing.join(', ')}]`);
    });
    if (report.missingData.length > 10) {
      console.log(`    ... and ${report.missingData.length - 10} more`);
    }
  }

  return report;
}

// ─── Stage 8: Final Report ──────────────────────────────────────────────────

function printFinalReport(validationReport) {
  console.log('\n' + '='.repeat(60));
  console.log('HDFC MUTUAL FUND DATA REPORT');
  console.log('='.repeat(60));

  const schemes = db.getAllSchemes();
  let retOk = 0, aumOk = 0, invOk = 0, portOk = 0;

  for (const s of schemes) {
    if (db.getReturn(s.id)) retOk++;
    if (db.getAum(s.id)) aumOk++;
    if (db.getInvestors(s.id)?.investorCount != null) invOk++;
    if (db.getLatestPortfolio(s.id)) portOk++;
  }

  console.log(`Total schemes:                ${schemes.length}`);
  console.log(`Schemes successfully processed: ${schemes.length}`);
  console.log(`1Y return available:          ${retOk}`);
  console.log(`AUM available:                ${aumOk}`);
  console.log(`Investor count available:     ${invOk}`);
  console.log(`Schemes with 12 months:       ${validationReport.schemesWith12Months}`);
  console.log(`Schemes with <12 months:      ${validationReport.schemesWithLessThan12Months}`);
  console.log(`Total portfolio snapshots:    ${validationReport.totalPortfolios}`);
  console.log(`Total holdings records:       ${validationReport.totalHoldings}`);
  console.log(`Duplicate warnings:           ${validationReport.duplicateWarnings.length}`);
  console.log(`Failed schemes:               ${validationReport.missingData.length}`);

  if (validationReport.missingData.length > 0) {
    console.log('\nFailed schemes details:');
    validationReport.missingData.forEach(m => {
      console.log(`  ${m.scheme}: missing [${m.missing.join(', ')}]`);
    });
  }

  console.log('='.repeat(60));
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== HDFC MUTUAL FUND DATA IMPORT PIPELINE ===');
  console.log('Started at:', new Date().toISOString());

  // 1. Load scheme master
  const schemes = await loadSchemeMaster();

  // 2. Upsert schemes into DB
  upsertSchemes(schemes);

  // 3. Fetch 1Y returns
  await fetchReturns(schemes);

  // 4. Fetch AUM
  await fetchAum(schemes);

  // 5. Fetch investor counts
  await fetchInvestors(schemes);

  // 6. Fetch monthly portfolios
  await fetchPortfolios(schemes);

  // 7. Validate
  const validationReport = validate();

  // 8. Final report
  printFinalReport(validationReport);

  console.log('\nPipeline completed at:', new Date().toISOString());
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Pipeline fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main, parseHoldingsXlsx };
