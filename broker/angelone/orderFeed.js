/**
 * angelone/orderFeed.js
 *
 * Real-time order status updates (fills, rejections, etc.) — separate
 * from marketFeed.js, which only carries prices.
 * Endpoint + auth confirmed from Angel One's official smartapi-python
 * SDK (SmartApi/smartWebSocketOrderUpdate.py): auth is sent as headers,
 * not query params.
 * Limit: 3 concurrent connections per client code.
 * Heartbeat: send "ping" every 10s; server replies "pong".
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const WS_URI = 'wss://tns.angelone.in/smart-order-update';
const HEARTBEAT_INTERVAL_MS = 10000;
const HEARTBEAT_MESSAGE = 'ping';

class AngelOrderFeed extends EventEmitter {
  /** @param {object} session { jwtToken, apiKey, clientCode, feedToken } from angelone/auth.js */
  constructor(session) {
    super();
    const { jwtToken, apiKey, clientCode, feedToken } = session || {};
    if (!jwtToken || !apiKey || !clientCode || !feedToken) {
      throw new Error('AngelOrderFeed requires session { jwtToken, apiKey, clientCode, feedToken }');
    }
    this.session = { jwtToken, apiKey, clientCode, feedToken };
    this.ws = null;
    this.heartbeatTimer = null;
  }

  connect() {
    const { jwtToken, apiKey, clientCode, feedToken } = this.session;

    this.ws = new WebSocket(WS_URI, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        'x-api-key': apiKey,
        'x-client-code': clientCode,
        'x-feed-token': feedToken,
      },
    });

    this.ws.on('open', () => {
      this.emit('open');
      this.heartbeatTimer = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(HEARTBEAT_MESSAGE);
      }, HEARTBEAT_INTERVAL_MS);
    });

    this.ws.on('message', (data) => {
      const text = data.toString();
      if (text === 'pong') return;
      try {
        this.emit('orderUpdate', JSON.parse(text));
      } catch (err) {
        this.emit('orderUpdate', text); // non-JSON payload, pass through raw
      }
    });

    this.ws.on('close', () => {
      clearInterval(this.heartbeatTimer);
      this.emit('close');
    });

    this.ws.on('error', (err) => this.emit('error', err));
  }

  close() {
    clearInterval(this.heartbeatTimer);
    if (this.ws) this.ws.close();
  }
}

module.exports = AngelOrderFeed;