/**
 * common/instruments/instrumentService.js
 *
 * Single entry point for instrument lookups across both brokers.
 * Load once at server startup: await instrumentService.refreshAll()
 */

const angel = require('./angelInstruments');
const groww = require('./growwInstruments');

async function refreshAll() {
  const results = await Promise.allSettled([angel.refresh(), groww.refresh()]);
  const failures = results
    .map((r, i) => ({ broker: i === 0 ? 'angel' : 'groww', r }))
    .filter((x) => x.r.status === 'rejected');
  if (failures.length) {
    for (const f of failures) {
      console.error(`[instrumentService] ${f.broker} instrument refresh failed:`, f.r.reason.message);
    }
  }
  return status();
}

function status() {
  return { angel: angel.status(), groww: groww.status() };
}

/**
 * Resolves a plain equity symbol (e.g. "RELIANCE") to both brokers'
 * broker-specific identifiers in one call, for wiring into an order.
 */
function resolveEquity(symbol, { exchange = 'NSE' } = {}) {
  const angelRec = angel.findEquity(symbol, exchange);
  const growwRec = groww.findEquity(symbol, exchange);
  return {
    symbol: symbol.toUpperCase(),
    angel: angelRec ? { symboltoken: angelRec.token, tradingsymbol: angelRec.symbol, lotsize: angelRec.lotsize } : null,
    groww: growwRec ? { tradingSymbol: growwRec.trading_symbol, exchangeToken: growwRec.exchange_token, lotSize: growwRec.lot_size } : null,
  };
}

function search(query, opts = {}) {
  return {
    angel: angel.search(query, { exchSeg: opts.exchange, limit: opts.limit }),
    groww: groww.search(query, { exchange: opts.exchange, segment: opts.segment, limit: opts.limit }),
  };
}

// Known underlyings so the caller can just say "NIFTY"/"GOLD" without
// knowing which exchange/segment each broker files it under.
const WATCH_KINDS = {
  NIFTY: { kind: 'index', angelExch: 'NSE', growwExch: 'NSE' },
  BANKNIFTY: { kind: 'index', angelExch: 'NSE', growwExch: 'NSE' },
  GOLD: { kind: 'mcxFuture', angelExch: 'MCX', angelInstrumenttype: 'FUTCOM', growwExch: 'MCX', growwSegment: 'COMMODITY' },
  SILVER: { kind: 'mcxFuture', angelExch: 'MCX', angelInstrumenttype: 'FUTCOM', growwExch: 'MCX', growwSegment: 'COMMODITY' },
};

/**
 * Resolves any of NIFTY, BANKNIFTY, GOLD, SILVER (or a plain equity
 * symbol as a fallback) to both brokers' live-feed identifiers in one
 * call. For GOLD/SILVER this returns the nearest-to-expiry MCX contract,
 * not the metal itself — there's no spot instrument to subscribe to.
 */
function resolveWatchItem(name) {
  const key = name.toUpperCase();
  const cfg = WATCH_KINDS[key];

  if (!cfg) {
    // Fall back to a plain equity lookup for anything not in the known list.
    return { symbol: key, kind: 'equity', ...resolveEquity(key) };
  }

  if (cfg.kind === 'index') {
    const angelRec = angel.findIndex(key);
    const growwRec = groww.findIndex(key, cfg.growwExch);
    return {
      symbol: key,
      kind: 'index',
      angel: angelRec ? { symboltoken: angelRec.token, tradingsymbol: angelRec.symbol, exchange: angelRec.exch_seg } : null,
      groww: growwRec ? { tradingSymbol: growwRec.trading_symbol, exchangeToken: growwRec.exchange_token, exchange: growwRec.exchange } : null,
    };
  }

  if (cfg.kind === 'mcxFuture') {
    const angelRec = angel.findNearestFuture(key, cfg.angelExch, { instrumenttype: cfg.angelInstrumenttype });
    const growwRec = groww.findNearestFuture(key, cfg.growwExch, { segment: cfg.growwSegment });
    return {
      symbol: key,
      kind: 'mcxFuture',
      angel: angelRec
        ? { symboltoken: angelRec.token, tradingsymbol: angelRec.symbol, exchange: angelRec.exch_seg, expiry: angelRec.expiry }
        : null,
      groww: growwRec
        ? { tradingSymbol: growwRec.trading_symbol, exchangeToken: growwRec.exchange_token, exchange: growwRec.exchange, expiry: growwRec.expiry_date }
        : null,
    };
  }

  return { symbol: key, kind: 'unknown', angel: null, groww: null };
}

module.exports = { refreshAll, status, resolveEquity, resolveWatchItem, search, angel, groww };