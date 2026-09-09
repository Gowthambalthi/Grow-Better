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

  -- NAV_HISTORY: compact per-scheme blob ("YYYY-MM-DD:NAV," ascending by date)
  -- Keeps the DB small enough to stay under git's 100MB file limit.
  CREATE TABLE IF NOT EXISTS mutual_fund_nav_blob (
    schemeId TEXT PRIMARY KEY,
    points TEXT NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_mfs_scheme ON mutual_fund_schemes(id);
  CREATE INDEX IF NOT EXISTS idx_mfs_amc ON mutual_fund_schemes(amc);
  CREATE INDEX IF NOT EXISTS idx_mfret_scheme ON mutual_fund_returns(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfaum_scheme ON mutual_fund_aum(schemeId);
  CREATE INDEX IF NOT EXISTS idx_mfnav_scheme ON mutual_fund_nav(schemeId);
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

/** Parse the compact per-scheme NAV blob into [{navDate, nav}] ascending by date. */
function navBlobToSeries(points) {
  if (!points) return [];
  const out = [];
  let i = 0;
  const n = points.length;
  while (i < n) {
    const c = points.indexOf(':', i);
    if (c < 0) break;
    const navDate = points.slice(i, c);
    let e = points.indexOf(',', c + 1);
    if (e < 0) e = n;
    const nav = parseFloat(points.slice(c + 1, e));
    if (!isNaN(nav) && nav > 0) out.push({ navDate, nav });
    i = e + 1;
  }
  return out;
}

function navSeries(schemeId) {
  const row = db.prepare('SELECT points FROM mutual_fund_nav_blob WHERE schemeId=?').get(schemeId);
  return navBlobToSeries(row && row.points);
}

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
   * Real per-card counts for the 7 Smart Money cards (same matcher as the frontend),
   * computed from the scheme master only — cheap even at 14k schemes.
   */
  getCardCounts() {
    // Keys must match the frontend card keys exactly (cd.key in index.html).
    // These tests replicate filterMfCategory() in index.html so the badge always equals the grid.
    const keys = ['Multi Cap', 'Mid Cap', 'Large & Mid Cap', 'Value', 'Large Cap', 'Flexi Cap', 'Small Cap', 'Index', 'ELSS', 'Money Market', 'Commodities'];
    const counts = {};
    for (const k of keys) counts[k] = 0;
    const lcMatcher = require('../common/mf-engine/largeCapMatcher');
    const match = (cn, nm, key) => {
      const cc = cn + ' ' + nm;
      switch (key) {
        case 'Multi Cap': return cc.indexOf('multi cap') !== -1 || cc.indexOf('multicap') !== -1;
        case 'Mid Cap': return lcMatcher.isMidCapName(nm, cn);
        case 'Large & Mid Cap': return cc.indexOf('large & mid') !== -1 || cc.indexOf('large and mid') !== -1 || cc.indexOf('large & midcap') !== -1 || cc.indexOf('large and midcap') !== -1 || cc.indexOf('largemidcap') !== -1 || cc.indexOf('large midcap') !== -1;
        case 'Value': return cc.indexOf('value') !== -1 || cc.indexOf('contra') !== -1;
        case 'Large Cap': return lcMatcher.isLargeCapName(nm, cn);
        case 'Flexi Cap': return cc.indexOf('flexi cap') !== -1 || cc.indexOf('flexicap') !== -1;
        case 'Small Cap': return lcMatcher.isSmallCapName(nm, cn);
        case 'Index': return cn.indexOf('index') !== -1 || nm.indexOf('index') !== -1 || nm.indexOf('etf') !== -1;
        case 'ELSS': return cc.indexOf('elss') !== -1 || cn.indexOf('tax') !== -1 || nm.indexOf('tax') !== -1 || nm.indexOf('80c') !== -1;
        case 'Money Market': return cc.indexOf('money market') !== -1 || cc.indexOf('liquid') !== -1 || cc.indexOf('overnight') !== -1;
        case 'Commodities': return cc.indexOf('commodit') !== -1 || cc.indexOf('gold') !== -1 || cc.indexOf('silver') !== -1;
        default: return cn.indexOf(key.toLowerCase()) !== -1;
      }
    };
    // Count UNIQUE funds (distinct schemeName) so the badge exactly equals the number of rows
    // the table shows — the grid deduplicates plan/option variants via getAllSchemesSummary, so
    // the badge must too, or the card says 164 while the table lists 35.
    const rows = db.prepare('SELECT schemeName, category FROM mutual_fund_schemes').all();
    const seen = new Set();
    for (const r of rows) {
      if (seen.has(r.schemeName)) continue;
      seen.add(r.schemeName);
      const cn = (r.category || '').toLowerCase();
      const nm = (r.schemeName || '').toLowerCase();
      for (const k of keys) if (match(cn, nm, k)) counts[k]++;
    }
    return counts;
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
   * Compute returns from stored NAV history (fallback for schemes without Groww return rows).
   * Returns the same shape as mutual_fund_returns rows: [{period, returnValue, asOfDate}]
   */
  getReturnsFromNav(schemeId) {
    const navs = navSeries(schemeId);
    if (!navs || navs.length < 2) return [];
    const last = navs[navs.length - 1];
    const asOfDate = last.navDate;
    const out = [];
    const windows = { '1D': 1, '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
    for (const [period, days] of Object.entries(windows)) {
      const cutoff = new Date(new Date(last.navDate + 'T00:00:00').getTime() - days * 86400000).toISOString().slice(0, 10);
      const win = navs.filter(r => r.navDate >= cutoff);
      if (win.length >= 2 && win[0].nav > 0) {
        out.push({ period, returnValue: (last.nav - win[0].nav) / win[0].nav * 100, asOfDate });
      }
    }
    return out;
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
    function normDate(d) { try { return new Date(d).toISOString().slice(0,10); } catch(e) { return d; } }
    const all = db.prepare('SELECT aum, snapshotDate FROM aum_snapshots WHERE schemeId = ? ORDER BY snapshotDate DESC').all(schemeId);
    if (all.length >= 2) {
      const latest = all[0];
      let historical = null;
      for (let i = 1; i < all.length; i++) {
        const d = normDate(all[i].snapshotDate);
        if (d <= targetStr) { historical = all[i]; break; }
      }
      if (!historical) historical = all[all.length - 1];
      const change = latest.aum - historical.aum;
      const changePct = historical.aum > 0 ? ((change / historical.aum) * 100) : null;
      return { current: latest.aum, previous: historical.aum, change, changePct, latestDate: latest.snapshotDate, historicalDate: historical.snapshotDate };
    }
    // Fallback: estimate from returns
    const periodMap = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y' };
    const ret = db.prepare('SELECT returnValue FROM mutual_fund_returns WHERE schemeId = ? AND period = ?').get(schemeId, periodMap[monthsBack]);
    const aum = db.prepare('SELECT aum FROM mutual_fund_aum WHERE schemeId = ?').get(schemeId);
    if (ret && aum && aum.aum > 0) {
      const estChange = aum.aum * (ret.returnValue / 100);
      return { current: aum.aum, previous: aum.aum - estChange, change: estChange, changePct: ret.returnValue, latestDate: 'estimated', historicalDate: 'estimated' };
    }
    return null;
  },

  getInvestorChange(schemeId, monthsBack) {
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() - monthsBack);
    const targetStr = targetDate.toISOString().slice(0, 10);
    function normDate(d) { try { return new Date(d).toISOString().slice(0,10); } catch(e) { return d; } }
    const all = db.prepare('SELECT investorCount, snapshotDate FROM investor_snapshots WHERE schemeId = ? ORDER BY snapshotDate DESC').all(schemeId);
    if (all.length >= 2) {
      const latest = all[0];
      let historical = null;
      for (let i = 1; i < all.length; i++) {
        const d = normDate(all[i].snapshotDate);
        if (d <= targetStr) { historical = all[i]; break; }
      }
      if (!historical) historical = all[all.length - 1];
      const change = latest.investorCount - historical.investorCount;
      const changePct = historical.investorCount > 0 ? ((change / historical.investorCount) * 100) : null;
      return { current: latest.investorCount, previous: historical.investorCount, change, changePct, latestDate: latest.snapshotDate, historicalDate: historical.snapshotDate };
    }
    // Fallback: estimate ~0.5% monthly growth for investor count
    const inv = db.prepare('SELECT investorCount FROM mutual_fund_investors WHERE schemeId = ?').get(schemeId);
    if (inv && inv.investorCount > 0) {
      const monthlyGrowthRate = 0.005;
      const estChange = Math.round(inv.investorCount * monthlyGrowthRate * monthsBack);
      return { current: inv.investorCount, previous: inv.investorCount - estChange, change: estChange, changePct: (monthlyGrowthRate * monthsBack * 100), latestDate: 'estimated', historicalDate: 'estimated' };
    }
    return null;
  },

  getAllSchemesSummary(limit) {
    let schemes = this.getAllSchemes();
    // DIRECT ONLY — collapse to one row per fund, preferring the Direct plan
    // (Regular rows are never shown; funds without a Direct plan fall back to
    // their best Growth-option variant).
    const best = new Map(); // schemeName -> chosen scheme row
    for (const s of schemes) {
      const pl = (s.plan || '').toLowerCase();
      const op = (s.option || '').toLowerCase();
      let score = 0;
      if (pl.indexOf('direct') !== -1) score += 100;             // Direct wins outright
      else if (pl.indexOf('regular') !== -1) score -= 100;       // Regular only if nothing better
      if (op.indexOf('growth') !== -1) score += 1; else if (op.indexOf('idcw') !== -1) score -= 1;
      const prev = best.get(s.schemeName);
      if (!prev || score > prev.score || (score === prev.score && s.id < prev.s.id)) best.set(s.schemeName, { score, s });
    }
    schemes = Array.from(best.values(), b => {
      b.s.variantCount = 1;
      return b.s;
    });
    if (limit && limit > 0) schemes = schemes.slice(0, limit); // slice BEFORE per-scheme work so the API stays fast at 14k schemes
    const ids = Array.from(new Set(schemes.map(s => s.id)));
    const inClause = ids.map(() => '?').join(',');

    // ─── Batch-load ONLY the sliced schemes' rows into maps (no N+1, no full-table scans) ─────────
    let metricsMap = {};
    try {
      for (const r of db.prepare(`SELECT * FROM fund_metrics WHERE schemeId IN (${inClause})`).all(...ids)) metricsMap[r.schemeId] = r;
    } catch (e) { /* fund_metrics may not exist yet */ }

    const retMap = {};   // schemeId -> { period: {period, returnValue, asOfDate} }
    for (const r of db.prepare(`SELECT schemeId, period, returnValue, asOfDate FROM mutual_fund_returns WHERE schemeId IN (${inClause})`).all(...ids)) {
      (retMap[r.schemeId] = retMap[r.schemeId] || {})[r.period] = r;
    }
    const aumMap = {};   for (const r of db.prepare(`SELECT * FROM mutual_fund_aum WHERE schemeId IN (${inClause})`).all(...ids)) aumMap[r.schemeId] = r;
    const navMap = {};   for (const r of db.prepare(`SELECT * FROM mutual_fund_nav WHERE schemeId IN (${inClause})`).all(...ids)) navMap[r.schemeId] = r;
    const invMap = {};   for (const r of db.prepare(`SELECT * FROM mutual_fund_investors WHERE schemeId IN (${inClause})`).all(...ids)) invMap[r.schemeId] = r;

    const portMap = {};  // schemeId -> portfolios sorted date DESC
    for (const r of db.prepare(`SELECT * FROM mutual_fund_portfolios WHERE schemeId IN (${inClause}) ORDER BY portfolioDate DESC`).all(...ids)) {
      (portMap[r.schemeId] = portMap[r.schemeId] || []).push(r);
    }
    const holdMap = {};  // portfolioId -> holdings sorted weight DESC (only for the sliced schemes' portfolios)
    const pids = [];
    for (const k in portMap) for (const p of portMap[k]) pids.push(p.id);
    if (pids.length) {
      const ph = pids.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT * FROM mutual_fund_holdings WHERE portfolioId IN (${ph}) ORDER BY weight DESC`).all(...pids)) {
        (holdMap[r.portfolioId] = holdMap[r.portfolioId] || []).push(r);
      }
    }
    const aumSnapMap = {};   for (const r of db.prepare(`SELECT schemeId, aum, snapshotDate FROM aum_snapshots WHERE schemeId IN (${inClause}) ORDER BY snapshotDate DESC`).all(...ids)) (aumSnapMap[r.schemeId] = aumSnapMap[r.schemeId] || []).push(r);
    const invSnapMap = {};   for (const r of db.prepare(`SELECT schemeId, investorCount, snapshotDate FROM investor_snapshots WHERE schemeId IN (${inClause}) ORDER BY snapshotDate DESC`).all(...ids)) (invSnapMap[r.schemeId] = invSnapMap[r.schemeId] || []).push(r);

    // NAV-derived returns fallback — only for schemes that lack return rows AND still have NAV history (rare)
    const needNav = schemes.filter(s => !retMap[s.id]).map(s => s.id);
    const navHistMap = {};
    if (needNav.length) {
      const ph = needNav.map(() => '?').join(',');
      try {
        for (const r of db.prepare(`SELECT schemeId, points FROM mutual_fund_nav_blob WHERE schemeId IN (${ph})`).all(...needNav)) {
          navHistMap[r.schemeId] = navBlobToSeries(r.points);
        }
      } catch (e) { /* ignore */ }
    }

    function returnsFromNav(navs) {
      if (!navs || navs.length < 2) return [];
      const last = navs[navs.length - 1];
      const out = [];
      const windows = { '1D': 1, '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
      for (const [period, days] of Object.entries(windows)) {
        const cutoff = new Date(new Date(last.navDate + 'T00:00:00').getTime() - days * 86400000).toISOString().slice(0, 10);
        const win = navs.filter(r => r.navDate >= cutoff);
        if (win.length >= 2 && win[0].nav > 0) out.push({ period, returnValue: (last.nav - win[0].nav) / win[0].nav * 100, asOfDate: last.navDate });
      }
      return out;
    }

    function normDate(d) { try { return new Date(d).toISOString().slice(0, 10); } catch (e) { return d; } }
    function snapChange(snaps, monthsBack, valKey) {
      if (!snaps || snaps.length < 2) return null;
      const targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() - monthsBack);
      const targetStr = targetDate.toISOString().slice(0, 10);
      const latest = snaps[0];
      let historical = null;
      for (let i = 1; i < snaps.length; i++) {
        const d = normDate(snaps[i].snapshotDate);
        if (d <= targetStr) { historical = snaps[i]; break; }
      }
      if (!historical) historical = snaps[snaps.length - 1];
      const change = latest[valKey] - historical[valKey];
      const changePct = historical[valKey] > 0 ? ((change / historical[valKey]) * 100) : null;
      return { current: latest[valKey], previous: historical[valKey], change, changePct, latestDate: latest.snapshotDate, historicalDate: historical.snapshotDate };
    }
    function aumChange(id, monthsBack) {
      const snap = snapChange(aumSnapMap[id], monthsBack, 'aum');
      if (snap) return snap;
      const periodMap = { 1: '1M', 3: '3M', 6: '6M', 12: '1Y' };
      const ret = retMap[id] && retMap[id][periodMap[monthsBack]];
      const aum = aumMap[id];
      if (ret && aum && aum.aum > 0) {
        const estChange = aum.aum * (ret.returnValue / 100);
        return { current: aum.aum, previous: aum.aum - estChange, change: estChange, changePct: ret.returnValue, latestDate: 'estimated', historicalDate: 'estimated' };
      }
      return null;
    }
    function invChange(id, monthsBack) {
      const snap = snapChange(invSnapMap[id], monthsBack, 'investorCount');
      if (snap) return snap;
      const inv = invMap[id];
      if (inv && inv.investorCount > 0) {
        const monthlyGrowthRate = 0.005;
        const estChange = Math.round(inv.investorCount * monthlyGrowthRate * monthsBack);
        return { current: inv.investorCount, previous: inv.investorCount - estChange, change: estChange, changePct: (monthlyGrowthRate * monthsBack * 100), latestDate: 'estimated', historicalDate: 'estimated' };
      }
      return null;
    }

    return schemes.map(s => {
      const metrics = metricsMap[s.id] || null;
      const ret = retMap[s.id] && retMap[s.id]['1Y'] ? retMap[s.id]['1Y'] : null;
      const aum = aumMap[s.id] || null;
      const nav = navMap[s.id] || null;
      const inv = invMap[s.id] || null;
      const allReturns = Object.values(retMap[s.id] || {});
      const allReturnsForScore = allReturns.length ? allReturns : returnsFromNav(navHistMap[s.id]);
      const retRows = allReturnsForScore;
      const ports = portMap[s.id] || [];
      const latestPortfolio = ports.length ? ports[0] : null;
      let topHoldings = [];
      if (latestPortfolio) topHoldings = (holdMap[latestPortfolio.id] || []).slice(0, 5);

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
        variantCount: s.variantCount || 1,
        return1Y: ret ? ret.returnValue : null,
        return1YDate: ret ? ret.asOfDate : null,
        returns: retRows.reduce((acc, r) => { acc[r.period] = r.returnValue; return acc; }, {}),
        nav: nav ? nav.nav : null,
        navDate: nav ? nav.asOfDate : null,
        aum: aum ? aum.aum : null,
        aumDate: aum ? aum.asOfDate : null,
        investorCount: inv ? inv.investorCount : null,
        aumChange1M: aumChange(s.id, 1),
        aumChange3M: aumChange(s.id, 3),
        aumChange6M: aumChange(s.id, 6),
        aumChange1Y: aumChange(s.id, 12),
        investorChange1M: invChange(s.id, 1),
        investorChange3M: invChange(s.id, 3),
        investorChange6M: invChange(s.id, 6),
        investorChange1Y: invChange(s.id, 12),
        latestPortfolioDate: latestPortfolio ? latestPortfolio.portfolioDate : null,
        availablePortfolioMonths: ports.length,
        topHoldings: topHoldings.map(h => ({
          securityName: h.securityName,
          isin: h.isin,
          assetType: h.assetType,
          sector: h.sector,
          weight: h.weight
        })),
        metrics,
        // Confidence score: based on returns, AUM, holdings, expense ratio
        confidenceScore: (() => {
          let score = 50; // baseline
          const returns = allReturnsForScore.reduce((acc, r) => { acc[r.period] = r.returnValue; return acc; }, {});
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
   * Cheap universe stats (full counts, not limited by the summary slice)
   */
  getUniverseStats() {
    const s = db.prepare('SELECT COUNT(*) AS n FROM mutual_fund_schemes').get();
    const a = db.prepare('SELECT COUNT(DISTINCT amc) AS n FROM mutual_fund_schemes').get();
    return { totalSchemes: s.n, totalAmcs: a.n };
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
    if (nav == null || isNaN(nav) || nav <= 0 || !navDate) return { changes: 0 };
    const series = navSeries(schemeId);
    let found = false;
    for (let i = 0; i < series.length; i++) {
      if (series[i].navDate === navDate) { series[i].nav = nav; found = true; break; }
    }
    if (!found) {
      series.push({ navDate, nav });
      series.sort((a, b) => (a.navDate < b.navDate ? -1 : a.navDate > b.navDate ? 1 : 0));
    }
    db.prepare('INSERT OR REPLACE INTO mutual_fund_nav_blob (schemeId, points) VALUES (?, ?)')
      .run(schemeId, series.map(p => p.navDate + ':' + (Math.round(p.nav * 10000) / 10000)).join(','));
    return { changes: 1 };
  },

  /**
   * Get NAV history for a scheme (last N days)
   */
  getNavHistory(schemeId, days) {
    const series = navSeries(schemeId).reverse(); // DESC
    if (days) series.length = Math.min(series.length, parseInt(days) || series.length);
    return series.map(p => ({ schemeId, navDate: p.navDate, nav: p.nav, source: 'mfapi' }));
  },

  /**
   * Get NAV history for a scheme within a date range
   */
  getNavHistoryRange(schemeId, fromDate, toDate) {
    return navSeries(schemeId).filter(p => p.navDate >= fromDate && p.navDate <= toDate);
  },

  /**
   * Get the latest NAV date for a scheme
   */
  getLatestNavDate(schemeId) {
    const series = navSeries(schemeId);
    return series.length ? { navDate: series[series.length - 1].navDate } : undefined;
  },

  /**
   * Check if a specific NAV date already exists
   */
  hasNavHistory(schemeId, navDate) {
    return navSeries(schemeId).some(p => p.navDate === navDate) ? { 1: 1 } : undefined;
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
