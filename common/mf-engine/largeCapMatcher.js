/**
 * common/mf-engine/largeCapMatcher.js
 *
 * Single source of truth for the cap-style card matchers (Large/Mid/Small,
 * Multi Cap, Large & Mid Cap, International). Used by db/mutualFunds.js
 * getCardCounts and duplicated inline in public/index.html (frontend cannot
 * require modules — keep in sync).
 *
 * Rules (user-approved classification):
 *   Large Cap: large cap / bluechip / top 100, Nifty 50, Nifty Next 50,
 *     Nifty 100 (incl. Equal Weight / Low Volatility 30 / Quality 30),
 *     BSE Sensex (incl. Next 50/30, Equal Weight), Nifty Top 10/15/20.
 *   Mid Cap:   mid cap / midcap — Nifty Midcap 50/100/150/Select, BSE MidCap,
 *     plus midcap index funds/ETFs/FOFs and MidSmallcap400 schemes.
 *   Small Cap: small cap / smallcap — Nifty Smallcap 50/100/250/Select, BSE SmallCap.
 *   Multi Cap: official SEBI category (multi cap / multicap variants, incl.
 *     Nifty 500 Multicap 50:25:25). NOT every Nifty 500 index fund — the
 *     index exposure and the SEBI category are different things.
 *   Large & Mid Cap: blended category — own card, never on pure cap cards.
 *   International: foreign-market exposure (global / world / overseas /
 *     foreign / US / Nasdaq / S&P 500 / Dow Jones / MSCI / FTSE / Japan /
 *     China / Hong Kong / Taiwan / Korea / Europe / Emerging Markets /
 *     Developed Markets / Asia / BRICS etc.). "International" alone is not
 *     required — any explicit foreign-market signal matches.
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

var MID_INCLUDE = /mid\s*cap|midcap|mid[-\s]*small[-\s]*cap|midsmallcap/;
var SMALL_INCLUDE = /small\s*cap|smallcap/;

function make(include, exclude, isMid) {
  return function (name, cat) {
    var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
    // MidSmallcap400 schemes are blended mid+small exposure — they belong on
    // the Mid Cap card, so the mid card must not reject them via 'smallcap'.
    if (isMid && /midsmallcap|mid[-\s]*small[-\s]*cap/.test(s)) return true;
    if (exclude.test(s)) return false;
    return include.test(s);
  };
}

// Index/ETF index funds DO count on the cap cards (user-confirmed): a Nifty
// Midcap 150 Index fund is mid-cap exposure, a Nifty 50 index fund is
// large-cap exposure. The 'Index' card was removed from the UI.

var isLargeCapName = make(LC_INCLUDE, LC_EXCLUDE);
var isMidCapName = make(MID_INCLUDE, MID_EXCLUDE, true);
var isSmallCapName = make(SMALL_INCLUDE, SMALL_EXCLUDE);

// ── Multi Cap (official SEBI category) ─────────────────────────────────────
// multi cap / multicap / multi-cap, incl. "Nifty 500 Multicap 50:25:25".
// Plain "Nifty 500" index funds are NOT classified here — broad Nifty 500
// index exposure and the SEBI Multi Cap category are different things.
var MULTI_INCLUDE = /multi[-\s]*cap|multicap|multi\s*cap(?:\s*fund)?/;
function isMultiCapName(name, cat) {
  var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
  return MULTI_INCLUDE.test(s);
}

// ── Large & Mid Cap (blended category — own card) ──────────────────────────
// large & mid cap / large and mid cap / large & midcap / large-mid cap /
// large mid cap / largemidcap / Nifty LargeMidcap 250.
var LM_INCLUDE = /large[\s&+,-]*(?:and[\s]+)?mid[\s-]*cap|large[\s&+,-]*midcap|largemidcap|nifty[\s-]*largemidcap/;
function isLargeMidCapName(name, cat) {
  var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
  return LM_INCLUDE.test(s);
}

// ── International / Foreign Equity ─────────────────────────────────────────
// Matches ANY explicit foreign-market signal, not just the word
// "International". Generic words like "opportunities" or "equity" alone are
// deliberately NOT enough.
var INTL_INCLUDE = new RegExp([
  // general international
  'internationa', 'global', 'world', 'overseas', 'foreign',
  // US-focused
  B + 'bus' + B + 's*(equity|stocks|opportunit|bluechip|technology|tech)',
  'u' + B + '.s' + B + '.|united' + B + 's+states',
  'nasdaq|s' + B + 's*&' + B + 's*p' + B + 's*500|dow' + B + 's*jones|russell' + B + 's*(1000|2000|3000)',
  // other regions / countries
  'japan|china|hong' + B + 's*kong|taiwan|korea|europe|euro' + B + '-?zone',
  'emerging' + B + 's*market|developed' + B + 's*market|asia(?!n)|bric|asean|latin' + B + 's*america|' + B + 'bafrica' + B + ',',
  // index providers
  'msci|ftse'
].join('|'));
function isInternationalName(name, cat) {
  var s = ((name || '') + ' ' + (cat || '')).toLowerCase();
  // NOTE: index/ETF funds (Nasdaq ETFs, MSCI ETFs…) DO count as International —
  // the index exclusion applies only to the pure cap cards.
  return INTL_INCLUDE.test(s);
}

module.exports = {
  isLargeCapName: isLargeCapName,
  isMidCapName: isMidCapName,
  isSmallCapName: isSmallCapName,
  isMultiCapName: isMultiCapName,
  isLargeMidCapName: isLargeMidCapName,
  isInternationalName: isInternationalName
};
