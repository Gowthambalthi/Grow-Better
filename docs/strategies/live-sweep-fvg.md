# live-sweep-fvg — Sweep + FVG (what runs live)

**What it gives: PF 0.70, win rate 35.0%, pooled over the 14 call books written so far — below break-even.**

<!-- live-doc id=SWEEP_FVG pf=0.70 winPct=35.0% callBooks=14 -->

## What it is

`strategies/fvg/sweepFvgLive.js`, with a Python mirror in `strategies/fvg/sweep_fvg_strategy.py`. 5-minute bar cadence with a 30-minute opening range (OR30) confluence, causal n=3 swing pivots with a 30-bar expiry, BSL/SSL sweep detection (wick ≥ 35% of the bar range, close back inside the level), an FVG displacement filter (gap ≥ 0.20 × ATR(14) within 3 bars), a limit entry at the 50% FVG midpoint with strictly traded-through execution, and a structural stop (sweep extreme + buffer) with an opposing structural target. SHORT-only on the sweep branch.

Exits are tick-by-tick: targets and stops are evaluated on the live tick, not on bar closes.

## How much it gives

| engine | win rate | PF |
|---|---|---|
| Sweep + FVG (5m cadence) | 35.0% | **0.70** |
| Order Flow Institutional Momentum (same book) | 44.2% | 0.79 |

Same measurement source as its sibling: `node scratch/pf_board.js`, pooled over 14 call books, classified by the shipped `common/market/callBookHistory.js`.

## Friction is itemised, not assumed

The engine books NSE friction explicitly (5.384 bps statutory plus 1–4 bps slippage) rather than taking a round number, and the stop buffer was measured rather than intuited: the old 1-tick-beyond-the-swept-extreme stop is exactly the level every other participant watches. Any number quoted from this engine already carries that accounting.

## Where it lives

- engine: `strategies/fvg/sweepFvgLive.js`
- python mirror: `strategies/fvg/sweep_fvg_strategy.py`
- the FVG research engine it borrows the zone from: `strategies/fvg/index.js` ([valueGap](../strategies/valueGap.md) is that premise as a measured row)
- call book: the same `data/orderflow/daily_calls_<date>.json` as the OF engine
