/**
 * angelone/trading.js
 * Docs: https://smartapi.angelbroking.com/docs/Orders
 */

const axios = require('axios');
const {
  OrderType,
  ProductType,
  validateOrder,
} = require('../common/trading/OrderTypes');
const env = require('../config/env');

const ANGEL_ORDER_TYPE = {
  [OrderType.MARKET]: 'MARKET',
  [OrderType.LIMIT]: 'LIMIT',
  [OrderType.SL]: 'STOPLOSS_LIMIT',
  [OrderType.SL_M]: 'STOPLOSS_MARKET',
};

const ANGEL_PRODUCT_TYPE = {
  [ProductType.DELIVERY]: 'DELIVERY',
  [ProductType.INTRADAY]: 'INTRADAY',
  [ProductType.MARGIN]: 'MARGIN',
};

class AngelTrading {
  /** @param {object} session { jwtToken, apiKey } from angelone/auth.js */
  constructor(session) {
    if (!session || !session.jwtToken || !session.apiKey) {
      throw new Error('AngelTrading requires session { jwtToken, apiKey }');
    }
    this.session = session;
    this.baseUrl = env.angel.baseUrl();
  }

  _headers() {
    const { jwtToken, apiKey } = this.session;
    return {
      Authorization: `Bearer ${jwtToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': process.env.CLIENT_LOCAL_IP || '127.0.0.1',
      'X-ClientPublicIP': process.env.CLIENT_PUBLIC_IP || '127.0.0.1',
      'X-MACAddress': process.env.CLIENT_MAC_ADDRESS || '00:00:00:00:00:00',
      'X-PrivateKey': apiKey,
    };
  }

  /**
   * The EXACT body placeOrder would POST, in one place, so a preflight cannot describe a different
   * order from the one that would actually go out. Validation lives here too: every caller gets the
   * full list of reasons the order cannot be sent instead of the first one. Not exported as a public
   * API on its own - placeOrder and preflightOrder are the two callers.
   */
  buildOrderBody(order, { variety = 'NORMAL' } = {}) {
    validateOrder(order);
    if (!order.symboltoken) {
      throw new Error('Angel One placeOrder requires order.symboltoken (instrument token)');
    }
    return {
      variety,
      tradingsymbol: order.tradingsymbol,
      symboltoken: order.symboltoken,
      transactiontype: order.transactionType,
      exchange: order.exchange,
      ordertype: ANGEL_ORDER_TYPE[order.orderType],
      producttype: ANGEL_PRODUCT_TYPE[order.productType],
      duration: order.validity || 'DAY',
      price: String(order.price ?? 0),
      triggerprice: String(order.triggerPrice ?? 0),
      quantity: String(order.quantity),
      disclosedquantity: String(order.disclosedQuantity ?? 0),
    };
  }

  /**
   * VALIDATE AND SHOW, SEND NOTHING. Answers "is live ordering working" without spending money on
   * the answer: it resolves the unified order into the broker body, and proves the session is
   * actually usable by making one real read call (an order cannot be placed on a session that cannot
   * be read). It never touches the order endpoint.
   */
  async preflightOrder(order, opts = {}) {
    const body = this.buildOrderBody(order, opts);
    const endpoint = `${this.baseUrl}/rest/secure/angelbroking/order/v1/placeOrder`;
    const warnings = [];
    let sessionOk = true;
    try {
      await axios.get(`${this.baseUrl}/rest/secure/angelbroking/order/v1/getOrderBook`, { headers: this._headers() });
    } catch (err) {
      sessionOk = false;
      const status = err.response && err.response.status;
      warnings.push(`The order-book read failed (${status || err.message}) - an order placed on this ` +
        `session would most likely fail too. The websocket can still be up while the REST session is not.`);
    }
    return { ok: warnings.length === 0, sessionOk, wouldSend: body, endpoint, warnings };
  }

  async placeOrder(order, opts = {}) {
    const body = this.buildOrderBody(order, opts);

    const { data } = await axios.post(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/placeOrder`,
      body,
      { headers: this._headers() }
    );

    if (data.status !== true) {
      throw new Error(`Angel One order rejected: ${data.message} (${data.errorcode})`);
    }
    return { orderId: data.data.orderid, raw: data };
  }

  async modifyOrder(orderId, changes, { variety = 'NORMAL' } = {}) {
    const body = {
      variety,
      orderid: orderId,
      ...(changes.orderType && { ordertype: ANGEL_ORDER_TYPE[changes.orderType] }),
      ...(changes.quantity && { quantity: String(changes.quantity) }),
      ...(changes.price !== undefined && { price: String(changes.price) }),
      ...(changes.triggerPrice !== undefined && { triggerprice: String(changes.triggerPrice) }),
      duration: changes.validity || 'DAY',
    };
    const { data } = await axios.post(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/modifyOrder`,
      body,
      { headers: this._headers() }
    );
    if (data.status !== true) {
      throw new Error(`Angel One modify rejected: ${data.message} (${data.errorcode})`);
    }
    return { orderId: data.data.orderid, raw: data };
  }

  async cancelOrder(orderId, { variety = 'NORMAL' } = {}) {
    const { data } = await axios.post(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/cancelOrder`,
      { variety, orderid: orderId },
      { headers: this._headers() }
    );
    if (data.status !== true) {
      throw new Error(`Angel One cancel rejected: ${data.message} (${data.errorcode})`);
    }
    return { orderId: data.data.orderid, raw: data };
  }

  async getOrderBook() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/getOrderBook`,
      { headers: this._headers() }
    );
    return data.data || [];
  }

  async getTradeBook() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/getTradeBook`,
      { headers: this._headers() }
    );
    return data.data || [];
  }
}

module.exports = AngelTrading;