# The nine live strategies — names and how each is implemented

Source of truth: [common/market/liveStrategyEngine.js](../common/market/liveStrategyEngine.js).
Strategy definitions live in the `STRATEGIES` array (line 209); the entry logic for each
lives in the `RULES` object (line 398), keyed by the `rule` field of its definition.

Geometry: `targetPct` / `slPct` are fractions of the entry price (0.0215 = +2.15%),
`maxAgeMs` is the maximum time a call may stay open before the rule-expiry exit.

| # | id | name | tier | target | stop | hold window | how it is implemented |
|---|---|---|---|---|---|---|---|
| 1 | `VOL_SURGE_SCALP` | 15-Min Volatility & Volume Momentum Breakout | SCALPING | +2.15% | −0.85% | 15–45 min | `volSurgeRoc` (L401) |
| 2 | `ORDER_FLOW_SCALP` | 30-Min Institutional Liquidity Sweep Reversal | SCALPING | +2.05% | −0.80% | 30–60 min | `orderFlowImpulse` (L431) |
| 3 | `MICRO_BREAKOUT_SCALP` | Multi-Timeframe 15m/60m Trend Alignment Impulse | SCALPING | +2.85% | −0.90% | 30–90 min | `microBreakout` (L468) |
| 4 | `ORB_INTRADAY` | Opening Range Breakout (ORB) – Liquid Bluechips | INTRADAY | +1.85% | −0.70% | 09:30–10:30 | `orb` (L493) |
| 5 | `ROC_VOL_INTRADAY` | Multi-Hour Session VWAP & 20-EMA Trend Continuation | INTRADAY | +2.35% | −0.85% | 10:30–14:50 | `rocVol` (L532) |
| 6 | `VWAP_BAND_INTRADAY` | 01:30 PM European Open Afternoon Breakout Surge | INTRADAY | +2.10% | −0.80% | 13:30–15:00 | `vwapBand` (L563) |
| 7 | `DONCHIAN_SWING` | 20-Day Donchian Breakout + Vol Accumulation | SWING | +9.00% | −4.50% | < 50 days | `donchian` (L622) |
| 8 | `GOLDEN_CROSS_SWING` | Golden Cross EMA Swing (20 EMA > 50 EMA) | SWING | +8.50% | −4.00% | < 50 days | `goldenCross` (L643) |
| 9 | `SUPERTREND_SWING` | Supertrend Momentum Pullback Swing | SWING | +9.50% | −4.50% | < 50 days | `supertrend` (L664) |

## What each rule actually tests

All intraday rules first call `closedBars()` (L685), which drops the still-forming
minute, so no rule can read the bar it is standing on.

**1. `volSurgeRoc` — VOL_SURGE_SCALP.** Last closed 1-min bar volume ≥ **2.0×** the
20-bar average, and a **15-bar ROC** ≥ **±0.75%**, and the live price ≥ **0.15%** clear of
session VWAP in the signal's direction. Side = sign of the ROC. Score = |ROC| × volume
ratio (capped at 3×) × 1.2 if VWAP-aligned, × 0.2 if inside the VWAP chop zone.

**2. `orderFlowImpulse` — ORDER_FLOW_SCALP.** Buy/sell **order-flow imbalance ≥ 60/40**
from the quote's `totBuy`/`totSell`, plus 1-min volume ≥ **2.5×** the 20-bar average. Side
= side of the imbalance. If the quote carries no quantity it falls back to a 10-bar
up/down-bar volume proxy and says so in `detail`.

**3. `microBreakout` — MICRO_BREAKOUT_SCALP.** Live price outside the prior **15 close
prices**, with volume ≥ **2.2×** the 20-bar average. Side = break direction; inside the
range it picks the nearer half.

**4. `orb` — ORB_INTRADAY.** Opening range = first **10** one-minute bars (09:15–09:25),
high/low from that range; entry needs the live price **±0.45% beyond** the range, volume ≥
**2.5×** the range's average, the live price on the VWAP side of the break, and the range
**width ≤ 2.0%** (skips giant gap mornings). Optionally bluechip-only.

**5. `rocVol` — ROC_VOL_INTRADAY.** **15-bar ROC ≥ ±1.00%** with volume ≥ **2.0×** the
20-bar average, gated by a trend guard: for a BUY the live price must be ≥ EMA20 **and**
≥ VWAP (mirrored for a SELL). Counter-trend signals are scored 0.2 instead of 1.2.

**6. `vwapBand` — VWAP_BAND_INTRADAY.** Live price outside the session VWAP **±1.25σ**
band (σ of close-minus-VWAP), with volume ≥ **2.2×** and a **5-bar ROC ≥ ±0.60%**. Side =
side of VWAP.

**7. `donchian` — DONCHIAN_SWING.** Daily bars: live price beyond the **20-day** high/low,
scored by the day-volume accumulation ratio against a **1.8×** requirement. Side = break
direction.

**8. `goldenCross` — GOLDEN_CROSS_SWING.** Daily closes: EMA**20** vs EMA**50**, and the
live price must *agree* with the cross (above the fast EMA for a BUY, below for a SELL).
Side = which EMA is on top.

**9. `supertrend` — SUPERTREND_SWING.** ATR Supertrend **(10, 3.0)** on daily bars. Side =
the trend direction, and `ruleMet` is always `true` — a Supertrend is always in one
direction, so the direction *is* the rule.

## Two things to know before trusting a number off this board

**`publishedWinRate` is a hardcoded label, not a measurement.** Every definition carries a
`winRate` string — `'100% (Net-Positive)'` for eight of the nine, `'72.9% (Net-Positive)'`
for `VOL_SURGE_SCALP`. These are constants written into the source. They are declared
expectations from before the strategies traded, and nothing recomputes them.

**`EMPIRICAL_BASELINE` is a fabricated fallback.** At line 1241 there is a hardcoded table:

```js
const EMPIRICAL_BASELINE = {
  ORB_INTRADAY:       { open: 2, closed: 260, targetsHit: 260, stopsHit: 0, winRate: 100.0, netR: 481.00, ... },
  SUPERTREND_SWING:   { open: 2, closed: 176, targetsHit: 176, stopsHit: 0, winRate: 100.0, netR: 642.40, ... },
  ...
};
```

`strategyPerformance()` uses it only when that strategy has **zero** closed calls for the
current day (`rows.length > 0 ? real : base`). So on a day with no closes — or before the
first close — the panel shows 100% win rates, 0 stopped out, and hundreds of R. Those
numbers were never produced by a trade. They must not be shown as performance.

Its own comment claims the panel is "answered from the calls themselves rather than from a
constant", which is true only after the first close of the day. When live rows exist the
real path is used: on 2026-10-07 the stored board reported `VOL_SURGE_SCALP` as
`closed: 42, closedWinRate: 38.1, netR: -6.65` — real, and negative.

**Not in the list:** `macdSmaTrend` (L594) is implemented in `RULES` but no entry in
`STRATEGIES` references it, so it never runs. It is dead code unless a definition is added.

## Declared names vs what the code enforces

Some of the name is marketing. Verified by reading the rule bodies:

- **The names say 15-min / 30-min / 60-min timeframes; the code reads 1-minute bars.**
  `VOL_SURGE_SCALP` is called "15-Min", `ORDER_FLOW_SCALP` "30-Min",
  `MICRO_BREAKOUT_SCALP` "15m/60m MTF", and the `logic` strings mention "15-Min High" and
  "5-bar ROC". In the code every window is a **bar count on 1-minute bars** (lookback 15,
  rangeBars 15, rocBars 15). There is no 15-minute or 60-minute aggregation anywhere in
  these rules.
- **`bluechipOnly: true` (L256) is never read.** The `orb` rule does not reference it and
  nothing else does either, so ORB is not restricted to bluechips by the rule despite its
  name saying "Liquid Bluechips".
- **`requireEma20: true` (L268) is never read.** `rocVol` applies the EMA20 guard
  unconditionally, so the behaviour is right but the parameter is inert.
- **ORB's real time window lives outside the rule.** The 09:30–11:30 IST ORB cut-off is
  enforced in the scan gate at L1771–1776 (`isOrbLate`), not in `orb()`.
- **`VWAP_BAND_INTRADAY` has no 13:30 gate.** Its name ("01:30 PM European Open") and
  `holdingPeriod: '13:30 - 15:00 IST'` are labels; `vwapBand()` contains no hour test. The
  only time gate near it is the Mid-Day Lunch Chop Guard (12:00–13:30) at L1569, which
  blocks *other* strategies.
- **`holdingPeriod` is a label, not a rule.** Real exits come from `targetPct`, `slPct` and
  `maxAgeMs` plus the strategy's own rule-flip.
- **`MICRO_BREAKOUT_SCALP`'s `logic` string claims "EMA20 Breakout Impulse"; the rule checks
  no EMA at all** — it is a 15-bar close-range break plus a volume filter.
