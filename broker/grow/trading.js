/**
 * grow/trading.js
 * Docs: https://groww.in/trade-api/docs/curl/orders
 */

const axios = require('axios');
const {
  OrderType,
  ProductType,
  validateOrder,
} = require('../common/trading/OrderTypes');
const env = require('../config/env');

const GROWW_ORDER_TYPE = {
  [OrderType.MARKET]: 'MARKET',
  [OrderType.LIMIT]: 'LIMIT',
  [OrderType.SL]: 'SL',
  // No documented pure SL-M distinct from SL — confirm in Annexures before relying on it live.
};

const GROWW_PRODUCT_TYPE = {
  [ProductType.DELIVERY]: 'CNC',
  [ProductType.INTRADAY]: 'MIS',
  [ProductType.MARGIN]: 'MTF',
};

class GrowwTrading {
  /** @param {object} session { accessToken } */
  constructor(session) {
    if (!session || !session.accessToken) {
      throw new Error('GrowwTrading requires session { accessToken }');
    }
    this.session = session;
    this.baseUrl = env.groww.baseUrl();
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.session.accessToken}`,
      'X-API-VERSION': '1.0',
    };
  }

  async placeOrder(order, { segment = 'CASH' } = {}) {
    validateOrder(order);
    const orderReferenceId = order.orderReferenceId || this._generateReferenceId();

    const body = {
      trading_symbol: order.tradingsymbol,
      quantity: order.quantity,
      price: order.price ?? 0,
      trigger_price: order.triggerPrice ?? 0,
      validity: order.validity || 'DAY',
      exchange: order.exchange,
      segment,
      product: GROWW_PRODUCT_TYPE[order.productType],
      order_type: GROWW_ORDER_TYPE[order.orderType],
      transaction_type: order.transactionType,
      order_reference_id: orderReferenceId,
    };

    const { data } = await axios.post(`${this.baseUrl}/v1/order/create`, body, { headers: this._headers() });

    if (data.status !== 'SUCCESS') {
      throw new Error(`Groww order rejected: ${data.payload?.remark || JSON.stringify(data)}`);
    }
    return {
      orderId: data.payload.groww_order_id,
      orderStatus: data.payload.order_status,
      orderReferenceId: data.payload.order_reference_id,
      raw: data,
    };
  }

  async modifyOrder(growwOrderId, changes, { segment = 'CASH' } = {}) {
    const body = {
      groww_order_id: growwOrderId,
      segment,
      order_type: GROWW_ORDER_TYPE[changes.orderType],
      ...(changes.quantity && { quantity: changes.quantity }),
      ...(changes.price !== undefined && { price: changes.price }),
      ...(changes.triggerPrice !== undefined && { trigger_price: changes.triggerPrice }),
    };
    const { data } = await axios.post(`${this.baseUrl}/v1/order/modify`, body, { headers: this._headers() });
    if (data.status !== 'SUCCESS') throw new Error(`Groww modify rejected: ${JSON.stringify(data)}`);
    return { orderId: data.payload.groww_order_id, orderStatus: data.payload.order_status, raw: data };
  }

  async cancelOrder(growwOrderId, { segment = 'CASH' } = {}) {
    const { data } = await axios.post(
      `${this.baseUrl}/v1/order/cancel`,
      { groww_order_id: growwOrderId, segment },
      { headers: this._headers() }
    );
    if (data.status !== 'SUCCESS') throw new Error(`Groww cancel rejected: ${JSON.stringify(data)}`);
    return { orderId: data.payload.groww_order_id, orderStatus: data.payload.order_status, raw: data };
  }

  async getOrderList({ segment = 'CASH', page = 0, pageSize = 50 } = {}) {
    const { data } = await axios.get(`${this.baseUrl}/v1/order/list`, {
      params: { segment, page, page_size: pageSize },
      headers: this._headers(),
    });
    return data.payload?.order_list || [];
  }

  _generateReferenceId() {
    const rand = Math.random().toString(36).slice(2, 10);
    return `sdk-${Date.now().toString(36)}-${rand}`.slice(0, 20);
  }
}

module.exports = GrowwTrading;