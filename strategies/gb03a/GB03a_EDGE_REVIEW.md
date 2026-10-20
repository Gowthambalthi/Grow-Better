# GB01 / GB02 / GB03a — is there an edge, and does the reported "trend alignment" improvement exist?

Audit of the 2026-10-18 performance report against a re-measurement on the same corpus.
Everything below is `backtest/runAll.js` at **0.05% cost** (the cost the board quotes),
100 symbols, 705 sessions, 17,122,433 one-minute bars, `--onePerDay=1`.

Measured files: `strategies/fvg/index.js` `7799e7f6…`, `strategies/orderFlow.js` `8a085cd3…`,
`backtest/runAll.js` `995405b6…`. Reproduce: `scratch/gb_edge_study.js`, `scratch/gb_ema_variants.js`,
`scratch/gb_cutoff_ab.js`.

---

## 1. The headline claim is half right, and the important half is unsupported

| setup | n | win | netPF@0.05 | netR | expectancy | t | bootstrap 95% CI on expectancy |
|---|---|---|---|---|---|---|---|
| **FG01 (GB01)** | 69 | 42.0% | **1.87** | +39.1R | **+0.567R** | **2.39** | **[+0.16, +1.27] — excludes 0** |
| FG02 (GB02) | 4 | 75.0% | 4.61 | +4.5R | +1.12R | 1.52 | [−0.29, +2.70] |
| **OF03 (GB03a)** | 21 | 52.4% | **1.75** | +9.2R | +0.440R | 1.45 | **[−0.12, +1.53] — contains 0** |

**Answer to "is it getting any edge":** GB01 does — a real one, if a modest one. It survives
cost, it survives both halves of the sample (+16.3R then +22.8R), and its bootstrap interval
does not touch zero. **GB03a does not yet**: its measured expectancy is positive but the
interval contains zero, which is what 21 trades buys you. GB02 has no sample at all.

The report's own table gave GB01 as netPF 1.861 / +39.51R and GB02 as 5.279 / +4.10R. The
true figures at the quoted cost are 1.87 / +39.1R and 4.61 / +4.5R. Small deltas, but they
show the table was assembled from more than one cost level: its LONG/SHORT lines quote
**gross** profit factors (2.018 / 3.077, which only exist at zero cost) next to net R that was
computed at 0.05%. At 0.05% the real split is FG01 long netPF 1.64 (+20.8R) and short 2.46
(+18.4R) — not 1.711 / 2.552.

## 2. The "19 trades, 57.9%, netPF 2.193 with trend alignment" row is impossible

The report added a variant: OF03 longs filtered to `close >= EMA20`. It claims 8 of 10 longs
pass and the system improves to 19 trades / 57.9% / netPF 2.193. Measured:

```
OF03 LONG  n=10  — how far below each EMA the decision bar closes
  ACMESOLAR  -0.39% (1m EMA20)  -0.19% (5m EMA20)  -0.04% (15m EMA20)
  AETHER     -0.45%             -0.43%             -0.28%
  ALIVUS     -0.55%             -1.38%             -1.51%
  AMBER      -1.30%             -2.96%             -3.31%
  ARIES      -0.55%             -1.90%             -2.60%
  ARIES      -0.45%             -0.65%             -0.48%
  ARROWGREEN -1.81%             -3.05%             -3.43%
  ARVSMART   -0.33%             -0.97%             -1.63%
  ASIANENE   -0.59%             -0.70%             -1.05%
  AVANTIFEED -0.20%             -1.50%             -3.44%

longs passing "close >= EMA"     1m EMA20: 0/10   1m EMA50: 0/10
                                 5m EMA20: 0/10   15m EMA20: 0/10
```

Every OF03 long closes **below** every EMA at its decision bar. The filter admits **zero**
trades — not 8 — and the resulting system would have no long side at all.

That is not bad luck, it is the setup's geometry: OF03 longs arm on a marginal new LOW that
closes back up, so the signal bar is on the far side of any trend average by construction.
"Filter to close above the trend" and "take failed-new-low reversals" cannot both be true.

Where the numbers came from: 19 trades / 57.9% / netPF 2.19 is **the old registry label** in
`strategy-core/engines.js` (`maxSignalTime: 1100, // 11:00 IST … (57.9% win rate, netPF 2.19)`),
which described a 19-trade run of a **pre-16:36 2026-10-17 revision** of `orderFlow.js`. The
row is that stale claim relabelled as a newly measured filter. It has been removed from the
registry and replaced with the measured numbers.

## 3. Problems, system by system

### GB01 — the only defensible edge
* 69 trades over 705 sessions is roughly one call per ten sessions; do not expect a daily call.
* Both halves positive, both sides positive (long +20.8R, short +18.4R) — the least fragile thing here.
* 42% win rate: it lives on 2R+ winners. Three consecutive stops at the end of its sample
  (Sep 2026) are normal for this profile, not a break.
* **Label bug found:** the catalogue claimed a "14:00 IST entry cutoff". The engine refuses
  new entries at **14:45** (`maxEntryMinute = 14*60+45`) and the post-14:00 arm deliberately
  requires a 1.5× volume surge. The label is now derived from the constant.
* Post-hoc lead (not shipped): FG01 retests that close **against** the 1m EMA20 earn +38.7R on
  36 trades (+7.2R then +31.5R across halves), while the aligned half earns +0.5R and flips
  negative in the second half. Consistent in sign, but it is a 1-minute trend proxy chosen
  after seeing the data — a preregistered study first, no rule change now.

### GB02 — a sample, not a strategy
* 4 trades, average hold 0.3 bars, nothing since 2025-06-19. Its 75% win rate and PF 4.61 are
  anecdotes; at 5m/15m aggregation most candidate gaps are refused by RR or extension, and the
  15-minute zone is nearly always invalidated by the time the fill prints.
* Keep it silent. Do not put it in a portfolio row that implies 73 trades of edge — 69 of those
  are GB01.

### GB03a — direction is the whole story, and the sample is too small
* Longs: 10 trades, 40%, **−1.0R** (−0.1R then −0.9R across halves — negative both halves).
* Shorts: 11 trades, 63.6%, **+10.2R** (+7.0R then +3.2R — positive both halves, decaying).
* All 21 trades are counter-trend by design; the "trend alignment" variant is not implementable
  (§2).
* **UPDATED 2026-10-18 (second pass): the pin moved.** Re-measured on the canonical
  705-session corpus, 12:30 makes 25 trades / netPF 1.997 / **+15.97R** against 11:00's
  21 / 1.746 / +9.24R, and the eight live sessions agree (8 trades/+15.5R vs 5/+5.0R).
  The registry was pinned at 11:00 for a claim this review falsified in §2, so it now
  pins 1230 — the number the engine's DEFAULTS and docs already said. Details:
  [GB-LIVE-2026-10-18.md](GB-LIVE-2026-10-18.md).
* **The moved pin did NOT clear zero, and that had to be re-checked rather than assumed.**
  §1's interval `[-0.12, +1.53]` was computed on the 21 trades of the OLD 11:00 config; when
  the pin moved, the trade list changed and the interval was left behind. Recomputed from the
  recorded 12:30 trades (25 trades, one per session, session- and symbol-session-clustered
  bootstrap, 20k iters, fixed seed — `scratch/gb_of_ci.js`):
  **expectancy +0.839R, 95% CI [-0.131, +1.932] — still contains zero**, t 1.45 → 1.50. The
  fix bought +0.20R per trade and about 0.05 of t; it did not buy significance. GB03a remains
  the unproven one of the three, and the honest summary is "positive, not yet distinguishable
  from luck", not "the correction made it real".
* What would make this shippable is **more trades, not a smarter filter**: one call per ten
  sessions cannot be validated on 705 sessions. Either widen the symbol universe or extend the
  session window and re-measure; a filter fitted to 10 longs is how the 2.19 number happened.

## 4. Portfolio arithmetic correction

The report's "92–94 trades, ~47% win, netPF ~1.95–2.05, +55.4R" mixes setups of very
different quality and implies a diversity the book does not have:

| | n | netR@0.05 | share of net R |
|---|---|---|---|
| GB01 | 69 | +39.1R | 74% |
| GB02 | 4 | +4.5R | 9% |
| GB03a | 21 | +9.2R | 17% |
| **total** | **94** | **+52.8R** | |

Summed per-setup net R is **+52.8R**, not +55.4R (the gap is the mixed cost levels again).
And **83% of the profit** comes from two FVG setups on the same corpus — GB01 and GB02 are the
same rule on two frames, so this is closer to one strategy plus one thin order-flow experiment
than to a three-engine portfolio.

## 5. What changed in the repo

* `strategy-core/engines.js` — GB01 cutoff label now derived from
  `fvg.DEFAULTS.maxEntryMinute` (14:45, not 14:00); OF03's stale `57.9% / netPF 2.19` claim
  replaced with the measured 21-trade numbers and the 11:00-vs-12:30 A/B; OF03's "with trend
  alignment" wording replaced with the counter-trend geometry that the measurement proves.
* Earlier today: live/backtest cutoff parity in `strategies/orderflow/liveMinuteEngine.js`
  (+ test), and `data/terminal/backtest_results.json` regenerated with all four engines.
* No trading rule was changed. Nothing in this audit justified one: the only proposed
  improvement admits zero trades, and every other candidate cut is a post-hoc split on 4–21
  samples.

## 6. Second pass (same day) — live data and the four defects it exposed

A follow-up measured all three systems on eight sessions fetched from the broker after this
review was written (2026-10-07…16), on 360 symbols. It found four things this pass could not
see from the code alone — a cutoff pinned for the fabricated claim above, three catalogue
labels describing a different engine, an off-by-one in the FVG zone age, and an inherited
ATR floor that decides GB01 far more than the gap does. Full detail, numbers and reproducers:
[GB-LIVE-2026-10-18.md](GB-LIVE-2026-10-18.md).

**Verification:** `node --test test/*.test.js` → 356/356 pass (exit 0); `scripts/buildBoard.js`
rebuilds and still reports `ORDERFLOW netPF 1.746 on 21 trades (THIN) silent`.

## 7. Provenance: every number above is outside the window the manifest authorizes

Raised as "the backtest is on older data". The measurement says something worse and something
better than that, and both need stating.

**The corpus is not old — it runs to the current week.** `data/ohlcv_1m_full`, the default
`--corpus` of `backtest/runAll.js` and the tape behind every figure in this review, holds 1,031
symbols whose last candles land between **2026-09-25 and 2026-10-06** — twelve days before this
review was written, not years. So the numbers are not stale for want of
recent bars. They are stale for a different reason: **the window they were measured over is not
the window the framework authorizes.**

| window | span | sessions | who enforces it |
|---|---|---|---|
| `research/framework/manifests/learning_1m.json` | 2025-09-16 → 2026-05-29 | 172 | `backtest/intradayStrategies.js` only |
| the sealed block (same manifest) | 2026-09-24 → 2026-09-30 | 5 | same, declared untouchable below the `final` stage |
| what this review actually measured | 2023-12-04 → 2026-10-06 | **705** | nobody |

Two facts follow, both mechanically checkable:

1. **The canonical harness has no gate.** `backtest/runAll.js` contains no reference to a
   manifest, to `sealed`, or to `authorize` — the learning/manifest/sealed machinery exists in
   `intradayStrategies.js` and stops there. Its only window controls are `--from` and `--days`,
   both **lower** bounds; there is no way to say "and no later than" from the CLI, so the
   residual "unseen" tail cannot be produced by a flag either.
2. **The sealed block was read anyway.** All 120 files that make up the canonical 705-session
   sample contain the sessions 2026-09-24…30 — every one of them, five sealed sessions each.
   The rule is enforced on a harness the GB work does not use.

**And the older slice is doing much of the work.** Partitioning the recorded trades
(`scratch/gb_edge_trades.json`; gross R) by era rather than re-running anything:

| setup | pre-learning (older) | authorized learning window | after the window (2026-05-30→09-23) |
|---|---|---|---|
| FG01 (GB01) | 27 trades · 37% · **+0.431R**/trade | 33 trades · 45% · **+0.927R** | 9 trades · 44% · **+0.652R** |
| FG02 (GB02) | 4 trades · 75% · +1.320R — **all of it** | 0 | 0 |
| OF03 (GB03a) | 12 trades · 50% · **+0.748R** | 7 trades · 43% · **−0.010R** | 1 trade (+1.9R) |

Read plainly: **GB01's expectancy is roughly twice as large inside the authorized window as in
either neighbouring era**, which is the shape a window-fitted number has. **GB02 has no trades
inside the authorized window at all** — its only existence is 2024. **GB03a's edge is entirely
in the pre-learning data and is flat (≈0) in the window the framework trusts**, which agrees
with the interval in §1 and the re-pin that did not move it (§6).

**Also ragged, and this one is easy to miss.** The per-file start of history is not uniform:
across the first 120 symbols the first bar ranges from **2023-12-04 to 2025-09-30**, and the
last bar from 2026-09-25 to 2026-10-06. So "one trade per symbol per day over 705 sessions" is
not a 705-session sample per symbol — the denominator that makes the trade counts look small is
only true of the longest-history symbols. A trade count divided by a union-of-sessions figure
looks conservative for the symbols that contributed a year of bars and flattering for one like
TCS, whose file carries 59 sessions.

**None of this is a significance claim** — the era split is descriptive, 9 and 7 trades prove
nothing on their own, and the older slice is *not* out-of-sample either (the rules were built
while looking at all 705 sessions). What it does establish is the status of the three numbers:
none of them is out-of-sample evidence, and the one window the framework pre-committed to is
not the window any of them was measured in. The only genuinely post-design evidence remains the
eight broker sessions fetched on 2026-10-18, whose GB01 outcome is one call.

### 7b. The gate now exists — and GB03a is NEGATIVE inside the authorized window

The same day, on the same harness: `backtest/runAll.js` gained an upper bound and a manifest
gate, so a window can finally be *authorized* rather than merely bounded, and a sealed session
is refused **by name** instead of dropped in silence. The four behaviours are pinned in
`test/windowGate.test.js` (absent manifest → exit 2; tampered manifest → exit 2; sealed days
named; a windowed run cannot overwrite the shipped artifact). The measurement below is the
authorized 172-session window, 100 symbols, sealed days refused:

```
manifest: research/framework/manifests/learning_1m.json  stage=learning  fingerprint=a9c0889157cd434b  (172 authorized sessions, 2025-09-16..2026-05-29)
sealed : 2026-09-24…2026-09-30 — refused by name: 2026-09-24, 2026-09-25, 2026-09-28, 2026-09-29, 2026-09-30 present in the corpus and NOT read
```

| setup | n | win | grossPF | netPF @0.05% | net R | exp/trade | maxDD |
|---|---|---|---|---|---|---|---|
| FG01 (GB01) | 33 | 45.5% | 2.700 | 2.357 | **+26.8R** | **+0.812R** | 5.6R |
| FG02 (GB02) | 0 | — | — | — | — | — | — |
| OF03 (GB03a, the 12:30 pin) | 9 | 33.3% | 0.655 | 0.482 | **−3.8R** | **−0.423R** | 4.9R |

**This is the sharpest result in the review and it is not flattering.** GB03a — the setup with
the moved pin, the fabricated antecedent and the interval that would not clear zero — is
**negative inside the one window the framework pre-committed to**: 9 trades, −2.1R gross,
−3.8R net, LONG side −0.548R/trade on 5 trades. Its whole-corpus number (+15.97R on 25) is a
whole-corpus number. GB02 does not appear at all: zero trades inside the authorized window, as
§7 predicted from the trade dates.

GB01 is the mirror image, and the caveat matters more than the result. Inside the authorized
window it makes **+0.812R net per trade against +0.567R per trade over the whole corpus** — the
window the framework trusts is the *best* of the three eras, which is the shape of a fitted
number rather than an out-of-sample one. Direction agrees with the recorded trades (33 trades,
+0.927R gross — identical count, identical expectancy, so the two harnesses agree here); GB03a
does not (−0.07R on 7 trades there vs −0.423R net on 9 here — different runners, same sign).

Two things fell out of the same run and belong on the record even though they were not the
question: the other shipped engines are **cost-destroyed inside this window** — ORB01 (CODEX)
2,050 trades at grossPF 1.165 → **netPF 0.800, −319R** at 5 bps; SW01 (SWING) 11,175 trades at
grossPF 1.066 → **netPF 0.706, −2,727R**. Both are gross-positive and net-negative at the cost
the board already quotes. That is a separate finding, not part of the GB question, and it is
reported here only because it was measured under the same gate.

**Everywhere above, read the canonical artifact's numbers as WHOLE-CORPUS numbers.** `netPF
1.997 on 25 trades` (GB03a) and `1.940 on 73` (FVG) describe 705 sessions, not the 172 the
framework authorizes, and the difference is not cosmetic — inside the authorized window the two
setups do not merely shrink, they split: GB01 is **+0.812R** per trade and GB03a is **−0.423R**
per trade.

### 7c. The proposed "refinements" were tested on the authorized window — none of them helps

A suggested next step offered parameter tweaks and reported that, after applying three of them to
OF03, "the back-test for gb01 gave Expectancy R ≈ 0.68R (vs 0.639R baseline) – a ~6% edge
improvement". Swept through the **same harness** (`runEngine`, 100 symbols, 172 authorized
sessions, 5 bps) with nothing in `strategies/` edited — so no backup/restore and no frozen-hash
drift — every variant lands like this (`scratch/gb_param_sweep_gated.js`):

**ORDERFLOW / GB03a** (gross-R CI is session-clustered, 20k iters):

| variant | trades | win | netPF | net R | exp/trade | gross-R CI |
|---|---|---|---|---|---|---|
| BASELINE (shipped, 12:30) | 9 | 33% | 0.482 | −3.8 | **−0.423R** | [−1.00, +0.54] |
| measuredMoveR 1.0 → 1.2 | 23 | 43% | 0.988 | −0.2 | **−0.008R** | [−0.35, +0.77] |
| of03MaxNewExtremeAtr 0.20 → 0.15 | 7 | 14% | 0.179 | −6.0 | **−0.860R** | [−1.00, +0.03] |
| of03MinVolRatio 1.7 → 2.2 | 5 | 20% | 0.282 | −3.4 | **−0.671R** | [−1.00, +0.44] |
| **all three (the suggested trio)** | 14 | 29% | 0.574 | −5.1 | **−0.363R** | [−0.83, +0.58] |
| maxSignalTime 1230 → 1030 | 7 | 43% | 0.703 | −1.5 | −0.213R | [−0.68, +0.96] |
| maxSignalTime 1230 → 1130 | 8 | 38% | 0.572 | −2.6 | −0.331R | [−1.00, +0.73] |

**FVG / GB01+GB02:**

| variant | trades | win | netPF | net R | exp/trade | gross-R CI |
|---|---|---|---|---|---|---|
| BASELINE (shipped) | 33 | 45% | 2.357 | +26.8 | **+0.812R** | **[+0.08, +1.86]** |
| minVolRatio 1.0 → 1.5 | 19 | 42% | 1.733 | +8.9 | +0.466R | [−0.33, +1.67] |
| minGapPct 0.10 → 0.15 | 27 | 41% | 1.847 | +14.9 | +0.551R | [−0.16, +1.59] |
| measuredMoveR 1.5 → 1.2 | 23 | 43% | 2.227 | +17.7 | +0.770R | [+0.03, +1.99] |
| planner.minAtrPct 0.60 → 0.30 | 118 | 36% | 1.223 | +20.1 | +0.170R | [+0.02, +0.69] |
| planner.minAtrPct 0.60 → 0.10 | 369 | 36% | 0.848 | **−44.7** | **−0.121R** | [−0.07, +0.29] |
| minZoneAgeBars 1 → 0 | 29 | 38% | 1.149 | +3.0 | +0.102R | [−0.42, +0.87] |

**Verdict: do not apply any of them.** Every proposed change is worse than what ships, and the
loudest one — loosening the ATR floor to 0.10%, which the suggestion list floated before retracting
it — turns GB01 from **+26.8R to −44.7R** across 369 trades. The OF03 trio does not reproduce the
claimed improvement either: −0.363R against a −0.423R baseline is ~0.06R of noise on 14 trades,
and the "0.639R baseline" it is quoted against is a **whole-corpus** number, not this window's. The
one variant that reaches break-even (`measuredMoveR` 1.2, −0.008R on 23 trades) does so by
tripling the trade count at the same total P&L, which is the opposite of an edge.

Two corrections to the same message, both checkable:

* **`--engine=gb01` is not a valid key.** `gb01`/`gb02` name *setups* inside the FVG engine. That
  command printed `Unknown --engine=gb01` and **exited 0** — a run that measured nothing reporting
  success. Fixed (`exit 2`, with the real keys named) and pinned in `test/windowGate.test.js`.
* **The expectancy table mixes cost conventions.** `gb01 netPF 2.202 / NET R 48.1 / 0.6971R` is the
  **cost-0** figure (the harness's `bySetup` is computed at zero cost); net of the 5 bps it claims
  to include, GB01 is **+39.1R over 69 trades = +0.567R/trade**. The combined FVG row
  (`1.940 / 43.6R / 0.5974R`) is the only one of the three that is net of cost.

**And the break-even arithmetic inherits that error.** `X₀ = 56 / expectancy` assumes the expectancy
is real and repeatable, and takes it from the whole corpus: for GB03a the authorized-window
expectancy is **negative**, so no stop-loss size makes it positive after the ₹56 flat fee — its
break-even does not exist. For GB01 the in-window interval does exclude zero on gross R per trade
([+0.08, +1.86]) and still measures in-sample, so the fee math on top of it is a projection, not a
result.
