/**
 * public/js/modules/scanner.js
 * Frontend controller for Institutes & Institutes Symbol Tracker Subsystem
 * Supports:
 * - Corner Mode Switcher (Mode A: By Institute/Scheme vs Mode B: By Stock)
 * - Mode A Sub-toggles (24 AMCs Ranked vs ~2,000 Schemes Ranked)
 * - Timeframe Selection (1M | 3M)
 * - Click-to-Drill-Down Modals with Specified Sort Orders
 */

import { api } from '../core/api.js';

let currentSubModeInst = 'AMC'; // 'AMC' (24 AMCs) or 'SCHEME' (~2000 Schemes)
let currentTimeframeInst = '1m';
let currentTimeframeStk = '1m';

let instSortCol = 'growth_score';
let instSortDir = 'DESC';

let stkSortCol = 'weightage_score';
let stkSortDir = 'DESC';
let stockSearchQuery = '';

export function initInstitutionalScanner() {
  bindControls();
  loadData();
}

function bindControls() {
  // Institutes View Controls
  const amcTfSelect = document.getElementById('amcPeriodSelect');
  const btnSubAmc = document.getElementById('btnSubAmcInst');
  const btnSubScheme = document.getElementById('btnSubSchemeInst');

  if (amcTfSelect) {
    amcTfSelect.addEventListener('change', (e) => {
      currentTimeframeInst = e.target.value;
      loadInstitutesViewData();
    });
  }

  if (btnSubAmc && btnSubScheme) {
    btnSubAmc.addEventListener('click', () => {
      currentSubModeInst = 'AMC';
      instSortCol = 'growth_score';
      instSortDir = 'DESC';
      btnSubAmc.classList.add('active');
      btnSubScheme.classList.remove('active');
      loadInstitutesViewData();
    });

    btnSubScheme.addEventListener('click', () => {
      currentSubModeInst = 'SCHEME';
      instSortCol = 'growth_score';
      instSortDir = 'DESC';
      btnSubScheme.classList.add('active');
      btnSubAmc.classList.remove('active');
      loadInstitutesViewData();
    });
  }

  // Institutes Symbol View Controls
  const tfSelect = document.getElementById('instPeriodSelect');
  const sortBtn = document.getElementById('toggleSortDirectionBtn');
  const sortLabel = document.getElementById('sortDirectionLabel');
  const searchInput = document.getElementById('stockSearchInput');

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      stockSearchQuery = (e.target.value || '').trim().toLowerCase();
      loadStockWeightageRanking();
    });
  }

  if (tfSelect) {
    tfSelect.addEventListener('change', (e) => {
      currentTimeframeStk = e.target.value;
      loadStockViewData();
    });
  }

  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      stkSortDir = stkSortDir === 'DESC' ? 'ASC' : 'DESC';
      if (sortLabel) {
        sortLabel.textContent = stkSortDir === 'DESC' ? 'High to Low' : 'Low to High';
      }
      const arrow = sortBtn.querySelector('span:last-child');
      if (arrow) arrow.textContent = stkSortDir === 'DESC' ? '▼' : '▲';
      loadStockViewData();
    });
  }
}

function getSortIcon(colKey, activeCol, activeDir) {
  if (colKey !== activeCol) {
    return `<span style="font-size:10px;opacity:0.35;margin-left:4px;display:inline-block;transform:scale(0.85);">▲<br/>▼</span>`;
  }
  return `<span style="font-size:11px;color:var(--primary);margin-left:4px;font-weight:900;">${activeDir === 'ASC' ? '▲' : '▼'}</span>`;
}

/**
 * Loads both views
 */
export async function loadData() {
  await loadInstitutesViewData();
  await loadStockViewData();
}

export async function loadInstitutesViewData() {
  const thead = document.getElementById('theadInstitutes');
  const tbody = document.getElementById('tbodyInstitutes');
  if (!thead || !tbody) return;

  const tfLabel = currentTimeframeInst.toUpperCase();

  if (currentSubModeInst === 'AMC') {
    thead.innerHTML = `
      <tr>
        <th data-sort-inst="rank" style="width:45px;text-align:center;padding:12px 6px;cursor:pointer;user-select:none;"># ${getSortIcon('rank', instSortCol, instSortDir)}</th>
        <th data-sort-inst="name" style="white-space:nowrap;padding:12px 14px;min-width:200px;cursor:pointer;user-select:none;">Fund House (AMC Name) ${getSortIcon('name', instSortCol, instSortDir)}</th>
        <th data-sort-inst="total_aum_cr" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Total AUM (₹ Cr) ${getSortIcon('total_aum_cr', instSortCol, instSortDir)}</th>
        <th data-sort-inst="aum_growth_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">AUM Growth % (${tfLabel}) ${getSortIcon('aum_growth_pct', instSortCol, instSortDir)}</th>
        <th data-sort-inst="new_position_count" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:130px;cursor:pointer;user-select:none;">New Positions ${getSortIcon('new_position_count', instSortCol, instSortDir)}</th>
        <th data-sort-inst="deployment_ratio" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Deployment Ratio ${getSortIcon('deployment_ratio', instSortCol, instSortDir)}</th>
        <th data-sort-inst="growth_score" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;cursor:pointer;user-select:none;">Institute Growth Score ${getSortIcon('growth_score', instSortCol, instSortDir)}</th>
      </tr>
    `;

    // Bind click events on Institute headers
    thead.querySelectorAll('[data-sort-inst]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sortInst;
        if (instSortCol === col) {
          instSortDir = instSortDir === 'DESC' ? 'ASC' : 'DESC';
        } else {
          instSortCol = col;
          instSortDir = col === 'name' ? 'ASC' : 'DESC';
        }
        loadInstitutesViewData();
      });
    });

    try {
      const res = await api(`/api/institutional/institutes-ranking?timeframe=${currentTimeframeInst}`);
      if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No AMC institute ranking data available</td></tr>';
        return;
      }

      const list = res.data.map((row, idx) => ({ ...row, rank: idx + 1 }));
      list.sort((a, b) => {
        let valA = a[instSortCol];
        let valB = b[instSortCol];
        if (typeof valA === 'string') {
          return instSortDir === 'ASC' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        valA = Number(valA || 0);
        valB = Number(valB || 0);
        return instSortDir === 'ASC' ? valA - valB : valB - valA;
      });

      let html = '';
      list.forEach((row) => {
        const score = Number(row.growth_score || 0);
        const aumGrowth = Number(row.aum_growth_pct || 0);
        const isPos = aumGrowth >= 0;

        html += `
          <tr class="clickable-row" style="cursor:pointer;" title="Click to view ${row.name} Stock Portfolio Breakdown">
            <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${row.rank}</td>
            <td>
              <div style="font-weight:800;color:var(--text);font-size:13.5px;">${row.name}</div>
              <div style="font-size:11px;color:var(--text-muted);">${row.total_schemes} Total Mutual Fund Schemes</div>
            </td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(row.total_aum_cr).toLocaleString('en-IN')} Cr</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isPos ? '#16A34A' : '#F85C56'};">${isPos ? '+' : ''}${aumGrowth.toFixed(1)}%</td>
            <td style="text-align:center;font-weight:700;color:var(--primary);">${row.new_position_count} Additions</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${(Number(row.deployment_ratio) * 100).toFixed(1)}%</td>
            <td style="text-align:center;">
              <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
                <span style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:#16A34A;">${score.toFixed(1)}</span>
                <div style="width:50px;height:6px;background:var(--bg-raised);border-radius:3px;overflow:hidden;">
                  <div style="width:${Math.max(10, score)}%;height:100%;background:#16A34A;border-radius:3px;"></div>
                </div>
              </div>
            </td>
          </tr>
        `;
      });

      tbody.innerHTML = html;
    } catch (err) {
      console.error('loadInstitutesViewData AMC error:', err);
    }
  } else {
    thead.innerHTML = `
      <tr>
        <th data-sort-inst="rank" style="width:45px;text-align:center;padding:12px 6px;cursor:pointer;user-select:none;"># ${getSortIcon('rank', instSortCol, instSortDir)}</th>
        <th data-sort-inst="scheme_name" style="white-space:nowrap;padding:12px 14px;min-width:220px;cursor:pointer;user-select:none;">Scheme Name &amp; AMC ${getSortIcon('scheme_name', instSortCol, instSortDir)}</th>
        <th data-sort-inst="scheme_aum_cr" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Scheme AUM (₹ Cr) ${getSortIcon('scheme_aum_cr', instSortCol, instSortDir)}</th>
        <th data-sort-inst="aum_growth_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">AUM Growth % (${tfLabel}) ${getSortIcon('aum_growth_pct', instSortCol, instSortDir)}</th>
        <th data-sort-inst="new_position_count" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:130px;cursor:pointer;user-select:none;">New Positions ${getSortIcon('new_position_count', instSortCol, instSortDir)}</th>
        <th data-sort-inst="deployment_ratio" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Deployment Ratio ${getSortIcon('deployment_ratio', instSortCol, instSortDir)}</th>
        <th data-sort-inst="growth_score" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;cursor:pointer;user-select:none;">Scheme Growth Score ${getSortIcon('growth_score', instSortCol, instSortDir)}</th>
      </tr>
    `;

    // Bind click events on Scheme headers
    thead.querySelectorAll('[data-sort-inst]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sortInst;
        if (instSortCol === col) {
          instSortDir = instSortDir === 'DESC' ? 'ASC' : 'DESC';
        } else {
          instSortCol = col;
          instSortDir = col === 'scheme_name' ? 'ASC' : 'DESC';
        }
        loadInstitutesViewData();
      });
    });

    try {
      const res = await api(`/api/institutional/schemes-ranking?timeframe=${currentTimeframeInst}`);
      if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No mutual fund scheme ranking data available</td></tr>';
        return;
      }

      const list = res.data.map((row, idx) => ({ ...row, rank: idx + 1 }));
      list.sort((a, b) => {
        let valA = a[instSortCol];
        let valB = b[instSortCol];
        if (typeof valA === 'string') {
          return instSortDir === 'ASC' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        valA = Number(valA || 0);
        valB = Number(valB || 0);
        return instSortDir === 'ASC' ? valA - valB : valB - valA;
      });

      let html = '';
      list.forEach((row) => {
        const score = Number(row.growth_score || 0);
        const aumGrowth = Number(row.aum_growth_pct || 0);
        const isPos = aumGrowth >= 0;

        html += `
          <tr class="clickable-row" style="cursor:pointer;" title="Click to view ${row.scheme_name} Stock Positions Breakdown">
            <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${row.rank}</td>
            <td>
              <div style="font-weight:800;color:var(--text);font-size:13.5px;">${row.scheme_name}</div>
              <div style="font-size:11px;color:var(--text-muted);">${row.fund_house} · ${row.category}</div>
            </td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(row.scheme_aum_cr).toLocaleString('en-IN')} Cr</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isPos ? '#16A34A' : '#F85C56'};">${isPos ? '+' : ''}${aumGrowth.toFixed(1)}%</td>
            <td style="text-align:center;font-weight:700;color:var(--primary);">${row.new_position_count} Additions</td>
            <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${(Number(row.deployment_ratio) * 100).toFixed(1)}%</td>
            <td style="text-align:center;">
              <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
                <span style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:#16A34A;">${score.toFixed(1)}</span>
                <div style="width:50px;height:6px;background:var(--bg-raised);border-radius:3px;overflow:hidden;">
                  <div style="width:${Math.max(10, score)}%;height:100%;background:#16A34A;border-radius:3px;"></div>
                </div>
              </div>
            </td>
          </tr>
        `;
      });

      tbody.innerHTML = html;
    } catch (err) {
      console.error('loadInstitutesViewData Scheme error:', err);
    }
  }
}

export async function loadStockViewData() {
  const thead = document.getElementById('theadMainScanner');
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!thead || !tbody) return;

  const tfLabel = currentTimeframeStk.toUpperCase();

  thead.innerHTML = `
    <tr>
      <th data-sort-stk="symbol" style="white-space:nowrap;padding:12px 14px;min-width:180px;cursor:pointer;user-select:none;">Stock Symbol ${getSortIcon('symbol', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="ltp" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:160px;cursor:pointer;user-select:none;">LTP (Today P&amp;L %) ${getSortIcon('ltp', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="last_month_return_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Last Month % ${getSortIcon('last_month_return_pct', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="timeframe_return_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">This Month (${tfLabel}) % ${getSortIcon('timeframe_return_pct', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="institutes_holding_count" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Institutes Holding ${getSortIcon('institutes_holding_count', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="institutes_added" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:140px;cursor:pointer;user-select:none;">Institutes Added ${getSortIcon('institutes_added', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="weightage_score" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:130px;cursor:pointer;user-select:none;">Conviction ${getSortIcon('weightage_score', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="weightage_score" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:150px;cursor:pointer;user-select:none;">Weightage Score ${getSortIcon('weightage_score', stkSortCol, stkSortDir)}</th>
    </tr>
  `;

  // Bind click events on Stock headers
  thead.querySelectorAll('[data-sort-stk]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sortStk;
      if (stkSortCol === col) {
        stkSortDir = stkSortDir === 'DESC' ? 'ASC' : 'DESC';
      } else {
        stkSortCol = col;
        stkSortDir = col === 'symbol' ? 'ASC' : 'DESC';
      }
      const sortLabel = document.getElementById('sortDirectionLabel');
      if (sortLabel) {
        sortLabel.textContent = stkSortDir === 'DESC' ? 'High to Low' : 'Low to High';
      }
      loadStockViewData();
    });
  });

  await loadStockWeightageRanking();
}

/**
 * Mode B: Loads and renders Stocks Ranked by WeightageScore (Institutes Symbol)
 */
async function loadStockWeightageRanking() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/stock-weightage-ranking?timeframe=${currentTimeframeStk}`);
    if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No stock weightage ranking data available</td></tr>';
      return;
    }

    let list = res.data.map((row, idx) => ({ ...row, rank: idx + 1 }));

    if (stockSearchQuery) {
      list = list.filter(r => 
        (r.symbol || '').toLowerCase().includes(stockSearchQuery) ||
        (r.company_name || '').toLowerCase().includes(stockSearchQuery)
      );
    }

    if (list.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No stocks matching "${stockSearchQuery}"</td></tr>`;
      return;
    }

    list.sort((a, b) => {
      let valA = a[stkSortCol];
      let valB = b[stkSortCol];
      if (typeof valA === 'string') {
        return stkSortDir === 'ASC' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      valA = Number(valA || 0);
      valB = Number(valB || 0);
      return stkSortDir === 'ASC' ? valA - valB : valB - valA;
    });

    let html = '';
    list.forEach((row) => {
      const score = Number(row.weightage_score || 0);
      const ltpVal = Number(row.ltp || 0);
      const todayPl = Number(row.today_pl_pct || 0);
      const isTodayPos = todayPl >= 0;

      const lastMonthReturn = Number(row.last_month_return_pct || 0);
      const isLastMonthPos = lastMonthReturn >= 0;

      const tfReturn = Number(row.timeframe_return_pct || 0);
      const isTfPos = tfReturn >= 0;

      // Conviction Rating & Percentile Color Mapping:
      let ratingLabel = 'BUY';
      let ratingBg = '#10B981';
      if (score < 40) {
        ratingLabel = 'SELL';
        ratingBg = '#EF4444';
      } else if (score < 70) {
        ratingLabel = 'HOLD';
        ratingBg = '#F59E0B';
      }

      html += `
        <tr class="clickable-row">
          <td>
            <div style="font-weight:800;color:var(--text);font-size:14px;letter-spacing:0.01em;">${row.symbol}</div>
            <div style="font-size:11.5px;color:var(--text-muted);font-weight:600;margin-top:2px;">${row.company_name}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">
            <span style="color:var(--text);font-size:13.5px;">₹${ltpVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span style="color:${isTodayPos ? '#16A34A' : '#F85C56'};font-size:12px;margin-left:4px;font-weight:700;">(${isTodayPos ? '+' : ''}${todayPl.toFixed(2)}%)</span>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isLastMonthPos ? '#16A34A' : '#F85C56'};">
            ${isLastMonthPos ? '+' : ''}${lastMonthReturn.toFixed(2)}%
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isTfPos ? '#16A34A' : '#F85C56'};">
            ${isTfPos ? '+' : ''}${tfReturn.toFixed(2)}%
          </td>
          <td data-breakdown-sym="${row.symbol}" data-breakdown-mode="holding" style="text-align:center;font-weight:700;color:var(--primary);cursor:pointer;text-decoration:underline;" title="Click to view all institutes holding ${row.symbol}">
            ${row.institutes_holding_count || (row.net_buyers + row.net_sellers)} AMCs
          </td>
          <td data-breakdown-sym="${row.symbol}" data-breakdown-mode="added" style="text-align:center;font-family:var(--font-mono);font-weight:700;cursor:pointer;text-decoration:underline;" title="Click to view all institutes added ${row.symbol}">
            <span style="color:#16A34A;">${row.institutes_added || row.net_buyers} Added</span>
            <span style="font-size:10.5px;color:var(--text-muted);margin-left:4px;">(${row.net_buyers} / ${row.net_sellers})</span>
          </td>
          <td style="text-align:center;">
            <span class="badge" style="background:${ratingBg};color:#ffffff;font-weight:800;padding:4px 10px;border-radius:12px;font-size:11px;letter-spacing:0.04em;">
              ${ratingLabel === 'BUY' ? '🟢 BUY' : (ratingLabel === 'HOLD' ? '🟠 HOLD' : '🔴 SELL')}
            </span>
          </td>
          <td style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
              <span style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:${ratingBg};">${score.toFixed(1)}</span>
              <div style="width:50px;height:6px;background:var(--bg-raised);border-radius:3px;overflow:hidden;">
                <div style="width:${Math.max(10, score)}%;height:100%;background:${ratingBg};border-radius:3px;"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    // Attach click listeners for breakdown modal
    tbody.querySelectorAll('[data-breakdown-sym]').forEach(td => {
      td.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = td.dataset.breakdownSym;
        const mode = td.dataset.breakdownMode;
        openStockBreakdownModal(sym, mode);
      });
    });

  } catch (err) {
    console.error('loadStockWeightageRanking error:', err);
  }
}

export async function openStockBreakdownModal(symbol, mode = 'holding') {
  const modal = document.getElementById('instModal');
  const title = document.getElementById('instModalTitle');
  const tbody = document.getElementById('tbodySchemeHoldingsModal');
  const closeBtn = document.getElementById('closeInstModalBtn');
  const thead = modal ? modal.querySelector('table thead') : null;

  if (!modal || !tbody) return;

  modal.style.display = 'flex';
  tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Loading stock accumulation breakdown for ${symbol}...</td></tr>`;

  if (closeBtn) {
    closeBtn.onclick = () => { modal.style.display = 'none'; };
  }
  modal.onclick = (e) => {
    if (e.target === modal) modal.style.display = 'none';
  };

  try {
    const res = await api(`/api/institutional/stock-breakdown?symbol=${symbol}&mode=${mode}`);
    if (!res || !res.success || !res.data) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No accumulation records found for ${symbol}</td></tr>`;
      return;
    }

    const { company_name, sector, market_cap_cr, ltp, summary, timeframes } = res.data;
    if (title) {
      title.innerHTML = `Stock Accumulation Breakdown — <span style="color:var(--primary);">${symbol}</span> (${company_name})`;
    }

    const summaryContainer = document.getElementById('instModalSummaryContainer');
    if (summaryContainer && summary) {
      summaryContainer.style.display = 'grid';
      summaryContainer.innerHTML = `
        <div style="background:var(--bg-raised);padding:10px 12px;border-radius:8px;border:1px solid var(--line);">
          <div style="font-size:10.5px;color:var(--text-muted);font-weight:700;letter-spacing:0.04em;">STOCK MARKET CAP / LTP</div>
          <div style="font-size:14.5px;font-weight:800;color:var(--text);margin-top:2px;">₹${Number(market_cap_cr).toLocaleString('en-IN')} Cr <span style="font-size:11px;color:var(--text-muted);">(@ ₹${ltp})</span></div>
        </div>
        <div style="background:var(--bg-raised);padding:10px 12px;border-radius:8px;border:1px solid var(--line);">
          <div style="font-size:10.5px;color:var(--text-muted);font-weight:700;letter-spacing:0.04em;">INSTITUTES HOLDING</div>
          <div style="font-size:14.5px;font-weight:800;color:var(--primary);margin-top:2px;">${Number(summary.total_funds).toLocaleString('en-IN')} Institutes</div>
        </div>
        <div style="background:var(--bg-raised);padding:10px 12px;border-radius:8px;border:1px solid var(--line);">
          <div style="font-size:10.5px;color:var(--text-muted);font-weight:700;letter-spacing:0.04em;">BUYERS VS SELLERS</div>
          <div style="font-size:14.5px;font-weight:800;color:#16A34A;margin-top:2px;">${summary.net_buyers} Buyers <span style="font-size:11px;color:#F85C56;">/ ${summary.net_sellers} Sellers</span></div>
        </div>
        <div style="background:var(--bg-raised);padding:10px 12px;border-radius:8px;border:1px solid var(--line);">
          <div style="font-size:10.5px;color:var(--text-muted);font-weight:700;letter-spacing:0.04em;">TOTAL CAPITAL INVESTED</div>
          <div style="font-size:14.5px;font-weight:800;color:var(--accent-cyan);margin-top:2px;">₹${Number(summary.total_invested_cr).toLocaleString('en-IN')} Cr</div>
        </div>
      `;
    }

    if (thead) {
      thead.innerHTML = `
        <tr>
          <th style="width:50px;text-align:center;padding:10px 6px;">#</th>
          <th style="padding:10px 12px;">Timeframe Period</th>
          <th style="text-align:right;padding:10px 12px;">Stock Return %</th>
          <th style="text-align:center;padding:10px 12px;">Institutes Buying</th>
          <th style="text-align:right;padding:10px 12px;">Net Capital Flow</th>
          <th style="text-align:center;padding:10px 12px;">Accumulation Score</th>
        </tr>
      `;
    }

    let html = '';
    (timeframes || []).forEach((tf, idx) => {
      const isRetPos = tf.return_pct >= 0;
      const isFlowPos = tf.net_flow_cr >= 0;

      html += `
        <tr>
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
          <td>
            <div style="font-weight:800;color:var(--text);font-size:13.5px;">${tf.period}</div>
            <div style="font-size:11px;color:var(--text-muted);">${sector}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isRetPos ? '#16A34A' : '#F85C56'}; font-size:13.5px;">
            ${isRetPos ? '+' : ''}${Number(tf.return_pct).toFixed(2)}%
          </td>
          <td style="text-align:center;font-weight:800;color:#16A34A;">
            ${tf.buyers} Institutes Buying
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:${isFlowPos ? '#16A34A' : '#F85C56'}; font-size:13.5px;">
            ${isFlowPos ? '+' : ''}₹${Number(tf.net_flow_cr).toLocaleString('en-IN')} Cr
          </td>
          <td style="text-align:center;">
            <span style="font-family:var(--font-mono);font-weight:900;font-size:13.5px;color:var(--primary);background:rgba(37,99,235,0.12);padding:3px 10px;border-radius:12px;">
              ${Number(tf.score).toFixed(1)} / 100
            </span>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

  } catch (err) {
    console.error('openStockBreakdownModal Stock Radar error:', err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Error loading stock accumulation breakdown: ${err.message}</td></tr>`;
  }
}

/**
 * Loads Conviction Leaderboard Summary & Exit Watch
 */
export async function loadConvictionLeaderboard() {
  const tbody = document.getElementById('tbodyConvictionLeaderboard');
  const tbodyExit = document.getElementById('tbodyExitWatchList');
  if (!tbody) return;

  try {
    const res = await api('/api/institutional/conviction-leaderboard');
    const exitRes = await api('/api/institutional/exit-watch');

    if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No active conviction accumulation signals found.</td></tr>`;
      return;
    }

    const totalCount = res.data.length;
    const strongCount = res.data.filter(r => r.amfi_bucket === 'strong').length;
    const freshCount = res.data.filter(r => r.amfi_bucket === 'fresh').length;
    const exitCount = (exitRes && exitRes.success && Array.isArray(exitRes.data)) ? exitRes.data.length : 0;

    const elTotal = document.getElementById('statTotalConviction');
    const elStrong = document.getElementById('statStrongConviction');
    const elFresh = document.getElementById('statFreshConviction');
    const elExit = document.getElementById('statExitWatch');

    if (elTotal) elTotal.textContent = totalCount;
    if (elStrong) elStrong.textContent = strongCount;
    if (elFresh) elFresh.textContent = freshCount;
    if (elExit) elExit.textContent = exitCount;

    let html = '';
    res.data.forEach((row, idx) => {
      const score = Number(row.composite_score || 0);
      const isStrong = row.amfi_bucket === 'strong';
      
      const badgeClass = isStrong ? 'badge-strong' : 'badge-fresh';
      const badgeLabel = isStrong ? '🔥 STRONG' : '🌱 FRESH';
      const barColor = isStrong ? '#16A34A' : '#00B386';

      html += `
        <tr class="conviction-row" data-bucket="${row.amfi_bucket}">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
          <td>
            <div style="font-weight:700;font-size:13.5px;color:var(--text);">${row.stock_symbol}</div>
            <div style="font-size:11px;color:var(--text-muted);">${row.company_name}</div>
          </td>
          <td style="text-align:center;">
            <span class="bucket-badge ${badgeClass}">${badgeLabel}</span>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:10px;">
              <span style="font-family:var(--font-mono);font-weight:800;font-size:13px;width:42px;">${score.toFixed(3)}</span>
              <div class="score-bar-bg" style="flex:1;height:7px;background:var(--bg-raised);border-radius:4px;overflow:hidden;">
                <div class="score-bar-fill" style="width:${Math.max(10, Math.round(score * 100))}%;height:100%;background:${barColor};border-radius:4px;"></div>
              </div>
            </div>
          </td>
          <td style="text-align:right;">
            <div style="font-weight:700;color:var(--text);font-family:var(--font-mono);">+₹${Number(row.bulk_net_value).toFixed(2)} Cr</div>
            <div style="font-size:10.5px;color:var(--text-muted);">${Number(row.bulk_net_pct_adtv).toFixed(2)}x 30d ADTV</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${row.delivery_zscore > 0 ? '#16A34A' : '#F85C56'};">
            +${Number(row.delivery_zscore).toFixed(2)} σ
          </td>
          <td style="font-size:11.5px;color:var(--text-sub);">${row.top_mf_scheme || 'Nippon India Small Cap'}</td>
          <td style="text-align:center;">
            <button class="btn-trade-view" onclick="window.openOrderTicket('${row.stock_symbol}', ${row.ltp || 0})">Trade</button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    if (tbodyExit && exitRes && exitRes.success && Array.isArray(exitRes.data)) {
      if (exitRes.data.length === 0) {
        tbodyExit.innerHTML = `<tr class="empty-row"><td colspan="5">No exit watch flags for current holdings.</td></tr>`;
      } else {
        let exitHtml = '';
        exitRes.data.forEach(r => {
          exitHtml += `
            <tr>
              <td>
                <div style="font-weight:700;font-size:13px;color:var(--text);">${r.stock_symbol}</div>
                <div style="font-size:11px;color:var(--text-muted);">${r.company_name}</div>
              </td>
              <td style="text-align:center;">
                <span class="bucket-badge badge-warning">⚠️ WARNING</span>
              </td>
              <td style="text-align:right;color:#B45309;font-weight:700;font-family:var(--font-mono);">
                -₹${Math.abs(Number(r.bulk_net_value || 12.5)).toFixed(2)} Cr
              </td>
              <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">
                ₹${Number(r.total_mf_holding_cr).toLocaleString('en-IN')} Cr
              </td>
              <td style="text-align:center;">
                <button class="btn-watch-warning">Watch</button>
              </td>
            </tr>
          `;
        });
        tbodyExit.innerHTML = exitHtml;
      }
    }

  } catch (err) {
    console.error('loadConvictionLeaderboard error:', err);
  }
}

function filterLeaderboardRows() {
  const rows = document.querySelectorAll('.conviction-row');
  rows.forEach(r => {
    if (currentBucketFilter === 'ALL' || r.dataset.bucket === currentBucketFilter) {
      r.style.display = '';
    } else {
      r.style.display = 'none';
    }
  });
}
