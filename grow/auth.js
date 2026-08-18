/**
 * grow/auth.js
 *
 * Groww's "3rd Approach: TOTP Flow" — confirmed request shape from
 * https://groww.in/trade-api/docs/curl :
 *   POST /v1/token/api/access
 *   Authorization: Bearer <GROWW_TOTP_TOKEN>   (the "API Key" from the
 *                                                Generate TOTP Token flow)
 *   Body: { "key_type": "totp", "totp": "<live 6-digit code>" }
 *
 * The underlying API key requires daily approval on Groww's Cloud API Keys
 * dashboard (https://groww.in/trade-api/api-keys) per their docs — this
 * call itself is fully automatable once that's approved for the day.
 */

const axios = require('axios');
const { authenticator } = require('otplib');
const env = require('../config/env');

/**
 * @returns {Promise<{ accessToken, tokenRefId, sessionName, expiry }>}
 */
async function login() {
  const totpToken = env.groww.totpToken();
  const totpSecret = env.groww.totpSecret();
  const baseUrl = env.groww.baseUrl();

  const totp = authenticator.generate(totpSecret);

  const { data } = await axios.post(
    `${baseUrl}/v1/token/api/access`,
    { key_type: 'totp', totp },
    {
      headers: {
        Authorization: `Bearer ${totpToken}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (!data.token) {
    throw new Error(`Groww login failed: ${JSON.stringify(data)}`);
  }

  return {
    accessToken: data.token,
    tokenRefId: data.tokenRefId,
    sessionName: data.sessionName,
    expiry: data.expiry,
  };
}

module.exports = { login };