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
      this._reconnectAttempt = 0;
      this._lastErr = null;
      this.emit('open');
      this.heartbeatTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send('ping');
      }, HEARTBEAT_INTERVAL_MS);
      // Replay subscriptions after a reconnect
      for (const sub of this.pendingSubscriptions) this._send(sub);
      this._opens = (this._opens || 0) + 1;
      this._openedAt = Date.now();
      console.log('[AngelMarketFeed] socket open (#' + this._opens + ') — ' +
        this.pendingSubscriptions.length + ' subscription(s) replayed');
    });

    this.ws.on('message', (data) => {
      if (data.toString() === 'pong') return;
      try {
        const tick = this._parseBinary(data);
        this._ticks = (this._ticks || 0) + 1;
        this._lastTickAt = Date.now();
        this.emit('tick', tick);
      } catch (err) {
        this.emit('error', err);
      }
    });

    this.ws.on('close', (code, reason) => {
      clearInterval(this.heartbeatTimer);
      const reasonStr = reason ? reason.toString() : '';
      if (/429/.test(reasonStr) || code === 429) {
        this._lastErr = '429 Rate Limit Exceeded';
      }
      this.emit('close');
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      this._lastErr = err ? (err.message || String(err)) : '';
      this.emit('error', err);
      if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
        this._scheduleReconnect();
      }
    });
  }

  _scheduleReconnect() {
    if (this.isReconnecting || this.manualClose) return;
    this.isReconnecting = true;
    // Exponential backoff: hammering the socket endpoint on failure gets the
    // IP rate-limited (HTTP 429 on connect) and then EVERY reconnect fails.
    this._reconnectAttempt = (this._reconnectAttempt || 0) + 1;
    // 429 at handshake = IP/account throttled by Angel. Retrying on the normal
    // backoff keeps the throttle hot; wait a hard 10 min instead.
    const hardThrottle = this._lastErr && /429/.test(this._lastErr);
    const delay = hardThrottle ? 600000 : Math.min(30000 * Math.pow(2, this._reconnectAttempt - 1), 300000);
    console.log(`[AngelMarketFeed] Connection dropped${hardThrottle ? ' (429 throttle)' : ''}. Auto-reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempt})...`);
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
    }, delay);
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

  /**
   * WHAT THIS SOCKET IS DOING, READABLE FROM OUTSIDE.
   *
   * The feed was invisible: no endpoint reported whether the socket was open, what it was
   * subscribed to, or when it last received a tick — so "no live data" and "a quiet market"
   * were indistinguishable, and a socket that had been displaced by a newer connection (or
   * whose session token had been superseded) looked exactly like a healthy one. This is what
   * /api/status publishes.
   */
  status() {
    const now = Date.now();
    return {
      socketState: this.ws ? this.ws.readyState : null,   // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      connected: !!(this.ws && this.ws.readyState === 1),
      opens: this._opens || 0,
      reconnects: this._reconnectAttempt || 0,
      ticks: this._ticks || 0,
      lastTickAt: this._lastTickAt || null,
      silentForMs: this._lastTickAt ? (now - this._lastTickAt) : null,
      // How long this socket has been open with nothing to show for it. A socket opened
      // seconds ago is not "silent", it is new — the watchdog needs the difference.
      openedAt: this._openedAt || null,
      openForMs: this._openedAt ? (now - this._openedAt) : null,
      subscriptions: this.pendingSubscriptions.map((s) => ({
        correlationId: s.correlationID, mode: s.params.mode,
        tokens: (s.params.tokenList || []).reduce((n, g) => n + ((g.tokens || []).length), 0),
      })),
      lastError: this._lastErr || null,
    };
  }

  /**
   * RECONNECT ON PURPOSE. A DISPLACED SOCKET NEVER TELLS YOU.
   *
   * Angel accepts the handshake and then, if the account's feed has been taken over by a
   * newer connection (or the jwtToken was superseded by a later login), simply stops pushing
   * frames. No 'close', no 'error', readyState stays OPEN, and TCP stays ESTABLISHED — so the
   * existing reconnect logic can never fire and the feed is silently dead until someone
   * restarts the server. This tears the socket down and rebuilds it, replaying every
   * subscription, which is the only thing that recovers that state.
   */
  recycle(reason) {
    console.log('[AngelMarketFeed] recycling the feed socket: ' + (reason || 'requested'));
    if (this._recycles == null) this._recycles = 0;
    this._recycles += 1;
    try { clearInterval(this.heartbeatTimer); } catch (_) {}
    try { if (this.ws) this.ws.terminate(); } catch (_) {}
    this.isReconnecting = false;
    this.manualClose = false;   // a recycle is not a shutdown: subscriptions must be replayed
    this.connect();
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
      // NUMBER, NOT BigInt. This was the only BigInt on the tick object, and a BigInt cannot
      // be JSON-serialised — `JSON.stringify(tick)` throws "Do not know how to serialize a
      // BigInt", which is exactly what the SSE tick stream (/api/<broker>/live/stream) does
      // with every tick it forwards. So the socket authenticated, ticks arrived, and the one
      // endpoint that hands them to a browser died on the first one: live data that looks
      // like no data. The value is a monotonically increasing counter and is read by nothing
      // in this repo, so a Number is both safe and sufficient (exact far past any session's
      // tick count).
      sequenceNumber: Number(buf.readBigInt64LE(27)),
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

  /**
   * BEST-5 DEPTH -> { buy, sell } where `buy` is the BID ladder sorted best-first
   * (highest price first) and `sell` the ASK ladder sorted best-first (lowest first),
   * so index 0 is level 1 on its own side.
   *
   * THE FLAG IS NOT A SIDE MARKER, AND THE PRICES ARE. Each 20-byte entry starts with a
   * 16-bit `flag`; treating 0 as "buy" put the ASK ladder in `bestBids` on 1,656,566 of
   * 1,656,566 depth snapshots on 2026-10-12 — every level-1 row in the tape read
   * bid > ask (an impossible book) and a big ASK quantity was recorded as a big BID.
   * From 15:20 IST the same flag began arriving the OTHER way round on some symbols
   * (flag 0 holding the bids, e.g. FEDERALBNK), so it is not stable enough to decide
   * anything with — and Angel's own smartWebSocketV2.py contradicts itself here too
   * (SDK issue #71).
   *
   * Two things the old code also got wrong and this one does not:
   *   - LEVEL ORDER. Entries do not reliably arrive best-first: after 15:20 the tape's
   *     `bid` was the FURTHEST bid (317.25 when the best was 325.15), because level 1
   *     was taken as array index 0. Sorting by price makes index 0 mean level 1.
   *   - WHOLE GROUPS. Keeping the flag groups (the only structure available) but
   *     ORIENTING them by price range is what orderflow/depth5_recorder.js already does,
   *     and it matches Groww's ladder level for level.
   *
   * When the two ranges overlap — locked, halted, or a malformed packet — there is no
   * honest way to say which group is which, so BOTH are dropped. An absent level-1 is a
   * gap a reader can see; a crossed one is a lie a strategy would trade on.
   */
  _parseBest5(slice) {
    const g1 = [], g2 = [];
    for (let i = 0; i + 20 <= slice.length; i += 20) {
      const packet = slice.slice(i, i + 20);
      const entry = {
        flag: packet.readUInt16LE(0),
        quantity: Number(packet.readBigInt64LE(2)),
        price: Number(packet.readBigInt64LE(10)) / 100,
        numOrders: packet.readUInt16LE(18),
      };
      if (!(entry.price > 0)) continue;          // padding / absent level: never published
      (entry.flag === 0 ? g1 : g2).push(entry);
    }
    if (!g1.length || !g2.length) return { buy: [], sell: [] };
    const max1 = Math.max(...g1.map((e) => e.price)), min1 = Math.min(...g1.map((e) => e.price));
    const max2 = Math.max(...g2.map((e) => e.price)), min2 = Math.min(...g2.map((e) => e.price));
    let bids, asks;
    if (max1 < min2) { bids = g1; asks = g2; }        // group 1 is the lower (buy) side
    else if (max2 < min1) { bids = g2; asks = g1; }   // group 1 is the higher (sell) side
    else return { buy: [], sell: [] };                // crossed/overlapping: cannot orient
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);
    return { buy: bids, sell: asks };
  }
}

module.exports = { AngelMarketFeed, MODE, EXCHANGE_TYPE };