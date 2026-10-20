/**
 * orderflow/f1Live.js - SPEC 8.27 F1 evaluated on LIVE ticks.
 *
 * WHAT THIS IS. The research path (backtest/tapeflow.py + backtest/f1/flow_scalper.py) proved out
 * a mechanism on recorded tapes. This file is the same mechanism running on the live Angel feed,
 * so the values it reports are live values, not backtest values.
 *
 * WHAT IT IS NOT. It places no orders and touches no broker order endpoint. It reads ticks,
 * arms signals, journals them, and scores them. Execution is a separate, deliberate decision
 * this module never makes. Everything here is read-only.
 *
 * WHERE IT SITS IN THE LIVE PATH (the wiring, in order):
 *
 *   1. angelone/auth.js            - Angel One session (API key + PIN + TOTP) -> JWT
 *   2. angelone/marketFeed.js      - SmartWebSocketV2 binary feed; needs subscription MODE
 *                                    QUOTE(2) or SNAP_QUOTE(3), because lastTradedQuantity,
 *                                    volumeTradedToday, totalBuyQuantity and totalSellQuantity
 *                                    are ONLY parsed in those modes (LTP mode gives q=0)
 *   3. orderflow/armCapture.js     - resolves symbol -> Angel token via the instrument master,
 *                                    subscribes on its OWN correlation id ('gb_capture') in
 *                                    SNAP_QUOTE, and routes each tick
 *   4. orderflow/tickCapture.js    - stores the raw tick and appends the JSONL line
 *                                    {t,s,p,q,v,bq,sq[,bid,bidq,ask,askq]}
 *   5. THIS FILE                   - consumes the SAME row object step 4 stored, so live and
 *                                    research see byte-identical input
 *
 * WHY IT CONSUMES tickCapture's ROW SHAPE. Order flow is derived from `p`, `q`, `bq`, `sq` and the
 * level-1 `bid`/`ask` prices. If the live path parsed the raw Angel payload itself it could drift
 * from the recorded tape, and then every researched number would be describing a different
 * instrument than the one being traded. One parser, one shape.
 *
 * THE BID/ASK ORIENTATION. The recorded tapes carry `bid` and `ask` SWAPPED (SPEC 8.22B, measured
 * again in 8.27M: ~96-100% of reconstructed books look crossed, with a 3.4-3.6 bps gap that is a
 * plausible real spread). This module measures the crossed fraction live and only trusts the quote
 * rule once that measurement says the book is usable; otherwise it falls back to the tick rule and
 * SAYS SO, rather than silently emitting a sign-flipped delta.
 *
 * THE RULES (SPEC 8.27E/F/H), unchanged from the pre-registration:
 *   big bar      bar total >= vol_mult x the rolling median of the previous 20 bars
 *   flow         FI = (buy - sell) / (buy + sell) with |FI| >= flow_theta
 *   book         BI = (bq - sq) / (bq + sq) with |BI| >= book_theta
 *   location     SHORT needs close at/above the running session POC; LONG at/below
 *   pattern      one of the 8.27F candles, on the signal bar, matching the side
 *   entry        the NEXT bar's open - you cannot enter a bar that has already closed
 *   stop         the far side of the SIGNAL candle
 *   target       the running session POC, else the nearest node on the profitable side
 *   exit early   an opposite big-flow bar -> out at the NEXT bar's open
 *   stop order   stop is tested BEFORE target on the same bar (conservative)
 *   flat         by session close
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IST_MS = 5 * 3600 * 1000 + 30 * 60 * 1000;
const SESS_OPEN_MIN = 9 * 60 + 15;
const SESS_CLOSE_MIN = 15 * 60 + 30;
const BAR_MIN = 5;
const ROLL = 20;
const MIN_BARS_PER_SESSION = 20;   // tapeflow.py line 57

// SPEC 8.27E grid, frozen. Live and research use the same numbers.
const VOL_MULT = [1.5, 2.0, 3.0];
const FLOW_THETA = [0.0, 0.10, 0.20];
const BOOK_THETA = [0.0, 0.10, 0.20];

const IMPACT_BPS = 2.0;
const STATUTORY_BPS = 9.5578;
const MIN_STOP_BPS = 5.0;
const MAX_STOP_PCT = 0.02;

const DTICK = 0.05;
const JOURNAL_DIR = process.env.GB_ORDERFLOW_DIR || path.join(__dirname, '..', '..', 'data', 'orderflow');

function istMinute(t) { return Math.floor((t + IST_MS) / 60000) % 1440; }
function istDay(t) {
  const d = new Date(t + IST_MS);
  return d.toISOString().slice(0, 10);
}
/** Start minute of the 5m bar, or null outside the session. */
function barStart(t) {
  const m = istMinute(t);
  if (m < SESS_OPEN_MIN || m >= SESS_CLOSE_MIN) return null;
  return SESS_OPEN_MIN + BAR_MIN * Math.floor((m - SESS_OPEN_MIN) / BAR_MIN);
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// The bar's traded volume is ALWAYS derived as buy + sell + unc, never kept as a separately
// accumulated total. The research path computes `b['total'] = b['buy'] + b['sell'] + b['unc']`,
// and a separate accumulator rounds differently in the last bits - enough to flip a
// `bar_total >= vol_mult * base` comparison that sits exactly on the boundary, which showed up
// as a handful of signal mismatches on the larger 10-07 session.
function total(b) { return b.buy + b.sell + b.unc; }

/** SPEC 8.27F. Strict predicates; returns the ids that fired on this bar. */
function patterns(b, p) {
  const out = [];
  const rng = b.h - b.l;
  const body = Math.abs(b.c - b.o);
  const upper = b.h - Math.max(b.o, b.c);
  const lower = Math.min(b.o, b.c) - b.l;
  const bull = b.c > b.o;
  if (rng <= 0) return out;
  if (body / rng >= 0.90) out.push(bull ? 'marubozu-bull' : 'marubozu-bear');
  if (body / rng <= 0.10) out.push('doji');
  if (body > 0 && lower >= 2 * body && upper <= 0.30 * body) out.push('hammer');
  if (body > 0 && upper >= 2 * body && lower <= 0.30 * body) out.push('shooting_star');
  if (p) {
    const pbody = Math.abs(p.c - p.o);
    if (body > pbody && Math.max(b.o, b.c) >= Math.max(p.o, p.c) &&
        Math.min(b.o, b.c) <= Math.min(p.o, p.c)) {
      out.push(bull ? 'engulf-bull' : 'engulf-bear');
    }
    if (b.h <= p.h && b.l >= p.l) out.push('inside_bar');
    if (b.h > p.h && b.l < p.l) out.push('outside_bar');
  }
  if (lower >= 0.60 * rng && lower >= 2 * body) out.push('pin_bar-bull');
  if (upper >= 0.60 * rng && upper >= 2 * body) out.push('pin_bar-bear');
  return out;
}

const BEARISH = new Set(['marubozu-bear', 'shooting_star', 'engulf-bear', 'pin_bar-bear']);
const BULLISH = new Set(['marubozu-bull', 'hammer', 'engulf-bull', 'pin_bar-bull']);

function createF1Live(opts) {
  const o = opts || {};
  const say = o.log || ((m) => console.log(m));
  const symbols = new Set((o.symbols || []).map((s) => String(s).toUpperCase()));
  const journalPath = o.journalPath ||
    path.join(JOURNAL_DIR, 'f1-signals-' + istDay(Date.now()) + '.jsonl');
  const frozenToll = o.frozenToll == null ? 41.5578 : o.frozenToll;

  const st = new Map();     // symbol -> state
  const armed = [];         // every signal ever armed this session
  // The session the state above belongs to. Server.js builds this module ONCE at boot, so without a
  // rollover check one instance spans days (see onTick).
  let curSessionDay = null;
  const stats = {
    ticks: 0, barsSealed: 0, thinSymbols: 0, armedCount: 0, confirmed: 0, skipped: 0,
    tickRuleOnly: 0, unclassified: 0, crossed: 0, booksSeen: 0,
    // Rows that moved a bar's PRICE without advancing `v` (SPEC 8.27X). Counted, not assumed: it is
    // the measurement that says how much of the price path 8.27U was throwing away.
    priceOnly: 0,
    // Tick-handler failures. This module is a PASSIVE listener on the same socket the trading
    // server reads, so a throw here must never escape into the emitter and interrupt the feed.
    // `safeTick` is what Server.js attaches; this counter is how a swallowed failure stays
    // VISIBLE instead of becoming silence that looks like a quiet market.
    errors: 0, firstError: null,
    startedAt: new Date().toISOString(), lastTickAt: null,
  };

  /**
   * safeTick(row) - the handler to attach to the live socket. Same tick, one guarantee: an
   * exception in the research evaluator stays inside the research evaluator.
   */
  function safeTick(row) {
    try { onTick(row); } catch (e) {
      stats.errors++;
      if (!stats.firstError) stats.firstError = String((e && e.message) || e);
      if (stats.errors <= 5) say('[f1/live] tick handler error (suppressed): ' + stats.firstError);
    }
  }

  function stateFor(sym) {
    let s = st.get(sym);
    if (!s) {
      s = {
        sym, bid: null, ask: null, bq: null, sq: null, v: null, vHwm: null, vBacksteps: 0,
        rawBid: null, rawAsk: null, swapVerdict: null,
        lastP: null, lastSide: null,
        bars: new Map(),        // barStart -> bar (still building)
        sealed: [],             // completed bars, oldest first
        profile: new Map(),     // price level -> cumulative session volume
        live: [],               // signals for this symbol not yet finished
        session: [],            // every signal this symbol produced this session
        cumBuy: 0, cumSell: 0, unclassified: 0,
      };
      st.set(sym, s);
    }
    return s;
  }

  function blankBar(t) {
    // `priceSet` mirrors tapeflow's `price_set`: it says whether the seed price below was a real
    // print or a carried-over one, so the first genuine print can re-seed the whole bar (8.27X).
    return { t, o: null, h: null, l: null, c: null, vol: 0, qsum: 0, buy: 0, sell: 0, unc: 0,
             trades: 0, levels: new Map(), bq: null, sq: null, bid: null, ask: null,
             priceSet: false };
  }

  // SESSION-WIDE ORIENTATION. The research path samples the tape once and applies ONE verdict to
  // every record (tapeflow.detect_orientation -> swapped=True). The measurement is ~95% crossed,
  // so the swapped reading is stable. Until the sample completes the module ASSUMES swapped -
  // which is what 8.22B documents the feed as being - and says so rather than pretending to know.
  let globalSwapped = null;
  const ORIENT_SAMPLE = 200000;

  /**
   * applyQuote(s, row) - carry each side forward INDEPENDENTLY (the feed sends one side per
   * record) and keep the orientation honest. Raw prices are kept and one verdict decides which
   * label is really which; only a book where bid < ask is used by the quote rule.
   */
  function applyQuote(s, row) {
    const b = Number(row.bid), a = Number(row.ask);
    if (Number.isFinite(b) && b > 0) s.rawBid = b;
    if (Number.isFinite(a) && a > 0) s.rawAsk = a;
    if (!(s.rawBid > 0) || !(s.rawAsk > 0)) return;
    if (stats.booksSeen < ORIENT_SAMPLE) {
      stats.booksSeen++;
      if (s.rawBid > s.rawAsk) stats.crossed++;
      if (stats.booksSeen === ORIENT_SAMPLE && globalSwapped === null) {
        globalSwapped = stats.crossed > stats.booksSeen / 2;
        say('[f1/live] bid/ask orientation resolved from ' + stats.booksSeen + ' books: ' +
            'crossed=' + (100 * stats.crossed / stats.booksSeen).toFixed(1) + '% -> ' +
            (globalSwapped ? 'SWAPPED (SPEC 8.22B)' : 'normal'));
      }
    }
    // Unresolved or swapped -> the lower price is the real bid. This is `swapped = True`, which is
    // the documented state of this feed and what the research run used.
    if (globalSwapped !== false) {
      s.bid = Math.min(s.rawBid, s.rawAsk); s.ask = Math.max(s.rawBid, s.rawAsk);
    } else { s.bid = s.rawBid; s.ask = s.rawAsk; }
  }

  /** onTick(row) - one captured tick, the same object tickCapture.record() stored. */
  function onTick(row) {
    if (!row) return;
    const sym = String(row.s || '').toUpperCase();
    if (!sym) return;
    if (symbols.size && !symbols.has(sym)) return;
    const p = Number(row.p);
    if (!(p > 0)) return;
    stats.ticks++;
    stats.lastTickAt = new Date().toISOString();

    // ---- SESSION ROLLOVER. The research path is PER SESSION and this module is built once at server
    // boot (Server.js line ~365), while closeSession() only seals and flushes - it never cleared the
    // per-symbol history. So a session after the first inherited the previous one twice over: `sealed`
    // fed the 20-bar volume baseline AND the POC value area, and `cumBuy`/`cumSell` fed the usability
    // rule. The first 20 bars of the new session would have been judged against yesterday's bars, which
    // the research run never does. Found while auditing which 20 bars the baseline covers (topic 7 of
    // the calculation sheet, question "is the 20-bar population session-local?") - it was not.
    const sessionDay = istDay(Number(row.t) || Date.now());
    if (curSessionDay === null) curSessionDay = sessionDay;
    else if (sessionDay !== curSessionDay) {
      say('[f1/live] session rollover ' + curSessionDay + ' -> ' + sessionDay
          + ': closing the previous session and clearing per-symbol state');
      try { closeSession(); }
      catch (e) { console.error('[f1/live] rollover closeSession failed:', e && e.message); }
      st.clear();
      armed.length = 0;
      curSessionDay = sessionDay;
    }

    const s = stateFor(sym);
    applyQuote(s, row);
    if (row.bq) s.bq = Number(row.bq);
    if (row.sq) s.sq = Number(row.sq);
    const v = Number(row.v);

    // ---- OUTSIDE THE SESSION FIRST, before anything touches the volume mark. tapeflow.build_session
    // calls bar_start() BEFORE it advances `v`, so a row stamped 08:00 or 16:05 moves neither the
    // baseline nor the high-water mark. Advancing the mark first is not a cosmetic difference: the
    // recorded tapes run 06:55-16:08, so the pre-open prints would hand the whole of the pre-open
    // volume to the first in-session bar, which is enough to move the big-bar gate and change the
    // signal set (measured: 342 signals missed and 82 invented on 10-06 before this ordering fix).
    const bs = barStart(Number(row.t));
    if (bs == null) {
      // PRE-SESSION ROWS ARE NOT USELESS (SPEC 8.27X). The last one before the open is the only
      // predecessor the session's first trade has: seeding the high-water mark from the first
      // IN-session row instead discards that row's own trade (8.27X measured BEL 10-06 opening at
      // 383.90, the SECOND printed price, instead of 383.35). tapeflow.build_session does the same.
      if (Number.isFinite(v)) s.preV = v;
      return;                               // outside the session
    }

    // ---- TRADED QUANTITY (SPEC 8.27R). `q` is a LAST-TRADED quantity that is re-emitted with every
    // snapshot - rows repeat byte for byte while the cumulative field `v` stands still - so summing
    // `q` per row under-reports real volume to about a seventh of the exchange's own number (0.13x
    // against Yahoo for the same minutes). The traded quantity is the advance of `v`. It is tracked
    // on a HIGH-WATER MARK because the feed is not monotonic: the recorded 2026-10-07 tape carries
    // 299,053 backward steps in `v`, the signature of duplicated/interleaved delivery, and counting
    // every forward step there inflates a session threefold. `q` is kept for audit only.
    let dv = 0;
    if (Number.isFinite(v)) {
      // Seeded from the last PRE-session row when there is one, so this session's first trade
      // registers its advance rather than being consumed as the baseline (SPEC 8.27X) - and the
      // advance is evaluated on THAT seeding row too. Leaving it inside the `else` swallowed the
      // session's first trade, which cost BSE 2026-10-06 its opening print: the live path opened at
      // 3210.00 where the research path and the exchange both print 3209.00 (found by
      // .freebuff/js_bar_parity.js, which compares the two paths' bars directly).
      if (s.vHwm == null) { s.vHwm = s.preV != null ? s.preV : v; s.v = v; }
      else {
        if (v < s.v) s.vBacksteps++;
        s.v = v;
      }
      if (v > s.vHwm) { dv = v - s.vHwm; s.vHwm = v; }
    }

    const q = Number(row.q) || 0;
    // ---- TWO GATES, NOT ONE (SPEC 8.27X, which supersedes 8.27U). 8.27U asked one question - did `v`
    // advance - and used the answer for BOTH price and volume. That is too strict: thousands of rows
    // per symbol per session carry a genuine price CHANGE with `dv === 0`, and dropping them put real
    // extremes out - BSE's 10-06 low, CAMS's open and BEL's 10-08 low (all measured, see SPEC 8.27X).
    // The replacement asks two questions:
    //     a row may move a bar's PRICE only if its price CHANGED from the last price seen
    //     a row may add VOLUME        only if `v` ADVANCED
    // What 8.27U existed for still holds: a pure repeat cannot set an open, because it has no price
    // change. The `q <= 0` term is kept so that rows which used to reach the bar-sealing block still do.
    const priceMoved = s.lastP == null || p !== s.lastP;
    if (q <= 0 && dv <= 0 && !priceMoved) return;   // a pure repeat: no trade and no price change

    // ---- bar roll, with a ONE-BAR SETTLE WINDOW.
    //
    // A bar is finalized only once a tick from a bar MORE THAN ONE BAR LATER arrives, so a bar
    // keeps absorbing ticks that arrive late. This is not defensive padding - it is required for
    // correctness. An earlier version sealed a bar on the first tick of the NEXT bar and then
    // dropped every subsequent tick stamped inside that bar, which silently deleted the tail of
    // a symbol's late-session bars (ASHOKLEY 10-07 bar 71: 33,392 of 42,749 volume) and moved
    // signals. The offline research path never sees this because it buckets every tick into a
    // dict and only sorts at the end.
    if (!s.bars.has(bs)) {
      const cutoff = bs - BAR_MIN;
      const stale = [...s.bars.keys()].filter((t2) => t2 < cutoff).sort((a, b) => a - b);
      for (const t2 of stale) { const b2 = s.bars.get(t2); s.bars.delete(t2); seal(s, b2); }
      // NO TRADE, NO BAR (SPEC 8.27U, upheld by the exchange). A bar is created by a row that TRADED.
      // Creating one on a mere price change was tried (SPEC 8.27X) and measured against the exchange's
      // own 5m bars: it changes exactly one session bar among the four cases the SPEC names - BEL
      // 2026-10-08, whose low it moves to 366.25, a single row at 14:27:41 with q=20 and no volume
      // advance that the exchange's bars do not contain. The SEALING above still runs whatever happens,
      // and that matters: an earlier version returned before this block and stopped sealing bars
      // whenever the feed went quiet, which invented 9 signals on 10-08 in the parity check.
      if (dv > 0) {
        const nb = blankBar(bs);
        nb.bq = s.bq; nb.sq = s.sq; nb.bid = s.bid; nb.ask = s.ask;
        // seed the bar with this row's price exactly as tapeflow.build_session does, and record
        // whether that price was a real CHANGE - `priceSet` false means the seed is a carried-over
        // price that the first genuine print is entitled to overwrite
        nb.o = nb.h = nb.l = nb.c = p;
        nb.priceSet = priceMoved;
        s.bars.set(bs, nb);
      }
    }
    // ---- NO TRADE, NOTHING MOVES (SPEC 8.27U, upheld by the exchange). A row where `v` did not
    // advance is a snapshot repeating the last traded price: no trade happened, so it must not move
    // prices, volume, levels OR the tick rule's carry state. 8.27X would have let a CHANGED price move
    // them; that is the loosening the exchange rejected (see the bar-creation note above), so the rows
    // are COUNTED instead - `stats.priceOnly` keeps the size of what 8.27X pointed at measurable.
    // tapeflow.build_session gates in this same place, and the two paths must agree (measured: 6
    // signals invented on 10-08 when the gate sat after the classification instead of before it).
    if (dv <= 0) {
      if (priceMoved) stats.priceOnly++;
      return;
    }

    // ---- aggressor classification (SPEC 8.27C)
    let side = null;
    if (s.bid && s.ask && s.bid < s.ask) {
      if (p >= s.ask) side = 1;
      else if (p <= s.bid) side = -1;
    }
    if (side === null) {
      if (s.lastP != null && p > s.lastP) side = 1;
      else if (s.lastP != null && p < s.lastP) side = -1;
      else side = s.lastSide;
      if (side === null) { s.unclassified++; stats.unclassified++; }
      else stats.tickRuleOnly++;
    }
    if (side !== null) s.lastSide = side;
    s.lastP = p;

    const b = s.bars.get(bs);
    // A traded row always writes the bar; whether it may OPEN the bar depends on its price having
    // CHANGED, so a traded row that merely repeats the carried price leaves `priceSet` false for the
    // first genuine print to re-seed. That is 8.27U's open rule, and it is the part worth keeping.
    if (!b.priceSet) {
      b.o = b.h = b.l = b.c = p;
      b.priceSet = priceMoved;
    } else {
      b.h = Math.max(b.h, p); b.l = Math.min(b.l, p); b.c = p;
    }
    b.vol += dv;
    b.qsum += q;
    b.trades++;
    if (side === 1) { b.buy += dv; s.cumBuy += dv; }
    else if (side === -1) { b.sell += dv; s.cumSell += dv; }
    else b.unc += dv;
    const lvl = Math.round(p / DTICK) * DTICK;
    const e = b.levels.get(lvl) || [0, 0, 0];
    if (side === 1) e[0] += dv; else if (side === -1) e[1] += dv; else e[2] += dv;
    b.levels.set(lvl, e);
    // The bar's book is refreshed on every traded tick, so it ends as the LAST book seen in the
    // bar (tapeflow.build_session lines 311-313 do exactly this, overwriting the values written
    // when the bar was created). Keeping only the creation snapshot changes the book-imbalance
    // filter and moves the signal set.
    b.bq = s.bq; b.sq = s.sq; b.bid = s.bid; b.ask = s.ask;
  }

  /** seal(s, bar) - a completed bar joins the session series, the profile, and drives management. */
  function seal(s, bar) {
    if (!bar || s.sealed.some((x) => x.t === bar.t)) return;
    // NOTE ON `usable`. The research path EXCLUDES a symbol for the whole session when it ends
    // with fewer than MIN_BARS_PER_SESSION traded bars (tapeflow's `usable` flag, decided after
    // the session closes). That cannot be decided bar-by-bar: a symbol sitting at 5 bars at
    // 10:15 may still finish the day with 60, and Python would have kept all of its early
    // signals. So every bar is evaluated here and the exclusion is applied at settlement
    // (closeSession -> isUsable), which is both live-honest and research-exact.
    // TWO PROFILE SNAPSHOTS, because the research path uses two. The LOCATION test compares the
    // signal bar's close against the POC built from bars[0..j-1] (flow_scalper line 341); the
    // TARGET uses the profile up to and including the signal bar (line 228). Using one snapshot
    // for both - which an earlier version did - moves the location filter and therefore the
    // signal set.
    const pvBefore = pocOf(s.profile);
    s.sealed.push(bar);
    for (const [price, e] of bar.levels) {
      s.profile.set(price, (s.profile.get(price) || 0) + e[0] + e[1] + e[2]);
    }
    stats.barsSealed++;
    manageAll(s);      // advance open signals FIRST, on the bar that just closed
    evaluate(s, bar, pvBefore);  // then let the closed bar arm new ones
  }

  /** running POC + value area from the sealed profile (causal: no future bar contributes). */
  function pocOf(profile) {
    if (!profile.size) return { poc: null, vah: null, val: null };
    const prices = [...profile.keys()].sort((a, b) => a - b);
    let poc = prices[0], best = -1;
    for (const p of prices) { const v = profile.get(p); if (v > best) { best = v; poc = p; } }
    const total0 = prices.reduce((t, p) => t + profile.get(p), 0);
    const need = total0 * 0.70;
    let i = prices.indexOf(poc), lo = i, hi = i, got = profile.get(poc);
    while (got < need && (lo > 0 || hi < prices.length - 1)) {
      const dn = lo > 0 ? profile.get(prices[lo - 1]) : -1;
      const up = hi < prices.length - 1 ? profile.get(prices[hi + 1]) : -1;
      if (up >= dn) { hi++; got += profile.get(prices[hi]); }
      else { lo--; got += profile.get(prices[lo]); }
    }
    return { poc, vah: prices[hi], val: prices[lo] };
  }

  /** evaluate(s, bar) - the pre-registered rules, applied when a bar closes. */
  function evaluate(s, bar, pvBefore) {
    // WARM-UP GATE. The research scan runs `for j_sig in range(ROLL, len(bars) - 1)`: a bar may
    // only signal once ROLL=20 prior bars exist to form its volume baseline, and the final bar
    // can never signal because entry needs a following bar. Without this gate the live module
    // evaluates the first 20 bars of every symbol with a truncated baseline and emits signals the
    // research run never had - which is exactly the superset that showed up in the parity check.
    if (s.sealed.length < ROLL + 1) return;
    const tot = bar.buy + bar.sell;
    if (tot <= 0) return;
    const hist = s.sealed.slice(-(ROLL + 1), -1).map(total);
    if (hist.length < ROLL) return;
    const base = median(hist);
    if (base <= 0) return;
    const fi = (bar.buy - bar.sell) / tot;
    const bi = (bar.bq && bar.sq) ? (bar.bq - bar.sq) / (bar.bq + bar.sq) : null;
    const pv = pocOf(s.profile);
    if (pv.poc == null) return;
    // `loc` POC = profile EXCLUDING this bar (flow_scalper's running_profile(bars, j_sig-1)).
    // If there is no prior volume the location test has nothing to compare against, and the
    // research run produces no signal either - so bail rather than inventing a POC.
    const loc = (pvBefore && pvBefore.poc != null) ? pvBefore : null;
    if (!loc) return;
    const prev = s.sealed.length >= 2 ? s.sealed[s.sealed.length - 2] : null;
    const pats = patterns(bar, prev);
    if (!pats.length) return;

    for (const vm of VOL_MULT) {
      if (total(bar) < vm * base) continue;
      for (const ft of FLOW_THETA) {
        for (const bt of BOOK_THETA) {
          if (fi <= -ft && bi !== null && bi <= -bt && bar.c >= loc.poc &&
              pats.some((p) => BEARISH.has(p))) {
            arm(s, bar, 'short', vm, ft, bt, fi, bi, loc, pv, pats, base);
          }
          if (fi >= ft && bi !== null && bi >= bt && bar.c <= loc.poc &&
              pats.some((p) => BULLISH.has(p))) {
            arm(s, bar, 'long', vm, ft, bt, fi, bi, loc, pv, pats, base);
          }
        }
      }
    }
  }

  /**
   * arm - one signal per (symbol, bar, side, cell). The research path found cells overlap heavily
   * (786 rows collapse to 94 unique signals), so the SAME dedupe is applied here.
   *
   * A signal is ARMED, not entered: its stop is the signal candle's far side, but the entry price
   * is the next bar's open and is not knowable yet. Entry, the stop/target sanity checks and the
   * skip reasons are all resolved on the next bar (see advance).
   */
  function arm(s, bar, side, vm, ft, bt, fi, bi, loc, pv, pats, base) {
    const key = bar.t + '|' + side + '|' + vm + '|' + ft + '|' + bt;
    if (s.armedKeys && s.armedKeys.has(key)) return;
    (s.armedKeys || (s.armedKeys = new Set())).add(key);
    const sig = {
      session: istDay(bar.t + IST_MS), sym: s.sym, armedAt: new Date().toISOString(),
      // DENSE INDEX, not a minute offset. The research path builds each symbol's series with
      // `for bs in sorted(bars)` - only minutes that actually traded - so its bar number counts
      // traded bars. A symbol whose first trade is 09:40 has j_sig=0 at 09:40, while a
      // minute-offset index would call that bar 5. Matching research means counting traded bars.
      barStart: bar.t, barMinute: bar.t, barIdx: s.sealed.length - 1,
      side, cell: vm + '|' + ft.toFixed(2) + '|' + bt.toFixed(2), cellVolMult: vm,
      cellFlowTheta: ft, cellBookTheta: bt,
      signalClose: bar.c, stop: side === 'short' ? bar.h : bar.l,
      loc: side === 'short' ? 'at-or-above-POC' : 'at-or-below-POC',
      locPoc: loc.poc, poc: pv.poc, vah: pv.vah, val: pv.val,
      barVol: total(bar), baseVol: base,
      fi, bi, patterns: pats,
      // THE TWO PATTERN SETS ARE NOT THE SAME SET, and only one of them matches research.
      //
      // `patterns` is everything the detector found on the bar, including the NEUTRAL family
      // (doji, inside_bar, outside_bar). `patternsArming` is the subset that can justify THIS
      // direction - exactly what flow_scalper records (`meta['pats'] = sorted(pats & BULLISH)` for
      // a long, `& BEARISH` for a short). Arming is unaffected by the difference (a neutral pattern
      // is in neither BULLISH nor BEARISH, so it could never have armed the trade), which is why
      // signals and P&L agreed to the digit while the per-pattern table did not: research's table
      // contains only directional patterns, and reporting the raw set instead produced a table
      // with `doji` / `inside_bar` / `outside_bar` rows that research never had, double-counting
      // each trade across context patterns as well as signal ones.
      patternsArming: pats.filter((p) => (side === 'short' ? BEARISH.has(p) : BULLISH.has(p))),
      profileLevels: s.profile.size,
      cumBuy: s.cumBuy, cumSell: s.cumSell, status: 'armed',
    };
    stats.armedCount++;
    sig.usable = null;        // decided at settlement (see isUsable)
    armed.push(sig);
    s.live.push(sig);
    s.session.push(sig);
    say('[f1/live] ARM ' + sig.session + ' ' + sig.sym + ' ' + side.toUpperCase() +
        ' sigClose=' + bar.c + ' stop=' + sig.stop + ' locPoc=' + loc.poc +
        ' tgtPoc=' + pv.poc + ' (' + pats.join('+') + ') fi=' + fi.toFixed(2) +
        ' cell=' + sig.cell);
  }

  /** advance(sig, b, halo) - resolve the entry, then stop/target/flow/close on this bar. */
  function advance(s, sig, b) {
    // 1. entry: first bar after the arm bar, at its open.
    if (sig.entry == null) {
      const e = b.o;
      if (!(e > 0)) { finish(s, sig, 'skip:bad-open'); return; }
      sig.entry = e;
      sig.entryBar = b.t;
      sig.entryAt = new Date().toISOString();
      sig.entryHalo = b.buy + b.sell > 0 ? 0 : 1;
      sig.riskBps = sig.side === 'short' ? (sig.stop - e) / e * 1e4 : (e - sig.stop) / e * 1e4;
      if (sig.riskBps < MIN_STOP_BPS) { finish(s, sig, 'skip:stop-too-tight'); return; }
      if (sig.riskBps / 1e4 > MAX_STOP_PCT) { finish(s, sig, 'skip:stop-too-wide'); return; }
      const levels = [...s.profile.keys()];
      if (sig.side === 'short') {
        const below = levels.filter((p) => p < e).sort((a, b2) => a - b2);
        sig.target = sig.poc < e ? sig.poc : (below.length ? below[below.length - 1] : null);
      } else {
        const above = levels.filter((p) => p > e).sort((a, b2) => a - b2);
        sig.target = sig.poc > e ? sig.poc : (above.length ? above[0] : null);
      }
      if (sig.target == null) { finish(s, sig, 'skip:no-target'); return; }
      sig.targetBps = Math.abs(sig.target - e) / e * 1e4;
      if (sig.targetBps < MIN_STOP_BPS) { finish(s, sig, 'skip:target-too-close'); return; }
      sig.tollMeasured = measuredToll(s);
      sig.status = 'pending';
      stats.confirmed++;
      say('[f1/live] ENTER ' + sig.sym + ' ' + sig.side.toUpperCase() + ' @' + e +
          ' stop=' + sig.stop + ' target=' + sig.target +
          ' risk=' + sig.riskBps.toFixed(2) + 'bps tgt=' + sig.targetBps.toFixed(2) + 'bps' +
          ' toll@measured=' + (sig.tollMeasured == null ? 'n/a' : sig.tollMeasured.toFixed(2)));
    } else if (sig.pendingExit) {
      // an opposite big-flow bar was seen on the PREVIOUS bar -> out at THIS bar's open
      exit(s, sig, b.o, 'opposite-flow');
      return;
    }

    // 2. excursions
    const riskDir = sig.side === 'short' ? -1 : 1;
    sig.fav = ((riskDir * (sig.side === 'short' ? b.l - sig.entry : b.h - sig.entry)) / sig.entry) * 1e4;
    sig.adv = ((-riskDir * (sig.side === 'short' ? b.h - sig.entry : b.l - sig.entry)) / sig.entry) * 1e4;
    // FLOORED AT ZERO, exactly as flow_scalper.simulate initialises `mfe = mae = 0.0`.
    //
    // `fav`/`adv` are SIGNED readings: on a bar that only moved the favourable way, `adv` is
    // negative. Python's `max(0.0, adv)` discards those; seeding with -Infinity kept them, so a
    // trade that never traded below its entry reported a NEGATIVE adverse excursion (ASIANPAINT
    // 10-07 bar 71: Python mae 0.0000, mine -17.7590). It is invisible on `stop` and `target`
    // trades - those necessarily touched an extreme, so the running max dominates either way -
    // and shows up only on monotone winners that ride to the session close. Excursions feed the
    // 8.27J geometry report, not the signal or the exit, which is why signal parity passed while
    // this was wrong.
    sig.mfe = Math.max(sig.mfe == null ? 0 : sig.mfe, sig.fav);
    sig.mae = Math.max(sig.mae == null ? 0 : sig.mae, sig.adv);

    // 3. stop BEFORE target on the same bar (conservative), per 8.27H
    if (sig.side === 'short') {
      if (b.h >= sig.stop) return exit(s, sig, sig.stop, 'stop');
      if (b.l <= sig.target) return exit(s, sig, sig.target, 'target');
    } else {
      if (b.l <= sig.stop) return exit(s, sig, sig.stop, 'stop');
      if (b.h >= sig.target) return exit(s, sig, sig.target, 'target');
    }

    // 4. opposite big flow -> flag; the exit prints at the NEXT bar's open.
    //
    // TWO THINGS THE RESEARCH PATH REQUIRES HERE, both of which an earlier version of this file
    // got wrong and neither of which affects SIGNAL parity (so the signal diff stayed at 100%
    // while the P&L did not):
    //   (a) the test is `fi * want >= ft`, scaled by the CELL'S OWN flow threshold -- not
    //       `fi > 0`. Using the looser test fired an early exit on 55 of 323 trades that the
    //       research run held all the way to their stop or target.
    //   (b) it is never evaluated on the entry bar (`k > j` in flow_scalper.simulate).
    if (b.t > sig.entryBar) {
      const hist = s.sealed.slice(-(ROLL + 1), -1).map(total);
      const base = median(hist);
      const tt = b.buy + b.sell;
      if (base > 0 && tt > 0 && total(b) >= sig.cellVolMult * base) {
        const fi = (b.buy - b.sell) / tt;
        const want = sig.side === 'short' ? 1 : -1;
        if (fi * want >= sig.cellFlowTheta) {
          // The exit normally prints at the NEXT bar's open (`bars[k+1]['o']`). When there is no
          // next bar the research path exits at THIS bar's close and labels it
          // `opposite-flow-close` (flow_scalper.simulate, the `k + 1 < len(bars)` else-branch).
          // Which of the two applies CANNOT be known while this is still the newest bar - live
          // only learns a bar was last when the session ends - so the flag is raised here and
          // closeSession() resolves it. Gating on wall-clock instead (>= SESS_CLOSE_MIN - BAR_MIN)
          // was WRONG: research's `k == len(bars) - 1` means "the last bar THIS SYMBOL traded",
          // not "a bar near 15:25". A symbol whose tape stops at 15:20 has that bar as its final
          // index too. DRREDDY 2026-10-06 bar 71 is exactly that case, and the wall-clock gate
          // mislabelled it session-close (same price, wrong reason - the parity harness checks
          // the reason as well as the money).
          sig.pendingExit = true;
          return;
        }
      }
    }

    // 5. session close
    if (istMinute(b.t) >= SESS_CLOSE_MIN - BAR_MIN) return exit(s, sig, b.c, 'session-close');
  }

  function manageAll(s) {
    if (!s.live.length) return;
    const b = s.sealed[s.sealed.length - 1];
    if (!b) return;
    for (const sig of [...s.live]) {
      if (b.t <= sig.barStart) continue;    // never manage a signal on its own arm bar
      advance(s, sig, b);
    }
  }

  function finish(s, sig, why) {
    sig.status = 'skipped';
    sig.why = why;
    sig.closedAt = new Date().toISOString();
    stats.skipped++;
    s.live = s.live.filter((x) => x !== sig);
    journal(sig);
    say('[f1/live] SKIP  ' + sig.sym + ' ' + sig.side + ' ' + why);
  }

  /** exit - score the signal, journal it, and drop it from the live list. */
  function exit(s, sig, px, why) {
    sig.status = 'closed';
    sig.why = why;
    sig.exit = px;
    sig.closedAt = new Date().toISOString();
    sig.grossBps = sig.side === 'short'
      ? (sig.entry - px) / sig.entry * 1e4
      : (px - sig.entry) / sig.entry * 1e4;
    sig.tollFrozen = frozenToll;
    sig.netMeasured = sig.tollMeasured == null ? null : sig.grossBps - sig.tollMeasured;
    sig.netFrozen = sig.grossBps - frozenToll;
    s.live = s.live.filter((x) => x !== sig);
    journal(sig);
    say('[f1/live] EXIT  ' + sig.sym + ' ' + why + ' @' + px +
        ' gross=' + sig.grossBps.toFixed(2) + 'bps net@measured=' +
        (sig.netMeasured == null ? 'n/a' : sig.netMeasured.toFixed(2)) +
        ' net@frozen=' + sig.netFrozen.toFixed(2));
    return sig;
  }

  /** measured toll = median relative spread for this symbol + impact + statutory (8.27I). */
  function measuredToll(s) {
    if (!s.spreads) s.spreads = [];
    for (const b of s.sealed.slice(-20)) {
      if (b.bid && b.ask && b.ask > b.bid) {
        s.spreads.push((b.ask - b.bid) / ((b.ask + b.bid) / 2) * 1e4);
      }
    }
    if (!s.spreads.length) return null;
    return median(s.spreads) + IMPACT_BPS + STATUTORY_BPS;
  }

  function journal(sig) {
    try {
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.appendFileSync(journalPath, JSON.stringify(sig) + '\n');
    } catch (e) {
      say('[f1/live] journal write failed: ' + ((e && e.message) || e));
    }
  }

  /**
   * closeSession() - flush a partially-built bar and settle everything still open, so a session
   * that ends mid-bar (or a process that is stopped) still produces complete, scored signals.
   */
  /** isUsable(s) - the research `usable` rule: at least MIN_BARS_PER_SESSION traded bars and a
   * real traded volume. A symbol that fails is excluded for the session, so its signals are
   * flagged rather than silently traded (this is the 10-06 partial-capture case). */
  function isUsable(s) { return s.sealed.length >= MIN_BARS_PER_SESSION && (s.cumBuy + s.cumSell) > 0; }

  function closeSession() {
    for (const s of st.values()) {
      const stale = [...s.bars.keys()].sort((a, b) => a - b);
      for (const t2 of stale) { const b2 = s.bars.get(t2); s.bars.delete(t2); seal(s, b2); }
      const b = s.sealed[s.sealed.length - 1];
      if (!b) continue;
      const usable = isUsable(s);
      for (const sig of [...s.live]) {
        if (sig.entry == null) { finish(s, sig, 'skip:never-entered'); continue; }
        // An unresolved `pendingExit` means opposite big flow printed on the FINAL bar. That is
        // research's `k == len(bars) - 1` case: flat at that bar's close, labelled
        // `opposite-flow-close`. Otherwise the flat-by-close rule wins and it is `session-close`.
        // Both exit at the same price; only the reason differs.
        exit(s, sig, b.c, sig.pendingExit ? 'opposite-flow-close' : 'session-close');
      }
      for (const sig of s.session) sig.usable = usable;
      if (!usable) { stats.thinSymbols++; say('[f1/live] ' + s.sym + ': only ' + s.sealed.length +
        ' traded bars - not usable this session (' + s.session.length + ' signals excluded)'); }
    }
  }

  /** performance() - live scoreboard, per pattern and per side, with the same toll. */
  function bucket(list) {
    const n = list.length;
    if (!n) return { n: 0, winGrossPct: null, gross: null, netMeasured: null, netFrozen: null };
    const nets = list.map((x) => x.netMeasured).filter((x) => x != null);
    const gross = list.map((x) => x.grossBps).filter((x) => x != null);
    return {
      n,
      winGrossPct: +(100 * gross.filter((x) => x > 0).length / n).toFixed(1),
      gross: +(gross.reduce((a, b) => a + b, 0) / n).toFixed(2),
      netMeasured: nets.length ? +(nets.reduce((a, b) => a + b, 0) / nets.length).toFixed(2) : null,
      netFrozen: +(list.map((x) => x.netFrozen).filter((x) => x != null)
        .reduce((a, b) => a + b, 0) / n).toFixed(2),
      stops: list.filter((x) => x.why === 'stop').length,
      targets: list.filter((x) => x.why === 'target').length,
      oppositeFlow: list.filter((x) => x.why === 'opposite-flow' || x.why === 'opposite-flow-close').length,
    };
  }

  function performance() {
    const closed = armed.filter((x) => x.status === 'closed');
    const byPattern = {};
    // `patternsArming`, NOT `patterns` - see the note where the signal is built. This is the
    // research convention, so the two per-pattern tables describe the same thing.
    for (const sig of closed) for (const p of sig.patternsArming) (byPattern[p] || (byPattern[p] = [])).push(sig);
    const byCell = {};
    for (const sig of closed) (byCell[sig.cell] || (byCell[sig.cell] = [])).push(sig);
    return {
      session: istDay(Date.now()),
      armed: armed.length,
      confirmed: armed.filter((x) => x.status !== 'armed').length,
      closed: closed.length,
      live: armed.filter((x) => x.status === 'pending').length,
      skipped: armed.filter((x) => x.status === 'skipped').length,
      overall: bucket(closed),
      bySide: { long: bucket(closed.filter((x) => x.side === 'long')),
                short: bucket(closed.filter((x) => x.side === 'short')) },
      byPattern: Object.fromEntries(Object.entries(byPattern).map(([k, v]) => [k, bucket(v)])),
      byCell: Object.fromEntries(Object.entries(byCell).map(([k, v]) => [k, bucket(v)])),
      feed: feedQuality(),
    };
  }

  function feedQuality() {
    return {
      ticks: stats.ticks,
      barsSealed: stats.barsSealed,
      symbolsSeen: st.size,
      symbolsWanted: symbols.size || null,
      armed: stats.armedCount,
      confirmedEntries: stats.confirmed,
      skippedSignals: stats.skipped,
      unclassifiedTicks: stats.unclassified,
      tickRuleOnlyTicks: stats.tickRuleOnly,
      tickErrors: stats.errors,
      firstTickError: stats.firstError,
      crossedBookPct: stats.booksSeen ? +(100 * stats.crossed / stats.booksSeen).toFixed(1) : null,
      booksSeen: stats.booksSeen,
      lastTickAt: stats.lastTickAt,
      journal: journalPath,
    };
  }

  return {
    onTick, safeTick, closeSession, performance, feedQuality,
    signals: () => armed,
    liveSignals: () => [...st.values()].flatMap((s) => s.live),
    state: st, journalPath, stats,
  };
}

module.exports = { createF1Live, patterns, barStart, VOL_MULT, FLOW_THETA, BOOK_THETA,
                   IMPACT_BPS, STATUTORY_BPS };
