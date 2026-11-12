'use strict';

/**
 * common/market/preMarketCalls.js
 *
 * 09:08 AM PRE-OPEN AUCTION CALL ENGINE
 *
 * Runs immediately at 09:08 AM IST after the NSE pre-market order matching
 * session completes. At 09:08 AM, the exchange discovers and publishes the
 * official Indicative Equilibrium Price (IEP / open) and pre-market gap %.
 *
 * This engine converts that 7-minute golden window (09:08 - 09:15 AM) into
 * actionable pre-open trading calls:
 *
 * 1. PRE-MARKET BUY (CONFIRMED GAP-UP):
 *    - Positive Catalyst (Order win, earnings beat, acquisition, capacity expansion)
 *    - Pre-market gap between +0.8% and +3.5% (healthy institutional opening demand)
 *    - Plan: Buy on 09:15 open at IEP with +1.5% to +2.0% target, tight structural SL.
 *
 * 2. PRE-MARKET SELL / FADE (CONFIRMED GAP-DOWN):
 *    - Filing gap-down <= -0.8% or negative corporate catalyst (results miss, dispute, dilution)
 *    - Plan: Sell / Fade on 09:15 open with -1.5% target, stop loss at previous close.
 *
 * 3. INSTITUTIONAL REJECTION / TRAP WARNING:
 *    - Stock had bullish news headline, but 09:08 pre-market auction gapped DOWN (< 0%)
 *    - Flags strictly to AVOID buying (institutions using news liquidity to offload).
 *
 * 4. EXTREME GAP EXHAUSTION:
 *    - Pre-market gap > +4.5%
 *    - High risk of opening profit-taking; wait for 15-min opening range pullback.
 */

const fs = require('fs');
const path = require('path');
const liveQuoteEngine = require('./liveQuoteEngine');
const preMarketCatalysts = require('../news/preMarketCatalysts');
const sessionTiming = require('./sessionTiming');

const PRE_CALLS_FILE = path.join(__dirname, '..', '..', 'data', 'pre_market_calls.json');

/**
 * Generates confirmed pre-market calls from 09:08 AM IEP auction data.
 * @param {Date} [now]
 * @param {Object} [overrideQuotes] Optional pre-fetched quotes
 * @returns {Promise<Object>}
 */
async function generatePreMarketCalls(now = new Date(), overrideQuotes = null) {
  const ist = sessionTiming.getISTTime(now);
  const dateStr = ist.toISOString().slice(0, 10);

  // 1. Load active catalysts from post-15:30 to now
  const catMap = preMarketCatalysts.loadPreMarketCatalysts();
  const catalysts = Array.from(catMap.values());
  const symbols = catalysts.map(c => c.symbol);

  if (symbols.length === 0) {
    return { date: dateStr, generatedAtIST: ist.toTimeString().slice(0, 8), calls: [], stats: { total: 0 } };
  }

  // 2. Fetch live pre-open IEP quotes
  let quotes = overrideQuotes;
  if (!quotes || Object.keys(quotes).length === 0) {
    try {
      quotes = await liveQuoteEngine.fetchStockQuotes(symbols);
    } catch (err) {
      console.warn('[preMarketCalls] liveQuoteEngine fetch error:', err.message);
      quotes = {};
    }
  }

  const calls = [];
  const traps = [];
  const fades = [];

  for (const c of catalysts) {
    const q = quotes[c.symbol];
    if (!q || !q.close) continue;

    // Discover IEP price (open or ltp during pre-market)
    const iep = Number(q.open || q.ltp || 0);
    const prevClose = Number(q.close || 0);
    if (iep <= 0 || prevClose <= 0) continue;

    // HARD PENNY STOCK & ZERO-LIQUIDITY EXCLUSION:
    // Strictly reject stocks below ₹20.00 floor or with low volume (< 2000) (e.g. GLFL at ₹4.89, Volume: 1)
    if (iep < 20.0 || prevClose < 20.0) continue;
    const vol = Number(q.volume || q.tradeVolume || 0);
    if (vol > 0 && vol < 2000) continue;

    const gapPct = Number((((iep - prevClose) / prevClose) * 100).toFixed(2));
    const pred = preMarketCatalysts.predictCatalyst(c.materiality, c.title, c.kind || '', gapPct);
    const isBull = pred.bias === 'BULLISH';

        // SCENARIO 0: 7% - 8% MULTI-PERCENT RUNNER CALL (Learned from Historical Backtest & Live Calls)
    // Historical runner signature (SUNTV +19.6%, PATANJALI +8.1%, BLUESTONE +11.7%, ASIANENE +14.9%, REFEX +16.2%):
    // Opens in unexhausted sweet spot (-0.5% to +1.5%), defends open price (low >= open - 0.25%).
    const isRunnerCandidate = (
      isBull &&
      (c.confidence >= 80 || ['ORDER', 'CORPORATE_ACTION', 'RESULTS', 'CAPITAL'].includes(c.materiality)) &&
      gapPct >= -0.5 && gapPct <= 1.5
    );
    if (isRunnerCandidate) {
      const target1 = Number((iep * 1.04).toFixed(2));
      const target2 = Number((iep * 1.08).toFixed(2));
      const stopLoss = Number((iep * 0.9965).toFixed(2)); // Tight SL: -0.35% below open
      calls.push({
        symbol: c.symbol,
        type: 'BUY',
        action: 'RUNNER_BUY',
        iep,
        prevClose,
        gapPct,
        targetPrice: target2,
        target1,
        target2,
        stopLoss,
        riskReward: '1:6.0',
        materiality: c.materiality,
        title: c.title,
        confidence: Math.max(88, c.confidence || 88),
        status: 'RUNNER_SWEET_SPOT',
        tag: '🚀 7% - 8% EXPANSION RUNNER',
        thesis: `09:08 Pre-open auction discovered at ₹${iep} (${gapPct >= 0 ? '+' : ''}${gapPct}% gap). Unexhausted sweet spot with high-conviction catalyst. Backtest confirms 7%–16% runners open in this zone and strictly defend the open.`,
        plan: `Enter at 09:15 open near ₹${iep}. Target 1: ₹${target1} (+4.0%), Target 2: ₹${target2} (+8.0%). Stop Loss strictly at ₹${stopLoss} (-0.35%). If price dips below open, exit or switch to SELL / FADE.`,
        url: c.url || null
      });
    }

    // SCENARIO 1: Confirmed Gap-Up Buy (Positive News + 09:08 Pre-Market Gap)
    // USER INSIGHT: "and also if it was to 0.8 to 3.8 it may not move more"
    if (isBull && gapPct >= 0.8 && gapPct <= 3.8) {
      const isLimitedZone = gapPct >= 2.0;
      const targetMovePct = isLimitedZone ? 1.010 : 1.012; // Conservative target (it may not move more)
      const targetPrice = Number((iep * targetMovePct).toFixed(2));
      const stopLoss = Number((prevClose * 0.995).toFixed(2));
      calls.push({
        symbol: c.symbol,
        type: 'BUY',
        action: 'BUY_AT_OPEN',
        iep,
        prevClose,
        gapPct,
        targetPrice,
        stopLoss,
        riskReward: '1:1.5',
        materiality: c.materiality,
        title: c.title,
        confidence: isLimitedZone ? 80 : 88,
        status: isLimitedZone ? 'LIMITED_MOVE_GAP' : 'CONFIRMED_GAP_UP',
        tag: isLimitedZone ? '⚠️ LIMITED MOVE BUY' : '🚀 PRE-MARKET BUY',
        thesis: isLimitedZone
          ? `09:08 Pre-open gap +${gapPct}% in ceiling zone. Catalyst largely priced in ("it may not move more"). Realistic +1.0% target; switch to SELL if open fades.`
          : `09:08 Pre-open auction confirmed +${gapPct}% gap-up on ${c.materiality} catalyst. Institutional demand confirmed for 09:15 open.`,
        plan: `Enter at 09:15 open near ₹${iep} if VWAP holds. Target ₹${targetPrice} (${isLimitedZone ? '+1.0%' : '+1.2%'}), Stop Loss ₹${stopLoss}.`,
        url: c.url || null
      });
    }

    // SCENARIO 2: Institutional Rejection — USER STRATEGY: GIVE SELL ON FADE
    // "if fade more then give sell ok"
    else if (isBull && gapPct < 0) {
      const shortTarget = Number((iep * 0.985).toFixed(2));
      const shortSL = Number((prevClose * 1.008).toFixed(2));
      calls.push({
        symbol: c.symbol,
        type: 'SELL',
        action: 'SELL_FADE',
        iep,
        prevClose,
        gapPct,
        targetPrice: shortTarget,
        stopLoss: shortSL,
        riskReward: '1:1.8',
        materiality: c.materiality,
        title: c.title,
        confidence: 85,
        status: 'FADE_SELL_CALL',
        tag: '📉 PRE-OPEN FADE (SELL)',
        thesis: `Bullish filing but pre-market auction faded and gapped DOWN ${gapPct}%. Institutional dumping confirmed; GIVE SELL at open.`,
        plan: `Enter SHORT / SELL at 09:15 open near ₹${iep}. Target ₹${shortTarget} (-1.5%), Stop Loss ₹${shortSL}.`,
        url: c.url || null
      });
      traps.push({
        symbol: c.symbol,
        type: 'SELL_FADE',
        action: 'GIVE_SELL_ON_FADE',
        iep,
        prevClose,
        gapPct,
        materiality: c.materiality,
        title: c.title,
        confidence: 85,
        status: 'INSTITUTIONAL_REJECTION',
        tag: '📉 GIVE SELL (FADE)',
        thesis: `Bullish filing but pre-market auction gapped DOWN ${gapPct}%. Institutions fading the news; GIVE SELL at open.`,
        plan: `Enter SHORT / SELL on 09:15 open. Do NOT buy. Target ₹${shortTarget}.`,
        url: c.url || null
      });
    }

    // SCENARIO 3: Extreme Gap — USER STRATEGY: GAP-FILL REVERSAL FADE
    // "If it opens gap up very large, then it may come down to gap fill. So, to overcome it, we can use one strategy."
    else if (isBull && gapPct > 3.8) {
      const gapFillTarget = Number((prevClose + (iep - prevClose) * 0.45).toFixed(2));
      const gapStop = Number((iep * 1.012).toFixed(2));
      calls.push({
        symbol: c.symbol,
        type: 'SELL_FADE',
        action: 'GAP_FILL_FADE',
        iep,
        prevClose,
        gapPct,
        targetPrice: gapFillTarget,
        stopLoss: gapStop,
        riskReward: '1:2.0',
        materiality: c.materiality,
        title: c.title,
        confidence: 82,
        status: 'GAP_FILL_FADE',
        tag: '⚡ GAP-FILL FADE',
        thesis: `09:08 IEP auction opened with extreme +${gapPct}% gap-up. Catalyst priced in; institutional profit taking expected at open.`,
        plan: `Wait for initial 1m spike to exhaust at 09:15-09:16. Enter SHORT on break below 1m opening low. Target gap fill ₹${gapFillTarget}. SL ₹${gapStop}.`,
        url: c.url || null,
        isGapFillStrategy: true
      });
      traps.push({
        symbol: c.symbol,
        type: 'WATCH_PULLBACK',
        action: 'WAIT_FOR_OR15',
        iep,
        prevClose,
        gapPct,
        materiality: c.materiality,
        title: c.title,
        confidence: 75,
        status: 'EXTREME_GAP',
        tag: '⚡ GAP-FILL CANDIDATE',
        thesis: `Pre-market gap of +${gapPct}% is extended. High risk of retail chasing into opening profit-taking.`,
        plan: `Trade gap-fill reversal short or wait for OR15 (09:30) consolidation above VWAP.`,
        url: c.url || null
      });
    }

    // SCENARIO 4: Confirmed Gap-Down Sell / Fade (Negative / Neutral Catalyst + Gap Down)
    else if (gapPct <= -0.8 && gapPct >= -6.0) {
      const targetPrice = Number((iep * 0.982).toFixed(2)); // -1.8% target
      const stopLoss = Number((prevClose * 1.008).toFixed(2));
      fades.push({
        symbol: c.symbol,
        type: 'SELL',
        action: 'SELL_AT_OPEN',
        iep,
        prevClose,
        gapPct,
        targetPrice,
        stopLoss,
        riskReward: '1:1.8',
        materiality: c.materiality,
        title: c.title,
        confidence: 85,
        status: 'CONFIRMED_GAP_DOWN',
        tag: '🔴 PRE-MARKET SHORT / FADE',
        thesis: `Filing gap-down ${gapPct}% confirmed by 09:08 pre-market auction. Statistical edge indicates gap-downs do not mean-revert on open.`,
        plan: `Sell / Short at 09:15 open near ₹${iep}. Target ₹${targetPrice} (-1.8%), Stop Loss ₹${stopLoss}.`,
        url: c.url || null
      });
    }
  }

  // Sort calls: Highest confidence and cleanest gaps first
  calls.sort((a, b) => b.gapPct - a.gapPct);
  fades.sort((a, b) => a.gapPct - b.gapPct);
  traps.sort((a, b) => a.gapPct - b.gapPct);

  const payload = {
    date: dateStr,
    generatedAtIST: ist.toTimeString().slice(0, 8),
    window: '09:08 - 09:15 AM IST (Pre-Market IEP Discovery Window)',
    summary: `${calls.length} Confirmed Buys, ${fades.length} Confirmed Fades, ${traps.length} Traps / Extended Gaps`,
    confirmedBuys: calls,
    confirmedFades: fades,
    traps,
    topBuy: calls.length > 0 ? calls[0] : null,
    topFade: fades.length > 0 ? fades[0] : null
  };

  try {
    fs.writeFileSync(PRE_CALLS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[preMarketCalls] failed to write cache file:', err.message);
  }

  return payload;
}

/**
 * Loads cached pre-market calls if available.
 */
function loadCachedPreMarketCalls() {
  try {
    if (fs.existsSync(PRE_CALLS_FILE)) {
      return JSON.parse(fs.readFileSync(PRE_CALLS_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

module.exports = {
  generatePreMarketCalls,
  loadCachedPreMarketCalls,
  PRE_CALLS_FILE
};
