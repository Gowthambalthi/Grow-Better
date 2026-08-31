/**
 * db/mutualFunds.js
 *
 * SQLite schema for HDFC Mutual Fund scheme-level data.
 * Stores: schemes, 1Y returns, AUM, investor counts, monthly portfolios, and complete holdings.
 *
 * Each scheme has its OWN return, AUM, investor count, and monthly portfolio snapshots.
 * Historical monthly portfolios are never overwritten — each is identified by (schemeId, portfolioDate).
 */

'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'hdfc_mutual_funds.db');

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (err) {
  console.warn('[MF DB] Native better-sqlite3 load failed, using mock memory storage:', err.message);
  db = {
    exec: () => {},
    prepare: () => ({
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => null,
      pluck: () => ({ all: () => [], run: () => ({ changes: 0 }), get: () => null })
    }),
    pragma: () => {},
    transaction: (fn) => fn
  };
}

// ─── Schema Initialization ──────────────────────────────────────────────────

db.exec(`
  -- SCHEMES: Master list of HDFC mutual fund schemes
  CREATE TABLE IF NOT EXISTS mutual_fund_schemes (
    id TEXT PRIMARY KEY,              -- unique schemeId, e.g. 'HDFC_FLEXI_CAP_DIRECT_GROWTH'
    schemeCode INTEGER,               -- AMFI scheme code
    schemeName TEXT NOT NULL,          -- full official name
    amc TEXT NOT NULL DEFAULT 'HDFC Mutual Fund',
    category TEXT,                     -- 'Equity: Flexi Cap', 'Equity: Mid Cap', etc.
    plan TEXT DEFAULT 'Direct',        -- 'Direct' | 'Regular'
    option TEXT DEFAULT 'Growth',      -- 'Growth' | 'IDCW'
    isin TEXT,                         -- ISIN if available
    status TEXT DEFAULT 'active',      -- 'active' | 'inactive' | 'closed'
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- RETURNS: 1Y return per scheme (one row per scheme per period)
  CREATE TABLE IF NOT EXISTS mutual_fund_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '1Y', -- '1Y' only
    returnValue REAL,                  -- percentage, e.g. 18.42
    asOfDate TEXT,                     -- ISO date
    source TEXT,                       -- 'mfapi.in' | 'HDFC Official'
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId, period)
  );

  -- AUM: Scheme-level Assets Under Management
  CREATE TABLE IF NOT EXISTS mutual_fund_aum (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    aum REAL,                          -- in Crores
    aumDate TEXT,                      -- ISO date or month label
    source TEXT,                       -- 'AMFI Monthly Report' | 'HDFC Official'
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId)
  );

  -- INVESTORS: Scheme-level investor/folio count
  CREATE TABLE IF NOT EXISTS mutual_fund_investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    investorCount REAL,                -- in lakhs if from HDFC (e.g. 39.9 means 39.9 lakhs)
    investorDate TEXT,                 -- ISO date
    source TEXT,                       -- 'HDFC Official' | 'AMFI'
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId)
  );

  -- PORTFOLIOS: Monthly portfolio snapshots (one per scheme per month)
  CREATE TABLE IF NOT EXISTS mutual_fund_portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    portfolioDate TEXT NOT NULL,       -- ISO date, e.g. '2026-07-31'
    source TEXT,                       -- 'HDFC Official Monthly Portfolio'
    sourceUrl TEXT,                    -- URL of the xlsx file
    totalHoldings INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId, portfolioDate)
  );

  -- HOLDINGS: Individual holdings within a portfolio snapshot
  CREATE TABLE IF NOT EXISTS mutual_fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolioId INTEGER NOT NULL,
    securityName TEXT NOT NULL,
    isin TEXT,
    assetType TEXT DEFAULT 'Equity',   -- 'Equity' | 'Debt' | 'Cash' | 'Other'
    sector TEXT,
    quantity REAL,
    marketValue REAL,                  -- in lakhs (from HDFC xlsx)
    marketValueCr REAL,                -- converted to crores
    weight REAL,                       -- % to NAV
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (portfolioId) REFERENCES mutual_fund_portfolios(id)
  );

  -- Indexes for performance
  CREATE INDEX IF NOT EXISTS idx_mfs_scheme ON mutual_fund_schemes(id);
  CREATE INDEX IF NOT EXISTS idx_mfs_amc ON mutual_fund_schemes(amc);
  CREATE INDEX IF NOT EXISTS idx_mfret_scheme ON mutual_fund_returns(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfaum_scheme ON mutual_fund_aum(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfinv_scheme ON mutual_fund_investors(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfp_scheme ON mutual_fund_portfolios(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfp_date ON mutual_fund_portfolios(portfolioDate);
  CREATE INDEX IF NOT EXISTS idx_mfh_portfolio ON mutual_fund_holdings(portfolioId);
  CREATE INDEX IF NOT EXISTS idx_mfh_name ON mutual_fund_holdings(securityName);
`);

// ─── Helper Functions ───────────────────────────────────────────────────────

const helpers = {
  /**
   * Upsert a scheme into mutual_fund_schemes
   */
  upsertScheme(scheme) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_schemes (id, schemeCode, schemeName, amc, category, plan, option, isin, status, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        schemeCode = excluded.schemeCode,
        schemeName = excluded.schemeName,
        category = excluded.category,
        plan = excluded.plan,
        option = excluded.option,
        isin = excluded.isin,
        status = excluded.status,
        updatedAt = datetime('now')
    `);
    return stmt.run(
      scheme.id, scheme.schemeCode || null, scheme.schemeName,
      scheme.amc || 'HDFC Mutual Fund', scheme.category || null,
      scheme.plan || 'Direct', scheme.option || 'Growth',
      scheme.isin || null, scheme.status || 'active'
    );
  },

  /**
   * Upsert a 1Y return for a scheme
   */
  upsertReturn(schemeId, period, returnValue, asOfDate, source) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(schemeId, period) DO UPDATE SET
        returnValue = excluded.returnValue,
        asOfDate = excluded.asOfDate,
        source = excluded.source
    `);
    return stmt.run(schemeId, period || '1Y', returnValue, asOfDate, source);
  },

  /**
   * Upsert AUM for a scheme
   */
  upsertAum(schemeId, aum, aumDate, source) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_aum (schemeId, aum, aumDate, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId) DO UPDATE SET
        aum = excluded.aum,
        aumDate = excluded.aumDate,
        source = excluded.source
    `);
    return stmt.run(schemeId, aum, aumDate, source);
  },

  /**
   * Upsert investor count for a scheme
   */
  upsertInvestors(schemeId, investorCount, investorDate, source) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_investors (schemeId, investorCount, investorDate, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId) DO UPDATE SET
        investorCount = excluded.investorCount,
        investorDate = excluded.investorDate,
        source = excluded.source
    `);
    return stmt.run(schemeId, investorCount, investorDate, source);
  },

  /**
   * Upsert a portfolio snapshot and its holdings in a transaction.
   * Returns the portfolioId.
   */
  upsertPortfolio(schemeId, portfolioDate, source, sourceUrl, holdings) {
    const upsertPortfolioStmt = db.prepare(`
      INSERT INTO mutual_fund_portfolios (schemeId, portfolioDate, source, sourceUrl, totalHoldings)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(schemeId, portfolioDate) DO UPDATE SET
        source = excluded.source,
        sourceUrl = excluded.sourceUrl,
        totalHoldings = excluded.totalHoldings
      RETURNING id
    `);

    const deleteHoldingsStmt = db.prepare(`
      DELETE FROM mutual_fund_holdings WHERE portfolioId = ?
    `);

    const insertHoldingStmt = db.prepare(`
      INSERT INTO mutual_fund_holdings (portfolioId, securityName, isin, assetType, sector, quantity, marketValue, marketValueCr, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const runInTransaction = db.transaction((schemeId, portfolioDate, source, sourceUrl, holdings) => {
      const row = upsertPortfolioStmt.get(schemeId, portfolioDate, source, sourceUrl, holdings.length);
      const portfolioId = row.id;

      // Clear old holdings for this portfolio and re-insert
      deleteHoldingsStmt.run(portfolioId);

      for (const h of holdings) {
        insertHoldingStmt.run(
          portfolioId,
          h.securityName,
          h.isin || null,
          h.assetType || 'Equity',
          h.sector || null,
          h.quantity || null,
          h.marketValue || null,
          h.marketValueCr || null,
          h.weight || null
        );
      }

      return portfolioId;
    });

    return runInTransaction(schemeId, portfolioDate, source, sourceUrl, holdings);
  },

  /**
   * Get all schemes
   */
  getAllSchemes() {
    return db.prepare('SELECT * FROM mutual_fund_schemes ORDER BY schemeName').all();
  },

  /**
   * Get a single scheme by ID
   */
  getScheme(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_schemes WHERE id = ?').get(schemeId);
  },

  /**
   * Get 1Y return for a scheme
   */
  getReturn(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_returns WHERE schemeId = ? AND period = ?').get(schemeId, '1Y');
  },

  /**
   * Get AUM for a scheme
   */
  getAum(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_aum WHERE schemeId = ?').get(schemeId);
  },

  /**
   * Get investor count for a scheme
   */
  getInvestors(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_investors WHERE schemeId = ?').get(schemeId);
  },

  /**
   * Get latest portfolio for a scheme
   */
  getLatestPortfolio(schemeId) {
    return db.prepare(
      'SELECT * FROM mutual_fund_portfolios WHERE schemeId = ? ORDER BY portfolioDate DESC LIMIT 1'
    ).get(schemeId);
  },

  /**
   * Get portfolio by schemeId and date (or latest if no date)
   */
  getPortfolio(schemeId, portfolioDate) {
    if (portfolioDate) {
      return db.prepare(
        'SELECT * FROM mutual_fund_portfolios WHERE schemeId = ? AND portfolioDate = ?'
      ).get(schemeId, portfolioDate);
    }
    return this.getLatestPortfolio(schemeId);
  },

  /**
   * Get all portfolio dates for a scheme (for month selector)
   */
  getPortfolioDates(schemeId) {
    return db.prepare(
      'SELECT id, portfolioDate, totalHoldings FROM mutual_fund_portfolios WHERE schemeId = ? ORDER BY portfolioDate DESC'
    ).all(schemeId);
  },

  /**
   * Get holdings for a portfolio
   */
  getHoldings(portfolioId) {
    return db.prepare(
      'SELECT * FROM mutual_fund_holdings WHERE portfolioId = ? ORDER BY weight DESC'
    ).all(portfolioId);
  },

  /**
   * Get holdings for a scheme by portfolioDate (convenience)
   */
  getHoldingsByDate(schemeId, portfolioDate) {
    const portfolio = this.getPortfolio(schemeId, portfolioDate);
    if (!portfolio) return null;
    return {
      ...portfolio,
      holdings: this.getHoldings(portfolio.id)
    };
  },

  /**
   * Get the complete scheme profile with all metrics
   */
  getSchemeProfile(schemeId) {
    const scheme = this.getScheme(schemeId);
    if (!scheme) return null;

    const ret = this.getReturn(schemeId);
    const aum = this.getAum(schemeId);
    const inv = this.getInvestors(schemeId);
    const latestPortfolio = this.getLatestPortfolio(schemeId);
    const portfolioDates = this.getPortfolioDates(schemeId);

    let latestHoldings = [];
    if (latestPortfolio) {
      latestHoldings = this.getHoldings(latestPortfolio.id);
    }

    return {
      ...scheme,
      return1Y: ret ? ret.returnValue : null,
      return1YDate: ret ? ret.asOfDate : null,
      return1YSource: ret ? ret.source : null,
      aum: aum ? aum.aum : null,
      aumDate: aum ? aum.aumDate : null,
      aumSource: aum ? aum.source : null,
      investorCount: inv ? inv.investorCount : null,
      investorDate: inv ? inv.investorDate : null,
      investorSource: inv ? inv.source : null,
      latestPortfolioDate: latestPortfolio ? latestPortfolio.portfolioDate : null,
      totalHoldings: latestPortfolio ? latestPortfolio.totalHoldings : 0,
      availablePortfolioMonths: portfolioDates.length,
      holdings: latestHoldings
    };
  },

  /**
   * Get all HDFC schemes with summary data for listing
   */
  getAllSchemesSummary() {
    const schemes = this.getAllSchemes();
    return schemes.map(s => {
      const ret = this.getReturn(s.id);
      const aum = this.getAum(s.id);
      const inv = this.getInvestors(s.id);
      const latestPortfolio = this.getLatestPortfolio(s.id);
      let topHoldings = [];
      if (latestPortfolio) {
        topHoldings = db.prepare(
          'SELECT * FROM mutual_fund_holdings WHERE portfolioId = ? ORDER BY weight DESC LIMIT 5'
        ).all(latestPortfolio.id);
      }

      return {
        id: s.id,
        schemeCode: s.schemeCode,
        schemeName: s.schemeName,
        amc: s.amc,
        category: s.category,
        plan: s.plan,
        option: s.option,
        status: s.status,
        return1Y: ret ? ret.returnValue : null,
        return1YDate: ret ? ret.asOfDate : null,
        aum: aum ? aum.aum : null,
        aumDate: aum ? aum.aumDate : null,
        investorCount: inv ? inv.investorCount : null,
        investorDate: inv ? inv.investorDate : null,
        latestPortfolioDate: latestPortfolio ? latestPortfolio.portfolioDate : null,
        availablePortfolioMonths: this.getPortfolioDates(s.id).length,
        topHoldings: topHoldings.map(h => ({
          securityName: h.securityName,
          isin: h.isin,
          assetType: h.assetType,
          sector: h.sector,
          weight: h.weight
        }))
      };
    });
  },

  /**
   * Validate data integrity — check for duplicate holdings across schemes
   */
  validateIntegrity() {
    const schemes = this.getAllSchemes();
    const warnings = [];
    let totalPortfolios = 0;
    let totalHoldings = 0;
    let schemesWith12Months = 0;
    let schemesWithLess = 0;

    // Check for identical holdings between schemes
    const holdingsMap = new Map(); // holdingsSignature -> [schemeIds]

    for (const scheme of schemes) {
      const portfolios = db.prepare(
        'SELECT * FROM mutual_fund_portfolios WHERE schemeId = ? ORDER BY portfolioDate DESC'
      ).all(scheme.id);

      totalPortfolios += portfolios.length;

      if (portfolios.length >= 12) schemesWith12Months++;
      else schemesWithLess++;

      // Check latest portfolio for duplicates
      if (portfolios.length > 0) {
        const latest = portfolios[0];
        const holdings = this.getHoldings(latest.id);
        totalHoldings += holdings.length;

        // Create a signature from sorted holdings names+weights
        const sig = holdings
          .map(h => `${h.securityName}:${h.weight}`)
          .sort()
          .join('|');

        if (sig.length > 0) {
          if (holdingsMap.has(sig)) {
            const existing = holdingsMap.get(sig);
            warnings.push(`COLLISION: ${scheme.id} shares identical holdings with ${existing.join(', ')}`);
            existing.push(scheme.id);
          } else {
            holdingsMap.set(sig, [scheme.id]);
          }
        }
      }
    }

    // Check for schemes missing data
    const missing = [];
    for (const scheme of schemes) {
      const ret = this.getReturn(scheme.id);
      const aum = this.getAum(scheme.id);
      const inv = this.getInvestors(scheme.id);
      const portfolio = this.getLatestPortfolio(scheme.id);
      const issues = [];
      if (!ret) issues.push('return1Y');
      if (!aum) issues.push('aum');
      if (!inv) issues.push('investors');
      if (!portfolio) issues.push('portfolio');
      if (issues.length > 0) {
        missing.push({ scheme: scheme.id, missing: issues });
      }
    }

    return {
      totalSchemes: schemes.length,
      totalPortfolios,
      totalHoldings,
      schemesWith12Months,
      schemesWithLessThan12Months: schemesWithLess,
      duplicateWarnings: warnings,
      missingData: missing
    };
  },

  /**
   * Get the raw database instance (for advanced queries)
   */
  getDb() {
    return db;
  }
};

module.exports = helpers;
