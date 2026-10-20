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
    port: (process.env.PORT && process.env.PORT !== '0') ? process.env.PORT : '4000',
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
  // Sieve scrape API (news extraction / structured document runs).
  // Server-side only: the key is never sent to the browser and never logged.
  // When SIEVE_API_KEY is unset this whole feature is inert and every other
  // part of the app behaves exactly as before.
  sieve: {
    enabled: () => bool('SIEVE_ENABLED', !!process.env.SIEVE_API_KEY),
    apiKey: () => process.env.SIEVE_API_KEY || null,
    baseUrl: () => process.env.SIEVE_BASE_URL || 'https://scrape.usesieve.com',
    clientName: () => process.env.SIEVE_CLIENT_NAME || 'grow-better-terminal',
    userAgent: () => process.env.SIEVE_USER_AGENT || null,
  },
  // PASSIVE RESEARCH. Nothing in here can produce a BUY, a SHORT, a planner gate
  // or a board row — these switches only decide what gets RECORDED while the
  // frozen engines (docs/ORDERFLOW-PHASE2.md) are being measured.
  research: {
    /**
     * ORDER-FLOW TICK CAPTURE — EXPLICIT OPT-IN. Re-arms the sub-minute tape so the
     * micro CHANGE condition can be re-tested on sessions the frozen
     * OF01-v2/OF03-v1 engine has never seen.
     *
     * DEFAULT OFF. Passive research that switches itself on during an ordinary
     * restart is not passive: it would subscribe the board's 254 symbols in QUOTE
     * mode and begin writing tape nobody asked for on that boot. Recording is a
     * decision, so it is taken deliberately — GB_TICK_CAPTURE=1 enables it and
     * anything else (including unset) leaves it off.
     *
     * It records only: see orderflow/armCapture.js and test/researchGuard.test.js
     * for the boundary that keeps this out of every decision path.
     */
    tickCapture: () => process.env.GB_TICK_CAPTURE === '1',
    /** Per-symbol ring size; the research only needs about ±2 min around an event. */
    tickRingMax: () => Number(process.env.GB_ORDERFLOW_RING_MAX) || 1500,
    /**
     * F1 LIVE EVALUATION — SPEC 8.27. Runs the pre-registered F1 mechanism (big bar x flow x
     * book x location x pattern -> entry at the next bar's open) over the SAME live ticks
     * capture stores, and journals what it arms and how each one resolves. It answers the
     * question the backtest cannot: does the mechanism behave the same way on tape that was
     * not used to design it.
     *
     * SEPARATE OPT-IN FROM CAPTURE. GB_TICK_CAPTURE=1 records; GB_F1_LIVE=1 additionally
     * evaluates. They are independent because recording a day of tape and committing to a
     * strategy evaluation are different decisions, and because F1 needs its research universe
     * SUBSCRIBED — it widens the capture subscription to the 8.27 universe, which a tape-only
     * run must not do.
     *
     * It arms no order, takes no position and touches no broker endpoint: orderflow/f1Live.js
     * journals signals and scores them, and nothing in it can reach the planner or the board.
     * Never let this become a trading path without a separate, explicit decision.
     */
    f1Live: () => process.env.GB_F1_LIVE === '1',
  },
  /**
   * EXPERIMENTAL SCALPING (scalping/). A COMPLETELY SEPARATE research module:
   * it reads live ROC10/ROC20 from the tick feed and writes its own board and
   * journal. It never feeds OF01/OF03, the planner, follow() or the Board, and it
   * cannot place an order. EXPLICIT OPT-IN — GB_SCALPING=1 arms it, anything else
   * (including unset) leaves it off, exactly like tick capture.
   */
  scalping: {
    enabled: () => process.env.GB_SCALPING === '1',
    /** V2 (acceleration: MOMENTUM vs REVERSAL). Separate board + journal. */
    v2: () => process.env.GB_SCALPING_V2 === '1',
  },
};

module.exports = config;