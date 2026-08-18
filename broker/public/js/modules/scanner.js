/**
 * public/js/modules/scanner.js
 * AMFI Stock Accumulation & Distribution Scanner Module
 * Features:
 *  - Inline Accordion Drawer (Click ▼ arrow on stock row to expand mutual fund holdings, ranks & weightage %)
 *  - Clean Stock Names (No stock ranks or numbers in stock names)
 *  - Numbered Mutual Fund Scheme Names (1. Kotak Bluechip Direct Growth, 2. SBI Small Cap Direct Growth...)
 *  - Dynamic Timeframe Ranking for Mutual Funds based on selected period (1M, 3M, 6M, 1Y Return %)
 *  - Click `🏥 490 Funds` or `📈 +162 Funds Increased` to view pop-up modal or expand inline tray
 */

import { api } from '../core/api.js';

let currentPeriod = '3m';
let currentSortBy = 'growth';
let currentSortOrder = 'DESC';

let isStarredOnlyMode = false;

function getStarredStocks() {
  try {
    return JSON.parse(localStorage.getItem('gb_starred_stocks') || '[]');
  } catch (e) {
    return [];
  }
}

function saveStarredStocks(list) {
  try {
    localStorage.setItem('gb_starred_stocks', JSON.stringify(list));
    updateStarredBadge();
  } catch (e) {}
}

function toggleStarStock(symbol) {
  const list = getStarredStocks();
  const idx = list.indexOf(symbol);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(symbol);
  saveStarredStocks(list);
  loadInstitutionalScannerData();
}

function updateStarredBadge() {
  const count = getStarredStocks().length;
  const lbl = document.getElementById('starredBtnLabel');
  if (lbl) lbl.textContent = `Starred Watchlist (${count})`;
}

export function initInstitutionalScanner() {
  updateStarredBadge();
  loadInstitutionalScannerData();

  // Timeframe period dropdown change listener
  const periodSelect = document.getElementById('instPeriodSelect');
  if (periodSelect) {
    periodSelect.addEventListener('change', (e) => {
      currentPeriod = e.target.value;
      loadInstitutionalScannerData();
    });
  }

  // Live filter dropdown listeners
  ['instTrendFilter', 'instMinFundsFilter', 'instMinValueFilter'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => loadInstitutionalScannerData());
    }
  });

  // Toggle Starred Watchlist Only button
  const starBtn = document.getElementById('toggleStarredOnlyBtn');
  if (starBtn) {
    starBtn.addEventListener('click', () => {
      isStarredOnlyMode = !isStarredOnlyMode;
      starBtn.classList.toggle('submit-btn--primary', isStarredOnlyMode);
      starBtn.classList.toggle('submit-btn--secondary', !isStarredOnlyMode);
      loadInstitutionalScannerData();
    });
  }

  // Handle Triangle Sort Button Clicks on Header
  document.querySelectorAll('.sort-triangle-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sortField = btn.dataset.sort;

      if (currentSortBy === sortField) {
        currentSortOrder = currentSortOrder === 'DESC' ? 'ASC' : 'DESC';
      } else {
        currentSortBy = sortField;
        currentSortOrder = 'DESC';
      }

      updateSortUi(btn);
      loadInstitutionalScannerData();
    });
  });

  // Sort direction toggle button in header
  const dirBtn = document.getElementById('toggleSortDirectionBtn');
  if (dirBtn) {
    dirBtn.addEventListener('click', () => {
      currentSortOrder = currentSortOrder === 'DESC' ? 'ASC' : 'DESC';
      updateSortLabel();
      loadInstitutionalScannerData();
    });
  }

  // Close modal button
  const closeBtn = document.getElementById('closeInstModalBtn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const modal = document.getElementById('instModal');
      if (modal) {
        modal.style.display = 'none';
        modal.classList.remove('open');
      }
    });
  }
}

function updateSortUi(activeBtn) {
  document.querySelectorAll('.sort-triangle-btn').forEach((b) => b.classList.remove('active'));
  if (activeBtn) activeBtn.classList.add('active');
  updateSortLabel();
}

function updateSortLabel() {
  const lbl = document.getElementById('sortDirectionLabel');
  if (lbl) {
    lbl.textContent = currentSortOrder === 'DESC' ? 'DESC (High to Low)' : 'ASC (Low to High)';
  }
}

export async function loadInstitutionalScannerData() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/stock-summary?period=${currentPeriod}&sortBy=${currentSortBy}&sortOrder=${currentSortOrder}`);
    let rows = res.data || [];

    // Apply Live Filters
    const trendVal = document.getElementById('instTrendFilter')?.value || 'ALL';
    const minFundsVal = Number(document.getElementById('instMinFundsFilter')?.value || 0);
    const minValCr = Number(document.getElementById('instMinValueFilter')?.value || 0);
    const starredList = getStarredStocks();

    rows = rows.filter((r) => {
      const growthVal = Number(r.active_growth != null ? r.active_growth : (r.growth_3m || 0));
      const changedCount = Number(r.active_institutes_changed != null ? r.active_institutes_changed : (r.funds_changed_3m || 0));
      const isSelling = growthVal < 0 || changedCount < 0;

      if (trendVal === 'BUYING' && isSelling) return false;
      if (trendVal === 'SELLING' && !isSelling) return false;
      if (r.total_institutes_count < minFundsVal) return false;
      if (Number(r.total_mf_holding_cr || 0) < minValCr) return false;
      if (isStarredOnlyMode && !starredList.includes(r.symbol)) return false;
      return true;
    });

    if (rows.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No matching institutional accumulation data found</td></tr>';
      return;
    }

    const periodLabel = currentPeriod === '1m' ? '1M' : (currentPeriod === '6m' ? '6M' : (currentPeriod === '1y' ? '1Y' : '3M'));

    tbody.innerHTML = rows.map((r) => {
      const growthVal = Number(r.active_growth != null ? r.active_growth : (r.growth_3m || 0));
      const growthColor = growthVal >= 0 ? 'var(--gain)' : 'var(--loss)';
      const growthSign = growthVal >= 0 ? '▲ +' : '▼ ';

      const ltpVal = Number(r.ltp || 0);
      const prChg = Number(r.price_change_pct || 0);
      const prColor = prChg >= 0 ? 'var(--gain)' : 'var(--loss)';
      const prSign = prChg >= 0 ? '+' : '';

      const totalInstCount = r.total_institutes_count || 0;
      const changedCount = Number(r.active_institutes_changed != null ? r.active_institutes_changed : (r.funds_changed_3m || 0));

      const isSelling = growthVal < 0 || changedCount < 0;
      const trendBadgeText = isSelling ? `📉 ${changedCount} Funds Sold` : `📈 +${changedCount} Funds Increased`;
      const trendBg = isSelling ? 'background:rgba(255, 77, 109, 0.14);color:var(--loss);border:1px solid rgba(255, 77, 109, 0.3);' : 'background:rgba(0, 230, 153, 0.14);color:var(--gain);border:1px solid rgba(0, 230, 153, 0.3);';

      const isStarred = starredList.includes(r.symbol);
      const starColor = isStarred ? '#f59e0b' : 'var(--text-muted)';

      return `
        <tr class="inst-row" data-symbol="${r.symbol}">
          <td style="text-align:center;padding:12px 6px;">
            <div style="display:flex;align-items:center;justify-content:center;gap:4px;">
              <button class="star-stock-btn" data-symbol="${r.symbol}" title="Add/Remove from Starred Watchlist" style="background:transparent;border:none;color:${starColor};font-size:14px;cursor:pointer;padding:0 2px;">
                ${isStarred ? '★' : '☆'}
              </button>
              <button class="edit-icon-btn toggle-accordion-btn" data-symbol="${r.symbol}" title="Click arrow to expand inline mutual fund holdings, ranks & weightage %" style="width:24px;height:24px;border-radius:50%;background:var(--bg-raised);color:var(--accent);border:1px solid var(--line);font-size:10px;font-weight:900;cursor:pointer;">
                ▼
              </button>
            </div>
          </td>
          <td style="white-space:nowrap;padding:12px 14px;">
            <div style="font-weight:800;color:var(--text-primary);font-size:13px;display:flex;align-items:center;gap:6px;">
              <span>${r.company_name}</span>
              <span class="days-pill" style="font-size:9.5px;padding:2px 6px;">${r.symbol}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${r.sector || 'NSE/BSE Equity'}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);white-space:nowrap;padding:12px 14px;">
            <div style="font-weight:800;color:var(--text-primary);">₹${ltpVal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
            <div style="font-size:10.5px;font-weight:700;color:${prColor};">${prSign}${prChg.toFixed(2)}%</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${growthColor};font-size:13px;white-space:nowrap;padding:12px 14px;">
            <div>${growthSign}${growthVal.toFixed(2)}%</div>
            <div style="font-size:10px;color:var(--text-muted);font-weight:400;">(${periodLabel} ${isSelling ? 'Reduction' : 'Growth'})</div>
          </td>
          <td style="text-align:center;white-space:nowrap;padding:12px 14px;">
            <span class="days-pill inst-badge-btn open-all-funds-btn" data-symbol="${r.symbol}" style="background:var(--accent-dim);color:var(--accent-cyan);font-weight:800;padding:6px 14px;border-radius:14px;border:1px solid var(--accent-dim-strong);cursor:pointer;" title="Click to view all ${totalInstCount} funds ranked by ${periodLabel} performance">
              🏥 ${totalInstCount} Funds
            </span>
          </td>
          <td style="text-align:center;white-space:nowrap;padding:12px 14px;">
            <span class="days-pill open-trend-funds-btn" data-symbol="${r.symbol}" data-action="${isSelling ? 'DECREASED' : 'INCREASED'}" style="${trendBg}font-weight:800;padding:6px 14px;border-radius:14px;cursor:pointer;" title="Click to view ${changedCount} ${isSelling ? 'selling' : 'added'} mutual funds">
              ${trendBadgeText}
            </span>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--gain);white-space:nowrap;padding:12px 14px;">${Number(r.avg_weightage_pct || 0).toFixed(2)}%</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--accent-cyan);white-space:nowrap;padding:12px 14px;">₹${Number(r.total_mf_holding_cr || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Cr</td>
        </tr>
        <tr class="accordion-tray-row" id="tray-${r.symbol}" style="display:none;background:var(--bg-body);">
          <td colspan="8" style="padding:14px 18px;border-bottom:2px solid var(--accent);">
            <div id="tray-content-${r.symbol}" style="font-size:12px;">
              ⏳ Loading mutual fund holdings & weightage %...
            </div>
          </td>
        </tr>`;
    }).join('');

    // Attach click listeners for '★' star buttons
    document.querySelectorAll('.star-stock-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.symbol;
        if (sym) toggleStarStock(sym);
      });
    });

    // Attach click listeners for '▼' expand accordion buttons
    document.querySelectorAll('.toggle-accordion-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.symbol;
        if (sym) toggleAccordionTray(sym, btn);
      });
    });

    // Attach click listeners for '🏥 Funds' badge (ALL funds)
    document.querySelectorAll('.open-all-funds-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.symbol;
        if (sym) openSchemeBreakdownModal(sym, 'ALL');
      });
    });

    // Attach click listeners for '📈 Funds Increased' badge (ONLY added/buying funds)
    document.querySelectorAll('.open-trend-funds-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.dataset.symbol;
        const act = btn.dataset.action || 'INCREASED';
        if (sym) openSchemeBreakdownModal(sym, act);
      });
    });

    // Row click fallback (toggle accordion tray)
    document.querySelectorAll('.inst-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.open-all-funds-btn') || e.target.closest('.open-trend-funds-btn')) return;
        const sym = row.dataset.symbol;
        const btn = row.querySelector('.toggle-accordion-btn');
        if (sym) toggleAccordionTray(sym, btn);
      });
    });

  } catch (err) {
    console.error('loadInstitutionalScannerData error:', err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8" style="color:var(--loss);">Error loading stock scanner: ${err.message}</td></tr>`;
  }
}

export async function toggleAccordionTray(symbol, btn) {
  const tray = document.getElementById(`tray-${symbol}`);
  const content = document.getElementById(`tray-content-${symbol}`);
  if (!tray || !content) return;

  const isExpanded = tray.style.display !== 'none';
  if (isExpanded) {
    tray.style.display = 'none';
    if (btn) btn.textContent = '▼';
    return;
  }

  tray.style.display = 'table-row';
  if (btn) btn.textContent = '▲';

  content.innerHTML = `<div style="padding:10px;color:var(--accent);">⏳ Fetching mutual fund holdings & weightage % for <b>${symbol}</b>...</div>`;

  try {
    const res = await api(`/api/institutional/scheme-breakdown/${symbol}?period=${currentPeriod}`);
    const rows = res.data || [];

    if (rows.length === 0) {
      content.innerHTML = `<div style="padding:10px;color:var(--text-muted);">No mutual fund schemes recorded for ${symbol}</div>`;
      return;
    }

    const periodLabel = currentPeriod === '1m' ? '1 Month' : (currentPeriod === '6m' ? '6 Months' : (currentPeriod === '1y' ? '1 Year' : '3 Months'));
    const periodShort = currentPeriod === '1m' ? '1M' : (currentPeriod === '6m' ? '6M' : (currentPeriod === '1y' ? '1Y' : '3M'));

    content.innerHTML = `
      <div style="background:var(--bg-panel);border:1px solid var(--accent);border-radius:10px;padding:14px;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:1px solid var(--line);padding-bottom:8px;">
          <div style="font-size:13px;font-weight:800;color:var(--accent-cyan);">
            🏥 Mutual Fund Holdings for <b>${symbol}</b> (Ranked by ${periodLabel} Performance Return)
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="days-pill" style="background:rgba(0, 230, 153, 0.15);color:var(--gain);font-weight:800;font-size:11px;">
              Total: ${rows.length} Funds Holding
            </span>
            <button type="button" class="submit-btn submit-btn--secondary" style="font-size:10.5px;padding:4px 10px;" onclick="openSchemeBreakdownModal('${symbol}', 'ALL')">
              OPEN FULL MODAL POPUP ↗
            </button>
          </div>
        </div>

        <div style="max-height:280px;overflow-y:auto;">
          <table class="holdings-table" style="width:100%;font-size:12px;">
            <thead>
              <tr style="background:var(--bg-raised);">
                <th style="width:55px;text-align:center;">MF Rank</th>
                <th>Mutual Fund Scheme Name</th>
                <th>Fund House</th>
                <th style="text-align:center;">Monthly Action</th>
                <th style="text-align:right;">${periodShort} Return %</th>
                <th style="text-align:right;">Invested (₹ Cr)</th>
                <th style="text-align:right;">Weightage %</th>
              </tr>
            </thead>
            <tbody>
              ${rows.slice(0, 25).map(s => {
                const rankNum = s.rank || 1;
                const mfRet = Number(s.mf_return || 0);
                const actType = s.action_type || 'INCREASED';
                const shChg = Number(s.shares_changed || 0);

                let actionBadge = `<span class="days-pill" style="background:rgba(0, 230, 153, 0.14);color:var(--gain);font-weight:800;padding:2px 6px;font-size:10.5px;">📈 Added (+${shChg.toLocaleString('en-IN')})</span>`;
                if (actType === 'DECREASED' || shChg < 0) {
                  actionBadge = `<span class="days-pill" style="background:rgba(255, 77, 109, 0.14);color:var(--loss);font-weight:800;padding:2px 6px;font-size:10.5px;">📉 Sold (${shChg.toLocaleString('en-IN')})</span>`;
                } else if (actType === 'HELD' || shChg === 0) {
                  actionBadge = `<span class="days-pill" style="background:var(--bg-raised);color:var(--text-muted);font-weight:700;padding:2px 6px;font-size:10.5px;">➖ Held</span>`;
                }

                return `
                  <tr>
                    <td style="text-align:center;font-weight:900;font-family:var(--font-mono);color:var(--accent);">
                      ${rankNum}.
                    </td>
                    <td style="font-weight:700;color:var(--text-primary);font-size:12.5px;">
                      <b style="color:var(--accent);margin-right:4px;">${rankNum}.</b> ${s.scheme_name}
                    </td>
                    <td style="font-size:11px;color:var(--text-muted);">${s.fund_house || '—'}</td>
                    <td style="text-align:center;">${actionBadge}</td>
                    <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${mfRet >= 0 ? 'var(--gain)' : 'var(--loss)'};">${mfRet >= 0 ? '+' : ''}${mfRet.toFixed(2)}%</td>
                    <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--accent-cyan);">₹${Number(s.invested_value_cr || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Cr</td>
                    <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--gain);">${Number(s.weightage_pct || 0).toFixed(2)}%</td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } catch (err) {
    content.innerHTML = `<div style="padding:10px;color:var(--loss);">Error loading accordion details: ${err.message}</div>`;
  }
}

export async function openSchemeBreakdownModal(symbol, filterAction = 'ALL') {
  const modal = document.getElementById('instModal');
  const title = document.getElementById('instModalTitle');
  const tbody = document.getElementById('tbodySchemeHoldingsModal');
  const returnColHeader = document.getElementById('modalMfReturnHeader');
  if (!modal || !tbody) return;

  const periodLabel = currentPeriod === '1m' ? '1 Month' : (currentPeriod === '6m' ? '6 Months' : (currentPeriod === '1y' ? '1 Year' : '3 Months'));
  const periodShort = currentPeriod === '1m' ? '1M' : (currentPeriod === '6m' ? '6M' : (currentPeriod === '1y' ? '1Y' : '3M'));

  if (returnColHeader) {
    returnColHeader.textContent = `${periodShort} Return %`;
  }

  let filterTitleText = 'All Mutual Funds';
  if (filterAction === 'INCREASED') filterTitleText = '📈 Added / Buying Mutual Funds';
  else if (filterAction === 'DECREASED') filterTitleText = '📉 Selling / Dumped Mutual Funds';

  if (title) {
    title.textContent = `🏥 ${filterTitleText} Holding ${symbol} (Ranked by ${periodLabel} Return %)`;
  }

  tbody.innerHTML = '<tr class="empty-row"><td colspan="7">⏳ Loading ranked mutual funds...</td></tr>';
  modal.style.display = 'flex';
  modal.classList.add('open');

  try {
    const actionQuery = filterAction !== 'ALL' ? `&action=${filterAction}` : '';
    const res = await api(`/api/institutional/scheme-breakdown/${symbol}?period=${currentPeriod}${actionQuery}`);
    const rows = res.data || [];

    if (rows.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No mutual fund scheme details recorded for ${symbol}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((s) => {
      const rankNum = s.rank || 1;
      const mfRet = Number(s.mf_return || 0);

      const actType = s.action_type || 'INCREASED';
      const shChg = Number(s.shares_changed || 0);

      let actionBadge = `<span class="days-pill" style="background:rgba(0, 230, 153, 0.14);color:var(--gain);font-weight:800;padding:3px 8px;border-radius:10px;">📈 Increased (${shChg > 0 ? '+' : ''}${shChg.toLocaleString('en-IN')})</span>`;
      if (actType === 'DECREASED' || shChg < 0) {
        actionBadge = `<span class="days-pill" style="background:rgba(255, 77, 109, 0.14);color:var(--loss);font-weight:800;padding:3px 8px;border-radius:10px;">📉 Decreased (${shChg.toLocaleString('en-IN')})</span>`;
      } else if (actType === 'HELD' || shChg === 0) {
        actionBadge = `<span class="days-pill" style="background:var(--bg-raised);color:var(--text-muted);font-weight:700;padding:3px 8px;border-radius:10px;">➖ Held Unchanged</span>`;
      }

      return `
        <tr>
          <td style="text-align:center;font-weight:900;font-size:12px;font-family:var(--font-mono);color:var(--accent);">
            ${rankNum}.
          </td>
          <td style="font-weight:700;color:var(--text-primary);font-size:12.5px;">
            <b style="color:var(--accent);margin-right:4px;">${rankNum}.</b> ${s.scheme_name}
          </td>
          <td style="font-size:11px;color:var(--text-muted);">${s.fund_house || '—'}</td>
          <td style="text-align:center;">${actionBadge}</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${mfRet >= 0 ? 'var(--gain)' : 'var(--loss)'};">${mfRet >= 0 ? '+' : ''}${mfRet.toFixed(2)}%</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--accent-cyan);">₹${Number(s.invested_value_cr || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Cr</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--text-primary);">${Number(s.weightage_pct || 0).toFixed(2)}%</td>
        </tr>`;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7" style="color:var(--loss);">Error: ${err.message}</td></tr>`;
  }
}

window.openSchemeBreakdownModal = openSchemeBreakdownModal;
window.toggleAccordionTray = toggleAccordionTray;
