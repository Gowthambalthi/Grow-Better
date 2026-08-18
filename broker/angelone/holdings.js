/**
 * angelone/holdings.js
 *
 * Kept as a direct REST call (verified against SmartAPI's official docs)
 * Docs: https://smartapi.angelbroking.com/docs/Portfolio
 */

const axios = require('axios');
const env = require('../config/env');

class AngelHoldings {
  /** @param {object} session { jwtToken, apiKey } from angelone/auth.js */
  constructor(session) {
    if (!session || !session.jwtToken || !session.apiKey) {
      throw new Error('AngelHoldings requires session { jwtToken, apiKey }');
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
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': apiKey,
    };
  }

  async getHoldings() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/portfolio/v1/getHolding`,
      { headers: this._headers(), timeout: 5000 }
    );
    if (data.status !== true) throw new Error(`Angel One getHolding failed: ${data.message}`);
    return data.data || [];
  }

  async getAllHoldings() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/portfolio/v1/getAllHolding`,
      { headers: this._headers(), timeout: 5000 }
    );
    if (data.status !== true) throw new Error(`Angel One getAllHolding failed: ${data.message}`);
    return data.data || { holdings: [], totalholding: {} };
  }

  async getPositions() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/order/v1/getPosition`,
      { headers: this._headers(), timeout: 5000 }
    );
    if (data.status !== true) throw new Error(`Angel One getPosition failed: ${data.message}`);
    return data.data || [];
  }

  async getFunds() {
    const { data } = await axios.get(
      `${this.baseUrl}/rest/secure/angelbroking/user/v1/getRMS`,
      { headers: this._headers(), timeout: 5000 }
    );
    if (data.status !== true) throw new Error(`Angel One getRMS failed: ${data.message}`);
    return data.data;
  }
}

module.exports = AngelHoldings;