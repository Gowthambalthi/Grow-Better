# GB06 — completed and backtested

**Date:** 2026-10-20
**Question:** finish GB06 (EMA 9/21 crossover scalping) and measure it.

**Outcome:** the strategy is now **mechanically correct and measurable** — it fires, plans, fills and closes trades with the rules the registry describes. It has **no edge after costs**: 46,696 trades over 60 sessions, netPF 1.051 gross, **0.755 at 5 bps**. No SL/TP variant tried clears 1.00.

---

## 1. What was broken

GB06 fired **8,255 signals over 20 sessions and the planner refused every single one**. Three separate causes, all silent — the engine kept returning without an error and the report simply read "no trades".

| # | Cause | Effect |
|---|---|---|
| 1 | Target priced on the **wrong side** of entry: `bar.high − 0.1×ATR` for a LONG | `gate: TARGET` on all 8,255 |
| 2 | `signal.targetCandidates` held `{price, basis}` **objects** | `backtest/follow.js` re-plans from that array at the fill, `isNaN(object)` is true → 1,362 of 1,386 signals died as `REFILL_TARGET` |
| 3 | `atrScaleFactor = 20` multiplied the measured ATR **and** ATR% by twenty so the shared `minAtrPct: 0.60` floor would pass | every stop inflated 20×, then clamped by the planner's 1.5% ceiling |

There was also a `detectSignal()` stub that always returned `null` — removed rather than left as a function that cannot answer.

## 2. What it is now

Exactly what the registry says: "EMA(9)/EMA(21) crossover with ATR-based SL/TP, max 2 trades/day, cooldown 10 bars, no trades after 14:00 IST."

* **Stop** = one ATR beyond the entry close. **Target** = two ATR beyond it → RR 2 by construction.
* **The ATR floor is recalibrated, not scaled**: `planner.minAtrPct: 0.10` (1-minute ATR% medians ~0.15%), the same recalibration `strategies/orderFlow.js` already carries for the same reason.
* **Only the measured move is offered as a target.** `pickTargets()` takes the *nearest* valid candidate, so offering VWAP/POC/day-high would hand the planner something closer than the RR floor and refuse the trade — the trap this strategy was stuck in.
* `targetCandidates` is a **list of numbers**, because the fill re-plans from it.
* Crossover requires two real previous EMA values (`null <= null` is true in JS).

## 3. The measurement

Corpus `data/ohlcv_1m_full` · **1,031 symbols · 60 sessions (2026-07-13 → 2026-10-06)** · 1.76 crore one-minute bars · 60-bar warmup · entries 09:20–15:00 IST, blocked windows refused · next-open fill · hold cap 60 bars.

```
signals fired : 93,303
refusals      : EXTENSION 109,630 · BLOCKED_TIME_WINDOW 1,720 · STOP_TOO_WIDE 27
fill-vetoed   : REFILL_RR 8,253 · FILL_INVERTED 1,200 · REFILL_TARGET 171 · REFILL_STOP_TOO_WIDE 14
```

| cost (round trip) | trades | win% | netPF | NET R | expectancy |
|---|---|---|---|---|---|
| 0.00% | 46,696 | 37.6% | **1.051** | **+1,462.2** | +0.0313R |
| 0.02% | 46,696 | 37.5% | 0.918 | −2,589.4 | −0.0555R |
| 0.05% | 46,696 | 37.3% | **0.755** | **−8,666.7** | −0.1856R |
| 0.10% | 46,696 | 37.1% | 0.550 | −18,795.6 | −0.4025R |

**The gross result is +0.031R per trade. Costs are 0.217R per trade at 5 bps.** The strategy does not have a small edge that fees erode; it has essentially none, and fees are seven times it.

By side at 5 bps: **LONG 22,782 trades, netPF 0.605, −7,360R** · **SHORT 23,914 trades, netPF 0.922, −1,306.7R**. The short side is the better half and still loses.

## 4. Is any other SL/TP ratio worth keeping?

Declared up front, measured once, same corpus — not an optimiser, and nothing is re-selected on the data afterwards.

| variant (SL / TP in ATR) | trades | win% | netPF @5bps | NET R @5bps |
|---|---|---|---|---|
| RR 1.5 (0.75 / 1.13) | 12,541 | 39.6% | 0.776 | −1,998.1 |
| RR 1.5 (1.00 / 1.50) | 22,804 | 40.0% | 0.789 | −3,361.1 |
| **RR 2.0 (1.00 / 2.00) — shipped** | 46,696 | 37.3% | 0.755 | −8,666.7 |
| RR 3.0 (1.00 / 3.00) | 48,763 | 31.6% | 0.797 | −8,069.2 |
| RR 2.0 wide (1.50 / 3.00) | 48,370 | 37.4% | **0.810** | −6,380.8 |
| RR 1.0 (0.50 / 0.50) | 0 | — | — | refused by the 1.2 RR floor |

Every ratio that produces trades lands between 0.755 and 0.810. The spread across an entire parameter family is smaller than the cost assumption — which is what "no edge" looks like.

## 5. Verdict

* **Complete:** yes. GB06 is registered (`strategy-core/engines.js`, setup `EMA01`, hold 60), fires, plans, fills and closes with sane geometry, and six regression tests pin the three defects above (`test/gb06.test.js`).
* **Deployable:** **no.** At any realistic cost it loses. A 9/21 EMA cross on one-minute bars is a lagging signal in a market that pays the spread.
* **Registered ≠ live.** GB06 is in the backtest registry only. The live server runs GB01 (FVG) and GB03a (OF03); putting GB06 on the tape is a separate decision that this measurement does not support.

If an EMA system is wanted, the honest next step is not another ratio on this one — it is testing whether the crossover adds anything on top of a regime filter (trend day, VWAP side) rather than in all conditions.

## 6. Reproducing

```bash
# full corpus, 60 sessions
node backtest/runAll.js --engine=GB06 --days=60 --out=scratch/gb06_full60.json

# the ratio grid and the side split
node scratch/gb06_grid.js --days=60

# regression tests
node --test test/gb06.test.js
```
