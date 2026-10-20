# GB03a: Technical Specification & Mathematical Blueprint

## 1. Concept: Failed Aggression at Range Extremes (OF03)

In institutional order flow, high volume that fails to produce proportional price travel indicates aggressive orders being absorbed by larger passive limit orders. When this occurs at a marginal new high, aggressive buyers become trapped at the top of the range.

### Mathematical Identification of Exhaustion:
1. **Marginal New Extreme**:
   $$\text{Bar High} > \max(\text{Previous } 20 \text{ Bar Highs})$$
   $$\text{Excess} = \text{Bar High} - \text{Previous Extreme} \le 0.20 \times \text{ATR}_{14}$$
   *Rationale*: If the breakout exceeds $0.20\text{ ATR}$, it is an impulsive trend runaway, not an exhaustion.
2. **Aggressive Volume Surge**:
   $$\text{Volume} \ge 1.70 \times \text{Average 20-bar Volume}$$
   *Rationale*: Confirms that substantial market order volume was absorbed at the level.
3. **Rejection Close Location**:
   $$\text{Close Location} = \frac{\text{Close} - \text{Low}}{\text{High} - \text{Low}} \le 0.35$$
   *Rationale*: The candle must close in the bottom $35\%$ of its total range, proving buyer capitulation.

---

## 2. Invalidation & Gating Architecture

1. **Short-Only Enforcement**:
   - The strategy disarms long bounce setups because breaking multi-bar lows in Indian equities triggers liquidation cascades rather than clean bounces.
   - Shorting failed highs (`RS`) generates $+108.8\text{R}$ with high profit factors.
2. **POC Buffer Gate**:
   - Point of Control (highest volume price level of the session) must NOT be resting within 25 bps below entry (to avoid selling directly into high-volume support).
3. **VWAP Position**:
   - $\text{Entry Price} \le \text{VWAP}$ or within 50 bps of VWAP.
4. **Time-of-Day Window**:
   - Active: `09:20 AM to 12:30 PM IST`.
   - Entry blocked after `12:30 IST` because afternoon reversals carry high chop and low edge.

---

## 3. Execution & Risk Parameters

- **Entry**: Next 1-minute Open after signal confirmation.
- **Stop Loss**: Bar High + 1 tick.
- **Target 1**: Opposing structural low or VWAP ($1:1.50\text{R}$).
- **Stop-to-Fill Tie**: Conservatively assumed stopped out if both limits touched within the same candle.
- **Hold Cap**: Maximum 90 bars (90 minutes) or session close at 15:15 IST.
