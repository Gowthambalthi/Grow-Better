'use strict';
/**
 * avgPriceEngine.js — THE AP ENGINE (AVERAGE PRICE).
 *
 * "AP" is the average traded price: the session VWAP the board prints in its `VWAP` column, the
 * distance to it, the POC, the value area — and the one order-flow reading that is ABOUT that
 * price rather than about direction: whether aggression is being ABSORBED at it.
 *
 * WHY ONE ENGINE AND NOT FOUR COLUMNS. VWAP, the VWAP stack (5-bar / 15-bar), the POC and the
 * value area are four answers to one question — where is the average price of the session, and
 * where is price relative to it. Computed in four places they can disagree (this repo has already
 * shipped two different VWAP denominators once); computed here, "above the average" means the same
 * thing on the board, in the engine and in the Pine mirror.
 *
 * THE DEFINITIONS, unchanged from boardMetrics.js on purpose:
 *   ATP / VWAP  Σ(typical price × volume) / Σvolume over the session's 1-minute bars, typical
 *               price = (high + low + close) / 3.
 *   STACK       price against session / 5-bar / 15-bar VWAP → 'ABOVE ALL' | 'BELOW ALL' | 'MIXED'.
 *   POC         the price bin holding the most traded volume, from the SAME profiler the footprint
 *               overlay uses (pocEngine.profileFromBars), never a second implementation.
 *   ABSORPTION  a volume-spike bar that travelled AWAY from the POC and closed back at it. That is
 *               what "control flips at the average price" looks like in OHLCV: one side pushed,
 *               the other took the size and returned the price. The engine reports WHICH side
 *               absorbed and at what price, and it says `null` when it cannot tell.
 *
 * A MISSING READ IS `null`, NEVER 0.
 */

const boardMetrics = require('./boardMetrics');
const pocEngine = require('./pocEngine');

const DEFAULTS = {
  atBandPct: 0.05,        // within this % of the average price counts as "AT" it
  nearPocPct: 0.10,       // within this % of the POC counts as "at the POC"
  absorptionRatio: 1.5,   // a bar needs this multiple of its own 5-bar average volume to absorb
  absorptionBars: 3,      // how far back an absorption print is still reported
};

// Same rule as liquidityEngine: `Number(null) === 0`, so null/''/booleans must be rejected BEFORE the
// cast, or a missing price becomes a real ₹0 and a missing volume becomes a real zero-volume bar.
function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pct(a, b) { return (a == null || !b) ? null : +(((a - b) / b) * 100).toFixed(3); }

/**
 * avgPriceRead(input) → the whole average-price verdict for one symbol.
 *
 * input: { bars, ltp, opts }
 */
function avgPriceRead(input = {}) {
  const opt = Object.assign({}, DEFAULTS, input.opts || {});
  const bars = (input.bars || []).filter(b => b && b.c > 0 && b.h >= b.l);
  const out = {
    engine: 'AP',
    ok: false,
    atp: null, atp5: null, atp15: null, stack: null,
    price: num(input.ltp),
    dist: null, distPct: null, side: null,            // ABOVE | BELOW | AT
    poc: null, vaLow: null, vaHigh: null, valueAreaPos: null,
    pocDist: null, pocDistPct: null, atPoc: false,
    absorption: null,                                 // { side, at, price, ratio, barsAgo, note }
    barsUsed: 0,
    reasons: [],
    refuse: null,
  };
  if (!bars.length) { out.refuse = 'no 1-minute bars for this symbol yet'; return out; }
  out.barsUsed = bars.length;

  const price = out.price != null && out.price > 0 ? out.price : bars[bars.length - 1].c;
  out.price = price;

  out.atp = round2(boardMetrics.vwapOf(bars));
  out.atp5 = round2(boardMetrics.vwapOf(bars.slice(-5)));
  out.atp15 = round2(boardMetrics.vwapOf(bars.slice(-15)));

  if (out.atp != null) {
    out.dist = +(price - out.atp).toFixed(2);
    out.distPct = +(((price - out.atp) / out.atp) * 100).toFixed(2);
    out.side = Math.abs(out.distPct) <= opt.atBandPct ? 'AT' : out.distPct > 0 ? 'ABOVE' : 'BELOW';
  }
  if (out.atp != null && out.atp5 != null && out.atp15 != null) {
    out.stack = (price > out.atp && price > out.atp5 && price > out.atp15) ? 'ABOVE ALL'
      : (price < out.atp && price < out.atp5 && price < out.atp15) ? 'BELOW ALL' : 'MIXED';
  }

  const prof = pocEngine.profileFromBars(bars);
  if (prof) {
    out.poc = prof.poc != null ? prof.poc : null;
    out.vaLow = prof.valueLow != null ? prof.valueLow : null;
    out.vaHigh = prof.valueHigh != null ? prof.valueHigh : null;
    if (out.poc != null) {
      out.pocDist = +(price - out.poc).toFixed(2);
      out.pocDistPct = pct(price, out.poc);
      out.atPoc = Math.abs(out.pocDistPct) <= opt.nearPocPct;
    }
    if (out.vaLow != null && out.vaHigh != null && out.vaHigh > out.vaLow) {
      const pos = (price - out.vaLow) / (out.vaHigh - out.vaLow);
      out.valueAreaPos = pos < 0 ? 'BELOW VA' : pos > 1 ? 'ABOVE VA' : pos < 0.33 ? 'LOWER VA' : pos > 0.67 ? 'UPPER VA' : 'MID VA';
    }
  }

  out.absorption = detectAbsorption(bars, out, opt);
  out.ok = out.atp != null;
  out.reasons.push(describe(out));
  return out;
}

/**
 * detectAbsorption — a volume-spike bar that left the POC and closed back at it.
 *
 * The signature is the one the plan describes as "control flips mid-candle": price pushed away
 * from the average-price level, size arrived, and the close came back to the level. Which side
 * absorbed is read from the bar's own close against its open at the level:
 *   close ABOVE the level after trading below it  → sellers were absorbed (buyers holding)
 *   close BELOW the level after trading above it  → buyers were absorbed (big selling)
 * `null` when no such bar is in the window — never a guess.
 */
function detectAbsorption(bars, ap, opt) {
  const src = bars.slice(0, -1);                       // completed bars only
  if (!src.length || ap.poc == null) return null;
  const recent = src.slice(-opt.absorptionBars);
  for (let i = recent.length - 1; i >= 0; i--) {
    const b = recent[i];
    const idxGlobal = src.length - recent.length + i;
    const prev5 = src.slice(Math.max(0, idxGlobal - 5), idxGlobal);
    if (!prev5.length) continue;
    const avg = prev5.reduce((s, x) => s + x.v, 0) / prev5.length;
    if (!(avg > 0) || b.v / avg < opt.absorptionRatio) continue;
    const level = ap.poc;
    const touched = b.l <= level && b.h >= level;
    if (!touched) continue;
    const closedAbove = b.c > level;
    const closedBelow = b.c < level;
    if (!closedAbove && !closedBelow) continue;
    const side = closedAbove ? 'BUYERS' : 'SELLERS';
    const note = side === 'BUYERS'
      ? 'size traded at the POC and the bar closed back above it — sellers absorbed'
      : 'size traded at the POC and the bar closed back below it — buyers absorbed';
    return {
      side,
      at: level,
      price: b.c,
      ratio: +(b.v / avg).toFixed(2),
      barsAgo: recent.length - 1 - i,
      barTime: b.t || null,
      note,
    };
  }
  return null;
}

function round2(v) { return v == null ? null : +Number(v).toFixed(2); }

function describe(o) {
  if (o.atp == null) return 'no average price yet (no traded volume)';
  const d = o.distPct == null ? '' : ' (' + (o.distPct > 0 ? '+' : '') + o.distPct + '%)';
  const p = o.poc == null ? '' : ' · POC ' + o.poc + (o.atPoc ? ' (at POC)' : '');
  const a = o.absorption ? ' · absorption ' + o.absorption.side + ' x' + o.absorption.ratio : '';
  return 'price ' + o.side + ' the average' + d + p + a;
}

/** The engine's board columns, in the board's own order. */
function columns() {
  return [
    { key: 'atp', label: 'VWAP (AP)', unit: '₹' },
    { key: 'distPct', label: 'VWAP Dist', unit: '%' },
    { key: 'poc', label: 'POC', unit: '₹' },
    { key: 'stack', label: 'Stack', unit: null },
  ];
}

module.exports = { avgPriceRead, detectAbsorption, columns, DEFAULTS };
