/**
 * common/risk/positionSizing.js — HOW MANY SHARES, FROM THE RISK AND THE MONEY AVAILABLE.
 *
 * One pure function, because position size is a decision with two hard limits and every surface
 * that shows a quantity must agree with the one that armed it:
 *
 *   1. RISK — the rupee distance from entry to stop, times the quantity, must not exceed the
 *      per-trade budget (a percent of capital, or an explicit rupee figure).
 *   2. MONEY — the whole position has to be payable from the capital available. A size that
 *      respects the risk budget but costs more than the account holds is not a position.
 *
 * The answer is the SMALLER of the two, rounded DOWN to the exchange lot. It is never rounded up
 * to reach the risk budget: that would break limit 1 to honour a target size, which is the wrong
 * direction to be wrong in.
 *
 * Everything here is arithmetic on numbers the caller supplies. No broker, no config, no clock —
 * which is why it can be pinned by a test.
 */
'use strict';

const DEFAULTS = {
  lotSize: 1,
  // A single position may not eat the whole account even when the stop is very tight. This is a
  // cap on exposure, not a risk rule, and it binds only when the risk rule alone would let one
  // trade take a large share of capital.
  maxNotionalPct: 100,
  // BELOW THIS, THE RISK BUDGET IS DISABLED AND THE WHOLE BALANCE IS THE SIZE.
  //
  // A small account and a percentage risk budget do not work together: 1% of a ₹2,500 balance is
  // ₹25, which buys nothing on any stock worth trading, so the "safe" rule would refuse every
  // trade the account could actually take. Below this floor the operator has already decided the
  // whole balance is at risk, so the risk limit is switched OFF and the money available is the
  // only limit. ABOVE the floor the risk budget binds again, unchanged.
  allInBelowInr: 3000,
};

/**
 * @param {object} p
 * @param {number} p.entry      planned entry / live LTP
 * @param {number} p.stop       the stop that invalidates the trade
 * @param {'LONG'|'SHORT'} [p.side]  only used to report which side the stop is on
 * @param {number} [p.capital]  money available for this account
 * @param {number} [p.riskPct]  percent of capital to risk on this trade
 * @param {number} [p.riskInr]  explicit rupee risk; overrides riskPct
 * @param {number} [p.lotSize]  exchange lot (1 for equity intraday)
 * @param {number} [p.maxNotionalPct] exposure cap as a percent of capital
 * @returns {object} the size, the two limits, and which one bound it
 */
function sizePosition(p) {
  const entry = Number(p && p.entry);
  const stop = Number(p && p.stop);
  const capital = Number(p && p.capital);
  const lotSize = Math.max(1, Math.floor(Number(p && p.lotSize) || DEFAULTS.lotSize));
  const maxNotionalPct = Number.isFinite(Number(p && p.maxNotionalPct)) && Number(p.maxNotionalPct) > 0
    ? Number(p.maxNotionalPct) : DEFAULTS.maxNotionalPct;

  const refuse = (reason, extra) => Object.assign({
    ok: false,
    qty: 0, shares: 0, notional: 0, riskInr: 0, riskPct: null,
    entry: Number.isFinite(entry) ? entry : null,
    stop: Number.isFinite(stop) ? stop : null,
    riskPerShare: null,
    budgetInr: null,
    qtyByRisk: null,
    qtyByCapital: null,
    qtyByExposure: null,
    binding: null,
    affordable: false,
    // Refusals carry the floor too: "cannot buy one share" means something different on an
    // all-in trade (the whole balance is too small for one share) than on a budgeted one (the
    // risk budget is), and the caller has to be able to tell them apart.
    allIn: false,
    reason,
  }, extra || {});

  if (!Number.isFinite(entry) || entry <= 0) return refuse('entry price is missing or not positive');
  if (!Number.isFinite(stop) || stop <= 0) return refuse('stop price is missing or not positive');
  if (entry === stop) return refuse('entry and stop are the same price — zero risk has no size');
  if (!Number.isFinite(capital) || capital <= 0) return refuse('no capital available was supplied');

  const riskPerShare = Math.abs(entry - stop);

  // THE ₹3,000 FLOOR — computed BEFORE the budget check, because under it there is no budget to
  // check: the whole balance is the position. See DEFAULTS.allInBelowInr for why.
  // `allIn` is reported separately from `binding`, because the money is still what capped the
  // size; all-in only says the risk rule was waived.
  const allIn = capital < (Number.isFinite(Number(p && p.allInBelowInr)) && Number(p.allInBelowInr) >= 0
    ? Number(p.allInBelowInr) : DEFAULTS.allInBelowInr);

  // The budget: an explicit rupee figure wins over a percentage, because the caller who typed
  // "I will risk ₹2,500 on this one" has already decided.
  const explicit = Number(p && p.riskInr);
  const pct = Number(p && p.riskPct);
  const useExplicit = Number.isFinite(explicit) && explicit > 0;
  if (!allIn && !useExplicit && (!Number.isFinite(pct) || pct <= 0)) {
    return refuse('no risk budget was supplied — set a risk % or a rupee amount', { riskPerShare });
  }
  // Under all-in the budget is only reported, never enforced: an all-in trade with no budget
  // supplied is sized by money alone, and its risk is whatever the whole balance happens to risk.
  const budgetInr = useExplicit ? explicit
    : (Number.isFinite(pct) && pct > 0 ? +(capital * pct / 100).toFixed(2) : capital);
  // LIMIT 1 — risk.
  const qtyByRisk = allIn ? Infinity : Math.floor(budgetInr / riskPerShare);
  // LIMIT 2 — money available.
  const qtyByCapital = Math.floor(capital / entry);
  // LIMIT 3 — exposure cap (binds only when the risk rule would let one trade dominate).
  const qtyByExposure = maxNotionalPct >= 100
    ? Infinity
    : Math.floor((capital * maxNotionalPct / 100) / entry);

  const rawQty = Math.min(qtyByRisk, qtyByCapital, qtyByExposure);
  if (!(rawQty > 0)) {
    const why = qtyByCapital < 1
      ? 'capital cannot buy one share at ₹' + entry.toFixed(2)
      : 'the risk budget (₹' + budgetInr.toFixed(2) + ') is smaller than one share\'s risk (₹' +
        riskPerShare.toFixed(2) + ')';
    return refuse(why, { allIn, riskPerShare, budgetInr, qtyByRisk: Number.isFinite(qtyByRisk) ? qtyByRisk : null, qtyByCapital, qtyByExposure: Number.isFinite(qtyByExposure) ? qtyByExposure : null });
  }

  // Round DOWN to whole lots: a partial lot is not orderable.
  const qty = lotSize > 1 ? Math.floor(rawQty / lotSize) * lotSize : rawQty;
  if (qty < 1) {
    return refuse(allIn
      ? 'one lot (' + lotSize + ') costs more than the balance available'
      : 'one lot (' + lotSize + ') would breach the risk budget or the capital available',
      { allIn, riskPerShare, budgetInr, qtyByRisk: Number.isFinite(qtyByRisk) ? qtyByRisk : null, qtyByCapital, qtyByExposure: Number.isFinite(qtyByExposure) ? qtyByExposure : null });
  }

  const notional = +(qty * entry).toFixed(2);
  const riskInr = +(qty * riskPerShare).toFixed(2);
  const binding = (qtyByExposure <= Math.min(qtyByRisk, qtyByCapital)) ? 'exposure'
    : (qtyByRisk <= qtyByCapital ? 'risk' : 'capital');
  return {
    ok: true,
    allIn,
    side: String((p && p.side) || '').toUpperCase() || null,
    entry, stop,
    riskPerShare: +riskPerShare.toFixed(2),
    budgetInr: +budgetInr.toFixed(2),
    qty, shares: qty,
    lotSize,
    notional,
    riskInr,
    riskPct: +(riskInr / capital * 100).toFixed(2),
    qtyByRisk,
    qtyByCapital,
    qtyByExposure: Number.isFinite(qtyByExposure) ? qtyByExposure : null,
    // WHICH LIMIT DECIDED IT — the number an operator needs when a size looks wrong.
    binding,
    affordable: notional <= capital,
    capital: +capital.toFixed(2),
    // The reward side is a ratio of the same size, so it is reported rather than assumed.
    note: allIn
      ? 'all-in: balance below ₹' + (Number.isFinite(Number(p && p.allInBelowInr)) ? Number(p.allInBelowInr) : DEFAULTS.allInBelowInr) +
        ' — the whole available money is the position, the risk budget is set aside'
      : (binding === 'capital'
        ? 'capped by the money available, not by the risk budget'
        : (binding === 'exposure' ? 'capped by the single-position exposure limit'
          : 'capped by the per-trade risk budget')),
  };
}

module.exports = { sizePosition, DEFAULTS };
