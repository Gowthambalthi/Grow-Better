'use strict';

/**
 * common/news/moveTimingAI.js
 * 
 * Machine Learning & Orderflow Timing Intelligence:
 * 1. Analyzes at which minute the stock moved today (Pre-News vs Post-News).
 * 2. Detects Pre-News Leakage / Front-Running (e.g. stock moved +3.6% BEFORE disclosure).
 * 3. Prevents after-market filings (>= 15:30 IST) from falsely showing intraday day moves as post-news moves.
 */

function analyzeMoveTiming(c, q = null) {
  const ltp = Number(q?.ltp || c.ltp || c.price || c.effectivePrice || 0);
  const open = Number(q?.open || c.open || 0);
  const priceAtFiling = Number(c.priceAtFiling || 0);
  const dayMovePct = Number(q?.changePct != null ? q.changePct : (c.movePct != null ? c.movePct : (open > 0 && ltp > 0 ? (((ltp - open) / open) * 100) : 0)));

  const nowMs = Date.now();
  const nowIst = new Date(nowMs + 330 * 60000);
  const nowHourMin = nowIst.getUTCHours() * 100 + nowIst.getUTCMinutes();
  const nowDay = nowIst.getUTCDay();
  const isMarketOpenNow = (nowDay >= 1 && nowDay <= 5 && nowHourMin >= 915 && nowHourMin < 1530);

  const tsNum = Number(c.ts || c.firstSeenAt || nowMs);
  const dIst = new Date(tsNum + 330 * 60000);
  const tNum = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();
  const isOvernightOrPreMarket = (tNum >= 1530 || tNum < 915);

  let postNewsMovePct = 0;
  let preNewsMovePct = 0;

  if (isOvernightOrPreMarket) {
    if (!isMarketOpenNow) {
      // Cash market is closed; waiting for 09:15 open
      postNewsMovePct = 0;
      preNewsMovePct = 0;
    } else {
      // Cash market is OPEN! For pre-market/overnight announcements,
      // the entire session move today IS the post-news reaction to the disclosure!
      postNewsMovePct = Number(c.postNewsMovePct != null && Math.abs(c.postNewsMovePct) >= 0.01
        ? c.postNewsMovePct
        : dayMovePct);
      preNewsMovePct = 0;
    }
  } else {
    // Intraday filing disclosed during active market hours
    postNewsMovePct = Number(c.postNewsMovePct != null
      ? c.postNewsMovePct
      : (priceAtFiling > 0 && ltp > 0 ? (((ltp - priceAtFiling) / priceAtFiling) * 100) : 0));

    if (open > 0 && priceAtFiling > 0) {
      preNewsMovePct = +(((priceAtFiling - open) / open) * 100).toFixed(2);
    } else if (dayMovePct != null && postNewsMovePct != null) {
      preNewsMovePct = +(dayMovePct - postNewsMovePct).toFixed(2);
    }
  }

  const ageMin = Math.max(0, Math.round((nowMs - tsNum) / 60000));

  // AI Timing Diagnosis
  let timingCategory = 'FRESH_UNPRICED';
  let badgeLabel = '0.0% After News';
  let badgeColor = '#64748b';
  let badgeBg = 'rgba(100, 116, 139, 0.12)';
  let badgeBorder = 'rgba(100, 116, 139, 0.25)';
  let timingDetail = 'Stock has not moved post-news.';

  const absPost = Math.abs(postNewsMovePct);
  const absPre = Math.abs(preNewsMovePct);

  if (isOvernightOrPreMarket && !isMarketOpenNow) {
    timingCategory = 'POST_CLOSE';
    badgeLabel = '0.0% After News';
    badgeColor = '#64748b';
    badgeBg = 'rgba(100, 116, 139, 0.12)';
    badgeBorder = 'rgba(100, 116, 139, 0.25)';
    timingDetail = `Filed after market hours (${c.filingTime || 'pre-open'}). Cash market is closed; 0.0% move.`;
  } else if (absPost >= 0.50) {
    const postSign = postNewsMovePct > 0 ? '+' : '';
    timingCategory = postNewsMovePct > 0 ? 'POST_NEWS_BURST' : 'POST_NEWS_DUMP';
    badgeLabel = `${postSign}${postNewsMovePct.toFixed(1)}% After News`;
    badgeColor = postNewsMovePct > 0 ? '#16a34a' : '#dc2626';
    badgeBg = postNewsMovePct > 0 ? 'rgba(22, 163, 74, 0.15)' : 'rgba(220, 38, 38, 0.15)';
    badgeBorder = postNewsMovePct > 0 ? 'rgba(22, 163, 74, 0.35)' : 'rgba(220, 38, 38, 0.35)';
    timingDetail = `${postSign}${postNewsMovePct.toFixed(2)}% reaction since ${isOvernightOrPreMarket ? '09:15 open' : c.filingTime || 'filing'}.`;
  } else if (preNewsMovePct >= 1.50 && absPost < 0.40) {
    timingCategory = 'PRE_RUN_LEAKAGE';
    badgeLabel = `🚨 Pre-Moved +${preNewsMovePct.toFixed(1)}% (Priced In)`;
    badgeColor = '#d97706';
    badgeBg = 'rgba(217, 119, 6, 0.15)';
    badgeBorder = 'rgba(217, 119, 6, 0.4)';
    timingDetail = `Stock rallied +${preNewsMovePct.toFixed(1)}% today before announcement arrived. News was already leaked/priced in; do not chase at highs.`;
  } else if (preNewsMovePct <= -1.50 && absPost < 0.40) {
    timingCategory = 'PRE_DUMP_LEAKAGE';
    badgeLabel = `📉 Pre-Dump -${Math.abs(preNewsMovePct).toFixed(1)}% (Before News)`;
    badgeColor = '#b91c1c';
    badgeBg = 'rgba(185, 28, 28, 0.15)';
    badgeBorder = 'rgba(185, 28, 28, 0.4)';
    timingDetail = `Stock fell -${Math.abs(preNewsMovePct).toFixed(1)}% prior to disclosure. Bad news was already active on tape.`;
  } else {
    timingCategory = 'FRESH_UNPRICED';
    badgeLabel = '0.0% After News';
    badgeColor = '#64748b';
    badgeBg = 'rgba(100, 116, 139, 0.12)';
    badgeBorder = 'rgba(100, 116, 139, 0.25)';
    timingDetail = `Unpriced catalyst filed at ${c.filingTime || 'session'}. Stock has not moved yet.`;
  }

  return {
    preNewsMovePct,
    postNewsMovePct: +postNewsMovePct.toFixed(2),
    dayMovePct: +dayMovePct.toFixed(2),
    timingCategory,
    badgeLabel,
    badgeColor,
    badgeBg,
    badgeBorder,
    timingDetail,
    ageMin
  };
}

module.exports = {
  analyzeMoveTiming
};
