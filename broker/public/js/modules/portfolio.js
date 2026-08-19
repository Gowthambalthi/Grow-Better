/**
 * public/js/modules/portfolio.js
 * Portfolio View & Settings Popover Controller
 */

import { api } from '../core/api.js';
import { money, plClass, pct, plSign, rawMoney } from '../core/formatters.js';
import { togglePopover } from '../components/ticker.js';
import { renderOrdersHistory, openOrderTicketModal, updateBrokerFunds } from './orders.js';
import { STOCK_LEVERAGE_DEFAULTS } from './settings.js';

let currentHoldingsCache = [];
let activeSettingsBroker = 'angelone';
let latestPortfolioData = null;
let currentViewMode = 'all';

export function renderHoldingsRow(row) {
  if (row.error) {
    return `<tr><td>${row.tradingsymbol}</td><td colspan="10" style="color:var(--loss);text-align:left;font-family:var(--font-sans)">${row.error}</td></tr>`;
  }
  const mtfBadge = row.isMtf ? `<span class="mtf-badge">MTF</span>` : '';
  const brokerBadge = row.broker === 'angelone'
    ? `<span class="broker-tag-angel">ANGEL</span>`
    : `<span class="broker-tag-groww">GROWW</span>`;

  const daysText = row.daysHeld != null ? String(row.daysHeld) : '—';
  const rawSymbol = row.tradingsymbol;
  const dayPlVal = row.todayPL != null ? row.todayPL : row.overallPL;
  const dayPlPct = row.todayPLPercent != null ? row.todayPLPercent : row.overallPLPercent;

  const instData = row.institutional;
  let instBadge = '';
  if (instData) {
    const netCount = instData.active_institutes_changed != null ? instData.active_institutes_changed : (instData.funds_changed_3m || 0);
    const isBuying = netCount >= 0;
    const badgeColor = isBuying
      ? 'background:rgba(0, 230, 153, 0.14);color:var(--gain);border:1px solid rgba(0, 230, 153, 0.3);'
      : 'background:rgba(255, 77, 109, 0.14);color:var(--loss);border:1px solid rgba(255, 77, 109, 0.3);';
    const sign = isBuying ? '+' : '';
    const totalCr = Number(instData.total_mf_holding_cr || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
    instBadge = `<span class="days-pill" style="${badgeColor}font-size:9px;padding:2px 6px;font-weight:800;" title="${instData.total_institutes_count || 0} Total Funds | ₹${totalCr} Cr MF Invested">${isBuying ? '📈' : '📉'} ${sign}${netCount} Funds</span>`;
  }

  return `
    <tr class="clickable-holding-row" data-action="order" data-symbol="${rawSymbol}" data-ltp="${row.ltp || 0}" data-broker="${row.broker || 'angelone'}" style="cursor:pointer;" title="Click row to open Order Ticket for ${rawSymbol}">
      <td>
        <div style="display:flex;align-items:center;gap:6px;overflow:hidden;flex-wrap:wrap;">
          ${brokerBadge}
          <span style="font-weight:700;color:var(--text-primary);">${rawSymbol}</span>${mtfBadge}
          ${instBadge}
        </div>
      </td>
      <td>${row.quantity}</td>
      <td>${money(row.avgPrice)}</td>
      <td>${money(row.ltp)}</td>
      <td>${money(row.investedAmount)}</td>
      <td>${money(row.currentAmount)}</td>
      <td class="${plClass(row.overallPL)}">${money(row.overallPL)}<br><small>${pct(row.overallPLPercent)}</small></td>
      <td class="${plClass(dayPlVal)}">${money(dayPlVal)}<br><small>${pct(dayPlPct)}</small></td>
      <td style="text-align:center;"><span class="days-pill">${daysText}</span></td>
      <td class="${plClass(row.grossPL)}" style="font-weight:700;">${money(row.grossPL)}<br><small style="font-size:10px;">${pct(row.grossPLPercent)}</small></td>
    </tr>`;
}

export function renderTable(tbodyId, countId, rows) {
  const tbody = document.getElementById(tbodyId);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = `${rows.length} holding${rows.length === 1 ? '' : 's'}`;
  if (tbody) {
    tbody.innerHTML = rows.length
      ? rows.map(renderHoldingsRow).join('')
      : '<tr class="empty-row"><td colspan="10">No holdings recorded</td></tr>';
  }
}

export function renderTableError(tbodyId, countId, errorMsg) {
  const tbody = document.getElementById(tbodyId);
  const countEl = document.getElementById(countId);
  if (countEl) countEl.textContent = '0 holdings';
  if (tbody) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9" style="color:var(--text-muted)">${errorMsg} — <a href="#" onclick="loadPortfolio();return false;" style="color:var(--accent);text-decoration:none;font-weight:700;">Retry ⟳</a></td></tr>`;
  }
}



export async function loadPortfolio() {
  try {
    const data = await api('/api/portfolio');
    const angelHoldings = data.angelone?.holdings || [];
    const growwHoldings = data.groww?.holdings || [];
    currentHoldingsCache = [...angelHoldings, ...growwHoldings];

    renderTable('tbodyAngelone', 'countAngelone', angelHoldings);
    renderTable('tbodyPortfolioAngelone', 'countPortfolioAngelone', angelHoldings);
    renderTable('tbodyGroww', 'countGroww', growwHoldings);
    renderTable('tbodyPortfolioGroww', 'countPortfolioGroww', growwHoldings);

    const missingCount = currentHoldingsCache.filter((h) => !h.error && h.daysHeld == null).length;
    const redDot = document.getElementById('settingsRedDotBadge');
    const alertBanner = document.getElementById('ulAlertBanner');
    if (redDot) {
      if (missingCount > 0) {
        redDot.style.display = 'block';
        redDot.title = `${missingCount} holding(s) missing Buy Dates — Click ⚙️ to configure`;
      } else {
        redDot.style.display = 'none';
      }
    }
    if (alertBanner) {
      alertBanner.style.display = missingCount > 0 ? 'flex' : 'none';
    }

    latestPortfolioData = data;
    updateSummaryCards(currentViewMode);

    updateBrokerFunds({
      angelone: data.angelone?.summary?.cashBalance,
      groww: data.groww?.summary?.cashBalance,
    });

    try {
      renderOrdersHistory();
    } catch (e) {
      console.error('renderOrdersHistory error:', e);
    }
  } catch (err) {
    console.error('portfolio load failed', err);
    renderTableError('tbodyAngelone', 'countAngelone', err.message);
    renderTableError('tbodyPortfolioAngelone', 'countPortfolioAngelone', err.message);
    renderTableError('tbodyGroww', 'countGroww', err.message);
    renderTableError('tbodyPortfolioGroww', 'countPortfolioGroww', err.message);
  }
}

function updateSummaryCards(mode = 'all') {
  if (!latestPortfolioData) return;

  let c = {};
  if (mode === 'angelone') {
    c = latestPortfolioData.angelone?.summary || {};
  } else if (mode === 'groww') {
    c = latestPortfolioData.groww?.summary || {};
  } else {
    c = (latestPortfolioData.combined?.summary || latestPortfolioData.combined) || {};
  }

  // Dashboard View Cards (#view-dashboard)
  setText('sumInvested', money(c.investedAmount));
  setText('sumCurrent', money(c.currentAmount));
  setGrowwPlCard('sumOverall', 'lblOverall', 'iconOverall', c.overallPL, c.overallPLPercent, 'Overall', c.investedAmount);
  setGrowwPlCard('sumToday', 'lblToday', 'iconToday', c.todayPL, c.todayPLPercent, 'Today\'s', c.investedAmount);
  setPl('sumGross', c.grossPL);

  // Portfolio View Groww Hero Dark Banner (#view-portfolio)
  setText('heroCurrentValue', money(c.currentAmount));
  setText('heroInvestedValue', money(c.investedAmount));
  
  const heroOverallEl = document.getElementById('heroOverallValue');
  if (heroOverallEl) {
    const ovNum = Number(c.overallPL || 0);
    const ovPct = Number(c.overallPLPercent || 0);
    const signPct = ovPct >= 0 ? `+${ovPct.toFixed(2)}%` : `${ovPct.toFixed(2)}%`;
    heroOverallEl.textContent = `${plSign(ovNum)}${money(ovNum)} (${signPct})`;
    heroOverallEl.style.color = ovNum >= 0 ? '#00B386' : '#EB5B56';
  }

  const heroTodayEl = document.getElementById('heroTodayPl');
  if (heroTodayEl) {
    const tdNum = Number(c.todayPL || 0);
    heroTodayEl.textContent = `${plSign(tdNum)}${money(tdNum)}`;
    heroTodayEl.style.color = tdNum >= 0 ? '#00B386' : '#EB5B56';
  }

  // Portfolio View 4 Light Cards (#view-portfolio)
  setPctVal('portSumXirr', c.xirr);
  setPctVal('portSumCagr', c.accountReturnPercent || c.cagr);
  setPl('portSumGross', c.grossPL);
  setPl('portSumAccountPl', c.accountPL);
  setText('portSumAdjAccountPl', money(c.totalAccruedCharges));
  setText('portSumCashInvested', money(c.ownCapitalInvested));

  // Topbar Cash Balance & Cash Breakdown Popover Dropdown (Colored Red if Negative)
  const angelCash = latestPortfolioData?.angelone?.summary?.cashBalance != null ? latestPortfolioData.angelone.summary.cashBalance : -185.08;
  const growwCash = latestPortfolioData?.groww?.summary?.cashBalance != null ? latestPortfolioData.groww.summary.cashBalance : 134.21;
  const totalCash = c.cashBalance != null ? c.cashBalance : (angelCash + growwCash);

  setColoredCash('topbarCashValue', totalCash);
  setColoredCash('angelCashFundVal', angelCash);
  setColoredCash('growwCashFundVal', growwCash);
  setColoredCash('totalCashFundVal', totalCash);

  setText('pnlCardValue', money(c.todayPL));
  const pnlSubEl = document.getElementById('pnlCardSub');
  if (pnlSubEl) {
    const todayPct = c.investedAmount ? (c.todayPL / c.investedAmount) * 100 : 0;
    pnlSubEl.textContent = `${plSign(c.todayPL)}${money(c.todayPL)} (${pct(todayPct)})`;
    pnlSubEl.style.color = c.todayPL >= 0 ? 'var(--gain)' : 'var(--loss)';
  }
}

function setColoredCash(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const num = Number(val) || 0;
  el.textContent = money(num);
  if (num < 0) {
    el.style.color = 'var(--loss)';
    el.style.fontWeight = '700';
  } else if (num > 0) {
    el.style.color = 'var(--gain)';
    el.style.fontWeight = '700';
  } else {
    el.style.color = 'var(--text-primary)';
  }
}

function updateCardTrendIcon(valueElId, val) {
  // ONLY update trend arrow icon for Today's P&L cards!
  if (valueElId !== 'sumToday' && valueElId !== 'portSumToday') return;

  const valueEl = document.getElementById(valueElId);
  if (!valueEl) return;
  const card = valueEl.closest('.stat-card');
  if (!card) return;
  const iconWrap = card.querySelector('.stat-badge-icon');
  if (!iconWrap) return;

  const num = Number(val) || 0;
  const isGain = num >= 0;

  iconWrap.classList.remove('badge-green', 'badge-red');
  iconWrap.classList.add(isGain ? 'badge-green' : 'badge-red');

  const upSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>`;
  const downSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline><polyline points="17 18 23 18 23 12"></polyline></svg>`;

  iconWrap.innerHTML = isGain ? upSvg : downSvg;
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setPctVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const num = Number(val) || 0;
  const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
  el.textContent = `${sign}${Math.abs(num).toFixed(2)}%`;
  el.style.color = num >= 0 ? 'var(--gain)' : 'var(--loss)';
  updateCardTrendIcon(id, num);
}
function setPl(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = money(value);
  const base = el.className.split(' ').filter((c) => c !== 'pl-positive' && c !== 'pl-negative').join(' ');
  el.className = `${base} ${plClass(value)}`.trim();
  updateCardTrendIcon(id, value);
}

function setGrowwPlCard(valId, labelId, iconId, plVal, plPct, defaultLabel = 'Overall', invAmt = 0) {
  const valEl = document.getElementById(valId);
  const lblEl = document.getElementById(labelId);
  const iconEl = document.getElementById(iconId);

  const num = Number(plVal || 0);
  let pctNum = Number(plPct);
  if (isNaN(pctNum) || plPct == null) {
    pctNum = invAmt > 0 ? (num / invAmt) * 100 : 0;
  }
  const isLoss = num < 0;

  if (lblEl) {
    lblEl.textContent = isLoss ? `${defaultLabel} Loss` : `${defaultLabel} Profit`;
  }

  if (valEl) {
    const absValStr = Math.abs(num).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const signPct = pctNum >= 0 ? `+${pctNum.toFixed(2)}%` : `${pctNum.toFixed(2)}%`;
    valEl.innerHTML = `₹${absValStr} <span style="font-size:12px;font-weight:600;margin-left:4px;">${signPct}</span>`;
    valEl.style.color = isLoss ? 'var(--loss)' : 'var(--gain)';
  }

  if (iconEl) {
    iconEl.className = `stat-badge-icon ${isLoss ? 'badge-red' : 'badge-green'}`;
    iconEl.innerHTML = isLoss ? `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 18 13.5 8.5 8.5 13.5 1 6"></polyline>
        <polyline points="17 18 23 18 23 12"></polyline>
      </svg>
    ` : `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
        <polyline points="17 6 23 6 23 12"></polyline>
      </svg>
    `;
  }
}

export function initPortfolio() {
  document.querySelectorAll('[data-view-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.viewMode;
      currentViewMode = mode;

      document.querySelectorAll('[data-view-mode]').forEach((b) => {
        if (b.dataset.viewMode === mode) {
          b.classList.add('active');
        } else {
          b.classList.remove('active');
        }
      });

      ['dashboardPanels', 'portfolioPanels'].forEach((containerId) => {
        const panelsContainer = document.getElementById(containerId);
        if (!panelsContainer) return;
        const panelAngel = panelsContainer.querySelector('[id*="Angelone"]');
        const panelGroww = panelsContainer.querySelector('[id*="Groww"]');

        if (mode === 'all') {
          panelsContainer.classList.remove('single-view');
          if (panelAngel) panelAngel.style.display = 'flex';
          if (panelGroww) panelGroww.style.display = 'flex';
        } else if (mode === 'angelone') {
          panelsContainer.classList.add('single-view');
          if (panelAngel) panelAngel.style.display = 'flex';
          if (panelGroww) panelGroww.style.display = 'none';
        } else if (mode === 'groww') {
          panelsContainer.classList.add('single-view');
          if (panelAngel) panelAngel.style.display = 'none';
          if (panelGroww) panelGroww.style.display = 'flex';
        }
      });

      updateSummaryCards(mode);
    });
  });

  document.querySelectorAll('.refresh-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.currentTarget.classList.add('spinning');
      loadPortfolio().finally(() => setTimeout(() => e.currentTarget.classList.remove('spinning'), 600));
    });
  });

  const cashPill = document.getElementById('cashCardPill');
  const cashPopover = document.getElementById('cashPopover');
  if (cashPill && cashPopover) {
    cashPill.addEventListener('click', (e) => {
      e.stopPropagation();
      cashPopover.classList.toggle('show');
    });
  }

  document.addEventListener('click', (e) => {
    const stockBtn = e.target.closest('[data-action="order"]');
    if (stockBtn) {
      const symbol = stockBtn.dataset.symbol;
      const ltp = Number(stockBtn.dataset.ltp) || 0;
      const broker = stockBtn.dataset.broker || 'angelone';
      openOrderTicketModal({ symbol, ltp, broker });
    }
  });

  initSettingsPopover();
}

function initSettingsPopover() {
  const openSettingsBtn = document.getElementById('openUnifiedLedgerBtn');
  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeSettingsBroker = 'angelone';
      document.querySelectorAll('[data-broker-tab]').forEach((b) => b.classList.toggle('active', b.dataset.brokerTab === 'angelone'));
      populateHoldingDropdown();
      document.getElementById('ulBuyDate').value = new Date().toISOString().slice(0, 10);
      document.getElementById('ulCapDate').value = new Date().toISOString().slice(0, 10);
      loadCapitalLogs();
      loadLedgerSummary();
      togglePopover('portfolioSettingsPopover', 'openUnifiedLedgerBtn');
    });
  }

  const closeSettingsBtn = document.getElementById('closeSettingsPopoverBtn');
  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
      document.getElementById('portfolioSettingsPopover').classList.remove('show');
      openSettingsBtn.classList.remove('active');
    });
  }

  document.querySelectorAll('[data-broker-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('[data-broker-tab]').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      activeSettingsBroker = tabBtn.dataset.brokerTab;
      populateHoldingDropdown();
      loadCapitalLogs();
      loadLedgerSummary();
    });
  });

  document.getElementById('ulSelectHolding').addEventListener('change', () => {
    const sel = document.getElementById('ulSelectHolding');
    const opt = sel.options[sel.selectedIndex];
    if (opt && opt.value) {
      const sym = opt.dataset.symbol;
      const isMtf = opt.dataset.ismtf === '1';
      const remQty = Number(opt.dataset.remqty);
      const totalQty = Number(opt.dataset.qty);
      const qtyToSet = (remQty > 0) ? remQty : totalQty;

      const qtyInp = document.getElementById('ulQtyInput');
      if (qtyInp) qtyInp.value = qtyToSet;

      document.getElementById('ulIsMtf').value = isMtf ? '1' : '0';
      const curRatio = STOCK_LEVERAGE_DEFAULTS[sym] || STOCK_LEVERAGE_DEFAULTS[sym.replace('-EQ', '')] || '2.9';
      document.getElementById('ulMtfCustomInput').value = curRatio;
      const selectRatioEl = document.getElementById('ulMtfRatio');
      if (selectRatioEl) {
        const matchingOpt = Array.from(selectRatioEl.options).find((o) => o.value === String(curRatio));
        if (matchingOpt) selectRatioEl.value = String(curRatio);
        else selectRatioEl.value = 'custom';
      }
    }
    updateUlMtfPreview();
  });

  const qtyInputEl = document.getElementById('ulQtyInput');
  if (qtyInputEl) qtyInputEl.addEventListener('input', updateUlMtfPreview);

  document.getElementById('ulBuyDate').addEventListener('change', updateUlMtfPreview);
  document.getElementById('ulIsMtf').addEventListener('change', updateUlMtfPreview);
  document.getElementById('ulMtfRatio').addEventListener('change', (e) => {
    const customInp = document.getElementById('ulMtfCustomInput');
    if (e.target.value !== 'custom' && customInp) {
      customInp.value = e.target.value;
    }
    updateUlMtfPreview();
  });
  document.getElementById('ulMtfCustomInput').addEventListener('input', updateUlMtfPreview);

  const ulTargetPrice = document.getElementById('ulTargetPrice');
  const ulTargetPct = document.getElementById('ulTargetPct');
  const ulSlPrice = document.getElementById('ulSlPrice');
  const ulSlPct = document.getElementById('ulSlPct');

  if (ulTargetPrice && ulTargetPct) {
    ulTargetPrice.addEventListener('input', () => {
      const sel = document.getElementById('ulSelectHolding');
      const opt = sel.options[sel.selectedIndex];
      const avgPrice = Number(opt?.dataset.price) || 0;
      const tgtVal = Number(ulTargetPrice.value);
      if (avgPrice > 0 && tgtVal > 0) {
        ulTargetPct.value = (((tgtVal - avgPrice) / avgPrice) * 100).toFixed(2);
      }
    });

    ulTargetPct.addEventListener('input', () => {
      const sel = document.getElementById('ulSelectHolding');
      const opt = sel.options[sel.selectedIndex];
      const avgPrice = Number(opt?.dataset.price) || 0;
      const pctVal = Number(ulTargetPct.value);
      if (avgPrice > 0 && !isNaN(pctVal)) {
        ulTargetPrice.value = (avgPrice * (1 + pctVal / 100)).toFixed(2);
      }
    });
  }

  if (ulSlPrice && ulSlPct) {
    ulSlPrice.addEventListener('input', () => {
      const sel = document.getElementById('ulSelectHolding');
      const opt = sel.options[sel.selectedIndex];
      const avgPrice = Number(opt?.dataset.price) || 0;
      const slVal = Number(ulSlPrice.value);
      if (avgPrice > 0 && slVal > 0) {
        ulSlPct.value = (((slVal - avgPrice) / avgPrice) * 100).toFixed(2);
      }
    });

    ulSlPct.addEventListener('input', () => {
      const sel = document.getElementById('ulSelectHolding');
      const opt = sel.options[sel.selectedIndex];
      const avgPrice = Number(opt?.dataset.price) || 0;
      const pctVal = Number(ulSlPct.value);
      if (avgPrice > 0 && !isNaN(pctVal)) {
        ulSlPrice.value = (avgPrice * (1 - Math.abs(pctVal) / 100)).toFixed(2);
      }
    });
  }

  document.getElementById('ulMtfForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = document.getElementById('ulSelectHolding');
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return alert('Please select a stock holding');

    const symbol = opt.dataset.symbol;
    const cleanSym = symbol.replace('-EQ', '');
    const broker = opt.dataset.broker;
    const isMtf = document.getElementById('ulIsMtf').value === '1';
    const customVal = Number(document.getElementById('ulMtfCustomInput').value);
    const selectVal = Number(document.getElementById('ulMtfRatio').value);
    const mtfLeverage = (!isNaN(customVal) && customVal > 0) ? customVal : ((!isNaN(selectVal) && selectVal > 0) ? selectVal : 2.9);

    // Persist custom ratio dynamically into leverage defaults mapping!
    STOCK_LEVERAGE_DEFAULTS[symbol] = String(mtfLeverage);
    STOCK_LEVERAGE_DEFAULTS[cleanSym] = String(mtfLeverage);
    STOCK_LEVERAGE_DEFAULTS[`${cleanSym}-EQ`] = String(mtfLeverage);

    const body = {
      tradingsymbol: symbol,
      exchange: 'NSE',
      quantity: Number(document.getElementById('ulQtyInput').value) || Number(opt.dataset.qty),
      avgPrice: Number(opt.dataset.price),
      tradeDate: document.getElementById('ulBuyDate').value,
      isMtf,
      mtfLeverage,
    };

    try {
      await api(`/api/${broker}/ledger/holding-settings`, { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('portfolioSettingsPopover').classList.remove('show');
      const openBtn = document.getElementById('openUnifiedLedgerBtn');
      if (openBtn) openBtn.classList.remove('active');
      loadPortfolio();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('ulCapitalForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      type: document.getElementById('ulCapType').value,
      amount: Number(document.getElementById('ulCapAmount').value),
      txnDate: document.getElementById('ulCapDate').value,
    };

    try {
      await api(`/api/${activeSettingsBroker}/ledger/funds`, { method: 'POST', body: JSON.stringify(body) });
      document.getElementById('ulCapAmount').value = '';
      await loadCapitalLogs();
      await loadLedgerSummary();
      await loadPortfolio();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById('editChargesBtn').addEventListener('click', () => {
    const wrap = document.getElementById('chargesEditWrap');
    const input = document.getElementById('customChargesInput');
    const isHidden = wrap.style.display === 'none';
    if (isHidden && input && !input.value) {
      const autoVal = input.getAttribute('data-auto-val') || '0.00';
      input.value = autoVal;
    }
    wrap.style.display = isHidden ? 'block' : 'none';
  });

  document.getElementById('saveChargesBtn').addEventListener('click', async () => {
    const val = document.getElementById('customChargesInput').value;
    if (!val) return;
    try {
      await api(`/api/${activeSettingsBroker}/ledger/override`, { method: 'POST', body: JSON.stringify({ customCharges: Number(val) }) });
      document.getElementById('chargesEditWrap').style.display = 'none';
      await loadLedgerSummary();
      await loadPortfolio();
    } catch (err) { console.error('Save charges failed:', err); }
  });

  document.getElementById('resetChargesBtn').addEventListener('click', async () => {
    try {
      await api(`/api/${activeSettingsBroker}/ledger/override`, { method: 'POST', body: JSON.stringify({ customCharges: null }) });
      await loadLedgerSummary();
      const input = document.getElementById('customChargesInput');
      if (input) input.value = input.getAttribute('data-auto-val') || '0.00';
      await loadPortfolio();
    } catch (err) { console.error('Reset charges failed:', err); }
  });

  document.getElementById('editMtfIntBtn').addEventListener('click', () => {
    const wrap = document.getElementById('mtfIntEditWrap');
    const input = document.getElementById('customMtfIntInput');
    const isHidden = wrap.style.display === 'none';
    if (isHidden && input && !input.value) {
      const autoVal = input.getAttribute('data-auto-val') || '0.00';
      input.value = autoVal;
    }
    wrap.style.display = isHidden ? 'block' : 'none';
  });

  document.getElementById('saveMtfIntBtn').addEventListener('click', async () => {
    const val = document.getElementById('customMtfIntInput').value;
    if (!val) return;
    try {
      await api(`/api/${activeSettingsBroker}/ledger/override`, { method: 'POST', body: JSON.stringify({ customMtfInterest: Number(val) }) });
      document.getElementById('mtfIntEditWrap').style.display = 'none';
      await loadLedgerSummary();
      await loadPortfolio();
    } catch (err) { console.error('Save MTF interest failed:', err); }
  });

  document.getElementById('resetMtfIntBtn').addEventListener('click', async () => {
    try {
      await api(`/api/${activeSettingsBroker}/ledger/override`, { method: 'POST', body: JSON.stringify({ customMtfInterest: null }) });
      await loadLedgerSummary();
      const input = document.getElementById('customMtfIntInput');
      if (input) input.value = input.getAttribute('data-auto-val') || '0.00';
      await loadPortfolio();
    } catch (err) { console.error('Reset MTF interest failed:', err); }
  });
}

function populateHoldingDropdown(selectedKey = '') {
  const sel = document.getElementById('ulSelectHolding');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Choose Stock Holding --</option>';

  const brokerHoldings = currentHoldingsCache.filter((h) => h.broker === activeSettingsBroker && h.tradingsymbol && !h.error);

  brokerHoldings.forEach((h) => {
    const key = `${h.broker}:${h.tradingsymbol}`;
    const opt = document.createElement('option');
    opt.value = key;
    opt.dataset.broker = h.broker;
    opt.dataset.symbol = h.tradingsymbol;
    opt.dataset.qty = h.quantity;
    opt.dataset.remqty = h.remainingQty != null ? h.remainingQty : h.quantity;
    opt.dataset.price = h.avgPrice;
    opt.dataset.ismtf = h.isMtf ? '1' : '0';
    opt.dataset.isfully = h.isFullyConfigured ? '1' : '0';
    
    let statusTag = '';
    if (h.isFullyConfigured || h.remainingQty === 0) {
      statusTag = ` (${h.daysHeld != null ? h.daysHeld : 0}d held)`;
    } else {
      const rem = h.remainingQty != null ? h.remainingQty : h.quantity;
      statusTag = ` 🔴 (${rem} / ${h.quantity} unassigned)`;
    }

    opt.textContent = `${h.tradingsymbol} — ${h.quantity} Qty @ ₹${rawMoney(h.avgPrice)}${statusTag}`;
    if (key === selectedKey) opt.selected = true;
    sel.appendChild(opt);
  });
}

function updateUlMtfPreview() {
  const sel = document.getElementById('ulSelectHolding');
  const opt = sel.options[sel.selectedIndex];
  if (!opt || !opt.value) {
    document.getElementById('ulPrevDays').textContent = '0 days';
    document.getElementById('ulPrevSelfFunded').textContent = '₹0.00';
    document.getElementById('ulPrevBorrowed').textContent = '₹0.00';
    document.getElementById('ulPrevDailyInt').textContent = '₹0.00 / day';
    return;
  }

  const symbol = opt.dataset.symbol;
  const qty = Number(document.getElementById('ulQtyInput')?.value) || Number(opt.dataset.qty) || 0;
  const price = Number(opt.dataset.price) || 0;
  const tradeDateStr = document.getElementById('ulBuyDate').value;
  const isMtf = document.getElementById('ulIsMtf').value === '1';

  const customInpVal = Number(document.getElementById('ulMtfCustomInput')?.value);
  const ratioSelVal = Number(document.getElementById('ulMtfRatio')?.value);
  const leverage = (!isNaN(customInpVal) && customInpVal > 0) ? customInpVal : ((!isNaN(ratioSelVal) && ratioSelVal > 0) ? ratioSelVal : 2.9);

  document.getElementById('ulMtfRatioGroup').style.display = isMtf ? 'block' : 'none';

  const totalVal = qty * price;
  const selfFunded = isMtf ? totalVal / leverage : totalVal;
  const borrowed = isMtf ? totalVal - selfFunded : 0;

  const buyPlus1 = new Date(tradeDateStr);
  buyPlus1.setDate(buyPlus1.getDate() + 1);
  const today = new Date();
  const diffMs = Math.max(0, today.getTime() - buyPlus1.getTime());
  const daysHeld = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const dailyInterestRate = 0.00041;
  const dailyInterest = borrowed * dailyInterestRate;

  document.getElementById('ulPrevDays').textContent = `${daysHeld} days`;
  document.getElementById('ulPrevSelfFunded').textContent = money(selfFunded);
  document.getElementById('ulPrevBorrowed').textContent = money(borrowed);
  document.getElementById('ulPrevDailyInt').textContent = isMtf ? `-₹${rawMoney(dailyInterest)} / day` : '₹0.00 / day';
}

async function loadCapitalLogs() {
  const container = document.getElementById('ulCapitalHistoryList');
  if (!container) return;
  container.textContent = 'Loading logs...';
  try {
    const res = await api(`/api/${activeSettingsBroker}/ledger/funds`).catch(() => ({ transactions: [], totals: { totalAdded: 0, totalWithdrawn: 0, net: 0 } }));
    const txns = (res.transactions || []).sort((a, b) => (a.txn_date < b.txn_date ? 1 : -1));

    const totals = res.totals || { totalAdded: 0, totalWithdrawn: 0, net: 0 };
    document.getElementById('sumCapAdded').textContent = money(totals.totalAdded);
    document.getElementById('sumCapWithdrawn').textContent = money(totals.totalWithdrawn);
    document.getElementById('sumNetCapital').textContent = money(totals.net);

    if (!txns.length) {
      container.innerHTML = `<div style="color:var(--text-muted);padding:4px 0;">No ${activeSettingsBroker === 'angelone' ? 'Angel One' : 'Groww'} deposits/withdrawals logged</div>`;
      return;
    }

    container.innerHTML = txns
      .map(
        (t) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:3.5px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;align-items:center;gap:6px;">
          <button type="button" class="del-funds-btn" data-id="${t.id}" title="Delete Transaction" style="background:none;border:none;color:var(--text-muted);cursor:pointer;padding:0 2px;display:inline-flex;align-items:center;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
          <span>${t.txn_date} — ${t.type === 'ADD' ? '+ Add' : '- Withdraw'}</span>
        </div>
        <b class="${t.type === 'ADD' ? 'pl-positive' : 'pl-negative'}">${t.type === 'ADD' ? '+' : '-'}${money(t.amount)}</b>
      </div>`
      )
      .join('');

    container.querySelectorAll('.del-funds-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        if (!id) return;
        if (confirm('Delete this capital transaction record?')) {
          try {
            await api(`/api/${activeSettingsBroker}/ledger/funds/${id}`, { method: 'DELETE' });
            await loadCapitalLogs();
            await loadLedgerSummary();
            await loadPortfolio();
          } catch (err) {
            alert('Failed to delete transaction: ' + err.message);
          }
        }
      });
    });
  } catch (err) {
    container.textContent = 'Failed to load logs';
  }
}

async function loadLedgerSummary() {
  try {
    const [brokerFunds, override, port] = await Promise.all([
      api(`/api/${activeSettingsBroker}/ledger/funds`).catch(() => ({ totals: { totalAdded: 0, totalWithdrawn: 0, net: 0 } })),
      api(`/api/${activeSettingsBroker}/ledger/override`).catch(() => ({ custom_charges: null, custom_mtf_interest: null })),
      api('/api/portfolio').catch(() => ({ combined: {} })),
    ]);

    const c = port.combined || {};
    const holdings = (port[activeSettingsBroker]?.holdings || []);

    let autoCharges = 0;
    let autoMtfInt = 0;

    holdings.forEach((h) => {
      autoCharges += (h.buyCharges || 0) + (h.estimatedSellCharges || 0);
      autoMtfInt += h.mtfInterestAccrued || 0;
    });

    const finalCharges = override.custom_charges != null ? override.custom_charges : autoCharges;
    const finalMtfInt = override.custom_mtf_interest != null ? override.custom_mtf_interest : autoMtfInt;

    const chargesEl = document.getElementById('sumTotalCharges');
    if (chargesEl) {
      chargesEl.textContent = `-₹${rawMoney(finalCharges)}`;
      chargesEl.title = override.custom_charges != null ? 'Manually Overridden Value' : 'Auto-Calculated Daily Value';
    }

    const chargesInput = document.getElementById('customChargesInput');
    if (chargesInput) {
      chargesInput.setAttribute('data-auto-val', autoCharges.toFixed(2));
      chargesInput.value = (override.custom_charges != null ? override.custom_charges : autoCharges).toFixed(2);
    }

    const mtfEl = document.getElementById('sumTotalMtfInt');
    if (mtfEl) {
      mtfEl.textContent = `-₹${rawMoney(finalMtfInt)}`;
      mtfEl.title = override.custom_mtf_interest != null ? 'Manually Overridden Value' : 'Auto-Calculated Daily Value (0.041%/day)';
    }

    const mtfInput = document.getElementById('customMtfIntInput');
    if (mtfInput) {
      mtfInput.setAttribute('data-auto-val', autoMtfInt.toFixed(2));
      mtfInput.value = (override.custom_mtf_interest != null ? override.custom_mtf_interest : autoMtfInt).toFixed(2);
    }

    const grossNet = (c.overallPL || 0) - finalCharges - finalMtfInt;
    setPl('sumGrossNetPnl', grossNet);
  } catch (err) {
    console.error('summary load failed', err);
  }
}
