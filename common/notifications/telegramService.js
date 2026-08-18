/**
 * common/notifications/telegramService.js
 * Instant Real-Time Mobile Phone Notifications (WhatsApp & Telegram) for +91 9390219001
 * Bot: @GBTerminalAlertsBot
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/notification_settings.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg.phoneNumber = cfg.phoneNumber || '9390219001';
      cfg.fullPhone = cfg.fullPhone || '+919390219001';
      cfg.botToken = cfg.botToken || '8886769745:AAFE2sx7vv-peheZJBxxjlyMfG-rVv5c0nA';
      return cfg;
    }
  } catch (e) {
    console.error('[notificationService] Error reading notification_settings.json:', e.message);
  }
  return {
    phoneNumber: '9390219001',
    fullPhone: '+919390219001',
    botToken: '8886769745:AAFE2sx7vv-peheZJBxxjlyMfG-rVv5c0nA',
    chatId: '',
    whatsappApiKey: '',
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
    console.error('[notificationService] Error saving notification_settings.json:', e.message);
  }
}

async function autoDetectChatId(token) {
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, { timeout: 5000 });
    if (res.data && res.data.ok && Array.isArray(res.data.result) && res.data.result.length > 0) {
      const lastMsg = res.data.result[res.data.result.length - 1];
      const detectedId = lastMsg.message?.chat?.id || lastMsg.my_chat_member?.chat?.id;
      if (detectedId) {
        saveConfig({ chatId: String(detectedId) });
        return String(detectedId);
      }
    }
  } catch (e) {
    console.error('[notificationService] Error auto-detecting Telegram Chat ID:', e.message);
  }
  return null;
}

async function sendPhoneNotification(message, options = {}) {
  const cfg = loadConfig();
  const token = options.botToken || cfg.botToken;
  let chatId = options.chatId || cfg.chatId;
  const phone = options.phoneNumber || cfg.phoneNumber || '9390219001';
  const whatsappKey = options.whatsappApiKey || cfg.whatsappApiKey;

  // Auto-detect Telegram Chat ID if user started the bot but chatId is missing
  if (token && !chatId) {
    const autoId = await autoDetectChatId(token);
    if (autoId) chatId = autoId;
  }

  let sentStatus = [];

  // 1. WhatsApp Instant Alert Gateway
  if (whatsappKey) {
    try {
      const cleanMsg = message.replace(/<[^>]*>/g, '');
      const waUrl = `https://api.callmebot.com/whatsapp.php?phone=91${phone}&text=${encodeURIComponent(cleanMsg)}&apikey=${whatsappKey}`;
      await axios.get(waUrl, { timeout: 6000 });
      sentStatus.push('WhatsApp (+91 ' + phone + ')');
    } catch (e) {
      console.error('[notificationService] WhatsApp API error:', e.message);
    }
  }

  // 2. Telegram Bot Push Notification to @GBTerminalAlertsBot
  if (token && chatId) {
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await axios.post(url, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }, { timeout: 8000 });

      if (res.data && res.data.ok) {
        sentStatus.push('Telegram (@GBTerminalAlertsBot)');
      }
    } catch (err) {
      console.error('[notificationService] Telegram API error:', err.message);
    }
  }

  if (sentStatus.length > 0) {
    return { success: true, sentTo: sentStatus, phoneNumber: phone };
  }

  return { 
    success: false, 
    phoneNumber: phone,
    botUsername: 'GBTerminalAlertsBot',
    reason: `Bot token is linked! Open Telegram app on phone (+91 ${phone}), search for @GBTerminalAlertsBot and tap START. Notifications will deliver automatically!`
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  sendPhoneNotification,
  autoDetectChatId
};
