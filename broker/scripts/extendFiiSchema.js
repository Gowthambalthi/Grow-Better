#!/usr/bin/env node
/**
 * extendFiiSchema.js
 * Extends fii_investors.db with all 7 sections of the FII & Investors module.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'fii_investors.db');

if (!fs.existsSync(DB_PATH)) {
  console.log('[FII] fii_investors.db not found. Run buildFiiInvestorDb.js first.');
  process.exit(1);
}

const db = new Database(DB_PATH);
console.log('[FII] Extending schema...');

db.exec(`
  -- ═══ COMPANY MASTER ═══════════════════════════════════════════════
  -- Central company table that all sections link to
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalizedName TEXT NOT NULL,
    isin TEXT,
    ticker TEXT,
    exchange TEXT,
    sector TEXT,
    industry TEXT,
    country TEXT DEFAULT 'India',
    marketCap REAL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_normalized ON companies(normalizedName);
  CREATE INDEX IF NOT EXISTS idx_companies_isin ON companies(isin);

  -- ═══ SECTION 4: INTERNATIONAL AMCs ═══════════════════════════════
  CREATE TABLE IF NOT EXISTS international_amcs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalizedName TEXT NOT NULL,
    country TEXT,
    headquarters TEXT,
    website TEXT,
    aumUsdBn REAL,
    indiaExposurePct REAL,
    knownIndiaFunds INTEGER DEFAULT 0,
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_intl_amc_name ON international_amcs(normalizedName);

  -- ═══ SECTION 5: INTERNATIONAL FUNDS / ETFs ═══════════════════════
  CREATE TABLE IF NOT EXISTS international_funds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amcId INTEGER,
    amcName TEXT,
    fundName TEXT NOT NULL,
    fundType TEXT DEFAULT 'MUTUAL_FUND',
    domicile TEXT,
    currency TEXT DEFAULT 'USD',
    isin TEXT,
    aumUsd REAL,
    indiaAllocationPct REAL,
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (amcId) REFERENCES international_amcs(id)
  );

  CREATE TABLE IF NOT EXISTS international_fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fundId INTEGER NOT NULL,
    companyId INTEGER,
    companyName TEXT NOT NULL,
    isin TEXT,
    shares REAL,
    holdingPct REAL,
    marketValueUsd REAL,
    marketValueInr REAL,
    reportDate TEXT,
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (fundId) REFERENCES international_funds(id),
    FOREIGN KEY (companyId) REFERENCES companies(id)
  );
  CREATE INDEX IF NOT EXISTS idx_intl_holdings_fund ON international_fund_holdings(fundId);
  CREATE INDEX IF NOT EXISTS idx_intl_holdings_company ON international_fund_holdings(companyId);

  -- ═══ SECTION 6: KEY INVESTORS ════════════════════════════════════
  CREATE TABLE IF NOT EXISTS key_investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalizedName TEXT NOT NULL,
    investorType TEXT DEFAULT 'INDIVIDUAL',
    country TEXT DEFAULT 'India',
    description TEXT,
    totalPortfolioValueInr REAL,
    holdingsCount INTEGER DEFAULT 0,
    avgHoldingPct REAL,
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_key_investor_name ON key_investors(normalizedName);

  CREATE TABLE IF NOT EXISTS key_investor_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investorId INTEGER NOT NULL,
    companyId INTEGER,
    companyName TEXT NOT NULL,
    isin TEXT,
    shares REAL,
    holdingPct REAL,
    marketValueInr REAL,
    reportDate TEXT,
    holdingType TEXT DEFAULT 'DIRECT',
    source TEXT,
    confidence TEXT DEFAULT 'MEDIUM',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (investorId) REFERENCES key_investors(id),
    FOREIGN KEY (companyId) REFERENCES companies(id)
  );
  CREATE INDEX IF NOT EXISTS idx_key_holdings_investor ON key_investor_holdings(investorId);
  CREATE INDEX IF NOT EXISTS idx_key_holdings_company ON key_investor_holdings(companyId);

  -- ═══ SECTION 7: PROMOTERS / STRATEGIC HOLDERS ════════════════════
  CREATE TABLE IF NOT EXISTS promoters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalizedName TEXT NOT NULL,
    promoterType TEXT DEFAULT 'PROMOTER',
    country TEXT DEFAULT 'India',
    companiesHolding INTEGER DEFAULT 0,
    totalShares REAL DEFAULT 0,
    totalValueInr REAL DEFAULT 0,
    source TEXT,
    confidence TEXT DEFAULT 'HIGH',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_promoter_name ON promoters(normalizedName);

  CREATE TABLE IF NOT EXISTS promoter_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promoterId INTEGER NOT NULL,
    companyId INTEGER,
    companyName TEXT NOT NULL,
    isin TEXT,
    shares REAL,
    holdingPct REAL,
    previousPct REAL,
    changePct REAL,
    marketValueInr REAL,
    reportDate TEXT,
    holdingType TEXT DEFAULT 'PROMOTER',
    source TEXT,
    confidence TEXT DEFAULT 'HIGH',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (promoterId) REFERENCES promoters(id),
    FOREIGN KEY (companyId) REFERENCES companies(id)
  );
  CREATE INDEX IF NOT EXISTS idx_promoter_holdings_promoter ON promoter_holdings(promoterId);
  CREATE INDEX IF NOT EXISTS idx_promoter_holdings_company ON promoter_holdings(companyId);

  -- ═══ SEED DATA: Major International AMCs ═════════════════════════
`);

// Seed international AMCs
const seedAmcs = [
  { name: 'BlackRock', country: 'USA', website: 'https://www.blackrock.com', aum: 10000 },
  { name: 'Vanguard', country: 'USA', website: 'https://www.vanguard.com', aum: 8500 },
  { name: 'Fidelity Investments', country: 'USA', website: 'https://www.fidelity.com', aum: 4500 },
  { name: 'State Street Global Advisors', country: 'USA', website: 'https://www.ssga.com', aum: 3500 },
  { name: 'JP Morgan Asset Management', country: 'USA', website: 'https://www.jpmorgan.com/asset-management', aum: 2800 },
  { name: 'Amundi', country: 'France', website: 'https://www.amundi.com', aum: 2100 },
  { name: 'HSBC Asset Management', country: 'UK', website: 'https://www.hsbc.com/asset-management', aum: 900 },
  { name: 'Schroders', country: 'UK', website: 'https://www.schroders.com', aum: 700 },
  { name: 'Invesco', country: 'USA', website: 'https://www.invesco.com', aum: 1600 },
  { name: 'Franklin Templeton', country: 'USA', website: 'https://www.franklintempleton.com', aum: 1500 },
  { name: 'Ninety One', country: 'South Africa', website: 'https://www.ninetyone.com', aum: 120 },
  { name: 'Aberdeen Investments', country: 'UK', website: 'https://www.aberdeeninvestments.com', aum: 500 },
  { name: 'Dimensional Fund Advisors', country: 'USA', website: 'https://www.dimensional.com', aum: 700 },
  { name: 'T. Rowe Price', country: 'USA', website: 'https://www.troweprice.com', aum: 1400 },
  { name: 'PIMCO', country: 'USA', website: 'https://www.pimco.com', aum: 1800 },
  { name: 'Nomura Asset Management', country: 'Japan', website: 'https://www.nomura-am.co.jp', aum: 500 },
  { name: 'Nikko Asset Management', country: 'Japan', website: 'https://www.nikkoam.com', aum: 200 },
  { name: 'Mirae Asset Global Investments', country: 'South Korea', website: 'https://www.miraeasset.com', aum: 200 },
  { name: 'GMO', country: 'USA', website: 'https://www.gmo.com', aum: 600 },
  { name: 'Baillie Gifford', country: 'UK', website: 'https://www.bailliegifford.com', aum: 250 },
];

const insertAmc = db.prepare(`INSERT OR IGNORE INTO international_amcs (name, normalizedName, country, website, aumUsdBn) VALUES (?, ?, ?, ?, ?)`);
const tx = db.transaction(() => {
  for (const a of seedAmcs) {
    insertAmc.run(a.name, a.name.toUpperCase(), a.country, a.website, a.aum);
  }
});
tx();
console.log(`[FII] Seeded ${seedAmcs.length} international AMCs`);

// Seed some known promoters
const seedPromoters = [
  { name: 'Mukesh Ambani Group', type: 'PROMOTER' },
  { name: 'Tata Group', type: 'PROMOTER' },
  { name: 'Bajaj Group', type: 'PROMOTER' },
  { name: 'Aditya Birla Group', type: 'PROMOTER' },
  { name: 'Murugappa Group', type: 'PROMOTER' },
  { name: 'Godrej Group', type: 'PROMOTER' },
  { name: 'Larsen & Toubro Group', type: 'PROMOTER' },
  { name: 'Infosys Founders', type: 'PROMOTER' },
  { name: 'Wipro (Azim Premji)', type: 'PROMOTER' },
  { name: 'HCL (Shiv Nadar)', type: 'PROMOTER' },
  { name: 'Sun Pharma (Dilip Shanghvi)', type: 'PROMOTER' },
  { name: 'ITC (British American Tobacco)', type: 'STRATEGIC' },
  { name: 'HDFC Bank (foreign investors)', type: 'STRATEGIC' },
  { name: 'JSW Group (Sajjan Jindal)', type: 'PROMOTER' },
  { name: 'Adani Group (Gautam Adani)', type: 'PROMOTER' },
];

const insertPromoter = db.prepare(`INSERT OR IGNORE INTO promoters (name, normalizedName, promoterType, country) VALUES (?, ?, ?, 'India')`);
const tx2 = db.transaction(() => {
  for (const p of seedPromoters) {
    insertPromoter.run(p.name, p.name.toUpperCase(), p.type);
  }
});
tx2();
console.log(`[FII] Seeded ${seedPromoters.length} promoters`);

// Final stats
const stats = {
  companies: db.prepare('SELECT COUNT(*) as c FROM companies').get().c,
  amcs: db.prepare('SELECT COUNT(*) as c FROM international_amcs').get().c,
  intlFunds: db.prepare('SELECT COUNT(*) as c FROM international_funds').get().c,
  intlHoldings: db.prepare('SELECT COUNT(*) as c FROM international_fund_holdings').get().c,
  keyInvestors: db.prepare('SELECT COUNT(*) as c FROM key_investors').get().c,
  keyHoldings: db.prepare('SELECT COUNT(*) as c FROM key_investor_holdings').get().c,
  promoters: db.prepare('SELECT COUNT(*) as c FROM promoters').get().c,
  promoterHoldings: db.prepare('SELECT COUNT(*) as c FROM promoter_holdings').get().c,
};

console.log('\n[FII] Schema extended. Current counts:');
console.log(`  Companies: ${stats.companies}`);
console.log(`  International AMCs: ${stats.amcs}`);
console.log(`  International Funds: ${stats.intlFunds}`);
console.log(`  International Fund Holdings: ${stats.intlHoldings}`);
console.log(`  Key Investors: ${stats.keyInvestors}`);
console.log(`  Key Investor Holdings: ${stats.keyHoldings}`);
console.log(`  Promoters: ${stats.promoters}`);
console.log(`  Promoter Holdings: ${stats.promoterHoldings}`);

db.close();
console.log(`\n[FII] Done. DB: ${DB_PATH}`);
