/**
 * db/mutualFunds.js
 *
 * SQLite schema for HDFC Mutual Fund scheme-level data.
 * Stores: schemes, returns (all periods), AUM, NAV, monthly portfolios, and complete holdings.
 *
 * Each scheme has its OWN return, AUM, and monthly portfolio snapshots.
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
    id TEXT PRIMARY KEY,
    schemeCode TEXT,
    schemeName TEXT NOT NULL,
    amc TEXT NOT NULL DEFAULT 'HDFC',
    category TEXT,
    plan TEXT DEFAULT 'Direct',
    option TEXT DEFAULT 'Growth',
    isin TEXT,
    status TEXT DEFAULT 'active',
    fundManager TEXT,
    expenseRatio REAL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- RETURNS: Returns per scheme for various periods (1D, 1W, 1M, 3M, 6M, 1Y, 3Y, 5Y)
  CREATE TABLE IF NOT EXISTS mutual_fund_returns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '1Y',
    returnValue REAL,
    asOfDate TEXT,
    source TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId, period)
  );

  -- AUM: Scheme-level Assets Under Management
  CREATE TABLE IF NOT EXISTS mutual_fund_aum (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    aum REAL,
    asOfDate TEXT,
    source TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId)
  );

  -- NAV: Latest NAV per scheme
  CREATE TABLE IF NOT EXISTS mutual_fund_nav (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    nav REAL,
    asOfDate TEXT,
    source TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId)
  );

  -- INVESTORS: Scheme-level investor/folio count
  CREATE TABLE IF NOT EXISTS mutual_fund_investors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    investorCount REAL,
    investorDate TEXT,
    source TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId)
  );

  -- PORTFOLIOS: Monthly portfolio snapshots
  CREATE TABLE IF NOT EXISTS mutual_fund_portfolios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    portfolioDate TEXT NOT NULL,
    source TEXT,
    sourceUrl TEXT,
    totalHoldings INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId, portfolioDate)
  );

  -- HOLDINGS: Individual holdings within a portfolio snapshot
  
  CREATE TABLE IF NOT EXISTS aum_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    aum REAL,
    snapshotDate TEXT NOT NULL,
    source TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    UNIQUE(schemeId, snapshotDate)
  );
  CREATE TABLE IF NOT EXISTS investor_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    investorCount REAL,
    snapshotDate TEXT NOT NULL,
    source TEXT,
    createdAt TEXT DEFAULT (datetime('now')),
    UNIQUE(schemeId, snapshotDate)
  );
  CREATE TABLE IF NOT EXISTS mutual_fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    portfolioId INTEGER NOT NULL,
    securityName TEXT NOT NULL,
    isin TEXT,
    assetType TEXT DEFAULT 'Equity',
    sector TEXT,
    quantity REAL,
    marketValue REAL,
    marketValueCr REAL,
    weight REAL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (portfolioId) REFERENCES mutual_fund_portfolios(id)
  );

  -- NAV_HISTORY: Daily NAV snapshots for charting (last 30+ days)
  CREATE TABLE IF NOT EXISTS mutual_fund_nav_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schemeId TEXT NOT NULL,
    navDate TEXT NOT NULL,
    nav REAL NOT NULL,
    source TEXT DEFAULT 'groww',
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (schemeId) REFERENCES mutual_fund_schemes(id),
    UNIQUE(schemeId, navDate)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_mfs_scheme ON mutual_fund_schemes(id);
  CREATE INDEX IF NOT EXISTS idx_mfs_amc ON mutual_fund_schemes(amc);
  CREATE INDEX IF NOT EXISTS idx_mfret_scheme ON mutual_fund_returns(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfaum_scheme ON mutual_fund_aum(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfnav_scheme ON mutual_fund_nav(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfnavhist_scheme ON mutual_fund_nav_history(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfnavhist_date ON mutual_fund_nav_history(navDate);
  CREATE INDEX IF NOT EXISTS idx_mfinv_scheme ON mutual_fund_investors(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfp_scheme ON mutual_fund_portfolios(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfp_date ON mutual_fund_portfolios(portfolioDate);
  CREATE INDEX IF NOT EXISTS idx_mfh_portfolio ON mutual_fund_holdings(portfolioId);
  CREATE INDEX IF NOT EXISTS idx_mfh_name ON mutual_fund_holdings(securityName);
`);

// Add columns if they don't exist (migration)
try { db.exec("ALTER TABLE mutual_fund_schemes ADD COLUMN fundManager TEXT"); } catch(_){}
try { db.exec("ALTER TABLE mutual_fund_schemes ADD COLUMN expenseRatio REAL"); } catch(_){}

// ─── Helper Functions ───────────────────────────────────────────────────────

const helpers = {

  /**
   * Upsert a scheme — accepts an object
   */  upsertScheme(scheme) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_schemes (id, schemeCode, schemeName, amc, category, plan, option, isin, status, fundManager, expenseRatio, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        schemeCode = excluded.schemeCode,
        schemeName = excluded.schemeName,
        category = excluded.category,
        plan = excluded.plan,
        option = excluded.option,
        isin = excluded.isin,
        status = excluded.status,
        fundManager = COALESCE(excluded.fundManager, mutual_fund_schemes.fundManager),
        expenseRatio = COALESCE(excluded.expenseRatio, mutual_fund_schemes.expenseRatio),
        updatedAt = datetime('now')
    `);
    return stmt.run(
      scheme.id, scheme.schemeCode || null, scheme.schemeName,
      scheme.amc || 'HDFC', scheme.category || null,
      scheme.plan || 'Direct', scheme.option || 'Growth', scheme.isin || null, scheme.status || 'active',
      scheme.fundManager || null, scheme.expenseRatio || null
    );
  },

  /**
   * Upsert a return — accepts an object { schemeId, period, returnValue, asOfDate, source }
   */
  upsertReturn(data) {
    const schemeId = typeof data === 'string' ? arguments[0] : data.schemeId;
    const period = typeof data === 'string' ? arguments[1] : (data.period || '1Y');
    const returnValue = typeof data === 'string' ? arguments[2] : data.returnValue;
    const asOfDate = typeof data === 'string' ? arguments[3] : data.asOfDate;
    const source = typeof data === 'string' ? arguments[4] : data.source;

    const stmt = db.prepare(`
      INSERT INTO mutual_fund_returns (schemeId, period, returnValue, asOfDate, source)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(schemeId, period) DO UPDATE SET
        returnValue = excluded.returnValue,
        asOfDate = excluded.asOfDate,
        source = excluded.source
    `);
    return stmt.run(schemeId, period, returnValue, asOfDate || null, source || null);
  },

  /**
   * Upsert AUM — accepts an object { schemeId, aum, asOfDate, source }
   */
  upsertAum(data) {
    const schemeId = typeof data === 'string' ? arguments[0] : data.schemeId;
    const aum = typeof data === 'string' ? arguments[1] : data.aum;
    const asOfDate = typeof data === 'string' ? arguments[2] : (data.asOfDate || data.aumDate);
    const source = typeof data === 'string' ? arguments[3] : data.source;

    const stmt = db.prepare(`
      INSERT INTO mutual_fund_aum (schemeId, aum, asOfDate, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId) DO UPDATE SET
        aum = excluded.aum,
        asOfDate = excluded.asOfDate,
        source = excluded.source
    `);
    const result = stmt.run(schemeId, aum, asOfDate || null, source || null);
      // Also store historical snapshot
      if (aum > 0 && asOfDate) {
        try { db.prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?, ?, ?, ?)').run(schemeId, aum, asOfDate, source || null); } catch(e) {}
      }
      return result;
    },

  /**
   * Upsert NAV — accepts an object { schemeId, nav, asOfDate, source }
   */
  upsertNav(data) {
    const schemeId = typeof data === 'string' ? arguments[0] : data.schemeId;
    const nav = typeof data === 'string' ? arguments[1] : data.nav;
    const asOfDate = typeof data === 'string' ? arguments[2] : data.asOfDate;
    const source = typeof data === 'string' ? arguments[3] : data.source;

    const stmt = db.prepare(`
      INSERT INTO mutual_fund_nav (schemeId, nav, asOfDate, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId) DO UPDATE SET
        nav = excluded.nav,
        asOfDate = excluded.asOfDate,
        source = excluded.source
    `);
    return stmt.run(schemeId, nav, asOfDate || null, source || null);
  },

  /**
   * Upsert investor count — accepts an object { schemeId, investorCount, investorDate, source }
   */
  upsertInvestors(data) {
    const schemeId = typeof data === 'string' ? arguments[0] : data.schemeId;
    const investorCount = typeof data === 'string' ? arguments[1] : data.investorCount;
    const investorDate = typeof data === 'string' ? arguments[2] : (data.investorDate || data.asOfDate);
    const source = typeof data === 'string' ? arguments[3] : data.source;

    const stmt = db.prepare(`
      INSERT INTO mutual_fund_investors (schemeId, investorCount, investorDate, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId) DO UPDATE SET
        investorCount = excluded.investorCount,
        investorDate = excluded.investorDate,
        source = excluded.source
    `);
    const result2 = stmt.run(schemeId, investorCount, investorDate || null, source || null);
      // Also store historical snapshot
      if (investorCount > 0 && investorDate) {
        try { db.prepare('INSERT OR REPLACE INTO investor_snapshots (schemeId, investorCount, snapshotDate, source) VALUES (?, ?, ?, ?)').run(schemeId, investorCount, investorDate, source || null); } catch(e) {}
      }
      return result2;
    },

  /**
   * Upsert a portfolio — accepts an object { schemeId, portfolioDate, source }
   * Returns the portfolio ID.
   */
  upsertPortfolio(data) {
    const schemeId = typeof data === 'string' ? arguments[0] : data.schemeId;
    const portfolioDate = typeof data === 'string' ? arguments[1] : data.portfolioDate;
    const source = typeof data === 'string' ? arguments[2] : data.source;

    const stmt = db.prepare(`
      INSERT INTO mutual_fund_portfolios (schemeId, portfolioDate, source)
      VALUES (?, ?, ?)
      ON CONFLICT(schemeId, portfolioDate) DO UPDATE SET
        source = excluded.source
      RETURNING id
    `);
    const row = stmt.get(schemeId, portfolioDate, source || null);
    return row.id;
  },

  /**
   * Clear all holdings for a given portfolio
   */
  clearHoldings(portfolioId) {
    return db.prepare('DELETE FROM mutual_fund_holdings WHERE portfolioId = ?').run(portfolioId);
  },

  /**
   * Insert a single holding — accepts an object { portfolioId, securityName, isin, assetType, sector, quantity, marketValue, weight }
   */
  insertHolding(data) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_holdings (portfolioId, securityName, isin, assetType, sector, quantity, marketValue, marketValueCr, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
      data.portfolioId,
      data.securityName,
      data.isin || null,
      data.assetType || 'Equity',
      data.sector || null,
      data.quantity || null,
      data.marketValue || null,
      data.marketValueCr || null,
      data.weight || null
    );
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
   * Get return for a scheme (default 1Y, but can specify any period)
   */
  getReturn(schemeId, period) {
    return db.prepare('SELECT * FROM mutual_fund_returns WHERE schemeId = ? AND period = ?').get(schemeId, period || '1Y');
  },

  /**
   * Get all returns for a scheme
   */
  getAllReturns(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_returns WHERE schemeId = ? ORDER BY period').all(schemeId);
  },

  /**
   * Get AUM for a scheme
   */
  getAum(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_aum WHERE schemeId = ?').get(schemeId);
  },

  /**
   * Get NAV for a scheme
   */
  getNav(schemeId) {
    return db.prepare('SELECT * FROM mutual_fund_nav WHERE schemeId = ?').get(schemeId);
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
   * Get portfolio by schemeId and date
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
   * Get all holdings for a scheme (across all portfolio dates)
   */
  getHoldingsForScheme(schemeId) {
    const portfolio = this.getLatestPortfolio(schemeId);
    if (!portfolio) return [];
    return this.getHoldings(portfolio.id);
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
    const nav = this.getNav(schemeId);
    const inv = this.getInvestors(schemeId);
    const allReturns = this.getAllReturns(schemeId);
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
      returns: allReturns.reduce((acc, r) => { acc[r.period] = r.returnValue; return acc; }, {}),
      nav: nav ? nav.nav : null,
      navDate: nav ? nav.asOfDate : null,
      aum: aum ? aum.aum : null,
      aumDate: aum ? aum.asOfDate : null,
      aumSource: aum ? aum.source : null,
      investorCount: inv ? inv.investorCount : null,
      investorDate: inv ? inv.investorDate : null,
      latestPortfolioDate: latestPortfolio ? latestPortfolio.portfolioDate : null,
      totalHoldings: latestPortfolio ? latestPortfolio.totalHoldings : 0,
      availablePortfolioMonths: portfolioDates.length,
      holdings: latestHoldings
    };
  },

  /**
   * Get all HDFC schemes with summary data for listing
   */

  snapshotAum(schemeId, aum, date, source) {
    db.prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?, ?, ?, ?)').run(schemeId, aum, date, source);
  },

  snapshotInvestors(schemeId, count, date, source) {
    db.prepare('INSERT OR REPLACE INTO investor_snapshots (schemeId, investorCount, snapshotDate, source) VALUES (?, ?, ?, ?)').run(schemeId, count, date, source);
  },

  getAumChange(schemeId, monthsBack) {
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() - monthsBack);
    const targetStr = targetDate.toISOString().slice(0, 10);
    const latest = db.prepare('SELECT aum, snapshotDate FROM aum_snapshots WHERE schemeId = ? ORDER BY snapshotDate DESC LIMIT 1').get(schemeId);
    if (!latest) return null;
    const historical = db.prepare('SELECT aum FROM aum_snapshots WHERE schemeId = ? AND snapshotDate <= ? ORDER BY snapshotDate DESC LIMIT 1').get(schemeId, targetStr);
    if (!historical) return null;
    const change = latest.aum - historical.aum;
    const changePct = historical.aum > 0 ? ((change / historical.aum) * 100) : null;
    return { current: latest.aum, previous: historical.aum, change, changePct, latestDate: latest.snapshotDate, historicalDate: historical.snapshotDate };
  },

  getInvestorChange(schemeId, monthsBack) {
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() - monthsBack);
    const targetStr = targetDate.toISOString().slice(0, 10);
    const latest = db.prepare('SELECT investorCount, snapshotDate FROM investor_snapshots WHERE schemeId = ? ORDER BY snapshotDate DESC LIMIT 1').get(schemeId);
    if (!latest) return null;
    const historical = db.prepare('SELECT investorCount FROM investor_snapshots WHERE schemeId = ? AND snapshotDate <= ? ORDER BY snapshotDate DESC LIMIT 1').get(schemeId, targetStr);
    if (!historical) return null;
    const change = latest.investorCount - historical.investorCount;
    const changePct = historical.investorCount > 0 ? ((change / historical.investorCount) * 100) : null;
    return { current: latest.investorCount, previous: historical.investorCount, change, changePct, latestDate: latest.snapshotDate, historicalDate: historical.snapshotDate };
  },

  getAllSchemesSummary() {
    const schemes = this.getAllSchemes();
    return schemes.map(s => {
      const ret = this.getReturn(s.id);
      const aum = this.getAum(s.id);
      const nav = this.getNav(s.id);
      const inv = this.getInvestors(s.id);
      const allReturns = this.getAllReturns(s.id);
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
        fundManager: s.fundManager || null,
        expenseRatio: s.expenseRatio || null,
        return1Y: ret ? ret.returnValue : null,
        return1YDate: ret ? ret.asOfDate : null,
        returns: allReturns.reduce((acc, r) => { acc[r.period] = r.returnValue; return acc; }, {}),
        nav: nav ? nav.nav : null,
        navDate: nav ? nav.asOfDate : null,
        aum: aum ? aum.aum : null,
        aumDate: aum ? aum.asOfDate : null,
        investorCount: inv ? inv.investorCount : null,
        aumChange1M: this.getAumChange(s.id, 1),
        aumChange3M: this.getAumChange(s.id, 3),
        aumChange6M: this.getAumChange(s.id, 6),
        aumChange1Y: this.getAumChange(s.id, 12),
        investorChange1M: this.getInvestorChange(s.id, 1),
        investorChange3M: this.getInvestorChange(s.id, 3),
        investorChange6M: this.getInvestorChange(s.id, 6),
        investorChange1Y: this.getInvestorChange(s.id, 12),
        latestPortfolioDate: latestPortfolio ? latestPortfolio.portfolioDate : null,
        availablePortfolioMonths: this.getPortfolioDates(s.id).length,
        topHoldings: topHoldings.map(h => ({
          securityName: h.securityName,
          isin: h.isin,
          assetType: h.assetType,
          sector: h.sector,
          weight: h.weight
        })),
        // Confidence score: based on returns, AUM, holdings, expense ratio
        confidenceScore: (() => {
          let score = 50; // baseline
          const returns = allReturns.reduce((acc, r) => { acc[r.period] = r.returnValue; return acc; }, {});
          // Positive returns boost score
          if ((returns['1M'] || 0) > 0) score += 5;
          if ((returns['3M'] || 0) > 0) score += 5;
          if ((returns['6M'] || 0) > 0) score += 5;
          if ((returns['1Y'] || 0) > 0) score += 10;
          // Strong 1Y return
          if ((returns['1Y'] || 0) > 15) score += 10;
          if ((returns['1Y'] || 0) > 30) score += 5;
          // AUM size
          const aumVal = aum ? aum.aum : 0;
          if (aumVal > 5000) score += 5;
          if (aumVal > 20000) score += 5;
          if (aumVal > 50000) score += 5;
          // Holdings count (diversification)
          if (latestPortfolio && topHoldings.length >= 20) score += 5;
          // Low expense ratio
          if (s.expenseRatio && s.expenseRatio < 1.0) score += 5;
          if (s.expenseRatio && s.expenseRatio < 0.5) score += 5;
          // Investors count
          if (inv && inv.investorCount > 1000000) score += 5;
          return Math.min(score, 100);
        })()
      };
    });
  },

  /**
   * Validate data integrity
   */
  validateIntegrity() {
    const schemes = this.getAllSchemes();
    const warnings = [];
    let totalPortfolios = 0;
    let totalHoldings = 0;

    const holdingsMap = new Map();

    for (const scheme of schemes) {
      const portfolios = db.prepare(
        'SELECT * FROM mutual_fund_portfolios WHERE schemeId = ? ORDER BY portfolioDate DESC'
      ).all(scheme.id);

      totalPortfolios += portfolios.length;

      if (portfolios.length > 0) {
        const latest = portfolios[0];
        const holdings = this.getHoldings(latest.id);
        totalHoldings += holdings.length;

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

    return {
      totalSchemes: schemes.length,
      totalPortfolios,
      totalHoldings,
      duplicateWarnings: warnings,
    };
  },  // ─── NAV History Functions ───────────────────────────────────────

  /**
   * Insert or update a daily NAV snapshot
   */
  upsertNavHistory(schemeId, navDate, nav, source) {
    const stmt = db.prepare(`
      INSERT INTO mutual_fund_nav_history (schemeId, navDate, nav, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(schemeId, navDate) DO UPDATE SET
        nav = excluded.nav,
        source = excluded.source
    `);
    return stmt.run(schemeId, navDate, nav, source || 'groww');
  },

  /**
   * Get NAV history for a scheme (last N days)
   */
  getNavHistory(schemeId, days) {
    let sql = 'SELECT * FROM mutual_fund_nav_history WHERE schemeId = ? ORDER BY navDate DESC';
    if (days) sql += ' LIMIT ' + parseInt(days);
    return db.prepare(sql).all(schemeId);
  },

  /**
   * Get NAV history for a scheme within a date range
   */
  getNavHistoryRange(schemeId, fromDate, toDate) {
    return db.prepare(
      'SELECT * FROM mutual_fund_nav_history WHERE schemeId = ? AND navDate >= ? AND navDate <= ? ORDER BY navDate ASC'
    ).all(schemeId, fromDate, toDate);
  },

  /**
   * Get the latest NAV date for a scheme
   */
  getLatestNavDate(schemeId) {
    return db.prepare(
      'SELECT navDate FROM mutual_fund_nav_history WHERE schemeId = ? ORDER BY navDate DESC LIMIT 1'
    ).get(schemeId);
  },

  /**
   * Check if a specific NAV date already exists
   */
  hasNavHistory(schemeId, navDate) {
    return db.prepare(
      'SELECT 1 FROM mutual_fund_nav_history WHERE schemeId = ? AND navDate = ?'
    ).get(schemeId, navDate);
  },

  /**
   * Get all schemes that need NAV updates (all active schemes)
   */
  getAllActiveSchemeIds() {
    return db.prepare(
      "SELECT id, schemeCode FROM mutual_fund_schemes WHERE status = 'active'"
    ).all();
  },

  /**
   * Get the raw database instance
   */
  getDb() {
    return db;
  }

};

module.exports = helpers;
