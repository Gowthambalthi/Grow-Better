# Trio Pattern Breakout Strategy (Engine 1 - v7)

> **Flagship Institutional Pattern Engine for NSE Equities**  
> Covers **Cup & Handle + RSI**, **Inverse Head & Shoulders + RSI**, and **Rectangle Breakout + RSI** across the full 1,006 liquid NSE universe with realistic Indian delivery friction (**0.28% round-trip**).

---

## 1. Executive Summary

- **Core Patterns**:
  1. **Cup & Handle + RSI**: 25–90 bar rounded accumulation base, shallow handle ($\le 45\%$ of cup depth), breakout above rim.
  2. **Inverse Head & Shoulders + RSI**: Capitulation head, symmetrical shoulders ($\pm 6\%$), breakout above neckline.
  3. **Rectangle Consolidation + RSI**: 30-bar tight base (height $\le 14\%$) with breakout above ceiling.
- **RSI Confluence**: RSI 14 strictly between **48 and 75** (healthy momentum initiation, rejecting exhaustion wicks $> 75$).
- **Relative Strength**: Stock 60-day return must outperform NIFTY 50 by $\ge 15\%$.
- **Structural Stops**: Stop placed at the **Handle Low** (Cup & Handle), **Right Shoulder Low** (Inverse H&S), or **Box Floor** (Rectangle), bounded between 2.5% and 7.5%.
- **Exit Architecture**:
  - **Tranche 1**: 50% profit booked at **+8.0%**.
  - **Breakeven Ratchet**: Stop immediately moved to Entry + 0.2% upon hitting +1.2R.
  - **Tranche 2 Runner**: Remaining 50% trailed via **20 EMA**.

---

## 2. Quantitative Performance Across 997 NSE Stocks (3 Years)

| Metric | Overall (3 Years) | In-Sample (< Apr 2025) | Out-of-Sample (>= Apr 2025) |
| :--- | :--- | :--- | :--- |
| **Total Trades** | 2,287 (or 552 at RS $\ge 25\%$) | 788 | 1,499 |
| **Win Rate** | **40.0% – 44.5%** | 34.6% | **42.8%** |
| **Profit Factor (Net)** | **0.95 – 1.03** | 0.74 | **1.09 – 1.15** |
| **Average Winner** | **+10.14%** | +10.12% | **+10.15%** |
| **Average Loser** | **-7.01%** | -7.25% | **-6.87%** |
| **Median Duration** | **7.0 days to Target** | 7.0 days | 7.0 days |

---

## 3. Pattern Performance Breakdown

| Pattern | Trades | Win Rate | Profit Factor | Characteristic |
| :--- | :--- | :--- | :--- | :--- |
| **Rectangle Breakout** | 458 | **44.5%** | **1.03** | Highest base win rate; clean floor support |
| **Inverse Head & Shoulders** | 1,095 | **39.8%** | **0.97** | Largest runner gains (+19% to +26%) |
| **Cup & Handle** | 734 | **37.5%** | **0.88** | Quickest to target; 40.5% hit target in Week 1 |

---

## 4. File Architecture

- [`config.py`](config.py): Single authoritative configuration parameters.
- [`resistanceBreakoutStrategy.js`](resistanceBreakoutStrategy.js): High-speed JavaScript engine implementation.
- [`resistance_breakout_v6.pine`](resistance_breakout_v6.pine): TradingView Pine Script v6 indicator with visual stops and targets.
- [`scripts/portfolio_simulator.py`](scripts/portfolio_simulator.py): Zero-lookahead dated daily portfolio simulator.
- [`data/portfolio_simulation_results.json`](data/portfolio_simulation_results.json): Full dated trade logs.
