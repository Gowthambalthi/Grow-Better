'use strict';

/**
 * strategies/gb01/liveAdapter.js — Live Market Adapter for GB01.
 *
 * Bridges the live tick / 1-minute streaming feed into the GB01 engine.
 * Ensures that:
 * 1. Only closed minute bars are fed.
 * 2. Bars are fed monotonically, once per session.
 * 3. Stale signals (> 3 mins old) are filtered out.
 */

module.exports = require('../fvg/liveAdapter');
