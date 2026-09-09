/**
 * common/mf-engine/largeCapMatcher.js
 *
 * Single source of truth for "does this fund belong under the Large-Cap card".
 * Used by db/mutualFunds.js getCardCounts, scripts/importFullUniverse.js, and
 * duplicated inline in public/index.html (frontend cannot require modules).
 *
 * Rules (user-approved classification):
 *   YES: large cap / bluechip / top 100, Nifty 50, Nifty Next 50, Nifty 100
 *        (incl. Equal Weight / Low Volatility 30 / Quality 30), BSE Sensex
 *        (incl. Next 50 / Next 30 / Equal Weight), Nifty Top 10/15/20.
 *   NO:  Mid Cap, Small Cap, Large & Mid Cap, Flexi Cap, Multi Cap, Nifty 200,
 *        any midcap/smallcap index.
 */
'use strict';

// Exclusions run first — a name containing any of these is never Large Cap.
var LC_EXCLUDE = /mid\s*cap|midcap|small\s*cap|smallcap|flexi\s*cap|flexicap|multi\s*cap|multicap|large\s*&\s*mid|large\s+and\s+mid|nifty\s*200(?![0-9])|nifty\s*midcap|nifty\s*smallcap/;

// nifty 50 must not match "nifty 500"; nifty 100 must not match "nifty 1000".
var LC_INCLUDE = /large\s*cap|largecap|bluechip|top\s*100(?![0-9])|nifty\s*50(?![0-9])|nifty50(?![0-9])|next\s*50(?![0-9])|nifty\s*100(?![0-9])|nifty100(?![0-9])|sensex|nifty\s*top\s*(10|15|20)(?![0-9])/;

/**
 * @param {string} name  scheme name
 * @param {string} [cat] AMFI/SEBI category (optional)
 * @returns {boolean}
 */
function isLargeCapName(name, cat) {
  var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
  if (LC_EXCLUDE.test(s)) return false;
  return LC_INCLUDE.test(s);
}

module.exports = { isLargeCapName: isLargeCapName };
