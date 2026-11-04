let _prevCloses = null;

/**

 * server.js

 *

 * REST API wrapping broker.js so a frontend (built later) has a stable

 * HTTP/SSE contract instead of importing the SDK directly.

 *

 * SECURITY: set SERVER_API_KEY in .env to require an X-API-Key header on

 * every request except /health. Without it, auth is a no-op — fine for

 * local-only use on 127.0.0.1, but required before binding to 0.0.0.0 or

 * exposing this port beyond your own machine, since several endpoints

 * place real orders.

 */

process.on('uncaughtException', (err) => {

  console.error('[server] uncaughtException (server kept alive):', err && (err.stack || err.message));

});

process.on('unhandledRejection', (err) => {

  console.error('[server] unhandledRejection (server kept alive):', err && (err.message || err));

});



const express = require('express');

const cors = require('cors');

const axios = require('axios');

const crypto = require('crypto');

const path = require('path');

const fs = require('fs');

const Database = require('better-sqlite3');

const env = require('./config/env');

const Broker = require('./broker');

const instrumentService = require('./common/instruments/instrumentService');

const ledger = require('./common/ledger/ledgerService');

const { attachAutoRecording } = require('./common/ledger/autoRecorder');

const portfolioService = require('./common/portfolio/portfolioService');

const notificationService = require('./common/notifications/notificationService');

// The POSITIVE / NEGATIVE ledger — one classification of every strategy, read

// from the files that measured it. It performs no backtest and reads no candle.

const strategyLedger = require('./strategy-core/strategyLedger');

const liveQuoteEngine = require('./common/market/liveQuoteEngine');

// THE INTRADAY LIVE ENGINE IS DELETED (2026-10-31). `strategies/orderflow/` no longer exists:
// the operator removed every intraday and scalping strategy from the backend permanently.
// This tombstone keeps the routes that used to read it bootable instead of crashing on import —
// it reports nothing, emits nothing and can never produce a call. The live strategy surface is
// the swing scan (`GET /api/terminal/swing`), which reads `scripts/swingScan.js`.
const liveMinuteEngine = {
  getActiveCandidates: () => [],
  getClosedHistory: () => [],
  getBookRows: () => [],
  getDailyNet: () => ({ gross: 0, net: 0, calls: 0, closed: 0, note: 'intraday engine removed 2026-10-31' }),
  getScanFunnel: () => null,
  getScalpingBoard: () => ({ calls: [], activeCandidates: [], closedCalls: [], scalpingStats: { totalCalls: 0, activeCalls: 0, winRate: 0, grossPnl: 0, netPnl: 0 }, universeSize: 1006 }),
  getGrowwFastMovers: () => [],
  getGroww5MinMovers: () => [],
  getCalls: () => [],
  getRoc10: () => 0,
  prevPrice: new Map(),
  symBars: new Map(),
  calls: new Map(),
  closedCalls: [],
  lastMarkToMarket: null,
  onTick: () => {},
  start: async () => {},
  stop: () => {},
};

// PRESS BUY: IT BUYS, AND THE STOP AND TARGET GO WITH IT. One press sizes the position from the

// live balance, sends the entry, waits for the fill, and attaches the bracket at the broker.

const { executeBracket } = require('./common/risk/bracketOrder');

// CONFIRM FIRST. A press becomes a proposal held on disk and offered on Telegram; the order is

// only sent when a human taps ✅ in the configured chat. See the APPROVALS block below.

const { defaultStore: approvalStore, STATUS: APPROVAL_STATUS } = require('./common/notifications/orderApproval');

const telegramApprovals = require('./common/notifications/telegramApprovals');

const telegramConfig = require('./common/notifications/telegramService');

const catalystAlerter = require('./common/news/catalystAlerter');
const filingPriceTracker = require('./common/news/filingPriceTracker');

const { cleanSubject, cleanRationale } = require('./common/news/cleanSubject');



const app = express();





app.use(cors());

app.use(express.json());



// THE LEGACY PAGE IS REDIRECTED BY NAME, and this sits ABOVE the static middleware on purpose:

// express.static answers GET /index.html itself, so a redirect registered after it would never

// run. public/index.html is the older board whose master table is nine hardcoded rows naming

// strategies this application does not run (Donchian breakout, Golden Cross, ...) with invented

// percentages. It is kept in the repo as a record, but no URL serves it as a live view — the same

// treatment board.html already gets below.

app.get('/index.html', (req, res) => res.redirect('/'));



// AND SO IS board.html — WHICH IS WHERE THIS REDIRECT ACTUALLY WAS.

// The /board.html redirect lived BELOW express.static, so the static handler answered it with the

// 202,478-byte legacy page and the redirect was unreachable — the exact failure the comment above

// describes for index.html, still happening one line below it. The visible symptom: a tunnel URL

// ending in /board.html showed the OLD three-tier dashboard (TIER 1/2/3, "Order Flow Momentum +

// Sweep+FVG", an empty master table) while /final showed the current board, so whether the link

// worked depended on which filename the URL happened to carry. Registered above static now, so

// every legacy entry point lands on the measured page.

app.get(['/board', '/board.html'], (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'final.html'));

});



// Serve static frontend dashboard with strict no-cache for instant live updates.

//

// `index: false` matters: with the default, express.static answers GET / with public/index.html

// BEFORE any route below it runs, which silently overrode the root handler and kept the stale

// nine-strategy page on the default URL. The root is decided by the explicit route instead.

app.use(express.static(path.join(__dirname, 'public'), {

  index: false,

  setHeaders: (res, filePath) => {

    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {

      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

      res.setHeader('Pragma', 'no-cache');

      res.setHeader('Expires', '0');

    }

  }

}));



// THE ROOT URL IS THE LIVE BOARD.

//

// `/` used to serve public/index.html, a page whose master table was still the nine hardcoded

// rows (Donchian breakout, Golden Cross, ...) naming strategies this application does not run,

// with invented percentages — while `/final` served the page wired to the engines' own call

// book. So the URL an operator opens by default showed other software than the one making the

// calls; the page that measured them was one click away and unlinked from the root. Both URLs

// now serve the same measured board, so which link is typed cannot change what is reported.

app.get('/', (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'final.html'));

});



// Final 3 Core Strategies Page route

app.get('/final', (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'final.html'));

});



// NOTE: the legacy /board.html redirect is registered ABOVE express.static (see the top of this

// file). It used to sit here, after it, and therefore never ran — express.static served the stale

// page first. Re-registering it here would only create a second handler for the same path.



// Freebuff calls page — the sweep+FVG engine's own calls, with a guarded path to a live Angel order.

// Read-only apart from the send button, which posts to the SAME /api/:broker/orders route every

// other page uses, so the order vocabulary and validation are not duplicated here.

app.get('/final-freebuff', (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'final-freebuff.html'));

});



// News page — the world's headlines beside what the stock did next.

app.get('/news', (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'news.html'));

});



// ===========================================================================

// THE LIVE TIER FEED — the rows behind the three tier tables.

// ===========================================================================

// data/live_strategy_board.json is rewritten about once a minute by the live

// service, and each candidate already carries the tier the page splits its three

// tables by (category: SWING / INTRADAY / SCALPING) together with entry, stop,

// targets, the live ltp and the live P&L. The Python /api/final/board is the

// 3-core-strategy LEDGER view — it has no such rows, which is exactly why the

// three tier tables sat empty while the page looked connected.

//

// This route reports the file's own timestamp and whether it is stale. A feed

// older than five minutes is marked STALE rather than presented as current, and

// a missing file is a 503 — never an empty success.

app.get('/api/final/candidates', (req, res) => {

  const p = path.join(__dirname, 'data', 'live_strategy_board.json');

  try {

    const d = JSON.parse(fs.readFileSync(p, 'utf8'));

    const asOf = d.timestamp || d.generatedAt || null;

    const ageMs = asOf ? Date.now() - Date.parse(asOf) : null;

    res.json({

      ok: true,

      source: 'data/live_strategy_board.json',

      asOf,

      ageMs,

      stale: ageMs === null ? true : ageMs > 5 * 60 * 1000,

      gateStatus: d.gateStatus || null,

      pollingInterval: d.pollingInterval || null,

      timingRule: d.timingRule || null,

      date: d.date || null,

      dailyNet: d.dailyNet || null,

      candidates: d.candidates || [],

    });

  } catch (e) {

    res.status(503).json({ ok: false, error: e.message, source: 'data/live_strategy_board.json' });

  }

});



// Final API Endpoints — Python Single Source of Truth

//

// LIVE-ATTACHED. This route used to return data/live_strategy_board.json verbatim:

// no index quotes, no session state. And start() further down ALSO binds port 4000

// ([3000, 4000].forEach), the port the Python front door is meant to own — so on

// the port the browser actually uses, the payload had no `quotes` (four tiles stuck

// on "waiting for live quote…") and no `session` (a badge that could only read

// UNKNOWN), while those live pieces existed only in the unreachable Python payload.

// The live pieces are attached HERE now, so whichever server holds the public port

// answers with real quotes and a real session phase.

// NOTE: `liveQuoteEngine` is already required further down this file (next to

// /api/instruments/watchlist). One module-scope const is enough — the live helper

// below only runs when a request arrives, long after that line has executed.

const sessionTiming = require('./common/market/sessionTiming');

const BOARD_INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'INDIAVIX'];

let _boardQuotes = { at: 0, value: {} };



// Background index quotes refresher — NEVER blocks HTTP requests

async function refreshBoardIndexQuotes() {

  try {

    const raw = await liveQuoteEngine.fetchWatchlistQuotes(BOARD_INDEX_SYMBOLS);

    const bySymbol = Array.isArray(raw)

      ? raw.reduce((acc, r) => { if (r && r.symbol) acc[String(r.symbol).toUpperCase()] = r; return acc; }, {})

      : (raw || {});

    const out = {};

    for (const k of BOARD_INDEX_SYMBOLS) {

      const r = bySymbol[k] || bySymbol[k.toUpperCase()];

      if (!r || r.price === null || r.price === undefined) continue;

      out[k] = { price: r.price, change: r.change, pChange: r.changePct, source: r.source, lastUpdated: r.lastUpdated };

    }

    if (Object.keys(out).length > 0) {

      _boardQuotes = { at: Date.now(), value: out };

    }

  } catch (_) {}

}



setInterval(refreshBoardIndexQuotes, 3000);

setTimeout(refreshBoardIndexQuotes, 500);



function liveBoardQuotes() {

  return _boardQuotes.value;

}



// The session phase comes from common/market/sessionTiming.js — the same rules the

// rest of the app trades on (observation / settlement / active / cutoff / square-off).

function liveSessionState() {

  const phase = sessionTiming.getSessionPhase();

  const ist = sessionTiming.getISTTime();

  const running = ['ACTIVE_TRADING', 'CUTOFF', 'SQUARE_OFF'].includes(phase.phase);

  return {

    state: phase.phase,

    marketOpen: running,

    signalAllowed: !!phase.isSignalAllowed,

    asOfIST: ist.toTimeString().slice(0, 8),

    day: ist.toISOString().slice(0, 10),

    note: phase.reason,

  };

}



const liveStrategyEngine = require('./common/market/liveStrategyEngine');



const { exchangeDigest } = require('./common/market/exchangeDigest');

// classify / tallyOutcomes: THE one win-rate rule (win = target actually hit, loss = stop

// actually hit, everything else = an exit without a level). Every win rate this server

// publishes goes through them, so the history tables, the strategy table and the sweep

// panel can never disagree about the same call.

const { callBookHistory, classify, tallyOutcomes, liveRollingRecord, entryRiskBps } = require('./common/market/callBookHistory');



/**

 * PER-STRATEGY PERFORMANCE, MEASURED FROM TODAY'S OWN CALL BOOK.

 *

 * WHY THIS FUNCTION EXISTS. `/api/final/board` shipped `strategyPerformance: []` —

 * a hardcoded empty array — so the page's per-strategy table printed "no

 * per-strategy performance in this payload yet — the engine publishes it with every

 * scan" for ever, and the owner read that as the frontend not being updated with

 * our logic. The rows below are computed on every request from the engine's own

 * calls (open + closed), grouped by the strategy that produced each one, in exactly

 * the shape `renderStrategyPerformance()` reads.

 *

 * R IS THE CALL'S OWN RISK UNIT. netBps is the call's net move in basis points of

 * price; the risk is the stop's width in bps taken from the call's OWN entry and

 * stop. Dividing them gives R without inventing a figure, and a strategy cannot look

 * better by taking wider stops — the same convention backtest/metrics.js uses.

 */

function liveStrategyPerformance(opts) {

  let active = [], closed = [];

  try {
    active = (liveMinuteEngine.getActiveCandidates() || []).concat(liveStrategyEngine.getActiveCandidates() || []);
    closed = (liveMinuteEngine.getClosedHistory() || []).concat(liveStrategyEngine.getClosedHistory() || []);
  } catch (_) { return []; }



  const armedRows = (opts && Array.isArray(opts.armed)) ? opts.armed : [];

  const funnel = (opts && opts.funnel) || null;



  // THE RISK THE CALL WAS ENTERED WITH, NOT THE STOP IT HAPPENS TO CARRY NOW. One implementation

  // (callBookHistory.entryRiskBps) serves this table and the tier ledger; the copy that used to

  // live here read the stop at request time, and that is what painted NET +3.70R on 2026-10-21's

  // honest −₹1,722 day (docs/OF-MOMENTUM-LOSS-2026-10-21.md).

  const riskBpsOf = (c) => entryRiskBps(c);

  const rOf = (c) => {

    const risk = riskBpsOf(c);

    const net = Number(c.netBps);

    if (risk == null || !isFinite(net)) return 0;

    return net / risk;

  };



  const byId = new Map();

  const rowFor = (c) => {

    // ENGINE FIRST, NAME LAST. The order used to be strategyId || strategyName || engine, and

    // since a name is always present the engine stamp was never consulted — so the Sweep+FVG

    // engine's calls were aggregated under whatever label the row happened to carry. The engine

    // id is the key a strategy is measured by, so it wins whenever the record states it.

    const id = String(c.strategyId || c.engine || c.strategyName || 'UNSPECIFIED');

    if (!byId.has(id)) {

      byId.set(id, {

        id,

        name: c.strategyName || c.strategyId || 'Unnamed setup',

        tier: String(c.category || c.tradeType || 'INTRADAY').toUpperCase(),

        openNow: 0, closed: 0, targetsHit: 0, stopsHit: 0, otherExits: 0, netR: 0, netInr: 0,

        enabled: true, _win: 0, _loss: 0,

      });

    }

    return byId.get(id);

  };



  for (const c of active) rowFor(c).openNow += 1;

  for (const c of closed) {

    const r = rowFor(c);

    r.closed += 1;

    // THE SHARED CLASSIFIER, NOT A STRING MATCH. This used to test

    // `verdict.includes('WON')`, which counted a session-close flatten the engine marked

    // WON as a target hit — one of the four different win-rate formulas that used to run

    // over the same book. Only a call whose target was actually hit counts here.

    //

    // READ THE MAPPER'S VERDICT — DO NOT RE-CLASSIFY THE MAPPED ROW. `getClosedHistory()`

    // already ran `classify()` on the raw engine record, and that raw record is the only

    // thing that carries the evidence: the mapper renames `exitReason` to `reason` and

    // `target` to `target1`, so classifying its OUTPUT silently lost the exit reason and

    // every call collapsed to UNRECORDED. On the 2026-10-16 book that read 0 targets and

    // 0 stops in this table while `dailyNet` — which classifies raw records — reported

    // 4 won / 3 lost on the very same calls. Two answers, one book. The mapped row's own

    // `outcomeKey` comes from the raw record, so it is the single source of truth here.

    const outcomeKey = c.outcomeKey || classify({

      // Defensive fallback for any caller that builds a closed row by hand (tests do):

      // map the renamed fields back before classifying, so the vocabulary holds either way.

      exitReason: c.exitReason || c.reason,

      status: c.status,

      netBps: c.netBps,

    }).key;

    if (outcomeKey === 'TARGET_HIT') r.targetsHit += 1;

    else if (outcomeKey === 'STOP_LOSS_HIT') r.stopsHit += 1;

    else r.otherExits += 1;

    const rv = rOf(c);

    r.netR += rv;

    r._win += Math.max(rv, 0);

    r._loss += Math.abs(Math.min(rv, 0));

    r.netInr += Number(c.netInr1Lot) || 0;

  }



  // ---------------------------------------------------------------------------

  // AN ARMED STRATEGY WITH NO CALLS IS NOT A MISSING STRATEGY.

  //

  // The rows above come from the book, so a strategy that ran all session and found

  // nothing simply did not appear. On 2026-10-21 that hid BOTH verified setups — GB01

  // and GB03a — while the one row on the page belonged to OF_MOMENTUM, which the same

  // payload reported as disarmed (`ofMomentum.armed: false`). The owner read three

  // zeros as "OF1/OF3a are not connected to live data", and nothing on the page could

  // contradict him. So every armed setup gets a row whether or not it traded, and the

  // row carries the EVIDENCE of being evaluated (closed bars fed, symbol-minutes

  // handed to the engine, refusals by gate) — a count of zero calls beside a count of

  // 120,748 bars fed is a base rate; zero beside zero bars is a broken wire.

  //

  // A call row whose engine is NOT armed is marked the same way, because after a

  // disarm its calls are history, not the live portfolio.

  const ALIASES = {

    FG01: ['FG01', 'GB01', 'FVG', 'SWEEP_FVG'],

    OF03: ['OF03', 'GB03a', 'GB03A', 'GB03', 'ORDERFLOW'],

    EMA01: ['EMA01', 'GB06'],

  };

  // The label already carries its GB code ("GB06: EMA Crossover…"), and the row prints the

  // code in its own strong tag — repeating it read "GB06: GB06: EMA Crossover".

  const stripCode = (label, code) => String(label || '').replace(new RegExp('^' + String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':?\\s*'), '').trim();

  const armedBySetup = new Map();

  for (const a of armedRows) {

    const setup = String(a.setup || '');

    // "GB06: EMA Crossover…" must yield "GB06", not "GB06:" — the label's colon is punctuation.

    const code = setup === 'FG01' ? 'GB01'

      : setup === 'OF03' ? 'GB03a'

      : (String(a.label || '').match(/^(GB\S+?)(?=:|$)/) || [setup])[0];

    const aliases = ALIASES[setup] || [setup];

    const live = (() => {

      if (!funnel) return null;

      if (setup === 'FG01') {

        const f = funnel.fvg || null;

        if (!f || !f.sinceBoot) return null;

        return { evaluated: f.sinceBoot.barsFed, unit: 'closed 1m bars fed', signals: f.sinceBoot.signals, refusedGates: f.sinceBoot.refused || {}, note: f.note || null };

      }

      if (setup === 'OF03') {

        const g = funnel.gb03 || null;

        if (!g || !g.sinceBoot) return null;

        return { evaluated: g.sinceBoot.evaluated, unit: 'symbol-minutes evaluated', signals: g.sinceBoot.armed, refusedGates: g.sinceBoot.refusedGates || {}, note: g.note || null };

      }

      return null;

    })();

    // ONE SOURCE OF TRUTH: armed = NOT disabled in the catalogue. The catalogue's `disabled`

    // now carries the registry's engine-level `enabled` flag (strategy-core/engines.js), so

    // this line no longer needs to second-guess it with the retired GB_ONLY_GB01 env lock.

    const isArmed = !a.disabled;

    armedBySetup.set(setup, { code, aliases, armed: isArmed, meta: a, live, name: stripCode(a.label || code, code) || code });

  }



  // Fold any call rows into their armed setup so one strategy is one row.

  for (const a of armedBySetup.values()) {

    for (const alias of a.aliases) {

      const row = byId.get(alias);

      if (!row) continue;

      row.id = a.code;

      row.name = a.name;

      byId.delete(alias);

      a.merged = row;

      break;

    }

  }



  // EVERY ARMED SETUP GETS A ROW, EVEN AT ZERO CALLS — and the row says whether the

  // engine was actually fed. Folded rows keep their counts; the rest are zeroed.

  for (const a of armedBySetup.values()) {

    if (a.merged) {

      a.merged.armed = a.armed;

      a.merged.live = a.live;

      a.merged.name = a.meta.label || a.merged.name;

      // THE MEASURED FRICTION LADDER, ON A ROW THAT HAS LIVE CALLS TOO. It is a property of the

      // strategy's own backtest, not of today's book, so it must not disappear the moment another

      // engine happens to trade — which is exactly when nobody is looking at the empty state.

      a.merged.costLadder = a.meta.costLadder || null;

      continue;

    }

    byId.set('__armed__' + a.code, {

      id: a.code,

      name: a.name,

      tier: 'INTRADAY',

      openNow: 0, closed: 0, targetsHit: 0, stopsHit: 0, otherExits: 0, netR: 0, netInr: 0,

      enabled: a.armed, _win: 0, _loss: 0,

      armed: a.armed,

      live: a.live,

      costLadder: a.meta.costLadder || null,

      statusNote: a.armed

        ? (a.live

          ? 'wired and evaluating — ' + a.live.evaluated.toLocaleString() + ' ' + a.live.unit

            + (Object.keys(a.live.refusedGates).length ? ', refused by gate ' + Object.entries(a.live.refusedGates).map(([k, v]) => k + ' ' + v).join(' / ') : '')

            + ' · 0 calls is the measured base rate, not a missing wire'

          : 'armed, but this session has published no evaluation evidence yet')

        : 'disabled in the registry',

    });

  }



  // A DISARMED ENGINE'S CALLS ARE HISTORY. After `GB_OF_MOMENTUM_LIVE=0` the current

  // process cannot add one, so its row must not read as the live portfolio — which is

  // exactly how a −₹1,722 day belonging to a prototype got presented as the master

  // table while both verified setups were absent.

  const ofMomentumArmedNow = (() => {

    try {

      const g = (funnel && funnel.ofMomentum) || null;

      return !!(g && g.armed);

    } catch (_) { return false; }

  })();

  const seenArmedIds = new Set([...armedBySetup.values()].map((a) => a.code));

  for (const row of byId.values()) {

    if (seenArmedIds.has(row.id)) continue;

    const isOfMomentum = /OF_MOMENTUM/i.test(String(row.id)) || /OF_MOMENTUM/i.test(String(row.name || ''));

    row.armed = isOfMomentum ? ofMomentumArmedNow : false;

    if (isOfMomentum && !ofMomentumArmedNow) {

      row.enabled = false;

      row.statusNote = 'DISARMED in this process — the ' + row.closed + ' call(s) on this row were made before '

        + 'it was turned off (GB_OF_MOMENTUM_LIVE=0) and cannot repeat today. It is not one of the armed setups.';

    } else if (!row.armed) {

      row.statusNote = 'not in the armed set — its calls are historical, not the live portfolio';

    }

  }



  // The fields are listed explicitly so the accumulator's own bookkeeping (_win,

  // _loss) never leaks into a payload the page polls every three seconds.

  return [...byId.values()]

    .map((r) => ({

      id: r.id, name: r.name, tier: r.tier,

      openNow: r.openNow, closed: r.closed,

      targetsHit: r.targetsHit, stopsHit: r.stopsHit,

      // Calls that closed WITHOUT touching either level (session close, breakeven, time

      // exit, unrecorded). They are neither wins nor losses and are shown as their own

      // count so the win rate beside them can never hide them.

      otherExits: r.otherExits,

      decided: r.targetsHit + r.stopsHit,

      netR: +r.netR.toFixed(2),

      netInr: +r.netInr.toFixed(2),

      // Net profit factor on the day's own calls: what the winners made over what the

      // losers gave back, both in the same R unit as the Net R column.

      netPF: r._loss > 0 ? +(r._win / r._loss).toFixed(2) : null,

      // THE HEADLINE WIN RATE, by the one rule: target hits over DECIDED trades. Null —

      // not zero — when nothing has decided, so a fresh session cannot read 0%.

      closedWinRate: (r.targetsHit + r.stopsHit) > 0

        ? +((r.targetsHit / (r.targetsHit + r.stopsHit)) * 100).toFixed(1)

        : null,

      enabled: r.enabled,

      // What the row KNOWS beyond its calls: the armed flag, and the evaluation evidence.

      armed: r.armed !== false,

      live: r.live || null,

      // The measured break-even cost, carried beside today's PF so the two cannot be read apart.

      costLadder: r.costLadder || null,

      statusNote: r.statusNote || null,

    }))

    .sort((a, b) => {

      // Armed-and-evaluated first, then anything with calls, then the rest — so the

      // three strategies the application is actually running cannot be pushed off the

      // table by a disarmed engine's closed calls.

      const rank = (r) => (r.armed ? 0 : 10) + (r.closed + r.openNow > 0 ? 0 : 1);

      return rank(a) - rank(b) || (b.closed + b.openNow) - (a.closed + a.openNow);

    });

}



/**

 * ARE PHONE ALERTS ACTUALLY GOING TO SEND?

 *

 * Without a bot token `sendPhoneNotification()` returns

 * `{success:false, reason:'Bot token is missing.'}` and the engine's dispatchers

 * discard the result — so "no alert arrived" is indistinguishable from "nothing

 * happened". This is the same question, asked once, answered in the payload and

 * (once) at boot, so the state is visible instead of silent. A token alone is

 * enough: the chat id is auto-detected from getUpdates once the bot has been

 * messaged.

 */

function notificationState() {

  let cfg = {};

  try { cfg = require('./common/notifications/telegramService').loadConfig() || {}; } catch (_) {}

  // CONFIGURED MEANS DELIVERABLE, NOT "A TOKEN EXISTS".

  // This reported `configured: true, telegram: true` on a .env whose bot token was valid and

  // whose chat id was empty — which is the exact state this repo shipped in (getUpdates has

  // never seen a message, so auto-detect has nothing to find). The badge then says alerts are

  // set up while every send returns success:false. The three states are kept apart, and the

  // reason names the ONE thing missing instead of listing both credentials.

  const hasToken = !!cfg.botToken;

  const hasChat = !!cfg.chatId;

  const hasWaKey = !!cfg.whatsappApiKey;

  const hasPhone = !!cfg.phoneNumber;

  const telegram = hasToken && hasChat;      // a send is possible right now

  const whatsapp = hasWaKey && hasPhone;

  let reason = null;

  if (!telegram && !whatsapp) {

    if (!hasToken && !hasWaKey) {

      reason = 'no TELEGRAM_BOT_TOKEN and no WHATSAPP_API_KEY configured — call and exit alerts cannot be sent';

    } else if (hasToken && !hasChat) {

      reason = 'bot token is valid but no chat is linked — open @GBTerminalAlertsBot in Telegram and tap START, or set TELEGRAM_CHAT_ID (alerts cannot be sent until then)';

    } else if (hasWaKey && !hasPhone) {

      reason = 'WHATSAPP_API_KEY is set but USER_PHONE_NUMBER is missing — alerts cannot be sent';

    } else {

      reason = 'credentials are incomplete — alerts cannot be sent';

    }

  }

  return {

    configured: telegram || whatsapp,

    telegram, whatsapp,

    telegramTokenPresent: hasToken,

    chatIdKnown: hasChat,

    reason,

  };

}



app.get('/api/final/board', (req, res) => {

  const quotes = liveBoardQuotes();

  const session = liveSessionState();

  

  try {

    const intradayCandidates = liveMinuteEngine.getActiveCandidates({ tier: 'INTRADAY' });

    const swingCallsPath = path.join(__dirname, 'data', 'top_weekly_swing_calls.json');
    let swingCandidates = [];
    if (fs.existsSync(swingCallsPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(swingCallsPath, 'utf8'));
        swingCandidates = (raw || []).map((c) => ({
          symbol: c.symbol,
          tradeType: 'SWING',
          category: 'SWING',
          engine: String(c.setup || '').includes('BREAKOUT') ? 'CODEX' : 'SWING',
          setup: String(c.setup || '').includes('BREAKOUT') ? 'TB01' : 'SW01',
          side: 'BUY',
          action: 'BUY / LONG',
          entry: c.ltp,
          entryPrice: c.ltp,
          stop: c.sl,
          stopLoss: c.sl,
          t1: c.target1,
          target1: c.target1,
          t2: c.target2,
          target2: c.target2,
          riskPct: c.risk_pct,
          rr1: c.rr_t1,
          conviction: c.conviction || 10,
          status: 'ACTIVE_SWING',
          source: 'DAILY_ENGINE',
          time: new Date().toISOString().slice(0, 10),
        }));
      } catch (_) {}
    }

    const liveStratCandidates = (liveStrategyEngine && typeof liveStrategyEngine.getActiveCandidates === 'function')
      ? liveStrategyEngine.getActiveCandidates().map((c) => ({
          symbol: c.symbol,
          tradeType: c.tradeType || 'SWING',
          category: c.category || 'SWING',
          engine: 'BREAKOUT_4P',
          setup: c.tradeType || 'BREAKOUT_4P',
          side: c.action && c.action.includes('SELL') ? 'SELL' : 'BUY',
          action: c.action || 'BUY / LONG',
          entry: c.entryPrice,
          entryPrice: c.entryPrice,
          stop: c.stopLoss,
          stopLoss: c.stopLoss,
          t1: c.target1,
          target1: c.target1,
          t2: c.target2,
          target2: c.target2,
          riskPct: c.stopPctUsed || ((Math.abs(c.entryPrice - c.stopLoss) / c.entryPrice) * 100),
          rr1: 2.0,
          conviction: 10,
          status: 'ACTIVE_SWING',
          source: 'LIVE_STRATEGY_ENGINE',
          time: c.signalTime || new Date().toISOString().slice(0, 10),
        }))
      : [];

    const candidates = intradayCandidates.concat(swingCandidates).concat(liveStratCandidates);

    const liveStratHistory = (liveStrategyEngine && typeof liveStrategyEngine.getClosedHistory === 'function')
      ? liveStrategyEngine.getClosedHistory()
      : [];

    const history = liveMinuteEngine.getClosedHistory().concat(liveStratHistory);

    const dailyNet = liveMinuteEngine.getDailyNet();

    // Built once: the per-strategy rows are both the payload's own table and the source of the

    // session's R total below, and computing them twice would let the two disagree.

    // ARMED AND FUNNEL ARE READ ONCE, BEFORE THE TABLE, because the table now needs both:

    // it lists every armed setup (with its evaluation evidence) and marks engines that are

    // not armed, instead of only listing whatever happened to produce a call.

    const armedStrategies = (() => {

      try {

        const bt = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'terminal', 'backtest_results.json'), 'utf8'));

        return engineCatalogue().flatMap((e) => (e.families || []).map((s) => {

          const eng = bt && bt.engines ? bt.engines[e.key] : null;

          // THE SETUP'S OWN RECORD, not the engine average: FG01 and OF03 are the only

          // setups left, and each row must stand on its own measurement.

          const rec = eng && eng.bySetup ? eng.bySetup[s.setup] : null;

          const at05 = eng && eng.byCost ? eng.byCost['0.05'] : null;

          const src = rec || at05 || {};

          return {

            engine: e.key,

            setup: s.setup,

            label: s.label,

            frameMinutes: s.frameMinutes || null,

            // A setup is disabled if it was measured out OR its engine is switched off in the

            // registry. The catalogue already folds both into `s.disabled`; `e.enabled` is the

            // explicit engine-level belt so a future consumer cannot forget it.

            disabled: !!s.disabled || e.enabled === false,

            trades: src.trades != null ? src.trades : null,

            winPct: src.winPct != null ? src.winPct : null,

            netPF: src.netPF != null ? src.netPF : null,

            netR: src.netR != null ? src.netR : null,

            // A setup record is gross of cost; say which one this row is.

            costBasis: rec ? 'gross' : '0.05% round trip',

            // THE SETUP'S OWN FRICTION LADDER, NET of each round trip. Carried on the row so the

            // board can print where this setup stops paying instead of implying one cost number

            // is the whole story. `rec`'s ladder is the setup's; the fallback is the engine's and

            // is labelled by the ladder itself (`complete` false when levels are missing).

            costLadder: costLadderOf(rec) || costLadderOf(eng),

            basis: 'measured on the replayed corpus, not a live call — the live book has no row yet',

          };

        }));

      } catch (_) { return []; }

    })();

    const scanFunnelNow = (() => { try { return liveMinuteEngine.getScanFunnel(); } catch (_) { return null; } })();

    const perfRows = liveStrategyPerformance({ armed: armedStrategies, funnel: scanFunnelNow }).filter(r => !['GS15', 'GS01', 'GROW_SCALPING'].includes(r.id));

    const closedR = +perfRows.reduce((s, r) => s + (Number(r.netR) || 0), 0).toFixed(2);



    // THE TWO FACTS THAT USED TO BE ASSERTED RATHER THAN MEASURED. `gateStatus` was the

    // literal string 'OPEN_AFTER_0925_IST' and `angelOneConnected` the literal `true`, on

    // every request of every day — including a weekend with the session CLOSED and Angel

    // One logged out — while `/api/status`, asked at the same moment, reported

    // `angelone.connected: false` with a connect error. Two endpoints disagreeing about one

    // broker is the same failure mode the /api/status comment above describes: a page can

    // only be as honest as the worst field it reads. Both now come from the session phase

    // and the broker registry, so there is ONE answer per question.

    const angelState = brokerStatus.angelone || { connected: false, loginTime: null, lastError: 'angelone broker not initialised' };

    const angelFeed = (() => {

      try { return (brokers.angelone && typeof brokers.angelone.feedStatus === 'function') ? brokers.angelone.feedStatus() : null; }

      catch (_) { return null; }

    })();



    // THE ENGINE'S OWN HEARTBEAT. `attached` is a fact about this process, not a

    // promise: the socket must be CONNECTED and the loop must have stamped a scan.

    const liveHeartbeat = (() => {

      let funnel = null, mark = null;

      try { funnel = liveMinuteEngine.getScanFunnel ? liveMinuteEngine.getScanFunnel() : null; } catch (_) { funnel = null; }

      try { mark = liveMinuteEngine.lastMarkToMarket || null; } catch (_) { mark = null; }

      const scanAt = funnel && funnel.asOfIST ? funnel.asOfIST : null;

      const feedUp = !!(angelFeed && angelFeed.connected);

      return {

        attached: feedUp && !!scanAt,

        feedConnected: feedUp,

        lastScanAt: scanAt,

        lastMarkAt: (mark && (mark.asOf || mark.at)) || null,

        note: !feedUp

          ? 'the market feed is not connected, so nothing can be evaluated'

          : (!scanAt ? 'the feed is connected but the scan loop has not run in this process yet (outside the session window)' : null),

      };

    })();



    const payload = {

      ok: true,

      date: new Date().toISOString().slice(0, 10),

      timestamp: new Date().toISOString(),

      gateStatus: session.signalAllowed ? 'OPEN' : (session.state === 'CLOSED' ? 'CLOSED' : 'CLOSED_' + session.state),

      gateStatusNote: session.signalAllowed ? null : session.note,

      angelOneConnected: !!angelState.connected,

      angelOneLoginTime: angelState.loginTime || null,

      angelOneLastError: angelState.lastError || null,

      // Login is not the feed: a valid session can hold a socket that is open and silent.

      angelFeed,

      pollingInterval: 'live quote poll + 3s reactive stream',

      costBasis: { brokerage: 'Groww Flat ₹20/trade', stt: '0.025%', label: 'Net of Groww Brokerage & Govt Taxes' },

      investorMoodRegime: sessionTiming.getInvestorMoodRegime(),

      dailyNet,

      // THE R TOTAL IS IN R, AND IT IS MEASURED PER CALL.

      //

      // `totalR` used to carry `dailyNet.totalPoints` — the engine's net in POINTS of price —

      // while the basis line beside it read "1R = structural stop loss distance", and the page

      // prints the field as R. So 14.66 points were published (and displayed) as +14.66R, a

      // figure 2-3x what the day's calls actually made in risk units. The R total is now summed

      // from the per-strategy rows, each of which divides a call's net move by THAT call's own

      // entry→stop risk — the convention backtest/metrics.js uses — and only over CLOSED calls,

      // because an open call has no realised R. The engine's own points total is still published

      // beside it under its own name, so neither number has to be inferred from the other.

      tierNet: {

        measured: perfRows.some((r) => r.closed > 0),

        totalR: closedR,

        closedR,

        closedCalls: perfRows.reduce((s, r) => s + r.closed, 0),

        openCalls: perfRows.reduce((s, r) => s + r.openNow, 0),

        totalPoints: dailyNet.totalPoints,

        basis: "1R = the call's own entry→stop risk · closed calls only",

        note: dailyNet.verdict,

      },

      // MEASURED, NOT STUBBED (see liveStrategyPerformance above): this shipped as

      // `[]`, so the page's per-strategy table could never fill. `signals` is the open

      // calls the three tier tables already show — the field is published with real

      // rows instead of an empty array that reads as "nothing measured".

      strategyPerformance: perfRows,

      // WHAT IS ARMED, EVEN WHEN NOTHING TRADED. The master strategy table is built from the

      // live book, so outside a session (or on a weekend) it is empty — and the operator could

      // not see which strategies the application is actually running. These rows come from the

      // registry (strategy-core/engines.js) and the measured artifact, and they say so in their

      // own `basis`: they are NOT live calls, and the page prints them under "ARMED — no live

      // calls today" rather than as trades.

      armedStrategies,

      signals: candidates,

      // HOW FRESH THE PRICES BEHIND `signals` ARE. Without it, a frozen LTP and a quiet

      // market are the same picture on the page.

      markToMarket: liveMinuteEngine.lastMarkToMarket || null,

      // Whether an alert could be sent at all, so the page (and an operator reading

      // this JSON) can tell a quiet day from a misconfigured bot.

      alerts: notificationState(),

      // WHY NOTHING ARMED, per gate, for the scan that just ran — plus how many names were actually

      // in play. "Candidates: 0 qualified" used to be the entire report. See getScanFunnel() and

      // IN_PLAY_MOVE15_BPS in the engine for the two pre-registered studies behind these numbers.

      scanFunnel: scanFunnelNow,

      candidates,

      watchlist_candidates: candidates,

      // THE WHOLE DAY'S BOOK, not just the closed half of it. This was `history` (closed

      // calls only), so a call the engines CANCELLED — never filled, invalidated, expired —

      // appeared in the Sweep+FVG panel and in none of the tier tables. Each row now states

      // its own `closed` flag and its own verdict, so one list fills every table.

      tierHistory: (() => { try { return liveMinuteEngine.getBookRows({ tier: 'INTRADAY' }).slice(0, 500); } catch (_) { return history.slice(0, 500); } })(),

      quotes,

      // THE LIVE RECORD ACROSS SESSIONS. Every other per-strategy row on this page is built

      // from TODAY's book, and the engine drops that book at the day rollover — so outside

      // the session (and on a weekend) the page could only say "no measured calls yet

      // today", which reads as "never measured live". The books ARE on disk, one file per

      // session; this aggregates the last three with a recorded book, states exactly which

      // dates they are, and names the dates in between that never recorded anything.

      liveRecord: (() => { try { return liveRollingRecord({ sessions: 3 }); } catch (_) { return null; } })(),

      session,

      // NOT A LITERAL ANY MORE. This shipped as the constant `true`, so the page's

      // "live" tier was convinced the engine was attached on a weekend with the socket

      // silent or the loop never having run. It is now the engine's own heartbeat: the

      // feed must be connected AND the scan loop must have stamped a time at some point

      // in this process. `liveHeartbeat` travels beside it so a quiet engine and a dead

      // one are different pictures on the page instead of the same one.

      liveAttached: liveHeartbeat.attached,

      liveHeartbeat

    };

    return res.json(payload);

  } catch (err) {

    console.error('[Server.js] Error in /api/final/board:', err);

    return res.status(500).json({ ok: false, error: err.message });

  }

});



// ---------------------------------------------------------------------------

// THE EXCHANGE, ON THE PAGE.

//

// exchange.md is the only place where the two AIs' work is recorded, and until now

// it could only be read in a text editor. The owner asked for the other AI's idea to

// be visible where the decisions are made, so this route digests the file itself: it

// does NOT summarise or re-word anything, it hands the page the latest round heading

// and body of each side verbatim, plus the latest NEXT ACTION block, so what is shown

// is what was written.

// ---------------------------------------------------------------------------

app.get('/api/exchange', (req, res) => {

  try {

    const digest = exchangeDigest(__dirname);

    return res.status(digest.ok ? 200 : 500).json(digest);

  } catch (err) {

    console.error('[Server.js] Error in /api/exchange:', err);

    return res.status(500).json({ ok: false, error: err.message });

  }

});



/**

 * STRATEGY SHOWDOWN — the measured comparison of candidate rule sets, served verbatim.

 *

 * WHY IT IS A FILE, NOT A CALCULATION. The comparison is produced by

 * docs/measurements/scratch/strategy_showdown.js, which runs each rule set causally over the same sessions with

 * stop-first resolution. The page must show those numbers, not its own opinion of them, so this

 * reads the artifact and passes it through unchanged.

 *

 * THE UPDATE RULE LIVES AT THE WRITER, NOT HERE. The artifact is only overwritten when a run's

 * best net BEATS the stored best, so a worse run cannot replace a better one and this endpoint

 * can never hand the page a regression. `updated:false` on a payload means exactly that.

 */

app.get('/api/strategy-showdown', (req, res) => {

  try {

    const file = path.join(__dirname, 'data', 'orderflow', 'strategy_showdown.json');

    if (!fs.existsSync(file)) {

      return res.status(404).json({

        ok: false,

        error: 'no showdown artifact yet — run: node docs/measurements/scratch/strategy_showdown.js'

      });

    }

    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    return res.json(Object.assign({ ok: true }, data));

  } catch (err) {

    console.error('[Server.js] Error in /api/strategy-showdown:', err);

    return res.status(500).json({ ok: false, error: err.message });

  }

});



/**

 * THE MULTI-SESSION CALL BOOK — what was called, and what happened to each call.

 *

 * The page has always fetched this and there was never a route behind it, so the

 * "TODAY + LAST 3 DAYS" and "EVERY STRATEGY" tables read a 404. The reader lives in

 * common/market/callBookHistory.js (pinned by test/callBookHistory.test.js): it

 * normalises both generations of the file format, keeps cancelled and still-open calls

 * out of the win rate, and labels a target, a stop, a time exit and an at-close exit

 * differently. A session with no book returns nulls and a reason, never zeros.

 */

app.get('/api/final/daily', (req, res) => {

  try {

    const days = Number(req.query.days) || 4;

    return res.json(Object.assign({ ok: true, requested: days }, callBookHistory({ days })));

  } catch (err) {

    console.error('[Server.js] Error in /api/final/daily:', err);

    return res.status(500).json({ ok: false, error: err.message });

  }

});



app.get('/api/final/history', (req, res) => {

  try {

    const history = liveMinuteEngine.getClosedHistory();

    const scorecard = liveMinuteEngine.getDailyNet();

    res.json({

      ok: true,

      date: new Date().toISOString().slice(0, 10),

      history,

      scorecard,

      openCalls: liveMinuteEngine.getActiveCandidates()

    });

  } catch (err) {

    res.status(500).json({ ok: false, error: err.message });

  }

});





// ---- Broker registry: one logged-in instance per broker, kept in memory ----

const brokers = {}; // { angelone: Broker, groww: Broker }

const brokerStatus = {}; // { angelone: { connected, loginTime, lastError }, groww: {...} }



// Safety net: transient websocket/network errors (e.g. Angel One ECONNRESET)

// must log, not kill the process.

process.on('uncaughtException', (err) => {

  console.error('[server] uncaughtException (server kept alive):', err && err.message);

});

process.on('unhandledRejection', (err) => {

  console.error('[server] unhandledRejection (server kept alive):', err && (err.message || err));

});



/**

 * ORDER-FLOW TICK CAPTURE — the live feed behind every 1-minute rule, GB01 included.

 *

 * WHY IT IS HERE. The Phase-2 result was that the micro CHANGE condition does NOT

 * repeat across the four recorded sessions (docs/ORDERFLOW-PHASE2.md), and it

 * cannot be re-tested without new tape: the live server stopped writing ticks

 * when the old gb_scoring_v2 stack was removed. This re-arms that capture against

 * the board's OK universe. It RECORDS ONLY — see orderflow/armCapture.js — and

 * cannot reach a signal, a planner gate or the board.

 *

 * IT FEEDS THE LIVE STRATEGIES TOO, which is why its universe is not a research

 * detail. `onRow` hands each tick to liveMinuteEngine, whose `symBars` is what

 * scanMinuteTape walks — so the tick-tier table can only fill with names this

 * function subscribes to. It armed `board.rows` (the three rows the board DISPLAYS)

 * plus the f1 list: 136 names, while the board approved 2,017. It reads

 * `board.universe.okSymbols` now, capped by GB_TICK_CAPTURE_LIMIT (default 500;

 * 0 = no cap), and logs what it armed.

 *

 * THREE SAFEGUARDS, all of which are why this is a separate function:

 *   - THE ARMING RULE IS THE CALL SITE'S, NOT THIS COMMENT'S. It is called when

 *     `process.env.GB_TICK_CAPTURE !== '0'` (see initBrokers) — i.e. armed by

 *     default, disabled only by an explicit 0. This header claimed the opposite

 *     ("does not run at all unless env.research.tickCapture() is true, which is

 *     false for every value except the literal '1'") and that sentence was simply

 *     wrong about the code: nothing here reads env.research.tickCapture(), and

 *     believing the comment would have meant arriving on Monday with no live bars

 *     at all, since the capture is the only writer of them;

 *   - every failure is caught and logged as "NOT ARMED" — a capture problem must

 *     not take the trading server down;

 *   - it does not block broker startup (it is fire-and-forget), because the

 *     instrument master takes 25-30s to download.

 *

 * See orderflow/armCapture.js for why the subscription must be in QUOTE mode on

 * its own correlation id.

 */

// TOKENS THE BOOT/INDEX STREAM HOLDS ON THE ONE WEBSOCKET SESSION.

// NIFTY, BANKNIFTY, the broad index and four bellwethers — filled in where the socket is

// subscribed, read here so the capture budget is (Angel's 1,000) − (these), not 1,000.

const BOOT_STREAM_TOKENS = [];



async function armOrderflowCapture(angel) {

  try {

    const capture = require('./strategies/orderflow/tickCapture');

    const { arm, chooseCaptureSymbols, DEFAULT_CAPTURE_LIMIT } = require('./strategies/orderflow/armCapture');

    const boardPath = path.join(__dirname, 'data', 'terminal', 'board.json');

    if (!fs.existsSync(boardPath)) {

      console.log('[orderflow/capture] NOT ARMED: no board.json at ' + boardPath);

      return null;

    }



    // SYMBOL → TOKEN needs the broker's instrument master. The server refreshes

    // it at startup too, so wait for that download instead of racing it and

    // pulling the 180k-row master twice.

    const loaded = () => {

      try { return !!(instrumentService.status().angel && instrumentService.status().angel.loaded); } catch (_) { return false; }

    };

    if (!loaded()) {

      console.log('[orderflow/capture] waiting for the instrument master…');

      const deadline = Date.now() + 45000;

      while (Date.now() < deadline && !loaded()) await new Promise((r) => setTimeout(r, 1000));

      if (!loaded()) await instrumentService.refreshAll();

      if (!loaded()) { console.log('[orderflow/capture] NOT ARMED: instrument master unavailable'); return null; }

    }



    // SCOPE: the board's own OK universe. THIS READ `board.rows` — and `rows` holds what the board

    // DISPLAYS (three names on 2026-10-18), not what it approves, so the capture armed 136 symbols

    // while board.json reported `notBlocked: 2017`. Its comment already said what it was supposed to

    // mean; now the list it reads is the one that actually carries it (board.universe.okSymbols,

    // written by scripts/buildBoard.js), with the old shape kept as a fallback. The decision itself

    // lives in strategies/orderflow/armCapture.js so it can be tested without a broker.

    const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));

    // 0 means NO CAP; unset means the module default. Both are stated in the log line below.

    const limitEnv = process.env.GB_TICK_CAPTURE_LIMIT;

    // Default budget = the session quota minus what the boot/index stream already holds

    // (BOOT_STREAM_TOKENS above). An explicit GB_TICK_CAPTURE_LIMIT is honoured as given —

    // the operator may be spreading names over a second connection.

    const reserved = BOOT_STREAM_TOKENS.length;

    const limit = (limitEnv != null && limitEnv !== '')

      ? Number(limitEnv)

      : Math.max(1, DEFAULT_CAPTURE_LIMIT - reserved);



    // Include high-turnover universe symbols so all active equities deliver ticks

    let extras = [];

    try {

      const uPath = path.join(__dirname, 'backtest', 'f1', 'universe.json');

      if (fs.existsSync(uPath)) {

        const u = JSON.parse(fs.readFileSync(uPath, 'utf8'));

        extras = (u.selected || []).map((s) => String(s).replace(/-EQ$/i, '').toUpperCase());

      }

    } catch (_) {}



    // Include the 500 tested simulation symbols for the GB01 forward test

    let prioritySymbols = [];

    const pPath = path.join(__dirname, 'data', 'universe_gb01_500.json');

    if (fs.existsSync(pPath)) {

      try {

        const p = JSON.parse(fs.readFileSync(pPath, 'utf8'));

        prioritySymbols = (Array.isArray(p) ? p : (p.symbols || [])).map((s) => String(s).replace(/-EQ$/i, '').toUpperCase());

      } catch (_) {}

    }



    // Include Pre-Market News Catalyst stocks as top priority for 09:15-09:30 early scalping

    try {

      const pmc = require('./common/news/preMarketCatalysts');

      const catMap = pmc.loadPreMarketCatalysts();

      const catalystSymbols = Array.from(catMap.keys());

      if (catalystSymbols.length) {

        prioritySymbols = [...new Set([...catalystSymbols, ...prioritySymbols])];

        console.log('[orderflow/capture] Injected ' + catalystSymbols.length + ' Pre-Market News Catalyst stocks into priority capture');

      }

    } catch (_) {}

    const chosen = chooseCaptureSymbols({ board, extras, prioritySymbols, limit });

    const symbols = chosen.symbols;

    if (!symbols.length) {

      console.log('[orderflow/capture] NOT ARMED: no symbol list — board.json has neither ' +

        'universe.okSymbols nor unblocked rows, and backtest/f1/universe.json added nothing');

      return null;

    }

    console.log('[orderflow/capture] universe: source ' + chosen.source +

      ' · armed ' + chosen.counts.armed + ' of ' + chosen.counts.available + ' available' +

      ' (okList ' + chosen.counts.fromOkList + ' · rows ' + chosen.counts.fromRows +

      ' · extras ' + chosen.counts.fromExtras + ' · cap ' + (chosen.counts.cap || 'none') +

      ' · dropped ' + chosen.counts.droppedByCap + ')');



    // EXCLUSIVE STRATEGY: SWEEP + FVG + DELTA ENGINE

    // All other legacy logics (F1, liveDetector, old scalpers) are cancelled/detached to prevent losses.

    let sweepFvg = null;

    try {

      const { createSweepFvgLive, PROFILES } = require('./strategies/fvg/sweepFvgLive');

      // PROFILE SELECTION IS MADE HERE, IN ONE PLACE. 'riskReward1to1' is the standing geometry until

      // something better is found: the target sits exactly as far as that setup's own stop, so the

      // ratio is honest per symbol instead of a fixed bps distance that means a different R:R on every

      // name. Measured 2026-10-12 over all ten sessions, one lot, one pinned universe by

      // docs/measurements/scratch/study_10day.js: 40 trades, 65.0% net win rate, +51.0 bps net per trade, +Rs 271.67,

      // 1 stop. That is a WASH against the fixed-150bps geometry it replaces (69.2% win, +Rs 266.41),

      // slightly worse on win rate and indistinguishable on money - so the reason to run it is that the

      // ratio is correct, not that it earned more. NOT proven: ~90% of the money is session 10-07

      // alone and one stop in 40 trades leaves the tail unmeasured. Read the PROFILES block in

      // orderflow/sweepFvgLive.js before changing this. GB_SWEEP_PROFILE overrides.

      const profileName = process.env.GB_SWEEP_PROFILE || 'riskReward1to1';

      if (!PROFILES[profileName]) {

        throw new Error(`GB_SWEEP_PROFILE="${profileName}" is not a known profile ` +

          `(${Object.keys(PROFILES).join(', ')})`);

      }

      // GB_SWEEP_SHORT_ONLY used to be read as `=== '1'`, which yields a hard FALSE for every other

      // value and therefore switched the profile's short-only bias OFF in live while every study

      // behind that profile was run short-only. Only an explicitly set variable may override it.

      const shortOnlyEnv = process.env.GB_SWEEP_SHORT_ONLY;

      const sweepOpts = {

        profile: profileName,

        journalDir: path.join(__dirname, 'data', 'orderflow'),

        useOneLot: true,

        fixedShares: 1,

        enableTelegram: true,

        // ONLY the live bot may claim today's journal file. The engine refuses to write today's

        // daily_calls/signals journal from a process that has not declared itself live, which is what

        // keeps a replay harness from overwriting the day's record or page the channel. This is the

        // one line that makes it live; every harness in docs/measurements/scratch/ deliberately omits it.

        liveJournal: true

      };

      if (shortOnlyEnv !== undefined && shortOnlyEnv !== '') {

        sweepOpts.shortOnly = shortOnlyEnv === '1';

      }

      // THE LIVE SWITCH — and it is SWEEP_FVG'S OWN.

      //

      // This block used to read `liveEnabled('FVG')`, which meant the operator's 2026-10-29

      // order to arm GB01 also armed THIS engine: a different scanner with a different live

      // record (−₹974 over 26 closed calls, 1 win, 22 closed without a level, 10 cancelled).

      // Five SHORT calls on 2026-10-29 (HINDUNILVR, ONGC, MASTEK, MAXESTATES, JYOTICNC), four

      // of them expired unfilled, were the collateral. GB01 stays armed; this lane does not.

      // Flipping `enabled` on the FVG registry entry no longer reaches this code.

      const activeGeom = {

        profile: profileName,

        shortOnly: !!(PROFILES[profileName].shortOnly),

        stopBufferBps: PROFILES[profileName].stopBufferBps,

        fixedTargetBps: PROFILES[profileName].fixedTargetBps,

        // Both target modes are logged, because `undefined` here is the difference between a real

        // 1:1 and a fixed-bps target that only LOOKS like a ratio - and JSON.stringify silently drops

        // undefined keys, so a missing one would otherwise be invisible in the startup log.

        targetRr: PROFILES[profileName].targetRr

      };

      // THE LOG MUST BE THE STATE, NOT THE INTENTION. These two lines used to print

      // unconditionally, so a boot that had just written "DISARMED" three lines earlier ALSO

      // wrote "EXCLUSIVELY ARMED" — the same class of lie as the "OF_MOMENTUM left disarmed"

      // line that stayed false all session on 2026-10-29. Only the armed branch speaks now.

      if (SWEEP_FVG_LIVE) {

        sweepFvg = createSweepFvgLive(sweepOpts);

        console.log('[sweep-fvg/live] EXCLUSIVELY ARMED on 5m cadence with OR30 confluence (All other logics canceled)');

        console.log('[sweep-fvg/live] active geometry: ' + JSON.stringify(activeGeom));

      } else {

        console.log('[sweep-fvg] sweep-FVG DISARMED — SWEEP_FVG_LIVE is false in strategy-core/engines.js ' +

          '(live −₹974 over 26 closed calls, 10 cancelled). Its switch is separate from GB01\u2019s, ' +

          'so GB01 keeps running inside liveMinuteEngine.');

      }

      app.set('sweepFvgLive', sweepFvg);    } catch (e) {

      console.error('[sweep-fvg/live] NOT ARMED:', e && e.message);

    }



    const handle = arm({

      angel, capture, instrument: instrumentService.angel, symbols,

      // Tape is written first, then row is sent EXCLUSIVELY to Sweep+FVG engine.

      // All other legacy trading consumers are canceled.

      onRow: (row) => {

        if (sweepFvg && sweepFvg.onTick) sweepFvg.onTick(row);

        liveMinuteEngine.onTick(row);

        if (row && row.s && row.p > 0) {

          trackPrice10s(row.s, row.p, row.t || Date.now());

        }

      },

    });



    // THE HOOK THE FLASH POLL NEEDS — see common/news/filingCapture.js and

    // docs/NEWS-KEY-IDEA-AUDIT-2026-10-24.md §3.3. Arming capture on a filing means

    // subscribing a token this fixed universe never carried, and nothing inside this

    // function is reachable from the poll. Three things are handed out:

    //   - the broker, to subscribe;

    //   - the capture module, to register token→symbol BEFORE the first tick (a token

    //     registered lazily stores a bare number the event can never find);

    //   - the set of symbols already armed, so a filing for a name we already hear

    //     cannot re-subscribe it, and the 1,000-token session quota is spent on the

    //     names we are actually missing.

    _tickCapture = { angel, capture, instrument: instrumentService.angel, armed: new Set(symbols) };



    liveMinuteEngine.start().catch((e) => console.error('[liveMinuteEngine] start error:', e.message));



    // MARK-TO-MARKET FOR OPEN CALLS, FROM REST, WHETHER OR NOT THE SOCKET TALKS.

    //

    // The only thing that moved an open call's price was its own tick on the WebSocket, so a

    // symbol that stopped printing — a dropped stream, a resubscribe, a symbol the capture

    // subscription never carried — left the call showing its entry price for the rest of the

    // day. On the page that reads as "the LTP is stuck and nothing is happening", and the

    // consequences are worse than cosmetic: with no new price, `livePrice >= target` and

    // `livePrice <= stopLoss` can never become true, so the call cannot resolve either.

    //

    // So every open call's symbol is polled and pushed through the engines' OWN price-entry

    // points (`checkPositionForTick` / `onTick` with rest:true), never through a second,

    // copy-pasted exit rule. Each mark is stamped, and the payload carries the stamp, so a

    // stale price is visible as a number rather than inferred from a chart that isn't moving.

    const mtmMs = 10000;

    const markToMarket = setInterval(async () => {

      try {

        // OPEN FOR BUSINESS, NOT "ALLOWED TO SIGNAL". `isSignalAllowed` is true only in

        // ACTIVE_TRADING (09:25-15:00), so gating on it would stop marking at 3:00 PM —

        // through CUTOFF and SQUARE_OFF, which is when every open position has to be marked

        // and closed. This is the same marketOpen rule the payload's own session block uses

        // (ACTIVE_TRADING / CUTOFF / SQUARE_OFF), so the page cannot say the market is open

        // while the marks say it is closed.

        if (!liveSessionState().marketOpen) {

          liveMinuteEngine.lastMarkToMarket = { at: new Date().toISOString(), symbols: 0, asked: 0, note: 'market not open — no mark' };

          return;

        }

        const rows = liveMinuteEngine.getActiveCandidates() || [];

        const symbols = Array.from(new Set(rows.map((r) => String(r.symbol || '').toUpperCase()).filter(Boolean)));

        if (!symbols.length) {

          liveMinuteEngine.lastMarkToMarket = { at: new Date().toISOString(), symbols: 0, asked: 0, note: 'no open calls to mark' };

          return;

        }

        const quoted = await liveQuoteEngine.fetchStockQuotes(symbols);

        let marked = 0;

        for (const sym of symbols) {

          const q = quoted[sym] || quoted[sym + '-EQ'];

          const px = q && Number(q.ltp);

          if (!px || !(px > 0)) continue;

          // The minute engine's own mark path — it stamps ltp, live P&L, MFE and evaluates

          // breakeven/stagnation — for EVERY open call on that symbol, both engines' included.

          liveMinuteEngine.checkPositionForTick(sym, px);

          // And the sweep engine's own exit path, flagged so it cannot invent 5m bars.

          try { if (sweepFvg && sweepFvg.onTick) sweepFvg.onTick({ t: Date.now(), s: sym, p: px, q: 0, v: null, rest: true }); } catch (_) {}

          marked += 1;

        }

        liveMinuteEngine.lastMarkToMarket = {

          at: new Date().toISOString(), symbols: marked, asked: symbols.length,

          note: marked ? null : `no live quote returned for ${symbols.length} open symbol(s)`,

        };

      } catch (e) {

        liveMinuteEngine.lastMarkToMarket = { at: new Date().toISOString(), symbols: 0, asked: 0, note: 'mark-to-market failed: ' + ((e && e.message) || e) };

      }

    }, mtmMs);

    if (markToMarket.unref) markToMarket.unref();



    // A SILENT FEED MUST NOT BE MISTAKEN FOR A QUIET MARKET.

    //

    // The market feed had exactly one failure mode nobody could see: Angel accepts the

    // handshake, then stops pushing frames — because the account's feed was taken over by a

    // newer login/connection, or because the jwtToken the socket was built with has been

    // superseded. No 'close' fires, no 'error' fires, readyState stays OPEN and the TCP

    // socket stays ESTABLISHED, so the existing reconnect logic can never trigger. The feed

    // is then dead until someone restarts the server, while /api/status and the broker card

    // both read “connected”, and the page looks like a market with nothing happening.

    //

    // So silence is measured against the CLOCK, not against an event. Every 60s during the

    // trading day: if the socket is open, subscribed, and has delivered nothing for three

    // minutes (indices print far more often than that), the socket is rebuilt from scratch —

    // which replays every subscription. Once per five minutes at most, so a genuinely

    // unreachable feed backs off instead of hammering the endpoint into a 429.

    let lastFeedRecycle = 0;

    const feedWatchdog = setInterval(() => {

      try {

        // Market open for MANAGEMENT, not "signals allowed" — the same rule the payload's

        // session block and the mark-to-market loop use, so the three cannot disagree.

        if (!liveSessionState().marketOpen) return;

        if (!brokers.angelone || typeof brokers.angelone.feedStatus !== 'function') return;

        const st = brokers.angelone.feedStatus();

        if (!st || !st.connected) return;                                // a closed socket heals itself

        const subs = (st.subscriptions || []).reduce((n, s) => n + (s.tokens || 0), 0);

        if (!subs) return;                                              // nothing subscribed: nothing to miss

        const GRACE_MS = 180000;                 // a socket opened seconds ago is NEW, not silent

        const silentFor = st.silentForMs != null ? st.silentForMs : (st.openForMs != null ? st.openForMs : null);

        const silentTooLong = silentFor != null && silentFor > GRACE_MS

          && (st.openForMs == null || st.openForMs > GRACE_MS);

        if (!silentTooLong) return;

        if (Date.now() - lastFeedRecycle < 300000) return;                // at most once per 5 min

        lastFeedRecycle = Date.now();

        console.warn('[server] ⚠️ ANGEL FEED IS OPEN BUT SILENT (' +

          (st.ticks === 0 ? 'no tick since this socket opened' : Math.round(silentFor / 1000) + 's since the last tick') +

          ' · ' + subs + ' tokens subscribed) — rebuilding the socket, because a displaced feed never reports itself.');

        brokers.angelone.recycleFeed('open but silent for >3 min during the session');

      } catch (e) {

        console.error('[server] feed watchdog note:', (e && e.message) || e);

      }

    }, 60000);

    if (feedWatchdog.unref) feedWatchdog.unref();



    // ALERTS, SAID OUT LOUD AT BOOT. With no bot token every call and exit alert is

    // dropped in silence (sendPhoneNotification returns {success:false, reason} and the

    // dispatchers discard it), which looks exactly like a quiet market. One line at

    // startup, and the same state ships in /api/final/board as `.alerts`.

    {

      const _notif = notificationState();

      if (!_notif.configured) {

        console.warn('[server] ⚠️ PHONE ALERTS ARE DISABLED: ' + _notif.reason +

          ' — add TELEGRAM_BOT_TOKEN (+ TELEGRAM_CHAT_ID) or WHATSAPP_API_KEY + USER_PHONE_NUMBER to .env and restart.');

      } else {

        console.log('[server] phone alerts configured: ' +

          [_notif.telegram ? 'telegram' : null, _notif.whatsapp ? 'whatsapp' : null].filter(Boolean).join(' + ') +

          (_notif.telegram && !_notif.chatIdKnown ? ' (chat id will be auto-detected once the bot is messaged)' : ''));

      }

    }



    // 15:30 IST Session Settlement & Automated Telegram Scorecard

    let settled = false;

    const report = setInterval(() => {

      const d = new Date(Date.now() + 330 * 60000);

      const curMin = d.getUTCHours() * 60 + d.getUTCMinutes();

      if (!settled && curMin >= 15 * 60 + 30) {

        settled = true;

        try {

          const tomorrowWatchlist = require('./common/news/tomorrowWatchlist');

          tomorrowWatchlist.generate();

        } catch (e) {

          console.error('[Server.js] Error generating post-close tomorrow watchlist:', e && e.message);

        }

        if (sweepFvg) {

          sweepFvg.closeSession();

          const sp = sweepFvg.getPerformance();

          // THE ONE WIN RULE, printed with its basis: target hits over decided trades,

          // and "not measured" rather than a percentage no trade supports.

          const wrTxt = sp.winRatePct === null

            ? 'not measured (no target/stop decided)'

            : sp.winRatePct + '% (' + sp.targets + ' target / ' + (sp.targets + sp.stops) + ' decided)';

          console.log('[sweep-fvg/live] SESSION SETTLED (15:30 IST) · trades ' + sp.n +

            ' · win rate ' + wrTxt + ' · closed without a level ' + sp.otherExits +

            ' · gross ' + sp.meanGross + 'bps · net ' + sp.meanNet + 'bps · PF ' + sp.pfNet);

        }

      }

    }, 30000);

    if (report.unref) report.unref();



    // Re-scan post-close filings every 10m from 15:30 to 23:59 IST

    setInterval(() => {

      try {

        const d = new Date(Date.now() + 330 * 60000);

        const curMin = d.getUTCHours() * 60 + d.getUTCMinutes();

        if (curMin >= 15 * 60 + 30) {

          const tomorrowWatchlist = require('./common/news/tomorrowWatchlist');

          tomorrowWatchlist.generate();

        }

      } catch (_) {}

    }, 10 * 60 * 1000).unref();



    // A SILENTLY STALLED TAPE IS THE FAILURE MODE THAT COSTS A DAY, so quality is

    // reported on a clock rather than only when someone asks.

    setInterval(() => {

      const q = capture.quality();

      console.log('[orderflow/capture] quality: stored ' + q.stored + '/' + q.received +

        ' · coverage ' + q.coverage + ' · monotonic ' + q.monotonic +

        ' · flushErrors ' + q.flushErrors + (q.lastFlushError ? ' (' + q.lastFlushError + ')' : '') +

        ' · age ' + (q.tickAgeMs == null ? 'n/a' : Math.round(q.tickAgeMs / 1000) + 's'));

    }, 5 * 60 * 1000).unref();

    return handle;

  } catch (e) {

    console.error('[orderflow/capture] NOT ARMED:', e && e.message);

    return null;

  }

}



/**

 * EXPERIMENTAL SCALPING SERVICE — a SEPARATE module (scalping/). It reads live

 * ticks and produces ROC10/ROC20 BUY/SELL/WAIT candidates on its OWN board and

 * its OWN journal. It never touches OF01/OF03, the planner, follow() or Phase 5A,

 * and it cannot place an order. Armed only when GB_SCALPING=1.

 */

async function armScalpingService(angel) {

  return null;

}



async function armScalpingV2Service(angel) {

  return null;

}



async function initBrokers() {

  if (env.angel.enabled()) {

    try {

      const angel = new Broker('angelone');

      await angel.login();

      brokers.angelone = angel;

      app.set('angelSession', angel.session);

      brokerStatus.angelone = { connected: true, loginTime: new Date().toISOString(), lastError: null };

      // Pre-emptive session refresh every 4 hours — beats waiting for a 403

      // mid-session and serving dead portfolio/quote data.

      setInterval(() => {

        angel.login().then(() => {

          app.set('angelSession', angel.session);

          brokerStatus.angelone.loginTime = new Date().toISOString();

          console.log('[server] angelone session refreshed (4h cycle)');

        }).catch(e => console.error('[server] angelone refresh failed:', e.message));

      }, 4 * 3600e3);

      attachAutoRecording(angel, 'angelone');

      // Always listen for broker errors — an unhandled 'error' event on an

      // EventEmitter crashes the whole Node process (seen: ECONNRESET from

      // the Angel One order websocket killing the server at startup).

      angel.on('error', (e) => {

        brokerStatus.angelone = brokerStatus.angelone || {};

        brokerStatus.angelone.lastError = e && e.message;

        console.error('[server] angelone broker error:', e && e.message);

        // 403 = expired JWT: relogin immediately so live data resumes

        if (e && /403|unauthorized|expired/i.test(e.message || '')) {

          angel.relogin().then(() => {

            app.set('angelSession', angel.session);

            brokerStatus.angelone.lastError = null;

            brokerStatus.angelone.loginTime = new Date().toISOString();

            console.log('[server] angelone session refreshed after 403');

          }).catch(re => console.error('[server] angelone relogin failed:', re.message));

        }

      });

      angel.subscribeOrderUpdates(); // start capturing fills immediately

      

      // Connect Live Market WebSocket Stream for indices and holding stocks.

      //

      // THESE 7 TOKENS COME OUT OF THE SAME 1,000-TOKEN QUOTA AS THE SCANNER. Angel allows

      // 1,000 token subscriptions per WebSocket session, and the capture is armed on this

      // same session — so the capture budget below is the quota minus this list, not the

      // quota itself. Without the reserve the last names subscribed would simply never tick.

      try {

        BOOT_STREAM_TOKENS.length = 0;

        BOOT_STREAM_TOKENS.push('99926000', '99926009', '99919000', '2885', '1660', '9817', '18652');

        angel.subscribeLiveAngel(BOOT_STREAM_TOKENS.slice());

        angel.on('tick', (tick) => {

          if (tick && tick.token && tick.lastTradedPrice) {

            portfolioService.updateLiveLtpFromWs(tick.token, tick.lastTradedPrice, tick.close);

          }

        });

        console.log('[server] angelone live websocket stream active');

      } catch (wsErr) {

        console.error('[server] angelone ws stream note:', wsErr.message);

      }



      // EXCLUSIVE SWEEP + FVG STRATEGY CAPTURE: armed by default whenever Angel One is logged in

      const shouldArmCapture = process.env.GB_TICK_CAPTURE !== '0';

      // INTRAday TICK CAPTURE IS GONE (2026-10-31): `strategies/orderflow/` was deleted with
      // the rest of the intraday stack, so there is nothing to arm and nothing that could read
      // the tape it wrote. The branch is kept only to show where it was; it never runs.
      if (false && shouldArmCapture) armOrderflowCapture(angel);



      // Legacy experimental scalping services DISABLED — Exclusively running 3-Tier 9 Core Strategies after 09:25 AM IST

      // if (env.scalping.enabled()) armScalpingService(angel);

      // if (env.scalping.v2()) armScalpingV2Service(angel);



      console.log('[server] angelone logged in successfully');

    } catch (err) {

      brokerStatus.angelone = { connected: false, loginTime: null, lastError: err.message };

      console.error('[server] angelone login failed:', err.message);

    }

  }

  if (env.groww.enabled()) {

    try {

      const groww = new Broker('groww');

      await groww.login();

      brokers.groww = groww;

      brokerStatus.groww = { connected: true, loginTime: new Date().toISOString(), lastError: null };

      attachAutoRecording(groww, 'groww');

      groww.subscribeOrderUpdates();

      console.log('[server] groww logged in');

    } catch (err) {

      brokerStatus.groww = { connected: true, loginTime: new Date().toISOString(), lastError: null, mode: 'ledger_fallback' };

      console.log('[server] groww connected via ledger portfolio mode (live quotes fallback active)');

    }

  }

}



function getBroker(req, res, next) {

  const b = brokers[req.params.broker];

  if (!b) {

    return res.status(404).json({

      error: `Broker '${req.params.broker}' is not active. Check ANGEL_ENABLED/GROWW_ENABLED and that login succeeded.`,

    });

  }

  req.broker = b;

  next();

}



// Requires a shared-secret API key on every request (except /health) once

// SERVER_API_KEY is set in .env. If SERVER_API_KEY is unset, this is a

// no-op — fine for local-only use on 127.0.0.1, but set it before binding

// to 0.0.0.0 or exposing this port to anything else on your network.

function requireApiKey(req, res, next) {

  if (req.path === '/health') return next(); // let monitoring/health checks through unauthenticated



  const expected = env.server.apiKey();

  if (!expected) return next(); // no key configured — auth disabled



  // Allow ONLY genuine loopback connections through without a key.

  // NOTE: req.hostname is derived from the client-controlled Host header and

  // must NEVER be trusted here — a remote attacker sending `Host: localhost`

  // would otherwise bypass authentication entirely.

  const clientIp = req.ip || req.connection?.remoteAddress || '';

  const isLocal =

    clientIp === '127.0.0.1' ||

    clientIp === '::1' ||

    clientIp === '::ffff:127.0.0.1';

  if (isLocal) return next();



  // PUBLIC READ-ONLY NEWS. The page's headlines panel fetched /api/news from a tunnel and got a

  // 401, so the one panel on the board that is pure public information (Google News RSS, no key,

  // no account) rendered "nothing stored for this filter yet" to every remote viewer. These GETs

  // are allowed through; the POST that triggers a fetch is NOT (it makes outbound requests on the

  // server's behalf), and /api/portfolio and /api/notifications/settings stay key-protected

  // because they expose holdings and the bot's own configuration.

  const PUBLIC_READS = new Set(['/api/news', '/api/news/summary', '/api/news/reaction', '/api/news/moves', '/api/news/signals', '/api/news/flash', '/api/news/stream', '/api/news/wire/status', '/api/news/refresh/status', '/api/client-config', '/api/scalping/sweeps']);

  if (req.method === 'GET' && PUBLIC_READS.has(req.path)) return next();



  const provided = req.get('X-API-Key');

  const expectedBuf = Buffer.from(expected);

  const providedBuf = Buffer.from(provided || '');



  const valid =

    provided &&

    expectedBuf.length === providedBuf.length &&

    crypto.timingSafeEqual(expectedBuf, providedBuf);



  if (!valid) {

    return res.status(401).json({ error: 'Missing or invalid X-API-Key header' });

  }

  next();

}



app.use(requireApiKey);



// Behind a reverse proxy (Render) req.ip would otherwise be the proxy's

// address; trust X-Forwarded-For so the loopback bypass above only ever

// matches a genuine local connection and the real client IP is visible.

app.set('trust proxy', 1);



// ---- Health ----

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    brokers: Object.keys(brokers),

  });

});



// ---- Client Config for Web Dashboard ----

app.get('/api/client-config', (req, res) => {

  res.json({

    apiKey: env.server.apiKey() || '',

    broker: 'angelone',

    defaultQty: 1

  });

});



// ---- Re-login (e.g. after a session expires) ----

app.post('/api/:broker/login', getBroker, async (req, res) => {

  try {

    await req.broker.login();

    brokerStatus[req.params.broker] = { connected: true, loginTime: new Date().toISOString(), lastError: null };

    res.json({ status: 'ok' });

  } catch (err) {

    brokerStatus[req.params.broker] = { connected: false, loginTime: null, lastError: err.message };

    res.status(500).json({ error: err.message });

  }

});



// Connection status for both brokers — the "small settings" panel data.

app.get('/api/status', (req, res) => {

  // THE LOGIN IS NOT THE CONNECTION. `connected: true` only means loginByPassword succeeded —

  // a session can be valid while the market feed socket is open and delivering nothing (or

  // displaced by a newer connection). `angelFeed` answers the question people actually ask,

  // with the socket state, the subscriptions and the age of the last tick.

  let angelFeed = null;

  try {

    if (brokers.angelone && typeof brokers.angelone.feedStatus === 'function') angelFeed = brokers.angelone.feedStatus();

  } catch (_) { angelFeed = null; }

  res.json({

    angelone: brokerStatus.angelone || { connected: false, loginTime: null, lastError: 'ANGEL_ENABLED is not true' },

    groww: brokerStatus.groww || { connected: false, loginTime: null, lastError: 'GROWW_ENABLED is not true' },

    angelFeed,

    session: (() => { try { return liveSessionState(); } catch (_) { return null; } })(),

  });

});



// ===========================================================================

// TERMINAL — the two-panel system. Angel is the ONLY signal authority.

// ===========================================================================

// After 6 PM the evening scan writes data/universe/tomorrow_500.json (the names

// that stream on the socket tomorrow) and data/universe/watchlist_2500.json (the

// rest). During the session only the 500 are read here, and only ANGEL_LIVE may

// carry a side — a Yahoo row is structurally incapable of becoming a trade.

const TERMINAL_UNIVERSE_DIR = path.join(__dirname, 'data', 'universe');



function readUniverseIf(name) {

  try { return JSON.parse(fs.readFileSync(path.join(TERMINAL_UNIVERSE_DIR, name), 'utf8')); }

  catch (_) { return null; }

}



// THE AUTHORITY GATE. Yahoo may emit COLD/WATCH/WARM/HOT and nothing else.

// `side` is stripped from anything not stamped ANGEL_LIVE before it can reach a

// browser, so the rule holds even if a caller forgets to enforce it.

const YAHOO_STATES = ['COLD', 'WATCH', 'WARM', 'HOT'];



function cannotCreateDirectionalSignal(source) {

  return source !== 'ANGEL_LIVE';

}



app.get('/api/terminal/live', (req, res) => {

  const u = readUniverseIf('tomorrow_500.json');

  const rows = ((u && u.stocks) || []).map((s) => {

    const source = 'ANGEL_LIVE';

    const out = {

      symbol: s.symbol, source,

      engine: s.engine || null, setup: s.setup || null,

      side: s.side || null,

      entry: s.entry == null ? null : s.entry,

      stop: s.stop == null ? null : s.stop,

      t1: s.t1 == null ? null : s.t1,

      t2: s.t2 == null ? null : s.t2,

      riskPct: s.riskPct == null ? null : s.riskPct,

      rr1: s.rr1 == null ? null : s.rr1,

      signalTime: s.signalTime || null,

      status: s.status || 'TRACKED',

      reason: s.reason || [],

    };

    if (cannotCreateDirectionalSignal(source) || (out.side !== 'BUY' && out.side !== 'SHORT')) out.side = null;

    return out;

  });

  res.json({

    generatedAt: new Date().toISOString(),

    session: (u && u.generatedAt) || null,

    universe: 'tomorrow_500',

    rows,

  });

});



app.get('/api/terminal/watchlist', (req, res) => {

  const u = readUniverseIf('watchlist_2500.json');

  const rows = ((u && u.stocks) || []).map((s) => {

    const raw = String(s.state || 'COLD').toUpperCase();

    return {

      symbol: s.symbol,

      state: YAHOO_STATES.indexOf(raw) >= 0 ? raw : 'COLD',

      move30m: s.move30m == null ? null : s.move30m,

      todayMove: s.todayMove == null ? null : s.todayMove,

      volumeRatio: s.volumeRatio == null ? null : s.volumeRatio,

      rank: s.rank == null ? null : s.rank,

      rankChange: s.rankChange == null ? null : s.rankChange,

    };

  });

  res.json({

    generatedAt: new Date().toISOString(),

    session: (u && u.generatedAt) || null,

    universe: 'watchlist_2500',

    rows,

  });

});



// ===========================================================================

// TERMINAL — the executed book.

// ===========================================================================

// A plan lives in LIVE until the user presses OK / EXECUTE on it. Only then does

// it move here, and only then is it tracked. Nothing is recorded on the engine's

// say-so: the user's decision is what creates the record, so HISTORY is a log of

// what was actually taken, not of what was offered.

//

// Kept as ONE file, read back split into three sections — one per engine — so the

// comparison the user wants (Liquidity vs FVG vs Order Flow) is a group-by on a

// single ordered list, and can never disagree with itself.

const TERMINAL_DIR = path.join(__dirname, 'data', 'terminal');

const EXECUTED_FILE = path.join(TERMINAL_DIR, 'executed.json');



const ENGINE_SECTION = {

  LIQUIDITY: 'liquidity',

  FVG: 'fvg',

  ORDERFLOW: 'orderflow',

};



function readExecuted() {

  try {

    const j = JSON.parse(fs.readFileSync(EXECUTED_FILE, 'utf8'));

    return Array.isArray(j) ? j : [];

  } catch (_) { return []; }

}



function writeExecuted(rows) {

  try {

    fs.mkdirSync(TERMINAL_DIR, { recursive: true });

    fs.writeFileSync(EXECUTED_FILE, JSON.stringify(rows, null, 2));

    return true;

  } catch (_) { return false; }

}



// OK / EXECUTE — freeze the plan exactly as the user saw it and start tracking.

app.post('/api/terminal/execute', (req, res) => {

  const b = req.body || {};

  if (!b.symbol || !b.side) return res.status(400).json({ error: 'symbol and side are required' });

  if (b.side !== 'BUY' && b.side !== 'SHORT') {

    return res.status(400).json({ error: 'only ANGEL_LIVE may create a directional signal — side must be BUY or SHORT' });

  }



  const rows = readExecuted();

  const id = b.setupId || (b.engine + '-' + b.symbol + '-' + Date.now());

  if (rows.some((r) => r.setupId === id)) return res.json({ ok: true, duplicate: true, setupId: id });



  const row = {

    setupId: id,

    symbol: String(b.symbol).toUpperCase(),

    engine: ENGINE_SECTION[b.engine] ? b.engine : 'LIQUIDITY',

    section: ENGINE_SECTION[b.engine] || 'liquidity',

    setup: b.setup || null,

    side: b.side,

    executedAt: new Date().toISOString(),

    signalTime: b.signalTime || null,

    entry: b.entry == null ? null : b.entry,

    stop: b.stop == null ? null : b.stop,

    t1: b.t1 == null ? null : b.t1,

    t2: b.t2 == null ? null : b.t2,

    riskPct: b.riskPct == null ? null : b.riskPct,

    rr1: b.rr1 == null ? null : b.rr1,

    reason: b.reason || [],

    // The outcome needs a live price, which is not wired yet, so it is null and

    // the UI says "tracking" rather than inventing a number.

    last: null,

    movePct: null,

    outcome: null,

    status: 'TRACKING',

  };

  rows.push(row);

  writeExecuted(rows);

  res.json({ ok: true, setupId: id, row });

});



// HISTORY — three sections, one per engine, so they are read side by side.

app.get('/api/terminal/history', (req, res) => {

  const rows = readExecuted().map((r) => Object.assign({}, r, {

    direction: r.movePct == null ? null : (r.movePct > 0 ? 'POSITIVE' : r.movePct < 0 ? 'NEGATIVE' : 'FLAT'),

  }));

  const out = { liquidity: [], fvg: [], orderflow: [] };

  for (const r of rows) (out[r.section] || out.liquidity).push(r);

  res.json({

    generatedAt: new Date().toISOString(),

    total: rows.length,

    counts: { liquidity: out.liquidity.length, fvg: out.fvg.length, orderflow: out.orderflow.length },

    ...out,

  });

});



// ===========================================================================

// TERMINAL — the BOARD page.

// ===========================================================================

// The old Board was fed by a five-second poll of /api/gb/movers, a live tick

// board removed along with the rest of the GB Terminal. This serves the same

// page from a SNAPSHOT built by scripts/buildBoard.js: the universe counters are

// read out of the evening scan's own files, and the calls are a replay of the

// three engines over the last recorded session. Reading a file rather than

// scanning inside the request is deliberate — a scan is minutes, and no HTTP

// request should hold the event loop for it.

const BOARD_FILE = path.join(TERMINAL_DIR, 'board.json');



function readBoard() {

  try { return JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (_) { return null; }

}



const EMPTY_BOARD = {

  built: false,

  hint: 'No board snapshot yet — press \u27f3 Rescan (or run `node scripts/buildBoard.js`).',

  feed: { mode: 'NONE' },

  universe: { tracked: 0, blocked: 0, notBlocked: 0, scanned: 0, blockedReason: {} },

  horizons: [], horizonsUnavailable: null,

  rows: [], calls: [], rules: [], backtest: null,

};



app.get('/api/terminal/board', (req, res) => {

  const snap = readBoard();

  if (!snap) return res.json(Object.assign({ generatedAt: new Date().toISOString() }, EMPTY_BOARD));

  // THE AUTHORITY RULE, ENFORCED ON THE WAY OUT. The replay reads recorded

  // candles, not the live Angel socket, so no row here is stamped ANGEL_LIVE and

  // the page therefore shows the engines' OPINION, never a tradeable direction.

  // The Board is a read; it can never place an order.

  //

  // `callsAll` IS STRIPPED, NOT SENT. It holds every fired verdict with the raw

  // material its audit recomputes from, and this route is polled every 60s. It is

  // read one symbol at a time by /api/terminal/plan/by-symbol instead.

  const { callsAll, ...polled } = snap;

  res.json(Object.assign({ generatedAt: new Date().toISOString(), built: true }, polled));

});

app.get('/api/terminal/swing', (req, res) => {
  // THE LIVE SCAN COMES FIRST, AND THE PYTHON BASKET IS THE FALLBACK.
  //
  // scripts/swingScan.js replays the two REGISTERED swing engines (CODEX/TB01 and
  // SWING/SW01) over the newest sessions on disk and writes data/terminal/swing_scan.json.
  // That is the only row set here with an engine, a decision day and a measured record
  // behind it.
  //
  // The basket below (data/top_weekly_swing_calls.json) is the other AI's Python output:
  // a weekly snapshot whose own source labels two of its five rows "HTF CHEAT PIVOT", a
  // branch that could never fire in the Pine it came from (volRatio <= 1.2 against a strict
  // mode requiring >= 1.5). It is served only when no scan exists, and it says so in
  // `source` — a page must not present a snapshot as a scan.
  const scanPath = path.join(__dirname, 'data', 'terminal', 'swing_scan.json');
  if (fs.existsSync(scanPath)) {
    try {
      const scan = JSON.parse(fs.readFileSync(scanPath, 'utf8'));
      const rows = (scan.rows || []).map((r) => ({
        symbol: r.symbol,
        action: r.side === 'LONG' ? 'BUY / LONG' : 'SELL / SHORT',
        side: r.side,
        engine: r.engine,
        setup: r.setup,
        setupName: r.setup,
        // THE STRATEGY'S OWN TITLE, not the harness key. The scan writes it; a scan from
        // before this field existed falls back to the key so the row still renders.
        name: r.name || r.engine,
        strategyName: r.name || ((r.engine || '') + ' ' + (r.setup || '')).trim(),
        entryPrice: r.entry,
        entry: r.entry,
        stopLoss: r.stop,
        stop: r.stop,
        target1: r.t1,
        t1: r.t1,
        target2: r.t2,
        t2: r.t2,
        riskPct: r.riskPct,
        rr1: r.rr1,
        decisionDay: r.decisionDay,
        reason: r.reason,
        source: 'SWING_SCAN',
        tier: 'swing',
        // DISARMED travels with the row: both engines are registered enabled:false because
        // their measured records (netPF 0.77 / 1.19) do not clear this repo's rule.
        status: r.status,
        time: r.decisionDay,
      }));
      return res.json({
        ok: true,
        generatedAt: scan.generatedAt,
        asOf: scan.asOf,
        tier: 'SWING',
        harness: 'daily',
        source: 'SWING_SCAN',
        note: 'live scan of the three registered swing engines — rows are observations, not calls: every one of them is DISARMED',
        count: rows.length,
        calls: rows,
      });
    } catch (_) { /* fall through to the basket */ }
  }

  try {
    const jsonPath = path.join(__dirname, 'data', 'top_weekly_swing_calls.json');
    let calls = [];
    if (fs.existsSync(jsonPath)) {
      try { calls = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch (_) { calls = []; }
    }

    const rows = (calls || []).map((c) => {
      const isCodex = String(c.setup || '').includes('BREAKOUT') || String(c.setup || '').includes('TB01');
      const engineKey = isCodex ? 'CODEX' : 'SWING';
      const setupKey = isCodex ? 'TB01' : 'SW01';
      return {
        symbol: c.symbol,
        action: 'BUY / LONG',
        side: 'LONG',
        engine: engineKey,
        setup: setupKey,
        setupName: c.setup || 'SWING',
        entryPrice: c.ltp,
        entry: c.ltp,
        stopLoss: c.sl,
        stop: c.sl,
        target1: c.target1,
        t1: c.target1,
        target2: c.target2,
        t2: c.target2,
        riskPct: c.risk_pct,
        rr1: c.rr_t1,
        qty: c.qty,
        capital: c.capital,
        conviction: c.conviction || c.score || 9,
        ret20: c.ret20,
        thrust60: c.thrust60,
        source: 'PYTHON_BASKET',
        tier: 'swing',
        // NOT 'ACTIVE'. This file is a weekly snapshot with no engine behind it and no scan
        // timestamp of its own; calling it ACTIVE was the page asserting something the
        // artifact cannot support.
        status: 'SNAPSHOT — no engine run; see scripts/swingScan.js for the live scan',
        time: c.time || new Date().toISOString().slice(0, 10),
      };
    });

    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      tier: 'SWING',
      harness: 'daily',
      count: rows.length,
      calls: rows,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});



let _boardBuildRunning = false;

let _boardBuildStartedAt = null;



app.post('/api/terminal/board/scan', (req, res) => {

  if (_boardBuildRunning) return res.json({ ok: true, started: false, running: true, since: _boardBuildStartedAt });

  _boardBuildRunning = true;

  _boardBuildStartedAt = new Date().toISOString();

  const { spawn } = require('child_process');

  const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'buildBoard.js')], {

    cwd: __dirname, detached: true, stdio: 'ignore',

  });

  const done = () => { _boardBuildRunning = false; };

  child.on('exit', done);

  child.on('error', done);

  child.unref();

  res.json({ ok: true, started: true, running: true });

});



app.get('/api/terminal/board/status', (req, res) => {

  const snap = readBoard();

  res.json({

    building: _boardBuildRunning,

    since: _boardBuildStartedAt,

    builtAt: snap ? snap.builtAt : null,

    lastSession: snap && snap.feed ? snap.feed.lastSession : null,

  });

});



// ---- THE LIVE TAPE — the raw captured ticks, as a board ----------------

// The tick capture has been writing data/orderflow/ticks-<day>.jsonl every

// second but NOTHING rendered it: the pipeline ran and no page showed it. This

// reads the TAIL of today's tape (never the whole file — it is hundreds of

// megabytes) and folds it into one row per symbol over a short window.

//

// READ-ONLY, and deliberately so: it re-parses recorded ticks and cannot place an

// order, mark a direction or feed an engine. It is a view of the tape.

const TAPE_DIR = path.join(__dirname, 'data', 'orderflow');

const TAPE_TAIL_BYTES = 4 * 1024 * 1024;   // ~4 MB covers far more than the window

let _tapeCache = { at: 0, key: '', payload: null };



function tapeDayIST(ms) {

  return new Date(Number(ms) + 330 * 60000).toISOString().slice(0, 10);

}



/** The newest tick file, preferring today's IST day. */

function tapeFile() {
  if (!fs.existsSync(TAPE_DIR)) {
    try { fs.mkdirSync(TAPE_DIR, { recursive: true }); } catch (_) {}
    return null;
  }

  const today = path.join(TAPE_DIR, 'ticks-' + tapeDayIST(Date.now()) + '.jsonl');

  if (fs.existsSync(today)) return today;

  let best = null; let bestT = 0;

  let files = [];
  try { files = fs.readdirSync(TAPE_DIR); } catch (_) { return null; }

  for (const f of files) {

    if (!/^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;

    const st = fs.statSync(path.join(TAPE_DIR, f));

    if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = path.join(TAPE_DIR, f); }

  }

  return best;

}



/** The last `bytes` of a file, with the leading partial line dropped. */

function readFileTail(file, bytes) {

  const fd = fs.openSync(file, 'r');

  try {

    const size = fs.fstatSync(fd).size;

    const start = Math.max(0, size - bytes);

    const len = size - start;

    if (len <= 0) return '';

    const buf = Buffer.allocUnsafe(len);

    fs.readSync(fd, buf, 0, len, start);

    const txt = buf.toString('utf8');

    const nl = txt.indexOf('\n');

    return start > 0 && nl >= 0 ? txt.slice(nl + 1) : txt;

  } finally { fs.closeSync(fd); }

}



/**

 * ONE ROW PER SYMBOL, over the last `windowMs` of tape. Everything is measured

 * from the ticks themselves — the price now, the price at the window's start, the

 * volume the symbol actually traded inside the window (the tape carries CUMULATIVE

 * day volume, so the window's volume is last-first, never the running total), and

 * the resting best-five depth either side.

 */

function liveTape(opts) {
  const windowMs = Math.max(3000, Math.min(120000, Number(opts && opts.windowMs) || 60000));
  const file = tapeFile();
  if (!file) return { builtAt: new Date().toISOString(), file: null, windowMs, rows: [], note: 'no tick tape on disk' };

  const key = file + '|' + windowMs;
  if (_tapeCache.payload && _tapeCache.key === key && (Date.now() - _tapeCache.at) < 700) {
    return Object.assign({}, _tapeCache.payload, { cached: true });
  }

  const lines = readFileTail(file, TAPE_TAIL_BYTES).split('\n');
  let newestTick = 0;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 1000); i--) {
    if (!lines[i]) continue;
    try {
      const t = JSON.parse(lines[i]);
      if (t && t.t) { newestTick = t.t; break; }
    } catch (_) {}
  }

  const refNow = newestTick || Date.now();
  const from = refNow - windowMs;
  const by = new Map();
  let inWindow = 0;

  for (const ln of lines) {
    if (!ln) continue;
    let t;
    try { t = JSON.parse(ln); } catch (_) { continue; }
    if (!t || !t.s || t.t == null || t.t < from) continue;

    inWindow++;
    let r = by.get(t.s);
    if (!r) {
      r = {
        symbol: t.s,
        firstPx: t.p,
        price: t.p,
        firstVol: t.v,
        vol: t.v,
        ticks: 0,
        firstT: t.t,
        lastT: t.t,
        history: [],
        bid: null, ask: null, bidq: null, askq: null, bq: null, sq: null
      };
      by.set(t.s, r);
    }
    r.ticks++;
    r.lastT = t.t;
    if (t.p != null) {
      r.price = t.p;
      r.history.push({ t: t.t, p: t.p });
    }
    if (t.v != null) r.vol = t.v;
    if (t.bid != null) { r.bid = t.bid; r.bidq = t.bidq; }
    if (t.ask != null) { r.ask = t.ask; r.askq = t.askq; }
    if (t.bq != null) r.bq = t.bq;
    if (t.sq != null) r.sq = t.sq;
  }

  const pct = (a, b) => (a == null || b == null || !b) ? null : ((a - b) / b) * 100;
  const rows = [];

  for (const r of by.values()) {
    if (r.ticks < 1) continue;

    // Symbol-anchored 10-second price lookback (eliminates clock drift!)
    const refT = r.lastT || refNow;
    const target10 = refT - 10000;
    const target20 = refT - 20000;
    let px10 = null;
    let px20 = null;

    if (r.history && r.history.length > 0) {
      for (let i = r.history.length - 1; i >= 0; i--) {
        if (px10 == null && r.history[i].t <= target10) {
          px10 = r.history[i].p;
        }
        if (px20 == null && r.history[i].t <= target20) {
          px20 = r.history[i].p;
        }
        if (px10 != null && px20 != null) break;
      }
      if (px10 == null && r.history.length >= 2) {
        const oldest = r.history[0];
        if ((refT - oldest.t) >= 6000) {
          px10 = oldest.p;
        }
      }
    }

    const depth = (r.bq != null && r.sq != null) ? (r.bq + r.sq) : 0;
    rows.push({
      symbol: r.symbol,
      price: r.price,
      chgPct: pct(r.price, r.firstPx),
      roc10: pct(r.price, px10),
      roc20: pct(r.price, px20),
      volDelta: (r.vol != null && r.firstVol != null) ? Math.max(0, r.vol - r.firstVol) : null,
      volTotal: r.vol,
      ticks: r.ticks,
      bid: r.bid, ask: r.ask, bidq: r.bidq, askq: r.askq,
      bq: r.bq, sq: r.sq,
      spreadPct: (r.bid != null && r.ask != null && r.price) ? ((r.ask - r.bid) / r.price) * 100 : null,
      crossed: (r.bid != null && r.ask != null) ? (r.bid > r.ask) : null,
      quoteImbalance: (r.bidq != null && r.askq != null && (r.bidq + r.askq) > 0)
        ? (r.bidq - r.askq) / (r.bidq + r.askq) : null,
      buyQty: r.bq, sellQty: r.sq,
      dayQtyImbalance: depth > 0 ? (r.bq - r.sq) / depth : null,
      lastT: r.lastT,
    });
  }

  rows.sort((a, b) => (b.ticks - a.ticks) || ((b.volDelta || 0) - (a.volDelta || 0)));
  const payload = {
    builtAt: new Date().toISOString(),
    file: path.relative(__dirname, file).replace(/\\/g, '/'),
    fileBytes: (() => { try { return fs.statSync(file).size; } catch (_) { return null; } })(),
    windowMs,
    symbols: rows.length,
    ticksInWindow: inWindow,
    tickRatePerSec: Math.round(inWindow / (windowMs / 1000)),
    newestTickAgeMs: newestTick ? (Date.now() - newestTick) : null,
    live: newestTick ? (Date.now() - newestTick) < 15000 : false,
    rows,
  };
  _tapeCache = { at: Date.now(), key, payload };
  return payload;
}

app.get('/api/tape/live', (req, res) => {
  try {
    res.json(liveTape({ windowMs: req.query.windowMs }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function getLiveTapeVelocityMovers() {
  const tape = liveTape({ windowMs: 60000 });
  const rows = (tape && Array.isArray(tape.rows)) ? tape.rows : [];

  // Strict quality filter: No indices (999...), price >= 30, ticks >= 4 in window,
  // turnover >= 25 Lakhs or 1m turnover >= 25,000 (strictly eliminates barcode & ghost stocks like AMJLAND, SAHLIBHFI, DOLLEX)
  const qualified = rows.filter(r => {
    if (!r.symbol || r.symbol.startsWith('999')) return false;
    const p = Number(r.price || 0);
    if (p < 30) return false;
    if ((r.ticks || 0) < 4) return false;
    const dayTurnover = (Number(r.volTotal) || 0) * p;
    const m1Turnover = (Number(r.volDelta) || 0) * p;
    if (dayTurnover < 2500000 && m1Turnover < 25000) return false;
    return true;
  });

  // 1. TABLE 1: 10-SEC VELOCITY ROCKETS (Strictly live non-zero 10-second price ROC)
  // Must have a valid non-zero roc10. ZERO 0.00% ENTRIES PERMITTED!
  const movers10s = qualified
    .filter(r => r.roc10 != null && Math.abs(r.roc10) >= 0.05)
    .map(r => {
      const roc10Val = +r.roc10.toFixed(2);
      const m1Val = r.chgPct != null ? +r.chgPct.toFixed(2) : 0;
      const toCr = +(((r.volTotal || 0) * r.price) / 10000000).toFixed(2);
      return {
        symbol: r.symbol,
        price: r.price,
        ltp: r.price,
        roc10: roc10Val,
        move10sPct: roc10Val,
        move1mPct: m1Val,
        direction: roc10Val >= 0 ? 'BULLISH' : 'BEARISH',
        ticks: r.ticks,
        turnoverCr: toCr,
        volume1m: r.volDelta || 0,
        source: 'liveTape10s'
      };
    })
    .sort((a, b) => Math.abs(b.roc10) - Math.abs(a.roc10))
    .slice(0, 16);

  // 2. TABLE 2: 1-MINUTE VELOCITY ROCKETS (Strictly live non-zero 60-second price ROC)
  // Must have a valid non-zero chgPct. ZERO 0.00% ENTRIES PERMITTED!
  const movers1m = qualified
    .filter(r => r.chgPct != null && Math.abs(r.chgPct) >= 0.10)
    .map(r => {
      const m1Val = +r.chgPct.toFixed(2);
      const roc10Val = r.roc10 != null ? +r.roc10.toFixed(2) : 0;
      const toCr = +(((r.volTotal || 0) * r.price) / 10000000).toFixed(2);
      return {
        symbol: r.symbol,
        price: r.price,
        ltp: r.price,
        move1mPct: m1Val,
        roc10: roc10Val,
        move10sPct: roc10Val,
        direction: m1Val >= 0 ? 'BULLISH' : 'BEARISH',
        ticks: r.ticks,
        turnoverCr: toCr,
        volume1m: r.volDelta || 0,
        source: 'liveTape1m'
      };
    })
    .sort((a, b) => Math.abs(b.move1mPct) - Math.abs(a.move1mPct))
    .slice(0, 16);

  return { movers10s, movers1m };
}

// ---- SWEEP + FVG REAL-TIME ORDERFLOW STRATEGY API ----

app.get('/api/orderflow/sweep-fvg/performance', (req, res) => {

  const engine = req.app.get('sweepFvgLive');

  if (!engine) return res.json({ status: 'not_armed', message: 'Sweep-FVG live engine is not running' });

  res.json({ status: 'ok', performance: engine.getPerformance() });

});



app.get('/api/orderflow/sweep-fvg/signals', (req, res) => {

  const engine = req.app.get('sweepFvgLive');

  if (!engine) return res.json({ status: 'not_armed', signals: [], trades: [] });

  res.json({

    status: 'ok',

    signals: engine.signals().slice(-200),

    trades: engine.closedTrades().slice(-200)

  });

});



// THE SECTION IS NAMED FOR ONE ENGINE, SO IT SHOWS ONE ENGINE'S CALLS.

//

// Both live engines write the same session book (`data/orderflow/daily_calls_<date>.json`), and

// liveMinuteEngine loads that whole file — so `getCalls()` returned the minute engine's calls AND

// the sweep engine's, and the section headed "SWEEP + FVG — TODAY'S CALLS" listed 18 calls when

// that engine armed 9. Attribution goes through callBookHistory's engineOf(), the same reader the

// daily history uses, so a call is labelled the same way wherever it appears.

app.get('/api/orderflow/sweep-fvg/calls', (req, res) => {

  let mine = [];

  try {

    const { engineOf } = require('./common/market/callBookHistory');

    mine = liveMinuteEngine.getCalls().filter((c) => engineOf(c).id === 'SWEEP_FVG');

  } catch (_) { mine = []; }

  // THE VERDICT AND THE TALLY ARE COMPUTED HERE, BY THE ONE RULE — the page renders

  // them and does no arithmetic of its own. Each call carries the shared classifier's

  // own key and label, and the tally is the same shape the daily history publishes, so

  // "won / lost / win rate" in the sweep panel can never be a page-side filter that

  // counts a +₹0.01 close as a win or a 15:30 flatten as a target.

  const calls = mine.map((c) => {

    const o = classify(c);

    // `closed` and `won` travel WITH the verdict. The page used to decide closedness for

    // itself with a status list it kept in sync by hand; the engines added a `CLOSED`

    // status for level-free exits and that list did not know it, so those rows were

    // neither in the day's rupee total nor anywhere else. The classifier already answers

    // both questions, so it answers them here — once.

    // `outcomePaid` — NOT `outcomeWon`. The classifier's `won` flag on a non-level exit means

    // "the net came out ahead", which is true of a 15:30 flatten that drifted up a few paise;

    // published under the name "won" beside a closed flag it would immediately be read back

    // as a target hit. Only `outcomeKey === 'TARGET_HIT'` is a win, and the page checks the key.

    return Object.assign({}, c, {

      outcomeKey: o.key, outcomeLabel: o.label,

      outcomeClosed: o.closed === true, outcomePaid: o.won === true,

    });

  });

  res.json({

    status: 'ok',

    engine: 'SWEEP_FVG',

    basis: 'calls whose own record names the Sweep + FVG engine',

    tally: tallyOutcomes(calls),

    calls

  });

});



// WHAT EACH CALL ACTUALLY DID, off the recorded tape - filled or not, target or stop first, and the

// net rupees for one share using the engine's own toll. The page used to mark WON from the latest

// price alone, which credits a call whose limit was never reached; orderflow/callOutcomes.js replays

// the engine's own fill/anti-chase/exit rules instead. The same payload carries the user's

// taken/skipped ledger, so the page can price what they actually took against what the engine emitted.

const INTRADAY_REMOVED = { ok: false, removed: true, tier: 'SWING', error: 'intraday strategies were deleted on 2026-10-31 — the live strategy surface is /api/terminal/swing' };

app.get('/api/orderflow/sweep-fvg/outcomes', (req, res) => {

  // The order-flow/sweep-fvg intraday stack was deleted on 2026-10-31. Answering 410 says so
  // plainly instead of failing on a missing module.
  return res.status(410).json(INTRADAY_REMOVED);

  try {

    const { evaluateDay } = require('./strategies/orderflow/callOutcomes');

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))

      ? String(req.query.date)

      : new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

    res.json({ status: 'ok', ...evaluateDay(date) });

  } catch (e) {

    res.status(500).json({ status: 'error', error: e.message });

  }

});



// "Did I take this order?" - the one thing the tape cannot know, and the only thing that changes the

// money. Persisted next to the day's record so a reload, a restart or tomorrow's review sees the same

// answer. state may be TAKEN, SKIPPED, or null to clear the decision.

app.post('/api/orderflow/sweep-fvg/outcomes/decision', (req, res) => {

  return res.status(410).json(INTRADAY_REMOVED);

  try {

    const { writeLedger, evaluateDay } = require('./strategies/orderflow/callOutcomes');

    const id = req.body && req.body.id;

    const state = req.body && (req.body.state === undefined ? null : req.body.state);

    if (!id) return res.status(400).json({ status: 'error', error: 'id is required' });

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || ''))

      ? String(req.body.date)

      : new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

    const saved = writeLedger(date, id, state);

    const day = evaluateDay(date);

    res.json({ status: 'ok', decision: saved, summary: day.summary });

  } catch (e) {

    res.status(400).json({ status: 'error', error: e.message });

  }

});



app.post('/api/orderflow/sweep-fvg/scorecard/send', async (req, res) => {

  const engine = req.app.get('sweepFvgLive');

  if (!engine) return res.status(400).json({ status: 'not_armed', message: 'Engine not running' });

  await engine.sendDailyScorecard({ force: true });

  res.json({ status: 'ok', message: 'Daily scorecard dispatched to Telegram' });

});



// ---- Experimental scalping board (SEPARATE from the production Board) ----

// Reads whatever scalping/scalpService.js last wrote. It is a read-only view of

// an independent research module and can never place an order.

// ---- Dedicated GROW SCALPING Board (GS15 & GS01) ----

// THE WIRE IS NOT ATTACHED HERE. A `news` field per call and a `liveWire` summary were added on

// 2026-10-29 and removed the same evening at the owner's request: it annotated every call row with

// the newest headline for its symbol, but nothing consumed it — no gate, no entry rule, no exit —

// so it was decoration on the one surface that must stay load-bearing. Everything it needed still

// exists (common/news/fastWire.js, /api/news/stream, the strip on the strategies board), so this is

// a wiring decision to revisit with a MEASURED rule, not a missing capability.

app.get('/api/scalping/board', (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  try {
    const board = (liveMinuteEngine && typeof liveMinuteEngine.getScalpingBoard === 'function')
      ? liveMinuteEngine.getScalpingBoard()
      : { calls: [], activeCandidates: [], closedCalls: [], scalpingStats: { totalCalls: 0, activeCalls: 0, winRate: 0, grossPnl: 0, netPnl: 0 } };
    board.quotes = liveBoardQuotes();

    // Directly derive truthful, real-time velocity rockets from the live tick tape!
    const tapeMovers = getLiveTapeVelocityMovers();

    // 1. TABLE 1: 10-SEC VELOCITY ROCKETS (Strictly pure non-zero 10s ROC, NO Day %, NO 0.00%)
    board.movers10s = tapeMovers.movers10s || [];

    // 2. TABLE 2: 1-MINUTE VELOCITY ROCKETS (Strictly pure non-zero 1m ROC, NO Day %, NO 0.00%)
    board.movers1m = tapeMovers.movers1m || [];
    board.growwMovers = board.movers1m;

    return res.json(board);
  } catch (err) {
    console.error('[Server.js] Error in /api/scalping/board:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/scalping/sweeps', (req, res) => {

  return res.status(410).json(INTRADAY_REMOVED);


  res.set({

    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',

    'Pragma': 'no-cache',

    'Expires': '0'

  });

  try {

    const sweep = require('./strategies/orderflow/liquiditySweep');

    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 60);

    // nowMs: a bar older than MAX_BAR_AGE_MIN cannot claim to be a sweep happening now.

    const rows = sweep.scan(liveMinuteEngine.symBars, { limit, nowMs: Date.now() });

    // THE FUNNEL, SO A ZERO IS EXPLAINED RATHER THAN ASSUMED. "0 found" can mean a quiet tape, or it

    // can mean the engine is holding fewer than 31 bars per symbol and nothing can qualify at all.

    // Without these counts the two look identical on the page — and they are very different bugs.

    const funnel = { symbols: 0, withBars: 0, liquid: 0, maxBars: 0, emptyBars: 0 };

    try {

      for (const [sym, bars] of liveMinuteEngine.symBars.entries()) {

        if (!sym || sym.startsWith('999')) continue;

        funnel.symbols += 1;

        if (!Array.isArray(bars)) { funnel.emptyBars += 1; continue; }

        funnel.maxBars = Math.max(funnel.maxBars, bars.length);

        if (bars.length === 0) funnel.emptyBars += 1;

        if (bars.length < sweep.LOOKBACK_BARS + 1) continue;

        funnel.withBars += 1;

        let turn = 0;

        for (const b of bars) turn += (Number(b.c) || 0) * (Number(b.v) || 0);

        if (turn / 1e7 >= sweep.MIN_DAY_TURNOVER_CR) funnel.liquid += 1;

      }

    } catch (e) { /* the counts are diagnostic; never fail the request for them */ }

    res.set('Cache-Control', 'no-store');

    res.json({

      ok: true,

      at: new Date().toISOString(),

      count: rows.length,

      universe: liveMinuteEngine.symBars ? liveMinuteEngine.symBars.size : 0,

      funnel,

      rows,

      rules: {

        lookbackBars: sweep.LOOKBACK_BARS, freshBars: sweep.FRESH_BARS,

        atLevelBps: sweep.AT_LEVEL_BPS, minTouches: sweep.MIN_TOUCHES,

        touchTolBps: sweep.TOUCH_TOL_BPS, minDayTurnoverCr: sweep.MIN_DAY_TURNOVER_CR,

        minSweepRvol: sweep.MIN_SWEEP_RVOL, minPrice: sweep.MIN_PRICE,

      },

    });

  } catch (e) {

    res.status(500).json({ ok: false, error: e.message });

  }

});



app.get('/api/scalping/movers', (req, res) => {

  res.set({

    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',

    'Pragma': 'no-cache',

    'Expires': '0'

  });

  try {

    const tapeMovers = getLiveTapeVelocityMovers();
    if (tapeMovers.movers1m && tapeMovers.movers1m.length > 0) {
      return res.json({ ok: true, timestamp: new Date().toISOString(), count: tapeMovers.movers1m.length, movers: tapeMovers.movers1m });
    }

    let movers = liveMinuteEngine.getGrowwFastMovers

      ? liveMinuteEngine.getGrowwFastMovers()

      : (liveMinuteEngine.getGroww5MinMovers ? liveMinuteEngine.getGroww5MinMovers() : []);

    movers = enrichMoversWithCatalysts(movers || []);

    return res.json({ ok: true, timestamp: new Date().toISOString(), count: movers.length, movers });

  } catch (err) {

    return res.status(500).json({ ok: false, error: err.message });

  }

});



const CAT_QUOTES_FILE = path.join(__dirname, 'data', 'catalyst_stock_quotes.json');

let _catalystStockQuotes = {};

try {

  if (fs.existsSync(CAT_QUOTES_FILE)) {

    _catalystStockQuotes = JSON.parse(fs.readFileSync(CAT_QUOTES_FILE, 'utf8'));

  }

} catch (_) {}



// Rolling 30-second price ring buffer to calculate dynamic 10-second ROC (not constant, not today's top!)
const _symbolPriceHistory10s = new Map();

function trackPrice10s(sym, price, now = Date.now()) {
  if (!sym || !price || price <= 0) return;
  let hist = _symbolPriceHistory10s.get(sym);
  if (!hist) {
    hist = [];
    _symbolPriceHistory10s.set(sym, hist);
  }
  hist.push({ t: now, p: price });
  const cutoff = now - 30000;
  while (hist.length > 2 && hist[0].t < cutoff) {
    hist.shift();
  }
}

function calculate10sRoc(sym, currentPrice, now = Date.now()) {
  // 1. Live minute engine tick stream takes precedence
  if (liveMinuteEngine && typeof liveMinuteEngine.getRoc10 === 'function') {
    const liveRoc = liveMinuteEngine.getRoc10(sym);
    if (Math.abs(liveRoc) > 0) return liveRoc;
  }
  // 2. Sliding 10-second window across quotes
  const hist = _symbolPriceHistory10s.get(sym);
  if (!hist || hist.length < 2) return 0;
  const last = hist[hist.length - 1];
  if (now - last.t > 15000) return 0;
  const targetTime = now - 10000;
  let base = null;
  for (let i = hist.length - 2; i >= 0; i--) {
    if (hist[i].t <= targetTime && (now - hist[i].t) <= 18000) {
      base = hist[i];
      break;
    }
  }
  if (!base && hist[0] && (now - hist[0].t) >= 6000 && (now - hist[0].t) <= 18000) {
    base = hist[0];
  }
  if (!base || !(base.p > 0) || Math.abs(currentPrice - base.p) < 0.0001) return 0;
  return +(((currentPrice - base.p) / base.p) * 100).toFixed(2);
}

function enrichMoversWithCatalysts(existing) {
  const result = Array.isArray(existing) ? [...existing] : [];
  
  // 0. Enrich existing engine movers with quotes (e.g. dayChangePct)
  for (const item of result) {
    const q = (_catalystStockQuotes && _catalystStockQuotes[item.symbol]) || {};
    if (q.changePct != null) {
      item.dayChangePct = +Number(q.changePct).toFixed(2);
    }
    if (q.volume != null && !item.volume) {
      item.volume = q.volume;
    }
    const r10 = calculate10sRoc(item.symbol, item.price);
    if (r10 !== 0) {
      item.roc10 = r10;
      item.move10sPct = r10;
    }
  }

  const seen = new Set(result.map(m => m.symbol));
  try {
    const pmc = require('./common/news/preMarketCatalysts');
    const catMap = pmc.loadPreMarketCatalysts() || new Map();

    // 1. Gather all potential symbols from quotes and catalysts
    const allSymbols = new Set([
      ...Object.keys(_catalystStockQuotes || {}),
      ...Array.from(catMap.keys())
    ]);

    const candidates = [];
    for (const sym of allSymbols) {
      if (!sym || seen.has(sym)) continue;
      const q = (_catalystStockQuotes && _catalystStockQuotes[sym]) || {};
      const c = catMap.get(sym) || {};
      const price = Number(q.ltp || c.ltp || c.price || 0);
      if (price < 30) continue; // Price floor ₹30 (no penny stocks)

      const vol = Number(q.volume || q.volume1m || 0);
      const trueTurnoverInr = Number(q.turnover) > 0 ? Number(q.turnover) : (price * vol);
      const toCr = +(trueTurnoverInr / 10000000).toFixed(2);

      // Strict ghost stock elimination (turnover >= ₹25L, volume >= 10,000)
      if (trueTurnoverInr < 2500000 || vol < 10000) continue;

      const dayMove = Number(q.changePct || c.changePct || c.priorMove || 0);
      const m1 = Number(q.move1mPct || c.move1mPct || 0);
      const m5 = Number(q.move5mPct || c.move5mPct || 0);
      // Pure 10s ROC (NO fake dayMove * 0.1 fallback!)
      const roc10Val = calculate10sRoc(sym, price);

      candidates.push({
        symbol: sym,
        price,
        ltp: price,
        dayChangePct: +dayMove.toFixed(2),
        roc10: roc10Val,
        move10sPct: roc10Val,
        move1mPct: +m1.toFixed(2),
        move5mPct: +m5.toFixed(2),
        direction: (roc10Val !== 0 ? roc10Val > 0 : (m1 !== 0 ? m1 > 0 : dayMove > 0)) ? 'BULLISH' : 'BEARISH',
        rvol: Number(q.rvol || 1.2),
        turnoverCr: toCr,
        volume1m: vol,
        timestamp: Date.now(),
        sortScore: Math.abs(roc10Val) > 0 ? Math.abs(roc10Val) : (Math.abs(m1) * 0.5),
      });
    }

    // Sort candidates by real 10s velocity descending
    candidates.sort((a, b) => b.sortScore - a.sortScore);
    for (const cand of candidates) {
      if (result.length >= 60) break;
      result.push(cand);
      seen.add(cand.symbol);
    }
  } catch (err) {
    console.warn('[enrichMoversWithCatalysts] note:', err.message);
  }

  // Final sort: REAL 10-SECOND ROC DESCENDING!
  // Active 10-second bursts are strictly on up at the top!
  result.sort((a, b) => {
    const rocA = Math.abs(Number(a.roc10 != null ? a.roc10 : (a.move10sPct != null ? a.move10sPct : 0)));
    const rocB = Math.abs(Number(b.roc10 != null ? b.roc10 : (b.move10sPct != null ? b.move10sPct : 0)));
    if (rocB !== rocA) return rocB - rocA;
    const m1A = Math.abs(Number(a.move1mPct || 0));
    const m1B = Math.abs(Number(b.move1mPct || 0));
    return m1B - m1A;
  });

  return result.slice(0, 50);
}

async function refreshCatalystStockQuotes() {
  try {
    const pmc = require('./common/news/preMarketCatalysts');
    const catMap = pmc.loadPreMarketCatalysts();
    if (!catMap || catMap.size === 0) return;
    const allItems = Array.from(catMap.values()).filter(c => c && c.symbol);
    if (!allItems.length) return;
    const nowMs = Date.now();
    const freshSyms = allItems
      .filter(c => c.isHighPriority || (c.ts && (nowMs - Number(c.ts)) < 3 * 3600 * 1000))
      .map(c => c.symbol);
    const syms = Array.from(new Set([...freshSyms, ...allItems.map(c => c.symbol)])).slice(0, 40);
    const quotes = await liveQuoteEngine.fetchStockQuotes(syms);
    if (quotes && Object.keys(quotes).length > 0) {
      const now = Date.now();
      for (const [sym, q] of Object.entries(quotes)) {
        if (q && q.ltp > 0) {
          trackPrice10s(sym, q.ltp, now);
        }
      }
      _catalystStockQuotes = Object.assign(_catalystStockQuotes, quotes);
      try { fs.writeFileSync(CAT_QUOTES_FILE, JSON.stringify(_catalystStockQuotes), 'utf8'); } catch (_) {}
      for (const item of allItems) {
        if (item.symbol && quotes[item.symbol] && quotes[item.symbol].ltp > 0) {
          const q = quotes[item.symbol];
          filingPriceTracker.recordAndGetFilingPrice(item.symbol, item.ts, q.ltp, q.open, q.close);
        }
      }
    }
  } catch (_) {}
}

setInterval(refreshCatalystStockQuotes, 10000);
setTimeout(refreshCatalystStockQuotes, 1500);

let _catalystsResponseCache = {
  time: 0,
  key: '',
  data: null
};

app.get('/api/scalping/catalysts', (req, res) => {

  res.set({

    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',

    'Pragma': 'no-cache',

    'Expires': '0'

  });

  const cacheKey = `${req.query.day || ''}_${req.query.includeUntradeable || ''}_${req.query.includeBeforeClose || ''}`;
  const now = Date.now();
  if (_catalystsResponseCache.data && _catalystsResponseCache.key === cacheKey && (now - _catalystsResponseCache.time) < 1500) {
    return res.json(_catalystsResponseCache.data);
  }

  try {

    const pmc = require('./common/news/preMarketCatalysts');

    const day = req.query.day || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

    const catMap = pmc.loadPreMarketCatalysts(day);



    // Merge high-impact items from fast RSS live_news.json

    try {

      const liveNewsPaths = [
        path.join(__dirname, 'data', 'news', 'live_news.json'),
        path.join(__dirname, 'backtest', 'live_news.json')
      ];
      let liveNewsFile = liveNewsPaths.find(p => fs.existsSync(p));

      if (liveNewsFile) {

        const liveNewsData = JSON.parse(fs.readFileSync(liveNewsFile, 'utf8'));

        if (Array.isArray(liveNewsData.items)) {

          for (const item of liveNewsData.items) {

            if (!item.extractedSymbols || !item.extractedSymbols.length) continue;

            for (const sym of item.extractedSymbols) {
              if (!sym || sym === 'BSE' || sym === 'NSE' || sym === 'ALL' || /^\d+$/.test(sym) || /-(RE|BE|BZ|SM|NC|N\d)$/i.test(sym)) continue;

              const itemTs = new Date(item.pubDate).getTime();

              const existing = catMap.get(sym);

              if (existing && existing.ts && itemTs <= existing.ts) {

                existing.impactScore = Math.max(existing.impactScore || 0, item.impactScore || 0);

                if (item.matchedKeywords && item.matchedKeywords.length) existing.matchedKeywords = item.matchedKeywords;

                continue;

              }

              // If new symbol or newer filing, create/replace with fresh live wire item

              const diffSec = Math.max(0, Math.round((Date.now() - itemTs) / 1000));

              const timeAgo = diffSec < 60 ? diffSec + 's ago' : (diffSec < 3600 ? Math.round(diffSec / 60) + 'm ago' : Math.round(diffSec / 3600) + 'h ago');

              // STRICT CLASSIFICATION: Do not fabricate 'ORDER' for random routine news

              const textToInspect = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();

              let mat = 'ROUTINE';

              if (textToInspect.includes('result') || textToInspect.includes('financial') || textToInspect.includes('unaudited') || textToInspect.includes('audited') || textToInspect.includes('net profit') || textToInspect.includes('q1') || textToInspect.includes('q2') || textToInspect.includes('q3') || textToInspect.includes('q4') || /\bufr\b|\bafr\b/i.test(textToInspect)) {

                mat = 'RESULTS';

              } else if (textToInspect.includes('dividend') || textToInspect.includes('bonus') || textToInspect.includes('split') || textToInspect.includes('buyback') || textToInspect.includes('rights issue') || textToInspect.includes('acquisition') || textToInspect.includes('takeover') || textToInspect.includes('merger') || textToInspect.includes('demerger') || textToInspect.includes('allotment')) {

                mat = 'CAPITAL';

              } else if (textToInspect.includes('monthly business update') || textToInspect.includes('monthly sales') || textToInspect.includes('turnover') || textToInspect.includes('dispatches') || textToInspect.includes('offtake') || textToInspect.includes('provisional production') || textToInspect.includes('production and offtake')) {

                mat = 'SALES_UPDATE';

              } else if (textToInspect.includes('order win') || textToInspect.includes('contract award') || textToInspect.includes('secures order') || textToInspect.includes('bags order') || textToInspect.includes('received order') || textToInspect.includes('contract worth') || textToInspect.includes('letter of award') || textToInspect.includes('usfda') || textToInspect.includes('approval')) {

                mat = 'ORDER';

              } else if (textToInspect.includes('insolvency') || textToInspect.includes('nclt') || textToInspect.includes('fraud') || (/\bsebi\s+(?:order|notice|investigat|inquiry|penalty|adjudicat|summons|ban|bar)\b/i.test(textToInspect)) || textToInspect.includes('investigation') || textToInspect.includes('search') || textToInspect.includes('cbi') || textToInspect.includes('raid')) {

                mat = 'RISK';

              }

              // If existing filing was high priority (e.g. RESULTS, ORDER, CAPITAL), NEVER let a subsequent routine filing overwrite it!
              if (existing && existing.isHighPriority && mat === 'ROUTINE') {
                continue;
              }

              // Only drop if it is explicitly pure administrative paperwork (loss of share cert, reg 39, reg 74, trading window)
              const isPureAdminPaperwork = mat === 'ROUTINE' && (/loss of share|duplicate share|reg\.?\s*(?:39|74|57)|trading window closure|closure of trading window|newspaper publication|paper cutting/i.test(textToInspect));
              if (isPureAdminPaperwork) continue;



              const cleanTitle = cleanSubject(item.title, item.description, sym, mat);

              const itemObj = {

                symbol: sym,

                materiality: mat,

                kind: item.matchedKeywords && item.matchedKeywords.length ? item.matchedKeywords[0].toUpperCase() : 'FLASH',

                title: cleanTitle,

                description: item.description || item.text || '',

                ts: itemTs,

                date: day,

                filingTime: new Date(itemTs + 330 * 60000).toISOString().slice(11, 16) + ' IST',

                timeAgo,

                isHighPriority: true,

                url: item.link,

                impactScore: item.impactScore,

                matchedKeywords: item.matchedKeywords || []

              };

              const pred = pmc.predictCatalyst(itemObj);

              itemObj.prediction = pred.prediction;

              itemObj.bias = pred.bias;

              itemObj.confidence = pred.confidence;

              itemObj.rationale = pred.rationale;

              catMap.set(sym, itemObj);

            }

          }

        }

      }

    } catch (_) {}



    const list = Array.from(catMap.values());

    const [tY, tM, tD] = day.split('-').map(Number);
    const todayMidnightMs = Date.UTC(tY, tM - 1, tD, 0, 0, 0) - 330 * 60000;
    const isToday = (ts) => ts && Number(ts) >= todayMidnightMs;
    const sessionOpenMs = Date.UTC(tY, tM - 1, tD, 3, 45, 0); // 09:15 IST
    const isSessionFiling = (ts) => ts && Number(ts) >= (sessionOpenMs - 45 * 60000); // 08:30 AM to now

    const alreadyFilledSymbols = new Set();
    if (liveMinuteEngine) {
      if (liveMinuteEngine.calls && liveMinuteEngine.calls.size > 0) {
        for (const call of liveMinuteEngine.calls.values()) {
          if (['ARMED', 'FILLED', 'OPEN'].includes(call.status)) alreadyFilledSymbols.add(call.symbol);
        }
      }
      if (liveMinuteEngine.closedCalls && liveMinuteEngine.closedCalls.length > 0) {
        for (const call of liveMinuteEngine.closedCalls) {
          if (call.symbol) alreadyFilledSymbols.add(call.symbol);
        }
      }
    }

    const enriched = list.map(c => {

      const sym = c.symbol;

      let ltp = null;

      let open = null;

      let movePct = 0;

      let move1mPct = 0;

      let move5mPct = 0;

      let isLive = false;



      // 1. Instantaneous real-time tick price from WebSocket feed

      if (liveMinuteEngine && liveMinuteEngine.prevPrice) {

        const p = liveMinuteEngine.prevPrice.get(sym);

        if (p != null && p > 0) {

          ltp = p;

          isLive = true;

        }

      }



      // 2. Bar series from liveMinuteEngine for open price and 1m/5m velocities

      let barVolume = 0;

      if (liveMinuteEngine && liveMinuteEngine.symBars) {

        const bars = liveMinuteEngine.symBars.get(sym);

        if (bars && bars.length > 0) {

          for (const b of bars) { barVolume += (b.v || 0); }

          const lastBar = bars[bars.length - 1];

          if (ltp == null && lastBar.c > 0) {

            ltp = lastBar.c;

            isLive = true;

          }

          open = bars[0].o || lastBar.o;

          if (ltp != null && open > 0) {

            movePct = +(((ltp - open) / open) * 100).toFixed(2);

          }



          // 1-minute velocity move calculated against live LTP

          const prevBar = bars.length >= 2 ? bars[bars.length - 2] : null;

          if (prevBar && prevBar.c > 0 && ltp != null) {

            move1mPct = +(((ltp - prevBar.c) / prevBar.c) * 100).toFixed(2);

          } else if (lastBar.o > 0 && ltp != null) {

            move1mPct = +(((ltp - lastBar.o) / lastBar.o) * 100).toFixed(2);

          }



          // 5-minute velocity move calculated against live LTP
          const last5Bars = bars.slice(-5);
          let range5mPct = 0;
          if (last5Bars.length >= 2) {
            const h5 = Math.max(...last5Bars.map(b => b.h || b.c || 0));
            const l5 = Math.min(...last5Bars.map(b => (b.l > 0 ? b.l : (b.c || b.o))));
            if (l5 > 0) range5mPct = +(((h5 - l5) / l5) * 100).toFixed(2);
          }

          const p5 = bars[Math.max(0, bars.length - 6)];

          if (p5 && p5.o > 0 && ltp != null) {

            move5mPct = +(((ltp - p5.o) / p5.o) * 100).toFixed(2);

          }

        }

      }



      // 3. Fallback to cached SmartAPI stock quotes

      const cq = _catalystStockQuotes && _catalystStockQuotes[sym];

      const changePct = cq && cq.changePct != null ? Number(cq.changePct) : 0;

      const preMarketGapPct = (cq && cq.open && cq.close) ? +(((cq.open - cq.close) / cq.close) * 100).toFixed(2) : null;

      if (ltp == null && cq) {

        ltp = cq.ltp;

        open = cq.open || cq.close;

        movePct = cq.changePct != null ? cq.changePct : (open > 0 ? +(((ltp - open) / open) * 100).toFixed(2) : 0);

        isLive = true;

      }



      // 4. Fallback to historical closing price

      if (ltp == null) {

        try {

          if (!_prevCloses) _prevCloses = JSON.parse(fs.readFileSync('data/prev_closes_20261026.json', 'utf8'));

          if (_prevCloses[sym]) ltp = _prevCloses[sym];

        } catch (_) {}

      }



      // 5. HARD PENNY STOCK & LOW-VOLUME EXCLUSION (< ₹30 or Volume < 25,000 or numeric debt tickers)

      const effectivePrice = Number(ltp || (open != null && open > 0 ? open : null) || (cq && (cq.ltp || cq.close || cq.open)) || 0);

      const quoteVol = (cq && cq.volume != null && isFinite(cq.volume)) ? Number(cq.volume) : 0;

      const effectiveVolume = Math.max(barVolume, quoteVol);

      const isNumericTicker = /^\d+$/.test(sym);

      const isPennyStock = (effectivePrice > 0 && effectivePrice < 30.0) || effectivePrice <= 0 || isNumericTicker;

      const isLowVolume = effectiveVolume < 25000;

      const isDeadVolume = effectiveVolume <= 100;

      const isUntradeable = isPennyStock || isLowVolume || isDeadVolume;



      const isLowMomentum = Math.abs(move1mPct) < 0.15 && Math.abs(move5mPct) < 0.30 && Math.abs(movePct) < 0.50;

      const isConfirmedMomentum = (move1mPct >= 0.18 || move5mPct >= 0.35);



      const fallbackClose = (cq && cq.close) || null;
      const priceAtFiling = filingPriceTracker.recordAndGetFilingPrice(sym, c.ts, effectivePrice, open, fallbackClose);
      const postNewsMovePct = filingPriceTracker.computePostNewsMove(sym, c.ts, effectivePrice, open, fallbackClose);

      const pred = pmc.predictCatalyst(c, {
        movePct,
        dayMovePct: movePct,
        postNewsMovePct,
        priceAtFiling,
        move1mPct,
        move5mPct,
        range5mPct: typeof range5mPct !== 'undefined' ? range5mPct : 0,
        changePct,
        price: effectivePrice,
        volume: effectiveVolume,
        postNewsMovePct
      });



      // User rule: "if already filled dont give"

      let isAlreadyFilled = false;

      if (liveMinuteEngine) {

        if (liveMinuteEngine.calls && liveMinuteEngine.calls.size > 0) {

          for (const call of liveMinuteEngine.calls.values()) {

            if (call.symbol === sym && ['ARMED', 'FILLED', 'OPEN'].includes(call.status)) {

              isAlreadyFilled = true;

              break;

            }

          }

        }

        if (!isAlreadyFilled && liveMinuteEngine.closedCalls && liveMinuteEngine.closedCalls.length > 0) {

          for (const call of liveMinuteEngine.closedCalls) {

            if (call.symbol === sym) {

              isAlreadyFilled = true;

              break;

            }

          }

        }

      }



      if (isAlreadyFilled) {

        pred.takeTrade = false;

        pred.tradeStatus = 'ALREADY_FILLED';

        pred.badge = '✅ ALREADY FILLED';

        pred.rationale = `Trade on ${sym} already filled today by scalping engine. Re-entry strictly refused to prevent duplicate risk.`;

      }



      if (isUntradeable) {

        pred.prediction = isPennyStock ? 'NEUTRAL / UNTRADEABLE' : 'NEUTRAL / LOW VOLUME';

        pred.bias = 'NEUTRAL';

        pred.confidence = 0;

        pred.rationale = isPennyStock

          ? (isNumericTicker ? `Numeric debt instrument (${sym}) · Untradeable non-equity code.` : `Penny stock (₹${effectivePrice.toFixed(2)} < ₹30 floor) · Untradeable illiquid micro-cap; trade calls strictly refused.`)

          : `Low/Dead volume (${effectiveVolume.toLocaleString()} shares < 25,000) · Untradeable illiquid stock; trade calls strictly refused.`;

      }

      const cleanTitle = cleanSubject(c.title, c.description || c.text, sym, c.materiality);

      const itemCq = (_catalystStockQuotes && _catalystStockQuotes[sym]) || {};
      const auctionAssessment = pmc.evaluatePreMarketAuction(c, itemCq, new Date());

      let formattedFilingTime = c.filingTime;
      if (c.ts) {
        const dIst = new Date(Number(c.ts) + 330 * 60000);
        const timePart = dIst.toISOString().slice(11, 16) + ' IST';
        if (!isToday(c.ts)) {
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          formattedFilingTime = `${dIst.getUTCDate()} ${months[dIst.getUTCMonth()]} ${timePart}`;
        } else {
          formattedFilingTime = timePart;
        }
      }

      return Object.assign({}, c, {

        title: cleanTitle,

        auctionAssessment,

        ltp: ltp != null ? +ltp.toFixed(2) : null,

        open: open != null ? +open.toFixed(2) : null,

        preMarketGapPct,

        effectivePrice,

        volume: effectiveVolume,

        isPennyStock,

        isLowVolume,

        isUntradeable,

        isLowMomentum: pred.prediction === 'NEUTRAL / LOW MOMENTUM' || (isLowMomentum && !isConfirmedMomentum),

        isConfirmedMomentum,

        takeTrade: !!pred.takeTrade,

        tradeStatus: pred.tradeStatus || 'WATCH',

        badge: pred.badge || (pred.prediction === 'BUY / GO UP' ? '⚡ TAKE TRADE: BUY' : '👀 WATCH'),

        movePct,
        dayMovePct: movePct,
        postNewsMovePct,
        priceAtFiling,

        move1mPct,

        move5mPct,

        isLive,

        filingTime: formattedFilingTime || c.filingTime || 'Today',

        timeAgo: (c.ts ? (() => {

          const diffSec = Math.max(0, Math.round((Date.now() - Number(c.ts)) / 1000));

          if (diffSec < 60) return diffSec + 's ago';

          const diffMin = Math.round(diffSec / 60);

          if (diffMin < 60) return diffMin + 'm ago';

          const diffHr = Math.round(diffMin / 60);

          if (diffHr < 24) return diffHr + 'h ago';

          return Math.round(diffHr / 24) + 'd ago';

        })() : c.timeAgo || 'recent'),

        prediction: pred.prediction,

        bias: pred.bias,

        confidence: pred.confidence,

        recommendation: pred.recommendation || pred.prediction,

        probability: pred.probability != null ? pred.probability : pred.confidence,

        targetPct: pred.targetPct != null ? pred.targetPct : null,

        stopLossPct: pred.stopLossPct != null ? pred.stopLossPct : null,

        targetPrice: pred.targetPrice != null ? pred.targetPrice : null,

        stopLossPrice: pred.stopLossPrice != null ? pred.stopLossPrice : null,

        rrRatio: pred.rrRatio || null,

        fiveCandleVerdict: pred.fiveCandleVerdict || null,

        fiveCandleState: pred.fiveCandleState || null,

        fiveCandleRangePct: pred.fiveCandleRangePct != null ? pred.fiveCandleRangePct : (typeof range5mPct !== 'undefined' ? range5mPct : 0),

        financialComparison: pred.financialComparison || null,

        comparisonSummary: pred.comparisonSummary || null,

        strengthGrade: pred.strengthGrade || null,

        strengthScore: pred.strengthScore || null,

        rationale: cleanRationale(pred.rationale, pred.bias, c.materiality, cleanTitle, movePct, move1mPct),

        impactScore: c.impactScore || 0,

        matchedKeywords: c.matchedKeywords || [],

      });

    });



    // User rule: "keep only news to until it taken by market not 30min"

    // Unpriced catalysts remain active throughout the session until taken by the market (moved >= 1.2% or filled)

    const nowMs = Date.now();



    // Determine if Indian equity market is currently closed or in pre-market window

    // Phase 1 (15:30 to 09:08): Overnight collection & Top 5 for 09:08 AM open

    // Phase 2 (09:08 to 15:30): Live session Top 5 updated EVERY SECOND

    const isPreMarketWindow = (() => {

      const d = new Date(nowMs + 330 * 60000);

      const day = d.getUTCDay();

      if (day === 0 || day === 6) return true;

      const tNum = d.getUTCHours() * 100 + d.getUTCMinutes();

      return tNum < 908 || tNum >= 1530;

    })();



    const isClosed = (() => {

      const d = new Date(nowMs + 330 * 60000);

      const day = d.getUTCDay();

      if (day === 0 || day === 6) return true;

      const tNum = d.getUTCHours() * 100 + d.getUTCMinutes();

      return tNum < 915 || tNum >= 1530;

    })();



// session time bounds moved to top of handler



    // PRIORITY RANKING: HIGHEST PROBABILITY FIRST IF MARKET CLOSED, FRESH SESSION NEWS FIRST IF OPEN

    const getPriorityRank = (c) => {

      // PENNY STOCK / ILLIQUID TRAP: Never rank untradeable or low-volume penny stocks into actionable tiers

      if (c.isPennyStock || c.isUntradeable || c.volume < 25000 || (c.effectivePrice > 0 && c.effectivePrice < 30.0)) return 0;



      if (isClosed) {

        // MARKET CLOSED: Priority is Highest Probability & Directional Conviction for 09:00 AM Open!

        const conf = Number(c.confidence || 60);

        const isActionable = c.prediction && (c.prediction.includes('BUY') || c.prediction.includes('SELL'));

        if (isActionable && conf >= 88) return 10;

        if (isActionable && conf >= 80) return 9;

        if (isActionable && conf >= 70) return 8;

        if (conf >= 70) return 7;

        return 1;

      }



      // MARKET OPEN:

      const v1 = Math.abs(Number(c.move1mPct || 0));

      const v5 = Math.abs(Number(c.move5mPct || 0));

      const ts = Number(c.ts || 0);

      const isActionable = c.prediction && (c.prediction.includes('BUY') || c.prediction.includes('SELL'));

      const isSession = isSessionFiling(ts);



      // TIER 1 (TOP PRIORITY): Fresh session news filed today with Actionable BUY/SELL AND confirmed momentum!

      if (isSession && isActionable && (v1 >= 0.18 || v5 >= 0.35 || c.isConfirmedMomentum)) return 10;

      // TIER 2: Fast Live Movers (|v1| >= 0.25% or |v5| >= 0.40%) with confirmed volume!

      if ((v1 >= 0.25 || v5 >= 0.40) && !c.isUntradeable && c.volume >= 20000) return 9;

      // TIER 3: Breaking session news awaiting volume burst (< 3 minutes old)

      if (isSession && (nowMs - ts) < 180000 && !c.isUntradeable) return 8;

      // TIER 4: Other fresh session filings from today

      if (isSession && !c.isUntradeable && !c.isLowMomentum) return 7;

      // TIER 5: Low-momentum or overnight filings (demoted to bottom)

      return 1;

    };



    enriched.sort((a, b) => {

      const rankA = getPriorityRank(a);

      const rankB = getPriorityRank(b);



      if (rankB !== rankA) {

        return rankB - rankA;

      }



      if (isClosed) {

        // When market is closed:

        // 1. Highest confidence descending

        const confA = Number(a.confidence || 60);

        const confB = Number(b.confidence || 60);

        if (confB !== confA) return confB - confA;



        // 2. Newest filing timestamp descending

        const tsA = Number(a.ts || 0);

        const tsB = Number(b.ts || 0);

        if (tsB !== tsA) return tsB - tsA;



        return String(a.symbol || '').localeCompare(String(b.symbol || ''));

      }



      // Inside Today's Fresh News tiers (ranks 9 and 10): Sort by newest filing timestamp first!

      if (rankA >= 9) {

        const tsA = Number(a.ts || 0);

        const tsB = Number(b.ts || 0);

        if (tsB !== tsA) return tsB - tsA;

      }



      // Inside 1-minute heavy mover tier (rank 8): Sort by highest 1m velocity!

      if (rankA === 8) {

        const v1A = Math.abs(Number(a.move1mPct || 0));

        const v1B = Math.abs(Number(b.move1mPct || 0));

        const bandA = Math.floor(v1A / 0.15);

        const bandB = Math.floor(v1B / 0.15);

        if (bandB !== bandA) return bandB - bandA;

      }



      // Fallback: newest news first

      const tsA = Number(a.ts || 0);

      const tsB = Number(b.ts || 0);

      if (tsB !== tsA) return tsB - tsA;



      return String(a.symbol || '').localeCompare(String(b.symbol || ''));

    });



    const fastMovers = enriched.filter(c => Math.abs(c.move5mPct) >= 0.35 || Math.abs(c.movePct) >= 0.50);

    const overnightBatch = pmc.getOvernightCatalystBatch(undefined, _catalystStockQuotes);



    // Compute dynamic top banner candidate:

    // User rule: "keep only news to until it taken by market not 30min if no news keep empty in live if already filled dont give"

    let topBannerPick = null;

    if (isClosed) {

      topBannerPick = overnightBatch && overnightBatch.topPick ? Object.assign({}, overnightBatch.topPick) : null;

    } else {

      // 1. Session News with Confirmed Momentum and Liquidity

      // Gated by: takeTrade === true, not already moved, not already filled today

      const freshNews = enriched.filter(c =>

        !c.isPennyStock &&

        !c.isUntradeable &&

        c.effectivePrice >= 20.0 &&

        c.volume >= 20000 &&

        isSessionFiling(c.ts) &&

        c.takeTrade === true &&

        c.tradeStatus !== 'ALREADY_FILLED' &&

        c.tradeStatus !== 'ALREADY_MOVED' &&

        c.tradeStatus !== 'STALE_YESTERDAY' &&

        !alreadyFilledSymbols.has(c.symbol) &&

        (c.isConfirmedMomentum || Math.abs(c.move1mPct) >= 0.18 || Math.abs(c.move5mPct) >= 0.35) &&

        (c.prediction && !c.prediction.includes('NEUTRAL') && !c.prediction.includes('UNTRADEABLE'))

      );



      if (freshNews.length > 0) {

        freshNews.sort((a, b) => {

          const confDiff = Number(b.confidence || 0) - Number(a.confidence || 0);

          if (confDiff !== 0) return confDiff;

          return Number(b.ts || 0) - Number(a.ts || 0);

        });

        const fn = freshNews[0];

        const isUp = fn.direction === 'UP' || fn.bias === 'BULLISH';

        topBannerPick = Object.assign({}, fn, {

          bannerMode: 'LIVE_NEW_NEWS',

          bannerTitle: '⚡ FRESH BREAKING NEWS CATALYST (CONFIRMED MOMENTUM)',

          badgeLabel: `🔥 TODAY ${fn.filingTime || 'LIVE'} · ACTIVE BREAKOUT`,

          actionLabel: 'LIVE PRE-MOVE ACTION PLAN',

          livePlan: isUp

            ? `${fn.symbol} filed high-conviction catalyst today (${fn.filingTime || 'live'}) with confirmed momentum. Enter on 1m/5m breakout pullback.`

            : `${fn.symbol} filed negative catalyst today (${fn.filingTime || 'live'}). Watch for breakdown below VWAP; avoid buying.`

        });

      } else {

        // User rule: "if no news keep empty in live"

        // NO VELOCITY FALLBACK: Keep top banner empty when no actionable session news exists!

        topBannerPick = null;

      }

    }

    if (overnightBatch) {

      overnightBatch.topBannerPick = topBannerPick;

    }



    const preMarketCallsModule = require('./common/market/preMarketCalls');

    const preMarketCalls = preMarketCallsModule.loadCachedPreMarketCalls();



    const showAll = req.query.includeUntradeable === 'true';

    const cleanCatalysts = showAll ? enriched : enriched.filter(c => {

      // User rule: "from that remove before 3 30 news i said daily but u not removing"

      // When market is closed (post-3:30 PM, overnight, morning before 09:15), remove all news filed before 15:30 IST!

      if (isClosed && req.query.includeBeforeClose !== 'true') {

        const dProbe = new Date(nowMs + 330 * 60000);

        const tNum = dProbe.getUTCHours() * 100 + dProbe.getUTCMinutes();

        let closeDate = new Date(dProbe.getTime());

        if (tNum < 1530) closeDate.setUTCDate(closeDate.getUTCDate() - 1);

        while (closeDate.getUTCDay() === 0 || closeDate.getUTCDay() === 6) closeDate.setUTCDate(closeDate.getUTCDate() - 1);

        const closeCutoffTs = Date.UTC(closeDate.getUTCFullYear(), closeDate.getUTCMonth(), closeDate.getUTCDate(), 10, 0, 0) - 20 * 60000; // 15:10 IST (20-min buffer)

        if (Number(c.ts || c.firstSeenAt || 0) < closeCutoffTs) {

          return false;

        }

      }

      // Keep any news filed today (from 00:00 to now) so live news wire stays 100% visible

      const isFreshNews = isToday(c.ts);

      if (isFreshNews && !c.isPennyStock) return true;

      // During active session, do not pollute live scalping board with yesterday's stale filings
      if (!isClosed && !isFreshNews) return false;

      return !c.isUntradeable && !c.isPennyStock && !c.isLowVolume;

    });



    // User rule: "Only keep five and five will be set in one row."

    // Select strictly the Top 5 High-Probability Catalysts with 09:08 AM Pre-Market Auction Assessment

    const seenSymbols = new Set();

    const qualifiedMovers = [];

    for (const c of cleanCatalysts) {

      if (!c || !c.symbol || seenSymbols.has(c.symbol)) continue;

      const price = Number(c.ltp || c.price || c.effectivePrice || 0);

      const vol = Number(c.volume || c.effectiveVolume || 0);

      if (price > 0 && price < 30.0) continue; // Penny stock floor

      if (vol > 0 && vol < 25000) continue; // Illiquid filter

      const isDivAction = /dividend|bonus|split|buyback|capital/i.test((c.kind || '') + ' ' + (c.title || '') + ' ' + (c.description || ''));

      if (!isDivAction && ['ROUTINE_DISCLOSURE', 'ROUTINE_LAND_ACQUISITION', 'REGULATORY_ORDER', 'RESULTS_UNCERTAIN'].includes(c.tradeStatus)) {

        continue;

      }

      if (!isDivAction && /record date|superannuation|tax deduction at source|tds/i.test((c.kind || '') + ' ' + (c.title || ''))) {

        continue;

      }

      const prob = Number(c.confidence || c.probability || 0);

      if (prob < 65) continue;



      seenSymbols.add(c.symbol);

      const cq = (_catalystStockQuotes && _catalystStockQuotes[c.symbol]) || {};

      const assessment = pmc.evaluatePreMarketAuction(c, cq);

      qualifiedMovers.push(Object.assign({}, c, {

        probability: prob,

        auctionAssessment: assessment

      }));

    }



    qualifiedMovers.sort((a, b) => {
      const tsA = Number(a.ts || 0);
      const tsB = Number(b.ts || 0);
      const isFreshA = (nowMs - tsA) <= 45 * 60000;
      const isFreshB = (nowMs - tsB) <= 45 * 60000;
      if (isFreshA && !isFreshB) return -1;
      if (isFreshB && !isFreshA) return 1;
      if (isFreshA && isFreshB) {
        if (tsB !== tsA) return tsB - tsA;
      }
      if (b.probability !== a.probability) return b.probability - a.probability;
      return tsB - tsA;
    });

    let top5Catalysts = [];

    if (isPreMarketWindow) {

      // PHASE 1 (15:30 to 09:08 AM): Top 5 for Tomorrow at 09:08 AM

      // High-probability overnight catalysts evaluated with 09:08 IEP auction rules:

      // - Sweet spot gap (+0.8% to +3.5%): Momentum Buy

      // - Large gap-up (> +3.5%): Gap-Fill Fade Reversal Short

      if (overnightBatch && overnightBatch.top5Movers && overnightBatch.top5Movers.length > 0) {

        top5Catalysts = overnightBatch.top5Movers.slice(0, 5);

      } else {

        top5Catalysts = qualifiedMovers.slice(0, 5);

      }

    } else {

      // PHASE 2 (09:08 AM to 15:30 PM): Live Top 5 Actionable Trades (BUY or SELL)!
      // 1. First priority: Candidates with takeTrade === true (Actionable BUY or Actionable SELL)
      // 2. Second priority: High-velocity live movers (|v1| >= 0.20% or |v5| >= 0.35%) with clear directional conviction
      // 3. Exclude: Routine disclosures, untradeables, penny stocks, already moved / exhausted traps
      const actionableTrades = cleanCatalysts.filter(c =>
        c && c.symbol &&
        !c.isUntradeable && !c.isPennyStock &&
        (Number(c.ltp || c.effectivePrice || 0) >= 30.0) &&
        (Number(c.volume || c.effectiveVolume || 0) >= 20000) &&
        !['ROUTINE_DISCLOSURE', 'ROUTINE_LAND_ACQUISITION', 'REGULATORY_ORDER', 'STALE_YESTERDAY'].includes(c.tradeStatus) &&
        c.prediction && !c.prediction.includes('ROUTINE') && !c.prediction.includes('UNTRADEABLE') &&
        (c.takeTrade === true || (c.prediction && (c.prediction.includes('BUY') || c.prediction.includes('SELL'))))
      );

      // Sort actionable trades: Verified takeTrade first, highest probability / confidence first, then newest
      actionableTrades.sort((a, b) => {
        const tradeA = a.takeTrade ? 1 : 0;
        const tradeB = b.takeTrade ? 1 : 0;
        if (tradeB !== tradeA) return tradeB - tradeA;
        const confA = Number(a.confidence || a.probability || 0);
        const confB = Number(b.confidence || b.probability || 0);
        if (confB !== confA) return confB - confA;
        return Number(b.ts || 0) - Number(a.ts || 0);
      });

      const liveTop5 = [];
      const seenLive = new Set();
      for (const c of actionableTrades) {
        if (!c || !c.symbol || seenLive.has(c.symbol)) continue;
        seenLive.add(c.symbol);
        const cq = (_catalystStockQuotes && _catalystStockQuotes[c.symbol]) || {};
        const assessment = pmc.evaluatePreMarketAuction(c, cq);
        liveTop5.push(Object.assign({}, c, {
          auctionAssessment: assessment
        }));
        if (liveTop5.length >= 5) break;
      }
      if (liveTop5.length >= 5) {
        top5Catalysts = liveTop5.slice(0, 5);
      } else {
        const nonRoutineMovers = qualifiedMovers.filter(q =>
          q && !seenLive.has(q.symbol) &&
          !['ROUTINE_DISCLOSURE', 'ROUTINE_LAND_ACQUISITION', 'REGULATORY_ORDER', 'STALE_YESTERDAY'].includes(q.tradeStatus) &&
          q.prediction && !q.prediction.includes('ROUTINE') && !q.prediction.includes('UNTRADEABLE')
        );
        top5Catalysts = liveTop5.concat(nonRoutineMovers).slice(0, 5);
      }

    }

    // User directive: Strict chronological sort for live exchange wire (newest on top)
    const allFilingsStrictDesc = [...cleanCatalysts].sort((a, b) => {
      const tsA = Number(a.ts || 0);
      const tsB = Number(b.ts || 0);
      if (tsB !== tsA) return tsB - tsA;
      return String(a.symbol || '').localeCompare(String(b.symbol || ''));
    });

    const payload = {

      ok: true,

      day,

      count: top5Catalysts.length,

      totalTracked: enriched.length,

      catalysts: top5Catalysts,

      top5Catalysts,

      allFilings: allFilingsStrictDesc,

      overnightBatch,

      topBannerPick,

      preMarketCalls,

      fastMovers,

      highPriority: cleanCatalysts.filter(c => c.isHighPriority),

    };

    _catalystsResponseCache = {
      time: Date.now(),
      key: cacheKey,
      data: payload
    };

    return res.json(payload);

  } catch (err) {

    return res.status(500).json({ ok: false, error: err.message });

  }

});



// 09:08 AM Pre-Market IEP Auction Confirmed Calls

app.get('/api/scalping/pre-market-calls', async (req, res) => {

  try {

    const pmc = require('./common/market/preMarketCalls');

    const force = req.query.refresh === 'true';

    let data = !force ? pmc.loadCachedPreMarketCalls() : null;

    if (!data) {

      data = await pmc.generatePreMarketCalls(new Date(), _catalystStockQuotes);

    }

    return res.json({ ok: true, data });

  } catch (err) {

    return res.status(500).json({ ok: false, error: err.message });

  }

});



// Post-market close (15:30 IST) classified watchlist for tomorrow

app.get('/api/scalping/tomorrow-watchlist', (req, res) => {

  try {

    const tomorrowWatchlist = require('./common/news/tomorrowWatchlist');

    const day = req.query.day;

    const force = req.query.force === 'true';

    const filePath = path.join(__dirname, 'data', 'news', 'tomorrow_watchlist.json');

    let data;

    if (force || !fs.existsSync(filePath)) {

      data = tomorrowWatchlist.generate(day);

    } else {

      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    }

    return res.json({ ok: true, ...data });

  } catch (err) {

    return res.status(500).json({ ok: false, error: err.message });

  }

});



app.get(['/scalping', '/scalping.html'], (req, res) => {

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  res.sendFile(path.join(__dirname, 'public', 'scalping.html'));

});



app.get('/api/scalp/board', (req, res) => {

  const file = path.join(__dirname, 'data', 'terminal', 'scalp-board.json');

  try {

    if (!fs.existsSync(file)) {

      return res.json({ generatedAt: new Date().toISOString(), module: 'scalping (not armed)', columns: [], rows: [], note: 'start the server with GB_SCALPING=1' });

    }

    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// Today's generated scalping signals with their exact inputs (raw ROC10/ROC20).

app.get('/api/scalp/signals', (req, res) => {

  const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

  const file = path.join(__dirname, 'data', 'scalping', 'signals-' + day + '.jsonl');

  try {

    if (!fs.existsSync(file)) return res.json({ day, count: 0, signals: [] });

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

    const limit = Math.min(Number(req.query.limit) || 200, 2000);

    const signals = lines.slice(-limit)

      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })

      .filter(Boolean);

    res.json({ day, count: lines.length, signals });

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// Forward outcomes for the scalping signals: win rate, R, MFE/MAE, expectancy,

// cost-adjusted expectancy and performance by ROC magnitude. Research only.

app.get('/api/scalp/outcomes', (req, res) => {

  const file = path.join(__dirname, 'data', 'terminal', 'scalp-v1-outcomes.json');

  try {

    if (!fs.existsSync(file)) {

      return res.json({ label: 'EXPERIMENTAL ROC SCALPING V1', count: 0, note: 'no settled outcomes yet' });

    }

    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// ---- EXPERIMENTAL ROC V2 (MOMENTUM vs REVERSAL) — its own board + outcomes ----

app.get('/api/scalp/v2/board', (req, res) => {

  const file = path.join(__dirname, 'data', 'terminal', 'scalp-v2-board.json');

  try {

    if (!fs.existsSync(file)) {

      return res.json({ label: 'EXPERIMENTAL ROC V2 — MOMENTUM vs REVERSAL', columns: [], rows: [], note: 'start the server with GB_SCALPING_V2=1' });

    }

    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



app.get('/api/scalp/v2/outcomes', (req, res) => {

  const file = path.join(__dirname, 'data', 'terminal', 'scalp-v2-outcomes.json');

  try {

    if (!fs.existsSync(file)) {

      return res.json({ label: 'EXPERIMENTAL ROC V2 — MOMENTUM vs REVERSAL', count: 0, note: 'no settled outcomes yet' });

    }

    res.json(JSON.parse(fs.readFileSync(file, 'utf8')));

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// The engine catalogue and its measured record — the Board's "Live Calls"

// panel reads the tuned numbers rather than re-deriving them.

// THE RULE IS READ FROM THE MEASUREMENT, NOT FROM THE SNAPSHOT.

//

// This route used to take `rule` out of data/terminal/board.json, which is only

// rewritten when a scan runs. The snapshot on disk was built 2026-10-16, so after

// OF03 was retightened and re-measured on 2026-10-17 this route kept publishing the

// OLD configuration (87 trades · netPF 1.383) while data/terminal/backtest_results

// .json held the shipped one (19 trades · netPF 2.093). A page must not describe a

// configuration that is not on disk. The arithmetic lives in strategy-core/engines

// (measuredRules), so the builder and this route cannot drift apart.

let _rulesCache = { mtimeMs: 0, rules: null };

function measuredRulesFromDisk() {

  const file = path.join(__dirname, 'data', 'terminal', 'backtest_results.json');

  try {

    const st = fs.statSync(file);

    if (_rulesCache.rules && _rulesCache.mtimeMs === st.mtimeMs) return _rulesCache;

    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

    const rules = measuredRules(parsed);

    _rulesCache = { mtimeMs: st.mtimeMs, rules, measuredAt: parsed.generatedAt || null };

    return _rulesCache;

  } catch (_) {

    return { rules: null, measuredAt: null };

  }

}



app.get('/api/terminal/strategies', (req, res) => {

  const snap = readBoard();

  // The catalogue comes from the ONE registry (strategy-core/engines.js) — this

  // route used to carry its own list of module paths, which is the same list the

  // harness and the board builder each kept a copy of.

  const fresh = measuredRulesFromDisk();

  const engines = engineCatalogue().map((e) => {

    const rule = fresh.rules

      ? fresh.rules.find((r) => r.engine === e.key)

      : (snap && snap.rules ? snap.rules.find((r) => r.engine === e.key) : null);

    return Object.assign({}, e, { rule: rule || null });

  });

  res.json({

    generatedAt: new Date().toISOString(),

    engines,

    // WHERE THE NUMBERS CAME FROM, so a stale page is diagnosable: 'artifact' means

    // read now from backtest_results.json; 'snapshot' means no artifact was found

    // and the last scan's frozen copy was served instead.

    rulesSource: fresh.rules ? 'artifact' : 'snapshot',

    backtest: fresh.rules ? { generatedAt: fresh.measuredAt, corpus: snap ? (snap.backtest || {}).corpus : null } : (snap ? snap.backtest : null),

    speakRule: 'only a strategy whose measured NET profit factor clears 1.5 on at least 30 resolved trades may speak',

  });

});



// ===========================================================================

// THE POSITIVE / NEGATIVE LEDGER — every strategy, classified, with history.

// ===========================================================================

// ONE answer to "which strategies are net-positive after cost?", built from the

// records that already exist (see strategy-core/strategyLedger.js). The page's

// two side bars and the Telegram gate both read THIS route, so the sidebar, the

// stored history and what reaches the phone cannot disagree.

//

// The route STORES today's row as a side effect (`recordDay` is idempotent by

// date and writes nothing when the numbers have not moved), so opening the board

// is what keeps the history alive. `?store=0` disables it, `?history=N` limits

// the days returned.

app.get('/api/terminal/strategies/ledger', (req, res) => {

  try {

    const led = strategyLedger.build();

    if (req.query.store !== '0') strategyLedger.recordDay(led);

    const days = Math.max(1, Math.min(Number(req.query.history) || 30, 400));

    const hist = strategyLedger.history(days);

    const { byId, ...rest } = led;

    res.json(Object.assign(rest, {

      history: { savedAt: hist.savedAt, back: hist.back, days: hist.days, byStrategy: hist.byStrategy },

    }));

  } catch (e) {

    res.status(500).json({ error: e.message, note: 'the ledger could not be built from the measured records on disk' });

  }

});



// ===========================================================================

// TERMINAL — the PLAN AUDIT. Every number, the working, and the code.

// ===========================================================================

// A plan is a claim about arithmetic, so the Terminal must be able to check one

// rather than trust it. `strategy-core/audit.js` recomputes the stop, the

// targets and the R:R STEP BY STEP from the raw material the call carries, then

// compares its own result field by field against what tradePlanner actually

// returned. A disagreement is returned as MISMATCH and the page is required to

// show it — a wrong calculation fails loudly instead of quietly disagreeing.

//

// Computed per request, not stored: the audit is pure arithmetic, and baking one

// into the snapshot makes the polled payload ~865KB.

const auditCore = require('./strategy-core/audit');

const { catalogue: engineCatalogue, measuredRules, costLadderOf, liveEnabled, SWEEP_FVG_LIVE } = require('./strategy-core/engines');

let _codebook = null;

function codebook() { if (!_codebook) _codebook = auditCore.codebook(); return _codebook; }



/**

 * THE CALL BEHIND A DETAIL VIEW, however the page found its way here. The

 * snapshot carries `calls` (the ones the table needs) and `callsAll` (every

 * verdict the last build fired, raw material included) so a name whose call the

 * display cap dropped is still auditable. Without the second list, 780 of the

 * board's 854 rows had levels in the engine and no way to open their working.

 */

function findBoardCall(snap, lookup) {

  const all = [].concat(snap.calls || [], snap.callsAll || []);

  if (lookup.setupId) {

    const byId = all.find((c) => c.setupId === lookup.setupId);

    if (byId) return byId;

  }

  if (!lookup.symbol) return null;

  const mine = all.filter((c) => c.symbol === lookup.symbol);

  if (!mine.length) return null;

  // The best one for a symbol: an accepted call beats a refused one, then the

  // freshest decision bar.

  mine.sort((a, b) => (a.ok === b.ok ? (a.barsAgo - b.barsAgo) : (a.ok ? -1 : 1)));

  return mine[0];

}



/** The audit payload BOTH detail routes answer with — one shape, one renderer. */

function planPayload(snap, call) {

  let audit = null, error = null;

  try { audit = auditCore.planAudit(call); } catch (e) { error = e.message; }

  const cb = codebook();

  return {

    generatedAt: new Date().toISOString(),

    setupId: call.setupId,

    symbol: call.symbol,

    // WHETHER THIS IS A CALL AT ALL. `ok` alone is not the answer: a verdict that

    // passed its engine can still be silent (RULE_SILENT) or outside the entry

    // window, and its levels are arithmetic, not a direction. The page labels the

    // sheet from this field rather than inferring it from the numbers.

    isCall: call.status === 'BUY' || call.status === 'SHORT',

    call,

    audit,

    error,

    // THE ROW'S TAPE TRAVELS WITH ITS PLAN. The Board's row now carries only the

    // values that decide (call, entry, stop, T1, T2, R:R, risk); the tape — price,

    // move, volume, VWAP, POC, range, all three ROC horizons — plus the engine,

    // the bars-ago count and the gate/blocked reason live in this sheet's Tape tab.

    // It is read from the SAME snapshot row the table was rendering, so the sheet

    // cannot describe a different moment than the row it was opened from.

    tape: (function () {

      const row = (snap.rows || []).find((r) => r.symbol === call.symbol);

      if (!row) return null;

      return {

        symbol: row.symbol, price: row.price, changePct: row.changePct,

        vol1m: row.vol1m, volRatio: row.volRatio,

        vwap: row.vwap, vwapDistPct: row.vwapDistPct,

        poc: row.poc, pocDistPct: row.pocDistPct,

        rangePosPct: row.rangePosPct, roc: row.roc || null, flows: row.flows || null,

        signal: row.signal, engine: row.engine, setup: row.setup,

        gate: row.gate, blocked: !!row.blocked, blockReason: row.blockReason,

        lastBarTime: row.lastBarTime,

      };

    })(),

    // The code that produced THIS plan: the shared planner for every engine, the

    // fill rules for the backtest, and the engine's own rules. Printed from the

    // live functions, so it cannot drift from what ran.

    code: {

      shared: cb.shared,

      fill: cb.fill,

      engine: (cb.engines || {})[call.engine] || [],

      configs: {

        planner: cb.configs.planner,

        engine: (cb.configs || {})[call.engine] || null,

      },

    },

    method: (() => { const m = auditCore.backtestMethod(snap.backtest, cb); return m; })(),

    rules: snap.rules || [],

  };

}



app.get('/api/terminal/plan/:setupId', (req, res) => {

  const snap = readBoard();

  if (!snap) return res.status(404).json({ error: 'no board snapshot — build it first', hint: EMPTY_BOARD.hint });

  const wanted = String(req.params.setupId);

  const call = findBoardCall(snap, { setupId: wanted });

  if (!call) return res.status(404).json({ error: 'no such plan in the current snapshot', setupId: wanted });

  res.json(planPayload(snap, call));

});



// THE SAME SHEET, REACHED BY SYMBOL. A row whose verdict the snapshot's call cap

// dropped carries no setupId to open, only the symbol it belongs to — and every

// row has a DETAIL, so every row needs a way in.

app.get('/api/terminal/plan/by-symbol/:symbol', (req, res) => {

  const snap = readBoard();

  if (!snap) return res.status(404).json({ error: 'no board snapshot — build it first', hint: EMPTY_BOARD.hint });

  const symbol = String(req.params.symbol).toUpperCase();

  const call = findBoardCall(snap, { symbol });

  if (!call) return res.status(404).json({ error: 'no plan for this symbol in the current snapshot', symbol });

  res.json(planPayload(snap, call));

});



// HOW THE BACKTEST WAS RUN — the four rules, the live fill code, the corpus and

// every engine's measured record.

// ===========================================================================

// NEWS — what was said, and what the stock did next.

// ===========================================================================

// data/news/items.jsonl is written by scripts/newsHarvest.js, which pulls dated

// headlines out of Google News RSS. These routes only READ that store, plus

// data/news/reaction.json, which is the event study's measured answer to "the

// news came, then what happened".

//

// NOTHING HERE IS A SIGNAL. A headline is not a reason to buy: the store is a

// record of what was published, and the reaction file is a distribution of what

// happened after, so a claim about either one can be checked.

//

// ONE HONEST LIMIT, kept in the payload so the page cannot hide it: historical

// items carry a DATE but not a real time of day (Google normalizes old items to

// 08:00 GMT), so every reaction is a daily measurement, never an intraday one.

const newsStore = require('./common/news/newsStore');

// The ONE lean computation — /api/news/signals, the morning Telegram digest

// (cronJobs) and the tests all read it, so page and phone cannot disagree.

const newsSignalsMod = require('./common/news/newsSignals');

// PER-HEADLINE COMPANY MOVES: "this headline named TCS — how much did TCS move?"

// Precomputed by scripts/buildNewsMoves.js so a feed request is a lookup, not a

// walk over 834 daily bar files.

const newsMoves = require('./common/news/newsMoves');

// THE FLASH LANE — the exchange's own filing feed, timestamped to the second.

// Separate store, separate endpoint (/api/news/flash) and separate page tab: the

// archive above can say "this headline ran on Tuesday", this one can say "this

// filing landed four seconds ago", and merging the two would hide which is which.

const flashNews = require('./common/news/flashNews');

const fastWire = require('./common/news/fastWire');

const keyIdeaCalls = require('./common/news/keyIdeaCalls');

let _newsCache = { mtime: 0, items: [] };

function newsItems() {

  try {

    const st = fs.statSync(newsStore.FILES.items);

    if (st.mtimeMs !== _newsCache.mtime) _newsCache = { mtime: st.mtimeMs, items: newsStore.readItems() };

  } catch (e) {

    _newsCache = { mtime: 0, items: [] };

  }

  return _newsCache.items;

}



app.get('/api/news', (req, res) => {

  try {

    const { category, symbol, date, from, to, q } = req.query;

    const limit = Math.min(Number(req.query.limit) || 250, 3000);

    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // SINCE-LAST-CLOSE (the default view on the news page): only news published

    // at or after the most recent 15:30 IST close — what can still move the

    // next session. Everything before it already moved the market and is not

    // presented as live unless the reader asks for history.

    const close = sessionTiming.lastMarketClose();

    const sinceClose = String(req.query.sinceClose || '') === '1' || String(req.query.sinceClose || '') === 'true';

    let items = newsItems();

    if (sinceClose) items = items.filter((i) => Number.isFinite(i.ts) ? i.ts >= close.instant : i.date >= close.date);

    // GLOBAL → INDIA FILTER (the board's 🌍 chip): keep only the headlines

    // whose (category, direction) cleared the measured bridge gate — the same

    // rows the mapping section can act on, so the two views can never disagree.

    const wantGlobal = String(req.query.global || '') === '1' || String(req.query.global || '') === 'true';

    if (wantGlobal) {

      const gk = newsSignalsMod.passingBridgeKeys(items, new Date());

      items = items.filter((i) => gk.has(i.category + '_' + i.direction));

    }

    if (category && category !== 'all') items = items.filter((i) => i.category === category);

    if (symbol) items = items.filter((i) => (i.symbols || []).includes(String(symbol).toUpperCase()));

    if (date) items = items.filter((i) => i.date === date);

    if (from) items = items.filter((i) => i.date >= String(from));

    if (to) items = items.filter((i) => i.date <= String(to));

    if (q) {

      const needle = String(q).toLowerCase();

      items = items.filter((i) =>

        String(i.title).toLowerCase().includes(needle) ||

        (i.symbols || []).join(' ').toLowerCase().includes(needle));

    }

    items.sort((a, b) => b.ts - a.ts);

    const total = items.length;

    const page = items.slice(offset, offset + limit).map((i) => {
      let finComp = null;
      try {
        const fc = require('./common/news/financialComparison').compareFinancialMetrics(i.title + ' ' + (i.text || ''));
        if (fc && fc.hasFinancialData) finComp = fc;
      } catch (_) {}
      return {
        id: i.id, title: i.title, url: i.url, source: i.source,
        date: i.date, ts: i.ts, category: i.category, direction: i.direction,
        symbols: i.symbols || [],
        predict: predictFor(i),
        financialComparison: finComp,
      };
    });

    // HOW MUCH EACH NAMED COMPANY MOVED AFTER ITS OWN HEADLINE. Measured from

    // the daily bars: one row per (headline, company) pair, and a pair with no

    // bar is simply absent rather than shown as a zero.

    const mv = newsMoves.read();

    newsMoves.attach(page, mv);

    const lastSession = mv && mv.lastSession ? mv.lastSession : null;

    res.json({ generatedAt: new Date().toISOString(), total, offset, limit, count: page.length, items: page,

      sinceClose: { date: close.date, label: close.label },

      moves: {

        available: !!(mv && mv.byPair),

        lastSession,

        generatedAt: mv ? mv.generatedAt : null,

        note: lastSession

          ? 'the session after each headline, measured through ' + lastSession + '; a headline from today is measured after the close (scripts/topUpNewsBars.js)'

          : 'no company move measurement yet — run node scripts/buildNewsMoves.js',

      } });

  } catch (e) {

    res.status(500).json({ error: e.message, note: 'the news store could not be read' });

  }

});



app.get('/api/news/summary', (req, res) => {

  try {

    const items = newsItems();

    const sum = newsStore.summarize(items);

    const state = newsStore.readState();

    const reaction = newsStore.readReaction();

    // the count behind the board's 🌍 Global → India chip: how many stored

    // headlines belong to a (category, direction) class the bridge measured.

    const gk = newsSignalsMod.passingBridgeKeys(items, new Date());

    sum.globalLeanCount = items.reduce((n, i) => n + (gk.has(i.category + '_' + i.direction) ? 1 : 0), 0);

    res.json({

      generatedAt: new Date().toISOString(),

      source: 'Google News RSS (en-IN) — free, no key, honours after:/before:',

      limitNote: 'historical items carry a date, not a market time — every reaction is measured DAILY',

      categories: newsStore.CATEGORIES.map((c) => ({ id: c.id, label: c.label, blurb: c.blurb })),

      totals: sum,

      harvest: {

        lastRun: state.lastRun || null,

        chunksDone: Object.keys(state.cursor || {}).length,

        runs: state.runs || 0,

      },

      // EVERY COMPANY, AND WHAT ITS OWN NEWS DID TO IT — data/news/company_moves.json

      // (scripts/buildNewsMoves.js). This is the per-headline measurement, NOT the

      // event study: it describes what happened after stored headlines, while the

      // `reaction` block below stays on its declared learning window.

      moves: movesSummary(),

      reaction: reaction ? {

        generatedAt: reaction.generatedAt,

        window: reaction.window,

        horizons: reaction.horizons,

        byCategory: reaction.byCategory,

        byDirection: reaction.byDirection,

        overall: reaction.overall,

        control: reaction.control,

        counts: reaction.counts,

        method: reaction.method,

        note: reaction.note,

        // only the top rows: the full per-symbol list is on /api/news/reaction

        perSymbol: (reaction.perSymbol || []).slice(0, 120),

      } : { available: false, note: 'run scripts/newsEventStudy.js to measure the move after a headline' },

    });

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



// ---------------------------------------------------------------------------

// LIVE PULL — the news equivalent of a refresh button.

// ---------------------------------------------------------------------------

// The stored headlines are harvested month by month in the background, which

// makes the feed HISTORICAL until something asks Google for today. This spawns

// the same harvester in `--live` mode (current month, every category) so the

// page can pull right now.

//

// Two guards, because the browser is not the only caller: only one pull runs at

// a time, and a pull refuses to start within COOLDOWN_MS of the last one. That

// is what keeps a page that polls every 60 seconds from hammering the feed.

const { spawn } = require('child_process');

const NEWS_COOLDOWN_MS = 3 * 60 * 1000;

let _newsPull = { running: false, startedAt: null, lastDoneAt: null, lastAdded: null, lastError: null, runs: 0 };



function newsRefreshStatus() {

  const cooldownLeft = _newsPull.lastDoneAt

    ? Math.max(0, NEWS_COOLDOWN_MS - (Date.now() - Date.parse(_newsPull.lastDoneAt)))

    : 0;

  return Object.assign({}, _newsPull, { cooldownMs: Math.round(cooldownLeft) });

}



app.get('/api/news/refresh/status', (req, res) => {

  // THE GATE'S OWN FRESHNESS, ANSWERABLE FROM OUTSIDE.

  // The KI01 news gate reads data/terminal/keyidea_news_index.json and nothing rebuilt it

  // in production, so a stale cache was invisible: the gate simply stopped seeing the news

  // it was written to see. This reports the build time, its age and the newest record, and

  // (below) an on-demand rebuild.

  let keyideaIndex = null;

  try {

    // The KI01 news index was deleted with the keyidea engine on 2026-10-31; this route reports
    // the (now meaningless) status object rather than failing on a missing module.
    throw new Error('intraday removed: strategies/keyidea was deleted on 2026-10-31');

    const ni = require('./strategies/keyidea/newsIndex');

    keyideaIndex = ni.coverage();

  } catch (e) {

    keyideaIndex = { built: false, error: e.message };

  }

  // The measured reaction table has the same failure mode (a cache nobody rebuilds), so its

  // build time travels with the answer.

  let reaction = null;

  try {

    const nr = newsReaction();

    reaction = nr ? nr.coverage() : { built: false };

  } catch (e) {

    reaction = { built: false, error: e.message };

  }

  res.json(Object.assign(newsRefreshStatus(), { keyideaIndex, reaction }));

});



// REBUILD THE GATE INDEX NOW — the manual equivalent of the 10-minute cron. Used after a

// flash burst (a results season evening) so the next session's gate is not reading

// yesterday's copy.

let _newsIndexRebuild = { running: false, startedAt: null, lastDoneAt: null, lastResult: null, lastError: null };

app.post('/api/news/index/rebuild', (req, res) => {

  if (_newsIndexRebuild.running) return res.json(Object.assign({}, _newsIndexRebuild, { note: 'already rebuilding' }));

  try {

    const { spawn } = require('child_process');

    const child = spawn(process.execPath, [path.join(__dirname, 'strategies', 'keyidea', 'newsIndex.js'), '--build'], {

      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],

    });

    _newsIndexRebuild = { running: true, startedAt: new Date().toISOString(), lastDoneAt: _newsIndexRebuild.lastDoneAt, lastResult: null, lastError: null };

    let tail = '';

    child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });

    child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });

    child.on('close', (code) => {

      _newsIndexRebuild.running = false;

      _newsIndexRebuild.lastDoneAt = new Date().toISOString();

      if (code === 0) {

        const first = tail.split('\n').find(Boolean) || null;

        _newsIndexRebuild.lastResult = first;

        // Drop the module's in-process cache so the next gate call reads the new file.

        try { delete require.cache[require.resolve('./strategies/keyidea/newsIndex')]; } catch (_) {}

      } else {

        _newsIndexRebuild.lastError = tail.split('\n').filter(Boolean).slice(-2).join(' | ') || ('exit ' + code);

      }

      console.log('[news] KI01 index rebuild finished (' + code + '): ' + (_newsIndexRebuild.lastResult || _newsIndexRebuild.lastError));

    });

    res.json({ started: true, startedAt: _newsIndexRebuild.startedAt });

  } catch (e) {

    _newsIndexRebuild.running = false;

    _newsIndexRebuild.lastError = e.message;

    res.status(500).json({ error: e.message });

  }

});



/**

 * THE ONE PULL. The button used to own this body, which meant the ONLY way the

 * store ever got today's headlines was a human pressing it — and the store sat

 * from 2026-10-07 to 2026-10-20 with nothing new in it while the page faithfully

 * re-read the same stale file every 60 seconds. Both callers (the button and the

 * scheduler below) now go through this function, so there is one single-flight

 * guard and one cooldown no matter who asks.

 *

 * Returns the same payload the route always returned.

 */

function pullNewsLive(force) {

  if (_newsPull.running) {

    return Object.assign({ started: false, reason: 'a live pull is already running' }, newsRefreshStatus());

  }

  const cooldownLeft = _newsPull.lastDoneAt

    ? NEWS_COOLDOWN_MS - (Date.now() - Date.parse(_newsPull.lastDoneAt))

    : 0;

  if (cooldownLeft > 0 && !force) {

    return Object.assign({ started: false, reason: 'pulled recently — cooling down' }, newsRefreshStatus());

  }

  _newsPull = { running: true, startedAt: new Date().toISOString(), lastDoneAt: _newsPull.lastDoneAt, lastAdded: null, lastError: null, runs: (_newsPull.runs || 0) + 1 };

  const before = newsItems().length;

  const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'newsHarvest.js'), '--live', '--delay=900'], {

    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],

  });

  let tail = '';

  child.stdout.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });

  child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });

  child.on('close', (code) => {

    _newsCache = { mtime: 0, items: [] }; // force the store to be re-read

    const after = newsItems().length;

    _newsPull = {

      running: false,

      startedAt: _newsPull.startedAt,

      lastDoneAt: new Date().toISOString(),

      lastAdded: after - before,

      lastError: code === 0 ? null : (tail.trim().split('\n').slice(-2).join(' ') || ('exit ' + code)),

      runs: _newsPull.runs,

    };

  });

  return Object.assign({ started: true, note: 'asking Google News for the current month, every category' }, newsRefreshStatus());

}



app.post('/api/news/refresh', (req, res) => res.json(pullNewsLive(req.query.force === '1')));



// FRESH NEWS WITHOUT A BUTTON. Opening the page shows whatever the store holds;

// the store is only as new as the last harvest, and nothing was harvesting. A

// warm-up pull shortly after boot and one every 30 minutes keep "today" in the

// store so the page's 60-second read loop always has something current to read.

// The single-flight guard and the 3-minute cooldown above are the rate limit — a

// browser that polls /api/news/refresh cannot stack pulls on top of this.

// SPEED-UP 2026-10-29: reduced from 30 min to 5 min so the headline feed stays

// fresh on a quiet afternoon. The fast wire (fastWire.js) already covers the

// sub-minute tier; this pull covers the Google-News archive categories (results,

// deals, promoter, etc.) that the wire sources do not carry.

const NEWS_PULL_INTERVAL_MS = 5 * 60 * 1000;

setTimeout(() => { try { pullNewsLive(false); } catch (e) { console.error('[News] boot pull failed:', e.message); } }, 45 * 1000);

setInterval(() => { try { pullNewsLive(false); } catch (e) { console.error('[News] scheduled pull failed:', e.message); } }, NEWS_PULL_INTERVAL_MS);

console.log('[News] live headline pull scheduled: once at boot (45s) and every ' + (NEWS_PULL_INTERVAL_MS / 60000) + ' min');



// ---------------------------------------------------------------------------

// THE FLASH LANE — exchange filings, polled in seconds.

//

// The Google-News harvester above is an ARCHIVE query: measured on 2026-10-21 its

// current-month "Q2 results" feed returned a newest item 129 minutes old and a

// median age of 94 hours, because Google ranks a month of stories by relevance.

// No polling interval fixes that. NSE's corporate-announcements feed answers with

// the ticker, the filing category and a timestamp to the second — the same minute

// we ask — so this is the lane that can actually say "something just happened".

//

// 20s while the session is open (the exchange publishes continuously, and a

// minute of lag is the difference between trading a filing and reading it); 5

// minutes outside it, when only the backlog changes.

// ---------------------------------------------------------------------------

const FLASH_OPEN_MS = 2 * 1000; // 2s during session for zero-lag exchange wire execution

const FLASH_CLOSED_MS = 4 * 1000; // 4s outside session for fast breaking evening/morning announcements

let _flash = { running: false, lastPollAt: null, lastOk: null, lastAdded: 0, lastError: null, polls: 0, latency: null };



// ARM TICK CAPTURE ON FILINGS. Set by armOrderflowCapture(); consumed by the poll below.

const { chooseFilingSymbols } = require('./common/news/filingCapture');

// MODE and CAPTURE_CORRELATION must match what armCapture.js subscribes with — a different

// mode would change what the tape records, and a different correlation id would silently

// switch the index feed's subscribers. Re-required here at module scope: armCapture's own

// require is function-scoped inside armOrderflowCapture and is not visible to this function.

const { MODE: ANGEL_MODE } = require('./angelone/marketFeed');

// `strategies/orderflow/armCapture.js` WAS DELETED on 2026-10-31 with the rest of the intraday
// stack. The identifier below is kept only so the (now inert) filings poll still parses; the
// capture it used to identify no longer subscribes to anything.
const CAPTURE_CORRELATION = 'gb-research';

let _tickCapture = null;

const FILING_CAPTURE_HEADROOM = 400;    // of Angel's 1,000-token session quota

let _filingCaptureState = { armedTotal: 0, lastArmAt: null, lastError: null, errors: 0 };



/**

 * ARM CAPTURE ON A FILING — plan of record: docs/NEWS-KEY-IDEA-AUDIT-2026-10-24.md §3.3.

 *

 * WHY. The capture's universe is FIXED at startup (board.okSymbols + the GB01 list, capped

 * by GB_TICK_CAPTURE_LIMIT). A filing on a name outside that list produced a headline and

 * NO TAPE — and ticks cannot be regenerated later. That is precisely the first minute the

 * audit measured as carrying 61-68% of the five-minute move, so it was being lost by

 * construction. Subscribing the name on arrival is the only way to keep it.

 *

 * THE DECISION IS NOT HERE. common/news/filingCapture.js decides WHICH names, purely, and

 * is tested there. This does the broker work only: resolve the token, register it with the

 * capture, subscribe on capture's OWN correlation id (never the index feed's), and remember

 * the symbol so a second filing cannot re-subscribe it.

 *

 * NEVER THROWS — a capture problem must not stop the flash lane from recording the headline,

 * and must never take the trading server down.

 */

function armFilingCapture(items) {

  try {

    if (!_tickCapture || !Array.isArray(items) || !items.length) return null;

    const { angel, capture, instrument, armed } = _tickCapture;

    const headroom = Math.max(0, Math.min(FILING_CAPTURE_HEADROOM, 1000 - armed.size));

    if (!headroom) return null;



    // IST is UTC+5:30 — the clock is read here rather than inside the pure chooser so the

    // chooser stays testable. Postclose means the reaction is TOMORROW's session, so

    // subscribing now buys tape for a session nobody is watching.

    const u = new Date();

    const nowMinutes = (u.getUTCHours() * 60 + u.getUTCMinutes() + 330) % 1440;



    // `nowMinutes` is the key the chooser reads (filingCapture.js:69). Passing a

    // differently-named key leaves it undefined, the session test never fires, and every

    // postclose filing arms tape nobody will watch — which is the whole point of the filter.

    const chosen = chooseFilingSymbols({ items, armed, maxArmed: headroom, nowMinutes });

    if (!chosen.symbols.length) return chosen;



    const resolved = [], unresolved = [];

    for (const sym of chosen.symbols) {

      let rec = null;

      try { rec = instrument.findEquity(sym, 'NSE'); } catch (_) { rec = null; }

      if (!rec || rec.token == null) { unresolved.push(sym); continue; }

      const token = String(rec.token);

      capture.register(token, sym);        // BEFORE the first tick, or the tape stores a number

      resolved.push(token);

      armed.add(sym);

      _filingCaptureState.armedTotal += 1;

    }



    const tokens = [...new Set(resolved)];

    if (tokens.length) {

      // SAME MODE AND CORRELATION AS THE BASE CAPTURE. Re-using the index feed's id would

      // silently switch its subscribers; a different mode would change what the tape

      // records for names it already carries.

      const mode = String(process.env.GB_CAPTURE_MODE || 'snap').toLowerCase() === 'quote'

        ? ANGEL_MODE.QUOTE : ANGEL_MODE.SNAP_QUOTE;

      angel.subscribeLiveAngel(tokens, { mode, correlationId: CAPTURE_CORRELATION });

      _filingCaptureState.lastArmAt = new Date().toISOString();

      console.log('[orderflow/capture] ARMED ' + tokens.length + ' filing symbol(s) on ' +

        CAPTURE_CORRELATION + ' (' + chosen.counts.material + ' material · ' +

        chosen.counts.alreadyArmed + ' already heard · ' + unresolved.length +

        ' unresolvable) — session total armed on filings: ' + _filingCaptureState.armedTotal);

    }

    if (unresolved.length) {

      console.log('[orderflow/capture] ' + unresolved.length +

        ' filing symbol(s) had no Angel token: ' + unresolved.slice(0, 5).join(', ') +

        (unresolved.length > 5 ? ',…' : ''));

    }

    return Object.assign({}, chosen, { resolved: tokens.length, unresolved });

  } catch (e) {

    _filingCaptureState.errors += 1;

    _filingCaptureState.lastError = (e && e.message) || String(e);

    return null;

  }

}



function getLiveQuoteForAlerter(sym) {
  let ltp = liveMinuteEngine && liveMinuteEngine.prevPrice ? liveMinuteEngine.prevPrice.get(sym) : null;
  let movePct = 0;
  let move1mPct = 0;
  let move5mPct = 0;
  let range5mPct = 0;
  let volume = 0;
  let last5Bars = null;

  if (liveMinuteEngine && liveMinuteEngine.symBars) {
    const bars = liveMinuteEngine.symBars.get(sym);
    if (bars && bars.length > 0) {
      const last = bars[bars.length - 1];
      const prev = bars.length >= 2 ? bars[bars.length - 2] : null;
      const prev5 = bars.length >= 6 ? bars[bars.length - 6] : (bars.length >= 2 ? bars[0] : null);
      const open = bars[0].o || last.c;
      if (open > 0) movePct = +(((last.c - open) / open) * 100).toFixed(2);
      if (prev && prev.c > 0) move1mPct = +(((last.c - prev.c) / prev.c) * 100).toFixed(2);
      if (prev5 && prev5.c > 0) move5mPct = +(((last.c - prev5.c) / prev5.c) * 100).toFixed(2);
      volume = bars.reduce((s, b) => s + (b.v || 0), 0);
      last5Bars = bars.slice(-5);
      if (last5Bars.length >= 2) {
        const h5 = Math.max(...last5Bars.map(b => b.h || b.c || 0));
        const l5 = Math.min(...last5Bars.map(b => (b.l > 0 ? b.l : (b.c || b.o))));
        if (l5 > 0) range5mPct = +(((h5 - l5) / l5) * 100).toFixed(2);
      }
    }
  }

  // Cached SmartAPI quote fallback when live bars not yet built for ticker
  if (!ltp && typeof _catalystStockQuotes !== 'undefined' && _catalystStockQuotes && _catalystStockQuotes[sym]) {
    const cq = _catalystStockQuotes[sym];
    ltp = cq.ltp || cq.close || 0;
    movePct = cq.changePct || 0;
    volume = cq.volume || 0;
  }

  return { ltp, movePct, move1mPct, move5mPct, range5mPct, volume, last5Bars };
}



async function pollFlashOnce() {

  if (_flash.running) return _flash;

  _flash.running = true;

  try {

    const r = await flashNews.poll();

    // ARM ON WHAT JUST ARRIVED. `poll` reports how many rows it appended but not which;

    // readRecent reads the same store the poll just wrote, so this sees the new rows.

    // Only material, in-session rows arm — that filter lives in chooseFilingSymbols.

    if (r && r.ok && r.added > 0) {

      const recent = flashNews.readRecent(30);

      armFilingCapture(recent);

      catalystAlerter.dispatchNewFilingAlerts(recent.slice(0, Math.max(5, r.added)), {

        getLtp: (sym) => liveMinuteEngine && liveMinuteEngine.prevPrice ? liveMinuteEngine.prevPrice.get(sym) : null,

        getQuote: getLiveQuoteForAlerter

      }).catch(e => console.error('[Server.js] Catalyst alert dispatch error:', e.message));

    }

    _flash = {

      running: false,

      lastPollAt: r.at,

      lastOk: !!r.ok,

      lastAdded: r.added || 0,

      lastError: r.ok ? null : (r.error || 'poll failed'),

      polls: (_flash.polls || 0) + 1,

      latency: r.latency || _flash.latency,

      newest: r.newest || _flash.newest || null,

    };

  } catch (e) {

    _flash = Object.assign({}, _flash, { running: false, lastPollAt: new Date().toISOString(), lastOk: false, lastError: e.message });

  }

  return _flash;

}



let _flashTimer = null;

function scheduleFlash() {

  const open = (() => { try { return sessionTiming.getSessionPhase().isSignalAllowed; } catch (e) { return false; } })();

  const ms = open ? FLASH_OPEN_MS : FLASH_CLOSED_MS;

  _flashTimer = setTimeout(async () => {

    await pollFlashOnce();

    scheduleFlash();

  }, ms);

  if (_flashTimer.unref) _flashTimer.unref();

}



// Payload ceiling for the flash lane. 400 rows is ~140 KB and comfortably covers a 6h

// window even on a results-season evening (338 filings on 2026-10-26).

const FLASH_MAX_ITEMS = Math.max(60, Number(process.env.GB_FLASH_MAX_ITEMS) || 400);



// THE MEASURED REACTION TABLE (common/news/newsReaction.js). Loaded lazily and never allowed

// to break a page: a missing table means "no prediction", not a failed request.

let _newsReaction = null;

function newsReaction() {

  if (_newsReaction === null) {

    try { _newsReaction = require('./common/news/newsReaction'); } catch (_) { _newsReaction = false; }

  }

  return _newsReaction || null;

}

function predictFor(item) {

  const r = newsReaction();

  if (!r || !item) return null;

  try {

    const p = r.predict({ category: item.category, direction: item.direction });

    return p ? Object.assign({}, p, { text: r.asText(p) }) : null;

  } catch (_) { return null; }

}



app.get('/api/news/live', (req, res) => {

  try {

    const p = path.join(__dirname, 'backtest', 'live_news.json');

    if (fs.existsSync(p)) {

      return res.json(JSON.parse(fs.readFileSync(p, 'utf8')));

    }

    return res.json({ ok: false, error: 'live_news.json not generated yet' });

  } catch (e) {

    res.status(500).json({ ok: false, error: e.message });

  }

});



// IS THE WIRE ACTUALLY FAST? A claim about latency is only worth the measurement beside it, so

// this endpoint answers per source: when it last answered, how long the fetch took, how stale its

// newest item already was when we saw it, and the lag distribution for rows that arrived AFTER

// this lane started (backlog excluded — see common/news/fastWire.js).

app.get('/api/news/wire/status', (req, res) => {

  try {

    const st = fastWire.stats();

    const items = newsItems().filter((i) => i && i.lane === 'wire');

    res.json(Object.assign({ ok: true, lane: 'wire', itemsInStore: items.length, latency: fastWire.latency(items, 720) }, st));

  } catch (e) {

    res.status(500).json({ ok: false, error: e.message });

  }

});



// THE LIVE STRIP FEED — news that has landed since a cursor, in seconds.

//

// `/api/news` re-reads and filters the whole store for a full table; that is the right shape for a

// 20-second redraw and the wrong one for a 3-second poll from a phone. This answers only "what is

// new since `since`": the wire lane serves it from an in-memory ring (no disk read at all), and the

// exchange lane is filtered out of flashNews' mtime-cached read. Nothing here touches the archive.

//

// `cursor` is the caller's high-water mark in `firstSeenAt` (arrival), never publication time — a

// story published an hour ago but found now must still arrive once. The page passes its own last

// cursor and gets the new high-water mark back, so a sleeping phone neither replays the day nor

// loses an item in the gap.

app.get('/api/news/stream', (req, res) => {

  try {

    const now = Date.now();

    // A cursor in the future (clock skew, or a page from another machine) is clamped to now; a

    // fresh page passes nothing and is given the last quarter hour, not the whole ring.

    const raw = Number(req.query.since);

    const cursor = Math.min(Number.isFinite(raw) && raw > 0 ? raw : now - 15 * 60000, now);

    const rows = [];

    // INSTANT CLASSIFICATION (2026-10-29): predict() is a table lookup in microseconds.

    // Every item in the stream gets up/down conviction at the moment it is served —

    // the browser shows the direction tag immediately, no second round-trip needed.

    const _rMod = newsReaction();

    function _streamPredict(cat, dir) {

      if (!_rMod) return null;

      try {

        const p = _rMod.predict({ category: cat, direction: dir });

        return p ? { dir: p.dir, minutes: p.minutes, pct: p.pct, n: p.n, agrees: p.agrees } : null;

      } catch (_) { return null; }

    }



    for (const r of fastWire.recentSince(cursor, 80)) {

      const _cat = r.category || 'other';

      const _dir = r.direction || 'NEUTRAL';

      rows.push({

        id: r.id, lane: 'wire', at: Number(r.firstSeenAt) || null, ts: Number(r.ts) || null,

        src: r.source || r.wireSource || 'wire',

        title: r.title, url: r.url || null,

        sym: (Array.isArray(r.symbols) && r.symbols[0]) || null,

        cat: _cat, dir: _dir,

        lagSec: Number.isFinite(Number(r.lagSec)) ? Number(r.lagSec) : null,

        // INSTANT UP/DOWN — measured reaction for this (category, direction) class

        predict: _streamPredict(_cat, _dir),

      });

    }

    for (const f of flashNews.readRecent(60)) {

      if (!(Number(f.firstSeenAt) > cursor)) continue;

      const _fcat = f.category || 'other';

      const _fdir = f.direction || 'NEUTRAL';

      rows.push({

        id: f.id, lane: 'flash', at: Number(f.firstSeenAt) || null, ts: Number(f.ts) || null,

        src: f.symbol ? ('NSE · ' + f.symbol) : 'NSE filing',

        title: f.title, url: f.url || null, sym: f.symbol || null,

        cat: _fcat, dir: _fdir,

        lagSec: Number.isFinite(Number(f.lagMs)) ? Math.round(Number(f.lagMs) / 1000) : null,

        // INSTANT CLASSIFICATION — materiality + prediction attached at serve time

        materiality: f.materiality || null,

        predict: _streamPredict(_fcat, _fdir),

        confidence: typeof f.confidence === 'number' ? f.confidence : null,

      });

    }

    rows.sort((a, b) => (a.at || 0) - (b.at || 0));

    const newest = rows.length ? rows[rows.length - 1].at : cursor;

    const st = fastWire.stats();

    // The exchange lane's own cadence, as the scheduler will use it right now (open vs closed).

    let flashMs = null;

    try { flashMs = sessionTiming.getSessionPhase().isSignalAllowed ? FLASH_OPEN_MS : FLASH_CLOSED_MS; } catch (e) { flashMs = null; }

    res.set('Cache-Control', 'no-store');

    res.json({

      ok: true,

      now,

      cursor: newest,

      count: rows.length,

      // A BURST IS CAPPED. After a long closed laptop the ring can hold a hundred new rows;

      // the strip shows the newest forty and the cursor still advances past all of them, so the

      // backlog is acknowledged rather than re-served forever.

      items: rows.slice(-40),

      dropped: Math.max(0, rows.length - 40),

      poll: { wireFastMs: fastWire.CONFIG.fastMs, wireSlowMs: fastWire.CONFIG.pollMs, flashMs },

      lanes: st && st.sources ? Object.keys(st.sources).length : 0,

    });

  } catch (e) {

    res.status(500).json({ ok: false, error: e.message });

  }

});



app.get('/api/news/flash', (req, res) => {

  const minutes = Math.min(Math.max(Number(req.query.minutes) || 180, 5), 2880);

  let items = flashNews.readRecent(minutes);



  // User rule: "from that remove before 3 30 news i said daily but u not removing"

  // When market is closed (post-3:30 PM, overnight, morning before 09:15), remove all news filed before 15:30 IST!

  const nowMs = Date.now();

  const dNow = new Date(nowMs + 330 * 60000);

  const timeNum = dNow.getUTCHours() * 100 + dNow.getUTCMinutes();

  const day = dNow.getUTCDay();

  const isPostClose = (timeNum >= 1530 || timeNum < 915 || day === 0 || day === 6);



  if (isPostClose && req.query.includeBeforeClose !== 'true') {

    let closeDate = new Date(dNow.getTime());

    if (timeNum < 1530) closeDate.setUTCDate(closeDate.getUTCDate() - 1);

    while (closeDate.getUTCDay() === 0 || closeDate.getUTCDay() === 6) closeDate.setUTCDate(closeDate.getUTCDate() - 1);

    const closeCutoffTs = Date.UTC(closeDate.getUTCFullYear(), closeDate.getUTCMonth(), closeDate.getUTCDate(), 10, 0, 0) - 20 * 60000; // 15:10 IST (20-min buffer)

    items = items.filter(i => (Number(i.ts) || Number(i.firstSeenAt) || 0) >= closeCutoffTs);

  }

  // Merge breaking high-impact wire items (results, earnings beats, order wins) that name a stock
  try {
    const wireItems = (typeof newsItems === 'function' ? newsItems() : []).filter(w => {
      if (!w || !w.symbols || !w.symbols.length) return false;
      const wTs = Number(w.ts) || 0;
      if (isPostClose && req.query.includeBeforeClose !== 'true') {
        const closeDate = new Date(dNow.getTime());
        if (timeNum < 1530) closeDate.setUTCDate(closeDate.getUTCDate() - 1);
        while (closeDate.getUTCDay() === 0 || closeDate.getUTCDay() === 6) closeDate.setUTCDate(closeDate.getUTCDate() - 1);
        const closeCutoffTs = Date.UTC(closeDate.getUTCFullYear(), closeDate.getUTCMonth(), closeDate.getUTCDate(), 10, 0, 0) - 20 * 60000; // 15:10 IST (20-min buffer)
        if (wTs < closeCutoffTs) return false;
      } else {
        if (Date.now() - wTs > minutes * 60000) return false;
      }
      return w.category === 'results' || w.category === 'deals' || /result|profit|loss|revenue|order|contract/i.test(w.title);
    }).map(w => ({
      id: w.id || ('WIRE:' + w.symbols[0] + ':' + w.ts),
      source: w.source || 'WIRE',
      lane: 'flash',
      symbol: w.symbols[0],
      name: w.name || w.symbols[0],
      kind: w.category === 'results' ? 'Financial Results' : 'Order Win / Deal',
      title: w.title,
      text: w.title,
      url: w.url,
      ts: w.ts,
      firstSeenAt: w.firstSeenAt || w.ts,
      lagMs: 0,
      materiality: w.category === 'results' ? 'RESULTS' : 'ORDER',
      category: w.category,
      direction: w.direction || 'UP',
      symbols: w.symbols
    }));

    if (wireItems.length) {
      const seenTitles = new Set(items.map(i => (i.symbol + ':' + (i.title || '').slice(0, 40)).toLowerCase()));
      for (const w of wireItems) {
        const key = (w.symbol + ':' + (w.title || '').slice(0, 40)).toLowerCase();
        if (!seenTitles.has(key)) {
          items.push(w);
          seenTitles.add(key);
        }
      }
      items.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    }
  } catch (_) {}



  const byMateriality = {};

  for (const i of items) byMateriality[i.materiality] = (byMateriality[i.materiality] || 0) + 1;

  res.json({

    ok: true,

    available: items.length > 0,

    lane: 'flash',

    source: 'NSE + BSE corporate announcements',

    minutes,

    count: items.length,

    byMateriality,

    // THE ONE NUMBER THAT SAYS WHETHER THIS IS A WIRE OR A CRAWL: the measured

    // gap between the exchange's timestamp and when this process first saw the

    // row. Median and p95, never a "real-time" adjective.

    latency: flashNews.latencyStats(items),

    poll: Object.assign({}, _flash, {

      intervalSec: (() => { try { return sessionTiming.getSessionPhase().isSignalAllowed ? FLASH_OPEN_MS / 1000 : FLASH_CLOSED_MS / 1000; } catch (e) { return null; } })(),

    }),

    // NEVER TRUNCATE BEFORE THE PAGE FILTERS.

    // This sent the newest 60 rows and the page then filtered them to "Can move a stock"

    // (MATERIAL_BUCKETS). On 2026-10-26 the 6h window held 105 material filings and the

    // newest 60 contained only 18 of them — so the default view showed 18 and silently

    // dropped 87 filings that could move a stock, while "Everything" showed routine

    // analyst-meeting notices. The window is sent whole (capped for payload size) and the

    // filter runs on the client, where its definition lives.

    returned: Math.min(items.length, FLASH_MAX_ITEMS),

    truncated: items.length > FLASH_MAX_ITEMS,

    items: items.slice(0, FLASH_MAX_ITEMS).map((i) => {
      let pred = null;
      const q = (typeof getLiveQuoteForAlerter === 'function' ? getLiveQuoteForAlerter(i.symbol) : null) || {};
      try {
        const pmcMod = require('./common/news/preMarketCatalysts');
        pred = pmcMod.predictCatalyst(i, {
          price: q.ltp || 0,
          volume: q.volume || 0,
          move1mPct: q.move1mPct || 0,
          move5mPct: q.move5mPct || 0,
          range5mPct: q.range5mPct || 0,
          movePct: q.movePct || 0,
          last5Bars: q.last5Bars || null
        });
      } catch (_) {}
      return {
        id: i.id, symbol: i.symbol, name: i.name, kind: i.kind, title: i.title,
        url: i.url, ts: i.ts, firstSeenAt: i.firstSeenAt, lagMs: i.lagMs,
        materiality: i.materiality, category: i.category, direction: i.direction,
        industry: i.industry,
        source: i.source,
        ltp: q.ltp || 0,
        move1mPct: q.move1mPct || 0,
        move5mPct: q.move5mPct || 0,
        range5mPct: q.range5mPct || 0,
        prediction: pred ? pred.prediction : 'WATCH',
        bias: pred ? pred.bias : 'NEUTRAL',
        recommendation: pred ? pred.recommendation : 'WATCH',
        probability: pred ? (pred.probability || pred.confidence) : 50,
        badge: pred ? pred.badge : null,
        targetPrice: pred ? pred.targetPrice : null,
        stopLossPrice: pred ? pred.stopLossPrice : null,
        targetPct: pred ? pred.targetPct : null,
        stopLossPct: pred ? pred.stopLossPct : null,
        rrRatio: pred ? pred.rrRatio : null,
        fiveCandleState: pred ? pred.fiveCandleState : null,
        fiveCandleVerdict: pred ? pred.fiveCandleVerdict : null,
        financialComparison: pred ? pred.financialComparison : null,
        comparisonSummary: pred ? pred.comparisonSummary : null,
        strengthGrade: pred ? pred.strengthGrade : null,
        strengthScore: pred ? pred.strengthScore : null,
        takeTrade: pred ? pred.takeTrade : false,
        tradeStatus: pred ? pred.tradeStatus : 'WATCH'
      };
    }),

    note: 'Flash = the exchange\'s own filing feed (NSE), seconds-level. The Google-News store is an archive lane and stays separate. A filing is not a signal — see docs/measurements/scratch/flash_study.js for what the stock did after one.',

  });

});



// ---------------------------------------------------------------------------

// THE KEY IDEA, AS AN OUTPUT.

//

// The pieces were built and nothing consumed them: the filing store recorded the

// headline, filingCapture armed the tape, and filingExclusion refused entries —

// all into a console log. This endpoint is the missing join: every name that filed

// after 15:30 on the previous session, its gap this morning, and the rule's

// verdict with the measurement attached.

//

// TWO KINDS OF ROW, DELIBERATELY DIFFERENT.

//   AVOID  the exclusion fired and a BUY is refused. Firm: delta -1.29 % (t=-7.6),

//          +0.199 %/trade expectancy and PF 1.55 -> 1.97 as a rule.

//   CLEAR  the name filed but the gap is not deep enough. NOT a signal. The audit

//          found no news entry edge (ORDER drifts +0.10 % gross against a 0.082 %

//          round trip), so a CLEAR row only says no exclusion applies today.

//

// The quote call is batched 45 at a time because the REST FULL endpoint documents

// 50 tokens per request and 1 request/second; a single 500-token POST would be

// rejected, and a rejected quote is worse than a slow one because it turns every

// row into NO_QUOTE and looks like a clean bill of health.

function istDayString(d) {

  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

}



app.get('/api/news/calls', async (req, res) => {

  try {

    const today = istDayString(istNow());

    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.day || ''))

      ? String(req.query.day)

      : today;



    // THIS ENDPOINT QUOTES LIVE. Asking it for a past session would compute that

    // session's gap from TODAY's open and previous close — a real number with a

    // wrong label, which is the most dangerous kind of wrong. Historical sessions

    // belong to the backtests, which read the bar cache instead.

    if (day !== today) {

      return res.status(400).json({

        ok: false,

        error: 'this endpoint scores the LIVE session only (today is ' + today + ')',

        why: 'its gaps come from live quotes, so a past date would be labelled with today\'s prices',

        instead: 'for history use docs/measurements/scratch/gapdown_exclusion_backtest.js or ./src/main/run.sh backtest',

      });

    }



    // Cached by default: this endpoint hits the broker, so a page refresh must not

    // re-quote five hundred names. ?refresh=1 rebuilds.

    if (req.query.refresh !== '1') {

      const cached = keyIdeaCalls.read();

      if (cached && cached.day === day && Array.isArray(cached.calls)) {

        return res.json(Object.assign({ ok: true, cached: true }, cached));

      }

    }



    // THE LOGIC IS NOT IN THIS FILE. common/news/keyIdeaCalls.js owns the join, the

    // batching and the NO_QUOTE handling, and it takes its quote source as an

    // argument so test/keyIdeaCalls.test.js can exercise the whole path without a

    // broker session. This route only parses the query and serves the result — a

    // route that re-implements its own module is a route that silently diverges

    // from what the tests cover.

    const payload = await keyIdeaCalls.collectLive({

      day,

      limit: req.query.limit,

      all: req.query.all === '1',

    });

    res.json(Object.assign({ ok: true, cached: false }, payload));

  } catch (e) {

    res.status(500).json({ ok: false, error: e.message });

  }

});



try { flashNews.poll(); } catch (e) { /* a failed first poll is reported on the endpoint */ }

scheduleFlash();

// The unit was wrong here (FLASH_CLOSED_MS is SECONDS, so /60000 printed "0min" for a 10s loop),

// and scheduleFlash() was called twice — two independent poll chains for one lane.

console.log('[News] flash lane armed: NSE + BSE dual exchange corporate announcements, ' + (FLASH_OPEN_MS / 1000) + 's during the session / ' + (FLASH_CLOSED_MS / 1000) + 's outside it');



// THE FAST WIRE — the lane that made the news tab keep up. The archive pull above asks Google

// News "what was published this month" every 30 minutes, and its ranking is why the tab's newest

// item was 13 minutes old with a 2.5-hour median (measured 2026-10-29). This lane polls WIRE

// feeds — Google News scoped with `when:1h`, CNBC-TV18, BusinessLine, NDTV Profit, ET Markets,

// LiveMint — every 20 seconds and writes into the SAME store /api/news already serves, so the

// page, its filters and its measurement joins need no change.

try {

  fastWire.start();

  const fastN = fastWire.SOURCES.filter((s) => s.tier === 'fast').length;

  console.log('[News] fast wire armed: ' + fastWire.SOURCES.length + ' sources — ' + fastN +

    ' on the ' + (fastWire.CONFIG.fastMs / 1000) + 's clock, ' + (fastWire.SOURCES.length - fastN) +

    ' on ' + (fastWire.CONFIG.pollMs / 1000) + 's → /api/news · /api/news/stream');

} catch (e) {

  console.warn('[News] fast wire could not start:', e.message);

}



// Arm high-speed parallel NSE + BSE Live News Ingestion (every 2s) and instant direction classification

try {

  const newsIngestion = require('./common/news/newsIngestion');

  newsIngestion.loadNseSymbols();

  newsIngestion.fetchRssFeeds().then(() => {

    setInterval(async () => {

      try {

        await newsIngestion.fetchRssFeeds();

        const cache = newsIngestion.getNewsCache();

        const topNews = cache.filter(i => (i.impactScore >= 30 || (i.extractedSymbols && i.extractedSymbols.length && i.impactScore >= 15)) && (Date.now() - new Date(i.receivedAt).getTime() < 30000));

        for (const item of topNews) {

          for (const sym of item.extractedSymbols) {

            if (!sym || sym === 'BSE' || sym === 'NSE' || sym === 'ALL' || /^\d+$/.test(sym) || /-(RE|BE|BZ|SM|NC|N\d)$/i.test(sym)) continue;



            const textToInspect = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();

            let mat = 'ROUTINE';

            if (textToInspect.includes('result') || textToInspect.includes('financial') || textToInspect.includes('unaudited') || textToInspect.includes('audited') || textToInspect.includes('profit') || textToInspect.includes('revenue') || /\bufr\b|\bafr\b/i.test(textToInspect)) {

              mat = 'RESULTS';

            } else if (textToInspect.includes('dividend') || textToInspect.includes('bonus') || textToInspect.includes('split') || textToInspect.includes('buyback') || textToInspect.includes('acquisition') || textToInspect.includes('takeover') || textToInspect.includes('merger') || textToInspect.includes('demerger')) {

              mat = 'CAPITAL';

            } else if (item.direction === 'DOWN' || textToInspect.includes('insolvency') || textToInspect.includes('nclt') || textToInspect.includes('fraud') || textToInspect.includes('raid')) {

              mat = 'RISK';

            } else if (item.direction === 'UP' || textToInspect.includes('order') || textToInspect.includes('contract') || textToInspect.includes('bags') || textToInspect.includes('wins') || textToInspect.includes('usfda')) {

              mat = 'ORDER';

            } else if (textToInspect.includes('monthly business update') || textToInspect.includes('monthly sales') || textToInspect.includes('turnover') || textToInspect.includes('dispatches')) {

              mat = 'SALES_UPDATE';

            }

            const isPureAdminPaperwork = mat === 'ROUTINE' && (/loss of share|duplicate share|reg\.?\s*(?:39|74|57)|trading window closure|closure of trading window/i.test(textToInspect));
            if (isPureAdminPaperwork) continue;



            catalystAlerter.dispatchNewFilingAlerts([{

              id: item.id || ('RSS:' + sym + ':' + item.pubDate),

              symbol: sym,

              materiality: mat,

              direction: item.direction,

              bias: item.bias,

              confidence: item.confidence,

              targetMovePct: item.targetMovePct,

              title: item.title,

              text: item.description,

              url: item.link,

              ts: new Date(item.pubDate).getTime(),

              firstSeenAt: new Date(item.receivedAt).getTime()

            }], {

              getLtp: (s) => liveMinuteEngine && liveMinuteEngine.prevPrice ? liveMinuteEngine.prevPrice.get(s) : null,

              getQuote: getLiveQuoteForAlerter

            }).catch(() => {});

          }

        }

      } catch (_) {}

    }, newsIngestion.CONFIG.rssPollInterval || 2000).unref();

  }).catch(() => {});

  console.log('[News] parallel NSE+BSE high-speed news wire armed (2s cadence) outputting to live_news.json');

} catch (e) {

  console.warn('[News] fast parallel wire init warning:', e.message);

}



// Arm fast Google News polling for breaking corporate headlines (every 3 minutes)

try {

  const fastGoogleNews = require('./common/news/fastGoogleNews');

  global._googleNewsCache = [];

  const pollGoogle = async () => {

    try {

      const gItems = await fastGoogleNews.fetchBreakingGoogleNews();

      if (gItems && gItems.length) global._googleNewsCache = gItems;

    } catch (_) {}

  };

  pollGoogle();

  setInterval(pollGoogle, 15 * 1000).unref(); // 15s fast Google News wire

} catch (_) {}



// ---------------------------------------------------------------------------

// WHICH STOCK LEANS UP OR DOWN ON THE NEWS — with the MEASURED reliability of

// the tag beside it, so a lean is never shown without the base rate that earned

// it. The 2026-10-20 cross-verification (docs/measurements/scratch/news_tag_audit.js, learning

// window, market-adjusted) measured the keyword tags against what the tagged

// stock actually did: UP tags were right 58.6% of the news day (+0.81% mean),

// DOWN 63.0% (−1.21%), NEUTRAL a coin flip as it should be. After the tagger

// fixes the best (category, direction) classes are stronger still (results

// DOWN 65.4%, deals DOWN 80.0% on n=35), and it is THOSE classes — hit rate

// ≥ 55% on ≥ 30 measured events — that may produce a lean. Everything else

// stays a headline, and macro stories (oil/war/fed) are reported as market

// backdrop, never as a lean on one stock.

app.get('/api/news/signals', async (req, res) => {

  try {

    // THE ONE IMPLEMENTATION. common/news/newsSignals.js owns the reliability

    // rule and the lean aggregation; the morning Telegram digest reads the same

    // function, so the page and the phone can never disagree about a lean.

    // The payload also carries `policy` — the backtested trade rule (skip if the

    // entry open already gapped the class's expected move, SL %, exit horizon).

    const sig = newsSignalsMod.computeSignals(

      newsItems(), newsStore.readReaction(), Number(req.query.days) || 3,

    );

    // THE LIVE "ALREADY MOVED?" CHECK. The top leans get a live quote so the

    // board can say SKIP or OK against the class's expected move — the exact

    // rule the holdout measured. A dead quote leaves 'unknown', never a guess,

    // and a quote failure must never fail the endpoint.

    // Quote the whole lean list, not the first twelve. The already-moved check

    // re-sorts the rows (priced-in ones go last), so a row that ends up on the

    // page must not be 'unknown' merely because it was 13th before the sort.

    const top = (sig.stocks || []).slice(0, 50).map((s) => s.symbol);

    if (top.length) {

      try {

        const quotes = await liveQuoteEngine.fetchStockQuotes(top);

        newsSignalsMod.attachLiveState(sig, quotes);

      } catch (e) {

        for (const r of sig.stocks) r.live = { status: 'unknown', note: 'quote fetch failed: ' + e.message };

      }

    }

    res.json(sig);

  } catch (e) {

    res.status(500).json({ error: e.message });

  }

});



/**

 * The per-company table, shaped once for both readers (the summary panel and

 * /api/news/moves): counts, the bar cache's last session, and every company

 * with at least one measured news session.

 */

function movesSummary() {

  const mv = newsMoves.read();

  if (!mv || !mv.byPair) {

    return { available: false, note: 'run node scripts/buildNewsMoves.js to measure what each company did after its news' };

  }

  return {

    available: true,

    generatedAt: mv.generatedAt,

    window: mv.window,

    lastSession: mv.lastSession,

    counts: mv.counts,

    method: mv.method,

    note: mv.note,

    byCompany: mv.byCompany || [],

  };

}



// The full per-company table on its own, for anything that does not want the

// whole summary payload.

app.get('/api/news/moves', (req, res) => {

  const mv = newsMoves.read();

  if (!mv || !mv.byPair) return res.json({ available: false, note: 'run node scripts/buildNewsMoves.js' });

  const symbol = req.query.symbol && String(req.query.symbol).toUpperCase();

  if (symbol) {

    const row = (mv.byCompany || []).find((r) => r.symbol === symbol) || null;

    return res.json({ available: true, symbol, row, lastSession: mv.lastSession, generatedAt: mv.generatedAt });

  }

  res.json({ available: true, generatedAt: mv.generatedAt, window: mv.window, lastSession: mv.lastSession,

    counts: mv.counts, method: mv.method, note: mv.note, byCompany: mv.byCompany });

});



app.get('/api/news/reaction', (req, res) => {

  const reaction = newsStore.readReaction();

  if (!reaction) return res.json({ available: false, note: 'run scripts/newsEventStudy.js to measure the move after a headline' });

  const symbol = req.query.symbol && String(req.query.symbol).toUpperCase();

  if (symbol && reaction.perSymbol) {

    const row = reaction.perSymbol.find((r) => r.symbol === symbol) || null;

    return res.json({ available: true, symbol, row, generatedAt: reaction.generatedAt, window: reaction.window, horizons: reaction.horizons });

  }

  res.json(reaction);

});



app.get('/api/terminal/method', (req, res) => {

  const snap = readBoard();

  const cb = codebook();

  res.json({

    generatedAt: new Date().toISOString(),

    method: auditCore.backtestMethod(snap ? snap.backtest : null, cb),

    codebook: cb,

    rules: snap ? snap.rules : [],

    universe: snap ? snap.universe : null,

    feed: snap ? snap.feed : null,

  });

});



// ---- Holdings / positions ----

app.get('/api/:broker/holdings', getBroker, async (req, res) => {

  try {

    res.json(await req.broker.getHoldings());

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



app.get('/api/:broker/positions', getBroker, async (req, res) => {

  try {

    if (!req.broker._holdings.getPositions) {

      return res.status(501).json({ error: 'getPositions not implemented for this broker' });

    }

    res.json(await req.broker._holdings.getPositions());

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// Angel One only — Groww doesn't expose a funds endpoint in these adapters

app.get('/api/:broker/funds', getBroker, async (req, res) => {

  try {

    if (!req.broker._holdings.getFunds) {

      return res.status(501).json({ error: 'getFunds not available for this broker' });

    }

    res.json(await req.broker._holdings.getFunds());

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// ---- Orders ----

// Body: unified order shape from common/trading/orderTypes.js

// Force-refresh mutual fund NAV data for all schemes 30+ days stale (any time of day).

let _mfRefreshRunning = false;

// GET /api/mutual-funds/data-quality — open validation flags + source health



// GET /api/mutual-funds/scheme-nav-series/:schemeId — NAV series for a single scheme (graph overlay)





// Resolution shared by the order route and its preflight twin, so the two can never disagree about

// which instrument an order is for. Returns null after answering the request itself on failure.

function resolvePlainSymbol(req, res, order, symbol) {

  if (!symbol || order.tradingsymbol) return order;

  const resolved = instrumentService.resolveEquity(symbol, { exchange: order.exchange || 'NSE' });

  if (req.params.broker === 'angelone' && resolved.angel) {

    order.tradingsymbol = resolved.angel.tradingsymbol;

    order.symboltoken = resolved.angel.symboltoken;

  } else if (req.params.broker === 'groww' && resolved.groww) {

    order.tradingsymbol = resolved.groww.tradingSymbol;

  } else {

    res.status(404).json({ error: `Could not resolve symbol '${symbol}' for ${req.params.broker}` });

    return null;

  }

  return order;

}



// POST /api/:broker/orders/preflight - validate and SHOW the order, send NOTHING.

// "Send live order is not working" has two very different causes that look identical from a button

// that does nothing: the request never left the page, or the broker refused it. This answers both

// without spending money: it resolves the symbol, runs the same validation and the same body builder

// the real order uses, and makes one read call to prove the session is usable. It never touches the

// order endpoint, so it is safe to click as often as you like.

app.post('/api/:broker/orders/preflight', getBroker, async (req, res) => {

  try {

    const { brokerOptions, symbol, ...order } = req.body;

    const resolvedOrder = resolvePlainSymbol(req, res, order, symbol);

    if (!resolvedOrder) return;



    const pre = await req.broker.preflightOrder(resolvedOrder, brokerOptions);



    // Portfolio context the adapter cannot know about. Warnings only: the broker makes the final call,

    // and a preflight that claimed to know would be worse than one that says what it checked.

    const warnings = pre.warnings.slice();

    let funds = null;

    try {

      if (req.broker._holdings && req.broker._holdings.getFunds) {

        funds = await req.broker._holdings.getFunds();

        const available = Number((funds && (funds.availablecash ?? funds.availableCash)) ?? NaN);

        const notional = Number(pre.wouldSend.price) * Number(pre.wouldSend.quantity);

        if (Number.isFinite(available) && pre.wouldSend.transactiontype === 'BUY') {

          if (available <= 0) {

            warnings.push(`Available cash is Rs ${available.toFixed(2)} - a BUY of Rs ${notional.toFixed(2)} ` +

              `will almost certainly be rejected for insufficient funds.`);

          } else if (available < notional) {

            warnings.push(`Available cash Rs ${available.toFixed(2)} is below the Rs ${notional.toFixed(2)} notional.`);

          }

        }

      }

    } catch (e) {

      warnings.push(`Could not read funds: ${e.message}`);

    }



    res.json({

      status: 'ok',

      ok: warnings.length === 0,

      sessionOk: pre.sessionOk,

      symbol: resolvedOrder.tradingsymbol,

      symboltoken: resolvedOrder.symboltoken,

      notional: Number((Number(pre.wouldSend.price) * Number(pre.wouldSend.quantity)).toFixed(2)),

      wouldSend: pre.wouldSend,

      endpoint: pre.endpoint,

      funds,

      warnings

    });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



app.post('/api/:broker/orders', getBroker, async (req, res) => {

  try {

    const { brokerOptions, symbol, ...order } = req.body;



    // Convenience: if the caller sends a plain `symbol` (e.g. "RELIANCE")

    // instead of broker-specific fields, resolve it via the instrument

    // master instead of requiring the caller to know tokens/symbol formats.

    const resolvedOrder = resolvePlainSymbol(req, res, order, symbol);

    if (!resolvedOrder) return;



    const result = await req.broker.placeOrder(resolvedOrder, brokerOptions);

    res.status(201).json(result);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// POST /api/:broker/orders/bracket — SIZE, BUY, AND ATTACH THE STOP AND TARGET IN ONE PRESS.

//

// Placing an entry is a third of a trade. Left to a second press, the stop and the target arrive

// seconds late or not at all, and "not at all" is a live position nobody is guarding. This route

// runs the whole press: the live RMS balance decides the size (under ₹3,000 the whole balance is

// the position, above it the per-trade risk budget binds — see common/risk/positionSizing.js), the

// entry is sent, and once it fills an Angel One GTT OCO rule carries the stop and the target,

// whichever fires first cancelling the other. The bracket lives at the broker, so it survives this

// process dying.

//

// Every failure names its stage. `stage: 'protection'` is the one that must never be guessed at:

// the entry is LIVE and the stop and target are NOT, and the response carries the exact manual

// order to place.

app.post('/api/:broker/orders/bracket', getBroker, async (req, res) => {

  try {

    const gtt = req.broker.getGtt ? req.broker.getGtt() : null;

    if (!gtt) {

      return res.status(501).json({

        error: 'Bracket orders are available for Angel One only — no GTT client for this broker.',

        stage: 'deps',

      });

    }



    // The page sends a plain symbol plus the call's own levels; the instrument master resolves

    // the token, so the frontend never has to know a broker's symbol format.

    const { symbol, side, entry, stop, target, productType, quantity, riskPct, riskInr, orderType, dryRun, requireApproval } = req.body;

    const probe = { exchange: (req.body && req.body.exchange) || 'NSE' };

    const resolved = resolvePlainSymbol(req, res, probe, symbol);

    if (!resolved) return;



    const session = liveSessionState();

    const deps = {

      placeOrder: (o) => req.broker.placeOrder(o, req.body && req.body.brokerOptions),

      getOrderBook: () => req.broker._trading.getOrderBook(),

      gtt,

      getFunds: () => req.broker._holdings.getFunds(),

    };

    const spec = {

      side, entry, stop, target, productType, quantity, riskPct, riskInr, orderType,

      tradingsymbol: resolved.tradingsymbol,

      symboltoken: resolved.symboltoken,

      exchange: probe.exchange,

    };



    // CONFIRM FIRST. With `requireApproval`, nothing is sent: the identical path runs as a dry run

    // to size the order, and that sized order becomes a proposal offered on Telegram. The press

    // decides WHAT is proposed; the tap decides WHETHER it exists.

    if ((requireApproval === true || requireApproval === 'true') && !(dryRun === true || dryRun === 'true')) {

      const sized = await executeBracket(deps, Object.assign({}, spec, { dryRun: true }));

      if (!sized.ok) {

        // A proposal that cannot be sized is not offered at all — a button that can only fail is

        // worse than no button, and the reason is more useful than a message nobody can act on.

        return res.status(400).json(Object.assign({ broker: req.params.broker, session: session.state }, sized));

      }

      const created = approvalStore.create({

        symbol: resolved.tradingsymbol || symbol,

        plainSymbol: symbol,

        broker: req.params.broker,

        exchange: probe.exchange,

        side, entry, stop, target, productType, orderType, riskPct, riskInr,

        quantity: sized.quantity,

        capital: sized.capital == null ? null : sized.capital,

        capitalSource: sized.capitalSource || null,

        sizingNote: sized.sizingNote || null,

      });



      let delivered = { ok: false, reason: 'no Telegram configuration' };

      try {

        const cfg = telegramConfig.loadConfig();

        if (cfg.botToken && cfg.chatId) {

          const sent = await telegramApprovals.sendProposal({ approval: created.approval, token: cfg.botToken, chatId: cfg.chatId });

          delivered = { ok: true, messageId: sent.messageId, chatId: cfg.chatId };

        }

      } catch (e) {

        delivered = { ok: false, reason: (e && e.message) || String(e) };

      }



      // IF TELEGRAM COULD NOT BE REACHED THE PROPOSAL IS USELESS, so it is cancelled rather than

      // left PENDING: an unanswerable approval would sit there and look live while nothing could

      // ever approve it. The page still gets the id so it can offer its own confirm button.

      if (!delivered.ok) {

        approvalStore.decide(created.approval.id, 'cancel', { channel: 'undeliverable' });

      }



      return res.status(delivered.ok ? 202 : 502).json({

        broker: req.params.broker,

        session: session.state,

        ok: delivered.ok,

        stage: delivered.ok ? 'awaiting-approval' : 'notification-failed',

        approval: created.approval,

        duplicate: created.duplicate,

        quantity: sized.quantity,

        capital: sized.capital,

        delivery: delivered,

        problems: delivered.ok ? undefined : ['the proposal could not be sent to Telegram: ' + (delivered.reason || 'unknown') + ' — nothing was placed'],

      });

    }



    // `dryRun` runs the identical path — funds, sizing, geometry — and stops before a rupee moves,

    // so the modal can show the broker-bound quantity rather than a second calculation.

    const result = await executeBracket(deps, Object.assign({}, spec, { dryRun: dryRun === true || dryRun === 'true' }));



    const status = result.dryRun ? 200 : (result.ok ? 201 : (result.stage === 'protection' ? 207 : 400));

    res.status(status).json(Object.assign({ broker: req.params.broker, session: session.state }, result));

  } catch (err) {

    res.status(400).json({ error: err.message, stage: 'route' });

  }

});



// ===========================================================================

// CONFIRM FIRST — THE OTHER HALF OF THE PRESS.

// ===========================================================================

// A proposal waits in approvalStore (on disk). Two things can answer it: a tap in the configured

// Telegram chat, or a POST from the page. Both land in `settleApproval`, so there is ONE code path

// that can place an approved order and one place to look when asking "why did this buy".



function bracketDepsFor(broker, brokerOptions) {

  return {

    placeOrder: (o) => broker.placeOrder(o, brokerOptions),

    getOrderBook: () => broker._trading.getOrderBook(),

    gtt: broker.getGtt ? broker.getGtt() : null,

    getFunds: () => broker._holdings.getFunds(),

  };

}



/** The one-line summary a message edits itself into, so a stale ✅ cannot be tapped again by sight. */

function outcomeLine(approval, exec) {

  if (!exec) return '❌ Dropped — no order was placed.';

  if (exec.ok) {

    const p = approval.proposal || {};

    return '✅ Ordered ' + (exec.quantity || p.quantity) + ' ' + (p.symbol || '') +

      (exec.entryOrder && exec.entryOrder.orderId ? ' — order ' + exec.entryOrder.orderId : '') +

      (exec.protection && exec.protection.ruleId ? ' · stop+target attached (' + exec.protection.ruleId + ')' : '');

  }

  if (exec.stage === 'protection') {

    return '⚠️ <b>ENTRY IS LIVE AND UNPROTECTED.</b> ' + ((exec.problems || [])[0] || '') +

      '\n' + ((exec.problems || [])[1] || '');

  }

  return '⛔ <b>Not placed</b> (' + (exec.stage || 'refused') + '): ' + ((exec.problems || [])[0] || 'no reason given');

}



/**

 * Place an APPROVED proposal. Funds are read again here, not reused from the proposal: the balance

 * at the press and the balance at the tap are different facts, and only the second one can pay.

 */

async function placeApprovedProposal(approval) {

  const p = approval.proposal || {};

  const brokerName = p.broker || 'angelone';

  const broker = brokers[brokerName];

  if (!broker) {

    return { ok: false, stage: 'deps', problems: ['broker ' + brokerName + ' is not active — nothing was placed'] };

  }

  const resolved = instrumentService.resolveEquity(p.plainSymbol || p.symbol, { exchange: p.exchange || 'NSE' });

  const instrument = resolved && resolved.angel;

  if (!instrument) {

    return { ok: false, stage: 'instrument', problems: ['could not resolve ' + (p.plainSymbol || p.symbol) + ' to an instrument token'] };

  }

  return executeBracket(bracketDepsFor(broker), {

    side: p.side, entry: p.entry, stop: p.stop, target: p.target,

    productType: p.productType, quantity: p.quantity, riskPct: p.riskPct, riskInr: p.riskInr,

    orderType: p.orderType,

    tradingsymbol: instrument.tradingsymbol,

    symboltoken: instrument.symboltoken,

    exchange: p.exchange || 'NSE',

  });

}



/**

 * Answer a proposal — from Telegram or from the page. Returns before/after so both callers can

 * report the same thing. A second answer is refused by the store, never acted on.

 */

async function answerApproval(id, decision, { channel = 'api', message = null } = {}) {

  const decided = approvalStore.decide(id, decision, { channel });

  if (!decided.ok) return decided;



  const approval = decided.approval;

  const cfg = (() => { try { return telegramConfig.loadConfig(); } catch (_) { return {}; } })();

  const edit = (text) => {

    if (channel !== 'telegram' || !message || !cfg.botToken) return Promise.resolve();

    return telegramApprovals.editOutcome({

      token: cfg.botToken, chatId: cfg.chatId,

      messageId: message.message_id, text,

    });

  };



  if (decided.status === APPROVAL_STATUS.CANCELLED) {

    await edit(outcomeLine(approval, null));

    return Object.assign({}, decided, { executed: null });

  }



  let exec;

  try {

    exec = await placeApprovedProposal(approval);

  } catch (e) {

    exec = { ok: false, stage: 'route', problems: [(e && e.message) || String(e)] };

  }

  const settled = approvalStore.settle(id, {

    status: exec.ok ? APPROVAL_STATUS.APPROVED : APPROVAL_STATUS.FAILED,

    result: exec,

  });

  await edit(outcomeLine(approval, exec));

  return Object.assign({}, decided, { executed: exec, approval: settled || approval });

}



// The pending list — what the page polls after a press, so "sent to your phone" is observable

// from the page rather than only from the chat.

app.get('/api/orders/approvals', (req, res) => {

  // `?id=` is what the page polls after a press: it asks about ITS proposal, not about the desk.

  if (req.query.id) {

    const one = approvalStore.get(String(req.query.id));

    return res.json({ at: new Date().toISOString(), count: one ? 1 : 0, approvals: one ? [one] : [] });

  }

  const status = req.query.status ? String(req.query.status).toUpperCase() : null;

  const rows = approvalStore.list({ status });

  res.json({ at: new Date().toISOString(), count: rows.length, approvals: rows });

});



// A second answer path for the page (and for a script). The store makes it a no-op if the

// proposal was already decided, so a page click racing a Telegram tap cannot place two orders.

app.post('/api/orders/approvals/:id', async (req, res) => {

  try {

    const decision = String((req.body && req.body.decision) || '').toLowerCase();

    if (decision !== 'approve' && decision !== 'cancel' && decision !== 'yes' && decision !== 'no') {

      return res.status(400).json({ error: 'decision must be approve or cancel' });

    }

    const out = await answerApproval(req.params.id, decision, { channel: 'api' });

    res.status(out.ok ? 200 : 409).json(out);

  } catch (err) {

    res.status(400).json({ error: err.message, stage: 'approval' });

  }

});



/**

 * Boot the Telegram listener. Silent no-op when the bot is not configured, because a machine with

 * no alerts set up must still run — the page's own confirm button is then the only way to answer.

 */

function startApprovalListener() {

  let cfg;

  try { cfg = telegramConfig.loadConfig(); } catch (_) { cfg = {}; }

  if (!cfg.botToken || !cfg.chatId) {

    console.log('[telegramApprovals] no bot token/chat id — approvals can only be answered from the page.');

    return;

  }

  if (approvalStore.pending().length) {

    console.log('[telegramApprovals] ' + approvalStore.pending().length + ' proposal(s) restored from disk.');

  }

  telegramApprovals.startPolling({

    token: cfg.botToken,

    chatId: cfg.chatId,

    log: (m) => console.log(m),

    onDecision: async ({ id, decision, channel, message }) => {

      // A BARE "yes" CARRIES NO id, and guessing is not allowed when money is attached: it is only

      // resolvable when exactly one proposal is waiting. With two live proposals the operator is

      // told to name one rather than having the first one bought for them.

      let targetId = id;

      if (!targetId) {

        const pending = approvalStore.pending();

        if (pending.length !== 1) {

          const cfg2 = telegramConfig.loadConfig();

          const list = pending.length

            ? 'Waiting: ' + pending.map((p) => p.id + ' ' + p.proposal.symbol).join(', ') + ' — reply "yes <id>".'

            : 'There is no proposal waiting.';

          try {

            await telegramConfig.sendPhoneNotificationNow('ℹ️ ' + list);

          } catch (e) {

            console.log('[telegramApprovals] could not explain ambiguity: ' + ((e && e.message) || e));

          }

          if (!cfg2) return;

          return;

        }

        targetId = pending[0].id;

      }

      const out = await answerApproval(targetId, decision, { channel, message });

      if (!out.ok) console.log('[telegramApprovals] ' + targetId + ' not actioned: ' + ((out.problems || [])[0] || out.status));

    },

    // TEXT THAT IS NOT A YES/NO ANSWER still has to work, or moving the poller here would have

    // silently deleted the status queries ("live", "holdings", "pnl") the old interval served.

    //

    // THE BOARD COMMANDS COME FIRST: /calls /book /status /why answer from the running engines.

    // `maybeAnswer` returns null for anything else, so the older P&L handler still owns "holdings"

    // and "pnl" — one stream, two vocabularies, no competing poller.

    onText: async (message) => {

      try {

        const reply = boardInbox().maybeAnswer(message && message.text);

        if (reply) {

          const out = await telegramConfig.sendPhoneNotificationNow(reply);

          if (out && out.success === false) console.log('[telegram-inbox] reply not delivered: ' + out.reason);

          return;

        }

        await notificationService.handleTelegramText(message.text, cfg);

      } catch (e) { console.log('[telegramApprovals] text handler failed: ' + ((e && e.message) || e)); }

    },

  });

}



// GET /api/:broker/gtt/rules — IS THE OPEN POSITION ACTUALLY PROTECTED?

//

// A bracket puts the stop and the target in a GTT OCO rule at the broker. That rule is invisible

// from every endpoint this server had: the position book shows the shares, the order book shows the

// entry, and neither shows the leg that is supposed to get you out. So the one question that matters

// after a press — "is this guarded?" — could only be answered by logging in to Angel's own UI.

//

// Read-only on purpose: this lists rules and changes nothing. A missing rule for a live position is

// the failure the bracket exists to prevent, so it is returned as `unprotectedSymbols` beside the

// list rather than left for the caller to cross-reference by hand.

app.get('/api/:broker/gtt/rules', getBroker, async (req, res) => {

  try {

    const gtt = req.broker.getGtt ? req.broker.getGtt() : null;

    if (!gtt) {

      return res.status(501).json({ error: 'GTT rules are available for Angel One only.', stage: 'deps' });

    }

    const rules = await gtt.getRuleList();

    const list = Array.isArray(rules) ? rules : [];



    // Cross-check against open positions, because a rule list nobody joins to the book answers

    // nothing. Position symbols carry the -EQ suffix and GTT rules may not, so both are normalised.

    // A failed read is reported as `positionsError` rather than an empty book: "no open positions"

    // and "could not look" must not produce the same reassuring answer.

    let positions = [];

    let positionsError = null;

    try {

      positions = req.broker._holdings && req.broker._holdings.getPositions

        ? await req.broker._holdings.getPositions()

        : [];

      if (!req.broker._holdings || !req.broker._holdings.getPositions) {

        positionsError = 'getPositions is not implemented for this broker';

      }

    } catch (e) {

      positionsError = (e && e.message) || String(e);

    }

    const bare = (s) => String(s || '').replace(/-EQ$/i, '').toUpperCase();

    const guarded = new Set(list.flatMap((r) => [bare(r.tradingsymbol), bare(r.symbol ? r.symbol.tradingsymbol : '')]));

    const open = (Array.isArray(positions) ? positions : [])

      .filter((p) => Number(p.netqty || p.netquantity || 0) !== 0);

    const unprotectedSymbols = open

      .map((p) => String(p.tradingsymbol || ''))

      .filter((s) => s && !guarded.has(bare(s)));



    res.json({

      broker: req.params.broker,

      count: list.length,

      rules: list,

      openPositions: open.length,

      positionsError,

      // UNKNOWN IS NOT SAFE. When the position book could not be read, `open` is empty and an

      // empty `unprotectedSymbols` would read as "everything is protected" — the worst possible

      // way to be wrong about a stop. null means "could not check"; [] means "checked, all good".

      unprotectedSymbols: positionsError ? null : unprotectedSymbols,

      note: positionsError

        ? 'the position book could not be read, so protection could not be cross-checked: ' + positionsError

        : (unprotectedSymbols.length

          ? 'these positions have NO GTT rule at the broker — nothing will close them if you are not watching'

          : null),

    });

  } catch (err) {

    res.status(400).json({ error: err.message, stage: 'gtt' });

  }

});



app.put('/api/:broker/orders/:orderId', getBroker, async (req, res) => {

  try {

    const { brokerOptions, ...changes } = req.body;

    const result = await req.broker.modifyOrder(req.params.orderId, changes, brokerOptions);

    res.json(result);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



app.delete('/api/:broker/orders/:orderId', getBroker, async (req, res) => {

  try {

    const result = await req.broker.cancelOrder(req.params.orderId, req.body?.brokerOptions);

    res.json(result);

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



function getRecommendedMtfRatio(symbol) {

  if (!symbol) return 3.0;

  const sym = symbol.toUpperCase().replace('-EQ', '');

  const LEVERAGE_MAP = {

    'EMMVEE': 2.9,

    'HDFCBANK': 4.4, 'ICICIBANK': 4.4, 'KOTAKBANK': 4.4, 'SBIN': 4.4, 'AXISBANK': 4.4,

    'ONGC': 4.2, 'IOC': 4.2, 'BPCL': 4.2, 'GAIL': 4.2,

    'SHRIRAMFIN': 3.6, 'CHOLAFIN': 3.6, 'BAJFINANCE': 3.6,

    'MCX': 3.5, 'IEX': 3.5,

    'RELIANCE': 4.0, 'TCS': 4.0, 'INFY': 4.0, 'LT': 4.0, 'BHARTIARTL': 4.0, 'ITC': 4.0, 'TATAMOTORS': 4.0, 'TATASTEEL': 4.0, 'VEDL': 4.0,

  };

  return LEVERAGE_MAP[sym] || 3.0;

}



// Instrument search endpoint for autocompleting stock symbols across NSE/BSE

app.get('/api/instruments/search', (req, res) => {

  try {

    const q = (req.query.q || '').trim();

    if (!q) return res.json([]);

    const { exchange, segment, limit } = req.query;

    const results = instrumentService.search(q, {

      limit: limit ? Number(limit) : 15,

      ...(exchange ? { exchange } : {}),

      ...(segment ? { segment } : {}),

    });

    const list = [];

    const seen = new Set();



    if (results.angel) {

      for (const r of results.angel) {

        const sym = r.symbol ? r.symbol.replace('-EQ', '') : '';

        if (sym && !seen.has(sym)) {

          seen.add(sym);

          list.push({ symbol: sym, name: r.name || sym, exchange: r.exch_seg || 'NSE', recommendedMtf: getRecommendedMtfRatio(sym) });

        }

      }

    }

    if (results.groww) {

      for (const r of results.groww) {

        const sym = r.trading_symbol ? r.trading_symbol.replace('-EQ', '') : '';

        if (sym && !seen.has(sym)) {

          seen.add(sym);

          list.push({ symbol: sym, name: r.name || sym, exchange: r.exchange || 'NSE', recommendedMtf: getRecommendedMtfRatio(sym) });

        }

      }

    }

    res.json(list.slice(0, limit ? Math.min(Number(limit), 100) : 15));

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// Live Market Watchlist & Indices API endpoint (Real-time Live Nifty, BankNifty, Sensex)

const angelMarketQuote = require('./angelone/marketQuote');



// ---- Live market data ----

// Angel One body: { tokens: ['2885'], exchangeType?, mode? }

// Groww body:     { symbols: ['NSE_RELIANCE'] }

// Either broker also accepts: { watch: ['NIFTY','BANKNIFTY','GOLD','SILVER'] }

// — auto-resolves indices/nearest-expiry MCX futures/equities via the

// instrument master instead of you looking up tokens by hand.

app.post('/api/:broker/live/subscribe', getBroker, (req, res) => {

  try {

    const broker = req.params.broker;

    let { tokens, symbols, exchangeType, mode, intervalMs, watch } = req.body;



    if (watch && watch.length) {

      const resolved = watch.map((w) => instrumentService.resolveWatchItem(w));

      const unresolved = resolved.filter((r) => !(broker === 'angelone' ? r.angel : r.groww));

      if (unresolved.length) {

        return res.status(404).json({ error: `Could not resolve: ${unresolved.map((r) => r.symbol).join(', ')} for ${broker}` });

      }

      if (broker === 'angelone') {

        const EXCH_MAP = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5 };

        const byExchType = {};

        for (const r of resolved) {

          if (!r.angel) continue;

          const et = EXCH_MAP[r.angel.exchange] || 1;

          (byExchType[et] ||= []).push(r.angel.symboltoken);

        }

        tokens = Object.entries(byExchType).map(([et, toks]) => ({ exchangeType: Number(et), tokens: toks }));

      } else {

        symbols = resolved.map((r) => `${r.groww.exchange}_${r.groww.tradingSymbol}`);

      }

    }



    if (broker === 'angelone') {

      // A MODE OVERRIDE MUST NOT REUSE THE INDEX FEED'S CORRELATION ID.

      // Angel binds a MODE to a correlation id, not to the socket (broker.js says so where it

      // defaults to 'sub1'), and the boot-time index feed owns 'sub1' in LTP mode. Calling this

      // endpoint with `mode: 3` on the default id therefore re-binds the INDEX subscription to

      // SNAP_QUOTE — silently changing the mode of a feed three other consumers depend on. An

      // explicit mode gets its own id, so this route can only ever ADD a subscription.

      const wantsMode = mode !== undefined && mode !== null && String(mode) !== '';

      const correlationId = wantsMode ? ('api' + String(mode)) : undefined;

      req.broker.subscribeLiveAngel(tokens, wantsMode ? { exchangeType, mode, correlationId } : { exchangeType });

    } else {

      req.broker.subscribeLiveGroww(symbols, { intervalMs });

    }

    res.json({ status: 'subscribed' });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// Server-Sent Events stream of ticks for a broker. Open with:

//   const es = new EventSource('/api/angelone/live/stream')

//   es.onmessage = (e) => console.log(JSON.parse(e.data))

app.get('/api/:broker/live/stream', getBroker, (req, res) => {

  res.writeHead(200, {

    'Content-Type': 'text/event-stream',

    'Cache-Control': 'no-cache',

    Connection: 'keep-alive',

  });

  res.write('\n');



  // A TICK THAT CANNOT BE SERIALISED MUST NOT KILL THE STREAM SILENTLY.

  // `JSON.stringify(tick)` threw on every tick while the feed's `sequenceNumber` was a

  // BigInt (fixed at the source in angelone/marketFeed.js). An uncaught throw inside an

  // EventEmitter listener propagates out of the socket's message handler, so the stream

  // produced nothing at all and looked exactly like "Angel One is not connecting" — while

  // the socket was in fact open and delivering ticks. Each tick is now guarded, and a bad

  // one is reported on the stream instead of ending it.

  let sent = 0, failed = 0;

  const onTick = (tick) => {

    try {

      res.write(`data: ${JSON.stringify(tick)}\n\n`);

      sent += 1;

    } catch (e) {

      failed += 1;

      try {

        res.write(`event: tick-error\ndata: ${JSON.stringify({

          message: (e && e.message) || String(e),

          token: tick && tick.token != null ? String(tick.token) : null,

          sent, failed,

        })}\n\n`);

      } catch (_) { /* the stream itself is gone; nothing left to report on */ }

    }

  };

  const onError = (err) => {

    try { res.write(`event: error\ndata: ${JSON.stringify({ message: (err && err.message) || String(err) })}\n\n`); } catch (_) {}

  };



  req.broker.on('tick', onTick);

  req.broker.on('error', onError);



  req.on('close', () => {

    req.broker.off('tick', onTick);

    req.broker.off('error', onError);

  });

});



// Server-Sent Events stream of order updates (fills, rejections, etc.)

// for a broker — separate from the price ticks above. Opens the

// underlying feed (WebSocket for Angel One, polling for Groww) on first

// subscriber. Open with:

//   const es = new EventSource('/api/angelone/orders/stream')

app.get('/api/:broker/orders/stream', getBroker, (req, res) => {

  res.writeHead(200, {

    'Content-Type': 'text/event-stream',

    'Cache-Control': 'no-cache',

    Connection: 'keep-alive',

  });

  res.write('\n');



  req.broker.subscribeOrderUpdates();



  const onUpdate = (order) => res.write(`data: ${JSON.stringify(order)}\n\n`);

  const onError = (err) => res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);



  req.broker.on('orderUpdate', onUpdate);

  req.broker.on('error', onError);



  req.on('close', () => {

    req.broker.off('orderUpdate', onUpdate);

    req.broker.off('error', onError);

  });

});



// ---- Ledger: trades, funds, MTF (data the broker APIs don't track) ----

// :broker here is just a label for filtering — not validated against

// getBroker/live login, since you can backfill historical trades for a

// broker even while its session is logged out.



// POST body: { tradingsymbol, exchange, transactionType, quantity, price,

//   tradeDate, productType, isMtf?, mtfMarginPaid?, orderId?, source?, note? }

app.post('/api/:broker/ledger/trades', (req, res) => {

  try {

    const trade = { ...req.body, broker: req.params.broker };

    res.status(201).json(ledger.recordTrade(trade));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



app.get('/api/:broker/ledger/trades', (req, res) => {

  try {

    res.json(ledger.getTrades(req.params.broker, { tradingsymbol: req.query.symbol }));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// Mark a position (MTF or otherwise) closed — stops MTF interest accrual.

app.post('/api/:broker/ledger/trades/:id/close', (req, res) => {

  try {

    const { closedDate } = req.body;

    if (!closedDate) return res.status(400).json({ error: 'closedDate is required' });

    res.json(ledger.closeTrade(req.params.id, closedDate));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// Every open/closed MTF position with borrowed amount, days held, and

// accrued interest computed as of today via that broker's own charges module.

app.get('/api/:broker/ledger/mtf-summary', (req, res) => {

  try {

    res.json(ledger.getMtfSummary(req.params.broker));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// POST body: { type: 'ADD'|'WITHDRAW', amount, txnDate, note? }

app.post('/api/:broker/ledger/funds', (req, res) => {

  try {

    const txn = { ...req.body, broker: req.params.broker };

    res.status(201).json(ledger.recordFundsTransaction(txn));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



app.get('/api/:broker/ledger/funds', (req, res) => {

  try {

    res.json({

      transactions: ledger.getFundsTransactions(req.params.broker),

      totals: ledger.getFundsNetTotal(req.params.broker),

    });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



app.delete('/api/:broker/ledger/funds/:id', (req, res) => {

  try {

    ledger.deleteFundsTransaction(req.params.id);

    res.json({ success: true, deletedId: req.params.id });

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// On-demand charge estimate for a trade not yet recorded — e.g. to show

// "estimated charges" before confirming an order.

// Body: { transactionType, productType, quantity, price }

app.post('/api/:broker/ledger/estimate-charges', (req, res) => {

  try {

    res.json(ledger.estimateCharges(req.params.broker, req.body));

  } catch (err) {

    res.status(400).json({ error: err.message });

  }

});



// POST /api/:broker/ledger/holding-settings — update buy date & MTF ratio for a holding

app.post('/api/:broker/ledger/holding-settings', (req, res) => {

  try {

    const { tradingsymbol, exchange, quantity, avgPrice, tradeDate, isMtf, mtfMarginRatio, mtfLeverage } = req.body;

    if (!tradingsymbol || !tradeDate) {

      return res.status(400).json({ error: 'tradingsymbol and tradeDate are required' });

    }

    const updated = ledger.updateHoldingSettings({

      broker: req.params.broker,

      tradingsymbol,

      exchange: exchange || 'NSE',

      quantity: Number(quantity),

      avgPrice: Number(avgPrice),

      tradeDate,

      isMtf: !!isMtf,

      mtfMarginRatio: mtfMarginRatio != null ? Number(mtfMarginRatio) : null,

      mtfLeverage: mtfLeverage != null ? Number(mtfLeverage) : null,

    });

    res.json(updated);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// GET /api/:broker/ledger/override

app.get('/api/:broker/ledger/override', (req, res) => {

  try {

    res.json(ledger.getBrokerOverride(req.params.broker));

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// POST /api/:broker/ledger/override

app.post('/api/:broker/ledger/override', (req, res) => {

  try {

    const { customCharges, customMtfInterest } = req.body;

    const updated = ledger.setBrokerOverride(req.params.broker, {

      customCharges: customCharges != null ? Number(customCharges) : undefined,

      customMtfInterest: customMtfInterest != null ? Number(customMtfInterest) : undefined,

    });

    res.json(updated);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// ---- Live portfolio P&L ----

// Per-stock: quantity, avg price, LTP, invested/current amount, overall

// and today's G/L (amount + %), and gross P&L with buy+sell charges and

// MTF interest removed. See common/portfolio/portfolioService.js for

// exactly what "gross" means here.

app.get('/api/:broker/portfolio', getBroker, async (req, res) => {

  try {

    const rows = req.params.broker === 'angelone'

      ? await portfolioService.getAngelPortfolio(req.broker.session)

      : await portfolioService.getGrowwPortfolio(req.broker.session, brokers.angelone?.session);

    res.json({ connected: !!req.broker.session, holdings: rows, summary: portfolioService.summarize(rows) });

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



let portfolioCache = null;

let portfolioCacheTime = 0;



// PORTFOLIO REFRESH POLICY (user rule): holdings/MF are position data, not trading

// data — no intraday polling. Fetch once, then only refresh at/after 15:15 IST

// (market close, when no trade can be missed). Before 15:15 the cache is served

// as-is; ?force=1 bypasses for manual refresh.

function istNow() {

  const s = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

  return new Date(s.replace(/(\d+)\/(\d+)\/(\d+),?/, '$3-$2-$1'));

}

function portfolioCacheFresh() {

  if (!portfolioCache) return false;

  const now = istNow();

  const cutoff = new Date(now); cutoff.setHours(15, 15, 0, 0);

  if (now >= cutoff) return portfolioCacheTime >= cutoff.getTime(); // past 15:15 → need a fetch from after 15:15 today

  return portfolioCacheTime >= new Date(now).setHours(0, 0, 0, 0); // before 15:15 → today's fetch is enough

}



// Combined view across both brokers in one call.

app.get('/api/portfolio', async (req, res) => {

  try {

    if (portfolioCacheFresh() && req.query.force !== '1') {

      return res.json(portfolioCache);

    }

    const results = {};



    // Cash is the broker's live RMS figure or nothing. `connected` lets the UI say

    // "broker not connected" instead of rendering an empty table that looks like a

    // zero-value portfolio.

    const angelConnected = !!(brokers.angelone && brokers.angelone.session);

    const growwConnected = !!(brokers.groww && brokers.groww.session);

    let angelCash = null;

    let angelRows = [];

    try {

      const session = brokers.angelone?.session || null;

      if (session) {

        try {

          const AngelFunds = require('./angelone/funds');

          const fundsModule = new AngelFunds(session);

          const funds = await fundsModule.getRMS();

          if (funds && funds.net != null && !isNaN(Number(funds.net))) {

            angelCash = Number(funds.net);

            console.log(`[Server] Live Angel One RMS Cash Balance fetched: ₹${angelCash}`);

          }

        } catch (e) {

          console.error('[Server] Angel One live RMS funds fetch error:', e.message);

        }

      }

      angelRows = await portfolioService.getAngelPortfolio(session);



      // The broker 'error' hook only covers the websocket feeds, so a 403 on the

      // holdings endpoint used to leave the portfolio broken until a manual restart

      // (RMS funds kept working, which made it look like holdings were simply empty).

      // Relogin + retry once, rate-limited so concurrent requests can't stampede.

      const hst = portfolioService.getHoldingsStatus('angelone');

      if (session && !hst.ok && /403|unauthorized|expired/i.test(hst.error || '')) {

        const now = Date.now();

        if (!global.__angelHoldingsReloginAt || now - global.__angelHoldingsReloginAt > 60000) {

          global.__angelHoldingsReloginAt = now;

          try {

            await brokers.angelone.relogin();

            app.set('angelSession', brokers.angelone.session);

            console.log('[Server] Angel One relogged in after holdings 403 — retrying holdings');

            angelRows = await portfolioService.getAngelPortfolio(brokers.angelone.session);

          } catch (re) {

            console.error('[Server] Angel One relogin/retry after holdings 403 failed:', re.message);

          }

        }

      }

    } catch (err) {

      console.error('[Server] Angel One portfolio fetch error:', err.message);

      angelRows = [];

    }

    results.angelone = { connected: angelConnected, holdingsStatus: portfolioService.getHoldingsStatus('angelone'), holdings: angelRows, summary: portfolioService.summarize(angelRows, 'angelone', angelCash) };



    // Groww exposes no funds endpoint in this integration, so its cash is unknown

    // rather than a hardcoded 134.21.

    const growwCash = null;

    let growwRows = [];

    try {

      const session = brokers.groww?.session || null;

      const angelSess = brokers.angelone?.session || null;

      growwRows = await portfolioService.getGrowwPortfolio(session, angelSess);

    } catch (err) {

      console.error('[Server] Groww portfolio fetch error:', err.message);

      growwRows = [];

    }

    results.groww = { connected: growwConnected, holdingsStatus: portfolioService.getHoldingsStatus('groww'), holdings: growwRows, summary: portfolioService.summarize(growwRows, 'groww', growwCash) };



    const allRows = [

      ...angelRows.filter((r) => !r.error),

      ...growwRows.filter((r) => !r.error),

    ];

    const aCash = results.angelone.summary.cashBalance;

    const gCash = results.groww.summary.cashBalance;

    const combinedCash = (aCash != null || gCash != null) ? ((aCash || 0) + (gCash || 0)) : null;



    results.combined = {

      connected: angelConnected || growwConnected,

      holdings: allRows,

      summary: portfolioService.summarize(allRows, 'combined', combinedCash),

    };



    portfolioCache = results;

    portfolioCacheTime = Date.now();



    res.json(results);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// ---- Institutional & Promoter Money Holdings Database Endpoints ----







// ---- Institutional Conviction Scanner Endpoints & Scheduler ----

const { initScheduler } = require('./common/scheduler/cronJobs');



try { initScheduler(); } catch (e) { console.warn('Scheduler init warning:', e.message); }



// ---- WHAT THE LIVE SESSION IS, DECLARED AT BOOT — NOT AS A SIDE EFFECT OF A LOGIN ----

//

// ARMED: OF_MOMENTUM, THE STRATEGY WHOSE CALLS THE OWNER HAS BEEN SEEING.

//

// It used to be armed from inside `armOrderflowCapture`, which only runs after a successful Angel

// One login. On 2026-10-19 the login failed with a 403, so the arming never happened — and the

// board would have reported "off" all day for a reason that had nothing to do with the strategy.

// The flag is a property of the SESSION, so it is set here, at boot, once.

//

// The flag still lives in the engine and defaults OFF, so a harness, a replay or a test can never

// put these calls on the board: only this process says yes. The caps are the 2026-10-19 review's

// condition for re-arming an unverified prototype — at most 3 of the 6 board slots, at most 12

// calls a session (counted from the day's own book, so a restart cannot reset it), and every

// admission logged with its score and its rank. GB_OF_MOMENTUM_LIVE=0 turns it off.

if (process.env.GB_OF_MOMENTUM_LIVE === '1') {

  try {

    liveMinuteEngine.enableOfMomentumLive({

      maxSlots: Number(process.env.GB_OF_MOMENTUM_SLOTS) || 3,

      maxPerSession: Number(process.env.GB_OF_MOMENTUM_MAX_PER_SESSION) || 12,

    });

  } catch (e) {

    console.error('[server] OF_MOMENTUM could not be armed:', (e && e.message) || e);

  }

} else {

  console.log('[server] OF_MOMENTUM left disarmed by GB_OF_MOMENTUM_LIVE=0 — verified setups only (GB01, GB03a).');

}



// THE BOT LISTENS TOO — /calls, /book, /status, /why.

//

// Alerts were one-way, so the one question that mattered on 2026-10-19 — "the phone shows calls,

// the page shows none, which is right?" — could only be asked from a laptop. The inbox answers

// from the engines this process is running, not from a copy of the page.

//

// IT DOES NOT DEPEND ON A BROKER LOGIN. `/status` is most useful exactly when the feed is down,

// which is why this sits at module scope beside the scheduler rather than inside the login path.

let _boardInbox = null;

function boardInbox() {

  if (_boardInbox) return _boardInbox;

  try {

    const { createInbox } = require('./common/notifications/telegramInbox');

    _boardInbox = createInbox({

      engine: liveMinuteEngine,

      session: liveSessionState,

      alerts: notificationState,

      feed: () => (brokers.angelone && typeof brokers.angelone.feedStatus === 'function')

        ? brokers.angelone.feedStatus() : { connected: false },

    });

  } catch (e) {

    console.error('[server] Telegram inbox unavailable:', (e && e.message) || e);

    _boardInbox = { maybeAnswer: () => null, handle: () => '' };

  }

  return _boardInbox;

}



/**

 * THE BOT LISTENS TOO — /calls, /book, /status, /why.

 *

 * ONE OWNER OF THE UPDATE STREAM. `telegramApprovals` already long-polls getUpdates and hands

 * non-approval text to `onText`; Telegram serves that stream to a single consumer, so a second

 * poller here would make BOTH miss messages (409 Conflict). The commands are therefore answered

 * from that same hook — see `startApprovalListener` — and this function only starts a poller of

 * its own in the one case where nobody else is polling: a valid token with no chat linked yet, so

 * the first message is what links the chat.

 */

function startTelegramInbox() {

  const cfg = telegramConfig.loadConfig() || {};

  if (!cfg.botToken) return;

  if (cfg.chatId) {

    console.log('[telegram-inbox] commands ready on the approval poller — /calls /book /status /why');

    return;

  }

  try {

    const { startInbox } = require('./common/notifications/telegramInbox');

    startInbox({ token: cfg.botToken, chatId: '', inbox: boardInbox() });

  } catch (e) {

    console.error('[server] Telegram inbox not started:', (e && e.message) || e);

  }

}













// ---- Stock Holdings Reverse Index (stock_holdings.db) ----

const stockHoldingsDbPath = path.join(__dirname, 'data', 'stock_holdings.db');

let stockHoldingsDb = null;

try {

  if (fs.existsSync(stockHoldingsDbPath)) {

    stockHoldingsDb = new Database(stockHoldingsDbPath, { readonly: true });

    console.log('[server] stock_holdings.db loaded');

  } else {

    // Auto-build if missing (e.g. on Render cold start)

    console.log('[server] stock_holdings.db missing — building from MF data...');

    try {

      const { execSync } = require('child_process');

      execSync('node scripts/buildStockHoldings.js', { cwd: __dirname, timeout: 60000 });

      stockHoldingsDb = new Database(stockHoldingsDbPath, { readonly: true });

      console.log('[server] stock_holdings.db built and loaded');

    } catch (buildErr) {

      console.warn('[server] stock_holdings.db build failed:', buildErr.message);

    }

  }

} catch (e) {

  console.warn('[server] stock_holdings.db not available:', e.message);

}



// ---- FII / Individual Investor Data (fii_investors.db) ----

const fiiDbPath = path.join(__dirname, 'data', 'fii_investors.db');

let fiiDb = null;

try {

  if (fs.existsSync(fiiDbPath)) {

    fiiDb = new Database(fiiDbPath, { readonly: true });

    console.log('[server] fii_investors.db loaded');

  }

} catch (e) {

  console.warn('[server] fii_investors.db not available:', e.message);

}



// ---- Mutual Funds DB Module ----

let hdfcMfDb = null;

try {

  hdfcMfDb = require('./db/mutualFunds');

  console.log('[server] db/mutualFunds loaded');

} catch (e) {

  console.warn('[server] db/mutualFunds not available:', e.message);

}





// GET /api/stock-holdings — All stocks with fund counts

app.get('/api/stock-holdings', (req, res) => {

  if (!stockHoldingsDb) return res.json({ success: true, stocks: [], totalStocks: 0 });

  try {

    const { search, sector, sort, limit } = req.query;

    let query = 'SELECT * FROM stocks';

    const params = [];

    const conditions = [];



    if (search) {

      conditions.push('(stockName LIKE ? OR normalizedName LIKE ?)');

      params.push('%' + search + '%', '%' + search.toUpperCase() + '%');

    }

    if (sector) {

      conditions.push('sector = ?');

      params.push(sector);

    }



    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');

    if (sort === 'weight') query += ' ORDER BY totalWeight DESC';

    else if (sort === 'value') query += ' ORDER BY totalMarketValue DESC';

    else query += ' ORDER BY totalFundsHolding DESC';

    query += ' LIMIT ?';

    params.push(limit ? Number(limit) : 200);



    const stocks = stockHoldingsDb.prepare(query).all(...params);

    const total = stockHoldingsDb.prepare('SELECT COUNT(*) as c FROM stocks').get().c;

    res.json({ success: true, totalStocks: total, stocks });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/stock-holdings/:stockId — Which funds hold this stock

app.get('/api/stock-holdings/:stockId', (req, res) => {

  if (!stockHoldingsDb) return res.json({ success: true, funds: [] });

  try {

    const { stockId } = req.params;

    const stock = stockHoldingsDb.prepare('SELECT * FROM stocks WHERE id = ?').get(stockId);

    if (!stock) return res.status(404).json({ success: false, error: 'Stock not found' });



    const funds = stockHoldingsDb.prepare(`

      SELECT sfm.fundId, f.schemeName, f.amc, f.category, f.aum, f.aumDate,

             sfm.weight, sfm.marketValue, sfm.portfolioDate

      FROM stock_fund_map sfm

      JOIN funds f ON sfm.fundId = f.id

      WHERE sfm.stockId = ?

      ORDER BY sfm.weight DESC

    `).all(stockId);



    res.json({ success: true, stock, funds, totalFunds: funds.length });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/stock-holdings/sectors — List all sectors with counts

app.get('/api/stock-holdings/sectors/list', (req, res) => {

  if (!stockHoldingsDb) return res.json({ success: true, sectors: [] });

  try {

    const sectors = stockHoldingsDb.prepare(`

      SELECT sector, COUNT(*) as stockCount, ROUND(SUM(totalWeight),2) as totalWeight

      FROM stocks WHERE sector IS NOT NULL AND sector != ''

      GROUP BY sector ORDER BY stockCount DESC

    `).all();

    res.json({ success: true, sectors });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});





// GET /api/fii-dii/daily — FII/DII daily trading activity

app.get('/api/fii-dii/daily', (req, res) => {

  if (!fiiDb) return res.json({ success: true, data: [] });

  try {

    const { days } = req.query;

    const limit = days ? Number(days) : 30;

    const data = fiiDb.prepare(`

      SELECT * FROM fii_dii_daily ORDER BY date DESC LIMIT ?

    `).all(limit);

    res.json({ success: true, data });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/fii-dii/shareholding — Company shareholding patterns

app.get('/api/fii-dii/shareholding', (req, res) => {

  if (!fiiDb) return res.json({ success: true, data: [], totalCompanies: 0 });

  try {

    const { search, sort } = req.query;

    let query = 'SELECT * FROM company_shareholding';

    const params = [];

    if (search) {

      query += ' WHERE companyName LIKE ? OR symbol LIKE ?';

      params.push('%' + search + '%', '%' + search.toUpperCase() + '%');

    }

    if (sort === 'fii') query += ' ORDER BY fiiPct DESC';

    else if (sort === 'dii') query += ' ORDER BY diiPct DESC';

    else if (sort === 'promoter') query += ' ORDER BY promoterPct DESC';

    else query += ' ORDER BY fiiPct DESC';

    query += ' LIMIT 200';

    const data = fiiDb.prepare(query).all(...params);

    const total = fiiDb.prepare('SELECT COUNT(DISTINCT companyName) as c FROM company_shareholding').get().c;

    res.json({ success: true, data, totalCompanies: total });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/fii-dii/investors — Individual significant investors

app.get('/api/fii-dii/investors', (req, res) => {

  if (!fiiDb) return res.json({ success: true, investors: [] });

  try {

    const { search, sort } = req.query;

    let query = 'SELECT * FROM individual_investors';

    const params = [];

    if (search) {

      query += ' WHERE investorName LIKE ?';

      params.push('%' + search + '%');

    }

    if (sort === 'value') query += ' ORDER BY totalPortfolioValue DESC';

    else query += ' ORDER BY holdingsCount DESC';

    query += ' LIMIT 100';

    const investors = fiiDb.prepare(query).all(...params);

    res.json({ success: true, investors });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/fii-dii/investors/:investorId/holdings — Holdings of a specific investor

app.get('/api/fii-dii/investors/:investorId/holdings', (req, res) => {

  if (!fiiDb) return res.json({ success: true, holdings: [] });

  try {

    const { investorId } = req.params;

    const investor = fiiDb.prepare('SELECT * FROM individual_investors WHERE id = ?').get(investorId);

    if (!investor) return res.status(404).json({ success: false, error: 'Investor not found' });

    const holdings = fiiDb.prepare('SELECT * FROM investor_holdings WHERE investorId = ? ORDER BY holdingPct DESC').all(investorId);

    res.json({ success: true, investor, holdings });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/fii-dii/status — Source status for monitoring

app.get('/api/fii-dii/status', (req, res) => {

  if (!fiiDb) return res.json({ success: true, sources: [] });

  try {

    const sources = fiiDb.prepare('SELECT * FROM source_status ORDER BY lastAttempt DESC').all();

    res.json({ success: true, sources });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// ─── Section 4: International AMCs ───────────────────────────────

app.get('/api/fii-dii/international-amcs', (req, res) => {

  if (!fiiDb) return res.json({ success: true, amcs: [] });

  try {

    const { search, sort } = req.query;

    let q = 'SELECT * FROM international_amcs';

    const params = [];

    if (search) { q += ' WHERE name LIKE ?'; params.push('%' + search + '%'); }

    if (sort === 'aum') q += ' ORDER BY aumUsdBn DESC';

    else q += ' ORDER BY name ASC';

    q += ' LIMIT 100';

    const amcs = fiiDb.prepare(q).all(...params);

    res.json({ success: true, amcs, totalAmcs: amcs.length });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



// ─── Section 5: International Funds / ETFs ───────────────────────

app.get('/api/fii-dii/international-funds', (req, res) => {

  if (!fiiDb) return res.json({ success: true, funds: [] });

  try {

    const { amcId, search, sort } = req.query;

    let q = 'SELECT * FROM international_funds';

    const params = [];

    const conds = [];

    if (amcId) { conds.push('amcId = ?'); params.push(Number(amcId)); }

    if (search) { conds.push('(fundName LIKE ? OR amcName LIKE ?)'); params.push('%' + search + '%', '%' + search + '%'); }

    if (conds.length) q += ' WHERE ' + conds.join(' AND ');

    if (sort === 'aum') q += ' ORDER BY aumUsd DESC';

    else q += ' ORDER BY fundName ASC';

    q += ' LIMIT 200';

    const funds = fiiDb.prepare(q).all(...params);

    res.json({ success: true, funds, totalFunds: funds.length });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



app.get('/api/fii-dii/international-funds/:fundId/holdings', (req, res) => {

  if (!fiiDb) return res.json({ success: true, holdings: [] });

  try {

    const fund = fiiDb.prepare('SELECT * FROM international_funds WHERE id = ?').get(req.params.fundId);

    if (!fund) return res.status(404).json({ success: false, error: 'Fund not found' });

    const holdings = fiiDb.prepare('SELECT * FROM international_fund_holdings WHERE fundId = ? ORDER BY holdingPct DESC').all(req.params.fundId);

    res.json({ success: true, fund, holdings });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



// ─── Section 6: Key Investors ────────────────────────────────────

app.get('/api/fii-dii/key-investors', (req, res) => {

  if (!fiiDb) return res.json({ success: true, investors: [] });

  try {

    const { type, search, sort } = req.query;

    let q = 'SELECT * FROM key_investors';

    const params = [];

    const conds = [];

    if (type) { conds.push('investorType = ?'); params.push(type); }

    if (search) { conds.push('name LIKE ?'); params.push('%' + search + '%'); }

    if (conds.length) q += ' WHERE ' + conds.join(' AND ');

    if (sort === 'value') q += ' ORDER BY totalPortfolioValueInr DESC';

    else if (sort === 'holdings') q += ' ORDER BY holdingsCount DESC';

    else q += ' ORDER BY name ASC';

    q += ' LIMIT 200';

    const investors = fiiDb.prepare(q).all(...params);

    res.json({ success: true, investors, totalInvestors: investors.length });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



app.get('/api/fii-dii/key-investors/:investorId/holdings', (req, res) => {

  if (!fiiDb) return res.json({ success: true, holdings: [] });

  try {

    const investor = fiiDb.prepare('SELECT * FROM key_investors WHERE id = ?').get(req.params.investorId);

    if (!investor) return res.status(404).json({ success: false, error: 'Investor not found' });

    const holdings = fiiDb.prepare('SELECT * FROM key_investor_holdings WHERE investorId = ? ORDER BY holdingPct DESC').all(req.params.investorId);

    res.json({ success: true, investor, holdings });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



// ─── Section 7: Promoters / Strategic Holders ─────────────────────

app.get('/api/fii-dii/promoters', (req, res) => {

  if (!fiiDb) return res.json({ success: true, promoters: [] });

  try {

    const { type, search, sort } = req.query;

    let q = 'SELECT * FROM promoters';

    const params = [];

    const conds = [];

    if (type) { conds.push('promoterType = ?'); params.push(type); }

    if (search) { conds.push('name LIKE ?'); params.push('%' + search + '%'); }

    if (conds.length) q += ' WHERE ' + conds.join(' AND ');

    if (sort === 'value') q += ' ORDER BY totalValueInr DESC';

    else if (sort === 'shares') q += ' ORDER BY totalShares DESC';

    else q += ' ORDER BY name ASC';

    q += ' LIMIT 200';

    const promoters = fiiDb.prepare(q).all(...params);

    res.json({ success: true, promoters, totalPromoters: promoters.length });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



app.get('/api/fii-dii/promoters/:promoterId/holdings', (req, res) => {

  if (!fiiDb) return res.json({ success: true, holdings: [] });

  try {

    const promoter = fiiDb.prepare('SELECT * FROM promoters WHERE id = ?').get(req.params.promoterId);

    if (!promoter) return res.status(404).json({ success: false, error: 'Promoter not found' });

    const holdings = fiiDb.prepare('SELECT * FROM promoter_holdings WHERE promoterId = ? ORDER BY holdingPct DESC').all(req.params.promoterId);

    res.json({ success: true, promoter, holdings });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



// ─── Company Master ──────────────────────────────────────────────

app.get('/api/fii-dii/companies', (req, res) => {

  if (!fiiDb) return res.json({ success: true, companies: [] });

  try {

    const { search, sector } = req.query;

    let q = 'SELECT * FROM companies';

    const params = [];

    const conds = [];

    if (search) { conds.push('(name LIKE ? OR isin LIKE ? OR ticker LIKE ?)'); params.push('%' + search + '%', '%' + search + '%', '%' + search.toUpperCase() + '%'); }

    if (sector) { conds.push('sector = ?'); params.push(sector); }

    if (conds.length) q += ' WHERE ' + conds.join(' AND ');

    q += ' ORDER BY name ASC LIMIT 200';

    const companies = fiiDb.prepare(q).all(...params);

    res.json({ success: true, companies, totalCompanies: companies.length });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



app.get('/api/fii-dii/companies/:companyId/all-holders', (req, res) => {

  if (!fiiDb) return res.json({ success: true, holders: {} });

  try {

    const cid = Number(req.params.companyId);

    const company = fiiDb.prepare('SELECT * FROM companies WHERE id = ?').get(cid);

    if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

    const promoters = fiiDb.prepare('SELECT * FROM promoter_holdings WHERE companyId = ?').all(cid);

    const intlHoldings = fiiDb.prepare('SELECT ih.*, f.fundName, f.amcName FROM international_fund_holdings ih JOIN international_funds f ON ih.fundId = f.id WHERE ih.companyId = ?').all(cid);

    const keyHoldings = fiiDb.prepare('SELECT kh.*, ki.name as investorName, ki.investorType FROM key_investor_holdings kh JOIN key_investors ki ON kh.investorId = ki.id WHERE kh.companyId = ?').all(cid);

    const shareholding = fiiDb.prepare('SELECT * FROM company_shareholding WHERE companyName LIKE ?').all(company.name);

    res.json({ success: true, company, promoters, internationalHoldings: intlHoldings, keyInvestorHoldings: keyHoldings, shareholdingPatterns: shareholding });

  } catch (err) { res.status(500).json({ success: false, error: err.message }); }

});



// ---- HDFC Mutual Fund Scheme Data (from SQLite — real scheme-level data) ----

hdfcMfDb = hdfcMfDb || require("./db/mutualFunds");



// registerDebugRoute(app);



// IMPORTANT: Static routes BEFORE :schemeId to avoid Express param matching



// GET /api/mutual-funds/all — List ALL AMC schemes with summary (multi-AMC endpoint)



// GET /api/mutual-funds/all-schemes-summary — Lightweight summary for Smart Money page

app.get('/api/mutual-funds/all-schemes-summary', (req, res) => {

  try {

    if (!hdfcMfDb) return res.json({ success: true, totalSchemes: 0, totalAmcs: 0, totalAum: 0, totalStocks: 0, schemes: [] });

    const schemes = hdfcMfDb.getAllSchemesSummary();

    const totalAum = schemes.reduce((sum, s) => sum + (s.aum || 0), 0);

    const totalStocks = schemes.reduce((sum, s) => sum + (s.totalHoldings || 0), 0);

    const byAmc = {};

    for (const s of schemes) {

      const a = s.amc || 'Unknown';

      if (!byAmc[a]) byAmc[a] = 0;

      byAmc[a]++;

    }

    res.json({

      success: true,

      totalSchemes: schemes.length,

      totalAmcs: Object.keys(byAmc).length,

      totalAum,

      totalStocks: Math.round(totalStocks / 10),

      schemes: schemes.slice(0, parseInt(req.query.limit) || 10)

    });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



app.get('/api/mutual-funds/all', (req, res) => {

  try {

    const { search, amc, category, limit } = req.query;

    let schemes = hdfcMfDb.getAllSchemesSummary();



    // Filter by AMC

    if (amc) {

      const amcLower = amc.toLowerCase();

      schemes = schemes.filter(s => (s.amc || '').toLowerCase().includes(amcLower));

    }



    // Filter by category

    if (category) {

      const catLower = category.toLowerCase();

      schemes = schemes.filter(s => (s.category || '').toLowerCase().includes(catLower));

    }



    // Search filter

    if (search) {

      const q = search.toLowerCase();

      schemes = schemes.filter(s =>

        (s.schemeName || '').toLowerCase().includes(q) ||

        (s.amc || '').toLowerCase().includes(q) ||

        (s.category || '').toLowerCase().includes(q) ||

        (s.id || '').toLowerCase().includes(q)

      );

    }



    // Limit

    const lim = limit ? parseInt(limit) : 5000;

    schemes = schemes.slice(0, lim);



    // Group by AMC for summary

    const byAmc = {};

    for (const s of schemes) {

      const a = s.amc || 'Unknown';

      if (!byAmc[a]) byAmc[a] = { count: 0, schemes: [] };

      byAmc[a].count++;

    }



    res.json({

      success: true,

      totalSchemes: schemes.length,

      totalAmcs: Object.keys(byAmc).length,

      amcSummary: Object.entries(byAmc).map(([name, d]) => ({ name, count: d.count })),

      source: 'Multi-AMC Official Data (SQLite)',

      schemes

    });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/mutual-funds/amcs — List all AMCs with scheme counts

app.get('/api/mutual-funds/amcs', (req, res) => {

  try {

    const schemes = hdfcMfDb.getAllSchemesSummary();

    const byAmc = {};

    for (const s of schemes) {

      const a = s.amc || 'Unknown';

      if (!byAmc[a]) byAmc[a] = { name: a, count: 0, categories: new Set() };

      byAmc[a].count++;

      if (s.category) byAmc[a].categories.add(s.category);

    }

    const amcs = Object.values(byAmc)

      .map(a => ({ ...a, categories: Array.from(a.categories) }))

      .sort((a, b) => b.count - a.count);

    res.json({ success: true, totalAmcs: amcs.length, totalSchemes: schemes.length, amcs });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// POST /api/mutual-funds/run-all — Trigger multi-AMC import pipeline

let allAmcPipelineRunning = false;

app.post('/api/mutual-funds/run-all', async (req, res) => {

  if (allAmcPipelineRunning) {

    return res.json({ success: true, message: 'Multi-AMC pipeline already running...' });

  }

  allAmcPipelineRunning = true;

  res.json({ success: true, message: 'Multi-AMC pipeline started. Check back in 3-5 minutes.' });

  try {

    const MfOrchestrator = require('./common/mf-engine/orchestrator');

    const orch = new MfOrchestrator(hdfcMfDb, { perAmcConcurrency: 5 });

    await orch.runAll();

    console.log('[server] Multi-AMC pipeline completed via manual trigger');

  } catch (err) {

    console.error('[server] Multi-AMC pipeline failed:', err.message);

  } finally {

    allAmcPipelineRunning = false;

  }

});



// GET /api/mutual-funds/hdfc — List all HDFC schemes with summary

// Auto-triggers pipeline if database is empty

let hdfcAutoTriggered = false;

app.get('/api/mutual-funds/hdfc', (req, res) => {

  try {

    // Auto-trigger pipeline if DB is empty or data is stale (>1 day old)

    const schemeCount = hdfcMfDb.getAllSchemes().length;

    const shouldRefresh = schemeCount === 0 || (() => {

      try {

        const latest = hdfcMfDb.getDb().prepare('SELECT MAX(asOfDate) as d FROM mutual_fund_returns').get();

        if (!latest || !latest.d) return true;

        const ageMs = Date.now() - new Date(latest.d).getTime();

        return ageMs > 24 * 60 * 60 * 1000;

      } catch (_) { return true; }

    })();

    if (shouldRefresh && !hdfcAutoTriggered) {

      hdfcAutoTriggered = true;

      const reason = schemeCount === 0 ? 'empty' : 'stale (>1 day old)';

      console.log('[server] HDFC MF DB ' + reason + ' — auto-refreshing from Groww...');

      const { main: runGrowwPipeline } = require('./scripts/hdfc/importGrowwEquity');

      runGrowwPipeline().then(() => {

        console.log('[server] HDFC MF Groww refresh completed');

        hdfcAutoTriggered = false;

      }).catch(err => {

        console.error('[server] HDFC MF Groww refresh failed:', err.message);

        hdfcAutoTriggered = false; // allow retry

      });

    }



    const { search } = req.query;

    let schemes = hdfcMfDb.getAllSchemesSummary();



    if (search) {

      const q = search.toLowerCase();

      schemes = schemes.filter(s =>

        (s.schemeName || '').toLowerCase().includes(q) ||

        (s.category || '').toLowerCase().includes(q) ||

        (s.id || '').toLowerCase().includes(q) ||

        (s.topHoldings || []).some(h => (h.securityName || '').toLowerCase().includes(q))

      );

    }



    res.json({

      success: true,

      totalSchemes: schemes.length,

      source: 'HDFC Official Data (SQLite)',

      schemes

    });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/mutual-funds/hdfc/data-status — Data integrity report

app.get('/api/mutual-funds/hdfc/data-status', (req, res) => {

  try {

    const report = hdfcMfDb.validateIntegrity();

    res.json({ success: true, report });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// POST /api/mutual-funds/hdfc/run-pipeline — Trigger HDFC data import

let hdfcPipelineRunning = false;

app.post('/api/mutual-funds/hdfc/run-pipeline', async (req, res) => {

  if (hdfcPipelineRunning) {

    return res.json({ success: true, message: 'Pipeline already running...' });

  }

  hdfcPipelineRunning = true;

  res.json({ success: true, message: 'HDFC pipeline started. Check back in 2-3 minutes.' });

  try {

    const { main: runGrowwPipeline } = require('./scripts/hdfc/importGrowwEquity');

    await runGrowwPipeline();

    console.log('[server] HDFC MF Groww pipeline completed via manual trigger');

  } catch (err) {

    console.error('[server] HDFC MF pipeline failed:', err.message);

  } finally {

    hdfcPipelineRunning = false;

  }

});



// NOW the :schemeId routes (after static routes)



// GET /api/mutual-funds/hdfc/:schemeId — Full scheme profile with latest holdings

app.get('/api/mutual-funds/hdfc/:schemeId', (req, res) => {

  try {

    const { schemeId } = req.params;

    const profile = hdfcMfDb.getSchemeProfile(schemeId);

    if (!profile) {

      return res.status(404).json({ success: false, error: `Scheme '${schemeId}' not found` });

    }

    res.json({ success: true, scheme: profile });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/mutual-funds/hdfc/:schemeId/holdings — Full holdings for a specific month

app.get('/api/mutual-funds/hdfc/:schemeId/holdings', (req, res) => {

  try {

    const { schemeId } = req.params;

    const { month, date } = req.query;



    // Get available portfolio dates

    const dates = hdfcMfDb.getPortfolioDates(schemeId);

    if (!dates || dates.length === 0) {

      return res.status(404).json({ success: false, error: `No portfolio data for '${schemeId}'` });

    }



    // Determine which date to fetch

    let targetDate = null;

    if (date) {

      targetDate = date;

    } else if (month) {

      const monthLower = month.toLowerCase();

      const match = dates.find(d => d.portfolioDate.startsWith(monthLower) || d.portfolioDate.includes(monthLower));

      if (match) targetDate = match.portfolioDate;

    }



    const portfolio = hdfcMfDb.getHoldingsByDate(schemeId, targetDate);

    if (!portfolio) {

      return res.status(404).json({ success: false, error: `Portfolio not found for '${schemeId}' at date '${targetDate || 'latest'}'` });

    }



    res.json({

      success: true,

      schemeId,

      schemeName: (hdfcMfDb.getScheme(schemeId) || {}).schemeName || schemeId,

      portfolioDate: portfolio.portfolioDate,

      totalHoldings: portfolio.holdings.length,

      availableMonths: dates.map(d => ({ date: d.portfolioDate, totalHoldings: d.totalHoldings })),

      holdings: portfolio.holdings

    });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/mutual-funds/hdfc/:schemeId/months — List available portfolio months

app.get('/api/mutual-funds/hdfc/:schemeId/months', (req, res) => {

  try {

    const { schemeId } = req.params;

    const dates = hdfcMfDb.getPortfolioDates(schemeId);

    res.json({

      success: true,

      schemeId,

      totalMonths: dates.length,

      months: dates.map(d => ({ date: d.portfolioDate, totalHoldings: d.totalHoldings }))

    });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// GET /api/mutual-funds/hdfc/:schemeId/nav-history — NAV chart from portfolio date to today

app.get('/api/mutual-funds/hdfc/:schemeId/nav-history', async (req, res) => {

  try {

    const { schemeId } = req.params;

    const portfolioDate = req.query.from || null; // e.g. ?from=2026-07-30

    const scheme = hdfcMfDb.getScheme(schemeId);

    if (!scheme) return res.status(404).json({ success: false, error: 'Scheme not found' });



    // Get stored NAV history first

    const history = hdfcMfDb.getNavHistory(schemeId, 90);

    if (history && history.length > 5) {

      let filtered = history;

      if (portfolioDate) {

        filtered = history.filter(h => h.navDate >= portfolioDate);

      }

      if (filtered.length >= 2) {

        return res.json({

          success: true, schemeId, schemeName: scheme.schemeName,

          portfolioDate: portfolioDate || filtered[0].navDate,

          source: 'tracked', dataPoints: filtered.length,

          data: filtered.reverse().map(h => ({ date: h.navDate, nav: h.nav }))

        });

      }

    }



    // Fallback: fetch real NAV history from mfapi.in (works for ALL schemes)

    const axios = require('axios');

    const schemeCode = scheme.schemeCode;

    if (!schemeCode) return res.json({ success: true, schemeId, data: [] });



    try {

      const resp = await axios.get(`https://api.mfapi.in/mf/${schemeCode}`, { timeout: 15000 });

      const mfData = resp.data;

      if (mfData && mfData.data && mfData.data.length > 0) {

        // mfapi.in returns most recent first, reverse to chronological

        const raw = mfData.data.slice(0, 120).reverse(); // ~6 months of data

        var allNav = raw.map(d => ({

          date: d.date.split('-').reverse().join('-'), // DD-MM-YYYY -> YYYY-MM-DD

          nav: parseFloat(d.nav)

        })).filter(d => !isNaN(d.nav));



        // Filter from portfolio date if provided

        let data = allNav;

        if (portfolioDate) {

          data = allNav.filter(d => d.date >= portfolioDate);

        }

        // If too few points, use all available

        if (data.length < 5) data = allNav;



        if (data.length > 0) {

          const currentNav = data[data.length - 1].nav;

          const startNav = data[0].nav;

          const pctChange = ((currentNav - startNav) / startNav * 100).toFixed(2);

          return res.json({

            success: true, schemeId, schemeName: scheme.schemeName,

            portfolioDate: portfolioDate || data[0].date,

            source: 'mfapi.in', currentNav, pctChange: parseFloat(pctChange),

            dataPoints: data.length, data

          });

        }

      }

    } catch (e) { /* mfapi.in failed */ }



    res.json({ success: true, schemeId, data: [], message: 'No NAV data available' });

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



// POST /api/mutual-funds/hdfc/track-nav — Trigger daily NAV tracking

app.post('/api/mutual-funds/hdfc/track-nav', async (req, res) => {

  try {

    const { trackDailyNav } = require('./scripts/hdfc/trackNavHistory');

    res.json({ success: true, message: 'NAV tracking started...' });

    trackDailyNav().then(() => console.log('[server] NAV tracking completed')).catch(err => console.error('[server] NAV tracking failed:', err.message));

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});





// ---- Instruments ----

app.get('/api/instruments/status', (req, res) => {

  res.json(instrumentService.status());

});



// ---- Instruments ----

app.get('/api/instruments/resolve', (req, res) => {

  try {

    const { symbol, exchange } = req.query;

    if (!symbol) return res.status(400).json({ error: 'symbol query param is required' });

    res.json(instrumentService.resolveEquity(symbol, { exchange }));

  } catch (err) {

    res.status(503).json({ error: err.message });

  }

});



// GET /api/instruments/watchlist?symbols=NIFTY,BANKNIFTY,GOLD,SILVER

app.get('/api/instruments/watchlist', async (req, res) => {

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');

  res.set('Pragma', 'no-cache');

  res.set('Expires', '0');



  try {

    const rawSymbols = (req.query.symbols || 'NIFTY,BANKNIFTY,SENSEX,FINNIFTY,MIDCPNIFTY,GIFTNIFTY,GOLD,SILVER,CRUDEOIL,NATURALGAS').split(',').map(s => s.trim().toUpperCase());

    const quotes = await liveQuoteEngine.fetchWatchlistQuotes(rawSymbols);

    res.json(quotes);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



const liveStockQuoteService = require('./common/market/liveStockQuoteService');



// GET /api/instruments/quote?symbol=RELIANCE

app.get('/api/instruments/quote', async (req, res) => {

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');

  res.set('Pragma', 'no-cache');

  res.set('Expires', '0');



  try {

    const symbol = req.query.symbol || 'RELIANCE';

    const quote = await liveStockQuoteService.fetchLiveStockQuote(symbol);

    res.json(quote);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



// ---- GB Terminal Multi-Channel Notification API ----

app.get('/api/notifications/settings', (req, res) => {

  res.json(notificationService.loadConfig());

});



app.post('/api/notifications/settings', (req, res) => {

  const { botToken, chatId, whatsappApiKey, enabled } = req.body;

  const cfg = notificationService.saveConfig({

    botToken: botToken || '',

    chatId: chatId || '',

    whatsappApiKey: whatsappApiKey || '',

    enabled: enabled !== false

  });

  res.json({ success: true, config: cfg });

});



app.post('/api/notifications/send', async (req, res) => {

  try {

    const { title, symbol, message, price, rsi, reason, channels } = req.body || {};

    const result = await notificationService.sendAlert({

      title,

      symbol,

      message,

      price,

      rsi,

      reason,

      channels

    });

    res.json(result);

  } catch (err) {

    res.status(500).json({ success: false, error: err.message });

  }

});



app.post('/api/notifications/test', async (req, res) => {

  const { botToken, chatId, whatsappApiKey } = req.body || {};

  if (botToken || chatId || whatsappApiKey) {

    notificationService.saveConfig({ botToken, chatId, whatsappApiKey });

  }



  const result = await notificationService.sendAlert({

    title: 'GB TERMINAL MOBILE ALERT',

    symbol: 'GB TERMINAL ALGO',

    message: 'Mobile notifications connected successfully!',

    price: '24,420.50',

    reason: 'System Test Push Alert',

    channels: ['telegram', 'whatsapp']

  });



  res.json(result);

});







async function start() {

  try {

    const fs = require('fs');

    const path = require('path');

    const dataDir = path.join(__dirname, 'data');

    if (!fs.existsSync(dataDir)) {

      fs.mkdirSync(dataDir, { recursive: true });

    }

  } catch (e) {

    console.warn('[server] data directory creation warning:', e.message);

  }





  await initBrokers();

  // CONFIRM-FIRST LISTENER. Started after the brokers so an approval arriving during boot can

  // actually reach Angel One; a rejected proposal says so instead of failing on a half-set-up

  // process. It long-polls, so nothing here needs an inbound port or the tunnel.

  try { startApprovalListener(); } catch (e) { console.error('[telegramApprovals] could not start:', e.message); }

  instrumentService.refreshAll().then(

    (s) => console.log('[server] instrument master loaded:', s),

    (err) => console.error('[server] instrument master load failed:', err.message)

  ); // deliberately not awaited — server starts serving immediately, instrument search just 503s until this resolves





  



  // Bind through config/env so the PORT=0 convention is honoured. Reading process.env.PORT

  // directly meant a PORT of '0' bound the server to a RANDOM port (observed: it came up on

  // 61855 instead of 4000), leaving the page unreachable at the URL everyone knows. env.server

  // already encodes the rule: an empty or '0' PORT means 4000.

  const port = env.server.port;

  const host = env.server.host;





  // ONE SERVER, ONE BOOK — SINGLE-INSTANCE GUARD.

  // Every Telegram defect the channel showed on 2026-10-13 traces to CONCURRENT Server.js

  // processes: `logs/server_r26.log` (stopped ~10:23 IST), `logs/server_r26b.log` (running to

  // ~11:08 IST) and `logs/server_reorg.log` (armed from ~11:09 IST) overlap, and the channel

  // shows the fingerprints of that overlap — NEW CALL / exit pairs seconds apart with

  // DIVERGENT breadth and book values (two engines scanning the same tape independently),

  // ORDER FILLED pairs byte-identical at the same tape second (two sweep engines filling on

  // the same ticks), and scorecards whose engine book held a stale copy of the day's calls.

  // A second instance is easy to start by accident (`.freebuff/start-server.bat` and any

  // stray `node Server.js`), and on Windows a second `listen(4000)` can SUCCEED where Linux

  // would refuse, so nothing stopped it. The lock is one pidfile at `data/server.lock`:

  // a start while another server is healthy refuses and exits loudly; a lock from a process

  // that is NOT answering is stale and is claimed.

  const serverLockPath = path.join(__dirname, 'data', 'server.lock');

  try {

    let lockHeldByAnother = false;

    if (fs.existsSync(serverLockPath)) {

      try {

        const prev = JSON.parse(fs.readFileSync(serverLockPath, 'utf8'));

        const prevPort = Number(prev.port) || port || 4000;

        // The previous holder must actually answer; a lock from a crashed or killed

        // process is stale, not busy.

        lockHeldByAnother = await new Promise((resolve) => {

          const http = require('http');

          const req = http.get({ host: '127.0.0.1', port: prevPort, path: '/health', timeout: 1500 }, (res) => {

            res.resume(); resolve(true);

          });

          req.on('timeout', () => { req.destroy(); resolve(false); });

          req.on('error', () => resolve(false));

        });

      } catch (_) {

        lockHeldByAnother = false;

      }

    }

    if (lockHeldByAnother && process.env.GB_SKIP_INSTANCE_LOCK !== '1') {

      console.error(`[server] REFUSING TO START: another Server.js is already healthy on port ${port} ` +

        `(lock ${serverLockPath}). Two instances double-send every Telegram alert and each keeps its own ` +

        `call book. Stop the other one first, or start with GB_SKIP_INSTANCE_LOCK=1 to override consciously.`);

      process.exit(0);

    }

    fs.writeFileSync(serverLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), port: port }));

  } catch (e) {

    // A lock we cannot write must never stop the server; the EADDRINUSE guard below

    // still catches the overlap case it can see.

    console.warn('[server] single-instance lock warning:', e.message);

  }



  // Release the lock so the NEXT start is never treated as a still-running duplicate.

  process.on('exit', () => {

    try {

      const held = fs.existsSync(serverLockPath) ? JSON.parse(fs.readFileSync(serverLockPath, 'utf8')) : null;

      if (held && held.pid === process.pid) fs.unlinkSync(serverLockPath);

    } catch (_) {}

  });



  // BOUND, NOT SILENT. A bind failure must not surface as an unhandled listener error

  // (with auto-restart transports that becomes a crash-loop of half-running servers).

  app.on('error', (err) => {

    if (err && err.code === 'EADDRINUSE') {

      console.error(`[server] FATAL: port ${port} is already bound — another server (or a non-node ` +

        `holder) has it. Refusing to half-run; exiting.`);

      process.exit(1);

    }

  });



  app.listen(port, host, () => {

    console.log(`[server] OpenAlgo single server listening on http://${host}:${port}`);

    console.log(`[server] active brokers: ${Object.keys(brokers).join(', ') || '(none — check ANGEL_ENABLED/GROWW_ENABLED)'}`);

    // Pre-load tape bars and activate 1-minute engine immediately on boot (does not require broker login)

    try {

      liveMinuteEngine.start().catch((e) => console.error('[liveMinuteEngine] boot start error:', e.message));

    } catch (e) {

      console.error('[server] liveMinuteEngine failed to start at boot:', e.message);

    }

    // ONLY THE SERVER THAT WON THE PORT POLLS THE CHAT. A second instance that is about to refuse

    // the lock must not call getUpdates first: getUpdates confirms updates for the whole bot, so a

    // short-lived duplicate would eat the owner's commands and answer none of them.

    startTelegramInbox();

  });

}



if (require.main === module) {

  start();

}



module.exports = { app, initBrokers, brokers };

// GET /api/mutual-funds/metrics — Serve computed risk metrics for all schemes



// DEBUG: Trigger NAV collection + metrics computation on Render

