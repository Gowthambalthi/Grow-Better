/**
 * common/scheduler/cronJobs.js
 * Automated Daily Scheduler for Institutional Conviction Pipeline
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const sessionTiming = require('../market/sessionTiming');
const { sendPhoneNotification } = require('../notifications/telegramService');

let cron;
try {
  cron = require('node-cron');
} catch (e) {
  console.warn('[Cron Scheduler] node-cron module not installed, falling back to interval scheduler');
}



/**
 * Initializes cron jobs or interval fallback timers
 */
/**
 * The 6 PM evening scan: rebuild data/universe/tomorrow_500.json +
 * watchlist_2500.json (the terminal feed) and send the Telegram summary.
 * It writes the files the Server already reads; before this it was never run.
 */
function runEveningScan(extraArgs = []) {
  const script = path.join(__dirname, '..', '..', 'scripts', 'eveningScan.js');
  console.log('[Cron Job] Evening scan starting...');
  execFile(process.execPath, [script].concat(extraArgs), { cwd: path.join(__dirname, '..', '..') }, (err, stdout, stderr) => {
    if (err) console.error('[Cron Job] Evening scan failed:', err.message, String(stderr).slice(0, 300));
    else console.log('[Cron Job] Evening scan done:', String(stdout).trim().split('\n').slice(-3).join(' | '));
  });
}

// ---------------------------------------------------------------------------
// THE HALF-HOURLY SCAN COUNT
// ---------------------------------------------------------------------------

/**
 * The owner's simplest question between calls: how many stocks is the engine
 * actually looking at? The minute scan answers it in the log line ("494 symbols
 * | … | in play 172"), which nobody reads on a phone, and the board only says it
 * while the page is open. This sends the same number to Telegram every 30 minutes
 * WHILE THE MARKET IS OPEN, and sends nothing at all outside that window.
 *
 * ACTIVE_TRADING is the obvious phase. CUTOFF and SQUARE_OFF are included because
 * the tape is still live (positions are still managed) and the counts are still
 * worth a message; PRE_OPEN, OBSERVATION and CLOSED are not, and are silent.
 */
const MARKET_OPEN_PHASES = ['ACTIVE_TRADING', 'CUTOFF', 'SQUARE_OFF'];
const SCAN_SUMMARY_CRON = '*/30 * * * *';

// 15:50 IST, weekdays — ten minutes after the close. The news feed's company
// moves are measured from FINISHED sessions only, so today's headlines become
// measurable here: fetch the session's daily candles for the symbols the news
// named, append them to the bar cache, and rebuild company_moves.json. Nothing
// else is touched — in particular the event study's learning window is not.
const NEWS_MOVES_TOPUP_CRON = '50 15 * * 1-5';

function marketOpenAt(date) {
  return MARKET_OPEN_PHASES.includes(sessionTiming.getSessionPhase(date || new Date()).phase);
}

/**
 * The message. `scanned` is how many names the last pass actually walked — NOT how
 * many qualified — because on a quiet day those are the only two numbers that tell
 * "nothing set up" apart from "the feed is not there".
 *
 * `asOfIST` is printed beside the count on purpose: during CUTOFF the scan stops
 * walking the universe, so the numbers keep their last values and the timestamp is
 * what says so.
 */
function formatScanSummary(funnel, atIST) {
  const at = atIST || sessionTiming.getISTTime().toTimeString().slice(0, 8);
  const f = funnel || {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const scanned = num(f.scanned);
  // `asOfIST` IS THE PROOF A PASS RAN. `emptyFunnel()` is every counter at zero with no
  // timestamp — a fresh process, a restart inside a no-entry window, a second instance — and
  // reporting that as "0 stocks scanned" says the feed is dead when the truth is that this
  // process has not looked yet. A REAL pass always stamps the time it walked the universe.
  if (scanned == null || !f.asOfIST) {
    return '🔍 <b>Scan report · ' + at + ' IST</b>\n' +
      'No symbol-level scan has walked the universe yet in this process — ' +
      'before the first pass, or outside the session window. ' +
      '(A pass stamps its own time; this one has none.)';
  }
  return [
    '🔍 <b>Scan report · ' + at + ' IST</b>',
    '<b>' + scanned + '</b> stocks scanned' + (f.asOfIST ? ' · last pass ' + f.asOfIST : ''),
    (num(f.inPlay) || 0) + ' in play · ' + (num(f.qualified) || 0) + ' qualified',
  ].join('\n');
}

/**
 * Send one summary. Returns the text that was produced, whether or not delivery
 * succeeded, so a test can read it without a socket.
 *
 * NOTHING HERE THROWS. It runs on a timer: a refused Telegram call must be logged,
 * never allowed to become an unhandled rejection that takes the scheduler down.
 */
async function sendScanSummary(opts = {}) {
  // THE INTRADAY MINUTE ENGINE WAS DELETED on 2026-10-31, so there is no funnel to report.
  // `opts.engine` is still honoured — the tests inject a stub and the scheduler keeps working —
  // and with nothing injected this reports a null funnel rather than crashing on a timer.
  const engine = opts.engine || { getScanFunnel: () => null };
  let funnel = null;
  try {
    funnel = typeof engine.getScanFunnel === 'function' ? engine.getScanFunnel() : null;
  } catch (err) {
    console.error('[Cron Job] Scan funnel read failed:', err.message);
  }
  const text = formatScanSummary(funnel, opts.atIST);
  const notify = opts.notify || sendPhoneNotification;
  // ONE REPORT PER SLOT, NOT ONE PER PROCESS. The half-hour is the event: two running
  // instances — or a restart just before :00 and another just after — otherwise send the
  // same count twice, and on 2026-10-19 a report at 12:13 and another at 12:30 both arrived
  // from instances that were not the one printing them. The test's stub is passed through
  // untouched, so a test that counts calls still sees every one of them.
  const ist = sessionTiming.getISTTime();
  const slot = opts.atIST ? String(opts.atIST).slice(0, 5) : ist.toTimeString().slice(0, 5);
  // The date is the IST one, for the same reason every other boundary here is: a UTC date
  // would open a new slot at 05:30 IST and make two reports in one session share a key.
  const dedupeKey = opts.notify ? null : `scansummary:${ist.toISOString().slice(0, 10)}:${slot}`;
  try {
    const res = await notify(text, dedupeKey ? { dedupeKey } : undefined);
    if (res && res.success === false) {
      console.warn('[Cron Job] Scan summary not delivered:', res.reason);
    } else {
      // LOGGED ON SUCCESS TOO. A silent timer is indistinguishable from a dead
      // timer, which is the exact ambiguity this whole message exists to remove.
      console.log('[Cron Job] Scan summary sent:', text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    }
  } catch (err) {
    console.error('[Cron Job] Scan summary send failed:', err.message);
  }
  return text;
}

/**
 * THE MORNING NEWS LEAN DIGEST — 08:45 IST, half an hour before the open.
 *
 * The owner's rule, measured on 2026-10-20 (docs/measurements/scratch/news_lean_backtest.js,
 * holdout 2026-01→05): acting on the reliable news leans at the NEXT open is
 * net-positive ONLY when the entry has NOT already gapped the class's expected
 * move — that skip rule is the difference between PF 0.95 and PF 1.09 — with a
 * 1.5% stop and an exit at the next close. The digest states the day's leans
 * WITH that rule and the measured numbers beside them, because a lean without
 * its base rate is a guess.
 *
 * One message per day, deduped by date — same pattern as sendScanSummary.
 * NOTHING HERE THROWS: it runs on a timer.
 */
const NEWS_LEAN_DIGEST_CRON = '45 8 * * *';

function formatLeanDigest(sig, policy) {
  const p = policy || {};
  const lines = [];
  const ist = sessionTiming.getISTTime();
  // THE BOARD'S OWN SCORECARD (common/news/leanVerified.js) — the digest says
  // the same thing the panel does about what these leans actually did.
  const verified = sig && sig.verified;
  lines.push('📰 <b>News leans · ' + ist.toISOString().slice(0, 10) + ' morning</b>');
  // THE WINDOW. The digest only ever shows news published at or after the last
  // 15:30 IST close — everything older already moved the market.
  if (sig && sig.sinceClose && sig.sinceClose.label) {
    lines.push('🕓 only news since last close · ' + sig.sinceClose.label);
  }
  const stocks = (sig && sig.stocks) || [];
  if (!stocks.length) {
    lines.push('No stock-specific reliable leans in the last day — nothing to act on.');
  } else {
    const pct = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%');
    for (const r of stocks.slice(0, 8)) {
      lines.push((r.lean === 'UP' ? '▲' : '▼') + ' <b>' + r.symbol + '</b> (' + r.category +
        ') — that class was right ' + Math.round(r.hitRate * 100) + '% (n=' + r.classN + ')');
      // HOW IT WAS TAKEN BEFORE — the distribution card the owner asked for.
      if (r.history && r.history.n) {
        lines.push('   📅 before, n=' + r.history.n + ': avg ' + pct(r.history.mean) + ' · median ' + pct(r.history.median) +
          ' · ran up >1% ' + Math.round(r.history.upOver1 * 100) + '% · fell >1% ' + Math.round(r.history.downOver1 * 100) + '%');
      }
      // THE MODEL'S SCORE — the persisted GBM. The ⭐ was WITHDRAWN on 2026-10-21:
      // replayed on this board's own output (docs/measurements/scratch/lean_walkforward.js) its
      // high-conviction picks were profitable 36.4% of the time against a 40.3%
      // base rate, so the phone must not present it as conviction either.
      if (r.ml) {
        lines.push(verified && verified.mlVerdict
          ? '   🧠 ml p=' + r.ml.p.toFixed(2) + ' — measured WORSE than the base rate out of sample; sizes nothing'
          : '   🧠 ml (p=' + r.ml.p.toFixed(2) + ' vs ' + r.ml.threshold.toFixed(2) + ')');
      }
      // WHAT THE MARKET DID WITH IT SO FAR — the rule that separates PF 0.95
      // from 1.09, plus the two states that are not a no: 'AGAINST' (the tape is
      // moving the other way) and 'FLAT' (nobody reacted). "Not moved yet" used
      // to cover all three, and a green tick on a falling stock is how a lean
      // reads as a call it never was.
      const g = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
      if (r.live && r.live.status === 'SKIP') {
        const gate = r.live.gatePct != null ? r.live.gatePct : r.live.muPct;
        lines.push('   ⚠️ CHASE ' + g(r.live.gapPct) + ' — the open is already ≥ ' + gate +
          '% with the lean; measured to lose money, SKIP');
      } else if (r.live && r.live.status === 'AGAINST') {
        lines.push('   ✗ MOVING AGAINST THE LEAN ' + g(r.live.gapPct) + ' — the tape disagrees; stand down');
      } else if (r.live && r.live.status === 'FLAT') {
        lines.push('   • NO REACTION ' + g(r.live.gapPct) + ' — the market ignored it; nothing to chase');
      } else if (r.live && r.live.status === 'PENDING') {
        lines.push('   · TOO EARLY ' + g(r.live.gapPct) + ' — news is only ' + Math.round(r.live.ageMin || 0) + ' min old');
      } else if (r.live && r.live.status === 'OPEN') {
        // NO GREEN TICK: the replay measured this cohort at −0.09%/trade.
        lines.push('   · OPEN ' + g(r.live.gapPct) + ', short of the ' + r.live.muPct.toFixed(1) +
          '% expected — moving as tagged, not a green light');
      }
      lines.push('   ' + String(r.title || '').slice(0, 110));
    }
  }

  // IS THE TAG STILL WORKING? Every row above quotes a LEARNING-WINDOW hit rate;
  // these two lines quote the last 30 days and what is left after the news day,
  // so the phone cannot read like a green light on a decayed edge.
  if (sig && sig.suppressed) {
    lines.push('');
    lines.push('🚫 ' + sig.suppressed + ' headline(s) suppressed — class under ' +
      Math.round(((sig.recentWindow && sig.recentWindow.gate) || 0.55) * 100) + '% on the last ' +
      ((sig.recentWindow && sig.recentWindow.days) || 30) + ' days' +
      (sig.suppressedClasses && Object.keys(sig.suppressedClasses).length
        ? ': ' + Object.keys(sig.suppressedClasses).map((k) => k.replace('_', ' ') + ' ' +
          Math.round(sig.suppressedClasses[k].hit * 100) + '%').join(', ')
        : ''));
  }
  if (sig && sig.forward && sig.forward.n) {
    lines.push('📉 after the news day: the NEXT session went the tagged way ' +
      Math.round(sig.forward.hit * 100) + '% of ' + sig.forward.n +
      ' measured pairs — the edge is the gap, not a continuation');
  }

  // GLOBAL → INDIA: world headlines that historically moved Indian baskets
  // (the Accenture/ai_DOWN → Indian IT case), gated by the measured bridge.
  const g = sig.global;
  const gThemed = (g && g.available && (g.themes || []).filter((t) => t.baskets.length)) || [];
  if (gThemed.length) {
    lines.push('');
    lines.push('🌍 <b>GLOBAL → INDIA</b> (measured bridge):');
    for (const t of gThemed.slice(0, 4)) {
      const b = t.baskets[0];
      lines.push((t.direction === 'UP' ? '▲' : '▼') + ' <b>' + b.members.slice(0, 8).join(', ') + '</b>' +
        (b.nMembers != null && b.nMembers < 3 ? ' <i>(measured on ' + b.nMembers + ' stock' + (b.nMembers === 1 ? '' : 's') + ' only)</i>' : '') +
        ' lean ' + b.expectedMove + ' — right ' + Math.round(b.rightRate * 100) + '% on ' + b.n +
        ' such days, avg ' + (b.meanAr * 100).toFixed(2) + '% vs market');
      lines.push('   because: ' + String(t.title || '').slice(0, 100));
    }
  }
  // WHAT THIS BOARD ITSELF DID — the phone and the page quote the same replay.
  if (verified && verified.available && verified.verdict) {
    lines.push('');
    lines.push('📋 <b>VERIFIED:</b> ' + verified.verdict);
    if (verified.controlVerdict) lines.push('   control: ' + verified.controlVerdict);
  }
  lines.push('');
  if (p.measuredAt && p.stats) {
    lines.push('📐 <b>Rule, measured ' + String(p.measuredAt).slice(0, 10) + ':</b> enter at the next open' +
      ' only if it has NOT already gapped ≥ the class\u2019s expected move — don\u2019t chase. ' +
      'SL ' + p.slPct + '%, exit at the next close.');
    lines.push('   holdout: n=' + p.stats.n + ' · hit ' + Math.round((p.stats.hit || 0) * 100) +
      '% · net ' + (Number(p.stats.meanNetPct) * 100).toFixed(2) + '%/trade · PF ' +
      (p.stats.pf != null ? Number(p.stats.pf).toFixed(2) : '—'));
  } else {
    lines.push('📐 Trade rule NOT yet measured (no lean_policy.json) — treat leans as context only.');
  }
  lines.push('A lean is a probability, not a call. This trades nothing by itself.');
  return lines.join('\n');
}

async function sendLeanDigest(opts = {}) {
  try {
    const store = opts.store || require('../../common/news/newsStore');
    const signals = opts.signals || require('../../common/news/newsSignals');
    const sig = signals.computeSignals(store.readItems(), store.readReaction(), 1);
    // LIVE GAP CHECK — the digest says SKIP or OK per lean, from a real quote.
    // Offline or unquoted symbols stay 'unknown'; the digest never guesses.
    if (!opts.noQuotes) {
      try {
        const liveQuoteEngine = require('../../common/market/liveQuoteEngine');
        const top = (sig.stocks || []).slice(0, 8).map((s) => s.symbol);
        if (top.length) signals.attachLiveState(sig, await liveQuoteEngine.fetchStockQuotes(top));
      } catch (e) {
        console.warn('[Cron Job] lean digest live quotes unavailable:', e.message);
      }
    }
    const text = formatLeanDigest(sig, sig.policy);
    const notify = opts.notify || sendPhoneNotification;
    const ist = sessionTiming.getISTTime();
    const dedupeKey = opts.notify ? null : `leandigest:${ist.toISOString().slice(0, 10)}`;
    const res = await notify(text, dedupeKey ? { dedupeKey } : undefined);
    if (res && res.success === false) {
      console.warn('[Cron Job] News lean digest not delivered:', res.reason);
    } else {
      console.log('[Cron Job] News lean digest sent:', text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
    }
    return text;
  } catch (err) {
    console.error('[Cron Job] News lean digest failed:', err.message);
    return null;
  }
}

/**
 * THE US CLOSE → INDIA TODAY RECAP. The US session (09:30–16:00 ET = 19:00/
 * 20:00 → 01:30/02:30 IST) is the information the Indian day opens on. This
 * digest reads the headlines that arrived DURING tonight's US session, counts
 * their themes, and maps the gate-passing ones through the measured
 * Global→India bridge — the same measurement the board and the morning digest
 * quote, so the three can never disagree.
 */
const US_CLOSE_DIGEST_CRON = '15 3 * * *'; // 03:15 IST — after both EDT (01:30) and EST (02:30) closes
const US_SESSION_MS = 6.5 * 3600000;       // 09:30 → 16:00 ET

function formatUsSessionDigest(recap, global) {
  const lines = [];
  lines.push('🇺🇸 <b>US CLOSE → INDIA TODAY</b> · US market closed ' + recap.close.label);
  lines.push('Tonight\u2019s session: <b>' + recap.n + '</b> headlines · ' +
    (recap.counts.length
      ? recap.counts.map((c) => c.category +
          (c.direction === 'UP' ? '▲' : c.direction === 'DOWN' ? '▼' : '·') + ' ' + c.n).join(' · ')
      : 'no headlines stored for the session'));
  for (const it of recap.headlines) {
    lines.push((it.direction === 'UP' ? '▲' : it.direction === 'DOWN' ? '▼' : '·') +
      ' [' + it.category + '] ' + String(it.title || '').slice(0, 110));
  }
  const gThemed = (global && global.available && (global.themes || []).filter((t) => t.baskets.length)) || [];
  lines.push('');
  if (gThemed.length) {
    lines.push('🌍 <b>Measured bridge — what this has historically moved in India:</b>');
    for (const t of gThemed.slice(0, 4)) {
      const b = t.baskets[0];
      lines.push((t.direction === 'UP' ? '▲' : '▼') + ' <b>' + b.members.slice(0, 8).join(', ') + '</b>' +
        (b.nMembers != null && b.nMembers < 3 ? ' <i>(measured on ' + b.nMembers + ' stock' + (b.nMembers === 1 ? '' : 's') + ' only)</i>' : '') +
        ' lean ' + b.expectedMove + ' — right ' + Math.round(b.rightRate * 100) + '% on ' + b.n +
        ' such days, avg ' + (b.meanAr * 100).toFixed(2) + '% vs market');
    }
  } else {
    lines.push('🌍 No measured Indian move for tonight\u2019s themes — backdrop only.');
  }
  lines.push('This is the backdrop today\u2019s session opens on. A lean is a probability, not a call.');
  return lines.join('\n');
}

/**
 * Build the recap from the store and send it — or skip honestly. The 6-hour
 * freshness guard is what makes the schedule safe: 03:15 IST is 0.75–1.75h
 * after a regular close (EST/EDT), a few hours after a half-day, and a full
 * day+ after Friday's close — so weekends send nothing rather than a stale
 * "US close". NOTHING HERE THROWS: it runs on a timer.
 */
async function sendUsCloseDigest(opts = {}) {
  try {
    const now = typeof opts.now === 'function' ? opts.now() : (opts.now || new Date());
    const close = sessionTiming.lastUsClose(now);
    const ageMs = now.getTime() - close.instant;
    if (!(ageMs >= 0 && ageMs <= 6 * 3600000)) {
      console.log('[Cron Job] US close recap skipped — last US close is ' + Math.round(ageMs / 3600000) + 'h old, not tonight\u2019s session.');
      return null;
    }
    const store = opts.store || require('../../common/news/newsStore');
    const signals = opts.signals || require('../../common/news/newsSignals');
    const openInstant = close.instant - US_SESSION_MS;
    const openDate = new Date(openInstant + 19800000).toISOString().slice(0, 10);
    const items = (store.readItems() || []).filter((it) => Number.isFinite(it.ts) && it.ts >= openInstant && it.ts <= close.instant);
    const byKey = {};
    for (const it of items) {
      const k = it.category + '_' + it.direction;
      byKey[k] = (byKey[k] || 0) + 1;
    }
    const counts = Object.entries(byKey)
      .map(([k, n]) => { const i = k.lastIndexOf('_'); return { category: k.slice(0, i), direction: k.slice(i + 1), n }; })
      .sort((a, b) => b.n - a.n).slice(0, 6);
    const headlines = items.slice().sort((a, b) => b.ts - a.ts).slice(0, 6);
    const global = signals.computeGlobal(items, openDate, now);
    const text = formatUsSessionDigest({ close, n: items.length, counts, headlines }, global);
    const notify = opts.notify || sendPhoneNotification;
    const ist = sessionTiming.getISTTime(now);
    const dedupeKey = opts.notify ? null : `usrecap:${ist.toISOString().slice(0, 10)}`;
    const res = await notify(text, dedupeKey ? { dedupeKey } : undefined);
    if (res && res.success === false) {
      console.warn('[Cron Job] US close recap not delivered:', res.reason);
    } else {
      console.log('[Cron Job] US close recap sent:', text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200));
    }
    return text;
  } catch (err) {
    console.error('[Cron Job] US close recap failed:', err.message);
    return null;
  }
}

/**
 * Initializes cron jobs or interval fallback timers.
 *
 * `deps` exists so the schedule itself can be tested without waiting for a wall
 * clock or touching a network: pass `{ cron, now, sendScanSummary }`. Production
 * calls it with no arguments.
 */
function initScheduler(deps = {}) {
  const scheduler = deps.cron || cron;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const send = deps.sendScanSummary || sendScanSummary;

  if (scheduler) {
    // 6:00 PM IST daily: build tomorrow's 500-name universe + Telegram report (0 18 * * *)
    scheduler.schedule('0 18 * * *', () => {
      runEveningScan();
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled: Evening scan (6 PM) — universe + Telegram.');

    // :00 and :30. The phase guard is what makes "market open" true — cron alone
    // would fire at 09:00 (PRE_OPEN) and 15:30 (CLOSED), so the guard, not the
    // expression, is the boundary.
    scheduler.schedule(SCAN_SUMMARY_CRON, () => {
      if (!marketOpenAt(now())) return;
      try {
        const out = send();
        if (out && typeof out.catch === 'function') {
          out.catch((err) => console.error('[Cron Job] Scan summary failed:', err.message));
        }
      } catch (err) {
        console.error('[Cron Job] Scan summary failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled: Scan count every 30 min, market hours only.');

    // 08:45 IST daily: the news leans of the last 24h with their measured hit
    // rates and the backtested rule (skip if already gapped, SL %, exit next
    // close) — half an hour before the open, which is when the rule acts.
    scheduler.schedule(NEWS_LEAN_DIGEST_CRON, () => {
      try {
        const out = sendLeanDigest();
        if (out && typeof out.catch === 'function') {
          out.catch((err) => console.error('[Cron Job] News lean digest failed:', err.message));
        }
      } catch (err) {
        console.error('[Cron Job] News lean digest failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled: News lean digest at 08:45 IST daily.');

    // 09:08 IST weekdays — PRE-MARKET AUCTION CALLS (09:08 - 09:15 AM Window)
    // Runs right after the NSE pre-market order matching finishes and the official
    // Indicative Equilibrium Price (IEP / open) and gap % are published.
    const PRE_MARKET_CALLS_CRON = process.env.PRE_MARKET_CALLS_CRON || '8 9 * * 1-5';
    scheduler.schedule(PRE_MARKET_CALLS_CRON, async () => {
      try {
        const preMarketCalls = require('../market/preMarketCalls');
        console.log('[Cron Job] 09:08 AM Pre-Market IEP Auction Call Engine running...');
        const res = await preMarketCalls.generatePreMarketCalls();
        console.log(`[Cron Job] 09:08 AM Pre-Market Calls generated: ${res.confirmedBuys.length} buys, ${res.confirmedFades.length} fades, ${res.traps.length} traps.`);
        if (res.confirmedBuys.length > 0 || res.confirmedFades.length > 0) {
          const lines = [
            `🌅 <b>09:08 AM PRE-OPEN CONFIRMED CALLS</b>`,
            `<i>(Pre-Market 09:00-09:08 IEP Discovered · Ready for 09:15 Open)</i>\n`
          ];
          if (res.confirmedBuys.length > 0) {
            lines.push(`🟢 <b>CONFIRMED BUYS (Gap-Up Momentum):</b>`);
            res.confirmedBuys.slice(0, 3).forEach(b => {
              lines.push(`• <b>${b.symbol}</b>: Entry ₹${b.iep} (+${b.gapPct}%) | Target ₹${b.targetPrice} | SL ₹${b.stopLoss}`);
            });
            lines.push('');
          }
          if (res.confirmedFades.length > 0) {
            lines.push(`🔴 <b>CONFIRMED SELLS / FADES (Gap-Down):</b>`);
            res.confirmedFades.slice(0, 3).forEach(f => {
              lines.push(`• <b>${f.symbol}</b>: Entry ₹${f.iep} (${f.gapPct}%) | Target ₹${f.targetPrice} | SL ₹${f.stopLoss}`);
            });
            lines.push('');
          }
          if (res.traps.length > 0) {
            lines.push(`⚠️ <b>TRAPS TO AVOID:</b>`);
            res.traps.slice(0, 2).forEach(t => {
              lines.push(`• <b>${t.symbol}</b>: Positive filing but pre-market gapped ${t.gapPct}% (Institutions fading)`);
            });
          }
          await sendPhoneNotification(lines.join('\n'));
        }
      } catch (err) {
        console.error('[Cron Job] 09:08 AM Pre-Market Calls failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });
    console.log('[Cron Scheduler] Scheduled: 09:08 AM Pre-Market IEP Auction Call Engine, weekdays.');

    // 03:15 IST daily — right after the US close (01:30 on EDT, 02:30 on EST):
    // what tonight's US session said, mapped to the Indian baskets it has
    // historically moved. The in-function guard skips weekends.
    scheduler.schedule(US_CLOSE_DIGEST_CRON, () => {
      try {
        const out = sendUsCloseDigest();
        if (out && typeof out.catch === 'function') {
          out.catch((err) => console.error('[Cron Job] US close recap failed:', err.message));
        }
      } catch (err) {
        console.error('[Cron Job] US close recap failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled: US close recap at 03:15 IST daily.');

    // The per-headline company moves the news feed shows. Without this the bar
    // cache stops at whatever the 1-minute corpus last covered, and every
    // headline after that silently had no measured move — the feed looked
    // broken for exactly the rows a reader looks at first.
    scheduler.schedule(NEWS_MOVES_TOPUP_CRON, () => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const child = spawn(process.execPath, [pathMod.join(root, 'scripts', 'topUpNewsBars.js')], {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
        child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
        child.on('close', (code) => {
          const last = tail.split('\n').filter(Boolean).slice(-2).join(' | ');
          console.log('[Cron Job] news company moves top-up finished (' + code + ')' + (last ? ' — ' + last : ''));
        });
      } catch (err) {
        console.error('[Cron Job] news company moves top-up failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });

    console.log('[Cron Scheduler] Scheduled: news company moves top-up at 15:50 IST, weekdays.');

    // THE KI01 NEWS INDEX WAS NEVER REBUILT IN PRODUCTION.
    //
    // `strategies/keyidea/newsIndex.js` caches a directional, symbol-keyed index at
    // data/terminal/keyidea_news_index.json, and the KI01 gate reads ONLY that file.
    // Nothing scheduled it — the shipped copy was built by hand once — so on 2026-10-26 it
    // was 3 hours old with its newest record at 10:13 while NSE filed Axis Bank's Q2
    // transcript at 20:58. A gate that cannot see this morning's news is not a gate.
    //
    // The build streams flash_history + items and takes ~15s, so every 10 minutes through
    // the session (and once after the close, when most filings land) is affordable.
    const NEWS_INDEX_MARKET_CRON = process.env.KEYIDEA_NEWS_INDEX_CRON || '*/10 9-15 * * 1-5';
    const NEWS_INDEX_CLOSE_CRON = process.env.KEYIDEA_NEWS_INDEX_CLOSE_CRON || '20 16 * * 1-5';
    const rebuildKeyideaNewsIndex = (why) => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const child = spawn(process.execPath, [pathMod.join(root, 'strategies', 'keyidea', 'newsIndex.js'), '--build'], {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-1000); });
        child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-1000); });
        child.on('close', (code) => {
          const line = tail.split('\n').filter(Boolean)[0] || '';
          console.log('[Cron Job] KEYIDEA news index rebuilt (' + code + ', ' + why + ')' + (line ? ' — ' + line : ''));
        });
      } catch (err) {
        console.error('[Cron Job] KEYIDEA news index rebuild failed:', err.message);
      }
    };
    scheduler.schedule(NEWS_INDEX_MARKET_CRON, () => rebuildKeyideaNewsIndex('market hours'), { timezone: 'Asia/Kolkata' });
    scheduler.schedule(NEWS_INDEX_CLOSE_CRON, () => rebuildKeyideaNewsIndex('after close'), { timezone: 'Asia/Kolkata' });
    console.log('[Cron Scheduler] Scheduled: KEYIDEA news index rebuild every 10 min 09-15 IST weekdays, plus 16:20 IST.');

    // THE REACTION TABLE (common/news/newsReaction.js) IS A CACHE TOO.
    // It learns what each (category, label) actually did over 15/30/60/120 minutes. It is
    // built from the 1m corpus + stored headlines, so it only changes when those change —
    // weekly is enough, and the build time is exposed on /api/news/refresh/status so a stale
    // table is visible instead of silently asserting an old measurement.
    const REACTION_CRON = process.env.GB_NEWS_REACTION_CRON || '10 9 * * 0';
    scheduler.schedule(REACTION_CRON, () => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const child = spawn(process.execPath, [pathMod.join(root, 'scripts', 'buildNewsReaction.js')], {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-1500); });
        child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-1500); });
        child.on('close', (code) => {
          const line = tail.split('\n').filter((l) => /groups with|written/.test(l)).join(' | ');
          console.log('[Cron Job] news reaction table rebuilt (' + code + ')' + (line ? ' — ' + line : ''));
        });
      } catch (err) {
        console.error('[Cron Job] news reaction rebuild failed:', err.message);
      }
    }, { timezone: 'Asia/Kolkata' });
    console.log('[Cron Scheduler] Scheduled: news reaction table rebuild Sundays 09:10 IST.');

    // 30-MINUTE LIVE SWING BREAKOUT SCANNER (WEEKDAYS 09:15 - 15:30 IST)
    const SWING_BREAKOUT_CRON = process.env.SWING_BREAKOUT_CRON || '*/30 9-15 * * 1-5';
    scheduler.schedule(SWING_BREAKOUT_CRON, () => {
      runLiveSwingBreakoutScan('market hours 30m cron');
    }, { timezone: 'Asia/Kolkata' });
    console.log('[Cron Scheduler] Scheduled: 30-minute Live Swing Breakout Scan (09:15-15:30 IST weekdays).');

    // 30-SECOND LIVE INDIAN FINANCIAL WIRE CONNECTOR (LiveMint + ET + BS + Strict NSE Catalysts)
    setInterval(() => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const pyScript = pathMod.join(root, 'scripts', 'connect_live_news_wire.py');
        const child = spawn('python', [pyScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        child.on('error', () => {});
      } catch (_) {}
    }, 30000);

    setTimeout(() => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const pyScript = pathMod.join(root, 'scripts', 'connect_live_news_wire.py');
        spawn('python', [pyScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        const strangleScript = pathMod.join(root, 'scripts', 'generate_live_strangle_calls.py');
        spawn('python', [strangleScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        const trackerScript = pathMod.join(root, 'scripts', 'track_live_strangle_pnl.py');
        spawn('python', [trackerScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {}
    }, 2000);

    // Regularly refresh 09:20 AM Strangle Calls and Live Session Tracker (every 2 minutes)
    setInterval(() => {
      try {
        const { spawn } = require('child_process');
        const pathMod = require('path');
        const root = pathMod.join(__dirname, '..', '..');
        const strangleScript = pathMod.join(root, 'scripts', 'generate_live_strangle_calls.py');
        spawn('python', [strangleScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
        const trackerScript = pathMod.join(root, 'scripts', 'track_live_strangle_pnl.py');
        spawn('python', [trackerScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {}
    }, 120000);

    // BOOT CATCH-UP CHECK:
    // If the server was off or restarted, check data/live_calls_tomorrow.json.
    // If it's missing or older than 30 minutes during market open, run immediate catch-up scan!
    try {
      const callsFile = path.join(__dirname, '..', '..', 'data', 'live_calls_tomorrow.json');
      const now = Date.now();
      let needsCatchup = false;
      if (!fs.existsSync(callsFile)) {
        needsCatchup = true;
      } else {
        const stats = fs.statSync(callsFile);
        const ageMin = (now - stats.mtimeMs) / (60 * 1000);
        let parsed = null;
        try { parsed = JSON.parse(fs.readFileSync(callsFile, 'utf8')); } catch {}
        const todayStr = new Date().toISOString().slice(0, 10);
        if (ageMin > 30 || (parsed && parsed.sessionDate !== todayStr)) {
          needsCatchup = true;
        }
      }
      if (needsCatchup) {
        console.log('[Cron Scheduler] ⚡ Boot catch-up triggered: live calls are stale (>30m) or from previous session. Running immediate scan in 5s...');
        setTimeout(() => runLiveSwingBreakoutScan('boot catch-up'), 5000);
      } else {
        console.log('[Cron Scheduler] Boot check: live calls file is fresh (<= 30m).');
      }
    } catch (bootErr) {
      console.warn('[Cron Scheduler] Boot check error:', bootErr.message);
    }
  } else {
    console.log('[Cron Scheduler] node-cron missing — the 6 PM evening scan and the 30-minute scan count will not auto-run.');
  }

}

// ---------------------------------------------------------------------------
// 30-MINUTE LIVE SWING BREAKOUT SCANNER (CUP & HANDLE + ASCENDING TRIANGLE)
// ---------------------------------------------------------------------------
let isSwingScanRunning = false;
function runLiveSwingBreakoutScan(why = 'scheduled') {
  if (isSwingScanRunning) {
    console.log('[Cron Job] Swing Breakout scan already in progress — skipping duplicate trigger (' + why + ').');
    return false;
  }
  isSwingScanRunning = true;
  const root = path.join(__dirname, '..', '..');
  const scriptPath = path.join(root, 'scripts', 'run_live_trading_system.js');
  console.log('[Cron Job] ⚡ Starting Live Swing Breakout Scan (' + why + ')...');
  const child = spawn(process.execPath, [scriptPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let tail = '';
  child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
  child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
  child.on('close', (code) => {
    isSwingScanRunning = false;
    const summaryLine = tail.split('\n').filter(l => l.includes('Actionable calls exported') || l.includes('ACTIONABLE INSTITUTIONAL')).join(' | ');
    console.log('[Cron Job] ⚡ Live Swing Breakout Scan finished (code ' + code + ', ' + why + ')' + (summaryLine ? ' — ' + summaryLine : ''));

    // Automatically trigger Institutional Trend Rider & TraderHR Support Bounce Scanner
    try {
      const pyScript = path.join(root, 'scripts', 'scan_institutional_trend_and_support_live.py');
      const pyChild = spawn('python', [pyScript], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      pyChild.on('close', (pyCode) => {
        console.log(`[Cron Job] 🛡️ Institutional Trend & Support Bounce Scan finished (code ${pyCode}).`);
      });
    } catch (pyErr) {
      console.warn('[Cron Job] Could not spawn institutional trend scan:', pyErr.message);
    }
  });
  child.on('error', (err) => {
    isSwingScanRunning = false;
    console.error('[Cron Job] Live Swing Breakout Scan error:', err.message);
  });
  return true;
}

module.exports = {
  runEveningScan,
  runLiveSwingBreakoutScan,
  initScheduler,
  marketOpenAt,
  formatScanSummary,
  sendScanSummary,
  formatLeanDigest,
  sendLeanDigest,
  formatUsSessionDigest,
  sendUsCloseDigest,
  US_CLOSE_DIGEST_CRON,
  SCAN_SUMMARY_CRON,
  NEWS_LEAN_DIGEST_CRON,
  NEWS_MOVES_TOPUP_CRON,
  MARKET_OPEN_PHASES,
};
