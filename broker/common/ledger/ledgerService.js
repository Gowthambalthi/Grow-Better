/**
 * common/ledger/ledgerService.js
 *
 * Records what the broker APIs don't track for you: buy date, MTF
 * borrowed-vs-paid breakdown, funds added/withdrawn history. Charges are
 * computed on the fly from each broker's own charges module — not stored,
 * so a rate-card update doesn't require rewriting history, and today's
 * "what would this cost now" always reflects the current constants.
 */

const db = require('../../db/db');
const angelCharges = require('../../angelone/charges');
const growwCharges = require('../../grow/charges');

function chargesModuleFor(broker) {
  return broker === 'angelone' ? angelCharges : growwCharges;
}

function daysBetween(dateA, dateB) {
  const ms = new Date(dateB).getTime() - new Date(dateA).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ---- Trades ----

/**
 * @param {object} trade {
 *   broker, tradingsymbol, exchange, transactionType, quantity, price,
 *   tradeDate ('YYYY-MM-DD'), productType, isMtf?, mtfMarginPaid?,
 *   orderId?, source? ('manual'|'live'), closedDate?, note?
 * }
 */
function recordTrade(trade) {
  const value = trade.quantity * trade.price;
  const isMtf = !!trade.isMtf;
  const mtfMarginPaid = isMtf ? trade.mtfMarginPaid : null;
  const mtfAmountBorrowed = isMtf && mtfMarginPaid != null ? value - mtfMarginPaid : null;
  const nowIso = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO trades (broker, tradingsymbol, exchange, transaction_type, quantity, price,
      trade_date, product_type, is_mtf, mtf_margin_paid, mtf_amount_borrowed, order_id, source, closed_date, note, created_at)
    VALUES (@broker, @tradingsymbol, @exchange, @transactionType, @quantity, @price,
      @tradeDate, @productType, @isMtf, @mtfMarginPaid, @mtfAmountBorrowed, @orderId, @source, @closedDate, @note, @createdAt)
  `);

  const result = stmt.run({
    broker: trade.broker,
    tradingsymbol: trade.tradingsymbol,
    exchange: trade.exchange,
    transactionType: trade.transactionType,
    quantity: trade.quantity,
    price: trade.price,
    tradeDate: trade.tradeDate,
    productType: trade.productType,
    isMtf: isMtf ? 1 : 0,
    mtfMarginPaid,
    mtfAmountBorrowed,
    orderId: trade.orderId || null,
    source: trade.source || 'manual',
    closedDate: trade.closedDate || null,
    note: trade.note || null,
    createdAt: nowIso,
  });

  return getTradeById(result.lastInsertRowid);
}

function getTradeById(id) {
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

function getTradeByOrderId(broker, orderId) {
  return db.prepare('SELECT * FROM trades WHERE broker = ? AND order_id = ?').get(broker, orderId);
}

function getTrades(broker, { isMtfOnly, tradingsymbol } = {}) {
  let query = 'SELECT * FROM trades WHERE broker = ?';
  const params = [broker];

  if (isMtfOnly) {
    query += ' AND is_mtf = 1 AND closed_date IS NULL';
  }

  if (tradingsymbol) {
    const cleanSym = tradingsymbol.replace('-EQ', '');
    query += ' AND (tradingsymbol = ? OR tradingsymbol = ?)';
    params.push(cleanSym, `${cleanSym}-EQ`);
  }

  query += ' ORDER BY trade_date DESC, id DESC';
  return db.prepare(query).all(...params);
}

/** Marks an MTF (or any) position as closed — stops interest accrual as of this date. */
function closeTrade(id, closedDate = new Date().toISOString().slice(0, 10)) {
  db.prepare('UPDATE trades SET closed_date = ? WHERE id = ?').run(closedDate, id);
}

/**
 * Calculates accrued MTF interest per trade for open MTF positions.
 * Interest starts accruing from T+1 of the buy date (0.041%/day = ~15%/yr),
 * computed as of today (or closed_date, if the position was closed).
 */
function getMtfSummary(broker) {
  const charges = chargesModuleFor(broker);
  const rows = db.prepare(`
    SELECT * FROM trades
    WHERE broker = ? AND is_mtf = 1 AND transaction_type = 'BUY'
    ORDER BY trade_date DESC
  `).all(broker);

  const today = new Date().toISOString().slice(0, 10);

  return rows.map((row) => {
    const asOf = row.closed_date || today;
    // Interest starts accruing from T+1 of the buy date, per both brokers' published terms.
    const buyDatePlus1 = new Date(row.trade_date);
    buyDatePlus1.setDate(buyDatePlus1.getDate() + 1);
    const daysHeld = Math.max(0, daysBetween(buyDatePlus1.toISOString().slice(0, 10), asOf));

    const borrowed = row.mtf_amount_borrowed || 0;
    const interestAccrued = charges.calculateMtfInterest(borrowed, daysHeld);
    const tradeCharges = charges.calculateTradeCharges({
      transactionType: 'BUY',
      productType: 'MARGIN',
      quantity: row.quantity,
      price: row.price,
    });

    return {
      ...row,
      daysHeld,
      interestAccrued,
      entryCharges: tradeCharges.totalCharges,
      isOpen: !row.closed_date,
    };
  });
}

/**
 * Calculates total historical brokerage charges & total MTF interest accrued
 * across ALL trades in the ledger (both active open holdings and closed/sold trades).
 * Closed positions stop accruing MTF interest on their closed_date!
 */
function getHistoricalChargesAndMtf(broker) {
  const charges = chargesModuleFor(broker);
  const trades = db.prepare('SELECT * FROM trades WHERE broker = ?').all(broker);
  const today = new Date().toISOString().slice(0, 10);

  let totalMtfInterest = 0;
  let totalTradeCharges = 0;

  for (const t of trades) {
    // 1. Calculate MTF Interest if position is MTF
    if (t.is_mtf && t.transaction_type === 'BUY') {
      const asOf = t.closed_date || today;
      const buyDatePlus1 = new Date(t.trade_date);
      buyDatePlus1.setDate(buyDatePlus1.getDate() + 1);
      const daysHeld = Math.max(0, daysBetween(buyDatePlus1.toISOString().slice(0, 10), asOf));
      const borrowed = t.mtf_amount_borrowed || 0;
      totalMtfInterest += charges.calculateMtfInterest(borrowed, daysHeld);
    }

    // 2. Calculate Brokerage & Transaction Charges for Buy order
    const buyChg = charges.calculateTradeCharges({
      transactionType: t.transaction_type,
      productType: t.product_type || (t.is_mtf ? 'MARGIN' : 'DELIVERY'),
      quantity: t.quantity,
      price: t.price,
    });
    totalTradeCharges += buyChg.totalCharges;

    // 3. If closed/sold, calculate Sell order charges as well!
    if (t.closed_date) {
      const sellChg = charges.calculateTradeCharges({
        transactionType: t.transaction_type === 'BUY' ? 'SELL' : 'BUY',
        productType: t.product_type || (t.is_mtf ? 'MARGIN' : 'DELIVERY'),
        quantity: t.quantity,
        price: t.price,
      });
      totalTradeCharges += sellChg.totalCharges;
    }
  }

  return { totalMtfInterest, totalTradeCharges };
}

// ---- Funds ----

function recordFundsTransaction({ broker, type, amount, txnDate, note }) {
  const nowIso = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO funds_transactions (broker, type, amount, txn_date, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(broker, type, amount, txnDate, note || null, nowIso);
  return db.prepare('SELECT * FROM funds_transactions WHERE id = ?').get(result.lastInsertRowid);
}

function getFundsTransactions(broker) {
  return db.prepare('SELECT * FROM funds_transactions WHERE broker = ? ORDER BY txn_date ASC, id ASC').all(broker);
}

function getFundsNetTotal(broker) {
  const txns = getFundsTransactions(broker);
  const totalAdded = txns.filter((t) => t.type === 'ADD').reduce((sum, t) => sum + t.amount, 0);
  const totalWithdrawn = txns.filter((t) => t.type === 'WITHDRAW').reduce((sum, t) => sum + t.amount, 0);
  return { totalAdded, totalWithdrawn, netTotal: totalAdded - totalWithdrawn };
}

function deleteFundsTransaction(id) {
  db.prepare('DELETE FROM funds_transactions WHERE id = ?').run(id);
}

// ---- Charges (on-demand, for a trade not yet recorded) ----

function estimateCharges(broker, tradeParams) {
  return chargesModuleFor(broker).calculateTradeCharges(tradeParams);
}

/**
 * Updates or backfills buy date, MTF ratio, leverage multiplier, and margin breakdown for a holding.
 */
function updateHoldingSettings({ broker, tradingsymbol, exchange, quantity, avgPrice, tradeDate, isMtf, mtfMarginRatio, mtfLeverage }) {
  const cleanSym = tradingsymbol.replace('-EQ', '');
  const existing = db.prepare('SELECT * FROM trades WHERE broker = ? AND (tradingsymbol = ? OR tradingsymbol = ?) AND closed_date IS NULL').get(broker, cleanSym, `${cleanSym}-EQ`);
  
  if (existing) {
    db.prepare(`
      UPDATE trades
      SET quantity = ?, price = ?, trade_date = ?, is_mtf = ?,
          mtf_margin_paid = ?, mtf_amount_borrowed = ?
      WHERE id = ?
    `).run(
      quantity,
      avgPrice,
      tradeDate,
      isMtf ? 1 : 0,
      isMtf && mtfMarginRatio ? (quantity * avgPrice * mtfMarginRatio) : null,
      isMtf && mtfMarginRatio ? (quantity * avgPrice * (1 - mtfMarginRatio)) : null,
      existing.id
    );
    return getTradeById(existing.id);
  }

  return recordTrade({
    broker,
    tradingsymbol: cleanSym,
    exchange: exchange || 'NSE',
    transactionType: 'BUY',
    quantity,
    price: avgPrice,
    tradeDate,
    productType: isMtf ? 'MARGIN' : 'DELIVERY',
    isMtf,
    mtfMarginPaid: isMtf && mtfMarginRatio ? (quantity * avgPrice * mtfMarginRatio) : null,
  });
}

function getBrokerOverride(broker) {
  return db.prepare('SELECT * FROM broker_overrides WHERE broker = ?').get(broker) || { broker, custom_charges: null, custom_mtf_interest: null };
}

function setBrokerOverride(broker, { customCharges, customMtfInterest }) {
  const existing = db.prepare('SELECT broker FROM broker_overrides WHERE broker = ?').get(broker);
  const nowIso = new Date().toISOString();
  if (existing) {
    if (customCharges !== undefined) db.prepare('UPDATE broker_overrides SET custom_charges = ?, updated_at = ? WHERE broker = ?').run(customCharges, nowIso, broker);
    if (customMtfInterest !== undefined) db.prepare('UPDATE broker_overrides SET custom_mtf_interest = ?, updated_at = ? WHERE broker = ?').run(customMtfInterest, nowIso, broker);
  } else {
    db.prepare('INSERT INTO broker_overrides (broker, custom_charges, custom_mtf_interest, updated_at) VALUES (?, ?, ?, ?)').run(broker, customCharges !== undefined ? customCharges : null, customMtfInterest !== undefined ? customMtfInterest : null, nowIso);
  }
  return getBrokerOverride(broker);
}

module.exports = {
  recordTrade,
  getTradeById,
  getTradeByOrderId,
  getTrades,
  closeTrade,
  getMtfSummary,
  getHistoricalChargesAndMtf,
  recordFundsTransaction,
  deleteFundsTransaction,
  getFundsTransactions,
  getFundsNetTotal,
  estimateCharges,
  updateHoldingSettings,
  getBrokerOverride,
  setBrokerOverride,
};