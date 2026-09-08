/**
 * public/js/components/ticker.js
 * Live Market Tickers & Market Status Controller
 */

import { api } from '../core/api.js';
import { rawMoney, pct, plSign } from '../core/formatters.js';

// India rows shown in the popover (order matters)
const INDIA_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'GIFTNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'];
// World rows per region tab
const REGION_SYMBOLS = {
  usa: ['SPX', 'DJI', 'NASDAQ', 'VIX'],
  asia: ['NIKKEI', 'HANGSENG', 'SHANGHAI', 'KOSPI'],
  europe: ['FTSE', 'DAX', 'CAC', 'STOXX50'],
};
const DISPLAY_NAMES = {
  NIFTY: 'NIFTY 50', BANKNIFTY: 'BANK NIFTY', SENSEX: 'SENSEX', FINNIFTY: 'FIN NIFTY',
  MIDCPNIFTY: 'MIDCAP NIFTY', GIFTNIFTY: 'GIFT NIFTY', GOLD: 'MCX GOLD', SILVER: 'MCX SILVER',
  CRUDEOIL: 'MCX CRUDE', NATURALGAS: 'MCX NATGAS',
  SPX: 'S&P 500', DJI: 'DOW JONES', NASDAQ: 'NASDAQ', VIX: 'US VIX',
  NIKKEI: 'NIKKEI 225', HANGSENG: 'HANG SENG', SHANGHAI: 'SHANGHAI', KOSPI: 'KOSPI',
  FTSE: 'FTSE 100', DAX: 'DAX', CAC: 'CAC 40', STOXX50: 'EURO STOXX 50',
};
const ALL_SYMBOLS = Array.from(new Set([...INDIA_SYMBOLS, ...Object.values(REGION_SYMBOLS).flat()]));
const tickerPrices = {
  NIFTY: { price: 23772.85, prevPrice: 23897.70, change: -124.85, changePct: -0.52 },
  BANKNIFTY: { price: 57045.75, prevPrice: 57369.65, change: -323.90, changePct: -0.56 },
  SENSEX: { price: 76116.33, prevPrice: 76515.43, change: -399.10, changePct: -0.52 },
  FINNIFTY: { price: 25935.30, prevPrice: 26051.00, change: -115.70, changePct: -0.44 },
  MIDCPNIFTY: { price: 14661.00, prevPrice: 14713.65, change: -52.65, changePct: -0.36 },
  GIFTNIFTY: { price: 24180.00, prevPrice: 24187.50, change: -7.50, changePct: -0.03 },
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
let activeRegion = 'india';

function ensureWorldRows() {
  const body = document.querySelector('#watchlistPopover .popover-body');
  if (!body) return;
  for (const [region, syms] of Object.entries(REGION_SYMBOLS)) {
    for (const sym of syms) {
      if (body.querySelector(`.watch-row[data-symbol="${sym}"]`)) continue;
      const row = document.createElement('div');
      row.className = 'watch-row world-row';
      row.setAttribute('data-symbol', sym);
      row.setAttribute('data-region', region);
      row.style.display = 'none';
      row.innerHTML = `<span class="w-name">${DISPLAY_NAMES[sym] || sym}</span>`
        + `<div class="w-right"><div class="w-price">–</div><div class="w-change">…</div></div>`;
      row.addEventListener('click', () => {
        selectedSymbolOverride = sym;
        renderTickerUI();
        document.querySelectorAll('.dropdown-popover').forEach((p) => p.classList.remove('show'));
      });
      body.appendChild(row);
    }
  }
}

function applyRegionFilter() {
  document.querySelectorAll('#watchlistPopover .watch-row').forEach((row) => {
    const isWorld = row.classList.contains('world-row');
    const rowRegion = row.getAttribute('data-region') || 'india';
    row.style.display = rowRegion === activeRegion ? '' : 'none';
    if (isWorld && rowRegion === activeRegion) row.style.display = '';
  });
  const viewAll = document.querySelector('#watchlistPopover .inder-viewall');
  if (viewAll) viewAll.style.display = activeRegion === 'india' ? '' : 'none';
}

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

  // Region tabs (India / USA / Asia / Europe) — switch which rows show
  document.querySelectorAll('#watchlistPopover .inder-region-tab').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      activeRegion = tab.getAttribute('data-region') || 'india';
      document.querySelectorAll('#watchlistPopover .inder-region-tab').forEach((t) => t.classList.toggle('active', t === tab));
      applyRegionFilter();
    });
  });

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
  ensureWorldRows();
  renderTickerUI();
  await updateTickerData();
  if (!tickerTimer) {
    tickerTimer = setInterval(updateTickerData, 1000);
  }
}

async function updateTickerData() {
  try {
    const watchlist = await api(`/api/instruments/watchlist?symbols=${ALL_SYMBOLS.join(',')}`).catch(() => []);
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
      arrowEl.textContent = isPos ? '▲' : '▼';
    }
    if (subEl) subEl.textContent = `${plSign(chgVal)}${Math.abs(chgVal).toFixed(2)} (${pct(changePct)})`;
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
