# live-tier-nine — the nine tier strategies, and why they are off

**How much each gives: nothing — all nine are DEACTIVATED for having no net-positive record.**

<!-- tier-doc count=9 active=0 -->

`common/market/liveStrategyEngine.js` defines nine strategies in its `STRATEGIES` array and implements them in `RULES`. They fill the SCALPING / INTRADAY / SWING tables. The board artifact `data/live_strategy_board.json` (2026-10-17) reports every one of them with `enabled: false` and `status: "DEACTIVATED (no net-positive record)"`.

| # | id | tier | what it tests (in one line) | status |
|---|---|---|---|---|
| 1 | `VOL_SURGE_SCALP` | SCALPING | volume ≥ 2× the 20-bar average with a ±0.75% 15-bar ROC and price clear of VWAP | DEACTIVATED — closed today 0, netR 0.00 |
| 2 | `ORDER_FLOW_SCALP` | SCALPING | order-flow imbalance ≥ 60/40 with volume ≥ 2.5× (quantity fallback when the quote carries none) | DEACTIVATED — closed today 0, netR 0.00 |
| 3 | `MICRO_BREAKOUT_SCALP` | SCALPING | price outside the prior 15 closes with volume ≥ 2.2× | DEACTIVATED — closed today 0, netR 0.00 |
| 4 | `ORB_INTRADAY` | INTRADAY | price ±0.45% beyond the 09:15–09:25 opening range with a ≤ 2.0% range width | DEACTIVATED — closed today 0, netR 0.00 |
| 5 | `ROC_VOL_INTRADAY` | INTRADAY | ±1.00% 15-bar ROC with volume ≥ 2× and an EMA20/VWAP trend guard | DEACTIVATED — closed today 0, netR 0.00 |
| 6 | `VWAP_BAND_INTRADAY` | INTRADAY | price outside the VWAP ±1.25σ band with volume ≥ 2.2× and a 5-bar ROC ≥ 0.6% | DEACTIVATED — closed today 0, netR 0.00 |
| 7 | `DONCHIAN_SWING` | SWING | daily price beyond the 20-day high/low with 1.8× volume accumulation | DEACTIVATED — closed today 0, netR 0.00 |
| 8 | `GOLDEN_CROSS_SWING` | SWING | daily EMA20 vs EMA50, price agreeing with the cross | DEACTIVATED — closed today 0, netR 0.00 |
| 9 | `SUPERTREND_SWING` | SWING | daily ATR Supertrend (10, 3.0) direction | DEACTIVATED — closed today 0, netR 0.00 |

## What was measured, honestly

The only real reading anyone has of these nine is in the board's own stored history: on 2026-10-07 `VOL_SURGE_SCALP` was recorded as `closed: 42, closedWinRate: 38.1, netR −6.65` — a real, negative record. That is consistent with the status the board now shows them.

Two traps that used to make this table lie are documented in [docs/liveStrategies.md](../liveStrategies.md) and must stay closed:

- **`publishedWinRate` is a hardcoded label.** Eight of the nine carry the literal string `'100% (Net-Positive)'`. Nothing recomputes it. It is a declared expectation, not a measurement, and it must not be read as one.
- **`EMPIRICAL_BASELINE` is a fabricated fallback.** When a strategy has zero closed calls for the day the panel falls back to a hardcoded table (e.g. `ORB_INTRADAY: closed 260, targetsHit 260, winRate 100.0, netR 481.00`). Those numbers were never produced by a trade; they appear only before the first close of a day.

## Where it lives

- definitions: `common/market/liveStrategyEngine.js` (`STRATEGIES` array)
- rules: the same file, `RULES` object — `macdSmaTrend` is implemented but referenced by nothing, so it never runs
- board artifact: `data/live_strategy_board.json`
- full line-by-line description: [docs/liveStrategies.md](../liveStrategies.md)
