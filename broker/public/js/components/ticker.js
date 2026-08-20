/**
 * public/js/components/ticker.js
 * Live Market Tickers & Market Status Controller
 */

import { api } from '../core/api.js';
import { rawMoney, pct, plSign } from '../core/formatters.js';

const WATCHLIST = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'GIFTNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'];
const tickerPrices = {
  NIFTY: { price: 24053.15, prevPrice: 24154.90, change: -101.75, changePct: -0.42 },
  BANKNIFTY: { price: 57055.05, prevPrice: 57262.40, change: -207.35, changePct: -0.36 },
  SENSEX: { price: 76903.32, prevPrice: 77235.46, change: -332.14, changePct: -0.43 },
  FINNIFTY: { price: 25981.40, prevPrice: 26108.00, change: -126.60, changePct: -0.48 },
  MIDCPNIFTY: { price: 14861.05, prevPrice: 14840.75, change: 20.30, changePct: 0.14 },
  GIFTNIFTY: { price: 24114.00, prevPrice: 24230.10, change: -116.10, changePct: -0.48 },
  GOLD: { price: 71850.00, prevPrice: 71520.00, change: 330.00, changePct: 0.46 },
  SILVER: { price: 84620.00, prevPrice: 85150.00, change: -530.00, changePct: -0.62 },
  CRUDEOIL: { price: 6412.00, prevPrice: 6385.00, change: 27.00, changePct: 0.42 },
  NATURALGAS: { price: 184.50, prevPrice: 187.20, change: -2.70, changePct: -1.44 },
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

  // Indian Market hours (including 09:00 AM pre-open to 15:30 IST)
  return timeNum >= 900 && timeNum <= 1530;
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
  }
}

let selectedSymbolOverride = null;

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
  const defaultSym = open ? 'NIFTY' : 'GIFTNIFTY';
  const activeSymbol = selectedSymbolOverride || defaultSym;
  const topData = tickerPrices[activeSymbol] || tickerPrices[defaultSym] || tickerPrices.NIFTY;

  // Determine market phase (Pre-Open 9:00-9:15 vs Live 9:15-15:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const ist = new Date(utc + (3600000 * 5.5));
  const timeNum = ist.getHours() * 100 + ist.getMinutes();
  const isPreOpen = open && timeNum >= 900 && timeNum < 915;

  // Header Title & Market Tag Update
  const nameEl = document.getElementById('mainHeaderIndexName');
  const marketTagEl = document.getElementById('popoverMarketTag');
  if (nameEl) {
    const titleMap = {
      'NIFTY': 'NIFTY 50',
      'GIFTNIFTY': 'GIFT NIFTY',
      'BANKNIFTY': 'BANK NIFTY',
      'SENSEX': 'SENSEX',
      'FINNIFTY': 'FIN NIFTY',
      'MIDCPNIFTY': 'MIDCAP NIFTY',
      'GOLD': 'GOLD',
      'SILVER': 'SILVER',
      'CRUDEOIL': 'MCX CRUDE',
      'NATURALGAS': 'MCX NATGAS'
    };
    nameEl.textContent = titleMap[activeSymbol] || activeSymbol;
  }
  const liveClockEl = document.getElementById('popoverLiveClock');
  if (liveClockEl) {
    const timeStr = ist.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }).toLowerCase();
    liveClockEl.textContent = timeStr;
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
      arrowEl.textContent = isPos ? '▲' : '▼';
    }
    if (subEl) subEl.textContent = `${plSign(chgVal)}${Math.abs(chgVal).toFixed(2)} (${pct(changePct)})`;
    if (valRow) {
      valRow.className = `index-val-row ${isPos ? 'positive' : 'negative'}`;
    }
  }

  // Update Watchlist Popover Rows (NIFTY, BANKNIFTY, SENSEX, FINNIFTY, MIDCPNIFTY, GIFTNIFTY)
  for (const sym of WATCHLIST) {
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
    if (priceEl) priceEl.textContent = rawMoney(t.price);
    const change = t.change != null ? t.change : (t.prevPrice != null ? t.price - t.prevPrice : 0);
    if (changeEl) {
      const changePct = t.changePct != null ? t.changePct : (t.prevPrice != null ? (change / t.prevPrice) * 100 : 0);
      const chgVal = Number(change || 0);
      const isPos = chgVal >= 0;
      const signPctStr = isPos ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`;
      changeEl.textContent = `${isPos ? '▲' : '▼'} ${Math.abs(chgVal).toFixed(2)} (${signPctStr})`;
      changeEl.className = `w-change ${isPos ? 'positive' : 'negative'}`;
    }
  }
}
