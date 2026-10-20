# GB01: Technical Specification & Mathematical Blueprint

## 1. Concept: 3-Candle Displacement Imbalance

A **Fair Value Gap (FVG)** represents an institutional liquidity void created by rapid price displacement where aggressive buyers or sellers outpace resting limit orders.

### 5-Minute Candle Bucketing
1-minute candles are aggregated strictly on the clock (`09:15-09:20`, `09:20-09:25`, etc.):
- **Bullish Gap (Demand Zone)**:
  $$c_1.\text{high} < c_3.\text{low}$$
  $$\text{Zone} = [c_1.\text{high}, c_3.\text{low}]$$
- **Bearish Gap (Supply Zone)**:
  $$c_3.\text{high} < c_1.\text{low}$$
  $$\text{Zone} = [c_3.\text{high}, c_1.\text{low}]$$

### Gap Width Gate
The gap width as a percentage of entry price must exceed:
$$\frac{|\text{Zone High} - \text{Zone Low}|}{\text{Entry}} \ge \text{minGapPct} \quad (0.10\%)$$
Narrower gaps are considered normal bid-ask spread friction and are discarded.

---

## 2. Retest & Entry Conditions

1. **First Return (One-Shot Rule)**:
   - A gap is only tradeable on its **first visit**.
   - The first candle that trades into the zone consumes the zone. Subsequent re-visits are ignored.
2. **Rejection Wick Floor**:
   - For **LONG**: Bar trades into zone ($\text{low} \le \text{zone.high}$) and closes back above far edge ($\text{close} > \text{zone.low}$).
   - The lower rejection wick must represent at least $35\%$ of the total bar range:
     $$\frac{\min(\text{open}, \text{close}) - \text{low}}{\text{high} - \text{low}} \ge 0.35$$
   - For **SHORT**: Mirror condition on upper rejection wick $\ge 35\%$.
3. **Volume Participation**:
   - Retest candle volume must satisfy:
     $$\text{Volume} \ge 1.0 \times \text{Average 20-bar Volume}$$
   - During Power Hour ($> 14:00\text{ IST}$), requires $\ge 1.5\times$ surge.

---

## 3. Directional Alignment & Filters

1. **Higher Timeframe (15m MTF) Trend**:
   - Evaluated on closed 15m candles:
     - Long requires: $c_{15}.\text{close} > c_{15}.\text{open}$ AND $c_{15}.\text{close} > c_{15-prev}.\text{close}$.
     - Short requires: $c_{15}.\text{close} < c_{15}.\text{open}$ AND $c_{15}.\text{close} < c_{15-prev}.\text{close}$.
2. **VWAP Side**:
   - Long entries must be strictly above Volume Weighted Average Price ($\text{LTP} \ge \text{VWAP}$).
   - Short entries must be strictly below VWAP ($\text{LTP} \le \text{VWAP}$).
3. **Time Boundary**:
   - Earliest signal: `09:20 IST` (after opening 5m candle forms).
   - Latest entry: `14:45 IST` (no entries during the final 45 minutes of the session).

---

## 4. Trade Planning & Execution Geometry

- **Entry**: Next 1-minute candle Open (Zero look-ahead).
- **Stop Loss**: Set immediately beyond the far edge of the FVG zone plus 1 tick buffer.
- **Target 1**: Set at opposing structural swing high/low or measured-move $1.5\text{R}$.
- **Risk-Reward Minimum**: $\text{RR} \ge 1:1.50$.
- **Session Settlement**: Any open trade is closed automatically at `15:15 IST` (MIS intraday square-off).
