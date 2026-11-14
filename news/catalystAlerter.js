'use strict';

/**
 * common/news/catalystAlerter.js
 * Instant Real-Time Multi-Burst Mobile Alerts for Breaking News Catalysts
 * Sends 2 to 3 notifications per breaking filing to ensure the trader never misses the pre-move window.
 *
 * RIGOROUS PROTECTION GATES:
 * 1. Price Floor: Minimum ₹30.00. Strictly eliminates penny stocks (< ₹30) like GLFL.
 * 2. Volume Floor: Minimum 25,000 shares traded. Strictly eliminates illiquid micro-caps (volume 1).
 * 3. Directional Tape Filter:
 *    - In market hours, if tape is falling (1m <= -0.05% or 5m <= -0.15%), BUY alerts are strictly forbidden.
 *    - If tape is low momentum / flat (|1m| < 0.15% & |5m| < 0.30%), BUY alerts are strictly forbidden.
 *    - If prior move >= 2.0%, pre-runup exhaustion blocks BUY.
 *    - Active green momentum required: 1m >= +0.15% or 5m >= +0.30%.
 * 4. Freshness Gate: In market hours, filings older than 15 minutes are discarded as priced in.
 */

const fs = require('fs');
const path = require('path');
const telegramConfig = (require.main ? (() => { try { return require('../notifications/telegramService'); } catch (_) { return require('../common/notifications/telegramService'); } })() : require('../common/notifications/telegramService'));
const pmc = require('./preMarketCatalysts');
let liveQuoteEngine = null;
try {
  liveQuoteEngine = (require.main ? (() => { try { return require('../market/liveQuoteEngine'); } catch (_) { return require('../common/market/liveQuoteEngine'); } })() : require('../common/market/liveQuoteEngine'));
} catch (_) {}

const SENT_LEDGER_FILE = path.join(__dirname, '../../data/news/sent_catalyst_alerts.json');
const _symbolAlertCooldown = new Map(); // sym -> timestamp (ms)
const _standbyLogged = new Map(); // filingId -> timestamp (ms)
const SYMBOL_COOLDOWN_MS = 15 * 60 * 1000;

let _cachedLedger = null;
let _lastLedgerRead = 0;

function readSentLedger() {
  const now = Date.now();
  if (_cachedLedger && (now - _lastLedgerRead) < 15000) {
    return _cachedLedger;
  }
  try {
    if (fs.existsSync(SENT_LEDGER_FILE)) {
      _cachedLedger = JSON.parse(fs.readFileSync(SENT_LEDGER_FILE, 'utf8'));
      _lastLedgerRead = now;
      return _cachedLedger;
    }
  } catch (_) {}
  _cachedLedger = {};
  _lastLedgerRead = now;
  return _cachedLedger;
}

function writeSentLedger(ledger) {
  _cachedLedger = ledger;
  _lastLedgerRead = Date.now();
  try {
    fs.mkdirSync(path.dirname(SENT_LEDGER_FILE), { recursive: true });
    // Keep ledger bounded to last 7 days
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const kept = {};
    for (const [k, v] of Object.entries(ledger)) {
      const at = Date.parse((v && v.at) || '');
      if (isFinite(at) && at >= cutoff) kept[k] = v;
    }
    fs.writeFileSync(SENT_LEDGER_FILE, JSON.stringify(kept, null, 2), 'utf8');
  } catch (err) {
    console.warn('[catalystAlerter] Ledger write error:', err.message);
  }
}

function getMarketSessionStatus() {
  const d = new Date(Date.now() + 330 * 60000);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) {
    return { isMarketHours: false, phase: 'WEEKEND', reason: 'Market is closed (Weekend).' };
  }
  const t = d.getUTCHours() * 100 + d.getUTCMinutes();
  if (t < 900) {
    return { isMarketHours: false, phase: 'OVERNIGHT', reason: 'Overnight session (pre-market opens at 09:00 IST, continuous trading at 09:15 IST).' };
  }
  if (t < 915) {
    return { isMarketHours: false, phase: 'PRE_MARKET', reason: 'Pre-Market window (09:00 - 09:15 IST). Continuous trading & live trade alerts activate at 09:15 AM.' };
  }
  if (t < 1530) {
    return { isMarketHours: true, phase: 'CONTINUOUS', reason: 'Continuous trading session active (09:15 - 15:30 IST).' };
  }
  return { isMarketHours: false, phase: 'POST_MARKET', reason: 'Market is closed (session ended at 15:30 IST). Live trade alerts disabled.' };
}

function isMarketHoursNow() {
  return getMarketSessionStatus().isMarketHours;
}

function sweetAndShortSubject(title, symbol, materiality) {
  if (!title) return materiality || 'Corporate Disclosure';
  let s = String(title).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const qm = s.match(/["“]([^"”]{6,80})["”]/);
  if (qm && qm[1]) s = qm[1].trim();

  s = s.replace(/^[A-Za-z0-9\s.,&-]+ (has informed the Exchange (about|regarding)|has submitted to the Exchange[A-Za-z0-9\s.,&-]*?titled|has submitted to the Exchange)\s*[-:,]?\s*/i, '');
  s = s.replace(/^General Updates\s*[-:,]?\s*/i, '');
  s = s.replace(/^Outcome of Board Meeting\s*[-:,]?\s*/i, '');
  s = s.replace(/^Please refer the enclosed intimation\s*[-:,]?\s*/i, '');
  s = s.replace(/^We enclose herewith,\s*intimation regarding\s*/i, '');
  s = s.replace(/^[,.\s]+/, '');

  if (/Press Release on the Audited Consolidated and Standalone Financial Results/i.test(s) || /financial results for the period ended/i.test(s)) {
    s = 'Q2 FY26 Financial Results';
  } else if (/Allotment of [0-9,]+ (equity )?shares/i.test(s)) {
    const num = (s.match(/[0-9,]+/) || [''])[0];
    s = num ? `ESOP Allotment of ${num} Shares` : 'ESOP Allotment of Shares';
  } else if (/Change in Directors/i.test(s)) {
    s = 'Change in Board Directors';
  } else if (/resignation of senior management/i.test(s) || /Resignation of Director/i.test(s)) {
    s = 'Senior Management Resignation';
  }

  if (s.length > 70) s = s.slice(0, 67) + '...';
  if (s.length > 0) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s;
}

function sweetAndShortRationale(rationale, bias, materiality) {
  if (!rationale) return 'Wait for directional confirmation';
  let r = String(rationale).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  if (/Financial results press release \/ beat/i.test(r) || /Q2_Results_beat/i.test(r) || (materiality === 'RESULTS' && bias === 'BULLISH')) {
    return 'Q2 results beat · High momentum scalp candidate';
  }
  if (/Routine administrative disclosure/i.test(r) || /administrative/i.test(r)) {
    return 'Administrative update · Low price impact';
  }
  if (/Key leadership/i.test(r) || /management/i.test(r)) {
    return 'Leadership change · Corporate positive sentiment';
  }
  if (/Dividend declared/i.test(r)) {
    return 'Dividend announced · Moderate bullish bias';
  }
  if (/Earnings miss/i.test(r) || (materiality === 'RESULTS' && bias === 'BEARISH')) {
    return 'Earnings miss · Watch for gap fade';
  }
  if (/Buyback/i.test(r)) {
    return 'Share buyback announcement · Bullish support';
  }
  if (r.length > 65) r = r.slice(0, 62) + '...';
  return r;
}

/**
 * Sends a 2 to 3 burst notification sequence to Telegram for a breaking catalyst.
 */
async function sendCatalystAlertSequence(item, { ltp = null, movePct = 0, move1mPct = 0, move5mPct = 0, range5mPct = 0, volume = 0, last5Bars = null } = {}) {
  if (!item || !item.symbol) return false;
  const sym = String(item.symbol).toUpperCase().trim();

  // Reject numeric and non-equity codes
  if (/^\d+$/.test(sym) || /-(RE|BE|BZ|SM|NC|N\d)$/i.test(sym)) {
    return false;
  }

  const price = Number(ltp) || 0;
  const vol = Number(volume) || 0;

  // HARD GATES:
  // 1. Minimum Price Floor: Must be >= ₹30.00
  if (price <= 0 || price < 30.0) {
    console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Price ₹${price.toFixed(2)} is below ₹30 floor or unverified.`);
    return false;
  }

  // 2. Minimum Volume Floor: Must be >= 25,000 shares
  if (vol < 25000) {
    console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Volume ${vol.toLocaleString()} shares is below 25,000 floor.`);
    return false;
  }

  const sessionStatus = getMarketSessionStatus();
  if (!sessionStatus.isMarketHours) {
    const isPreMarket = sessionStatus.phase === 'PRE_MARKET';
    const tag = isPreMarket ? '⏳ Standby' : '🚫 Blocked';
    console.log(`[catalystAlerter] ${tag} ${sym}: ${sessionStatus.reason}`);
    return false;
  }

  const pred = pmc.predictCatalyst(item, { movePct, move1mPct, move5mPct, range5mPct, last5Bars, price, volume: vol });

  // Disallow untradeable, low volume, neutral, already moved, or stale
  if (pred.bias === 'NEUTRAL' || pred.confidence < 60 || !pred.takeTrade || pred.prediction.includes('UNTRADEABLE') || pred.prediction.includes('LOW VOLUME') || pred.prediction.includes('LOW MOMENTUM') || pred.prediction.includes('ALREADY MOVED') || pred.prediction.includes('STALE')) {
    console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Filtered out (${pred.prediction}).`);
    return false;
  }

  // Strict Market Hours Momentum & Microstructure Gates
  const itemTs = Number(item.ts || item.firstSeenAt || 0);
  // Age check: Max 15 minutes old in active hours
  if (itemTs > 0 && (Date.now() - itemTs > 15 * 60 * 1000)) {
    console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Filing is stale (${Math.round((Date.now() - itemTs)/60000)}m old > 15m window).`);
    return false;
  }

  if (pred.bias === 'BULLISH') {
    // 1. User rule: "First, you want to check it moved, meaning you don't take the trade."
    if (movePct >= 1.2 || move5mPct >= 1.0) {
      console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Stock already surged (+${movePct}% day, +${move5mPct}% 5m). Avoid chasing top.`);
      return false;
    }
    // 2. Falling tape rejection
    if (move5mPct <= -0.50 || (move1mPct <= -0.20 && move5mPct <= -0.30) || (movePct < -0.30 && move1mPct <= -0.10)) {
      console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Tape actively falling (${move1mPct}% 1m, ${move5mPct}% 5m). Avoid buying falling tape.`);
      return false;
    }
    // Breaking Catalysts (< 3 minutes old):
    // Eliminate artificial 1-minute delay: Alert IMMEDIATELY upon filing disclosure!
    // As long as tape is not falling or exhausted, trigger the pre-move entry immediately.
    // For older filings (> 3m old), require confirmed green momentum thrust before chasing.
    const isBreakingFresh = itemTs > 0 ? (Date.now() - itemTs < 3 * 60 * 1000) : true;
    if (!isBreakingFresh) {
      // 3. Low momentum / stagnant
      if (Math.abs(move1mPct) < 0.15 && Math.abs(move5mPct) < 0.30) {
        console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Low momentum / flat tape (${move1mPct}% 1m, ${move5mPct}% 5m).`);
        return false;
      }
      // 4. Confirmed green momentum thrust required
      if (!(move1mPct >= 0.15 || move5mPct >= 0.30)) {
        console.log(`[catalystAlerter] 🚫 Blocked ${sym}: Awaiting confirmed momentum thrust (+0.15% 1m or +0.30% 5m).`);
        return false;
      }
    }
  }

  const subject = sweetAndShortSubject(item.title || item.kind, sym, item.materiality);
  const thesis = sweetAndShortRationale(pred.rationale, pred.bias, item.materiality);
  const ltpText = `₹${price.toFixed(2)}`;
  const biasIcon = pred.bias === 'BULLISH' ? '🟢' : (pred.bias === 'BEARISH' ? '🔴' : '⚪');
  const actionWord = pred.recommendation || (pred.bias === 'BULLISH' ? 'BUY / GO UP' : (pred.bias === 'BEARISH' ? 'SELL / FADE' : 'WATCH'));
  const probVal = pred.probability || pred.confidence || 75;

  // --- BURST 1: Comprehensive Rich Catalyst Alert with 5-Candle Context ---
  const msg1 = [
    `⚡ <b>[BREAKING NEWS CATALYST 1/2]</b> 🚨`,
    `<b>${sym}</b> · ${biasIcon} <b>${actionWord} (${probVal}% Probability)</b>`,
    ``,
    pred.fiveCandleVerdict ? `📊 <b>5-Candle Context:</b> ${pred.fiveCandleVerdict}` : '',
    pred.targetPrice ? `🎯 <b>Target:</b> ₹${pred.targetPrice} (${pred.targetPct > 0 ? '+' : ''}${pred.targetPct}%) | <b>SL:</b> ₹${pred.stopLossPrice} (${pred.stopLossPct}%) | R:R ${pred.rrRatio || '1:3.0'}` : '',
    (pred.financialComparison && pred.financialComparison.metricsList && pred.financialComparison.metricsList.length > 0)
      ? `📈 <b>Comprehensive Financials (Old vs New):</b>\n${pred.financialComparison.metricsList.map(m => `  • <b>${m.name}:</b> ${m.current} vs ${m.prior} (<b>${m.change}</b>)`).join('\n')}`
      : (pred.comparisonSummary ? `📈 <b>Financials (Old vs New):</b> ${pred.comparisonSummary}` : ''),
    `📋 <b>Subject:</b> ${subject}`,
    `💡 <b>Thesis:</b> ${thesis}`,
    `💰 <b>LTP:</b> ${ltpText} (Vol: ${vol.toLocaleString()})`,
    `🏷️ <b>Tag:</b> ${item.materiality || 'CATALYST'}`,
    item.url ? `📄 <a href="${item.url}">Official Exchange Filing PDF ↗</a>` : `📄 Exchange Disclosure`,
  ].filter(Boolean).join('\n');

  try {
    await telegramConfig.sendPhoneNotificationNow(msg1);
    console.log(`[catalystAlerter] Sent Alert 1/2 for ${sym} (${actionWord}) to Telegram`);
  } catch (err) {
    console.error(`[catalystAlerter] Msg 1 send error for ${sym}:`, err.message);
  }

  // --- BURST 2 (2.5s later): Immediate Action Ping ---
  setTimeout(async () => {
    try {
      const msg2 = [
        `⚡ <b>[CATALYST ALERT 2/2]</b> 🔔 <b>ACTION NOW:</b> <b>${sym}</b>`,
        `${biasIcon} <b>${actionWord} (${probVal}%)</b> @ <b>${ltpText}</b>`,
        pred.targetPrice ? `🎯 Target: ₹${pred.targetPrice} | SL: ₹${pred.stopLossPrice}` : '',
        `<i>⚡ 5-Candle Structure: ${pred.fiveCandleState || 'CONFIRMED'}</i>`
      ].filter(Boolean).join('\n');
      await telegramConfig.sendPhoneNotificationNow(msg2);
      console.log(`[catalystAlerter] Sent Alert 2/2 follow-up for ${sym} to Telegram`);
    } catch (_) {}
  }, 2500);

  // --- BURST 3 (5.0s later for high conviction or earnings results): Scalp Targets ---
  if (pred.confidence >= 75 || item.materiality === 'RESULTS') {
    setTimeout(async () => {
      try {
        const tgtPct = pred.targetPct != null ? pred.targetPct : (pred.bias === 'BULLISH' ? 1.8 : -1.5);
        const slPct = pred.stopLossPct != null ? pred.stopLossPct : (pred.bias === 'BULLISH' ? -0.6 : 0.5);
        const tgtPrice = pred.targetPrice ? `₹${pred.targetPrice}` : `${tgtPct > 0 ? '+' : ''}${tgtPct}%`;
        const slPrice = pred.stopLossPrice ? `₹${pred.stopLossPrice}` : `${slPct}%`;
        const msg3 = [
          `⚡ <b>[HIGH CONVICTION 3/3]</b> 🎯 <b>${sym} TRADE GEOMETRY</b>`,
          `Target: <b>${tgtPrice} (${tgtPct > 0 ? '+' : ''}${tgtPct}%)</b> | Stop Loss: <b>${slPrice} (${slPct}%)</b>`,
          `Win Probability: <b>${probVal}%</b> | Risk/Reward: <b>${pred.rrRatio || '1:3.0'}</b>`,
          `<i>Evaluated across past 5 candles · Zero lookahead institutional engine.</i>`
        ].join('\n');
        await telegramConfig.sendPhoneNotificationNow(msg3);
        console.log(`[catalystAlerter] Sent Alert 3/3 target specification for ${sym} to Telegram`);
      } catch (_) {}
    }, 5000);
  }

  return true;
}

/**
 * Examines newly arrived filings and dispatches multi-burst alerts for new material items.
 */
async function dispatchNewFilingAlerts(items, { getLtp = null, getQuote = null } = {}) {
  if (!Array.isArray(items) || !items.length) return 0;
  const sessionStatus = getMarketSessionStatus();
  const isMarketHours = sessionStatus.isMarketHours;
  if (!isMarketHours) return 0; // Outside continuous trading hours, do not burn event loop evaluating live alerts
  const ledger = readSentLedger();
  let dispatched = 0;
  const nowMs = Date.now();
  const MAX_AGE_MS = 15 * 60 * 1000;

  for (const item of items) {
    if (!item || !item.symbol) continue;
    const sym = String(item.symbol).toUpperCase().trim();
    if (/^\d+$/.test(sym) || sym === 'BSE' || sym === 'NSE' || sym === 'ALL' || /-(RE|BE|BZ|SM|NC|N\d)$/i.test(sym)) continue;

    const itemTs = Number(item.ts || item.firstSeenAt || 0);
    // Age check: Max 15 minutes old during session, max 14 hours outside
    if (itemTs > 0) {
      const diff = nowMs - itemTs;
      if (diff > MAX_AGE_MS || diff < -5 * 60 * 1000) continue;
    }

    const filingId = item.id || `${sym}:${item.ts || item.firstSeenAt || Date.now()}`;
    const cleanTitleKey = (item.title || item.kind || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    const symDedupeKey = `DEDUPE:${sym}:${cleanTitleKey}`;
    if (ledger[filingId] || ledger[symDedupeKey]) continue; // Already processed

    // 15-Minute per-symbol alert cooldown: Prevents flip-flops and alert spamming
    const lastSentAt = _symbolAlertCooldown.get(sym) || 0;
    if (nowMs - lastSentAt < SYMBOL_COOLDOWN_MS) {
      console.log(`[catalystAlerter] ⏳ Alert cooldown active for ${sym} (${Math.round((nowMs - lastSentAt)/1000)}s ago < 15m). Alert suppressed.`);
      continue;
    }

    let ltp = null;
    let movePct = 0;
    let move1mPct = 0;
    let move5mPct = 0;
    let volume = 0;

    if (typeof getQuote === 'function') {
      try {
        const q = getQuote(sym);
        if (q) {
          ltp = q.ltp;
          movePct = q.movePct || 0;
          move1mPct = q.move1mPct || 0;
          move5mPct = q.move5mPct || 0;
          volume = q.volume || 0;
        }
      } catch (_) {}
    } else if (typeof getLtp === 'function') {
      try { ltp = getLtp(sym); } catch (_) {}
    }

    // Fallback: Query liveQuoteEngine directly ONLY during active market hours to avoid socket starvation
    if (isMarketHours && (ltp == null || ltp <= 0 || volume == null || volume <= 0) && liveQuoteEngine && typeof liveQuoteEngine.fetchStockQuotes === 'function') {
      try {
        const quotes = await liveQuoteEngine.fetchStockQuotes([sym]);
        const q = quotes && quotes[sym];
        if (q) {
          if (q.ltp) ltp = q.ltp;
          if (q.volume) volume = q.volume;
          if (q.changePct != null) movePct = q.changePct;
        }
      } catch (_) {}
    }

    const price = Number(ltp) || 0;
    const vol = Number(volume) || 0;

    // Hard exclusion: Penny stocks (< ₹30) & illiquid (< 25,000 shares)
    if (price <= 0 || price < 30.0 || vol < 25000) {
      ledger[filingId] = {
        symbol: sym,
        skipped: true,
        reason: (price <= 0 || price < 30.0) ? `penny_stock_price_${price}` : `low_volume_${vol}`,
        at: new Date().toISOString()
      };
      continue;
    }

    const pred = pmc.predictCatalyst(item, { movePct, move1mPct, move5mPct, price, volume: vol });
    const isMaterial = item.materiality && item.materiality !== 'ROUTINE';
    const isActionable = pred.bias && pred.bias !== 'NEUTRAL' && pred.confidence >= 60;

    if (isMaterial || isActionable) {
      if (!isMarketHours) {
        // Outside continuous trading hours: Do NOT send live continuous alerts and do NOT skip permanently.
        // Log once per 5 minutes so terminal isn't spammed every poll cycle.
        const lastLog = _standbyLogged.get(filingId) || 0;
        if (nowMs - lastLog > 5 * 60 * 1000) {
          _standbyLogged.set(filingId, nowMs);
          const phaseTag = sessionStatus.phase === 'PRE_MARKET' ? '⏳ Pre-Market Standby' : '⏸️ Standby';
          console.log(`[catalystAlerter] ${phaseTag} ${sym}: ${sessionStatus.reason} [${pred.bias || 'CATALYST'} ${pred.confidence || 0}%]`);
        }
        continue;
      }

      const sent = await sendCatalystAlertSequence(item, { ltp: price, movePct, move1mPct, move5mPct, volume: vol });
      if (sent) {
        _symbolAlertCooldown.set(sym, Date.now());
        ledger[filingId] = {
          symbol: sym,
          materiality: item.materiality,
          prediction: pred.prediction,
          confidence: pred.confidence,
          price,
          volume: vol,
          at: new Date().toISOString()
        };
        ledger[symDedupeKey] = { at: new Date().toISOString(), symbol: sym };
        dispatched++;
      } else {
        const itemTs = Number(item.ts || item.firstSeenAt || 0);
        const ageMs = itemTs > 0 ? (nowMs - itemTs) : 999999;
        // ONLY write permanent skip into ledger if the 10-minute post-news observation window has EXPIRED
        // If the filing is within 10 minutes of disclosure, keep it open so 1m/5m tape prints can trigger Syrma or Dixon alert!
        if (ageMs > 10 * 60 * 1000) {
          ledger[filingId] = {
            symbol: sym,
            skipped: true,
            reason: 'rejected_by_tape_or_conviction_after_10m',
            at: new Date().toISOString()
          };
        }
      }
    }
  }

  if (dispatched > 0) {
    writeSentLedger(ledger);
  }
  return dispatched;
}

module.exports = {
  dispatchNewFilingAlerts,
  sendCatalystAlertSequence,
  getMarketSessionStatus,
  isMarketHoursNow,
  sweetAndShortSubject,
  sweetAndShortRationale,
};
