/**
 * config/env.js
 * Loads and validates environment variables. Require this once at the
 * top of your entrypoint before anything else touches process.env.
 */

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}. Check your .env file.`);
  return value;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v.toLowerCase() === 'true';
}

const config = {
  server: {
    host: process.env.HOST || '0.0.0.0',
    port: process.env.PORT || '4000',
    apiKey: () => process.env.SERVER_API_KEY || null,
  },
  angel: {
    enabled: () => bool('ANGEL_ENABLED', false),
    apiKey: () => required('ANGEL_API_KEY'),
    clientCode: () => required('ANGEL_CLIENT_CODE'),
    password: () => required('ANGEL_PASSWORD'),
    totpSecret: () => required('ANGEL_TOTP_SECRET'),
    baseUrl: () => process.env.ANGEL_BASE_URL || 'https://apiconnect.angelone.in',
  },
  groww: {
    enabled: () => bool('GROWW_ENABLED', false),
    totpToken: () => required('GROWW_TOTP_TOKEN'), // the "API Key" from Groww's TOTP key generation flow
    totpSecret: () => required('GROWW_TOTP_SECRET'), // base32 secret used to generate live 6-digit codes
    baseUrl: () => process.env.GROWW_BASE_URL || 'https://api.groww.in',
  },
};

module.exports = config;