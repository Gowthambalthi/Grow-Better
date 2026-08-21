import { api } from '../core/api.js';
import { money, rawMoney, pct, plSign } from '../core/formatters.js';
import { goToView } from '../core/router.js';
import { STOCK_LEVERAGE_DEFAULTS } from './settings.js';

function getLeverageFor(symbol) {
  if (!symbol) return 3.0;
  const clean = symbol.toUpperCase();
  return STOCK_LEVERAGE_DEFAULTS[clean] || 3.0;
}

let activeOrderParams = {
  symbol: 'EMMVEE',
  ltp: 323.8,
  broker: 'angelone',
  side: 'BUY',
  orderMode: 'NORMAL',
  productType: 'MARGIN',
};

let brokerFundsMap = {
  angelone: 788.69,
  groww: 111.31,
};

let selectedActionOrderId = null;

// Store Today's Orders and Historical Trades
export let todaysOrders = [
  { 
    id: 'ORD-108492', 
    broker: 'angelone', 
    symbol: 'CUPID', 
    side: 'BUY', 
    qty: 20, 
    price: 290.00, 
    ltp: 294.86, 
    targetPrice: 340.00, 
    stopLossPrice: 280.00,
    type: 'LIMIT', 
    status: 'PENDING', 
    time: '10:45 AM', 
    date: '2026-08-13' 
  }
];

export let tradeHistory = [
  { broker: 'angelone', symbol: 'CUPID-EQ', side: 'BUY', qty: 20, price: 293.19, date: '2026-08-13' },
  { broker: 'groww', symbol: 'CUPID', side: 'BUY', qty: 13, price: 233.29, date: '2026-07-30' },
  { broker: 'angelone', symbol: 'RELIANCE-EQ', side: 'BUY', qty: 16, price: 1321.48, date: '2026-07-17' },
  { broker: 'angelone', symbol: 'EMMVEE-EQ', side: 'BUY', qty: 15, price: 346.37, date: '2026-07-17' },
  { broker: 'angelone', symbol: 'SHRIRAMFIN-EQ', side: 'BUY', qty: 20, price: 1026.30, date: '2026-07-09' },
  { broker: 'angelone', symbol: 'ONGC-EQ', side: 'SELL', qty: 63, price: 240.00, buyCost: 244.95, date: '2026-08-12' },
  { broker: 'angelone', symbol: 'SHAKTIPR', side: 'SELL', qty: 20, price: 26.97, buyCost: 85.00, date: '2026-08-12' },
  { broker: 'angelone', symbol: 'SHAKTIPR', side: 'BUY', qty: 20, price: 85.00, date: '2026-06-23' },
];

export function addOrderToToday(order) {
  const ltp = order.ltp || order.price || 294.86;
  const newOrder = {
    id: `ORD-${Date.now().toString().slice(-6)}`,
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    date: new Date().toISOString().slice(0, 10),
    ltp,
    ...order
  };

  // 1. Check Available Funds
  const brokerKey = newOrder.broker || 'angelone';
  const availCash = brokerFundsMap[brokerKey] || 0;
  const leverage = getLeverageFor(newOrder.symbol);
  const requiredFunds = (newOrder.productType === 'MARGIN' || newOrder.isMtf)
    ? ((newOrder.qty * newOrder.price) / leverage)
    : (newOrder.qty * newOrder.price);

  if (requiredFunds > availCash) {
    newOrder.status = 'REJECTED (NO FUNDS)';
  } else {
    // 2. Enforcement Rules:
    if (newOrder.type === 'LIMIT' || newOrder.type === 'TARGET_SL') {
      if (newOrder.side === 'BUY') {
        newOrder.status = (ltp <= newOrder.price) ? 'EXECUTED' : 'PENDING (WAITING PRICE <= LIMIT)';
      } else if (newOrder.side === 'SELL') {
        newOrder.status = (ltp >= newOrder.price) ? 'EXECUTED' : 'PENDING (WAITING PRICE >= LIMIT)';
      }
    } else {
      newOrder.status = 'EXECUTED';
    }
  }

  todaysOrders.unshift(newOrder);
  renderOrdersUI();

  // Send instant phone alert for order status
  try {
    const isRejected = newOrder.status.includes('REJECTED');
    const isExecuted = newOrder.status.includes('EXECUTED');
    const isPending = newOrder.status.includes('PENDING');
    
    let emoji = '📊';
    if (isRejected) emoji = '⚠️';
    else if (isExecuted) emoji = '🚀';
    else if (isPending) emoji = '⏳';

    const notifyMsg = `${emoji} <b>GROWBETTER ORDER UPDATE</b>\n\n` +
      `<b>Stock:</b> ${newOrder.symbol}\n` +
      `<b>Broker:</b> ${newOrder.broker === 'angelone' ? 'Angel One' : 'Groww'}\n` +
      `<b>Action:</b> ${newOrder.side} ${newOrder.qty} Qty @ ₹${newOrder.price}\n` +
      `<b>Status:</b> ${newOrder.status}`;

    api('/api/notifications/test', 'POST', { message: notifyMsg }).catch(() => {});
  } catch (e) {}
}

export function openOrderActionModal(orderId) {
  const order = todaysOrders.find(o => o.id === orderId);
  if (!order) return;

  selectedActionOrderId = orderId;
  const modal = document.getElementById('orderActionModal');
  const titleEl = document.getElementById('actionModalTitle');
  const detailsEl = document.getElementById('actionOrderDetails');

  if (titleEl) titleEl.textContent = `MANAGE ORDER #${order.id}`;
  if (detailsEl) {
    const isRejected = (order.status || '').includes('REJECTED');
    const isCancelled = order.status === 'CANCELLED';
    const isPending = (order.status || '').includes('PENDING');

    let statusColor = 'var(--gain)';
    if (isRejected || isCancelled) statusColor = 'var(--loss)';
    else if (isPending) statusColor = '#2563EB';

    detailsEl.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="color:var(--text-muted);">Stock Symbol:</span>
        <b style="font-family:var(--font-mono);color:var(--accent);">${order.symbol}</b>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="color:var(--text-muted);">Order Side &amp; Qty:</span>
        <b>${order.side} ${order.qty} Qty</b>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
        <span style="color:var(--text-muted);">Limit Price:</span>
        <b style="font-family:var(--font-mono);">₹${rawMoney(order.price)}</b>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="color:var(--text-muted);">Current Status:</span>
        <b style="color:${statusColor}">${order.status}</b>
      </div>
    `;
  }

  if (modal) modal.style.display = 'flex';
}

export function renderOrdersUI() {
  const todaysContainer = document.getElementById('todaysOrdersContainer');
  const countEl = document.getElementById('todaysOrdersCount');

  if (countEl) countEl.textContent = String(todaysOrders.length);

  if (todaysContainer) {
    if (todaysOrders.length === 0) {
      todaysContainer.innerHTML = `
        <div style="padding:28px 20px;text-align:center;background:var(--bg-raised);border:1px dashed var(--line);border-radius:10px;margin:4px 0;">
          <div style="font-size:13px;font-weight:800;color:var(--text-primary);margin-bottom:4px;">NO ORDERS PLACED TODAY</div>
          <div style="font-size:11.5px;color:var(--text-muted);">Orders placed today will appear here automatically.</div>
        </div>
      `;
    } else {
      let html = `
        <div class="table-wrap">
          <table class="holdings-table" style="width:100%;font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid var(--line);color:var(--text-muted);font-size:10.5px;text-transform:uppercase;">
                <th style="padding:8px;text-align:left;">BROKER</th>
                <th style="padding:8px;text-align:left;">STOCK NAME</th>
                <th style="padding:8px;text-align:right;">QTY</th>
                <th style="padding:8px;text-align:right;">ORDER PRICE (% TO LTP)</th>
                <th style="padding:8px;text-align:right;">LTP</th>
                <th style="padding:8px;text-align:right;">TARGET PRICE (% TO LTP)</th>
                <th style="padding:8px;text-align:center;">STATUS</th>
                <th style="padding:8px;text-align:right;">DATE &amp; TIME</th>
              </tr>
            </thead>
            <tbody>
      `;

      todaysOrders.forEach(o => {
        // Dynamic Funds Validation for Live Order Rows
        const brokerKey = o.broker || 'angelone';
        const availCash = brokerFundsMap[brokerKey] || 0;
        const leverage = getLeverageFor(o.symbol);
        const requiredFunds = (o.productType === 'MARGIN' || o.isMtf)
          ? ((o.qty * o.price) / leverage)
          : (o.qty * o.price);

        if (o.status !== 'CANCELLED' && requiredFunds > availCash) {
          o.status = 'REJECTED (NO FUNDS)';
        }

        const isBuy = o.side === 'BUY';
        const isPending = (o.status || '').includes('PENDING');
        const isCancelled = o.status === 'CANCELLED';
        const isRejected = (o.status || '').includes('REJECTED');

        const ltpVal = o.ltp || o.price || 294.86;
        const priceDiffPct = ltpVal ? (((o.price - ltpVal) / ltpVal) * 100) : 0;
        const pricePctHtml = `<small style="font-size:10px;color:${priceDiffPct >= 0 ? 'var(--gain)' : 'var(--loss)'};">(${plSign(priceDiffPct)}${pct(priceDiffPct)})</small>`;

        let targetPctHtml = '—';
        if (o.targetPrice != null && o.targetPrice > 0) {
          const tgtDiffPct = ltpVal ? (((o.targetPrice - ltpVal) / ltpVal) * 100) : 0;
          targetPctHtml = `₹${rawMoney(o.targetPrice)} <small style="font-size:10px;color:var(--gain);">(${plSign(tgtDiffPct)}${pct(tgtDiffPct)})</small>`;
        }

        let badges = [];
        if (isRejected) {
          badges.push(`<span style="background:rgba(220,38,38,0.18);color:var(--loss);border:1px solid rgba(220,38,38,0.35);padding:2px 8px;border-radius:4px;font-weight:800;font-size:10.5px;white-space:nowrap;">⚠️ REJECTED (NO FUNDS)</span>`);
        } else if (isCancelled) {
          badges.push(`<span style="background:rgba(220,38,38,0.18);color:var(--loss);border:1px solid rgba(220,38,38,0.35);padding:2px 8px;border-radius:4px;font-weight:800;font-size:10.5px;white-space:nowrap;">🚫 CANCELLED</span>`);
        } else if (isPending) {
          badges.push(`<span style="background:rgba(37,99,235,0.15);color:#2563EB;border:1px solid rgba(37,99,235,0.35);padding:2px 8px;border-radius:4px;font-weight:800;font-size:10.5px;white-space:nowrap;">⏳ PENDING</span>`);
        } else {
          badges.push(`<span style="background:rgba(5,150,105,0.18);color:var(--gain);border:1px solid rgba(5,150,105,0.35);padding:2px 8px;border-radius:4px;font-weight:800;font-size:10.5px;white-space:nowrap;">✓ EXECUTED</span>`);
        }

        const isMarketOrder = o.type === 'MARKET' || o.orderType === 'MARKET' || o.isMarket;
        if (isMarketOrder) {
          badges.push(`<span style="background:rgba(147,51,234,0.15);color:#9333EA;border:1px solid rgba(147,51,234,0.35);padding:2px 6px;border-radius:4px;font-weight:800;font-size:10px;white-space:nowrap;">⚡ MARKET</span>`);
        } else if (o.type === 'LIMIT') {
          badges.push(`<span style="background:rgba(59,130,246,0.12);color:#3B82F6;border:1px solid rgba(59,130,246,0.25);padding:2px 6px;border-radius:4px;font-weight:800;font-size:10px;white-space:nowrap;">🎯 LIMIT</span>`);
        }

        const statusBadgeHtml = `<div style="display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap;">${badges.join('')}</div>`;

        html += `
          <tr class="order-row-clickable" data-order-id="${o.id}" style="border-bottom:1px solid var(--line);cursor:pointer;" title="Click row to Edit or Cancel">
            <td style="padding:9px 8px;font-weight:600;color:var(--text-primary);">${o.broker === 'angelone' ? 'Angel One' : 'Groww'}</td>
            <td style="padding:9px 8px;font-weight:800;font-family:var(--font-mono);color:var(--accent);">${o.symbol}</td>
            <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);font-weight:700;">${o.qty}</td>
            <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);font-weight:700;">₹${rawMoney(o.price)} ${pricePctHtml}</td>
            <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);">${ltpVal ? '₹' + rawMoney(ltpVal) : '—'}</td>
            <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);">${targetPctHtml}</td>
            <td style="padding:9px 8px;text-align:center;">${statusBadgeHtml}</td>
            <td style="padding:9px 8px;text-align:right;color:var(--text-muted);font-family:var(--font-mono);">${o.date} ${o.time}</td>
          </tr>
        `;
      });

      html += `</tbody></table></div>`;
      todaysContainer.innerHTML = html;
    }
  }

  // Render Trade History
  const historyContainer = document.getElementById('tradeHistoryContainer');
  if (historyContainer) {
    let html = `
      <div class="table-wrap">
        <table class="holdings-table" style="width:100%;font-size:12px;">
          <thead>
            <tr style="border-bottom:1px solid var(--line);color:var(--text-muted);font-size:10.5px;text-transform:uppercase;">
              <th style="padding:8px;text-align:left;">BROKER</th>
              <th style="padding:8px;text-align:left;">STOCK NAME</th>
              <th style="padding:8px;text-align:center;">SIDE & PERFORMANCE</th>
              <th style="padding:8px;text-align:right;">QTY</th>
              <th style="padding:8px;text-align:right;">EXECUTION PRICE</th>
              <th style="padding:8px;text-align:right;">DATE</th>
            </tr>
          </thead>
          <tbody>
    `;

    tradeHistory.forEach(h => {
      const isBuy = h.side === 'BUY';
      let sideHtml = '';
      if (isBuy) {
        sideHtml = `<span style="background:rgba(5,150,105,0.12);color:var(--gain);padding:2px 8px;border-radius:4px;font-weight:800;">BUY</span>`;
      } else {
        const buyCost = h.buyCost || (h.price * 0.88);
        const pnl = (h.price - buyCost) * h.qty;
        const pnlPct = ((h.price - buyCost) / buyCost) * 100;
        const isProf = pnl >= 0;

        sideHtml = `
          <span style="background:rgba(220,38,38,0.15);color:var(--loss);border:1px solid rgba(220,38,38,0.3);padding:3px 8px;border-radius:4px;font-weight:800;display:inline-flex;align-items:center;gap:4px;">
            <span>SELL</span>
            <span style="font-size:11px;">(${isProf ? 'PROFIT' : 'LOSS'} ${plSign(pnl)}₹${rawMoney(Math.abs(pnl))} ${pct(pnlPct)})</span>
          </span>
        `;
      }

      html += `
        <tr style="border-bottom:1px solid var(--line);">
          <td style="padding:9px 8px;font-weight:600;color:var(--text-primary);">${h.broker === 'angelone' ? 'Angel One' : 'Groww'}</td>
          <td style="padding:9px 8px;font-weight:800;font-family:var(--font-mono);color:var(--text-primary);">${h.symbol}</td>
          <td style="padding:9px 8px;text-align:center;">${sideHtml}</td>
          <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);font-weight:700;">${h.qty}</td>
          <td style="padding:9px 8px;text-align:right;font-family:var(--font-mono);font-weight:700;">₹${rawMoney(h.price)}</td>
          <td style="padding:9px 8px;text-align:right;color:var(--text-muted);">${h.date}</td>
        </tr>
      `;
    });

    html += `</tbody></table></div>`;
    historyContainer.innerHTML = html;
  }
}

export function recalculateOmValues() {
  const qty = Number(document.getElementById('omQtyInput')?.value) || 1;
  const price = Number(document.getElementById('omPriceInput')?.value) || activeOrderParams.ltp;
  const leverage = getLeverageFor(activeOrderParams.symbol);

  const totalValue = qty * price;
  const mtfValue = totalValue / leverage;
  const intradayValue = totalValue / 5.0;

  const totalValEl = document.getElementById('omTotalValue');
  const fullValEl = document.getElementById('omFullVal');
  const mtfValEl = document.getElementById('omMtfVal');
  const mtfLabelEl = document.getElementById('omMtfLabel');

  if (totalValEl) totalValEl.textContent = money(totalValue);

  if (fullValEl) {
    if (activeOrderParams.productType === 'INTRADAY') {
      fullValEl.textContent = money(intradayValue);
    } else {
      fullValEl.textContent = money(totalValue);
    }
  }

  if (mtfValEl) mtfValEl.textContent = money(mtfValue);
  if (mtfLabelEl) mtfLabelEl.textContent = `MTF (${leverage}x)`;
}

export function setProductType(prodType) {
  activeOrderParams.productType = prodType;

  const mtfBtn = document.getElementById('omMtfPayBtn');
  const fullBtn = document.getElementById('omFullPayBtn');

  document.querySelectorAll('.prod-btn').forEach((b) => {
    const isIntradayBtn = b.dataset.prod === 'INTRADAY';
    const isDelivBtn = b.dataset.prod === 'DELIVERY';

    if (prodType === 'INTRADAY') {
      b.classList.toggle('active', isIntradayBtn);
    } else {
      b.classList.toggle('active', isDelivBtn);
    }
  });

  if (prodType === 'INTRADAY') {
    if (mtfBtn) mtfBtn.style.display = 'none';
    if (fullBtn) {
      fullBtn.classList.add('active');
      const titleSpan = fullBtn.querySelector('.pay-title');
      if (titleSpan) titleSpan.textContent = 'Intraday (5x)';
    }
  } else if (prodType === 'MARGIN') {
    if (mtfBtn) {
      mtfBtn.style.display = 'flex';
      mtfBtn.classList.add('active');
    }
    if (fullBtn) {
      fullBtn.classList.remove('active');
      const titleSpan = fullBtn.querySelector('.pay-title');
      if (titleSpan) titleSpan.textContent = 'Pay Full';
    }
  } else { // DELIVERY
    if (mtfBtn) {
      mtfBtn.style.display = 'flex';
      mtfBtn.classList.remove('active');
    }
    if (fullBtn) {
      fullBtn.classList.add('active');
      const titleSpan = fullBtn.querySelector('.pay-title');
      if (titleSpan) titleSpan.textContent = 'Pay Full';
    }
  }
  recalculateOmValues();
}

export function updateBrokerFunds(funds) {
  if (!funds) return;
  if (funds.angelone != null) brokerFundsMap.angelone = funds.angelone;
  if (funds.groww != null) brokerFundsMap.groww = funds.groww;
  updateOmBrokerDisplay();
  renderOrdersUI();
}

export function openOrderTicketModal({ symbol, ltp, broker = 'angelone', side = 'BUY' }) {
  activeOrderParams.symbol = symbol || 'EMMVEE';
  activeOrderParams.ltp = Number(ltp) || 0;
  activeOrderParams.broker = broker || 'angelone';
  activeOrderParams.side = side || 'BUY';

  const modal = document.getElementById('orderTicketModal');
  const titleEl = document.getElementById('omSymbolTitle');
  const ltpEl = document.getElementById('omLtpVal');
  const priceInput = document.getElementById('omPriceInput');
  const qtyInput = document.getElementById('omQtyInput');

  if (titleEl) titleEl.textContent = activeOrderParams.symbol;
  if (ltpEl) ltpEl.textContent = money(activeOrderParams.ltp);
  if (priceInput) priceInput.value = activeOrderParams.ltp;
  if (qtyInput) qtyInput.value = 1;

  setBroker(activeOrderParams.broker);
  setSide(activeOrderParams.side);
  setProductType('DELIVERY');

  // Fetch 100% live real-time LTP & day change for this exact stock
  api(`/api/instruments/quote?symbol=${activeOrderParams.symbol}`).then((q) => {
    if (q && q.ltp != null) {
      const qLtp = Number(q.ltp || 0);
      const qChg = Number(q.change || 0);
      const qPct = Number(q.changePct || 0);

      activeOrderParams.ltp = qLtp;
      if (priceInput) priceInput.value = qLtp;
      if (ltpEl) {
        const isPos = qChg >= 0;
        const sign = isPos ? '+' : '';
        const color = isPos ? 'var(--gain)' : 'var(--loss)';
        ltpEl.innerHTML = `<span style="color:var(--text-primary);font-weight:700;">₹${qLtp.toFixed(2)}</span> <span style="font-size:12px;font-weight:600;color:${color};margin-left:4px;">${sign}${qChg.toFixed(2)} (${sign}${qPct.toFixed(2)}%)</span>`;
      }
      recalculateOmValues();
    }
  }).catch(() => {});

  if (modal) modal.style.display = 'flex';
}

function setBroker(broker) {
  activeOrderParams.broker = broker;
  document.querySelectorAll('#omBrokerTabs .om-broker-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.broker === broker);
  });
  updateOmBrokerDisplay();
}

function updateOmBrokerDisplay() {
  const broker = activeOrderParams.broker || 'angelone';
  const side = (activeOrderParams.side || 'BUY').toUpperCase();

  const modalHeader = document.querySelector('.order-modal-header');
  const modalCard = document.querySelector('.order-modal-card');
  if (modalHeader) {
    modalHeader.setAttribute('data-broker', broker);
    modalHeader.setAttribute('data-side', side.toLowerCase());
  }
  if (modalCard) {
    modalCard.setAttribute('data-broker', broker);
    modalCard.setAttribute('data-side', side.toLowerCase());
  }

  const availValEl = document.getElementById('omAvailVal');
  const availCash = brokerFundsMap[broker] != null ? brokerFundsMap[broker] : 0;
  if (availValEl) {
    availValEl.textContent = money(availCash);
  }
  const submitBtn = document.getElementById('omSubmitBtn');
  if (submitBtn) {
    const brokerName = broker === 'angelone' ? 'Angel One' : 'Groww';
    const isBuy = side === 'BUY';
    submitBtn.textContent = `Place ${isBuy ? 'Buy' : 'Sell'} Order (${brokerName})`;
    submitBtn.style.background = isBuy ? '#00B386' : '#EB5B56';
  }
}

function setSide(side) {
  activeOrderParams.side = side;
  document.querySelectorAll('#omSideToggle .bs-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.side === side);
  });
  updateOmBrokerDisplay();
}

export function initOrders() {
  renderOrdersUI();

  const modal = document.getElementById('orderTicketModal');
  const closeBtn = document.getElementById('closeOmBtn');
  const omForm = document.getElementById('omForm');

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  // Broker Tab Selector (Angel One vs Groww)
  document.querySelectorAll('#omBrokerTabs .om-broker-tab').forEach((tab) => {
    tab.addEventListener('click', () => setBroker(tab.dataset.broker));
  });

  // Side Toggle Buttons (B / S)
  document.querySelectorAll('#omSideToggle .bs-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSide(btn.dataset.side));
  });

  // Product Type Buttons (INT / DEL)
  document.querySelectorAll('.prod-btn').forEach((btn) => {
    btn.addEventListener('click', () => setProductType(btn.dataset.prod));
  });

  // Pay Mode Cards (MTF 3x vs Pay Full)
  const mtfBtn = document.getElementById('omMtfPayBtn');
  const fullBtn = document.getElementById('omFullPayBtn');

  if (mtfBtn) {
    mtfBtn.addEventListener('click', () => setProductType('MARGIN'));
  }

  if (fullBtn) {
    fullBtn.addEventListener('click', () => setProductType(activeOrderParams.productType === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY'));
  }

  // Order Mode Tabs (Regular / Stop Loss / GTT / SIP)
  document.querySelectorAll('.om-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.om-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      activeOrderParams.orderMode = tab.dataset.omTab;
      const triggerWrap = document.getElementById('omTriggerPriceWrap');
      if (triggerWrap) {
        const isTrigger = tab.dataset.omTab === 'STOPLOSS' || tab.dataset.omTab === 'GTT';
        triggerWrap.style.display = isTrigger ? 'block' : 'none';
      }
    });
  });

  // Unified Price (₹) & Percentage (%) Synchronized Box Controls for Order Ticket Modal
  const omSlInput = document.getElementById('omSlInput');
  const omSlPctInput = document.getElementById('omSlPctInput');
  const omTargetInput = document.getElementById('omTargetInput');
  const omTargetPctInput = document.getElementById('omTargetPctInput');

  if (omSlInput && omSlPctInput) {
    omSlInput.addEventListener('input', () => {
      const ltp = activeOrderParams.ltp || 294.86;
      const val = Number(omSlInput.value);
      if (ltp && val > 0) {
        const pctVal = Math.abs(((val - ltp) / ltp) * 100);
        omSlPctInput.value = pctVal.toFixed(1);
      } else {
        omSlPctInput.value = '';
      }
    });

    omSlPctInput.addEventListener('input', () => {
      const ltp = activeOrderParams.ltp || 294.86;
      const isBuy = activeOrderParams.side === 'BUY';
      const pctVal = Number(omSlPctInput.value);
      if (ltp && pctVal > 0) {
        const val = isBuy ? (ltp * (1 - pctVal / 100)) : (ltp * (1 + pctVal / 100));
        omSlInput.value = val.toFixed(2);
      } else {
        omSlInput.value = '';
      }
    });
  }

  if (omTargetInput && omTargetPctInput) {
    omTargetInput.addEventListener('input', () => {
      const ltp = activeOrderParams.ltp || 294.86;
      const val = Number(omTargetInput.value);
      if (ltp && val > 0) {
        const pctVal = Math.abs(((val - ltp) / ltp) * 100);
        omTargetPctInput.value = pctVal.toFixed(1);
      } else {
        omTargetPctInput.value = '';
      }
    });

    omTargetPctInput.addEventListener('input', () => {
      const ltp = activeOrderParams.ltp || 294.86;
      const isBuy = activeOrderParams.side === 'BUY';
      const pctVal = Number(omTargetPctInput.value);
      if (ltp && pctVal > 0) {
        const val = isBuy ? (ltp * (1 + pctVal / 100)) : (ltp * (1 - pctVal / 100));
        omTargetInput.value = val.toFixed(2);
      } else {
        omTargetInput.value = '';
      }
    });
  }

  // Limit / Market Switch
  const marketSwitch = document.getElementById('omMarketSwitch');
  const priceInput = document.getElementById('omPriceInput');
  const priceLabel = document.getElementById('omPriceTypeLabel');
  if (marketSwitch && priceInput && priceLabel) {
    marketSwitch.addEventListener('change', () => {
      if (marketSwitch.checked) {
        priceLabel.textContent = 'Market';
        priceInput.disabled = true;
        priceInput.value = activeOrderParams.ltp;
      } else {
        priceLabel.textContent = 'Limit';
        priceInput.disabled = false;
      }
      recalculateOmValues();
    });
  }

  const omQtyInput = document.getElementById('omQtyInput');
  if (omQtyInput) omQtyInput.addEventListener('input', recalculateOmValues);
  if (priceInput) priceInput.addEventListener('input', recalculateOmValues);

  // Action Modal Handlers (Cancel & Edit Order)
  const actionModal = document.getElementById('orderActionModal');
  const closeActionBtn = document.getElementById('closeActionModalBtn');
  const btnCancel = document.getElementById('btnCancelOrder');
  const btnEdit = document.getElementById('btnEditOrder');

  if (closeActionBtn && actionModal) {
    closeActionBtn.addEventListener('click', () => { actionModal.style.display = 'none'; });
  }

  if (btnCancel && actionModal) {
    btnCancel.addEventListener('click', () => {
      const order = todaysOrders.find(o => o.id === selectedActionOrderId);
      if (order) {
        order.status = 'CANCELLED';
        renderOrdersUI();
      }
      actionModal.style.display = 'none';
    });
  }

  const editModal = document.getElementById('editOrderModal');
  const closeEditBtn = document.getElementById('closeEditModalBtn');
  const editForm = document.getElementById('editOrderForm');

  const editSymbolEl = document.getElementById('editOrderSymbol');
  const editLtpEl = document.getElementById('editOrderLtp');
  const editQtyInput = document.getElementById('editOrderQty');
  const editPriceInput = document.getElementById('editOrderPrice');
  const editPctInput = document.getElementById('editOrderPct');
  const editTargetPriceInput = document.getElementById('editOrderTargetPrice');
  const editTargetPctInput = document.getElementById('editOrderTargetPct');
  const editSlPriceInput = document.getElementById('editOrderSlPrice');
  const editSlPctInput = document.getElementById('editOrderSlPct');

  if (closeEditBtn && editModal) {
    closeEditBtn.addEventListener('click', () => { editModal.style.display = 'none'; });
  }

  if (btnEdit && actionModal && editModal) {
    btnEdit.addEventListener('click', () => {
      const order = todaysOrders.find(o => o.id === selectedActionOrderId);
      if (order) {
        const ltp = order.ltp || 294.86;
        document.getElementById('editOrderId').value = order.id;
        if (editSymbolEl) editSymbolEl.textContent = order.symbol;
        if (editLtpEl) editLtpEl.textContent = money(ltp);

        if (editQtyInput) editQtyInput.value = order.qty;
        if (editPriceInput) editPriceInput.value = order.price;
        if (editPctInput && ltp) {
          editPctInput.value = (((order.price - ltp) / ltp) * 100).toFixed(2);
        }

        if (editTargetPriceInput) {
          editTargetPriceInput.value = order.targetPrice != null ? order.targetPrice : '';
        }
        if (editTargetPctInput && ltp) {
          editTargetPctInput.value = (order.targetPrice != null && order.targetPrice > 0)
            ? (((order.targetPrice - ltp) / ltp) * 100).toFixed(2)
            : '';
        }

        if (editSlPriceInput) {
          editSlPriceInput.value = order.stopLossPrice != null ? order.stopLossPrice : '';
        }
        if (editSlPctInput && ltp) {
          editSlPctInput.value = (order.stopLossPrice != null && order.stopLossPrice > 0)
            ? (((order.stopLossPrice - ltp) / ltp) * 100).toFixed(2)
            : '';
        }

        actionModal.style.display = 'none';
        editModal.style.display = 'flex';
      }
    });
  }

  // Dual Synchronized Input Listeners:
  // 1. Order Price (₹) <-> Order Price (% to LTP)
  if (editPriceInput && editPctInput) {
    editPriceInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const newPrice = Number(editPriceInput.value) || 0;
      if (ltp && newPrice) {
        editPctInput.value = (((newPrice - ltp) / ltp) * 100).toFixed(2);
      }
    });

    editPctInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const pctVal = Number(editPctInput.value);
      if (ltp && !isNaN(pctVal)) {
        editPriceInput.value = (ltp * (1 + pctVal / 100)).toFixed(2);
      }
    });
  }

  // 2. Target Price (₹) <-> Target Price (% to LTP)
  if (editTargetPriceInput && editTargetPctInput) {
    editTargetPriceInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const newTgt = Number(editTargetPriceInput.value) || 0;
      if (ltp && newTgt) {
        editTargetPctInput.value = (((newTgt - ltp) / ltp) * 100).toFixed(2);
      }
    });

    editTargetPctInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const pctVal = Number(editTargetPctInput.value);
      if (ltp && !isNaN(pctVal)) {
        editTargetPriceInput.value = (ltp * (1 + pctVal / 100)).toFixed(2);
      }
    });
  }

  // 3. Stop Loss Price (₹) <-> Stop Loss Price (% to LTP)
  if (editSlPriceInput && editSlPctInput) {
    editSlPriceInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const newSl = Number(editSlPriceInput.value) || 0;
      if (ltp && newSl) {
        editSlPctInput.value = (((newSl - ltp) / ltp) * 100).toFixed(2);
      }
    });

    editSlPctInput.addEventListener('input', () => {
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      const ltp = order?.ltp || 294.86;
      const pctVal = Number(editSlPctInput.value);
      if (ltp && !isNaN(pctVal)) {
        editSlPriceInput.value = (ltp * (1 + pctVal / 100)).toFixed(2);
      }
    });
  }

  if (editForm && editModal) {
    editForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const orderId = document.getElementById('editOrderId').value;
      const order = todaysOrders.find(o => o.id === orderId);
      if (order) {
        order.qty = Number(document.getElementById('editOrderQty').value) || order.qty;
        order.price = Number(document.getElementById('editOrderPrice').value) || order.price;
        
        const tgtVal = document.getElementById('editOrderTargetPrice').value;
        order.targetPrice = tgtVal !== '' ? Number(tgtVal) : null;

        const slVal = document.getElementById('editOrderSlPrice').value;
        order.stopLossPrice = slVal !== '' ? Number(slVal) : null;

        // Re-evaluate execution rules after edit
        const ltp = order.ltp || 294.86;
        if (order.side === 'BUY') {
          order.status = (ltp <= order.price) ? 'EXECUTED' : 'PENDING (WAITING PRICE <= LIMIT)';
        } else if (order.side === 'SELL') {
          order.status = (ltp >= order.price) ? 'EXECUTED' : 'PENDING (WAITING PRICE >= LIMIT)';
        }
        renderOrdersUI();
      }
      editModal.style.display = 'none';
    });
  }

  // Clickable Full Order Row Listener
  document.addEventListener('click', (e) => {
    const row = e.target.closest('.order-row-clickable');
    if (row) {
      const orderId = row.dataset.orderId;
      openOrderActionModal(orderId);
    }
  });

  // Order Ticket Modal Form Submission
  if (omForm) {
    omForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const symbol = activeOrderParams.symbol;
      const broker = activeOrderParams.broker;
      const side = activeOrderParams.side;
      const priceInput = document.getElementById('omPriceInput');
      const qtyInput = document.getElementById('omQtyInput');
      const slInput = document.getElementById('omSlInput');
      const targetInput = document.getElementById('omTargetInput');

      const isStopLossMode = activeOrderParams.orderMode === 'STOPLOSS';
      const orderPrice = Number(priceInput?.value) || activeOrderParams.ltp;
      
      const slVal = Number(slInput?.value);
      const tgtVal = Number(targetInput?.value);

      const targetPrice = tgtVal > 0 ? tgtVal : null;
      const stopLossPrice = slVal > 0 ? slVal : null;

      addOrderToToday({
        broker,
        symbol,
        side,
        type: isStopLossMode ? 'TARGET_SL' : (priceInput && !priceInput.disabled ? 'LIMIT' : 'MARKET'),
        qty: Number(qtyInput?.value) || 1,
        price: orderPrice,
        targetPrice,
        stopLossPrice,
        ltp: activeOrderParams.ltp
      });

      if (modal) modal.style.display = 'none';
      goToView('orders');
    });
  }
}

export function renderOrdersHistory() {
  renderOrdersUI();
}
