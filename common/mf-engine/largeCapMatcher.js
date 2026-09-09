/**
 * common/mf-engine/largeCapMatcher.js
 *
 * Single source of truth for the cap-style card matchers (Large/Mid/Small).
 * Used by db/mutualFunds.js getCardCounts and duplicated inline in
 * public/index.html (frontend cannot require modules — keep in sync).
 *
 * Rules (user-approved classification):
 *   Large Cap: large cap / bluechip / top 100, Nifty 50, Nifty Next 50,
 *     Nifty 100 (incl. Equal Weight / Low Volatility 30 / Quality 30),
 *     BSE Sensex (incl. Next 50/30, Equal Weight), Nifty Top 10/15/20.
 *   Mid Cap:   mid cap / midcap — Nifty Midcap 50/100/150/Select, BSE MidCap.
 *   Small Cap: small cap / smallcap — Nifty Smallcap 50/100/250/Select, BSE SmallCap.
 *   Never on any pure cap card: Large & Mid Cap / Nifty LargeMidcap 250
 *     (own card), Flexi Cap, Multi Cap.
 */
'use strict';

var B = String.fromCharCode(92); // backslash, keeps the regexes copy-paste safe

// Patterns each card must NOT contain — every card excludes the other caps,
// the blended categories, and Flexi/Multi.
function otherCaps(own) {
  var parts = {
    large: 'mid' + B + 's*cap|midcap|small' + B + 's*cap|smallcap|largemidcap|large' + B + 's*midcap|large' + B + 's*&' + B + 's*mid|large' + B + 's+and' + B + 's+mid',
    mid:   'small' + B + 's*cap|smallcap|largemidcap|large' + B + 's*midcap|large' + B + 's*&' + B + 's*mid|large' + B + 's+and' + B + 's+mid',
    small: 'mid' + B + 's*cap|midcap|largemidcap|large' + B + 's*midcap|large' + B + 's*&' + B + 's*mid|large' + B + 's+and' + B + 's+mid',
  };
  return new RegExp(parts[own] + '|flexi' + B + 's*cap|flexicap|multi' + B + 's*cap|multicap');
}

var LC_EXCLUDE = otherCaps('large');
var MID_EXCLUDE = otherCaps('mid');
var SMALL_EXCLUDE = otherCaps('small');

// nifty 50 must not match "nifty 500"; nifty 100 must not match "nifty 1000".
var LC_INCLUDE = /large\s*cap|largecap|bluechip|top\s*100(?![0-9])|nifty\s*50(?![0-9])|nifty50(?![0-9])|next\s*50(?![0-9])|nifty\s*100(?![0-9])|nifty100(?![0-9])|sensex|nifty\s*top\s*(10|15|20)(?![0-9])/;

var MID_INCLUDE = /mid\s*cap|midcap/;
var SMALL_INCLUDE = /small\s*cap|smallcap/;

function make(include, exclude) {
  return function (name, cat) {
    var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
    if (exclude.test(s)) return false;
    return include.test(s);
  };
}

var isLargeCapName = make(LC_INCLUDE, LC_EXCLUDE);
var isMidCapName = make(MID_INCLUDE, MID_EXCLUDE);
var isSmallCapName = make(SMALL_INCLUDE, SMALL_EXCLUDE);

module.exports = { isLargeCapName: isLargeCapName, isMidCapName: isMidCapName, isSmallCapName: isSmallCapName };
