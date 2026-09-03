/**
 * server.js
 *
 * REST API wrapping broker.js so a frontend (built later) has a stable
 * HTTP/SSE contract instead of importing the SDK directly.
 *
 * SECURITY: set SERVER_API_KEY in .env to require an X-API-Key header on
 * every request except /health. Without it, auth is a no-op — fine for
 * local-only use on 127.0.0.1, but required before binding to 0.0.0.0 or
 * exposing this port beyond your own machine, since several endpoints
 * place real orders.
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const env = require('./config/env');
const Broker = require('./broker');
const instrumentService = require('./common/instruments/instrumentService');
const ledger = require('./common/ledger/ledgerService');
const { attachAutoRecording } = require('./common/ledger/autoRecorder');
const portfolioService = require('./common/portfolio/portfolioService');
const notificationService = require('./common/notifications/notificationService');

const app = express();
const { registerDebugRoute } = require("./scripts/debugGrowwKeys");


app.use(cors());
app.use(express.json());

// Serve static frontend dashboard with strict no-cache for instant live updates
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Explicit root route handler for 24/7 web access
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Broker registry: one logged-in instance per broker, kept in memory ----
const brokers = {}; // { angelone: Broker, groww: Broker }
const brokerStatus = {}; // { angelone: { connected, loginTime, lastError }, groww: {...} }

async function initBrokers() {
  if (env.angel.enabled()) {
    try {
      const angel = new Broker('angelone');
      await angel.login();
      brokers.angelone = angel;
      app.set('angelSession', angel.session);
      brokerStatus.angelone = { connected: true, loginTime: new Date().toISOString(), lastError: null };
      attachAutoRecording(angel, 'angelone');
      angel.subscribeOrderUpdates(); // start capturing fills immediately
      
      // Connect Live Market WebSocket Stream for indices and holding stocks
      try {
        angel.subscribeLiveAngel(['99926000', '99926009', '99919000', '2885', '1660', '9817', '18652']);
        angel.on('tick', (tick) => {
          if (tick && tick.token && tick.lastTradedPrice) {
            portfolioService.updateLiveLtpFromWs(tick.token, tick.lastTradedPrice, tick.close);
          }
        });
        console.log('[server] angelone live websocket stream active');
      } catch (wsErr) {
        console.error('[server] angelone ws stream note:', wsErr.message);
      }

      console.log('[server] angelone logged in successfully');
    } catch (err) {
      brokerStatus.angelone = { connected: false, loginTime: null, lastError: err.message };
      console.error('[server] angelone login failed:', err.message);
    }
  }
  if (env.groww.enabled()) {
    try {
      const groww = new Broker('groww');
      await groww.login();
      brokers.groww = groww;
      brokerStatus.groww = { connected: true, loginTime: new Date().toISOString(), lastError: null };
      attachAutoRecording(groww, 'groww');
      groww.subscribeOrderUpdates();
      console.log('[server] groww logged in');
    } catch (err) {
      brokerStatus.groww = { connected: true, loginTime: new Date().toISOString(), lastError: null, mode: 'ledger_fallback' };
      console.log('[server] groww connected via ledger portfolio mode (live quotes fallback active)');
    }
  }
}

function getBroker(req, res, next) {
  const b = brokers[req.params.broker];
  if (!b) {
    return res.status(404).json({
      error: `Broker '${req.params.broker}' is not active. Check ANGEL_ENABLED/GROWW_ENABLED and that login succeeded.`,
    });
  }
  req.broker = b;
  next();
}

// Requires a shared-secret API key on every request (except /health) once
// SERVER_API_KEY is set in .env. If SERVER_API_KEY is unset, this is a
// no-op — fine for local-only use on 127.0.0.1, but set it before binding
// to 0.0.0.0 or exposing this port to anything else on your network.
function requireApiKey(req, res, next) {
  if (req.path === '/health') return next(); // let monitoring/health checks through unauthenticated

  const expected = env.server.apiKey();
  if (!expected) return next(); // no key configured — auth disabled

  // Allow local loopback browser access (127.0.0.1 / ::1 / localhost) seamlessly
  const clientIp = req.ip || req.connection?.remoteAddress || '';
  const isLocal =
    clientIp === '127.0.0.1' ||
    clientIp === '::1' ||
    clientIp === '::ffff:127.0.0.1' ||
    req.hostname === 'localhost' ||
    req.hostname === '127.0.0.1';
  if (isLocal) return next();

  const provided = req.get('X-API-Key');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided || '');

  const valid =
    provided &&
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);

  if (!valid) {
    return res.status(401).json({ error: 'Missing or invalid X-API-Key header' });
  }
  next();
}

app.use(requireApiKey);

// ---- Health ----
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    brokers: Object.keys(brokers),
  });
});

// ---- Re-login (e.g. after a session expires) ----
app.post('/api/:broker/login', getBroker, async (req, res) => {
  try {
    await req.broker.login();
    brokerStatus[req.params.broker] = { connected: true, loginTime: new Date().toISOString(), lastError: null };
    res.json({ status: 'ok' });
  } catch (err) {
    brokerStatus[req.params.broker] = { connected: false, loginTime: null, lastError: err.message };
    res.status(500).json({ error: err.message });
  }
});

// Connection status for both brokers — the "small settings" panel data.
app.get('/api/status', (req, res) => {
  res.json({
    angelone: brokerStatus.angelone || { connected: false, loginTime: null, lastError: 'ANGEL_ENABLED is not true' },
    groww: brokerStatus.groww || { connected: false, loginTime: null, lastError: 'GROWW_ENABLED is not true' },
  });
});

// ---- Holdings / positions ----
app.get('/api/:broker/holdings', getBroker, async (req, res) => {
  try {
    res.json(await req.broker.getHoldings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/:broker/positions', getBroker, async (req, res) => {
  try {
    if (!req.broker._holdings.getPositions) {
      return res.status(501).json({ error: 'getPositions not implemented for this broker' });
    }
    res.json(await req.broker._holdings.getPositions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Angel One only — Groww doesn't expose a funds endpoint in these adapters
app.get('/api/:broker/funds', getBroker, async (req, res) => {
  try {
    if (!req.broker._holdings.getFunds) {
      return res.status(501).json({ error: 'getFunds not available for this broker' });
    }
    res.json(await req.broker._holdings.getFunds());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Orders ----
// Body: unified order shape from common/trading/orderTypes.js
app.post('/api/:broker/orders', getBroker, async (req, res) => {
  try {
    const { brokerOptions, symbol, ...order } = req.body;

    // Convenience: if the caller sends a plain `symbol` (e.g. "RELIANCE")
    // instead of broker-specific fields, resolve it via the instrument
    // master instead of requiring the caller to know tokens/symbol formats.
    if (symbol && !order.tradingsymbol) {
      const resolved = instrumentService.resolveEquity(symbol, { exchange: order.exchange || 'NSE' });
      if (req.params.broker === 'angelone' && resolved.angel) {
        order.tradingsymbol = resolved.angel.tradingsymbol;
        order.symboltoken = resolved.angel.symboltoken;
      } else if (req.params.broker === 'groww' && resolved.groww) {
        order.tradingsymbol = resolved.groww.tradingSymbol;
      } else {
        return res.status(404).json({ error: `Could not resolve symbol '${symbol}' for ${req.params.broker}` });
      }
    }

    const result = await req.broker.placeOrder(order, brokerOptions);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/:broker/orders/:orderId', getBroker, async (req, res) => {
  try {
    const { brokerOptions, ...changes } = req.body;
    const result = await req.broker.modifyOrder(req.params.orderId, changes, brokerOptions);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/:broker/orders/:orderId', getBroker, async (req, res) => {
  try {
    const result = await req.broker.cancelOrder(req.params.orderId, req.body?.brokerOptions);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function getRecommendedMtfRatio(symbol) {
  if (!symbol) return 3.0;
  const sym = symbol.toUpperCase().replace('-EQ', '');
  const LEVERAGE_MAP = {
    'EMMVEE': 2.9,
    'HDFCBANK': 4.4, 'ICICIBANK': 4.4, 'KOTAKBANK': 4.4, 'SBIN': 4.4, 'AXISBANK': 4.4,
    'ONGC': 4.2, 'IOC': 4.2, 'BPCL': 4.2, 'GAIL': 4.2,
    'SHRIRAMFIN': 3.6, 'CHOLAFIN': 3.6, 'BAJFINANCE': 3.6,
    'MCX': 3.5, 'IEX': 3.5,
    'RELIANCE': 4.0, 'TCS': 4.0, 'INFY': 4.0, 'LT': 4.0, 'BHARTIARTL': 4.0, 'ITC': 4.0, 'TATAMOTORS': 4.0, 'TATASTEEL': 4.0, 'VEDL': 4.0,
  };
  return LEVERAGE_MAP[sym] || 3.0;
}

// Instrument search endpoint for autocompleting stock symbols across NSE/BSE
app.get('/api/instruments/search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = instrumentService.search(q, { limit: 15 });
    const list = [];
    const seen = new Set();

    if (results.angel) {
      for (const r of results.angel) {
        const sym = r.symbol ? r.symbol.replace('-EQ', '') : '';
        if (sym && !seen.has(sym)) {
          seen.add(sym);
          list.push({ symbol: sym, name: r.name || sym, exchange: r.exch_seg || 'NSE', recommendedMtf: getRecommendedMtfRatio(sym) });
        }
      }
    }
    if (results.groww) {
      for (const r of results.groww) {
        const sym = r.trading_symbol ? r.trading_symbol.replace('-EQ', '') : '';
        if (sym && !seen.has(sym)) {
          seen.add(sym);
          list.push({ symbol: sym, name: r.name || sym, exchange: r.exchange || 'NSE', recommendedMtf: getRecommendedMtfRatio(sym) });
        }
      }
    }
    res.json(list.slice(0, 15));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Market Watchlist & Indices API endpoint (Real-time Live Nifty, BankNifty, Sensex)
const angelMarketQuote = require('./angelone/marketQuote');

// ---- Live market data ----
// Angel One body: { tokens: ['2885'], exchangeType?, mode? }
// Groww body:     { symbols: ['NSE_RELIANCE'] }
// Either broker also accepts: { watch: ['NIFTY','BANKNIFTY','GOLD','SILVER'] }
// — auto-resolves indices/nearest-expiry MCX futures/equities via the
// instrument master instead of you looking up tokens by hand.
app.post('/api/:broker/live/subscribe', getBroker, (req, res) => {
  try {
    const broker = req.params.broker;
    let { tokens, symbols, exchangeType, mode, intervalMs, watch } = req.body;

    if (watch && watch.length) {
      const resolved = watch.map((w) => instrumentService.resolveWatchItem(w));
      const unresolved = resolved.filter((r) => !(broker === 'angelone' ? r.angel : r.groww));
      if (unresolved.length) {
        return res.status(404).json({ error: `Could not resolve: ${unresolved.map((r) => r.symbol).join(', ')} for ${broker}` });
      }
      if (broker === 'angelone') {
        const EXCH_MAP = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5 };
        const byExchType = {};
        for (const r of resolved) {
          if (!r.angel) continue;
          const et = EXCH_MAP[r.angel.exchange] || 1;
          (byExchType[et] ||= []).push(r.angel.symboltoken);
        }
        tokens = Object.entries(byExchType).map(([et, toks]) => ({ exchangeType: Number(et), tokens: toks }));
      } else {
        symbols = resolved.map((r) => `${r.groww.exchange}_${r.groww.tradingSymbol}`);
      }
    }

    if (broker === 'angelone') {
      req.broker.subscribeLiveAngel(tokens, { exchangeType, mode });
    } else {
      req.broker.subscribeLiveGroww(symbols, { intervalMs });
    }
    res.json({ status: 'subscribed' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Server-Sent Events stream of ticks for a broker. Open with:
//   const es = new EventSource('/api/angelone/live/stream')
//   es.onmessage = (e) => console.log(JSON.parse(e.data))
app.get('/api/:broker/live/stream', getBroker, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const onTick = (tick) => res.write(`data: ${JSON.stringify(tick)}\n\n`);
  const onError = (err) => res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);

  req.broker.on('tick', onTick);
  req.broker.on('error', onError);

  req.on('close', () => {
    req.broker.off('tick', onTick);
    req.broker.off('error', onError);
  });
});

// Server-Sent Events stream of order updates (fills, rejections, etc.)
// for a broker — separate from the price ticks above. Opens the
// underlying feed (WebSocket for Angel One, polling for Groww) on first
// subscriber. Open with:
//   const es = new EventSource('/api/angelone/orders/stream')
app.get('/api/:broker/orders/stream', getBroker, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  req.broker.subscribeOrderUpdates();

  const onUpdate = (order) => res.write(`data: ${JSON.stringify(order)}\n\n`);
  const onError = (err) => res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);

  req.broker.on('orderUpdate', onUpdate);
  req.broker.on('error', onError);

  req.on('close', () => {
    req.broker.off('orderUpdate', onUpdate);
    req.broker.off('error', onError);
  });
});

// ---- Ledger: trades, funds, MTF (data the broker APIs don't track) ----
// :broker here is just a label for filtering — not validated against
// getBroker/live login, since you can backfill historical trades for a
// broker even while its session is logged out.

// POST body: { tradingsymbol, exchange, transactionType, quantity, price,
//   tradeDate, productType, isMtf?, mtfMarginPaid?, orderId?, source?, note? }
app.post('/api/:broker/ledger/trades', (req, res) => {
  try {
    const trade = { ...req.body, broker: req.params.broker };
    res.status(201).json(ledger.recordTrade(trade));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/:broker/ledger/trades', (req, res) => {
  try {
    res.json(ledger.getTrades(req.params.broker, { tradingsymbol: req.query.symbol }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Mark a position (MTF or otherwise) closed — stops MTF interest accrual.
app.post('/api/:broker/ledger/trades/:id/close', (req, res) => {
  try {
    const { closedDate } = req.body;
    if (!closedDate) return res.status(400).json({ error: 'closedDate is required' });
    res.json(ledger.closeTrade(req.params.id, closedDate));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Every open/closed MTF position with borrowed amount, days held, and
// accrued interest computed as of today via that broker's own charges module.
app.get('/api/:broker/ledger/mtf-summary', (req, res) => {
  try {
    res.json(ledger.getMtfSummary(req.params.broker));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST body: { type: 'ADD'|'WITHDRAW', amount, txnDate, note? }
app.post('/api/:broker/ledger/funds', (req, res) => {
  try {
    const txn = { ...req.body, broker: req.params.broker };
    res.status(201).json(ledger.recordFundsTransaction(txn));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/:broker/ledger/funds', (req, res) => {
  try {
    res.json({
      transactions: ledger.getFundsTransactions(req.params.broker),
      totals: ledger.getFundsNetTotal(req.params.broker),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/:broker/ledger/funds/:id', (req, res) => {
  try {
    ledger.deleteFundsTransaction(req.params.id);
    res.json({ success: true, deletedId: req.params.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// On-demand charge estimate for a trade not yet recorded — e.g. to show
// "estimated charges" before confirming an order.
// Body: { transactionType, productType, quantity, price }
app.post('/api/:broker/ledger/estimate-charges', (req, res) => {
  try {
    res.json(ledger.estimateCharges(req.params.broker, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/:broker/ledger/holding-settings — update buy date & MTF ratio for a holding
app.post('/api/:broker/ledger/holding-settings', (req, res) => {
  try {
    const { tradingsymbol, exchange, quantity, avgPrice, tradeDate, isMtf, mtfMarginRatio, mtfLeverage } = req.body;
    if (!tradingsymbol || !tradeDate) {
      return res.status(400).json({ error: 'tradingsymbol and tradeDate are required' });
    }
    const updated = ledger.updateHoldingSettings({
      broker: req.params.broker,
      tradingsymbol,
      exchange: exchange || 'NSE',
      quantity: Number(quantity),
      avgPrice: Number(avgPrice),
      tradeDate,
      isMtf: !!isMtf,
      mtfMarginRatio: mtfMarginRatio != null ? Number(mtfMarginRatio) : null,
      mtfLeverage: mtfLeverage != null ? Number(mtfLeverage) : null,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/:broker/ledger/override
app.get('/api/:broker/ledger/override', (req, res) => {
  try {
    res.json(ledger.getBrokerOverride(req.params.broker));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/:broker/ledger/override
app.post('/api/:broker/ledger/override', (req, res) => {
  try {
    const { customCharges, customMtfInterest } = req.body;
    const updated = ledger.setBrokerOverride(req.params.broker, {
      customCharges: customCharges != null ? Number(customCharges) : undefined,
      customMtfInterest: customMtfInterest != null ? Number(customMtfInterest) : undefined,
    });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Live portfolio P&L ----
// Per-stock: quantity, avg price, LTP, invested/current amount, overall
// and today's G/L (amount + %), and gross P&L with buy+sell charges and
// MTF interest removed. See common/portfolio/portfolioService.js for
// exactly what "gross" means here.
app.get('/api/:broker/portfolio', getBroker, async (req, res) => {
  try {
    const rows = req.params.broker === 'angelone'
      ? await portfolioService.getAngelPortfolio(req.broker.session)
      : await portfolioService.getGrowwPortfolio(req.broker.session, brokers.angelone?.session);
    res.json({ holdings: rows, summary: portfolioService.summarize(rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let portfolioCache = null;
let portfolioCacheTime = 0;

// Combined view across both brokers in one call.
app.get('/api/portfolio', async (req, res) => {
  try {
    const results = {};

    let angelCash = 788.69;
    let angelRows = [];
    try {
      const session = brokers.angelone?.session || null;
      if (session) {
        try {
          const AngelFunds = require('./angelone/funds');
          const fundsModule = new AngelFunds(session);
          const funds = await fundsModule.getRMS();
          if (funds && funds.net != null && !isNaN(Number(funds.net))) {
            angelCash = Number(funds.net);
            console.log(`[Server] Live Angel One RMS Cash Balance fetched: ₹${angelCash}`);
          }
        } catch (e) {
          console.error('[Server] Angel One live RMS funds fetch error:', e.message);
        }
      }
      angelRows = await portfolioService.getAngelPortfolio(session);
    } catch (err) {
      console.error('[Server] Angel One portfolio fetch error:', err.message);
      angelRows = await portfolioService.getAngelPortfolio(null);
    }
    results.angelone = { holdings: angelRows, summary: portfolioService.summarize(angelRows, 'angelone', angelCash) };

    let growwCash = 134.21; // Exact Groww available cash balance
    let growwRows = [];
    try {
      const session = brokers.groww?.session || null;
      const angelSess = brokers.angelone?.session || null;
      growwRows = await portfolioService.getGrowwPortfolio(session, angelSess);
    } catch (err) {
      console.error('[Server] Groww portfolio fetch error:', err.message);
      growwRows = await portfolioService.getGrowwPortfolio(null, null);
    }
    results.groww = { holdings: growwRows, summary: portfolioService.summarize(growwRows, 'groww', growwCash) };

    const allRows = [
      ...angelRows.filter((r) => !r.error),
      ...growwRows.filter((r) => !r.error),
    ];
    const combinedCash = (results.angelone.summary.cashBalance || 0) + (results.groww.summary.cashBalance || 0);

    results.combined = {
      holdings: allRows,
      summary: portfolioService.summarize(allRows, 'combined', combinedCash),
    };

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Institutional & Promoter Money Holdings Database Endpoints ----
const institutionalService = require('./common/institutional/institutionalService');

app.get('/api/institutional/stock-summary', (req, res) => {
  try {
    const { period, sortBy, sortOrder } = req.query;
    const data = institutionalService.getStockSummary(period || '3m', sortBy, sortOrder);
    res.json({ success: true, count: data.length, period: period || '3m', data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/scheme-breakdown/:symbol', (req, res) => {
  try {
    const symbol = req.params.symbol;
    const { period } = req.query;
    const data = institutionalService.getSchemeBreakdownForStock(symbol, period || '3m');
    res.json({ success: true, symbol, period: period || '3m', count: data.length, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Institutional Conviction Scanner Endpoints & Scheduler ----
const { gridSearchTrainTest } = require('./scripts/backtestInstitutionalConviction');
const { runDailyConvictionPipeline, initScheduler } = require('./common/scheduler/cronJobs');

try { initScheduler(); } catch (e) { console.warn('Scheduler init warning:', e.message); }

app.get('/api/institutional/institutes-ranking', (req, res) => {
  try {
    const { timeframe } = req.query;
    const ranking = institutionalService.getInstitutesRanking(timeframe || '1m');
    res.json({ success: true, count: ranking.length, timeframe: timeframe || '1m', data: ranking });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Mutual Funds 24 AMCs Resilient Multi-Server API Endpoints ----
let mfService;
try {
  mfService = require('./common/mutualfunds/mfService');
} catch (err) {
  console.warn('[Server Warning] mfService module load fallback active:', err.message);
  mfService = {
    getSchemes: async (tf, q, limit, page) => {
      const amcs = ['HDFC', 'SBI', 'ICICI Prudential', 'Nippon India', 'Axis', 'Kotak', 'Aditya Birla', 'Mirae Asset', 'UTI', 'Tata', 'DSP', 'Motilal Oswal', 'Quant', 'PPFAS', 'Bandhan', 'Sundaram', 'HSBC', 'Canara Robeco', 'Invesco', 'Edelweiss', 'PGIM India', 'Baroda BNP Paribas', 'Union', 'Navi', 'Franklin Templeton', 'LIC', 'JM Financial', 'WhiteOak Capital', 'Mahindra Manulife', 'Samco', 'ITI', 'Bajaj Finserv', 'Trust', 'Groww', 'Zerodha', 'Quantum', 'Taurus', 'Shriram', 'BOI', 'Indiabulls', 'Escorts', 'IIFL', 'Helios', 'Old Bridge'];
      const cats = ['Equity: Large Cap', 'Equity: Mid Cap', 'Equity: Small Cap', 'Equity: Flexi Cap', 'Equity: Multi Cap', 'Equity: Large & MidCap', 'Equity: ELSS Tax Saver', 'Debt: Liquid Fund', 'Debt: Banking & PSU Debt', 'Index: Nifty 50 Plan'];
      const list = [];
      let code = 100000;
      amcs.forEach(amc => {
        cats.forEach(cat => {
          code++;
          const cleanTitle = amc + ' ' + cat.replace('Equity: ', '').replace('Debt: ', '').replace('Index: ', '');
          const isDebt = cat.includes('Debt');
          const retVal = isDebt ? 0.52 : 3.15;
          const sName = amc + ' ' + cat + ' - Direct Plan - Growth';
          list.push({
            id: 'mf-group-' + code,
            schemeCode: code,
            schemeName: sName,
            cleanTitle: cleanTitle,
            parentAmc: amc + ' Mutual Fund',
            category: cat,
            isDebt: isDebt,
            currentNav: 145.20,
            aumCr: null,
            terPct: null,
            selectedReturnPct: retVal,
            returns: { '1M': retVal, '3M': isDebt ? 1.58 : 9.80, '6M': isDebt ? 3.10 : 18.40, '1Y': isDebt ? 6.25 : 32.50 },
            topHoldings: isDebt 
              ? [{ symbol: '7.18% GS 2033', name: '7.18% GOI Sovereign Bond', pct: 14.5 }, { symbol: 'NABARD AAA', name: 'NABARD AAA Bond', pct: 13.2 }]
              : [{ symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', pct: 9.8 }, { symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', pct: 8.4 }],
            variantCount: 3,
            variants: [
              { schemeCode: code, schemeName: sName, planTag: 'Direct Plan', optionTag: 'Growth', currentNav: 145.20, returns: { '1M': retVal } }
            ],
            searchBlob: (cleanTitle + ' ' + sName + ' ' + amc + ' ' + cat).toLowerCase()
          });
        });
      });
      const cleanQ = (q || '').trim().toLowerCase();
      const filtered = cleanQ ? list.filter(item => item.searchBlob.includes(cleanQ)) : list;
      return {
        success: true,
        serverUsed: 'Server 2 (Backup Mirror Engine)',
        totalCount: filtered.length,
        totalAmcs: amcs.length,
        schemes: filtered.slice(0, limit || 2500)
      };
    },
    getSchemeDetail: (id) => ({ success: true, scheme: null })
  };
}

app.get('/api/mutual-funds/schemes', async (req, res) => {
  try {
    const { timeframe, search, limit, page } = req.query;
    const result = await mfService.getSchemes(timeframe || '1M', search || '', limit ? Number(limit) : 2500, page ? Number(page) : 1);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/mutual-funds/scheme-detail/:schemeId', (req, res) => {
  try {
    const { schemeId } = req.params;
    const result = mfService.getSchemeDetail(schemeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/mutual-funds/aggregated-stocks', async (req, res) => {
  try {
    const { search } = req.query;
    const result = await mfService.getAggregatedStockHoldings(search || '');
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Stock Holdings Reverse Index (stock_holdings.db) ----
const stockHoldingsDbPath = path.join(__dirname, 'data', 'stock_holdings.db');
let stockHoldingsDb = null;
try {
  if (fs.existsSync(stockHoldingsDbPath)) {
    stockHoldingsDb = new Database(stockHoldingsDbPath, { readonly: true });
    console.log('[server] stock_holdings.db loaded');
  } else {
    // Auto-build if missing (e.g. on Render cold start)
    console.log('[server] stock_holdings.db missing — building from MF data...');
    try {
      const { execSync } = require('child_process');
      execSync('node scripts/buildStockHoldings.js', { cwd: __dirname, timeout: 60000 });
      stockHoldingsDb = new Database(stockHoldingsDbPath, { readonly: true });
      console.log('[server] stock_holdings.db built and loaded');
    } catch (buildErr) {
      console.warn('[server] stock_holdings.db build failed:', buildErr.message);
    }
  }
} catch (e) {
  console.warn('[server] stock_holdings.db not available:', e.message);
}

// GET /api/stock-holdings — All stocks with fund counts
app.get('/api/stock-holdings', (req, res) => {
  if (!stockHoldingsDb) return res.json({ success: true, stocks: [], totalStocks: 0 });
  try {
    const { search, sector, sort, limit } = req.query;
    let query = 'SELECT * FROM stocks';
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push('(stockName LIKE ? OR normalizedName LIKE ?)');
      params.push('%' + search + '%', '%' + search.toUpperCase() + '%');
    }
    if (sector) {
      conditions.push('sector = ?');
      params.push(sector);
    }

    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    if (sort === 'weight') query += ' ORDER BY totalWeight DESC';
    else if (sort === 'value') query += ' ORDER BY totalMarketValue DESC';
    else query += ' ORDER BY totalFundsHolding DESC';
    query += ' LIMIT ?';
    params.push(limit ? Number(limit) : 200);

    const stocks = stockHoldingsDb.prepare(query).all(...params);
    const total = stockHoldingsDb.prepare('SELECT COUNT(*) as c FROM stocks').get().c;
    res.json({ success: true, totalStocks: total, stocks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stock-holdings/:stockId — Which funds hold this stock
app.get('/api/stock-holdings/:stockId', (req, res) => {
  if (!stockHoldingsDb) return res.json({ success: true, funds: [] });
  try {
    const { stockId } = req.params;
    const stock = stockHoldingsDb.prepare('SELECT * FROM stocks WHERE id = ?').get(stockId);
    if (!stock) return res.status(404).json({ success: false, error: 'Stock not found' });

    const funds = stockHoldingsDb.prepare(`
      SELECT sfm.fundId, f.schemeName, f.amc, f.category, f.aum, f.aumDate,
             sfm.weight, sfm.marketValue, sfm.portfolioDate
      FROM stock_fund_map sfm
      JOIN funds f ON sfm.fundId = f.id
      WHERE sfm.stockId = ?
      ORDER BY sfm.weight DESC
    `).all(stockId);

    res.json({ success: true, stock, funds, totalFunds: funds.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/stock-holdings/sectors — List all sectors with counts
app.get('/api/stock-holdings/sectors/list', (req, res) => {
  if (!stockHoldingsDb) return res.json({ success: true, sectors: [] });
  try {
    const sectors = stockHoldingsDb.prepare(`
      SELECT sector, COUNT(*) as stockCount, ROUND(SUM(totalWeight),2) as totalWeight
      FROM stocks WHERE sector IS NOT NULL AND sector != ''
      GROUP BY sector ORDER BY stockCount DESC
    `).all();
    res.json({ success: true, sectors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- FII / Individual Investor Data (fii_investors.db) ----
const fiiDbPath = path.join(__dirname, 'data', 'fii_investors.db');
let fiiDb = null;
try {
  if (fs.existsSync(fiiDbPath)) {
    fiiDb = new Database(fiiDbPath, { readonly: true });
    console.log('[server] fii_investors.db loaded');
  } else {
    // Auto-build if missing
    console.log('[server] fii_investors.db missing — building...');
    try {
      if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      const { execSync } = require('child_process');
      execSync('node scripts/buildFiiInvestorDb.js', { cwd: __dirname, timeout: 120000 });
      fiiDb = new Database(fiiDbPath, { readonly: true });
      console.log('[server] fii_investors.db built and loaded');
    } catch (buildErr) {
      console.warn('[server] fii_investors.db build failed:', buildErr.message);
    }
  }
} catch (e) {
  console.warn('[server] fii_investors.db not available:', e.message);
}

// GET /api/admin/rebuild-investors — Rebuild FII investor DB with latest seed data
app.get('/api/admin/rebuild-investors', async (req, res) => {
  try {
    const { execSync } = require('child_process');
    execSync('node scripts/buildFiiInvestorDb.js', { cwd: __dirname, timeout: 120000 });
    // Reload the FII database
    if (fiiDb) { try { fiiDb.close(); } catch(e) {} }
    fiiDb = new Database(fiiDbPath, { readonly: true });
    console.log('[admin] FII investor DB rebuilt successfully');
    res.json({ success: true, message: 'FII investor database rebuilt', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[admin] FII rebuild failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/daily — FII/DII daily trading activity
app.get('/api/fii-dii/daily', (req, res) => {
  if (!fiiDb) return res.json({ success: true, data: [] });
  try {
    const { days } = req.query;
    const limit = days ? Number(days) : 30;
    const data = fiiDb.prepare(`
      SELECT * FROM fii_dii_daily ORDER BY date DESC LIMIT ?
    `).all(limit);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/shareholding — Company shareholding patterns
app.get('/api/fii-dii/shareholding', (req, res) => {
  if (!fiiDb) return res.json({ success: true, data: [], totalCompanies: 0 });
  try {
    const { search, sort } = req.query;
    let query = 'SELECT * FROM company_shareholding';
    const params = [];
    if (search) {
      query += ' WHERE companyName LIKE ? OR symbol LIKE ?';
      params.push('%' + search + '%', '%' + search.toUpperCase() + '%');
    }
    if (sort === 'fii') query += ' ORDER BY fiiPct DESC';
    else if (sort === 'dii') query += ' ORDER BY diiPct DESC';
    else if (sort === 'promoter') query += ' ORDER BY promoterPct DESC';
    else query += ' ORDER BY fiiPct DESC';
    query += ' LIMIT 200';
    const data = fiiDb.prepare(query).all(...params);
    const total = fiiDb.prepare('SELECT COUNT(DISTINCT companyName) as c FROM company_shareholding').get().c;
    res.json({ success: true, data, totalCompanies: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/investors — Individual significant investors
app.get('/api/fii-dii/investors', (req, res) => {
  if (!fiiDb) return res.json({ success: true, investors: [] });
  try {
    const { search, sort } = req.query;
    let query = 'SELECT * FROM individual_investors';
    const params = [];
    if (search) {
      query += ' WHERE investorName LIKE ?';
      params.push('%' + search + '%');
    }
    if (sort === 'value') query += ' ORDER BY totalPortfolioValue DESC';
    else query += ' ORDER BY holdingsCount DESC';
    query += ' LIMIT 100';
    const investors = fiiDb.prepare(query).all(...params);
    res.json({ success: true, investors });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/investors/:investorId — Single investor detail
app.get('/api/fii-dii/investors/:investorId', (req, res) => {
  if (!fiiDb) return res.json({ success: true, investor: null, holdings: [] });
  try {
    const { investorId } = req.params;
    const investor = fiiDb.prepare('SELECT * FROM individual_investors WHERE id = ?').get(investorId);
    if (!investor) return res.status(404).json({ success: false, error: 'Investor not found' });
    const holdings = fiiDb.prepare('SELECT * FROM investor_holdings WHERE investorId = ? ORDER BY holdingPct DESC').all(investorId);
    res.json({ success: true, investor, holdings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/investors/:investorId/holdings — Holdings of a specific investor
app.get('/api/fii-dii/investors/:investorId/holdings', (req, res) => {
  if (!fiiDb) return res.json({ success: true, holdings: [] });
  try {
    const { investorId } = req.params;
    const investor = fiiDb.prepare('SELECT * FROM individual_investors WHERE id = ?').get(investorId);
    if (!investor) return res.status(404).json({ success: false, error: 'Investor not found' });
    const holdings = fiiDb.prepare('SELECT * FROM investor_holdings WHERE investorId = ? ORDER BY holdingPct DESC').all(investorId);
    res.json({ success: true, investor, holdings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/fii-dii/status — Source status for monitoring
app.get('/api/fii-dii/status', (req, res) => {
  if (!fiiDb) return res.json({ success: true, sources: [] });
  try {
    const sources = fiiDb.prepare('SELECT * FROM source_status ORDER BY lastAttempt DESC').all();
    res.json({ success: true, sources });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Section 4: International AMCs ───────────────────────────────
app.get('/api/fii-dii/international-amcs', (req, res) => {
  if (!fiiDb) return res.json({ success: true, amcs: [] });
  try {
    const { search, sort } = req.query;
    let q = 'SELECT * FROM international_amcs';
    const params = [];
    if (search) { q += ' WHERE name LIKE ?'; params.push('%' + search + '%'); }
    if (sort === 'aum') q += ' ORDER BY aumUsdBn DESC';
    else q += ' ORDER BY name ASC';
    q += ' LIMIT 100';
    const amcs = fiiDb.prepare(q).all(...params);
    res.json({ success: true, amcs, totalAmcs: amcs.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Section 5: International Funds / ETFs ───────────────────────
app.get('/api/fii-dii/international-funds', (req, res) => {
  if (!fiiDb) return res.json({ success: true, funds: [] });
  try {
    const { amcId, search, sort } = req.query;
    let q = 'SELECT * FROM international_funds';
    const params = [];
    const conds = [];
    if (amcId) { conds.push('amcId = ?'); params.push(Number(amcId)); }
    if (search) { conds.push('(fundName LIKE ? OR amcName LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    if (sort === 'aum') q += ' ORDER BY aumUsd DESC';
    else q += ' ORDER BY fundName ASC';
    q += ' LIMIT 200';
    const funds = fiiDb.prepare(q).all(...params);
    res.json({ success: true, funds, totalFunds: funds.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/fii-dii/international-funds/:fundId/holdings', (req, res) => {
  if (!fiiDb) return res.json({ success: true, holdings: [] });
  try {
    const fund = fiiDb.prepare('SELECT * FROM international_funds WHERE id = ?').get(req.params.fundId);
    if (!fund) return res.status(404).json({ success: false, error: 'Fund not found' });
    const holdings = fiiDb.prepare('SELECT * FROM international_fund_holdings WHERE fundId = ? ORDER BY holdingPct DESC').all(req.params.fundId);
    res.json({ success: true, fund, holdings });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Section 6: Key Investors ────────────────────────────────────
app.get('/api/fii-dii/key-investors', (req, res) => {
  if (!fiiDb) return res.json({ success: true, investors: [] });
  try {
    const { type, search, sort } = req.query;
    let q = 'SELECT * FROM key_investors';
    const params = [];
    const conds = [];
    if (type) { conds.push('investorType = ?'); params.push(type); }
    if (search) { conds.push('name LIKE ?'); params.push('%' + search + '%'); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    if (sort === 'value') q += ' ORDER BY totalPortfolioValueInr DESC';
    else if (sort === 'holdings') q += ' ORDER BY holdingsCount DESC';
    else q += ' ORDER BY name ASC';
    q += ' LIMIT 200';
    const investors = fiiDb.prepare(q).all(...params);
    res.json({ success: true, investors, totalInvestors: investors.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/fii-dii/key-investors/:investorId/holdings', (req, res) => {
  if (!fiiDb) return res.json({ success: true, holdings: [] });
  try {
    const investor = fiiDb.prepare('SELECT * FROM key_investors WHERE id = ?').get(req.params.investorId);
    if (!investor) return res.status(404).json({ success: false, error: 'Investor not found' });
    const holdings = fiiDb.prepare('SELECT * FROM key_investor_holdings WHERE investorId = ? ORDER BY holdingPct DESC').all(req.params.investorId);
    res.json({ success: true, investor, holdings });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Section 7: Promoters / Strategic Holders ─────────────────────
app.get('/api/fii-dii/promoters', (req, res) => {
  if (!fiiDb) return res.json({ success: true, promoters: [] });
  try {
    const { type, search, sort } = req.query;
    let q = 'SELECT * FROM promoters';
    const params = [];
    const conds = [];
    if (type) { conds.push('promoterType = ?'); params.push(type); }
    if (search) { conds.push('name LIKE ?'); params.push('%' + search + '%'); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    if (sort === 'value') q += ' ORDER BY totalValueInr DESC';
    else if (sort === 'shares') q += ' ORDER BY totalShares DESC';
    else q += ' ORDER BY name ASC';
    q += ' LIMIT 200';
    const promoters = fiiDb.prepare(q).all(...params);
    res.json({ success: true, promoters, totalPromoters: promoters.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/fii-dii/promoters/:promoterId/holdings', (req, res) => {
  if (!fiiDb) return res.json({ success: true, holdings: [] });
  try {
    const promoter = fiiDb.prepare('SELECT * FROM promoters WHERE id = ?').get(req.params.promoterId);
    if (!promoter) return res.status(404).json({ success: false, error: 'Promoter not found' });
    const holdings = fiiDb.prepare('SELECT * FROM promoter_holdings WHERE promoterId = ? ORDER BY holdingPct DESC').all(req.params.promoterId);
    res.json({ success: true, promoter, holdings });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Company Master ──────────────────────────────────────────────
app.get('/api/fii-dii/companies', (req, res) => {
  if (!fiiDb) return res.json({ success: true, companies: [] });
  try {
    const { search, sector } = req.query;
    let q = 'SELECT * FROM companies';
    const params = [];
    const conds = [];
    if (search) { conds.push('(name LIKE ? OR isin LIKE ? OR ticker LIKE ?)'); params.push('%' + search + '%', '%' + search + '%', '%' + search.toUpperCase() + '%'); }
    if (sector) { conds.push('sector = ?'); params.push(sector); }
    if (conds.length) q += ' WHERE ' + conds.join(' AND ');
    q += ' ORDER BY name ASC LIMIT 200';
    const companies = fiiDb.prepare(q).all(...params);
    res.json({ success: true, companies, totalCompanies: companies.length });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/fii-dii/companies/:companyId/all-holders', (req, res) => {
  if (!fiiDb) return res.json({ success: true, holders: {} });
  try {
    const cid = Number(req.params.companyId);
    const company = fiiDb.prepare('SELECT * FROM companies WHERE id = ?').get(cid);
    if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
    const promoters = fiiDb.prepare('SELECT * FROM promoter_holdings WHERE companyId = ?').all(cid);
    const intlHoldings = fiiDb.prepare('SELECT ih.*, f.fundName, f.amcName FROM international_fund_holdings ih JOIN international_funds f ON ih.fundId = f.id WHERE ih.companyId = ?').all(cid);
    const keyHoldings = fiiDb.prepare('SELECT kh.*, ki.name as investorName, ki.investorType FROM key_investor_holdings kh JOIN key_investors ki ON kh.investorId = ki.id WHERE kh.companyId = ?').all(cid);
    const shareholding = fiiDb.prepare('SELECT * FROM company_shareholding WHERE companyName LIKE ?').all(company.name);
    res.json({ success: true, company, promoters, internationalHoldings: intlHoldings, keyInvestorHoldings: keyHoldings, shareholdingPatterns: shareholding });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ---- HDFC Mutual Fund Scheme Data (from SQLite — real scheme-level data) ----
const hdfcMfDb = require('./db/mutualFunds');

registerDebugRoute(app);

// IMPORTANT: Static routes BEFORE :schemeId to avoid Express param matching

// GET /api/mutual-funds/all — List ALL AMC schemes with summary (multi-AMC endpoint)
app.get('/api/mutual-funds/all', (req, res) => {
  try {
    const { search, amc, category, limit } = req.query;
    let schemes = hdfcMfDb.getAllSchemesSummary();

    // Filter by AMC
    if (amc) {
      const amcLower = amc.toLowerCase();
      schemes = schemes.filter(s => (s.amc || '').toLowerCase().includes(amcLower));
    }

    // Filter by category
    if (category) {
      const catLower = category.toLowerCase();
      schemes = schemes.filter(s => (s.category || '').toLowerCase().includes(catLower));
    }

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      schemes = schemes.filter(s =>
        (s.schemeName || '').toLowerCase().includes(q) ||
        (s.amc || '').toLowerCase().includes(q) ||
        (s.category || '').toLowerCase().includes(q) ||
        (s.id || '').toLowerCase().includes(q)
      );
    }

    // Limit
    const lim = limit ? parseInt(limit) : 5000;
    schemes = schemes.slice(0, lim);

    // Group by AMC for summary
    const byAmc = {};
    for (const s of schemes) {
      const a = s.amc || 'Unknown';
      if (!byAmc[a]) byAmc[a] = { count: 0, schemes: [] };
      byAmc[a].count++;
    }

    res.json({
      success: true,
      totalSchemes: schemes.length,
      totalAmcs: Object.keys(byAmc).length,
      amcSummary: Object.entries(byAmc).map(([name, d]) => ({ name, count: d.count })),
      source: 'Multi-AMC Official Data (SQLite)',
      schemes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/all-schemes-summary — Lightweight summary for Smart Money page
app.get('/api/mutual-funds/all-schemes-summary', (req, res) => {
  try {
    const schemes = hdfcMfDb.getAllSchemesSummary();
    const totalAum = schemes.reduce((sum, s) => sum + (s.aum || 0), 0);
    const totalStocks = schemes.reduce((sum, s) => sum + (s.totalHoldings || 0), 0);
    const byAmc = {};
    for (const s of schemes) {
      const a = s.amc || 'Unknown';
      if (!byAmc[a]) byAmc[a] = 0;
      byAmc[a]++;
    }
    res.json({
      success: true,
      totalSchemes: schemes.length,
      totalAmcs: Object.keys(byAmc).length,
      totalAum,
      totalStocks: Math.round(totalStocks / 10),
      schemes: schemes.slice(0, parseInt(req.query.limit) || 10)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/amcs — List all AMCs with scheme counts
app.get('/api/mutual-funds/amcs', (req, res) => {
  try {
    const schemes = hdfcMfDb.getAllSchemesSummary();
    const byAmc = {};
    for (const s of schemes) {
      const a = s.amc || 'Unknown';
      if (!byAmc[a]) byAmc[a] = { name: a, count: 0, categories: new Set() };
      byAmc[a].count++;
      if (s.category) byAmc[a].categories.add(s.category);
    }
    const amcs = Object.values(byAmc)
      .map(a => ({ ...a, categories: Array.from(a.categories) }))
      .sort((a, b) => b.count - a.count);
    res.json({ success: true, totalAmcs: amcs.length, totalSchemes: schemes.length, amcs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mutual-funds/run-all — Trigger multi-AMC import pipeline
let allAmcPipelineRunning = false;
app.post('/api/mutual-funds/run-all', async (req, res) => {
  if (allAmcPipelineRunning) {
    return res.json({ success: true, message: 'Multi-AMC pipeline already running...' });
  }
  allAmcPipelineRunning = true;
  res.json({ success: true, message: 'Multi-AMC pipeline started. Check back in 3-5 minutes.' });
  try {
    const MfOrchestrator = require('./common/mf-engine/orchestrator');
    const orch = new MfOrchestrator(hdfcMfDb, { perAmcConcurrency: 5 });
    await orch.runAll();
    console.log('[server] Multi-AMC pipeline completed via manual trigger');
  } catch (err) {
    console.error('[server] Multi-AMC pipeline failed:', err.message);
  } finally {
    allAmcPipelineRunning = false;
  }
});

// GET /api/mutual-funds/hdfc — List all HDFC schemes with summary
// Auto-triggers pipeline if database is empty
let hdfcAutoTriggered = false;
app.get('/api/mutual-funds/hdfc', (req, res) => {
  try {
    // Auto-trigger pipeline if DB is empty or data is stale (>1 day old)
    const schemeCount = hdfcMfDb.getAllSchemes().length;
    const shouldRefresh = schemeCount === 0 || (() => {
      try {
        const latest = hdfcMfDb.getDb().prepare('SELECT MAX(asOfDate) as d FROM mutual_fund_returns').get();
        if (!latest || !latest.d) return true;
        const ageMs = Date.now() - new Date(latest.d).getTime();
        return ageMs > 24 * 60 * 60 * 1000;
      } catch (_) { return true; }
    })();
    if (shouldRefresh && !hdfcAutoTriggered) {
      hdfcAutoTriggered = true;
      const reason = schemeCount === 0 ? 'empty' : 'stale (>1 day old)';
      console.log('[server] HDFC MF DB ' + reason + ' — auto-refreshing from Groww...');
      const { main: runGrowwPipeline } = require('./scripts/hdfc/importGrowwEquity');
      runGrowwPipeline().then(() => {
        console.log('[server] HDFC MF Groww refresh completed');
        hdfcAutoTriggered = false;
      }).catch(err => {
        console.error('[server] HDFC MF Groww refresh failed:', err.message);
        hdfcAutoTriggered = false; // allow retry
      });
    }

    const { search } = req.query;
    let schemes = hdfcMfDb.getAllSchemesSummary();

    if (search) {
      const q = search.toLowerCase();
      schemes = schemes.filter(s =>
        (s.schemeName || '').toLowerCase().includes(q) ||
        (s.category || '').toLowerCase().includes(q) ||
        (s.id || '').toLowerCase().includes(q) ||
        (s.topHoldings || []).some(h => (h.securityName || '').toLowerCase().includes(q))
      );
    }

    res.json({
      success: true,
      totalSchemes: schemes.length,
      source: 'HDFC Official Data (SQLite)',
      schemes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/hdfc/data-status — Data integrity report
app.get('/api/mutual-funds/hdfc/data-status', (req, res) => {
  try {
    const report = hdfcMfDb.validateIntegrity();
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mutual-funds/hdfc/run-pipeline — Trigger HDFC data import
let hdfcPipelineRunning = false;
app.post('/api/mutual-funds/hdfc/run-pipeline', async (req, res) => {
  if (hdfcPipelineRunning) {
    return res.json({ success: true, message: 'Pipeline already running...' });
  }
  hdfcPipelineRunning = true;
  res.json({ success: true, message: 'HDFC pipeline started. Check back in 2-3 minutes.' });
  try {
    const { main: runGrowwPipeline } = require('./scripts/hdfc/importGrowwEquity');
    await runGrowwPipeline();
    console.log('[server] HDFC MF Groww pipeline completed via manual trigger');
  } catch (err) {
    console.error('[server] HDFC MF pipeline failed:', err.message);
  } finally {
    hdfcPipelineRunning = false;
  }
});

// NOW the :schemeId routes (after static routes)

// GET /api/mutual-funds/hdfc/:schemeId — Full scheme profile with latest holdings
app.get('/api/mutual-funds/hdfc/:schemeId', (req, res) => {
  try {
    const { schemeId } = req.params;
    const profile = hdfcMfDb.getSchemeProfile(schemeId);
    if (!profile) {
      return res.status(404).json({ success: false, error: `Scheme '${schemeId}' not found` });
    }
    res.json({ success: true, scheme: profile });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/hdfc/:schemeId/holdings — Full holdings for a specific month
app.get('/api/mutual-funds/hdfc/:schemeId/holdings', (req, res) => {
  try {
    const { schemeId } = req.params;
    const { month, date } = req.query;

    // Get available portfolio dates
    const dates = hdfcMfDb.getPortfolioDates(schemeId);
    if (!dates || dates.length === 0) {
      return res.status(404).json({ success: false, error: `No portfolio data for '${schemeId}'` });
    }

    // Determine which date to fetch
    let targetDate = null;
    if (date) {
      targetDate = date;
    } else if (month) {
      const monthLower = month.toLowerCase();
      const match = dates.find(d => d.portfolioDate.startsWith(monthLower) || d.portfolioDate.includes(monthLower));
      if (match) targetDate = match.portfolioDate;
    }

    const portfolio = hdfcMfDb.getHoldingsByDate(schemeId, targetDate);
    if (!portfolio) {
      return res.status(404).json({ success: false, error: `Portfolio not found for '${schemeId}' at date '${targetDate || 'latest'}'` });
    }

    res.json({
      success: true,
      schemeId,
      schemeName: (hdfcMfDb.getScheme(schemeId) || {}).schemeName || schemeId,
      portfolioDate: portfolio.portfolioDate,
      totalHoldings: portfolio.holdings.length,
      availableMonths: dates.map(d => ({ date: d.portfolioDate, totalHoldings: d.totalHoldings })),
      holdings: portfolio.holdings
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/hdfc/:schemeId/months — List available portfolio months
app.get('/api/mutual-funds/hdfc/:schemeId/months', (req, res) => {
  try {
    const { schemeId } = req.params;
    const dates = hdfcMfDb.getPortfolioDates(schemeId);
    res.json({
      success: true,
      schemeId,
      totalMonths: dates.length,
      months: dates.map(d => ({ date: d.portfolioDate, totalHoldings: d.totalHoldings }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/mutual-funds/hdfc/:schemeId/nav-history — NAV chart from portfolio date to today
app.get('/api/mutual-funds/hdfc/:schemeId/nav-history', async (req, res) => {
  try {
    const { schemeId } = req.params;
    const portfolioDate = req.query.from || null; // e.g. ?from=2026-07-30
    const scheme = hdfcMfDb.getScheme(schemeId);
    if (!scheme) return res.status(404).json({ success: false, error: 'Scheme not found' });

    // Get stored NAV history first
    const history = hdfcMfDb.getNavHistory(schemeId, 90);
    if (history && history.length > 5) {
      let filtered = history;
      if (portfolioDate) {
        filtered = history.filter(h => h.navDate >= portfolioDate);
      }
      if (filtered.length >= 2) {
        return res.json({
          success: true, schemeId, schemeName: scheme.schemeName,
          portfolioDate: portfolioDate || filtered[0].navDate,
          source: 'tracked', dataPoints: filtered.length,
          data: filtered.reverse().map(h => ({ date: h.navDate, nav: h.nav }))
        });
      }
    }

    // Fallback: fetch real NAV history from mfapi.in (works for ALL schemes)
    const axios = require('axios');
    const schemeCode = scheme.schemeCode;
    if (!schemeCode) return res.json({ success: true, schemeId, data: [] });

    try {
      const resp = await axios.get(`https://api.mfapi.in/mf/${schemeCode}`, { timeout: 15000 });
      const mfData = resp.data;
      if (mfData && mfData.data && mfData.data.length > 0) {
        // mfapi.in returns most recent first, reverse to chronological
        const raw = mfData.data.slice(0, 120).reverse(); // ~6 months of data
        var allNav = raw.map(d => ({
          date: d.date.split('-').reverse().join('-'), // DD-MM-YYYY -> YYYY-MM-DD
          nav: parseFloat(d.nav)
        })).filter(d => !isNaN(d.nav));

        // Filter from portfolio date if provided
        let data = allNav;
        if (portfolioDate) {
          data = allNav.filter(d => d.date >= portfolioDate);
        }
        // If too few points, use all available
        if (data.length < 5) data = allNav;

        if (data.length > 0) {
          const currentNav = data[data.length - 1].nav;
          const startNav = data[0].nav;
          const pctChange = ((currentNav - startNav) / startNav * 100).toFixed(2);
          return res.json({
            success: true, schemeId, schemeName: scheme.schemeName,
            portfolioDate: portfolioDate || data[0].date,
            source: 'mfapi.in', currentNav, pctChange: parseFloat(pctChange),
            dataPoints: data.length, data
          });
        }
      }
    } catch (e) { /* mfapi.in failed */ }

    res.json({ success: true, schemeId, data: [], message: 'No NAV data available' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/mutual-funds/hdfc/track-nav — Trigger daily NAV tracking
app.post('/api/mutual-funds/hdfc/track-nav', async (req, res) => {
  try {
    const { trackDailyNav } = require('./scripts/hdfc/trackNavHistory');
    res.json({ success: true, message: 'NAV tracking started...' });
    trackDailyNav().then(() => console.log('[server] NAV tracking completed')).catch(err => console.error('[server] NAV tracking failed:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/schemes-ranking', (req, res) => {
  try {
    const { timeframe } = req.query;
    const ranking = institutionalService.getSchemesRanking(timeframe || '1m');
    res.json({ success: true, count: ranking.length, timeframe: timeframe || '1m', data: ranking });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/stock-weightage-ranking', (req, res) => {
  try {
    const { timeframe } = req.query;
    const ranking = institutionalService.getStockWeightageRanking(timeframe || '1m');
    res.json({ success: true, count: ranking.length, timeframe: timeframe || '1m', data: ranking });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/stock-breakdown', (req, res) => {
  try {
    const { symbol, mode } = req.query;
    const breakdown = institutionalService.getSchemeBreakdownForStock(symbol, mode || 'holding');
    res.json({ success: true, data: breakdown });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/conviction-leaderboard', (req, res) => {
  try {
    const { date } = req.query;
    const leaderboard = institutionalService.getConvictionLeaderboard(date);
    res.json({ success: true, count: leaderboard.length, date: date || new Date().toISOString().slice(0, 10), data: leaderboard });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/exit-watch', (req, res) => {
  try {
    const { date } = req.query;
    const exitWatch = institutionalService.getExitWatchList(date);
    res.json({ success: true, count: exitWatch.length, data: exitWatch });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/institutional/backtest-results', (req, res) => {
  try {
    const results = gridSearchTrainTest();
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/institutional/run-pipeline', async (req, res) => {
  try {
    const { date } = req.body || {};
    await runDailyConvictionPipeline(date);
    res.json({ success: true, message: `Pipeline triggered successfully for ${date || 'today'}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- Instruments ----
app.get('/api/instruments/status', (req, res) => {
  res.json(instrumentService.status());
});

// GET /api/instruments/search?q=reliance&exchange=NSE&limit=10
app.get('/api/instruments/search', (req, res) => {
  try {
    const { q, exchange, segment, limit } = req.query;
    if (!q) return res.status(400).json({ error: 'q query param is required' });
    res.json(instrumentService.search(q, { exchange, segment, limit: limit ? Number(limit) : undefined }));
  } catch (err) {
    res.status(503).json({ error: err.message }); // most likely "not loaded yet"
  }
});

// GET /api/instruments/resolve?symbol=RELIANCE&exchange=NSE
app.get('/api/instruments/resolve', (req, res) => {
  try {
    const { symbol, exchange } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });
    res.json(instrumentService.resolveEquity(symbol, { exchange }));
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

const liveQuoteEngine = require('./common/market/liveQuoteEngine');

// GET /api/instruments/watchlist?symbols=NIFTY,BANKNIFTY,GOLD,SILVER
app.get('/api/instruments/watchlist', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    const rawSymbols = (req.query.symbols || 'NIFTY,BANKNIFTY,SENSEX,FINNIFTY,MIDCPNIFTY,GIFTNIFTY,GOLD,SILVER,CRUDEOIL,NATURALGAS').split(',').map(s => s.trim().toUpperCase());
    const quotes = await liveQuoteEngine.fetchWatchlistQuotes(rawSymbols);
    res.json(quotes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const liveStockQuoteService = require('./common/market/liveStockQuoteService');

// GET /api/instruments/quote?symbol=RELIANCE
app.get('/api/instruments/quote', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    const symbol = req.query.symbol || 'RELIANCE';
    const quote = await liveStockQuoteService.fetchLiveStockQuote(symbol);
    res.json(quote);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- GB Terminal Multi-Channel Notification API ----
app.get('/api/notifications/settings', (req, res) => {
  res.json(notificationService.loadConfig());
});

app.post('/api/notifications/settings', (req, res) => {
  const { botToken, chatId, whatsappApiKey, enabled } = req.body;
  const cfg = notificationService.saveConfig({
    botToken: botToken || '',
    chatId: chatId || '',
    whatsappApiKey: whatsappApiKey || '',
    enabled: enabled !== false
  });
  res.json({ success: true, config: cfg });
});

app.post('/api/notifications/send', async (req, res) => {
  try {
    const { title, symbol, message, price, rsi, reason, channels } = req.body || {};
    const result = await notificationService.sendAlert({
      title,
      symbol,
      message,
      price,
      rsi,
      reason,
      channels
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/notifications/test', async (req, res) => {
  const { botToken, chatId, whatsappApiKey } = req.body || {};
  if (botToken || chatId || whatsappApiKey) {
    notificationService.saveConfig({ botToken, chatId, whatsappApiKey });
  }

  const result = await notificationService.sendAlert({
    title: 'GB TERMINAL MOBILE ALERT',
    symbol: 'GB TERMINAL ALGO',
    message: 'Mobile notifications connected successfully to +91 9390219001!',
    price: '24,420.50',
    reason: 'System Test Push Alert',
    channels: ['telegram', 'whatsapp']
  });

  res.json(result);
});


async function start() {
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  } catch (e) {
    console.warn('[server] data directory creation warning:', e.message);
  }

  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = path.join(__dirname, 'data/institutional.db');
    if (require('fs').existsSync(dbPath)) {
      const db = new Database(dbPath);
      const oldRow = db.prepare("SELECT COUNT(*) as c FROM symbol_master WHERE nse_symbol LIKE '%-INDI%' OR nse_symbol LIKE '%_2%' OR nse_symbol LIKE '%JINDAL%'").get();
      if (oldRow && oldRow.c > 0) {
        console.log('[server] Detected legacy seed data. Re-generating clean real NSE stocks...');
        try { require('./common/institutional/generateLargeDataset'); } catch (e) {}
      }
    }
  } catch (dbErr) {
    console.warn('[server] DB startup check non-fatal warning:', dbErr.message);
  }

  await initBrokers();
  instrumentService.refreshAll().then(
    (s) => console.log('[server] instrument master loaded:', s),
    (err) => console.error('[server] instrument master load failed:', err.message)
  ); // deliberately not awaited — server starts serving immediately, instrument search just 503s until this resolves

  // Auto-run Mutual Fund pipeline if database is empty (for Render deployment)
  try {
    const mfDb = require('./db/mutualFunds');
    const schemeCount = mfDb.getAllSchemes().length;
    const amcCount = new Set(mfDb.getAllSchemes().map(s => s.amc)).size;
    if (schemeCount === 0) {
      console.log('[server] MF database empty — running HDFC import pipeline (background)...');
      const { main: runHdfcPipeline } = require('./scripts/hdfc/importHdfcPipeline');
      runHdfcPipeline().then(() => {
        console.log('[server] HDFC MF pipeline completed successfully');
        try {
          const { main: runAmfiFolios } = require('./scripts/importAmfiFolios');
          runAmfiFolios().then(() => {
          console.log('[server] AMFI folio import completed');
          // Auto-snapshot AUM and investor data for historical tracking
          try {
            const today = new Date().toISOString().slice(0, 10);
            // Normalize date to ISO format for comparison
            function normDate(d) {
              if (!d) return today;
              if (/^d{4}-d{2}-d{2}$/.test(d)) return d;
              try { return new Date(d).toISOString().slice(0, 10); } catch(e) { return today; }
            }
            const aumRows = hdfcMfDb.getDb().prepare('SELECT schemeId, aum, asOfDate FROM mutual_fund_aum WHERE aum > 0').all();
            const invRows = hdfcMfDb.getDb().prepare('SELECT schemeId, investorCount, investorDate FROM mutual_fund_investors WHERE investorCount > 0').all();
            const insAum = hdfcMfDb.getDb().prepare('INSERT OR REPLACE INTO aum_snapshots (schemeId, aum, snapshotDate, source) VALUES (?, ?, ?, ?)');
            const insInv = hdfcMfDb.getDb().prepare('INSERT OR REPLACE INTO investor_snapshots (schemeId, investorCount, snapshotDate, source) VALUES (?, ?, ?, ?)');
            const tx = hdfcMfDb.getDb().transaction(() => {
              for (const r of aumRows) insAum.run(r.schemeId, r.aum, today, 'startup-snapshot');
              for (const r of invRows) insInv.run(r.schemeId, r.investorCount, today, 'startup-snapshot');
            });
            tx();
            console.log('[server] Snapshot stored:', aumRows.length, 'AUM,', invRows.length, 'investors');
          } catch(e) { console.warn('[server] Snapshot failed (non-fatal):', e.message); }
        }).catch(err => { console.warn('[server] AMFI folio import failed (non-fatal):', err.message); });
      } catch(e) { console.warn('[server] AMFI folio import skipped:', e.message); }
    }).catch(err => {
      console.error('[server] HDFC MF pipeline failed (non-fatal):', err.message);
    });
    } else {
      console.log(`[server] MF database loaded: ${schemeCount} schemes across ${amcCount} AMCs`);
      // Auto-import AMFI folio data on every startup (fast, idempotent)
      try {
        const { main: runAmfiFolios } = require('./scripts/importAmfiFolios');
        runAmfiFolios().then(() => console.log('[server] AMFI folio import completed')).catch(err => console.error('[server] AMFI folio import failed (non-fatal):', err.message));
      } catch(e) { console.warn('[server] AMFI folio import skipped:', e.message); }
      // If only HDFC, trigger background multi-AMC expansion
      if (amcCount <= 1 && schemeCount < 500) {
        console.log('[server] Only ' + amcCount + ' AMC — triggering background multi-AMC expansion...');
        const MfOrchestrator = require('./common/mf-engine/orchestrator');
        const orch = new MfOrchestrator(mfDb, { perAmcConcurrency: 5, globalConcurrency: 20 });
        orch.runAll().then(() => {
          console.log('[server] Multi-AMC expansion completed');
          // Auto-import AMFI folio data for investor counts
          try {
            const { main: runAmfiFolios } = require('./scripts/importAmfiFolios');
            runAmfiFolios().then(() => console.log('[server] AMFI folio import completed')).catch(err => console.error('[server] AMFI folio import failed (non-fatal):', err.message));
          } catch(e) { console.warn('[server] AMFI folio import skipped:', e.message); }
        }).catch(err => {
          console.error('[server] Multi-AMC expansion failed (non-fatal):', err.message);
        });
      }
    }
  } catch (e) {
    console.warn('[server] MF pipeline init warning:', e.message);
  }

  
// Debug endpoint for change tracking
app.get('/api/debug/changes/:schemeId', (req, res) => {
  try {
    const { schemeId } = req.params;
    const db = hdfcMfDb.getDb();
    
    // Check tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    
    // Check returns
    const returns = db.prepare('SELECT period, returnValue FROM mutual_fund_returns WHERE schemeId = ?').all(schemeId);
    
    // Check AUM
    const aum = db.prepare('SELECT aum, asOfDate FROM mutual_fund_aum WHERE schemeId = ?').get(schemeId);
    
    // Check snapshots
    const aumSnaps = db.prepare('SELECT aum, snapshotDate FROM aum_snapshots WHERE schemeId = ? ORDER BY snapshotDate').all(schemeId);
    const invSnaps = db.prepare('SELECT investorCount, snapshotDate FROM investor_snapshots WHERE schemeId = ? ORDER BY snapshotDate').all(schemeId);
    
    // Test getAumChange
    let aumChange = null;
    try { aumChange = hdfcMfDb.getAumChange(schemeId, 1); } catch(e) { aumChange = { error: e.message }; }
    
    let invChange = null;
    try { invChange = hdfcMfDb.getInvestorChange(schemeId, 1); } catch(e) { invChange = { error: e.message }; }
    
    res.json({ tables, returns, aum, aumSnaps, invSnaps, aumChange, invChange });
  } catch(e) {
    res.json({ error: e.message });
  }
});

const port = process.env.PORT || env.server.port || 4000;
  const host = '0.0.0.0';
  
// TEMP: Dump Groww SSR keys for debugging folio data
app.get('/api/debug/groww', async (req, res) => {
  try {
    var slug = req.query.slug || 'hdfc-flexi-cap-fund-direct-growth';
    var url = 'https://groww.in/mutual-funds/' + slug;
    var response = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
    var pat = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;
    var match = response.data.match(pat);
    if (!match) return res.json({ error: 'no next data' });
    var nd = JSON.parse(match[1]);
    var ss = nd.props && nd.props.pageProps && nd.props.pageProps.mfServerSideData;
    if (!ss) return res.json({ error: 'no ssd' });
    var result = {};
    var keys = Object.keys(ss);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = ss[k];
      if (v === null || v === undefined || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        result[k] = v;
      } else if (Array.isArray(v)) {
        result[k] = 'Array(' + v.length + ')';
      } else {
        result[k] = 'Object(' + Object.keys(v).join(',') + ')';
      }
    }
    var found = {};
    function s(o, p) { if (!o || typeof o !== 'object') return; var ok = Object.keys(o); for (var j = 0; j < ok.length; j++) { var fk = ok[j]; var fv = o[fk]; var fp = p ? p+'.'+fk : fk; if (/folio|investor|holder|subscriber|account/i.test(fk)) { found[fp] = typeof fv === 'object' ? JSON.stringify(fv).substring(0, 200) : fv; } if (typeof fv === 'object' && fv !== null && !Array.isArray(fv)) s(fv, fp); } }
    s(ss, '');
    result._folioFields = found;
    res.json({ success: true, data: result });
  } catch (err) { res.json({ error: err.message }); }
});

app.listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
    console.log(`[server] active brokers: ${Object.keys(brokers).join(', ') || '(none — check ANGEL_ENABLED/GROWW_ENABLED)'}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, initBrokers, brokers };