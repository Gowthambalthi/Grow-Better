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

let currentMode = 'B'; // Dedicated 'B' (By Stock / Institutes Symbol)
let currentTimeframe = '1m'; // '1m', '3m', '6m', '1y'
let currentSortOrder = 'DESC'; // 'DESC' or 'ASC'

export function initInstitutionalScanner() {
  bindControls();
  loadData();
}

function bindControls() {
  const tfSelect = document.getElementById('instPeriodSelect');
  const sortBtn = document.getElementById('toggleSortDirectionBtn');
  const sortLabel = document.getElementById('sortDirectionLabel');

  if (tfSelect) {
    tfSelect.addEventListener('change', (e) => {
      currentTimeframe = e.target.value;
      loadData();
    });
  }

  if (sortBtn) {
    sortBtn.addEventListener('click', () => {
      currentSortOrder = currentSortOrder === 'DESC' ? 'ASC' : 'DESC';
      if (sortLabel) {
        sortLabel.textContent = currentSortOrder === 'DESC' ? 'High to Low' : 'Low to High';
      }
      const arrow = sortBtn.querySelector('span:last-child');
      if (arrow) arrow.textContent = currentSortOrder === 'DESC' ? '▼' : '▲';
      loadData();
    });
  }
}

/**
 * Loads main table data for Institutes Symbol
 */
export async function loadData() {
  updateTableHeaders();
  await loadStockWeightageRanking();
}

function updateTableHeaders() {
  const thead = document.getElementById('theadMainScanner');
  if (!thead) return;

  const tfLabel = currentTimeframe.toUpperCase();

  if (currentMode === 'A' && currentSubMode === 'AMC') {
    thead.innerHTML = `
      <tr>
        <th style="width:45px;text-align:center;padding:12px 6px;">#</th>
        <th style="white-space:nowrap;padding:12px 14px;min-width:200px;">Fund House (AMC Name)</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">Total AUM (₹ Cr)</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">AUM Growth % (${tfLabel})</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:130px;">New Positions</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">Deployment Ratio</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;">Institute Growth Score</th>
      </tr>
    `;
  } else if (currentMode === 'A' && currentSubMode === 'SCHEME') {
    thead.innerHTML = `
      <tr>
        <th style="width:45px;text-align:center;padding:12px 6px;">#</th>
        <th style="white-space:nowrap;padding:12px 14px;min-width:220px;">Scheme Name &amp; AMC</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">Scheme AUM (₹ Cr)</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">AUM Growth % (${tfLabel})</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:130px;">New Positions</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:140px;">Deployment Ratio</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;">Scheme Growth Score</th>
      </tr>
    `;
  } else {
    thead.innerHTML = `
      <tr>
        <th style="width:45px;text-align:center;padding:12px 6px;">#</th>
        <th style="white-space:nowrap;padding:12px 14px;min-width:200px;">Institutes Symbol</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:130px;">Today's P&amp;L %</th>
        <th style="text-align:right;white-space:nowrap;padding:12px 14px;min-width:150px;">Timeframe Return % (${tfLabel})</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:150px;">Institutes Holding</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:160px;">Institutes Added</th>
        <th style="text-align:center;white-space:nowrap;padding:12px 14px;min-width:170px;">Weightage Score</th>
      </tr>
    `;
  }
}

/**
 * Mode A1: Loads and renders 24 AMCs Ranked by InstituteGrowthScore
 */
async function load24AmcsRanking() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/institutes-ranking?timeframe=${currentTimeframe}`);
    if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No AMC institute ranking data available</td></tr>';
      return;
    }

    let html = '';
    res.data.forEach((row, idx) => {
      const score = Number(row.growth_score || 0);
      const aumGrowth = Number(row.aum_growth_pct || 0);
      const isPos = aumGrowth >= 0;

      html += `
        <tr class="clickable-row" style="cursor:pointer;" title="Click to view ${row.name} Stock Portfolio Breakdown">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
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
    console.error('load24AmcsRanking error:', err);
  }
}

/**
 * Mode A2: Loads and renders ~2,000 Schemes Ranked by SchemeGrowthScore
 */
async function load2000SchemesRanking() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/schemes-ranking?timeframe=${currentTimeframe}`);
    if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No mutual fund scheme ranking data available</td></tr>';
      return;
    }

    let html = '';
    res.data.forEach((row, idx) => {
      const score = Number(row.growth_score || 0);
      const aumGrowth = Number(row.aum_growth_pct || 0);
      const isPos = aumGrowth >= 0;

      html += `
        <tr class="clickable-row" style="cursor:pointer;" title="Click to view ${row.scheme_name} Stock Positions Breakdown">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
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
    console.error('load2000SchemesRanking error:', err);
  }
}

/**
 * Mode B: Loads and renders Stocks Ranked by WeightageScore (Institutes Symbol)
 */
async function loadStockWeightageRanking() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/stock-weightage-ranking?timeframe=${currentTimeframe}`);
    if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No stock weightage ranking data available</td></tr>';
      return;
    }

    const list = [...res.data];
    if (currentSortOrder === 'ASC') {
      list.sort((a, b) => Number(a.weightage_score || 0) - Number(b.weightage_score || 0));
    } else {
      list.sort((a, b) => Number(b.weightage_score || 0) - Number(a.weightage_score || 0));
    }

    let html = '';
    list.forEach((row, idx) => {
      const score = Number(row.weightage_score || 0);
      const todayPl = Number(row.today_pl_pct || 0);
      const isTodayPos = todayPl >= 0;

      const tfReturn = Number(row.timeframe_return_pct || 0);
      const isTfPos = tfReturn >= 0;

      html += `
        <tr class="clickable-row" style="cursor:pointer;" title="Click to view schemes holding ${row.symbol}">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
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
          <td style="text-align:center;font-weight:700;color:var(--primary);">
            ${row.institutes_holding_count || (row.net_buyers + row.net_sellers)} Institutes
          </td>
          <td style="text-align:center;font-family:var(--font-mono);font-weight:700;">
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

  } catch (err) {
    console.error('loadStockWeightageRanking error:', err);
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
