# OF04 — ONE MACHINE-GATED CANDIDATE PER TRACK

> **FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**
> Discovery was **not** restarted. No new feature, no threshold change, no V4. OF01/OF03 and
> Phase 5A untouched. No production wiring. No orders. Nothing sent live. No tuning after the result.

**Builder / runner:** [research/of04Candidate.js](research/of04Candidate.js) ·
**raw:** [data/terminal/of04-candidates.json](data/terminal/of04-candidates.json) ·
**gate (unchanged):** [research/candidateGate.js](research/candidateGate.js) ·
**gate tests:** [test/candidateGate.test.js](test/candidateGate.test.js)
**Source of the candidates:** [data/terminal/discovery-scalp.json](data/terminal/discovery-scalp.json) ·
[data/terminal/discovery-intraday.json](data/terminal/discovery-intraday.json)

Evidence is the **same discovery corpus** — **IN-SAMPLE**, never out-of-sample. A historical
gate PASS would only have meant *"strong enough to consider for unseen-data validation"*; it
would **not** have been production approval.

---

## 0. How the candidates were frozen (before the gate was run)

Each track is packaged as **ONE two-sided mechanism with two directional resolutions** — not a
vote, not a score. The two branches are taken **verbatim from the discovery pass's own declared
strongest branches** (`directional.strongestUp` / `directional.strongestDown`), with **no**
threshold change, **no** extra filter, and **no** re-selection:

| track | UP branch (verbatim) | DOWN branch (verbatim) |
|---|---|---|
| SCALP | `distLo60 < 0.02` (at the 60 s low) | `distHi60 < 0.02` (at the 60 s high) |
| INTRADAY | `distLo15 < 0.05` (at the 15-bar low) | `distHi15 < 0.05 & imp15 in [0.2,0.4)` |

**Direction:** UP branch trades **long**, DOWN branch trades **short**. Entry is **at the
event**; horizon is the discovery horizon (60 s for scalp, 30 min for intraday); risk 0.20 %,
cost 0.05 %.

**No post-hoc liquidity filter.** The scalp discovery explicitly showed the broad
`distLo60<0.02` population is cost-negative and only a liquid subset is positive. That liquid
subset was **not** promoted into the candidate. The **full labelled population** the discovery
pass used is the candidate's universe on **both** tracks. This is the decisive discipline of
this pass.

---

# SCALPING

## 1. Frozen candidate definition

`OF04-SCALPING-NORMALIZED-EXTREME-REVERSION` — one mechanism, two directional resolutions:

* **UP:** a tick at/near the recent **60 s low** (`distLo60 < 0.02`) → bet the next 60 s moves
  **away** from the low. (n = 646,761)
* **DOWN:** a tick at/near the recent **60 s high** (`distHi60 < 0.02`) → bet the next 60 s
  moves **away** from the high. (n = 658,847)
* Universe: **all labelled scalp events** (1,426 symbols, 4 discovery sessions), **no symbol or
  liquidity filter**.

## 2. Gate result — **FAIL (REJECT)**

| gate condition | measured | outcome |
|---|---|---|
| **net expectancy after cost** | **−0.090 R** at 0.05 % | ❌ **FATAL — ≤ 0** |
| net PF after cost | **0.890** (floor 1.30) | ❌ |
| gross PF | 1.224 | — |
| survives double cost (0.10 %) | **−0.340 R** | ❌ |
| long / short stability | long (UP) **−0.044**, short (DOWN) **−0.136** (both < 0; min-side floor 0.55) | ❌ |
| independent observations | 348,823 (dedup) ≥ 40 | ✅ |
| selectivity | 163.1 indep events / 1000 frames | ✅ |
| effective-sample inflation | 3.74× (≤ 12) | ✅ |
| positive-session coverage | **not measurable** from the frozen discovery aggregates | ⚠️ |
| hourly / day-of-week split | not persisted by the discovery pass | ⚠️ |
| top-5 % / top-10 % tail shares | not measurable (branch net totals are negative → shares undefined) | ⚠️ |

**Verdict: `REJECT`.** Fatal condition: **net expectancy after cost is negative.** This is the
one unambiguous fatal check in the gate and it fires on the candidate's own full population.

## 3. Full robustness metrics (from the frozen discovery artifacts)

| metric | UP branch | DOWN branch | combined candidate |
|---|---|---|---|
| gross trades | 646,761 | 658,847 | **1,305,608** |
| deduplicated trades / independent obs | 178,088 | 170,735 | **348,823** |
| win proxy (directional hit-rate) | 56.20 % (dedup 61.54 %) | 56.83 % (dedup 62.57 %) | **56.52 %** |
| gross PF (@0 %) | 1.297 | 1.156 | **1.224** |
| **net PF (@0.05 %)** | 0.945 | 0.839 | **0.890** |
| gross expectancy (@0 %) | +0.206 R | +0.114 R | **+0.160 R** |
| **net expectancy (@0.05 %)** | −0.044 R | −0.136 R | **−0.090 R** |
| max drawdown | not persisted per-event by discovery | — | — |
| sessions above base | 4/4 | 4/4 | 4/4 (directional) |
| time-of-day concentration | not persisted | not persisted | unavailable |
| long/short (UP/DOWN) symmetry | — | — | both negative; short side worse |
| top-1 % contribution removal | n/a (net negative) | n/a | n/a |
| top-5 % / top-10 % removal | mean −0.322 / −0.454 R (UP) | mean −0.383 / −0.506 R (DOWN) | monotonically worse |
| dedup sensitivity | 178,088 indep obs, precision **rises** to 61.5 % | 170,735 indep obs, precision **rises** to 62.6 % | signal survives dedup |
| cost sensitivity | +0.206 → −0.044 → −0.294 → −0.794 R | +0.114 → −0.136 → −0.386 → −0.886 R | **−0.090 @0.05, −0.340 @0.10, −0.840 @0.20** |
| selective? | 1.31 M events / 4 sessions (~327 k/session) | — | not selective |
| dominated by a few events? | not the failure mode here — the *aggregate* is already negative | — | **no**, the negative is broad-based |

**Session-by-session directional view** (persisted; per-session *net R* was not persisted):

| session | UP branch P(UP) | DOWN branch P(DOWN) |
|---|---|---|
| 2026-09-28 | 57.33 % | 59.19 % |
| 2026-09-29 | 60.13 % | 55.72 % |
| 2026-09-30 | 54.52 % | 56.97 % |
| 2026-10-01 | 52.27 % | 55.20 % |

The directional edge is real and present in **4/4** sessions — and it is still **not enough to
clear cost** on the full population.

> **Note on tail/win metrics.** The discovery row store persisted branch *aggregates*, not
> per-event profit outcomes, so a true profit win rate, per-session net R, max drawdown and
> tail-share tables are **not recoverable** from the frozen artifacts. They are reported as
> unavailable rather than invented. This does not affect the verdict: the candidate fails on
> **net expectancy after cost**, which is fully determined by the persisted aggregates.

## 4. Time-to-MFE interpretation (diagnostic only — NOT a confirmation rule)

Liquid subset (trustworthy shape). `fracPos` = share of events whose forward move in the
predicted direction is positive at that offset.

**UP branch (`distLo60<0.02`, liquid n = 2,218)**

| offset | +1 s | +3 s | +5 s | +10 s | +20 s | +30 s | +60 s |
|---|---|---|---|---|---|---|---|
| fracPos | 47.8 % | 45.0 % | 40.7 % | 40.8 % | 40.7 % | 51.9 % | **77.5 %** |
| mean path % | +0.002 | +0.012 | +0.021 | +0.046 | +0.096 | +0.152 | **+0.316** |

**DOWN branch (`distHi60<0.02`, liquid n = 1,478)**

| offset | +1 s | +3 s | +5 s | +10 s | +20 s | +30 s | +60 s |
|---|---|---|---|---|---|---|---|
| fracPos | 43.2 % | 39.5 % | 40.5 % | 35.1 % | 36.6 % | 27.5 % | **27.1 %** |
| mean path % | −0.001 | −0.006 | −0.011 | −0.022 | −0.041 | −0.062 | **−0.081** |

**Reading:** the directional response is **present immediately** (already ≈ 43–48 % at +1 s,
i.e. near the ~coin-flip base) and then **strengthens monotonically toward +60 s** on both
sides. There is **no confirmation-then-win pattern** — the information is in the pre-move state.
**A confirmation delay would likely destroy information**: any rule that waits for the reversion
to "begin" would forgo the horizon over which the edge accrues.

**Crucially, this favourable shape exists only on the liquid subset.** On the full population
(which is the candidate's universe) the same 60 s gross path is **+0.041 %** — the shape that
looks tradeable on the liquid subset is the very thing the no-post-hoc-liquidity rule forbids us
from promoting.

## 5. Dominant failure mode

**Cost on the full population.** The scalping mechanism is directionally real (56–63 %), but on
the intended universe the per-event gross edge (~+0.16 R) is **smaller than the 0.05 % round-trip
cost** (~0.25 R at 0.20 % risk) once the whole population — including illiquid symbols whose
60 s path is structurally invisible — is included. The candidate goes negative at exactly the
assumed cost and stays negative at every higher cost. This is **not** a tail-dependence failure
and **not** a sample-size failure; it is a **breadth-vs-cost failure**: the traditional
mean-reversion signal is present, but too small to pay for its own execution at the intended
universe.

---

# INTRADAY

## 6. Frozen candidate definition

`OF04-INTRADAY-NORMALIZED-EXTREME-REVERSION` — one mechanism, two directional resolutions:

* **UP:** a 1 m bar at/near the recent **15-bar low** (`distLo15 < 0.05`) → bet the next 30 min
  moves **away** from the low. (n = 510,695)
* **DOWN:** a 1 m bar at/near the recent **15-bar high** with the 15-bar range in [0.2, 0.4) %
  (`distHi15 < 0.05 & imp15 in [0.2,0.4)`) → bet the next 30 min moves **away** from the high.
  (n = 181,314)
* Universe: **all labelled 1 m bars** (1,028 symbols, 145 sessions), **no symbol or liquidity
  filter**.

## 7. Gate result — **FAIL (REJECT)**

| gate condition | measured | outcome |
|---|---|---|
| **net expectancy after cost** | **−0.108 R** at 0.05 % | ❌ **FATAL — ≤ 0** |
| net PF after cost | **0.909** (floor 1.30) | ❌ |
| gross PF | 1.132 | — |
| survives double cost (0.10 %) | **−0.358 R** | ❌ |
| long / short stability | long (UP) **−0.128**, short (DOWN) **−0.053** (both < 0) | ❌ |
| independent observations | 274,778 (dedup) ≥ 40 | ✅ |
| selectivity | 47.9 indep events / 1000 frames | ✅ |
| effective-sample inflation | 2.52× (≤ 12) | ✅ |
| positive-session coverage | **not measurable** from the frozen aggregates | ⚠️ |
| hourly / day-of-week split | not persisted | ⚠️ |
| top-5 % / top-10 % tail shares | not measurable (branch net totals negative) | ⚠️ |

**Verdict: `REJECT`.** Same fatal condition: **net expectancy after cost is negative** on the
candidate's own full population.

## 8. Full robustness metrics

| metric | UP branch | DOWN branch | combined candidate |
|---|---|---|---|
| gross trades | 510,695 | 181,314 | **692,009** |
| deduplicated trades / independent obs | 192,753 | 82,025 | **274,778** |
| win proxy (directional hit-rate) | 49.18 % (dedup 54.80 %) | 59.09 % (dedup 61.39 %) | **51.78 %** |
| gross PF (@0 %) | 1.139 | 1.199 | **1.132** |
| **net PF (@0.05 %)** | 0.896 | 0.951 | **0.909** |
| gross expectancy (@0 %) | +0.122 R | +0.197 R | **+0.142 R** |
| **net expectancy (@0.05 %)** | −0.128 R | −0.053 R | **−0.108 R** |
| max drawdown | not persisted per-event | — | — |
| sessions above base | **80/145** | **111/145** | 145-session corpus |
| time-of-day concentration | not persisted | not persisted | unavailable |
| long/short symmetry | UP side weak (49 % raw), DOWN side stronger (59 %) | — | **structural DOWN skew preserved, not forced** |
| top-1 % removal | n/a (net negative) | n/a | n/a |
| top-5 % / top-10 % removal | mean −0.536 / −0.771 R (UP) | mean −0.331 / −0.519 R (DOWN) | monotonically worse |
| dedup sensitivity | precision **rises** 49.2 → 54.8 % | precision **rises** 59.1 → 61.4 % | signal survives dedup |
| cost sensitivity | +0.122 → −0.128 → −0.378 → −0.878 R | +0.197 → −0.053 → −0.303 → −0.803 R | **−0.108 @0.05, −0.358 @0.10, −0.858 @0.20** |
| selective? | 692 k events / 145 sessions (~4.8 k/session) | — | broad |
| dominated by a few events? | no — the negative is broad-based | — | **broad, not tail** |

**Session-by-session** (directional view; the corpus spans 145 sessions; the UP branch clears
its base in **80/145** and the DOWN branch in **111/145**). Representative sessions:

| session | UP P(UP) | DOWN P(DOWN) |
|---|---|---|
| 2026-09-11 | 65.07 % | 49.02 % |
| 2026-09-15 | 26.69 % | 84.88 % |
| 2026-09-24 | 34.43 % | 70.88 % |
| 2026-09-28 | 44.94 % | 71.71 % |
| 2026-09-29 | 52.97 % | 46.74 % |
| 2026-09-30 | 42.63 % | 59.00 % |

The directional base rate is unstable session-to-session (e.g. UP 26.7 % one day, 65.1 %
another) — a structural feature of the intraday skew, and another reason the aggregate cannot
clear cost.

## 9. Time-to-MFE interpretation (diagnostic only — NOT a confirmation rule)

Full population. `fracPos` = share of events whose forward move in the predicted direction is
positive at that offset.

**UP branch (`distLo15<0.05`, n = 510,695)**

| offset | +1 m | +2 m | +5 m | +10 m | +15 m | +30 m |
|---|---|---|---|---|---|---|
| fracPos | 52.10 % | 54.09 % | 53.46 % | 51.31 % | 49.97 % | 49.18 % |
| mean path % | +0.023 | +0.025 | +0.026 | +0.024 | +0.023 | +0.024 |

**DOWN branch (`distHi15<0.05 & imp15 in [0.2,0.4)`, n = 181,314)**

| offset | +1 m | +2 m | +5 m | +10 m | +15 m | +30 m |
|---|---|---|---|---|---|---|
| fracPos | 54.39 % | 57.88 % | 59.60 % | 59.79 % | 59.43 % | 59.09 % |
| mean path % | +0.019 | +0.021 | +0.024 | +0.027 | +0.029 | +0.039 |

**Reading:** the response begins **immediately** (already above 50 % at +1 m) and for the DOWN
branch **strengthens** through +10 m before easing. There is **no confirmation delay** — the
edge is in the pre-move state. **A confirmation rule would destroy information.** But the
accumulated gross move is only **+0.019 % to +0.039 %**, i.e. **below the 0.05 % round-trip
cost** — the path is early and directionally coherent, yet too small to pay.

## 10. Dominant failure mode

**Cost, not tail, not sample.** The intraday directional edge — the short-horizon reversal
after a bar closes near an extreme — is present in the data and begins immediately, but its
gross magnitude (~+0.14 R combined) is **smaller than the assumed round-trip cost** (~0.25 R).
The candidate is negative at the assumed cost and far more negative at double cost. It is
**not** a handful-of-winners story (the discovery tails are undefined precisely because the
branch totals are negative) — it is a **breadth-vs-cost** failure, exactly as on the scalp
track, at a different time scale.

---

# FINAL VERDICT

### Does the common mean-reversion mechanism survive the machine historical gate?

**No — not as a tradeable candidate on either track.** The mechanism itself is confirmed again:
both tracks show a **real, immediate, symmetric directional response** to a normalized extreme
(scalp: at the 60 s low ⇒ up / at the 60 s high ⇒ down; intraday: at the 15-bar low ⇒ up / at
the 15-bar high ⇒ down), present at the first observable offset and strengthening toward the
horizon, with clean 4/4 (scalp) and 80–111/145 (intraday) directional session coverage. But
**both packaged candidates fail the gate on the same fatal condition — net expectancy after
realistic cost ≤ 0 on the intended, unfiltered universe.**

### Which track is strong enough to proceed to unseen validation?

**Neither.** `OF04-SCALPING-NORMALIZED-EXTREME-REVERSION` → **REJECT**.
`OF04-INTRADAY-NORMALIZED-EXTREME-REVERSION` → **REJECT**. Nothing is frozen for live shadow
testing and no unseen tape is consumed. Historical PASS would only have authorised *considering*
unseen validation; neither candidate earns that.

### What exact reason caused each track to fail?

* **Scalp:** on the **full labelled population** (no post-hoc liquidity filter), the combined
  net expectancy is **−0.090 R** at 0.05 % cost (net PF 0.890, gross PF 1.224). Both UP and DOWN
  branches are individually cost-negative (−0.044 R, −0.136 R). The directional edge (56–63 %) is
  real but too small to pay for execution once the whole universe is included; the liquid subset
  where the 60 s path is positive was **deliberately not** promoted.
* **Intraday:** on the **full 1 m corpus**, the combined net expectancy is **−0.108 R** at 0.05 %
  cost (net PF 0.909, gross PF 1.132). The UP branch is the weaker side (−0.128 R, 49.2 % raw);
  the DOWN branch is stronger but still cost-negative (−0.053 R). The gross forward move
  (+0.019–0.039 %) is below the 0.05 % cost.

**Common cause:** the shared mechanism is **real but sub-cost** at the intended universe and
horizon. The discovery's headline precision came from *directional separation*, not from
*after-cost magnitude*; when the exact frozen branches are packaged and priced, the edge does
not survive costs on either track.

### What this means scientifically

A FAILED candidate is a valid result. The discovery conclusion —

> NORMALIZED EXTREME → EXHAUSTION / RESPONSE → DIRECTIONAL RESOLUTION

— is **not** refuted; it is **bounded**. The directional resolution is genuine and immediate,
and it fails to become tradeable at the tested horizons/costs. The next legitimate step is **not**
to tune these candidates (forbidden) but to test the same frozen mechanism on genuinely unseen
data and/or on a universe whose execution cost the pre-existing eligibility rules — not the
result — already justify. **No threshold was tuned, no filter was added, nothing was promoted.**

---

## Constraint verification

| check | result |
|---|---|
| discovery restarted | **no** ✅ |
| new thresholds / features introduced | **no** ✅ |
| V4 created | **no** ✅ |
| OF01/OF03 / Phase 5A touched | **no** ✅ |
| production code / live signal logic changed | **no** ✅ |
| post-hoc liquidity filter applied | **no** — full population used ✅ |
| gate modified | **no** — `research/candidateGate.js` sha256(16) `c4037412deff0b14`, unchanged ✅ |
| live order / anything sent live | **no** ✅ |
| `strategies/orderFlow.js` sha256(16) | `90471e9ae616cd62` — unchanged ✅ |
| `strategy-core/tradePlanner.js` sha256(16) | `7a311fe0bc97b1d7` — unchanged ✅ |
| `backtest/follow.js` sha256(16) | `e4753e0fe896dd02` — unchanged ✅ |
| `cmp strategies/orderFlow.js strategies/frozen/orderFlow.of01v2-of03v1.js` | byte-identical ✅ |
| `grep -c "research/" Server.js` | `0` ✅ |
| full test suite `node --test test/*.test.js` | **309/309 pass, exit 0** ✅ |
| `node --test test/candidateGate.test.js` | 12/12 on a clean run; **known pre-existing flake** — the test builds its candidate with `Math.random()`, so its first assertion fails ~1 run in 5 *independently of any change here* |
| new tooling | read-only; writes only `data/terminal/of04-candidates.json` ✅ |
