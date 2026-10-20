'use strict';

/**
 * THE BOT ANSWERS BACK.
 *
 * Every message this application sent until now was one-way: a call armed, an exit hit, a
 * scorecard at 15:30, and no way to ask "what is on the board right now?" without a laptop.
 * On 2026-10-19 the owner's question was exactly that — the phone showed ~50 calls and the
 * page showed none — and there was no channel in which the two could be compared.
 *
 * So the alerts bot also reads: `getUpdates` with an offset, and four commands that answer
 * from the SAME engines the page reads, not from a copy:
 *
 *   /calls   the open board — symbol, side, entry, stop, target, live P&L, which setup
 *   /book    today's whole call book — counts by outcome and the day's net
 *   /status  is the session open, is the feed attached, can an alert send at all
 *   /why     the scan funnel — why nothing armed, per gate, for the last scan
 *
 * The router is pure (`createInbox().maybeAnswer(text)` → a string or null) so it can be tested
 * without a network, a bot token or a clock. In the running server the answers ride the EXISTING
 * getUpdates owner (`telegramApprovals.startPolling` → `onText`), because Telegram serves the
 * update stream to one consumer: a second poller makes both miss messages. `startInbox()` is the
 * standalone poller for the one case where nobody else polls — a token with no linked chat.
 *
 * THREE RULES THE POLLER KEEPS:
 *   1. It never answers an old message. The first `getUpdates` call is `offset: -1`, which
 *      returns only the newest update, so starting the server does not replay the history
 *      into the chat (the 2026-10-19 flood was exactly that failure, with exits).
 *   2. It only answers the linked chat. A stranger messaging the bot gets no reply about the
 *      owner's positions — and if NO chat is linked yet, the first chat to say anything
 *      becomes the link, which is the same handshake `autoDetectChatId()` performs, done once
 *      and with the id remembered.
 *   3. A failure to answer must never kill the server. Every poll is wrapped; the loop backs
 *      off and tries again.
 */

const axios = require('axios');

/** Telegram's parse_mode is HTML here, so engine-supplied text must not become markup. */
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function inr(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '+';
  return `${sign}₹${Math.abs(n).toFixed(0)}`;
}

const HELP = [
  '🤖 <b>GB Terminal — commands</b>',
  '/calls — open calls on the board',
  '/book — today\'s whole call book and net',
  '/status — session, feed and alert state',
  '/why — why the last scan armed nothing',
  '/help — this list',
  '',
  '<i>Answers come from the running engines, not from the page.</i>',
].join('\n');

/**
 * A ROW'S OWN WORDS. `/calls` prints entry, stop and target as the call holds them; it never
 * recomputes them, because a phone that disagrees with the page is worse than no phone.
 */
function callLine(row, i) {
  const side = String(row.side || row.action || '').toUpperCase().includes('SHORT') ? 'SHORT' : 'LONG';
  const arrow = side === 'SHORT' ? '🔻' : '🔺';
  const who = row.strategyId || row.engine || 'strategy';
  const name = row.strategyName && row.strategyName !== who ? ` · ${esc(row.strategyName)}` : '';
  const live = Number.isFinite(Number(row.livePnLPct))
    ? ` · ${Number(row.livePnLPct) >= 0 ? '+' : ''}${num(row.livePnLPct)}%`
    : '';
  return [
    `${arrow} <b>${i}. ${esc(row.symbol)}</b> ${side} <i>(${esc(who)}${name})</i>`,
    `   entry ${num(row.entryPrice)} · SL ${num(row.stopLoss)} · T ${num(row.target1)}${live} · ${esc(row.status || '')}`,
  ].join('\n');
}

/**
 * Build the router. Every dependency is injected, and every read is guarded: a command that
 * cannot answer says what is missing rather than posting a stack trace to a phone.
 */
function createInbox({ engine, session, alerts, feed, now = () => Date.now() } = {}) {
  const call = (fn, fallback) => {
    try { return typeof fn === 'function' ? fn() : fallback; } catch (_) { return fallback; }
  };

  function openCalls() {
    const rows = call(() => engine.getActiveCandidates(), []) || [];
    return Array.isArray(rows) ? rows : [];
  }

  function funnel() {
    return call(() => engine.getScanFunnel && engine.getScanFunnel(), null);
  }

  function refusals(f) {
    const groups = [['long', (f && f.long) || {}], ['short', (f && f.short) || {}]];
    const out = [];
    for (const [side, g] of groups) {
      Object.entries(g)
        .filter(([k, v]) => Number(v) > 0 && k !== 'armed')
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .forEach(([k, v]) => out.push(`${side} ${k} ${v}`));
    }
    return out;
  }

  function whyLine() {
    const f = funnel();
    if (!f) return 'no scan funnel yet — the engine has not been asked for one in this process';
    if (!f.asOfIST) {
      return f.note || 'no symbol-level scan has run in this process yet (outside the session window)';
    }
    const r = refusals(f);
    return `scanned ${f.scanned} · in play ${f.inPlay} · qualified ${f.qualified}` +
      (r.length ? `\nrefused: ${esc(r.join(' · '))}` : '');
  }

  function cmdCalls() {
    const rows = openCalls();
    const f = funnel();
    const head = `📈 <b>OPEN CALLS — ${rows.length}</b>`;
    const asOf = f && f.asOfIST ? `\n<i>scan ${esc(f.asOfIST)} IST</i>` : '';
    if (!rows.length) {
      return `${head}${asOf}\n\nNothing armed on the board right now.\n<i>${esc(whyLine())}</i>`;
    }
    const shown = rows.slice(0, 12).map((r, i) => callLine(r, i + 1)).join('\n');
    const more = rows.length > 12 ? `\n…and ${rows.length - 12} more` : '';
    return `${head}${asOf}\n${shown}${more}\n\n<i>entry/SL/T are the call's own numbers; use /book and /why</i>`;
  }

  function cmdBook() {
    const d = call(() => engine.getDailyNet(), null);
    if (!d) return '🧾 <b>TODAY\'S BOOK</b>\n\nthe engine did not answer — it may not have started yet';
    return [
      `🧾 <b>TODAY'S BOOK — ${esc(d.date || '')}</b>`,
      `calls ${d.totalCalls} · open ${d.activeCalls} · closed ${d.closedCalls}`,
      `won ${d.won} · lost ${d.lost} · exited without a level ${d.otherExits}`,
      `net ${num(d.totalPoints)} pts · ${inr(d.totalNetInr)} (1 lot, after cost)`,
      `<i>${esc(d.winRateBasis || '')}</i>`,
      '',
      `<b>${esc(d.verdict || '')}</b>`,
    ].join('\n');
  }

  function cmdStatus() {
    const s = call(session, null) || {};
    const a = call(alerts, null) || {};
    const fd = call(feed, null) || {};
    const om = call(() => engine.ofMomentumLiveState && engine.ofMomentumLiveState(), null);
    const f = funnel();
    const lines = [
      '🩺 <b>STATUS</b>',
      `session <b>${esc(s.state || 'unknown')}</b>${s.signalAllowed ? ' · signals open' : ' · signals closed'}`,
      `feed ${fd.connected ? 'connected' : 'NOT connected'}${fd.lastTickAt ? ` · last tick ${esc(fd.lastTickAt)}` : ''}`,
      `scan ${f && f.asOfIST ? `last at ${esc(f.asOfIST)} IST` : 'none in this process'}`,
      `alerts ${a.configured ? 'configured' : 'NOT configured — nothing can be sent'}` +
        (a.reason ? `\n<i>${esc(a.reason)}</i>` : ''),
      `OF_MOMENTUM ${om && om.armed
        ? `armed · ${om.maxSlots}/6 slots · ${om.maxPerSession}/session`
        : 'off (verified setups only: GB01, GB03a)'}`,
    ];
    if (s.note) lines.push(`<i>${esc(s.note)}</i>`);
    return lines.join('\n');
  }

  function cmdWhy() {
    const f = funnel();
    if (!f) return '❓ <b>WHY</b>\n\nno scan funnel yet — the engine has not been asked for one';
    const lines = [
      '❓ <b>WHY — last scan</b>',
      f.asOfIST ? `as of ${esc(f.asOfIST)} IST` : 'no symbol-level scan has run yet',
      whyLine(),
    ];
    if (f.gb03) {
      lines.push(`GB03a: evaluated ${f.gb03.evaluated != null ? f.gb03.evaluated : '—'}` +
        ` · emitted ${f.gb03.emitted != null ? f.gb03.emitted : '—'}` +
        ` · refused ${f.gb03.refusedPlanner != null ? f.gb03.refusedPlanner : '—'}`);
    }
    if (f.ofMomentum) {
      lines.push(`OF_MOMENTUM: ${f.ofMomentum.armed
        ? `armed · today ${f.ofMomentum.today}/${f.ofMomentum.maxPerSession} · open ${f.ofMomentum.open}/${f.ofMomentum.maxSlots}` +
          (f.ofMomentum.droppedBySessionCap ? ` · ${f.ofMomentum.droppedBySessionCap} refused by the cap` : '')
        : 'off'}`);
    }
    if (f.slotsAvailable != null) lines.push(`open board slots ${f.slotsAvailable}/6`);
    return lines.join('\n');
  }

  const ROUTES = {
    '/calls': cmdCalls,
    '/book': cmdBook,
    '/status': cmdStatus,
    '/why': cmdWhy,
    '/help': () => HELP,
    '/start': () => HELP,
  };

  /**
   * `text` → the reply. Unknown text gets the command list rather than silence: a user who
   * types "calls" without the slash is asking the same question, and a bot that ignores it
   * looks broken.
   */
  function handle(text) {
    const raw = String(text || '').trim();
    // `/calls@GBTerminalAlertsBot` is what a group chat sends; the bot name is not part of
    // the command. The leading slash is optional for the same reason.
    const head = raw.split(/\s+/)[0].replace(/^\/+/, '').split('@')[0].toLowerCase();
    const fn = ROUTES['/' + head];
    if (!raw) return HELP;
    try {
      return fn ? fn() : HELP;
    } catch (e) {
      return `⚠️ that command failed: ${esc((e && e.message) || e)}\n<i>the server is still running; try /status</i>`;
    }
  }

  /**
   * `text` → the reply, or NULL when the text is not one of ours.
   *
   * THIS IS THE SEAM THE PROCESS USES. `telegramApprovals` owns getUpdates (Telegram serves the
   * stream to ONE consumer, and a second poller makes both miss messages — 409 Conflict, seen on
   * 2026-10-19), so the inbox does not poll at all when that listener is running: it offers this
   * function to its `onText` hook and stays quiet for anything it does not recognise, which is
   * what keeps "holdings" and "pnl" working through the older handler.
   */
  function maybeAnswer(text) {
    const raw = String(text || '').trim();
    const head = raw.split(/\s+/)[0].replace(/^\/+/, '').split('@')[0].toLowerCase();
    if (!ROUTES['/' + head]) return null;
    try {
      return ROUTES['/' + head]();
    } catch (e) {
      return `⚠️ that command failed: ${esc((e && e.message) || e)}`;
    }
  }

  return { handle, maybeAnswer, commands: Object.keys(ROUTES), now };
}

/**
 * The poller. `transport` is injected so a test can drive it without Telegram:
 *   { getUpdates(offset) → Promise<{updates, nextOffset}>, sendMessage(chatId, text) → Promise }
 */
function startInbox({ token, chatId, inbox, transport, pollMs = 1500, retryMs = 5000, logger = console } = {}) {
  if (!token) {
    logger.warn('[telegram-inbox] no bot token — the bot will not answer commands');
    return null;
  }
  if (process.env.GB_TELEGRAM_INBOX === '0') {
    logger.log('[telegram-inbox] disabled by GB_TELEGRAM_INBOX=0');
    return null;
  }
  const http = transport || {
    async getUpdates(offset, timeoutSec) {
      const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates`, {
        params: offset == null ? { offset: -1, limit: 1 } : { offset, timeout: timeoutSec || 20 },
        timeout: ((timeoutSec || 20) + 10) * 1000,
      });
      const updates = (res.data && Array.isArray(res.data.result)) ? res.data.result : [];
      const lastId = updates.reduce((m, u) => Math.max(m, Number(u.update_id) || 0), 0);
      return { updates, nextOffset: lastId ? lastId + 1 : (offset || 0) };
    },
    async sendMessage(id, text) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: id,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }, { timeout: 8000 });
    },
  };

  // The linked chat, adopted on first contact when the config has none. Held in memory for the
  // life of the process, and written back so the next boot starts already linked.
  let linked = chatId ? String(chatId) : null;
  let offset = null;          // null → ask for ONLY the newest update, to find where the chat's history ends
  let stopped = false;

  // A MESSAGE OLDER THAN THIS IS HISTORY, NOT A QUESTION. On the first probe the offset is
  // unknown, so the newest update may be the owner's message from this morning — answering it
  // would re-print the day, which is the 2026-10-19 flood in one chat. A fresh message (the one
  // that just arrived) IS answered, so first contact and the first command are one event.
  const FRESH_MS = 2 * 60 * 1000;
  const fresh = (msg) => {
    const d = Number(msg && msg.date);
    if (!Number.isFinite(d)) return false;            // no clock: treat as history, stay quiet
    const age = Date.now() - d * 1000;
    return age <= FRESH_MS && age >= -60000;
  };

  const remember = (id) => {
    linked = String(id);
    try {
      require('./telegramService').saveConfig({ chatId: linked });
      logger.log(`[telegram-inbox] chat linked: ${linked}`);
    } catch (_) {}
  };

  async function tick() {
    const firstProbe = offset === null;
    const { updates, nextOffset } = await http.getUpdates(offset, firstProbe ? 0 : 20);
    // PRIMING ASKS, AND ANSWERS ONLY WHAT JUST ARRIVED. The first update may be hours old, so
    // the offset is advanced past it and the chat is left quiet; a message from the last two
    // minutes is a question and gets an answer.
    if (updates.length) {
      offset = nextOffset != null ? nextOffset : (Number(updates[updates.length - 1].update_id) || 0) + 1;
    }
    for (const u of updates) {
      const msg = u && (u.message || u.channel_post);
      const text = msg && msg.text;
      const id = msg && msg.chat && msg.chat.id;
      if (!text || id == null) continue;
      if (firstProbe && !fresh(msg)) continue;        // history: advance the offset, say nothing
      if (!linked) remember(id);
      if (String(id) !== linked) continue;          // not the owner's chat: no reply, ever
      // IN ORDER, ONE AT A TIME: updates are handled sequentially inside `tick`, so two rapid
      // commands cannot interleave their sends — and none is dropped.
      try {
        const reply = inbox.handle(text);
        if (reply) await http.sendMessage(linked, reply);
        logger.log(`[telegram-inbox] answered "${String(text).slice(0, 40)}"`);
      } catch (e) {
        logger.warn('[telegram-inbox] reply failed:', (e && e.message) || e);
      }
    }
  }

  const loop = (async () => {
    while (!stopped) {
      try {
        await tick();
      } catch (e) {
        // A network failure is not an event: back off and keep the inbox alive.
        logger.warn('[telegram-inbox] polling failed:', (e && e.message) || e);
        if (!stopped) await new Promise((r) => setTimeout(r, retryMs));
      }
      if (!stopped) await new Promise((r) => setTimeout(r, pollMs));
    }
  })();

  logger.log('[telegram-inbox] listening — /calls /book /status /why');
  return {
    stop() { stopped = true; return loop.catch(() => {}); },
    get chatId() { return linked; },
  };
}

module.exports = { createInbox, startInbox, HELP };
