/**
 * common/ledger/autoRecorder.js
 *
 * Listens to each broker's 'orderUpdate' events (from broker.js
 * subscribeOrderUpdates()) and auto-records completed fills into the
 * ledger with today's/the fill's date — so new buys get a date
 * automatically, the way old backfilled buys need one typed in by hand.
 *
 * IMPORTANT ASYMMETRY BETWEEN THE TWO BROKERS:
 * - Groww: the order-list fields are fully confirmed from their official
 *   docs (filled_quantity, remaining_quantity, average_fill_price, etc.),
 *   so this can reliably detect a genuine fill and extract real values.
 * - Angel One: their order-update WEBSOCKET payload schema is NOT fully
 *   documented anywhere I could confirm — only one sample field
 *   ("user-id") appears in their own forum post. This module tries the
 *   field names Angel uses in their REST order-book responses (a
 *   reasonable guess, since brokers usually reuse field names across
 *   REST/WS), but if those don't match what actually arrives, it will
 *   NOT record a fabricated trade — it logs the raw payload and skips,
 *   so you can inspect it and tell me the real field names to fix this.
 *   That's the "if any issue, it doesn't just silently invent a date"
 *   behavior — nothing pops up asking, since there's no frontend, but
 *   the trade simply won't appear until entered via POST /ledger/trades.
 */

const ledger = require('./ledgerService');

function isoDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

// ---- Groww: fields confirmed from https://groww.in/trade-api/docs/curl/orders ----
function tryRecordGroww(order) {
  const {
    groww_order_id: orderId,
    trading_symbol: tradingsymbol,
    exchange,
    transaction_type: transactionType,
    product, // 'CNC' | 'MIS' | 'MTF'
    filled_quantity: filledQuantity,
    remaining_quantity: remainingQuantity,
    average_fill_price: avgPrice,
    price,
    created_at: createdAt,
    trade_date: tradeDate,
  } = order;

  // Only record once an order is actually (fully) filled — remaining_quantity
  // reaching 0 with filled_quantity > 0 is the numeric signal confirmed in
  // Groww's own docs, more reliable than guessing at order_status strings.
  if (!(filledQuantity > 0 && remainingQuantity === 0)) return null;
  if (!orderId || !tradingsymbol || !transactionType) return null;
  if (ledger.getTradeByOrderId('groww', orderId)) return null; // already recorded

  const productType = product === 'MTF' ? 'MARGIN' : product === 'MIS' ? 'INTRADAY' : 'DELIVERY';

  return ledger.recordTrade({
    broker: 'groww',
    tradingsymbol,
    exchange: exchange || 'NSE',
    transactionType,
    quantity: filledQuantity,
    price: avgPrice || price,
    tradeDate: isoDate(tradeDate || createdAt),
    productType,
    isMtf: productType === 'MARGIN',
    // mtfMarginPaid is NOT knowable from the order response alone — Groww
    // doesn't return how much margin vs. borrowed funded this specific
    // fill. Left null here; add it via POST /ledger/trades/:id or a
    // follow-up PATCH-style call once you know the actual margin used.
    mtfMarginPaid: null,
    orderId,
    source: 'live',
  });
}

// ---- Angel One: field names inferred from their REST order-book docs, NOT confirmed for the WS payload ----
function tryRecordAngel(update) {
  const tradingsymbol = update.tradingsymbol || update.symbol;
  const transactionType = update.transactiontype || update.transactionType;
  const quantity = Number(update.quantity || update.filledshares || update.qty);
  const price = Number(update.averageprice || update.price || update.ltp);
  const orderId = update.orderid || update.orderId;
  const status = (update.status || update.orderstatus || '').toString().toLowerCase();
  const producttype = (update.producttype || update.product || '').toUpperCase();

  const isEmptyHeartbeat = !tradingsymbol && !orderId && quantity === 0;
  if (isEmptyHeartbeat) return null; // Connection handshake/heartbeat ping — silently ignore

  if (!looksComplete || !hasRequiredFields) {
    console.warn('[autoRecorder] angelone order update did not match expected shape — skipping auto-record, raw payload:', JSON.stringify(update));
    return null;
  }
  if (ledger.getTradeByOrderId('angelone', orderId)) return null;

  const productType = producttype === 'MARGIN' ? 'MARGIN' : producttype === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY';

  return ledger.recordTrade({
    broker: 'angelone',
    tradingsymbol,
    exchange: update.exchange || 'NSE',
    transactionType,
    quantity,
    price,
    tradeDate: isoDate(update.updatetime || update.exchtime),
    productType,
    isMtf: productType === 'MARGIN',
    mtfMarginPaid: null,
    orderId,
    source: 'live',
  });
}

/** Call once per broker instance after subscribeOrderUpdates() is active. */
function attachAutoRecording(brokerInstance, brokerName) {
  brokerInstance.on('orderUpdate', (update) => {
    try {
      const recorded = brokerName === 'groww' ? tryRecordGroww(update) : tryRecordAngel(update);
      if (recorded) {
        console.log(`[autoRecorder] recorded live fill: ${brokerName} ${recorded.transaction_type} ${recorded.quantity} ${recorded.tradingsymbol} @ ${recorded.price} on ${recorded.trade_date}`);
      }
    } catch (err) {
      console.error(`[autoRecorder] failed to record ${brokerName} order update:`, err.message);
    }
  });
}

module.exports = { attachAutoRecording };