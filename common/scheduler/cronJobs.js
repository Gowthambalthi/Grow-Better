/**
 * common/scheduler/cronJobs.js
 * Automated Daily Scheduler for Institutional Conviction Pipeline
 */
'use strict';

const path = require('path');
const { execFile } = require('child_process');
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
  const engine = opts.engine || require('../../strategies/orderflow/liveMinuteEngine');
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
 * The owner's rule, measured on 2026-10-20 (scratch/news_lean_backtest.js,
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
  lines.push('📰 <b>News leans · ' + ist.toISOString().slice(0, 10) + ' morning</b>');
  const stocks = (sig && sig.stocks) || [];
  if (!stocks.length) {
    lines.push('No stock-specific reliable leans in the last day — nothing to act on.');
  } else {
    for (const r of stocks.slice(0, 8)) {
      lines.push((r.lean === 'UP' ? '▲' : '▼') + ' <b>' + r.symbol + '</b> (' + r.category +
        ') — that class was right ' + Math.round(r.hitRate * 100) + '% (n=' + r.classN + ')');
      lines.push('   ' + String(r.title || '').slice(0, 110));
    }
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
  } else {
    console.log('[Cron Scheduler] node-cron missing — the 6 PM evening scan and the 30-minute scan count will not auto-run.');
  }

}







module.exports = {
  runEveningScan,
  initScheduler,
  marketOpenAt,
  formatScanSummary,
  sendScanSummary,
  formatLeanDigest,
  sendLeanDigest,
  SCAN_SUMMARY_CRON,
  NEWS_LEAN_DIGEST_CRON,
  MARKET_OPEN_PHASES,
};
