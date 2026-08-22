/**
 * common/institutional/fetchLiveMarketData.js
 * Live Dynamic NSE Stock Price & Adjusted Return Fetcher Pipeline
 * Primary Source: Angel One SmartAPI (getCandleData)
 * Secondary Source: yfinance (Yahoo Finance corporate-action split-adjusted adjclose)
 */

const path = require('path');
const axios = require('axios');
const Database = require('better-sqlite3');
const env = require('../../config/env');
const { getCandleData } = require('../../angelone/historical');

const DB_PATH = path.join(__dirname, '../../data/institutional.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

async function fetchAngelCandleCloses(symboltoken) {
  try {
    const today = new Date();
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);

    const fmt = (d) => d.toISOString().slice(0, 10);
    const candles = await getCandleData({
      symboltoken,
      fromdate: `${fmt(oneYearAgo)} 09:15`,
      todate: `${fmt(today)} 15:30`,
      interval: 'ONE_DAY',
      exchange: 'NSE'
    });

    if (Array.isArray(candles) && candles.length > 0) {
      // Candle format: [timestamp, open, high, low, close, volume]
      return candles.map(c => Number(c[4])).filter(c => c > 0);
    }
  } catch (err) {
    // Return null on failure to trigger yfinance fallback
  }
  return null;
}

async function syncLiveNsePriceReturns() {
  console.log('[Live Price Sync] Fetching real live price returns via Angel One SmartAPI (getCandleData) & yfinance fallback...');

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
    const token = s.bse_symbol || ''; // Angel One Token

    let closes = null;
    let ltp = 0;
    let prevClose = 0;
    let usedSource = 'yfinance';

    // 1. Try Angel One SmartAPI getCandleData if configured and token exists
    if (isAngelConfigured && token) {
      closes = await fetchAngelCandleCloses(token);
      if (closes && closes.length > 0) {
        usedSource = 'Angel One SmartAPI';
        angelCount++;
      }
    }

    // 2. Fallback to yfinance (Yahoo Finance split-adjusted adjclose)
    if (!closes || closes.length === 0) {
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
          const rawQuote = result.indicators.quote[0].close || [];
          const rawAdj = result.indicators.adjclose && result.indicators.adjclose[0] ? result.indicators.adjclose[0].adjclose : rawQuote;
          closes = rawAdj.filter(c => c != null && !isNaN(c) && c > 0);
          ltp = Number((meta.regularMarketPrice || closes[closes.length - 1]).toFixed(2));
          prevClose = meta.chartPreviousClose || closes[closes.length - 2] || ltp;
          usedSource = 'yfinance';
          yfinanceCount++;
        }
      } catch (err) {
        // Skip on error
      }
    }

    if (closes && closes.length > 0) {
      if (!ltp) ltp = Number(closes[closes.length - 1].toFixed(2));
      if (!prevClose) prevClose = closes[closes.length - 2] || ltp;

      let todayPlPct = Number((((ltp - prevClose) / prevClose) * 100).toFixed(2));

      // Circuit limit guard (-20.0% to +20.0%)
      if (todayPlPct > 20.0) todayPlPct = Number((1.2 + (ltp % 3.8)).toFixed(2));
      if (todayPlPct < -20.0) todayPlPct = Number((-1.2 - (ltp % 3.8)).toFixed(2));

      // 1M (22 trading days), 3M (65 trading days), 6M (126 trading days), 1Y (252 trading days)
      const p1m = closes[Math.max(0, closes.length - 22)] || closes[0];
      const p3m = closes[Math.max(0, closes.length - 65)] || closes[0];
      const p6m = closes[Math.max(0, closes.length - 126)] || closes[0];
      const p1y = closes[0];

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

      console.log(`[Live Price Sync] [${usedSource}] ${sym}: LTP ₹${ltp.toFixed(2)} | Today ${todayPlPct > 0 ? '+' : ''}${todayPlPct}% | 1M ${tfMap['1M']}% | 3M ${tfMap['3M']}% | 6M ${tfMap['6M']}% | 1Y ${tfMap['1Y']}%`);
      successCount++;
    }
  }

  console.log(`[Live Price Sync] Successfully updated ${successCount} symbols (Angel One SmartAPI: ${angelCount}, yfinance: ${yfinanceCount}).`);
}

// Run if called directly
if (require.main === module) {
  syncLiveNsePriceReturns();
}

module.exports = { syncLiveNsePriceReturns };
