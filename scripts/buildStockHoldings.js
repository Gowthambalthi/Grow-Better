#!/usr/bin/env node
/**
 * buildStockHoldings.js
 * 
 * Creates data/stock_holdings.db — a reverse index from MF scheme holdings to stocks.
 * Reads from data/hdfc_mutual_funds.db (which has 739 schemes across 47 AMCs).
 * 
 * For each stock, aggregates:
 *   - Which funds hold it
 *   - Total weight across all funds
 *   - Total market value
 *   - Per-fund breakdown
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SRC_DB = path.join(__dirname, '..', 'data', 'hdfc_mutual_funds.db');
const DST_DB = path.join(__dirname, '..', 'data', 'stock_holdings.db');

console.log('[StockHoldings] Starting build...');
console.log('[StockHoldings] Source:', SRC_DB);
console.log('[StockHoldings] Destination:', DST_DB);

// Remove old DB if exists
if (fs.existsSync(DST_DB)) {
  fs.unlinkSync(DST_DB);
  console.log('[StockHoldings] Removed old database');
}

const src = new Database(SRC_DB, { readonly: true });
const dst = new Database(DST_DB);

// ─── Create schema ───────────────────────────────────────────────
dst.exec(`
  CREATE TABLE IF NOT EXISTS stocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stockName TEXT NOT NULL,
    normalizedName TEXT NOT NULL,
    isin TEXT,
    assetType TEXT DEFAULT 'EQUITY',
    sector TEXT,
    totalFundsHolding INTEGER DEFAULT 0,
    totalWeight REAL DEFAULT 0,
    totalMarketValue REAL DEFAULT 0,
    latestPortfolioDate TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_stocks_normalized ON stocks(normalizedName);

  CREATE TABLE IF NOT EXISTS funds (
    id TEXT PRIMARY KEY,
    schemeName TEXT NOT NULL,
    amc TEXT,
    category TEXT,
    plan TEXT,
    option TEXT,
    aum REAL,
    aumDate TEXT,
    schemeCode TEXT,
    isin TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stockId INTEGER NOT NULL,
    fundId TEXT NOT NULL,
    portfolioId INTEGER,
    portfolioDate TEXT,
    weight REAL,
    marketValue REAL,
    assetType TEXT DEFAULT 'EQUITY',
    sector TEXT,
    isin TEXT,
    quantity INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (stockId) REFERENCES stocks(id),
    FOREIGN KEY (fundId) REFERENCES funds(id)
  );

  CREATE INDEX IF NOT EXISTS idx_fund_holdings_stock ON fund_holdings(stockId);
  CREATE INDEX IF NOT EXISTS idx_fund_holdings_fund ON fund_holdings(fundId);

  CREATE TABLE IF NOT EXISTS stock_fund_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stockId INTEGER NOT NULL,
    fundId TEXT NOT NULL,
    weight REAL,
    marketValue REAL,
    portfolioDate TEXT,
    FOREIGN KEY (stockId) REFERENCES stocks(id),
    FOREIGN KEY (fundId) REFERENCES funds(id),
    UNIQUE(stockId, fundId, portfolioDate)
  );

  CREATE INDEX IF NOT EXISTS idx_stock_fund_map_stock ON stock_fund_map(stockId);
  CREATE INDEX IF NOT EXISTS idx_stock_fund_map_fund ON stock_fund_map(fundId);
`);

console.log('[StockHoldings] Schema created');

// ─── Step 1: Copy all funds ──────────────────────────────────────
console.log('[StockHoldings] Copying funds...');
const schemes = src.prepare('SELECT * FROM mutual_fund_schemes').all();
const insertFund = dst.prepare(`
  INSERT OR REPLACE INTO funds (id, schemeName, amc, category, plan, option, schemeCode, isin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const fundAum = src.prepare(`
  SELECT aum, asOfDate FROM mutual_fund_aum 
  WHERE schemeId = ? ORDER BY asOfDate DESC LIMIT 1
`);

let fundCount = 0;
const copyFunds = dst.transaction(() => {
  for (const s of schemes) {
    const aumRow = fundAum.get(s.id);
    insertFund.run(
      s.id,
      s.schemeName,
      s.amc,
      s.category,
      s.plan,
      s.option,
      s.schemeCode,
      s.isin
    );
    if (aumRow) {
      dst.prepare('UPDATE funds SET aum = ?, aumDate = ? WHERE id = ?')
        .run(aumRow.aum, aumRow.asOfDate, s.id);
    }
    fundCount++;
  }
});
copyFunds();
console.log(`[StockHoldings] Copied ${fundCount} funds`);

// ─── Step 2: Get latest portfolio per scheme ──────────────────────
console.log('[StockHoldings] Processing holdings...');
const portfolios = src.prepare(`
  SELECT p.id as portfolioId, p.schemeId, p.portfolioDate
  FROM mutual_fund_portfolios p
  ORDER BY p.portfolioDate DESC
`).all();

// Get latest portfolio per scheme
const latestPortfolios = new Map();
for (const p of portfolios) {
  if (!latestPortfolios.has(p.schemeId)) {
    latestPortfolios.set(p.schemeId, p);
  }
}

console.log(`[StockHoldings] ${latestPortfolios.size} schemes with latest portfolios`);

// ─── Step 3: Process all holdings ────────────────────────────────
// Normalize stock name: remove "Ltd", "Limited", trim, uppercase
function normalizeStockName(name) {
  if (!name) return '';
  return name
    .replace(/\bLTD\b\.?/gi, '')
    .replace(/\bLIMITED\b\.?/gi, '')
    .replace(/\bPRIVATE LIMITED\b\.?/gi, '')
    .replace(/\bPVT LTD\b\.?/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// Skip non-equity items
function shouldSkip(name) {
  if (!name) return true;
  const skip = ['repo', 'net payable', 'net receivable', 'cash', 'margin', 'treasury', 
    'collateral', 'borrowing', 'loan', 'deposit', 'other current', 'inter corporate',
    'cblo', 'murabaha', 'short', 'pending'];
  const lower = name.toLowerCase();
  return skip.some(s => lower.startsWith(s) || lower.includes(s));
}

const insertStock = dst.prepare(`
  INSERT OR IGNORE INTO stocks (stockName, normalizedName, isin, assetType, sector)
  VALUES (?, ?, ?, ?, ?)
`);

const getStock = dst.prepare('SELECT id FROM stocks WHERE normalizedName = ?');

const insertFundHolding = dst.prepare(`
  INSERT INTO fund_holdings (stockId, fundId, portfolioId, portfolioDate, weight, marketValue, assetType, sector, isin, quantity)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertStockFundMap = dst.prepare(`
  INSERT OR IGNORE INTO stock_fund_map (stockId, fundId, weight, marketValue, portfolioDate)
  VALUES (?, ?, ?, ?, ?)
`);

const updateStockAgg = dst.prepare(`
  UPDATE stocks SET 
    totalFundsHolding = totalFundsHolding + 1,
    totalWeight = totalWeight + ?,
    totalMarketValue = totalMarketValue + ?,
    latestPortfolioDate = MAX(COALESCE(latestPortfolioDate, ''), ?),
    updatedAt = datetime('now')
  WHERE id = ?
`);

const getHoldingsForPortfolio = src.prepare(`
  SELECT h.*, p.schemeId, p.portfolioDate
  FROM mutual_fund_holdings h
  JOIN mutual_fund_portfolios p ON h.portfolioId = p.id
  WHERE p.id = ?
`);

let totalHoldings = 0;
let skippedHoldings = 0;
let stocksCreated = 0;

const processHoldings = dst.transaction(() => {
  for (const [schemeId, portfolio] of latestPortfolios) {
    const holdings = getHoldingsForPortfolio.all(portfolio.portfolioId);
    
    for (const h of holdings) {
      if (shouldSkip(h.securityName)) {
        skippedHoldings++;
        continue;
      }

      const normalized = normalizeStockName(h.securityName);
      if (!normalized || normalized.length < 2) {
        skippedHoldings++;
        continue;
      }

      // Create or get stock
      insertStock.run(h.securityName, normalized, h.isin, h.assetType, h.sector);
      const stockRow = getStock.get(normalized);
      if (!stockRow) continue;

      const stockId = stockRow.id;
      const weight = h.weight || 0;
      const mktVal = h.marketValue || 0;
      const pDate = portfolio.portfolioDate || '';

      // Insert fund holding record
      insertFundHolding.run(
        stockId, schemeId, portfolio.portfolioId, pDate,
        weight, mktVal, h.assetType, h.sector, h.isin, h.quantity
      );

      // Insert into stock-fund map
      insertStockFundMap.run(stockId, schemeId, weight, mktVal, pDate);

      // Update stock aggregates
      updateStockAgg.run(weight, mktVal, pDate, stockId);

      totalHoldings++;
    }
  }
});

processHoldings();
console.log(`[StockHoldings] Processed ${totalHoldings} holdings (${skippedHoldings} skipped)`);

// ─── Step 4: Final stats ─────────────────────────────────────────
const stats = {
  funds: dst.prepare('SELECT COUNT(*) as c FROM funds').get().c,
  stocks: dst.prepare('SELECT COUNT(*) as c FROM stocks').get().c,
  fundHoldings: dst.prepare('SELECT COUNT(*) as c FROM fund_holdings').get().c,
  stockFundMaps: dst.prepare('SELECT COUNT(*) as c FROM stock_fund_map').get().c,
  topStocks: dst.prepare(`
    SELECT stockName, totalFundsHolding, ROUND(totalWeight, 2) as totalWeight, 
           ROUND(totalMarketValue, 2) as totalMarketValue, sector
    FROM stocks ORDER BY totalFundsHolding DESC LIMIT 10
  `).all(),
  topFundsByHoldings: dst.prepare(`
    SELECT f.schemeName, f.amc, COUNT(fh.id) as holdingCount, f.aum
    FROM funds f JOIN fund_holdings fh ON f.id = fh.fundId
    GROUP BY f.id ORDER BY holdingCount DESC LIMIT 5
  `).all()
};

console.log('\n[StockHoldings] ═══════════════════════════════════════');
console.log('[StockHoldings] BUILD COMPLETE');
console.log('[StockHoldings] ═══════════════════════════════════════');
console.log(`  Funds: ${stats.funds}`);
console.log(`  Unique Stocks: ${stats.stocks}`);
console.log(`  Fund-Holding Records: ${stats.fundHoldings}`);
console.log(`  Stock-Fund Mappings: ${stats.stockFundMaps}`);
console.log('\n  Top 10 Most Held Stocks:');
stats.topStocks.forEach((s, i) => {
  console.log(`  ${i+1}. ${s.stockName} — ${s.totalFundsHolding} funds, weight: ${s.totalWeight}%, sector: ${s.sector || 'N/A'}`);
});
console.log('\n  Top 5 Funds by Holdings:');
stats.topFundsByHoldings.forEach((f, i) => {
  console.log(`  ${i+1}. ${f.schemeName} (${f.amc}) — ${f.holdingCount} stocks, AUM: ₹${f.aum || 0} Cr`);
});

src.close();
dst.close();

console.log(`\n[StockHoldings] Database saved to: ${DST_DB}`);
console.log(`[StockHoldings] File size: ${(fs.statSync(DST_DB).size / 1024 / 1024).toFixed(1)} MB`);
