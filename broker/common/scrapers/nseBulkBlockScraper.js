/**
 * common/scrapers/nseBulkBlockScraper.js
 * Scraper for NSE Bulk and Block Deals API with two-stage session hit & exponential backoff
 */

const https = require('https');
const { tagClientType } = require('../institutional/clientTagger');
const institutionalService = require('../institutional/institutionalService');

const NSE_BASE_URL = 'https://www.nseindia.com';
const BULK_DEALS_API = 'https://www.nseindia.com/api/snapshot-capital-market-bulk-deals';
const BLOCK_DEALS_API = 'https://www.nseindia.com/api/snapshot-capital-market-block-deals';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.nseindia.com/report-detail/display-bulk-and-block-deals',
  'Connection': 'keep-alive'
};

/**
 * Executes an HTTP GET request with cookie jar support and timeout
 */
function fetchUrl(url, headers = {}, cookies = '') {
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...DEFAULT_HEADERS, ...headers };
    if (cookies) reqHeaders['Cookie'] = cookies;

    const req = https.get(url, { headers: reqHeaders, timeout: 10000 }, (res) => {
      const setCookies = res.headers['set-cookie'] || [];
      const newCookies = setCookies.map(c => c.split(';')[0]).join('; ');

      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body, cookies: newCookies });
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }
      });
    });

    req.on('error', err => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request timeout fetching ${url}`));
    });
  });
}

/**
 * Establishes a session with NSE by hitting the main page to obtain valid cookies
 */
async function initializeNseSession() {
  try {
    const res = await fetchUrl(NSE_BASE_URL);
    return res.cookies || '';
  } catch (err) {
    console.warn('[NSE Scraper] Main page session init warning:', err.message);
    return '';
  }
}

/**
 * Fetches JSON from NSE API with 3-tier exponential backoff retries (2s, 5s, 10s)
 */
async function fetchWithBackoff(apiUrl, sessionCookies) {
  const delays = [2000, 5000, 10000];
  let lastErr = null;

  for (let i = 0; i <= delays.length; i++) {
    try {
      // Re-initialize session cookies if retrying
      const cookies = i === 0 ? sessionCookies : await initializeNseSession();
      const res = await fetchUrl(apiUrl, {}, cookies);
      const json = JSON.parse(res.body);
      return json;
    } catch (err) {
      lastErr = err;
      if (i < delays.length) {
        console.warn(`[NSE Scraper Attempt ${i + 1} Failed] ${err.message}. Retrying in ${delays[i] / 1000}s...`);
        await new Promise(r => setTimeout(r, delays[i]));
      }
    }
  }
  throw lastErr;
}

/**
 * Scrapes today's Bulk and Block deals from NSE and ingests tagged records into SQLite
 */
async function scrapeBulkAndBlockDeals(targetDate = null) {
  const todayStr = targetDate || new Date().toISOString().slice(0, 10);
  console.log(`[NSE Scraper] Starting Bulk/Block deal ingestion for ${todayStr}...`);

  let sessionCookies = await initializeNseSession();

  let bulkDeals = [];
  let blockDeals = [];

  try {
    const bulkJson = await fetchWithBackoff(BULK_DEALS_API, sessionCookies);
    bulkDeals = Array.isArray(bulkJson?.data) ? bulkJson.data : (Array.isArray(bulkJson) ? bulkJson : []);
  } catch (err) {
    console.error('[NSE Scraper] Failed to fetch Bulk Deals after retries:', err.message);
  }

  try {
    const blockJson = await fetchWithBackoff(BLOCK_DEALS_API, sessionCookies);
    blockDeals = Array.isArray(blockJson?.data) ? blockJson.data : (Array.isArray(blockJson) ? blockJson : []);
  } catch (err) {
    console.error('[NSE Scraper] Failed to fetch Block Deals after retries:', err.message);
  }

  const allRecords = [];

  const processRecords = (records, dealType) => {
    for (const r of records) {
      const symbol = (r.symbol || r.BD_SYMBOL || r.SYMBOL || '').replace('-EQ', '').toUpperCase();
      if (!symbol) continue;

      const clientName = r.clientName || r.BD_CLIENT_NAME || r.CLIENT_NAME || 'Unknown';
      const buySell = (r.buySell || r.BD_BUY_SELL || r.BUY_SELL || '').toLowerCase().includes('buy') ? 'buy' : 'sell';
      const quantity = Number(r.quantity || r.BD_QTY_TRADED || r.QTY || 0);
      const price = Number(r.price || r.BD_TP_PRICE || r.PRICE || 0);
      const value = (quantity * price) / 10000000; // Value in ₹ Cr

      const clientType = tagClientType(clientName, symbol);

      allRecords.push({
        date: todayStr,
        stock_symbol: symbol,
        client_name: clientName,
        client_type: clientType,
        deal_type: dealType,
        buy_sell: buySell,
        quantity,
        price,
        value: Number(value.toFixed(2))
      });
    }
  };

  processRecords(bulkDeals, 'bulk');
  processRecords(blockDeals, 'block');

  if (allRecords.length > 0) {
    institutionalService.insertBulkBlockDeals(allRecords);
    console.log(`[NSE Scraper Success] Processed and inserted ${allRecords.length} deals for ${todayStr}.`);
  } else {
    console.log(`[NSE Scraper] No bulk/block deals found for ${todayStr}.`);
  }

  return allRecords;
}

module.exports = {
  scrapeBulkAndBlockDeals,
  initializeNseSession
};
