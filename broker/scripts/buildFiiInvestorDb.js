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

console.log('[FII] Starting FII/Investor database build...');

// Remove old DB
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('[FII] Removed old database');
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
`);

console.log('[FII] Schema created');

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
    sources: db.prepare('SELECT * FROM source_status').all()
  };
  
  console.log('\n[FII] ═══════════════════════════════════════');
  console.log('[FII] BUILD COMPLETE');
  console.log('[FII] ═══════════════════════════════════════');
  console.log(`  FII/DII Daily Records: ${stats.fiiDiiDaily}`);
  console.log(`  Company Shareholding Records: ${stats.shareholding}`);
  console.log(`  Individual Investors: ${stats.investors}`);
  console.log(`  Investor Holdings: ${stats.investorHoldings}`);
  console.log('\n  Source Status:');
  stats.sources.forEach(s => {
    console.log(`    ${s.sourceName}: ${s.status} (${s.recordCount} records)`);
  });
  
  db.close();
  console.log(`\n[FII] Database saved to: ${DB_PATH}`);
  console.log(`[FII] File size: ${(fs.statSync(DB_PATH).size / 1024).toFixed(1)} KB`);
}

main().catch(console.error);
