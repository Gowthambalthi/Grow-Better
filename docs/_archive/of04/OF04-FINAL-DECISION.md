# OF04 — Final Decision Pass

**Inputs used:** ONLY the Message-1 trade-level backtest results
(`docs/OF04-TRADE-BACKTEST.md`, `data/terminal/of04-trade-backtest-stats-scalp.json`,
`data/terminal/of04-trade-backtest-stats-intraday.json`).

**Actions NOT taken (per instruction):** no tuning from results, no added filters, no threshold
changes, no new strategy, no parameter search, no gate modification, no production/live change,
no orders sent.

---

## Decision rule applied (rule A)

> If the trade-level backtest FAILS → mark it FAILED and stop. Do not repair it by modifying rules.

Failure criterion (pre-existing, not invented here): **net expectancy ≤ 0** / **after-cost profit
factor ≤ 1** on the full tradeable population.

---

## SCALPING — FAIL

| Decisive metric (Message 1) | Result |
|---|---|
| Net expectancy @ realistic cost (0.07%) | **−0.300 R** |
| After-cost profit factor | **0.180** |
| Positive-session coverage | **0 / 4 (0.0%)** |
| Break-even round-trip cost | ≈ 0.0101% |

**Fails on positive expectancy and after-cost PF. No gate run. No repair.**

## INTRADAY — FAIL

| Decisive metric (Message 1) | Result |
|---|---|
| Net expectancy @ realistic cost (0.07%) | **−0.251 R** |
| After-cost profit factor | **0.547** |
| Positive-session coverage | **9 / 145 (6.2%)** |
| Break-even round-trip cost | ≈ 0.0198% |

**Fails on positive expectancy and after-cost PF. No gate run. No repair.**

---

## Validation readiness (rule C)

No track passed, so **no frozen validation record is created** and **no candidate is declared
READY FOR UNSEEN VALIDATION**.

- SCALPING — **FAILED — NO LIVE VALIDATION**
- INTRADAY — **FAILED — NO LIVE VALIDATION**

---

## Final output

```
SCALPING — FAIL
INTRADAY — FAIL

UNSEEN VALIDATION CANDIDATES:
  (none)
```

The research chain terminates here. Nothing is promoted to validation, and production/live trading
is untouched.
