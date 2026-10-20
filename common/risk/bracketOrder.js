/**
 * common/risk/bracketOrder.js — PRESS BUY: IT BUYS, AND THE STOP AND TARGET GO WITH IT.
 *
 * THE PROBLEM THIS SOLVES. A call on the board carries an entry, a stop and a target, and placing
 * the entry is only the first third of the trade. If the stop and the target are left to be typed
 * later, the position runs unprotected for the seconds (or the hour) until someone types them —
 * and if nobody does, it runs unprotected until the session close. So one press does all three:
 * the entry is sent, and the moment it fills, a broker-side rule carries the stop and the target,
 * whichever fires first cancels the other.
 *
 * SIZE FROM THE MONEY, NOT FROM A GUESS. Before anything is sent, the live RMS balance is read
 * from the broker and handed to `sizePosition` (see common/risk/positionSizing.js), which answers
 * "how many shares can this account actually pay for, within its risk budget". Under the ₹3,000
 * floor the whole balance is the position; above it the per-trade budget binds. The quantity the
 * caller typed is NOT trusted — it is a ceiling at most, because a quantity that costs more than
 * the account holds is not an order, it is a rejection with a delay.
 *
 * WHY A GTT OCO AND NOT TWO ORDERS. A target sell and a stoploss sell for the same shares are two
 * sells for one position: if both were left resting, whichever fired first would leave the other
 * selling stock the account no longer owns. Angel One's OCO rule holds both legs and cancels the
 * sibling when one triggers, so the bracket lives at the broker and survives this process dying.
 *
 * EVERY STEP IS INJECTED. The broker client, the GTT client, the clock and the funds reader are
 * all parameters, so the whole sequence — read funds, size, entry, protection, failure handling —
 * is pinned by a test with a fake broker and no money, no network and no market.
 */
'use strict';

const { sizePosition } = require('./positionSizing');
const { TransactionType, OrderType, ProductType, Exchange } = require('../trading/OrderTypes');

/** How long to wait for the entry to fill before placing protection without a fill price. */
const DEFAULT_FILL_WAIT_MS = 12000;
const DEFAULT_FILL_POLL_MS = 800;
// THE PER-TRADE RISK BUDGET WHEN THE CALL DOES NOT NAME ONE. 1% of the balance, which is the
// figure the sizing tests already treat as the house rule. It only ever applies ABOVE the ₹3,000
// all-in floor — under it the whole balance is the position and no budget is consulted.
const DEFAULT_RISK_PCT = 1;

const round2 = (n) => +Number(n).toFixed(2);

/** A long's stop sits BELOW entry and its target above; a short's is the mirror. */
function geometry(side, entry, stop, target) {
  const isShort = side === TransactionType.SELL;
  const stopOk = Number.isFinite(stop) && stop > 0 && (isShort ? stop > entry : stop < entry);
  const targetOk = Number.isFinite(target) && target > 0 && (isShort ? target < entry : target > entry);
  const problems = [];
  if (!stopOk) problems.push(isShort
    ? `a short's stop must be ABOVE its entry — got stop ₹${stop} on entry ₹${entry}`
    : `a long's stop must be BELOW its entry — got stop ₹${stop} on entry ₹${entry}`);
  if (!targetOk) problems.push(isShort
    ? `a short's target must be BELOW its entry — got target ₹${target} on entry ₹${entry}`
    : `a long's target must be ABOVE its entry — got target ₹${target} on entry ₹${entry}`);
  if (stopOk && targetOk && isShort && stop <= target) {
    problems.push('a short needs its stop above its target — they are crossed');
  }
  if (stopOk && targetOk && !isShort && stop >= target) {
    problems.push('a long needs its stop below its target — they are crossed');
  }
  return { ok: problems.length === 0, problems, isShort };
}

/**
 * The GTT OCO rule for a FILLED position: sell a long, buy a short back, whichever leg triggers
 * cancels the other. Pure — it only arranges numbers the caller has already proven, so the test
 * can read the exact broker payload without a broker.
 */
function buildProtectionRule({ side, tradingsymbol, symboltoken, exchange, quantity, entry, stop, target, productType, timeperiod = 30 }) {
  const isShort = side === TransactionType.SELL;
  return {
    tradingsymbol,
    symboltoken,
    exchange: exchange || Exchange.NSE,
    // A long is protected by selling out; a short by buying back.
    transactiontype: isShort ? TransactionType.BUY : TransactionType.SELL,
    producttype: productType || ProductType.DELIVERY,
    quantity,
    // The rule rests until a leg's trigger is touched; the entry price is the reference only.
    price: round2(entry),
    triggerprice: round2(isShort ? stop : stop),
    timeperiod,
    gttType: 'OCO',
    stoploss: { triggerprice: round2(stop), price: round2(stop), quantity },
    target: { triggerprice: round2(target), price: round2(target), quantity },
  };
}

/** Read the cash actually available to trade, from whichever shape the broker answered in. */
function cashFrom(funds) {
  if (!funds || typeof funds !== 'object') return null;
  const raw = funds.availablecash ?? funds.availableCash ?? funds.net ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Wait for an order to fill by polling the order book. Returns the fill, or null on timeout. */
async function awaitFill({ getOrderBook, orderId, waitMs = DEFAULT_FILL_WAIT_MS, pollMs = DEFAULT_FILL_POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const deadline = Date.now() + waitMs;
  let last = null;
  for (;;) {
    const book = await getOrderBook();
    const row = (Array.isArray(book) ? book : []).find((o) => String(o.orderid || o.orderId) === String(orderId));
    if (row) {
      last = row;
      const status = String(row.orderstatus || row.status || '').toLowerCase();
      const filled = Number(row.fillqty ?? row.filledquantity ?? 0);
      if (status === 'complete' || status === 'filled' || filled > 0) {
        return {
          filled: true,
          status,
          quantity: filled > 0 ? filled : Number(row.quantity || 0),
          averagePrice: Number(row.averageprice || row.avgprice || 0),
        };
      }
      if (status === 'rejected' || status === 'cancelled' || status === 'canceled' || status === 'error') {
        return { filled: false, status, reason: row.text || row.message || row.rejectionreason || 'rejected by the broker' };
      }
    }
    if (Date.now() >= deadline) {
      return { filled: false, status: last ? String(last.orderstatus || last.status || 'open') : 'not seen in the book', timedOut: true };
    }
    await sleep(pollMs);
  }
}

/**
 * Run the whole press. `deps` are the injected edges:
 *   placeOrder(order)          — send an order, resolves { orderId }
 *   getOrderBook()             — the broker's order book, for the fill wait
 *   gtt.createRule(rule)       — create the OCO protection rule, resolves { ruleId }
 *   getFunds()                 — the live RMS balance (optional; capital may be supplied)
 * `req` is the trade: { side, entry, stop, target, symbol, symboltoken, exchange, productType,
 * quantity (a ceiling, not a promise), riskPct / riskInr, capital (overrides getFunds), nowMs }.
 *
 * Returns { ok, stage, sizing, entry, protection, problems } — `stage` names the step that failed,
 * so "rejected" means the broker refused the entry and "protection" means the entry is LIVE but
 * the stop and target are not, which is the one state an operator must never have to guess about.
 */
async function executeBracket(deps, req) {
  const d = deps || {};
  const r = req || {};
  const stage = (name, extra) => Object.assign({ ok: false, stage: name }, extra || {});
  if (!d.placeOrder) return stage('deps', { problems: ['placeOrder was not supplied'] });
  if (!d.gtt || typeof d.gtt.createRule !== 'function') return stage('deps', { problems: ['gtt.createRule was not supplied'] });

  const side = String(r.side || TransactionType.BUY).toUpperCase();
  const entry = Number(r.entry);
  const stop = Number(r.stop);
  const target = Number(r.target);
  const productType = r.productType || ProductType.DELIVERY;

  // GEOMETRY FIRST. A stop on the wrong side of the entry is not a stop, and sending it would
  // fire the moment the order rests. Refuse before a rupee moves.
  const geo = geometry(side, entry, stop, target);
  if (!geo.ok) return stage('geometry', { problems: geo.problems });

  // THE MONEY. Live RMS if the caller did not supply a capital figure; if neither is available
  // the trade is sized from the caller's ceiling alone and said so, rather than sized to zero.
  //
  // A BALANCE THAT WAS READ AND IS NOT POSITIVE IS NOT AN UNREADABLE BALANCE, and the two must not
  // produce the same sentence. An account at ₹-115 says "there is nothing to spend"; an unreadable
  // RMS says "we do not know". Reporting the first as the second hides the only number the operator
  // can act on, so the figure is kept here and named below rather than being folded into `null`.
  let capital = Number(r.capital);
  let capitalSource = Number.isFinite(capital) && capital > 0 ? 'supplied' : null;
  let fundsError = null;
  if (!capitalSource && typeof d.getFunds === 'function') {
    try {
      const cash = cashFrom(await d.getFunds());
      if (cash == null) fundsError = 'the balance was read but contained no cash field';
      else { capital = cash; capitalSource = 'rms'; }
    } catch (e) {
      fundsError = (e && e.message) || String(e);
    }
  }

  // Cash in hand, not "could not ask": sizing from zero can only ever be zero, and sending an
  // entry the broker's own RMS will reject buys nothing but a delay and a rejection.
  //
  // A BUY ONLY. A SELL is how you get OUT, and getting out must not require cash — closing a
  // position frees margin rather than consuming it, so an empty balance is a reason to refuse an
  // entry and never a reason to lock an operator into a position they are trying to leave.
  if (capitalSource === 'rms' && Number.isFinite(capital) && capital <= 0 && side === TransactionType.BUY) {
    return stage('sizing', {
      problems: ['the account has no cash to size from: Angel One reports available cash of ₹' +
        round2(capital) + ' — nothing can be bought until it is funded or margin is freed'],
      capital, capitalSource, cashAvailable: round2(capital), sizing: null,
    });
  }

  const sizing = Number.isFinite(capital) && capital > 0
    ? sizePosition({
      entry, stop, side, capital,
      // An explicit rupee figure beats a percent; with neither, the house 1% applies. Above the
      // all-in floor sizePosition demands a budget, and refusing a press for want of one when the
      // rule has a default would be a bad reason to send nothing.
      riskInr: r.riskInr,
      riskPct: Number.isFinite(Number(r.riskInr)) && Number(r.riskInr) > 0 ? undefined
        : (Number.isFinite(Number(r.riskPct)) && Number(r.riskPct) > 0 ? Number(r.riskPct) : DEFAULT_RISK_PCT),
      lotSize: r.lotSize, maxNotionalPct: r.maxNotionalPct, allInBelowInr: r.allInBelowInr,
    })
    : null;

  // The caller's quantity is a CEILING: the size is the smaller of what the money allows and what
  // was asked for. If nothing could be sized, the ask stands, and the sizing says why.
  const requested = Number.isInteger(r.quantity) && r.quantity > 0 ? r.quantity : null;
  let quantity;
  if (sizing && sizing.ok) {
    quantity = requested != null ? Math.min(requested, sizing.qty) : sizing.qty;
  } else if (requested != null) {
    quantity = requested;
  } else {
    return stage('sizing', {
      problems: [sizing ? sizing.reason : (fundsError
        ? 'the balance could not be read (' + fundsError + ') and no quantity was supplied, so there is nothing to size from'
        : 'no quantity was supplied and no capital was available to size one')],
      capital: Number.isFinite(capital) ? round2(capital) : null,
      capitalSource,
      sizing: sizing || null,
    });
  }
  if (!(quantity > 0)) {
    return stage('sizing', {
      problems: ['the size came to zero shares — the balance cannot buy one whole share at ₹' + entry.toFixed(2)],
      sizing: sizing || null,
    });
  }

  // DRY RUN — the same path, stopped before a rupee moves, so what the operator is shown is the
  // size this code would actually use rather than a second calculation that can drift from it.
  // The modal calls this on open, so "this trade will buy N shares" is the broker-bound answer.
  if (r.dryRun) {
    return {
      ok: true,
      stage: 'sized',
      dryRun: true,
      sizing,
      sizingNote: sizing ? sizing.note
        : (capitalSource ? null : 'no live balance was readable — sized from the quantity supplied'),
      capital,
      capitalSource,
      quantity,
      wouldSend: { symbol: r.tradingsymbol, transactionType: side, productType, quantity, price: round2(entry), stop: round2(stop), target: round2(target) },
    };
  }

  // THE ENTRY. A MARKET order is the default because a bracket on an unfilled entry is a bracket
  // for nothing; a limit is still offered for the caller who wants the price controlled.
  const entryOrder = {
    tradingsymbol: r.tradingsymbol,
    symboltoken: r.symboltoken,
    exchange: r.exchange || Exchange.NSE,
    transactionType: side,
    orderType: r.orderType === OrderType.MARKET ? OrderType.MARKET : OrderType.LIMIT,
    productType,
    quantity,
    price: round2(entry),
    validity: r.validity || 'DAY',
  };
  if (!entryOrder.tradingsymbol || !entryOrder.symboltoken) {
    return stage('instrument', { problems: ['symboltoken is required — resolve the symbol before bracketing'], sizing, quantity });
  }

  let placed;
  try {
    placed = await d.placeOrder(entryOrder);
  } catch (e) {
    return stage('rejected', { problems: ['the broker refused the entry: ' + ((e && e.message) || e)], sizing, quantity, entryOrder });
  }
  const orderId = placed && (placed.orderId || placed.orderid);

  // THE FILL. If the order book can be read, wait for the fill so the protection is sized to what
  // actually filled; if it cannot, protect the requested quantity rather than protect nothing.
  let fill = null;
  if (orderId && typeof d.getOrderBook === 'function') {
    try {
      fill = await d.awaitFill
        ? await d.awaitFill({ getOrderBook: d.getOrderBook, orderId })
        : await awaitFill({ getOrderBook: d.getOrderBook, orderId, sleep: d.sleep });
    } catch (e) {
      fill = { filled: false, status: 'book unreadable: ' + ((e && e.message) || e) };
    }
  }
  const heldQuantity = fill && fill.filled && Number(fill.quantity) > 0 ? Number(fill.quantity) : quantity;
  const fillPrice = fill && Number(fill.averagePrice) > 0 ? Number(fill.averagePrice) : entry;

  // THE PROTECTION. This is the step that makes the press safe to walk away from.
  const rule = buildProtectionRule({
    side, tradingsymbol: entryOrder.tradingsymbol, symboltoken: entryOrder.symboltoken,
    exchange: entryOrder.exchange, quantity: heldQuantity,
    entry: fillPrice, stop, target, productType,
  });
  let protection;
  try {
    const created = await d.gtt.createRule(rule);
    protection = { ok: true, ruleId: created && created.ruleId, rule };
  } catch (e) {
    // THE ENTRY IS LIVE AND UNPROTECTED. Say so in the state itself, never as a log line: this is
    // the one failure an operator has to act on immediately, and it is why `ok` is false here even
    // though the entry succeeded.
    protection = {
      ok: false,
      rule,
      message: 'the entry is LIVE but the stop and target are NOT attached: ' + ((e && e.message) || e),
      manual: `place it yourself — ${side} ${heldQuantity} ${entryOrder.tradingsymbol}, stop ₹${round2(stop)}, target ₹${round2(target)}`,
    };
    return stage('protection', { problems: [protection.message, protection.manual], sizing, quantity, orderId, fill, protection, entryOrder: Object.assign({}, entryOrder, { orderId }) });
  }

  return {
    ok: true,
    stage: 'done',
    sizing,
    sizingNote: sizing ? sizing.note : (capitalSource ? null : 'no live balance was readable — sized from the quantity supplied'),
    capital,
    capitalSource,
    quantity,
    entryOrder: Object.assign({}, entryOrder, { orderId }),
    fill,
    protection,
  };
}

module.exports = { executeBracket, buildProtectionRule, geometry, cashFrom, awaitFill, DEFAULT_FILL_WAIT_MS, DEFAULT_RISK_PCT };
