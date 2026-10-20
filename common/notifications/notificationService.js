/**
 * common/notifications/notificationService.js
 * Unified Multi-Channel Notification Engine & Interactive Telegram Assistant
 * Features:
 *  1. Interactive Bot Assistant (Replies to "live", "holdings", "today gain", "pnl", "status", "signals")
 *  2. Stock-by-stock Holdings Breakdown & Live Signal Switch Status
 *  3. Automated 03:30 PM Market Closing P&L Summary Push Alert
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/notification_settings.json');
let portfolioService = null;
let lastUpdateId = 0;
let isMarketCloseSentToday = false;

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        phoneNumber: cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '',
        fullPhone: cfg.fullPhone || ((cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE) ? '+91' + (cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE) : ''),
        botToken: cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: cfg.chatId || process.env.TELEGRAM_CHAT_ID || '',
        whatsappPhoneId: cfg.whatsappPhoneId || process.env.WHATSAPP_PHONE_ID || '',
        whatsappAccessToken: cfg.whatsappAccessToken || process.env.WHATSAPP_ACCESS_TOKEN || '',
        whatsappApiKey: cfg.whatsappApiKey || process.env.WHATSAPP_API_KEY || '',
        enabled: cfg.enabled !== false
      };
    }
  } catch (e) {
    console.error('[notificationService] Error loading config:', e.message);
  }

  return {
    phoneNumber: process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '',
    fullPhone: (process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE) ? '+91' + (process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE) : '',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappApiKey: process.env.WHATSAPP_API_KEY || '',
    enabled: true
  };
}

function saveConfig(cfg) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const existing = loadConfig();
    const updated = { ...existing, ...cfg };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (e) {
    console.error('[notificationService] Error saving config:', e.message);
  }
}

async function autoDetectTelegramChatId(token) {
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, { timeout: 5000 });
    if (res.data && res.data.ok && Array.isArray(res.data.result) && res.data.result.length > 0) {
      for (let i = res.data.result.length - 1; i >= 0; i--) {
        const item = res.data.result[i];
        const detectedId = item.message?.chat?.id || item.my_chat_member?.chat?.id;
        if (detectedId) {
          saveConfig({ chatId: String(detectedId) });
          return String(detectedId);
        }
      }
    }
  } catch (e) {
    console.error('[notificationService] Error auto-detecting Telegram Chat ID:', e.message);
  }
  return null;
}

async function sendTelegram(message, cfg) {
  let token = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  let chatId = cfg.chatId || process.env.TELEGRAM_CHAT_ID || '';

  if (!chatId && token) {
    chatId = await autoDetectTelegramChatId(token);
  }

  if (!token || !chatId) {
    return { channel: 'telegram', success: false, reason: 'Bot token or Chat ID missing' };
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 8000 });

    if (res.data && res.data.ok) {
      return { channel: 'telegram', success: true, messageId: res.data.result?.message_id };
    }
    return { channel: 'telegram', success: false, reason: res.data?.description || 'Telegram returned not OK' };
  } catch (err) {
    return { channel: 'telegram', success: false, reason: err.message };
  }
}

async function sendWhatsApp(message, cfg) {
  const phone = cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '';

  if (cfg.whatsappApiKey) {
    try {
      const cleanMsg = message.replace(/<[^>]*>/g, '');
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=91${phone}&text=${encodeURIComponent(cleanMsg)}&apikey=${cfg.whatsappApiKey}`;
      const res = await axios.get(waUrl, { timeout: 8000 });
      return { channel: 'whatsapp', success: true, response: res.data };
    } catch (err) {
      return { channel: 'whatsapp', success: false, reason: err.message };
    }
  }
  return { channel: 'whatsapp', success: false, reason: 'WhatsApp API Key not configured' };
}

async function sendAlert(alert) {
  const cfg = loadConfig();
  if (!cfg.enabled) {
    return { success: false, reason: 'Notifications disabled in settings' };
  }

  const isScalping = (alert.tradeType === 'SCALPING') ||
                     (alert.strategy && String(alert.strategy).toLowerCase().includes('scalp')) ||
                     (alert.title && String(alert.title).toLowerCase().includes('scalp')) ||
                     (alert.message && String(alert.message).toLowerCase().includes('scalp')) ||
                     (alert.kind === 'SIGNAL' && alert.reason && String(alert.reason).toLowerCase().includes('scalp'));
  const typeBadge = isScalping
    ? '⚡ <b>[SCALPING TRADE]</b> (0.55% Target | 5-6 Min Hold)'
    : '📈 <b>[INTRADAY TRADE]</b> (Target +1.5% to +3% | Auto Exit 3:15 PM)';

  const symbol = alert.symbol || '';
  const title = alert.title || '';
  const bodyMsg = alert.message || '';
  const priceStr = alert.price ? `💵 Price: ₹${alert.price}` : '';
  const reasonStr = alert.reason ? `📋 Reason: ${alert.reason}` : '';
  const stratStr = alert.strategy ? `⚙️ <b>Strategy</b>: ${alert.strategy}\n` : '';

  const formattedMsg =
    `${typeBadge}\n\n` +
    (symbol ? `🎯 <b>SYMBOL: #${symbol}</b>\n\n` : '') +
    stratStr +
    `🔔 <b>${title}</b>\n\n` +
    (bodyMsg ? `${bodyMsg}\n` : '') +
    (priceStr ? `${priceStr}\n` : '') +
    (reasonStr ? `${reasonStr}\n` : '');

  const channels = alert.channels || ['telegram'];
  const results = [];

  if (channels.includes('telegram')) {
    const tgRes = await sendTelegram(formattedMsg, cfg);
    results.push(tgRes);
  }

  if (channels.includes('whatsapp')) {
    const waRes = await sendWhatsApp(formattedMsg, cfg);
    results.push(waRes);
  }

  const successCount = results.filter(r => r.success).length;
  return {
    success: successCount > 0,
    deliveredCount: successCount,
    channels: results,
    phoneNumber: cfg.phoneNumber
  };
}

/**
 * Builds real-time P&L summary string + Live Status + Full Holdings List for Telegram Bot replies
 */
async function generatePnlSummaryText(headerTitle = '📊 GROWBETTER ALGO LIVE P&L SUMMARY') {
  if (!portfolioService) {
    portfolioService = require('../portfolio/portfolioService');
  }

  const cfg = loadConfig();
  const isSignalsOn = cfg.enabled !== false;
  const signalStatusLine = isSignalsOn ? `🟢 <b>LIVE ALGO SIGNALS: ACTIVE &amp; ONLINE</b>` : `🔴 <b>LIVE ALGO SIGNALS: INACTIVE / OFF</b>`;

  try {
    const angelRows = await portfolioService.getAngelPortfolio(null);
    const growwRows = await portfolioService.getGrowwPortfolio(null, null);

    const angelSum = portfolioService.summarize(angelRows, 'angelone', 788.69);
    const growwSum = portfolioService.summarize(growwRows, 'groww', 134.21);

    const allRows = [...angelRows.filter(r => !r.error), ...growwRows.filter(r => !r.error)];
    const combSum = portfolioService.summarize(allRows, 'combined', 788.69 + 134.21);

    const angelHoldings = angelRows.filter(h => h.quantity > 0);
    const growwHoldings = growwRows.filter(h => h.quantity > 0);

    const todayPl = combSum.todayPL || 0;
    const todayPct = combSum.investedAmount ? (todayPl / combSum.investedAmount) * 100 : 0;
    const overallPl = combSum.overallPL || 0;
    const overallPct = combSum.investedAmount ? (overallPl / combSum.investedAmount) * 100 : 0;
    const accountPl = combSum.accountPL || overallPl;
    const cash = combSum.cashBalance || 922.90;

    const todaySign = todayPl >= 0 ? '+' : '';
    const overallSign = overallPl >= 0 ? '+' : '';
    const accountSign = accountPl >= 0 ? '+' : '';

    let holdingsText = '';
    const totalCount = angelHoldings.length + growwHoldings.length;

    if (totalCount > 0) {
      holdingsText += `\n📦 <b>ACTIVE HOLDINGS (${totalCount} STOCKS):</b>\n`;
      if (angelHoldings.length > 0) {
        holdingsText += `\n🔹 <b>ANGEL ONE HOLDINGS:</b>\n`;
        for (const h of angelHoldings) {
          const pl = h.overallPL || 0;
          const plPct = h.overallPLPercent || 0;
          const s = pl >= 0 ? '+' : '';
          const mtf = h.isMtf ? ' (MTF)' : '';
          holdingsText += `• <b>${h.tradingsymbol}</b>${mtf} — Qty: ${h.quantity} | LTP: ₹${h.ltp} | P&L: ${s}₹${pl.toFixed(2)} (${s}${plPct.toFixed(2)}%)\n`;
        }
      }
      if (growwHoldings.length > 0) {
        holdingsText += `\n🔸 <b>GROWW HOLDINGS:</b>\n`;
        for (const h of growwHoldings) {
          const pl = h.overallPL || 0;
          const plPct = h.overallPLPercent || 0;
          const s = pl >= 0 ? '+' : '';
          const mtf = h.isMtf ? ' (MTF)' : '';
          holdingsText += `• <b>${h.tradingsymbol}</b>${mtf} — Qty: ${h.quantity} | LTP: ₹${h.ltp} | P&L: ${s}₹${pl.toFixed(2)} (${s}${plPct.toFixed(2)}%)\n`;
        }
      }
    } else {
      holdingsText += `\n📦 <b>ACTIVE HOLDINGS:</b> No open holdings`;
    }

    return `<b>${headerTitle}</b>\n\n` +
      `${signalStatusLine}\n\n` +
      `💰 <b>Today's P&L:</b> ${todaySign}₹${todayPl.toFixed(2)} (${todaySign}${todayPct.toFixed(2)}%)\n` +
      `📈 <b>Overall Gain:</b> ${overallSign}₹${overallPl.toFixed(2)} (${overallSign}${overallPct.toFixed(2)}%)\n` +
      `🏦 <b>Account P&L:</b> ${accountSign}₹${accountPl.toFixed(2)}\n` +
      `💵 <b>Cash Balance:</b> ₹${cash.toFixed(2)}\n` +
      `${holdingsText}`;
  } catch (e) {
    console.error('[notificationService] Error generating PnL summary text:', e.message);
    return `<b>${headerTitle}</b>\n\n${signalStatusLine}\n\n⚠️ Unable to load live portfolio snapshot: ${e.message}`;
  }
}

/**
 * Listens for incoming Telegram messages from user and replies instantly!
 */
function initTelegramBotListener() {
  const cfg = loadConfig();
  const token = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
  if (!token) return;

  setInterval(async () => {
    try {
      const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}`;
      const res = await axios.get(url, { timeout: 4000 });
      if (res.data && res.data.ok && Array.isArray(res.data.result)) {
        for (const item of res.data.result) {
          lastUpdateId = Math.max(lastUpdateId, item.update_id);
          const msg = item.message;
          if (msg && msg.text && msg.chat?.id) {
            const userText = msg.text.toLowerCase().trim();
            console.log(`[telegramBot] Received message from user ${msg.from?.first_name}: "${msg.text}"`);

            // If user asks for live, holdings, today gain, overall gain, status, signals, or /start
            if (
              userText.includes('live') ||
              userText.includes('holding') ||
              userText.includes('holdings') ||
              userText.includes('today') ||
              userText.includes('gain') ||
              userText.includes('pnl') ||
              userText.includes('overall') ||
              userText.includes('status') ||
              userText.includes('signal') ||
              userText.includes('signals') ||
              userText.includes('/start')
            ) {
              const replyText = await generatePnlSummaryText('📊 GROWBETTER ALGO LIVE RESPONSE');
              await sendTelegram(replyText, cfg);
            }
          }
        }
      }
    } catch (e) {
      // Non-blocking background listener
    }
  }, 3000);

  // 03:30 PM Market Closing Summary Scheduler
  setInterval(async () => {
    const now = new Date();
    const day = now.getDay();
    const hours = now.getHours();
    const minutes = now.getMinutes();

    // Monday (1) to Friday (5) at 15:30 (03:30 PM IST)
    if (day >= 1 && day <= 5 && hours === 15 && minutes === 30) {
      if (!isMarketCloseSentToday) {
        isMarketCloseSentToday = true;
        const closeMsg = await generatePnlSummaryText('🔔 03:30 PM MARKET CLOSING P&L SUMMARY');
        await sendTelegram(closeMsg, cfg);
        console.log('[notificationService] Automated 03:30 PM Market Closing P&L Summary dispatched to Telegram!');
      }
    } else {
      if (hours !== 15 || minutes !== 30) {
        isMarketCloseSentToday = false;
      }
    }
  }, 30000);
}

/**
 * THE TEXT HALF OF THE LISTENER, callable by whichever poller owns the update stream.
 *
 * WHY THIS WAS EXTRACTED (2026-10-19). Two pollers ran against one bot: this interval and the
 * order-approval long poll. Telegram serves getUpdates to ONE consumer at a time, so each would
 * kick the other off with a 409 — which, for the approval path, means a tapped ✅ could simply
 * never arrive. There can only be one owner of the stream, so the owner asks this function about
 * plain text and the old interval is no longer started by default.
 *
 * Returns true when it answered, false when the text was not a command it knows.
 */
async function handleTelegramText(text, cfg) {
  if (!text || !cfg) return false;
  const userText = String(text).toLowerCase().trim();
  const wants = ['live', 'holding', 'holdings', 'today', 'gain', 'pnl', 'overall', 'status', 'signal', 'signals', '/start'];
  if (!wants.some((w) => userText.includes(w))) return false;
  const replyText = await generatePnlSummaryText('📊 GROWBETTER ALGO LIVE RESPONSE');
  await sendTelegram(replyText, cfg);
  return true;
}

// Boot Telegram bot listener immediately — EXCEPT INSIDE A TEST PROCESS, AND EXCEPT WHEN TOLD NOT TO.
// The listener polls Telegram every 3 seconds and holds the event loop open, so requiring this module from
// a unit test both hit the network and hung the run on exit (found 2026-10-01 when the signal-source
// policy test timed out). node:test sets NODE_TEST_CONTEXT in its child processes; GB_TELEGRAM_LISTENER=0
// is the manual off switch. Production is unchanged: neither is set there.
//
// THE APPROVAL POLLER OWNS getUpdates NOW. Starting both meant neither reliably received anything
// (409 Conflict, observed 2026-10-19), so the legacy interval is opt-in: TELEGRAM_LEGACY_POLLER=1.
if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test' && process.env.GB_TELEGRAM_LISTENER !== '0') {
  if (process.env.TELEGRAM_LEGACY_POLLER === '1') {
    initTelegramBotListener();
  } else {
    console.log('[notificationService] text poller NOT started — the approval listener owns getUpdates (set TELEGRAM_LEGACY_POLLER=1 for the old one).');
  }
} else {
  console.log('[notificationService] bot listener NOT started (test process or GB_TELEGRAM_LISTENER=0)');
}

module.exports = {
  loadConfig,
  saveConfig,
  sendAlert,
  sendTelegram,
  sendWhatsApp,
  autoDetectTelegramChatId,
  generatePnlSummaryText,
  initTelegramBotListener,
  handleTelegramText
};
