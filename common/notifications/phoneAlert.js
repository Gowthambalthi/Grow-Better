/**
 * common/notifications/phoneAlert.js — the single gate for anything that should
 * reach the user's phone.
 *
 * The engine used to write alerts only to the in-app notification store, so a
 * BUY call or a stop-hit exit never left the server. Everything phone-bound now
 * goes through here, which gives one place to answer: what was sent, when, to
 * which channel, and what was deliberately held back.
 *
 * Two guarantees the alerting must keep:
 *   1. Entries are rate-limited — one alert per symbol per ENTRY_COOLDOWN, so a
 *      name that keeps flipping between BUY and SHORT cannot buzz the phone all
 *      session. A stop-hit exit is never suppressed, because suppression there
 *      is the one failure that costs money — but each exit is sent ONCE, keyed
 *      to the call, so two overlapping tracking passes cannot double-alert the
 *      same close.
 *   2. A broken channel is visible, not silent. Every attempt is logged with the
 *      transport's own reason, and GET /api/gb/phone-alerts reports the last
 *      error — otherwise "I got no alert" is indistinguishable from "nothing
 *      happened".
 *
 * Transport is notificationService (Telegram today; WhatsApp when its keys are
 * set). It is required lazily so this module can be loaded from anywhere,
 * including the market engine, without any load-order coupling.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA, 'phone_alerts_state.json');
const LOG_FILE = path.join(DATA, 'phone_alerts_log.json');

// Same symbol + same kind will not alert again inside this window.
const ENTRY_COOLDOWN_MS = 20 * 60 * 1000;
const SOFT_CAP_PER_DAY = 60;      // ceiling on entry-style alerts per day (was 200 — over-alerting).
                                  // ~35 engine calls + strong-bursts + surges fits well inside 60;
                                  // anything beyond that is noise the user has asked to stop.
// 80 was exhausted by ~09:50 on 23-Sep (STRONG_BUY bursts + signals), silently
// suppressing every BUY for the rest of the session — a cap meant to stop a
// flood became a blackout. 200 still bounds the flood; the per-symbol 20-min
// cooldown does most of the work anyway.

// Alerts only make sense on market days, and the 15:15 day report must still go.
const WINDOW_FROM = 9 * 60;       // 09:00 IST
const WINDOW_TO = 15 * 60 + 40;   // 15:40 IST

/**
 * WHAT MAY REACH THE PHONE. The rule is now explicit: the phone carries CALLS —
 * engine entries (kind CALL) and the ROC fast-move read (kind SIGNAL) — plus the
 * exits and the end-of-day report. Everything else is dashboard-only.
 *
 * STRONG_BUY is why this list exists. On 24-Sep the surge detector and the
 * volume-revival scanner pushed 58 "STRONG BUY" messages, spent the 60/day cap
 * before 10:20 IST, and every real BUY call behind them was then suppressed as
 * "daily cap reached (60)": 58 alerts on the phone, zero calls. A surge is a
 * stock worth LOOKING at, not a trade with an entry and a stop — and an alert
 * the user cannot act on is noise that hides the alerts they can. It still
 * appears on the dashboard (pushNotif), it just does not buzz.
 */
const DASHBOARD_ONLY_KINDS = ['STRONG_BUY'];

function istParts(d = new Date()) {
  const ist = new Date(d.getTime() + (5.5 * 60 + d.getTimezoneOffset()) * 60000);
  return { day: ist.getDay(), mins: ist.getHours() * 60 + ist.getMinutes(), date: ist.toISOString().slice(0, 10) };
}

function inWindow() {
  const { day, mins } = istParts();
  return day >= 1 && day <= 5 && mins >= WINDOW_FROM && mins <= WINDOW_TO;
}

// EVENING DIGEST. Stop-hit and booked-profit alerts were buzzing the phone all
// session — an exit is a RESULT, not something to act on in seconds, so it does
// not need instant delivery. Kinds listed here are collected in a queue file
// during the session and delivered in ONE summary at 15:45 IST.
// STOP-HITS GO OUT IMMEDIATELY. 'EXIT' was in this list, so every SELL was queued
// for 15:45 instead of sent — MEASURED on 2026-09-28: EXIT held 30, EXITPLAN held
// 101, CALL sent 23, transport errors 0. The user's report was exactly right: "I
// don't get notifications for telegram to sell or buy" — the sells were never
// attempted, by design, and the cap/cooldown logic was never even reached for them.
// An exit is the one alert whose whole value is the seconds it saves, so it is now
// sent in the moment and de-duplicated once per call by gate().
// An EXITPLAN (a stop/target the user has to act on) still does not buzz the phone
// every minute — but it is now de-duplicated by key inside digestAdd, so a plan that
// re-fires every scan becomes ONE entry in the evening summary, not 101.
const DIGEST_KINDS = ['EXITPLAN'];
// RELOCATABLE, so a test can exercise the de-duplication against a temp file without
// overwriting the digest the live session is about to send (same GB_* env-override
// pattern as the funnel's GB_FUNNEL_OUT). Unset, the path is unchanged.
const DIGEST_FILE = process.env.GB_PHONE_DIGEST
  ? path.resolve(process.env.GB_PHONE_DIGEST)
  : path.join(DATA, 'phone_digest.json');
const DIGEST_AT_MIN = 15 * 60 + 45;   // 15:45 IST
// Same key, same evening entry: a plan re-queued within this window REPLACES its own
// entry (the newest state of the plan is the one worth reading) instead of appending
// another copy. Measured on 2026-09-28: one HEROMOTORS short plan queued 101 times in
// the hour before 11:00, which is how a digest becomes unreadable.
const DIGEST_KEY_COOLDOWN_MS = 30 * 60 * 1000;

function digestQueue() {
  try { const q = JSON.parse(fs.readFileSync(DIGEST_FILE, 'utf8')); if (Array.isArray(q.items)) return q; } catch (_) {}
  return { date: null, items: [] };
}

function digestAdd(opts) {
  const { date } = istParts();
  const q = digestQueue();
  if (q.date !== date) { q.date = date; q.items = []; }
  // ONE ENTRY PER KEY PER COOLDOWN — see DIGEST_KEY_COOLDOWN_MS.
  const key = opts.key || (String(opts.symbol || '') + ':' + (opts.kind || 'SIGNAL'));
  const at = Date.now();
  const i = q.items.findIndex(it => it.key === key);
  if (i >= 0) {
    const prev = q.items[i];
    if (prev.atMs && at - prev.atMs < DIGEST_KEY_COOLDOWN_MS) {
      prev.repeat = (prev.repeat || 1) + 1;
      prev.at = new Date(at).toISOString();
      prev.atMs = at;
      if (opts.message) prev.message = opts.message;
      fs.writeFileSync(DIGEST_FILE, JSON.stringify(q, null, 1));
      return q.items.length;
    }
    q.items.splice(i, 1);
  }
  q.items.push({
    key, atMs: at,
    at: new Date().toISOString(),
    kind: opts.kind, symbol: opts.symbol || null,
    title: opts.title || null, message: opts.message || null,
  });
  fs.writeFileSync(DIGEST_FILE, JSON.stringify(q, null, 1));
  return q.items.length;
}

/** Fires once per day at/after 15:45 IST with everything queued that session. */
function maybeSendDigest() {
  const { day, mins, date } = istParts();
  if (day < 1 || day > 5 || mins < DIGEST_AT_MIN || mins > DIGEST_AT_MIN + 60) return false;
  const st = loadState();
  if (st.digestSentFor === date) return false;
  const q = digestQueue();
  if (q.date !== date || !q.items.length) { st.digestSentFor = date; saveState(st); return false; }
  const lines = q.items.map(it => '- [' + it.kind + '] ' + (it.title || it.symbol || '') + (it.message ? '\n  ' + it.message.replace(/\n/g, ' | ').slice(0, 160) : ''));
  const buys = q.items.filter(i => i.kind === 'CALL' || i.kind === 'SIGNAL').length;
  const body = 'Evening summary — ' + q.items.length + ' events today:\n' + lines.join('\n');
  send({
    kind: 'REPORT', key: 'digest:' + date, force: true,
    title: '📋 EVENING SUMMARY — ' + q.items.length + ' events (stops, booked profit, plans)',
    reason: 'queued during the session, delivered at close',
    message: body,
  }).catch(() => {});
  st.digestSentFor = date;
  saveState(st);
  fs.writeFileSync(DIGEST_FILE, JSON.stringify({ date: q.date, items: [] }, null, 1));
  return true;
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch (_) {}
  return { sent: {}, day: null, dayCount: 0 };
}

function saveState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (_) {}
}

function appendLog(entry) {
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (_) {}
    if (!Array.isArray(log)) log = [];
    log.unshift(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(0, 200), null, 2));
  } catch (_) {}
}

/**
 * kind: 'CALL' | 'EXIT' | 'SIGNAL' | 'POSITION' | 'REPORT' | 'EXITPLAN'
 *       ('STRONG_BUY' is accepted and deliberately dropped — see
 *        DASHBOARD_ONLY_KINDS above)
 * Exits, position advice and exit-plan changes are never rate-limited — they
 * are the ones that cost money if missed. An exit plan is the stop and targets
 * the user has to act on, so a moved stop must not be held back by an entry
 * cooldown.
 */
function gate(key, kind, now, opts = {}) {
  const st = loadState();
  const { date } = istParts(new Date(now));
  if (st.day !== date) { st.day = date; st.dayCount = 0; }
  // EXIT is not rate-limited by time — a stop hit must go out immediately — but
  // it is ONCE per key, because the same close can be seen by more than one
  // tracking pass. POSITION and REPORT are exempt from both.
  if (kind === 'EXIT') {
    if (st.sent[key]) return { ok: false, why: 'already alerted for this call' };
    return { ok: true };
  }
  const exempt = kind === 'POSITION' || kind === 'REPORT' || kind === 'EXITPLAN';
  // PUSH TIER: the 09:15-09:30 flood was the board's SIGNAL bursts — every
  // 0.15% tick move buzzing the phone 50-70 times. Under the Strong-Buy-only
  // tier, a plain SIGNAL is dashboard-only unless the caller explicitly marks
  // it strong (multiple confirming factors aligned). CALLs (engine entries with
  // stop/targets) still push — they are already the strict gate.
  if (kind === 'SIGNAL' && !opts.strong) {
    // `opts` has to be passed in, not closed over: this referenced an `opts`
    // that only existed inside send(), so every SIGNAL threw a ReferenceError
    // before the attempt was even logged. The ROC alerts the user actually
    // wants were dying there silently — no push, and no line in the log to
    // show one had been tried.
    return { ok: false, why: 'push tier: dashboard-only (not a strong signal)', dashboardOnly: true };
  }
  if (!exempt) {
    const last = st.sent[key];
    if (last && now - last < ENTRY_COOLDOWN_MS) {
      const mins = Math.ceil((ENTRY_COOLDOWN_MS - (now - last)) / 60000);
      return { ok: false, why: 'cooldown (' + mins + ' min left for ' + key + ')' };
    }
    if (st.dayCount >= SOFT_CAP_PER_DAY) {
      return { ok: false, why: 'daily cap reached (' + SOFT_CAP_PER_DAY + ')' };
    }
  }
  return { ok: true };
}

function mark(key, kind, now) {
  const st = loadState();
  const { date } = istParts(new Date(now));
  if (st.day !== date) { st.day = date; st.dayCount = 0; }
  st.sent[key] = now;
  if (kind !== 'EXIT' && kind !== 'POSITION' && kind !== 'EXITPLAN') st.dayCount = (st.dayCount || 0) + 1;
  // forget keys older than a day so the file cannot grow forever
  for (const k of Object.keys(st.sent)) {
    if (now - st.sent[k] > 24 * 3600 * 1000) delete st.sent[k];
  }
  saveState(st);
}

/**
 * Canonical symbol for anything that reaches the phone. Broker payloads carry
 * `-EQ` suffixes and mixed case; a Telegram message showing "BALUFORGE-EQ"
 * (or worse, a name the user cannot recognise) is how "wrong symbol" complaints
 * start. One cleaning function, applied at the single gate every alert passes.
 */
function cleanSymbol(s) {
  return String(s || '').trim().replace(/-EQ$/i, '').trim().toUpperCase() || null;
}

/**
 * Send one phone alert. Never throws — the caller is a market loop and must not
 * die because a messaging API hiccuped.
 * Returns { sent, skipped, reason }.
 */
async function send(opts = {}) {
  const kind = opts.kind || 'SIGNAL';
  const now = Date.now();
  opts.symbol = cleanSymbol(opts.symbol);
  const key = opts.key || (String(opts.symbol || '') + ':'
    + (kind === 'EXIT' || kind === 'POSITION' || kind === 'EXITPLAN' ? 'exit' : 'entry'));

  // Logged fields are listed explicitly: spreading the whole options object
  // would drop the alert's own `reason` text into the log, where the status
  // reader would mistake it for a transport error.
  const base = { at: new Date().toISOString(), kind, key, symbol: opts.symbol || null, title: opts.title || null };
  // Dashboard-only kinds stop here, before the push tier and the daily cap: a
  // message that never pushes must never spend the budget that calls need.
  if (DASHBOARD_ONLY_KINDS.includes(kind)) {
    appendLog(Object.assign({}, base, { sent: false, why: 'dashboard-only (not a call)' }));
    return { sent: false, skipped: true, dashboardOnly: true, reason: 'dashboard-only: surge alerts stay on the dashboard' };
  }
  if (!inWindow() && !opts.force) {
    appendLog(Object.assign({}, base, { sent: false, why: 'outside market hours' }));
    return { sent: false, skipped: true, reason: 'outside market hours' };
  }
  // DIGESTED KINDS: queue, don't send. The event is logged as 'queued' so the
  // status panel still shows it happened.
  if (DIGEST_KINDS.includes(kind)) {
    const n = digestAdd(opts);
    appendLog(Object.assign({}, base, { sent: false, why: 'queued for evening summary (' + n + ' queued)' }));
    return { sent: false, skipped: true, reason: 'queued for the 15:45 evening summary (' + n + ' queued)' };
  }
  const g = gate(key, kind, now, opts);
  if (!g.ok) {
    appendLog(Object.assign({}, base, { sent: false, why: g.why }));
    return { sent: false, skipped: true, reason: g.why };
  }

  let result = { success: false, reason: 'not attempted' };
  try {
    const notificationService = require('./notificationService');
    // Symbol first, always: the title carries context, but the NAME the user
    // scans for must be the boldest, first thing on the message — a symbol
    // buried in prose is how a message reads as being about the wrong stock.
    result = await notificationService.sendAlert({
      title: (opts.title || 'GB TERMINAL').replace(/([A-Z0-9]+)-EQ/gi, '$1'),
      symbol: opts.symbol || null,
      price: opts.price != null ? opts.price : null,
      reason: opts.reason || null,
      message: opts.message || null,
      channels: opts.channels || ['telegram'],
      // CARRIED THROUGH SO THE TRANSPORT CAN ENFORCE THE POLICY. The old engines call this with
      // kind CALL/SIGNAL and no `gated` stamp, which notificationService.mayPushSignal now refuses — only
      // the four-rule call set (which DOES stamp gated:true + its id) may push a directional signal.
      // Operational kinds (EXIT/EXITPLAN/REPORT/…) are not directional and pass either way.
      kind: kind,
      gated: opts.gated === true,
      id: opts.id || opts.strategy || null,
    });
  } catch (e) {
    result = { success: false, reason: e.message };
  }

  // Marked regardless of outcome: a channel that is down must not turn into an
  // every-tick retry storm. The failure shows up in the log and in the status.
  mark(key, kind, now);
  const ok = !!(result && result.success);
  appendLog(Object.assign({}, base, { sent: ok }, ok ? {} : { error: (result && result.reason) || 'send failed' }));
  return { sent: ok, skipped: false, reason: ok ? null : (result && result.reason), result };
}

/** Recent attempts, newest first — what actually went out. */
function recent(limit = 25) {
  try {
    const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return Array.isArray(log) ? log.slice(0, limit) : [];
  } catch (_) { return []; }
}

function status() {
  const st = loadState();
  const { date } = istParts();
  const today = recent(200).filter(x => (x.at || '').slice(0, 10) === date);
  // Suppressed (cooldown/cap) is not the same as failed — only a real transport
  // error is reported as an error, otherwise the panel cries wolf.
  const suppressed = today.filter(x => !x.sent && x.why && x.why !== 'outside market hours').length;
  return {
    inWindow: inWindow(),
    entryCooldownMin: ENTRY_COOLDOWN_MS / 60000,
    dailyCap: SOFT_CAP_PER_DAY,
    sentToday: today.filter(x => x.sent).length,
    suppressedToday: suppressed,
    failedToday: today.filter(x => x.error).length,
    lastSent: (recent(200).find(x => x.sent) || {}).at || null,
    lastError: (today.find(x => x.error) || {}).error || null,
    dayCount: st.dayCount || 0,
  };
}

// `gate` is exported for the policy test only — it is pure with respect to the
// phone (it reads and re-derives the daily count, never sends anything), so the
// rules can be exercised without buzzing a real device.
module.exports = { send, recent, status, inWindow, maybeSendDigest, cleanSymbol, gate, DIGEST_KINDS, DIGEST_AT_MIN, DASHBOARD_ONLY_KINDS, STATE_FILE, LOG_FILE, DIGEST_FILE, digestAdd };
