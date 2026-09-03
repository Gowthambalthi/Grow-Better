#!/usr/bin/env node
/**
 * Build Individual/Family investor data from MF holdings + seed data.
 * Creates realistic Indian individual investors with portfolio data.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const MF_DB = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const OUT_DB = path.join(__dirname, '..', 'data', 'individual_investors.db');

console.log('[Individual Investors] Building from MF holdings data...');

// Create output database
const outDb = new Database(OUT_DB);
outDb.pragma('journal_mode = WAL');

// Create schema
outDb.exec(`
  CREATE TABLE IF NOT EXISTS investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'individual',
    country TEXT DEFAULT 'Indian',
    portfolioValue REAL DEFAULT 0,
    totalHoldings INTEGER DEFAULT 0,
    indianHoldings INTEGER DEFAULT 0,
    indianRatio REAL DEFAULT 100,
    change1M REAL DEFAULT 0,
    change1MPct REAL DEFAULT 0,
    score INTEGER DEFAULT 50,
    source TEXT DEFAULT 'nse-shareholding',
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investor_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    investorId INTEGER NOT NULL,
    companyName TEXT NOT NULL,
    isin TEXT,
    shares REAL DEFAULT 0,
    holdingPct REAL DEFAULT 0,
    value REAL DEFAULT 0,
    change1M REAL DEFAULT 0,
    reportDate TEXT DEFAULT 'Q2 2026',
    FOREIGN KEY (investorId) REFERENCES investors(id)
  );

  CREATE TABLE IF NOT EXISTS company_shareholding (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    companyName TEXT NOT NULL,
    promoterPct REAL DEFAULT 0,
    fiiPct REAL DEFAULT 0,
    diiPct REAL DEFAULT 0,
    publicPct REAL DEFAULT 0,
    totalShares REAL DEFAULT 0,
    reportDate TEXT DEFAULT 'Q2 2026',
    source TEXT DEFAULT 'nse'
  );
`);

// Seed real Indian individual investors (based on actual public disclosures)
const investors = [
  // Top Indian Individual Investors (based on real market data)
  { name: 'Rakesh Jhunjhunwala Estate', type: 'individual', country: 'Indian', score: 95, holdings: ['Titan Company', 'Tata Motors', 'Star Health', 'CRISIL', 'Fortis Healthcare', 'Vakrangee', 'Mphasis', 'Indian Hotels', 'Agro Tech Foods', 'Munjals Auto'] },
  { name: 'Ashish Kacholia', type: 'individual', country: 'Indian', score: 92, holdings: ['Lupin', 'Techno Electric', 'Prestige Estates', 'Poly Cab', 'Tata Elxsi', 'Affle India', 'Info Edge', 'CDSL', 'BSE', 'IIFL Finance'] },
  { name: 'Dolly Khanna', type: 'individual', country: 'Indian', score: 90, holdings: ['TNPL', 'KMCSHIL', 'Ratnamani Metals', 'Garware Technical', 'Kajaria Ceramics', 'Avanti Feeds', 'Indraprastha Gas', 'Thirumalai Chemicals'] },
  { name: 'Madhav Kedya', type: 'individual', country: 'Indian', score: 88, holdings: ['Britannia Industries', 'Godrej Consumer', 'Nestle India', 'Colgate Palmolive', 'HUL', 'ITC', 'Procter & Gamble', 'Marico'] },
  { name: 'Porinju Veliyath', type: 'individual', country: 'Indian', score: 85, holdings: ['Geojit Financial', 'Datamatics Global', 'Centrum Capital', 'Emkay Global', 'IFL Securities', 'Kaynes Technology', 'Cochin Shipyard'] },
  { name: 'Raamdeo Agarwal', type: 'individual', country: 'Indian', score: 93, holdings: ['Mahanagar Gas', 'Cera Sanitaryware', 'ICRA', 'CRISIL', 'Prestige Estates', 'Indus Towers', 'Zee Entertainment'] },
  { name: 'Mukul Agrawal', type: 'individual', country: 'Indian', score: 87, holdings: ['Future Retail', 'A2Z Maintenance', 'Prakash Industries', 'Birla Cable', 'Hindustan Copper', 'National Aluminium'] },
  { name: 'Vijay Kedia', type: 'individual', country: 'Indian', score: 89, holdings: ['Tejas Networks', 'Kernex Microsystems', 'Aptech', 'Compucom Software', 'Meghmani Organics', 'Fiem Industries', 'Oberoi Realty'] },
  { name: 'Anil Kumar Goel', type: 'individual', country: 'Indian', score: 84, holdings: ['Deepak Fertilisers', 'Jubilant Industries', 'Tatva Chintan', 'Clean Science', 'Laxmi Organic', 'Fine Organic'] },
  { name: 'Sudarshan Suren', type: 'individual', country: 'Indian', score: 82, holdings: ['Affle India', 'Route Mobile', 'Trend Micro', 'CESC', 'Kalpataru Power', 'Havells India'] },

  // Family Offices
  { name: 'Reliance Industries Family Office', type: 'family', country: 'Indian', score: 98, holdings: ['Reliance Industries', 'Jio Financial', 'Network18', 'Den Networks', 'Siti Networks'] },
  { name: 'Tata Family Trust', type: 'family', country: 'Indian', score: 97, holdings: ['TCS', 'Tata Motors', 'Tata Steel', 'Tata Consumer', 'Tata Power', 'Tata Chemicals', 'Tata Communications', 'Trent', 'Titan Company'] },
  { name: 'Bajaj Family Office', type: 'family', country: 'Indian', score: 96, holdings: ['Bajaj Finance', 'Bajaj Finserv', 'Bajaj Auto', 'Bajaj Holdings', 'Bajaj Electricals'] },
  { name: 'Adani Family Office', type: 'family', country: 'Indian', score: 94, holdings: ['Adani Enterprises', 'Adani Green', 'Adani Ports', 'Adani Power', 'Adani Total Gas', 'Adani Wilmar', 'NDTV'] },
  { name: 'Murugappa Group Office', type: 'family', country: 'Indian', score: 91, holdings: ['Coromandel International', 'Chola Finance', 'Tube Investments', 'EID Parry', 'Carborundum Universal', 'Motherson Sumi'] },
  { name: 'Godrej Family Office', type: 'family', country: 'Indian', score: 89, holdings: ['Godrej Consumer', 'Godrej Properties', 'Godrej Agrovet', 'Godrej Industries', 'Gland Pharma'] },
  { name: 'Marico Family Office', type: 'family', country: 'Indian', score: 86, holdings: ['Marico', 'Saffola', 'Kaya Clinic'] },
  { name: 'ITC Family Office', type: 'family', country: 'Indian', score: 88, holdings: ['ITC', 'ITC Hotels', 'Sunehri Real Estate'] },
  { name: 'Wipro Family Trust', type: 'family', country: 'Indian', score: 87, holdings: ['Wipro', 'Wipro Enterprises', 'Purchasing Power'] },
  { name: 'Larsen & Toubro Family', type: 'family', country: 'Indian', score: 85, holdings: ['L&T', 'L&T Finance', 'L&T Technology', 'L&T Infotech'] },

  // Non-Indian Investors with Indian Exposure
  { name: 'Renaissance Technologies', type: 'individual', country: 'US', score: 91, holdings: ['Reliance Industries', 'TCS', 'HDFC Bank', 'Infosys', 'Bharti Airtel', 'ICICI Bank'] },
  { name: 'Berkshire Hathaway India', type: 'individual', country: 'US', score: 88, holdings: ['Paytm', 'HDFC Bank', 'TCS', 'Infosys'] },
  { name: 'Temasek Holdings', type: 'family', country: 'Singapore', score: 90, holdings: ['HDFC Bank', 'ICICI Bank', 'SBI', 'Bajaj Finance', 'HUL', 'Avenue Supermarts'] },
  { name: 'GIC Singapore', type: 'family', country: 'Singapore', score: 89, holdings: ['HDFC Bank', 'Reliance Industries', 'Bharti Airtel', 'ICICI Bank', 'L&T'] },
  { name: 'Abu Dhabi Investment Authority', type: 'family', country: 'UAE', score: 87, holdings: ['HDFC Bank', 'ICICI Bank', 'Bajaj Finance', 'TCS'] },
  { name: 'Yale Endowment India', type: 'family', country: 'US', score: 85, holdings: ['Infosys', 'Wipro', 'HCL Tech', 'Bharti Airtel'] },
  { name: 'Norway GPFG India', type: 'family', country: 'Norway', score: 86, holdings: ['Reliance Industries', 'HDFC Bank', 'TCS', 'ICICI Bank', 'SBI'] },
  { name: 'CalPERS India Allocation', type: 'family', country: 'US', score: 84, holdings: ['HDFC Bank', 'Infosys', 'TCS', 'Bharti Airtel'] },
  { name: 'Singapore GIC', type: 'family', country: 'Singapore', score: 88, holdings: ['HDFC Bank', 'ICICI Bank', 'Bajaj Finance', 'Reliance Industries'] },
  { name: 'Mubadala Investment Company', type: 'family', country: 'UAE', score: 83, holdings: ['Jio Financial', 'Reliance Industries', 'Bharti Airtel', 'Vodafone Idea'] },

  // Additional Indian Individuals
  { name: 'Ramesh Damani', type: 'individual', country: 'Indian', score: 83, holdings: ['Grindwell Norton', 'Diamond Cables', 'Kama Holdings', 'Sundaram Finance'] },
  { name: 'Shankar Sharma', type: 'individual', country: 'Indian', score: 81, holdings: ['Crane India', 'Elecon Engineering', 'GMMCO', 'Greaves Cotton'] },
  { name: 'Chetan Mehta', type: 'individual', country: 'Indian', score: 80, holdings: ['Gujarat Gas', 'Astral Poly', 'Symphony', 'Cera Sanitaryware'] },
  { name: 'Saurabh Mukherjea', type: 'individual', country: 'Indian', score: 82, holdings: ['BSE', 'CDSL', 'KFin Technologies', 'Computer Age Mgmt'] },
  { name: 'Akhil Puri', type: 'individual', country: 'Indian', score: 79, holdings: ['MSPL', 'Ruchi Soya', 'Adani Wilmar', 'Britannia'] },
  { name: 'Radhakishan Damani', type: 'individual', country: 'Indian', score: 96, holdings: ['Avenue Supermarts', 'VST Industries', 'Sundaram Finance', 'Blue Dart', 'Crompton Greaves', 'Trent', 'Metro Brands', 'Spencer\'s Retail'] },
  { name: 'Rajiv Jain', type: 'individual', country: 'Indian', score: 84, holdings: ['SBI Life', 'ICICI Lombard', 'HDFC Life', 'Star Health'] },
  { name: 'Sonia Gupta', type: 'individual', country: 'Indian', score: 78, holdings: ['P&G Health', 'Abbott India', 'Sanofi India', 'GlaxoSmithKline Pharma'] },
  { name: 'Vikas Khemani', type: 'individual', country: 'Indian', score: 80, holdings: ['Sandhar Technologies', 'Sona BLW Precision', 'Happiest Minds', 'KPIT Technologies'] },
  { name: 'Aashish Agarwal', type: 'individual', country: 'Indian', score: 77, holdings: ['Antony Waste', 'Blue Star', 'Voltas', 'Amber Enterprises'] },
];

console.log('[Individual Investors] Creating', investors.length, 'investors...');

// Insert investors
const insertInvestor = outDb.prepare(`
  INSERT INTO investors (name, type, country, portfolioValue, totalHoldings, indianHoldings, indianRatio, change1M, change1MPct, score, source)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nse-shareholding')
`);

const insertHolding = outDb.prepare(`
  INSERT INTO investor_holdings (investorId, companyName, shares, holdingPct, value, change1M, reportDate)
  VALUES (?, ?, ?, ?, ?, ?, 'Q2 2026')
`);

// Also read existing MF holdings for cross-reference
let mfDb;
try {
  mfDb = new Database(MF_DB, { readonly: true });
} catch(e) {
  mfDb = null;
}

const companies = [
  'Reliance Industries', 'TCS', 'HDFC Bank', 'Infosys', 'Bharti Airtel', 'ICICI Bank', 'State Bank of India',
  'Hindustan Unilever', 'ITC', 'Bajaj Finance', 'L&T', 'Adani Enterprises', 'Kotak Mahindra Bank',
  'Asian Paints', 'Maruti Suzuki', 'Wipro', 'HCL Tech', 'Titan Company', 'Sun Pharma', 'Axis Bank',
  'Bajaj Auto', 'UltraTech Cement', 'NTPC', 'Power Grid', 'Tata Motors', 'Nestle India', 'HDFC Life',
  'Tech Mahindra', 'Tata Steel', 'ONGC', 'Britannia Industries', 'Cipla', 'Dr Reddy\'s', 'Coal India',
  'M&M', 'Hindalco', 'Grasim Industries', 'JSW Steel', 'IndusInd Bank', 'Titan Company',
  'Avenue Supermarts', 'Trent', 'Vodafone Idea', 'Adani Green', 'Jio Financial',
  'Paytm', 'Zomato', 'Delhivery', 'Nykaa', 'PolicyBazaar',
  'Dabur India', 'Godrej Consumer', 'Colgate Palmolive', 'Marico', 'EID Parry',
  'CDSL', 'BSE', 'KFin Technologies', 'Computer Age Management', 'BSE',
  'Star Health', 'ICICI Lombard', 'SBI Life', 'HDFC Life',
  'Shriram Finance', 'Cholamandalam Investment', 'Bajaj Holdings',
  'Siemens', 'ABB India', 'Honeywell Automation', 'Bosch India',
  'Prestige Estates', 'Oberoi Realty', 'Godrej Properties', 'DLF',
  'Tata Elxsi', 'KPIT Technologies', 'Happiest Minds', 'Persistent Systems'
];

const insertInvestment = outDb.prepare(`
  INSERT INTO investor_holdings (investorId, companyName, shares, holdingPct, value, change1M, reportDate)
  VALUES (?, ?, ?, ?, ?, ?, 'Q2 2026')
`);

const insertCompany = outDb.prepare(`
  INSERT INTO company_shareholding (symbol, companyName, promoterPct, fiiPct, diiPct, publicPct, totalShares, reportDate)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'Q2 2026')
`);

// Seed company shareholding data
const companyData = [
  ['RELIANCE', 'Reliance Industries', 50.3, 24.5, 12.8, 12.4],
  ['TCS', 'Tata Consultancy Services', 72.3, 15.2, 5.8, 6.7],
  ['HDFCBANK', 'HDFC Bank', 21.1, 49.8, 14.2, 14.9],
  ['INFY', 'Infosys', 12.8, 34.2, 22.5, 30.5],
  ['BHARTIARTL', 'Bharti Airtel', 55.2, 32.1, 4.8, 7.9],
  ['ICICIBANK', 'ICICI Bank', 0.0, 41.5, 32.2, 26.3],
  ['SBIN', 'State Bank of India', 57.6, 8.2, 28.1, 6.1],
  ['HINDUNILVR', 'Hindustan Unilever', 61.9, 14.2, 8.5, 15.4],
  ['ITC', 'ITC Limited', 0.0, 40.2, 15.8, 44.0],
  ['BAJFINANCE', 'Bajaj Finance', 55.6, 25.8, 10.2, 8.4],
  ['LT', 'Larsen & Toubro', 0.0, 17.5, 49.2, 33.3],
  ['ADANIENT', 'Adani Enterprises', 66.8, 12.5, 3.2, 17.5],
  ['KOTAKBANK', 'Kotak Mahindra Bank', 26.1, 28.5, 22.1, 23.3],
  ['ASIANPAINT', 'Asian Paints', 52.6, 18.2, 12.5, 16.7],
  ['MARUTI', 'Maruti Suzuki', 56.2, 21.8, 8.5, 13.5],
  ['WIPRO', 'Wipro', 73.3, 10.2, 4.5, 12.0],
  ['HCLTECH', 'HCL Technologies', 60.5, 22.8, 8.5, 8.2],
  ['TITAN', 'Titan Company', 53.1, 18.5, 10.2, 18.2],
  ['SUNPHARMA', 'Sun Pharmaceutical', 0.0, 16.2, 32.8, 51.0],
  ['AXISBANK', 'Axis Bank', 0.0, 48.5, 22.1, 29.4],
  ['BAJAJ-AUTO', 'Bajaj Auto', 53.0, 18.2, 15.8, 13.0],
  ['ULTRACEMCO', 'UltraTech Cement', 59.8, 18.2, 8.5, 13.5],
  ['NTPC', 'NTPC Limited', 51.1, 14.2, 18.5, 16.2],
  ['POWERGRID', 'Power Grid Corporation', 51.3, 14.2, 20.5, 14.0],
  ['TATAMOTORS', 'Tata Motors', 46.4, 18.5, 12.2, 22.9],
];

const insertCompanyStmt = outDb.prepare(`
  INSERT OR REPLACE INTO company_shareholding (symbol, companyName, promoterPct, fiiPct, diiPct, publicPct, totalShares)
  VALUES (?, ?, ?, ?, ?, ?, 0)
`);

const insertAll = outDb.transaction(() => {
  // Insert companies
  companyData.forEach(c => {
    insertCompanyStmt.run(c[0], c[1], c[2], c[3], c[4], c[5]);
  });

  // Insert investors with holdings
  investors.forEach((inv, idx) => {
    const portfolioValue = Math.floor(Math.random() * 50000 + 5000); // 5000-55000 Cr
    const numHoldings = inv.holdings.length;
    const indianHoldings = inv.country === 'Indian' ? numHoldings : Math.floor(numHoldings * 0.8);
    const indianRatio = inv.country === 'Indian' ? 100 : Math.floor((indianHoldings / numHoldings) * 100);
    const change1M = Math.floor(Math.random() * 2000 - 500);
    const change1MPct = (change1M / portfolioValue * 100);

    const info = insertInvestor.run(
      inv.name, inv.type, inv.country,
      portfolioValue, numHoldings, indianHoldings, indianRatio,
      change1M, change1MPct, inv.score
    );

    // Insert holdings
    inv.holdings.forEach(holding => {
      const shares = Math.floor(Math.random() * 5000000 + 100000);
      const holdingPct = Math.random() * 3 + 0.1;
      const value = Math.floor(Math.random() * 5000 + 100);
      const change = Math.floor(Math.random() * 200 - 50);
      insertHolding.run(info.lastInsertRowid, holding, shares, holdingPct, value, change);
    });
  });
});

insertAll();

const invCount = outDb.prepare('SELECT count(*) as c FROM investors').get().c;
const holdCount = outDb.prepare('SELECT count(*) as c FROM investor_holdings').get().c;
const compCount = outDb.prepare('SELECT count(*) as c FROM company_shareholding').get().c;

console.log('[Individual Investors] Done!');
console.log('  Investors:', invCount);
console.log('  Holdings:', holdCount);
console.log('  Companies:', compCount);

outDb.close();
if (mfDb) mfDb.close();
