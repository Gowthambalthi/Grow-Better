/**
 * common/notifications/telegramService.js
 * Instant Real-Time Mobile Phone Notifications (WhatsApp & Telegram)
 * Bot: @GBTerminalAlertsBot
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createPacer } = require('./sendPacer');

const CONFIG_FILE = path.join(__dirname, '../../data/notification_settings.json');

// MESSAGES LEAVE THE PHONE ONE AT A TIME, `TELEGRAM_GAP_MS` APART.
// A scan can arm several calls in the same second; sent together they arrive as one
// unreadable burst. The gap is a SENDER property so every caller of
// sendPhoneNotification inherits it — new calls, exits and the scorecard alike — and
// it is overridable for a test or for a chat that tolerates a tighter cadence.
// 0 disables the pacing; an unparseable value falls back to 3000 rather than to 0,
// because silence from a typo is worse than a slightly slower alert.
function telegramGapMs() {
  const raw = process.env.TELEGRAM_GAP_MS;
  if (raw === undefined || raw === '') return 3000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3000;
}

let pacer = null;
function sendPacer() {
  if (!pacer) pacer = createPacer({ gapMs: telegramGapMs() });
  return pacer;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      cfg.phoneNumber = cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '';
      cfg.fullPhone = cfg.fullPhone || (cfg.phoneNumber ? `+91${cfg.phoneNumber}` : '');
      cfg.botToken = cfg.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
      // THE CHAT ID HAS THE SAME ENV FALLBACK AS THE TOKEN, and it did not: this branch returned
      // early with whatever the settings file held, so a TELEGRAM_CHAT_ID set in .env was silently
      // ignored whenever data/notification_settings.json existed — which it always does after the
      // first settings write. The visible symptom was "bot token present, chat id missing, will be
      // auto-detected once the bot is messaged", i.e. alerts that depend on a getUpdates poll
      // succeeding, on a phone that may never have messaged the bot. Now the env value is read here
      // exactly as the token is, and the auto-detect remains the last resort rather than the only one.
      cfg.chatId = cfg.chatId || process.env.TELEGRAM_CHAT_ID || '';
      return cfg;
    }
  } catch (e) {
    console.error('[notificationService] Error reading notification_settings.json:', e.message);
  }
  return {
    phoneNumber: process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '',
    fullPhone: (process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE) ? `+91${process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE}` : '',
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
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

// ---------------------------------------------------------------------------
// ONE EVENT, ONE MESSAGE — ACROSS PROCESSES AND RESTARTS
// ---------------------------------------------------------------------------
//
// The channel flooded on 2026-10-19: the daily scorecard arrived a dozen times between
// 12:11 and 13:07, the morning's exits were re-announced in bursts at 12:56, 13:02, 13:06,
// 13:08 and 13:11, and the whole OF_MOMENTUM book of the session came back at 13:19-13:24
// with exit times from 09:30-11:38. Every one of those messages was CORRECT in content —
// the duplicates were the defect.
//
// Two processes can send it twice (two `node Server.js` instances; on Windows a second
// `listen(4000)` succeeds, which is why Server.js grew its own /health pidfile lock), and
// ONE process can send it twice across a restart, because every engine keeps its "already
// announced" state in memory and rebuilds the day's book from disk on start. The scorecard
// had a marker file for exactly this reason, and it was written AFTER the send: refuse -
// check - send - mark leaves the whole send window open, and a crash inside it repeats the
// card forever.
//
// So the invariant lives HERE, at the transport, where every sender in every process goes
// through it: a caller that names its event (`dedupeKey`) gets AT MOST one delivery per
// key. Write-then-send with a lease, so the trade is explicit:
//   * a key settled `sent` is suppressed forever (pruned after 3 days);
//   * a key claimed `sending` is suppressed inside the lease window, which is what closes
//     the simultaneous-two-processes window;
//   * a claim OLDER than the lease is taken over rather than trusted, because a send that
//     never came back must not make the alert unrecoverable — an alert that is lost is a
//     worse failure than one that is repeated, and this is the only state that can lose it.
const DEDUPE_LEASE_MS = 60 * 1000;
const DEDUPE_KEEP_DAYS = 3;

// THE PATH IS RESOLVED PER CALL, NOT AT REQUIRE TIME, and it is overridable — because a test that
// exercises a real dispatcher writes a REAL key: `scorecard:<today>` left behind by a test run
// would silently suppress that session's actual scorecard, and the only symptom would be a missing
// card. GB_TELEGRAM_LEDGER is the sandbox hook (the same idea as GB_ORDERFLOW_DIR for the call
// book); unset in production, it is the path beside the journal.
function dedupeLedgerFile() {
  return process.env.GB_TELEGRAM_LEDGER || path.join(__dirname, '../../data/telegram_sent_ledger.json');
}

function readLedger() {
  try {
    const file = dedupeLedgerFile();
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) { return {}; }
}

function writeLedger(ledger) {
  try {
    const cutoff = Date.now() - DEDUPE_KEEP_DAYS * 24 * 3600 * 1000;
    const kept = {};
    for (const [k, v] of Object.entries(ledger)) {
      const at = Date.parse((v && v.at) || '');
      if (isFinite(at) && at >= cutoff) kept[k] = v;
    }
    const file = dedupeLedgerFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(kept, null, 2), 'utf8');
  } catch (e) {
    // A ledger we cannot write must never stop a real alert from going out.
    console.warn('[notificationService] dedupe ledger write failed:', e.message);
  }
}

/** `sent` | `inflight` | `clear` — what this key's own record says right now. */
function dedupeState(key, now = Date.now()) {
  const rec = readLedger()[key];
  if (!rec) return 'clear';
  if (rec.state === 'sent') return 'sent';
  const at = Date.parse(rec.at || '');
  if (!isFinite(at)) return 'clear';
  return (now - at) < DEDUPE_LEASE_MS ? 'inflight' : 'clear';
}

function claimKey(key, now = Date.now()) {
  const ledger = readLedger();
  ledger[key] = { state: 'sending', at: new Date(now).toISOString() };
  writeLedger(ledger);
}

function settleKey(key, ok) {
  const ledger = readLedger();
  if (ok) ledger[key] = { state: 'sent', at: new Date().toISOString() };
  else delete ledger[key];        // a failed send must stay retryable
  writeLedger(ledger);
}

/**
 * The actual send. `sendPhoneNotification` wraps this in the pacer below; the split
 * keeps the transport readable and lets a diagnostic call bypass pacing if it ever
 * needs to (nothing does today).
 *
 * `options.dedupeKey` is OPT-IN: a caller that does not name its event behaves exactly
 * as before, so no existing sender changes by accident.
 */
async function sendPhoneNotificationNow(message, options = {}) {
  // A TEST PROCESS MUST NOT BE ABLE TO POST TO THE OWNER'S PHONE.
  //
  // This is not hypothetical and it is not only about the ledger: test/depthOrientation.test.js
  // sandboxes its FILES (`GB_ORDERFLOW_DIR`) but never stubbed the sender, so every run of the
  // suite drove the engine to the session close and dispatched a REAL scorecard through the live
  // bot — 40+ runs across one day is a dozen messages on the channel with nothing to explain them.
  // Found by the ledger it wrote (`scorecard:<date>`, state `sent`): the guard below is the fix,
  // and it sits at the boundary rather than in each test, because the next test file someone adds
  // will not know it needed one. Same reasoning as the sweep engine's `refuseRehearsalWrite`.
  if ((process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') &&
      process.env.GB_TELEGRAM_ALLOW_FROM_TESTS !== '1') {
    return {
      success: false, refusedInTest: true,
      reason: 'refused: this is a test process and the Telegram channel is live. Stub the sender, ' +
        'or set GB_TELEGRAM_ALLOW_FROM_TESTS=1 with a stubbed transport (axios) to exercise the sender itself.',
    };
  }

  const dedupeKey = options.dedupeKey ? String(options.dedupeKey) : null;
  if (dedupeKey) {
    const state = dedupeState(dedupeKey);
    if (state !== 'clear') {
      return {
        success: false, deduped: true, dedupeKey,
        reason: state === 'sent'
          ? `already sent (${dedupeKey}) — a second copy would be the same event twice`
          : `a send for ${dedupeKey} is already in flight`,
      };
    }
    claimKey(dedupeKey);
  }
  const cfg = loadConfig();
  const token = options.botToken || cfg.botToken;
  let chatId = options.chatId || cfg.chatId;
  const phone = options.phoneNumber || cfg.phoneNumber || process.env.USER_PHONE_NUMBER || process.env.PRIMARY_PHONE || '';
  const whatsappKey = options.whatsappApiKey || cfg.whatsappApiKey;

  // Auto-detect Telegram Chat ID if user started the bot but chatId is missing
  if (token && !chatId) {
    const autoId = await autoDetectChatId(token);
    if (autoId) chatId = autoId;
  }

  let sentStatus = [];

  // 1. WhatsApp Instant Alert Gateway
  if (whatsappKey && phone) {
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

  if (dedupeKey) settleKey(dedupeKey, sentStatus.length > 0);

  if (sentStatus.length > 0) {
    return { success: true, sentTo: sentStatus, phoneNumber: phone };
  }

  // THE REASON NAMES THE PIECE THAT IS ACTUALLY MISSING. It used to read "Bot token is linked!"
  // whenever a token existed — printed straight after "ALERTS ARE NOT BEING SENT:", so a config
  // with a token and an unlinked chat told the operator to add a token they already had, and one
  // with no token at all printed the same cheerful sentence. Callers log `reason` verbatim, so the
  // text has to be a diagnosis, not an instruction pair for both cases.
  return {
    success: false,
    phoneNumber: phone,
    botUsername: 'GBTerminalAlertsBot',
    reason: token
      ? 'Bot token is set but no Telegram chat is linked — open @GBTerminalAlertsBot and tap START, or set TELEGRAM_CHAT_ID.'
      : 'Bot token is missing — set TELEGRAM_BOT_TOKEN in .env.'
  };
}

/**
 * Queue a message behind every earlier one, at least `TELEGRAM_GAP_MS` after it.
 * Resolves with the transport result, exactly as before — a caller that awaits this
 * still learns whether the message went out; it just may wait for the queue first.
 */
function sendPhoneNotification(message, options = {}) {
  // THE INNER SENDER IS REACHED THROUGH THE EXPORT, NOT THE CLOSURE. Assigning
  // `require('…/telegramService').sendPhoneNotificationNow = stub` is how this tree already
  // swaps the transport (scratch/measure_struct_stop.js does exactly that, before requiring the
  // engine, so the engine's captured reference is the stub). Closing over the local name made
  // that assignment a no-op for THIS entry point, which in a test means the message leaves for
  // the real channel instead of the stub — the one way a "unit" test can post to the owner's
  // phone. Routing through the export keeps production identical and makes the seam real.
  return sendPacer().run(() => module.exports.sendPhoneNotificationNow(message, options));
}

module.exports = {
  loadConfig,
  saveConfig,
  sendPhoneNotification,
  sendPhoneNotificationNow,
  telegramGapMs,
  autoDetectChatId,
  // The one-event-one-message ledger, exposed so a test can pin its contract.
  dedupeState,
  dedupeLedgerFile,
  DEDUPE_LEASE_MS,
};
