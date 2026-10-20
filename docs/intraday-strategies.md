# OUR SIX — the complete logic, the implementation, and the record

Written 2026-09-29, after the user named the set and asked for everything else removed.

> **Give LuxAlgo SMC, then orb, trend-day-adr, liqorb, trend-day — and remove all other strategies.**

This file is the whole answer: what each of the six IS, where it lives in the code, what it measured,
how it is wired to the board, and what was removed to get here.

---

## 1. THE SIX, IN THE USER'S ORDER

| # | id | name | where it lives | live on the board? |
|---|---|---|---|---|
| 1 | `smcLuxalgo` | Smart Money Concepts (LuxAlgo) | [pinePorts.js](../gb_scoring_v2/github/pinePorts.js) | yes — structure + gap votes |
| 2 | `orb` | Opening Range Breakout ("our Strategy 2") | [strategies.js](../gb_scoring_v2/github/strategies.js) `makeOrbRetest` | yes — ORB + VWAP votes |
| 3 | `trend_day_adr` | Trend Day (ADR threshold) | `makeTrendDay` | **no** — a daily rule |
| 4 | `liqOrb` | Liquidity + ORB | `strategies.js` + [liquiditySweep.js](../common/market/liquiditySweep.js) | yes — volume + VWAP votes |
| 5 | `trend_day` | Trend Day (Ernie Chan) | `makeTrendDay` | **no** — a daily rule |
| 6 | `valueGap` | Value Gap (unfilled FVG) | `makeValueGap` + [fvg.js](../common/market/fvg.js) | yes — FVG votes |

`gb_scoring_v2/github/strategies.js` now has `STRATEGIES = [smcLuxalgo, orb, trend_day_adr, liqOrb,
trend_day, valueGap]` and a **default harness run touches only these six**. `PARKED` is empty.

---

## 2. THE COMPLETE LOGIC OF EACH ONE

### 1 · `smcLuxalgo` — Smart Money Concepts [LuxAlgo]
**Source:** the Pine v5 listing the user pasted (2026-09-29). Transcribed, not reimagined.

```
pivots        swing length 50, internal length 5 (ta.pivothigh/pivotlow), confirmed `len` bars late —
              a pivot is never usable at its own bar, which is what makes the read causal
structure     a CLOSE through the last confirmed pivot high/low = BOS if it continues the trend,
              CHoCH if it turns it. ONE break per pivot: without that guard a single pivot re-breaks
              on every bar that closes beyond it (measured on real tape: 20,910 "breaks" in 52,461
              bars, an order block stored on each — a detector that has stopped meaning anything)
order blocks  on a bullish break, the last BEARISH candle before it becomes the demand block
              (its high/low); mitigated when a close goes below its low. Mirror for supply.
FVG           3-candle imbalance (candle-3 low vs candle-1 high) at least one cumulative mean range
              tall; filled when price trades back through it
premium /     equilibrium of the last swing high-low range; above it is PREMIUM, below it DISCOUNT
discount
EQH/EQL       two pivots within 0.10 % of each other = equal highs/lows (liquidity above/below)
```

**Entry chain (DECLARED — the listing publishes no entry):** direction from swing structure → a
retrace **into** the freshest unmitigated block on that side, or a fresh same-direction gap when no
block survives → the bar must close back out of the band (a touch, not a pass-through) → longs only in
**discount**, shorts only in **premium** → fresh touches only.
**Stop** beyond the block *and* the protected swing, floored at 0.15 % of price. **Target** 2R.

### 2 · `orb` — Opening Range Breakout
```
opening range  built from the first minutes of the session
entry          break of that range, then the VWAP retest holds
stop           the opposite side of the opening range
target         rr × risk
```
This is the row the user calls **"our Strategy 2"**. It is also the direction gate inside `liqOrb`.

### 3 · `trend_day_adr` — Trend Day with the ADR threshold
```
threshold      the day's move at 14:00 expressed in AVERAGE DAILY RANGE (adrMult 1.0 over the prior
               `adrSessions`, floored) instead of the source's fixed 6 %
entry          14:00, when the move exceeds that threshold
stop           declared (the source has no stop)
target         hold to the session close (MOC, as the source does)
```

### 4 · `liqOrb` — Liquidity + ORB
```
sweep          a pivot confirmed `swings` bars late is PIERCED and CLOSED BACK INSIDE
order block    stored at the sweep
direction gate the direction the OPENING RANGE has already broken decides which side is taken
stop           beyond the sweep extreme + the declared buffer
target         2R
```
The A/B is measured: without the gate (`liqSweepOb`) the gross was +0.001R; with it (`liqOrb`) +0.006R,
on 2,207 fewer trades.

### 5 · `trend_day` — Trend Day (Ernie Chan)
```
threshold      6 % by 14:00 — the source's own number, which is set for LEVERAGED ETFs
entry          14:00 on that move
stop           declared 1 % (the source has none)
target         hold to the close
```
Kept by name. Both Trend Day rows are **daily-bar rules**: the live engine is intraday and does not
compute them, so the board shows them as *not computed live* rather than as a 0 % win rate.

### 6 · `valueGap` — Value Gap
```
band           a 3-candle imbalance on the 5m or 15m frame (candle-1 extreme vs candle-3 opposite
               extreme), still unfilled, ≥ MIN_GAP_PCT tall, ≤ MAX_AGE_BARS old on its own frame —
               read by common/market/fvg.js, the SAME module the board's FVG column uses
entry          a bar CLOSES inside the band
stop           beyond the FAR edge + 0.15 %
target         2R
```

---

## 3. WHAT EACH ONE MEASURED

Tape for every row: **100 symbols · 142 sessions · NSE 1-minute bars · 0.10 % round trip · entries
09:25–14:45 IST · risk band 0.15–3.0 %**. Win = the 1R target touched before the plan stop, after costs.
Reproduce with the command in §6. These are the numbers the board panel prints — it **reads** them from
`data/pine_ports.json` and `data/strategy_rank_100.json` rather than carrying a typed-in copy.

| # | strategy | trades | net win | PF (gross) | net R | gross R | cost R | CI |
|---|---|---|---|---|---|---|---|---|
| 2 | **orb** | 10,847 | **43.6 %** | 0.801 (0.962) | −0.082 | −0.014 | 0.068 | [−0.110, −0.052] |
| 3 | **trend_day_adr** | 1,309 | 42.6 % | 0.872 (1.120) | −0.055 | +0.045 | 0.100 | [−0.131, +0.016] |
| 4 | **liqOrb** | 6,368 | 42.0 % | 0.809 (0.900) | −0.089 | +0.006 | 0.094 | [−0.124, −0.049] |
| 5 | **trend_day** | 376 | 40.7 % | **0.943** (1.144) | −0.031 | +0.069 | 0.100 | [−0.172, +0.111] |
| 6 | **valueGap** | 13,931 | 38.2 % | 0.817 (0.903) | −0.110 | +0.003 | 0.113 | [−0.139, −0.081] |
| 1 | **smcLuxalgo** | 6,936 | 37.6 % | 0.71 (**1.008**) | −0.187 | +0.004 | 0.191 | [−0.217, −0.155] |

**Read the gross column before the win-rate column.** `smcLuxalgo`'s gross PF is **1.008** — before
costs there is nothing there, and the loss is the round-trip cost paid 6,936 times. `trend_day` has the
best profit factor in the whole table (0.943; gross 1.144) and 376 trades, and its CI spans zero, so it
is not established either way. **All six are net-negative after costs**, and every one with a positive
gross R has a gross edge smaller than its own cost per trade. That is the finding, not a ranking.

*(The seventh row built today — `rangeFilter`, the DonovanWall Range Filter — is 39,053 trades, 26.5 %
net win, PF 0.74 (gross 0.971), net R −0.221. It is measured and kept reachable by id, and it is not
one of the six.)*

---

## 4. HOW THE BOARD IMPLEMENTS THEM

### 4a. The data path
```
Angel One WebSocket ticks (NSE, 3 sockets × 1,000 tokens; the scrip master enumerates 2,933 scrips)
  → common/market/tickBoard.js       one OHLCV bar per minute per token + a 10-second sample grid
  → common/market/boardMetrics.js    VWAP · VWAP distance · POC + value area · volume · volume ratio
  → Server.js /api/gb/signals        the per-row payload (recomputed on read as well as at build)
  → public/index.html                the Intraday Signals table
```

### 4b. The columns, and which of the six reads each
| Column | How it is computed | Read by |
|---|---|---|
| **Price** | last exchange tick (LTP) | all |
| **Vol 1m** | shares in the last **completed** minute, from the exchange's cumulative counter | `liqOrb`, `orb` |
| **Vol Ratio** | that minute ÷ the mean of the **previous five completed** minutes. `<1.0` low · `>1.2` ▲ · `>1.5` ▲▲ · `>2.0` ⚡ | `liqOrb` |
| **VWAP** | session VWAP from 1-minute bars: `Σ(typical×vol)/Σvol`, typical `(h+l+c)/3` | `orb`, `liqOrb` |
| **VWAP Dist** | price − VWAP, in **₹ and %** | `orb`, `liqOrb` |
| **POC** | point of control of the 1-minute volume profile via [pocEngine.js](../common/market/pocEngine.js), with distance and value area | `valueGap` |
| **Big Buyers** | absorption from 15s tick candles: `BUYERS HOLDING` / `BIG SELLING` / `–` (null, never false) | `smcLuxalgo` |
| **ROC 10s / 20s / 30s** | change vs the 10-second sample grid; `–` when the anchor is older than 12.5 s (never `0.00 %`) | `smcLuxalgo`, `orb` |
| **ROC 1m** | change vs the close one minute back, from minute bars | `orb` |
| **Signal** | the engine's verdict for the row, with the refusal reason on hover | all |
| **News** | count of current items for that symbol | context |

Refresh: signals every **9 s**, clock/sentiment every 1 s. Off-hours the board says *"feed stopped
(off-hours: 09:15–15:30 IST)"* instead of printing a zero that reads as "nothing tracked".

### 4c. The panel, and how a live row is attributed
`common/market/finalStrategies.js` is the **single** place the six are named for the frontend. It
carries, per strategy: the logic text, the entry/stop/target, the module that implements it, the
**votes it reads** off the live tape, and its measured record read from the artifacts.

`/api/gb/engines` serves `/api/gb/signals`'s `finalStrategies` object, and the panel renders three
blocks per row that are never mixed:

1. **what it is** — logic, entry, stop, target, source, module;
2. **what it measured** — win, PF (gross PF), net R, trades, CI, from the artifact;
3. **what the live tape says** — the ledger join (`signal_ledger.json`), where a live row is credited
   to a strategy when **at least one of the votes it reads agreed** (`f5`, `vol`, `vwap`, `fvg`…).

That third block is a **proxy for attribution, not a per-strategy tag**, and the panel says so on every
row (`proxy: true`). A strategy the live engine does not compute — both Trend Day rows — shows *not
computed live*; it is never displayed as 0 %.

Two populations always travel together: `calls` (rows actually published) and `all` (every directional
row the engine scored, refusals included), each beside the **board baseline**, so a strategy's number
can never be read without the population it came from.

### 4d. The live record today
```
board baseline (all directional)   1,836 rows · 4.1 % 1R win
  smcLuxalgo                         941 rows · 4.6 %
  orb                                690 rows · 4.6 %
  liqOrb                             961 rows · 4.7 %
  valueGap                           801 rows · 5.0 %
  trend_day / trend_day_adr          not computed live (daily rules)
```
A 4–5 % 1R win rate is not a broken engine: it is the **risk frame**. The stop sits at ~0.2–0.35 % of
price, which is inside a single 1-minute bar's range, so the stop is tagged far more often than the 1R
target. Fix the stop before believing any win rate — measured earlier on 799 rows: 39.5 % tagged their
stop first and 59.9 % resolved neither way inside 20 minutes.

---

## 5. WHAT WAS REMOVED

**From the default table (this request):** every row that is not one of the six. The full record with
its measured net R travels in `RETIRED` (23 rows) and is printed in the harness's `notPortable` channel
on every run — so "was X tried?" is answerable without re-porting X:

| removed | net R | why |
|---|---|---|
| `rangeFilter` (Pine) | −0.221 | measured today; not one of the six |
| `liquiditySweep` | −0.141 | superseded by `liqOrb`; the module stays live inside it |
| `srFib` | −0.152 | underpowered (188 trades, CI spans zero) |
| `liqSweepOb`, `liqObRetest`, `sweepReversalOte` | −0.095 … −0.128 | sweep variants without the gate |
| `nifty50_ict`, `nifty_trend` | −0.259 / −0.704 | index-trend family |
| `aggShortCircuit` | −0.315 | needs order-flow data this tape does not have |
| `intraday_roc`, `vwap_reversion`, `ema_rsi`, `bollinger`, `supertrend`, `luxSweep*`, `luxTrendBreak*`, `ai_*`, `zarattini_momentum`, `trend_day_*` variants | −0.056 … −0.473 | 23 rows in total, each with its reason on the row |

**Also withdrawn from the frontend:** the "our five" framing (FRAME · MOMENTUM · LIQUIDITY · AP ·
AGGRESSION). Those were five **evidence families inside one scoring engine**, not five strategies, and
presenting them as the finalised set was wrong. The panel now names only the six.

**Already retired earlier (unchanged):** the five daily-scan engines — TREND · PULLBACK · SUPPORT
BOUNCE · ACCUMULATION · BREAKOUT. Their tombstone is [keptStrategies.js](../common/market/keptStrategies.js)
and their ledger is still [live_calls.json](../data/live_calls.json) (661 calls, 629 closed at **17.2 %**
won; 53 rows dated today with 1 winner). That file must be renamed or archived before any figure from it
is quoted as current, because it is where a "live win rate" gets read from.

---

## 6. HOW TO REPRODUCE ANY OF IT

```bash
# the six, on the 100-symbol tape, exactly as measured above
node gb_scoring_v2/github/backtest.js --limit=100 --ids=smcLuxalgo,orb,trend_day_adr,liqOrb,trend_day,valueGap

# any removed row, by id — the measurement behind its removal
node gb_scoring_v2/github/backtest.js --limit=100 --ids=rangeFilter,liquiditySweep,srFib,liqSweepOb

# the board's own answer: the six, their logic, their artifact record, today's live join
curl -s localhost:4000/api/gb/engines | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d).strategies.map(s=>({id:s.id,win:s.backtest&&s.backtest.netWin,pf:s.backtest&&s.backtest.pf,netR:s.backtest&&s.backtest.netR,tagged:s.tagged})),null,1)))"

# the checks that keep this honest
npm test                     # 382 checks, including the registry cut and the ports' causality
node --test test/pinePorts.test.js
```

## 7. THE SIX ADAPTATIONS, ON A HELD-OUT HALF

Six changes were proposed for the six rows above, aimed at the arithmetic rather than the rules. They
were measured on a symbol split of the full 1,025-symbol tape (510 dev / 515 holdout) with a **0.30 %
risk floor** on every row. **Five of the six are refuted; one survives, as *flat*:**
`trend_day_adr_stop` (the ADR threshold with a stop one ADR from the entry) is **+0.003 R**, win 48.8 %,
net PF 1.023, CI [−0.108, +0.087] — the only row of the seven not negative on the held-out half, and not
established. The ORB filters make `orb` worse (−0.101 → −0.117 while deleting 74 % of its trades); the
SMC direction filter makes `orb` worse and moves `liqOrb` by +0.008 R with the gross PF unchanged, i.e.
it carries no directional information; `liqOrb`'s meaningful-level restriction is the one weak support
(+0.023 R, gross PF 0.950 → 1.014); `valueGap`'s first-touch/alignment/5×-cost filters halve the trade
count and improve gross PF 1.044 → 1.080 but leave the row at −0.160 R.

The finding underneath all six: they are not six strategies with six fixable problems, they are **one
problem — cost relative to risk — appearing six times**, and the only change that moved a number was the
only one that acted on the cost. Full protocol, per-gate refusal counters, the tuned-vs-held-out table,
and the three artifact checks (cost in R measured at 0.073–0.203; `smcLuxalgo`'s realized reward:risk
measured at 1.24 with the 2R target hit on 17.9 % of trades; the live join's per-strategy populations
overlapping and 88.5 % of published rows carrying no claimed vote key): **`gb_scoring_v2/ADAPTATIONS_OOS.md`**.

Artifacts: [strategy_rank_100.json](../data/strategy_rank_100.json) (the 35-row table) ·
[pine_ports.json](../data/pine_ports.json) (the two Pine ports) · [finalStrategies.js](../common/market/finalStrategies.js)
(the six, for the frontend) · [FINDING_SOURCED_CLAIMS.md](../gb_scoring_v2/FINDING_SOURCED_CLAIMS.md)
(every source-tracked claim).
