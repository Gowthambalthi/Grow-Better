# OF_MOMENTUM — what the 65% actually was, and what 13 sessions of tape say

**Date:** 2026-10-19
**Question:** the board showed `OF_MOMENTUM 65.0% win (20 decided / 30 calls)`. Was it performing
that well, and can it be backtested / reproduced?

**Short answer.** The 65% is a real reading of a *snapshot of 20 decisions from a two-session book*.
Those two sessions produce 30 calls / 27 decided, and the final record is +11.55R at 0.05%
round-trip cost (+0.428R/trade, PF 2.19). Only **13 of 27** reached target (48.1%); 18 of 27 closed
green (66.7%), which is what the board's status field counts, and 15/27 is what the shared classifier
counts.

Replaying the same gate on every recorded tick tape — 13 sessions, 333 decided calls — gives
**24.6% target hits and −0.297R/trade (PF 0.60)**. The two results are not two estimates of one
number: §4 shows that on the day both were measured the gate passed **3,131 symbol-minutes** and the
six-slot board admitted **21** calls, so which names get in *is* the decision — and it is not the
gate.

---

## 1. Reconstructing the 65%

`30 calls` is exact: the minute engine armed 21 OF_MOMENTUM calls on 2026-10-13 and 9 on
2026-10-16, and no other session has any. At the moment the board was read, 20 of the 30 had
decided and 13 had won — 65.0%. By the close of 10-16 the same book read 27 decided / 18 won
(66.7%).

The screenshot therefore dates from mid-session on 2026-10-16, not from a finished record. It is not
wrong; it is 20 trades.

## 2. The live record, measured at the cost the backtests use

Every decided call is priced in R over its **original** risk (`riskPts`, the fill-to-stop distance
at arm time — the book later moves `stopLoss` as a call trails, so the stored stop is not the risk),
with 0.05% round trip charged in R the way `backtest/metrics.js` charges it.

| set | trades | target hits | net R | expectancy | netPF |
|---|---|---|---|---|---|
| both sessions | 27 | 13 (48.1%) | **+11.55R** | +0.428R | 2.19 |
| LONG | 19 | 10 (52.6%) | +11.70R | +0.616R | 3.36 |
| SHORT | 8 | 3 (37.5%) | −0.14R | −0.018R | 0.97 |
| 2026-10-13 | 18 | 12 | +8.48R | +0.471R | 2.42 |
| 2026-10-16 | 9 | 6 | +3.08R | +0.342R | 1.83 |

Three different "win rates" describe this same book, and they are all correct about different
questions:

- **48.1%** (13/27) reached the target — the strategy's own payoff.
- **55.6%** (15/27) is `classify()`'s verdict. It excludes the three BREAKEVEN_EXIT calls by *reason*
  even though they banked a small profit.
- **66.7%** (18/27) made money after cost, and is what the board's status field (and the 65% in the
  screenshot) counts.

A 65% that means "18 of 27 closed green on two days, and 13 of them hit target" is not what a reader
hears from "65% win".

Exits: 13 TARGET_HIT, 7 STOP_LOSS_HIT, 4 STAGNATION_EXIT, 3 BREAKEVEN_EXIT. Stop width 45–55 bps
(median 47), target 1.5× risk, so cost is 0.107R/trade (range 0.090–0.111R).

Two things to hold onto: the entire positive record is the **long** side, and it is 27 trades over
two sessions.

## 3. The same gate, on 13 recorded sessions of tape

Method — `scratch/of_momentum_tick_replay.js`: real recorded ticks (bid/ask/depth included, ~95% of
rows), fed through the engine's own `ingestTick()` and `scanMinuteTape()`, one scan per tape minute,
clock pinned to the tape, `GB_ENABLE_OF_MOMENTUM=1`, its own journal, Telegram dispatch stubbed.
Outcome classified by `callBookHistory.classify` — the same function the board's win rate goes
through. Tapes: 2026-09-28 → 2026-10-19, the 13 files that carry a session (10-17/10-18 are
stubs). Two of them — 10-05 (6 MB) and 10-09 (50 MB) — are partial recordings and produced **no**
calls; 11 sessions have decisions.

| session | calls | decided | target | profitable | netPF | net R |
|---|---|---|---|---|---|---|
| 2026-09-28 | 19 | 19 | 15.8% | 36.8% | 0.46 | −8.26 |
| 2026-09-29 | 36 | 36 | 33.3% | 47.2% | 0.93 | −1.66 |
| 2026-09-30 | 44 | 40 | 25.0% | 32.5% | 0.50 | −16.64 |
| 2026-10-01 | 33 | 27 | 22.2% | 25.9% | 0.24 | −30.54 |
| 2026-10-06 | 39 | 39 | 43.6% | 61.5% | 1.68 | **+12.24** |
| 2026-10-07 | 59 | 59 | 20.3% | 35.6% | 0.48 | −22.50 |
| 2026-10-08 | 10 | 10 | 20.0% | 20.0% | 0.28 | −7.64 |
| 2026-10-12 | 25 | 25 | 20.0% | 36.0% | 0.49 | −9.04 |
| 2026-10-13 | 21 | 21 | 9.5% | 61.9% | 0.98 | −0.19 |
| 2026-10-16 | 21 | 21 | 42.9% | 52.4% | 1.71 | **+5.76** |
| 2026-10-19 | 36 | 36 | 11.1% | 30.6% | 0.28 | −20.39 |

| pooled | trades | target | profitable | netPF | net R | expectancy | maxDD |
|---|---|---|---|---|---|---|---|
| all | 333 | 24.6% | 40.5% | **0.60** | **−98.86R** | **−0.297R** (SE 0.073) | 100.05R |
| LONG | 313 | 24.9% | 39.6% | 0.59 | −97.67R | −0.312R | 98.96R |
| SHORT | 20 | 20.0% | 55.0% | 0.87 | −1.19R | −0.059R | 4.08R |

Dev (first 7 sessions, 230 trades): −0.326R/trade, PF 0.59.
Holdout (last 4, 103 trades): −0.232R/trade, PF 0.62. The sign does not flip; the level does not
improve.

Exits: 173 STOP_LOSS_HIT, 82 TARGET_HIT, 42 BREAKEVEN_EXIT, 36 SESSION_CLOSE.
Two of eleven sessions with decisions are positive.

## 4. Why the tape and the live book disagree — and why that is the finding

The replay does **not** reproduce the live calls. On 2026-10-13 it shares 1 symbol of 13 with the
live book; on 2026-10-16, **0 of 9**. That is not a bug in the harness, and it is not a change to
the gate:

- The arming conjunction for this setup is unchanged from the 2026-10-14 engine snapshot
  (`handoff/zc/…`), and `pickStopGeometry()` — the function that turns a pass into a call — is
  **byte-identical** (40 lines, zero diff). The changes since then are the enable flag, the funnel
  counters and the telemetry rows; `minDelta`, `requiredConfluence`, the vwap band, the day-change
  threshold and the price cap are all unmoved.
- The tape carries the depth the gate reads (bid/ask on ~95% of rows; the engine orients them).

What differs is **admission**. Gate telemetry on the 2026-10-16 tape, through 14:17 IST:

- **3,131** symbol-minutes passed every long gate *and* the stop-geometry check;
- **99 of 152** scans had **0 of 6** board slots free (`maxSlots: 6`, `no_structure: 0`);
- the run made **21** calls; the live book made 9. Not one of the 9 is a name the tape called on
  10-16. SHANTIGOLD, which live admitted at 10:50, had a *passing* gate on the tape's own numbers in
  five consecutive minutes (10:43–10:47: vwap distance 0.21–0.36%, day change +0.65–0.80%, delta
  0.25–0.52, confluence 2–3 against a threshold of 2) and was still never admitted.

So the strategy's daily result is set by a **first-come, six-slot admission race** over a gate that
fires on ~20 symbol-minutes per scan. Two runs of the same code on the same tape disagree because
the board fills with different names, and each day the P&L is one draw from that race. That is also
why the live two-session record (+0.43R/trade) and the tape's thirteen-session record
(−0.30R/trade) can both be true statements about *different draws of the same allocator*.

A 20-decision snapshot of a six-slot race is not a win rate. It is one hand of cards.

## 5. Verdict

- **"65%" is not retrievable as a property of OF_MOMENTUM.** It is 13 of the 20 decisions that had
  resolved when the board was read, out of a 27-decision two-session record. Only 13 of those 27
  reached target; 3 of the 18 "wins" are breakeven exits the board's status field scores as wins.
- **The live record is genuinely positive** (+11.55R net, PF 2.19) and worth not throwing away. On
  its own it is not yet distinguishable from zero: mean +0.428R, sd 1.196, SE 0.230, so t ≈ 1.9
  (two-sided p ≈ 0.07). What it *is* distinguishable from is the replay's −0.297R (difference 0.725R,
  SE 0.241, t ≈ 3.0) — which is why the gap has to be explained by a different process, not by
  sampling noise, and why neither number by itself settles the setup.
- **The edge, if there is one, is in selection, not in the gate.** The gate admits far more than the
  book can hold (3,131 passes, 21 calls in a day, six slots). Nothing measured here ranks those passes
  by forward outcome. That is the experiment worth running: bucket the 3,131 passes by score /
  delta / vwap distance and ask which bucket the +0.43R came from.
- **Do not re-arm it live on the strength of the 65%.** If it is re-armed, cap it, log every
  admission with its score and its rank among that minute's candidates, and judge it on 100+
  decisions, not 20.

## 6. Limitations

- The replay's feed is the recorded 1 Hz tick set, not the live websocket. Its bars (and therefore
  `volSurge`, high/low structure and the stop geometry built from them) can differ from what the
  live engine saw. This is a plausible partial cause of the symbol-level disagreement, and it is not
  separated from the admission race by anything measured here.
- The replay book holds OF_MOMENTUM alone. Live also wrote 9 SWEEP_FVG calls on 10-16 from a
  separate writer; whether that writer competes for this engine's six slots is not measured here, so
  the replay is a single-engine board whatever the live one was.
- 13 sessions, one market regime, and a corpus that is the symbols subscribed on those days — not
  survivorship-free.
- Cost is 0.05% round trip; no slippage beyond the stop. The live fills already show what that
  omits: SHANTIGOLD exited at −1.18R against a 45 bps stop, i.e. 18% worse than the stop price.
- The 10-16 telemetry run was cut at 14:17 IST, so the 3,131 / 99-of-152 figures cover that window,
  not the full session.

## Artifacts

| path | what |
|---|---|
| `scratch/of_momentum_tick_replay.js` | the replay harness (used for every session) |
| `scratch/ofm-replay/run_all.sh` | driver, 4 sessions in parallel |
| `scratch/ofm-replay/aggregate.js` | pools the dumps; all pooled/ per-session numbers above |
| `scratch/ofm-replay/compare.js` | live vs replay symbol overlap per session |
| `scratch/ofm-replay/calls-<day>.json` | raw call book per session (13 files) |
| `scratch/ofm-replay/log-<day>.txt` | per-session engine log |
| `scratch/ofm-replay/tel1016/` | 10-16 gate-funnel telemetry (through 14:17 IST) |

No strategy, harness or test code was modified.
