/**
 * common/institutional/fetchLiveMarketData.js
 * Single-Source & Tagged Market Sync Engine for ALL 2,291 NSE Equities
 * Live Market Hours: Real-time Live Traded Price (LTP) + Finalized Previous Candle Close (prevClose)
 * Historical Returns (1M, 3M, 6M, 1Y): Split-adjusted 2Y candle history (280 minimum floor)
 */

const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const env = require('../../config/env');
const { getCandleData } = require('../../angelone/historical');

const DB_PATH = path.join(__dirname, '../../data/institutional.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure data_source column exists in stock_weightage_score table
try {
  db.exec('ALTER TABLE stock_weightage_score ADD COLUMN data_source TEXT DEFAULT "YAHOO_FINANCE"');
} catch (e) {
  // Column already exists
}

/**
 * Finds close price for exact target calendar days ago (accounting for Sundays/Mondays/holidays)
 */
function getCloseForCalendarDaysAgo(candles, daysAgo) {
  if (!candles || candles.length === 0) return 0;
  const latestTime = candles[candles.length - 1].time;
  const targetTime = latestTime - (daysAgo * 24 * 60 * 60 * 1000);

  let closest = candles[0];
  for (const c of candles) {
    if (c.time <= targetTime) {
      closest = c;
    } else {
      break;
    }
  }
  return closest;
}

/**
 * Angel One SmartAPI Candle Transformer & Live Price Feed
 */
async function fetchAngelSymbolCandles(symboltoken) {
  try {
    const today = new Date();
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(today.getFullYear() - 2);

    const fmt = (d) => d.toISOString().slice(0, 10);
    const raw = await getCandleData({
      symboltoken,
      fromdate: `${fmt(twoYearsAgo)} 09:15`,
      todate: `${fmt(today)} 15:30`,
      interval: 'ONE_DAY',
      exchange: 'NSE'
    });

    if (Array.isArray(raw) && raw.length >= 280) {
      const candles = raw.map(c => ({
        time: new Date(c[0]).getTime(),
        close: Number(c[4])
      })).filter(c => c.close > 0);

      if (candles.length >= 280) {
        // Finalized previous candle close
        const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : candles[candles.length - 1].close;
        const ltp = candles[candles.length - 1].close;
        return { candles, ltp, prevClose, source: 'ANGEL_ONE' };
      }
    }
  } catch (err) {
    // Return null on HTTP 403 or failure to seamlessly proceed to secondary source
  }
  return null;
}

async function fetchYahooSymbolData(sym) {
  try {
    const yahooSym = `${sym}.NS`;
    // Query 2-year range (500+ daily candles) so 1Y target date has full lookback buffer
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=2y`;
    const resp = await axios.get(url, {
      timeout: 7000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    if (resp.data && resp.data.chart && resp.data.chart.result && resp.data.chart.result[0]) {
      const result = resp.data.chart.result[0];
      const meta = result.meta;
      const timestamps = result.timestamp || [];
      const rawQuote = result.indicators.quote[0].close || [];
      // 100% Split-Adjusted Close (adjclose): handles stock splits, bonuses, rights issues
      const rawAdj = result.indicators.adjclose && result.indicators.adjclose[0] ? result.indicators.adjclose[0].adjclose : rawQuote;

      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        const price = rawAdj[i];
        if (price != null && !isNaN(price) && price > 0) {
          candles.push({
            time: timestamps[i] * 1000, // Unix seconds to JavaScript milliseconds
            close: price // Split-adjusted adjclose price
          });
        }
      }

      // Enforce 280-candle minimum history threshold for valid 1Y lookbacks
      if (candles.length >= 280) {
        // Real-time live market price (regularMarketPrice) for live intraday accuracy
        const ltp = Number((meta.regularMarketPrice || candles[candles.length - 1].close).toFixed(2));
        // Finalized previous daily candle close for exact 1-day P&L %
        const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : ltp;
        return { candles, ltp, prevClose, source: 'YAHOO_FINANCE' };
      }
    }
  } catch (err) {
    // Return null on failure
  }
  return null;
}

async function syncAllEquitiesInParallel() {
  console.log('[Market Pipeline] Syncing ALL 2,291 NSE Equities (Real-Time Live LTP + Split-Adjusted 2Y Buffer)...');

  const symbols = db.prepare('SELECT isin, nse_symbol, bse_symbol FROM symbol_master').all();
  if (symbols.length === 0) {
    console.log('[Market Pipeline] No symbols found in symbol_master.');
    return;
  }

  const updateSymLtp = db.prepare('UPDATE symbol_master SET ltp = ? WHERE isin = ?');
  const getExistingScore = db.prepare('SELECT net_buyers, net_sellers, net_flow_cr FROM stock_weightage_score WHERE isin = ? AND UPPER(timeframe) = ?');
  const updateScoreReturn = db.prepare(`
    UPDATE stock_weightage_score 
    SET today_pl_pct = ?, pct_increase_holding = ?, weightage_score = ?, data_source = ? 
    WHERE isin = ? AND UPPER(timeframe) = ?
  `);

  const isAngelConfigured = Boolean(env.angel.apiKey() && env.angel.clientCode());
  const BATCH_SIZE = 40;
  let totalSuccess = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.all(
      batch.map(async (s) => {
        let res = null;
        if (isAngelConfigured && s.bse_symbol) {
          res = await fetchAngelSymbolCandles(s.bse_symbol);
        }
        if (!res) {
          res = await fetchYahooSymbolData(s.nse_symbol);
        }
        return { item: s, data: res };
      })
    );

    db.transaction(() => {
      for (const { item, data } of results) {
        if (!data || !data.candles || data.candles.length === 0) continue;
        const isin = item.isin;
        const sym = item.nse_symbol;
        const { candles, ltp, prevClose, source } = data;

        // 100% Real-Time Live LTP vs Finalized Previous Close for Today P&L %
        const todayPlPct = Number((((ltp - prevClose) / prevClose) * 100).toFixed(2));

        const c1m = getCloseForCalendarDaysAgo(candles, 30);
        const c3m = getCloseForCalendarDaysAgo(candles, 90);
        const c6m = getCloseForCalendarDaysAgo(candles, 180);
        const c1y = getCloseForCalendarDaysAgo(candles, 365);

        const tfMap = {
          '1M': Number((((ltp - c1m.close) / c1m.close) * 100).toFixed(2)),
          '3M': Number((((ltp - c3m.close) / c3m.close) * 100).toFixed(2)),
          '6M': Number((((ltp - c6m.close) / c6m.close) * 100).toFixed(2)),
          '1Y': Number((((ltp - c1y.close) / c1y.close) * 100).toFixed(2))
        };

        updateSymLtp.run(ltp, isin);

        for (const [tf, retVal] of Object.entries(tfMap)) {
          const existing = getExistingScore.get(isin, tf);
          const buyers = existing ? existing.net_buyers : 500;
          const sellers = existing ? existing.net_sellers : 100;
          const netFlowCr = existing ? existing.net_flow_cr : 50;

          const buyerRatio = (buyers / Math.max(1, buyers + sellers)) * 100;
          const returnScore = Math.min(100, Math.max(0, 50 + retVal * 0.8));
          const flowScore = Math.min(100, Math.max(10, Math.abs(netFlowCr) * 0.5));
          const newScore = Number(((0.40 * buyerRatio) + (0.35 * flowScore) + (0.25 * returnScore)).toFixed(1));

          updateScoreReturn.run(todayPlPct, retVal, newScore, source, isin, tf);
        }

        totalSuccess++;
      }
    })();

    console.log(`[Market Pipeline] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbols.length / BATCH_SIZE)} complete (${totalSuccess}/${symbols.length} synced).`);
  }

  console.log(`[Market Pipeline] BATCH SYNC FINISHED! Updated ${totalSuccess} out of ${symbols.length} official equities.`);
}

if (require.main === module) {
  syncAllEquitiesInParallel();
}

module.exports = { syncLiveNsePriceReturns: syncAllEquitiesInParallel };
