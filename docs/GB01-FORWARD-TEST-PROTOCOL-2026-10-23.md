# GB01 Pre-Registered Forward-Testing Protocol

**Date Sealed:** 2026-10-23  
**Status:** ACTIVE / SEALED — IMMUTABLE PRE-REGISTRATION  
**Repository:** `openalgo`  

---

## 1. Pre-Registered Decision Rule

This document defines the immutable decision protocol for evaluating **GB01 (Fresh 5-Minute Fair Value Gap Retest)** on uncollected live market data. No parameters, thresholds, or decision boundaries may be modified after data collection begins.

### Rule Under Test (Frozen Production Configuration)
- **Engine:** `strategies/fvg/index.js` (Setup `FG01`)
- **Imbalance Threshold (`minGapPct`):** $\ge 0.10\%$
- **Zone Age Window (`minZoneAgeBars` to `maxZoneAgeBars`):** $1$ to $180$ 1-minute bars
- **Retest Policy:** One-shot first return only; far zone edge must not be broken/filled
- **Rejection Wick Ratio (`wickRatio`):** $\ge 0.35$ (35% of candle range on rejection side)
- **Multi-Timeframe Trend (`confirmMtfTrend`):** 15-minute candle must not explicitly oppose the direction
- **VWAP Directional Alignment:** $\text{Price} > \text{VWAP}$ for LONG; $\text{Price} < \text{VWAP}$ for SHORT
- **Volume Ratio (`minVolRatio`):** $\ge 1.0\times$ 20-bar SMA; $\ge 1.5\times$ after 14:00 IST
- **Entry Window Cutoff (`maxEntryMinute`):** 14:45 IST (09:20 to 14:45 IST)
- **Volatility Regime Floor (`minAtrPct`):** $\ge 0.60\%$
- **Overextension Ceilings:** `maxRangePosPct` $\le 92\%$, `maxVwapDistPct` $\le 2.50\%$
- **Structural Invalidation (Stop):** Beyond zone distal edge $+ 0.05\%$ buffer; clamped between $0.15\%$ and $1.50\%$
- **Risk-to-Reward Floor (`minRR1`):** $\ge 1.20\text{R}$
- **Execution Fill:** Next 1-minute bar OPEN (realistic next available price)
- **Friction Accounting:** $0.05\%$ round-trip deducted from R on every trade
- **Config Hash:** Recorded on every candidate log row

---

## 2. Primary Metric & Fixed Decision Checkpoints

- **Primary Metric:** **Mean Net R per trade** (after $0.05\%$ round-trip friction).
  *(Net Profit Factor is reported for telemetry but does NOT decide strategy continuation or retirement).*

### Checkpoint 1 (at exactly 100 executed trades)
Compute a one-sided $95\%$ lower bound on mean Net R using the trade-level bootstrap ($10,000$ iterations).
- **Lower Bound $> +0.20\text{ R}$:** **PROMISING**. Continue forward test to Checkpoint 2.
- **Upper Bound $< +0.10\text{ R}$:** **RETIRE**. Strategy is formally decommissioned.
- **Otherwise:** **INCONCLUSIVE**. Continue forward test to Checkpoint 2.

### Checkpoint 2 (at exactly 200 executed trades)
Compute the same one-sided $95\%$ bootstrap test.
- **Lower Bound $> +0.10\text{ R}$:** **ACCEPT AS A WORKING EDGE**, subject to the Mandatory Cost Check below.
- **Upper Bound $< +0.10\text{ R}$:** **RETIRE**.
- **Otherwise:** **RETIRE AS UNPROVEN**.

### Session Cap (250 Trading Sessions)
If the trade count has not reached $200$ trades within **250 trading sessions** (~1 calendar year):
- The rule is **RETIRED as too sparse to validate**. A rule that cannot produce sufficient trades to confirm edge is untradeable as an active strategy.

### Mandatory Cost Check (Required Before Final Acceptance)
Re-score all trades at **$0.15\%$ round-trip friction** (stress-testing against severe slippage and STT).
- If the bootstrap lower bound drops below $+0.10\text{ R}$ at $0.15\%$ friction, the edge is deemed too thin to survive live execution and the strategy is **RETIRED**.

### Secondary Metrics (Reported, Non-Decisional)
- Session-clustered bootstrap $95\%$ confidence interval
- Win rate (%) and Stop-out rate (%)
- Maximum drawdown in R
- Gate failure distribution counts from the candidate log

---

## 3. Power Analysis & Sample Size Calibration

Based on empirical trade standard deviation $\sigma \approx 1.70\text{ R}$, one-sided $\alpha = 0.05$, and statistical power $80\%$:

| Hypothesized True Mean R | Trades Required for 80% Power | Sessions at 0.50 trades/day | Sessions at 0.15 trades/day |
| :---: | :---: | :---: | :---: |
| **0.45 R** | **~90 trades** | ~180 sessions | ~600 sessions |
| **0.30 R** | **~200 trades** | ~400 sessions | ~1,330 sessions |
| **0.20 R** | **~450 trades** | ~900 sessions | Exceeds 250-session cap |
| **0.10 R** | **~1,800 trades** | Exceeds cap | Exceeds 250-session cap |

*Note: The real-world signal rate measured over the first 30 sessions will calibrate which sample size trajectory applies.*

---

## 4. Structured Logging Schema

Logs are stored in an append-only file: `data/orderflow/forward_audit_2026.jsonl`.  
Never edit, truncate, or rewrite rows. A `config_hash` change mid-test permanently invalidates and resets the sample.

### Candidate Row Schema (One row per FVG retest evaluated, including rejected candidates):
```json
{
  "type": "CANDIDATE",
  "ts": 1729671600000,
  "session_date": "2026-10-23",
  "symbol": "RELIANCE",
  "config_hash": "a1b2c3d4e5f6...",
  "fvg_id": "FVG-RELIANCE-2026-10-23-5m-2745.50",
  "c1_ts": "2026-10-23 09:20",
  "c3_ts": "2026-10-23 09:30",
  "zone_low": 2745.50,
  "zone_high": 2749.80,
  "gap_pct": 0.156,
  "age_bars": 12,
  "retest_ts": "2026-10-23 09:42",
  "wick_ratio": 0.42,
  "atr_pct": 0.68,
  "vwap_side": "ABOVE",
  "mtf15_ok": true,
  "volume_ratio": 1.35,
  "range_pos": 48.2,
  "vwap_dist_pct": 0.35,
  "rr": 1.45,
  "stop_width_pct": 0.28,
  "stop_price": 2744.10,
  "target_price": 2755.20,
  "gate_failed": "PASS",
  "signal_ts": "2026-10-23 09:43",
  "fill_price": 2748.20,
  "exit_ts": "2026-10-23 10:15",
  "exit_reason": "T1",
  "r_multiple": 1.45,
  "cost_r": 0.18
}
```

### Heartbeat Row Schema (One row per trading session):
```json
{
  "type": "HEARTBEAT",
  "session_date": "2026-10-23",
  "symbols_expected": 494,
  "symbols_with_complete_bars": 492,
  "bars_missing": 14,
  "candidates_logged": 18
}
```

---

## 5. Execution Phasing

1. **Phase 1 (First 30 Sessions):** Measure the true live signal rate across the expanded universe. Do not judge or alter strategy logic.
2. **Phase 2 (Sessions 31 to 250):** Execute the pre-registered decision rules at Checkpoint 1 (100 trades) and Checkpoint 2 (200 trades).
