/**
 * angelone/funds.js
 * Fetches real-time RMS funds & available cash balance directly from Angel One API
 * Docs: https://smartapi.angelbroking.com/docs/User#RMS
 */

const axios = require('axios');
const env = require('../config/env');

class AngelFunds {
  constructor(session) {
    this.session = session;
  }

  async getRMS() {
    if (!this.session || !this.session.jwtToken) {
      throw new Error('Angel One session invalid or not logged in');
    }

    const baseUrl = env.angel.baseUrl();
    const url = `${baseUrl}/rest/secure/angelbroking/user/v1/getRMS`;
    const headers = {
      'Authorization': `Bearer ${this.session.jwtToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': this.session.apiKey || env.angel.apiKey(),
    };

    const res = await axios.get(url, { headers, timeout: 8000 });
    if (res.data && res.data.status === true && res.data.data) {
      const d = res.data.data;
      const net = d.net != null ? Number(d.net) : (d.availablecash != null ? Number(d.availablecash) : 0);
      const availablecash = d.availablecash != null ? Number(d.availablecash) : net;
      return {
        net,
        availablecash,
        availablelimitmargin: d.availablelimitmargin != null ? Number(d.availablelimitmargin) : 0,
        m2munrealized: d.m2munrealized != null ? Number(d.m2munrealized) : 0,
        raw: d
      };
    }
    throw new Error(res.data?.message || 'Failed to fetch Angel One RMS funds');
  }
}

module.exports = AngelFunds;
