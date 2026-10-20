/**
 * common/notifications/telegramApprovals.js — THE PHONE SIDE OF A CONFIRM-FIRST ORDER.
 *
 * A proposal becomes a Telegram message with two buttons, and the bot listens for the tap. The
 * listening is a LONG POLL of getUpdates rather than a webhook: this server runs on a laptop
 * behind NAT, and requiring a public HTTPS endpoint would mean the approval path is down whenever
 * the tunnel is — which is exactly the afternoon you want to trade from your phone.
 *
 * THE SECURITY RULE, and it is the only one that matters here: A BUTTON IN SOMEONE ELSE'S CHAT MUST
 * NOT BUY ANYTHING. `--bot` tokens are not secret, they are discoverable, and a bot can be messaged
 * by anyone who finds its username. So every update is checked against the configured chat id and
 * anything else is dropped without a reply — not even an error, because a reply confirms the bot is
 * alive to a stranger.
 *
 * WHAT THE MESSAGE SAYS. It repeats the exact levels the approval will use and the size that was
 * computed from the live balance, because the operator is being asked to approve a specific order
 * rather than the idea of an order. It also says the size is re-checked at click time: the balance
 * can fall between the press and the tap, and the approved number is a claim about the past.
 */
'use strict';

const axios = require('axios');

const API = 'https://api.telegram.org';

/** `ord:<id>:yes` / `ord:<id>:no` — short enough for Telegram's 64-byte callback limit. */
function callbackData(id, decision) {
  return 'ord:' + id + ':' + (decision === 'cancel' || decision === 'no' ? 'no' : 'yes');
}

/** Parse a callback payload. Returns null for anything that is not ours. */
function parseCallbackData(data) {
  const m = /^ord:([A-Z0-9]{1,16}):(yes|no)$/.exec(String(data || ''));
  if (!m) return null;
  return { id: m[1], decision: m[2] === 'yes' ? 'approve' : 'cancel' };
}

/**
 * A typed reply is the fallback when buttons are unavailable (old client, forwarded message).
 * Accepts "yes A7K2", "no A7K2" and a bare "yes"/"no" — the bare form is only resolved by the
 * caller when exactly one proposal is waiting, because "yes" to two live orders is not a decision.
 */
function parseTextCommand(text) {
  const s = String(text || '').trim();
  const m = /^(yes|no|y|n|approve|cancel)\b\s*([A-Z0-9]{1,16})?$/i.exec(s);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return {
    decision: (word === 'yes' || word === 'y' || word === 'approve') ? 'approve' : 'cancel',
    id: m[2] ? m[2].toUpperCase() : null,
  };
}

/** Only the configured chat may decide. Everything else is dropped silently. */
function isAllowedChat(updateChatId, configuredChatId) {
  if (configuredChatId == null || configuredChatId === '') return false;
  return String(updateChatId) === String(configuredChatId);
}

const money = (n) => (n == null || !Number.isFinite(Number(n))) ? '—' : '₹' + Number(n).toFixed(2);

/** The message. Plain and specific: what will be bought, at what size, with which guard rails. */
function proposalText(approval) {
  const p = approval.proposal || {};
  const side = String(p.side || 'BUY').toUpperCase();
  const risk = (p.entry != null && p.stop != null) ? Math.abs(Number(p.entry) - Number(p.stop)) : null;
  const reward = (p.entry != null && p.target != null) ? Math.abs(Number(p.target) - Number(p.entry)) : null;
  const rr = (risk && reward) ? (reward / risk).toFixed(2) : null;
  const notional = (p.entry != null && p.quantity != null) ? Number(p.entry) * Number(p.quantity) : null;
  const expiresIn = Math.max(0, Math.round((approval.expiresAt - Date.now()) / 1000));

  const lines = [
    '<b>' + (side === 'BUY' ? '🟢 BUY' : '🔴 SELL') + ' ' + (p.symbol || '?') + '</b>',
    'Quantity: <b>' + (p.quantity != null ? p.quantity : '?') + '</b>' +
      (notional != null ? '  (' + money(notional) + ')' : ''),
    'Entry: ' + money(p.entry),
    'Stop: ' + money(p.stop) + (risk != null ? '  (risk ' + money(risk) + '/share)' : ''),
    'Target: ' + money(p.target) + (rr ? '  (R:R 1:' + rr + ')' : ''),
  ];
  if (p.capital != null) lines.push('Size from balance: ' + money(p.capital));
  lines.push('');
  lines.push('Tap ✅ to place it at Angel One, ❌ to drop it.');
  lines.push('<i>Rev ' + approval.id + ' · expires in ' + expiresIn + 's · size is re-checked against the live balance when you tap.</i>');
  return lines.join('\n');
}

function keyboard(approval) {
  return {
    inline_keyboard: [[
      { text: '✅ Place it', callback_data: callbackData(approval.id, 'approve') },
      { text: '❌ Drop it', callback_data: callbackData(approval.id, 'cancel') },
    ]],
  };
}

async function sendProposal({ approval, token, chatId }) {
  const res = await axios.post(`${API}/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: proposalText(approval),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard(approval),
  }, { timeout: 10000 });
  if (!res.data || !res.data.ok) {
    throw new Error('Telegram refused the proposal: ' + JSON.stringify(res.data).slice(0, 300));
  }
  return { ok: true, messageId: res.data.result && res.data.result.message_id };
}

/** Replace the message with the outcome, so a stale ✅ can never be tapped twice by accident. */
async function editOutcome({ token, chatId, messageId, text }) {
  if (!messageId) return { ok: false, reason: 'no message id to edit' };
  try {
    await axios.post(`${API}/bot${token}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, { timeout: 8000 });
    return { ok: true };
  } catch (e) {
    // An edit can fail when the text is unchanged, which is not a failure of the order.
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

/** Stop the client spinning forever on the tap. */
async function answerCallback({ token, callbackId, text }) {
  try {
    await axios.post(`${API}/bot${token}/answerCallbackQuery`, {
      callback_query_id: callbackId,
      text: String(text || '').slice(0, 190),
    }, { timeout: 6000 });
    return true;
  } catch (_) { return false; }
}

/**
 * Long poll. `onDecision({ id, decision, channel })` is called for each accepted tap; it is awaited
 * so two taps cannot interleave their broker calls. Errors are logged and the loop continues —
 * a dropped update must not take the approval path down for the rest of the session.
 */
function startPolling({ token, chatId, onDecision, onText = null, log = console.log, timeoutSec = 25 }) {
  if (!token || !chatId) {
    log('[telegramApprovals] not started — no bot token or chat id configured.');
    return { stop() {}, running: false };
  }
  let offset = 0;
  let stopped = false;

  async function handle(update) {
    if (!update) return;
    if (update.callback_query) {
      const cq = update.callback_query;
      const from = cq.message && cq.message.chat && cq.message.chat.id;
      if (!isAllowedChat(from, chatId)) return; // a stranger's tap buys nothing and is not answered
      const parsed = parseCallbackData(cq.data);
      if (!parsed) return;
      await answerCallback({ token, callbackId: cq.id, text: parsed.decision === 'approve' ? 'Placing…' : 'Dropped' });
      await onDecision({ ...parsed, channel: 'telegram', message: cq.message });
      return;
    }
    if (update.message && typeof update.message.text === 'string') {
      const from = update.message.chat && update.message.chat.id;
      if (!isAllowedChat(from, chatId)) return;
      const parsed = parseTextCommand(update.message.text);
      if (!parsed) { if (onText) await onText(update.message); return; }
      await onDecision({ ...parsed, channel: 'telegram-text', message: update.message });
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const res = await axios.get(`${API}/bot${token}/getUpdates`, {
          params: { offset, timeout: timeoutSec, allowed_updates: JSON.stringify(['message', 'callback_query']) },
          timeout: (timeoutSec + 10) * 1000,
        });
        const updates = (res.data && res.data.ok && Array.isArray(res.data.result)) ? res.data.result : [];
        for (const u of updates) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          try { await handle(u); } catch (e) { log('[telegramApprovals] update failed: ' + ((e && e.message) || e)); }
        }
      } catch (e) {
        if (stopped) break;
        // A network blip is expected on a laptop: wait, then keep listening. Silence here would
        // mean the ✅ button stops working with nothing on screen saying why.
        log('[telegramApprovals] poll error: ' + ((e && e.message) || e));
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  const done = loop();
  log('[telegramApprovals] listening for approvals in chat ' + chatId + '.');
  return { stop() { stopped = true; return done; }, running: true };
}

module.exports = {
  callbackData,
  parseCallbackData,
  parseTextCommand,
  isAllowedChat,
  proposalText,
  keyboard,
  sendProposal,
  editOutcome,
  answerCallback,
  startPolling,
};
