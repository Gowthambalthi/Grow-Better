# Finding: public-repo strategies with strong claimed win rates show no edge here

**Status:** measured, 12-strategy leaderboard, 995 symbols, 21 sessions (2026-08-27..2026-09-25),
dev 14 / OOS 7, one shared simulator, 0.10% round-trip cost, adverse intrabar assumption
(stop checked before target), position-at-a-time enforced.
Artifact: `data/github_strategies.json`. A 142-session refresh (33.6M candles, dev 99 / OOS 43)
was running when this was written — the numbers below are the 21-session read and are labelled as such.

## The claim-vs-measured table

| # | id | source claim (verbatim) | win% | gross R | cost R | net R | n | verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | nifty50_ict | "64.7% win rate" | 60.1 | +0.412 | 0.278 | ~~**+0.134**~~ **WITHDRAWN** | 9,647 | ~~ESTABLISHED~~ **ARTIFACT** (see the update below) |
| 2 | orb | "best strategy of the set, net −Rs 3.4k over 60 days after costs" | 41.6 | −0.028 | 0.076 | −0.103 | 17,034 | NO_EDGE |
| 3 | liquiditySweep | plan v3 addendum (no published number) | 41.8 | +0.034 | 0.180 | −0.146 | 17,278 | NO_EDGE |
| 4 | vwap_reversion | "22.6% win rate" | 38.1 | +0.032 | 0.286 | −0.253 | 59,118 | NO_EDGE |
| 5 | ai_mean_reversion | "60-76% win rate" | 42.2 | +0.071 | 0.379 | −0.308 | 134,247 | NO_EDGE |
| 6 | bollinger | (repo file) | 34.8 | −0.099 | 0.323 | −0.423 | 153,765 | NO_EDGE |
| 7 | ai_bearish_momentum | "60-76% win rate" | 37.6 | −0.028 | 0.428 | −0.455 | 223,906 | NO_EDGE |
| 8 | supertrend | (repo file) | 20.8 | −0.154 | 0.336 | −0.490 | 322,359 | NO_EDGE |
| 9 | ai_vwap_momentum | "60-76% win rate (best across risk profiles)" | 34.7 | −0.106 | 0.395 | −0.502 | 207,498 | NO_EDGE |
| 10 | aggShortCircuit | plan gate logic (not Strategy 1) | 29.0 | −0.127 | 0.428 | −0.555 | 63,999 | NO_EDGE |
| 11 | ema_rsi | (repo file) | 33.1 | −0.150 | 0.413 | −0.564 | 106,556 | NO_EDGE |
| 12 | nifty_trend | "profit factor 1.10-1.92" | 5.2 | −0.291 | 0.432 | −0.723 | 71,976 | NO_EDGE |

## Two different failures are being lumped together

Split the rows by **gross** R, because that separates "the signal is there but costs eat it" from
"there is no signal":

- **Negative gross (signal absent):** bollinger −0.099, ai_bearish_momentum −0.028,
  ai_vwap_momentum −0.106, aggShortCircuit −0.127, ema_rsi −0.150, nifty_trend −0.291,
  orb −0.028. These lose money **before** any cost. No fee structure, broker, or exit tweak
  rescues them; the entry has no directional information on this universe.
- **Positive gross, murdered by cost (execution mismatch):** ai_mean_reversion +0.071 with
  cost 0.379, vwap_reversion +0.032 with cost 0.286, liquiditySweep +0.034 with cost 0.180.
  Here the entry does carry a little information — but these signal far more often than a
  0.10% round trip can pay for (134k / 59k / 17k trades over 21 sessions). Cost is 5–12× gross.
  This is a *trade-frequency* problem, and frequency is a property of the design, not a bug.

## Why the claimed win rates are not evidence

1. **Sample.** The source's own strongest-looking row, `nifty50_ict`, was claimed at 64.7% on a
   **34-trade sample over two months** — a 95% CI on 34 trades spans roughly ±16 points, so "64.7%"
   was never distinguishable from 50% even in its own terms. Re-measured on this tape it looked like
   the one survivor — and that measurement was itself a bookkeeping artifact, withdrawn in the update
   at the end of this document. The lesson doubles: a claim from a 34-trade sample is not evidence,
   and neither is a backtest number whose trades the price path cannot support.
2. **Instrument.** The copied repos trade indices/options/F&O baskets where the payoff is
   convex or premium-denominated. A win rate measured on premium decay ("60-76%") is not a
   win rate on directional equity moves; the same entry rule re-measured on equity closes
   lands at 34.7–42.2%.
3. **Timeframe.** `nifty_trend`'s 1.10–1.92 profit factor holds on 15-year **daily** bars; the
   author himself calls the intraday version "a friction-and-runway problem". Intraday here:
   **5.2% win rate**, PF far below 1.
4. **Curve-fit signature.** The three `ai_*` rows share one claim ("60-76% across risk
   profiles") with three different mechanisms, i.e. the number came from a parameter scan,
   not from three independent hypotheses.

## What this does and does not say

- It does **not** say the source repos are dishonest or that their numbers were fabricated.
  It says those numbers were produced under conditions (instrument, sample, timeframe,
  no-cost or premium-based accounting) that do not transfer to directionally traded NSE
  intraday equities at 0.10% round trip.
- It **does** say: copying a rule with a strong advertised win rate is not a starting edge.
  On this universe, 11 of 12 gave negative expectancy after cost, and 7 of 12 were already
  negative before it.
- The practical filter this suggests, for anyone tempted to copy the next repo: check
  **gross** R and **trades per session** before anything else. A positive gross at
  300+ trades/session/symbol is dead on arrival at retail costs; a negative gross is dead
  regardless of cost.

## Update 2026-09-27 — the one positive row in the table above is WITHDRAWN

`nifty50_ict` was the only row that survived (net +0.121R over 142 sessions, 59.7% win, ESTABLISHED).
That row was a **fabrication of the same family as the withdrawn liquiditySweep number**:

- The port arms a retracement entry when price first trades back into the displacement zone, but never
  re-checks the **invalidation level the stop is built from** (the trigger bar's extreme). When the
  pullback has already traded through that level, the candidate came out as a **long whose stop sits
  above its fill** (or a short whose stop sits below it).
- The simulator credits the first touch of that level as a **stop-out**, which for such a candidate is a
  **profit**: it booked exactly **+1.0000R on the next bar**.
- Measured on a 6-symbol sample: **186 of 452** trades carried the wrong-side stop; **270** booked that
  phantom +1R with an **MFE of ZERO** — a win the price path never offered. **Without those trades the
  mean R is −1.105R.** On 20 symbols × the last 43 sessions, honestly re-measured: **241 trades,
  gross −0.084R, net −0.380R, gross win 32%, PF 0.55**.

So the corrected reading of this whole exercise is: **all 12 external strategies are cost-negative, and
none of them is an established edge** — 7 negative before cost, 3 positive-but-5–12×-over-traded, and
the one apparent exception was a bookkeeping artifact.

**What caught it** was a redundant statistic, not the headline: the audit asserted `grossR <= mfeR`
(a trade cannot book more than its own best excursion) and `grossR >= -maeR`, and 18 ICT trades booked
`grossR = 1.0000` with `mfeR = 0`. Both fabrications in this project were found by cross-checking one
computed number against an independently computed one — never by a single metric looking good.

**Guards now in place** (each pinned by a test):

1. `BT.simulate` **refuses** a plan whose stop is not beyond the entry in the losing direction — no
   strategy, runner or sweep can book the +1.00R stop-that-is-a-profit again.
2. `nifty50_ict` refuses a setup whose invalidation level was already breached, at the source.
3. Every candidate, every strategy, is checked for a resolvable side and a geometrically valid stop,
   over real tape: `.freebuff/test-github-strategies.js` (154 checks) and the audit's standing
   invariants (`candGeom`, `excursion`, `flatExits`, `constantBooking`).

### Update 2026-09-27 (later) — the withdrawal, re-measured on the full tape, and folds

`.freebuff/ict-folds.js` → `data/ict_folds.json` re-runs `nifty50_ict` on the CURRENT code, with the
same guards as the harness (risk band 0.15–3.00%, cross-session refusals, one position at a time,
shared simulator, 0.10% round trip), over the whole tape: **995 symbols × 142 sessions, 36,320 trades**.

- **Geometry audit — clean.** 0 wrong-side stops (no long whose stop sits above its fill), 0 phantom
  wins (`grossR >= 0.95` with `mfeR = 0`), 0 stop-out exits that paid, 0 excursion violations
  (`grossR <= mfeR` and `grossR >= -maeR` hold for every trade). The artifact family is gone, not just
  hidden — a candidate whose invalidation was already breached is refused at the source, and the
  simulator will not book a stop that is a profit.
- **Win-rate arithmetic reconciles.** gross win 36.1% · avg gross win **+1.755R** · avg gross loss
  **−0.966R** → `0.361 × 1.755 − 0.639 × 0.966 = +0.016R`, which reproduces the measured mean gross R
  of **+0.016R** exactly (and the same sum re-derived inside the run).
- **It is a cost story, not a signal story — and no cost lever reaches it.** gross **+0.016R**, cost
  **0.275R** (17× the gross), net **−0.259R**, cluster session-bootstrap CI **[−0.284, −0.234]**. For
  comparison the earlier 20-symbol × 43-session tail read gross −0.084R / net −0.380R; the full tape is
  the better estimate and both are negative. A 0.05% round trip would still cost ~0.137R against a
  0.016R gross, so the min-stop gate cannot flip this one either — it is not the ORB case (S2), where
  the gross was 4× larger.
- **Not fragile in the "two lucky days" sense; it is uniformly negative.** Only **7 of 142 sessions**
  were positive, the best 3 sessions carry −2% of total R (the losers dominate), and the mean with the
  best session removed is −0.265R.
- **Walk-forward, expanding, 12 folds: 0/12 held.** Every fold's net mean R is negative (−0.331 to
  −0.212R) and every fold's CI excludes zero on the negative side. There is no fold rule to apply here:
  the strategy fails the first gate, so the paper-trading question is closed, not deferred.

So the corrected row is `NO_EDGE` (net negative, CI excludes zero the wrong way), i.e. it joins the
"positive gross, murdered by cost" group in the table above rather than the "no signal" group — with
the one distinction that matters: cost is **17×** the gross, so trade-frequency and stop-width levers
cannot pay for it.

**Record hygiene.** `data/github_strategies.json` was the PRE-GUARD run and still crowned
`best`/`bestEstablished = nifty50_ict` (mean +0.121R, verdict ESTABLISHED). It is now stamped
artifact-era: the crown is cleared and the withdrawal is written into the file, with the pre-stamp
content preserved at `data/github_strategies_artifact-era.json`. A guarded re-run is what repopulates
it (`node gb_scoring_v2/github/backtest.js --out=data/github_strategies.json`, ~45 min over the full
universe) — until that finishes, the table on disk is artifact-era and must be read as withdrawn.

**S3 (`liquiditySweep`) — CLOSED.** The pre-registered rule was applied and the config is retired
(IMPROVEMENT_PROTOCOL.md §3, `github/strategies.js` header): every stop-width cell and every eligible
min-stop gate cell is negative OOS, 0/12 folds held for the gate, and the mechanism's premise is
falsified (a ≥1% structural stop selects a worse population, not the same signal cheaper). Revisit only
with new information — real executed orderflow sharpening the sweep *detection*, never another exit
filter.

### Update 2026-09-27 (filters) — the five proposed S1 development levers, measured on one run

A development plan for S1 proposed, in priority order: Nifty-50-only universe, Relative Volume filter,
target/exit optimisation, a 09:45–13:30 time window, and a long/short split. `.freebuff/ict-folds.js`
→ `data/ict_folds.json` (+ the per-trade dump `data/ict_trades.json`, 36,320 trades, now carrying a
per-trade `relVol` column) measures the four that can be answered from the trade set. Cost is exact per trade (`costR = costPct / riskPct`), so a
gate or a filter is a re-slice of ONE measurement, not a re-run.

| proposed lever | measured answer |
|---|---|
| **Universe = true Nifty 50** ("biggest expected gain") | **Backwards.** By median session turnover: all −0.259R · top200 −0.315R · top100 −0.323R · **top50 −0.342R**, 0/12 folds in every tier. Mechanism: large caps carry TIGHTER structural stops in % (median risk 0.41% → 0.33%), so `costR` RISES (0.275 → 0.324). Restricting to liquid names makes the cost problem worse, not better. (Tier labels are a liquidity proxy, not index membership.) |
| **Min-stop-distance gate** (the only lever that moves cost arithmetically) | Improves net monotonically but never crosses zero, and keeps almost nothing: gate 0.5% −0.151R @38% kept · 1.0% −0.087R @9.7% · 1.5% −0.062R @2.8% (CI [−0.129,+0.008]) · 2.0% −0.106R @1.0%. Fold holds never exceed 4/12. Gross does NOT improve with the gate (+0.016 → −0.02 → −0.01) — same mechanism as S3: a wide structural stop selects a worse population. |
| **RelVol ≥ 1.5–2.0 entry filter** | **Measured: it does not raise gross.** Session-relative volume (today's cumulative volume at the signal minute vs the prior-session average, no lookahead): relVol gate 1.2 → 8,443 trades, gross **+0.005R**, net −0.219R · gate 1.5 → 5,935 trades, gross **+0.001R**, net −0.211R · gate 2.0 → 3,723 trades, gross **−0.003R**, net −0.200R · gate 3.0 → 1,928 trades, gross +0.021R, net −0.160R. Cost does fall (0.277R → 0.197R, because high-volume sessions carry wider structural stops) and net-win ticks 35.3% → 35.8%, but gross never leaves zero and **0/12 folds hold at every gate**. The filter trades fewer times at the same signal quality — the 17× arithmetic stands. (Measurable on 33,854 of 36,320 trades; 2,466 had no prior-session baseline.) |
| **Time filter — "avoid the last 60–90 min"** | **Backwards.** By entry window: 09:45–10:45 gross +0.009R (n 18,818) · 10:45–12:15 +0.016R · 12:15–14:00 +0.014R · **14:00–15:15 +0.117R** (n 1,139, median risk 0.612%). The late window is the best gross on the tape, not the worst. Still net −0.082R. |
| **Long/short split** | Real asymmetry, not a rescue: **SELL gross +0.082R** vs **BUY −0.043R**; net −0.203R and −0.309R, 0/12 folds each. |

**Multiple-comparisons tax.** The grid (7 gates × 3 side slices × 5 windows, cells with ≥30 trades) is
**100 cells**: 11 have netR > 0, exactly **1** has a session CI above zero, and **0 hold in all folds**.
The CI-positive cell is gate 1.5% × late window: **92 trades**, net +0.136R, CI [0.014, 0.272] — which
keeps **0.25%** of the signal stream, i.e. one such cell out of 100 is the multiple-comparisons artefact,
not a finding (same family as S3's "2.0% cell +0.351R over 31 OOS trades"). The best-looking cell with
any real coverage (late window × gate 1.0%) reads net +0.041R over 230 trades, CI [−0.052,+0.141], 9/11
folds — and still keeps only **0.6%** of the stream, so the project's own coverage floor disqualifies it.

**Conclusion.** All five proposed S1 levers are now measured and **none of them creates an edge**;
two point the wrong way (universe, time). S1 stays withdrawn: net −0.259R, CI [−0.284,−0.234], 0/12
folds, geometry clean. The stated goal ("net +0.121 → +0.18–0.25 while keeping win rate above 55%")
has no starting point: the +0.121 never existed, and per IMPROVEMENT_PROTOCOL §1 a win-rate target is
the last thing to chase — win% is coupled to stop width through `costR = costPct / riskPct`.

### Update 2026-09-28 — the cost × side sweep, the repo's own ROC strategy, and what a mix cannot do

Five rows (`zarattini_momentum`, `orb`, `trend_day`, `liquiditySweep`, `nifty50_ict`) were re-measured
over the whole tape with two **reporting** levers added to the harness — `--cost` and `--side`. Neither
touches a rule: `--side=SHORT` drops long candidates *before* simulation (so the remaining population
is the short stream evaluated on its own merits, not a post-hoc cut of a mixed result), and `--cost`
re-prices the identical trades. Six cells: `data/sweep_{all,SHORT}_{010,005,002}.json`. Two further
cells (`data/sweep_{all,SHORT}_002b.json`) were re-run to carry per-session mean R, which is what the
mix analysis needs and nothing more.

Net mean R (full tape, 995 symbols, 142 sessions):

| cell | zarattini | orb | trend_day | liquiditySweep | nifty50_ict |
|---|---|---|---|---|---|
| all trades @0.10% | −0.063 | −0.094 | −0.141 | **−0.151** | **−0.259** |
| all trades @0.05% | −0.040 | −0.059 | −0.091 | −0.063 | −0.122 |
| all trades @0.02% | −0.026 | −0.038 | −0.061 | −0.010 | −0.039 |
| SHORT only @0.10% | −0.060 | −0.084 | −0.099 | −0.113 | −0.203 |
| SHORT only @0.05% | −0.036 | −0.048 | −0.049 | −0.021 | −0.060 |
| SHORT only @0.02% | −0.022 | −0.027 | −0.019 | **+0.033** | **+0.025** |

**Two different failures, and only one of them is about cost.** `zarattini_momentum` (−0.016 gross),
`orb` (−0.024) and `trend_day` (−0.041) have **negative gross** in every cell: there is no signal to
save, and cheaper execution does not manufacture one (their best cell is still −0.022R).
`liquiditySweep` (+0.025 gross) and `nifty50_ict` (+0.016) have **positive gross killed by costR**
(0.177R and 0.275R at the locked 0.10%) — the 17× arithmetic in the sections above, now measured across
a grid instead of argued.

**The SHORT stream is where their gross actually lives.** Restricting to shorts raises gross from
+0.025 → **+0.070** (liquiditySweep) and +0.016 → **+0.082** (nifty50_ict). Cost falls too (0.177 →
0.163, and 0.275 → 0.286 stays flat for S1). The shape of the two positive cells is therefore a
**conjunction of the two most favourable assumptions at once** — SHORT-only *and* a 0.02% round trip —
and at the harness's locked 0.10% the same two streams are −0.113R and −0.203R. Both positives are
**NOT_ESTABLISHED**: liquiditySweep +0.033R over 66,226 trades, session CI [−0.012,+0.084], 77/142
positive sessions; nifty50_ict +0.025R over 16,981, CI [−0.031,+0.083], 73/142. The CI spans zero in
both cases, so neither may be called an edge.

**A mix does not turn NOT_ESTABLISHED into established.** Equal-weighting the two (per-session means,
CIs rebuilt with the harness's own session bootstrap) gives +0.033R, 81/142 positive sessions, maxDD
3.2R, CI [−0.013,+0.080] — a better distribution, the same missing edge. Their session correlation is
r = 0.64, so most of that is one bet, not two.

**The repo's own buy-side strategy, ported and measured (`intraday_roc`).** `scripts/backtestIntradayRoc.js`
ran the 15-minute store with ROC thresholds scaled ×3; ported to the shared 1-minute harness with the
thresholds **unchanged and the adaptation declared** (`ROC5 > 0.3%` over five 1-minute bars is a far
weaker momentum bar than over five 15-minute ones). Full tape, 0.02% cost: **259,841 trades**,
grossWin 33.2%, gross **−0.082R**, cost 0.033R, net **−0.115R**, CI [−0.139,−0.090] → NO_EDGE, and this
time the CI **excludes zero on the negative side** (session-mean CI [−0.157,−0.113], 18/142 positive
sessions). Unlike S1/S3 its gross is negative too: on 1-minute data this entry has no edge before cost,
so the timeframe-dependence is not a tuning problem to be squeezed — the signal is absent at this
resolution. Its mean MFE is 1.061R against 43% of trades ever reaching +1R, i.e. it gives back
1.143R of excursion: it takes real heat and pays for the privilege.

**Adding the buy-side strategy to the positive pair makes it worse.** `intraday_roc` is long-only, so it
is the one stream that *should* complement short-only cells — and its correlation with them is negative
(r = −0.80 against liquiditySweep, −0.85 against orb), which is exactly what a hedge looks like. It is
still the wrong trade, because it has negative expectancy: the pair + ROC reads **−0.023R**, CI
[−0.048,+0.002], and all five short cells + ROC reads **−0.037R**, CI [−0.069,−0.005] — an *established
negative*. A negatively-correlated stream with a negative mean lowers the combined mean; diversification
smooths a curve, it does not pay for one.

**The buy side, measured rather than inferred.** The LONG side was never measured directly — only
implied by subtracting the two-sided number. It is now its own cell (`data/sweep_LONG_002.json`, plus
`intraday_roc`'s own run) because the subtraction assumes a symmetry the tape has not shown. At 0.02%
cost, every single BUY stream loses, and every CI excludes zero on the negative side:
zarattini_momentum −0.030R (18,533 trades, 31/127 positive sessions) · orb −0.051R (42,644, 52/142) ·
trend_day −0.074R (2,468, 55/141) · nifty50_ict −0.096R (19,339, 41/142) · liquiditySweep −0.111R
(33,089, 46/142) · intraday_roc −0.115R (259,841, 18/142). **No BUY signal on this tape is worth acting
on, and the repo's own ROC strategy ranks last of the six on it.** The dashboard says this in the sweep
panel rather than leaving the user to infer it from a two-sided table.

**A port bug found while porting it, worth naming.** The first cut of `intraday_roc` summed volume from
index 0 of the *whole tape* instead of from the session's first bar, and read `roc15` across the session
boundary — so a 09:16 bar was graded against the previous day's 15:29. The same loop was O(n²) (a fresh
sum of 0..i per bar), which is why one strategy over 995 symbols was heading for a two-hour run instead
of three minutes. Fixed to session-local running sums, with the regression pinned in the suite (a
fixture whose new session gaps up out of a fading prior session: an unconfined port fires at into=5, the
shipped one cannot).

## Reproduce

```
node gb_scoring_v2/github/backtest.js --sample=2 --out=data/github_strategies.json
node gb_scoring_v2/github/backtest.js --ids=intraday_roc --cost=0.02 --out=data/sweep_roc_002.json
node gb_scoring_v2/github/backtest.js --ids=liquiditySweep,nifty50_ict,trend_day,zarattini_momentum,orb --side=LONG --cost=0.02 --out=data/sweep_LONG_002.json
node .freebuff/roc-mix.js                       # the buy-side rows + the ROC-inclusive mix, CIs rebuilt
node .freebuff/ict-folds.js                     # audit + 12 expanding folds + gate/tier/side/time tables
node .freebuff/ict-cells.js                     # candidate cells + the multiple-comparisons tax
node .freebuff/test-github-strategies.js        # 192 checks, incl. the side/geometry and session-window guards
node .freebuff/audit-metrics.js --symbols=20 --sessions=43   # invariants + independent recomputation
node .freebuff/verify-bqsq.js --selftest        # the feed-semantics test, self-tested
```
