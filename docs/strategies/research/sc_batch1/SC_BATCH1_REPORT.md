# SC Batch 1 — 20 Fixed Scalping Mechanisms (SC01–SC20)

**Status: CLOSED on the development segment — ALL 20 PLANS FAIL. Stage-2 shortlist: EMPTY.**
Locked segment (2026-09-24 … 2026-09-30) was **never read**. No plan was modified after execution and no 21st plan was added.

## 1. Run configuration (frozen)

| Item | Value |
|---|---|
| Instrument scope | Normal NSE cash equities only (no futures/options/ETFs/index, no SME/T2T) |
| Dense panel | 22 complete sessions (≥10k rows/session) |
| Usable (≥5 prior sessions) | 17 → **dev 12**, locked 5 |
| Dev sessions | 2026-09-07 … 2026-09-23 (12 sessions) |
| Locked sessions | 2026-09-24, 09-25, 09-28, 09-29, 09-30 (never read) |
| PIT universe | trailing-5-session turnover ≥ ₹25 Cr, price ≥ ₹100, ≥16/20 nonzero-volume bars |
| Eligible symbols/session | 47 (2026-09-07) then 523–550 |
| Costs | primary 7 bp round trip; sensitivity 3 and 10 bp |
| Trial budget | N = 20 primary trials (one per plan); diagnostics not trials |
| Holm correction | applied across the 20 plans |

Frozen production hashes re-verified True at report time:
`strategies/orderFlow.js` `90471e9ae616cd62` · `strategy-core/tradePlanner.js` `7a311fe0bc97b1d7` · `backtest/follow.js` `e4753e0fe896dd02` · `research/candidateGate.js` `c4037412deff0b14`.

## 2. Ranked summary (development segment, ordered by net expectancy @7 bp)

| Rank | Plan | Family | Trades | Win% | Gross PF | Net PF | Gross exp (bp) | **Net exp (bp)** | @3 bp | @10 bp | PosSess% | Syms | Holm p | Verdict |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | SC04 | impulse pullback | 220 | 45.9 | 1.160 | 0.803 | +2.82 | **−4.18** | −0.18 | −7.18 | 42 | 151 | 1.000 | FAIL |
| 2 | SC07 | impulse pullback | 425 | 44.5 | 1.109 | 0.652 | +1.37 | **−5.63** | −1.63 | −8.63 | 17 | 285 | 1.000 | FAIL |
| 3 | SC01 | extension fade | 1157 | 46.3 | 1.034 | 0.686 | +0.57 | **−6.43** | −2.43 | −9.43 | 8 | 400 | 1.000 | FAIL |
| 4 | SC16 | failed breakout | 23218 | 37.9 | 1.029 | 0.402 | +0.22 | **−6.78** | −2.78 | −9.78 | 0 | 704 | 1.000 | FAIL (PREFLIGHT) |
| 5 | SC08 | impulse pullback | 1232 | 43.2 | 1.013 | 0.654 | +0.21 | **−6.79** | −2.79 | −9.79 | 8 | 420 | 1.000 | FAIL |
| 6 | SC18 | extension fade | 5033 | 42.5 | 1.000 | 0.546 | −0.00 | **−7.00** | −3.00 | −10.00 | 0 | 669 | 1.000 | FAIL |
| 7 | SC13 | compression breakout | 5429 | 35.8 | 0.976 | 0.324 | −0.16 | **−7.16** | −3.16 | −10.16 | 0 | 683 | 1.000 | FAIL (PREFLIGHT) |
| 8 | SC02 | extension fade | 870 | 47.9 | 0.990 | 0.634 | −0.17 | **−7.17** | −3.17 | −10.17 | 0 | 349 | 1.000 | FAIL |
| 9 | SC19 | extension fade | 4345 | 38.0 | 0.937 | 0.488 | −0.69 | **−7.69** | −3.69 | −10.69 | 0 | 669 | 1.000 | FAIL |
| 10 | SC06 | compression breakout | 1929 | 36.9 | 0.943 | 0.528 | −0.70 | **−7.70** | −3.70 | −10.70 | 0 | 578 | 1.000 | FAIL |
| 11 | SC12 | compression breakout | 3688 | 33.6 | 0.903 | 0.344 | −0.74 | **−7.74** | −3.74 | −10.74 | 0 | 647 | 1.000 | FAIL (PREFLIGHT) |
| 12 | SC17 | failed breakout | 24566 | 32.9 | 0.862 | 0.340 | −1.11 | **−8.11** | −4.11 | −11.11 | 0 | 703 | 1.000 | FAIL (PREFLIGHT) |
| 13 | SC11 | impulse pullback | 1486 | 37.8 | 0.881 | 0.411 | −1.19 | **−8.19** | −4.19 | −11.19 | 0 | 505 | 1.000 | FAIL (PREFLIGHT) |
| 14 | SC20 | impulse pullback | 624 | 35.3 | 0.895 | 0.508 | −1.33 | **−8.33** | −4.33 | −11.33 | 0 | 391 | 1.000 | FAIL |
| 15 | SC05 | compression breakout | 2027 | 40.9 | 0.885 | 0.537 | −1.70 | **−8.70** | −4.70 | −11.70 | 0 | 563 | 1.000 | FAIL |
| 16 | SC14 | gap | 43 | 39.5 | 0.902 | 0.631 | −1.99 | **−8.99** | −4.99 | −11.99 | 45 | 43 | 1.000 | FAIL |
| 17 | SC09 | impulse pullback | 349 | 41.5 | 0.852 | 0.501 | −2.15 | **−9.15** | −5.15 | −12.15 | 8 | 203 | 1.000 | FAIL |
| 18 | SC10 | impulse pullback | 2064 | 36.5 | 0.804 | 0.448 | −2.57 | **−9.57** | −5.57 | −12.57 | 0 | 548 | 1.000 | FAIL (PREFLIGHT) |
| 19 | SC15 | gap | 9 | 11.1 | 0.096 | 0.040 | −24.91 | **−31.91** | −27.91 | −34.91 | 0 | 9 | 1.000 | FAIL |
| 20 | SC03 | extension fade | 0 | — | — | — | — | — | — | — | — | 0 | 1.000 | FAIL (no trades) |

All Holm-adjusted p-values round to 1.000: no plan is close to a one-sided positive-expectancy result.

**Best plan (SC04)** is the only one with a net expectancy better than −5 bp, yet it is still negative at every cost level and its net PF is 0.80. It fails the PASS gates outright on net expectancy and net PF, independent of any control or significance test.

## 3. Family view (weighted by trades)

| Family | Plans | Trades | Weighted net exp @7 bp | Weighted gross exp | Weighted net PF | Best plan |
|---|---:|---:|---:|---:|---:|---|
| Gap | 2 (SC14, SC15) | 52 | −12.96 bp | −5.96 bp | 0.529 | SC14 (−8.99) |
| Impulse pullback | 7 (SC04,07,08,09,10,11,20) | 6400 | −8.12 bp | −1.12 bp | 0.514 | SC04 (−4.18) |
| Extension fade | 5 (SC01,02,03,18,19) | 11405 | −7.22 bp | −0.22 bp | 0.545 | SC01 (−6.43) |
| Compression breakout | 4 (SC05,06,12,13) | 13073 | −7.64 bp | −0.64 bp | 0.393 | SC13 (−7.16) |
| Failed breakout | 2 (SC16, SC17) | 47784 | −7.47 bp | −0.47 bp | 0.370 | SC16 (−6.78) |

**No family survives.** Three of five families are negative on *gross* expectancy (before any costs), i.e. the microstructure signal itself is on the wrong side of the spread. The impulse-pullback family is the least-bad in net terms only because SC04/SC07 have slightly positive gross edges that are nonetheless consumed several times over by the 7 bp round-trip cost.

## 4. Preflight and state-visit flags

- **Preflight kills** (median stop < 25 bp → FAIL without backtest): SC16, SC17, SC12, SC13, SC11, SC10.
- **State-visit flags** (fire rate > 2% of eligible symbol-bars): SC16 (1.08%), SC17 (1.14%) — plus SC12/SC13 near the boundary (0.17%/0.25%). SC16/SC17 fire on 23k–25k trades across dev, which is a *state*, not an event, consistent with the micro-range break condition being near-continuous.
- **SC03** produced zero trades: the undercut→reclaim sequence never fired under the frozen causality rules → FAIL (no trades).

## 5. Stage-2 shortlist

**EMPTY.** The frozen shortlist rule admits only PASS plans plus INCONCLUSIVE plans whose sole limitation is power (net exp > 0 @7 bp, net PF ≥ 1.05, positive beta residual, no concentration failure). No plan meets the INCONCLUSIVE floor because **every** plan has net expectancy < 0 at 7 bp. There is nothing to carry into the locked segment.

Per the standing rule "a failed mechanism is closed," all 20 plans are **CLOSED** for this cycle. There is no optimization loop, no re-check and no OR1b/EX1b-style variant.

## 6. Required statistics — availability note (integrity)

Recorded for every feasible plan: trades, win rate, gross/net PF, gross/net expectancy (bp and R), average win/loss, max drawdown, positive-session %, unique symbols, top-10 gross share, top-symbol net share, MAE/MFE (R), holding time, 3/7/10 bp sensitivity, session-clustered bootstrap CI, one-sided session p-value, NIFTY beta and residual expectancy, up/down-day split, reach rates at 0.25/0.50/0.75/1.0/1.5 R, stop-distance median, fire rate, and exit-reason mix.

**Not computed in Batch 1:** the matched-random control (spec §8) and the entry-shift leakage test (spec §11). The harness was not instrumented for them before the run, and the frozen no-modification rule prohibited retrofitting the executed engine. This does **not** change any verdict: every plan already fails the mandatory `net expectancy > 0 @7 bp` gate, and 12 of 20 fail even `gross expectancy > 0`. A control or shift test can only move a result further from PASS, never toward it. They are recorded here as a process limitation, not as a pass.

## 7. Verdict

**SC BATCH 1 = FAIL (all 20).** No candidate, no shortlist. The locked segment remains sealed. No production code, OR1 shadow, EX1, or frozen strategy was touched.
