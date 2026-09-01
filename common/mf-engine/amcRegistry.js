/**
 * common/mf-engine/amcRegistry.js
 *
 * AMC source registry + scheme master discovery.
 * Uses AMFI NAVAll.txt to discover all equity schemes per AMC,
 * then maps them to Groww slugs for data fetching.
 */

'use strict';

const axios = require('axios');

// Top 24 AMCs to support
const TARGET_AMCS = [
  'HDFC Mutual Fund',
  'SBI Mutual Fund',
  'ICICI Prudential Mutual Fund',
  'Nippon India Mutual Fund',
  'Axis Mutual Fund',
  'Kotak Mahindra Mutual Fund',
  'Aditya Birla Sun Life Mutual Fund',
  'Mirae Asset Mutual Fund',
  'UTI Mutual Fund',
  'Tata Mutual Fund',
  'DSP Mutual Fund',
  'Motilal Oswal Mutual Fund',
  'Quantum Mutual Fund',
  'PPFAS Mutual Fund',
  'Bandhan Mutual Fund',
  'HSBC Mutual Fund',
  'Canara Robeco Mutual Fund',
  'Edelweiss Mutual Fund',
  'PGIM India Mutual Fund',
  'Baroda BNP Paribas Mutual Fund',
  'Union Mutual Fund',
  'Franklin Templeton Mutual Fund',
  'Sundaram Mutual Fund',
  'Invesco Mutual Fund',
];

// AMC name normalization mapping
const AMC_ALIASES = {
  'kotak': 'Kotak Mahindra Mutual Fund',
  'kotak mahindra': 'Kotak Mahindra Mutual Fund',
  'aditya birla sun life': 'Aditya Birla Sun Life Mutual Fund',
  'aditya birla': 'Aditya Birla Sun Life Mutual Fund',
  'birla sun life': 'Aditya Birla Sun Life Mutual Fund',
  'absl': 'Aditya Birla Sun Life Mutual Fund',
  'nippon india': 'Nippon India Mutual Fund',
  'mirae asset': 'Mirae Asset Mutual Fund',
  'ppfas': 'PPFAS Mutual Fund',
  'parag parikh': 'PPFAS Mutual Fund',
  'bandhan': 'Bandhan Mutual Fund',
  'idfc': 'Bandhan Mutual Fund',
  'canara robeco': 'Canara Robeco Mutual Fund',
  'pgim': 'PGIM India Mutual Fund',
  'pgim india': 'PGIM India Mutual Fund',
  'baroda bnp': 'Baroda BNP Paribas Mutual Fund',
  'baroda bnp paribas': 'Baroda BNP Paribas Mutual Fund',
  'franklin templeton': 'Franklin Templeton Mutual Fund',
  'franklin': 'Franklin Templeton Mutual Fund',
  'motilal oswal': 'Motilal Oswal Mutual Fund',
};

// Equity category keywords
const EQUITY_KEYWORDS = [
  'equity', 'large cap', 'mid cap', 'small cap', 'flexi cap', 'multi cap',
  'focused', 'value', 'contra', 'elss', 'tax saver', 'dividend yield',
  'index', 'nifty', 'sensex', 'sector', 'thematic', 'infrastructure',
  'banking', 'pharma', 'technology', 'manufacturing', 'consumption',
  'business cycle', 'innovation', 'defence', 'housing', 'transport',
  'energy', 'digital', 'consumption', 'mnc', 'psu', 'momentum',
  'reduce', 'fund of fund', 'gold etf', 'silver etf', 'commodit',
  'retirement', 'children', 'savings', 'advantage',
];

/**
 * Fetch and parse AMFI NAVAll.txt to discover all schemes
 */
async function fetchAmfiSchemeList() {
  console.log('[AMC Registry] Fetching AMFI NAVAll.txt...');
  const res = await axios.get('https://www.amfiindia.com/spages/NAVAll.txt', { timeout: 20000 });
  const lines = res.data.split('\n');
  const amcMap = new Map(); // amcName -> [{code, name, nav, date, isin, plan, option}]
  let currentAmc = '';
  let currentCategory = '';

  for (const line of lines) {
    const l = line.trim().replace(/\r/g, '');
    if (!l) continue;

    // Category headers
    if (l.startsWith('Open Ended Schemes') || l.startsWith('Close Ended Schemes')) {
      currentCategory = l;
      continue;
    }

    // AMC headers (line without semicolons containing "Mutual Fund")
    if (l.includes('Mutual Fund') && !l.includes(';')) {
      // Normalize AMC name
      currentAmc = normalizeAmcName(l);
      continue;
    }

    // Scheme data lines
    if (l.includes(';')) {
      const parts = l.split(';');
      if (parts.length >= 7 && parts[0] !== 'Scheme Code' && !isNaN(parseInt(parts[0]))) {
        const code = parts[0].trim();
        const isin = parts[1] || '';
        const schemeName = (parts[3] || parts[1] || '').trim();
        const plan = (parts[4] || '').trim();
        const option = (parts[5] || '').trim();
        const nav = parseFloat(parts[6]);
        const date = (parts[7] || '').trim().replace(/\r/g, '');

        if (!currentAmc || !code || isNaN(nav)) continue;

        if (!amcMap.has(currentAmc)) {
          amcMap.set(currentAmc, []);
        }
        amcMap.get(currentAmc).push({
          schemeCode: code,
          schemeName,
          plan,
          option,
          nav,
          navDate: date,
          isin,
          category: currentCategory,
        });
      }
    }
  }

  console.log(`[AMC Registry] Found ${amcMap.size} AMCs in AMFI data`);
  return amcMap;
}

/**
 * Normalize AMC name to standard form
 */
function normalizeAmcName(raw) {
  const lower = raw.toLowerCase().trim();
  // Check aliases first
  for (const [alias, canonical] of Object.entries(AMC_ALIASES)) {
    if (lower.includes(alias)) return canonical;
  }
  // Direct match
  for (const target of TARGET_AMCS) {
    if (lower.includes(target.toLowerCase().replace(' mutual fund', ''))) return target;
  }
  return raw.trim();
}

/**
 * Filter for equity Direct Growth schemes
 */
function filterEquityDirectGrowth(schemes) {
  return schemes.filter(s => {
    const lower = s.schemeName.toLowerCase();
    const plan = s.plan.toLowerCase();
    const option = s.option.toLowerCase();

    // Must be Direct Plan + Growth option
    const isDirect = plan.includes('direct');
    const isGrowth = option.includes('growth');

    // Must be equity-related
    const isEquity = EQUITY_KEYWORDS.some(kw => lower.includes(kw));

    // Exclude pure debt/liquid/gilt
    const isDebt = ['liquid', 'money market', 'gilt', 'g-sec', 'overnight', 'treasury', 'ultra short', 'low duration', 'short duration', 'medium duration', 'long duration', 'dynamic bond', 'corporate bond', 'banking and psu', 'credit risk', 'floater'].some(kw => lower.includes(kw));

    return isDirect && isGrowth && isEquity && !isDebt;
  });
}

/**
 * Convert AMFI scheme name to a Groww-compatible slug
 */
function schemeNameToGrowwSlug(schemeName) {
  return schemeName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Build AMC scheme masters for all target AMCs
 */
async function buildAmcSchemeMasters() {
  const amfiData = await fetchAmfiSchemeList();
  const registry = {};

  for (const amcName of TARGET_AMCS) {
    const allSchemes = amfiData.get(amcName) || [];
    const equitySchemes = filterEquityDirectGrowth(allSchemes);

    if (equitySchemes.length === 0) {
      console.log(`[AMC Registry] ${amcName}: 0 equity schemes (skipped)`);
      continue;
    }

    // Group by base fund name (remove plan/option to get unique funds)
    const fundMap = new Map();
    for (const s of equitySchemes) {
      const baseName = s.schemeName
        .replace(/direct plan/gi, '')
        .replace(/regular plan/gi, '')
        .replace(/growth option/gi, '')
        .replace(/idcw.*$/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!fundMap.has(baseName)) {
        fundMap.set(baseName, {
          schemeCode: s.schemeCode,
          schemeName: baseName,
          growwSlug: schemeNameToGrowwSlug(baseName + ' direct growth'),
          amc: amcName,
          category: categorizeScheme(baseName),
          isin: s.isin,
        });
      }
    }

    registry[amcName] = {
      amcId: amcName.replace(/\s+Mutual Fund$/i, '').replace(/[^a-zA-Z0-9]/g, '_').toUpperCase(),
      amcName,
      schemes: Array.from(fundMap.values()),
      source: 'amfi',
      lastUpdated: new Date().toISOString(),
    };

    console.log(`[AMC Registry] ${amcName}: ${fundMap.size} equity schemes`);
  }

  return registry;
}

/**
 * Categorize a scheme by name
 */
function categorizeScheme(name) {
  const lower = name.toLowerCase();
  if (lower.includes('index') || lower.includes('nifty') || lower.includes('sensex')) return 'Index';
  if (lower.includes('etf') || lower.includes('fund of fund') || lower.includes('gold') || lower.includes('silver')) return 'ETF/FoF';
  if (lower.includes('sector') || lower.includes('banking') || lower.includes('pharma') || lower.includes('technology') || lower.includes('infra') || lower.includes('manufacturing') || lower.includes('defence') || lower.includes('consumption') || lower.includes('transport') || lower.includes('digital') || lower.includes('energy')) return 'Sectoral';
  if (lower.includes('small cap') || lower.includes('smallcap')) return 'Small Cap';
  if (lower.includes('mid cap') || lower.includes('midcap')) return 'Mid Cap';
  if (lower.includes('large cap') || lower.includes('largecap') || lower.includes('bluechip')) return 'Large Cap';
  if (lower.includes('flexi cap') || lower.includes('flexicap')) return 'Flexi Cap';
  if (lower.includes('multi cap') || lower.includes('multicap')) return 'Multi Cap';
  if (lower.includes('focused')) return 'Focused';
  if (lower.includes('value') || lower.includes('contra')) return 'Value';
  if (lower.includes('elss') || lower.includes('tax saver')) return 'ELSS';
  if (lower.includes('dividend yield')) return 'Dividend Yield';
  if (lower.includes('retirement') || lower.includes('children')) return 'Solution';
  if (lower.includes('hybrid') || lower.includes('balanced') || lower.includes('equity savings') || lower.includes('aggressive')) return 'Hybrid';
  return 'Other Equity';
}

module.exports = {
  fetchAmfiSchemeList,
  filterEquityDirectGrowth,
  schemeNameToGrowwSlug,
  buildAmcSchemeMasters,
  normalizeAmcName,
  categorizeScheme,
  TARGET_AMCS,
};
