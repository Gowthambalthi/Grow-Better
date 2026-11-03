# Core 4-Pattern Breakout Strategy (Engine 1 - v7)

> **Flagship Institutional Pattern Engine for NSE Equities**  
> Covers **Cup & Handle + RSI**, **Inverse Head & Shoulders + RSI**, **Rectangle Breakout + RSI**, and **Ascending Triangle + RSI** across the full 1,006 liquid NSE universe with realistic Indian delivery friction (**0.28% round-trip**).

---

## 1. Executive Summary

- **Core Patterns**:
  1. **Cup & Handle + RSI**: 25–90 bar rounded accumulation base, shallow handle ($\le 45\%$ of cup depth), breakout above rim.
  2. **Inverse Head & Shoulders + RSI**: Capitulation head, symmetrical shoulders ($\pm 6\%$), breakout above neckline.
  3. **Rectangle Consolidation + RSI**: 30-bar tight base (height $\le 14\%$) with breakout above ceiling.
  4. **Ascending Triangle + RSI**: Flat upper resistance ($\ge 2$ tests within 2%) with rising higher swing lows, breakout above resistance.
- **RSI Confluence**: RSI 14 strictly between **48 and 75** (healthy momentum initiation, rejecting exhaustion wicks $> 75$).
- **Relative Strength**: Stock 60-day return must outperform NIFTY 50 by $\ge 15\%$.
- **Structural Stops**: Stop placed at the **Handle Low** (Cup & Handle), **Right Shoulder Low** (Inverse H&S), **Box Floor** (Rectangle), or **Rising Swing Low** (Ascending Triangle), bounded between 2.5% and 7.5%.
- **Exit Architecture**:
  - **Tranche 1**: 50% profit booked at **+8.0%**.
  - **Breakeven Ratchet**: Stop immediately moved to Entry + 0.2% upon hitting +1.2R.
  - **Tranche 2 Runner**: Remaining 50% trailed via **20 EMA**.

---

## 2. Quantitative Performance Across Liquid NSE Universe (3-Year Zero-Lookahead Simulation)

| Metric | Overall Portfolio (3 Years) | In-Sample (< Apr 2025) | Out-of-Sample (>= Apr 2025) |
| :--- | :--- | :--- | :--- |
| **Total Portfolio Trades** | **603 trades (4.02 calls/week)** | 271 trades | **332 trades** |
| **Win Rate** | **52.6%** | 50.9% | **53.9%** |
| **Profit Factor (Net)** | **1.08** | 0.91 | **1.34** |
| **Net Realized R** | **+25.3R** | +2.1R | **+23.2R** |
| **Average Winner Return** | **+7.78%** | +7.62% | **+7.91%** |
| **Average Loser Return** | **-7.92%** | -8.11% | **-7.76%** |
| **Execution Sizing** | **20 Concurrent Slots (5% allocation each)** | 20 Slots | 20 Slots |

---

## 3. Pattern Characteristics

| Pattern | Win Rate | Profit Factor | Key Characteristic |
| :--- | :--- | :--- | :--- |
| **Ascending Triangle** | **42.8%** | **1.01** | High continuation probability; rising demand floor |
| **Rectangle Breakout** | **44.5%** | **1.03** | Highest base win rate; clean floor support |
| **Inverse Head & Shoulders** | **39.8%** | **0.97** | Largest individual runner gains (+19% to +26%) |
| **Cup & Handle** | **37.5%** | **0.88** | Quickest to target; 40.5% hit target in Week 1 |

---

## 4. File Architecture

- [`config.py`](config.py): Single authoritative configuration parameters.
- [`resistanceBreakoutStrategy.js`](resistanceBreakoutStrategy.js): High-speed JavaScript engine implementation.
- [`resistance_breakout_v6.pine`](resistance_breakout_v6.pine): TradingView Pine Script v6 indicator with visual stops and targets.
- [`scripts/portfolio_simulator.py`](scripts/portfolio_simulator.py): Zero-lookahead dated daily portfolio simulator.
- [`data/portfolio_simulation_results.json`](data/portfolio_simulation_results.json): Full dated trade logs.
