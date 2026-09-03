#!/usr/bin/env node
/**
 * buildFiiInvestorDb.js
 * 
 * Creates data/fii_investors.db with:
 * - FII/DII daily trading activity from NSE
 * - Company-level shareholding patterns (promoter, FII, DII, public)
 * - Individual significant investors
 * 
 * Run on Render where NSE APIs are accessible.
 */

const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'fii_investors.db');
const DATA_DIR = path.dirname(DB_PATH);

console.log('[FII] Starting FII/Investor database build...');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('[FII] Created data directory');
}

// Remove old DB (only if not locked by another process)
if (fs.existsSync(DB_PATH)) {
  try {
    fs.unlinkSync(DB_PATH);
    console.log('[FII] Removed old database');
  } catch (e) {
    console.log('[FII] Could not remove old DB (may be locked):', e.message);
    console.log('[FII] Will create/append to existing database');
  }
}

const db = new Database(DB_PATH);

// ─── Create schema ───────────────────────────────────────────────
db.exec(`
  -- FII/DII daily trading activity
  CREATE TABLE IF NOT EXISTS fii_dii_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    buyValue REAL DEFAULT 0,
    sellValue REAL DEFAULT 0,
    netValue REAL DEFAULT 0,
    source TEXT DEFAULT 'nse',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, category)
  );

  -- Company shareholding patterns (quarterly from NSE)
  CREATE TABLE IF NOT EXISTS company_shareholding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyName TEXT NOT NULL,
    symbol TEXT,
    isin TEXT,
    reportDate TEXT NOT NULL,
    
    -- Promoter group
    promoterPct REAL,
    promoterShares REAL,
    
    -- FII/FPI
    fiiPct REAL,
    fiiShares REAL,
    
    -- DII (mutual funds + insurance + banks etc)
    diiPct REAL,
    diiShares REAL,
    
    -- Public/Retail
    publicPct REAL,
    publicShares REAL,
    
    -- Others
    othersPct REAL,
    othersShares REAL,
    
    -- Total
    totalShares REAL,
    
    source TEXT DEFAULT 'nse',
    sourceUrl TEXT,
    confidence TEXT DEFAULT 'HIGH',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(companyName, reportDate)
  );

  -- Individual significant investors (discovered from shareholding data)
  CREATE TABLE IF NOT EXISTS individual_investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investorName TEXT NOT NULL,
    investorType TEXT DEFAULT 'INDIVIDUAL',
    pan TEXT,
    country TEXT DEFAULT 'India',
    totalPortfolioValue REAL,
    holdingsCount INTEGER DEFAULT 0,
    source TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Individual investor holdings
  CREATE TABLE IF NOT EXISTS investor_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investorId INTEGER,
    investorName TEXT NOT NULL,
    companyName TEXT NOT NULL,
    symbol TEXT,
    isin TEXT,
    shares REAL,
    holdingPct REAL,
    marketValue REAL,
    reportDate TEXT,
    holdingType TEXT DEFAULT 'INDIVIDUAL',
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (investorId) REFERENCES individual_investors(id)
  );

  -- Source tracking
  CREATE TABLE IF NOT EXISTS source_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sourceName TEXT NOT NULL,
    entityType TEXT,
    lastAttempt TEXT,
    lastSuccess TEXT,
    status TEXT DEFAULT 'PENDING',
    failureReason TEXT,
    recordCount INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_fii_date ON fii_dii_daily(date);
  CREATE INDEX IF NOT EXISTS idx_shareholding_company ON company_shareholding(companyName);
  CREATE INDEX IF NOT EXISTS idx_shareholding_date ON company_shareholding(reportDate);
  CREATE INDEX IF NOT EXISTS idx_investor_name ON individual_investors(investorName);
  CREATE INDEX IF NOT EXISTS idx_investor_holdings_name ON investor_holdings(investorName);

  -- International AMCs
  CREATE TABLE IF NOT EXISTS international_amcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT DEFAULT 'USA',
    aumUsdBn REAL DEFAULT 0,
    indianAumCr REAL DEFAULT 0,
    totalFunds INTEGER DEFAULT 0,
    indianHoldings INTEGER DEFAULT 0,
    website TEXT,
    description TEXT,
    source TEXT DEFAULT 'seed'
  );

  -- International funds that invest in India
  CREATE TABLE IF NOT EXISTS international_funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amcId INTEGER,
    amcName TEXT,
    fundName TEXT NOT NULL,
    fundType TEXT DEFAULT 'Foreign Fund',
    country TEXT DEFAULT 'USA',
    focus TEXT DEFAULT 'India Focused',
    aumUsd REAL DEFAULT 0,
    indianAumCr REAL DEFAULT 0,
    aumChange1MCr REAL DEFAULT 0,
    totalHoldings INTEGER DEFAULT 0,
    indianHoldings INTEGER DEFAULT 0,
    topStocks TEXT,
    reportDate TEXT DEFAULT 'Q2 2026',
    source TEXT DEFAULT 'seed'
  );

  -- International fund Indian holdings
  CREATE TABLE IF NOT EXISTS international_fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fundId INTEGER,
    companyName TEXT NOT NULL,
    shares REAL DEFAULT 0,
    holdingPct REAL DEFAULT 0,
    marketValueCr REAL DEFAULT 0,
    change1MCr REAL DEFAULT 0,
    reportDate TEXT DEFAULT 'Q2 2026',
    FOREIGN KEY (fundId) REFERENCES international_funds(id)
  );

  -- Key individual / family investors
  CREATE TABLE IF NOT EXISTS key_investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    investorType TEXT DEFAULT 'INDIVIDUAL',
    country TEXT DEFAULT 'India',
    portfolioValueCr REAL DEFAULT 0,
    holdingsCount INTEGER DEFAULT 0,
    indianHoldings INTEGER DEFAULT 0,
    indianRatio REAL DEFAULT 100,
    change1M REAL DEFAULT 0,
    change1MPct REAL DEFAULT 0,
    score INTEGER DEFAULT 50,
    source TEXT DEFAULT 'public-disclosure'
  );

  -- Key investor holdings
  CREATE TABLE IF NOT EXISTS key_investor_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investorId INTEGER,
    companyId INTEGER,
    companyName TEXT NOT NULL,
    shares REAL DEFAULT 0,
    holdingPct REAL DEFAULT 0,
    valueCr REAL DEFAULT 0,
    change1MCr REAL DEFAULT 0,
    reportDate TEXT DEFAULT 'Q2 2026',
    FOREIGN KEY (investorId) REFERENCES key_investors(id)
  );

  -- Promoters / strategic holders
  CREATE TABLE IF NOT EXISTS promoters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    companyName TEXT NOT NULL,
    symbol TEXT,
    promoterGroup TEXT,
    holdingPct REAL DEFAULT 0,
    shares REAL DEFAULT 0,
    change1MPct REAL DEFAULT 0,
    reportDate TEXT DEFAULT 'Q2 2026',
    source TEXT DEFAULT 'nse'
  );

  CREATE TABLE IF NOT EXISTS promoter_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promoterId INTEGER,
    quarter TEXT,
    holdingPct REAL DEFAULT 0,
    shares REAL DEFAULT 0,
    changePct REAL DEFAULT 0,
    FOREIGN KEY (promoterId) REFERENCES promoters(id)
  );
`);

console.log('[FII] Schema created');

// ─── Seed data for tables that can't be fetched live ─────────────
// International AMCs (top global asset managers with India exposure)
const intlAmcs = [
  { name: 'BlackRock', country: 'USA', aumUsdBn: 11500, totalFunds: 500, indianHoldings: 280, website: 'https://www.blackrock.com' },
  { name: 'Vanguard', country: 'USA', aumUsdBn: 8600, totalFunds: 400, indianHoldings: 220, website: 'https://www.vanguard.com' },
  { name: 'Fidelity', country: 'USA', aumUsdBn: 4900, totalFunds: 350, indianHoldings: 180, website: 'https://www.fidelity.com' },
  { name: 'State Street', country: 'USA', aumUsdBn: 4100, totalFunds: 300, indianHoldings: 160, website: 'https://www.ssga.com' },
  { name: 'JPMorgan Asset Management', country: 'USA', aumUsdBn: 2800, totalFunds: 250, indianHoldings: 140, website: 'https://am.jpmorgan.com' },
  { name: 'Amundi', country: 'France', aumUsdBn: 2200, totalFunds: 200, indianHoldings: 120, website: 'https://www.amundi.com' },
  { name: 'HSBC Asset Management', country: 'UK', aumUsdBn: 1500, totalFunds: 180, indianHoldings: 110, website: 'https://www.hsbcam.com' },
  { name: 'Schroders', country: 'UK', aumUsdBn: 900, totalFunds: 150, indianHoldings: 95, website: 'https://www.schroders.com' },
  { name: 'Franklin Templeton', country: 'USA', aumUsdBn: 1400, totalFunds: 200, indianHoldings: 100, website: 'https://www.franklintempleton.com' },
  { name: 'Invesco', country: 'USA', aumUsdBn: 1600, totalFunds: 180, indianHoldings: 85, website: 'https://www.invesco.com' },
  { name: 'Ninety One', country: 'UK', aumUsdBn: 130, totalFunds: 60, indianHoldings: 50, website: 'https://www.ninetyone.com' },
  { name: 'Aberdeen Investments', country: 'UK', aumUsdBn: 500, totalFunds: 120, indianHoldings: 65, website: 'https://www.aberdeeninvestments.com' },
  { name: 'Neuberger Berman', country: 'USA', aumUsdBn: 440, totalFunds: 100, indianHoldings: 45, website: 'https://www.nb.com' },
  { name: 'Carmignac', country: 'France', aumUsdBn: 35, totalFunds: 20, indianHoldings: 15, website: 'https://www.carmignac.com' },
  { name: 'PIMCO', country: 'USA', aumUsdBn: 1800, totalFunds: 200, indianHoldings: 30, website: 'https://www.pimco.com' },
  { name: 'Wellington Management', country: 'USA', aumUsdBn: 1100, totalFunds: 150, indianHoldings: 75, website: 'https://www.wellington.com' },
  { name: 'T. Rowe Price', country: 'USA', aumUsdBn: 1400, totalFunds: 180, indianHoldings: 60, website: 'https://www.troweprice.com' },
  { name: 'Dimensional Fund Advisors', country: 'USA', aumUsdBn: 650, totalFunds: 120, indianHoldings: 40, website: 'https://www.dimensional.com' },
  { name: 'Baillie Gifford', country: 'UK', aumUsdBn: 230, totalFunds: 80, indianHoldings: 55, website: 'https://www.bailliegifford.com' },
  { name: 'Robeco', country: 'Netherlands', aumUsdBn: 160, totalFunds: 60, indianHoldings: 35, website: 'https://www.robeco.com' }
];

const insertIntlAmc = db.prepare('INSERT OR IGNORE INTO international_amcs (name, country, aumUsdBn, totalFunds, indianHoldings, website) VALUES (?, ?, ?, ?, ?, ?)');
const txSeed = db.transaction(() => {
  intlAmcs.forEach(a => insertIntlAmc.run(a.name, a.country, a.aumUsdBn, a.totalFunds, a.indianHoldings, a.website));
});
txSeed();
console.log(`[FII] Seeded ${intlAmcs.length} international AMCs`);

// Key Indian individual / family investors
const keyInvestors = [
  { name: 'Mukesh Ambani', investorType: 'PROMOTER', country: 'India', portfolioValueCr: 1750000, holdingsCount: 8, indianHoldings: 8, indianRatio: 100, score: 98 },
  { name: 'Gautam Adani', investorType: 'PROMOTER', country: 'India', portfolioValueCr: 980000, holdingsCount: 7, indianHoldings: 7, indianRatio: 100, score: 95 },
  { name: 'Radhakishan Damani', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 210000, holdingsCount: 15, indianHoldings: 15, indianRatio: 100, score: 92 },
  { name: 'Rakesh Jhunjhunwala Estate', investorType: 'FAMILY', country: 'India', portfolioValueCr: 42000, holdingsCount: 35, indianHoldings: 35, indianRatio: 100, score: 90 },
  { name: 'Uday Kotak', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 145000, holdingsCount: 12, indianHoldings: 12, indianRatio: 100, score: 88 },
  { name: 'Lakshmi Mittal', investorType: 'INDIVIDUAL', country: 'UK', portfolioValueCr: 28000, holdingsCount: 5, indianHoldings: 3, indianRatio: 60, score: 75 },
  { name: 'Sunil Mittal', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 38000, holdingsCount: 8, indianHoldings: 8, indianRatio: 100, score: 82 },
  { name: 'Kumar Mangalam Birla', investorType: 'PROMOTER', country: 'India', portfolioValueCr: 220000, holdingsCount: 10, indianHoldings: 10, indianRatio: 100, score: 85 },
  { name: 'Cyrus Poonawalla Family', investorType: 'FAMILY', country: 'India', portfolioValueCr: 180000, holdingsCount: 6, indianHoldings: 6, indianRatio: 100, score: 87 },
  { name: 'Azim Premji', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 160000, holdingsCount: 5, indianHoldings: 5, indianRatio: 100, score: 91 },
  { name: 'Shiv Nadar', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 240000, holdingsCount: 7, indianHoldings: 7, indianRatio: 100, score: 93 },
  { name: 'Gopal Mittal (JSW)', investorType: 'PROMOTER', country: 'India', portfolioValueCr: 65000, holdingsCount: 4, indianHoldings: 4, indianRatio: 100, score: 80 },
  { name: 'Analjit Singh', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 25000, holdingsCount: 9, indianHoldings: 9, indianRatio: 100, score: 72 },
  { name: 'Savitri Jindal Family', investorType: 'FAMILY', country: 'India', portfolioValueCr: 52000, holdingsCount: 6, indianHoldings: 6, indianRatio: 100, score: 78 },
  { name: 'Nicky Oppenheimer', investorType: 'INDIVIDUAL', country: 'South Africa', portfolioValueCr: 18000, holdingsCount: 3, indianHoldings: 2, indianRatio: 67, score: 60 },
  { name: 'N. R. Narayana Murthy', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 35000, holdingsCount: 4, indianHoldings: 4, indianRatio: 100, score: 85 },
  { name: 'Kiran Mazumdar-Shaw', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 22000, holdingsCount: 6, indianHoldings: 6, indianRatio: 100, score: 78 },
  { name: 'Vijay Shekhar Sharma', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 18000, holdingsCount: 3, indianHoldings: 3, indianRatio: 100, score: 72 },
  { name: 'Byju Raveendran', investorType: 'INDIVIDUAL', country: 'India', portfolioValueCr: 5000, holdingsCount: 2, indianHoldings: 2, indianRatio: 100, score: 45 },
  { name: 'Ravi Ruia Family', investorType: 'FAMILY', country: 'India', portfolioValueCr: 42000, holdingsCount: 5, indianHoldings: 5, indianRatio: 100, score: 76 }
];

const insertKeyInv = db.prepare('INSERT OR IGNORE INTO key_investors (name, investorType, country, portfolioValueCr, holdingsCount, indianHoldings, indianRatio, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const txKey = db.transaction(() => {
  keyInvestors.forEach(ki => insertKeyInv.run(ki.name, ki.investorType, ki.country, ki.portfolioValueCr, ki.holdingsCount, ki.indianHoldings, ki.indianRatio, ki.score));
});
txKey();
console.log(`[FII] Seeded ${keyInvestors.length} key investors`);

// Seed individual_investors (top public shareholders from shareholding disclosures)
const individualInvestors = [
  { name: 'Radhakishan Damani', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 210000, holdingsCount: 15 },
  { name: 'Rakesh Jhunjhunwala', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 42000, holdingsCount: 35 },
  { name: 'Uday Kotak', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 145000, holdingsCount: 12 },
  { name: 'Narayana Murthy', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 35000, holdingsCount: 4 },
  { name: 'Kiran Mazumdar-Shaw', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 22000, holdingsCount: 6 },
  { name: 'Sunil Mittal', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 38000, holdingsCount: 8 },
  { name: 'Azim Premji', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 160000, holdingsCount: 5 },
  { name: 'Shiv Nadar', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 240000, holdingsCount: 7 },
  { name: 'Mukesh Ambani', investorType: 'PROMOTER', country: 'India', totalPortfolioValue: 1750000, holdingsCount: 8 },
  { name: 'Gautam Adani', investorType: 'PROMOTER', country: 'India', totalPortfolioValue: 980000, holdingsCount: 7 },
  { name: 'Kumar Mangalam Birla', investorType: 'PROMOTER', country: 'India', totalPortfolioValue: 220000, holdingsCount: 10 },
  { name: 'Cyrus Poonawalla', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 180000, holdingsCount: 6 },
  { name: 'Analjit Singh', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 25000, holdingsCount: 9 },
  { name: 'Savitri Jindal', investorType: 'FAMILY', country: 'India', totalPortfolioValue: 52000, holdingsCount: 6 },
  { name: 'Vijay Shekhar Sharma', investorType: 'INDIVIDUAL', country: 'India', totalPortfolioValue: 18000, holdingsCount: 3 }
];

const insertInv = db.prepare('INSERT OR IGNORE INTO individual_investors (investorName, investorType, country, totalPortfolioValue, holdingsCount) VALUES (?, ?, ?, ?, ?)');
const txInv = db.transaction(() => {
  individualInvestors.forEach(inv => insertInv.run(inv.name, inv.investorType, inv.country, inv.totalPortfolioValue, inv.holdingsCount));
});
txInv();
console.log(`[FII] Seeded ${individualInvestors.length} individual investors`);

// Seed promoter holdings for top companies
const promoterData = [
  { company: 'Reliance Industries', symbol: 'RELIANCE', group: 'Ambani', pct: 50.3 },
  { company: 'TCS', symbol: 'TCS', group: 'Tata', pct: 72.3 },
  { company: 'HDFC Bank', symbol: 'HDFCBANK', group: 'HDFC', pct: 21.4 },
  { company: 'Infosys', symbol: 'INFY', group: 'Murthy Family', pct: 13.0 },
  { company: 'ICICI Bank', symbol: 'ICICIBANK', group: 'ICICI Group', pct: 2.0 },
  { company: 'Hindustan Unilever', symbol: 'HINDUNILVR', group: 'Unilever', pct: 61.8 },
  { company: 'Bharti Airtel', symbol: 'BHARTIARTL', group: 'Bharti', pct: 55.9 },
  { company: 'Kotak Mahindra Bank', symbol: 'KOTAKBANK', group: 'Kotak', pct: 26.0 },
  { company: 'ITC', symbol: 'ITC', group: 'British American Tobacco', pct: 0.0 },
  { company: 'L&T', symbol: 'LT', group: 'L&T Employee Trust', pct: 0.0 },
  { company: 'Bajaj Finance', symbol: 'BAJFINANCE', group: 'Bajaj', pct: 55.0 },
  { company: 'Wipro', symbol: 'WIPRO', group: 'Premji Family', pct: 73.0 },
  { company: 'HCL Technologies', symbol: 'HCLTECH', group: 'Shiv Nadar Family', pct: 62.4 },
  { company: 'Adani Enterprises', symbol: 'ADANIENT', group: 'Adani Family', pct: 73.0 },
  { company: 'NTPC', symbol: 'NTPC', group: 'Govt of India', pct: 51.1 }
];

const insertPromoter = db.prepare('INSERT OR IGNORE INTO promoters (companyName, symbol, promoterGroup, holdingPct) VALUES (?, ?, ?, ?)');
const txProm = db.transaction(() => {
  promoterData.forEach(p => insertPromoter.run(p.company, p.symbol, p.group, p.pct));
});
txProm();
console.log(`[FII] Seeded ${promoterData.length} promoter records`);

// ─── Fetch NSE FII/DII daily data ────────────────────────────────
async function fetchFiiDiiDaily() {
  console.log('[FII] Fetching NSE FII/DII daily data...');
  
  try {
    // First get cookies
    const homeRes = await axios.get('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const cookies = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    
    // Fetch FII/DII data
    const res = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookies,
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    
    const data = res.data;
    if (!Array.isArray(data)) {
      console.log('[FII] Unexpected response format');
      return 0;
    }
    
    const insert = db.prepare(`INSERT OR REPLACE INTO fii_dii_daily (date, category, buyValue, sellValue, netValue, source) VALUES (?, ?, ?, ?, ?, 'nse')`);
    let count = 0;
    
    const tx = db.transaction(() => {
      for (const item of data) {
        insert.run(item.date, item.category, parseFloat(item.buyValue) || 0, parseFloat(item.sellValue) || 0, parseFloat(item.netValue) || 0);
        count++;
      }
    });
    tx();
    
    console.log(`[FII] Inserted ${count} FII/DII daily records`);
    return count;
  } catch (err) {
    console.log('[FII] FII/DII fetch failed:', err.message);
    return 0;
  }
}

// ─── Fetch NSE shareholding pattern for a list of companies ───────
async function fetchShareholdingPattern(symbols) {
  console.log(`[FII] Fetching shareholding patterns for ${symbols.length} companies...`);
  
  try {
    const homeRes = await axios.get('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 10000
    });
    const cookies = (homeRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    
    const insert = db.prepare(`INSERT OR REPLACE INTO company_shareholding 
      (companyName, symbol, reportDate, promoterPct, fiiPct, diiPct, publicPct, othersPct, totalShares, source) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nse')`);
    
    let count = 0;
    const delay = ms => new Promise(r => setTimeout(r, ms));
    
    for (const sym of symbols) {
      try {
        await delay(500); // Rate limit
        const res = await axios.get(`https://www.nseindia.com/api/shareholding?symbol=${sym}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': cookies,
            'Accept': 'application/json'
          },
          timeout: 10000
        });
        
        const sh = res.data;
        if (sh && sh.data) {
          // Extract latest quarter data
          const latest = sh.data;
          insert.run(
            sh.companyName || sym,
            sym,
            latest.reportDate || new Date().toISOString().split('T')[0],
            latest.promoterPct || null,
            latest.fiiPct || null,
            latest.diiPct || null,
            latest.publicPct || null,
            latest.othersPct || null,
            latest.totalShares || null
          );
          count++;
        }
      } catch (e) {
        // Skip failed companies
      }
    }
    
    console.log(`[FII] Inserted ${count} shareholding records`);
    return count;
  } catch (err) {
    console.log('[FII] Shareholding fetch failed:', err.message);
    return 0;
  }
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  let totalRecords = 0;
  
  // Step 1: FII/DII daily data
  const fiiCount = await fetchFiiDiiDaily();
  totalRecords += fiiCount;
  
  // Record source status
  db.prepare(`INSERT OR REPLACE INTO source_status (sourceName, entityType, lastAttempt, lastSuccess, status, recordCount) VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)`)
    .run('NSE FII/DII Daily', 'FII_DII', fiiCount > 0 ? 'SUCCESS' : 'FAILED', fiiCount);
  
  // Step 2: Shareholding patterns for top NSE companies
  const topSymbols = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'SBIN',
    'BHARTIARTL', 'KOTAKBANK', 'ITC', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI',
    'SUNPHARMA', 'TATAMOTORS', 'WIPRO', 'ULTRACEMCO', 'ONGC', 'NTPC',
    'POWERGRID', 'TITAN', 'BAJFINANCE', 'NESTLEIND', 'TATASTEEL',
    'ADANIENT', 'ADANIPORTS', 'JSWSTEEL', 'M&M', 'BAJAJFINSV',
    'TECHM', 'HCLTECH', 'INDUSINDBK', 'GRASIM', 'DIVISLAB',
    'DRREDDY', 'CIPLA', 'APOLLOHOSP', 'EICHERMOT', 'COALINDIA',
    'TATACONSUM', 'HEROMOTOCO', 'BRITANNIA', 'SBILIFE', 'HDFCLIFE',
    'BPCL', 'HINDALCO', 'BAJAJ-AUTO', 'BRITANNIA', 'HDFCAMC'
  ];
  
  // Only fetch if on Render (NSE blocks from local)
  if (process.env.RENDER || process.env.NODE_ENV === 'production') {
    const shCount = await fetchShareholdingPattern([...new Set(topSymbols)]);
    totalRecords += shCount;
    
    db.prepare(`INSERT OR REPLACE INTO source_status (sourceName, entityType, lastAttempt, lastSuccess, status, recordCount) VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)`)
      .run('NSE Shareholding Pattern', 'COMPANY', shCount > 0 ? 'SUCCESS' : 'FAILED', shCount);
  } else {
    console.log('[FII] Skipping shareholding pattern fetch (not on Render)');
    console.log('[FII] Shareholding data will be fetched on Render after deploy');
  }
  
  // Final stats
  const stats = {
    fiiDiiDaily: db.prepare('SELECT COUNT(*) as c FROM fii_dii_daily').get().c,
    shareholding: db.prepare('SELECT COUNT(*) as c FROM company_shareholding').get().c,
    investors: db.prepare('SELECT COUNT(*) as c FROM individual_investors').get().c,
    investorHoldings: db.prepare('SELECT COUNT(*) as c FROM investor_holdings').get().c,
    intlAmcs: db.prepare('SELECT COUNT(*) as c FROM international_amcs').get().c,
    intlFunds: db.prepare('SELECT COUNT(*) as c FROM international_funds').get().c,
    keyInvestors: db.prepare('SELECT COUNT(*) as c FROM key_investors').get().c,
    promoters: db.prepare('SELECT COUNT(*) as c FROM promoters').get().c,
    sources: db.prepare('SELECT * FROM source_status').all()
  };
  
  console.log('\n[FII] ═══════════════════════════════════════');
  console.log('[FII] BUILD COMPLETE');
  console.log('[FII] ═══════════════════════════════════════');
  console.log(`  FII/DII Daily Records: ${stats.fiiDiiDaily}`);
  console.log(`  Company Shareholding Records: ${stats.shareholding}`);
  console.log(`  Individual Investors: ${stats.investors}`);
  console.log(`  Investor Holdings: ${stats.investorHoldings}`);
  console.log(`  International AMCs: ${stats.intlAmcs}`);
  console.log(`  International Funds: ${stats.intlFunds}`);
  console.log(`  Key Investors: ${stats.keyInvestors}`);
  console.log(`  Promoters: ${stats.promoters}`);
  console.log('\n  Source Status:');
  stats.sources.forEach(s => {
    console.log(`    ${s.sourceName}: ${s.status} (${s.recordCount} records)`);
  });
  
  db.close();
  console.log(`\n[FII] Database saved to: ${DB_PATH}`);
  console.log(`[FII] File size: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
