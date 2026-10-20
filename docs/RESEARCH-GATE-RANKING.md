# RESEARCH GATE + TRACK RANKING — READ-ONLY

> **FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**
> No strategy implemented. No V4. OF01/OF03 and Phase 5A untouched. No production wiring. No automatic orders. Nothing moved to live. No threshold tuned after seeing any result.

**Machine gate:** [research/candidateGate.js](research/candidateGate.js) · tests [test/candidateGate.test.js](test/candidateGate.test.js)
**Ranking harness:** [research/gateRanking.js](research/gateRanking.js) · raw [data/terminal/gate-ranking.json](data/terminal/gate-ranking.json)
**Evidence base:** [data/terminal/s2-robustness.json](data/terminal/s2-robustness.json) · [data/terminal/s2-stage-diagnosis.json](data/terminal/s2-stage-diagnosis.json) · [data/terminal/i1-stage-diagnosis.json](data/terminal/i1-stage-diagnosis.json) · [data/terminal/setup-study-scalping.json](data/terminal/setup-study-scalping.json) · [data/terminal/setup-study-intraday.json](data/terminal/setup-study-intraday.json) · [data/phaseD_mtf_backtest.json](data/phaseD_mtf_backtest.json)

All of the above is **in-sample / development-corpus evidence.** The only tick tapes that exist are the four discovery sessions (2026-09-28…10-01); there is **no unseen tape**, so nothing here is out-of-sample validation.

---

# PART 1 — THE MACHINE-CHECKABLE HISTORICAL GATE

The gate is the **only** authority allowed to authorise a live shadow test. It does its own accounting — it re-derives net expectancy, net PF and tail shares from the trade list when one is supplied, and otherwise accepts an explicitly precomputed report (so an already-aggregated study can be judged without re-running it). It never invents a candidate and never optimises.

`Gate.evaluate(candidate)` → `{ verdict, flags[], passes[], fails[], tracked{…} }`. Verdicts:

| verdict | meaning |
|---|---|
| **PASSES** | clears every PASSES floor and raises no flag |
| **CONDITIONAL** | positive but fragile, or a required measurement is missing → continue research, do **not** freeze |
| **REJECT** | at least one fatal condition → cannot be promoted |

**What it evaluates automatically** (the user's list, one-for-one):

| requirement | gate field(s) |
|---|---|
| net PF after costs | `netPF` (and `grossPF`) vs `minNetPFAfterCost 1.30` |
| net expectancy after costs | `netExpectancyR` vs `minNetExpectancyAfterCost 0.10` |
| trades / independent observations | `n` vs `minTrades 40`, `independentObservations` vs `minIndependentObservations 30` |
| overlapping / duplicate signal dependence | `inflationRatio` vs `maxEffectiveInflation 12` (fatal 30) |
| positive-session coverage | `positiveSessionsAfterCost` vs `minPositiveSessions 0.60`; `negativeSessionsAfterCost`; `flatSessionsAfterCost` |
| long vs short stability | `minSideNetExpR` vs `minSideStability 0.55` |
| time-of-day dependency | `bestHourShareOfNetR` vs `maxHourConcentrationAfterCost 0.35` |
| day-of-week dependency | `bestDayOfWeekShareOfNetR` vs `maxDayOfWeekConcentrationAfterCost 0.35` |
| tail dependence | `top5Share` vs 0.55, `top10Share` vs 0.92 (fatal) |
| drawdown | `maxDDR`, `maxAdversePct` (flags) |
| cost sensitivity | `costCurve`; must stay positive at **double** the assumed cost (`minSurviveDoubleCost`) |
| signal frequency / selectivity | `selectivity` (independent events per 1000 native frames) vs `minSelectivity 1.0` (fatal 0.15) |

**Win rate is deliberately NOT a standalone block.** `winPct` only raises a quality flag below 42% (warning below 35%). PF, expectancy, stability and cost resilience decide.

**Fatal (REJECT) conditions:** net expectancy ≤ 0; top-10% tail share > 92%; effective-sample inflation > 30×; < 18 independent observations; < 18 trades; selectivity < 0.15 per 1000 frames.

Verified: `node --test test/candidateGate.test.js` → **12/12 pass, exit 0**. Full suite `node --test test/*.test.js` → **309/309 pass, exit 0**.

---

# PART 2 — SCALPING

**Mechanism already established** ([docs/STAGE2-DIAGNOSIS.md](docs/STAGE2-DIAGNOSIS.md)): the edge exists **before** the trigger and the trigger **destroys** it. Expectancy is monotonic in earliness — extension `+0.069 R` → deceleration `−0.002` → reversal trigger `−0.217`; the mean 5-second forward drift collapses from `+0.0337%` at the extension to `+0.0017%` at the trigger. The promising scalping object is therefore the **meaningful extension event itself** (act at the event, no deceleration wait).

### Top promising candidates → evidence → gate

**1. `SC-S2-MEANINGFUL-EXTENSION`** — extension state `r20/r60` same-signed ≥ 0.30%, meaningful `│r20│ ≥ 0.50%`, enter the fade **at the episode event**, 15 s cooldown, 0.05% cost (pre-registered, frozen). *Strongest scalping hypothesis.*

| evidence | value |
|---|---|
| trades (independent) | 10,519 (**1,232** effective independent 60s events) |
| win / grossPF | 50.1% / 2.15 |
| **netPF @0.05%** | **1.62** |
| **net expectancy @0.05%** | **+0.447 R** |
| positive sessions | 3/4 raw (75%); deduplicated only 2/4 |
| long / short | +0.650 / +0.275 |
| hours | all 7 positive; without best hour +0.410; without best day +0.379 |
| cost curve | +0.447@0.05 → +0.197@0.10 → **−0.303@0.20** |
| tail | top1 **52.6%**, top2 **76.9%**, top5 **121.2%**, top10 **167.1%** of net R |
| inflation | **8.54×** (raw n overstates independent evidence) |

> **GATE: REJECT.** Fatal: **top-10% tail share 167.1% > 92% — a one-trade story.** Also flagged: top-5% 121.2%, single-session concentration 51.1%, min side expectancy +0.275 < 0.55, adverse excursion −21.4%. *Positive after cost, robust across hours and days — and still rejected, because removing the top 5% of trades flips it negative (−0.100 R).*

**2. `SC-S2-DEDUP-ONE-PER-60S`** — the same rule on the honest independent sample (one entry per 60s bucket).

| evidence | value |
|---|---|
| trades | 1,232 |
| netPF / net expectancy | 1.48 / **+0.343 R** |
| positive sessions | **2/4 (50%)** |
| single-session concentration | 75.5% |
| tail | top10 167.1% |

> **GATE: REJECT.** Fatal tail (167.1%). Flagged: positive-session coverage 50% < 60%, losing-session fraction 50% > 40%, session concentration 75.5%. The deduplicated sample is positive but *half its sessions lose* and it is carried by the same tail.

**3. `SC-S2-TRIGGER-ENTRY`** — the frozen S2 entry as it stands (deceleration + reversal trigger). net expectancy **−0.217 R**, netPF 0.74, negative on **4/4** sessions.

> **GATE: REJECT.** Fatal: net expectancy ≤ 0.

**4. Other scalping archetypes** (read-only structure study, tick tapes):

| candidate | n | netExpR | netPF | gate |
|---|---|---|---|---|
| `SC-S1_CONTINUATION_PULLBACK` | 109,993 | −0.249 | 0.51 | **REJECT** (expectancy ≤ 0) |
| `SC-S3_COMPRESSION_EXPANSION` | 90,480 | −0.399 | 0.32 | **REJECT** |
| `SC-S4_FAILED_MOVE` | 224,409 | −0.409 | 0.34 | **REJECT** |
| `SC-S5_EXTENDED_NO_CHASE` (chase control) | 54,255 | −0.568 | 0.41 | **REJECT** |

**Scalping verdict: no candidate clears the gate.** The strongest object (meaningful-extension event) is positive after cost and stable across hours/days, but it is **tail-dominated** and its independent sample is only ~1,232 minutes over four sessions. **Frozen — NOT VALIDATED, NOT DEPLOYED.**

---

# PART 3 — INTRADAY

**Mechanism** ([docs/STAGE2-DIAGNOSIS.md](docs/STAGE2-DIAGNOSIS.md)): context alone is strongly negative (`−0.598 R`); the **pullback** is the one gross-positive stage (`grossPF 1.07`, `+0.071 R` gross); the **1m re-acceleration trigger makes it worse** (`grossPF 0.86`, `−0.431 R` net; 1m forward drift −0.0194%). 33% of entries are already `TOO_LATE` (`distExtreme < 0.10%`, −0.513 R). **Sub-minute triggers cannot be validated from the 1m corpus** — they are a design intention, not evidence. A separate, genuinely higher-timeframe candidate source exists: the MTF daily trend study.

### Top promising candidates → evidence → gate

**1. `IN-I2-EXTENSION-REVERSAL`** — context trend → large extension → deceleration → reversal (1m). *Best-scoring intraday archetype.*

| evidence | value |
|---|---|
| trades | 23,733 |
| netPF / net expectancy | 1.01 / **+0.021 R** |
| win | 49.1% |
| cost curve | +0.271@0% → +0.171@0.02 → **+0.021@0.05** → −0.229@0.10 |

> **GATE: CONDITIONAL.** No fatal condition, but net expectancy `+0.021` and netPF `1.01` are far below the PASSES floors (`0.10` / `1.30`); it **fails double cost**; single-hour concentration 100% (daily-frame concentration is real); tail shares unmeasured in the source study. *Positive but far too thin to freeze — continue research, do not promote.*

**2. `IN-MTF-DAILY-ALL`** — weekly context → daily confirmation → daily structure-break trigger, MTF trend-follow ([common/market/mtfTrend.js](common/market/mtfTrend.js)), assessed from the **388 per-trade** records in [data/phaseD_mtf_backtest.json](data/phaseD_mtf_backtest.json) (walk-forward as-of). Per-trade net R recomputed as `(exit−entry)/(entry−stop)` minus a round-trip cost of `0.05% / riskPct`.

| evidence | value |
|---|---|
| trades | 388 |
| win | 36.3% |
| netPF / net expectancy | 0.91 / **−0.045 R** |
| positive sessions (monthly) | 1/3 (33%) |
| exits | TGT 55 / TIME 204 / SL 129 |

> **GATE: REJECT.** Fatal: net expectancy ≤ 0; does not survive double cost. Flagged: losing-session fraction 67%, win 36.3%, day-of-week concentration 38.5%.

**3. `IN-MTF-DAILY-HTF-SWING-FILTER`** — the MTF *tuned* selection (`target_kind == htf_swing_high`, from [data/phaseD_mtf_tuning.json](data/phaseD_mtf_tuning.json)). **Presented for completeness only — it is a swept selection, which the research rule forbids promoting.**

| evidence | value |
|---|---|
| trades | 87 |
| netPF / net expectancy | 1.42 / **+0.200 R** |
| win | 41.4% |
| positive sessions | 3/3 (100%) |
| tail | top5 79.5%, **top10 162.5%** |
| session concentration | 80.1% |

> **GATE: REJECT.** Fatal: **top-10% tail 162.5% > 92%.** Independently, a configuration chosen by a sweep after seeing results is **not a pre-registered candidate** and cannot pass by rule, regardless of its numbers.

**4. `IN-I1-*` stage candidates** (`CONTEXT → PULLBACK → ENTRY`, 1m corpus, 145 sessions):

| candidate | n | netExpR | netPF | positive sessions | gate |
|---|---|---|---|---|---|
| `IN-I1-ENTRY` | 27,159 | −0.431 | 0.70 | 15% | **REJECT** (expectancy ≤ 0) |
| `IN-I1-PULLBACK` | 103,339 | −0.179 | 0.85 | 38% | **REJECT** (expectancy ≤ 0) |
| `IN-I1_TREND_PULLBACK_CONTINUATION` | 7,137 | −0.127 | 0.91 | — | **REJECT** (expectancy ≤ 0) |

The pullback stage is gross-positive but **net-negative after cost** — deleting the re-acceleration trigger is necessary but not sufficient; it moves toward break-even, it does not clear cost.

**Intraday verdict: no candidate clears the gate.** The 1m I1 entry is robustly negative; the strongest 1m archetype (I2) is positive but ~break-even after cost and fails double cost; the MTF daily trend system is net-negative as specified and its only positive variant is both tail-dominated and a post-hoc sweep. **Frozen — NOT VALIDATED, NOT DEPLOYED.**

---

# PART 4 — RANKED BY ROBUST AFTER-COST EVIDENCE (NOT RAW PF)

| verdict | track | candidate | n | indep | netExpR | netPF | win | posSess | top10 | infl |
|---|---|---|---|---|---|---|---|---|---|---|
| CONDITIONAL | INTRADAY | IN-I2-EXTENSION-REVERSAL | 23,733 | 23,733 | +0.021 | 1.01 | 49.1% | n/a | n/a | 1.00 |
| **REJECT** | SCALPING | SC-S2-MEANINGFUL-EXTENSION | 10,519 | 1,232 | **+0.447** | 1.62 | 50.1% | 75% | 1.67 | 8.54 |
| REJECT | SCALPING | SC-S2-DEDUP-ONE-PER-60S | 1,232 | 1,232 | +0.343 | 1.48 | 48.3% | 50% | 1.67 | 1.00 |
| REJECT | INTRADAY | IN-MTF-DAILY-HTF-SWING-FILTER *(tuned)* | 87 | 87 | +0.200 | 1.42 | 41.4% | 100% | 1.62 | 1.00 |
| REJECT | INTRADAY | IN-MTF-DAILY-ALL | 388 | 388 | −0.045 | 0.91 | 36.3% | 33% | n/a | 1.00 |
| REJECT | INTRADAY | IN-I1_TREND_PULLBACK_CONTINUATION | 7,137 | 7,137 | −0.127 | 0.91 | 41.2% | n/a | n/a | 1.00 |
| REJECT | INTRADAY | IN-I1-PULLBACK | 103,339 | 103,339 | −0.179 | 0.85 | 46.5% | 38% | n/a | 1.00 |
| REJECT | SCALPING | SC-S2-TRIGGER-ENTRY | 6,762 | 6,762 | −0.217 | 0.74 | 52.6% | 0% | n/a | 1.00 |
| REJECT | SCALPING | SC-S1_CONTINUATION_PULLBACK | 109,993 | 109,993 | −0.249 | 0.51 | 46.7% | n/a | n/a | 1.00 |
| REJECT | SCALPING | SC-S3_COMPRESSION_EXPANSION | 90,480 | 90,480 | −0.399 | 0.32 | 35.4% | n/a | n/a | 1.00 |
| REJECT | SCALPING | SC-S4_FAILED_MOVE | 224,409 | 224,409 | −0.409 | 0.34 | 36.7% | n/a | n/a | 1.00 |
| REJECT | INTRADAY | IN-I1-ENTRY | 27,159 | 27,159 | −0.431 | 0.70 | 40.0% | 15% | n/a | 1.00 |
| REJECT | SCALPING | SC-S5_EXTENDED_NO_CHASE | 54,255 | 54,255 | −0.568 | 0.41 | 34.4% | n/a | n/a | 1.00 |

Note how the ranking behaves: **the highest net expectancy in the entire program is a REJECT** (`SC-S2-MEANINGFUL-EXTENSION`, +0.447 R), because raw PF/expectancy is not the ranking criterion — the gate re-ranks by robustness. `IN-I2` sits top only because no *fatal* condition fires and its tail was never measured; it is `CONDITIONAL`, not a pass.

---

# PART 5 — WHAT THIS MEANS

1. **Both tracks fail their own gate — separately, on their own evidence.** No candidate is approved for live shadow testing. Nothing was frozen, nothing was tuned, nothing was deployed.
2. **A strong intraday result did not compensate for a weak scalping result, or vice versa** — each candidate is gated in its own track and each fails independently.
3. **The decisive scalping failure is tail dependence**, not PF. The edge is real in aggregate but produced by a handful of extreme moves; four sessions cannot tell a market property from a sample property.
4. **The decisive intraday failure is sign/thinness** — the 1m entry is robustly negative, the pullback is gross-positive but net-negative, the best archetype is ~break-even and fails double cost.

**What is genuinely required before either track can advance:**

- **Genuinely unseen tick tape** — the frozen harness, unchanged, on data whose content does not match a discovery tape (the duplicate/replay guard already exists in [research/s2Validation.js](research/s2Validation.js)). Target a few hundred **independent** 60s events per session, not 10k overlapping entries.
- **Actual sub-minute history** for the intraday trigger. Until then the 10s/20s layer is a design intention, never a claim.
- **No tuning between sessions.** Every threshold, cooldown, entry rule and cost stays exactly as pre-registered.

**STOP.** No threshold was optimised. No candidate was implemented. Nothing was wired into [scripts/buildBoard.js](scripts/buildBoard.js). No V4.

---

## Constraint verification (this turn)

| check | result |
|---|---|
| `strategies/orderFlow.js` sha256 (16) | `90471e9ae616cd62` ✅ unchanged |
| `strategy-core/tradePlanner.js` | `7a311fe0bc97b1d7` ✅ |
| `backtest/follow.js` | `e4753e0fe896dd02` ✅ |
| `cmp strategies/orderFlow.js strategies/frozen/orderFlow.of01v2-of03v1.js` | byte-identical ✅ |
| V2 engine hashes vs `.freebuff/v2-hashes-before.json` | 8/8 unchanged ✅ |
| `grep -c "research/" Server.js` | `0` ✅ |
| full test suite `node --test test/*.test.js` | **309/309 pass, exit 0** ✅ |
| OF01/OF03 modified | **no** ✅ |
| V4 created | **no** ✅ |
| anything moved to live | **no** ✅ |
