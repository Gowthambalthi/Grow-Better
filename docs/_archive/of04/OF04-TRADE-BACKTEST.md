# OF04 — Trade-Level Backtest of the Frozen Normalized-Extreme Mean-Reversion Mechanism

**Status:** complete. **Both tracks are rejected at realistic cost.**
**Nothing was tuned.** The frozen thresholds, production code, OF01/OF03, and Phase 5A were not touched.

This document is the trade-level audit that the aggregate discovery artifacts could not provide.
It converts every qualifying event into an actual simulated trade (entry → stop → target/exit →
cost → slippage → final R) over the **full historical corpus**, and reports the result honestly.

---

## 1. What was backtested (frozen, unmodified)

| | SCALP | INTRADAY |
|---|---|---|
| UP branch | `distLo60 < 0.02` → LONG | `distLo15 < 0.05` → LONG |
| DOWN branch | `distHi60 < 0.02` → SHORT | `distHi15 < 0.05 & imp15 ∈ [0.2, 0.4)` → SHORT |
| Data source | `data/orderflow/ticks-YYYY-MM-DD.jsonl` (tick tape) | `data/ohlcv_1m/*.json` (1-minute corpus) |
| Sessions covered | 4 (2026-09-28 → 2026-10-01) | 145 (2026-02-27 → 2026-09-30) |
| Execution clock | tick-level | bar-level |

Thresholds are exactly those frozen in the discovery campaign. No filter, no symbol/session
selection, no parameter search was applied.

### 1.1 Execution semantics (pre-declared, mirrors the research framework)

Taken from `strategies/roc/outcomeTracker.js` and the OF04 cost/infra work:

- **risk unit** `RISK = 0.20%` of entry price (1R). R = realised % move ÷ 0.20.
- **bracket** ±1R: stop = entry ∓ 0.20%, target = entry ± 0.20% (`targetR = 1.0`).
- **cost** `COST = 0.05%` round-trip + **slippage** `SLIP = 0.02%` ⇒ `TOTAL_COST = 0.07%` (= 0.35R per trade).
- **max hold** scalp 60 s; intraday 30 bars. Exit = first of **STOP / TARGET / TIME**; remaining
  positions force-closed at session end (`SESSION_END`).
- **conservative rule:** if a bar touches both stop and target, **STOP is assumed first.**
- **dedup group:** `symbol | time-bucket` (2 s scalp, 15 min intraday).

### 1.2 The one honesty-critical design decision

The discovery **directional** aggregates were computed only among events whose forward class was
`cls > 0` (i.e. *a tradeable move existed afterwards*). `cls` is a property of the **future**, so
trading only `cls > 0` events would be look-ahead. This backtest therefore trades **every** event
that matches the state predicate — the only population that is actually tradeable in real time.
That choice is expected to make the result **weaker** than the discovery aggregate, and it does.

---

## 2. Artifacts

| Artifact | Path |
|---|---|
| Simulator / analyser | [research/of04TradeBacktest.js](research/of04TradeBacktest.js) |
| Scalp trades (10,322,492 lines, 3.57 GB) | `data/terminal/of04-trades-scalp.jsonl` |
| Intraday trades (1,348,207 lines, 483 MB) | `data/terminal/of04-trades-intraday.jsonl` |
| Scalp stats JSON | `data/terminal/of04-trade-backtest-stats-scalp.json` |
| Intraday stats JSON | `data/terminal/of04-trade-backtest-stats-intraday.json` |

Every trade line persists: `ts, day, hour, symbol, direction, branch, entry, stop, target, exit,
exitReason, grossPct, grossR, costPct, slippagePct, netPct, netR, dedupGroup`.
The analyser is memory-bounded (typed arrays + bounded maps) so multi-gigabyte files stream.

---

## 3. SCALP — results

**10,322,492 trades** over 4 sessions.

### 3.1 Core trade statistics

| Metric | Value |
|---|---|
| Total trades | 10,322,492 |
| Wins / Losses | 1,972,424 / 8,350,068 |
| Win rate | **19.1%** |
| Gross profit factor | **1.389** |
| Net profit factor (@0.07%) | **0.180** |
| Gross expectancy | **+0.050 R** |
| Net expectancy | **−0.300 R** |
| Final net R | −3,093,049 R |
| Max drawdown | 3,093,049 R (0.2996 R/trade) |
| Per-trade σ | 0.4405 R |
| Sharpe / trade | −0.680 |
| Longest win / loss streak | 44 / 13,520 |
| Exit mix | TIME 9,179,011 (88.9%), TARGET 622,711, STOP 483,457, SESSION_END 37,313 |

Interpretation: the raw edge is real but tiny (**+0.050 R gross**). Cost is **0.35 R** per trade.
The gross edge is ~7× smaller than the cost, so the net result is massively negative. The ~89% TIME
exits confirm a scalp-scale horizon where ±1R is rarely reached before 60 s.

### 3.2 Per session (profit factor by session)

| Day | Trades | Net expectancy | Net PF |
|---|---|---|---|
| 2026-09-28 | 2,485,973 | −0.292 R | 0.166 |
| 2026-09-29 | 2,888,526 | −0.292 R | 0.183 |
| 2026-09-30 | 3,522,999 | −0.303 R | 0.186 |
| 2026-10-01 | 1,424,994 | −0.321 R | 0.182 |

**Positive-session coverage: 0 / 4 = 0.0%.**

### 3.3 UP / DOWN branch performance

| Branch | n | Net expectancy | Win rate |
|---|---|---|---|
| `SCALP_UP_distLo60_lt_0.02` (LONG) | 5,522,582 | −0.311 R | 18.4% |
| `SCALP_DN_distHi60_lt_0.02` (SHORT) | 4,799,910 | −0.287 R | 19.9% |

Both directions are negative; neither branch rescues the other.

### 3.4 Concentration

- **Symbols traded:** 1425 · top-symbol share of |net R| **8.3%** · HHI **0.008** (very diffuse).
- **Hour concentration:** expectancy is essentially flat and negative every hour
  (09h −0.301, 10h −0.297, 11h −0.298, 12h −0.307, 13h −0.301, 14h −0.296, 15h −0.290 R).
- **Tail contribution** (share of gross profit captured by the largest trades):
  top 1% → 9.9%, top 5% → 49.3%, top 10% → **84.3%**. The 10% worst trades account for 31.8% of
  gross loss. There is **no net-profit tail to report** (aggregate net is negative), which is
  itself the finding.

### 3.5 Cost curve (break-even search)

| Round-trip cost | Net expectancy | Net PF | Win rate |
|---|---|---|---|
| 0.00% | **+0.050 R** | 1.389 | 49.2% |
| 0.02% | **−0.050 R** | 0.731 | 38.5% |
| 0.05% | −0.200 R | 0.306 | 25.2% |
| 0.10% | −0.450 R | 0.086 | 13.0% |
| 0.15% | −0.700 R | 0.024 | 7.9% |

**Break-even cost ≈ 0.0101% round-trip.** The mechanism is positive only at costs a fraction of
any realistic NSE round-trip; it crosses zero between 0% and 0.02%.

### 3.6 Dedup sensitivity

Collapsing to one trade per `symbol | 2 s bucket` → **426,527 trades**, net expectancy
**−0.270 R**, net PF **0.258**. Deduplication does **not** rescue the track — it stays solidly
negative, confirming the loss is not an artifact of burst-repeating the same signal.

---

## 4. INTRADAY — results

**1,348,207 trades** over 145 sessions.

### 4.1 Core trade statistics

| Metric | Value |
|---|---|
| Total trades | 1,348,207 |
| Wins / Losses | 660,076 / 688,131 |
| Win rate | **49.0%** |
| Gross profit factor | **1.259** |
| Net profit factor (@0.07%) | **0.547** |
| Gross expectancy | **+0.099 R** |
| Net expectancy | **−0.251 R** |
| Final net R | −338,185 R |
| Max drawdown | 338,187 R (0.2508 R/trade) |
| Per-trade σ | 0.9104 R |
| Sharpe / trade | −0.276 |
| Longest win / loss streak | 49 / 190 |
| Exit mix | TARGET 613,814 (45.5%), STOP 480,432, TIME 228,904, SESSION_END 25,057 |

Interpretation: gross edge **+0.099 R** — about **2× larger** than scalp and genuinely positive
pre-cost — but still far below the 0.35 R cost. Net expectancy **−0.251 R**. The bracket hits more
often (54% of exits are hard target/stop), so the win rate is a normal-looking 49%.

### 4.2 Per session

145 sessions; full per-day table is in the stats JSON (`bySession`). The distribution is almost
uniformly negative:

- Best: 2026-08-12 **+0.081 R** (n=967, PF 1.244), 2026-08-21 +0.060 R, 2026-07-24 +0.056 R,
  2026-06-17 +0.048 R, 2026-07-29 +0.024 R.
- Worst: 2026-04-09 −0.442 R, 2026-09-15 −0.375 R, 2026-04-28 −0.372 R.
- **Positive-session coverage: 9 / 145 = 6.2%.**

The handful of positive days are not concentrated in a regime that could be isolated without
selection; they are scattered across the calendar and are not robust to the cost floor.

### 4.3 UP / DOWN branch performance

| Branch | n | Net expectancy | Win rate |
|---|---|---|---|
| `INTRA_UP_distLo15_lt_0.05` (LONG) | 1,016,028 | −0.287 R | 46.6% |
| `INTRA_DN_distHi15_lt_0.05_imp15_0.2_0.4` (SHORT) | 332,179 | −0.141 R | 56.3% |

The **DOWN** branch is less-bad (−0.141 R, 56% win rate) than **UP** (−0.287 R), but both are
negative. Note the DOWN branch, even though it is the *stronger* discovery branch, is still
negative once the full (non-`cls`-filtered) population and realistic cost are applied.

### 4.4 Concentration

- **Symbols traded:** 1028 · top-symbol share of |net R| **1.3%** · HHI **0.0016** (extremely diffuse).
- **Hour concentration:** 10h −0.278, 11h −0.247, 12h −0.248, 13h −0.281, 14h −0.236,
  15h −0.173 R. Flat and negative; the best hour (15h) is still −0.173 R.
- **Tail contribution:** top 1% → 1.0%, top 5% → 5.2%, top 10% → 10.5% of gross profit;
  the 10% worst trades are 12.4% of gross loss. Again **no positive net tail**.

### 4.5 Cost curve (break-even search)

| Round-trip cost | Net expectancy | Net PF | Win rate |
|---|---|---|---|
| 0.00% | **+0.099 R** | 1.259 | 53.4% |
| 0.02% | **−0.001 R** | 0.998 | 52.2% |
| 0.05% | −0.151 R | 0.700 | 50.1% |
| 0.10% | −0.401 R | 0.366 | 47.5% |
| 0.15% | −0.651 R | 0.149 | 46.0% |

**Break-even cost ≈ 0.0198% round-trip.** Positive only below ~2 bp — not reachable with realistic
NSE costs.

### 4.6 Dedup sensitivity

One trade per `symbol | 15 min bucket` → **21,440 trades**, net expectancy **−0.182 R**,
net PF **0.662**. Still clearly negative; deduplication improves it (removes overlapping repeats of
the same stale signal) but does not turn it positive.

---

## 5. Why the trade-level result is worse than the OF04 gate aggregate

| | Gate aggregate (net R @0.05%) | Trade-level (net R @0.07%) |
|---|---|---|
| SCALP | −0.090 | −0.300 |
| INTRADAY | −0.108 | −0.251 |

Two honest reasons, neither of them a bug:

1. **Population.** The gate aggregate was computed on `cls > 0` events (look-ahead). The trade
   backtest fires on **every** predicate match, which is the only tradeable set and is weaker.
2. **Execution model.** The gate used unscaled forward returns; the trade model applies a ±1R
   bracket with **stop-first** conservatism, TIME exits, and the 0.02% slippage point. This is a
   strictly more realistic (and lower) accounting.

The direction of the discrepancy is expected and confirms the gate's conclusion rather than
overturning it.

---

## 6. Verdicts

### 6.1 SCALP verdict

**REJECT.** Net expectancy **−0.300 R** over 10.3 M trades; net PF **0.180**; 0/4 positive
sessions; negative in both directions and at every hour; still −0.270 R after deduplication.

**Exact reason:** the mechanism has a real but tiny gross edge (**+0.050 R**) that is roughly
**7× smaller than the 0.35 R transaction cost**. Break-even cost is **≈ 0.0101% round-trip** —
below any realistic NSE execution cost. It is not a threshold problem, not a direction problem, and
not a burst-dedup artifact; the edge is simply too small for the friction.

### 6.2 INTRADAY verdict

**REJECT.** Net expectancy **−0.251 R** over 1.35 M trades across **145 sessions**; net PF **0.547**;
only **9/145 (6.2%)** positive sessions; both branches negative; still −0.182 R after
deduplication.

**Exact reason:** the gross edge (**+0.099 R**) is about 2× the scalp edge and genuinely positive
pre-cost — this is the more promising of the two tracks — but it is still only **~28% of the
0.35 R cost**. Break-even cost is **≈ 0.0198% round-trip**, and the strategy turns negative between
0.02% and 0.05% cost. Under the framework's own 0.07% assumption it loses 0.251 R per trade.

### 6.3 Is either tradeable / worth pursuing?

**No, neither is tradeable at realistic cost.** The full trade-level corpus confirms the OF04
machine-gate verdict: both tracks are **gross-positive but net-negative** — they die on
transaction cost, not on signal direction. Both cross zero only below ~2 bp round-trip, which no
realistic NSE execution achieves.

This is **not** validation of anything. Because the result is **negative**, it is recorded as a
clean scientific rejection. Even had it been positive, it would have been reported as an
**unvalidated in-sample candidate**, not a validated strategy — no walk-forward, no out-of-sample
holdout, and no live-execution modelling beyond cost+slippage has been performed.

---

## 7. Limitations (stated, not hidden)

1. **In-sample.** 145 intraday sessions and 4 scalp days are historical; no out-of-sample holdout.
2. **Scalp history is thin.** Only 4 sessions of tick tape exist — the scalp verdict rests on
   ~10.3 M trades but only 4 distinct days; it is a strong within-window result, not a long-run one.
3. **Data-density drift.** Intraday daily trade counts jump from ~600/day (spring) to ~60k/day
   (September) because 1-minute coverage across the 1028-symbol corpus thickens over time; per-session
   PF should be read with that in mind.
4. **Bar-level intraday exits.** Inside a 1-minute bar the intrabar path is unknown; the
   stop-first rule is deliberately conservative but cannot reconstruct true sequencing.
5. **Cost model.** A flat 0.05% cost + 0.02% slippage on every trade; real slippage varies with
   liquidity, size and volatility and is not modelled per symbol.
6. **Dedup is approximate** (fixed time buckets), not a true one-position-per-symbol-at-a-time
   serialisation.

These limitations make the result **more** likely to be optimistic, not less. The rejection stands.

---

*Generated from [research/of04TradeBacktest.js](research/of04TradeBacktest.js); raw trades and
stats JSON listed in §2. Thresholds unchanged; production and OF01/OF03 untouched.*
