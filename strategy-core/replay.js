/**
 * strategy-core/replay.js — ask one engine about ONE bar of a full array.
 *
 * WHY THIS EXISTS. All three engines carried their own copy of this wrapper,
 * each with the same comment about being O(n²). Three copies of a convenience
 * function is how one of them quietly becomes the one a test drives while the
 * other two drift — so it is written once, and each engine's `evaluate()` is a
 * one-line binding of it.
 *
 * It rebuilds the engine's state from bar 0 up to `upto`, so it is O(bars) per
 * call and O(n²) over a whole replay. That is fine for what it is for: a caller
 * with a full array asking a question about one bar (a test, a probe, a
 * what-if). A backtest must use `createEngine()` directly and walk the bars once.
 *
 * `mod` is an engine module: anything exporting `createEngine` and `DEFAULTS`.
 */
'use strict';

function replay(mod, bars, upto, config) {
  const cfg = Object.assign({}, mod.DEFAULTS, config || {});
  const eng = mod.createEngine(cfg);
  let last = null;
  for (let i = 0; i <= upto; i++) {
    const s = eng.onBar(bars, i);
    if (i === upto) last = s;
  }
  return last;
}

module.exports = { replay };
