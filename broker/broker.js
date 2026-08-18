/**
 * broker.js
 *
 * new Broker('angelone') / new Broker('groww') expose the same methods.
 *
 * Usage:
 *   require('./config/env');
 *   const Broker = require('./broker');
 *   const angel = new Broker('angelone');
 *   await angel.login();
 *   const holdings = await angel.getHoldings();
 */

const EventEmitter = require('events');

const AngelAuth = require('./angelone/auth');
const AngelHoldings = require('./angelone/holdings');
const { AngelMarketFeed, MODE, EXCHANGE_TYPE } = require('./angelone/marketFeed');
const AngelTrading = require('./angelone/trading');
const AngelOrderFeed = require('./angelone/orderFeed');

const GrowwAuth = require('./grow/auth');
const GrowwHoldings = require('./grow/holdings');
const GrowwMarketFeed = require('./grow/marketFeed');
const GrowwTrading = require('./grow/trading');
const GrowwOrderFeed = require('./grow/orderFeed');

class Broker extends EventEmitter {
  constructor(brokerName) {
    super();
    this.brokerName = brokerName; // 'angelone' | 'groww'
    this.session = null;
    this._feed = null;
    this._orderFeed = null;
    this._holdings = null;
    this._trading = null;
  }

  async login() {
    if (this.brokerName === 'angelone') {
      const { session } = await AngelAuth.login();
      this.session = session;
      this._holdings = new AngelHoldings(session);
      this._trading = new AngelTrading(session);
    } else if (this.brokerName === 'groww') {
      this.session = await GrowwAuth.login();
      this._holdings = new GrowwHoldings(this.session);
      this._trading = new GrowwTrading(this.session);
    } else {
      throw new Error(`Unsupported broker: ${this.brokerName}`);
    }
    return this.session;
  }

  async getHoldings() {
    this._assertLoggedIn();
    return this._holdings.getHoldings();
  }

  async placeOrder(order, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.placeOrder(order, brokerOptions);
  }

  async modifyOrder(orderId, changes, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.modifyOrder(orderId, changes, brokerOptions);
  }

  async cancelOrder(orderId, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.cancelOrder(orderId, brokerOptions);
  }

  /** Angel One: subscribeLiveAngel(['2885']) or subscribeLiveAngel([{ exchangeType: 1, tokens: [...] }, ...]) */
  subscribeLiveAngel(tokenList, { exchangeType = EXCHANGE_TYPE.NSE_CM, mode = MODE.LTP } = {}) {
    this._assertLoggedIn();
    if (!this._feed) {
      this._feed = new AngelMarketFeed(this.session);
      this._feed.on('tick', (t) => this.emit('tick', t));
      this._feed.on('error', (e) => {
        console.error('[broker] Angel One market feed note:', e.message);
      });
      this._feed.connect();
    }
    const formatted = Array.isArray(tokenList) && tokenList.length && typeof tokenList[0] === 'object'
      ? tokenList
      : [{ exchangeType, tokens: tokenList }];
    this._feed.subscribe('sub1', mode, formatted);
  }

  /** Groww: subscribeLiveGroww(['NSE_RELIANCE']) */
  subscribeLiveGroww(exchangeSymbols, { intervalMs } = {}) {
    this._assertLoggedIn();
    if (!this._feed) {
      this._feed = new GrowwMarketFeed(this.session, { intervalMs });
      this._feed.on('tick', (t) => this.emit('tick', t));
      this._feed.on('error', (e) => this.emit('error', e));
      this._feed.start();
    }
    this._feed.subscribe(exchangeSymbols);
  }

  stopLiveFeed() {
    if (this._feed) {
      if (this.brokerName === 'angelone') this._feed.close();
      else this._feed.stop();
      this._feed = null;
    }
  }

  // ---- Live order status updates (fills, rejections, etc.) ----
  // Emits 'orderUpdate' events. Angel One is a genuine push WebSocket;
  // Groww is REST-polled underneath (see grow/orderFeed.js for why) —
  // the event you get is the same shape either way: whatever the broker's
  // own order object looks like, not papered over into a fake unified schema.
  subscribeOrderUpdates(opts = {}) {
    this._assertLoggedIn();
    if (this._orderFeed) return; // already subscribed

    if (this.brokerName === 'angelone') {
      this._orderFeed = new AngelOrderFeed(this.session);
      this._orderFeed.on('orderUpdate', (u) => this.emit('orderUpdate', u));
      this._orderFeed.on('error', (e) => this.emit('error', e));
      this._orderFeed.connect();
    } else {
      this._orderFeed = new GrowwOrderFeed(this.session, opts);
      this._orderFeed.on('orderUpdate', (u) => this.emit('orderUpdate', u));
      this._orderFeed.on('error', (e) => this.emit('error', e));
      this._orderFeed.start();
    }
  }

  stopOrderUpdates() {
    if (this._orderFeed) {
      if (this.brokerName === 'angelone') this._orderFeed.close();
      else this._orderFeed.stop();
      this._orderFeed = null;
    }
  }

  _assertLoggedIn() {
    if (!this.session) throw new Error(`Call ${this.brokerName}.login() before using this method.`);
  }
}

module.exports = Broker;