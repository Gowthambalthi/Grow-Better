/**
 * grow/holdings.js
 * Docs: https://groww.in/trade-api/docs/curl/portfolio
 */

const axios = require('axios');
const env = require('../config/env');

class GrowwHoldings {
  /** @param {object} session { accessToken } from grow/auth.js login() */
  constructor(session) {
    if (!session || !session.accessToken) {
      throw new Error('GrowwHoldings requires session { accessToken }');
    }
    this.session = session;
    this.baseUrl = env.groww.baseUrl();
  }

  _headers() {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.session.accessToken}`,
      'X-API-VERSION': '1.0',
    };
  }

  async getHoldings() {
    const { data } = await axios.get(`${this.baseUrl}/v1/holdings/user`, { headers: this._headers() });
    if (data.status !== 'SUCCESS') throw new Error(`Groww getHoldings failed: ${JSON.stringify(data)}`);
    return data.payload?.holdings || [];
  }

  async getPositions(segment = 'CASH') {
    const { data } = await axios.get(`${this.baseUrl}/v1/positions/user`, {
      params: { segment },
      headers: this._headers(),
    });
    if (data.status !== 'SUCCESS') throw new Error(`Groww getPositions failed: ${JSON.stringify(data)}`);
    return data.payload || [];
  }
}

module.exports = GrowwHoldings;