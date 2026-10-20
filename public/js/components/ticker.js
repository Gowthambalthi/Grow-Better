/**
 * public/js/components/ticker.js
 * Live Market Tickers & Market Status Controller
 */

import { api } from '../core/api.js';
import { rawMoney, pct, plSign } from '../core/formatters.js';

// Core symbols polled every tick — they feed the always-visible topbar ticker
// Core symbols polled every tick — they feed the always-visible topbar ticker
const CORE_SYMBOLS = ['GIFTNIFTY', 'NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'BANKEX', 'MIDCPNIFTY', 'INDIAVIX', 'NIFTYNXT50'];
// Extra Indian rows (MCX commodities) fetched while the Indices List popover is open
const EXTRA_SYMBOLS = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'];
// Indian indices and commodities shown in the popover
const INDIA_SYMBOLS = [...CORE_SYMBOLS, ...EXTRA_SYMBOLS];

const DISPLAY_NAMES = {
  GIFTNIFTY: 'GIFT Nifty', NIFTY: 'NIFTY', SENSEX: 'SENSEX', BANKNIFTY: 'BANKNIFTY', FINNIFTY: 'FINNIFTY',
  BANKEX: 'BANKEX', MIDCPNIFTY: 'MIDCPNIFTY', INDIAVIX: 'INDIA VIX', NIFTYNXT50: 'NIFTYNXT50',
  GOLD: 'MCX GOLD', SILVER: 'MCX SILVER', CRUDEOIL: 'MCX CRUDE', NATURALGAS: 'MCX NATGAS',
};
const ALL_SYMBOLS = Array.from(new Set([...INDIA_SYMBOLS, ...EXTRA_SYMBOLS]));
const tickerPrices = {
  GIFTNIFTY: { price: 22888.95, prevPrice: 23146.15, change: -257.20, changePct: -1.11 },
  NIFTY: { price: 23398.10, prevPrice: 23477.80, change: -79.70, changePct: -0.34 },
  SENSEX: { price: 74781.76, prevPrice: 74902.59, change: -120.83, changePct: -0.16 },
  BANKNIFTY: { price: 56606.55, prevPrice: 56471.95, change: 134.60, changePct: 0.24 },
  FINNIFTY: { price: 25545.40, prevPrice: 25520.30, change: 25.10, changePct: 0.10 },
  BANKEX: { price: 64025.06, prevPrice: 63963.64, change: 61.42, changePct: 0.10 },
  MIDCPNIFTY: { price: 14584.70, prevPrice: 14528.30, change: 56.40, changePct: 0.39 },
  INDIAVIX: { price: 12.29, prevPrice: 11.80, change: 0.49, changePct: 4.15 },
  NIFTYNXT50: { price: 72083.70, prevPrice: 72530.90, change: -447.20, changePct: -0.62 },
};

export function isIndianMarketOpen() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  const day = ist.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;

  const hours = ist.getHours();
  const mins = ist.getMinutes();
  const timeNum = hours * 100 + mins;

  // Indian market hours: 09:15 to 15:30 IST. This used to start at 09:00 to cover the pre-open
  // session, but the pre-open feature was removed — so the ticker no longer calls itself "open"
  // for a quarter of an hour during which no continuous trading exists.
  return timeNum >= 915 && timeNum <= 1530;
}

export function togglePopover(popoverId, buttonId) {
  const popover = document.getElementById(popoverId);
  const btn = document.getElementById(buttonId);
  if (!popover) return;
  const isShown = popover.classList.contains('show');

  document.querySelectorAll('.dropdown-popover:not(#portfolioSettingsPopover)').forEach((p) => p.classList.remove('show'));
  document.querySelectorAll('.topbar-index-pill').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.portfolio-settings-btn').forEach((b) => b.classList.remove('active'));

  if (!isShown) {
    popover.classList.add('show');
    if (btn) btn.classList.add('active');
    popoverOpen = true;
    updateTickerData(); // lazy-load MCX quotes on open
  } else {
    popoverOpen = false;
  }
}

let selectedSymbolOverride = null;
let popoverOpen = false; // extra MCX quotes are fetched only while this is true

export function initPopovers() {
  const indexPill = document.getElementById('topbarIndexPill');
  if (indexPill) {
    indexPill.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover('watchlistPopover', 'topbarIndexPill');
    });
  }

  const cashPill = document.getElementById('cashCardPill');
  if (cashPill) {
    cashPill.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover('cashPopover', 'cashCardPill');
    });
  }

  // Click Watchlist Row to switch active topbar index
  document.querySelectorAll('.watch-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      const sym = row.getAttribute('data-symbol');
      if (sym) {
        selectedSymbolOverride = sym;
        renderTickerUI();
        document.querySelectorAll('.dropdown-popover').forEach((p) => p.classList.remove('show'));
      }
    });
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover-wrapper') && !e.target.closest('#portfolioSettingsPopover') && !e.target.closest('#settingsModalBackdrop')) {
      document.querySelectorAll('.dropdown-popover:not(#portfolioSettingsPopover)').forEach((p) => p.classList.remove('show'));
      document.querySelectorAll('.topbar-index-pill').forEach((b) => b.classList.remove('active'));
    }
  });
}

let tickerTimer = null;

export async function startTicker() {
  renderTickerUI();
  await updateTickerData();
  if (!tickerTimer) {
    tickerTimer = setInterval(updateTickerData, 1000);
  }
}

async function updateTickerData() {
  try {
    // Lazy polling: core symbols always (topbar feed); extras only while the popover is open
    // or when the selected topbar symbol is an extra one.
    const wanted = new Set(CORE_SYMBOLS);
    if (popoverOpen) EXTRA_SYMBOLS.forEach((s) => wanted.add(s));
    if (selectedSymbolOverride) wanted.add(selectedSymbolOverride);
    const symbolList = ALL_SYMBOLS.filter((s) => wanted.has(s));
    const watchlist = await api(`/api/instruments/watchlist?symbols=${symbolList.join(',')}`).catch(() => []);
    if (Array.isArray(watchlist)) {
      for (const item of watchlist) {
        if (item && item.quote && item.quote.price != null) {
          tickerPrices[item.symbol] = {
            price: item.quote.price,
            prevPrice: item.quote.close,
            change: item.quote.change,
            changePct: item.quote.changePct,
            name: item.name,
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
  const defaultSym = 'NIFTY';
  const activeSymbol = selectedSymbolOverride || defaultSym;
  const topData = tickerPrices[activeSymbol] || tickerPrices[defaultSym] || tickerPrices.NIFTY;

  // There is no pre-open phase any more (the 09:00-09:15 tag and its `isPreOpen` flag were
  // removed with the pre-open feature); the clock below is only used for the header time.
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));

  // Header Title & Market Tag Update
  const nameEl = document.getElementById('mainHeaderIndexName');
  const marketTagEl = document.getElementById('popoverMarketTag');
  if (nameEl) {
    nameEl.textContent = DISPLAY_NAMES[activeSymbol] || activeSymbol;
  }
  const liveClockEl = document.getElementById('popoverLiveClock');
  if (liveClockEl) {
    const timeStr = ist.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const parts = timeStr.split(' ');
    liveClockEl.textContent = parts[0];
    const ampmEl = document.getElementById('popoverLiveAmPm');
    if (ampmEl && parts[1]) ampmEl.textContent = parts[1].toLowerCase();
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
    if (arrowEl) {
      arrowEl.style.display = 'none';
    }
    if (subEl) {
      const chgStr = Math.abs(chgVal).toFixed(2);
      const pctStr = Math.abs(changePct).toFixed(2);
      subEl.textContent = isPos ? `+${chgStr} (+${pctStr}%)` : `${chgStr} (-${pctStr}%)`;
    }
    if (valRow) {
      valRow.className = `index-val-row ${isPos ? 'positive' : 'negative'}`;
    }
  }

  // Update Watchlist Popover Rows (India + MCX + world indices)
  for (const sym of ALL_SYMBOLS) {
    const row = document.querySelector(`.watch-row[data-symbol="${sym}"]`);
    if (!row) continue;

    // Highlight active selected row
    if (sym === activeSymbol) {
      row.classList.add('active');
    } else {
      row.classList.remove('active');
    }

    const t = tickerPrices[sym];
    if (!t || t.price == null) continue;
    const priceEl = row.querySelector('.w-price');
    const changeEl = row.querySelector('.w-change');
    const change = t.change != null ? t.change : (t.prevPrice != null ? t.price - t.prevPrice : 0);
    const changePct = t.changePct != null ? t.changePct : (t.prevPrice != null ? (change / t.prevPrice) * 100 : 0);
    const chgVal = Number(change || 0);
    const isPos = chgVal >= 0;

    if (priceEl) {
      priceEl.textContent = rawMoney(t.price);
      priceEl.className = `w-price ${isPos ? 'positive' : 'negative'}`;
    }
    if (changeEl) {
      const signPctStr = isPos ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`;
      const signValStr = isPos ? `+${Math.abs(chgVal).toFixed(2)}` : `-${Math.abs(chgVal).toFixed(2)}`;
      changeEl.textContent = `${isPos ? '▲' : '▼'} ${signValStr} (${signPctStr})`;
      changeEl.className = `w-change ${isPos ? 'positive' : 'negative'}`;
    }
  }
}
