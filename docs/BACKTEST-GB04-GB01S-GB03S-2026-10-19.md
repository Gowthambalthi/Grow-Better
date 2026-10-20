# GB04, GB01 shorts, GB03a shorts — measured on the full corpus

**Date:** 2026-10-19 · **Corpus:** `data/ohlcv_1m_full`, **1031 symbols** · **Cost:** 0.05% round trip, charged in R
**Script:** `node scratch/gb04_gb01s_gb03s_study.js --symbols=2000` · artifact `scratch/gb04_full.log`

---

## Method — one harness, three strategies

All three run through the shipped rules in `backtest/follow.js` and the shipped
accounting in `backtest/metrics.js`:

- signal frozen at the decision bar's close, **fill at the next bar's open**;
- the plan is **re-derived against the fill**, and a fill that inverts the setup is rejected;
- a bar holding both stop and target resolves as the **stop**;
- the hold **cannot outlive the entry session**;
- entries only inside 09:20–15:00 IST **minus the measured blocked windows** (12:15–12:45, 13:15–13:45);
- **one trade per symbol per day**;
- cost is `0.05% / stopWidth` in R, so a tight stop pays proportionally more.

**GB04 is the odd one and it is stated rather than hidden.** It is not registered in
`strategy-core/engines.js` and has never been through the harness. It emits only
`{ setup, side, entry, invalidation }` — no planner call, no `barIndex`, no targets.
The study supplies the three shared pieces (`barIndex`, `market`, `targetCandidates`)
from `strategy-core/market.js`, the same source the other engines plan from, so GB04 is
priced on the same levels rather than on a private list invented for this run. Its hold
cap is 180 bars, the same as GB01, because it has no registered hold of its own.

---

## GB04 — Real Support / Resistance

| slice | trades | netPF | netR | exp | win% | T1 | T2 | stop | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **all** | 6883 | **1.13** | +693.77R | +0.101R | 34.1% | 1747 | 564 | 4516 | 59.23R |
| support bounce (RL, longs) | 2668 | **1.05** | +96.39R | +0.036R | 32.3% | 629 | 218 | 1798 | **85.07R** |
| resistance reject (RS, shorts) | 4215 | **1.19** | +597.38R | +0.142R | 35.3% | 1118 | 346 | 2718 | 54.48R |
| dev (to 2026-02-02) | 2662 | 1.30 | +581.54R | +0.218R | 36.5% | 716 | 238 | 1684 | 35.22R |
| **holdout (from 2026-02-02)** | 4221 | **1.03** | +112.24R | **+0.027R** | 32.6% | 1031 | 326 | 2832 | **84.19R** |

**Verdict: not validated.** The full sample looks positive (netPF 1.13), but the
forward half is **break-even** at PF 1.03 and +0.027R per trade, with an 84R drawdown
across 4221 trades. Two thirds of its signals stop out (4516/6883). The whole edge sits
in the first half.

The split inside the strategy is the same story: the resistance rejection (short) side
earns 0.142R per trade, the support bounce (long) side earns **0.036R** and carries the
deepest drawdown in the study (85.07R). GB04's longs are the drag, exactly as GB01's are.

---

## GB01 — FG01 SHORT

| slice | trades | netPF | netR | exp | win% | T1 | T2 | stop | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **FG01 shorts** | 74 | **2.25** | +59.26R | +0.801R | 43.2% | 23 | 7 | 42 | 6.87R |
| dev (to 2026-05-14) | 49 | 2.09 | +34.74R | +0.709R | 42.9% | 14 | 5 | 28 | 5.87R |
| **holdout (from 2026-05-14)** | 25 | **2.57** | +24.52R | +0.981R | 44.0% | 9 | 2 | 14 | 4.52R |
| *(longs, reference)* | 227 | **1.03** | +4.74R | +0.021R | 32.6% | 51 | 22 | 153 | 29.76R |

**Verdict: the strongest line in the study, and stable.** Both halves are above PF 2,
the holdout is *better* than the development half, and the drawdown is the smallest
measured (6.87R). The long side of the same engine earns +0.021R per trade — it pays
its costs and nothing else, on 227 trades.

Sample caveat: 74 trades. This is a real but thin edge.

---

## GB03a — OF03 SHORT

| slice | trades | netPF | netR | exp | win% | T1 | T2 | stop | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **OF03 shorts** | 77 | **1.80** | +34.62R | +0.450R | 53.2% | 33 | 7 | 36 | 10.75R |
| dev (to 2026-06-04) | 52 | 1.44 | +13.61R | +0.262R | 50.0% | 20 | 5 | 26 | 9.66R |
| **holdout (from 2026-06-04)** | 25 | **2.74** | +21.01R | +0.840R | 60.0% | 13 | 2 | 10 | 4.92R |
| *(longs, reference)* | 65 | 1.27 | +11.68R | +0.180R | 46.2% | 17 | 11 | 34 | 7.49R |

**Verdict: positive, and improving forward.** 0.45R per trade overall, 0.84R in the
holdout, and the highest win rate of the three (53.2%). This agrees with the existing
100-symbol measurement (13 shorts, +19.27R) and with the live engine's own default,
which already arms **shorts only** (`GB03_SIDES: 'short'`).

---

## GB01 + GB03a — shorts only, combined

| slice | trades | netPF | netR | exp | win% | T1 | T2 | stop | maxDD |
|---|---|---|---|---|---|---|---|---|---|
| **combined** | 151 | **2.03** | +93.88R | +0.622R | 48.3% | 56 | 14 | 78 | 10.75R |
| dev | 104 | 1.76 | +49.45R | +0.475R | 46.2% | 34 | 11 | 56 | 9.66R |
| **holdout** | 47 | **2.74** | +44.43R | +0.945R | 53.2% | 22 | 3 | 22 | 4.92R |

133 symbols produced a trade, across 118 sessions. A shorts-only book is a different
strategy from either engine in full, and this is what it measures: **PF 2.03, +0.62R per
trade, 10.75R maximum drawdown**, with the forward half stronger than the development half.

---

## What this says to act on

1. **GB03a shorts: keep.** Positive overall, positive in both halves, and the live
   default already restricts it to shorts. No change needed.
2. **GB01 shorts: the best measured line**, but it is 74 trades. It deserves a larger
   sample before size is increased, not before it is used.
3. **GB04: do not register it.** Break-even out of sample, two thirds of its signals
   stop out, its long side earns 0.036R, and its worst drawdown is the largest here. A
   registered engine is a standing instruction to every harness and to the board
   (`strategy-core/engines.js` says exactly this), so it stays out until a forward
   sample says otherwise.
4. **The long side is the recurring leak.** GB04 longs 0.036R, GB01 longs 0.021R,
   while every short side measures 0.14–0.80R. Three independent setups agreeing on
   that is the most useful finding in this run.

---

## Limits

- **Cost is 0.05% round trip and nothing else.** No slippage, no impact, no brokerage
  minimums. A 6883-trade book like GB04 is far more exposed to that omission than a
  74-trade one — real friction would hurt GB04 most and the short books least.
- **Stop-first ties** are pessimistic by policy; every engine is charged the same way,
  so the comparison holds even though each individual number is slightly conservative.
- **GB04's targets are the shared market levels plus a 1.5R projection**, because the
  engine emits no plan. A different target rule would move its numbers; it would not
  plausibly rescue a 0.027R holdout expectancy.
- **The corpus is not survivorship-free.** It is the symbols present in
  `data/ohlcv_1m_full` on 2026-10-06, so delisted or newly listed names are unevenly
  represented across the two halves.
- GB01/GB03a short samples (74/77) are thin enough that a handful of trades moves the
  PF by several tenths. The halves are reported so that a flattering whole cannot hide
  an unstable split.

---

## Reproduce

```bash
node scratch/gb04_gb01s_gb03s_study.js --symbols=2000          # ~20 min, 1031 symbols
node scratch/gb04_gb01s_gb03s_study.js --symbols=25            # ~45 s, smoke test
```
