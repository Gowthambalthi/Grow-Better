# live-of-momentum — Order Flow Institutional Momentum (what runs live)

**What it gives: PF 0.79, win rate 44.2%, pooled over the 14 call books written so far — below break-even.**

<!-- live-doc id=OF_MOMENTUM pf=0.79 winPct=44.2% callBooks=14 -->

## What it is

`strategies/orderflow/liveMinuteEngine.js`. It reads live Angel One ticks every second, keeps in-memory 1-minute OHLCV, volume, delta and VWAP for ~700–1,000 NSE symbols, and runs its institutional setup scan once a minute; up to 6 calls are armed per day on a 1-minute cadence. It is the same code path in replay and live, which is why the tape can be compared to the book at all.

Its setups are the engine 3 family (`strategies/orderFlow.js`, OF03 exhaustion — OF01 absorption and OF02 continuation were removed 2026-10-15) plus FVG support, delta footprint, volume surge and the anti-climax guard. The engine says on every signal that the broker feed carries resting depth, not executed aggressor volume — the delta it shows is a proxy and is labelled as one.

## How much it gives

Measured from the calls it actually wrote, not from a backtest: `node scratch/pf_board.js` pools `data/orderflow/daily_calls_*.json` through the shipped, tested classifier in `common/market/callBookHistory.js`, so an expired or cancelled call is bucketed exactly as the dashboard buckets it.

| engine | win rate | PF |
|---|---|---|
| Order Flow Institutional Momentum | 44.2% | **0.79** |
| Sweep + FVG (the other writer of the same book) | 35.0% | 0.70 |

Books read: 14. Attribution mismatches against the shipped reader: 0 (must stay 0; the script fails loudly if its own attribution disagrees with the dashboard).

## What this number is not

It is not the tier strategies: those run in `common/market/liveStrategyEngine.js` and are all deactivated ([live-tier-nine.md](live-tier-nine.md)). It is also not a fixed sample — a new call book moves the pooled number, and `scratch/verify_strategy_docs.js` fails when this file's stated book count no longer matches the disk.

## Where it lives

- engine: `strategies/orderflow/liveMinuteEngine.js`
- setup rules: `strategies/orderFlow.js` (hash-pinned)
- tick capture: `strategies/orderflow/tickCapture.js`
- call book: `data/orderflow/daily_calls_<date>.json` (written by this engine and by Sweep + FVG)
- measurement: `node scratch/pf_board.js`
