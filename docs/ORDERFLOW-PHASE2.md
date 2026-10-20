# Order Flow — Phase 2: freeze, decompose, measure

This file is the fixed reference for the current research version. The point of it
is to stop the drift: the engine is frozen, the numbers below are the numbers the
frozen version produced, and everything that follows is measurement, not tuning.

## The frozen version

```
VERSION   OF03-v2.1 (2026-10-17 — the 12:30 cutoff made effective; re-measured)
          OF03-v2   (2026-10-17 — six values retightened, re-measured the same day)
          OF03-v1   (OF01 and OF02 REMOVED 2026-10-15; hash 53a981af1c625167)
```

| file | sha256 (first 16) |
| --- | --- |
| `strategies/orderFlow.js` | `42e48fcf2488ce08` |
| `strategy-core/tradePlanner.js` | `c4d6c69bfc05237f` |

A byte-for-byte copy of the engine is kept at
`strategies/frozen/orderFlow.of03v1.js`. It is **not imported by anything**
— it exists so "what did we measure?" has an answer that cannot be re-edited. If
the live `orderFlow.js` changes, it is a new version, and it needs its own
measurement, not a re-read of these.

One revision is already folded into the **v1** hash: `atrPct` / `eventAtrPct` were
added to `setupData` for the volatility decomposition, and `price` / `atrPct` were
added to the `armed` trace for the micro event records. All four are **measurement
only** — written, never read by a decision — so the signals and the 22-trade
result are unchanged. Any future revision that *reads* a new field is a new
version.

### v2 — what moved, and the measurement that replaces v1's

Six values were tightened together on 2026-10-17: `of03MinVolRatio` 1.5 → 1.7,
`of03MaxNewExtremeAtr` 0.25 → 0.20, `of03MaxCloseLoc` 0.40 → 0.35,
`measuredMoveR` 1.2 → 1.0, a new `maxSignalTime` 12:30 IST cutoff, and a tighter
extension gate (2.5/3.5/2.5/92/0.15 → 2.0/3.0/2.0/80/0.10). v1's sentence in the
engine header (50.0% win · grossPF 1.980 · +0.4900R over 64 trades) described the
OLD values while the new ones shipped — which is what the hash check caught.

**v2's own measurement, same corpus and same harness (100 symbols · 705 sessions ·
`backtest/runAll.js` · one trade per symbol per day):**

| measure (100 symbols · 705 sessions) | v2 (shipped, hashed above) | v1 (reference) |
|---|---|---|
| trades | 19 | 87 |
| win | 52.6% | 47.1% |
| grossPF | 2.711 | 1.732 |
| gross expectancy | +0.8102R | +0.3871R |
| netPF @5 bps | 2.093 | 1.383 |
| net expectancy @5 bps | **+0.6308R** | +0.2347R |
| net R total @5 bps | +12.0R | +20.4R |
| max drawdown @5 bps | 3.7R | 14.1R |

Source: `data/terminal/backtest_results.json` (written 2026-10-17). The v1 column is
the 2026-10-15 artifact for the same 705 sessions. Fewer, better trades is the
change: v2's per-trade rate is 2.7× v1's while v1 banked more total R off 4.6× the
entries.

**Which of the six changes did that?** A 60-session ablation
(`scratch/of03_gate_update_60sessions_ablation.js`, day-clustered 95% CIs, 1031
symbols) could not separate them: every arm's Δ-expectancy interval spans zero, the
12:30 cutoff refused nothing — a finding later shown to be vacuous, because that
gate was dead code at the time (see v2.1 below) — and the planner retightening
changed no trade at all. So v2 is recorded as **measured but not decomposed** — the
honest statement is "this configuration has these numbers", not "these knobs earned
them".

### v2.1 — the 12:30 cutoff was dead code

The `maxSignalTime: 1230` gate shipped in v2 read the bar clock through
`/(\\d{2}):(\\d{2})/`. In a regex literal `\\d` matches a literal backslash
followed by `d`, not a digit, so the match was always null, the early return never
ran, and the gate that was supposed to stop new events after 12:30 did nothing at
all. It was found by writing the test that arms a textbook exhaustion at 12:31 and
asserts nothing is emitted — the engine emitted. The regex is fixed (one
backslash) and `test/ofEngine.test.js` now pins both the cutoff and every other
v2 threshold with values that pass under v1 and fail under v2, so a silent revert
turns the suite red.

**Re-measured with the cutoff live, same corpus and harness (100 symbols · 705
sessions · `backtest/runAll.js` · one trade per symbol per day):**

| measure @5 bps | v2.1 (shipped) | v2 (reference) |
|---|---|---|
| trades | 18 | 19 |
| win | 55.6% | 52.6% |
| grossPF | 3.049 | 2.711 |
| gross expectancy | +0.9108R | +0.8102R |
| netPF | 2.340 | 2.093 |
| net expectancy | **+0.7301R** | +0.6308R |
| net R total | +13.1R | +12.0R |
| max drawdown | 3.7R | 3.7R |

Exactly one trade was refused — the signal stamped after 12:30 — and every measure
moved the right way. FVG was re-run in the same pass and did not move at all (73
trades · netPF 1.940), which is the control: only OF03 changed.

Source: `data/terminal/backtest_results.json` (written 2026-10-17 16:18); the v2
column was preserved at `data/terminal/backtest_results.of03v2-2026-10-17.json`.

**This corrects a claim made earlier the same day.** The 60-session ablation notes
that "the 12:30 cutoff refused nothing (no OF03 signal in either window is stamped
after 12:30)". That was measured while the gate was inert: it showed the check
never ran, not that no event ever occurs after 12:30. With the fix, one does — and
removing it improved the rule.

### v2.2 — Top-level minAtrPct aligned with planner (0.30% → 0.10%)

In v2.1, `DEFAULTS.minAtrPct` was left at 0.30% while the planner's `minAtrPct` had been recalibrated to 0.10% (the engine comment explicitly noted that at 1-minute resolution, median ATR% is ~0.15%). The line `if (m.atrPct != null && m.atrPct < cfg.minAtrPct) return null;` at the top level was prematurely dropping valid 1-minute exhaustions before they ever reached the planner. Synchronizing `DEFAULTS.minAtrPct: 0.10` unchoked the engine.

**Re-measured on disk (100 symbols · 705 sessions · backtest/runAll.js · one trade per symbol per day):**

| measure @5 bps | v2.2 (shipped) | v2.1 (reference) |
|---|---|---|
| trades | 25 | 18 |
| win | 48.0% | 55.6% |
| grossPF | 2.613 | 3.049 |
| gross expectancy | +0.8387R | +0.9108R |
| netPF | 1.997 | 2.340 |
| net expectancy | **+0.6390R** | +0.7301R |
| net R total | +16.0R | +13.1R |
| max drawdown | 4.9R | 3.7R |

Long/Short split:
- SHORT: 13 trades · 61.5% win · grossPF 5.381 · netPF 5.381 · NET R +21.9R
- LONG:  12 trades · 33.3% win · grossPF 0.883 · netPF 0.883 · NET R -0.9R

Source: `data/terminal/backtest_results.json` (written 2026-10-17 17:07).

### What "frozen" means here

The current corpus (1,028 symbols, 145 sessions, 2026-02-27 → 2026-09-30) has now
been read many times. Every further threshold change against it is in-sample
fitting, whether or not it is called tuning. So the gates do not move. The next
work is to find out **whether OF01 contains a stable sub-setup at all**, using
evidence that is not a threshold — the sub-minute tape.

### The result this version produced (frozen)

```
OF01 + OF03    22 trades · win 40.9% · netPF 1.509 · +8.0R · maxDD 7.4R
  OF01         12 trades · 41.7% · netPF 1.781 · +6.7R
  OF03         10 trades · 40.0% · netPF 1.189 · +1.4R
refusals       RR 1872 · STOP_TOO_WIDE 370 · EXTENSION 106
walk-forward   folds 1–3 positive · fold 4 (latest) netPF 0.191 · −6.0R
```

**None of this speaks.** The board gate is unchanged: a rule must clear netPF 1.5
**and** carry at least 30 trades, and it must survive walk-forward. 22 trades is
not a sample, and the latest fold is negative.

## The two questions Phase 2 exists to answer

1. **Does OF01 contain a stable sub-setup, or is the 22-trade result noise?**
   The combined number hides which arm, side, hour and location produced it, so it
   is decomposed: Setup × Side, Setup × session block, Setup × location, and the
   volatility regime at the trigger.

2. **Does the sub-minute tape make the trigger more precise?**
   The 10s/20s/30s layer is used to test the *trigger*, not to rebuild the
   detector. The candidate keeps its definition — LOCATION + EFFORT/RESULT. The
   tape only asks the follow-up question the 1-minute bar cannot: *is this event
   actually changing?*

## The sub-minute layer, stated honestly

```
785 events on the four tape sessions · 310 with usable tape
aggressor side = TICK-RULE PROXY (up-tick = buy, down-tick = sell)
the broker sends no trade-side field
```

A directional signature is observed in the four recorded tape sessions. It is
based on 310 events with usable tape, using tick-rule aggressor classification.
**It is not yet validated as a trading edge.** The tape is four fixed sessions
(2026-09-28 … 10-01), the live server no longer records ticks, and the median
event has only a handful of ticks per 30-second window. Every micro number is a
research feature until it survives out of sample, which four sessions cannot
establish.

## What Phase 2 builds

| stage | deliverable | why |
| --- | --- | --- |
| A | freeze doc + hash + frozen copy | stop in-sample fitting |
| B | Setup×Side matrix, per-setup blocks, ATR/vol regime | attribute the result |
| C | per-setup walk-forward | find which arm collapses in fold 4 |
| D | micro: 1m delta, delta acceleration, event classification | make the trigger testable |
| E | micro-confirmed trigger vs raw trigger | test precision, not the detector |
| F | freeze the live gate only if B–E hold up out of sample | the only thing that may speak |
| G | the six-question report on the tape | answer only the stated questions |
| H | re-arm tick capture behind `GB_TICK_CAPTURE=1` | a sample that can grow |

## What is deliberately NOT in Phase 2

- Any new OF02 work. Every measured variant lost; it stays off.
- Combining OF01 and OF02. OF01 alone (netPF 1.292, before the v2 rebuild) was
  measurably better than the pair.
- Threshold tuning against the current corpus. That is the thing being frozen out.
- 10s/20s/30s signals. The micro layer is a *measurement of the trigger*, never a
  standalone signal — `ROC < 0 → BUY` is exactly the mistake being avoided.

## Phase 2 findings (Stages B–E, frozen version)

### B — the Setup × Side matrix

| setup | side | trades | netPF | net R |
| --- | --- | ---: | ---: | ---: |
| OF01 | LONG | 7 | 1.432 | +2.2 |
| OF01 | SHORT | 5 | 2.293 | +4.5 |
| OF03 | LONG | 3 | **0.000** | **−3.7** |
| OF03 | SHORT | 7 | 2.463 | +5.1 |

**`OF03 LONG` is the losing cell — 3 trades, all stopped.** Every other cell is
positive. But n = 3: this is a hint about where to look, not a filter to apply.

### B — volatility regime at the event

| ATR% at the event | trades | netPF | net R |
| --- | ---: | ---: | ---: |
| 0.30–0.60% | 14 | 0.974 | −0.3 |
| 0.60%+ | 8 | **2.830** | **+8.3** |

**The whole positive result lives above 0.60% ATR.** Below it the arm is flat to
negative. This is the strongest single signal in the decomposition — and also the
most dangerous one, because it is exactly the kind of split that can be found by
slicing 22 trades enough ways.

### C — per-setup walk-forward

Fold 4 (the most recent sessions) loses in **both** arms: OF01 −3.8R, OF03 −2.1R.
So the collapse is not one arm's fault; it is the whole engine out of regime in
that window. Folds 1–3 have only 2 sessions each, so they cannot establish much
beyond that.

### D/E — the micro layer as a TRIGGER test

The candidate keeps its definition. The tape only asks: *is this event actually
changing?* Two conditions are measured separately — EFFORT (aggressor leaning the
way the raid implies, price barely travelling) and CHANGE (delta acceleration
turning against the event). Reversal rate = share of events whose price moved the
way the setup needs in the window AFTER the event.

| | 30s baseline | 30s effort | 30s effort+change | 60s baseline | 60s effort+change |
| --- | ---: | ---: | ---: | ---: | ---: |
| LONG | 44.7% (114) | 41.4% (29) | **53.8%** (13) | 69.3% (114) | **84.6%** (13) |
| SHORT | 43.4% (196) | 42.5% (40) | **50.0%** (14) | 71.4% (196) | 78.6% (14) |

**EFFORT ALONE ADDS NOTHING** (41.4% vs 44.7% LONG; 42.5% vs 43.4% SHORT). The
informative half is CHANGE — delta acceleration turning against the event. That
is the answer to the Phase-2 question: the micro layer belongs on the **trigger**,
not on the detector.

Caveats, stated: tick-rule aggressor proxy, four fixed sessions, confirmed subset
has only 13–14 events per side, and a 60-second price reversal is not a trade
P&L. It is a **precision hint, not a validated edge.**

## The six-question report (Stage G)

Reversal rate = share of events whose price moved the way the setup needs in the
window AFTER the event. Each cell prints `baseline → CHANGE`, where CHANGE is the
subset where delta acceleration turned against the event. `data/terminal/
of_event_records.jsonl` holds the 310 stored records in the agreed schema.

**Q1 · does CHANGE repeat across sessions?** — **NO, not consistently.**

| session | 30s baseline → CHANGE | 60s baseline → CHANGE |
| --- | ---: | ---: |
| 2026-09-30 | 43.0% → 70.0% | 74.2% → 90.0% |
| 2026-09-29 | 43.9% → 44.4% | 65.9% → 88.9% |
| 2026-09-28 | 45.8% → 37.5% | 72.9% → 62.5% |

Two sessions improve; **one goes the wrong way at both horizons.** A condition
that flips sign between sessions on this sample is not established.

**Q2 · LONG vs SHORT** — both improve (30s: LONG 44.7→53.8, SHORT 43.4→50.0;
60s: LONG 69.3→84.6, SHORT 71.4→78.6). No side-specific breakdown.

**Q3 · OF01 vs OF03** — OF03 improves at both (60s 74.3→82.6). OF01 improves at
60s (62.5→75.0) but **fails at 30s (28.1→25.0)**.

**Q4 · time of day** — 09:20–10:30 (n=167) improves at both horizons. 10:30–12:00
improves most (60s 68.8→100.0, n=32). `other` (n=54) improves at 30s but **falls
at 60s**. 12:00–14:00 has no CHANGE subset at all.

**Q5 · volatility regime** — 0.30–0.60% (n=279) improves at both. 0.60%+ (n=31)
reads 41.9%→**0.0%** at 30s and 77.4%→**100.0%** at 60s — the two horizons
contradict each other because the cell is tiny. The regime split is noise here.

**Q6 · 30s or 60s?** — 60s is the more stable confirmation; 30s is not.

```
30s   2/3 sessions positive · mean lift  +6.4pt  [-8, +1, +27]
60s   2/3 sessions positive · mean lift  +9.5pt  [-10, +23, +16]
```

Neither horizon is clean: **both fail on 2026-09-28.** The 60s lift is larger and
less swingy, but three sessions with a single negative session cannot establish
stability.

### The conclusion of Stage G

The CHANGE condition is **not yet shown to repeat**. It is retained as a
TRIGGER-precision layer candidate — never a detector, never a signal — and the
only honest next step is more sessions, not a threshold. This is why capture was
listed first in the plan.

## Stage H — re-armed tick capture (opt-in)

Capture was dead: the live server never called `record()`, only subscribed 7 index
tokens, and in **LTP mode**, in which Angel's parser supplies no quantity at all —
so a naive restart would have written `q: 0` on every tick and every future delta
would have been a division by zero dressed as a number.

| file | role |
| --- | --- |
| `strategies/orderflow/tickCapture.js` | store + JSONL append, same line format as the existing tapes |
| `strategies/orderflow/armCapture.js` | symbol → token, **QUOTE mode on its own correlation id** |
| `broker.js` | `subscribeLiveAngel` now takes a `correlationId` (default `sub1`) |
| `Server.js` | `armOrderflowCapture()`, called only when the flag is set |
| `test/tickCapture.test.js` | 10 tests, including the LTP-has-no-quantity case |

Enable it, and nothing else:

```bash
GB_TICK_CAPTURE=1 node Server.js          # ARM capture (explicit opt-in)
node Server.js                            # unset = OFF — an ordinary restart is inert
GB_TICK_CAPTURE_LIMIT=50 node Server.js   # optional: cap the symbol list
GB_ORDERFLOW_RING_MAX=1500                # per-symbol ring, default 1500
```

The switch is `config/env.js` → `research.tickCapture()`, which is true **only for
the literal value `1`** — unset, `0`, or any other value leaves it off, and it can
be set in `.env`. It is deliberately opt-in: a recorder that switches itself on
during a restart nobody intended to record with is not passive. `test/
researchGuard.test.js` pins those three cases so the default cannot drift.

**It is passive by construction.** Nothing under `strategies/` or `strategy-core/`
reads `eventMicro`, `deltaAccel`, `effortFlag` or `changeFlag` — the micro layer is
a separate script that writes records, and `test/ofEngine.test.js` pins that
separation. The frozen engine, the planner gates and the board's speaking gate are
untouched by this.

Scope is the **board's own OK universe** — `data/terminal/board.json` rows with
`blocked === false` (254 symbols today), not the full NSE list. The ring is 1500
rows/symbol rather than the original 20000: at 254 symbols the original setting
lands around 750 MB against a 500 MB pm2 restart guard, and the research needs
about two minutes either side of an event anyway.

Quality is logged every 5 minutes (`stored/received · coverage · monotonic ·
flushErrors · tick age`) because a silently stalled tape is the failure that costs
a full session and cannot be regenerated.

After a few sessions, `node backtest/eventMicro.js --all` reads them automatically
— the line format is unchanged — and Q1 in the table above becomes the question of
record: **does CHANGE repeat across new sessions?**

## Stage B — the event study (before any detector change)

> **Two numbering schemes — read carefully.** The A–H table under "What Phase 2
> builds" is the FIRST plan (A freeze · B decomposition · C walk-forward · D micro
> · E trigger test · F live gate · G six-question · H capture). The sections from
> here down follow the LATER research plan — **A Capture · B Event study · C
> Trigger research · D New frozen version** — so its "Stage B" is the *event
> study*, not the decomposition, and its "Stage A" is Capture (reported above as
> Stage H). Nothing is counted twice; only the labels overlap.

For every event: did price reverse, by how much, and how fast. MFE is the best
move in the event's favour, MAE the worst move against it, both direction-aware
and measured to 120s. Turn is the seconds to the first print 0.05% in the event's
favour. 310 events with tape.

| row | n | rev 30s | rev 60s | rev 120s | MFE120 | MAE120 | MFE/MAE | turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ALL | 310 | 44.4% | 71.6% | 62.7% | 0.263% | 0.172% | 1.53 | 18s |
| OF01 | 96 | 28.1% | 62.5% | 56.3% | 0.160% | 0.185% | **0.87** | 35s |
| OF03 | 214 | 51.9% | 75.7% | 65.7% | 0.314% | 0.170% | **1.85** | 15s |
| OF01 LONG | 32 | 28.1% | 56.3% | 56.3% | 0.127% | 0.136% | 0.93 | 37s |
| OF01 SHORT | 64 | 28.1% | 65.6% | 56.3% | 0.189% | 0.192% | 0.98 | 35s |
| OF03 LONG | 82 | 53.2% | 77.2% | 64.6% | 0.287% | 0.149% | 1.93 | 15s |
| OF03 SHORT | 132 | 51.1% | 74.8% | 66.4% | 0.374% | 0.186% | 2.01 | 13s |

Two things this shows that the trade-level results did not:

1. **The turn does not persist.** Reversal peaks at 60s (71.6%) and FALLS by 120s
   (62.7%). Any trigger that waits long is chasing a move that has already faded.
2. **On tape, OF03's events look stronger than OF01's** — OF03 MFE/MAE 1.85 with a
   15s turn, OF01 at 0.87 with a 35s turn. That is the OPPOSITE of the 1-minute
   trade record (OF01 netPF 1.781, OF03 1.189). It is a contradiction to
   investigate, not a conclusion: four sessions, tick-rule proxy, and the two
   measures answer different questions (event quality vs traded outcome after
   planner gates).

## Stage C — trigger candidates, asked separately

60s reversal, each candidate on its own, never merged:

| candidate | n | rev 30s | rev 60s | rev 120s |
| --- | ---: | ---: | ---: | ---: |
| baseline (the 1m confirmation) | 310 | 44.4% | 71.6% | 62.7% |
| **change30** | 114 | 48.2% | **79.8%** | **65.8%** |
| change60 | 160 | 52.5% | 74.1% | 62.0% |
| **bothChange** | 58 | **60.3%** | **82.8%** | 67.2% |
| effortChange (EFFORT + CHANGE) | 27 | 51.9% | 81.5% | 66.7% |
| priceConfirm | 74 | 32.4% | 73.0% | 59.5% |
| deltaConfirm | 95 | 43.2% | 73.7% | 64.2% |

Session by session (60s reversal, baseline → candidate, cells with n<3 omitted):

```
change30     : 09-28 74→82(n28)  09-29 66→75(n44)  09-30 76→83(n42)   ALL THREE POSITIVE
change60     : 09-28 74→74(n31)  09-29 66→73(n60)  09-30 76→75(n67)   flat
bothChange   : 09-28 74→71(n14)  09-29 66→95(n21)  09-30 76→78(n23)   one negative
priceConfirm : 09-28 74→73(n15)  09-29 66→58(n24)  09-30 76→83(n35)   one negative
```

**`change30` is the only candidate that improved in every session that had enough
events.** And EFFORT still contributes nothing — `effortChange` covers only 27
events, and the condition that actually moves the number is CHANGE alone. That is
consistent with the earlier finding that EFFORT sits at or below baseline.

What this does NOT establish: four sessions, three of them with n≥3 for this
cut, tick-rule aggressor proxy, and a 60-second price reversal is not a trade P&L.
**`change30` is a candidate for the trigger, it is not a trigger**, and nothing
about it reaches the detector or the board.

## The contradiction resolved: tape says OF03 > OF01, trades say OF01 > OF03

The largest open question in Phase 2, decomposed one measurement at a time
(`node backtest/ofAnalysis.js --all`, section "WHERE THE TAPE AND THE TRADE RECORD
DISAGREE"). No gate was touched.

| measurement | OF01 | OF03 |
| --- | ---: | ---: |
| armed events | 1,505 | **4,059** |
| · invalidation broke first | 709 (47%) | 1,278 (31%) |
| · expired without a trigger | 118 (**7.8%**) | 965 (**23.8%**) |
| signals refused by the planner | 653 | 1,695 |
| **trades** | 12 | 10 |
| event → trigger delay (median) | 1 bar | 1 bar |
| risk % at entry (median) | 0.28% | 0.26% |
| stop width in ATR (median) | 0.53 | 0.59 |
| R:R room to T1 (median) | 2.15 | 2.05 |
| position in day's range (median) | 38.6% | 80.2% |
| mean R per trade | 0.76 | 0.34 |

**Three of the eight candidate explanations are ruled out.** Stop width, risk size
and target placement are effectively identical between the arms (0.28 vs 0.26%,
0.53 vs 0.59 ATR, 2.15 vs 2.05R), and the event→trigger delay is 1 bar for both —
so it is **not** entry delay, stop placement, target placement or risk size.

What is left:

1. **EVENT SELECTION is the real difference.** OF03 arms **2.7× more events** but
   expires unconfirmed **23.8% of the time vs 7.8%** for OF01, and the planner
   refuses 1,695 of its signals. Its detector is far noisier: it arms readily and
   confirms rarely, so very few of its events ever become trades.
2. **The aggregate is dragged down by ONE cell.** By setup × side:

   | | n | rangePos | vwapDist | held | meanR |
   | --- | ---: | ---: | ---: | ---: | ---: |
   | OF01 LONG | 7 | 17.2% | −0.06% | 1.0b | **+0.53** |
   | OF01 SHORT | 5 | 86.3% | +0.56% | 6.0b | **+1.08** |
   | OF03 LONG | 3 | 4.8% | −0.80% | 1.0b | **−1.00** |
   | OF03 SHORT | 7 | 90.6% | +0.69% | 2.0b | **+0.91** |

   **OF03 SHORT (+0.91 meanR) is essentially as good as OF01 SHORT (+1.08).** The
   whole OF03 deficit is `OF03 LONG` — three trades, all stopped. And three trades
   is far too small to become a filter, so it is reported as an observation only.

3. **The two measurements answer different questions, which is the actual
   explanation.** The tape anchors at the **event close** and asks whether price
   rejects within 120s — that is what OF03 is designed to do (a marginal new
   extreme that fails to hold), so it scores well (MFE/MAE 1.85). The trade
   record anchors at the **next-open fill** with a stop at the failed extreme and
   holds to T1/T2 or session end. An event can be excellent over 120 seconds and
   still be a poor trade, which is precisely why Stage 4 converts event-study
   observations into P&L before anything is adopted.

Entry location differences are structural, not defects: OF03 LONG enters at 4.8%
of the day's range and OF03 SHORT at 90.6% — mirror images, both correct for a
setup whose event *is* a new extreme.

**Conclusion: no strategy change follows from this.** The explanation is event
noisy-arm selection plus one three-trade cell, not an execution-geometry flaw —
and neither observation is strong enough to act on.

---

## Stage I · Phase 4 — the trigger candidates as P&L (`backtest/phase4TriggerPnl.js`)

Stage C compared trigger candidates as reversal percentages. Phase 4 closes the
loop it opened: both branches are replayed through **one execution path** —
`backtest/follow.js` (next-open fill, plan re-derived against the fill, stop-first
tie, intraday hold, 09:20–15:00 window), same planner, same stop/T1/T2, same
cost convention (0.05%), same one-trade-per-symbol-per-session cap, ORDERFLOW
hold 90 bars. The branches differ in exactly one line:

- **baseline** — every confirmed candidate trades (the frozen live behaviour);
- **change30** — a candidate trades only if its parent armed event's tape
  measurement (`eventMicro.measure().triggers.change30`, read from tape, never
  recomputed) approved it. No variant, no threshold, no new gate.

The condition is checked before the day is consumed, so a refused candidate
leaves the session's slot free for a later candidate — what the variant would do
live. change30 is built from look-back windows only (delta10 vs delta30, both
before the event bar's close), so it is known before the confirmation bar — no
look-ahead. The armed→signal join is self-checked against `barsToTrigger`;
mismatches are counted (`joinMiss`), never guessed. Both passes replay the same
frozen engine; the run asserts they armed the same events (`determinism check`).

### Results on the discovery sessions (1028 symbols, tape 2026-09-28..10-01)

| session | baseline | change30 |
| --- | --- | --- |
| 09-28 | 1t, −1.3R | no trades |
| 09-29 | 2t, −2.5R | no trades |
| 09-30 | no trades | no trades |
| 10-01 | no trades (no minute bars for this session yet) | no trades |
| **pooled** | **3t, win 0.0%, NET −3.8R** | **0t** |

Funnel: 785 armed on the three tape sessions that have bars → 6 signals in
scope (2 outside the entry window) → **4 eligible** candidates handed to
`follow()` → baseline filled 3 (1 `REFILL_RR` vetoed); change30 refused all 4
as `MICRO_NO_DATA` — **none of the trade-eligible events had a readable tape
window**. Tape coverage: 341 events measured, 444 armed events without a
readable window (thin tape; flag false — no evidence, not a guess).

### What this says (and what it does not)

1. **The comparison is inconclusive by data, not by design.** The tape scored
   Stage C's rates on events that overwhelmingly never become trades (785 armed
   → 6 signals); the few events that DO trade happened where the tick record is
   too thin to evaluate the condition. A reversal percentage and a tradeable
   trigger currently live on different event populations — which is exactly the
   gap Phase 4 exists to expose.
2. **The baseline's own tape-window result (3t, −3.8R) is consistent with the
   known late-September losing stretch** (walk-forward fold 4 lost in both
   arms). Nothing here re-judges the frozen record; it re-states it on the
   tape-windowed slice.
3. **10-01 cannot be studied yet** — the tape exists but the minute bars for
   that session are not in `data/ohlcv_1m`. It stays a scope row, not a result.

`change30` remains a **RESEARCH CANDIDATE**. Nothing was promoted, nothing was
tuned, and `test/researchGuard.test.js` now also blocks any decision path from
requiring the harness (`phase4TriggerPnl` joined the micro-token list). The
harness is the machinery Phase 4 needs on **independent** sessions: arm capture,
let sessions accumulate, rerun
`node backtest/phase4TriggerPnl.js --all`, and the same table falls out with
data that was not used to discover the candidate.
