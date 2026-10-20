# strategies/fvg/ — fair-value-gap strategies

## MAIN CODE

| file | what it is |
|---|---|
| `index.js` | **ENGINE 2 — fresh Fair-Value-Gap retest** (5m FG01 / 15m FG02). The research engine; the measured row `valueGap` is this module's premise. |
| `sweepFvgLive.js` | **the live Sweep + FVG signal engine** — 5-minute cadence, OR30 confluence, tick-by-tick exits. Publishes calls. |
| `sweep_fvg_strategy.py` | the Python mirror of the live engine, kept in parity with it (same stop-buffer measurement). |

<!-- dir-doc dir=strategies/fvg files=2 strategies=2 live=1 -->

## How many strategies, and how much each gives

**In this directory: 3 files — 2 strategies (1 research engine, 1 live engine) plus the python mirror of the live one.**

| strategy | how much it gives | evidence |
|---|---|---|
| FVG retest (`valueGap` row) | -0.110R per trade net, PF 0.817, 38.2% win — NO_EDGE | `data/strategy_rank_100.json` |
| Sweep + FVG live | PF 0.70, 35.0% win | `scratch/pf_board.js`, 14 call books |

Both are below the 1.00 PF line; that is the finding, not a rounding note.

## What the engine does, in one paragraph

A gap is registered only on the bar that CLOSED the third candle (the no-look-ahead line), only if it is at least the minimum width, and it is tradeable only on the FIRST return: a bar that closes through the far edge has filled the gap, not retested it, so the zone is retired. Stops and targets come from `strategy-core/tradePlanner.js`, which owns every price level.

- full measurement write-up: [docs/strategies/valueGap.md](../../docs/strategies/valueGap.md)
- live engine write-up: [docs/strategies/live-sweep-fvg.md](../../docs/strategies/live-sweep-fvg.md)
