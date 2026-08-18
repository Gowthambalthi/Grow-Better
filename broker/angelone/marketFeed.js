/**
 * angel/marketFeed.js
 *
 * SmartAPI WebSocket 2.0 live market data client.
 * Endpoint + binary packet layout ported directly from Angel One's own
 * official smartapi-python SDK (SmartApi/smartWebSocketV2.py), translated
 * to Node's Buffer API — not reverse-engineered/guessed.
 * Reference: https://github.com/angel-one/smartapi-python
 *
 * Prices are transmitted as integers scaled by 100 (e.g. 141910 == ₹1419.10).
 * This client divides by 100 before handing ticks to your callback.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const ROOT_URI = 'wss://smartapisocket.angelone.in/smart-stream';
const HEARTBEAT_INTERVAL_MS = 10000;

const MODE = Object.freeze({ LTP: 1, QUOTE: 2, SNAP_QUOTE: 3, DEPTH: 4 });
const EXCHANGE_TYPE = Object.freeze({
  NSE_CM: 1, NSE_FO: 2, BSE_CM: 3, BSE_FO: 4, MCX_FO: 5, NCX_FO: 7, CDE_FO: 13,
});

class AngelMarketFeed extends EventEmitter {
  /**
   * @param {object} session { jwtToken, apiKey, clientCode, feedToken }
   * jwtToken/feedToken come from angel/auth.js login().
   */
  constructor(session) {
    super();
    const { jwtToken, apiKey, clientCode, feedToken } = session || {};
    if (!jwtToken || !apiKey || !clientCode || !feedToken) {
      throw new Error('AngelMarketFeed requires session { jwtToken, apiKey, clientCode, feedToken }');
    }
    this.session = { jwtToken, apiKey, clientCode, feedToken };
    this.ws = null;
    this.heartbeatTimer = null;
    this.pendingSubscriptions = []; // replayed on reconnect
  }

  connect() {
    const { jwtToken, apiKey, clientCode, feedToken } = this.session;
    this.ws = new WebSocket(ROOT_URI, {
      headers: {
        Authorization: jwtToken,
        'x-api-key': apiKey,
        'x-client-code': clientCode,
        'x-feed-token': feedToken,
      },
    });

    this.ws.on('open', () => {
      this.emit('open');
      this.heartbeatTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send('ping');
      }, HEARTBEAT_INTERVAL_MS);
      // Replay subscriptions after a reconnect
      for (const sub of this.pendingSubscriptions) this._send(sub);
    });

    this.ws.on('message', (data) => {
      if (data.toString() === 'pong') return;
      try {
        const tick = this._parseBinary(data);
        this.emit('tick', tick);
      } catch (err) {
        this.emit('error', err);
      }
    });

    this.ws.on('close', () => {
      clearInterval(this.heartbeatTimer);
      this.emit('close');
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.isReconnecting || this.manualClose) return;
    this.isReconnecting = true;
    console.log('[AngelMarketFeed] Connection dropped. Auto-reconnecting in 5 seconds...');
    setTimeout(() => {
      this.isReconnecting = false;
      try {
        if (this.ws) {
          try { this.ws.terminate(); } catch (e) {}
        }
        this.connect();
      } catch (e) {
        console.error('[AngelMarketFeed] Auto-reconnect failed:', e.message);
      }
    }, 5000);
  }

  /**
   * @param {string} correlationId up to 10 alphanumeric chars
   * @param {number} mode MODE.LTP | MODE.QUOTE | MODE.SNAP_QUOTE
   * @param {Array<{exchangeType: number, tokens: string[]}>} tokenList
   */
  subscribe(correlationId, mode, tokenList) {
    const payload = { correlationID: correlationId, action: 1, params: { mode, tokenList } };
    this.pendingSubscriptions.push(payload);
    this._send(payload);
  }

  unsubscribe(correlationId, mode, tokenList) {
    this._send({ correlationID: correlationId, action: 0, params: { mode, tokenList } });
    this.pendingSubscriptions = this.pendingSubscriptions.filter(
      (s) => !(s.params.mode === mode)
    );
  }

  close() {
    this.manualClose = true;
    clearInterval(this.heartbeatTimer);
    if (this.ws) this.ws.close();
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  // ---- Binary parsing (ported from smartWebSocketV2.py _parse_binary_data) ----

  _parseBinary(buf) {
    const tick = {
      subscriptionMode: buf.readUInt8(0),
      exchangeType: buf.readUInt8(1),
      token: this._parseToken(buf.slice(2, 27)),
      sequenceNumber: buf.readBigInt64LE(27),
      exchangeTimestamp: Number(buf.readBigInt64LE(35)),
      lastTradedPrice: Number(buf.readBigInt64LE(43)) / 100,
    };

    if (tick.subscriptionMode === MODE.QUOTE || tick.subscriptionMode === MODE.SNAP_QUOTE) {
      tick.lastTradedQuantity = Number(buf.readBigInt64LE(51));
      tick.averageTradedPrice = Number(buf.readBigInt64LE(59)) / 100;
      tick.volumeTradedToday = Number(buf.readBigInt64LE(67));
      tick.totalBuyQuantity = buf.readDoubleLE(75);
      tick.totalSellQuantity = buf.readDoubleLE(83);
      tick.open = Number(buf.readBigInt64LE(91)) / 100;
      tick.high = Number(buf.readBigInt64LE(99)) / 100;
      tick.low = Number(buf.readBigInt64LE(107)) / 100;
      tick.close = Number(buf.readBigInt64LE(115)) / 100;
    }

    if (tick.subscriptionMode === MODE.SNAP_QUOTE) {
      tick.lastTradedTimestamp = Number(buf.readBigInt64LE(123));
      tick.openInterest = Number(buf.readBigInt64LE(131));
      tick.openInterestChangePct = Number(buf.readBigInt64LE(139));
      const depth = this._parseBest5(buf.slice(147, 347));
      tick.bestBids = depth.buy;
      tick.bestAsks = depth.sell;
      tick.upperCircuit = Number(buf.readBigInt64LE(347)) / 100;
      tick.lowerCircuit = Number(buf.readBigInt64LE(355)) / 100;
      tick.week52High = Number(buf.readBigInt64LE(363)) / 100;
      tick.week52Low = Number(buf.readBigInt64LE(371)) / 100;
    }

    return tick;
  }

  _parseToken(slice) {
    const nullIdx = slice.indexOf(0);
    return (nullIdx === -1 ? slice : slice.slice(0, nullIdx)).toString('ascii');
  }

  _parseBest5(slice) {
    const buy = [];
    const sell = [];
    for (let i = 0; i < slice.length; i += 20) {
      const packet = slice.slice(i, i + 20);
      const entry = {
        flag: packet.readUInt16LE(0),
        quantity: Number(packet.readBigInt64LE(2)),
        price: Number(packet.readBigInt64LE(10)) / 100,
        numOrders: packet.readUInt16LE(18),
      };
      if (entry.flag === 0) buy.push(entry);
      else sell.push(entry);
    }
    return { buy, sell };
  }
}

module.exports = { AngelMarketFeed, MODE, EXCHANGE_TYPE };