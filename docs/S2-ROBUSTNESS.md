# S2 0.5% CANDIDATE — ROBUSTNESS ANALYSIS & HISTORICAL-GATE VERDICT

> **FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**

**No rule changed. No entry rule changed. No threshold tuned. No V4. No production change. Nothing moved to live.**

Tool: [research/s2Robustness.js](research/s2Robustness.js) · raw: [data/terminal/s2-robustness.json](data/terminal/s2-robustness.json)

This tool re-uses the frozen harness ([research/s2Validation.js](research/s2Validation.js)) for the event set, so there is **one** implementation and it cannot drift from the pre-registered definition. It applies the already pre-registered rule only:

| item | value (unchanged) |
|---|---|
| Extension state | `r20`, `r60` same-signed, both │·│ ≥ 0.30% |
| Meaningful | **│r20│ ≥ 0.50%** |
| Entry | tick where a new extension episode starts |
| Direction | fade |
| Episode / cooldown | one per continuous episode per symbol; 15 s |
| Outcome | primary 60 s, risk 0.20%, cost 0.05% |

**Evidence is in-sample: the four discovery sessions only. This is not out-of-sample validation.**

---

## THE ONE QUESTION

> *"Is the positive result spread across many ordinary events, or is it produced by a small number of extreme moves?"*

**Answer: it is produced by a small number of extreme moves.**

The aggregate is +0.447 R over 10,519 trades. The **top 1% of trades carry 52.6%** of the total net R and the **top 2% carry 76.9%**. The **top 100 trades alone carry 51.2%**, and the single largest trade is **+99.75 R (2.1% of all net R)**. Remove the top 2% and the edge is a rounding error (+0.105); remove the top 5% and it is **negative (−0.100)**.

| treatment | n | netExpR | netPF | share of net R removed |
|---|---|---|---|---|
| raw | 10,519 | **+0.447** | 1.62 | — |
| without top 1% | 10,414 | +0.214 | 1.30 | 52.6% |
| **without top 2%** | 10,309 | **+0.105** | 1.14 | **76.9%** |
| **without top 5%** | 9,994 | **−0.100** | 0.87 | **121.2%** |
| without top 10% | 9,468 | −0.333 | 0.58 | 167.1% |

A candidate whose sign flips when 5% of trades are removed is **FRAGILE**.

## Overlap and effective independent event count

| measure | value |
|---|---|
| raw entries | 10,519 |
| distinct 5s buckets | 5,915 |
| **distinct 60s buckets (effective independent events)** | **1,232** |
| distinct 300s buckets | 274 |
| symbol-sessions | 2,369 |
| symbols / sessions | 1,183 / **4** |
| 60s cluster size — mean / median / p90 / max | **8.54 / 5 / 17 / 188** |
| overlap rate (entries in 60s clusters of >5) | **82.9%** |
| inflation — 60 s / 300 s | **8.54× / 38.4×** |

The raw n overstates independent evidence by **8.5×**, and the whole independent sample is **1,232 minutes across four sessions**.

## Deduplication

| basis | n | netExpR |
|---|---|---|
| one per 60 s bucket | 1,232 | **+0.343** |
| one per 300 s bucket | 274 | **+0.166** |
| one per symbol-session | 2,369 | **+0.145** |
| cluster-mean (60 s) | 1,232 | +0.363 |
| cluster-mean (300 s) | 274 | +0.307 |

Every deduplicated estimator is positive — but they are all constructed from the *same* four sessions and the *same* tail.

## Per session (the decisive check)

| session | raw netExpR / n | one-per-60s netExpR / n |
|---|---|---|
| 2026-09-28 | −0.067 / 1,281 | **−0.255** / 314 |
| 2026-09-29 | +0.226 / 1,669 | **−0.009** / 352 |
| 2026-09-30 | +0.530 / 5,477 | **+1.141** / 290 |
| 2026-10-01 | +0.721 / 2,092 | **+0.634** / 276 |

**Raw: 3/4 positive. On the independent (one-per-60s) basis: only 2/4 positive.** One session (09-30) supplies the bulk of the deduplicated edge.

## Long vs short, time-of-day

| slice | result |
|---|---|
| long (n=4,837) | **+0.650** |
| short (n=5,682) | **+0.275** |
| by IST hour (netExpR / n) | 9h +0.324/3,641 · 10h +0.367/1,682 · 11h +0.310/1,070 · 12h +0.478/1,194 · 13h +0.428/1,178 · 14h +0.722/1,256 · 15h +1.193/498 |
| without the best hour (15h) | **+0.410** |
| without the best day (10-01) | **+0.379** |

No single-hour and no single-day dependency. Longs are ~2.4× shorts, but both are positive.

## Cost / slippage

| total cost | netExpR |
|---|---|
| 0.05% (base) | **+0.447** |
| 0.07% (+2 bp slippage) | +0.347 |
| 0.10% (+5 bp slippage) | +0.197 |
| **0.15% (+10 bp slippage)** | **−0.053** |

Cost-only: +0.697 / +0.597 / +0.447 / +0.197 / −0.303 at 0 / 0.02 / 0.05 / 0.10 / 0.20%.

---

# HISTORICAL-GATE VERDICT

The gate is the only thing that may authorise live shadow testing. Each condition, measured:

| gate condition | measured | passes? |
|---|---|---|
| positive after realistic cost | +0.447 R at 0.05%, +0.197 R at 0.10%, **negative at 0.15%** | ✅ (with thin margin) |
| positive across multiple sessions | raw **3/4**; deduplicated **2/4** | ⚠️ **weak** |
| not dominated by a handful of winners | top 2% carry **76.9%** of net R; **top-5% removal flips it negative** | ❌ **FAILS** |
| not dependent on one time window | all 7 hours positive; without best hour +0.410; without best day +0.379 | ✅ |
| sufficiently selective | 0.5% floor; but only **1,232 independent events / 4 sessions** | ⚠️ **thin** |
| reproducible regardless of session ordering | byte-identical report forward vs reversed; session isolation verified | ✅ |
| evaluated on genuinely unseen sessions | **no unseen tape exists** | ❌ **NOT TESTED** |

## Verdict

**The 0.5% candidate does NOT clear the historical gate. It stays a FROZEN research hypothesis — NOT VALIDATED, NOT DEPLOYED.**

It fails on the decisive condition: **it is dominated by a handful of winners.** The positive aggregate is not spread across many ordinary events; it is produced by a small tail of extreme moves, and 4 sessions cannot tell us whether that tail is a property of the market or of the sample.

**Explicitly not accepted as evidence:** "positive at every independence level." That is true (+0.343 / +0.166 / +0.145) and it is **not sufficient** — every one of those estimators is built from the same four sessions and the same extreme trades. Independence level and independence of *sample* are different things.

## What would be required to move forward

1. **Unseen sessions** — the frozen harness, unchanged, on genuinely unseen tape ([docs/S2-VALIDATION.md](docs/S2-VALIDATION.md)). Reject on the first unseen session if the per-session deduplicated pattern stays ~half-positive and tail-dependent.
2. **Enough unseen sessions to make the effective sample real** — the target is a few hundred **independent** 60s events *per unseen session*, not 10k overlapping entries.
3. **No tuning between sessions.** The 0.5% threshold, the 15 s cooldown, the entry-at-event rule and the cost all stay exactly as pre-registered.

**STOP.** No threshold was optimized. Nothing was implemented. Nothing was moved to live validation.
