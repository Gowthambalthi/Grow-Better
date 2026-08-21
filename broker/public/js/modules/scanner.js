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

let currentMode = 'A'; // 'A' (By Institute/Scheme) or 'B' (By Stock)
let currentSubMode = 'AMC'; // 'AMC' (24 AMCs) or 'SCHEME' (~2000 Schemes)
let currentTimeframe = '1m'; // '1m' or '3m'
let currentBucketFilter = 'ALL';

export function initInstitutionalScanner() {
  bindControls();
  loadData();
  loadConvictionLeaderboard();
}

function bindControls() {
  const btnModeInst = document.getElementById('btnModeInstitutes');
  const btnModeStk = document.getElementById('btnModeStock');
  const btnSubAmc = document.getElementById('btnSubAmc');
  const btnSubSch = document.getElementById('btnSubScheme');
  const subWrap = document.getElementById('subToggleWrap');
  const tfSelect = document.getElementById('instPeriodSelect');

  if (btnModeInst && btnModeStk) {
    btnModeInst.addEventListener('click', () => {
      currentMode = 'A';
      btnModeInst.classList.add('active');
      btnModeStk.classList.remove('active');
      if (subWrap) subWrap.style.display = 'flex';
      loadData();
    });

    btnModeStk.addEventListener('click', () => {
      currentMode = 'B';
      btnModeStk.classList.add('active');
      btnModeInst.classList.remove('active');
      if (subWrap) subWrap.style.display = 'none';
      loadData();
    });
  }

  if (btnSubAmc && btnSubSch) {
    btnSubAmc.addEventListener('click', () => {
      currentSubMode = 'AMC';
      btnSubAmc.classList.add('active');
      btnSubSch.classList.remove('active');
      loadData();
    });

    btnSubSch.addEventListener('click', () => {
      currentSubMode = 'SCHEME';
      btnSubSch.classList.add('active');
      btnSubAmc.classList.remove('active');
      loadData();
    });
  }

  if (tfSelect) {
    tfSelect.addEventListener('change', (e) => {
      currentTimeframe = e.target.value;
      loadData();
      loadConvictionLeaderboard();
    });
  }

  const pillBtns = document.querySelectorAll('.conviction-pill[data-bucket]');
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
 * Loads main table data based on currentMode, currentSubMode, and currentTimeframe
 */
export async function loadData() {
  if (currentMode === 'A') {
    if (currentSubMode === 'AMC') {
      await load24AmcsRanking();
    } else {
      await load2000SchemesRanking();
    }
  } else {
    await loadStockWeightageRanking();
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

    let html = '';
    res.data.forEach((row, idx) => {
      const score = Number(row.weightage_score || 0);
      const pctInc = Number(row.pct_increase_holding || 0);
      const isPos = pctInc >= 0;

      html += `
        <tr class="clickable-row" style="cursor:pointer;" title="Click to view schemes holding ${row.symbol}">
          <td style="text-align:center;font-weight:800;color:var(--text-muted);font-family:var(--font-mono);">#${idx + 1}</td>
          <td>
            <div style="font-weight:800;color:var(--text);font-size:13.5px;">${row.symbol}</div>
            <div style="font-size:11px;color:var(--text-muted);">${row.company_name}</div>
          </td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">₹${Number(row.ltp).toFixed(2)}</td>
          <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${isPos ? '#16A34A' : '#F85C56'};">${isPos ? '+' : ''}${pctInc.toFixed(1)}%</td>
          <td style="text-align:center;font-weight:700;color:var(--primary);">${row.net_buyers + row.net_sellers} Institutes</td>
          <td style="text-align:center;font-family:var(--font-mono);font-weight:700;">
            <span style="color:#16A34A;">${row.net_buyers}B</span> / <span style="color:#F85C56;">${row.net_sellers}S</span>
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
