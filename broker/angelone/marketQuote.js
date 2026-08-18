/**
 * angelone/marketQuote.js
 *
 * Angel One's REST Quote API
 */

const axios = require('axios');
const env = require('../config/env');

const MAX_TOKENS_PER_CALL = 50;

/**
 * @param {object} session { jwtToken, apiKey, clientCode, feedToken }
 * @param {object} exchangeTokens e.g. { NSE: ['2885', '3045'] } — grouped by exch_seg
 * @param {'FULL'|'OHLC'|'LTP'} mode
 * @returns {Promise<Array>} fetched quote objects (tradingsymbol, symboltoken, ltp, close, ...)
 */
async function getQuote(session, exchangeTokens, mode = 'FULL') {
  const { jwtToken, apiKey, clientCode, feedToken } = session;
  if (!jwtToken || !apiKey || !clientCode || !feedToken) {
    throw new Error('marketQuote.getQuote requires session { jwtToken, apiKey, clientCode, feedToken }');
  }

  const baseUrl = env.angel.baseUrl();
  const headers = {
    Authorization: `Bearer ${jwtToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
    'x-api-key': apiKey,
    'x-client-code': clientCode,
    'x-feed-token': feedToken,
  };

  const allFetched = [];
  for (const [exch, tokens] of Object.entries(exchangeTokens)) {
    for (let i = 0; i < tokens.length; i += MAX_TOKENS_PER_CALL) {
      const batch = tokens.slice(i, i + MAX_TOKENS_PER_CALL);
      const { data } = await axios.post(
        `${baseUrl}/rest/secure/angelbroking/market/v1/quote/`,
        { mode, exchangeTokens: { [exch]: batch } },
        { headers, timeout: 5000 }
      );
      if (data.status !== true) {
        throw new Error(`Angel One quote fetch failed: ${data.message} (${data.errorcode})`);
      }
      allFetched.push(...(data.data?.fetched || []));
      if (Object.keys(exchangeTokens).length > 1 || tokens.length > MAX_TOKENS_PER_CALL) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    }
  }
  return allFetched;
}

module.exports = { getQuote };