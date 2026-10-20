'use strict';

/**
 * strategies/gb03a/index.js — GB03a: Institutional OF03 Exhaustion Reversal (Short Only).
 *
 * The official implementation of the GB03a institutional exhaustion reversal system.
 * Delegated to the canonical core engine in strategies/orderFlow.js with
 * GB03a setup branding, default parameter configuration, and Short-only enforcement.
 */

const orderFlow = require('../orderFlow');

module.exports = {
  ...orderFlow,
  id: 'GB03a',
  setup: 'OF03',
  name: 'GB03a: OF03 Exhaustion Reversal',
  families: [
    { setup: 'OF03', label: 'GB03a OF03 Exhaustion Reversal (Window to 12:30 IST)' },
  ],
  BASIS: 'Institutional order flow exhaustion reversal at marginal new extremes (Short-only)',
  createEngine: orderFlow.createEngine,
  evaluate: orderFlow.evaluate,
  DEFAULTS: orderFlow.DEFAULTS,
};
