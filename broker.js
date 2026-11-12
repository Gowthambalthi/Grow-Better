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
const AngelGtt = require('./angelone/gtt');
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
    this._gtt = null;
  }

  async login() {
    if (this.brokerName === 'angelone') {
      const { session } = await AngelAuth.login();
      this.session = session;
      this._holdings = new AngelHoldings(session);
      this._trading = new AngelTrading(session);
      // GTT is the broker-side bracket (OCO: stop + target, one firing cancels the other). Angel
      // One only — Groww exposes no equivalent in these adapters, so a bracket press on Groww is
      // refused up front rather than bought and left unprotected.
      this._gtt = new AngelGtt(session);
    } else if (this.brokerName === 'groww') {
      this.session = await GrowwAuth.login();
      this._holdings = new GrowwHoldings(this.session);
      this._trading = new GrowwTrading(this.session);
    } else {
      throw new Error(`Unsupported broker: ${this.brokerName}`);
    }
    return this.session;
  }

  /**
   * Re-login and swap the live session objects. Broker JWTs expire (Angel
   * returns 403 once they do) — callers relogin and retry instead of
   * failing until the next manual server restart.
   */
  async relogin() {
    return this.login();
  }

  async getHoldings() {
    this._assertLoggedIn();
    return this._holdings.getHoldings();
  }

  async placeOrder(order, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.placeOrder(order, brokerOptions);
  }

  /** Validate-only twin of placeOrder: builds the body and reports blockers without sending it. */
  async preflightOrder(order, brokerOptions) {
    this._assertLoggedIn();
    if (!this._trading || !this._trading.preflightOrder) {
      throw new Error('preflightOrder is not implemented for this broker');
    }
    return this._trading.preflightOrder(order, brokerOptions);
  }

  async modifyOrder(orderId, changes, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.modifyOrder(orderId, changes, brokerOptions);
  }

  async cancelOrder(orderId, brokerOptions) {
    this._assertLoggedIn();
    return this._trading.cancelOrder(orderId, brokerOptions);
  }

  /**
   * The GTT client (Angel One only). Returns null rather than throwing on other brokers, so the
   * bracket route can answer "not available for this broker" instead of failing mid-press with a
   * stack trace and an entry already live.
   */
  getGtt() {
    if (!this.session) throw new Error(`Call ${this.brokerName}.login() before using this method.`);
    return this._gtt || null;
  }

  /** Angel One: subscribeLiveAngel(['2885']) or subscribeLiveAngel([{ exchangeType: 1, tokens: [...] }, ...]) */
  subscribeLiveAngel(tokenList, { exchangeType = EXCHANGE_TYPE.NSE_CM, mode = MODE.LTP, correlationId = 'sub1' } = {}) {
    this._assertLoggedIn();
    // VALIDATE AT THE SOCKET BOUNDARY — LOUDLY. Angel parses `mode` and `exchange_seg` as
    // NUMBERS on the wire frame. An HTTP caller sending `"mode": "3"` would otherwise be
    // forwarded as a string, the frame gets mis-parsed or dropped, the endpoint still answers
    // 200 — and the observable symptom is once again "Angel One is not connecting for live
    // data". So: coerce what is numeric ("3" → 3), THROW on what is not. The
    // /api/:broker/live/subscribe route maps this throw to a 400 carrying the message, and the
    // boot-time index subscription always passes (it sends literals). The allowed sets ARE the
    // enums, not copies of them, so a future mode can never be falsely rejected here.
    const md = Number(mode);
    if (!Object.values(MODE).includes(md)) {
      throw new TypeError(`mode must be one of ${Object.values(MODE).join('|')} (LTP/QUOTE/SNAP_QUOTE/DEPTH), got ${JSON.stringify(mode)}`);
    }
    const ex = Number(exchangeType);
    if (!Object.values(EXCHANGE_TYPE).includes(ex)) {
      throw new TypeError(`exchangeType must be one of ${Object.values(EXCHANGE_TYPE).join('|')}, got ${JSON.stringify(exchangeType)}`);
    }
    if (!this._feed) {
      this._feed = new AngelMarketFeed(this.session);
      this._feed.on('tick', (t) => this.emit('tick', t));
      this._feed.on('error', (e) => {
        console.error('[broker] Angel One market feed note:', e.message);
      });
      this._feed.connect();
    }
    // Grouped input (the watch/MCX path) carries its OWN exchangeType per group — validate each
    // one against the same enum; flat input takes the validated top-level one.
    const grouped = Array.isArray(tokenList) && tokenList.length && typeof tokenList[0] === 'object';
    const formatted = grouped
      ? tokenList.map((g) => {
          const gex = Number(g && g.exchangeType);
          if (!Object.values(EXCHANGE_TYPE).includes(gex)) {
            throw new TypeError(`exchangeType must be one of ${Object.values(EXCHANGE_TYPE).join('|')}, got ${JSON.stringify(g && g.exchangeType)}`);
          }
          return { ...g, exchangeType: gex };
        })
      : [{ exchangeType: ex, tokens: tokenList }];
    // correlationId lets a second consumer subscribe on its own MODE without
    // disturbing the first: the feed parses lastTradedQuantity / volume / bq / sq
    // ONLY in QUOTE or SNAP_QUOTE mode, so an LTP subscriber and a QUOTE
    // subscriber cannot share one correlation id without fighting over mode.
    this._feed.subscribe(correlationId, md, formatted);
  }

  /**
   * FEED HEALTH, READABLE FROM OUTSIDE — null when no feed was ever opened.
   *
   * The market feed was private state: nothing could ask whether the socket was open, what it
   * was subscribed to, or when it last delivered a tick. So "Angel One is not connecting for
   * live data" could not be checked, only asserted. /api/status publishes this now.
   */
  feedStatus() {
    if (!this._feed || typeof this._feed.status !== 'function') return null;
    return this._feed.status();
  }

  /**
   * REBUILD THE FEED SOCKET. See AngelMarketFeed.recycle() — a feed that has been displaced
   * stays open and silent for ever, and nothing else recovers it.
   */
  recycleFeed(reason) {
    if (!this._feed || typeof this._feed.recycle !== 'function') return false;
    this._feed.recycle(reason);
    return true;
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