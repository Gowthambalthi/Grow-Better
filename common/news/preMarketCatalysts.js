'use strict';



/**

 * common/news/preMarketCatalysts.js

 *

 * PRE-MARKET NEWS CATALYST DETECTOR (09:15 - 09:30 Window Engine).

 *

 * Identifies stocks that announced high-impact corporate filings between the

 * previous session's close (15:30 IST) and today's market open (09:15 IST).

 *

 * Supported Materiality Classes:

 *   - RESULTS: Quarterly financial results, earnings beats, profit jumps

 *   - ORDER: Contract awards, bagging orders, government tenders

 *   - CORPORATE_ACTION: Acquisitions, mergers, demergers, strategic stake buys

 *   - CAPITAL: QIP allotments, fund-raising, rights issues, bonus/dividends

 *   - MANAGEMENT: MD/CEO appointments, executive leadership changes

 *   - RATING: Credit rating upgrades

 *

 * Rules:

 *   1. Filters out routine administrative filings (trading window, routine disclosures).

 *   2. Enforces Gap-Down Exclusion (filingExclusion.js): If stock gapped down <= -1.0%,

 *      long entries are strictly refused to avoid buying into earnings disaster traps.

 *   3. Qualifies high-catalyst stocks for early 09:15 - 09:30 execution window

 *      in GROW SCALPING (GS05 Impulse-Dip-Resume & GS01 Micro Thrust).

 */



const fs = require('fs');

const path = require('path');

const flashNews = require('./flashNews');

const filingExclusion = require('./filingExclusion');

const financialComparison = require('./financialComparison');

let sessionTiming = null;
try {
  sessionTiming = require('../market/sessionTiming');
} catch (_) {
  try {
    sessionTiming = require('../../common/market/sessionTiming');
  } catch (__) {}
}



let historicalLearner = null;

try {

  historicalLearner = require('./historicalReactionLearner');

} catch (_) {}

let autoLearner = null;
try {
  autoLearner = require('./autoCatalystLearner');
} catch (_) {}



let newsMl = null;

try {

  newsMl = require('./newsMl');

} catch (_) {}

const { cleanSubject, cleanRationale } = require('./cleanSubject');



const DIR = path.join(__dirname, fs.existsSync(path.join(__dirname, '..', 'data')) ? '..' : '../..', 'data', 'news');

const CACHE_TTL_MS = 3000; // 3000ms cache: keeps board snappy with sub-millisecond responses without locking event loop



// ---------------------------------------------------------------------------

// THE NUMBERS THE EXCHANGE DOES NOT SEND.

//

// An NSE/BSE results filing is a COVER LETTER. Measured over this machine's whole

// flash store on 2026-11-07: 0 of 2,388 RESULT filings carried a single number in

// the payload — the subject is "Q2 FY27 Unaudited Financial Results" and the figures

// live inside the attached PDF, which nothing here parses.

//

// So `financialComparison.parseFinancialComparison()` could never fire on a real

// filing, and every result fell through to the same flat 45% "NEUTRAL / UNCERTAIN

// RESULTS". That is not a scoring bug, it is missing input.

//

// The numbers do exist — in coverage of the same filing ("Tata Chemicals reports

// ₹4,177 crore revenue in Q2FY27"). This index hands the grader that sentence for a

// symbol that filed results without numbers. It is used ONLY as extra text for the

// financial comparison; every other rule keeps seeing the filing exactly as filed, so

// a stray word in a headline cannot turn a routine filing into a "penalty" signal.

//

// No matching headline means no enrichment — the confidence stays low because the

// information really is absent. Nothing here invents a number.

const NEWS_ITEMS_PATH = path.join(DIR, 'items.jsonl');

const NEWS_NUM_RE = /(₹|\brs\.?\s*\d|\bcrore\b|\blakh\b|\bper ?cent\b|\d+(\.\d+)?\s*%)/i;

const NEWS_NUM_TTL_MS = 60000;

let _newsNumIdx = { mtime: -1, builtAt: 0, bySym: new Map() };



function buildNewsNumberIndex() {

  const now = Date.now();

  try {

    if (!fs.existsSync(NEWS_ITEMS_PATH)) return;

    const st = fs.statSync(NEWS_ITEMS_PATH);

    if (st.mtimeMs === _newsNumIdx.mtime && (now - _newsNumIdx.builtAt) < NEWS_NUM_TTL_MS) return;

    const bySym = new Map();

    for (const line of fs.readFileSync(NEWS_ITEMS_PATH, 'utf8').split('\n')) {

      if (!line) continue;

      let o;

      try { o = JSON.parse(line); } catch (_) { continue; }

      const ts = Number(o.ts) || 0;

      if (!ts || now - ts > 36 * 3600000) continue;

      const title = String(o.title || '');

      if (!NEWS_NUM_RE.test(title)) continue;

      // KEY ON THE STORE'S OWN TAGS ONLY. An earlier cut also indexed every uppercase word

      // in the headline, and "Landmark" in an unrelated Prozone Realty story attached a

      // DIFFERENT company's figures to LANDMARK's filing. Wrong numbers are worse than no

      // numbers: an untagged headline simply leaves the filing at its honest low confidence.

      for (const s of (Array.isArray(o.symbols) ? o.symbols : [])) {

        const k = String(s || '').toUpperCase();

        if (!k) continue;

        const arr = bySym.get(k) || [];

        if (arr.length < 6) arr.push({ title, ts, source: o.source || '' });

        bySym.set(k, arr);

      }

    }

    for (const arr of bySym.values()) arr.sort((a, b) => b.ts - a.ts);

    _newsNumIdx = { mtime: st.mtimeMs, builtAt: now, bySym };

  } catch (_) { /* an unreadable index costs a low confidence, never a crash */ }

}



function headlineNumbersFor(symbol, tsMs) {

  const sym = String(symbol || '').toUpperCase();

  if (!sym) return null;

  buildNewsNumberIndex();

  const arr = _newsNumIdx.bySym.get(sym);

  if (!arr || !arr.length) return null;

  const at = Number(tsMs) || Date.now();

  return arr.find((x) => Math.abs(x.ts - at) <= 36 * 3600000) || null;

}



/** Attach reported figures to a results filing that carried none. Idempotent. */

function enrichResultsFilingNumbers(catalyst) {

  if (!catalyst || catalyst.newsMatch) return catalyst;

  const mat = String(catalyst.materiality || '').toUpperCase();

  const looksLikeResults = mat === 'RESULTS' || /result/i.test(String(catalyst.title || ''));

  if (!looksLikeResults) return catalyst;

  // A Regulation-47 newspaper clipping is a REPRINT of results declared days ago — the

  // engine already scores it 15% "routinely priced in", and grading it again from this

  // morning's coverage produced a 86% "NEUTRAL / ROUTINE NEWSPAPER" contradiction

  // (IRIS). Old news stays old news: never enrich a reprint.

  if (/newspaper|clipping|paper\s+publication/i.test(String(catalyst.title || ''))) return catalyst;

  const desc = String(catalyst.description || catalyst.text || '');

  // A FINANCIAL number, not any digit: the subject line carries "quarter ended

  // September 30, 2026", and a bare /[0-9]/ guard read that date as reported figures

  // and skipped every results filing in the store.

  if (NEWS_NUM_RE.test(desc)) return catalyst; // the exchange did send numbers; trust them

  const hit = headlineNumbersFor(catalyst.symbol, catalyst.ts);

  if (!hit) return catalyst;

  catalyst.description = (desc ? desc + ' · ' : '') + hit.title;

  catalyst.newsMatch = { title: hit.title, ts: hit.ts, source: hit.source };

  return catalyst;

}



let _cachedSession = null;

let _cachedMap = null;

let _cachedTime = 0;

let _cachedMtime = 0;



const HIGH_PRIORITY_MATERIALITY = new Set([

  'SALES_UPDATE',

  'RESULTS',

  'ORDER',

  'CORPORATE_ACTION',

  'CAPITAL',

  'MANAGEMENT',

  'RATING'

]);



function getPreviousSessionDate(todayIstStr) {

  // Simple session offset helper

  const d = new Date(todayIstStr + 'T00:00:00Z');

  // Walk back 1 to 3 days to skip weekends

  for (let offset = 1; offset <= 4; offset++) {

    const prev = new Date(d.getTime() - offset * 86400000);

    const dayOfWeek = prev.getUTCDay();

    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Not Sunday (0) or Saturday (6)

      return prev.toISOString().slice(0, 10);

    }

  }

  return todayIstStr;

}



/**

 * Calculates the post-market close cutoff timestamp (15:30 IST).

 * - If current time >= 15:30 IST: Cutoff is TODAY at 15:30 IST.

 *   (News before 15:30 is removed; only post-15:30 filings for tomorrow are kept).

 * - If current time < 15:30 IST (e.g. tomorrow morning): Cutoff is PREV TRADING DAY at 15:30 IST.

 * This runs continuously in a loop, refreshing after 15:30 IST daily.

 */

function getPostCloseCutoffMs(nowMs = Date.now()) {
  try {
    let sessionTiming;
    try { sessionTiming = require('../market/sessionTiming'); } catch (_) {
      try { sessionTiming = require('./common/market/sessionTiming'); } catch (_) {
        sessionTiming = require('../../common/market/sessionTiming');
      }
    }
    const lastClose = sessionTiming.lastMarketClose(new Date(nowMs));
    // 20-minute buffer (15:10 IST) to ensure late-session closing bell filings are never missed due to exchange delay
    return lastClose.instant - 20 * 60000;
  } catch (_) {
    const nowIst = nowMs + 330 * 60000;
    const d = new Date(nowIst);
    return d.getTime() - 24 * 3600000;
  }
}



/**

 * Returns pre-market news items filed from previous session 15:30 IST to today 09:15 IST.

 * 

 * @param {string} [targetDateStr] - IST Date string 'YYYY-MM-DD', defaults to today IST.

 */

function loadPreMarketCatalysts(targetDateStr) {

  const now = Date.now();

  const todayIst = targetDateStr || new Date(now + 330 * 60000).toISOString().slice(0, 10);



  if (_cachedMap && _cachedSession === todayIst && (now - _cachedTime) < CACHE_TTL_MS) {

    return _cachedMap;

  }



  // Cutoff: Strictly filings AFTER 15:30 IST (removes all earlier news)

  const cutoffStartMs = getPostCloseCutoffMs(now);



  // End: Today at 09:15 IST = 03:45 UTC

  const [tY, tM, tD] = todayIst.split('-').map(Number);

  const cutoffEndMs = Date.UTC(tY, tM - 1, tD, 3, 45, 0); // 09:15 IST on today



  const allItems = flashNews.readAll();

  const catalystMap = new Map();



  const seenAnnounceUrls = new Set();
  const seenAnnounceKeys = new Set();

  for (const it of allItems) {

    if (!it || !it.symbol) continue;

    let sym = String(it.symbol).toUpperCase().trim();
    if (sym === 'HEGAM') sym = 'HEG';

    // Deduplicate duplicate exchange announcements sharing the same press release URL or headline key
    const itUrl = (it.url || it.link || '').toLowerCase().trim();
    const itKey = (it.title || it.description || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
    if (itUrl && seenAnnounceUrls.has(itUrl)) continue;
    if (itKey && itKey.length > 15 && seenAnnounceKeys.has(itKey)) continue;

    if (sym === 'BSE' && !/^bse\s+limited/i.test((it.name || '') + ' ' + (it.title || '') + ' ' + (it.description || ''))) continue;

    if (sym === 'NSE' && !/national\s+stock\s+exchange/i.test((it.name || '') + ' ' + (it.title || ''))) continue;

    if (sym === 'MCX' && !/multi\s+commodity\s+exchange/i.test((it.name || '') + ' ' + (it.title || ''))) continue;

    const itemTs = Number(it.ts || it.firstSeenAt);

    if (!isFinite(itemTs)) continue;

    // Must be filed between previous close (15:30 IST) and today open (09:15 IST)
    // Also include up to current time if before 09:30 AM
    if (itemTs >= cutoffStartMs) {
      if (itUrl) seenAnnounceUrls.add(itUrl);
      if (itKey && itKey.length > 15) seenAnnounceKeys.add(itKey);

      const mat = String(it.materiality || '').toUpperCase();

      // All filings from cutoffStartMs (market close) to next market open are preserved

      const isHighPriority = HIGH_PRIORITY_MATERIALITY.has(mat);

      const existing = catalystMap.get(sym);



      // Overwrite / preservation rules:

      // 1. If symbol not yet tracked -> accept item

      // 2. If new item is high priority and existing is low/routine -> upgrade to high priority

      // 3. If existing is high priority and new item is low/routine -> IGNORE new routine item!

      // 4. If newer filing arrives for this symbol, ALWAYS update to the latest live announcement!

      if (existing) {

        if (existing.isHighPriority && !isHighPriority) {

          continue; // Protect high-priority catalyst from being overwritten by routine paperwork

        }

        if (itemTs <= existing.ts) {

          continue; // Older filing cannot overwrite newer filing

        }

      }



      if (!existing || itemTs > existing.ts || (!existing.isHighPriority && isHighPriority)) {

        const dateObj = new Date(itemTs + 330 * 60000);

        const filingTime = dateObj.toISOString().slice(11, 16) + ' IST';

        const diffSec = Math.max(0, Math.round((Date.now() - itemTs) / 1000));

        let timeAgo = '';

        if (diffSec < 60) timeAgo = diffSec + 's ago';

        else if (diffSec < 3600) timeAgo = Math.round(diffSec / 60) + 'm ago';

        else if (diffSec < 86400) timeAgo = Math.round(diffSec / 3600) + 'h ago';

        else timeAgo = Math.round(diffSec / 86400) + 'd ago';



        const cleanTitle = cleanSubject(it.title, it.description || it.text, sym, mat);

        const itemObj = {

          symbol: sym,

          materiality: mat,

          kind: it.kind || '',

          title: cleanTitle,

          description: it.description || it.text || '',

          ts: itemTs,

          date: it.date || todayIst,

          filingTime,

          timeAgo,

          isHighPriority,

          url: it.url || null,

        };

        const pred = predictCatalyst(itemObj);

        itemObj.prediction = pred.prediction;

        itemObj.bias = pred.bias;

        itemObj.confidence = pred.confidence;

        itemObj.rationale = cleanRationale(pred.rationale, pred.bias, mat, cleanTitle);

        itemObj.takeTrade = pred.takeTrade;

        itemObj.tradeStatus = pred.tradeStatus;

        itemObj.badge = pred.badge;

        itemObj.mlProb = pred.mlProb;

        itemObj.mlHighConviction = pred.mlHighConviction;



        catalystMap.set(sym, itemObj);

      }

    }

  }



  // Merge recent breaking Google News items if not already covered by official filings

  try {

    if (global._googleNewsCache && Array.isArray(global._googleNewsCache)) {

      for (const git of global._googleNewsCache) {

        if (!git || !git.symbol || catalystMap.has(git.symbol)) continue;

        const gTs = Number(git.ts || git.firstSeenAt);

        if (gTs >= cutoffStartMs) {

          const dateObj = new Date(gTs + 330 * 60000);

          const filingTime = dateObj.toISOString().slice(11, 16) + ' IST';

          const diffMin = Math.max(0, Math.round((Date.now() - gTs) / 60000));

          const timeAgo = diffMin < 60 ? diffMin + 'm ago' : (diffMin < 1440 ? Math.round(diffMin / 60) + 'h ago' : Math.round(diffMin / 1440) + 'd ago');



          const itemObj = {

            symbol: git.symbol,

            materiality: git.materiality || 'RESULTS',

            kind: 'Google News Wire',

            title: git.title,

            ts: gTs,

            date: todayIst,

            filingTime,

            timeAgo,

            isHighPriority: true,

            url: git.url || null,

            source: git.source || 'Google News',

          };

          const pred = predictCatalyst(itemObj);

          itemObj.prediction = pred.prediction;

          itemObj.bias = pred.bias;

          itemObj.confidence = pred.confidence;

          itemObj.rationale = pred.rationale;

          catalystMap.set(git.symbol, itemObj);

        }

      }

    }

  } catch (_) {}



  _cachedSession = todayIst;

  _cachedMap = catalystMap;

  _cachedTime = Date.now();



  return catalystMap;

}



/**

 * Checks if a symbol has an active pre-market catalyst today.

 */

function getSymbolCatalyst(symbol, targetDateStr) {

  if (!symbol) return null;

  const sym = String(symbol).toUpperCase().trim();

  const map = loadPreMarketCatalysts(targetDateStr);

  return map.get(sym) || null;

}



/**

 * Validates whether a pre-market news symbol is eligible for trading at 09:15-09:30.

 * Refuses LONG entries on gap-down traps (per filingExclusion rule).

 */

function evaluatePreNewsTrade({ symbol, open, prevClose, side = 'BUY', targetDateStr }) {

  const catalyst = getSymbolCatalyst(symbol, targetDateStr);

  if (!catalyst) {

    return { eligible: false, reason: 'NO_PRE_NEWS_CATALYST' };

  }



  const o = Number(open);

  const pc = Number(prevClose);

  let gapPct = 0;

  if (o > 0 && pc > 0) {

    gapPct = +(((o / pc) - 1) * 100).toFixed(2);

  }



  // Check Gap-Down Exclusion

  if (side === 'BUY' && gapPct <= -1.0) {

    return {

      eligible: false,

      reason: 'GAP_DOWN_EXCLUDED',

      gapPct,

      basis: `Filing stock gapped down ${gapPct}%. Refusing LONG entry per filingExclusion rule.`

    };

  }



  return {

    eligible: true,

    catalyst,

    gapPct,

    reason: `PRE_NEWS_${catalyst.materiality}`,

    basis: `[PRE-NEWS CATALYST] ${catalyst.materiality} (${catalyst.kind}): ${(catalyst.title || '').slice(0, 80)}`,

  };

}



/**

 * Predicts directional reaction and bias for a catalyst filing:

 * - prediction: 'BUY / GO UP' | 'SELL / FADE' | 'NEUTRAL / WATCH'

 * - bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'

 * - confidence: integer % (50 - 90)

 * - rationale: 1-sentence explanatory thesis

 */

function _predictCatalystRaw(catalyst, opts = {}) {

  const { gapPct = 0, movePct = 0, move1mPct = 0, move5mPct = 0, range5mPct = 0, changePct = 0, price = 0, volume = null, last5Bars = null, fiveCandleRangePct = 0 } = opts;

  if (!catalyst) {

    return {

      prediction: 'NEUTRAL / WATCH',

      bias: 'NEUTRAL',

      confidence: 50,

      rationale: 'No active filing detected.'

    };

  }



  // 0. STRICT PENNY STOCK & ZERO-LIQUIDITY GUARD (e.g. GLFL, GAYAHWS, TRU)

  // Stocks below ₹30 are illiquid microcaps with wide spreads, 2-5% circuit locks, and no MIS leverage.

  const stockPrice = Number(price || catalyst.ltp || catalyst.close || catalyst.price || 0);

  if (stockPrice > 0 && stockPrice < 30.0) {

    return {

      prediction: 'NEUTRAL / UNTRADEABLE',

      bias: 'NEUTRAL',

      confidence: 0,

      rationale: `Penny stock (₹${stockPrice.toFixed(2)} < ₹30 floor) · Untradeable illiquid micro-cap; trade calls strictly refused.`

    };

  }



  const vol = Number(volume != null ? volume : (catalyst.volume || catalyst.effectiveVolume || 0));

  if (vol > 0 && vol < 25000) {

    return {

      prediction: 'NEUTRAL / LOW VOLUME',

      bias: 'NEUTRAL',

      confidence: 0,

      rationale: `Low volume (${vol.toLocaleString()} shares < 25,000) · Illiquid tape; trade calls strictly refused.`

    };

  }



  // 0. ROUTINE COMPLIANCE & ADMINISTRATIVE DISCLOSURE IMMUNITY

  // (Newspapers, board meeting notices, concall recordings, SAST shareholding filings)

  // Must be checked FIRST before any risk or financial comparison logic!

  const fullTextEarly = ((catalyst.title || '') + ' ' + (catalyst.kind || '') + ' ' + (catalyst.description || '') + ' ' + (catalyst.text || '')).toLowerCase();



  // 0A. Newspaper Publication (Regulation 47: Newspaper reprint of previously declared results)

  const isNewspaperResults = /newspaper|paper\s*cutting|clipping/i.test(fullTextEarly);

  if (isNewspaperResults) {

    return {

      prediction: 'NEUTRAL / ROUTINE NEWSPAPER',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📄 NEWSPAPER PUBLICATION (OLD NEWS)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine (Newspaper)',

      recommendation: 'AVOID / ROUTINE',

      rationale: 'Regulation 47 newspaper clipping of previously declared results. Historical results already priced in; pure administrative compliance.'

    };

  }



  // 0B. Board Meeting Notice (Regulation 29: Board Meeting to Consider Financial Results)

  const isBoardMeetingNotice = (/board\s+meeting|meeting\s+of\s+(?:the\s+)?board/i.test(fullTextEarly)) && !/outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome/i.test(fullTextEarly);

  const isMeetingOutcome = /outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome/i.test(fullTextEarly);



  if (isBoardMeetingNotice && !isMeetingOutcome) {

    return {

      prediction: 'NEUTRAL / BOARD MEETING NOTICE',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📅 BOARD MEETING (SCHEDULED)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine (Board Meeting)',

      recommendation: 'AVOID / ROUTINE',

      rationale: 'Administrative scheduling notice under Regulation 29 (board meeting to consider results). No results disclosed yet; zero trading edge.'

    };

  }



  // 0C. Earnings Conference Call Transcripts & Audio Recordings

  const isConcallTranscript = /transcript.*?(?:conference|earnings|analyst|concall)|audio\s+recording.*?(?:conference|earnings|concall)|concall\s+transcript|earnings\s+call\s+transcript/i.test(fullTextEarly);

  if (isConcallTranscript) {

    return {

      prediction: 'NEUTRAL / CONCALL TRANSCRIPT',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '🎙️ CONFCALL TRANSCRIPT (OLD NEWS)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine (Transcript)',

      recommendation: 'AVOID / ROUTINE',

      rationale: 'Earnings conference call transcript / audio recording of previously declared results. Historical commentary; zero fresh directional edge.'

    };

  }



  // 0D. SEBI SAST Regulation 29 / 10(6) / PIT 7(2) & Institutional MF Shareholding Disclosures

  const isSastOrShareholdingDisclosure = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition\s+of\s+shares|sebi\s*\(\s*sast\s*\)|sebi\s*\(\s*pit\s*\)|regulation\s*29\s*\(\s*[12]\s*\)|approval\s+of\s+irdai|by\s+the\s+schemes\s+of.*mutual\s+fund/i.test(fullTextEarly);

  if (isSastOrShareholdingDisclosure) {

    return {

      prediction: 'NEUTRAL / SAST REG 29 DISCLOSURE',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📄 SEBI SAST REG 29 (ROUTINE)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine (SAST 29)',

      recommendation: 'AVOID / ROUTINE',

      rationale: 'Administrative shareholding / promoter disclosure under SEBI SAST / PIT regulations. Routine statutory filing; not an acquisition or takeover.'

    };

  }



  // 0E. Administrative Tax Circular / TDS on Dividend Notice (Section 194 Income Tax compliance)

  const isTdsNoticeEarly = /deduction\s+of\s+tax|tax\s+deduction\s+at\s+source|tds\s+on\s+dividend|\btds\b|tax\s+at\s+source|form\s+15[gh]|communication\s+to\s+shareholders\s+regarding.*tax/i.test(fullTextEarly);

  if (isTdsNoticeEarly) {

    return {

      prediction: 'NEUTRAL / ROUTINE TAX COMPLIANCE',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📋 ROUTINE (TAX NOTICE / TDS)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine (Tax Notice)',

      recommendation: 'AVOID / ROUTINE',

      rationale: 'Administrative intimation regarding deduction of tax at source (TDS) / Form 15G/15H for dividend. Pure compliance paperwork without trading edge.'

    };

  }

  // 0F. Allotment of Non-Convertible Debentures (NCDs) / Commercial Paper (Debt issuance compliance)
  const isDebtPaperAllotment = /allotment\s+of\s+(?:non-convertible\s+)?debentures|issue\s+of\s+debentures|ncd\s+allotment|\b(?:ncd|ncds)\b|commercial\s+paper|bonds\s+allotment|redemption\s+of\s+debentures/i.test(fullTextEarly);
  if (isDebtPaperAllotment) {
    return {
      prediction: 'NEUTRAL / DEBT ALLOTMENT',
      bias: 'NEUTRAL',
      confidence: 15,
      takeTrade: false,
      tradeStatus: 'ROUTINE_DISCLOSURE',
      badge: '📄 DEBT ALLOTMENT (ROUTINE)',
      actionBtnClass: 'btn-trade-watch',
      actionBtnLabel: 'Routine (Debt Allotment)',
      recommendation: 'AVOID / ROUTINE',
      rationale: 'Administrative intimation regarding allotment or redemption of Non-Convertible Debentures (NCDs) / Commercial Paper. Normal corporate debt financing; zero directional equity edge.'
    };
  }

  // 0G. Analyst / Institutional Investor Meetings & Presentations
  const isInvestorMeetNotice = /analyst\s*(?:\/|\s+and\s+)?(?:institutional\s+)?investor\s+meet|interaction\s+with\s+(?:investors|analysts)|schedule\s+of\s+(?:investor|analyst)|investor\s+conference|annual\s+investor|spark\s+indx|analyst\s+conference|investor\s+presentation|presentation\s+with\s+respect\s+to\s+(?:the\s+)?(?:un-?audited|financial)|earning\s+call\s+presentation/i.test(fullTextEarly);
  if (isInvestorMeetNotice) {
    return {
      prediction: 'NEUTRAL / INVESTOR MEET',
      bias: 'NEUTRAL',
      confidence: 15,
      takeTrade: false,
      tradeStatus: 'ROUTINE_DISCLOSURE',
      badge: '🤝 INVESTOR / ANALYST MEET',
      actionBtnClass: 'btn-trade-watch',
      actionBtnLabel: 'Routine (Investor Meet)',
      recommendation: 'AVOID / ROUTINE',
      rationale: 'Schedule or presentation for analyst / institutional investor meeting under SEBI LODR. Routine investor relations; zero fresh directional edge.'
    };
  }

  // 0H. Generic Board Meeting Outcome Notice (Administrative conclusion without results or numbers)
  const isGenericBoardOutcomeNotice = (
    /outcome\s+of\s+(?:the\s+)?board\s+meeting/i.test(fullTextEarly) &&
    !/financial\s+result|quarterly\s+result|unaudited|audited|dividend|bonus|split|acquisition|merger/i.test(fullTextEarly)
  );
  if (isGenericBoardOutcomeNotice) {
    return {
      prediction: 'NEUTRAL / BOARD OUTCOME',
      bias: 'NEUTRAL',
      confidence: 15,
      takeTrade: false,
      tradeStatus: 'ROUTINE_DISCLOSURE',
      badge: '📋 BOARD OUTCOME (ROUTINE)',
      actionBtnClass: 'btn-trade-watch',
      actionBtnLabel: 'Routine (Board Outcome)',
      recommendation: 'AVOID / ROUTINE',
      rationale: 'Administrative outcome of board meeting without financial results, dividend, or major corporate action.'
    };
  }



  const mat = String(catalyst.materiality || '').toUpperCase();

  const kind = String(catalyst.kind || '').toLowerCase();

  const title = String(catalyst.title || '').toLowerCase();



  // 1. Extreme negative / Bearish conditions -> SELL / FADE

  if (

    mat === 'RISK' ||

    kind.includes('insolvency') ||

    title.includes('insolvency') ||

    kind.includes('default') ||

    title.includes('default') ||

    kind.includes('litigation') ||

    title.includes('dispute') ||

    title.includes('penalty') ||

    (/\bsearch\b/i.test(title) && !/\bresearch\b/i.test(title)) ||

    title.includes('raid') ||

    kind.includes('delay') ||

    title.includes('delay') ||

    title.includes('non-submission') ||

    title.includes('non submission') ||

    title.includes('cyber security')

  ) {

    const isActualDefault = kind.includes('default') || title.includes('default') || kind.includes('insolvency') || title.includes('insolvency');

    const isDumpingTape = (move1mPct <= -0.15 || move5mPct <= -0.30 || movePct <= -0.50);

    const isTapeGreen = (movePct >= 0.30 || move1mPct >= 0.10 || move5mPct >= 0.20);



    if (isTapeGreen && !isActualDefault) {

      return {

        prediction: 'AVOID SHORT / TAPE ABSORBING',

        bias: 'NEUTRAL',

        confidence: 45,

        takeTrade: false,

        tradeStatus: 'BEAR_TRAP_AVOID',

        badge: '🛡️ TAPE ABSORBING (AVOID SHORT)',

        actionBtnClass: 'btn-trade-watch',

        actionBtnLabel: 'Watch (Bear Trap)',

        recommendation: 'AVOID SHORT',

        rationale: `Regulatory / litigation headline met with green order flow (+${(movePct || move1mPct).toFixed(1)}%). Smart money absorption; shorting strictly avoided to prevent bear trap squeeze.`

      };

    }



    const canShort = isActualDefault || isDumpingTape;



    let r = 'Insolvency, litigation, or regulatory risk filing — high likelihood of selling pressure or fading pops.';

    if (kind.includes('default') || title.includes('default')) {

      r = 'Debt / loan default on payment of principal or interest indicates severe credit distress · Sell / Fade or avoid';

    } else if (title.includes('delay') || title.includes('non-submission') || title.includes('non submission')) {

      r = 'Delayed / non-submission of financial results indicates regulatory or accounting distress · Fade or avoid';

    } else if (title.includes('cyber security')) {

      r = 'Cyber security incident reported · High risk of operational disruption and negative sentiment';

    }



    return {

      prediction: canShort ? 'SELL / FADE' : 'AVOID / REGULATORY RISK',

      bias: 'BEARISH',

      confidence: canShort ? 85 : 60,

      takeTrade: canShort,

      tradeStatus: canShort ? 'TAKE_TRADE_SHORT' : 'REGULATORY_ORDER',

      badge: canShort ? '📉 CREDIT/REGULATORY RISK' : '⚠️ REGULATORY RISK (WATCH)',

      actionBtnClass: canShort ? 'btn-trade-sell' : 'btn-trade-watch',

      actionBtnLabel: canShort ? 'Take Short / Fade (85%)' : 'Watch Risk',

      recommendation: canShort ? 'STRONG SELL / FADE' : 'AVOID / WATCH',

      targetPct: -1.8,

      stopLossPct: 0.6,

      rationale: r

    };

  }



  // -------------------------------------------------------------

  // MARKET MICROSTRUCTURE & TAPE CONFIRMATION OVERRIDES

  // -------------------------------------------------------------

  const hasIntradayVelocity = (move1mPct !== 0 || move5mPct !== 0);

  const isMarketHours = (() => {

    if (opts.isMarketHours !== undefined) return Boolean(opts.isMarketHours);

    if (opts.isOpeningWindow) return true;

    if (catalyst.isMarketHours !== undefined) return Boolean(catalyst.isMarketHours);

    if (hasIntradayVelocity) return true; // If 1m or 5m velocity is explicitly provided, treat as active session tape

    try {
      let sessionTiming;
      try { sessionTiming = require('../market/sessionTiming'); } catch (_) {
        try { sessionTiming = require('./common/market/sessionTiming'); } catch (_) {
          sessionTiming = require('../../common/market/sessionTiming');
        }
      }
      return sessionTiming.isMarketOpen();
    } catch (_) {
      const d = new Date(Date.now() + 330 * 60000);
      const day = d.getUTCDay();
      if (day === 0 || day === 6) return false;
      const t = d.getUTCHours() * 100 + d.getUTCMinutes();
      return t >= 915 && t < 1530;
    }

  })();

  const hasTapeData = (move1mPct !== 0 || move5mPct !== 0 || movePct !== 0);



  const desc = String(catalyst.description || catalyst.text || '').toLowerCase();

  const fullText = (title + ' ' + desc).toLowerCase();



  // Early Financial Comparison extraction (Old vs New: EBITDA, Margins, PAT, Revenue, Orders)

  const finComp = financialComparison.parseFinancialComparison(fullText, title);

  if (finComp.hasFinancialData) {

    if (finComp.strengthGrade === 'FLAT_DISAPPOINTING') {

      const hasDixonThrust = isMarketHours && (Number(move1mPct || 0) >= 0.18 || Number(move5mPct || 0) >= 0.35 || Number(gapPct || 0) >= 0.50);

      const isSyrmaDumping = isMarketHours && hasTapeData && (Number(move1mPct || 0) <= -0.15 || Number(move5mPct || 0) <= -0.30 || Number(gapPct || 0) <= -0.40);

      if (hasDixonThrust) {

        return {

          prediction: 'BUY / GO UP',

          bias: 'BULLISH',

          confidence: 82,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE_BUY',

          badge: '🚀 RELIEF BREAKOUT (DIXON EFFECT)',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: 'Take Trade (Buy 82%)',

          recommendation: 'STRONG BUY (PRICE ACTION OVERRIDE)',

          targetPct: 2.0,

          stopLossPct: -0.6,

          rationale: `Dixon Pattern (Price Action Override): Tepid results met with buying thrust (+${(move1mPct || gapPct || move5mPct).toFixed(1)}%). Short covering & relief breakout; take buy.`,

          financialComparison: finComp

        };

      }

      if (isSyrmaDumping) {

        return {

          prediction: 'SELL / FADE',

          bias: 'BEARISH',

          confidence: 82,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE_SHORT',

          badge: '📉 RESULTS SELL-OFF (SYRMA EFFECT)',

          actionBtnClass: 'btn-trade-sell',

          actionBtnLabel: 'Take Short / Fade (82%)',

          recommendation: 'STRONG SELL / FADE',

          targetPct: -1.8,

          stopLossPct: 0.6,

          rationale: `Syrma Pattern (Price Action Override): Results met with falling tape (${move1mPct ? `${move1mPct}% 1m, ` : ''}${move5mPct ? `${move5mPct}% 5m` : ''}). Institutional dump into announcement; take short / fade.`,

          financialComparison: finComp

        };

      }

      return {

        prediction: 'DO NOT CHASE / TEPID RESULTS',

        bias: 'NEUTRAL',

        confidence: finComp.convictionProb || 35,

        takeTrade: false,

        tradeStatus: 'FLAT_DISAPPOINTING',

        badge: '⏳ FLAT / TEPID (DO NOT CHASE)',

        actionBtnClass: 'btn-trade-warn',

        actionBtnLabel: 'Flat Results (Do Not Chase)',

        rationale: `Tepid results: ${finComp.comparisonSummary}. Flat growth or compressed margins; lacks strength to justify institutional entry.`,

        financialComparison: finComp

      };

    } else if (finComp.strengthGrade === 'SEVERE_MISS') {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: finComp.convictionProb || 88,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 SEVERE EARNINGS MISS',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: `Take Short (${finComp.convictionProb || 88}%)`,

        rationale: `Severe earnings miss: ${finComp.comparisonSummary}. Fundamental breakdown vs prior year; strong institutional selling pressure.`,

        financialComparison: finComp

      };

    }

  }



  // 1. Regulatory / Legal / Penalty Orders (Action initiated or orders passed)

  const isRegulatoryOrCourtOrder = (

    fullText.includes('orders passed') ||

    fullText.includes('order passed') ||

    fullText.includes('action(s) initiated') ||

    fullText.includes('penalty') ||

    fullText.includes('assessment order') ||

    fullText.includes('demand order') ||

    fullText.includes('show cause') ||

    fullText.includes('interim order') ||

    fullText.includes('nclt') ||

    fullText.includes('tribunal') ||

    fullText.includes('court order') ||

    (/sebi.{0,40}(?:penalty|order|action|notice|fine|investigat|inquiry|summons)/i.test(fullText) || /action\s+by\s+sebi/i.test(fullText)) ||

    fullText.includes('summons') ||

    fullText.includes('search and seizure') ||

    (/\b(?:cbi|ed|sebi|it|tax|police|sfio)\s+investigation\b/i.test(fullText) || /investigation\s+initiated/i.test(fullText)) ||

    fullText.includes('goods and services tax') ||

    fullText.includes('gst act') ||

    fullText.includes('tax act') ||

    /order\s+under\s+(?:the\s+)?(?:.*?tax\s+act|section|cgst|sgst|igst|customs|excise)/i.test(fullText)

  );



  const isOrderOrContract = !isRegulatoryOrCourtOrder && (

    mat === 'ORDER' ||

    /bagg(?:ed|ing)\s+(?:order|contract)/i.test(fullText) ||

    /secur(?:ed|es|ing)\s+(?:order|contract)/i.test(fullText) ||

    /award(?:ed|s|ing)\s+(?:of\s+)?(?:order|contract|project|work)/i.test(fullText) ||

    /received?\s+(?:an?\s+)?(?:order|contract|work\s+order|purchase\s+order|commercial\s+order|export\s+order)/i.test(fullText) ||

    /receipt\s+of\s+(?:an?\s+)?(?:order|contract|work\s+order|purchase\s+order|commercial\s+order|export\s+order)/i.test(fullText) ||

    /bagging\/receiving\s+of\s+orders\/contracts/i.test(fullText) ||

    /letter\s+of\s+(?:intent|award|acceptance)|\b(?:loi|loa)\b/i.test(fullText) ||

    /wins?\s+(?:order|contract|bid|tender)/i.test(fullText) ||

    /commercial\s+order|purchase\s+order|export\s+order|work\s+order/i.test(fullText)

  );



  if (isRegulatoryOrCourtOrder) {

    return {

      prediction: 'NEUTRAL / REGULATORY ORDER',

      bias: 'BEARISH',

      confidence: 65,

      takeTrade: false,

      tradeStatus: 'REGULATORY_ORDER',

      badge: '⚠️ REGULATORY ORDER (RISK)',

      rationale: 'Regulatory / legal authority order passed against company or notice received. Downside or reputational risk; not a commercial order win.'

    };

  }



  // Explicit Results Filing check: Genuine earnings releases only! (Exclude newspaper reprints, board meetings, transcripts)

  const isResultsFiling = !isNewspaperResults && !isBoardMeetingNotice && !isConcallTranscript && !isSastOrShareholdingDisclosure && (

    mat === 'RESULTS' ||

    /outcome\s+of\s+(?:the\s+)?board\s+meeting.*result|board\s+meeting\s+outcome.*result|financial\s+results\s+for\s+(?:the\s+)?(?:quarter|half|year)|unaudited.*financial\s+results.*ended|audited.*financial\s+results.*ended/i.test(fullTextEarly)

  );



  const isPureRecordDateFollowup = (

    String(catalyst.kind || '') === 'Record Date' ||

    /record\s+date\s+for\s+the\s+purpose\s+of\s+dividend/i.test(fullTextEarly)

  ) && !/declare|approved|recommended|outcome|board\s+meeting|consider\s+(?:and\s+approve\s+)?interim/i.test(fullTextEarly);



  const isDividendOrCapital = !isPureRecordDateFollowup && !isTdsNoticeEarly && (

    mat === 'CAPITAL' ||

    fullTextEarly.includes('dividend') ||

    fullTextEarly.includes('interim dividend') ||

    fullTextEarly.includes('special dividend') ||

    fullTextEarly.includes('bonus') ||

    fullTextEarly.includes('buyback') ||

    fullTextEarly.includes('split')

  ) && !/deduction\s+of\s+tax|tax\s+deduction|tds\s+on\s+dividend|\btds\b|tax\s+at\s+source|shareholder\s+communication\s+on\s+tax/i.test(fullTextEarly);



  const isRoutineEarly = (

    mat === 'ROUTINE' ||

    fullTextEarly.includes('investor presentation') ||

    fullTextEarly.includes('analyst presentation') ||

    fullTextEarly.includes('open offer') ||

    fullTextEarly.includes('ams update') ||

    fullTextEarly.includes('superannuation') ||

    (!isDividendOrCapital && fullTextEarly.includes('record date')) ||

    fullTextEarly.includes('newspaper') ||

    fullTextEarly.includes('investor meet') ||

    fullTextEarly.includes('analyst meet') ||

    fullTextEarly.includes('loss of share') ||

    fullTextEarly.includes('closure of trading') ||

    fullTextEarly.includes('appointment of') ||

    fullTextEarly.includes('re-appointment') ||

    fullTextEarly.includes('reappointment') ||

    fullTextEarly.includes('listing regulations') ||

    fullTextEarly.includes('trading window') ||

    fullTextEarly.includes('monitoring agency') ||

    fullTextEarly.includes('change in corporate office address') ||

    fullTextEarly.includes('change in registered office address') ||

    fullTextEarly.includes('change of address') ||

    fullTextEarly.includes('share transfer agent') ||

    fullTextEarly.includes('registrar and share transfer') ||

    fullTextEarly.includes('postal ballot') ||

    fullTextEarly.includes('scrutinizer') ||

    fullTextEarly.includes('voting results') ||

    fullTextEarly.includes('credit rating') ||

    fullTextEarly.includes('annual general meeting') ||

    fullTextEarly.includes('extraordinary general meeting') ||

    /reg\.?\s*(?:32|39|74|57|40|76|55a|24a)\b/i.test(fullTextEarly) ||

    /clarification\s+on\s+spurt|spurt\s+in\s+volume|movement\s+in\s+price/i.test(fullTextEarly)

  );



  if (isRoutineEarly && !isOrderOrContract && !isResultsFiling && !isDividendOrCapital) {

    return {

      prediction: 'NEUTRAL / ROUTINE',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📄 ROUTINE (NO EDGE)',

      rationale: 'Routine administrative disclosure (compliance / intimation / address / presentation / agency report). Event study shows 0.00% forward edge; trade calls strictly refused.'

    };

  }



  // 2. Routine Land / Property Acquisitions (Real estate standard Capex)

  const isRoutineLandAcquisition = (

    /acquisition\s+of\s+(?:land|plot|property|flat|premises|development\s+rights)/i.test(fullText) ||

    /purchase\s+of\s+(?:land|plot|property)/i.test(fullText) ||

    /agreement\s+for\s+(?:land|plot|property)/i.test(fullText) ||

    /execution\s+of\s+jda/i.test(fullText)

  );



  if (isRoutineLandAcquisition && !isResultsFiling) {

    return {

      prediction: 'NEUTRAL / ROUTINE LAND PURCHASE',

      bias: 'NEUTRAL',

      confidence: 20,

      takeTrade: false,

      tradeStatus: 'ROUTINE_LAND_ACQUISITION',

      badge: '🏞️ ROUTINE LAND (NO M&A)',

      rationale: 'Routine real estate land parcel acquisition. Standard business Capex for developer; not a corporate M&A / takeover catalyst.'

    };

  }



  // Positive corporate news guard: NEVER short an order win, capex, expansion, demerger, or dividend just because stock dipped -1%

  const isCapacityOrCommercialEarly = (

    fullTextEarly.includes('commercial production') ||

    fullTextEarly.includes('capacity addition') ||

    fullTextEarly.includes('capacity expansion') ||

    fullTextEarly.includes('expansion') ||

    fullTextEarly.includes('commissioning') ||

    fullTextEarly.includes('bess project')

  );

  const isDemergerEarly = fullTextEarly.includes('demerger') || fullTextEarly.includes('scheme of arrangement');

  const isPositiveCorporateNews = !isResultsFiling && (

    mat === 'ORDER' || mat === 'SALES_UPDATE' || mat === 'CAPITAL' ||

    isOrderOrContract || isCapacityOrCommercialEarly || isDemergerEarly || isDividendOrCapital

  );



  if (isPositiveCorporateNews && (gapPct <= -1.0 || movePct <= -1.0)) {

    const drop = gapPct <= -1.0 ? gapPct : movePct;

    return {

      prediction: 'NEUTRAL / DIVERGENCE',

      bias: 'NEUTRAL',

      confidence: 40,

      takeTrade: false,

      tradeStatus: 'AUCTION_REJECTED',

      badge: '⚠️ PRICE DIVERGENCE (AVOID SHORT)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Watch (Divergence)',

      recommendation: 'AVOID / WATCH',

      rationale: `Positive corporate catalyst (${mat}) met with negative market beta / price dip (${Number(drop).toFixed(1)}%). Fundamental catalyst conflicts with price action; shorting strictly avoided to prevent bear trap squeeze.`

    };

  }



  // Gap-down short edge is strictly reserved for:

  // 1. Genuine earnings releases (mat === 'RESULTS' && isResultsFiling) where stock dumps post-news (Syrma Effect)

  // 2. Genuine catastrophic risk catalysts (mat === 'RISK', loan/debt default, insolvency, SEBI ban, fraud)

  // Generic corporate updates (mat === 'OTHER', administrative notices) must NEVER trigger a short just because the stock dipped -1%!

  const isEligibleShortCatalyst = (mat === 'RESULTS' && isResultsFiling) || mat === 'RISK' || /insolvency|nclt|fraud|cbi|raid|loan\s+default|debt\s+default|rating\s+downgrade/i.test(fullTextEarly);

  const postNewsPctEarly = opts.postNewsMovePct != null ? Number(opts.postNewsMovePct) : null;

  const isDumpingSession = isMarketHours && (postNewsPctEarly != null ? postNewsPctEarly <= -0.80 : (move1mPct <= -0.20 && move5mPct <= -0.40));

  const isDumpingPreMarket = !isMarketHours && (gapPct <= -1.0 || (movePct <= -1.0 && !hasIntradayVelocity));



  if (!isRoutineEarly && !isPositiveCorporateNews && isEligibleShortCatalyst && (isDumpingSession || isDumpingPreMarket)) {

    const drop = !isMarketHours ? (gapPct <= -1.0 ? gapPct : movePct) : (postNewsPctEarly != null ? postNewsPctEarly : (move5mPct || move1mPct));

    // Overextended dump (<= -3.8%): Move is already consumed! Avoid chasing short into opening bounce.

    if (drop <= -3.8) {

      return {

        prediction: 'DO NOT CHASE / ALREADY MOVED',

        bias: 'NEUTRAL',

        confidence: 40,

        takeTrade: false,

        tradeStatus: 'ALREADY_MOVED',

        badge: '🚫 ALREADY MOVED',

        rationale: `Stock already plunged ${Number(drop).toFixed(1)}%. Downside move exhausted; avoid chasing short into bounce.`

      };

    }

    return {

      prediction: 'SELL / FADE',

      bias: 'BEARISH',

      confidence: (mat === 'RESULTS' || isResultsFiling) ? 85 : 75,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE_SHORT',

      badge: (mat === 'RESULTS' || isResultsFiling) ? '📉 RESULTS SELL-OFF (SYRMA EFFECT)' : '📉 CATALYST BREAKDOWN (RISK EVENT)',

      actionBtnClass: 'btn-trade-sell',

      actionBtnLabel: (mat === 'RESULTS' || isResultsFiling) ? 'Take Short / Fade (85%)' : 'Take Short / Fade (75%)',

      recommendation: 'STRONG SELL / FADE',

      targetPct: -1.50,

      stopLossPct: 0.50,

      rationale: mat === 'RESULTS'

        ? `Syrma Pattern: Stock dropped ${Number(drop).toFixed(1)}% on results. Institutional selling into liquidity; take short / fade.`

        : `High-risk catalyst (${mat || 'RISK'}) broke down ${Number(drop).toFixed(1)}%. Empirical edge shows negative catalysts do not mean-revert; expect fade.`

    };

  }



  // 1B. ROUTINE ADMINISTRATIVE DISCLOSURE GUARD (Event study: 47.4% of all news, 0.00% edge, 46.2% win rate)

  // Superannuation / retirement, record dates, TDS circulars are purely routine administration

  const isSuperannuation = fullText.includes('superannuation') || fullText.includes('retirement');

  const isTaxOnDividend = /deduction\s+of\s+tax|tax\s+deduction|tds\s+on\s+dividend|\btds\b|tax\s+at\s+source|shareholder\s+communication\s+on\s+tax/i.test(fullText);

  const isRecordDateOrTds = (fullText.includes('record date') || isTaxOnDividend || fullText.includes('tax deduction at source') || fullText.includes('tds on dividend')) && !isDividendOrCapital;

  const isRoutine = !isDividendOrCapital && !isResultsFiling && (

    mat === 'ROUTINE' ||

    isSuperannuation ||

    isRecordDateOrTds ||

    fullText.includes('commercial paper') ||

    fullText.includes('redemption of') ||

    fullText.includes('esop allotment') ||

    fullText.includes('allotment of shares under esop') ||

    kind.includes('newspaper') ||

    title.includes('newspaper') ||

    kind.includes('investor meet') ||

    title.includes('investor meet') ||

    title.includes('analyst meet') ||

    title.includes('investor presentation') ||

    title.includes('analyst presentation') ||

    kind.includes('presentation') ||

    title.includes('presentation') ||

    title.includes('open offer') ||

    title.includes('con-call') ||

    title.includes('concall') ||

    title.includes('conference call') ||

    title.includes('compliance certificate') ||

    title.includes('secretarial') ||

    title.includes('loss of share') ||

    title.includes('reg 39') ||

    title.includes('reg 74') ||

    title.includes('closure of trading')

  );



  if (isRoutine && !isOrderOrContract && !isResultsFiling) {

    return {

      prediction: 'NEUTRAL / ROUTINE',

      bias: 'NEUTRAL',

      confidence: 15,

      takeTrade: false,

      tradeStatus: 'ROUTINE_DISCLOSURE',

      badge: '📄 ROUTINE (NO EDGE)',

      rationale: isSuperannuation

        ? 'Normal executive superannuation/retirement. Routine administrative transition; no trading edge.'

        : isRecordDateOrTds

          ? 'Routine record date / tax intimation following prior dividend. Purely administrative; no forward trade edge.'

          : 'Routine administrative disclosure (newspaper / investor meet / compliance). Event study shows 0.00% forward edge (pure noise); trade calls strictly refused.'

    };

  }



  if ((kind.includes('resignation') || title.includes('resignation') || title.includes('cessation')) && !isSuperannuation) {

    const isMajorCrisis = fullText.includes('fraud') || fullText.includes('whistleblower') || fullText.includes('irregularit') || fullText.includes('investigation') || fullText.includes('removal') || fullText.includes('termination');

    const isTopLeadership = fullText.includes('managing director') || fullText.includes('ceo') || fullText.includes('chief executive') || fullText.includes('cfo') || fullText.includes('chief financial officer');

    if (isMajorCrisis || isTopLeadership) {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 75,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '⚠️ LEADERSHIP CRISIS',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short / Fade (75%)',

        recommendation: 'STRONG SELL / FADE',

        targetPct: -1.50,

        stopLossPct: 0.50,

        rationale: 'Abrupt C-suite leadership departure or governance inquiry creates selling pressure — downside drift bias.'

      };

    }

    return {

      prediction: 'NEUTRAL / ROUTINE',

      bias: 'NEUTRAL',

      confidence: 25,

      takeTrade: false,

      tradeStatus: 'ROUTINE_LEADERSHIP_CHANGE',

      badge: '👤 BOARD ROTATION',

      rationale: 'Routine resignation / succession of non-executive or independent director. Historically negligible market reaction; trade calls refused.'

    };

  }







  const isEarningsBeat = (

    (mat === 'RESULTS' || kind.includes('result') || fullText.includes('result')) &&

    (title.includes('record') || title.includes('growth') || title.includes('jump') || title.includes('beat') || title.includes('surge') || /(\d+(?:\.\d+)?)\s*%\s*(?:jump|growth|surge|increase|up)/i.test(fullText)) &&

    !title.includes('loss') && !title.includes('decline') && !title.includes('drop') && !title.includes('slump')

  );



  // Commercial Production, Plant Commissioning, Capacity Expansion, or BESS / Energy Projects

  const isCapacityOrCommercial = (

    fullText.includes('commercial production') ||

    fullText.includes('commencement of commercial') ||

    fullText.includes('capacity addition') ||

    fullText.includes('capacity expansion') ||

    fullText.includes('commissioning of') ||

    fullText.includes('commissioned') ||

    fullText.includes('new manufacturing plant') ||

    fullText.includes('bess project') ||

    fullText.includes('battery energy storage')

  );



  // Demerger & Value-Unlock Catalysts (Structural Reorganization)

  const isDemerger = fullText.includes('demerger') || fullText.includes('scheme of arrangement') || fullText.includes('scheme of demerger');



  // M&A must involve genuine company shares, equity stake, merger, or amalgamation

  const isSastRegulation = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition\s+of\s+shares|sebi\s*\(\s*sast\s*\)|regulation\s*29\s*\(\s*[12]\s*\)/i.test(fullText);

  const isStakeSaleOrDivestment = /sale\s+of\s+(?:entire\s+)?stake|divestment|disposal\s+of\s+(?:entire\s+)?stake/i.test(fullText);

  const isGenuineMA = !isRoutineLandAcquisition && !isSastRegulation && !isStakeSaleOrDivestment && (

    isDemerger ||

    (

      (mat === 'CORPORATE_ACTION' || kind.includes('acquisition') || fullText.includes('acquisition')) &&

      (

        fullText.includes('shares') || fullText.includes('stake') || fullText.includes('entity') ||

        fullText.includes('company') || fullText.includes('subsidiary') || fullText.includes('merger') ||

        fullText.includes('takeover') || fullText.includes('amalgamation') ||

        fullText.includes('business transfer') || fullText.includes('slump sale') || fullText.includes('spa') ||

        fullText.includes('share purchase agreement') || fullText.includes('ocps') || fullText.includes('ncps')

      )

    )

  );



  const isPositiveHeadline = (

    isOrderOrContract ||

    isEarningsBeat ||

    isDemerger ||

    isGenuineMA ||

    isCapacityOrCommercial ||

    (mat === 'CAPITAL' && (fullText.includes('qip') || fullText.includes('bonus') || fullText.includes('allotment') || fullText.includes('fund raise'))) ||

    fullText.includes('dividend') ||

    fullText.includes('partnership')

  );



  // Check 0B: Reject Yesterday's Stale Filings During Market Hours

  // User: "you're taking the news from yesterday. That's not correct."

  // IMPORTANT: Filings published after yesterday's 15:30 close (overnight / evening earnings)

  // are the PRIMARY catalysts for today's opening window (09:00 - 09:30 AM).

  // Only reject them if:

  // 1. Current time is past the 09:30 AM opening window (istTNum >= 930), OR

  // 2. The filing was published BEFORE yesterday 15:30 close (i.e. during yesterday's market session).

  const nowUtc = Date.now();

  const dIst = new Date(nowUtc + 330 * 60000);

  const istTNum = dIst.getUTCHours() * 100 + dIst.getUTCMinutes();

  const todayIstMidnight = Date.UTC(dIst.getUTCFullYear(), dIst.getUTCMonth(), dIst.getUTCDate()) - 330 * 60000;

  const sessionOpenMs = Date.UTC(dIst.getUTCFullYear(), dIst.getUTCMonth(), dIst.getUTCDate(), 3, 45, 0); // 09:15 IST

  const isOpeningWindow = (opts && opts.isOpeningWindow !== undefined) ? Boolean(opts.isOpeningWindow) : (istTNum >= 900 && istTNum < 930);

  const postCloseCutoffMs = isOpeningWindow ? getPostCloseCutoffMs(todayIstMidnight + 9 * 3600000 + 15 * 60000) : getPostCloseCutoffMs(nowUtc);



  if (isMarketHours && catalyst.ts) {

    const isStale = (catalyst.ts < postCloseCutoffMs) || (!isOpeningWindow && catalyst.ts < todayIstMidnight);

    if (isStale) {

      return {

        prediction: 'DO NOT TRADE / STALE YESTERDAY',

        bias: 'NEUTRAL',

        confidence: 0,

        takeTrade: false,

        tradeStatus: 'STALE_YESTERDAY',

        badge: '📅 YESTERDAY (PRICED IN)',

        rationale: `Filing is from yesterday (${catalyst.filingTime || ''}). Already fully priced in during pre-market; intraday trade calls strictly refused.`

      };

    }

  }



  const priorMove = (changePct != null && changePct !== 0) ? changePct : (movePct || 0);

  const abs1m = Math.abs(Number(move1mPct || 0));

  const abs5m = Math.abs(Number(move5mPct || 0));

  const absMove = Math.abs(Number(movePct || 0));

  const isStagnant = abs1m < 0.15 && abs5m < 0.30 && absMove < 0.50;



  // 5-CANDLE / 5-MINUTE STRUCTURE ANALYSIS

  // User Directive: "no you not consider 1minute u see the past last 5min like 5 candles are huge

  // then you get idea it was already did the news takes... your work it tot tell it was good buy or sell or how mch probablity"

  let c5Range = Number(range5mPct || fiveCandleRangePct || 0);

  if (Array.isArray(last5Bars) && last5Bars.length >= 2) {

    const h5 = Math.max(...last5Bars.map(b => b.h || b.c || 0));

    const l5 = Math.min(...last5Bars.map(b => (b.l > 0 ? b.l : (b.c || b.o))));

    if (l5 > 0) c5Range = Math.max(c5Range, +(((h5 - l5) / l5) * 100).toFixed(2));

  }

  const c5Net = Number(move5mPct || 0);

  const effectiveC5Range = c5Range > 0 ? c5Range : Math.abs(c5Net);



  // 1. Are the past 5 candles huge? (The move has already been taken/priced in!)

  const isStallingMomentum = Math.abs(move1mPct) <= 0.10;

  const is5CandlesHuge = (c5Net >= 2.2 || effectiveC5Range >= 2.5 || ((c5Net >= 1.5 || effectiveC5Range >= 1.8) && isStallingMomentum));



  // 2. Are the past 5 candles heavily dumping?

  const is5CandlesDumping = (c5Net <= -0.50 || (c5Net <= -0.30 && move1mPct <= -0.15) || (move1mPct <= -0.20 && c5Net <= -0.20));



  // 3. Are the past 5 candles coiled in a tight consolidation base? (Unpriced news runway)

  const is5CandlesTight = (effectiveC5Range <= 0.45 && Math.abs(c5Net) <= 0.35 && Math.abs(priorMove) <= 0.50);



  // Condition 1A: Check if already surged / priced in ("First, you want to check it moved, meaning you don't take the trade.")
  // User directive: If stock already surged or is heavily extended ahead of positive news,
  // DO NOT CHASE, DO NOT TAKE TRADE! NEVER convert positive news into a short call ("When you sell it goes up")!
  const hasRealTape5Bars = Array.isArray(last5Bars) && last5Bars.length >= 5;
  const isBlowoutBeatCatalyst = Boolean(
    catalyst.category === 'QUARTERLY_RESULTS' ||
    catalyst.materiality === 'RESULTS' ||
    /quarterly\s+results?|financial\s+results?|net\s+profit\s+(?:more\s+than\s+doubles|jumps|surges|doubles|\d+%)|pat\s+(?:jumps|up|doubles)|press\s+release.*?financial\s+results/i.test((catalyst.title || '') + ' ' + (catalyst.description || ''))
  );

  // During active market hours with real 5-minute bars, check if momentum has stalled after a surge
  const surgeCutoff = isBlowoutBeatCatalyst ? 6.5 : 3.5;
  const isStallingAfterSurge = isMarketHours && hasRealTape5Bars && (move5mPct >= surgeCutoff || c5Net >= surgeCutoff) && Math.abs(move1mPct) <= 0.10;
  const isSevereOverextension = isMarketHours && hasRealTape5Bars
    ? (movePct >= surgeCutoff && move1mPct < 0.20)
    : (movePct >= 7.5 || c5Net >= 7.5);

  const hasAlreadyMoved = (hasRealTape5Bars && is5CandlesHuge) || isStallingAfterSurge || isSevereOverextension;

  if (isPositiveHeadline && hasAlreadyMoved) {

    return {

      prediction: 'DO NOT CHASE / ALREADY MOVED',

      bias: 'NEUTRAL',

      confidence: 30,

      takeTrade: false,

      tradeStatus: 'ALREADY_MOVED',

      badge: `🚫 ALREADY MOVED (+${(c5Net || move5mPct || movePct || 2.0).toFixed(1)}%)`,

      actionBtnClass: 'btn-trade-warn',

      actionBtnLabel: 'Already Moved (Do Not Chase)',

      rationale: `Past 5 candles already surged +${(c5Net || move5mPct || movePct || 2.0).toFixed(1)}%. Positive catalyst was already absorbed by earlier candles. DO NOT TAKE TRADE to avoid top-chasing trap.`

    };

  }



  // Condition 1B: 5-CANDLE DUMP / TAPE REJECTION

  if (hasTapeData && (is5CandlesDumping || (move1mPct <= -0.20 && (move5mPct <= -0.30 || movePct < 0)))) {

    const dropDesc = `${c5Net.toFixed(2)}% 5m${move1mPct ? `, ${move1mPct.toFixed(2)}% 1m` : ''}`;

    return {

      prediction: 'SELL / FADE',

      bias: 'BEARISH',

      confidence: 85,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE_SHORT',

      badge: (mat === 'RESULTS' || isResultsFiling) ? '📉 RESULTS SELL-OFF (SYRMA EFFECT)' : '⚡ GIVE SELL (TAPE DUMP)',

      actionBtnClass: 'btn-trade-sell',

      actionBtnLabel: 'Take Short / Fade (85%)',

      rationale: `5-Candle Dump: Tape is actively falling (${dropDesc}) despite headline. Sellers dumping into catalyst; GIVE SELL / SHORT.`

    };

  }



  // Condition 2: STRICT DIRECTIONAL TAPE REJECTION (Active Market Hours Only)

  if (isMarketHours && hasTapeData && (move5mPct <= -0.50 || (move1mPct <= -0.20 && move5mPct <= -0.30) || (movePct < -0.30 && move1mPct <= -0.10))) {

    const drop1m = move1mPct ? `${move1mPct.toFixed(2)}% 1m` : '';

    const drop5m = move5mPct ? `${move5mPct.toFixed(2)}% 5m` : '';

    const dropDesc = [drop1m, drop5m].filter(Boolean).join(', ');

    return {

      prediction: 'SELL / FADE',

      bias: 'BEARISH',

      confidence: 85,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE_SHORT',

      badge: (mat === 'RESULTS' || isResultsFiling) ? '📉 RESULTS SELL-OFF (SYRMA EFFECT)' : '⚡ GIVE SELL (FADE)',

      actionBtnClass: 'btn-trade-sell',

      actionBtnLabel: 'Take Short / Fade',

      rationale: `Tape fading heavily: Stock is actively falling (${dropDesc}) despite news. Sellers dumping into catalyst; GIVE SELL / SHORT.`

    };

  }



  // Condition 3: Low Momentum Post-News (Active Market Hours Only — applies to resting red ticks or stale news > 10m)

  // For overnight catalysts evaluated during the opening window (09:15 - 09:30),

  // their market trading clock starts at 09:15 AM!

  const isOvernightFiling = catalyst.ts && (catalyst.ts < todayIstMidnight) && (catalyst.ts >= postCloseCutoffMs);

  const sessionElapsedMs = (opts && opts.sessionElapsedMs !== undefined)

    ? Number(opts.sessionElapsedMs)

    : Math.max(0, nowUtc - sessionOpenMs);



  const effectiveAgeMs = (isOvernightFiling && isOpeningWindow)

    ? (opts && opts.sessionElapsedMs !== undefined ? sessionElapsedMs : Math.min(sessionElapsedMs, 5 * 60 * 1000))

    : (catalyst.ts ? Math.max(0, nowUtc - Number(catalyst.ts)) : 999999);



  const isBreakingFresh = catalyst.ts && (effectiveAgeMs < 10 * 60 * 1000) && move1mPct >= 0;

  const isHighImpactCatalyst = (mat === 'ORDER' || mat === 'RESULTS' || mat === 'SALES_UPDATE' || (finComp && finComp.hasFinancialData && finComp.strengthGrade !== 'SEVERE_MISS' && finComp.strengthGrade !== 'FLAT_DISAPPOINTING'));

  const isDumpFading = (move1mPct < -0.20 || move5mPct < -0.50);



  if (isMarketHours && isPositiveHeadline && hasTapeData && !isBreakingFresh && !(move1mPct >= 0.15 || move5mPct >= 0.30)) {

    if (isHighImpactCatalyst && !isDumpFading) {

      let conf = is5CandlesTight ? 88 : 85;

      if (finComp && finComp.hasFinancialData) {

        if (finComp.strengthGrade === 'BLOWOUT_BEAT' || (finComp.order && finComp.order.tier === 'MEGA_ORDER')) {

          conf = Math.max(conf, finComp.convictionProb || 92);

        } else if (finComp.strengthGrade === 'SOLID_BEAT') {

          conf = Math.max(conf, finComp.convictionProb || 86);

        }

      }

      return {

        prediction: 'BUY / GO UP',

        bias: 'BULLISH',

        confidence: conf,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_BUY',

        badge: mat === 'ORDER' ? '⚡ ORDER WIN BUY' : (mat === 'RESULTS' ? '⚡ EARNINGS BEAT BUY' : '⚡ HIGH CONVICTION BUY'),

        actionBtnClass: 'btn-trade-buy',

        actionBtnLabel: `Buy ${conf}%`,

        recommendation: 'STRONG BUY',

        targetPct: 2.0,

        stopLossPct: -0.6,

        rationale: `High-impact ${mat === 'ORDER' ? 'order win' : 'catalyst'} basing cleanly post-filing. Pristine entry on consolidation before continuation.`

      };

    }



    return {

      prediction: 'NEUTRAL / LOW MOMENTUM',

      bias: 'NEUTRAL',

      confidence: 40,

      takeTrade: false,

      tradeStatus: 'DO_NOT_TRADE_LOW_MOMENTUM',

      badge: '⏳ DO NOT TRADE (LOW MOMENTUM)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Observing Tape',

      rationale: `Low momentum post-news: Stock is flat or lacking thrust (${move1mPct > 0 ? '+' : ''}${move1mPct.toFixed(2)}% 1m, ${move5mPct > 0 ? '+' : ''}${move5mPct.toFixed(2)}% 5m). Avoid sluggish chop.`

    };

  }



  // Condition 4: Genuine Unpriced Breakout / Confirmed Momentum / Breaking News -> TAKE TRADE (Active Market Hours)

  if (isPositiveHeadline && (isBreakingFresh || (hasTapeData && (move1mPct >= 0.15 || move5mPct >= 0.30)) || !hasTapeData)) {

    const thrustMsg = move5mPct >= 0.30 ? `+${move5mPct.toFixed(2)}% 5m` : `+${move1mPct.toFixed(2)}% 1m`;

    const isUnpricedEntry = isBreakingFresh && Math.abs(move1mPct) <= 0.10 && Math.abs(move5mPct) <= 0.15;

    const isCoiledBase = is5CandlesTight;

    let conf = isCoiledBase ? 88 : (isUnpricedEntry ? 87 : 85);

    if (finComp.hasFinancialData) {

      if (finComp.strengthGrade === 'BLOWOUT_BEAT' || finComp.order.tier === 'MEGA_ORDER') {

        conf = Math.max(conf, finComp.convictionProb || 92);

      } else if (finComp.strengthGrade === 'SOLID_BEAT') {

        conf = Math.max(conf, finComp.convictionProb || 86);

      }

    }

    const badgeLabel = isGenuineMA ? '💼 STRATEGIC M&A' : ((finComp.strengthGrade === 'BLOWOUT_BEAT') ? '🚀 BLOWOUT BEAT' : (isUnpricedEntry ? '⚡ LIVE BUY (PRE-MOVE RUNWAY)' : (isCoiledBase ? '⚡ STRONG BUY (UNPRICED 5M BASE)' : '⚡ TAKE TRADE: BUY')));

    const actionLabel = isUnpricedEntry ? `Buy (Pre-Move ${conf}%)` : `Strong Buy (${conf}%)`;

    const rationaleText = isUnpricedEntry

      ? `Breaking Unpriced Catalyst: Disclosed ${Math.max(1, Math.round(effectiveAgeMs / 1000))}s ago. Stock has not moved yet (0.00% pre-move runway); prime low-risk institutional entry before algorithmic momentum surge.`

      : (isCoiledBase

        ? `Unpriced Fresh Catalyst: Past 5 candles coiled tight in base (range ${effectiveC5Range.toFixed(2)}%). Pure institutional runway with high-probability breakout continuation (${conf}%).`

        : `Fresh breakout: Strong post-filing thrust (${thrustMsg}) with low prior runup (+${priorMove.toFixed(1)}%). High probability continuation (${conf}%).`);

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: conf,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE',

      badge: badgeLabel,

      actionBtnClass: 'btn-trade-buy',

      actionBtnLabel: actionLabel,

      recommendation: 'STRONG BUY',

      targetPct: 2.0,

      stopLossPct: -0.6,

      rationale: rationaleText,

      financialComparison: finComp

    };

  }







  // Condition 5: Breaking News Awaiting Volume Burst (< 3 minutes old during market hours)

  if (isMarketHours && hasTapeData && isPositiveHeadline && catalyst.ts && (Date.now() - catalyst.ts) < 180000) {

    return {

      prediction: 'WATCH / AWAITING BURST',

      bias: 'BULLISH',

      confidence: 60,

      takeTrade: false,

      tradeStatus: 'AWAITING_BURST',

      badge: '👀 AWAITING BURST',

      rationale: `Breaking news just filed (${catalyst.filingTime || 'live'}) — awaiting 1m volume burst confirmation above VWAP before entry.`

    };

  }



  // 2. High-conviction Positive / Bullish conditions -> BUY / GO UP (Outside market hours or unpriced base)

  // 2. High-conviction Positive / Bullish conditions -> BUY / GO UP (Outside market hours or unpriced base)

  if (isOrderOrContract) {

    // SCOPE-ADJUSTED CONFIDENCE (2026-10-29): Order wins are NOT all equal.

    // A Rs 5,000 Cr defence contract is a major catalyst; a Rs 25 Cr local work

    // order barely moves a large-cap. Scale the probability by the stated value:

    //

    //   >= 1000 Cr  -> 90%  (market-moving: defence, infra, large corporate)

    //   >= 200 Cr   -> 85%  (meaningful mid-size order)

    //   >= 50 Cr    -> 78%  (moderate, still material for a small-cap)

    //   < 50 Cr     -> 68%  (small order; limited scope, await volume confirm)

    //   no value stated -> 75% (unknown size: treat as moderate, not large)

    //

    // These thresholds are first-principles adjustments. A future event study

    // (newsEventStudy.js segmented by crore band) should replace them with

    // measured hit rates per size tier.

    let orderRationale = 'Order win / contract award filing (size not stated). Treating as moderate scope; await morning tape confirmation.';

    let orderConfidence = 75; // default: no crore value found in filing

    const croreMatch = fullText.match(/(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i);

    if (croreMatch && croreMatch[1]) {

      const croreVal = Number(String(croreMatch[1]).replace(/,/g, ''));

      if (croreVal >= 1000) {

        orderConfidence = 90;

        orderRationale = `Major order win worth Rs ${croreMatch[1]} Cr (>=1000 Cr) — large-scale market-moving contract. High probability of continuation.`;

      } else if (croreVal >= 200) {

        orderConfidence = 85;

        orderRationale = `Significant order win worth Rs ${croreMatch[1]} Cr (>=200 Cr) — meaningful catalyst for mid-cap. Strong momentum probability.`;

      } else if (croreVal >= 50) {

        orderConfidence = 78;

        orderRationale = `Moderate order win worth Rs ${croreMatch[1]} Cr (>=50 Cr) — material for small/mid-cap. Moderate probability of continuation.`;

      } else {

        orderConfidence = 68;

        orderRationale = `Small order win worth Rs ${croreMatch[1]} Cr (<50 Cr) — limited scope. Reduced confidence; await volume confirmation before entry.`;

      }

    }

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: orderConfidence,

      takeTrade: orderConfidence >= 75,

      tradeStatus: orderConfidence >= 75 ? 'TAKE_TRADE' : 'NEUTRAL_WATCH',

      badge: orderConfidence >= 85 ? '📬 MAJOR ORDER WIN' : (orderConfidence >= 75 ? '📬 ORDER WIN' : '📬 SMALL ORDER (WATCH)'),

      rationale: orderRationale,

      orderCrore: croreMatch ? Number(String(croreMatch[1]).replace(/,/g, '')) : null,

    };

  }



  if (isDemerger) {

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: 85,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE',

      badge: '💼 STRATEGIC M&A',

      rationale: 'Scheme of Demerger / Restructuring regulatory clearance. Major structural value-unlock catalyst.'

    };

  }



  if (mat === 'CORPORATE_ACTION' && isGenuineMA) {

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: 80,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE',

      badge: '💼 STRATEGIC M&A',

      rationale: 'Strategic corporate acquisition or restructuring (merger/takeover/stake buy). Expansion impulse.'

    };

  }



  if (isCapacityOrCommercial) {

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: 80,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE',

      badge: '🏭 EXPANSION / PRODUCTION',

      rationale: 'Commencement of commercial production or major capacity expansion. Direct revenue impulse.'

    };

  }



  if (mat === 'RATING' && (kind.includes('upgrade') || title.includes('upgrade'))) {

    return {

      prediction: 'WATCH / CREDIT UPGRADE',

      bias: 'BULLISH',

      confidence: 65,

      takeTrade: false,

      tradeStatus: 'NEUTRAL_WATCH',

      badge: '⭐ CREDIT UPGRADE',

      rationale: 'Credit rating upgraded. Lowers cost of capital, but await confirmed morning tape volume before entry.'

    };

  }



  if ((mat === 'CAPITAL' || isDividendOrCapital) && (title.includes('dividend') || kind.includes('dividend') || fullText.includes('dividend') || title.includes('bonus') || title.includes('qip'))) {

    const postNewsPct = opts.postNewsMovePct != null ? Number(opts.postNewsMovePct) : (catalyst.postNewsMovePct != null ? Number(catalyst.postNewsMovePct) : null);

    const isTapeDumping = hasTapeData && (move1mPct <= -0.15 || move5mPct <= -0.30);

    const hasPostDrop = postNewsPct != null && postNewsPct <= -0.30;

    const isPrePumpedExhaustion = (priorMove >= 3.5 || c5Net >= 3.5) && (isTapeDumping || hasPostDrop);

    if (isTapeDumping || hasPostDrop || isPrePumpedExhaustion) {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 85,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 DIVIDEND/BONUS FADE (INNOVACAP EFFECT)',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short / Fade (85%)',

        recommendation: 'STRONG SELL / FADE',

        targetPct: -2.0,

        stopLossPct: 0.6,

        rationale: `InnovaCaptab Pattern: Dividend/bonus announcement met with post-news distribution / operator profit taking; take short / fade.`

      };

    }

    return {

      prediction: 'BUY / GO UP',

      bias: 'BULLISH',

      confidence: 82,

      takeTrade: true,

      tradeStatus: 'TAKE_TRADE_BUY',

      badge: '💰 DIVIDEND / CAPITAL SURGE',

      actionBtnClass: 'btn-trade-buy',

      actionBtnLabel: 'Buy (82%)',

      recommendation: 'STRONG BUY',

      targetPct: 2.2,

      stopLossPct: -0.6,

      rationale: `Shareholder return catalyst (dividend/bonus/capital action). Stock displaying positive reaction (+${(postNewsPct != null ? postNewsPct : movePct).toFixed(1)}%); high probability continuation.`

    };

  }



  // 2b. SALES UPDATE (Monthly Auto/Business Sales, Turnover & Volume Updates)

  if (mat === 'SALES_UPDATE' || fullText.includes('monthly business update') || fullText.includes('monthly sales') || (fullText.includes('business update') && fullText.includes('month of')) || fullText.includes('production and offtake') || (fullText.includes('production') && fullText.includes('month of')) || (fullText.includes('turnover') && fullText.includes('month of'))) {

    const isSalesDrop = (

      fullText.includes('decline') ||

      fullText.includes('drop') ||

      fullText.includes('slump') ||

      fullText.includes('fall') ||

      opts.move5mPct <= -0.50

    );



    if (isSalesDrop) {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 80,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 SALES SLUMP',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short (80%)',

        targetMovePct: -2.5,

        targetPct: -2.5,

        stopLossPct: 1.0,

        recommendation: 'SHORT / FADE',

        rationale: 'Monthly sales volume decline. Institutional selling pressure expected.'

      };

    }



    // Default for breaking monthly auto/business updates: Highly tradeable long catalyst!

    const isTapeFalling = (opts.move5mPct <= -0.40 || (opts.move1mPct <= -0.20 && opts.move5mPct <= -0.30));

    if (!isTapeFalling) {

      return {

        prediction: 'BUY / GO UP',

        bias: 'BULLISH',

        confidence: 85,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_BUY',

        badge: '🚀 SALES VOLUME SURGE',

        actionBtnClass: 'btn-trade-buy',

        actionBtnLabel: 'Take Trade (Buy 85%)',

        targetMovePct: 3.5,

        targetPct: 3.5,

        stopLossPct: 1.2,

        recommendation: 'STRONG BUY (RECORD SALES)',

        rationale: 'Monthly business update / sales volume record. Strong operational turnover growth catalyst.'

      };

    } else {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 80,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 SALES DUMP (FADE)',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short / Fade (80%)',

        targetMovePct: -2.0,

        targetPct: -2.0,

        stopLossPct: 0.6,

        recommendation: 'STRONG SELL / FADE',

        rationale: `Monthly business update met with selling pressure (${opts.move1mPct ? `${opts.move1mPct}% 1m, ` : ''}${opts.move5mPct ? `${opts.move5mPct}% 5m` : ''}). Institutional dump into update; take short / fade.`

      };

    }

  }



  // 3. RESULTS (Financial Earnings)

  if (mat === 'RESULTS' || kind.includes('financial result') || title.includes('financial result')) {

    // Quantitative Comparison of Current vs Old (EBITDA, Margins, PAT, Revenue)

    const finComp = financialComparison.parseFinancialComparison(fullText, title);

    if (finComp.hasFinancialData) {

      if (finComp.strengthGrade === 'BLOWOUT_BEAT') {

        return {

          prediction: 'BUY / GO UP',

          bias: 'BULLISH',

          confidence: finComp.convictionProb || 92,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE',

          badge: '🚀 BLOWOUT BEAT',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: `Strong Buy (${finComp.convictionProb || 92}%)`,

          rationale: `Blowout financial beat: ${finComp.comparisonSummary}. Massive quantitative expansion over prior period.`,

          financialComparison: finComp

        };

      } else if (finComp.strengthGrade === 'SOLID_BEAT') {

        return {

          prediction: 'BUY / GO UP',

          bias: 'BULLISH',

          confidence: finComp.convictionProb || 86,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE',

          badge: '📈 SOLID BEAT',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: `Strong Buy (${finComp.convictionProb || 86}%)`,

          rationale: `Solid financial beat: ${finComp.comparisonSummary}. Healthy growth over prior year.`,

          financialComparison: finComp

        };

      } else if (finComp.strengthGrade === 'SEVERE_MISS') {

        return {

          prediction: 'SELL / FADE',

          bias: 'BEARISH',

          confidence: finComp.convictionProb || 88,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE_SHORT',

          badge: '📉 SEVERE EARNINGS MISS',

          actionBtnClass: 'btn-trade-sell',

          actionBtnLabel: `Take Short (${finComp.convictionProb || 88}%)`,

          rationale: `Severe earnings miss: ${finComp.comparisonSummary}. Fundamental breakdown vs prior year; strong institutional selling pressure.`,

          financialComparison: finComp

        };

      } else if (finComp.strengthGrade === 'FLAT_DISAPPOINTING') {

        const hasPostNewsThrust = isMarketHours && hasTapeData && (Number(opts.move1mPct || 0) >= 0.25 || Number(opts.move5mPct || 0) >= 0.45);

        if (hasPostNewsThrust) {

          return {

            prediction: 'BUY / GO UP',

            bias: 'BULLISH',

            confidence: 80,

            takeTrade: true,

            tradeStatus: 'TAKE_TRADE_BUY',

            badge: '🚀 RELIEF RALLY (PRICE ACTION OVERRIDE)',

            actionBtnClass: 'btn-trade-buy',

            actionBtnLabel: 'Take Trade (Relief Buy 80%)',

            targetMovePct: 3.5,

            targetPct: 1.8,

            stopLossPct: -0.6,

            recommendation: 'STRONG BUY (RELIEF BREAKOUT)',

            rationale: `Average/tepid results (${finComp.comparisonSummary}) met with powerful institutional buying thrust (+${opts.move1mPct}% 1m). Price action overrules average headline; trade relief breakout.`,

            financialComparison: finComp

          };

        }

        return {

          prediction: 'DO NOT CHASE / TEPID RESULTS',

          bias: 'NEUTRAL',

          confidence: finComp.convictionProb || 35,

          takeTrade: false,

          tradeStatus: 'FLAT_DISAPPOINTING',

          badge: '⏳ FLAT / TEPID (DO NOT CHASE)',

          actionBtnClass: 'btn-trade-warn',

          actionBtnLabel: 'Flat Results (Do Not Chase)',

          rationale: `Tepid results: ${finComp.comparisonSummary}. Flat growth or compressed margins; lacks strength to justify institutional entry.`,

          financialComparison: finComp

        };

      }

    }



    // Check for negative cues in title

    if (title.includes('loss') || title.includes('decline') || title.includes('drop') || title.includes('slump')) {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 80,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 EARNINGS MISS',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short (80%)',

        recommendation: 'STRONG SELL / FADE',

        targetPct: -1.8,

        stopLossPct: 0.6,

        rationale: 'Earnings headline indicates contraction or loss — expect selling pressure.'

      };

    }

    // 0. Newspaper Reprints / Board Meeting notices / Transcripts are NEVER actionable results!

    if (isNewspaperResults || isBoardMeetingNotice || isConcallTranscript || isSastOrShareholdingDisclosure) {

      return {

        prediction: 'NEUTRAL / ROUTINE DISCLOSURE',

        bias: 'NEUTRAL',

        confidence: 15,

        takeTrade: false,

        tradeStatus: 'ROUTINE_DISCLOSURE',

        badge: '📄 ROUTINE DISCLOSURE',

        actionBtnClass: 'btn-trade-watch',

        actionBtnLabel: 'Routine',

        recommendation: 'AVOID / WATCH',

        rationale: 'Routine administrative disclosure or scheduled notice. 0.00% edge; trade calls strictly refused.'

      };

    }



    const postNewsPct = opts.postNewsMovePct != null ? Number(opts.postNewsMovePct) : null;

    const ageMs = catalyst.ts ? (Date.now() - Number(catalyst.ts)) : 999999;

    const isTapeFlat = (postNewsPct != null ? Math.abs(postNewsPct) <= 0.15 : (Math.abs(move1mPct) <= 0.10 && Math.abs(move5mPct) <= 0.15));



    // 1. High-conviction positive cues: Explicit beat or growth metrics in title/text

    const hasExplicitBeat = (

      title.includes('record') || title.includes('growth') || title.includes('jump') ||

      title.includes('beat') || title.includes('surge') ||

      /(\d+(?:\.\d+)?)\s*%\s*(?:jump|growth|surge|increase|up)/i.test(fullText) ||

      (finComp && (finComp.strengthGrade === 'BLOWOUT_BEAT' || finComp.strengthGrade === 'SOLID_BEAT'))

    );



    // 2. Pre-News Price Action Check (stock was already run up BEFORE the filing)

    const preFilingMove = (opts.priceAtFiling && opts.open && opts.open > 0)

      ? (((opts.priceAtFiling - opts.open) / opts.open) * 100)

      : (postNewsPct != null ? (movePct - postNewsPct) : (c5Net || movePct || priorMove));

    const isPrePumpedResults = (c5Net >= 2.0 || (move5mPct >= 1.8 && move1mPct <= 0.05)) && (postNewsPct != null ? postNewsPct <= 0.20 : (move1mPct <= 0.05 && move5mPct <= 0.10));



    if (isPrePumpedResults) {

      return {

        prediction: 'ALREADY MOVED / PRICED IN',

        bias: 'NEUTRAL',

        confidence: 40,

        takeTrade: false,

        tradeStatus: 'ALREADY_MOVED',

        badge: '🚫 RESULTS PRICED IN (DO NOT CHASE)',

        actionBtnClass: 'btn-trade-watch',

        actionBtnLabel: 'Avoid (Priced In)',

        recommendation: 'DO NOT CHASE',

        rationale: `Stock was heavily run up (+${(c5Net || move5mPct || preFilingMove).toFixed(1)}%) immediately leading into results. Numbers are priced in; avoid buying at the top.`

      };

    }



    // 3. Post-News Surging Tape -> DIXON PATTERN (Take Trade Buy)

    const isTapeSurgingResults = (

      (postNewsPct != null && postNewsPct >= 0.20) ||

      (move1mPct >= 0.15 && move5mPct >= 0.25) ||

      (!isMarketHours && gapPct >= 0.40)

    );

    if (isTapeSurgingResults) {

      return {

        prediction: 'BUY / GO UP',

        bias: 'BULLISH',

        confidence: 85,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_BUY',

        badge: '🚀 RESULTS BREAKOUT (DIXON EFFECT)',

        actionBtnClass: 'btn-trade-buy',

        actionBtnLabel: 'Take Trade (Buy 85%)',

        recommendation: 'STRONG BUY',

        targetPct: 2.0,

        stopLossPct: -0.6,

        rationale: `Dixon Pattern (Price Action Override): Results met with buying momentum (${postNewsPct != null ? `post-news +${postNewsPct}%, ` : ''}+${(move1mPct || gapPct || move5mPct).toFixed(1)}%). Short covering & relief breakout; take buy.`

      };

    }



    // 4. Post-News Dumping Tape -> SYRMA PATTERN (Take Trade Short)

    // MUST be strictly based on post-news selling dump, NEVER on morning drift!

    const isTapeDumpingResults = (

      (postNewsPct != null && postNewsPct <= -0.20) ||

      (move1mPct <= -0.15 && move5mPct <= -0.30) ||

      (!isMarketHours && gapPct <= -0.40)

    );

    if (isTapeDumpingResults) {

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: 85,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '📉 RESULTS SELL-OFF (SYRMA EFFECT)',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: 'Take Short / Fade (85%)',

        recommendation: 'STRONG SELL / FADE',

        targetPct: -1.8,

        stopLossPct: 0.6,

        rationale: `Syrma Pattern (Price Action Override): Results met with falling tape (${postNewsPct != null ? `post-news ${postNewsPct}%, ` : ''}${move1mPct ? `${move1mPct}% 1m, ` : ''}${move5mPct ? `${move5mPct}% 5m` : ''}). Institutional dump into announcement; take short / fade.`

      };

    }



    // 5. Fresh results inside 10-minute window with unreacted flat tape (0.00% Pre-Move Runway)

    if (isMarketHours && hasTapeData && ageMs < 10 * 60 * 1000 && isTapeFlat) {

      if (hasExplicitBeat) {

        return {

          prediction: 'BUY / GO UP',

          bias: 'BULLISH',

          confidence: 86,

          takeTrade: true,

          tradeStatus: 'TAKE_TRADE',

          badge: '⚡ LIVE BUY (PRE-MOVE RUNWAY)',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: 'Buy (Pre-Move 86%)',

          recommendation: 'STRONG BUY',

          targetPct: 2.0,

          stopLossPct: -0.6,

          rationale: `Fresh Quarterly Results: Disclosed ${Math.max(1, Math.round(ageMs / 1000))}s ago with beat metrics. Stock tape has not reacted yet (0.00% pre-move runway); prime unpriced entry before algorithmic surge.`,

          financialComparison: finComp

        };

      }

      return {

        prediction: 'STANDBY / OBSERVING 10M TAPE',

        bias: 'NEUTRAL',

        confidence: 60,

        takeTrade: false,

        tradeStatus: 'OBSERVING_POST_NEWS_TAPE',

        badge: '⏳ OBSERVING 10M TAPE',

        actionBtnClass: 'btn-trade-watch',

        actionBtnLabel: '10m Tape Watch',

        recommendation: 'AWAITING 10M TAPE BREAK',

        rationale: 'Moral of the Story: Do not rush unconfirmed numbers. Awaiting 1m/5m tape confirmation: BUY on green breakout (+0.15%), SHORT on red dump (-0.15%).',

        financialComparison: finComp

      };

    }



    // 6. Explicit Beat with unreacted tape beyond 5 minutes

    if (hasExplicitBeat) {

      return {

        prediction: 'BUY / GO UP',

        bias: 'BULLISH',

        confidence: 85,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE',

        badge: '🚀 EARNINGS BEAT',

        actionBtnClass: 'btn-trade-buy',

        actionBtnLabel: 'Take Trade (Buy 85%)',

        recommendation: 'STRONG BUY',

        targetPct: 2.5,

        stopLossPct: -0.8,

        rationale: 'Financial results headline confirms explicit growth/beat. Prime candidate for morning impulse scalping.'

      };

    }



    // 7. Fresh results inside 15-minute post-news observation window

    if (isMarketHours && hasTapeData && catalyst.ts && (Date.now() - Number(catalyst.ts)) < 15 * 60 * 1000) {

      return {

        prediction: 'STANDBY / OBSERVING 10M TAPE',

        bias: 'NEUTRAL',

        confidence: 60,

        takeTrade: false,

        tradeStatus: 'OBSERVING_POST_NEWS_TAPE',

        badge: '⏳ OBSERVING 10M TAPE',

        actionBtnClass: 'btn-trade-watch',

        actionBtnLabel: '10m Tape Watch',

        recommendation: 'AWAITING 10M TAPE BREAK',

        rationale: 'Moral of the Story: Do not rush unconfirmed numbers. Awaiting 1m/5m tape confirmation: BUY on green breakout (+0.10%), SHORT on red dump (-0.10%).'

      };

    }



    return {

      prediction: 'NEUTRAL / UNCERTAIN RESULTS',

      bias: 'NEUTRAL',

      confidence: 45,

      takeTrade: false,

      tradeStatus: 'RESULTS_UNCERTAIN',

      badge: '📊 RESULTS (UNCERTAIN)',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Watch',

      rationale: 'Quarterly results filing without verified beat or price breakout. Event study shows only 40.1% win rate (-0.30% drift); avoid unconfirmed results.'

    };

  }



  // 4. Directional Price Action & Tape Confirmation for Corporate Catalysts

  const postNewsPct = opts.postNewsMovePct != null ? Number(opts.postNewsMovePct) : null;

  const dayMove = Number((opts.changePct != null && opts.changePct !== 0) ? opts.changePct : (opts.movePct || 0));

  const isNegativeMove = (dayMove <= -0.70 || (postNewsPct != null && postNewsPct <= -0.25) || (move1mPct <= -0.15 && move5mPct <= -0.25));

  const isPositiveMove = (dayMove >= 0.70 || (postNewsPct != null && postNewsPct >= 0.25) || (move1mPct >= 0.15 && move5mPct >= 0.25));



  if (!isRoutine) {

    if (isNegativeMove) {

      const conf = Math.max(76, Math.min(90, 75 + Math.round(Math.abs(dayMove))));

      return {

        prediction: 'SELL / FADE',

        bias: 'BEARISH',

        confidence: conf,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_SHORT',

        badge: '🔻 BEARISH SELL / FADE',

        actionBtnClass: 'btn-trade-sell',

        actionBtnLabel: `Sell ${conf}%`,

        recommendation: 'STRONG SELL / FADE',

        targetPct: -1.8,

        stopLossPct: 0.6,

        rationale: `Stock experiencing negative price action post-announcement (${dayMove ? `${dayMove.toFixed(1)}% Day` : ''}${postNewsPct != null ? ` · Post-news ${postNewsPct.toFixed(1)}%` : ''}). Downside drift expected.`

      };

    }



    if (isPositiveMove) {

      const conf = Math.max(78, Math.min(92, 75 + Math.round(dayMove)));

      return {

        prediction: 'BUY / GO UP',

        bias: 'BULLISH',

        confidence: conf,

        takeTrade: true,

        tradeStatus: 'TAKE_TRADE_BUY',

        badge: '⚡ BULLISH BUY',

        actionBtnClass: 'btn-trade-buy',

        actionBtnLabel: `Buy ${conf}%`,

        recommendation: 'STRONG BUY',

        targetPct: 2.0,

        stopLossPct: -0.6,

        rationale: `Stock experiencing positive buying velocity post-announcement (${dayMove ? `+${dayMove.toFixed(1)}% Day` : ''}${postNewsPct != null ? ` · Post-news +${postNewsPct.toFixed(1)}%` : ''}). Institutional demand confirmed.`

      };

    }

  }



  // 5. Default / Routine / Neutral

  return {

    prediction: 'NEUTRAL / WATCH',

    bias: 'NEUTRAL',

    confidence: 40,

    takeTrade: false,

    tradeStatus: 'NEUTRAL_WATCH',

    badge: '⏳ NEUTRAL / WATCH',

    actionBtnClass: 'btn-trade-watch',

    actionBtnLabel: 'Watch',

    rationale: 'Filing within normal consolidation range. Await confirmed directional breakout.'

  };

}



/**

 * Public Predictor with 23-Feature Gradient Boosted ML Scoring

 * Evaluates the structural decision rules + historical ML probability.

 */

/**

 * Enriches predicted catalyst with exact 5-candle trade geometry:

 * - recommendation: STRONG BUY | GOOD BUY | STRONG SELL / FADE | GOOD SELL / FADE | DO NOT CHASE

 * - probability: Integer % win rate

 * - fiveCandleVerdict: 1-sentence analytical verdict on 5-candle state

 * - targetPrice, stopLossPrice, targetPct, stopLossPct, rrRatio

 */

function enrichCatalystTradeGeometry(res, catalyst, opts = {}) {

  if (!res) return res;

  const price = Number(opts.price || (catalyst && (catalyst.ltp || catalyst.close || catalyst.price)) || 0);

  const c5Net = Number(opts.move5mPct || 0);

  const c5Range = Number(opts.range5mPct || opts.fiveCandleRangePct || 0);

  const effRange = c5Range > 0 ? c5Range : Math.abs(c5Net);

  const priorMove = Number(opts.changePct != null && opts.changePct !== 0 ? opts.changePct : (opts.movePct || 0));



  let fiveCandleVerdict = '';

  let fiveCandleState = 'NORMAL';



  if (c5Net >= 1.2 || effRange >= 1.5) {

    fiveCandleState = 'HUGE_RUNUP';

    fiveCandleVerdict = `Past 5 candles HUGE (+${c5Net.toFixed(1)}% move, range ${effRange.toFixed(1)}%). Move was ALREADY TAKEN by earlier candles.`;

  } else if (c5Net <= -0.50 || (c5Net <= -0.30 && Number(opts.move1mPct || 0) <= -0.15)) {

    fiveCandleState = 'HEAVY_DUMP';

    fiveCandleVerdict = `Past 5 candles DUMPING (${c5Net.toFixed(2)}% 5m). Strong selling pressure overrides catalyst.`;

  } else if (effRange <= 0.45 && Math.abs(c5Net) <= 0.35 && Math.abs(priorMove) <= 0.50) {

    fiveCandleState = 'TIGHT_BASE';

    fiveCandleVerdict = `Past 5 candles TIGHT BASE (range ${effRange.toFixed(2)}%). Unpriced fresh catalyst with pristine runway.`;

  } else {

    fiveCandleState = 'MODERATE';

    fiveCandleVerdict = `Past 5 candles moderate (${c5Net > 0 ? '+' : ''}${c5Net.toFixed(2)}% 5m). Directional confirmation required.`;

  }



  const fullText = (catalyst && ((catalyst.title || '') + ' ' + (catalyst.text || catalyst.description || ''))) || '';

  const finComp = res.financialComparison || financialComparison.parseFinancialComparison(fullText, catalyst ? catalyst.title : '');

  res.financialComparison = finComp;

  res.strengthGrade = finComp.strengthGrade;

  res.strengthScore = finComp.strengthScore;

  res.comparisonSummary = finComp.comparisonSummary;



  if (finComp && finComp.hasFinancialData) {

    if (finComp.strengthGrade === 'BLOWOUT_BEAT' || finComp.order.tier === 'MEGA_ORDER') {

      if (res.tradeStatus !== 'ALREADY_MOVED' && res.tradeStatus !== 'HISTORICAL_FADE') {

        res.confidence = Math.max(res.confidence || 0, finComp.convictionProb || 92);

        res.bias = 'BULLISH';

        res.takeTrade = true;

        // The beat branches raised confidence and recommendation but left `prediction`

        // at whatever the filing-only rules said earlier — which is how a stock came out

        // 86% "NEUTRAL / WATCH". The label now follows the score it is shown next to.

        res.prediction = 'BUY / GO UP';

        res.recommendation = 'STRONG BUY';

      }

    } else if (finComp.strengthGrade === 'SOLID_BEAT') {

      if (res.tradeStatus !== 'ALREADY_MOVED' && res.tradeStatus !== 'HISTORICAL_FADE') {

        res.confidence = Math.max(res.confidence || 0, finComp.convictionProb || 86);

        res.bias = 'BULLISH';

        res.takeTrade = true;

        res.prediction = 'BUY / GO UP';

        res.recommendation = 'STRONG BUY';

      }

    } else if (finComp.strengthGrade === 'SEVERE_MISS') {

      res.confidence = Math.max(res.confidence || 0, finComp.convictionProb || 88);

      res.bias = 'BEARISH';

      res.takeTrade = true;

      res.tradeStatus = 'TAKE_TRADE_SHORT';

      res.recommendation = 'STRONG SELL / FADE';

      res.prediction = 'SELL / FADE';

    } else if (finComp.strengthGrade === 'FLAT_DISAPPOINTING') {

      res.confidence = Math.min(res.confidence || 100, finComp.convictionProb || 35);

      res.takeTrade = false;

      res.tradeStatus = 'FLAT_DISAPPOINTING';

      res.recommendation = 'AVOID / WATCH';

    }

  }



  res.fiveCandleState = fiveCandleState;

  res.fiveCandleVerdict = fiveCandleVerdict;

  res.fiveCandleRangePct = effRange;

  res.probability = res.confidence || 50;



  if (res.bias === 'BULLISH' && res.takeTrade) {

    res.recommendation = res.confidence >= 80 ? 'STRONG BUY' : 'GOOD BUY';

    res.targetPct = 1.80;

    res.stopLossPct = -0.60;

    res.rrRatio = '1:3.0';

    res.targetPrice = price > 0 ? +(price * (1 + res.targetPct / 100)).toFixed(2) : null;

    res.stopLossPrice = price > 0 ? +(price * (1 + res.stopLossPct / 100)).toFixed(2) : null;

  } else if (res.bias === 'BEARISH' && res.takeTrade) {

    res.recommendation = res.confidence >= 80 ? 'STRONG SELL / FADE' : 'GOOD SELL / FADE';

    res.targetPct = -1.50;

    res.stopLossPct = 0.50;

    res.rrRatio = '1:3.0';

    res.targetPrice = price > 0 ? +(price * (1 + res.targetPct / 100)).toFixed(2) : null;

    res.stopLossPrice = price > 0 ? +(price * (1 + res.stopLossPct / 100)).toFixed(2) : null;

  } else {

    res.recommendation = (res.tradeStatus === 'ALREADY_MOVED' || (res.prediction && res.prediction.includes('ALREADY MOVED')))

      ? 'DO NOT CHASE / ALREADY MOVED'

      : ((res.tradeStatus === 'HISTORICAL_FADE' || (res.prediction && res.prediction.includes('HISTORICAL FADE')))

        ? 'DO NOT CHASE / HISTORICAL FADE'

        : 'AVOID / WATCH');

    res.targetPct = null;

    res.stopLossPct = null;

    res.targetPrice = null;

    res.stopLossPrice = null;

    res.rrRatio = null;

  }



  return res;

}



function predictCatalyst(catalyst, opts = {})

{

  enrichResultsFilingNumbers(catalyst);

  const res = _predictCatalystRaw(catalyst, opts);

  if (!res || !catalyst) return res;

  // Auto-Learned Failure Guardrail ("It learns why it not moved so next time it not repeat")
  if (autoLearner) {
    try {
      const guard = autoLearner.checkLearnedGuardrail(Object.assign({}, catalyst, opts, { bias: res.bias }));
      if (guard && guard.blocked) {
        return {
          prediction: guard.action === 'FORCE_ROUTINE' ? 'ROUTINE_DISCLOSURE' : 'STANDBY / LEARNED_NON_MOVER',
          bias: 'NEUTRAL',
          confidence: guard.confidenceCap,
          probability: guard.confidenceCap,
          takeTrade: false,
          tradeStatus: guard.action === 'FORCE_ROUTINE' ? 'ROUTINE_DISCLOSURE' : 'NON_MOVER_GUARDRAIL',
          badge: guard.badge,
          actionBtnClass: 'btn-trade-watch',
          actionBtnLabel: 'Learned Dud (Blocked)',
          recommendation: 'AVOID / NON-MOVER',
          targetPct: 0,
          stopLossPct: 0,
          rationale: guard.explanation,
          learnedGuardrail: guard
        };
      }
    } catch (_) {}
  }



  // ML Scoring via 23-Feature Gradient Boosted Trees (trained on 3,319 historical events)

  if (newsMl && catalyst.symbol) {

    try {

      const mat = String(catalyst.materiality || '').toUpperCase();

      const leanCategory = (mat === 'ORDER') ? 'deals'

        : (mat === 'RESULTS' ? 'results'

        : (mat === 'CORPORATE_ACTION' ? 'corporate_action'

        : (mat === 'CAPITAL' ? 'promoter' : 'deals')));

      const dateStr = catalyst.date || (catalyst.ts ? new Date(catalyst.ts + 330 * 60000).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));

      const prior = (opts.changePct != null && opts.changePct !== 0) ? opts.changePct : (opts.movePct || 0);

      const sc = newsMl.scoreLean({

        symbol: catalyst.symbol,

        category: leanCategory,

        lean: res.bias === 'BULLISH' ? 'UP' : (res.bias === 'BEARISH' ? 'DOWN' : 'NEUTRAL'),

        title: catalyst.title || catalyst.headline || '',

        date: dateStr,

        headlines: [catalyst.title || '']

      }, { gapMove: prior || 0 });



      if (sc) {

        res.mlProb = +(sc.p * 100).toFixed(1);

        res.mlHighConviction = sc.highConviction;

        // ML probability calibration (nudges confidence without trade-killing overfitting)

        if (res.bias === 'BULLISH') {

          if (sc.p >= 0.60) res.confidence = Math.min(95, res.confidence + 5);

          else if (sc.p < 0.35) res.confidence = Math.max(70, res.confidence - 5);

        } else if (res.bias === 'BEARISH') {

          if (sc.p <= 0.40) res.confidence = Math.min(95, res.confidence + 5);

          else if (sc.p > 0.65) res.confidence = Math.max(70, res.confidence - 5);

        }

      }

    } catch (_) {}

  }



  // Empirical Historical Reaction Learner ("Learn from old: moved more vs faded")

  if (historicalLearner && catalyst.symbol) {

    try {

      const mat = String(catalyst.materiality || '').toUpperCase();

      const leanCategory = (mat === 'ORDER') ? 'deals'

        : (mat === 'RESULTS' ? 'results'

        : (mat === 'CORPORATE_ACTION' ? 'deals'

        : (mat === 'CAPITAL' ? 'promoter' : (catalyst.category || ''))));

      const hist = historicalLearner.evaluateHistoricalMove({

        symbol: catalyst.symbol,

        category: leanCategory,

        direction: res.bias === 'BULLISH' ? 'UP' : (res.bias === 'BEARISH' ? 'DOWN' : 'NEUTRAL'),

        materiality: mat,

        title: catalyst.title || catalyst.headline || ''

      });



      if (hist && hist.hasEmpiricalData) {

        res.historicalReaction = hist;

        res.historicalVerdict = hist.verdict;

        res.historicalConfidenceDelta = hist.confidenceDelta;



        const hasLiveTapeThrust = (Number(opts.move1mPct || 0) >= 0.15 || Number(opts.move5mPct || 0) >= 0.30);



        if (res.bias === 'BULLISH') {

          if (hist.verdict === 'HISTORICAL_RUNNER') {

            res.confidence = Math.min(95, res.confidence + (hist.confidenceDelta || 6));

            if (res.confidence >= 80 && res.takeTrade) {

              if (!res.badge || res.badge === 'BULLISH' || res.badge.includes('LONG')) { res.badge = hist.badge || res.badge; }

            }

            res.rationale += ` · ${hist.summary}`;

          } else if (hist.verdict === 'HISTORICAL_FADE') {

            // Modulate confidence slightly, but DO NOT overfit or veto genuine positive moves/catalysts!

            res.confidence = Math.max(72, res.confidence - 5);

            res.rationale += ` · Historical category showed lower follow-through (${hist.summary}).`;

          } else if (hist.summary && hist.summary !== 'No statistically significant historical move bias found.') {

            res.rationale += ` · ${hist.summary}`;

          }

        } else if (res.bias === 'BEARISH') {

          if (hist.verdict === 'HISTORICAL_RUNNER' || (hist.companyStats && hist.companyStats.meanMove <= -0.50)) {

            res.confidence = Math.min(95, res.confidence + Math.abs(hist.confidenceDelta || 8));

            res.rationale += ` · ${hist.summary}`;

          } else if (hist.verdict === 'HISTORICAL_FADE') {

            res.confidence = Math.max(70, res.confidence - 5);

            res.rationale += ` · ${hist.summary}`;

          }

        }

      }

    } catch (_) {}

  }

  return enrichCatalystTradeGeometry(res, catalyst, opts);

}





/**

 * Overnight Catalyst Batch (Post-15:30 IST to Next 09:00 AM Open)

 * Collects filings posted from 15:30 IST onwards, checks holiday schedule,

 * and ranks candidates by probability to move UP or DOWN.

 */



let _cachedOvernightBatch = null;

let _cachedOvernightTime = 0;



/**

 * Overnight Catalyst Batch (Post-15:30 IST to Next 09:00 AM Open)

 * Collects filings posted from 15:30 IST onwards, checks holiday schedule,

 * and ranks candidates by probability to move UP or DOWN.

 */

function getOvernightCatalystBatch(now = new Date(), quotes = {}) {

  const isDefaultNow = !arguments[0] || (now instanceof Date && Math.abs(now.getTime() - Date.now()) < 5000);

  if (isDefaultNow && _cachedOvernightBatch && (Date.now() - _cachedOvernightTime) < CACHE_TTL_MS) {

    return _cachedOvernightBatch;

  }



  let activeQuotes = quotes;

  if (!activeQuotes || Object.keys(activeQuotes).length === 0) {

    try {

      const fsQuotes = require('fs');

      const pQuotes = require('path').join(__dirname, fs.existsSync(require('path').join(__dirname, '..', 'data')) ? '..' : '../..', 'data', 'catalyst_stock_quotes.json');

      if (fsQuotes.existsSync(pQuotes)) {

        activeQuotes = JSON.parse(fsQuotes.readFileSync(pQuotes, 'utf8'));

      }

    } catch (_) {

      activeQuotes = {};

    }

  }



  const ist = new Date(now.getTime() + 330 * 60000);

  const nowHours = ist.getUTCHours();

  const nowMins = ist.getUTCMinutes();

  const nowTimeNum = nowHours * 100 + nowMins;



  const pad = n => (n < 10 ? '0' : '') + n;

  const toDateStr = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());



  let sessionTiming;

  try {

    sessionTiming = require('../market/sessionTiming');

  } catch (_) {

    try {

      sessionTiming = require('../common/market/sessionTiming');

    } catch (__) {

      sessionTiming = require('../../common/market/sessionTiming');

    }

  }



  // 1. Determine Window Start (Most recent 15:30 IST market close)

  let closeProbe = new Date(ist.getTime());

  if (nowTimeNum < 1530) {

    closeProbe.setUTCDate(closeProbe.getUTCDate() - 1);

  }

  while (closeProbe.getUTCDay() === 0 || closeProbe.getUTCDay() === 6 || sessionTiming.isHoliday(toDateStr(closeProbe), 'india')) {

    closeProbe.setUTCDate(closeProbe.getUTCDate() - 1);

  }

  const cy = closeProbe.getUTCFullYear(), cm = closeProbe.getUTCMonth(), cd = closeProbe.getUTCDate();

  const windowStartInstant = Date.UTC(cy, cm, cd, 10, 0, 0); // 15:30 IST = 10:00 UTC

  const closeDateStr = toDateStr(closeProbe);



  // 2. Determine Next Trading Session (Target 09:00 AM Open)

  let openProbe = new Date(closeProbe.getTime());

  openProbe.setUTCDate(openProbe.getUTCDate() + 1);



  const tomorrowDateStr = toDateStr(openProbe);

  const isTomorrowHoliday = sessionTiming.isHoliday(tomorrowDateStr, 'india');

  const holidayName = isTomorrowHoliday ? sessionTiming.holidayCalendar('india')[tomorrowDateStr] : null;



  let skippedHolidays = [];

  while (openProbe.getUTCDay() === 0 || openProbe.getUTCDay() === 6 || sessionTiming.isHoliday(toDateStr(openProbe), 'india')) {

    const ds = toDateStr(openProbe);

    if (sessionTiming.isHoliday(ds, 'india')) {

      skippedHolidays.push({ date: ds, name: sessionTiming.holidayCalendar('india')[ds] });

    }

    openProbe.setUTCDate(openProbe.getUTCDate() + 1);

  }

  const targetTradingDate = toDateStr(openProbe);

  const ty = openProbe.getUTCFullYear(), tm = openProbe.getUTCMonth(), td = openProbe.getUTCDate();

  const targetOpenInstant = Date.UTC(ty, tm, td, 3, 30, 0); // 09:00 AM IST = 03:30 UTC



  // 3. Collect filings from windowStartInstant to targetOpenInstant

  const allItems = flashNews.readAll();

  const postCloseFilings = allItems.filter(it => {

    if (!it || !it.symbol) return false;

    const ts = Number(it.ts || it.firstSeenAt);

    const mat = String(it.materiality || 'OTHER').toUpperCase();

    if (!isFinite(ts) || ts < windowStartInstant || ts > targetOpenInstant) return false;

    if (mat === 'ROUTINE') return false;

    return true;

  });



  // 4. Deduplicate by symbol

  const bySymbol = new Map();

  for (const it of postCloseFilings) {

    const sym = String(it.symbol).toUpperCase().trim();

    if (sym === 'BSE' && !/^bse\s+limited/i.test((it.name || '') + ' ' + (it.title || '') + ' ' + (it.description || ''))) continue;

    if (sym === 'NSE' && !/national\s+stock\s+exchange/i.test((it.name || '') + ' ' + (it.title || ''))) continue;

    if (sym === 'MCX' && !/multi\s+commodity\s+exchange/i.test((it.name || '') + ' ' + (it.title || ''))) continue;

    const existing = bySymbol.get(sym);

    if (!existing) {

      bySymbol.set(sym, it);

      continue;

    }

    const predThis = predictCatalyst(it);

    const predExist = predictCatalyst(existing);

    const scoreThis = (predThis.takeTrade ? 100 : 0) + (predThis.confidence || 0);

    const scoreExist = (predExist.takeTrade ? 100 : 0) + (predExist.confidence || 0);

    if (scoreThis > scoreExist || (scoreThis === scoreExist && it.ts > existing.ts)) {

      bySymbol.set(sym, it);

    }

  }



  // 5. Score Probability & Check Pre-Runup

  const scoredStocks = [];

  for (const [sym, it] of bySymbol) {

    const q = (activeQuotes && activeQuotes[sym]) || null;

    const stockPrice = q ? (q.ltp || q.close || q.open || 0) : 0;

    if (stockPrice > 0 && stockPrice < 30.0) continue; // Penny stock floor



    const changePct = q && q.changePct != null ? Number(q.changePct) : 0;



    const pred = predictCatalyst(it, {

      ltp: stockPrice,

      changePct: changePct,

      volume: q ? q.volume : 0

    });



    const isPricedIn = changePct >= 2.5 || pred.tradeStatus === 'ALREADY_MOVED';

    const itemTs = Number(it.ts || it.firstSeenAt);

    const filingTimeIST = new Date(itemTs + 330 * 60000).toISOString().slice(11, 16) + ' IST';

    const diffSec = Math.max(0, Math.round((now.getTime() - itemTs) / 1000));

    const timeAgo = diffSec < 60 ? diffSec + 's ago' : (diffSec < 3600 ? Math.round(diffSec / 60) + 'm ago' : Math.round(diffSec / 3600) + 'h ago');



    const filingIst = new Date(itemTs + 330 * 60000);

    const filingTNum = filingIst.getUTCHours() * 100 + filingIst.getUTCMinutes();

    const isMarketOpenNow = (ist.getUTCDay() !== 0 && ist.getUTCDay() !== 6 && nowTimeNum >= 915 && nowTimeNum < 1530);

    const isFilingIntraday = (itemTs >= targetOpenInstant) || (filingTNum >= 915 && filingTNum < 1530 && ist.toISOString().slice(0, 10) === filingIst.toISOString().slice(0, 10));



    const isPostCloseFiling = !isMarketOpenNow && !isFilingIntraday && (nowTimeNum >= 1530 || nowTimeNum < 915);

    let reactionStatus = {};

    if (isPostCloseFiling) {

      reactionStatus = {

        moved: false,

        movePct: 0.00,

        moveText: '0.00% Post-News (Unpriced Overnight)',

        moveTag: 'UNPRICED',

        timeText: `Filed ${filingTimeIST} · Post-Market Close`,

        volumeStatus: 'Market Closed · Awaiting 09:08 Pre-Open Surge',

        volumeIncreasing: false,

        summary: '⚡ 100% Unpriced Overnight · Prime Coiled Setup for Tomorrow 09:15 Open'

      };

    } else {

      const filingTracker = require('./filingPriceTracker');

      const pFiling = filingTracker.recordAndGetFilingPrice(sym, itemTs, stockPrice, q ? q.open : null, q ? q.close : null);

      const postMove = (pFiling > 0 && stockPrice > 0)

        ? +(((stockPrice - pFiling) / pFiling) * 100).toFixed(2)

        : Number(changePct || 0);

      const postVol = Number(q ? q.volume : 0);

      const hasMoved = Math.abs(postMove) >= 0.15;

      const volInc = (q && q.rvol && q.rvol >= 1.5) || false;

      const moveSign = postMove > 0 ? '+' : '';

      reactionStatus = {

        moved: hasMoved,

        movePct: postMove,

        moveText: hasMoved ? `Moved ${moveSign}${postMove.toFixed(2)}% post-news` : `${moveSign}${postMove.toFixed(2)}% Post-News (Runway)`,

        moveTag: hasMoved ? 'MOVED_POST_NEWS' : 'UNMOVED',

        timeText: `Filed ${filingTimeIST} · Intraday`,

        volumeStatus: volInc ? `Volume surged ${q.rvol}x (₹${((postVol * (stockPrice || 1)) / 1e7).toFixed(1)} Cr)` : 'Volume quiet / normal',

        volumeIncreasing: volInc,

        summary: hasMoved ? `Post-news reaction confirmed (${moveSign}${postMove.toFixed(2)}%)` : 'Fresh announcement · Pre-move window'

      };

    }



    scoredStocks.push(Object.assign({}, it, {

      price: stockPrice,

      volume: q ? q.volume : 0,

      changePct,

      postNewsMovePct: reactionStatus.movePct,

      reactionMoveText: reactionStatus.moveText,

      reactionTimeStatus: reactionStatus.timeText,

      prediction: pred.prediction,

      bias: pred.bias,

      confidence: pred.confidence,

      probability: pred.probability || pred.confidence,

      takeTrade: pred.takeTrade,

      tradeStatus: pred.tradeStatus,

      badge: pred.badge,

      rationale: pred.rationale,

      filingTime: filingTimeIST,

      timeAgo,

      reactionStatus

    }));

  }



  const qualifiedMovers = scoredStocks.filter(s => {

    const p = Number(s.price || 0);

    if (p > 0 && p < 30.0) return false;

    if (['ROUTINE_DISCLOSURE', 'ROUTINE_LAND_ACQUISITION', 'REGULATORY_ORDER', 'RESULTS_UNCERTAIN', 'NEUTRAL_WATCH', 'ALREADY_MOVED', 'STALE_YESTERDAY'].includes(s.tradeStatus)) return false;

    if (s.prediction && (s.prediction.includes('ROUTINE') || s.prediction.includes('UNTRADEABLE') || s.prediction.includes('ALREADY MOVED') || s.prediction.includes('DO NOT CHASE') || s.prediction.includes('EXHAUSTION'))) return false;

    // Strict exclusion of overextended / exhausted moves:
    // Downside move <= -3.5% or upside move >= +3.8% (unless verified blowout beat)
    const rawMove = Number(s.postNewsMovePct != null ? s.postNewsMovePct : (s.changePct || 0));
    const isBlowout = Boolean(s.isBlowoutBeat || (s.badge && s.badge.includes('BLOWOUT')));
    if (rawMove <= -3.5) return false; // Downside exhaustion (already dumped)
    if (rawMove >= (isBlowout ? 6.5 : 3.8)) return false; // Upside exhaustion (already ran)

    const effMove = Math.abs(Number(s.effNewsMove || s.postNewsMove || s.dayMovePct || s.movePct || rawMove || 0));
    if (effMove >= (isBlowout ? 6.5 : 3.8)) return false;

    if (s.takeTrade === false && !isBlowout) return false;

    return true;

  }).sort((a, b) => {

    const tradeA = a.takeTrade ? 1 : 0;

    const tradeB = b.takeTrade ? 1 : 0;

    if (tradeB !== tradeA) return tradeB - tradeA;

    if (b.probability !== a.probability) return b.probability - a.probability;

    return (b.ts || 0) - (a.ts || 0);

  });



  for (const stockObj of qualifiedMovers) {

    const q = (activeQuotes && activeQuotes[stockObj.symbol]) || null;

    stockObj.auctionAssessment = evaluatePreMarketAuction(stockObj, q);

  }



  const actionableMovers = qualifiedMovers.filter(s => s.takeTrade === true);

  // Guarantee strictly 5 actionable, unpriced catalysts (never < 5 unless total pool is exhausted, and never Already Moved)
  const isCandidateEligible = (s) => {
    if (!s || !s.symbol) return false;
    if (s.tradeStatus === 'ALREADY_MOVED' || (s.prediction && (s.prediction.includes('ALREADY MOVED') || s.prediction.includes('DO NOT CHASE')))) return false;
    const m = Number(s.postNewsMovePct != null ? s.postNewsMovePct : (s.changePct || 0));
    if (m <= -3.5 || (!s.isBlowoutBeat && m >= 3.8)) return false;
    return true;
  };

  const top5Set = new Set();
  const top5Movers = [];

  for (const s of actionableMovers) {
    if (!isCandidateEligible(s) || top5Set.has(s.symbol)) continue;
    top5Set.add(s.symbol);
    top5Movers.push(s);
    if (top5Movers.length >= 5) break;
  }

  // Backfill up to 5 if needed
  if (top5Movers.length < 5) {
    for (const s of qualifiedMovers) {
      if (!isCandidateEligible(s) || top5Set.has(s.symbol)) continue;
      top5Set.add(s.symbol);
      top5Movers.push(s);
      if (top5Movers.length >= 5) break;
    }
  }

  // Final fallback to high-probability scored stocks to ensure 5 cards
  if (top5Movers.length < 5) {
    for (const s of scoredStocks) {
      if (!isCandidateEligible(s) || top5Set.has(s.symbol)) continue;
      const p = Number(s.price || 0);
      if (p > 0 && p < 30.0) continue;
      top5Set.add(s.symbol);
      top5Movers.push(s);
      if (top5Movers.length >= 5) break;
    }
  }

  const topPick = top5Movers.length > 0 ? top5Movers[0] : null;



  const result = {

    targetDate: targetTradingDate,

    targetDateStr: targetTradingDate,

    closeDateStr,

    holidayName,

    isHoliday: isTomorrowHoliday,

    skippedHolidays,

    totalLoaded: postCloseFilings.length,

    allCatalysts: scoredStocks,

    topPick,

    top5Movers

  };



  if (isDefaultNow) {

    _cachedOvernightBatch = result;

    _cachedOvernightTime = Date.now();

  }



  return result;

}



/**

 * Pre-Market Auction Gap Evaluation (09:08 - 09:15 AM Relief Window)

 */

function evaluatePreMarketAuction(catalyst, quote = {}) {

  const c = catalyst || {};

  const q = quote || {};

  const ltp = Number(q.ltp || c.ltp || c.price || 0);

  const close = Number(q.close || c.close || c.prevClose || 0);

  const open = Number(q.open || c.open || 0);



  let gapPct = null;

  if (open > 0 && close > 0) {

    gapPct = +(((open - close) / close) * 100).toFixed(2);

  } else if (c.preMarketGapPct != null) {

    gapPct = Number(c.preMarketGapPct);

  }



  const ist = new Date(Date.now() + 330 * 60000);

  const tNum = ist.getUTCHours() * 100 + ist.getUTCMinutes();

  const day = ist.getUTCDay();

  const isWeekend = (day === 0 || day === 6);

  const isLiveMarket = !isWeekend && (tNum >= 915 && tNum < 1530);

  const isPreOpenRelief = !isWeekend && (tNum >= 908 && tNum < 915);

  const isPreAuction = !isWeekend && (tNum >= 900 && tNum < 908);

  const isClosed = isWeekend || tNum >= 1530 || tNum < 900;



  const isBull = c.bias === 'BULLISH' || c.direction === 'UP' || (c.prediction && c.prediction.includes('BUY'));

  const isBear = c.bias === 'BEARISH' || c.direction === 'DOWN' || (c.prediction && c.prediction.includes('SELL'));



  const todayMidnightMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 0, 0, 0) - 330 * 60000;

  const sessionOpenMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 3, 45, 0); // 09:15 IST



  let isIntradayFiling = false;

  const isTodayTradingDay = (ist.getUTCDay() !== 0 && ist.getUTCDay() !== 6 && !sessionTiming.isHoliday(ist.toISOString().slice(0, 10), 'india'));

  if (isTodayTradingDay && c.filingTime) {

    const tm = String(c.filingTime).match(/(\d{1,2}):(\d{2})/);

    if (tm) {

      const fNum = parseInt(tm[1], 10) * 100 + parseInt(tm[2], 10);

      // STRICT: Only 09:15 to 15:30 is intraday! Post-15:30 is post-market close / overnight!
      if (fNum >= 915 && fNum < 1530) isIntradayFiling = true;

    }

  }

  if (isTodayTradingDay && !isIntradayFiling && c.ts) {

    const dFiling = new Date(Number(c.ts) + 330 * 60000);

    const fTNum = dFiling.getUTCHours() * 100 + dFiling.getUTCMinutes();

    const isSameDate = (dFiling.getUTCDate() === ist.getUTCDate() && dFiling.getUTCMonth() === ist.getUTCMonth() && dFiling.getUTCFullYear() === ist.getUTCFullYear());

    if (isSameDate && fTNum >= 915 && fTNum < 1530) isIntradayFiling = true;

  }



  const titleText = ((c.title || '') + ' ' + (c.description || '') + ' ' + (c.kind || '')).toLowerCase();

  const mat = String(c.materiality || '').toUpperCase();

  const isNewspaper = titleText.includes('newspaper publication') || titleText.includes('newspapers publication') || titleText.includes('copy of newspaper') || titleText.includes('newspaper advertisement') || titleText.includes('paper cutting') || titleText.includes('newspaper clipping');

  const isBoardOutcome = /outcome\s+of\s+(?:the\s+)?board\s+meeting|board\s+meeting\s+outcome/i.test(titleText);

  const isBoardMeeting = (/meeting\s+of\s+(?:the\s+)?board|board\s+meeting/i.test(titleText)) && !isBoardOutcome;

  const isConcall = /transcript.*?(?:conference|earnings|analyst|concall)|audio\s+recording.*?(?:conference|earnings|concall)|concall\s+transcript|earnings\s+call\s+transcript/i.test(titleText);

  const isSast = /disclosure\s+under\s+reg(?:ulation)?\s*(?:29|10|7)|substantial\s+acquisition\s+of\s+shares|sebi\s*\(\s*sast\s*\)|sebi\s*\(\s*pit\s*\)|regulation\s*29\s*\(\s*[12]\s*\)/i.test(titleText);

  const isTradingWindow = /trading\s+window/i.test(titleText);

  const isDebtPaper = /commercial paper|redemption of|allotment of (?:equity )?shares under esop|loss of share certificate/i.test(titleText);

  const isTdsNotice = /deduction\s+of\s+tax|tax\s+deduction|tds\s+on\s+dividend|\btds\b|tax\s+at\s+source|form\s+15[gh]|communication\s+to\s+shareholders\s+regarding.*tax/i.test(titleText);

  const isRealCatalyst = (mat === 'RESULTS' || mat === 'ORDER' || mat === 'CAPITAL' || mat === 'CORPORATE_ACTION' || mat === 'SALES_UPDATE') && !isNewspaper && !isBoardMeeting && !isConcall && !isSast && !isTradingWindow && !isDebtPaper && !isTdsNotice;

  const isRoutineFiling = !isRealCatalyst && (isNewspaper || isBoardMeeting || isConcall || isSast || isTradingWindow || isDebtPaper || isTdsNotice || c.tradeStatus === 'ROUTINE_DISCLOSURE' || mat === 'ROUTINE' || mat === 'BOARD');



  // ROUTINE & NON-ACTIONABLE FILING IMMUNITY:

  // Newspaper publications, board meeting intimations, and routine disclosures must NEVER trigger trade calls!

  if (isRoutineFiling) {

    const routineLabel = isNewspaper ? '📄 NEWSPAPER (ROUTINE)' : (isBoardMeeting ? '📅 BOARD MEETING (ROUTINE)' : (isTdsNotice ? '📋 TDS NOTICE (ROUTINE)' : (isConcall ? '🎙️ TRANSCRIPT (ROUTINE)' : (isSast ? '📋 SAST 29 (ROUTINE)' : '👀 ROUTINE WATCH'))));

    const routineBtn = isNewspaper ? 'Routine (Newspaper)' : (isBoardMeeting ? 'Routine (Board Meeting)' : (isTdsNotice ? 'Routine (Tax Notice)' : (isConcall ? 'Routine (Transcript)' : (isSast ? 'Routine (SAST 29)' : 'Routine'))));

    return {

      status: 'ROUTINE_WATCH',

      label: routineLabel,

      badge: '👀 ROUTINE',

      color: '#64748b',

      bg: 'rgba(100, 116, 139, 0.12)',

      border: 'rgba(100, 116, 139, 0.3)',

      action: 'WATCH',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: routineBtn,

      confirmed: false,

      takeTrade: false,

      isLiveSessionFiling: isIntradayFiling,

      plan: isNewspaper

        ? 'Regulation 47 newspaper extract of past results. Old news already priced in; strictly not an active trading catalyst.'

        : (isBoardMeeting ? 'Notice of scheduled board meeting. No actual results released yet; trading calls strictly refused.' : (isTdsNotice ? 'Administrative intimation regarding deduction of tax at source (TDS) on dividend. Pure compliance paperwork without trading edge.' : 'Routine statutory disclosure. Pure compliance paperwork without trading edge.'))

    };

  }



  // INTRADAY LIVE SESSION FILINGS (Filed after 09:15 AM today):

  // The 09:08 pre-market auction occurred before this news was published.

  // Must have strict takeTrade === true to issue an actionable call!

  if (isIntradayFiling || (isLiveMarket && c.ts && Number(c.ts) >= sessionOpenMs)) {

    const isActionableBuy = c.takeTrade && (c.tradeStatus === 'TAKE_TRADE_BUY' || c.tradeStatus === 'TAKE_TRADE' || isBull);

    const isActionableShort = c.takeTrade && (c.tradeStatus === 'TAKE_TRADE_SHORT' || isBear);

    if (isActionableBuy || isActionableShort) {

      return {

        status: isActionableBuy ? 'LIVE_MOMENTUM_BUY' : 'LIVE_MOMENTUM_SHORT',

        label: isActionableBuy ? (c.badge || '⚡ LIVE BUY BREAKOUT') : (c.badge || '⚡ LIVE SHORT / FADE'),

        badge: isActionableBuy ? '⚡ LIVE BUY' : '⚡ LIVE SHORT',

        color: isActionableBuy ? '#16a34a' : '#dc2626',

        bg: isActionableBuy ? 'rgba(22, 163, 74, 0.12)' : 'rgba(220, 38, 38, 0.12)',

        border: isActionableBuy ? 'rgba(22, 163, 74, 0.3)' : 'rgba(220, 38, 38, 0.3)',

        action: isActionableBuy ? 'TAKE LIVE BUY' : 'TAKE LIVE SHORT',

        actionBtnClass: isActionableBuy ? 'btn-trade-buy' : 'btn-trade-sell',

        actionBtnLabel: c.actionBtnLabel || (isActionableBuy ? `Buy ${c.probability || c.confidence || 80}%` : `Sell ${c.probability || c.confidence || 80}%`),

        confirmed: true,

        takeTrade: true,

        isLiveSessionFiling: true,

        plan: `Live intraday filing disclosed during market hours (${c.filingTime || 'live'}). Evaluated with real-time price action & momentum.`

      };

    }



    // Non-tradeable intraday state: ALREADY_MOVED, OBSERVING_TAPE, LOW_MOMENTUM, or WATCH

    const isAlreadyMoved = c.tradeStatus === 'ALREADY_MOVED' || (c.prediction && c.prediction.includes('ALREADY MOVED'));

    const isObservingTape = c.tradeStatus === 'OBSERVING_POST_NEWS_TAPE';

    const isLowMo = c.tradeStatus === 'DO_NOT_TRADE_LOW_MOMENTUM';



    let label = '👀 LIVE SESSION WATCH';

    let badge = '👀 LIVE WATCH';

    let btnLabel = 'Watch';

    let color = '#64748b';

    let bg = 'rgba(100, 116, 139, 0.12)';

    let border = 'rgba(100, 116, 139, 0.3)';



    if (isAlreadyMoved) {

      label = '🚫 ALREADY MOVED (DO NOT CHASE)';

      badge = '🚫 ALREADY MOVED';

      btnLabel = 'Already Moved';

      color = '#eab308';

      bg = 'rgba(234, 179, 8, 0.12)';

      border = 'rgba(234, 179, 8, 0.3)';

    } else if (isObservingTape) {

      label = '⏳ OBSERVING 10M TAPE';

      badge = '⏳ OBSERVING TAPE';

      btnLabel = '10m Tape Watch';

      color = '#38bdf8';

      bg = 'rgba(56, 189, 248, 0.12)';

      border = 'rgba(56, 189, 248, 0.3)';

    } else if (isLowMo) {

      label = '⏳ LOW MOMENTUM (DO NOT CHASE)';

      badge = '⏳ LOW MOMENTUM';

      btnLabel = 'Low Momentum';

    }



    return {

      status: isAlreadyMoved ? 'ALREADY_MOVED' : (isObservingTape ? 'OBSERVING_TAPE' : 'LIVE_WATCH'),

      label,

      badge,

      color,

      bg,

      border,

      action: 'WATCH',

      actionBtnClass: isAlreadyMoved ? 'btn-trade-warn' : 'btn-trade-watch',

      actionBtnLabel: btnLabel,

      confirmed: false,

      takeTrade: false,

      isLiveSessionFiling: true,

      plan: isAlreadyMoved

        ? 'Catalyst already priced in; large initial move already consumed. Await pullback or new base.'

        : (isObservingTape

          ? 'Fresh numbers released. Observing 1m/5m tape orderflow for directional thrust before entry.'

          : `Live intraday filing disclosed during market hours (${c.filingTime || 'live'}). Evaluated with real-time price action & momentum.`)

    };

  }



  const isDemerger = titleText.includes('demerger') || titleText.includes('scheme of arrangement');

  const isOrder = mat === 'ORDER' || (titleText.includes('order') && !titleText.includes('order passed'));

  const isMA = mat === 'CORPORATE_ACTION' || titleText.includes('acquisition') || titleText.includes('takeover');

  const isExpansion = titleText.includes('commercial production') || titleText.includes('capacity addition') || titleText.includes('capacity expansion') || titleText.includes('bess project');



  let catType = 'STANDARD';

  let expectedGapMin = 0.8;

  let expectedGapMax = 3.8;

  let circuitLimit = 6.0;

  let catalystDesc = 'Corporate catalyst';



  if (isDemerger) {

    catType = 'DEMERGER';

    expectedGapMin = 0.8;

    expectedGapMax = 6.5;

    circuitLimit = 9.0;

    catalystDesc = 'Demerger value unlock';

  } else if (isOrder) {

    catType = 'ORDER_WIN';

    expectedGapMin = 0.8;

    expectedGapMax = 5.5;

    circuitLimit = 8.0;

    catalystDesc = 'Major order win';

  } else if (isMA) {

    catType = 'STRATEGIC_MA';

    expectedGapMin = 0.8;

    expectedGapMax = 5.0;

    circuitLimit = 7.5;

    catalystDesc = 'Strategic corporate acquisition';

  } else if (isExpansion) {

    catType = 'EXPANSION';

    expectedGapMin = 0.8;

    expectedGapMax = 4.0;

    circuitLimit = 6.5;

    catalystDesc = 'Commercial production / expansion';

  } else if (isBear) {

    catType = 'NEGATIVE';

    expectedGapMin = -2.0;

    expectedGapMax = -7.0;

    circuitLimit = -10.0;

    catalystDesc = 'Distress / governance issue';

  }



  const isRoutine = c.tradeStatus === 'ROUTINE_DISCLOSURE' || c.tradeStatus === 'ROUTINE_LAND_ACQUISITION' || mat === 'ROUTINE' || /open offer made to public shareholders|investor presentation|analyst meet/i.test(titleText);

  if (isRoutine) {

    return {

      status: 'ROUTINE',

      label: '📄 ROUTINE DISCLOSURE',

      badge: '📄 ROUTINE (NO EDGE)',

      color: '#64748b',

      bg: 'rgba(100, 116, 139, 0.12)',

      border: 'rgba(100, 116, 139, 0.3)',

      action: 'WATCH',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Routine Disclosure',

      confirmed: false,

      plan: 'Routine corporate disclosure without directional trading edge.'

    };

  }



  const effectiveMove = gapPct != null ? gapPct : Number(c.movePct || 0);

  if (effectiveMove <= -3.8) {

    return {

      status: 'ALREADY_MOVED',

      label: `⚠️ EXTENDED DROP (${effectiveMove.toFixed(1)}%)`,

      badge: '⚠️ DUMP EXHAUSTED',

      color: '#d97706',

      bg: 'rgba(245, 158, 11, 0.12)',

      border: 'rgba(245, 158, 11, 0.3)',

      action: 'AVOID CHASE SHORT',

      actionBtnClass: 'btn-trade-warn',

      actionBtnLabel: `Dump Exhausted (${effectiveMove.toFixed(1)}%)`,

      confirmed: false,

      plan: `Extreme drop (${effectiveMove.toFixed(1)}%). Downside move already exhausted in pre-market auction; strictly avoid chasing shorts.`

    };

  }



  // 1. If Market is Closed or Pre-Auction or auction data not yet arrived

  if ((isClosed || isPreAuction || gapPct == null) && !c.isPreMarketEvaluated) {

    let customPlan = '';

    if (isBull) {

      customPlan = `${catalystDesc}. Expected 09:08 IEP gap: +${expectedGapMin.toFixed(1)}% to +${expectedGapMax.toFixed(1)}%. Buy on 09:15 open with VWAP support. Avoid only if gapping > +${circuitLimit.toFixed(1)}% (circuit risk).`;

    } else if (isBear) {

      customPlan = `${catalystDesc}. Expected 09:08 IEP gap: ${expectedGapMin.toFixed(1)}% to ${expectedGapMax.toFixed(1)}%. Short continuation on 09:15 open if gap holds below VWAP.`;

    } else {

      customPlan = `Awaiting 09:08 AM auction discovery. Await confirmed volume breakout before entry.`;

    }



    return {

      status: 'AWAITING_AUCTION',

      label: '⏳ AWAITING 09:08 IEP',

      badge: '⏳ AWAITING 09:08 IEP',

      color: '#64748b',

      bg: 'rgba(100, 116, 139, 0.12)',

      border: 'rgba(100, 116, 139, 0.3)',

      action: isBull ? 'PREPARE BUY CALL' : (isBear ? 'PREPARE SHORT / FADE' : 'WATCH'),

      actionBtnClass: isBull ? 'btn-trade-buy' : (isBear ? 'btn-trade-sell' : 'btn-trade-watch'),

      actionBtnLabel: isBull ? `Prepare Buy Call (${c.probability || c.confidence || 80}%)` : `Prepare Short (${c.probability || c.confidence || 80}%)`,

      plan: `Awaiting 09:08 AM auction discovery. ${customPlan}`,

      expectedGapMin,

      expectedGapMax,

      circuitLimit,

      catType

    };

  }



  // 2. Pre-Market Auction Gap Evaluation (09:08 - 09:15 AM Relief Window or simulated pre-market)

  if (gapPct != null) {

    if (isBull) {

      const overExtendedCutoff = (catType === 'DEMERGER') ? 4.5 : 3.8;

      const isHighConvictionRunner = (

        isDemerger ||

        (isOrder && (c.orderCrore == null || c.orderCrore >= 50)) ||

        isMA ||

        isExpansion ||

        mat === 'RESULTS' ||

        (c.confidence && c.confidence >= 80)

      );



      // High-conviction runner pullback: if stock opens green and pulls back into open-to-close zone,
      // it is a high-probability BUY ON DIP, NEVER a short fade unless it cracks below previous close!
      if (ltp > 0 && open > 0 && ltp < open && ltp >= close) {
        const dipPct = +(((open - ltp) / open) * 100).toFixed(1);
        return {
          status: 'SWEET_SPOT_PULLBACK',
          label: `⚡ PULLBACK DIP (-${dipPct}%)`,
          badge: '⚡ BUY ON DIP',
          color: '#16a34a',
          bg: 'rgba(22, 163, 74, 0.12)',
          border: 'rgba(22, 163, 74, 0.3)',
          action: 'TAKE DIP BUY',
          actionBtnClass: 'btn-trade-buy',
          actionBtnLabel: `Buy ${c.probability || c.confidence || 80}%`,
          targetPrice: Number((open * 1.035).toFixed(2)),
          stopLoss: Number((close * 0.995).toFixed(2)),
          plan: `Stock opened at ₹${open.toFixed(2)} (+${gapPct.toFixed(1)}%) and pulled back -${dipPct}% into value pocket. STRATEGY: Enter BUY on reversal near VWAP with strong catalyst support.`
        };
      } else if (ltp > 0 && close > 0 && ltp < close && ((close - ltp) / close) >= 0.008) {
        // High-conviction bullish catalyst dip: NEVER issue a short call against a high-probability bullish catalyst!
        const fadePct = +(((close - ltp) / close) * 100).toFixed(1);
        return {
          status: 'DIP_RETEST',
          label: `📉 DIP RETEST (-${fadePct}%)`,
          badge: '⚡ DIP RETEST',
          color: '#d97706',
          bg: 'rgba(217, 119, 6, 0.12)',
          border: 'rgba(217, 119, 6, 0.3)',
          action: 'WAIT VWAP RECLAIM',
          actionBtnClass: 'btn-trade-watch',
          actionBtnLabel: 'Wait VWAP Reclaim',
          targetPrice: Number((open * 1.035).toFixed(2)),
          stopLoss: Number((close * 0.985).toFixed(2)),
          plan: `Stock dipped -${fadePct}% below previous close. High-conviction bullish catalyst intact. STRATEGY: Wait for VWAP reclaim before entry; do not short into positive news.`
        };
      } else if (gapPct > overExtendedCutoff) {
        return {
          status: 'OVEREXTENDED_GAP',
          label: `⚡ EXTENDED GAP (+${gapPct.toFixed(1)}%)`,
          badge: '⚠️ OVER-EXTENDED',
          color: '#d97706',
          bg: 'rgba(217, 119, 6, 0.12)',
          border: 'rgba(217, 119, 6, 0.3)',
          action: 'AVOID CHASE (WAIT DIP)',
          actionBtnClass: 'btn-trade-warn',
          actionBtnLabel: 'Avoid Chase (Wait Dip)',
          isGapFillStrategy: true,
          strategyType: 'PULLBACK_WATCH',
          targetPrice: Number((open * 1.03).toFixed(2)),
          stopLoss: Number((close * 0.995).toFixed(2)),
          plan: `Extreme gap-up (+${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}). Catalyst partially priced in. Avoid chasing at open; wait for orderly pullback to VWAP before buying.`
        };

      } else if (isHighConvictionRunner && gapPct >= -0.5 && gapPct <= 1.5) {

        const target1 = Number((open * 1.04).toFixed(2));

        return {

          status: 'RUNNER_SWEET_SPOT',

          label: isLiveMarket ? `⚡ LIVE BUY CONFIRMED (+${gapPct.toFixed(1)}%)` : `🎯 09:08 CONFIRMED (+${gapPct.toFixed(1)}%)`,

          badge: isLiveMarket ? '⚡ LIVE BUY CONFIRMED' : '🎯 09:08 BUY CONFIRMED',

          color: '#16a34a',

          bg: 'rgba(22, 163, 74, 0.12)',

          border: 'rgba(22, 163, 74, 0.3)',

          action: 'CONFIRMED BUY CALL',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: `Confirmed Buy (${c.probability || c.confidence || 85}%)`,

          targetPrice: target1,

          stopLoss: open,

          confirmed: true,

          plan: isLiveMarket

            ? `Live price action confirms optimal momentum (+${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}). Enter on 1m/5m push near ₹${open.toFixed(2)}. Target ₹${target1}, SL ₹${open.toFixed(2)}.`

            : `09:08 auction confirms optimal sweet spot (+${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}). Enter at 09:15 open near ₹${open.toFixed(2)}. Target ₹${target1}, SL ₹${open.toFixed(2)}.`

        };

      } else if (gapPct >= expectedGapMin && gapPct <= expectedGapMax) {

        const targetPrice = Number((open * 1.015).toFixed(2));

        return {

          status: 'SWEET_SPOT_GAP',

          label: isLiveMarket ? `⚡ LIVE BUY CONFIRMED (+${gapPct.toFixed(1)}%)` : `🎯 09:08 CONFIRMED (+${gapPct.toFixed(1)}%)`,

          badge: isLiveMarket ? '⚡ LIVE BUY CONFIRMED' : '🎯 09:08 BUY CONFIRMED',

          color: '#16a34a',

          bg: 'rgba(22, 163, 74, 0.12)',

          border: 'rgba(22, 163, 74, 0.3)',

          action: 'CONFIRMED BUY CALL',

          actionBtnClass: 'btn-trade-buy',

          actionBtnLabel: `Confirmed Buy (${c.probability || c.confidence || 80}%)`,

          targetPrice,

          stopLoss: open,

          confirmed: true,

          plan: isLiveMarket

            ? `Live momentum confirmed (+${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}). Enter on candle break near ₹${open.toFixed(2)} with VWAP support.`

            : `09:08 auction confirmed (+${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}). Enter on 09:15 open candle near ₹${open.toFixed(2)} with VWAP support.`

        };

      } else if (gapPct < -0.5) {

        return {

          status: 'PRE_OPEN_FADE_SELL',

          label: `❌ AUCTION REJECTED (${gapPct.toFixed(1)}%)`,

          badge: '❌ AUCTION REJECTED',

          color: '#dc2626',

          bg: 'rgba(220, 38, 38, 0.12)',

          border: 'rgba(220, 38, 38, 0.3)',

          action: 'AUCTION REJECTED',

          actionBtnClass: 'btn-trade-watch',

          actionBtnLabel: 'Auction Rejected',

          confirmed: false,

          plan: `Auction rejected positive news (${gapPct.toFixed(1)}% gap-down). AVOID LONG; do not buy news that auction dumps.`

        };

      } else {

        return {

          status: 'AWAITING_BURST',

          label: `⏳ FLAT PRE-OPEN (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%)`,

          badge: '⏳ FLAT PRE-OPEN',

          color: '#6366f1',

          bg: 'rgba(99, 102, 241, 0.12)',

          border: 'rgba(99, 102, 241, 0.3)',

          action: 'WAIT OR15 BREAKOUT',

          actionBtnClass: 'btn-trade-watch',

          actionBtnLabel: 'Wait OR15 Breakout',

          confirmed: false,

          plan: `Stock opened flat (${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(1)}%). Wait for 09:15 open volume burst.`

        };

      }

    } else if (isBear) {

      if (gapPct < -3.8) {

        return {

          status: 'ALREADY_MOVED',

          label: `⚠️ EXTENDED GAP-DOWN (${gapPct.toFixed(1)}%)`,

          badge: '⚠️ DUMP EXHAUSTED',

          color: '#d97706',

          bg: 'rgba(245, 158, 11, 0.12)',

          border: 'rgba(245, 158, 11, 0.3)',

          action: 'AVOID CHASE SHORT',

          actionBtnClass: 'btn-trade-warn',

          actionBtnLabel: 'Avoid Chase Short',

          confirmed: false,

          plan: `Stock crashed in pre-open auction (${gapPct.toFixed(1)}%). Downside move already priced in; avoid chasing shorts at 09:15 open.`

        };

      } else if (gapPct <= -0.8 && gapPct >= -3.8) {

        return {

          status: 'SWEET_SPOT_GAP',

          label: isLiveMarket ? `⚡ LIVE SHORT CONFIRMED (${gapPct.toFixed(1)}%)` : `🎯 09:08 SHORT CONFIRMED (${gapPct.toFixed(1)}%)`,

          badge: isLiveMarket ? '⚡ LIVE SHORT CONFIRMED' : '🎯 09:08 SHORT CONFIRMED',

          color: '#dc2626',

          bg: 'rgba(220, 38, 38, 0.12)',

          border: 'rgba(220, 38, 38, 0.3)',

          action: 'SHORT / FADE CALL',

          actionBtnClass: 'btn-trade-sell',

          actionBtnLabel: `Prepare Short / Fade (${c.probability || c.confidence || 80}%)`,

          confirmed: true,

          plan: isLiveMarket

            ? `Live breakdown confirmed ${gapPct.toFixed(1)}% at ₹${open.toFixed(2)}. Enter short on next 1m/5m breakdown; target -1.8%, SL above ₹${close.toFixed(2)}.`

            : `Pre-open auction confirmed ${gapPct.toFixed(1)}% breakdown at ₹${open.toFixed(2)}. Enter short on 09:15 open; target -1.8%, SL above ₹${close.toFixed(2)}.`

        };

      } else {

        return {

          status: 'AWAITING_BURST',

          label: `⏳ FLAT PRE-OPEN (${gapPct.toFixed(1)}%)`,

          badge: '⏳ FLAT PRE-OPEN',

          color: '#6366f1',

          bg: 'rgba(99, 102, 241, 0.12)',

          border: 'rgba(99, 102, 241, 0.3)',

          action: 'WATCH BREAKDOWN',

          actionBtnClass: 'btn-trade-watch',

          actionBtnLabel: 'Watch Breakdown',

          confirmed: false,

          plan: `Pre-open flat. Watch for breakdown below VWAP on 09:15 open candle.`

        };

      }

    }

  }



  // 3. LIVE MARKET HOURS (09:15 - 15:30 IST)

  const m1 = Number(c.move1mPct || 0);

  const m5 = Number(c.move5mPct || 0);

  const mDay = Number(c.movePct || 0);

  if (mDay >= 3.8 || mDay <= -3.8 || m5 >= 2.5) {

    return {

      status: 'ALREADY_MOVED',

      label: `⚠️ ALREADY MOVED (${mDay > 0 ? '+' : ''}${mDay.toFixed(1)}%)`,

      badge: '⚠️ ALREADY MOVED',

      color: '#d97706',

      bg: 'rgba(245, 158, 11, 0.12)',

      border: 'rgba(245, 158, 11, 0.3)',

      action: 'DO NOT CHASE',

      actionBtnClass: 'btn-trade-warn',

      actionBtnLabel: 'Already Moved (Do Not Chase)',

      confirmed: false,

      plan: `Stock already moved ${mDay > 0 ? '+' : ''}${mDay.toFixed(1)}% on news. Move exhausted; avoid chasing.`

    };

  } else if (m1 >= 0.18 || m5 >= 0.35) {

    return {

      status: 'ACTIVE_BREAKOUT',

      label: `🚀 BREAKOUT (+${m1.toFixed(2)}% 1m)`,

      badge: '🚀 ACTIVE BREAKOUT',

      color: '#16a34a',

      bg: 'rgba(22, 163, 74, 0.12)',

      border: 'rgba(22, 163, 74, 0.3)',

      action: 'ACTIVE BUY SCALP',

      actionBtnClass: 'btn-trade-buy',

      actionBtnLabel: `Active Scalp (+${m1.toFixed(2)}% 1m)`,

      confirmed: true,

      plan: `Confirmed volume thrust (+${m1.toFixed(2)}% 1m). Enter on shallow 1m pullback above VWAP.`

    };

  } else {

    return {

      status: 'STAGNANT',

      label: '⏳ AWAITING VOLUME',

      badge: '⏳ AWAITING VOLUME',

      color: '#64748b',

      bg: 'rgba(100, 116, 139, 0.12)',

      border: 'rgba(100, 116, 139, 0.3)',

      action: 'AWAIT BREAKOUT',

      actionBtnClass: 'btn-trade-watch',

      actionBtnLabel: 'Await Volume Burst',

      confirmed: false,

      plan: `Stock tape quiet post-filing. Wait for 1m volume burst above VWAP before entry.`

    };

  }

}



module.exports = {

  loadPreMarketCatalysts,

  getSymbolCatalyst,

  evaluatePreNewsTrade,

  predictCatalyst,

  evaluatePreMarketAuction,

  HIGH_PRIORITY_MATERIALITY,

  getOvernightCatalystBatch,

};

