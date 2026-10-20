/**
 * orderflow/armCapture.js — wires raw tick capture to the live Angel socket.
 *
 * Kept out of Server.js so the wiring is testable: everything here is a pure
 * decision (symbol → token, which correlation id to subscribe, what to log) plus
 * two calls into objects the caller injects. A test hands it a fake broker and a
 * fake instrument master and asserts exactly what it would do to the real one.
 *
 * THREE THINGS THAT ARE EASY TO GET WRONG AND ARE THE REASON THIS EXISTS:
 *
 *  1. SUBSCRIPTION MODE. Angel only parses lastTradedQuantity, volumeTradedToday,
 *     totalBuyQuantity and totalSellQuantity when mode is QUOTE (2) or
 *     SNAP_QUOTE (3). The live server's index feed subscribes in LTP mode (1), so
 *     recording from THAT subscription would store q=0 on every tick and every
 *     delta computed from it would be a division by zero dressed as a number.
 *     Capture therefore subscribes its own token list in SNAP_QUOTE by default
 *     (best-5 bid/ask prices recorded forward; GB_CAPTURE_MODE=quote forces the
 *     legacy QUOTE-only mode). The index feed stays untouched either way.
 *
 *  2. CORRELATION ID. A mode is bound to a correlation id, not to the socket. If
 *     capture re-uses the index feed's id it would silently switch the existing
 *     subscribers to QUOTE, or itself to LTP. It gets its own id: 'gb_capture'.
 *
 *  3. SYMBOL ON THE STORED LINE. The tape is joined to events by SYMBOL, not by
 *     token (backtest/eventMicro.js matches `r.s` against the corpus). If the
 *     token→symbol index is not seeded first, the line stores a bare number and
 *     the event can never find its tape. So every token is REGISTERED before the
 *     first tick arrives, not resolved lazily on tick one.
 *
 * Everything else — where the file goes, how many rows per symbol are kept, the
 * 1-second flush — belongs to orderflow/tickCapture.js.
 *
 * 4. ONE PARSER, TWO CONSUMERS. `arm` takes an optional `onRow` observer. It is
 *    handed the EXACT row object tickCapture.record() just stored, not the raw
 *    Angel payload, so a live strategy (orderflow/f1Live.js) computes from
 *    byte-identical input to the research tapes. If the live consumer re-parsed
 *    the broker payload itself the two could drift, and every researched number
 *    would describe a different instrument than the one being traded. The
 *    observer runs AFTER the store, so a throwing consumer cannot lose tape.
 */
'use strict';

const MODE = require('../../angelone/marketFeed').MODE;

/** The correlation id capture subscribes on. Distinct from the index feed's 'sub1'. */
const CAPTURE_CORRELATION = 'gb_capture';

/**
 * arm({ angel, capture, instrument, symbols, log, onRow }) →
 *   { tokens, skipped, onTick, stop() }
 *
 * `onRow(row)` is optional and read-only: it receives each stored row for a live
 * strategy to consume. It is never awaited and never allowed to interrupt the store.
 *
 * Throws when not ONE symbol resolves — a capture that silently records nothing
 * for a session is worse than one that refuses to start, because it burns a day
 * of tape that cannot be regenerated.
 */
/**
 * HOW WIDE THE CAPTURE IS, AND WHY IT IS A FUNCTION HERE RATHER THAN AN EXPRESSION IN Server.js.
 *
 * The capture armed `board.rows` — the rows the board DISPLAYS, which on 2026-10-18 was THREE
 * names — plus the f1 universe file: 136 symbols in total, while its own comment claimed the scope
 * was "the board's own OK universe" and board.json reported `notBlocked: 2017`. That difference is
 * not cosmetic for a rare rule: GB01's measured base rate is 1 call per 1,022 symbol-days, so at
 * 136 names its tier-2 row is empty for about a week at a time by arithmetic, and the same silence
 * would look identical if the wiring were broken.
 *
 * SOURCE ORDER, and why each source is here:
 *   1. `board.universe.okSymbols`  — the LIST the board publishes (scripts/buildBoard.js). A
 *      counter with no list behind it cannot be subscribed to, which is exactly what went wrong.
 *   2. `board.rows[!blocked]`      — the OLD shape, still honoured so a board.json from before the
 *      list existed arms something rather than silently arming nothing.
 *   3. `extras`                    — the high-turnover names from backtest/f1/universe.json.
 * Anything not in one of these is a name no board-approved rule is looking at.
 *
 * `limit` is an UPPER BOUND on the subscription count (broker and tape have a cost); 0 means no
 * cap. The counts returned are what the caller logs, so "armed 500 of 1,006 available" is a line in
 * the startup log instead of something to infer.
 */
function chooseCaptureSymbols({ board, extras, limit, defaultLimit = DEFAULT_CAPTURE_LIMIT } = {}) {
  const clean = (s) => String(s == null ? '' : s).replace(/-EQ$/i, '').trim().toUpperCase();
  const b = board || {};

  const okList = (b.universe && Array.isArray(b.universe.okSymbols)) ? b.universe.okSymbols.map(clean).filter(Boolean) : [];
  const rowList = Array.isArray(b.rows)
    ? b.rows.filter((r) => r && r.symbol && !r.blocked).map((r) => clean(r.symbol)).filter(Boolean)
    : [];
  const extraList = (extras || []).map(clean).filter(Boolean);

  const seen = new Set();
  const symbols = [];
  const add = (arr) => { for (const s of arr) if (!seen.has(s)) { seen.add(s); symbols.push(s); } };
  if (okList.length) { add(okList); add(extraList); } else { add(rowList); add(extraList); }

  // AN EXPLICIT 0 IS NOT THE SAME AS "NOT GIVEN". `GB_TICK_CAPTURE_LIMIT=0` means the operator asked
  // for the whole list and gets it; omitting the argument lands on the module default instead. Read
  // as `Number(x) || default`, those two would be the same input — and the difference is between
  // subscribing 500 names and subscribing every name the board approves.
  const given = limit !== undefined && limit !== null && limit !== '';
  const cap = given ? Math.max(0, Math.trunc(Number(limit)) || 0)
    : (Number(defaultLimit) > 0 ? Math.trunc(Number(defaultLimit)) : 0);
  const armed = cap ? symbols.slice(0, cap) : symbols;

  return {
    symbols: armed,
    source: okList.length ? 'board.universe.okSymbols' : (rowList.length ? 'board.rows (legacy shape)' : 'extras only'),
    counts: {
      fromOkList: okList.length,
      fromRows: rowList.length,
      fromExtras: extraList.length,
      available: symbols.length,
      armed: armed.length,
      cap: cap || null,
      droppedByCap: symbols.length - armed.length,
    },
  };
}

/** Default subscription ceiling when GB_TICK_CAPTURE_LIMIT is unset. */
const DEFAULT_CAPTURE_LIMIT = 500;

function arm({ angel, capture, instrument, symbols, log, onRow }) {
  const observe = typeof onRow === 'function' ? onRow : null;
  const say = log || ((m) => console.log(m));
  const list = symbols || [];

  const resolved = [];
  const skipped = [];
  for (const raw of list) {
    const sym = String(raw).replace(/-EQ$/i, '').toUpperCase();
    let rec = null;
    try { rec = instrument.findEquity(sym, 'NSE'); } catch (_) { rec = null; }
    if (!rec || rec.token == null) { skipped.push(sym); continue; }
    const token = String(rec.token);
    capture.register(token, sym);
    resolved.push({ token, symbol: sym });
  }

  const tokens = [...new Set(resolved.map((r) => r.token))];
  if (!tokens.length) {
    throw new Error('tick capture: 0 of ' + list.length + ' symbols resolved to an Angel token — not subscribing');
  }

  // token → symbol for the tick handler. Registered above as well; kept here so
  // the handler does not depend on capture's internal index.
  const tokenToSymbol = new Map(resolved.map((r) => [r.token, r.symbol]));

  const { createDepthRecorder } = require('./depth5_recorder');
  const depthRecorder = createDepthRecorder();

  capture.start();
  // BEST-5 QUOTE RECORDING (forward capture, framework instruction section 7):
  // SNAP_QUOTE adds best-bid/ask PRICES (marketFeed._parseBest5) on top of every
  // QUOTE field, on capture's own correlation id — the index feed is untouched.
  // GB_CAPTURE_MODE=quote forces the old QUOTE-only behaviour if the depth
  // subscription ever misbehaves on the wire. OF-1 trading logic does NOT change:
  // research/pipeline/of1_record.py strips bid/ask before the detector sees rows,
  // so OF-1 computes the same proxy delta on historical and forward tapes.
  const mode = String(process.env.GB_CAPTURE_MODE || 'snap').toLowerCase() === 'quote'
    ? MODE.QUOTE : MODE.SNAP_QUOTE;
  angel.subscribeLiveAngel(tokens, { mode, correlationId: CAPTURE_CORRELATION });
  say('[orderflow/capture] subscription mode: ' +
      (mode === MODE.SNAP_QUOTE
        ? 'SNAP_QUOTE (best-5 bid/ask prices recorded forward)'
        : 'QUOTE (best-5 OFF, legacy)') + ' · correlation ' + CAPTURE_CORRELATION);

  const onTick = (tick) => {
    if (!tick || tick.token == null) return;
    const sym = tokenToSymbol.get(String(tick.token));
    const row = capture.record(tick, sym);
    try { depthRecorder.record(tick, sym); } catch (_) {}
    // Live consumer LAST: the tape is already durably queued, so a strategy bug can
    // never cost a session of raw tape (which cannot be regenerated).
    if (observe && row) {
      try { observe(row); } catch (e) {
        say('[orderflow/capture] onRow observer threw (tape unaffected): ' + ((e && e.message) || e));
      }
    }
  };
  angel.on('tick', onTick);

  say('[orderflow/capture] armed on ' + tokens.length + ' tokens' +
    (skipped.length ? ' (' + skipped.length + ' symbol(s) had no token: ' + skipped.slice(0, 5).join(',') + (skipped.length > 5 ? ',…' : '') + ')' : '') +
    ' · mode QUOTE · correlation ' + CAPTURE_CORRELATION);

  return {
    tokens,
    skipped,
    onTick,
    stop() { angel.off('tick', onTick); capture.stop(); },
  };
}

module.exports = { arm, chooseCaptureSymbols, DEFAULT_CAPTURE_LIMIT, CAPTURE_CORRELATION };
