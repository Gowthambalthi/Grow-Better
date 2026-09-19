/**
 * common/portfolio/portfolioService.js
 *
 * Per-stock live P&L for the portfolio page. Combines:
 *  - live holdings (quantity, avg price) + live price from each broker API
 *  - MTF borrowed/paid + accrued interest from the ledger
 *  - estimated buy + sell charges from each broker's own charges module
 */

const AngelHoldings = require('../../angelone/holdings');
const angelCharges = require('../../angelone/charges');
const GrowwHoldings = require('../../grow/holdings');
const growwCharges = require('../../grow/charges');
const angelInstruments = require('../instruments/angelInstruments');
const angelMarketQuote = require('../../angelone/marketQuote');
const env = require('../../config/env');
const axios = require('axios');
const ledger = require('../ledger/ledgerService');
const institutionalService = require('../institutional/institutionalService');
const liveQuoteEngine = require('../market/liveQuoteEngine');

// Live-only price caches. These used to be seeded with hardcoded CUPID/EMMVEE/
// RELIANCE numbers, which meant the portfolio displayed invented prices whenever
// the broker feed was down. They are now populated exclusively by real ticks and
// quotes; an empty cache falls through to the live quote and then to the average
// buy price, never to a made-up constant.
const LAST_TRADED_MARKET_PRICES = {};

const PREVIOUS_CLOSE_PRICES = {};

const TOKEN_TO_SYMBOL = {
  '1660': 'CUPID',
  '2885': 'RELIANCE',
  '9817': 'EMMVEE',
  '18652': 'SHRIRAMFIN',
};

function updateLiveLtpFromWs(token, ltp, close) {
  const sym = TOKEN_TO_SYMBOL[String(token)];
  if (sym && ltp > 0) {
    LAST_TRADED_MARKET_PRICES[sym] = Number(ltp);
    LAST_TRADED_MARKET_PRICES[`${sym}-EQ`] = Number(ltp);
    if (close > 0) {
      PREVIOUS_CLOSE_PRICES[sym] = Number(close);
      PREVIOUS_CLOSE_PRICES[`${sym}-EQ`] = Number(close);
    }
  }
}

function resolveLastTradedPrice(symbol, liveLtp, defaultPrice) {
  const clean = (symbol || '').replace('-EQ', '').trim().toUpperCase();
  const nLive = Number(liveLtp);

  if (liveLtp != null && !isNaN(nLive) && nLive > 0) {
    LAST_TRADED_MARKET_PRICES[clean] = nLive;
    LAST_TRADED_MARKET_PRICES[`${clean}-EQ`] = nLive;
    return nLive;
  }

  if (LAST_TRADED_MARKET_PRICES[clean] && LAST_TRADED_MARKET_PRICES[clean] > 0) {
    return LAST_TRADED_MARKET_PRICES[clean];
  }

  const nDefault = Number(defaultPrice);
  if (!isNaN(nDefault) && nDefault > 0) {
    return nDefault;
  }

  return 0;
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return (numerator / denominator) * 100;
}

function daysBetween(dateA, dateB) {
  const ms = new Date(dateB).getTime() - new Date(dateA).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

/** Finds this symbol's ledger trade history to determine buy date, MTF split, weighted days held, and remaining unassigned qty. */
function ledgerContextFor(broker, tradingsymbol, totalQuantity = 0) {
  const cleanSym = (tradingsymbol || '').replace('-EQ', '').trim().toUpperCase();
  const allTrades = ledger.getTrades(broker);
  const trades = allTrades.filter((t) => {
    const tClean = (t.tradingsymbol || '').replace('-EQ', '').trim().toUpperCase();
    return tClean === cleanSym;
  });
  const openBuys = trades.filter((t) => t.transaction_type === 'BUY' && !t.closed_date);

  const todayStr = new Date().toISOString().slice(0, 10);
  const chargesModule = broker === 'angelone' ? angelCharges : growwCharges;

  let totalAssignedQty = 0;
  let weightedDaysSum = 0;
  let mtfBorrowed = 0;
  let mtfInterestAccrued = 0;
  let isMtf = false;
  let earliestBuyDate = todayStr;

  if (openBuys.length > 0) {
    earliestBuyDate = openBuys.reduce((min, t) => (t.trade_date < min ? t.trade_date : min), openBuys[0].trade_date);
    for (const t of openBuys) {
      const q = Number(t.quantity) || 0;
      totalAssignedQty += q;
      const days = Math.max(0, daysBetween(t.trade_date, todayStr));
      weightedDaysSum += (q * days);

      if (t.is_mtf) {
        isMtf = true;
        const borrowed = t.mtf_amount_borrowed || 0;
        mtfBorrowed += borrowed;
        const buyPlus1 = new Date(t.trade_date);
        buyPlus1.setDate(buyPlus1.getDate() + 1);
        const heldDays = Math.max(0, daysBetween(buyPlus1.toISOString().slice(0, 10), todayStr));
        mtfInterestAccrued += chargesModule.calculateMtfInterest(borrowed, heldDays);
      }
    }
  }

  const daysHeld = totalAssignedQty > 0 ? Math.round(weightedDaysSum / totalAssignedQty) : Math.max(0, daysBetween(earliestBuyDate, todayStr));
  const isFullyConfigured = totalQuantity > 0 ? totalAssignedQty >= totalQuantity : openBuys.length > 0;
  const remainingQty = totalQuantity > 0 ? Math.max(0, totalQuantity - totalAssignedQty) : 0;

  return { earliestBuyDate, daysHeld, isMtf, mtfBorrowed, mtfInterestAccrued, totalAssignedQty, remainingQty, isFullyConfigured, hasLedgerRecord: openBuys.length > 0, openBuys };
}

function buildRow(broker, { tradingsymbol, exchange, quantity, avgPrice, ltp, close, open }) {
  const chargesModule = broker === 'angelone' ? angelCharges : growwCharges;
  const ctx = ledgerContextFor(broker, tradingsymbol, quantity);
  const cleanSym = (tradingsymbol || '').replace('-EQ', '').toUpperCase();

  // MTF status and interest come from the ledger's actual records only. They used
  // to be inferred from the symbol name (a hardcoded "EMMVEE and RELIANCE are MTF"
  // rule plus a made-up leverage table and fabricated holding periods), which
  // charged imaginary interest against positions that may not exist at all.
  // A position with no ledger record is plain delivery with no accrued interest.
  const isMtfPosition = !!ctx.isMtf && ctx.mtfBorrowed > 0;
  const daysHeld = ctx.daysHeld || 0;

  let mtfInterestToDeduct = 0;
  let borrowedAmt = 0;

  if (isMtfPosition) {
    borrowedAmt = ctx.mtfBorrowed;
    mtfInterestToDeduct = Math.max(0, ctx.mtfInterestAccrued || 0);
  }

  const productType = isMtfPosition ? 'MARGIN' : 'DELIVERY';

  // Sanitize LTP against stale or unadjusted broker holdings feeds
  let actualLtp = resolveLastTradedPrice(cleanSym, ltp, avgPrice);

  const investedAmount = quantity * avgPrice;
  const currentAmount = quantity * actualLtp;
  const overallPL = currentAmount - investedAmount;
  const overallPLPercent = pct(overallPL, investedAmount);

  let todayPLAmount = 0;

  const istDateStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const istDate = new Date(istDateStr);
  const istMinutes = istDate.getHours() * 60 + istDate.getMinutes();
  const isPreMarketAfterMidnight = istMinutes < 555; // 00:00 to 09:15 AM IST

  if (!isPreMarketAfterMidnight) {
    let prevClose = null;
    if (close != null && Number(close) > 0) {
      prevClose = Number(close);
    } else if (open != null && Number(open) > 0) {
      prevClose = Number(open);
    } else if (PREVIOUS_CLOSE_PRICES[cleanSym] && PREVIOUS_CLOSE_PRICES[cleanSym] > 0) {
      prevClose = PREVIOUS_CLOSE_PRICES[cleanSym];
    }

    if (prevClose != null && prevClose > 0) {
      // Standard broker Day's P&L: (LTP - PrevClose) * Quantity
      todayPLAmount = (actualLtp - prevClose) * quantity;
      var calculatedTodayPLPercent = ((actualLtp - prevClose) / prevClose) * 100;
    } else {
      todayPLAmount = (actualLtp - avgPrice) * quantity;
    }
  }

  const todayPLPercent = typeof calculatedTodayPLPercent !== 'undefined' ? calculatedTodayPLPercent : (investedAmount > 0 ? (todayPLAmount / investedAmount) * 100 : 0);

  const buyCharges = chargesModule.calculateTradeCharges({
    transactionType: 'BUY', productType, quantity, price: avgPrice,
  }).totalCharges;
  const estimatedSellCharges = chargesModule.calculateTradeCharges({
    transactionType: 'SELL', productType, quantity, price: actualLtp,
  }).totalCharges;

  const netPL = overallPL - buyCharges - estimatedSellCharges - mtfInterestToDeduct;
  const netPLPercent = pct(netPL, investedAmount);
  const grossPL = overallPL;
  const grossPLPercent = overallPLPercent;

  return {
    broker,
    tradingsymbol,
    exchange,
    quantity,
    avgPrice,
    ltp: actualLtp,
    investedAmount,
    currentAmount,
    overallPL: netPL,
    overallPLPercent: netPLPercent,
    rawOverallPL: overallPL,
    rawOverallPLPercent: overallPLPercent,
    todayPL: todayPLAmount,
    todayPLPercent,
    isMtf: isMtfPosition,
    mtfBorrowed: borrowedAmt,
    mtfInterestAccrued: isMtfPosition ? mtfInterestToDeduct : 0,
    buyCharges,
    estimatedSellCharges,
    netPL,
    netPLPercent,
    grossPL,
    grossPLPercent,
    daysHeld,
    buyDateKnown: ctx.hasLedgerRecord,
    isFullyConfigured: ctx.isFullyConfigured,
    remainingQty: ctx.remainingQty,
    institutional: institutionalService.getInstitutionalSummaryForSymbol(tradingsymbol),
  };
}

async function fetchAngelLiveQuotes(holdingsList, angelSession) {
  const bySymbol = {};
  if (!angelSession || !holdingsList.length) return bySymbol;

  const tokensByExch = {};
  const tokenToSymbol = {};

  for (const h of holdingsList) {
    const rawSymbol = h.tradingsymbol || h.trading_symbol || h.tradingSymbol || h.symbol;
    if (!rawSymbol) continue;
    const cleanSym = rawSymbol.replace('-EQ', '');

    let rec;
    try {
      rec = angelInstruments.findEquity(cleanSym, 'NSE') || angelInstruments.findEquity(cleanSym, 'BSE') || angelInstruments.findEquity(rawSymbol, 'NSE');
    } catch (e) {}
    if (!rec) continue;

    (tokensByExch[rec.exch_seg] ||= []).push(rec.token);
    tokenToSymbol[`${rec.exch_seg}:${rec.token}`] = rawSymbol;
    tokenToSymbol[`${rec.exch_seg}:${rec.token}:clean`] = cleanSym;
  }

  if (Object.keys(tokensByExch).length === 0) return bySymbol;

  try {
    const fetched = await angelMarketQuote.getQuote(angelSession, tokensByExch, 'FULL');
    for (const q of fetched) {
      const token = q.symbolToken || q.symboltoken || q.token;
      const exch = q.exchange || q.exch_seg || 'NSE';
      const ltp = q.ltp != null ? Number(q.ltp) : (q.last_price != null ? Number(q.last_price) : null);
      const close = q.close != null ? Number(q.close) : (q.closePrice != null ? Number(q.closePrice) : null);
      const open = q.open != null ? Number(q.open) : (q.openPrice != null ? Number(q.openPrice) : null);

      const sym = tokenToSymbol[`${exch}:${token}`] || tokenToSymbol[`${exch}:${token}:clean`];
      if (!sym || ltp == null) continue;

      const qObj = {
        last_price: ltp,
        open: open,
        close: close != null ? close : ltp,
        day_change: close != null ? ltp - close : (q.day_change != null ? Number(q.day_change) : 0),
        __exchange: exch,
      };
      bySymbol[sym] = qObj;
      bySymbol[sym.replace('-EQ', '')] = qObj;
    }
  } catch (err) {
    console.error('[portfolioService] Angel One live quote fetch error:', err.message);
  }

  return bySymbol;
}

/**
 * Live holdings only. If the broker session is missing or the live call fails we
 * return an EMPTY list — never a cached, ledger-derived or hardcoded position.
 *
 * History: this function used to fall back to open BUY rows in the ledger DB and,
 * failing that, to three hardcoded rows ("matching Angel One terminal screenshot")
 * for CUPID/EMMVEE/RELIANCE. That is why the portfolio displayed holdings the user
 * did not own whenever the broker was disconnected. Removed deliberately: showing
 * nothing is correct, showing a fabricated position is not.
 */
/**
 * Per-broker holdings health, for the UI to distinguish three very different
 * states that all render as an empty table otherwise:
 *   connected=false            → we have no broker session at all
 *   ok=false, connected=true   → session exists but the fetch failed (auth/limits)
 *   ok=true, rows=0            → genuinely holding nothing
 */
const HOLDINGS_STATUS = {
  angelone: { connected: false, ok: false, error: null },
  groww: { connected: false, ok: false, error: null },
};

function setHoldingsStatus(broker, patch) {
  HOLDINGS_STATUS[broker] = { ...HOLDINGS_STATUS[broker], ...patch };
}

function getHoldingsStatus(broker) {
  return HOLDINGS_STATUS[broker] || { connected: false, ok: false, error: null };
}

async function getAngelPortfolio(session) {
  if (!session) {
    console.warn('[portfolioService] Angel One: no live session — showing no holdings (fabricated fallbacks removed)');
    setHoldingsStatus('angelone', { connected: false, ok: false, error: 'no live session' });
    return [];
  }

  let liveRows = [];
  try {
    const holdings = new AngelHoldings(session);
    liveRows = await holdings.getHoldings();
    setHoldingsStatus('angelone', { connected: true, ok: true, error: null });
  } catch (err) {
    console.error('[portfolioService] Angel One live holdings call error:', err.message);
    setHoldingsStatus('angelone', { connected: true, ok: false, error: err.message });
    return [];
  }

  const mergedMap = new Map();

  // Live broker data is the only source of truth for what is held.
  for (const h of (Array.isArray(liveRows) ? liveRows : [])) {
    const rawSym = h.tradingsymbol || h.symbol || '';
    const cleanSym = rawSym.replace('-EQ', '');
    if (!cleanSym) continue;

    mergedMap.set(cleanSym, {
      tradingsymbol: cleanSym,
      exchange: h.exchange || 'NSE',
      quantity: Number(h.quantity || h.netquantity || 0),
      avgPrice: Number(h.averageprice || h.price || h.avgprice || 0),
      ltp: Number(h.ltp || h.averageprice || 0),
      close: h.close != null ? Number(h.close) : null,
    });
  }

  const holdingsList = Array.from(mergedMap.values());
  holdingsList.sort((a, b) => (a.tradingsymbol || '').localeCompare(b.tradingsymbol || ''));
  if (holdingsList.length === 0) return [];

  const liveQuotes = await fetchAngelLiveQuotes(holdingsList, session);
  const symbolList = holdingsList.map(h => h.tradingsymbol || h.symbol);
  const multiQuotes = await liveQuoteEngine.fetchStockQuotes(symbolList);

  return holdingsList.filter((h) => h.quantity > 0).map((h) => {
    const sym = h.tradingsymbol;
    const cleanSym = (sym || '').replace('-EQ', '');
    const q = liveQuotes[sym] || liveQuotes[cleanSym] || multiQuotes[sym] || multiQuotes[cleanSym];

    const rawLtp = q && (q.last_price != null ? q.last_price : q.ltp);
    const ltp = resolveLastTradedPrice(sym, rawLtp, h.ltp || h.avgPrice);

    const rawClose = q && q.close != null ? q.close : multiQuotes[cleanSym]?.close;
    if (rawClose != null && rawClose > 0) {
      PREVIOUS_CLOSE_PRICES[cleanSym] = Number(rawClose);
      PREVIOUS_CLOSE_PRICES[`${cleanSym}-EQ`] = Number(rawClose);
    }
    const close = rawClose != null ? Number(rawClose) : (PREVIOUS_CLOSE_PRICES[cleanSym] || ltp);
    const open = q && q.open != null ? q.open : h.open;

    return buildRow('angelone', {
      tradingsymbol: sym,
      exchange: h.exchange || 'NSE',
      quantity: h.quantity,
      avgPrice: h.avgPrice,
      ltp: ltp,
      close: close,
      open: open,
    });
  });
}

/** Groww holdings — live only, same rule as Angel One: no session or a failed call means no rows. */
async function getGrowwPortfolio(growwSession, angelSession) {
  if (!growwSession) {
    console.warn('[portfolioService] Groww: no live session — showing no holdings (fabricated fallbacks removed)');
    setHoldingsStatus('groww', { connected: false, ok: false, error: 'no live session' });
    return [];
  }

  let liveRows = [];
  try {
    const holdings = new GrowwHoldings(growwSession);
    liveRows = await holdings.getHoldings();
    setHoldingsStatus('groww', { connected: true, ok: true, error: null });
  } catch (err) {
    console.error('[portfolioService] Groww live holdings call error:', err.message);
    setHoldingsStatus('groww', { connected: true, ok: false, error: err.message });
    return [];
  }

  const mergedMap = new Map();

  for (const h of (Array.isArray(liveRows) ? liveRows : [])) {
    const sym = h.trading_symbol || h.tradingSymbol || h.symbol;
    if (!sym) continue;
    mergedMap.set(sym, {
      trading_symbol: sym,
      quantity: Number(h.quantity || 0),
      average_price: Number(h.average_price || h.averagePrice || 0),
      ltp: Number(h.last_price || h.average_price || 0),
      tradable_exchanges: h.tradable_exchanges || ['NSE'],
    });
  }

  const holdingsList = Array.from(mergedMap.values()).filter(h => Number(h.quantity) > 0);
  holdingsList.sort((a, b) => (a.trading_symbol || '').localeCompare(b.trading_symbol || ''));
  if (holdingsList.length === 0) return [];

  let angelQuotes = {};
  if (angelSession) {
    angelQuotes = await fetchAngelLiveQuotes(holdingsList, angelSession);
  }

  const symbolList = holdingsList.map(h => h.trading_symbol || h.symbol);
  const multiQuotes = await liveQuoteEngine.fetchStockQuotes(symbolList);

  return holdingsList.map((h) => {
    const symbol = h.trading_symbol || h.tradingSymbol;
    const cleanSym = symbol.replace('-EQ', '');
    const q = angelQuotes[symbol] || angelQuotes[cleanSym] || multiQuotes[symbol] || multiQuotes[cleanSym];

    const rawLtp = q && (q.last_price != null ? q.last_price : q.ltp);
    const ltp = resolveLastTradedPrice(cleanSym, rawLtp, Number(h.average_price || 0));

    const rawClose = q && q.close != null ? q.close : multiQuotes[cleanSym]?.close;
    if (rawClose != null && rawClose > 0) {
      PREVIOUS_CLOSE_PRICES[cleanSym] = Number(rawClose);
      PREVIOUS_CLOSE_PRICES[`${cleanSym}-EQ`] = Number(rawClose);
    }
    const close = rawClose != null ? Number(rawClose) : (PREVIOUS_CLOSE_PRICES[cleanSym] || ltp);

    return buildRow('groww', {
      tradingsymbol: symbol,
      exchange: (h.tradable_exchanges && h.tradable_exchanges[0]) || 'NSE',
      quantity: Number(h.quantity),
      avgPrice: Number(h.average_price),
      ltp: ltp,
      close: close,
    });
  });
}

function calculateXirr(cashFlows) {
  if (!cashFlows || cashFlows.length < 2) return 0;
  const firstDate = cashFlows[0].date.getTime();

  function npv(rate) {
    if (rate <= -0.999) return 1e9;
    let sum = 0;
    for (const cf of cashFlows) {
      const years = (cf.date.getTime() - firstDate) / (1000 * 60 * 60 * 24 * 365.25);
      sum += cf.amount / Math.pow(1 + rate, years);
    }
    return sum;
  }

  let low = -0.99;
  let high = 5.0;
  const fLow = npv(low);
  const fHigh = npv(high);

  if (isNaN(fLow) || isNaN(fHigh) || fLow * fHigh > 0) {
    const totalInflow = cashFlows.filter((c) => c.amount < 0).reduce((s, c) => s - c.amount, 0);
    const terminalVal = cashFlows[cashFlows.length - 1].amount;
    if (!totalInflow) return 0;
    return ((terminalVal - totalInflow) / totalInflow) * 100;
  }

  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-4) return mid * 100;
    if (npv(low) * fMid < 0) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return ((low + high) / 2) * 100;
}

function summarize(rows, broker = 'combined', liveCash = null) {
  const valid = rows.filter((r) => !r.error);

  const investedAmount = valid.reduce((s, r) => s + (r.investedAmount || 0), 0);
  const currentAmount = valid.reduce((s, r) => s + (r.currentAmount || 0), 0);
  const netPL = valid.reduce((s, r) => s + (r.netPL != null ? r.netPL : (r.overallPL || 0)), 0);
  const rawOverallPL = valid.reduce((s, r) => s + (r.rawOverallPL != null ? r.rawOverallPL : (r.grossPL != null ? r.grossPL : (r.overallPL || 0))), 0);
  const overallPL = netPL;
  const overallPLPercent = investedAmount > 0 ? (overallPL / investedAmount) * 100 : 0;

  const todayPL = valid.reduce((s, r) => s + (r.todayPL || 0), 0);
  const prevDayPortfolioValue = currentAmount - todayPL;
  const todayPLPercent = prevDayPortfolioValue > 0 ? (todayPL / prevDayPortfolioValue) * 100 : (investedAmount > 0 ? (todayPL / investedAmount) * 100 : 0);
  const grossPL = rawOverallPL;
  const mtfInterestAccrued = valid.reduce((s, r) => s + (r.mtfInterestAccrued || 0), 0);
  const totalMtfBorrowed = valid.reduce((s, r) => s + (r.mtfBorrowed || 0), 0);
  const totalBuyCharges = valid.reduce((s, r) => s + (r.buyCharges || 0), 0);
  const totalSellCharges = valid.reduce((s, r) => s + (r.estimatedSellCharges || 0), 0);

  let totalAdded = 0;
  let totalWithdrawn = 0;
  let fundsTxns = [];

  if (broker === 'combined') {
    const angelNet = ledger.getFundsNetTotal('angelone');
    const growwNet = ledger.getFundsNetTotal('groww');
    totalAdded = (angelNet.totalAdded || 0) + (growwNet.totalAdded || 0);
    totalWithdrawn = (angelNet.totalWithdrawn || 0) + (growwNet.totalWithdrawn || 0);
    fundsTxns = [...ledger.getFundsTransactions('angelone'), ...ledger.getFundsTransactions('groww')];
  } else {
    const brokerNet = ledger.getFundsNetTotal(broker);
    totalAdded = brokerNet.totalAdded || 0;
    totalWithdrawn = brokerNet.totalWithdrawn || 0;
    fundsTxns = ledger.getFundsTransactions(broker);
  }

  const rawNetDeposits = totalAdded - totalWithdrawn;

  // Cash comes from the broker's live funds API or not at all. It used to default
  // to hardcoded per-broker balances (₹788.69 / ₹134.21 / ₹922.90), so an offline
  // broker still showed a confident — and invented — cash figure. `cashBalance` is
  // now null when unknown (the UI renders "—"), while the arithmetic below uses 0
  // so derived totals stay finite.
  const cashBalance = (liveCash != null && !isNaN(Number(liveCash))) ? Number(liveCash) : null;
  const cashForMath = cashBalance != null ? cashBalance : 0;

  const effectiveNetDeposits = (totalAdded > 0 || totalWithdrawn > 0) ? rawNetDeposits : (investedAmount - totalMtfBorrowed + cashForMath);
  const currentPortfolioEquity = currentAmount - totalMtfBorrowed;
  const accountEquity = currentAmount + cashForMath - totalMtfBorrowed;

  const ownCapitalInvested = investedAmount - totalMtfBorrowed;
  const cashInvested = investedAmount;
  const effectiveTotalAdded = totalAdded > 0 ? totalAdded : (cashInvested + cashForMath + (totalWithdrawn > 0 ? totalWithdrawn : 0));
  const accountPL = effectiveTotalAdded - totalWithdrawn - cashForMath - cashInvested;

  let effectiveNetCharges = 0;
  let effectiveMtfInterest = 0;

  const getBrokerChargesAndMtf = (bName) => {
    const ov = ledger.getBrokerOverride(bName);
    const hist = ledger.getHistoricalChargesAndMtf(bName);

    const baseCharges = ov.custom_charges != null ? Number(ov.custom_charges) : 0;
    const baseMtfInt = ov.custom_mtf_interest != null ? Number(ov.custom_mtf_interest) : 0;

    return {
      netChg: baseCharges + hist.totalTradeCharges,
      mtfInt: baseMtfInt + hist.totalMtfInterest,
    };
  };

  if (broker === 'combined') {
    const aRes = getBrokerChargesAndMtf('angelone');
    const gRes = getBrokerChargesAndMtf('groww');
    effectiveNetCharges = aRes.netChg + gRes.netChg;
    effectiveMtfInterest = aRes.mtfInt + gRes.mtfInt;
  } else {
    const res = getBrokerChargesAndMtf(broker);
    effectiveNetCharges = res.netChg;
    effectiveMtfInterest = res.mtfInt;
  }

  const totalAccruedCharges = effectiveNetCharges + effectiveMtfInterest;
  const adjustedAccountPL = effectiveNetDeposits - cashForMath - totalAccruedCharges;

  // With no live holdings, "account P&L" degenerates into echoing the ledger's net
  // deposits back as profit (deposits − cash, with nothing invested). That is not a
  // P&L — it is unaccounted capital — so report it as unknown rather than a number
  // that looks like a ₹10k gain on an empty portfolio.
  const plKnown = valid.length > 0;
  const accountPLOut = plKnown ? accountPL : null;
  const adjustedAccountPLOut = plKnown ? adjustedAccountPL : null;

  const maxDaysHeld = valid.length > 0 ? Math.max(...valid.map((r) => r.daysHeld || 0), 1) : 0;
  const accountReturnPercent = (plKnown && effectiveNetDeposits > 0) ? (accountPL / effectiveNetDeposits) * 100 : null;
  const cagr = accountReturnPercent;

  const cashFlows = fundsTxns.map((t) => ({
    amount: t.type === 'ADD' ? -t.amount : t.amount,
    date: new Date(t.txn_date),
  }));
  if (cashFlows.length === 0) {
    cashFlows.push({ amount: -effectiveNetDeposits, date: new Date(Date.now() - maxDaysHeld * 24 * 60 * 60 * 1000) });
  }
  cashFlows.push({ amount: accountEquity, date: new Date() });

  const totalInflow = ownCapitalInvested || investedAmount || effectiveNetDeposits;
  let xirr = 0;
  if (maxDaysHeld < 365 && totalInflow > 0) {
    xirr = (overallPL / totalInflow) * 100;
  } else {
    xirr = calculateXirr(cashFlows);
  }

  const uninvestedLedgerCash = cashForMath;
  const absorbedCapital = effectiveNetDeposits - ownCapitalInvested - uninvestedLedgerCash;
  const unadjustedNetFormula = accountPL;

  return {
    investedAmount,
    currentAmount,
    overallPL,
    netPL: overallPL,
    rawOverallPL: grossPL,
    todayPL,
    grossPL,
    mtfInterestAccrued,
    totalMtfBorrowed,
    totalBuyCharges,
    totalSellCharges,
    totalAccruedCharges,
    effectiveNetCharges,
    effectiveMtfInterest,
    totalAdded,
    totalWithdrawn,
    netDeposits: effectiveNetDeposits,
    ownCapitalInvested,
    uninvestedLedgerCash,
    absorbedCapital,
    unadjustedNetFormula,
    cashBalance,
    currentHoldingsEquity: currentPortfolioEquity,
    accountEquity,
    accountPL: accountPLOut,
    adjustedAccountPL: adjustedAccountPLOut,
    unreflectedCosts: totalAccruedCharges,
    xirr,
    cagr,
    accountReturnPercent,
    maxDaysHeld,
    holdingsCount: rows.length,
    errorCount: rows.length - valid.length,
  };
}

module.exports = { getAngelPortfolio, getGrowwPortfolio, summarize, updateLiveLtpFromWs, getHoldingsStatus };