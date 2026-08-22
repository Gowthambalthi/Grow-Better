/**
 * common/institutional/fetchLiveMarketData.js
 * Monthly Calendar & MTD Return Engine for ALL 2,291 NSE Equities
 * Tracks:
 * - Today P&L % & Price Change ₹ (LTP vs Prev Close)
 * - This Month MTD Return % & Change ₹ (Month Start to Today)
 * - Last Month Full Return % & Change ₹ (Prior Month Start to Current Month Start)
 * - Composite Weightage Score calculated from Institutional Buying + This Month + Last Month + Today P&L
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
  if (!candles || candles.length === 0) return candles[0] || { close: 0, time: 0 };
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
 * Computes Exact Calendar Month Returns:
 * - mtdPct / mtdChange: Current Month Start to Today
 * - lastMonthPct / lastMonthChange: Prior Month Start to Current Month Start
 */
function getMonthlyCalendarReturns(candles) {
  if (!candles || candles.length === 0) return { lastMonthPct: 0, lastMonthChange: 0, mtdPct: 0, mtdChange: 0 };
  
  const latestCandle = candles[candles.length - 1];
  const latestDate = new Date(latestCandle.time);
  const currentYear = latestDate.getFullYear();
  const currentMonth = latestDate.getMonth();

  const currentMonthStartTime = new Date(currentYear, currentMonth, 1).getTime();
  const priorMonthStartTime = new Date(currentYear, currentMonth - 1, 1).getTime();

  let currentMonthStartCandle = candles[0];
  let priorMonthStartCandle = candles[0];

  for (const c of candles) {
    if (c.time <= currentMonthStartTime) {
      currentMonthStartCandle = c;
    }
    if (c.time <= priorMonthStartTime) {
      priorMonthStartCandle = c;
    }
  }

  const ltp = latestCandle.close;

  // This Month (MTD so far)
  const mtdChange = ltp - currentMonthStartCandle.close;
  const mtdPct = ((ltp - currentMonthStartCandle.close) / Math.max(0.01, currentMonthStartCandle.close)) * 100;

  // Last Month (Full Prior Month)
  const lastMonthChange = currentMonthStartCandle.close - priorMonthStartCandle.close;
  const lastMonthPct = ((currentMonthStartCandle.close - priorMonthStartCandle.close) / Math.max(0.01, priorMonthStartCandle.close)) * 100;

  return {
    lastMonthPct: Number(lastMonthPct.toFixed(2)),
    lastMonthChange: Number(lastMonthChange.toFixed(2)),
    mtdPct: Number(mtdPct.toFixed(2)),
    mtdChange: Number(mtdChange.toFixed(2))
  };
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
        const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : candles[candles.length - 1].close;
        const ltp = candles[candles.length - 1].close;
        return { candles, ltp, prevClose, source: 'ANGEL_ONE' };
      }
    }
  } catch (err) {
    // Return null on HTTP 403 or failure to proceed to fallback
  }
  return null;
}

async function fetchYahooSymbolData(sym) {
  try {
    const yahooSym = `${sym}.NS`;
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
      const rawAdj = result.indicators.adjclose && result.indicators.adjclose[0] ? result.indicators.adjclose[0].adjclose : rawQuote;

      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        const price = rawAdj[i];
        if (price != null && !isNaN(price) && price > 0) {
          candles.push({
            time: timestamps[i] * 1000,
            close: price
          });
        }
      }

      if (candles.length >= 280) {
        const ltp = Number((meta.regularMarketPrice || candles[candles.length - 1].close).toFixed(2));
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
  console.log('[Monthly Calendar Pipeline] Syncing ALL 2,291 NSE Equities (Last Month + This Month MTD + Today P&L)...');

  const symbols = db.prepare('SELECT isin, nse_symbol, bse_symbol FROM symbol_master').all();
  if (symbols.length === 0) {
    console.log('[Monthly Calendar Pipeline] No symbols found in symbol_master.');
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

        // 1. Today P&L %
        const todayPlPct = Number((((ltp - prevClose) / prevClose) * 100).toFixed(2));

        // 2. Exact Calendar Month Returns (Last Month vs This Month MTD)
        const { lastMonthPct, mtdPct } = getMonthlyCalendarReturns(candles);

        // 3. Standard Rolling Window Returns (3M, 6M, 1Y)
        const c3m = getCloseForCalendarDaysAgo(candles, 90);
        const c6m = getCloseForCalendarDaysAgo(candles, 180);
        const c1y = getCloseForCalendarDaysAgo(candles, 365);

        const ret3m = Number((((ltp - c3m.close) / c3m.close) * 100).toFixed(2));
        const ret6m = Number((((ltp - c6m.close) / c6m.close) * 100).toFixed(2));
        const ret1y = Number((((ltp - c1y.close) / c1y.close) * 100).toFixed(2));

        const tfMap = {
          '1M': mtdPct,      // This Month (MTD so far until today)
          '3M': ret3m,
          '6M': ret6m,
          '1Y': ret1y
        };

        updateSymLtp.run(ltp, isin);

        for (const [tf, retVal] of Object.entries(tfMap)) {
          const existing = getExistingScore.get(isin, tf);
          const buyers = existing ? existing.net_buyers : 500;
          const sellers = existing ? existing.net_sellers : 100;
          const netFlowCr = existing ? existing.net_flow_cr : 50;

          const buyerRatio = (buyers / Math.max(1, buyers + sellers)) * 100;
          
          // Weightage Score blending: 35% Buyer Ratio, 30% MTD Return, 20% Last Month Return, 15% Today P&L
          const mtdScore = Math.min(100, Math.max(0, 50 + mtdPct * 0.8));
          const lastMonthScore = Math.min(100, Math.max(0, 50 + lastMonthPct * 0.8));
          const todayScore = Math.min(100, Math.max(0, 50 + todayPlPct * 2.0));

          const newScore = Number((
            (0.35 * buyerRatio) + 
            (0.30 * mtdScore) + 
            (0.20 * lastMonthScore) + 
            (0.15 * todayScore)
          ).toFixed(1));

          updateScoreReturn.run(todayPlPct, retVal, newScore, source, isin, tf);
        }

        totalSuccess++;
      }
    })();

    console.log(`[Monthly Calendar Pipeline] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbols.length / BATCH_SIZE)} complete (${totalSuccess}/${symbols.length} synced).`);
  }

  console.log(`[Monthly Calendar Pipeline] BATCH SYNC FINISHED! Updated ${totalSuccess} out of ${symbols.length} official equities.`);
}

if (require.main === module) {
  syncAllEquitiesInParallel();
}

module.exports = { syncLiveNsePriceReturns: syncAllEquitiesInParallel };
