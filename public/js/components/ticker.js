/**
 * public/js/components/ticker.js
 * Live Market Tickers & Market Status Controller
 */

import { api } from '../core/api.js';
import { rawMoney, pct, plSign } from '../core/formatters.js';

const WATCHLIST = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'GIFTNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'];
const tickerPrices = {};

export function isIndianMarketOpen() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;

  const hours = ist.getHours();
  const mins = ist.getMinutes();
  const timeNum = hours * 100 + mins;

  // Indian Market hours (including 09:00 AM pre-open to 15:30 IST)
  return timeNum >= 900 && timeNum <= 1530;
}

export function togglePopover(popoverId, buttonId) {
  const popover = document.getElementById(popoverId);
  const btn = document.getElementById(buttonId);
  if (!popover) return;
  const isShown = popover.classList.contains('show');

  document.querySelectorAll('.dropdown-popover').forEach((p) => p.classList.remove('show'));
  document.querySelectorAll('.topbar-index-pill').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.portfolio-settings-btn').forEach((b) => b.classList.remove('active'));

  if (!isShown) {
    popover.classList.add('show');
    if (btn) btn.classList.add('active');
  }
}

export function initPopovers() {
  const indexPill = document.getElementById('topbarIndexPill');
  if (indexPill) {
    indexPill.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover('watchlistPopover', 'topbarIndexPill');
    });
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover-wrapper')) {
      document.querySelectorAll('.dropdown-popover').forEach((p) => p.classList.remove('show'));
      document.querySelectorAll('.topbar-index-pill').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.portfolio-settings-btn').forEach((b) => b.classList.remove('active'));
    }
  });
}

let tickerTimer = null;

export async function startTicker() {
  await updateTickerData();
  if (!tickerTimer) {
    tickerTimer = setInterval(updateTickerData, 1000);
  }
}

async function updateTickerData() {
  try {
    const watchlist = await api(`/api/instruments/watchlist?symbols=${WATCHLIST.join(',')}`).catch(() => []);
    if (Array.isArray(watchlist)) {
      for (const item of watchlist) {
        if (item.quote && item.quote.price != null) {
          tickerPrices[item.symbol] = {
            price: item.quote.price,
            prevPrice: item.quote.close,
            change: item.quote.change,
            changePct: item.quote.changePct,
            lastUpdated: item.lastUpdated,
            source: item.source,
          };
        }
      }
    }
    renderTickerUI();
  } catch (err) {
    console.error('ticker update failed:', err.message);
  }
}

function renderTickerUI() {
  const open = isIndianMarketOpen();
  const topSymbol = open ? 'NIFTY' : 'GIFTNIFTY';
  const topData = tickerPrices[topSymbol] || tickerPrices.NIFTY;

  // Determine market phase (Pre-Open 9:00-9:15 vs Live 9:15-15:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  const timeNum = ist.getHours() * 100 + ist.getMinutes();
  const isPreOpen = open && timeNum >= 900 && timeNum < 915;

  // Header Title & Market Tag Update
  const nameEl = document.getElementById('mainHeaderIndexName');
  const marketTagEl = document.getElementById('popoverMarketTag');
  if (nameEl) nameEl.textContent = open ? 'NIFTY 50' : 'GIFT NIFTY';
  if (marketTagEl) {
    const timeStr = topData && topData.lastUpdated ? new Date(topData.lastUpdated).toLocaleTimeString('en-IN') : '';
    const statusText = isPreOpen ? '● PRE-OPEN (NSE IST)' : (open ? '● LIVE (NSE IST)' : '● MARKET CLOSED (GIFT ACTIVE)');
    marketTagEl.textContent = statusText + (timeStr ? ` • ${timeStr}` : '');
    marketTagEl.style.color = open ? '#00E699' : '#F87171';
  }

  // Update Topbar Ticker Value
  if (topData && topData.price != null) {
    const valEl = document.getElementById('niftyCardValue');
    const subEl = document.getElementById('niftyCardSub');
    const arrowEl = document.getElementById('mainHeaderArrow');
    const valRow = document.getElementById('mainHeaderValRow');

    if (valEl) valEl.textContent = rawMoney(topData.price);
    const change = topData.change != null ? topData.change : (topData.prevPrice != null ? topData.price - topData.prevPrice : 0);
    const changePct = topData.changePct != null ? topData.changePct : (topData.prevPrice != null ? (change / topData.prevPrice) * 100 : 0);

    const chgVal = Number(change || 0);
    const isPos = chgVal >= 0;
    if (arrowEl) arrowEl.textContent = isPos ? '▲' : '▼';
    if (subEl) subEl.textContent = `${plSign(chgVal)}${Math.abs(chgVal).toFixed(2)} (${pct(changePct)})`;
    if (valRow) {
      valRow.className = `index-val-row ${isPos ? 'positive' : 'negative'}`;
    }
  }
  // Update Watchlist Popover Rows (NIFTY, BANKNIFTY, SENSEX, GIFTNIFTY, GOLD, SILVER)
  for (const sym of WATCHLIST) {
    const row = document.querySelector(`.watch-row[data-symbol="${sym}"]`);
    if (!row) continue;
    const t = tickerPrices[sym];
    if (!t || t.price == null) continue;
    const priceEl = row.querySelector('.w-price');
    const changeEl = row.querySelector('.w-change');
    if (priceEl) priceEl.textContent = rawMoney(t.price);
    const change = t.change != null ? t.change : (t.prevPrice != null ? t.price - t.prevPrice : 0);
    if (changeEl) {
      const changePct = t.changePct != null ? t.changePct : (t.prevPrice != null ? (change / t.prevPrice) * 100 : 0);
      const chgVal = Number(change || 0);
      const isPos = chgVal >= 0;
      changeEl.textContent = `${isPos ? '▲' : '▼'} ${plSign(chgVal)}${Math.abs(chgVal).toFixed(2)} (${pct(changePct)})`;
      changeEl.className = `w-change ${isPos ? 'positive' : 'negative'}`;
    }
  }
}
