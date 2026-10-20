# GB03a: Order Flow Mechanics, Delta & Order Book Absorption

## 1. Tick Stream & aggressor Classification

Angel One SmartAPI provides Best-5 market depth (resting limit orders) but does NOT provide an executed trade aggressor flag (buy vs. sell). 

To deduce true aggressor flow in real-time, the GB03a system uses the Lee-Ready algorithm coupled with Level-1 oriented book state (`strategies/orderflow/tickCapture.js`):

### The Matching Rule:
1. **L1 Ask Lifted**: If tick price $P \ge \text{Best Ask}$, the trade is classified as **Aggressive Buyer**.
2. **L1 Bid Hit**: If tick price $P \le \text{Best Bid}$, the trade is classified as **Aggressive Seller**.
3. **Inside Spread Tick Rule**: If $\text{Best Bid} < P < \text{Best Ask}$, the trade falls back to the tick rule:
   - $P > P_{\text{prev}} \implies \text{Aggressive Buyer}$
   - $P < P_{\text{prev}} \implies \text{Aggressive Seller}$

---

## 2. Order Flow Delta & Delta Ratio

Cumulative Volume Delta (CVD) measures the net difference between aggressive buying and aggressive selling volume for each candle:
$$\Delta = \text{Buy Volume} - \text{Sell Volume}$$
$$\text{Delta Ratio} = \frac{\Delta}{\text{Total Volume}}$$

### Exhaustion Divergence Signature:
- When price breaks to a new intraday high on elevated total volume, but Delta Ratio diverges negatively ($\text{Delta Ratio} < -0.05$ or drops sharply relative to prior candles), it confirms **passive absorption** by institutional sellers.
- The buyers' market orders were absorbed by hidden limit sell orders, preceding an immediate mean-reversion drop.

---

## 3. Order Book Depth & Wall Detection

Level-2 depth (Snap Quote mode) records the top 5 bids and asks:
- **Ask Wall Ratio**:
  $$\text{Ask Wall Ratio} = \frac{\text{Ask Quantity at Top Level}}{\text{Median Level Quantity}}$$
- **Bid Wall Ratio**:
  $$\text{Bid Wall Ratio} = \frac{\text{Bid Quantity at Top Level}}{\text{Median Level Quantity}}$$

A Short entry requires that there is NO large resting Bid Wall directly underneath the current price ($\text{Bid Wall Ratio} < 2.0\times$), ensuring clear downside liquidity for target realization.
