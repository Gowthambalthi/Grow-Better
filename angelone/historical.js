/**
 * angelone/historical.js
 *
 * Angel One SmartAPI Historical Candle Data Fetcher (getCandleData)
 * Endpoint: POST /rest/secure/angelbroking/historical/v1/getCandleData
 *
 * Docs: https://smartapi.angelbroking.com/docs/Historical
 */

const axios = require('axios');
const { login } = require('./auth');
const env = require('../config/env');

let cachedSession = null;
let lastLoginTime = 0;

async function getSession() {
  const now = Date.now();
  // Refresh token session if older than 12 hours
  if (!cachedSession || now - lastLoginTime > 12 * 60 * 60 * 1000) {
    const res = await login();
    cachedSession = res.session;
    lastLoginTime = now;
  }
  return cachedSession;
}

/**
 * Fetch daily historical candles for an NSE symbol token via Angel One SmartAPI
 * @param {string} symboltoken - Angel One token for the stock (e.g. "3045" for RELIANCE)
 * @param {string} fromDate - "YYYY-MM-DD 09:15"
 * @param {string} toDate - "YYYY-MM-DD 15:30"
 * @param {string} interval - "ONE_DAY" | "ONE_MINUTE" | "FIVE_MINUTE" | "FIFTEEN_MINUTE"
 * @returns {Promise<Array<[string, number, number, number, number, number]>>} Array of [timestamp, open, high, low, close, volume]
 */
async function getCandleData({ symboltoken, fromdate, todate, interval = 'ONE_DAY', exchange = 'NSE' }) {
  const session = await getSession();
  const apiKey = session.apiKey;
  const baseUrl = env.angel.baseUrl();

  const headers = {
    'Authorization': `Bearer ${session.jwtToken}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };

  const body = {
    exchange,
    symboltoken,
    interval,
    fromdate,
    todate
  };

  const { data } = await axios.post(
    `${baseUrl}/rest/secure/angelbroking/historical/v1/getCandleData`,
    body,
    { headers, timeout: 7000 }
  );

  if (data.status !== true || !Array.isArray(data.data)) {
    throw new Error(`Angel One getCandleData failed: ${data.message || 'Unknown error'} (${data.errorcode || ''})`);
  }

  return data.data;
}

module.exports = { getCandleData, getSession };
