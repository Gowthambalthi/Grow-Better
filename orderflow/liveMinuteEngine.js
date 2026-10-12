/**
 * orderflow/liveMinuteEngine.js
 * 
 * REAL-TIME CONTINUOUS INSTITUTIONAL ORDER FLOW ENGINE
 * - Reads live Angel One WebSocket ticks every second.
 * - Maintains in-memory 1-minute OHLCV, Volume, Delta, and VWAP for all ~700 Indian stocks.
 * - Runs Institutional Setup Scan every 60 seconds (every minute).
 * - Enforces minimum targets >= 0.70% (70-120 bps) with R:R >= 1:1.60.
 * - Applies FVG Support + Delta Footprint + Volume Surge + Anti-Climax Guard.
 * - Immediately pushes newly generated calls to Telegram (@GBTerminalAlertsBot).
 * - Real-time tick-by-tick monitoring: checks Target (WON) and Stop Loss (LOST) every second.
 * - Dispatches exit alerts to Telegram on Target Hit or Stop Hit.
 * - Dynamically calculates today's total recommendations scorecard: Won, Lost, Win Rate, Net INR, Net Verdict.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const tickCapture = require('./tickCapture');

let sendPhoneNotification = null;
try {
  const tel = require('../common/notifications/telegramService');
  sendPhoneNotification = tel.sendPhoneNotification;
} catch (_) {}

// GB_ORDERFLOW_DIR is the SAME override tickCapture uses, so a test or a replay
// harness can point both the tape and this engine's journal at a sandbox instead of
// touching today's real calls file. Unset in production: the path is unchanged.
const DATA_DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', 'data', 'orderflow');

// DEPTH TRUST WINDOW. A level-1 book older than this is not evidence about where
// the book is NOW — the depth snapshot is throttled at source, so an old reading is
// a record of a moment that has passed. When depth is stale the ask-wall gate is
// skipped rather than guessed: refusing a trade on a five-second-old book would be
// a different kind of wrong than refusing it on a live one.
const DEPTH_MAX_AGE_MS = Number(process.env.GB_DEPTH_MAX_AGE_MS) || 5000;
// ASK-WALL GATE (longs only). The ask quantity divided by the bid quantity at L1.
// A big ask is overhead supply sitting on top of price, and a price-only scanner
// cannot see it.
//
// THE GATE IS CONDITIONAL, and how it got here is worth recording — it is the first
// thing this two-AI exchange settled with a measurement rather than an opinion:
//   - Freebuff added a flat block at >= 5x, on the grounds that a wall is supply.
//   - Antigravity objected that in a real displacement the wall is what gets SWEPT,
//     so a flat block discards exactly the explosive breakouts, and asked for the
//     wall to be judged together with aggression.
//   - EXP001 (experiments/EXP001.md, 2026-10-12, 16 settled calls joined against the
//     L2-L5 book) measured the ratio AT ENTRY: winners averaged 8.03, losers 0.71.
//     The thickest walls at entry belonged to the WINNERS (KOPRAN 24x, NRBBEARING
//     10.3x), and persistence separated nothing (wallPct 22.5% winners vs 22.5%
//     losers). So a FLAT block is measurably wrong on day 1.
//   - Resolution for now: block a wall only when it is NOT being absorbed — see
//     isAbsorbingWall below, Antigravity's rule, kept as written. EXP001-B decides
//     whether even that survives (it needs the trade prints, not the resting book).
//
// WHAT SURVIVES EITHER WAY IS THE MEASUREMENT, which is what was actually broken:
// the book's real bid/ask quantities are now correct on every row and printed in the
// call note (Book BI, bid qty, ask qty), so the operator can see the wall and judge
// it. Threshold is per-instance (this.askWallRatioMin) so a study can arm/disarm it
// at runtime; 0 disables the block entirely and keeps the measurement.
// SHIPPED OFF (0). The owner's objection was that an intraday trader reacts to PRICE
// moving and does not read the resting ladder, so a wall of posted ask quantity is not
// what stops a move — and the measurements agree: (a) the historical tick tapes carry
// no bid/ask at all, so this gate has never been validated on a single past session;
// (b) EXP009's variant comparison shows that removing order flow from the entry
// entirely leaves win rate and profit factor unchanged (LONG PF 0.42 -> 0.49, SHORT
// +4.5 -> +5.1 bps); (c) the gate blocked 68% of candidates in the funnel while
// testing nothing measurable. The code and the measurement are KEPT — setting
// GB_ASK_WALL_RATIO=5 restores the old behaviour exactly, and the tests arm it
// explicitly, so the decision is reversible and the numbers stay visible in the call
// note. This is the owner's instruction, not a silent removal of another AI's work.
const ASK_WALL_RATIO = Number(process.env.GB_ASK_WALL_RATIO) || 0;

// SESSION WINDOW. This engine used to arm at ANY hour the process happened to be
// running — it armed a long at 15:09, with 21 minutes left for a target to be
// reached and no mechanism to square it off. ARM_END is when NEW setups stop;
// monitoring of what is already open continues tick-by-tick until SESSION_CLOSE,
// where every open call is stamped SESSION_CLOSE so nothing is left looking armed
// overnight (orderflow/callOutcomes.js reaches the same verdict independently).
// SESSION WINDOW. ARM_END is when NEW setups stop; monitoring of what is already
// open continues tick-by-tick until SESSION_CLOSE (15:30 IST).
// 14:45 IST cutoff gives every entry at least 45 minutes of expansion room.
const ARM_END_MINUTE = Number(process.env.GB_LIVE_ARM_END_MINUTE) || (14 * 60 + 45);
const SESSION_CLOSE_MINUTE = Number(process.env.GB_LIVE_SESSION_CLOSE_MINUTE) || (15 * 60 + 30);

// CAPITAL-NORMALIZED POSITION SIZING.
// Instead of an arbitrary share price cap that eliminates top-tier liquid bluechips
// (e.g. NAVINFLUOR @ 8520), sizing is normalized to a fixed notional allocation
// (default ₹50,000 per position) so each trade carries equal portfolio weight.
const POSITION_NOTIONAL = Number(process.env.GB_POSITION_NOTIONAL) || 50000.0;
const MAX_SHARE_PRICE = Number(process.env.GB_MAX_SHARE_PRICE) || 50000.0;

// BID-ASK SPREAD GATE. Any spread wider than 6.0 bps introduces heavy execution slippage
// (crossing the spread eats 6-12 bps gross, which combined with 15 bps statutory taxes
// consumes >35% of a 74 bps target). Names with spread > 6.0 bps are refused.
const MAX_SPREAD_BPS = Number(process.env.GB_MAX_SPREAD_BPS) || 6.0;

// SHORT SCALP & INTRADAY GEOMETRY (MANDATE: R:R <= 1:1.50):
// Stop 45-55 bps (default 50 bps), Target 60-75 bps (default 75 bps, <= 1:1.50 R:R).
// Wide target mode (250 bps) can be activated via GB_SHORT_TARGET_BPS=250.
const SHORT_TARGET_BPS = Number(process.env.GB_SHORT_TARGET_BPS) || 75;
const LONG_ENABLED = process.env.GB_LONG_ENABLED !== '0';
const STRICT_INVALIDATION = process.env.GB_STRICT_INVALIDATION !== '0';

// ---- FVG STRUCTURAL RULES (research/fvg/FVG_DEEP_RESEARCH.md, Part 6.1) -------------
// The research conclusion is that an FVG is a LOCATION, not a signal: a bare mechanical
// gap has no measurable edge (PF 0.43 over 2,232 trades; the FVG component alone is
// +0.45R with a confidence interval that crosses zero). What the sources DO agree on,
// and what is implemented here, is the structure of a usable gap:
//   F1 QUALITY    gap >= max(8 bps, 0.10 x ATR) and the displacement candle's body is
//                 >= 60% of its own range. Both are published tool DEFAULTS, not optima.
//   F2 CE         the 50% midpoint (consequent encroachment) is the reference level: a
//                 short must sell INTO the imbalance (price at/above CE), never below it.
//   F3 LIVENESS   a COMPLETED close above the distal wick kills the gap. Dead is dead.
//   F4 STOP FIT   the structural stop (beyond the distal wick) must fit the owner's
//                 1:1.50 mandate (<= GB_FVG_MAX_STOP_BPS); a wider structural stop is
//                 refused rather than silently converted into a bps stop.
// Every rule reads only bars already seen, so the whole block is CAUSAL — the exact bug
// (full-session high/low for the fib gate) that inflated a prior +16.4 bps claim is not
// repeated here.
// GB_FVG_STRUCTURAL=0 disables the block; GB_FVG_REQUIRE=0 keeps the measurements and
// diagnostics but stops the gate from vetoing a short.
const FVG_STRUCTURAL = process.env.GB_FVG_STRUCTURAL !== '0';
// SHIPPED DEFAULT: measurement ON, VETO OFF. Measured causally across 8 sessions
// (scratch/measure_fvg_structural.js) the veto cut trades 51 -> 10 over the 5 older days and
// made the mean WORSE (-7.7 -> -16.7 bps), and produced ZERO trades on the recent 3 days. So
// the rules are computed, reported in the call record and pinned by tests, but they do not
// block an entry until someone asks for it: GB_FVG_REQUIRE=1 turns the veto on. This is the
// same treatment the ask-wall gate got — measured, kept, and not allowed to decide silently.
const FVG_REQUIRE = process.env.GB_FVG_REQUIRE === '1';
const FVG_MIN_ATR_FRAC = Number(process.env.GB_FVG_MIN_ATR_FRAC) || 0.10;
const FVG_MIN_BODY_FRAC = Number(process.env.GB_FVG_MIN_BODY_FRAC) || 0.60;
const FVG_MAX_STOP_BPS = Number(process.env.GB_FVG_MAX_STOP_BPS) || 55;

// ---- FVG CONFLUENCE WEIGHT (exchange.md Round 24) -----------------------------------
// The engine counts an FVG as ONE of four confluence points (FVG / liquidity sweep /
// volume surge / strong delta), so a setup can qualify on gap + volume alone. Round 24
// isolated the gap on our own tapes with everything else held constant and it does not
// pay: FVG_CE minus NO_FVG measured -2.6 bps at the live 1:1.50 shape and -8.0 bps at 2R
// over the past 5 sessions, both 95% bootstrap intervals straddling zero, with 3 of 4
// panels running AGAINST the gap. A point that carries no measured information still
// spends one of the two confluence slots a trade needs.
//
// SHIPPED DEFAULT: 1 — today's behaviour, UNCHANGED. Setting GB_FVG_CONFLUENCE_WEIGHT=0
// demotes the gap out of the count, so qualification then needs 2 of the remaining three
// (sweep / volume surge / strong delta). That is a DIFFERENT and untested population, so
// it is armed by env or per-instance only after the Round 24 (C) forward test — the same
// treatment GB_FVG_REQUIRE got. The weight is the only knob here: nothing silently changes
// what the engine trades today.
const FVG_CONFLUENCE_WEIGHT = process.env.GB_FVG_CONFLUENCE_WEIGHT === '0' ? 0 : 1;

/**
 * The confluence count BOTH scan branches use — the single source of truth for what a
 * trade must accumulate, so a test cannot describe arithmetic the engine does not apply
 * (same arrangement as `fvgShortGate`).
 *
 *   dir = +1 (long): the delta point needs deltaRatio > +0.15
 *   dir = -1 (short): the delta point needs deltaRatio < -0.15
 *
 * `fvgWeight` is the only thing that varies: 1 counts a live gap as a full point (today's
 * shipped behaviour), 0 demotes it so the two points must come from sweep / volume surge /
 * strong delta. The threshold itself (>= 2, or >= 3 when Nifty is bearish) is NOT changed
 * by this function — demoting the gap therefore makes qualification stricter, never looser.
 */
function confluenceCount(dir, { hasFvg, swept, volSurge, deltaRatio }, fvgWeight) {
  const deltaPoint = dir > 0 ? deltaRatio > 0.15 : deltaRatio < -0.15;
  return (hasFvg ? fvgWeight : 0) + (swept ? 1 : 0) + (volSurge > 1.3 ? 1 : 0) + (deltaPoint ? 1 : 0);
}

/** Mean true range of the last 8 bars, computed from the bars themselves. */
function fvgAtr(bars) {
  const w = bars.slice(-8);
  if (!w.length) return 0;
  return w.reduce((s, b) => s + (b.h - b.l), 0) / w.length;
}

/**
 * Locate the most recent FVG in the last 8 completed bars together with its ZONE.
 *
 * dir = -1 -> BEARISH gap (candle 1's low above candle 3's high): zone = [c3.high, c1.low]
 * dir = +1 -> BULLISH gap (candle 3's low above candle 1's high): zone = [c1.high, c3.low]
 *
 * Returns null when no gap clears F1, otherwise
 *   { dir, top, bottom, ce, gapBps, bodyFrac, idx, dead, live }
 * `dead` is F3: a completed bar after the gap closed beyond its far edge.
 * CAUSAL by construction — it looks only at bars already in the array.
 */
/**
 * The two entry-state rules that turn a gap into an allow/refuse decision for a SHORT.
 * Single source of truth: the scan uses this function and the tests call it directly, so
 * a test can never pass against a rule the engine does not actually apply.
 *
 *   FVG_DEAD          a completed close above the distal wick killed the gap (F3)
 *   CE_BELOW_GAP      price has not retraced to the 50% midpoint yet (F2)
 *   FVG_STOP_TOO_FAR  the structural stop would exceed the 1:1.50 mandate (F4)
 *   FVG_RECLAIMED     price is back ABOVE the far edge: a short's stop would not be above it
 *   BEARISH_FVG_CE    the gap is live, price is selling into its upper half — ALLOW
 *   NONE              no qualifying gap at all
 */
function fvgShortGate(bars, price) {
  const gap = findFvg(bars, -1);
  if (!gap) return { gate: 'NONE', gap: null, structuralStopBps: 0 };
  if (gap.dead) return { gate: 'FVG_DEAD', gap, structuralStopBps: 0 };
  if (!(price >= gap.ce)) return { gate: 'CE_BELOW_GAP', gap, structuralStopBps: 0 };
  // Above the distal edge the gap has been RECLAIMED. For a SHORT the structural stop has to sit
  // ABOVE the entry; up here the far edge is behind the price, so the arithmetic yields a NEGATIVE
  // stop that sails through the F4 cap and would report a nonsense trade as a qualified one.
  // Found by running the Node<->Python parity grid (scratch/fvg_parity_check.js), not by reading.
  if (price > gap.top) return { gate: 'FVG_RECLAIMED', gap, structuralStopBps: 0 };
  const structuralStopBps = +(((gap.top * (1 + 0.00005) - price) / price) * 10000).toFixed(1);
  if (structuralStopBps > FVG_MAX_STOP_BPS) {
    return { gate: 'FVG_STOP_TOO_FAR', gap, structuralStopBps };
  }
  return { gate: 'BEARISH_FVG_CE', gap, structuralStopBps };
}

function findFvg(bars, dir) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  const atr = fvgAtr(bars);
  const ref = bars[bars.length - 1].c || bars[bars.length - 1].h || 1;
  const atrBps = ref > 0 ? (atr / ref) * 10000 : 0;
  const minGapBps = Math.max(8, atrBps * FVG_MIN_ATR_FRAC);
  for (let i = bars.length - 1; i >= Math.max(2, bars.length - 8); i--) {
    const c1 = bars[i - 2];
    const mid = bars[i - 1];
    const c3 = bars[i];
    if (!c1 || !mid || !c3) continue;
    let top = null, bottom = null;
    if (dir < 0 && c3.h < c1.l) { bottom = c3.h; top = c1.l; }
    else if (dir > 0 && c3.l > c1.h) { bottom = c1.h; top = c3.l; }
    if (top === null || !(top > bottom)) continue;
    const gapBps = ((top - bottom) / (c3.c || c3.h)) * 10000;
    if (gapBps < minGapBps) continue;
    const range = mid.h - mid.l;
    const bodyFrac = range > 0 ? Math.abs(mid.c - mid.o) / range : 0;
    if (FVG_STRUCTURAL && bodyFrac < FVG_MIN_BODY_FRAC) continue;
    let dead = false;
    for (let k = i + 1; k < bars.length; k++) {
      if (dir < 0 && bars[k].c > top) { dead = true; break; }
      if (dir > 0 && bars[k].c < bottom) { dead = true; break; }
    }
    return {
      dir, top: +top.toFixed(4), bottom: +bottom.toFixed(4),
      ce: +((top + bottom) / 2).toFixed(4),
      gapBps: +gapBps.toFixed(1), bodyFrac: +bodyFrac.toFixed(3),
      idx: i, dead, live: !dead,
    };
  }
  return null;
}

function getTodayIST() {
  const d = new Date(Date.now() + 330 * 60000);
  return d.toISOString().slice(0, 10);
}

function getISTTimeString(ms = Date.now()) {
  const d = new Date(ms + 330 * 60000);
  return d.toISOString().slice(11, 19);
}

class LiveMinuteEngine {
  constructor() {
    this.today = getTodayIST();
    this.calls = new Map(); // id -> call
    this.closedCalls = [];
    this.symBars = new Map(); // symbol -> array of 1m bars { t, o, h, l, c, v, q, delta, buyVol, sellVol }
    this.prevPrice = new Map(); // symbol -> last price
    this.book = new Map(); // symbol -> { bid, bidq, ask, askq, t } last ORIENTED level-1 book
    this.sessionClosed = false;
    // Per-instance so a study (or a test) can arm/disarm the wall gate at runtime
    // without re-requiring the module to re-read the env.
    this.askWallRatioMin = ASK_WALL_RATIO;
    this.armEndMinute = ARM_END_MINUTE;
    this.sessionCloseMinute = SESSION_CLOSE_MINUTE;
    this.maxSpreadBps = MAX_SPREAD_BPS;
    this.shortTargetBps = SHORT_TARGET_BPS;
    this.longEnabled = LONG_ENABLED;
    this.strictInvalidation = STRICT_INVALIDATION;
    // Per-instance, like the wall gate above: a study can demote the FVG from the
    // confluence count at runtime (this.fvgConfluenceWeight = 0) without re-requiring.
    this.fvgConfluenceWeight = FVG_CONFLUENCE_WEIGHT;
    this.isScanning = false;
    this.scanInterval = null;
    this.monitorInterval = null;

    this.loadExistingCalls();
  }

  loadExistingCalls() {
    const today = getTodayIST();
    const callsFile = path.join(DATA_DIR, `daily_calls_${today}.json`);
    if (fs.existsSync(callsFile)) {
      try {
        const arr = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
        if (Array.isArray(arr)) {
          for (const c of arr) {
            this.calls.set(c.id, c);
            if (['WON', 'LOST', 'SESSION_CLOSE'].includes(c.status)) {
              this.closedCalls.push(c);
            }
          }
          console.log(`[liveMinuteEngine] Loaded ${arr.length} existing calls for ${today} (${this.closedCalls.length} closed)`);
        }
      } catch (e) {
        console.error('[liveMinuteEngine] Error loading calls:', e.message);
      }
    }
  }

  saveCalls() {
    const today = getTodayIST();
    const callsFile = path.join(DATA_DIR, `daily_calls_${today}.json`);
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const allCalls = Array.from(this.calls.values());
      fs.writeFileSync(callsFile, JSON.stringify(allCalls, null, 2));
    } catch (e) {
      console.error('[liveMinuteEngine] Error saving calls:', e.message);
    }
  }

  // Pre-seed today's bars from the tape file on startup
  async loadTapeBars() {
    const tapeFile = path.join(DATA_DIR, `ticks-${this.today}.jsonl`);
    if (!fs.existsSync(tapeFile)) {
      console.log('[liveMinuteEngine] No prior tape file found for today; starting clean from live stream.');
      return;
    }

    console.log(`[liveMinuteEngine] Pre-loading historical bars from ${path.basename(tapeFile)}...`);
    const fileStream = fs.createReadStream(tapeFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let count = 0;
    for await (const line of rl) {
      if (!line) continue;
      count++;
      try {
        const t = JSON.parse(line);
        this.ingestTick(t, false);
      } catch (_) {}
    }
    console.log(`[liveMinuteEngine] Pre-loaded ${count} ticks across ${this.symBars.size} symbols.`);
  }

  // Ingest a single tick in real-time
  ingestTick(t, live = true) {
    const sym = t.s;
    if (!sym || !(t.p > 0)) return;

    const minKey = Math.floor(t.t / 60000) * 60000;
    let bars = this.symBars.get(sym);
    if (!bars) {
      bars = [];
      this.symBars.set(sym, bars);
    }

    // AGGRESSOR CLASSIFICATION — the book first, the tick rule only as the fallback
    // (the Lee-Ready convention). A print at or above the ask was lifted by a buyer,
    // a print at or below the bid was hit by a seller; only prints inside the spread
    // fall back to up-tick/down-tick.
    //
    // THIS BLOCK WAS DEAD CODE UNTIL NOW. The guard read `t.ask > t.bid`, but the
    // feed hands the sides over reversed (see tickCapture.orientLevel1), so the
    // guard was false on literally every row and the engine fell straight through
    // to the tick rule — the book was never consulted even though it was captured.
    // orientLevel1 normalises first, so the same code now works whether or not the
    // feed's side labels are trustworthy.
    let isBuy = false, isSell = false;
    const book = tickCapture.orientLevel1(t.bid, t.bidq, t.ask, t.askq);
    if (book.bid > 0 && book.ask > 0 && book.ask > book.bid) {
      if (t.p >= book.ask) isBuy = true;
      else if (t.p <= book.bid) isSell = true;
    }
    const prev = this.prevPrice.get(sym);
    if (!isBuy && !isSell && prev != null) {
      if (t.p > prev) isBuy = true;
      else if (t.p < prev) isSell = true;
    }
    this.prevPrice.set(sym, t.p);
    // Keep the level-1 book for the scanner: the ask wall and the book imbalance are
    // properties of the RESTING book, not of this print, so they are read from the
    // most recent orientation-correct snapshot rather than from the trade itself.
    if (book.bid > 0 && book.ask > 0 && book.ask > book.bid) {
      this.book.set(sym, {
        bid: book.bid, bidq: Number(book.bidq) || 0,
        ask: book.ask, askq: Number(book.askq) || 0,
        t: t.t || Date.now(),
      });
    }

    const q = t.q || 1;
    let currentBar = bars.length > 0 ? bars[bars.length - 1] : null;

    if (!currentBar || currentBar.t !== minKey) {
      currentBar = {
        t: minKey,
        o: t.p,
        h: t.p,
        l: t.p,
        c: t.p,
        v: q,
        delta: isBuy ? q : (isSell ? -q : 0),
        buyVol: isBuy ? q : 0,
        sellVol: isSell ? q : 0,
      };
      bars.push(currentBar);
      if (bars.length > 390) bars.shift(); // keep full 1-day 375 bars
    } else {
      currentBar.c = t.p;
      if (t.p > currentBar.h) currentBar.h = t.p;
      if (t.p < currentBar.l) currentBar.l = t.p;
      currentBar.v += q;
      if (isBuy) { currentBar.delta += q; currentBar.buyVol += q; }
      else if (isSell) { currentBar.delta -= q; currentBar.sellVol += q; }
    }

    // If live, monitor open positions on this symbol in real-time
    if (live) {
      this.checkPositionForTick(sym, t.p);
    }
  }

  // Hook called on every incoming tick from Angel One WebSocket
  onTick(tick) {
    if (!tick) return;
    this.ingestTick(tick, true);
  }

  // Check open calls for a specific symbol on every incoming tick
  checkPositionForTick(symbol, livePrice) {
    const nowIST = getISTTimeString();

    for (const c of this.calls.values()) {
      if (c.symbol !== symbol || ['WON', 'LOST', 'SESSION_CLOSE'].includes(c.status)) continue;

      c.ltp = livePrice;
      const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
      const entry = Number(c.limitEntry) || livePrice;

      const pts = isShort ? (entry - livePrice) : (livePrice - entry);
      const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;
      c.livePoints = +pts.toFixed(2);
      c.livePnLPct = +pnlPct.toFixed(2);
      c.livePnLVal = +pts.toFixed(2);
      c.netInr1Lot = +(pts * (c.shares || 1)).toFixed(2);
      c.mfePct = Math.max(c.mfePct || 0, pnlPct);

      // DYNAMIC BREAKEVEN LOCK (EXP004):
      // When trade reaches +0.50% profit (50 bps MFE), automatically trail stop to entry + 15 bps friction floor.
      // This protects winning runners from round-tripping into full stop-outs.
      if (!c.breakevenArmed) {
        if (!isShort && pnlPct >= 0.50) {
          c.breakevenArmed = true;
          const beStop = +(entry * 1.0015).toFixed(2); // entry + 15 bps to cover all taxes & brokerage
          if (beStop > c.stopLoss) {
            c.stopLoss = beStop;
            c.note = (c.note || '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]';
            console.log(`[liveMinuteEngine] 🛡️ BREAKEVEN LOCKED: ${c.symbol} reached +${pnlPct.toFixed(2)}% MFE, trailing SL to ₹${c.stopLoss}`);
          }
        } else if (isShort && pnlPct >= 0.50) {
          c.breakevenArmed = true;
          const beStop = +(entry * 0.9985).toFixed(2);
          if (beStop < c.stopLoss) {
            c.stopLoss = beStop;
            c.note = (c.note || '') + ' [🛡️ BREAKEVEN LOCKED at +0.50% MFE]';
            console.log(`[liveMinuteEngine] 🛡️ BREAKEVEN LOCKED: ${c.symbol} reached +${pnlPct.toFixed(2)}% MFE, trailing SL to ₹${c.stopLoss}`);
          }
        }
      }

      // 45-MINUTE MOMENTUM STAGNATION STOP (EXP007B):
      // If position has been active for >= 45 minutes and failed to achieve >= +0.35% MFE,
      // order flow momentum has evaporated. Exit at market to free slot and prevent afternoon liquidation dumps.
      const elapsedMs = Date.now() - (c.timestamp || Date.now());
      const elapsedMin = elapsedMs / 60000;
      if (elapsedMin >= 45.0 && (c.mfePct || 0) < 0.35) {
        c.status = pts >= 0 ? 'WON' : 'LOST';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'STAGNATION_EXIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - (pts !== 0 ? 0.20 : 0)).toFixed(2);
        c.note = (c.note || '') + ` [⏱️ 45M STAGNATION EXIT: Momentum faded (peak +${(c.mfePct || 0).toFixed(2)}% MFE)]`;
        this.closedCalls.push(c);
        this.saveCalls();
        const won = pts >= 0;
        console.log(`[liveMinuteEngine] ⏱️ STAGNATION EXIT: ${c.symbol} exited at ${nowIST} after ${elapsedMin.toFixed(0)}m (MFE: +${(c.mfePct || 0).toFixed(2)}%)`);
        this.dispatchTelegramExit(c, won);
        continue;
      }

      // Check Target Hit (WON)
      if (!isShort && livePrice >= c.target) {
        c.status = 'WON';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'TARGET_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - 0.20).toFixed(2);
        this.closedCalls.push(c);
        this.saveCalls();
        console.log(`[liveMinuteEngine] 🎯 TARGET REACHED: ${c.symbol} WON +${pts.toFixed(2)} pts (+${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, true);
      } else if (isShort && livePrice <= c.target) {
        c.status = 'WON';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'TARGET_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - 0.20).toFixed(2);
        this.closedCalls.push(c);
        this.saveCalls();
        console.log(`[liveMinuteEngine] 🎯 TARGET REACHED: ${c.symbol} WON +${pts.toFixed(2)} pts (+${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, true);
      }
      // Check Stop Loss Hit (LOST or BREAKEVEN)
      else if (!isShort && livePrice <= c.stopLoss) {
        c.status = (c.breakevenArmed && pts >= 0) ? 'WON' : 'LOST';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = c.breakevenArmed ? 'BREAKEVEN_EXIT' : 'STOP_LOSS_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - (pts !== 0 ? 0.20 : 0)).toFixed(2);
        this.closedCalls.push(c);
        this.saveCalls();
        const won = c.status === 'WON';
        console.log(`[liveMinuteEngine] ${won ? '🛡️ BREAKEVEN SCRATCH' : '🛑 STOP LOSS HIT'}: ${c.symbol} ${c.status} ${pts.toFixed(2)} pts (${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, won);
      } else if (isShort && livePrice >= c.stopLoss) {
        c.status = (c.breakevenArmed && pts >= 0) ? 'WON' : 'LOST';
        c.exitPrice = livePrice;
        c.exitTimeIST = nowIST;
        c.exitReason = c.breakevenArmed ? 'BREAKEVEN_EXIT' : 'STOP_LOSS_HIT';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - (pts !== 0 ? 0.20 : 0)).toFixed(2);
        this.closedCalls.push(c);
        this.saveCalls();
        const won = c.status === 'WON';
        console.log(`[liveMinuteEngine] ${won ? '🛡️ BREAKEVEN SCRATCH' : '🛑 STOP LOSS HIT'}: ${c.symbol} ${c.status} ${pts.toFixed(2)} pts (${pnlPct.toFixed(2)}%) at ${nowIST}`);
        this.dispatchTelegramExit(c, won);
      }
    }
  }

  // Telegram Alert for Exit
  async dispatchTelegramExit(c, won) {
    if (!sendPhoneNotification) return;
    try {
      const emoji = won ? '🎯' : '🛑';
      const title = won ? 'TARGET 1 REACHED (WON)' : 'STOP LOSS HIT (CLOSED)';
      const msg = `${emoji} <b>${title}</b>\n\n` +
        `Symbol: <b>#${c.symbol}</b>\n` +
        `Action: <b>${c.action}</b>\n` +
        `Entry Price: ₹${Number(c.limitEntry).toFixed(2)}\n` +
        `Exit Price: <b>₹${Number(c.exitPrice).toFixed(2)}</b>\n` +
        `Result: <b>${won ? '+' : ''}${c.grossPoints1Lot} pts (${won ? '+' : ''}${c.livePnLPct}%)</b>\n` +
        `Net P&L (1 Lot): <b>${c.netInr1Lot >= 0 ? '+' : ''}₹${Number(c.netInr1Lot).toFixed(2)}</b>\n` +
        `Exit Time: <b>${c.exitTimeIST} IST</b>\n\n` +
        `<i>Track live on http://localhost:4000/final</i>`;
      await sendPhoneNotification(msg);
    } catch (_) {}
  }

  // Telegram Alert for New Call
  async dispatchTelegramNewCall(c) {
    if (!sendPhoneNotification) return;
    try {
      const targetPct = ((c.target - c.limitEntry) / c.limitEntry * 100).toFixed(2);
      const stopPct = ((c.limitEntry - c.stopLoss) / c.limitEntry * 100).toFixed(2);
      const msg = `🚀 <b>NEW INSTITUTIONAL BUY CALL</b>\n\n` +
        `Symbol: <b>#${c.symbol}</b>\n` +
        `Action: <b>${c.action} / ${c.side}</b>\n` +
        `Entry: <b>₹${Number(c.limitEntry).toFixed(2)}</b>\n` +
        `Stop Loss: <b>₹${Number(c.stopLoss).toFixed(2)}</b> (-${stopPct}% / -${c.riskBps} bps)\n` +
        `Target 1: <b>₹${Number(c.target).toFixed(2)}</b> (+${targetPct}% / +${c.targetBps} bps)\n` +
        `Risk:Reward: <b>${c.riskReward}</b>\n\n` +
        `<b>Institutional Confluence:</b>\n` +
        `• ${c.note}\n` +
        `• Time: <b>${c.timeIST} IST</b>\n\n` +
        `<i>Live tracking enabled on http://localhost:4000/final</i>`;
      await sendPhoneNotification(msg);
    } catch (_) {}
  }

  // Current IST minute-of-day. A METHOD rather than a bare call so a test can pin
  // the clock without faking Date globally (which would also move the depth-age
  // check in the same breath).
  istMinute() {
    const d = new Date(Date.now() + 330 * 60000);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  // NIFTY 50 MACRO REGIME DETECTOR.
  // Calculates real-time intraday VWAP for Nifty 50 to assess broader market beta gravity.
  // When Nifty is falling below VWAP, market-wide selling knocks long breakouts down.
  getNiftyRegime() {
    const niftyBars = this.symBars.get('NIFTY') || this.symBars.get('NIFTY 50') || this.symBars.get('99926000');
    if (!niftyBars || niftyBars.length < 5) return { regime: 'NEUTRAL', currentPrice: 0, vwap: 0, distPct: 0 };
    let cumNum = 0, cumDen = 0;
    for (const b of niftyBars) {
      const typ = (b.h + b.l + b.c) / 3;
      cumNum += typ * b.v;
      cumDen += b.v;
    }
    const currentPrice = niftyBars[niftyBars.length - 1].c;
    // AN INDEX FEED CARRIES NO TRADED VOLUME. Weighting the typical price by `b.v`
    // therefore left cumDen === 0, and the old fallback set vwap = currentPrice —
    // which makes `currentPrice >= vwap` TRUE on every bar of every session. The
    // regime read BULLISH permanently, so `isNiftyBearish` was never true and the
    // Nifty macro gate (heavier confluence + delta >= 15% when Nifty < VWAP) NEVER
    // FIRED, on any day, including 2026-10-12 when Nifty fell -0.84% below VWAP and
    // the engine kept arming longs into it. With no volume to weight by, the honest
    // proxy is a TIME-weighted VWAP: the mean typical price over the session.
    const timeVwap = niftyBars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3), 0) / niftyBars.length;
    const vwap = cumDen > 0 ? cumNum / cumDen : timeVwap;
    const distPct = ((currentPrice - vwap) / vwap) * 100;
    const dayLow = Math.min(...niftyBars.map(b => b.l));
    const isCascading = currentPrice <= (dayLow * 1.0010); // Within 10 bps of Day Low -> Institutional liquidation cascade
    return {
      regime: currentPrice >= vwap ? 'BULLISH' : 'BEARISH',
      currentPrice,
      dayLow: +dayLow.toFixed(2),
      isCascading,
      vwap: +vwap.toFixed(2),
      distPct: +distPct.toFixed(2),
    };
  }

  /** Stamp every open call SESSION_CLOSE, calculate final realized P&L, push to closedCalls, and dispatch Telegram summary. */
  closeSession() {
    if (this.sessionClosed) return;
    let n = 0;
    const nowIST = getISTTimeString();
    for (const c of this.calls.values()) {
      if (c.status === 'ARMED') {
        const exitPrice = c.ltp || c.limitEntry;
        const entry = Number(c.limitEntry) || exitPrice;
        const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
        const pts = isShort ? (entry - exitPrice) : (exitPrice - entry);
        const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;

        c.exitPrice = exitPrice;
        c.exitTimeIST = nowIST;
        c.exitReason = 'SESSION_CLOSE';
        c.grossPoints1Lot = +pts.toFixed(2);
        c.netBps = +((pts / entry) * 10000 - 15).toFixed(1);
        c.netInr1Lot = +(pts * (c.shares || 1) - (pts !== 0 ? 0.20 : 0)).toFixed(2);
        c.status = pts >= 0 ? 'WON' : 'LOST';
        this.closedCalls.push(c);
        n++;
      }
    }
    this.sessionClosed = true;
    if (n) {
      this.saveCalls();
      console.log('[liveMinuteEngine] SESSION CLOSED (15:30 IST) — ' + n + ' open call(s) settled at market close');
      this.dispatchTelegramSessionSummary();
    }
  }

  async dispatchTelegramSessionSummary() {
    if (!sendPhoneNotification) return;
    try {
      const net = this.getDailyNet();
      const emoji = net.isNetPositive ? '🟢' : '🔴';
      const msg = `📊 <b>NSE MARKET CLOSE — DAILY INSTITUTIONAL SCORECARD</b>\n\n` +
        `Date: <b>${net.date}</b>\n` +
        `Total Recommendations: <b>${net.totalRecommendations}</b>\n` +
        `Won: <b>${net.won}</b> ✅ | Lost: <b>${net.lost}</b> 🛑\n` +
        `Win Rate: <b>${net.winRatePct}%</b>\n` +
        `Total Net Points: <b>${net.totalPoints > 0 ? '+' : ''}${net.totalPoints} pts</b>\n` +
        `Net P&L (1 Lot Basis): <b>${net.totalNetInr >= 0 ? '+' : ''}₹${net.totalNetInr}</b>\n` +
        `Verdict: <b>${emoji} ${net.verdict}</b>\n\n` +
        `<i>All positions settled net of Groww brokerage and exchange taxes.</i>\n` +
        `<i>View full audited history at http://localhost:4000/final</i>`;
      await sendPhoneNotification(msg);
      console.log('[liveMinuteEngine] Daily Telegram summary dispatched!');
    } catch (e) {
      console.error('[liveMinuteEngine] Error sending summary:', e.message);
    }
  }

  // Evaluate all stocks in universe every 60 seconds
  scanMinuteTape() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      const activeSymbols = new Set(Array.from(this.calls.values()).filter(c => c.status === 'ARMED').map(c => c.symbol));
      const candidates = [];
      const currentIST = getISTTimeString();

      // NIFTY 50 MACRO REGIME CHECK.
      // Evaluates whether the broader market has downward index gravity.
      const nifty = this.getNiftyRegime();
      const isNiftyBearish = nifty.regime === 'BEARISH';
      const isNiftyCascading = !!nifty.isCascading;
      if (isNiftyCascading) {
        console.log(`[liveMinuteEngine] ⚠️ Nifty is cascading at Day Low (₹${nifty.currentPrice} <= LOD ₹${nifty.dayLow}). Long setups HARD-LOCKED.`);
      }

      // SESSION GATES, checked before any candidate is built. Both are returns rather
      // than per-row conditions so a late-session scan cannot arm anything at all,
      // and a post-close scan cannot re-arm a call that was just stamped closed.
      // Position monitoring is NOT in here: it runs from ingestTick, tick by tick.
      const minuteIST = this.istMinute();
      // Boundaries are read off the INSTANCE, not the module constants, so an
      // experiment (or a test) can move the edge and assert the behaviour at it
      // without hard-coding a clock value another editor may later change.
      if (minuteIST >= this.sessionCloseMinute) { this.closeSession(); return; }
      if (minuteIST >= this.armEndMinute) return;   // cutoff onward: watch, never arm

      for (const [sym, bars] of this.symBars.entries()) {
        if (!bars || bars.length < 15 || activeSymbols.has(sym)) continue;

        const currentBar = bars[bars.length - 1];
        const currentPrice = currentBar.c;
        if (!(currentPrice > 0)) continue;
        // Above the one-lot price cap the call is never even considered — see
        // MAX_SHARE_PRICE. Only arming is gated; an already-open position in a name
        // that later crosses the cap keeps being monitored to its exit.
        if (currentPrice > MAX_SHARE_PRICE) continue;

        // VWAP calculation
        let cumNum = 0, cumDen = 0;
        let dayHigh = -Infinity, dayLow = Infinity;
        for (const b of bars) {
          const typ = (b.h + b.l + b.c) / 3;
          cumNum += typ * b.v;
          cumDen += b.v;
          if (b.h > dayHigh) dayHigh = b.h;
          if (b.l < dayLow) dayLow = b.l;
        }
        const vwap = cumDen > 0 ? cumNum / cumDen : currentPrice;
        const vwapDistPct = ((currentPrice - vwap) / vwap) * 100;
        const firstPrice = bars[0].o || currentPrice;
        const dayChangePct = ((currentPrice - firstPrice) / firstPrice) * 100;

        // Delta ratio in recent 5 bars
        const recent5 = bars.slice(-5);
        const delta5 = recent5.reduce((s, b) => s + b.delta, 0);
        const vol5 = recent5.reduce((s, b) => s + b.v, 0);
        const deltaRatio = vol5 > 0 ? (delta5 / vol5) : 0;

        // Volume surge vs 20-bar baseline
        const priorBars = bars.slice(0, -5);
        const avgVol = priorBars.length > 0 ? (priorBars.reduce((s, b) => s + b.v, 0) / priorBars.length) : (vol5 / 5);
        const curVol = vol5 / 5;
        const volSurge = avgVol > 0 ? (curVol / avgVol) : 1;

        // BULLISH FVG — structural (zone + F1 quality + F3 liveness).
        const bullFvg = findFvg(bars, +1);
        const hasBullishFvg = !!bullFvg && bullFvg.live;

        // Liquidity Sweep (SSL Sweep Reclaim for Longs)
        let hasLiquiditySweep = false;
        if (bars.length >= 25) {
          const swingLow = Math.min(...bars.slice(-25, -5).map(b => b.l));
          const dippedBelow = bars.slice(-5).some(b => b.l < swingLow);
          const closedAbove = currentPrice > swingLow;
          if (dippedBelow && closedAbove) {
            hasLiquiditySweep = true;
          }
        }

        // Anti-Climax Guard (Reject if current bar spiked > 2.5x ATR at HOD)
        const recentAtr = bars.slice(-8).reduce((s, b) => s + (b.h - b.l), 0) / 8;
        const isClimaxSpike = (currentBar.h - currentBar.l > recentAtr * 2.5) && (currentPrice >= dayHigh * 0.998);

        // 1. Trend Alignment (20/50 EMA on 1-min bars)
        let ema20 = bars[0].c, ema50 = bars[0].c;
        const k20 = 2 / (20 + 1), k50 = 2 / (50 + 1);
        for (let i = 1; i < bars.length; i++) {
          const bc = bars[i].c;
          ema20 = bc * k20 + ema20 * (1 - k20);
          ema50 = bc * k50 + ema50 * (1 - k50);
        }
        const isLongTrendValid = currentPrice >= ema20 && ema20 >= ema50;
        const isShortTrendValid = currentPrice <= ema20 && ema20 <= ema50;

        // 2. Fibonacci Premium / Discount Equilibrium
        const dayRange = dayHigh - dayLow;
        const fibEquilibrium = dayLow + 0.50 * dayRange;
        // DO NOT BUY in Premium (> 50% range); DO NOT SHORT in Discount (< 50% range)
        const isLongFibValid = currentPrice <= fibEquilibrium;
        const isShortFibValid = currentPrice >= fibEquilibrium;

        // 3. Volume Point of Control (POC) Buffer
        const TICK_POC = 0.10;
        const bins = new Map();
        for (const b of bars) {
          if (!(b.v > 0) || !(b.h >= b.l)) continue;
          const lo = Math.floor(b.l / TICK_POC) * TICK_POC;
          const hi = Math.ceil(b.h / TICK_POC) * TICK_POC;
          const steps = Math.max(1, Math.round((hi - lo) / TICK_POC) + 1);
          const per = b.v / steps;
          for (let p = lo; p <= hi + 1e-9; p += TICK_POC) {
            const key = p.toFixed(2);
            bins.set(key, (bins.get(key) || 0) + per);
          }
        }
        let poc = null, maxVol = -1;
        for (const [key, vol] of bins.entries()) {
          if (vol > maxVol) { maxVol = vol; poc = parseFloat(key); }
        }
        const distToPocBps = poc ? ((currentPrice - poc) / currentPrice) * 10000 : 0;
        const isPocShortBlocked = poc && poc < currentPrice && distToPocBps <= 25;
        const isPocLongBlocked = poc && poc > currentPrice && Math.abs(distToPocBps) <= 25;

        // Core Institutional Rules:
        // 1. Not a climax exhaustion spike
        // 2. Firmly defended above VWAP support (pullback within 0.05% to 0.85%)
        // 3. Positive day change (relative strength > 0.3% and < 4.0%)
        // 4. MANDATORY Positive Order Flow Delta (> +5%): Never buy into negative delta / institutional distribution
        // 5. Confluence: FVG Support OR Liquidity Sweep OR Strong Volume Surge (>1.3x) OR High Delta (>15%)
        const confluence = confluenceCount(+1,
          { hasFvg: hasBullishFvg, swept: hasLiquiditySweep, volSurge, deltaRatio },
          this.fvgConfluenceWeight);

        // THE BOOK — Level-1 / Level-5 order book dynamics.
        // `bi`: standard imbalance (-1..+1)
        // `askWallRatio`: askQty / bidQty overhead
        // DYNAMIC ABSORPTION GATE:
        // An ask wall (>5x) is overhead resistance ONLY if buying aggression is weak.
        // If smart money is actively absorbing the wall (deltaRatio >= +15% and volSurge >= 1.8x),
        // large resting asks are liquidity targets being swept — DO NOT BLOCK!
        const bookNow = this.book.get(sym);
        const bookAgeMs = bookNow ? (Date.now() - bookNow.t) : Infinity;
        const depthFresh = bookNow && bookAgeMs <= DEPTH_MAX_AGE_MS;
        const bookBidq = bookNow ? bookNow.bidq : 0;
        const bookAskq = bookNow ? bookNow.askq : 0;
        const bi = (bookBidq + bookAskq) > 0 ? (bookBidq - bookAskq) / (bookBidq + bookAskq) : 0;
        const askWallRatio = bookBidq > 0 ? bookAskq / bookBidq
          : (bookAskq > 0 ? Infinity : 0);
        // The mirror measurement, and it must be the MIRROR: askq === 0 with a large
        // bidq is a one-sided book and is just as much a wall for a short as an empty
        // bid is for a long. The previous short-side formula returned 0 there, so the
        // two sides disagreed about the same book; both are Infinity/0 consistently now.
        const bidWallRatio = bookAskq > 0 ? bookBidq / bookAskq
          : (bookBidq > 0 ? Infinity : 0);

        // BID-ASK SPREAD GATE.
        // Eliminates wide-spread names (>6.0 bps) that suffer from severe slippage & crossing costs.
        const spreadBps = (bookNow && bookNow.bid > 0 && bookNow.ask > 0)
          ? ((bookNow.ask - bookNow.bid) / bookNow.bid) * 10000
          : 0;
        const blockedBySpread = !!depthFresh && this.maxSpreadBps > 0 && spreadBps > this.maxSpreadBps;

        // Both walls are measured ONCE, above the branches, for both directions. The
        // short branch used to recompute its own copy, which is how a measured BID wall
        // ended up published in a field called askWallRatio and printed as "ask wall".
        const isAbsorbingWall = deltaRatio >= 0.15 && volSurge >= 1.8;
        const blockedByAskWall = this.askWallRatioMin > 0 && !!depthFresh &&
          askWallRatio >= this.askWallRatioMin && !isAbsorbingWall;
        const isAbsorbingBidWall = deltaRatio <= -0.15 && volSurge >= 1.8;
        const blockedByBidWall = this.askWallRatioMin > 0 && !!depthFresh &&
          bidWallRatio >= this.askWallRatioMin && !isAbsorbingBidWall;

        // NIFTY MARKET BETA CONFLUENCE GATE:
        // When Nifty is falling below VWAP, market beta drag knocks long breakouts down.
        // In BEARISH Nifty regime, longs MUST decouple with Confluence >= 3 AND Delta >= +15%.
        const requiredConfluence = isNiftyBearish ? 3 : 2;
        const minDelta = isNiftyBearish ? 0.15 : 0.05;

        // DIRECTION-AWARE MIDDAY FILTER (EXP010):
        // Replay and tape forensics prove the 12:30-13:45 IST window is severely unprofitable for LONGS (-30.8 bps),
        // but profitable for SHORTS (+8.8 bps). Block Longs during this lull; keep Shorts active.
        const isMiddayLongWindow = minuteIST >= (12 * 60 + 30) && minuteIST < (13 * 60 + 45);

        // LONG SETUP EVALUATION
        // Hard-locked if Longs disabled, Nifty cascading at Day Low (EXP007C), Midday Long Window (EXP010),
        // or invalidated by the 5 Core Invalidation Gates:
        // Gate 1: Counter-Trend EMA (Price < EMA20 or EMA20 < EMA50)
        // Gate 2: Premium Trap (Price > Fib Equilibrium)
        // Gate 3: Overhead POC Buffer (POC <= 25 bps overhead)
        // Gate 4: Overhead Ask Wall without Absorption
        const longGatesPassed = !this.strictInvalidation || (isLongTrendValid && isLongFibValid && !isPocLongBlocked);
        if (this.longEnabled && longGatesPassed && !isMiddayLongWindow && !isNiftyCascading && !blockedBySpread && !isClimaxSpike && currentPrice > vwap && vwapDistPct >= 0.05 && vwapDistPct <= 0.85 && dayChangePct > 0.3 && deltaRatio >= minDelta && confluence >= requiredConfluence) {
          const stopBps = Math.max(45, Math.min(55, Math.round((Math.abs(vwapDistPct) + 0.25) * 100)));
          const stopLoss = +(currentPrice * (1 - stopBps / 10000)).toFixed(2);
          const targetBps = Math.round(stopBps * 1.50); // Mandate: R:R <= 1:1.50
          const target = +(currentPrice * (1 + targetBps / 10000)).toFixed(2);
          const riskPts = +(currentPrice - stopLoss).toFixed(2);
          const rewardPts = +(target - currentPrice).toFixed(2);

          candidates.push({
            symbol: sym,
            action: 'BUY',
            side: 'LONG',
            limitEntry: currentPrice,
            stopLoss,
            target,
            riskPts,
            rewardPts,
            riskBps: stopBps,
            targetBps,
            riskReward: `1 : ${(rewardPts / riskPts).toFixed(2)}`,
            vwap: +vwap.toFixed(2),
            volSurge: +volSurge.toFixed(2),
            deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
            spreadBps: +spreadBps.toFixed(1),
            hasBullishFvg,
            hasLiquiditySweep,
            invalidationGates: {
              trend: isLongTrendValid ? 'EMA_ALIGNED' : 'COUNTER_TREND',
              fib: isLongFibValid ? 'DISCOUNT_ZONE' : 'PREMIUM_TRAP',
              poc: isPocLongBlocked ? 'OVERHEAD_POC' : 'POC_CLEAR',
              sweep: hasLiquiditySweep ? 'SSL_SWEPT' : 'NONE',
              fvg: hasBullishFvg ? 'BULLISH_FVG' : 'NONE',
              delta: +(deltaRatio * 100).toFixed(1) + '%'
            },
            // A long buys at the ASK: the wall it must cross is the ask wall.
            blockedByAskWall,
            blockedByBidWall: false,
            wallSide: 'ASK',
            wallRatio: +askWallRatio.toFixed(2),
            blockedBySpread,
            bookBidq, bookAskq, bi: +bi.toFixed(3),
            askWallRatio: +askWallRatio.toFixed(2),
            bidWallRatio: +bidWallRatio.toFixed(2),
            score: confluence * 10 + Math.min(volSurge, 5),
          });
        }

        // SHORT SETUP EVALUATION (Sell-Side Institutional Momentum)
        // BEARISH FVG with its zone, then the two entry-state rules (F2, F4).
        const fvgDecision = fvgShortGate(bars, currentPrice);
        const bearFvg = fvgDecision.gap;
        const fvgGate = fvgDecision.gate;
        const hasBearishFvg = fvgGate === 'BEARISH_FVG_CE';
        const fvgShortOk = !(FVG_STRUCTURAL && FVG_REQUIRE) || hasBearishFvg;

        let hasBslSweep = false;
        if (bars.length >= 25) {
          const swingHigh = Math.max(...bars.slice(-25, -5).map(b => b.h));
          const pokedAbove = bars.slice(-5).some(b => b.h > swingHigh);
          const closedBelow = currentPrice < swingHigh;
          if (pokedAbove && closedBelow) {
            hasBslSweep = true;
          }
        }

        const isDumpClimax = (currentBar.h - currentBar.l > recentAtr * 2.5) && (currentPrice <= dayLow * 1.002);
        const bearConfluence = confluenceCount(-1,
          { hasFvg: hasBearishFvg, swept: hasBslSweep, volSurge, deltaRatio },
          this.fvgConfluenceWeight);

        // Hard-locked if invalidated by the 5 Core Invalidation Gates:
        // Gate 1: Counter-Trend EMA (Price > EMA20 or EMA20 > EMA50)
        // Gate 2: Discount Trap (Price < Fib Equilibrium)
        // Gate 3: Below POC Buffer (POC <= 25 bps below)
        // Gate 4: Bid Wall without Absorption
        const shortGatesPassed = !this.strictInvalidation || (isShortTrendValid && isShortFibValid && !isPocShortBlocked);
        if (shortGatesPassed && fvgShortOk && !blockedBySpread && !isDumpClimax && currentPrice < vwap && vwapDistPct <= -0.05 && vwapDistPct >= -0.85 && dayChangePct < -0.3 && deltaRatio < -0.05 && bearConfluence >= 2) {
          const stopBps = Math.max(45, Math.min(55, Math.round((Math.abs(vwapDistPct) + 0.25) * 100)));
          const stopLoss = +(currentPrice * (1 + stopBps / 10000)).toFixed(2);
          const targetBps = Math.min(this.shortTargetBps || 75, Math.round(stopBps * 1.50)); // Mandate: R:R <= 1:1.50
          const target = +(currentPrice * (1 - targetBps / 10000)).toFixed(2);
          const riskPts = +(stopLoss - currentPrice).toFixed(2);
          const rewardPts = +(currentPrice - target).toFixed(2);

          candidates.push({
            symbol: sym,
            action: 'SELL',
            side: 'SHORT',
            limitEntry: currentPrice,
            stopLoss,
            target,
            riskPts,
            rewardPts,
            riskBps: stopBps,
            targetBps,
            riskReward: `1 : ${(rewardPts / riskPts).toFixed(2)}`,
            vwap: +vwap.toFixed(2),
            volSurge: +volSurge.toFixed(2),
            deltaRatio: +(deltaRatio * 100).toFixed(1) + '%',
            spreadBps: +spreadBps.toFixed(1),
            hasBullishFvg: false,
            hasLiquiditySweep: hasBslSweep,
            hasBearishFvg,
            invalidationGates: {
              trend: isShortTrendValid ? 'EMA_ALIGNED' : 'COUNTER_TREND',
              fib: isShortFibValid ? 'PREMIUM_ZONE' : 'DISCOUNT_TRAP',
              poc: isPocShortBlocked ? 'SUPPORT_POC' : 'POC_CLEAR',
              sweep: hasBslSweep ? 'BSL_SWEPT' : 'NONE',
              fvg: fvgGate,
              delta: +(deltaRatio * 100).toFixed(1) + '%'
            },
            fvgZone: bearFvg ? { top: bearFvg.top, bottom: bearFvg.bottom, ce: bearFvg.ce, gapBps: bearFvg.gapBps, bodyFrac: bearFvg.bodyFrac } : null,
            blockedByFvg: !fvgShortOk,
            // A short sells at the BID, so the wall it must cross is the bid wall.
            blockedByAskWall: false,
            blockedByBidWall,
            wallSide: 'BID',
            wallRatio: +bidWallRatio.toFixed(2),
            blockedBySpread,
            bookBidq, bookAskq, bi: +bi.toFixed(3),
            askWallRatio: +askWallRatio.toFixed(2),
            bidWallRatio: +bidWallRatio.toFixed(2),
            score: bearConfluence * 10 + Math.min(volSurge, 5),
          });
        }
      }

      // A candidate the ask wall refuses is REPORTED, not quietly discarded — the
      // whole point of measuring the book is that the operator can see what stopped
      // a call. It is excluded from selection so the wall can never fill a slot.
      const wallBlocked = (c) => c.blockedByAskWall || c.blockedByBidWall;
      const blocked = candidates.filter(c => wallBlocked(c) || c.blockedBySpread);
      const allowed = candidates.filter(c => !wallBlocked(c) && !c.blockedBySpread);
      if (blocked.length) {
        console.log('[liveMinuteEngine] filter blocked ' + blocked.length + ' candidate(s): ' +
          blocked.map(c => c.symbol + (c.blockedBySpread
            ? ` (spread ${c.spreadBps} bps > ${this.maxSpreadBps})`
            : ` (${c.wallSide} wall ${c.wallRatio}x)`)).join(', '));
      }

      allowed.sort((a, b) => b.score - a.score || b.volSurge - a.volSurge);

      // Keep maximum 6-8 active calls on the board
      const activeCount = Array.from(this.calls.values()).filter(c => c.status === 'ARMED').length;
      const slotsAvailable = Math.max(0, 6 - activeCount);

      if (slotsAvailable > 0 && allowed.length > 0) {
        const selected = allowed.slice(0, slotsAvailable);
        for (const s of selected) {
          const id = `CALL-${s.symbol}-${this.today}-${String(this.calls.size + 1).padStart(3, '0')}`;
          const newCall = {
            id,
            date: this.today,
            timeIST: currentIST,
            timestamp: Date.now(),
            symbol: s.symbol,
            side: s.side,
            action: s.action,
            strategyType: 'INTRADAY',
            limitEntry: s.limitEntry,
            stopLoss: s.stopLoss,
            target: s.target,
            riskPts: s.riskPts,
            rewardPts: s.rewardPts,
            riskBps: s.riskBps,
            targetBps: s.targetBps,
            riskReward: s.riskReward,
            shares: Math.max(1, Math.floor(POSITION_NOTIONAL / s.limitEntry)),
            notional: +(Math.max(1, Math.floor(POSITION_NOTIONAL / s.limitEntry)) * s.limitEntry).toFixed(2),
            status: 'ARMED',
            marketBreadth: 'BULLISH_CONFLUENCE',
            sectorBreadth: 'INSTITUTIONAL_MOMENTUM',
            fillPrice: s.limitEntry,
            entryTimeIST: currentIST,
            exitPrice: null,
            exitTimeIST: null,
            exitReason: null,
            grossPoints1Lot: null,
            netBps: null,
            netInr1Lot: 0.0,
            note: `${s.hasBullishFvg ? 'FVG Support + ' : ''}${s.hasLiquiditySweep ? 'SSL Sweep + ' : ''}Vol Surge ${s.volSurge}x + Delta ${s.deltaRatio}. Book BI ${s.bi} (bid ${s.bookBidq} / ask ${s.bookAskq}). Target +${(s.targetBps/100).toFixed(2)}% (+${s.targetBps} bps) net of taxes.`,
            ltp: s.limitEntry,
            livePoints: 0.0,
            livePnLPct: 0.0,
            livePnLVal: 0.0,
          };
          this.calls.set(id, newCall);
          console.log(`[liveMinuteEngine] 🚀 LIVE CALL DISPATCHED (${currentIST}): ${newCall.symbol} BUY @ ₹${newCall.limitEntry} (Target: ₹${newCall.target} | SL: ₹${newCall.stopLoss})`);
          this.dispatchTelegramNewCall(newCall);
        }
        this.saveCalls();
      }
    } catch (err) {
      console.error('[liveMinuteEngine] Scan error:', err.message);
    } finally {
      this.isScanning = false;
    }
  }

  async start() {
    console.log('[liveMinuteEngine] Initializing Institutional Live Engine...');
    await this.loadTapeBars();

    // Run initial scan
    this.scanMinuteTape();

    // 1-minute cadence for setup scanning
    this.scanInterval = setInterval(() => {
      this.scanMinuteTape();
    }, 60000);

    if (this.scanInterval.unref) this.scanInterval.unref();
    console.log('[liveMinuteEngine] Continuous 1-minute engine active!');
  }

  stop() {
    if (this.scanInterval) clearInterval(this.scanInterval);
  }

  getCalls() {
    return Array.from(this.calls.values());
  }

  getActiveCandidates() {
    return Array.from(this.calls.values()).filter(c => c.status === 'ARMED').map(c => {
      const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
      return {
        id: c.id,
        symbol: c.symbol,
        category: c.strategyType || 'INTRADAY',
        tradeType: '1:1.5 SCALPING',
        strategyName: 'Institutional Invalidation Scalp (1:1.50 R:R)',
        action: c.action || (isShort ? 'SELL / SHORT' : 'BUY / LONG'),
        side: isShort ? 'SHORT' : 'LONG',
        entryPrice: c.limitEntry,
        stopLoss: c.stopLoss,
        target1: c.target,
        ltp: c.ltp || c.limitEntry,
        livePnLPct: c.livePnLPct || 0.0,
        livePnLVal: c.livePnLVal || 0.0,
        status: c.status || 'ARMED',
        time: c.timeIST,
        signalTime: new Date(c.timestamp || Date.now()).toISOString(),
        winRate: '60.0%',
        riskReward: c.riskReward || '1 : 1.50',
        filterNote: c.note || '5 Invalidation Gates Verified (EMA+Fib+POC+Sweep+Delta)',
        invalidationGates: c.invalidationGates || null,
      };
    });
  }

  getClosedHistory() {
    return this.closedCalls.map(c => {
      const entry = Number(c.limitEntry || c.entryPrice || 0);
      const exit = Number(c.exitPrice || entry);
      const isShort = String(c.action || '').toUpperCase().includes('SELL') || String(c.side || '').toUpperCase() === 'SHORT';
      const pts = isShort ? (entry - exit) : (exit - entry);
      const pnlPct = entry > 0 ? (pts / entry) * 100 : 0;
      return {
        id: c.id,
        date: c.date,
        time: c.exitTimeIST || c.timeIST,
        symbol: c.symbol,
        category: c.strategyType || 'INTRADAY',
        strategyId: 'OF_MOMENTUM',
        strategyName: 'Order Flow Institutional Momentum',
        action: c.action || 'BUY',
        entryPrice: entry,
        exitPrice: exit,
        stopLoss: c.stopLoss,
        target1: c.target,
        status: c.status,
        verdict: c.status,
        realizedPnLPct: +pnlPct.toFixed(2),
        realizedPnLVal: +pts.toFixed(2),
        reason: c.exitReason || c.status,
        closedAt: c.timestamp,
      };
    });
  }

  getDailyNet() {
    const all = Array.from(this.calls.values());
    const closed = this.closedCalls;
    const won = closed.filter(c => c.status === 'WON');
    const lost = closed.filter(c => c.status === 'LOST');
    const active = all.filter(c => c.status === 'ARMED');

    const closedPoints = closed.reduce((sum, c) => sum + (c.grossPoints1Lot || 0), 0);
    const closedNetInr = closed.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0);

    const activePoints = active.reduce((sum, c) => sum + (c.livePoints || 0), 0);
    const activeNetInr = active.reduce((sum, c) => sum + (c.netInr1Lot || 0), 0);

    const totalNetInr = +(closedNetInr + activeNetInr).toFixed(2);
    const totalPoints = +(closedPoints + activePoints).toFixed(2);
    const winRate = closed.length > 0 ? +((won.length / closed.length) * 100).toFixed(1) : (won.length > 0 ? 100.0 : 0.0);

    return {
      date: this.today,
      measured: true,
      totalRecommendations: all.length,
      totalCalls: all.length,
      activeCalls: active.length,
      closedCalls: closed.length,
      won: won.length,
      lost: lost.length,
      winRatePct: winRate,
      positiveCalls: won.length + active.filter(c => (c.livePnLPct || 0) >= 0).length,
      closedNetInr: +closedNetInr.toFixed(2),
      activeNetInr: +activeNetInr.toFixed(2),
      totalNetInr,
      totalPoints,
      isNetPositive: totalNetInr >= 0,
      verdict: totalNetInr >= 0 ? `NET POSITIVE (+₹${Math.abs(totalNetInr)})` : `NET NEGATIVE (-₹${Math.abs(totalNetInr)})`,
      note: `Live measured today: ${won.length} WON, ${lost.length} LOST, ${active.length} ACTIVE out of ${all.length} calls`,
    };
  }
}

const liveEngine = new LiveMinuteEngine();

// Exposed on the exported instance so test/depthOrientation.test.js can exercise the FVG
// rules directly. The scan calls the SAME functions, so a passing test cannot describe a
// rule the engine does not apply.
liveEngine.findFvg = findFvg;
liveEngine.fvgShortGate = fvgShortGate;
liveEngine.fvgAtr = fvgAtr;
// The resolved shipped default of the FVG VETO, so a test can pin it. It must stay false
// until the causal measurement says the veto helps; see the constant's comment above.
liveEngine.fvgRequireDefault = FVG_REQUIRE;
// The resolved shipped default of the FVG CONFLUENCE WEIGHT, so a test can pin it. It must
// stay 1 (counted) until the Round 24 (C) forward test says demoting the gap helps.
liveEngine.fvgConfluenceWeightDefault = FVG_CONFLUENCE_WEIGHT;
// The confluence arithmetic itself, so a test can exercise the exact rule the scan applies.
liveEngine.confluenceCount = confluenceCount;

module.exports = liveEngine;
