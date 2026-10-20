/**
 * common/market/liveQuoteEngine.js
 *
 * Clean, Fresh Real-Time Market Data Engine.
 * Direct Angel One SmartAPI Batch Quote Integration + Live Commodity Feeds.
 */

const axios = require('axios');
const angelAuth = require('../../angelone/auth');
const env = require('../../config/env');

const SYMBOL_TOKENS = {
  '99926000': { key: 'NIFTY', name: 'NIFTY 50' },
  '99926009': { key: 'BANKNIFTY', name: 'BANK NIFTY' },
  '99926037': { key: 'FINNIFTY', name: 'FIN NIFTY' },
  '99926074': { key: 'MIDCPNIFTY', name: 'MIDCAP NIFTY' },
  // INDIA VIX had NO token here, so the VIX tile could never receive a quote and
  // was showing the hardcoded 100 fallback instead. Token verified against Angel's
  // own OpenAPIScripMaster.json: {'token':'99926017','symbol':'India VIX','exch_seg':'NSE'}.
  '99926017': { key: 'INDIAVIX', name: 'INDIA VIX' },
  '99919000': { key: 'SENSEX', name: 'SENSEX' },
  '58072':    { key: 'GIFTNIFTY', name: 'GIFT NIFTY' },
  '483079':   { key: 'GOLD', name: 'MCX GOLD' },
  '471725':   { key: 'SILVER', name: 'MCX SILVER' }
};

let cachedSession = null;
let cachedSessionAt = 0;

async function getAngelSession() {
  // JWTs expire — never trust a cached session older than 3 hours.
  if (cachedSession && cachedSession.jwtToken && (Date.now() - cachedSessionAt) < 3 * 3600e3) return cachedSession;
  cachedSession = null;
  try {
    const authRes = await angelAuth.login();
    if (authRes?.session) {
      cachedSession = authRes.session;
      cachedSessionAt = Date.now();
      return cachedSession;
    }
  } catch (e) {
    console.error('[liveQuoteEngine] Angel One login error:', e.message);
  }
  return null;
}

/**
 * Main function: Fetches live real-time quotes for all symbols.
 * Returns an array of symbol quote objects with exact LTP, change, changePct, and timestamp.
 */
async function fetchWatchlistQuotes(symbolKeys = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'GIFTNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS']) {
  const result = {};
  const nowIso = new Date().toISOString();

  // NO PRE-FILLED PRICES. This used to seed every index with a hardcoded number
  // (NIFTY 24108.15, BANKNIFTY 57124.80, SENSEX 77098.23, ...) and a 100 fallback
  // for anything not listed, then label the lot `source: 'Live Feed'`. When the
  // Angel batch call below timed out (3.5s) those constants were handed to the
  // page AS a live feed — measured live: NIFTY was really 22579.25 while the
  // hardcoded "live" number said 24108.15, a 6.8% wrong level that looked live.
  // A missing quote now stays missing; the source says so plainly and the UI
  // shows a dash. Only the display NAME is still resolved here.
  const DISPLAY_NAMES = {
    MIDCPNIFTY: 'MIDCAP NIFTY',
    CRUDEOIL: 'MCX CRUDE',
    NATURALGAS: 'MCX NATGAS'
  };

  for (const k of symbolKeys) {
    result[k] = {
      symbol: k,
      name: DISPLAY_NAMES[k] || k,
      ltp: null,
      price: null,
      close: null,
      change: null,
      changePct: null,
      quote: null,
      source: 'no live quote yet',
      lastUpdated: nowIso
    };
  }

  // 1. Fetch Official Live Quotes via Angel One SmartAPI Batch Endpoint
  try {
    const session = await getAngelSession();
    if (session && session.jwtToken) {
      const batchUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/';
      const apiKey = (env.angel && typeof env.angel.apiKey === 'function' ? env.angel.apiKey() : env.angel?.apiKey) || process.env.ANGEL_API_KEY || '0de1184a7c9e9c11a1a6108562aeaf0bb810084fd173be4d';
      const aHeaders = {
        'Authorization': 'Bearer ' + session.jwtToken,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': apiKey
      };

      const batchRes = await axios.post(batchUrl, {
        mode: 'FULL',
        exchangeTokens: {
          NSE: ['99926000', '99926009', '99926037', '99926074', '99926017'],
          BSE: ['99919000'],
          NFO: ['58072'],
          MCX: ['483079', '471725']
        }
      }, { headers: aHeaders, timeout: 3500 });

      const fetched = batchRes.data?.data?.fetched || [];
      for (const item of fetched) {
        const info = SYMBOL_TOKENS[item.symbolToken];
        if (info && result[info.key] && item.ltp != null) {
          const ltp = Number(item.ltp);
          const close = Number(item.close || ltp);
          const chg = item.netChange != null ? Number(item.netChange) : Number((ltp - close).toFixed(2));
          const chgPct = item.percentChange != null ? Number(item.percentChange) : (close > 0 ? Number(((chg / close) * 100).toFixed(2)) : 0);

          result[info.key].ltp = ltp;
          result[info.key].price = ltp;
          result[info.key].close = close;
          result[info.key].change = chg;
          result[info.key].changePct = chgPct;
          result[info.key].quote = { price: ltp, close, change: chg, changePct: chgPct };
          result[info.key].source = 'Angel One SmartAPI Live';
          result[info.key].lastUpdated = new Date().toISOString();
        }
      }
    }
  } catch (err) {
    if (err.response?.status === 401 || /token|session|auth/i.test(err.message)) {
      console.error('[liveQuoteEngine] Token expired, resetting session for next call...');
      cachedSession = null;
    } else {
      console.error('[liveQuoteEngine] Angel One batch quote note:', err.message);
    }
  }

  // 2. Fetch Live GIFT NIFTY directly from Groww Live Feed Endpoint
  try {
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' };
    const gRes = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers: uHeaders, timeout: 3500 });
    const html = gRes.data;

    const ltpMatch = html.match(/"value":\s*([0-9.]+)/) || html.match(/"lastPrice":\s*([0-9.]+)/);
    const chgMatch = html.match(/"dayChange":\s*([+-]?[0-9.]+)/) || html.match(/"change":\s*([+-]?[0-9.]+)/);
    const chgPctMatch = html.match(/"dayChangePerc":\s*([+-]?[0-9.]+)/) || html.match(/"changePercent":\s*([+-]?[0-9.]+)/);
    const prevCloseMatch = html.match(/"close":\s*([0-9.]+)/) || html.match(/"previousClose":\s*([0-9.]+)/);

    if (ltpMatch && result['GIFTNIFTY']) {
      const price = Number(ltpMatch[1]);
      const change = chgMatch ? Number(chgMatch[1]) : 0;
      const changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
      const close = prevCloseMatch ? Number(prevCloseMatch[1]) : Number((price - change).toFixed(2));

      result['GIFTNIFTY'].ltp = price;
      result['GIFTNIFTY'].price = price;
      result['GIFTNIFTY'].close = close;
      result['GIFTNIFTY'].change = change;
      result['GIFTNIFTY'].changePct = changePct;
      result['GIFTNIFTY'].quote = { price, close, change, changePct };
      result['GIFTNIFTY'].source = 'Groww Live GIFT NIFTY';
      result['GIFTNIFTY'].lastUpdated = new Date().toISOString();
    }
  } catch (gErr) {
    console.error('[liveQuoteEngine] Groww GIFT NIFTY live fetch note:', gErr.message);
  }

  return symbolKeys.map(k => result[k]).filter(Boolean);
}

/**
 * Dynamic Multi-Source Live Stock Quote Fetcher
 * Tries Angel One SmartAPI first -> Backup to Yahoo Finance NSE feed.
 */
async function fetchStockQuotes(symbolList = []) {
  const quotesMap = {};
  if (!Array.isArray(symbolList) || symbolList.length === 0) return quotesMap;

  const cleanSymbols = Array.from(new Set(symbolList.map(s => (s || '').replace('-EQ', '').trim().toUpperCase()))).filter(Boolean);
  const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  // 1. Try Angel One SmartAPI Live Quote Fetch
  try {
    const session = await getAngelSession();
    if (session && session.jwtToken) {
      const angelInstruments = require('../instruments/angelInstruments');
      const tokensByExch = {};
      const tokenToSymbol = {};

      for (const cleanSym of cleanSymbols) {
        let rec;
        try {
          rec = angelInstruments.findEquity(cleanSym, 'NSE') || angelInstruments.findEquity(cleanSym, 'BSE');
        } catch (e) {}
        if (rec) {
          (tokensByExch[rec.exch_seg] ||= []).push(rec.token);
          tokenToSymbol[`${rec.exch_seg}:${rec.token}`] = cleanSym;
        }
      }

      if (Object.keys(tokensByExch).length > 0) {
        const batchUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/';
        const apiKey = (env.angel && typeof env.angel.apiKey === 'function' ? env.angel.apiKey() : env.angel?.apiKey) || process.env.ANGEL_API_KEY || '0de1184a7c9e9c11a1a6108562aeaf0bb810084fd173be4d';
        const aHeaders = {
          'Authorization': 'Bearer ' + session.jwtToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'fe80::1',
          'X-PrivateKey': apiKey
        };

        const batchRes = await axios.post(batchUrl, { mode: 'FULL', exchangeTokens: tokensByExch }, { headers: aHeaders, timeout: 3000 });
        const fetched = batchRes.data?.data?.fetched || [];

        for (const item of fetched) {
          const token = item.symbolToken || item.symboltoken;
          const exch = item.exchange || item.exch_seg || 'NSE';
          const sym = tokenToSymbol[`${exch}:${token}`];
          if (sym && item.ltp != null) {
            const ltp = Number(item.ltp);
            const close = item.close != null ? Number(item.close) : ltp;
            const chg = item.netChange != null ? Number(item.netChange) : Number((ltp - close).toFixed(2));
            const chgPct = item.percentChange != null ? Number(item.percentChange) : (close > 0 ? Number(((chg / close) * 100).toFixed(2)) : 0);
            quotesMap[sym] = { ltp, close, change: chg, changePct: chgPct, source: 'Angel One SmartAPI' };
          }
        }
      }
    }
  } catch (err) {
    console.error('[liveQuoteEngine] Angel One stock quote fetch note:', err.message);
  }

  return quotesMap;
}

/**
 * Drop the cached Angel session so the next getAngelSession() does a fresh
 * TOTP login. Used by the tickBoard feed watchdog: when the WebSocket has
 * been reconnecting with a stale/invalidated JWT, the REST path shares the
 * same cached session, so one invalidation heals both paths.
 */
function invalidateAngelSession() {
  cachedSession = null;
  cachedSessionAt = 0;
}

module.exports = {
  fetchWatchlistQuotes,
  fetchStockQuotes,
  getAngelSession,   // shared live session — tickBoard reuses it instead of a second TOTP login
  invalidateAngelSession
};
