/**
 * grow/marketFeed.js
 *
 * REST polling against /live-data/ltp — Groww has no published Node
 * WebSocket endpoint (only their Python SDK wraps one internally,
 * undocumented for direct use), so this polls instead of guessing at
 * an undocumented socket protocol.
 * Docs: https://groww.in/trade-api/docs/curl/live-data
 */

const axios = require('axios');
const EventEmitter = require('events');
const env = require('../config/env');

const MAX_SYMBOLS_PER_CALL = 50;

class GrowwMarketFeed extends EventEmitter {
  /**
   * @param {object} session { accessToken }
   * @param {object} [opts] { intervalMs, segment }
   */
  constructor(session, opts = {}) {
    super();
    if (!session || !session.accessToken) {
      throw new Error('GrowwMarketFeed requires session { accessToken }');
    }
    this.session = session;
    this.baseUrl = env.groww.baseUrl();
    this.intervalMs = opts.intervalMs || 3000;
    this.segment = opts.segment || 'CASH';
    this.symbols = new Set(); // e.g. "NSE_RELIANCE"
    this.timer = null;
  }

  _headers() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.session.accessToken}`,
      'X-API-VERSION': '1.0',
    };
  }

  /** @param {string[]} exchangeSymbols e.g. ["NSE_RELIANCE", "NSE_TCS"] */
  subscribe(exchangeSymbols) {
    for (const s of exchangeSymbols) this.symbols.add(s);
  }

  unsubscribe(exchangeSymbols) {
    for (const s of exchangeSymbols) this.symbols.delete(s);
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
    if (this.symbols.size === 0) return;
    const all = [...this.symbols];

    try {
      for (let i = 0; i < all.length; i += MAX_SYMBOLS_PER_CALL) {
        const batch = all.slice(i, i + MAX_SYMBOLS_PER_CALL);
        const { data } = await axios.get(`${this.baseUrl}/v1/live-data/ltp`, {
          params: { segment: this.segment, exchange_symbols: batch.join(',') },
          headers: this._headers(),
        });
        if (data.status !== 'SUCCESS') {
          this.emit('error', new Error(`Groww LTP fetch failed: ${JSON.stringify(data)}`));
          continue;
        }
        // NOTE: request shape is confirmed from Groww's docs; the exact
        // response schema for this REST endpoint isn't published (only the
        // WebSocket feed's nested shape is documented, a different
        // endpoint). Log `data` once against a real call and adjust this
        // parsing if it doesn't match — don't trust it for live decisions
        // until verified.
        for (const [symbol, ltp] of Object.entries(data.payload || {})) {
          this.emit('tick', { symbol, ltp, timestamp: Date.now() });
        }
      }
    } catch (err) {
      this.emit('error', err);
    }
  }
}

module.exports = GrowwMarketFeed;