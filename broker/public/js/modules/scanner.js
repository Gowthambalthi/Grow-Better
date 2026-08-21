/**
 * public/js/modules/scanner.js
 * Frontend controller for AMFI Monthly Accumulation & Institutional Conviction Scanner
 */

import { api } from '../core/router.js';

let currentPeriod = '3m';
let currentSortBy = 'growth_3m';
let currentSortOrder = 'DESC';
let currentBucketFilter = 'ALL';

export function initInstitutionalScanner() {
  bindControls();
  loadInstitutionalScannerData();
  loadConvictionLeaderboard();
}

function bindControls() {
  const periodSelect = document.getElementById('instPeriodSelect');
  if (periodSelect) {
    periodSelect.addEventListener('change', (e) => {
      currentPeriod = e.target.value;
      loadInstitutionalScannerData();
      loadConvictionLeaderboard();
    });
  }

  // Filter Pill buttons
  const pillBtns = document.querySelectorAll('.conviction-pill');
  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      pillBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentBucketFilter = btn.dataset.bucket || 'ALL';
      filterLeaderboardRows();
    });
  });
}

/**
 * Loads and renders the Conviction Scanner Ranked Leaderboard
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

    // Update Summary Strip Counters
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
      const scorePct = Math.round(score * 100);
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
                <div class="score-bar-fill" style="width:${Math.max(10, scorePct)}%;height:100%;background:${barColor};border-radius:4px;"></div>
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

    // Render Exit Watch List
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Failed to load conviction leaderboard.</td></tr>`;
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

export async function loadInstitutionalScannerData() {
  const tbody = document.getElementById('tbodyInstitutionalScanner');
  if (!tbody) return;

  try {
    const res = await api(`/api/institutional/stock-summary?period=${currentPeriod}&sortBy=${currentSortBy}&sortOrder=${currentSortOrder}`);

    if (!res || !res.success || !res.data || res.data.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No matching institutional accumulation data found</td></tr>';
      return;
    }

    let html = '';
    res.data.forEach((row, index) => {
      const growth = Number(row.growth_3m || 0);
      const isPositive = growth >= 0;
      const growthColor = isPositive ? '#16A34A' : '#F85C56';
      const sign = isPositive ? '+' : '';

      html += `
        <tr>
          <td style="text-align:center;font-weight:700;color:var(--text-muted);">${index + 1}</td>
          <td>
            <div style="font-weight:700;color:var(--text);font-size:13px;">${row.symbol}</div>
            <div style="font-size:11px;color:var(--text-muted);">${row.company_name}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(row.ltp).toFixed(2)}</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${growthColor};">${sign}${growth.toFixed(1)}%</td>
          <td style="text-align:center;font-weight:700;color:var(--primary);">${row.total_institutes_count} Schemes</td>
          <td style="text-align:center;">
            <span class="bucket-badge ${growth >= 0 ? 'badge-strong' : 'badge-warning'}">
              ${growth >= 0 ? '📈 ACCUMULATING' : '📉 TRIMMING'}
            </span>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${Number(row.avg_weightage_pct).toFixed(2)}%</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(row.total_mf_holding_cr).toLocaleString('en-IN')} Cr</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

  } catch (err) {
    console.error('loadInstitutionalScannerData error:', err);
  }
}
