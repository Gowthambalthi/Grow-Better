/**
 * common/institutional/fetchLiveMarketData.js
 * Fast Parallel Batch Market Sync Engine for ALL 2,291 NSE Equities
 * Updates symbol_master (ltp) and stock_weightage_score (today_pl_pct, pct_increase_holding, weightage_score)
 * using real corporate-action split-adjusted market prices (adjclose) from live APIs.
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

async function fetchYahooSymbolData(sym) {
  try {
    const yahooSym = `${sym}.NS`;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1y`;
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

      if (candles.length > 0) {
        const ltp = Number((meta.regularMarketPrice || candles[candles.length - 1].close).toFixed(2));
        const prevClose = meta.chartPreviousClose || (candles.length >= 2 ? candles[candles.length - 2].close : ltp);
        return { candles, ltp, prevClose };
      }
    }
  } catch (err) {
    // Return null on failure
  }
  return null;
}

async function syncAllEquitiesInParallel() {
  console.log('[Live Market Pipeline] Starting FAST BATCH SYNC for ALL 2,291 NSE Equities...');

  const symbols = db.prepare('SELECT isin, nse_symbol, bse_symbol FROM symbol_master').all();
  if (symbols.length === 0) {
    console.log('[Live Market Pipeline] No symbols found in symbol_master.');
    return;
  }

  const updateSymLtp = db.prepare('UPDATE symbol_master SET ltp = ? WHERE isin = ?');
  const getExistingScore = db.prepare('SELECT net_buyers, net_sellers, net_flow_cr FROM stock_weightage_score WHERE isin = ? AND UPPER(timeframe) = ?');
  const updateScoreReturn = db.prepare(`
    UPDATE stock_weightage_score 
    SET today_pl_pct = ?, pct_increase_holding = ?, weightage_score = ? 
    WHERE isin = ? AND UPPER(timeframe) = ?
  `);

  const BATCH_SIZE = 40;
  let totalSuccess = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    
    const results = await Promise.all(
      batch.map(async (s) => {
        const res = await fetchYahooSymbolData(s.nse_symbol);
        return { item: s, data: res };
      })
    );

    db.transaction(() => {
      for (const { item, data } of results) {
        if (!data || !data.candles || data.candles.length === 0) continue;
        const isin = item.isin;
        const sym = item.nse_symbol;
        const { candles, ltp, prevClose } = data;

        const todayPlPct = Number((((ltp - prevClose) / prevClose) * 100).toFixed(2));

        const p1m = getCloseForCalendarDaysAgo(candles, 30);
        const p3m = getCloseForCalendarDaysAgo(candles, 90);
        const p6m = getCloseForCalendarDaysAgo(candles, 180);
        const p1y = getCloseForCalendarDaysAgo(candles, 365);

        const tfMap = {
          '1M': Number((((ltp - p1m) / p1m) * 100).toFixed(2)),
          '3M': Number((((ltp - p3m) / p3m) * 100).toFixed(2)),
          '6M': Number((((ltp - p6m) / p6m) * 100).toFixed(2)),
          '1Y': Number((((ltp - p1y) / p1y) * 100).toFixed(2))
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

          updateScoreReturn.run(todayPlPct, retVal, newScore, isin, tf);
        }

        totalSuccess++;
      }
    })();

    console.log(`[Live Market Pipeline] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(symbols.length / BATCH_SIZE)} complete (${totalSuccess}/${symbols.length} synced).`);
  }

  console.log(`[Live Market Pipeline] BATCH SYNC FINISHED! Updated ${totalSuccess} out of ${symbols.length} official equities with 100% real live market data.`);
}

if (require.main === module) {
  syncAllEquitiesInParallel();
}

module.exports = { syncLiveNsePriceReturns: syncAllEquitiesInParallel };
