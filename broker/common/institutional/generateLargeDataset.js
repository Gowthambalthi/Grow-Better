/**
 * common/institutional/generateLargeDataset.js
 * Generator script to seed institutional.db with:
 * - 1,650+ NSE & BSE Listed Equities (symbol_master)
 * - 2,000+ Mutual Fund Schemes & AMCs (schemes, institutes)
 * - Computed Weightage Scores across 1M, 3M, 6M, 1Y timeframes
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const DB_PATH = path.join(DB_DIR, 'institutional.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS symbol_master (
    isin TEXT PRIMARY KEY,
    nse_symbol TEXT NOT NULL,
    bse_symbol TEXT,
    company_name TEXT NOT NULL,
    sector TEXT,
    market_cap_cr REAL DEFAULT 0,
    ltp REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS institutes (
    institute_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    total_schemes INTEGER DEFAULT 0,
    total_aum_cr REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS schemes (
    scheme_id TEXT PRIMARY KEY,
    institute_id TEXT NOT NULL,
    scheme_name TEXT NOT NULL,
    scheme_aum_cr REAL DEFAULT 0,
    category TEXT
  );

  CREATE TABLE IF NOT EXISTS stock_weightage_score (
    isin TEXT NOT NULL,
    month TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    weightage_score REAL DEFAULT 0,
    net_flow_cr REAL DEFAULT 0,
    breadth_score_norm REAL DEFAULT 0,
    pct_increase_holding REAL DEFAULT 0,
    velocity_multiplier REAL DEFAULT 1.0,
    net_buyers INTEGER DEFAULT 0,
    net_sellers INTEGER DEFAULT 0,
    PRIMARY KEY (isin, timeframe)
  );
`);

const SECTORS = [
  'Banking & Financials', 'IT Services', 'Oil & Gas', 'Automotive', 'Healthcare & Pharma',
  'FMCG & Consumer', 'Infrastructure', 'Metals & Mining', 'Renewable Energy', 'Telecommunications',
  'Capital Goods', 'Chemicals & Fertilizers', 'Real Estate & Construction', 'Textiles', 'Utilities'
];

const AMC_NAMES = [
  'SBI Mutual Fund', 'ICICI Prudential Mutual Fund', 'HDFC Mutual Fund', 'Nippon India Mutual Fund',
  'Kotak Mahindra Mutual Fund', 'Axis Mutual Fund', 'Aditya Birla Sun Life Mutual Fund', 'UTI Mutual Fund',
  'Mirae Asset Mutual Fund', 'DSP Mutual Fund', 'Edelweiss Mutual Fund', 'Tata Mutual Fund',
  'Sundaram Mutual Fund', 'Invesco Mutual Fund', 'Canara Robeco Mutual Fund', 'Motilal Oswal Mutual Fund',
  'HSBC Mutual Fund', 'PGIM India Mutual Fund', 'Union Mutual Fund', 'Bandhan Mutual Fund',
  'Baroda BNP Paribas Mutual Fund', 'Quant Mutual Fund', 'PPFAS Mutual Fund', 'JM Financial Mutual Fund'
];

const SCHEME_TYPES = [
  'Bluechip Direct Growth', 'Flexi Cap Direct Growth', 'Small Cap Direct Growth', 'Mid Cap Direct Growth',
  'Large & Mid Cap Growth', 'Focused Equity Growth', 'ELSS Tax Saver Growth', 'Contra Fund Growth',
  'Value Discovery Growth', 'Infrastructure Fund Growth', 'Healthcare Fund Growth', 'Technology Fund Growth',
  'Banking & Financial Services Growth', 'Balanced Advantage Growth', 'Multi Cap Growth', 'Opportunities Fund Growth'
];

// High profile base stocks
const BASE_STOCKS = [
  { isin: 'INE213A01011', sym: 'EMMVEE', bse: '543210', name: 'Emmvee Photovoltaic Power Ltd', sec: 'Renewable Energy', cap: 4200, ltp: 326.45, score: 94.5, netFlow: 348.5, ret: 11.34, b: 1420, s: 60 },
  { isin: 'INE002A01018', sym: 'RELIANCE', bse: '500325', name: 'Reliance Industries Ltd', sec: 'Oil & Gas', cap: 1845000, ltp: 1313.20, score: 88.2, netFlow: 1425.0, ret: 4.12, b: 1850, s: 90 },
  { isin: 'INE213A01029', sym: 'SHRIRAMFIN', bse: '511218', name: 'Shriram Finance Ltd', sec: 'Banking & Financials', cap: 112000, ltp: 2985.40, score: 82.4, netFlow: 482.0, ret: 4.93, b: 1240, s: 70 },
  { isin: 'INE090A01021', sym: 'ICICIBANK', bse: '532174', name: 'ICICI Bank Ltd', sec: 'Banking & Financials', cap: 842000, ltp: 1195.00, score: 79.8, netFlow: 620.0, ret: 5.33, b: 1650, s: 110 },
  { isin: 'INE062A01020', sym: 'SBIN', bse: '500112', name: 'State Bank of India', sec: 'Banking & Financials', cap: 748000, ltp: 848.00, score: 76.5, netFlow: 540.0, ret: 5.42, b: 1410, s: 80 },
  { isin: 'INE094A01015', sym: 'CUPID', bse: '538418', name: 'Cupid Ltd', sec: 'Healthcare & Pharma', cap: 3100, ltp: 285.99, score: 71.2, netFlow: 184.0, ret: 9.01, b: 840, s: 40 }
];

function generate1600StocksAnd2000Schemes() {
  console.log('[Dataset Generator] Starting generation of 1,650+ stocks and 2,000+ MF schemes...');

  const insertSym = db.prepare('INSERT OR REPLACE INTO symbol_master (isin, nse_symbol, bse_symbol, company_name, sector, market_cap_cr, ltp) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertStockScore = db.prepare('INSERT OR REPLACE INTO stock_weightage_score (isin, month, timeframe, weightage_score, net_flow_cr, breadth_score_norm, pct_increase_holding, velocity_multiplier, net_buyers, net_sellers) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  const monthStr = '2026-08';
  const timeframes = ['1M', '3M', '6M', '1Y'];

  db.transaction(() => {
    // 1. Insert Base Stocks
    for (const b of BASE_STOCKS) {
      insertSym.run(b.isin, b.sym, b.bse, b.name, b.sec, b.cap, b.ltp);
      for (const tf of timeframes) {
        const tfMult = tf === '1M' ? 1.0 : (tf === '3M' ? 1.5 : (tf === '6M' ? 2.3 : 3.8));
        const adjRet = Number((b.ret * (tf === '1M' ? 1.0 : (tf === '3M' ? 2.1 : (tf === '6M' ? 3.8 : 6.2)))).toFixed(2));
        const adjFlow = Number((b.netFlow * tfMult).toFixed(1));
        const adjScore = Math.min(99.9, Number((b.score * (tf === '1M' ? 1.0 : 1.02)).toFixed(1)));
        insertStockScore.run(b.isin, monthStr, tf, adjScore, adjFlow, 85, adjRet, 1.15, b.b, b.s);
      }
    }

    // 2. Generate 1,650 Listed Equities
    const prefixes = ['TATA', 'ADANI', 'BIRLA', 'RELIANCE', 'MAHINDRA', 'BAJAJ', 'GODREJ', 'JINDAL', 'APOLLO', 'BHARTI', 'L&T', 'KOTAK', 'HDFC', 'ICICI', 'SHREE', 'MUTHOOT', 'KPIT', 'CYIENT', 'CEAT', 'SRF'];
    const suffixes = ['INDIA', 'TECH', 'FINANCE', 'POWER', 'MOTORS', 'CHEMICALS', 'GLOBAL', 'ENERGY', 'INFRA', 'PHARMA', 'LOGISTICS', 'LABS', 'INDUSTRIES', 'CORP', 'ENTERPRISES', 'SYSTEMS', 'DIGITAL', 'SOLUTIONS'];

    let count = BASE_STOCKS.length;
    for (let i = 1; i <= 1650; i++) {
      const p = prefixes[i % prefixes.length];
      const s = suffixes[Math.floor(i / prefixes.length) % suffixes.length];
      const sym = `${p}_${s}_${i}`;
      const isin = `INE${String(i).padStart(9, '0')}`;
      const bse = String(500000 + i);
      const name = `${p} ${s} India Ltd #${i}`;
      const sec = SECTORS[i % SECTORS.length];
      const cap = Number((500 + (i * 147.5) % 850000).toFixed(0));
      const ltp = Number((40 + (i * 37.8) % 4500).toFixed(2));

      insertSym.run(isin, sym, bse, name, sec, cap, ltp);

      const baseScore = Number((15 + (i * 13.7) % 80).toFixed(1));
      const netFlow = Number((10 + (i * 29.4) % 1800).toFixed(1));
      const bBuyers = 250 + ((i * 37) % 1500); // 250 to 1,750 buying mutual fund schemes
      const bSellers = 10 + ((i * 11) % 110);   // 10 to 120 selling mutual fund schemes
      const ret = Number((-5 + (i * 7.3) % 45).toFixed(2));

      for (const tf of timeframes) {
        const tfMult = tf === '1M' ? 1.0 : (tf === '3M' ? 1.6 : (tf === '6M' ? 2.4 : 4.0));
        const adjRet = Number((ret * (tf === '1M' ? 1.0 : (tf === '3M' ? 2.0 : (tf === '6M' ? 3.5 : 5.8)))).toFixed(2));
        const adjFlow = Number((netFlow * tfMult).toFixed(1));
        const adjScore = Math.min(99.9, Number((baseScore * (tf === '1M' ? 1.0 : 1.01)).toFixed(1)));
        insertStockScore.run(isin, monthStr, tf, adjScore, adjFlow, 50, adjRet, 1.0, bBuyers, bSellers);
      }
      count++;
    }

    console.log(`[Dataset Generator] Successfully inserted ${count} listed equity stocks into symbol_master & stock_weightage_score.`);

    // 3. Seed 24 AMCs & 2,000 Mutual Fund Schemes
    const insertInst = db.prepare('INSERT OR REPLACE INTO institutes (institute_id, name, total_schemes, total_aum_cr) VALUES (?, ?, ?, ?)');
    const insertScheme = db.prepare('INSERT OR REPLACE INTO schemes (scheme_id, institute_id, scheme_name, scheme_aum_cr, category) VALUES (?, ?, ?, ?, ?)');
    const insertInstScore = db.prepare('INSERT OR REPLACE INTO institute_growth_score (institute_id, month, timeframe, growth_score, aum_growth_pct, deployment_ratio, new_position_count, exit_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertSchemeScore = db.prepare('INSERT OR REPLACE INTO scheme_growth_score (scheme_id, month, timeframe, growth_score, aum_growth_pct, deployment_ratio, new_position_count, exit_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    for (let instIdx = 0; instIdx < AMC_NAMES.length; instIdx++) {
      const instId = `INST${String(instIdx + 1).padStart(2, '0')}`;
      const amcName = AMC_NAMES[instIdx];
      const totalSchemes = 80 + (instIdx * 5);
      const totalAum = 45000 + (instIdx * 35000);

      insertInst.run(instId, amcName, totalSchemes, totalAum);

      for (const tf of timeframes) {
        insertInstScore.run(instId, monthStr, tf, Number((70 + instIdx * 0.9).toFixed(1)), 8.5, 0.045, 6, 0.008);
      }

      // Generate ~85 schemes per AMC = 2,040 schemes total!
      for (let sIdx = 1; sIdx <= 85; sIdx++) {
        const schemeId = `SCH_${instId}_${sIdx}`;
        const stType = SCHEME_TYPES[sIdx % SCHEME_TYPES.length];
        const schemeName = `${amcName.replace(' Mutual Fund', '')} ${stType}`;
        const schemeAum = Number((1200 + (sIdx * 480)).toFixed(0));
        const category = stType.split(' ')[0] + ' Cap';

        insertScheme.run(schemeId, instId, schemeName, schemeAum, category);

        for (const tf of timeframes) {
          const sScore = Number((65 + (sIdx * 0.35) % 32).toFixed(1));
          insertSchemeScore.run(schemeId, monthStr, tf, sScore, 10.2, 0.052, 4, 0.006);
        }
      }
    }

    console.log('[Dataset Generator] Successfully inserted 24 AMCs and 2,040 Mutual Fund Schemes into institutes & schemes database.');

  })();
}

generate1600StocksAnd2000Schemes();
