# strategies/ — the strategy code

## MAIN CODE

| file | what it is |
|---|---|
| `strategies/liquiditySweep.js` | **ENGINE 1 — liquidity sweep reversal.** Hash-pinned by Gate F, so the path is frozen. Measured as the row `liquiditySweep`. |
| `strategies/orderFlow.js` | **ENGINE 3 — exhaustion / failed aggression (OF03 v1 only — OF01 and OF02 removed 2026-10-15).** Hash-pinned, and it carries the order-flow planner CONFIG that Gate F hashes. |
| `strategies/fvg/index.js` | **ENGINE 2 — fair-value-gap retest** (lives in `fvg/`). |

Everything else in this directory is organised under a subdirectory by strategy family: `fvg/`, `orderflow/`, `roc/`, `frozen/`.

<!-- dir-doc dir=strategies files=3 strategies=6 engines=2 -->

## How many strategies, and how much each gives

**In this directory and its subdirectories: 3 research engines (engines 1–3), the live engines built on them, and the experimental ROC family — the six rows below are every strategy with a number attached.**

| strategy | how much it gives | evidence |
|---|---|---|
| Liquidity Sweep Reversal (`liquiditySweep`) — `strategies/liquiditySweep.js` | -0.099R per trade net, PF 0.832 — NO_EDGE (CI [-0.136, -0.063]) | `data/strategy_rank_100.json` |
| Value gap / FVG re-entry (`valueGap`) — `strategies/fvg/index.js` | -0.110R per trade net, PF 0.817 — NO_EDGE | `data/strategy_rank_100.json` |
| Intraday ROC+VWAP (`intraday_roc`) — `strategies/roc/rocEngine.js` | -0.193R per trade net, PF 0.740 — NO_EDGE | `data/strategy_rank_100.json` |
| Order Flow Institutional Momentum (live) — `strategies/orderflow/liveMinuteEngine.js` | PF 0.79, win rate 44.2% | `scratch/pf_board.js`, 14 call books |
| Sweep + FVG (live) — `strategies/fvg/sweepFvgLive.js` | PF 0.70, win rate 35.0% | the same call books |
| Engine 3 order-flow setup (OF03 exhaustion) — `strategies/orderFlow.js` | 50.0% win, grossPF 1.980, +0.4900R over 64 trades | `data/terminal/backtest_runall_100.json` |

## The three engines, in their own words

- **ENGINE 1 — `liquiditySweep.js`.** Raids of *meaningful* levels only: formation, age, untouched, distance and dedupe filters, incremental per-day state, and a strict refusal list. v1 treated every swing as raid-worthy and "found" a raid on about half of all one-minute bars.
- **ENGINE 2 — `fvg/index.js`.** A Fair Value Gap is a three-candle imbalance, so it only exists on a frame that contains the three candles; the engine builds 5m and 15m frames on the clock and trades the FIRST retest, retiring a zone that is closed through.
- **ENGINE 3 — `orderFlow.js`.** An OHLCV proxy for order flow: lots of volume with little travel is absorption, lots of volume with a close at the extreme is continuation. Its own header states that the broker feed carries resting depth, not executed aggressor volume, and every signal is stamped with that basis.

## Frozen, and why a move is not cosmetic

`strategies/liquiditySweep.js`, `strategies/orderFlow.js` and `strategy-core/tradePlanner.js` are hash-pinned by Gate F, and the paths are asserted by tests (`test/researchGuard.test.js`, `test/f1LiveGuard.test.js`, `backtest/phase5Preflight.js`). A copy of engine 3 is compared byte-for-byte by a test: `strategies/frozen/orderFlow.of03v1.js`.

## Related

- one file per measured strategy: [docs/strategies/README.md](../docs/strategies/README.md)
- how the layout came to be, and the trap the move had to avoid: [docs/STRATEGIES.md](../docs/STRATEGIES.md)
