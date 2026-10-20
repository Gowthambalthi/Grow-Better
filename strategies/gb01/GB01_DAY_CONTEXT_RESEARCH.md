# GB01 — the "down after an up day" gate

**Date:** 2026-10-19 · **Verdict:** gate measured, unsupported, shipped **OFF**; the two
numbers are recorded on every signal so the live tape can settle it.

---

## The question

> If a stock goes down more than X% today, and yesterday (or the day before) it was
> up, it may not keep going down — yesterday's buyers were the sellers, not the
> company. GB01's target is 1.5 ATR and it may not reach it. Find that X and gate it.

Two separate claims live in that paragraph, and they turn out to have different
answers:

1. **A day-context filter helps** — "don't long a stock that is down today after
   being up yesterday".
2. **The 1.5R target often does not arrive** — a statement about the exit, not the entry.

Claim 2 is true. Claim 1 is not measurable on this corpus, and what evidence exists
points the other way.

---

## Method

| | |
|---|---|
| Corpus | `data/ohlcv_1m_full` — **1031 symbols**, one continuous tape per symbol |
| Engine | `strategies/fvg` GB01/GB02, shipped config (`minAtrPct 0.60`, MTF on) |
| Trades | one per symbol per day, `backtest/follow.js` rules (next-open fill, stop-first tie, intraday hold) |
| Costs | 0.05% round trip |
| Split | dev ≤ 2026-05-13, holdout > 2026-05-13 |
| Reproduce | `node scratch/gb01_down_after_up_study.js` · `node scratch/gb01_gate_buckets.js` · `node scratch/gb01_gate_stability.js` |

Features: `dayChangePct` = entry vs **today's first open**; `prevDayPct` = yesterday's
close vs the close before it.

---

## Baseline — and the thing that matters more than the gate

| slice | trades | netPF | R | exp | T1 | T2 | stop |
|---|---|---|---|---|---|---|---|
| **both** | 301 | 1.289 | +103.83 | +0.345 | 74 | 29 | 195 |
| **LONG** | 227 | **1.027** | +34.07 | +0.15 | 51 | 22 | 153 |
| **SHORT** | 74 | **2.246** | +69.76 | +0.943 | 23 | 7 | 42 |

The long book — 75% of the signals — is at **netPF 1.03**, i.e. it pays for its costs
and nothing else. The short book carries the result.

**How often 1.5R actually arrives** (claim 2):

| side | reached target | stopped |
|---|---|---|
| LONG | **32%** | **67%** |
| SHORT | 41% | 57% |

So the observation that "the 1.5R target may not reach" is correct: two thirds of longs
stop first.

Is the side split stable in a half it was not chosen on?

| | dev | holdout |
|---|---|---|
| LONG | 151 tr · 1.14 · +15.87R | 76 tr · **0.81** · −11.13R |
| SHORT | 49 tr · 2.09 · +34.74R | 25 tr · **2.57** · +24.52R |

Shorts are positive in both halves. Longs are weak and getting worse, but not
reliably negative — 76 holdout trades at 0.81 is a warning, not a proof.

> Context: the board quotes GB01 at netPF 1.94. That number is the 100-symbol
> canonical corpus, which this run reproduces exactly (73 trades, 1.94). Across
> 1031 symbols the same rules return 1.289. The headline is a small-sample
> result, not a contradiction of the engine.

---

## Result 1 — there is no X

Longs that are down today after an up yesterday:

| X | cell trades | cell netPF | cell R | everything else |
|---|---|---|---|---|
| 0.0% | **6** | 0.961 | +0.41R | 221 tr · 1.029 |
| 0.5% | **3** | 0.000 | −3.00R | 224 tr · 1.047 |
| 1.0% | **1** | 0.000 | −1.00R | 226 tr · 1.034 |
| ≥1.5% | **0** | — | — | 227 tr · 1.027 |

The cell is **2.6% of the long book**, and above 1.5% it is **empty**. There is no
threshold to pick: at any X worth naming, the gate blocks nothing, because GB01's
own MTF confirmation (15m trend + VWAP alignment) already keeps it from longing
stocks that are falling on the day. The gate and the engine's existing filter are
asking the same question, and the engine asks it first.

**Why 3-for-3 losses is not evidence.** GB01's long win rate is 35%. The chance of
three straight stops is `0.65³ = 0.27` — the gate's entire "edge" is an event that
happens by luck a quarter of the time. Telling a 15% cell win rate from 33% at 95%
confidence needs roughly **100 trades in the cell**. The corpus has 3.

Applying the gate anyway:

| gate | all | holdout |
|---|---|---|
| A · X=0.5 | 224 tr · 1.047 · +37.07R | 76 tr · 0.813 · −2.15R |
| A · X=1.0 | 226 tr · 1.034 · +35.07R | 77 tr · 0.799 · −3.15R |
| A · X≥1.5 | 227 tr · 1.027 · +34.07R | unchanged — no-op |
| B · prev **or** prev2 up, X=1 | 223 tr · 1.041 · +35.82R | 76 tr · **0.78** · −4.39R |

Whole-sample PF moves by 0.01–0.02 and the holdout gets *worse* under gate B. This is
noise trading with a filter attached.

---

## Result 2 — the day's move does not separate outcomes, either way

Every GB01 trade bucketed by today's move (both sides, 301 trades):

| dayChangePct | trades | netPF | R |
|---|---|---|---|
| ≤ −3% | 26 | 1.28 | +8.93 |
| −3…−2% | 11 | 2.39 | +13.27 |
| −2…−1% | 9 | 0.45 | −3.79 |
| −1…0% | 12 | 2.41 | +13.11 |
| 0…+1% | 14 | 1.18 | +3.64 |
| +1…+2% | 5 | 2.57 | +5.84 |
| +2…+3% | 23 | 1.38 | +7.69 |
| ≥ +3% | 201 | 1.19 | +55.13 |

No monotone trend — down days are not worse than up days, and the biggest bucket
(≥ +3%, 201 trades) earns the *lowest* PF of the large cells.

The hypothesis cell, side by side:

| | trades | netPF | exp |
|---|---|---|---|
| down >1% today **AND** prev up | 23 | 1.23 | +0.320 |
| down >1% today, prev **not** up | 23 | 1.44 | +0.480 |
| not down 1%, prev up | 165 | 1.28 | +0.338 |
| not down 1%, prev not up | 90 | 1.29 | +0.330 |

All four cells sit at 1.2–1.4. "Down today after an up day" is **not a losing
subset**; taken literally, the opposite reading is available (down >2% today, any
prev day: 1.62).

---

## Result 3 — the one bucket that survived a split

Scanning buckets produces hypotheses, so every bucket was re-tested on a split it
was not chosen on. Exactly one is negative in both halves with ≥8 trades each:

| prevDayPct | dev | holdout |
|---|---|---|
| **+1…+2%** | 23 tr · 0.81 · −3.51R | 13 tr · **0.27** · −9.14R |

"The day before was up, but only mildly" is bad for GB01 longs. It is **not** the
user's rule (it ignores today's move entirely), it is **not monotone** — the adjacent
buckets are 0.75 dev / 1.76 hold at 0–1% and 4.18 dev / 0 hold at 2–3% — and 36 trades
of a scanned bucket is exactly the sample size that produces this by chance. Recorded
here as a hypothesis for the live data, **not shipped**.

---

## Decision

**The gate is not enabled.** The reasons are in order of strength:

1. It has no population: 6 of 227 longs, 0 above 1.5%. Enabling it changes almost
   nothing while adding a live decision path nobody can evaluate.
2. Its direction is not supported: the bucket sweep puts the hypothesised cell at
   netPF 1.23 against 1.28 for everything else.
3. The sample cannot distinguish the effect from noise, and the split shows the
   alternate gate (B) *worsening* the holdout.
4. A filter that fires three times in a 1031-symbol corpus is exactly the kind of
   change that looks like rigor and functions as overfitting.

**What shipped instead:**

- `setupData.dayChangePct` and `setupData.prevDayPct` are recorded on **every** GB01
  signal, accepted or refused. No decision reads them.
- `blockLongAfterUpDay` exists and is `null` by default. Enabling it is deliberate:
  `{ dropPct: 0.5, minPrevDayPct: 0 }`.
- The live adapter now carries the **last two session closes** per symbol across its
  per-session engine reset, so `prevDayPct` is not permanently null on the live tape.
  `seedPriorCloses()` seeds only closes — a seeded day has null high/low rather than a
  range that never printed.
- A gate whose input is unknown (fewer than two observed sessions) **does not fire**:
  unknown is not "was flat".

Files: `strategies/fvg/index.js`, `strategies/fvg/liveAdapter.js`,
`strategy-core/session.js`, `test/fvgDayContext.test.js` (7 tests).

**Verified on real data** (`node scratch/gb01_live_ctx_proof.js --symbols=150`): the
live adapter's carried closes equal each file's own session closes for **150/150
symbols, 0 mismatches**, both during the third session and after a rollover. No real
GB01 signal fired in those 150 symbol-triples — consistent with the rarity measured
above, so the recorded numbers were exercised by the synthetic test rather than by a
live call.

**No decisions changed.** Re-running the study after the edit returns the identical
result it returned before it: 100 symbols → 73 trades, netPF 1.94. The gate is
`null`; the engine behaves exactly as it did.

## What would change the answer

The live tape, not another backtest slice. Each GB01 long now stamps the day move and
yesterday's move; after ~40 such calls the cell can be counted without a filter in the
way. Until then the honest state is **unmeasured**, and the board should not behave as
though it knows.
