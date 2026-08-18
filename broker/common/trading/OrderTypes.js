/**
 * common/trading/OrderTypes.js
 *
 * Shared, broker-agnostic order vocabulary. Both the Angel One and Groww
 * trading adapters translate INTO their broker-specific fields FROM this
 * shape, so the rest of the SDK (and the caller) only ever deals with
 * one consistent order object.
 */

const TransactionType = Object.freeze({
  BUY: 'BUY',
  SELL: 'SELL',
});

const OrderType = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL: 'SL',       // stop-loss limit
  SL_M: 'SL_M',   // stop-loss market (Angel One only — Groww has no direct equivalent)
});

const ProductType = Object.freeze({
  DELIVERY: 'DELIVERY', // Angel One delivery == Groww CNC
  INTRADAY: 'INTRADAY',
  MARGIN: 'MARGIN',
});

const Exchange = Object.freeze({
  NSE: 'NSE',
  BSE: 'BSE',
});

const Validity = Object.freeze({
  DAY: 'DAY',
  IOC: 'IOC',
});

/**
 * Unified order shape the caller builds, regardless of broker:
 * {
 *   tradingsymbol: 'RELIANCE-EQ' | 'RELIANCE'   // adapter normalizes per broker
 *   symboltoken:   '2885'                        // required for Angel One, ignored by Groww
 *   exchange:      Exchange.NSE,
 *   transactionType: TransactionType.BUY,
 *   orderType:     OrderType.MARKET,
 *   productType:   ProductType.DELIVERY,
 *   quantity:      1,
 *   price:         0,          // required for LIMIT/SL
 *   triggerPrice:  0,          // required for SL/SL_M
 *   validity:      Validity.DAY,
 *   orderReferenceId: 'my-app-order-1'  // Groww requires this (8-20 alphanumeric, max 2 hyphens)
 * }
 */

class OrderValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

function validateOrder(order) {
  const errors = [];

  if (!order.tradingsymbol) errors.push('tradingsymbol is required');
  if (!order.exchange || !Object.values(Exchange).includes(order.exchange)) {
    errors.push(`exchange must be one of ${Object.values(Exchange).join(', ')}`);
  }
  if (!Object.values(TransactionType).includes(order.transactionType)) {
    errors.push(`transactionType must be one of ${Object.values(TransactionType).join(', ')}`);
  }
  if (!Object.values(OrderType).includes(order.orderType)) {
    errors.push(`orderType must be one of ${Object.values(OrderType).join(', ')}`);
  }
  if (!Object.values(ProductType).includes(order.productType)) {
    errors.push(`productType must be one of ${Object.values(ProductType).join(', ')}`);
  }
  if (!Number.isInteger(order.quantity) || order.quantity <= 0) {
    errors.push('quantity must be a positive integer');
  }
  if ((order.orderType === OrderType.LIMIT || order.orderType === OrderType.SL) &&
      (order.price === undefined || order.price <= 0)) {
    errors.push(`price is required and must be > 0 for ${order.orderType} orders`);
  }
  if ((order.orderType === OrderType.SL || order.orderType === OrderType.SL_M) &&
      (order.triggerPrice === undefined || order.triggerPrice <= 0)) {
    errors.push(`triggerPrice is required and must be > 0 for ${order.orderType} orders`);
  }

  if (errors.length) {
    throw new OrderValidationError(errors.join('; '));
  }

  return true;
}

module.exports = {
  TransactionType,
  OrderType,
  ProductType,
  Exchange,
  Validity,
  OrderValidationError,
  validateOrder,
};