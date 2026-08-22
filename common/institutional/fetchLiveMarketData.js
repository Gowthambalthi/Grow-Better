/**
 * common/institutional/fetchLiveMarketData.js
 * Live Dynamic NSE Stock Price & Calendar-Day Return Fetcher Pipeline
 * Counts CALENDAR DAYS (including Sundays, Mondays, Saturdays, and all holidays):
 * - Today P&L %: Exact 1 Calendar Session Price Change ((LTP - PrevClose)/PrevClose * 100)
 * - 1M: 30 Calendar Days ago
 * - 3M: 90 Calendar Days ago
 * - 6M: 180 Calendar Days ago
 * - 1Y: 365 Calendar Days ago
 */

const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const env = require('../../config/env');
const { getCandleData } = require('../../angelone/historical');

const DB_PATH = path.join(__dirname, '../../data/institutional.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/**
 * Finds close price for exact target calendar days ago (accounting for Sundays/Mondays/holidays)
 * @param {Array<{time: number, close: number}>} candles
 * @param {number} daysAgo - 30 (1M), 90 (3M), 180 (6M), 365 (1Y)
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
  return closest.close;
}

async function fetchAngelCandlesWithTime(symboltoken) {
  try {
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);

    const fmt = (d) => d.toISOString().slice(0, 10);
    const raw = await getCandleData({
      symboltoken,
      fromdate: `${fmt(oneYearAgo)} 09:15`,
      todate: `${fmt(today)} 15:30`,
      interval: 'ONE_DAY',
      exchange: 'NSE'
    });

    if (Array.isArray(raw) && raw.length > 0) {
      return raw.map(c => ({
        time: new Date(c[0]).getTime(),
        close: Number(c[4])
      })).filter(c => c.close > 0);
    }
  } catch (err) {
    // Return null on failure to trigger yfinance fallback
  }
  return null;
}

async function syncLiveNsePriceReturns() {
  console.log('[Live Price Sync] Fetching 100% REAL 1-Day Today P&L % and Calendar Day Returns (30d, 90d, 180d, 365d)...');

  const symbols = db.prepare('SELECT isin, nse_symbol, bse_symbol FROM symbol_master').all();
  if (symbols.length === 0) {
    console.log('[Live Price Sync] No symbols found in symbol_master.');
    return;
  }

  const updateSymLtp = db.prepare('UPDATE symbol_master SET ltp = ? WHERE isin = ?');
  const getExistingScore = db.prepare('SELECT net_buyers, net_sellers, net_flow_cr FROM stock_weightage_score WHERE isin = ? AND UPPER(timeframe) = ?');
  const updateScoreReturn = db.prepare(`
    UPDATE stock_weightage_score 
    SET today_pl_pct = ?, pct_increase_holding = ?, weightage_score = ? 
    WHERE isin = ? AND UPPER(timeframe) = ?
  `);

  let successCount = 0;
  let angelCount = 0;
  let yfinanceCount = 0;

  const isAngelConfigured = Boolean(env.angel.apiKey() && env.angel.clientCode());

  for (const s of symbols) {
    const isin = s.isin;
    const sym = s.nse_symbol;
    const token = s.bse_symbol || '';

    let candles = null;
    let ltp = 0;
    let prevClose = 0;
    let usedSource = 'yfinance';

    // 1. Try Angel One SmartAPI getCandleData if configured and token exists
    if (isAngelConfigured && token) {
      candles = await fetchAngelCandlesWithTime(token);
      if (candles && candles.length > 0) {
        usedSource = 'Angel One SmartAPI';
        angelCount++;
      }
    }

    // 2. Fallback to yfinance (Yahoo Finance split-adjusted adjclose)
    if (!candles || candles.length === 0) {
      try {
        const yahooSym = `${sym}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1y`;
        const resp = await axios.get(url, {
          timeout: 6000,
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        if (resp.data && resp.data.chart && resp.data.chart.result && resp.data.chart.result[0]) {
          const result = resp.data.chart.result[0];
          const meta = result.meta;
          const timestamps = result.timestamp || [];
          const rawQuote = result.indicators.quote[0].close || [];
          const rawAdj = result.indicators.adjclose && result.indicators.adjclose[0] ? result.indicators.adjclose[0].adjclose : rawQuote;

          candles = [];
          for (let i = 0; i < timestamps.length; i++) {
            const price = rawAdj[i];
            if (price != null && !isNaN(price) && price > 0) {
              candles.push({
                time: timestamps[i] * 1000,
                close: price
              });
            }
          }

          ltp = Number((meta.regularMarketPrice || candles[candles.length - 1].close).toFixed(2));
          prevClose = meta.chartPreviousClose || (candles.length >= 2 ? candles[candles.length - 2].close : ltp);
          usedSource = 'yfinance';
          yfinanceCount++;
        }
      } catch (err) {
        // Skip on error
      }
    }

    if (candles && candles.length > 0) {
      if (!ltp) ltp = Number(candles[candles.length - 1].close.toFixed(2));
      if (!prevClose) prevClose = candles.length >= 2 ? candles[candles.length - 2].close : ltp;

      // 100% REAL 1-DAY TODAY P&L % (NO Artificial Guards or Overrides!)
      const todayPlPct = Number((((ltp - prevClose) / prevClose) * 100).toFixed(2));

      // Exact CALENDAR DAYS calculation (including Sundays, Mondays, and holidays)
      const p1m = getCloseForCalendarDaysAgo(candles, 30);   // 30 Calendar Days
      const p3m = getCloseForCalendarDaysAgo(candles, 90);   // 90 Calendar Days
      const p6m = getCloseForCalendarDaysAgo(candles, 180);  // 180 Calendar Days
      const p1y = getCloseForCalendarDaysAgo(candles, 365);  // 365 Calendar Days

      const tfMap = {
        '1M': Number((((ltp - p1m) / p1m) * 100).toFixed(2)),
        '3M': Number((((ltp - p3m) / p3m) * 100).toFixed(2)),
        '6M': Number((((ltp - p6m) / p6m) * 100).toFixed(2)),
        '1Y': Number((((ltp - p1y) / p1y) * 100).toFixed(2))
      };

      db.transaction(() => {
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

          updateScoreReturn.run(todayPlPct, retVal, newScore, isin, tf);
        }
      })();

      console.log(`[Live Price Sync] [${usedSource}] ${sym}: LTP ₹${ltp.toFixed(2)} | Today ${todayPlPct > 0 ? '+' : ''}${todayPlPct}% | 1M(30d) ${tfMap['1M']}% | 3M(90d) ${tfMap['3M']}% | 6M(180d) ${tfMap['6M']}% | 1Y(365d) ${tfMap['1Y']}%`);
      successCount++;
    }
  }

  console.log(`[Live Price Sync] Successfully updated ${successCount} symbols with exact 1-Day Today P&L % and Calendar Day Returns.`);
}

// Run if called directly
if (require.main === module) {
  syncLiveNsePriceReturns();
}

module.exports = { syncLiveNsePriceReturns };
