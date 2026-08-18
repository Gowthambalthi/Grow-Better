/**
 * common/instruments/growwInstruments.js
 *
 * Downloads Groww's official instruments CSV and builds in-memory lookup
 * maps. Same purpose as angelInstruments.js — resolve a plain symbol to
 * whatever Groww's trading_symbol/exchange_token actually is.
 * Source: https://growwapi-assets.groww.in/instruments/instrument.csv
 * Columns confirmed from https://groww.in/trade-api/docs/curl/instruments :
 *   exchange, exchange_token, trading_symbol, groww_symbol, name,
 *   instrument_type, segment, series, isin, underlying_symbol,
 *   underlying_exchange_token, expiry_date, strike_price, lot_size,
 *   tick_size, freeze_quantity, is_reserved, buy_allowed, sell_allowed
 */

const axios = require('axios');

const INSTRUMENTS_CSV_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv';

let bySymbol = new Map(); // "EXCHANGE:TRADING_SYMBOL" -> record
let byToken = new Map();  // "EXCHANGE:exchange_token"  -> record
let all = [];
let lastRefreshed = null;
let refreshPromise = null;

/** Minimal quote-aware CSV line splitter — handles the rare comma-in-field case without a dependency. */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    // Filter out options derivatives (PE/CE options & FNO segment)
    if (l.includes(',PE,') || l.includes(',CE,') || l.includes(',FNO,')) continue;
    const values = splitCsvLine(l);
    const rec = {};
    for (let j = 0; j < header.length; j++) rec[header[j]] = values[j];
    records.push(rec);
  }
  return records;
}

async function refresh() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { data } = await axios.get(INSTRUMENTS_CSV_URL, { timeout: 60000, responseType: 'text' });
    const records = parseCsv(data);

    const nextBySymbol = new Map();
    const nextByToken = new Map();
    const filteredRecords = [];

    for (const rec of records) {
      if (!rec.exchange || !rec.trading_symbol) continue;

      const instType = rec.instrument_type || '';
      const isOption = instType.includes('OPT');
      
      // Memory Optimization: Skip derivative options contracts to keep memory under 15MB RAM
      if (isOption && !rec.trading_symbol.includes('NIFTY') && !rec.trading_symbol.includes('BANKNIFTY')) {
        continue;
      }

      nextBySymbol.set(`${rec.exchange}:${rec.trading_symbol}`, rec);
      if (rec.exchange_token) nextByToken.set(`${rec.exchange}:${rec.exchange_token}`, rec);
      filteredRecords.push(rec);
    }

    bySymbol = nextBySymbol;
    byToken = nextByToken;
    all = filteredRecords;
    lastRefreshed = new Date();
  })();

  try {
    await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function ensureLoaded() {
  if (!lastRefreshed) return false;
  return true;
}

function findBySymbol(exchange, tradingSymbol) {
  if (!ensureLoaded()) return null;
  return bySymbol.get(`${exchange}:${tradingSymbol}`) || null;
}

function findByToken(exchange, exchangeToken) {
  if (!ensureLoaded()) return null;
  return byToken.get(`${exchange}:${String(exchangeToken)}`) || null;
}

/** Convenience: cash-equity lookup by plain symbol, e.g. "RELIANCE". */
function findEquity(symbol, exchange = 'NSE') {
  return findBySymbol(exchange, symbol.toUpperCase());
}

function search(query, { exchange, segment, limit = 20 } = {}) {
  if (!ensureLoaded()) return [];
  const q = query.toUpperCase();
  const results = [];
  for (const rec of all) {
    if (exchange && rec.exchange !== exchange) continue;
    if (segment && rec.segment !== segment) continue;
    if ((rec.trading_symbol && rec.trading_symbol.includes(q)) || (rec.name && rec.name.toUpperCase().includes(q))) {
      results.push(rec);
      if (results.length >= limit) break;
    }
  }
  return results;
}

function status() {
  return { loaded: !!lastRefreshed, lastRefreshed, count: all.length };
}

/**
 * Finds the nearest-to-expiry (not yet expired) futures contract for a
 * commodity/index underlying, e.g. findNearestFuture('GOLD', 'MCX') or
 * findNearestFuture('BANKNIFTY', 'NSE'). expiry_date is ISO "YYYY-MM-DD"
 * per Groww's own docs sample data — no custom parsing needed.
 */
function findNearestFuture(underlyingSymbol, exchange, { segment } = {}) {
  if (!ensureLoaded()) return null;
  const name = underlyingSymbol.toUpperCase();
  const now = new Date();
  let best = null;
  let bestExpiry = null;

  for (const rec of all) {
    if (rec.exchange !== exchange) continue;
    if (segment && rec.segment !== segment) continue;
    if ((rec.underlying_symbol || '').toUpperCase() !== name) continue;
    if (!rec.expiry_date) continue;
    const expiry = new Date(`${rec.expiry_date}T00:00:00Z`);
    if (Number.isNaN(expiry.getTime()) || expiry < now) continue;
    if (!bestExpiry || expiry < bestExpiry) {
      bestExpiry = expiry;
      best = rec;
    }
  }
  return best;
}

/** Resolves an index's spot instrument (for LTP), e.g. findIndex('NIFTY'). */
function findIndex(name, exchange = 'NSE') {
  if (!ensureLoaded()) return null;
  const q = name.toUpperCase().replace(/\s+/g, '');
  for (const rec of all) {
    if (rec.exchange !== exchange) continue;
    const symbol = (rec.trading_symbol || '').toUpperCase().replace(/\s+/g, '');
    const growwSymbol = (rec.groww_symbol || '').toUpperCase().replace(/\s+/g, '');
    if (symbol === q || growwSymbol.endsWith(q)) return rec;
  }
  return null;
}

module.exports = { refresh, findBySymbol, findByToken, findEquity, findNearestFuture, findIndex, search, status };