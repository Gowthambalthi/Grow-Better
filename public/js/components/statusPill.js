/**
 * public/js/components/statusPill.js
 * Broker Connection Status Indicator Module
 */

import { api } from '../core/api.js';

export async function loadStatus() {
  try {
    const status = await api('/api/status');
    for (const broker of ['angelone', 'groww']) {
      const pill = document.querySelector(`.status-dot-pill[data-broker="${broker}"]`);
      if (!pill) continue;
      const st = status[broker];
      const isOk = st && st.connected;
      pill.className = `status-dot-pill ${isOk ? 'connected' : 'error'}`;
      pill.title = st ? (isOk ? `Connected since ${st.loginTime}` : `Error: ${st.lastError}`) : 'Disabled';
    }
  } catch (err) {
    console.error('status check failed', err);
  }
}
