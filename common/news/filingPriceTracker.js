'use strict';

/**
 * common/news/filingPriceTracker.js
 * Tracks and persists the stock price at the exact moment a corporate filing occurs.
 * Enables accurate post-news reaction measurement (how the stock moved AFTER news arrived).
 */

const fs = require('fs');
const path = require('path');

const FILE_PATH = path.join(__dirname, '../../data/news/filing_initial_prices.json');

let _prices = null;
let _dirty = false;
let _saveTimer = null;

function loadPrices() {
  if (_prices) return _prices;
  try {
    if (fs.existsSync(FILE_PATH)) {
      _prices = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    } else {
      _prices = {};
    }
  } catch (err) {
    _prices = {};
  }
  return _prices;
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (!_dirty || !_prices) return;
    try {
      const dir = path.dirname(FILE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(FILE_PATH, JSON.stringify(_prices, null, 2), 'utf8');
      _dirty = false;
    } catch (e) {
      console.warn('[filingPriceTracker] Error saving prices:', e.message);
    }
  }, 1500);
}

/**
 * Registers or retrieves the initial price of the stock at the moment of filing.
 * @param {string} symbol - NSE ticker
 * @param {number|string} filingTs - Timestamp of the filing in milliseconds
 * @param {number} currentLtp - Current live LTP
 * @param {number} fallbackOpen - 09:15 open price or yesterday close
 * @param {number} fallbackClose - Yesterday close
 * @returns {number|null} The baseline price at the filing moment
 */
function recordAndGetFilingPrice(symbol, filingTs, currentLtp, fallbackOpen = null, fallbackClose = null) {
  if (!symbol) return null;
  const store = loadPrices();
  const tsNum = Number(filingTs || 0);
  const key = `${symbol}:${tsNum > 0 ? tsNum : 'live'}`;

  const currentPrice = Number(currentLtp) > 0 ? Number(currentLtp) : null;
  const closePrice = Number(fallbackClose) > 0 ? Number(fallbackClose) : null;
  const openPrice = Number(fallbackOpen) > 0 ? Number(fallbackOpen) : null;

  // Determine if filing occurred after 15:30 close today or before 09:15 open
  let isPostClose = false;
  if (tsNum > 0) {
    const dIst = new Date(tsNum + 330 * 60000);
    const tNum = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();
    isPostClose = (tNum >= 1530 || tNum < 915);
  }

  // If filed after market close or pre-market (overnight):
  // Baseline price MUST be yesterday's closing price (closePrice), NEVER morning open or mid-day LTP!
  if (isPostClose) {
    const base = closePrice || openPrice || currentPrice;
    if (base > 0) {
      if (!store[key] || store[key].price !== base || store[key].price === currentPrice) {
        store[key] = {
          symbol,
          filingTs: tsNum,
          price: base,
          isPostClose: true,
          recordedAt: Date.now()
        };
        _dirty = true;
        scheduleSave();
      }
      return base;
    }
  }

  if (store[key] && store[key].price > 0) {
    const existing = store[key].price;
    // Calibrate away stale fallback prices (e.g. if stored price is > 8% away from ltp/close)
    if (currentPrice > 0 || closePrice > 0) {
      const ref = currentPrice || closePrice;
      const deviation = Math.abs(existing - ref) / ref;
      if (deviation > 0.08) {
        store[key].price = ref;
        store[key].recalibratedAt = Date.now();
        _dirty = true;
        scheduleSave();
        return ref;
      }
    }
    return store[key].price;
  }

  const priceToRecord = currentPrice || closePrice || openPrice;
  if (priceToRecord > 0) {
    store[key] = {
      symbol,
      filingTs: tsNum,
      price: priceToRecord,
      recordedAt: Date.now()
    };
    _dirty = true;
    scheduleSave();
    return priceToRecord;
  }

  return null;
}

/**
 * Computes the percentage change of the stock since the news was disclosed.
 * @returns {number|null} Signed percentage move since filing (+0.45, -0.80, etc.)
 */
function computePostNewsMove(symbol, filingTs, currentLtp, fallbackOpen = null, fallbackClose = null) {
  const ltp = Number(currentLtp);
  if (!(ltp > 0)) return null;

  const nowIst = new Date(Date.now() + 330 * 60000);
  const nowHourMin = nowIst.getUTCHours() * 100 + nowIst.getUTCMinutes();
  const dayOfWeek = nowIst.getUTCDay(); // 0 is Sun, 6 is Sat
  const isMarketOpenNow = (dayOfWeek >= 1 && dayOfWeek <= 5 && nowHourMin >= 915 && nowHourMin < 1530);

  const tsNum = Number(filingTs || 0);
  let isPreOpenOrOvernight = false;
  if (tsNum > 0) {
    const dIst = new Date(tsNum + 330 * 60000);
    const tNum = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();
    isPreOpenOrOvernight = (tNum >= 1530 || tNum < 915);
    
    // If news was filed post-close or pre-open AND the cash market is currently CLOSED:
    // Cash market has not opened yet. Post-news move is strictly 0.00%.
    if (isPreOpenOrOvernight && !isMarketOpenNow) {
      return 0.00;
    }
  }

  // Once market opens at 09:15 AM:
  // For pre-open / overnight filings, baseline price is yesterday's close (fallbackClose) or morning open.
  // The price move since announcement is today's price change against yesterday's close!
  const basePrice = recordAndGetFilingPrice(symbol, filingTs, currentLtp, fallbackOpen, fallbackClose);
  const ref = (basePrice > 0) ? basePrice : (fallbackClose > 0 ? fallbackClose : fallbackOpen);
  if (!(ref > 0)) return null;

  return +(((ltp - ref) / ref) * 100).toFixed(2);
}

module.exports = {
  recordAndGetFilingPrice,
  computePostNewsMove,
  loadPrices
};
