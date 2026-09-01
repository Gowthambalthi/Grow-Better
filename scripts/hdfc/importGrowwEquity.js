#!/usr/bin/env node
/**
 * HDFC Equity Mutual Fund Importer — Groww Source
 *
 * Fetches REAL scheme-level data from Groww's server-side rendered pages:
 * - 1Y Return (and all other periods)
 * - AUM (fund-specific, not AMC total)
 * - NAV
 * - ALL holdings with exact weights per scheme
 * - Category, sub-category, fund manager, expense ratio, etc.
 *
 * Each scheme gets its OWN data — no sharing between schemes.
 */

const axios = require('axios');
const path = require('path');
const db = require(path.join(__dirname, '../../db/mutualFunds'));

// ── HDFC Equity Scheme Master (Direct Plan + Growth Option) ──
const HDFC_EQUITY_SCHEMES = [
  // ── Active Equity Funds ──
  { schemeCode: '118955', growwSlug: 'hdfc-equity-fund-direct-growth', name: 'HDFC Flexi Cap Fund', category: 'Equity', subCategory: 'Flexi Cap', group: 'Equity Funds' },
  { schemeCode: '118950', growwSlug: 'hdfc-focused-fund-direct-growth', name: 'HDFC Focused Fund', category: 'Equity', subCategory: 'Focused', group: 'Equity Funds' },
  { schemeCode: '119018', growwSlug: 'hdfc-large-cap-fund-direct-growth', name: 'HDFC Large Cap Fund', category: 'Equity', subCategory: 'Large Cap', group: 'Equity Funds' },
  { schemeCode: '118989', growwSlug: 'hdfc-mid-cap-opportunities-fund-direct-growth', name: 'HDFC Mid Cap Fund', category: 'Equity', subCategory: 'Mid Cap', group: 'Equity Funds' },
  { schemeCode: '149368', growwSlug: 'hdfc-multi-cap-fund-direct-growth', name: 'HDFC Multi Cap Fund', category: 'Equity', subCategory: 'Multi Cap', group: 'Equity Funds' },
  { schemeCode: '130503', growwSlug: 'hdfc-small-cap-fund-direct-growth', name: 'HDFC Small Cap Fund', category: 'Equity', subCategory: 'Small Cap', group: 'Equity Funds' },
  { schemeCode: '130498', growwSlug: 'hdfc-large-mid-cap-fund-direct-growth', name: 'HDFC Large & Mid Cap Fund', category: 'Equity', subCategory: 'Large & Mid Cap', group: 'Equity Funds' },
  { schemeCode: '118935', growwSlug: 'hdfc-value-fund-direct-plan-growth', name: 'HDFC Value Fund', category: 'Equity', subCategory: 'Value Oriented', group: 'Equity Funds' },
  // ── Sectoral / Thematic Equity Funds ──
  { schemeCode: '148986', growwSlug: 'hdfc-banking-financial-services-fund-direct-growth', name: 'HDFC Banking & Financial Services Fund', category: 'Equity', subCategory: 'Sectoral', group: 'Equity Funds' },
  { schemeCode: '118979', growwSlug: 'hdfc-infrastructure-fund-direct-growth', name: 'HDFC Infrastructure Fund', category: 'Equity', subCategory: 'Sectoral', group: 'Equity Funds' },
  { schemeCode: '152600', growwSlug: 'hdfc-manufacturing-fund-direct-growth', name: 'HDFC Manufacturing Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '152059', growwSlug: 'hdfc-technology-fund-direct-growth', name: 'HDFC Technology Fund', category: 'Equity', subCategory: 'Sectoral', group: 'Equity Funds' },
  { schemeCode: '151901', growwSlug: 'hdfc-transportation-and-logistics-fund-direct-growth', name: 'HDFC Transportation and Logistics Fund', category: 'Equity', subCategory: 'Sectoral', group: 'Equity Funds' },
  { schemeCode: '151750', growwSlug: 'hdfc-defence-fund-direct-growth', name: 'HDFC Defence Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '151458', growwSlug: 'hdfc-pharma-and-healthcare-fund-direct-growth', name: 'HDFC Pharma And Healthcare Fund', category: 'Equity', subCategory: 'Sectoral', group: 'Equity Funds' },
  { schemeCode: '151804', growwSlug: 'hdfc-consumption-fund-direct-growth', name: 'HDFC Consumption Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '150805', growwSlug: 'hdfc-business-cycle-fund-direct-growth', name: 'HDFC Business Cycle Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '153620', growwSlug: 'hdfc-innovation-fund-direct-growth', name: 'HDFC Innovation Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '141924', growwSlug: 'hdfc-housing-opportunities-fund-direct-growth', name: 'HDFC Housing Opportunities Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '151313', growwSlug: 'hdfc-long-term-fund-direct-growth', name: 'HDFC Long Term Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  { schemeCode: '151458b', growwSlug: 'hdfc-mnc-fund-direct-growth', name: 'HDFC MNC Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  // Dividend Yield
  { schemeCode: '118942', growwSlug: 'hdfc-dividend-yield-fund-direct-growth', name: 'HDFC Dividend Yield Fund', category: 'Equity', subCategory: 'Thematic', group: 'Equity Funds' },
  // ELSS
  { schemeCode: '118982', growwSlug: 'hdfc-elss-tax-saver-fund-direct-growth', name: 'HDFC ELSS Tax Saver Fund', category: 'Equity', subCategory: 'ELSS', group: 'Equity Funds' },
  // ── Index Funds ──
  { schemeCode: '153097', growwSlug: 'hdfc-nifty-50-index-fund-direct-growth', name: 'HDFC NIFTY 50 Index Fund', category: 'Equity', subCategory: 'Large Cap', group: 'Index Funds' },
  { schemeCode: '152889', growwSlug: 'hdfc-nifty-next-50-index-fund-direct-growth', name: 'HDFC NIFTY Next 50 Index Fund', category: 'Equity', subCategory: 'Large Cap', group: 'Index Funds' },
  { schemeCode: '153517', growwSlug: 'hdfc-bse-sensex-index-fund-direct-growth', name: 'HDFC BSE Sensex Index Fund', category: 'Equity', subCategory: 'Large Cap', group: 'Index Funds' },
  { schemeCode: '153518', growwSlug: 'hdfc-nifty-100-index-fund-direct-growth', name: 'HDFC NIFTY 100 Index Fund', category: 'Equity', subCategory: 'Large Cap', group: 'Index Funds' },
  { schemeCode: '152778', growwSlug: 'hdfc-nifty-smallcap-250-index-fund-direct-growth', name: 'HDFC Nifty Smallcap 250 Index Fund', category: 'Equity', subCategory: 'Small Cap', group: 'Index Funds' },
  { schemeCode: '152889b', growwSlug: 'hdfc-nifty-midcap-150-index-fund-direct-growth', name: 'HDFC NIFTY Midcap 150 Index Fund', category: 'Equity', subCategory: 'Mid Cap', group: 'Index Funds' },
  // ── ETFs (Fund of Fund) ──
  { schemeCode: '153860', growwSlug: 'hdfc-gold-etf-fund-of-fund-direct-plan-growth', name: 'HDFC Gold ETF Fund of Fund', category: 'Commodities', subCategory: 'Gold', group: 'ETFs' },
  { schemeCode: '153861', growwSlug: 'hdfc-silver-etf-fof-direct-growth', name: 'HDFC Silver ETF FoF', category: 'Commodities', subCategory: 'Silver', group: 'ETFs' },
  // ── Equity-Oriented Hybrid / FOF ──
  { schemeCode: '119128', growwSlug: 'hdfc-equity-savings-fund-direct-growth', name: 'HDFC Equity Savings Fund', category: 'Hybrid', subCategory: 'Equity Savings', group: 'Equity-Oriented' },
  { schemeCode: '136094', growwSlug: 'hdfc-retirement-fund-equity-plan-direct-growth', name: 'HDFC Retirement Fund - Equity Plan', category: 'Equity', subCategory: 'Flexi Cap', group: 'Equity-Oriented' },
  { schemeCode: '136464', growwSlug: 'hdfc-retirement-fund-hybrid-equity-plan-direct-growth', name: 'HDFC Retirement Fund - Hybrid Equity Plan', category: 'Hybrid', subCategory: 'Aggressive Hybrid', group: 'Equity-Oriented' },
];

const DELAY_MS = 1500; // Delay between requests to be respectful

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch scheme data from Groww's __NEXT_DATA__
 */
async function fetchGrowwData(slug) {
  const url = `https://groww.in/mutual-funds/${slug}`;
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const match = res.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('No __NEXT_DATA__ found for ' + slug);

  const nextData = JSON.parse(match[1]);
  const ss = nextData.props?.pageProps?.mfServerSideData;
  if (!ss) throw new Error('No mfServerSideData for ' + slug);

  return ss;
}

/**
 * Import a single scheme
 */
async function importScheme(schemeMaster, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const growwData = await fetchGrowwData(schemeMaster.growwSlug);
      return processGrowwData(schemeMaster, growwData);
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) {
        console.error(`  ✗ FAILED after ${retries} attempts: ${err.message}`);
        return { success: false, error: err.message };
      }
      const waitMs = attempt * 3000;
      console.log(`  ⟳ Attempt ${attempt} failed (${err.message}), retrying in ${waitMs / 1000}s...`);
      await sleep(waitMs);
    }
  }
}

/**
 * Process Groww data and store in database
 */
function processGrowwData(master, groww) {
  const schemeId = `HDFC_${master.schemeCode}`;
  const schemeName = groww.scheme_name || master.name;

  // ── Upsert scheme ──
  db.upsertScheme({
    id: schemeId,
    schemeCode: master.schemeCode,
    schemeName: schemeName,
    amc: 'HDFC',
    category: groww.category || master.category,
    plan: groww.plan_type || 'Direct',
    option: groww.scheme_type || 'Growth',
    isin: groww.isin || null,
    status: 'active',
    fundManager: groww.fund_manager || null,
    expenseRatio: groww.expense_ratio || null,
  });

  // ── Store returns ──
  const returnStats = groww.return_stats?.[0] || {};
  const return1y = returnStats.return1y ?? groww.stats?.[0]?.stat_1y ?? null;

  if (return1y !== null) {
    db.upsertReturn({
      schemeId: schemeId,
      period: '1Y',
      returnValue: return1y,
      asOfDate: groww.nav_date || null,
      source: 'groww',
    });
  }

  // ── Store additional return periods ──
  const extraReturns = [
    { period: '1D', value: returnStats.return1d },
    { period: '1W', value: returnStats.return1w },
    { period: '1M', value: returnStats.return1m },
    { period: '3M', value: returnStats.return3m },
    { period: '6M', value: returnStats.return6m },
    { period: '3Y', value: returnStats.return3y },
    { period: '5Y', value: returnStats.return5y },
  ];
  for (const r of extraReturns) {
    if (r.value !== null && r.value !== undefined) {
      db.upsertReturn({
        schemeId: schemeId,
        period: r.period,
        returnValue: r.value,
        asOfDate: groww.nav_date || null,
        source: 'groww',
      });
    }
  }

  // ── Store AUM ──
  const aum = groww.aum ?? null;
  if (aum !== null) {
    db.upsertAum({
      schemeId: schemeId,
      aum: aum,
      asOfDate: groww.nav_date || null,
      source: 'groww',
    });
  }

  // ── Store NAV ──
  const nav = groww.nav ?? null;
  if (nav !== null) {
    db.upsertNav({
      schemeId: schemeId,
      nav: nav,
      asOfDate: groww.nav_date || null,
      source: 'groww',
    });
  }

  // ── Store holdings ──
  const growwHoldings = groww.holdings || [];
  const portfolioDate = growwHoldings[0]?.portfolio_date || null;

  if (portfolioDate && growwHoldings.length > 0) {
    const portfolioId = db.upsertPortfolio({
      schemeId: schemeId,
      portfolioDate: portfolioDate.split('T')[0], // "2026-07-30T..." → "2026-07-30"
      source: 'groww',
    });

    // Clear old holdings for this portfolio
    db.clearHoldings(portfolioId);

    // Insert all holdings
    for (const h of growwHoldings) {
      db.insertHolding({
        portfolioId: portfolioId,
        securityName: h.company_name || h.stock_name || 'Unknown',
        isin: h.isin || null,
        assetType: h.nature_name || h.instrument_name || 'Equity',
        sector: h.sector_name || null,
        quantity: h.quantity || null,
        marketValue: h.market_value || null,
        weight: h.corpus_per || null,
      });
    }
  }

  return {
    success: true,
    schemeName,
    return1Y: return1y,
    aum: aum,
    holdingsCount: growwHoldings.length,
    expenseRatio: groww.expense_ratio || null,
    fundManager: groww.fund_manager || null,
  };
}

/**
 * Main pipeline
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  HDFC Equity MF Importer — Groww Source                 ║');
  console.log('║  Fetching REAL returns, AUM, and holdings per scheme    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const startTime = Date.now();
  const results = [];
  const errors = [];
  const BATCH_SIZE = 5; // Parallel threads per batch

  console.log(`Processing ${HDFC_EQUITY_SCHEMES.length} HDFC equity schemes (${BATCH_SIZE} parallel batches)...\n`);

  // Process in parallel batches of BATCH_SIZE
  for (let i = 0; i < HDFC_EQUITY_SCHEMES.length; i += BATCH_SIZE) {
    const batch = HDFC_EQUITY_SCHEMES.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(HDFC_EQUITY_SCHEMES.length / BATCH_SIZE);
    console.log(`[Batch ${batchNum}/${totalBatches}] Fetching ${batch.length} schemes in parallel...`);

    // Fetch all schemes in this batch simultaneously
    const batchResults = await Promise.allSettled(
      batch.map((master, idx) => {
        const globalIdx = i + idx + 1;
        console.log(`  [${globalIdx}/${HDFC_EQUITY_SCHEMES.length}] Starting: ${master.name}`);
        return importScheme(master).then(result => {
          if (result.success) {
            console.log(`  [${globalIdx}] ✓ ${master.name}: 1Y=${result.return1Y}% | AUM=₹${result.aum?.toFixed(0)} Cr | Holdings=${result.holdingsCount}`);
          } else {
            console.log(`  [${globalIdx}] ✗ ${master.name}: ${result.error}`);
          }
          return result;
        });
      })
    );

    // Collect results from this batch
    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value && r.value.success) {
        results.push(r.value);
      } else {
        const err = r.status === 'rejected' ? r.reason?.message : (r.value?.error || 'Unknown error');
        errors.push({ scheme: 'batch', error: err });
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + BATCH_SIZE < HDFC_EQUITY_SCHEMES.length) {
      await sleep(1000);
    }
  }

  // ── Summary ──
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('IMPORT SUMMARY');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Total schemes:      ${HDFC_EQUITY_SCHEMES.length}`);
  console.log(`Successfully imported: ${results.length}`);
  console.log(`Failed:             ${errors.length}`);
  console.log(`Time elapsed:       ${elapsed}s`);
  console.log('');

  if (results.length > 0) {
    const totalHoldings = results.reduce((sum, r) => sum + (r.holdingsCount || 0), 0);
    console.log(`Total holdings records: ${totalHoldings}`);

    // Show returns for each scheme
    console.log('\nScheme Returns:');
    for (const r of results.sort((a, b) => (b.return1Y || 0) - (a.return1Y || 0))) {
      const ret = r.return1Y !== null ? `${r.return1Y}%` : 'N/A';
      const aum = r.aum !== null ? `₹${r.aum.toFixed(0)} Cr` : 'N/A';
      console.log(`  ${r.schemeName.padEnd(50)} 1Y: ${ret.padStart(8)} | AUM: ${aum.padStart(12)} | Holdings: ${r.holdingsCount}`);
    }
  }

  if (errors.length > 0) {
    console.log('\nFailed schemes:');
    for (const e of errors) {
      console.log(`  ${e.scheme}: ${e.error}`);
    }
  }

  // ── Load folio (investor) data from AMFI ──
  try {
    const folioData = require('../../data/hdfc_folio_data.json');
    let folioCount = 0;
    for (const [schemeId, info] of Object.entries(folioData.schemes)) {
      db.upsertInvestors({ schemeId, investorCount: info.folios, asOfDate: folioData._asOfDate, source: 'amfi' });
      folioCount++;
    }
    console.log(`\nLoaded folio data for ${folioCount} schemes from AMFI (${folioData._asOfDate})`);
  } catch (err) {
    console.warn('Could not load folio data:', err.message);
  }

  // ── Data integrity check ──
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('DATA INTEGRITY CHECK');
  console.log('══════════════════════════════════════════════════════════');

  const allSchemes = db.getAllSchemes();
  const hdfcSchemes = allSchemes.filter(s => s.id.startsWith('HDFC_'));

  let sharedHoldings = 0;
  const holdingsSignatures = {};

  for (const scheme of hdfcSchemes) {
    const holdings = db.getHoldingsForScheme(scheme.id);
    // Create a signature from top 5 holdings
    const sig = holdings.slice(0, 5).map(h => h.securityName).sort().join('|');
    if (holdingsSignatures[sig]) {
      sharedHoldings++;
      console.log(`⚠ DUPLICATE HOLDINGS: ${scheme.schemeName} shares holdings with ${holdingsSignatures[sig]}`);
    } else {
      holdingsSignatures[sig] = scheme.schemeName;
    }
  }

  if (sharedHoldings === 0) {
    console.log('✓ No duplicate holdings detected between schemes');
  }

  console.log('');
  console.log('Done! Database: data/hdfc_mutual_funds.db');
  return { results, errors };
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Pipeline failed:', err);
    process.exit(1);
  });
}

module.exports = { main, importScheme, HDFC_EQUITY_SCHEMES };
