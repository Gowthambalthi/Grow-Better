/**
 * common/instruments/angelInstruments.js
 *
 * Downloads Angel One's official instrument master (~180k+ entries,
 * updated daily) and builds in-memory lookup maps so orders/live-feed
 * calls can resolve a plain symbol to the symboltoken they require,
 * instead of you hardcoding tokens by hand.
 * Source: https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json
 * (this exact URL is the one Angel One's own docs/forum point developers to)
 */

const axios = require('axios');

const SCRIP_MASTER_URL = 'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

let bySymbol = new Map(); // "EXCH:SYMBOL" -> record   e.g. "NSE:RELIANCE-EQ"
let byToken = new Map();  // "EXCH:token"  -> record
let all = [];
let lastRefreshed = null;
let refreshPromise = null;

const REFRESH_TTL_MS = 6 * 3600e3;   // the master changes ~daily; 6h is generous

async function refresh(force = false) {
  // TTL GUARD. This download is ~25-30s and fetchAngelQuotes called refresh()
  // on EVERY quote batch — so a scan fetching 700 quotes serially re-downloaded
  // the whole scrip master 700 times (measured: a single quote took 26-29s,
  // nearly all of it this download). The heavy scan then ran 25+ minutes and
  // the signals board went stale. Fresh enough is fresh enough: skip the
  // download when the map is younger than the TTL unless forced.
  if (!force && lastRefreshed && (Date.now() - lastRefreshed.getTime()) < REFRESH_TTL_MS) return;
  if (refreshPromise) return refreshPromise; // de-dupe concurrent refreshes

  refreshPromise = (async () => {
    const { data } = await axios.get(SCRIP_MASTER_URL, { timeout: 30000 });
    const nextBySymbol = new Map();
    const nextByToken = new Map();
    const filteredAll = [];

    for (const rec of data) {
      const instType = rec.instrumenttype || '';
      if (instType.includes('OPT')) continue; // Skip options contracts to save 250MB RAM

      nextBySymbol.set(`${rec.exch_seg}:${rec.symbol}`, rec);
      nextByToken.set(`${rec.exch_seg}:${rec.token}`, rec);
      filteredAll.push(rec);
    }

    bySymbol = nextBySymbol;
    byToken = nextByToken;
    all = filteredAll;
    lastRefreshed = new Date();
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function ensureLoaded() {
  if (!lastRefreshed) throw new Error('Angel instrument master not loaded yet — call refresh() first (done once at server startup).');
}

/** Exact lookup. `symbol` must match Angel's own format, e.g. "RELIANCE-EQ" for cash equity. */
function findBySymbol(exchSeg, symbol) {
  ensureLoaded();
  return bySymbol.get(`${exchSeg}:${symbol}`) || null;
}

function findByToken(exchSeg, token) {
  ensureLoaded();
  return byToken.get(`${exchSeg}:${String(token)}`) || null;
}

function findEquity(symbol, exchSeg = 'NSE') {
  if (!symbol) return null;
  ensureLoaded();
  const clean = symbol.toUpperCase().replace(/-EQ$/, '').trim();
  
  // 1. Try exact symbol with -EQ in requested exchange
  let match = findBySymbol(exchSeg, `${clean}-EQ`) || findBySymbol(exchSeg, clean);
  if (match) return match;

  // 2. Try alternate exchange (NSE <-> BSE)
  const altExch = exchSeg === 'NSE' ? 'BSE' : 'NSE';
  match = findBySymbol(altExch, `${clean}-EQ`) || findBySymbol(altExch, clean);
  if (match) return match;

  // 3. Fallback search by instrument name
  for (const rec of all) {
    if ((rec.exch_seg === 'NSE' || rec.exch_seg === 'BSE') && rec.name && rec.name.toUpperCase() === clean) {
      return rec;
    }
  }
  return null;
}

/** Case-insensitive substring search across name + symbol, capped at `limit`. */
function search(query, { exchSeg, limit = 20 } = {}) {
  ensureLoaded();
  const q = query.toUpperCase();
  const results = [];
  for (const rec of all) {
    if (exchSeg && rec.exch_seg !== exchSeg) continue;
    if (rec.symbol.includes(q) || (rec.name && rec.name.includes(q))) {
      results.push(rec);
      if (results.length >= limit) break;
    }
  }
  return results;
}

/**
 * equitySymbols(exchSeg, opts) → EVERY cash-equity scrip in the broker's master, as {symbol, token, series}.
 *
 * THE COMPLAINT THIS ANSWERS (user, 2026-09-29): "i want all total market". The board's universe was a
 * 2,934-line FILE (`data/nse_universe_3000.txt`) that nothing regenerated — so the market could list a new
 * name and the board would never see it, and anything the file missed was invisible by construction. The
 * scrip master is downloaded every 6 hours and already holds every tradeable symbol; this is the one place
 * that can enumerate it.
 *
 * SERIES: `-EQ` is the normal rolling-settlement series and `-BE` is trade-for-trade (illiquid, wide
 * spreads, no intraday leverage). Both are real tradeable NSE scrips, so both are returned — the board's
 * own liquidity gates decide what is worth a trade, not the universe builder. Pass
 * `{ series: ['EQ'] }` to hold it to the main series only.
 */
function equitySymbols(exchSeg = 'NSE', opts = {}) {
  ensureLoaded();
  const want = (opts.series && opts.series.length) ? opts.series.map((s) => String(s).toUpperCase()) : ['EQ', 'BE'];
  const out = [];
  for (const rec of all) {
    if (!rec || rec.exch_seg !== exchSeg) continue;
    const sym = String(rec.symbol || '');
    const m = /-([A-Z]+)$/.exec(sym);
    if (!m || want.indexOf(m[1]) < 0) continue;
    out.push({ symbol: sym.replace(/-[A-Z]+$/, ''), token: String(rec.token), series: m[1] });
  }
  return out;
}

function status() {
  return { loaded: !!lastRefreshed, lastRefreshed, count: all.length };
}

// ---- Expiry parsing ----
// Angel's scrip master expiry format is "DDMMMYYYY" e.g. "17SEP2021",
// "28OCT2025" — confirmed from Angel One's own SmartAPI forum examples.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function parseExpiry(str) {
  if (!str || str.length < 9) return null;
  const day = parseInt(str.slice(0, 2), 10);
  const mon = MONTHS[str.slice(2, 5).toUpperCase()];
  const year = parseInt(str.slice(5, 9), 10);
  if (Number.isNaN(day) || mon === undefined || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, mon, day));
}

/**
 * Finds the nearest-to-expiry (not yet expired) futures contract for a
 * commodity/index underlying, e.g. findNearestFuture('GOLD', 'MCX') or
 * findNearestFuture('BANKNIFTY', 'NFO').
 * instrumenttype is 'FUTCOM' for MCX commodities, 'FUTIDX' for index futures.
 */
function findNearestFuture(underlyingName, exchSeg, { instrumenttype } = {}) {
  ensureLoaded();
  const name = underlyingName.toUpperCase();
  const now = new Date();
  let best = null;
  let bestExpiry = null;

  for (const rec of all) {
    if (rec.exch_seg !== exchSeg) continue;
    if (instrumenttype && rec.instrumenttype !== instrumenttype) continue;
    if ((rec.name || '').toUpperCase() !== name) continue;
    const expiry = parseExpiry(rec.expiry);
    if (!expiry || expiry < now) continue; // skip expired/unparseable
    if (!bestExpiry || expiry < bestExpiry) {
      bestExpiry = expiry;
      best = rec;
    }
  }
  return best;
}

/**
 * Resolves an index's spot instrument (for LTP, not futures), e.g.
 * findIndex('NIFTY') / findIndex('BANKNIFTY'). Angel's actual index
 * symbols are "Nifty 50" / "Nifty Bank" (not "NIFTY"/"BANKNIFTY"), so
 * this checks a known-alias table first, falling back to a loose
 * name/symbol match for anything else.
 */
const INDEX_ALIASES = {
  NIFTY: 'NIFTY 50',
  NIFTY50: 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  NIFTYBANK: 'NIFTY BANK',
};
function findIndex(name) {
  ensureLoaded();
  const raw = name.toUpperCase().replace(/\s+/g, '');
  const aliased = INDEX_ALIASES[raw];
  const q = (aliased || name).toUpperCase().replace(/\s+/g, '');
  for (const rec of all) {
    if (rec.exch_seg !== 'NSE') continue;
    const recName = (rec.name || '').toUpperCase().replace(/\s+/g, '');
    const recSymbol = (rec.symbol || '').toUpperCase().replace(/\s+/g, '');
    if (recName === q || recSymbol === q) return rec;
  }
  return null;
}

module.exports = { refresh, findBySymbol, findByToken, findEquity, equitySymbols, findNearestFuture, findIndex, search, status };