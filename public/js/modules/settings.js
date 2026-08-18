export const STOCK_LEVERAGE_DEFAULTS = {
  'EMMVEE-EQ': 2.9,
  'EMMVEE': 2.9,
  'HDFCBANK-EQ': 4.4,
  'HDFCBANK': 4.4,
  'ONGC-EQ': 4.2,
  'ONGC': 4.2,
  'SHRIRAMFIN-EQ': 3.6,
  'SHRIRAMFIN': 3.6,
  'MCX-EQ': 3.5,
  'MCX': 3.5,
  'RELIANCE-EQ': 4.0,
  'RELIANCE': 4.0,
};

// Load saved custom MTF ratios from localStorage if present
try {
  const saved = localStorage.getItem('CUSTOM_STOCK_MTF_RATIOS');
  if (saved) {
    const parsed = JSON.parse(saved);
    Object.assign(STOCK_LEVERAGE_DEFAULTS, parsed);
  }
} catch (e) {}

export function renderGlobalMtfRatiosTable() {
  const tbody = document.getElementById('tbodyGlobalMtfRatios');
  if (!tbody) return;

  const entries = Object.entries(STOCK_LEVERAGE_DEFAULTS).filter(([sym]) => !sym.endsWith('-EQ'));
  if (entries.length === 0) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">No stock MTF ratios configured</td></tr>';
    return;
  }

  tbody.innerHTML = entries.map(([sym, lev]) => {
    const cashPct = (100 / lev).toFixed(1);
    return `
      <tr>
        <td style="font-weight:700;">${sym}</td>
        <td style="text-align:right;font-family:var(--font-mono);color:var(--accent);font-weight:800;">${lev}x</td>
        <td style="text-align:right;font-family:var(--font-mono);color:var(--text-muted);">${cashPct}% Cash</td>
        <td style="text-align:center;">
          <button type="button" class="edit-icon-btn remove-mtf-ratio-btn" data-sym="${sym}" title="Remove custom ratio" style="color:var(--loss);">×</button>
        </td>
      </tr>`;
  }).join('');

  document.querySelectorAll('.remove-mtf-ratio-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sym = btn.dataset.sym;
      delete STOCK_LEVERAGE_DEFAULTS[sym];
      delete STOCK_LEVERAGE_DEFAULTS[`${sym}-EQ`];
      saveGlobalMtfRatios();
      renderGlobalMtfRatiosTable();
    });
  });
}

function saveGlobalMtfRatios() {
  try {
    localStorage.setItem('CUSTOM_STOCK_MTF_RATIOS', JSON.stringify(STOCK_LEVERAGE_DEFAULTS));
  } catch (e) {}
}

export function initSettingsView() {
  const fundsForm = document.getElementById('fundsForm');
  const fundsDateInput = document.getElementById('fundsDate');
  if (fundsDateInput) fundsDateInput.valueAsDate = new Date();

  if (fundsForm) {
    fundsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const broker = document.getElementById('fundsBroker').value;
      const body = {
        type: document.getElementById('fundsType').value,
        amount: Number(document.getElementById('fundsAmount').value),
        txnDate: document.getElementById('fundsDate').value,
      };
      try {
        await api(`/api/${broker}/ledger/funds`, { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('fundsAmount').value = '';
        loadFundsTotals();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  const globalForm = document.getElementById('globalMtfRatioForm');
  const symInput = document.getElementById('globalMtfSymbolInput');
  const suggestionsBox = document.getElementById('globalMtfSuggestions');
  let searchDebounce = null;

  if (symInput && suggestionsBox) {
    const doSearch = async () => {
      const query = symInput.value.trim();
      try {
        const results = await api(`/api/instruments/search?q=${encodeURIComponent(query || 'V')}`);
        if (!results || results.length === 0) {
          suggestionsBox.style.display = 'none';
          return;
        }

        suggestionsBox.innerHTML = results.map((r) => {
          const rec = r.recommendedMtf || 3.0;
          return `
            <div class="search-suggestion-item" data-sym="${r.symbol}" data-rec="${rec}">
              <div>
                <span class="s-sym">${r.symbol}</span>
                <span class="s-name" style="margin-left:6px;">${r.name}</span>
              </div>
              <span style="font-size:10px;font-weight:700;color:#38bdf8;background:rgba(56,189,248,0.12);padding:1px 5px;border-radius:3px;">⚡ ${rec}x MTF</span>
            </div>`;
        }).join('');
        suggestionsBox.style.display = 'block';

        suggestionsBox.querySelectorAll('.search-suggestion-item').forEach((item) => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const sym = item.dataset.sym;
            const rec = Number(item.dataset.rec) || 3.0;
            symInput.value = sym;
            suggestionsBox.style.display = 'none';

            const existingLev = STOCK_LEVERAGE_DEFAULTS[sym];
            const levToUse = existingLev || rec;

            const ratioInp = document.getElementById('globalMtfRatioInput');
            if (ratioInp) ratioInp.value = levToUse;

            // Display recommendation badge
            const recBox = document.getElementById('mtfRecInfoBox');
            const recVal = document.getElementById('mtfRecVal');
            const recCash = document.getElementById('mtfRecCash');
            if (recBox && recVal && recCash) {
              recVal.textContent = `${rec}x`;
              recCash.textContent = `${(100 / rec).toFixed(1)}% Cash`;
              recBox.style.display = 'block';
            }
          });
        });
      } catch (err) {
        suggestionsBox.style.display = 'none';
      }
    };

    symInput.addEventListener('focus', doSearch);
    symInput.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(doSearch, 100);
    });

    document.addEventListener('click', (e) => {
      if (!symInput.contains(e.target) && !suggestionsBox.contains(e.target)) {
        suggestionsBox.style.display = 'none';
      }
    });
  }

  const recBox = document.getElementById('mtfRecInfoBox');
  if (recBox) {
    recBox.addEventListener('click', () => {
      const recValStr = document.getElementById('mtfRecVal')?.textContent.replace('x', '');
      const ratioInp = document.getElementById('globalMtfRatioInput');
      if (recValStr && ratioInp) ratioInp.value = Number(recValStr) || 2.9;
    });
  }

  if (globalForm) {
    globalForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const ratioInput = document.getElementById('globalMtfRatioInput');
      if (!symInput || !ratioInput) return;

      const sym = symInput.value.trim().toUpperCase();
      const ratio = Number(ratioInput.value);
      if (!sym || isNaN(ratio) || ratio <= 0) return alert('Please enter a valid stock symbol and positive leverage ratio');

      STOCK_LEVERAGE_DEFAULTS[sym] = ratio;
      STOCK_LEVERAGE_DEFAULTS[`${sym}-EQ`] = ratio;
      saveGlobalMtfRatios();

      symInput.value = '';
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      if (recBox) recBox.style.display = 'none';
      renderGlobalMtfRatiosTable();
    });
  }

  renderGlobalMtfRatiosTable();

  // Handle WhatsApp & Telegram Settings Forms
  const waForm = document.getElementById('settingsWaForm');
  const tgForm = document.getElementById('settingsTgForm');
  const waKeyInput = document.getElementById('settingsWaKeyInput');
  const tgTokenInput = document.getElementById('settingsTgTokenInput');
  const tgChatInput = document.getElementById('settingsTgChatIdInput');
  const testAllBtn = document.getElementById('settingsTestAllBtn');
  const statusAlert = document.getElementById('settingsNotificationAlert');

  // Load notification settings on init
  api('/api/notifications/settings').then((cfg) => {
    if (waKeyInput && cfg.whatsappApiKey) waKeyInput.value = cfg.whatsappApiKey;
    if (tgTokenInput && cfg.botToken) tgTokenInput.value = cfg.botToken;
    if (tgChatInput && cfg.chatId) tgChatInput.value = cfg.chatId;
  }).catch(() => {});

  if (waForm) {
    waForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const whatsappApiKey = waKeyInput?.value || '';
      api('/api/notifications/settings', 'POST', { whatsappApiKey })
        .then(() => {
          if (statusAlert) {
            statusAlert.style.display = 'block';
            statusAlert.style.background = 'rgba(16,185,129,0.15)';
            statusAlert.style.color = '#10B981';
            statusAlert.textContent = '✓ Saved WhatsApp API Key for +91 9390219001!';
          }
        });
    });
  }

  if (tgForm) {
    tgForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const botToken = tgTokenInput?.value || '';
      const chatId = tgChatInput?.value || '';
      api('/api/notifications/settings', 'POST', { botToken, chatId })
        .then(() => {
          if (statusAlert) {
            statusAlert.style.display = 'block';
            statusAlert.style.background = 'rgba(16,185,129,0.15)';
            statusAlert.style.color = '#10B981';
            statusAlert.textContent = '✓ Saved Telegram Bot Token & Chat ID!';
          }
        });
    });
  }

  if (testAllBtn) {
    testAllBtn.addEventListener('click', () => {
      if (statusAlert) {
        statusAlert.style.display = 'block';
        statusAlert.style.background = 'rgba(37,99,235,0.15)';
        statusAlert.style.color = '#2563EB';
        statusAlert.textContent = '⏳ Sending multi-channel test push alert...';
      }
      api('/api/notifications/test', 'POST')
        .then((res) => {
          if (statusAlert) {
            if (res.success) {
              statusAlert.style.background = 'rgba(16,185,129,0.15)';
              statusAlert.style.color = '#10B981';
              statusAlert.textContent = `📲 TEST PUSH SENT! Delivered to ${res.sentTo?.join(', ') || 'Phone (+91 9390219001)'}!`;
            } else {
              statusAlert.style.background = 'rgba(239,68,68,0.15)';
              statusAlert.style.color = 'var(--loss)';
              statusAlert.textContent = `⚠️ Notification: ${res.reason || 'Failed to deliver'}`;
            }
          }
        });
    });
  }
}

export async function loadFundsTotals() {
  try {
    const [angel, groww] = await Promise.all([
      api('/api/angelone/ledger/funds').catch(() => null),
      api('/api/groww/ledger/funds').catch(() => null),
    ]);
    const angelEl = document.getElementById('fundsNetAngel');
    const growwEl = document.getElementById('fundsNetGroww');
    if (angel && angel.totals && angelEl) angelEl.textContent = money(angel.totals.net || 0);
    if (groww && groww.totals && growwEl) growwEl.textContent = money(groww.totals.net || 0);
  } catch (err) {
    console.warn('funds totals load warning:', err.message);
  }
}
