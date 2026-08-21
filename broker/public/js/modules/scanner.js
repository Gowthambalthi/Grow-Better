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
      <th data-sort-stk="rank" style="width:45px;text-align:center;padding:12px 6px;cursor:pointer;user-select:none;"># ${getSortIcon('rank', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="symbol" style="white-space:nowrap;padding:12px 14px;min-width:200px;cursor:pointer;user-select:none;">Institutes Symbol ${getSortIcon('symbol', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="today_pl_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:130px;cursor:pointer;user-select:none;">Today's P&amp;L % ${getSortIcon('today_pl_pct', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="timeframe_return_pct" style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:150px;cursor:pointer;user-select:none;">Timeframe Return % (${tfLabel}) ${getSortIcon('timeframe_return_pct', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="institutes_holding_count" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:150px;cursor:pointer;user-select:none;">Institutes Holding ${getSortIcon('institutes_holding_count', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="institutes_added" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:160px;cursor:pointer;user-select:none;">Institutes Added ${getSortIcon('institutes_added', stkSortCol, stkSortDir)}</th>
      <th data-sort-stk="weightage_score" style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;cursor:pointer;user-select:none;">Weightage Score ${getSortIcon('weightage_score', stkSortCol, stkSortDir)}</th>
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

    const list = res.data.map((row, idx) => ({ ...row, rank: idx + 1 }));
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
      const todayPl = Number(row.today_pl_pct || 0);
      const isTodayPos = todayPl >= 0;

      const tfReturn = Number(row.timeframe_return_pct || 0);
      const isTfPos = tfReturn >= 0;

      html += `
        <tr class="clickable-row">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${row.rank}</td>
          <td>
            <div style="font-weight:800;color:var(--text);font-size:13.5px;">${row.symbol}</div>
            <div style="font-size:11px;color:var(--text-muted);">${row.company_name}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isTodayPos ? '#16A34A' : '#F85C56'};">
            ${isTodayPos ? '+' : ''}${todayPl.toFixed(2)}%
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isTfPos ? '#16A34A' : '#F85C56'};">
            ${isTfPos ? '+' : ''}${tfReturn.toFixed(1)}%
          </td>
          <td data-breakdown-sym="${row.symbol}" data-breakdown-mode="holding" style="text-align:center;font-weight:700;color:var(--primary);cursor:pointer;text-decoration:underline;" title="Click to view all ${row.institutes_holding_count || 1400} institutes holding ${row.symbol}">
            ${row.institutes_holding_count || (row.net_buyers + row.net_sellers)} Institutes
          </td>
          <td data-breakdown-sym="${row.symbol}" data-breakdown-mode="added" style="text-align:center;font-family:var(--font-mono);font-weight:700;cursor:pointer;text-decoration:underline;" title="Click to view all ${row.institutes_added || 1200} institutes added ${row.symbol}">
            <span style="color:#16A34A;">${row.institutes_added || row.net_buyers} Added</span>
            <span style="font-size:10.5px;color:var(--text-muted);margin-left:4px;">(${row.net_buyers}B / ${row.net_sellers}S)</span>
          </td>
          <td style="text-align:center;">
            <div style="display:flex;align-items:center;justify-content:center;gap:6px;">
              <span style="font-family:var(--font-mono);font-weight:800;font-size:13px;color:#2563EB;">${score.toFixed(1)}</span>
              <div style="width:50px;height:6px;background:var(--bg-raised);border-radius:3px;overflow:hidden;">
                <div style="width:${Math.max(10, score)}%;height:100%;background:#2563EB;border-radius:3px;"></div>
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

  if (!modal || !tbody) return;

  modal.style.display = 'flex';
  tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Loading institute holdings breakdown for ${symbol}...</td></tr>`;

  if (closeBtn) {
    closeBtn.onclick = () => { modal.style.display = 'none'; };
  }
  modal.onclick = (e) => {
    if (e.target === modal) modal.style.display = 'none';
  };

  try {
    const res = await api(`/api/institutional/stock-breakdown?symbol=${symbol}&mode=${mode}`);
    if (!res || !res.success || !res.data || !Array.isArray(res.data.schemes)) {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No breakdown records found for ${symbol}</td></tr>`;
      return;
    }

    const { company_name, schemes } = res.data;
    if (title) {
      if (mode === 'holding') {
        title.innerHTML = `All Institutes Holding Record — <span style="color:var(--primary);">${symbol}</span> (${company_name})`;
      } else {
        title.innerHTML = `Institutes Added / Bought Record — <span style="color:#16A34A;">${symbol}</span> (${company_name})`;
      }
    }

    let html = '';
    schemes.forEach((sch, idx) => {
      const isBuy = sch.action === 'BUY';
      const actionBadge = isBuy
        ? `<span style="background:rgba(22, 163, 74, 0.15);color:#16A34A;padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px;">${sch.action_detail}</span>`
        : `<span style="background:rgba(248, 92, 86, 0.15);color:#F85C56;padding:3px 8px;border-radius:4px;font-weight:700;font-size:11px;">${sch.action_detail}</span>`;

      html += `
        <tr>
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
          <td>
            <div style="font-weight:800;color:var(--text);font-size:13px;">${sch.scheme_name}</div>
            <div style="font-size:11px;color:var(--text-muted);">${sch.fund_house} · ${sch.category}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--accent-cyan);">
            ${Number(sch.weightage_pct).toFixed(2)}%
          </td>
          <td style="text-align:center;">
            ${actionBadge}
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:var(--text);">
            ₹${Number(sch.invested_cr).toLocaleString('en-IN')} Cr
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

  } catch (err) {
    console.error('openStockBreakdownModal error:', err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Error loading breakdown: ${err.message}</td></tr>`;
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
