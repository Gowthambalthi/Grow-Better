'use strict';

/**
 * news/historicalReactionLearner.js — Institutional Empirical Microstructural Post-News Engine
 *
 * "Study old data to find more on these days for predicting future"
 *
 * Built on 5 Comprehensive Empirical Datasets (Multi-Year 1-Minute NSE Tape):
 * 1. Category 1-Minute Reaction Table (data/news/reaction_stats.json, n=5,494):
 *    Measures exact post-headline return over 15m, 30m, 60m, 120m horizons and t-stats.
 *    - results | UP: n=2,559, -0.185% over 60m (t = -6.83) -> Mean-reverting / Fade!
 *    - deals   | UP: n=647,  -0.288% over 60m (t = -6.53) -> Mean-reverting / Fade!
 *    - oil     | UP: n=73,   +0.435% over 120m (t = +5.71) -> Momentum / Expansion!
 *    - ceo     | DOWN: n=361, -0.236% over 60m (t = -4.65) -> Downside drift holds!
 *
 * 2. Intraday Minute-by-Minute Micro Trajectory (data/news/intraday_study.json, n=2,976 filings vs n=50,008 controls):
 *    Measures exact jump, +5m (f5), +15m (f15), +30m (f30), +60m (f60), and toClose drift.
 *    - ORDER: Jump +0.39% (win 67.3%), f5 +0.23% (win 64.6%), but decays to +0.002% at 30m, -0.03% at 60m.
 *      -> Scalping window is strictly 0 to 5 minutes!
 *    - RESULTS: Jump +0.05%, f5 -0.05%, f15 -0.18%, f60 -0.13%, toClose -0.37% (win rate 40.1%).
 *      -> Systematically bled by institutional selling!
 *    - CORPORATE_ACTION (Demergers/M&A): Expands into close (+0.23% toClose, win rate 58.0%, t=+2.37).
 *
 * 3. Jump-Band Hazard & Net-of-Cost Decay (data/news/intraday2.json, n=4,432 liquid events, net of 0.10% friction):
 *    - Stocks popping > 2% on news lose -0.74% net to close (win rate 38.6%, t=-2.46).
 *    - Stocks popping 0.7% to 2% lose -0.30% net to close (win rate 39.5%).
 *    - Stocks dropping -0.7% to -2% drift further down (-0.50% net to close, t=-2.47).
 *
 * 4. Microstructural Exhaustion Limits (data/news/overmoved.json, 2.2M minute observations):
 *    - Prior 5m move > 2.5%: forward 30m net return drops to -0.27% (t = -5.05).
 *    - Distance from VWAP > 2.5%: forward 30m net return drops to -0.14%.
 *
 * 5. Company-Specific News Track Record (data/news/company_moves.json, n=8,232 events across 722 NSE equities):
 *    - Proven Expansion Runners: ATHERENERG (+3.67%, 68.8%), VBL (+1.14%, 61.9%), ANANTRAJ (+0.92%, 65.0%), HINDZINC (+0.86%, 64.0%), ADANIPORTS (+0.69%, 66.7%).
 *    - Proven Faders/Dumps: SKFINDIA (-1.69%), KOTAKBANK (-1.12%, 31.3%), COCHINSHIP (-1.00%, 33.3%), BHEL (-0.99%), HINDUNILVR (-0.76%, 33.3%), RVNL (-0.61%, 36.8%).
 *
 * 6. Predictive Edges Discovered Across 8,232 Joined Events:
 *    - Mid-Cap Order Sweet Spot (₹200 - ₹1,000 Cr): 72.7% win rate, Day 1 move +1.31% (Mega orders >= ₹1,000 Cr have only 47.1% win rate).
 *    - Margin Expansion Quality Beat: 67.2% win rate, abnormal return +1.03% (vs 55.7% for generic profit jumps).
 *    - Pre-News Leakage Penalty: Runup >= +1.0% in 60m before headline drops win rate to 40.0% (quiet unpriced bases hit 65.0%).
 *    - Day of Week Drift: Mondays produce +0.67% average gain (57.2% win rate), while Thursday F&O expiry drops -0.29% (45.8% win rate).
 *    - Multi-Day Governance Edge: CEO resignations decline -4.29% over 20 sessions (t = -5.24, 70.2% consistency).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, fs.existsSync(path.join(__dirname, '..', 'data')) ? '..' : '../..');
const STATS_FILE = path.join(ROOT, 'data', 'news', 'reaction_stats.json');
const MOVES_FILE = path.join(ROOT, 'data', 'news', 'company_moves.json');
const INTRA_STUDY_FILE = path.join(ROOT, 'data', 'news', 'intraday_study.json');
const INTRA2_FILE = path.join(ROOT, 'data', 'news', 'intraday2.json');
const OVERMOVED_FILE = path.join(ROOT, 'data', 'news', 'overmoved.json');

let cachedStats = null;
let cachedStatsMtime = 0;
let cachedMoves = null;
let cachedMovesMtime = 0;
let cachedCompanyMap = null;
let cachedIntraStudy = null;
let cachedIntraStudyMtime = 0;
let cachedIntra2 = null;
let cachedIntra2Mtime = 0;
let cachedOvermoved = null;
let cachedOvermovedMtime = 0;

function loadReactionStats() {
  try {
    const st = fs.statSync(STATS_FILE);
    if (cachedStats && st.mtimeMs === cachedStatsMtime) return cachedStats;
    cachedStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    cachedStatsMtime = st.mtimeMs;
    return cachedStats;
  } catch (_) {
    return null;
  }
}

function loadCompanyMoves() {
  try {
    const st = fs.statSync(MOVES_FILE);
    if (cachedMoves && st.mtimeMs === cachedMovesMtime) return cachedCompanyMap;
    cachedMoves = JSON.parse(fs.readFileSync(MOVES_FILE, 'utf8'));
    cachedMovesMtime = st.mtimeMs;
    cachedCompanyMap = new Map();
    if (cachedMoves && Array.isArray(cachedMoves.byCompany)) {
      for (const c of cachedMoves.byCompany) {
        if (c && c.symbol) cachedCompanyMap.set(String(c.symbol).toUpperCase(), c);
      }
    }
    return cachedCompanyMap;
  } catch (_) {
    return null;
  }
}

function loadIntradayStudy() {
  try {
    const st = fs.statSync(INTRA_STUDY_FILE);
    if (cachedIntraStudy && st.mtimeMs === cachedIntraStudyMtime) return cachedIntraStudy;
    cachedIntraStudy = JSON.parse(fs.readFileSync(INTRA_STUDY_FILE, 'utf8'));
    cachedIntraStudyMtime = st.mtimeMs;
    return cachedIntraStudy;
  } catch (_) {
    return null;
  }
}

function loadIntraday2() {
  try {
    const st = fs.statSync(INTRA2_FILE);
    if (cachedIntra2 && st.mtimeMs === cachedIntra2Mtime) return cachedIntra2;
    cachedIntra2 = JSON.parse(fs.readFileSync(INTRA2_FILE, 'utf8'));
    cachedIntra2Mtime = st.mtimeMs;
    return cachedIntra2;
  } catch (_) {
    return null;
  }
}

function loadOvermoved() {
  try {
    const st = fs.statSync(OVERMOVED_FILE);
    if (cachedOvermoved && st.mtimeMs === cachedOvermovedMtime) return cachedOvermoved;
    cachedOvermoved = JSON.parse(fs.readFileSync(OVERMOVED_FILE, 'utf8'));
    cachedOvermovedMtime = st.mtimeMs;
    return cachedOvermoved;
  } catch (_) {
    return null;
  }
}

/**
 * Normalizes news category from materiality, category, or headline text.
 */
function resolveCategory(mat, cat, text = '') {
  const m = String(mat || '').toUpperCase();
  const c = String(cat || '').toLowerCase();
  const t = String(text || '').toLowerCase();

  if (c === 'results' || m === 'RESULTS' || t.includes('financial result') || t.includes('q1') || t.includes('q2') || t.includes('q3') || t.includes('q4')) {
    return 'results';
  }
  if (c === 'deals' || m === 'ORDER' || t.includes('order') || t.includes('contract') || t.includes('bagged') || t.includes('secured')) {
    return 'deals';
  }
  if (c === 'oil' || m === 'COMMODITY' || t.includes('crude') || t.includes('oil') || t.includes('opec') || t.includes('brent')) {
    return 'oil';
  }
  if (c === 'ceo' || m === 'MANAGEMENT' || t.includes('resignation') || t.includes('managing director') || t.includes('ceo') || t.includes('cfo')) {
    return 'ceo';
  }
  if (c === 'bulk' || t.includes('bulk deal') || t.includes('block deal')) {
    return 'bulk';
  }
  if (c === 'promoter' || m === 'CAPITAL' || t.includes('promoter') || t.includes('stake') || t.includes('pledge')) {
    return 'promoter';
  }
  if (c === 'corporate_action' || m === 'CORPORATE_ACTION' || t.includes('demerger') || t.includes('scheme of demerger') || t.includes('merger') || t.includes('amalgamation') || t.includes('bonus') || t.includes('split')) {
    return 'corporate_action';
  }
  if (c === 'fed' || t.includes('interest rate') || t.includes('rbi') || t.includes('repo rate') || t.includes('fed')) {
    return 'fed';
  }
  if (c === 'ai' || t.includes('artificial intelligence') || t.includes('generative ai')) {
    return 'ai';
  }
  if (c === 'war' || t.includes('conflict') || t.includes('military') || t.includes('geopolitical')) {
    return 'war';
  }
  return c || 'deals'; // Fallback
}

/**
 * Evaluates how the market historically moved when such news hit in the past with deep predictive features.
 *
 * @param {Object} params
 * @param {string} params.symbol - NSE stock symbol (e.g. 'VBL', 'COCHINSHIP')
 * @param {string} [params.category] - News category ('results', 'deals', 'oil', etc.)
 * @param {string} [params.direction='UP'] - Expected news direction ('UP' or 'DOWN')
 * @param {string} [params.materiality] - Regulatory materiality ('RESULTS', 'ORDER', 'RISK', etc.)
 * @param {string} [params.title] - Headline text
 * @param {number} [params.priorMovePct] - Realized 5m or gap move ahead of entry
 * @param {number} [params.preLeakagePct] - Price move in the 60m prior to headline release
 * @param {number} [params.vwapDistPct] - Distance from VWAP
 * @param {Date|number} [params.eventDate] - Date of the event for calendar conditioning
 * @returns {Object} Comprehensive empirical microstructural evaluation
 */
function evaluateHistoricalMove({ symbol, category, direction = 'UP', materiality, title = '', priorMovePct = 0, preLeakagePct = 0, vwapDistPct = 0, eventDate = null, volSurgeRatio = null, prior5dRunup = null, openGapPct = null, isStage2 = null, isStage4 = null }) {
  const sym = String(symbol || '').toUpperCase().trim();
  const dir = String(direction || 'UP').toUpperCase();
  const cat = resolveCategory(materiality, category, title);
  const matKey = String(materiality || '').toUpperCase();
  const cleanTitle = String(title || '').toLowerCase();

  const stats = loadReactionStats();
  const compMap = loadCompanyMoves();
  const intraStudy = loadIntradayStudy();

  // 1. Category Reaction
  const catKey = cat + '|' + dir;
  const catReaction = (stats && stats.predict && stats.predict[catKey]) || null;

  // 2. Company Move History
  const compMove = (compMap && sym) ? compMap.get(sym) || null : null;

  let confidenceDelta = 0;
  let rationaleParts = [];
  let isRunner = false;
  let isFade = false;

  // --- Category-level Scoring ---
  let catSummary = null;
  if (catReaction && catReaction.n >= 25) {
    const agrees = catReaction.labelAgrees === true;
    const tStat = catReaction.t || 0;
    const movePct = catReaction.pct || 0;
    const n = catReaction.n;
    const mins = catReaction.minutes || 60;

    catSummary = {
      category: cat,
      direction: dir,
      n,
      minutes: mins,
      movePct,
      tStat,
      agrees,
      upShare: catReaction.upShare || null
    };

    if (agrees && tStat >= 1.8 && movePct > 0) {
      confidenceDelta += 8;
      isRunner = true;
      rationaleParts.push(`Category '${cat} ${dir}' historically continued (${mins}m move +${movePct.toFixed(2)}%, t=+${tStat.toFixed(2)}, n=${n})`);
    } else if (!agrees && tStat <= -2.0 && movePct < 0) {
      confidenceDelta -= 14;
      isFade = true;
      rationaleParts.push(`Category '${cat} ${dir}' historically faded (${mins}m move ${movePct.toFixed(2)}%, t=${tStat.toFixed(2)}, n=${n})`);
    } else if (!agrees && movePct < 0) {
      confidenceDelta -= 8;
      rationaleParts.push(`Category '${cat} ${dir}' historically showed negative drift (${movePct.toFixed(2)}%, n=${n})`);
    }
  }

  // --- Company-level Scoring ---
  let compSummary = null;
  if (compMove && compMove.n >= 10) {
    const n = compMove.n;
    const winRate = +(compMove.up * 100).toFixed(1);
    const meanMove = compMove.mean;
    const abnormal = compMove.adj != null ? compMove.adj : meanMove;

    compSummary = {
      symbol: sym,
      n,
      winRate,
      meanMove,
      abnormalReturn: abnormal
    };

    if (dir === 'UP') {
      if (winRate >= 58.0 && meanMove >= 0.50) {
        confidenceDelta += 12;
        isRunner = true;
        rationaleParts.push(`${sym} historically expanded on news (win rate ${winRate}%, mean +${meanMove.toFixed(2)}%, abnormal +${abnormal.toFixed(2)}%, n=${n})`);
      } else if (winRate >= 52.0 && meanMove > 0) {
        confidenceDelta += 6;
        rationaleParts.push(`${sym} historically positive on news (win rate ${winRate}%, mean +${meanMove.toFixed(2)}%, n=${n})`);
      } else if (winRate <= 42.0 || meanMove <= -0.50) {
        confidenceDelta -= 16;
        isFade = true;
        rationaleParts.push(`${sym} historically faded on news (win rate ${winRate}%, mean ${meanMove.toFixed(2)}%, abnormal ${abnormal.toFixed(2)}%, n=${n})`);
      } else if (meanMove < 0) {
        confidenceDelta -= 6;
        rationaleParts.push(`${sym} historical post-news return negative (${meanMove.toFixed(2)}%, n=${n})`);
      }
    } else if (dir === 'DOWN') {
      if (meanMove <= -0.50) {
        confidenceDelta += 10;
        rationaleParts.push(`${sym} historically dropped on news (mean ${meanMove.toFixed(2)}%, n=${n})`);
      }
    }
  }

  const isCompanyFader = compMove && (compMove.up <= 0.42 || compMove.mean <= -0.50);

  // --- 3. Order Win Crore Scope Sweet Spot ---
  if ((cat === 'deals' || matKey === 'ORDER') && dir === 'UP' && !isCompanyFader) {
    const croreMatch = cleanTitle.match(/(?:inr|rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:cr|crore)/i);
    if (croreMatch && croreMatch[1]) {
      const cr = Number(String(croreMatch[1]).replace(/,/g, ''));
      if (cr >= 200 && cr < 1000) {
        confidenceDelta += 5;
        isRunner = true;
        rationaleParts.push(`Order size ₹${cr} Cr is in empirical mid-cap sweet spot (₹200-1,000 Cr: win rate 72.7%, Day1 move +1.31%)`);
      } else if (cr < 50) {
        confidenceDelta -= 6;
        rationaleParts.push(`Small order size ₹${cr} Cr (<₹50 Cr) has high failure rate (win rate 39.3%)`);
      }
    }
  }

  // --- 4. Quality Earnings Beat (Margin / EBITDA Expansion) ---
  if ((cat === 'results' || matKey === 'RESULTS') && dir === 'UP') {
    if (cleanTitle.includes('margin') || cleanTitle.includes('ebitda') || cleanTitle.includes('record') || cleanTitle.includes('all-time')) {
      confidenceDelta += 6;
      isRunner = true;
      rationaleParts.push(`Quality Earnings Beat: Explicit margin expansion / record PAT (empirical win rate 67.2%, abnormal return +1.03%)`);
    }
  }

  // --- 5. Pre-News Insider Leakage vs Quiet Base ---
  const pLeak = Number(preLeakagePct || 0);
  if (pLeak >= 1.0) {
    confidenceDelta -= 10;
    isFade = true;
    rationaleParts.push(`Pre-news insider leakage (+${pLeak.toFixed(1)}% prior 60m): Post-news win rate drops to 40.0% (sell-the-news trap)`);
  } else if (pLeak <= -1.0 && dir === 'UP') {
    confidenceDelta += 6;
    rationaleParts.push(`Pre-news bear dip (${pLeak.toFixed(1)}%): Trapped shorts squeeze post-catalyst (empirical win rate 75.0%)`);
  }

  // --- 6. Microstructural Trajectory & Optimal Holding Window ---
  const matLookup = matKey || (cat === 'deals' ? 'ORDER' : (cat === 'results' ? 'RESULTS' : 'OTHER'));
  const intraMat = intraStudy && intraStudy.materiality && intraStudy.materiality[matLookup];
  let microTrajectory = null;
  let optimalHoldingWindow = 'Awaiting Tape Discovery';

  if (intraMat) {
    microTrajectory = {
      materiality: matLookup,
      n: intraMat.n,
      jump: intraMat.jump ? { mean: intraMat.jump.mean, med: intraMat.jump.med, win: intraMat.jump.win, t: intraMat.jump.t } : null,
      f5: intraMat.f5 ? { mean: intraMat.f5.mean, med: intraMat.f5.med, win: intraMat.f5.win, t: intraMat.f5.t } : null,
      f15: intraMat.f15 ? { mean: intraMat.f15.mean, med: intraMat.f15.med, win: intraMat.f15.win, t: intraMat.f15.t } : null,
      f30: intraMat.f30 ? { mean: intraMat.f30.mean, med: intraMat.f30.med, win: intraMat.f30.win, t: intraMat.f30.t } : null,
      f60: intraMat.f60 ? { mean: intraMat.f60.mean, med: intraMat.f60.med, win: intraMat.f60.win, t: intraMat.f60.t } : null,
      toClose: intraMat.toClose ? { mean: intraMat.toClose.mean, med: intraMat.toClose.med, win: intraMat.toClose.win, t: intraMat.toClose.t } : null
    };

    if (matLookup === 'ORDER') {
      optimalHoldingWindow = '0 to 5 minutes strictly (First 5m win rate 64.6%, decays into coin-flip by 30-60m)';
    } else if (matLookup === 'CORPORATE_ACTION') {
      optimalHoldingWindow = 'Intraday to close (Expands +0.23% into close, win rate 58.0%, t=+2.37)';
      if (dir === 'UP') {
        confidenceDelta += 8;
        isRunner = true;
        rationaleParts.push('Corporate Action / Demerger historically expanded into close (+0.23%, win rate 58.0%, t=+2.37)');
      }
    } else if (matLookup === 'RESULTS') {
      optimalHoldingWindow = 'DO NOT CHASE LONG (Mean-reverts -0.37% into close, win rate 40.1%)';
    } else if (matLookup === 'MANAGEMENT' || matLookup === 'RISK') {
      optimalHoldingWindow = 'Fade / Short drift (Bleeds -0.31% to -0.41% into close)';
    } else {
      optimalHoldingWindow = 'Micro scalping on confirmed 1m volume burst (OR15)';
    }
  }

  // --- 7. Micro Jump-Band & Overmoved Risk ---
  const realizedPrior = Number(priorMovePct || 0);
  let jumpBandWarning = null;
  if (realizedPrior >= 2.0) {
    jumpBandWarning = 'MEGA_POP_FADE_RISK: Stocks popping >= +2.0% on news lose -0.74% net into close (win rate 38.6%, t=-2.46). Over-chasing penalty applied.';
    confidenceDelta -= 15;
    isFade = true;
    rationaleParts.push(`Mega pop hazard: Prior runup +${realizedPrior.toFixed(1)}% falls into >2% band where 61.4% of trades lose into close`);
  } else if (realizedPrior >= 0.70) {
    jumpBandWarning = 'MODERATE_POP_FADE_RISK: Stocks popping +0.7% to +2.0% lose -0.30% net into close (win rate 39.5%). High mean-reversion risk.';
    confidenceDelta -= 8;
  } else if (realizedPrior <= -0.70) {
    jumpBandWarning = 'DOWNWARD_DRIFT_RISK: Stocks dropping <= -0.7% on news drift further down (-0.50% net to close, t=-2.47). Do not buy dip.';
  }

  // Check VWAP extension
  const vDist = Number(vwapDistPct || 0);
  if (vDist >= 2.5) {
    confidenceDelta -= 8;
    rationaleParts.push(`Extended ${vDist.toFixed(1)}% above VWAP (historical 30m forward return net of cost is -0.14%)`);
  }

  // --- 8. Volume Surge Expansion Multiplier (n=793, t=+5.52) ---
  const vSurge = volSurgeRatio !== null ? Number(volSurgeRatio) : null;
  if (vSurge !== null && vSurge > 0) {
    if (vSurge >= 3.0 && dir === 'UP') {
      confidenceDelta += 10;
      isRunner = true;
      rationaleParts.push(`Massive volume surge (${vSurge.toFixed(1)}x 20d avg): Strong institutional accumulation (Day 0 +1.21%, Day 1 +1.14%, t=+5.52, n=793)`);
    } else if (vSurge >= 1.5 && dir === 'UP') {
      confidenceDelta += 5;
      rationaleParts.push(`Solid volume expansion (${vSurge.toFixed(1)}x 20d avg): Institutional participation confirmed (Day 0 +0.29%, Day 1 +0.51%)`);
    } else if (vSurge < 0.8) {
      confidenceDelta -= 8;
      isFade = true;
      rationaleParts.push(`Volume vacuum (${vSurge.toFixed(1)}x 20d avg): Low volume news events historically bleed into close (-0.28%, t=-2.26, n=1,245)`);
    }
  }

  // --- 9. Opening Gap Calibration (Sweet Spot vs Gap-Down Trap) ---
  const oGap = openGapPct !== null ? Number(openGapPct) : null;
  if (oGap !== null) {
    if (oGap < 0 && dir === 'UP') {
      confidenceDelta -= 15;
      isFade = true;
      rationaleParts.push(`Gap-down trap on good news (${oGap.toFixed(1)}%): 66% failure rate, Day 0 -1.50% (t=-10.65, n=1,224). Refuse BUY.`);
    } else if (oGap >= 0.8 && oGap <= 3.5 && dir === 'UP') {
      confidenceDelta += 6;
      rationaleParts.push(`Sweet spot opening gap (+${oGap.toFixed(1)}%): Win rate 72.0%, Day 0 +1.77%, Day 1 +1.75% (t=+14.19, n=793)`);
    }
  }

  // --- 10. Prior 5-day Runup Exhaustion ---
  const p5d = prior5dRunup !== null ? Number(prior5dRunup) : null;
  if (p5d !== null) {
    if (p5d >= 8.0 && dir === 'UP') {
      confidenceDelta -= 10;
      isFade = true;
      rationaleParts.push(`Severe pre-event runup (+${p5d.toFixed(1)}% in 5d): Overheating / profit-taking drag (Win rate 50.8%, t=+1.09)`);
    } else if (p5d <= 3.0 && p5d >= -2.0 && dir === 'UP') {
      confidenceDelta += 4;
      rationaleParts.push(`Unextended base (5d move ${p5d.toFixed(1)}%): Clean unexhausted setup ahead of catalyst`);
    }
  }

  // --- 11. Trend Stage & Stage 4 Trap ---
  if (isStage4 === true && dir === 'UP') {
    confidenceDelta -= 6;
    rationaleParts.push('Stage 4 downtrend below 200 EMA: Heavy institutional overhead supply resistance');
  }

  // --- 12. Executive Resignation Short Edge (71.5% consistency) ---
  const isActualResignation = (cleanTitle.includes('resignation') || cleanTitle.includes('steps down') || cleanTitle.includes('quits') || cleanTitle.includes('resigned') || cleanTitle.includes('cessation of')) && !cleanTitle.includes('appointment');
  if (isActualResignation && dir === 'DOWN') {
    confidenceDelta += 12;
    isRunner = true;
    rationaleParts.push('Executive Resignation Short Edge: 71.5% negative consistency, Day 0 -0.80%, Day 1 -1.35% (t=-2.61, n=80)');
  }

  // --- 13. Institutional Golden Confluence Badge ---
  let isGoldenConfluence = false;
  if (isStage2 === true && (p5d === null || p5d < 4.0) && (oGap === null || (oGap >= 0.5 && oGap <= 3.5)) && (vSurge === null || vSurge >= 1.5) && dir === 'UP' && !isFade && !isCompanyFader) {
    isGoldenConfluence = true;
    confidenceDelta += 8;
    isRunner = true;
    rationaleParts.push('⭐ INSTITUTIONAL GOLDEN CONFLUENCE: Stage 2 + Clean Base + Sweet Spot Gap + Volume Surge (Empirical Win Rate 68.9%, Day 0 +2.09%, Abnormal +1.83%, t=+7.85, n=221)');
  }


  // Cap confidence adjustments
  confidenceDelta = Math.max(-35, Math.min(25, confidenceDelta));

  // Determine final verdict
  let verdict = 'HISTORICAL_NEUTRAL';
  let badge = null;
  if (confidenceDelta >= 8) {
    verdict = 'HISTORICAL_RUNNER';
    badge = isGoldenConfluence ? '⭐ INSTITUTIONAL GOLDEN CONFLUENCE' : '🚀 HISTORICAL RUNNER';
  } else if (confidenceDelta <= -8) {
    verdict = 'HISTORICAL_FADE';
    badge = '⚠️ HISTORICAL FADE';
  } else if (!catSummary && !compSummary) {
    verdict = 'INSUFFICIENT_DATA';
  }

  const summary = rationaleParts.length > 0
    ? `Learned from past: ${rationaleParts.join(' · ')}.`
    : 'No statistically significant historical move bias found.';

  return {
    symbol: sym,
    category: cat,
    direction: dir,
    materiality: matKey,
    verdict,
    badge,
    confidenceDelta,
    isRunner,
    isFade,
    summary,
    optimalHoldingWindow,
    jumpBandWarning,
    microTrajectory,
    categoryStats: catSummary,
    companyStats: compSummary,
    hasEmpiricalData: !!(catSummary || compSummary || microTrajectory)
  };
}

module.exports = {
  evaluateHistoricalMove,
  resolveCategory,
  loadReactionStats,
  loadCompanyMoves,
  loadIntradayStudy,
  loadIntraday2,
  loadOvermoved,
  STATS_FILE,
  MOVES_FILE,
  INTRA_STUDY_FILE,
  INTRA2_FILE,
  OVERMOVED_FILE
};
