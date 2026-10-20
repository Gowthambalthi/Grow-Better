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
let _angelSessionAt = 0;
let _instrumentMap = null;   // symbol -> token
let _instrumentMapAt = 0;
// Angel REST circuit breaker (see fetchAngelQuotes)
const _angelBreaker = { fails: 0, openUntil: 0, rateLimited: false, lastReason: null };
const RATE_LIMIT_BACKOFF_MS = 90e3;

/**
 * Record an Angel REST failure and decide how to recover.
 * kind:
 *   'rate' — throttled (403/429 + "exceeding access rate", or a 200 body with
 *            errorcode AB1012). The JWT is FINE. This used to fall through to the
 *            branch below, which threw the cached session away, and then the next
 *            call logged in again — and login is Angel's most rate-limited
 *            endpoint, so one throttle turned into a self-arming login storm that
 *            took the whole live layer down (no ticks => no fast BUY path). Back
 *            off hard and KEEP the token.
 *   'auth' — a genuinely rejected token. Count it; at 3 drop the session so the
 *            next attempt after the breaker closes does a fresh login instead of
 *            replaying the same dead JWT for another 3 hours.
 *   'net'  — timeouts / transport errors. Count them (a 5s timeout on every one of
 *            ~700 symbols is minutes of dead time) but never touch the session.
 */
function _angelFail(kind, reason) {
  _angelBreaker.lastReason = reason || null;
  if (kind === 'rate') {
    const wait = Math.max(RATE_LIMIT_BACKOFF_MS, angelAuth.cooldownRemainingMs());
    _angelBreaker.openUntil = Date.now() + wait;
    _angelBreaker.rateLimited = true;
    console.log('[angelQuotes] rate limited — backing off ' + Math.round(wait / 1000) + 's, session KEPT'
      + (reason ? ' (' + reason + ')' : '') + ' — Yahoo carries the load');
    return;
  }
  _angelBreaker.fails++;
  if (_angelBreaker.fails >= 3) {
    _angelBreaker.openUntil = Date.now() + 10 * 60e3;
    _angelBreaker.fails = 0;
    _angelBreaker.rateLimited = false;
    if (kind === 'auth') {
      // A token that 403'd three times is not a session.
      _angelSession = null;
      _angelSessionAt = 0;
    }
    console.log('[angelQuotes] circuit OPEN for 10 min after repeated REST failures (' + kind
      + (reason ? ': ' + reason : '') + ') — Yahoo fallback carries the load');
  }
}

async function _getAngelSession() {
  if (_angelSession && _angelSession.jwtToken && (Date.now() - _angelSessionAt) < 3 * 3600e3) return _angelSession;
  _angelSession = null;
  try {
    // reuse the running broker's session if the server already logged in
    const envCfg = require('../../config/env');
    const session = typeof envCfg.getAngelSession === 'function' ? await envCfg.getAngelSession() : null;
    if (session && session.jwtToken) { _angelSession = session; _angelSessionAt = Date.now(); return _angelSession; }
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
  // CIRCUIT BREAKER. When Angel's REST auth goes bad (403), every single call
  // burned its full 5s timeout before the Yahoo fallback — and a scan fetching
  // ~700 quotes turned that into ~7 minutes of pure timeout tax. The heavy scan
  // then overran the tick and the whole board went stale. After 3 consecutive
  // failures, skip Angel entirely for 10 minutes; Yahoo carries the load and a
  // passing background probe reopens the circuit when Angel recovers.
  // A THROTTLE (not a dead token) backs off for RATE_LIMIT_BACKOFF_MS instead and
  // keeps the session — see _angelFail for why that distinction matters.
  if (_angelBreaker.openUntil > Date.now()) return {};
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
      if (data.status !== true) {
        // Angel answers throttling with HTTP 200 + status:false too, so the body
        // (not the status code) is what classifies this.
        const why = (data && (data.message || data.errorcode)) || 'status:false';
        _angelFail(angelAuth.isRateLimitBody(data) ? 'rate' : 'auth', why);
        break;
      }
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
        quoteCache[sym]._fetchedAt = Date.now();
      }
      _angelBreaker.fails = 0;   // a good batch resets the counter
    } catch (e) {
      // Classify, do not guess from the status code alone: 403 means "too fast"
      // just as often as it means "bad token" here, and the two want opposite
      // recoveries. See _angelFail.
      const status = e && e.response ? e.response.status : null;
      const body = e && e.response ? e.response.data : null;
      const detail = typeof body === 'string' ? body.slice(0, 120)
        : (body && (body.message || body.errorcode)) || '';
      const why = status ? ('HTTP ' + status + (detail ? ' ' + detail : '')) : (e && e.message) || 'unknown';
      if (angelAuth.isRateLimit(e)) _angelFail('rate', why);
      else if (status === 403 || status === 401) _angelFail('auth', why);
      else _angelFail('net', why);
      /* try next batch / fall through to yahoo */
    }
  }
  return out;
}
/**
 * Fetch today's 1-minute series for a symbol (for velocity/momentum).
 * Returns { bars: [{t, c, v}], dayVol, last } or null.
 */
// ONE-MINUTE SERIES CACHE. A 1-minute bar only changes once a minute, so a second
// read inside the same minute cannot return anything new — but the board asks for
// hundreds of these per scan, and the scan-into-scan refresh was doubling Yahoo load
// for nothing (and inviting 429s). Cached per minute, keyed by symbol, with the
// cached object's `lastBarAgeSec` recomputed on read so freshness is never faked.
const seriesCache = new Map();
const SERIES_TTL_MS = 60000;

async function fetchIntradaySeries(symbol) {
  const cleanSym = String(symbol || '').replace(/-EQ$/i, '').trim().toUpperCase();
  const hit = seriesCache.get(cleanSym);
  if (hit && (Date.now() - hit.at) < SERIES_TTL_MS) {
    const age = hit.value && hit.value.lastBarTs
      ? Math.round((Date.now() - hit.value.lastBarTs) / 1000) : null;
    return hit.value ? Object.assign({}, hit.value, { lastBarAgeSec: age, fromCache: true }) : null;
  }
  try {
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
    // SERVER FAILOVER: try query2 first, then query1 — whichever answers.
    // For intraday, a slow/dead server must never mean stale or no data.
    let r = null;
    for (const host of ['query2', 'query1']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${cleanSym}.NS?interval=1m&range=1d`;
        const res = await axios.get(url, { headers: uHeaders, timeout: 3000 });
        if (res.data?.chart?.result?.[0]) { r = res.data.chart.result[0]; break; }
      } catch (_) { /* next server */ }
    }
    if (!r) return null;
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
    // EARLY-SESSION FLOOR. A hard 20-bar minimum made this function return null
    // for EVERY symbol for roughly the first 20 minutes of every session — the
    // new day simply has fewer than 20 one-minute bars so far — which is why the
    // Intraday Signals board came up empty right after the 09:15 open (reported as
    // "intra trade signal is not working"). The short series is returned and
    // MARKED, and each indicator computes what it can and yields null for the
    // windows it cannot yet fill. Yahoo also publishes today's bars before the
    // 20th minute, so refusing them was throwing away live data.
    if (bars.length < 3) return null;
    const shortHistory = bars.length < 20;
    // LIVE-DATA RULE for intraday: expose how old the newest bar is so the
    // engine can refuse to trade on 5-minute-late data.
    const lastBarAgeSec = Math.round((Date.now() - bars[bars.length - 1].t) / 1000);
    const out = { bars, shortHistory, dayVol: bars.reduce((s, b) => s + b.v, 0), last: bars[bars.length - 1].c,
      lastBarAgeSec, _fetchedAt: Date.now(),
      lastBarTs: bars[bars.length - 1].t,
      prevClose: Number(r.meta?.chartPreviousClose || r.meta?.previousClose || 0),
      dayHigh: bars.reduce((m, b) => Math.max(m, b.h ?? b.c), 0),
      dayLow: bars.reduce((m, b) => Math.min(m, b.l ?? b.c), Infinity) };
    seriesCache.set(cleanSym, { at: Date.now(), value: out });
    if (seriesCache.size > 4000) seriesCache.clear();   // bounded: a day of scans
    return out;
  } catch (_) { return null; }
}

module.exports = {
  fetchLiveStockQuote,
  fetchAngelQuotes,
  fetchIntradaySeries
};async function fetchLiveStockQuote(symbol) {
  if (!symbol) return null;
  const cleanSym = symbol.replace(/-EQ$/i, '').trim().toUpperCase();

  // 1. Angel One (real exchange feed, works on Render with creds).
  // STALENESS RULE for intraday: a quote older than 90s is NOT live enough.
  // If Angel fails or returns stale, we fall through to Yahoo rather than
  // serving 5-minute-old prices that would fire late intraday signals.
  let angelQuote = null;
  try {
    const angel = await fetchAngelQuotes([cleanSym]);
    if (angel[cleanSym]) angelQuote = angel[cleanSym];
  } catch (_) {}
  const angelFresh = angelQuote && angelQuote._fetchedAt && (Date.now() - angelQuote._fetchedAt) < 90000;
  if (angelQuote && !angelFresh) {
    angelQuote.source = 'Angel (STALE ' + Math.round((Date.now() - angelQuote._fetchedAt) / 1000) + 's)';
  }


  if (angelQuote) return angelQuote;
  const cached = quoteCache[cleanSym];
  if (cached && cached._fetchedAt && (Date.now() - cached._fetchedAt) < 90000) return cached;
  return null;
}

/**
 * Fetch today's 1-minute series for a symbol (for velocity/momentum).
 * Returns { bars: [{t, c, v}], dayVol, last } or null.
 */
