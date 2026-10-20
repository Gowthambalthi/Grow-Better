'use strict';

/**
 * strategies/gb01/index.js — GB01: 5m Fair Value Gap Retest (MTF Confirmed).
 *
 * The official implementation of the GB01 institutional gap retest system.
 * Delegated to the canonical core engine in strategies/fvg/index.js with
 * GB01 setup branding and default parameter configuration.
 */

const fvg = require('../fvg/index');

module.exports = {
  ...fvg,
  id: 'GB01',
  setup: 'FG01',
  name: 'GB01: 5m Fair-Value-Gap Retest',
  families: [
    { setup: 'FG01', label: 'GB01: 5m FVG Retest (MTF Confirmed)' },
  ],
  BASIS: 'Fresh 5-minute Fair Value Gap (FVG) retest with 15m trend & VWAP confirmation',
  createEngine: fvg.createEngine,
  evaluate: fvg.evaluate,
  DEFAULTS: fvg.DEFAULTS,
  FRAMES: fvg.FRAMES,
};
