/**
 * grow/orderFeed.js
 *
 * Groww's real-time order/position feed only exists inside their Python
 * SDK over an undocumented NATS protocol — same dead end as the market
 * feed reverse-engineering attempt earlier in this project. Rather than
 * guess at that protocol for something that places real orders, this
 * polls the official REST order list and emits only the orders whose
 * status actually changed since the last poll.
 * Docs: https://groww.in/trade-api/docs/curl/orders (order/list)
 */

const EventEmitter = require('events');
const GrowwTrading = require('./trading');

class GrowwOrderFeed extends EventEmitter {
  /**
   * @param {object} session { accessToken }
   * @param {object} [opts] { intervalMs, segment }
   */
  constructor(session, opts = {}) {
    super();
    this.trading = new GrowwTrading(session);
    this.intervalMs = opts.intervalMs || 3000;
    this.segment = opts.segment || 'CASH';
    this.timer = null;
    this.lastStatusById = new Map(); // groww_order_id -> order_status
    this.hasPolledOnce = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._poll(), this.intervalMs);
    this._poll();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async _poll() {
    try {
      const orders = await this.trading.getOrderList({ segment: this.segment });

      // First poll after start() just establishes the baseline snapshot —
      // otherwise every pre-existing order would fire as a "change" on restart.
      if (!this.hasPolledOnce) {
        for (const order of orders) this.lastStatusById.set(order.groww_order_id, order.order_status);
        this.hasPolledOnce = true;
        return;
      }

      for (const order of orders) {
        const id = order.groww_order_id;
        const prevStatus = this.lastStatusById.get(id);
        if (prevStatus !== order.order_status) {
          this.lastStatusById.set(id, order.order_status);
          this.emit('orderUpdate', order);
        }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = GrowwOrderFeed;