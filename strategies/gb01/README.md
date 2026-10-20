# GB01: 5-Minute Fair Value Gap (FVG) Retest Strategy

## 📌 Overview
**GB01** is an institutional-grade price action strategy designed to exploit displacement imbalances (Fair Value Gaps) formed on 5-minute candles, confirmed by higher-timeframe (15-minute) trend alignment and VWAP positioning.

The strategy waits for price to return cleanly into the imbalance zone (a "first return" retest) and enters on a confirmed rejection wick, placing an invalidation stop beyond the far edge of the gap.

---

## 📁 Package Directory Contents

| File | Description |
| :--- | :--- |
| [`index.js`](./index.js) | Core GB01 strategy implementation module |
| [`liveAdapter.js`](./liveAdapter.js) | Live tick and 1-minute streaming feed adapter |
| [`GB01_SPECIFICATION.md`](./GB01_SPECIFICATION.md) | Full technical and mathematical blueprint (rules, formulas, gates) |
| [`GB01_BACKTEST_AUDIT.md`](./GB01_BACKTEST_AUDIT.md) | 14-month canonical backtest verification (100 stocks, 705 sessions) |
| [`GB01_DAY_CONTEXT_RESEARCH.md`](./GB01_DAY_CONTEXT_RESEARCH.md) | Quantitative study on day-context filtering and 1.5R target hit rates |

---

## 📊 Performance Benchmark (705 Sessions / 100 Liquid NSE Stocks)

| Metric | Measured Value | Notes |
| :--- | :--- | :--- |
| **Expectancy per Trade** | **$+0.6971\text{R}$** | Net of 5 bps transaction costs |
| **Win Rate** | **42.0%** | Target RR is $1:1.60\text{ to }1:2.0\text{R}$ |
| **Net Profit Factor (PF)** | **2.202** | Highly robust against slippage |
| **Total Net R** | **$+48.1\text{R}$** | Across canonical sample |
| **Base Frequency** | **~1 call / 1,022 symbol-days** | ~0.5 to 0.7 calls/day across 500 stocks |

---

## 🛠️ How to Run Backtest

```powershell
# Quick sanity check (5 symbols, 5 days)
node backtest/runAll.js --module=strategies/gb01/index.js --key=GB01 --symbols=5 --days=5

# 50 symbols, 10 sessions
node backtest/runAll.js --module=strategies/gb01/index.js --key=GB01 --symbols=50 --days=10

# Full corpus run (100 symbols, 30 days)
node backtest/runAll.js --module=strategies/gb01/index.js --key=GB01 --symbols=100 --days=30
```

---

## ⚙️ Key Configuration Defaults

```javascript
{
  minGapPct: 0.10,             // Minimum gap width (0.10%)
  maxZoneAgeBars: 180,         // Zone expires after 180 minutes
  wickRatio: 0.35,             // Rejection wick >= 35% of bar range
  minVolRatio: 1.0,            // Retest volume >= 1.0x average volume
  cooldownBars: 10,            // 10-bar cooldown between trades on same stock
  maxSignalsPerDay: 4,         // Max 4 signals per day per symbol
  confirmMtfTrend: true,       // 15m trend & VWAP alignment required
  maxEntryMinute: 885,         // 14:45 IST cutoff
  powerHourVolRatio: 1.5       // >= 1.5x volume after 14:00 IST
}
```

---

## 💰 Position Sizing & Live Paper Trading
Live orders are sized to maintain a fixed 1R risk:
$$\text{Shares} = \left\lfloor \frac{X}{|\text{Entry} - \text{Stop Loss}|} \right\rfloor \quad (X = ₹1{,}000)$$
A full loss is capped at ₹1,000; a target hit delivers ₹1,600 to ₹2,000.
