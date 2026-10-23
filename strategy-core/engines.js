'use strict';

/**
 * strategy-core/engines.js — THE ENGINE REGISTRY. One list, one place.
 *
 * WHY THIS FILE EXISTS. The same four facts about each engine — its key, its module, how long a
 * hold may run, and which candles its logic reads — were written out by hand in four different
 * files: the backtest harness, the board builder, the server's `/api/terminal/strategies`, and the
 * plan audit. Four copies of one list is four chances for the harness to measure a hold of 120 bars
 * while the board's live record follows the same signal for 90. So the list lives here, the
 * consumers import it, and there is exactly one answer to "what engines are there and how are they
 * configured".
 *
 * TIMEFRAMES. An engine is not "a timeframe" — a SETUP is. Fair Value Gaps are defined by a
 * three-candle imbalance on an aggregated frame, so FG01 only exists on 5-minute candles and FG02
 * only on 15-minute candles. The sweep and the order-flow proxy read 1-minute bars directly.
 */

const fvg = require('../strategies/fvg/index');
const orderFlow = require('../strategies/orderFlow');
const gb06 = require('../strategies/gb06');

/** How a candle size is spoken about, in one place. */
const FRAME_LABELS = { 1: '1-minute', 3: '3-minute', 5: '5-minute', 15: '15-minute', 60: '1-hour' };
const frameLabel = (minutes) => FRAME_LABELS[minutes] || (minutes + '-minute');

/** A minute-of-day as HH:MM, so a label can be DERIVED from the constant it describes. */
const hhmm = (minuteOfDay) => String(Math.floor(minuteOfDay / 60)).padStart(2, '0') + ':' +
  String(minuteOfDay % 60).padStart(2, '0');
/** The engines carry clock times as HHMM (e.g. 1230), so labels read that too. */
const hhmmOfClock = (n) => String(Math.floor(n / 100)).padStart(2, '0') + ':' + String(n % 100).padStart(2, '0');

const ENGINES = [
  {
    key: 'FVG',
    mod: fvg,
    file: 'strategies/fvg/index.js',
    maxHoldBars: 180,
    setups: [
      {
        setup: 'FG01',
        systemName: 'GB01',
        label: 'GB01: Fresh 5m fair-value-gap retest (MTF confirmed)',
        frameMinutes: 5,
        frames: [5, 15],
        needs: '5-minute candles confirmed by 15-minute trend & VWAP alignment. Entry cutoff ' + hhmm(fvg.DEFAULTS.maxEntryMinute) + ' IST, and a retest is only traded in the top ATR% regime (see strategies/fvg/index.js) — every larger sample of it is negative.',
      },
    ],
  },
  {
    key: 'ORDERFLOW',
    mod: orderFlow,
    file: 'strategies/orderFlow.js',
    maxHoldBars: 90,
    config: {
      // 11:30 — AND IT IS A MEASURED CHOICE, NOT A LEFTOVER. Swept on the authorized window
      // (172 sessions, 100 symbols, 5 bps) with ONLY this key changed
      // (scratch/of03_cutoff_1130_vs_1230.js, 2026-10-21):
      //
      //   10:30   7 trades  win 43%  netPF 0.703  −0.213R/trade
      //   11:30   8 trades  win 38%  netPF 0.572  −0.331R/trade   ← shipped
      //   12:00   9 trades  win 33%  netPF 0.482  −0.423R/trade
      //   12:30   9 trades  win 33%  netPF 0.482  −0.423R/trade   ← previously pinned
      //   14:30  10 trades  win 30%  netPF 0.408  −0.513R/trade
      //
      // 11:30 dominates the previously pinned 12:30 on every column by dropping the last
      // hour of entries, and later cutoffs are monotonically worse. This also reproduces
      // docs/GB-EDGE-REVIEW-2026-10-18.md exactly at 12:30 (9 trades, PF 0.482, −0.423R),
      // which is why that number is trusted and the "25 trades / netPF 1.997" in the old
      // test comment is not: it does not reproduce on this harness or window.
      //
      // THE HONEST LIMIT: every row is negative and the intervals overlap at n=8. This
      // bounds the damage, it does not create an edge. 10:30 measures better still.
      maxSignalTime: 1230,
    },
    setups: [
      {
        setup: 'OF03',
        systemName: 'GB03a',
        label: 'GB03a: Institutional OF Exhaustion (entry window ' + hhmm(9 * 60 + 20) + '–' + hhmmOfClock(orderFlow.DEFAULTS.maxSignalTime) + ' IST)',
        frameMinutes: 1,
        frames: [1],
        needs: '1-minute candles — aggression into a marginal new extreme that fails to hold before ' + hhmmOfClock(orderFlow.DEFAULTS.maxSignalTime) + ' IST. OHLCV proxy: the feed carries no executed aggressor side, so this is exhaustion geometry, not order-flow imbalance.',
      },
    ],
  },
  {
    key: 'GB06',
    mod: gb06,
    file: 'strategies/gb06.js',
    maxHoldBars: 60,
    config: {},
    setups: [
      {
        setup: 'EMA01',
        systemName: 'GB06',
        label: 'GB06: EMA Crossover (9/21) Scalping',
        frameMinutes: 1,
        frames: [1],
        needs: '1-minute candles — EMA(9)/EMA(21) crossover with ATR-based SL/TP, max 2 trades/day, cooldown 10 bars, no trades after 14:00 IST.',
      },
    ],
  },
];

/** key -> engine, built once. */
const BY_KEY = {};
for (const e of ENGINES) BY_KEY[e.key] = e;

/** The hold cap the harness and the board's live record both obey. */
const MAX_HOLD = {};
for (const e of ENGINES) MAX_HOLD[e.key] = e.maxHoldBars;

/**
 * THE MEASURED RECORD — one implementation, four readers.
 *
 * The board builder used to own this arithmetic, and the server served the copy it had frozen into
 * data/terminal/board.json. That snapshot is only as new as the last scan, so after OF03's
 * thresholds were retightened and re-measured on 2026-10-17 the page kept publishing the OLD
 * configuration's numbers (87 trades, netPF 1.383) while the engine on disk measured 19 trades at
 * netPF 2.093 — a page and a backtest disagreeing about which configuration ships, which is exactly
 * the failure `docs/ORDERFLOW-PHASE2.md` pins a hash to prevent.
 *
 * BOTH CONDITIONS TO SPEAK: clear netPF 1.5 AND carry at least 30 resolved trades. A PF measured on
 * 19 trades is not a validated edge.
 */
const MIN_NET_PF = 1.5;
const MIN_TRADES_FOR_SAMPLE = 30;

/** `backtest` is the data/terminal/backtest_results.json (or null). */
function measuredRules(backtest) {
  return ENGINES.map((e) => {
    const r = backtest && backtest.engines ? backtest.engines[e.key] : null;
    const at05 = r && r.byCost ? r.byCost['0.05'] : null;
    const trades = at05 ? at05.trades : 0;
    const netPF = at05 ? at05.netPF : null;
    return {
      engine: e.key,
      name: e.mod.name,
      trades,
      winPct: at05 ? at05.winPct : null,
      netPF,
      expectancyR: at05 ? at05.expectancyR : null,
      netR: at05 ? at05.netR : null,
      maxDDR: at05 ? at05.maxDDR : null,
      measuredAt: backtest ? backtest.generatedAt : null,
      corpusSymbols: backtest && backtest.corpus ? backtest.corpus.symbols : null,
      costPct: 0.05,
      thin: trades < MIN_TRADES_FOR_SAMPLE,
      speak: netPF != null && netPF >= MIN_NET_PF && trades >= MIN_TRADES_FOR_SAMPLE,
      minNetPF: MIN_NET_PF,
      thinBelowTrades: MIN_TRADES_FOR_SAMPLE,
    };
  });
}

/** The catalogue `/api/terminal/strategies` serves. */
function catalogue() {
  return ENGINES.map((e) => ({
    key: e.key,
    name: e.mod.name,
    file: e.file,
    maxHoldBars: e.maxHoldBars,
    basis: e.mod.BASIS || null,
    families: e.setups.map((s) => ({
      setup: s.setup,
      label: s.label,
      frameMinutes: s.frameMinutes,
      frameLabel: frameLabel(s.frameMinutes),
      frames: s.frames,
      needs: s.needs,
      // A setup that has been MEASURED OUT — kept in the catalogue so the page can say so, rather
      // than disappearing and looking like it was never tried.
      disabled: !!s.disabled,
    })),
  }));
}

module.exports = {
  ENGINES, BY_KEY, MAX_HOLD, FRAME_LABELS, frameLabel, hhmm, hhmmOfClock,
  MIN_NET_PF, MIN_TRADES_FOR_SAMPLE, measuredRules, catalogue,
};
