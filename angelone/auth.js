/**
 * angelone/auth.js
 *
 * Raw REST login (NOT going through smartapi-javascript). The installed
 * SDK bakes X-ClientLocalIP/X-ClientPublicIP/X-MACAddress into Axios's
 * default headers synchronously, before the async IP-detection calls
 * that are supposed to fill them ever resolve — those headers come out
 * null on every request the SDK makes. Angel One documents them as
 * mandatory on secure endpoints, so this can cause silent auth/order
 * rejections. This file sets them explicitly instead.
 * Docs: https://smartapi.angelbroking.com/docs/User
 */

const axios = require('axios');
const { authenticator } = require('otplib');
const env = require('../config/env');

function baseHeaders(apiKey) {
  return {
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

/** @returns {Promise<{ session: { jwtToken, refreshToken, feedToken, apiKey, clientCode } }>} */
async function login() {
  const apiKey = env.angel.apiKey();
  const clientCode = env.angel.clientCode();
  const password = env.angel.password();
  const totpSecret = env.angel.totpSecret();
  const baseUrl = env.angel.baseUrl();

  const totp = authenticator.generate(totpSecret);

  const { data } = await axios.post(
    `${baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`,
    { clientcode: clientCode, password, totp },
    { headers: baseHeaders(apiKey) }
  );

  if (data.status !== true) {
    throw new Error(`Angel One login failed: ${data.message} (${data.errorcode})`);
  }

  const { jwtToken, refreshToken, feedToken } = data.data;
  return { session: { jwtToken, refreshToken, feedToken, apiKey, clientCode } };
}

module.exports = { login };