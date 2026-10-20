# S2 CANDIDATE — PRE-REGISTERED TEST (READ-ONLY)

**No strategy implemented. No V4. OF01/OF03 and Phase 5A untouched. No threshold changed after the result. No live deployment.**

Tool: [research/s2Candidate.js](research/s2Candidate.js) · raw: [data/terminal/s2-candidate-preregistered.json](data/terminal/s2-candidate-preregistered.json)

> Numbers below are the post-fix run. The tool now creates its per-symbol state **fresh
> per session** (see "Correction" below); the bill of materials — 0.5% threshold, fade
> direction, entry at the event, 15 s cooldown, 0.05% cost — is unchanged.

## Pre-registration (frozen before the run)

| item | value |
|---|---|
| Extension state | `r20` and `r60` same-signed, both │·│ ≥ 0.30% |
| **Meaningful extension** | **│r20│ ≥ 0.50% — PRE-REGISTERED, FROZEN, not changed** |
| Entry | the tick where a **new** extension episode starts (at the event, no deceleration wait, no swing break) |
| Direction | fade the extension (UP → SELL, DOWN → BUY) |
| Episode rule | one entry per continuous extension episode per symbol; 15 s per-symbol cooldown |
| Data | the four discovery tapes, same tick order |
| Outcome | same tracker: horizons 30s/60s/2m/5m, primary 60s, risk 0.20%, cost 0.05% |
| Not done | no threshold sweep, no 0.5% change, no indicators, no VWAP/FVG/POC/order-flow/volume, no V2/V3 combination |

## Result — the headline replicated

| | value |
|---|---|
| trades | 10,519 (from 51,954 episodes; 619 cooldown-blocked) |
| win rate | 50.1% |
| gross PF | **2.19** |
| **net PF (0.05% cost)** | **1.62** |
| expectancy | +0.697 R |
| **net expectancy** | **+0.447 R** |
| avg MFE / MAE | +0.671% / −0.413% |
| max adverse | −21.4% |
| DD per trade | 0.021 R |
| long (n=4,837) | netExpR **+0.650** |
| short (n=5,682) | netExpR **+0.275** |

The stage-2 attribution put the meaningful-extension stage at **+0.447 R** on its own sample definition (n=11,384); this independently implemented, pre-registered run gives **+0.447 R**. Same sign and magnitude. *(Caveat: the stage-2 diagnosis tools share the cross-session leak described below and their absolute numbers are pending re-derivation — see [docs/S2-VALIDATION.md](docs/S2-VALIDATION.md).)*

**Cost sensitivity:** +0.697 (0%) → +0.597 (0.02%) → **+0.447 (0.05%)** → +0.197 (0.10%) → −0.303 (0.20%). It survives the pre-registered 0.05% cost with margin, and is still positive at double the assumed cost.

## Overlap — this is the critical section

The user's rule requires checking whether one price move manufactures many correlated entries. It does.

| measure | value |
|---|---|
| entries | 10,519 |
| distinct **5s** buckets | 5,915 |
| distinct **60s** buckets | **1,232** |
| distinct **300s** buckets | **274** |
| symbol-days | 2,369 |
| symbols / sessions | 1,183 / 4 |
| 60s cluster size — median / p90 / max | **5 / 17 / 188** |
| share of entries inside clusters of >5 | **82.9%** |

One market move creates a large cross-sectional pile-up (up to 188 simultaneous-ish entries in the same minute). **n = 10,519 overstates the independent evidence by roughly 8.5×.**

### Does it survive de-duplication? Yes — but far weaker.

| treatment | n | netExpR |
|---|---|---|
| AS_IS | 10,519 | **+0.447** |
| one per 5s bucket | 5,915 | +0.490 |
| **one per 60s bucket** | 1,232 | **+0.343** |
| one per 300s bucket | 274 | +0.166 |
| drop pile-ups >5 per 60s | 1,796 | +0.218 |
| **one per symbol per session** | 2,369 | **+0.145** |
| without top 1% of trades | 10,414 | +0.214 |
| **without top 5% of trades** | 9,994 | **−0.100** |
| without best day | 8,427 | +0.379 |
| without best hour | 10,021 | +0.410 |
| excluding the first hour | 6,878 | +0.512 |

The edge is **not created** by the duplication — it remains positive at every independence level — but it is **inflated** by it, and the effective independent sample is ~1,230 minutes / 274 five-minute windows across four sessions.

## Session and hour

| day | n | netExpR |
|---|---|---|
| 2026-09-28 | 1,281 | **−0.067** |
| 2026-09-29 | 1,669 | +0.226 |
| 2026-09-30 | 5,477 | +0.530 |
| 2026-10-01 | 2,092 | +0.721 |

Positive **3/4** sessions; the first is slightly negative. Removing the best day leaves **+0.379**.

Every hour is positive (09h +0.324, 10h +0.367, 11h +0.310, 12h +0.478, 13h +0.428, 14h +0.722, 15h +1.193); removing the best hour leaves **+0.410**. **No single-hour dependency.**

## Tail concentration (the main fragility)

**The top 1% of trades produce 52.6% of all net R; the top 5% produce 121.2% — i.e. removing the top 5% turns the strategy negative (−0.100 R).** Combined with max adverse excursion −21.4%, this is a fat-tail, few-winners profile, not a broad-based edge.

## Label

**SCALP RESEARCH CANDIDATE** — it is positive after cost and is not a one-session or one-hour result.

**But it is NOT ready to freeze for live shadow validation.** The two unresolved items are decisive:

1. **Effective sample size.** ~1,232 independent minutes (274 independent 5-minute windows) across four sessions is thin, and the raw n is inflated ~8.5× by cross-sectional pile-ups.
2. **Tail dependence.** Removing the top 5% of trades flips it negative.

**FROZEN RESEARCH HYPOTHESIS — NOT VALIDATED — NOT DEPLOYED.**

## Correction (session isolation) — found while hardening the harness

Per-symbol state (`hist`, `inEpisode`, `lastEntryTs`) and the outcome tracker were created **once, outside the day loop**, so they crossed the session boundary. Because `priceAt()` returns the last tick `≤ target`, a surviving overnight price fabricated an extension at the next open; `2026-10-01` reported **n=2,226 (pooled) vs n=2,092 (standalone)**. The state and tracker are now created **inside the day loop**. This is a data-integrity fix, not a methodology change: no threshold, cooldown, entry rule, cost or dedup rule moved. The frozen harness [research/s2Validation.js](research/s2Validation.js) carries the identical fix, and the two tools now agree **exactly** on every estimator and per-day number. Regression test: [test/s2Validation.test.js](test/s2Validation.test.js).

**STOP.** Do not deploy live. Do not tune the 0.5% threshold.
