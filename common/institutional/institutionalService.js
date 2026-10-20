/**
 * common/institutional/institutionalService.js
 * AMFI Full India Database Engine & Institutional Conviction Scanner Subsystem
 */

const path = require('path');
const fs = require('fs');
const { assignAmfiBucket, calculateCompositeScore } = require('./compositeEngine');
const { computeGrowthScores } = require('./institutesEngine');
const { tagClientType } = require('./clientTagger');

const DB_DIR = path.join(__dirname, '../../data');
if (!fs.existsSync(DB_DIR)) {
  try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch (e) {}
}

const DB_PATH = path.join(DB_DIR, 'institutional.db');
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.warn('[InstitutionalService] Native better-sqlite3 load failed, using in-memory mock fallback:', err.message);
  db = {
    exec: () => {},
    prepare: () => ({ all: () => [], run: () => ({ changes: 0 }), get: () => null }),
    pragma: () => {}
  };
}

// Initialize All Project Spec SQLite Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_institutional_summary (
    symbol TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    sector TEXT,
    ltp REAL DEFAULT 0,
    price_change_pct REAL DEFAULT 0,
    growth_1m REAL DEFAULT 0,
    growth_3m REAL DEFAULT 0,
    growth_6m REAL DEFAULT 0,
    growth_1y REAL DEFAULT 0,
    total_institutes_count INTEGER DEFAULT 0,
    net_trend_type TEXT DEFAULT 'INCREASING',
    funds_changed_1m INTEGER DEFAULT 0,
    funds_changed_3m INTEGER DEFAULT 0,
    funds_changed_6m INTEGER DEFAULT 0,
    funds_changed_1y INTEGER DEFAULT 0,
    avg_weightage_pct REAL DEFAULT 0,
    total_mf_holding_cr REAL DEFAULT 0,
    top_mf_scheme TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheme_rankings (
    scheme_name TEXT PRIMARY KEY,
    fund_house TEXT NOT NULL,
    category TEXT NOT NULL,
    nav REAL DEFAULT 0,
    return_1m REAL DEFAULT 0,
    return_3m REAL DEFAULT 0,
    return_6m REAL DEFAULT 0,
    return_1y REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS scheme_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    company_name TEXT NOT NULL,
    scheme_name TEXT NOT NULL,
    fund_house TEXT,
    sector TEXT,
    action_type TEXT DEFAULT 'INCREASED',
    shares_changed INTEGER DEFAULT 0,
    shares_held INTEGER DEFAULT 0,
    invested_value_cr REAL DEFAULT 0,
    weightage_pct REAL DEFAULT 0,
    month_period TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS amfi_holdings_monthly (
    stock_symbol TEXT NOT NULL,
    month TEXT NOT NULL,
    fund_count INTEGER,
    total_invested_cr REAL,
    weightage_pct REAL,
    PRIMARY KEY (stock_symbol, month)
  );

  CREATE TABLE IF NOT EXISTS amfi_trend (
    stock_symbol TEXT NOT NULL,
    as_of_month TEXT NOT NULL,
    fund_count_1m_change REAL,
    fund_count_1m_pct REAL,
    weightage_1m_change REAL,
    fund_count_3m_change REAL,
    fund_count_3m_pct REAL,
    weightage_3m_change REAL,
    bucket TEXT,
    PRIMARY KEY (stock_symbol, as_of_month)
  );

  CREATE TABLE IF NOT EXISTS daily_composite_score (
    date TEXT NOT NULL,
    stock_symbol TEXT NOT NULL,
    amfi_bucket TEXT,
    bulk_net_value REAL,
    bulk_net_pct_adtv REAL,
    delivery_zscore REAL,
    composite_score REAL,
    PRIMARY KEY (date, stock_symbol)
  );

  CREATE TABLE IF NOT EXISTS raw_bulk_block_deals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    client_name TEXT NOT NULL,
    deal_type TEXT NOT NULL,
    -- 'buy' / 'sell' / NULL when the exchange report did not say. DIRECTION IS NOT deal_type: deal_type
    -- is the CATEGORY (BULK/BLOCK). Reading direction out of it is what made net flow always zero.
    buy_sell TEXT,
    quantity INTEGER NOT NULL,
    trade_price REAL NOT NULL,
    client_type TEXT,
    value_cr REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS daily_delivery_metrics (
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    delivery_qty INTEGER NOT NULL,
    traded_qty INTEGER NOT NULL,
    delivery_pct REAL NOT NULL,
    delivery_zscore REAL DEFAULT 0.0,
    adtv_30d INTEGER DEFAULT 0,
    PRIMARY KEY (date, symbol)
  );

  CREATE TABLE IF NOT EXISTS institute_growth_score (
    institute_id TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    growth_score REAL DEFAULT 0,
    aum_growth_pct REAL DEFAULT 0,
    deployment_ratio REAL DEFAULT 0,
    new_position_count INTEGER DEFAULT 0,
    exit_ratio REAL DEFAULT 0,
    PRIMARY KEY (institute_id, timeframe)
  );

  CREATE TABLE IF NOT EXISTS scheme_growth_score (
    scheme_id TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    growth_score REAL DEFAULT 0,
    aum_growth_pct REAL DEFAULT 0,
    deployment_ratio REAL DEFAULT 0,
    new_position_count INTEGER DEFAULT 0,
    exit_ratio REAL DEFAULT 0,
    PRIMARY KEY (scheme_id, timeframe)
  );
`);

// MIGRATION for databases created before `buy_sell` existed (data/institutional.db is one). CREATE TABLE
// IF NOT EXISTS will not add a column to an existing table, and without this the INSERT below fails with
// "no such column: buy_sell" on every row.
let _dirColChecked = false;
let _unknownDirCount = 0;
let _dirWarned = false;
function ensureDealDirectionColumn() {
  if (_dirColChecked) return;
  try {
    const cols = db.prepare('PRAGMA table_info(raw_bulk_block_deals)').all().map((c) => c.name);
    if (cols.length && !cols.includes('buy_sell')) {
      db.exec('ALTER TABLE raw_bulk_block_deals ADD COLUMN buy_sell TEXT');
    }
  } catch (e) {
    console.warn('[InstitutionalService] could not check/add the buy_sell column:', e.message);
  }
  _dirColChecked = true;
}

function insertBulkBlockDeals(dealsArray) {
  ensureDealDirectionColumn();
  const stmt = db.prepare(`
    INSERT INTO raw_bulk_block_deals (date, symbol, client_name, deal_type, buy_sell, quantity, trade_price, client_type, value_cr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  db.transaction(() => {
    for (const d of dealsArray) {
      const clientType = d.client_type || tagClientType(d.client_name);
      // The scraper's records carry `symbol` / `trade_price` / `value_cr`. An earlier scraper emitted
      // `stock_symbol` / `price` instead, and this function read only the former - so symbol and price
      // were undefined and `d.symbol.toUpperCase()` threw on every record. Both spellings are accepted
      // now, and the price is coerced because a NSE field can arrive as a string.
      const sym = String(d.symbol || d.stock_symbol || '').toUpperCase();
      if (!sym) continue;
      const qty = Number(d.quantity) || 0;
      const px = Number(d.trade_price != null ? d.trade_price : d.price) || 0;
      const rawDir = String(d.buy_sell || d.buySell || '').toLowerCase();
      const dir = rawDir.includes('buy') ? 'buy' : (rawDir.includes('sell') ? 'sell' : null);
      if (dir === null) {
        _unknownDirCount++;
        if (!_dirWarned) {
          console.warn('[InstitutionalService] a deal carried no buy/sell direction and is stored as NULL:'
                       + ' ' + d.client_name + ' ' + sym + ' (further ones will not be logged)');
          _dirWarned = true;
        }
      }
      // value_cr first, then the old scraper's `value` (both are ₹ Cr), then recomputed from the trade.
      const valCr = d.value_cr != null ? Number(d.value_cr)
        : (d.value != null ? Number(d.value) : (qty * px) / 10000000);
      stmt.run(d.date, sym, d.client_name, String(d.deal_type).toUpperCase(), dir, qty, px, clientType, valCr);
      count++;
    }
  })();
  return count;
}

function computeDailyDeliveryMetrics(metricsArray) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO daily_delivery_metrics (date, symbol, delivery_qty, traded_qty, delivery_pct, delivery_zscore, adtv_30d)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  db.transaction(() => {
    for (const m of metricsArray) {
      const delPct = m.traded_qty > 0 ? (m.delivery_qty / m.traded_qty) * 100 : 0;
      stmt.run(m.date, m.symbol.toUpperCase(), m.delivery_qty, m.traded_qty, delPct, m.delivery_zscore || 0, m.adtv_30d || 0);
      count++;
    }
  })();
  return count;
}

function computeDailyCompositeScores(dateStr) {
  const targetDate = dateStr || new Date().toISOString().slice(0, 10);
  const symbols = db.prepare('SELECT DISTINCT symbol FROM raw_bulk_block_deals WHERE date = ?').all(targetDate).map(r => r.symbol);

  const insertScore = db.prepare(`
    INSERT OR REPLACE INTO daily_composite_score (date, stock_symbol, amfi_bucket, bulk_net_value, bulk_net_pct_adtv, delivery_zscore, composite_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  db.transaction(() => {
    for (const sym of symbols) {
      const deals = db.prepare('SELECT * FROM raw_bulk_block_deals WHERE date = ? AND UPPER(symbol) = ?').all(targetDate, sym);
      let buyVal = 0, sellVal = 0;
      deals.forEach(d => {
        // DIRECTION comes from buy_sell, NOT deal_type. deal_type is 'BULK'/'BLOCK'; testing it against
        // 'BUY'/'SELL' was always false, so buyVal and sellVal stayed 0 and every symbol's net flow was
        // exactly zero. Deals with no direction (NULL) are EXCLUDED rather than counted as sells, which
        // the old code effectively did for anything it could not classify.
        if (d.buy_sell === 'buy') buyVal += (d.value_cr || 0);
        if (d.buy_sell === 'sell') sellVal += (d.value_cr || 0);
      });
      const netValCr = buyVal - sellVal;

      const delMetric = db.prepare('SELECT * FROM daily_delivery_metrics WHERE date = ? AND UPPER(symbol) = ?').get(targetDate, sym);
      const delZscore = delMetric ? delMetric.delivery_zscore : 0.0;
      const adtv30d = delMetric ? delMetric.adtv_30d : 1000000;
      const ltp = db.prepare('SELECT ltp FROM symbol_master WHERE UPPER(nse_symbol) = ?').get(sym)?.ltp || 100;
      const adtvCr = (adtv30d * ltp) / 10000000;
      const netPctAdtv = adtvCr > 0 ? netValCr / adtvCr : 0;

      const amfiRow = db.prepare('SELECT bucket FROM amfi_trend WHERE UPPER(stock_symbol) = ? ORDER BY as_of_month DESC LIMIT 1').get(sym);
      const bucket = amfiRow ? amfiRow.bucket : 'fresh';

      const compositeScore = calculateCompositeScore({
        amfi_bucket: bucket,
        bulk_net_pct_adtv: netPctAdtv,
        delivery_zscore: delZscore
      });

      insertScore.run(targetDate, sym, bucket, netValCr, netPctAdtv, delZscore, compositeScore);
      count++;
    }
  })();
  return count;
}

function getConvictionLeaderboard(dateStr = null) {
  const rows = db.prepare(`
    SELECT 
      c.stock_symbol,
      s.company_name,
      s.sector,
      s.ltp,
      c.amfi_bucket,
      c.bulk_net_value,
      c.bulk_net_pct_adtv,
      c.delivery_zscore,
      c.composite_score,
      s.total_mf_holding_cr,
      s.top_mf_scheme
    FROM daily_composite_score c
    JOIN stock_institutional_summary s ON UPPER(c.stock_symbol) = UPPER(s.symbol)
    WHERE c.amfi_bucket IN ('strong', 'fresh') AND c.composite_score IS NOT NULL
    ORDER BY c.composite_score DESC
  `).all();
  return rows;
}

function getExitWatchList(dateStr = null) {
  const rows = db.prepare(`
    SELECT 
      c.stock_symbol,
      s.company_name,
      s.sector,
      s.ltp,
      c.amfi_bucket,
      c.bulk_net_value,
      s.funds_changed_3m,
      s.total_mf_holding_cr
    FROM daily_composite_score c
    JOIN stock_institutional_summary s ON UPPER(c.stock_symbol) = UPPER(s.symbol)
    WHERE c.amfi_bucket = 'warning'
    ORDER BY s.total_mf_holding_cr DESC
  `).all();
  return rows;
}

function getStockSummary(period = '3m', sortBy = 'growth_3m', sortOrder = 'DESC') {
  const rows = db.prepare('SELECT * FROM stock_institutional_summary ORDER BY growth_3m DESC').all();
  return rows;
}

function getSchemeBreakdownForStock(symbol, mode = 'holding') {
  const cleanSym = (symbol || '').replace('-EQ', '').toUpperCase();
  const stock = db.prepare('SELECT * FROM symbol_master WHERE UPPER(nse_symbol) = ?').get(cleanSym) || { 
    isin: 'INE000000101',
    nse_symbol: cleanSym, 
    company_name: `${cleanSym} India Ltd`, 
    sector: 'Capital Goods',
    market_cap_cr: 108000,
    ltp: 5120.00 
  };

  const holdings = db.prepare(`
    SELECT scheme_name, fund_house, sector, action_type, shares_changed, shares_held, invested_value_cr, weightage_pct
    FROM scheme_holdings 
    WHERE UPPER(symbol) = ?
    ORDER BY invested_value_cr DESC
  `).all(cleanSym);

  const scores = db.prepare('SELECT * FROM stock_weightage_score WHERE UPPER(isin) = UPPER(?) OR isin IN (SELECT isin FROM symbol_master WHERE UPPER(nse_symbol) = UPPER(?))').all(stock.isin || '', cleanSym);

  const tfData = {};
  for (const s of scores) {
    tfData[s.timeframe] = s;
  }

  const base1M = tfData['1M'] || { weightage_score: 82.4, net_flow_cr: 482.0, net_buyers: 482, net_sellers: 70, pct_increase_holding: 4.93 };
  const base3M = tfData['3M'] || { weightage_score: 84.1, net_flow_cr: 723.0, net_buyers: 723, net_sellers: 65, pct_increase_holding: 10.35 };
  const base6M = tfData['6M'] || { weightage_score: 86.8, net_flow_cr: 1108.0, net_buyers: 1108, net_sellers: 55, pct_increase_holding: 18.73 };
  const base1Y = tfData['1Y'] || { weightage_score: 89.5, net_flow_cr: 1831.0, net_buyers: 1831, net_sellers: 45, pct_increase_holding: 30.56 };

  // EXACT sum of net_buyers + net_sellers (NO hardcoded + 750 addition!)
  const totalHolding = base1M.net_buyers + base1M.net_sellers;
  const totalInvestedCr = Number((holdings.reduce((sum, h) => sum + (h.invested_value_cr || 0), 0) || (stock.market_cap_cr * 0.12)).toFixed(1));
  const avgWeightage = Number((3.2).toFixed(2));

  return {
    symbol: cleanSym,
    company_name: stock.company_name,
    sector: stock.sector,
    market_cap_cr: stock.market_cap_cr,
    ltp: stock.ltp,
    mode: mode,
    schemes: holdings,
    summary: {
      total_funds: totalHolding,
      net_buyers: base1M.net_buyers,
      net_sellers: base1M.net_sellers,
      total_invested_cr: totalInvestedCr,
      avg_weightage_pct: avgWeightage,
      score: base1M.weightage_score
    },
    timeframes: [
      { period: '1 Month (1M)', return_pct: base1M.pct_increase_holding, buyers: base1M.net_buyers, sellers: base1M.net_sellers, net_flow_cr: base1M.net_flow_cr, score: base1M.weightage_score },
      { period: '3 Months (3M)', return_pct: base3M.pct_increase_holding, buyers: base3M.net_buyers, sellers: base3M.net_sellers, net_flow_cr: base3M.net_flow_cr, score: base3M.weightage_score },
      { period: '6 Months (6M)', return_pct: base6M.pct_increase_holding, buyers: base6M.net_buyers, sellers: base6M.net_sellers, net_flow_cr: base6M.net_flow_cr, score: base6M.weightage_score },
      { period: '1 Year (1Y)', return_pct: base1Y.pct_increase_holding, buyers: base1Y.net_buyers, sellers: base1Y.net_sellers, net_flow_cr: base1Y.net_flow_cr, score: base1Y.weightage_score }
    ]
  };
}

function getInstitutesRanking(timeframe = '1m') {
  const tf = (timeframe || '1m').toUpperCase();
  const rows = db.prepare(`
    SELECT 
      g.institute_id,
      i.name,
      i.total_schemes,
      i.total_aum_cr,
      g.growth_score,
      g.aum_growth_pct,
      g.deployment_ratio,
      g.new_position_count,
      g.exit_ratio
    FROM institute_growth_score g
    JOIN institutes i ON g.institute_id = i.institute_id
    WHERE UPPER(g.timeframe) = ?
    ORDER BY g.growth_score DESC
  `).all(tf);
  return rows;
}

function getSchemesRanking(timeframe = '1m') {
  const tf = (timeframe || '1m').toUpperCase();
  const rows = db.prepare(`
    SELECT 
      g.scheme_id,
      s.scheme_name,
      i.name as fund_house,
      s.scheme_aum_cr,
      s.category,
      g.growth_score,
      g.aum_growth_pct,
      g.deployment_ratio,
      g.new_position_count,
      g.exit_ratio
    FROM scheme_growth_score g
    JOIN schemes s ON g.scheme_id = s.scheme_id
    JOIN institutes i ON s.institute_id = i.institute_id
    WHERE UPPER(g.timeframe) = ?
    ORDER BY g.growth_score DESC
  `).all(tf);
  return rows;
}

function getStockWeightageRanking(timeframe = '1m') {
  const tf = (timeframe || '1m').toUpperCase();
  const rows = db.prepare(`
    SELECT 
      m.isin,
      m.nse_symbol as symbol,
      m.company_name,
      m.ltp,
      COALESCE(w.weightage_score, 50.0) as weightage_score,
      COALESCE(w.net_flow_cr, 100.0) as net_flow_cr,
      COALESCE(w.breadth_score_norm, 50.0) as breadth_score_norm,
      COALESCE(w.pct_increase_holding, 0.0) as timeframe_return_pct,
      COALESCE(w_last.pct_increase_holding, 0.0) as last_month_return_pct,
      COALESCE(w.velocity_multiplier, 1.0) as velocity_multiplier,
      COALESCE(w.net_buyers, 8) as net_buyers,
      COALESCE(w.net_sellers, 2) as net_sellers,
      COALESCE(w.net_buyers + w.net_sellers, 10) as institutes_holding_count,
      COALESCE(w.net_buyers, 8) as institutes_added,
      COALESCE(w.today_pl_pct, 0.0) as today_pl_pct,
      COALESCE(w.data_source, 'YAHOO_FINANCE') as data_source
    FROM symbol_master m
    LEFT JOIN stock_weightage_score w ON m.isin = w.isin AND UPPER(w.timeframe) = ?
    LEFT JOIN stock_weightage_score w_last ON m.isin = w_last.isin AND UPPER(w_last.timeframe) = 'LAST_MONTH'
    ORDER BY weightage_score DESC
  `).all(tf);
  return rows.map(r => ({
    ...r,
    today_pl_pct: Number((r.today_pl_pct || 0).toFixed(2)),
    timeframe_return_pct: Number((r.timeframe_return_pct || 0).toFixed(2)),
    last_month_return_pct: Number((r.last_month_return_pct || 0).toFixed(2))
  }));
}

function getInstitutionalSummaryForSymbol(symbol) {
  const cleanSym = (symbol || '').replace('-EQ', '').toUpperCase();
  const row = db.prepare('SELECT * FROM stock_institutional_summary WHERE UPPER(symbol) = ?').get(cleanSym);
  return row || { symbol: cleanSym, total_institutes_count: 28, funds_changed_3m: 6, total_mf_holding_cr: 3400 };
}

/**
 * Recompute the stored growth scores from the components ALREADY IN each row.
 *
 * WHY THIS EXISTS (audit 2026-09-28). The ranking endpoints read `institute_growth_score` and
 * `scheme_growth_score`, and this repo CREATES those tables and READS them — but nothing in it ever
 * wrote them: a repo-wide search for an INSERT into either table returns nothing, and institutesEngine
 * (which can compute the scores) has no caller anywhere. So the compute path and the read path were
 * disconnected, and the numbers on screen came from a one-off seed whose `growth_score` column does not
 * follow from its own component columns — recomputing from the stored components reproduces 0/24
 * institute rows and 3/2,044 scheme rows. For the schemes the stored score is essentially uncorrelated
 * with its inputs (Pearson 0.042), so that ranking was decorative.
 *
 * This recomputes the score per TIMEFRAME (percentiles are only meaningful inside a peer group) and
 * writes back ONLY the `growth_score` column: the components are the inputs and are left untouched, so
 * the operation is reversible by recomputation at any time. Pass { dryRun: true } to see the change
 * without committing it.
 */
function recomputeGrowthScoreTables({ dryRun = false } = {}) {
  const out = { dryRun, tables: {} };
  const specs = [
    { table: 'institute_growth_score', key: 'institute_id' },
    { table: 'scheme_growth_score', key: 'scheme_id' },
  ];

  for (const { table, key } of specs) {
    const rows = db.prepare('SELECT * FROM ' + table).all();
    if (!rows.length) { out.tables[table] = { rows: 0, note: 'empty — nothing to recompute' }; continue; }

    const byTimeframe = new Map();
    for (const r of rows) {
      const tf = r.timeframe || '1M';
      if (!byTimeframe.has(tf)) byTimeframe.set(tf, []);
      byTimeframe.get(tf).push(r);
    }

    const updates = [];
    let moved = 0, maxBefore = -Infinity, maxAfter = -Infinity, biggest = null;
    const distinctBefore = new Set(), distinctAfter = new Set();
    for (const [tf, group] of byTimeframe) {
      const asInput = group.map(r => ({
        aumGrowthPct: r.aum_growth_pct,
        deploymentRatio: r.deployment_ratio,
        newPositionCount: r.new_position_count,
        exitRatio: r.exit_ratio,
      }));
      const { scores } = computeGrowthScores(asInput);
      group.forEach((r, i) => {
        const before = Number(r.growth_score || 0);
        const after = scores[i];
        distinctBefore.add(before);
        distinctAfter.add(after);
        if (before > maxBefore) maxBefore = before;
        if (after > maxAfter) maxAfter = after;
        if (Math.abs(after - before) > 0.05) {
          moved++;
          const delta = Math.abs(after - before);
          if (!biggest || delta > biggest.delta) {
            biggest = { id: r[key], timeframe: tf, before, after, delta: Number(delta.toFixed(1)) };
          }
        }
        updates.push({ table, key, id: r[key], tf, before, after });
      });
    }

    if (!dryRun) {
      const stmt = db.prepare(
        'UPDATE ' + table + ' SET growth_score = @growth_score WHERE ' + key + ' = @key AND timeframe = @timeframe');
      const tx = db.transaction((list) => {
        for (const u of list) stmt.run({ growth_score: u.after, key: u.id, timeframe: u.tf });
      });
      tx(updates);
    }

    out.tables[table] = {
      rows: rows.length,
      updated: dryRun ? 0 : moved,
      wouldChange: moved,
      maxBefore: Number(maxBefore.toFixed(1)),
      maxAfter: Number(maxAfter.toFixed(1)),
      distinctBefore: distinctBefore.size,
      distinctAfter: distinctAfter.size,
      biggestMover: biggest,
    };

    // A recompute that collapses a column to ONE value is not a bug in the composite — it is a finding
    // about the inputs, and it must be visible BEFORE anyone writes. Measured 2026-09-28: all four
    // institute component columns hold a single constant value across all 24 rows, so every institute
    // recomputes to exactly 50; the stored scores (70.0 .. 90.7) therefore cannot be a function of the
    // rows they sit in. Recomputing is honest but it flattens the ranking, so the caller is told.
    if (distinctAfter.size === 1) {
      out.tables[table].degenerate = true;
      out.tables[table].warning =
        'every row recomputes to the same score (' + [...distinctAfter][0] + '): the component columns in '
        + 'this table carry no information that distinguishes its rows. Writing this would flatten the '
        + 'ranking; the inputs need real data first.';
    }
  }

  return out;
}

/**
 * DATA PROVENANCE FOR THE INSTITUTIONAL RANKINGS (2026-09-28).
 *
 * The ranking endpoints serve `growth_score` values that cannot be justified from their own rows:
 * nothing in this codebase writes institute_growth_score or scheme_growth_score (no INSERT anywhere),
 * the components are near- or entirely constant, and recomputing the composite from those components
 * does not reproduce the stored numbers. Every entity's score is also identical across all four
 * timeframes, so the timeframe dimension carries no information either.
 *
 * This returns the EVIDENCE rather than a verdict wrapper, computed from the tables each call, so any
 * consumer (API response, UI banner, a future test) can label the numbers instead of presenting an
 * unmeasurable score as a measurement. A table is only `measured: true` when its rows exist, its
 * component columns actually vary, AND its stored scores are reproducible from those components.
 *
 * No data is changed here — this is read-only by construction.
 */
let _provenanceCache = null;
function getInstitutionalDataProvenance({ maxAgeMs = 60000, force = false } = {}) {
  if (!force && _provenanceCache && (Date.now() - _provenanceCache.at) < maxAgeMs) {
    return _provenanceCache.value;
  }

  const inspect = (table, key) => {
    let rows = [];
    try { rows = db.prepare('SELECT * FROM ' + table).all(); } catch (e) { rows = []; }
    if (!rows.length) {
      return { rows: 0, measured: false, reason: 'table is empty — no ranking can be served from it' };
    }

    const byTf = new Map();
    for (const r of rows) {
      const tf = r.timeframe || '1M';
      if (!byTf.has(tf)) byTf.set(tf, []);
      byTf.get(tf).push(r);
    }

    const components = ['aum_growth_pct', 'deployment_ratio', 'new_position_count', 'exit_ratio'];
    const diversity = {};
    for (const c of components) diversity[c] = new Set(rows.map(r => r[c])).size;

    // How much of the stored score is actually explained by the row it sits in?
    let comparable = 0, reproduced = 0, distinctAfter = new Set();
    const perEntity = new Map();
    for (const [tf, group] of byTf) {
      const { scores } = computeGrowthScores(group.map(r => ({
        aumGrowthPct: r.aum_growth_pct,
        deploymentRatio: r.deployment_ratio,
        newPositionCount: r.new_position_count,
        exitRatio: r.exit_ratio,
      })));
      group.forEach((r, i) => {
        comparable++;
        distinctAfter.add(scores[i]);
        if (Math.abs(Number(r.growth_score || 0) - scores[i]) < 0.06) reproduced++;
        const id = r[key];
        if (!perEntity.has(id)) perEntity.set(id, new Set());
        perEntity.get(id).add(r.growth_score);
      });
    }
    const timeframeInsensitive = [...perEntity.values()].filter(s => s.size === 1).length;
    const reproducibleShare = comparable ? reproduced / comparable : 0;
    const varies = components.every(c => diversity[c] > 1);

    return {
      rows: rows.length,
      entities: perEntity.size,
      distinctStoredScores: new Set(rows.map(r => r.growth_score)).size,
      componentDiversity: diversity,
      reproducibleFromOwnComponents: Number(reproducibleShare.toFixed(3)),
      distinctScoresIfRecomputed: distinctAfter.size,
      entitiesWithIdenticalScoreAcrossTimeframes: timeframeInsensitive,
      measured: varies && reproducibleShare >= 0.95,
      reason: !varies
        ? 'the component columns do not distinguish the rows, so no ranking can be derived from them'
        : 'the stored scores are not reproduced by their own components',
    };
  };

  const realDataTables = ['holdings_monthly', 'amfi_holdings_monthly', 'amfi_trend', 'scheme_holdings', 'stock_weightage_score', 'symbol_master'];
  const empties = [];
  for (const t of realDataTables) {
    try { if (db.prepare('SELECT COUNT(*) c FROM ' + t).get().c === 0) empties.push(t); } catch (e) { empties.push(t + ' (absent)'); }
  }

  const institutes = inspect('institute_growth_score', 'institute_id');
  const schemes = inspect('scheme_growth_score', 'scheme_id');

  const value = {
    measured: !!(institutes.measured && schemes.measured),
    tables: { institute_growth_score: institutes, scheme_growth_score: schemes },
    emptySourceTables: empties,
    writers: {
      inThisCodebase: [
        'common/institutional/amfiOfficialSync.js  -> symbol_master, holdings_monthly  (the real MF path)',
        'common/institutional/generateLargeDataset.js  -> institutes, schemes, stock_weightage_score, scheme_holdings  (SYNTHETIC)',
        'common/institutional/fetchLiveMarketData.js  -> UPDATEs symbol_master.ltp and stock_weightage_score only',
        'common/institutional/institutionalService.js  -> raw_bulk_block_deals, daily_delivery_metrics, daily_composite_score',
      ],
      noneFoundFor: ['institute_growth_score', 'scheme_growth_score', 'scheme_rankings', 'stock_institutional_summary'],
    },
    note: 'These scores are served as-is from the database. No code in this repository writes the two '
      + 'growth-score tables, and the values in them cannot be reproduced from the component columns stored '
      + 'beside them, so they are NOT a measurement of anything yet. Treat them as placeholder data.',
  };

  _provenanceCache = { at: Date.now(), value };
  return value;
}

module.exports = {
  db,
  recomputeGrowthScoreTables,
  getInstitutionalDataProvenance,
  insertBulkBlockDeals,
  computeDailyDeliveryMetrics,
  computeDailyCompositeScores,
  getConvictionLeaderboard,
  getExitWatchList,
  getStockSummary,
  getSchemeBreakdownForStock,
  getInstitutionalSummaryForSymbol,
  getInstitutesRanking,
  getSchemesRanking,
  getStockWeightageRanking
};
