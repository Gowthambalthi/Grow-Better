# Core Institutional Pattern Breakout Strategy (Engine 1 - v7)

> **Flagship Institutional Pattern Engine for NSE Equities**  
> Covers **Classic Cup & Handle**, **Ascending Triangle**, **Multi-Month Base**, **Symmetrical Triangle**, and **Inverse Head & Shoulders** across the full 997 liquid NSE universe with realistic Indian delivery friction (**0.28% round-trip**).

---

## 1. Modular Architecture in `strategies/mine/`

To keep pattern recognition visually verifiable and decoupled from execution logic, all shape detection algorithms are organized in dedicated pattern modules:

- [`patterns.js`](patterns.js): High-speed JavaScript pattern detector with normalized geometric angles ($\theta_{\text{sup}}, \theta_{\text{res}}$), swing highs/lows, and structural stops.
- [`patterns.py`](patterns.py): Python counterpart for multi-year backtesting scripts in `scripts/`.
- [`resistanceBreakoutStrategy.js`](resistanceBreakoutStrategy.js): Main trading strategy orchestrator. Imports `patterns.js`, executes risk management (RSI sweet spot 48–85, anti-chasing limit orders, targets, and stops).
- [`resistance_breakout_v6.pine`](resistance_breakout_v6.pine): TradingView Pine Script v6 indicator with visual stops and targets.

---

## 2. Core Geometric & Structural Patterns

1. **Ascending Triangle (`detectAscendingTriangle`)**:
   - Flat resistance ceiling with $\ge 3$ distinct tests ($\pm 1.8\%$, angle $|\theta_{\text{res}}| \le 6.0^\circ$).
   - At least 3 strictly ascending swing lows ($L_1 < L_2 < L_3$, angle $\theta_{\text{sup}} \ge +10.0^\circ$).
   - Structural stop: Anchored below the last ascending swing low ($L_3 \times 0.995$).

2. **Classic Cup & Handle (`detectCupAndHandle`)**:
   - U-shaped accumulation basin (depth 10% to 35%).
   - Rim alignment within 3.8% between left and right peaks.
   - Downward/flat drifting handle (slope $\le +2.5^\circ$) in the upper 48% of the cup.
   - Structural stop: Anchored below the handle low trough.

3. **Multi-Month Base (`detectMultiMonthBase`)**:
   - 35 to 100-day tight consolidation base (depth 7% to 30%).
   - Distinct resistance tests separated by $\ge 12$ bars.
   - Structural stop: Anchored below recent 20-day base floor.

4. **Symmetrical Triangle / Coil (`detectSymmetricalTriangle`)**:
   - Converging volatility contraction ($H_1 > H_2$, $L_1 < L_2$).
   - Upper resistance angle $\le -5.0^\circ$, lower support angle $\ge +5.0^\circ$.
   - Structural stop: Anchored below the contraction swing low ($L_2$).

5. **Inverse Head & Shoulders (`detectInverseHeadAndShoulders`)**:
   - Symmetrical left and right shoulders ($|RS/LS - 1.0| \le 5.5\%$).
   - Capitulation head strictly lower than both shoulders by $\ge 3.0\%$.
   - Structural stop: Anchored below the right shoulder low.

---

## 3. Usage Example

```javascript
// In Node.js:
const { ResistanceBreakoutStrategy, patterns } = require("./strategies/mine/resistanceBreakoutStrategy");

// Direct pattern detection:
const pattern = patterns.detectPattern(sessions);
console.log(pattern);

// Full strategy signal generation:
const strategy = new ResistanceBreakoutStrategy();
const signal = strategy.onBar(sessions);
if (signal) {
    console.log(`BUY Signal on ${signal.pattern} at ₹${signal.patternLevel}, SL: ₹${signal.stopLoss}`);
}
```
