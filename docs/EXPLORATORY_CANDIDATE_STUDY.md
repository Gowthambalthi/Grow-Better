# EXPLORATORY & DIAGNOSTIC STUDY: 1M LIQUIDITY SWEEP + 15M FVG DISPLACEMENT CONFLUENCE

## 1. Study Status & Data Observation Record
- **Study Status:** **EXPLORATORY & RETROSPECTIVE AUDIT**
- **Single-Look / Confirmatory Status:** **VOID / NONE.** This study does not make any confirmatory or single-look inference. The 14-month Discovery partition (`2025-05-28` to `2026-07-31`) was queried and evaluated across multiple scripts during technical development to count trades, examine execution state divergence, and audit dual-sweep candle behavior. The Held-Out partition (`2026-08-01` to `2026-10-05`) spans only 44 trading sessions (704 symbol-sessions), with an expected sample of only ~18 trades, which is far too small to support an independent confirmatory hypothesis test.
- **Purpose of this Document:** To serve as a permanent, reproducible record of the strategy's exact implementation, parameter consistency, observed empirical trade counts, and structural mechanics across the 14-month dataset.

---

## 2. Full Record of Prior Discovery Observations (2025-05-28 to 2026-07-31)

Across the 3,912 continuous symbol-sessions (09:15–15:14 IST) evaluated on the 16 large-cap NSE equities:

### 1. Trade Frequencies
- **Baseline (Sweep 1m alone):** Generated **7,978 trades** (~2.04 trades per symbol-session).
- **Candidate (Sweep 1m + 15m FVG Confluence):** Generated **104 trades** (~0.027 trades per symbol-session, or ~7.4 trades per month across all 16 names).

### 2. State Divergence & Non-Subset Behavior
- **Matched Trades:** Exactly **30 trades** were taken by Candidate where Baseline was flat and took the identical trade.
- **Unmatched Candidate Trades:** Exactly **74 trades** were taken by Candidate while Baseline was locked in an earlier active position.
- **Unmatched while Flat:** Exactly **0 trades** were taken by Candidate while Baseline was flat (i.e. every candidate trade was an underlying sweep trigger that Baseline would have taken if flat).

### 3. Dual-Sweep Measurements & Script Attribution
Two distinct measurements were performed regarding outside bars that swept both pivots with $\ge 35\%$ wicks (which occurred 2,653 times in Discovery):
- **Measurement A (Executed SHORT trades on dual-sweep candles):**
  - *Script Logic:* Audited the executed trade lists (`base.trades` and `cand.trades`) to count how many executed SHORT trades had a trigger bar $i$ that simultaneously swept a pivot low with $\ge 35\%$ lower wick.
  - *Result:* Baseline executed **47** SHORT trades on dual-sweep candles; Candidate executed **6** SHORT trades on dual-sweep candles.
- **Measurement B (LONG qualification on those exact trigger bars):**
  - *Script Logic:* Evaluated the trigger bars of those executed SHORT trades to test if the LONG side simultaneously met 1m sweep/wick/RR conditions and (for Candidate) 15m confluence. Note: this script evaluated candle-level gate conditions on bar $i$; it did not simulate an alternative execution branch with LONG active.
  - *Result:*
    - **Baseline (47 candles):** On all 47 trigger bars, the LONG side simultaneously satisfied 1m SSL sweep, $\ge 35\%$ lower wick, and $\text{RR} \ge 0.1$.
    - **Candidate (0 candles):** On 0 of the 6 trigger bars did the LONG side satisfy 15m confluence.

### 4. Code Path Proof for Candidate's Zero LONG Confluence on SHORT Bars
In `strategies/fvg/candidate_sweep_15m_fvg.js` lines 125–137:
```javascript
function check15mConfluence(i, side, bars1m, bars15m, atr15m, opt) {
  const current1mTime = bars1m[i].time;
  const currentMin = getMinuteOfIST(current1mTime);

  let lastClosedIdx = -1;
  for (let k = bars15m.length - 1; k >= 0; k--) {
    if (bars15m[k].bucketMin + 15 <= currentMin) {
      lastClosedIdx = k;
      break;
    }
  }
  const dispBar = bars15m[lastClosedIdx];
```
Because both SHORT and LONG pass the identical 1m bar index $i$ and determine `lastClosedIdx` strictly from `currentMin`, **both sides read the exact same 15m displacement candle (`dispBar`)**.
Lines 167 and 172 then enforce:
- For SHORT: `if (dispBar.c >= dispBar.o) return { pass: false, reason: '15M_NOT_BEARISH' };`
- For LONG:  `if (dispBar.c <= dispBar.o) return { pass: false, reason: '15M_NOT_BULLISH' };`
Because a single closed candle `dispBar` cannot have both $c < o$ and $c > o$, on any 1m bar where Candidate entered a SHORT trade (confirming $c < o$), a LONG confluence check on that same 1m bar is mathematically guaranteed to return `15M_NOT_BULLISH`.

### 5. Inspected Sessions
Detailed trade logs were generated and inspected for RELIANCE (`2025-07-09`, `2026-06-15`, `2026-06-29`) and HDFCBANK (`2026-01-12`).

---

## 3. Implementation Parameters & Consistency Check

The implementation is housed in `strategies/fvg/candidate_sweep_15m_fvg.js`.

| Parameter Name | Code Line | Code Extract | Specification & Role |
|---|---|---|---|
| `shortOnly` | L188 | `shortOnly: false` | Two-Sided trading enabled. Both arms scan for Short and Long setups. |
| `armingStartMin` | L189 | `armingStartMin: 585` | Earliest sweep evaluation starts at 09:45 IST; 15m confluence gates until 10:00 (L141). |
| `armingEndMin` | L190 | `armingEndMin: 780` | Arming cutoff strictly at 13:00 IST (minute 780). No new setups armed after 13:00. |
| `swingWing` | L191 | `swingWing: 3` | 3-bar swing pivots on 1m bars (3 bars before, 3 bars after). |
| `minWickPct` | L192 | `minWickPct: 0.35` | Rejection wick $\ge 35\%$ of candle range on trigger bar. |
| `fvgLookback15m` | L193 | `fvgLookback15m: 20` | Lookback of 20 15m bars to compute median displacement candle body. |
| `displacementMult` | L194 | `displacementMult: 1.5` | 15m displacement candle body must be $\ge 1.5\times$ the 20-bar median 15m body. |
| `fvgAtrMult` | L195 | `fvgAtrMult: 0.20` | FVG gap between bar $k-2$ and bar $k$ must be $\ge 0.20\times\text{ATR}(14)$. |
| `stopBufferBps` | L196 | `stopBufferBps: 25.0` | Stop placed 25.0 bps beyond sweep extreme (Short: $+25$ bps; Long: $-25$ bps). |
| `targetBps` | L197 | `targetBps: 150.0` | Profit target placed 150.0 bps from entry open (Short: $-150$ bps; Long: $+150$ bps). |
| `minRr` | L198 | `minRr: 0.1` | Minimum Reward-to-Risk ratio $\ge 0.1$ (matches shipped clamp profile). |
| `flatTollBps` | L199 | `flatTollBps: 15.0` | Flat 15.0 bps round-trip assumed friction (5.384 statutory + 9.616 assumed spread/slippage). |
| `sessionCloseCutoff` | L224, L260 | `m > 914`, `m >= 914` | Session strictly terminates at 15:14 IST. Open positions close at 15:14 bar close. |
| `pessimisticTie` | L235, L248 | `if (hitStop && hitTgt)` | If candle range hits both stop and target, STOP fills first (pessimistic). |

---

## 4. Position Rule: Combined Strategy Mechanics

- Both arms enforce single-position execution per symbol (`!activePosition`).
- The comparison evaluates the **Combined Strategy** (the combined effect of the 15m FVG filter and the resulting capital/position availability).
- Candidate trades are **not** an exact nested subset of Baseline trades across multi-trade sessions.
- Session outcomes are evaluated as the paired symbol-session differential:
  $$\Delta(s, d) = R_{\text{cand}}(s, d) - R_{\text{base}}(s, d)$$
  where $R(s, d) = \sum_{t \in \text{Trades}(s, d)} \text{NetBps}(t)$.

---

## 5. Friction Model & Sensitivity Reporting

- **Primary Assumed Hurdle:** **15.0 bps flat round-trip** (5.384 bps statutory + 9.616 bps assumed spread/slippage).
- **Mandatory Sensitivity Reporting:** Any evaluation of this strategy must report full performance across three standardized cost levels:
  1. **10.0 bps flat round-trip:** Statutory + minimal spread crossing (optimistic).
  2. **15.0 bps flat round-trip:** Primary assumed hurdle (baseline).
  3. **20.0 bps flat round-trip:** Stressed liquidity / wider spread hurdle (conservative).

---

## 6. History and Rationale of the 200-Trade Floor

- **Origin and History:** The $N \ge 200$ trade floor was initially proposed in earlier turns as an arbitrary statistical sample size rule to limit estimation variance. Later in the conversation, after Discovery audit scripts revealed that Candidate only produced 104 trades, the floor was reframed downward (first to 75, then to 15 for held-out) to match the observed count. That post-hoc reframing is formally acknowledged as an error.
- **Explicit Operational Rationale:** The $N \ge 200$ figure represents a user-selected operational deployability choice: requiring at least ~14 trades per month across 16 large-cap stocks over a 14-month horizon to justify capital allocation and dedicated live monitoring infrastructure.
- **Observed Frequency:** The Candidate strategy produced 104 trades over 14 months (~7.4 trades per month), falling short of this 200-trade deployment threshold. Whether 7.4 trades per month is acceptable is an external operational decision, not an empirical conclusion proven by data.

---

## 7. Requirements for a Genuine Confirmatory Test

Because Discovery has been observed and Held-Out is underpowered (~18 expected trades), a confirmatory test cannot be conducted on this dataset. A genuine confirmatory test would require:
1. **A Completely Fresh Dataset:** Either forward live paper/production trading or newly collected historical equity data that has never been queried.
2. **Sufficient Sample Size:** A sample window large enough to yield at least 200–300 candidate trades under the frozen parameter rules.
3. **Pre-Registration Prior to Ingestion:** Freezing the code SHA-256 and evaluation protocol before the fresh data is collected or loaded.
