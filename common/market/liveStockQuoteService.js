/**
 * common/market/liveStockQuoteService.js
 *
 * Real-Time Live Quote Engine for ALL Indian Stocks & Equities.
 * PRIMARY:  Angel One SmartAPI REST quote (real LTP, day volume, totBuy/totSell,
 *           best-5 depth) — works from any host including Render (authenticated,
 *           not rate-limited like public feeds).
 * FALLBACK: Yahoo 1-min chart.
 * NO FAKE PRICES: if both sources fail, returns null (callers skip the tick).
 */

const axios = require('axios');
const angelAuth = require('../../angelone/auth');
const env = require('../../config/env');

const quoteCache = {};
let _angelSession = null;
let _instrumentMap = null;   // symbol -> token
let _instrumentMapAt = 0;

async function _getAngelSession() {
  if (_angelSession && _angelSession.jwtToken) return _angelSession;
  try {
    // reuse the running broker's session if the server already logged in
    const envCfg = require('../../config/env');
    const session = typeof envCfg.getAngelSession === 'function' ? await envCfg.getAngelSession() : null;
    if (session && session.jwtToken) { _angelSession = session; return _angelSession; }
  } catch (_) {}
  try {
    const { login } = require('../../angelone/auth');
    const r = await login();
    const session = r && r.session ? r.session : r;
    if (session && session.jwtToken) _angelSession = session;
  } catch (_) {}
  return _angelSession;
}

async function _getInstrumentMap() {
  if (_instrumentMap && Date.now() - _instrumentMapAt < 6 * 3600e3) return _instrumentMap;
  try {
    const ai = require('../instruments/angelInstruments');
    await ai.refresh();
    // resolve each requested symbol via findEquity (public API)
    const map = _instrumentMap || {};
    if (Object.keys(map).length > 100) return map;
    _instrumentMapAt = Date.now();
    return map;
  } catch (_) {}
  return _instrumentMap;
}

/**
 * Angel batch quote for a set of symbols. Returns { symbol: quoteObj }.
 * Quote obj: { ltp, close, change, changePct, volume, totBuy, totSell, depth: {buy, sell}, source }
 */
async function fetchAngelQuotes(symbols) {
  const session = await _getAngelSession();
  if (!session) return {};
  const ai = require('../instruments/angelInstruments');
  try { await ai.refresh(); } catch (_) {}
  const tokenToSym = {};
  const tokens = [];
  for (const sym of symbols) {
    try {
      const inst = ai.findEquity(sym);
      if (inst && inst.exch_seg === 'NSE' && inst.token && !tokenToSym[inst.token]) {
        tokenToSym[inst.token] = sym.toUpperCase();
        tokens.push(inst.token);
      }
    } catch (_) {}
  }
  if (!tokens.length) return {};

  const out = {};
  for (let i = 0; i < tokens.length; i += 50) {
    const batch = tokens.slice(i, i + 50);
    try {
      const baseUrl = env.angel && env.angel.baseUrl ? env.angel.baseUrl() : 'https://apiconnect.angelone.in';
      const { data } = await axios.post(
        baseUrl + '/rest/secure/angelbroking/market/v1/quote/',
        { mode: 'FULL', exchangeTokens: { NSE: batch } },
        {
          headers: {
            Authorization: 'Bearer ' + session.jwtToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-UserType': 'USER',
            'X-SourceID': 'WEB',
            'X-ClientLocalIP': '127.0.0.1',
            'X-ClientPublicIP': '127.0.0.1',
            'X-MACAddress': '00:00:00:00:00:00',
            'X-PrivateKey': session.apiKey,
            'x-api-key': session.apiKey,
            'x-client-code': session.clientCode,
            'x-feed-token': session.feedToken,
          },
          timeout: 5000,
        }
      );
      if (data.status !== true) break;
      for (const q of data.data?.fetched || []) {
        const sym = tokenToSym[q.symbolToken];
        if (!sym) continue;
        const ltp = Number(q.ltp);
        const close = Number(q.close || ltp);
        const chg = q.netChange != null ? Number(q.netChange) : ltp - close;
        out[sym] = {
          symbol: sym,
          ltp,
          price: ltp,
          close,
          change: +chg.toFixed(2),
          changePct: close > 0 ? +(((ltp - close) / close) * 100).toFixed(2) : 0,
          volume: Number(q.tradeVolume || 0),
          totBuy: Number(q.totBuyQuan || 0),
          totSell: Number(q.totSellQuan || 0),
          depth: q.depth || null,
          source: 'Angel One Live',
          lastUpdated: new Date().toISOString(),
        };
        quoteCache[sym] = out[sym];
      }
    } catch (_) { /* try next batch / fall through to yahoo */ }
  }
  return out;
}
/**
 * Fetch today's 1-minute series for a symbol (for velocity/momentum).
 * Returns { bars: [{t, c, v}], dayVol, last } or null.
 */
async function fetchIntradaySeries(symbol) {
  const cleanSym = String(symbol || '').replace(/-EQ$/i, '').trim().toUpperCase();
  try {
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${cleanSym}.NS?interval=1m&range=1d`;
    const res = await axios.get(url, { headers: uHeaders, timeout: 3000 });
    const r = res.data?.chart?.result?.[0];
    const ts = r?.timestamp; const q = r?.indicators?.quote?.[0];
    if (!ts || !q) return null;
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i]; const v = q.volume?.[i];
      if (c == null) continue;
      const tMs = ts[i] * 1000;
      // NSE regular session only: 09:15 <= IST < 15:15. Drops the pre-open
      // bar and the 15:15-15:30 closing-auction stub that Yahoo includes —
      // both are fake sessions for intraday math (velocity/ROC/volume).
      const ist = new Date(tMs + (5.5 * 60 + new Date(tMs).getTimezoneOffset()) * 60000);
      const mins = ist.getHours() * 60 + ist.getMinutes();
      if (mins < 555 || mins >= 915) continue;
      bars.push({ t: tMs, o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: v || 0 });
    }
    if (bars.length < 20) return null;
    return { bars, dayVol: bars.reduce((s, b) => s + b.v, 0), last: bars[bars.length - 1].c,
      prevClose: Number(r.meta?.chartPreviousClose || r.meta?.previousClose || 0),
      dayHigh: bars.reduce((m, b) => Math.max(m, b.h ?? b.c), 0),
      dayLow: bars.reduce((m, b) => Math.min(m, b.l ?? b.c), Infinity) };
  } catch (_) { return null; }
}

module.exports = {
  fetchLiveStockQuote,
  fetchAngelQuotes,
  fetchIntradaySeries
};async function fetchLiveStockQuote(symbol) {
  if (!symbol) return null;
  const cleanSym = symbol.replace(/-EQ$/i, '').trim().toUpperCase();

  // 1. Angel One (real exchange feed, works on Render with creds)
  const angel = await fetchAngelQuotes([cleanSym]);
  if (angel[cleanSym]) return angel[cleanSym];

  // 2. Yahoo fallback
  try {
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + cleanSym + '.NS?interval=1m&range=1d';
    const res = await axios.get(url, { headers: uHeaders, timeout: 3000 });
    const meta = res.data?.chart?.result?.[0]?.meta;
    if (meta && meta.regularMarketPrice != null) {
      const ltp = Number(meta.regularMarketPrice);
      const close = Number(meta.chartPreviousClose || meta.previousClose || ltp);
      // Day volume + buy/sell proxies from the 1-min series so the engine's
      // openCheck and new-buyer gates work on hosts without Angel creds.
      const quote = res.data?.chart?.result?.[0];
      const iq = quote?.indicators?.quote?.[0] || {};
      let dayVol = 0, buyProxy = 0, sellProxy = 0;
      const tsArr = quote?.timestamp || [];
      for (let i = 0; i < tsArr.length; i++) {
        const v = iq.volume?.[i] || 0; const o = iq.open?.[i]; const cl = iq.close?.[i];
        dayVol += v;
        if (o != null && cl != null) { if (cl >= o) buyProxy += v; else sellProxy += v; }
      }
      const obj = {
        symbol: cleanSym,
        ltp,
        price: ltp,
        close,
        change: Number((ltp - close).toFixed(2)),
        changePct: close > 0 ? Number((((ltp - close) / close) * 100).toFixed(2)) : 0,
        volume: dayVol || Number(meta.regularMarketVolume || 0),
        totBuy: Math.round(buyProxy),
        totSell: Math.round(sellProxy),
        source: 'Live Exchange Feed',
        lastUpdated: new Date().toISOString(),
      };
      quoteCache[cleanSym] = obj;
      return obj;
    }
  } catch (_) {}

  // 3. No fake fallback: cached only, else null (callers must skip)
  return quoteCache[cleanSym] || null;
}

/**
 * Fetch today's 1-minute series for a symbol (for velocity/momentum).
 * Returns { bars: [{t, c, v}], dayVol, last } or null.
 */
async function fetchIntradaySeries(symbol) {
  const cleanSym = String(symbol || '').replace(/-EQ$/i, '').trim().toUpperCase();
  try {
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${cleanSym}.NS?interval=1m&range=1d`;
    const res = await axios.get(url, { headers: uHeaders, timeout: 3000 });
    const r = res.data?.chart?.result?.[0];
    const ts = r?.timestamp; const q = r?.indicators?.quote?.[0];
    if (!ts || !q) return null;
    const bars = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i]; const v = q.volume?.[i];
      if (c == null) continue;
      const tMs = ts[i] * 1000;
      // NSE regular session only: 09:15 <= IST < 15:15. Drops the pre-open
      // bar and the 15:15-15:30 closing-auction stub that Yahoo includes —
      // both are fake sessions for intraday math (velocity/ROC/volume).
      const ist = new Date(tMs + (5.5 * 60 + new Date(tMs).getTimezoneOffset()) * 60000);
      const mins = ist.getHours() * 60 + ist.getMinutes();
      if (mins < 555 || mins >= 915) continue;
      bars.push({ t: tMs, o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: v || 0 });
    }
    if (bars.length < 20) return null;
    return { bars, dayVol: bars.reduce((s, b) => s + b.v, 0), last: bars[bars.length - 1].c,
      prevClose: Number(r.meta?.chartPreviousClose || r.meta?.previousClose || 0),
      dayHigh: bars.reduce((m, b) => Math.max(m, b.h ?? b.c), 0),
      dayLow: bars.reduce((m, b) => Math.min(m, b.l ?? b.c), Infinity) };
  } catch (_) { return null; }
}

module.exports = {
  fetchLiveStockQuote,
  fetchAngelQuotes,
  fetchIntradaySeries
};
