/**
 * orderflow/sweepFvgLive.js — Real-Time Liquidity Sweep + Fair Value Gap (FVG) Signal Engine.
 *
 * Designed for live execution on Indian NSE cash equities via Angel One feed.
 * Fully compatible with tickCapture.js row shape: { t, s, p, q, v, bq, sq, bid, ask }.
 *
 * Core Microstructure Rules:
 * 1. 5-Minute Bar Cadence with 30m Opening Range (OR30) confluence.
 * 2. Causal Swing Pivots (n=3 lookback, 30-bar expiry).
 * 3. BSL/SSL Sweep Detection: wick >= 35% of bar range, close back inside level.
 * 4. FVG Displacement Filter: gap >= 0.20 * ATR(14) within 3 bars.
 * 5. Limit Entry at 50% FVG Midpoint (Consequent Encroachment) with strictly traded-through execution.
 * 6. Structural Stop Loss (Sweep extreme +/- 0.05) and Opposing Structural Target.
 * 7. Live Tick Monitoring: Stops and Targets evaluated tick-by-tick.
 * 8. Itemized NSE friction accounting (5.384 bps statutory + 1-4 bps slippage).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

let sendPhoneNotification = null;
try {
  const telegramService = require('../../common/notifications/telegramService');
  sendPhoneNotification = telegramService.sendPhoneNotification;
} catch (e) {
  // Telegram service optional in test/isolated environments
}

const IST_MS = 5 * 3600 * 1000 + 30 * 60 * 1000;
// THE MEASURED BLOCKED WINDOWS — 12:15-12:45 and 13:15-13:45 IST by default,
// the minutes the recorded corpus loses in across both engines, both one-per-day
// modes and both split halves (study and rule in backtest/follow.js
// BLOCKED_WINDOWS). The midday lull is a property of the SESSION, not of one
// engine's logic, so this engine refuses it too; its own maxSetupMinute (13:00)
// already covers the second window for setups, but not by a name the reader can
// trace — one list, read here and in the harness, is the point.
const { BLOCKED_WINDOWS } = require('../../backtest/follow');
// THE ONE WIN RULE, shared with the daily history, the server's strategy table and the
// page: a win is a call whose TARGET was actually hit. classify() decides each call's
// verdict and tallyOutcomes() counts them, so this engine's scorecard cannot disagree
// with the history table about the same book.
const { classify, tallyOutcomes } = require('../../common/market/callBookHistory');
const SESS_OPEN_MIN = 9 * 60 + 15;   // 09:15 IST = 555 min
const SESS_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST = 930 min
const BAR_MIN = 5;
const TICK_SIZE = 0.05;

// STOP BUFFER - measured, not intuition, and identical to orderflow/sweep_fvg_strategy.py so the two
// engines stay in parity. The old 1-tick-beyond-the-swept-extreme stop is the level every other
// participant watches: 38% of trades stopped out, and 18 of 101 comparable trades were taken out by
// exactly that tag (averaging -1.448R) against only 4 newly stopped by the buffer. A 0.25% buffer cuts
// the stop rate to 24% and the cost to 0.162R of risk, moving holdout from -0.008R to +0.110R.
// NOT yet cleared for live sizing: holdout n=54 and ex-top-10% is still -0.019R - paper it first.
const DEFAULT_STOP_BUFFER_BPS = 25.0;
const STATUTORY_BPS = 5.384;

const SECTOR_KEYWORDS = {
  BANK_FIN: [
    'BANK', 'FIN', 'CAP', 'HDFC', 'ICICI', 'KOTAK', 'AXIS', 'SBI', 'PNB', 'CANBK',
    'MUTHOOT', 'MANAPPURAM', 'CHOLA', 'SHRIRAM', 'BAJAJFIN', 'JIOFIN', 'INSUR',
    'LIFE', 'GI', 'AMC', 'BSE', 'MCX', 'ANGEL', 'CDSL', 'KFIN', 'FIVESTAR', 'POONAWALLA'
  ],
  IT_TECH: [
    'TECH', 'INFY', 'TCS', 'WIPRO', 'HCL', 'LTIM', 'PERSIST', 'COFORGE', 'MPHASIS',
    'KPIT', 'ELXSI', 'LTTS', 'CYIENT', 'BSOFT', 'SONAT', 'ZENSAR', 'HAPPST', 'MASTEK',
    'INTELLECT', 'ZENTEC', 'BBOX'
  ],
  AUTO_IND: [
    'MOTOR', 'AUTO', 'MARUTI', 'ASHOK', 'EICHER', 'TVS', 'BHARATFORG', 'SONA',
    'APOLLO', 'MRF', 'EXIDE', 'AMARA', 'BALKRIS', 'ESCORTS', 'LT', 'HAL', 'BEL',
    'BHEL', 'SIEMENS', 'ABB', 'CGPOWER', 'CUMMINS', 'SUZLON', 'THERMAX', 'AIAENG',
    'CONCOR', 'TMCV', 'BELRISE', 'ACE', 'JYOTICNC', 'UNIMECH', 'CRAFTSMAN', 'FORCEMOT'
  ],
  PHARMA_HEALTH: [
    'PHARM', 'SUNP', 'CIPLA', 'REDDY', 'DIVIS', 'LUPIN', 'AURO', 'ZYDUS', 'MANKIND',
    'TORNT', 'ALKEM', 'BIOCON', 'GLENMARK', 'IPCA', 'LAURUS', 'HOSP', 'MAXHEALTH',
    'FORTIS', 'MEDANTA', 'LALPATH', 'SYNGENE', 'ABBOT', 'MARKSANS', 'SHILPA', 'AARTI'
  ],
  FMCG_CONSUMER: [
    'HINDUNILVR', 'ITC', 'NESTLE', 'BRITAN', 'DABUR', 'MARICO', 'GODREJ', 'COLPAL',
    'VBL', 'RADICO', 'MCDOWELL', 'UBL', 'EMAMI', 'TITAN', 'TRENT', 'DMART', 'PAGEIND',
    'BATA', 'PATANJALI', 'CONSUM'
  ],
  METALS_COMMOD: [
    'STEEL', 'TATAST', 'JSW', 'HINDALCO', 'JINDAL', 'VEDL', 'COAL', 'NMDC', 'SAIL',
    'NALCO', 'HINDCOP', 'WELCORP', 'RATNAMANI', 'CEMENT', 'SHREECEM', 'ULTRACEM',
    'AMBUJA', 'ACC', 'DALBHARAT', 'GRASIM', 'PIDILIT', 'SRF', 'UPL', 'GPIL', 'SSWL'
  ],
  ENERGY_POWER: [
    'RELIANCE', 'ONGC', 'IOC', 'BPCL', 'HPCL', 'GAIL', 'PETRONET', 'OIL', 'NTPC',
    'POWERGRID', 'TATAPOW', 'ADANIGREEN', 'ADANIPOW', 'JSWENERGY', 'NHPC', 'SJVN',
    'ATGL', 'POWERINDIA'
  ],
  REALTY_INFRA: [
    'DLF', 'GODREJPROP', 'LODHA', 'OBEROI', 'PHOENIX', 'PRESTIGE', 'BRIGADE', 'SOBHA',
    'ANANTRAJ', 'SIGNATURE', 'HUDCO', 'IRCTC', 'IRCON', 'RVNL'
  ]
};

function getSector(sym) {
  const upper = sym.toUpperCase();
  for (const [sec, kws] of Object.entries(SECTOR_KEYWORDS)) {
    if (kws.some(kw => upper.includes(kw))) {
      return sec;
    }
  }
  return 'DIVERSIFIED';
}

function istMinute(t) {
  return Math.floor((t + IST_MS) / 60000) % 1440;
}

function istDay(t) {
  const d = new Date(t + IST_MS);
  return d.toISOString().slice(0, 10);
}

function barStart(t) {
  const m = istMinute(t);
  if (m < SESS_OPEN_MIN || m >= SESS_CLOSE_MIN) return null;
  return SESS_OPEN_MIN + BAR_MIN * Math.floor((m - SESS_OPEN_MIN) / BAR_MIN);
}

// ONE cost table, keyed by the exact exit reasons this engine emits. A reason that is not in the
// table THROWS rather than defaulting to the cheapest slippage: an implicit 1.0 bps default is what
// let a sibling ledger charge every stopped trade the passive rate and report a profit.
const SLIPPAGE_BPS = {
  stop: 4.0,
  target: 1.0,
  session_close: 2.0,
  time_exit: 2.0
};

// UNIVERSE GUARD. The engine consumes whatever the feed delivers, and the recorded tapes carry index
// quotes ('99926000') and broker test instruments ('011NSETEST') side by side with cash equity. An
// index quote is not a position anyone can hold, and the 368-symbol bar pack the research harnesses
// read does not contain these codes at all - so without this guard a replay and live disagree about
// the universe by construction, and a replay that trades an index books P&L that cannot exist.
// Rejecting them here states the universe explicitly instead of leaving it implied by whatever the
// subscription currently happens to include.
function isTradeableCash(sym) {
  if (!sym) return false;
  const s = String(sym).toUpperCase();
  if (/^\d+$/.test(s)) return false;        // index / special quote codes
  if (s.includes('NSETEST')) return false;  // broker test instruments
  return true;
}

let DEFAULT_UNIVERSE = null;
try {
  const uPath = path.join(__dirname, '..', '..', 'scratch', 'corrected_367_universe.json');
  if (fs.existsSync(uPath)) {
    const data = JSON.parse(fs.readFileSync(uPath, 'utf8'));
    if (data && Array.isArray(data.symbols)) {
      DEFAULT_UNIVERSE = new Set(data.symbols);
    }
  }
} catch (e) {}

function calcItemizedToll(exitReason) {
  if (!Object.prototype.hasOwnProperty.call(SLIPPAGE_BPS, exitReason)) {
    throw new Error('calcItemizedToll: unknown exit reason ' + JSON.stringify(exitReason) +
      ' - refusing to assume the cheapest slippage. Add it to SLIPPAGE_BPS with a measured value.');
  }
  return STATUTORY_BPS + SLIPPAGE_BPS[exitReason];
}

// ==========================================
// MEASURED PROFILES
// ==========================================
// Numbers are from scratch/study_10day.js, which drives every config over the same recorded tick
// tapes in one pass (one engine instance per config, so a difference cannot come from a different
// tape read or a different bar build), one lot, with ONE universe pinned at 562 symbols and passed
// explicitly to every engine - the engine's own fallback universe used to narrow that silently.
//
// HEAD-TO-HEAD, all ten recorded sessions 2026-09-28 .. 2026-10-12 (measured 2026-10-12):
//
//   profile                 trades  win%   net bps/trade   net Rs    PF   stops  sessions traded
//   measured_150_150            39   69.2           +56.1  +266.41 17.83      1   5 of 10
//   highWinRate (as now set)    26   34.6           -19.0   -50.17  0.28     15   3 of 10
//   previous defaults           61   42.6            +2.2   +75.79  1.50     29   7 of 10
//
// READ THIS BEFORE TRUSTING `highWinRate`. Its values were re-set by another editor at 10:16 on
// 2026-10-12, part-way through the measurement above, to shortOnly:false / buffer 25 / target 35 /
// minRr 1.0 / premove 0.5. That is the middle row: it LOSES money, on 15 stops in 26 trades, and
// Server.js selects it BY NAME. So the name now asserts the opposite of the measurement, and a
// previous version of this comment still described the geometry it used to hold - which is how a
// live bot ends up running one thing while its own documentation claims another. Either re-measure
// it or rename it; do not leave the name and the numbers disagreeing.
//
// measured_150_150 - both axes sit on a PLATEAU, which is the only part actually claimed: a 120 / 150
// / 200 bps stop buffer all return about 72% win and +59..+63 bps (a fitted spike would not survive
// that), and dropping the anti-chase rule makes it WORSE - 69.2% at +57.0 bps - so that rule earns
// its place rather than being decoration.
//
// WHAT IT IS NOT: proof of edge. About 89% of the rupees come from 10-07 alone, a broadly negative
// session (median stock -54 bps, 62% of the universe down), so part of the number is a short book on
// a down day. One stop in 39 trades means the tail is barely sampled - at a 150 bps buffer a single
// stop costs about three winners. Paper it; do not size it.
const PROFILES = {
  default: {},
  // Values below were set by another editor; left as found. See the note above: as measured on
  // 2026-10-12 this configuration loses money and does not live up to its name.
  highWinRate: {
    shortOnly: false, // ENABLE BOTH LONG (BUY) AND SHORT SETUPS
    stopBufferBps: 25,
    fixedTargetBps: 35,
    minRr: 1.0,
    minTargetBps: 15,
    maxPremovePct: 0.5
  },
  measured_150_150: {
    shortOnly: true,
    stopBufferBps: 150,
    fixedTargetBps: 150,
    minRr: 0.1,
    minTargetBps: 10,
    maxPremovePct: 0.6
  },
  // riskReward1to1 - a TRUE 1:1: the target sits exactly as far from the entry as that setup's own
  // stop, so the ratio is fixed across symbols instead of a fixed bps distance that silently means
  // 3.75R on one name and 0.5R on another. Requested as the standing geometry until something better
  // is found.
  //
  // MEASURED 2026-10-12, all 10 sessions, one lot, one pinned 562-symbol universe:
  //   1:1, buffer 150   40 trades | 65.0% win | +51.0 bps/trade | +Rs 271.67 | PF 15.76 | 1 stop
  //   fixed150/buf150   39 trades | 69.2% win | +56.1 bps/trade | +Rs 266.41 | PF 17.83 | 1 stop
  // So 1:1 is a WASH, and slightly WORSE on win rate: +Rs 5.26 of "extra" profit on 40 trades is
  // noise, while the win rate is genuinely 4 points lower. Its one real advantage is that the ratio is
  // honest per setup.
  //
  // DO NOT raise the win rate by narrowing the buffer to 60. That returns 71.1%, the best number of
  // anything tested, and it is a SPIKE: its own neighbours are 65.7% at 50 and 69.2% at 80, and its
  // stop count (5) is not even monotonic against them (6 at 50, 4 at 80, 1 at 150). Profit, by
  // contrast, rises MONOTONICALLY with the buffer - 100 / 132 / 185 / 233 / 249 / 272 for 40..150 -
  // which is a real effect (a wider stop is harder to shake out). Narrowing the buffer to buy a
  // single-point win-rate peak would be fitting the tape.
  riskReward1to1: {
    shortOnly: false, // Enabled both LONG and SHORT setups (previously shortOnly: true locked out all longs)
    stopBufferBps: 150,
    targetRr: 1.0,
    minRr: 0.1,
    minTargetBps: 10,
    maxPremovePct: 0.6
  }
};
// Which profile a caller gets when it does not name one. Deliberately 'default', NOT a measured
// profile: every harness in scratch/ that reproduces earlier numbers calls this factory with partial
// options, and an implicit switch would silently change what those replays mean. The live bot selects
// its profile explicitly in Server.js (`GB_SWEEP_PROFILE`, currently riskReward1to1), where the choice
// is visible in one place and printed at startup, and the replay CLI takes --profile so the same
// geometry can be re-run against any tape.
const DEFAULT_PROFILE = 'default';

/** Profile first, then the caller's own values. `undefined` never overrides, so an accidental
 *  `{ stopBufferBps: undefined }` does not silently reset the profile. */
function mergedOptions(options) {
  const name = options.profile || DEFAULT_PROFILE;
  const profile = PROFILES[name];
  if (!profile) {
    throw new Error('createSweepFvgLive: unknown profile ' + JSON.stringify(name) +
      ' - known profiles: ' + Object.keys(PROFILES).join(', '));
  }
  const out = Object.assign({}, profile);
  for (const k of Object.keys(options)) {
    // `profile` is a SELECTOR, not an option - carrying it into the merged set would leave the engine
    // reading an option it never consults, and hide the difference between "named a profile" and
    // "named a profile and got its geometry".
    if (k === 'profile') continue;
    if (options[k] !== undefined) out[k] = options[k];
  }
  return out;
}

function createSweepFvgLive(options = {}) {
  // A profile is a NAMED SET OF OPTION VALUES, not a second engine. Explicit options always win over
  // the profile, so a study can still vary one axis without silently inheriting a different strategy.
  const opt = mergedOptions(options);
  const swingN = opt.swingN || 3;
  const fvgAtrMult = opt.fvgAtrMult || 0.20;
  const wickRatioMin = opt.wickRatioMin || 0.35;
  const maxRetraceBars = opt.maxRetraceBars || 6;
  const shortOnly = opt.shortOnly !== undefined ? opt.shortOnly : false;
  const useSentimentFilter = opt.useSentimentFilter !== undefined ? opt.useSentimentFilter : true;
  const maxPremovePct = opt.maxPremovePct || 0.60;
  const enforceDiscountPremium = opt.enforceDiscountPremium !== undefined ? opt.enforceDiscountPremium : true;
  // Stop buffer and target gates are options so an exit-geometry study can drive them without
  // editing production defaults. Omitted -> the measured production values.
  const stopBufferBps = opt.stopBufferBps !== undefined ? opt.stopBufferBps : DEFAULT_STOP_BUFFER_BPS;
  const minRr = opt.minRr !== undefined ? opt.minRr : 1.5;
  const minTargetBps = opt.minTargetBps !== undefined ? opt.minTargetBps : 25.0;
  // Maximum minute of the session (IST) after which NO new setups are armed (default 13:00 IST = 780 min)
  // Stops entering late-afternoon chop where trades cannot reach target before 15:30 close
  const maxSetupMinute = opt.maxSetupMinute !== undefined ? opt.maxSetupMinute : 780;
  // For 1-lot accounts, cap share price to avoid extreme price outliers (e.g. Rs 17,000) dominating 1-lot P&L
  const maxSharePrice = opt.maxSharePrice !== undefined ? opt.maxSharePrice : 3000.0;
  // Universe set: defaults to the 368 liquid NSE equity universe
  const universe = opt.universe !== undefined ? opt.universe : DEFAULT_UNIVERSE;
  const maxHoldBars = opt.maxHoldBars !== undefined ? opt.maxHoldBars : 0;
  // FIXED-DISTANCE TARGET. When > 0 the exit is pinned to this many bps from the entry instead of the
  // nearest structural pivot. Needed for an honest high-probability profile: with pivot targets the
  // same config silently trades a different R:R on every symbol, so "win rate" measures the pivot
  // layout of the day rather than the edge.
  const fixedTargetBps = opt.fixedTargetBps !== undefined ? opt.fixedTargetBps : 0;
  // RISK-MULTIPLE TARGET. targetRr 1.0 means "target exactly as far from the entry as the stop is" -
  // a real 1:1, where the reward scales with whatever risk that particular setup carries. This is NOT
  // the same as fixedTargetBps: a fixed 150 bps target against a 40 bps stop is 3.75R on one symbol and
  // against a 300 bps stop is 0.5R on another, so a fixed target cannot express an R:R at all.
  // Takes precedence over fixedTargetBps and over structural pivots when > 0. 0 = disabled.
  const targetRr = opt.targetRr !== undefined ? opt.targetRr : 0;
  // TREND ALIGNMENT. The sweep fade is counter-trend by construction, which is where its sub-50% hit
  // rate comes from. Requiring the session VWAP - the institutional benchmark - to be sloping the
  // SAME way as the trade (down for shorts) keeps the same entry but only in names whose aggregate
  // flow already agrees with it.
  const requireTrendAlign = opt.requireTrendAlign !== undefined ? opt.requireTrendAlign : false;
  const trendLookbackBars = opt.trendLookbackBars !== undefined ? opt.trendLookbackBars : 4;
  const minVwapSlopeBps = opt.minVwapSlopeBps !== undefined ? opt.minVwapSlopeBps : 0;
  // Per-symbol daily trade budget. 0 = unlimited (previous behaviour).
  const maxTradesPerDay = opt.maxTradesPerDay !== undefined ? opt.maxTradesPerDay : 0;
  const riskPerTrade = opt.riskPerTrade || 1000.0;
  const useOneLot = opt.useOneLot !== undefined ? opt.useOneLot : true;
  const fixedShares = opt.fixedShares || (useOneLot ? 1 : null);
  // "THIS PROCESS IS THE LIVE BOT." Declared, never inferred - see the rehearsal guard below.
  const liveJournal = opt.liveJournal === true;
  const enableTelegram = opt.enableTelegram !== undefined ? opt.enableTelegram : (liveJournal && process.env.GB_TELEGRAM_ALERTS !== '0');
  const enableScorecardTimer = opt.enableScorecardTimer !== undefined ? opt.enableScorecardTimer : liveJournal;
  const journalDir = opt.journalDir || path.join(__dirname, '..', '..', 'data', 'orderflow');
  const resumeExisting = opt.resumeExisting !== undefined ? opt.resumeExisting : false;

  const symbols = new Map(); // sym -> SymbolState
  const signals = [];        // all generated signals
  const closedTrades = [];   // all settled trades

  let sessionDate = opt.sessionDate || istDay(Date.now());
  let journalFile = path.join(journalDir, `sweep-fvg-signals-${sessionDate}.jsonl`);
  const callsFile = path.join(journalDir, `daily_calls_${sessionDate}.json`);

  // A REHEARSAL MUST NOT BE ABLE TO WRITE TODAY'S RECORD.
  // This is not hypothetical. scratch/verify_cross_engine_parity.js constructed the engine with no
  // options on 2026-10-12, so it inherited the production journalDir and the default-on Telegram, and
  // a parity replay OVERWROTE that day's live journal with its own two sample-symbol calls and
  // dispatched a fabricated 15:30 scorecard to the real channel - during the live session. The live
  // engine kept its own copy in memory and rewrote the file on its next arm, so nothing was lost, but
  // nothing in the engine had refused. Nine harnesses in scratch/ construct the engine without a
  // journalDir; a per-harness fix would regress the moment someone writes a tenth.
  //
  // The rule is therefore at the boundary: a process that has not declared itself live
  // (`liveJournal: true`, which only Server.js sets) may not write a journal for TODAY's session, and
  // may not notify. Replaying a PAST date - what every study actually does - is unaffected, so this
  // costs no existing capability. Writing today's file requires saying so out loud.
  let rehearsalRefused = false;
  function refuseRehearsalWrite(what) {
    if (rehearsalRefused) return;
    rehearsalRefused = true;
    console.error(`[sweep-fvg] REFUSED to write ${what} for TODAY's session (${sessionDate}) from a ` +
      `process that is not the live bot. Pass liveJournal: true to claim the live session, or give ` +
      `this process its own journalDir for a rehearsal. Nothing was written.`);
  }
  const mayWriteSession = () => liveJournal || sessionDate !== istDay(Date.now());

  const dailyCalls = [];
  if (resumeExisting && fs.existsSync(callsFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
      if (Array.isArray(existing)) dailyCalls.push(...existing);
    } catch (e) {}
  }

  // CALL IDENTITY / DE-DUPLICATION.
  // Re-hydrating today's file at construction is deliberate - a restart mid-session must not lose the
  // day. But the engine then re-arms and re-records a setup it had already written, generating a NEW
  // id from dailyCalls.length while symbol/side/time/limit/stop were identical, so every call appeared
  // twice and the 15:30 scorecard counted both. Identity is the setup itself, never the counter.
  const callKey = (c) => [c.symbol, c.side, c.timeIST, c.limitEntry, c.stopLoss].join('|');
  const callByKey = new Map();
  for (const c of dailyCalls) {
    const k = callKey(c);
    if (!callByKey.has(k)) callByKey.set(k, c);
  }
  /** Returns the canonical record for this setup; `added` is false when the file already held it. */
  function registerCall(call) {
    const k = callKey(call);
    const existing = callByKey.get(k);
    if (existing) return { call: existing, added: false };
    callByKey.set(k, call);
    dailyCalls.push(call);
    return { call, added: true };
  }

  let hasSentScorecard = false;
  // CALL ID SEQUENCE. The id used to be derived from dailyCalls.length, which stops growing whenever
  // registerCall() recognises a setup it already has (the restart / de-duplication path). Two
  // different setups then both came out as CALL-X-003. The identity that de-duplicates is still the
  // setup key; the id just has to be unique, so it comes from a monotonic counter.
  let callSeq = 0;

  function saveDailyCalls() {
    if (!mayWriteSession()) { refuseRehearsalWrite(callsFile); return; }
    try {
      if (!fs.existsSync(journalDir)) {
        fs.mkdirSync(journalDir, { recursive: true });
      }
      // A WRITE MUST NOT ERASE WHAT THE FILE ALREADY HOLDS.
      // This rewrites the whole file from memory, and memory starts empty on every start
      // (resumeExisting defaults to false) - so a mid-session restart silently deleted the day's
      // earlier calls from the record. That is the opposite of what the identity/de-duplication
      // comment above promises ("a restart mid-session must not lose the day"), and it was observed
      // on 2026-10-12: a restart at 11:25 left the three calls armed at 10:50 and 11:00 in no file at
      // all. Records the engine does not itself hold are therefore carried over, and carried over
      // LOUDLY, because a silent merge is indistinguishable from a bug.
      // A BOOK WE CANNOT READ IS A BOOK WE MUST NOT OVERWRITE — the same rule, and the same
      // failure, as liveMinuteEngine.saveCalls(): the swallow-everything `catch (e) {}` here meant a
      // file that could not be parsed (a second writer mid-write; on Windows `writeFileSync`
      // truncates its target first) fell through to "write this process's own calls", which for a
      // process holding none yet is `[]` over the whole day. That is how 2026-10-19's book came to
      // be two bytes at 09:51.
      const exists = fs.existsSync(callsFile);
      let raw = null;
      if (exists) {
        try { raw = fs.readFileSync(callsFile, 'utf8'); } catch (e) {
          console.error(`[sweep-fvg] cannot READ ${path.basename(callsFile)} (${e.message}) — refusing to ` +
            `overwrite it. The day's book is left as it is until it can be read.`);
          return;
        }
      }
      let toWrite = dailyCalls;
      const mine = new Set(dailyCalls.map(callKey));
      if (raw != null && raw.trim() !== '') {
        let onDisk = null;
        try { onDisk = JSON.parse(raw); } catch (_) { onDisk = null; }
        if (onDisk === null) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          try {
            fs.writeFileSync(`${callsFile}.corrupt-${stamp}`, raw, 'utf8');
            fs.writeFileSync(`${callsFile}.unmerged-${stamp}.json`, JSON.stringify(dailyCalls, null, 2), 'utf8');
          } catch (_) {}
          console.error(`[sweep-fvg] ${path.basename(callsFile)} is not readable JSON — REFUSING to overwrite ` +
            `it. Kept the file, wrote .corrupt-${stamp} beside it and this session's ${dailyCalls.length} ` +
            `record(s) to .unmerged-${stamp}.json.`);
          return;
        }
        const carried = Array.isArray(onDisk) ? onDisk.filter((c) => c && !mine.has(callKey(c))) : [];
        if (carried.length) {
          toWrite = dailyCalls.concat(carried);
          console.log(`[sweep-fvg] calls file carried over ${carried.length} record(s) this process ` +
            `does not hold (${carried.map((c) => c.symbol).join(', ')}) - not erased. They appear in ` +
            `the record but not in this session's scorecard, which only counts what it saw.`);
        }
      }
      // Atomic: a reader in the other engine can never see a half-written document.
      const tmpFile = `${callsFile}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(toWrite, null, 2), 'utf8');
      fs.renameSync(tmpFile, callsFile);
    } catch (err) {
      console.error(`[sweep-fvg] Calls write error: ${err.message}`);
    }
  }

  // AN UNSENT ALERT MUST NOT BE LOGGED AS SENT.
  //
  // `sendPhoneNotification()` answers `{success:false, reason}` rather than THROWING when the token
  // or chat id is missing, so `await notifyTelegram(msg); console.log('successfully dispatched')`
  // printed a delivery that never happened — on 2026-10-16 the 15:30 scorecard reported "successfully
  // dispatched to Telegram!" while the board payload reported `chatIdKnown: false` for the whole
  // session. The result is now returned to the caller, and the FIRST failure of a given reason is
  // printed once (not every alert), so a broken bot is visible in the log without drowning it.
  let lastTelegramFailureReason = null;
  // `dedupeKey` names the EVENT this message is about, and the transport drops a second copy of
  // it — across restarts and across two running instances, which is exactly how the channel
  // flooded on 2026-10-19 (the same exit announced two and three times, the day's book re-sent
  // in one burst). Every alert here is about a named call and an outcome, so every one of them
  // can name its event; see common/notifications/telegramService.js.
  async function notifyTelegram(msg, dedupeKey) {
    if (!enableTelegram || !sendPhoneNotification) return { success: false, reason: 'telegram disabled in this process' };
    try {
      const res = await sendPhoneNotification(msg, dedupeKey ? { dedupeKey } : {});
      const ok = !!(res && res.success);
      const reason = (res && res.reason) || 'sender returned no result';
      if (!ok) {
        if (lastTelegramFailureReason !== reason) {
          lastTelegramFailureReason = reason;
          console.warn('[sweep-fvg] ⚠️ TELEGRAM DELIVERY FAILED: ' + reason +
            ' — alerts are still attempted; the scorecard and journal are written regardless.');
        }
      } else {
        lastTelegramFailureReason = null;
      }
      return res || { success: false, reason };
    } catch (err) {
      console.error(`[sweep-fvg] Telegram notification error: ${err.message}`);
      return { success: false, reason: err.message };
    }
  }

  function formatSetupArmedAlert(call) {
    const icon = call.action === 'BUY' ? '🟢' : '🔴';
    const modeBadge = call.strategyType === 'SCALPING' ? '⚡ SCALPING (Fast 5m Sweep)' : '📊 INTRADAY (Structural Expansion)';
    return `<b>${icon} NEW SIGNAL: ${call.action} ${call.symbol}</b>\n` +
      `───────────────────────\n` +
      `🎯 <b>Strategy</b>: <code>${modeBadge}</code>\n` +
      `🏢 <b>Sector</b>: ${call.sector}\n` +
      `⏱️ <b>Time</b>: ${call.timeIST} IST\n\n` +
      `💵 <b>Limit Entry</b>: ₹${call.limitEntry.toFixed(2)}\n` +
      `🎯 <b>Target</b>: ₹${call.target.toFixed(2)} (+${call.rewardPts.toFixed(2)} pts | +${call.targetBps.toFixed(1)} bps)\n` +
      `🛑 <b>Stop Loss</b>: ₹${call.stopLoss.toFixed(2)} (-${call.riskPts.toFixed(2)} pts | -${call.riskBps.toFixed(1)} bps)\n` +
      `⚖️ <b>Risk:Reward</b>: <b>${call.riskReward}</b>\n` +
      `📦 <b>Sizing</b>: <b>1 LOT (1 Share)</b>\n\n` +
      `🌊 <b>Market Breadth</b>: ${call.marketBreadth}\n` +
      `🏢 <b>Sector Breadth</b>: ${call.sectorBreadth}\n` +
      `───────────────────────\n` +
      `⚠️ <i>Valid only if filled before ${(maxPremovePct * 100).toFixed(0)}% expansion. Strictly no chase!</i>`;
  }

  function formatOrderFilledAlert(call) {
    const icon = call.action === 'BUY' ? '🟢' : '🔴';
    return `🔔 <b>ORDER FILLED: ${call.action} ${call.symbol}</b>\n` +
      `───────────────────────\n` +
      `🎯 <b>Strategy</b>: <b>GB01 — 5m FVG Retest</b> (${call.strategyType || 'INTRADAY'})\n` +
      `💵 <b>Executed At</b>: ₹${call.fillPrice.toFixed(2)}\n` +
      `🛑 <b>Stop Loss Active</b>: ₹${call.stopLoss.toFixed(2)}\n` +
      `🎯 <b>Target Active</b>: ₹${call.target.toFixed(2)}\n` +
      `📦 <b>Quantity</b>: 1 LOT\n` +
      `⏱️ <b>Time</b>: ${call.entryTimeIST} IST\n` +
      `───────────────────────\n` +
      `<i>Order live. Monitoring tick-by-tick for Target or Stop Loss.</i>`;
  }

  function formatTradeExitAlert(call, trade) {
    if (trade.exitReason === 'target') {
      return `🎉 <b>TARGET HIT! ✅ — ${call.symbol}</b>\n` +
        `───────────────────────\n` +
        `🎯 <b>Strategy</b>: <b>GB01 — 5m FVG Retest</b> (${call.strategyType || 'INTRADAY'})\n` +
        `📊 <b>Action</b>: ${call.action}\n` +
        `💵 <b>Entry</b>: ₹${trade.entryPx.toFixed(2)} ➔ <b>Exit</b>: ₹${trade.exitPx.toFixed(2)}\n` +
        `💰 <b>Gross Profit</b>: <b>+${trade.grossPt.toFixed(2)} pts</b>\n` +
        `🪙 <b>Net P&L (1 Lot)</b>: <b>+₹${trade.netInr.toFixed(2)}</b>\n` +
        `📈 <b>Net Return</b>: +${trade.netBps.toFixed(1)} bps\n` +
        `⏱️ <b>Closed At</b>: ${call.exitTimeIST} IST\n` +
        `───────────────────────\n` +
        `<i>Target reached cleanly! Profit locked on 1 lot.</i>`;
    } else if (trade.exitReason === 'stop') {
      return `🛑 <b>STOP LOSS HIT ❌ — ${call.symbol}</b>\n` +
        `───────────────────────\n` +
        `🎯 <b>Strategy</b>: <b>GB01 — 5m FVG Retest</b> (${call.strategyType || 'INTRADAY'})\n` +
        `📊 <b>Action</b>: ${call.action}\n` +
        `💵 <b>Entry</b>: ₹${trade.entryPx.toFixed(2)} ➔ <b>Exit</b>: ₹${trade.exitPx.toFixed(2)}\n` +
        `📉 <b>Gross Loss</b>: <b>${trade.grossPt.toFixed(2)} pts</b>\n` +
        `💸 <b>Net P&L (1 Lot)</b>: <b>-₹${Math.abs(trade.netInr).toFixed(2)}</b>\n` +
        `📉 <b>Net Return</b>: ${trade.netBps.toFixed(1)} bps\n` +
        `⏱️ <b>Closed At</b>: ${call.exitTimeIST} IST\n` +
        `───────────────────────\n` +
        `<i>Risk strictly capped at structural invalidation level.</i>`;
    } else {
      return `🔔 <b>SESSION CLOSE EXIT — ${call.symbol}</b>\n` +
        `───────────────────────\n` +
        `🎯 <b>Strategy</b>: <b>GB01 — 5m FVG Retest</b> (${call.strategyType || 'INTRADAY'})\n` +
        `💵 <b>Closed at Market</b>: ₹${trade.exitPx.toFixed(2)} (Net: ₹${trade.netInr.toFixed(2)})\n` +
        `⏱️ <b>Time</b>: 15:30 IST`;
    }
  }

  function formatDailyScorecard(calls, sDate) {
    // THE ONE WIN RULE, NOT A PAGE-SIDE FILTER. This used to count any close with
    // netInr1Lot > 0 as "Succeeded (Won)" — a +₹0.01 flatten and a 15:30 session close
    // both became wins, and real stops were lumped with them under "Failed". The shared
    // classifier decides: target hit = won, stop hit = failed, and a close that touched
    // neither level is its own bucket, never a win.
    const tally = tallyOutcomes(calls);
    const completed = calls.filter(c => c.status === 'WON' || c.status === 'LOST' || c.status === 'SESSION_CLOSE' || c.status === 'TIME_EXIT');
    const wonCount = tally.targetHits;
    const lostCount = tally.stopsHit;
    const otherCount = tally.otherExits;
    // THE THREE BUCKETS MUST BE DISJOINT AND MUST ADD UP. EXPIRED used to sit in this cancel list,
    // which made "Anti-Chase Filtered" count setups that were never anti-chased at all (an expired
    // window is just a limit that never got touched) - and it double-counted against the never-filled
    // line, so the card could claim 4 calls out of 2. EXPIRED belongs to never-filled; the cancel
    // bucket is only the calls this strategy actively refused.
    const cancelled = calls.filter(c => c.status === 'CANCELLED_EXHAUSTION' || c.status === 'INVALIDATED' || c.status === 'REJECTED_RISK' || c.status === 'CANCELLED_TRADE_LIMIT');
    
    const totalCalls = calls.length;
    const executed = completed.length;
    // Decided trades only (target or stop), and "not measured" rather than 0.0% when
    // nothing decided — 0.0% is a claim about performance that no trade supports.
    const decided = tally.targetHits + tally.stopsHit;
    const winRate = decided > 0 ? ((tally.targetHits / decided) * 100).toFixed(1) : null;

    // WHAT THE CARD NEVER SAID: how many calls never became a trade at all. It printed "Total Calls
    // Generated" and "Executed Trades" with no bridge between them, so a day that emitted 91 calls and
    // traded 40 looked like a 40-trade day with no explanation of the other 51. Measured 2026-10-12
    // over seven sessions: 91 calls, 40 filled, 11 cancelled, and 40 that simply never reached their
    // limit price - 44% of everything the engine emitted. Those calls cost nothing and earn nothing,
    // and they belong on the card next to the money, because they are the difference between "the
    // strategy traded well" and "the strategy barely traded".
    // FILLED is an in-flight state (the fill happened, the exit has not); at session close the engine
    // resolves every position, so a FILLED call left over is a bug, not a category. It is counted here
    // so the three buckets still reconcile when that bug happens - and scratch/test_scorecard_ledger.js
    // fails separately on any call left FILLED, so the bucket arithmetic cannot hide it.
    const unfilled = calls.filter(c => c.status === 'ARMED' || c.status === 'EXPIRED' || c.status === 'FILLED');
    
    // The card said "Net Points" while summing GROSS points, which is how a day reads +431 pts and
    // -Rs 30 at the same time. At one lot one point is one rupee, so net points and net rupees are the
    // same number; gross is now labelled gross and net is the money actually kept.
    const grossPts = completed.reduce((sum, c) => sum + (c.grossPoints1Lot || 0), 0);
    const netPts = completed.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0);
    const netInr = netPts;
    // Net rupees per call EMITTED - the productivity of the signal itself, not of the fills it chose.
    // Computed HERE, after netPts exists: the first version of this line sat above the declaration and
    // crashed the scorecard with a temporal-dead-zone ReferenceError, which the ledger test caught.
    const netPerCall = totalCalls > 0 ? (netPts / totalCalls) : 0;
    
    const grossProfit = completed.filter(c => (c.netInr1Lot || 0) > 0).reduce((sum, c) => sum + c.netInr1Lot, 0);
    const grossLoss = Math.abs(completed.filter(c => (c.netInr1Lot || 0) < 0).reduce((sum, c) => sum + c.netInr1Lot, 0));
    const pf = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? '999.0' : '0.00');

    let recapLines = '';
    if (completed.length === 0) {
      recapLines = '• <i>No executed trades closed today.</i>';
    } else {
      recapLines = completed.slice(0, 15).map((c, idx) => {
        // The icon follows the SAME classifier the counts above use: ✅ only for a
        // target that was actually hit.
        const oKey = classify(c).key;
        const icon = oKey === 'TARGET_HIT' ? '✅' : (oKey === 'STOP_LOSS_HIT' ? '❌' : '⏱️');
        // TIME_EXIT lands on the ⏱️ branch with the session closes: it is a closed trade, not a stop.
        const sideIcon = c.action === 'BUY' ? '🟢' : '🔴';
        const pts = c.grossPoints1Lot >= 0 ? `+${c.grossPoints1Lot.toFixed(2)}` : `${c.grossPoints1Lot.toFixed(2)}`;
        const inr = c.netInr1Lot >= 0 ? `+₹${c.netInr1Lot.toFixed(2)}` : `-₹${Math.abs(c.netInr1Lot).toFixed(2)}`;
        return `${idx + 1}. ${sideIcon} <b>${c.symbol}</b> [${c.strategyType}] ➔ ${inr} (${pts} pts) ${icon}`;
      }).join('\n');
      if (completed.length > 15) {
        recapLines += `\n<i>...and ${completed.length - 15} more trades</i>`;
      }
    }

    const grossPtsStr = grossPts >= 0 ? `+${grossPts.toFixed(2)}` : `${grossPts.toFixed(2)}`;
    const netInrStr = netInr >= 0 ? `+₹${netInr.toFixed(2)}` : `-₹${Math.abs(netInr).toFixed(2)}`;

    return `🏁 <b>END-OF-DAY SCORECARD (15:30 IST)</b>\n` +
      `📅 Date: <b>${sDate}</b>\n` +
      `📈 Engine: <b>Sweep + FVG + Delta Logic</b>\n` +
      `📦 Sizing: <b>1 LOT ONLY (1 Share per Trade)</b>\n` +
      `───────────────────────────\n` +
      `📊 <b>PERFORMANCE SUMMARY</b>:\n` +
      `• Total Calls Generated: <b>${totalCalls}</b>\n` +
      `• Executed Trades: <b>${executed}</b>\n` +
      `• 🛡️ Cancelled before fill: <b>${cancelled.length}</b> <i>(anti-chase / invalidated / risk)</i>\n` +
      `• ✅ <b>Target hit</b>: <b>${wonCount}</b>\n` +
      `• ❌ <b>Stop loss hit</b>: <b>${lostCount}</b>\n` +
      `• ⏱️ <b>Closed without a level</b>: <b>${otherCount}</b> <i>(session close / breakeven / time exit — NOT counted as wins)</i>\n` +
      `• 🎯 <b>Win Rate: ${winRate === null ? 'not measured (no target/stop decided)' : winRate + '%'}</b> <i>(target hits / ${decided} decided trades)</i>\n` +
      `• 📈 <b>Gross Points: ${grossPtsStr} pts</b>\n` +
      `• 💰 <b>Net P&L (1 Lot): ${netInrStr}</b> <i>(after 5.384 bps statutory + 1-4 bps exit slippage)</i>\n` +
      `• 🛡️ <b>Profit Factor: ${pf}</b>\n` +
      `• 📭 <b>Never filled: ${unfilled.length}</b> <i>(price never reached the limit - Rs 0, no trade either way)</i>\n` +
      `• 📐 <b>Net per call emitted: Rs ${netPerCall.toFixed(2)}</b> <i>(net / all ${totalCalls} calls, filled or not)</i>\n` +
      `───────────────────────────\n` +
      `📋 <b>CALL-BY-CALL RECAP</b>:\n` +
      `${recapLines}\n` +
      `───────────────────────────\n` +
      `📁 <i>All calls recorded to data/orderflow/daily_calls_${sDate}.json</i>`;
  }

  async function sendDailyScorecard(opts = {}) {
    const force = opts.force === true;
    if (hasSentScorecard && !force) return;
    hasSentScorecard = true;

    saveDailyCalls();
    const summaryMsg = formatDailyScorecard(dailyCalls, sessionDate);
    console.log('\n[sweep-fvg] 3:30 PM DAILY SCORECARD:\n' + summaryMsg.replace(/<[^>]*>/g, '') + '\n');

    if (enableTelegram) {
      try {
        const res = await notifyTelegram(summaryMsg, 'sweep:scorecard:' + sessionDate);
        // Claim delivery only when the SENDER confirms it. The unconditional success line below this
        // block is what made a 15:30 scorecard with no linked chat id look like it had been sent.
        if (res && res.success) {
          console.log('[sweep-fvg] 3:30 PM Scorecard dispatched to Telegram (' +
            (Array.isArray(res.sentTo) ? res.sentTo.join(' + ') : 'ok') + ')');
        } else {
          console.warn('[sweep-fvg] 3:30 PM Scorecard NOT delivered to Telegram: ' +
            ((res && res.reason) || 'unknown reason') + ' — it is on disk at ' +
            path.join(journalDir, `scorecard_${sessionDate}.json`));
        }
      } catch (err) {
        console.error('[sweep-fvg] Failed to send Telegram scorecard:', err.message);
      }
    }

    // The scorecard FILE is written independently of Telegram, so a rehearsal with notifications off
    // still overwrote the live day's scorecard artifact - the same hole as the journal, one artifact
    // over. The message above is still printed to stdout, because a harness wants to read it.
    if (!mayWriteSession()) { refuseRehearsalWrite(path.join(journalDir, `scorecard_${sessionDate}.json`)); return; }
    try {
      const scorecardFile = path.join(journalDir, `scorecard_${sessionDate}.json`);
      const completed = dailyCalls.filter(c => c.status === 'WON' || c.status === 'LOST' || c.status === 'SESSION_CLOSE' || c.status === 'TIME_EXIT');
      // The FILE gets the same rule as the message: target hits are wins, stops are
      // losses, and closes without a level are their own count.
      const tally = tallyOutcomes(dailyCalls);
      const decided = tally.targetHits + tally.stopsHit;
      const scorecardData = {
        date: sessionDate,
        totalCalls: dailyCalls.length,
        executed: completed.length,
        won: tally.targetHits,
        lost: tally.stopsHit,
        otherExits: tally.otherExits,
        decided,
        // NULL, not 0.0 — with no target or stop decided there is no rate to report.
        winRatePct: decided > 0 ? +(100 * tally.targetHits / decided).toFixed(1) : null,
        grossPoints1Lot: +completed.reduce((sum, c) => sum + (c.grossPoints1Lot || 0), 0).toFixed(2),
        netPoints1Lot: +completed.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0).toFixed(2),
        netInr1Lot: +completed.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0).toFixed(2),
        timestamp: Date.now()
      };
      fs.writeFileSync(scorecardFile, JSON.stringify(scorecardData, null, 2), 'utf8');
    } catch (e) {}
  }

  // Automatic 15:30 IST Session Scorecard Checker
  let scorecardTimer = null;
  if (enableScorecardTimer) {
    scorecardTimer = setInterval(() => {
      const nowMin = istMinute(Date.now());
      if (nowMin >= 15 * 60 + 30 && !hasSentScorecard) {
        closeSession();
      }
    }, 30000);
    if (scorecardTimer && scorecardTimer.unref) scorecardTimer.unref();
  }

  // WHERE AND WHEN A CALL DIED. The cancel branches knew both the price and the tick time that fired
  // them and recorded neither, so a cancelled call was a dead end: you could not ask what entering it
  // at that moment would have done, which is the only honest way to price the anti-chase rule. The
  // price is the CHASE ENTRY - the limit was never touched, so filling at the limit is fantasy - and
  // it is recorded with the same IST clock the fills use.
  function recordCancelPoint(callRef, price, tickMs) {
    callRef.cancelPrice = +Number(price).toFixed(2);
    callRef.cancelTimestamp = tickMs || Date.now();
    callRef.cancelTimeIST = new Date((tickMs || Date.now()) + IST_MS).toISOString().slice(11, 19);
  }

  function logJournal(entry) {
    if (!mayWriteSession()) { refuseRehearsalWrite(journalFile); return; }
    try {
      if (!fs.existsSync(journalDir)) {
        fs.mkdirSync(journalDir, { recursive: true });
      }
      fs.appendFileSync(journalFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      console.error(`[sweep-fvg] Journal write error: ${err.message}`);
    }
  }

  function getMarketBreadth() {
    let active = 0;
    let above = 0;
    for (const st of symbols.values()) {
      if (st.bars.length > 0 && st.vwap.length > 0) {
        active++;
        if (st.bars[st.bars.length - 1].c > st.vwap[st.vwap.length - 1]) {
          above++;
        }
      }
    }
    return active > 0 ? (above / active) : 0.50;
  }

  function getSectorBreadth(sec) {
    let active = 0;
    let above = 0;
    for (const st of symbols.values()) {
      if (st.sec === sec && st.bars.length > 0 && st.vwap.length > 0) {
        active++;
        if (st.bars[st.bars.length - 1].c > st.vwap[st.vwap.length - 1]) {
          above++;
        }
      }
    }
    return active > 0 ? (above / active) : 0.50;
  }

  function getOrCreateState(sym) {
    let st = symbols.get(sym);
    if (!st) {
      st = {
        sym,
        sec: getSector(sym),
        bars: [],
        curBar: null,
        pivHighs: [], // [{ idx, px }]
        pivLows: [],
        or30High: null,
        or30Low: null,
        atr: [],
        vwap: [],
        cumPv: 0.0,
        cumV: 0.0,
        tradesToday: 0, // executed fills for this symbol, for maxTradesPerDay
        pendingSetup: null, // limit order awaiting fill
        activePosition: null // entered trade
      };
      symbols.set(sym, st);
    }
    return st;
  }

  // VWAP SLOPE, bps per bar over the last trendLookbackBars sealed bars. 0 when there is not enough
  // history - "unknown" must not silently pass a trend filter.
  function vwapSlope(st, i) {
    const back = trendLookbackBars;
    if (i < back || st.vwap.length <= i) return 0;
    const cur = st.vwap[i];
    const prev = st.vwap[i - back];
    if (!prev) return 0;
    return ((cur - prev) / prev) * 1e4;
  }

  function sealBar(st, bar) {
    const i = st.bars.length;
    st.bars.push(bar);

    // Running VWAP
    const tp = (bar.h + bar.l + bar.c) / 3.0;
    st.cumPv += tp * bar.vol;
    st.cumV += bar.vol;
    const curVwap = st.cumV > 0 ? (st.cumPv / st.cumV) : bar.c;
    st.vwap.push(curVwap);

    // Running ATR(14)
    if (i === 0) {
      st.atr.push(bar.h - bar.l);
    } else {
      const prevC = st.bars[i - 1].c;
      const tr = Math.max(bar.h - bar.l, Math.abs(bar.h - prevC), Math.abs(bar.l - prevC));
      const prevAtr = st.atr[i - 1];
      st.atr.push((prevAtr * 13.0 + tr) / 14.0);
    }

    // Opening Range 30m (first 6 5m bars: 09:15 to 09:45)
    if (i === 5 && st.bars.length >= 6) {
      st.or30High = Math.max(...st.bars.slice(0, 6).map(b => b.h));
      st.or30Low = Math.min(...st.bars.slice(0, 6).map(b => b.l));
    }

    // Swing Pivots (lookback swingN)
    const p = i - swingN;
    if (p >= swingN) {
      const pivotBar = st.bars[p];
      let isHigh = true;
      let isLow = true;
      for (let x = p - swingN; x <= p + swingN; x++) {
        if (x !== p) {
          if (st.bars[x].h >= pivotBar.h) isHigh = false;
          if (st.bars[x].l <= pivotBar.l) isLow = false;
        }
      }
      if (isHigh) st.pivHighs.push({ idx: p, px: pivotBar.h });
      if (isLow) st.pivLows.push({ idx: p, px: pivotBar.l });
    }

    // Expire pivots older than 30 bars
    st.pivHighs = st.pivHighs.filter(p => (i - p.idx) <= 30);
    st.pivLows = st.pivLows.filter(p => (i - p.idx) <= 30);

    // TIME STOP: close a position that has used its bars, at this bar's close.
    if (maxHoldBars > 0 && st.activePosition && (i - st.activePosition.entryBar) >= maxHoldBars) {
      const pos = st.activePosition;
      const exitPx = bar.c;
      const grossPt = pos.side === 'SHORT' ? (pos.entryPx - exitPx) : (exitPx - pos.entryPx);
      const grossBps = (grossPt / pos.entryPx) * 1e4;
      const tollBps = calcItemizedToll('time_exit');
      const netBps = grossBps - tollBps;
      const shares = pos.shares || fixedShares || 1;
      const netInr = grossPt * shares - pos.entryPx * shares * (tollBps / 1e4);
      const trade = {
        type: 'TRADE_EXIT', symbol: st.sym, sec: st.sec, side: pos.side,
        entryPx: pos.entryPx, exitPx: +exitPx.toFixed(2), exitReason: 'time_exit',
        sl: pos.sl, tgt: pos.tgt, shares,
        grossPt: +grossPt.toFixed(2), riskBps: pos.riskBps, grossBps: +grossBps.toFixed(2),
        tollBps: +tollBps.toFixed(2), netBps: +netBps.toFixed(2), netInr: +netInr.toFixed(2),
        entryTime: pos.entryTime, exitTime: bar.t_ms || Date.now()
      };
      closedTrades.push(trade);
      logJournal(trade);
      if (pos.callRef) {
        pos.callRef.status = 'TIME_EXIT';
        pos.callRef.exitPrice = +exitPx.toFixed(2);
        pos.callRef.exitReason = 'time_exit';
        pos.callRef.grossPoints1Lot = +grossPt.toFixed(2);
        pos.callRef.netBps = +netBps.toFixed(2);
        pos.callRef.netInr1Lot = +netInr.toFixed(2);
        saveDailyCalls();
      }
      st.activePosition = null;
    }

    // Setup Expiration
    if (st.pendingSetup && (i - st.pendingSetup.setupBar) > maxRetraceBars) {
      if (st.pendingSetup.callRef) {
        st.pendingSetup.callRef.status = 'EXPIRED';
        saveDailyCalls();
      }
      st.pendingSetup = null;
    }

    // 1. Check Pending Sweeps for FVG Displacement Formation
    if (st.pendingSweep) {
      const ps = st.pendingSweep;
      if ((i - ps.sweepBar) > 3) {
        st.pendingSweep = null;
      } else if (i >= 2) {
        const curAtr = st.atr[i];

        if (ps.side === 'SHORT') {
          const gap = st.bars[i - 2].l - bar.h;
          if (gap >= fvgAtrMult * curAtr) {
            const fvgMid = (st.bars[i - 2].l + bar.h) / 2.0;
            const sl = ps.sweepExtreme + Math.max(TICK_SIZE, ps.sweepExtreme * stopBufferBps / 1e4);
            const riskPerShare = sl - fvgMid;

            // Institutional Target Selection: Must offer at least minRr
            const pivsBelow = st.pivLows.map(p => p.px).filter(px => (fvgMid - px) >= minRr * riskPerShare);
            const tgt = targetRr > 0
              ? fvgMid - targetRr * riskPerShare
              : (fixedTargetBps > 0
                ? fvgMid * (1 - fixedTargetBps / 1e4)
                : (pivsBelow.length > 0 ? Math.max(...pivsBelow) : (fvgMid - minRr * riskPerShare)));
            const targetBps = ((fvgMid - tgt) / fvgMid) * 1e4;

            // Discount/Premium location filter: Never short in discount
            const equilibrium = (tgt + ps.sweepExtreme) / 2.0;
            if (enforceDiscountPremium && fvgMid < equilibrium) {
              st.pendingSweep = null;
              return;
            }

            if (targetBps >= minTargetBps) {
              const rr = +(Math.abs(tgt - fvgMid) / riskPerShare).toFixed(2);
              const isScalp = targetBps <= 45.0 && rr <= 2.2;
              const strategyType = isScalp ? 'SCALPING' : 'INTRADAY';
              const callId = `CALL-${st.sym}-${sessionDate}-${String(++callSeq).padStart(3, '0')}`;

              const callObj = {
                id: callId,
                // WHICH ENGINE MADE THIS CALL. This engine and the minute order-flow engine write
                // the same daily_calls book and use the same CALL-<SYM>-<date>-NNN id format, so a
                // reader that does not know the writer attributes these calls to the other engine's
                // strategy. The stamp makes the record self-describing.
                engine: 'SWEEP_FVG',
                date: sessionDate,
                timeIST: new Date((bar.t_ms || Date.now()) + IST_MS).toISOString().slice(11, 19),
                timestamp: bar.t_ms || Date.now(),
                symbol: st.sym,
                sector: st.sec,
                side: 'SHORT',
                action: 'SELL',
                strategyType,
                limitEntry: +fvgMid.toFixed(2),
                stopLoss: +sl.toFixed(2),
                target: +tgt.toFixed(2),
                riskPts: +riskPerShare.toFixed(2),
                rewardPts: +Math.abs(tgt - fvgMid).toFixed(2),
                riskBps: +(((sl - fvgMid) / fvgMid) * 1e4).toFixed(1),
                targetBps: +targetBps.toFixed(1),
                riskReward: `1 : ${rr}`,
                shares: fixedShares || 1,
                status: 'ARMED',
                marketBreadth: +(getMarketBreadth() * 100).toFixed(1) + '%',
                sectorBreadth: +(getSectorBreadth(st.sec) * 100).toFixed(1) + '%',
                // NUMERIC SIBLINGS (schema fix, additive — Gate Research §4B): one
                // machine-comparable pair across both engines' books; the %-strings
                // above stay exactly as they were for display.
                marketBreadthPct: +(getMarketBreadth() * 100).toFixed(1),
                sectorBreadthPct: +(getSectorBreadth(st.sec) * 100).toFixed(1),
                fillPrice: null,
                entryTimeIST: null,
                exitPrice: null,
                exitTimeIST: null,
                exitReason: null,
                grossPoints1Lot: null,
                netBps: null,
                netInr1Lot: null
              };

              const reg = registerCall(callObj);
              const callRef = reg.call;
              if (reg.added) saveDailyCalls();

              st.pendingSetup = {
                sym: st.sym,
                side: 'SHORT',
                setupBar: i,
                sweepExtreme: ps.sweepExtreme,
                limitEntry: fvgMid,
                sl,
                tgt,
                timestamp: Date.now(),
                callRef
              };

              const sig = {
                type: 'SETUP_ARMED',
                side: 'SHORT',
                symbol: st.sym,
                strategyType,
                barIndex: i,
                limitEntry: +fvgMid.toFixed(2),
                stopLoss: +sl.toFixed(2),
                target: +tgt.toFixed(2),
                riskBps: +(((sl - fvgMid) / fvgMid) * 1e4).toFixed(1),
                vwap: +st.vwap[i].toFixed(2),
                atr: +curAtr.toFixed(2),
                timestamp: bar.t_ms || Date.now()
              };
              signals.push(sig);
              logJournal(sig);
              console.log(`[SIGNAL] ARMED SHORT [${strategyType}] ${st.sym} @ Limit=${sig.limitEntry} SL=${sig.stopLoss} TGT=${sig.target} (Risk: ${sig.riskBps} bps)`);
              if (reg.added) notifyTelegram(formatSetupArmedAlert(callRef), 'sweep:new:' + callRef.id);
            }
            st.pendingSweep = null;
          }
        } else if (ps.side === 'LONG') {
          if (shortOnly) {
            st.pendingSweep = null;
            return;
          }
          const gap = bar.l - st.bars[i - 2].h;
          if (gap >= fvgAtrMult * curAtr) {
            const fvgMid = (st.bars[i - 2].h + bar.l) / 2.0;
            const sl = ps.sweepExtreme - Math.max(TICK_SIZE, ps.sweepExtreme * stopBufferBps / 1e4);
            const riskPerShare = fvgMid - sl;

            const pivsAbove = st.pivHighs.map(p => p.px).filter(px => (px - fvgMid) >= minRr * riskPerShare);
            const tgt = targetRr > 0
              ? fvgMid + targetRr * riskPerShare
              : (fixedTargetBps > 0
                ? fvgMid * (1 + fixedTargetBps / 1e4)
                : (pivsAbove.length > 0 ? Math.min(...pivsAbove) : (fvgMid + minRr * riskPerShare)));
            const targetBps = ((tgt - fvgMid) / fvgMid) * 1e4;

            // Discount/Premium location filter: Never buy in premium
            const equilibriumLong = (ps.sweepExtreme + tgt) / 2.0;
            if (enforceDiscountPremium && fvgMid > equilibriumLong) {
              st.pendingSweep = null;
              return;
            }

            if (targetBps >= minTargetBps) {
              const rr = +(Math.abs(tgt - fvgMid) / riskPerShare).toFixed(2);
              const isScalp = targetBps <= 45.0 && rr <= 2.2;
              const strategyType = isScalp ? 'SCALPING' : 'INTRADAY';
              const callId = `CALL-${st.sym}-${sessionDate}-${String(++callSeq).padStart(3, '0')}`;

              const callObj = {
                id: callId,
                // WHICH ENGINE MADE THIS CALL. This engine and the minute order-flow engine write
                // the same daily_calls book and use the same CALL-<SYM>-<date>-NNN id format, so a
                // reader that does not know the writer attributes these calls to the other engine's
                // strategy. The stamp makes the record self-describing.
                engine: 'SWEEP_FVG',
                date: sessionDate,
                timeIST: new Date((bar.t_ms || Date.now()) + IST_MS).toISOString().slice(11, 19),
                timestamp: bar.t_ms || Date.now(),
                symbol: st.sym,
                sector: st.sec,
                side: 'LONG',
                action: 'BUY',
                strategyType,
                limitEntry: +fvgMid.toFixed(2),
                stopLoss: +sl.toFixed(2),
                target: +tgt.toFixed(2),
                riskPts: +riskPerShare.toFixed(2),
                rewardPts: +Math.abs(tgt - fvgMid).toFixed(2),
                riskBps: +(((fvgMid - sl) / fvgMid) * 1e4).toFixed(1),
                targetBps: +targetBps.toFixed(1),
                riskReward: `1 : ${rr}`,
                shares: fixedShares || 1,
                status: 'ARMED',
                marketBreadth: +(getMarketBreadth() * 100).toFixed(1) + '%',
                sectorBreadth: +(getSectorBreadth(st.sec) * 100).toFixed(1) + '%',
                // NUMERIC SIBLINGS (schema fix, additive — Gate Research §4B): one
                // machine-comparable pair across both engines' books; the %-strings
                // above stay exactly as they were for display.
                marketBreadthPct: +(getMarketBreadth() * 100).toFixed(1),
                sectorBreadthPct: +(getSectorBreadth(st.sec) * 100).toFixed(1),
                fillPrice: null,
                entryTimeIST: null,
                exitPrice: null,
                exitTimeIST: null,
                exitReason: null,
                grossPoints1Lot: null,
                netBps: null,
                netInr1Lot: null
              };

              const reg = registerCall(callObj);
              const callRef = reg.call;
              if (reg.added) saveDailyCalls();

              st.pendingSetup = {
                sym: st.sym,
                side: 'LONG',
                setupBar: i,
                sweepExtreme: ps.sweepExtreme,
                limitEntry: fvgMid,
                sl,
                tgt,
                timestamp: Date.now(),
                callRef
              };

              const sig = {
                type: 'SETUP_ARMED',
                side: 'LONG',
                symbol: st.sym,
                strategyType,
                barIndex: i,
                limitEntry: +fvgMid.toFixed(2),
                stopLoss: +sl.toFixed(2),
                target: +tgt.toFixed(2),
                riskBps: +(((fvgMid - sl) / fvgMid) * 1e4).toFixed(1),
                vwap: +st.vwap[i].toFixed(2),
                atr: +curAtr.toFixed(2),
                timestamp: bar.t_ms || Date.now()
              };
              signals.push(sig);
              logJournal(sig);
              console.log(`[SIGNAL] ARMED LONG [${strategyType}] ${st.sym} @ Limit=${sig.limitEntry} SL=${sig.stopLoss} TGT=${sig.target} (Risk: ${sig.riskBps} bps)`);
              if (reg.added) notifyTelegram(formatSetupArmedAlert(callRef), 'sweep:new:' + callRef.id);
            }
            st.pendingSweep = null;
          }
        }
      }
    }

    // 2. Check for NEW sweeps if flat and no pending setups
    if (!st.activePosition && !st.pendingSetup && !st.pendingSweep) {
      const barMin = bar.t;
      const inBlockedMinute = BLOCKED_WINDOWS.some(([bf, bt]) => barMin >= bf && barMin < bt);
      if (barMin >= 585 && barMin <= maxSetupMinute && !inBlockedMinute) { // Institutional morning window: 09:45 to maxSetupMinute (13:00), minus the measured dead windows
        const curVwap = st.vwap[i];
        const refHighs = st.pivHighs.map(p => p.px);
        const refLows = st.pivLows.map(p => p.px);
        if (st.or30High != null) refHighs.push(st.or30High);
        if (st.or30Low != null) refLows.push(st.or30Low);

        const curMktBreadth = getMarketBreadth();
        const curSecBreadth = getSectorBreadth(st.sec);
        // Trade budget and trend gate are evaluated once per bar for both directions.
        const withinTradeBudget = !maxTradesPerDay || (st.tradesToday || 0) < maxTradesPerDay;
        const slopeBps = vwapSlope(st, i);

        // BEARISH SWEEP: BSL Sweep
        if (withinTradeBudget && bar.c <= curVwap && refHighs.length > 0) {
          const passTrend = !requireTrendAlign || (slopeBps <= -minVwapSlopeBps);
          const passSentiment = passTrend && (!useSentimentFilter || (curSecBreadth <= 0.65 && curMktBreadth <= 0.70));
          if (passSentiment) {
            const swept = refHighs.filter(px => bar.h > px);
            if (swept.length > 0) {
              const pivPx = Math.max(...swept);
              const upperWick = bar.h - Math.max(bar.o, bar.c);
              const wickRatio = upperWick / (bar.h - bar.l + 1e-6);
              const closedBelow = bar.c < pivPx;

              if (closedBelow && wickRatio >= wickRatioMin) {
                st.pendingSweep = {
                  side: 'SHORT',
                  sweepBar: i,
                  sweepExtreme: bar.h,
                  pivPx
                };
              }
            }
          }
        }

        // BULLISH SWEEP: SSL Sweep
        if (withinTradeBudget && !shortOnly && !st.pendingSweep && bar.c >= curVwap && refLows.length > 0) {
          const passTrend = !requireTrendAlign || (slopeBps >= minVwapSlopeBps);
          const passSentiment = passTrend && (!useSentimentFilter || (curSecBreadth >= 0.50 && curMktBreadth >= 0.50));
          if (passSentiment) {
            const swept = refLows.filter(px => bar.l < px);
            if (swept.length > 0) {
              const pivPx = Math.min(...swept);
              const lowerWick = Math.min(bar.o, bar.c) - bar.l;
              const wickRatio = lowerWick / (bar.h - bar.l + 1e-6);
              const closedAbove = bar.c > pivPx;

              if (closedAbove && wickRatio >= wickRatioMin) {
                st.pendingSweep = {
                  side: 'LONG',
                  sweepBar: i,
                  sweepExtreme: bar.l,
                  pivPx
                };
              }
            }
          }
        }
      }
    }
  }

  function onTick(tick) {
    const { t, s, p, q, v } = tick;
    if (!p || p <= 0) return;
    const sym = s;
    const st = getOrCreateState(sym);
    // The entry gates (tradeable cash · universe membership · share-price cap) are applied
    // at step 3 below, AFTER the two resolution blocks. They decide what may be SIGNALLED;
    // they must not decide what may be MANAGED. Sitting here they also gated position
    // monitoring and setup resolution — so a symbol that dropped out of the universe, or
    // one that filled above the cap, stopped being watched entirely: its stop and target
    // were never evaluated again and nothing but the 15:30 flatten could close it.

    // 1. Check Active Position Stops & Targets tick-by-tick
    if (st.activePosition) {
      const pos = st.activePosition;
      let exitPx = null;
      let exitReason = null;

      if (pos.side === 'SHORT') {
        if (p >= pos.sl) {
          exitPx = pos.sl;
          exitReason = 'stop';
        } else if (p <= pos.tgt) {
          exitPx = pos.tgt;
          exitReason = 'target';
        }
      } else if (pos.side === 'LONG') {
        if (p <= pos.sl) {
          exitPx = pos.sl;
          exitReason = 'stop';
        } else if (p >= pos.tgt) {
          exitPx = pos.tgt;
          exitReason = 'target';
        }
      }

      if (exitReason) {
        const riskPerShare = Math.abs(pos.sl - pos.entryPx);
        const shares = pos.shares || fixedShares || 1;
        const grossPt = pos.side === 'SHORT' ? (pos.entryPx - exitPx) : (exitPx - pos.entryPx);
        const grossBps = (grossPt / pos.entryPx) * 1e4;
        const tollBps = calcItemizedToll(exitReason);
        const netBps = grossBps - tollBps;
        const grossInr = grossPt * shares;
        const costsInr = (pos.entryPx * shares) * (tollBps / 1e4);
        const netInr = grossInr - costsInr;

        const trade = {
          type: 'TRADE_EXIT',
          symbol: sym,
          sec: st.sec,
          side: pos.side,
          entryPx: pos.entryPx,
          exitPx: +exitPx.toFixed(2),
          exitReason,
          sl: pos.sl,
          tgt: pos.tgt,
          shares,
          grossPt: +grossPt.toFixed(2),
          riskBps: pos.riskBps,
          grossBps: +grossBps.toFixed(2),
          tollBps: +tollBps.toFixed(2),
          netBps: +netBps.toFixed(2),
          netInr: +netInr.toFixed(2),
          entryTime: pos.entryTime,
          exitTime: t || Date.now()
        };
        closedTrades.push(trade);
        logJournal(trade);

        if (pos.callRef) {
          pos.callRef.status = exitReason === 'target' ? 'WON' : (exitReason === 'stop' ? 'LOST' : 'SESSION_CLOSE');
          pos.callRef.exitPrice = +exitPx.toFixed(2);
          pos.callRef.exitTimeIST = new Date((t || Date.now()) + IST_MS).toISOString().slice(11, 19);
          pos.callRef.exitReason = exitReason;
          pos.callRef.grossPoints1Lot = +grossPt.toFixed(2);
          pos.callRef.netBps = +netBps.toFixed(2);
          pos.callRef.netInr1Lot = +netInr.toFixed(2);
          saveDailyCalls();
          notifyTelegram(formatTradeExitAlert(pos.callRef, trade),
            'sweep:exit:' + pos.callRef.id + ':' + (trade.result || trade.reason || 'CLOSED'));
        }          console.log(`[TRADE CLOSED] ${trade.side} ${sym} (${st.sec}) | Reason=${trade.exitReason} | Net=${trade.netBps > 0 ? '+' : ''}${trade.netBps} bps | Net INR=${trade.netInr >= 0 ? '+' : '-'}Rs ${Math.abs(trade.netInr)}`);
        st.activePosition = null;
      }
    }

    // 2. Check Pending Setup for Limit Order Fill
    if (st.pendingSetup) {
      const setup = st.pendingSetup;
      let filled = false;
      let entryPx = 0.0;

      if (setup.side === 'SHORT') {
        const totalDist = setup.limitEntry - setup.tgt;
        const moveDone = setup.limitEntry - p;
        if (totalDist > 0 && moveDone >= maxPremovePct * totalDist) {
          if (setup.callRef) {
            setup.callRef.status = 'CANCELLED_EXHAUSTION';
            setup.callRef.cancelReason = 'Price moved >= 60% towards target before fill (Anti-Chase)';
            recordCancelPoint(setup.callRef, p, t);
            saveDailyCalls();
          }
          st.pendingSetup = null; // User rule: after moving we not buy just leave them
        } else if (p >= setup.sweepExtreme) {
          if (setup.callRef) {
            setup.callRef.status = 'INVALIDATED';
            setup.callRef.cancelReason = 'Price broke sweep extreme prior to fill';
            recordCancelPoint(setup.callRef, p, t);
            saveDailyCalls();
          }
          st.pendingSetup = null; // Invalidated
        } else if (p >= setup.limitEntry + TICK_SIZE) { // strictly traded-through
          filled = true;
          entryPx = setup.limitEntry;
        }
      } else if (setup.side === 'LONG') {
        const totalDist = setup.tgt - setup.limitEntry;
        const moveDone = p - setup.limitEntry;
        if (totalDist > 0 && moveDone >= maxPremovePct * totalDist) {
          if (setup.callRef) {
            setup.callRef.status = 'CANCELLED_EXHAUSTION';
            setup.callRef.cancelReason = 'Price moved >= 60% towards target before fill (Anti-Chase)';
            recordCancelPoint(setup.callRef, p, t);
            saveDailyCalls();
          }
          st.pendingSetup = null; // User rule: after moving we not buy just leave them
        } else if (p <= setup.sweepExtreme) {
          if (setup.callRef) {
            setup.callRef.status = 'INVALIDATED';
            setup.callRef.cancelReason = 'Price broke sweep extreme prior to fill';
            recordCancelPoint(setup.callRef, p, t);
            saveDailyCalls();
          }
          st.pendingSetup = null; // Invalidated
        } else if (p <= setup.limitEntry - TICK_SIZE) { // strictly traded-through
          filled = true;
          entryPx = setup.limitEntry;
        }
      }

      if (filled) {
        const risk = Math.abs(setup.sl - entryPx);
        const riskBps = (risk / entryPx) * 1e4;
        const budgetLeft = !maxTradesPerDay || (st.tradesToday || 0) < maxTradesPerDay;
        if (!budgetLeft) {
          // The limit was touched after the symbol had already used its budget. Refuse the fill AND
          // resolve the record, otherwise the call sits on ARMED for the rest of the day.
          if (setup.callRef) {
            setup.callRef.status = 'CANCELLED_TRADE_LIMIT';
            setup.callRef.cancelReason = `Daily trade budget (${maxTradesPerDay}) already used for this symbol`;
            saveDailyCalls();
          }
        } else if (riskBps >= 5.0 && (risk / entryPx) <= 0.03) {
          const shares = fixedShares || (useOneLot ? 1 : Math.max(1, Math.floor(riskPerTrade / risk)));
          st.tradesToday = (st.tradesToday || 0) + 1;
          st.activePosition = {
            sym,
            sec: st.sec,
            side: setup.side,
            entryPx,
            sl: setup.sl,
            tgt: setup.tgt,
            shares,
            riskBps: +riskBps.toFixed(1),
            entryBar: st.bars.length,
            entryTime: t || Date.now(),
            callRef: setup.callRef
          };
          if (setup.callRef) {
            setup.callRef.status = 'FILLED';
            setup.callRef.fillPrice = +entryPx.toFixed(2);
            setup.callRef.entryTimeIST = new Date((t || Date.now()) + IST_MS).toISOString().slice(11, 19);
            saveDailyCalls();
            notifyTelegram(formatOrderFilledAlert(setup.callRef), 'sweep:fill:' + setup.callRef.id);
          }
          const entryEvent = {
            type: 'TRADE_ENTRY',
            symbol: sym,
            sec: st.sec,
            side: setup.side,
            entryPx: +entryPx.toFixed(2),
            sl: setup.sl,
            tgt: setup.tgt,
            shares,
            riskBps: +riskBps.toFixed(1),
            timestamp: t || Date.now()
          };
          logJournal(entryEvent);
          console.log(`[TRADE ENTERED] ${setup.side} ${sym} @ ${entryEvent.entryPx} | SL=${setup.sl} | TGT=${setup.tgt} | Qty=${shares}`);
        } else {
          // Filled, then refused by the risk band. It used to be dropped in silence, leaving a call
          // stuck on ARMED that no scorecard would ever resolve.
          if (setup.callRef) {
            setup.callRef.status = 'REJECTED_RISK';
            setup.callRef.cancelReason = `Risk ${riskBps.toFixed(1)} bps outside the 5-300 bps band`;
            saveDailyCalls();
          }
        }
        st.pendingSetup = null;
      }
    }

    // A REST MARK IS A PRICE, NOT A PRINT. The server polls quotes for open calls when a
    // symbol's socket ticks have gone quiet, and feeds them through THIS function so the
    // exit rules are evaluated by exactly one implementation. It must stop here: a polled
    // snapshot has no trade size and no clock inside the bar, so letting it reach bar
    // aggregation would fabricate 5m bars out of quote samples.
    if (tick.rest === true) return;

    // 3. ENTRY GATES — anything below this line feeds the 5m scan, so only symbols the
    // strategy is allowed to trade are aggregated into bars.
    if (!isTradeableCash(sym)) return;
    if (universe && !universe.has(sym)) return;
    if (maxSharePrice && p > maxSharePrice) return;

    // 4. 5-Minute Bar Aggregation
    const bStart = barStart(t);
    if (bStart == null) return;

    if (!st.curBar) {
      st.curBar = { t: bStart, t_ms: t, o: p, h: p, l: p, c: p, vol: q || 0 };
      if (v != null) st.lastV = v;
    } else if (st.curBar.t === bStart) {
      if (p > st.curBar.h) st.curBar.h = p;
      if (p < st.curBar.l) st.curBar.l = p;
      st.curBar.c = p;
      const dv = (v != null && st.lastV != null && v >= st.lastV) ? (v - st.lastV) : (q || 0);
      if (v != null) st.lastV = v;
      st.curBar.vol += dv;
    } else {
      // Seal completed bar
      sealBar(st, st.curBar);
      st.curBar = { t: bStart, t_ms: t, o: p, h: p, l: p, c: p, vol: q || 0 };
      if (v != null) st.lastV = v;
    }
  }

  function closeSession() {
    for (const [sym, st] of symbols.entries()) {
      if (st.curBar) {
        sealBar(st, st.curBar);
        st.curBar = null;
      }
      if (st.activePosition) {
        const pos = st.activePosition;
        const lastC = st.bars.length > 0 ? st.bars[st.bars.length - 1].c : pos.entryPx;
        const exitPx = lastC;
        const exitReason = 'session_close';
        const grossPt = pos.side === 'SHORT' ? (pos.entryPx - exitPx) : (exitPx - pos.entryPx);
        const grossBps = (grossPt / pos.entryPx) * 1e4;
        const tollBps = calcItemizedToll(exitReason);
        const netBps = grossBps - tollBps;
        const shares = pos.shares || fixedShares || 1;
        const grossInr = grossPt * shares;
        const costsInr = (pos.entryPx * shares) * (tollBps / 1e4);
        const netInr = grossInr - costsInr;

        const trade = {
          type: 'TRADE_EXIT',
          symbol: sym,
          sec: st.sec,
          side: pos.side,
          entryPx: pos.entryPx,
          exitPx: +exitPx.toFixed(2),
          exitReason,
          sl: pos.sl,
          tgt: pos.tgt,
          shares,
          grossPt: +grossPt.toFixed(2),
          riskBps: pos.riskBps,
          grossBps: +grossBps.toFixed(2),
          tollBps: +tollBps.toFixed(2),
          netBps: +netBps.toFixed(2),
          netInr: +netInr.toFixed(2),
          entryTime: pos.entryTime,
          exitTime: Date.now()
        };
        closedTrades.push(trade);
        logJournal(trade);

        if (pos.callRef) {
          pos.callRef.status = 'SESSION_CLOSE';
          pos.callRef.exitPrice = +exitPx.toFixed(2);
          pos.callRef.exitTimeIST = '15:30:00';
          pos.callRef.exitReason = exitReason;
          pos.callRef.grossPoints1Lot = +grossPt.toFixed(2);
          pos.callRef.netBps = +netBps.toFixed(2);
          pos.callRef.netInr1Lot = +netInr.toFixed(2);
        }
        st.activePosition = null;
      }
    }

    saveDailyCalls();
    sendDailyScorecard();
  }

  function getPerformance() {
    const n = closedTrades.length;
    if (n === 0) return { n: 0, winRatePct: null, winRateNet: null, targets: 0, stops: 0, otherExits: 0, meanGross: 0, meanNet: 0, pfNet: 0 };
    // THE ONE WIN RULE: a win is a trade whose TARGET was hit. A close that touched
    // neither level (session flatten, breakeven, time exit) is neither a win nor a loss,
    // and a +0.01 bps net is never a win. The rate is over DECIDED trades and is null
    // when nothing decided.
    const targets = closedTrades.filter(t => t.exitReason === 'target').length;
    const stops = closedTrades.filter(t => t.exitReason === 'stop').length;
    const otherExits = n - targets - stops;
    const decided = targets + stops;
    const meanGross = closedTrades.reduce((a, b) => a + b.grossBps, 0) / n;
    const meanNet = closedTrades.reduce((a, b) => a + b.netBps, 0) / n;
    const winSum = closedTrades.filter(t => t.exitReason === 'target').reduce((a, b) => a + b.netBps, 0);
    const lossSum = Math.abs(closedTrades.filter(t => t.exitReason === 'stop').reduce((a, b) => a + b.netBps, 0));
    const pfNet = lossSum > 0 ? (winSum / lossSum) : 999.0;

    return {
      n,
      winRatePct: decided > 0 ? +(100 * targets / decided).toFixed(1) : null,
      // Kept under its old name for callers that still read it: it is now the same
      // decided-trade figure, not a net-sign count.
      winRateNet: decided > 0 ? +(100 * targets / decided).toFixed(1) : null,
      meanGross: +meanGross.toFixed(1),
      meanNet: +meanNet.toFixed(1),
      pfNet: +pfNet.toFixed(2),
      targets,
      stops,
      otherExits,
      sessionCloses: closedTrades.filter(t => t.exitReason === 'session_close').length
    };
  }

  return {
    onTick,
    sealBar,
    closeSession,
    getPerformance,
    signals: () => signals,
    closedTrades: () => closedTrades,
    symbols: () => symbols,
    getCalls: () => dailyCalls,
    sendDailyScorecard,
    formatDailyScorecard,
    // The size of the universe this engine is actually filtering on. Reported so a replay states
    // which symbols it tested instead of leaving the reader to infer it from a config file.
    universeSize: () => (universe ? universe.size : null)
  };
}

// ==========================================
// CLI REPLAY / STANDALONE RUNNER
// ==========================================
async function runReplay(sessionDate, profileName) {
  const tapePath = path.join(__dirname, '..', '..', 'data', 'orderflow', `ticks-${sessionDate}.jsonl`);
  if (!fs.existsSync(tapePath)) {
    console.error(`Missing tape file: ${tapePath}`);
    process.exit(1);
  }

  const engine = createSweepFvgLive({ sessionDate, profile: profileName });
  console.log(`\nStarting Replay of ${sessionDate} with SweepFvgLive Engine ` +
    `(profile=${profileName}, universe=${engine.universeSize() ?? 'all'})...`);

  const fileStream = fs.createReadStream(tapePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineCount = 0;
  for await (const line of rl) {
    if (line.length < 20) continue;
    try {
      const tick = JSON.parse(line);
      engine.onTick(tick);
      lineCount++;
      if (lineCount % 200000 === 0) {
        process.stdout.write(`  Processed ${(lineCount / 1000).toFixed(0)}k ticks...\r`);
      }
    } catch (e) {}
  }

  engine.closeSession();
  const perf = engine.getPerformance();
  console.log(`\nReplay Complete for ${sessionDate}:`);
  const wrTxt = perf.winRatePct === null ? 'not measured (no target/stop decided)' : perf.winRatePct + '%';
  console.log(`Total Trades: ${perf.n} | Win Rate (target hits / decided): ${wrTxt} | Mean Gross: ${perf.meanGross} bps | Mean Net: ${perf.meanNet} bps | Net PF: ${perf.pfNet}`);
  console.log(`Targets: ${perf.targets} | Stops: ${perf.stops} | Closed without a level: ${perf.otherExits} | Session Closes: ${perf.sessionCloses}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const replayIdx = args.indexOf('--replay');
  const profileIdx = args.indexOf('--profile');
  const profileName = profileIdx !== -1 && args[profileIdx + 1] ? args[profileIdx + 1] : DEFAULT_PROFILE;
  if (replayIdx !== -1 && args[replayIdx + 1]) {
    runReplay(args[replayIdx + 1], profileName);
  } else {
    console.log('Usage: node orderflow/sweepFvgLive.js --replay <YYYY-MM-DD> [--profile ' +
      Object.keys(PROFILES).join('|') + ']');
  }
}

module.exports = {
  createSweepFvgLive, mergedOptions, PROFILES, DEFAULT_PROFILE,
  barStart, istMinute, istDay, calcItemizedToll, SLIPPAGE_BPS, STATUTORY_BPS
};
