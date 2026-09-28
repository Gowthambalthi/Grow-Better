# Improvement protocol — one axis per pass, and who is allowed to read the holdout

Written 2026-09-27, before any filter work starts. It exists so that "we improved the win rate" is a
statement with a spending rule attached, not a feeling. The reason it is written down first: this
project has already produced one number that was not a finding (`+0.093R ESTABLISHED`, a side-naming
bug — `.freebuff/verify-side-bug.js`), and the cheapest way to produce the next one is to try eight
filters against the same holdout and keep the one that looks best.

## 1. The registered objectives

**CORRECTED 2026-09-27, AFTER THE TABLE WAS FIRST WRITTEN.** The `nifty50_ict` row below was the only
established edge on the board and it has since been **withdrawn as a fabrication** (retracement entries
were armed without re-checking the invalidation level the stop is built from, so breached setups came
back as longs whose stop sat above their fill and booked exactly +1.00R on the next bar — 270 of 452
sampled trades at an MFE of ZERO; mean R without them −1.105R). Honest re-measurement: 241 trades,
gross −0.084R, net −0.380R, gross win 32%, PF 0.55. So there is currently **no established edge on the
board at all**, and every objective below is now "establish that an edge exists" before any of the
65–70% language means anything. A win-rate target is the last thing to chase, not the first.

| # | strategy | today (142 sessions, 995 symbols) | objective |
|---|---|---|---|
| 1 | `nifty50_ict` | row WITHDRAWN as an artifact; honest sample 241 trades · gross −0.084R · net −0.380R · win 32% · PF 0.55; full tape on current code (995 symbols × 142 sessions, `data/ict_folds.json`): 36,320 trades · gross +0.016R · cost 0.275R (17× gross) · net −0.259R · CI [−0.284,−0.234] · **0/12 expanding walk-forward folds held** · 7/142 sessions positive · geometry audit clean (0 wrong-side stops, 0 phantom wins) | **net R > 0 on dev AND folds** first. Only if that happens does a win-rate objective exist — and then it is gross win 65–70% **with** net R and PF up and maxDD not worse |
| 2 | `orb` (repo port) **and** `orbRetest` (locked v2, Tests A–D) — two different systems, never one row | port: 95,167 trades · gross −0.024R · net −0.094R. Locked v2 stack (D@2x, 2R, OOS): 2,151 trades · **gross +0.062R** · net −0.283R | **net R > 0 first**, and the two need opposite sentences: the PORT has no signal at all (negative gross — nothing to rescue), the LOCKED STACK has a real but small gross that 0.34R of cost erases (`costR = costPct/riskPct` at a median stop of ~0.29% of price) |
| 3 | absorption / order-flow | NOT BUILT — feed has no executed side; `.freebuff/verify-bqsq.js` decides whether its only per-tick quantity pair is traded-cumulative (fundable) or resting-book (not) | win 50%+ only after the feed clears; `aggShortCircuit` is a proxy and is not this |

**Win rate is a tracked column, never the selection criterion.** It is arithmetically coupled to the
stop width through the cost: `costR = costPct / riskPct`, so widening the stop lowers cost-in-R and
RAISES the net win rate with no change in the signal — measured on S3's grid, the same entry went from
38.1% to 39.6% net-win purely by moving the stop from 0.15% to 0.30%. A pass that raises win% while
lowering net R is a REJECTION, not an improvement.

## 2. What is tracked per pass (all of it now emitted by `github/backtest.js`, and independently
re-derived by `.freebuff/audit-metrics.js` on a sample, because a metric layer that is not audited is
where the last wrong number came from)

net mean R (primary) · gross mean R (the signal) · mean cost R · net win% **and** gross win% ·
profit factor (net and gross) · max drawdown in R (time-ordered) · longest losing streak ·
average win/loss R · expectancy · trades · refused (degenerate risk) · refused (cross-session fills) ·
cluster session-bootstrap CI (seeded, reproducible) · full vs thin coverage cohort.

## 3. The loop — and the one thing in the original loop that has to change

```
BASE (frozen, tagged)
  ↓
+ ONE axis            ← one filter, or one parameter, never two
  ↓
DEV (99 sessions)     ← selection
  ↓
WALK-FORWARD (12 sequential folds inside dev)
  ↓
KEEP / REJECT
  ↓
next axis
  ↓
FINAL config → the 43-session OOS is read ONCE, for that config only
```

**The correction: keep/reject decisions are made on the walk-forward folds, not on the holdout.** The
original loop reads the OOS after every filter. Eight filters would then spend the same 43 sessions
eight times, and the best-looking of eight tries is not a result — that is the exact mechanism that
manufactured the withdrawn S3 number. The rules that follow from this:

* **Dev is free.** Filter away. Everything selected on dev is selected on dev only.
* **Folds are the gate.** 12 expanding-window folds, sequential in time; a filter is kept only if the
  fold median improves and no fold turns materially worse.
* **The holdout is spent once per strategy VERSION.** Read it for the frozen final config. If the config
  is then changed, that version's holdout is gone: the next read must come from sessions appended to
  the tape AFTER the change (`scripts/fetchOhlcv1m.js` extends forward), declared as the new block
  before it is read.
* A rejected filter costs no holdout. Rejections are the cheap, expected outcome: assume most axes fail.

## 4. The gate a filter must clear to be KEPT

1. **Mechanism first.** The axis, its direction of expected effect, and why it should exist (a
   microstructure or session-structure reason) are written into the runner header BEFORE the run. A
   filter whose mechanism is "it improved the sample" is a curve fit.
2. **Fold median net R improves** across the 12 folds, and **no fold worsens by more than 0.05R mean or
   loses more than 25% of its trades**.
3. **Trade count floor** holds (>= 50 total and >= 10 in each fold's test window), and the refusal
   counters do not blow up (a filter that works by refusing everything is a filter that stopped the
   strategy, and it shows up here).
4. **The effect is not stop-width arithmetic.** Re-check `meanCostR` and the stop-width distribution: if
   the gain came from the risk band moving, say so — that is a cost-model change, not an edge.
5. **Time-structure neutral.** Thresholds come from the pre-registered mechanism, never from a quantile
   of the sample being tested.
6. **Coverage stated.** 16.5% of the tape's symbols were added late and exist ONLY inside the OOS
   window (164 symbols with ~21 sessions; `data/tape_coverage.json`). Headline numbers are quoted on the
   full-coverage cohort (`--minSessions=128`); the thin cohort is reported separately, never mixed in.

## 5. The axes, in the order they will be tried

**Strategy 1 — `nifty50_ict`:** the first measurement to act on is not an entry filter but the
**excursion give-back**. On the corrected tape (100 symbols, 142 sessions) the port trades 4,344 times
at **gross −0.010R** and **mean MFE 1.159R** — the entries locate roughly 1.16R of favourable excursion
and the exits hand back **1.169R** of it, i.e. essentially all of it, with a fixed 2R target inside a
structural stop. So the axis order is: (1) **exit management** (partial at the zone extreme, trail the
displacement extreme, time stop) — the money is already being found and being returned; (2) displacement
strength (does a bigger leg give back less?); (3) market-direction and time-of-day filters;
(4) entry-zone quality (the FVG/order-block selection the port reduces to one rule); (5) liquidity/volume
filter; (6) retest confirmation; (7) long and short measured SEPARATELY — the port pools them.

**NAMING (two numbering schemes are in use — write the ROW NAME, not just the number).** This file's
S1/S2/S3 are the portfolio's labels: S1 = `nifty50_ict`, S2 = `orb`/ORB+retest, S3 = absorption /
order-flow. The 2026-09-27 working conversation numbered them differently: S1 = the order-flow footprint
(the absorption strategy), S2 = ORB+retest, S3 = `liquiditySweep`. Same three systems, different digits.
Every sentence below carries its row name so the mapping cannot be guessed wrong.

**Strategy 2 — ORB (+retest):** opening-range quality (range size vs ATR) · breakout displacement ·
VWAP alignment · retest confirmation · volume expansion · NIFTY trend alignment · midday/chop avoidance.

**The port and the locked stack are not one row, and the first thing to fix depends on which is meant.**
`orb` (repo port: 1m close beyond the OR ±0.05%, stop at the opposite range side, 1.5R) measures gross
−0.024R — no signal, and no stop width can create one. `orbRetest` (locked v2, Tests A–D: 5m bucket
close, structural stop, 2R) measures gross **+0.033R (C) to +0.062R (D@2x) on OOS** — a small real
gross that 0.34R of cost erases completely. An earlier revision of this file merged the two and applied
the port's negative-gross conclusion to the stack.

**CORRECTION, TWICE OVER (2026-09-27) — NEITHER EARLIER ORB LAYER TABLE MAY BE USED, AND THE FLIP IS
NOT A RESULT EITHER.** History: (1) the pre-fix run (21:14, `.freebuff/orb-full.out`) read B→C at OOS
−0.075R and the retest layer was written off as falsified; (2) the post-fix run (00:46,
`.freebuff/orb-retest-full.out`) read B→C **+0.013R** and C→D@2x **+0.040R**, and that flip was recorded as
the corrected result — including in the first revision of this very section. Both are withdrawn.

A re-run on the current code (`.freebuff/run-orb-retest.js` → `data/orb_retest_gate.json`; 995 symbols ×
142 sessions, 12:30) emitted **6-7x MORE candidates** than the 00:46 run for the identical question: Test A
106,711 signals / 94,058 trades against 18,162 / 15,585. The gap was INVESTIGATED, not assumed:
`.freebuff/probe-orb-counts.js` re-derives Test A's rule straight from the raw tape with no shared code
(OR = 09:15-09:29 high/low; breakout = a 5-minute bucket close beyond it by 14:45, once per session) and
finds 1,020 breakouts on 1,130 sessions-with-OR across 8 symbols = **90.3%**, against the strategy's
1,014 = 89.7%, per-symbol agreement within ~10 candidates. **The current candidate rate is right; the
00:46 rate (~6% of sessions) came from a code state that has since been fixed.** It was not a tape change:
the 832 `data/ohlcv_1m` files rewritten at 00:48 leave `liquiditySweep`'s counts IDENTICAL (60,571 signals
and 7,141 refusals at w005 in both `data/liquidity_stopwidth_grid.json` and
`data/liquidity_mingate_grid.json` 12 hours later), and no ORB candidate count is reproducible from either
earlier log.

**WHAT THE VERIFIED TABLE SAYS** (OOS mean R, current code, dev-selected participation = D@1x):
A→B **+0.000** (VWAP adds nothing, as before) · B→C **−0.041** (the RETEST DOES NOT ADD VALUE on this
tape) · C→D@1x **+0.008** (participation + ROC adds a little). So the retest layer's falsification STANDS —
but for the corrected reason: it is measured on a candidate rate an independent reimplementation
confirms, and NOT because a broken simulator said so. A lesson for the ledger: "the number changed after
the fix" is not evidence that the new number is right. Reproducing a count from the raw tape is.

**The cost-to-stop gate axis (PRE-REGISTERED before the run, on both ORB and `liquiditySweep`).**
Mechanism: `costR = costPct / riskPct` is a division, and a structural stop is tight by construction
(median planned risk on the locked ORB stack ~0.29% of price, on `liquiditySweep` 0.32% original /
0.55% widened) — so a 0.10% round trip costs ~0.31-0.35R per trade, which is the entire gross. The
AXIS: refuse a plan whose structural stop sits nearer than `minStopPct` (absolute % of price). The stop
is never moved — only which plans are taken changes, so this is not the width grid again.

PREDICTION, STATED BEFORE THE MEASUREMENT: at a gross of +0.03..+0.06R, break-even needs a stop of
**1.6%-3.3% of price** (costPct / gross). If the wide-stop tail does not carry a materially larger gross
than the strategy as a whole, then net R stays negative at EVERY threshold and the kept trade count
collapses — in which case the axis closes and the mechanism is not "the stops were too tight".
Discipline: gate selected on dev only, among cells keeping ≥ 10% of signals and ≥ 30 dev trades;
decision on the 12 expanding walk-forward folds (median improves, no fold worse than −0.05R); the
43-session OOS read ONCE for the frozen (config, gate) pair. Artifacts: `data/orb_retest_gate.json`,
`data/liquidity_mingate_grid.json`.

**RESULT, ORB `orbRetest` (2026-09-27) — THE GATE IS THE FIRST AXIS IN THIS PROJECT TO CLEAR THE FOLD
RULE, AND IT STILL DOES NOT PAY.** On the verified code state (995 symbols × 142 sessions, cost 0.10%,
D@1x = the participation cell this run dev-selected), gate chosen on dev among cells keeping ≥10% of
signals:

| gate | kept | keep% | medRisk% | devR (n) | oosR (n) | oos gross | oos cost | oos win% | oos CI |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 49,985 | 100% | 0.313 | −0.275 (34,979) | −0.299 (15,006) | +0.046 | 0.345 | 35.7 | [−0.336, −0.257] |
| **0.5** | 11,876 | 23.8% | 0.666 | **−0.142** (8,404) | **−0.132** (3,472) | +0.012 | 0.145 | 36.5 | [−0.199, −0.056] |
| 0.75 | 4,178 | 8.4% | 0.922 | −0.112 (2,931) | −0.080 (1,247) | +0.023 | 0.103 | 38.3 | [−0.161, +0.008] |
| 1.0 | 1,558 | 3.1% | 1.213 | −0.198 (1,081) | −0.097 (477) | −0.018 | 0.078 | 38.6 | [−0.211, +0.014] |
| 1.5 | 317 | 0.6% | 1.741 | −0.164 (210) | −0.053 (107) | +0.002 | 0.055 | 42.1 | [−0.255, +0.159] |
| 2.0 | 75 | 0.2% | 2.261 | −0.287 (44) | +0.351 (31) | +0.393 | 0.043 | 51.6 | [−0.099, +0.829] |

Dev-selected cell: **gate 0.5% → OOS −0.132R over 3,472 trades, against −0.299R ungated: +0.167R, 56% of
the loss removed**, with cost falling 0.345R → 0.145R and gross falling 0.046R → 0.012R. Cost sensitivity
of the frozen cell (all 11,876 trades): **0.05% → −0.066R · 0.10% → −0.139R · 0.15% → −0.211R** — negative
even at a round trip cheaper than NSE cash equity can actually be traded at.

**WALK-FORWARD: KEEP = TRUE, the first time in this project's filter work.** 12 expanding folds, gate
picked on each train block and read on the next: every fold improved against its own ungated control
(median delta **+0.144R**, worst **+0.06R**), though only 1 of the 12 test blocks was itself positive.
That is what a COST filter should look like — it removes an arithmetic penalty, it does not invent a
signal. And that is the limit of it: net stays negative at every eligible threshold, and the cells where
the break-even arithmetic says the gate must live (≥1.0%, needing an 8.03% stop at the measured gross)
keep 3.1% / 0.6% / 0.2% of the book and are ineligible under the coverage floor. The 2.0% cell's
+0.351R over 31 OOS trades is noise, not a result, and its CI spans zero by construction.

**THE MECHANISM'S PREMISE FAILS HERE TOO.** Gross falls monotonically as the gate rises
(+0.046 → +0.012 → −0.018), i.e. trades with wide STRUCTURAL stops are not "the same signal, cheaper" —
they are a worse population, because a wide stop means the invalidation is far away. Same finding as
`liquiditySweep` below, same direction, measured independently.

**LAYER INTERACTION, REPORTED BECAUSE IT IS REAL AND SMALL.** At gate 0.5% the layer steps become
A→B +0.000 · B→C **+0.018** · C→D@1x **+0.014** (OOS): once the tight-stop trades are removed, the retest
step stops being negative (it was −0.041 ungated). It does not rescue the strategy — every cell under the
gate is still deeply negative — but it says the retest's failure was partly a STOP-POPULATION effect, not
purely a signal failure.

**CONCLUSION FOR S2:** its gross is real and positive (+0.046..+0.056R at the C/D layers, OOS) but
smaller than the cheapest achievable cost; the min-stop gate removes 56% of the loss and cannot close it.
The next lever for this strategy is the ENTRY and the EXIT STRUCTURE (gross), not the cost ratio. Its best
measured configuration on the verified tape remains **−0.132R OOS**.

**RESULT, `liquiditySweep` (2026-09-27) — AXIS CLOSED, AND THE MECHANISM'S PREMISE IS FALSIFIED.**
`.freebuff/sweep-mingate.js` → `data/liquidity_mingate_grid.json` (498 symbols, 142 sessions; the
current w030 @2R config, gate chosen on dev among cells keeping ≥10% of signals). The cost term does
exactly what the identity promises — costR falls 0.177R → 0.043R as the gate moves 0 → 2.0% — but GROSS
falls with it, +0.028R → −0.131R:

| gate | kept | keep% | medRisk% | grossR | costR | netR | win% | stop% |
|---|---|---|---|---|---|---|---|---|
| 0 | 43,475 | 100% | 0.574 | +0.028 | 0.177 | −0.149 | 37.8 | 51 |
| 0.5 | 30,440 | 70.0% | 0.673 | +0.001 | 0.144 | −0.143 | 37.9 | 49 |
| 0.75 | 11,940 | 27.5% | 0.922 | −0.021 | 0.104 | −0.125 | 39.0 | 45 |
| 1.0 | 4,676 | 10.8% | 1.192 | −0.038 | 0.080 | −0.118 | 40.0 | 41 |
| 1.5 | 914 | 2.1% | 1.758 | −0.088 | 0.055 | −0.143 | 38.9 | 36 |
| 2.0 | 258 | 0.6% | 2.262 | −0.131 | 0.043 | −0.174 | 40.7 | 31 |

Dev-selected cell: gate 1.0% → **OOS −0.132R over 1,494 trades, gross −0.051R, cost 0.081R, bootstrap
[−0.192, −0.076]**, and **0/12 walk-forward folds held** (median delta +0.015R, worst −0.059R). WHY,
mechanically: a stop ≥1% of price on a 1-minute name means the invalidation is far away BECAUSE the move
was already extended, so the same R multiple is a far larger price move — the tail shows the excursion in
R SHRINKS as the stop widens (MFE median 0.6R and 33% of trades reach 1R at the gate, against 0.9R / 45%
ungated). The gate does not select "the same signal, cheaper"; it selects a different and worse
population. The original w005 width behaves identically (−0.302R → best −0.138R dev / −0.169R OOS at gate
1.0%). **Conclusion: this exact `liquiditySweep` config is RETIRED, per the pre-registered rule** (the
gate was its last unexplored lever). It is revisited only with new information — real orderflow from the
S1 capture, which would sharpen the sweep DETECTION rather than the exit.

**Strategy 3 — absorption / order-flow (`aggShortCircuit` territory, NOT `liquiditySweep`):** blocked on
the feed, not on ideas. `data/orderflow/` is empty and `.freebuff/verify-bqsq.js` has not yet had a
session to read. The capture path is armed unconditionally on server boot (`Server.js` →
`orderflow.start()` → `capture.start()` + `tickBoard.onTickHook`), so the first session the app runs with
a broker session writes `data/orderflow/ticks-<day>.jsonl`; the only missing ingredient was a running
server during market hours, not wiring. If the verdict is RESTING-BOOK this strategy stays NOT BUILT and
the bq/sq series is used, if at all, as an explicitly named book-imbalance proxy.

**`liquiditySweep` (the conversation's "S3") is a SEPARATE hypothesis from order-flow absorption** and is
measured by `data/liquidity_stopwidth_grid*.json` + `data/liquidity_mingate_grid.json`, not by the feed.

## 6. Artifacts (one per pass, and each pass names its axis in the file)

`data/improve_<strategy>_<axis>.json` — pre-registered hypothesis, dev stats, fold rows, the gate
outcome, and the reason for keep/reject. A pass without its artifact did not happen.

## 7. How to run one pass

```bash
node .freebuff/audit-metrics.js --symbols=20 --sessions=43   # correctness gate for the metric layer
node gb_scoring_v2/github/backtest.js --minSessions=128 --progressEvery=100
```
