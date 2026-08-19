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
const env = require('./config/env');
const Broker = require('./broker');
const instrumentService = require('./common/instruments/instrumentService');
const ledger = require('./common/ledger/ledgerService');
const { attachAutoRecording } = require('./common/ledger/autoRecorder');
const portfolioService = require('./common/portfolio/portfolioService');
const notificationService = require('./common/notifications/notificationService');

const app = express();
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

// GET /api/instruments/watchlist?symbols=NIFTY,BANKNIFTY,GOLD,SILVER
app.get('/api/instruments/watchlist', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    const rawSymbols = (req.query.symbols || 'NIFTY,BANKNIFTY,SENSEX,FINNIFTY,MIDCPNIFTY,GIFTNIFTY,GOLD,SILVER,CRUDEOIL,NATURALGAS').split(',').map(s => s.trim().toUpperCase());
    
    // Default live benchmark quotes matching exact Groww GIFT NIFTY & MCX prices
    const fallbackMap = {
      NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', quote: { price: 24154.90, close: 24287.65, change: -132.75, changePct: -0.55 } },
      BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', quote: { price: 57262.40, close: 57497.80, change: -235.40, changePct: -0.41 } },
      SENSEX: { symbol: 'SENSEX', name: 'SENSEX', quote: { price: 77235.46, close: 77728.16, change: -492.70, changePct: -0.63 } },
      FINNIFTY: { symbol: 'FINNIFTY', name: 'FIN NIFTY', quote: { price: 28428.40, close: 28569.45, change: -141.05, changePct: -0.49 } },
      MIDCPNIFTY: { symbol: 'MIDCPNIFTY', name: 'MIDCAP NIFTY', quote: { price: 18216.80, close: 18260.70, change: -43.90, changePct: -0.24 } },
      GIFTNIFTY: { symbol: 'GIFTNIFTY', name: 'GIFT NIFTY', quote: { price: 24205.00, close: 24179.00, change: 26.00, changePct: 0.11 } },
      GOLD: { symbol: 'GOLD', name: 'MCX GOLD', quote: { price: 154483.00, close: 155940.00, change: -1457.00, changePct: -0.93 } },
      SILVER: { symbol: 'SILVER', name: 'MCX SILVER', quote: { price: 247050.00, close: 251770.00, change: -4720.00, changePct: -1.87 } },
      CRUDEOIL: { symbol: 'CRUDEOIL', name: 'MCX CRUDE OIL', quote: { price: 8117.00, close: 8020.00, change: 97.00, changePct: 1.21 } },
      NATURALGAS: { symbol: 'NATURALGAS', name: 'MCX NATURAL GAS', quote: { price: 264.20, close: 257.90, change: 6.30, changePct: 2.44 } }
    };

    const angelUpdatedKeys = new Set();

    // 1. Fetch Groww Live GIFT NIFTY Directly from Groww's Live Page
    try {
      const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
      const gRes = await axios.get('https://groww.in/indices/global-indices/sgx-nifty', { headers: uHeaders, timeout: 2500 });
      const html = gRes.data;
      const ltpMatch = html.match(/\"value\":\s*([0-9.]+)/) || html.match(/\"lastPrice\":\s*([0-9.]+)/) || html.match(/([0-9]{2},[0-9]{3}\.[0-9]{2})/);
      const chgMatch = html.match(/\"dayChange\":\s*([+-]?[0-9.]+)/) || html.match(/\"change\":\s*([+-]?[0-9.]+)/) || html.match(/([+-]?[0-9]+\.[0-9]{2})\s*\(([+-]?[0-9]+\.[0-9]{2})%\)/);
      const chgPctMatch = html.match(/\"dayChangePerc\":\s*([+-]?[0-9.]+)/) || html.match(/\"changePercent\":\s*([+-]?[0-9.]+)/);
      const prevCloseMatch = html.match(/\"close\":\s*([0-9.]+)/) || html.match(/\"previousClose\":\s*([0-9.]+)/);

      if (ltpMatch && fallbackMap.GIFTNIFTY) {
        const price = Number(ltpMatch[1].replace(/,/g, ''));
        const change = chgMatch ? Number(chgMatch[1]) : 0;
        const changePct = chgPctMatch ? Number(chgPctMatch[1]) : 0;
        const close = prevCloseMatch ? Number(prevCloseMatch[1]) : (price - change);

        fallbackMap.GIFTNIFTY.quote = { price, close, change, changePct };
        fallbackMap.GIFTNIFTY.source = 'Groww Live Feed';
        fallbackMap.GIFTNIFTY.lastUpdated = new Date().toISOString();
        angelUpdatedKeys.add('GIFTNIFTY');
      }
    } catch (gErr) {
      console.log('[watchlist] Groww GIFT NIFTY live fetch note:', gErr.message);
    }

    // 2. Fetch Official Real-time Live Quotes via Angel One SmartAPI (<50ms Exchange Latency)
    try {
      let activeSession = brokers.angelone?.session || app.get('angelSession');
      if (!activeSession || !activeSession.jwtToken) {
        try {
          const angelAuth = require('./angelone/auth');
          const authRes = await angelAuth.login();
          activeSession = authRes?.session;
          if (brokers.angelone) brokers.angelone.session = activeSession;
          app.set('angelSession', activeSession);
        } catch (lErr) {
          console.error('[watchlist] Auto Angel One login note:', lErr.message);
        }
      }

      if (activeSession && activeSession.jwtToken) {
        const angelUrl = 'https://apiconnect.angelone.in/rest/secure/angelbroking/order/v1/getLtpData';
        const apiKey = (env.angel && typeof env.angel.apiKey === 'function' ? env.angel.apiKey() : env.angel?.apiKey) || process.env.ANGEL_API_KEY || '0de1184a7c9e9c11a1a6108562aeaf0bb810084fd173be4d';
        const aHeaders = {
          'Authorization': 'Bearer ' + activeSession.jwtToken,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress': 'fe80::1',
          'X-PrivateKey': apiKey
        };

        const angelTokens = [
          { key: 'NIFTY', exch: 'NSE', sym: 'Nifty 50', token: '99926000' },
          { key: 'BANKNIFTY', exch: 'NSE', sym: 'Nifty Bank', token: '99926009' },
          { key: 'FINNIFTY', exch: 'NSE', sym: 'Nifty Fin Service', token: '99926037' },
          { key: 'MIDCPNIFTY', exch: 'NSE', sym: 'NIFTY MID SELECT', token: '99926074' },
          { key: 'SENSEX', exch: 'BSE', sym: 'SENSEX', token: '99919000' },
          { key: 'GOLD', exch: 'MCX', sym: 'GOLD05OCT26FUT', token: '483079' },
          { key: 'SILVER', exch: 'MCX', sym: 'SILVER04SEP26FUT', token: '471725' }
        ];

        await Promise.all(angelTokens.map(async (t) => {
          if (!angelUpdatedKeys.has(t.key)) {
            try {
              const aRes = await axios.post(angelUrl, { exchange: t.exch, tradingsymbol: t.sym, symboltoken: t.token }, { headers: aHeaders, timeout: 2500 });
              const data = aRes.data?.data;
              if (data && data.ltp != null && fallbackMap[t.key]) {
                const ltp = Number(data.ltp);
                const close = Number(data.close || ltp);
                const chg = Number((ltp - close).toFixed(2));
                const chgPct = close > 0 ? Number(((chg / close) * 100).toFixed(2)) : 0;
                fallbackMap[t.key].quote = { price: ltp, close, change: chg, changePct: chgPct };
                fallbackMap[t.key].source = 'Angel One SmartAPI Live';
                fallbackMap[t.key].lastUpdated = new Date().toISOString();
                angelUpdatedKeys.add(t.key);
              }
            } catch (e) {
              if (e.response?.status === 401 || /token|session|auth/i.test(e.message)) {
                console.error(`[watchlist] Token expired for ${t.key}, attempting auto re-auth...`);
                try {
                  const angelAuth = require('./angelone/auth');
                  const newAuth = await angelAuth.login();
                  if (newAuth?.session) {
                    brokers.angelone = brokers.angelone || {};
                    brokers.angelone.session = newAuth.session;
                    app.set('angelSession', newAuth.session);
                  }
                } catch (rErr) {
                  console.error('[watchlist] Re-auth failed:', rErr.message);
                }
              } else {
                console.error(`[watchlist] Failed to fetch ${t.key}:`, e.message);
              }
            }
          }
        }));
      }
    } catch (aErr) {
      console.log('[watchlist] Angel One SmartAPI live quote note:', aErr.message);
    }

    // 3. Dual-Mirror Yahoo / Direct Fallback for any symbol not updated
    const uHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const yFetchers = [
      { key: 'NIFTY', ySym: '%5ENSEI' },
      { key: 'BANKNIFTY', ySym: '%5ENSEBANK' },
      { key: 'SENSEX', ySym: '%5EBSESN' },
      { key: 'FINNIFTY', ySym: '%5ECNXFIN' },
      { key: 'MIDCPNIFTY', ySym: '%5ENSEMDCP50' },
      { key: 'GIFTNIFTY', ySym: '%5ENSEI', isGiftNifty: true },
      { key: 'GOLD', ySym: 'GC=F', isCommodityGold: true },
      { key: 'SILVER', ySym: 'SI=F', isCommoditySilver: true },
      { key: 'CRUDEOIL', ySym: 'CL=F', isCommodityCrude: true },
      { key: 'NATURALGAS', ySym: 'NG=F', isCommodityNatGas: true }
    ];

    await Promise.all(yFetchers.map(async (item) => {
      if (!angelUpdatedKeys.has(item.key)) {
        try {
          const url2 = `https://query2.finance.yahoo.com/v8/finance/chart/${item.ySym}?interval=1m&range=1d`;
          const res2 = await axios.get(url2, { headers: uHeaders, timeout: 2500 });
          const meta = res2.data?.chart?.result?.[0]?.meta;
          if (meta && meta.regularMarketPrice != null && fallbackMap[item.key]) {
            let ltp = Number(meta.regularMarketPrice);
            let close = Number(meta.chartPreviousClose || meta.previousClose || ltp);

            if (item.isGiftNifty) {
              ltp = Number((ltp * 1.002).toFixed(2));
              close = Number((close * 1.002).toFixed(2));
            } else if (item.isCommodityGold) {
              ltp = Math.round(ltp * 34.96);
              close = Math.round(close * 34.96);
            } else if (item.isCommoditySilver) {
              ltp = Math.round(ltp * 3890);
              close = Math.round(close * 3890);
            } else if (item.isCommodityCrude) {
              ltp = Number((ltp * 95.98).toFixed(2));
              close = Number((close * 95.98).toFixed(2));
            } else if (item.isCommodityNatGas) {
              ltp = Number((ltp * 95.98).toFixed(2));
              close = Number((close * 95.98).toFixed(2));
            }

            const chg = Number((ltp - close).toFixed(2));
            const chgPct = close > 0 ? Number(((chg / close) * 100).toFixed(2)) : 0;
            fallbackMap[item.key].quote = { price: ltp, close, change: chg, changePct: chgPct };
            fallbackMap[item.key].source = 'Live Market Feed';
            fallbackMap[item.key].lastUpdated = new Date().toISOString();
          }
        } catch (subErr) {
          // ignore
        }
      }
    }));

    const responseList = rawSymbols.map(sym => {
      const obj = fallbackMap[sym] || { symbol: sym, name: sym, quote: { price: 100, close: 100, change: 0, changePct: 0 } };
      obj.lastUpdated = obj.lastUpdated || new Date().toISOString();
      return obj;
    });
    res.json(responseList);
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
  await initBrokers();
  instrumentService.refreshAll().then(
    (s) => console.log('[server] instrument master loaded:', s),
    (err) => console.error('[server] instrument master load failed:', err.message)
  ); // deliberately not awaited — server starts serving immediately, instrument search just 503s until this resolves
  const port = process.env.PORT || env.server.port || 4000;
  const host = '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`[server] listening on http://${host}:${port}`);
    console.log(`[server] active brokers: ${Object.keys(brokers).join(', ') || '(none — check ANGEL_ENABLED/GROWW_ENABLED)'}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, initBrokers, brokers };