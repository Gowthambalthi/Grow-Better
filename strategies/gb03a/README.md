# GB03a: Institutional Order Flow Exhaustion Reversal (Short-Only)

## 📌 Overview
**GB03a** is an institutional order flow strategy designed to fade failed buyer aggression at marginal new intraday highs. When high volume is committed to breaking out above a recent extreme but price closes back down inside the range (inability to accept higher prices), GB03a enters a short position to capture the liquidity vacuum back towards VWAP.

Following empirical quantitative reviews, **GB03a is strictly enforced as SHORT-ONLY** because fading resistance at highs has an established positive edge, whereas catching falling knives at lows lacks statistical edge.

---

## 📁 Package Directory Contents

| File | Description |
| :--- | :--- |
| [`index.js`](./index.js) | Core GB03a strategy implementation module |
| [`GB03a_SPECIFICATION.md`](./GB03a_SPECIFICATION.md) | Technical blueprint (formulas, exhaustion criteria, invalidation rules) |
| [`GB03a_EDGE_REVIEW.md`](./GB03a_EDGE_REVIEW.md) | Formal quantitative audit, bootstrap confidence intervals, and Long vs Short analysis |
| [`GB03a_ORDERFLOW_MECHANICS.md`](./GB03a_ORDERFLOW_MECHANICS.md) | In-depth mechanics of volume surge, delta ratios, and book imbalance |

---

## 📊 Performance Benchmark (Canonical Corpus & Backtests)

| Metric | Short Side (`RS` / OF03 Short) | Long Side (Disarmed) |
| :--- | :--- | :--- |
| **Gross Profit Factor** | **1.390 to 1.750** | 0.824 (Losing) |
| **Net Expectancy** | **$+0.2235\text{R}$ to $+0.440\text{R}$** | Negative |
| **Win Rate** | **42.5% to 52.4%** | ~31.0% |
| **Max Drawdown** | **12.5 R (Shallow)** | 76.0 R (Severe) |
| **Execution Window** | **09:25 AM to 12:30 PM IST** | Disarmed |

---

## 🛠️ How to Run Backtest

```powershell
# 50 symbols, 10 sessions
node backtest/runAll.js --module=strategies/gb03a/index.js --key=GB03a --symbols=50 --days=10

# 100 symbols, 30 sessions
node backtest/runAll.js --module=strategies/gb03a/index.js --key=GB03a --symbols=100 --days=30
```

---

## ⚙️ Key Configuration Defaults

```javascript
{
  of03MinVolRatio: 1.7,        // Volume surge >= 1.7x average volume
  of03MaxNewExtremeAtr: 0.20,  // Marginal break <= 0.20 ATR (not a runaway trend)
  of03MaxCloseLoc: 0.35,       // Closed in lower 35% of the candle range
  cooldownBars: 10,            // 10-bar symbol cooldown
  maxSignalsPerDay: 3,         // Max 3 signals per day per symbol
  maxSignalTime: 1230,         // Hard cutoff at 12:30 IST (morning exhaustion only)
  shortOnly: true              // Strictly enforced SHORT-only
}
```

---

## 💰 Position Sizing & Live Paper Trading
$$\text{Shares} = \left\lfloor \frac{X}{|\text{Entry} - \text{Stop Loss}|} \right\rfloor \quad (X = ₹1{,}000)$$
Every short trade risks exactly ₹1,000 with target anchored to opposing swing liquidity or VWAP.
