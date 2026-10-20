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
    'X-ClientLocalIP': process.env.CLIENT_LOCAL_IP || '127.0.0.1',
    'X-ClientPublicIP': process.env.CLIENT_PUBLIC_IP || '127.0.0.1',
    'X-MACAddress': process.env.CLIENT_MAC_ADDRESS || '00:00:00:00:00:00',
    'X-PrivateKey': apiKey,
  };
}

/**
 * LOGIN GATE — single-flight, rate-limited, with a cooldown after a rate-limit 403.
 *
 * Angel's login endpoint answers a burst of logins with
 *   HTTP 403 {"message":"Access denied because of exceeding access rate"}
 * and that is what took the whole live layer down on 24-Sep: the quote engine,
 * the tick board, holdings and positions all retry on 403, and every retry called
 * login() again — a feedback loop that kept the account rate-limited, so the 403
 * never cleared. With no session the tick board disables itself, and with no tick
 * board there are no 10s/15s readings and no fast BUY path at all (which is why the
 * board showed 14 SHORTs and zero BUYs).
 *
 * So: one login at a time (a second caller waits on the same promise instead of
 * starting another), a HARD cooldown after a rate-limit answer so a retry loop can
 * no longer re-arm it, and a cached session reused until it is nearly expired.
 */
let _inflight = null;          // the single in-progress login
let _session = null;           // last good session
let _sessionAt = 0;
let _cooldownUntil = 0;        // no login attempts before this timestamp
let _rateLimitHits = 0;        // escalating backoff (60s, 120s, 240s ... cap 15min)
const SESSION_TTL_MS = 3 * 3600e3;   // Angel JWTs live ~24h; refresh well inside that

/**
 * Classify an Angel RESPONSE BODY. Angel reports throttling two ways and the live
 * quote path meets BOTH: an HTTP 403 whose body says "Access denied because of
 * exceeding access rate", and an HTTP 200 with status:false + errorcode AB1012
 * ("You are accessing API too fast"). Both mean the same thing — the token is fine,
 * the caller is too loud — and both must be told apart from a genuinely dead
 * session ("Invalid Token"), because the recovery is opposite: a rate limit wants
 * back-off with the token KEPT, a dead token wants a fresh login.
 */
function isRateLimitBody(body) {
  if (!body) return false;
  const msg = typeof body === 'string' ? body : ((body.message || body.errorMessage || '') || '');
  const code = typeof body === 'object' ? (body.errorcode || body.errorCode || '') : '';
  return code === 'AB1012' || /access rate|rate limit|too many|accessing api too fast/i.test(msg);
}

function isRateLimit(err) {
  const status = err && err.response ? err.response.status : null;
  const body = err && err.response ? err.response.data : null;
  // 403 alone is NOT a rate limit — it is only one when the body says so.
  return status === 429 || isRateLimitBody(body) || isRateLimitBody(err);
}

function cooldownRemainingMs() { return Math.max(0, _cooldownUntil - Date.now()); }

/** Cached session, or null when there is none that is still fresh. */
function cachedSession() {
  if (_session && _session.jwtToken && (Date.now() - _sessionAt) < SESSION_TTL_MS) return _session;
  return null;
}

function invalidate() { _session = null; _sessionAt = 0; }

/** @returns {Promise<{ session: { jwtToken, refreshToken, feedToken, apiKey, clientCode } }>} */
async function loginOnce() {
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
  _session = { jwtToken, refreshToken, feedToken, apiKey, clientCode };
  _sessionAt = Date.now();
  _rateLimitHits = 0;
  return { session: _session };
}

/**
 * login() — the only way the app should authenticate. Returns the cached session
 * when one is fresh, joins an in-flight attempt when one is running, refuses to even
 * try during a cooldown, and escalates the cooldown on a rate-limit answer.
 */
async function login(opts) {
  const force = !!(opts && opts.force);
  if (!force) {
    const cached = cachedSession();
    if (cached) return { session: cached, cached: true };
  }
  if (_inflight) return _inflight;                     // single-flight
  const waitMs = cooldownRemainingMs();
  if (waitMs > 0) {
    const err = new Error('Angel login cooling down for ' + Math.ceil(waitMs / 1000)
      + 's after a rate-limit response (no attempt made)');
    err.rateLimited = true;
    err.cooldownMs = waitMs;
    throw err;
  }
  _inflight = (async () => {
    try {
      return await loginOnce();
    } catch (e) {
      if (isRateLimit(e)) {
        _rateLimitHits++;
        const backoff = Math.min(15 * 60000, 60000 * Math.pow(2, _rateLimitHits - 1));
        _cooldownUntil = Date.now() + backoff;
        e.rateLimited = true;
        e.cooldownMs = backoff;
        console.error('[angelAuth] login rate-limited — holding off for '
          + Math.round(backoff / 1000) + 's (hit #' + _rateLimitHits + ')');
      }
      throw e;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

module.exports = {
  login, invalidate, cachedSession, cooldownRemainingMs,
  isRateLimit, isRateLimitBody, SESSION_TTL_MS,
  // diagnostics for the feed watchdog / UI
  status: () => ({
    hasSession: !!cachedSession(), sessionAgeMs: _session ? Date.now() - _sessionAt : null,
    cooldownMs: cooldownRemainingMs(), rateLimitHits: _rateLimitHits,
  }),
};