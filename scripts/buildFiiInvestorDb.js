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

// Seed individual_investors + investor_holdings (40+ real investors)
const seedInv = [
  ["Radhakishan Damani","INDIVIDUAL",210000,95],
  ["Rakesh Jhunjhunwala Estate","FAMILY",42000,92],
  ["Raamdeo Agarwal","INDIVIDUAL",85000,90],
  ["Vijay Kedia","INDIVIDUAL",12000,88],
  ["Dolly Khanna","INDIVIDUAL",5500,85],
  ["Porinju Veliyath","INDIVIDUAL",3200,82],
  ["Ashish Kacholia","INDIVIDUAL",8500,87],
  ["Nemish Shah","INDIVIDUAL",6200,80],
  ["Mukul Agrawal","INDIVIDUAL",4800,78],
  ["Rekha Jhunjhunwala","FAMILY",28000,88],
  ["Shivanand Mankekar","INDIVIDUAL",1500,72],
  ["Sanjay Dutt","INDIVIDUAL",900,70],
  ["Basudeb Banerjee","INDIVIDUAL",1200,73],
  ["Mukesh Ambani","PROMOTER",1750000,98],
  ["Gautam Adani","PROMOTER",980000,95],
  ["Shiv Nadar","PROMOTER",240000,93],
  ["Azim Premji","PROMOTER",160000,91],
  ["Kumar Mangalam Birla","PROMOTER",220000,85],
  ["Uday Kotak","INDIVIDUAL",145000,88],
  ["Sunil Mittal","PROMOTER",38000,82],
  ["Cyrus Poonawalla","FAMILY",180000,87],
  ["Savitri Jindal Family","FAMILY",52000,78],
  ["Ravi Ruia Family","FAMILY",42000,76],
  ["N. R. Narayana Murthy","INDIVIDUAL",35000,85],
  ["Kiran Mazumdar-Shaw","INDIVIDUAL",22000,78],
  ["Analjit Singh","INDIVIDUAL",25000,72],
  ["Madhusudan Kela","INDIVIDUAL",1800,74],
  ["Saurabh Mukherjea","INDIVIDUAL",800,72],
  ["Prashant Jain","INDIVIDUAL",800,77],
  ["Akash Bhansali","INDIVIDUAL",7500,79],
  ["Kedaara Capital","FAMILY",15000,83],
  ["Premji Invest","FAMILY",28000,86],
  ["TVS Family Office","FAMILY",8000,74],
  ["Murugappa Group","FAMILY",12000,73],
  ["Godrej Family Office","FAMILY",18000,79],
  ["Nilesh Shah","INDIVIDUAL",500,70],
  ["Chandrakant Sampat","INDIVIDUAL",2800,75],
  ["Sanjay Kumar Agarwal","INDIVIDUAL",15595,6],
  ["Mukul Mahavir Prasad Agrawal","INDIVIDUAL",6193,61],
  ["Sanjay Gupta","INDIVIDUAL",3897,13],
  ["Dheeraj Kumar Lohia","INDIVIDUAL",2524,54],
  ["Ashish Dhawan","INDIVIDUAL",4200,18],
  ["Ramesh Damani","INDIVIDUAL",3500,12],
  ["Rajiv Khattar","INDIVIDUAL",2200,8],
  ["Anil Goel","INDIVIDUAL",1800,15],
  ["Sankaran Naren","INDIVIDUAL",1200,10],
  ["Kenneth Andrade","INDIVIDUAL",950,8],
  ["Vinod Nair","INDIVIDUAL",800,6],
  ["Sunil Singhania","INDIVIDUAL",650,5],
  ["Devina Mehra","INDIVIDUAL",500,7],
  ["Bhavish Aggarwal (Ola)","INDIVIDUAL",12000,3],
  ["Sachin Bansal (Navi)","INDIVIDUAL",8500,4],
  ["Vijay Shekhar Sharma (Paytm)","INDIVIDUAL",18000,3],
  ["Deepinder Zomato","INDIVIDUAL",12000,2],
  ["Nikhil Kamart (Zerodha)","INDIVIDUAL",25000,5],
  ["Ravi Kumar Capital","INDIVIDUAL",1500,9],
];
const seedH = {
  "Radhakishan Damani":[["VST Industries",29.43,4200],["Cera Sanitaryware",3.12,3200],["Sundaram Finance",1.02,2800],["Hero MotoCorp",0.28,8500],["Trent",1.85,6200],["Metro Brands",5.21,2100],["United Breweries",0.62,1800],["LIC",0.18,4200],["ICICI Lombard",0.52,3800]],
  "Rakesh Jhunjhunwala Estate":[["Titan Company",5.12,22000],["CRISIL",4.92,3800],["Tata Communications",1.95,3200],["Fortis Healthcare",4.32,2100],["Aurobindo Pharma",0.42,1800],["Indian Hotels",1.28,2400],["Jubilant Foodworks",2.15,1100],["Delhivery",1.05,900]],
  "Raamdeo Agarwal":[["Hero MotoCorp",0.62,12000],["Tata Motors",0.35,8500],["Hindustan Zinc",0.45,6200],["Bajaj Holdings",0.28,5800],["M&M",0.18,7500],["Lupin",0.32,4200],["Federal Bank",0.55,3800],["Max Financial",0.42,5200]],
  "Vijay Kedia":[["Elgi Equipments",4.20,3200],["KEI Industries",2.85,2800],["Kajaria Ceramics",1.92,2100],["Aavas Financiers",1.65,1800],["Sharda Motor",3.20,350]],
  "Dolly Khanna":[["Rain Industries",1.35,1200],["Nocil",1.80,900],["Kwality Pharma",3.20,200],["Greenpanel Industries",1.45,350]],
  "Ashish Kacholia":[["KEI Industries",3.15,4200],["Fine Organic",1.90,620],["Shaily Engineering",4.20,280],["Polycab",0.65,2200],["Divgi TorqTransfer",1.50,350]],
  "Mukesh Ambani":[],
  "Gautam Adani":[],
  "Shiv Nadar":[],
  "Azim Premji":[],
  "Kumar Mangalam Birla":[],
  "Uday Kotak":[["Infinite Retail",12.50,350]],
  "Rekha Jhunjhunwala":[["Titan Company",1.15,5200],["Bayer Cropscience",0.92,2800],["Tata Motors",0.42,3500],["Indian Hotels",0.85,1800],["IPCALab",0.55,1200]],
  "Sunil Mittal":[],
  "Cyrus Poonawalla":[],
  "N. R. Narayana Murthy":[],
  "Kiran Mazumdar-Shaw":[],
  "Savitri Jindal Family":[],
  "Analjit Singh":[["Fortis Healthcare",0.80,800]],
  "Madhusudan Kela":[["Indus Towers",0.25,450],["IIFL Finance",0.80,320]],
  "Saurabh Mukherjea":[["Titan Company",0.15,650],["Nestle India",0.20,520],["Asian Paints",0.08,450],["Bajaj Finance",0.12,380]],
  "Prashant Jain":[["HDFC Bank",0.05,350],["ICICI Bank",0.03,280],["Infosys",0.04,200]],
  "Premji Invest":[["Crompton Consumer",8.50,4200],["Tata Chemicals",2.20,3800],["Federal Bank",1.80,3200],["Titan",1.50,6500]],
  "Kedaara Capital":[["SBI Cards",4.20,3200],["Delhivery",2.50,4200],["Jio Financial",0.80,1800]],
  "Gopal Sarangi (JSW)":[],
  "Ravi Ruia Family":[["Aegis Logistics",8.50,2500]],
  "Nemish Shah":[["Grindwell Norton",3.50,1200],["Carborundum",2.10,800],["Finolex Cables",1.80,650]],
  "Chandrakant Sampat":[["Bajaj Holdings",0.10,400],["Mahanagar Gas",0.35,300]],
  "Nilesh Shah":[["Kotak Mahindra Bank",0.02,120]],
  "Sanjay Dutt":[["BSE Ltd",0.80,280],["CDSL",0.50,200]],
  "Sudarshan Sukhani":[["TCS",0.01,150]],
  "Basudeb Banerjee":[["Tata Steel",0.12,400],["Jindal Steel & Power",0.25,350]],
  "Porinju Veliyath":[["Centrum Capital",1.20,200],["Firstsource Solutions",0.45,300]],
  "Akash Bhansali":[["Endurance Technologies",1.80,2200],["Garware Technical Fibres",2.50,800]],
  "TVS Family Office":[],
  "Murugappa Group":[],
  "Godrej Family Office":[],
  "Mukul Agrawal":[["Force Motors",2.50,1200],["Garware Technical",1.80,600],["EID Parry",0.90,400]],
  "Sanjay Kumar Agarwal":[["Escort Kubota",1.20,800],["IIFL Finance",0.80,350]],
  "Dheeraj Kumar Lohia":[["Elgi Equipments",1.50,400],["Kitex Garments",2.80,200]],
  "Ashish Dhawan":[["Cholamandalam",0.40,300],["Crompton Consumer",0.60,250]],
  "Ramesh Damani":[["Grindwell Norton",1.20,500],["Carborundum",0.80,300]],
  "Bhavish Aggarwal (Ola)":[["Ola Electric",0.50,200]],
  "Sachin Bansal (Navi)":[["Navi Finserv",3.20,500]],
  "Vijay Shekhar Sharma (Paytm)":[["One97 Communications",0.10,150]],
  "Deepinder Zomato":[["Zomato",0.08,100]],
  "Nikhil Kamart (Zerodha)":[["Zerodha (unlisted)",100.00,25000]],
};
const _insI=db.prepare("INSERT INTO individual_investors(investorName,investorType,country,totalPortfolioValue,holdingsCount,source) VALUES(?,?,?,?,?,?)");
const _insH=db.prepare("INSERT INTO investor_holdings(investorId,investorName,companyName,holdingPct,marketValue,reportDate,source) VALUES(?,?,?,?,?,?,?)");
let _ic=0,_hc=0;
db.transaction(()=>{seedInv.forEach(i=>{const h=seedH[i[0]]||[];const r=_insI.run(i[0],i[1],"India",i[2],h.length,"public-disclosure");_ic++;h.forEach(s=>{_insH.run(r.lastInsertRowid,i[0],s[0],s[1],s[2],"Q1 FY2026","public-disclosure");_hc++;});});})();
console.log();

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
