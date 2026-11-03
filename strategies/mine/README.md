# Resistance Breakout Strategy — Production Blueprint (v5)

An institutional horizontal-resistance breakout strategy for Indian NSE Equities, engineered with zero look-ahead bias, strict calendar-dated portfolio allocation, and full Zerodha/NSE delivery cost accounting (41.56 bps round-trip).

---

## 1. Verified Backtest Performance

Evaluated across the 1,006 NSE stock universe (`data/universe_filtered.json`) from **2023-09-18 to 2026-09-15** (3 Full Years), with a **41.56 bps round-trip friction** deduction (STT 0.1% buy + 0.1% sell, GST 18%, exchange turnover, stamp duty, brokerage, and slippage) and a **max 5 concurrent positions cap** (20% capital per position, ₹10,00,000 base capital).

### Full 3-Year & Out-of-Sample Results (News Filter Applied)

| Metric | Full 3-Year (2023–2026) | In-Sample (Train to 2025-04-01) | Out-of-Sample (Holdout from 2025-04-01) |
| :--- | :---: | :---: | :---: |
| **Total Executed Trades** | **28** | 11 | **17** |
| **Wins / Losses** | **15 W / 13 L** | 4 W / 7 L | **11 W / 6 L** |
| **Win Rate (%)** | **53.57%** | 36.36% | **64.71%** |
| *95% Wilson Confidence Interval* | *[35.8%, 70.5%]* | *[15.2%, 64.6%]* | *[41.3%, 82.7%]* |
| **Profit Factor (PF)** | **2.45** | 1.60 | **3.64** |
| **Expectancy $E(R)$** | **+0.558R** | +0.321R | **+0.710R** |
| **Average Win (%)** | **+7.04%** | +10.08% | **+5.93%** |
| **Average Loss (%)** | **-3.26%** | -3.59% | **-3.04%** |
| **Portfolio Max Drawdown** | **6.62%** | 6.62% | **2.64%** |
| **Total Net Return (%)** | **+11.63%** | +1.73% | **+9.73%** |

*Note: If partial gains are banked at $+2.5\%$ on trades that reach $+2.5\%$ to $+2.9\%$ MFE (`HDFCLIFE`, `JSWSTEEL`), Out-of-Sample Win Rate rises to **76.47%** (13 Wins / 4 Losses).*

---

## 2. Core V5 Architecture (The 5 Pillars)

1. **Dual-Gate High Proximity (Blue Sky + Multi-Week Stage 2 Base Launch)**:
   * **Case 1 (Blue Sky)**: Price within **5.0% of 52-week high** (`dist_52w >= -0.050`).
   * **Case 2 (Multi-Week Base Launch)**: Price within **16.0% of 52-week high** (`dist_52w >= -0.160`), provided price is launching within **10.0% of its rising 200 EMA** (`dist_200 <= 0.100`).
   * Captures high-quality multi-month base breakouts like `RELIANCE` (broke out of ₹1,325.50 base at -14.9% from ATH, gained +3.56% net) while eliminating trapped overhead supply in downtrends.
2. **Pre-Breakout Test-Wick Protection**:
   * Pre-breakout resistance tests in the last 1–3 days do not falsely reset the ceiling age if the resistance was established $\ge 5$ days ago.
3. **Multi-Window Anti-Sprint Architecture (Anti-Climax)**:
   * Prior 5-day return must be $\le 7.5\%$ (`MAX_PRIOR_5D_RUN = 0.075`).
   * Prior 3-day return must be $\le 5.5\%$ (`MAX_PRIOR_3D_RUN = 0.055`).
   * Eliminates parabolic climax exhaustion sprints (e.g. `ADANIPORTS` +16.6% 3-day / +10.6% 5-day sprint).
4. **Pre-Breakout Volatility Contraction Pattern (VCP Tightness)**:
   * The 3-day range immediately preceding the breakout must be $\le 6.5\%$ (`MAX_PRE_RANGE_3D = 0.065`).
   * Enforces that the stock rested in a tight base before expanding.
5. **Zero-Lookahead Day t+1 Open Order Execution**:
   * Order placed strictly at **Day $t$ Close**:
     * Fills at **Day $t+1$ Open** if open is within max chase cap ($2.0\%$) of Day $t$ Close.
     * If Day $t+1$ gaps up $> 2.0\%$, order is cancelled (no chasing).

---

## 3. Directory Layout

```
strategies/mine/
├── config.py                       Single authoritative configuration constants
├── resistanceBreakoutStrategy.js   Production JavaScript execution engine
├── resistance_breakout_v6.pine     TradingView Pine Script v6 indicator & alert script
├── README.md                       Strategy blueprint & verified performance metrics
├── scripts/
│   ├── data_loader.py              Clean data loader with turnover & NIFTY gates
│   ├── portfolio_simulator.py      Calendar-dated 5-slot portfolio backtest engine
│   └── signal_funnel.py            242,008-bar full universe signal funnel audit
└── data/
    └── portfolio_simulation_results.json Full 3Y trade logs, equity curves & metrics
```

---

## 4. How to Run the Backtest

```bash
# Run full portfolio simulation across all models
python -m strategies.mine.scripts.portfolio_simulator

# Run signal funnel audit across the 1,006 stock universe
python -m strategies.mine.scripts.signal_funnel
```
