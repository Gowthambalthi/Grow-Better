/**
 * public/js/app.js
 * Main Application Bootstrapper & ES Module Entry Point
 */

import { initTheme } from './core/theme.js?v=20260821_v117';
import { initRouter } from './core/router.js?v=20260821_v117';
import { initPopovers, startTicker } from './components/ticker.js?v=20260821_v117';
import { loadStatus } from './components/statusPill.js?v=20260821_v117';
import { initPortfolio, loadPortfolio } from './modules/portfolio.js?v=20260821_v117';
import { initOrders } from './modules/orders.js?v=20260821_v117';
import { loadMtfPositions, initPositionsSubtabs } from './modules/positions.js?v=20260821_v117';
import { initInstitutionalScanner } from './modules/scanner.js?v=20260821_v117';
import { initSettingsView, loadFundsTotals } from './modules/settings.js?v=20260821_v117';

function refreshAll() {
  loadStatus();
  loadPortfolio();
  loadMtfPositions();
  loadFundsTotals();
}

function boot() {
  // Always load initial data FIRST so tables populate immediately!
  refreshAll();

  try { initTheme(); } catch (e) { console.error('initTheme error:', e); }
  try { initRouter(); } catch (e) { console.error('initRouter error:', e); }
  try { initPopovers(); } catch (e) { console.error('initPopovers error:', e); }
  try { initPortfolio(); } catch (e) { console.error('initPortfolio error:', e); }
  try { initOrders(); } catch (e) { console.error('initOrders error:', e); }
  try { initPositionsSubtabs(); } catch (e) { console.error('initPositionsSubtabs error:', e); }
  try { initInstitutionalScanner(); } catch (e) { console.error('initInstitutionalScanner error:', e); }
  try { initSettingsView(); } catch (e) { console.error('initSettingsView error:', e); }
  try { initMobileNotifications(); } catch (e) { console.error('initMobileNotifications error:', e); }

  // Instant Calendar Picker on Date Input Click (No mm/dd/yyyy lag!)
  document.addEventListener('click', (e) => {
    const dateInput = e.target.closest('input[type="date"]');
    if (dateInput && typeof dateInput.showPicker === 'function') {
      try { dateInput.showPicker(); } catch (err) {}
    }
  });

  startTicker();

  setInterval(loadStatus, 15000);
  setInterval(loadPortfolio, 2500);
  setInterval(loadMtfPositions, 15000);
}

function initMobileNotifications() {
  const signalBtn = document.getElementById('signalToggleBtn');
  const signalDot = document.getElementById('signalDotStatus');
  const signalLbl = document.getElementById('signalTextLbl');
  const tgPopover = document.getElementById('telegramPopover');
  const closeTgBtn = document.getElementById('closeTelegramPopoverBtn');
  const tgForm = document.getElementById('telegramConfigForm');
  const waApiKeyInput = document.getElementById('waApiKeyInput');
  const botTokenInput = document.getElementById('tgBotTokenInput');
  const chatIdInput = document.getElementById('tgChatIdInput');
  const testPhoneBtn = document.getElementById('testTgPhoneBtn');
  const statusAlert = document.getElementById('tgStatusAlert');

  let isEnabled = true;

  // Load current settings from backend
  fetch('/api/notifications/settings')
    .then(r => r.json())
    .then(cfg => {
      if (waApiKeyInput) waApiKeyInput.value = cfg.whatsappApiKey || '';
      if (botTokenInput) botTokenInput.value = cfg.botToken || '';
      if (chatIdInput) chatIdInput.value = cfg.chatId || '';
      isEnabled = cfg.enabled !== false;
      updateSignalUI(isEnabled);
    })
    .catch(() => {});

  function updateSignalUI(on) {
    if (signalDot) {
      if (on) {
        signalDot.classList.add('on');
        if (signalLbl) signalLbl.textContent = 'Signals On';
      } else {
        signalDot.classList.remove('on');
        if (signalLbl) signalLbl.textContent = 'Signals Off';
      }
    }
  }

  if (signalBtn) {
    signalBtn.addEventListener('click', (e) => {
      if (e.target.closest('#closeTelegramPopoverBtn')) return;
      if (tgPopover) {
        const isShown = tgPopover.classList.contains('show');
        document.querySelectorAll('.dropdown-popover').forEach(p => p.classList.remove('show'));
        if (!isShown) tgPopover.classList.add('show');
      }
    });
  }

  if (closeTgBtn) {
    closeTgBtn.addEventListener('click', () => {
      if (tgPopover) tgPopover.classList.remove('show');
    });
  }

  if (tgForm) {
    tgForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const botToken = botTokenInput?.value || '';
      const chatId = chatIdInput?.value || '';

      fetch('/api/notifications/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId, enabled: isEnabled })
      })
        .then(r => r.json())
        .then(res => {
          if (statusAlert) {
            statusAlert.style.display = 'block';
            statusAlert.style.background = 'rgba(16,185,129,0.15)';
            statusAlert.style.color = '#10B981';
            statusAlert.textContent = '✓ Saved credentials! Notifications linked.';
          }
        })
        .catch(err => {
          if (statusAlert) {
            statusAlert.style.display = 'block';
            statusAlert.style.background = 'rgba(239,68,68,0.15)';
            statusAlert.style.color = 'var(--loss)';
            statusAlert.textContent = '❌ Failed to save credentials.';
          }
        });
    });
  }

  if (testPhoneBtn) {
    testPhoneBtn.addEventListener('click', () => {
      const botToken = botTokenInput?.value || '';
      const chatId = chatIdInput?.value || '';

      if (statusAlert) {
        statusAlert.style.display = 'block';
        statusAlert.style.background = 'rgba(37,99,235,0.15)';
        statusAlert.style.color = '#2563EB';
        statusAlert.textContent = '⏳ Sending test push alert to phone...';
      }

      fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken, chatId })
      })
        .then(r => r.json())
        .then(res => {
          if (statusAlert) {
            if (res.success) {
              statusAlert.style.background = 'rgba(16,185,129,0.15)';
              statusAlert.style.color = '#10B981';
              statusAlert.textContent = '📲 TEST ALERT SENT! Check your phone Telegram app!';
            } else {
              statusAlert.style.background = 'rgba(239,68,68,0.15)';
              statusAlert.style.color = 'var(--loss)';
              statusAlert.textContent = `⚠️ Notification: ${res.reason || 'Bot Token / Chat ID missing'}`;
            }
          }
        })
        .catch(err => {
          if (statusAlert) {
            statusAlert.style.background = 'rgba(239,68,68,0.15)';
            statusAlert.style.color = 'var(--loss)';
            statusAlert.textContent = '❌ Connection error.';
          }
        });
    });
  }
}

document.addEventListener('DOMContentLoaded', boot);