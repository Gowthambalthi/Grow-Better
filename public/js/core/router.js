import { togglePortfolioSettingsPopover } from '../modules/portfolio.js';

const PAGE_TITLES = {
  dashboard: 'DASHBOARD OVERVIEW',
  portfolio: 'PORTFOLIO',
  orders: 'ORDERS',
  positions: 'OPEN MTF POSITIONS',
  scanner: 'INSTITUTES & INSTITUTES SYMBOL',
  terminal: 'TRADING TERMINAL',
  alerts: 'PRICE ALERTS',
  settings: 'SYSTEM SETTINGS & FUNDS',
};

export function goToView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  document.querySelectorAll('.nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.nav === name));
  const titleEl = document.getElementById('topbarPageTitle');
  if (titleEl && PAGE_TITLES[name]) titleEl.textContent = PAGE_TITLES[name];
}

export function initRouter() {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const navTarget = el.dataset.nav;
      if (navTarget === 'settings') {
        e.preventDefault();
        e.stopPropagation();
        togglePortfolioSettingsPopover(true);
        return;
      }
      goToView(navTarget);
    });
  });

  const collapseBtn = document.getElementById('collapseToggle');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      document.getElementById('sidebar').classList.toggle('collapsed');
    });
  }
}
