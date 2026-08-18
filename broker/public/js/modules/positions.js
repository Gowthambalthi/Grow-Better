/**
 * public/js/modules/positions.js
 * Positions & Orders 2-Tab Controller (Open MTF Positions, Order History)
 */

import { api } from '../core/api.js';
import { money } from '../core/formatters.js';

export function initPositionsSubtabs() {
  const nav = document.getElementById('posSubtabsNav');
  if (!nav) return;

  const buttons = nav.querySelectorAll('.toggle-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      const tabKey = btn.dataset.tab;
      document.querySelectorAll('.positions-subtab-view').forEach((view) => {
        view.style.display = 'none';
      });

      if (tabKey === 'open') {
        const el = document.getElementById('subviewPosOpen');
        if (el) el.style.display = 'block';
        loadMtfPositions();
      } else if (tabKey === 'orders') {
        const el = document.getElementById('subviewPosOrders');
        if (el) el.style.display = 'block';
        loadPosOrdersHistory();
      }
    });
  });

  const refreshOrdersBtn = document.getElementById('refreshPosOrdersBtn');
  if (refreshOrdersBtn) {
    refreshOrdersBtn.addEventListener('click', () => loadPosOrdersHistory());
  }
}

export async function loadMtfPositions() {
  for (const broker of ['angelone', 'groww']) {
    try {
      const rows = await api(`/api/${broker}/ledger/mtf-summary`);
      const open = rows.filter((r) => r.isOpen);
      const tbody = document.getElementById(`tbodyMtf${broker === 'angelone' ? 'Angelone' : 'Groww'}`);
      if (tbody) {
        tbody.innerHTML = open.length
          ? open.map((r) => `
            <tr>
              <td style="font-weight:700;">${r.tradingsymbol}</td>
              <td>${r.quantity}</td>
              <td>${money(r.price)}</td>
              <td>${money(r.mtf_amount_borrowed)}</td>
              <td style="color:var(--loss);font-weight:700;">${money(r.interestAccrued)}</td>
              <td><span class="days-pill">${r.daysHeld}</span></td>
            </tr>`).join('')
          : '<tr class="empty-row"><td colspan="6">No open MTF positions</td></tr>';
      }
    } catch (err) {
      console.error(`mtf summary load failed for ${broker}`, err);
    }
  }
}

export async function loadPosOrdersHistory() {
  const tbody = document.getElementById('tbodyPosOrders');
  if (!tbody) return;

  try {
    const [angelRes, growwRes] = await Promise.all([
      api('/api/angelone/orders').catch(() => []),
      api('/api/groww/orders').catch(() => []),
    ]);

    const angelOrders = (Array.isArray(angelRes) ? angelRes : (angelRes.orders || [])).map(o => ({ ...o, broker: 'angelone' }));
    const growwOrders = (Array.isArray(growwRes) ? growwRes : (growwRes.orders || [])).map(o => ({ ...o, broker: 'groww' }));

    const allOrders = [...angelOrders, ...growwOrders];
    allOrders.sort((a, b) => new Date(b.updatetime || b.orderTime || 0) - new Date(a.updatetime || a.orderTime || 0));

    if (allOrders.length === 0) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9">No orders executed today</td></tr>';
      return;
    }

    tbody.innerHTML = allOrders.map((o) => {
      const status = (o.status || o.orderstatus || 'EXECUTED').toUpperCase();
      const isOk = status.includes('EXECUTED') || status.includes('COMPLETE') || status.includes('SUCCESS');
      const badgeClass = isOk ? 'badge--success' : (status.includes('REJECT') ? 'badge--loss' : 'badge--neutral');
      const side = (o.transactiontype || o.side || 'BUY').toUpperCase();
      const sideColor = side === 'BUY' ? 'var(--gain)' : 'var(--loss)';
      const brokerTag = o.broker === 'angelone' ? '<span class="broker-tag-angel">ANGEL</span>' : '<span class="broker-tag-groww">GROWW</span>';
      const timeStr = o.updatetime || o.exchtime || new Date().toLocaleTimeString();

      return `
        <tr>
          <td style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);">${timeStr}</td>
          <td>${brokerTag}</td>
          <td style="font-weight:700;">${o.tradingsymbol || o.symbol}</td>
          <td><span style="font-size:10px;font-family:var(--font-mono);">${o.ordertype || 'MARKET'}</span></td>
          <td style="font-weight:800;color:${sideColor};">${side}</td>
          <td>${o.quantity || o.filledshares || 0}</td>
          <td>${money(o.price || o.averageprice || 0)}</td>
          <td><span class="badge ${badgeClass}">${status}</span></td>
          <td style="font-family:var(--font-mono);font-size:10.5px;color:var(--text-muted);">${o.orderid || '—'}</td>
        </tr>`;
    }).join('');
  } catch (err) {
    console.error('loadPosOrdersHistory error:', err);
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9" style="color:var(--loss);">Failed to load order history: ${err.message}</td></tr>`;
  }
}
